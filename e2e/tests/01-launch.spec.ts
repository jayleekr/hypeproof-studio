// Smoke: app launches, workbench renders, autoOnboard does its job.
//
// Two flavors:
//   - default launch (token pre-seeded) → expect chat webview to mount
//   - cold launch (no token)            → expect setToken input box to appear

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, chatFrame } from "../fixtures/app.ts";

test("launches + chat panel mounts when token is pre-seeded", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "테스트코치" },
  });
  try {
    // (Window title is the workspace folder name once a folder is open, so
    // it's not a stable product check — rely on the chat panel instead.)

    // Activity-bar container header
    const header = ctx.win
      .locator("h2, .composite.title")
      .filter({ hasText: /HypeProof Chat/i })
      .first();
    await expect(header).toBeVisible({ timeout: 20_000 });

    // Webview React shell mounts (proves the resource-URI rewrite works)
    const cf = await chatFrame(ctx.win);
    await expect(cf.locator(".hps-shell")).toBeVisible({ timeout: 25_000 });
  } finally {
    await closeApp(ctx);
  }
});

test("cold launch (no token) opens the setToken input box", async () => {
  const ctx = await launchApp({ preseedToken: false });
  try {
    // autoOnboard waits 400ms after panel focus before firing setToken.
    // The QuickInput shows both Korean title and English prompt; match
    // either so renderer differences (line breaks, ARIA wrapping) don't
    // false-negative. Bumped from 15s → 30s — issue #42 root cause was
    // timing variance on cold first-launch (cache miss + workbench cold +
    // extension activation + autoOnboard delay can pile up past 15s on a
    // contended runner).
    const tokenPrompt = ctx.win
      .locator(".quick-input-widget")
      .filter({ hasText: /Workshop token|선생님께 받은 토큰/i });
    await expect(tokenPrompt).toBeVisible({ timeout: 30_000 });
    await ctx.win.keyboard.press("Escape");
  } finally {
    await closeApp(ctx);
  }
});
