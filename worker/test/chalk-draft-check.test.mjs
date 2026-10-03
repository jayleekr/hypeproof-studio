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
// Load chalk_plan_files table for html-absent fallback tests (T-C8).
const planFilesMigration = readFileSync(new URL('../migrations/0031-chalk-plan-files.sql', import.meta.url), 'utf8');
db.exec(planFilesMigration);

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

// ─── T-C6: 깨진 content_json → 200 + skipped 항목 ──────────────────────────
await check('T-C6 broken content_json returns 200 with a skipped gate-check item', async () => {
  const brokenCourse = 'broken-content-course';
  db.prepare(
    `INSERT INTO authoring_drafts (cohort_id, course_id, owner_id, profile_id, revision, content_json, request_id, request_hash, updated_at)
     VALUES (?,?,?,?,1,?,?,?,datetime('now'))`
  ).run(cohort, brokenCourse, 'alice', profileId, 'NOT_VALID_JSON', 'broken-req', 'x');

  const r = await req(`/admin/chalk/cohorts/${cohort}/courses/${brokenCourse}/check`, 'POST', {});
  assert.equal(r.status, 200, r.raw);
  const skipped = r.json?.results?.find(i => i.skipped === true);
  assert.ok(skipped, 'broken content_json must produce a skipped result item');
  assert.equal(skipped.blocks_confirm, false, 'skipped item must not block confirm');
  assert.ok(typeof skipped.message === 'string' && skipped.message.length > 0, 'skipped item has a message');
});

// ─── T-C7: check route body-limit ───────────────────────────────────────────
// T-C7a: valid token + body > 256KB → POST /check returns 413
// T-C7b: invalid token + body > 256KB → POST /check returns 401 (auth before bodyLimit)
const OVER_LIMIT_BODY = JSON.stringify({ html: 'x'.repeat(256 * 1024 + 1) });

await check('T-C7a POST /check valid-token 256KB+ body returns 413', async () => {
  const tok = await mkIssuer('alice-c7');
  const res = await app.fetch(
    new Request('https://service.test' + checkBase, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: OVER_LIMIT_BODY,
    }),
    env, makeCtx(),
  );
  assert.equal(res.status, 413, `expected 413 got ${res.status}`);
});

await check('T-C7b POST /check invalid-token 256KB+ body returns 401', async () => {
  const res = await app.fetch(
    new Request('https://service.test' + checkBase, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-valid-token', 'content-type': 'application/json' },
      body: OVER_LIMIT_BODY,
    }),
    env, makeCtx(),
  );
  assert.equal(res.status, 401, `expected 401 got ${res.status}`);
});

// ─── T-C8: html-absent fallback — /check reads latest plan row ──────────────
// Insert a chalk_plan_files row directly, then POST /check without html.
// G1-* findings (audience-tier=lv1) must appear — same as /check with html supplied.
await check('T-C8 /check without html falls back to latest plan row (G1 checks fire)', async () => {
  const planCheckBase = `/admin/chalk/cohorts/${cohort}/courses/site-check/check`;

  // HTML with audience-tier=lv1 so G1-* checks fire.
  const richHtml = `<!DOCTYPE html>
<html lang="ko" data-chalk-plan="1" data-chalk-kind="lesson">
<head>
  <meta charset="utf-8">
  <meta name="chalk:course" content="site-check">
  <meta name="chalk:knowledge-version" content="1">
  <meta name="chalk:format" content="workshop">
  <meta name="chalk:family-session" content="false">
  <meta name="chalk:duration-min" content="90">
  <meta name="chalk:methods" content="m-001">
  <meta name="chalk:audience-tier" content="lv1">
  <meta name="chalk:prerequisites" content="없음">
</head>
<body>
  <section data-chalk-section="meta">
    <table>
      <tr><th>과목</th><td>테스트</td></tr>
      <tr><th>형식</th><td>workshop</td></tr>
      <tr><th>시간</th><td>90분</td></tr>
      <tr><th>선행 조건</th><td>없음</td></tr>
    </table>
  </section>
  <section data-chalk-section="objectives">
    <ul><li data-chalk-objective="obj-1">목표. 자격증</li></ul>
  </section>
  <section data-chalk-section="essential-question">
    <p data-chalk-question>질문</p>
  </section>
  <section data-chalk-section="evidence">
    <ul><li data-chalk-evidence="ev-1">제출 증거: 기록지</li></ul>
  </section>
  <section data-chalk-section="flow">
    <table data-chalk-flow>
      <tr data-chalk-step="s-1" data-duration-min="40" data-chalk-requires="" data-chalk-forbids="">
        <th data-chalk-field="title">활동</th>
        <td data-chalk-role="teacher">안내</td>
        <td data-chalk-role="learner">활동 수행 후 제출 증거: 기록지</td>
      </tr>
    </table>
  </section>
  <section data-chalk-section="key-questions">
    <ul><li data-chalk-key-question>핵심 질문</li></ul>
  </section>
  <section data-chalk-section="prohibited-moves">
    <ul><li data-chalk-move="P1" data-chalk-step="s-1">금지 개입</li></ul>
  </section>
  <section data-chalk-section="materials">
    <ul><li data-chalk-material data-kind="physical" data-owner="instructor">기록지</li></ul>
  </section>
  <section data-chalk-section="safety" data-chalk-safety="none"></section>
  <section data-chalk-section="bridging"><p>연결</p></section>
  <section data-chalk-section="support"></section>
</body>
</html>`;

  // Insert plan row directly so we avoid PUT /plan CAS complexity in a shared DB.
  db.prepare(
    `INSERT OR REPLACE INTO chalk_plan_files
     (cohort_id, course_id, ref_kind, ref, file, html, sha256, knowledge_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cohort, 'site-check', 'draft', '99', 'lesson', richHtml, 'sha-tc8', 1, Date.now());

  // POST /check without html — should fall back to the row above.
  const noHtmlR = await req(planCheckBase, 'POST', {});
  assert.equal(noHtmlR.status, 200, `POST /check (no html): ${noHtmlR.raw}`);
  const noHtmlChecks = (noHtmlR.json.results ?? []).map(f => f.check).filter(Boolean);

  // G1-4 (자격증) should fire since the html body contains "자격증".
  assert.ok(
    noHtmlChecks.includes('g1_4_credential'),
    `expected g1_4_credential in /check results (no html): ${JSON.stringify(noHtmlChecks)}`,
  );

  // POST /check with same html — must produce the same check names.
  const withHtmlR = await req(planCheckBase, 'POST', { html: richHtml });
  assert.equal(withHtmlR.status, 200, `POST /check (with html): ${withHtmlR.raw}`);
  const withHtmlChecks = (withHtmlR.json.results ?? []).map(f => f.check).filter(Boolean).sort();

  assert.deepEqual(
    noHtmlChecks.slice().sort(),
    withHtmlChecks,
    `html-absent vs html-present check sets differ:\nno-html: ${noHtmlChecks}\nwith-html: ${withHtmlChecks}`,
  );
});

console.log(`\n${passed} tests passed`);
