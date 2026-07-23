// #384 SDK-runtime pilot part 2 — WRITE path: ask the coach to persist the
// rubric as a FILE (rubric.md). Write tools are modal-gated; this spec clicks
// the native VS Code "Approve" dialog(s) as they appear, then asserts the file
// lands in the workspace. Proves the full Claude Code-style write loop:
// model → Write tool → canUseTool ask → modal → fs.
// Run:
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" HPS_QUIET=0 \
//     npx playwright test sdk-file-write --reporter=line

import { test, expect, type FrameLocator } from "@playwright/test";
import { launchApp, closeApp, openChatContainer, type AppContext } from "../fixtures/app.ts";
import * as fs from "node:fs";
import * as path from "node:path";

async function chatCf(win: import("@playwright/test").Page, timeoutMs = 40_000): Promise<FrameLocator> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await win.locator("iframe.webview.ready").count();
    for (let i = 0; i < n; i++) {
      const fl = win.frameLocator("iframe.webview.ready").nth(i).frameLocator("#active-frame");
      try { if ((await fl.locator(".hps-shell").count()) > 0) return fl; } catch { /* next */ }
    }
    if (Date.now() > deadline) throw new Error("chat frame not found");
    await openChatContainer(win).catch(() => undefined);
    await win.waitForTimeout(2_000);
  }
}

test("SDK runtime — coach writes rubric.md through the approval modal", async () => {
  test.setTimeout(600_000);
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  // Give the coach an index.html so it doesn't wander into live-preview
  // "not found" (fresh workspace) instead of writing the rubric.
  fs.writeFileSync(
    path.join(ctx.wsDir, "index.html"),
    "<!doctype html><html><body><h1>정담치과</h1></body></html>",
  );
  // Auto-click "Approve" on the (DOM, window.dialogStyle=custom) modal
  // whenever it appears — write tools are modal-gated; we play the participant.
  const approver = (async () => {
    for (;;) {
      try {
        const box = ctx.win.locator(".monaco-dialog-box").first();
        if (await box.isVisible().catch(() => false)) {
          const text = (await box.textContent().catch(() => "")) ?? "";
          // The pre-seeded window.dialogStyle setting makes VS Code ask for a
          // restart on first boot — dismiss it (Cancel), we don't need it now.
          const wanted = /restart to take effect/i.test(text) ? /Cancel/i : /Approve/i;
          const btn = box.locator("a.monaco-button, .monaco-button").filter({ hasText: wanted }).first();
          if (await btn.isVisible().catch(() => false)) {
            await btn.click().catch(() => undefined);
            // eslint-disable-next-line no-console
            console.log(`[approver] clicked ${wanted}`);
          }
        }
      } catch {
        /* window closing */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  void approver;
  try {
    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    const cf = await chatCf(ctx.win);
    const ta = cf.locator(".hps-input textarea").first();
    await ta.waitFor({ state: "visible", timeout: 30_000 });

    await ta.fill(
      "브라우저는 열지 말고 — 우리 병원 검사 기준(루브릭) 기본 8항목을 rubric.md 파일로 작업 폴더에 저장해줘. 파일 쓰기 승인은 내가 바로 눌러줄게.",
    );
    await ta.press("Enter");

    const target = path.join(ctx.wsDir, "rubric.md");
    await expect
      .poll(() => fs.existsSync(target), { timeout: 300_000, intervals: [2_000] })
      .toBe(true);
    const content = fs.readFileSync(target, "utf8");
    expect(content.length).toBeGreaterThan(50);
    // eslint-disable-next-line no-console
    console.log(`SDK FILE-WRITE PROVEN — rubric.md written (${content.length} chars)\n` + content.slice(0, 300));
  } finally {
    await closeApp(ctx);
  }
});
