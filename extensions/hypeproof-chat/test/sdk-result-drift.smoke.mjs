// #749 — 벤더 SDK 의 종료 오류 표면과 우리 처리가 어긋나지 않게 잠근다.
//
// 왜 필요한가. `consumeSdkStream` 은 `{type:"result", subtype:"error_max_turns"}`
// 하나만 처리하고 있었다. 벤더 타입(`sdk.d.ts` 의 `SDKResultError`)은 subtype 을
// **넷** 선언한다. 나머지 셋은 delta 도 안내도 없이 떨어져, 학생 화면에는 그냥
// 멈춘 턴이 남았다 — 그 분기 바로 위 주석이 "조용히 끝나면 안 된다" 라고 적어 둔
// 바로 그 실패가 넷 중 셋에 대해 열려 있었다.
//
// 이 파일은 두 가지를 잰다:
//   1. 벤더가 선언한 **모든** 종료 오류 subtype 이 학생용 안내를 만든다 (침묵 금지)
//   2. 우리가 분기하는 문자열이 벤더 타입에 실재한다 (죽은 분기 감지)
//
// 벤더 `.d.ts` 를 읽는 이유는 그것이 이 머신에 **실제로 설치된 버전**의 계약이기
// 때문이다. 우리가 기억하는 목록이 아니라 배포되는 물건을 대조한다.
//
// Run: node --experimental-strip-types test/sdk-result-drift.smoke.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const {
  SDK_MAX_TURNS_FRIENDLY,
  SDK_RESULT_ERROR_FALLBACK,
  SDK_RESULT_ERROR_FRIENDLY,
  consumeSdkStream,
  sdkResultNotice,
} = await import("../src/sdkCoachHelpers.ts");

const handlers = (deltas) => ({
  isAborted: () => false,
  makeAbortError: () => new Error("abort"),
  abortQuery: () => {},
  makeFatalAuthError: () => new Error("auth"),
  onDelta: (d) => deltas.push(d),
  stallMs: 0,
});
const runResult = async (msg) => {
  const deltas = [];
  await consumeSdkStream((async function* () { yield msg; })(), handlers(deltas));
  return deltas.join("");
};

// ─── 벤더가 선언한 subtype 을 실제 .d.ts 에서 읽는다 ──────────────────────────
const dts = join(here, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.d.ts");
let declared = null;
if (existsSync(dts)) {
  const src = readFileSync(dts, "utf8");
  // `export declare type SDKResultError = { type: 'result'; subtype: 'a' | 'b'; …`
  const block = /SDKResultError\s*=\s*\{[\s\S]*?\}/.exec(src);
  assert.ok(block, "SDKResultError 선언을 찾지 못했다 — 벤더가 이름을 바꿨다면 이 테스트부터 고쳐야 한다");
  const line = /subtype:\s*([^;]+);/.exec(block[0]);
  assert.ok(line, "SDKResultError 에 subtype 필드가 없다");
  declared = [...line[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(declared.length >= 1, "subtype union 을 하나도 못 읽었다");
  // 처음 이 표면을 볼 때 넷이었다. 늘거나 줄면 알아야 한다 — 늘어난 쪽은 폴백이
  // 받아내지만, 무엇이 늘었는지는 사람이 봐야 문구를 정할 수 있다.
  assert.ok(
    declared.includes("error_max_turns") && declared.includes("error_during_execution"),
    `알던 subtype 이 사라졌다: ${declared.join(", ")}`,
  );
} else {
  // 벤더 트리가 없는 체크아웃(패키징 빌드 등)에서는 이 대조를 건너뛴다. 아래
  // 동작 단언은 그대로 돈다 — 건너뛰는 것은 "벤더가 뭐라 하는지" 뿐이다.
  console.log("  (벤더 sdk.d.ts 없음 — 선언 대조는 건너뛴다)");
}

// ─── 1. 선언된 어떤 subtype 도 침묵을 만들지 않는다 ──────────────────────────
{
  const subtypes = declared ?? [
    "error_during_execution", "error_max_turns",
    "error_max_budget_usd", "error_max_structured_output_retries",
  ];
  for (const subtype of subtypes) {
    const notice = sdkResultNotice({ type: "result", subtype, is_error: true });
    assert.ok(notice, `${subtype} 이 안내 없이 끝난다 — 학생에게는 그냥 멈춘 턴이다`);
    assert.match(notice, /파일로 저장돼 있어요/, `${subtype}: 한 일이 남아 있다는 사실을 말해야 한다`);
    // SDK 원문(영어)이 새어나가면 참가자에게는 고장으로 보인다.
    assert.doesNotMatch(notice, /[A-Za-z]{6,}/, `${subtype}: 영어 원문/식별자가 학생 화면에 나가면 안 된다`);

    // 그리고 그 안내가 실제 스트림에서도 나가야 한다 — 판정기만 맞고 배선이
    // 빠지면 아무 소용이 없다.
    const emitted = await runResult({ type: "result", subtype, is_error: true });
    assert.equal(emitted, notice, `${subtype}: 스트림이 판정기와 같은 줄을 내보내야 한다`);
  }
}

// ─── 2. 아는 subtype 은 각자의 문구를 받는다 ────────────────────────────────
{
  assert.equal(sdkResultNotice({ type: "result", subtype: "error_max_turns" }), SDK_MAX_TURNS_FRIENDLY);
  for (const [subtype, text] of Object.entries(SDK_RESULT_ERROR_FRIENDLY)) {
    assert.equal(sdkResultNotice({ type: "result", subtype }), text, `${subtype} 전용 문구`);
    assert.notEqual(text, SDK_RESULT_ERROR_FALLBACK, `${subtype} 은 폴백이 아니라 자기 문구를 가져야 한다`);
  }
  // 문구가 서로 달라야 한다 — 넷이 같은 줄이면 무슨 일이 있었는지 알 수 없다.
  const all = [SDK_MAX_TURNS_FRIENDLY, ...Object.values(SDK_RESULT_ERROR_FRIENDLY)];
  assert.equal(new Set(all).size, all.length, "종료 사유마다 다른 문구여야 한다");
}

// ─── 3. 모르는 subtype 은 폴백으로 — 열거가 다시 뚫리지 않게 ────────────────
// 이것이 열거로 끝내지 않은 이유다. SDK 가 다섯 번째를 추가해도 침묵은 없다.
{
  assert.equal(
    sdkResultNotice({ type: "result", subtype: "error_something_new_in_2027" }),
    SDK_RESULT_ERROR_FALLBACK,
  );
  // 이름 규칙이 바뀌어도 `is_error` 가 잡는다 — 둘 중 하나만 맞아도 안내가 나간다.
  assert.equal(
    sdkResultNotice({ type: "result", subtype: "budget_exhausted", is_error: true }),
    SDK_RESULT_ERROR_FALLBACK,
  );
  assert.equal(await runResult({ type: "result", subtype: "error_unknown", is_error: true }),
    SDK_RESULT_ERROR_FALLBACK, "미지 subtype 도 스트림에서 안내가 나가야 한다");
}

// ─── 4. 음성 대조군 — 정상 종료는 아무 줄도 붙이지 않는다 ───────────────────
// 이게 없으면 "모든 턴 끝에 오류 안내를 붙이는" 구현이 위 단언을 전부 통과한다.
{
  for (const msg of [
    { type: "result", subtype: "success" },
    { type: "result", subtype: "success", is_error: false },
    { type: "result" },
    { type: "assistant", message: { content: [{ type: "text", text: "다 됐어요" }] } },
    { type: "system", subtype: "init" },
  ]) {
    assert.equal(sdkResultNotice(msg), null, `정상 이벤트에 안내가 붙었다: ${JSON.stringify(msg)}`);
  }

  const normal = await runResult({ type: "result", subtype: "success" });
  assert.equal(normal, "", "정상 종료에는 아무 줄도 붙지 않는다");

  const withText = [];
  await consumeSdkStream(
    (async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "다 됐어요" }] } };
      yield { type: "result", subtype: "success" };
    })(),
    handlers(withText),
  );
  assert.equal(withText.join(""), "다 됐어요", "정상 턴의 본문이 그대로 나가고 군더더기가 없다");
}

// ─── 5. 우리가 분기하는 문자열이 벤더에 실재하는가 (죽은 분기 감지) ─────────
// `consumeSdkStream` 은 `text` 와 `content_block_delta` 최상위 타입에도 분기한다.
// 실측(2026-07 두 런) 0건이었고 벤더 타입에도 없다 — 방어 분기로 남기되, 그
// 사실을 여기 적어 둔다. 나중에 누군가 "이건 왜 있지" 를 물을 때의 답이다.
if (declared) {
  const src = readFileSync(dts, "utf8");
  for (const t of ["assistant", "result", "system"]) {
    assert.ok(src.includes(`'${t}'`), `벤더가 더 이상 '${t}' 이벤트를 선언하지 않는다`);
  }
  for (const t of ["text", "content_block_delta"]) {
    // 있으면 좋고, 없어도 방어 분기이므로 실패시키지 않는다. 상태만 남긴다.
    if (!src.includes(`'${t}'`)) console.log(`  (참고: '${t}' 는 벤더 타입에 없다 — 방어 분기)`);
  }
}

console.log("sdk-result-drift smoke OK");
