// DIAGNOSTIC: why does the e2e-driven real Studio agent-sdk coach not write?
// Launch, send the brief, observe ~150s, then dump BEFORE teardown:
//   $HPS_OUT.frame.html  — full chat webview innerHTML (tool logs, banners, errors)
//   $HPS_OUT.logs/       — the VS Code exthost logs (coach console.* lands here)
//   $HPS_OUT.files.txt   — workspace listing
//   $HPS_OUT.html/.chat.txt — captured artifact + assistant text if any
//
// Run:
//   cd e2e && HPS_APP_PATH="/Applications/HypeProof Studio.app" \
//     HPS_E2E_PROXY_URL="https://api.hypeproof-ai.xyz/v1" HPS_QUIET=1 \
//     HPS_OUT="/path/diag" npx playwright test ablation-real-copyclone --reporter=line

import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { launchApp, closeApp, openChatContainer, type AppContext } from "../fixtures/app.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

async function grabChat(cf: FrameLocator): Promise<string> {
  try {
    const bubbles = cf.locator(".hps-msg-assistant .hps-msg-body");
    const c = await bubbles.count();
    const parts: string[] = [];
    for (let i = 0; i < c; i++) parts.push((await bubbles.nth(i).textContent()) ?? "");
    return parts.join("\n");
  } catch { return ""; }
}

const OUT = process.env.HPS_OUT || path.join(process.env.TMPDIR || "/tmp", "diag");
const OBSERVE_MS = Number(process.env.HPS_OBSERVE_MS || 600_000);

async function chatCf(win: Page, timeoutMs = 40_000): Promise<FrameLocator> {
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

function copyDir(src: string, dst: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else { try { fs.copyFileSync(s, d); } catch { /* skip */ } }
  }
}

test("DIAG — real coach runtime trace", async () => {
  test.setTimeout(900_000);
  const ctx: AppContext = await launchApp({ preseedToken: true, preseedCoach: { name: "코치" } });

  const modals: string[] = [];
  const approver = (async () => {
    for (;;) {
      try {
        const box = ctx.win.locator(".monaco-dialog-box").first();
        if (await box.isVisible().catch(() => false)) {
          const text = (await box.textContent().catch(() => "")) ?? "";
          modals.push(text.slice(0, 200));
          const wanted = /restart to take effect/i.test(text) ? /Cancel/i : /Approve/i;
          const btn = box.locator("a.monaco-button, .monaco-button").filter({ hasText: wanted }).first();
          if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => undefined);
        }
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  })();
  void approver;

  try {
    await ctx.win.waitForTimeout(5_000);
    await openChatContainer(ctx.win);
    const cf = await chatCf(ctx.win);
    const ta = cf.locator(".hps-input textarea").first();
    await ta.waitFor({ state: "visible", timeout: 30_000 });
    // The agent-sdk coach writes to its OWN default workspace (~/HypeProofGames),
    // NOT the e2e-passed wsDir. Watch the real file. Overridable via HPS_WATCH_FILE.
    const watch = process.env.HPS_WATCH_FILE || path.join(os.homedir(), "HypeProofGames", "index.html");
    // Clear any prior run's output IN-PROCESS (node can, the bash harness can't)
    // so we never capture a stale homepage from a previous cohort's run.
    try { fs.rmSync(watch, { force: true }); } catch { /* ignore */ }
    const t0 = Date.now();

    await ta.fill(process.env.HPS_BRIEF || "보아치과 홈페이지 만들어줘. 완성된 단일 HTML을 index.html 파일로 저장해줘. 브라우저 열지 마.");
    await ta.press("Enter");

    // Observe until the homepage is written AND its size stabilizes (the coach
    // may write a skeleton then edit). Require the file to be freshly written
    // (mtime ≥ t0) so a leftover file can never be captured.
    let lastSize = -1, stableFor = 0;
    while (Date.now() - t0 < OBSERVE_MS) {
      await ctx.win.waitForTimeout(8_000);
      try { fs.writeFileSync(`${OUT}.frame.html`, await cf.locator("body").innerHTML()); } catch { /* ignore */ }
      const size = fs.existsSync(watch) ? fs.statSync(watch).size : 0;
      if (size > 2500) {
        if (size === lastSize) { stableFor += 8; } else { stableFor = 0; }
        lastSize = size;
        const chatNow = await grabChat(cf).catch(() => "");
        const done = /완료|저장|덮어|끝났|완성/.test(chatNow);
        if (stableFor >= 16 || (done && stableFor >= 8)) { fs.copyFileSync(watch, `${OUT}.html`); break; }
      }
    }
    if (!fs.existsSync(`${OUT}.html`) && fs.existsSync(watch) && fs.statSync(watch).size > 1500) {
      fs.copyFileSync(watch, `${OUT}.html`);
    }

    // Final evidence dump BEFORE teardown.
    try {
      const list: string[] = [];
      const walk = (d: string, pre = "") => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name.startsWith(".git")) continue;
          list.push(pre + (e.isDirectory() ? "d " : "f ") + e.name);
          if (e.isDirectory()) walk(path.join(d, e.name), pre + "  ");
        }
      };
      if (fs.existsSync(ctx.wsDir)) walk(ctx.wsDir);
      fs.writeFileSync(`${OUT}.files.txt`, list.join("\n"));
    } catch { /* ignore */ }

    try {
      const bubbles = cf.locator(".hps-msg-assistant .hps-msg-body");
      const c = await bubbles.count();
      const parts: string[] = [];
      for (let i = 0; i < c; i++) parts.push((await bubbles.nth(i).textContent()) ?? "");
      fs.writeFileSync(`${OUT}.chat.txt`, `MODALS SEEN:\n${modals.join("\n")}\n\n=== ASSISTANT ===\n${parts.join("\n---\n")}`);
    } catch { /* ignore */ }

    // The exthost logs — where the coach's console.info/warn (runtime pick, SDK
    // resolve, tool decisions) land. Copy before closeApp rmSync's userDataDir.
    copyDir(path.join(ctx.userDataDir, "logs"), `${OUT}.logs`);

    // eslint-disable-next-line no-console
    console.log(`DIAG dumped → ${OUT}.{frame.html,chat.txt,files.txt,logs/} ; modals=${modals.length}`);
  } finally {
    await closeApp(ctx);
  }
});
