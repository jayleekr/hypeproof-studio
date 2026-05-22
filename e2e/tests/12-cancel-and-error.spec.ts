// REQ-C6 stream cancel + REQ-C8 request_id in error banner (#93).
//
// We spin up an ephemeral HTTP server per test that pretends to be the
// HypeProof proxy. settings.json points hypeproofChat.proxyUrl at it.
//
// - For cancel: server returns an OpenAI-shaped SSE stream that chunks
//   slowly. Spec sends a message, waits for the first chunk, clicks the
//   Stop button, then sends a second message and verifies it works.
//
// - For request_id: server returns 503 with x-request-id: <known-id>.
//   Spec sends a message, then asserts the error banner DOM contains the id.

import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { APP_BINARY, TOKEN_FILE } from "../fixtures/global-setup";
import { chatFrame, openChatContainer } from "../fixtures/app";

interface MockServer {
  port: number;
  close: () => Promise<void>;
  /** Set how the next /chat/completions call should respond. */
  setMode: (m: MockMode) => void;
}

type MockMode =
  | { kind: "slow_stream"; chunkCount: number; intervalMs: number; profileBody?: unknown }
  | { kind: "fail_503"; requestId: string; profileBody?: unknown }
  | { kind: "fast_ok"; reply: string; profileBody?: unknown };

const DEFAULT_PROFILE = {
  profile_id: "boah-dental-teaser-2026-s1",
  display_name: "보아치과 v4",
  language: "ko",
  series_index: 1,
  series_total: 1,
  welcome: { greeting_md: "안녕!", example_prompts: [] },
  ux: {
    coach: { naming_mode: "fixed", fallback_name: "코디", naming_prompt_md: "", personality_prompt_md: "" },
    suggestions: { initial: [], follow_up: [] },
    hints: {
      short_input: { enabled: false, min_chars: 0, message_md: "" },
      roll_input_button: { enabled: false, label: "", probe_md: "" },
    },
    retry_button: { enabled: false, show_counter: false },
  },
  publishing: { enabled: false, strategy: "none" },
  preview: { type: "iframe", auto_start: false },
};

async function startMockServer(initialMode: MockMode): Promise<MockServer> {
  let mode: MockMode = initialMode;

  const server = http.createServer((req, res) => {
    // CORS-y headers — not strictly needed inside Electron but harmless.
    res.setHeader("access-control-allow-origin", "*");

    if (req.method === "GET" && req.url?.endsWith("/profile")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(mode.profileBody ?? DEFAULT_PROFILE));
      return;
    }

    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      if (mode.kind === "fail_503") {
        res.setHeader("x-request-id", mode.requestId);
        res.setHeader("content-type", "application/json");
        res.statusCode = 503;
        res.end(JSON.stringify({ error: { message: "upstream unavailable", type: "transport" } }));
        return;
      }
      if (mode.kind === "fast_ok") {
        res.setHeader("content-type", "text/event-stream");
        const chunk = {
          choices: [{ delta: { content: mode.reply } }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      // slow_stream
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      const { chunkCount, intervalMs } = mode;
      let i = 0;
      const tick = () => {
        if (req.destroyed || res.writableEnded) return;
        if (i >= chunkCount) {
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        i++;
        const chunk = { choices: [{ delta: { content: `청크 ${i} ` } }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        setTimeout(tick, intervalMs);
      };
      tick();
      return;
    }

    if (req.method === "GET" && req.url?.endsWith("/health")) {
      res.end("ok");
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    setMode: (m) => { mode = m; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface LaunchedCtx {
  app: ElectronApplication;
  win: Page;
  userDataDir: string;
}

async function launchPointedAtMock(port: number): Promise<LaunchedCtx> {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-cancel-"));
  const userDir = path.join(userDataDir, "User");
  fs.mkdirSync(userDir, { recursive: true });

  fs.writeFileSync(
    path.join(userDir, "settings.json"),
    JSON.stringify({
      "hypeproofChat.proxyUrl": `http://127.0.0.1:${port}/v1`,
      "workbench.startupEditor": "none",
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
    }),
  );

  fs.writeFileSync(
    path.join(userDir, "hps-test-state.json"),
    JSON.stringify({ token, coach: { name: "코디", personality: "" } }),
  );

  const wsDir = path.join(userDataDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  const app = await electron.launch({
    executablePath: APP_BINARY,
    args: [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${path.join(userDataDir, "extensions")}`,
      "--disable-workspace-trust",
      "--password-store=basic",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-sandbox",
      wsDir,
    ],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      HPS_TEST_TOKEN: token,
      HPS_TEST_COACH_NAME: "코디",
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForSelector(".monaco-workbench", { timeout: 30_000 });
  return { app, win, userDataDir };
}

async function teardown(ctx: LaunchedCtx) {
  try { await ctx.app.close(); } catch { /* ignore */ }
  try { fs.rmSync(ctx.userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function sendMessage(win: Page, text: string): Promise<void> {
  const frame = await chatFrame(win);
  const input = frame.locator("textarea, input[type='text']").first();
  await input.fill(text);
  await win.keyboard.press("Enter");
}

test("REQ-C6: mid-stream cancel stops chunks; next message succeeds", async () => {
  const mock = await startMockServer({ kind: "slow_stream", chunkCount: 20, intervalMs: 400 });
  const ctx = await launchPointedAtMock(mock.port);
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(800);

    // 1) Start a slow stream
    await sendMessage(ctx.win, "긴 응답을 줘");

    // Wait for the first chunk to appear (proves stream started)
    const frame = await chatFrame(ctx.win);
    await frame.locator("body:has-text('청크 1')").waitFor({ timeout: 10_000 });

    // 2) Mid-stream cancel
    const stopBtn = frame.locator(".hps-btn-stop");
    await stopBtn.click({ timeout: 5_000 });

    // Capture content at cancel time
    await ctx.win.waitForTimeout(800);
    const atCancel = ((await frame.locator("body").innerText().catch(() => "")) ?? "");
    const chunksAtCancel = (atCancel.match(/청크\s*\d+/g) ?? []).length;
    expect(chunksAtCancel).toBeGreaterThan(0);
    expect(chunksAtCancel).toBeLessThan(20); // didn't reach the end

    // 3) Switch the mock to fast OK and send again — must succeed
    mock.setMode({ kind: "fast_ok", reply: "두 번째 응답 OK" });
    await sendMessage(ctx.win, "다시 시도");
    await frame.locator("body:has-text('두 번째 응답 OK')").waitFor({ timeout: 15_000 });
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});

test("REQ-C8: 5xx with x-request-id surfaces the id in the error banner", async () => {
  const RID = "deadbeefcafe1234";
  const mock = await startMockServer({ kind: "fail_503", requestId: RID });
  const ctx = await launchPointedAtMock(mock.port);
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(800);

    await sendMessage(ctx.win, "에러 유도");

    const frame = await chatFrame(ctx.win);
    const banner = frame.locator(".hps-error-banner");
    await banner.waitFor({ state: "visible", timeout: 15_000 });

    const ridCell = frame.locator(".hps-error-banner-rid");
    await expect(ridCell).toContainText(RID, { timeout: 5_000 });
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});
