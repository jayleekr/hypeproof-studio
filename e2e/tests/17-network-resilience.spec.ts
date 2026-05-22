// Network resilience (#117). Stream interruption, Anthropic 5xx, 429,
// timeout — verify the error banner shows up with non-empty user copy so
// a kid in a flaky wifi room isn't stuck with a silent dead UI.
//
// Pattern: mock-server-per-test (see 12-cancel-and-error.spec.ts for the
// same approach). Cases that need product changes not yet landed are
// `test.skip` with a comment pointing to the follow-up issue.

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
  | { kind: "slow_stream"; chunkCount: number; intervalMs: number }
  | { kind: "fail_status"; status: number; requestId?: string; bodyMessage?: string }
  | { kind: "fast_ok"; reply: string }
  | { kind: "never_respond" };       // for timeout test — just hangs

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
      res.end(JSON.stringify(DEFAULT_PROFILE));
      return;
    }

    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      if (mode.kind === "fail_status") {
        if (mode.requestId) res.setHeader("x-request-id", mode.requestId);
        res.setHeader("content-type", "application/json");
        res.statusCode = mode.status;
        res.end(JSON.stringify({
          error: {
            message: mode.bodyMessage ?? `mocked ${mode.status}`,
            type: "transport",
          },
        }));
        return;
      }
      if (mode.kind === "fast_ok") {
        res.setHeader("content-type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: mode.reply } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (mode.kind === "never_respond") {
        // Hang forever (test will tear down)
        return;
      }
      // slow_stream
      res.setHeader("content-type", "text/event-stream");
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
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `청크 ${i} ` } }] })}\n\n`);
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

async function launchPointedAt(port: number): Promise<LaunchedCtx> {
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

async function errorBannerVisible(win: Page, timeoutMs = 15_000): Promise<boolean> {
  const frame = await chatFrame(win);
  try {
    await frame.locator(".hps-error-banner").waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

test.skip("Stream cut mid-response — error banner appears, retry succeeds", async () => {
  // Playwright's BrowserContext.setOffline(true) doesn't reliably terminate
  // in-flight fetch() calls in Electron's main-process renderer (CDP toggle
  // only applies to new requests; an open SSE stream stays alive on the
  // socket layer). Verified by run on 2026-05-22 against this build: stream
  // continued chunking past setOffline, no error banner surfaced.
  //
  // Two avenues for a real test:
  //   1) Kill the mock server's TCP connection mid-response (mock.destroyAll()
  //      via an extra knob) — proves the host surfaces a banner when fetch
  //      errors mid-stream.
  //   2) Wait for product-level auto-reconnect to land (separately deferred
  //      below), then test the full happy reconnect.
  //
  // Left skipped to flag the gap rather than silently delete the case.
  const mock = await startMockServer({ kind: "slow_stream", chunkCount: 20, intervalMs: 400 });
  const ctx = await launchPointedAt(mock.port);
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(800);
    await sendMessage(ctx.win, "긴 응답을 줘");
    const frame = await chatFrame(ctx.win);
    await frame.locator("body:has-text('청크 1')").waitFor({ timeout: 10_000 });
    await ctx.app.context().setOffline(true);
    expect(await errorBannerVisible(ctx.win, 15_000)).toBe(true);
    await ctx.app.context().setOffline(false);
    mock.setMode({ kind: "fast_ok", reply: "복구 성공" });
    await sendMessage(ctx.win, "다시 시도");
    await frame.locator("body:has-text('복구 성공')").waitFor({ timeout: 15_000 });
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});

test("Upstream 5xx — generic transport copy in banner", async () => {
  const mock = await startMockServer({
    kind: "fail_status",
    status: 502,
    requestId: "rid-5xx-test",
    bodyMessage: "upstream bad gateway",
  });
  const ctx = await launchPointedAt(mock.port);
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(800);
    await sendMessage(ctx.win, "5xx 유도");
    expect(await errorBannerVisible(ctx.win, 15_000)).toBe(true);
    // The proxyClient currently sends a generic ProxyTransportError on 5xx;
    // banner shows that string. We only assert it's non-empty + has the rid.
    const frame = await chatFrame(ctx.win);
    const banner = frame.locator(".hps-error-banner");
    const text = (await banner.innerText()) ?? "";
    expect(text.trim().length).toBeGreaterThan(0);
    await expect(frame.locator(".hps-error-banner-rid")).toContainText("rid-5xx-test");
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});

test("Upstream 429 — error banner surfaces with rate-limit shape", async () => {
  // proxyClient classifies 401/403; 429 falls into ProxyTransportError.
  // Verify the banner appears and includes the request id if provided.
  const mock = await startMockServer({
    kind: "fail_status",
    status: 429,
    requestId: "rid-429-test",
    bodyMessage: "too many requests",
  });
  const ctx = await launchPointedAt(mock.port);
  try {
    await openChatContainer(ctx.win);
    await ctx.win.waitForTimeout(800);
    await sendMessage(ctx.win, "429 유도");
    expect(await errorBannerVisible(ctx.win, 15_000)).toBe(true);
    const frame = await chatFrame(ctx.win);
    await expect(frame.locator(".hps-error-banner-rid")).toContainText("rid-429-test");
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});

test.skip(
  "Auto-reconnect after setOffline(false) — needs product change (deferred)",
  async () => {
    // The chat panel does not currently auto-retry the failed stream when the
    // network comes back. The user has to click Retry. Until product lands
    // an "on online → re-issue last send" behavior, this stays skipped.
    // Follow-up: file as a sub-issue of #108 if Jay wants auto-recover.
  },
);

test.skip(
  "Worker cold-start latency ≤ 10s — not deterministically testable",
  async () => {
    // Worker cold-start is a property of Cloudflare's free tier, not of our
    // code. The rehearsal R1.x latency checks are the closest we get; e2e
    // can't force a cold start.
  },
);

test.skip(
  "60s explicit timeout — needs product change (proxyClient has no timeout)",
  async () => {
    // proxyClient.proxyChat uses fetch without an AbortController-bound
    // timeout. A 60s ceiling needs to land in proxyClient first; this test
    // pins what would be asserted after.
  },
);
