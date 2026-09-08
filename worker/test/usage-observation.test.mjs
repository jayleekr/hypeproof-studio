import assert from 'node:assert/strict';
import { localUsageObservation } from './harness/usage-observation.mjs';
import { usageLimit, usageObservation } from '../src/lib/usage-observation.ts';
import { issue, issueIssuer } from '../src/lib/tokens.ts';
import { TEST_SECRET, PROFILE } from './harness/index.mjs';

const local = await localUsageObservation();
try {
  const call = (query = '', auth = local.auth, cohort = local.cohort) => local.fetch(new Request(
    'https://synthetic.test/admin/cohorts/' + encodeURIComponent(cohort) + '/usage' + query,
    { headers: { authorization: auth } }));
  for (const raw of ['0', '-1', '1.5', '501', 'NaN', 'Infinity', '', '1e2', '1;DROP TABLE usage_log']) {
    const before = local.state.queries.length;
    assert.equal((await call('?limit=' + encodeURIComponent(raw))).status, 400);
    assert.equal(local.state.queries.length, before, 'invalid bound never queries D1');
    assert.equal(usageLimit(raw), null);
  }
  assert.equal(usageLimit(undefined), 50);
  assert.equal(usageLimit('500'), 500);
  const response = await call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { usage, observation: o } = await response.json();
  assert.equal(usage.length, 4);
  assert.equal(o.record_count, 4);
  assert.equal(o.failed_records, 2);
  assert.equal(o.failed_with_tokens, 1);
  assert.equal(o.zero_token_records, 1);
  assert.equal(o.unattributed_session_records, 2);
  assert.deepEqual(o.totals, { tokens_in: 607, tokens_out: 27, cache_read: 340, cache_write: 54 });
  assert.equal(o.cost.status, 'unknown'); assert.equal(o.cost.amount, null);
  assert.equal(o.completeness, 'unverified');
  assert(!Number.isNaN(Date.parse(o.fetched_at)));
  assert.equal(o.has_older_records, false);
  assert(!JSON.stringify(usage).includes('private-other-student'));
  assert(usage.every(r => !('prompt' in r) && !('body_ref' in r)));
  const limited = await (await call('?limit=2')).json();
  assert.equal(limited.usage.length, 2);
  assert.equal(limited.observation.has_older_records, true);
  assert.equal(limited.observation.totals.tokens_in, 500, 'aggregate only the returned window');
  const empty = await (await call('', local.auth, 'no-records')).json();
  assert.deepEqual(empty.usage, []); assert.equal(empty.observation.cost.amount, null);
  assert.equal(empty.observation.completeness, 'unverified');
  const injected = await (await call('', local.auth, "' OR 1=1--")).json();
  assert.deepEqual(injected.usage, [], 'cohort is a bound value');
  for (const auth of ['', 'Basic invalid', 'Bearer invalid',
    'Bearer ' + (await issue({ u: 'synthetic-student', c: local.cohort, p: PROFILE }, 1, TEST_SECRET)).token,
    'Bearer ' + (await issueIssuer({ issuer: 'synthetic-instructor', scopes: [{ cohort: local.cohort, profiles: [PROFILE] }] }, 1, TEST_SECRET)).token]) {
    const before = local.state.queries.length;
    assert.equal((await call('', auth)).status, 401);
    assert.equal(local.state.queries.length, before, 'no new student/instructor read authority');
  }
  local.state.failReads = true;
  const failure = await call(); assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { error: 'usage_unavailable' });
  local.state.failReads = false;
  assert.equal((await call()).status, 200);
  assert(local.state.queries.every(sql => /^SELECT\b/.test(sql)), 'request path is read only');
  for (const invalid of [-1, NaN, Infinity, 1.5, '10', null])
    assert.throws(() => usageObservation([{ ...usage[0], cache_write: invalid }], 50, false));
  console.log('PASS usage observation: actual Hono/SQLite, exact recent window, cache write, failed spend, unknown/empty/error, operator auth, input bounds and read-only isolation');
} finally { local.close(); }
