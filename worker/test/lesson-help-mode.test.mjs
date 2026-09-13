// #1008 (AE-10, AE-36, EDU-02) — a frozen lesson step offers help modes and the
// student's choice reaches the model for the next run.
// Design: docs/design/learning-agent-experience.md "도움을 조절하는 계약".
//
// What this file separates, because the design says they are different values:
//   - the help STRATEGY reaches the model (asserted on the real upstream body)
//   - the execution GRANT does not move (upstream body minus `system` is
//     byte-identical across modes, and /v1/profile flags are identical)
//   - the receipt never turns a selection into observed performance
// Every refusal is paired with an accepted control on the same lesson, so a
// gate that refused everything would fail here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localAuthoring } from './harness/dental-authoring.mjs';
import { withMockUpstream, anthropicStreamBody, TEST_SECRET } from './harness/index.mjs';
const { getProfile } = await import('../src/profiles/index.ts');
const { HELP_MODES, HELP_MODE_LABELS, resolveHelpMode, helpModeInstruction } = await import('../src/lib/lesson-help-mode.ts');
const { validateSessionDesign } = await import('../src/lib/session-design.ts');
const { setRoster, startSession } = await import('../src/lib/kv.ts');
const { issue } = await import('../src/lib/tokens.ts');

const local = await localAuthoring({ profileId: 'homepage-practice-s1' });
local.env.LLM_PROVIDER = 'anthropic';
local.env.ANTHROPIC_API_KEY = 'synthetic-provider-key';
local.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort, 'Synthetic help modes');
local.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
  .run('help', local.cohort, local.profileId, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 3600000).toISOString());

const profile = getProfile(local.profileId);
const originalRuntime = profile.coach_runtime;

const offered = { default: 'hint', allowed: ['hint', 'co_edit', 'independent'] };
const baseStep = { title: '확인', instructions: '영업시간 확인', hint: '', acceptance: '수정 이유 설명' };
const content = (help = offered) => ({
  schema: 'hps-session-design/1', title: '가상 꽃집', audience: '합성 사용자',
  duration_minutes: 60, objective: '영업시간 검토', prerequisites: '', starter: '연습 폴더',
  steps: [{ id: 'one', ...baseStep, ...(help ? { help } : {}) }, { id: 'two', ...baseStep }],
});
const base = '/admin/cohorts/' + local.cohort + '/authoring/';
const request = async (path, method = 'GET', body, token = local.token, extra = {}) => {
  const r = await local.fetcher(local.origin + path, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json(), headers: r.headers };
};
const save = c => ({ profile_id: local.profileId, request_id: crypto.randomUUID(), expected_revision: 0, content: c });
const answer = Response.json({
  id: 'synthetic-message', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: '확인했습니다.' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 },
});
const ask = { model: 'hypeproof-default', max_tokens: 32, messages: [{ role: 'user', content: '영업시간을 확인해 주세요.' }] };
// One upstream observation per call: status, receipt, and the exact body the provider saw.
const run = async (token, headers, route = '/v1/messages', body = ask) => {
  let upstream = null;
  const r = await withMockUpstream((_u, init) => { upstream = JSON.parse(init.body); return answer.clone(); },
    () => request(route, 'POST', body, token, headers));
  return { ...r, upstream, receipt: r.headers.get('x-hps-help-mode') };
};
const systemText = body => JSON.stringify(body?.system ?? body?.messages?.filter(m => m.role === 'system') ?? '');
const withoutSystem = body => { const { system: _s, ...rest } = body; return rest; };

try {
  await setRoster(local.env.HPS_KV, local.cohort, ['student']);
  await startSession(local.env.HPS_KV, local.cohort, {
    session_id: 'help', profile_id: local.profileId,
    starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(),
  });

  // ── Names: no raw key reaches a person ───────────────────────────────────
  for (const m of HELP_MODES) assert.ok(HELP_MODE_LABELS[m] && HELP_MODE_LABELS[m] !== m, `${m} 에 이름표가 없다`);

  // ── Schema: the old step shape stays valid; malformed help is refused ────
  assert.equal(validateSessionDesign(content(null), true), null, 'a step without help is unchanged (old lessons)');
  assert.equal(validateSessionDesign(content(), true), null);
  for (const help of [
    { default: 'hint', allowed: [] },                        // nothing offered
    { default: 'demonstrate', allowed: ['hint'] },           // default outside allowed
    { default: 'hint', allowed: ['hint', 'hint'] },          // duplicate
    { default: 'hint', allowed: ['solve_for_me'] },          // not a mode
    { default: 'hint', allowed: ['hint'], grant: 'shell' },  // unknown key — content cannot smuggle a grant
    { allowed: ['hint'] },                                   // default required
  ]) {
    assert.match(validateSessionDesign(content(help), true) ?? '', /step one/, JSON.stringify(help));
    assert.equal((await request(base + 'invalid', 'PUT', save(content(help)))).status, 400, JSON.stringify(help));
  }

  // ── Freeze a lesson with help on step one, none on step two ───────────────
  const seat = async slug => {
    assert.equal((await request(base + slug, 'PUT', save(slug === 'plain' ? content(null) : content()))).status, 200);
    const frozen = await request(base + slug + '/versions/m2026.09.13-1', 'PUT', { expected_revision: 1 });
    assert.equal(frozen.status, 200, JSON.stringify(frozen.json));
    return (await request(base + slug + '/versions/m2026.09.13-1/participants', 'POST', { user: 'student', hours: 1 })).json.token;
  };
  const token = await seat('helped');

  // The step's offer is served with the lesson so an app can draw the choice.
  const view = await request('/v1/profile', 'GET', undefined, token);
  assert.equal(view.status, 200, JSON.stringify(view.json));
  assert.deepEqual(view.json.lesson.content.steps[0].help, offered);

  // ── POSITIVE: default applies when the student has not chosen ────────────
  const byDefault = await run(token, { 'x-hps-lesson-step': 'one' });
  assert.equal(byDefault.status, 200, JSON.stringify(byDefault.json));
  assert.equal(byDefault.receipt, 'mode=hint; source=lesson_default; step=one; performance=unobserved');
  assert.ok(systemText(byDefault.upstream).includes("'힌트 받기'"), 'default hint instruction must reach the provider');

  // ── POSITIVE: the student's allowed choice applies to this run ────────────
  const chosen = await run(token, { 'x-hps-lesson-step': 'one', 'x-hps-help-mode': 'co_edit' });
  assert.equal(chosen.status, 200);
  assert.equal(chosen.receipt, 'mode=co_edit; source=student; step=one; performance=unobserved');
  assert.ok(systemText(chosen.upstream).includes("'함께 수정'"));
  assert.ok(!systemText(chosen.upstream).includes("'힌트 받기'이며"), 'only the selected mode is instructed');

  // ── NEGATIVE: independent is a strategy, not evidence ────────────────────
  const independent = await run(token, { 'x-hps-lesson-step': 'one', 'x-hps-help-mode': 'independent' });
  assert.equal(independent.status, 200);
  assert.match(independent.receipt, /performance=unobserved/, 'selecting independent must not record independent performance');
  assert.ok(systemText(independent.upstream).includes('독립적으로 수행했다고 말하거나 판정하지 마세요'));

  // ── NEGATIVE: switching help never changes what the provider may do ──────
  // Everything except `system` must be identical, including tools and model.
  const toolAsk = { ...ask, tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } }] };
  const hintRun = await run(token, { 'x-hps-lesson-step': 'one', 'x-hps-help-mode': 'hint' }, '/v1/messages', toolAsk);
  const indRun = await run(token, { 'x-hps-lesson-step': 'one', 'x-hps-help-mode': 'independent' }, '/v1/messages', toolAsk);
  assert.deepEqual(withoutSystem(hintRun.upstream), withoutSystem(indRun.upstream));
  assert.notDeepEqual(hintRun.upstream.system, indRun.upstream.system, 'control: the instruction itself did change');

  // ── NEGATIVE: outside the offer is refused with a reason, never widened ──
  for (const [headers, status, code] of [
    [{ 'x-hps-lesson-step': 'one', 'x-hps-help-mode': 'demonstrate' }, 409, 'help_mode_not_allowed'],
    [{ 'x-hps-lesson-step': 'one', 'x-hps-help-mode': 'solve_for_me' }, 400, 'invalid_help_mode'],
    [{ 'x-hps-lesson-step': 'forged', 'x-hps-help-mode': 'hint' }, 409, 'lesson_step_unknown'],
    [{ 'x-hps-lesson-step': 'two', 'x-hps-help-mode': 'hint' }, 409, 'help_mode_not_offered'],
    [{ 'x-hps-help-mode': 'hint' }, 400, 'help_mode_step_required'],
  ]) {
    const r = await run(token, headers);
    assert.equal(r.status, status, JSON.stringify(headers));
    assert.equal(r.json.error.code, code);
    assert.equal(r.upstream, null, `${code}: a refused request must not reach the provider`);
    assert.equal(r.receipt, null);
  }
  const notAllowed = await run(token, { 'x-hps-lesson-step': 'one', 'x-hps-help-mode': 'demonstrate' });
  assert.match(notAllowed.json.error.message, /힌트 받기, 함께 수정, 직접 해보기/, 'the refusal names what IS available');

  // ── CONTROL: no headers, or a step without help, keeps today's behavior ──
  for (const headers of [{}, { 'x-hps-lesson-step': 'two' }]) {
    const r = await run(token, headers);
    assert.equal(r.status, 200, JSON.stringify(headers));
    assert.equal(r.receipt, null);
    assert.ok(!systemText(r.upstream).includes('[도움 방식]'), 'no help instruction without a resolved help');
  }

  // ── A seat with no lesson cannot pretend a mode applied ──────────────────
  const bare = (await issue({ c: local.cohort, u: 'student', p: local.profileId }, 1, TEST_SECRET)).token;
  const bareRun = await run(bare, { 'x-hps-help-mode': 'hint' });
  assert.equal(bareRun.status, 409, JSON.stringify(bareRun.json));
  assert.equal(bareRun.json.error.code, 'help_mode_not_offered');
  assert.equal((await run(bare, {})).status, 200, 'control: the same bare seat works without the header');

  // ── Proxy route carries the same instruction ─────────────────────────────
  profile.coach_runtime = 'proxy';
  try {
    const proxyToken = await seat('proxy-helped');
    const r = await run(proxyToken, { 'x-hps-lesson-step': 'one', 'x-hps-help-mode': 'co_edit' }, '/v1/chat/completions',
      { max_tokens: 32, messages: ask.messages, stream: false });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.receipt, 'mode=co_edit; source=student; step=one; performance=unobserved');
    assert.ok(systemText(r.upstream).includes("'함께 수정'"));
  } finally {
    profile.coach_runtime = originalRuntime;
  }

  // ── Streaming carries the same receipt (PR #1028 review) ─────────────────
  // Both streaming paths return a raw Response with their own header object,
  // which bypasses c.header() (chat.ts already notes this for x-request-id,
  // #580). Streaming is the ordinary student path, so a receipt that exists
  // only on JSON responses would be missing exactly where it matters.
  const streamRun = async (token, headers, route, body) => {
    let upstream = null;
    const r = await withMockUpstream((_u, init) => {
      upstream = JSON.parse(init.body);
      return new Response(anthropicStreamBody(['확인했습니다.']), { headers: { 'content-type': 'text/event-stream' } });
    }, () => local.fetcher(local.origin + route, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }));
    const text = await r.text();
    return { status: r.status, text, upstream, receipt: r.headers.get('x-hps-help-mode'), type: r.headers.get('content-type') };
  };
  {
    const s = await streamRun(token, { 'x-hps-lesson-step': 'one', 'x-hps-help-mode': 'co_edit' }, '/v1/messages', { ...ask, stream: true });
    assert.equal(s.status, 200, s.text);
    assert.match(s.type ?? '', /text\/event-stream/, 'instrument: /v1/messages actually took the streaming path');
    assert.ok(systemText(s.upstream).includes("'함께 수정'"), 'instrument: the instruction reached the provider on the stream');
    assert.equal(s.receipt, 'mode=co_edit; source=student; step=one; performance=unobserved', 'agent-sdk stream carries the help receipt');
    const none = await streamRun(token, { 'x-hps-lesson-step': 'two' }, '/v1/messages', { ...ask, stream: true });
    assert.equal(none.status, 200);
    assert.equal(none.receipt, null, 'control: no receipt on a stream without a resolved help');
  }
  profile.coach_runtime = 'proxy';
  try {
    const proxyToken = await seat('proxy-stream');
    const s = await streamRun(proxyToken, { 'x-hps-lesson-step': 'one' }, '/v1/chat/completions', { max_tokens: 32, messages: ask.messages, stream: true });
    assert.equal(s.status, 200, s.text);
    assert.match(s.type ?? '', /text\/event-stream/, 'instrument: /v1/chat/completions actually took the streaming path');
    assert.equal(s.receipt, 'mode=hint; source=lesson_default; step=one; performance=unobserved', 'proxy stream carries the help receipt');
  } finally {
    profile.coach_runtime = originalRuntime;
  }

  // ── Pure resolver edges ──────────────────────────────────────────────────
  const steps = content().steps;
  assert.deepEqual(resolveHelpMode(steps, '  one ', ' independent '), { ok: true, help: { step_id: 'one', mode: 'independent', source: 'student' } });
  assert.equal(resolveHelpMode(steps, 'one'.repeat(30), undefined).ok, false, 'an over-long step id is not looked up');
  assert.match(helpModeInstruction({ step_id: 'one', mode: 'hint', source: 'lesson_default' }), /도구 권한이나 정책을 바꾸지 않습니다/);

  console.log('lesson-help-mode: schema, default/choice, refusals, grant invariance, both routes — OK');
} finally {
  profile.coach_runtime = originalRuntime;
}
