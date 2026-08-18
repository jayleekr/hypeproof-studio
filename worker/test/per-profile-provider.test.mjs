// 프로필별 프로바이더 — 한 배포에서 UC 마다 다른 모델을 쓴다.
//
// 왜 필요한가: 쓰임새마다 맞는 모델이 다르다. 아이들 수업은 싸고 빠른 쪽, 고위험
// 산출물은 비싸도 정확한 쪽. 그런데 지금까지는 `LLM_PROVIDER` 하나가 배포 전체를 묶어서
// **한 번에 한 모델만** 쓸 수 있었다.
//
// 검증하는 것:
//   1. 프로필이 provider 를 선언하면 그 요청만 그쪽으로 나간다
//   2. 선언하지 않은 프로필은 **기존 동작 그대로** 배포 기본값을 쓴다 (회귀 방지)
//   3. 같은 배포에서 둘이 **동시에** 갈린다 — 이게 이 기능의 전부다
//   4. 프로필이 가리키는 키가 없으면 **그 프로필만** 죽고 나머지는 산다
import "./harness/loader.mjs";

import assert from "node:assert/strict";
import {
  bootApp, createMockEnv, makeCtx, withMockUpstream,
  anthropicJsonBody, openAIJsonBody, COHORT, PROFILE, USER, TEST_SECRET,
} from "./harness/index.mjs";

const app = await bootApp();
const { issue } = await import("../src/lib/tokens.ts");
const { getProfile } = await import("../src/profiles/index.ts");
const { providerKey } = await import("../src/env.ts");

const { token: TOKEN } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET);

function chatRequest() {
  return new Request("https://api.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model: "hypeproof-default", stream: false, messages: [{ role: "user", content: "안녕" }] }),
  });
}

/** 프로필의 provider 핀을 이 테스트 동안만 바꾼다 (모듈 캐시를 공유하므로 되돌린다). */
async function withPinnedProvider(provider, fn) {
  const profile = getProfile(PROFILE);
  const before = profile.model.provider;
  profile.model.provider = provider;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete profile.model.provider;
    else profile.model.provider = before;
  }
}

const okAnthropic = () => new Response(JSON.stringify(anthropicJsonBody({ text: "ok" })),
  { status: 200, headers: { "content-type": "application/json" } });
const okOpenAI = () => new Response(JSON.stringify(openAIJsonBody({ content: "ok" })),
  { status: 200, headers: { "content-type": "application/json" } });

// --- 1 + 3. 같은 배포에서 프로필마다 다른 상류로 나간다 ----------------------
{
  // 배포 기본값은 openai (harness 기본). 프로필만 glm 으로 핀.
  const env = { ...createMockEnv(), GLM_API_KEY: "glm-test-key" };

  const pinnedCalls = await withPinnedProvider("glm", () =>
    withMockUpstream(okAnthropic, async (calls) => {
      const r = await app.fetch(chatRequest(), env, makeCtx());
      assert.equal(r.status, 200);
      return calls;
    }));
  assert.ok(pinnedCalls.some((c) => c.url.includes("z.ai")),
    `핀이 걸린 프로필은 z.ai 로 가야 한다 (실제: ${pinnedCalls.map((c) => c.url).join(", ")})`);

  // 같은 env, 핀 없는 프로필 → 배포 기본값(openai)
  const defaultCalls = await withMockUpstream(okOpenAI, async (calls) => {
    const r = await app.fetch(chatRequest(), env, makeCtx());
    assert.equal(r.status, 200);
    return calls;
  });
  assert.ok(defaultCalls.some((c) => c.url.includes("openai.com")),
    `핀 없는 프로필은 배포 기본값으로 가야 한다 (실제: ${defaultCalls.map((c) => c.url).join(", ")})`);
  assert.ok(!defaultCalls.some((c) => c.url.includes("z.ai")),
    "핀을 푼 뒤에도 z.ai 로 가면 핀이 전역으로 샌 것이다");

  console.log("✅ 같은 배포에서 UC 마다 다른 상류로 갈린다 (핀=z.ai · 기본=openai)");
}

// --- 2. 기존 동작 회귀 없음 --------------------------------------------------
{
  // provider 를 선언한 프로필이 하나도 없으면 지금까지와 완전히 같아야 한다.
  const pinned = [];
  for (const id of ["sk-biopharm-kids-2026-grade-3-4-s1", "sk-biopharm-kids-s1"]) {
    const p = getProfile(id);
    if (p?.model?.provider) pinned.push(id);
  }
  assert.deepEqual(pinned, [],
    `기본 배포에서는 어떤 프로필도 provider 를 핀하지 않는다 (핀된 것: ${pinned})`);
  console.log("✅ 회귀 없음: 아무 프로필도 provider 를 선언하지 않은 상태가 기본이다");
}

// --- 4. 키가 없으면 그 프로필만 죽는다 ----------------------------------------
{
  assert.throws(() => providerKey({ GEMINI_API_KEY: "g" }, "glm"),
    /provider=glm .*key is not set/,
    "핀한 프로바이더의 키가 없으면 던져야 한다 — 조용히 다른 상류로 새면 안 된다");

  // 그리고 그 실패가 배포 전체를 죽이지 않는다: 다른 프로필은 그대로 200.
  const env = { ...createMockEnv() };            // GLM 키 없음
  const failed = await withPinnedProvider("glm", () =>
    withMockUpstream(okAnthropic, async () => app.fetch(chatRequest(), env, makeCtx())));
  assert.equal(failed.status, 502, "키 없는 핀 → 그 프로필은 502");

  const survived = await withMockUpstream(okOpenAI, async () =>
    app.fetch(chatRequest(), env, makeCtx()));
  assert.equal(survived.status, 200, "핀 없는 프로필은 영향 없이 200 이어야 한다");

  console.log("✅ 격리: 키 없는 핀은 그 프로필만 502, 나머지는 정상");
}

console.log("\n3/3 passed");
