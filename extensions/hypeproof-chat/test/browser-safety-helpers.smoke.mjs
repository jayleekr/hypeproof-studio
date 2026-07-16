// Smoke tests for the #306 hardened-browser pure helper. vscode-free. Run:
//   node --experimental-strip-types test/browser-safety-helpers.smoke.mjs

import assert from "node:assert/strict";

const { resolveBrowserSafety } = await import("../src/browserSafetyHelpers.ts");

// ─── safe cohort (minor) ───
{
  const r = resolveBrowserSafety({
    browser_session: { mode: "safe", allowlist: ["example.com", "https://ok.org/x"] },
  });
  assert.equal(r.safeSession, true);
  assert.deepEqual(r.safeAllowlist, ["example.com", "https://ok.org/x"]);
  console.log("✓ mode=safe → safeSession true + allowlist passed through");
}

// ─── safe cohort with no allowlist → local-only (empty list) ───
{
  const r = resolveBrowserSafety({ browser_session: { mode: "safe" } });
  assert.equal(r.safeSession, true);
  assert.deepEqual(r.safeAllowlist, []);
  console.log("✓ mode=safe without allowlist → empty allowlist (local-only)");
}

// ─── browse / adult / absent → not safe (fail-safe default) ───
{
  for (const profile of [
    { browser_session: { mode: "browse", allowlist: ["x.com"] } },
    { browser_session: { mode: "weird" } },
    {},
    null,
    undefined,
  ]) {
    const r = resolveBrowserSafety(profile);
    assert.equal(r.safeSession, false, `expected not-safe for ${JSON.stringify(profile)}`);
    assert.deepEqual(r.safeAllowlist, [], "allowlist cleared when not safe");
  }
  console.log("✓ browse / unknown mode / missing / null → safeSession false, allowlist cleared");
}

// ─── malformed allowlist is sanitized (never widens access) ───
{
  const r = resolveBrowserSafety({
    browser_session: { mode: "safe", allowlist: ["good.com", 42, "", null, "also.ok"] },
  });
  assert.equal(r.safeSession, true);
  assert.deepEqual(r.safeAllowlist, ["good.com", "also.ok"], "non-string / empty entries dropped");
  // Non-array allowlist → empty.
  const r2 = resolveBrowserSafety({ browser_session: { mode: "safe", allowlist: "nope" } });
  assert.deepEqual(r2.safeAllowlist, []);
  console.log("✓ malformed allowlist entries dropped; non-array → empty");
}

console.log("All browser-safety-helpers smoke tests passed.");
