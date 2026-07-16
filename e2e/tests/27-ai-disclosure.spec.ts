// #320 / REQ-C14 — AI disclosure banner at session start (Anthropic Usage
// Policy / ToS §D.3). Verifies the host-gated notice in the REAL Electron app:
//
//   1. Fresh session → banner (role=note, exact Korean copy) is visible at the
//      TOP of the message list, before the first chat turn.
//   2. After the first roundtrip the banner is still there — exactly once,
//      never duplicated (webview replaces aiNotice, never appends).
//   3. Clear Conversation starts a new session → the banner re-appears,
//      still exactly once.
//
// The gating contract is unit-tested (AiDisclosureGate smoke); this spec proves
// it survives the host↔webview bridge in the shipped shell.

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chatFrame, closeApp, launchApp, runCommand } from "../fixtures/app.ts";

// Single source of truth — the exact disclosure copy is read straight from
// chatPanelHelpers.ts at load time, not duplicated here. A direct import won't
// work (the extension package is CommonJS while this suite is ESM, and
// Playwright doesn't transpile .ts outside the e2e package), so we extract the
// AI_DISCLOSURE_TEXT literal from source. If the const is renamed or moved the
// match fails loudly — that's intended: the copy must stay coupled to source.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPERS_SRC = path.resolve(
  __dirname,
  "../../extensions/hypeproof-chat/src/chatPanelHelpers.ts",
);
function readDisclosureText(): string {
  const src = fs.readFileSync(HELPERS_SRC, "utf8");
  const m = src.match(/AI_DISCLOSURE_TEXT\s*=\s*"([^"]+)"/);
  if (!m) {
    throw new Error(
      `Could not extract AI_DISCLOSURE_TEXT from ${HELPERS_SRC} — did the const move or change shape?`,
    );
  }
  return m[1];
}
const AI_DISCLOSURE_TEXT = readDisclosureText();

const BANNER = ".hps-ai-disclosure";

test("REQ-C14: AI disclosure banner shows once at session start, persists across a turn, re-appears after clear", async () => {
  const ctx = await launchApp({
    preseedToken: true,
    preseedCoach: { name: "테스트코치", personality: "" },
  });
  const { win } = ctx;
  try {
    const cf = await chatFrame(win);
    await cf.locator(".hps-shell").waitFor({ state: "visible", timeout: 25_000 });

    // ---- 1. Fresh session: banner visible, exact copy, role=note ----------
    const banner = cf.locator(BANNER);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toHaveText(AI_DISCLOSURE_TEXT);
    await expect(banner).toHaveAttribute("role", "note");
    await expect(banner).toHaveCount(1);

    // …and it sits at the TOP of the message list (first child of .hps-messages,
    // ahead of any message bubble) so it reads as a session-start notice.
    const isFirstChild = await cf.locator(".hps-messages").evaluate(
      (el, sel) => el.querySelector(sel) === el.firstElementChild,
      BANNER,
    );
    expect(isFirstChild).toBe(true);

    // Evidence: banner at session start (before any turn).
    await win.screenshot({ path: "test-results/ai-disclosure-session-start.png", fullPage: true });

    // ---- 2. First chat turn — banner must survive it ----------------------
    const textarea = cf.locator(".hps-input textarea").first();
    await textarea.waitFor({ state: "visible", timeout: 5_000 });
    await textarea.fill("안녕");
    await textarea.press("Enter");

    // User bubble in, assistant reply streams (Korean).
    await expect(cf.locator(".hps-msg-user .hps-msg-body").last()).toContainText("안녕");
    const assistant = cf.locator(".hps-msg-assistant .hps-msg-body").last();
    await expect(assistant).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      const t = (await assistant.textContent()) ?? "";
      expect(t.length).toBeGreaterThan(2);
      expect(/[가-힣]/.test(t)).toBeTruthy();
    }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });

    // After the turn: still visible, still exactly one — no duplication as
    // messages were appended above/below it.
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(AI_DISCLOSURE_TEXT);
    await expect(banner).toHaveCount(1);

    // Evidence: banner sitting on top of a live conversation.
    await win.screenshot({ path: "test-results/ai-disclosure-post-turn.png", fullPage: true });

    // ---- 3. Clear Conversation → new session → banner re-appears ----------
    await runCommand(win, "HypeProof Chat: Clear Conversation");

    // Poll: the seeded turn clears and the banner is re-posted by the host's
    // noticeForHistoryClear(); it must land exactly once, still at the top.
    await expect.poll(
      async () => await cf.locator(BANNER).count(),
      { timeout: 10_000, intervals: [200, 200, 500, 500] },
    ).toBe(1);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(AI_DISCLOSURE_TEXT);

    // The prior user turn is gone (new session) but the notice remains on top.
    // Assert on the message bubbles, not raw text — the empty-state greeting
    // legitimately contains "안녕" so a body text check would false-positive.
    await expect(cf.locator(".hps-msg-user")).toHaveCount(0, { timeout: 5_000 });
    const stillFirst = await cf.locator(".hps-messages").evaluate(
      (el, sel) => el.querySelector(sel) === el.firstElementChild,
      BANNER,
    );
    expect(stillFirst).toBe(true);

    // Evidence: banner re-appears on a fresh (post-clear) session.
    await win.screenshot({ path: "test-results/ai-disclosure-post-clear.png", fullPage: true });
  } finally {
    await closeApp(ctx);
  }
});
