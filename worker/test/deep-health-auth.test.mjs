// `/v1/health/deep` 의 인증을 잠근다.
//
// 왜 이 파일이 지금 생기나: **이 경로에는 테스트가 하나도 없었다.** 그래서
// `x-cron-trigger: true` 라는 **요청 헤더만으로** 인증을 건너뛰는 분기가 아무도
// 모르게 살아 있었고, 2026-09-10 프로덕션에서 자격증명 없이 실제로 열렸다:
//
//   curl -H 'x-cron-trigger: true' https://api.hypeproof-ai.xyz/v1/health/deep
//   → 200 {"providers":{"openai":{"ok":true,...},"glm":...,"anthropic":{"via":"...fly.dev"}},...}
//
// 두 가지가 동시에 틀렸다:
//   1. 요청 헤더는 **요청자가 정한다.** 내부 출처의 증거가 될 수 없다. 그런데 소스
//      주석은 "set by the scheduled() entry point" 라고 단정하고 있었고, 그 단정 때문에
//      아무도 그쪽을 보지 않았다 (verification.md: 배너 문구가 원인을 단정하면 사람이
//      다른 곳을 안 본다 — 이 레포에 같은 실패 기록이 있다).
//   2. **그 헤더를 보내는 코드는 존재하지 않았다.** `scheduled()` 는 `runHeartbeat(env)`
//      를 평범한 함수로 부른다 — 이 라우트로 HTTP 요청을 하지 않는다. 레포 전체 grep
//      결과가 우회 분기 자신의 두 줄뿐이었다. 즉 **보호하는 호출자는 없고 노출만 있었다.**
//
// 유출된 것: 어떤 공급자에 키가 들어 있는지 · 각 공급자의 실시간 상태와 지연 ·
// KV/D1 상태 · Anthropic 프록시 호스트명. 그리고 공개보다 나쁜 것 — 호출 한 번이
// 워커로 하여금 **네 공급자에 실제 probe 요청**을 보내게 한다. 인증 없는 요청 하나가
// 유료 요청 네 개로 증폭됐다.
//
// Run: node --experimental-strip-types test/deep-health-auth.test.mjs

import './harness/loader.mjs';
import assert from 'node:assert/strict';
import { bootApp, createMockEnv, makeCtx } from './harness/index.mjs';

const ADMIN = 'test-admin-password';
const app = await bootApp();

/** 업스트림 probe 를 가로채서 **몇 번 나갔는지** 센다. 증폭이 이 파일의 관심사다. */
async function call(headers, opts = {}) {
  // **기본 매개변수를 쓰지 않는다.** `{ adminPassword = ADMIN } = {}` 로 썼다가 당했다:
  // 기본값은 `undefined` 에도 적용되므로 `call(h, { adminPassword: undefined })` 가
  // 비밀번호를 **설정된 상태로** 되돌려, §4(미설정 배포)가 엉뚱한 환경을 재고 있었다.
  // fail-open 변이가 그 때문에 살아남았다 — 계측기를 먼저 의심한다(규칙 6).
  const adminPassword = 'adminPassword' in opts ? opts.adminPassword : ADMIN;
  const env = createMockEnv({ adminPassword });
  if ('adminPassword' in opts && opts.adminPassword === undefined) {
    // 계측기 대조군 — 이 런이 정말 "비밀번호 없는 배포" 인지 직접 확인한다.
    assert.equal(env.HPS_ADMIN_PASSWORD, undefined, '미설정 배포를 만들려 했는데 비밀번호가 들어 있다');
  }
  const upstreamCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    upstreamCalls.push(String(url));
    return Response.json({ ok: true });
  };
  try {
    const ctx = makeCtx();
    const res = await app.fetch(new Request('https://x/v1/health/deep', { headers }), env, ctx);
    await ctx.settle?.();
    const text = await res.text();
    return { status: res.status, text, upstreamCalls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const basic = (pass) => ({ authorization: 'Basic ' + btoa(':' + pass) });

// ═══ 1. 올바른 자격증명은 통과한다 (양성 대조군) ═══════════════════════════════
// 이게 없으면 아래 401 단언들이 "이 경로가 아예 죽어 있다" 와 구별되지 않는다.
{
  const ok = await call(basic(ADMIN));
  // **200 이 아니라 "인증을 통과했다" 를 잰다.** 처음 이 단언을 200 으로 썼고 틀렸다 —
  // 하네스의 D1 스텁이 `unexpected D1 result` 를 돌려주므로 종합 판정이 false 가 되어
  // 핸들러가 503 을 준다. 그건 제품이 아니라 계측기의 상태다. 이 파일의 관심사는
  // **인증**이므로, 통과의 증거는 상태 코드가 아니라 **보고서가 실제로 생성됐다**는 것이다.
  // (verification.md 규칙 1: 판정 기준을 세우기 전에 대상을 열어본다 — 안 열어봤다.)
  assert.notEqual(ok.status, 401, `관리자 자격증명이 거부됐다: ${ok.text}`);
  assert.ok([200, 503].includes(ok.status), `예상 밖 상태: ${ok.status} ${ok.text}`);
  const body = JSON.parse(ok.text);
  assert.ok(body.providers, '통과했는데 공급자 상태가 없다 — 엉뚱한 응답을 보고 있다');
  assert.ok(body.kv && body.d1, '통과했는데 KV/D1 상태가 없다');
  // 증폭의 근거 — 인증된 호출 **한 번**이 업스트림 probe 를 여럿 만든다. 이 수가
  // 0이면 아래 "인증 없는 호출은 업스트림을 부르지 않는다" 단언이 공짜로 통과한다.
  assert.ok(
    ok.upstreamCalls.length >= 1,
    `deep health 가 업스트림을 부르지 않는다 — 증폭 단언의 전제가 사라졌다 (${ok.upstreamCalls.length})`,
  );
}

// ═══ 2. 우회 헤더가 돌아오지 않는다 ═══════════════════════════════════════════
// 이 절이 이 파일의 존재 이유다. 어떤 형태로든 **요청 헤더만으로** 통과해서는 안 된다.
{
  const FORGED = [
    { 'x-cron-trigger': 'true' },                       // 실제로 프로덕션을 열었던 그 헤더
    { 'X-Cron-Trigger': 'true' },                       // 헤더 이름은 대소문자 구분이 없다
    { 'x-cron-trigger': 'TRUE' },
    { 'x-cron-trigger': '1' },
    { 'cf-cron': 'true' },
    { 'x-internal': 'true' },
    { 'x-forwarded-for': '127.0.0.1' },                 // 출처를 흉내내는 다른 고전
    { 'user-agent': 'Cloudflare-Workers-Cron' },
  ];
  for (const headers of FORGED) {
    const r = await call(headers);
    const name = Object.keys(headers)[0];
    assert.equal(r.status, 401, `${name} 만으로 통과했다: ${r.text}`);
    // **그리고 업스트림을 부르지 않았다.** 401 을 돌려주면서 probe 를 쏘면 증폭은
    // 그대로 남는다 — 거절이 조기에 일어났는지를 호출 수로 직접 확인한다.
    assert.equal(
      r.upstreamCalls.length, 0,
      `${name}: 거절하면서 업스트림 probe 를 ${r.upstreamCalls.length}회 보냈다 — 증폭이 남아 있다`,
    );
    // 거절 응답이 내용을 흘리지 않는다.
    assert.doesNotMatch(r.text, /openai|anthropic|glm|gemini|latency|fly\.dev/i, `${name}: 거절 응답이 공급자 정보를 흘린다`);
  }
}

// ═══ 3. 자격증명이 틀리거나 깨졌으면 401 ══════════════════════════════════════
{
  const BAD = [
    [{}, '헤더 없음'],
    [{ authorization: '' }, '빈 authorization'],
    [basic('wrong-password'), '틀린 비밀번호'],
    [basic(''), '빈 비밀번호'],
    [{ authorization: 'Basic' }, 'Basic 만'],
    [{ authorization: 'Basic ' }, 'Basic 공백'],
    [{ authorization: 'Bearer ' + ADMIN }, '맞는 비밀번호를 Bearer 로'],
    [{ authorization: 'Basic !!!not-base64!!!' }, '깨진 base64'],
    [{ authorization: 'Basic ' + btoa('admin') }, '콜론 없는 자격증명'],
  ];
  for (const [headers, why] of BAD) {
    const r = await call(headers);
    assert.equal(r.status, 401, `${why}: 401 이 아니다 (${r.status}) ${r.text}`);
    assert.equal(r.upstreamCalls.length, 0, `${why}: 거절하면서 업스트림을 불렀다`);
    // 거절 응답 본문도 아무것도 흘리지 않는다. §2 의 위조 헤더 경로는 `authorization`
    // 자체가 없어서 더 이른 분기에서 끝나므로, **비밀번호 불일치 경로**는 여기서만
    // 덮인다 — 그 구멍으로 "401 에 공급자 목록을 덧붙이는" 변이가 살아남았다.
    assert.doesNotMatch(
      r.text, /openai|anthropic|glm|gemini|latency|fly\.dev|providers/i,
      `${why}: 거절 응답이 공급자 정보를 흘린다: ${r.text}`,
    );
    // 그리고 실패 사유를 구분해 주지 않는다 — "비밀번호가 틀렸다" 와 "헤더가 없다" 를
    // 다르게 답하면 추측 공격에 단서를 준다.
    assert.equal(JSON.parse(r.text).error, 'auth required', `${why}: 거절 문구가 사유를 구분한다`);
  }
  // 깨진 base64 가 500 이 되지 않는다 — `atob` 는 던진다. 위에서 401 을 확인했으므로
  // 이 단언은 그 경로가 예외로 새지 않음을 못박는다.
  const broken = await call({ authorization: 'Basic !!!not-base64!!!' });
  assert.notEqual(broken.status, 500, 'base64 오류가 500 으로 샜다');
}

// ═══ 4. 비밀번호가 설정되지 않은 배포는 열리지 않는다 ═════════════════════════
// fail-open 이 가장 비싼 실수다 — 설정을 빠뜨린 배포가 전부 공개되면 안 된다.
{
  for (const headers of [{}, basic('anything'), { 'x-cron-trigger': 'true' }]) {
    const r = await call(headers, { adminPassword: undefined });
    assert.notEqual(r.status, 200, `비밀번호 미설정 배포가 200 을 돌려줬다: ${r.text}`);
    assert.ok([401, 503].includes(r.status), `미설정 배포의 상태가 예상 밖이다: ${r.status}`);
    assert.equal(r.upstreamCalls.length, 0, '미설정 배포가 업스트림을 불렀다');
  }
}

// ═══ 5. 소스 락 — 헤더 기반 우회가 어떤 형태로도 돌아오지 않는다 ═══════════════
// 위 행동 단언은 "지금 그 헤더" 만 막는다. 다음 사람이 다른 이름으로 같은 패턴을
// 되살리는 것은 막지 못하므로, 핸들러 슬라이스를 직접 본다.
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/routes/chat.ts', import.meta.url), 'utf8');
  const at = src.indexOf('chat.get("/health/deep"');
  assert.ok(at > 0, '핸들러를 못 찾았다 — 이 단언의 기준점이 사라졌다');
  const end = src.indexOf('\nchat.', at + 10);
  assert.ok(end > at, '핸들러의 끝을 못 찾았다');
  const handler = src.slice(at, end);
  // 추출 앵커 — 슬라이스가 실제로 이 핸들러다.
  assert.match(handler, /runDeepHealth/, '핸들러 슬라이스 추출이 틀렸다');
  assert.match(handler, /HPS_ADMIN_PASSWORD/, '핸들러가 관리자 비밀번호를 보지 않는다');

  assert.doesNotMatch(handler, /x-cron-trigger/i, '우회 헤더가 핸들러로 돌아왔다');
  assert.doesNotMatch(handler, /cronFlag/, '우회 플래그가 핸들러로 돌아왔다');
  // 일반화: 헤더 값을 **자격증명 대신** 쓰는 모양을 막는다. `authorization` 은 예외다.
  const headerReads = [...handler.matchAll(/c\.req\.header\(\s*["']([^"']+)["']/g)].map((m) => m[1].toLowerCase());
  assert.deepEqual(
    headerReads.filter((h) => h !== 'authorization'),
    [],
    `핸들러가 authorization 외의 헤더를 읽는다: ${headerReads.join(',')} — 요청 헤더는 출처의 증거가 아니다`,
  );
  // 탐침 양성 대조군 — 같은 정규식이 실제로 헤더 읽기를 찾아낸다. 못 찾으면 위
  // 빈 배열이 "정규식이 고장났다" 와 구별되지 않는다.
  const probeHits = [...'c.req.header("x-hps-turn-id")'.matchAll(/c\.req\.header\(\s*["']([^"']+)["']/g)];
  assert.equal(probeHits.length, 1, '헤더 읽기 탐침이 고장났다');
  assert.ok(headerReads.includes('authorization'), '핸들러가 authorization 을 읽는 것은 확인돼야 한다');

  // 그리고 `scheduled()` 는 여전히 HTTP 를 쓰지 않는다 — 우회를 지운 근거가 유지되는지.
  // 만약 누군가 cron 을 HTTP 호출로 바꾸면 이 단언이 터지고, 그때 인증을 같이 설계해야 한다.
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const schedAt = index.indexOf('async scheduled(');
  assert.ok(schedAt > 0, 'scheduled() 를 못 찾았다');
  const sched = index.slice(schedAt);
  assert.match(sched, /runHeartbeat\(env\)/, 'scheduled() 가 하트비트를 직접 부르지 않는다');
  assert.doesNotMatch(sched, /health\/deep/, 'scheduled() 가 deep health 를 HTTP 로 부른다 — 인증 설계를 다시 해야 한다');
  assert.doesNotMatch(sched, /app\.fetch|new Request/, 'scheduled() 가 자기 자신에게 HTTP 요청을 한다');
}

console.log('deep-health-auth: 관리자 Basic 만 통과 · 헤더 우회 없음 · 거절은 업스트림을 부르지 않는다 — OK');
