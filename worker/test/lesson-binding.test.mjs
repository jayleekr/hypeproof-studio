// #751 U3 — the learning path of targeted lesson settings: one resolver for the chat gate and /v1/profile, Service-admitted
// turns, execution evidence at the provider boundary. Real routing + real token verifier + SQLite; the provider is a recorder.
// Contract: docs/requirements/classroom-admin.md#remote-management-u3-20260921 · plan: docs/testing/classroom-admin.md (AT-46).
//
// Every scenario runs its positive control first. Negative controls put the FIRST design's decision (kept here as a pure
// function, or reproduced by a configuration that behaves like it) under the same assertion and require it to fail.
import assert from 'node:assert/strict';
import { localOps } from './harness/classroom-ops.mjs';
import { makeCtx, withMockUpstream, anthropicJsonBody, sseResponse, TEST_SECRET } from './harness/index.mjs';
const B = await import('../src/lib/lesson-binding.ts');
const store = await import('../src/lib/lesson-binding-store.ts');
const { readLesson } = await import('../src/lib/lesson-delivery.ts');
const { issue } = await import('../src/lib/tokens.ts');
let passed = 0; const ok = (name) => { passed++; console.log('PASS ' + name); };

// ── pure contract ────────────────────────────────────────────────────────────
{
  const token = { course_id: 'c', version: 'v1', sha256: 'a'.repeat(64) };
  const row = (o = {}) => ({ class_run_id: 'r', student_id: 's', binding_seq: 1, seat_id: 'A1', seat_revision: 1, binding_key: 'b'.repeat(32), source: 'setting', distribution_id: 'd', object_id: 'o', revision: 1, course_id: 'c', version: 'v2', lesson_sha256: 'c'.repeat(64), base_lesson_sha256: token.sha256, steps_json: '["s1","s4"]', activated_at: 1, first_dispatched_at: null, first_completed_at: null, last_failure_kind: '', last_failure_at: null, seat_live: 1, ...o });
  assert.equal(B.applicableBinding(null, token).key, B.tokenBindingKey(token.sha256));
  const e = B.applicableBinding(row(), token); assert.equal(e.source, 'setting'); assert.equal(e.version, 'v2'); assert.deepEqual(e.steps, ['s1', 's4']); assert.equal(e.token_equivalent, false);
  for (const [o, why] of [[{ seat_live: 0 }, 'seat_replaced'], [{ base_lesson_sha256: 'd'.repeat(64) }, 'token_lesson_changed'], [{ course_id: 'other' }, 'course_mismatch']]) { const x = B.applicableBinding(row(o), token); assert.equal(x.source, 'token'); assert.equal(x.not_applied, why); assert.equal(x.key, B.tokenBindingKey(token.sha256)); }
  const back = B.applicableBinding(row({ source: 'base', binding_seq: 2, binding_key: 'e'.repeat(32) }), token); assert.equal(back.source, 'base'); assert.equal(back.lesson_sha256, token.sha256); assert.equal(back.token_equivalent, true); assert.equal(back.key, 'e'.repeat(32));
  // a new turn is admitted under the CURRENT binding only
  assert.deepEqual(B.decideNewTurn(e, { expectKey: e.key, turnId: 't' }), { ok: true, pin: true });
  assert.deepEqual(B.decideNewTurn(e, { expectKey: B.tokenBindingKey(token.sha256), turnId: 't' }), { ok: false, code: 'lesson_binding_changed' });
  assert.deepEqual(B.decideNewTurn(e, { expectKey: undefined, turnId: 't' }), { ok: false, code: 'lesson_binding_app_unsupported' });
  assert.deepEqual(B.decideNewTurn(back, { expectKey: undefined, turnId: undefined }), { ok: true, pin: false });
  // an admitted turn keeps its snapshot however many bindings follow; closed is closed; the TTL only bounds an UNCLOSED turn
  const turn = { token_jti: 'j', binding_key: 'k1', admitted_at: 0, closed_at: null };
  assert.deepEqual(B.decideAdmittedTurn(turn, { tokenIdentity: 'j', expectKey: 'k1', currentKey: 'k3', now: 29 * 60_000 }), { ok: true });
  assert.equal(B.decideAdmittedTurn(turn, { tokenIdentity: 'j', expectKey: 'k1', currentKey: 'k3', now: 31 * 60_000 }).code, 'lesson_turn_expired');
  assert.deepEqual(B.decideAdmittedTurn(turn, { tokenIdentity: 'j', expectKey: 'k1', currentKey: 'k1', now: 31 * 60_000 }), { ok: true });
  assert.equal(B.decideAdmittedTurn({ ...turn, closed_at: 5 }, { tokenIdentity: 'j', expectKey: 'k1', currentKey: 'k1', now: 6 }).code, 'lesson_turn_closed');
  assert.equal(B.decideAdmittedTurn(turn, { tokenIdentity: 'other', expectKey: 'k1', currentKey: 'k1', now: 1 }).code, 'lesson_turn_mismatch');
  // NEGATIVE CONTROL — the first design ("current or previous key within ten minutes") under the same two assertions.
  const firstDesign = (header, keys, sinceSwitchMs) => header === keys.current || (header === keys.previous && sinceSwitchMs <= 600_000);
  assert.equal(firstDesign('k1', { current: 'k3', previous: 'k2' }, 1000), false, 'first design breaks a v1 turn once v2 then v3 are committed — the defect the row-based rule removes');
  assert.equal(firstDesign('k1', { current: 'k2', previous: 'k1' }, 1000), true, 'first design lets a NEW turn keep the old key — the second defect');
  // evidence comes from the protocol, not from "2xx and a body"
  const f = (o) => B.classifyOutcome({ upstreamStatus: 200, protocolComplete: true, streamError: false, outputTokens: 5, recordedStatus: 200, ...o });
  assert.equal(f({}), 'completed'); assert.equal(f({ protocolComplete: false }), 'truncated'); assert.equal(f({ streamError: true }), 'stream_error'); assert.equal(f({ outputTokens: 0 }), 'empty');
  assert.equal(f({ upstreamStatus: 529 }), 'upstream_error'); assert.equal(f({ upstreamStatus: null }), 'upstream_error'); assert.equal(f({ recordedStatus: 400 }), 'refused_after_dispatch');
  assert.equal(B.turnState(null), 'not_started'); assert.equal(B.turnState({ first_dispatched_at: null, first_completed_at: null, last_failure_kind: '' }), 'not_started');
  assert.equal(B.turnState({ first_dispatched_at: 1, first_completed_at: null, last_failure_kind: '' }), 'dispatched'); assert.equal(B.turnState({ first_dispatched_at: 1, first_completed_at: null, last_failure_kind: 'truncated' }), 'failed'); assert.equal(B.turnState({ first_dispatched_at: 1, first_completed_at: 2, last_failure_kind: 'truncated' }), 'completed');
  const ph = (b, latest = 1, now = 10) => B.settingPhase(b, { latestSeq: latest, now });
  assert.equal(ph(null), 'prepared'); assert.equal(ph({ binding_seq: 1, activated_at: 1, first_dispatched_at: null, first_completed_at: null, last_failure_kind: '' }), 'switched');
  assert.equal(ph({ binding_seq: 1, activated_at: 1, first_dispatched_at: 2, first_completed_at: null, last_failure_kind: '' }), 'attempted'); assert.equal(ph({ binding_seq: 1, activated_at: 1, first_dispatched_at: 2, first_completed_at: null, last_failure_kind: '' }, 1, 2 + B.TURN_PIN_MAX_MS + 1), 'outcome_unknown');
  assert.equal(ph({ binding_seq: 1, activated_at: 1, first_dispatched_at: 2, first_completed_at: null, last_failure_kind: 'upstream_error' }), 'attempt_failed'); assert.equal(ph({ binding_seq: 1, activated_at: 1, first_dispatched_at: 2, first_completed_at: 3, last_failure_kind: '' }), 'applied'); assert.equal(ph({ binding_seq: 1, activated_at: 1, first_dispatched_at: 2, first_completed_at: 3, last_failure_kind: '' }, 2), 'replaced');
  ok('pure contract: applicable binding, new vs admitted turn, protocol outcome, instructor phase — with the first design as a failing control');
}

// ── fixture: a run pinned to v1, students whose TOKEN pins v1, and two more frozen versions of the same course ──
const f = await localOps();
const course = f.lesson.course_id, V1 = f.lesson.version, V2 = 'm2026.09.18-2', V3 = 'm2026.09.18-3';
const step = (id) => ({ id, title: id, instructions: '합성 단계 ' + id + '\n제출 증거: ' + id + '.md', hint: '', acceptance: '합성 기준' });
const design = (ids, title) => ({ schema: 'hps-session-design/1', title, audience: '합성 사용자', duration_minutes: 60, objective: '원격 운영 시험', prerequisites: '코딩 경험 불필요', starter: '연습 폴더', steps: ids.map(step) });
await f.freeze(course, V1, ['intro', 'build', 'review']);
async function freezeNext(version, ids, title) {
  const a = `/admin/cohorts/${f.cohort}/authoring/${course}`, cur = (await f.request(a)).json;
  const saved = await f.request(a, 'PUT', { profile_id: f.profile, request_id: crypto.randomUUID(), expected_revision: cur.revision ?? cur.draft?.revision, content: design(ids, title) }); assert.equal(saved.status, 200, saved.raw);
  const frozen = await f.request(`${a}/versions/${version}`, 'PUT', { expected_revision: saved.json.revision }); assert.equal(frozen.status, 200, frozen.raw);
}
await freezeNext(V2, ['intro', 'craft-v2', 'review'], '합성 수업 v2'); await freezeNext(V3, ['intro', 'craft-v3'], '합성 수업 v3');
assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-c' }])).status, 201);
const sha = {}; for (const v of [V1, V2, V3]) sha[v] = (await readLesson(f.env, f.cohort, course, v, f.profile)).sha256;
const tokenFor = async (u, version = V1, hours = 2) => (await issue({ u, c: f.cohort, p: f.profile, lesson: { course_id: course, version, sha256: sha[version] } }, hours, TEST_SECRET));
const A = await tokenFor('student-a'), Bt = await tokenFor('student-b');
f.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
const KEY1 = B.tokenBindingKey(sha[V1]);
const rows = (sql, ...a) => f.db.prepare(sql).all(...a), one = (sql, ...a) => { const r = f.db.prepare(sql).get(...a); return r ? { ...r } : r; };
let bindN = 0;
function bind(student, version, { source = 'setting', seat = 'A1', base = sha[V1] } = {}) {
  const seq = (one('SELECT COALESCE(MAX(binding_seq),0) n FROM classroom_lesson_bindings WHERE class_run_id=? AND student_id=?', f.run, student).n) + 1, key = String(++bindN).padStart(32, '0').replace(/[^0-9]/g, '0');
  const seatRev = one('SELECT seat_revision r FROM class_run_seats WHERE class_run_id=? AND seat_id=? AND replaced_at IS NULL', f.run, seat).r;
  f.db.prepare('INSERT INTO classroom_lesson_bindings(class_run_id,student_id,binding_seq,seat_id,seat_revision,binding_key,source,distribution_id,object_id,revision,content_hash,course_id,version,lesson_sha256,base_lesson_sha256,steps_json,activated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(f.run, student, seq, seat, seatRev, key, source, 'dist-' + seq + '-' + student, 'obj-setting', seq, 'h'.repeat(64), course, version, sha[version], base, '[]', Date.now());
  return key;
}
const turnId = () => crypto.randomUUID();
/** One model request through the full app. Returns status, body, and what the recorder provider actually received. */
async function ask(token, { turn, key, route = 'messages', upstream, body, headers = {}, stream = false } = {}) {
  const ctx = makeCtx();
  return withMockUpstream(upstream ?? (() => new Response(JSON.stringify(anthropicJsonBody({ text: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } })), async (calls) => {
    const path = route === 'messages' ? '/v1/messages' : route === 'count' ? '/v1/messages/count_tokens' : '/v1/chat/completions';
    const r = await f.app.fetch(new Request('https://service.test' + path, { method: 'POST', headers: { authorization: 'Bearer ' + token.token, 'content-type': 'application/json', ...(turn ? { 'x-hps-turn-id': turn } : {}), ...(key ? { 'x-hps-lesson-binding': key } : {}), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body ?? { model: 'claude-mock', max_tokens: 256, stream, messages: [{ role: 'user', content: '합성 질문' }] }) }), f.env, ctx);
    const text = await r.text(); await ctx.settle();
    let json; try { json = JSON.parse(text); } catch {}
    const sent = calls.map((c) => { try { return JSON.parse(c.init.body); } catch { return {}; } });
    return { status: r.status, json, text, header: r.headers.get('x-hps-lesson-binding'), upstream: sent, system: sent.map((s) => JSON.stringify(s.system ?? s.messages ?? '')).join('\n') };
  });
}
const profileOf = async (token) => { const r = await f.app.fetch(new Request('https://service.test/v1/profile', { headers: { authorization: 'Bearer ' + token.token } }), f.env, makeCtx()); return { status: r.status, json: await r.json() }; };
const turnRow = (student, turn) => one('SELECT * FROM classroom_lesson_turns WHERE class_run_id=? AND student_id=? AND turn_id=?', f.run, student, turn);

// ── enforcement unset: exactly as before ─────────────────────────────────────
{
  const p = await profileOf(A); assert.equal(p.status, 200); assert.equal('lesson_binding' in p.json, false, 'no new key without enforcement'); assert.equal(p.json.lesson.version, V1);
  const t = turnId(), r = await ask(A, { turn: t }); assert.equal(r.status, 200, r.text); assert.equal(r.upstream.length, 1);
  assert.equal(rows('SELECT 1 FROM classroom_lesson_turns').length, 0, 'no turn is recorded without enforcement'); assert.match(r.system, /build/);
  ok('enforcement unset: profile bytes carry no new key, a request runs the token lesson, nothing is written');
}
f.env.HPS_LESSON_BINDINGS = 'enforce';

// ── positive control: an unswitched seat ─────────────────────────────────────
{
  const p = await profileOf(A); assert.deepEqual([p.json.lesson_binding.key, p.json.lesson_binding.seq, p.json.lesson_binding.source, p.json.lesson_binding.enforced], [KEY1, 0, 'token', true]);
  const t = turnId(), r = await ask(A, { turn: t, key: KEY1 }); assert.equal(r.status, 200, r.text); assert.equal(r.header, KEY1);
  const row = turnRow('student-a', t); assert.equal(row.binding_seq, 0); assert.equal(row.binding_key, KEY1); assert.equal(row.token_jti, A.jti ?? row.token_jti); assert.ok(row.first_dispatched_at && row.first_completed_at, 'dispatched before, completed after');
  assert.equal(row.runtime, 'agent-sdk'); assert.ok(row.first_dispatch_request);
  ok('positive control: an unswitched seat is admitted under its token lesson; the profile, the response header and the turn row agree on one key');
}

// ── a switched seat: the same key in four places, and only the selected learner ──
const KEY2 = bind('student-a', V2);
{
  const p = await profileOf(A); assert.equal(p.json.lesson.version, V2); assert.equal(p.json.lesson_binding.key, KEY2); assert.equal(p.json.lesson_binding.source, 'setting');
  const t = turnId(), r = await ask(A, { turn: t, key: KEY2 }); assert.equal(r.status, 200, r.text); assert.equal(r.header, KEY2);
  assert.match(r.system, /craft-v2/); assert.doesNotMatch(r.system, /build\.md/, 'v2 removed that step');
  assert.equal(turnRow('student-a', t).binding_key, KEY2);
  const b = one('SELECT first_dispatched_at d,first_completed_at c FROM classroom_lesson_bindings WHERE binding_key=?', KEY2); assert.ok(b.d && b.c, 'the binding row got its evidence from the SECOND statement of the same batch');
  // the unselected learner: same instant, token lesson, no binding row, profile unchanged
  const pb = await profileOf(Bt); assert.equal(pb.json.lesson.version, V1); assert.equal(pb.json.lesson_binding.key, KEY1);
  const rb = await ask(Bt, { turn: turnId(), key: KEY1 }); assert.match(rb.system, /build\.md/); assert.equal(rows('SELECT 1 FROM classroom_lesson_bindings WHERE student_id=?', 'student-b').length, 0);
  ok('switched seat: /v1/profile, the response header, the binding row and the turn row carry one key and the provider received v2; the unselected learner still runs v1');
}

// ── a NEW turn cannot keep the old key; nothing is executed and nothing is recorded ──
{
  const t = turnId(), r = await ask(A, { turn: t, key: KEY1 });
  assert.equal(r.status, 403); assert.equal(r.json.error.type, 'lesson_binding'); assert.equal(r.json.error.code, 'lesson_binding_changed'); assert.equal(r.json.error.current_key, KEY2);
  assert.equal(r.upstream.length, 0); assert.equal(turnRow('student-a', t), undefined);
  // another learner's key selects nothing either
  const rb = await ask(Bt, { turn: turnId(), key: KEY2 }); assert.equal(rb.status, 403); assert.equal(rb.json.error.code, 'lesson_binding_changed'); assert.equal(rb.upstream.length, 0);
  ok('a new turn with the old key (or another learner\'s key) is refused before anything runs: 403, no row, provider not called');
}

// ── the in-flight turn of another window survives TWO consecutive switches ──
{
  const Ct = await tokenFor('student-c'), t = turnId();
  const first = await ask(Ct, { turn: t, key: KEY1 }); assert.equal(first.status, 200); assert.match(first.system, /build\.md/);
  const k2 = bind('student-c', V2, { seat: 'A3' }); const mid = await ask(Ct, { turn: t, key: KEY1 }); assert.equal(mid.status, 200, mid.text); assert.match(mid.system, /build\.md/); assert.doesNotMatch(mid.system, /craft-v2/);
  const k3 = bind('student-c', V3, { seat: 'A3' }); const late = await ask(Ct, { turn: t, key: KEY1 }); assert.equal(late.status, 200, late.text); assert.match(late.system, /build\.md/); assert.doesNotMatch(late.system, /craft-v3/);
  const count = await ask(Ct, { turn: t, key: KEY1, route: 'count', upstream: () => Response.json({ input_tokens: 3 }) }); assert.equal(count.status, 200, count.text);
  // evidence stays with what the turn was pinned to: neither v2 nor v3 is "applied" by a v1 turn
  for (const k of [k2, k3]) assert.deepEqual(one('SELECT first_dispatched_at d,first_completed_at c FROM classroom_lesson_bindings WHERE binding_key=?', k), { d: null, c: null });
  const next = await ask(Ct, { turn: turnId(), key: k3 }); assert.equal(next.status, 200); assert.match(next.system, /craft-v3/);
  assert.ok(one('SELECT first_completed_at c FROM classroom_lesson_bindings WHERE binding_key=?', k3).c); assert.equal(one('SELECT first_completed_at c FROM classroom_lesson_bindings WHERE binding_key=?', k2).c, null, 'v2 was never executed and is never called applied');
  ok('an admitted v1 turn keeps v1 through v2 and v3 (requests and count_tokens alike); its evidence is v1\'s; the next turn runs v3; v2 stays unapplied');
}

// ── the commit boundary of admission: what was read moved before the INSERT ──
{
  const Dt = await tokenFor('student-b'); let fired = 0;
  // positive control: the hook fires and, left alone, the turn is admitted
  store.resolverHooks.afterRead = async () => { fired++; };
  const calm = turnId(), c0 = await ask(Dt, { turn: calm, key: KEY1 }); assert.equal(c0.status, 200); assert.equal(fired, 1); assert.equal(turnRow('student-b', calm).binding_seq, 0);
  // a switch lands between the read and the INSERT: the v1 turn is NOT admitted
  let kb; store.resolverHooks.afterRead = async () => { if (fired++ === 1) kb = bind('student-b', V2, { seat: 'A2' }); };
  const raced = turnId(), c1 = await ask(Dt, { turn: raced, key: KEY1 }); assert.ok(fired >= 2, 'the injection point was reached');
  assert.equal(c1.status, 403); assert.equal(c1.json.error.code, 'lesson_binding_changed'); assert.equal(c1.json.error.current_key, kb); assert.equal(c1.upstream.length, 0); assert.equal(turnRow('student-b', raced), undefined, 'no v1 snapshot was admitted after v2 was committed');
  // a seat change lands in between: the v2 turn is not admitted under a binding whose seat is gone
  fired = 0; store.resolverHooks.afterRead = async () => { if (fired++ === 0) f.db.prepare("UPDATE class_run_seats SET replaced_at=?,replaced_reason='student_changed' WHERE class_run_id=? AND seat_id='A2' AND replaced_at IS NULL").run(Date.now(), f.run); };
  const moved = turnId(), c2 = await ask(Dt, { turn: moved, key: kb }); assert.equal(fired >= 1, true);
  assert.equal(c2.status, 403); assert.equal(c2.json.error.code, 'lesson_binding_changed'); assert.equal(c2.json.error.current_key, KEY1); assert.equal(c2.upstream.length, 0); assert.equal(turnRow('student-b', moved), undefined);
  store.resolverHooks.afterRead = undefined;
  // two first requests of ONE turn: one row, and both run from the stored row
  // (one recorder for both: the fetch swap of `ask` is not re-entrant, so the two requests share a single installation)
  const twin = turnId(), post = () => { const ctx = makeCtx(); return f.app.fetch(new Request('https://service.test/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + Dt.token, 'content-type': 'application/json', 'x-hps-turn-id': twin, 'x-hps-lesson-binding': KEY1 }, body: JSON.stringify({ model: 'claude-mock', max_tokens: 64, messages: [{ role: 'user', content: '합성' }] }) }), f.env, ctx).then(async (r) => { await r.text(); await ctx.settle(); return r.status; }); };
  const both = await withMockUpstream(() => new Response(JSON.stringify(anthropicJsonBody({ text: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } }), () => Promise.all([post(), post()]));
  assert.deepEqual(both, [200, 200]); assert.equal(rows('SELECT 1 FROM classroom_lesson_turns WHERE turn_id=?', twin).length, 1);
  ok('admission commit boundary: a switch or a seat change between the read and the INSERT admits nothing (hook verified to fire); twin first requests share one stored row');
}

// ── a finished turn is CLOSED; the TTL only bounds a turn nobody closed ──────
{
  const call = async (token, path, method = 'GET', body) => { const r = await f.app.fetch(new Request('https://service.test' + path, { method, headers: { authorization: 'Bearer ' + token.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), f.env, makeCtx()); return { status: r.status, json: await r.json() }; };
  const t = turnId(); assert.equal((await ask(A, { turn: t, key: KEY2 })).status, 200);
  assert.deepEqual((await call(A, `/v1/lesson-turns/${t}`)).json.state, 'completed');
  assert.equal((await call(Bt, `/v1/lesson-turns/${t}`)).json.state, 'not_started', "another learner asking about this id learns nothing of it");
  assert.equal((await call(Bt, `/v1/lesson-turns/${t}/close`, 'POST', { outcome: 'completed' })).json.closed, false, 'only the admitted token closes a turn');
  assert.equal((await call(A, `/v1/lesson-turns/${t}/close`, 'POST', { outcome: 'nonsense' })).status, 400);
  assert.equal((await call(A, `/v1/lesson-turns/${t}/close`, 'POST', { outcome: 'completed' })).json.reason, 'closed');
  assert.equal((await call(A, `/v1/lesson-turns/${t}/close`, 'POST', { outcome: 'completed' })).json.reason, 'already');
  const reuse = await ask(A, { turn: t, key: KEY2 }); assert.equal(reuse.status, 403); assert.equal(reuse.json.error.code, 'lesson_turn_closed'); assert.equal(reuse.upstream.length, 0, 'a finished turn id cannot carry a new question — one second or 29 minutes later');
  // an unclosed turn: bounded from ADMISSION, not renewable by traffic, and only when there is a change to dodge
  const u = turnId(); assert.equal((await ask(A, { turn: u, key: KEY2 })).status, 200);
  const k3 = bind('student-a', V3); f.db.prepare('UPDATE classroom_lesson_turns SET admitted_at=? WHERE turn_id=?').run(Date.now() - 29 * 60_000, u);
  assert.equal((await ask(A, { turn: u, key: KEY2 })).status, 200, 'inside the bound an unclosed turn keeps its snapshot (this is the stated limit, observed)');
  assert.equal(turnRow('student-a', u).admitted_at < Date.now() - 28 * 60_000, true, 'traffic did not refresh admitted_at');
  f.db.prepare('UPDATE classroom_lesson_turns SET admitted_at=? WHERE turn_id=?').run(Date.now() - 31 * 60_000, u);
  const old = await ask(A, { turn: u, key: KEY2 }); assert.equal(old.status, 403); assert.equal(old.json.error.code, 'lesson_turn_expired'); assert.equal(old.upstream.length, 0);
  // a reissued token is another token: it cannot continue the old token's turn
  const A2 = await tokenFor('student-a'); const v = turnId(); assert.equal((await ask(A, { turn: v, key: k3 })).status, 200);
  const other = await ask(A2, { turn: v, key: k3 }); assert.equal(other.status, 403); assert.equal(other.json.error.code, 'lesson_turn_mismatch');
  assert.equal((await call(A2, `/v1/lesson-turns/${v}`)).json.state, 'unknown', "a turn admitted under another token is 'unknown' to this one, never 'not started'");
  ok('completion: the host closes a turn and its id is refused from then on; unclosed turns are bounded from admission and not renewable; turns are bound to one token');
}
const KEY3 = one('SELECT binding_key k FROM classroom_lesson_bindings WHERE class_run_id=? AND student_id=? ORDER BY binding_seq DESC LIMIT 1', f.run, 'student-a').k;

// ── a binding-unaware app ────────────────────────────────────────────────────
{
  const Ct = await tokenFor('student-c');
  const blocked = await ask(Ct, { turn: turnId() }); assert.equal(blocked.status, 403); assert.equal(blocked.json.error.code, 'lesson_binding_app_unsupported'); assert.equal(blocked.upstream.length, 0, 'cached v1 tools + v3 Service policy never execute together');
  const noIds = await ask(Ct, {}); assert.equal(noIds.status, 403);
  bind('student-c', V1, { source: 'base', seat: 'A3' });
  const again = await ask(Ct, { turn: turnId() }); assert.equal(again.status, 200, again.text); assert.match(again.system, /build\.md/);
  const E = await tokenFor('legacy-test-seat'); const legacy = await ask(E, {}); assert.equal(legacy.status, 200, 'positive control: an unswitched seat without any of the new headers runs as it always did');
  ok('binding-unaware app: legacy behaviour on an unswitched seat, refused on a switched one, runs again after an explicit return');
}

// ── unknown is held; "no such table" is a verified absence ───────────────────
{
  f.fail('FROM classroom_lesson_bindings b WHERE');
  const held = await ask(A, { turn: turnId(), key: KEY3 }); assert.equal(held.status, 403); assert.equal(held.json.error.code, 'lesson_binding_unknown'); assert.equal(held.upstream.length, 0);
  const heldB = await ask(Bt, { turn: turnId(), key: KEY1 }); assert.equal(heldB.status, 403, 'an unreadable table says nothing about who was switched: nobody is run on a guess');
  assert.equal((await profileOf(A)).status, 503);
  f.fail('');
  // NEGATIVE CONTROL — "fall back to the token lesson when the binding cannot be read / when it is off" is what a Service
  // without enforcement does. Under the same assertion ("a learner narrowed to v3 never reaches the provider as v1") it fails.
  f.env.HPS_LESSON_BINDINGS = undefined; const wide = await ask(A, { turn: turnId(), key: KEY3 }); f.env.HPS_LESSON_BINDINGS = 'enforce';
  assert.match(wide.system, /build\.md/, 'control: the fallback behaviour DOES send the wider v1 lesson — which is why enforcement is a separate switch that operations-off does not touch');
  // operations switched off globally: enforcement continues, mid-turn included
  const t = turnId(); assert.equal((await ask(A, { turn: t, key: KEY3 })).status, 200); f.env.HPS_CLASSROOM_OPS = undefined;
  const off = await ask(A, { turn: t, key: KEY3 }); assert.equal(off.status, 200); assert.match(off.system, /craft-v3/); const offNew = await ask(A, { turn: turnId(), key: KEY3 }); assert.match(offNew.system, /craft-v3/); f.env.HPS_CLASSROOM_OPS = 'enabled';
  ok('unknown holds execution for everyone (403, provider not called, profile 503); operations-off keeps enforcing mid-turn; the token-fallback control is shown to widen');
}

// ── evidence is made at the provider boundary ────────────────────────────────
{
  const kb = bind('student-a', V2); const ev = () => one('SELECT first_dispatched_at d,first_completed_at c,last_failure_kind k FROM classroom_lesson_bindings WHERE binding_key=?', kb);
  assert.equal((await profileOf(A)).status, 200); assert.deepEqual(ev(), { d: null, c: null, k: '' }, '/v1/profile is not execution');
  const t1 = turnId(); assert.equal((await ask(A, { turn: t1, key: kb, route: 'count', upstream: () => Response.json({ input_tokens: 3 }) })).status, 200); assert.deepEqual(ev(), { d: null, c: null, k: '' }, 'count_tokens passed the gate and is not execution');
  const bad = await ask(A, { turn: t1, key: kb, body: '{not json' }); assert.equal(bad.status, 400); const notArray = await ask(A, { turn: t1, key: kb, body: { model: 'x', messages: 'nope' } }); assert.equal(notArray.status, 400);
  assert.deepEqual(ev(), { d: null, c: null, k: '' }, 'a request refused after the gate leaves no evidence'); assert.equal(turnRow('student-a', t1).first_dispatched_at, null);
  // the first dispatch cannot be recorded → the provider is NOT called
  f.fail('SET first_dispatched_at'); const hold = await ask(A, { turn: t1, key: kb }); f.fail('');
  assert.equal(hold.status, 403); assert.equal(hold.json.error.code, 'lesson_binding_unknown'); assert.equal(hold.upstream.length, 0, 'no durable intent, no execution'); assert.equal(turnRow('student-a', t1).first_dispatched_at, null);
  // upstream failure / truncated stream / SSE error / empty: attempted, never applied
  const sse = (events) => sseResponse(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''));
  const start = ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-mock', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }];
  const delta = ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '반쯤' } }];
  for (const [name, upstream, kind] of [
    ['upstream 529', () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }), { status: 529 }), 'upstream_error'],
    ['truncated stream', () => sse([start, delta]), 'truncated'],
    ['SSE error event', () => sse([start, ['error', { type: 'error', error: { type: 'overloaded_error', message: 'x' } }]]), null],
  ]) {
    const t = turnId(), r = await ask(A, { turn: t, key: kb, upstream, stream: true }); const row = turnRow('student-a', t);
    assert.ok(row.first_dispatched_at, name + ': attempted'); assert.equal(row.first_completed_at, null, name + ': never completed'); if (kind) assert.equal(row.last_failure_kind, kind, name); else assert.ok(['stream_error', 'truncated'].includes(row.last_failure_kind), name + ' → ' + row.last_failure_kind);
    assert.equal(ev().c, null, name + ': the binding is not applied');
  }
  assert.ok(ev().d, 'attempted is on record'); assert.ok(ev().k, 'so is the failure');
  // the outcome cannot be written → stays "dispatched, outcome unknown"
  const t2 = turnId(); f.fail('SET first_completed_at'); assert.equal((await ask(A, { turn: t2, key: kb })).status, 200); f.fail('');
  assert.ok(turnRow('student-a', t2).first_dispatched_at); assert.equal(turnRow('student-a', t2).first_completed_at, null); assert.equal(B.turnState(turnRow('student-a', t2)), 'dispatched', 'never "not started", never "completed"');
  assert.equal(ev().c, null);
  // a protocol-complete answer, on both routes
  const t3 = turnId(), done = await ask(A, { turn: t3, key: kb }); assert.equal(done.status, 200); assert.ok(ev().c); assert.equal(turnRow('student-a', t3).model.length > 0, true);
  const t4 = turnId(), px = await ask(A, { turn: t4, key: kb, route: 'chat', body: { model: 'hypeproof-default', messages: [{ role: 'user', content: '합성' }] }, upstream: () => Response.json({ id: 'x', object: 'chat.completion', model: 'gpt-test', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) });
  assert.equal(px.status, 200, px.text); assert.equal(turnRow('student-a', t4).runtime, 'proxy'); assert.ok(turnRow('student-a', t4).first_completed_at); assert.match(px.system, /craft-v2/);
  ok('evidence: profile, count_tokens, malformed and refused requests leave none; an unrecordable first dispatch stops the call; failures and cut streams are "attempted"; only a protocol-complete answer is "applied" (SDK and proxy routes)');
}

// ── policy shrink: a version that no longer resolves closes, it does not widen ──
{
  const Ft = await tokenFor('student-a'); f.db.prepare('DELETE FROM authoring_versions WHERE course_id=? AND version=?').run(course, V2);
  const r = await ask(Ft, { turn: turnId(), key: one('SELECT binding_key k FROM classroom_lesson_bindings WHERE student_id=? ORDER BY binding_seq DESC LIMIT 1', 'student-a').k });
  assert.equal(r.status, 403, 'a 403, not the legacy 409: the pinned SDK retries a 409 for a minute and more'); assert.equal(r.json.error.code, 'lesson_unavailable'); assert.match(r.json.error.message, /\[hps:lesson_unavailable\]/); assert.equal(r.upstream.length, 0);
  assert.equal((await profileOf(Ft)).status, 409, 'the profile route keeps the existing 409');
  ok('a switched version that stops resolving is refused (403 lesson_unavailable on the model routes); nothing runs under the token lesson instead');
}

// ── "no such table": enforcement on, migration 0024 absent ───────────────────
{
  f.db.exec('DROP TABLE classroom_lesson_turns; DROP TABLE classroom_lesson_bindings;');
  const r = await ask(Bt, { turn: turnId(), key: KEY1 }); assert.equal(r.status, 200, r.text); assert.match(r.system, /build\.md/);
  assert.equal((await profileOf(Bt)).status, 200);
  ok('enforcement on a database without migration 0024: no binding can exist, the token lesson runs, chat and profile stay up');
}
f.close();
console.log(`\n${passed} passed`);
