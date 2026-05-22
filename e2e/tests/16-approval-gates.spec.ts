// Approval gates — workspace path scope + shell-exec hard-deny (#115).
//
// Extends 10-manual-approve.spec.ts (REQ-E1·E2 modal Approve/Deny) with the
// defense-in-depth tiers that came out of epic #108:
//
//   Tier 1 (hard-deny)   — executeShell refused without modal
//   Tier 2 (path-scope)  — writeFile outside workspace refused without modal
//   Tier 3 (modal-gated) — writeFile inside workspace shows modal (positive
//                          control to prove path-scope doesn't break legit writes)
//
// LLM-driven shell-refusal scenario (issue #115 case 4) is deferred — the
// rehearsal R3 suite already exercises that prompt rule against the live
// worker; replicating here would need a flaky live LLM call.

import { test, expect, _electron as electron, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_BINARY, TOKEN_FILE } from "../fixtures/global-setup";

interface GateCtx {
  app: Awaited<ReturnType<typeof electron.launch>>;
  win: Page;
  userDataDir: string;
  wsDir: string;
  resultFile: string;
}

async function launch(opts: {
  kind: "writeFile" | "executeShell";
  description: string;
  payload?: Record<string, unknown>;
}): Promise<GateCtx> {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-gates-"));
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
  const resultFile = path.join(userDataDir, "gate-result.json");

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    HPS_TEST_TOKEN: token,
    HPS_TEST_COACH_NAME: "코디",
    HPS_TEST_SYNTH_ACTION: JSON.stringify({
      kind: opts.kind,
      description: opts.description,
      payload: opts.payload,
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
  return { app, win, userDataDir, wsDir, resultFile };
}

async function teardown(ctx: GateCtx) {
  try { await ctx.app.close(); } catch { /* ignore */ }
  try { fs.rmSync(ctx.userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function readResult(resultFile: string, timeoutMs = 15_000): Promise<{ approved?: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      try {
        return JSON.parse(fs.readFileSync(resultFile, "utf8"));
      } catch { /* mid-write */ }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`result file never appeared: ${resultFile}`);
}

async function modalCount(win: Page): Promise<number> {
  return win.locator(".monaco-dialog-box, .monaco-dialog, .dialog-shadow").count();
}

test("Tier 1: executeShell is hard-denied without showing a modal", async () => {
  const ctx = await launch({
    kind: "executeShell",
    description: "rm -rf / (this should be flat-refused)",
  });
  try {
    // Result file appears quickly — no modal interaction needed
    const result = await readResult(ctx.resultFile, 10_000);
    expect(result.error).toBeUndefined();
    expect(result.approved).toBe(false);
    // No modal was shown
    expect(await modalCount(ctx.win)).toBe(0);
  } finally {
    await teardown(ctx);
  }
});

test("Tier 2: writeFile outside workspace is refused without modal", async () => {
  // Use an obviously-outside path. /etc is read-only on macOS but the host
  // never gets that far — Tier 2 rejects before any FS attempt.
  const outsidePath = "/etc/hps-should-never-write.txt";
  const ctx = await launch({
    kind: "writeFile",
    description: "Save game outside workspace (must be rejected)",
    payload: { path: outsidePath },
  });
  try {
    const result = await readResult(ctx.resultFile, 10_000);
    expect(result.error).toBeUndefined();
    expect(result.approved).toBe(false);
    expect(await modalCount(ctx.win)).toBe(0);
  } finally {
    await teardown(ctx);
  }
});

test.skip("Tier 3: writeFile inside workspace shows modal + Approve works", async () => {
  // showWarningMessage({modal:true}) renders as a native OS dialog
  // (NSAlert on macOS) — not in the DOM, so Playwright can't see/click it.
  // The non-modal path coverage (Tier 1 hard-deny + Tier 2 path-scope) above
  // already exercises resolveActionApproval's branching logic. A future
  // webview-rendered approval modal would let us re-enable this.
  const ctx = await launch({
    kind: "writeFile",
    description: "Save game to index.html",
  });
  try {
    const dialog = ctx.win.locator(".monaco-dialog-box, .monaco-dialog, .dialog-shadow").first();
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
    const approve = dialog
      .locator('a.monaco-text-button:has-text("Approve"), button:has-text("Approve")')
      .first();
    await approve.click({ timeout: 10_000 });
    const result = await readResult(ctx.resultFile);
    expect(result.error).toBeUndefined();
    expect(result.approved).toBe(true);
  } finally {
    await teardown(ctx);
  }
});
