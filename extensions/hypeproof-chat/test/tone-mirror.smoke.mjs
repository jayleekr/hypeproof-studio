// 톤 테이블은 두 곳에 산다 — 그 둘이 어긋나지 않게 잡는다.
//
// 왜 이 TC 가 있나 (2026-08-17 Windows 실기기):
//   "내가 만든 미래" 커리큘럼이 `kids-world` tier 를 새로 썼는데, 톤 판정
//   (`appToneOf`)에 그 tier 가 없어서 **`game` 으로 떨어졌다.** 그 결과 앱이
//   "게임 만드는 중"·"🎮 내 게임"·'채팅에서 "게임 만들어줘"라고 말해보세요'
//   같은 문구를 띄웠다 — 그 커리큘럼은 **"게임" 프레임을 금지**한다
//   ("게임이라는 말을 먼저 꺼내지 마세요"). 프롬프트는 지키는데 앱이 어겼다.
//
//   판정 로직이 두 곳에 있는 것이 원인이다:
//     src/chatPanelHelpers.ts       appToneOf + TONE_LABELS   (확장 호스트)
//     webview-ui/src/ChatPanel.tsx  같은 로직을 손으로 미러링 (웹뷰)
//
//   웹뷰는 `Buffer` 를 쓰는 helpers 를 import 할 수 없어 미러가 **의도적**이다
//   (extension-dev.md "Boundaries"). 그래서 없앨 수는 없고, **어긋나면 잡는다.**
//
// 앱을 띄우지 않고 소스만 읽으므로 밀리초에 끝난다.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appToneOf, TONE_LABELS } from "../src/chatPanelHelpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webview = readFileSync(join(here, "..", "webview-ui", "src", "ChatPanel.tsx"), "utf8");

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log(`  ok   ${name}`);
};

console.log("=== 1. tier → tone 매핑이 실제로 도는가 ===");

const TIER_TO_TONE = [
  ["search-webapp", "search"],
  ["website", "site"],
  ["kids-world", "world"],
  ["kids-basic", "game"],
  ["kids-rich", "game"],
  [undefined, "game"],
];
for (const [tier, expected] of TIER_TO_TONE) {
  t(`${tier ?? "(없음)"} → ${expected}`, () => {
    assert.equal(appToneOf({ game: { template_tier: tier } }), expected);
  });
}

console.log("");
console.log("=== 2. 웹뷰 미러가 모든 tier 를 안다 ===");
// helpers 가 분기하는 tier 문자열은 웹뷰에도 반드시 나타나야 한다.
for (const [tier] of TIER_TO_TONE.filter(([x]) => x && x !== "kids-basic" && x !== "kids-rich")) {
  t(`웹뷰가 "${tier}" 를 분기한다`, () => {
    assert.ok(webview.includes(`"${tier}"`), `ChatPanel.tsx 에 ${tier} 분기가 없다`);
  });
}

console.log("");
console.log("=== 3. 웹뷰 미러의 문구가 TONE_LABELS 와 일치한다 ===");
for (const [tone, labels] of Object.entries(TONE_LABELS)) {
  t(`${tone}: buildingLabel "${labels.buildingLabel}"`, () => {
    assert.ok(
      webview.includes(`"${labels.buildingLabel}"`),
      `ChatPanel.tsx 에 ${tone} 의 buildingLabel 이 없다 — 미러가 어긋났다`,
    );
  });
  t(`${tone}: namingEmoji ${labels.namingEmoji}`, () => {
    assert.ok(
      webview.includes(`"${labels.namingEmoji}"`),
      `ChatPanel.tsx 에 ${tone} 의 namingEmoji 가 없다 — 미러가 어긋났다`,
    );
  });
}

console.log("");
console.log('=== 4. "게임" 프레임 금지 트랙에 게임 어휘가 새지 않는다 ===');
t("world 톤 문구 어디에도 '게임'/🎮 이 없다", () => {
  const world = JSON.stringify(TONE_LABELS.world);
  assert.ok(!world.includes("게임"), `world 톤에 "게임" 이 있다: ${world}`);
  assert.ok(!world.includes("🎮"), `world 톤에 🎮 가 있다: ${world}`);
});

console.log("");
console.log(`PASS — tone mirror ${n}건`);
