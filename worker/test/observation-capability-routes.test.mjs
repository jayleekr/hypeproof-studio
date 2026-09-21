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

/**
 * One seat on the canary cohort, asked the way the extension asks.
 *
 * `openSession` exists for ADR 0010 step 2: the claim "the session gate stopped
 * riding on observation" is only measurable on a seat whose class is NOT open,
 * and every case in this file before that step had one open.
 */
async function seat({ openSession = true } = {}) {
  const local = await localAuthoring({ profileId: CANARY });
  local.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort, 'capability-routes');
  if (openSession) {
    const starts = new Date(Date.now() - 1000).toISOString();
    const ends = new Date(Date.now() + 3600000).toISOString();
    local.db
      .prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
      .run('cap', local.cohort, local.profileId, starts, ends);
    await setRoster(local.env.HPS_KV, local.cohort, ['student']);
    await startSession(local.env.HPS_KV, local.cohort, {
      session_id: 'cap', profile_id: local.profileId, starts_at: starts, ends_at: ends,
    });
  }
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

/** Patch any set of top-level canary fields for the duration of `fn`. */
async function withCanaryProfile(patch, fn) {
  const profile = getProfile(CANARY);
  assert.ok(profile, `${CANARY} is not in the registry — this test's subject moved`);
  const original = Object.fromEntries(Object.keys(patch).map((k) => [k, profile[k]]));
  Object.assign(profile, patch);
  try {
    return await fn();
  } finally {
    Object.assign(profile, original);
  }
}

const withCanaryObservation = (observation, fn) => withCanaryProfile({ observation }, fn);

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

test('/v1/profile hands the client the cohort\'s own assess, not a constant', async () => {
  // This is the ONLY place the client learns `assess`, and therefore the only
  // input to the work-screen gate (SX-59). Without this case, hardcoding
  // `assess: true` in the response would pass every other test in this file —
  // the routes below would still branch correctly while every cohort got the
  // observation results panel back.
  for (const [observation, expected] of [
    [{ record: true, assess: false, format: 'hps-observation/2' }, false],
    [{ record: true, assess: true, format: 'hps-observation/2' }, true],
    [{ enabled: true, format: 'hps-observation/2' }, true],
  ]) {
    await withCanaryObservation(observation, async () => {
      const s = await seat();
      try {
        const res = await s.get('/v1/profile');
        assert.equal(res.status, 200);
        assert.equal(
          res.body.observation?.assess,
          expected,
          `${JSON.stringify(observation)} 인데 /v1/profile 이 assess=${res.body.observation?.assess} 를 줬다`,
        );
      } finally {
        s.close();
      }
    });
  }
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

// ---------------------------------------------------------------------------
// ADR 0010 step 2 — the /v1/profile session gate stops riding on observation
// ---------------------------------------------------------------------------
//
// The snapshot next door (profile-serving-snapshot) proves today's 36 answers
// did not move. That is necessary and not sufficient: a route that still read
// `record` would produce the identical 36 answers, because the only two
// recording cohorts are the only two that declare `requires_open_session`.
// What the split claims is a DIFFERENT thing — that the two switches are now
// independent — and the only way to measure it is to set them apart, which no
// shipped profile does. Hence the canary, again.

/** The canary's own session block, with one field overridden. */
const sessionWith = (over) => ({ ...getProfile(CANARY).session, ...over });

test('/v1/profile: recording a seat no longer requires the class to be open', async () => {
  // record ON, requires_open_session OFF, class NOT open.
  // Before step 2 this was a 403: `record` was the gate. It is what would have
  // happened to seven cohorts the day `record` defaults on (ADR step 4).
  await withCanaryProfile(
    {
      observation: { record: true, assess: false, format: 'hps-observation/2' },
      session: sessionWith({ requires_open_session: false }),
    },
    async () => {
      const s = await seat({ openSession: false });
      try {
        const res = await s.get('/v1/profile');
        assert.equal(
          res.status,
          200,
          `기록이 켜졌다는 이유만으로 수업 전 프로필 읽기가 막혔다 — ${res.status} ${JSON.stringify(res.body)}`,
        );
        // And the guard that makes loosening the gate safe: no session means no
        // scope, and a scopeless observation block moves the shipped app's chat
        // history to a token hash. Serve nothing rather than something broken.
        assert.equal(
          res.body.observation,
          undefined,
          `scope 를 만들 수 없는데 observation 블록을 보냈다 — ${JSON.stringify(res.body.observation)}`,
        );
      } finally {
        s.close();
      }
    },
  );
});

test('/v1/profile: the cohort that declares requires_open_session still gets 403 — negative control', async () => {
  // The mirror. observation entirely OFF, the new flag ON. If the route still
  // read `record`, this would be a 200 and the flag would be decorative.
  await withCanaryProfile(
    {
      observation: { record: false, assess: false },
      session: sessionWith({ requires_open_session: true }),
    },
    async () => {
      const s = await seat({ openSession: false });
      try {
        const res = await s.get('/v1/profile');
        assert.equal(
          res.status,
          403,
          `requires_open_session 을 켰는데 수업 없이 프로필이 나왔다 — ${res.status}`,
        );
      } finally {
        s.close();
      }
    },
  );
});

test('/v1/profile: a recording seat inside an open class still gets its scope — positive control', async () => {
  // Without this the two cases above are satisfied by a route that never
  // serves an observation block at all.
  await withCanaryProfile(
    {
      observation: { record: true, assess: true, format: 'hps-observation/2' },
      session: sessionWith({ requires_open_session: true }),
    },
    async () => {
      const s = await seat();
      try {
        const res = await s.get('/v1/profile');
        assert.equal(res.status, 200);
        assert.equal(res.body.observation?.format, 'hps-observation/2');
        assert.equal(typeof res.body.observation?.scope, 'string');
        assert.ok(res.body.observation.scope.length > 0, 'scope 가 빈 문자열이다');
        assert.equal(res.body.observation?.assess, true);
      } finally {
        s.close();
      }
    },
  );
});
