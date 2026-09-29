// Remote classroom operations R3 (#751) — Service layer of AT-20/22/24: state-changing
// commands and "pause new runs" admission. The SDK's local tool admission, a real
// running turn and OS-level stop are the App/real-device layers and are not run here.
import assert from 'node:assert/strict';
import { localOps } from './harness/classroom-ops.mjs';
import { withMockUpstream, openAIJsonBody } from './harness/index.mjs';
import * as ops from '../src/lib/classroom-ops.ts';
let count = 0; async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const f = await localOps();
const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }];
try {
  await f.freeze(); assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true } })).status, 201);
  const a1 = (await f.pair('A1', 1, 1)).conn.json, a2 = (await f.pair('A2', 1, 2)).conn.json;
  await check('controls: the reset contract is narrow by construction', async () => {
    assert.deepEqual([ops.COMMAND_ACTIONS.reset_runtime.maxTargets, ops.COMMAND_ACTIONS.reset_runtime.mutating, ops.COMMAND_ACTIONS.reset_runtime.capability], [1, true, 'reset']);
    assert.ok(!Object.keys(ops.COMMAND_ACTIONS).some((a) => /clear|delete|wipe|reboot|history/.test(a)));
  });
  await check('AT-19/20 reset needs its own capability, takes one learner, and carries no arguments', async () => {
    assert.equal((await f.command('reset_runtime', ['A1'], {}, await f.teacher('helper', ['observe', 'command']))).json.reason, 'ops_capability_missing');
    assert.equal((await f.command('reset_runtime', ['A1', 'A2'])).status, 400);
    assert.equal((await f.command('reset_runtime', ['A1'], { args: { clear_history: true } })).json.reason, 'args_not_allowed');
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_commands').get().n, 0);
  });
  await check('AT-20 two instructors reset the same learner at once: one command is in flight, the other is told the seat is busy', async () => {
    const t2 = await f.teacher('teacher-b'); const both = await Promise.all([f.command('reset_runtime', ['A1']), f.command('reset_runtime', ['A1'], {}, t2)]);
    assert.deepEqual(both.map((r) => r.status), [202, 202]); const states = both.map((r) => [r.json.targets[0].state, r.json.targets[0].result_code]).sort();
    assert.deepEqual(states, [['queued', ''], ['rejected', 'seat_busy']]);
    // The winner runs to an unknown outcome; only then may another reset be queued. Unknown is not retried for the instructor.
    const cmd = (await f.sync(a1.credential, [], 1)).json.commands[0]; assert.equal(cmd.action, 'reset_runtime'); assert.equal(cmd.run_within_ms, 60000);
    await f.sync(a1.credential, [], 1, { receipts: [f.receipt(cmd, 'accepted')] }); await f.sync(a1.credential, [], 1, { receipts: [f.receipt(cmd, 'running')] });
    assert.equal((await f.command('cancel_current_run', ['A1'])).json.targets[0].result_code, 'seat_busy', 'a different state-changing action is held too');
    assert.equal((await f.command('retry_diagnostics', ['A1'])).json.targets[0].state, 'queued', 'read-only actions are not blocked by the mutation lease');
    await f.sync(a1.credential, [], 1, { receipts: [f.receipt(cmd, 'outcome_unknown', 'interrupted')] });
    const v = (await f.request(f.base + '/commands/' + cmd.command_id)).json; assert.deepEqual([v.targets[0].state, v.summary.unconfirmed, v.summary.all_succeeded], ['outcome_unknown', 1, false]);
    assert.equal((await f.command('reset_runtime', ['A1'])).json.targets[0].state, 'queued');
  });
  const chat = (token) => withMockUpstream(() => Response.json(openAIJsonBody({ content: '합성 응답' })), () => f.request('/v1/chat/completions', 'POST', { model: 'hypeproof-default', messages: [{ role: 'user', content: '합성 질문' }] }, token));
  const messages = (token) => withMockUpstream(() => Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: '합성' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), () => f.request('/v1/messages', 'POST', { model: 'hypeproof-default', max_tokens: 16, messages: [{ role: 'user', content: '합성 질문' }] }, token));
  const student = await f.student('student-a'); let baseline;
  await check('AT-24 positive control: before any pause both model routes admit this learner', async () => {
    baseline = [(await chat(student)).status, (await messages(student)).status]; for (const s of baseline) assert.ok(s !== 503 && s !== 401 && s !== 403, 'baseline admission ' + baseline);
  });
  await check('AT-24 pause needs the pause capability and a current revision; it says what it does not stop', async () => {
    assert.equal((await f.request(f.base + '/control', 'PUT', { paused: true, expected_control_revision: 0 }, await f.teacher('helper', ['observe', 'command']))).status, 403);
    assert.equal((await f.request(f.base + '/control', 'PUT', { paused: true, expected_control_revision: 7 })).status, 409);
    const two = await Promise.all([f.request(f.base + '/control', 'PUT', { paused: true, expected_control_revision: 0 }), f.request(f.base + '/control', 'PUT', { paused: true, expected_control_revision: 0 }, await f.teacher('teacher-b'))]);
    assert.deepEqual(two.map((r) => r.status).sort(), [200, 409]); const okr = two.find((r) => r.status === 200).json; assert.equal(okr.control_revision, 1); assert.ok(okr.not_applied_to.some((x) => /already running/.test(x)));
    assert.equal(f.db.prepare("SELECT count(*) n FROM ops_audit WHERE action='new_runs_paused'").get().n, 1);
  });
  await check('AT-24 both model routes refuse NEW requests of the paused run with a named reason; nothing else about the learner changes', async () => {
    for (const r of [await chat(student), await messages(student)]) { assert.equal(r.status, 503, r.raw); assert.equal(r.json.error.type, 'class_paused'); assert.equal(r.json.error.control_revision, 1); assert.match(r.json.error.message, /파일과 대화는 그대로/); }
    assert.equal((await f.request('/v1/profile', 'GET', undefined, student)).status, 200, 'profile and therefore local work stay available');
    assert.equal((await f.request('/v1/classroom/shares', 'GET', undefined, student)).status, 200);
    const s = (await f.sync(a1.credential, [], 1)).json; assert.deepEqual(s.control, { paused: true, control_revision: 1 });
  });
  await check('AT-24 per-device application is reported as applied / pending / unknown, not assumed', async () => {
    await f.sync(a1.credential, [], 1, { sample: { idle_ms: 1, observed_at: Date.now(), control_revision: 1 } }); await f.sync(a2.credential, [], 2, { sample: { idle_ms: 1, observed_at: Date.now(), control_revision: 0 } });
    let st = (await f.request(f.base + '/status')).json; assert.deepEqual(st.seats.map((x) => x.control_applied), ['applied', 'pending']); assert.deepEqual(st.control, { paused: true, control_revision: 1, devices: { applied: 1, pending: 1, unknown: 0 } });
    f.db.prepare("UPDATE ops_latest_state SET last_received_at=1 WHERE seat_id='A2'").run(); st = (await f.request(f.base + '/status')).json; assert.equal(st.seats[1].control_applied, 'unknown', 'an old or silent app is not counted as paused');
  });
  await check('AT-24/25 resume restores admission; a control read failure never blocks learning; other runs are untouched', async () => {
    f.fail('FROM class_run_control'); const during = await chat(student); f.fail(''); assert.equal(during.status, baseline[0], 'metadata outage does not take the chat path down');
    assert.equal((await f.request(f.base + '/control', 'PUT', { paused: false, expected_control_revision: 1 })).status, 200);
    assert.deepEqual([(await chat(student)).status, (await messages(student)).status], baseline);
    f.db.prepare("INSERT INTO class_run_control(class_run_id,cohort_id,paused,control_revision,updated_by,updated_at) VALUES('some-other-run','x',1,1,'t',1)").run(); assert.equal((await chat(student)).status, baseline[0]);
  });
  console.log(`${count} remote classroom control/reset controls passed`);
} finally { f.close(); }
{
  const off = await localOps({ enabled: false });
  try {
    off.db.prepare("INSERT INTO class_run_control(class_run_id,cohort_id,paused,control_revision,updated_by,updated_at) VALUES(?,?,1,1,'t',1)").run(off.run, off.cohort);
    const r = await withMockUpstream(() => Response.json(openAIJsonBody({ content: 'x' })), () => off.request('/v1/chat/completions', 'POST', { model: 'hypeproof-default', messages: [{ role: 'user', content: 'q' }] }, null, { authorization: 'Bearer placeholder' }).then(async () => off.request('/v1/chat/completions', 'POST', { model: 'hypeproof-default', messages: [{ role: 'user', content: 'q' }] }, await off.student('student-a'))));
    assert.notEqual(r.json?.error?.type, 'class_paused'); console.log('PASS AT-32 switch OFF: a stray control row cannot pause anything');
  } finally { off.close(); }
}
