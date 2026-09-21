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
    const counted = f.db.prepare('SELECT COUNT(*) n FROM classroom_lesson_requests WHERE turn_id=?').get(id).n; assert.equal(counted, 2, 'only the two requests that were permitted have a request row');
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
    const mixed = await basis('after-rollback'); assert.deepEqual([mixed.basis, mixed.verdict], ['unknown', { allow: false, reason: 'lesson_basis_unknown', tables: true }], 'an answered request that no permitted request points at: not attributable, held — not labelled by a guess');
    f.env.HPS_LESSON_BINDINGS = 'enforce'; assert.equal((await basis('after-re-enable')).verdict.allow, false, 'turning enforcement back on does not launder the record');
    ok('2 v2 under a permitted request, then v1 with enforcement switched off: the usage ledger has an answered row no permitted request points at — held');
  } finally { f.close(); } }
// ── S9 + S10: other cohorts, a new run, and the four reissue cases — end to end, with the identity fixes above as controls ──
{ const { f, course, V1, V2, sha, token, ask } = await world();
  try {
    const { issueIssuer } = await import('../src/lib/tokens.ts');
    // a third confirmed version, so that "reissued for ANOTHER version" is distinguishable from the switched one
    const V3 = 'm2026.09.21-3', a = `/admin/cohorts/${f.cohort}/authoring/${course}`, cur = (await f.request(a)).json;
    const saved = await f.request(a, 'PUT', { profile_id: f.profile, request_id: KEY(), expected_revision: cur.revision ?? cur.draft?.revision, content: { schema: 'hps-session-design/1', title: '합성 v3', audience: '합성 사용자', duration_minutes: 60, objective: '기준 확인', prerequisites: '없음', starter: '연습', steps: ['v3-only'].map((id) => ({ id, title: id, instructions: '합성 ' + id, hint: '', acceptance: '합성 기준' })) } }); assert.equal(saved.status, 200, saved.raw);
    assert.equal((await f.request(a + '/versions/' + V3, 'PUT', { expected_revision: saved.json.revision })).status, 200); sha[V3] = (await readLesson(f.env, f.cohort, course, V3, f.profile)).sha256;
    assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }], 0, { flags: FLAGS })).status, 201);
    const L = await f.teacher('review-teacher', [...OPS_ALL, 'distribute', 'lesson_settings']);
    const save = await f.request(f.base + '/contents', 'POST', { idempotency_key: KEY(), kind: 'setting', title: '합성 전환', body: '다음 질문부터 적용', lesson: { course_id: course, version: V2, sha256: sha[V2] } }, L); assert.equal(save.status, 201, save.raw);
    // S9 — an instructor of ANOTHER cohort, a learner token and an operations credential reach nothing of this run's settings
    const stranger = (await issueIssuer({ issuer: 'other-teacher', scopes: [{ cohort: 'another-cohort-2026', profiles: [f.profile], ops: [...OPS_ALL, 'distribute', 'lesson_settings'] }] }, 2, TEST_SECRET)).token, learner = (await token('student-a')).token;
    const conn = (await f.pair('A1', 1, 1, CAPS)).conn.json;
    for (const [who, tok] of [['another cohort\'s instructor', stranger], ['a learner token', learner], ['an operations credential', conn.credential]]) for (const [path, method, body] of [['/setting-options', 'GET'], ['/contents', 'POST', { idempotency_key: KEY(), kind: 'setting', title: 't', body: 'b', base: true, object_id: save.json.object_id, expected_latest_revision: 1 }], ['/distributions', 'POST', { idempotency_key: KEY(), expected_roster_revision: 1, object_id: save.json.object_id, revision: 1, content_hash: save.json.content_hash, targets: ['A1'] }], ['/distributions', 'GET']]) {
      const r = await f.request(f.base + path, method, body, tok); assert.ok(r.status === 401 || r.status === 403, `${who} ${method} ${path}: ${r.status}`); }
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM classroom_distributions').get().n, 0); assert.equal(f.db.prepare('SELECT latest_revision r FROM classroom_content_objects WHERE object_id=?').get(save.json.object_id).r, 1, 'nothing was written by any of them');
    // the switch, honestly
    const dist = await f.request(f.base + '/distributions', 'POST', { idempotency_key: KEY(), expected_roster_revision: 1, object_id: save.json.object_id, revision: 1, content_hash: save.json.content_hash, targets: ['A1'] }, L); assert.equal(dist.status, 201, dist.raw);
    const got = await f.sync(conn.credential, [], 1), item = got.json.distribution.items[0], rc = (stage) => ({ offer_key: item.offer_key, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, seq: item.seq, stage, result_code: '', observed_at: Date.now() });
    await f.sync(conn.credential, [], 1, { distribution: { receipts: [rc('received'), rc('reflected')] } });
    const old = await token('student-a'), sw = await f.request('/v1/classroom/ops/lesson-binding', 'POST', { app_instance_id: f.instance(1).app_instance_id, boot_id: f.instance(1).boot_id, offer_key: item.offer_key, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, learner_token: old.token }, conn.credential); assert.equal(sw.status, 201, sw.raw); const K2 = sw.json.binding.key;
    const profile = async (tok) => (await f.request('/v1/profile', 'GET', undefined, tok)).json;
    assert.equal((await profile(old.token)).lesson.version, V2, 'control: switched');
    // S10 ① reissued for the SAME version: the binding keeps applying, under the same key
    const same = await token('student-a'); const p1 = await profile(same.token); assert.deepEqual([p1.lesson.version, p1.lesson_binding.key], [V2, K2]); assert.match((await ask(same.token, { key: K2 })).system, /v2-work/);
    // S10 ② reissued for ANOTHER version: that token is the newer explicit decision — it runs ITS lesson, and says why the setting is not applied
    const other = await token('student-a', V3); const p3 = await profile(other.token); assert.deepEqual([p3.lesson.version, p3.lesson_binding.not_applied, p3.lesson_binding.key], [V3, 'token_lesson_changed', B.tokenBindingKey(sha[V3])]);
    const ran3 = await ask(other.token, { key: B.tokenBindingKey(sha[V3]) }); assert.equal(ran3.status, 200); assert.match(ran3.system, /v3-only/); assert.doesNotMatch(ran3.system, /v2-work/);
    const seat = (await f.request(f.base + '/status', 'GET', undefined, L)).json.seats.find((s) => s.seat_id === 'A1'); assert.equal(seat.lesson.version, V2, 'the board speaks for the run\'s token lesson; a learner-specific reissue is visible in that learner\'s own profile');
    // S10 ③ a forged base with the genuine token — refused (review 1, here as the control of this block)
    assert.equal((await f.request('/v1/classroom/ops/lesson-binding', 'POST', { app_instance_id: f.instance(1).app_instance_id, boot_id: f.instance(1).boot_id, offer_key: item.offer_key, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: 'd'.repeat(64), learner_token: old.token, base_lesson_sha256: sha[V3] }, conn.credential)).json.recorded, false);
    // S10 ④ a turn that was running under the OLD token keeps its snapshot with that token; the new token cannot take the turn over
    const turn = KEY(); assert.equal((await ask(old.token, { turn, key: K2 })).status, 200); const cont = await ask(old.token, { turn, key: K2 }); assert.equal(cont.status, 200); assert.match(cont.system, /v2-work/);
    const taken = await ask(same.token, { turn, key: K2 }); assert.deepEqual([taken.status, taken.provider], [403, 0]); assert.match(taken.json.error.message, /\[hps:lesson_turn_mismatch\]/);
    ok('S10 reissue: same version keeps the binding; another version runs its own lesson and says token_lesson_changed; a forged base is refused; a running turn stays with the token it was admitted under');
    // S9 — a NEW run of the same cohort: the old run's binding is not this run's; back in the old run it still is
    const next = 'review-next-run', starts = new Date(Date.now() - 1000).toISOString(), ends = new Date(Date.now() + 3600000).toISOString();
    f.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES(?,?,?,?,?)').run(next, f.cohort, f.profile, starts, ends); await startSession(f.env.HPS_KV, f.cohort, { session_id: next, profile_id: f.profile, starts_at: starts, ends_at: ends });
    const pn = await profile(same.token); assert.deepEqual([pn.lesson.version, pn.lesson_binding.key], [V1, B.tokenBindingKey(sha[V1])], 'a new run starts from the token lesson'); const inNew = await ask(same.token, { key: B.tokenBindingKey(sha[V1]) }); assert.equal(inNew.status, 200); assert.doesNotMatch(inNew.system, /v2-work/);
    assert.equal((await ask(same.token, { key: K2 })).status, 403, 'the old run\'s key is refused in the new run');
    await startSession(f.env.HPS_KV, f.cohort, { session_id: f.run, profile_id: f.profile, starts_at: starts, ends_at: ends }); assert.equal((await profile(same.token)).lesson.version, V2, 'control: the binding is still the old run\'s');
    ok('S9 another cohort\'s instructor, a learner token and an operations credential reach nothing; a new run does not inherit the previous run\'s binding');
  } finally { f.close(); } }
// ── review at 5a476f7: a FAILED enforced request must not stand in for a successful request made with enforcement off ──
{ const { f, course, V1, V2, sha, token } = await world();
  try {
    assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }], 0, { flags: FLAGS })).status, 201);
    const bind = (student, seat, key) => f.db.prepare('INSERT INTO classroom_lesson_bindings(class_run_id,student_id,binding_seq,seat_id,seat_revision,binding_key,source,distribution_id,object_id,revision,content_hash,course_id,version,lesson_sha256,base_lesson_sha256,steps_json,activated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(f.run, student, 1, seat, 1, key, 'setting', 'review-dist-' + student, 'review-obj', 1, 'a'.repeat(64), course, V2, sha[V2], sha[V1], '[]', Date.now() - 2000);
    const KA = 'b'.repeat(32), KB = 'c'.repeat(32); bind('student-a', 'A1', KA); bind('student-b', 'A2', KB); const ta = (await token('student-a')).token, tb = (await token('student-b')).token;
    /** One real request through the route; `answer` scripts the provider: ok · a 500 · a stream that is cut before its end marker. */
    async function call(tok, { key, turn = KEY(), answer = 'ok', path = '/v1/messages' } = {}) { const ctx = makeCtx();
      const sse = (events) => new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      const cut = () => sse([['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-mock', content: [], usage: { input_tokens: 5, output_tokens: 0 } } }], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '끊긴' } }]]);
      return withMockUpstream(() => answer === 'ok' ? Response.json(anthropicJsonBody({ text: '합성 응답' })) : answer === 'cut' ? cut() : Response.json({ error: { type: 'api_error', message: 'synthetic injected failure' } }, { status: 500 }), async (calls) => {
        const r = await f.app.fetch(new Request('https://service.test' + path, { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', ...(turn ? { 'x-hps-turn-id': turn } : {}), ...(key ? { 'x-hps-lesson-binding': key } : {}) }, body: JSON.stringify({ model: 'claude-mock', max_tokens: 128, ...(answer === 'cut' ? { stream: true } : {}), messages: [{ role: 'user', content: '합성 질문' }] }) }), f.env, ctx);
        await r.text(); await ctx.settle(); return { status: r.status, provider: calls.length, system: calls.map((c) => JSON.stringify(JSON.parse(c.init.body).system)).join('\n') }; }); }
    const basis = async (student, batch) => { const i = { class_run_id: f.run, student_id: student, batch_id: batch, revision: 1, now: Date.now() }; await sealBasisStatement(f.env.HPS_DB, i).run(); return [f.db.prepare('SELECT basis b FROM classroom_input_basis WHERE batch_id=?').get(batch).b, (await inputBasisVerdict(f.env.HPS_DB, { ...i, snapshot_revision: 1 })).allow]; };
    const requests = (student) => f.db.prepare('SELECT turn_id,lesson_sha256 s,usage_row_id u FROM classroom_lesson_requests WHERE student_id=? ORDER BY permitted_at,request_id').all(student).map((r) => ({ ...r }));
    const usage = (student) => f.db.prepare('SELECT id,status FROM usage_log WHERE user_id=? ORDER BY id').all(student).map((r) => ({ ...r }));

    // positive control — everything a single-basis class really contains: a success, a multi-request turn, a provider error,
    // a cut stream, a retry of the failed question under a new request, and a request without a turn id. All v2. All attributed.
    assert.match((await call(ta, { key: KA })).system, /v2-work/);
    const multi = KEY(); for (let k = 0; k < 3; k++) assert.equal((await call(ta, { key: KA, turn: multi })).status, 200);
    assert.ok((await call(ta, { key: KA, answer: 'fail' })).status >= 400); assert.equal((await call(ta, { key: KA, answer: 'cut' })).provider, 1); assert.equal((await call(ta, { key: KA })).status, 200, 'the learner asks again');
    assert.equal((await call(ta, { key: KA, turn: null })).status, 200, 'a request without a turn id still runs under the binding in force');
    const ra = requests('student-a'), ua = usage('student-a'); assert.equal(ra.length, 8); assert.ok(ra.every((r) => r.s === sha[V2]), 'every permitted request names v2 — the failed, the cut and the turn-less one as well');
    assert.deepEqual(ra.map((r) => r.u).sort((x, y) => x - y), ua.map((r) => r.id), 'every usage row — 200, 500 and the cut stream alike — is pointed at by exactly the request that produced it');
    assert.deepEqual(await basis('student-a', 'a-single'), ['single', true], 'a real single-basis record with failures, a cut stream, a retry and a multi-request turn is NOT held');

    // an answered usage row that is NOT a lesson execution (the opt-in observation assessment writes one for the same learner and
    // run): identified as such under enforcement, it is neither a basis nor "cannot attribute" — without that note it would hold
    const { persistUsage } = await import('../src/lib/analytics.ts'), assessLog = { cohort_id: f.cohort, user_id: 'student-a', profile_id: f.profile, model: 'm', status: 200, error_kind: null, tokens_in: 1, tokens_out: 1, cache_read: 0, cache_create: 0, latency_ms: 1, module_version: 'v', session_id: f.run };
    await persistUsage(f.env, assessLog, { class_run_id: f.run, student_id: 'student-a', request_id: 'observation:' + KEY(), non_lesson: true }); assert.deepEqual(await basis('student-a', 'a-with-assessment'), ['single', true], 'an identified assessment call does not hold a single-basis record');
    { const wrongNoNote = async () => { await persistUsage(f.env, assessLog, null); const r = await basis('student-a', 'a-assessment-unnoted'); f.db.prepare("DELETE FROM usage_log WHERE id=(SELECT MAX(id) FROM usage_log)").run(); return r; }; assert.deepEqual(await wrongNoNote(), ['unknown', false], 'negative control: the same row WITHOUT the note is unattributable'); }

    // the defect: v2 success → v2 provider FAILURE → enforcement off → v1 success. Permitted 2, answered 2 — and two different lessons ran.
    assert.match((await call(tb, { key: KB })).system, /v2-work/); assert.deepEqual(await basis('student-b', 'b-before'), ['single', true], 'control: v2 only');
    assert.ok((await call(tb, { key: KB, answer: 'fail' })).status >= 400);
    f.env.HPS_LESSON_BINDINGS = undefined; const off = await call(tb, { key: KB }); f.env.HPS_LESSON_BINDINGS = 'enforce'; assert.equal(off.status, 200); assert.match(off.system, /build/); assert.doesNotMatch(off.system, /v2-work/);
    assert.deepEqual(usage('student-b').map((r) => r.status), [200, 500, 200]); assert.equal(requests('student-b').length, 2, 'permitted requests 2 = answered usage rows 2: the totals that used to "match"');
    const wrong = (permitted, answered) => answered <= permitted; /* negative control: the counting rule of 5a476f7 */ assert.equal(wrong(2, 2), true, 'the control calls this single');
    assert.deepEqual(await basis('student-b', 'b-masked'), ['unknown', false], 'by identity: the second answered usage row is pointed at by no permitted request — held');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM usage_log u WHERE u.user_id='student-b' AND u.status BETWEEN 200 AND 299 AND u.id NOT IN (SELECT usage_row_id FROM classroom_lesson_requests WHERE student_id='student-b' AND usage_row_id IS NOT NULL)").get().n, 1, 'exactly the v1 request');

    // a lost link (the usage row was stored, the note was not) is "cannot attribute" as well — never "fine"
    f.db.prepare("UPDATE classroom_lesson_requests SET usage_row_id=NULL WHERE student_id='student-a' AND request_id=(SELECT request_id FROM classroom_lesson_requests WHERE student_id='student-a' AND usage_row_id=(SELECT MIN(id) FROM usage_log WHERE user_id='student-a' AND status=200))").run();
    assert.deepEqual(await basis('student-a', 'a-lost-link'), ['unknown', false]); 
    // a usage row stored AFTER the seal for a request made before it: the sealed `single` does not outlive it — at the model-input
    // boundary (the verdict) and in the predicate the commit statements carry
    f.db.prepare("DELETE FROM usage_log WHERE user_id='student-a' AND id NOT IN (SELECT usage_row_id FROM classroom_lesson_requests WHERE student_id='student-a' AND usage_row_id IS NOT NULL)").run();
    assert.deepEqual(await basis('student-a', 'a-sealed-early'), ['single', true]); const { basisAllows } = await import('../src/lib/lesson-basis.ts');
    const commitOk = () => f.db.prepare(`SELECT ${basisAllows('j')} AS ok FROM (SELECT 'a-sealed-early' AS batch_id,'student-a' AS student_id,1 AS snapshot_revision,? AS class_run_id) j`).get(f.run).ok; assert.equal(commitOk(), 1);
    f.db.prepare("INSERT INTO usage_log(session_id,cohort_id,user_id,profile_id,model,status) VALUES(?,?,?,?,?,200)").run(f.run, f.cohort, 'student-a', f.profile, 'm');
    assert.equal((await inputBasisVerdict(f.env.HPS_DB, { class_run_id: f.run, student_id: 'student-a', batch_id: 'a-sealed-early', snapshot_revision: 1 })).allow, false, 'read again at the boundary: held'); assert.equal(commitOk(), 0, 'and the commit predicate says the same');
    assert.equal(f.db.prepare("SELECT basis b FROM classroom_input_basis WHERE batch_id='a-single'").get().b, 'single', 'an input sealed earlier keeps its own row; the verdict of each input is read at each boundary');
    ok('failure mask: a failed enforced request no longer covers a successful request made with enforcement off — requests are joined to usage rows by identity; failures, cut streams, retries, multi-request and turn-less requests stay single; a lost link and a late usage row are held');
  } finally { f.close(); } }
console.log(`\n${n} passed`);
