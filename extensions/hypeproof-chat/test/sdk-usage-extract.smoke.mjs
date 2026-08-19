// #580 — SDK 스트림의 토큰 usage 추출. 앱 없이, 밀리초.
//
// 시료는 #503 실측(0.3.207)과 sdk.d.ts 로 확인한 실제 형태를 본뜬다:
// SDK 는 API 응답 1개를 thinking/text/tool_use 여러 메시지로 쪼개며 같은
// message.id·usage 를 복제하고, 턴 끝의 result 메시지가 합계를 실어 온다.
//
//   양성 — assistant/result 메시지에서 4종 토큰·키·합계가 정확히 나와야 한다
//   음성 — 키 없는 usage 는 **버려야 한다** (기록하면 분할 복제 × 과대계상),
//          usage 없는 메시지는 null 이어야 한다
//
// Run: node --experimental-strip-types test/sdk-usage-extract.smoke.mjs

import assert from "node:assert/strict";

const { extractSdkUsage } = await import("../src/sdkCoachHelpers.ts");

const USAGE = {
  input_tokens: 1204,
  output_tokens: 3310,
  cache_read_input_tokens: 51002,
  cache_creation_input_tokens: 388,
};

/** #503 형태의 assistant 메시지 — 같은 API 응답의 분할 조각. */
const assistantMsg = (over = {}) => ({
  type: "assistant",
  message: { id: "msg_abc", model: "claude-sonnet-5", usage: { ...USAGE } },
  parent_tool_use_id: null,
  uuid: "uuid-1",
  session_id: "sdk-session",
  request_id: "req_xyz",
  ...over,
});

// ─── 양성 대조군 — 요청 단위 추출 ───────────────────────────────────────────
{
  const u = extractSdkUsage(assistantMsg());
  assert.deepEqual(u, {
    kind: "request",
    requestKey: "msg_abc",
    model: "claude-sonnet-5",
    usage: USAGE,
  });

  // 분할 3조각 — 전부 같은 requestKey 를 내야 소비자 dedupe 가 1건으로 만든다.
  const keys = ["thinking", "text", "tool_use"].map(
    () => extractSdkUsage(assistantMsg()).requestKey,
  );
  assert.deepEqual(keys, ["msg_abc", "msg_abc", "msg_abc"]);

  // message.id 가 없으면 request_id 로 폴백.
  const fallback = extractSdkUsage(
    assistantMsg({ message: { model: "m", usage: { ...USAGE } } }),
  );
  assert.equal(fallback.requestKey, "req_xyz");

  // 서브에이전트 메시지도 같은 형태 — 전량 목표에 포함된다.
  const sub = extractSdkUsage(assistantMsg({ parent_tool_use_id: "toolu_1", subagent_type: "explorer" }));
  assert.equal(sub.kind, "request");
  console.log("✓ 양성 — assistant 요청 단위: 키·모델·토큰 4종");
}

// ─── 양성 대조군 — result 턴 합계 ───────────────────────────────────────────
{
  const total = extractSdkUsage({
    type: "result",
    subtype: "success",
    usage: { ...USAGE },
    total_cost_usd: 0.042,
    num_turns: 3,
  });
  assert.deepEqual(total, { kind: "turn_total", usage: USAGE, totalCostUsd: 0.042 });

  // 비용 필드가 없어도 합계는 나온다 (cost 는 null).
  const noCost = extractSdkUsage({ type: "result", subtype: "error_max_turns", usage: { ...USAGE } });
  assert.equal(noCost.kind, "turn_total");
  assert.equal(noCost.totalCostUsd, null);
  console.log("✓ 양성 — result 턴 합계 + total_cost_usd");
}

// ─── 음성 대조군 — 키 없는 usage 는 버린다 (과대계상 방지) ──────────────────
{
  // message.id 도 request_id 도 없으면: uuid 는 SDK 메시지 단위라 분할 조각마다
  // 다르다 — 그걸 키로 쓰면 같은 요청이 3번 계상된다. null 이 정답.
  const noKey = extractSdkUsage({
    type: "assistant",
    message: { usage: { ...USAGE } },
    uuid: "uuid-per-sdk-message",
  });
  assert.equal(noKey, null);
  console.log("✓ 음성 — 키 없는 assistant usage 는 null (uuid 로 대체하지 않는다)");
}

// ─── 음성 대조군 — usage 아닌 메시지는 null ─────────────────────────────────
{
  for (const msg of [
    { type: "assistant", message: { id: "msg_1", model: "m" } },       // usage 없음
    { type: "assistant", message: { id: "msg_1", usage: [1, 2] } },    // 배열 usage — 통과시키면 0 레코드 조작
    { type: "assistant", message: { id: "msg_1", usage: 123 } },       // 원시값 usage
    { type: "stream_event", event: { type: "content_block_delta" } },  // 부분 스트림
    { type: "system", subtype: "init" },
    { type: "result", subtype: "success" },                            // usage 없는 result
    { type: "user" },
    {},
  ]) {
    assert.equal(extractSdkUsage(msg), null, JSON.stringify(msg));
  }
  console.log("✓ 음성 — usage 없는/깨진 메시지 전부 null");
}

// ─── 경계 — 깨진 숫자는 0 으로 (지어내지 않는다) ────────────────────────────
{
  const u = extractSdkUsage(
    assistantMsg({
      message: {
        id: "msg_broken",
        usage: { input_tokens: "12", output_tokens: -5, cache_read_input_tokens: NaN },
      },
    }),
  );
  assert.deepEqual(u.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  assert.equal(u.model, null);
  console.log("✓ 경계 — 문자열·음수·NaN 은 0, 모델 없으면 null");
}

console.log("sdk-usage-extract.smoke.mjs — all green");
