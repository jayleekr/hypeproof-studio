// REQ-F2: naming_mode="fixed" → no in-panel naming card surfaces.
// REQ-F5: renameCoach command pre-fills the existing coach name.
//
// Strategy: launch with dental cohort token (naming_mode=fixed); assert
// the .hps-naming card NEVER appears. Then for F5, pre-seed a coach name
// and run the rename command; assert the QuickInput input.value reflects
// the existing name.
//
// REQ-F3 (length clamp) is covered by the chatPanelHelpers smoke
// (sanitizeCoachInput) — not in this e2e.

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, chatFrame, runCommand } from "../fixtures/app";

test("REQ-F2: dental cohort (naming_mode=fixed) → no naming card", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    // No preseedCoach. With dental cohort's naming_mode=fixed the card
    // must NOT show regardless. Empty header still uses fallback_name.
  });
  try {
    const cf = await chatFrame(ctx.win);
    // Give 2.5s for any potential card to render
    await ctx.win.waitForTimeout(2_500);
    const card = cf.locator(".hps-naming");
    expect(await card.count()).toBe(0);
    // Coach header should show fallback name (configured via env preseed
    // doesn't apply here — we didn't preseedCoach). Header still renders
    // SOMETHING — fallback from profile.ux.coach.fallback_name.
    const header = cf.locator(".hps-coach-name").first();
    if (await header.count() > 0) {
      const txt = (await header.innerText().catch(() => "")) ?? "";
      // dental profile fallback_name === "코치"; sanity-check it's a
      // non-empty string.
      expect(txt.trim().length).toBeGreaterThan(0);
    }
  } finally {
    await closeApp(ctx);
  }
});

test("REQ-F5: renameCoach command pre-fills existing coach name", async () => {
  const existingName = "기존코디";
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: existingName, personality: "" },
  });
  try {
    // Give the panel + profile fetch time to settle before running the
    // command so ensureProfile() inside runCoachNamingRitual doesn't race
    // the showInputBox creation.
    await ctx.win.waitForTimeout(2_000);

    await runCommand(ctx.win, "HypeProof Chat: 코치 이름 다시 짓기");

    // The renameCoach showInputBox opens AFTER the command palette closes.
    // Wait via expect.poll for the input to have the pre-filled value —
    // tolerates the (palette closes → ensureProfile resolves → new
    // InputBox renders) sequence.
    const input = ctx.win.locator(".quick-input-widget input.input").first();
    await expect.poll(
      async () => {
        if (!(await input.isVisible().catch(() => false))) return null;
        return await input.inputValue();
      },
      { timeout: 15_000, intervals: [200, 200, 500, 500, 1000] },
    ).toBe(existingName);

    // Cleanup: dismiss the QuickInput
    await ctx.win.keyboard.press("Escape");
  } finally {
    await closeApp(ctx);
  }
});
