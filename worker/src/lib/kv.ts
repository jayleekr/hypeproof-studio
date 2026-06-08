// KV access helpers. Keys are stable strings; never embed PII.
//
// Layout:
//   cohort:<id>:roster           → { users: string[], updated_at: string }
//   cohort:<id>:active_session   → { session_id, profile_id, starts_at, ends_at }
//   cohort:<id>:paused           → { ts, reason? }   — S-12 kill-switch (#47)
//   revoked:<jti>                → { ts, reason?, cohort, user } — S-01 (#46)
//
// Roster + active_session + paused + revoked are intentionally KV (not D1)
// because the chat hot path reads them on every request. D1 holds durable
// history in `sessions` and `usage_log` tables.

export interface Roster {
  users: string[];
  updated_at: string;
}

export interface ActiveSession {
  session_id: string;
  profile_id: string;
  starts_at: string;            // ISO8601
  ends_at: string;              // ISO8601
}

export interface CohortPause {
  ts: string;                   // ISO8601 when paused
  reason?: string;              // optional human note
}

export interface TokenRevocation {
  ts: string;                   // ISO8601 when revoked
  reason?: string;              // optional human note
  cohort?: string;              // cohort id from the payload (audit hint)
  user?: string;                // user id from the payload (audit hint)
}

const rosterKey = (cohortId: string) => `cohort:${cohortId}:roster`;
const sessionKey = (cohortId: string) => `cohort:${cohortId}:active_session`;
const pauseKey = (cohortId: string) => `cohort:${cohortId}:paused`;
const revokedKey = (jti: string) => `revoked:${jti}`;

export async function getRoster(kv: KVNamespace, cohortId: string): Promise<Roster | null> {
  return kv.get<Roster>(rosterKey(cohortId), "json");
}

export async function setRoster(kv: KVNamespace, cohortId: string, users: string[]): Promise<void> {
  const r: Roster = { users, updated_at: new Date().toISOString() };
  await kv.put(rosterKey(cohortId), JSON.stringify(r));
}

export async function getActiveSession(kv: KVNamespace, cohortId: string): Promise<ActiveSession | null> {
  return kv.get<ActiveSession>(sessionKey(cohortId), "json");
}

export async function startSession(
  kv: KVNamespace,
  cohortId: string,
  s: ActiveSession,
): Promise<void> {
  const ttlSec = Math.max(60, Math.floor((Date.parse(s.ends_at) - Date.now()) / 1000) + 300);
  await kv.put(sessionKey(cohortId), JSON.stringify(s), { expirationTtl: ttlSec });
}

export async function endSession(kv: KVNamespace, cohortId: string): Promise<void> {
  await kv.delete(sessionKey(cohortId));
}

/** True if `now` is between `starts_at` and `ends_at`. */
export function isSessionLive(s: ActiveSession, now: Date = new Date()): boolean {
  const start = Date.parse(s.starts_at);
  const end = Date.parse(s.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const t = now.getTime();
  return t >= start && t <= end;
}

// ---- cohort kill-switch (S-12 / #47) ---------------------------------------
// Single KV key flip → chat.ts returns 503 immediately. Independent of
// session/roster, so a cohort can be paused mid-class without nuking state.

export async function getCohortPause(kv: KVNamespace, cohortId: string): Promise<CohortPause | null> {
  return kv.get<CohortPause>(pauseKey(cohortId), "json");
}

export async function pauseCohort(
  kv: KVNamespace,
  cohortId: string,
  reason?: string,
): Promise<CohortPause> {
  const p: CohortPause = { ts: new Date().toISOString(), reason };
  // 24h TTL — a pause is a fire-drill, not a permanent state. Forces the
  // operator to consciously re-pause if the incident lasts longer.
  await kv.put(pauseKey(cohortId), JSON.stringify(p), { expirationTtl: 60 * 60 * 24 });
  return p;
}

export async function unpauseCohort(kv: KVNamespace, cohortId: string): Promise<void> {
  await kv.delete(pauseKey(cohortId));
}

// ---- token revocation (S-01 / #46) -----------------------------------------
// Per-token kill (vs the cohort-wide pause above). Caller computes
// expirationTtl from the token's exp claim so revocation records
// auto-disappear when they're no longer useful.

export async function isTokenRevoked(kv: KVNamespace, jti: string): Promise<TokenRevocation | null> {
  return kv.get<TokenRevocation>(revokedKey(jti), "json");
}

export async function revokeToken(
  kv: KVNamespace,
  jti: string,
  rev: Omit<TokenRevocation, "ts">,
  ttlSeconds: number,
): Promise<TokenRevocation> {
  const record: TokenRevocation = { ts: new Date().toISOString(), ...rev };
  await kv.put(revokedKey(jti), JSON.stringify(record), {
    // Floor at 60s so KV accepts; cap at 60d so a forgotten revocation
    // doesn't accumulate forever.
    expirationTtl: Math.max(60, Math.min(ttlSeconds, 60 * 60 * 24 * 60)),
  });
  return record;
}

export async function unrevokeToken(kv: KVNamespace, jti: string): Promise<void> {
  await kv.delete(revokedKey(jti));
}

/** List revoked jti's with optional limit (KV scan, expensive — keep small). */
export async function listRevoked(
  kv: KVNamespace,
  opts: { limit?: number } = {},
): Promise<Array<{ jti: string; record: TokenRevocation }>> {
  const list = await kv.list({ prefix: "revoked:", limit: opts.limit ?? 100 });
  const out: Array<{ jti: string; record: TokenRevocation }> = [];
  for (const k of list.keys) {
    const jti = k.name.slice("revoked:".length);
    const record = await kv.get<TokenRevocation>(k.name, "json");
    if (record) out.push({ jti, record });
  }
  return out;
}

// --- coarse rate limiting (#33 F#6) -----------------------------------------
// Best-effort per-key counter in a fixed window. KV is eventually consistent
// and the increment is read-modify-write (not atomic), so this is a coarse
// abuse guard — fine layered on top of the session + roster gate, not an exact
// limiter. `now` is injectable for tests.
export interface RateResult {
  allowed: boolean;
  count: number;
}

export async function bumpRateCounter(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSec: number,
  now: number = Date.now(),
): Promise<RateResult> {
  const cur = await kv.get<{ n: number; resetAt: number }>(key, "json");
  let n = 1;
  let resetAt = now + windowSec * 1000;
  if (cur && typeof cur.resetAt === "number" && cur.resetAt > now) {
    n = (typeof cur.n === "number" ? cur.n : 0) + 1;
    resetAt = cur.resetAt;
  }
  await kv.put(key, JSON.stringify({ n, resetAt }), { expirationTtl: windowSec });
  return { allowed: n <= limit, count: n };
}
