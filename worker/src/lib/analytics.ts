// Per-request datapoint to Workers Analytics Engine. Queryable via SQL in
// the Cloudflare dashboard ("Workers Analytics Engine"). No PII.

import type { Env } from "../env";

export interface ChatLog {
  cohort_id: string;
  user_id: string;
  profile_id: string;
  model: string;
  status: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_create: number;
  latency_ms: number;
}

export function logChat(env: Env, l: ChatLog): void {
  env.HPS_ANALYTICS.writeDataPoint({
    indexes: [l.cohort_id],
    blobs: [l.user_id, l.profile_id, l.model, String(l.status)],
    doubles: [l.tokens_in, l.tokens_out, l.cache_read, l.cache_create, l.latency_ms],
  });
}

// Also persist to D1 for historical query. Fire-and-forget via ctx.waitUntil.
//
// Resilience (prod D1 accounting outage postmortem): usage_log.session_id
// REFERENCES sessions(id) and D1 enforces foreign keys unconditionally. When
// the parent sessions row is missing (e.g. a session opened before the
// sessions D1 mirror existed, or the mirror write itself failed), the INSERT
// rejects with SQLITE_CONSTRAINT_FOREIGNKEY — and because callers waitUntil()
// this promise, the row silently vanished. Accounting must never be lost to
// attribution: log loudly, then retry once with session_id=NULL (the column
// is nullable). This function never rejects — it is always fire-and-forget.
export async function persistUsage(env: Env, l: ChatLog & { session_id: string | null }): Promise<void> {
  const insert = (session_id: string | null) =>
    env.HPS_DB
      .prepare(
        `INSERT INTO usage_log
          (session_id, cohort_id, user_id, profile_id, model,
           tokens_in, tokens_out, cache_read, cache_write, latency_ms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        session_id,
        l.cohort_id,
        l.user_id,
        l.profile_id,
        l.model,
        l.tokens_in,
        l.tokens_out,
        l.cache_read,
        l.cache_create,
        l.latency_ms,
        l.status,
      )
      .run();
  try {
    await insert(l.session_id);
  } catch (err) {
    console.error(
      `persistUsage: usage_log INSERT failed (cohort=${l.cohort_id} user=${l.user_id} session=${l.session_id}):`,
      err,
    );
    if (l.session_id == null) return;
    try {
      await insert(null);
      console.error(
        `persistUsage: retried with session_id=NULL — usage saved without session attribution (cohort=${l.cohort_id} user=${l.user_id})`,
      );
    } catch (err2) {
      console.error("persistUsage: session_id=NULL retry also failed — usage row LOST:", err2);
    }
  }
}
