import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ChatPanelProvider } from "./chatPanelProvider";
import { AssetStatusBar } from "./assetStatusBar";
import { labelsForProfile } from "./chatPanelHelpers";
import { PreviewProvider } from "./previewProvider";
import { runReportProblemCommand } from "./reportProblem";
import { runMintStudentToken, ISSUER_TOKEN_KEY } from "./mintStudentToken";
import {
  scheduleUpdateChecks,
  checkForUpdates,
  runUpdate,
  dismissVersion,
  currentBundleVersion,
} from "./updateChecker";
import { openBrowser, captureActivePage } from "./nativeBrowser";
import { LiveServer } from "./liveServer";

const TOKEN_KEY = "hypeproofChat.workshopToken";

let providerRef: ChatPanelProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
  // Kill kid-hostile modals globally + persistently, regardless of whether a
  // folder is already open this session. The setting lands in settings.json
  // so every future launch is dialog-free. (Can't suppress the dialog for the
  // current session if the folder opened before we activated, but it's a
  // one-time click then never again.)
  try {
    await vscode.workspace
      .getConfiguration("security.workspace.trust")
      .update("enabled", false, vscode.ConfigurationTarget.Global);
  } catch { /* ignore: read-only profile */ }

  // Test-only backdoors. Reads from env vars (which Playwright may not always
  // propagate to the extension host) AND a JSON file in the user-data-dir as
  // a more reliable fallback.
  await applyTestBackdoors(context);

  const preview = new PreviewProvider(context);
  const liveServer = new LiveServer();
  const assetStatus = new AssetStatusBar();
  const provider = new ChatPanelProvider(context, preview, liveServer, assetStatus);
  providerRef = provider;

  context.subscriptions.push(
    { dispose: () => liveServer.dispose() },
    assetStatus,
    vscode.window.registerWebviewViewProvider("hypeproof-chat.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Preview is no longer a sidebar view — it's an editor-area WebviewPanel
    // created on demand by PreviewProvider.show().

    vscode.commands.registerCommand("hypeproof-chat.focus", () => {
      vscode.commands.executeCommand("hypeproof-chat.panel.focus");
    }),

    vscode.commands.registerCommand("hypeproof-chat.clearHistory", async () => {
      await provider.clearHistory();
      vscode.window.showInformationMessage("HypeProof Chat: conversation cleared.");
    }),

    vscode.commands.registerCommand("hypeproof-chat.setToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "선생님께 받은 토큰을 넣어주세요",
        prompt: "Workshop token",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "eyJ... 로 시작하는 긴 문자열",
      });
      if (token === undefined) return;
      if (token.trim() === "") {
        await context.secrets.delete(TOKEN_KEY);
        vscode.window.showInformationMessage("HypeProof Chat: token cleared.");
        provider.invalidateProfile();
        provider.refreshConfig();
        return;
      }
      await context.secrets.store(TOKEN_KEY, token.trim());
      provider.invalidateProfile();
      // Re-fetch profile with the new token. The coach naming step is driven
      // by the in-panel card (kid-friendly) — NOT a system input box. Once
      // profile is fetched and pushed via postConfig, the webview shows the
      // naming card itself when coach.configured is false. Do not call
      // runCoachNamingRitual() here (it would block on a quickInput and
      // prevent postConfig from reaching the webview).
      const profile = await provider.ensureProfile();
      if (profile) {
        const tail = labelsForProfile(profile).tokenConfirmTail;
        vscode.window.showInformationMessage(`토큰 확인 완료! ${tail}`);
      } else {
        vscode.window.showWarningMessage(
          "토큰이 맞는지 확인이 안 돼요. 선생님께 토큰을 다시 받아주세요.",
        );
      }
      provider.refreshConfig();
    }),

    vscode.commands.registerCommand("hypeproof-chat.runLastCode", async () => {
      const html = provider.extractLastRenderableCode();
      if (!html) {
        vscode.window.showWarningMessage("HypeProof Chat: 마지막 응답에서 실행할 코드가 없어요.");
        return;
      }
      await provider.revealBuilt(html);
    }),

    // Preview the .html file in the active editor (or a passed-in URI from
    // the explorer context menu). basePath = the file's parent dir so
    // sibling assets (./style.css, ./pic.png) resolve.
    vscode.commands.registerCommand("hypeproof-chat.previewActiveFile", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== "file") {
        vscode.window.showWarningMessage("HypeProof: preview할 .html 파일을 열어주세요.");
        return;
      }
      if (!/\.html?$/i.test(target.fsPath)) {
        vscode.window.showWarningMessage("HypeProof: .html / .htm 파일만 preview 가능합니다.");
        return;
      }
      const basePath = vscode.Uri.joinPath(target, "..");
      try {
        const buf = await vscode.workspace.fs.readFile(target);
        const html = Buffer.from(buf).toString("utf8");
        await preview.show(html, basePath);
        await preview.watchForReload(target);
      } catch (err) {
        vscode.window.showErrorMessage(`HypeProof: 파일을 읽지 못했어요 — ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand("hypeproof-chat.renameCoach", async () => {
      await provider.runCoachNamingRitual({ force: true });
    }),

    vscode.commands.registerCommand("hypeproof-chat.reportProblem", async () => {
      await runReportProblemCommand({
        context,
        getLastRequestId: () => provider.getLastRequestId(),
        getProfileId: () => provider.getProfileId(),
        getRecentTurns: () => provider.getHistorySnapshot(),
      });
    }),

    // #66 — Mint Student Token for instructors. Pulls cohort/profile defaults
    // from the active /v1/profile response so the 강사 doesn't have to retype
    // them. issuer token persists in SecretStorage between mints.
    vscode.commands.registerCommand("hypeproof-chat.mintStudentToken", async () => {
      const proxyUrl = vscode.workspace
        .getConfiguration("hypeproofChat")
        .get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
      // Cohort id is not exposed via /v1/profile; the issuer token payload
      // carries cohort scope and mintStudentToken extracts the default
      // automatically when scope is a single cohort.
      await runMintStudentToken({
        context,
        proxyUrl,
        defaults: {
          profile: provider.getProfileId(),
        },
      });
    }),

    vscode.commands.registerCommand("hypeproof-chat.forgetIssuerToken", async () => {
      await context.secrets.delete(ISSUER_TOKEN_KEY);
      vscode.window.showInformationMessage("issuer 토큰이 지워졌어요. 다음 발급 시 다시 물어봅니다.");
    }),

    // #72: auto-update commands. The banner in the chat panel calls
    // installUpdate via the openInstallUpdate webview message → provider →
    // here. checkForUpdates is also exposed as a command so the user can
    // manually trigger a check (Cmd+Shift+P).
    vscode.commands.registerCommand("hypeproof-chat.checkForUpdates", async () => {
      const current = currentBundleVersion();
      const info = await checkForUpdates(current);
      if (info.available) {
        provider.setAvailableUpdate({
          version: info.version,
          notes: info.notes,
          releaseUrl: info.releaseUrl,
          sizeBytes: info.sizeBytes,
        });
        vscode.window.showInformationMessage(
          `새 버전 v${info.version} 발견. 채팅 패널 상단의 배너에서 설치할 수 있어요.`,
        );
      } else {
        provider.setAvailableUpdate(null);
        vscode.window.showInformationMessage(`현재 v${current} — 최신 버전입니다.`);
      }
    }),

    vscode.commands.registerCommand("hypeproof-chat.installUpdate", async () => {
      // Re-fetch to be safe (the stored banner state might be stale).
      const current = currentBundleVersion();
      const info = await checkForUpdates(current);
      if (!info.available) {
        provider.setAvailableUpdate(null);
        vscode.window.showInformationMessage("최신 버전이라 업데이트 안 해도 됩니다.");
        return;
      }
      await runUpdate(info, {
        context,
        onUpdateScheduled: () => provider.setAvailableUpdate(null),
      });
    }),

    vscode.commands.registerCommand("hypeproof-chat.dismissUpdate", async (version: string) => {
      if (typeof version !== "string" || !version) return;
      await dismissVersion(context, version);
      provider.setAvailableUpdate(null);
    }),

    // #278 — native integrated browser. openBrowser: open a real browser tab
    // (own/external/localhost/file pages, Q1). sendPageToCoach: capture the
    // active tab via CDP for the coach (Q2 foundation).
    vscode.commands.registerCommand("hypeproof-chat.openBrowser", (url?: string) =>
      openBrowser(typeof url === "string" ? url : undefined),
    ),

    vscode.commands.registerCommand("hypeproof-chat.sendPageToCoach", async () => {
      // Per-cohort gate (default off → minor-safe). Worker emits input.page_context
      // via /v1/profile; the host enforces it here for the text-injection path.
      if (!provider.isPageContextEnabled()) {
        vscode.window.showInformationMessage(
          "이 코호트에서는 '페이지를 코치에게' 기능이 꺼져 있어요.",
        );
        return;
      }
      const ctx = await captureActivePage();
      if (!ctx) return;
      provider.attachPageContext({ url: ctx.url, title: ctx.title, text: ctx.text });
      await vscode.commands.executeCommand("hypeproof-chat.panel.focus");
      vscode.window.showInformationMessage(
        `📄 페이지를 코치에게 붙였어요 — ${ctx.title || ctx.url}. 이제 질문을 입력해 보내세요.`,
      );
    }),

  );

  // Test-only: if HPS_TEST_CRASH_AFTER_MS is set, post a webviewTestCrash
  // to the panel after that many milliseconds. Lets e2e exercise REQ-C7
  // (ChatErrorBoundary) without needing a registered command in
  // contributes.commands. Env-gated; no-op in real workshop builds.
  if (process.env.HPS_TEST_CRASH_AFTER_MS) {
    const ms = Number(process.env.HPS_TEST_CRASH_AFTER_MS);
    if (Number.isFinite(ms) && ms >= 0) {
      setTimeout(() => provider.postTestCrash(), ms);
    }
  }

  // #72: kick off background update checks. Scheduler is disposable so we
  // attach it to the extension lifecycle.
  context.subscriptions.push(
    scheduleUpdateChecks({
      context,
      currentVersion: currentBundleVersion(),
      pushUpdateBanner: (info) => {
        if (!info) {
          provider.setAvailableUpdate(null);
          return;
        }
        provider.setAvailableUpdate({
          version: info.version,
          notes: info.notes,
          releaseUrl: info.releaseUrl,
          sizeBytes: info.sizeBytes,
        });
      },
    }),
  );

  // Auto-onboarding: close the default welcome editor, focus the chat panel,
  // prompt for a token if none stored, then prompt for coach name.
  void autoOnboard(context, provider);

  // E2E backdoor for REQ-E1/E2 manual-approve modal. Fires a synthetic
  // actionRequest after the panel mounts and writes the approve/deny result
  // to a file the Playwright test can read. Gated on env so it can never
  // run in a real workshop build.
  void maybeSynthesizeTestAction(context, provider);
}

/**
 * Test-only: synthesize a manual-approve actionRequest if the test fixture
 * asked for one. Result (the user's Approve/Deny click outcome) is written
 * to a JSON file so the test side can read it after dismissing the modal.
 */
async function maybeSynthesizeTestAction(
  _context: vscode.ExtensionContext,
  provider: ChatPanelProvider,
): Promise<void> {
  const raw = process.env.HPS_TEST_SYNTH_ACTION;
  if (!raw) return;
  let cfg: {
    kind: "writeFile" | "executeShell";
    description: string;
    resultFile: string;
    payload?: Record<string, unknown>;
  };
  try {
    cfg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!cfg.kind || !cfg.resultFile) return;

  // Give the chat panel time to mount so focus is in a sensible place.
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const approved = await provider.resolveActionApproval({
      requestId: `test-${Date.now()}`,
      kind: cfg.kind,
      description: cfg.description ?? "(test description)",
      payload: cfg.payload ?? { test: true },
    });
    fs.writeFileSync(cfg.resultFile, JSON.stringify({ approved, ts: Date.now() }));
  } catch (err) {
    fs.writeFileSync(
      cfg.resultFile,
      JSON.stringify({ error: (err as Error).message, ts: Date.now() }),
    );
  }
}

const FIRST_RUN_KEY = "hypeproofChat.didFirstRun";

async function autoOnboard(
  context: vscode.ExtensionContext,
  provider: ChatPanelProvider,
): Promise<void> {
  // 0. Ensure a workspace folder exists + is open. The kid's games live here
  //    and this is what GitHub Pages publishing will push later. If we have to
  //    open the folder, the window reloads — fine on first launch (nothing
  //    done yet); the post-reload activation skips this (folder already open)
  //    and continues to token/naming.
  if (await ensureWorkspace()) {
    return; // window is reloading
  }

  const isFirstRun = !context.globalState.get<boolean>(FIRST_RUN_KEY);

  if (isFirstRun) {
    try {
      await vscode.workspace
        .getConfiguration("workbench")
        .update("startupEditor", "none", vscode.ConfigurationTarget.Global);
    } catch { /* ignore */ }
    try {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    } catch { /* ignore */ }
    await context.globalState.update(FIRST_RUN_KEY, true);
  }

  // Reveal the chat container.
  try {
    await vscode.commands.executeCommand("workbench.view.extension.hypeproof-chat");
    await vscode.commands.executeCommand("hypeproof-chat.panel.focus");
  } catch { /* ignore */ }

  // 1. Token (if missing) — setToken itself re-fetches profile + runs the
  //    naming ritual on success, so we can return early here.
  const existing = await context.secrets.get(TOKEN_KEY);
  if (!existing) {
    await new Promise((r) => setTimeout(r, 400));
    await vscode.commands.executeCommand("hypeproof-chat.setToken");
    return;
  }

  // 2. Token exists — verify it actually works. A stale/expired token would
  //    otherwise silently degrade the whole UX (no chips, no naming, default
  //    "코치", raw 401 on first message). REQ-A5 / REQ-B3: show a friendly
  //    warning toast so the kid knows what happened before the QuickInput
  //    pops, then re-open setToken.
  const profile = await provider.ensureProfile();
  if (!profile) {
    vscode.window.showWarningMessage(
      "저장된 토큰이 유효하지 않은 것 같아요. 선생님께 토큰을 다시 받아주세요. 🔑",
    );
    await new Promise((r) => setTimeout(r, 400));
    await vscode.commands.executeCommand("hypeproof-chat.setToken");
    return;
  }

  // 3. Coach naming is now driven by an in-panel card (kid-friendly), not a
  //    system input box. The webview shows it when coach.configured is false
  //    and the profile requests user_names_it. Nothing to do here.
}

const WORKSPACE_DIRNAME = "HypeProofGames";

const STARTER_INDEX_HTML = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>내 게임</title>
  <style>
    body { margin:0; height:100vh; display:flex; align-items:center;
           justify-content:center; background:#1b1b2a; color:#fff;
           font-family:-apple-system,sans-serif; text-align:center; }
  </style>
</head>
<body>
  <div>
    <h1>🎮 내 첫 게임</h1>
    <p>채팅에서 "게임 만들어줘"라고 말해보세요!</p>
  </div>
</body>
</html>
`;

/**
 * Make sure the kid has a real folder to work in. Returns true if the window
 * is reloading (caller should bail). Idempotent: once a folder is open this
 * returns false immediately.
 *
 * Race protection (#42): even with `onStartupFinished` activation, a
 * positional `--folder` arg may take a tick to register in
 * `workspaceFolders`. Grace-poll for up to 1s before deciding to trigger a
 * create-and-reload — without this, e2e cold-launch with a pre-opened test
 * folder would briefly see workspaceFolders empty, fire openFolder, and
 * reload mid-onboard, racing the setToken QuickInput.
 */
async function ensureWorkspace(): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return false;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Disable the "Do you trust the authors of this folder?" modal BEFORE
  // opening the folder. It's auto-created by us; a 9-year-old should never
  // see a scary security dialog. Persisted to global settings so it sticks.
  try {
    await vscode.workspace
      .getConfiguration("security.workspace.trust")
      .update("enabled", false, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration("workbench")
      .update("startupEditor", "none", vscode.ConfigurationTarget.Global);
  } catch { /* ignore: read-only profile */ }

  const dir = path.join(os.homedir(), WORKSPACE_DIRNAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const indexPath = path.join(dir, "index.html");
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, STARTER_INDEX_HTML);
    }
  } catch {
    // If we can't create the dir, don't trap the user — just continue without
    // a workspace (chat + preview still work).
    return false;
  }

  // Single-root open (clean Explorer for a 9-year-old). Reloads the window.
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), {
    forceReuseWindow: true,
  });
  return true;
}

async function applyTestBackdoors(context: vscode.ExtensionContext): Promise<void> {
  // Source 1: env vars (works when Playwright passes them through to the
  // extension host, which is inconsistent across VS Code versions).
  let token = process.env.HPS_TEST_TOKEN;
  let coachName = process.env.HPS_TEST_COACH_NAME;
  let coachPersonality = process.env.HPS_TEST_COACH_PERSONALITY ?? "";
  let history: Array<{ id: string; role: "user" | "assistant" | "system"; content: string; createdAt: number }> | undefined;
  let issuerToken = process.env.HPS_TEST_ISSUER_TOKEN;

  // Source 2: a JSON file the test fixture writes into the user-data-dir,
  // typically <userDataDir>/User/hps-test-state.json. Always wins over env
  // (file is more explicit + more reliable).
  try {
    const candidates = [
      path.join(context.globalStorageUri.fsPath, "..", "..", "..", "User", "hps-test-state.json"),
      path.join(os.homedir(), ".hps-test-state.json"),
    ];
    for (const f of candidates) {
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, "utf8")) as {
          token?: string;
          coach?: { name?: string; personality?: string };
          history?: typeof history;
          issuerToken?: string;
        };
        if (j.token) token = j.token;
        if (j.coach?.name) coachName = j.coach.name;
        if (j.coach?.personality) coachPersonality = j.coach.personality;
        if (Array.isArray(j.history)) history = j.history;
        if (j.issuerToken) issuerToken = j.issuerToken;
        break;
      }
    }
  } catch { /* ignore — file missing or unparseable */ }

  // Source 3: dev convenience. A manually-launched local build picks up the
  // token `scripts/dev-stack.sh` writes, so contributors don't paste it every
  // launch. Dev-gated:
  //   - only when proxyUrl points at a local worker (so a real workshop build
  //     never reads /tmp); AND
  //   - only when HPS_TEST_E2E is unset — the e2e fixture sets that flag so
  //     `preseedToken: false` actually produces a cold launch instead of
  //     getting silently filled in from the dev token file. Fix for #42.
  if ((!token || token.length === 0) && !process.env.HPS_TEST_E2E) {
    const proxyUrl = vscode.workspace
      .getConfiguration("hypeproofChat")
      .get<string>("proxyUrl", "");
    const isLocalDev = /\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(proxyUrl);
    if (isLocalDev) {
      const devTokenFile = process.env.HPS_DEV_TOKEN_FILE || "/tmp/hps-token.txt";
      try {
        if (fs.existsSync(devTokenFile)) {
          const t = fs.readFileSync(devTokenFile, "utf8").trim();
          if (t.length > 20) token = t;
        }
      } catch { /* ignore — best effort */ }
    }
  }

  if (token && token.length > 0) {
    await context.secrets.store(TOKEN_KEY, token);
  }
  if (coachName && coachName.length > 0) {
    await context.globalState.update("hypeproofChat.coach", {
      name: coachName,
      personality: coachPersonality,
      configured: true,
    });
    await context.globalState.update("hypeproofChat.coachRitualDone", true);
  }
  // Pre-seed chat history so e2e tests can exercise preview / reload paths
  // without depending on a live LLM round-trip.
  if (history && history.length > 0) {
    await context.workspaceState.update("hypeproofChat.history", history);
  }
  // Pre-seed issuer token for mint-flow tests (G5/G6).
  if (issuerToken && issuerToken.length > 0) {
    await context.secrets.store(ISSUER_TOKEN_KEY, issuerToken);
  }
}

export function deactivate() {
  providerRef = null;
}

export { TOKEN_KEY };
