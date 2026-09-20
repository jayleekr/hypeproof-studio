// #1185 — 숨긴 것과 막은 것은 다르다: 저작 API 역할 집행을 서버에서 전수 고정한다.
//
// 왜 있나 (2026-09-21 A안 스코프 재정의): Studio 한 앱 안에 강사 면(Chalk)과 학생 면이
// 공존하게 된다. 화면을 `role` 로 가리는 것(#1184)은 **화면을 숨기는 것**이고, 이 파일은
// **서버가 막는지**를 묻는다. URL 을 아는 사람이 학생 토큰으로 직접 불렀을 때 무엇이
// 돌아오는가. ARC-01 — 권한 판정은 Service 가 소유한다.
//
// ── 이 시험은 경로를 손으로 등록하지 않는다 ────────────────────────────────────
// 경로 목록을 `admin.routes`(Hono 라우터가 실제로 들고 있는 등록부)에서 읽는다. 그래서
// **새 admin 경로를 추가하면 다음 실행부터 자동으로 이 시험에 들어온다.** 이 저장소에는
// 반대 모양의 함정이 이미 있다 — `test/harness/dental-authoring.mjs` 의 마이그레이션
// 목록은 손으로 등록해야 하고, 빠뜨리면 시험이 옛 스키마로 돌면서 **통과한다**.
//
// 자동 편입에 남는 구멍은 하나뿐이고, 그것도 실패로 드러난다: 새 경로가 이 파일이 모르는
// 이름의 path param 을 쓰면 구체 URL 을 만들 수 없다 → §2 가 이름을 찍고 실패한다.
// 그때 PARAM 에 값을 추가하는 것이 등록의 전부다.
//
// Run: node --experimental-strip-types --experimental-sqlite test/authoring-role-enforcement.test.mjs

import assert from 'node:assert/strict';
import './harness/loader.mjs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './harness/index.mjs';

const { admin } = await import('../src/routes/admin.ts');
const { authoring, authenticate } = await import('../src/routes/authoring.ts');
const { isIssuerAllowedEndpoint } = await import('../src/lib/instructor-auth.ts');
const { issue, issueIssuer } = await import('../src/lib/tokens.ts');
const { listProfiles } = await import('../src/profiles/index.ts');

const COHORT = 'boah-dental-2026-a';
const PROFILE = listProfiles().find(p => p.session.cohort_id === COHORT)?.id;
assert.ok(PROFILE, '시료 코호트의 프로필을 못 찾았다 — 프로필 레지스트리가 바뀌었다');

// 구체 URL 을 만들기 위한 path param 값. 값 자체는 판정에 영향이 없어야 한다(인증이 먼저다).
// 그래도 **실재하는** 코호트/프로필을 쓴다 — 없는 값이면 404 가 먼저 나와서 "거부됐다"와
// "그런 게 없다"가 구분되지 않는다.
const PARAM = {
  cohort: COHORT, id: COHORT, course: 'site-1', profile: PROFILE,
  version: 'm2026.09.06-1', user: 'kid01', jti: 'jti-1', account: 'acct-1',
};
// 본문 검증이 인증보다 먼저 도는 경로가 있다(admin.ts /tokens/issue, /session, /session/open).
// 빈 본문을 보내면 400 이 먼저 나와 역할 판정에 **도달하지 못한 채** 통과처럼 보인다.
// 유효한 본문을 보내 판정까지 밀어 넣는다.
const BODY = {
  '/tokens/issue': () => ({ u: 'kid01', c: COHORT, p: PROFILE, hours: 4 }),
  '/cohorts/:id/session': () => ({ profile_id: PROFILE, starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 36e5).toISOString() }),
  '/cohorts/:id/session/open': () => ({ profile_id: PROFILE, user: 'kid01', token_hours: 2, session_hours: 2 }),
  '/cohorts/:id/roster/append': () => ({ users: ['kid01'] }),
};

function concretePath(pattern) {
  const unknown = [];
  const out = pattern.split('/').map(seg => {
    if (!seg.startsWith(':')) return seg === '*' ? 'x' : seg;
    const name = seg.slice(1);
    if (!(name in PARAM)) { unknown.push(name); return 'x'; }
    return PARAM[name];
  }).join('/');
  return { path: '/admin' + out, unknown };
}

const app = await bootApp();
// HPS_ADMIN_PASSWORD 가 있어야 Bearer 예외에 걸리지 않는 경로가 503 이 아니라 401 로 닫힌다.
// HPS_ACCESS_CONTRACTS 를 켜지 않으면 예산/접근 경로가 **역할 판정 전에** 503 을 낸다 —
// 그러면 "막혔다"가 아니라 "구성이 없다"를 본 것이고, 이 시험은 아무것도 재지 못한다.
const env = createMockEnv({ adminPassword: 'dev-pw', env: { HPS_ACCESS_CONTRACTS: 'enabled' } });

const OTHER_SECRET = 'forged-secret-0123456789abcdef';
const scope = [{ cohort: COHORT, profiles: [PROFILE], can_start_session: true, max_session_hours: 4, max_hours: 8 }];
const credential = {
  none:        null,
  student:     (await issue({ u: 'kid01', c: COHORT, p: PROFILE }, 4, TEST_SECRET)).token,
  garbage:     'not-a-token',
  forged:      (await issueIssuer({ issuer: 'attacker', scopes: scope }, 4, OTHER_SECRET)).token,
  expired:     (await issueIssuer({ issuer: 'teacher', scopes: scope }, -1, TEST_SECRET)).token,
  otherCohort: (await issueIssuer({ issuer: 'outsider', scopes: [{ cohort: 'some-other-cohort', profiles: [PROFILE] }] }, 4, TEST_SECRET)).token,
  // 양성 대조군. 이 자격이 거부되면 계측기가 **너무 엄격한** 것이고, 그러면 위의 거부들도
  // 아무것도 증명하지 않는다 (.claude/rules/verification.md 규칙 2).
  instructor:  (await issueIssuer({ issuer: 'teacher', scopes: scope }, 4, TEST_SECRET)).token,
};
// 위조 토큰이 **모양은 멀쩡한데 서명만 다른** 것인지 확인한다. 모양부터 깨져 있으면
// 'garbage' 와 같은 것을 두 번 재는 셈이다.
assert.equal(credential.forged.split('.').length, 2, '위조 시료가 토큰 모양이 아니다');
assert.notEqual(credential.forged, credential.instructor);

async function call(method, path, cred) {
  const headers = { 'content-type': 'application/json' };
  if (cred) headers.authorization = `Bearer ${cred}`;
  const body = ['GET', 'DELETE'].includes(method) ? undefined : JSON.stringify({});
  const res = await app.fetch(new Request('https://service.test' + path, { method, headers, body }), env, makeCtx());
  const raw = await res.text();
  let json; try { json = JSON.parse(raw); } catch { /* HTML/text bodies (admin Basic) */ }
  return { status: res.status, json, raw };
}
async function callRoute(route, cred) {
  const { path } = concretePath(route.path);
  const make = BODY[route.path];
  const headers = { 'content-type': 'application/json' };
  if (cred) headers.authorization = `Bearer ${cred}`;
  const body = ['GET', 'DELETE'].includes(route.method) ? undefined : JSON.stringify(make ? make() : {});
  const res = await app.fetch(new Request('https://service.test' + path, { method: route.method, headers, body }), env, makeCtx());
  const raw = await res.text();
  let json; try { json = JSON.parse(raw); } catch {}
  return { status: res.status, json, raw };
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

// ─── §0 계측기부터 ─────────────────────────────────────────────────────────────
// 본 단언은 전부 "전수 호출했더니 전부 거부됐다" 형태다. 경로를 하나도 못 세는 고장이면
// 공짜로 통과한다. 세는 쪽과 판정하는 쪽이 실제로 갈리는지 먼저 증명한다.
await check('§0 계측기 — 경로를 세고 구체 URL 을 만든다', async () => {
  assert.ok(admin.routes.length >= 60, `admin 라우터 등록부가 너무 작다(${admin.routes.length}) — 세는 쪽이 죽었다`);
  assert.equal(concretePath('/cohorts/:cohort/authoring/:course').path, `/admin/cohorts/${COHORT}/authoring/site-1`);
  // 모르는 param 은 조용히 넘어가지 않고 이름이 찍혀 나온다.
  assert.deepEqual(concretePath('/cohorts/:cohort/thing/:brandNew').unknown, ['brandNew']);
});

await check('§0 계측기 — 양성 대조군: 정상 강사 자격은 거부되지 않는다', async () => {
  const r = await call('GET', `/admin/cohorts/${COHORT}/authoring/site-1`, credential.instructor);
  // D1 목이 빈 값을 주므로 404(course not found)가 정상 — 인증을 **통과했다**는 뜻이다.
  assert.equal(r.status, 404, `강사 자격이 인증 단계에서 막혔다: ${r.raw}`);
  assert.equal(r.json?.error, 'course not found');
});

await check('§0 계측기 — 음성 대조군: 학생 자격은 같은 경로에서 막힌다', async () => {
  const r = await call('GET', `/admin/cohorts/${COHORT}/authoring/site-1`, credential.student);
  assert.equal(r.status, 403, `학생 자격이 막히지 않았다: ${r.status} ${r.raw}`);
});

// ─── §1 구조 — 저작 라우터의 모든 핸들러가 authenticate 를 거친다 ───────────────
// authoring.ts 는 `for (const path of [...]) authoring.use(path, authenticate)` 로 미들웨어를
// **손으로 나열**한다. Hono 의 use(path) 는 하위 경로로 내려가지 않으므로, 새 경로를
// 추가하면서 그 목록에 넣지 않으면 그 경로만 인증 없이 열린다. 여기서 그것을 잡는다.
await check('§1 저작 라우터의 모든 핸들러 경로에 authenticate 가 걸려 있다', async () => {
  const guarded = new Set(admin.routes.filter(r => r.method === 'ALL' && r.handler === authenticate).map(r => r.path));
  // 등록을 **하나도** 못 찾으면 동일성 비교 자체가 깨진 것이다(번들러가 함수를 감쌌다거나).
  // 그 경우 아래 naked 목록이 전부 빨개져서 원인을 오해하게 되므로 먼저 가른다.
  assert.ok(guarded.size > 0, 'authenticate 등록을 하나도 못 찾았다 — 함수 동일성 비교가 깨졌다');
  const handlers = authoring.routes.filter(r => r.method !== 'ALL');
  assert.ok(handlers.length >= 7, `저작 핸들러가 너무 적다(${handlers.length})`);
  const naked = handlers.filter(r => !guarded.has(r.path)).map(r => `${r.method} ${r.path}`);
  assert.deepEqual(naked, [],
    `authenticate 미들웨어 없이 등록된 저작 경로: ${naked.join(', ')}\n` +
    `  → authoring.ts 의 authenticate 등록 목록에 이 경로를 추가해라. Hono 의 use(path) 는\n` +
    `  하위 경로를 덮지 않으므로, 빠진 경로는 인증 없이 열린다.`);
  console.log(`  저작 핸들러 ${handlers.length}개 전부 authenticate 아래 — OK`);
});

// ─── §1b 반대 방향 — 강사가 자기 경로에 닿는가 ────────────────────────────────
// §1 은 "학생이 못 들어오는가" 만 본다. 집행은 **양방향**이다: `authenticate` 아래 등록했는데
// `isIssuerAllowedEndpoint` 에 올리지 않으면, admin 미들웨어가 Bearer 를 통과시키지 않아
// **강사 본인도 못 들어온다**(운영자 비번이 있으면 401, 없으면 503 `admin not configured`).
// 목록이 둘이고 손으로 맞춰야 하므로 반드시 벌어진다.
//
// 2026-09-21 실제로 옆 브랜치에서 그 모양이 나왔다(#1187 의 `…/rehearsal-tickets`). 그때
// 이 파일의 §1~§4 는 **전부 초록이었다** — 표에 401 이 찍혀 있는데도 아무것도 단언하지
// 않았기 때문이다. 거부만 세는 시험은 거부밖에 못 본다. 그래서 양성 대조군을 한 경로가
// 아니라 **저작 표면 전수**로 돌린다.
await check('§1b 정상 강사 자격이 저작 경로 전수에 닿는다 (허용 목록 누락 탐지)', async () => {
  const unreachable = [];
  for (const route of authoring.routes.filter(r => r.method !== 'ALL')) {
    const r = await callRoute(route, credential.instructor);
    // 401/503 은 **인증 단계에서 막힌** 것이다. 400/404/409/200 은 판정을 통과한 뒤의 응답이라
    // 이 시험의 관심사가 아니다(내용 판정은 authoring.test.mjs 의 몫).
    if (r.status === 401 || r.status === 503) unreachable.push(`${route.method} ${route.path}: ${r.status} ${r.raw.slice(0, 120)}`);
  }
  assert.deepEqual(unreachable, [],
    `정상 강사 자격으로도 닿지 않는 저작 경로:\n  ${unreachable.join('\n  ')}\n` +
    `  → lib/instructor-auth.ts 의 isIssuerAllowedEndpoint 에 이 경로를 추가해라. authenticate 에만\n` +
    `  등록하면 admin 미들웨어가 Bearer 를 통과시키지 않아 강사 본인이 막힌다 (#1187 이 그 모양이었다).`);
  console.log(`  저작 핸들러 ${authoring.routes.filter(r => r.method !== 'ALL').length}개 전부 강사에게 도달 가능 — OK`);
});

// ─── §2 전수 — Bearer 로 들어올 수 있는 모든 admin 경로에서 학생/위조/만료/타코호트 거부 ──
// 관문은 두 겹이다. admin.ts 의 use("*") 는 isIssuerAllowedEndpoint 가 허용한 경로에 한해
// **Bearer 가 있다는 사실만 보고** 통과시킨다 — 토큰을 검증하지 않는다. 진짜 판정은 각
// 핸들러 안에 있다. 그래서 "허용 목록에 올렸는데 핸들러가 검증을 안 하는" 경로가 곧 구멍이다.
const handlerRoutes = admin.routes.filter(r => r.method !== 'ALL');
const census = [];
await check('§2 전수 호출 — 거부되지 않은 경로가 없다', async () => {
  const unknownParams = new Set();
  const holes = [];
  for (const route of handlerRoutes) {
    const { path, unknown } = concretePath(route.path);
    unknown.forEach(u => unknownParams.add(`${route.method} ${route.path} → :${u}`));
    const admitted = isIssuerAllowedEndpoint(path, route.method);
    const row = { method: route.method, path: route.path, admitted, results: {} };
    for (const name of ['none', 'student', 'garbage', 'forged', 'expired', 'otherCohort']) {
      const r = await callRoute(route, credential[name]);
      row.results[name] = r.status;
      if (r.status < 400) holes.push(`${route.method} ${route.path} ← ${name}: ${r.status} ${r.raw.slice(0, 120)}`);
      // 2xx 가 아니어도 400(본문 오류)은 판정에 **도달하지 못한** 것이다. 통과로 읽지 않는다.
      if (admitted && r.status === 400) holes.push(`${route.method} ${route.path} ← ${name}: 400 — 인증 전에 본문 검증이 끝났다. 역할 판정에 도달하지 못했다: ${r.raw.slice(0, 120)}`);
    }
    census.push(row);
  }
  assert.deepEqual([...unknownParams], [],
    `구체 URL 을 만들 수 없는 path param 이 있다 — 이 시험이 그 경로를 재지 못한다:\n  ${[...unknownParams].join('\n  ')}\n` +
    `  → 이 파일의 PARAM 에 값을 추가해라.`);
  assert.deepEqual(holes, [], `역할 집행이 닿지 않은 경로:\n  ${holes.join('\n  ')}`);
});

// ─── §3 응답 모양이 일관된다 ───────────────────────────────────────────────────
// 상태 코드가 자격 종류별로 갈려야 한다. 전부 403 이면 "만료"와 "학생"이 구분되지 않고,
// 전부 401 이면 강사가 자기 권한 범위를 알 수 없다.
await check('§3 거부 응답의 상태 코드가 자격 종류별로 일관된다', async () => {
  const admitted = census.filter(r => r.admitted);
  assert.ok(admitted.length >= 20, `Bearer 로 들어올 수 있는 경로를 너무 적게 셌다(${admitted.length})`);
  const shape = {
    none: s => s === 401,                 // Bearer 없음 → admin Basic 관문
    student: s => s === 403,              // 서명은 유효, 역할이 아님
    garbage: s => s === 401,              // 토큰 모양 아님
    forged: s => s === 401,               // 서명 불일치
    expired: s => s === 401,              // 만료
    otherCohort: s => s === 403,          // 유효한 강사, 스코프 밖
  };
  const odd = [];
  for (const row of admitted)
    for (const [name, ok] of Object.entries(shape))
      if (!ok(row.results[name])) odd.push(`${row.method} ${row.path} ← ${name}: ${row.results[name]}`);
  assert.deepEqual(odd, [], `거부 응답 모양이 다른 경로:\n  ${odd.join('\n  ')}`);
  console.log(`  Bearer 허용 경로 ${admitted.length}개 × 자격 6종 = ${admitted.length * 6}회 호출, 전부 401/403 — OK`);
});

// ─── §4 저작 경로는 cf-access 헤더에 기대지 않는다 ────────────────────────────
// admin.ts 의 use("*") 는 `cf-access-authenticated-user-email` 이 **있기만 하면** 통과시킨다
// (JWT 검증도, 이메일 허용 목록도 없다). 프로덕션에서 안전한 이유는 코드가 아니라 엣지다 —
// Cloudflare 가 클라이언트가 보낸 cf-access-* 를 벗긴다. docs/plan/HANDOFF.md §3 이 그것을
// api.hypeproof-ai.xyz 에 실제로 찔러 401 을 받아 확인해 뒀고, Chalk 호스트는 미확인으로
// 남겨 뒀다. 저작 경로는 그 엣지 동작에 **기대지 않는다**: authenticate 가 강사 신원을
// 다시 확인하므로 헤더만으로는 열리지 않는다. 기대게 되는 변경을 여기서 막는다.
await check('§4 위조 cf-access 헤더만으로는 저작 경로가 열리지 않는다', async () => {
  const spoofed = { 'cf-access-authenticated-user-email': 'attacker@example.com' };
  const opened = [];
  for (const route of authoring.routes.filter(r => r.method !== 'ALL')) {
    const { path } = concretePath(route.path);
    const headers = { 'content-type': 'application/json', ...spoofed };
    const body = ['GET', 'DELETE'].includes(route.method) ? undefined : JSON.stringify({});
    const res = await app.fetch(new Request('https://service.test' + path, { method: route.method, headers, body }), env, makeCtx());
    if (res.status !== 401) opened.push(`${route.method} ${route.path}: ${res.status} ${(await res.text()).slice(0, 120)}`);
  }
  assert.deepEqual(opened, [],
    `cf-access 헤더만으로 강사 신원 확인을 건너뛴 저작 경로:\n  ${opened.join('\n  ')}\n` +
    `  → 저작은 엣지가 헤더를 벗긴다는 가정 위에 서면 안 된다. authenticate 를 통과시켜라.`);
  console.log(`  저작 핸들러 ${authoring.routes.filter(r => r.method !== 'ALL').length}개 전부 401 — 엣지에 기대지 않는다`);
});

// ─── §5 전수 표 ────────────────────────────────────────────────────────────────
console.log('\n저작·강사 API 경로 전수 표 (BEARER = admin use("*") 가 Bearer 만 보고 통과시키는 경로)');
console.log('  판정: none/garbage/forged/expired = 401, student/otherCohort = 403');
for (const r of census)
  console.log(`  ${r.admitted ? 'BEARER' : '  --  '} ${r.method.padEnd(6)} ${r.path.padEnd(58)} ${['none','student','garbage','forged','expired','otherCohort'].map(k => r.results[k]).join(' ')}`);

console.log(`\nauthoring-role-enforcement: ${passed} checks passed, ${handlerRoutes.length} admin routes enumerated from the live router`);
