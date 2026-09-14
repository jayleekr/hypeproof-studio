import * as vscode from "vscode";
import { ChatPanelProvider } from "./chatPanelProvider";
import { ActivityConnectionError, activityConnections } from "./activityConnections";
import { fetchProfileResult, verifyActivity, ProxyTransportError } from "./proxyClient";
import { sanitizeWorkshopToken, looksLikeIssuerTokenUnverified } from "./chatPanelHelpers";
import type { ResolvedProfile } from "./protocol";
import type { StartRequest, StartState } from "./startPageProtocol";

const entryError = (error:unknown) => error instanceof ActivityConnectionError || error instanceof ProxyTransportError
  ? error.message : "활동을 열지 못했습니다. 다시 시도해 주세요. 기존 연결과 작업 파일은 보존됩니다.";
const TOKEN_KEY = "hypeproofChat.workshopToken";

/**
 * 활동 분리 **이전**에 쌓인 대화 기록 키인가 (#960).
 *
 * 한 곳에 둔 이유: 같은 판정이 "내보내기 버튼을 보일까"(refresh)와 "무엇을 파일로
 * 쓸까"(exportLegacyHistory) 두 곳에 복사돼 있었다. 갈라지면 버튼은 안 보이는데
 * 내보내면 현재 활동 대화가 섞여 나가거나(또는 그 반대) 하고, 그 어긋남은 둘 다
 * "통과" 로 보인다. 활동별 키는 끝이 64자리 hex 라 여기서 걸러낸다 — 그건 이미
 * 활동에 묶여 있으므로 '이전 기록' 이 아니다.
 */
const isLegacyHistoryKey = (key: string): boolean =>
  key === 'hypeproofChat.history' || (key.startsWith('hypeproofChat.history:') && !/:[a-f0-9]{64}$/.test(key));

/** App entry surface; authentication and cohort authority remain in Service. */
export class StartPage {
  private panel?: vscode.WebviewPanel;
  private busy = false;
  private error?: string;
  private started = false;
  private candidate?: { token: string; profile: ResolvedProfile; proxyUrl: string; previousConnected: boolean; workspace?: string };
  constructor(
    private context: vscode.ExtensionContext,
    private chat: ChatPanelProvider,
    private begin: (profile: ResolvedProfile, commit: (directory?: string) => Promise<void>) => Promise<boolean>,
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
    // #747 — the naming step happens in the chat panel; this tab is retained
    // (retainContextWhenHidden), so re-read the identity whenever it comes back
    // to the front instead of showing the name from before the rename.
    panel.onDidChangeViewState(e => { if (e.webviewPanel.active) void this.refresh(); });
    panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.candidate = undefined; } });
    this.context.subscriptions.push(panel);
  }

  private async refresh(profile?: ResolvedProfile | null): Promise<void> {
    const p = this.candidate?.profile ?? (profile === undefined ? await this.chat.ensureProfile() : profile);
    let activities: StartState['activities'];
    try { activities=await activityConnections(this.context)?.list(); }
    catch { this.error ??= "저장된 활동 목록을 읽지 못했습니다. 참여 코드를 다시 입력해 주세요."; }
    const legacyHistory=this.context.workspaceState?.keys?.().some(isLegacyHistoryKey);
    const state: StartState = {
      legacyConnection:await activityConnections(this.context)?.hasLegacyConnection(),
      legacyHistory,
      activities,
      checking: this.busy,
      started: !this.candidate && this.started && !!p,
      candidate: !!this.candidate,
      previousConnected: this.candidate ? this.candidate.previousConnected : !!p,
      error: this.error ?? (!p ? this.chat.profileFailure()?.friendly : undefined),
      version: this.context.extension.packageJSON.version,
      workspace: vscode.workspace.workspaceFolders?.[0]?.name,
      ...(p ? { coachName: this.chat.coachDisplayName(p), profile: { kind: p.activity_kind, id: p.profile_id, name: p.lesson?.content.title ?? p.display_name,
        // #747 — the row is labelled "AI 이름", so it shows the name the rest of
        // the card uses. A student-named cohort that has not been named yet
        // describes the mode instead of showing the placeholder as a name.
        coach: this.chat.coachNameIsChosen(p) ? this.chat.coachDisplayName(p) : "직접 이름 짓는 코치",
        series: p.lesson?.version ?? `${p.series_index} / ${p.series_total}`, workspace: p.workspace_root ?? "현재 작업 폴더" } } : {}),
    };
    await this.panel?.webview.postMessage({ type: "startState", state });
  }

  private async handle(msg: StartRequest): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "startReady") { await this.refresh(); return; }
    if (msg.type === "openStudioFiles" || msg.type === "openStudioSettings") {
      await vscode.commands.executeCommand(msg.type === "openStudioFiles" ? "workbench.view.explorer" : "workbench.action.openSettings");
      return;
    }
    if (msg.type==='exportLegacyHistory') {
      const keys=this.context.workspaceState.keys().filter(isLegacyHistoryKey);
      const file=await vscode.window.showSaveDialog({saveLabel:'이전 기록 저장',filters:{JSON:['json']}});
      if(file) {
        const backup={format:'hps-local-history-export/1',records:keys.map(key=>({source:key,messages:this.context.workspaceState.get(key,[])}))};
        try { await vscode.workspace.fs.writeFile(file,new TextEncoder().encode(JSON.stringify(backup,null,2))); }
        catch { this.error='기록을 저장하지 못했습니다. 다른 저장 위치를 선택해 주세요.'; await this.refresh(); }
      }
      return;
    }
    if (this.busy) return;
    const connections = activityConnections(this.context);
    if (this.chat.hasActiveStream()) { this.error = "진행 중인 작업을 마치거나 중지한 후 활동을 변경하세요."; await this.refresh(); return; }
    if (msg.type === "openLocalFolder") {
      const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "작업 폴더 열기" });
      if (folders?.[0]) await vscode.commands.executeCommand("vscode.openFolder", folders[0]);
      return;
    }
    if (msg.type === 'selectActivity') {
      this.busy = true;
      try {
        const record = await connections?.candidate(msg.ref);
        // ActivityConnectionError 여야 한다. 평범한 Error 는 entryError 가 일반 문구로
        // 덮어써서, 여기 적힌 이유가 학생에게 **한 번도 도달하지 않는다**(#960 에서
        // 테스트를 쓰다 발견). 저장 목록에서 고른 항목이 사라진 경우는 재시도가 아니라
        // 다른 항목 선택이 답이므로 일반 문구보다 이 문장이 맞다.
        if (!record) throw new ActivityConnectionError('저장된 활동을 찾지 못했습니다.');
        const result = await fetchProfileResult({proxyUrl:record.service,token:record.token});
        if (!result.ok) {this.error=result.failure.friendly; return;}
        this.candidate = {token:record.token,proxyUrl:record.service,profile:{...result.profile,workspace_root:record.workspace},workspace:record.workspace,previousConnected:!!connections?.current};
        this.error = undefined;
      } catch (error) { this.error = entryError(error); }
      finally { this.busy=false; await this.refresh(); }
      return;
    }
    if (msg.type === 'chooseActivityFolder' && this.candidate) {
      const choice = await vscode.window.showOpenDialog({canSelectFiles:false,canSelectFolders:true,canSelectMany:false,openLabel:'이 활동의 작업 폴더 선택'});
      if (choice?.[0]) { this.candidate.workspace=choice[0].fsPath; this.candidate.profile={...this.candidate.profile,workspace_root:choice[0].fsPath}; }
      await this.refresh(); return;
    }
    if (msg.type === "cancelCandidate") {
      this.candidate = undefined; this.error = undefined; await this.refresh(); return;
    }
    if (msg.type === "disconnectCourse") {
      this.busy = true;
      try {
        await this.chat.setConnectionChanging(true);
        await this.context.secrets.delete(TOKEN_KEY);
        this.candidate = undefined; this.chat.invalidateProfile(); this.error = undefined; this.started = false;
        this.chat.refreshConfig();
      } catch (error) { this.error=entryError(error); } finally {
        this.busy = false; await this.chat.setConnectionChanging(false); await this.refresh();
      }
      return;
    }
    if (msg.type === "beginCourse") {
      const candidate = this.candidate;
      const wasStarted = this.started;
      let previous: string | undefined;
      let committed = false;
      let rollback: (() => Promise<void>) | undefined;
      this.busy = true; this.error = undefined;
      let profile: ResolvedProfile | null = null;
      try {
        await this.chat.setConnectionChanging(true);
        await this.refresh();
        // A connected card is not proof that the session is still live.
        if (candidate) {
          const proxyUrl = vscode.workspace.getConfiguration("hypeproofChat").get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
          if (proxyUrl !== candidate.proxyUrl) throw new Error("Activity Service changed during confirmation");
          const result = await fetchProfileResult({ proxyUrl, token: candidate.token });
          if (!result.ok) { this.error = result.failure.friendly; return; }
          profile = candidate.workspace ? {...result.profile,workspace_root:candidate.workspace} : result.profile;
          if (!profile?.profile_id || !profile.display_name || !profile.ux?.coach || !profile.welcome) throw new Error("Invalid activity profile");
        } else profile = await this.chat.ensureProfile(true);
        if (!profile) {
          this.error = this.chat.profileFailure()?.friendly ?? "수업 연결을 확인할 수 없습니다. 참여 코드를 다시 확인해주세요.";
          return;
        }
        if (connections) {
          const token = candidate?.token ?? await connections.token();
          if (!token) throw new Error('참여 코드를 다시 입력해 주세요.');
          await verifyActivity({proxyUrl:candidate?.proxyUrl ?? vscode.workspace.getConfiguration('hypeproofChat').get<string>('proxyUrl','https://api.hypeproof-ai.xyz/v1'),token},profile.activity_id ?? '');
        }
        const commit = async (directory?: string) => {
          if (!this.panel || (candidate && !committed && this.candidate !== candidate)) throw new Error("Activity entry was cancelled");
          if (!candidate || committed) return;
          previous = await this.context.secrets.get(TOKEN_KEY);
          if (!this.panel || this.candidate !== candidate) throw new Error("Activity entry was cancelled");
          if (connections) {
            const root = directory ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!root) throw new Error('작업 폴더를 선택해 주세요.');
            rollback = await connections.commit(candidate.token,profile!,root);
          } else await this.context.secrets.store(TOKEN_KEY, candidate.token);
          committed = true;
          this.chat.invalidateProfile();
          if (vscode.workspace.getConfiguration("hypeproofChat").get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1") !== candidate.proxyUrl) throw new Error("Activity Service changed during confirmation");
          if (!await this.chat.ensureProfile(true)) throw new Error('connection validation failed');
          if (!this.panel || this.candidate !== candidate) throw new Error("Activity entry was cancelled");
          this.candidate = undefined;
        };
        if (await this.begin(profile, commit)) return; // workspace switch reloads the window
        await commit();
        const entry = this.panel;
        if (!entry) throw new Error('Entry page was closed');
        await this.chat.openInEditor(entry);
        if (this.panel === entry) this.panel = undefined;
        this.started = true;
        this.chat.refreshConfig();
      } catch (error) {
        let restoreFailed = false;
        if (committed) {
          try {
            if (rollback) await rollback();
            else if (previous) await this.context.secrets.store(TOKEN_KEY, previous);
            else await this.context.secrets.delete(TOKEN_KEY);
          } catch { restoreFailed = true; }
          this.chat.invalidateProfile();
        }
        this.candidate = !restoreFailed && this.panel ? candidate : undefined;
        this.started = !restoreFailed && wasStarted;
        this.error = restoreFailed
          ? '활동 연결 복구를 완료하지 못했습니다. 파일은 삭제하지 않았습니다. 앱을 다시 열어 현재 활동을 확인해 주세요.'
          : entryError(error);
      } finally {
        this.busy = false; await this.chat.setConnectionChanging(false);
        await this.refresh();
      }
      return;
    }
    if (msg.type !== "connectCourse" || typeof msg.token !== "string") return;
    const token = sanitizeWorkshopToken(msg.token);
    if (!token) { this.error = "수업 참여 코드를 입력하세요."; await this.refresh(); return; }
    if (looksLikeIssuerTokenUnverified(token)) {
      this.error = "강사용 코드입니다. 수강생 참여 코드를 입력하세요."; await this.refresh(); return;
    }
    const entryPanel=this.panel;
    this.busy = true; this.error = undefined;
    try {
      await this.chat.setConnectionChanging(true);
      await this.refresh();
      const proxyUrl = vscode.workspace.getConfiguration("hypeproofChat").get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
      const result = await fetchProfileResult({ proxyUrl, token });
      if (!result.ok) { this.error = result.failure.friendly; return; }
      const p = result.profile;
      if (!p?.profile_id || !p.display_name || !p.ux?.coach || !p.welcome) {
        this.error = "수업 정보 응답을 읽지 못했습니다. 잠시 후 다시 연결하세요."; return;
      }
      if (!entryPanel || this.panel!==entryPanel) return;
      // Preview only. Existing runtime and credential stay bound until workspace preparation succeeds.
      this.candidate = { token, profile: p, proxyUrl, previousConnected: !!await this.chat.ensureProfile() };
    } catch {
      this.error = "수업에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.";
    } finally {
      this.busy = false; await this.chat.setConnectionChanging(false);
      await this.refresh();
    }
  }
}
