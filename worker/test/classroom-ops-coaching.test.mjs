// #751, 2026-09-18 added criteria — Service layer of AT-35/36/37:
// recovery vs coaching authority, closed coaching arguments, evidence provenance,
// instructor review state. The learner-side display (AT-39) is the App layer.
import assert from 'node:assert/strict';
import { localOps } from './harness/classroom-ops.mjs';
import * as ops from '../src/lib/classroom-ops.ts';
let count = 0; async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const f = await localOps(); const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }];
try {
  await f.freeze(); assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true } })).status, 201);
  const a1 = (await f.pair('A1', 1, 1, ['observe', 'commands', 'retry_diagnostics', 'reset_runtime', 'send_question', 'mark_checkpoint'])).conn.json;
  await check('controls: coaching and recovery are different kinds with different capabilities; provenance defaults are conservative', async () => {
    const kinds = Object.fromEntries(Object.entries(ops.COMMAND_ACTIONS).map(([a, s]) => [a, [s.kind, s.capability]]));
    assert.deepEqual([kinds.send_question, kinds.mark_checkpoint, kinds.reset_runtime, kinds.retry_diagnostics], [['coaching', 'coach'], ['coaching', 'coach'], ['recovery', 'reset'], ['recovery', 'command']]);
    assert.ok(Object.values(ops.COMMAND_ACTIONS).filter((s) => s.kind === 'coaching').every((s) => !s.mutating));
    assert.equal(ops.validatePayload('evidence', { evidence_type: 'decision' }).value.source_state, 'unverified', 'an unstated source is never real');
    assert.equal(ops.validateEvent({ event_id: 'event-00000001', seq: 1, observed_at: 1, kind: 'runtime', actor: 'human', payload: { status: 'idle' } }).value.actor, 'student');
    for (const p of [{ evidence_type: 'decision', student_text: '내가 고른 이유' }, { evidence_type: 'score' }, { evidence_type: 'change', artifact_after: 'index.html' }, { evidence_type: 'decision', source_state: 'verified_by_ai' }]) assert.equal(ops.validatePayload('evidence', p).ok, false, JSON.stringify(p));
  });
  await check('AT-35 authority does not cross: a recovery-only instructor cannot coach, a coach-only instructor cannot reset or diagnose', async () => {
    const fixer = await f.teacher('fixer', ['observe', 'command', 'reset']), coach = await f.teacher('coach', ['observe', 'coach']);
    assert.equal((await f.command('send_question', ['A1'], { args: { text: '어떤 조건에서 확인했나요?' } }, fixer)).json.reason, 'ops_capability_missing');
    assert.equal((await f.command('reset_runtime', ['A1'], {}, coach)).json.reason, 'ops_capability_missing'); assert.equal((await f.command('retry_diagnostics', ['A1'], {}, coach)).json.reason, 'ops_capability_missing');
    // Recovery is not gated behind any coaching step: a blocked seat is diagnosed straight away.
    assert.equal((await f.command('retry_diagnostics', ['A1'], {}, fixer)).status, 202);
  });
  await check('AT-35 coaching carries a question or a pointer — not an answer, code, markup, a path or a secret', async () => {
    for (const args of [{ text: '```js\nfix()\n```' }, { text: '<button onclick=x>' }, { text: 'const a = 1;' }, { text: 'x'.repeat(301) }, { text: '' }, { text: 'ok', file: 'index.html' }, {}]) assert.equal((await f.command('send_question', ['A1'], { args })).json.reason, 'args_invalid', JSON.stringify(args));
    assert.equal((await f.command('mark_checkpoint', ['A1'], { args: { step_id: 'not-in-lesson' } })).json.reason, 'unknown_step');
    const q = await f.command('send_question', ['A1'], { args: { text: '테스트 전에 어떤 결과를 기대했나요? GITHUB_TOKEN=' + 'a'.repeat(30) } }); assert.equal(q.status, 202, q.raw);
    assert.ok(!f.db.prepare('SELECT args_json a FROM ops_commands WHERE id=?').get(q.json.command.id).a.includes('a'.repeat(30)), 'secrets are scrubbed before storage');
    assert.ok(!JSON.stringify(f.db.prepare("SELECT detail_json FROM ops_audit WHERE action='command_enqueued'").all()).includes('기대했나요'), 'the audit names the action, not the words');
    const cp = await f.command('mark_checkpoint', ['A1'], { args: { step_id: 'build', note: '기대 조건과 실제 결과를 나란히 다시 보세요' } }); assert.equal(cp.status, 202);
    const got = (await f.sync(a1.credential, [], 1)).json.commands; const sent = got.find((c) => c.action === 'send_question'); assert.match(sent.args.text, /기대했나요/); assert.deepEqual(got.find((c) => c.action === 'mark_checkpoint').args, { step_id: 'build', note: '기대 조건과 실제 결과를 나란히 다시 보세요' });
    // Only the addressed seat's device ever receives the words.
    const a2 = (await f.pair('A2', 1, 2)).conn.json; assert.ok(!(await f.sync(a2.credential, [], 2)).raw.includes('기대했나요'));
    await f.sync(a1.credential, [], 1, { receipts: [f.receipt(sent, 'accepted')] }); await f.sync(a1.credential, [], 1, { receipts: [f.receipt(sent, 'running')] }); await f.sync(a1.credential, [], 1, { receipts: [f.receipt(sent, 'succeeded', 'shown')] });
    const v = (await f.request(f.base + '/commands/' + sent.command_id)).json; assert.deepEqual([v.targets[0].state, v.targets[0].result_code], ['succeeded', 'shown']);
  });
  let ref;
  await check('AT-36 provenance: actor and source_state are kept per event, simulated never becomes real, before/after is a digest comparison', async () => {
    const h = (c) => c.repeat(64);
    await f.sync(a1.credential, [f.event(1, 'evidence', { evidence_type: 'criterion', source_state: 'self_reported', step_id: 'build' }, { actor: 'student' }), f.event(2, 'evidence', { evidence_type: 'action', source_state: 'simulated' }, { actor: 'ai' }), f.event(3, 'evidence', { evidence_type: 'change', source_state: 'real', artifact_before: h('a'), artifact_after: h('b') }, { actor: 'student' }), f.event(4, 'evidence', { evidence_type: 'decision' }, { actor: 'external_user' })], 1);
    const s = (await f.request(f.base + '/status')).json, e = s.seats[0].evidence; assert.equal(e.observed, 4); assert.deepEqual(e.by_source_state, { unverified: 1, real: 1, simulated: 1, self_reported: 1 }); assert.equal(e.unreviewed, 4);
    assert.deepEqual(e.latest.map((x) => [x.evidence_type, x.source_state, x.actor, x.changed]).sort(), [['action', 'simulated', 'ai', null], ['change', 'real', 'student', true], ['criterion', 'self_reported', 'student', null], ['decision', 'unverified', 'external_user', null]]);
    ref = e.latest.find((x) => x.evidence_type === 'change').ref;
    // AT-37: a seat with nothing observed is "0 observed", with no score, grade, rank or red flag derived from it.
    const quiet = s.seats[1]; assert.deepEqual(quiet.evidence, { observed: 0, unreviewed: 0, by_source_state: {}, latest: [] }); assert.notEqual(quiet.attention, 'blocked');
    assert.ok(!/score|rank|grade|percent|dependency/i.test(JSON.stringify(s)), 'the board carries no evaluative number');
  });
  await check('AT-36 review state is its own thing: coach capability, CAS, and it approves nothing', async () => {
    assert.equal((await f.request(f.base + '/evidence/' + ref, 'PUT', { state: 'confirmed', expected_revision: 0 }, await f.teacher('fixer', ['observe', 'command']))).status, 403);
    assert.equal((await f.request(f.base + '/evidence/' + ref, 'PUT', { state: 'approved', expected_revision: 0 })).status, 400);
    const two = await Promise.all([f.request(f.base + '/evidence/' + ref, 'PUT', { state: 'confirmed', expected_revision: 0 }), f.request(f.base + '/evidence/' + ref, 'PUT', { state: 'disputed', expected_revision: 0 }, await f.teacher('teacher-b'))]);
    assert.deepEqual(two.map((r) => r.status).sort(), [200, 409]); const okr = two.find((r) => r.status === 200).json; assert.ok(okr.does_not_mean.includes('delivery approval') && okr.does_not_mean.includes('lesson completion'));
    assert.equal((await f.request(f.base + '/evidence/' + ref, 'PUT', { state: 'disputed', expected_revision: 1 })).json.review_revision, 2);
    assert.equal((await f.request(f.base + '/evidence/' + ref.replace(/\.\d+$/, '.999'), 'PUT', { state: 'confirmed', expected_revision: 0 })).status, 404);
    const s = (await f.request(f.base + '/status')).json; assert.equal(s.seats[0].evidence.unreviewed, 3); assert.equal(s.seats[0].step, null, 'reviewing evidence does not move the learning step');
    assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE '%evidence%' AND type='table' AND name<>'ops_event_reviews' AND name NOT LIKE 'native%' AND name NOT LIKE 'usage%' AND name NOT LIKE 'trial%'").get().n, 0, 'no second evidence store was added');
  });
  await check('reviewed: an instructor may confirm only a step the LEARNER submitted; it needs the coach capability; two instructors cannot both win; a later step starts unreviewed', async () => {
    const r = await localOps(); try {
      await r.freeze(); assert.equal((await r.configure([{ seat_id: 'A1', student_id: 'student-a' }], 0, { flags: { ops_observe: true, ops_commands: true } })).status, 201);
      const cred = (await r.pair('A1', 1)).conn.json.credential, v = r.lesson.version, stepOf = async () => (await r.request(r.base + '/status')).json.seats[0].step;
      await r.sync(cred, [r.event(1, 'step', { lesson_version: v, step_id: 'build', status: 'in_progress' }, { actor: 'student' })]);
      assert.equal((await stepOf()).review, undefined, 'a step in progress offers nothing to review');
      const progressRef = r.db.prepare("SELECT grant_id||'.'||boot_id||'.'||seq AS ref FROM ops_events WHERE kind='step'").get().ref;
      assert.equal((await r.request(r.base + '/evidence/' + progressRef, 'PUT', { state: 'confirmed', expected_revision: 0 })).json.reason, 'step_not_submitted', 'the instructor cannot complete a step for the learner');
      await r.sync(cred, [r.event(2, 'step', { lesson_version: v, step_id: 'build', status: 'submitted' }, { actor: 'student' })]);
      let step = await stepOf(); assert.deepEqual([step.status, step.actor, step.review.state, step.review.revision], ['submitted', 'student', 'unreviewed', 0]);
      const observer = await r.teacher('observer-only', ['observe']); assert.equal((await r.request(r.base + '/evidence/' + step.review.ref, 'PUT', { state: 'confirmed', expected_revision: 0 }, observer)).json.reason, 'ops_capability_missing');
      const other = await r.teacher('second-coach', ['observe', 'coach']), [x, y] = await Promise.all([r.request(r.base + '/evidence/' + step.review.ref, 'PUT', { state: 'confirmed', expected_revision: 0 }), r.request(r.base + '/evidence/' + step.review.ref, 'PUT', { state: 'disputed', expected_revision: 0 }, other)]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409], 'one of two simultaneous reviews wins, the other is told to reload'); const won = x.status === 200 ? x : y; assert.deepEqual(won.json.does_not_mean, ['delivery approval', 'lesson completion', 'a grade']); assert.equal(won.json.kind, 'step');
      step = await stepOf(); assert.deepEqual([step.status, step.review.state, step.review.revision], ['submitted', won.json.review_state, 1], 'the learner-reported status is kept; the review sits next to it');
      assert.equal((await r.request(r.base + '/evidence/' + step.review.ref, 'PUT', { state: 'confirmed', expected_revision: 0 })).status, 409, 'a stale revision is refused');
      assert.equal((await r.request(r.base + '/evidence/' + step.review.ref, 'PUT', { state: 'confirmed', expected_revision: 1 })).status, 200);
      await r.sync(cred, [r.event(3, 'step', { lesson_version: v, step_id: 'review', status: 'submitted' }, { actor: 'student' })]);
      step = await stepOf(); assert.deepEqual([step.step_id, step.review.state, step.review.revision], ['review', 'unreviewed', 0], 'the next step is not reviewed by inheritance');
      assert.equal(r.db.prepare("SELECT count(*) n FROM ops_audit WHERE action LIKE 'step_%'").get().n, 2);
    } finally { r.close(); }
  });
  console.log(`${count} coaching/provenance controls passed`);
} finally { f.close(); }
