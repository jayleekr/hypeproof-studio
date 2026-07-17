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

// ─── issuer scope reading (#347) ─────────────────────────────────────
//
// Fixtures are minted by the WORKER'S OWN issueIssuer(), not hand-rolled here.
// That is the whole point of this block: #347 was a silent schema drift (this
// extension read `payload.scope.cohorts`; the worker signs `payload.scopes[]`
// with a singular `cohort` per entry) that the old hand-built fixture hid —
// the test asserted against a token shape the worker never produces, so it
// stayed green while the feature was dead in every real Studio. Minting with
// the real signer means any future payload change breaks this test instead.
const tokens = await import("../../../worker/src/lib/tokens.ts");
const SECRET = "smoke-test-signing-secret-not-real";

const mintIssuer = async (scopes) =>
  (await tokens.issueIssuer({ issuer: "instr-park", scopes }, 24, SECRET)).token;

{
  const single = await mintIssuer([
    { cohort: "boah-dental-2026-a", profiles: ["boah-dental-teaser-2026-s1"], max_hours: 12 },
  ]);
  const multi = await mintIssuer([
    { cohort: "boah-dental-2026-a", profiles: ["boah-dental-teaser-2026-s1"] },
    {
      cohort: "sk-biopharm-2026-a",
      profiles: [
        "sk-biopharm-kids-2026-grade-3-4-s1",
        "sk-biopharm-kids-2026-grade-5-6-s1",
      ],
    },
  ]);

  // ── issuerScopes: reads the real signed shape
  assert.equal(m.issuerScopes(single).length, 1);
  assert.equal(m.issuerScopes(single)[0].cohort, "boah-dental-2026-a");
  assert.deepEqual(m.issuerScopes("not-a-token"), []);
  assert.deepEqual(m.issuerScopes(""), []);

  // ── issuerCohorts: scope order, deduped
  assert.deepEqual(m.issuerCohorts(single), ["boah-dental-2026-a"]);
  assert.deepEqual(m.issuerCohorts(multi), ["boah-dental-2026-a", "sk-biopharm-2026-a"]);

  // ── issuerDefaultCohort: single → prefill, multi → caller must ask
  assert.equal(m.issuerDefaultCohort(single), "boah-dental-2026-a");
  assert.equal(m.issuerDefaultCohort(multi), undefined);

  // A STUDENT token has no scopes → no default (and never the old hardcoded
  // "boah-dental-2026-a", which is what #347 leaked into every prompt).
  const studentToken = (
    await tokens.issue({ u: "kid01", c: "sk-biopharm-2026-a", p: "sk-biopharm-kids-2026-grade-3-4-s1" }, 2, SECRET)
  ).token;
  assert.equal(m.issuerDefaultCohort(studentToken), undefined);
  assert.deepEqual(m.issuerScopes(studentToken), []);

  // Garbage → undefined (no throw).
  assert.equal(m.issuerDefaultCohort("not-a-token"), undefined);
  assert.equal(m.issuerDefaultCohort(""), undefined);
  assert.equal(m.issuerDefaultCohort("a.b.c.d"), undefined);
  // 2-segment format only (base64url(payload).base64url(sig)) — a 3-segment
  // JWT is not ours; parts[0] would be a header, so refuse rather than guess.
  assert.equal(m.issuerDefaultCohort("a.b.c"), undefined);

  // ── issuerProfilesFor: scoped to the chosen cohort
  assert.deepEqual(m.issuerProfilesFor(single, "boah-dental-2026-a"), [
    "boah-dental-teaser-2026-s1",
  ]);
  assert.deepEqual(m.issuerProfilesFor(multi, "sk-biopharm-2026-a"), [
    "sk-biopharm-kids-2026-grade-3-4-s1",
    "sk-biopharm-kids-2026-grade-5-6-s1",
  ]);
  // Cohort the issuer does not hold → no profiles (never another cohort's).
  assert.deepEqual(m.issuerProfilesFor(multi, "unknown-cohort"), []);
  assert.deepEqual(m.issuerProfilesFor("not-a-token", "boah-dental-2026-a"), []);

  console.log(
    "✅ issuer scopes (#347): real-signer fixtures · 1→default · multi→undef · student→undef · profiles scoped",
  );
}

// ─── #347 regression guard: the drifted shape must NOT be honoured ────
{
  // The exact payload the old helper looked for. If someone reintroduces a
  // `scope.cohorts` read, this fails — it must not be treated as a scope.
  const b64 = Buffer.from(JSON.stringify({ scope: { cohorts: ["boah-dental-2026-a"] } }))
    .toString("base64")
    .replace(/=+$/, "");
  const drifted = `${b64}.sig`;
  assert.equal(m.issuerDefaultCohort(drifted), undefined);
  assert.deepEqual(m.issuerScopes(drifted), []);
  console.log("✅ #347 guard: legacy scope.cohorts shape is not honoured");
}

console.log("\n5/5 smoke groups passed.");
