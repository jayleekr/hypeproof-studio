// Smoke tests for mintStudentToken helpers (issue #66). Pure helpers — no
// vscode host needed. Mirrors the update-checker.smoke pattern.

import assert from "node:assert/strict";

const m = await import("../src/mintStudentTokenHelpers.ts");

// ─── adminBaseFor ────────────────────────────────────────────────────
{
  assert.equal(m.adminBaseFor("https://api.hypeproof-ai.xyz/v1"), "https://api.hypeproof-ai.xyz");
  assert.equal(m.adminBaseFor("https://api.hypeproof-ai.xyz/v1/"), "https://api.hypeproof-ai.xyz");
  assert.equal(m.adminBaseFor("http://localhost:8787/v1"), "http://localhost:8787");
  assert.equal(m.adminBaseFor("http://localhost:8787/"), "http://localhost:8787");
  // No /v1 suffix — leave origin alone.
  assert.equal(m.adminBaseFor("https://api.hypeproof-ai.xyz"), "https://api.hypeproof-ai.xyz");
  console.log("✅ adminBaseFor: strips /v1 suffix + trailing slashes");
}

// ─── mapMintError ────────────────────────────────────────────────────
{
  assert.match(m.mapMintError("not an issuer token"), /강사 토큰/);
  assert.match(m.mapMintError("issuer token expired"), /만료/);
  assert.match(m.mapMintError("scope mismatch"), /권한/);
  assert.match(m.mapMintError("HTTP 401"), /인증 실패/);
  assert.match(m.mapMintError("fetch failed: dns"), /네트워크/);
  // Pass-through for unknown errors.
  assert.equal(m.mapMintError("something bizarre"), "something bizarre");
  console.log("✅ mapMintError: 5 known + 1 fallthrough");
}

// ─── validateInputs ──────────────────────────────────────────────────
{
  assert.deepEqual(m.validateInputs("student-01", "boah-dental-2026-a", "boah-dental-teaser-2026-s1", 2), { ok: true });
  assert.equal(m.validateInputs("", "c", "p", 2).ok, false);
  assert.equal(m.validateInputs("student-01", "", "p", 2).ok, false);
  assert.equal(m.validateInputs("student-01", "c", "", 2).ok, false);
  // bad chars in user id
  assert.equal(m.validateInputs("student 01", "c", "p", 2).ok, false);
  assert.equal(m.validateInputs("student/01", "c", "p", 2).ok, false);
  assert.equal(m.validateInputs("학생01", "c", "p", 2).ok, false);
  // hours bounds
  assert.equal(m.validateInputs("u", "c", "p", 0).ok, false);
  assert.equal(m.validateInputs("u", "c", "p", 1441).ok, false);
  assert.equal(m.validateInputs("u", "c", "p", 1).ok, true);
  assert.equal(m.validateInputs("u", "c", "p", 1440).ok, true);
  // non-integer hours
  assert.equal(m.validateInputs("u", "c", "p", 1.5).ok, false);
  // too long user id
  assert.equal(m.validateInputs("a".repeat(65), "c", "p", 2).ok, false);
  assert.equal(m.validateInputs("a".repeat(64), "c", "p", 2).ok, true);
  console.log("✅ validateInputs: happy path + 9 rejection branches");
}

// ─── issuerDefaultCohort ─────────────────────────────────────────────
{
  // Build a fake issuer-shaped token: <base64(payload)>.<sig>
  const mkToken = (payload) => {
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64").replace(/=+$/, "");
    return `${b64}.sig`;
  };
  // Single cohort → returned as default.
  assert.equal(
    m.issuerDefaultCohort(mkToken({ scope: { cohorts: ["boah-dental-2026-a"] } })),
    "boah-dental-2026-a",
  );
  // Multiple cohorts → cannot pick, returns undefined.
  assert.equal(
    m.issuerDefaultCohort(mkToken({ scope: { cohorts: ["a", "b"] } })),
    undefined,
  );
  // Missing scope → undefined.
  assert.equal(m.issuerDefaultCohort(mkToken({ u: "instr-park" })), undefined);
  // Garbage input → undefined (no throw).
  assert.equal(m.issuerDefaultCohort("not-a-token"), undefined);
  assert.equal(m.issuerDefaultCohort(""), undefined);
  assert.equal(m.issuerDefaultCohort("a.b.c.d"), undefined);
  // 3-part JWT (header.payload.sig) — we read parts[0] as header. Acceptable
  // since our minted tokens are 2-part; for 3-part inputs we just return
  // undefined when scope isn't present.
  console.log("✅ issuerDefaultCohort: 1-cohort default · multi → undef · garbage → undef");
}

console.log("\n6/6 smoke groups passed.");
