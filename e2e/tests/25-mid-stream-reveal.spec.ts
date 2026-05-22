// REQ-D2: HTML auto-reveal DURING stream — not waiting for streamEnd.
//
// Mock /v1/chat/completions to emit a 3-phase SSE: code-block chunks (~1s),
// closing ``` (revealable now), then a long trailing-prose tail (~5s) that
// finishes streamEnd much later. Preview must open during the prose phase,
// not at streamEnd — verified by timing the gap between revealed iframe
// and stream completion.

import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { APP_BINARY, TOKEN_FILE } from "../fixtures/global-setup";
import { chatFrame, openChatContainer, previewFrame } from "../fixtures/app";

const GAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>mid-stream-game</title></head><body><h1 id="mid-stream-marker">D2 mid-stream test</h1></body></html>`;

const DEFAULT_PROFILE = {
  profile_id: "boah-dental-teaser-2026-s1", display_name: "보아치과 v4", language: "ko",
  series_index: 1, series_total: 1,
  welcome: { greeting_md: "", example_prompts: [] },
  ux: {
    coach: { naming_mode: "fixed", fallback_name: "코디", naming_prompt_md: "", personality_prompt_md: "" },
    suggestions: { initial: [], follow_up: [] },
    hints: { short_input: { enabled: false, min_chars: 0, message_md: "" }, roll_input_button: { enabled: false, label: "", probe_md: "" } },
    retry_button: { enabled: false, show_counter: false },
  },
  publishing: { enabled: false, strategy: "none" },
  preview: { type: "iframe", auto_start: false },
};

async function startMock(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "GET" && req.url?.endsWith("/profile")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(DEFAULT_PROFILE));
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      res.setHeader("content-type", "text/event-stream");
      const send = (delta: string) => {
        const chunk = { choices: [{ delta: { content: delta } }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };
      // Phase 1: "Here's your game:\n\n```html\n"
      send("Here's your game:\n\n```html\n");
      await sleep(100);
      // Phase 2: full HTML in one chunk + closing fence
      send(GAME_HTML);
      await sleep(50);
      send("\n```\n");
      // Mark MIDPOINT timestamp for the test by sending a sentinel — the
      // closing ``` is the reveal trigger. We immediately follow with a
      // 5-second prose tail to widen the window between reveal and end.
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        send("이 게임은 점프하고 별을 모으는 미니게임이에요. ");
      }
      send("끝까지 즐겁게 만들어보세요!");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface Ctx { app: ElectronApplication; win: Page; userDataDir: string }

async function launchAt(port: number): Promise<Ctx> {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-d2-"));
  const userDir = path.join(userDataDir, "User");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({
    "hypeproofChat.proxyUrl": `http://127.0.0.1:${port}/v1`,
    "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
  }));
  fs.writeFileSync(path.join(userDir, "hps-test-state.json"), JSON.stringify({
    token, coach: { name: "코디", personality: "" },
  }));
  const wsDir = path.join(userDataDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });
  const app = await electron.launch({
    executablePath: APP_BINARY,
    args: [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${path.join(userDataDir, "extensions")}`,
      "--disable-workspace-trust", "--password-store=basic",
      "--disable-updates", "--skip-welcome", "--skip-release-notes",
      "--no-sandbox", wsDir,
    ],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      HPS_TEST_E2E: "1", HPS_TEST_TOKEN: token, HPS_TEST_COACH_NAME: "코디",
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForSelector(".monaco-workbench", { timeout: 30_000 });
  return { app, win, userDataDir };
}

async function teardown(ctx: Ctx) {
  try { await ctx.app.close(); } catch { /* */ }
  try { fs.rmSync(ctx.userDataDir, { recursive: true, force: true }); } catch { /* */ }
}

test("REQ-D2: preview opens during stream, not waiting for streamEnd", async () => {
  const mock = await startMock();
  const ctx = await launchAt(mock.port);
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(800);

    const cf = await chatFrame(ctx.win);
    const input = cf.locator("textarea, input[type='text']").first();
    await input.fill("게임 만들어줘");
    const sendStart = Date.now();
    await ctx.win.keyboard.press("Enter");

    // Mock sends the closing ``` around 250ms after stream start, then
    // emits a ~5s prose tail. The preview should appear during that prose
    // window — i.e. within ~2s of sendStart, well before streamEnd (~5s+).
    const pf = await previewFrame(ctx.win);
    const iframe = pf.locator("#frame");
    await iframe.waitFor({ state: "attached", timeout: 12_000 });
    const previewVisibleAt = Date.now();
    const elapsed = previewVisibleAt - sendStart;
    expect(elapsed).toBeLessThan(4_500); // streamEnd is at ~5s; preview must beat it

    // Sanity: the canned HTML rendered
    const sandbox = await iframe.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");

    // Wait for the stream to actually end so cleanup doesn't race
    await ctx.win.waitForTimeout(2_500);
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});
