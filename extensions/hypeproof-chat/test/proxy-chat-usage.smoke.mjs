// #580 — proxyChat 스트림 루프의 usage 발화. 앱 없이, 밀리초.
//
// 추출기(usageFromStreamChunk)는 따로 테스트되지만, 위험한 건 접합부다:
// onUsage 가 **호출당 정확히 1회**, 올바른 requestKey 로 발화하는가. 키는
// 3단 폴백이다 — 청크 hps_request_id → x-request-id 헤더 → local-* 생성.
// (리뷰 실측: 과거 스트리밍 200 응답엔 x-request-id 헤더가 아예 없었다 —
// 헤더에만 의존했으면 이 경로의 usage 기록이 전량 유실됐다.)
//   양성 — usage 청크가 있으면 정확히 1회, 우선순위대로 키가 붙는다
//   음성 — usage 없는 스트림·stream_error 스트림에서 usage 를 지어내지 않는다
//
// Run: node --experimental-strip-types test/proxy-chat-usage.smoke.mjs

import assert from "node:assert/strict";

const { proxyChat, ProxyTransportError } = await import("../src/proxyClient.ts");

const enc = new TextEncoder();

function sseResponse(lines, headers = {}) {
  const body = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", ...headers } });
}

const DELTA = JSON.stringify({
  id: "c1", object: "chat.completion.chunk", model: "claude-sonnet-5",
  choices: [{ index: 0, delta: { content: "안녕" }, finish_reason: null }],
});
const usageChunk = (extra = {}) => JSON.stringify({
  id: "chatcmpl-hps-usage", object: "chat.completion.chunk", model: "claude-sonnet-5",
  choices: [],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  hps_usage: {
    input_tokens: 100, output_tokens: 20,
    cache_read_input_tokens: 4000, cache_creation_input_tokens: 30,
  },
  ...extra,
});

async function runProxyChat(response) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => response;
  const fired = [];
  try {
    const result = await proxyChat({
      proxyUrl: "https://api.example.test/v1",
      model: "hypeproof-default",
      token: "tok.sig",
      history: [],
      userText: "hi",
      signal: new AbortController().signal,
      onDelta: () => {},
      onUsage: (u) => fired.push(u),
    });
    return { result, fired };
  } finally {
    globalThis.fetch = orig;
  }
}

// ─── 양성 — 청크 rid 우선, 정확히 1회 ───────────────────────────────────────
{
  const { fired } = await runProxyChat(
    sseResponse([DELTA, usageChunk({ hps_request_id: "req-chunk" }), "[DONE]"],
      { "x-request-id": "req-header" }),
  );
  assert.equal(fired.length, 1, "onUsage 는 호출당 정확히 1회");
  assert.equal(fired[0].requestKey, "req-chunk", "청크 hps_request_id 가 헤더보다 우선");
  assert.equal(fired[0].model, "claude-sonnet-5");
  assert.equal(fired[0].inputTokens, 100);
  assert.equal(fired[0].cacheReadInputTokens, 4000);
  console.log("✓ 양성 — usage 1회 발화, 청크 rid 우선");
}

// ─── 양성 — 청크 rid 없으면 헤더, 그것도 없으면 local-* ─────────────────────
{
  const { fired: viaHeader } = await runProxyChat(
    sseResponse([usageChunk(), "[DONE]"], { "x-request-id": "req-header" }),
  );
  assert.equal(viaHeader[0].requestKey, "req-header");

  const { fired: viaLocal } = await runProxyChat(sseResponse([usageChunk(), "[DONE]"]));
  assert.match(viaLocal[0].requestKey, /^local-/, "키가 전무해도 버리지 않는다 — local 표식");
  console.log("✓ 양성 — 헤더 폴백 · local-* 최종 폴백");
}

// ─── 양성 — [DONE] 없는 스트림 종료(루프 끝 반환)에서도 1회 ─────────────────
{
  const { fired } = await runProxyChat(sseResponse([DELTA, usageChunk()]));
  assert.equal(fired.length, 1);
  console.log("✓ 양성 — [DONE] 부재 종료 경로에서도 정확히 1회");
}

// ─── 음성 — usage 청크 없는 스트림은 발화하지 않는다 ────────────────────────
{
  const { fired, result } = await runProxyChat(sseResponse([DELTA, "[DONE]"]));
  assert.equal(fired.length, 0, "usage 미관측 → 발화 없음 (지어내지 않는다)");
  assert.equal(result.text, "안녕", "본문 처리는 그대로");
  console.log("✓ 음성 — usage 없는 스트림은 무발화");
}

// ─── 음성 — stream_error 는 던지고, usage 는 발화하지 않는다 ────────────────
{
  const streamError = JSON.stringify({
    error: { message: "stream interrupted — please retry (request_id: r1)", type: "stream_error", request_id: "r1" },
  });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([DELTA, streamError, "data-없는줄무시"], {});
  const fired = [];
  try {
    await assert.rejects(
      proxyChat({
        proxyUrl: "https://api.example.test/v1", model: "m", token: "t.s",
        history: [], userText: "hi",
        signal: new AbortController().signal,
        onDelta: () => {},
        onUsage: (u) => fired.push(u),
      }),
      (err) => err instanceof ProxyTransportError && err.requestId === "r1",
      "stream_error 는 ProxyTransportError 로 표면화된다 (조용한 절단 금지)",
    );
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(fired.length, 0, "끊긴 스트림의 usage 는 발화하지 않는다");
  console.log("✓ 음성 — stream_error 는 던지고 usage 무발화");
}

console.log("proxy-chat-usage.smoke.mjs — all green");
