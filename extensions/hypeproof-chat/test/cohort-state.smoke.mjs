// Smoke tests for cohort-keyed chat panel state (#63).
// Pure helpers — no vscode host.
// Run: node --experimental-strip-types test/cohort-state.smoke.mjs

import assert from "node:assert/strict";

const {
  LEGACY_HISTORY_KEY,
  LEGACY_COACH_KEY,
  LEGACY_COACH_RITUAL_DONE_KEY,
  stateBucketId,
  historyKeyForCohort,
  coachKeyForCohort,
  coachRitualDoneKeyForCohort,
  extractCohortIdUnverified,
} = await import("../src/chatPanelHelpers.ts");

function makeToken(payload) {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${b64}.sig`;
}

// ─── Bucket keys isolate cohort A/B ──────────────────────────────────
{
  const a = "boah-dental-2026-a";
  const b = "sk-biopharm-2026-a";
  assert.equal(historyKeyForCohort(a), `${LEGACY_HISTORY_KEY}:boah-dental-2026-a`);
  assert.equal(coachKeyForCohort(a), `${LEGACY_COACH_KEY}:boah-dental-2026-a`);
  assert.equal(coachRitualDoneKeyForCohort(a), `${LEGACY_COACH_RITUAL_DONE_KEY}:boah-dental-2026-a`);
  assert.notEqual(historyKeyForCohort(a), historyKeyForCohort(b));
  assert.notEqual(coachKeyForCohort(a), coachKeyForCohort(b));
}

// ─── Missing cohort preserves legacy keys for pre-token/no-profile paths ─
{
  assert.equal(historyKeyForCohort(null), LEGACY_HISTORY_KEY);
  assert.equal(coachKeyForCohort(undefined), LEGACY_COACH_KEY);
  assert.equal(coachRitualDoneKeyForCohort(""), LEGACY_COACH_RITUAL_DONE_KEY);
}

// ─── Unsafe characters are constrained but support-readable ───────────
{
  assert.equal(stateBucketId(" cohort/한글:value "), "cohort____value");
}

// ─── HypeProof token payload `c` drives the bucket ────────────────────
{
  assert.equal(
    extractCohortIdUnverified(makeToken({ c: "boah-dental-2026-a", p: "s1" })),
    "boah-dental-2026-a",
  );
  assert.equal(extractCohortIdUnverified(makeToken({ p: "s1" })), undefined);
  assert.equal(extractCohortIdUnverified("not-a-token"), undefined);
  assert.equal(extractCohortIdUnverified("a.b.c"), undefined);
}

console.log("✅ cohort-state: 4 case groups passed");
