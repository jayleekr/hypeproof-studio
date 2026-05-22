// REQ-G5: minted token copied to clipboard + expiry shown in toast.
// REQ-G6: forgetIssuerToken command deletes the stored issuer secret.
//
// Strategy: mock the worker's /admin/tokens/issue endpoint via a small
// http.createServer; point hypeproofChat.proxyUrl at it. Pre-seed an
// issuer token via the test backdoor (G5+G6). For G5, run mint, walk the
// 5-step QuickInput cascade, then read the clipboard via Electron's main
// process. For G6, run forgetIssuerToken, then run mint again and verify
// the issuer-token prompt re-appears.

import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { APP_BINARY, TOKEN_FILE } from "../fixtures/global-setup";
import { runCommand } from "../fixtures/app";

// Minimal valid issuer-token payload (HS256-style 3-segment shape, payload
// has cohort scope c="boah-dental-2026-a"). Signature segment is arbitrary
// — the extension only decodes the payload locally; the worker is mocked.
const ISSUER_PAYLOAD = Buffer.from(JSON.stringify({
  jti: "test-issuer-jti",
  c: "boah-dental-2026-a",
  role: "issuer",
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString("base64url");
const FAKE_ISSUER = `eyJ.${ISSUER_PAYLOAD}.fakesig`;

const MINTED_TOKEN = "eyJ.minted-student-token-payload.minted-sig";
const MINTED_EXP = Math.floor(Date.now() / 1000) + 7200; // +2h

async function startMockAdmin(): Promise<{ port: number; close: () => Promise<void>; setFail: (b: boolean) => void }> {
  let failNext = false;
  const server = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "GET" && req.url?.endsWith("/profile")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        profile_id: "boah-dental-teaser-2026-s1",
        display_name: "보아치과 v4",
        language: "ko",
        series_index: 1, series_total: 1,
        welcome: { greeting_md: "", example_prompts: [] },
        ux: {
          coach: { naming_mode: "fixed", fallback_name: "코치", naming_prompt_md: "", personality_prompt_md: "" },
          suggestions: { initial: [], follow_up: [] },
          hints: { short_input: { enabled: false, min_chars: 0, message_md: "" }, roll_input_button: { enabled: false, label: "", probe_md: "" } },
          retry_button: { enabled: false, show_counter: false },
        },
        publishing: { enabled: false, strategy: "none" },
        preview: { type: "iframe", auto_start: false },
      }));
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/admin/tokens/issue")) {
      if (failNext) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "test forced fail" }));
        return;
      }
      // Read body (we ignore it but consume the stream).
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ token: MINTED_TOKEN, jti: "test-mint-jti", exp: MINTED_EXP }));
      });
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
    setFail: (b) => { failNext = b; },
  };
}

interface MintCtx {
  app: ElectronApplication;
  win: Page;
  userDataDir: string;
}

async function launchAtMock(port: number, opts: { preseedIssuer?: string } = {}): Promise<MintCtx> {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-mint-"));
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
  const testState: Record<string, unknown> = {
    token,
    coach: { name: "코치", personality: "" },
  };
  if (opts.preseedIssuer) testState.issuerToken = opts.preseedIssuer;
  fs.writeFileSync(path.join(userDir, "hps-test-state.json"), JSON.stringify(testState));

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
      HPS_TEST_E2E: "1",
      HPS_TEST_TOKEN: token,
      HPS_TEST_COACH_NAME: "코치",
      ...(opts.preseedIssuer ? { HPS_TEST_ISSUER_TOKEN: opts.preseedIssuer } : {}),
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForSelector(".monaco-workbench", { timeout: 30_000 });
  return { app, win, userDataDir };
}

async function teardown(ctx: MintCtx) {
  try { await ctx.app.close(); } catch { /* ignore */ }
  try { fs.rmSync(ctx.userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function fillQuickInput(win: Page, value: string): Promise<void> {
  const input = win.locator(".quick-input-widget input.input").first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  // The input may have prefilled text — clear with select-all + delete.
  await input.press("Meta+a").catch(() => undefined);
  await input.press("Delete").catch(() => undefined);
  await input.fill(value);
  await win.keyboard.press("Enter");
}

test("REQ-G5: mint command writes the new token to the clipboard", async () => {
  const mock = await startMockAdmin();
  const ctx = await launchAtMock(mock.port, { preseedIssuer: FAKE_ISSUER });
  try {
    // Wait for activation to finish (backdoor stores issuer).
    await ctx.win.waitForTimeout(1_500);

    await runCommand(ctx.win, "HypeProof Chat: 학생 토큰 발급");

    // Walk the 5-step QuickInput cascade. Issuer is preseeded → first step
    // is cohort (default already filled from issuer payload), then profile,
    // then user, then hours.
    await fillQuickInput(ctx.win, "boah-dental-2026-a");           // cohort
    await fillQuickInput(ctx.win, "boah-dental-teaser-2026-s1");   // profile
    await fillQuickInput(ctx.win, "test-student-01");              // user
    await fillQuickInput(ctx.win, "2");                            // hours

    // Wait a beat for the POST + clipboard write.
    await expect.poll(
      async () => {
        return await ctx.app.evaluate(({ clipboard }) => clipboard.readText());
      },
      { timeout: 15_000, intervals: [500, 500, 1000] },
    ).toBe(MINTED_TOKEN);
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});

test("REQ-G6: forgetIssuerToken clears the stored secret", async () => {
  const mock = await startMockAdmin();
  const ctx = await launchAtMock(mock.port, { preseedIssuer: FAKE_ISSUER });
  try {
    await ctx.win.waitForTimeout(1_500);

    // Run forget command
    await runCommand(ctx.win, "HypeProof Chat: 저장된 issuer 토큰 지우기");

    // Now run mint — should prompt for issuer (first cascade step), proving
    // secret was cleared.
    await ctx.win.waitForTimeout(800);
    await runCommand(ctx.win, "HypeProof Chat: 학생 토큰 발급");

    const input = ctx.win.locator(".quick-input-widget input.input").first();
    await input.waitFor({ state: "visible", timeout: 10_000 });

    // The QuickInput title for the issuer-paste step contains "issuer 토큰"
    // and a placeholder mentioning "eyJjIjoi…".
    // We can read the title from the .quick-input-titlebar.
    const title = ctx.win.locator(".quick-input-titlebar").first();
    await title.waitFor({ state: "visible", timeout: 5_000 });
    const titleText = (await title.innerText().catch(() => "")) ?? "";
    expect(titleText).toMatch(/강사 issuer 토큰/);

    await ctx.win.keyboard.press("Escape");
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});
