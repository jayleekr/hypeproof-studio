// #1465 (E2-5) — chalk_judge_items + chalk_record_judgement 도구 단위 시험.
// Node --experimental-strip-types 로 돌린다 (worker 하네스 없음).
//
// 대조군 규율:
//   양성 대조: 정상 서버 응답 → 올바른 경로 + 반환값 구조
//   음성 대조: human_only 400 → throw 대신 { error: "human_only" } 반환
//            서버 400 (다른 코드) → { error, message } 반환
//            서버 4xx가 아닌 오류 → 그대로 throw
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const {
  CHALK_TOOL_DEFINITIONS,
  execJudgeItems,
  execRecordJudgement,
  callChalkTool,
} = await import('../src/chalk/tools.ts');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

async function withMockServer(handler, fn) {
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try { await fn(port); } finally { server.close(); }
}

const fakeSecrets = { get: async () => 'tok', store: async () => {}, delete: async () => {}, keys: async () => [] };
const fakeCtx = (port, extra = {}) => ({
  serverUrl: `http://127.0.0.1:${port}`,
  secrets: fakeSecrets,
  ...extra,
});

// ─── TJ-01: 도구 목록에 두 도구 포함 ────────────────────────────────────────
await check('TJ-01 CHALK_TOOL_DEFINITIONS includes chalk_judge_items and chalk_record_judgement', () => {
  const names = CHALK_TOOL_DEFINITIONS.map(d => d.name);
  assert.ok(names.includes('chalk_judge_items'), 'chalk_judge_items missing');
  assert.ok(names.includes('chalk_record_judgement'), 'chalk_record_judgement missing');
  for (const name of ['chalk_judge_items', 'chalk_record_judgement']) {
    const def = CHALK_TOOL_DEFINITIONS.find(d => d.name === name);
    assert.equal(def.inputSchema.additionalProperties, false);
    assert.ok(Array.isArray(def.inputSchema.required));
  }
});

// ─── TJ-02: execJudgeItems — 올바른 서버 경로 호출 ───────────────────────────
await check('TJ-02 execJudgeItems calls GET judge-brief route', async () => {
  let captured = '';
  const mockBrief = {
    plan_sha256: 'abc123',
    revision: 3,
    items: [
      { check: 'G2-2', prompt_id: 'G2-2', prompt_version: 1, prompt_text: '목표가 관찰 가능한 동사로 시작하나요?', plan_excerpt: '목표: 홈페이지를 수정합니다' },
    ],
  };
  await withMockServer((req, res) => {
    captured = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(mockBrief));
  }, async (port) => {
    const result = await execJudgeItems(fakeCtx(port), { cohort: 'sk-kids', course: 'lesson-01' });
    assert.match(captured, /\/admin\/chalk\/cohorts\/sk-kids\/courses\/lesson-01\/judge-brief/);
    assert.equal(result.plan_sha256, 'abc123');
    assert.equal(result.revision, 3);
    assert.ok(Array.isArray(result.items));
    assert.equal(result.items[0].check, 'G2-2');
  });
});

// ─── TJ-03: execJudgeItems — cohort/course 없으면 오류 ──────────────────────
await check('TJ-03 execJudgeItems requires cohort and course', async () => {
  const ctx = fakeCtx(9999);
  await assert.rejects(() => execJudgeItems(ctx, { course: 'lesson-01' }), /cohort/);
  await assert.rejects(() => execJudgeItems(ctx, { cohort: 'sk-kids' }), /course/);
});

// ─── TJ-04: execRecordJudgement — 정상 경로 + model 자동 채워짐 ──────────────
await check('TJ-04 execRecordJudgement posts to correct route and fills model from currentModel', async () => {
  let capturedPath = '';
  let capturedBody = null;
  await withMockServer((req, res) => {
    capturedPath = req.url ?? '';
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { capturedBody = JSON.parse(body); } catch {}
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ judgement_id: 'j_abc', check_name: 'G2-2' }));
    });
  }, async (port) => {
    const ctx = fakeCtx(port, { currentModel: 'claude-opus-5' });
    const result = await execRecordJudgement(ctx, {
      cohort: 'sk-kids',
      course: 'lesson-01',
      check: 'G2-2',
      plan_sha256: 'abc123',
      revision: 3,
      prompt_id: 'G2-2',
      prompt_version: 1,
      verdict: 'pass',
      rationale: '목표가 관찰 가능한 동사로 시작합니다.',
    });
    assert.match(capturedPath, /\/admin\/chalk\/cohorts\/sk-kids\/courses\/lesson-01\/judgements/);
    assert.equal(capturedBody?.model, 'claude-opus-5', 'model must come from currentModel');
    assert.ok(result.judgement_id, 'judgement_id in response');
  });
});

// ─── TJ-05: execRecordJudgement — currentModel 없으면 fallback ───────────────
await check('TJ-05 execRecordJudgement uses fallback model when currentModel absent', async () => {
  let capturedBody = null;
  await withMockServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { capturedBody = JSON.parse(body); } catch {}
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ judgement_id: 'j_fallback' }));
    });
  }, async (port) => {
    // currentModel 없는 ctx
    await execRecordJudgement(fakeCtx(port), {
      cohort: 'sk-kids', course: 'lesson-01',
      check: 'G2-2', plan_sha256: 'abc', revision: 1,
      prompt_id: 'G2-2', prompt_version: 1,
      verdict: 'pass', rationale: '좋음',
    });
    assert.ok(typeof capturedBody?.model === 'string' && capturedBody.model.length > 0, 'model must be non-empty');
  });
});

// ─── TJ-06: human_only 400 → { error: "human_only" } 반환 (throw 아님) ────────
await check('TJ-06 human_only 400 returns structured error, not throw', async () => {
  await withMockServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'human_only', error: 'G2-12은 사람이 확인하는 항목입니다.' }));
  }, async (port) => {
    const result = await execRecordJudgement(fakeCtx(port), {
      cohort: 'sk-kids', course: 'lesson-01',
      check: 'G2-12', plan_sha256: 'abc', revision: 1,
      prompt_id: 'G2-12', prompt_version: 1,
      verdict: 'pass', rationale: '사람이 확인',
    });
    assert.equal(result.error, 'human_only');
    assert.ok(typeof result.message === 'string' && result.message.length > 0);
  });
});

// ─── TJ-07: 서버 400 (다른 코드) → { error, message } 반환 ──────────────────
await check('TJ-07 other 400 from record returns { error, message }', async () => {
  await withMockServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'unknown_plan', error: '계획 SHA256 불일치' }));
  }, async (port) => {
    const result = await execRecordJudgement(fakeCtx(port), {
      cohort: 'sk-kids', course: 'lesson-01',
      check: 'G2-2', plan_sha256: 'wrong', revision: 1,
      prompt_id: 'G2-2', prompt_version: 1,
      verdict: 'pass', rationale: 'test',
    });
    assert.equal(result.error, 'unknown_plan');
    assert.ok(result.message.includes('불일치'));
  });
});

// ─── TJ-08: 서버 500 → throw (IssuerHttpError) ───────────────────────────────
await check('TJ-08 server 500 from record throws IssuerHttpError', async () => {
  const { IssuerHttpError } = await import('../src/chalk/tools.ts');
  await withMockServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal server error' }));
  }, async (port) => {
    await assert.rejects(
      () => execRecordJudgement(fakeCtx(port), {
        cohort: 'sk-kids', course: 'lesson-01',
        check: 'G2-2', plan_sha256: 'abc', revision: 1,
        prompt_id: 'G2-2', prompt_version: 1,
        verdict: 'pass', rationale: 'test',
      }),
      e => e instanceof IssuerHttpError && e.status === 500,
    );
  });
});

// ─── TJ-09: callChalkTool 경로 검증 ──────────────────────────────────────────
await check('TJ-09 callChalkTool routes chalk_judge_items correctly', async () => {
  let captured = '';
  await withMockServer((req, res) => {
    captured = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ plan_sha256: 'x', revision: 1, items: [] }));
  }, async (port) => {
    await callChalkTool(fakeCtx(port), 'chalk_judge_items', { cohort: 'c1', course: 'l1' });
    assert.match(captured, /\/admin\/chalk\/cohorts\/c1\/courses\/l1\/judge-brief/);
  });
});

console.log(`\n${passed} tests passed`);
