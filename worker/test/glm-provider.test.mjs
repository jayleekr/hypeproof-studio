// GLM(Z.ai) 프로바이더 배선 — hypeprooflab#545.
//
// 검증하는 것은 셋이다.
//   1. LLM_PROVIDER=glm 이 **명시적으로만** 켜진다 (키만 넣었다고 상류가 바뀌면 사고)
//   2. 요청이 z.ai 의 Anthropic 호환 URL 로 나가고, 모델 id 가 glm 계열이다
//   3. Anthropic 전용 프록시 헤더가 **따라가지 않는다** (붙으면 z.ai 가 403 을 낸다)
//
// 실제 z.ai 호출은 여기서 하지 않는다 — 테스트가 외부 유료 API 에 의존하면 키가 없는
// 사람의 CI 에서 죽는다. 실키 왕복은 도입 시 1회 수동으로 했고 근거는 lib/glm.ts 에 있다.
import "./harness/loader.mjs";

import assert from "node:assert/strict";
import {
  bootApp,
  createMockEnv,
  makeCtx,
  withMockUpstream,
  anthropicJsonBody,
  COHORT,
  PROFILE,
  USER,
  TEST_SECRET,
} from "./harness/index.mjs";

const app = await bootApp();
const { issue } = await import("../src/lib/tokens.ts");
const { resolveProvider } = await import("../src/env.ts");
const { GLM_ANTHROPIC_URL } = await import("../src/lib/glm.ts");

const { token: TOKEN } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET);

function chatRequest(prompt = "안녕") {
  return new Request("https://api.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model: "hypeproof-default", stream: false, messages: [{ role: "user", content: prompt }] }),
  });
}

// --- 1. 명시적으로만 켜진다 --------------------------------------------------
{
  const resolved = resolveProvider({ LLM_PROVIDER: "glm", GLM_API_KEY: "k" });
  assert.equal(resolved.provider, "glm");
  assert.equal(resolved.apiKey, "k");

  assert.throws(
    () => resolveProvider({ LLM_PROVIDER: "glm" }),
    /GLM_API_KEY is not set/,
    "키 없이 glm 을 지정하면 던져야 한다 — 인증 없는 상류 호출을 조용히 하지 않는다",
  );

  // 키만 있고 LLM_PROVIDER 가 없으면 기존 기본(gemini)이 유지돼야 한다.
  // GLM 키를 넣었다는 이유만으로 수업 트래픽의 상류가 바뀌면 사고다.
  const implicit = resolveProvider({ GLM_API_KEY: "k", GEMINI_API_KEY: "g" });
  assert.equal(implicit.provider, "gemini", "GLM 은 기본 순서에 들어가면 안 된다");

  console.log("✅ provider: LLM_PROVIDER=glm 일 때만 켜지고, 키 없으면 fail-closed");
}

// --- 2. z.ai 로 나가고 모델이 glm 이다 ---------------------------------------
{
  const env = { ...createMockEnv(), LLM_PROVIDER: "glm", GLM_API_KEY: "glm-test-key" };

  const calls = await withMockUpstream(
    () => new Response(JSON.stringify(anthropicJsonBody({ text: "ok" })), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    async (calls) => {
      const r = await app.fetch(chatRequest(), env, makeCtx());
      assert.equal(r.status, 200, "glm 경로가 200 을 내야 한다");
      return calls;
    },
  );

  const upstream = calls.find((c) => c.url.includes("z.ai"));
  assert.ok(upstream, `요청이 z.ai 로 나가야 한다 (실제: ${calls.map((c) => c.url).join(", ")})`);
  assert.equal(upstream.url, GLM_ANTHROPIC_URL, "Anthropic 호환 경로를 써야 한다");

  const sent = JSON.parse(upstream.init.body);
  assert.match(sent.model, /^glm-/, `모델이 glm 계열이어야 한다 (실제: ${sent.model})`);

  console.log("✅ routing: z.ai Anthropic 호환 URL + glm 모델 id");
}

// --- 3. Anthropic 프록시 헤더가 따라가지 않는다 -------------------------------
{
  // 프록시가 설정된 환경에서도 glm 은 그것을 쓰면 안 된다. 붙이면 z.ai 가 403 을 낸다.
  const env = {
    ...createMockEnv(),
    LLM_PROVIDER: "glm",
    GLM_API_KEY: "glm-test-key",
    ANTHROPIC_PROXY_URL: "https://proxy.invalid/proxy/anthropic/v1/messages",
    ANTHROPIC_PROXY_SECRET: "should-not-leak",
  };

  const calls = await withMockUpstream(
    () => new Response(JSON.stringify(anthropicJsonBody({ text: "ok" })), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    async (calls) => {
      await app.fetch(chatRequest(), env, makeCtx());
      return calls;
    },
  );

  const upstream = calls.find((c) => c.url.includes("z.ai"));
  assert.ok(upstream, "프록시가 설정돼 있어도 glm 은 z.ai 로 직접 가야 한다");

  const headers = new Headers(upstream.init.headers);
  assert.equal(
    headers.get("X-Sediment-Proxy-Secret"), null,
    "Anthropic 프록시 시크릿이 z.ai 로 새면 안 된다",
  );
  assert.equal(headers.get("x-api-key"), "glm-test-key", "GLM 키로 인증해야 한다");

  console.log("✅ isolation: Anthropic 프록시 URL·시크릿이 glm 요청에 섞이지 않는다");
}

console.log("\n3/3 passed");
