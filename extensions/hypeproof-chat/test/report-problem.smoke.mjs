// Smoke for reportProblemHelpers.ts pure helpers (#64 extension side).
// Run: node --experimental-strip-types test/report-problem.smoke.mjs
//
// We import the pure helper module directly — it has no vscode dependency,
// so plain Node works. The interactive QuickInput cascade in reportProblem.ts
// is not exercised here; that path needs a real vscode host (hand-test).

import assert from "node:assert/strict";

const { hashJti, extractJtiUnverified, sanitizeRecentTurns } = await import(
  "../src/reportProblemHelpers.ts"
);

const results = [];
async function check(label, fn) {
  try { await fn(); results.push({ label, ok: true }); console.log(`✅ ${label}`); }
  catch (err) { results.push({ label, ok: false, err: String(err) }); console.log(`❌ ${label}\n   ${err}`); }
}

// --- hashJti -------------------------------------------------------------

await check("hashJti returns 16 hex chars", async () => {
  const h = await hashJti("c7133f44-b8e2-4e76-a004-a3087f72b493");
  assert.equal(h.length, 16);
  assert.match(h, /^[0-9a-f]{16}$/);
});

await check("hashJti is deterministic (same input → same hash)", async () => {
  const a = await hashJti("alpha");
  const b = await hashJti("alpha");
  assert.equal(a, b);
});

await check("hashJti differs across inputs", async () => {
  const a = await hashJti("alpha");
  const b = await hashJti("beta");
  assert.notEqual(a, b);
});

// --- extractJtiUnverified -----------------------------------------------

function makeFakeToken(payload) {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64")
    .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return b64 + ".sig-not-checked";
}

await check("extractJtiUnverified pulls jti from valid v2 token", () => {
  const tok = makeFakeToken({
    u: "alice", c: "boah-dental-2026-a", p: "boah-dental-teaser-2026-s1",
    iat: 1, exp: 100, v: 2, jti: "11111111-2222-4333-8444-555555555555",
  });
  assert.equal(extractJtiUnverified(tok), "11111111-2222-4333-8444-555555555555");
});

await check("extractJtiUnverified returns undefined for missing jti", () => {
  const tok = makeFakeToken({ u: "x", c: "y", p: "z", iat: 1, exp: 2, v: 2 });
  assert.equal(extractJtiUnverified(tok), undefined);
});

await check("extractJtiUnverified returns undefined for malformed token", () => {
  assert.equal(extractJtiUnverified("not-a-token"), undefined);
  assert.equal(extractJtiUnverified(""), undefined);
});

await check("extractJtiUnverified handles non-base64url chars gracefully", () => {
  assert.equal(extractJtiUnverified("!!!.xyz"), undefined);
});

// --- sanitizeRecentTurns -------------------------------------------------

await check("sanitizeRecentTurns takes last 3 messages", () => {
  const turns = [
    { id: "a", role: "user", content: "1", createdAt: 1 },
    { id: "b", role: "assistant", content: "2", createdAt: 2 },
    { id: "c", role: "user", content: "3", createdAt: 3 },
    { id: "d", role: "assistant", content: "4", createdAt: 4 },
    { id: "e", role: "user", content: "5", createdAt: 5 },
  ];
  const out = sanitizeRecentTurns(turns);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((t) => t.content), ["3", "4", "5"]);
});

await check("sanitizeRecentTurns truncates content > 2000 chars", () => {
  const big = "x".repeat(3000);
  const turns = [{ id: "a", role: "user", content: big, createdAt: 1 }];
  const out = sanitizeRecentTurns(turns);
  assert.equal(out.length, 1);
  assert.equal(out[0].content.length, 2000);
});

await check("sanitizeRecentTurns drops system messages", () => {
  const turns = [
    { id: "a", role: "system", content: "secret", createdAt: 1 },
    { id: "b", role: "user", content: "ok", createdAt: 2 },
  ];
  const out = sanitizeRecentTurns(turns);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
});

await check("sanitizeRecentTurns on empty array → empty", () => {
  assert.deepEqual(sanitizeRecentTurns([]), []);
});

await check("sanitizeRecentTurns handles missing content", () => {
  const turns = [{ id: "a", role: "user", content: undefined, createdAt: 1 }];
  const out = sanitizeRecentTurns(turns);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "");
});

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
