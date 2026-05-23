import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { TOKEN_KEY } from "./extension";
import { proxyChat, fetchProfile, ProxyAuthError, ProxyTransportError } from "./proxyClient";
import { PreviewProvider } from "./previewProvider";
import {
  ChatMessage,
  CoachInfo,
  HostMessage,
  ResolvedProfile,
  WebviewMessage,
  ActionRequest,
} from "./protocol";
import { isShowIntent, clampHistory, HISTORY_MAX, sanitizeCoachInput, abortAllStreams, resolveCoach, labelsForProfile } from "./chatPanelHelpers";
import { buildChatPanelCsp } from "./cspBuilder";

const HISTORY_KEY = "hypeproofChat.history";
export const COACH_KEY = "hypeproofChat.coach";
const COACH_RITUAL_DONE_KEY = "hypeproofChat.coachRitualDone";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private activeStreams = new Map<string, AbortController>();
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private cachedProfile: ResolvedProfile | null = null;
  private profileFetchPromise: Promise<ResolvedProfile | null> | null = null;
  // Stashed for the bug-report flow (#64). Updated whenever a stream errors
  // or completes — the Worker's request-id middleware (PR #49) plumbs an
  // x-request-id header on every response we can correlate against in tail.
  private lastRequestId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly preview: PreviewProvider,
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

  /**
   * Public accessor for #64. Returns the persisted chat history (workspaceState).
   * The report flow takes only the tail (last 3) and only when the user
   * explicitly opts in.
   */
  getHistorySnapshot(): ChatMessage[] {
    return this.context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
  }

  // -------------------------------------------------------------------------
  // Public API used by extension.ts
  // -------------------------------------------------------------------------

  extractLastRenderableCode(): string | null {
    const messages = this.context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
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
    void this.postConfig();
  }

  async clearHistory(): Promise<void> {
    await this.context.workspaceState.update(HISTORY_KEY, []);
    void this.post({ type: "history", messages: [] });
  }

  /** Force re-fetch on next config push (e.g. after token change). */
  invalidateProfile(): void {
    this.cachedProfile = null;
    this.profileFetchPromise = null;
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
    await this.context.globalState.update(COACH_KEY, next);
    await this.context.globalState.update(COACH_RITUAL_DONE_KEY, true);
    await this.postConfig();
  }

  /** Should extension.ts pop the naming ritual on this launch? */
  shouldOfferNamingRitual(profile: ResolvedProfile | null): boolean {
    const mode = profile?.ux.coach.naming_mode ?? "fixed";
    if (mode === "fixed") return false;
    const done = this.context.globalState.get<boolean>(COACH_RITUAL_DONE_KEY, false);
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
      (p) => {
        this.cachedProfile = p;
        this.profileFetchPromise = null;
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
    return this.context.globalState.get<CoachInfo>(COACH_KEY, {
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
    await this.context.globalState.update(COACH_KEY, next);
    await this.context.globalState.update(COACH_RITUAL_DONE_KEY, true);
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

    const streamId = randomId();
    const messageId = randomId();
    const ctrl = new AbortController();
    this.activeStreams.set(streamId, ctrl);

    void this.post({ type: "streamStart", streamId, messageId });

    let assistantText = "";
    // REQ-D2: auto-reveal as soon as a renderable HTML block completes in
    // the stream, NOT waiting for streamEnd. The block closes (```) often
    // arrives many seconds before the assistant's trailing prose. Showing
    // the game in that window is the strongest essence-1 "감탄" moment.
    let revealed = false;
    const tryReveal = (text: string) => {
      if (revealed) return;
      const html = extractRenderableHtml(text);
      if (!html) return;
      revealed = true;
      void this.preview.show(html);
      void this.saveGameToWorkspace(html);
    };
    try {
      await proxyChat({
        proxyUrl,
        model,
        token,
        history,
        userText: text,
        signal: ctrl.signal,
        coachName: effectiveCoachName,
        coachPersonality: effectiveCoachPersonality,
        onDelta: (delta) => {
          assistantText += delta;
          void this.post({ type: "streamChunk", streamId, delta });
          // Cheap check; extractRenderableHtml regex returns null fast on
          // most chunks (no fence/doctype present yet).
          tryReveal(assistantText);
        },
      });
      void this.post({ type: "streamEnd", streamId });
      await this.appendHistory([
        { id: randomId(), role: "user", content: text, createdAt: Date.now() },
        { id: messageId, role: "assistant", content: assistantText, createdAt: Date.now() },
      ]);
      // Fallback reveal in case the stream completed but the per-chunk
      // probe missed it (e.g. the closing ``` was in the very last delta).
      tryReveal(assistantText);
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

    // Tier 2 — writeFile must target the active workspace.
    if (req.kind === "writeFile") {
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
    const messages = this.context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
    await this.post({ type: "history", messages });
  }

  private async appendHistory(msgs: ChatMessage[]): Promise<void> {
    const current = this.context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
    const next = clampHistory(current, msgs, HISTORY_MAX);
    await this.context.workspaceState.update(HISTORY_KEY, next);
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
