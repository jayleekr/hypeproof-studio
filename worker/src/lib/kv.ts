// KV access helpers. Keys are stable strings; never embed PII.
//
// Layout:
//   cohort:<id>:roster           → { users: string[], updated_at: string }
//   cohort:<id>:active_session   → { session_id, profile_id, starts_at, ends_at }
//   cohort:<id>:paused           → { ts, reason? }   — S-12 kill-switch (#47)
//   revoked:<jti>                → { ts, reason?, cohort, user } — S-01 (#46)
//   issuer_audit:<jti>           → { instructor, scopes, exp, days, ... } — #294/#295 mint trail
//
// Roster + active_session + paused + revoked are intentionally KV (not D1)
// because the chat hot path reads them on every request. D1 holds durable
// history in `sessions` and `usage_log` tables.

import type { IssuerScope } from "./tokens";

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
const ISSUER_AUDIT_PREFIX = "issuer_audit:";
export const issuerAuditKey = (jti: string) => `${ISSUER_AUDIT_PREFIX}${jti}`;

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

// --- issuer mint-lineage audit (#294 / #295 / #313) -------------------------
// Metadata-only record `/admin/issuers` POST writes on every mint (NEVER the
// token). TTL tracks the issued token's lifetime, so the working set is small
// (tens) and prefix-scanning it is an ops-console operation, not a hot path.

export interface IssuerAuditRecord {
  instructor: string;           // issuer-token subject (the instructor handle)
  scopes: IssuerScope[];        // cohort/profile authority granted
  exp: number;                  // unix seconds — the issued token's expiry
  days: number;                 // requested lifetime in days
  revoked_jti: string | null;   // jti this mint replaced on re-scope, if any
  minted_by: string;            // "admin" (Basic/CF) OR the Bearer minter handle
  can_issue_issuers: boolean;   // whether the child is itself an admin-minter
}

/**
 * List issuer-mint audit records, optionally filtered to a single minter.
 *
 * The lineage query behind #313: when a member departs or a minter token leaks,
 * "which instructor issuers did minter X create?" has no answer without scanning
 * `issuer_audit:` and matching `minted_by` — additional mints are blocked the
 * moment the minter is revoked, but the issuers it already signed live until
 * their own expiry (≤90d) and must be found to be revoked.
 *
 * KV scan → get per key (list() returns names only), so it is O(matched keys).
 * `limit` caps the number of returned records; a single KV list() page is
 * capped at 1000 keys by the platform, so we page with the cursor until we have
 * `limit` matches or the namespace is exhausted.
 */
export async function listIssuerAudits(
  kv: KVNamespace,
  opts: { mintedBy?: string; limit?: number } = {},
): Promise<Array<{ jti: string; record: IssuerAuditRecord }>> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const out: Array<{ jti: string; record: IssuerAuditRecord }> = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: ISSUER_AUDIT_PREFIX, limit: 1000, cursor });
    for (const k of page.keys) {
      const record = await kv.get<IssuerAuditRecord>(k.name, "json");
      if (!record) continue;
      if (opts.mintedBy !== undefined && record.minted_by !== opts.mintedBy) continue;
      out.push({ jti: k.name.slice(ISSUER_AUDIT_PREFIX.length), record });
      if (out.length >= limit) return out;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
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
