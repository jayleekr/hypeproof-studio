// REQ-A2: workspace trust modal permanently suppressed via global settings.
// REQ-B2: empty token input clears the stored secret + shows "cleared" toast.
//
// A2: on first activation the extension writes
// `security.workspace.trust.enabled: false` to the user settings file. We
// verify by reading the settings.json from the test's user-data-dir AFTER
// the app has activated and exited.
//
// B2: pre-seed a token; run setToken; submit an empty string; verify the
// header pill flips from "Token ✓" to "Token" (signal that hasToken=false
// was pushed to the webview).

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { chatFrame, closeApp, launchApp, runCommand, type AppContext } from "../fixtures/app";

test("REQ-A2: workspace-trust suppression lands in global settings.json", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "코디" },
  });
  const settingsPath = path.join(ctx.userDataDir, "User", "settings.json");

  // Give activation enough time to run the update() + VS Code to flush
  // the in-memory settings buffer.
  await expect.poll(
    () => {
      try {
        const j = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        return j["security.workspace.trust.enabled"];
      } catch {
        return undefined;
      }
    },
    { timeout: 20_000, intervals: [500, 500, 1000, 1000] },
  ).toBe(false);

  // Manual teardown (closeApp would rm the dir before we can inspect).
  try { await ctx.app.close(); } catch { /* ignore */ }
  try { fs.rmSync(ctx.userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("REQ-B2: empty token submit clears the stored secret", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "코디" },
  });
  try {
    const cf = await chatFrame(ctx.win);

    // Header should show "Token ✓" because we pre-seeded a token.
    const tokenPill = cf.locator(":text-matches('Token ✓', 'i')").first();
    await tokenPill.waitFor({ state: "visible", timeout: 15_000 });

    // Run setToken command; press Enter without typing → empty string → clear.
    await runCommand(ctx.win, "HypeProof Chat: Set Workshop Token");
    const tokenInput = ctx.win.locator(".quick-input-widget input.input").first();
    await tokenInput.waitFor({ state: "visible", timeout: 10_000 });
    await ctx.win.keyboard.press("Enter");

    // Pill should flip — host post-config arrives with hasToken=false.
    // The button text drops the checkmark.
    await expect.poll(
      async () => {
        const tx = (await cf.locator("body").innerText().catch(() => "")) ?? "";
        return tx;
      },
      { timeout: 15_000, intervals: [200, 500, 1000] },
    ).not.toContain("Token ✓");
  } finally {
    await closeApp(ctx);
  }
});
