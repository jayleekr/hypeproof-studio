// `observationCapability()` — the one place ADR 0010's record/assess split is decided.
// Run: node --experimental-strip-types test/observation-capability.test.mjs
//
// The point of the ADR is that two things that used to move together can now move
// apart. A test that only checks the legacy fallback would pass just as happily if
// the function ignored `record`/`assess` entirely, so the independence cases are the
// ones that carry the weight.

import test from 'node:test';
import assert from 'node:assert/strict';

const { observationCapability } = await import('../src/lib/measurement-core/legacy-observation.ts');

test('legacy `enabled` still drives both — step 1 changes nothing that ships', () => {
  assert.deepEqual(observationCapability({ enabled: true }), { record: true, assess: true });
  assert.deepEqual(observationCapability({ enabled: false }), { record: false, assess: false });
  // No observation block at all is the state of 7 of the 9 profiles.
  assert.deepEqual(observationCapability(undefined), { record: false, assess: false });
});

test('the two move independently — this is the whole point of the split', () => {
  // The kids-cohort shape: record on the device, nothing leaves it.
  assert.deepEqual(
    observationCapability({ record: true, assess: false }),
    { record: true, assess: false },
    'record without assess must be expressible, or ADR 0010 buys nothing',
  );
  // And the reverse, so a future reader cannot collapse the pair back into one
  // boolean and still pass.
  assert.deepEqual(observationCapability({ record: false, assess: true }), { record: false, assess: true });
});

test('an explicit field wins over the legacy boolean it replaces', () => {
  // The migration state: a profile still carries `enabled` while one capability
  // has already been pinned. If the fallback won here, step 4 (default record on)
  // could not turn anything on without also turning assess on.
  assert.deepEqual(observationCapability({ enabled: true, assess: false }), { record: true, assess: false });
  assert.deepEqual(observationCapability({ enabled: false, record: true }), { record: true, assess: false });
});

test('only `enabled === true` counts as on', () => {
  // Negative control against a truthiness bug: `enabled` is typed boolean, but the
  // block is built from JSON in tests and fixtures. A `??`-based reader would treat
  // 0 or "" as "not set" and fall through to the wrong answer.
  for (const bad of [0, '', 'true', 1, null]) {
    assert.deepEqual(
      observationCapability({ enabled: bad }),
      { record: false, assess: false },
      `enabled=${JSON.stringify(bad)} must not read as on`,
    );
  }
});

test('the assertions above are not vacuous', () => {
  // Rule 2's positive control, aimed at this file rather than the product: if the
  // function were replaced by a constant, every case above would still have to
  // disagree with it somewhere.
  const constant = () => ({ record: true, assess: true });
  const disagrees = [
    { enabled: false },
    { record: true, assess: false },
    { record: false, assess: true },
    { enabled: true, assess: false },
    undefined,
  ].filter((input) => {
    const real = observationCapability(input);
    const fake = constant();
    return real.record !== fake.record || real.assess !== fake.assess;
  });
  assert.equal(disagrees.length, 5, 'every case must disagree with a constant implementation');
});
