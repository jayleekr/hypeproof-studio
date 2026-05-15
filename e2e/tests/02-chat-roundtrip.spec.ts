// Golden path: launch (token pre-seeded via env) → autoOnboard opens chat
// panel → type "안녕" → assistant reply streams in.

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, chatFrame } from "../fixtures/app.ts";

test("chat roundtrip: 안녕 → HypeProof Coach reply", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "테스트코치", personality: "" },
  });
  const { win } = ctx;
  try {
    // autoOnboard sees the pre-seeded token in SecretStorage, opens the chat
    // container, and does NOT pop the setToken input box. The chat webview
    // should resolve on its own.

    // ---- 1. Wait for the chat webview's React shell to mount ---------------
    const cf = await chatFrame(win);
    const shell = cf.locator(".hps-shell");
    await shell.waitFor({ state: "visible", timeout: 25_000 });

    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.waitFor({ state: "visible", timeout: 5_000 });

    // ---- 2. Send "안녕" -----------------------------------------------------
    await textarea.fill("안녕");
    await textarea.press("Enter");

    // The user message should appear immediately in the message list.
    await expect(cf.locator(".hps-msg-user .hps-msg-body").last()).toContainText("안녕");

    // ---- 3. Wait for assistant message to stream in -----------------------
    const assistant = cf.locator(".hps-msg-assistant .hps-msg-body").last();
    await expect(assistant).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      const t = (await assistant.textContent()) ?? "";
      expect(t.length).toBeGreaterThan(2);
      expect(/[가-힣]/.test(t)).toBeTruthy();
    }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });

    // ---- 4. Save evidence -------------------------------------------------
    await win.screenshot({ path: "test-results/chat-success.png", fullPage: true });
  } finally {
    await closeApp(ctx);
  }
});
