// #1042 — the App observation contract is the common measurement core, not a copy.
import assert from 'node:assert/strict';
const app = await import('../src/nativeObservationContract.ts');
const core = await import('../../../worker/src/lib/measurement-core/index.ts');
for (const name of ['validateObservation', 'validateFindings', 'observableAssets', 'OBSERVATION_FORMAT', 'OBSERVATION_ASSETS'])
  assert.equal(app[name], core[name], `App ${name} is not the core export`);
// Control: the recorder built on that contract still refuses a changed scope.
const { NativeObservationRecorder } = await import('../src/nativeObservationRecorder.ts');
const context = { format: 'hps-observation/1', scope: 'synthetic-a', session: 'session-a', program: 'm2026.09.08-1' };
const saved = new NativeObservationRecorder(context).snapshot();
assert.throws(() => new NativeObservationRecorder({ ...context, scope: 'synthetic-b' }, saved), /observation_scope_changed/);
console.log('PASS App observation contract resolves to the common measurement core');
