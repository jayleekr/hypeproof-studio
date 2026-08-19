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

// 2026-08-19 — 이름만/이모지만도 잡아야 한다(빠른 GET 경로). 별칭 오매칭 금지.
const { isGuestListRequest, guestListMessage } = await import("../src/chatPanelHelpers.ts");
const W2 = [
  { id: "kq-jump", guest: "도토", emoji: "🐿️", chip: "🐿️ 도토 세상에 가볼래", aliases: ["다람쥐", "나무"], line: "가지가 부러져 위로 못 올라가" },
  { id: "kq-run", guest: "찍찍", emoji: "🐁", chip: "🐁 찍찍 세상에 가볼래", aliases: ["생쥐", "하수구"], line: "캄캄한데 뒤에서 물이 밀려와" },
];
assert.equal(matchWorldRef("도토", W2)?.id, "kq-jump", "이름만");
assert.equal(matchWorldRef("도토!", W2)?.id, "kq-jump", "이름 + 감탄");
assert.equal(matchWorldRef("🐿️", W2)?.id, "kq-jump", "이모지만");
assert.equal(matchWorldRef("다람쥐 세상", W2)?.id, "kq-jump", "별칭 — '쥐' 가 '다람쥐' 를 먹지 않는다");
assert.equal(matchWorldRef("도토한테 가자", W2)?.id, "kq-jump");
assert.equal(matchWorldRef("도토를 갈색으로 바꿔줘", W2), null, "바꾸기 요청은 세상 전환이 아니다");
assert.ok(isGuestListRequest("다른 친구도 있어?") && isGuestListRequest("또 누구 있어?"));
assert.ok(!isGuestListRequest("불덩이 대신 아이스크림 떨어지게 해줘"));
assert.ok(guestListMessage(W2).includes("도토") && guestListMessage(W2).includes("가지가 부러져"));
console.log("✓ 이름만·이모지만 매칭 · 별칭 경계 · 게스트 목록 즉답 9건");
