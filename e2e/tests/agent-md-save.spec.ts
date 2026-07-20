// #371/#372 — verify the agent.md handoff AUTO-SAVE in the packaged app:
// ask the coach for agent.md in the real chat, then assert the file appears
// in the workspace folder. Single turn, no browser tools involved.
//
// Prerequisite: prod copyclone session live + /tmp/hps-token.txt (prod token).
// Run:
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" HPS_QUIET=0 \
//     npx playwright test agent-md-save --reporter=line

import { test, expect, type FrameLocator } from "@playwright/test";
import { launchApp, closeApp, chatFrame, openChatContainer, type AppContext } from "../fixtures/app.ts";
import * as fs from "node:fs";
import * as path from "node:path";

// The packaged app opens the chat container quickly but the webview content
// (.hps-shell) can take a few seconds to render. Poll up to `timeoutMs`,
// re-opening the container each round in case it wasn't revealed yet.
async function chatCf(
  win: import("@playwright/test").Page,
  timeoutMs = 40_000,
): Promise<FrameLocator> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await win.locator("iframe.webview.ready").count();
    for (let i = 0; i < n; i++) {
      const fl = win.frameLocator("iframe.webview.ready").nth(i).frameLocator("#active-frame");
      try {
        if ((await fl.locator(".hps-shell").count()) > 0) return fl;
      } catch {
        /* frame mid-navigation */
      }
    }
    if (Date.now() > deadline) throw new Error("chat frame not found (no .hps-shell after wait)");
    await openChatContainer(win).catch(() => undefined);
    await win.waitForTimeout(2_000);
  }
}

test("agent.md 자동 저장 — 실채팅 → workspace 파일", async () => {
  test.setTimeout(420_000);
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    const cf = await chatCf(ctx.win);
    await cf.locator(".hps-input textarea").first().waitFor({ state: "visible", timeout: 30_000 });

    const ta = cf.locator(".hps-input textarea").first();
    await ta.fill(
      "정담치과(보철 전문) 작업을 한다고 치고, agent.md 만들어줘 — 다음 AI에게 넘길 인수인계 문서로. 파일로 저장까지 해줘.",
    );
    await ta.press("Enter");

    // The file write happens at stream COMPLETION — poll the workspace dir.
    const target = path.join(ctx.wsDir, "agent.md");
    await expect
      .poll(() => fs.existsSync(target), { timeout: 240_000, intervals: [2_000] })
      .toBe(true);
    const content = fs.readFileSync(target, "utf8");
    expect(content.length).toBeGreaterThan(100);
    expect(content).toContain("agent.md");
    expect(content).not.toContain("```");
    console.log(`agent.md saved: ${content.length} chars\n---\n${content.slice(0, 400)}`);
  } finally {
    await closeApp(ctx);
  }
});
