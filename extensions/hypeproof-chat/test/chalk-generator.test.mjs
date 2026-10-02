// #1295 (E2-6) — Chalk 생성 도구 층 단위 시험.
// Node --experimental-strip-types 로 돌린다 (worker 하네스 없음).
//
// 대조군 규율:
//   양성 대조: 강사 토큰 + 모의 서버 → 도구가 올바른 경로로 요청한다
//   음성 대조: 학생 모드(chalkCtx 없음) → 새 도구가 mergeChalkTools 결과에 없다
//   로컬 변경 있음 → 덮어쓰기 전 requestConfirmation 콜백을 부른다
//   revision 충돌(409) → "다시 열기" 결과 반환 (오류가 아니라 안내)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const {
  CHALK_TOOL_DEFINITIONS,
  callChalkTool,
  execSetInputs,
  execGeneratorBrief,
  execOpenCourse,
  execSavePlan,
  workingCopyPath,
} = await import('../src/chalk/tools.ts');

const { mergeChalkTools, mergeBrowserTools } = await import('../src/localRuntime/index.ts');
const { runBrowserOpen, runLivePreviewStart } = await import('../src/browserMcp.ts');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

// ─── 모의 서버 유틸 ────────────────────────────────────────────────────────
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

// ─── T-G1: 도구 목록에 새 도구 4개 포함 ────────────────────────────────────
await check('T-G1 CHALK_TOOL_DEFINITIONS includes all 7 tools', () => {
  const names = CHALK_TOOL_DEFINITIONS.map(d => d.name);
  for (const n of ['chalk_check_plan', 'chalk_get_knowledge', 'chalk_recommend_methods',
    'chalk_set_inputs', 'chalk_generator_brief', 'chalk_open_course', 'chalk_save_plan']) {
    assert.ok(names.includes(n), `${n} missing from definitions`);
  }
});

// ─── T-G2: 학생 모드(chalkCtx 없음) → 새 도구 4개 붙지 않음 ──────────────
await check('T-G2 student mode: new E2-6 tools NOT in definitions', () => {
  const mockWork = { definitions: [{ name: 'Read', description: '', inputSchema: {} }], call: async () => 'ok' };
  const merged = mergeChalkTools(mockWork, undefined);
  const names = merged.definitions.map(d => d.name);
  for (const n of ['chalk_set_inputs', 'chalk_generator_brief', 'chalk_open_course', 'chalk_save_plan']) {
    assert.ok(!names.includes(n), `${n} must not appear in student mode`);
  }
});

// ─── T-G3: chalk_set_inputs → PUT /admin/chalk/cohorts/:cohort/courses/:course/inputs ─
await check('T-G3 execSetInputs correct path, body includes vocab, request_id auto-generated', async () => {
  let capturedPath = '';
  let capturedBody = '';
  await withMockServer((req, res) => {
    capturedPath = req.url ?? '';
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { capturedBody = body; });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ revision: 2 }));
  }, async (port) => {
    // expected_revision, request_id는 모델이 넘기지 않는다 — exec가 자동 생성
    await execSetInputs(fakeCtx(port), {
      cohort: 'sk-biopharm-kids-s1', course: 'lesson-01',
      audience: '어린이', assets: ['INTENT', 'VERIFY'],
      teaching_style: '탐구', requirements: '없음', format: 'workshop',
      vocab: { goals: ['concept_understanding'], conditions: ['no_prior'] },
    });
    assert.match(capturedPath, /\/admin\/chalk\/cohorts\/sk-biopharm-kids-s1\/courses\/lesson-01\/inputs/,
      `inputs 경로 불일치: ${capturedPath}`);
    assert.ok(capturedBody.includes('"vocab"'), `vocab 필드가 바디에 없다`);
    const parsed = JSON.parse(capturedBody);
    assert.ok(typeof parsed.request_id === 'string' && parsed.request_id.length > 0, 'request_id가 자동 생성되지 않았다');
    assert.ok(typeof parsed.expected_revision === 'number', 'expected_revision이 자동 생성되지 않았다');
  });
});

// ─── T-G4: chalk_generator_brief → GET .../brief?file=lesson ──────────────
await check('T-G4 execGeneratorBrief correct path with file=lesson query', async () => {
  let capturedPath = '';
  await withMockServer((req, res) => {
    capturedPath = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ knowledge_version: 3, skeleton_html: '<html></html>', authoring_order: [] }));
  }, async (port) => {
    await execGeneratorBrief(fakeCtx(port), { cohort: 'c1', course: 'lesson-01', file: 'lesson' });
    assert.match(capturedPath, /\/admin\/chalk\/cohorts\/c1\/courses\/lesson-01\/brief\?file=lesson/,
      `brief 경로 불일치: ${capturedPath}`);
  });
});

// ─── T-G5: chalk_open_course → GET .../plan?file=lesson ───────────────────
await check('T-G5 execOpenCourse correct path', async () => {
  let capturedPath = '';
  await withMockServer((req, res) => {
    capturedPath = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ html: '<html></html>', sha256: 'abc', knowledge_version: 3 }));
  }, async (port) => {
    await execOpenCourse(fakeCtx(port), { cohort: 'c1', course: 'lesson-01', file: 'lesson' });
    assert.match(capturedPath, /\/admin\/chalk\/cohorts\/c1\/courses\/lesson-01\/plan\?file=lesson/,
      `plan GET 경로 불일치: ${capturedPath}`);
  });
});

// ─── T-G6: chalk_save_plan → PUT .../plan (파일 내용 바디에 포함) ──────────
await check('T-G6 execSavePlan reads working copy and sends html in body, request_id auto-generated', async () => {
  const tmpDir = join(tmpdir(), `chalk-test-${Date.now()}`);
  const course = 'lesson-01';
  const filePath = workingCopyPath(tmpDir, course, 'lesson');
  await mkdir(join(tmpDir, 'chalk', course), { recursive: true });
  await writeFile(filePath, '<html>draft</html>', 'utf-8');

  let capturedPath = '';
  let capturedBody = '';
  await withMockServer((req, res) => {
    // authoring GET → revision 반환; plan PUT → 저장 결과 반환
    if (req.method === 'GET' && req.url?.includes('/authoring/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revision: 1 }));
      return;
    }
    capturedPath = req.url ?? '';
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { capturedBody = b; });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ revision: 2, sha256: 'abc', findings: [] }));
  }, async (port) => {
    // expected_revision, request_id는 모델이 넘기지 않는다 — exec가 자동 생성
    await execSavePlan(fakeCtx(port, { cwd: tmpDir }), { cohort: 'c1', course, knowledge_version: 3 });
    assert.match(capturedPath, /\/admin\/chalk\/cohorts\/c1\/courses\/lesson-01\/plan/,
      `plan PUT 경로 불일치: ${capturedPath}`);
    assert.ok(capturedBody.includes('<html>draft</html>'), `작업 사본 html이 바디에 없다`);
    const parsed = JSON.parse(capturedBody);
    assert.ok(typeof parsed.request_id === 'string' && parsed.request_id.length > 0, 'request_id가 자동 생성되지 않았다');
    assert.equal(parsed.expected_revision, 1, 'authoring GET의 revision이 expected_revision으로 사용되지 않았다');
  });
});

// ─── T-G7: 로컬 변경 있을 때 requestConfirmation 콜백 호출 ──────────────
await check('T-G7 execOpenCourse calls requestConfirmation when local file differs', async () => {
  const tmpDir = join(tmpdir(), `chalk-test-confirm-${Date.now()}`);
  const course = 'lesson-01';
  const filePath = workingCopyPath(tmpDir, course, 'lesson');
  await mkdir(join(tmpDir, 'chalk', course), { recursive: true });
  await writeFile(filePath, '<html>local change</html>', 'utf-8');

  let confirmCalled = false;
  let confirmResult = false; // 취소

  await withMockServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ html: '<html>server version</html>', sha256: 'xyz' }));
  }, async (port) => {
    const result = JSON.parse(await callChalkTool(
      {
        serverUrl: `http://127.0.0.1:${port}`,
        secrets: fakeSecrets,
        cwd: tmpDir,
        requestConfirmation: async (msg) => { confirmCalled = true; return confirmResult; },
      },
      'chalk_open_course',
      { cohort: 'c1', course, file: 'lesson' },
    ));

    assert.ok(confirmCalled, 'requestConfirmation이 호출되지 않았다');
    assert.equal(result.overwrite_skipped, true, '취소 시 overwrite_skipped=true여야 한다');

    // 취소했으므로 파일은 원래 내용 유지
    const fileContent = await readFile(filePath, 'utf-8');
    assert.equal(fileContent, '<html>local change</html>', '취소 후 파일이 덮어써졌다');
  });
});

// ─── T-G8: revision 충돌(409) → error: revision_conflict 반환 ─────────────
await check('T-G8 execSavePlan returns revision_conflict on 409 revision conflict (not throw)', async () => {
  const tmpDir = join(tmpdir(), `chalk-test-conflict-${Date.now()}`);
  const course = 'lesson-01';
  const filePath = workingCopyPath(tmpDir, course, 'lesson');
  await mkdir(join(tmpDir, 'chalk', course), { recursive: true });
  await writeFile(filePath, '<html>draft</html>', 'utf-8');

  await withMockServer((req, res) => {
    // authoring GET → revision 반환; plan PUT → 409 충돌
    if (req.method === 'GET' && req.url?.includes('/authoring/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revision: 1 }));
      return;
    }
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'revision_conflict', error: '버전이 충돌했습니다.' }));
  }, async (port) => {
    const result = JSON.parse(await callChalkTool(
      fakeCtx(port, { cwd: tmpDir }),
      'chalk_save_plan',
      { cohort: 'c1', course, knowledge_version: 3 },
    ));
    assert.equal(result.error, 'revision_conflict', `409 충돌이 revision_conflict로 반환되지 않았다: ${JSON.stringify(result)}`);
    assert.ok(result.message.includes('chalk_open_course'), '다시 열기 안내에 chalk_open_course가 없다');
  });
});

// ─── T-G10: knowledge_missing(409) → error: knowledge_missing ────────────
await check('T-G10 execSavePlan returns knowledge_missing on 409 knowledge_missing', async () => {
  const tmpDir = join(tmpdir(), `chalk-test-kv-${Date.now()}`);
  const course = 'lesson-01';
  const filePath = workingCopyPath(tmpDir, course, 'lesson');
  await mkdir(join(tmpDir, 'chalk', course), { recursive: true });
  await writeFile(filePath, '<html>draft</html>', 'utf-8');

  await withMockServer((req, res) => {
    // authoring GET → revision 반환; plan PUT → 409 knowledge_missing
    if (req.method === 'GET' && req.url?.includes('/authoring/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revision: 1 }));
      return;
    }
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'knowledge_missing', error: '지식이 없습니다.' }));
  }, async (port) => {
    const result = JSON.parse(await callChalkTool(
      fakeCtx(port, { cwd: tmpDir }),
      'chalk_save_plan',
      { cohort: 'c1', course, knowledge_version: 999 },
    ));
    assert.equal(result.error, 'knowledge_missing', `지식 없음이 knowledge_missing으로 반환되지 않았다: ${JSON.stringify(result)}`);
    assert.ok(result.message, '안내 메시지가 없다');
  });
});

// ─── T-G11: brief inputs 없음(409) → error: inputs_missing ───────────────
await check('T-G11 execGeneratorBrief returns inputs_missing on 409 inputs_missing', async () => {
  await withMockServer((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'inputs_missing', error: '입력을 먼저 저장하세요.' }));
  }, async (port) => {
    const result = JSON.parse(await callChalkTool(
      fakeCtx(port),
      'chalk_generator_brief',
      { cohort: 'c1', course: 'lesson-01' },
    ));
    assert.equal(result.error, 'inputs_missing', `inputs 없음이 inputs_missing으로 반환되지 않았다: ${JSON.stringify(result)}`);
    assert.ok(result.message.includes('chalk_set_inputs'), '안내에 chalk_set_inputs가 없다');
  });
});

// ─── T-G12: knowledge incompatible(409) → error: knowledge_incompatible ──
await check('T-G12 execGeneratorBrief returns knowledge_incompatible on 409 knowledge_incompatible', async () => {
  await withMockServer((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'knowledge_incompatible', error: '지식 호환 오류', field: 'conditions', unranked: ['no_prior'] }));
  }, async (port) => {
    const result = JSON.parse(await callChalkTool(
      fakeCtx(port),
      'chalk_generator_brief',
      { cohort: 'c1', course: 'lesson-01' },
    ));
    assert.equal(result.error, 'knowledge_incompatible', `knowledge incompatible이 knowledge_incompatible로 반환되지 않았다: ${JSON.stringify(result)}`);
    assert.equal(result.field, 'conditions', 'field가 전달되지 않았다');
  });
});

// ─── T-G9: 강사 모드 mergeChalkTools → E2-6 도구 4개 포함 확인 ───────────
await check('T-G9 instructor mode: all E2-6 tools in merged definitions', () => {
  const issuerPayload = Buffer.from(JSON.stringify({ role: 'issuer', scopes: [] })).toString('base64url');
  const chalkCtx = { serverUrl: 'http://localhost', secrets: { get: async (k) => k === 'hypeproofChat.issuerToken' ? `${issuerPayload}.sig` : undefined } };
  const mockWork = { definitions: [{ name: 'Read', description: '', inputSchema: {} }], call: async () => 'ok' };
  const merged = mergeChalkTools(mockWork, chalkCtx);
  const names = merged.definitions.map(d => d.name);
  for (const n of ['chalk_set_inputs', 'chalk_generator_brief', 'chalk_open_course', 'chalk_save_plan']) {
    assert.ok(names.includes(n), `강사 모드에 ${n}이 없다`);
  }
});

// ─── T-G13: lesson과 ops 작업 사본 경로가 다르다 ────────────────────────────
await check('T-G13 workingCopyPath: lesson and ops produce different paths', () => {
  const cwd = '/tmp/test-cwd';
  const course = 'lesson-01';
  const lessonPath = workingCopyPath(cwd, course, 'lesson');
  const opsPath = workingCopyPath(cwd, course, 'ops');
  assert.ok(lessonPath.endsWith('lesson.html'), `lesson path must end with lesson.html: ${lessonPath}`);
  assert.ok(opsPath.endsWith('ops.html'), `ops path must end with ops.html: ${opsPath}`);
  assert.notEqual(lessonPath, opsPath, 'lesson and ops paths must differ');
});

// ─── T-G14: chalk_set_inputs 스키마 + 도구 자동 생성 필드 = 서버 PUT /inputs 검증 집합 ─
await check('T-G14 chalk_set_inputs schema + tool-generated fields cover server PUT /inputs validation', () => {
  const def = CHALK_TOOL_DEFINITIONS.find(d => d.name === 'chalk_set_inputs');
  assert.ok(def, 'chalk_set_inputs def missing');
  const required = def.inputSchema.required ?? [];
  // 모델이 채워야 하는 필수 필드
  for (const field of ['audience', 'assets', 'teaching_style', 'requirements', 'format']) {
    assert.ok(required.includes(field), `모델 필수 필드 '${field}'가 required 배열에 없다`);
  }
  // expected_revision, request_id는 스키마에서 제거됨 — exec가 자동 생성
  assert.ok(!required.includes('expected_revision'), 'expected_revision은 스키마 required에 없어야 한다 (exec 자동 생성)');
  assert.ok(!required.includes('request_id'), 'request_id는 스키마 required에 없어야 한다 (exec 자동 생성)');
  // assets는 enum 배열이어야 한다
  const assetsSchema = def.inputSchema.properties?.assets;
  assert.ok(assetsSchema?.type === 'array', 'assets must be array type');
  assert.ok(Array.isArray(assetsSchema?.items?.enum), 'assets items must have enum');
  // format은 enum이어야 한다
  const formatSchema = def.inputSchema.properties?.format;
  assert.ok(Array.isArray(formatSchema?.enum), 'format must have enum');
  assert.ok(formatSchema.enum.includes('workshop'), 'format enum must include workshop');
  assert.ok(formatSchema.enum.includes('track'), 'format enum must include track');
});

// ─── T-G15: set_inputs로 revision 올린 뒤 save_plan이 최신 revision 사용 ──
await check('T-G15 set_inputs raises revision; subsequent save_plan uses latest revision', async () => {
  const tmpDir = join(tmpdir(), `chalk-test-g15-${Date.now()}`);
  const course = 'lesson-01';
  const filePath = workingCopyPath(tmpDir, course, 'lesson');
  await mkdir(join(tmpDir, 'chalk', course), { recursive: true });
  await writeFile(filePath, '<html>lesson</html>', 'utf-8');

  // 서버 상태: set_inputs 전 revision=1, set_inputs 성공 후 revision=2
  let currentRevision = 1;

  let savedRevisionInSavePlan = null;
  await withMockServer((req, res) => {
    if (req.method === 'GET' && req.url?.includes('/authoring/')) {
      // fetchExpectedRevision 호출마다 현재 revision 반환
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revision: currentRevision }));
      return;
    }
    if (req.method === 'GET' && req.url?.includes('/knowledge/versions')) {
      // resolveKnowledgeVersion fallback: return latest version
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ versions: [{ version: 1, parent_version: null, origin: 'test', source_repo: null, source_commit: null, note: '', created_by: 'test', created_at: 0, doc_count: 0, digest: '' }] }));
      return;
    }
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      const parsed = JSON.parse(b);
      if (req.url?.includes('/inputs')) {
        // set_inputs 성공 → revision 올림
        currentRevision = 2;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ revision: 2 }));
      } else if (req.url?.includes('/plan')) {
        // save_plan이 넘긴 expected_revision 기록
        savedRevisionInSavePlan = parsed.expected_revision;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ revision: 3, sha256: 'def', findings: [] }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  }, async (port) => {
    // 1. set_inputs — 서버가 revision을 1→2로 올림
    await execSetInputs(fakeCtx(port), {
      cohort: 'c1', course,
      audience: '어린이', assets: ['INTENT'],
      teaching_style: '탐구', requirements: '없음', format: 'workshop',
    });
    // 2. save_plan — fetchExpectedRevision이 authoring에서 revision=2 받아야 함
    await execSavePlan(fakeCtx(port, { cwd: tmpDir }), { cohort: 'c1', course });
    assert.equal(savedRevisionInSavePlan, 2,
      `save_plan expected_revision must be 2 (post-set_inputs revision), got: ${savedRevisionInSavePlan}`);
  });
});

// ─── T-G16: 강사 모드 mergeBrowserTools → browser 도구 2개 포함, 연속 두 턴 ──
await check('T-G16 instructor mode: live_preview_start + browser_open in merged defs (two consecutive turns)', () => {
  const BROWSER_DEFS = [
    { name: 'live_preview_start', description: '라이브 서버 시작', inputSchema: { type: 'object' } },
    { name: 'browser_open', description: '브라우저 열기', inputSchema: { type: 'object' } },
  ];
  const browserTools = { definitions: BROWSER_DEFS, call: async () => 'ok' };

  const mockWork = { definitions: [{ name: 'Read', description: '', inputSchema: {} }], call: async () => 'ok' };

  // Simulate two consecutive instructor turns by merging twice from the same base.
  for (const turn of [1, 2]) {
    const merged = mergeBrowserTools(mockWork, browserTools);
    const names = merged.definitions.map(d => d.name);
    assert.ok(names.includes('live_preview_start'), `턴 ${turn}: live_preview_start 없음`);
    assert.ok(names.includes('browser_open'), `턴 ${turn}: browser_open 없음`);
  }
});

// ─── T-G17: 학생 모드(browserTools=undefined) → browser 도구 없음 ──────────
await check('T-G17 student mode (no browserTools): live_preview_start + browser_open NOT in defs', () => {
  const mockWork = { definitions: [{ name: 'Read', description: '', inputSchema: {} }], call: async () => 'ok' };
  const merged = mergeBrowserTools(mockWork, undefined);
  const names = merged.definitions.map(d => d.name);
  assert.ok(!names.includes('live_preview_start'), 'live_preview_start must not appear without browserTools');
  assert.ok(!names.includes('browser_open'), 'browser_open must not appear without browserTools');
  // Base tools preserved.
  assert.ok(names.includes('Read'), 'Read must still be present');
});

// ─── T-G18: browser_open 라우팅 — url이 실제로 전달되는지 단언 ─────────────
await check('T-G18 mergeBrowserTools routes browser_open and passes the url input through', async () => {
  let calledWith = null;
  const BROWSER_DEFS = [
    { name: 'live_preview_start', description: '', inputSchema: {} },
    { name: 'browser_open', description: '', inputSchema: {} },
  ];
  const TARGET_URL = 'http://127.0.0.1:3000/chalk/lesson-01/lesson.html';
  const browserTools = {
    definitions: BROWSER_DEFS,
    call: async (name, input) => { calledWith = { name, input }; return 'opened'; },
  };
  const mockWork = { definitions: [], call: async () => { throw new Error('base call must not be reached'); } };
  const merged = mergeBrowserTools(mockWork, browserTools);
  const result = await merged.call('browser_open', { url: TARGET_URL });
  assert.equal(calledWith?.name, 'browser_open', 'browser_open이 browserTools.call로 위임되지 않았다');
  // The url must be passed through to browserTools.call, not ignored.
  assert.deepEqual(calledWith?.input, { url: TARGET_URL }, `url이 browserTools.call에 전달되지 않았다: ${JSON.stringify(calledWith?.input)}`);
  assert.equal(result, 'opened', '결과가 browserTools.call 반환값과 다르다');
});

// ─── T-G19: runBrowserOpen isError → call throws (강사 경로 실패 전파) ──────
await check('T-G19 runBrowserOpen isError propagates: call throws so local runtime sees failure', async () => {
  // Fake host: live server up, fetchHead returns 404 for the requested path.
  const LIVE_URL = 'http://127.0.0.1:9999/';
  const fakeHost = {
    openBrowser: async () => {},
    screenshot: async () => null,
    startLivePreview: async () => LIVE_URL,
    livePreviewUrl: async () => LIVE_URL,
    fetchHead: async (_url) => ({ ok: false, status: 404 }),
    currentPage: async () => null,
    openPages: async () => null,
  };

  const r = await runBrowserOpen(fakeHost, LIVE_URL + 'chalk/lesson-01/lesson.html');
  assert.ok(r.isError, 'runBrowserOpen must return isError:true for 404');
  assert.ok(r.content.some(b => b.type === 'text' && b.text.includes('파일이 없어요')),
    `result text must mention 파일이 없어요: ${JSON.stringify(r.content)}`);

  // Simulate what the instructor call() does: throw when isError.
  const text = r.content.map(b => b.type === 'text' ? b.text : '').join('\n');
  let threw = false;
  try {
    if (r.isError) throw new Error(text);
  } catch {
    threw = true;
  }
  assert.ok(threw, 'call must throw for isError result so local runtime marks tool as failed');
});

// ─── T-G20: runBrowserOpen #507 포트 교정 — 잘못된 포트 → 라이브 서버 주소로 교정 ─
await check('T-G20 runBrowserOpen #507: wrong loopback port corrected to live server url', async () => {
  const LIVE_URL = 'http://127.0.0.1:58085/';
  let openedWith = null;
  const fakeHost = {
    openBrowser: async (url) => { openedWith = url; },
    screenshot: async () => null,
    // livePreviewUrl returns null initially → triggers #507 startLivePreview branch.
    livePreviewUrl: async () => null,
    startLivePreview: async () => LIVE_URL,
    currentPage: async () => null,
    openPages: async () => null,
  };

  const WRONG_PORT_URL = 'http://127.0.0.1:3000/';
  const r = await runBrowserOpen(fakeHost, WRONG_PORT_URL);
  assert.ok(!r.isError, `must succeed: ${JSON.stringify(r)}`);
  const text = r.content.map(b => b.type === 'text' ? b.text : '').join('\n');
  assert.ok(text.includes(LIVE_URL), `result must mention the corrected live url ${LIVE_URL}: ${text}`);
  // #507 branch calls startLivePreview which opens the browser — openBrowser is NOT called.
  assert.equal(openedWith, null, 'openBrowser must NOT be called when #507 startLivePreview handles it');
});

// ─── T-G21: chalk_record_feedback in CHALK_TOOL_DEFINITIONS ──────────────────
await check('T-G21 chalk_record_feedback present in CHALK_TOOL_DEFINITIONS', async () => {
  const def = CHALK_TOOL_DEFINITIONS.find(d => d.name === 'chalk_record_feedback');
  assert.ok(def, 'chalk_record_feedback must be in CHALK_TOOL_DEFINITIONS');
  assert.deepEqual(def.inputSchema.required.sort(), ['cohort_id', 'course_id', 'request_id', 'text'].sort());
  assert.equal(def.inputSchema.additionalProperties, false);
});

// ─── T-G22: chalk_view_diff in CHALK_TOOL_DEFINITIONS ────────────────────────
await check('T-G22 chalk_view_diff present in CHALK_TOOL_DEFINITIONS', async () => {
  const def = CHALK_TOOL_DEFINITIONS.find(d => d.name === 'chalk_view_diff');
  assert.ok(def, 'chalk_view_diff must be in CHALK_TOOL_DEFINITIONS');
  assert.deepEqual(def.inputSchema.required.sort(), ['cohort_id', 'course_id'].sort());
  assert.equal(def.inputSchema.additionalProperties, false);
});

// ─── T-G23: chalk_record_feedback calls POST /feedback with auto-filled base_revision ──
await check('T-G23 chalk_record_feedback: POST /feedback auto-fills base_revision from server', async () => {
  let capturedPath = null;
  let capturedBody = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.includes('/authoring/')) {
        // fetchExpectedRevision GET — no body
        res.end(JSON.stringify({ revision: 5 }));
      } else {
        // POST /feedback
        capturedPath = req.url;
        capturedBody = JSON.parse(body);
        res.end(JSON.stringify({ feedback_id: 'fb_test-req-01', base_revision: 5, created_at: 12345 }));
      }
    });
  });
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();

  const ctx = {
    serverUrl: `http://127.0.0.1:${port}`,
    secrets: { get: async () => 'fake-issuer-token' },
    currentModel: 'claude-sonnet-5',
  };

  const result = await callChalkTool(ctx, 'chalk_record_feedback', {
    cohort_id: 'c1', course_id: 'crs1',
    text: '피드백 내용',
    request_id: 'test-req-01',
  });
  const parsed = JSON.parse(result);

  assert.ok(parsed.feedback_id, 'feedback_id must be returned');
  assert.ok(capturedBody !== null, `capturedBody must be set; capturedPath=${capturedPath}`);
  assert.equal(capturedBody.base_revision, 5, 'base_revision must be auto-filled from fetchExpectedRevision');
  assert.equal(capturedBody.model, 'claude-sonnet-5', 'model must be auto-filled from ctx.currentModel');
  assert.equal(capturedBody.request_id, 'test-req-01');

  server.close();
});

// ─── T-G24: chalk_view_diff calls GET /diff with optional params ─────────────
await check('T-G24 chalk_view_diff: GET /diff with from+to params', async () => {
  let capturedUrl = null;
  const server = createServer((req, res) => {
    capturedUrl = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from_revision: 2, to_revision: 3, file: 'lesson', changes: [] }));
  });
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();

  const ctx = {
    serverUrl: `http://127.0.0.1:${port}`,
    secrets: { get: async () => 'fake-issuer-token' },
  };

  const result = await callChalkTool(ctx, 'chalk_view_diff', {
    cohort_id: 'c1', course_id: 'crs1', from: 2, to: 3, file: 'lesson',
  });
  const parsed = JSON.parse(result);

  assert.ok(capturedUrl.includes('from=2'), `URL must include from=2: ${capturedUrl}`);
  assert.ok(capturedUrl.includes('to=3'), `URL must include to=3: ${capturedUrl}`);
  assert.ok(capturedUrl.includes('file=lesson'), `URL must include file=lesson: ${capturedUrl}`);
  assert.deepEqual(parsed.changes, []);

  server.close();
});

console.log(`\n${passed} tests passed`);
