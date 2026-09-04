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
  /**
   * Gateway moderation blocked the turn (#320). Used for BOTH directions:
   * inbound (screened before upstream — zero tokens) and outbound (screened
   * after upstream answered — the tokens on the row were genuinely spent).
   * The student experience is identical either way ("I typed something and
   * the coach refused me"), so both render as the same seat state.
   */
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
 * The billing predicate, in ONE place. Import it; do not retype it.
 *
 * MEANING (changed by dag task L, settled by Jay 2026-09-04 — option (c)):
 * **"were tokens actually spent upstream"** — NOT "did the turn succeed".
 *
 * It used to be `status < 400`, which made one column answer two unrelated
 * questions: *did we spend money* (billing) and *did this turn help the
 * student* (the instructor board, #674). Outbound moderation is where the two
 * answers diverge and conflict: the model already ran and charged us, but the
 * child got nothing. Under the old predicate the only way to make the board
 * honest (write a non-200 status) silently stopped billing real spend, and the
 * only way to keep billing honest (leave status 200) rendered a completely
 * broken seat as healthy.
 *
 * So the predicates are decoupled. Two independent questions, two independent
 * columns:
 *
 *   billing -> USAGE_BILLABLE  (token columns: did upstream charge us)
 *   health  -> USAGE_FAILED / USAGE_HEALTHY  (status: did the student get help)
 *
 * Consequences, deliberate:
 *   - A mid-stream interruption (status 502, STREAM_INTERRUPTED) IS billed —
 *     those tokens were genuinely spent — and still renders as a failure.
 *   - An OUTBOUND moderation block (status 400, MODERATION_BLOCK) IS billed,
 *     and stops reading as a healthy 200.
 *   - Turns that never reached upstream (bad_request, config, inbound
 *     moderation, upstream_unreachable) carry zero tokens, so they contribute
 *     nothing to any billing aggregate — by arithmetic, not by a status
 *     filter. Nothing is billed that was not spent.
 *
 * Written over the four token columns rather than a status range precisely so
 * a failure that DID cost money cannot hide from the ledger.
 */
export const USAGE_BILLABLE = "(tokens_in + tokens_out + cache_read + cache_write) > 0";

/**
 * The HEALTH predicates — the other half of the decoupling above. `status` is
 * the observed outcome for the student, and answers the board's question only.
 * Never use these to gate a token/cost aggregate, and never use
 * USAGE_BILLABLE to decide whether a seat is doing fine.
 */
export const USAGE_FAILED = "status >= 400";
export const USAGE_HEALTHY = "status < 400";

/**
 * #684 — /admin/stats last-hour aggregate. Lives here (next to the writer and
 * the predicates) so tests can execute the REAL query instead of asserting on
 * a copy of its text.
 *
 * Each column now answers exactly one question (dag task L):
 *   requests  every attempt                        (no predicate)
 *   messages  turns that actually helped a student (HEALTH -> USAGE_HEALTHY)
 *   errors    turns that did not                   (HEALTH -> USAGE_FAILED)
 *   tokens_*  what upstream charged us             (BILLING -> USAGE_BILLABLE)
 *
 * So `messages + errors == requests` still holds, while the token columns are
 * free to include a failed-but-charged turn (outbound moderation block,
 * mid-stream interruption) instead of quietly writing that spend off.
 */
export const USAGE_LAST_HOUR_SQL = `SELECT
    COUNT(*) AS requests,
    SUM(CASE WHEN ${USAGE_HEALTHY} THEN 1 ELSE 0 END) AS messages,
    SUM(CASE WHEN ${USAGE_FAILED} THEN 1 ELSE 0 END) AS errors,
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
