// #1012 · #751 G2 — learner-condition rehearsal of one frozen candidate, the teacher's confirmation, and the gate that keeps
// an unconfirmed version away from learners. Real Service routing + SQLite (schema.sql, which carries migration 0026) +
// the real token verifier; the model provider is a scripted mock. Says nothing about a real model or a real App.
import assert from 'node:assert/strict';
import { localOps, OPS_ALL } from './harness/classroom-ops.mjs';
import { makeCtx, withMockUpstream, anthropicJsonBody, TEST_SECRET } from './harness/index.mjs';

const R = await import('../src/lib/lesson-rehearsal.ts');
const { getProfile } = await import('../src/profiles/index.ts');
const { readLesson } = await import('../src/lib/lesson-delivery.ts');
const { setRoster } = await import('../src/lib/kv.ts');
const { issue } = await import('../src/lib/tokens.ts');
let passed = 0; const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
const KEY = () => crypto.randomUUID();

// Two deliberately different VALID curricula built only from existing fields (curriculum-runtime packet, 2026-09-22).
const common = { schema: 'hps-session-design/1', duration_minutes: 60, prerequisites: '코딩 경험 불필요', starter: '예약 안내 페이지 예제 폴더' };
export const CURRICULUM_A = { ...common, title: '첫 시제품 — 예약 안내 페이지', audience: '처음 만들어 보는 원장님', objective: '예약 안내 페이지의 첫 판을 만들고 확인 기준을 스스로 정한다',
  steps: [
    { id: 'criteria', title: '확인 기준 정하기', instructions: '페이지가 무엇을 보여줘야 하는지 한 줄 기준을 적는다.\n제출 증거: 저장한 확인 기준', hint: '환자가 가장 먼저 찾는 정보부터', acceptance: '저장한 확인 기준 한 줄이 있다', help: { default: 'hint', allowed: ['hint', 'independent'] }, ui: 'criterion_form' },
    { id: 'look', title: '예제 살펴보기', instructions: '예제 페이지를 열어 기준과 비교한다.\n제출 증거: 비교 메모', hint: '', acceptance: '기준에 맞는 곳과 아닌 곳을 하나씩 말한다' },
  ],
  features: { allowed: ['read'] } };
export const CURRICULUM_B = { ...common, title: '고쳐 보기 — 진료시간 수정', audience: '첫 판을 만든 원장님', objective: '진료시간 안내를 고치고 무엇을 왜 바꿨는지 남긴다',
  steps: [
    { id: 'revise', title: '고치고 이유 남기기', instructions: '진료시간 문구를 AI와 함께 고친다.\n제출 증거: 고친 index.html과 바꾼 이유', hint: '', acceptance: '고친 index.html과 바꾼 이유 한 줄이 있다', help: { default: 'co_edit', allowed: ['co_edit', 'independent'] }, ui: 'decision_form' },
  ],
  features: { allowed: ['read', 'write'] } };
const report = (content, over = {}) => ({ schema: 'hps-rehearsal-report/1', app: { extension_version: '0.1.test', host: 'test', runtime: 'agent-sdk', os: 'darwin', arch: 'arm64' },
  steps: content.steps.map((s) => ({ id: s.id, visited: true, help_offered: s.help?.allowed ?? [], help_default: s.help?.default ?? null, surface: s.ui ?? 'chat', ...(over[s.id] ?? {}) })) });

const profile = getProfile('boah-dental-director-copyclone-2026-s1');
const READ = ['Glob', 'Grep', 'Read'], WRITE = ['Edit', 'MultiEdit', 'Write'];
const turn = (sha, o = {}) => ({ request_id: KEY(), lesson_sha256: sha, step_id: 'criteria', help_receipt: 'mode=hint; source=lesson_default; step=criteria; performance=unobserved', runtime: 'agent-sdk', tool_names: READ, outcome: 'completed', ...o });

await check('judge — positive control: A with its own help, surface, a completed request and read-only tools passes', async () => {
  const v = R.judgeRehearsal({ content: CURRICULUM_A, lessonSha: 'a', profile, report: report(CURRICULUM_A), turns: [turn('a')] });
  assert.equal(v.verdict, 'passed', JSON.stringify(v)); assert.deepEqual(v.reasons, []); assert.equal(v.checks.tools.boundary, 'held');
  const w = R.judgeRehearsal({ content: CURRICULUM_B, lessonSha: 'b', profile, report: report(CURRICULUM_B), turns: [turn('b', { step_id: 'revise', tool_names: [...READ, ...WRITE] })] });
  assert.equal(w.verdict, 'passed', JSON.stringify(w)); assert.equal(w.checks.tools.write_expected, true);
});
await check('judge — negative controls: each disagreement fails with its own reason, an unrenderable surface is unsupported', async () => {
  const j = (content, rep, turns) => R.judgeRehearsal({ content, lessonSha: 'a', profile, report: rep, turns });
  assert.deepEqual(j(CURRICULUM_A, report(CURRICULUM_A, { criteria: { help_offered: ['hint', 'independent', 'co_edit'] } }), [turn('a')]).reasons, ['help_mismatch']);
  assert.deepEqual(j(CURRICULUM_A, report(CURRICULUM_A, { criteria: { surface: 'chat' } }), [turn('a')]).reasons, ['surface_mismatch']);
  const u = j(CURRICULUM_A, report(CURRICULUM_A, { criteria: { surface: 'unsupported:criterion_form' } }), [turn('a')]); assert.deepEqual([u.verdict, u.reasons], ['unsupported', ['surface_unsupported']]);
  assert.deepEqual(j(CURRICULUM_A, report(CURRICULUM_A, { look: { visited: false } }), [turn('a')]).reasons, ['steps_not_visited']);
  assert.deepEqual(j(CURRICULUM_A, report(CURRICULUM_A), [turn('a', { tool_names: [...READ, 'Write'] })]).reasons, ['tool_boundary_crossed'], 'a write tool on a read-only lesson');
  assert.deepEqual(j(CURRICULUM_B, report(CURRICULUM_B), [turn('a', { step_id: 'revise' })]).reasons, ['allowed_tool_missing'], 'a write lesson whose request carried no write tool');
  assert.deepEqual(j(CURRICULUM_A, report(CURRICULUM_A), [turn('a', { outcome: 'upstream_error' })]).reasons, ['no_completed_request']);
  assert.deepEqual(j(CURRICULUM_A, report(CURRICULUM_A), [turn('a', { step_id: '' })]).reasons, ['step_not_sent'], 'an App that never names the step cannot pass');
  assert.deepEqual(j(CURRICULUM_A, report(CURRICULUM_A), [turn('a'), turn('other')]).reasons, ['other_lesson_requests']);
  assert.equal(R.parseReport({ ...report(CURRICULUM_A), schema: 'x' }), 'unsupported report schema');
  assert.equal(R.parseReport({ ...report(CURRICULUM_A), steps: [{ id: 'a', visited: true, help_offered: ['everything'], help_default: null, surface: 'chat' }] }), 'invalid help_offered');
  assert.deepEqual(R.requestToolNames({ tools: [{ name: 'Read' }, { name: 'Read' }, { type: 'web_search_20250305' }, { function: { name: 'x' } }] }), ['Read', 'web_search_20250305', 'x']);
});
await check('state — issued is running (never ready), expiry is its own state, a pass on another policy is stale', async () => {
  const row = { verdict: null, expires_at: 10, policy_digest: 'p' };
  assert.equal(R.rehearsalState(null, { now: 0, currentDigest: 'p' }), 'not_run');
  assert.equal(R.rehearsalState(row, { now: 0, currentDigest: 'p' }), 'running');
  assert.equal(R.rehearsalState(row, { now: 11, currentDigest: 'p' }), 'expired');
  assert.equal(R.rehearsalState({ ...row, verdict: 'passed' }, { now: 0, currentDigest: 'p' }), 'passed');
  assert.equal(R.rehearsalState({ ...row, verdict: 'passed' }, { now: 0, currentDigest: 'q' }), 'stale');
  assert.equal(R.rehearsalState({ ...row, verdict: 'failed' }, { now: 0, currentDigest: 'q' }), 'failed');
});

// ── HTTP: the whole teacher journey on the real routes ─────────────────────────────────────────────────────────────
const f = await localOps(); f.env.HPS_LESSON_BINDINGS = 'enforce'; f.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
const course = f.lesson.course_id, V1 = f.lesson.version, VA = 'm2026.09.22-11', VB = 'm2026.09.22-12', VB2 = 'm2026.09.22-13';
const authoring = `/admin/cohorts/${f.cohort}/authoring/${course}`;
const students = ['a', 'b', 'c'].map((x, i) => ({ seat_id: 'A' + (i + 1), student_id: 'student-' + x }));
const one = (sql, ...a) => { const r = f.db.prepare(sql).get(...a); return r ? { ...r } : r; };
try {
  await setRoster(f.env.HPS_KV, f.cohort, [...students.map((s) => s.student_id), 'rehearsal-t1']);
  await f.freeze(course, V1, ['intro', 'build', 'review']);
  const saveDraft = async (content) => { const cur = (await f.request(authoring)).json; const r = await f.request(authoring, 'PUT', { profile_id: f.profile, request_id: KEY(), expected_revision: cur.revision, content }); assert.equal(r.status, 200, r.raw); return r.json.revision; };
  const freeze = async (version, content) => { const rev = await saveDraft(content); const r = await f.request(`${authoring}/versions/${version}`, 'PUT', { expected_revision: rev }); assert.equal(r.status, 200, r.raw); assert.equal(r.json.rehearsal, 'not_run', 'a freshly frozen candidate is not rehearsed'); return r.json; };
  const readiness = async (v) => (await f.request(`${authoring}/versions/${v}/readiness`)).json;
  const rehearse = async (v, learner = 'rehearsal-t1', request_id = KEY()) => f.request(`${authoring}/versions/${v}/rehearsals`, 'POST', { learner, request_id });
  async function ask(token, { step, help, tools = READ } = {}) {
    const ctx = makeCtx();
    return withMockUpstream(() => new Response(JSON.stringify(anthropicJsonBody({ text: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } }), async (calls) => {
      const r = await f.app.fetch(new Request('https://service.test/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(step ? { 'x-hps-lesson-step': step } : {}), ...(help ? { 'x-hps-help-mode': help } : {}) },
        body: JSON.stringify({ model: 'claude-mock', max_tokens: 64, tools: tools.map((name) => ({ name, description: name, input_schema: { type: 'object' } })), messages: [{ role: 'user', content: '합성 질문' }] }) }), f.env, ctx);
      const text = await r.text(); await ctx.settle();
      return { status: r.status, help: r.headers.get('x-hps-help-mode'), system: calls.map((x) => String(x.init.body)).join('\n'), text };
    });
  }
  const send = (token, body) => f.request('/v1/classroom/rehearsal/report', 'POST', body, token);

  let passA;
  await check('A: candidate → rehearsal code → requests under the code → App report → passed; the code is a learner credential, not readiness', async () => {
    await freeze(VA, CURRICULUM_A);
    const issued = await rehearse(VA); assert.equal(issued.status, 200, issued.raw); assert.equal(issued.json.state, 'running');
    assert.equal((await readiness(VA)).state, 'running', 'issuing the code is not a pass');
    const prof = await (await f.app.fetch(new Request('https://service.test/v1/profile', { headers: { authorization: 'Bearer ' + issued.json.token } }), f.env, makeCtx())).json();
    assert.ok(prof.rehearsal, JSON.stringify(Object.keys(prof)) + JSON.stringify(prof.lesson?.version)); assert.equal(prof.rehearsal.id, issued.json.rehearsal_id); assert.equal(prof.lesson.version, VA); assert.equal(prof.sdk_tools.write, false, 'A keeps read only — the served profile is what a learner would get');
    const early = await send(issued.json.token, report(CURRICULUM_A)); assert.deepEqual([early.status, early.json.reason], [409, 'no_request_yet'], 'nothing asked yet is not judged');
    const r1 = await ask(issued.json.token, { step: 'criteria' }); assert.equal(r1.status, 200, r1.text);
    assert.match(r1.help, /mode=hint; source=lesson_default; step=criteria/); assert.match(r1.system, /힌트 받기/); assert.match(r1.system, /처음 만들어 보는 원장님/, 'the audience reaches the model boundary');
    const r2 = await ask(issued.json.token, { step: 'criteria', help: 'independent' }); assert.match(r2.help, /mode=independent; source=student/);
    assert.equal((await ask(issued.json.token, { step: 'criteria', help: 'co_edit' })).status, 409, 'a help mode the step does not offer is refused, never silently unlocked');
    const done = await send(issued.json.token, report(CURRICULUM_A)); assert.equal(done.status, 200, done.raw); assert.equal(done.json.verdict, 'passed', done.raw);
    assert.deepEqual(done.json.checks.turns.help_modes, ['hint', 'independent']);
    const ready = await readiness(VA); assert.equal(ready.state, 'passed'); assert.equal(ready.rehearsal.app.extension_version, '0.1.test'); passA = issued.json;
    assert.deepEqual(await send(issued.json.token, report(CURRICULUM_A)).then((x) => x.json.verdict), 'passed', 'the same report again returns the stored verdict');
    const other = await send(issued.json.token, report(CURRICULUM_A, { look: { visited: false } })); assert.deepEqual([other.status, other.json.reason], [409, 'already_judged'], 'a verdict is written once');
  });

  await check('in-flight edit race: B saved while A runs; A passes for A only; B stays untested and cannot be confirmed on A\'s pass', async () => {
    const aAgain = await rehearse(VA); const tok = aAgain.json.token;
    await saveDraft(CURRICULUM_B); // the teacher edits while the rehearsal of A is still running
    assert.equal((await readiness(VA)).draft_changed_since, true);
    await ask(tok, { step: 'criteria' });
    assert.equal((await send(tok, report(CURRICULUM_A))).json.verdict, 'passed');
    const cur = (await f.request(authoring)).json; const fr = await f.request(`${authoring}/versions/${VB}`, 'PUT', { expected_revision: cur.revision }); assert.equal(fr.status, 200, fr.raw);
    assert.equal(fr.json.rehearsal, 'not_run'); assert.equal((await readiness(VB)).state, 'not_run', 'B inherits nothing');
    const steal = await f.request(`${authoring}/versions/${VB}/confirmation`, 'POST', { rehearsal_id: aAgain.json.rehearsal_id, request_id: KEY() });
    assert.deepEqual([steal.status, steal.json.reason], [409, 'rehearsal_not_latest']);
    assert.equal((await readiness(VA)).state, 'passed', 'reopening/retrying keeps A\'s own result');
    const list = (await f.request(authoring + '/versions')).json; assert.deepEqual(list.versions.filter((v) => [VA, VB].includes(v.version)).map((v) => [v.version, v.rehearsal]), [[VB, 'not_run'], [VA, 'passed']]);
    passA = aAgain.json;
  });

  await check('failure and unsupported are their own results; a report after expiry is refused', async () => {
    await freeze(VB2, { ...CURRICULUM_B, title: '고쳐 보기 (재시험)' });
    const x = await rehearse(VB2); await ask(x.json.token, { step: 'revise', tools: READ });
    const failed = await send(x.json.token, report(CURRICULUM_B)); assert.deepEqual([failed.json.verdict, failed.json.reasons], ['failed', ['allowed_tool_missing']]);
    assert.equal((await readiness(VB2)).state, 'failed');
    const y = await rehearse(VB2); await ask(y.json.token, { step: 'revise', tools: [...READ, ...WRITE] });
    const un = await send(y.json.token, report(CURRICULUM_B, { revise: { surface: 'unsupported:decision_form' } })); assert.equal(un.json.verdict, 'unsupported');
    assert.equal((await readiness(VB2)).state, 'unsupported');
    const z = await rehearse(VB2); await ask(z.json.token, { step: 'revise', tools: [...READ, ...WRITE] });
    f.db.prepare('UPDATE authoring_rehearsals SET expires_at=1 WHERE rehearsal_id=?').run(z.json.rehearsal_id);
    assert.equal((await readiness(VB2)).state, 'expired');
    assert.deepEqual(await send(z.json.token, report(CURRICULUM_B)).then((r) => [r.status, r.json.reason]), [410, 'rehearsal_expired']);
  });

  await check('authority: only the course owner issues; the learner must be on the roster of an open session; ordinary codes cannot report', async () => {
    assert.equal((await f.request(`${authoring}/versions/${VA}/rehearsals`, 'POST', { learner: 'rehearsal-t1', request_id: KEY() }, await f.teacher('teacher-b'))).status, 404);
    assert.deepEqual(await rehearse(VA, 'not-registered').then((r) => [r.status, r.json.reason]), [403, 'learner_not_in_roster']);
    const plain = (await issue({ u: 'student-a', c: f.cohort, p: f.profile, lesson: { course_id: course, version: VA, sha256: passA ? (await readLesson(f.env, f.cohort, course, VA, f.profile)).sha256 : '' } }, 1, TEST_SECRET)).token;
    assert.deepEqual(await send(plain, report(CURRICULUM_A)).then((r) => [r.status, r.json.reason]), [403, 'not_rehearsal']);
    const id = KEY(), first = await rehearse(VA, 'rehearsal-t1', id), again = await rehearse(VA, 'rehearsal-t1', id);
    assert.equal(again.json.rehearsal_id, first.json.rehearsal_id, 'a retried issue (lost response) is the same rehearsal, not a second one');
    assert.equal((await rehearse(VB, 'rehearsal-t1', id)).status, 409, 'the request id cannot be reused for another version');
  });

  await check('confirmation: only the latest passed, current rehearsal of this exact version; a changed policy makes it stale', async () => {
    // The latest rehearsal of A is the retried one above (running): A cannot be confirmed until it is judged.
    const latest = (await readiness(VA)).rehearsal.id;
    assert.deepEqual(await f.request(`${authoring}/versions/${VA}/confirmation`, 'POST', { rehearsal_id: latest, request_id: KEY() }).then((r) => [r.status, r.json.reason]), [409, 'rehearsal_not_passed']);
    const run = await rehearse(VA); await ask(run.json.token, { step: 'criteria' }); assert.equal((await send(run.json.token, report(CURRICULUM_A))).json.verdict, 'passed');
    // A policy change after the pass (simulated on the stored digest: compiled profiles are code) → stale, not confirmable.
    const keep = one('SELECT policy_digest FROM authoring_rehearsals WHERE rehearsal_id=?', run.json.rehearsal_id).policy_digest;
    f.db.prepare('UPDATE authoring_rehearsals SET policy_digest=? WHERE rehearsal_id=?').run('0'.repeat(64), run.json.rehearsal_id);
    assert.equal((await readiness(VA)).state, 'stale');
    assert.deepEqual(await f.request(`${authoring}/versions/${VA}/confirmation`, 'POST', { rehearsal_id: run.json.rehearsal_id, request_id: KEY() }).then((r) => [r.status, r.json.reason]), [409, 'rehearsal_stale']);
    f.db.prepare('UPDATE authoring_rehearsals SET policy_digest=? WHERE rehearsal_id=?').run(keep, run.json.rehearsal_id);
    const ok = await f.request(`${authoring}/versions/${VA}/confirmation`, 'POST', { rehearsal_id: run.json.rehearsal_id, request_id: KEY() }); assert.equal(ok.status, 200, ok.raw);
    assert.equal((await f.request(`${authoring}/versions/${VA}/confirmation`, 'POST', { rehearsal_id: run.json.rehearsal_id, request_id: KEY() })).status, 200, 'idempotent');
    const ready = await readiness(VA); assert.equal(ready.confirmed.rehearsal_id, run.json.rehearsal_id); assert.equal(ready.confirmation_current, true);
  });

  await check('reuse and review: a frozen version reopens as a draft body without Service bindings; impact names help, surface, text and tool changes', async () => {
    const ready = await readiness(VA); assert.equal(ready.content.features.binding, undefined, 'bindings are Service-produced and stripped for reuse');
    assert.equal(ready.content.steps[0].help.default, 'hint');
    const imp = (await f.request(`${authoring}/impact?from=${VA}&to=${VB}`)).json.impact;
    assert.deepEqual(imp.steps, { kept: [], removed: ['criteria', 'look'], added: ['revise'] });
    assert.deepEqual(imp.features, { from: ['read'], to: ['read', 'write'] });
    assert.ok(imp.text.some((t) => t.field === 'audience'));
    await saveDraft({ ...CURRICULUM_A, steps: [{ ...CURRICULUM_A.steps[0], help: { default: 'independent', allowed: ['independent'] }, ui: 'decision_form' }, CURRICULUM_A.steps[1]] });
    const d = (await f.request(`${authoring}/impact?from=${VA}&to=draft`)).json.impact.step_changes;
    assert.deepEqual(d.map((x) => [x.id, x.help?.to?.default, x.surface?.to]), [['criteria', 'independent', 'decision_form']]);
    assert.equal((await f.request(`${authoring}/impact?from=nope&to=draft`)).status, 400);
  });

  await check('gate (HPS_LESSON_CONFIRMATION=require): invitations and class switches only to a confirmed version; off keeps today\'s behaviour', async () => {
    const { issueIssuer } = await import('../src/lib/tokens.ts');
    const owner = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: f.cohort, profiles: [f.profile], ops: OPS_ALL }] }, 3, TEST_SECRET)).token;
    const invite = (v) => f.request(`${authoring}/versions/${v}/participants`, 'POST', { user: 'student-c', hours: 1 }, owner);
    assert.equal((await invite(VB)).status, 200, 'unset: an unconfirmed version is still usable, exactly as before');
    f.env.HPS_LESSON_CONFIRMATION = 'require';
    assert.deepEqual(await invite(VB).then((r) => [r.status, r.json.reason]), [409, 'version_not_confirmed']);
    const okA = await invite(VA); assert.equal(okA.status, 200, okA.raw); assert.equal(okA.json.rehearsal, 'passed');
    // The class run pins V1; a setting may switch to confirmed A but not to unconfirmed B, and the base is never blocked.
    assert.equal((await f.configure(students, 0, { flags: { ops_observe: true, ops_commands: true, ops_distribute: true, ops_lesson_settings: true } })).status, 201);
    const L = await f.teacher('teacher-l', [...OPS_ALL, 'distribute', 'lesson_settings']);
    const opts = await f.request(f.base + '/setting-options', 'GET', undefined, L); assert.equal(opts.status, 200, opts.raw);
    const by = Object.fromEntries(opts.json.options.map((o) => [o.version, [o.selectable, o.reason, o.confirmed]]));
    assert.deepEqual(by[VA], [true, '', true]); assert.deepEqual(by[VB], [false, 'not_confirmed', false]); assert.deepEqual(by[V1], [true, '', false], 'the run\'s own version stays selectable (the return)');
    const sha = async (v) => (await readLesson(f.env, f.cohort, course, v, f.profile)).sha256;
    const save = (lesson) => f.request(f.base + '/contents', 'POST', { idempotency_key: KEY(), kind: 'setting', title: '설정', body: '수업 설정을 바꿉니다.', lesson }, L);
    assert.deepEqual(await save({ course_id: course, version: VB, sha256: await sha(VB) }).then((r) => [r.status, r.json.reason]), [409, 'version_not_confirmed']);
    assert.equal((await save({ course_id: course, version: VA, sha256: await sha(VA) })).status, 201);
    delete f.env.HPS_LESSON_CONFIRMATION;
  });
} finally { f.close(); }
console.log(`${passed} authoring rehearsal checks passed`);
