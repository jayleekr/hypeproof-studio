import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { closeApp, launchApp, startFrame } from "../fixtures/app";

test("REQ-A2: activation preserves the user's workspace trust setting", async () => {
  const ctx = await launchApp({ preseedToken: false });
  try {
    const start = await startFrame(ctx.win);
    await expect(start.locator("#course-code")).toBeVisible();
    const settings = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, "User/settings.json"), "utf8"));
    expect(settings["security.workspace.trust.enabled"]).toBeUndefined();
  } finally { await closeApp(ctx); }
});

test("REQ-B2: explicit disconnect removes the course connection", async () => {
  const ctx = await launchApp({ preseedToken: true, stayOnStart: true });
  try {
    const start = await startFrame(ctx.win);
    await start.getByRole("button", { name: "연결 해제", exact: true }).click();
    await expect(start.locator("#course-code")).toBeVisible();
    await expect(start.locator(".studio-course")).toHaveCount(0);
  } finally { await closeApp(ctx); }
});
