// Drift lock — instructor token verification is ONE implementation on both
// Cloudflare Workers (dag.yaml task F negative control).
//
// The Service (worker/) and Chalk (chalk/) deploy on different trains. If
// either ever grew its own copy of issuer-token verification, the two would
// drift and there would be two trust boundaries around minors' data. This
// test boots BOTH real apps in one process, shares ONE KV store between them,
// and pushes the same token fixtures through:
//
//   Service : POST /admin/cohorts/:id/roster/append  (authorizeIssuerForCohort)
//   Chalk   : GET  /admin/cohorts/:id/state          (authorizeIssuerForCohort)
//
// For every fixture the HTTP status must match, and for every rejection the
// error prose must match byte-for-byte. It also asserts identity: Chalk's
// `verify` / `authorizeIssuerForCohort` / `isIssuerAllowedEndpoint` ARE the
// Service's function objects (re-export), not look-alikes.
//
// Deliberate, asserted asymmetry: admin Basic is an auth path on the Service
// and NOT on Chalk (Chalk holds no admin password). That is the boundary the
// split draws, so it is pinned here rather than hidden.
//
// Run: node --experimental-strip-types chalk/test/instructor-auth-drift.test.mjs

import assert from "node:assert/strict";
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from "../../worker/test/harness/index.mjs";

const service = await bootApp();                                   // worker/src/index.ts
const { default: chalk } = await import("../src/index.ts");        // chalk/src/index.ts
const tokens = await import("../../worker/src/lib/tokens.ts");
const auth = await import("../../worker/src/lib/instructor-auth.ts");
const shared = await import("../src/shared.ts");

// --- identity: re-export, not copy ------------------------------------------
assert.strictEqual(shared.verify, tokens.verify, "chalk.verify must BE worker verify (same function object)");
assert.strictEqual(shared.authorizeIssuerForCohort, auth.authorizeIssuerForCohort, "authorizeIssuerForCohort re-exported, not copied");
assert.strictEqual(shared.isIssuerAllowedEndpoint, auth.isIssuerAllowedEndpoint, "isIssuerAllowedEndpoint re-exported, not copied");
assert.strictEqual(shared.TokenError, tokens.TokenError, "TokenError class identity (instanceof must work across both)");
console.log("✓ drift-lock: Chalk re-exports the Service's verifier — same function objects");

// --- one KV, two workers ------------------------------------------------------
const COHORT = "boah-dental-2026-a";
const PROFILE = "boah-dental-director-copyclone-2026-s1";
const OTHER_COHORT = "sk-biopharm-2026-a";
const ADMIN_PW = "drift-admin-pw";

const serviceEnv = createMockEnv({ withSession: false, withRoster: false, adminPassword: ADMIN_PW });
const chalkEnv = {
  HPS_SIGNING_SECRET: TEST_SECRET,
  ENVIRONMENT: "production",
  HPS_SERVICE_ORIGIN: "https://service.test",
  HPS_KV: serviceEnv.HPS_KV,      // the SAME store: a revocation written once is seen by both
  HPS_DB: serviceEnv.HPS_DB,
};

async function viaService(headers) {
  const r = await service.fetch(
    new Request(`https://api.test/admin/cohorts/${COHORT}/roster/append`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ users: ["drift-probe"] }),
    }),
    serviceEnv,
    makeCtx(),
  );
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, error: json?.error ?? null, text };
}
async function viaChalk(headers) {
  const r = await chalk.fetch(
    new Request(`https://chalk.test/admin/cohorts/${COHORT}/state`, { headers }),
    chalkEnv,
    makeCtx(),
  );
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { /* html/plain */ }
  return { status: r.status, error: json?.error ?? null, text };
}

// --- fixtures -------------------------------------------------------------------
const scoped = { cohort: COHORT, profiles: [PROFILE], max_hours: 12, can_start_session: true, max_session_hours: 4 };
const valid = await tokens.issueIssuer({ issuer: "drift-ok", scopes: [scoped] }, 24, TEST_SECRET);
const otherCohort = await tokens.issueIssuer({ issuer: "drift-other", scopes: [{ ...scoped, cohort: OTHER_COHORT }] }, 24, TEST_SECRET);
const student = await tokens.issue({ u: "kid", c: COHORT, p: PROFILE }, 1, TEST_SECRET);
const expired = await tokens.issueIssuer({ issuer: "drift-expired", scopes: [scoped] }, -1, TEST_SECRET);
const foreignSecret = await tokens.issueIssuer({ issuer: "drift-foreign", scopes: [scoped] }, 24, "another-secret-0123456789abcdef");
const revoked = await tokens.issueIssuer({ issuer: "drift-revoked", scopes: [scoped] }, 24, TEST_SECRET);
await serviceEnv.HPS_KV.put(`revoked:${revoked.jti}`, JSON.stringify({ ts: new Date().toISOString(), reason: "drift fixture" }));
const tampered = valid.token.slice(0, -1) + (valid.token.endsWith("A") ? "B" : "A");

const bearer = (t) => ({ authorization: `Bearer ${t}` });
// { label, headers, expected, credential } — `credential:false` marks the
// no-credential cases. There the verdict (401) must still match, but the
// wording legitimately differs: the Service falls through to its Basic realm
// ("Auth required", text/plain) because it HAS an admin path, Chalk names the
// Bearer because it has none. Every case where a token was actually presented
// is decided by the shared helper on both sides and must match byte-for-byte.
// Note "Bearer " with no token lands here too: the Fetch spec trims header
// values, so both workers see a bare "Bearer" and neither finds a token.
const fixtures = [
  { label: "valid issuer scoped to the cohort", headers: bearer(valid.token), expected: 200, credential: true },
  { label: "issuer scoped to a different cohort", headers: bearer(otherCohort.token), expected: 403, credential: true },
  { label: "student token (no issuer role)", headers: bearer(student.token), expected: 403, credential: true },
  { label: "expired issuer", headers: bearer(expired.token), expected: 401, credential: true },
  { label: "issuer signed with a foreign secret", headers: bearer(foreignSecret.token), expected: 401, credential: true },
  { label: "tampered signature", headers: bearer(tampered), expected: 401, credential: true },
  { label: "revoked issuer (revocation written once, in the shared KV)", headers: bearer(revoked.token), expected: 401, credential: true },
  { label: "garbage Bearer", headers: bearer("not.atoken"), expected: 401, credential: true },
  { label: "Bearer with no token", headers: { authorization: "Bearer " }, expected: 401, credential: false },
  { label: "no Authorization at all", headers: {}, expected: 401, credential: false },
];

// --- parity ------------------------------------------------------------------------
let mismatches = 0;
for (const { label, headers, expected, credential } of fixtures) {
  const s = await viaService(headers);
  const c = await viaChalk(headers);
  const proseSame = s.status < 400 || !credential || s.error === c.error;
  const same = s.status === c.status && proseSame;
  const okExpected = s.status === expected;
  if (!same || !okExpected) mismatches++;
  console.log(
    `${same && okExpected ? "✓" : "✗"} ${label}: service=${s.status} chalk=${c.status}` +
      (s.status >= 400 ? ` | "${s.error}" vs "${c.error}"${credential ? "" : " (no credential — status only)"}` : ""),
  );
  assert.equal(s.status, expected, `${label}: Service status`);
  assert.equal(c.status, expected, `${label}: Chalk status`);
  if (s.status >= 400 && credential) {
    assert.equal(c.error, s.error, `${label}: rejection prose must match`);
  }
}
assert.equal(mismatches, 0, "every fixture must yield the same verdict on both workers");
console.log("✓ drift-lock: identical verdicts on both workers for all fixtures");

// Positive control sanity: the 200 case really did the write on the Service
// side (so the parity above compared real authorization, not a stub).
const roster = await serviceEnv.HPS_KV.get(`cohort:${COHORT}:roster`, "json");
assert.ok(roster?.users.includes("drift-probe"), "Service actually admitted the valid issuer and wrote the roster");

// --- the asserted asymmetry: Basic auth -----------------------------------------------
{
  const basic = { authorization: "Basic " + Buffer.from(`admin:${ADMIN_PW}`).toString("base64") };
  const s = await viaService(basic);
  const c = await viaChalk(basic);
  assert.equal(s.status, 200, "Service: admin Basic is an auth path (operator surface stays there)");
  assert.equal(c.status, 401, "Chalk: admin Basic is NOT an auth path — Chalk holds no admin password");
}
console.log("✓ drift-lock: admin Basic accepted by the Service, refused by Chalk (deliberate boundary)");

console.log("All instructor-auth drift-lock tests passed.");
