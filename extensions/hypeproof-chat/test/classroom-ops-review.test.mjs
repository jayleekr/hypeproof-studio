// #751 review regressions, real sync loop + command runner with a deferred transport.
// No real VS Code process, SDK, timer, filesystem change or network request.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandRunner } from '../src/classroomOpsCommands.ts';
import { OpsOutbox, startOpsSync } from '../src/classroomOps.ts';

const memory = () => { let value = null; return { load: async () => value, save: async (s) => { value = structuredClone(s); } }; };
async function pendingSync() {
  let executions = 0, controls = 0, resolve;
  const command = { schema_version: 1, command_id: 'review-command', action: 'reset_runtime', args: {}, lease_generation: 1, connection_epoch: 3, issued_at: 1, start_within_ms: 120000, run_within_ms: 5000 };
  const runner = new CommandRunner({
    executors: { reset_runtime: { mutating: true, run: async () => { executions++; return { ok: true, code: 'synthetic_reset' }; } } },
    journal: memory(), now: () => 1, monotonic: () => 1, epoch: () => 3,
  });
  await runner.recover(); await runner.onCommands([command]);
  const box = await OpsOutbox.open(memory(), 'review-grant', 'review-boot', () => 1, () => crypto.randomUUID());
  const loop = startOpsSync({
    post: () => new Promise((r) => { resolve = r; }), outbox: box, appInstanceId: 'review-instance', sample: () => ({ idle_ms: 0 }),
    now: () => 1, random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {}, commands: runner,
    onControl: () => { controls++; },
  });
  const pending = loop.tick();
  const finish = async () => {
    resolve({ status: 200, body: {
      ack: { boot_id: box.bootId, contiguous_seq: 0, missing: [] },
      control: { paused: true, control_revision: 1 },
      receipt_acks: [{ command_id: command.command_id, state: 'accepted', proceed: true, reason: '' }],
    } });
    await pending;
    return { executions, controls };
  };
  return { loop, finish };
}

test('F2 positive: an active connection executes the approved command once', async () => {
  const f = await pendingSync();
  try { assert.deepEqual(await f.finish(), { executions: 1, controls: 1 }); }
  finally { f.loop.stop(); }
});
test('F2 a late proceed response cannot start a command after disconnect', async () => {
  const f = await pendingSync(); f.loop.stop();
  assert.equal((await f.finish()).executions, 0);
  assert.equal(f.loop.state, 'stopped');
});
test('F2 a late control response cannot restore the disconnected instructor hold', async () => {
  const f = await pendingSync(); f.loop.stop();
  assert.equal((await f.finish()).controls, 0);
});

// ── added with the fix: re-pairing and a command that is already running ──
test('F2 re-pairing: a response addressed to the previous connection cannot act once a new connection is running', async () => {
  const old = await pendingSync(), fresh = await pendingSync();
  old.loop.stop(); // what the host does when the learner pairs again
  assert.deepEqual(await old.finish(), { executions: 0, controls: 0 }, 'the previous connection is void');
  try { assert.deepEqual(await fresh.finish(), { executions: 1, controls: 1 }, 'the new connection works normally'); }
  finally { fresh.loop.stop(); }
});
test('F2 mid-run disconnect: the running action is asked to stop, and its result is reported as unknown — not as stopped or failed', async () => {
  let aborted = false, release;
  const command = { schema_version: 1, command_id: 'review-running', action: 'reset_runtime', args: {}, lease_generation: 1, connection_epoch: 3, issued_at: 1, start_within_ms: 120000, run_within_ms: 60000 };
  const runner = new CommandRunner({
    executors: { reset_runtime: { mutating: true, run: (signal) => new Promise((resolve) => { release = resolve; signal.addEventListener('abort', () => { aborted = true; resolve({ ok: false, code: 'aborted' }); }); }) } },
    journal: memory(), now: () => 1, monotonic: () => 1, epoch: () => 3,
  });
  await runner.recover(); await runner.onCommands([command]);
  const running = runner.onAcks([{ command_id: command.command_id, state: 'accepted', proceed: true, reason: '' }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runner.pendingReceipts()[0].state, 'running', 'precondition: the effect has started');
  runner.close(); await running; void release;
  assert.equal(aborted, true, 'a stop was requested');
  const receipt = runner.pendingReceipts()[0];
  assert.deepEqual([receipt.state, receipt.result_code], ['outcome_unknown', 'connection_closed'], 'a state-changing action that was interrupted is unknown, never assumed undone');
  await runner.onCommands([{ ...command, command_id: 'review-after-close' }]);
  assert.equal(runner.pendingReceipts().length, 1, 'a closed runner accepts nothing new');
});

// ── F4: what the App reports comes from what it observed, and only that ──
import { turnObservations, evidencePayload } from '../src/classroomOps.ts';
import { lessonStepSignal } from '../src/chatPanelHelpers.ts';
const kinds = (list) => list.map((o) => [o.kind, o.payload.stage ?? o.payload.class, o.payload.blocking ?? null, o.payload.cleared ?? false]);
test('F4 turn outcomes: first completed turn is runtime_ready, SDK fallback is a non-blocking sdk_not_ready, a later success clears', () => {
  assert.deepEqual(kinds(turnObservations({ ok: true, runtime: 'agent-sdk' })), [['activation', 'runtime_ready', null, false], ['error', 'unknown', false, true]]);
  assert.deepEqual(kinds(turnObservations({ ok: true, runtime: 'proxy', sdkFallback: true })), [['error', 'sdk_not_ready', false, false], ['activation', 'runtime_ready', null, false]], 'the turn went on: not red, and not "cleared" either');
  assert.deepEqual(kinds(turnObservations({ ok: true, toolFailed: true })), [['activation', 'runtime_ready', null, false], ['error', 'tool_not_ready', false, false]]);
});
test('F4 a failed turn names the observed cause; an unrecognised one stays unknown and a Stop is not a fault', () => {
  assert.deepEqual(kinds(turnObservations({ ok: false, errorKind: 'auth:expired' })), [['error', 'auth_expired', true, false]]);
  assert.deepEqual(kinds(turnObservations({ ok: false, errorKind: 'auth:session_inactive', status: 403, code: 'session_inactive' })), [['error', 'class_not_open', true, false]]);
  assert.deepEqual(kinds(turnObservations({ ok: false, errorKind: 'transport' })), [['error', 'network', true, false]]);
  assert.deepEqual(kinds(turnObservations({ ok: false, errorKind: 'stall' })), [['error', 'unknown', true, false], ['activation', 'runtime_failed', null, false]], 'never upgraded to a guess');
  assert.equal(turnObservations({ ok: false, errorKind: 'stall' })[0].payload.code, 'stall');
  assert.deepEqual(turnObservations({ ok: false, aborted: true, errorKind: 'aborted' }), [], 'the learner pressing Stop is their decision');
  // 401 without the Service's own code is a rejection, not an expiry (2026-07-28).
  assert.deepEqual(kinds(turnObservations({ ok: false, status: 401 })), [['error', 'auth_rejected', true, false]]);
});
test('F4 a step signal exists only for the learner\'s explicit action on a step of the confirmed lesson', () => {
  const lesson = { version: 'm2026.09.18-1', content: { steps: [{ id: 'intro' }, { id: 'build' }] } };
  assert.deepEqual(lessonStepSignal(lesson, { stepId: 'build', status: 'in_progress' }), { lesson_version: 'm2026.09.18-1', step_id: 'build', status: 'in_progress', source_state: 'real' });
  assert.equal(lessonStepSignal(lesson, { stepId: 'build', status: 'submitted' }).source_state, 'self_reported', '"I finished" is the learner\'s statement, not a verified completion');
  for (const bad of [{ stepId: 'not-in-lesson', status: 'submitted' }, { stepId: 'build', status: 'reviewed' }, { stepId: 'build', status: 'done' }, { stepId: 7, status: 'submitted' }]) assert.equal(lessonStepSignal(lesson, bad), null, JSON.stringify(bad));
  assert.equal(lessonStepSignal(null, { stepId: 'build', status: 'submitted' }), null, 'no confirmed lesson → no step is reported (the board shows unknown)');
  assert.equal(evidencePayload('change', {}).source_state, 'unverified', 'an unstated source is never reported as real');
});

test('F4 observers fire without awaiting: concurrent adds are persisted one after another, in order, and none is lost', async () => {
  let active = 0, overlapped = false, saved = null;
  const store = { load: async () => null, save: async (s) => { if (active++) overlapped = true; await new Promise((r) => setTimeout(r, 2)); saved = structuredClone(s); active--; } };
  const box = await OpsOutbox.open(store, 'review-grant', 'review-boot', () => 1, () => crypto.randomUUID());
  await Promise.all(Array.from({ length: 8 }, (_, i) => box.add('runtime', { status: i % 2 ? 'idle' : 'running' })));
  assert.equal(overlapped, false, 'two saves never run at once (a shared temp file would be renamed away under the second)');
  assert.deepEqual(saved.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
});

// Seen in the real Mac window (2026-09-20): the learner was told “강사가 ‘reset_runtime’ 조치를…”. A wire id is not a sentence.
test('the learner is told what is happening in words, not the wire id; an action without a label still says something', async () => {
  const lines = [], run = async (action, executor) => { let saved = null; const r = new CommandRunner({ executors: { [action]: executor }, journal: { load: async () => saved, save: async (s) => { saved = structuredClone(s); } }, monotonic: () => 0, now: () => 1000, epoch: () => 1, notify: (l) => lines.push(l) });
    await r.recover(); const c = { schema_version: 1, command_id: 'c-' + action, action, args: {}, lease_generation: 1, connection_epoch: 1, issued_at: 0, start_within_ms: 60000, run_within_ms: 5000 };
    await r.onCommands([c]); await r.onAcks([{ command_id: c.command_id, state: 'accepted', proceed: true, reason: 'ok' }]); };
  await run('reset_runtime', { mutating: true, label: 'AI 세션 다시 시작 (대화와 파일은 그대로)', run: async () => ({ ok: true, code: 'reset_ok' }) });
  await run('unlabelled_action', { mutating: true, run: async () => ({ ok: true, code: 'ok' }) }); await run('send_question', { mutating: false, label: '질문', run: async () => ({ ok: true, code: 'shown' }) });
  assert.deepEqual(lines, ['강사가 ‘AI 세션 다시 시작 (대화와 파일은 그대로)’ 조치를 요청해 실행합니다.', '강사가 ‘unlabelled_action’ 조치를 요청해 실행합니다.'], 'only state-changing actions announce themselves');
});
