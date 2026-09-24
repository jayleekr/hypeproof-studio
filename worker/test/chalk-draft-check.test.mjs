// #1294 — POST /admin/chalk/cohorts/:cohort/courses/:course/check 라우트 검증.
// 실제 Service 라우팅 + 서명 토큰 + 운영 SQL(SQLite in-memory).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './harness/index.mjs';

const { issueIssuer, issue } = await import('../src/lib/tokens.ts');
const app = await bootApp();

const cohort = 'boah-dental-2026-a';
const { listProfiles } = await import('../src/profiles/index.ts');
const profileId = listProfiles().find(p => p.session.cohort_id === cohort)?.id;
assert.ok(profileId, 'harness sanity: profileId found');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
const migration = readFileSync(new URL('../migrations/0002-chalk-authoring.sql', import.meta.url), 'utf8');
db.exec(migration);

const env = createMockEnv();
env.HPS_DB = { prepare(sql) {
  let bindings = [];
  return {
    bind(...args) { bindings = args; return this; },
    async first() { return db.prepare(sql).get(...bindings) ?? null; },
    async run() { const r = db.prepare(sql).run(...bindings); return { success: true, meta: { changes: Number(r.changes) } }; },
    async all() { return { success: true, results: db.prepare(sql).all(...bindings) }; },
  };
}};

const mkIssuer = (id, opts = {}) =>
  issueIssuer({ issuer: id, scopes: [{ cohort, profiles: [profileId], ...opts }] }, 48, TEST_SECRET)
    .then(t => t.token);
const mkStudent = () =>
  issue({ u: 'student', c: cohort, p: profileId }, 1, TEST_SECRET).then(t => t.token);

const alice = await mkIssuer('alice');
const bob   = await mkIssuer('bob');
const student = await mkStudent();

const authBase = `/admin/cohorts/${cohort}/authoring/site-check`;
const checkBase = `/admin/chalk/cohorts/${cohort}/courses/site-check/check`;

const req = (path, method = 'POST', body, cred = alice) => {
  const headers = { authorization: `Bearer ${cred}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.fetch(
    new Request('https://service.test' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    makeCtx(),
  ).then(async res => {
    const raw = await res.text();
    let json;
    try { json = JSON.parse(raw); } catch {}
    return { status: res.status, json, raw };
  });
};

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

// ─── 사전 준비: alice가 초안을 만든다 ────────────────────────────────────────
const draftContent = {
  schema: 'hps-session-design/1',
  title: '진료시간 수정',
  audience: '치과의사',
  duration_minutes: 120,
  objective: '진료시간을 수정하고 검수한다',
  prerequisites: '코딩 경험 불필요. 예제 폴더 사본 제공',
  starter: '정적 홈페이지 예제',
  steps: [{ id: 'edit', title: '시간 변경', instructions: '진료시간을 변경하세요', hint: '', acceptance: '모바일에서 확인' }],
};

await req(authBase, 'PUT', {
  expected_revision: 0,
  request_id: 'create-for-check',
  profile_id: profileId,
  content: draftContent,
});

// ─── T-C1: 학생 토큰 → 403 ──────────────────────────────────────────────────
await check('T-C1 student token is denied (403)', async () => {
  const r = await req(checkBase, 'POST', {}, student);
  assert.equal(r.status, 403, r.raw);
});

// ─── T-C2: 다른 강사 강의 → 404 ─────────────────────────────────────────────
await check('T-C2 other instructor gets 404 for owned course', async () => {
  const r = await req(checkBase, 'POST', {}, bob);
  assert.equal(r.status, 404, r.raw);
});

// ─── T-C3: 정상 — 항목과 위치를 돌려준다 ────────────────────────────────────
await check('T-C3 normal check returns results array with at fields', async () => {
  const r = await req(checkBase, 'POST', {});
  assert.equal(r.status, 200, r.raw);
  assert.ok(Array.isArray(r.json.results), 'results is array');

  for (const item of r.json.results) {
    assert.ok('severity' in item, 'item has severity');
    assert.ok('at' in item, 'item has at');
    assert.ok('message' in item, 'item has message');
    assert.ok('source' in item, 'item has source');
    assert.ok('blocks_confirm' in item, 'item has blocks_confirm');
    assert.equal(item.judge, 'machine');
  }
});

// ─── T-C4: HTML 본문 첨부 — 규격 위반이 results에 포함된다 ───────────────────
await check('T-C4 malformed HTML in body produces parser violation in results', async () => {
  const badHtml = `<html lang="ko" data-chalk-plan="1" data-chalk-kind="lesson"><body>
    <script>alert(1)</script>
  </body></html>`;
  const r = await req(checkBase, 'POST', { html: badHtml });
  assert.equal(r.status, 200, r.raw);
  const parserItems = r.json.results.filter(i => i.source.includes('chalk-plan/1 parser'));
  assert.ok(parserItems.length > 0, 'parser violations present when html has script tag');
  for (const i of parserItems) {
    assert.equal(i.blocks_confirm, false, 'parser violations never block confirm');
    assert.equal(i.severity, 'warn');
  }
});

// ─── T-C5: fail 있는 초안도 저장·검사된다. 확정 경로 422는 그대로 ──────────
await check('T-C5 draft with blocking pedagogy can be saved and checked; freeze path unchanged', async () => {
  // 빈 steps로 초안 저장 (step_evidence 검사가 발화한다)
  const blocking = {
    ...draftContent,
    steps: [],
  };
  const saveR = await req(authBase, 'PUT', {
    expected_revision: 1,
    request_id: 'blocking-draft',
    profile_id: profileId,
    content: blocking,
  });
  assert.equal(saveR.status, 200, `draft save: ${saveR.raw}`);

  // 검사 경로: 200을 낸다 (저장이 block 안 됐음)
  const checkR = await req(checkBase, 'POST', {});
  assert.equal(checkR.status, 200, checkR.raw);

  // 확정 경로는 422 그대로 (validateSessionDesign가 막는다)
  const freezeR = await req(authBase + '/versions/m2099.01.01-1', 'PUT', { expected_revision: 2 });
  assert.notEqual(freezeR.status, 200, 'freeze with incomplete design should not succeed');
  assert.ok([400, 422].includes(freezeR.status), `freeze status should be 400 or 422, got ${freezeR.status}`);
});

console.log(`\n${passed} tests passed`);
