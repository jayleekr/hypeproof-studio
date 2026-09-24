// #1298 — GET /admin/chalk/whoami: issuer tokens get 200, student tokens and
// absent/malformed Bearers get 401/403. Uses the full Hono app (bootApp) so
// the isIssuerAllowedEndpoint allowlist and the admin middleware are exercised.

import './harness/loader.mjs';
import assert from 'node:assert/strict';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, COHORT, PROFILE } from './harness/index.mjs';
const { issue, issueIssuer } = await import('../src/lib/tokens.ts');

const app = await bootApp();
const env = createMockEnv();
const ctx = makeCtx();

async function get(path, bearer) {
  const headers = { 'content-type': 'application/json' };
  if (bearer) headers['authorization'] = `Bearer ${bearer}`;
  const res = await app.fetch(new Request(`https://worker${path}`, { method: 'GET', headers }), env, ctx);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// 1. Valid issuer token → 200, role === "issuer"
{
  const { token } = await issueIssuer(
    { issuer: 'test-teacher', scopes: [{ cohort: COHORT, profiles: [PROFILE] }] },
    1, TEST_SECRET,
  );
  const { status, body } = await get('/admin/chalk/whoami', token);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.role, 'issuer', `expected role=issuer, got ${JSON.stringify(body)}`);
  assert.ok(Array.isArray(body.cohorts), 'expected cohorts array');
  assert.ok(body.cohorts.includes(COHORT), `cohort ${COHORT} not in ${JSON.stringify(body.cohorts)}`);
  console.log('PASS valid issuer token → 200 + role=issuer');
}

// 2. Student token (role=student) → 403
{
  const { token } = await issue({ u: 'kid01', c: COHORT, p: PROFILE, role: 'student' }, 1, TEST_SECRET);
  const { status } = await get('/admin/chalk/whoami', token);
  assert.equal(status, 403, `expected 403, got ${status}`);
  console.log('PASS student token → 403');
}

// 3. No token (no Authorization header) → non-2xx (401 if admin-pw set, 503 if not configured)
{
  const { status } = await get('/admin/chalk/whoami', null);
  assert.ok(status >= 400, `expected >=400 for absent token, got ${status}`);
  console.log(`PASS absent token → ${status} (non-2xx)`);
}

// 4. Malformed JWT → 401
{
  const { status } = await get('/admin/chalk/whoami', 'not-a-jwt');
  assert.equal(status, 401, `expected 401, got ${status}`);
  console.log('PASS malformed JWT → 401');
}

// 5. Revoked issuer token → 401
{
  const { token, jti } = await issueIssuer(
    { issuer: 'revoked-teacher', scopes: [{ cohort: COHORT, profiles: [PROFILE] }] },
    1, TEST_SECRET,
  );
  // Simulate revocation by inserting jti into KV revocation list.
  await env.HPS_KV.put(`revoked:${jti}`, '1');
  const { status } = await get('/admin/chalk/whoami', token);
  assert.equal(status, 401, `expected 401 for revoked token, got ${status}`);
  console.log('PASS revoked issuer token → 401');
}

console.log('ALL PASS chalk-instructor-whoami');
