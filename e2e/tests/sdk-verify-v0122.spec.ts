// v0.1.22 install verification — the coach reads a planted image filename AND
// writes a file, in one real chat session, on the shipped app + prod. Combines
// the two pilot probes into a single go/no-go run.
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" HPS_QUIET=0 \
//     npx playwright test sdk-verify-v0122 --reporter=line

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

test("v0.1.22 — coach reads a planted image then writes a file", async () => {
  test.setTimeout(600_000);
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  fs.writeFileSync(path.join(ctx.wsDir, "reception-photo-42.jpeg"), Buffer.from("jpegbytes"));
  fs.writeFileSync(path.join(ctx.wsDir, "index.html"), "<!doctype html><html><body><h1>정담치과</h1></body></html>");

  const approver = (async () => {
    for (;;) {
      try {
        const box = ctx.win.locator(".monaco-dialog-box").first();
        if (await box.isVisible().catch(() => false)) {
          const text = (await box.textContent().catch(() => "")) ?? "";
          const wanted = /restart to take effect/i.test(text) ? /Cancel/i : /Approve/i;
          const btn = box.locator("a.monaco-button, .monaco-button").filter({ hasText: wanted }).first();
          if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => undefined);
        }
      } catch { /* window closing */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  void approver;
  try {
    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    let cf = await chatCf(ctx.win);
    let ta = cf.locator(".hps-input textarea").first();
    await ta.waitFor({ state: "visible", timeout: 30_000 });
    // Panel can transiently collapse right after first render — re-open + settle.
    await ctx.win.waitForTimeout(2_000);
    await openChatContainer(ctx.win);
    cf = await chatCf(ctx.win);
    ta = cf.locator(".hps-input textarea").first();
    await ta.waitFor({ state: "visible", timeout: 30_000 });

    // 1) READ — name the planted image.
    await ta.click();
    await ta.fill("브라우저는 열지 마. 작업 폴더 안 파일 이름을 읽어서 그대로 알려줘.");
    await ta.press("Enter");
    // Confirm a NEW assistant bubble actually appeared (message really sent).
    await expect
      .poll(async () => cf.locator(".hps-msg-assistant").count(), { timeout: 60_000, intervals: [2_000] })
      .toBeGreaterThan(0);
    const body = cf.locator(".hps-msg-assistant .hps-msg-body").last();
    await expect
      .poll(async () => (await body.textContent().catch(() => "")) ?? "", { timeout: 240_000, intervals: [3_000] })
      .toContain("reception-photo-42");
    // eslint-disable-next-line no-console
    console.log("READ ✓ — coach named the planted image file");

    // 2) WRITE — persist a file through the modal.
    await ta.fill("좋아. 이제 그 사진을 히어로에 넣는 계획을 hero-plan.md 파일로 작업 폴더에 저장해줘. 승인은 바로 눌러줄게.");
    await ta.press("Enter");
    const target = path.join(ctx.wsDir, "hero-plan.md");
    await expect
      .poll(() => fs.existsSync(target), { timeout: 240_000, intervals: [2_000] })
      .toBe(true);
    const written = fs.readFileSync(target, "utf8");
    expect(written.length).toBeGreaterThan(20);
    // eslint-disable-next-line no-console
    console.log(`WRITE ✓ — hero-plan.md written (${written.length} chars)\nv0.1.22 SDK FILE COACH: FULLY OPERATIONAL`);
  } finally {
    await closeApp(ctx);
  }
});
