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

const { mergeChalkTools } = await import('../src/localRuntime/index.ts');

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
await check('T-G3 execSetInputs correct path and body includes vocab', async () => {
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
    await execSetInputs(fakeCtx(port), {
      cohort: 'sk-biopharm-kids-s1', course: 'lesson-01',
      audience: '어린이', assets: ['intent', 'verify'],
      teaching_style: '탐구', requirements: '없음', format: 'workshop',
      vocab: { goals: ['concept_understanding'], conditions: ['no_prior'], learner_level: 'novice', has_guidance: false },
      expected_revision: 1, request_id: 'uuid-001',
    });
    assert.match(capturedPath, /\/admin\/chalk\/cohorts\/sk-biopharm-kids-s1\/courses\/lesson-01\/inputs/,
      `inputs 경로 불일치: ${capturedPath}`);
    assert.ok(capturedBody.includes('"vocab"'), `vocab 필드가 바디에 없다`);
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
await check('T-G6 execSavePlan reads working copy and sends html in body', async () => {
  const tmpDir = join(tmpdir(), `chalk-test-${Date.now()}`);
  const course = 'lesson-01';
  const filePath = workingCopyPath(tmpDir, course, 'lesson');
  await mkdir(join(tmpDir, 'chalk', course), { recursive: true });
  await writeFile(filePath, '<html>draft</html>', 'utf-8');

  let capturedPath = '';
  let capturedBody = '';
  await withMockServer((req, res) => {
    capturedPath = req.url ?? '';
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { capturedBody = b; });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ revision: 2, sha256: 'abc', findings: [] }));
  }, async (port) => {
    await execSavePlan(fakeCtx(port, { cwd: tmpDir }), {
      cohort: 'c1', course, knowledge_version: 3, expected_revision: 1, request_id: 'uuid-002',
    });
    assert.match(capturedPath, /\/admin\/chalk\/cohorts\/c1\/courses\/lesson-01\/plan/,
      `plan PUT 경로 불일치: ${capturedPath}`);
    assert.ok(capturedBody.includes('<html>draft</html>'), `작업 사본 html이 바디에 없다`);
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
await check('T-G8 execSavePlan returns revision_conflict on 409 (not throw)', async () => {
  const tmpDir = join(tmpdir(), `chalk-test-conflict-${Date.now()}`);
  const course = 'lesson-01';
  const filePath = workingCopyPath(tmpDir, course, 'lesson');
  await mkdir(join(tmpDir, 'chalk', course), { recursive: true });
  await writeFile(filePath, '<html>draft</html>', 'utf-8');

  await withMockServer((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'revision_mismatch' }));
  }, async (port) => {
    const result = JSON.parse(await callChalkTool(
      fakeCtx(port, { cwd: tmpDir }),
      'chalk_save_plan',
      { cohort: 'c1', course, knowledge_version: 3, expected_revision: 1, request_id: 'uuid-003' },
    ));
    assert.equal(result.error, 'revision_conflict', `409 충돌이 revision_conflict로 반환되지 않았다: ${JSON.stringify(result)}`);
    assert.ok(result.message.includes('chalk_open_course'), '다시 열기 안내에 chalk_open_course가 없다');
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

console.log(`\n${passed} tests passed`);
