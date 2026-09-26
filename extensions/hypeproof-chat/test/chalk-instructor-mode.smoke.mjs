// InstructorModeManager — student token must NOT activate instructor mode.
//
// Why this TC exists (#1298):
//   checkInstructorMode trusts the /admin/chalk/whoami response code.
//   A 403 from a student token must result in isInstructor === false,
//   never true. Without this guard, a bug that always returns 200 would
//   silently open instructor chat for any token.

import assert from "node:assert/strict";
import { InstructorModeManager } from "../src/chalk/instructorMode.ts";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok   ${name}`); };

const PROXY = "https://api.hypeproof-ai.xyz/v1";

// --- helpers ---
function withFetch(status, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: status < 400 });
  try { return fn(); } finally { globalThis.fetch = orig; }
}

// --- tests ---
console.log("=== student token — instructor mode does not open ===");

t("student token (403) → isInstructor false", async () => {
  const mgr = new InstructorModeManager();
  const result = await withFetch(403, () => mgr.checkInstructorMode("student-token", PROXY));
  assert.strictEqual(result, false);
  assert.strictEqual(mgr.isInstructor, false);
});

t("no token → isInstructor false", async () => {
  const mgr = new InstructorModeManager();
  const result = await mgr.checkInstructorMode(undefined, PROXY);
  assert.strictEqual(result, false);
  assert.strictEqual(mgr.isInstructor, false);
});

t("401 response → isInstructor false", async () => {
  const mgr = new InstructorModeManager();
  const result = await withFetch(401, () => mgr.checkInstructorMode("bad-token", PROXY));
  assert.strictEqual(result, false);
});

console.log("\n=== valid issuer token — instructor mode opens ===");

t("200 response → isInstructor true", async () => {
  const mgr = new InstructorModeManager();
  const result = await withFetch(200, () => mgr.checkInstructorMode("issuer-token", PROXY));
  assert.strictEqual(result, true);
  assert.strictEqual(mgr.isInstructor, true);
});

t("caches result per token — no second fetch", async () => {
  const mgr = new InstructorModeManager();
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return { ok: true }; };
  try {
    await mgr.checkInstructorMode("issuer-token", PROXY);
    await mgr.checkInstructorMode("issuer-token", PROXY);
    assert.strictEqual(calls, 1, "second call must use cache");
  } finally { globalThis.fetch = orig; }
});

t("reset() clears state, re-fetches on next call", async () => {
  const mgr = new InstructorModeManager();
  await withFetch(200, () => mgr.checkInstructorMode("issuer-token", PROXY));
  mgr.reset();
  assert.strictEqual(mgr.isInstructor, null);
  assert.strictEqual(mgr.brief, undefined);
});

console.log(`\n${n} tests passed\n`);
