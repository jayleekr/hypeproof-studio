// #384 SDK-runtime pilot — THE decisive probe: can the coach actually READ the
// workspace? We plant files in the e2e workspace dir, then ask the coach what
// files exist. A proxy coach cannot know the planted filename; only a real
// SDK (Read/Glob) coach can answer it. Read tools are auto-allowed (no modal),
// so this probe runs unattended.
// Run:
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" HPS_QUIET=0 \
//     npx playwright test sdk-file-read --reporter=line

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

test("SDK runtime — coach reads planted workspace files", async () => {
  test.setTimeout(600_000); // SDK turns are slower (CLI boot + agent loop)
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });
  try {
    // Plant files the coach could only know about by actually reading the dir.
    fs.writeFileSync(path.join(ctx.wsDir, "clinic-room-77.jpeg"), Buffer.from("fakejpegbytes"));
    fs.writeFileSync(path.join(ctx.wsDir, "hero-note.txt"), "병원 슬로건: 정성을 담는 진료");

    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    const cf = await chatCf(ctx.win);
    const ta = cf.locator(".hps-input textarea").first();
    await ta.waitFor({ state: "visible", timeout: 30_000 });

    await ta.fill("작업 폴더 안에 지금 어떤 파일들이 있는지 읽어서 파일 이름을 그대로 알려줘.");
    await ta.press("Enter");

    // Wait for a reply that names the planted file (or give up at 5 min).
    const body = cf.locator(".hps-msg-assistant .hps-msg-body").last();
    await expect
      .poll(async () => (await body.textContent().catch(() => "")) ?? "", {
        timeout: 300_000,
        intervals: [3_000],
      })
      .toContain("clinic-room-77");

    const reply = (await body.textContent()) ?? "";
    // eslint-disable-next-line no-console
    console.log("SDK FILE-READ PROVEN — reply names planted files:\n" + reply.slice(0, 500));
  } finally {
    // Diagnostics: surface extension-host "[coach]" lines (SdkUnavailableError
    // fallback reasons land there) before the user-data dir is wiped.
    try {
      const logRoot = path.join(ctx.userDataDir, "logs");
      const found: string[] = [];
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".log")) {
            const txt = fs.readFileSync(p, "utf8");
            for (const line of txt.split("\n")) {
              if (line.includes("[coach]") || line.includes("Sdk") || line.includes("sdk")) found.push(line.trim());
            }
          }
        }
      };
      walk(logRoot);
      // eslint-disable-next-line no-console
      console.log("── extension-host sdk/coach log lines ──\n" + found.slice(0, 40).join("\n"));
    } catch {
      /* best-effort */
    }
    await closeApp(ctx);
  }
});
