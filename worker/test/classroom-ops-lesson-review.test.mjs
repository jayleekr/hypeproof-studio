// #751 U3 — the six Service defects an independent review reproduced at a92301d, as regressions through the REAL routes
// (teacher and device HTTP routes, SQLite, the token verifier, a recording provider). Every negative has its positive control
// beside it, and the observed values are asserted, not only the exit code. Synthetic accounts; no model, no production.
//   1 a base lesson hash the device merely CLAIMS must not decide where a setting applies
//   2 a record made under v2, then under v1 after enforcement was switched off, is not a single basis
//   3 a new learner in a re-assigned seat must not be answered with the previous learner's switch
//   4 a turn is looked up and closed where it was admitted — a run rollover is not "never started"
//   5 a close that lands between the gate's read and the provider call stops the call
//   6 one request in the very second of the switch is a single basis
import assert from 'node:assert/strict';
import { localOps, OPS_ALL } from './harness/classroom-ops.mjs';
import { makeCtx, withMockUpstream, anthropicJsonBody, TEST_SECRET } from './harness/index.mjs';
const B = await import('../src/lib/lesson-binding.ts');
const S = await import('../src/lib/lesson-binding-store.ts');
const { readLesson } = await import('../src/lib/lesson-delivery.ts');
const { issue, verify } = await import('../src/lib/tokens.ts');
const { startSession, revokeToken, setRoster } = await import('../src/lib/kv.ts');
const { sealBasisStatement, inputBasisVerdict } = await import('../src/lib/lesson-basis.ts');
let n = 0; const ok = (name) => { n++; console.log('PASS ' + name); };
const KEY = () => crypto.randomUUID(), CAPS = ['observe', 'commands', 'distribution_inbox', 'inbox_prompt', 'lesson_binding'];
const FLAGS = { ops_observe: true, ops_commands: true, ops_distribute: true, ops_lesson_settings: true };

async function world() {
  const f = await localOps(); f.env.HPS_LESSON_BINDINGS = 'enforce'; f.env.ANTHROPIC_API_KEY = 'synthetic-key';
  await setRoster(f.env.HPS_KV, f.cohort, ['a', 'b', 'c', 'd'].map((x) => 'student-' + x)); await f.freeze(); const course = f.lesson.course_id, V1 = f.lesson.version, V2 = 'm2026.09.21-2', a = `/admin/cohorts/${f.cohort}/authoring/${course}`, cur = (await f.request(a)).json;
  const content = { schema: 'hps-session-design/1', title: '합성 v2', audience: '합성 사용자', duration_minutes: 60, objective: '기준 확인', prerequisites: '없음', starter: '연습', steps: ['v2-begin', 'v2-work', 'v2-finish'].map((id) => ({ id, title: id, instructions: '합성 ' + id, hint: '', acceptance: '합성 기준' })) };
  const saved = await f.request(a, 'PUT', { profile_id: f.profile, request_id: KEY(), expected_revision: cur.revision ?? cur.draft?.revision, content }); assert.equal(saved.status, 200, saved.raw);
  assert.equal((await f.request(a + '/versions/' + V2, 'PUT', { expected_revision: saved.json.revision })).status, 200);
  const sha = { [V1]: (await readLesson(f.env, f.cohort, course, V1, f.profile)).sha256, [V2]: (await readLesson(f.env, f.cohort, course, V2, f.profile)).sha256 };
  const token = async (u, v = V1, hours = 2) => (await issue({ u, c: f.cohort, p: f.profile, lesson: { course_id: course, version: v, sha256: sha[v] } }, hours, TEST_SECRET));
  async function ask(tok, { turn = KEY(), key, onProvider } = {}) { const ctx = makeCtx();
    return withMockUpstream(() => { onProvider?.(); return Response.json(anthropicJsonBody({ text: '합성 응답' })); }, async (calls) => {
      const r = await f.app.fetch(new Request('https://service.test/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', 'x-hps-turn-id': turn, ...(key ? { 'x-hps-lesson-binding': key } : {}) }, body: JSON.stringify({ model: 'claude-mock', max_tokens: 128, messages: [{ role: 'user', content: '합성 질문' }] }) }), f.env, ctx);
      const text = await r.text(); await ctx.settle(); let json; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, provider: calls.length, system: calls.map((c) => JSON.stringify(JSON.parse(c.init.body).system)).join('\n') }; }); }
  return { f, course, V1, V2, sha, token, ask };
}

// ── 1 + 3: the switch — whose lesson it starts from, and whom a replay may answer ────────────────────────────────────
{ const { f, course, V1, V2, sha, token, ask } = await world();
  try {
    assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-d' }], 0, { flags: FLAGS })).status, 201);
    const L = await f.teacher('review-teacher', [...OPS_ALL, 'distribute', 'lesson_settings']);
    const save = await f.request(f.base + '/contents', 'POST', { idempotency_key: KEY(), kind: 'setting', title: '합성 전환', body: '다음 질문부터 적용', lesson: { course_id: course, version: V2, sha256: sha[V2] } }, L); assert.equal(save.status, 201, save.raw);
    const dist = await f.request(f.base + '/distributions', 'POST', { idempotency_key: KEY(), expected_roster_revision: 1, object_id: save.json.object_id, revision: 1, content_hash: save.json.content_hash, targets: ['A1', 'A2', 'A3'] }, L); assert.equal(dist.status, 201, dist.raw);
    const peer = {}; for (const [no, seat] of [[1, 'A1'], [2, 'A2'], [3, 'A3']]) { const conn = (await f.pair(seat, 1, no, CAPS)).conn.json, got = await f.sync(conn.credential, [], no), item = got.json.distribution?.items?.[0]; assert.ok(item, got.raw);
      const rc = (stage) => ({ offer_key: item.offer_key, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, seq: item.seq, stage, result_code: '', observed_at: Date.now() });
      assert.ok((await f.sync(conn.credential, [], no, { distribution: { receipts: [rc('received'), rc('reflected')] } })).json.distribution.receipt_acks.every((x) => x.recorded));
      peer[seat] = { conn, req: { app_instance_id: f.instance(no).app_instance_id, boot_id: f.instance(no).boot_id, offer_key: item.offer_key, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash } }; }
    const activate = (p, body) => f.request('/v1/classroom/ops/lesson-binding', 'POST', { ...p.req, ...body }, p.conn.credential);
    const count = (student) => f.db.prepare('SELECT COUNT(*) n FROM classroom_lesson_bindings WHERE class_run_id=? AND student_id=?').get(f.run, student).n;
    const ta = (await token('student-a')).token, tb = (await token('student-b')).token, td = await token('student-d');

    // positive control: the genuine token (with or without the optional hash) switches; the lost answer of the SAME learner is replayed
    const first = await activate(peer.A1, { learner_token: ta, base_lesson_sha256: sha[V1] }); assert.equal(first.status, 201, first.raw); assert.equal(first.json.recorded, true);
    const again = await activate(peer.A1, { learner_token: ta }); assert.deepEqual([again.status, again.json.replayed, again.json.binding.key], [200, true, first.json.binding.key]);
    assert.equal((await f.request('/v1/profile', 'GET', undefined, ta)).json.lesson.version, V2); assert.match((await ask(ta, { key: first.json.binding.key })).system, /v2-work/);
    ok('control: a genuine learner token switches, the profile and the provider request are v2, and the same learner\'s lost answer is replayed');

    // 1 — the same GENUINE token with a tampered claim: refused before anything is recorded (it used to record a row that never applied)
    const before = count('student-b');
    for (const [body, reason] of [[{ learner_token: tb, base_lesson_sha256: 'f'.repeat(64) }, 'base_mismatch'], [{ base_lesson_sha256: sha[V1] }, 'learner_token_required'], [{ learner_token: ta }, 'learner_token_mismatch'],
      [{ learner_token: tb.slice(0, -4) + 'AAAA' }, 'learner_token_invalid'], [{ learner_token: (await issue({ u: 'student-b', c: f.cohort, p: f.profile }, 2, TEST_SECRET)).token }, 'learner_token_lesson'],
      [{ learner_token: (await issue({ u: 'student-b', c: f.cohort, p: f.profile, lesson: { course_id: 'another-course', version: V1, sha256: sha[V1] } }, 2, TEST_SECRET)).token }, 'learner_token_lesson']]) {
      const r = await activate(peer.A2, body); assert.deepEqual([r.json.recorded, r.json.reason], [false, reason], r.raw); assert.equal(count('student-b'), before, reason + ': nothing recorded'); }
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ops_audit WHERE action='lesson_binding_switched' AND seat_id='A2'").get().n, 0);
    const still = await ask(tb, { key: B.tokenBindingKey(sha[V1]) }); assert.equal(still.status, 200); assert.match(still.system, /build/); assert.doesNotMatch(still.system, /v2-work/, 'the refused switch left the learner on v1 — and the instructor sees "prepared", not "switched"');
    const good = await activate(peer.A2, { learner_token: tb }); assert.equal(good.status, 201, good.raw); assert.match((await ask(tb, { key: good.json.binding.key })).system, /v2-work/, 'the same learner, asking honestly, is switched');
    // a revoked token is not a basis either; a REISSUED token of the same learner is
    await revokeToken(f.env.HPS_KV, td.jti, { reason: 'review', by: 'test' }, 3600);
    const revoked = await activate(peer.A3, { learner_token: td.token }); const reissued = (await token('student-d')).token;
    if (revoked.json.recorded) assert.fail('a revoked learner token must not switch: ' + revoked.raw); assert.equal(count('student-d'), 0);
    const fresh = await activate(peer.A3, { learner_token: reissued }); assert.equal(fresh.status, 201, fresh.raw); assert.equal((await f.request('/v1/profile', 'GET', undefined, reissued)).json.lesson.version, V2, 'a genuine reissue is not blocked');
    assert.ok(!JSON.stringify(f.db.prepare('SELECT detail_json FROM ops_audit').all()).includes(tb.slice(0, 24)), 'no token in the audit trail');
    ok('1 a claimed base hash decides nothing: tampered, missing, another learner\'s, forged, lesson-less, other-course and revoked tokens record nothing; honest and reissued tokens switch');

    // 3 — the seat is re-assigned; the new learner presents the PREVIOUS learner's offer with their own credential and token
    assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'student-c' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-d' }], 1, { flags: FLAGS })).status, 200);
    const rePair = (await f.pair('A1', 2, 4, CAPS)).conn.json, tc = (await token('student-c')).token;
    const replay = await f.request('/v1/classroom/ops/lesson-binding', 'POST', { ...peer.A1.req, app_instance_id: f.instance(4).app_instance_id, boot_id: f.instance(4).boot_id, learner_token: tc }, rePair.credential);
    assert.notEqual(replay.json.recorded, true, replay.raw); assert.equal(replay.json.binding, undefined, 'the previous learner\'s key is not handed over'); assert.equal(count('student-c'), 0);
    assert.equal((await f.request('/v1/profile', 'GET', undefined, tc)).json.lesson.version, V1, 'the new learner runs the run\'s lesson');
    // content mismatch on a replay of one's own row is not a replay
    const wrong = await activate(peer.A2, { learner_token: tb, content_hash: 'e'.repeat(64) }); assert.notEqual(wrong.json.replayed, true, wrong.raw);
    const mine = await activate(peer.A2, { learner_token: tb }); assert.deepEqual([mine.status, mine.json.replayed], [200, true], 'control: the same learner, same offer, same content — replayed');
    ok('3 a replay answers only the same run, learner, seat revision and content; the new holder of the seat gets nothing of the previous one');
  } finally { f.close(); } }

// ── 4 + 5: where a turn lives, and the last check before the provider ─────────────────────────────────────────────────
{ const { f, V1, sha, token, ask } = await world();
  try {
    assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'student-a' }], 0, { flags: FLAGS })).status, 201);
    const grant = await token('student-a'), tok = grant.token, payload = await verify(tok, TEST_SECRET), K1 = B.tokenBindingKey(sha[V1]);
    const state = async (id, t = tok) => (await f.request('/v1/lesson-turns/' + id, 'GET', undefined, t)).json.state;
    const closeRoute = (id, t = tok) => f.request('/v1/lesson-turns/' + id + '/close', 'POST', { outcome: 'completed' }, t);
    // controls
    const never = KEY(); assert.equal(await state(never), 'not_started', 'control: a turn the Service never saw IS "not started" (the input may be restored)');
    const ran = KEY(); assert.equal((await ask(tok, { turn: ran, key: K1 })).status, 200); assert.equal(await state(ran), 'completed');
    const held = KEY(), row = (await S.resolveEffectiveLesson(f.env, payload, { classRunId: f.run, lessonCohort: f.cohort, mode: 'turn', turnId: held, expectKey: K1, now: Date.now() })).turn;
    assert.deepEqual(await S.recordDispatch(f.env, row, { request: KEY(), runtime: 'agent-sdk', model: 'm', now: Date.now() }), { ok: true }); assert.equal(await state(held), 'dispatched');
    // 4 — only the cohort's ACTIVE run changes
    const next = 'review-next-run', starts = new Date(Date.now() - 1000).toISOString(), ends = new Date(Date.now() + 3600000).toISOString();
    f.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES(?,?,?,?,?)').run(next, f.cohort, f.profile, starts, ends); await startSession(f.env.HPS_KV, f.cohort, { session_id: next, profile_id: f.profile, starts_at: starts, ends_at: ends });
    assert.equal(await state(held), 'dispatched', 'a rollover does not turn an executed turn into "not started"'); assert.equal(await state(ran), 'completed'); assert.equal(await state(never), 'not_started', 'control: still true for a turn nobody admitted anywhere');
    const closed = await closeRoute(held); assert.deepEqual([closed.status, closed.json.closed, closed.json.reason], [200, true, 'closed']);
    assert.equal(f.db.prepare('SELECT close_outcome o FROM classroom_lesson_turns WHERE turn_id=?').get(held).o, 'completed', 'the ORIGINAL row was closed, in the run it was admitted in');
    // another token of the same learner (a reissue) and another learner are told nothing
    const reissued = (await token('student-a')).token, other = (await token('student-b')).token;
    assert.equal(await state(held, reissued), 'unknown', 'a reissued token is not told about a turn of the previous token — and is not told "not started" either');
    assert.equal(await state(held, other), 'not_started', 'another learner has no such turn'); assert.equal((await closeRoute(ran, reissued)).json.closed, false); assert.equal(f.db.prepare('SELECT closed_at c FROM classroom_lesson_turns WHERE turn_id=?').get(ran).c, null);
    f.fail('classroom_lesson_turns'); assert.equal(await state(held), 'unknown', 'an unreadable ledger is "unknown"'); f.fail('');
    ok('4 a turn is read and closed where it was admitted: executed stays executed across a rollover, never-seen stays not_started, other tokens and failures are unknown');

    // 5 — back in the first run: open → 200; closed before the request → 403; closed BETWEEN the gate's read and the provider call → 403, provider not called
    await startSession(f.env.HPS_KV, f.cohort, { session_id: f.run, profile_id: f.profile, starts_at: starts, ends_at: ends });
    const id = KEY(); assert.deepEqual([(await ask(tok, { turn: id, key: K1 })).status, (await ask(tok, { turn: id, key: K1 })).provider], [200, 1], 'control: later requests of an open turn run');
    const shut = KEY(); await ask(tok, { turn: shut, key: K1 }); await closeRoute(shut); const late = await ask(tok, { turn: shut, key: K1 }); assert.deepEqual([late.status, late.provider], [403, 0], 'control: closed before the request');
    const db = f.env.HPS_DB, batch = db.batch.bind(db); let armed = true, injected = 0;
    db.batch = async (stmts) => { const r = await batch(stmts); if (armed && stmts.length === 2 && r[0]?.results?.[0]?.turn_id === id && r[0].results[0].closed_at === null) { armed = false; assert.equal(await S.closeTurn(f.env, payload, { turnId: id, outcome: 'completed', now: Date.now() }), 'closed'); injected++; } return r; };
    let closedAtProvider = 'not called'; const raced = await ask(tok, { turn: id, key: K1, onProvider: () => { closedAtProvider = f.db.prepare('SELECT closed_at c FROM classroom_lesson_turns WHERE turn_id=?').get(id).c; } }); db.batch = batch;
    assert.equal(injected, 1, 'the close really landed between the read and the dispatch'); assert.deepEqual([raced.status, raced.provider, closedAtProvider], [403, 0, 'not called']); assert.match(raced.json.error.message, /\[hps:lesson_turn_closed\]/);
    const counted = f.db.prepare('SELECT requests r FROM classroom_lesson_turns WHERE turn_id=?').get(id).r; assert.equal(counted, 2, 'only the two requests that were permitted are on the turn row');
    ok('5 the dispatch permission is the last database check of EVERY request: a close that lands after the gate\'s read stops the provider call and is not counted');
  } finally { f.close(); } }

// ── 2 + 6: what a record was really made under ────────────────────────────────────────────────────────────────────────
for (const sameSecond of [false, true]) { const { f, course, V1, V2, sha, token, ask } = await world();
  try {
    assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'student-a' }], 0, { flags: FLAGS })).status, 201);
    const tok = (await token('student-a')).token, key = 'b'.repeat(32), at = Date.now() - (sameSecond ? 0 : 2000);
    f.db.prepare('INSERT INTO classroom_lesson_bindings(class_run_id,student_id,binding_seq,seat_id,seat_revision,binding_key,source,distribution_id,object_id,revision,content_hash,course_id,version,lesson_sha256,base_lesson_sha256,steps_json,activated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(f.run, 'student-a', 1, 'A1', 1, key, 'setting', 'review-dist', 'review-obj', 1, 'a'.repeat(64), course, V2, sha[V2], sha[V1], '[]', at);
    const basis = async (batch) => { const i = { class_run_id: f.run, student_id: 'student-a', batch_id: batch, revision: 1, now: Date.now() }; await sealBasisStatement(f.env.HPS_DB, i).run(); return { basis: f.db.prepare('SELECT basis b FROM classroom_input_basis WHERE batch_id=?').get(batch).b, verdict: await inputBasisVerdict(f.env.HPS_DB, { ...i, snapshot_revision: 1 }) }; };
    assert.match((await ask(tok, { key })).system, /v2-work/);
    const single = await basis('single'); assert.deepEqual([single.basis, single.verdict.allow], ['single', true], (sameSecond ? '6 the request and the switch share a second: ' : 'control: ') + 'one v2 request is a single basis');
    if (sameSecond) { ok('6 one request in the very second of the switch is a single basis — no clock is compared'); continue; }
    f.env.HPS_LESSON_BINDINGS = undefined; const rolled = await ask(tok, { key }); assert.equal(rolled.status, 200); assert.match(rolled.system, /build/); assert.doesNotMatch(rolled.system, /v2-work/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM usage_log WHERE session_id=? AND user_id='student-a'").get(f.run).n, 2, 'both requests are in the usage ledger');
    const mixed = await basis('after-rollback'); assert.deepEqual([mixed.basis, mixed.verdict], ['mixed', { allow: false, reason: 'mixed_lesson_basis', tables: true }]);
    f.env.HPS_LESSON_BINDINGS = 'enforce'; assert.equal((await basis('after-re-enable')).verdict.allow, false, 'turning enforcement back on does not launder the record');
    ok('2 v2 under an admitted turn, then v1 with enforcement switched off: the usage ledger has a request no turn accounts for — mixed, held');
  } finally { f.close(); } }
console.log(`\n${n} passed`);
