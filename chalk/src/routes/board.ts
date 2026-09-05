// GET /admin/cohorts/:id/board — the instructor live board (plan task G,
// docs/plan/vessel-and-modules.md §4, issue #674).
//
// On 2026-08-22 the only way to find a stuck seat was hand-querying D1, three
// times in one day. Two seats went 11 minutes with no activity and, walking the
// room, were indistinguishable from students who were fine.
//
// The four rules this endpoint is built to (§4):
//   1. EVERY roster row is always rendered. Absence of activity is the signal,
//      so a quiet seat must occupy a row. Today's admin panel shows recent
//      rows, so the quiet student disappears first — that inversion is the
//      defect. See `resolveSeatSet` for what "the roster" can honestly mean.
//   2. First column is time-since-last-turn, ahead of any performance number.
//   3. Readable in two seconds — the instructor is walking with a phone.
//   4. ZERO prompt text. Latency, counts, error class, elapsed time, an
//      artifact-changed boolean. Nothing a participant wrote. This is what
//      keeps the board shippable for minor cohorts without a guardian-consent
//      procedure (PIPA Art. 22-2); a "recent question preview" column would
//      cross it and block the whole feature. Refuse it.
//
// Everything numeric is decided by chalk/src/lib/board-verdict.ts, which is
// pure and replays against the labelled 2026-08-22 session in
// chalk/test/board-threshold.test.mjs. This file only fetches and shapes.

import { Hono } from "hono";
import type { ChalkEnv } from "../env.ts";
import {
  authorizeIssuerForCohort,
  getActiveSession,
  getArtifact,
  getCohortPause,
  getHeartbeat,
  getRoster,
  USAGE_FAILED,
} from "../shared.ts";
import {
  ANALYSIS_WINDOW_MS,
  BOARD_THRESHOLDS,
  boardDegradations,
  compareSeats,
  deriveSeat,
  NO_LIVENESS,
  resolveErrorSignal,
  type ErrorSignal,
  type SeatInput,
  type SeatLiveness,
  type SeatSessionAgg,
  type SeatWindowAgg,
} from "../lib/board-verdict.ts";

export const board = new Hono<{ Bindings: ChalkEnv; Variables: { requestId: string } }>();

/** Session lookback when no session is open — long enough to cover a class. */
export const DEFAULT_LOOKBACK_MS = 4 * 60 * 60_000;

/** Hard cap on rendered rows. Rule 3: a 340-row page is not readable at all. */
export const MAX_SEATS = 60;

/**
 * `usage_log.created_at` is SQLite `datetime('now')` text — 'YYYY-MM-DD
 * HH:MM:SS', UTC, no timezone suffix. String comparison is chronological for
 * this format, which is what the WHERE clauses below rely on. Bounds MUST be
 * formatted identically or the comparison silently shifts by the length of the
 * suffix.
 */
export function d1Timestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** Parse a D1 'YYYY-MM-DD HH:MM:SS' stamp (UTC) back to epoch ms. */
export function d1ToMs(s: string | null | undefined): number | null {
  if (typeof s !== "string" || s.length < 19) return null;
  const ms = Date.parse(`${s.slice(0, 10)}T${s.slice(11, 19)}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Per-seat aggregate over the whole session window. Exported so the replay test
 * executes THIS text against a real SQLite rather than a paraphrase of it —
 * .claude/rules/verification.md rule 1: confirm the thing before judging it.
 *
 * `?1` cohort_id, `?2` window start (inclusive), `?3` now (inclusive).
 */
export const BOARD_SESSION_SQL = `SELECT
    user_id,
    COUNT(*)                                            AS calls,
    MIN(created_at)                                     AS first_at,
    MAX(created_at)                                     AS last_at,
    SUM(CASE WHEN ${USAGE_FAILED} THEN 1 ELSE 0 END)    AS failures,
    COALESCE(SUM(tokens_in), 0)                         AS tokens_in,
    COALESCE(SUM(tokens_out), 0)                        AS tokens_out
  FROM usage_log
  WHERE cohort_id = ?1 AND created_at >= ?2 AND created_at <= ?3
  GROUP BY user_id`;

/**
 * Per-seat aggregate over the trailing ANALYSIS_WINDOW_MS. The mean gap between
 * calls telescopes to (last − first) / (calls − 1), so the individual gaps
 * never have to be materialised — `meanWaitMs` does that division.
 *
 * `?1` cohort_id, `?2` window start (exclusive), `?3` now (inclusive).
 */
export const BOARD_WINDOW_SQL = `SELECT
    user_id,
    COUNT(*)                                            AS calls,
    MIN(created_at)                                     AS first_at,
    MAX(created_at)                                     AS last_at,
    SUM(CASE WHEN ${USAGE_FAILED} THEN 1 ELSE 0 END)    AS failures,
    AVG(latency_ms)                                     AS mean_latency_ms
  FROM usage_log
  WHERE cohort_id = ?1 AND created_at > ?2 AND created_at <= ?3
  GROUP BY user_id`;

interface AggRow {
  user_id: string;
  calls: number;
  first_at: string | null;
  last_at: string | null;
  failures: number | null;
  tokens_in?: number;
  tokens_out?: number;
  mean_latency_ms?: number | null;
}

export function toSessionAgg(userId: string, r: AggRow | undefined): SeatSessionAgg {
  return {
    user_id: userId,
    calls: r?.calls ?? 0,
    first_call_ms: d1ToMs(r?.first_at),
    last_call_ms: d1ToMs(r?.last_at),
    failures: r ? Number(r.failures ?? 0) : 0,
    tokens_in: Number(r?.tokens_in ?? 0),
    tokens_out: Number(r?.tokens_out ?? 0),
  };
}

export function toWindowAgg(userId: string, r: AggRow | undefined): SeatWindowAgg {
  return {
    user_id: userId,
    calls: r?.calls ?? 0,
    first_call_ms: d1ToMs(r?.first_at),
    last_call_ms: d1ToMs(r?.last_at),
    failures: r ? Number(r.failures ?? 0) : 0,
    mean_latency_ms:
      r && r.mean_latency_ms != null && Number.isFinite(Number(r.mean_latency_ms))
        ? Math.round(Number(r.mean_latency_ms))
        : null,
  };
}

/**
 * Which seats occupy a row — rule 1's hardest practical question, and one the
 * spec does not settle.
 *
 * OBSERVED PROBLEM: `cohort:<id>:roster` is CUMULATIVE. Production's
 * sk-biopharm-2026-a roster holds 340 user ids, every seat of every session
 * ever run on that cohort, and there is no per-session seat list anywhere in KV
 * or D1 (sessions has id/profile/times, nothing about who). Rendering "the
 * roster" literally would put 340 rows on a phone screen, which fails rule 3
 * as badly as hiding the quiet seat fails rule 1.
 *
 * So the seat set is explicit, and the response always says which mode it is in:
 *
 *   seat_prefix=SK34-CM6YPX-   the roster filtered by the batch prefix the
 *                              instructor's own token mint produced. Complete:
 *                              a seat that never opened Studio still gets a
 *                              row. THIS is rule 1 in full — on 2026-08-22 it
 *                              is what makes -13 and -15 visible, two seats
 *                              that made zero calls all day and appear nowhere
 *                              in usage_log.
 *   (omitted)                  seats OBSERVED this session: any seat with a
 *                              usage row in the window, plus any seat with a
 *                              task-E liveness record. Marked complete:false
 *                              and announced as a degradation, because a seat
 *                              that never connected cannot be in it.
 *
 * The fallback is never silent. Guessing a prefix from the observed ids would
 * be exactly the "aha, it will probably look like this" reasoning that was
 * wrong 9 times out of 9 on 2026-07-25..27.
 */
export function resolveSeatSet(opts: {
  roster: string[];
  seatPrefix: string | null;
  observed: string[];
}): { seats: string[]; source: "prefix" | "observed"; complete: boolean; truncated: boolean } {
  const source = opts.seatPrefix ? "prefix" : "observed";
  const raw =
    opts.seatPrefix !== null
      ? opts.roster.filter((u) => u.startsWith(opts.seatPrefix as string))
      : [...new Set(opts.observed)];
  const seats = raw.slice().sort((a, b) => a.localeCompare(b));
  return {
    seats: seats.slice(0, MAX_SEATS),
    source,
    complete: source === "prefix",
    truncated: seats.length > MAX_SEATS,
  };
}

/** HPS_ERROR_SIGNAL_FROM → epoch ms, or null when unset/unparseable. */
export function parseErrorSignalFrom(v: string | undefined): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const ms = Date.parse(v.trim());
  return Number.isFinite(ms) ? ms : null;
}

board.get("/cohorts/:id/board", async (c) => {
  const cohortId = c.req.param("id");
  const authz = await authorizeIssuerForCohort(c, cohortId);
  if (authz instanceof Response) return authz;
  if (authz === null) {
    return c.json({ error: "instructor issuer token required (Authorization: Bearer …)" }, 401);
  }

  const nowMs = Date.now();
  const rawPrefix = c.req.query("seat_prefix");
  // Bounded and boring: this string goes into a String.startsWith over roster
  // ids only (never into SQL, never into HTML without escaping).
  const seatPrefix =
    typeof rawPrefix === "string" && rawPrefix.trim().length > 0 && rawPrefix.length <= 64
      ? rawPrefix.trim()
      : null;

  const [session, roster, paused] = await Promise.all([
    getActiveSession(c.env.HPS_KV, cohortId),
    getRoster(c.env.HPS_KV, cohortId),
    getCohortPause(c.env.HPS_KV, cohortId),
  ]);

  const sessionStartMs = session ? Date.parse(session.starts_at) : NaN;
  const windowStartMs = Number.isFinite(sessionStartMs)
    ? sessionStartMs
    : nowMs - DEFAULT_LOOKBACK_MS;
  const recentStartMs = nowMs - ANALYSIS_WINDOW_MS;

  const nowStamp = d1Timestamp(nowMs);
  const [sessionRes, windowRes] = await Promise.all([
    c.env.HPS_DB.prepare(BOARD_SESSION_SQL)
      .bind(cohortId, d1Timestamp(windowStartMs), nowStamp)
      .all<AggRow>(),
    c.env.HPS_DB.prepare(BOARD_WINDOW_SQL)
      .bind(cohortId, d1Timestamp(recentStartMs), nowStamp)
      .all<AggRow>(),
  ]);
  const sessionRows = sessionRes.results ?? [];
  const windowRows = windowRes.results ?? [];
  const byUserSession = new Map(sessionRows.map((r) => [r.user_id, r]));
  const byUserWindow = new Map(windowRows.map((r) => [r.user_id, r]));

  const set = resolveSeatSet({
    roster: roster?.users ?? [],
    seatPrefix,
    observed: sessionRows.map((r) => r.user_id),
  });

  // Liveness is one KV read per rendered seat. Bounded by MAX_SEATS.
  const liveness = new Map<string, SeatLiveness>();
  await Promise.all(
    set.seats.map(async (u) => {
      const [hb, af] = await Promise.all([
        getHeartbeat(c.env.HPS_KV, cohortId, u),
        getArtifact(c.env.HPS_KV, cohortId, u),
      ]);
      liveness.set(u, {
        heartbeat_at_ms: hb ? Date.parse(hb.at) || null : null,
        heartbeat_panel_idle_ms: hb && typeof hb.idle_ms === "number" ? hb.idle_ms : null,
        client_version: hb?.client_version ?? null,
        artifact_at_ms: af ? Date.parse(af.at) || null : null,
        artifact_bytes: af ? af.bytes : null,
      });
    }),
  );

  const sawNon2xx =
    sessionRows.some((r) => Number(r.failures ?? 0) > 0) ||
    windowRows.some((r) => Number(r.failures ?? 0) > 0);
  const errorSignal: ErrorSignal = resolveErrorSignal({
    sawNon2xx,
    signalFromMs: parseErrorSignalFrom(c.env.HPS_ERROR_SIGNAL_FROM),
    windowStartMs,
  });

  const seats = set.seats
    .map((u) => {
      const input: SeatInput = {
        user_id: u,
        session: toSessionAgg(u, byUserSession.get(u)),
        window: toWindowAgg(u, byUserWindow.get(u)),
        liveness: liveness.get(u) ?? NO_LIVENESS,
      };
      return deriveSeat(input, nowMs, errorSignal, BOARD_THRESHOLDS);
    })
    .sort(compareSeats);

  const degraded = boardDegradations(errorSignal, seats);
  if (!set.complete) {
    degraded.push({
      column: "roster",
      reason:
        "showing seats OBSERVED this session — the cohort roster is cumulative across " +
        "every session ever run, so it cannot be rendered as-is. A seat that never " +
        "connected is NOT in this list. Pass ?seat_prefix=<batch prefix> for the full roster.",
    });
  }
  if (set.truncated) {
    degraded.push({
      column: "roster",
      reason: `more than ${MAX_SEATS} seats matched — the list is truncated. Narrow seat_prefix.`,
    });
  }

  return c.json({
    id: cohortId,
    // Server clock. The board derives every age from THIS, never from a client
    // clock and never from a client-computed state (spec §1, task E).
    now: new Date(nowMs).toISOString(),
    session,
    paused,
    window: {
      session_start: new Date(windowStartMs).toISOString(),
      analysis_window_ms: ANALYSIS_WINDOW_MS,
    },
    thresholds: BOARD_THRESHOLDS,
    error_signal: errorSignal,
    roster: {
      source: set.source,
      complete: set.complete,
      rendered: seats.length,
      cohort_roster_size: roster?.users.length ?? 0,
    },
    degraded,
    seats,
  });
});
