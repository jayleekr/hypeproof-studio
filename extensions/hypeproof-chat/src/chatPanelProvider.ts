import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { TOKEN_KEY, resolveWorkspaceRoot } from "./extension";
import type { AssetScoreSink } from "./assetStatusBar";
import { proxyChat, fetchProfileResult, ProxyAuthError, ProxyTransportError } from "./proxyClient";
import { TOKEN_MISSING_FRIENDLY, type ProfileFailure } from "./proxyClientHelpers";
import { runSdkCoach, SdkUnavailableError, type BrowserMcpHost } from "./sdkCoach";
import { sdkToolToActionRequest, isAbortError, summarizeToolInput } from "./sdkCoachHelpers";
import { commandSignature, describeCommandForApproval } from "./shellPolicy";
import {
  originOfUrl,
  planCoachBrowserTabs,
  coachTabSlot,
  isSameBrowserUrl,
  resolveLivePreviewUrl,
  pickRevealTabIndex,
} from "./browserControlHelpers";

// #525 — 코어에 등록된 일반 에디터 명령. 브라우저 전용 API 로는 탭을 앞으로 가져올
// 수 없어서(BrowserTab 에 show()/reveal() 없음) 이 경로를 쓴다. `openEditorAtIndex`
// 는 **활성 그룹**에서 0-based 인덱스로 연다(코어 editorCommands.ts) — 그래서 그룹
// 활성화가 먼저다.
const FOCUS_FIRST_GROUP = "workbench.action.focusFirstEditorGroup";
const FOCUS_SECOND_GROUP = "workbench.action.focusSecondEditorGroup";
const OPEN_EDITOR_AT_INDEX = "workbench.action.openEditorAtIndex";
import { PreviewProvider } from "./previewProvider";
import { LiveServer } from "./liveServer";
import { BrowserControl, type BrowserToolCall } from "./browserControl";
import { resolveBrowserSafety } from "./browserSafetyHelpers";
import { extractAgentMd } from "./agentHandoff";
import {
  clampTimeline,
  emptyTimeline,
  modelHistory,
  timelineDelta,
  timelineEnd,
  timelineStart,
  timelineTool,
  type TimelineState,
  type ToolEntry,
} from "./chatTimeline";
import { capturePageContext } from "./nativeBrowser";
import { validateAndRepairHtml, type HtmlStructureResult } from "./htmlStructure";
import {
  PASTED_IMAGE_DIR,
  parsePastedImage,
  pastedImageFailureLabel,
  pastedImageName,
  pastedImageNote,
  pastedImageSavedLabel,
} from "./pastedImages";
import {
  ChatMessage,
  CoachInfo,
  HostMessage,
  ResolvedProfile,
  WebviewMessage,
  ActionRequest,
} from "./protocol";
import {
  isShowIntent,
  clampHistory,
  HISTORY_MAX,
  sanitizeCoachInput,
  abortAllStreams,
  resolveCoach,
  labelsForProfile,
  LEGACY_HISTORY_KEY,
  LEGACY_COACH_KEY,
  LEGACY_COACH_RITUAL_DONE_KEY,
  HISTORY_MIGRATION_DONE_KEY,
  COACH_MIGRATION_DONE_KEY,
  historyKeyForCohort,
  coachKeyForCohort,
  coachRitualDoneKeyForCohort,
  stateBucketId,
  extractCohortIdUnverified,
  browserToolLogLine,
  AiDisclosureGate,
  COACH_DEGRADED_NOTICE,
  sdkFallbackLogLine,
  resolveCoachRuntime,
} from "./chatPanelHelpers";
import { buildChatPanelCsp } from "./cspBuilder";

/**
 * 승인 모달 문구. `kind` 별로 무엇을 하려는지 한국어로 말하고, 확인 버튼도
 * 그 행동의 동사로 쓴다 — `Approve` 보다 `저장`/`위임`이 무엇을 승인하는지
 * 분명하다. 취소는 VS Code 가 항상 붙이므로 따로 만들지 않는다.
 */
const APPROVAL_COPY: Record<string, { title: string; verb: string }> = {
  writeFile: { title: "코치가 파일을 저장하려고 해요:", verb: "저장" },
  readFile: { title: "코치가 파일을 읽으려고 해요:", verb: "읽기" },
  webSearch: { title: "코치가 웹에서 찾아보려고 해요:", verb: "검색" },
  delegateAgent: { title: "코치가 다른 에이전트에게 맡기려고 해요:", verb: "맡기기" },
  browserType: { title: "코치가 페이지에 입력하려고 해요:", verb: "입력" },
};


export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private activeStreams = new Map<string, AbortController>();
  /**
   * #503 — 진행 중인 턴의 단일 타임라인(스트림 id 별). 웹뷰가 화면에 그리는 것과
   * **같은 순수 리듀서**로 만들어 그대로 영속화한다. 규칙이 두 벌이면 창을 다시
   * 열었을 때 순서가 달라진다.
   */
  private turnTimelines = new Map<string, TimelineState>();
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  /**
   * #476 — agent-sdk → proxy 폴백을 참가자에게 알린 적이 있는가 (세션 1회).
   *
   * 매 턴 붙이지 않는 이유: 폴백은 그 머신에서 **계속** 일어난다(시드가 없으면
   * 다음 턴도 마찬가지). 턴마다 같은 경고가 뜨면 두 번째부터는 아무도 안 읽고,
   * 대화 기록이 경고로 덮인다. 능력 상실은 상태이지 사건이 아니다.
   */
  private fallbackNoticeShown = false;
  /**
   * #476 — 개발자용 진단 채널. 이전에는 폴백이 `console.warn` 한 줄이었는데,
   * 확장에 `createOutputChannel` 이 **한 군데도 없어서** 그 줄은 어디에도 남지
   * 않았다: 사고 당일 전 세션의 `exthost.log` 에서 `[coach]` 문자열이 0건이었다.
   * 즉 사후에 "이 교실이 프록시로 돌았는가" 를 확인할 방법이 없었다.
   */
  private logChannel: vscode.OutputChannel | null = null;
  private cachedProfile: ResolvedProfile | null = null;
  private profileFetchPromise: Promise<ResolvedProfile | null> | null = null;
  /**
   * #381 — why the last profile fetch failed (null when it succeeded or was
   * never attempted). Read by the token-entry command so a rejected paste gets
   * a cause-specific sentence instead of one generic failure message.
   */
  private lastProfileFailure: ProfileFailure | null = null;
  // #278 — browser-page context queued by "페이지를 코치에게", prepended to the
  // NEXT turn's prompt only (history keeps the user's clean text).
  private pendingPageContext: string | null = null;
  // #278 Phase 2 — screenshot of the current browser page (data: URL), sent as
  // an image with the NEXT turn so the coach can *see* the page. image_paste-
  // gated; consumed once, like pendingPageContext.
  private pendingPageImage: string | null = null;
  // #308 — inline "붙였어요" notice queued for the webview. post() silently
  // drops messages while the view is unresolved, and extension.ts calls
  // attachPageContext() BEFORE panel.focus creates the view — so the notice
  // must survive until the webview signals "ready". Also re-flushed on every
  // remount: WebviewView does not support retainContextWhenHidden, so React
  // state (pageNotice) resets whenever the panel is hidden and re-shown.
  // Cleared alongside pendingPageContext when the queued context is consumed.
  private pendingPageNotice: string | null = null;
  // #320 — AI disclosure at session start (REQ-C14). Host-side gate because
  // the webview forgets everything on hide/show remounts; see AiDisclosureGate.
  private readonly aiDisclosure = new AiDisclosureGate();
  private activeCohortId: string | null = null;
  /**
   * epic #431 — shell command signatures the participant chose to always
   * allow. SESSION-SCOPED and never persisted: a fresh window restores the
   * full judgment. Destructive commands never reach this set (shellPolicy's
   * commandSignature returns null for them), so `rm` can never be remembered.
   */
  private readonly approvedCommandSignatures = new Set<string>();
  /**
   * "이 사이트는 항상 허용" 을 누른 오리진. 셸 시그니처와 같은 규율 —
   * 세션 한정, 저장하지 않는다. 오리진 단위라 다른 사이트는 다시 묻는다.
   */
  private readonly approvedBrowserOrigins = new Set<string>();
  /** #457 — SDK 경로의 검사 도구용 CDP 실행기. 첫 사용 때 만든다. */
  private mcpBrowser?: BrowserControl;
  // Stashed for the bug-report flow (#64). Updated whenever a stream errors
  // or completes — the Worker's request-id middleware (PR #49) plumbs an
  // x-request-id header on every response we can correlate against in tail.
  private lastRequestId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly preview: PreviewProvider,
    private readonly liveServer: LiveServer,
    private readonly assetScores?: AssetScoreSink,
  ) {}

  /**
   * Public accessor for the #64 report-problem flow. Returns the most recent
   * request_id we've seen (from a stream error or successful response). Used
   * to auto-attach to bug reports without the user typing it.
   */
  getLastRequestId(): string | undefined {
    return this.lastRequestId;
  }

  /**
   * Public accessor for #64. Returns the cached profile_id if any. Used as
   * an auto-attached field on bug reports.
   */
  getProfileId(): string | undefined {
    return this.cachedProfile?.profile_id;
  }

  /** #278 — is "페이지를 코치에게" allowed for this cohort? Default off (minor-safe). */
  isPageContextEnabled(): boolean {
    return this.cachedProfile?.input?.page_context === true;
  }

  /**
   * #306 — mirror the cohort's browser_session onto the two settings the fork
   * core patch reads (`hypeproof.browser.safeSession` / `.safeAllowlist`). Safe
   * cohorts (minors) get the hardened persist:hp-safe integrated-browser
   * session; every other cohort explicitly clears it, so switching cohorts in
   * one install self-corrects. Best-effort + feature-detecting: on a Studio
   * build without patches/62-hp-safe-session.patch these keys are unregistered
   * and `update` rejects — we swallow it, since there is no hardened session to
   * drive there and the panel must not crash on older builds.
   */
  private async applyBrowserSafety(profile: ResolvedProfile | null): Promise<void> {
    const { safeSession, safeAllowlist } = resolveBrowserSafety(profile);
    try {
      const cfg = vscode.workspace.getConfiguration("hypeproof.browser");
      await cfg.update("safeSession", safeSession, vscode.ConfigurationTarget.Global);
      await cfg.update("safeAllowlist", safeAllowlist, vscode.ConfigurationTarget.Global);
    } catch {
      /* setting not registered → build without the fork patch; nothing to enforce */
    }
  }

  /** #278 Phase 2 — may we attach a page screenshot (image)? Worker enforces the same gate. */
  isImagePasteEnabled(): boolean {
    return this.cachedProfile?.input?.image_paste === true;
  }

  /**
   * #384 — hand the webview an image data URL to attach to the next turn. Used
   * by the "image opened in an editor tab" flow (extension.ts) so dropping a
   * screenshot onto the editor still reaches the coach. The webview downscales
   * + thumbnails it, same path as ⌘V paste. image_paste-gated by the caller.
   */
  attachImageDataUrl(dataUrl: string, name: string): void {
    void this.post({ type: "attachImage", dataUrl, name });
  }

  /**
   * #278 — stash captured browser-page context for the NEXT turn. The DOM text
   * is prepended to the prompt; the screenshot (if present, and if this cohort
   * has image_paste) rides along as an image so the coach can *see* the page
   * too. History keeps the user's clean text.
   */
  attachPageContext(ctx: { url: string; title: string; text: string; imageBase64?: string }): void {
    const body = ctx.text.trim().slice(0, 3000);
    this.pendingPageContext =
      `[현재 브라우저 페이지]\nURL: ${ctx.url}\n제목: ${ctx.title}\n` +
      `--- 페이지 내용(일부) ---\n${body}\n---\n` +
      `위 페이지를 참고해서 답해줘.`;
    // capturePageContext returns raw JPEG base64 (no data: prefix). Only attach
    // when the cohort allows images — otherwise the worker would drop it anyway.
    this.pendingPageImage =
      ctx.imageBase64 && this.isImagePasteEnabled()
        ? `data:image/jpeg;base64,${ctx.imageBase64}`
        : null;
    // #308 — announce inline in the chat panel, NOT via a VS Code toast (a toast
    // pauses the integrated browser). The webview clears it on the next send.
    const withShot = !!this.pendingPageImage;
    this.postPageNotice(
      `${withShot ? "🖼 화면과 내용을" : "📄 내용을"} 코치에게 붙였어요 — ${ctx.title || ctx.url}. 이제 질문을 입력해 보내세요.`,
    );
  }

  /**
   * #308 — show an inline notice line in the chat panel (toast replacement;
   * a visible toast pauses the integrated browser). The label is stashed in
   * pendingPageNotice and flushed on webview "ready", because at call time the
   * view may not exist yet (attachPageContext runs before panel.focus) or may
   * be recreated later (WebviewView has no retainContextWhenHidden). Posting
   * is idempotent: the webview reducer replaces pageNotice, never appends.
   */
  postPageNotice(label: string): void {
    this.pendingPageNotice = label;
    void this.post({ type: "pageAttached", label });
  }

  /**
   * Public accessor for #64. Returns the persisted chat history (workspaceState).
   * The report flow takes only the tail (last 3) and only when the user
   * explicitly opts in.
   */
  getHistorySnapshot(): ChatMessage[] {
    return this.getHistory();
  }

  // -------------------------------------------------------------------------
  // Public API used by extension.ts
  // -------------------------------------------------------------------------

  extractLastRenderableCode(): string | null {
    const messages = this.getHistory();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const html = extractRenderableHtml(m.content);
      if (html) return html;
    }
    return null;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webviewDist = vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewDist],
    };
    view.webview.html = this.renderHtml(view.webview, webviewDist);

    view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg));
    view.onDidDispose(() => abortAllStreams(this.activeStreams));
  }

  refreshConfig() {
    void (async () => {
      await this.postConfig();
      await this.postHistory();
    })();
  }

  async clearHistory(): Promise<void> {
    await this.context.workspaceState.update(this.historyKey(), []);
    this.assetScores?.resetAssetScores();
    void this.post({ type: "history", messages: [] });
    // #320 — a cleared conversation is a fresh session: disclose again (REQ-C14).
    void this.post({ type: "aiDisclosure", text: this.aiDisclosure.noticeForHistoryClear() });
  }

  /** Force re-fetch on next config push (e.g. after token change). */
  invalidateProfile(): void {
    this.cachedProfile = null;
    this.profileFetchPromise = null;
    this.lastProfileFailure = null;
    this.activeCohortId = null;
    this.assetScores?.resetAssetScores();
  }

  /** #381 — cause of the most recent failed profile fetch, if any. */
  profileFailure(): ProfileFailure | null {
    return this.lastProfileFailure;
  }

  /**
   * Public so extension.ts can drive the naming flow at first launch /
   * when the user clicks the coach name in the header.
   */
  async runCoachNamingRitual(opts: { force?: boolean } = {}): Promise<void> {
    const profile = await this.ensureProfile();
    const mode = profile?.ux.coach.naming_mode ?? "fixed";
    if (mode === "fixed" && !opts.force) {
      // Nothing to ask — fixed name is server-driven (or fallback).
      return;
    }

    const namingPrompt = profile?.ux.coach.naming_prompt_md ?? "코치의 이름";
    const personalityPrompt = profile?.ux.coach.personality_prompt_md ?? "";
    const fallback = profile?.ux.coach.fallback_name ?? "코치";

    const existing = this.getCoach();
    const name = await vscode.window.showInputBox({
      title: stripMd(namingPrompt),
      prompt: "비워두면 기본 이름을 사용해요",
      placeHolder: fallback,
      value: opts.force ? existing.name : "",
      ignoreFocusOut: true,
    });
    if (name === undefined) return;       // user pressed Escape

    let personality = existing.personality;
    if (personalityPrompt) {
      const ans = await vscode.window.showInputBox({
        title: stripMd(personalityPrompt),
        prompt: "건너뛰어도 괜찮아요",
        placeHolder: "예: 친절하고 엉뚱한 친구",
        value: opts.force ? existing.personality : "",
        ignoreFocusOut: true,
      });
      // ans === undefined means user dismissed; preserve existing if force, clear otherwise
      personality = ans ?? (opts.force ? existing.personality : "");
    }

    const sanitized = sanitizeCoachInput(name.trim() || "", personality, fallback);
    const next: CoachInfo = { ...sanitized, configured: true };
    await this.context.globalState.update(this.coachKey(), next);
    await this.context.globalState.update(this.coachRitualDoneKey(), true);
    await this.postConfig();
  }

  /** Should extension.ts pop the naming ritual on this launch? */
  shouldOfferNamingRitual(profile: ResolvedProfile | null): boolean {
    const mode = profile?.ux.coach.naming_mode ?? "fixed";
    if (mode === "fixed") return false;
    const done = this.context.globalState.get<boolean>(this.coachRitualDoneKey(), false);
    if (!done) return true;
    return !!profile?.ux.coach.revisit_on_entry;
  }

  /** Eager profile fetch — called by extension.ts on activation. */
  async ensureProfile(): Promise<ResolvedProfile | null> {
    if (this.cachedProfile) return this.cachedProfile;
    if (this.profileFetchPromise) return this.profileFetchPromise;

    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    const proxyUrl = cfg.get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (!token) {
      this.lastProfileFailure = null;
      return null;
    }

    this.profileFetchPromise = fetchProfileResult({ proxyUrl, token }).then(
      async (r) => {
        // #381 — remember WHY, so the token-entry flow can say something the
        // participant can act on instead of one generic "확인이 안 돼요".
        this.lastProfileFailure = r.ok ? null : r.failure;
        const p = r.ok ? r.profile : null;
        this.cachedProfile = p;
        this.profileFetchPromise = null;
        // #278 — gate the "페이지를 코치에게" toolbar button to opted-in cohorts.
        void vscode.commands.executeCommand(
          "setContext",
          "hypeproof-chat.pageContextEnabled",
          p?.input?.page_context === true,
        );
        // #306 — mirror the cohort's browser_session onto the hardened-session
        // settings the fork core patch reads (minor cohorts → persist:hp-safe).
        await this.applyBrowserSafety(p);
        this.activeCohortId = extractCohortIdUnverified(token) ?? null;
        await this.migrateLegacyStateForActiveCohort();
        // Apply tone-appropriate labels to the preview panel (#159).
        const labels = labelsForProfile(p);
        this.preview.setLabels({
          title: labels.previewTitle,
          placeholder: labels.previewPlaceholder,
          emoji: labels.namingEmoji,
        });
        return p;
      },
      () => {
        this.profileFetchPromise = null;
        return null;
      },
    );
    return this.profileFetchPromise;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private getCoach(): CoachInfo {
    return this.context.globalState.get<CoachInfo>(this.coachKey(), {
      name: "",
      personality: "",
      configured: false,
    });
  }

  /**
   * Save the latest game to the workspace root as index.html so it persists
   * and is GitHub-Pages-ready. No approval modal — this is the kid saving
   * their own game in their own workspace (the core flow), not an AI-initiated
   * arbitrary file write.
   */
  /**
   * #371 — persist the coach's ```agent-md handoff fence to workspace/agent.md
   * (same sanctioned workspace-write pattern as index.html, REQ-D5). Surfaced
   * as a toolLog line so the participant knows the file exists.
   */
  private async saveAgentMdIfPresent(text: string, streamId?: string): Promise<void> {
    const md = extractAgentMd(text);
    if (!md) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    try {
      const target = vscode.Uri.joinPath(folders[0].uri, "agent.md");
      await vscode.workspace.fs.writeFile(target, Buffer.from(md, "utf8"));
      if (streamId) {
        this.postToolLog(streamId, {
          id: randomId(),
          icon: "📝",
          label: "agent.md 저장됨 — 작업 폴더에서 확인하세요",
          state: "done",
        });
      }
    } catch {
      // Non-fatal: the coach's reply already tells the user to copy manually.
    }
  }

  private async saveGameToWorkspace(html: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    try {
      const root = folders[0].uri;
      const target = vscode.Uri.joinPath(root, "index.html");
      await vscode.workspace.fs.writeFile(target, Buffer.from(html, "utf8"));
    } catch {
      // Non-fatal: preview still works even if the save fails.
    }
  }

  /**
   * #476 — agent-sdk → proxy 폴백을 **세 대상에게** 남긴다.
   *
   * 1. 개발자 — 전용 출력 채널. 이전의 `console.warn` 은 확장에
   *    `createOutputChannel` 이 한 군데도 없어 `exthost.log` 에도 안 남았고,
   *    사고 당일 전 세션에서 `[coach]` 문자열이 0건이었다. 사후 확인 자체가
   *    불가능했다. 사유 원문을 그대로 싣는다 — `SdkUnavailableError` 메시지가
   *    해석 후보 4개를 이미 나열한다.
   * 2. 참가자 — 대화 타임라인의 한 줄(세션 1회). 무엇이 안 되고 무엇이 되는지
   *    같이 말한다.
   * 3. 강사 — 별도 채널을 만들지 않았다. 학생 화면의 그 한 줄이 강사가 교실을
   *    돌며 볼 수 있는 실물이고, 대화 기록에 남으므로(REQ-C17) 사후에도 보인다.
   *    워커까지 신호를 보내 `/console` 에서 교실 단위로 보는 것은 별건으로 남긴다.
   *
   * 코치 자신에게 알리는 것은 **워커**가 한다 — `degradedRuntimeNoticeFor`
   * (translate.ts). 런타임의 ground truth 가 라우트이고 프롬프트 소유자가
   * 워커라서, 앱 릴리스 없이 배포만으로 반영된다.
   */
  private noteSdkFallback(reason: string, streamId: string): void {
    this.logChannel ??= vscode.window.createOutputChannel("HypeProof Coach");
    this.logChannel.appendLine(sdkFallbackLogLine(reason, new Date()));

    // 세션 1회. 폴백은 그 머신에서 계속 일어나므로(시드가 없으면 다음 턴도
    // 마찬가지) 매 턴 붙이면 두 번째부터 아무도 안 읽고 기록이 경고로 덮인다.
    if (this.fallbackNoticeShown) return;
    this.fallbackNoticeShown = true;
    this.postToolLog(streamId, {
      id: randomId(),
      icon: "⚠️",
      label: COACH_DEGRADED_NOTICE,
      state: "error",
    });
  }

  /**
   * #421 — 붙여넣은 이미지를 `<작업폴더>/assets/` 에 실제 파일로 저장한다.
   *
   * 승인 게이트와의 관계 (이슈가 확인을 요청한 항목): 이건 **모델이 요청한 쓰기가
   * 아니라 참가자가 방금 첨부한 자기 자료를 호스트가 보관하는 것**이다. 같은
   * 계열의 선례가 이미 둘 있다 — `saveGameToWorkspace`(index.html)와
   * `saveAgentMdIfPresent`(agent.md). 모달을 태우는 `resolveActionApproval` 은
   * **모델발 액션**(writeFile/executeShell)의 게이트이고, 그 정책의 핵심인
   * "워크스페이스 밖 절대경로 거절"은 여기서 구조적으로 성립한다: 경로가
   * `resolveCoachCwd()` + 고정 하위 폴더 + mime 에서 뽑은 확장자로만 조립되고,
   * 파일명은 참가자·모델 어느 쪽 문자열도 타지 않는다(#421 · REQ-C10~C13).
   *
   * 실패는 조용히 넘기지 않는다 — 저장이 안 됐는데 코치만 "있다"고 믿으면
   * 원래 증상으로 되돌아간다. 그때는 note 를 비우고(코치는 예전처럼 없는 것으로
   * 취급) 참가자에게 한 줄 남긴다.
   */
  private async savePastedImages(
    images: string[] | undefined,
    streamId: string,
  ): Promise<{ note: string; relPaths: string[] }> {
    const empty = { note: "", relPaths: [] as string[] };
    if (!images || images.length === 0) return empty;
    const cwd = this.resolveCoachCwd();
    if (!cwd) return empty;

    const dir = vscode.Uri.joinPath(vscode.Uri.file(cwd), PASTED_IMAGE_DIR);
    const at = new Date();
    const relPaths: string[] = [];
    let failed = 0;
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch {
      this.postToolLog(streamId, {
        id: randomId(),
        icon: "⚠️",
        label: pastedImageFailureLabel(images.length),
        state: "error",
      });
      return empty;
    }

    for (let i = 0; i < images.length; i++) {
      const parsed = parsePastedImage(images[i]);
      if (!parsed) {
        failed++;
        continue;
      }
      try {
        // 같은 초에 같은 순번이 이미 있으면 이름을 올려 가며 빈 자리를 찾는다.
        // 덮어쓰면 참가자가 앞서 붙인 사진이 소리 없이 사라진다.
        let name = pastedImageName(at, i + 1, parsed.ext);
        for (let dedupe = 1; dedupe <= 20; dedupe++) {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, name));
          } catch {
            break; // stat 실패 = 없음 = 이 이름을 쓴다
          }
          name = pastedImageName(at, i + 1, parsed.ext, dedupe);
        }
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(dir, name),
          Buffer.from(parsed.base64, "base64"),
        );
        relPaths.push(`${PASTED_IMAGE_DIR}/${name}`);
      } catch {
        failed++;
      }
    }

    if (failed > 0) {
      this.postToolLog(streamId, {
        id: randomId(),
        icon: "⚠️",
        label: pastedImageFailureLabel(failed),
        state: "error",
      });
    }
    if (relPaths.length === 0) return empty;
    this.postToolLog(streamId, {
      id: randomId(),
      icon: "🖼️",
      label: pastedImageSavedLabel(relPaths),
      state: "done",
    });
    return { note: pastedImageNote(relPaths, cwd), relPaths };
  }

  /** #278 Phase 1 — does this cohort's profile request the native live-server preview? */
  private isLiveServerPreview(): boolean {
    return this.cachedProfile?.preview?.type === "live_server";
  }

  /**
   * Reveal a freshly-built page. Always persists it to the workspace root
   * (index.html, GitHub-Pages-ready). Then either:
   *  - live_server cohorts (#278): serve the workspace root over
   *    http://127.0.0.1 and open/refresh the native integrated browser — real
   *    origin, so multi-file, same-origin fetch, storage, and page navigation
   *    all work; or
   *  - default: the sandboxed iframe PreviewProvider (existing behavior).
   * Public so extension.ts (runLastCode) shares the same routing.
   */
  async revealBuilt(html: string, opts?: { streamId?: string }): Promise<boolean> {
    // #359 — structural guard: auto-repair the known comment-close typo, and
    // refuse to reveal a still-broken document as if it succeeded. Returns
    // false when blocked so the streaming caller can let a corrected block retry.
    const checked = validateAndRepairHtml(html);
    if (checked.issues.length > 0) this.surfaceStructureIssues(checked, opts?.streamId);
    if (checked.blocked) return false;

    // 2026-08-17 Windows 실기기 — 코치가 "완성됐어요!" 라고 말한 **뒤에도** 화면이
    // 한참 비어 있었다. 스트림이 끝난 시점과 미리보기가 실제로 뜨는 시점 사이에
    // 라이브서버 기동 + 탭 열기가 들어가는데, 그 구간에 아무 표시가 없어서
    // 아이 눈에는 그냥 멈춘 것으로 보인다("완성된거 안보여").
    //
    // 그 공백을 타임라인 한 줄로 메운다. 실제로 뜨면 done, 실패하면 error 로
    // 바뀌므로 "떴다고 말했는데 안 뜬" 상태가 화면에 남지 않는다(R0).
    const revealLogId = randomId();
    const logReveal = (state: "running" | "done" | "error", label: string): void => {
      if (!opts?.streamId) return;
      this.postToolLog(opts.streamId, { id: revealLogId, icon: "🖼️", label, state });
    };

    logReveal("running", "미리보기 여는 중");
    await this.saveGameToWorkspace(checked.html);
    if (this.isLiveServerPreview() && (await this.openInLiveServer())) {
      logReveal("done", "미리보기를 열었어요");
      return true;
    }
    void this.preview.show(checked.html);
    logReveal("done", "미리보기를 열었어요");
    return true;
  }

  /**
   * #359 — surface a one-line structural note for a build. In-stream we reuse
   * the existing toolLog channel (a corrected/blocked build reads like any
   * other build step); off-stream (e.g. the ▶ Run button) we fall back to a
   * VS Code warning toast.
   */
  private surfaceStructureIssues(r: HtmlStructureResult, streamId?: string): void {
    const label = `생성물 점검: ${r.issues.join(" · ")}`;
    if (streamId) {
      this.postToolLog(streamId, {
        id: randomId(),
        icon: r.blocked ? "🚫" : "⚠️",
        label,
        state: r.blocked ? "error" : "done",
      });
    } else {
      void vscode.window.showWarningMessage(label);
    }
  }

  /**
   * Ensure the live server is up for the workspace root and open (or refresh)
   * the native browser at its URL. Returns false on any failure so the caller
   * falls back to the iframe preview.
   */
  private async openInLiveServer(): Promise<boolean> {
    return (await this.startLivePreview()) !== null;
  }

  /**
   * Ensure the live server is up for the workspace root and open (or refresh)
   * the native browser at its URL. Returns the server URL, or null on failure
   * (no workspace / server error) so callers can fall back or report.
   * Shared by the live_server preview path and the coach's
   * `live_preview_start` MCP tool (#282 P2 slice 2).
   */
  async startLivePreview(): Promise<string | null> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    try {
      const url = await this.liveServer.ensure(root);
      // Avoid stacking preview tabs on the right. The live server binds a fresh
      // random port on each (re)start (app relaunch, root change), so the URL
      // can differ from a previously-opened tab — an exact-URL match alone then
      // fails and every restart opens ANOTHER tab. So we match by "is this a
      // loopback preview tab" (port-independent): reuse the one already on the
      // current URL via SSE reload; otherwise close any STALE preview tabs
      // (dead port from a prior server start) and open exactly one fresh tab.
      const tabs = vscode.window.browserTabs ?? [];
      const isPreviewTab = (u?: string): boolean =>
        !!u && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(u);
      const current = tabs.find((t) => t.url?.startsWith(url));
      // #519 — 아래에서 프리뷰 탭을 코치의 운전 대상으로 고정한다. `?.` 로 두면
      // live_preview_start 가 첫 도구 호출일 때(인스턴스가 아직 없다) 고정이
      // 조용히 날아가고, 뒤이은 screenshot 이 다시 activeBrowserTab 에 의존한다.
      this.mcpBrowser ??= new BrowserControl();
      if (current) {
        this.liveServer.reload();
        // #519 — 코치가 이어서 screenshot/read 를 부를 때 이 탭이 대상이 되도록
        // 고정한다. 이 경로는 `preserveFocus: true` 로 열기 때문에 activeBrowserTab
        // 이 안 잡힐 수 있고, 그때 검사 도구가 "열린 탭이 없어요"로 실패했다.
        this.mcpBrowser.setTargetTab(current);
        // #525 — 참가자가 "미리보기 띄워줘"라고 한 흐름이다. 이미 떠 있는 탭이
        // 배경에 있으면 리로드만 하고 화면은 그대로여서 "아무 일도 안 일어난"
        // 것처럼 보인다. 앞으로 가져온다.
        await this.revealBrowserTab(current);
      } else {
        for (const t of tabs) {
          if (isPreviewTab(t.url)) {
            try {
              await t.close();
            } catch {
              /* best-effort — a tab we can't close shouldn't block the preview */
            }
          }
        }
        // Open in the FIRST editor column (not Beside): this cohort edits via the
        // coach, so the editor area is otherwise an empty welcome group. Beside
        // would open the preview next to that empty group, leaving a blank pane
        // between the chat sidebar and the preview. ViewColumn.One fills the main
        // editor area so the layout is just: chat sidebar | preview.
        const opened = await vscode.window.openBrowserTab(url, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: true,
        });
        this.mcpBrowser.setTargetTab(opened);
      }
      return url;
    } catch {
      return null;
    }
  }

  /**
   * #507 — 프록시 경로(#278)의 `browser_navigate` 를 실행 직전에 교정한다.
   *
   * 코치는 라이브 서버 주소를 모르면 `127.0.0.1:3000` 같은 흔한 포트를 반사적으로
   * 찍는다(코드 어디에도 3000 은 없다 — 모델의 추측이다). 라이브 서버는 매 실행
   * `listen(0)` 으로 임의 포트를 받으므로 그 주소는 항상 비어 있고,
   * `ERR_CONNECTION_REFUSED` 로 끝난다. Run 버튼은 URL 을 직접 받으므로 멀쩡했고,
   * 코치만 이 경로가 없어서 실패했다 (#470 재발).
   *
   * 서버가 안 떠 있으면 교정하지 않는다 — 짐작으로 고치지 않는다(모르면 그대로).
   */
  private retargetLoopbackNavigation(call: BrowserToolCall): {
    call: BrowserToolCall;
    note?: string;
  } {
    if (call.name !== "browser_navigate") return { call };
    const requested = String(call.input?.url ?? "");
    const target = resolveLivePreviewUrl(requested, this.liveServer.currentUrl());
    if (!target?.redirected) return { call };
    return {
      call: { ...call, input: { ...call.input, url: target.url } },
      note:
        `참고: ${target.requested} 은(는) 이 Studio 의 주소가 아니라 실제 라이브 서버 주소 ` +
        `${target.url} 로 이동했어요. 라이브 서버 포트는 실행할 때마다 달라지니 ` +
        `추측하지 말고 이 주소를 쓰세요.`,
    };
  }

  /**
   * #282 P2 slice 2 — host capabilities behind the "hypeproof" MCP browser
   * tools. Registered by runSdkCoach only when the profile grants
   * sdk_tools.browser (adults; minors are stripped). Silent by design: MCP
   * failures become isError tool results the coach can react to in-chat —
   * a toast here would pause the integrated browser (#308).
   */
  /**
   * 이미 열려 있는 브라우저 탭을 **참가자 화면 앞으로** 가져온다 (#525).
   *
   * proposed API 의 `BrowserTab` 에는 `show()`/`reveal()` 이 없고, `openBrowserTab`
   * 재호출은 새 탭을 만들어 #519 를 되돌린다. 그래서 **일반 에디터 경로**를 쓴다:
   * 그룹을 활성화한 뒤 `openEditorAtIndex` 로 그 탭을 앞세우고, 참가자가 편집기에
   * 있었으면 되돌린다(bounce).
   *
   * 2026-08-02 실측(설치된 0.1.16, 격리 프로파일)에서 확인한 것:
   *   - 배경에 있던 브라우저 탭이 실제로 앞으로 나온다
   *   - bounce 후 `activeTextEditor` 와 **선택 영역이 그대로 보존**된다
   *   - 그 컬럼은 계속 브라우저를 보여준다(되돌아가지 않는다)
   *
   * 규율 두 가지 — 둘 다 "확실하지 않으면 참가자 화면을 건드리지 않는다":
   *   ① 탭 식별은 `pickRevealTabIndex` 의 세 조건 교집합. 후보가 둘이면 아무것도
   *      안 한다(실측에서 라벨이 동점 나는 것을 봤다).
   *   ② `activeTextEditor` 가 없으면 bounce 를 생략한다 — 되돌릴 커서가 없으면
   *      IME 조합을 흔들 위험이 0 이다(코치가 도구를 쓸 때 참가자 포커스는 대개
   *      채팅 사이드바에 있다).
   *
   * 전부 best-effort 다. 실패해도 던지지 않는다 — 도구 결과를 오류로 바꾸면
   * "열렸는데 실패로 보이는" 더 나쁜 상태가 된다.
   */
  private async revealBrowserTab(tab: vscode.BrowserTab): Promise<void> {
    try {
      if (!tab.url) return;
      const column = coachTabSlot(tab.url) === "preview" ? 1 : 2;
      const group = (vscode.window.tabGroups?.all ?? []).find((g) => g.viewColumn === column);
      if (!group) return;
      const index = pickRevealTabIndex(
        group.tabs.map((t, i) => ({
          index: i,
          label: t.label,
          inputIsUndefined: t.input === undefined,
          isActive: t.isActive,
        })),
        tab.title,
      );
      if (index === null) return;

      // bounce 대상은 **명령을 쏘기 전에** 붙잡는다 — 쏜 뒤엔 이미 옮겨가 있다.
      const restore = vscode.window.activeTextEditor;
      const focusGroup = column === 1 ? FOCUS_FIRST_GROUP : FOCUS_SECOND_GROUP;
      await vscode.commands.executeCommand(focusGroup);
      await vscode.commands.executeCommand(OPEN_EDITOR_AT_INDEX, index);
      if (restore) {
        // 커서·선택까지 되돌린다. showTextDocument 는 컬럼을 명시할 수 있어
        // focus{N}EditorGroup 조합보다 정확하다(참가자가 3번 컬럼에 있을 수도 있다).
        await vscode.window.showTextDocument(restore.document, {
          viewColumn: restore.viewColumn,
          selection: restore.selection,
          preserveFocus: false,
        });
      }
    } catch {
      /* 앞으로 못 가져와도 도구 자체는 성공이다 — 조용히 넘어간다 */
    }
  }

  private buildBrowserMcpHost(): BrowserMcpHost {
    return {
      openBrowser: async (url: string) => {
        // #519 — **여는 게 아니라 이동한다.**
        //
        // `openBrowserTab` 은 부를 때마다 새 에디터를 만든다(mainThreadBrowsers 가
        // 매번 새 UUID 를 뽑는다) — 플랫폼에는 URL 재사용이 아예 없다. 전에는 그
        // 위에 "닫고 새로 열기"를 얹었는데, 루프백(참가자 결과물)은 정리 대상에서
        // 빠져 있어 하위 페이지를 돌 때마다 탭이 쌓였다. 이제 슬롯(결과물/참고)당
        // 탭 하나를 잡아 CDP 로 이동시킨다: 탭도 컬럼도 늘지 않고, 페이지
        // 히스토리(browser_back)가 살아 있고, 참가자가 보던 다른 슬롯은 그대로다.
        const tabs = vscode.window.browserTabs ?? [];
        const plan = planCoachBrowserTabs(tabs.map((t) => t.url), url);
        // 같은 슬롯에 이미 쌓여 있던 잉여 탭만 정리한다(레거시 누적분).
        for (const i of plan.close) {
          try {
            await tabs[i]?.close();
          } catch {
            /* 못 닫는 탭이 이동을 막아서는 안 된다 */
          }
        }
        this.mcpBrowser ??= new BrowserControl();
        if (plan.reuse !== null) {
          // #526 — 이동 **전에** 이 탭이 무엇을 보여주고 있었는지 붙잡아 둔다.
          // 이동 후에 읽으면 이미 새 주소라 "무엇이 밀려났는지"를 알 수 없다.
          const reused = tabs[plan.reuse];
          const replaced = reused?.url ? { url: reused.url, title: reused.title } : undefined;
          // 재사용 탭을 고정한 뒤 CDP navigate — 프록시 경로(#278)가 쓰는 실행기를
          // 그대로 태운다. 같은 동작을 두 벌 두면 한쪽만 고쳐진다(#457 과 같은 이유).
          this.mcpBrowser.setTargetTab(reused);
          const r = await this.mcpBrowser.execute({
            id: "mcp-browser_open",
            name: "browser_navigate",
            input: { url },
          });
          if (!r.isError) {
            // #525 — 이동은 됐는데 그 탭이 배경이면 참가자 화면은 그대로다.
            // 참가자가 "열어줘"라고 한 흐름이므로 앞으로 가져온다.
            if (reused) await this.revealBrowserTab(reused);
            return { replaced };
          }
          // 이동 실패(탭이 방금 닫혔다든지)는 새로 여는 쪽으로 폴백한다 —
          // 학생 눈에는 "안 열렸다"가 되어선 안 된다.
          this.mcpBrowser.setTargetTab(undefined);
        }
        // 슬롯이 비었으면 새로 연다. 컬럼을 **명시**하는 이유: `Beside`(SIDE_GROUP)는
        // 활성 그룹 오른쪽 이웃을 찾고 없으면 새 그룹을 만든다. 방금 연 브라우저
        // 탭이 활성(=맨 오른쪽)이면 다음 호출마다 컬럼이 갈라져 작업 공간이 좁아진다.
        // preserveFocus 는 그 활성화 자체를 막고, 포커스가 없어도 탭 핸들로 운전한다.
        const opened = await vscode.window.openBrowserTab(url, {
          viewColumn:
            coachTabSlot(url) === "preview" ? vscode.ViewColumn.One : vscode.ViewColumn.Two,
          preserveFocus: true,
        });
        this.mcpBrowser.setTargetTab(opened);
      },
      screenshot: async () => {
        // #519 — 폴백 경로도 운전 중인 탭을 먼저 본다(위 currentPage 와 같은 이유).
        const tab = this.mcpBrowser?.currentTab() ?? vscode.window.activeBrowserTab;
        if (!tab) return null;
        try {
          const ctx = await capturePageContext(tab);
          if (!ctx.imageBase64) {
            // 원인을 남긴다. `catch { return null }` 이 이유를 통째로 삼켜서
            // 실측(2026-07-26)에서 스크린샷이 왜 실패하는지 못 밝혔다.
            console.warn(`[coach] screenshot: empty image for ${tab.url ?? "(no url)"}`);
            return null;
          }
          return {
            imageBase64: ctx.imageBase64,
            mimeType: "image/jpeg",
            url: ctx.url,
            title: ctx.title,
          };
        } catch (e) {
          console.warn(`[coach] screenshot failed for ${tab.url ?? "(no url)"}: ${String(e)}`);
          return null;
        }
      },
      startLivePreview: () => this.startLivePreview(),
      // #507 — 지금 떠 있는 라이브 서버 주소. 시작시키지 않는다(조회에 부작용을
      // 두면 "주소가 뭐냐"가 서버를 켜게 된다). 이게 유일한 진실이고, 이걸 안
      // 읽는 쪽은 전부 추측이다 — 그 추측이 127.0.0.1:3000 이었다.
      livePreviewUrl: async () => this.liveServer.currentUrl() ?? null,
      // #415 — 지금 떠 있는 페이지를 가장 싸게 읽는 경로. BrowserTab 은 url/title 을
      // 그대로 들고 있어 CDP 접속도 스크린샷도 필요 없다 (URL 하나 알자고 이미지를
      // 뜨면 토큰도 시간도 낭비).
      //
      // #519 — 여기서 `activeBrowserTab` 만 보면 안 된다. 그 값은 활성 에디터가
      // 브라우저일 때만 세팅되므로, 참가자가 코드 탭을 클릭한 순간 "열린 페이지
      // 없음"이 되어 중복 방지가 조용히 꺼졌다(같은 페이지를 또 열고 승인 모달이
      // 또 뜬다). 코치가 운전 중인 탭을 먼저 보고, 없을 때만 활성 탭으로 폴백한다.
      currentPage: async () => {
        const tab = this.mcpBrowser?.currentTab() ?? vscode.window.activeBrowserTab;
        if (!tab?.url) return null;
        return { url: tab.url, title: tab.title };
      },
      // #519 — 중복 판정용. 슬롯이 둘이므로 "지금 보는 페이지" 하나로는 이미 떠
      // 있는 다른 슬롯을 놓치고 불필요한 승인 모달이 뜬다.
      openPages: async () =>
        (vscode.window.browserTabs ?? [])
          .filter((t) => !!t.url)
          .map((t) => ({ url: t.url, title: t.title })),
      // #523 — "이미 열려 있다"로 판정된 탭을 운전 대상으로 고정한다. openPages 가
      // URL 만 넘기므로(탭 핸들은 이 경계를 넘지 않는다) 여기서 다시 찾는다 —
      // 판정과 **같은 비교 함수**로 찾아야 판정된 탭과 고정된 탭이 갈라지지 않는다.
      //
      // #525 — 고정만으로는 참가자가 못 본다. 그 탭이 배경에 있으면 화면은 그대로다.
      // 앞으로 가져오는 것까지 한다(revealBrowserTab — 실패는 조용히 무시).
      focusOpenPage: async (url: string) => {
        const tab = (vscode.window.browserTabs ?? []).find(
          (t) => !!t.url && isSameBrowserUrl(t.url, url),
        );
        if (!tab?.url) return null;
        this.mcpBrowser ??= new BrowserControl();
        this.mcpBrowser.setTargetTab(tab);
        await this.revealBrowserTab(tab);
        return { url: tab.url, title: tab.title };
      },
      // #457 — 검사 3종(read/click/type)을 CDP 실행기에 그대로 위임한다.
      // 프록시 경로(#278)가 쓰던 BrowserControl 을 재사용한다 — 같은 동작을 두 벌
      // 구현하면 한쪽만 고쳐지는 버그가 생긴다. 인스턴스는 여기서 lazily 만들고
      // dispose 는 패널 정리 경로가 맡는다.
      inspect: async (name, input) => {
        try {
          this.mcpBrowser ??= new BrowserControl();
          const r = await this.mcpBrowser.execute({ id: `mcp-${name}`, name, input });
          // BrowserToolResult(content: text | image_url) → McpToolResult(text | image)
          return {
            content: r.content.map((b) =>
              b.type === "text"
                ? { type: "text" as const, text: b.text }
                : {
                    type: "image" as const,
                    data: b.image_url.url.replace(/^data:[^,]*,/, ""),
                    mimeType: "image/jpeg",
                  },
            ),
            ...(r.isError ? { isError: true } : {}),
          };
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: `브라우저 조작 실패: ${String(e)}` }],
            isError: true,
          };
        }
      },
    };
  }

  /**
   * #457 — 코치가 설 작업 폴더. 열린 폴더 → 프로필의 workspace_root 순.
   * 둘 다 없으면 undefined 를 돌려주되 **조용히 넘어가지 않는다**: 그 상태는
   * 코치가 파일을 못 찾는다는 뜻이고, 로그가 없으면 사후에 원인을 못 밝힌다.
   */
  private resolveCoachCwd(): string | undefined {
    const opened = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (opened) return opened;

    const root = this.cachedProfile?.workspace_root;
    const resolved = root ? resolveWorkspaceRoot(root) : null;
    if (resolved) {
      console.warn(
        `[coach] no folder open — falling back to profile workspace_root: ${resolved}`,
      );
      return resolved;
    }
    console.error(
      "[coach] cwd is UNKNOWN (no folder open, no usable profile workspace_root). " +
        "The coach will not receive a working directory and file tools will fail.",
    );
    return undefined;
  }

  /** Persist coach info chosen via the in-panel naming card. */
  private async saveCoachFromWebview(name: string, personality: string): Promise<void> {
    const profile = await this.ensureProfile();
    const fallback = profile?.ux.coach.fallback_name ?? "코치";
    const sanitized = sanitizeCoachInput(name, personality, fallback);
    const next: CoachInfo = { ...sanitized, configured: true };
    await this.context.globalState.update(this.coachKey(), next);
    await this.context.globalState.update(this.coachRitualDoneKey(), true);
    await this.postConfig();
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.postConfig();
        await this.postHistory();
        // #308 — flush the pending inline notice. The webview may have just
        // been created for the first time (attachPageContext ran before
        // panel.focus) or recreated after hide/show (no retainContextWhenHidden
        // for WebviewView → React state reset). Re-posting is idempotent: the
        // reducer replaces pageNotice rather than appending.
        if (this.pendingPageNotice) {
          void this.post({ type: "pageAttached", label: this.pendingPageNotice });
        }
        // #320 — AI disclosure at session start (REQ-C14). First "ready" of
        // a session shows the notice; hide/show remounts within the same
        // session return null here and stay silent. A history clear resets
        // the session (see clearHistory), so the next conversation start is
        // disclosed again.
        {
          const disclosure = this.aiDisclosure.noticeForReady();
          if (disclosure) void this.post({ type: "aiDisclosure", text: disclosure });
        }
        return;
      case "sendMessage":
        await this.handleSend(msg.text, msg.history, msg.images);
        return;
      case "retryMessage":
        // #358 — carry the failed turn's image(s) through the retry so the
        // coach actually re-receives the screenshot (was text-only → "스크린샷을
        // 아직 못 받았어요").
        await this.handleSend(msg.prompt, msg.history, msg.images);
        return;
      case "cancelStream":
        this.activeStreams.get(msg.streamId)?.abort();
        // #497 — abort() alone tells the webview NOTHING. handleSend and
        // handleSendError both skip their posts on an aborted signal, each
        // citing "the webview already ended the stream" — a premise no code
        // ever satisfied. The panel therefore stayed in the streaming state
        // forever: Stop and the spinner never cleared, and every later message
        // parked in the #416 queue whose flush only fires on the streaming →
        // idle edge. Say it explicitly here, where we know it was user-initiated.
        void this.post({ type: "streamStopped", streamId: msg.streamId });
        return;
      case "requestAction":
        await this.handleActionRequest(msg.action);
        return;
      case "openSettings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "hypeproofChat");
        return;
      case "setToken":
        void vscode.commands.executeCommand("hypeproof-chat.setToken");
        return;
      case "openReportModal":
        // #64. Webview's error banner has a 🚨 link; we delegate to the same
        // command so the QuickInput cascade lives in one place.
        void vscode.commands.executeCommand("hypeproof-chat.reportProblem");
        return;
      case "installUpdate":
        // #72. User clicked "Install Now" on the update banner.
        void vscode.commands.executeCommand("hypeproof-chat.installUpdate");
        return;
      case "dismissUpdate":
        // #72. User clicked "Later" — silence this version for 7 days.
        void vscode.commands.executeCommand("hypeproof-chat.dismissUpdate", msg.version);
        return;
      case "namingRitual":
        void this.runCoachNamingRitual({ force: true });
        return;
      case "saveCoach":
        await this.saveCoachFromWebview(msg.name, msg.personality);
        return;
      case "clearHistory":
        void this.clearHistory();
        return;
      case "runCode":
        void this.revealBuilt(msg.html);
        return;
      case "previewReady":
        return;
      case "openExternal":
        // #173 — citation chip click. Guard the URL: http(s) only, no
        // file://, javascript:, vscode:, etc. The webview should never
        // request anything else (citations come from the worker which only
        // emits web_search_result entries), but defend against a compromised
        // upstream that might inject a hostile scheme.
        if (typeof msg.url === "string" && /^https?:\/\//i.test(msg.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        return;
      case "webviewError":
        // S-04 (#48). Log to output channel so the trace survives a panel
        // reload; don't crash the host.
        console.error(
          `[hypeproof-chat] webview error: ${msg.message}\n` +
          `stack:\n${msg.stack}\n` +
          `componentStack:\n${msg.componentStack}`,
        );
        return;
      // Trace events are forwarded to the worker in a separate path; they
      // never reach this switch in the current build (#9d, follow-up). Keep
      // the cases listed so adding the forwarder doesn't break the exhaustive
      // check below.
      case "traceTrialStart":
      case "traceTrialEnd":
      case "traceValidationRun":
      case "traceHumanAction":
        return;
    }
  }

  private async handleSend(
    text: string,
    rawHistory: ChatMessage[],
    images?: string[],
  ): Promise<void> {
    // #503 — 웹뷰의 히스토리에는 이제 툴 줄(role:"tool")이 섞여 있다. 모델로
    // 나가는 경로는 여기 하나뿐이므로 초입에서 한 번 거른다. 아래쪽 프록시·SDK
    // 게이트웨이 호출은 user/assistant 만 아는 계약이다.
    const history = modelHistory(rawHistory);
    // "Show me / open it / run it" — if the kid asks to see the game in plain
    // language and a game already exists, just open it. Don't make them hunt
    // for the ▶ Run button or burn an AI round-trip on a deflection. Skipped
    // when an image is attached — a pasted screenshot is always a real turn.
    if (isShowIntent(text) && (!images || images.length === 0)) {
      const lastGame = this.extractLastRenderableCode();
      if (lastGame) {
        const labels = labelsForProfile(this.cachedProfile);
        const reply = labels.showIntentReply;
        const uid = randomId();
        const aid = randomId();
        void this.post({ type: "streamStart", streamId: uid, messageId: aid });
        void this.post({ type: "streamChunk", streamId: uid, delta: reply });
        void this.post({ type: "streamEnd", streamId: uid });
        await this.appendHistory([
          { id: randomId(), role: "user", content: text, createdAt: Date.now() },
          { id: aid, role: "assistant", content: reply, createdAt: Date.now() },
        ]);
        void this.revealBuilt(lastGame);
        return;
      }
      // No game yet → fall through to the AI, which will guide them to make one.
    }

    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    const proxyUrl = cfg.get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
    const model = cfg.get<string>("model", "hypeproof-default");
    const token = await this.context.secrets.get(TOKEN_KEY);
    const coach = this.getCoach();
    // Fixed-naming cohorts must NOT inject a user-supplied coach name carried
    // over from a different cohort's user-data-dir into the LLM context (#140).
    const profile = await this.ensureProfile();
    const { name: effectiveCoachName, personality: effectiveCoachPersonality } =
      resolveCoach(coach, profile);

    // #278 — consume any queued browser-page context for THIS turn only. The
    // user message stored in history keeps their clean text; only the model
    // sees the prepended page context.
    const pageContext = this.pendingPageContext;
    this.pendingPageContext = null;
    // #308 — the notice describes the queued context; once consumed, stop
    // resurrecting it on webview remounts (webview clears its copy on userSent).
    this.pendingPageNotice = null;
    let userTextForModel = pageContext ? `${pageContext}\n\n${text}` : text;
    // #278 Phase 2 — fold any queued page screenshot into this turn's images.
    const pageImage = this.pendingPageImage;
    this.pendingPageImage = null;
    const effectiveImages = pageImage ? [...(images ?? []), pageImage] : images;

    const streamId = randomId();
    const messageId = randomId();
    const ctrl = new AbortController();
    this.activeStreams.set(streamId, ctrl);

    void this.post({ type: "streamStart", streamId, messageId });
    // #503 — 이 턴의 단일 타임라인. 웹뷰와 같은 리듀서를 돌려 화면 순서 그대로
    // 히스토리에 남긴다.
    this.turnTimelines.set(streamId, timelineStart(emptyTimeline(), messageId, Date.now()));

    // #421 — 붙여넣은 이미지를 작업 폴더에 파일로 남기고, 그 경로를 이 턴의
    // 모델 입력에 얹는다. 저장하지 않으면 코치가 `<img src>` 로 걸 대상이 없어
    // "파일로 저장해 주시겠어요?" 라고 참가자에게 일을 떠넘긴다(2026-07-24 실강의).
    //
    // `images` 만 저장한다 — `pageImage`(#278 "이 페이지를 코치에게") 는 참가자가
    // 간직하겠다고 붙인 자료가 아니라 브라우저 캡처라, 저장하면 작업 폴더가
    // 참가자가 요청한 적 없는 파일로 찬다.
    const savedImages = await this.savePastedImages(images, streamId);
    if (savedImages.note) userTextForModel = `${userTextForModel}\n\n${savedImages.note}`;

    let assistantText = "";
    // REQ-D2: auto-reveal as soon as a renderable HTML block completes in
    // the stream, NOT waiting for streamEnd. The block closes (```) often
    // arrives many seconds before the assistant's trailing prose. Showing
    // the game in that window is the strongest Taste "감탄" moment.
    let revealed = false;
    // #364 (Jay review) — the LAST html we attempted to reveal. On a blocked
    // reveal we reset `revealed` so a corrected block can retry, but without
    // this every subsequent delta re-extracts the SAME still-broken html and
    // re-surfaces a fresh toolLog warning (new randomId each chunk → warning
    // spam, no UI dedup). Retry ONLY when the extracted html actually changed.
    let lastAttemptedHtml = "";
    const tryReveal = (text: string) => {
      if (revealed) return;
      const html = extractRenderableHtml(text);
      if (!html) return;
      if (html === lastAttemptedHtml) return; // unchanged → don't re-warn
      lastAttemptedHtml = html;
      revealed = true; // optimistic — stop later chunks from re-revealing
      void this.revealBuilt(html, { streamId }).then((ok) => {
        // #359 — a blocked (still-broken after repair) build didn't ship;
        // let a later, CORRECTED (different) HTML block in the same stream try.
        if (!ok) revealed = false;
      });
    };
    // #173 — accumulate citations across the stream so they persist to history.
    const assistantCitations: import("./protocol").Citation[] = [];
    try {
      // #282 Phase 1 — route to the Agent SDK coach behind the flag. Default
      // "proxy" keeps the exact existing single-turn behavior; "agent-sdk"
      // runs runSdkCoach with the SAME callbacks so nothing downstream changes.
      // #371 — the cohort profile can request "agent-sdk" (worker already
      // force-pinned minors to "proxy"), OR the machine-scoped setting can
      // select it. Either opts in; the SDK path still gates every tool via
      // canUseTool and strips minor tools. Belt-and-suspenders: never honor a
      // profile agent-sdk request for a minor_cohort, even if the worker
      // somehow sent one.
      // 판단은 resolveCoachRuntime (chatPanelHelpers) 가 소유한다 — 미성년 검사가
      // 설정 경로에만 빠져 있던 비대칭을 고치면서 순수 함수로 뺐다. 대조군 포함
      // 단위 테스트: test/coach-runtime.smoke.mjs
      const settingRuntime = cfg.get<"proxy" | "agent-sdk">("coachRuntime", "proxy");
      const runtime: "proxy" | "agent-sdk" = resolveCoachRuntime({
        settingRuntime,
        profileRuntime: profile?.coach_runtime,
        minorCohort: profile?.minor_cohort,
      });
      const onDelta = (delta: string) => {
        assistantText += delta;
        const t = this.turnTimelines.get(streamId);
        if (t) this.turnTimelines.set(streamId, timelineDelta(t, delta, Date.now()));
        void this.post({ type: "streamChunk", streamId, delta });
        // Cheap check; extractRenderableHtml regex returns null fast on
        // most chunks (no fence/doctype present yet).
        tryReveal(assistantText);
      };
      const onCitations = (cites: import("./protocol").Citation[]) => {
        for (const c of cites) assistantCitations.push(c);
        void this.post({ type: "streamCitations", streamId, citations: cites });
      };
      const onAssetScore = (assetScore: import("./protocol").AssetScoreChunk) => {
        this.assetScores?.recordAssetScore(assetScore);
        void this.post({ type: "streamAssetScore", streamId, assetScore });
      };
      // #414 — the SDK coach's real work, rendered through the same toolLog
      // lines the browser loop already uses. Deliberately NOT translated: the
      // model thinks in English and the tool names are the SDK's own, and a
      // Korean paraphrase of "Write(index.html)" would be a worse signal than
      // the thing itself. Shape follows Claude Code — one truncated line per
      // action (the CSS ellipsizes), plus a live token counter while thinking.
      let thinkingIndex = 0;
      // The webview replaces an entry wholesale by id, so a tool_result has to
      // re-send the label the tool_use showed — keep it per stream.
      const toolLabels = new Map<string, string>();
      const onActivity = (a: import("./sdkCoachHelpers").SdkActivity) => {
        const log = (id: string, icon: string, label: string, state: "running" | "done" | "error") =>
          // #503 — a.at: SDK 가 실어 보낸 자기 시각. 영속화된 줄의 createdAt 이 된다.
          this.postToolLog(streamId, { id, icon, label, state, ...(a.at ? { at: a.at } : {}) });
        switch (a.kind) {
          case "thinking_tokens":
            // One entry that ticks in place; the completed block replaces it.
            log(`think-${thinkingIndex}`, "💭", `Thinking… ${a.tokens} tokens`, "running");
            break;
          case "thinking":
            log(`think-${thinkingIndex}`, "💭", a.text, "done");
            thinkingIndex += 1;
            break;
          case "tool_use": {
            // 워크스페이스 루트를 넘겨 경로를 루트 기준으로 보여 준다. 파일명만
            // 남기면 "정상 · 상대경로 거부 · 워크스페이스 밖"이 같은 글자가 된다.
            const label = `${a.name}(${summarizeToolInput(a.name, a.input, 60, this.resolveCoachCwd())})`;
            toolLabels.set(a.id, label);
            log(a.id, "🔧", label, "running");
            break;
          }
          case "tool_result":
            // 실패는 라벨에 표시를 남긴다 — 아이콘만으로는 스크롤 지나가면
            // 사라진다. 실사용에서 Write 실패를 놓치고 "저장됐습니다"를 그대로
            // 믿었다(2026-07-26).
            log(
              a.id,
              "🔧",
              a.isError
                ? `${toolLabels.get(a.id) ?? ""} — 실패${a.reason ? `: ${a.reason}` : ""}`
                : (toolLabels.get(a.id) ?? ""),
              a.isError ? "error" : "done",
            );
            break;
        }
      };
      // The non-SDK runtime: the agentic browser loop when the cohort opted
      // into browser_control (copyclone opens the reference URL / re-checks the
      // live preview), else the plain single-turn proxy. #371 — the SDK path's
      // SdkUnavailableError fallback MUST route here too; falling back to a bare
      // runProxy() drops the browser loop, so the coach only *narrates* "브라우저
      // 열게요" and never opens it (regression from the #380 SDK-runtime flip).
      const runProxyRuntime = async () => {
        if (this.cachedProfile?.browser_control?.enabled) {
          await this.runBrowserLoop({
            proxyUrl,
            model,
            token,
            history,
            userText: userTextForModel,
            images: effectiveImages,
            signal: ctrl.signal,
            streamId,
            coachName: effectiveCoachName,
            coachPersonality: effectiveCoachPersonality,
            onDelta,
            onCitations,
          });
        } else {
          await runProxy();
        }
      };
      const runProxy = () =>
        proxyChat({
          proxyUrl,
          model,
          token,
          history,
          userText: userTextForModel,
          images: effectiveImages,
          signal: ctrl.signal,
          coachName: effectiveCoachName,
          coachPersonality: effectiveCoachPersonality,
          // #507 — 떠 있는 라이브 서버 주소를 매 턴 실어 보낸다. 없으면 생략:
          // 워커가 "아직 안 떠 있다 + 포트를 추측하지 마라"를 대신 말한다.
          previewUrl: this.liveServer.currentUrl(),
          onDelta,
          onCitations,
          onAssetScore,
        });
      if (runtime === "agent-sdk") {
        if (!profile) {
          throw new Error("코치 프로필을 아직 못 받았어요. 잠시 후 다시 시도해주세요.");
        }
        if (!token) {
          throw new ProxyAuthError("missing", TOKEN_MISSING_FRIENDLY);
        }
        try {
          await runSdkCoach({
            gatewayUrl: proxyUrl,
            token,
            model,
            profile,
            // The worker gateway (POST /v1/messages, #316) DROPS the client
            // `system` field and injects the cohort profile blocks server-side
            // (REQ-M10) — the tuned Korean prompt + classroom key never leave
            // the worker, so there is nothing to send from here.
            systemPrompt: "",
            history: history.map((m) => ({ role: m.role, content: m.content })),
            userText: userTextForModel,
            signal: ctrl.signal,
            // #457 — 폴더가 안 열려 있으면 workspaceFolders 가 비고, cwd 가
            // undefined 로 넘어간다. 그러면 withWorkspaceContext 가 프롬프트를
            // **그대로** 돌려주므로(경로 주입 없음) 코치는 자기 위치를 모르는
            // 채로 상대 경로를 쓰다 전부 실패한다. 2026-07-26 실사용에서 Read 5회가
            // 연속 실패했고, 코치가 `find ~` 로 홈 전체를 뒤지느라 20턴 중 13턴을
            // 태우고 maxTurns 로 세션이 죽었다.
            //
            // 프로필이 workspace_root 를 이미 알고 있으므로 그걸로 폴백한다.
            // 두 소스가 모두 없을 때만 undefined 로 두고, 그 경우는 소리 나게 남긴다.
            cwd: this.resolveCoachCwd(),
            // #507 — 떠 있는 라이브 서버 주소(없으면 생략). MCP 도구 결과로도
            // 알려주지만, 턴 시작 시점의 컨텍스트에 있어야 첫 이동부터 맞는다.
            previewUrl: this.liveServer.currentUrl(),
            // #282 W4a — explicit claude-binary override (highest priority in
            // the REQ-M24 resolution order: setting > HPS_SDK_BINARY env >
            // seeded > node_modules). Empty string = unset.
            binaryPathSetting: cfg.get<string>("sdkBinaryPath", "") || undefined,
            // #403 — no-progress budget before the turn is aborted with a
            // visible retry message instead of an endless "생각하는 중…".
            stallTimeoutMs: cfg.get<number>("sdkStallTimeoutMs"),
            onDelta,
            onActivity,
            onCitations,
            onAssetScore,
            // Map the SDK tool call → an accurate host ActionRequest so the
            // executeShell hard-deny and writeFile workspace-scope actually fire.
            requestApproval: (action) =>
              this.resolveActionApproval({ requestId: randomId(), ...sdkToolToActionRequest(action) }),
            // #282 P2 slice 2 — native-browser capabilities for the hypeproof
            // MCP tools. Always passed; runSdkCoach registers the server only
            // when the profile grants sdk_tools.browser (minors never do).
            browserHost: this.buildBrowserMcpHost(),
          });
        } catch (err) {
          if (!(err instanceof SdkUnavailableError)) throw err;
          // Pre-Phase-1: the SDK package isn't installed. Keep the classroom
          // working — fall back to the proxy runtime for this turn instead of
          // showing the student a technical error.
          //
          // #476 — 폴백 자체는 유지하되(동작 변경 없음) **보이게** 한다. 이전에는
          // `console.warn` 한 줄이 전부였고, 확장에 출력 채널이 없어 그 줄은
          // 어디에도 남지 않았다: 학생도 강사도 개발자도 코치 자신도 능력이
          // 사라진 걸 몰랐고, 그 오진이 이슈 3건(#470·#471·#472)을 만들었다.
          assistantText = "";
          assistantCitations.length = 0;
          revealed = false;
          // #503 — 텍스트를 버리면 타임라인도 같이 버린다. 안 그러면 폴백 전에
          // 찍힌 툴 줄만 히스토리에 남아 "말은 없고 행동만 있는" 턴이 된다.
          this.turnTimelines.set(streamId, timelineStart(emptyTimeline(), messageId, Date.now()));
          // #476 — 안내는 이 리셋 **뒤에** 넣는다. 앞에 넣으면 방금 찍은 줄이
          // 같이 지워져 웹뷰에만 남고 히스토리에는 안 남는다(창을 다시 열면 사라짐).
          this.noteSdkFallback(err.message, streamId);
          // #371 — fall back to the browser-loop-aware runtime, NOT bare proxy,
          // so a browser_control cohort (copyclone) still opens the browser when
          // the SDK binary isn't seeded.
          await runProxyRuntime();
        }
      } else {
        // #278 Phase 3 — browser loop for opted-in cohorts, else plain proxy.
        await runProxyRuntime();
      }
      // On user-initiated stop the cancelStream handler already ended the stream
      // in the webview; don't post streamEnd or commit the truncated turn
      // (parity with the proxy path, which throws on abort).
      if (!ctrl.signal.aborted) {
        void this.post({ type: "streamEnd", streamId });
        // #371 — persist the agent.md handoff fence, if the coach emitted one.
        // #503 — 히스토리를 굳히기 **전에** 기다린다. 이게 남기는 toolLog 줄도
        // 이 턴의 타임라인에 들어가야 창을 다시 열었을 때 같이 보인다.
        await this.saveAgentMdIfPresent(assistantText, streamId);
        await this.appendHistory([
          { id: randomId(), role: "user", content: text, createdAt: Date.now() },
          ...this.finishTurnItems(streamId, messageId, assistantText, assistantCitations),
        ]);
        // Fallback reveal in case the stream completed but the per-chunk
        // probe missed it (e.g. the closing ``` was in the very last delta).
        tryReveal(assistantText);
      }
    } catch (err) {
      await this.handleSendError(err, streamId);
    } finally {
      this.activeStreams.delete(streamId);
      this.turnTimelines.delete(streamId);
    }
  }

  /**
   * #503 — 턴을 닫고 영속화할 아이템들을 낸다. 말풍선과 툴 줄이 **일어난 순서
   * 그대로** 섞여 있는 배열이다. 인용은 마지막 어시스턴트 말풍선에 붙인다(툴이
   * 말풍선을 여러 개로 쪼갤 수 있으므로 "그 턴의 어시스턴트 메시지 하나"라는
   * 가정을 더는 쓸 수 없다).
   *
   * 타임라인이 없으면(호출 순서가 어긋난 경우) 기존과 똑같이 어시스턴트 한
   * 덩어리로 폴백한다 — 히스토리가 비는 것보다 낫다.
   */
  private finishTurnItems(
    streamId: string,
    messageId: string,
    assistantText: string,
    citations: import("./protocol").Citation[],
  ): ChatMessage[] {
    const t = this.turnTimelines.get(streamId);
    const fallback: ChatMessage[] = [
      {
        id: messageId,
        role: "assistant",
        content: assistantText,
        createdAt: Date.now(),
        ...(citations.length > 0 ? { citations } : {}),
      },
    ];
    if (!t) return fallback;
    const items = timelineEnd(t, Date.now()).items;
    if (items.length === 0) return assistantText ? fallback : [];
    if (citations.length === 0) return items;
    let lastAssistant = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].role === "assistant") {
        lastAssistant = i;
        break;
      }
    }
    if (lastAssistant < 0) return items;
    return items.map((m, i) =>
      i === lastAssistant ? { ...m, citations: [...(m.citations ?? []), ...citations] } : m,
    );
  }

  /**
   * #278 Phase 3 — client-driven agentic browser loop. Streams a turn; if the
   * coach emitted tool_use blocks, runs each via the CDP executor, posts an
   * action-log line (auto-run + log, no modal), appends the tool_use +
   * tool_result as EPHEMERAL scratch turns, and re-invokes — until the coach
   * stops calling tools (or the per-cohort iteration cap). Text streams through
   * `onDelta` (accumulated into the caller's assistant message + history);
   * scratch turns never touch persisted history. Asset score is recorded from
   * the terminal (non-tool) turn only.
   */
  private async runBrowserLoop(p: {
    proxyUrl: string;
    model: string;
    token: string | undefined;
    history: ChatMessage[];
    userText: string;
    images?: string[];
    signal: AbortSignal;
    streamId: string;
    coachName: string;
    coachPersonality: string;
    onDelta: (delta: string) => void;
    onCitations: (cites: import("./protocol").Citation[]) => void;
  }): Promise<void> {
    const browser = new BrowserControl();
    const maxIter = this.cachedProfile?.browser_control?.max_iterations ?? 8;
    const scratch: Array<{ role: "user" | "assistant"; content: unknown }> = [];
    let lastAssetScore: import("./protocol").AssetScoreChunk | null = null;
    try {
      for (let iter = 0; ; iter++) {
        if (p.signal.aborted) return;
        const result = await proxyChat({
          proxyUrl: p.proxyUrl,
          model: p.model,
          token: p.token,
          history: p.history,
          userText: p.userText,
          images: p.images,
          toolTurns: scratch,
          signal: p.signal,
          coachName: p.coachName,
          coachPersonality: p.coachPersonality,
          // #507 — 루프 안에서 매 턴 다시 읽는다: live_preview_start 로 방금 뜬
          // 서버 주소가 다음 턴 컨텍스트에 들어가야 추측할 이유가 사라진다.
          previewUrl: this.liveServer.currentUrl(),
          onDelta: p.onDelta,
          onCitations: p.onCitations,
          onAssetScore: (s) => {
            lastAssetScore = s; // buffer; only the terminal turn is recorded
          },
        });
        if (result.toolUses.length === 0) break; // terminal turn → done
        if (iter >= maxIter) {
          p.onDelta("\n\n_(브라우저 작업을 여기서 멈췄어요.)_");
          break;
        }
        // #371 — save+reveal THIS iteration's HTML BEFORE running its browser
        // tools, so a re-check (browser_navigate to the live preview) reads the
        // freshly-saved page, not a stale one. Without this the autonomous
        // rubric loop re-reads iteration-0's HTML every round and can't
        // converge on later fixes. tryReveal's once-per-stream latch does not
        // fire here (browser loop path), so reveal explicitly per iteration.
        if (result.text) {
          const iterHtml = extractRenderableHtml(result.text);
          if (iterHtml) await this.revealBuilt(iterHtml);
        }
        // Assistant tool_use turn (its text + tool_use blocks) — scratch only.
        const asstContent: unknown[] = [];
        if (result.text) asstContent.push({ type: "text", text: result.text });
        for (const b of result.toolUses) {
          asstContent.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        }
        scratch.push({ role: "assistant", content: asstContent });
        // Run each tool → action log + tool_result (executor never throws).
        const toolResults: unknown[] = [];
        for (const call of result.toolUses) {
          if (p.signal.aborted) return;
          // #507 — 추측된 루프백 포트를 실제 라이브 서버로 교정한 뒤 실행한다.
          // **로그를 만들기 전에** 고친다: 화면 줄이 요청한 주소를 보여주면
          // 참가자는 실제로 열린 곳과 다른 주소를 읽게 된다.
          const fixed = this.retargetLoopbackNavigation(call);
          const line = browserToolLogLine(fixed.call.name, fixed.call.input);
          this.postToolLog(p.streamId, { id: call.id, ...line, state: "running" });
          const tr = await browser.execute(fixed.call);
          this.postToolLog(p.streamId, { id: call.id, ...line, state: tr.isError ? "error" : "done" });
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            // 교정했으면 모델에게도 말한다 — 조용히 고치면 다음 턴에 또 추측한다.
            content: fixed.note
              ? [...tr.content, { type: "text" as const, text: fixed.note }]
              : tr.content,
            ...(tr.isError ? { is_error: true } : {}),
          });
        }
        scratch.push({ role: "user", content: toolResults });
      }
      if (lastAssetScore) {
        this.assetScores?.recordAssetScore(lastAssetScore);
        void this.post({ type: "streamAssetScore", streamId: p.streamId, assetScore: lastAssetScore });
      }
    } finally {
      await browser.dispose();
    }
  }

  /**
   * Turn raw errors into kid-friendly messages and recovery actions. The kid
   * must never see raw JSON. Expired/missing token → auto-reopen the token
   * input box (teacher pastes a fresh one). Session/roster → friendly nudge
   * to call the teacher.
   */
  private async handleSendError(err: unknown, streamId: string): Promise<void> {
    // User-initiated stop (cancelStream) surfaces as an AbortError on both the
    // proxy and agent-sdk paths — it's not an error, and the webview already
    // ended the stream. Don't show a banner.
    if (isAbortError(err)) return;
    if (err instanceof ProxyAuthError) {
      if (err.requestId) this.lastRequestId = err.requestId;
      void this.post({
        type: "streamError",
        streamId,
        error: err.friendly,
        requestId: err.requestId,
        runbookUrl: err.runbookUrl,
      });
      // #381 — "wrong_role" (instructor token) also needs a different token,
      // so reopen the box. It is NOT deleted: only "expired" is provably dead.
      if (err.kind === "expired" || err.kind === "missing" || err.kind === "wrong_role") {
        // Clear the dead token so the UI shows "Token" not "Token ✓",
        // then reopen the input box for a fresh one.
        if (err.kind === "expired") {
          await this.context.secrets.delete(TOKEN_KEY);
          this.invalidateProfile();
          await this.postConfig();
        }
        await new Promise((r) => setTimeout(r, 600));
        await vscode.commands.executeCommand("hypeproof-chat.setToken");
      }
      return;
    }
    const reason = err instanceof Error ? err.message : "앗, 문제가 생겼어요. 선생님을 불러주세요.";
    const requestId = err instanceof ProxyTransportError ? err.requestId : undefined;
    if (requestId) this.lastRequestId = requestId;
    void this.post({ type: "streamError", streamId, error: reason, requestId });
  }

  private async handleActionRequest(req: ActionRequest): Promise<void> {
    const approved = await this.resolveActionApproval(req);
    void this.post({ type: "actionResult", requestId: req.requestId, approved });
  }

  /**
   * Resolve a manual-approve request from streamed assistant code.
   *
   * Policy tiers (#115 / epic #108):
   *   1. Hard-deny: `executeShell` is refused outright — no modal, info toast.
   *      Defense-in-depth on top of the worker's "셸 실행 금지" prompt rule.
   *   2. Path-scope: `writeFile` with an absolute path outside the active
   *      workspace is refused outright — warning toast, no modal.
   *   3. Modal-gated: anything else listed in `requireApprovalFor` triggers
   *      a Warning modal; Approve/Deny → boolean.
   *   4. Allow-by-default: not in the required set → return true.
   *
   * Public so e2e tests can synthesize requests without spinning through the
   * streamed-assistant path.
   */
  async resolveActionApproval(req: ActionRequest): Promise<boolean> {
    // Tier 1 — shell (epic #431). No longer a hard deny: a cohort that set
    // `sdk_tools.shell` gets arbitrary commands, and THIS modal is the gate.
    // Three shapes, in order of how much they interrupt:
    //   destructive → strong confirm every time, never remembered;
    //   remembered  → silent (the participant already said "항상 허용");
    //   otherwise   → normal confirm + the option to remember.
    if (req.kind === "executeShell") {
      const command = (req.payload as { command?: string } | null | undefined)?.command ?? "";
      const destructive = req.destructive === true;
      const signature = destructive ? null : commandSignature(command);

      if (signature && this.approvedCommandSignatures.has(signature)) {
        return true;
      }

      const pretty = describeCommandForApproval(command);
      if (destructive) {
        // Deliberately NOT offering "항상 허용". Approving `rm -rf` once must
        // never approve it for the rest of the session, and the whole point of
        // the strong confirm is that it stays interruptive.
        const pick = await vscode.window.showWarningMessage(
          `⚠️ 되돌리기 어려운 명령이에요. 정말 실행할까요?\n\n${pretty}`,
          { modal: true },
          "실행",
          "취소",
        );
        return pick === "실행";
      }

      const REMEMBER = signature ? `항상 허용 (${signature})` : null;
      const buttons = REMEMBER ? ["실행", REMEMBER] : ["실행"];
      const pick = await vscode.window.showWarningMessage(
        `코치가 명령을 실행하려고 해요:\n\n${pretty}`,
        { modal: true },
        ...buttons,
      );
      if (pick === REMEMBER && signature) {
        // Session-scoped only — never persisted. A new window starts the
        // participant's judgment over, which is the intended lesson; what we
        // are killing is the fifteen identical modals inside ONE 20:35 block
        // that train them to stop reading.
        this.approvedCommandSignatures.add(signature);
        return true;
      }
      return pick === "실행";
    }

    // Tier 1.5 — 브라우저 열기. 오리진 단위로 한 번만 묻는다.
    //
    // 실측(2026-07-26 실사용): 코치가 정답지 사이트의 서브페이지를 차례로 읽는
    // 동안 About·첨단디지털·평생예방·시니어… 페이지마다 모달이 떴다. 판단은
    // "이 사이트를 코치가 둘러봐도 되는가" 한 번이면 끝나는데, 같은 답을 다섯 번
    // 요구하면 읽지 않고 누르는 습관만 남는다 — 승인 게이트가 훈련시키려던 것과
    // 정반대다. 셸의 `항상 허용`(위)과 같은 장치이고, 마찬가지로 세션 한정이다.
    if (req.kind === "openBrowser") {
      const url = (req.payload as { url?: string } | null | undefined)?.url ?? "";
      const origin = originOfUrl(url);
      if (origin && this.approvedBrowserOrigins.has(origin)) {
        return true;
      }
      const REMEMBER = origin ? `이 사이트는 항상 허용 (${origin})` : null;
      const buttons = REMEMBER ? ["열기", REMEMBER] : ["열기"];
      const pick = await vscode.window.showWarningMessage(
        `코치가 브라우저를 열려고 해요:\n\n${url || req.description}`,
        { modal: true },
        ...buttons,
      );
      if (pick === REMEMBER && origin) {
        this.approvedBrowserOrigins.add(origin);
        return true;
      }
      return pick === "열기";
    }

    // Tier 2 — file access must target the active workspace (write and read).
    if (req.kind === "writeFile" || req.kind === "readFile") {
      const target = (req.payload as { path?: string } | null | undefined)?.path;
      if (typeof target === "string" && target.length > 0 && !isInsideWorkspace(target)) {
        vscode.window.showWarningMessage(
          `작업 폴더 밖 경로는 쓸 수 없어요: ${target}`,
        );
        return false;
      }
    }

    // Tier 3 — modal-gated.
    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    //
    // writeFile 은 여기서 **빠졌다** (원장 결정 2026-07-27, 이전 결정 번복).
    //
    // 이 모달이 뜰 때는 이미 안전 검사가 끝나 있다: 워크스페이스 밖 경로는
    // evaluateSdkToolUse 의 containment 가 모달 없이 거부한다. 그래서 남은 기능은
    // 안전이 아니라 위임 판단 교육뿐이었는데, 실측에서 그 교육이 성립하지 않았다.
    //
    //   07-27 턴 2: 파일 저장 모달 하나가 **174초** 방치됐다. 원장이 화면 앞에
    //   없었고, 코치는 그동안 아무것도 못 하고 멈춰 있었다. 그 전날엔 42.2초짜리가
    //   한 턴 승인 대기의 77% 였다. 한 턴에 8번 뜨던 날도 있었고 그때는 3~4초 만에
    //   눌렸다 — 읽지 않고 누르는 리듬이다.
    //
    // 즉 이 모달은 둘 중 하나가 된다: 놓쳐서 세션을 멈추거나, 반사로 눌러 교육
    // 효과가 없거나. 위임 판단은 셸·브라우저·서브에이전트에서 가르친다 — 그쪽은
    // 진짜로 되돌리기 어렵거나 바깥으로 나가는 행위다.
    //
    // 되돌리려면 설정 한 줄이다: hypeproofChat.requireApprovalFor 에 "writeFile" 추가.
    // browserClick 은 목록에 **없다** → 자동 허용.
    //
    // 페이지를 여는 결정(openBrowser)에서 이미 위임 판단을 한 뒤다. 그 페이지 안에서
    // 누르는 것은 새로운 바깥 행위가 아니라 검증이고, 같은 페이지의 browser_read 는
    // 이미 자동 허용이다. 실측(07-27): 코치가 "고치고 직접 눌러 확인"하는 루프마다
    // 모달이 떴고, 그것도 매핑 누락 탓에 **셸 문구에 빈 내용**으로 떴다.
    // browserType 은 남긴다 — 값을 넣고 제출까지 갈 수 있어 성격이 다르다.
    //
    // 정책의 단일 소스는 package.json 의 `requireApprovalFor.default` 다.
    // 매니페스트에 default 가 선언돼 있으면 **항상 매니페스트가 이기고** 아래
    // 두 번째 인자는 도달하지 않는다. #499 는 그 사실을 놓쳐서 생긴 드리프트였다
    // — 코드만 고치고 매니페스트를 안 고쳐서 writeFile 모달이 살아 있었고
    // browserType 은 목록에 없어 무조건 자동 허용이었다. 정책을 바꿀 때는
    // package.json 의 `default` 와 `items.enum` 을 고친다(스모크 테스트가 잠근다).
    const required = cfg.get<string[]>("requireApprovalFor", [
      "executeShell",
      "openBrowser",
      "delegateAgent",
      "browserType",
    ]);
    const needsApproval = required.includes(req.kind);
    if (!needsApproval) return true;

    // 한국어로 묻는다. 셸(`코치가 명령을 실행하려고 해요`)과 브라우저(`코치가
    // 브라우저를 열려고 해요`)는 한국어인데 파일 쓰기만 이 일반 폴백으로 빠져
    // `HypeProof Chat wants to writeFile:` / `Deny·Cancel·Approve` 로 나갔다.
    //
    // 잡음 제거가 아니라 **속도** 문제다(2026-07-27 실측): 한국어 모달은 3~4초
    // 만에 눌렸는데 이 영어 모달 하나가 42.2초를 잡아먹었다 — 그 한 건이 그 턴
    // 승인 대기의 77%였다. 성인 전문직 청중에게 갑자기 영어가 뜨면 읽는 데
    // 시간이 걸린다.
    //
    // 승인 게이트 자체는 유지한다(원장 결정 2026-07-27): 자기 결과물이 바뀌는
    // 순간마다 의식적으로 승인하는 것이 이 트랙의 위임 판단 훈련이다.
    const { title, verb } = APPROVAL_COPY[req.kind] ?? {
      title: "코치가 작업을 하려고 해요",
      verb: "허용",
    };
    const pick = await vscode.window.showWarningMessage(
      `${title}\n\n${req.description}`,
      { modal: true },
      verb,
    );
    return pick === verb;
  }

  private async postConfig(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    const token = await this.context.secrets.get(TOKEN_KEY);
    const profile = await this.ensureProfile();
    await this.post({
      type: "config",
      config: {
        proxyUrl: cfg.get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1"),
        model: cfg.get<string>("model", "hypeproof-default"),
        hasToken: !!token,
        coach: this.getCoach(),
        profile,
        update: this.availableUpdate,
      },
    });
  }

  // ---- #72: auto-update banner state ---------------------------------------
  // The scheduler in updateChecker.ts pushes here whenever a check completes;
  // we relay through postConfig so the webview re-renders. Null clears.
  private availableUpdate: import("./protocol").UpdateOffer | null = null;

  /**
   * Test-only: post `webviewTestCrash` to the webview so the React tree
   * throws on next render and ChatErrorBoundary catches it. Called from
   * the env-gated `__test_crashWebview` command (REQ-C7).
   */
  postTestCrash(): void {
    void this.post({ type: "webviewTestCrash" });
  }

  setAvailableUpdate(info: import("./protocol").UpdateOffer | null): void {
    this.availableUpdate = info;
    // Best-effort push; if webview isn't ready yet, the next postConfig
    // (e.g., after panel reveal) picks it up.
    void this.postConfig();
  }

  getAvailableUpdate(): import("./protocol").UpdateOffer | null {
    return this.availableUpdate;
  }

  private async postHistory(): Promise<void> {
    const messages = this.getHistory();
    await this.post({ type: "history", messages });
  }

  private async appendHistory(msgs: ChatMessage[]): Promise<void> {
    const current = this.getHistory();
    // #503 — 상한은 '말한 것' 기준으로 센다. 툴 줄까지 같은 200 안에서 세면 SDK
    // 턴 한 번(수십 줄)이 대화 히스토리를 통째로 밀어낸다.
    const next = clampTimeline([...current, ...msgs], HISTORY_MAX);
    await this.context.workspaceState.update(this.historyKey(), next);
  }

  private historyKey(): string {
    return historyKeyForCohort(this.activeCohortId);
  }

  private coachKey(): string {
    return coachKeyForCohort(this.activeCohortId);
  }

  private coachRitualDoneKey(): string {
    return coachRitualDoneKeyForCohort(this.activeCohortId);
  }

  private getHistory(): ChatMessage[] {
    return this.context.workspaceState.get<ChatMessage[]>(this.historyKey(), []);
  }

  private async migrateLegacyStateForActiveCohort(): Promise<void> {
    const bucket = stateBucketId(this.activeCohortId);
    if (!bucket) return;

    const historyDone = this.context.globalState.get<boolean>(HISTORY_MIGRATION_DONE_KEY, false);
    if (!historyDone) {
      const targetKey = this.historyKey();
      const target = this.context.workspaceState.get<ChatMessage[]>(targetKey, []);
      const legacy = this.context.workspaceState.get<ChatMessage[]>(LEGACY_HISTORY_KEY, []);
      if (target.length === 0 && legacy.length > 0) {
        await this.context.workspaceState.update(targetKey, legacy);
      }
      await this.context.globalState.update(HISTORY_MIGRATION_DONE_KEY, true);
    }

    const coachDone = this.context.globalState.get<boolean>(COACH_MIGRATION_DONE_KEY, false);
    if (!coachDone) {
      const targetKey = this.coachKey();
      const target = this.context.globalState.get<CoachInfo | undefined>(targetKey, undefined);
      const legacy = this.context.globalState.get<CoachInfo | undefined>(LEGACY_COACH_KEY, undefined);
      if (!target && legacy) {
        await this.context.globalState.update(targetKey, legacy);
      }

      const targetDoneKey = this.coachRitualDoneKey();
      const targetDone = this.context.globalState.get<boolean | undefined>(targetDoneKey, undefined);
      const legacyDone = this.context.globalState.get<boolean>(LEGACY_COACH_RITUAL_DONE_KEY, false);
      if (targetDone === undefined && legacyDone) {
        await this.context.globalState.update(targetDoneKey, true);
      }
      await this.context.globalState.update(COACH_MIGRATION_DONE_KEY, true);
    }
  }

  /**
   * #503 — 툴 한 줄을 웹뷰로 보내면서 **같은 줄을 이 턴의 타임라인에도** 남긴다.
   * 이 한 지점을 통과하지 않는 toolLog 는 화면엔 뜨는데 히스토리엔 없는 줄이 되어,
   * 창을 다시 열면 사라진다 — 이 이슈가 잡으려는 증상 그 자체다.
   */
  private postToolLog(streamId: string, entry: ToolEntry): void {
    const t = this.turnTimelines.get(streamId);
    if (t) this.turnTimelines.set(streamId, timelineTool(t, entry, Date.now()));
    void this.post({ type: "toolLog", streamId, ...entry });
  }

  private async post(msg: HostMessage): Promise<boolean | void> {
    if (!this.view) return;
    return this.view.webview.postMessage(msg);
  }

  private renderHtml(webview: vscode.Webview, distDir: vscode.Uri): string {
    const indexPath = path.join(distDir.fsPath, "index.html");
    if (!fs.existsSync(indexPath)) {
      return /* html */ `<!doctype html><html><body style="font-family:sans-serif;padding:20px">
        <h3>HypeProof Chat — webview not built</h3>
        <p>Run <code>npm run build:webview</code> in <code>extensions/hypeproof-chat/</code>.</p>
      </body></html>`;
    }
    let html = fs.readFileSync(indexPath, "utf8");
    // Rewrite asset URIs (`./assets/x`, `/assets/x`, `assets/x`) to
    // vscode-resource scheme so the sandboxed iframe can fetch them.
    html = html.replace(
      /(src|href)="(?!https?:|data:|vscode-|#)([^"]+)"/g,
      (_m, attr: string, raw: string) => {
        const cleaned = raw.replace(/^\.?\//, "");
        const onDisk = vscode.Uri.joinPath(distDir, cleaned);
        return `${attr}="${webview.asWebviewUri(onDisk)}"`;
      },
    );
    const nonce = randomId();
    const csp = buildChatPanelCsp({ cspSource: webview.cspSource, nonce });
    html = html.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);
    return html;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Is `targetPath` inside any of the currently-open workspace folders? Used by
 * the writeFile path-scope check (#115). Resolves both sides to absolute paths
 * before comparison so `..` traversal can't sneak past.
 *
 * Returns true when no workspace is open — we don't want to block writes in
 * dev/test scenarios that haven't opened a folder yet. The production path
 * always has a workspace via ensureWorkspace().
 */
/**
 * Canonicalize a path for containment comparison. realpath the nearest
 * EXISTING ancestor (the target itself may not exist yet — new-file writes),
 * then re-append the non-existing tail. Resolves macOS /var → /private/var
 * style symlinks so a canonicalized SDK path still matches the workspace root
 * (#384: without this every coach Write in a symlinked workspace auto-denied).
 */
function canonicalizeForCompare(p: string): string {
  let base = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0
        ? fs.realpathSync(base)
        : path.join(fs.realpathSync(base), ...tail.reverse());
    } catch {
      const parent = path.dirname(base);
      if (parent === base) return path.resolve(p); // hit fs root — give up
      tail.push(path.basename(base));
      base = parent;
    }
  }
}

function isInsideWorkspace(targetPath: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return true;
  const resolved = canonicalizeForCompare(targetPath);
  for (const f of folders) {
    const root = canonicalizeForCompare(f.uri.fsPath);
    const rel = path.relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

function stripMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

/**
 * Pull renderable HTML out of an assistant message. Order of preference:
 *   1. ```html fenced block
 *   2. Full <!doctype html...> document anywhere in the text
 *   3. ```javascript or ```js block → wrap into a minimal HTML shell
 * Returns null if nothing renderable found.
 */
export function extractRenderableHtml(text: string): string | null {
  const htmlFence = /```(?:html|HTML)\s*\n([\s\S]*?)\n```/.exec(text);
  if (htmlFence) return htmlFence[1].trim();

  const doctype = /<!doctype\s+html[\s\S]*?<\/html\s*>/i.exec(text);
  if (doctype) return doctype[0];

  const jsFence = /```(?:javascript|js)\s*\n([\s\S]*?)\n```/.exec(text);
  if (jsFence) {
    const js = jsFence[1].trim();
    return `<!doctype html>
<html><head><meta charset="utf-8"><style>body{margin:0;font-family:sans-serif;padding:12px}</style></head>
<body><script>
try { ${js} } catch (err) { document.body.innerHTML = '<pre style="color:#c00">'+ err +'</pre>'; }
</script></body></html>`;
  }

  return null;
}
