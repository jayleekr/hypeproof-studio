// Shared app launcher fixture. Each test gets a fresh user-data-dir and a
// pre-written settings file pointing at the local wrangler dev server.

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_BINARY, TOKEN_FILE } from "./global-setup";

export interface AppContext {
  app: ElectronApplication;
  win: Page;
  userDataDir: string;
  token: string;
}

export interface LaunchOptions {
  /** Pre-seed the workshop token into SecretStorage via env var (test backdoor). */
  preseedToken?: boolean;
  /** Pre-seed coach name + personality so the naming ritual doesn't pop. */
  preseedCoach?: { name: string; personality?: string };
}

export async function launchApp(opts: LaunchOptions = { preseedToken: true }): Promise<AppContext> {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-"));
  const userDir = path.join(userDataDir, "User");
  fs.mkdirSync(userDir, { recursive: true });

  // Pre-seed settings: local wrangler URL, no telemetry, no welcome page.
  fs.writeFileSync(
    path.join(userDir, "settings.json"),
    JSON.stringify(
      {
        "hypeproofChat.proxyUrl": "http://localhost:8787/v1",
        "workbench.startupEditor": "none",
        "telemetry.telemetryLevel": "off",
        "update.mode": "none",
        "workbench.tips.enabled": false,
        "workbench.welcomePage.walkthroughs.openOnInstall": false,
      },
      null,
      2,
    ),
  );

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  };
  if (opts.preseedToken !== false) {
    env.HPS_TEST_TOKEN = token;
  }
  if (opts.preseedCoach) {
    env.HPS_TEST_COACH_NAME = opts.preseedCoach.name;
    if (opts.preseedCoach.personality) {
      env.HPS_TEST_COACH_PERSONALITY = opts.preseedCoach.personality;
    }
  }

  // Also write the file backdoor — env vars don't always reach the extension
  // host, but a file in the user-data-dir does.
  const testState: { token?: string; coach?: { name: string; personality: string } } = {};
  if (opts.preseedToken !== false) testState.token = token;
  if (opts.preseedCoach) {
    testState.coach = {
      name: opts.preseedCoach.name,
      personality: opts.preseedCoach.personality ?? "",
    };
  }
  fs.writeFileSync(path.join(userDir, "hps-test-state.json"), JSON.stringify(testState));

  // Pre-create + open a workspace folder so the extension's ensureWorkspace()
  // sees a folder already open and does NOT trigger a window reload (which
  // would destabilize Playwright's window handle).
  const wsDir = path.join(userDataDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  const app = await electron.launch({
    executablePath: APP_BINARY,
    args: [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${path.join(userDataDir, "extensions")}`,
      "--disable-workspace-trust",
      "--password-store=basic",       // secrets stored in user-data-dir, not keychain
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-sandbox",
      wsDir,                          // open this folder → no reload
    ],
    env,
    timeout: 30_000,
  });

  const win = await app.firstWindow({ timeout: 30_000 });
  // Wait for workbench to be ready (presence of activity bar)
  await win.waitForSelector(".monaco-workbench", { timeout: 30_000 });

  return { app, win, userDataDir, token };
}

export async function closeApp(ctx: AppContext): Promise<void> {
  try {
    await ctx.app.close();
  } catch {
    /* ignore — test may have left the app in a bad state */
  }
  try {
    fs.rmSync(ctx.userDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Open the command palette and run a command by its label, then return the
 * input element so callers can type the next thing (e.g. token).
 */
export async function runCommand(win: Page, label: string): Promise<void> {
  // Command palette: Cmd+Shift+P on Mac
  await win.keyboard.press("Meta+Shift+P");
  const input = win.locator(".quick-input-widget input.input").first();
  await input.waitFor({ state: "visible", timeout: 5_000 });
  await input.fill(`>${label}`);
  // Wait briefly for the filter to settle
  await win.waitForTimeout(150);
  await win.keyboard.press("Enter");
}

/** Open + select the HypeProof Chat container (idempotent — safe if already open). */
export async function openChatContainer(win: Page): Promise<void> {
  // Try several selectors — VS Code's activitybar DOM varies a bit by version.
  const selectors = [
    '.activitybar [aria-label*="HypeProof"]',
    '.activitybar [title*="HypeProof"]',
    '[role="tab"][aria-label*="HypeProof"]',
  ];
  for (const sel of selectors) {
    const item = win.locator(sel).first();
    if ((await item.count()) > 0 && (await item.isVisible().catch(() => false))) {
      await item.click().catch(() => undefined);
      return;
    }
  }
  // Fallback: command palette.
  await runCommand(win, "View: Show HypeProof Chat");
}

/**
 * Wait for the chat webview's content frame to be attached and return a
 * FrameLocator pointing at it. VS Code wraps every webview in an outer
 * security iframe + an inner #active-frame.
 */
export async function chatFrame(win: Page) {
  // The chat sidebar webview renders before any editor-area preview panel,
  // so the first webview iframe is the chat one. (Validated across 14 runs.)
  const outerSel = "iframe.webview.ready";
  await win.locator(outerSel).first().waitFor({ state: "attached", timeout: 20_000 });
  return win.frameLocator(outerSel).first().frameLocator("#active-frame");
}

/** The game preview now lives in the editor area (a WebviewPanel). It is the
 *  webview whose inner document contains our preview iframe (#frame). */
export async function previewFrame(win: Page) {
  const outerSel = "iframe.webview.ready";
  // Preview opens after the chat webview, so it's the last one.
  await win.locator(outerSel).last().waitFor({ state: "attached", timeout: 20_000 });
  return win.frameLocator(outerSel).last().frameLocator("#active-frame");
}
