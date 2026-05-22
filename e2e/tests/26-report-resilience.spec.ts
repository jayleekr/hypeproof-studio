// REQ-H6: report path stays alive when chat is broken.
//
// Mock: /v1/chat/completions returns 500 (chat dead) but /v1/report accepts
// reports normally. Run the reportProblem command's 3-step QuickInput
// cascade. Verify the mock received the POST and returned 200 — proving
// the host's report path doesn't share a fate with the chat path.

import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { APP_BINARY, TOKEN_FILE } from "../fixtures/global-setup";
import { runCommand } from "../fixtures/app";

interface ReceivedReport { description: string; profile_id?: string; contact?: string }

async function startMock(): Promise<{ port: number; close: () => Promise<void>; received: ReceivedReport[] }> {
  const received: ReceivedReport[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");

    if (req.method === "GET" && req.url?.endsWith("/profile")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        profile_id: "boah-dental-teaser-2026-s1",
        display_name: "보아치과 v4", language: "ko", series_index: 1, series_total: 1,
        welcome: { greeting_md: "", example_prompts: [] },
        ux: {
          coach: { naming_mode: "fixed", fallback_name: "코디", naming_prompt_md: "", personality_prompt_md: "" },
          suggestions: { initial: [], follow_up: [] },
          hints: { short_input: { enabled: false, min_chars: 0, message_md: "" }, roll_input_button: { enabled: false, label: "", probe_md: "" } },
          retry_button: { enabled: false, show_counter: false },
        },
        publishing: { enabled: false, strategy: "none" },
        preview: { type: "iframe", auto_start: false },
      }));
      return;
    }

    // Chat is DEAD.
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "chat dead", type: "transport" } }));
      return;
    }

    // Report endpoint STAYS ALIVE.
    if (req.method === "POST" && req.url?.endsWith("/report")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as ReceivedReport;
          received.push(parsed);
        } catch { /* ignore */ }
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({ report_id: "rep_test_h6_ok" }));
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
    received,
  };
}

interface Ctx { app: ElectronApplication; win: Page; userDataDir: string }

async function launchAt(port: number): Promise<Ctx> {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-h6-"));
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

async function fillQuickInput(win: Page, value: string): Promise<void> {
  const input = win.locator(".quick-input-widget input.input").first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.press("Meta+a").catch(() => undefined);
  await input.press("Delete").catch(() => undefined);
  await input.fill(value);
  await win.keyboard.press("Enter");
}

async function pickQuickPick(win: Page, labelIncludes: RegExp): Promise<void> {
  // QuickPick (the recent-turns step) — wait for the list, click the item.
  const list = win.locator(".quick-input-widget .quick-input-list").first();
  await list.waitFor({ state: "visible", timeout: 10_000 });
  const item = win.locator(".quick-input-widget .quick-input-list-row").filter({ hasText: labelIncludes }).first();
  await item.click({ timeout: 5_000 });
}

test("REQ-H6: report path stays alive when chat is broken", async () => {
  const mock = await startMock();
  const ctx = await launchAt(mock.port);
  try {
    // Wait for activation
    await ctx.win.waitForTimeout(2_500);

    // Run the report-problem command
    await runCommand(ctx.win, "HypeProof Chat: 문제 신고하기");

    // Step 1: description (must be ≥10 chars per validateInput)
    await fillQuickInput(ctx.win, "H6 e2e probe: chat is dead but report should still work — please ignore on triage.");

    // Step 2: recent_turns? Pick the "포함하지 않기" option
    await pickQuickPick(ctx.win, /포함하지 않기/);

    // Step 3: contact (optional) — submit empty
    await fillQuickInput(ctx.win, "");

    // The mock /v1/report should have received the submission.
    await expect.poll(
      () => mock.received.length,
      { timeout: 15_000, intervals: [500, 500, 1000] },
    ).toBeGreaterThanOrEqual(1);

    const r = mock.received[0]!;
    expect(r.description).toContain("H6 e2e probe");
  } finally {
    await teardown(ctx);
    await mock.close();
  }
});
