// Approval gates — workspace path scope + shell-exec hard-deny (#115).
//
// Extends 10-manual-approve.spec.ts (REQ-E1·E2 modal Approve/Deny) with the
// defense-in-depth tiers that came out of epic #108:
//
//   Tier 1 (modal-gated) — executeShell waits for a human. #115 의 hard-deny 는
//                          #431 에서 죽었다(셸이 코호트 기능이 됐다). 지금은
//                          모달이 게이트다
//   Tier 2 (path-scope)  — writeFile outside workspace refused without modal
//   Tier 3 (auto-allow)  — writeFile inside workspace 는 모달 없이 통과한다
//                          (#464 → #499). path-scope 가 정상 쓰기를 막지 않는다는
//                          양성 대조군이자, writeFile 모달 부활을 잡는 잠금
//
// 승인 정책의 단일 소스는 `extensions/hypeproof-chat/package.json` 의
// `requireApprovalFor.default` 다 — 코드의 getConfiguration 폴백이 아니다(#499).
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
  destructive?: boolean;
  payload?: Record<string, unknown>;
  /**
   * 워크스페이스 폴더는 launch 안에서 만들어지므로 호출자가 미리 그 경로를 쓸 수
   * 없다. 이 이름을 주면 wsDir 기준으로 풀어서 payload.path 로 넣는다 —
   * Tier 2 containment 를 "진짜 안쪽 경로"로 통과시키는 양성 대조군용.
   */
  pathInWorkspace?: string;
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
      "window.dialogStyle": "custom",
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
      destructive: opts.destructive,
      payload: opts.pathInWorkspace
        ? { ...opts.payload, path: path.join(wsDir, opts.pathInWorkspace) }
        : opts.payload,
      resultFile,
    }),
  };

  const app = await electron.launch({
    executablePath: APP_BINARY,
    args: [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${path.join(userDataDir, "extensions")}`,
      "--disable-workspace-trust",
      "--use-inmemory-secretstorage",
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

test("Tier 1: destructive approval offers no always-allow and cancellation refuses", async () => {
  // Approval-only hook: no command is executed, even if mistakenly approved.
  const ctx = await launch({kind:'executeShell',description:'synthetic destructive classification',destructive:true,payload:{command:'rm -rf ./synthetic-delete-target'}});
  try {
    const dialog=ctx.win.locator('.monaco-dialog-box').first();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('되돌리기 어려운 명령');
    await expect(dialog).not.toContainText('항상 허용');
    expect(fs.existsSync(ctx.resultFile)).toBe(false);
    await dialog.getByRole('button',{name:'취소',exact:true}).click();
    const result=await readResult(ctx.resultFile);
    expect(result.error).toBeUndefined();expect(result.approved).toBe(false);
    if(process.env.HPS_NATIVE_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.HPS_NATIVE_EVIDENCE_DIR,'destructive-approval.json'),JSON.stringify({scope:'actual App approval-only synthetic action; no shell execution',approved:result.approved}));
  } finally {await teardown(ctx);}
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

test("Tier 3: 워크스페이스 안 writeFile 은 모달 없이 통과한다", async () => {
  // 이 테스트는 원래 "shows modal + Approve works" 였고, 네이티브 다이얼로그를
  // 클릭할 수 없어 skip 돼 있었다. #464 → #499 로 전제가 바뀌면서 오히려
  // **클릭 없이 잴 수 있는** 테스트가 됐다: writeFile 은 정책 목록에 없으므로
  // Tier 3 를 그냥 통과한다.
  //
  // 두 가지를 동시에 지킨다.
  //   · 원래 의도 — path-scope(Tier 2)가 정상적인 워크스페이스 내 쓰기를
  //     막지 않는다는 양성 대조군. 위 Tier 2 의 거부가 "무조건 거부"가 아님을 증명한다.
  //   · #499 잠금 — 매니페스트 default 에 writeFile 이 다시 들어오면 모달이 떠서
  //     settle 하지 않고, 이 테스트가 타임아웃으로 잡는다.
  const ctx = await launch({
    kind: "writeFile",
    description: "Save game to index.html",
    pathInWorkspace: "index.html",
  });
  try {
    const result = await readResult(ctx.resultFile, 15_000);
    expect(result.error).toBeUndefined();
    expect(result.approved).toBe(true);
    expect(await modalCount(ctx.win)).toBe(0);
  } finally {
    await teardown(ctx);
  }
});
