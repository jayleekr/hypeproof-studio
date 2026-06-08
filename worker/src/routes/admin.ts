// Admin endpoints (and a tiny HTML SPA at /).
//
// Auth: protected via Cloudflare Access at the route level (recommended) —
// HPS_ADMIN_PASSWORD is the dev fallback. In production set up a Cloudflare
// Access policy on api.hypeproof-ai.xyz/admin/* limited to Jay's email.
//
// Endpoints:
//   GET    /admin/cohorts                       — list with status
//   GET    /admin/cohorts/:id                   — detail (roster + active session)
//   POST   /admin/cohorts/:id/roster            — body: { users: string[] }
//   POST   /admin/cohorts/:id/session           — body: { profile_id, starts_at, ends_at }
//   DELETE /admin/cohorts/:id/session           — end current session
//   POST   /admin/cohorts/:id/pause             — kill-switch on (S-12 / #47)
//   DELETE /admin/cohorts/:id/pause             — kill-switch off
//   POST   /admin/tokens/revoke                 — per-token kill (S-01 / #46)
//   DELETE /admin/tokens/revoke/:jti            — un-revoke (typo / restore)
//   GET    /admin/tokens/revoked                — current revocation list

import { Hono } from "hono";
import type { Env } from "../env";
import { listProfiles } from "../profiles";
import { issue, verify, type IssuerScope, type TokenPayload } from "../lib/tokens";
import { isIssuerAllowedEndpoint } from "./issuer-acl";
import { postDiscordResolution } from "./report";
import {
  endSession,
  getActiveSession,
  getCohortPause,
  getRoster,
  isTokenRevoked,
  listRevoked,
  pauseCohort,
  revokeToken,
  setRoster,
  startSession,
  unpauseCohort,
  unrevokeToken,
  type ActiveSession,
} from "../lib/kv";

export const admin = new Hono<{ Bindings: Env }>();

admin.use("*", async (c, next) => {
  // Cloudflare Access injects this header for authenticated requests.
  if (c.req.header("cf-access-authenticated-user-email")) return next();

  // Path-scoped issuer-Bearer exception (see isIssuerAllowedEndpoint above).
  if (isIssuerAllowedEndpoint(c.req.path, c.req.method)) {
    const ah = c.req.header("authorization") ?? "";
    if (/^Bearer\s+/i.test(ah)) return next();
  }

  // Dev fallback: HPS_ADMIN_PASSWORD basic-auth.
  const pw = c.env.HPS_ADMIN_PASSWORD;
  if (pw) {
    const ah = c.req.header("authorization") ?? "";
    if (ah.startsWith("Basic ")) {
      try {
        const decoded = atob(ah.slice(6));
        const [_, pass] = decoded.split(":", 2);
        if (pass === pw) return next();
      } catch { /* fallthrough */ }
    }
    return new Response("Auth required", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="HypeProof Admin"' },
    });
  }
  return c.json({ error: "admin not configured" }, 503);
});

// ---- cohort list ------------------------------------------------------------

admin.get("/cohorts", async (c) => {
  const profiles = listProfiles();
  // Group profiles by cohort_id
  const cohortMap = new Map<string, { id: string; profiles: typeof profiles }>();
  for (const p of profiles) {
    const cid = p.session.cohort_id;
    if (!cohortMap.has(cid)) cohortMap.set(cid, { id: cid, profiles: [] });
    cohortMap.get(cid)!.profiles.push(p);
  }

  // For each cohort, fetch live state.
  const out = [];
  for (const c2 of cohortMap.values()) {
    const [roster, session] = await Promise.all([
      getRoster(c.env.HPS_KV, c2.id),
      getActiveSession(c.env.HPS_KV, c2.id),
    ]);
    out.push({
      id: c2.id,
      profile_ids: c2.profiles.map((p) => p.id),
      profile_names: c2.profiles.map((p) => p.display_name),
      roster_size: roster?.users.length ?? 0,
      session,
    });
  }
  return c.json({ cohorts: out });
});

admin.get("/cohorts/:id", async (c) => {
  const id = c.req.param("id");
  const [roster, session, paused] = await Promise.all([
    getRoster(c.env.HPS_KV, id),
    getActiveSession(c.env.HPS_KV, id),
    getCohortPause(c.env.HPS_KV, id),
  ]);
  return c.json({ id, roster, session, paused });
});

// ---- kill-switch (S-12 / #47) ----------------------------------------------
// Cohort-wide hard stop. Returns 503 from /v1/chat/completions until cleared.
// Independent of session/roster — useful when an active session needs to be
// halted but state shouldn't be discarded.

admin.post("/cohorts/:id/pause", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json<{ reason?: string }>().catch(() => ({}))) as { reason?: string };
  const reason = typeof body.reason === "string" && body.reason.length <= 200
    ? body.reason
    : undefined;
  const paused = await pauseCohort(c.env.HPS_KV, id, reason);
  return c.json({ ok: true, paused });
});

admin.delete("/cohorts/:id/pause", async (c) => {
  const id = c.req.param("id");
  await unpauseCohort(c.env.HPS_KV, id);
  return c.json({ ok: true });
});

// ---- self-service token mint (issuer role) ---------------------------------
// Two auth paths:
//   1. Admin Basic (Jay)
//   2. Bearer <issuer-token> in Authorization header
// Issuer tokens are minted once per instructor (via worker/scripts/issue-
// issuer-token.ts). They embed `role:"issuer"` + `scopes:[{cohort, profiles}]`
// and can mint STUDENT tokens only within those scopes. They cannot chat,
// pause cohorts, revoke other tokens, or view stats — POST /admin/tokens/issue
// is the only thing they unlock.

admin.post("/tokens/issue", async (c) => {
  type Body = { u?: string; c?: string; p?: string; hours?: number };
  const body = (await c.req.json<Body>().catch(() => ({}))) as Body;
  const { u, c: cohort, p: profile } = body;
  const hours = Number.isFinite(body.hours) ? Number(body.hours) : 168;

  // Field validation
  if (!u || typeof u !== "string" || u.length < 1 || u.length > 64) {
    return c.json({ error: "u (user handle) required (1-64 chars)" }, 400);
  }
  if (!cohort || typeof cohort !== "string" || cohort.length < 1 || cohort.length > 64) {
    return c.json({ error: "c (cohort) required" }, 400);
  }
  if (!profile || typeof profile !== "string" || profile.length < 1 || profile.length > 80) {
    return c.json({ error: "p (profile) required" }, 400);
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 60) {
    return c.json({ error: "hours must be 1..1440 (60 days max)" }, 400);
  }

  // Auth: admin already gated at the route prefix via the .use("*", ...) above.
  // But we ALSO accept an issuer Bearer — so we re-inspect Authorization here
  // to detect which path was used + enforce scope on issuers.
  const auth = c.req.header("authorization") ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (bearerMatch && bearerMatch[1]) {
    const issuerToken = bearerMatch[1];
    let issuerPayload;
    try {
      issuerPayload = await verify(issuerToken, c.env.HPS_SIGNING_SECRET);
    } catch (err) {
      return c.json({ error: `invalid issuer token: ${(err as Error).message}` }, 401);
    }
    if (issuerPayload.role !== "issuer") {
      return c.json({ error: "token is not an issuer" }, 403);
    }
    const scopes = issuerPayload.scopes ?? [];
    const allowed = scopes.find(
      (s) => s.cohort === cohort && (s.profiles?.includes(profile) ?? false),
    );
    if (!allowed) {
      return c.json(
        { error: `issuer not scoped to (cohort=${cohort}, profile=${profile})` },
        403,
      );
    }
    if (allowed.max_hours && hours > allowed.max_hours) {
      return c.json({ error: `requested ${hours}h exceeds scope max ${allowed.max_hours}h` }, 403);
    }
    // OK — also revoke check the issuer itself (so a leaked issuer can be killed)
    if (issuerPayload.jti) {
      const rev = await isTokenRevoked(c.env.HPS_KV, issuerPayload.jti);
      if (rev) return c.json({ error: "issuer token revoked" }, 401);
    }
    // Permit; mint below.
  }
  // (else: the .use("*", ...) admin gate already enforced Basic auth — no extra check needed)

  // Mint the student token.
  const { token, jti } = await issue(
    { u, c: cohort, p: profile },
    hours,
    c.env.HPS_SIGNING_SECRET,
  );
  return c.json({
    ok: true,
    token,
    jti,
    user: u,
    cohort,
    profile,
    hours,
    exp: Math.floor(Date.now() / 1000) + hours * 3600,
  });
});

// ---- token revocation (S-01 / #46) -----------------------------------------

// Loose RFC 4122 UUID shape — same regex as storage.ts UUID_RE.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

admin.post("/tokens/revoke", async (c) => {
  type Body = { jti?: string; reason?: string; cohort?: string; user?: string; exp?: number };
  const body = (await c.req.json<Body>().catch(() => ({}))) as Body;
  if (!body.jti || !UUID_RE.test(body.jti)) {
    return c.json({ error: "jti must be a valid UUID" }, 400);
  }
  // TTL: caller passes the token's exp (unix seconds). Default 24h if unknown.
  const now = Math.floor(Date.now() / 1000);
  const ttl = typeof body.exp === "number" && body.exp > now
    ? body.exp - now
    : 60 * 60 * 24;
  const rev = await revokeToken(
    c.env.HPS_KV,
    body.jti,
    {
      reason: typeof body.reason === "string" && body.reason.length <= 200 ? body.reason : undefined,
      cohort: typeof body.cohort === "string" && body.cohort.length <= 64 ? body.cohort : undefined,
      user: typeof body.user === "string" && body.user.length <= 64 ? body.user : undefined,
    },
    ttl,
  );
  return c.json({ ok: true, jti: body.jti, record: rev, ttl_seconds: ttl });
});

admin.delete("/tokens/revoke/:jti", async (c) => {
  const jti = c.req.param("jti");
  if (!UUID_RE.test(jti)) return c.json({ error: "jti must be a valid UUID" }, 400);
  await unrevokeToken(c.env.HPS_KV, jti);
  return c.json({ ok: true });
});

admin.get("/tokens/revoked", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const list = await listRevoked(c.env.HPS_KV, { limit });
  return c.json({ revoked: list, count: list.length });
});

// ---- roster -----------------------------------------------------------------

admin.post("/cohorts/:id/roster", async (c) => {
  const id = c.req.param("id");

  // #191 — instructor self-service. If the request came via an issuer Bearer
  // (no CF Access, no admin Basic), it must be scoped to THIS cohort with
  // can_start_session. Roster isn't profile-specific, so requireProfileId=null.
  // Returns null when an admin/CF path was used (no extra check); a Response on
  // rejection; scope+payload when an issuer was admitted for this cohort.
  const issuerCheck = await authorizeIssuerForSession(c, id, null);
  if (issuerCheck instanceof Response) return issuerCheck;

  const body = await c.req.json<{ users?: string[] }>().catch(() => ({} as { users?: string[] }));
  const users = body.users;
  if (!Array.isArray(users)) return c.json({ error: "users must be array" }, 400);
  if (users.some((u) => typeof u !== "string" || u.length < 1 || u.length > 64)) {
    return c.json({ error: "user ids must be 1-64 char strings" }, 400);
  }
  await setRoster(c.env.HPS_KV, id, users);
  return c.json({ ok: true, size: users.length });
});

// ---- session start/end ------------------------------------------------------

// #167 — when an issuer-role Bearer is presented to /cohorts/:id/session
// (POST/DELETE), this helper does the same re-verify + scope check pattern
// that /tokens/issue uses. Returns `null` if no Bearer was present (so the
// caller knows the middleware admitted via Basic/CF Access). Throws a Response
// (caught + returned) on Bearer-but-not-authorized cases.
//
// `requireProfileId`: when set, the matched scope must include this profile.
// (start needs it; end does not — end just kills the current session).
async function authorizeIssuerForSession(
  c: { env: Env; req: { header: (k: string) => string | undefined } },
  cohortId: string,
  requireProfileId: string | null,
): Promise<{ scope: IssuerScope; payload: TokenPayload } | null | Response> {
  const auth = c.req.header("authorization") ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!bearerMatch || !bearerMatch[1]) return null;
  const issuerToken = bearerMatch[1];

  let payload: TokenPayload;
  try {
    payload = await verify(issuerToken, c.env.HPS_SIGNING_SECRET);
  } catch (err) {
    return Response.json(
      { error: `invalid issuer token: ${(err as Error).message}` },
      { status: 401 },
    );
  }
  if (payload.role !== "issuer") {
    return Response.json({ error: "token is not an issuer" }, { status: 403 });
  }
  const scopes: IssuerScope[] = payload.scopes ?? [];
  const scope = scopes.find(
    (s) =>
      s.cohort === cohortId &&
      s.can_start_session === true &&
      (requireProfileId === null || (s.profiles?.includes(requireProfileId) ?? false)),
  );
  if (!scope) {
    return Response.json(
      {
        error: requireProfileId
          ? `issuer not scoped for session start on (cohort=${cohortId}, profile=${requireProfileId}). scope needs can_start_session=true.`
          : `issuer not scoped for session control on cohort=${cohortId}. scope needs can_start_session=true.`,
      },
      { status: 403 },
    );
  }
  if (payload.jti) {
    const rev = await isTokenRevoked(c.env.HPS_KV, payload.jti);
    if (rev) return Response.json({ error: "issuer token revoked" }, { status: 401 });
  }
  return { scope, payload };
}

admin.post("/cohorts/:id/session", async (c) => {
  const cohortId = c.req.param("id");
  type SessionBody = {
    session_id?: string;
    profile_id?: string;
    starts_at?: string;
    ends_at?: string;
  };
  const body = (await c.req.json<SessionBody>().catch(() => ({} as SessionBody))) as SessionBody;
  const { session_id, profile_id, starts_at, ends_at } = body;

  if (!profile_id || !starts_at || !ends_at) {
    return c.json({ error: "profile_id, starts_at, ends_at required" }, 400);
  }
  if (!Number.isFinite(Date.parse(starts_at)) || !Number.isFinite(Date.parse(ends_at))) {
    return c.json({ error: "starts_at and ends_at must be ISO8601" }, 400);
  }
  if (Date.parse(ends_at) <= Date.parse(starts_at)) {
    return c.json({ error: "ends_at must be after starts_at" }, 400);
  }

  // #167 — if request came via issuer Bearer (no CF Access, no admin Basic),
  // verify scope + cap duration. Returns null when admin/CF auth path was
  // used → no extra check. Returns Response on rejection. Returns scope+payload
  // when an issuer was admitted.
  const issuerCheck = await authorizeIssuerForSession(c, cohortId, profile_id);
  if (issuerCheck instanceof Response) return issuerCheck;
  if (issuerCheck) {
    const maxHours = issuerCheck.scope.max_session_hours ?? 4;
    const durationHours =
      (Date.parse(ends_at) - Date.parse(starts_at)) / (3600 * 1000);
    if (durationHours > maxHours + 0.001) {
      return c.json(
        {
          error: `session duration ${durationHours.toFixed(2)}h exceeds issuer scope max ${maxHours}h`,
        },
        403,
      );
    }
  }

  const session: ActiveSession = {
    session_id: session_id || `${cohortId}-${new Date().toISOString().slice(0, 10)}`,
    profile_id: profile_id,
    starts_at: starts_at,
    ends_at: ends_at,
  };
  await startSession(c.env.HPS_KV, cohortId, session);

  // Persist to D1 for history
  c.executionCtx.waitUntil(
    c.env.HPS_DB
      .prepare(
        `INSERT OR REPLACE INTO sessions (id, cohort_id, profile_id, starts_at, ends_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(session.session_id, cohortId, session.profile_id, session.starts_at, session.ends_at)
      .run(),
  );

  return c.json({ ok: true, session });
});

admin.delete("/cohorts/:id/session", async (c) => {
  const cohortId = c.req.param("id");
  // #167 — same Bearer gate as POST, but profile match is not required for
  // ending (an instructor with cohort-level can_start_session may also stop).
  const issuerCheck = await authorizeIssuerForSession(c, cohortId, null);
  if (issuerCheck instanceof Response) return issuerCheck;

  const existing = await getActiveSession(c.env.HPS_KV, cohortId);
  await endSession(c.env.HPS_KV, cohortId);
  if (existing) {
    c.executionCtx.waitUntil(
      c.env.HPS_DB
        .prepare(`UPDATE sessions SET ended_at = datetime('now') WHERE id = ?`)
        .bind(existing.session_id)
        .run(),
    );
  }
  return c.json({ ok: true, ended: existing });
});

// ---- live stats snapshot (S-09 / #50) ---------------------------------------
// 1-second polling endpoint for the operator console during a live session.
// Returns: cohort live state (roster size + session + paused), aggregated
// volumes for the last hour from D1 usage_log, and heartbeat KV slot.
// JSON only — Jay polls with `watch -n 5 'curl ... | jq'` during 보아치과.

admin.get("/stats", async (c) => {
  const profiles = listProfiles();
  const cohortIds = Array.from(new Set(profiles.map((p) => p.session.cohort_id)));

  // Per-cohort live state (KV reads in parallel)
  const cohortRows = await Promise.all(
    cohortIds.map(async (id) => {
      const [roster, session, paused] = await Promise.all([
        getRoster(c.env.HPS_KV, id),
        getActiveSession(c.env.HPS_KV, id),
        getCohortPause(c.env.HPS_KV, id),
      ]);
      return {
        id,
        roster_size: roster?.users.length ?? 0,
        paused: paused ?? null,
        session: session ?? null,
      };
    }),
  );

  // Last-hour aggregates from D1 usage_log.
  // SQLite datetime('now') is UTC; usage_log.created_at is UTC ISO8601 by
  // convention (we INSERT with datetime('now') / ISO8601 timestamps).
  let lastHour = { messages: 0, errors: 0, tokens_in: 0, tokens_out: 0 };
  try {
    const row = await c.env.HPS_DB
      .prepare(
        `SELECT
            COUNT(*) AS messages,
            SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
            COALESCE(SUM(tokens_in), 0)  AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out
         FROM usage_log
         WHERE created_at > datetime('now', '-1 hour')`,
      )
      .first<{ messages: number; errors: number; tokens_in: number; tokens_out: number }>();
    if (row) lastHour = row;
  } catch (err) {
    // D1 might be unset in some dev configs; surface but don't crash.
    console.error("/admin/stats: usage_log query failed:", err);
  }

  // Heartbeat KV slot (#45). If missing → cron not firing OR cleared.
  const [heartbeat, alert, failStreak] = await Promise.all([
    c.env.HPS_KV.get<unknown>("heartbeat:last", "json"),
    c.env.HPS_KV.get<unknown>("heartbeat:alert", "json"),
    c.env.HPS_KV.get("heartbeat:fail_streak"),
  ]);

  return c.json({
    ts: new Date().toISOString(),
    cohorts: cohortRows,
    last_hour: lastHour,
    heartbeat: {
      last: heartbeat,
      alert: alert,
      fail_streak: failStreak ? parseInt(failStreak, 10) : 0,
    },
  });
});

// ---- recent usage -----------------------------------------------------------

admin.get("/cohorts/:id/usage", async (c) => {
  const cohortId = c.req.param("id");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 500);
  const rs = await c.env.HPS_DB
    .prepare(
      `SELECT user_id, model, tokens_in, tokens_out, cache_read, latency_ms, status, created_at
       FROM usage_log WHERE cohort_id = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .bind(cohortId, limit)
    .all();
  return c.json({ usage: rs.results });
});

// ---- profiles (read-only) ---------------------------------------------------

admin.get("/profiles", (c) => {
  return c.json({
    profiles: listProfiles().map((p) => ({
      id: p.id,
      display_name: p.display_name,
      cohort_id: p.session.cohort_id,
      series_index: p.session.series_index,
      series_total: p.session.series_total,
      model: p.model.default,
      assets_focus: p.assets_focus,
      essences_focus: p.essences_focus ?? [],
    })),
  });
});

// ---- in-app bug reports (#64) ----------------------------------------------
// Triage flow lives over in /v1/report (public submit + status poll). Admin
// endpoints handle list + resolve. Resolution also announces back to the same
// Discord webhook (best-effort).

admin.get("/reports", async (c) => {
  const status = (c.req.query("status") ?? "open").toLowerCase();
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 500);
  let rs;
  if (status === "all") {
    rs = await c.env.HPS_DB
      .prepare(
        `SELECT id, ts, jti_hash, profile_id, request_id, description,
                attachments_json, contact, status, resolved_at,
                resolution_note, github_issue_url
         FROM reports ORDER BY ts DESC LIMIT ?`,
      )
      .bind(limit)
      .all();
  } else if (status === "open" || status === "resolved") {
    rs = await c.env.HPS_DB
      .prepare(
        `SELECT id, ts, jti_hash, profile_id, request_id, description,
                attachments_json, contact, status, resolved_at,
                resolution_note, github_issue_url
         FROM reports WHERE status = ? ORDER BY ts DESC LIMIT ?`,
      )
      .bind(status, limit)
      .all();
  } else {
    return c.json({ error: "status must be one of: open, resolved, all" }, 400);
  }
  return c.json({ reports: rs.results });
});

admin.post("/reports/:id/resolve", async (c) => {
  const id = c.req.param("id");
  if (!id || !/^rep_[a-z2-7]+$/.test(id)) {
    return c.json({ error: "report not found" }, 404);
  }
  type Body = { resolution_note?: unknown; github_issue_url?: unknown };
  const body = (await c.req.json<Body>().catch(() => ({}))) as Body;
  if (typeof body.resolution_note !== "string" || body.resolution_note.trim().length === 0) {
    return c.json({ error: "resolution_note (non-empty string) required" }, 400);
  }
  const resolutionNote = body.resolution_note.trim().slice(0, 2000);
  let githubIssueUrl: string | undefined;
  if (typeof body.github_issue_url === "string" && body.github_issue_url.length > 0) {
    if (body.github_issue_url.length > 500) {
      return c.json({ error: "github_issue_url exceeds 500 chars" }, 400);
    }
    // Light shape check — full validation against github.com is overkill;
    // Discord/admin UI will surface a broken link visually.
    if (!/^https?:\/\//.test(body.github_issue_url)) {
      return c.json({ error: "github_issue_url must be an http(s) URL" }, 400);
    }
    githubIssueUrl = body.github_issue_url;
  }
  const now = Math.floor(Date.now() / 1000);
  const result = await c.env.HPS_DB
    .prepare(
      `UPDATE reports
       SET status = 'resolved', resolved_at = ?, resolution_note = ?, github_issue_url = ?
       WHERE id = ?`,
    )
    .bind(now, resolutionNote, githubIssueUrl ?? null, id)
    .run();
  // D1 .meta.changes is the canonical "rows affected" signal.
  const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changes === 0) {
    return c.json({ error: "report not found" }, 404);
  }
  if (c.env.DISCORD_REPORT_WEBHOOK_URL) {
    await postDiscordResolution(c.env.DISCORD_REPORT_WEBHOOK_URL, {
      reportId: id,
      resolutionNote,
      githubIssueUrl,
    });
  }
  return c.json({ ok: true, report_id: id, status: "resolved" });
});
