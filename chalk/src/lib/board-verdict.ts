// The instructor board's verdict logic — a PURE function over rows.
//
// docs/plan/vessel-and-modules.md §4. No hono, no D1, no KV, no fetch, no
// clock: everything this module needs is passed in, so the whole thing replays
// against the labelled 2026-08-22 session in milliseconds with no app running
// (chalk/test/board-threshold.test.mjs).
//
// ---------------------------------------------------------------------------
// WHY THE THRESHOLDS LIVE HERE
// ---------------------------------------------------------------------------
// Spec §1, "The second question the rule does not ask": a threshold on the slow
// train is a threshold you cannot calibrate. Task E originally shipped a 60 s
// idle cut inside the Studio extension — a 1–2 h build plus a reinstall on
// every machine to correct. It was removed before release. These constants ride
// Chalk's 30-second train instead, and the wire carries only observations
// (a server-stamped `at`, a client-reported `idle_ms`) — never a client verdict.
//
// ---------------------------------------------------------------------------
// HOW THEY WERE DERIVED  (derive, don't guess — §4)
// ---------------------------------------------------------------------------
// Source: production D1 `usage_log`, read-only, the SK바이오팜 1회차 morning
// session of 2026-08-22 (session_id sk-biopharm-2026-a-2026-08-21) — 2,928 rows
// across 13 connected seats of a 15-seat roster. Frozen at
// chalk/test/fixtures/session-2026-08-22.json.
//
// The distribution was taken from the NINE seats the spec labels "fine"
// (-02 -03 -04 -05 -07 -08 -09 -10 -11), sampled every 10 s across the
// post-break working window 01:45–03:00 UTC (n = 4,046 seat-samples). The
// pre-break stretch is excluded on purpose: 00:52–01:40 is a class-wide break
// during which every seat is idle simultaneously, so including it would inflate
// the tail with an interval where "idle" is the correct state for everyone.
//
//   idle (now − last call), fine seats     mean wait between calls, trailing 15 min
//     p50    56 s                            p50     23.2 s
//     p75   143 s                            p75     30.7 s
//     p90   293 s   <- SLOWING               p90     45.1 s
//     p95   434 s                            p95     58.5 s
//     p98   612 s   <- QUIET                 p99     96.7 s
//     p99   692 s                            p99.9  170.4 s   <- STUCK
//     max   872 s                            max    360.0 s
//
// Sanity check against ClassAid (arXiv 2602.06734), whose 240 s inactivity
// threshold mimics instructor circulation. It does NOT transfer, in both
// directions, and the measurement is why:
//
//   • As an IDLE cut, 240 s is far too strict here. 13.6 % of fine-seat time
//     sits above it and all 9 fine seats cross it at least once. A board that
//     amber-flags nine of nine healthy seats is the noise failure mode the
//     positive control exists to catch — the tab gets closed. ClassAid watches
//     a student working alone; here the student is waiting on an agentic coach
//     whose calls take 10–50 s and then reading a long answer. Median idle is
//     56 s, not 5 s.
//   • As a MEAN-WAIT cut, 240 s is too permissive: seat -12, the labelled
//     stuck seat, measures 233 s at the instant the other two labels reproduce.
//     A 240 s cut MISSES the one seat the whole board exists to find.
//
// So: nothing here is 240 s, and that is a measured result rather than a
// disagreement with the paper.
// ---------------------------------------------------------------------------

/**
 * Trailing window the rate metrics are computed over. 15 minutes because that
 * is the unit the ground truth is stated in ("3 turns in 15 min", §4) — using
 * anything else would mean the labels no longer describe what is measured.
 */
export const ANALYSIS_WINDOW_MS = 15 * 60_000;

export interface BoardThresholds {
  /** Idle at/above this reads `slowing` (amber). p90 of fine-seat idle = 293 s. */
  slowingIdleMs: number;
  /**
   * Idle at/above this reads `quiet` (the -01/-06 state). p98 of fine-seat idle
   * = 612 s, rounded down to a round 10 minutes. Both labelled quiet
   * observations sit at 664 s / 666 s, so the cut clears them by ~10 % — it is
   * derived from the healthy distribution first and the labels only confirm it.
   */
  quietIdleMs: number;
  /**
   * Mean wait between calls (trailing window) at/above this reads `stuck`.
   * p99.9 of fine-seat mean wait = 170 s, rounded up to a round 3 minutes.
   * Seat -12 measures 233 s / 254 s at the two instants the ground truth was
   * taken — above the cut with ≥ 29 % margin.
   */
  stuckMeanWaitMs: number;
  /**
   * A mean needs at least two gaps to mean anything. Below this the seat has
   * no wait verdict at all and is judged on idle alone — never silently `ok`.
   */
  stuckMinCalls: number;
  /**
   * Heartbeat age at/above which a ping-capable seat reads `stale`.
   *
   * NOT DERIVED, and deliberately flagged as such: task E's heartbeat had not
   * shipped when the 2026-08-22 data was collected, so there is no ping history
   * to take a distribution from. 180 s = three missed pings at the slowest
   * client cadence (30–60 s, worker/src/lib/liveness.ts). Recalibrate from real
   * ping data the first session after E reaches participants; until then this
   * only ever refines an explanation, it never decides red vs green.
   */
  heartbeatStaleMs: number;
}

export const BOARD_THRESHOLDS: BoardThresholds = {
  slowingIdleMs: 300_000,
  quietIdleMs: 600_000,
  stuckMeanWaitMs: 180_000,
  stuckMinCalls: 3,
  heartbeatStaleMs: 180_000,
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Per-seat aggregate over the whole session so far. One `usage_log` row is one
 * model call, not one thing a child typed: an agentic turn fans out into
 * several calls seconds apart. `calls` is therefore a call count, and the seat
 * verdict is built on WAIT (time between calls) rather than on the count.
 */
export interface SeatSessionAgg {
  user_id: string;
  calls: number;
  /** Epoch ms of the last call. null when the seat has never called. */
  last_call_ms: number | null;
  first_call_ms: number | null;
  /**
   * Rows with an observed failure status. `null` means NOT OBSERVABLE — see
   * `ErrorSignal`. Never coerce null to 0; that is the false negative this
   * whole plan exists to remove.
   */
  failures: number | null;
  tokens_in: number;
  tokens_out: number;
}

/** Per-seat aggregate over the trailing ANALYSIS_WINDOW_MS. */
export interface SeatWindowAgg {
  user_id: string;
  calls: number;
  first_call_ms: number | null;
  last_call_ms: number | null;
  failures: number | null;
  mean_latency_ms: number | null;
}

/** Task E liveness, read from KV. Absent record => the seat contributes null. */
export interface SeatLiveness {
  /** Server-stamped observation time of the last heartbeat (epoch ms). */
  heartbeat_at_ms: number | null;
  /** Client-reported panel idle at that ping. ADVISORY ONLY — see deriveSeat. */
  heartbeat_panel_idle_ms: number | null;
  client_version: string | null;
  /** Server-stamped time of the last artifact change (epoch ms). */
  artifact_at_ms: number | null;
  artifact_bytes: number | null;
}

export const NO_LIVENESS: SeatLiveness = {
  heartbeat_at_ms: null,
  heartbeat_panel_idle_ms: null,
  client_version: null,
  artifact_at_ms: null,
  artifact_bytes: null,
};

export interface SeatInput {
  user_id: string;
  session: SeatSessionAgg;
  window: SeatWindowAgg;
  liveness: SeatLiveness;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * Seat states, worst first. Order is the precedence order used by deriveSeat().
 *
 *   absent   never made a call and never pinged. Today this seat does not
 *            appear in the admin panel AT ALL — 2 of 15 on 2026-08-22.
 *   failing  failures observed in the trailing window (needs task B live).
 *   quiet    idle >= quietIdleMs. The -01 / -06 state.
 *   stuck    working, but each wait is enormous. The -12 state.
 *   slowing  idle >= slowingIdleMs. Watch, do not walk over yet.
 *   ok       nothing to say.
 */
export const SEAT_STATES = ["absent", "failing", "quiet", "stuck", "slowing", "ok"] as const;
export type SeatState = (typeof SEAT_STATES)[number];

/** Three buckets so the page is readable in two seconds (§4 rule 3). */
export type SeatSeverity = "alert" | "watch" | "ok";

export const SEAT_SEVERITY: Record<SeatState, SeatSeverity> = {
  absent: "alert",
  failing: "alert",
  quiet: "alert",
  stuck: "alert",
  slowing: "watch",
  ok: "ok",
};

/**
 * Whether the failure columns mean anything yet.
 *
 *   observed  a non-2xx status can appear in this data — task B is live for it.
 *   unknown   it cannot. Every failure number renders as "—", never as 0, and
 *             no seat may be called `failing` OR cleared on failure grounds.
 */
export type ErrorSignal = "observed" | "unknown";

/** Heartbeat verdict. `unknown` is a first-class answer, not a fallback. */
export type HeartbeatState = "alive" | "stale" | "unknown";

export interface SeatVerdict {
  user_id: string;
  state: SeatState;
  severity: SeatSeverity;
  /** THE first column (§4 rule 2). null when the seat never called. */
  idle_ms: number | null;
  /** Mean gap between calls in the trailing window; null under stuckMinCalls. */
  mean_wait_ms: number | null;
  calls_in_window: number;
  calls_in_session: number;
  mean_latency_ms: number | null;
  /** null <=> errorSignal is "unknown". */
  failures_in_window: number | null;
  failures_in_session: number | null;
  heartbeat: HeartbeatState;
  heartbeat_age_ms: number | null;
  client_version: string | null;
  /** null when no artifact change has ever been observed for this seat. */
  artifact_age_ms: number | null;
  artifact_bytes: number | null;
  /**
   * Why this state, in the board's own vocabulary. Short machine tokens, never
   * prose and never anything a participant wrote.
   */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Mean gap between consecutive calls in a window.
 *
 * The mean of consecutive differences telescopes to (last − first) / (n − 1),
 * so the aggregate SQL never has to materialise the individual gaps. Returns
 * null below `minCalls` — a "mean" over one gap is not a rate, it is an
 * anecdote, and rounding it into a verdict is how a board starts lying.
 */
export function meanWaitMs(
  firstMs: number | null,
  lastMs: number | null,
  calls: number,
  minCalls: number,
): number | null {
  if (firstMs === null || lastMs === null) return null;
  if (calls < minCalls || calls < 2) return null;
  return (lastMs - firstMs) / (calls - 1);
}

/**
 * The verdict. Pure: same inputs, same answer, no clock read, no I/O.
 *
 * `nowMs` is the SERVER's clock, and every age is measured against it. The
 * client's own `idle_ms` never enters a comparison here (task E deliberately
 * stopped sending a computed state, spec §1): a browser clock cannot be
 * trusted to decide whether a child needs help, and a value computed on the
 * app's release train cannot be recalibrated. It is carried through to the
 * page as an observation only.
 */
export function deriveSeat(
  input: SeatInput,
  nowMs: number,
  errorSignal: ErrorSignal,
  cfg: BoardThresholds = BOARD_THRESHOLDS,
): SeatVerdict {
  const { session, window: win, liveness } = input;

  const idle_ms = session.last_call_ms === null ? null : Math.max(0, nowMs - session.last_call_ms);
  const mean_wait_ms = meanWaitMs(
    win.first_call_ms,
    win.last_call_ms,
    win.calls,
    cfg.stuckMinCalls,
  );

  const heartbeat_age_ms =
    liveness.heartbeat_at_ms === null ? null : Math.max(0, nowMs - liveness.heartbeat_at_ms);
  const heartbeat: HeartbeatState =
    heartbeat_age_ms === null
      ? // No record. Two indistinguishable causes — a client too old to ping
        // (the normal case until E ships; the app train is 1–2 h plus a
        // reinstall behind this one) and an app that died more than
        // HEARTBEAT_TTL_SEC ago. Reporting either as "fine" or as "dead" would
        // be a guess, so the board says it does not know.
        "unknown"
      : heartbeat_age_ms >= cfg.heartbeatStaleMs
        ? "stale"
        : "alive";

  // Failure columns are only meaningful once a failure CAN be recorded.
  const failures_in_window = errorSignal === "observed" ? (win.failures ?? 0) : null;
  const failures_in_session = errorSignal === "observed" ? (session.failures ?? 0) : null;

  const reasons: string[] = [];
  let state: SeatState;

  if (session.last_call_ms === null && liveness.heartbeat_at_ms === null) {
    // §4 rule 1, the whole reason this board exists. A roster seat with no
    // trace at all is the seat today's "recent N rows" panel cannot render.
    state = "absent";
    reasons.push("no_calls_ever", "no_heartbeat_ever");
  } else if (failures_in_window !== null && failures_in_window > 0) {
    state = "failing";
    reasons.push("failures_in_window");
  } else if (idle_ms !== null && idle_ms >= cfg.quietIdleMs) {
    state = "quiet";
    reasons.push("idle_ge_quiet");
    // §3's "third gap": quiet means two different things and the instructor
    // response differs. The heartbeat splits them — when there is one.
    if (heartbeat === "alive") reasons.push("app_alive");
    else if (heartbeat === "stale") reasons.push("app_not_pinging");
    else reasons.push("liveness_unknown");
  } else if (session.last_call_ms === null) {
    // Pinging but has never asked anything. Not absent, not idle-measurable.
    state = "quiet";
    reasons.push("heartbeat_only", "no_calls_ever");
  } else if (mean_wait_ms !== null && mean_wait_ms >= cfg.stuckMeanWaitMs) {
    state = "stuck";
    reasons.push("mean_wait_ge_stuck");
  } else if (idle_ms !== null && idle_ms >= cfg.slowingIdleMs) {
    state = "slowing";
    reasons.push("idle_ge_slowing");
  } else {
    state = "ok";
  }

  if (errorSignal === "unknown") reasons.push("error_signal_unknown");

  return {
    user_id: input.user_id,
    state,
    severity: SEAT_SEVERITY[state],
    idle_ms,
    mean_wait_ms,
    calls_in_window: win.calls,
    calls_in_session: session.calls,
    mean_latency_ms: win.mean_latency_ms,
    failures_in_window,
    failures_in_session,
    heartbeat,
    heartbeat_age_ms,
    client_version: liveness.client_version,
    artifact_age_ms:
      liveness.artifact_at_ms === null ? null : Math.max(0, nowMs - liveness.artifact_at_ms),
    artifact_bytes: liveness.artifact_bytes,
    reasons,
  };
}

/**
 * Sort order for the page: worst first, then longest idle first. An instructor
 * walking the room reads the top of the list and stops.
 */
export function compareSeats(a: SeatVerdict, b: SeatVerdict): number {
  const rank = (v: SeatVerdict) => SEAT_STATES.indexOf(v.state);
  const d = rank(a) - rank(b);
  if (d !== 0) return d;
  const ai = a.idle_ms ?? Number.MAX_SAFE_INTEGER;
  const bi = b.idle_ms ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return bi - ai;
  return a.user_id.localeCompare(b.user_id);
}

/**
 * Whether a failure can be observed in this data at all.
 *
 * Both inputs can only ever REVEAL the signal; neither can assert health from
 * silence, so the answer defaults to `unknown` and the false-negative direction
 * is unreachable by construction:
 *
 *   • `sawNon2xx` — a non-2xx row is proof by existence. Before task B every
 *     row was a hardcoded 200 (16,564 of them across seven weeks, §3), so such
 *     a row cannot exist unless B is live for it.
 *   • `signalFromMs` — HPS_ERROR_SIGNAL_FROM, the instant task B reached
 *     production. Unset => unknown, which is the safe direction if an operator
 *     forgets. Set => rows at or after it carry an observed status even if the
 *     class happened to have no errors at all.
 */
export function resolveErrorSignal(opts: {
  sawNon2xx: boolean;
  signalFromMs: number | null;
  windowStartMs: number;
}): ErrorSignal {
  if (opts.sawNon2xx) return "observed";
  if (opts.signalFromMs !== null && opts.windowStartMs >= opts.signalFromMs) return "observed";
  return "unknown";
}

/**
 * Capability degradations to announce on the page.
 *
 * Spec §5, "the vessel owes contracts too": announces lost capability — no
 * silent fallback. REQ-M30 is the precedent (one silent degradation was
 * misdiagnosed as three separate product defects). A column that quietly reads
 * "fine" because the data is not there yet would recreate exactly the defect
 * the preceding seven tasks removed.
 */
export function boardDegradations(
  errorSignal: ErrorSignal,
  seats: SeatVerdict[],
): Array<{ column: string; reason: string }> {
  const out: Array<{ column: string; reason: string }> = [];
  if (errorSignal === "unknown") {
    out.push({
      column: "failures",
      reason:
        "no failure row can exist in this data yet (task B not observed for this window) — " +
        "shown as unknown, never as zero",
    });
  }
  if (seats.length > 0 && seats.every((s) => s.heartbeat === "unknown")) {
    out.push({
      column: "heartbeat",
      reason:
        "no seat has ever pinged (task E not yet in a Studio release these seats run) — " +
        "'alive' vs 'not alive' is unanswerable, shown as unknown",
    });
  }
  return out;
}
