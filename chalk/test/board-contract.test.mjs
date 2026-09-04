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

console.log("All board-contract tests passed (state; /board joins with task G).");
