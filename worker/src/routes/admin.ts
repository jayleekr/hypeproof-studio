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
import {
  endSession,
  getActiveSession,
  getCohortPause,
  getRoster,
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
      essences_focus: p.essences_focus,
    })),
  });
});
