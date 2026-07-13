// Admin endpoints (and a tiny HTML SPA at /).
//
// Auth: protected via Cloudflare Access at the route level (recommended) —
// HPS_ADMIN_PASSWORD is the dev fallback. In production set up a Cloudflare
// Access policy on api.hypeproof-ai.xyz/admin/* limited to Jay's email.
//
// Endpoints:
//   GET    /admin/cohorts                       — list with status
//   GET    /admin/cohorts/:id                   — detail (roster + active session)
//   POST   /admin/cohorts/:id/roster            — body: { users: string[] } (full replace)
//   POST   /admin/cohorts/:id/roster/append     — body: { users: string[] } (server-side merge, #290)
//   POST   /admin/cohorts/:id/session           — body: { profile_id, starts_at, ends_at }
//   DELETE /admin/cohorts/:id/session           — end current session
//   POST   /admin/cohorts/:id/session/open      — composite: guard→mint→roster→start (#290)
//   POST   /admin/cohorts/:id/session/close     — composite: end + revoke minted token (#290)
//   POST   /admin/cohorts/:id/pause             — kill-switch on (S-12 / #47)
//   DELETE /admin/cohorts/:id/pause             — kill-switch off
//   POST   /admin/tokens/revoke                 — per-token kill (S-01 / #46)
//   DELETE /admin/tokens/revoke/:jti            — un-revoke (typo / restore)
//   GET    /admin/tokens/revoked                — current revocation list
//   POST   /admin/issuers                       — mint/re-scope an instructor issuer token (admin Basic/CF, or a member's can_issue_issuers Bearer; #290/#191/#295)

import { Hono } from "hono";
import type { Env } from "../env";
import { listProfiles } from "../profiles";
import { issue, issueIssuer, verify, TokenError, type IssuerScope, type TokenPayload } from "../lib/tokens";

// #257 — verify() failures surface curated TokenError prose only; anything
// else (crypto/config internals) is logged server-side, client gets a
// generic message.
function publicVerifyError(err: unknown, label: string): string {
  if (err instanceof TokenError) return `invalid ${label} token: ${err.message}`;
  console.error(`${label} token verify failed:`, err);
  return `invalid ${label} token`;
}
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

// Path-scoped issuer-Bearer exceptions. Each endpoint listed here re-verifies
// the issuer token + checks scope inside its own handler. The middleware just
// lets the request through gating so the handler can do the real check. All
// other admin paths stay admin-only.
function isIssuerAllowedEndpoint(path: string, method: string): boolean {
  if (path === "/admin/tokens/issue" && method === "POST") return true;
  // #167 — issuer-role tokens with can_start_session scope may start/end
  // their scoped cohort's session without admin Basic auth.
  if (method === "POST" && /^\/admin\/cohorts\/[^/]+\/session$/.test(path)) return true;
  if (method === "DELETE" && /^\/admin\/cohorts\/[^/]+\/session$/.test(path)) return true;
  // #290 — scoped issuers may append to their cohort's roster and use the
  // composite session open/close endpoints (self-service workshop ops).
  if (method === "POST" && /^\/admin\/cohorts\/[^/]+\/roster\/append$/.test(path)) return true;
  if (method === "POST" && /^\/admin\/cohorts\/[^/]+\/session\/(open|close)$/.test(path)) return true;
  // #295 — an admin-tier minter (issuer token with can_issue_issuers) may mint
  // instructor issuers via Bearer. The handler re-verifies the token AND the
  // capability; a Bearer minter still cannot create another admin-minter.
  if (path === "/admin/issuers" && method === "POST") return true;
  return false;
}

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
      return c.json({ error: publicVerifyError(err, "issuer") }, 401);
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

// ---- issuer minting (root-of-trust) — #290 / #191 / #295 -------------------
// Mint or re-scope an INSTRUCTOR issuer token SERVER-SIDE so the raw
// HPS_SIGNING_SECRET never leaves the Worker (previously only the offline
// worker/scripts/issue-issuer-token.ts could do this → Jay-only bottleneck).
//
// Two ways to authenticate here:
//   • admin Basic / CF Access  → "full admin" — may mint anything, INCLUDING
//     another admin-minter (a token with can_issue_issuers).
//   • Bearer <issuer-with-can_issue_issuers> → "admin-tier minter" (#295) —
//     the operating members each hold one, so any of them can mint instructor
//     issuers with their OWN auditable credential (no shared password). A
//     Bearer minter may NOT set can_issue_issuers on its child, so the
//     capability cannot spread without a full admin.
//
// Bearer-minter trust model (PR #297 review — B1/B2): a minter is NOT a full
// admin. It is confined to its own scopes:
//   • child scopes must be a SUBSET of the minter's scopes (⑧ below) — a
//     cohort-A minter cannot mint issuers for cohort B, nor grant
//     can_start_session / caps it does not hold itself;
//   • revoke_jti may only target tokens the minter itself minted, proven via
//     issuer_audit.minted_by (⑨ below) — no revoking other operators' tokens.
// Only full admin (Basic/CF) is unrestricted on both counts.
// isIssuerAllowedEndpoint admits the Bearer through the middleware; this
// handler does the real verify + capability check.
admin.post("/issuers", async (c) => {
  const MAX_DAYS = 90;
  const MAX_TOKEN_HOURS = 168;
  const MAX_SESSION_HOURS = 24;
  const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

  // Determine the auth path. The middleware already admitted this request
  // (Basic/CF, or Bearer via isIssuerAllowedEndpoint) but does NOT verify a
  // Bearer — so a Bearer minter must be verified + capability-checked here.
  const authHeader = c.req.header("authorization") ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  let minter = "admin";       // recorded in the audit trail
  let viaBearer = false;
  let minterScopes: IssuerScope[] = [];   // consulted for subset enforcement (Bearer only)
  if (bearerMatch && bearerMatch[1]) {
    viaBearer = true;
    let mp;
    try {
      mp = await verify(bearerMatch[1], c.env.HPS_SIGNING_SECRET);
    } catch (err) {
      return c.json({ error: publicVerifyError(err, "minter") }, 401);
    }
    if (mp.role !== "issuer" || mp.can_issue_issuers !== true) {
      return c.json({ error: "token not permitted to mint issuers (needs can_issue_issuers)" }, 403);
    }
    if (mp.jti && (await isTokenRevoked(c.env.HPS_KV, mp.jti))) {
      return c.json({ error: "minter token revoked" }, 401);
    }
    minter = mp.u;
    minterScopes = mp.scopes ?? [];
  }

  type ScopeIn = {
    cohort?: string;
    profiles?: string[];
    max_hours?: number;
    can_start_session?: boolean;
    max_session_hours?: number;
  };
  type Body = {
    instructor?: string;
    scopes?: ScopeIn[];
    days?: number;
    revoke_jti?: string;
    can_issue_issuers?: boolean;
  };
  const body = (await c.req.json<Body>().catch(() => ({}))) as Body;

  // #295 — only a FULL admin (Basic/CF) may grant the admin-minter capability;
  // a Bearer minter cannot spread it. Checked before any signing.
  const childCanIssue = body.can_issue_issuers === true;
  if (childCanIssue && viaBearer) {
    return c.json({ error: "only admin (Basic / CF Access) may grant can_issue_issuers" }, 403);
  }

  // ③ input validation — whitelist every field before anything is signed.
  const instructor = body.instructor;
  if (typeof instructor !== "string" || !HANDLE_RE.test(instructor)) {
    return c.json({ error: "instructor required ([A-Za-z0-9_-], 1-64 chars)" }, 400);
  }
  const days = body.days === undefined ? 60 : body.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days <= 0 || days > MAX_DAYS) {
    return c.json({ error: `days must be an integer 1..${MAX_DAYS}` }, 400);
  }
  if (!Array.isArray(body.scopes) || body.scopes.length === 0 || body.scopes.length > 20) {
    return c.json({ error: "scopes[] required (1..20 entries)" }, 400);
  }

  // ④ scope caps — even an admin cannot mint an unbounded issuer.
  const scopes: IssuerScope[] = [];
  for (const s of body.scopes) {
    if (!s || typeof s !== "object") return c.json({ error: "each scope must be an object" }, 400);
    if (typeof s.cohort !== "string" || !ID_RE.test(s.cohort)) {
      return c.json({ error: "scope.cohort invalid ([A-Za-z0-9_-], 1..80)" }, 400);
    }
    if (
      !Array.isArray(s.profiles) || s.profiles.length === 0 || s.profiles.length > 20 ||
      s.profiles.some((p) => typeof p !== "string" || !ID_RE.test(p))
    ) {
      return c.json({ error: "scope.profiles[] required (1..20, each [A-Za-z0-9_-])" }, 400);
    }
    const maxHours = s.max_hours === undefined ? 24 : s.max_hours;
    if (typeof maxHours !== "number" || !Number.isInteger(maxHours) || maxHours <= 0 || maxHours > MAX_TOKEN_HOURS) {
      return c.json({ error: `scope.max_hours must be an integer 1..${MAX_TOKEN_HOURS}` }, 400);
    }
    const canStart = s.can_start_session === true;
    let maxSession: number | undefined;
    if (canStart) {
      maxSession = s.max_session_hours === undefined ? 4 : s.max_session_hours;
      if (
        typeof maxSession !== "number" || !Number.isInteger(maxSession) ||
        maxSession <= 0 || maxSession > MAX_SESSION_HOURS
      ) {
        return c.json({ error: `scope.max_session_hours must be an integer 1..${MAX_SESSION_HOURS}` }, 400);
      }
    }
    scopes.push({
      cohort: s.cohort,
      profiles: s.profiles,
      max_hours: maxHours,
      ...(canStart ? { can_start_session: true, max_session_hours: maxSession } : {}),
    });
  }

  // ⑧ #295 SUBSET ENFORCEMENT (B2) — a Bearer minter can only delegate
  // authority it holds itself: every requested child scope must be covered by
  // a single one of the minter's own scopes. "Covered" mirrors how scopes are
  // consumed elsewhere (/admin/tokens/issue, session open):
  //   • same cohort,
  //   • child profiles ⊆ minter profiles,
  //   • child max_hours ≤ minter max_hours (absent minter max_hours = uncapped,
  //     same as the /tokens/issue check),
  //   • can_start_session only if the minter scope has it, and child
  //     max_session_hours ≤ the minter's effective cap (max_session_hours ?? 4,
  //     same default the session endpoint applies).
  // Full admin (Basic/CF) is NOT scope-restricted — it holds the root of trust.
  if (viaBearer) {
    for (const s of scopes) {
      const covered = minterScopes.some((m) => {
        if (m.cohort !== s.cohort) return false;
        if (!s.profiles.every((p) => m.profiles?.includes(p) ?? false)) return false;
        if (m.max_hours !== undefined && (s.max_hours ?? 24) > m.max_hours) return false;
        if (s.can_start_session === true) {
          if (m.can_start_session !== true) return false;
          if ((s.max_session_hours ?? 4) > (m.max_session_hours ?? 4)) return false;
        }
        return true;
      });
      if (!covered) {
        return c.json(
          {
            error:
              `scope (cohort=${s.cohort}) exceeds minter authority — ` +
              "child scopes must be a subset of the minter's own scopes " +
              "(cohort, profiles, max_hours, can_start_session, max_session_hours)",
          },
          403,
        );
      }
    }
  }

  // ⑤ validate revoke_jti shape up-front (fail-closed before any signing);
  // the actual revoke runs AFTER a successful mint (see below).
  if (
    body.revoke_jti !== undefined &&
    (typeof body.revoke_jti !== "string" || !UUID_RE.test(body.revoke_jti))
  ) {
    return c.json({ error: "revoke_jti must be a valid UUID" }, 400);
  }

  // ⑨ #295 revoke_jti OWNERSHIP (B1) — on the Bearer path, revoke_jti may only
  // target a token the minter itself minted, proven by the issuer_audit record
  // this endpoint writes on every mint (minted_by). Otherwise any admin-tier
  // minter could fill a well-formed mint request and silently revoke another
  // operator's minter or a live instructor issuer (DoS side channel).
  //   • no audit record → not minted via this endpoint (or audit expired) → deny
  //   • minted_by !== minter → someone else's token → deny
  // Full admin (Basic/CF) stays unrestricted — it already holds
  // /admin/tokens/revoke for arbitrary jtis.
  if (viaBearer && body.revoke_jti !== undefined) {
    const rec = await c.env.HPS_KV.get(`issuer_audit:${body.revoke_jti}`, "json") as
      | { minted_by?: string }
      | null;
    if (!rec || rec.minted_by !== minter) {
      return c.json(
        { error: "revoke_jti: a Bearer minter may only re-scope issuers it minted itself" },
        403,
      );
    }
  }

  // ① mint server-side with the Worker's own secret; the token is returned
  // ONLY in this HTTPS response body — never logged, never audited in plaintext.
  const { token, jti } = await issueIssuer(
    { issuer: instructor, scopes, ...(childCanIssue ? { can_issue_issuers: true } : {}) },
    days * 24,
    c.env.HPS_SIGNING_SECRET,
  );
  const exp = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;

  // ⑤/⑥ re-scope: revoke the replaced issuer AFTER the mint succeeds, so a
  // mint failure leaves the instructor with their OLD token rather than
  // neither. TTL = 90-day hard cap >= any issuer lifetime → no resurrection.
  if (body.revoke_jti !== undefined) {
    await revokeToken(
      c.env.HPS_KV,
      body.revoke_jti,
      { reason: "issuer re-scope", user: instructor },
      MAX_DAYS * 24 * 60 * 60,
    );
  }

  // ⑦ audit — metadata only (NEVER the token). Root-of-trust issuance must be
  // traceable; TTL tracks the token's own lifetime.
  await c.env.HPS_KV.put(
    `issuer_audit:${jti}`,
    JSON.stringify({
      instructor,
      scopes,
      exp,
      days,
      revoked_jti: body.revoke_jti ?? null,
      minted_by: minter,
      can_issue_issuers: childCanIssue,
    }),
    { expirationTtl: days * 24 * 60 * 60 },
  );

  return c.json({
    ok: true,
    token,
    jti,
    instructor,
    scopes,
    exp,
    exp_days: days,
    can_issue_issuers: childCanIssue,
    minted_by: minter,
  });
});

// ---- roster -----------------------------------------------------------------

admin.post("/cohorts/:id/roster", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ users?: string[] }>().catch(() => ({} as { users?: string[] }));
  const users = body.users;
  if (!Array.isArray(users)) return c.json({ error: "users must be array" }, 400);
  if (users.some((u) => typeof u !== "string" || u.length < 1 || u.length > 64)) {
    return c.json({ error: "user ids must be 1-64 char strings" }, 400);
  }
  await setRoster(c.env.HPS_KV, id, users);
  return c.json({ ok: true, size: users.length });
});

// #290 — append-merge roster. The endpoint above is a full replace, which
// forced callers into a client-side GET+replace round-trip that (a) races
// concurrent writers and (b) wipes the roster on a partial GET. Merging
// server-side removes both hazards. Issuer-role tokens scoped to the cohort
// may call it: a scoped issuer can already mint a student token, and being
// unable to put that student on the roster was the last admin-only step in
// the workshop-open flow.
const ROSTER_MAX = 500;
admin.post("/cohorts/:id/roster/append", async (c) => {
  const id = c.req.param("id");
  const issuerCheck = await authorizeIssuerForCohort(c, id);
  if (issuerCheck instanceof Response) return issuerCheck;

  const body = await c.req.json<{ users?: string[] }>().catch(() => ({} as { users?: string[] }));
  const users = body.users;
  if (!Array.isArray(users) || users.length === 0) {
    return c.json({ error: "users must be a non-empty array" }, 400);
  }
  if (users.some((u) => typeof u !== "string" || u.length < 1 || u.length > 64)) {
    return c.json({ error: "user ids must be 1-64 char strings" }, 400);
  }
  const existing = (await getRoster(c.env.HPS_KV, id))?.users ?? [];
  const merged = [...existing];
  const added: string[] = [];
  for (const u of users) {
    if (!merged.includes(u)) {
      merged.push(u);
      added.push(u);
    }
  }
  if (merged.length > ROSTER_MAX) {
    return c.json({ error: `roster would exceed ${ROSTER_MAX} users` }, 400);
  }
  if (added.length > 0) await setRoster(c.env.HPS_KV, id, merged);
  return c.json({ ok: true, size: merged.length, added });
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
// #290 — issuer-Bearer gate for roster append: any scope on this cohort is
// enough (no can_start_session needed — minting rights already imply the
// minted student must be able to join the roster). Same null/Response/result
// contract as authorizeIssuerForSession below.
async function authorizeIssuerForCohort(
  c: { env: Env; req: { header: (k: string) => string | undefined } },
  cohortId: string,
): Promise<{ scope: IssuerScope; payload: TokenPayload } | null | Response> {
  const auth = c.req.header("authorization") ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!bearerMatch || !bearerMatch[1]) return null;

  let payload: TokenPayload;
  try {
    payload = await verify(bearerMatch[1], c.env.HPS_SIGNING_SECRET);
  } catch (err) {
    return Response.json(
      { error: publicVerifyError(err, "issuer") },
      { status: 401 },
    );
  }
  if (payload.role !== "issuer") {
    return Response.json({ error: "token is not an issuer" }, { status: 403 });
  }
  const scope = (payload.scopes ?? []).find((s) => s.cohort === cohortId);
  if (!scope) {
    return Response.json(
      { error: `issuer not scoped to cohort=${cohortId}` },
      { status: 403 },
    );
  }
  if (payload.jti) {
    const rev = await isTokenRevoked(c.env.HPS_KV, payload.jti);
    if (rev) return Response.json({ error: "issuer token revoked" }, { status: 401 });
  }
  return { scope, payload };
}

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
      { error: publicVerifyError(err, "issuer") },
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

// ---- composite session open/close (#290 / #191) ------------------------------
//
// One call = live-session guard → mint student token → roster append →
// session start. Exists so an instructor holding only a scoped issuer token
// can open a workshop with zero admin involvement, and so the student token
// travels only inside this HTTPS response — never a CI log or public job
// summary (the leak that killed the PR #291 workflow approach).

admin.post("/cohorts/:id/session/open", async (c) => {
  const cohortId = c.req.param("id");
  type OpenBody = {
    profile_id?: string;
    user?: string;
    token_hours?: number;
    session_hours?: number;
    force?: boolean;
  };
  const body = (await c.req.json<OpenBody>().catch(() => ({} as OpenBody))) as OpenBody;
  const { profile_id, user } = body;
  if (!profile_id || typeof profile_id !== "string" || profile_id.length > 80) {
    return c.json({ error: "profile_id required" }, 400);
  }
  if (!user || typeof user !== "string" || user.length < 1 || user.length > 64) {
    return c.json({ error: "user required (1-64 chars)" }, 400);
  }
  const tokenHours = Number.isFinite(body.token_hours) ? Number(body.token_hours) : 6;
  const sessionHours = Number.isFinite(body.session_hours) ? Number(body.session_hours) : 3;
  // 24h hard cap on both: a rehearsal/workshop credential should never span
  // days, and it keeps the close-side revocation TTL bounded even when the
  // caller forgets to pass exp.
  if (tokenHours <= 0 || tokenHours > 24) return c.json({ error: "token_hours must be 1..24" }, 400);
  if (sessionHours <= 0 || sessionHours > 24) return c.json({ error: "session_hours must be 1..24" }, 400);

  const issuerCheck = await authorizeIssuerForSession(c, cohortId, profile_id);
  if (issuerCheck instanceof Response) return issuerCheck;
  if (issuerCheck) {
    const maxSession = issuerCheck.scope.max_session_hours ?? 4;
    if (sessionHours > maxSession) {
      return c.json(
        { error: `session_hours ${sessionHours} exceeds issuer scope max ${maxSession}h` },
        403,
      );
    }
    if (issuerCheck.scope.max_hours && tokenHours > issuerCheck.scope.max_hours) {
      return c.json(
        { error: `token_hours ${tokenHours} exceeds issuer scope max ${issuerCheck.scope.max_hours}h` },
        403,
      );
    }
  }

  // Guard — refuse to clobber a live session unless the caller opts in.
  // (active_session is a single key per cohort; a silent overwrite would end
  // whatever class is currently running — the #291 blast-radius concern.)
  const live = await getActiveSession(c.env.HPS_KV, cohortId);
  const liveNow = live && Date.parse(live.ends_at) > Date.now() ? live : null;
  if (liveNow && body.force !== true) {
    return c.json(
      { error: "cohort has a live session — pass force:true to replace it", active: liveNow },
      409,
    );
  }

  const { token, jti } = await issue(
    { u: user, c: cohortId, p: profile_id },
    tokenHours,
    c.env.HPS_SIGNING_SECRET,
  );

  // Roster merge — same server-side semantics as /roster/append.
  const existing = (await getRoster(c.env.HPS_KV, cohortId))?.users ?? [];
  const onRoster = existing.includes(user);
  if (!onRoster) await setRoster(c.env.HPS_KV, cohortId, [...existing, user]);

  const now = Date.now();
  const session: ActiveSession = {
    session_id: `${cohortId}-${new Date(now).toISOString().slice(0, 10)}`,
    profile_id,
    starts_at: new Date(now).toISOString(),
    ends_at: new Date(now + sessionHours * 3600_000).toISOString(),
  };
  await startSession(c.env.HPS_KV, cohortId, session);
  c.executionCtx.waitUntil(
    c.env.HPS_DB
      .prepare(
        `INSERT OR REPLACE INTO sessions (id, cohort_id, profile_id, starts_at, ends_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(session.session_id, cohortId, session.profile_id, session.starts_at, session.ends_at)
      .run(),
  );

  return c.json({
    ok: true,
    token,
    jti,
    user,
    cohort: cohortId,
    profile: profile_id,
    exp: Math.floor(now / 1000) + tokenHours * 3600,
    session,
    roster_size: onRoster ? existing.length : existing.length + 1,
    replaced: liveNow,
  });
});

admin.post("/cohorts/:id/session/close", async (c) => {
  const cohortId = c.req.param("id");
  type CloseBody = { jti?: string; exp?: number };
  const body = (await c.req.json<CloseBody>().catch(() => ({} as CloseBody))) as CloseBody;

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

  let revoked: string | null = null;
  if (body.jti) {
    if (!UUID_RE.test(body.jti)) return c.json({ error: "jti must be a valid UUID" }, 400);
    const now = Math.floor(Date.now() / 1000);
    // TTL runs to the token's actual exp when given — a fixed 24h TTL would
    // let a longer-lived token outlive its revocation record and come back
    // from the dead.
    const ttl = typeof body.exp === "number" && body.exp > now ? body.exp - now : 60 * 60 * 24;
    await revokeToken(c.env.HPS_KV, body.jti, { reason: "session-close", cohort: cohortId }, ttl);
    revoked = body.jti;
  }
  return c.json({ ok: true, ended: existing, revoked });
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
