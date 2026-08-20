// kids-quest — 세상 전환은 **클릭만** (#649, 2026-08-20). 칩 문구 정확일치만 매칭한다.
// 워커 worlds.ts 의 matchWorld 와 같은 규칙 — 한쪽만 고치면 앱과 워커가 갈라진다.
import assert from "node:assert/strict";
const { matchWorldRef } = await import("../src/chatPanelHelpers.ts");
const W = [
  { id: "kq-catcher", guest: "초코", emoji: "🐕", chip: "🐕 초코 세상에 가볼래", aliases: ["강아지"] },
  { id: "kq-runner", guest: "나비", emoji: "🐈", chip: "🐈 나비 세상에 가볼래", aliases: ["고양이"] },
];
// 칩 문구 — 이모지 포함형/미포함형 두 가지만 통과한다(버튼이 보내는 문구 그대로).
assert.equal(matchWorldRef("🐕 초코 세상에 가볼래", W)?.id, "kq-catcher");
assert.equal(matchWorldRef("초코 세상에 가볼래", W)?.id, "kq-catcher");
assert.equal(matchWorldRef("🐈 나비 세상에 가볼래", W)?.id, "kq-runner");
assert.equal(matchWorldRef("  🐕 초코 세상에 가볼래  ", W)?.id, "kq-catcher", "앞뒤 공백은 무시");
// 느슨한 매칭은 전부 사라졌다.
assert.equal(matchWorldRef("고양이 세상 보여줘", W), null, "별칭 매칭 없음");
assert.equal(matchWorldRef("나비 얘기 들려줘", W), null, "이름 매칭 없음");
assert.equal(matchWorldRef("초코를 갈색으로 바꿔줘", W), null);
assert.equal(matchWorldRef("안녕", W), null);
assert.equal(matchWorldRef("초코 세상", undefined), null);
console.log("✓ matchWorldRef — 칩 정확일치만 9건");

// 2026-08-20 (#649) 실기기 사고 재현 케이스. 이 두 줄이 세상을 열면 안 된다:
// ① 다른 세상으로 튀고 ② 원본을 다시 받아 아이가 고친 index.html 을 덮어쓴다.
const { isGuestListRequest, guestListMessage } = await import("../src/chatPanelHelpers.ts");
const W2 = [
  { id: "kq-jump", guest: "도토", emoji: "🐿️", chip: "🐿️ 도토 세상에 가볼래", aliases: ["다람쥐", "나무"], line: "가지가 부러져 위로 못 올라가" },
  { id: "kq-run", guest: "찍찍", emoji: "🐁", chip: "🐁 찍찍 세상에 가볼래", aliases: ["생쥐", "하수구"], line: "캄캄한데 뒤에서 물이 밀려와" },
  { id: "kq-catcher", guest: "초코", emoji: "🐕", chip: "🐕 초코 세상에 가볼래", aliases: ["강아지"], line: "마당이 너무 뜨거워" },
];
assert.equal(matchWorldRef("초코 세상에 다람쥐 데려와줘", W2), null, "다른 세상으로 튀지 않는다");
assert.equal(matchWorldRef("초코 세상에 불 대신 물", W2), null, "원본을 다시 받아 덮어쓰지 않는다");
assert.equal(matchWorldRef("도토", W2), null, "이름만으로는 안 바뀐다 — 버튼으로만");
assert.equal(matchWorldRef("🐿️", W2), null, "이모지만으로도 안 바뀐다");
assert.equal(matchWorldRef("다람쥐 세상", W2), null, "별칭도 안 잡는다");
assert.equal(matchWorldRef("🐿️ 도토 세상에 가볼래", W2)?.id, "kq-jump", "버튼 문구는 여전히 잡는다");
// 게스트 목록 즉답은 유지 — 다만 문구는 타이핑이 아니라 클릭을 가리킨다.
assert.ok(isGuestListRequest("다른 친구도 있어?") && isGuestListRequest("또 누구 있어?"));
assert.ok(!isGuestListRequest("불덩이 대신 아이스크림 떨어지게 해줘"));
const listed = guestListMessage(W2);
assert.ok(listed.includes("도토") && listed.includes("가지가 부러져"));
// 2026-08-20 검토 — 이 답변은 대화 타임라인의 말풍선이고, 친구 스트립은 작성란
// 위(=말풍선보다 **아래**)에 있다. "위 …👆" 는 지나간 대화를 가리켰다.
assert.ok(listed.includes("아래 친구 버튼을 눌러요 👇"), "이름을 타이핑하게 두면 세상이 안 열린다");
assert.ok(!listed.includes("위 친구 버튼"), "화살표가 지나간 대화를 가리키던 옛 문구");
assert.ok(!listed.includes("누구 세상에 가볼까요"), "타이핑을 유도하던 옛 문구는 사라졌다");
console.log("✓ 타이핑 전환 차단 · 게스트 목록은 클릭 유도 12건");

// ─── 호스트-웹뷰 계약: 칩 문구를 한 글자도 다듬지 않는다 ────────────────────
// 세상 전환의 유일한 통로다. 누군가 handleWorldPick 에서 trim/이모지 제거를 하거나
// 버튼이 다른 문자열을 보내면 matchWorldRef(정확일치)가 영영 안 잡는데, 순수 함수
// 테스트로는 그것을 볼 수 없다 — 그래서 배선을 문자열로 잠근다.
{
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const panel = readFileSync(join(here, "..", "webview-ui", "src", "ChatPanel.tsx"), "utf8");
  assert.ok(panel.includes("onPick(w.chip)"), "친구 버튼이 칩 문구 원문을 보내지 않는다");
  assert.ok(panel.includes("props.onSend(chip)"), "handleWorldPick 이 칩을 그대로 보내지 않는다");
  console.log("✓ 칩 문구 원문 전달 계약 2건");
}
