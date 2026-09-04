// Per-request datapoint to Workers Analytics Engine. Queryable via SQL in
// the Cloudflare dashboard ("Workers Analytics Engine"). No PII.

import type { Env } from "../env";

export interface ChatLog {
  cohort_id: string;
  user_id: string;
  profile_id: string;
  model: string;
  // #684 — OBSERVED, never a literal. When there is no upstream response to
  // observe, a synthetic gateway status stands in (see ERROR_KIND).
  status: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_create: number;
  latency_ms: number;
  // #684 — coarse failure class, null on success. Deliberately a fixed
  // vocabulary (ERROR_KIND), never error prose: arbitrary upstream text is how
  // provider keys, URLs and student utterances leak into analytics (#257).
  error_kind?: string | null;
}

/**
 * #684 — coarse server-side failure vocabulary.
 *
 * Sibling of the client spool's `turn_end.error_kind`
 * (extensions/hypeproof-chat/src/chatPanelHelpers.ts `classifyTurnError`), so
 * the two can be laid side by side for one turn. The client classifies what IT
 * saw (auth:*, stall, aborted, transport); this classifies what the GATEWAY
 * saw. Complementary, not duplicates.
 *
 * These land in Analytics Engine (schemaless blobs) and in the log line — NOT
 * in a D1 column. `usage_log` has no error-class column and #684 is explicitly
 * a no-migration fix; in D1 the coarse class IS the status code (4xx request
 * shaped, 500 upstream fault, 502 gateway could not reach upstream), which is
 * what the instructor board (#674) needs to separate "erroring" from "absent".
 */
export const ERROR_KIND = {
  /** Body was not valid JSON / not the expected shape. Never reached upstream. */
  BAD_REQUEST: "bad_request",
  /** Gateway moderation blocked the turn before upstream (#320). Zero tokens. */
  MODERATION_BLOCK: "moderation_block",
  /** No usable LLM provider configured — our misconfiguration, not the student's. */
  CONFIG: "config",
  /** fetch() threw: DNS, TLS, region block, proxy down. No upstream status exists. */
  UPSTREAM_UNREACHABLE: "upstream_unreachable",
  /** Upstream answered 4xx — request-shaped (413 oversized image, 429 quota…). */
  UPSTREAM_4XX: "upstream_4xx",
  /** Upstream answered 5xx. */
  UPSTREAM_5XX: "upstream_5xx",
  /** Stream opened 200 then died mid-flight. Tokens so far are kept on the row. */
  STREAM_INTERRUPTED: "stream_interrupted",
} as const;

export type ErrorKind = (typeof ERROR_KIND)[keyof typeof ERROR_KIND];

/** #684 — classify an upstream response status we actually observed. */
export function upstreamErrorKind(status: number): ErrorKind {
  return status >= 500 ? ERROR_KIND.UPSTREAM_5XX : ERROR_KIND.UPSTREAM_4XX;
}

/**
 * #684 — the billing predicate, in ONE place.
 *
 * `usage_log` is the quota/billing ledger. Before #684 it only ever held
 * successful turns, so every aggregate could sum blindly. Now that failures
 * write rows, every token/cost aggregate MUST carry this predicate or the
 * gateway starts billing its own outages. Import it; do not retype it.
 */
export const USAGE_BILLABLE = "status < 400";

/**
 * #684 — /admin/stats last-hour aggregate. Lives here (next to the writer and
 * the predicate) so tests can execute the REAL query instead of asserting on a
 * copy of its text.
 *
 * `requests` counts every attempt, `messages` counts billable (successful)
 * turns, `errors` is now a real number instead of a structural zero.
 */
export const USAGE_LAST_HOUR_SQL = `SELECT
    COUNT(*) AS requests,
    SUM(CASE WHEN ${USAGE_BILLABLE} THEN 1 ELSE 0 END) AS messages,
    SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
    COALESCE(SUM(CASE WHEN ${USAGE_BILLABLE} THEN tokens_in  ELSE 0 END), 0) AS tokens_in,
    COALESCE(SUM(CASE WHEN ${USAGE_BILLABLE} THEN tokens_out ELSE 0 END), 0) AS tokens_out
 FROM usage_log
 WHERE created_at > datetime('now', '-1 hour')`;

export function logChat(env: Env, l: ChatLog): void {
  env.HPS_ANALYTICS.writeDataPoint({
    indexes: [l.cohort_id],
    // blobs[4] (#684) — the failure class, "" on success. Analytics Engine is
    // schemaless, so this costs no migration on either store.
    blobs: [l.user_id, l.profile_id, l.model, String(l.status), l.error_kind ?? ""],
    doubles: [l.tokens_in, l.tokens_out, l.cache_read, l.cache_create, l.latency_ms],
  });
}

// #320 — moderation-block datapoint (REQ-O5). Shares the dataset with chat
// datapoints; blobs[0] = "moderation_block" is the discriminator. Carries
// category + rule id + a short hash of the match — NEVER the matched text.
export interface ModerationLogEntry {
  cohort_id: string;
  user_id: string;
  profile_id: string;
  direction: "inbound" | "outbound";
  category: string;
  rule_id: string;
  match_hash: string;
}

export function logModeration(env: Env, l: ModerationLogEntry): void {
  env.HPS_ANALYTICS.writeDataPoint({
    indexes: [l.cohort_id],
    blobs: ["moderation_block", l.direction, l.category, l.rule_id, l.match_hash, l.user_id, l.profile_id],
    doubles: [1],
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
