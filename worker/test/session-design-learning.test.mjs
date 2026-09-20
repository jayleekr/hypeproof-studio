// SX-55 · SX-56 · SX-57 · SX-58 · SX-59 — hps-session-design/1 의 learning 확장.
//
// 설계: docs/design/studio-learning-experience.md "세션 설계 파일 (Module)".
// 요구: docs/requirements/studio-learning-experience.md SX-55~59.
//
// 대조군 규율(.claude/rules/verification.md 규칙 2·3):
//
//   양성 대조(심은 정답)  설계 문서의 3주차 JSON을 **그대로** fixture 로 두고
//                        validateSessionDesign(content, true) === null 을 요구한다.
//                        계약 문서와 검증기가 어긋나면 여기서 즉시 드러난다.
//   불변 대조            learning 이 없는 설계는 오늘과 똑같이 통과해야 한다.
//                        이 확장이 기존 수업을 건드리지 않았다는 증거다.
//   음성 대조            결함을 **하나씩** 심어 그 규칙만 정확히 깨어나는지 센다.
//
// 이 파일은 learning-design.ts 를 모듈 최상위에서 import 하지 않는다. 변경 전
// 코드에서도 끝까지 돌아야 대조군 역할을 하기 때문이다(그때는 learning 키가
// 상위 allowlist 에 없어 "invalid session-design fields" 로 빨갛게 죽는다).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { validateSessionDesign } = await import('../src/lib/session-design.ts');

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n      ${String(e && e.message).replace(/\s*\n\s*/g, ' | ')}`); }
};

const fixture = (n) =>
  JSON.parse(readFileSync(new URL(`./fixtures/session-design/week-${n}.json`, import.meta.url), 'utf8'));
const week3 = () => fixture(3);

// 진단 한 줄. 판정이 아니라 관측이다 — 변경 전에는 상위 allowlist 가 learning 을
// 모르므로 "invalid session-design fields" 가, 변경 후에는 null 이 찍힌다.
console.log('probe: validateSessionDesign(week-3, complete=true) =>',
  JSON.stringify(validateSessionDesign(week3(), true)));

// ─── 1. 불변 대조 — learning 이 없는 설계는 오늘과 같다 ──────────────────────
// 변경 전 코드에서도 통과해야 한다. 여기가 빨개지면 확장이 기존 수업을 깼다는 뜻이다.
const legacy = () => ({
  schema: 'hps-session-design/1',
  title: '레거시 수업',
  audience: '성인 실습반',
  duration_minutes: 90,
  objective: '기존 스키마가 그대로 통과하는지 본다',
  prerequisites: '코딩 경험 불필요',
  starter: 'starter/ (빈 폴더)',
  steps: [
    { id: 'one', title: '한 단계', instructions: '무언가 한다', hint: '', acceptance: '결과 파일이 남는다',
      help: { default: 'hint', allowed: ['hint', 'independent'] } },
  ],
  assistant: { display_name: '코치' },
  model: undefined,
});

await check('불변: learning 이 없는 설계는 초안·확정 모두 통과한다', () => {
  const c = legacy(); delete c.model;
  assert.equal(validateSessionDesign(c, false), null);
  assert.equal(validateSessionDesign(c, true), null);
});

await check('불변: 알 수 없는 최상위 키는 여전히 거부된다', () => {
  const c = legacy(); delete c.model;
  c.curriculum = { week: 3 };
  assert.equal(validateSessionDesign(c, true), 'invalid session-design fields');
});

await check('불변: 스키마 id 는 오르지 않는다', () => {
  const c = week3();
  assert.equal(c.schema, 'hps-session-design/1', '필수 키가 바뀌지 않았으므로 /2 를 열지 않는다');
  const bumped = { ...c, schema: 'hps-session-design/2' };
  assert.equal(validateSessionDesign(bumped, true), 'unsupported session-design schema');
});

// ─── 2. 양성 대조 — 심은 정답 ───────────────────────────────────────────────
await check('양성 대조: 설계 문서의 3주차 JSON 이 확정 가능하다', () => {
  assert.equal(validateSessionDesign(week3(), true), null);
});

await check('양성 대조: 3주차는 초안으로도 통과한다', () => {
  assert.equal(validateSessionDesign(week3(), false), null);
});

// ─── 3. 음성 대조 — 결함을 하나씩 심는다 ────────────────────────────────────
const mutate = (fn) => { const c = week3(); fn(c); return validateSessionDesign(c, true); };

await check('음성: learning.completion[].event 가 이벤트 8종 밖이면 거부', () => {
  const bad = mutate(c => { c.learning.completion[0].event = 'not_a_kind'; });
  assert.match(String(bad), /invalid learning\.completion/);
});

await check('음성: learning 안의 점수 키는 거부된다 (SX-59 / C4)', () => {
  const bad = mutate(c => { c.learning.score = 62; });
  assert.match(String(bad), /learning must not carry a score/);
});

await check('음성: 중첩된 점수 키도 거부된다 — 재귀 스캔', () => {
  const bad = mutate(c => { c.learning.completion[0].level = 3; });
  assert.match(String(bad), /learning must not carry a score/);
});

await check('음성: week 말고 다른 숫자 값은 이름이 무엇이든 거부된다', () => {
  const bad = mutate(c => { c.learning.mastery = 0.8; });
  assert.match(String(bad), /learning must not carry a score/);
  // week 는 유일하게 허용된 숫자다 — 대조.
  assert.equal(validateSessionDesign(week3(), true), null);
});

await check('음성: learning 안의 알 수 없는 키는 거부된다', () => {
  const bad = mutate(c => { c.learning.badge = '금장'; });
  assert.match(String(bad), /invalid learning fields/);
});

await check('음성: learning.week 은 1..52 정수다', () => {
  assert.match(String(mutate(c => { c.learning.week = 0; })), /invalid learning\.week/);
  assert.match(String(mutate(c => { c.learning.week = 53; })), /invalid learning\.week/);
  assert.match(String(mutate(c => { c.learning.week = 3.5; })), /invalid learning\.week/);
});

await check('음성: learning.mission 은 비어 있을 수 없다', () => {
  assert.match(String(mutate(c => { c.learning.mission = '   '; })), /invalid learning\.mission/);
  assert.match(String(mutate(c => { c.learning.mission = 'ㄱ'.repeat(201); })), /invalid learning\.mission/);
});

await check('음성: learning.completion 의 id 는 중복될 수 없다', () => {
  const bad = mutate(c => { c.learning.completion[1].id = c.learning.completion[0].id; });
  assert.match(String(bad), /invalid learning\.completion/);
});

await check('음성: learning.reflection 은 불리언 두 칸이다', () => {
  assert.match(String(mutate(c => { c.learning.reflection.changed_mind = 'yes'; })), /invalid learning\.reflection/);
  assert.match(String(mutate(c => { delete c.learning.reflection.next_experiment; })), /invalid learning\.reflection/);
});

await check('음성: evidence_types / source_kinds 는 정해진 목록 안이어야 한다', () => {
  assert.match(String(mutate(c => { c.learning.evidence_types = ['criterion', 'creativity']; })), /invalid learning\.evidence_types/);
  assert.match(String(mutate(c => { c.learning.source_kinds = ['tiktok']; })), /invalid learning\.source_kinds/);
});

await check('음성: never·observe 는 빈 문자열을 담을 수 없다', () => {
  assert.match(String(mutate(c => { c.learning.never = ['']; })), /invalid learning\.never/);
  assert.match(String(mutate(c => { c.learning.observe = [7]; })), /invalid learning\.observe/);
});

await check('음성: 알 수 없는 단계 키는 여전히 거부된다 (기존 allowlist 가 살아 있다)', () => {
  const bad = mutate(c => { c.steps[0].rubric = '표'; });
  assert.equal(bad, 'invalid step fields');
});

await check('음성: steps[].ui 는 7종 밖이면 거부', () => {
  const bad = mutate(c => { c.steps[0].ui = 'dashboard'; });
  assert.match(String(bad), /^step expect: ui must be one of/);
});

await check('음성: steps[].evidence 는 6종 밖이면 거부', () => {
  const bad = mutate(c => { c.steps[0].evidence = 'creativity'; });
  assert.match(String(bad), /^step expect: evidence must be one of/);
});

await check('음성: steps[].gate 는 이벤트 8종 밖이면 거부', () => {
  const bad = mutate(c => { c.steps[0].gate = 'vibes_checked'; });
  assert.match(String(bad), /^step expect: gate must be one of/);
});

// SX-57 — 관측만 목적인 단계는 만들지 않는다. evidence·gate 를 단 단계는 산출물이 있어야 한다.
await check('SX-57 음성: evidence 만 있고 완료 기준이 빈 단계는 초안에서도 거부', () => {
  const c = week3();
  c.steps[3].acceptance = '   ';                 // diff 단계는 evidence: action 을 단다
  assert.match(String(validateSessionDesign(c, false)), /must name an acceptance/);
});

await check('SX-57 음성: gate 만 있고 완료 기준이 빈 단계도 초안에서 거부', () => {
  const c = week3();
  delete c.steps[2].evidence;                    // gate: test_observed 만 남긴다
  c.steps[2].acceptance = '';
  assert.match(String(validateSessionDesign(c, false)), /must name an acceptance/);
});

await check('SX-57 음성: 확정 모드에서도 거부된다', () => {
  const c = week3();
  c.steps[3].acceptance = '   ';
  const bad = validateSessionDesign(c, true);
  assert.notEqual(bad, null, '확정이 막혀야 한다');
  assert.match(String(bad), /acceptance/);
});

await check('SX-57 대조: evidence·gate 가 없는 단계는 초안에서 빈 완료 기준을 허용한다', () => {
  const c = week3();
  c.steps[1].acceptance = '';                    // build 단계는 evidence·gate 가 없다
  assert.equal(validateSessionDesign(c, false), null, '초안 저장의 관용은 그대로다');
  assert.match(String(validateSessionDesign(c, true)), /acceptance is required to freeze a version/);
});

// ─── 4. 6주 예시 파일 — SX-56 · SX-58 · SX-51 ───────────────────────────────
// SX-58 의 여섯 문장. 원문은 docs/design/ui-philosophy-2026-09-18.md §6·§7 의
// "절대 하지 않을 것" 칸이고, 3주차만 설계 문서의 fixture 문자열을 그대로 쓴다.
const NEVER = {
  1: '인터뷰 답을 AI가 대신 만들어주거나 “좋은 문제”를 자동 선택하지 않는다.',
  2: '“AI 기반 맞춤형 플랫폼” 같은 추상 문구를 먼저 생성하지 않는다.',
  3: '측정을 위해 고의 오류를 추가하지 않는다. 실제 제작 과정에서 생긴 결과를 확인하는 것이 기본이다',
  4: '가짜 결제를 실제 매출로 표시하지 않는다.',
  5: 'SNS 노출·클릭만으로 PMF나 수요를 주장하지 않는다.',
  6: '예측 숫자를 확정된 미래처럼 표현하지 않는다.',
};

await check('6주 예시 여섯 개가 모두 확정 가능하다 (SX-56)', () => {
  for (let w = 1; w <= 6; w++) {
    assert.equal(validateSessionDesign(fixture(w), true), null, `week-${w}`);
  }
});

await check('여섯 파일 모두 비어 있지 않은 learning.never 를 갖는다 (SX-58)', () => {
  for (let w = 1; w <= 6; w++) {
    const { learning } = fixture(w);
    assert.equal(learning.week, w, `week-${w}.json 의 주차가 파일 이름과 같다`);
    assert.ok(Array.isArray(learning.never) && learning.never.length >= 1, `week-${w} never[]`);
    assert.ok(learning.never.every(s => typeof s === 'string' && s.trim()), `week-${w} never[] 가 비지 않았다`);
    assert.equal(learning.never[0], NEVER[w], `week-${w} 의 금지 문장이 원문과 같다`);
  }
});

// 2026-09-20 평가에서 잡힌 드리프트. 2·5주차의 미션과 목표가 보존 원문과 달랐다:
//   2주  "시간/돈보다"        → "시간과 돈보다"
//   5주  "10명을 만드나?"     → "열 명을 만나나?"   ← 뜻이 움직인다(획득 → 대면)
// `never` 여섯 문장은 위 검사가 축자로 잡고 있었는데 미션·목표에는 같은 장치가
// 없었다. 강사가 읽는 문장은 원문이 정본이므로 **문서 본문에 그대로 있는지**로
// 판정한다. 이 검사는 다음에 누가 "다듬는" 것도 막는다.
await check('여섯 주차의 미션·목표·금지 문장이 보존 원문에 그대로 있다 (SX-56·SX-58)', () => {
  const source = readFileSync(new URL('../../docs/design/ui-philosophy-2026-09-18.md', import.meta.url), 'utf8');
  // 대조군: 계측기가 무언가를 실제로 세는지. 원문에 없는 문장은 반드시 걸려야 한다.
  assert.equal(source.includes('돈 안 쓰고 어떻게 열 명을 만나나?'), false,
    '드리프트한 문장이 원문에 있다 — 대조군 전제가 바뀌었다');
  for (let w = 1; w <= 6; w++) {
    const design = fixture(w);
    assert.ok(source.includes(design.learning.mission), `week-${w} mission 이 원문에 없다: ${design.learning.mission}`);
    assert.ok(source.includes(design.objective), `week-${w} objective 가 원문에 없다: ${design.objective}`);
    for (const line of design.learning.never) {
      assert.ok(source.includes(line), `week-${w} never 가 원문에 없다: ${line}`);
    }
  }
});

await check('숫자 카드(metric_board)는 4·6주차에만 있다 (SX-51)', () => {
  for (let w = 1; w <= 6; w++) {
    const uses = fixture(w).steps.some(s => s.ui === 'metric_board');
    assert.equal(uses, w === 4 || w === 6, `week-${w} metric_board=${uses}`);
  }
});

await check('여섯 파일 어디에도 금지 라벨·점수·등급이 없다 (SX-59)', () => {
  const BANNED = ['개선 필요', '낮음', '높음', '상위', '역량 부족', 'AI 활용 고수', '성장 점수', '점수', '등급', '순위', '레벨'];
  for (let w = 1; w <= 6; w++) {
    const raw = readFileSync(new URL(`./fixtures/session-design/week-${w}.json`, import.meta.url), 'utf8');
    for (const label of BANNED) assert.ok(!raw.includes(label), `week-${w} 에 "${label}" 이 있다`);
    assert.ok(!/%/.test(raw), `week-${w} 에 퍼센트가 있다`);
  }
});

await check('모든 단계에 실제 산출물을 지목하는 완료 기준이 있다 (SX-57)', () => {
  for (let w = 1; w <= 6; w++) {
    for (const s of fixture(w).steps) {
      assert.ok(typeof s.acceptance === 'string' && s.acceptance.trim(), `week-${w}.${s.id} acceptance`);
    }
  }
});

// ─── 5. enum 은 한 곳에서만 정의된다 ────────────────────────────────────────
await check('learning-design.ts 가 네 목록의 유일한 정의처다', async () => {
  const m = await import('../src/lib/learning-design.ts');
  assert.deepEqual([...m.LEARNING_EVENT_KINDS], [
    'problem_committed', 'criterion_set', 'test_observed', 'change_requested',
    'retest_confirmed', 'external_feedback_received', 'decision_revised', 'reflection_submitted',
  ]);
  assert.deepEqual([...m.EVIDENCE_TYPES], ['intent', 'criterion', 'action', 'decision', 'change', 'ownership']);
  assert.deepEqual([...m.SOURCE_KINDS], ['link', 'article', 'policy', 'interview', 'test', 'none']);
  assert.deepEqual([...m.STEP_UI_KINDS], [
    'canvas_editor', 'canvas_preview', 'criterion_form', 'evidence_note',
    'coach_request', 'decision_form', 'metric_board',
  ]);
});

// ─── 6. SX-58 — never[] 가 코치 프롬프트 경로에 실제로 닿는가 ───────────────
//
// 읽어서 "닿을 것이다" 라고 쓰지 않는다(.claude/rules/verification.md 규칙 1b).
// 실제 Service 앱에 수업을 저장·확정하고, 좌석 토큰으로 /v1/messages 를 불러,
// **공급자가 본 body** 안에서 금지 문장을 찾는다. 경로에 새 분기를 추가하지 않았다는
// 주장의 실측 근거이기도 하다 — chat-gate.ts 가 lesson.content 를 통째로
// JSON.stringify 하므로 learning 은 라우트 변경 없이 따라간다.
const { localAuthoring } = await import('./harness/dental-authoring.mjs');
const { withMockUpstream } = await import('./harness/index.mjs');
const { setRoster, startSession } = await import('../src/lib/kv.ts');

const local = await localAuthoring({ profileId: 'homepage-practice-s1' });
local.env.LLM_PROVIDER = 'anthropic';
local.env.ANTHROPIC_API_KEY = 'synthetic-provider-key';
local.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort, 'Synthetic learning block');
local.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
  .run('learning', local.cohort, local.profileId, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 3600000).toISOString());

try {
  await setRoster(local.env.HPS_KV, local.cohort, ['student']);
  await startSession(local.env.HPS_KV, local.cohort, {
    session_id: 'learning', profile_id: local.profileId,
    starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(),
  });

  const base = '/admin/cohorts/' + local.cohort + '/authoring/';
  const request = async (path, method = 'GET', body, token = local.token) => {
    const r = await local.fetcher(local.origin + path, {
      method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: await r.json() };
  };

  const design = week3();
  let seatToken = null;

  await check('실측: 3주차 예시가 실제 Service 에 저장·확정된다', async () => {
    const saved = await request(base + 'week3', 'PUT',
      { profile_id: local.profileId, request_id: crypto.randomUUID(), expected_revision: 0, content: design });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const frozen = await request(base + 'week3/versions/m2026.09.20-1', 'PUT', { expected_revision: saved.json.revision });
    assert.equal(frozen.status, 200, JSON.stringify(frozen.json));
    const seat = await request(base + 'week3/versions/m2026.09.20-1/participants', 'POST', { user: 'student', hours: 1 });
    assert.equal(seat.status, 200, JSON.stringify(seat.json));
    seatToken = seat.json.token;
  });

  await check('실측: /v1/profile 이 learning 블록을 좌석에 그대로 서빙한다 (SX-56)', async () => {
    const view = await request('/v1/profile', 'GET', undefined, seatToken);
    assert.equal(view.status, 200, JSON.stringify(view.json));
    assert.deepEqual(view.json.lesson.content.learning, design.learning,
      '주차·미션·완료 조건이 코드가 아니라 확정된 데이터에서 온다');
  });

  await check('실측: learning.never 가 공급자가 본 system 에 들어 있다 (SX-58)', async () => {
    const answer = Response.json({
      id: 'synthetic-message', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: '확인했습니다.' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 },
    });
    let upstream = null;
    const r = await withMockUpstream(
      (_u, init) => { upstream = JSON.parse(init.body); return answer.clone(); },
      () => request('/v1/messages', 'POST',
        { model: 'hypeproof-default', max_tokens: 32, messages: [{ role: 'user', content: '시작할게요.' }] }, seatToken),
    );
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const system = JSON.stringify(upstream?.system ?? '');
    assert.ok(system.includes('고의 오류를 추가하지 않는다'), '금지 문장이 코치 프롬프트에 닿는다');
    assert.ok(system.includes('AI가 만든 걸 내가 확인했나'), '미션도 같은 경로로 닿는다');
    assert.ok(system.includes('criterion_set'), '완료 조건의 이벤트도 같은 경로로 닿는다');
  });
} finally {
  local.close();
}

console.log(`session-design-learning: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
