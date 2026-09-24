// #1298 — GET /admin/chalk/instructor-brief: issuer tokens get 200 + versioned text,
// student tokens get 403. Uses the full Hono app (bootApp) so the allowlist and
// admin middleware are exercised.

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

// 1. Valid issuer token → 200, id and version present, text is a string
{
  const { token } = await issueIssuer(
    { issuer: 'test-teacher', scopes: [{ cohort: COHORT, profiles: [PROFILE] }] },
    1, TEST_SECRET,
  );
  const { status, body } = await get('/admin/chalk/instructor-brief', token);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.id, 'chalk-instructor-brief', `expected id=chalk-instructor-brief, got ${JSON.stringify(body)}`);
  assert.ok(typeof body.version === 'number' && body.version >= 1, `expected numeric version >= 1, got ${JSON.stringify(body)}`);
  assert.ok(typeof body.text === 'string' && body.text.length > 0, `expected non-empty text string, got ${JSON.stringify(body)}`);
  console.log(`PASS valid issuer token → 200 id=${body.id} version=${body.version}`);
}

// 2. Student token (role=student) → 403
{
  const { token } = await issue({ u: 'kid01', c: COHORT, p: PROFILE, role: 'student' }, 1, TEST_SECRET);
  const { status } = await get('/admin/chalk/instructor-brief', token);
  assert.equal(status, 403, `expected 403, got ${status}`);
  console.log('PASS student token → 403');
}

// 3. Cache hit: requesting with current version returns up_to_date:true
{
  const { token } = await issueIssuer(
    { issuer: 'caching-teacher', scopes: [{ cohort: COHORT, profiles: [PROFILE] }] },
    1, TEST_SECRET,
  );
  // First fetch to learn the version
  const { body: first } = await get('/admin/chalk/instructor-brief', token);
  const version = first.version;
  // Second fetch with same version
  const { status: s2, body: b2 } = await get(`/admin/chalk/instructor-brief?version=${version}`, token);
  assert.equal(s2, 200, `expected 200, got ${s2}`);
  assert.equal(b2.up_to_date, true, `expected up_to_date=true, got ${JSON.stringify(b2)}`);
  assert.equal(b2.text, null, `expected text=null on cache hit, got ${JSON.stringify(b2)}`);
  console.log('PASS cache hit with current version → up_to_date:true text:null');
}

console.log('ALL PASS chalk-instructor-brief');
