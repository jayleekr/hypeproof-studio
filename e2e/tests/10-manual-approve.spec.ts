// REQ-E1 + REQ-E2 manual-approve modal (#91).
//
// The modal is normally fired by the streamed assistant requesting writeFile
// or executeShell — too LLM-flaky for e2e. We use a test backdoor
// (HPS_TEST_SYNTH_ACTION env) that, after the panel mounts, fires a synthetic
// actionRequest and writes the approve/deny result to a JSON file. The spec
// then clicks Approve/Deny and asserts the file's `approved` value.

import { test, expect, _electron as electron } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_BINARY, TOKEN_FILE } from "../fixtures/global-setup";

interface ManualApproveCtx {
  app: Awaited<ReturnType<typeof electron.launch>>;
  win: import("@playwright/test").Page;
  userDataDir: string;
  resultFile: string;
}

async function launchWithSynthAction(opts: {
  kind: "writeFile" | "executeShell";
  description: string;
}): Promise<ManualApproveCtx> {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-approve-"));
  const userDir = path.join(userDataDir, "User");
  fs.mkdirSync(userDir, { recursive: true });

  fs.writeFileSync(
    path.join(userDir, "settings.json"),
    JSON.stringify({
      "hypeproofChat.proxyUrl": "http://localhost:8787/v1",
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

  const resultFile = path.join(userDataDir, "action-result.json");

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    HPS_TEST_TOKEN: token,
    HPS_TEST_COACH_NAME: "코디",
    HPS_TEST_SYNTH_ACTION: JSON.stringify({
      kind: opts.kind,
      description: opts.description,
      resultFile,
    }),
  };

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
    env,
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForSelector(".monaco-workbench", { timeout: 30_000 });

  return { app, win, userDataDir, resultFile };
}

async function teardown(ctx: ManualApproveCtx) {
  try { await ctx.app.close(); } catch { /* ignore */ }
  try { fs.rmSync(ctx.userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Find the modal warning dialog and click the named button. VS Code renders
 * `showWarningMessage({modal:true}, ...)` as a `.monaco-dialog` overlay; the
 * action buttons live inside it as `<a class="monaco-text-button">` with
 * the visible label as text.
 */
async function clickModalButton(win: import("@playwright/test").Page, label: string): Promise<void> {
  const dialog = win.locator(".monaco-dialog-box, .monaco-dialog, .dialog-shadow").first();
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  const button = dialog.locator(`a.monaco-text-button:has-text("${label}"), button:has-text("${label}")`).first();
  await button.click({ timeout: 10_000 });
}

async function readResult(resultFile: string): Promise<{ approved?: boolean; error?: string }> {
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(resultFile)) {
      try {
        return JSON.parse(fs.readFileSync(resultFile, "utf8"));
      } catch { /* file might be mid-write */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`result file never appeared: ${resultFile}`);
}

test.skip("REQ-E1 + REQ-E2: writeFile → Approve → approved=true", async () => {
  // `vscode.window.showWarningMessage({modal: true}, ...)` renders as a
  // native OS dialog (NSAlert on macOS) when the workbench window is
  // electron-driven — not a DOM element. Playwright cannot reach it via
  // .monaco-dialog selectors because it's not in the DOM at all.
  //
  // The path-scope rejection (10-approval-gates.spec.ts Tier 2) + hard-deny
  // (Tier 1) DO test resolveActionApproval's policy logic without needing
  // to click a modal. The actual Approve click is verified only via manual
  // QA. Leaving this skipped pins the contract; a future webview-rendered
  // approval modal would let us re-enable.
  const ctx = await launchWithSynthAction({
    kind: "writeFile",
    description: "Save game to index.html",
  });
  try {
    await clickModalButton(ctx.win, "Approve");
    const result = await readResult(ctx.resultFile);
    expect(result.error).toBeUndefined();
    expect(result.approved).toBe(true);
  } finally {
    await teardown(ctx);
  }
});

test("REQ-E1 + REQ-E2: executeShell → hard-deny (no modal, approved=false)", async () => {
  // Post-#115 policy change: executeShell is refused outright by the host
  // before any modal is shown. Defense-in-depth on top of the worker prompt's
  // "셸 실행 금지" rule. See chatPanelProvider.resolveActionApproval Tier 1.
  const ctx = await launchWithSynthAction({
    kind: "executeShell",
    description: "Run `npm install` in workspace",
  });
  try {
    const result = await readResult(ctx.resultFile);
    expect(result.error).toBeUndefined();
    expect(result.approved).toBe(false);
  } finally {
    await teardown(ctx);
  }
});
