// kids-quest — 아이의 말 → 사전 완성 세상 매칭 (matchWorldRef). 워커 worlds.ts 와 같은 규칙.
import assert from "node:assert/strict";
const { matchWorldRef } = await import("../src/chatPanelHelpers.ts");
const W = [
  { id: "kq-catcher", guest: "초코", emoji: "🐕", chip: "🐕 초코 세상에 가볼래", aliases: ["강아지"] },
  { id: "kq-runner", guest: "나비", emoji: "🐈", chip: "🐈 나비 세상에 가볼래", aliases: ["고양이"] },
];
assert.equal(matchWorldRef("🐕 초코 세상에 가볼래", W)?.id, "kq-catcher");
assert.equal(matchWorldRef("초코 세상에 가볼래", W)?.id, "kq-catcher");
assert.equal(matchWorldRef("고양이 세상 보여줘", W)?.id, "kq-runner");
assert.equal(matchWorldRef("나비 얘기 들려줘", W)?.id, "kq-runner");
assert.equal(matchWorldRef("초코를 갈색으로 바꿔줘", W), null, "바꾸기 요청은 매칭 안 됨");
assert.equal(matchWorldRef("안녕", W), null);
assert.equal(matchWorldRef("초코 세상", undefined), null);
console.log("✓ matchWorldRef 7건");
