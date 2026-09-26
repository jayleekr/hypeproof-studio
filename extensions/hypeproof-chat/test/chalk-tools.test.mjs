// #1297 (E4-2) — Chalk 도구 층 단위 시험.
// Node --experimental-strip-types 로 돌린다 (worker 하네스 없음).
//
// 대조군 규율:
//   양성 대조: 강사 토큰 + 모의 서버 → chalk_* 도구가 실행된다
//   음성 대조: 학생 토큰(issuer 아님) → chalkToolsEnabled false → 도구 목록에 붙지 않는다
//   토큰 비노출: execCheckPlan 결과에 토큰 문자열이 없다
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// tools.ts를 직접 동적 import (strip-types)
const {
  CHALK_TOOL_DEFINITIONS,
  CHALK_TOOL_EXECUTORS,
  callChalkTool,
  chalkToolsEnabled,
  execCheckPlan,
} = await import('../src/chalk/tools.ts');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

// ─── T-L1: 도구 목록 구조 검증 ─────────────────────────────────────────────
await check('T-L1 tool definitions have required fields and additionalProperties:false', () => {
  const names = ['chalk_check_plan', 'chalk_get_knowledge', 'chalk_recommend_methods'];
  for (const name of names) {
    const def = CHALK_TOOL_DEFINITIONS.find(d => d.name === name);
    assert.ok(def, `${name} definition missing`);
    assert.ok(def.description.length > 0, `${name} needs description`);
    assert.equal(def.inputSchema.additionalProperties, false, `${name} must have additionalProperties:false`);
    assert.ok(Array.isArray(def.inputSchema.required), `${name} must have required array`);
  }
});

// ─── T-L2: callChalkTool 모르는 도구 이름 → 오류 ────────────────────────────
await check('T-L2 unknown tool name throws', async () => {
  const fakeSecrets = { get: async () => 'issuer-token', store: async () => {}, delete: async () => {}, keys: async () => [] };
  await assert.rejects(
    () => callChalkTool({ serverUrl: 'http://localhost:9999', secrets: fakeSecrets }, 'unknown_tool', {}),
    /알 수 없는 Chalk 도구/,
  );
});

// ─── T-L3: chalkToolsEnabled — 학생 토큰(issuer 아님) → false ────────────────
await check('T-L3 student token returns chalkToolsEnabled=false', async () => {
  // decodeTokenPayloadUnverified는 2파트 토큰을 읽는다: parts[0]이 페이로드
  const studentPayload = Buffer.from(JSON.stringify({ u: 'student', c: 'cohort-a', p: 'prof-1', role: 'student' })).toString('base64url');
  const studentToken = `${studentPayload}.sig`;
  const fakeSecrets = {
    get: async (key) => key === 'hypeproofChat.issuerToken' ? studentToken : undefined,
    store: async () => {}, delete: async () => {}, keys: async () => [],
  };
  const result = await chalkToolsEnabled(fakeSecrets);
  assert.equal(result, false, 'student token must not enable chalk tools');
});

// ─── T-L4: chalkToolsEnabled — 토큰 없음 → false ─────────────────────────────
await check('T-L4 no token returns chalkToolsEnabled=false', async () => {
  const fakeSecrets = {
    get: async () => undefined,
    store: async () => {}, delete: async () => {}, keys: async () => [],
  };
  assert.equal(await chalkToolsEnabled(fakeSecrets), false);
});

// ─── T-L5: chalkToolsEnabled — issuer 토큰 → true ────────────────────────────
await check('T-L5 issuer token returns chalkToolsEnabled=true', async () => {
  // decodeTokenPayloadUnverified: 2파트, parts[0]이 페이로드
  const issuerPayload = Buffer.from(JSON.stringify({ role: 'issuer', scopes: [] })).toString('base64url');
  const issuerToken = `${issuerPayload}.sig`;
  const fakeSecrets = {
    get: async (key) => key === 'hypeproofChat.issuerToken' ? issuerToken : undefined,
    store: async () => {}, delete: async () => {}, keys: async () => [],
  };
  assert.equal(await chalkToolsEnabled(fakeSecrets), true);
});

// ─── T-L6: 토큰 비노출 — execCheckPlan 결과에 토큰 없음 ─────────────────────
await check('T-L6 token not in callChalkTool result', async () => {
  const SECRET_TOKEN = 'secret-issuer-token-must-not-leak';

  // 모의 HTTP 서버
  const server = createServer((req, res) => {
    // 요청 헤더에 토큰이 있어야 하지만 응답에는 노출하지 않는다
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const fakeSecrets = {
      get: async (key) => key === 'hypeproofChat.issuerToken' ? SECRET_TOKEN : undefined,
      store: async () => {}, delete: async () => {}, keys: async () => [],
    };
    const result = await callChalkTool(
      { serverUrl: `http://127.0.0.1:${port}`, secrets: fakeSecrets },
      'chalk_check_plan',
      { cohort: 'test-cohort', course: 'lesson-01' },
    );
    assert.ok(!result.includes(SECRET_TOKEN), '토큰이 도구 결과에 포함됐다');
  } finally {
    server.close();
  }
});

// ─── T-L7: execCheckPlan 입력 검증 — cohort/course 없으면 오류 ───────────────
await check('T-L7 execCheckPlan requires cohort and course', async () => {
  const fakeSecrets = { get: async () => 'issuer-token', store: async () => {}, delete: async () => {}, keys: async () => [] };
  const ctx = { serverUrl: 'http://localhost:9999', secrets: fakeSecrets };
  await assert.rejects(() => execCheckPlan(ctx, { course: 'c' }), /cohort/);
  await assert.rejects(() => execCheckPlan(ctx, { cohort: 'h' }), /course/);
});

// ─── T-L8~T-L9: mergeChalkTools — 도구 목록에 chalk_* 포함 여부 ────────────
const { mergeChalkTools } = await import('../src/localRuntime/index.ts');

// 모의 워크스페이스 도구 (Read 하나만)
const mockWorkTools = {
  definitions: [{ name: 'Read', inputSchema: {} }],
  call: async () => 'read-result',
};

await check('T-L8 instructor mode: chalk_* added to definitions (Claude+Codex path)', async () => {
  const issuerPayload = Buffer.from(JSON.stringify({ role: 'issuer', scopes: [] })).toString('base64url');
  const fakeSecrets = { get: async (k) => k === 'hypeproofChat.issuerToken' ? `${issuerPayload}.sig` : undefined };
  const chalkCtx = { serverUrl: 'http://localhost:9999', secrets: fakeSecrets };

  const merged = mergeChalkTools(mockWorkTools, chalkCtx);
  const names = merged.definitions.map(d => d.name);

  assert.ok(names.includes('Read'), 'workspace tool preserved');
  assert.ok(names.includes('chalk_check_plan'), 'chalk_check_plan added');
  assert.ok(names.includes('chalk_get_knowledge'), 'chalk_get_knowledge added');
  assert.ok(names.includes('chalk_recommend_methods'), 'chalk_recommend_methods added');
});

await check('T-L9 student mode: chalk_* NOT in definitions', async () => {
  // chalkCtx 없음 = 학생 모드
  const merged = mergeChalkTools(mockWorkTools, undefined);
  const names = merged.definitions.map(d => d.name);

  assert.ok(names.includes('Read'), 'workspace tool preserved');
  assert.ok(!names.some(n => n.startsWith('chalk_')), `chalk tools must not appear; found: ${names.filter(n=>n.startsWith('chalk_')).join(',')}`);
});

// ─── T-L10: 버튼 명령과 도구 호출이 같은 callChalkTool을 부른다 ────────────
await check('T-L10 mergeChalkTools routes chalk tool call through callChalkTool', async () => {
  const SECRET_TOKEN = 'secret-token-spy-test';
  let capturedPath = '';

  const server = createServer((req, res) => {
    capturedPath = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const fakeSecrets = { get: async (k) => k === 'hypeproofChat.issuerToken' ? SECRET_TOKEN : undefined };
    const chalkCtx = { serverUrl: `http://127.0.0.1:${port}`, secrets: fakeSecrets };
    const merged = mergeChalkTools(mockWorkTools, chalkCtx);

    // 버튼 명령도 callChalkTool을 부른다 — 같은 실행 함수 경로 검증
    const result = await merged.call('chalk_check_plan', { cohort: 'c1', course: 'l1' });

    // 올바른 서버 경로가 호출됐는지 (E2-3 / #1294 경로)
    assert.match(capturedPath, /\/admin\/chalk\/cohorts\/c1\/courses\/l1\/check/,
      `expected #1294 route path, got: ${capturedPath}`);

    // 토큰이 결과에 없다
    assert.ok(!(result).includes(SECRET_TOKEN), '토큰이 merged.call 결과에 포함됐다');
  } finally {
    server.close();
  }
});

// ─── T-L11: 서버 경로 확인 — #1294 cohort 포함 형태 ─────────────────────────
await check('T-L11 execCheckPlan uses #1294 route with cohort in path', async () => {
  let capturedPath = '';
  const server = createServer((req, res) => {
    capturedPath = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const fakeSecrets = { get: async () => 'tok', store: async () => {}, delete: async () => {}, keys: async () => [] };
    await callChalkTool({ serverUrl: `http://127.0.0.1:${port}`, secrets: fakeSecrets },
      'chalk_check_plan', { cohort: 'sk-biopharm', course: 'lesson-01' });
    assert.match(capturedPath, /\/admin\/chalk\/cohorts\/sk-biopharm\/courses\/lesson-01\/check/,
      `#1294 경로가 아님: ${capturedPath}`);
  } finally {
    server.close();
  }
});

// ─── T-L12~L15: 서버 경로 단언 (#1288 세 경로 + #1293 cohort 포함 경로) ──────

// 공통: 모의 서버 유틸
async function withMockServer(handler, fn) {
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

const {
  execGetKnowledge,
  execRecommendMethods,
} = await import('../src/chalk/tools.ts');

const fakeCtx = (port) => ({
  serverUrl: `http://127.0.0.1:${port}`,
  secrets: { get: async () => 'tok', store: async () => {}, delete: async () => {}, keys: async () => [] },
});

await check('T-L12 execGetKnowledge versions → GET /admin/chalk/knowledge/versions', async () => {
  let captured = '';
  await withMockServer((req, res) => {
    captured = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ versions: [] }));
  }, async (port) => {
    await execGetKnowledge(fakeCtx(port), {});
    assert.equal(captured, '/admin/chalk/knowledge/versions', `경로 불일치: ${captured}`);
  });
});

await check('T-L13 execGetKnowledge version+kind → GET .../docs?kind=method (쿼리스트링)', async () => {
  let captured = '';
  await withMockServer((req, res) => {
    captured = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: 3, docs: [] }));
  }, async (port) => {
    await execGetKnowledge(fakeCtx(port), { version: 3, kind: 'method' });
    assert.match(captured, /\/admin\/chalk\/knowledge\/3\/docs\?kind=method/, `경로 불일치: ${captured}`);
    // kind가 경로 세그먼트에 들어가면 안 됨
    assert.ok(!captured.includes('/docs/method'), `kind가 경로 세그먼트로 들어갔다: ${captured}`);
  });
});

await check('T-L14 execGetKnowledge version+doc_id → GET .../docs/:doc_id (URL 인코딩)', async () => {
  let captured = '';
  await withMockServer((req, res) => {
    captured = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ doc_id: 'method:m-001' }));
  }, async (port) => {
    await execGetKnowledge(fakeCtx(port), { version: 3, doc_id: 'method:m-001' });
    // ':' 가 %3A 로 인코딩돼야 함
    assert.match(captured, /\/admin\/chalk\/knowledge\/3\/docs\/method%3Am-001/, `URL 인코딩 실패: ${captured}`);
  });
});

await check('T-L15 execRecommendMethods → POST /admin/chalk/cohorts/:cohort/courses/:course/recommend', async () => {
  let captured = '';
  await withMockServer((req, res) => {
    captured = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ recommended: [] }));
  }, async (port) => {
    await execRecommendMethods(fakeCtx(port), {
      cohort: 'sk-biopharm-kids-s1',
      course: 'lesson-01',
      conditions: ['short-time'],
      goals: ['build-concept'],
    });
    assert.match(
      captured,
      /\/admin\/chalk\/cohorts\/sk-biopharm-kids-s1\/courses\/lesson-01\/recommend/,
      `#1293 경로 불일치: ${captured}`,
    );
  });
});

await check('T-L16 409 from recommend → 지식이 적재되지 않았습니다 message', async () => {
  await withMockServer((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'knowledge_incomplete' }));
  }, async (port) => {
    let threw = null;
    try {
      await execRecommendMethods(fakeCtx(port), {
        cohort: 'sk-biopharm-kids-s1', course: 'lesson-01',
        conditions: ['short-time'], goals: ['build-concept'],
      });
    } catch (e) { threw = e; }
    assert.ok(threw, '409 should throw');
    assert.ok(threw.message.includes('지식이 적재되지 않았습니다'), `409 message mismatch: ${threw.message}`);
  });
});

const { IssuerHttpError } = await import('../src/chalk/tools.ts');

await check('T-L17 409 from check passes through as IssuerHttpError, not 지식 message', async () => {
  await withMockServer((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'conflict' }));
  }, async (port) => {
    let threw = null;
    try {
      await execCheckPlan(fakeCtx(port), { cohort: 'sk-biopharm-kids-s1', course: 'lesson-01' });
    } catch (e) { threw = e; }
    assert.ok(threw, '409 should throw');
    assert.ok(threw instanceof IssuerHttpError, `should be IssuerHttpError, got: ${threw.constructor.name}`);
    assert.ok(!threw.message.includes('지식'), `check 409 must not include 지식 message: ${threw.message}`);
    assert.equal(threw.status, 409);
  });
});

await check('T-L18 400 VocabError from recommend → field and unknown_values in message', async () => {
  await withMockServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ field: 'conditions', unknown_values: ['bad-key'] }));
  }, async (port) => {
    let threw = null;
    try {
      await execRecommendMethods(fakeCtx(port), {
        cohort: 'sk-biopharm-kids-s1', course: 'lesson-01',
        conditions: ['bad-key'], goals: ['build-concept'],
      });
    } catch (e) { threw = e; }
    assert.ok(threw, '400 should throw');
    assert.ok(threw.message.includes('conditions'), `field not in message: ${threw.message}`);
    assert.ok(threw.message.includes('bad-key'), `unknown_values not in message: ${threw.message}`);
  });
});

console.log(`\n${passed} tests passed`);
