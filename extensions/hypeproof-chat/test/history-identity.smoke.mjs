// #747 (AE-08) — 기록은 소급해서 다시 쓰이지 않는다.
//
// 고치기 전 상태: 답변 줄이 전부 살아 있는 `coachName` 하나를 렌더했다. 아동
// 코호트 둘 다 `naming_mode: "user_names_it"` 이라, 아이가 수업 중간에 이름을
// 바꾸면 **그 전에 코치가 한 말까지 새 이름이 한 것으로** 바뀌었다. 증거 기반
// 관찰을 표방하는 제품에서 기록이 스스로를 고치는 상태였다.
//
// 이 파일이 잠그는 것:
//   1. 저장된 이름이 있으면 그것을 쓴다 (이름을 바꿔도 과거가 안 따라온다)
//   2. 없으면 살아 있는 이름으로 떨어진다 (이전 줄·스트리밍 중 말풍선)
//   3. user·tool 줄에는 절대 안 붙는다
//   4. 호스트가 실제로 찍는다 — 그리고 **런타임에 넘긴 값**을 찍는다
//
// Run: node --experimental-strip-types test/history-identity.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(here, "..", ...p), "utf8");

// 웹뷰는 별도 vite 앱이고 호스트는 vscode 결합이라 둘 다 단독 import 가 안 된다.
// 그래서 렌더 규칙은 소스로 잠그고, **순수하게 뽑아낼 수 있는 판정**은 아래에서
// 실제로 실행한다(regex 로 긁고 끝내지 않는다).
const panel = src("webview-ui", "src", "ChatPanel.tsx");
const host = src("src", "chatPanelProvider.ts");
const protocol = src("src", "protocol.ts");

// ─── 렌더 규칙을 실행 가능한 형태로 옮겨와 확인한다 ─────────────────────────
// ChatPanel 의 한 줄과 같은 식. 소스 단언(아래 §5)이 이 미러가 실물과 갈라지지
// 않도록 잡는다.
const roleLabel = (message, coachName) =>
  message.role === "user" ? "나" : message.assistantName ?? coachName;

// ─── 1. 이름을 바꿔도 과거가 따라오지 않는다 ────────────────────────────────
{
  const history = [
    { id: "1", role: "user", content: "안녕", createdAt: 1 },
    { id: "2", role: "assistant", content: "반가워", createdAt: 2, assistantName: "별똥별" },
    { id: "3", role: "user", content: "이름 바꿀래", createdAt: 3 },
    { id: "4", role: "assistant", content: "좋아", createdAt: 4, assistantName: "무지개" },
  ];
  // 지금 화면의 이름은 "무지개" 다. 그래도 2번 줄은 별똥별이 한 말이다.
  assert.equal(roleLabel(history[1], "무지개"), "별똥별", "이름을 바꿔도 과거 답변은 그대로다");
  assert.equal(roleLabel(history[3], "무지개"), "무지개");
  assert.equal(roleLabel(history[0], "무지개"), "나");

  // 한 배열 안에 서로 다른 정체성이 공존한다 — 이게 기록이 보존됐다는 뜻이다.
  const names = history.filter((m) => m.role === "assistant").map((m) => roleLabel(m, "무지개"));
  assert.deepEqual(names, ["별똥별", "무지개"]);
}

// ─── 2. 없으면 살아 있는 이름으로 (이전 줄 · 스트리밍 중) ───────────────────
// 이 폴백이 "구버전 호환" 이자 이 변경이 기존 화면을 안 건드린다는 보장이다.
{
  const legacy = { id: "9", role: "assistant", content: "예전 답변", createdAt: 1 };
  assert.equal(roleLabel(legacy, "무지개"), "무지개", "저장된 이름이 없으면 살아 있는 이름");

  // 기본 좌석 — 찍힌 이름이 기본값과 같으면 출력이 오늘과 **바이트 동일**하다.
  // 너무 엄격한 구현(예: 항상 스탬프를 요구)이 여기서 걸린다.
  const stamped = { id: "10", role: "assistant", content: "x", createdAt: 1, assistantName: "코치" };
  assert.equal(roleLabel(stamped, "코치"), roleLabel({ ...stamped, assistantName: undefined }, "코치"));
}

// ─── 3. user·tool 줄에는 붙지 않는다 (음성 대조군) ──────────────────────────
// 이게 없으면 "모든 줄에 이름을 찍는" 구현이 위를 전부 통과한다.
{
  assert.equal(roleLabel({ role: "user", assistantName: "별똥별" }, "무지개"), "나",
    "user 줄은 스탬프가 있어도 '나' 다");

  // 호스트는 assistant 줄에만 찍는다.
  assert.match(host, /m\.role === "assistant" \? \{ \.\.\.m, assistantName \} : m/,
    "스탬프는 assistant 줄에만 붙는다");
}

// ─── 4. 호스트가 실제로 찍는가 — 그리고 무엇을 찍는가 ──────────────────────
// 렌더가 맞아도 아무도 안 찍으면 전부 폴백으로 떨어져 오늘과 똑같아진다.
{
  assert.match(host, /assistantName\?: string,/, "finishTurnItems 가 이름을 받는다");

  // **런타임에 넘긴 값**을 찍어야 한다. 여기서 다시 해석하면(coachDisplayName())
  // 이름을 바꾼 뒤 과거가 따라 바뀌는 지금 동작이 그대로 남는다.
  assert.match(
    host,
    /finishTurnItems\(\s*streamId,\s*messageId,\s*assistantText,\s*assistantCitations,\s*effectiveCoachName,/,
    "커밋 지점이 그 턴을 돌린 이름을 넘긴다",
  );

  // 앱이 직접 쓴 답변 두 곳도 찍는다 — 화면에는 똑같이 코치 이름으로 붙는다.
  assert.equal(
    (host.match(/assistantName: this\.coachDisplayName\(\)/g) || []).length,
    2,
    "앱이 만든 답변(보여주기·게스트 목록)도 이름을 남긴다",
  );
}

// ─── 5. 드리프트 락 — 위 미러가 실물과 갈라지지 않게 ────────────────────────
{
  assert.match(
    panel,
    /message\.role === "user" \? "나" : message\.assistantName \?\? coachName/,
    "웹뷰가 저장된 이름을 우선하고 없을 때만 살아 있는 이름을 쓴다",
  );
  // 고치기 전의 조건이 남아 있으면 안 된다.
  assert.doesNotMatch(
    panel,
    /\{message\.role === "user" \? "나" : coachName\}/,
    "살아 있는 이름만 렌더하던 옛 줄이 남아 있다",
  );
  // 계약이 타입에 적혀 있다.
  assert.match(protocol, /assistantName\?: string;/, "ChatMessage 가 정체성을 들고 다닌다");
}

// ─── 6. 순수 모듈은 이 관심사를 모른다 ──────────────────────────────────────
// chatTimeline 은 vscode 없는 순수 모듈이다. 정체성을 거기 넣으면 타임라인이
// 표시 관심사를 알게 되고, 그 다음 사람이 렌더 시점에 다시 해석하고 싶어진다.
{
  const timeline = src("src", "chatTimeline.ts");
  assert.doesNotMatch(timeline, /assistantName/, "타임라인은 정체성을 모른다 — 나가는 길에 찍는다");
}

console.log("history-identity smoke OK");
