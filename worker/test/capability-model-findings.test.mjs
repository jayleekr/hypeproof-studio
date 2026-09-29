// Findings are validated against the model they were WRITTEN in.
// Run: node --experimental-strip-types test/capability-model-findings.test.mjs
//
// Jay's 2026-09-13 decision (#1020): new interpretations use the six-capability
// candidate model, the seven Assets stay readable under their own id, and nothing
// maps one onto the other. The hazard in implementing that is not the new path —
// it is every observation already stored on a student's machine. The App
// re-validates saved records from `workspaceState` on load, so a validator that
// simply switched to six keys would turn all of that history into
// "이전 관찰 근거를 확인하지 못했습니다."
//
// So the legacy case here is not a courtesy test. It is the one that says the
// migration did not eat anything.

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  validateFindings,
  observableAssets,
  capabilityKeys,
  asCapabilityModel,
} = await import('../src/lib/measurement-core/legacy-observation.ts');
const { capabilityLabel } = await import('../src/lib/measurement-core/capability-models.ts');

const SEVEN = ['TASTE', 'INTENT', 'CONTEXT', 'VERIFY', 'DELEGATE', 'ITERATE', 'OWNERSHIP'];
const SIX = ['FRAMING', 'JUDGMENT', 'ORCHESTRATE', 'VERIFY', 'ADAPT', 'OWNERSHIP'];

/** One `user` event: no executed result, no artifact versions. */
const batch = () => ({
  format: 'hps-observation/1',
  scope: 'seat-1',
  session: 's1',
  program: 'm2026.09.21-1',
  events: [{
    id: 'u1', seq: 1, task: 't1', at: 1, kind: 'user',
    text: '새 직원이 주문을 확인할 문서가 필요해', assistance: 'unknown',
  }],
});

const unobserved = (keys) => keys.map((asset) => ({
  asset, status: 'unobserved', interpretation: '잠정 관찰',
  evidence: [], assistance: 'unknown', next: '다음 과제에서 확인',
}));

test('a stored seven-Asset record still validates — nothing on a student machine breaks', () => {
  assert.doesNotThrow(() => validateFindings(unobserved(SEVEN), batch()));
  // And explicitly, the way the App now asks after reading a record with no model id.
  assert.equal(asCapabilityModel(undefined), 'legacy-seven-assets');
  assert.doesNotThrow(() =>
    validateFindings(unobserved(SEVEN), batch(), asCapabilityModel(undefined)));
});

test('a new six-capability record validates under its own model', () => {
  assert.doesNotThrow(() => validateFindings(unobserved(SIX), batch(), 'candidate-capability-v1'));
  assert.equal(asCapabilityModel('candidate-capability-v1'), 'candidate-capability-v1');
});

test('each model refuses the other — there is no conversion table', () => {
  // The whole point of `capability-models.ts` saying so. If either direction passed,
  // a findings array would have no single meaning.
  assert.throws(() => validateFindings(unobserved(SIX), batch()), /invalid_/);
  assert.throws(() => validateFindings(unobserved(SEVEN), batch(), 'candidate-capability-v1'), /invalid_/);
});

test('a mixed array is refused even when the count is right', () => {
  // Length alone would accept this: five candidate keys plus VERIFY and OWNERSHIP,
  // which live in both models, is seven items. Membership is what catches it.
  const mixed = unobserved(['FRAMING', 'JUDGMENT', 'ORCHESTRATE', 'VERIFY', 'ADAPT', 'OWNERSHIP', 'TASTE']);
  assert.equal(mixed.length, SEVEN.length);
  assert.throws(() => validateFindings(mixed, batch()), /invalid_asset/);
});

test('evidence floors follow the capability, not the model', () => {
  // VERIFY needs an executed result in both models; ITERATE and its candidate
  // counterpart ADAPT need two artifact versions. The candidate half comes from
  // that capability's `insufficient` line; the ITERATE half is the pre-existing /1
  // rule preserved (every legacy capability's `insufficient` is literally
  // "historical" — the legacy model states no criteria).
  const thin = batch();
  assert.ok(!observableAssets(thin).includes('VERIFY'));
  assert.ok(!observableAssets(thin, 'candidate-capability-v1').includes('VERIFY'));
  assert.ok(!observableAssets(thin).includes('ITERATE'));
  assert.ok(!observableAssets(thin, 'candidate-capability-v1').includes('ADAPT'));

  // Positive control: with the evidence present, both open up. Without this the
  // assertions above would pass against a function that returned nothing at all.
  const rich = batch();
  rich.events.push(
    { id: 'r1', seq: 2, task: 't1', at: 2, kind: 'tool_result', text: 'ok', outcome: 'success', assistance: 'unknown' },
    { id: 'a1', seq: 3, task: 't1', at: 3, kind: 'artifact', text: 'v1', sha256: 'a'.repeat(64), assistance: 'unknown' },
    { id: 'a2', seq: 4, task: 't1', at: 4, kind: 'artifact', text: 'v2', sha256: 'b'.repeat(64), assistance: 'unknown' },
  );
  assert.deepEqual([...observableAssets(rich)].sort(), [...SEVEN].sort());
  assert.deepEqual([...observableAssets(rich, 'candidate-capability-v1')].sort(), [...SIX].sort());
});

test('capabilityKeys is the single list both the schema and the validator read', () => {
  assert.deepEqual([...capabilityKeys('legacy-seven-assets')], SEVEN);
  assert.deepEqual([...capabilityKeys('candidate-capability-v1')], SIX);
});

test('every key a screen may draw has a Korean label, in its own model', () => {
  // The panel prints `capabilityLabel(f.asset, model)`. A key with no label would
  // silently fall back to the English key in front of a learner.
  for (const [model, keys] of [['legacy-seven-assets', SEVEN], ['candidate-capability-v1', SIX]]) {
    for (const key of keys) {
      const label = capabilityLabel(key, model);
      assert.notEqual(label, key, `${model}/${key} 에 한국어 이름표가 없다`);
      assert.match(label, /[가-힣]/, `${model}/${key} 의 이름표가 한국어가 아니다`);
    }
  }
  // Unknown key, and unknown model, both stay visible rather than blank.
  assert.equal(capabilityLabel('NOPE', 'candidate-capability-v1'), 'NOPE');
  assert.equal(capabilityLabel('VERIFY', 'no-such-model'), 'VERIFY');
});

test('a key in both models keeps its own model\'s word', () => {
  // OWNERSHIP is the one collision, and the two words are different constructs:
  // 책임 in the candidate model, 주인의식 in the seven Assets. An implementation
  // that scanned both models and took the first hit would relabel every stored
  // legacy finding with the current model's word — a silent one-way conversion in
  // a file whose header says there is deliberately no conversion table.
  assert.equal(capabilityLabel('OWNERSHIP', 'candidate-capability-v1'), '책임');
  assert.equal(capabilityLabel('OWNERSHIP', 'legacy-seven-assets'), '주인의식');
  assert.notEqual(
    capabilityLabel('OWNERSHIP', 'candidate-capability-v1'),
    capabilityLabel('OWNERSHIP', 'legacy-seven-assets'),
  );
  // A key that exists in only one model is not borrowed from the other.
  assert.equal(capabilityLabel('TASTE', 'candidate-capability-v1'), 'TASTE');
  assert.equal(capabilityLabel('FRAMING', 'legacy-seven-assets'), 'FRAMING');
});
