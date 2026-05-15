// KV access helpers. Keys are stable strings; never embed PII.
//
// Layout:
//   cohort:<id>:roster           → { users: string[], updated_at: string }
//   cohort:<id>:active_session   → { session_id, profile_id, starts_at, ends_at }
//
// Roster + active_session are intentionally KV (not D1) because the chat hot
// path reads them on every request. D1 holds durable history in `sessions` and
// `usage_log` tables.

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

const rosterKey = (cohortId: string) => `cohort:${cohortId}:roster`;
const sessionKey = (cohortId: string) => `cohort:${cohortId}:active_session`;

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
