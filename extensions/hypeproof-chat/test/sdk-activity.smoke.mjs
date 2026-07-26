// Smoke tests for the SDK-coach activity log (#414, REQ-M27). Pure — no
// vscode, no SDK. 2026-07-24 실측: 코치가 286초 동안 thinking → Write → Bash →
// Write 를 4턴 돌았는데 화면엔 "🛠️ 웹사이트 만드는 중 — 구조 정리 중… ✨" 한 줄만
// 떴다. 그 가짜 단계는 스트리밍된 채팅 텍스트 '길이'로 만들어진 것이고, SDK
// 경로에선 코치가 도구로 파일을 쓰기 때문에 텍스트가 안 늘어 영원히 첫 단계에
// 머문다. 진짜 신호(thinking / tool_use / tool_result / thinking_tokens)는 이미
// 스트림에 다 들어 있었고 그냥 버려지고 있었다.
//
// 계약: extractSdkActivity 는 이벤트 하나에서 '보여줄 수 있는 것'만 뽑는 순수
// 함수이고, consumeSdkStream 은 그것을 발생 순서대로 흘리되 기존 텍스트
// 스트리밍·#320 fast-fail·#403 stall 워치독을 하나도 건드리지 않는다.
//
// 번역하지 않는 것이 의도다(이슈 코멘트): 도구 이름은 SDK 의 것이고 thinking 은
// 모델이 실제로 쓴 문장이다. "Write(index.html)" 를 한국어로 의역하면 원본보다
// 못한 신호가 된다 — Claude Code 처럼 행동 한 줄, 길면 잘라서.
// Run: node --experimental-strip-types test/sdk-activity.smoke.mjs

import assert from "node:assert/strict";

const { extractSdkActivity, summarizeToolInput, consumeSdkStream, SDK_STALL_FRIENDLY } =
  await import("../src/sdkCoachHelpers.ts");

// 실제 SDK 메시지 모양(sdk.d.ts 기준)만 쓴다 — 모양이 바뀌면 이 테스트가 먼저 깨져야 한다.
const assistantBlocks = (...blocks) => ({ type: "assistant", message: { content: blocks } });
const userBlocks = (...blocks) => ({ type: "user", message: { content: blocks } });
const thinkingTokens = (estimated_tokens) => ({
  type: "system",
  subtype: "thinking_tokens",
  estimated_tokens,
  estimated_tokens_delta: 12,
});
const apiRetry = (error_status) => ({
  type: "system",
  subtype: "api_retry",
  attempt: 1,
  max_retries: 10,
  error_status,
  error: "overloaded",
});

// ─── extractSdkActivity: thinking ───────────────────────────────────────────
{
  const acts = extractSdkActivity(
    assistantBlocks({ type: "thinking", thinking: "Let me check the workspace path first.", signature: "s" }),
  );
  assert.deepEqual(acts, [{ kind: "thinking", text: "Let me check the workspace path first." }]);

  // 빈/공백 thinking 은 화면에 빈 줄만 남기므로 버린다.
  assert.deepEqual(extractSdkActivity(assistantBlocks({ type: "thinking", thinking: "   " })), []);
  assert.deepEqual(extractSdkActivity(assistantBlocks({ type: "thinking" })), []);
}

// ─── extractSdkActivity: tool_use ───────────────────────────────────────────
{
  const acts = extractSdkActivity(
    assistantBlocks({ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/w/index.html" } }),
  );
  assert.deepEqual(acts, [
    { kind: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/w/index.html" } },
  ]);

  // id 나 name 이 없으면 tool_result 와 짝지을 수 없다 → 로그에 못 올린다.
  assert.deepEqual(extractSdkActivity(assistantBlocks({ type: "tool_use", name: "Write" })), []);
  assert.deepEqual(extractSdkActivity(assistantBlocks({ type: "tool_use", id: "toolu_2" })), []);
}

// ─── extractSdkActivity: tool_result (user 메시지로 되돌아온다) ─────────────
{
  assert.deepEqual(extractSdkActivity(userBlocks({ type: "tool_result", tool_use_id: "toolu_1", content: "ok" })), [
    { kind: "tool_result", id: "toolu_1", isError: false },
  ]);
  // 실패도 '진행'이다 — 읽기전용 경로에 막힌 Write 는 반드시 ⚠️ 로 보여야 한다.
  assert.deepEqual(
    extractSdkActivity(userBlocks({ type: "tool_result", tool_use_id: "toolu_1", is_error: true })),
    [{ kind: "tool_result", id: "toolu_1", isError: true }],
  );
  assert.deepEqual(extractSdkActivity(userBlocks({ type: "tool_result" })), [], "id 없는 결과는 무시");
}

// ─── extractSdkActivity: thinking_tokens (스피너용 살아있는 카운터) ─────────
{
  assert.deepEqual(extractSdkActivity(thinkingTokens(1200)), [{ kind: "thinking_tokens", tokens: 1200 }]);
  // 숫자가 아니면 "Thinking… undefined tokens" 가 되므로 버린다.
  assert.deepEqual(extractSdkActivity({ type: "system", subtype: "thinking_tokens" }), []);
}

// ─── extractSdkActivity: 보여줄 게 없는 이벤트는 조용히 [] ──────────────────
{
  assert.deepEqual(extractSdkActivity(assistantBlocks({ type: "text", text: "저장했어요" })), [], "텍스트는 onDelta 몫");
  assert.deepEqual(extractSdkActivity({ type: "system", subtype: "init" }), []);
  assert.deepEqual(extractSdkActivity(apiRetry(529)), [], "재시도 틱은 작업이 아니다");
  assert.deepEqual(extractSdkActivity({ type: "result" }), []);
  assert.deepEqual(extractSdkActivity({ type: "assistant", message: { content: "not-an-array" } }), []);
  assert.deepEqual(extractSdkActivity({}), []);
}

// ─── 한 이벤트 안의 여러 블록은 순서대로 ────────────────────────────────────
{
  const acts = extractSdkActivity(
    assistantBlocks(
      { type: "thinking", thinking: "Write both files." },
      { type: "text", text: "만들게요" },
      { type: "tool_use", id: "a", name: "Write", input: { file_path: "a.html" } },
      { type: "tool_use", id: "b", name: "Write", input: { file_path: "b.css" } },
    ),
  );
  assert.deepEqual(
    acts.map((a) => a.kind),
    ["thinking", "tool_use", "tool_use"],
  );
  assert.deepEqual(acts.map((a) => a.id ?? null), [null, "a", "b"]);
}

// ─── summarizeToolInput: 도구 옆에 붙일 '식별되는 한 조각' ──────────────────
{
  // 경로는 **워크스페이스 루트 기준**으로 보여 준다. 접두사는 매 줄 똑같아
  // 쓸모없지만, 파일명만 남기는 축약은 정보를 너무 많이 버렸다 — 2026-07-26
  // 실측에서 이 셋이 화면에 같은 글자로 보여 같은 결함을 세 번 오진했다:
  //   정상(절대·루트 안) · 상대경로(SDK 가 거부) · 루트 밖(위험)
  const WS = "/Users/kid/workspace";
  assert.equal(summarizeToolInput("Write", { file_path: `${WS}/index.html` }, 60, WS), "index.html");
  assert.equal(summarizeToolInput("Write", { file_path: `${WS}/sub/a.css` }, 60, WS), "sub/a.css");
  // 루트 밖은 축약하지 않는다 — 눈에 띄어야 한다.
  assert.equal(summarizeToolInput("Read", { path: "/etc/passwd" }, 60, WS), "/etc/passwd");
  // 상대경로는 `./` 로 구분된다 (흡수 전에 보이면 그게 곧 원인 표시다).
  assert.equal(summarizeToolInput("Read", { file_path: "agent.md" }, 60, WS), "./agent.md");
  // 루트를 모르면 절대경로를 그대로 — 잘라서 숨기지 않는다.
  assert.equal(summarizeToolInput("Write", { file_path: `${WS}/index.html` }), `${WS}/index.html`);
  assert.equal(summarizeToolInput("Read", { path: "/w/src/styles.css" }), "/w/src/styles.css");
  assert.equal(summarizeToolInput("Bash", { command: "ls -la" }), "ls -la");
  assert.equal(summarizeToolInput("WebFetch", { url: "https://example.com/pricing" }), "https://example.com/pricing");
  assert.equal(summarizeToolInput("WebSearch", { query: "임플란트 가격" }), "임플란트 가격");
  assert.equal(summarizeToolInput("Grep", { pattern: "TODO" }), "TODO");

  // 모르는 도구도 이름만 덩그러니 두지 않는다 → 압축 JSON 이라도 보여준다.
  assert.equal(summarizeToolInput("MysteryTool", { ref: "e3" }), '{"ref":"e3"}');

  // 입력이 없으면 빈 문자열(호출부가 `Name()` 로 그린다).
  assert.equal(summarizeToolInput("Read", undefined), "");
  assert.equal(summarizeToolInput("Read", "not-an-object"), "");

  // 한 줄 유지: 줄바꿈은 공백으로, 길면 … 로 자른다.
  assert.equal(summarizeToolInput("Bash", { command: "echo a\n  echo b" }), "echo a echo b");
  const long = summarizeToolInput("Bash", { command: "x".repeat(500) });
  assert.ok(long.endsWith("…"), "긴 입력은 잘린다");
  assert.equal(long.length, 61, "기본 60자 + …");
  assert.equal(summarizeToolInput("Bash", { command: "x".repeat(500) }, 10), `${"x".repeat(10)}…`);
}

// ─── consumeSdkStream: 활동은 발생 순서대로, 텍스트는 그대로 ────────────────
function handlers(overrides = {}) {
  const calls = { deltas: [], acts: [], aborted: 0, stalls: 0 };
  const h = {
    isAborted: () => false,
    makeAbortError: () => Object.assign(new Error("Aborted"), { name: "AbortError" }),
    abortQuery: () => {
      calls.aborted++;
    },
    makeFatalAuthError: (status) => Object.assign(new Error("auth"), { name: "FatalAuth", status }),
    onDelta: (d) => calls.deltas.push(d),
    onActivity: (a) => calls.acts.push(a),
    makeStallError: () => {
      calls.stalls++;
      return Object.assign(new Error(SDK_STALL_FRIENDLY), { name: "CoachStallError" });
    },
    ...overrides,
  };
  return { h, calls };
}

const mockStream = (events) =>
  (async function* () {
    for (const e of events) yield e;
  })();

{
  // 이슈에 붙은 실측 턴을 그대로 축약한 것: 생각 → 쓰기 → 실패 → 셸 → 쓰기.
  const { h, calls } = handlers();
  await consumeSdkStream(
    mockStream([
      thinkingTokens(300),
      assistantBlocks({ type: "thinking", thinking: "Check the workspace path." }),
      assistantBlocks(
        { type: "text", text: "작업 폴더를 확인할게요." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "pwd" } },
      ),
      userBlocks({ type: "tool_result", tool_use_id: "t1" }),
      assistantBlocks({ type: "tool_use", id: "t2", name: "Write", input: { file_path: "/w/index.html" } }),
      userBlocks({ type: "tool_result", tool_use_id: "t2", is_error: true }),
      assistantBlocks({ type: "text", text: " 저장했어요." }),
      { type: "result" },
    ]),
    h,
  );

  assert.deepEqual(
    calls.acts.map((a) => [a.kind, a.name ?? a.id ?? a.tokens ?? null]),
    [
      ["thinking_tokens", 300],
      ["thinking", null],
      ["tool_use", "Bash"],
      ["tool_result", "t1"],
      ["tool_use", "Write"],
      ["tool_result", "t2"],
    ],
    "활동은 스트림에 나타난 순서 그대로",
  );
  assert.equal(calls.acts[5].isError, true, "실패한 도구는 error 로 보인다");
  assert.deepEqual(calls.deltas, ["작업 폴더를 확인할게요.", " 저장했어요."], "텍스트 스트리밍은 그대로");
  assert.equal(calls.aborted, 0);
}

// ─── 같은 이벤트에서 활동이 텍스트보다 먼저 나온다 ──────────────────────────
// "브라우저로 확인합니다" 라고 말한 뒤에 그 도구 줄이 뜨면 순서가 거꾸로 읽힌다.
{
  const order = [];
  const { h } = handlers({
    onDelta: () => order.push("delta"),
    onActivity: () => order.push("activity"),
  });
  await consumeSdkStream(
    mockStream([
      assistantBlocks(
        { type: "text", text: "브라우저로 확인합니다." },
        { type: "tool_use", id: "t9", name: "Bash", input: { command: "open ." } },
      ),
    ]),
    h,
  );
  assert.deepEqual(order, ["activity", "delta"]);
}

// ─── onActivity 없이도 동작은 이전과 완전히 동일 ────────────────────────────
{
  const { h, calls } = handlers({ onActivity: undefined });
  await consumeSdkStream(
    mockStream([
      assistantBlocks({ type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.html" } }),
      assistantBlocks({ type: "text", text: "끝" }),
    ]),
    h,
  );
  assert.deepEqual(calls.deltas, ["끝"]);
  assert.equal(calls.aborted, 0);
}

// ─── #320 회귀 방지: 401 은 여전히 이벤트 하나 만에 죽는다 ──────────────────
{
  const { h, calls } = handlers();
  const err = await consumeSdkStream(
    mockStream([apiRetry(401), assistantBlocks({ type: "tool_use", id: "t1", name: "Write", input: {} })]),
    h,
  ).then(
    () => null,
    (e) => e,
  );
  assert.equal(err?.name, "FatalAuth", "활동 로그가 붙어도 fast-fail 이 먼저");
  assert.equal(calls.aborted, 1);
  assert.deepEqual(calls.acts, [], "죽은 턴에서는 활동도 새지 않는다");
}

// ─── #403 회귀 방지: 침묵은 여전히 stall 로 끝난다 ──────────────────────────
{
  const { h, calls } = handlers({ stallMs: 40 });
  const silent = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: async () => ({ done: true }) }),
  };
  const err = await consumeSdkStream(silent, h).then(
    () => null,
    (e) => e,
  );
  assert.equal(err?.name, "CoachStallError", "활동 훅이 워치독을 무력화하지 않는다");
  assert.equal(calls.aborted, 1);
  assert.deepEqual(calls.acts, []);
}

// ─── 재시도 틱은 활동으로 보이지 않는다(그래서 여전히 stall 된다) ───────────
{
  const { h, calls } = handlers({ stallMs: 60 });
  const paced = (async function* () {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 10));
      yield apiRetry(529);
    }
  })();
  const err = await consumeSdkStream(paced, h).then(
    () => null,
    (e) => e,
  );
  assert.equal(err?.name, "CoachStallError", "재시도 폭풍은 활동이 아니다 → stall");
  assert.deepEqual(calls.acts, []);
}

console.log("✓ #414: sdk activity — thinking/tool_use/tool_result/thinking_tokens 를 순서대로, 텍스트·fast-fail·stall 무회귀");

// ─── maxTurns 소진은 우리 말로 알린다 ───────────────────────────────────────
{
  const { SDK_MAX_TURNS_FRIENDLY } = await import("../src/sdkCoachHelpers.ts");
  const deltas = [];
  await consumeSdkStream(
    (async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "만드는 중" }] } };
      yield { type: "result", subtype: "error_max_turns", result: "Reached maximum number of turns (20)" };
    })(),
    { isAborted: () => false, makeAbortError: () => new Error("abort"),
      abortQuery: () => {}, makeFatalAuthError: () => new Error("auth"),
      onDelta: (d) => deltas.push(d), stallMs: 0 },
  );
  const joined = deltas.join("");
  assert.ok(joined.includes("파일로 저장돼 있어요"), "예산 소진을 우리 말로 알려야 한다");
  assert.ok(!joined.includes("Reached maximum"), "SDK 영어 원문이 그대로 나가면 안 된다");
  assert.equal(SDK_MAX_TURNS_FRIENDLY.includes("이어서"), true, "다음 행동을 제시해야 한다");

  // 음성 대조군 — 정상 종료(result/success)에는 이 줄이 붙지 않아야 한다.
  const ok = [];
  await consumeSdkStream(
    (async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "다 됐어요" }] } };
      yield { type: "result", subtype: "success", result: "done" };
    })(),
    { isAborted: () => false, makeAbortError: () => new Error("abort"),
      abortQuery: () => {}, makeFatalAuthError: () => new Error("auth"),
      onDelta: (d) => ok.push(d), stallMs: 0 },
  );
  assert.ok(!ok.join("").includes("파일로 저장돼 있어요"), "정상 종료에는 붙지 않아야 한다");
  console.log("✓ maxTurns 소진 — 우리 말 안내 · 정상 종료에는 안 붙음");
}

// ─── 실패한 툴은 이유까지 싣는다 ────────────────────────────────────────────
{
  const { toolResultText } = await import("../src/sdkCoachHelpers.ts");

  // 실패 → reason 이 붙는다. 2026-07-27 에 browser_click 이 두 턴 연속 실패했는데
  // ⚠️ 아이콘만 있고 사유가 없어 소스를 읽어 추정해야 했다.
  const err = extractSdkActivity(
    userBlocks({
      type: "tool_result", tool_use_id: "t1", is_error: true,
      content: [{ type: "text", text: "e12를 찾을 수 없어요. browser_read로 페이지를 다시 읽어 최신 ref를 받아주세요." }],
    }),
  );
  assert.equal(err[0].kind, "tool_result");
  assert.equal(err[0].isError, true);
  assert.ok(err[0].reason.includes("e12를 찾을 수 없어요"), "실패 사유가 실려야 한다");

  // 성공 → reason 없음. 성공 결과는 길고 대부분 노이즈다.
  const ok = extractSdkActivity(
    userBlocks({ type: "tool_result", tool_use_id: "t2", content: "저장했어요 (2.1KB)" }),
  );
  assert.equal(ok[0].isError, false);
  assert.equal(ok[0].reason, undefined, "성공에는 사유를 붙이지 않는다");

  // 문자열 content 도 읽는다 (MCP/SDK 양쪽 모양)
  const strErr = extractSdkActivity(
    userBlocks({ type: "tool_result", tool_use_id: "t3", is_error: true, content: "권한이 없어요" }),
  );
  assert.equal(strErr[0].reason, "권한이 없어요");

  // 음성 대조군 — 뽑을 게 없으면 undefined (빈 문자열로 라벨을 더럽히지 않는다)
  assert.equal(toolResultText(undefined), undefined);
  assert.equal(toolResultText([]), undefined);
  assert.equal(toolResultText([{ type: "image", data: "x" }]), undefined);
  assert.equal(toolResultText("   "), undefined);
  // 길면 자른다
  assert.ok(toolResultText("x".repeat(500)).endsWith("…"));
  console.log("✓ 실패한 툴은 사유까지 · 성공은 안 붙임 · 빈 값은 undefined");
}
