// REQ-C-resilience — Network resilience (#117, scope-reduced).
//
// PR #118 (REQ-C6·C8) covered: stream cancel + request_id surfacing on 503.
// Remaining from #117:
//   - Abrupt mid-stream disconnect (peer closes socket) → user sees error
//   - Retry after disconnect → next message succeeds
//   - 5xx error banner has Korean user copy (separate from request_id)
//
// Cold-start latency observation + 60s hard timeout copy needed product
// confirmation; left for a follow-up if not yet wired.

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
  setMode: (m: MockMode) => void;
}

type MockMode =
  | { kind: "drop_mid_stream"; chunkCount: number; intervalMs: number; profileBody?: unknown }
  | { kind: "fail_500_korean"; profileBody?: unknown }
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
    res.setHeader("access-control-allow-origin", "*");

    if (req.method === "GET" && req.url?.endsWith("/profile")) {
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify(mode.profileBody ?? DEFAULT_PROFILE));
      return;
    }

    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      if (mode.kind === "drop_mid_stream") {
        // Start a SSE stream, send a couple of chunks, then abruptly destroy
        // the socket to simulate a network drop.
        const chunkCount = mode.chunkCount;
        const intervalMs = mode.intervalMs;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.statusCode = 200;
        let i = 0;
        const interval = setInterval(() => {
          i++;
          const chunk = {
            id: `chat-${i}`,
            choices: [{ delta: { content: `청크 ${i} ` }, finish_reason: null, index: 0 }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (i >= chunkCount) {
            clearInterval(interval);
            // Drop without sending [DONE] or finish_reason. Destroying the
            // underlying socket is what simulates a real connection loss.
            res.socket?.destroy();
          }
        }, intervalMs);
        return;
      }

      if (mode.kind === "fail_500_korean") {
        res.setHeader("content-type", "application/json");
        res.setHeader("x-request-id", "rid-net-500-test");
        res.statusCode = 500;
        // Korean user-facing message — what the worker SHOULD send on upstream errors.
        res.end(
          JSON.stringify({
            error: {
              message: "잠시 연결이 불안정해요. 잠시 후 다시 시도해주세요.",
              type: "upstream",
              code: "anthropic_5xx",
            },
          }),
        );
        return;
      }

      if (mode.kind === "fast_ok") {
        res.setHeader("content-type", "text/event-stream");
        res.statusCode = 200;
        const chunk = {
          id: "chat-fast",
          choices: [{ delta: { content: mode.reply }, finish_reason: null, index: 0 }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        const done = {
          id: "chat-fast",
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
        };
        res.write(`data: ${JSON.stringify(done)}\n\n`);
        res.write(`data: [DONE]\n\n`);
        res.end();
        return;
      }
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    setMode: (m) => {
      mode = m;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

interface LaunchedCtx {
  app: ElectronApplication;
  win: Page;
  userDataDir: string;
}

async function launchPointedAtMock(port: number): Promise<LaunchedCtx> {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-net-"));
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

// ─────────────────────────────────────────────────────────────────────────
// 1. Mid-stream connection drop → error banner appears, can retry
// ─────────────────────────────────────────────────────────────────────────

test("mid-stream drop → error banner + retry succeeds", async () => {
  const mock = await startMockServer({ kind: "drop_mid_stream", chunkCount: 3, intervalMs: 300 });
  const ctx = await launchPointedAtMock(mock.port);
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(800);

    await sendMessage(ctx.win, "응답 끊김 테스트");

    const frame = await chatFrame(ctx.win);
    // Wait for at least one chunk to land (proves stream started)
    await frame.locator("body:has-text('청크 1')").waitFor({ timeout: 10_000 });

    // After the mock destroys the socket, an error banner should surface.
    // (Studio may also auto-mark the assistant message as failed; either path
    // is acceptable — we just need a user-visible failure signal.)
    const errorSignal = frame.locator(
      ".hps-error-banner, .hps-msg-failed, [data-state='error'], .hps-error",
    );
    await errorSignal.first().waitFor({ state: "visible", timeout: 15_000 });

    // Now flip to fast_ok and verify a fresh send works
    mock.setMode({ kind: "fast_ok", reply: "재시도 응답 OK" });
    await sendMessage(ctx.win, "다시 시도");
    await frame.locator("body:has-text('재시도 응답 OK')").waitFor({ timeout: 15_000 });
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 5xx response carries Korean user copy in the banner body
// ─────────────────────────────────────────────────────────────────────────

test("5xx response → 한국어 user copy in error banner", async () => {
  const mock = await startMockServer({ kind: "fail_500_korean" });
  const ctx = await launchPointedAtMock(mock.port);
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(800);

    await sendMessage(ctx.win, "에러 유도");

    const frame = await chatFrame(ctx.win);
    const banner = frame.locator(".hps-error-banner");
    await banner.waitFor({ state: "visible", timeout: 15_000 });

    // The banner SHOULD include a Korean user message — either the worker's
    // localized copy or a Studio-side fallback. What we ban is a raw English
    // dump like "Internal Server Error" being the only text.
    const bannerText = (await banner.innerText().catch(() => "")) ?? "";
    expect(bannerText.length).toBeGreaterThan(0);
    const hasKoreanCopy = /다시|잠시|연결|불안정|오류|문제|실패|시간/.test(bannerText);
    const onlyEnglish = /^Internal Server Error|^Bad Gateway|^Service Unavailable/.test(
      bannerText.trim(),
    );
    expect(hasKoreanCopy, `banner missing Korean copy: ${bannerText}`).toBe(true);
    expect(onlyEnglish, `banner shows raw upstream: ${bannerText}`).toBe(false);
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Cold-start observation — first chunk should arrive within 10s
//    Skipped by default because cold-start latency depends on the runner.
//    Enable with HPS_TEST_COLDSTART=1 when verifying on a fresh deploy.
// ─────────────────────────────────────────────────────────────────────────

test("cold-start: first token arrives within 10s @optional", async ({}, testInfo) => {
  if (!process.env.HPS_TEST_COLDSTART) {
    testInfo.skip(true, "set HPS_TEST_COLDSTART=1 to run cold-start observation");
    return;
  }
  const mock = await startMockServer({ kind: "fast_ok", reply: "first" });
  const ctx = await launchPointedAtMock(mock.port);
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(800);

    const t0 = Date.now();
    await sendMessage(ctx.win, "cold-start measurement");
    const frame = await chatFrame(ctx.win);
    await frame.locator("body:has-text('first')").waitFor({ timeout: 10_000 });
    const dt = Date.now() - t0;
    expect(dt, `cold-start first token too slow: ${dt}ms`).toBeLessThan(10_000);
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});
