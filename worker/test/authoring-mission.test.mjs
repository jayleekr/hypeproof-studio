// #751 G2 mission — the lesson's `learning` block (week, mission, completion) through authoring: saved and reopened with its
// preserved fields, refused when invalid, named in the difference review, frozen into a candidate, carried to the model by
// the Service, and checked in the rehearsal against what the learner's mission header DREW. Real Service routing + SQLite +
// token verifier; the model provider is a recorder. Nothing about a real model or a real App window (that is the Mac run).
import assert from 'node:assert/strict';
import { localOps } from './harness/classroom-ops.mjs';
import { makeCtx, withMockUpstream, anthropicJsonBody } from './harness/index.mjs';

const R = await import('../src/lib/lesson-rehearsal.ts');
const { getProfile } = await import('../src/profiles/index.ts');
const { setRoster } = await import('../src/lib/kv.ts');
const { SCORE_REFUSAL } = await import('../src/lib/learning-design.ts');
let passed = 0; const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
const KEY = () => crypto.randomUUID();

// Same shape as authoring-rehearsal.test.mjs's curriculum A (that file runs its own journey on import, so it is not imported).
const CURRICULUM_A = { schema: 'hps-session-design/1', duration_minutes: 60, prerequisites: '코딩 경험 불필요', starter: '예약 안내 페이지 예제 폴더', title: '첫 시제품 — 예약 안내 페이지', audience: '처음 만들어 보는 원장님', objective: '예약 안내 페이지의 첫 판을 만들고 확인 기준을 스스로 정한다',
  steps: [
    { id: 'criteria', title: '확인 기준 정하기', instructions: '페이지가 무엇을 보여줘야 하는지 한 줄 기준을 적는다.\n제출 증거: 저장한 확인 기준', hint: '', acceptance: '저장한 확인 기준 한 줄이 있다', help: { default: 'hint', allowed: ['hint', 'independent'] }, ui: 'criterion_form' },
    { id: 'look', title: '예제 살펴보기', instructions: '예제 페이지를 열어 기준과 비교한다.\n제출 증거: 비교 메모', hint: '', acceptance: '기준에 맞는 곳과 아닌 곳을 하나씩 말한다' },
  ],
  features: { allowed: ['read'] } };
const MA = { week: 2, mission: '예약 버튼이 첫 화면에서 보이게 만든다', completion: [{ id: 'c1', text: '확인 기준을 먼저 적었다', event: 'criterion_set' }, { id: 'c2', text: '직접 눌러 확인했다', event: 'test_observed' }],
  observe: ['기대 조건을 먼저 정하는가'], never: ['측정을 위해 고의 오류를 넣지 않는다'] };
const WITH_A = { ...CURRICULUM_A, learning: MA };
/** What MissionHeader.tsx draws for a learning block — the App reads exactly this back from the DOM. */
const drawn = (l) => l ? { week: l.week + '주차', sentence: l.mission, completion: (l.completion ?? []).map((c) => c.text) } : { week: null, sentence: '미션이 정해지지 않았습니다.', completion: [] };
const report = (content, mission) => ({ schema: 'hps-rehearsal-report/1', app: { extension_version: '0.1.test', host: 'test', runtime: 'agent-sdk', os: 'darwin', arch: 'arm64' },
  steps: content.steps.map((s) => ({ id: s.id, visited: true, help_offered: s.help?.allowed ?? [], help_default: s.help?.default ?? null, surface: s.ui ?? 'chat' })), ...(mission === undefined ? {} : { mission }) });
const profile = getProfile('boah-dental-director-copyclone-2026-s1');
const turn = (sha) => ({ request_id: KEY(), lesson_sha256: sha, step_id: 'criteria', help_receipt: 'mode=hint; source=lesson_default; step=criteria', runtime: 'agent-sdk', tool_names: ['Glob', 'Grep', 'Read'], outcome: 'completed' });
const judge = (content, mission) => R.judgeRehearsal({ content, lessonSha: 'a', profile, report: report(content, mission), turns: [turn('a')] });

await check('judge — the mission the learner saw must be the candidate\'s own, word for word', async () => {
  const ok = judge(WITH_A, drawn(MA)); assert.equal(ok.verdict, 'passed', JSON.stringify(ok)); assert.equal(ok.checks.mission.result, 'match');
  assert.deepEqual(ok.checks.mission.expected, { week: '2주차', sentence: MA.mission, completion: ['확인 기준을 먼저 적었다', '직접 눌러 확인했다'] });
  // Negative controls: a stale header (another version's mission), an unset header, a missing condition, a missing read-back.
  const stale = judge(WITH_A, drawn({ ...MA, mission: '이전 버전의 미션' })); assert.deepEqual([stale.verdict, stale.reasons, stale.checks.mission.result], ['failed', ['mission_mismatch'], 'mismatch']);
  assert.deepEqual(judge(WITH_A, drawn(null)).reasons, ['mission_mismatch'], '“미션이 정해지지 않았습니다.” cannot pass a candidate that has a mission');
  assert.deepEqual(judge(WITH_A, { ...drawn(MA), completion: ['확인 기준을 먼저 적었다'] }).reasons, ['mission_mismatch']);
  assert.deepEqual(judge(WITH_A, { ...drawn(MA), week: '3주차' }).reasons, ['mission_mismatch']);
  assert.deepEqual(judge(WITH_A, undefined).reasons, ['mission_not_reported'], 'an App that does not read the header back cannot earn a mission-linked pass');
});
await check('judge — a lesson without a mission (legacy) makes no mission claim and still passes on its own terms', async () => {
  const legacy = judge(CURRICULUM_A, drawn(null)); assert.deepEqual([legacy.verdict, legacy.checks.mission.result, legacy.checks.mission.expected], ['passed', 'none', null]);
  assert.equal(judge(CURRICULUM_A, undefined).checks.mission.result, 'none', 'an older App on a legacy lesson is not failed for a mission it could not have');
  assert.deepEqual(judge(CURRICULUM_A, drawn(MA)).reasons, ['mission_mismatch'], 'a header showing a mission the candidate does not have is wrong too');
  assert.equal(R.parseReport(report(CURRICULUM_A, { week: null, sentence: 'x'.repeat(241), completion: [] })), 'invalid mission');
  assert.equal(R.parseReport(report(CURRICULUM_A, { week: 2, sentence: 'x', completion: [] })), 'invalid mission', 'the week is read back as the text drawn');
  assert.equal(typeof R.parseReport(report(CURRICULUM_A, { week: '2주차', sentence: '두 줄\n미션', completion: [] })), 'object', 'a line break the teacher typed is drawn text, not an error');
});

const f = await localOps(); f.env.HPS_LESSON_BINDINGS = 'enforce'; f.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
const course = f.lesson.course_id, V1 = f.lesson.version, VM = 'm2026.09.22-41', VM2 = 'm2026.09.22-42', VL = 'm2026.09.22-43';
const authoring = `/admin/cohorts/${f.cohort}/authoring/${course}`;
try {
  await setRoster(f.env.HPS_KV, f.cohort, ['rehearsal-t1']);
  await f.freeze(course, V1, ['intro', 'build', 'review']);
  const put = async (content) => { const cur = (await f.request(authoring)).json; return f.request(authoring, 'PUT', { profile_id: f.profile, request_id: KEY(), expected_revision: cur.revision, content }); };
  const saveDraft = async (content) => { const r = await put(content); assert.equal(r.status, 200, r.raw); return r.json.revision; };
  const freeze = async (version, content) => { const rev = await saveDraft(content); const r = await f.request(`${authoring}/versions/${version}`, 'PUT', { expected_revision: rev }); assert.equal(r.status, 200, r.raw); };
  const readiness = async (v) => (await f.request(`${authoring}/versions/${v}/readiness`)).json;
  const rehearse = async (v) => { const r = await f.request(`${authoring}/versions/${v}/rehearsals`, 'POST', { learner: 'rehearsal-t1', request_id: KEY() }); assert.equal(r.status, 200, r.raw); return r.json; };
  const send = (token, body) => f.request('/v1/classroom/rehearsal/report', 'POST', body, token);
  async function ask(token, step = 'criteria') {
    const ctx = makeCtx();
    return withMockUpstream(() => new Response(JSON.stringify(anthropicJsonBody({ text: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } }), async (calls) => {
      const r = await f.app.fetch(new Request('https://service.test/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-hps-lesson-step': step },
        body: JSON.stringify({ model: 'claude-mock', max_tokens: 64, tools: ['Read'].map((name) => ({ name, description: name, input_schema: { type: 'object' } })), messages: [{ role: 'user', content: '합성 질문' }] }) }), f.env, ctx);
      await r.text(); await ctx.settle(); return { status: r.status, system: calls.map((x) => String(x.init.body)).join('\n') };
    });
  }

  await check('save/reopen: week, mission and completion round-trip; the fields the page does not edit (observe, never) survive', async () => {
    await saveDraft(WITH_A);
    const back = (await f.request(authoring)).json.content.learning; assert.deepEqual(back, MA);
  });
  await check('invalid: the existing validator refuses a mission-less, out-of-range or scored learning block; nothing is saved', async () => {
    const before = (await f.request(authoring)).json.revision;
    for (const [learning, error] of [[{ week: 2 }, 'invalid learning fields'], [{ week: 2, mission: '   ' }, 'invalid learning.mission'], [{ week: 0, mission: 'x' }, 'invalid learning.week'],
      [{ week: 2, mission: 'x'.repeat(201) }, 'invalid learning.mission'], [{ week: 2, mission: 'x', completion: [{ id: 'c1', text: '', event: 'criterion_set' }] }, 'invalid learning.completion'],
      [{ week: 2, mission: 'x', completion: [{ id: 'c1', text: '조건', event: 'criterion_set', level: 3 }] }, SCORE_REFUSAL]]) {
      const r = await put({ ...CURRICULUM_A, learning }); assert.deepEqual([r.status, r.json.error], [400, error], JSON.stringify(learning));
    }
    assert.equal((await f.request(authoring)).json.revision, before);
  });
  await check('candidate: the frozen mission is the candidate\'s identity — readiness, version list and the model request all carry it', async () => {
    await freeze(VM, WITH_A);
    const ready = await readiness(VM); assert.deepEqual(ready.content.learning, MA);
    const listed = (await f.request(authoring + '/versions')).json.versions.find((v) => v.version === VM); assert.deepEqual(listed.mission, { week: 2, mission: MA.mission });
    const code = await rehearse(VM); const r = await ask(code.token); assert.equal(r.status, 200);
    assert.match(r.system, /\[학습 설계\] 2주차 · 이번 주 미션: \\?"예약 버튼이 첫 화면에서 보이게 만든다/, 'the Service builds the coach context from the candidate\'s mission');
    assert.match(r.system, /측정을 위해 고의 오류를 넣지 않는다/); assert.doesNotMatch(r.system, /기대 조건을 먼저 정하는가/, 'observe stays hidden from the coach (SX-57)');
    const done = await send(code.token, report(WITH_A, drawn(MA))); assert.equal(done.json.verdict, 'passed', done.raw); assert.equal(done.json.checks.mission.result, 'match');
    assert.equal((await readiness(VM)).rehearsal.checks.mission.result, 'match', 'the teacher sees the mission check with the verdict');
  });
  await check('edit during rehearsal: a mission edited while a rehearsal runs is a new candidate; the old one keeps only its own result; a header showing the edited mission fails the old one', async () => {
    const running = await rehearse(VM); await ask(running.token);
    const MB = { ...MA, mission: '고친 이유를 한 줄로 남긴다', completion: [{ id: 'c1', text: '고른 이유를 적었다', event: 'decision_revised' }] };
    await saveDraft({ ...WITH_A, learning: MB });
    assert.equal((await readiness(VM)).draft_changed_since, true);
    const wrong = await send(running.token, report(WITH_A, drawn(MB))); assert.deepEqual([wrong.json.verdict, wrong.json.reasons], ['failed', ['mission_mismatch']], 'a window showing the edited draft\'s mission is not the candidate');
    const cur = (await f.request(authoring)).json; assert.equal((await f.request(`${authoring}/versions/${VM2}`, 'PUT', { expected_revision: cur.revision })).status, 200);
    assert.equal((await readiness(VM2)).state, 'not_run', 'the edited mission inherits nothing');
    const imp = (await f.request(`${authoring}/impact?from=${VM}&to=${VM2}`)).json.impact.learning;
    assert.deepEqual([imp.week, imp.mission, imp.completion, imp.advanced, imp.from.mission, imp.to.mission], [false, true, true, [], MA.mission, MB.mission]);
    assert.deepEqual(imp.to.completion, [{ text: '고른 이유를 적었다', event: 'decision_revised' }]);
  });
  await check('legacy: a lesson without learning saves, freezes and rehearses exactly as before — no mission is invented, no mission claim is made', async () => {
    await freeze(VL, CURRICULUM_A);
    const ready = await readiness(VL); assert.equal(ready.content.learning, undefined); assert.equal((await f.request(authoring + '/versions')).json.versions.find((v) => v.version === VL).mission, null);
    const code = await rehearse(VL); const r = await ask(code.token); assert.doesNotMatch(r.system, /\[학습 설계\]/);
    const done = await send(code.token, report(CURRICULUM_A, drawn(null))); assert.deepEqual([done.json.verdict, done.json.checks.mission.result], ['passed', 'none']);
    const imp = (await f.request(`${authoring}/impact?from=${VL}&to=${VM}`)).json.impact.learning; assert.deepEqual([imp.from, imp.to.week, imp.mission], [null, 2, true]);
    assert.equal((await f.request(`${authoring}/impact?from=${V1}&to=${VL}`)).json.impact.learning, null, 'no learning on either side: nothing to say');
  });
  await check('advanced-only change is named, not hidden: never/observe edits elsewhere show as a learning change', async () => {
    const other = { ...MA, never: ['다른 금지 사항'] }; await saveDraft({ ...WITH_A, learning: other });
    const imp = (await f.request(`${authoring}/impact?from=${VM}&to=draft`)).json.impact.learning; assert.deepEqual([imp.mission, imp.completion, imp.advanced], [false, false, ['never']]);
  });
} finally { f.close(); }
console.log(`${passed} authoring mission checks passed`);
