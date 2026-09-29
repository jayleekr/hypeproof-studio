// 교육 원칙 관문 v0 — 순수 함수 판정 + freeze 라우트의 차단/통과.
//
// 대조군 규율(.claude/rules/verification.md 규칙 2·3):
//
//   양성 대조  docs/curriculum/dental-ownership/generated/drafts.json의 **실제 5강**을
//              그대로 넣는다. 합성 시료가 아니라 강사가 쓴 물건이다. 이게 막히면
//              계측기가 너무 엄격한 것이고, 오늘 이 관문이 저지를 가장 비싼 실수다.
//   음성 대조  결함을 **하나씩 심어** 그 검사만 정확히 깨어나는지 센다. 정답을 알고
//              시작하므로 계측기가 고장나면 즉시 드러난다.
//
// 라우트 절반은 실제 Service 앱 + 서명 토큰 + 운영 SQL을 돌리는 SQLite다
// (authoring.test.mjs와 같은 방식). 판정이 HTTP 경계를 실제로 통과하는지 본다.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './harness/index.mjs';

const {
  checkLessonPedagogy,
  blockingPedagogyFindings,
  PEDAGOGY_CHECKS,
  DURATION_TOLERANCE_MIN,
  UNVERIFIED_SOURCE,
} = await import('../src/lib/lesson-pedagogy.ts');
const { validateSessionDesign } = await import('../src/lib/session-design.ts');
const { issueIssuer } = await import('../src/lib/tokens.ts');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const byCheck = (findings, id) => findings.filter(f => f.check === id);
const firing = findings => findings.filter(f => !f.skipped);

// ─── 1. 양성 대조 — 실제 치과 5강이 통과해야 한다 ────────────────────────────
const batch = JSON.parse(
  readFileSync(new URL('../../docs/curriculum/dental-ownership/generated/drafts.json', import.meta.url), 'utf8'),
);
assert.equal(batch.courses.length, 5, 'fixture sanity: five real courses');

await check('양성 대조: 실제 치과 L1~L5가 차단되지 않는다', () => {
  for (const course of batch.courses) {
    // 시료가 진짜인지 먼저 확인한다 — 형태 검증을 통과 못 하는 물건이면 관문 판정은 의미가 없다.
    assert.equal(validateSessionDesign(course.content, true), null, `${course.course_id} is a real freezable lesson`);
    const findings = checkLessonPedagogy(course.content);
    assert.deepEqual(
      blockingPedagogyFindings(findings), [],
      `${course.course_id} must not be blocked: ${JSON.stringify(blockingPedagogyFindings(findings))}`,
    );
    // 30단계 전부 "제출 증거:"를 갖고 있으므로 발화하는 warn 도 없어야 한다.
    assert.deepEqual(firing(findings.filter(f => f.severity === 'warn')), [],
      `${course.course_id} must not warn: ${JSON.stringify(firing(findings))}`);
    // 남는 것은 duration skip 하나뿐이다.
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, 'duration_consistency');
    assert.equal(findings[0].skipped, true);
  }
});

// 이후 음성 대조의 기준 시료. 실제 L1을 복제해 쓰므로 "결함 하나만 다른" 대조가 된다.
const clone = () => JSON.parse(JSON.stringify(batch.courses[0].content));

await check('기준 시료는 결함이 없다 (음성 대조의 대조군)', () => {
  assert.deepEqual(blockingPedagogyFindings(checkLessonPedagogy(clone())), []);
});

// ─── 2. 음성 대조 — 결함을 하나씩 심는다 ────────────────────────────────────
await check('음성 대조 fail: 단계 완료 기준이 비면 그 단계만 차단된다', () => {
  const content = clone();
  content.steps[2].acceptance = '   ';                       // 공백만 — blank 취급
  const findings = checkLessonPedagogy(content);
  const hits = byCheck(findings, 'step_acceptance');
  assert.equal(hits.length, 1, '심은 결함 1개 → 판정 1개');
  assert.equal(hits[0].severity, 'fail');
  assert.equal(hits[0].step_id, content.steps[2].id, '어느 단계인지 지목한다');
  assert.ok(hits[0].remedy.trim(), 'remedy 가 비어 있지 않다');
  assert.equal(blockingPedagogyFindings(findings).length, 1);
});

await check('음성 대조 fail: 선행 조건이 비면 수업 단위로 차단된다', () => {
  const content = clone();
  content.prerequisites = '';
  const findings = checkLessonPedagogy(content);
  const hits = byCheck(findings, 'lesson_prerequisites');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'fail');
  assert.equal(hits[0].step_id, undefined, '수업 단위 판정에는 step_id 가 없다');
  // 정본 조항이 아직 확정되지 않았다는 사실이 응답에 그대로 드러나야 한다.
  assert.equal(hits[0].source, UNVERIFIED_SOURCE, '미확정 조항을 확정된 것처럼 보이지 않게 한다');
});

await check('음성 대조 warn: 증거물 미지목은 경고이고 차단하지 않는다', () => {
  const content = clone();
  content.steps[1].instructions = '두 시안을 비교하세요.';    // "제출 증거:" 줄 제거
  const findings = checkLessonPedagogy(content);
  const hits = byCheck(findings, 'step_evidence');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'warn');
  assert.equal(hits[0].step_id, content.steps[1].id);
  assert.deepEqual(blockingPedagogyFindings(findings), [], '경고는 확정을 막지 않는다');
});

await check('증거물 판정은 전각 콜론과 앞 공백을 견딘다', () => {
  for (const line of ['제출 증거： review.md', '  제출증거:  review.md', '제출\t증거\t:\tx']) {
    const content = clone();
    content.steps[0].instructions = `실습: 무언가 한다\n${line}`;
    assert.equal(byCheck(checkLessonPedagogy(content), 'step_evidence').length, 0, `should accept: ${line}`);
  }
  // 값이 없는 접두사는 지목이 아니다.
  const empty = clone();
  empty.steps[0].instructions = '실습: 무언가 한다\n제출 증거:';
  assert.equal(byCheck(checkLessonPedagogy(empty), 'step_evidence').length, 1, '값 없는 접두사는 미지목');
});

await check('여러 결함은 각각 따로 보고된다 (첫 위반에서 멈추지 않는다)', () => {
  const content = clone();
  content.prerequisites = '';
  content.steps[0].acceptance = '';
  content.steps[1].acceptance = '';
  content.steps[2].instructions = '증거 없는 안내';
  const findings = checkLessonPedagogy(content);
  assert.equal(byCheck(findings, 'step_acceptance').length, 2);
  assert.equal(byCheck(findings, 'lesson_prerequisites').length, 1);
  assert.equal(byCheck(findings, 'step_evidence').length, 1);
  assert.equal(blockingPedagogyFindings(findings).length, 3, 'fail 3건이 전부 보인다');
});

// ─── 3. skip 은 통과가 아니다 ───────────────────────────────────────────────
await check('duration 검사는 항상 skip 으로 남고 통과로 세지 않는다', () => {
  const findings = checkLessonPedagogy(clone());
  const hits = byCheck(findings, 'duration_consistency');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].skipped, true);
  assert.equal(hits[0].severity, 'warn', 'skip 은 fail 이 아니므로 차단하지 않는다');
  assert.deepEqual(blockingPedagogyFindings(findings), []);
  // 조항이 임계값을 이미 정해 두었다 — 제품이 새로 정하지 않는다.
  assert.equal(DURATION_TOLERANCE_MIN, 10);
  assert.match(hits[0].remedy, /±10분/);
});

await check('모든 판정은 check·severity·message·remedy·source 를 갖는다', () => {
  const content = clone();
  content.prerequisites = '';
  content.steps[0].acceptance = '';
  content.steps[0].instructions = '증거 없음';
  for (const f of checkLessonPedagogy(content)) {
    assert.ok(PEDAGOGY_CHECKS.includes(f.check), `known check: ${f.check}`);
    assert.ok(['fail', 'warn'].includes(f.severity));
    for (const k of ['message', 'remedy', 'source']) {
      assert.equal(typeof f[k], 'string');
      assert.ok(f[k].trim(), `${f.check}.${k} is non-empty`);
    }
  }
});

await check('판정은 입력을 변경하지 않는다', () => {
  const content = clone();
  const before = JSON.stringify(content);
  checkLessonPedagogy(content);
  assert.equal(JSON.stringify(content), before);
});

// ─── 4. freeze 라우트 — 실제 앱·서명 토큰·운영 SQL ──────────────────────────
const app = await bootApp();
const cohort = 'boah-dental-2026-a';
const { listProfiles } = await import('../src/profiles/index.ts');
const profileId = listProfiles().find(p => p.session.cohort_id === cohort)?.id;
assert.ok(profileId);

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
db.exec(readFileSync(new URL('../migrations/0002-chalk-authoring.sql', import.meta.url), 'utf8'));
const env = createMockEnv();
env.HPS_DB = { prepare(sql) {
  let bindings = [];
  return {
    bind(...args) { bindings = args; return this; },
    async first() { return db.prepare(sql).get(...bindings) ?? null; },
    async run() { const r = db.prepare(sql).run(...bindings); return { success: true, meta: { changes: Number(r.changes) } }; },
    async all() { return { success: true, results: db.prepare(sql).all(...bindings) }; },
  };
} };

const token = (await issueIssuer({ issuer: 'pedagogy-author', scopes: [{ cohort, profiles: [profileId] }] }, 48, TEST_SECRET)).token;
const request = async (path, method = 'GET', body) => {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.fetch(
    new Request('https://service.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env, makeCtx(),
  );
  const raw = await res.text();
  let json; try { json = JSON.parse(raw); } catch { /* non-json */ }
  return { status: res.status, json };
};

/** 초안을 저장하고 확정을 시도한다. course 마다 독립된 id 를 쓴다. */
async function saveAndFreeze(course, content, version) {
  const base = `/admin/cohorts/${cohort}/authoring/${course}`;
  const saved = await request(base, 'PUT', { expected_revision: 0, request_id: `${course}-save`, profile_id: profileId, content });
  assert.equal(saved.status, 200, `draft save: ${JSON.stringify(saved.json)}`);
  return request(`${base}/versions/${version}`, 'PUT', { expected_revision: saved.json.revision });
}

await check('라우트: warn 만 있으면 확정되고 판정이 응답에 실린다', async () => {
  const content = clone();
  content.steps[1].instructions = '증거를 지목하지 않은 안내';   // warn 1건
  const res = await saveAndFreeze('pedagogy-warn', content, 'm2026.09.18-1');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.module, '확정본이 돌아온다');
  assert.ok(Array.isArray(res.json.pedagogy), '성공 응답이 판정 목록을 싣는다');
  assert.equal(res.json.pedagogy.filter(f => f.severity === 'fail').length, 0);
  assert.equal(res.json.pedagogy.filter(f => f.check === 'step_evidence').length, 1);
  assert.ok(res.json.pedagogy.some(f => f.skipped), 'skip 도 숨기지 않는다');
});

await check('라우트: fail 이 있으면 422 로 막고 판정 목록 전체를 돌려준다', async () => {
  const content = clone();
  content.prerequisites = '';                                    // fail 1건
  content.steps[1].instructions = '증거를 지목하지 않은 안내';   // warn 1건
  const res = await saveAndFreeze('pedagogy-fail', content, 'm2026.09.18-2');
  assert.equal(res.status, 422, `기존 400/403/409 와 겹치지 않는 코드: ${JSON.stringify(res.json)}`);
  assert.equal(res.json.reason, 'pedagogy_blocked', '기계가 읽을 수 있는 이유');
  const kinds = res.json.findings.map(f => f.check);
  assert.ok(kinds.includes('lesson_prerequisites'), '막은 항목이 있다');
  assert.ok(kinds.includes('step_evidence'), '막지 않은 warn 도 함께 보낸다 — 강사가 한 번에 고치도록');
  assert.ok(kinds.includes('duration_consistency'), 'skip 도 함께 보낸다');
  assert.ok(res.json.findings.every(f => typeof f.remedy === 'string' && f.remedy.trim()),
    '차단 응답의 모든 항목이 다음 행동을 지목한다');
});

await check('라우트: 차단된 확정은 버전을 남기지 않는다', async () => {
  const row = db.prepare('SELECT count(*) n FROM authoring_versions WHERE course_id=?').get('pedagogy-fail');
  assert.equal(Number(row.n), 0, '422 뒤에 확정본이 저장돼 있으면 안 된다');
  const ok = db.prepare('SELECT count(*) n FROM authoring_versions WHERE course_id=?').get('pedagogy-warn');
  assert.equal(Number(ok.n), 1, '대조: warn 경로는 실제로 저장됐다');
});

await check('라우트: 형태 검증이 먼저다 — 완료 기준 공백은 422 가 아니라 400', async () => {
  // step_acceptance 가 freeze 경로에서 도달 불가라는 주장의 실측 근거.
  const content = clone();
  content.steps[0].acceptance = '';
  const res = await saveAndFreeze('pedagogy-shape', content, 'm2026.09.18-3');
  assert.equal(res.status, 400, `session-design 검증기가 먼저 거른다: ${JSON.stringify(res.json)}`);
  assert.match(res.json.error, /acceptance is required to freeze a version/);
  assert.equal(res.json.reason, undefined, '관문까지 도달하지 않았다');
});

db.close();
console.log(`lesson-pedagogy: ${passed} checks passed — 실제 치과 5강 양성 대조 + 결함 주입 음성 대조 + 실 라우트 422/200.`);
