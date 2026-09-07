import { test, expect } from "@playwright/test";
import { launchApp, closeApp, chatFrame, startFrame } from "../fixtures/app.ts";

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

test("cold launch opens the branded in-app connection form", async () => {
  const ctx = await launchApp({ preseedToken: false });
  try {
    const start = await startFrame(ctx.win);
    await expect(start.getByRole("heading", { name: "내 수업에 연결하기" })).toBeVisible();
    await expect(start.locator("#course-code")).toHaveAttribute("type", "password");
    await expect(start.getByRole("button", { name: "수업 확인하기" })).toBeDisabled();
    await expect(start.locator("body")).not.toContainText("나비");
    await expect(ctx.win.locator(".quick-input-widget")).not.toBeVisible();
  } finally { await closeApp(ctx); }
});
