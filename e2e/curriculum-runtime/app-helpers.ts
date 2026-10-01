// Shared helpers of the in-app Curriculum Runtime runs (moved unchanged out of
// app-layer.spec.ts by cr-verify #1392 so verify-app.spec.ts drives the same Service,
// composer, palette and outline sampler instead of a second copy).
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chatFrame } from "../fixtures/app";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "../..");
export const PORT = Number(process.env.HPS_CR_APP_PORT || 18931);

export type Run = { failedAt: number | null; failures: Array<{ step: number | null; message: string }>; steps: number; done: boolean; results: unknown[]; actions: string[]; lines: Array<{ round: number; line: string }> };
export type State = { requests: Array<{ tools: string[]; userText: string; images: number }>; runs: Record<string, Run> };

export function screenLocked(): boolean | null {
  try {
    return execFileSync("python3", ["-c", "import Quartz;print(int(Quartz.CGSessionCopyCurrentDictionary().get('CGSSessionScreenIsLocked',0)))"], { encoding: "utf8" }).trim() === "1";
  } catch {
    return null;
  }
}

export class Service {
  private proc!: ChildProcess;
  /** `mode: "publish"` adds the Publish for User Test storage and test origin (cr-publish). */
  async start(on: boolean, mode?: "publish"): Promise<void> {
    fs.mkdirSync(path.dirname(process.env.HPS_E2E_TOKEN_FILE!), { recursive: true });
    this.proc = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", path.join(here, "app-service.mjs"), String(PORT), process.env.HPS_E2E_TOKEN_FILE!, on ? "on" : "off", ...(mode ? [mode] : [])], { cwd: repo, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("service did not start")), 30_000);
      this.proc.stdout!.on("data", (d) => { if (/READY/.test(String(d))) { clearTimeout(t); resolve(); } });
      this.proc.on("exit", (c) => reject(new Error(`service exited ${c}`)));
    });
  }
  async state(): Promise<State> {
    return (await fetch(`http://127.0.0.1:${PORT}/__cr/state`)).json() as Promise<State>;
  }
  stop(): void {
    this.proc?.kill();
  }
}

/**
 * Send one message and prove it left: the composer must be idle first (its idle
 * placeholder; a turn still finishing would park the message instead), and the student's
 * bubble must appear before anything polls the Service. A message that does not show up
 * fails HERE, with what the composer held, instead of as a run that "did not finish".
 */
export async function send(win: Page, text: string): Promise<void> {
  // The unified chat is an editor tab; opening index.html can cover it. Bring it forward.
  const tab = win.locator(".tabs-container .tab", { hasText: "AI와 작업" }).first();
  if ((await tab.count()) > 0) await tab.click().catch(() => undefined);
  const chat = await chatFrame(win);
  // The app copy's own update check finds a newer public release and shows a banner whose
  // "업데이트" button starts a download that pauses the integrated browser ("Paused due
  // to Notification", run of 2026-10-01). Dismiss it; nothing here may update the copy.
  const later = chat.locator(".hps-update-banner-dismiss");
  if (await later.isVisible().catch(() => false)) await later.click();
  const input = chat.locator("textarea[placeholder^=\"메시지를 입력\"]").first();
  await expect(input, "the composer is idle (no turn still finishing)").toBeEditable({ timeout: 60_000 });
  const bubbles = chat.locator(".hps-msg-user .hps-msg-body");
  const before = await bubbles.count();
  await input.fill(text);
  await expect(input).toHaveValue(text);
  await input.press("Enter");
  try {
    await expect.poll(async () => (await bubbles.allInnerTexts()).slice(before).some((t) => t.includes(text)), { timeout: 15_000 }).toBe(true);
  } catch {
    const diag = {
      draft: await chat.locator("textarea").first().inputValue().catch(() => null),
      placeholder: await chat.locator("textarea").first().getAttribute("placeholder").catch(() => null),
      queued: await chat.locator(".hps-queued-text").allInnerTexts().catch(() => []),
      notices: await chat.locator(".hps-page-notice").allInnerTexts().catch(() => []),
      banner: await later.isVisible().catch(() => null),
      bubbles: (await bubbles.allInnerTexts().catch(() => [])).slice(-2),
    };
    sendLost.push({ text, ...diag });
    throw new Error(`message did not leave the composer: ${JSON.stringify({ text, ...diag })}`);
  }
}
export const sendLost: unknown[] = [];

/** Command palette rows for a query, without running anything. */
export async function paletteRows(win: Page, query: string): Promise<string[]> {
  const titleBar = win.locator(".monaco-workbench .part.titlebar").first();
  const input = win.locator(".quick-input-widget input.input").first();
  for (let attempt = 1; ; attempt++) {
    await titleBar.click({ position: { x: 10, y: 10 }, force: true }).catch(() => undefined);
    await win.keyboard.press("Meta+Shift+P");
    try { await input.waitFor({ state: "visible", timeout: 2_500 }); break; } catch (e) { if (attempt >= 3) throw e; await win.keyboard.press("Escape"); }
  }
  await input.fill(`>${query}`);
  await win.waitForTimeout(600);
  const rows = await win.locator(".quick-input-list .monaco-list-row").allInnerTexts();
  await win.keyboard.press("Escape");
  return rows.map((r) => r.replace(/\s+/g, " ").trim());
}

/** The integrated browser's web contents showing the kiosk preview, from the main process. */
export async function previewUrl(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()).find((u) => /^http:\/\/127\.0\.0\.1:\d+\/(index\.html)?(\?.*)?$/.test(u) && !u.includes(":18931")) ?? null);
}

export async function waitRun(svc: Service, key: string, win: Page, sample?: (running: number) => void): Promise<Run> {
  const chat = await chatFrame(win);
  const end = Date.now() + 120_000;
  for (;;) {
    const running = await chat.locator(".hps-tool-log-line.hps-tool-running").count().catch(() => 0);
    sample?.(running);
    const run = (await svc.state()).runs[key];
    if (run?.done) {
      await expect(chat.locator(".hps-tool-log-line.hps-tool-running")).toHaveCount(0, { timeout: 30_000 });
      return run;
    }
    if (Date.now() > end) throw new Error(`run ${key} did not finish: ${JSON.stringify(run)}`);
    await win.waitForTimeout(50);
  }
}

/** Main-process sampler: does the preview's painted frame carry the orange automation outline? */
export async function startOutlineSampler(app: ElectronApplication, urlPattern = "^http://127\\.0\\.0\\.1:\\d+/index\\.html"): Promise<void> {
  // cr-verify passes a pattern that also matches the preview root ("/"), where the runner starts.
  await app.evaluate(({ webContents }, pattern) => {
    const g = globalThis as unknown as { __crOutline?: { samples: Array<{ at: number; orange: number }>; stop?: boolean } };
    g.__crOutline = { samples: [] };
    const tick = async () => {
      const s = g.__crOutline!;
      if (s.stop) return;
      try {
        const wc = webContents.getAllWebContents().find((w) => new RegExp(pattern).test(w.getURL()));
        if (wc) {
          const img = await wc.capturePage();
          const { width, height } = img.getSize();
          const bmp = img.toBitmap();
          const scale = Math.sqrt(bmp.length / 4 / (width * height));
          const w = Math.round(width * scale), h = Math.round(height * scale);
          let orange = 0;
          const isOrange = (x: number, y: number) => { const i = (y * w + x) * 4; return bmp[i + 2] > 200 && bmp[i + 1] > 70 && bmp[i + 1] < 175 && bmp[i] < 90; };
          for (let y = 4; y < h - 4; y += 6) for (const x of [0, 1, 2, 3, w - 1, w - 2, w - 3, w - 4]) if (isOrange(x, y)) orange++;
          s.samples.push({ at: Date.now(), orange });
        }
      } catch { /* a frame that cannot be captured is not a sample */ }
      setTimeout(tick, 25);
    };
    void tick();
  }, urlPattern);
}
export async function stopOutlineSampler(app: ElectronApplication): Promise<Array<{ at: number; orange: number }>> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __crOutline?: { samples: Array<{ at: number; orange: number }>; stop?: boolean } };
    if (!g.__crOutline) return [];
    g.__crOutline.stop = true;
    return g.__crOutline.samples;
  });
}

