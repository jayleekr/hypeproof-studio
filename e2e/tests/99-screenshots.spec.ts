// Captures key UX states to test-results/screenshots/ for visual review.
// Not a regression test — always passes (best-effort). Run when you want
// fresh visual evidence of where the UX is right now.
//
// Some snapshots require non-dental cohort shape (naming card, follow-up
// chips). Those skip automatically on option B (#187) — see beforeAll.

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, chatFrame } from "../fixtures/app.ts";
import { fetchDentalProfile } from "../fixtures/dental-helpers.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT_DIR = "test-results/screenshots";

let isOptionB = false;
let namingMode: string = "user_names_it";

test.beforeAll(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const profile = await fetchDentalProfile();
  isOptionB = profile.ux.suggestions.follow_up.length === 0;
  namingMode = profile.ux.coach.naming_mode;
});

test("screenshot — in-panel coach naming card", async () => {
  test.skip(namingMode === "fixed", "naming_mode=fixed → no naming card (option B)");
  const ctx = await launchApp({ preseedToken: true });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);
    await cf.locator(".hps-naming").waitFor({ state: "visible", timeout: 25_000 });
    await win.screenshot({ path: path.join(OUT_DIR, "01-naming-card.png"), fullPage: true });
  } finally {
    await closeApp(ctx);
  }
});

test("screenshot — empty state with initial chips", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "별이", personality: "엉뚱하고 칭찬 잘함" },
  });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    await cf.locator(".hps-chip").first().waitFor({ state: "visible", timeout: 10_000 });
    await win.screenshot({ path: path.join(OUT_DIR, "02-empty-with-chips.png"), fullPage: true });
  } finally {
    await closeApp(ctx);
  }
});

test("screenshot — after first response with follow-up chips", async () => {
  test.skip(isOptionB, "option B has empty follow_up — no chip rack to capture");
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "별이", personality: "엉뚱하고 칭찬 잘함" },
  });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.fill("원이 좌우로 움직이는 화면 만들어줘");
    await textarea.press("Enter");
    // Wait for assistant text to settle
    const assistant = cf.locator(".hps-msg-assistant .hps-msg-body").last();
    await expect(assistant).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      const t = (await assistant.textContent()) ?? "";
      expect(t.length).toBeGreaterThan(80);
    }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });
    // Wait a bit for follow-up chips to render
    await cf.locator(".hps-chips-rack").last().waitFor({ state: "visible", timeout: 15_000 });
    await win.screenshot({ path: path.join(OUT_DIR, "03-after-response.png"), fullPage: true });
  } finally {
    await closeApp(ctx);
  }
});

test("screenshot — roll-input expansion banner", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "별이", personality: "엉뚱하고 칭찬 잘함" },
  });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.fill("게임");
    await cf.locator(".hps-btn-roll").click();
    await cf.locator(".hps-roll-hint").waitFor({ state: "visible", timeout: 5_000 });
    await win.screenshot({ path: path.join(OUT_DIR, "04-roll-input.png"), fullPage: true });
  } finally {
    await closeApp(ctx);
  }
});

test("screenshot — short-input hint", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "별이", personality: "엉뚱하고 칭찬 잘함" },
  });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });
    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.fill("ab");
    await cf.locator(".hps-hint").waitFor({ state: "visible", timeout: 3_000 });
    await win.screenshot({ path: path.join(OUT_DIR, "05-short-hint.png"), fullPage: true });
  } finally {
    await closeApp(ctx);
  }
});
