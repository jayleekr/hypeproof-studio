// Does the record/assess split actually REACH the routes?
// Run: node --experimental-strip-types --experimental-sqlite test/observation-capability-routes.test.mjs
//
// ## Why a route test and not another unit test
//
// `observation-capability.test.mjs` proves the function returns two independent
// booleans. That is not the same claim as "the routes branch on them". P1 shipped a
// feature whose unit tests were all green and whose screens no cohort could reach,
// because nothing asked the route (judge-P1-2026-09-20 F-1). MASTER_PROMPT v3 calls
// this gate G4 — reachability.
//
// The split has no effect on anything shipped until a profile sets the fields, so a
// test that only used today's profiles would pass against a router that ignored them
// completely. This test therefore pins the SYNTHETIC canary profile
// (`canary-sdk-contract`, already CI-only with an empty roster) to each half of the
// split in turn and asks the real routes.
//
// It mutates the registry's profile object and restores it in a `finally`. That is
// deliberate and contained: the alternative is a tenth profile carried in the product
// only so a test can look at it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { localAuthoring } from './harness/dental-authoring.mjs';
import { TEST_SECRET } from './harness/index.mjs';

const { getProfile } = await import('../src/profiles/index.ts');
const { setRoster, startSession } = await import('../src/lib/kv.ts');
const { issue } = await import('../src/lib/tokens.ts');

const CANARY = 'canary-sdk-contract';

/** One seat on the canary cohort with class open, asked the way the extension asks. */
async function seat() {
  const local = await localAuthoring({ profileId: CANARY });
  local.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort, 'capability-routes');
  const starts = new Date(Date.now() - 1000).toISOString();
  const ends = new Date(Date.now() + 3600000).toISOString();
  local.db
    .prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
    .run('cap', local.cohort, local.profileId, starts, ends);
  await setRoster(local.env.HPS_KV, local.cohort, ['student']);
  await startSession(local.env.HPS_KV, local.cohort, {
    session_id: 'cap', profile_id: local.profileId, starts_at: starts, ends_at: ends,
  });
  const { token } = await issue({ u: 'student', c: local.cohort, p: local.profileId }, 1, TEST_SECRET);
  return {
    close: local.close,
    async get(path) {
      const res = await local.fetcher(local.origin + path, {
        headers: { authorization: 'Bearer ' + token, 'x-hps-observation-format': 'hps-observation/2' },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async post(path, payload) {
      const res = await local.fetcher(local.origin + path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'x-hps-observation-format': 'hps-observation/2',
        },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
  };
}

/** The code the routes return when a capability is off, and nothing else. */
const unavailable = (r) => r.status === 404 && r.body?.error?.code === 'observation_unavailable';

async function withCanaryObservation(observation, fn) {
  const profile = getProfile(CANARY);
  assert.ok(profile, `${CANARY} is not in the registry — this test's subject moved`);
  const original = profile.observation;
  profile.observation = observation;
  try {
    return await fn();
  } finally {
    profile.observation = original;
  }
}

test('record on, assess off: the device records, nothing may leave it', async () => {
  await withCanaryObservation({ record: true, assess: false, format: 'hps-observation/2' }, async () => {
    const s = await seat();
    try {
      const context = await s.get('/v1/observations/context');
      assert.equal(context.status, 200, `/context should serve a recording seat, got ${context.status}`);
      assert.equal(context.body.format, 'hps-observation/2');

      const assess = await s.post('/v1/observations/assess', {});
      assert.ok(
        unavailable(assess),
        `/assess must refuse when assess is off — got ${assess.status} ${JSON.stringify(assess.body)}`,
      );
    } finally {
      s.close();
    }
  });
});

test('record off, assess on: /context closes, /assess is no longer refused for being unavailable', async () => {
  // The mirror case. Without it, a router that wired BOTH routes to `record` would
  // still pass the test above.
  await withCanaryObservation({ record: false, assess: true, format: 'hps-observation/2' }, async () => {
    const s = await seat();
    try {
      const context = await s.get('/v1/observations/context');
      assert.ok(
        unavailable(context),
        `/context must refuse when record is off — got ${context.status} ${JSON.stringify(context.body)}`,
      );

      // `/assess` gets past the capability check and fails later on the empty body.
      // The claim here is only "not refused as unavailable" — asserting a specific
      // downstream error would pin behaviour this ADR step does not own.
      const assess = await s.post('/v1/observations/assess', {});
      assert.ok(
        !unavailable(assess),
        'assess:true must get past the capability gate',
      );
    } finally {
      s.close();
    }
  });
});

test('legacy `enabled` alone still opens both — the shipped profiles did not change', async () => {
  await withCanaryObservation({ enabled: true, format: 'hps-observation/2' }, async () => {
    const s = await seat();
    try {
      assert.equal((await s.get('/v1/observations/context')).status, 200);
      assert.ok(!unavailable(await s.post('/v1/observations/assess', {})));
    } finally {
      s.close();
    }
  });
});

test('both off closes both — negative control', async () => {
  await withCanaryObservation({ record: false, assess: false }, async () => {
    const s = await seat();
    try {
      assert.ok(unavailable(await s.get('/v1/observations/context')));
      assert.ok(unavailable(await s.post('/v1/observations/assess', {})));
    } finally {
      s.close();
    }
  });
});
