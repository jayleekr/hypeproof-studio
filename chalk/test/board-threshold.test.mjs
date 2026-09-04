// Calibration replay for the instructor live board (plan task G, spec §4).
//
// "Derive, don't guess." Labelled ground truth exists: on 2026-08-22 seat -12
// was stuck, -01 and -06 went quiet, the rest were fine. That session is frozen
// in test/fixtures/session-2026-08-22.json (2,928 real usage_log rows, pulled
// read-only from production D1), and this file replays it against the shipping
// verdict logic. Milliseconds, no app, no network.
//
// Three things make this an instrument rather than a decoration
// (.claude/rules/verification.md):
//
//  1. It executes the PRODUCTION SQL. BOARD_SESSION_SQL / BOARD_WINDOW_SQL are
//     imported from src/routes/board.ts and run against a real SQLite
//     (node:sqlite) loaded with the real rows — not a JS reimplementation of
//     what the query is believed to do. Rule 1: open the thing before judging
//     it.
//  2. It runs BOTH controls. The positive control (nine fine seats come back
//     green) is the one that matters most, because today's error direction is
//     "too strict": a board that flags healthy seats is noise, and the tab gets
//     closed. The negative control catches a permissive board.
//  3. It plants the answer and then checks the instrument can fail. Section 5
//     perturbs each threshold and asserts a control BREAKS. A control that
//     passes under every threshold is measuring nothing.
//
// Run: node --experimental-strip-types chalk/test/board-threshold.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import "../../worker/test/harness/loader.mjs";

const {
  BOARD_THRESHOLDS,
  ANALYSIS_WINDOW_MS,
  deriveSeat,
  meanWaitMs,
  resolveErrorSignal,
  boardDegradations,
  compareSeats,
  NO_LIVENESS,
} = await import("../src/lib/board-verdict.ts");
const {
  BOARD_SESSION_SQL,
  BOARD_WINDOW_SQL,
  toSessionAgg,
  toWindowAgg,
  d1Timestamp,
  d1ToMs,
  resolveSeatSet,
} = await import("../src/routes/board.ts");

const FX = JSON.parse(
  readFileSync(new URL("./fixtures/session-2026-08-22.json", import.meta.url), "utf8"),
);
const BASE_MS = Date.parse(FX.base_utc.replace(" ", "T") + "Z");

// ---------------------------------------------------------------------------
// 0. Load the real rows into a real SQLite, in the real usage_log shape.
// ---------------------------------------------------------------------------
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, cohort_id TEXT, user_id TEXT, profile_id TEXT, model TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER, status INTEGER NOT NULL, created_at TEXT NOT NULL, trial_id TEXT)`);
{
  const ins = db.prepare(
    `INSERT INTO usage_log (session_id, cohort_id, user_id, model, tokens_in, tokens_out,
      latency_ms, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const [seatIdx, offsetSec, status, latency] of FX.rows) {
    ins.run(
      FX.session_id,
      FX.cohort_id,
      FX.seats[seatIdx],
      "claude-sonnet-4-6",
      3,
      120,
      latency,
      status,
      d1Timestamp(BASE_MS + offsetSec * 1000),
    );
  }
}
assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_log").get().n, FX.rows.length);

// The fixture predates task B, so nothing in it can carry a failure status.
// This is asserted rather than assumed — it is the premise of section 4.
assert.equal(
  db.prepare("SELECT COUNT(*) n FROM usage_log WHERE status >= 400").get().n,
  0,
  "fixture premise: pre-B data cannot contain a failure row",
);

// ---------------------------------------------------------------------------
// 1. The replay — the production SQL, at a named instant.
// ---------------------------------------------------------------------------
const sessionStart = d1Timestamp(BASE_MS - 60_000);

function boardAt(nowMs, thresholds = BOARD_THRESHOLDS, seatSet = FX.roster) {
  const nowStamp = d1Timestamp(nowMs);
  const sess = db
    .prepare(BOARD_SESSION_SQL.replace(/\?1/g, "?").replace(/\?2/g, "?").replace(/\?3/g, "?"))
    .all(FX.cohort_id, sessionStart, nowStamp);
  const win = db
    .prepare(BOARD_WINDOW_SQL.replace(/\?1/g, "?").replace(/\?2/g, "?").replace(/\?3/g, "?"))
    .all(FX.cohort_id, d1Timestamp(nowMs - ANALYSIS_WINDOW_MS), nowStamp);
  const bySess = new Map(sess.map((r) => [r.user_id, r]));
  const byWin = new Map(win.map((r) => [r.user_id, r]));
  const errorSignal = resolveErrorSignal({
    sawNon2xx: sess.some((r) => Number(r.failures ?? 0) > 0),
    signalFromMs: null, // HPS_ERROR_SIGNAL_FROM unset — 2026-08-22 predates B.
    windowStartMs: BASE_MS,
  });
  const seats = seatSet
    .map((u) =>
      deriveSeat(
        {
          user_id: u,
          session: toSessionAgg(u, bySess.get(u)),
          window: toWindowAgg(u, byWin.get(u)),
          liveness: NO_LIVENESS, // 2026-08-22 predates task E: no heartbeats exist.
        },
        nowMs,
        errorSignal,
        thresholds,
      ),
    )
    .sort(compareSeats);
  return { seats, errorSignal, byState: Object.fromEntries(seats.map((s) => [s.user_id, s.state])) };
}

// The instant the two "quiet" labels reproduce simultaneously — DERIVED, not
// assumed. -01's last call is 02:14:39 and -06's is 02:14:41, so 02:25:45 is
// the only narrow band in the whole class where both read exactly 11 minutes
// idle. (-01 comes back at 02:25:50, five seconds later.)
const T_QUIET = Date.parse("2026-08-22T02:25:45Z");
// The instant the "-12: 3 turns in 15 min, 250 s mean wait" label reproduces:
// -12's calls at 02:08:29 / 02:13:13 / 02:16:57 give exactly 3 in the window and
// a mean wait of 254 s. The spec's three numbers come from three different D1
// queries that day, so they do not share one instant — the board must flag -12
// at both.
const T_STUCK = Date.parse("2026-08-22T02:20:00Z");

const quietBoard = boardAt(T_QUIET);
const stuckBoard = boardAt(T_STUCK);

// ---------------------------------------------------------------------------
// 2. POSITIVE CONTROL — the seats that were fine come back green.
//    This is the one that catches an over-strict board, the failure mode that
//    turns instructor attention into noise and gets the tab closed.
// ---------------------------------------------------------------------------
for (const u of FX.labels.fine) {
  const s = quietBoard.seats.find((x) => x.user_id === u);
  assert.equal(
    s.state,
    "ok",
    `positive control: ${u} was fine on 2026-08-22 and must render ok, got "${s.state}" ` +
      `(idle ${s.idle_ms} ms, mean wait ${s.mean_wait_ms} ms)`,
  );
  assert.equal(s.severity, "ok");
}
console.log(`✓ positive control: all ${FX.labels.fine.length} fine seats render ok at 02:25:45Z`);

// ---------------------------------------------------------------------------
// 3. NEGATIVE CONTROL — the three labelled bad seats, and the two the summary
//    table does not mention because today's panel cannot see them at all.
// ---------------------------------------------------------------------------
for (const u of FX.labels.quiet) {
  const s = quietBoard.seats.find((x) => x.user_id === u);
  assert.equal(s.state, "quiet", `negative control: ${u} went 11 min with no activity`);
  assert.ok(s.idle_ms >= 600_000 && s.idle_ms < 720_000, `${u} idle ~11 min, got ${s.idle_ms} ms`);
  assert.equal(s.severity, "alert");
  // §3's "third gap" — quiet means two things and this data cannot split them.
  assert.ok(s.reasons.includes("liveness_unknown"), "no heartbeat exists in pre-E data");
}
console.log("✓ negative control: -01 and -06 render quiet (11 min idle), liveness unknown");

for (const u of FX.labels.stuck) {
  const a = quietBoard.seats.find((x) => x.user_id === u);
  const b = stuckBoard.seats.find((x) => x.user_id === u);
  assert.equal(a.state, "stuck", `${u} at 02:25:45Z`);
  assert.equal(b.state, "stuck", `${u} at 02:20:00Z`);
  assert.equal(a.severity, "alert");
  assert.equal(b.calls_in_window, 3, "the labelled '3 turns in 15 min'");
  assert.ok(
    Math.round(b.mean_wait_ms / 1000) === 254,
    `the labelled '250 s mean wait' measures 254 s, got ${b.mean_wait_ms} ms`,
  );
  // The ClassAid sanity check, made concrete: their 240 s inactivity cut,
  // applied to mean wait, MISSES this seat at 02:25:45Z (233 s). Measuring the
  // real distribution is not optional.
  assert.ok(a.mean_wait_ms < 240_000, `-12 measures ${a.mean_wait_ms} ms at 02:25:45Z, under 240 s`);
  assert.ok(a.mean_wait_ms >= BOARD_THRESHOLDS.stuckMeanWaitMs, "…and the derived 180 s cut catches it");
}
console.log("✓ negative control: -12 renders stuck at both labelled instants; a 240 s cut would miss it");

// Rule 1 in full. -13 and -15 are on the roster and made ZERO calls all day —
// they appear nowhere in usage_log, so today's "recent rows" panel cannot draw
// them at all. They are exactly the seats the board exists for.
for (const u of FX.labels.never_connected) {
  const s = quietBoard.seats.find((x) => x.user_id === u);
  assert.equal(s.state, "absent", `${u} never connected and must still occupy a row`);
  assert.equal(s.idle_ms, null);
  assert.deepEqual(s.reasons.slice(0, 2), ["no_calls_ever", "no_heartbeat_ever"]);
}
assert.equal(
  quietBoard.seats.length,
  FX.roster.length,
  "rule 1: every roster row is rendered — 15 seats, 13 of which ever called",
);
console.log("✓ rule 1: all 15 roster seats render; -13 and -15 (zero calls all day) show as absent");

// -14 left at 01:36 and never came back. Not in the spec's summary table, but
// the rows are unambiguous: 49 minutes of nothing is not "fine".
{
  const s = quietBoard.seats.find((x) => x.user_id === "SK34-CM6YPX-14");
  assert.equal(s.state, "quiet");
  assert.ok(s.idle_ms > 45 * 60_000, `-14 idle ${s.idle_ms} ms`);
}

// Rule 2 / rule 3: worst first, longest idle first inside a tier.
{
  const order = quietBoard.seats.map((s) => s.severity);
  const rank = { alert: 0, watch: 1, ok: 2 };
  for (let i = 1; i < order.length; i++) {
    assert.ok(rank[order[i - 1]] <= rank[order[i]], "seats sort worst-first");
  }
}
console.log("✓ ordering: worst-first, so the top of the phone screen is the seat to walk to");

// ---------------------------------------------------------------------------
// 4. UNKNOWN vs FALSE NEGATIVE.
//    The failure columns must read "unknown" on pre-B data, never 0, and no
//    seat may be cleared on failure grounds. Same for heartbeats on pre-E data.
// ---------------------------------------------------------------------------
assert.equal(quietBoard.errorSignal, "unknown", "pre-B rows cannot carry an observed status");
for (const s of quietBoard.seats) {
  assert.equal(s.failures_in_window, null, `${s.user_id}: failures must be null, never 0`);
  assert.equal(s.failures_in_session, null);
  assert.equal(s.heartbeat, "unknown", `${s.user_id}: no ping exists, so 'alive' is unanswerable`);
  assert.equal(s.artifact_age_ms, null);
  assert.ok(s.reasons.includes("error_signal_unknown"));
}
{
  const degraded = boardDegradations(quietBoard.errorSignal, quietBoard.seats);
  const cols = degraded.map((d) => d.column).sort();
  assert.deepEqual(cols, ["failures", "heartbeat"], "both lost capabilities are ANNOUNCED, not hidden");
}
console.log("✓ unknown-not-false-negative: failures/heartbeat are null + announced, never 0/'fine'");

// resolveErrorSignal can only ever REVEAL the signal — silence never clears it.
assert.equal(resolveErrorSignal({ sawNon2xx: false, signalFromMs: null, windowStartMs: 0 }), "unknown");
assert.equal(resolveErrorSignal({ sawNon2xx: true, signalFromMs: null, windowStartMs: 0 }), "observed");
assert.equal(
  resolveErrorSignal({ sawNon2xx: false, signalFromMs: 500, windowStartMs: 400 }),
  "unknown",
  "a window that starts BEFORE B went live is still unknown",
);
assert.equal(
  resolveErrorSignal({ sawNon2xx: false, signalFromMs: 500, windowStartMs: 500 }),
  "observed",
  "a window entirely after B went live is observed even with zero errors",
);

// Once the signal IS observable, a failure row must flip the seat to `failing`
// — the column is not merely decorative. Replays the same fixture with the two
// labelled-fine seats' most recent calls rewritten as upstream 5xx.
{
  const bDb = new DatabaseSync(":memory:");
  bDb.exec("CREATE TABLE usage_log (user_id TEXT, cohort_id TEXT, latency_ms INTEGER, status INTEGER NOT NULL, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, created_at TEXT NOT NULL)");
  const ins = bDb.prepare("INSERT INTO usage_log (user_id, cohort_id, latency_ms, status, created_at) VALUES (?,?,?,?,?)");
  for (const [seatIdx, offsetSec, status, latency] of FX.rows) {
    const u = FX.seats[seatIdx];
    const at = BASE_MS + offsetSec * 1000;
    const broken = u === "SK34-CM6YPX-08" && at > T_QUIET - 5 * 60_000 && at <= T_QUIET;
    ins.run(u, FX.cohort_id, latency, broken ? 502 : status, d1Timestamp(at));
  }
  const win = bDb
    .prepare(BOARD_WINDOW_SQL.replace(/\?1/g, "?").replace(/\?2/g, "?").replace(/\?3/g, "?"))
    .all(FX.cohort_id, d1Timestamp(T_QUIET - ANALYSIS_WINDOW_MS), d1Timestamp(T_QUIET));
  const sess = bDb
    .prepare(BOARD_SESSION_SQL.replace(/\?1/g, "?").replace(/\?2/g, "?").replace(/\?3/g, "?"))
    .all(FX.cohort_id, sessionStart, d1Timestamp(T_QUIET));
  const signal = resolveErrorSignal({
    sawNon2xx: sess.some((r) => Number(r.failures ?? 0) > 0),
    signalFromMs: null,
    windowStartMs: BASE_MS,
  });
  assert.equal(signal, "observed", "one non-2xx row is proof by existence that B is live");
  const byWin = new Map(win.map((r) => [r.user_id, r]));
  const bySess = new Map(sess.map((r) => [r.user_id, r]));
  const v = (u) =>
    deriveSeat(
      { user_id: u, session: toSessionAgg(u, bySess.get(u)), window: toWindowAgg(u, byWin.get(u)), liveness: NO_LIVENESS },
      T_QUIET,
      signal,
    );
  assert.equal(v("SK34-CM6YPX-08").state, "failing", "an erroring seat outranks a merely healthy one");
  assert.ok(v("SK34-CM6YPX-08").failures_in_window > 0);
  assert.equal(v("SK34-CM6YPX-09").state, "ok", "…and does not spill onto its neighbours");
  assert.equal(v("SK34-CM6YPX-09").failures_in_window, 0, "post-B, a real zero IS a zero");
}
console.log("✓ post-B replay: a seeded 502 flips exactly one seat to failing; zeros become real");

// Heartbeat is a presence question. Needs no history, so it is testable now.
{
  const u = "SK34-CM6YPX-01";
  const base = { user_id: u, session: toSessionAgg(u, undefined), window: toWindowAgg(u, undefined) };
  const alive = deriveSeat(
    { ...base, liveness: { ...NO_LIVENESS, heartbeat_at_ms: T_QUIET - 20_000, client_version: "0.1.51" } },
    T_QUIET, "observed",
  );
  assert.equal(alive.heartbeat, "alive");
  assert.equal(alive.state, "quiet", "pinging but never asked anything is quiet, not absent");
  assert.ok(alive.reasons.includes("heartbeat_only"));
  const stale = deriveSeat(
    { ...base, liveness: { ...NO_LIVENESS, heartbeat_at_ms: T_QUIET - 400_000 } },
    T_QUIET, "observed",
  );
  assert.equal(stale.heartbeat, "stale");
  const none = deriveSeat({ ...base, liveness: NO_LIVENESS }, T_QUIET, "observed");
  assert.equal(none.heartbeat, "unknown");
  assert.equal(none.state, "absent");
}
console.log("✓ heartbeat: alive / stale / unknown are three distinct answers, not two plus a guess");

// ---------------------------------------------------------------------------
// 5. Does the instrument have teeth? Perturb each threshold and require a
//    control to BREAK. A control that survives every setting measures nothing.
// ---------------------------------------------------------------------------
function controlsPass(th) {
  const b = boardAt(T_QUIET, th);
  const s = boardAt(T_STUCK, th);
  const st = (bd, u) => bd.seats.find((x) => x.user_id === u).state;
  return (
    FX.labels.fine.every((u) => st(b, u) === "ok") &&
    FX.labels.quiet.every((u) => st(b, u) === "quiet") &&
    st(b, "SK34-CM6YPX-12") === "stuck" &&
    st(s, "SK34-CM6YPX-12") === "stuck"
  );
}
assert.ok(controlsPass(BOARD_THRESHOLDS), "sanity: the shipped thresholds pass");
const perturbations = [
  ["quietIdleMs", 240_000, "ClassAid's 240 s as an idle cut — flags healthy seats (over-strict)"],
  ["quietIdleMs", 900_000, "15 min quiet cut — misses -01/-06 (permissive)"],
  ["slowingIdleMs", 60_000, "task E's original guessed 60 s cut — amber on healthy seats"],
  ["stuckMeanWaitMs", 240_000, "ClassAid's 240 s as a wait cut — misses -12 at 02:25:45Z"],
  // p75 of the healthy mean-wait distribution (30.7 s). Note the headroom this
  // exposes: at 02:25:45Z the worst fine seat measures 44.8 s, so the stuck cut
  // could fall from 180 s to ~45 s before the positive control breaks. The
  // 180 s the board ships is the healthy p99.9, not the edge of the controls.
  ["stuckMeanWaitMs", 30_000, "p75 of the healthy distribution — flags fine seats as stuck"],
  ["stuckMinCalls", 12, "requiring 12 calls before judging wait — -12 has 3, so it hides"],
];
for (const [key, value, why] of perturbations) {
  assert.equal(
    controlsPass({ ...BOARD_THRESHOLDS, [key]: value }),
    false,
    `instrument has no teeth: ${key}=${value} still passes both controls (${why})`,
  );
}
console.log(`✓ instrument: all ${perturbations.length} threshold perturbations break a control`);

// ---------------------------------------------------------------------------
// 6. Unit edges on the pure helpers.
// ---------------------------------------------------------------------------
assert.equal(meanWaitMs(null, 10, 5, 3), null);
assert.equal(meanWaitMs(0, 100, 1, 3), null, "one call is not a rate");
assert.equal(meanWaitMs(0, 100, 2, 3), null, "below stuckMinCalls there is no verdict");
assert.equal(meanWaitMs(0, 400, 3, 3), 200, "mean of gaps telescopes to (last-first)/(n-1)");
assert.equal(d1ToMs("2026-08-22 02:25:45"), Date.parse("2026-08-22T02:25:45Z"));
assert.equal(d1Timestamp(Date.parse("2026-08-22T02:25:45Z")), "2026-08-22 02:25:45");
assert.equal(d1ToMs(null), null);
assert.equal(d1ToMs("nonsense"), null);

// The seat set — the spec did not settle this, so the behaviour is pinned here.
{
  const cumulative = [...FX.roster, "SK34-E87K3K-01", "보아치과-01", "load-01"];
  const withPrefix = resolveSeatSet({ roster: cumulative, seatPrefix: "SK34-CM6YPX-", observed: ["SK34-CM6YPX-02"] });
  assert.deepEqual(withPrefix.seats, FX.roster, "prefix mode renders the batch, not the 340-row cohort roster");
  assert.equal(withPrefix.complete, true);
  const observed = resolveSeatSet({ roster: cumulative, seatPrefix: null, observed: ["SK34-CM6YPX-02", "SK34-CM6YPX-02", "SK34-CM6YPX-01"] });
  assert.deepEqual(observed.seats, ["SK34-CM6YPX-01", "SK34-CM6YPX-02"]);
  assert.equal(observed.complete, false, "observed mode can never contain a seat that never connected");
}

// Privacy, at the type level: a verdict may not carry anything a participant
// wrote. Every string field is a seat id, a fixed state token, or a version.
{
  const s = quietBoard.seats[0];
  const ALLOWED = new Set([
    "user_id", "state", "severity", "idle_ms", "mean_wait_ms", "calls_in_window",
    "calls_in_session", "mean_latency_ms", "failures_in_window", "failures_in_session",
    "heartbeat", "heartbeat_age_ms", "client_version", "artifact_age_ms",
    "artifact_bytes", "reasons",
  ]);
  for (const k of Object.keys(s)) {
    assert.ok(ALLOWED.has(k), `seat verdict grew a field "${k}" — is it prompt text? (spec §4 rule 4)`);
  }
}

console.log("All board-threshold (2026-08-22 calibration replay) tests passed.");
