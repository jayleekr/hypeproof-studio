// #1469 (E3-3) — deriveRunbook / deriveHandout pure functions + POST /derive + GET /plan?file=runbook|handout
// DR-01~DR-11
import './harness/loader.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, COHORT } from './harness/index.mjs';

const { issueIssuer } = await import('../src/lib/tokens.ts');
const { listProfiles } = await import('../src/profiles/index.ts');
const { deriveRunbook, deriveHandout } = await import('../src/lib/chalk-derive.ts');
const { sha256Hex } = await import('../src/lib/modules.ts');

const app = await bootApp();

const AUTHORING_SCHEMA = readFileSync(new URL('../migrations/0002-chalk-authoring.sql', import.meta.url), 'utf8');
const PLAN_SCHEMA = readFileSync(new URL('../migrations/0031-chalk-plan-files.sql', import.meta.url), 'utf8');
const TIER_DURATION_SCHEMA = readFileSync(new URL('../migrations/0035-chalk-course-inputs-tier-duration.sql', import.meta.url), 'utf8');

const profileId = listProfiles().find(p => p.session.cohort_id === COHORT)?.id;
assert.ok(profileId, 'profile not found for COHORT');

// ── Sample ops HTML ───────────────────────────────────────────────────────────
const SAMPLE_OPS_HTML = `<!DOCTYPE html>
<html lang="ko" data-chalk-plan="1" data-chalk-kind="ops">
<head>
  <meta charset="utf-8">
  <meta name="chalk:course" content="test-course">
  <meta name="chalk:knowledge-version" content="1">
  <meta name="chalk:format" content="track">
  <meta name="chalk:audience-tier" content="lv1">
  <meta name="chalk:family-session" content="false">
  <meta name="chalk:duration-min" content="240">
</head>
<body>
  <section data-chalk-section="schedule">
    <table>
      <tr data-chalk-block="block-1" data-chalk-step-ref="s-1 s-2" data-start="09:00" data-duration-min="110">
        <td data-chalk-field="activity">탐구 활동</td>
        <td data-chalk-field="asset">탐구 키트</td>
        <td data-chalk-field="artifact">탐구 노트</td>
        <td data-chalk-role="facilitator">진행자 안내</td>
        <td data-chalk-role="assistant">보조 지원</td>
        <td data-chalk-role="learner">탐구 수행</td>
        <td data-chalk-field="exit-criteria">노트 완성</td>
        <td data-chalk-field="if-stuck">힌트 제공</td>
      </tr>
      <tr data-chalk-block="break" data-chalk-block-kind="break" data-start="10:50" data-duration-min="20">
        <td data-chalk-field="activity">쉬는 시간</td>
      </tr>
      <tr data-chalk-block="buffer" data-chalk-block-kind="buffer" data-start="11:10" data-duration-min="10">
        <td data-chalk-field="activity">여유 시간</td>
        <td data-chalk-role="facilitator">조율</td>
        <td data-chalk-role="learner">자유</td>
        <td data-chalk-field="if-ahead">일찍 끝나면 심화</td>
        <td data-chalk-field="if-behind">늦으면 축소</td>
      </tr>
      <tr data-chalk-block="block-2" data-chalk-step-ref="s-3" data-start="11:20" data-duration-min="100">
        <td data-chalk-field="activity">심화 탐구</td>
        <td data-chalk-field="asset">발표 카드</td>
        <td data-chalk-field="artifact">발표 자료</td>
        <td data-chalk-role="facilitator">심화 진행</td>
        <td data-chalk-role="learner">심화 활동</td>
        <td data-chalk-field="exit-criteria">발표 완료</td>
        <td data-chalk-field="if-stuck">질문 유도</td>
      </tr>
    </table>
  </section>
  <section data-chalk-section="materials">
    <ul>
      <li data-owner="learner">탐구 키트 (학생용)</li>
      <li data-owner="instructor">진행자 매뉴얼</li>
      <li data-owner="parent">학부모 안내문</li>
    </ul>
  </section>
  <section data-chalk-section="risks">
    <ul>
      <li data-chalk-risk="ai-latency"><span data-chalk-field="first-line">AI 응답 지연</span></li>
      <li data-chalk-risk="content-guard"><span data-chalk-field="first-line">부적절 콘텐츠 차단</span></li>
      <li data-chalk-risk="pace-gap"><span data-chalk-field="first-line">속도 차이</span></li>
      <li data-chalk-risk="parent-overreach"><span data-chalk-field="first-line">보호자 과잉 개입</span></li>
      <li data-chalk-risk="overtime"><span data-chalk-field="first-line">시간 초과</span></li>
    </ul>
  </section>
  <section data-chalk-section="consent"><ul><li>동의 항목</li></ul></section>
  <section data-chalk-section="post-deliverables"><ul><li>사후 제출물</li></ul></section>
</body>
</html>`;

const SAMPLE_OPS_SHA = 'test-ops-sha-abc123';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(AUTHORING_SCHEMA);
  db.exec(PLAN_SCHEMA);
  db.exec(TIER_DURATION_SCHEMA);
  db.prepare(
    `INSERT INTO authoring_drafts (cohort_id,course_id,owner_id,profile_id,revision,content_json,request_id,request_hash,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    COHORT, 'test-course', 'tester', '', 1,
    '{"schema":"hps-session-design/1","title":"","audience":"","duration_minutes":120,"objective":"","prerequisites":"","starter":"","steps":[]}',
    'req-seed', 'hash-seed', new Date().toISOString(),
  );
  return db;
}

function makeEnv(db) {
  const env = createMockEnv({ withSession: false });
  function makeStmt(sql) {
    let bindings = [];
    const stmt = {
      get _sql() { return sql; },
      bind(...args) { bindings = [...args]; return stmt; },
      async first() { return db.prepare(sql).get(...bindings) ?? null; },
      async run() { const r = db.prepare(sql).run(...bindings); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { success: true, results: db.prepare(sql).all(...bindings) }; },
    };
    return stmt;
  }
  env.HPS_DB = {
    prepare(sql) { return makeStmt(sql); },
    async batch(stmts) {
      const results = [];
      for (const stmt of stmts) {
        try { results.push(await stmt.run()); } catch { results.push({ success: false }); }
      }
      return results;
    },
  };
  return env;
}

async function makeTok(db) {
  const env = makeEnv(db);
  const tok = (await issueIssuer({ issuer: 'tester', scopes: [{ cohort: COHORT, profiles: [profileId] }] }, 4, TEST_SECRET)).token;
  return { tok, env };
}

async function req(method, path, body, tok, db) {
  const env = makeEnv(db);
  const base = `/admin/chalk/cohorts/${COHORT}/courses/test-course`;
  const fullPath = path.startsWith('/') ? path : `${base}/${path}`;
  const headers = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
  const init = body !== null ? { method, headers, body: JSON.stringify(body) } : { method, headers };
  const res = await app.fetch(
    new Request('https://service.test' + fullPath, init),
    env, makeCtx(),
  );
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function seedOps(db, sha) {
  const actualSha = sha ?? await sha256Hex(SAMPLE_OPS_HTML);
  db.prepare(
    `INSERT INTO chalk_plan_files (cohort_id,course_id,ref_kind,ref,file,html,sha256,knowledge_version,created_at) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(COHORT, 'test-course', 'draft', '1', 'ops', SAMPLE_OPS_HTML, actualSha, 1, Date.now());
  return actualSha;
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

// ── Pure function tests (no HTTP) ─────────────────────────────────────────────

// DR-01: runbook has data-chalk-kind="runbook" and data-chalk-derived-from=sha
await check('DR-01 deriveRunbook → data-chalk-kind="runbook", data-chalk-derived-from=sha', () => {
  const html = deriveRunbook(SAMPLE_OPS_HTML, SAMPLE_OPS_SHA);
  assert.ok(html.includes('data-chalk-kind="runbook"'), 'must have kind=runbook');
  assert.ok(html.includes(`data-chalk-derived-from="${SAMPLE_OPS_SHA}"`), 'must have derived-from sha');
});

// DR-02: handout has data-chalk-kind="handout" and same derived-from
await check('DR-02 deriveHandout → data-chalk-kind="handout", data-chalk-derived-from=sha', () => {
  const html = deriveHandout(SAMPLE_OPS_HTML, SAMPLE_OPS_SHA);
  assert.ok(html.includes('data-chalk-kind="handout"'), 'must have kind=handout');
  assert.ok(html.includes(`data-chalk-derived-from="${SAMPLE_OPS_SHA}"`), 'must have derived-from sha');
});

// DR-03: deterministic — same input → same output
await check('DR-03 deriveRunbook and deriveHandout are deterministic', () => {
  const r1 = deriveRunbook(SAMPLE_OPS_HTML, SAMPLE_OPS_SHA);
  const r2 = deriveRunbook(SAMPLE_OPS_HTML, SAMPLE_OPS_SHA);
  assert.equal(r1, r2, 'runbook must be deterministic');
  const h1 = deriveHandout(SAMPLE_OPS_HTML, SAMPLE_OPS_SHA);
  const h2 = deriveHandout(SAMPLE_OPS_HTML, SAMPLE_OPS_SHA);
  assert.equal(h1, h2, 'handout must be deterministic');
});

// DR-04: handout excludes facilitator, assistant, exit-criteria, if-stuck, if-ahead, buffer blocks, instructor materials
await check('DR-04 handout excludes facilitator/assistant/exit-criteria/if-stuck/if-ahead/buffer/instructor-materials', () => {
  const html = deriveHandout(SAMPLE_OPS_HTML, SAMPLE_OPS_SHA);
  // These should NOT appear in the handout
  assert.ok(!html.includes('진행자 안내'), 'facilitator text must be excluded');
  assert.ok(!html.includes('보조 지원'), 'assistant text must be excluded');
  assert.ok(!html.includes('노트 완성'), 'exit-criteria must be excluded');
  assert.ok(!html.includes('힌트 제공'), 'if-stuck must be excluded');
  assert.ok(!html.includes('일찍 끝나면 심화'), 'if-ahead must be excluded');
  assert.ok(!html.includes('여유 시간'), 'buffer activity must be excluded');
  assert.ok(!html.includes('진행자 매뉴얼'), 'instructor materials must be excluded');
  // These SHOULD appear
  assert.ok(html.includes('탐구 수행'), 'learner role must be included');
  assert.ok(html.includes('탐구 노트'), 'artifact must be included');
  assert.ok(html.includes('탐구 키트 (학생용)'), 'learner materials must be included');
  assert.ok(html.includes('학부모 안내문'), 'parent materials must be included');
});

// DR-05: no <script> and no external URLs in handout
await check('DR-05 handout has no <script> and no external http URLs', () => {
  const html = deriveHandout(SAMPLE_OPS_HTML, SAMPLE_OPS_SHA);
  assert.ok(!/<script/i.test(html), 'must not have <script> tags');
  assert.ok(!/https?:\/\//.test(html), 'must not have external URLs');
  const runbook = deriveRunbook(SAMPLE_OPS_HTML, SAMPLE_OPS_SHA);
  assert.ok(!/<script/i.test(runbook), 'runbook must not have <script> tags');
  assert.ok(!/https?:\/\//.test(runbook), 'runbook must not have external URLs');
});

// ── HTTP tests ────────────────────────────────────────────────────────────────

// DR-06: ops re-save → GET /plan?file=runbook returns stale:true
await check('DR-06 after derive, re-saving ops → GET /plan?file=runbook returns stale:true', async () => {
  const db = makeDb();
  const { tok } = await makeTok(db);
  const opsSha = await seedOps(db);

  // Derive runbook
  const deriveR = await req('POST', 'derive', { file: 'runbook' }, tok, db);
  assert.equal(deriveR.status, 201, `derive must return 201: ${JSON.stringify(deriveR.json)}`);

  // GET runbook before re-save: not stale
  const getR1 = await req('GET', `plan?file=runbook`, null, tok, db);
  assert.equal(getR1.status, 200);
  assert.equal(getR1.json.stale, false, 'runbook should not be stale before ops update');

  // Insert a new ops with different sha to simulate re-save
  db.prepare(
    `INSERT OR REPLACE INTO chalk_plan_files (cohort_id,course_id,ref_kind,ref,file,html,sha256,knowledge_version,created_at) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(COHORT, 'test-course', 'draft', '2', 'ops', SAMPLE_OPS_HTML + '<!-- updated -->', 'new-sha-after-update', 1, Date.now() + 1);

  // GET runbook after re-save: should be stale
  const getR2 = await req('GET', `plan?file=runbook`, null, tok, db);
  assert.equal(getR2.status, 200);
  assert.equal(getR2.json.stale, true, 'runbook should be stale after ops update');
});

// DR-07: ops missing → POST /derive 400 missing_ops
await check('DR-07 ops missing → POST /derive returns 400 missing_ops', async () => {
  const db = makeDb();
  const { tok } = await makeTok(db);
  const r = await req('POST', 'derive', { file: 'runbook' }, tok, db);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'missing_ops');
});

// DR-08: same ops sha → second POST /derive returns 200 (idempotent)
await check('DR-08 same ops sha → second POST /derive returns 200 (idempotent)', async () => {
  const db = makeDb();
  const { tok } = await makeTok(db);
  await seedOps(db);

  const r1 = await req('POST', 'derive', { file: 'handout' }, tok, db);
  assert.equal(r1.status, 201, `first derive must be 201: ${JSON.stringify(r1.json)}`);

  const r2 = await req('POST', 'derive', { file: 'handout' }, tok, db);
  assert.equal(r2.status, 200, `second derive with same sha must be 200: ${JSON.stringify(r2.json)}`);
  assert.equal(r2.json.status, 'unchanged');
});

// DR-09: student token → 401/403; wrong course → 404
await check('DR-09 student token → 401/403; wrong course → 404', async () => {
  const db = makeDb();
  const env = makeEnv(db);
  await seedOps(db);

  // Use student token (plain token, not issuer)
  const studentRes = await app.fetch(
    new Request(`https://service.test/admin/chalk/cohorts/${COHORT}/courses/test-course/derive`, {
      method: 'POST',
      headers: { authorization: 'Bearer student-invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'runbook' }),
    }),
    env, makeCtx(),
  );
  assert.ok([401, 403].includes(studentRes.status), `student token must get 401/403, got ${studentRes.status}`);

  // Wrong course
  const { tok } = await makeTok(db);
  const wrongCourse = await req('POST', `/admin/chalk/cohorts/${COHORT}/courses/nonexistent/derive`, { file: 'runbook' }, tok, db);
  assert.equal(wrongCourse.status, 404, `wrong course must get 404: ${JSON.stringify(wrongCourse.json)}`);
});

// DR-10: chalk_derive propagates missing_ops error to caller
await check('DR-10 derive missing_ops returns {error:"missing_ops"} body, not an exception', async () => {
  const db = makeDb();
  const { tok } = await makeTok(db);
  const r = await req('POST', 'derive', { file: 'runbook' }, tok, db);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'missing_ops', `must return code missing_ops: ${JSON.stringify(r.json)}`);
  assert.ok(typeof r.json.error === 'string', 'must return error message string');
});

// DR-11: PUT /plan file=runbook → 400
await check('DR-11 PUT /plan file=runbook → 400 invalid_request', async () => {
  const db = makeDb();
  const { tok } = await makeTok(db);
  const r = await req('PUT', 'plan', { html: '<html></html>', file: 'runbook', knowledge_version: 1, expected_revision: 1, request_id: 'req-dr11' }, tok, db);
  assert.equal(r.status, 400, `PUT /plan file=runbook must be 400: ${JSON.stringify(r.json)}`);
});

console.log(`\nAll ${passed} tests passed.`);
