// Smoke tests for resolveCoach (#140 — fixed-naming cohorts must ignore
// user-supplied coach name carried over from a different cohort).
// Pure helper — no vscode host.
// Run: node --experimental-strip-types test/resolve-coach.smoke.mjs

import assert from "node:assert/strict";

const { resolveCoach } = await import("../src/chatPanelHelpers.ts");

// ─── #140 — fixed naming cohorts override user-supplied state ─────────
{
  const profile = { ux: { coach: { naming_mode: "fixed", fallback_name: "코치" } } };
  const result = resolveCoach(
    { name: "마법사", personality: "엉뚱하고 칭찬 잘함" },
    profile,
  );
  assert.equal(result.name, "코치", "fixed cohort must override user-set name");
  assert.equal(result.personality, "", "fixed cohort must drop carried-over personality");
}

{
  // Even with no user state, fixed cohort uses fallback.
  const profile = { ux: { coach: { naming_mode: "fixed", fallback_name: "코치" } } };
  const result = resolveCoach(null, profile);
  assert.equal(result.name, "코치");
  assert.equal(result.personality, "");
}

// ─── user_names_it cohort — user input wins ───────────────────────────
{
  const profile = { ux: { coach: { naming_mode: "user_names_it", fallback_name: "코치" } } };
  const result = resolveCoach(
    { name: "마법사", personality: "엉뚱하고 칭찬 잘함" },
    profile,
  );
  assert.equal(result.name, "마법사", "user-set name wins for user_names_it mode");
  assert.equal(result.personality, "엉뚱하고 칭찬 잘함");
}

{
  // user_names_it but user hasn't set a name → fallback.
  const profile = { ux: { coach: { naming_mode: "user_names_it", fallback_name: "별이" } } };
  const result = resolveCoach({ name: "", personality: "" }, profile);
  assert.equal(result.name, "별이");
  assert.equal(result.personality, "");
}

// ─── No profile → graceful default ────────────────────────────────────
{
  const result = resolveCoach(null, null);
  assert.equal(result.name, "코치");
  assert.equal(result.personality, "");
}

{
  const result = resolveCoach({ name: "햇님", personality: "친절함" }, null);
  // No profile means we can't enforce fixed-mode override — user state passes through.
  assert.equal(result.name, "햇님");
}

// ─── Whitespace trim + empty-string handling ──────────────────────────
{
  const profile = { ux: { coach: { naming_mode: "user_names_it", fallback_name: "코치" } } };
  const result = resolveCoach({ name: "   ", personality: "  " }, profile);
  assert.equal(result.name, "코치", "whitespace-only name → fallback");
  assert.equal(result.personality, "", "whitespace-only personality → empty");
}

// ─── Fixed cohort empty fallback → default ────────────────────────────
{
  const profile = { ux: { coach: { naming_mode: "fixed", fallback_name: "" } } };
  const result = resolveCoach({ name: "anything", personality: "x" }, profile);
  assert.equal(result.name, "코치", "empty fallback_name → default '코치'");
}

console.log("✅ resolveCoach: 8 cases passed");
