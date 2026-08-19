import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ChatPanelProvider } from "./chatPanelProvider";
import { AssetStatusBar } from "./assetStatusBar";
import {
  labelsForProfile,
  appToneOf,
  TONE_LABELS,
  extractCohortIdUnverified,
  sanitizeWorkshopToken,
  looksLikeWorkshopToken,
  looksLikeIssuerTokenUnverified,
  coachKeyForCohort,
  coachRitualDoneKeyForCohort,
  historyKeyForCohort,
  LEGACY_COACH_KEY,
  LEGACY_COACH_RITUAL_DONE_KEY,
  LEGACY_HISTORY_KEY,
} from "./chatPanelHelpers";
import { PROFILE_ISSUER_TOKEN_FRIENDLY } from "./proxyClientHelpers";
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
import { decideWorkspaceSwitch, isSameLocation } from "./workspaceRouting";
import { SessionSpool, resolveSpoolSessionsRoot } from "./sessionSpool";
import { uploadAllPending } from "./spoolUploader";
import type { ResolvedProfile } from "./protocol";

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
  const backdoors = await applyTestBackdoors(context);

  const preview = new PreviewProvider(context);
  const liveServer = new LiveServer();
  const assetStatus = new AssetStatusBar();
  // #580 — 세션 로그 로컬 스풀 (수집 계층). 세션 = 이 활성화 1회. 디렉토리는
  // 첫 이벤트에서 게으르게 생기므로 채팅 없는 창은 아무것도 남기지 않는다.
  //
  // e2e 런은 스풀을 만들지 않는다: 스풀 루트는 의도적으로 user-data-dir 밖의
  // 고정 경로라 e2e 의 fresh-user-data-dir 격리를 우회하는데, e2e 픽스처는
  // 실코호트의 진짜 토큰을 프리시드하므로 합성 턴이 실학생 신원의 세션으로
  // 실기기 스풀에 쌓인다 — 업로더가 생기는 순간 분석 오염이다.
  //
  // 게이트는 env + 테스트 상태 파일의 OR 다. env(HPS_TEST_E2E)는 확장 호스트
  // 까지 전파가 "inconsistent" 하다고 이 파일 스스로 적어 놨고(REQ-A7 의
  // 파일 백도어가 존재하는 이유), 오염이 성립하려면 토큰이 도달해야 하는데
  // 토큰은 env 아니면 그 파일로 온다 — 어느 쪽이 뚫렸든 게이트에 걸린다.
  // F5 개발 호스트는 기록하되 meta 에 `dev: true` 표식으로 걸러낼 수 있게 한다.
  const isTestRun = !!process.env.HPS_TEST_E2E || backdoors.testStateFileFound;
  const spoolRoot = resolveSpoolSessionsRoot({
    platform: process.platform,
    homeDir: os.homedir(),
    env: process.env as Record<string, string | undefined>,
  });
  const spool = isTestRun
    ? undefined
    : new SessionSpool({
        root: spoolRoot,
        appVersion: String(
          (context.extension.packageJSON as { version?: unknown } | undefined)?.version ?? "unknown",
        ),
        os: { platform: process.platform, release: os.release(), arch: process.arch },
        devHost: context.extensionMode === vscode.ExtensionMode.Development,
      });
  if (spool) {
    // 총량 캡 집행 (#580 D7) — 활성화를 막지 않는 fire-and-forget, 실패는 삼킨다.
    void spool.sweepRetention();
    // 종료 시 큐에 남은 마지막 이벤트를 흘려보낸다 (best-effort — 크래시는
    // 라인 단위 append 가 감당한다).
    context.subscriptions.push({ dispose: () => void spool.flush() });
  }
  const provider = new ChatPanelProvider(context, preview, liveServer, assetStatus, spool);
  providerRef = provider;
  // kids-quest — skeleton round result → next-turn context for the coach.
  context.subscriptions.push(preview.onResult((r) => provider.attachQuestResult(r)));

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

    // #596 — 세션 로그 업로드 (#580 업로드 계층). 항상 **명시적 액션**으로만
    // 돈다: 이 커맨드(팔레트) 또는 세션 종료 감지 배너의 버튼. 현재 진행 중인
    // 세션은 제외 — 완결(비활성) 세션만 올리고, 활성 세션은 다음 트리거 몫이다.
    vscode.commands.registerCommand("hypeproof-chat.uploadSessionLogs", async () => {
      if (!spool) {
        vscode.window.showInformationMessage("테스트 실행에서는 세션 기록을 남기지 않아요.");
        return;
      }
      const token = await context.secrets.get(TOKEN_KEY);
      if (!token) {
        vscode.window.showInformationMessage("토큰을 먼저 넣어주세요 — 기록은 토큰의 수업으로 보내져요.");
        return;
      }
      const profile = await provider.ensureProfile();
      if (profile?.analytics?.upload_session_logs !== true) {
        // 서버도 어차피 거부한다(fail closed) — 여기서 미리 조용히 알린다.
        vscode.window.showInformationMessage("이 수업은 기록 업로드를 사용하지 않아요.");
        return;
      }
      const proxyUrl = vscode.workspace
        .getConfiguration("hypeproofChat")
        .get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "오늘 활동 기록 보내는 중…" },
        async () => {
          const results = await uploadAllPending(spoolRoot, {
            baseUrl: proxyUrl,
            token,
            currentSessionDir: spool.currentSessionDir(),
          });
          const ok = results.filter((r) => r.ok).length;
          const fail = results.length - ok;
          // 업로드 시도 자체도 행동 데이터다 — 현재 세션 스풀에 남긴다.
          spool.recordWorkflow({
            event: "logs_upload",
            payload: { sessions: results.length, ok, fail },
          });
          if (results.length === 0) {
            vscode.window.showInformationMessage("보낼 새 기록이 없어요.");
          } else if (fail === 0) {
            vscode.window.showInformationMessage(`활동 기록 ${ok}개 세션을 보냈어요!`);
          } else {
            const first = results.find((r) => !r.ok);
            vscode.window.showWarningMessage(
              `기록 ${ok}개는 보냈고 ${fail}개는 실패했어요 — 다음에 자동으로 다시 시도해요.` +
                (first?.message ? ` (${first.message})` : ""),
            );
          }
        },
      );
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
      // #427 — accept the token in whatever packaging it arrived in ("이름: 토큰"
      // from the console's bulk copy, "Bearer …", a hard-wrapped relay). The old
      // bare trim() left the packaging in place and the paste 401'd silently,
      // with `password: true` hiding the evidence.
      const clean = sanitizeWorkshopToken(token);
      if (clean === "") {
        await context.secrets.delete(TOKEN_KEY);
        vscode.window.showInformationMessage("HypeProof Chat: token cleared.");
        provider.invalidateProfile();
        provider.refreshConfig();
        return;
      }
      // #381 — an instructor token in the participant box is decidable offline
      // (payload carries role: "issuer"). Say so BEFORE storing it and before
      // the round trip: storing would leave the panel showing "Token ✓" for a
      // token that can never chat. Diagnosis only — the shape check below is
      // what all other tokens fall through to, and the server still decides.
      if (looksLikeIssuerTokenUnverified(clean)) {
        const retry = await vscode.window.showWarningMessage(
          PROFILE_ISSUER_TOKEN_FRIENDLY,
          "다시 입력",
        );
        if (retry === "다시 입력") {
          await vscode.commands.executeCommand("hypeproof-chat.setToken");
        }
        return;
      }
      await context.secrets.store(TOKEN_KEY, clean);
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
        // #422 — first launch has no workspace yet (we no longer create one
        // before the cohort is known). Now that the profile resolved, open the
        // cohort's folder (website vs game). If one is already open, no-op.
        // NOTE: this may reload the window; refreshConfig below still runs for
        // the already-open case.
        if (await ensureWorkspace(profile, context)) {
          return; // window is reloading; post-reload activation continues onboarding
        }
      } else {
        // #427 — a rejected token used to be a dead end: the toast fired and the
        // input box never came back, so the only way to retry was to know about
        // the panel's Token button or the command palette entry. Hand the retry
        // back directly. The user drives the loop, so it cannot spin.
        provider.refreshConfig();
        // Name the actual cause instead of one generic line. Precedence:
        //   1. shape mismatch — decided locally, can only be a paste problem
        //   2. the server's own answer (#381) — expired / instructor token /
        //      unknown 회차 / server down / unreachable, each with its own copy
        //   3. nothing to go on (no failure recorded) — say only that much
        // Diagnosis only — never a gate, so a future token format can't be
        // false-rejected client-side (the server decides).
        const failure = provider.profileFailure();
        const message = !looksLikeWorkshopToken(clean)
          ? "붙여넣은 값이 토큰 형식이 아니에요. 이름이나 따옴표가 섞이지 않았는지 확인하고, eyJ… 로 시작하는 부분만 넣어주세요."
          : (failure?.friendly ??
            "토큰이 확인되지 않았어요. 선생님께 새 토큰을 받아주세요.");
        const retry = await vscode.window.showWarningMessage(message, "다시 입력");
        if (retry === "다시 입력") {
          await vscode.commands.executeCommand("hypeproof-chat.setToken");
        }
        return;
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
      // 미리보기는 **라이브 서버 하나로** 모은다 (원장 결정 2026-07-27).
      //
      // 예전에는 webview 로 HTML 을 직접 렌더했다. 그러면 코치가 보는 화면
      // (live_preview_start → 127.0.0.1)과 학생이 우클릭으로 여는 화면이 **서로 다른
      // 진실**이 된다. 실사용에서 우클릭 미리보기가 라이브보다 뒤처진 내용을 보여
      // 줬고, 학생은 어느 쪽이 맞는지 알 방법이 없었다.
      //
      // 라이브 서버는 진짜 HTTP + 진짜 브라우저 + 저장 시 자동 새로고침이라
      // 코치가 검증하는 화면과 정확히 같다.
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showWarningMessage("HypeProof: 작업 폴더를 먼저 열어주세요.");
        return;
      }
      try {
        const base = await liveServer.ensure(root);
        // 워크스페이스 루트 기준 상대경로로 연다. 루트의 index.html 은 `/`.
        const rel = path.relative(root, target.fsPath).split(path.sep).join("/");
        const url = rel === "index.html" ? base : `${base.replace(/\/$/, "")}/${rel}`;
        await vscode.commands.executeCommand("hypeproof-chat.openBrowser", url);
      } catch (err) {
        vscode.window.showErrorMessage(`HypeProof: 미리보기를 열지 못했어요 — ${err instanceof Error ? err.message : String(err)}`);
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
        // #308 — inline notice, not a toast: same trigger path, same freeze
        // mechanism (any visible toast pauses the integrated browser). Focus
        // the panel so the notice is actually visible; if the webview isn't
        // mounted yet, the pending-notice flush on "ready" delivers it.
        provider.postPageNotice(
          "이 코호트에서는 '페이지를 코치에게' 기능이 꺼져 있어요.",
        );
        await vscode.commands.executeCommand("hypeproof-chat.panel.focus");
        return;
      }
      const ctx = await captureActivePage();
      if (!ctx) return;
      // #278 Phase 2 — attach the screenshot too (image_paste-gated inside).
      provider.attachPageContext({
        url: ctx.url,
        title: ctx.title,
        text: ctx.text,
        imageBase64: ctx.imageBase64,
      });
      await vscode.commands.executeCommand("hypeproof-chat.panel.focus");
      // #308 — the "붙였어요" confirmation is shown inline in the chat panel by
      // attachPageContext (pageAttached message). A VS Code toast is NOT used
      // here: a visible toast pauses the integrated browser ("Paused due to
      // Notification"), which broke every capture in the workshop.
    }),

    // #384 — "drag a screenshot in" that survives VS Code. Dropping a file on
    // the editor makes VS Code open it as a tab (it intercepts the drop before
    // the chat webview ever sees it). So we watch for an image tab opening and
    // offer to attach it to the coach — turning the interception into the
    // feature. image_paste-gated; the user still confirms via a one-click
    // notification (never silent).
    vscode.window.tabGroups.onDidChangeTabs(async (e) => {
      if (!provider.isImagePasteEnabled()) return;
      for (const tab of e.opened) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        const uri = input?.uri;
        if (!uri || uri.scheme !== "file") continue;
        if (!/\.(png|jpe?g|gif|webp)$/i.test(uri.fsPath)) continue;
        const name = uri.path.split("/").pop() ?? "이미지";
        const pick = await vscode.window.showInformationMessage(
          `🖼 방금 연 이미지 "${name}"를 코치 채팅에 붙일까요?`,
          "붙이기",
        );
        if (pick !== "붙이기") continue;
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const ext = (uri.path.split(".").pop() ?? "png").toLowerCase();
          const mime = ext === "jpg" ? "jpeg" : ext;
          const dataUrl = `data:image/${mime};base64,${Buffer.from(bytes).toString("base64")}`;
          provider.attachImageDataUrl(dataUrl, name);
          await vscode.commands.executeCommand("hypeproof-chat.panel.focus");
        } catch {
          const pasteKey = process.platform === "darwin" ? "⌘V" : "Ctrl+V";
          void vscode.window.showWarningMessage(`이미지를 읽지 못했어요. ${pasteKey}로 붙여넣어 주세요.`);
        }
      }
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
  // 0. The workspace folder is now cohort-driven (#422): it is created/opened
  //    only AFTER the profile is resolved, so its name + starter match the
  //    cohort (website vs game). That happens in the token paths below and in
  //    the setToken success handler. We no longer create a hardcoded folder
  //    here before we know the cohort.

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

  // 3. Profile is valid — open the cohort's workspace folder (#422). If a
  //    folder is already open this is a no-op; otherwise it opens the
  //    profile-specified folder and the window reloads (post-reload activation
  //    finds the folder open and skips it).
  if (await ensureWorkspace(profile, context)) {
    return; // window is reloading
  }

  // 4. Coach naming is now driven by an in-panel card (kid-friendly), not a
  //    system input box. The webview shows it when coach.configured is false
  //    and the profile requests user_names_it. Nothing to do here.
}

// Legacy fallback folder — used only when the profile carries no (or an
// unusable) `workspace_root`. Cohorts now drive this via profile.workspace_root
// (#422): "~/HypeProofClinic" for the dental website cohort, "~/HypeProofGames"
// for kids, etc. os.homedir() makes the fallback path always absolute.
const LEGACY_WORKSPACE_DIRNAME = "HypeProofGames";

/**
 * globalState key holding the root we last tried to switch TO. Written before
 * the reload, cleared once we land (or once we decide not to switch). Its only
 * job is to make a failed `vscode.openFolder` fail ONCE: without it, a root that
 * cannot be opened would be retried on every post-reload activation and the
 * learner's window would reload forever mid-lecture.
 */
const WORKSPACE_SWITCH_ATTEMPT_KEY = "hypeproofChat.workspaceSwitchAttempt";

async function clearWorkspaceSwitchAttempt(context?: vscode.ExtensionContext): Promise<void> {
  if (!context) return;
  if (context.globalState.get<string>(WORKSPACE_SWITCH_ATTEMPT_KEY) === undefined) return;
  await context.globalState.update(WORKSPACE_SWITCH_ATTEMPT_KEY, undefined);
}

/**
 * realpath the nearest EXISTING ancestor and re-append the tail, so a folder
 * that does not exist yet still canonicalizes. Same shape as the twins in
 * chatPanelProvider/sdkCoach (#384) — a symlinked home (`/var` → `/private/var`,
 * a redirected profile folder on Windows) must not read as a DIFFERENT root, or
 * we would switch away from the folder we are already in, forever.
 */
function canonicalizeFsPath(p: string): string {
  let base = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0
        ? fs.realpathSync(base)
        : path.join(fs.realpathSync(base), ...tail.reverse());
    } catch {
      const parent = path.dirname(base);
      if (parent === base) return path.resolve(p);
      tail.push(path.basename(base));
      base = parent;
    }
  }
}

// Per-tone background for the throwaway starter index.html. The title/subtitle
// come from the single source of truth (TONE_LABELS.aboutTitle/aboutSubtitle),
// so game / search-webapp / website each get copy matching their chat panel.
const STARTER_BG: Record<string, string> = {
  game: "#1b1b2a",
  search: "#0b1f2a",
  site: "#0f172a",
};

/**
 * The placeholder index.html seeded into a fresh workspace. Uses the cohort's
 * tone (appToneOf) so a website cohort never sees a "🎮 게임" starter (#422).
 * It's a throwaway — the coach overwrites it on the first build.
 */
function starterIndexHtml(profile?: ResolvedProfile | null): string {
  const tone = appToneOf(profile ?? undefined);
  const { aboutTitle, aboutSubtitle } = TONE_LABELS[tone];
  const bg = STARTER_BG[tone] ?? STARTER_BG.game;
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>${aboutTitle}</title>
  <style>
    body { margin:0; height:100vh; display:flex; align-items:center;
           justify-content:center; background:${bg}; color:#fff;
           font-family:-apple-system,sans-serif; text-align:center; }
  </style>
</head>
<body>
  <div>
    <h1>${aboutTitle}</h1>
    <p>${aboutSubtitle}</p>
  </div>
</body>
</html>
`;
}

/**
 * Resolve a profile's `workspace_root` to an absolute path. Expands a leading
 * `~`. Returns null when the value can't be trusted as an absolute location
 * (relative or empty) — the caller then falls back to the legacy folder, so a
 * misauthored profile can never point the open-folder at a relative path and
 * trigger a reload loop.
 */
export function resolveWorkspaceRoot(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const expanded =
    v === "~" ? os.homedir()
    : v.startsWith("~/") || v.startsWith("~\\") ? path.join(os.homedir(), v.slice(2))
    : v;
  return path.isAbsolute(expanded) ? expanded : null;
}

/**
 * Make sure the learner has a real folder to work in, matching their cohort.
 * The folder path comes from `profile.workspace_root` and the starter page from
 * `profile.game.template_tier` (website vs game) — #422. When the profile is
 * absent (called before onboarding resolves it) or carries no workspace_root,
 * we fall back to the legacy `~/HypeProofGames` + game starter, so existing
 * cohorts are unchanged.
 *
 * Returns true if the window is reloading (caller should bail).
 *
 * A folder being open is NOT automatically a no-op. VS Code restores the last
 * window, so once `~/HypeProofGames` was opened it hijacked every later session:
 * a different cohort's token could never move the window, and the coach's cwd
 * (resolveCoachCwd prefers the OPEN folder) stayed on the stale one — an adult
 * cohort ran its lecture inside the kids' game folder. So when the profile names
 * a different root we switch to it (decideWorkspaceSwitch owns the rules; the
 * reload-loop guard is `WORKSPACE_SWITCH_ATTEMPT_KEY` below).
 *
 * Race protection (#42): even with `onStartupFinished` activation, a
 * positional `--folder` arg may take a tick to register in
 * `workspaceFolders`. Grace-poll for up to 1s before deciding to trigger a
 * create-and-reload — without this, e2e cold-launch with a pre-opened test
 * folder would briefly see workspaceFolders empty, fire openFolder, and
 * reload mid-onboard, racing the setToken QuickInput.
 */
async function ensureWorkspace(
  profile?: ResolvedProfile | null,
  context?: vscode.ExtensionContext,
): Promise<boolean> {
  let open: string[] = [];
  for (let i = 0; i < 10; i++) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      open = folders.map((f) => f.uri.fsPath);
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (open.length > 0) {
    const attempted = context?.globalState.get<string>(WORKSPACE_SWITCH_ATTEMPT_KEY) ?? null;
    const decision = decideWorkspaceSwitch({
      openFolders: open,
      desiredRoot: profile?.workspace_root ? resolveWorkspaceRoot(profile.workspace_root) : null,
      lastAttemptedRoot: attempted,
      isE2E: !!process.env.HPS_TEST_E2E,
      canonicalize: canonicalizeFsPath,
    });
    if (!decision.switch) {
      console.info(`[workspace] staying in ${open[0]} — ${decision.reason}`);
      // We just came back from a switch we ordered. Say so: a folder that
      // silently changes underneath the learner reads as "my files are gone".
      // The toast is post-reload on purpose — one fired before openFolder dies
      // with the window and is never seen.
      if (attempted && open.some((f) => isSameLocation(f, attempted, canonicalizeFsPath))) {
        vscode.window.showInformationMessage(
          `작업 폴더를 수업에 맞는 곳으로 옮겼어요: ${path.basename(attempted)} 📁`,
        );
      }
      // The attempt marker has served its purpose (either we landed where we
      // meant to, or we deliberately gave up). Clear it so a LATER cohort change
      // is not mistaken for a failed retry of this one.
      await clearWorkspaceSwitchAttempt(context);
      return false;
    }
    console.warn(`[workspace] cohort folder differs — switching ${decision.from} → ${decision.to}`);
    // Record BEFORE the reload: if the open fails we must not try again.
    await context?.globalState.update(WORKSPACE_SWITCH_ATTEMPT_KEY, decision.to);
    return await openWorkspaceFolder(decision.to, profile);
  }

  // Folder + starter are cohort-driven; legacy fallback keeps old cohorts intact
  // and guarantees an absolute path (a relative workspace_root resolves to null).
  const resolved = profile?.workspace_root ? resolveWorkspaceRoot(profile.workspace_root) : null;
  const dir = resolved ?? path.join(os.homedir(), LEGACY_WORKSPACE_DIRNAME);
  return await openWorkspaceFolder(dir, profile);
}

/**
 * Create `dir` (with the cohort's starter page if empty) and open it as the
 * single workspace root. Returns true when the open was issued — the window is
 * reloading and the caller must bail. Returns false if the folder could not be
 * created: we continue without a workspace rather than trapping the learner
 * (chat + preview still work).
 *
 * Shared by BOTH entry paths (first open, and the cohort switch) so a switched
 * folder gets the same trust/startup-editor treatment as a freshly created one.
 */
async function openWorkspaceFolder(
  dir: string,
  profile?: ResolvedProfile | null,
): Promise<boolean> {
  // Disable the "Do you trust the authors of this folder?" modal BEFORE
  // opening the folder. It's auto-created by us; a learner should never
  // see a scary security dialog. Persisted to global settings so it sticks.
  try {
    await vscode.workspace
      .getConfiguration("security.workspace.trust")
      .update("enabled", false, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration("workbench")
      .update("startupEditor", "none", vscode.ConfigurationTarget.Global);
  } catch { /* ignore: read-only profile */ }

  try {
    fs.mkdirSync(dir, { recursive: true });
    const indexPath = path.join(dir, "index.html");
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, starterIndexHtml(profile));
    }
  } catch {
    return false;
  }

  // Single-root open (clean Explorer). Reloads the window.
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), {
    forceReuseWindow: true,
  });
  return true;
}

async function applyTestBackdoors(
  context: vscode.ExtensionContext,
): Promise<{ testStateFileFound: boolean }> {
  // Source 1: env vars (works when Playwright passes them through to the
  // extension host, which is inconsistent across VS Code versions).
  let token = process.env.HPS_TEST_TOKEN;
  let testStateFileFound = false;
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
        // 파싱 성공 여부와 무관하게 "테스트 런" 표식이다 — #580 스풀 게이트가
        // 이 플래그를 env 와 OR 로 쓴다 (파일은 env 보다 신뢰 가능한 채널).
        testStateFileFound = true;
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
    const coachInfo = { name: coachName, personality: coachPersonality, configured: true };
    // Legacy flat keys — kept for back-compat with pre-cohort-scoping builds.
    await context.globalState.update(LEGACY_COACH_KEY, coachInfo);
    await context.globalState.update(LEGACY_COACH_RITUAL_DONE_KEY, true);
    // Cohort-scoped keys — the runtime moved coach state to per-cohort buckets
    // (coachKeyForCohort) and only back-fills the legacy value via an async
    // migration that runs *after* the profile fetch resolves. On webview
    // "ready" postConfig can read the still-empty scoped key first, flashing
    // the naming ritual in front of a preseeded test (breaks preseedCoach on
    // the current extension). Writing the scoped keys directly here removes
    // that race. The cohort is read (unverified) from the seeded token.
    const cohortId = extractCohortIdUnverified(token);
    if (cohortId) {
      await context.globalState.update(coachKeyForCohort(cohortId), coachInfo);
      await context.globalState.update(coachRitualDoneKeyForCohort(cohortId), true);
    }
  }
  // Pre-seed chat history so e2e tests can exercise preview / reload paths
  // without depending on a live LLM round-trip. Same legacy + cohort-scoped
  // dual-write as the coach state above (history moved to per-cohort buckets
  // with the same async migration race).
  if (history && history.length > 0) {
    await context.workspaceState.update(LEGACY_HISTORY_KEY, history);
    const cohortId = extractCohortIdUnverified(token);
    if (cohortId) {
      await context.workspaceState.update(historyKeyForCohort(cohortId), history);
    }
  }
  // Pre-seed issuer token for mint-flow tests (G5/G6).
  if (issuerToken && issuerToken.length > 0) {
    await context.secrets.store(ISSUER_TOKEN_KEY, issuerToken);
  }
  return { testStateFileFound };
}

export function deactivate() {
  providerRef = null;
}

export { TOKEN_KEY };
