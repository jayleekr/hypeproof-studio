// #751 U3 — the REAL device inbox (extension sources: sync loop, InboxSession, InboxStore on a real directory) against the
// REAL Service routes + SQLite, in-process: a prompt and a lesson setting travel the wire the app really speaks, the hash the
// device recomputes matches, a setting survives a restart as PENDING, and the switch is made from what the device's own
// index holds. Not a Studio window and not a real model — those are the browser e2e and the Mac run.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localOps, OPS_ALL } from './harness/classroom-ops.mjs';
import { makeCtx, withMockUpstream, anthropicJsonBody, TEST_SECRET } from './harness/index.mjs';
import * as ops from '../../extensions/hypeproof-chat/src/classroomOps.ts';
import { INBOX_CAPABILITY, INBOX_PROMPT_CAPABILITY, LESSON_BINDING_CAPABILITY, boundSetting, markSettingBound, pendingSetting } from '../../extensions/hypeproof-chat/src/classroomInbox.ts';
import { InboxSession, InboxStore, inboxDir } from '../../extensions/hypeproof-chat/src/classroomInboxStore.ts';
import { planPreflight, candidateMatches, tokenLessonSha } from '../../extensions/hypeproof-chat/src/lessonBinding.ts';
const { readLesson } = await import('../src/lib/lesson-delivery.ts');
const { issue } = await import('../src/lib/tokens.ts');
let n = 0; const ok = (name) => { n++; console.log('  ✓ ' + name); };
const root = mkdtempSync(path.join(tmpdir(), 'hps-u3-device-')), f = await localOps(), KEY = () => crypto.randomUUID();
f.env.HPS_LESSON_BINDINGS = 'enforce'; f.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
try {
  const course = f.lesson.course_id, V1 = f.lesson.version, V2 = 'm2026.09.18-2';
  await f.freeze(course, V1, ['intro', 'build', 'review']);
  { const a = `/admin/cohorts/${f.cohort}/authoring/${course}`, cur = (await f.request(a)).json, step = (id) => ({ id, title: id, instructions: '합성 단계 ' + id, hint: '', acceptance: '합성 기준' });
    const saved = await f.request(a, 'PUT', { profile_id: f.profile, request_id: KEY(), expected_revision: cur.revision ?? cur.draft?.revision, content: { schema: 'hps-session-design/1', title: '합성 수업 v2', audience: '합성', duration_minutes: 60, objective: '시험', prerequisites: '없음', starter: '폴더', steps: ['intro', 'craft-v2'].map(step) } }); assert.equal(saved.status, 200, saved.raw);
    assert.equal((await f.request(`${a}/versions/${V2}`, 'PUT', { expected_revision: saved.json.revision })).status, 200); }
  const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-c' }];
  assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_distribute: true, ops_lesson_settings: true } })).status, 201);
  const sha = {}; for (const v of [V1, V2]) sha[v] = (await readLesson(f.env, f.cohort, course, v, f.profile)).sha256;
  const L = await f.teacher('teacher-l', [...OPS_ALL, 'distribute', 'lesson_settings']);
  const FULL = ['observe', INBOX_CAPABILITY, INBOX_PROMPT_CAPABILITY, LESSON_BINDING_CAPABILITY], OLD = ['observe', INBOX_CAPABILITY];
  const memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; };
  let id = 0;
  async function device(seat, no, conn, caps, seen) {
    const dir = inboxDir(root, { cohort: conn.student.c, run: conn.class_run_id, seat: conn.seat_id, student: conn.student.u }), store = new InboxStore(dir); let alive = true;
    const inbox = new InboxSession({ store, alive: () => alive, clock: { mono: () => performance.now(), wall: () => Date.now() } });
    const outbox = await ops.OpsOutbox.open(memory(), conn.grant_id, 'stream-' + seat + '-' + no + '-' + (++id), () => Date.now(), () => `event-u3-${String(++id).padStart(6, '0')}`), inst = f.instance(no, caps);
    const loop = ops.startOpsSync({ outbox, appInstanceId: inst.app_instance_id, capabilities: caps, distribution: inbox, sample: () => ({ idle_ms: 1 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() { alive = false; },
      post: async (body) => { const r = await f.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: inst.boot_id }, conn.credential); seen?.(r.json); return { status: r.status, body: r.json }; } });
    return { loop, store, dir, inst, cards: async () => (await store.read()).cards, end: () => { alive = false; loop.stop(); } };
  }
  const spin = async (dev, k = 4) => { f.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); for (let i = 0; i < k; i++) await dev.loop.tick(); };
  const connA = (await f.pair('A1', 1, 1, FULL)).conn.json, connB = (await f.pair('A2', 1, 2, FULL)).conn.json, connC = (await f.pair('A3', 1, 3, OLD)).conn.json;
  const wireC = []; let A = await device('A1', 1, connA, FULL); const Bd = await device('A2', 2, connB, FULL), C = await device('A3', 3, connC, OLD, (j) => wireC.push(JSON.stringify(j ?? {})));
  const save = (b) => f.request(f.base + '/contents', 'POST', { idempotency_key: KEY(), ...b }, L), send = (o) => f.request(f.base + '/distributions', 'POST', { idempotency_key: KEY(), expected_roster_revision: 1, ...o }, L);
  const view = async (d) => (await f.request(f.base + '/distributions/' + d, 'GET', undefined, L)).json;

  // ── prompt ──
  const pr = (await save({ kind: 'prompt', title: '조사 프롬프트', body: '이 페이지의 구조를 세 문장으로 설명해 줘.' })).json, dp = (await send({ object_id: pr.object_id, revision: 1, content_hash: pr.content_hash, targets: ['A1', 'A3'] })).json.distribution;
  await spin(A); await spin(Bd); await spin(C);
  assert.deepEqual((await A.cards()).map((c) => [c.kind, c.title, c.body, c.revision]), [['prompt', '조사 프롬프트', '이 페이지의 구조를 세 문장으로 설명해 줘.', 1]], 'the device re-hashed the item, stored it and read it back through the card path');
  assert.deepEqual(await Bd.cards(), []); assert.deepEqual(await C.cards(), []); assert.ok(wireC.every((w) => !w.includes('세 문장')), 'an app without `inbox_prompt` was never SENT the body');
  assert.deepEqual((await view(dp.id)).targets.map((t) => [t.seat_id, t.state]), [['A1', 'reflected'], ['A3', 'unsupported']]);
  ok('prompt: stored and readable on the selected, capable device; never sent to an incapable one; nothing for the unselected one');

  // ── setting: arrives as PENDING, survives a restart, is switched from the device's own index ──
  const st = (await save({ kind: 'setting', title: '2번째 판', body: '다음 질문부터 새 단계로 진행합니다.', lesson: { course_id: course, version: V2, sha256: sha[V2] } })).json, ds = (await send({ object_id: st.object_id, revision: 1, content_hash: st.content_hash, targets: ['A1', 'A3'] })).json.distribution;
  await spin(A); await spin(C);
  const card = (await A.cards()).find((c) => c.kind === 'setting'); assert.equal(card.setting, 'pending'); assert.equal(card.body, '다음 질문부터 새 단계로 진행합니다.');
  assert.ok(!readdirSync(A.dir + '/rev').some((file) => readFileSync(A.dir + '/rev/' + file, 'utf8').includes('craft-v2')), 'no lesson content is on the device: the item is a reference and a notice');
  assert.deepEqual((await view(ds.id)).targets.map((t) => [t.seat_id, t.state, t.setting.phase]), [['A1', 'reflected', 'prepared'], ['A3', 'unsupported', 'not_prepared']]);
  A.end(); A = await device('A1', 1, connA, FULL); // app restart: same directory, new session
  const pending = pendingSetting((await A.store.current()).index); assert.ok(pending, 'pending survived the restart'); assert.equal(pending.lesson.version, V2);
  const token = await issue({ u: 'student-a', c: f.cohort, p: f.profile, lesson: { course_id: course, version: V1, sha256: sha[V1] } }, 2, TEST_SECRET);
  const profile = async () => (await (await f.app.fetch(new Request('https://service.test/v1/profile', { headers: { authorization: 'Bearer ' + token.token } }), f.env, makeCtx())).json());
  const before = await profile(); assert.equal(before.lesson.version, V1);
  // exactly what ClassroomOpsHost.switchPendingSetting sends
  const sw = await f.request('/v1/classroom/ops/lesson-binding', 'POST', { app_instance_id: A.inst.app_instance_id, offer_key: pending.offer_key, distribution_id: pending.distribution_id, object_id: pending.object_id, revision: pending.revision, content_hash: pending.content_hash, base_lesson_sha256: tokenLessonSha(token.token), learner_token: token.token }, connA.credential);
  assert.equal(sw.status, 201, sw.raw);
  const result = { state: 'switched', key: sw.json.binding.key, seq: sw.json.binding.seq, object_id: pending.object_id, revision: pending.revision, content_hash: pending.content_hash, lesson: pending.lesson };
  const plan = planPreflight(before.lesson_binding, result, null); assert.equal(plan.action, 'adopt');
  const candidate = await profile(); assert.equal(candidateMatches(plan, candidate), true, 'the Service serves exactly the switched binding'); assert.equal(candidate.lesson.version, V2);
  await A.store.commit((index) => ({ next: markSettingBound(index, result), result: null }));
  assert.equal((await A.cards()).find((c) => c.kind === 'setting').setting, 'bound'); assert.deepEqual(boundSetting((await A.store.current()).index), { key: result.key, seq: 1 });
  assert.equal((await view(ds.id)).targets[0].setting.phase, 'switched', 'the device saying "bound" is not the Service saying "applied"');
  const ctx = makeCtx(), asked = await withMockUpstream(() => new Response(JSON.stringify(anthropicJsonBody({ text: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } }), async (calls) => { const r = await f.app.fetch(new Request('https://service.test/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + token.token, 'content-type': 'application/json', 'x-hps-turn-id': KEY(), 'x-hps-lesson-binding': candidate.lesson_binding.key }, body: JSON.stringify({ model: 'claude-mock', max_tokens: 32, messages: [{ role: 'user', content: '합성' }] }) }), f.env, ctx); await r.text(); await ctx.settle(); return { status: r.status, sent: calls.map((c) => c.init.body).join('') }; });
  assert.equal(asked.status, 200); assert.match(asked.sent, /craft-v2/); assert.equal((await view(ds.id)).targets[0].setting.phase, 'applied');
  ok('setting: pending on arrival, pending after a restart, switched from the device index, adopted only on the served key, applied only after a real answer');

  // ── withdrawing the setting takes the CARD down; the binding stays ──
  await f.request(`${f.base}/distributions/${ds.id}/revoke`, 'POST', { expected_row_revision: 0 }, L); await spin(A);
  assert.equal((await A.cards()).find((c) => c.object_id === st.object_id).withdrawn, true); assert.equal((await profile()).lesson.version, V2, 'the learner keeps running v2: withdrawing is not going back');
  ok('withdrawal: the notice card comes down on the device, the participant stays on the switched version');
} finally { f.close(); rmSync(root, { recursive: true, force: true }); }
console.log(`classroom-ops-lesson-settings-device: ${n} checks passed`);
