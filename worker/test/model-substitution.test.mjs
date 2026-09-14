// 요청한 모델을 지키지 못했을 때 **그걸 말하는지**.
//
// Codex 의 #897 H-05 부분 관측: "요청/응답 모델 불일치 시 기본 채팅 표시가 같음."
// 원인은 `lib/translate.ts` 의 `resolveAlias` 다 —
//
//   permittedModelKeys(profile).find(key => key === requested) ?? profile.model.default
//
// 코호트가 허용하지 않은 요청은 **조용히 프로필 기본값으로 바뀐다.** 정책 집행 자체는
// 맞다(클라이언트가 수업 모델을 벗어나면 안 된다). 틀린 것은 **그게 선에 흔적을 안
// 남긴다**는 것이다: alias→모델 id 번역에서도 요청 문자열과 응답 모델이 다르므로,
// 클라이언트가 `x-hps-model` 만 보고는 "정상 번역" 과 "요청 무시" 를 구별할 수 없다.
//
// 같은 레포에 이미 답이 있다: `x-hps-module-fallback`(REQ-B8 ④) — 저하를 막는 대신
// **보이게** 한다. 여기서도 서빙 모델은 바꾸지 않고 판정만 싣는다.
//
// 이 파일에서 **두 관문을 분리해서** 잰다:
//   ① 치환이 일어났는가 (순수 판정)
//   ② 그게 응답 헤더로 나오는가 (스트리밍·비스트리밍 양쪽)
//
// 비교 좌석(`studio-model-practice`)은 이미 400 `model_not_allowed` 로 거부한다 —
// 그 비대칭이 의도된 것임을 여기서 잠근다. 일반 좌석에서 400 으로 바꾸면 오타 하나가
// 아이 화면에서 턴 실패가 된다.
//
// Run: node --experimental-strip-types test/model-substitution.test.mjs

import './harness/loader.mjs';
import assert from 'node:assert/strict';
import {
  bootApp, createMockEnv, makeCtx, withMockUpstream, openAIJsonBody, openAIStreamBody,
  sseResponse, TEST_SECRET, COHORT, PROFILE, USER,
} from './harness/index.mjs';

const { issue } = await import('../src/lib/tokens.ts');
const { modelAnnouncement } = await import('../src/lib/translate.ts');
const { getProfile } = await import('../src/profiles/index.ts');

const app = await bootApp();
const { token } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET);
const AUTH = `Bearer ${token}`;
const profile = getProfile(PROFILE);

// 이 코호트는 provider 를 선언하지 않으므로 하네스의 `LLM_PROVIDER=openai` 를 따른다.
// openai 쪽은 세 alias 가 모두 같은 id 로 모여 있다 — 그래서 "허용된 alias 를 보냈는데
// 응답 모델 문자열이 다르다" 와 "같다" 가 **둘 다** 이 프로필에서 재현된다.
const SERVED = 'gpt-5.6-luna';
assert.deepEqual(
  [profile.model.default, profile.model.fallback], ['hypeproof-default', 'hypeproof-fast'],
  '전제가 바뀌었다 — 이 파일의 판정 기준은 이 프로필의 허용 집합에 맞춰 쓰였다',
);

// ── ① 순수 판정 ─────────────────────────────────────────────────────────────
{
  // 양성: 코호트가 허용하지 않은 구체 모델을 요청했다 → 치환이다.
  const a = modelAnnouncement('claude-opus-5', profile, SERVED);
  assert.equal(a.substituted, true, '허용되지 않은 요청이 치환으로 잡히지 않았다');
  assert.equal(a.requested, 'claude-opus-5', '요청 값이 헤더용으로 실리지 않았다');

  // 음성 대조군 1: 허용된 alias. 요청 문자열('hypeproof-fast')과 서빙 모델
  // ('gpt-5.6-luna')은 **다르다** — 그런데 치환이 아니다. 단순히
  // `requested !== served` 로 판정하면 여기서 거짓 경보가 난다.
  assert.equal(modelAnnouncement('hypeproof-fast', profile, SERVED).substituted, false,
    '허용된 alias 의 정상 번역을 치환으로 읽었다 — 매 턴 거짓 경보가 뜬다');

  // 음성 대조군 2: 허용 집합에는 없지만 **같은 모델이 나가는** 구체 id.
  assert.equal(modelAnnouncement(SERVED, profile, SERVED).substituted, false,
    '같은 모델이 나가는데 치환이라고 했다');

  // 음성 대조군 3: 모델을 안 보냈다 → 치환할 요청이 없다.
  for (const empty of [undefined, null, '', 0, {}, []]) {
    assert.equal(modelAnnouncement(empty, profile, SERVED).substituted, false,
      `요청이 없는데 치환을 만들어냈다: ${JSON.stringify(empty)}`);
  }

  // 보안: 모델 이름은 **클라이언트가 준 문자열이 응답 헤더 값이 된다.** CR/LF 가 섞이면
  // 헤더 주입이고, workers 의 Headers 는 거기서 throw 해서 멀쩡한 턴이 500 이 된다.
  for (const nasty of ['claude-opus-5\r\nX-Evil: 1', 'a\nb', 'x'.repeat(65), '모델 이름', 'a b']) {
    const r = modelAnnouncement(nasty, profile, SERVED);
    assert.equal(r.substituted, true, `위험한 문자열에서 치환 사실까지 잃었다: ${JSON.stringify(nasty)}`);
    assert.equal(r.requested, undefined,
      `헤더에 실으면 안 되는 값이 실렸다: ${JSON.stringify(nasty)}`);
  }
  // 양성 대조군: 실제 모델 id 에 쓰이는 문자는 통과해야 한다. 위 필터가 전부 막는
  // 고장이면 헤더가 영영 안 붙고, 그건 이 기능이 없는 것과 같다.
  for (const ok of ['claude-sonnet-4-5-20250929', 'gpt-5.6-luna', 'glm-5.2', 'gemini-2.5-flash']) {
    assert.equal(modelAnnouncement(ok, profile, 'other-model').requested, ok,
      `정상 모델 id 가 필터에 걸렸다: ${ok}`);
  }
}

// ── ② 응답 헤더 ─────────────────────────────────────────────────────────────
function chat(model, { stream = false } = {}) {
  return new Request('https://api.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: AUTH },
    body: JSON.stringify({ ...(model === undefined ? {} : { model }), stream,
      messages: [{ role: 'user', content: '안녕' }] }),
  });
}

/** 한 번 호출하고 응답 헤더 + 상류가 실제로 받은 모델을 돌려준다. */
async function call(model, opts = {}) {
  const env = createMockEnv();
  let upstreamModel;
  return withMockUpstream((_url, init) => {
    upstreamModel = JSON.parse(init.body).model;
    return opts.stream
      ? sseResponse(openAIStreamBody(['네'], { model: SERVED }))
      : new Response(JSON.stringify(openAIJsonBody({ content: '네', model: SERVED })),
          { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {
    const r = await app.fetch(chat(model, opts), env, makeCtx());
    return {
      status: r.status,
      served: r.headers.get('x-hps-model'),
      substituted: r.headers.get('x-hps-model-substituted'),
      requested: r.headers.get('x-hps-model-requested'),
      upstreamModel,
    };
  });
}

// 양성: 허용되지 않은 모델 → 200 이지만 **치환을 알린다**.
{
  const r = await call('claude-opus-5');
  assert.equal(r.status, 200, '일반 좌석의 오타·비허용 모델은 턴을 죽이지 않는다');
  assert.equal(r.upstreamModel, SERVED, '정책대로 수업 기본 모델이 나갔다');
  assert.equal(r.substituted, '1', '치환이 헤더로 나오지 않았다 — 이게 H-05 관측이다');
  assert.equal(r.requested, 'claude-opus-5', '무엇을 요청했는지가 헤더에 없다');
  assert.equal(r.served, SERVED, 'x-hps-model 이 실제 서빙 모델이 아니다');
}

// 음성 대조군: 허용된 alias → 헤더가 **붙지 않는다**.
{
  const r = await call('hypeproof-fast');
  assert.equal(r.status, 200);
  assert.equal(r.substituted, null, '정상 번역에 치환 헤더가 붙었다 — 매 턴 거짓 경보');
  assert.equal(r.requested, null);
}

// 음성 대조군: 모델을 안 보냈다.
{
  const r = await call(undefined);
  assert.equal(r.status, 200);
  assert.equal(r.substituted, null, '요청이 없는데 치환 헤더가 붙었다');
}

// 음성 대조군: 같은 모델이 나가는 구체 id.
{
  const r = await call(SERVED);
  assert.equal(r.status, 200);
  assert.equal(r.substituted, null, '같은 모델이 나가는데 치환이라고 알렸다');
}

// 보안: 헤더 주입 시도 → 500 이 아니라 200, 이름만 생략.
{
  const r = await call('claude-opus-5\r\nX-Evil: 1');
  assert.equal(r.status, 200, '위험한 모델 문자열이 턴을 500 으로 만들었다');
  assert.equal(r.substituted, '1', '치환 사실은 그대로 알려야 한다');
  assert.equal(r.requested, null, '걸러야 할 값이 헤더에 실렸다');
}

// 스트리밍에도 실린다. 한쪽만 실으면 "스트림이면 조용하다" 는 새 구멍이 된다.
{
  const r = await call('claude-opus-5', { stream: true });
  assert.equal(r.status, 200);
  assert.equal(r.substituted, '1', '스트리밍 응답에 치환 헤더가 없다');
  assert.equal(r.requested, 'claude-opus-5');
}
{
  const r = await call('hypeproof-fast', { stream: true });
  assert.equal(r.substituted, null, '스트리밍에서 정상 번역에 치환 헤더가 붙었다');
}

// ── ③ 비교 좌석의 계약은 다르다 — 의도된 비대칭을 잠근다 ────────────────────
//
// `studio-model-practice` 는 학생이 **모델을 직접 고르는** 좌석이다. 거기서 비허용
// 모델은 400 `model_not_allowed` 로 거부된다(chat.ts). 고르는 화면이 있는 좌석에서는
// 조용히 바꾸면 "내가 고른 게 적용됐나" 를 영원히 알 수 없기 때문이다.
//
// 반대로 일반 좌석에는 고르는 화면이 없고 모델 문자열은 설정·클라이언트 기본값에서
// 온다 — 거기서 400 을 내면 오타 하나가 아이 화면의 턴 실패가 된다. 그래서 한쪽은
// 거부, 한쪽은 공지다. **같게 만들지 않는 것이 결정**이고, 그 결정을 여기서 고정한다.
{
  const id = 'studio-model-practice';
  const mp = getProfile(id);
  assert.ok(mp, `${id} 프로필이 없다`);
  const env = createMockEnv({
    withSession: false, withRoster: false,
    env: { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic', OPENAI_API_KEY: 'synthetic' },
  });
  const now = Date.now();
  await env.HPS_KV.put(`cohort:${id}:roster`, JSON.stringify({ users: ['synthetic-adult'] }));
  await env.HPS_KV.put(`cohort:${id}:active_session`, JSON.stringify({
    session_id: 'sess-mp', profile_id: id,
    starts_at: new Date(now - 1000).toISOString(), ends_at: new Date(now + 60_000).toISOString(),
  }));
  const { token: mpToken } = await issue({ u: 'synthetic-adult', c: id, p: id }, 1, TEST_SECRET);
  await withMockUpstream(() => { throw new Error('비허용 모델은 상류에 도달하면 안 된다'); }, async () => {
    const r = await app.fetch(new Request('https://api.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mpToken}` },
      body: JSON.stringify({ model: 'claude-opus-5-nonexistent', messages: [{ role: 'user', content: '안녕' }] }),
    }), env, makeCtx());
    assert.equal(r.status, 400, '비교 좌석에서 비허용 모델이 거부되지 않았다');
    assert.equal((await r.json()).error.code, 'model_not_allowed');
    assert.equal(r.headers.get('x-hps-model-substituted'), null,
      '거부 응답에 치환 공지가 붙었다 — 두 계약이 섞였다');
  });
}

console.log('model-substitution: OK');
