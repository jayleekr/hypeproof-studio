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
