// Remote classroom operations R2 (#751) — command ledger with synthetic accounts.
// Service+SQLite layer of AT-19/20/21/23. The App executor, real crash recovery
// and real D1 concurrency are separate layers.
import assert from 'node:assert/strict';
import { localOps } from './harness/classroom-ops.mjs';
import * as ops from '../src/lib/classroom-ops.ts';
let count = 0; async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }

await check('controls: target states only move forward and a terminal outcome is final', async () => {
  assert.deepEqual(ops.nextTargetState('leased', 'accepted'), { ok: true, state: 'accepted' }); assert.deepEqual(ops.nextTargetState('running', 'succeeded'), { ok: true, state: 'succeeded' });
  assert.equal(ops.nextTargetState('queued', 'accepted').reason, 'not_leased'); assert.equal(ops.nextTargetState('running', 'accepted').reason, 'backwards'); assert.equal(ops.nextTargetState('succeeded', 'failed').reason, 'terminal'); assert.equal(ops.nextTargetState('leased', 'leased').reason, 'unknown_state');
  const s = ops.summarize([{ state: 'succeeded' }, { state: 'queued' }]); assert.equal(s.done, false); assert.equal(s.all_succeeded, false);
  assert.equal(ops.summarize([{ state: 'succeeded' }, { state: 'outcome_unknown' }]).all_succeeded, false); assert.equal(ops.summarize([{ state: 'succeeded' }]).all_succeeded, true); assert.equal(ops.summarize([]).all_succeeded, false);
  for (const a of Object.keys(ops.COMMAND_ACTIONS)) assert.ok(!/shell|exec|eval|path|url|command$/.test(a), a);
});

const f = await localOps();
const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-c' }];
try {
  await f.freeze(); assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true } })).status, 201);
  const a1 = (await f.pair('A1', 1, 1)).conn.json, a2 = (await f.pair('A2', 1, 2, ['observe'])).conn.json; // A2 is an old client; A3 never connects
  await check('AT-19 flag off, missing capability, other cohort, student and non-allowlisted actions/arguments are refused', async () => {
    assert.equal((await f.command('retry_diagnostics', ['A1'])).json.reason, 'ops_commands_disabled');
    assert.equal((await f.configure(seats, 1, { flags: { ops_commands: true } })).status, 200);
    const again = { expected_roster_revision: 2 };
    assert.equal((await f.command('retry_diagnostics', ['A1'], again, await f.teacher('watcher', ['observe']))).status, 403);
    assert.equal((await f.command('retry_diagnostics', ['A1'], again, await f.student())).status, 403);
    assert.equal((await f.command('retry_diagnostics', ['A1'], again, await f.teacher('other', undefined, 'other-cohort'))).status, 403);
    for (const action of ['shell', 'run_vscode_command', 'open_url', 'delete_workspace', 'clear_history', '../reset']) assert.equal((await f.command(action, ['A1'], again)).json.reason, 'action_not_allowed', action);
    for (const args of [{ cmd: 'id' }, { path: '/etc/passwd' }, { url: 'https://example.test/x.sh' }]) assert.equal((await f.command('retry_diagnostics', ['A1'], { ...again, args })).json.reason, 'args_not_allowed');
    assert.equal((await f.command('retry_diagnostics', ['ZZ'], again)).status, 404); assert.equal((await f.command('retry_diagnostics', ['A1'], { expected_roster_revision: 1 })).status, 409);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_commands').get().n, 0);
  });
  let cmd, cmd2, view;
  await check('AT-20 enqueue is 202 queued, never success; per-target outcome is decided up front; same key replays, different payload conflicts', async () => {
    const key = crypto.randomUUID(), body = { expected_roster_revision: 2, idempotency_key: key };
    const r = await f.command('retry_diagnostics', ['A1', 'A2', 'A3'], body); assert.equal(r.status, 202, r.raw); view = r.json;
    assert.deepEqual(view.targets.map((t) => [t.seat_id, t.state]), [['A1', 'queued'], ['A2', 'unsupported'], ['A3', 'not_connected']]);
    assert.deepEqual([view.summary.done, view.summary.all_succeeded, view.summary.unconfirmed], [false, false, 1]);
    const replay = await f.command('retry_diagnostics', ['A3', 'A2', 'A1'], body); assert.equal(replay.status, 200); assert.equal(replay.json.command.id, view.command.id);
    assert.equal((await f.command('retry_diagnostics', ['A1'], body)).status, 409); assert.equal((await f.command('restart_preview', ['A1', 'A2', 'A3'], body)).status, 409);
    const racedKey = crypto.randomUUID(), raced = await Promise.all([1, 2, 3].map(() => f.command('refresh_connection', ['A1'], { expected_roster_revision: 2, idempotency_key: racedKey })));
    assert.deepEqual(raced.map((x) => x.status).sort(), [200, 200, 202]); assert.equal(f.db.prepare('SELECT count(*) n FROM ops_commands').get().n, 2);
    assert.equal(f.db.prepare("SELECT count(*) n FROM ops_audit WHERE action='command_enqueued'").get().n, 2, 'enqueue and audit commit together, once');
  });
  await check('AT-20 enqueue is atomic: a failed audit write leaves no command and no target', async () => {
    const before = f.db.prepare('SELECT count(*) n FROM ops_command_targets').get().n; f.fail('INSERT INTO ops_audit');
    const r = await f.command('retry_diagnostics', ['A1'], { expected_roster_revision: 2 }); f.fail(''); assert.equal(r.status, 503);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_command_targets').get().n, before);
  });
  await check('AT-21/23 only the lease-owning window receives commands; a second window observes; lost responses are re-delivered', async () => {
    const other = await f.sync(a1.credential, [], 5); assert.equal(other.status, 200); // same seat, another window, arrives first
    assert.equal(other.json.lease, 'owner'); // first window to ask owns the seat lease…
    const first = await f.sync(a1.credential, [], 1); assert.equal(first.json.lease, 'observer'); assert.deepEqual(first.json.commands, [], '…and the other window gets nothing to run');
    const again = await f.sync(a1.credential, [], 5); assert.equal(again.json.commands.length, 2); cmd = again.json.commands.find((x) => x.command_id === view.command.id); cmd2 = again.json.commands.find((x) => x.command_id !== view.command.id);
    assert.deepEqual(Object.keys(cmd).sort(), ['action', 'args', 'command_id', 'connection_epoch', 'issued_at', 'lease_generation', 'run_within_ms', 'schema_version', 'start_within_ms']);
    assert.ok(cmd.start_within_ms > 0 && cmd.start_within_ms <= ops.COMMAND_TTL_MS); assert.deepEqual(cmd.args, {});
    const redelivered = await f.sync(a1.credential, [], 5); assert.ok(redelivered.json.commands.some((x) => x.command_id === cmd.command_id), 'response loss does not strand a leased command');
    assert.equal((await f.sync(a2.credential, [], 2)).json.commands.length, 0);
  });
  await check('AT-21 receipts: observer window, wrong generation/epoch, skipped states and other seats are refused; accepted→running→succeeded is recorded once', async () => {
    const ack = async (cred, n, r) => (await f.sync(cred, [], n, { receipts: [r] })).json.receipt_acks[0];
    assert.equal((await ack(a1.credential, 1, f.receipt(cmd, 'accepted'))).reason, 'lease_lost');
    assert.equal((await ack(a1.credential, 5, f.receipt({ ...cmd, lease_generation: 99 }, 'accepted'))).reason, 'lease_lost');
    assert.equal((await ack(a1.credential, 5, f.receipt({ ...cmd, connection_epoch: 0 }, 'accepted'))).reason, 'epoch_stale');
    assert.equal((await ack(a2.credential, 2, f.receipt(cmd2, 'succeeded'))).reason, 'not_found', 'another seat cannot report this command');
    assert.equal((await ack(a2.credential, 2, f.receipt(cmd, 'succeeded'))).reason, 'terminal', 'an unsupported target cannot be flipped to success');
    assert.equal((await ack(a1.credential, 5, { ...f.receipt(cmd, 'succeeded'), stdout: 'x' })).reason, 'schema');
    assert.equal((await ack(a1.credential, 5, f.receipt(cmd, 'succeeded', 'rm -rf /'))).reason, 'schema');
    const ok = await ack(a1.credential, 5, f.receipt(cmd, 'accepted')); assert.deepEqual([ok.state, ok.proceed], ['accepted', true]);
    assert.equal((await ack(a1.credential, 5, f.receipt(cmd, 'accepted'))).reason, 'backwards');
    let v = (await f.request(f.base + '/commands/' + cmd.command_id)).json; assert.equal(v.targets[0].state, 'accepted'); assert.equal(v.summary.done, false);
    assert.equal((await ack(a1.credential, 5, f.receipt(cmd, 'running'))).state, 'running');
    assert.equal((await ack(a1.credential, 5, f.receipt(cmd, 'succeeded', 'probe_ok'))).state, 'succeeded');
    assert.equal((await ack(a1.credential, 5, f.receipt(cmd, 'succeeded', 'probe_ok'))).reason, 'recorded'); assert.equal((await ack(a1.credential, 5, f.receipt(cmd, 'failed', 'late'))).reason, 'terminal');
    v = (await f.request(f.base + '/commands/' + cmd.command_id)).json; assert.deepEqual(v.targets.map((t) => t.state), ['succeeded', 'unsupported', 'not_connected']);
    assert.deepEqual([v.summary.done, v.summary.all_succeeded], [true, false], 'bulk is done but not "all succeeded"'); assert.equal(v.targets[0].result_code, 'probe_ok');
    assert.equal(f.db.prepare("SELECT count(*) n FROM ops_audit WHERE action='command_succeeded'").get().n, 1);
  });
  await check('AT-21 TTL: a command not started in time expires and the device is told not to proceed; a started one without a receipt becomes outcome_unknown', async () => {
    const late = (await f.command('restart_preview', ['A1'], { expected_roster_revision: 2 })).json; const sy = await f.sync(a1.credential, [], 5); const got = sy.json.commands.find((x) => x.command_id === late.command.id); assert.ok(got, JSON.stringify(late) + sy.raw);
    f.db.prepare('UPDATE ops_command_targets SET expires_at=1 WHERE command_id=?').run(late.command.id);
    const r = (await f.sync(a1.credential, [], 5, { receipts: [f.receipt(got, 'accepted')] })).json; assert.deepEqual([r.receipt_acks[0].state, r.receipt_acks[0].proceed], ['expired', false]); assert.ok(!r.commands.some((x) => x.command_id === late.command.id));
    const lost = (await f.command('restart_preview', ['A1'], { expected_roster_revision: 2 })).json; const g2 = (await f.sync(a1.credential, [], 5)).json.commands.find((x) => x.command_id === lost.command.id);
    await f.sync(a1.credential, [], 5, { receipts: [f.receipt(g2, 'accepted')] }); f.db.prepare('UPDATE ops_command_targets SET expires_at=1 WHERE command_id=?').run(lost.command.id);
    const v = (await f.request(f.base + '/commands/' + lost.command.id)).json; assert.deepEqual([v.targets[0].state, v.targets[0].result_code, v.summary.unconfirmed], ['outcome_unknown', 'no_receipt', 1]);
  });
  await check('AT-21/23 a command addressed to an earlier epoch or device is never delivered after token re-issue or re-pairing', async () => {
    const stale = (await f.command('retry_diagnostics', ['A1'], { expected_roster_revision: 2 })).json;
    await f.request('/admin/tokens/issue', 'POST', { u: 'student-a', c: f.cohort, p: f.profile, hours: 2 }); // new login generation
    const s = (await f.sync(a1.credential, [], 5)).json; assert.ok(!s.commands.some((x) => x.command_id === stale.command.id));
    let v = (await f.request(f.base + '/commands/' + stale.command.id)).json; assert.deepEqual([v.targets[0].state, v.targets[0].result_code], ['expired', 'epoch_stale']);
    const held = (await f.command('retry_diagnostics', ['A1'], { expected_roster_revision: 2 })).json; const newer = (await f.pair('A1', 2, 6)).conn.json;
    assert.equal((await f.sync(a1.credential, [], 5)).status, 401); const n = (await f.sync(newer.credential, [], 6)).json; assert.ok(!n.commands.some((x) => x.command_id === held.command.id), 'the new device does not inherit the old device\'s command');
    v = (await f.request(f.base + '/commands/' + held.command.id)).json; assert.equal(v.targets[0].result_code, 'epoch_stale');
  });
  await check('AT-20 cancel stops delivery of queued targets and says so; it does not claim to undo a started one', async () => {
    const newer = (await f.pair('A1', 2, 7)).conn.json; const c1 = (await f.command('retry_diagnostics', ['A1'], { expected_roster_revision: 2 })).json;
    const cancelled = await f.request(f.base + '/commands/' + c1.command.id, 'DELETE'); assert.equal(cancelled.json.targets[0].state, 'cancelled'); assert.equal((await f.sync(newer.credential, [], 7)).json.commands.length, 0);
    const c2 = (await f.command('retry_diagnostics', ['A1'], { expected_roster_revision: 2 })).json; const got = (await f.sync(newer.credential, [], 7)).json.commands[0]; await f.sync(newer.credential, [], 7, { receipts: [f.receipt(got, 'accepted'), ] });
    await f.sync(newer.credential, [], 7, { receipts: [f.receipt(got, 'running')] }); const late = await f.request(f.base + '/commands/' + c2.command.id, 'DELETE'); assert.equal(late.json.targets[0].state, 'running');
    assert.equal((await f.sync(newer.credential, [], 7, { receipts: [f.receipt(got, 'succeeded')] })).json.receipt_acks[0].state, 'succeeded');
  });
  await check('AT-25 command authority unknown → nothing is delivered and the observation path still answers', async () => {
    const live = f.db.prepare("SELECT id FROM ops_grants WHERE kind='connection' AND state='active' AND seat_id='A1'").get(); assert.ok(live);
    await f.command('retry_diagnostics', ['A1'], { expected_roster_revision: 2 }); f.fail('FROM ops_seat_leases');
    const cred = (await import('../src/lib/tokens.ts')).signOpsCredential; const { TEST_SECRET } = await import('./harness/index.mjs');
    const r = await f.sync(await cred(live.id, TEST_SECRET), [f.event(1, 'runtime', { status: 'idle' })], 7); f.fail('');
    assert.equal(r.status, 200); assert.deepEqual([r.json.commands, r.json.lease], [[], 'unknown']); assert.equal(r.json.ack.contiguous_seq, 1);
  });
  await check('no token, credential, argument or free text enters the command ledger', async () => {
    const dump = ['ops_commands', 'ops_command_targets', 'ops_seat_leases'].map((t) => JSON.stringify(f.db.prepare('SELECT * FROM ' + t).all())).join('\n');
    assert.ok(!dump.includes('hpsops1.')); assert.ok(!/rm -rf|passwd|stdout/.test(dump)); assert.ok(f.db.prepare("SELECT count(*) n FROM ops_commands WHERE args_json<>'{}'").get().n === 0);
  });
  await check('AT-33 slice: fresh schema.sql equals the previous schema plus migrations 0011+0012; both re-runnable and additive', async () => {
    const { DatabaseSync } = await import('node:sqlite'); const { readFileSync } = await import('node:fs');
    const shape = (d) => JSON.stringify(d.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map((r) => [r.type, r.name, (r.sql ?? '').replace(/\s+/g, ' ')]));
    const m = ['0011-classroom-ops', '0012-classroom-ops-commands'].map((n) => readFileSync(new URL(`../migrations/${n}.sql`, import.meta.url), 'utf8'));
    const upgraded = new DatabaseSync(':memory:'); upgraded.exec(readFileSync(new URL('./fixtures/schema-pre-0011.sql', import.meta.url), 'utf8')); for (const sql of [...m, ...m]) upgraded.exec(sql);
    const fresh = new DatabaseSync(':memory:'); fresh.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); assert.equal(shape(upgraded), shape(fresh));
    assert.ok(!/\b(DROP|ALTER|DELETE|UPDATE)\b/i.test(m[1].replace(/^--.*$/gm, '').replace(/ON DELETE CASCADE/g, ''))); upgraded.close(); fresh.close();
  });
  console.log(`${count} remote classroom command controls passed`);
} finally { f.close(); }
