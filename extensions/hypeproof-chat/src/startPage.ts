import * as vscode from "vscode";
import { ChatPanelProvider } from "./chatPanelProvider";
import { fetchProfileResult } from "./proxyClient";
import { sanitizeWorkshopToken, looksLikeIssuerTokenUnverified } from "./chatPanelHelpers";
import type { ResolvedProfile } from "./protocol";
import type { StartRequest, StartState } from "./startPageProtocol";

const TOKEN_KEY = "hypeproofChat.workshopToken";

/** App entry surface; authentication and cohort authority remain in Service. */
export class StartPage {
  private panel?: vscode.WebviewPanel;
  private busy = false;
  private error?: string;
  constructor(
    private context: vscode.ExtensionContext,
    private chat: ChatPanelProvider,
    private begin: (profile: ResolvedProfile) => Promise<boolean>,
  ) {}

  async show(): Promise<void> {
    if (this.panel) { this.panel.reveal(); void this.refresh(); return; }
    // Empty first-run windows need one useful canvas, not empty editor groups.
    // Existing editors and layouts are left alone.
    if (vscode.window.tabGroups.all.every(group => group.tabs.length === 0)) {
      await vscode.commands.executeCommand("workbench.action.editorLayoutSingle");
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    }
    const existing = this.panel as vscode.WebviewPanel | undefined;
    if (existing) { existing.reveal(); return; }
    const panel = vscode.window.createWebviewPanel("hypeproof.start", "HypeProof Studio", vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist")] });
    this.panel = panel;
    panel.webview.html = this.chat.renderHtml(panel.webview, vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist"))
      .replace(/<html\b/, '<html data-surface="start"');
    panel.webview.onDidReceiveMessage((msg: StartRequest) => { void this.handle(msg); });
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    this.context.subscriptions.push(panel);
  }

  private async refresh(): Promise<void> {
    const p = await this.chat.ensureProfile();
    const state: StartState = {
      checking: this.busy,
      error: this.error ?? (!p ? this.chat.profileFailure()?.friendly : undefined),
      version: this.context.extension.packageJSON.version,
      workspace: vscode.workspace.workspaceFolders?.[0]?.name,
      ...(p ? { profile: { id: p.profile_id, name: p.display_name,
        coach: p.ux.coach.naming_mode === "fixed" ? p.ux.coach.fallback_name : "직접 이름 짓는 코치",
        series: `${p.series_index} / ${p.series_total}`, workspace: p.workspace_root ?? "현재 작업 폴더" } } : {}),
    };
    await this.panel?.webview.postMessage({ type: "startState", state });
  }

  private async handle(msg: StartRequest): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "startReady") { await this.refresh(); return; }
    if (this.busy) return;
    if (this.chat.hasActiveStream()) { this.error = "진행 중인 작업을 마치거나 중지한 후 수업을 변경하세요."; await this.refresh(); return; }
    if (msg.type === "openLocalFolder") {
      const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "작업 폴더 열기" });
      if (folders?.[0]) await vscode.commands.executeCommand("vscode.openFolder", folders[0]);
      return;
    }
    if (msg.type === "disconnectCourse") {
      this.busy = true; this.chat.setConnectionChanging(true);
      try {
        await this.context.secrets.delete(TOKEN_KEY);
        this.chat.invalidateProfile(); this.error = undefined;
        this.chat.refreshConfig();
      } finally {
        this.busy = false; this.chat.setConnectionChanging(false); await this.refresh();
      }
      return;
    }
    if (msg.type === "beginCourse") {
      const p = await this.chat.ensureProfile();
      if (!p) { await this.refresh(); return; }
      this.error = undefined;
      if (await this.begin(p)) return; // folder switch reloads the window
      this.panel?.dispose();
      await vscode.commands.executeCommand("workbench.view.extension.hypeproof-chat");
      await vscode.commands.executeCommand("hypeproof-chat.panel.focus");
      this.chat.refreshConfig();
      return;
    }
    if (msg.type !== "connectCourse" || typeof msg.token !== "string") return;
    const token = sanitizeWorkshopToken(msg.token);
    if (!token) { this.error = "수업 참여 코드를 입력하세요."; await this.refresh(); return; }
    if (looksLikeIssuerTokenUnverified(token)) {
      this.error = "강사용 코드입니다. 수강생 참여 코드를 입력하세요."; await this.refresh(); return;
    }
    this.busy = true; this.error = undefined; this.chat.setConnectionChanging(true);
    await this.refresh();
    try {
      const proxyUrl = vscode.workspace.getConfiguration("hypeproofChat").get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
      const result = await fetchProfileResult({ proxyUrl, token });
      if (!result.ok) { this.error = result.failure.friendly; return; }
      const p = result.profile;
      if (!p?.profile_id || !p.display_name || !p.ux?.coach || !p.welcome) {
        this.error = "수업 정보 응답을 읽지 못했습니다. 잠시 후 다시 연결하세요."; return;
      }
      // Validate before replacing a working connection. No credential echo or URL/state persistence.
      const previous = await this.context.secrets.get(TOKEN_KEY);
      await this.context.secrets.store(TOKEN_KEY, token);
      this.chat.invalidateProfile();
      const resolved = await this.chat.ensureProfile();
      if (!resolved) {
        this.error = this.chat.profileFailure()?.friendly ?? "수업 정보를 확인하지 못했습니다. 다시 시도하세요.";
        if (previous) await this.context.secrets.store(TOKEN_KEY, previous);
        else await this.context.secrets.delete(TOKEN_KEY);
        this.chat.invalidateProfile();
      }
      this.chat.refreshConfig();
    } catch {
      this.error = "수업에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.";
    } finally {
      this.busy = false; this.chat.setConnectionChanging(false);
      await this.refresh();
    }
  }
}
