// 침묵 안내 줄이 **지어낸 성공**으로 닫히지 않는가 (R0).
//
// #628 이 3분짜리 침묵을 메우려고 `✍️ 고치는 중…` 줄을 넣었는데, 닫을 때 무조건
// "고쳤어요" 를 적었다. 실기기에서 관측(2026-08-20): 아이가 "웹서치로 가져와봐"
// → 코치가 "저는 웹 검색 기능이 없어요" 로 거절 → 그 위에 `✍️ 고쳤어요 ✓`.
// 아이는 그 줄을 보고 화면을 본다. 안 바뀌어 있으면 그게 최악의 실패다.
//
// Run: node --experimental-strip-types test/pending-label.smoke.mjs

import assert from "node:assert/strict";

const { pendingCloseLabel, WRITE_TOOL_NAMES } = await import("../src/chatPanelHelpers.ts");

// ── 양성: 쓰기가 성공한 턴만 "고쳤어요" ────────────────────────────────────
assert.equal(pendingCloseLabel(true), "고쳤어요");
console.log("✓ 양성 — 쓰기 성공 → 고쳤어요");

// ── 음성: 아무것도 안 고친 턴은 고쳤다고 하지 않는다 ────────────────────────
const idle = pendingCloseLabel(false);
assert.notEqual(idle, "고쳤어요");
assert.ok(!/고쳤|바꿨|저장|완성|다 됐/.test(idle), `안 고친 턴의 문구가 성공을 주장한다: ${idle}`);
assert.ok(idle.length > 0, "빈 문구는 안 된다 — 줄을 지울 방법이 없으므로 무엇이라도 사실을 적어야 한다");
console.log(`✓ 음성 — 쓰기 없음 → "${idle}" (성공 주장 없음)`);

// ── 판정 근거가 되는 도구 집합이 실물과 일치하는가 (드리프트 락) ────────────
// 이 목록이 SDK 가 실제로 주는 쓰기 도구와 어긋나면, 고쳤는데 "생각했어요" 로
// 닫히거나(과소) 안 고쳤는데 "고쳤어요" 로 닫힌다(과대 — 이쪽이 나쁘다).
const SDK_WRITE = ["Write", "Edit", "MultiEdit"];
assert.deepEqual([...WRITE_TOOL_NAMES].sort(), [...SDK_WRITE].sort(),
  "WRITE_TOOL_NAMES 가 sdkCoachHelpers 의 SDK_WRITE_TOOL_NAMES 와 어긋났다");
console.log("✓ 드리프트 락 — 쓰기 도구 집합 일치");

// ── 심은 정답 대비: 실제 턴 흐름을 재생해 본다 ──────────────────────────────
// 열린 텍스트를 긁는 대신 시나리오를 심고 결과를 센다(verification.md 규칙 3).
const replay = (events) => {
  let wroteOk = false;
  const writeIds = new Set();
  for (const e of events) {
    if (e.kind === "tool_use" && WRITE_TOOL_NAMES.includes(e.name)) writeIds.add(e.id);
    if (e.kind === "tool_result" && !e.isError && writeIds.has(e.id)) wroteOk = true;
  }
  return pendingCloseLabel(wroteOk);
};

const CASES = [
  { name: "Read 만 하고 거절", events: [
    { kind: "tool_use", id: "1", name: "Read" },
    { kind: "tool_result", id: "1", isError: false },
  ], want: "생각했어요" },
  { name: "Edit 성공", events: [
    { kind: "tool_use", id: "1", name: "Edit" },
    { kind: "tool_result", id: "1", isError: false },
  ], want: "고쳤어요" },
  { name: "Edit 실패", events: [
    { kind: "tool_use", id: "1", name: "Edit" },
    { kind: "tool_result", id: "1", isError: true },
  ], want: "생각했어요" },
  { name: "Edit 실패 후 재시도 성공", events: [
    { kind: "tool_use", id: "1", name: "Edit" },
    { kind: "tool_result", id: "1", isError: true },
    { kind: "tool_use", id: "2", name: "Edit" },
    { kind: "tool_result", id: "2", isError: false },
  ], want: "고쳤어요" },
  { name: "도구를 아예 안 씀 (거절·되묻기)", events: [], want: "생각했어요" },
  { name: "MultiEdit 성공", events: [
    { kind: "tool_use", id: "1", name: "MultiEdit" },
    { kind: "tool_result", id: "1", isError: false },
  ], want: "고쳤어요" },
];

for (const c of CASES) {
  const got = replay(c.events);
  assert.equal(got, c.want, `${c.name}: ${got} (기대 ${c.want})`);
  console.log(`✓ ${c.name} → ${got}`);
}

console.log("\npending-label smoke: ok");
