// #607 — 채팅 패널의 상시 "기록 보내기" 진입점 (REQ-Q9).
//
// 왜 실기기여야 하나: 소스 락(extensions/hypeproof-chat/test/session-upload-
// entrypoint.smoke.mjs)은 "조건이 이 값을 본다"까지만 증명한다. 아이가 실제로
// **볼 수 있는가**와 **누르면 기존 커맨드에 닿는가**는 렌더된 웹뷰에서만
// 확인된다 — 팔레트를 못 쓰는 코호트에게는 그게 기능의 전부다.
//
// 전제: `bash scripts/dev-stack.sh` 기본값(초3·4 트랙, opt-in ON) + 이 브랜치의
// 확장이 들어간 앱(HPS_APP_PATH 로 개발 실행기 앱을 가리킬 수 있다).
//
//   HPS_APP_PATH="$HOME/Studio-Dev-607/HypeProof Studio Dev.app" \
//     npx playwright test tests/28-upload-entrypoint.spec.ts
//
// 클릭의 도착 증거로 "테스트 실행에서는…" 토스트를 쓴다. e2e 런은
// HPS_TEST_E2E=1 이라 스풀이 없고(extension.ts `isTestRun`), 커맨드의 첫
// 분기가 정확히 그 문구다 — 즉 이 토스트는 **그 커맨드가 실행됐다는 것**
// 자체이고, 실제 업로드는 일어나지 않는다.

import { test, expect } from "@playwright/test";
import { chatFrame, closeApp, launchApp } from "../fixtures/app";

const UPLOAD_BTN = "button.hps-upload-btn";

test("REQ-Q9: opt-in 코호트의 패널에 상시 기록 보내기 버튼이 있고, 누르면 기존 커맨드가 돈다", async () => {
  const ctx = await launchApp({ preseedToken: true, preseedCoach: { name: "코디" } });
  try {
    const cf = await chatFrame(ctx.win);

    // 프로필이 도착해야 게이트가 열린다 — config 는 ready 직후 비동기로 온다.
    const btn = cf.locator(UPLOAD_BTN);
    await expect(btn).toBeVisible({ timeout: 20_000 });

    // 상시여야 한다: 헤더는 메시지 목록과 함께 스크롤되지 않는 유일한 줄이다.
    // 배너처럼 사라지는 진입점이면 #607 이 그대로 남는다.
    await expect(cf.locator("header.hps-header " + UPLOAD_BTN)).toHaveCount(1);
    await expect(btn).toContainText("기록 보내기");

    await btn.click();

    // 호스트 커맨드에 닿았다는 증거. (팔레트로 부른 것과 같은 커맨드다.)
    await expect(ctx.win.locator(".notifications-toasts")).toContainText(
      "테스트 실행에서는 세션 기록을 남기지 않아요",
      { timeout: 15_000 },
    );
  } finally {
    await closeApp(ctx);
  }
});
