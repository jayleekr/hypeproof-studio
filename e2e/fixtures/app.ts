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
  /** The workspace folder opened on launch — tests writing artifacts (REQ-D5)
   *  read from here. */
  wsDir: string;
}

export interface SeedHistoryTurn {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
}

export interface LaunchOptions {
  /** Pre-seed the workshop token into SecretStorage via env var (test backdoor). */
  preseedToken?: boolean;
  /** Pre-seed coach name + personality so the naming ritual doesn't pop. */
  preseedCoach?: { name: string; personality?: string };
  /** Pre-seed chat history into workspaceState — bypass the LLM for tests
   *  exercising preview / reload paths. */
  preseedHistory?: SeedHistoryTurn[];
  /** Pre-seed an issuer token into SecretStorage for mint-flow tests (G5/G6). */
  preseedIssuerToken?: string;
}

/**
 * Quiet mode (#e2e-quiet) — keep the Electron window off Jay's screen so a
 * local GUI run doesn't interrupt him. On by default; `HPS_QUIET=0` opts out
 * for headed debugging.
 *
 * Strategy (macOS), applied in the Electron MAIN process via `app.evaluate`:
 *   (a) `app.dock.hide()` — no bouncing dock icon.
 *   (b) move every BrowserWindow to (-4000,-4000) and `showInactive()` — the
 *       window stays *shown* (so the renderer is NOT occlusion-throttled and
 *       CDP waits stay stable) but is off every physical display and never
 *       steals focus. Hook `browser-window-created` so windows spawned after
 *       launch (VS Code can recreate) get stashed too.
 *   (c) after the workbench is ready, `app.hide()` so macOS returns focus to
 *       whatever Jay was doing — UNLESS `HPS_QUIET_NO_HIDE=1`, the escape hatch
 *       if hide-throttling ever destabilizes waits (off-screen alone is enough
 *       to be invisible).
 *
 * Playwright drives everything over CDP, which captures the offscreen/hidden
 * surface directly, so DOM interaction and `page.screenshot` keep working.
 */
const QUIET = process.env.HPS_QUIET !== "0";

async function applyQuietMode(app: ElectronApplication): Promise<void> {
  if (!QUIET) return;
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    try {
      (electronApp as unknown as { dock?: { hide(): void } }).dock?.hide();
    } catch {
      /* non-macOS or already hidden */
    }
    type Win = {
      setPosition(x: number, y: number): void;
      showInactive?(): void;
      once?(ev: string, cb: () => void): void;
      on?(ev: string, cb: () => void): void;
    };
    const stash = (w: Win) => {
      try {
        w.setPosition(-4000, -4000);
        w.showInactive?.();
      } catch {
        /* window torn down mid-call */
      }
    };
    // VS Code re-centers its window shortly after creation (measured: it
    // overrode our -4000 back to an on-screen position). Re-stash on every
    // surfacing event so it never actually lands on a physical display.
    const wire = (w: Win) => {
      stash(w);
      try {
        w.once?.("ready-to-show", () => stash(w));
        w.on?.("show", () => stash(w));
      } catch {
        /* ignore */
      }
    };
    for (const w of BrowserWindow.getAllWindows()) wire(w as Win);
    electronApp.on("browser-window-created", (_e: unknown, w: unknown) => wire(w as Win));
  });
}

async function hideAppAfterReady(app: ElectronApplication): Promise<void> {
  if (!QUIET || process.env.HPS_QUIET_NO_HIDE === "1") return;
  await app.evaluate(({ app: electronApp }) => {
    try {
      (electronApp as unknown as { hide?(): void }).hide?.();
    } catch {
      /* non-macOS */
    }
  });
}

/** Diagnostic (HPS_QUIET_DEBUG=1): report dock/app/window visibility so a
 *  verification run can assert the window really is off-screen + hidden. */
async function reportQuietState(app: ElectronApplication): Promise<void> {
  if (process.env.HPS_QUIET_DEBUG !== "1") return;
  const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
    dockVisible:
      (electronApp as unknown as { dock?: { isVisible?(): boolean } }).dock?.isVisible?.() ?? null,
    appHidden: (electronApp as unknown as { isHidden?(): boolean }).isHidden?.() ?? null,
    windows: BrowserWindow.getAllWindows().map((w: { getBounds(): unknown; isVisible(): boolean }) => ({
      bounds: w.getBounds(),
      visible: w.isVisible(),
    })),
  }));
  // eslint-disable-next-line no-console
  console.log(`[HPS_QUIET] ${JSON.stringify(state)}`);
}

export async function launchApp(opts: LaunchOptions = { preseedToken: true }): Promise<AppContext> {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-"));
  const userDir = path.join(userDataDir, "User");
  fs.mkdirSync(userDir, { recursive: true });

  // Pre-seed settings: local wrangler URL, no telemetry, no welcome page.
  // HPS_E2E_PROXY_URL overrides the proxy (e.g. prod for run-through evidence
  // captures — the sanctioned test target is the deployed cohort when the
  // local .dev.vars has no live LLM key). Same knob spirit as HPS_APP_PATH.
  fs.writeFileSync(
    path.join(userDir, "settings.json"),
    JSON.stringify(
      {
        "hypeproofChat.proxyUrl": process.env.HPS_E2E_PROXY_URL?.trim() || "http://localhost:8787/v1",
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
    // E2E mode flag: disables the dev /tmp/hps-token.txt fallback in
    // applyTestBackdoors so `preseedToken: false` produces a real cold launch
    // (#42 root cause).
    HPS_TEST_E2E: "1",
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
  const testState: {
    token?: string;
    coach?: { name: string; personality: string };
    history?: SeedHistoryTurn[];
  } = {};
  if (opts.preseedToken !== false) testState.token = token;
  if (opts.preseedCoach) {
    testState.coach = {
      name: opts.preseedCoach.name,
      personality: opts.preseedCoach.personality ?? "",
    };
  }
  if (opts.preseedHistory && opts.preseedHistory.length > 0) {
    testState.history = opts.preseedHistory;
  }
  if (opts.preseedIssuerToken) {
    (testState as { issuerToken?: string }).issuerToken = opts.preseedIssuerToken;
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
      // Quiet mode hides / off-screens the window (see applyQuietMode). A
      // hidden/occluded Chromium renderer normally throttles timers + pauses
      // rAF (measured ~5x slowdown), which risks tripping LLM-spec timeouts.
      // These switches keep it running at full speed while invisible.
      ...(QUIET
        ? [
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
          ]
        : []),
      wsDir,                          // open this folder → no reload
    ],
    env,
    timeout: 30_000,
  });

  // Stash the window off-screen ASAP (before we even resolve firstWindow) so
  // it doesn't linger on Jay's display during the run.
  await applyQuietMode(app);

  const win = await app.firstWindow({ timeout: 30_000 });
  // Wait for workbench to be ready (presence of activity bar)
  await win.waitForSelector(".monaco-workbench", { timeout: 30_000 });

  // Now that the workbench is up, hide the app so focus returns to Jay.
  await hideAppAfterReady(app);
  await reportQuietState(app);

  return { app, win, userDataDir, token, wsDir };
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
  // Keyboard shortcuts only reach the host when a non-webview element has
  // focus. If a chat-panel webview is mounted and focused (the common case
  // after openChatContainer), Cmd+Shift+P would be swallowed by the iframe
  // and the QuickInput never opens. Defocus by clicking the title-bar area
  // (always present, never intercepts) before sending the shortcut.
  const titleBar = win.locator(".monaco-workbench .part.titlebar").first();
  if ((await titleBar.count()) > 0) {
    await titleBar.click({ position: { x: 10, y: 10 }, force: true }).catch(() => undefined);
  }
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
