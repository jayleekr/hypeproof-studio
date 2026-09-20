// 교환권 → 학생 조건 좌석, 그리고 그 좌석이 **실제로 수업에 들어간다** (#1189 C-2).
//
// 이 파일이 잠그는 계약은 둘이고 **방향이 반대**다. 한쪽만 재면 나머지가 죽어도 초록이다 —
// `#1185` §1b 에서 정확히 그 일을 겪었다(전수 표에 401 이 보이는데 아무것도 단언하지 않아
// 통과했다). **막힘만 세는 시험은 막힘밖에 못 본다.**
//
//   막힘 — 학생은 이 갈래로 로스터를 우회하지 못한다
//   통함 — 리허설 좌석은 **로스터도 열린 세션도 없이** 들어간다 (`RUN-01`)
//
// `RUN-01` 본문: *"리허설은 수업을 열기 전에 하는 일이므로 **열린 세션을 요구하지 않는다**"*.
// `#1131`: 강사를 운영 로스터에 넣는 것은 데이터 오염. 그래서 통함 쪽이 **요구사항**이지
// 편의가 아니다.
//
// Run: node --experimental-strip-types --experimental-sqlite test/rehearsal-redeem.test.mjs

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, withMockUpstream, openAIJsonBody } from './harness/index.mjs';

const { issueIssuer, issue } = await import('../src/lib/tokens.ts');
const { listProfiles } = await import('../src/profiles/index.ts');
const { ticketKey, encodeStoredTicket } = await import('../src/lib/rehearsal-ticket.ts');
const { REDEEM_IDEMPOTENCY_WINDOW_SECONDS } = await import('../src/routes/rehearsal.ts');

const app = await bootApp();
const cohort = 'boah-dental-2026-a';
const profileId = listProfiles().find(p => p.session.cohort_id === cohort)?.id;
assert.ok(profileId, '시료 코호트의 프로필을 못 찾았다');

// 실제 마이그레이션이 만든 스키마 위에서 실제 SQL 을 돌린다.
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
db.exec(readFileSync(new URL('../migrations/0002-chalk-authoring.sql', import.meta.url), 'utf8'));
// usage_log 등 본 스키마도 올린다. 없으면 사용량 기록이 waitUntil 안에서 조용히 실패하고
// 로그에 SQL 오류가 찍혀, 초록인 실행이 **고장난 것처럼 보인다**(리뷰어가 거기서 멈춘다).
try { db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); } catch (e) { console.log('schema.sql 적재 실패(무시):', e.message.slice(0, 80)); }

// ⚠️ 이 코호트에는 **열린 세션도 로스터도 심지 않는다.** 그것이 이 시험의 요점이다 —
// createMockEnv 의 기본 세션/로스터는 다른 코호트(sk-biopharm)에만 붙는다.
const env = createMockEnv();
env.HPS_DB = { prepare(sql) {
  let b = [];
  return {
    bind(...a) { b = a; return this; },
    async first() { return db.prepare(sql).get(...b) ?? null; },
    async run() { const r = db.prepare(sql).run(...b); return { success: true, meta: { changes: Number(r.changes) } }; },
    async all() { return { success: true, results: db.prepare(sql).all(...b) }; },
  };
}, async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; } };

const scope = [{ cohort, profiles: [profileId], max_hours: 24 }];
const instructor = (await issueIssuer({ issuer: 'teacher', scopes: scope }, 48, TEST_SECRET)).token;
const student = (await issue({ u: 'kid01', c: cohort, p: profileId }, 4, TEST_SECRET)).token;

const base = `/admin/cohorts/${cohort}/authoring/rehearse-course`;
const VERSION = 'm2026.09.21-1';
const content = {
  schema: 'hps-session-design/1', title: '리허설 입구', audience: '치과의사',
  duration_minutes: 120, objective: '리허설 좌석이 로스터 없이 들어간다',
  prerequisites: '코딩 경험 불필요. 예제 폴더 사본 제공', starter: '정적 홈페이지 예제',
  steps: [{ id: 'edit', title: '시간 변경', instructions: '진료시간을 변경하세요', hint: '', acceptance: '모바일에서 확인' }],
};

async function call(path, method = 'GET', body, cred) {
  const headers = { 'content-type': 'application/json' };
  if (cred) headers.authorization = `Bearer ${cred}`;
  const res = await app.fetch(new Request('https://service.test' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, makeCtx());
  const raw = await res.text();
  let json; try { json = JSON.parse(raw); } catch {}
  return { status: res.status, json, raw };
}
const chat = (cred) => withMockUpstream(
  () => new Response(JSON.stringify(openAIJsonBody({ content: '안녕하세요' })), { headers: { 'content-type': 'application/json' } }),
  () => call('/v1/chat/completions', 'POST', { model: 'gpt-test', messages: [{ role: 'user', content: '안녕' }] }, cred),
);

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

// ─── 준비: 초안 → 확정 → 교환권 (C-1 경로를 그대로 탄다) ────────────────────────
let ticket, seatId;
await check('준비 — 강사가 수업을 확정하고 교환권을 받는다', async () => {
  const saved = await call(base, 'PUT', { expected_revision: 0, request_id: 'create', profile_id: profileId, content }, instructor);
  assert.equal(saved.status, 200, saved.raw);
  const frozen = await call(`${base}/versions/${VERSION}`, 'PUT', { expected_revision: 1 }, instructor);
  assert.equal(frozen.status, 200, frozen.raw);
  const r = await call(`${base}/versions/${VERSION}/rehearsal-tickets`, 'POST', { hours: 4 }, instructor);
  assert.equal(r.status, 200, r.raw);
  ticket = r.json.ticket; seatId = r.json.seat;
  assert.match(ticket, /^[A-Za-z0-9_-]{16,256}$/, '교환권 모양이 앱의 제약과 다르다');
  assert.ok(seatId.startsWith('rehearsal-'), '좌석 id 에 사람이 읽는 표시가 없다');
});

// ─── 계측기 대조군 — 이 코호트에 정말 세션도 로스터도 없나 ─────────────────────
// 없어야 "리허설 좌석이 로스터 없이 들어갔다" 가 의미를 갖는다. 있으면 아래 통함 시험이
// 공짜로 통과한다.
await check('§0 대조군 — 이 코호트에는 열린 세션도 로스터도 없다', async () => {
  assert.equal(await env.HPS_KV.get(`cohort:${cohort}:active_session`), null, '세션이 심겨 있다 — 통함 시험이 무의미해진다');
  assert.equal(await env.HPS_KV.get(`cohort:${cohort}:roster`), null, '로스터가 심겨 있다 — 통함 시험이 무의미해진다');
});

// ─── 막힘 1 — 학생 좌석은 로스터가 없으면 여전히 못 들어간다 ───────────────────
// 게이트는 세션을 **로스터보다 먼저** 본다. 세션이 없으면 로스터까지 가지도 않는다 —
// 그래서 "로스터가 막는다" 를 재려면 세션이 있어야 한다. 처음에 이걸 모르고
// `not_in_roster` 를 기대했다가 `session_inactive` 를 받았다. 두 상태를 갈라서 잰다.
const liveSession = () => env.HPS_KV.put(`cohort:${cohort}:active_session`, JSON.stringify({
  session_id: 'sess-rehearsal-test', profile_id: profileId,
  starts_at: new Date(Date.now() - 60_000).toISOString(),
  ends_at: new Date(Date.now() + 3600_000).toISOString(),
}));

await check('T-1 막힘 — 학생 좌석은 세션이 없으면 session_inactive, 있어도 로스터 밖이면 not_in_roster', async () => {
  const noSession = await chat(student);
  assert.equal(noSession.status, 403, noSession.raw);
  assert.equal(noSession.json?.error?.type, 'session_inactive', noSession.raw);

  await liveSession();
  try {
    const noRoster = await chat(student);
    assert.equal(noRoster.status, 403, noRoster.raw);
    assert.equal(noRoster.json?.error?.type, 'not_in_roster', `로스터 검사가 학생을 막지 않는다: ${noRoster.raw}`);
  } finally { await env.HPS_KV.delete(`cohort:${cohort}:active_session`); }
});

// ─── 통함 2 — 이 파일의 존재 이유 ─────────────────────────────────────────────
let seatToken, seatLessonSha;
await check('T-2 통함 — 교환권이 좌석 자격으로 바뀐다', async () => {
  const r = await call('/v1/rehearsal/redeem', 'POST', { ticket });
  assert.equal(r.status, 200, r.raw);
  assert.ok(typeof r.json?.token === 'string' && r.json.token.length > 0, '앱이 읽는 필드는 token 이다');
  assert.equal(r.json.seat, seatId);
  seatToken = r.json.token;
  seatLessonSha = r.json.lesson.sha256;
});

await check('T-3 통함 — 리허설 좌석이 **로스터도 열린 세션도 없이** 수업에 들어간다', async () => {
  const r = await chat(seatToken);
  assert.equal(r.status, 200, `리허설 좌석이 막혔다 — RUN-01 이 깨졌다: ${r.raw}`);
});

// 🔴 채팅이 된다고 **진입도 된다고 짐작하지 않는다.** `/v1/profile` 은 일반 좌석에 대해
// `gateChatRequest` 를 돌리지 않고 **자체 로스터 검사**를 갖고 있다(`routes/chat.ts`).
// 그래서 게이트만 고치면 좌석이 채팅은 되는데 **첫 화면이 안 열린다.** 실제로 그랬다 —
// 로컬 worker 에 전 구간을 쳐 보고서야 드러났고, 시험이 채팅 한 표면만 재고 있었다.
// 참가자 자격이 지나가는 표면은 하나가 아니므로 **표면마다 따로 잰다.**
await check('T-3d 통함 — 리허설 좌석이 **진입(/v1/profile)** 에서도 로스터 없이 통과한다', async () => {
  const seat = await call('/v1/profile', 'GET', undefined, seatToken);
  assert.equal(seat.status, 200, `리허설 좌석이 진입에서 막혔다 — 첫 화면이 안 열린다: ${seat.raw}`);
  assert.equal(seat.json?.lesson?.version, VERSION, '진입이 고정된 수업을 돌려주지 않았다');
});

await check('T-3e 막힘 — 같은 표면에서 로스터 밖 **수업 좌석**은 여전히 403', async () => {
  // 음성 대조군. `lesson` 을 든 일반 학생 좌석은 로스터가 있어야 한다 — 위 통함이
  // "이 표면의 로스터 검사를 통째로 없앴다" 가 아님을 보인다.
  const lessonStudent = (await issue({ u: 'kid01', c: cohort, p: profileId,
    lesson: { course_id: 'rehearse-course', version: VERSION, sha256: seatLessonSha } }, 4, TEST_SECRET)).token;
  const r = await call('/v1/profile', 'GET', undefined, lessonStudent);
  assert.equal(r.status, 403, `로스터 밖 학생 좌석이 진입했다: ${r.raw}`);
  assert.equal(r.json?.error?.code, 'not_in_roster', r.raw);
});

// 리허설 좌석에는 `sessions` 행이 없다(수업을 연 적이 없으므로). 그래서 `usage_log` 의
// 첫 INSERT 는 FK 로 실패하고 **session_id=NULL 로 재시도해서 성공**한다 — 로그에 찍히는
// "FOREIGN KEY constraint failed" 한 줄은 그 재시도의 흔적이지 유실이 아니다.
// 짐작으로 넘기지 않고 **행이 실제로 남는지 세어서** 고정한다. 기록이 남는 것과 그것이
// 리허설 증거로 쓰이는 것은 다른 일이고, 후자는 `#1186` 의 몫이다.
await check('T-3c — 리허설 턴이 사용량 기록을 남긴다 (session 귀속은 NULL)', async () => {
  const rows = db.prepare('SELECT session_id FROM usage_log WHERE user_id=?').all(seatId);
  assert.ok(rows.length > 0, '리허설 턴이 usage_log 에 한 행도 남기지 않았다 — 증거 경로가 끊겨 있다');
  assert.ok(rows.every(r => r.session_id === null),
    `리허설 행이 세션에 귀속됐다 — sessions 행이 없는데 붙었다면 무언가 지어낸 것이다: ${JSON.stringify(rows)}`);
});

// 같은 좌석이 세션이 열린 뒤에도 그대로 돈다. 리허설을 "세션 없을 때만 되는 것" 으로
// 만들면 강사가 수업을 연 뒤 다시 확인하려다 막힌다.
await check('T-3b 통함 — 세션이 열려 있어도 리허설 좌석은 로스터 없이 들어간다', async () => {
  await liveSession();
  try {
    const r = await chat(seatToken);
    assert.equal(r.status, 200, `세션이 열리자 리허설 좌석이 막혔다: ${r.raw}`);
  } finally { await env.HPS_KV.delete(`cohort:${cohort}:active_session`); }
});

// ─── 막힘 3~9 ─────────────────────────────────────────────────────────────────
await check('T-4 막힘 — rehearsal 클레임을 손으로 붙인 토큰은 서명에서 죽는다', async () => {
  // 좌석 토큰의 payload 를 고쳐 서명을 그대로 붙인다(= 위조 시도).
  const [payload, sig] = seatToken.split('.');
  const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  const forgedPayload = Buffer.from(JSON.stringify({ ...decoded, u: 'kid01' }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await chat(`${forgedPayload}.${sig}`);
  assert.equal(r.status, 401, `위조 좌석이 통과했다: ${r.raw}`);
});

await check('T-5 막힘 — 학생 토큰으로는 교환권을 발급받지 못한다 (#1188 회귀)', async () => {
  const r = await call(`${base}/versions/${VERSION}/rehearsal-tickets`, 'POST', { hours: 4 }, student);
  assert.equal(r.status, 403, r.raw);
});

await check('T-6 막힘 — 리허설 좌석으로 저작 경로에 들어가지 못한다 (좌석은 학생 조건이다)', async () => {
  const r = await call(base, 'GET', undefined, seatToken);
  assert.equal(r.status, 403, `리허설 좌석이 저작 API 에 들어갔다: ${r.raw}`);
});

await check('T-7 막힘 — 없는 교환권과 모양이 틀린 교환권', async () => {
  const absent = await call('/v1/rehearsal/redeem', 'POST', { ticket: 'A'.repeat(22) });
  assert.equal(absent.status, 410, absent.raw);
  assert.equal(absent.json?.error, 'not_found', '없는 표를 만료라고 단정하지 않는다');
  const malformed = await call('/v1/rehearsal/redeem', 'POST', { ticket: 'short' });
  assert.equal(malformed.status, 400, malformed.raw);
});

await check('T-8 막힘 — 고정된 수업이 사라지면 좌석이 죽는다 (VER-02)', async () => {
  const row = db.prepare('SELECT module_json FROM authoring_versions WHERE version=?').get(VERSION);
  db.prepare('DELETE FROM authoring_versions WHERE version=?').run(VERSION);
  try {
    const r = await chat(seatToken);
    assert.equal(r.status, 409, `내용이 바뀌었는데 좌석이 살아 있다: ${r.raw}`);
    const redeemed = await call('/v1/rehearsal/redeem', 'POST', { ticket });
    assert.equal(redeemed.json?.error, 'content_changed', redeemed.raw);
  } finally {
    db.prepare('INSERT INTO authoring_versions (cohort_id,course_id,version,source_revision,module_json) VALUES (?,?,?,?,?)')
      .run(cohort, 'rehearse-course', VERSION, 1, row.module_json);
  }
});

await check('T-9 막힘 — cohort kill-switch 는 리허설 좌석도 멈춘다', async () => {
  await env.HPS_KV.put(`cohort:${cohort}:paused`, JSON.stringify({ ts: new Date().toISOString(), reason: 'test' }));
  try {
    const r = await chat(seatToken);
    assert.equal(r.status, 503, `일시정지된 수업에서 리허설이 돌았다: ${r.raw}`);
  } finally { await env.HPS_KV.delete(`cohort:${cohort}:paused`); }
});

// ─── 멱등과 일회성 — 둘은 다른 것이다 ────────────────────────────────────────
await check('T-10 멱등 — 응답이 유실된 재시도는 **같은** 좌석을 받는다 (새 자격이 아니다)', async () => {
  const again = await call('/v1/rehearsal/redeem', 'POST', { ticket });
  assert.equal(again.status, 200, again.raw);
  assert.equal(again.json.token, seatToken, '같은 교환권이 서로 다른 자격을 냈다 — ARC-03 위반');
});

await check('T-11 일회성 — 멱등 창이 지나면 두 번째 통과는 없다', async () => {
  const key = await ticketKey(ticket);
  const stored = JSON.parse(await env.HPS_KV.get(key));
  const stale = Math.floor(Date.now() / 1000) - REDEEM_IDEMPOTENCY_WINDOW_SECONDS - 1;
  await env.HPS_KV.put(key, JSON.stringify({ ...stored, used_at: stale }));
  const r = await call('/v1/rehearsal/redeem', 'POST', { ticket });
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.json?.error, 'already_used', '앱이 already_used 를 정상 결과로 읽는다');
});

console.log(`\nrehearsal-redeem: ${passed} checks passed — 막힘 ${8}종 · 통함 ${2}종 (양방향)`);
console.log(`  통함이 빠지면 게이트가 죽어도 초록이다 — #1185 §1b 에서 겪은 그 구멍이다`);
