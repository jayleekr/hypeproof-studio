// #580 — 스트림 끝의 usage 청크. 앱 없이, 밀리초.
//
// 클라이언트(Studio 로컬 스풀)가 요청 단위 토큰 기록을 남기려면 usage 가
// 스트림에 실려 내려와야 한다. 이 청크는 D1 usage_log 기록(onUsage 콜백)과
// **같은 accumulator** 에서 나오므로 두 기록은 정의상 일치해야 한다 — 그
// 일치가 이 테스트의 핵심 어서션이다.
//   양성 — Anthropic 합성·OpenAI passthrough 모두 [DONE] 직전에 hps_usage
//          4종이 onUsage 와 같은 값으로 실려야 한다
//   음성 — usage 를 못 본 스트림은 0 값 청크를 **지어내면 안 된다**
//
// Run: node --experimental-strip-types test/sse-usage-chunk.test.mjs

import assert from "node:assert/strict";
import "./harness/loader.mjs"; // 확장자 없는 src 상대 import 해석

const { transformStream, passThroughOpenAIStream } = await import("../src/lib/sse.ts");

const enc = new TextEncoder();

function sseStream(blocks) {
  return new ReadableStream({
    start(controller) {
      for (const b of blocks) controller.enqueue(enc.encode(b + "\n\n"));
      controller.close();
    },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

function usageChunksIn(text) {
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("data: ") && b.includes("hps_usage"))
    .map((b) => JSON.parse(b.slice(6)));
}

// ─── 양성 — Anthropic 합성 스트림: usage 청크 = onUsage(D1 경로) 값 ─────────
{
  const anthropic = sseStream([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":4000,"cache_creation_input_tokens":30}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"안녕"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ]);
  let tapped = null;
  const text = await drain(
    transformStream(anthropic, "claude-sonnet-5", (u) => { tapped = u; }, { requestId: "req-1" }),
  );

  const chunks = usageChunksIn(text);
  assert.equal(chunks.length, 1, "usage 청크는 정확히 1개");
  const [chunk] = chunks;
  assert.equal(chunk.id, "chatcmpl-hps-usage");
  assert.equal(chunk.model, "claude-sonnet-5");
  assert.equal(chunk.hps_request_id, "req-1", "클라 스풀 requestKey — 서버 로그와 조인되는 id");
  assert.deepEqual(chunk.choices, [], "OpenAI include_usage 최종 청크 형태 — 구 파서는 그냥 지나간다");
  assert.deepEqual(chunk.usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  assert.deepEqual(chunk.hps_usage, tapped, "스트림 청크와 D1 기록(onUsage)은 같은 accumulator — 반드시 일치");
  assert.deepEqual(tapped, {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 30,
  });
  // 순서: 마지막 콘텐츠 뒤, [DONE] 앞.
  assert.ok(text.indexOf("hps_usage") > text.indexOf("안녕"), "콘텐츠 뒤에 온다");
  assert.match(text, /hps_usage[\s\S]*data: \[DONE\]\n\n$/, "[DONE] 앞에 온다");
  console.log("✓ 양성 — Anthropic 합성: hps_usage 4종 = onUsage, [DONE] 직전");
}

// ─── 양성 — OpenAI passthrough: verbatim usage + 우리 청크가 공존해도 일치 ──
{
  const upstream = sseStream([
    'data: {"id":"c1","object":"chat.completion.chunk","model":"gemini-x","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
    'data: {"id":"c1","object":"chat.completion.chunk","model":"gemini-x","choices":[],"usage":{"prompt_tokens":55,"completion_tokens":7}}',
    "data: [DONE]",
  ]);
  let tapped = null;
  const text = await drain(passThroughOpenAIStream(upstream, (u) => { tapped = u; }));
  const chunks = usageChunksIn(text);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].hps_usage, tapped);
  assert.deepEqual(tapped, {
    input_tokens: 55,
    output_tokens: 7,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  assert.match(text, /"usage":\{"prompt_tokens":55/, "업스트림 verbatim usage 청크도 그대로 통과");
  assert.match(text, /data: \[DONE\]\n\n$/);
  console.log("✓ 양성 — OpenAI passthrough: verbatim + hps_usage 일치");
}

// ─── 음성 — usage 를 못 본 스트림은 0 값 청크를 지어내지 않는다 ─────────────
{
  const anthropic = sseStream([
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}',
  ]);
  const text = await drain(transformStream(anthropic, "m", () => {}));
  assert.equal(usageChunksIn(text).length, 0, "usage 미관측 → 청크 없음 (0 토큰을 지어내지 않는다)");
  assert.match(text, /data: \[DONE\]\n\n$/, "[DONE] 은 여전히 온다");
  console.log("✓ 음성 — usage 미관측 스트림엔 usage 청크 없음");
}

// ─── 음성 — mid-stream 업스트림 실패: 클라엔 usage 청크 없음, D1 tap 은 발화 ─
// (의도된 비대칭: 끊긴 턴의 usage 는 서버 원장(D1)에만 남고, 클라 스풀은
//  turn_end(status:error) 로 "usage 없는 이유"를 남긴다.)
{
  // start() 안에서 enqueue 직후 동기 error() 를 부르면 큐에 남은 청크가
  // 버려져 message_start 가 소비되지 않는다 — pull 로 한 read 뒤에 죽인다.
  let step = 0;
  const failing = new ReadableStream({
    pull(c) {
      if (step++ === 0) {
        c.enqueue(enc.encode(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":42}}}\n\n',
        ));
      } else {
        c.error(new Error("upstream died"));
      }
    },
  });
  let tapped = null;
  const text = await drain(transformStream(failing, "m", (u) => { tapped = u; }, { requestId: "req-2" }));
  assert.equal(usageChunksIn(text).length, 0, "에러 경로엔 usage 청크 없음");
  assert.match(text, /stream_error/, "#257 sanitized 에러 청크는 나간다");
  assert.equal(tapped.input_tokens, 42, "D1 경로(onUsage)는 finally 에서 그래도 발화");
  console.log("✓ 음성 — mid-stream 실패: 클라 무청크 · D1 tap 유지 (의도된 비대칭)");
}

console.log("sse-usage-chunk.test.mjs — all green");
