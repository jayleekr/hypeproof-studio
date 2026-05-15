// Retry button regenerates a fresh assistant response. Roll-input button
// captures original + appends a follow-up, sending the combined prompt.

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, chatFrame } from "../fixtures/app.ts";

test("retry button regenerates an assistant message", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "테스트코치" },
  });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });

    // Send first message
    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.fill("간단히 인사해줘");
    await textarea.press("Enter");

    const assistant1 = cf.locator(".hps-msg-assistant .hps-msg-body").nth(0);
    await expect(assistant1).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      const t = (await assistant1.textContent()) ?? "";
      expect(t.length).toBeGreaterThan(2);
    }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });

    // Click retry on the assistant message
    const retryBtn = cf.locator(".hps-msg-retry").first();
    await expect(retryBtn).toBeVisible({ timeout: 5_000 });
    await retryBtn.click();

    // A second assistant message appears
    const assistant2 = cf.locator(".hps-msg-assistant .hps-msg-body").nth(1);
    await expect(assistant2).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      const t = (await assistant2.textContent()) ?? "";
      expect(t.length).toBeGreaterThan(2);
    }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });
  } finally {
    await closeApp(ctx);
  }
});

test("roll-input button shows expansion banner and sends combined prompt", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "테스트코치" },
  });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });

    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.fill("게임");

    // Click the roll-input button
    const rollBtn = cf.locator(".hps-btn-roll");
    await expect(rollBtn).toBeVisible({ timeout: 5_000 });
    await rollBtn.click();

    // Expansion banner appears with the original captured
    await expect(cf.locator(".hps-roll-hint")).toBeVisible({ timeout: 5_000 });
    await expect(cf.locator(".hps-roll-original")).toContainText("게임");

    // Textarea is cleared, ready for extra
    await expect(textarea).toHaveValue("");
    await textarea.fill("별이 떨어지는 형태로");
    await textarea.press("Enter");

    // User message appears with both pieces joined
    const userMsg = cf.locator(".hps-msg-user .hps-msg-body").last();
    await expect(userMsg).toContainText("게임");
    await expect(userMsg).toContainText("별이 떨어지는");
  } finally {
    await closeApp(ctx);
  }
});
