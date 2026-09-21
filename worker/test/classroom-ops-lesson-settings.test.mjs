// #751 U3 — AT-45/46, Service side: a PROMPT is inbox content; a SETTING is a reference to a frozen lesson version that a
// participant is SWITCHED to by one conditional batch, and "applied" is the Service's own record of a protocol-complete
// provider answer under that binding. Synthetic accounts, SQLite, a recorder provider. The device speaks the wire by hand
// here; the real App is exercised in the extension tests, the browser e2e and the Mac run.
// Plan: docs/testing/classroom-admin.md#remote-management-u3-plan-20260921.
import assert from 'node:assert/strict';
import { localOps, OPS_ALL } from './harness/classroom-ops.mjs';
import { makeCtx, withMockUpstream, anthropicJsonBody, TEST_SECRET } from './harness/index.mjs';
const lib = await import('../src/lib/classroom-distribution.ts');
const B = await import('../src/lib/lesson-binding.ts');
const act = await import('../src/lib/lesson-binding-activate.ts');
const dstore = await import('../src/lib/classroom-distribution-store.ts');
const { readLesson } = await import('../src/lib/lesson-delivery.ts');
const { issue } = await import('../src/lib/tokens.ts');
const { setRoster } = await import('../src/lib/kv.ts');
let count = 0; async function check(name, fn) { f?.db.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run(); await fn(); count++; console.log('PASS ' + name); }
const KEY = () => crypto.randomUUID();
const FULL = ['observe', 'commands', 'send_question', 'mark_checkpoint', 'distribution_inbox', 'inbox_prompt', 'lesson_binding'];
let f;

await check('controls: prompt and setting are kinds of the same object; a setting is a REFERENCE; notice/material hashes are unchanged', async () => {
  const n = (o) => lib.normalizeContent({ kind: 'notice', title: '제목', body: '본문', ...o }, []);
  assert.equal(n({ kind: 'prompt' }).ok, true); assert.equal(n({ kind: 'prompt', links: [{ label: 'a', url: 'https://x.example.org/' }] }).reason, 'content_invalid', 'a prompt carries no link');
  assert.equal(n({ kind: 'prompt', lesson: { course_id: 'c', version: 'v', sha256: 'a'.repeat(64) } }).reason, 'content_invalid', 'only a setting names a lesson');
  const ref = { course_id: 'c', version: 'm2026.09.18-2', sha256: 'a'.repeat(64) };
  assert.deepEqual(n({ kind: 'setting', lesson: ref }).value.lesson, ref); assert.equal(n({ kind: 'setting', base: true }).value.lesson, 'base');
  for (const o of [{ kind: 'setting' }, { kind: 'setting', base: false }, { kind: 'setting', base: true, lesson: ref }, { kind: 'setting', lesson: { ...ref, sha256: 'short' } }, { kind: 'setting', lesson: { ...ref, tools: ['Bash'] } }, { kind: 'setting', lesson: { ...ref, model: 'opus' } }]) assert.equal(n(o).reason, 'content_invalid', JSON.stringify(o));
  assert.equal(lib.normalizeContentRequest({ idempotency_key: KEY(), kind: 'setting', title: 't', body: 'b', lesson: ref, settings: { model: 'x' } }, []).reason, 'unknown_field', 'there is nowhere to put a free-form value');
  const notice = { kind: 'notice', title: '제목', body: '본문', links: [] };
  assert.equal(lib.contentCanonical(notice), JSON.stringify([lib.CONTENT_SCHEMA, 'notice', '제목', '본문', []]), 'byte-for-byte what U2 hashed');
  assert.equal(JSON.parse(lib.contentCanonical({ ...notice, kind: 'setting', lesson: ref })).length, 6); assert.deepEqual(JSON.parse(lib.contentCanonical({ ...notice, kind: 'setting', lesson: 'base' }))[5], ['base']);
  assert.equal(lib.declaresKind(['distribution_inbox'], 'notice'), true); assert.equal(lib.declaresKind(['distribution_inbox'], 'prompt'), false); assert.equal(lib.declaresKind(['distribution_inbox', 'inbox_prompt'], 'setting'), false); assert.equal(lib.declaresKind(['lesson_binding'], 'setting'), false, 'a binding-capable app still needs an inbox'); assert.equal(lib.declaresKind(FULL, 'setting'), true);
  const d = B.lessonImpact({ title: 'a', steps: [{ id: 's1' }, { id: 's2' }], features: { allowed: ['read', 'write'] } }, { title: 'b', steps: [{ id: 's1' }, { id: 's4' }], features: { allowed: ['read'] }, assistant: { display_name: '새 이름' } });
  assert.deepEqual(d.steps, { kept: ['s1'], removed: ['s2'], added: ['s4'] }); assert.deepEqual(d.features, { from: ['read', 'write'], to: ['read'] }); assert.deepEqual(d.assistant_name, { from: null, to: '새 이름' }); assert.equal(d.model, null);
});

f = await localOps(); f.env.HPS_LESSON_BINDINGS = 'enforce'; f.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
const course = f.lesson.course_id, V1 = f.lesson.version, V2 = 'm2026.09.18-2', V3 = 'm2026.09.18-3';
const step = (id) => ({ id, title: id, instructions: '합성 단계 ' + id, hint: '', acceptance: '합성 기준' });
const design = (ids, title) => ({ schema: 'hps-session-design/1', title, audience: '합성 사용자', duration_minutes: 60, objective: '원격 운영 시험', prerequisites: '없음', starter: '연습 폴더', steps: ids.map(step) });
const students = ['a', 'b', 'c', 'd'].map((x, i) => ({ seat_id: 'A' + (i + 1), student_id: 'student-' + x }));
const rows = (sql, ...a) => f.db.prepare(sql).all(...a).map((r) => ({ ...r })), one = (sql, ...a) => { const r = f.db.prepare(sql).get(...a); return r ? { ...r } : r; };
try {
  await setRoster(f.env.HPS_KV, f.cohort, students.map((s) => s.student_id)); await f.freeze(course, V1, ['intro', 'build', 'review']);
  const authoring = `/admin/cohorts/${f.cohort}/authoring/${course}`;
  async function freezeNext(version, ids, title) { const cur = (await f.request(authoring)).json; const saved = await f.request(authoring, 'PUT', { profile_id: f.profile, request_id: KEY(), expected_revision: cur.revision ?? cur.draft?.revision, content: design(ids, title) }); assert.equal(saved.status, 200, saved.raw); const fr = await f.request(`${authoring}/versions/${version}`, 'PUT', { expected_revision: saved.json.revision }); assert.equal(fr.status, 200, fr.raw); }
  await freezeNext(V2, ['intro', 'craft-v2', 'review'], '합성 수업 v2'); await freezeNext(V3, ['intro', 'craft-v3'], '합성 수업 v3');
  const FLAGS = { ops_observe: true, ops_commands: true, ops_distribute: true, ops_lesson_settings: true };
  assert.equal((await f.configure(students, 0, { flags: FLAGS })).status, 201); let roster = 1;
  const sha = {}; for (const v of [V1, V2, V3]) sha[v] = (await readLesson(f.env, f.cohort, course, v, f.profile)).sha256;
  const ref = (v) => ({ course_id: course, version: v, sha256: sha[v] });
  // L may send settings. X distributes only. Y holds every OTHER capability.
  const L = await f.teacher('teacher-l', [...OPS_ALL, 'distribute', 'lesson_settings']), X = await f.teacher('teacher-x', [...OPS_ALL, 'distribute']), Y = f.teacherToken;
  const save = (body, token = L, key = KEY()) => f.request(f.base + '/contents', 'POST', { idempotency_key: key, ...body }, token);
  const send = (o, token = L, key = KEY()) => f.request(f.base + '/distributions', 'POST', { idempotency_key: key, expected_roster_revision: roster, ...o }, token);
  const view = (id, token = L) => f.request(f.base + '/distributions/' + id, 'GET', undefined, token);
  const dsync = (conn, n, distribution) => f.sync(conn.credential, [], n, distribution === undefined ? {} : { distribution });
  const receipt = (item, stage) => ({ offer_key: item.offer_key, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, seq: item.seq, stage, result_code: '', observed_at: Date.now() });
  const now0 = () => f.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run();
  /** A device takes whatever is pending for it and reports it as held. Returns the items it was given. */
  const take = async (conn, n) => { now0(); const r = await dsync(conn, n); const items = r.json.distribution?.items ?? []; if (items.length) { const h = await dsync(conn, n, { receipts: items.flatMap((i) => [receipt(i, 'received'), receipt(i, 'reflected')]) }); assert.ok(h.json.distribution.receipt_acks.every((a) => a.recorded), h.raw); } return items; };
  const conn = {}; for (const [i, s] of students.entries()) conn[s.seat_id] = (await f.pair(s.seat_id, 1, i + 1, i === 3 ? ['observe', 'commands', 'distribution_inbox'] /* A4: holds notices, nothing of U3 */ : FULL)).conn.json;
  const token = {}; for (const s of students) token[s.seat_id] = await issue({ u: s.student_id, c: f.cohort, p: f.profile, lesson: ref(V1) }, 2, TEST_SECRET);
  const KEY1 = B.tokenBindingKey(sha[V1]);
  const switchTo = (seat, n, item, _seqHint, extra = {}) => f.request('/v1/classroom/ops/lesson-binding', 'POST', { app_instance_id: f.instance(n).app_instance_id, boot_id: f.instance(n).boot_id, offer_key: item.offer_key, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, base_lesson_sha256: sha[V1], ...extra }, conn[seat].credential);
  async function ask(seat, { turn = KEY(), key } = {}) {
    const ctx = makeCtx();
    return withMockUpstream(() => new Response(JSON.stringify(anthropicJsonBody({ text: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } }), async (calls) => {
      const r = await f.app.fetch(new Request('https://service.test/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + token[seat].token, 'content-type': 'application/json', 'x-hps-turn-id': turn, ...(key ? { 'x-hps-lesson-binding': key } : {}) }, body: JSON.stringify({ model: 'claude-mock', max_tokens: 64, messages: [{ role: 'user', content: '합성 질문' }] }) }), f.env, ctx);
      const text = await r.text(); await ctx.settle(); let json; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, system: calls.map((c) => c.init.body).join('\n'), upstream: calls.length };
    });
  }
  const profileOf = async (seat) => (await (await f.app.fetch(new Request('https://service.test/v1/profile', { headers: { authorization: 'Bearer ' + token[seat].token } }), f.env, makeCtx())).json());
  const bindings = (student) => rows('SELECT binding_seq,source,version,binding_key,distribution_id FROM classroom_lesson_bindings WHERE class_run_id=? AND student_id=? ORDER BY binding_seq', f.run, student);
  const tables = () => Object.fromEntries(['classroom_content_objects', 'classroom_content_revisions', 'classroom_distributions', 'classroom_distribution_targets', 'classroom_lesson_bindings'].map((t) => [t, one(`SELECT count(*) n FROM ${t}`).n]));

  let prompt, setting;
  await check('S14 authority and admission: `lesson_settings` is its own capability and switch; a setting names a frozen version of THE RUN\'S course that resolves now', async () => {
    const before = tables();
    assert.equal((await save({ kind: 'setting', title: '2번째 판', body: '안내', lesson: ref(V2) }, X)).json.reason, 'ops_capability_missing', 'X holds distribute and everything else — not lesson_settings');
    assert.equal((await save({ kind: 'setting', title: 't', body: 'b', lesson: ref(V2) }, Y)).json.reason, 'ops_capability_missing');
    for (const [body, reason] of [
      [{ lesson: { course_id: 'another-course', version: V2, sha256: sha[V2] } }, 'setting_course_mismatch'], [{ lesson: { ...ref(V2), sha256: 'b'.repeat(64) } }, 'lesson_mismatch'],
      [{ lesson: { course_id: course, version: 'm2026.09.18-9', sha256: sha[V2] } }, 'lesson_unavailable'] /* never frozen: a draft or a typo */,
    ]) assert.equal((await save({ kind: 'setting', title: 't', body: '안내', ...body })).json.reason, reason);
    f.env.HPS_LESSON_BINDINGS = undefined; assert.equal((await save({ kind: 'setting', title: 't', body: '안내', lesson: ref(V2) })).json.reason, 'lesson_bindings_not_enforced', 'a binding may only exist where it is enforced'); f.env.HPS_LESSON_BINDINGS = 'enforce';
    await f.request(f.base, 'PUT', { expected_roster_revision: roster, seats: students, flags: { ops_lesson_settings: false } }); roster++;
    assert.equal((await save({ kind: 'setting', title: 't', body: '안내', lesson: ref(V2) })).json.reason, 'ops_lesson_settings_disabled');
    assert.equal((await save({ kind: 'prompt', title: '프롬프트', body: '본문' }, X)).status, 201, 'a prompt needs only `distribute` and ops_distribute'); f.db.prepare("DELETE FROM classroom_content_revisions WHERE kind='prompt'").run(); f.db.prepare("DELETE FROM classroom_content_objects WHERE kind='prompt'").run(); f.db.prepare("DELETE FROM ops_audit WHERE action='distribution_content_saved'").run();
    await f.request(f.base, 'PUT', { expected_roster_revision: roster, seats: students, flags: { ops_lesson_settings: true } }); roster++;
    const pin = one('SELECT lesson_json j FROM class_run_ops WHERE class_run_id=?', f.run).j; f.db.prepare("UPDATE class_run_ops SET lesson_json='{}' WHERE class_run_id=?").run(f.run);
    assert.equal((await save({ kind: 'setting', title: 't', body: '안내', lesson: ref(V2) })).json.reason, 'run_lesson_not_pinned'); f.db.prepare('UPDATE class_run_ops SET lesson_json=? WHERE class_run_id=?').run(pin, f.run);
    assert.deepEqual(tables(), before, 'every refusal wrote nothing');
    const r = await save({ kind: 'setting', title: '2번째 판', body: '다음 질문부터 새 단계로 진행합니다. 선택한 모델은 기본값으로 돌아갑니다.', lesson: ref(V2) }); assert.equal(r.status, 201, r.raw); setting = r.json;
    assert.equal((await save({ kind: 'setting', title: '또 하나', body: '안내', lesson: ref(V3) })).json.reason, 'setting_object_exists', 'one setting object per run: the next choice is its next revision');
    assert.equal((await f.request(`${f.base}/contents/${setting.object_id}/retire`, 'POST', { expected_latest_revision: 1 }, L)).json.reason, 'setting_not_retirable');
    const status = (await f.request(f.base + '/status', 'GET', undefined, L)).json; assert.deepEqual(status.lesson_settings, { enabled: true, held: true, enforced: true, pinned: true });
    assert.deepEqual(status.seats.map((s) => [s.inbox_prompt, s.lesson_binding]), [['declared', 'declared'], ['declared', 'declared'], ['declared', 'declared'], ['not_declared', 'not_declared']]);
    assert.equal((await f.request(f.base + '/status', 'GET', undefined, X)).json.lesson_settings.held, false);
  });

  await check('P1/P6 prompt: only the selected learners get it; an app that holds notices but cannot import a prompt is "unsupported" and its body is never sent', async () => {
    prompt = (await save({ kind: 'prompt', title: '조사 프롬프트', body: '이 페이지의 구조를 세 문장으로 설명해 줘.\n<script>alert(1)</script>' }, X)).json;
    const dry = await send({ object_id: prompt.object_id, revision: 1, content_hash: prompt.content_hash, targets: ['A1', 'A3', 'A4'], dry_run: true }, X);
    assert.deepEqual(dry.json.targets.map((t) => t.expect), ['deliverable_now', 'deliverable_now', 'unsupported_app']); assert.equal('setting' in dry.json, false);
    const d = (await send({ object_id: prompt.object_id, revision: 1, content_hash: prompt.content_hash, targets: ['A1', 'A3', 'A4'] }, X)).json.distribution;
    const a1 = await take(conn.A1, 1), a2 = await take(conn.A2, 2), a3 = await take(conn.A3, 3), a4 = await take(conn.A4, 4);
    assert.deepEqual([a1.length, a2.length, a3.length, a4.length], [1, 0, 1, 0]); assert.equal(a1[0].kind, 'prompt'); assert.equal(a1[0].body.includes('<script>'), true, 'text stays text; the device draws it as text'); assert.equal('lesson' in a1[0], false);
    const v = (await view(d.id, X)).json; assert.deepEqual(v.targets.map((t) => [t.seat_id, t.state]), [['A1', 'reflected'], ['A3', 'reflected'], ['A4', 'unsupported']]);
    assert.equal(rows('SELECT 1 FROM classroom_distribution_targets WHERE seat_id=?', 'A2').length, 0, 'the unselected learner has no row at all');
    // A4 still receives a notice: capability is per kind
    const notice = (await save({ kind: 'notice', title: '공지', body: '본문' }, X)).json; const dn = (await send({ object_id: notice.object_id, revision: 1, content_hash: notice.content_hash, targets: ['A4'] }, X)).json.distribution; assert.equal((await take(conn.A4, 4)).length, 1); assert.equal((await view(dn.id, X)).json.targets[0].state, 'reflected');
    assert.equal('setting_summary' in v, false, 'a prompt has no execution phase: "in the inbox" is all the instructor is told');
  });

  let d2, item = {};
  await check('S1 setting: prepared is not switched, switched is not applied; one key in the profile, the gate answer, the binding row and the turn row; the unselected learner runs v1', async () => {
    const dry = await send({ object_id: setting.object_id, revision: 1, content_hash: setting.content_hash, targets: ['A1', 'A3', 'A4'], dry_run: true });
    assert.deepEqual(dry.json.setting.impact.steps, { kept: ['intro', 'review'], removed: ['build'], added: ['craft-v2'] }); assert.equal(dry.json.setting.applies, 'next_question'); assert.equal(dry.json.targets[2].expect, 'unsupported_app');
    assert.equal((await send({ object_id: setting.object_id, revision: 1, content_hash: setting.content_hash, targets: ['A1'] }, X)).json.reason, 'ops_capability_missing', 'distributing a setting needs the same authority as creating one');
    d2 = (await send({ object_id: setting.object_id, revision: 1, content_hash: setting.content_hash, targets: ['A1', 'A3', 'A4'] })).json.distribution;
    [item.A1] = await take(conn.A1, 1); [item.A3] = await take(conn.A3, 3); assert.equal((await take(conn.A4, 4)).length, 0);
    assert.deepEqual(item.A1.lesson, ref(V2)); assert.equal(item.A1.body.includes('다음 질문부터'), true); assert.equal(JSON.stringify(item.A1).includes('craft-v2'), false, 'the item carries a reference and a notice — never lesson content');
    let v = (await view(d2.id)).json; assert.deepEqual(v.targets.map((t) => [t.seat_id, t.state, t.setting.phase]), [['A1', 'reflected', 'prepared'], ['A3', 'reflected', 'prepared'], ['A4', 'unsupported', 'not_prepared']]); assert.equal(v.setting_summary.all_applied, false);
    assert.equal((await ask('A1', { key: KEY1 })).status, 200, 'prepared changes nothing: the learner still runs v1'); assert.equal(bindings('student-a').length, 0);
    const sw = await switchTo('A1', 1, item.A1, 0); assert.equal(sw.status, 201, sw.raw); const K2 = sw.json.binding.key; assert.deepEqual([sw.json.binding.seq, sw.json.binding.source, sw.json.binding.version], [1, 'setting', V2]);
    v = (await view(d2.id)).json; assert.equal(v.targets[0].setting.phase, 'switched', 'a recorded switch is not an execution'); assert.equal(v.setting_summary.applied, 0);
    const p = await profileOf('A1'); assert.equal(p.lesson_binding.key, K2); assert.equal(p.lesson.version, V2);
    const turn = KEY(), r = await ask('A1', { turn, key: K2 }); assert.equal(r.status, 200); assert.match(r.system, /craft-v2/); assert.doesNotMatch(r.system, /build\.md/);
    assert.equal(one('SELECT binding_key k FROM classroom_lesson_turns WHERE turn_id=?', turn).k, K2);
    v = (await view(d2.id)).json; assert.deepEqual(v.targets.map((t) => t.setting.phase), ['applied', 'prepared', 'not_prepared']); assert.equal(v.setting_summary.all_applied, false, 'A3 never asked: prepared is an honest state, not a failure, and not "all applied"');
    const pb = await profileOf('A2'); assert.equal(pb.lesson.version, V1); assert.equal(pb.lesson_binding.key, KEY1); const rb = await ask('A2', { key: KEY1 }); assert.match(rb.system, /build\.md/); assert.equal(bindings('student-b').length, 0);
    const board = (await f.request(f.base + '/status', 'GET', undefined, L)).json.seats; assert.deepEqual(board.map((s) => [s.lesson.version, s.lesson.source]), [[V2, 'setting'], [V1, 'token'], [V1, 'token'], [V1, 'token']]);
  });

  await check('S7 idempotent and single: a lost answer, a repeat and two windows get the SAME row; nothing is switched twice', async () => {
    const again = await switchTo('A1', 1, item.A1, 0); assert.equal(again.status, 200); assert.equal(again.json.replayed, true); assert.equal(again.json.binding.seq, 1); assert.equal(bindings('student-a').length, 1);
    const both = await Promise.all([switchTo('A3', 3, item.A3, 0), switchTo('A3', 3, item.A3, 0)]); assert.deepEqual(both.map((r) => r.json.recorded), [true, true]); assert.equal(new Set(both.map((r) => r.json.binding.key)).size, 1); assert.equal(bindings('student-c').length, 1);
    assert.equal((await switchTo('A3', 9, item.A3, 1)).json.reason, 'not_owner', 'only the window that holds the seat switches it');
    assert.equal((await f.request('/v1/classroom/ops/lesson-binding', 'POST', { offer_key: item.A1.offer_key, all: true }, conn.A1.credential)).status, 400);
    assert.equal((await f.request('/v1/classroom/ops/lesson-binding', 'POST', {}, token.A1.token)).status, 401, 'a learning token is not an operations credential');
  });

  await check('S6 the commit boundary of the switch: what was read moved before the conditional INSERT — nothing is recorded, and the answer says so', async () => {
    // every case gets a NEW revision of the run's one setting object: re-sending a revision the device holds is `no_change`, not an offer
    let flip = 0; const fresh = async () => {
      const head = one('SELECT latest_revision r FROM classroom_content_objects WHERE object_id=?', setting.object_id);
      const s = await save({ kind: 'setting', title: '다음 판', body: '안내', lesson: ref(flip++ % 2 ? V2 : V3), object_id: setting.object_id, expected_latest_revision: head.r }); assert.equal(s.status, 201, s.raw);
      const d = (await send({ object_id: setting.object_id, revision: s.json.revision, content_hash: s.json.content_hash, targets: ['A2'] })).json.distribution; const [it] = await take(conn.A2, 2); assert.ok(it, 'positive: the device holds the new setting'); return { d, it };
    };
    let fired = 0; const inject = (fn) => { fired = 0; act.activateHooks.beforeCommit = async () => { fired++; await fn(); }; };
    const restore = [];
    const cases = [
      ['distribution withdrawn', async (x) => { const r = await f.request(`${f.base}/distributions/${x.d.id}/revoke`, 'POST', { expected_row_revision: 0 }, L); assert.equal(r.status, 200, r.raw); }, 'revoked'],
      ['settings switched off', async () => { f.db.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_lesson_settings',json('false')) WHERE class_run_id=?").run(f.run); restore.push(() => f.db.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_lesson_settings',json('true')) WHERE class_run_id=?").run(f.run)); }, 'disabled'],
      ['class ended', async () => { f.db.prepare("UPDATE sessions SET ended_at=datetime('now') WHERE id=?").run(f.run); restore.push(() => f.db.prepare('UPDATE sessions SET ended_at=NULL WHERE id=?').run(f.run)); }, 'run_ended'],
      ['re-login (epoch+1)', async () => { f.db.prepare('UPDATE ops_grants SET connection_epoch=connection_epoch+1 WHERE id=?').run(conn.A2.grant_id); restore.push(() => f.db.prepare('UPDATE ops_grants SET connection_epoch=connection_epoch-1 WHERE id=?').run(conn.A2.grant_id)); }, 'stale_offer'],
      ['seat lease moved to another window', async () => { f.db.prepare("UPDATE ops_seat_leases SET app_instance_id='another-window' WHERE grant_id=?").run(conn.A2.grant_id); restore.push(() => f.db.prepare('UPDATE ops_seat_leases SET app_instance_id=? WHERE grant_id=?').run(f.instance(2).app_instance_id, conn.A2.grant_id)); }, 'not_owner'],
      ["the sending instructor's token was revoked (sweep)", async () => { await f.db.exec('BEGIN'); for (const st of dstore.issuerFenceStatements({ prepare: (sql) => { let a = []; return { bind(...x) { a = x; return this; }, run: () => f.db.prepare(sql).run(...a) }; } }, 'unused', { reason: 'test', by: 'test', sweep: false, now: Date.now() })) void st; await f.db.exec('COMMIT'); f.db.prepare("UPDATE classroom_distribution_targets SET state='revoked',pending=0 WHERE seat_id='A2' AND state='reflected'").run(); f.db.prepare("UPDATE classroom_distributions SET revoked_at=?,revoke_reason='issuer_revoked' WHERE revoked_at IS NULL AND id IN (SELECT distribution_id FROM classroom_distribution_targets WHERE seat_id='A2')").run(Date.now()); }, 'revoked'],
    ];
    // positive control FIRST: the hook fires and, left alone, the switch is recorded
    { const x = await fresh(); inject(async () => {}); const r = await switchTo('A2', 2, x.it, 0); assert.equal(fired, 1); assert.equal(r.status, 201, r.raw); f.db.prepare("DELETE FROM classroom_lesson_bindings WHERE student_id='student-b'").run(); f.db.prepare("DELETE FROM ops_audit WHERE action='lesson_binding_switched' AND seat_id='A2'").run(); }
    for (const [name, interfere, reason] of cases) {
      const x = await fresh(), audits = one("SELECT count(*) n FROM ops_audit WHERE action='lesson_binding_switched'").n;
      inject(() => interfere(x)); const r = await switchTo('A2', 2, x.it, 0); act.activateHooks.beforeCommit = undefined;
      assert.equal(fired, 1, name + ': the injection point was reached'); assert.equal(r.json.recorded, false, name + ' → ' + r.raw); assert.equal(r.json.reason, reason, name);
      assert.equal(bindings('student-b').length, 0, name + ': no binding row'); assert.equal(one("SELECT count(*) n FROM ops_audit WHERE action='lesson_binding_switched'").n, audits, name + ': no audit row');
      assert.match((await ask('A2', { key: KEY1 })).system, /build\.md/, name + ': the learner still runs v1');
      while (restore.length) restore.pop()();
    }
    // a seat change: the old participant's switch is refused outright, and the new one was never a target
    const x = await fresh(); inject(async () => { const r = await f.request(f.base, 'PUT', { expected_roster_revision: roster, seats: students.map((s) => s.seat_id === 'A2' ? { seat_id: 'A2', student_id: 'student-d' } : s.seat_id === 'A4' ? { seat_id: 'A4', student_id: 'student-b' } : s), flags: FLAGS }); assert.equal(r.status, 200, r.raw); roster++; });
    const moved = await switchTo('A2', 2, x.it, 0); act.activateHooks.beforeCommit = undefined; assert.equal(fired, 1); assert.equal(moved.json.recorded, false); assert.equal(rows("SELECT 1 FROM classroom_lesson_bindings WHERE student_id IN ('student-b','student-d')").length, 0, 'neither the old nor the new holder of the seat was switched');
  });

  let K3;
  await check('S8/S2b late and consecutive: a newer setting supersedes an unswitched older one; a switched learner goes v2 → v3 with its history kept', async () => {
    const head = one('SELECT latest_revision r FROM classroom_content_objects WHERE object_id=?', setting.object_id), s3 = await save({ kind: 'setting', title: '3번째 강의', body: '안내', lesson: ref(V3), object_id: setting.object_id, expected_latest_revision: head.r }); assert.equal(s3.status, 201, s3.raw);
    const d3 = (await send({ object_id: setting.object_id, revision: s3.json.revision, content_hash: s3.json.content_hash, targets: ['A1', 'A3'] })).json.distribution; const [i1] = await take(conn.A1, 1);
    // A3 holds the v2 setting (switched to it) and a v3 one is now on its way: a LATE switch request for the old distribution changes nothing
    const lateOld = await switchTo('A3', 3, item.A3, 1); assert.equal(lateOld.json.replayed, true, 'the row that distribution already made is simply returned'); assert.equal(bindings('student-c').length, 1);
    const sw = await switchTo('A1', 1, i1, 1); assert.equal(sw.status, 201, sw.raw); K3 = sw.json.binding.key; assert.deepEqual(bindings('student-a').map((b) => [b.binding_seq, b.version]), [[1, V2], [2, V3]]);
    assert.equal((await switchTo('A1', 1, i1, 0)).json.replayed, true); assert.match((await ask('A1', { key: K3 })).system, /craft-v3/);
    const v2view = (await view(d2.id)).json.targets[0].setting.phase, v3view = (await view(d3.id)).json.targets[0].setting.phase; assert.deepEqual([v2view, v3view], ['replaced', 'applied'], 'v2 was applied and is now history; v3 is what runs');
  });

  await check('S12 withdrawing is not going back: a withdrawn setting leaves the binding alone; the return is a NEW distribution with its own evidence; v1 never revives by itself', async () => {
    const d3 = one("SELECT id,row_revision FROM classroom_distributions WHERE object_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", setting.object_id);
    assert.equal((await f.request(`${f.base}/distributions/${d3.id}/revoke`, 'POST', { expected_row_revision: d3.row_revision }, L)).status, 200);
    assert.match((await ask('A1', { key: K3 })).system, /craft-v3/, 'the very next question after the withdrawal still runs v3'); assert.equal(bindings('student-a').length, 2);
    assert.equal((await profileOf('A1')).lesson_binding.key, K3);
    const rev = one('SELECT latest_revision r FROM classroom_content_objects WHERE object_id=?', setting.object_id).r;
    const back = await save({ kind: 'setting', title: '참여 코드의 강의로 복귀', body: '다음 질문부터 처음 강의로 진행합니다.', base: true, object_id: setting.object_id, expected_latest_revision: rev }); assert.equal(back.status, 201, back.raw);
    const db = (await send({ object_id: setting.object_id, revision: back.json.revision, content_hash: back.json.content_hash, targets: ['A1'] })).json.distribution; const [ib] = await take(conn.A1, 1); assert.equal(ib.lesson, 'base');
    assert.equal((await view(db.id)).json.targets[0].setting.phase, 'prepared'); assert.match((await ask('A1', { key: K3 })).system, /craft-v3/, 'prepared is not "returned"');
    const sw = await switchTo('A1', 1, ib, 2); assert.equal(sw.status, 201, sw.raw); assert.equal(sw.json.binding.source, 'base'); assert.equal((await view(db.id)).json.targets[0].setting.phase, 'switched');
    const r = await ask('A1', { key: sw.json.binding.key }); assert.match(r.system, /build\.md/); assert.equal((await view(db.id)).json.targets[0].setting.phase, 'applied', 'the return is "applied" only after a real answer under it');
    assert.equal((await ask('A1', {})).status, 200, 'after the return a binding-unaware app runs again');
  });

  await check('S11 basis: a step is judged by what the participant runs; earlier self-reports and instructor confirmations are history, never the new version\'s', async () => {
    // A3 runs v2 (switched above). Its device reports v1 steps late, then v2 steps.
    let seq = 100; const stepEvent = (version, id, status) => f.event(++seq, 'step', { lesson_version: version, step_id: id, status });
    const late = await f.sync(conn.A3.credential, [stepEvent(V1, 'build', 'submitted')], 3); assert.deepEqual(late.json.quarantined.length, 1, 'a v1 step after the switch does not move the v2 board');
    const good = await f.sync(conn.A3.credential, [stepEvent(V2, 'craft-v2', 'submitted')], 3); assert.equal(good.json.quarantined.length, 0);
    assert.equal((await f.sync(conn.A3.credential, [stepEvent(V2, 'build', 'in_progress')], 3)).json.quarantined.length, 1, 'v2 has no such step');
    const seat = (await f.request(f.base + '/status', 'GET', undefined, L)).json.seats.find((s) => s.seat_id === 'A3'); assert.equal(seat.lesson.version, V2); assert.equal(seat.step.step_id, 'craft-v2'); assert.equal(seat.step.basis, 'current');
    // …and a learner who reported under v1 BEFORE being switched: the board keeps it, marked as the previous basis
    const A1now = (await f.request(f.base + '/status', 'GET', undefined, L)).json.seats.find((s) => s.seat_id === 'A1'); assert.equal(A1now.lesson.source, 'base');
    assert.equal((await f.command('mark_checkpoint', ['A3'], { args: { step_id: 'build' }, expected_roster_revision: roster }, L)).json.reason, 'unknown_step', 'a checkpoint names a step of the version THAT seat runs');
    const okCp = await f.command('mark_checkpoint', ['A3'], { args: { step_id: 'craft-v2' }, expected_roster_revision: roster }, L); assert.ok([200, 201, 202].includes(okCp.status), okCp.raw);
    f.fail('FROM classroom_lesson_bindings b WHERE'); const blind = await f.sync(conn.A3.credential, [stepEvent(V2, 'review', 'in_progress')], 3); f.fail('');
    assert.equal(blind.json.quarantined.length, 1, 'an unreadable basis stores the step as basis_unknown; it is not judged by the run pin instead'); assert.equal(one("SELECT disposition d FROM ops_events WHERE seq=? AND grant_id=?", seq, conn.A3.grant_id).d, 'basis_unknown');
  });
} finally { f?.close(); }
console.log(`\n${count} passed`);
