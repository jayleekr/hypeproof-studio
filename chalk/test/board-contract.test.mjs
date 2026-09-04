// Drift lock for Chalk's ONE declared contract (products.yaml `chalk`,
// admission gate 2/3): read-only cohort JSON under GET /admin/cohorts/:id/*.
//
//   /state  — lands with plan task F (this file pins it)
//   /board  — lands with plan task G; G EXTENDS this file with the board
//             shape and its calibrated verdicts (board-threshold.test.mjs
//             holds the pure verdict function; the HTTP shape belongs here).
//
// Two rules apply to every read Chalk serves, today and after G
// (docs/plan/vessel-and-modules.md §4):
//   • operational metadata only — roster SIZE, never member handles; track
//     DISPLAY NAMES, never prompt text. The privacy line (PIPA Art. 22-2 for
//     minor cohorts) is what keeps the surface shippable.
//   • the response shape is a closed set of keys. A new column is a contract
//     change and must be added HERE first.
//
// Run: node --experimental-strip-types chalk/test/board-contract.test.mjs

import assert from "node:assert/strict";
import "../../worker/test/harness/loader.mjs";

const SECRET = "test-secret-" + "x".repeat(20);
const { default: chalk } = await import("../src/index.ts");
const { issueIssuer } = await import("../../worker/src/lib/tokens.ts");
const { listProfiles } = await import("../../worker/src/profiles/index.ts");
const { setRoster, startSession, pauseCohort } = await import("../../worker/src/lib/kv.ts");

const COHORT = "boah-dental-2026-a";
const COPYCLONE = "boah-dental-director-copyclone-2026-s1";
const TEASER = "boah-dental-teaser-2026-s1";   // dashboard_hidden this round (#384)

const store = new Map();
const kv = {
  async get(k, t) { const v = store.get(k); return v === undefined ? null : t === "json" ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list({ prefix } = {}) { return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};
const env = { HPS_SIGNING_SECRET: SECRET, ENVIRONMENT: "production", HPS_KV: kv, HPS_DB: {} };

// Seed what a live class looks like: named members on the roster, a session
// open on one track, and a pause — every field the shape has a value for.
const HANDLES = ["kim-cheolsu", "lee-younghee", "park-minsu"];
await setRoster(kv, COHORT, HANDLES);
const now = Date.now();
await startSession(kv, COHORT, {
  session_id: "sess-contract", profile_id: COPYCLONE,
  starts_at: new Date(now).toISOString(), ends_at: new Date(now + 3600_000).toISOString(),
});
await pauseCohort(kv, COHORT, "contract fixture");

// Instructor scoped to BOTH tracks, so the hidden one is excluded by the
// dashboard rule and not merely by scope.
const { token } = await issueIssuer(
  { issuer: "contract", scopes: [{ cohort: COHORT, profiles: [COPYCLONE, TEASER], max_hours: 6 }] },
  24,
  SECRET,
);

const res = await chalk.fetch(
  new Request(`https://chalk.test/admin/cohorts/${COHORT}/state`, { headers: { authorization: `Bearer ${token}` } }),
  env,
  { waitUntil() {}, passThroughOnException() {} },
);
assert.equal(res.status, 200);
const text = await res.text();
const body = JSON.parse(text);

// --- closed key set ----------------------------------------------------------------
assert.deepEqual(
  Object.keys(body).sort(),
  ["id", "now", "paused", "profiles", "roster_size", "scope", "session"],
  "GET /admin/cohorts/:id/state — top-level keys are a closed set",
);
assert.equal(body.id, COHORT);
assert.ok(Number.isFinite(Date.parse(body.now)), "`now` is server time, ISO8601 — the board derives idle time from THIS, never client clocks");
assert.deepEqual(Object.keys(body.session).sort(), ["ends_at", "profile_id", "session_id", "starts_at"]);
assert.deepEqual(Object.keys(body.paused).sort(), ["reason", "ts"]);
assert.deepEqual(Object.keys(body.scope).sort(), ["can_start_session", "max_hours", "max_session_hours"]);
assert.deepEqual(body.scope, { can_start_session: false, max_session_hours: 4, max_hours: 6 }, "caps default exactly as the Service enforces them");
for (const p of body.profiles) {
  assert.deepEqual(Object.keys(p).sort(), ["display_name", "id"], "profile rows carry id + display_name only");
}
assert.deepEqual(body.profiles.map((p) => p.id), [COPYCLONE], "dashboard_hidden track excluded even though the issuer is scoped to it");
console.log("✓ board-contract: /state key set is closed and matches the documented shape");

// --- privacy: metadata only ----------------------------------------------------------
assert.equal(body.roster_size, HANDLES.length, "roster reported as a SIZE");
for (const h of HANDLES) {
  assert.ok(!text.includes(h), `member handle "${h}" must never appear in a Chalk read`);
}
for (const p of listProfiles().filter((p) => p.session.cohort_id === COHORT)) {
  // A distinctive slice of the system prompt; the whole thing is long.
  const probe = p.system_prompt.trim().slice(40, 120);
  assert.ok(probe.length > 20, "sanity: prompt probe is non-trivial");
  assert.ok(!text.includes(probe), `prompt text of ${p.id} must never appear in a Chalk read`);
}
console.log("✓ board-contract: no member handles, no prompt text — operational metadata only");

// ===========================================================================
// GET /admin/cohorts/:id/board — the live board (plan task G, issue #674).
//
// Same contract, same file: read-only cohort JSON under /admin/cohorts/:id/*,
// operational metadata only, closed key set. The CALIBRATION of the numbers is
// a separate concern and lives in board-threshold.test.mjs (it replays the real
// 2026-08-22 session); what is pinned HERE is the SHAPE — because the shape is
// what an old console page and a new Chalk deploy drift apart on.
// ===========================================================================

const { DatabaseSync } = await import("node:sqlite");
const { d1Timestamp } = await import("../src/routes/board.ts");

// A D1-shaped adapter over a real SQLite, so the route's SQL actually executes
// rather than being answered by a stub that agrees with whatever it is sent.
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, cohort_id TEXT, user_id TEXT,
  profile_id TEXT, model TEXT, tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER, status INTEGER NOT NULL,
  created_at TEXT NOT NULL, trial_id TEXT)`);
const d1 = {
  prepare(sql) {
    const stmt = sqlite.prepare(sql.replace(/\?\d/g, "?"));
    let args = [];
    return {
      bind(...a) { args = a; return this; },
      async all() { return { results: stmt.all(...args), success: true }; },
    };
  },
};
{
  const ins = sqlite.prepare(
    `INSERT INTO usage_log (cohort_id, user_id, model, tokens_in, tokens_out, latency_ms, status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  // Two seats calling steadily; the third roster member never calls at all.
  for (let i = 0; i < 6; i++) {
    for (const u of ["kim-cheolsu", "lee-younghee"]) {
      ins.run(COHORT, u, "claude-sonnet-4-6", 5, 200, 4000, 200, d1Timestamp(now - i * 20_000));
    }
  }
}
const boardEnv = { ...env, HPS_DB: d1 };

const bres = await chalk.fetch(
  new Request(`https://chalk.test/admin/cohorts/${COHORT}/board`, {
    headers: { authorization: `Bearer ${token}` },
  }),
  boardEnv,
  { waitUntil() {}, passThroughOnException() {} },
);
assert.equal(bres.status, 200);
const btext = await bres.text();
const bbody = JSON.parse(btext);

// --- closed key set ---------------------------------------------------------
assert.deepEqual(
  Object.keys(bbody).sort(),
  ["degraded", "error_signal", "id", "now", "paused", "roster", "seats", "session", "thresholds", "window"],
  "GET /admin/cohorts/:id/board — top-level keys are a closed set; a new column is a contract change and lands HERE first",
);
assert.ok(Number.isFinite(Date.parse(bbody.now)), "`now` is the SERVER clock — every age derives from it, never a client's");
assert.deepEqual(Object.keys(bbody.roster).sort(), ["cohort_roster_size", "complete", "rendered", "source"]);
assert.deepEqual(Object.keys(bbody.window).sort(), ["analysis_window_ms", "session_start"]);
assert.deepEqual(
  Object.keys(bbody.thresholds).sort(),
  ["heartbeatStaleMs", "quietIdleMs", "slowingIdleMs", "stuckMeanWaitMs", "stuckMinCalls"],
  "the thresholds are SERVED, not compiled into a client — that is what keeps them recalibratable in 30 s (spec §1)",
);
assert.ok(["observed", "unknown"].includes(bbody.error_signal));
for (const s of bbody.seats) {
  assert.deepEqual(
    Object.keys(s).sort(),
    [
      "artifact_age_ms", "artifact_bytes", "calls_in_session", "calls_in_window",
      "client_version", "failures_in_session", "failures_in_window", "heartbeat",
      "heartbeat_age_ms", "idle_ms", "mean_latency_ms", "mean_wait_ms", "reasons",
      "severity", "state", "user_id",
    ],
    "seat rows are a closed set — no free-text field can be smuggled in",
  );
  assert.ok(["alert", "watch", "ok"].includes(s.severity));
  assert.ok(["absent", "failing", "quiet", "stuck", "slowing", "ok"].includes(s.state));
}
console.log("✓ board-contract: /board key set is closed (top level, thresholds, and every seat row)");

// --- rule 1: every roster row, including the seat that never connected -------
assert.equal(bbody.roster.source, "observed", "no seat_prefix falls back to observed, never to a guessed prefix");
{
  const withPrefix = await chalk.fetch(
    new Request(`https://chalk.test/admin/cohorts/${COHORT}/board?seat_prefix=park-`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    boardEnv,
    { waitUntil() {}, passThroughOnException() {} },
  );
  const pb = await withPrefix.json();
  assert.equal(pb.roster.source, "prefix");
  assert.equal(pb.roster.complete, true);
  assert.deepEqual(pb.seats.map((s) => s.user_id), ["park-minsu"], "a roster seat with ZERO calls still occupies a row");
  assert.equal(pb.seats[0].state, "absent");
  assert.equal(pb.seats[0].idle_ms, null);
}
// …and observed-mode incompleteness is ANNOUNCED, never silent (§5).
assert.ok(
  bbody.degraded.some((d) => d.column === "roster"),
  "observed mode cannot contain a seat that never connected — it must say so",
);
assert.equal(bbody.error_signal, "unknown", "all-200 rows cannot prove task B is live");
assert.ok(bbody.degraded.some((d) => d.column === "failures"));
assert.ok(bbody.degraded.some((d) => d.column === "heartbeat"));
for (const s of bbody.seats) {
  assert.equal(s.failures_in_window, null, "unknown renders as null, NEVER as 0");
  assert.equal(s.heartbeat, "unknown");
}
console.log("✓ board-contract: rule 1 holds under seat_prefix; every degradation is announced, never a false negative");

// --- auth: the shared door, no second implementation ------------------------
for (const [hdrs, want] of [
  [{}, 401],
  [{ authorization: "Basic " + btoa("admin:whatever") }, 401],
]) {
  const r = await chalk.fetch(
    new Request(`https://chalk.test/admin/cohorts/${COHORT}/board`, { headers: hdrs }),
    boardEnv,
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(r.status, want, "the board opens with an instructor issuer token and nothing else");
}
{
  const { token: other } = await issueIssuer(
    { issuer: "elsewhere", scopes: [{ cohort: "some-other-cohort", profiles: [], max_hours: 6 }] },
    24,
    SECRET,
  );
  const r = await chalk.fetch(
    new Request(`https://chalk.test/admin/cohorts/${COHORT}/board`, { headers: { authorization: `Bearer ${other}` } }),
    boardEnv,
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(r.status, 403, "an issuer not scoped to this cohort cannot read its board");
}
console.log("✓ board-contract: /board uses the shared instructor-auth door (401 without, 403 out of scope)");

// --- privacy: metadata only, same rule as /state -----------------------------
for (const p of listProfiles().filter((p) => p.session.cohort_id === COHORT)) {
  const probe = p.system_prompt.trim().slice(40, 120);
  assert.ok(!btext.includes(probe), `prompt text of ${p.id} must never appear on the board`);
}
assert.ok(
  !/prompt|message|content|question|preview|body|text/i.test(Object.keys(bbody.seats[0] ?? {}).join(" ")),
  "no seat field may be named after participant-authored content (spec §4 rule 4)",
);
console.log("✓ board-contract: zero prompt text — this is what keeps the board shippable for minor cohorts");

console.log("All board-contract tests passed (state + board).");
