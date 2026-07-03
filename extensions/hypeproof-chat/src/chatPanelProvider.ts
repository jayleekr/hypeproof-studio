import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { TOKEN_KEY } from "./extension";
import type { AssetScoreSink } from "./assetStatusBar";
import { proxyChat, fetchProfile, ProxyAuthError, ProxyTransportError } from "./proxyClient";
import { runSdkCoach, SdkUnavailableError } from "./sdkCoach";
import { sdkToolToActionRequest } from "./sdkCoachHelpers";
import { PreviewProvider } from "./previewProvider";
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
} from "./chatPanelHelpers";
import { buildChatPanelCsp } from "./cspBuilder";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private activeStreams = new Map<string, AbortController>();
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private cachedProfile: ResolvedProfile | null = null;
  private profileFetchPromise: Promise<ResolvedProfile | null> | null = null;
  // #278 — browser-page context queued by "페이지를 코치에게", prepended to the
  // NEXT turn's prompt only (history keeps the user's clean text).
  private pendingPageContext: string | null = null;
  private activeCohortId: string | null = null;
  // Stashed for the bug-report flow (#64). Updated whenever a stream errors
  // or completes — the Worker's request-id middleware (PR #49) plumbs an
  // x-request-id header on every response we can correlate against in tail.
  private lastRequestId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly preview: PreviewProvider,
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

  /** #278 — stash captured browser-page context to prepend to the next turn. */
  attachPageContext(ctx: { url: string; title: string; text: string }): void {
    const body = ctx.text.trim().slice(0, 3000);
    this.pendingPageContext =
      `[현재 브라우저 페이지]\nURL: ${ctx.url}\n제목: ${ctx.title}\n` +
      `--- 페이지 내용(일부) ---\n${body}\n---\n` +
      `위 페이지를 참고해서 답해줘.`;
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
  }

  /** Force re-fetch on next config push (e.g. after token change). */
  invalidateProfile(): void {
    this.cachedProfile = null;
    this.profileFetchPromise = null;
    this.activeCohortId = null;
    this.assetScores?.resetAssetScores();
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
    if (!token) return null;

    this.profileFetchPromise = fetchProfile({ proxyUrl, token }).then(
      async (p) => {
        this.cachedProfile = p;
        this.profileFetchPromise = null;
        // #278 — gate the "페이지를 코치에게" toolbar button to opted-in cohorts.
        void vscode.commands.executeCommand(
          "setContext",
          "hypeproof-chat.pageContextEnabled",
          p?.input?.page_context === true,
        );
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
        return;
      case "sendMessage":
        await this.handleSend(msg.text, msg.history);
        return;
      case "retryMessage":
        await this.handleSend(msg.prompt, msg.history);
        return;
      case "cancelStream":
        this.activeStreams.get(msg.streamId)?.abort();
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
        void this.preview.show(msg.html);
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

  private async handleSend(text: string, history: ChatMessage[]): Promise<void> {
    // "Show me / open it / run it" — if the kid asks to see the game in plain
    // language and a game already exists, just open it. Don't make them hunt
    // for the ▶ Run button or burn an AI round-trip on a deflection.
    if (isShowIntent(text)) {
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
        void this.preview.show(lastGame);
        void this.saveGameToWorkspace(lastGame);
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
    const userTextForModel = pageContext ? `${pageContext}\n\n${text}` : text;

    const streamId = randomId();
    const messageId = randomId();
    const ctrl = new AbortController();
    this.activeStreams.set(streamId, ctrl);

    void this.post({ type: "streamStart", streamId, messageId });

    let assistantText = "";
    // REQ-D2: auto-reveal as soon as a renderable HTML block completes in
    // the stream, NOT waiting for streamEnd. The block closes (```) often
    // arrives many seconds before the assistant's trailing prose. Showing
    // the game in that window is the strongest Taste "감탄" moment.
    let revealed = false;
    const tryReveal = (text: string) => {
      if (revealed) return;
      const html = extractRenderableHtml(text);
      if (!html) return;
      revealed = true;
      void this.preview.show(html);
      void this.saveGameToWorkspace(html);
    };
    // #173 — accumulate citations across the stream so they persist to history.
    const assistantCitations: import("./protocol").Citation[] = [];
    try {
      // #282 Phase 1 — route to the Agent SDK coach behind the flag. Default
      // "proxy" keeps the exact existing single-turn behavior; "agent-sdk"
      // runs runSdkCoach with the SAME callbacks so nothing downstream changes.
      const runtime = cfg.get<"proxy" | "agent-sdk">("coachRuntime", "proxy");
      const onDelta = (delta: string) => {
        assistantText += delta;
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
      const runProxy = () =>
        proxyChat({
          proxyUrl,
          model,
          token,
          history,
          userText: userTextForModel,
          signal: ctrl.signal,
          coachName: effectiveCoachName,
          coachPersonality: effectiveCoachPersonality,
          onDelta,
          onCitations,
          onAssetScore,
        });
      if (runtime === "agent-sdk") {
        if (!profile) {
          throw new Error("코치 프로필을 아직 못 받았어요. 잠시 후 다시 시도해주세요.");
        }
        if (!token) {
          throw new ProxyAuthError("missing", "토큰이 필요해요. 선생님께 받은 토큰을 넣어주세요. 🔑");
        }
        try {
          await runSdkCoach({
            gatewayUrl: proxyUrl,
            token,
            model,
            profile,
            // TODO(#282 Phase 1): source the cohort system prompt via the worker
            // gateway (keeps the key server-side; worker injects prompt + auth).
            systemPrompt: "",
            history: history.map((m) => ({ role: m.role, content: m.content })),
            userText: userTextForModel,
            signal: ctrl.signal,
            onDelta,
            onCitations,
            onAssetScore,
            // Map the SDK tool call → an accurate host ActionRequest so the
            // executeShell hard-deny and writeFile workspace-scope actually fire.
            requestApproval: (action) =>
              this.resolveActionApproval({ requestId: randomId(), ...sdkToolToActionRequest(action) }),
          });
        } catch (err) {
          if (!(err instanceof SdkUnavailableError)) throw err;
          // Pre-Phase-1: the SDK package isn't installed. Keep the classroom
          // working — log for developers and fall back to the proxy runtime for
          // this turn instead of showing the student a technical error.
          console.warn(`[coach] ${err.message}`);
          assistantText = "";
          assistantCitations.length = 0;
          revealed = false;
          await runProxy();
        }
      } else {
        await runProxy();
      }
      // On user-initiated stop the cancelStream handler already ended the stream
      // in the webview; don't post streamEnd or commit the truncated turn
      // (parity with the proxy path, which throws on abort).
      if (!ctrl.signal.aborted) {
        void this.post({ type: "streamEnd", streamId });
        await this.appendHistory([
          { id: randomId(), role: "user", content: text, createdAt: Date.now() },
          {
            id: messageId,
            role: "assistant",
            content: assistantText,
            createdAt: Date.now(),
            ...(assistantCitations.length > 0 ? { citations: assistantCitations } : {}),
          },
        ]);
        // Fallback reveal in case the stream completed but the per-chunk
        // probe missed it (e.g. the closing ``` was in the very last delta).
        tryReveal(assistantText);
      }
    } catch (err) {
      await this.handleSendError(err, streamId);
    } finally {
      this.activeStreams.delete(streamId);
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
      if (err.kind === "expired" || err.kind === "missing") {
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
    // Tier 1 — hard-deny shell exec.
    if (req.kind === "executeShell") {
      vscode.window.showInformationMessage(
        "셸 실행은 허용되지 않아요. 다른 방법으로 도와드릴게요.",
      );
      return false;
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
    const required = cfg.get<string[]>("requireApprovalFor", ["writeFile", "executeShell"]);
    const needsApproval = required.includes(req.kind);
    if (!needsApproval) return true;

    const pick = await vscode.window.showWarningMessage(
      `HypeProof Chat wants to ${req.kind}:\n\n${req.description}`,
      { modal: true },
      "Approve",
      "Deny",
    );
    return pick === "Approve";
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
    const next = clampHistory(current, msgs, HISTORY_MAX);
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
function isInsideWorkspace(targetPath: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return true;
  const resolved = path.resolve(targetPath);
  for (const f of folders) {
    const root = path.resolve(f.uri.fsPath);
    const rel = path.relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

/** True for an AbortError from either runtime (fetch abort or SDK abort). */
function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "AbortError"
  );
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
