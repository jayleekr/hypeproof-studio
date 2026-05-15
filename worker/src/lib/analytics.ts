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
export async function persistUsage(env: Env, l: ChatLog & { session_id: string | null }): Promise<void> {
  await env.HPS_DB
    .prepare(
      `INSERT INTO usage_log
        (session_id, cohort_id, user_id, profile_id, model,
         tokens_in, tokens_out, cache_read, cache_write, latency_ms, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      l.session_id,
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
}
