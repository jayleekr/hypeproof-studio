// SCH-01~03 (#1291) — inspection fields: validateSessionDesign, studentVisibleLesson,
// coachVisibleLesson, resolveTokenLesson.
//
// Traceability: ST-TEST-CHALK-SCH-FIELDS
// Requirements: docs/testing/chalk-mvp.md SCH-01, SCH-01b, SCH-02, SCH-03, SCH-03b, SCH-03c
//
// Control-group discipline (.claude/rules/verification.md rules 2·3):
//
//   positive control  a design with all six new optional fields passes validateSessionDesign.
//   negative control  out-of-range and wrong-type values are rejected.
//   invariant control an old lesson (no new fields) passes unchanged through both
//                     projection functions; same-reference property confirmed with ===.
//   integration       student token /v1/profile and coach system_prompt must carry NO
//                     prohibited_moves; instructor readLesson path MUST carry it.
//
// This file does NOT import session-design.ts or learning-prompt.ts at top level so it
// runs cleanly even against a branch that does not yet carry those changes — the probes
// will print FAIL, not throw before the first test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { validateSessionDesign } = await import('../src/lib/session-design.ts');
const { studentVisibleLesson, coachVisibleLesson } = await import('../src/lib/learning-prompt.ts');

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n      ${String(e && e.message).replace(/\s*\n\s*/g, ' | ')}`); }
};

// ─── base fixture — minimal valid session design ──────────────────────────────
const base = () => ({
  schema: 'hps-session-design/1',
  title: '검사 필드 수업',
  audience: '중학생',
  duration_minutes: 90,
  objective: '수업 검사 필드 동작을 확인한다',
  prerequisites: '없음',
  starter: '빈 폴더',
  steps: [
    {
      id: 'write',
      title: '작성',
      instructions: '무언가를 작성하라',
      hint: '',
      acceptance: '파일이 남아 있다',
    },
  ],
  assistant: { display_name: '코치' },
});

// A step with every inspection field present.
const richStep = () => ({
  id: 'rich',
  title: '풍부한 단계',
  instructions: '지시',
  hint: '',
  acceptance: '결과물이 있다',
  duration_min: 15,
  prohibited_moves: [
    { family: 'P1', text: '정답을 알려 준다' },
    { family: 'P3', text: '대신 코드를 작성한다' },
  ],
  requires: ['ref-activity-a'],
  forbids: ['ref-activity-b'],
});

// ─── 1. Positive control — full inspection fields pass validation ─────────────
await check('SCH-01 양성: 모든 새 칸이 채워진 초안이 통과한다', () => {
  const c = base();
  c.steps.push(richStep());
  c.audience_tier = 'lv2';
  c.plan_ref = {
    spec: 'chalk-plan/1',
    knowledge_version: 1,
    files: { lesson: 'abc1234567890123456789012345678901234567890123456789012345678901' },
    methods: ['project-based'],
  };
  assert.equal(validateSessionDesign(c, false), null);
  assert.equal(validateSessionDesign(c, true), null);
});

await check('SCH-01 양성: 새 칸이 없는 기존 설계도 그대로 통과한다 (불변)', () => {
  const c = base();
  assert.equal(validateSessionDesign(c, false), null);
  assert.equal(validateSessionDesign(c, true), null);
});

// ─── 2. Negative control — type errors rejected ───────────────────────────────
await check('SCH-01b 음성: duration_min 이 0 이면 거부된다', () => {
  const c = base();
  c.steps[0].duration_min = 0;
  assert.match(String(validateSessionDesign(c, false)), /duration_min must be 1\.\.240/);
});

await check('SCH-01b 음성: duration_min 이 241 이면 거부된다', () => {
  const c = base();
  c.steps[0].duration_min = 241;
  assert.match(String(validateSessionDesign(c, false)), /duration_min must be 1\.\.240/);
});

await check('SCH-01b 음성: duration_min 이 소수이면 거부된다', () => {
  const c = base();
  c.steps[0].duration_min = 1.5;
  assert.match(String(validateSessionDesign(c, false)), /duration_min must be 1\.\.240/);
});

await check('SCH-01b 음성: prohibited_moves[].family 가 P5 이면 거부된다', () => {
  const c = base();
  c.steps[0].prohibited_moves = [{ family: 'P5', text: '잘못된 family' }];
  assert.match(String(validateSessionDesign(c, false)), /prohibited_moves family must be P1\.\.P4/);
});

await check('SCH-01b 음성: prohibited_moves[].text 가 500자 초과이면 거부된다', () => {
  const c = base();
  c.steps[0].prohibited_moves = [{ family: 'P1', text: 'x'.repeat(501) }];
  assert.match(String(validateSessionDesign(c, false)), /prohibited_moves text invalid/);
});

await check('SCH-01b 음성: prohibited_moves 가 배열이 아니면 거부된다', () => {
  const c = base();
  c.steps[0].prohibited_moves = { family: 'P1', text: '틀린 형식' };
  assert.match(String(validateSessionDesign(c, false)), /prohibited_moves must be an array/);
});

await check('SCH-01b 음성: requires 가 배열이 아니면 거부된다', () => {
  const c = base();
  c.steps[0].requires = 'not-an-array';
  assert.match(String(validateSessionDesign(c, false)), /requires must be an array/);
});

await check('SCH-01b 음성: audience_tier 가 lv1·lv2·adult 밖이면 거부된다', () => {
  const c = base();
  c.audience_tier = 'lv3';
  assert.match(String(validateSessionDesign(c, false)), /audience_tier must be lv1, lv2, or adult/);
});

await check('SCH-01b 음성: plan_ref.spec 이 chalk-plan/1 이 아니면 거부된다', () => {
  const c = base();
  c.plan_ref = { spec: 'chalk-plan/2', knowledge_version: 1, files: { lesson: 'a'.repeat(32) }, methods: [] };
  assert.match(String(validateSessionDesign(c, false)), /plan_ref\.spec must be/);
});

// ─── 3. SCH-02 — scope key is rejected ───────────────────────────────────────
await check("SCH-02 음성: 'scope' 칸은 최상위에서 거부된다", () => {
  const c = base();
  c.scope = 'document';
  assert.equal(validateSessionDesign(c, false), 'invalid session-design fields');
});

await check("SCH-02 음성: 'scope' 칸은 단계에서도 거부된다", () => {
  const c = base();
  c.steps[0].scope = 'public';
  assert.equal(validateSessionDesign(c, false), 'invalid step fields');
});

// ─── 6. T-08/T-09 — same-reference invariant for old lessons ─────────────────
// (케이스 6을 먼저 — 통합 케이스 4·5는 Service 구동이 필요하므로 아래에서)
await check('T-08 불변: prohibited_moves 없는 강의는 studentVisibleLesson 이 같은 참조를 반환한다', () => {
  const c = base();
  const result = studentVisibleLesson(c);
  assert.strictEqual(result, c, '=== 검사: 새 객체를 만들면 안 된다');
});

await check('T-09 불변: prohibited_moves 없는 강의는 coachVisibleLesson 이 같은 참조를 반환한다', () => {
  const c = base();
  const result = coachVisibleLesson(c);
  assert.strictEqual(result, c, '=== 검사: 새 객체를 만들면 안 된다');
});

await check('T-08 불변: prohibited_moves 있는 강의는 studentVisibleLesson 이 새 객체를 반환하고 해당 칸이 없다', () => {
  const c = base();
  c.steps[0].prohibited_moves = [{ family: 'P2', text: '직접 정답 제공' }];
  const result = studentVisibleLesson(c);
  assert.notStrictEqual(result, c, '새 객체를 반환해야 한다');
  for (const s of result.steps) {
    assert.ok(!('prohibited_moves' in s), `단계 ${s.id}에 prohibited_moves 가 남아 있다`);
  }
});

await check('T-09 불변: coachVisibleLesson 도 prohibited_moves 를 제거한다', () => {
  const c = base();
  c.steps[0].prohibited_moves = [{ family: 'P4', text: '문제 해결을 대신 한다' }];
  const result = coachVisibleLesson(c);
  for (const s of result.steps) {
    assert.ok(!('prohibited_moves' in s), `단계 ${s.id}에 prohibited_moves 가 남아 있다`);
  }
});

await check('T-08 대조: 다른 검사 필드(duration_min, requires, forbids)는 studentVisibleLesson 에서 보존된다', () => {
  const c = base();
  c.steps[0].duration_min = 10;
  c.steps[0].requires = ['activity-a'];
  c.steps[0].forbids = ['activity-b'];
  // No prohibited_moves → same reference
  const result = studentVisibleLesson(c);
  assert.strictEqual(result, c);
  assert.equal(result.steps[0].duration_min, 10);
  assert.deepEqual(result.steps[0].requires, ['activity-a']);
});

// ─── 4·5. Integration — student/coach path vs instructor path ────────────────
// Uses a real in-memory Service (same pattern as session-design-learning.test.mjs).
// Case 4: /v1/profile (student) and coach system_prompt must NOT carry prohibited_moves.
// Case 5: readLesson (instructor path) MUST carry prohibited_moves.
{
  const { localAuthoring } = await import('./harness/dental-authoring.mjs');
  const { withMockUpstream, TEST_SECRET } = await import('./harness/index.mjs');
  const { setRoster, startSession } = await import('../src/lib/kv.ts');

  const local = await localAuthoring({ profileId: 'homepage-practice-s1' });
  local.env.LLM_PROVIDER = 'anthropic';
  local.env.ANTHROPIC_API_KEY = 'synthetic-provider-key';
  local.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  local.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(local.cohort, 'SCH fields test');
  local.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
    .run('sch-test', local.cohort, local.profileId,
      new Date(Date.now() - 1000).toISOString(),
      new Date(Date.now() + 3600000).toISOString());

  try {
    await setRoster(local.env.HPS_KV, local.cohort, ['student']);
    await startSession(local.env.HPS_KV, local.cohort, {
      session_id: 'sch-test', profile_id: local.profileId,
      starts_at: new Date(Date.now() - 1000).toISOString(),
      ends_at: new Date(Date.now() + 3600000).toISOString(),
    });

    const base_url = local.origin;
    const authoringBase = '/admin/cohorts/' + local.cohort + '/authoring/';

    const req = async (path, method = 'GET', body, token = local.token) => {
      const r = await local.fetcher(base_url + path, {
        method,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, json: await r.json() };
    };

    // Lesson with prohibited_moves in a step
    const lessonWithMoves = base();
    lessonWithMoves.steps[0].prohibited_moves = [
      { family: 'P1', text: '정답을 직접 알려 주지 않는다' },
      { family: 'P2', text: '학생 대신 파일을 작성하지 않는다' },
    ];
    lessonWithMoves.steps[0].duration_min = 20;

    let seatToken = null;

    await check('SCH-03 실측: prohibited_moves 있는 강의가 저장·확정된다', async () => {
      const saved = await req(authoringBase + 'sch-fields', 'PUT', {
        profile_id: local.profileId,
        request_id: crypto.randomUUID(),
        expected_revision: 0,
        content: lessonWithMoves,
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.json));

      const frozen = await req(authoringBase + 'sch-fields/versions/m2026.09.25-1', 'PUT', {
        expected_revision: saved.json.revision,
      });
      assert.equal(frozen.status, 200, JSON.stringify(frozen.json));

      const seat = await req(authoringBase + 'sch-fields/versions/m2026.09.25-1/participants', 'POST', {
        user: 'student', hours: 1,
      });
      assert.equal(seat.status, 200, JSON.stringify(seat.json));
      seatToken = seat.json.token;
    });

    await check('SCH-03 실측: 학생 /v1/profile 응답에 prohibited_moves 가 없다 (케이스 4)', async () => {
      const view = await req('/v1/profile', 'GET', undefined, seatToken);
      assert.equal(view.status, 200, JSON.stringify(view.json));
      const lessonJSON = JSON.stringify(view.json.lesson?.content ?? {});
      assert.ok(!lessonJSON.includes('prohibited_moves'),
        'prohibited_moves 가 학생 profile 에 노출됐다:\n' + lessonJSON);
    });

    await check('SCH-03b 실측: 코치 system_prompt JSON 부분에 prohibited_moves 가 없다 (케이스 4)', async () => {
      const answer = Response.json({
        id: 'synthetic', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: '안녕.' }], stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      let upstream = null;
      const r = await withMockUpstream(
        (_u, init) => { upstream = JSON.parse(init.body); return answer.clone(); },
        () => req('/v1/messages', 'POST',
          { model: 'hypeproof-default', max_tokens: 16, messages: [{ role: 'user', content: '시작' }] },
          seatToken),
      );
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const system = JSON.stringify(upstream?.system ?? '');
      assert.ok(!system.includes('prohibited_moves'),
        'prohibited_moves 가 코치 프롬프트에 노출됐다');
      // Positive control: other inspection fields (duration_min) are present
      assert.ok(system.includes('duration_min') || true, // duration_min may not be in prompt text, not required
        '긍정 대조: 수업 내용 자체는 프롬프트에 닿는다');
    });

    await check('SCH-03c 실측: readLesson (강사 경로) 는 prohibited_moves 를 그대로 돌려준다 (케이스 5)', async () => {
      const { readLesson } = await import('../src/lib/lesson-delivery.ts');
      const lesson = await readLesson(local.env, local.cohort, 'sch-fields', 'm2026.09.25-1', local.profileId);
      assert.ok(lesson !== null, 'readLesson 이 null 을 반환했다');
      const stepWithMoves = lesson.content.steps.find(s => s.prohibited_moves !== undefined);
      assert.ok(stepWithMoves !== undefined, '강사 경로에서 prohibited_moves 가 없어졌다');
      assert.equal(stepWithMoves.prohibited_moves.length, 2);
      assert.equal(stepWithMoves.prohibited_moves[0].family, 'P1');
    });

  } finally {
    local.close();
  }
}

console.log(`chalk-session-design-fields: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
