// Coach naming is now an in-panel card (kid-friendly), not a system input
// box. Fresh user-data-dir + no pre-seeded coach → the naming card appears
// inside the chat webview; filling it surfaces the coach name everywhere.

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, chatFrame } from "../fixtures/app.ts";

test("in-panel naming card: name + personality → coach surfaces", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    // No preseedCoach → naming card shows
  });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);

    // Naming card visible (profile fetched → user_names_it → not configured)
    const card = cf.locator(".hps-naming");
    await card.waitFor({ state: "visible", timeout: 25_000 });

    // Step 1 — name
    const nameInput = cf.locator(".hps-naming-input");
    await nameInput.waitFor({ state: "visible", timeout: 5_000 });
    await nameInput.fill("루카");
    await cf.locator(".hps-naming-btn").click();

    // Step 2 — personality
    await expect(cf.locator(".hps-naming-input")).toBeVisible({ timeout: 5_000 });
    await cf.locator(".hps-naming-input").fill("엉뚱하고 칭찬 잘함");
    await cf.locator(".hps-naming-btn").click();

    // Card gone, chat shell shows the coach name
    await expect(cf.locator(".hps-coach-name")).toHaveText("루카", { timeout: 15_000 });
    await expect(cf.locator(".hps-empty-greeting")).toContainText("루카");
  } finally {
    await closeApp(ctx);
  }
});

test("naming card skip button uses fallback name", async () => {
  const ctx = await launchApp({ preseedToken: true });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);
    await cf.locator(".hps-naming").waitFor({ state: "visible", timeout: 25_000 });

    // Type a name, advance, then skip on personality step
    await cf.locator(".hps-naming-input").fill("포포");
    await cf.locator(".hps-naming-btn").click();
    await expect(cf.locator(".hps-naming-input")).toBeVisible({ timeout: 5_000 });
    await cf.locator(".hps-naming-btn-ghost").click(); // 건너뛰기

    await expect(cf.locator(".hps-coach-name")).toHaveText("포포", { timeout: 15_000 });
  } finally {
    await closeApp(ctx);
  }
});
