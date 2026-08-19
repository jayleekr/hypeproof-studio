// #580 — proxy 스트림 청크의 토큰 usage 파싱. 앱 없이, 밀리초.
//
// 두 형태를 받아야 한다: 워커가 [DONE] 직전에 싣는 hps_usage(캐시 포함 전량,
// #580 worker 변경) 와 OpenAI/Gemini 업스트림의 verbatim usage 최종 청크.
//   양성 — 두 형태 모두에서 4종 토큰이 정확히 나와야 한다
//   음성 — 일반 delta/asset_score 청크에서 usage 를 **지어내면 안 된다**
//
// Run: node --experimental-strip-types test/proxy-usage-extract.smoke.mjs

import assert from "node:assert/strict";

const { usageFromStreamChunk } = await import("../src/proxyClientHelpers.ts");

// ─── 양성 대조군 — 워커 hps_usage 청크 (Anthropic 업스트림 경로) ────────────
{
  const u = usageFromStreamChunk({
    id: "chatcmpl-hps-usage",
    object: "chat.completion.chunk",
    model: "claude-sonnet-5",
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    hps_usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 30,
    },
  });
  assert.deepEqual(u, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 4000,
    cacheCreationInputTokens: 30,
  }, "hps_usage 가 있으면 캐시 필드까지 전량 — usage 보다 우선");
  console.log("✓ 양성 — hps_usage 4종 전량");
}

// ─── 양성 대조군 — OpenAI 형식 usage 최종 청크 (Gemini/OpenAI 업스트림) ─────
{
  const u = usageFromStreamChunk({
    id: "chatcmpl-123",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 55, completion_tokens: 7, total_tokens: 62 },
  });
  assert.deepEqual(u, {
    inputTokens: 55,
    outputTokens: 7,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }, "OpenAI usage — 캐시 정보가 없으니 0 (지어내지 않는다)");
  console.log("✓ 양성 — OpenAI usage 청크");
}

// ─── 음성 대조군 — usage 아닌 청크는 null ───────────────────────────────────
{
  for (const chunk of [
    { choices: [{ index: 0, delta: { content: "안녕" }, finish_reason: null }] },  // 일반 delta
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },                 // 종료 청크
    { type: "asset_score", version: 1, method: "heuristic-v1" },                   // 워커 부가 청크
    { choices: [{ index: 0, delta: { hps_tool_use: { id: "t", name: "n" } } }] },  // 툴 청크
    { usage: {} },              // 빈 usage — prompt/completion 없음
    { usage: [5, 5] },          // 배열 usage — 통과시키면 0 레코드 조작
    { hps_usage: [5, 5] },      // 배열 hps_usage
    { hps_usage: 7 },           // 원시값 hps_usage
    null,
    "data-string",
    {},
  ]) {
    assert.equal(usageFromStreamChunk(chunk), null, JSON.stringify(chunk));
  }
  console.log("✓ 음성 — delta·asset_score·툴 청크에서 usage 를 지어내지 않는다");
}

// ─── 경계 — 깨진 숫자는 0 ───────────────────────────────────────────────────
{
  const u = usageFromStreamChunk({
    hps_usage: { input_tokens: "100", output_tokens: -1, cache_read_input_tokens: Infinity },
  });
  assert.deepEqual(u, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  });
  console.log("✓ 경계 — 문자열·음수·Infinity 는 0");
}

console.log("proxy-usage-extract.smoke.mjs — all green");
