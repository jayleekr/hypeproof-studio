import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { TOKEN_KEY } from "./extension";
import { proxyChat, fetchProfile, ProxyAuthError } from "./proxyClient";
import { PreviewProvider } from "./previewProvider";
import {
  ChatMessage,
  CoachInfo,
  HostMessage,
  ResolvedProfile,
  WebviewMessage,
  ActionRequest,
} from "./protocol";

const HISTORY_KEY = "hypeproofChat.history";
const HISTORY_MAX = 200;
export const COACH_KEY = "hypeproofChat.coach";
const COACH_RITUAL_DONE_KEY = "hypeproofChat.coachRitualDone";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private activeStreams = new Map<string, AbortController>();
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private cachedProfile: ResolvedProfile | null = null;
  private profileFetchPromise: Promise<ResolvedProfile | null> | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly preview: PreviewProvider,
  ) {}

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
    view.onDidDispose(() => {
      for (const ctrl of this.activeStreams.values()) ctrl.abort();
      this.activeStreams.clear();
    });
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

    const next: CoachInfo = {
      name: (name.trim() || fallback).slice(0, 40),
      personality: personality.trim().slice(0, 200),
      configured: true,
    };
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
    const next: CoachInfo = {
      name: (name.trim() || fallback).slice(0, 40),
      personality: personality.trim().slice(0, 200),
      configured: true,
    };
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
    }
  }

  private async handleSend(text: string, history: ChatMessage[]): Promise<void> {
    // "Show me / open it / run it" — if the kid asks to see the game in plain
    // language and a game already exists, just open it. Don't make them hunt
    // for the ▶ Run button or burn an AI round-trip on a deflection.
    if (isShowIntent(text)) {
      const lastGame = this.extractLastRenderableCode();
      if (lastGame) {
        const uid = randomId();
        const aid = randomId();
        void this.post({ type: "streamStart", streamId: uid, messageId: aid });
        void this.post({ type: "streamChunk", streamId: uid, delta: "오른쪽 창에 게임을 열었어요! 🎮 한번 해보세요." });
        void this.post({ type: "streamEnd", streamId: uid });
        await this.appendHistory([
          { id: randomId(), role: "user", content: text, createdAt: Date.now() },
          { id: aid, role: "assistant", content: "오른쪽 창에 게임을 열었어요! 🎮 한번 해보세요.", createdAt: Date.now() },
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

    const streamId = randomId();
    const messageId = randomId();
    const ctrl = new AbortController();
    this.activeStreams.set(streamId, ctrl);

    void this.post({ type: "streamStart", streamId, messageId });

    let assistantText = "";
    try {
      await proxyChat({
        proxyUrl,
        model,
        token,
        history,
        userText: text,
        signal: ctrl.signal,
        coachName: coach.name,
        coachPersonality: coach.personality,
        onDelta: (delta) => {
          assistantText += delta;
          void this.post({ type: "streamChunk", streamId, delta });
        },
      });
      void this.post({ type: "streamEnd", streamId });
      await this.appendHistory([
        { id: randomId(), role: "user", content: text, createdAt: Date.now() },
        { id: messageId, role: "assistant", content: assistantText, createdAt: Date.now() },
      ]);
      // Auto-reveal the game the moment it exists — the strongest essence-1
      // ("감탄") moment. Opens the editor-area preview beside the chat. The
      // ▶ Run button still re-renders into the same panel afterwards.
      const html = extractRenderableHtml(assistantText);
      if (html) {
        void this.preview.show(html);
        void this.saveGameToWorkspace(html);
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
    if (err instanceof ProxyAuthError) {
      void this.post({ type: "streamError", streamId, error: err.friendly });
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
    void this.post({ type: "streamError", streamId, error: reason });
  }

  private async handleActionRequest(req: ActionRequest): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    const required = cfg.get<string[]>("requireApprovalFor", ["writeFile", "executeShell"]);
    const needsApproval = required.includes(req.kind);

    let approved = !needsApproval;
    if (needsApproval) {
      const pick = await vscode.window.showWarningMessage(
        `HypeProof Chat wants to ${req.kind}:\n\n${req.description}`,
        { modal: true },
        "Approve",
        "Deny",
      );
      approved = pick === "Approve";
    }

    void this.post({ type: "actionResult", requestId: req.requestId, approved });
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
      },
    });
  }

  private async postHistory(): Promise<void> {
    const messages = this.context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
    await this.post({ type: "history", messages });
  }

  private async appendHistory(msgs: ChatMessage[]): Promise<void> {
    const current = this.context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
    const next = [...current, ...msgs].slice(-HISTORY_MAX);
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
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
    ].join("; ");
    html = html.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);
    return html;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Does the kid's message mean "(just) show/open/run the existing game"?
 *
 * Tight on purpose: a message that *describes* a game ("별이 떨어지는 게임
 * 보여줘") is a CREATE request, not a show request. So we only match short
 * messages that have no create/modify verbs and no descriptive content.
 */
function isShowIntent(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!.?~\s]+$/g, "");
  if (t.length > 14) return false;
  // Creation/modification words → it's a new request, not "show it".
  if (/(만들|추가|바꿔|바꾸|그려|넣어|없애|지워|색|소리|빠르|느리|크게|작게)/.test(t)) return false;
  return /^(그거\s*)?(게임\s*)?(보여|열어|실행|돌려|켜|플레이|미리\s*보기|다시\s*보여|run|play|open|show)(줘|봐|해|해줘|해봐|해주세요|보자)?$/.test(
    t,
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
