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

/**
 * True if the host settled the request (wrote a result) within `ms`.
 *
 * The gated case cannot be asserted by clicking: `showWarningMessage({modal:true})`
 * renders as a native OS dialog (NSAlert), not a DOM node. What IS observable —
 * and is exactly the property REQ-E1 promises — is that a gated action does
 * **not** settle on its own. No result inside the window = something is waiting
 * for a human. Auto-allowed actions settle in well under a second.
 */
async function settledWithin(resultFile: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fs.existsSync(resultFile);
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

test.skip("REQ-E2: (구 전제) writeFile → Approve → approved=true", async () => {
  // 두 가지 이유로 skip 이고, **두 번째가 지금은 더 크다.**
  //
  // 1. `vscode.window.showWarningMessage({modal: true}, ...)` 는 네이티브 OS
  //    다이얼로그(macOS NSAlert)로 뜬다 — DOM 노드가 아니라서 Playwright 의
  //    .monaco-dialog 셀렉터로는 애초에 닿지 않는다.
  // 2. **전제가 뒤집혔다 (#464 → #499).** writeFile 은 더 이상 모달 대상이
  //    아니다. 기본 정책은 [executeShell, openBrowser, delegateAgent,
  //    browserType] 이고 writeFile 은 Tier 3 에서 자동 허용된다. 이 테스트를
  //    그대로 되살리면 모달이 없어서 실패하는데, 위 주석 1번이 말하는 이유와는
  //    무관한 실패다.
  //
  // 지금의 writeFile 동작은 아래 "모달 없이 자동 허용" 테스트가 잰다.
  // REQ-E2(Approve 클릭 → approved=true)는 여전히 수동 QA 로만 검증된다 —
  // 승인 모달이 webview 로 렌더되면 그때 되살린다.
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

test("REQ-E1: writeFile → 모달 없이 자동 허용 (approved=true)", async () => {
  // #464 → #499 의 실제 동작을 재는 자리. writeFile 은 정책 목록에서 빠졌으므로
  // Tier 3 를 그냥 통과한다 — 사람이 아무것도 누르지 않아도 곧바로 settle 한다.
  //
  // 워크숍에서 이게 뒤집히면(= 다시 모달) 07-27 실측처럼 모달 하나가 174초를
  // 잡아먹으므로, 자동 허용 자체가 요구사항이다. payload 에 path 를 주지 않으면
  // Tier 2 containment 는 건너뛴다(워크스페이스 안 경로의 동작은
  // 16-approval-gates.spec.ts 가 실제 경로로 잰다).
  const ctx = await launchWithSynthAction({
    kind: "writeFile",
    description: "Save game to index.html",
  });
  try {
    const result = await readResult(ctx.resultFile);
    expect(result.error).toBeUndefined();
    expect(result.approved).toBe(true);
  } finally {
    await teardown(ctx);
  }
});

test("REQ-E1: executeShell → 게이트에 걸린다 (스스로 승인되지 않는다)", async () => {
  // 옛 전제("#115 이후 executeShell 은 모달 없이 즉시 거부")는 **죽었다**.
  // #431 에서 셸이 코호트 기능이 되면서 hard deny 가 사라졌다 —
  // chatPanelProvider.ts Tier 1: "No longer a hard deny … THIS modal is the gate."
  //
  // 모달은 네이티브라 클릭할 수 없다. 대신 게이트의 본질을 잰다: 아무도 누르지
  // 않으면 **아무 일도 일어나지 않는다.** 자동 허용이었다면(위 writeFile 처럼)
  // 1초 안에 settle 한다. 이 단언이 깨지는 방향은 하나뿐 — 셸이 조용히 자동
  // 실행되는 것이고, 그게 이 요구사항이 막으려는 상태다.
  const ctx = await launchWithSynthAction({
    kind: "executeShell",
    description: "Run `npm install` in workspace",
  });
  try {
    expect(await settledWithin(ctx.resultFile, 8_000)).toBe(false);
  } finally {
    await teardown(ctx);
  }
});
