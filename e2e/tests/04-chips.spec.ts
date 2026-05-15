// Initial suggestion chips render with good/weak contrast, click drops into
// input box, follow-up chips appear after assistant response.

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, chatFrame } from "../fixtures/app.ts";

test("initial chips show, weak chip is disabled, good chip drops into input", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "테스트코치" },
  });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });

    // Chips visible in empty state
    const chips = cf.locator(".hps-chip");
    await expect(chips.first()).toBeVisible({ timeout: 10_000 });
    const count = await chips.count();
    expect(count).toBeGreaterThan(2);

    // At least one good and at least one weak chip
    await expect(cf.locator(".hps-chip-good").first()).toBeVisible();
    await expect(cf.locator(".hps-chip-weak").first()).toBeVisible();

    // Weak chip is disabled (non-clickable)
    const weak = cf.locator(".hps-chip-weak").first();
    await expect(weak).toBeDisabled();

    // Click a good chip → text lands in the textarea
    const firstGood = cf.locator(".hps-chip-good").first();
    const chipText = (await firstGood.locator(".hps-chip-text").textContent()) ?? "";
    await firstGood.click();
    const textarea = cf.locator(".hps-input textarea").first();
    await expect(textarea).toHaveValue(chipText.trim(), { timeout: 5_000 });
  } finally {
    await closeApp(ctx);
  }
});

test("follow-up chips appear after assistant response", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "테스트코치" },
  });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });

    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.fill("안녕");
    await textarea.press("Enter");

    // Wait for assistant message to populate
    const assistant = cf.locator(".hps-msg-assistant .hps-msg-body").last();
    await expect(assistant).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      const t = (await assistant.textContent()) ?? "";
      expect(t.length).toBeGreaterThan(2);
    }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });

    // Follow-up chips should now appear (different label than initial)
    const labelText = await cf.locator(".hps-chips-label").last().textContent();
    expect(labelText).toContain("이어서");
  } finally {
    await closeApp(ctx);
  }
});
