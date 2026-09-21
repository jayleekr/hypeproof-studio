import { registerLocalReview } from "./localReviewPanel";
import { ActivityConnectionError, ActivityConnections, activityConnections } from './activityConnections';
import { fetchProfileResult } from './proxyClient';
import { ClassroomOpsHost } from './classroomOpsHost';
import { prepareWorkspaceDirectory } from './workspacePreparation';
import { imageAttachPrompt } from "./coachIdentity.ts";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { StartPage } from "./startPage";
import { ChatPanelProvider } from "./chatPanelProvider";
import {
  labelsForProfile,
  appToneOf,
  TONE_LABELS,
  extractCohortIdUnverified,
  coachKeyForCohort,
  coachRitualDoneKeyForCohort,
  historyKeyForCohort,
  LEGACY_COACH_KEY,
  LEGACY_COACH_RITUAL_DONE_KEY,
  LEGACY_HISTORY_KEY,
} from "./chatPanelHelpers";
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
import { openBrowser, captureActivePage, registerPreviewViewport } from "./nativeBrowser";
import { LiveServer } from "./liveServer";
import { decideWorkspaceSwitch, isSameLocation } from "./workspaceRouting";
import { SessionSpool, resolveSpoolSessionsRoot, spoolIdentityFromToken } from "./sessionSpool";
import { uploadAllPending, scanUploadableSessions } from "./spoolUploader";
import type { ResolvedProfile } from "./protocol";

const TOKEN_KEY = "hypeproofChat.workshopToken";

let providerRef: ChatPanelProvider | null = null;
/** #596 — re-entry lock on the upload command (banner + palette clicked at once → no double upload). */
let uploadInFlight = false;

export async function activate(context: vscode.ExtensionContext) {
  const connections = new ActivityConnections(context,
    () => vscode.workspace.getConfiguration('hypeproofChat').get<string>('proxyUrl','https://api.hypeproof-ai.xyz/v1'),
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    async token => {
      const result = await fetchProfileResult({token,proxyUrl:vscode.workspace.getConfiguration('hypeproofChat').get<string>('proxyUrl','https://api.hypeproof-ai.xyz/v1')});
      if (!result.ok) throw new Error(result.failure.friendly);
      return result.profile;
    });
  try { await connections.initialize(); }
  catch { void vscode.window.showWarningMessage('저장된 활동을 읽지 못했습니다. 작업 파일은 보존됩니다. 참여 코드를 다시 입력해 주세요.'); }
  context = connections.wrap();
  // Respect the existing workspace-trust setting. Changing it on activation
  // forced a restart dialog over the first-run page.

  // Test-only backdoors. Reads from env vars (which Playwright may not always
  // propagate to the extension host) AND a JSON file in the user-data-dir as
  // a more reliable fallback.
  const backdoors = await applyTestBackdoors(context);

  const preview = new PreviewProvider(context);
  const liveServer = new LiveServer();
  registerPreviewViewport(context, liveServer);
  // SX-59 — the old capability status bar was built here and sat on screen for the
  // whole session. It was removed module and all, per the requirement that no
  // capability score, grade or badge belongs on the working screen. What disappeared
  // is held by git history and `test/sx-legacy-score-removed.smoke.mjs` — writing the
  // deleted strings back into a comment makes that absence check trip over its own
  // documentation (which it did, once).
  // #580 — local session-log spool (collection layer). A session = one activation of
  // this extension. The directory is created lazily on the first event, so a window
  // with no chat leaves nothing behind.
  //
  // An e2e run makes no spool: the spool root is deliberately a fixed path OUTSIDE
  // user-data-dir, which bypasses e2e's fresh-user-data-dir isolation, and the e2e
  // fixture preseeds a real cohort's real token — so synthetic turns would pile up in
  // the real-device spool as sessions under a real student's identity. The moment an
  // uploader exists, that is analytics contamination.
  //
  // The gate is env OR the test state file. This file itself has written down that
  // env (HPS_TEST_E2E) propagates "inconsistently" as far as the extension host (that
  // is why REQ-A7's file backdoor exists), and contamination requires the token to
  // arrive — and the token comes either by env or by that file, so whichever one got
  // through, the gate catches it.
  // An F5 development host does record, but is marked `dev: true` in meta so it can
  // be filtered out.
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
  // #897 (VO-01) — voice capability diagnosis. It runs **by command only**: after the
  // core patch this path raises an OS permission prompt, so it must never be run at
  // activation time.
  //
  // It sits **outside** the spool branch. In #904 this registration had been put
  // inside `if (spool)`, and `spool` is undefined on a test run (`isTestRun`) or when
  // spool initialization fails — so under exactly those conditions the command
  // silently disappeared. A diagnostic tool that vanishes when diagnosis is needed is
  // worse than no tool at all.
  context.subscriptions.push(
    vscode.commands.registerCommand("hypeproof-chat.diagnoseVoiceCapability", async () => {
      const { diagnoseVoiceCapability } = await import("./voiceCapability");
      await diagnoseVoiceCapability(context, provider, provider.voiceLogChannel());
    }),
  );

  if (spool) {
    // Total-size cap enforcement (#580 D7) — fire-and-forget so it never blocks
    // activation; failures are swallowed.
    void spool.sweepRetention();
    // On shutdown, flush the last events left in the queue (best-effort — a crash is
    // covered by the line-at-a-time append).
    context.subscriptions.push({ dispose: () => void spool.flush() });
    // #596 — leftovers banner at startup (once per activation). The session-end
    // banner only fires on the proxy runtime's session_window, but the main runtime
    // is agent-sdk (session 1 review F6), so that path alone never reaches anyone —
    // instead, the next startup that finds "records not sent" offers the button. The
    // upload itself still only happens on a click.
    const pendingTimer = setTimeout(() => {
      void (async () => {
        try {
          const token = await context.secrets.get(TOKEN_KEY);
          if (!token) return;
          const pending = scanUploadableSessions(spoolRoot, {
            currentSessionDir: spool.currentSessionDir(),
            // Shared PC (N2): count only the sessions belonging to this token's
            // owner — ringing the banner over someone else's leftovers uploads
            // someone else's raw text under THIS student's consent.
            identity: spoolIdentityFromToken(token),
          });
          if (pending.length === 0) return;
          const profile = await provider.ensureProfile();
          if (profile?.analytics?.upload_session_logs !== true) return;
          const pick = await vscode.window.showInformationMessage(
            `지난 활동 기록 ${pending.length}개가 아직 안 보내졌어요 — 지금 보낼까요?`,
            "기록 보내기",
          );
          if (pick === "기록 보내기") {
            void vscode.commands.executeCommand("hypeproof-chat.uploadSessionLogs");
          }
        } catch { /* best-effort — a failed banner must not get in the way of activation */ }
      })();
    }, 15_000);
    context.subscriptions.push({ dispose: () => clearTimeout(pendingTimer) });
  }
  const provider = new ChatPanelProvider(context, preview, liveServer, spool);
  providerRef = provider;
  registerLocalReview(context, (webview, dist) => provider.renderHtml(webview, dist));
  const startPage = new StartPage(context, provider, async (profile, commit) => {
    return ensureWorkspace(profile, context, isTestRun && process.env.HPS_TEST_REAL_WORKSPACE !== "1", commit);
  });
  context.subscriptions.push(vscode.commands.registerCommand("hypeproof-chat.start", () => startPage.show()));
  // kids-quest — skeleton round result → next-turn context for the coach.
  context.subscriptions.push(preview.onResult((r) => provider.attachQuestResult(r)));

  const classroomOps = new ClassroomOpsHost(context, () => provider.opsRuntime(), {
    hasActiveRun: () => provider.hasActiveStream(),
    probeProfile: async () => {
      const token = await context.secrets.get(TOKEN_KEY);
      if (!token) return { ok: false, noToken: true };
      const r = await fetchProfileResult({ token, proxyUrl: vscode.workspace.getConfiguration("hypeproofChat").get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1") });
      return r.ok ? { ok: true } : { ok: false, status: r.failure.status, code: r.failure.reason === "expired" ? "expired" : undefined, requestId: r.failure.requestId, network: r.failure.reason === "network" };
    },
    refreshProfile: async () => !!(await provider.ensureProfile(true)),
    requestStop: () => provider.opsRequestStop(),
    freezeInput: (frozen) => provider.opsFreezeInput(frozen),
    preservation: () => provider.opsPreservation(),
    runtimeGeneration: () => provider.opsRuntimeGeneration(),
    newGeneration: () => provider.opsNewGeneration(),
    setHold: (hold) => provider.opsSetHold(hold),
    recoverPreview: async () => {
      const probe = async (url: string) => { try { return (await fetch(url, { signal: AbortSignal.timeout(4000) })).status < 500; } catch { return false; } };
      const r = await liveServer.recover(probe);
      return { state: r.state, healthy: r.url ? await probe(r.url) : false };
    },
  }, (line) => console.log(line));
  provider.opsObserver = classroomOps;
  void classroomOps.resume();
  context.subscriptions.push(
    { dispose: () => liveServer.dispose() },
    vscode.window.registerWebviewViewProvider("hypeproof-chat.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Preview is no longer a sidebar view — it's an editor-area WebviewPanel
    // created on demand by PreviewProvider.show().

    vscode.commands.registerCommand("hypeproof-chat.focus", () => {
      if (!provider.focusEditor()) vscode.commands.executeCommand("hypeproof-chat.panel.focus");
    }),

    // #751 — remote classroom operations: learner-initiated, status-only, droppable.
    vscode.commands.registerCommand("hypeproof-chat.classroomConnect", () => classroomOps.connectInteractively()),
    vscode.commands.registerCommand("hypeproof-chat.classroomDisconnect", () => classroomOps.disconnectInteractively()),
    vscode.commands.registerCommand("hypeproof-chat.classroomNotes", () => classroomOps.showCoachingNotes()),

    vscode.commands.registerCommand("hypeproof-chat.clearHistory", async () => {
      await provider.clearHistory();
      vscode.window.showInformationMessage("HypeProof Chat: conversation cleared.");
    }),

    // #596 — session-log upload (#580 upload layer). It always runs on an **explicit
    // action** only: this command (palette), or the button on the session-end /
    // startup leftovers banner.
    //
    // The ORDER is the whole point: first **seal** the current session (seal — the
    // spool routes the next event into a new session), then upload the sealed
    // directory with the quiescence gate waived (allowFresh). Without this, the
    // "exclude the active session" rule means the end-of-day-1 banner uploads none of
    // today's data (session 1 review F1). Active sessions in other windows are still
    // protected by the quiescence gate (UPLOAD_QUIESCENT_MS) (F2).
    vscode.commands.registerCommand("hypeproof-chat.uploadSessionLogs", async () => {
      if (!spool) {
        vscode.window.showInformationMessage("테스트 실행에서는 세션 기록을 남기지 않아요.");
        return;
      }
      if (uploadInFlight) {
        vscode.window.showInformationMessage("이미 기록을 보내는 중이에요 — 잠시만요.");
        return;
      }
      // Take the lock immediately after the check — if a second call slips in between
      // the awaits below, the lock is decoration (session 2 review N4).
      uploadInFlight = true;
      try {
        const token = await context.secrets.get(TOKEN_KEY);
        if (!token) {
          vscode.window.showInformationMessage("토큰을 먼저 넣어주세요 — 기록은 토큰의 수업으로 보내져요.");
          return;
        }
        const profile = await provider.ensureProfile();
        if (profile === null) {
          // A failed lookup must not be merged with "the feature is off" (#381), and
          // the wording must not assert a cause either (the 401 misreading incident in
          // verification.md) — the side that knows the cause AND the next action is
          // profileFailure.
          vscode.window.showWarningMessage(
            provider.profileFailure()?.friendly ??
              "수업 정보를 확인하지 못했어요 — 잠시 후 다시 시도해주세요.",
          );
          return;
        }
        if (profile.analytics?.upload_session_logs !== true) {
          // The server refuses it anyway (fail closed) — say so quietly, up front.
          vscode.window.showInformationMessage("이 수업은 기록 업로드를 사용하지 않아요.");
          return;
        }
        const proxyUrl = vscode.workspace
          .getConfiguration("hypeproofChat")
          .get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "오늘 활동 기록 보내는 중…" },
          async () => {
            // Record the attempt **before sealing, and only into a session that
            // already had activity**. Recording after the seal materializes a junk
            // one-event session, which becomes the next startup banner's "1 record not
            // sent" and kills the signal (N3).
            if (spool.currentSessionDir()) {
              // Seal the real index.html as it stands at the end of the lesson, not
              // the code inside a chat reply. Whatever the child edited by hand last
              // then survives into the outcome analysis.
              await provider.captureFinalArtifactForSpool();
              spool.recordWorkflow({ event: "logs_upload" });
            }
            const sealed = await spool.seal();
            const results = await uploadAllPending(spoolRoot, {
              baseUrl: proxyUrl,
              token,
              currentSessionDir: spool.currentSessionDir(),
              // Shared-PC defence (N2): only sessions whose meta matches this token's identity.
              identity: spoolIdentityFromToken(token),
              ...(sealed ? { allowFresh: [sealed] } : {}),
            });
            const ok = results.filter((r) => r.ok).length;
            const fail = results.length - ok;
            // The result tally goes to the console, not the spool — writing it to the
            // spool materializes the empty post-seal session and starts a junk chain
            // (N3).
            console.log(`[spool-upload] sessions=${results.length} ok=${ok} fail=${fail}`);
            if (results.length === 0) {
              vscode.window.showInformationMessage("보낼 새 기록이 없어요.");
            } else if (fail === 0) {
              vscode.window.showInformationMessage(`활동 기록 ${ok}개 세션을 보냈어요!`);
            } else {
              const first = results.find((r) => !r.ok);
              vscode.window.showWarningMessage(
                `기록 ${ok}개는 보냈고 ${fail}개는 실패했어요 — 나중에 "오늘 활동 기록 보내기"를 다시 실행하면 이어서 보내요.` +
                  (first?.message ? ` (${first.message})` : ""),
              );
            }
          },
        );
      } finally {
        uploadInFlight = false;
      }
    }),

    vscode.commands.registerCommand("hypeproof-chat.setToken", () => startPage.show()),

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
      // Preview is consolidated onto **one live server** (원장 decision 2026-07-27).
      //
      // It used to render the HTML directly in a webview. That makes the screen the
      // coach sees (live_preview_start → 127.0.0.1) and the screen the student opens
      // by right-click **two different truths**. In real use the right-click preview
      // showed content that lagged behind the live one, and the student had no way to
      // tell which was right.
      //
      // The live server is real HTTP + a real browser + auto-reload on save, so it is
      // exactly the screen the coach verifies against.
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showWarningMessage("HypeProof: 작업 폴더를 먼저 열어주세요.");
        return;
      }
      try {
        const base = await liveServer.ensure(root);
        // Open by a path relative to the workspace root. index.html at the root is `/`.
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
    // from the active /v1/profile response so the instructor doesn't have to retype
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
      try {
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
      } catch (error) {
        vscode.window.showWarningMessage(`업데이트를 확인하지 못했습니다. 잠시 후 다시 시도해주세요. ${(error as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("hypeproof-chat.installUpdate", async () => {
      try {
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
      } catch (error) {
        vscode.window.showErrorMessage(`업데이트를 완료하지 못했습니다. 현재 앱은 종료하지 않습니다. ${(error as Error).message}`);
      }
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
          imageAttachPrompt(provider.coachDisplayName(), name),
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

  // The start surface owns connection and explicit course entry.
  void startPage.show();

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
    destructive?: boolean;
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
      destructive: cfg.destructive,
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
  isTestRun = false,
  commit: (directory?: string) => Promise<void> = async () => {},
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
      // Reuse the env OR file fixture verdict from activation (same as spool).
      isE2E: isTestRun,
      canonicalize: canonicalizeFsPath,
    });
    if (!decision.switch) {
      const desired = profile?.workspace_root ? resolveWorkspaceRoot(profile.workspace_root) : null;
      if (!isTestRun && desired && !isSameLocation(open[0], desired, canonicalizeFsPath)) {
        await clearWorkspaceSwitchAttempt(context);
        throw new Error('Activity workspace is not the active root');
      }
      console.info(`[workspace] staying in ${open[0]} — ${decision.reason}`);
      // We just came back from a switch we ordered. Say so: a folder that
      // silently changes underneath the learner reads as "my files are gone".
      // The toast is post-reload on purpose — one fired before openFolder dies
      // with the window and is never seen.
      if (attempted && open.some((f) => isSameLocation(f, attempted, canonicalizeFsPath))) {
        vscode.window.showInformationMessage(
          `선택한 활동의 작업 폴더를 열었습니다: ${path.basename(attempted)}`,
        );
      }
      // The attempt marker has served its purpose (either we landed where we
      // meant to, or we deliberately gave up). Clear it so a LATER cohort change
      // is not mistaken for a failed retry of this one.
      await clearWorkspaceSwitchAttempt(context);
      await commit(open[0]);
      return false;
    }
    console.warn(`[workspace] cohort folder differs — switching ${decision.from} → ${decision.to}`);
    // Record BEFORE the reload: if the open fails we must not try again.
    await context?.globalState.update(WORKSPACE_SWITCH_ATTEMPT_KEY, decision.to);
    try { return await openWorkspaceFolder(decision.to, profile, commit, context); }
    catch (error) { await clearWorkspaceSwitchAttempt(context); throw error; }
  }

  // Folder + starter are cohort-driven; legacy fallback keeps old cohorts intact
  // and guarantees an absolute path (a relative workspace_root resolves to null).
  const resolved = profile?.workspace_root ? resolveWorkspaceRoot(profile.workspace_root) : null;
  const dir = resolved ?? path.join(os.homedir(), LEGACY_WORKSPACE_DIRNAME);
  return await openWorkspaceFolder(dir, profile, commit, context);
}

/**
 * Create `dir` (with the cohort's starter page if empty) and open it as the
 * single workspace root. Returns true when the open was issued — the window is
 * reloading and the caller must bail. Returns false if the folder could not be
 * created: preparation now throws and entry retains the prior connection.
 *
 * Shared by BOTH entry paths (first open, and the cohort switch) so a switched
 * folder gets the same trust/startup-editor treatment as a freshly created one.
 */
async function openWorkspaceFolder(
  dir: string,
  profile: ResolvedProfile | null | undefined,
  commit: (directory?: string) => Promise<void>,
  context?: vscode.ExtensionContext,
): Promise<boolean> {
  try {
    const prepare=()=>prepareWorkspaceDirectory(dir, !profile || profile.workspace_start === 'empty' ? 'empty' : 'html', () => starterIndexHtml(profile));
    const connections=context && activityConnections(context);
    if(connections && profile)connections.prepare(dir,profile,prepare);else prepare();
  } catch(error) {
    if(error instanceof ActivityConnectionError)throw error;
    throw new Error('Activity workspace preparation failed');
  }
  await commit(dir);

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
        // Regardless of whether parsing succeeds, this is the "test run" marker —
        // the #580 spool gate ORs this flag with env (the file is a more trustworthy
        // channel than env).
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
    try {
      await context.secrets.store(TOKEN_KEY, token);
    } catch {
      // A stale development seed must not prevent command registration or
      // the normal participation screen from opening. Never log the token.
      void vscode.window.showWarningMessage('개발용 참여 코드를 연결하지 못했습니다. 새 코드로 수업에 다시 참여해 주세요.');
    }
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
    const cohortId = activityConnections(context)?.scope ?? extractCohortIdUnverified(token);
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
    const cohortId = activityConnections(context)?.scope ?? extractCohortIdUnverified(token);
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
