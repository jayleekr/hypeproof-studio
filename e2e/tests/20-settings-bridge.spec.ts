// REQ-K2: webview ⚙ button → workbench.action.openSettings("hypeproofChat")
//
// Click the cog button in the chat panel header → assert the Settings editor
// opens with the hypeproofChat query pre-filtered.

import { test, expect } from "@playwright/test";
import { chatFrame, closeApp, launchApp } from "../fixtures/app";

test("REQ-K2: ⚙ click opens Settings editor pre-filtered to hypeproofChat", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "코디" }, // skip naming card so the cog is reachable
  });
  try {
    const cf = await chatFrame(ctx.win);
    const cog = cf.locator("button:has-text('⚙')").first();
    await cog.waitFor({ state: "visible", timeout: 15_000 });
    await cog.click();

    // The Settings editor opens in the editor area with our 3 settings
    // visible (filtered by "hypeproofChat" query). VS Code's display labels
    // come from the `title` field in package.json (`HypeProof Chat`).
    await expect(ctx.win.locator(".monaco-workbench"))
      .toContainText("Hypeproof Chat: Model", { timeout: 15_000 });
    await expect(ctx.win.locator(".monaco-workbench"))
      .toContainText("Hypeproof Chat: Proxy Url");
    await expect(ctx.win.locator(".monaco-workbench"))
      .toContainText("Hypeproof Chat: Require Approval For");
  } finally {
    await closeApp(ctx);
  }
});
