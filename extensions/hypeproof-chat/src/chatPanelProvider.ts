import {localRuntimeConfig,localModelSelection,runLocalCoach} from './localRuntime';
import { ActivityConnectionError, activityConnections } from './activityConnections';
import { emptyActivityDraft, validActivityDraft } from './activityDraft';
import { verifyActivity } from './proxyClient';
import { fetchAccessView, sendBudgetRequest, accessProfile, type AccessState } from './accessClient';
import { availableModelSelection, selectedModel, modelSelectionScope, type SavedModelChoice, selectedEffort, observedEffortResult, type SavedEffortChoice } from './modelSelection';
import { modelEchoVerdict, modelEchoNotice, describeModelEcho, type ModelEchoInput } from './modelEchoHelpers';
/** Everything except the part that changes per turn — `resolved` is filled in when the response arrives. */
type ModelEchoContext = Omit<ModelEchoInput, 'resolved'>;
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {createHash} from 'node:crypto';
import {NativeObservationRecorder} from './nativeObservationRecorder';
import {OBSERVATION_FORMATS, validateFindings, type ObservationBatch} from './nativeObservationContract';
import {acceptSubmit, learningEventRequest, learningState, type CompletionItem} from './learningStateHelpers';
import {observationHeaders} from './proxyClientHelpers.ts';
import { TOKEN_KEY, resolveWorkspaceRoot } from "./extension";
import { proxyChat, fetchProfileResult, ProxyAuthError, ProxyTransportError } from "./proxyClient";
import { TOKEN_MISSING_FRIENDLY, type ProfileFailure } from "./proxyClientHelpers";
import { runSdkCoach, SdkUnavailableError, type BrowserMcpHost } from "./sdkCoach";
import {
  coachSeatKeyFor,
  isAbortError,
  sdkToolToActionRequest,
  summarizeToolInput,
  withCoachSeatLock,
} from "./sdkCoachHelpers";
import { commandSignature, describeCommandForApproval } from "./shellPolicy";
import { extractTitle, galleryPublishAllowed, publishWorld, resolveSiteBase } from "./galleryPublish";
import { uploadSessionSnapshot } from "./spoolUploader";
import {
  originOfUrl,
  planCoachBrowserTabs,
  coachTabSlot,
  isSameBrowserUrl,
  resolveLivePreviewUrl,
  pickRevealTabIndex,
} from "./browserControlHelpers";

// #525 — a plain editor command registered in the core. The browser-only API cannot
// bring a tab to the front (BrowserTab has no show()/reveal()), so this path is used
// instead. `openEditorAtIndex` opens by 0-based index within the **active group**
// (core editorCommands.ts) — which is why activating the group comes first.
/** The `/1` key is kept byte-for-byte and only `/2` uses a different slot. See the comment above. */
const observationKey = (b: {format?: string; scope: string; program: string}) =>
  'hps.observation.'+(b.format === 'hps-observation/2' ? '2' : '1')+'.'+b.scope+'.'+b.program;

const FOCUS_FIRST_GROUP = "workbench.action.focusFirstEditorGroup";
const FOCUS_SECOND_GROUP = "workbench.action.focusSecondEditorGroup";
const OPEN_EDITOR_AT_INDEX = "workbench.action.openEditorAtIndex";
import { PreviewProvider, sanitizeQuestResult } from "./previewProvider";
import {
  matchWorldRef,
  isGuestListRequest,
  guestListMessage,
  WORLD_ARCHIVE_DIR,
  worldArchiveFileName,
  worldArchiveTitle,
  shouldArchiveWorld,
  worldEngineUrls,
  openWorldNotice,
  isWorldCohort,
  openWorldKeyForCohort,
} from "./chatPanelHelpers";
import {
  approvalCopyFor,
  approvalFallbackTitle,
  browserApprovalTitle,
  coachDegradedNotice,
  pageAttachedNotice,
  profileNotReadyNotice,
  shellApprovalTitle,
} from "./coachIdentity.ts";
import { CdpSession } from "./cdpSession";
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
  sdkFallbackLogLine,
  resolveCoachRuntime,
  classifyTurnError,
  pendingCloseLabel,
  WRITE_TOOL_NAMES,
} from "./chatPanelHelpers";
import { buildChatPanelCsp } from "./cspBuilder";
import {
  SessionSpool,
  spoolIdentityFromToken,
  traceMsgToWorkflowRecord,
  type SpoolArtifactSource,
} from "./sessionSpool";
import type { ProxyStreamUsage } from "./proxyClientHelpers";
import {
  ArtifactChangeGate,
  startHeartbeat,
  type HeartbeatPinger,
  type LivenessEvent,
} from "./heartbeat";

/**
 * Approval modal copy. It says in Korean what is about to happen, per `kind`, and the
 * confirm button is the verb of that action — `저장`/`위임` makes what is being
 * approved clearer than `Approve` does. Cancel is not written here: VS Code always
 * adds it.
 *
 * #747 — the titles live in `coachIdentity.approvalCopyFor(name)` and are built
 * from the resolved AI name (lesson-fixed, student-chosen, or "코치"). With the
 * default name they are byte-identical to the previous literals here.
 */


export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private effortNotice?: string;
  /** #897 H-13 — has the model-substitution notice already been attached to this turn? One turn per seat (REQ-M37 ③). */
  private modelNoticeTurn?: string;
  private effortScope?: string;
  private effortResult?: import('./protocol').ChatConfig['effortResult'];
  private effortTurn?: { id: string; url: string; token: string; scope: string };

  private async refreshEffortResult(): Promise<void> {
    const turn = this.effortTurn;
    if (!turn) return;
    let result: import('./protocol').ChatConfig['effortResult'] = {state:'unknown',requests:[]};
    try {
      const response = await fetch(`${turn.url.replace(/\/$/,'')}/request-settings/${encodeURIComponent(turn.id)}`, {
        headers:{authorization:`Bearer ${turn.token}`}, signal:AbortSignal.timeout(5000),
      });
      if (response.ok) {
        result = observedEffortResult(await response.json());
      }
    } catch { /* Retrieval cannot fail the conversation; unknown stays visible. */ }
    if (this.effortTurn !== turn || await this.context.secrets.get(TOKEN_KEY) !== turn.token) return;
    this.effortResult = result;
    await this.postConfig();
  }

  private nativeObservation: NativeObservationRecorder | null = null;
  private nativeHistoryScope: string | null = null;
  private accessState:AccessState|undefined;
  private accessScope:string|undefined;
  private accessCheckedAt=0;
  private accessLoad:Promise<void>|undefined;
  private async loadAccess(force=false):Promise<void>{
    const token=await this.context.secrets.get(TOKEN_KEY);
    const scope=token?createHash('sha256').update(token).digest('hex'):undefined;
    if(scope!==this.accessScope){this.accessScope=scope;this.accessState=undefined;this.accessCheckedAt=0;this.accessLoad=undefined;}
    if(!token)return;
    if(!force&&this.accessState&&Date.now()-this.accessCheckedAt<10000)return;
    if(this.accessLoad)return this.accessLoad;
    const proxy=vscode.workspace.getConfiguration('hypeproofChat').get<string>('proxyUrl','https://api.hypeproof-ai.xyz/v1');
    const selected=this.accessState?.selected;
    const pending=(async()=>{try{const view=await fetchAccessView(proxy,token);if(await this.context.secrets.get(TOKEN_KEY)===token)this.accessState={status:'ready',view,selected:this.accessState?.selected??selected};}
      catch{if(await this.context.secrets.get(TOKEN_KEY)===token)this.accessState={status:'unknown',selected,notice:'사용량 미확인 · 새로고침해 주세요.'};}
      finally{if(this.accessScope===scope){this.accessCheckedAt=Date.now();this.accessLoad=undefined;}}})();
    this.accessLoad=pending;return pending;
  }

  private profileGeneration=0;
  private nativeObservationError: string | null = null;
  private nativeLearningPath: {title:string;url:string;reason:string} | null = null;
  private observationAssessment: AbortController | null = null;
  private observationWrites: Promise<void> = Promise.resolve();
  /**
   * Puts the format into the storage key.
   *
   * The `/1` key is kept byte-for-byte (an existing saved batch still opens). `/2`
   * uses a different slot — sharing one slot would open a `/1`-saved batch in a `/2`
   * context, and `recordLearningEvent()` would then be blocked by
   * `observation_format`, leaving the state where **the configuration is right but
   * learning events just quietly stop accumulating**.
   */
  private async prepareObservation(proxyUrl: string, token: string | undefined, profile: ResolvedProfile | null) {
    await this.observationWrites;
    this.nativeObservation = null;
    // P1 — both `/1` and `/2` are accepted. Which one is used is the profile's call
    // (design §관측 이벤트와 필드: "the profile's observation.format decides which one is used").
    if (!OBSERVATION_FORMATS.includes(profile?.observation?.format as never) || !token) return null;
    try {
      // **P1 was still dead because this header was missing.** `/v1/profile` was
      // served `/2` while this one request went out without the header and got back a
      // `/1` context, so the recorder was built as `/1` and `currentLearningRecorder()`
      // stayed null forever. The client asks with one voice.
      const response = await fetch(proxyUrl.replace(/\/$/, '')+'/observations/context', {headers:observationHeaders(token),signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw Error('observation_unavailable');
      const context = await response.json() as Omit<ObservationBatch,'events'> & {learning_path?:{title:string;url:string;reason:string}};
      this.nativeLearningPath=context.learning_path??null;
      const key=observationKey(context);
      this.nativeObservation = new NativeObservationRecorder(context, this.context.workspaceState.get(key));
      this.nativeObservationError=null;
      return this.nativeObservation;
    } catch { this.nativeObservationError='관찰 기록을 연결하지 못했습니다. 기존 작업은 계속할 수 있습니다.'; return null; }
  }
  private persistObservation(recorder: NativeObservationRecorder) {
    const value=recorder.snapshot(), key=observationKey(value);
    this.observationWrites=this.observationWrites.then(async()=>{await this.context.workspaceState.update(key,value);}).catch(()=>{this.nativeObservationError='관찰 기록 저장에 실패했습니다.';});
  }
  /** Drawer D is open. A view state, so it is never used in a verdict. */
  private learningDrawerOpen = false;

  /** Learning events are made only on a connection using `/2`. Otherwise null, and region D is not drawn. */
  private async currentLearningRecorder(): Promise<NativeObservationRecorder | null> {
    const token = await this.context.secrets.get(TOKEN_KEY);
    const proxy = vscode.workspace.getConfiguration('hypeproofChat').get<string>('proxyUrl','https://api.hypeproof-ai.xyz/v1');
    const recorder = await this.prepareObservation(proxy, token, await this.ensureProfile());
    return recorder?.batch.format === 'hps-observation/2' ? recorder : null;
  }

  /**
   * Design §과제 흐름 상태 기계 — `task-<first 16 chars of the module sha256>-<first 8
   * chars of the activity id>`. Two tasks are never merged just because they share a
   * folder (MC-08).
   */
  private learningTaskId(lessonSha: string | undefined, activityId: string | undefined) {
    return 'task-' + String(lessonSha ?? '').slice(0,16) + '-' + String(activityId ?? '').slice(0,8);
  }

  /**
   * The completion conditions. When the session design declares none it is an **empty
   * list**, and that fact travels all the way to the screen as
   * `learningState.declared=false`. No default is invented here.
   */
  private learningCompletion(profile: ResolvedProfile | null): CompletionItem[] {
    const rows = profile?.lesson?.content?.learning?.completion ?? [];
    return rows.map(r => ({ id: r.id, event: r.event as CompletionItem['event'], label: r.text }));
  }

  /**
   * Uses the step id the webview sent, but **only after checking it**. A step that is
   * not part of this lesson falls back to the first step — if the webview's string
   * were stored straight into `context.step_id`, there would later be no way to tell
   * which step the evidence belongs to.
   */
  private learningStep(profile: ResolvedProfile | null, wanted: string | undefined) {
    const steps = profile?.lesson?.content?.steps ?? [];
    return steps.find(s => s.id === wanted) ?? steps[0];
  }

  /** The learning state the host computes and sends down to the webview. Never stored; computed every time. */
  private async postLearningState() {
    const recorder = await this.currentLearningRecorder();
    if (!recorder) return;
    const profile = await this.ensureProfile();
    const task = this.learningTaskId(profile?.lesson?.sha256, activityConnections(this.context)?.current?.id);
    await this.post({
      type: 'learningState',
      state: learningState({
        task,
        events: recorder.batch.events,
        completion: this.learningCompletion(profile),
      }),
    });
  }

  private view?: vscode.WebviewView;
  private editorChat?: vscode.WebviewPanel;
  private activeStreams = new Map<string, AbortController>();
  // A send owns its activity before its first authentication await, through persistence.
  private pendingSends = 0;
  /**
   * #503 — the single timeline of the in-flight turn (per stream id). It is built with
   * the **same pure reducer** the webview draws with and persisted exactly as it is.
   * Two sets of rules would mean a different order once the window is reopened.
   */
  private turnTimelines = new Map<string, TimelineState>();
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  /**
   * #476 — has the participant ever been told about the agent-sdk → proxy fallback
   * (once per session)?
   *
   * Why it is not attached every turn: the fallback keeps happening on that machine
   * (without the seed the next turn is the same). The same warning every turn means
   * nobody reads it from the second one on, and the conversation record gets buried
   * under warnings. Losing a capability is a state, not an event.
   */
  private fallbackNoticeShown = false;
  /** #596 — has the session-end upload banner already been shown this activation (toast-spam guard)? */
  private sessionEndUploadOffered = false;
  /**
   * #476 — the developer-facing diagnostic channel. The fallback used to be a single
   * `console.warn`, but the extension had `createOutputChannel` **nowhere at all**, so
   * that line survived nowhere: on the day of the incident, the string `[coach]`
   * appeared 0 times across every session's `exthost.log`. In other words there was no
   * way, after the fact, to check "did this classroom run on the proxy?".
   */
  private logChannel: vscode.OutputChannel | null = null;
  /**
   * #897 (VO-01) — the voice capability probe in flight. One per command, cleared when
   * a response arrives or it times out. With no webview, or one that does not answer,
   * this has to end as **not measured** (it must not be written down as blocked), so
   * null is returned here.
   */
  private voiceProbes = new Map<string, (o: import("./voiceCapabilityHelpers").VoiceProbeObservations) => void>();

  /** The surface the diagnostic command uses. With the webview closed it returns null, leaving it as not measured. */
  async probeVoiceCapability(
    timeoutMs: number,
  ): Promise<import("./voiceCapabilityHelpers").VoiceProbeObservations | null> {
    if (!this.view) return null;
    const probeId = randomId();
    const observations = new Promise<import("./voiceCapabilityHelpers").VoiceProbeObservations | null>((resolve) => {
      this.voiceProbes.set(probeId, resolve);
      setTimeout(() => {
        if (this.voiceProbes.delete(probeId)) resolve(null);
      }, timeoutMs);
    });
    void this.post({ type: "probeVoiceCapability", probeId });
    return observations;
  }

  /** The output channel — where a diagnosis leaves its verdict. Same channel as the fallback notice (#476). */
  voiceLogChannel(): vscode.OutputChannel {
    this.logChannel ??= vscode.window.createOutputChannel("HypeProof Coach");
    return this.logChannel;
  }
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
   * Origins the participant pressed "이 사이트는 항상 허용" on. The same discipline as
   * the shell signatures — session-scoped, never persisted. It is per origin, so a
   * different site is asked again.
   */
  private readonly approvedBrowserOrigins = new Set<string>();
  /** #457 — the CDP executor for the SDK path's inspection tools. Created on first use. */
  private mcpBrowser?: BrowserControl;
  // Stashed for the bug-report flow (#64). Updated whenever a stream errors
  // or completes — the Worker's request-id middleware (PR #49) plumbs an
  // x-request-id header on every response we can correlate against in tail.
  private lastRequestId: string | undefined;
  /**
   * Task E (docs/plan/dag.yaml) — liveness. `lastActivityAt` is bumped by any
   * webview message; the pinger turns it into an idle_ms the instructor board
   * can read. Deliberately NOT tied to the chat path: a seat that is reading,
   * and a seat whose app died, are the two cases the board must tell apart.
   */
  private lastActivityAt = Date.now();
  private heartbeat: HeartbeatPinger | null = null;
  private readonly artifactGate = new ArtifactChangeGate();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly preview: PreviewProvider,
    private readonly liveServer: LiveServer,
    /** #580 — the local session-log spool. Optional: tests and older callers run without recording. */
    private readonly spool?: SessionSpool,
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
    this.postPageNotice(pageAttachedNotice(this.coachDisplayName(), withShot, ctx.title || ctx.url));
  }

  /**
   * kids-quest — a skeleton round ended (`hp:result`). Stash a one-line summary
   * for the NEXT turn so the coach can react in the guest's voice to what the
   * kid actually did, instead of guessing. Same consume-once channel as
   * attachPageContext (#278): history keeps the kid's clean text; only the
   * model sees the prepended line. Retries overwrite — the last round is the
   * one the kid is talking about — but the attempt count is kept so "got it on the
   * 3rd try" is visible to the coach.
   */
  attachQuestResult(result: Record<string, unknown>): void {
    const ok = result.ok === true;
    const attempts = ++this.questAttempts;
    if (ok) this.questAttempts = 0;
    const kv = Object.entries(result)
      .filter(([k]) => k !== "ok")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    this.pendingPageContext =
      `[게스트 결과] ${ok ? "성공" : "실패"} · ${kv}` +
      (attempts > 1 ? ` · ${attempts}번째 시도` : "") +
      `\n위 결과를 게스트 목소리로 한 줄 반응한 뒤 아이에게 넘겨줘. 결과에 없는 숫자는 지어내지 마.`;
    this.pendingPageImage = null;
    // 2026-08-19 on a real device — the notification copy ("친구가 해봤어요 — 아직")
    // is noise to the child. The child just played it and already knows the result;
    // the guest reacting in the next message is enough. Attached quietly to the next
    // turn only, with no notification.
  }
  /** Rounds since the last success (a success resets it). */
  private questAttempts = 0;
  /** JSON of the last pulled `__hpLast` — so a round is folded in once. */
  private lastPulledQuestResult = "";

  /**
   * kids-quest, live_server path — the skeleton runs in the native browser tab
   * (no parent window, so `hp:result` postMessage has nowhere to go). Every
   * skeleton also leaves the last round on `window.__hpLast`; pull it over CDP
   * right before a turn goes out. Cheap (one Runtime.evaluate) and pull-based,
   * so "됐어?" always sees the freshest round. Silent on any failure — a
   * missing result just means the coach says "한번 해보고 알려주세요".
   */
  private async pullQuestResultFromPreview(): Promise<void> {
    if (this.cachedProfile?.game?.template_tier !== "kids-quest") return;
    const tabs = vscode.window.browserTabs ?? [];
    const tab =
      this.mcpBrowser?.currentTab() ??
      tabs.find((t) => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(t.url ?? "")) ??
      vscode.window.activeBrowserTab;
    if (!tab) return;
    let json = "";
    try {
      const session = await CdpSession.attach(tab);
      try {
        const res = await session.send(
          "Runtime.evaluate",
          { expression: "JSON.stringify(window.__hpLast || null)", returnByValue: true },
          3_000,
        );
        json = typeof res?.result?.value === "string" ? res.result.value : "";
      } finally {
        await session.close();
      }
    } catch {
      return;
    }
    if (!json || json === "null" || json === this.lastPulledQuestResult) return;
    this.lastPulledQuestResult = json;
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { return; }
    this.attachQuestResult(sanitizeQuestResult(parsed));
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

  /**
   * Just before the lesson log is sealed, leave the work folder's real index.html as
   * the last piece of evidence. If the child edited the file by hand after the last
   * AI response, that change disappears when only the chat text is kept. A failure or
   * a missing file is a fail-soft path that never blocks the upload itself.
   */
  async captureFinalArtifactForSpool(): Promise<boolean> {
    if (!this.spool?.currentSessionDir()) return false;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return false;
    try {
      const target = vscode.Uri.joinPath(root, "index.html");
      const bytes = await vscode.workspace.fs.readFile(target);
      const content = Buffer.from(bytes).toString("utf8");
      if (!/<html[\s>]/i.test(content) && !/<!doctype html/i.test(content)) return false;
      this.spool.recordArtifactSnapshot({
        source: "session_end",
        path: "index.html",
        content,
      });
      return true;
    } catch {
      return false;
    }
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

    const sidebarWebview=view.webview;
    view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg, view.webview));
    view.onDidDispose(() => {
      if (this.draftSource===sidebarWebview) this.draftSource=undefined;
      if (this.view === view) this.view = undefined;
      if (!this.editorChat) abortAllStreams(this.activeStreams);
    });
  }

  /** Hand the entry canvas to the conversation instead of leaving a landing
   * page beside a narrow sidebar. The same provider owns auth, history and tools. */
  async openInEditor(entry: vscode.WebviewPanel): Promise<void> {
    if (this.editorChat) {
      this.editorChat.reveal(vscode.ViewColumn.One);
      if (entry !== this.editorChat) entry.dispose();
    } else {
      this.editorChat = entry;
      entry.title = 'AI와 작업';
      const dist = vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'dist');
      entry.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg, entry.webview));
      const editorWebview=entry.webview;
      entry.onDidDispose(() => {
        if(this.draftSource===editorWebview)this.draftSource=undefined;
        if (this.editorChat === entry) {
          this.editorChat = undefined;
          abortAllStreams(this.activeStreams);
        }
      });
      entry.webview.html = this.renderHtml(entry.webview, dist);
      entry.reveal(vscode.ViewColumn.One);
    }
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
  }

  focusEditor(): boolean {
    if (!this.editorChat) return false;
    this.editorChat.reveal(vscode.ViewColumn.One);
    return true;
  }

  private connectionChanging = false;
  private draftWrites: Promise<void> = Promise.resolve();
  private draftSource?: vscode.Webview;
  private draftFlush?: {nonce:string;source:vscode.Webview;resolve:()=>void;reject:(e:Error)=>void};
  async setConnectionChanging(value: boolean): Promise<void> {
    this.connectionChanging = value;
    if (!activityConnections(this.context)) return;
    await this.post({type:'activityFreeze',frozen:value});
    if (!value) return;
    const source=this.draftSource;
    if (source) {
      const nonce=crypto.randomUUID();
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{this.draftFlush=undefined;reject(new Error('입력 저장을 확인하지 못했습니다. 활동을 유지하고 다시 시도해 주세요.'));},8000);
        this.draftFlush={nonce,source,resolve:()=>{clearTimeout(timer);this.draftFlush=undefined;resolve();},reject:e=>{clearTimeout(timer);this.draftFlush=undefined;reject(e);}};
        void source.postMessage({type:'activityFreeze',frozen:true,nonce,activityId:activityConnections(this.context)?.scope});
      });
    }
    await this.draftWrites;
  }

  hasActiveStream(): boolean { return this.pendingSends > 0 || this.activeStreams.size > 0 || !!this.worldOpening || !!this.observationAssessment || (this.pendingApprovals?.size ?? 0) > 0; }

  refreshConfig() {
    void (async () => {
      await this.postConfig();
      await this.postHistory();
    })();
  }

  private clearingHistory = false;
  async clearHistory(): Promise<void> {
    if (this.clearingHistory || this.hasActiveStream()) return;
    this.clearingHistory = true;
    const key = this.historyKey();
    try {
      const choice = await vscode.window.showWarningMessage(
        "이 대화 기록을 지울까요?",
        { modal: true, detail: "채팅 기록은 되돌릴 수 없습니다. 작업 파일과 내 작업 돌아보기의 관찰 기록은 그대로 남습니다." },
        "대화 지우기",
      );
      if (choice !== "대화 지우기" || this.hasActiveStream() || key !== this.historyKey()) return;
      await this.context.workspaceState.update(key, []);
      void this.post({ type: "history", messages: [] });
      // A cleared chat starts a new conversation, not a new trial allowance.
      void this.post({ type: "aiDisclosure", text: this.aiDisclosure.noticeForHistoryClear() });
    } finally { this.clearingHistory = false; }
  }

  /** Force re-fetch on next config push (e.g. after token change). */
  invalidateProfile(): void {
    this.profileGeneration++;
    this.observationAssessment?.abort();
    this.nativeObservation=null;
    this.nativeLearningPath=null;
    this.cachedProfile = null;
    this.profileFetchPromise = null;
    this.lastProfileFailure = null;
    this.activeCohortId = null;
    this.nativeHistoryScope = null;
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
  async ensureProfile(forceRefresh = false): Promise<ResolvedProfile | null> {
    if (forceRefresh) {
      await this.profileFetchPromise;
      this.cachedProfile = null;
    }
    const connections=activityConnections(this.context);
    if (connections && !connections.matchesService) return null;
    if (this.cachedProfile) return this.cachedProfile;
    if (this.profileFetchPromise) return this.profileFetchPromise;

    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    const proxyUrl = cfg.get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (!token) {
      this.lastProfileFailure = null;
      return null;
    }

    const generation=this.profileGeneration;
    this.profileFetchPromise = fetchProfileResult({ proxyUrl, token }).then(
      async (r) => {
        if(generation!==this.profileGeneration || await this.context.secrets.get(TOKEN_KEY)!==token)return null;
        // #381 — remember WHY, so the token-entry flow can say something the
        // participant can act on instead of one generic "확인이 안 돼요".
        this.lastProfileFailure = r.ok ? null : r.failure;
        let p = r.ok ? r.profile : null;
        if (connections?.current && p) {
          if (p.activity_id!==connections.current.serverId) p=null;
          else p={...p,workspace_root:connections.current.workspace};
        }
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
        this.nativeHistoryScope=(p?.access_identity?.kind==='account')?p.access_identity.scope:(p?.observation||this.activeCohortId==='studio-native-trial')?'native-'+(p?.observation?.scope??createHash('sha256').update(token).digest('hex')):null;
        // Task E — a resolved profile means we have a usable token; start the
        // chat-independent ping. Failures back off inside the pinger.
        if(p?.access_identity?.kind!=='account')this.startLiveness();else this.stopLiveness();
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
   * #747 — the AI's display name for THIS seat: the lesson/cohort-fixed name
   * (ux.coach fixed precedence, #140 / ADR-0005), else the student's stored
   * name, else "코치". Every host-side sentence that names the AI (approval
   * modals, degraded notice, page-attach notice, start page) uses this, so a
   * lesson called "제작 파트너" is "제작 파트너" everywhere, not only in the header.
   */
  coachDisplayName(profile: ResolvedProfile | null = this.cachedProfile): string {
    return resolveCoach(this.getCoach(), profile).name;
  }

  /**
   * #747 — true when the displayed name was actually chosen: fixed by the
   * cohort/lesson, or named by this student. False means a `user_names_it`
   * seat that has not been through the naming step, where the start page
   * should describe the mode instead of showing the placeholder as a name.
   */
  coachNameIsChosen(profile: ResolvedProfile | null = this.cachedProfile): boolean {
    return profile?.ux.coach.naming_mode === "fixed" || this.getCoach().configured;
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

  // ── Task E — liveness (heartbeat + artifactChanged) ───────────────────────

  /**
   * POST one liveness event to the worker. Never throws and never surfaces to
   * the participant: telemetry that can interrupt a kid mid-turn is worse than
   * telemetry that is missing.
   *
   * `x-hps-client-version` is what lets the instructor board say "this seat is
   * still on last week's build". It is optional on the worker side on purpose —
   * the worker deploys in 30 seconds, the app takes 1–2 hours plus a reinstall,
   * so an old client sending none of this is the normal path.
   */
  private async postLivenessEvent(
    ev: LivenessEvent,
  ): Promise<{ ok: boolean; status: number }> {
    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    const proxyUrl = cfg.get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
    const token = await this.context.secrets.get(TOKEN_KEY);
    // No token yet (the participant hasn't pasted one) is TRANSIENT, not a
    // rejection — status 0 makes the pinger back off and retry rather than
    // stopping for good.
    if (!token) return { ok: false, status: 0 };
    const version = this.context.extension?.packageJSON?.version;
    try {
      const res = await fetch(`${proxyUrl.replace(/\/$/, "")}/trace/event`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(typeof version === "string" && version ? { "x-hps-client-version": version } : {}),
        },
        body: JSON.stringify(ev),
      });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  /** Start the 45 s ping. Idempotent — a second call is a no-op. */
  startLiveness(): void {
    if (this.heartbeat) return;
    this.heartbeat = startHeartbeat({
      send: (ev) => this.postLivenessEvent(ev),
      idleMs: () => Date.now() - this.lastActivityAt,
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      log: (line) => this.logChannel?.appendLine(line),
      onStopped: () => {
        this.heartbeat = null;
      },
    });
    this.context.subscriptions.push({ dispose: () => this.stopLiveness() });
  }

  stopLiveness(): void {
    const h = this.heartbeat;
    this.heartbeat = null;
    h?.stop(); // onStopped nulls the field too — idempotent either way.
  }

  /**
   * Report that the participant's artifact changed — a digest and a length,
   * nothing else. Silent when the bytes are identical to the last report
   * (see ArtifactChangeGate).
   */
  private emitArtifactChanged(content: string): void {
    const ev = this.artifactGate.next(content);
    if (!ev) return;
    void this.postLivenessEvent(ev);
  }

  private async saveGameToWorkspace(html: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    try {
      const root = folders[0].uri;
      const target = vscode.Uri.joinPath(root, "index.html");
      await vscode.workspace.fs.writeFile(target, Buffer.from(html, "utf8"));
      // Task E — "the coach ran for four minutes; did anything change?"
      this.emitArtifactChanged(html);
    } catch {
      // Non-fatal: preview still works even if the save fails.
    }
  }

  /**
   * #476 — records the agent-sdk → proxy fallback for **three audiences**.
   *
   * 1. The developer — a dedicated output channel. The previous `console.warn` left
   *    nothing even in `exthost.log`, because the extension had `createOutputChannel`
   *    nowhere at all; on the day of the incident the string `[coach]` appeared 0
   *    times across every session. Checking after the fact was simply impossible. The
   *    raw reason is carried verbatim — the `SdkUnavailableError` message already
   *    lists the 4 candidate interpretations.
   * 2. The participant — one line in the conversation timeline (once per session). It
   *    says both what no longer works and what does.
   * 3. The instructor — no separate channel was built. That one line on the student's
   *    screen is the real thing an instructor walking the room can see, and it stays
   *    in the conversation record (REQ-C17), so it is visible after the fact too.
   *    Signalling the worker as well, to see it per classroom in `/console`, is left
   *    as separate work.
   *
   * Telling the coach itself is the **worker's** job — `degradedRuntimeNoticeFor`
   * (translate.ts). The runtime's ground truth is the route and the prompt's owner is
   * the worker, so it lands with a deploy and needs no app release.
   */
  private noteSdkFallback(reason: string, streamId: string): void {
    this.logChannel ??= vscode.window.createOutputChannel("HypeProof Coach");
    this.logChannel.appendLine(sdkFallbackLogLine(reason, new Date()));

    // Once per session. The fallback keeps happening on that machine (without the
    // seed the next turn is the same), so attaching it every turn means nobody reads
    // it from the second one on and the record gets buried under warnings.
    if (this.fallbackNoticeShown) return;
    this.fallbackNoticeShown = true;
    this.postToolLog(streamId, {
      id: randomId(),
      icon: "⚠️",
      label: coachDegradedNotice(this.coachDisplayName()),
      state: "error",
    });
  }

  /**
   * #421 — saves a pasted image as a real file under `<work folder>/assets/`.
   *
   * Its relation to the approval gate (the item the issue asked to confirm): this is
   * **not a write the model requested — it is the host keeping material the
   * participant just attached themselves**. Two precedents of the same kind already
   * exist — `saveGameToWorkspace` (index.html) and `saveAgentMdIfPresent` (agent.md).
   * `resolveActionApproval`, which raises the modal, is the gate for
   * **model-originated actions** (writeFile/executeShell), and the core of that
   * policy — "refuse an absolute path outside the workspace" — holds structurally
   * here: the path is assembled only from `resolveCoachCwd()` + a fixed subfolder +
   * an extension taken from the mime type, and the filename rides on neither the
   * participant's nor the model's string (#421 · REQ-C10~C13).
   *
   * A failure is not swallowed — if the save did not happen but the coach alone
   * believes it "is there", we are back to the original symptom. In that case the
   * note is emptied (the coach treats it as absent, as before) and one line is left
   * for the participant.
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
        // When the same index within the same second already exists, walk the name
        // up until a free slot is found. Overwriting would silently lose a photo the
        // participant pasted earlier.
        let name = pastedImageName(at, i + 1, parsed.ext);
        for (let dedupe = 1; dedupe <= 20; dedupe++) {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, name));
          } catch {
            break; // stat failed = not there = this name is free
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
  /**
   * **Before** a new world is written to index.html, archive the current one as
   * '이전 세상/<title>.html'.
   *
   * 2026-08-20 (#649) — it used to skip the whole thing when
   * `lastPrebuiltWorld === nextId`. That rule caused a real incident: "water instead
   * of fire in 초코's world" fetched 초코's world again, and because it was the same
   * world the archive was skipped and the index.html the child had spent a long time
   * editing was overwritten. The criterion is now **content**, not id — if the
   * current file differs from the HTML about to be written, it is always archived,
   * even when the same world was clicked again. A failed archive does not block
   * opening the world (the child's screen comes first).
   */
  private async archiveCurrentWorld(nextHtml: string, streamId?: string): Promise<string | null> {
    const cwd = this.resolveCoachCwd();
    if (!cwd) return null;
    let html: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cwd, "index.html")));
      html = Buffer.from(bytes).toString("utf8");
    } catch {
      return null; // no file means there is nothing to archive
    }
    if (!shouldArchiveWorld(html, nextHtml)) return null;
    try {
      const dir = vscode.Uri.file(path.join(cwd, WORLD_ARCHIVE_DIR));
      await vscode.workspace.fs.createDirectory(dir);
      let taken: string[] = [];
      try {
        taken = (await vscode.workspace.fs.readDirectory(dir)).map(([name]) => name);
      } catch {
        /* the empty folder we just created */
      }
      const name = worldArchiveFileName(worldArchiveTitle(html), taken);
      // 2026-08-20 review — putting the source in as-is means the archived copy
      // **does not open**: a world's HTML calls `<script src="engine.js">` by relative
      // path, and since it is saved under '이전 세상/' it went looking for
      // `이전 세상/engine.js` → 404 → S_* ReferenceError → a black screen. On top of
      // that the engine now differs per world (#644) — keeping one copy in the folder
      // is not enough either. So the archived copy **inlines** that world's engine and
      // is complete in itself.
      const body = await this.inlineEngineIfNeeded(html);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(cwd, WORLD_ARCHIVE_DIR, name)),
        Buffer.from(body, "utf8"),
      );
      // An archive that happens silently is the same as no archive — the child does
      // not know a backup was made and asks "where did the one from before go?". An
      // archive that happened inside a turn leaves one line.
      if (streamId) {
        this.postToolLog(streamId, {
          id: randomId(),
          icon: "📦",
          label: `고치던 세상을 「${WORLD_ARCHIVE_DIR}」 폴더에 넣어 뒀어요 — ${name}`,
          state: "done",
        });
      }
      return name;
    } catch (e) {
      console.warn(`[world] 이전 세상 보관 실패: ${String(e).slice(0, 120)}`);
      return null;
    }
  }


  /**
   * "갤러리에 올리기" — sends the current world to the lab gallery.
   *
   * ## What is uploaded
   *
   * Not the last HTML on the chat screen but **the work folder's `index.html`**. The
   * child also edits the file directly without going through the coach (that is one
   * of this lesson's goals), and what was edited that way is what has to go up.
   * `engine.js` is inlined to make it **one single page** — the gallery takes exactly
   * one file, and the relative `<script src="engine.js">` 404s there
   * (`archiveCurrentWorld` does the same thing for the same reason).
   *
   * ## Whose it is is NOT decided here
   *
   * Only the token is sent. The name and seat number are looked up by the server on
   * the distribution board — the child never retypes their own name, and there is no
   * room to write someone else's.
   *
   * ## Failures are not swallowed
   *
   * It is a button pressed explicitly, so the result has to be visible on screen. The
   * Korean sentence the server produced is handed to the webview as it is
   * (`publishResult`). A VS Code toast is not used because the integrated browser
   * stops on a notification (the same reason as #308).
   */
  private async publishToGallery(): Promise<void> {
    const fail = (message: string) =>
      void this.post({ type: "publishResult", state: "error", message });

    // #748 — the profile owns the publishing policy. This check comes **before** the
    // world / token / folder ones: a seat that is not permitted must not be handed a
    // next-step hint like "open a world first". That reads as something that would
    // work if they did it.
    const allowed = galleryPublishAllowed(this.cachedProfile?.publishing);
    if (!allowed.ok) return fail(allowed.message);

    const worldId = this.lastPrebuiltWorld;
    if (!worldId) return fail("먼저 친구를 눌러 세상을 열어주세요.");

    const token = await this.context.secrets.get(TOKEN_KEY);
    if (!token) return fail(TOKEN_MISSING_FRIENDLY);

    const cwd = this.resolveCoachCwd();
    if (!cwd) return fail("작업 폴더를 찾지 못했어요.");

    let html: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cwd, "index.html")));
      html = Buffer.from(bytes).toString("utf8");
    } catch {
      return fail("아직 만든 세상이 없어요.");
    }

    void this.post({ type: "publishResult", state: "uploading" });

    const body = await this.inlineEngineIfNeeded(html);
    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    // The spool session directory's name IS the session_id (sessionSpool builds it
    // that way). Null when the spool is off — publishing still goes ahead. Getting the
    // work itself up comes before keeping the logs joined up.
    const sessionDir = this.spool?.currentSessionDir() ?? null;
    const sessionId = sessionDir ? path.basename(sessionDir) : null;

    const result = await publishWorld({
      siteBase: resolveSiteBase(cfg.get<string>("siteBase")),
      token,
      worldId,
      title: extractTitle(body),
      html: body,
      sessionId,
    });

    if (!result.ok) {
      console.error(`[gallery] 발행 실패 (${result.status}): ${result.message}`);
      return fail(result.message);
    }
    void this.post({ type: "publishResult", state: "done", url: result.url });

    // Publish succeeded → upload a log snapshot of the in-flight session **without
    // sealing it** (2026-08-21, operations decision: guardian pre-survey consent
    // secured). The "this far" at publish time survives on the server, so the raw
    // material for the report is secured even when the child misses "기록 보내기" at
    // the end of the lesson. No manifest is uploaded, so it is incomplete — the
    // complete upload at the end of the lesson overwrites the same key and becomes
    // canonical (the header comment on uploadSessionSnapshot is the canonical one).
    //
    // fire-and-forget: the game is already up. A snapshot failure is not put on the
    // child's screen — it goes to the console only, and the complete-upload path
    // overwrites it anyway.
    if (sessionDir && sessionId && this.cachedProfile?.analytics?.upload_session_logs === true) {
      const day = path.basename(path.dirname(sessionDir));
      const proxyUrl = cfg.get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
      void uploadSessionSnapshot({
        session: { dir: sessionDir, day, sessionId },
        baseUrl: proxyUrl,
        token,
      }).then((r) => {
        console.log(
          r.ok
            ? `[gallery] 로그 스냅샷 업로드 완료 (${r.keys.length}개 파일)`
            : `[gallery] 로그 스냅샷 실패 (${r.failedAt}: ${r.message}) — 수업 끝 완결 업로드가 대신한다`,
        );
      });
    }
  }

  /** Saves engine.js into the work folder (beside the world HTML). A failure is rescued by the preview's inlining. */
  private async saveEngineToWorkspace(js: string): Promise<void> {
    const cwd = this.resolveCoachCwd();
    if (!cwd) return;
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(cwd, "engine.js")), Buffer.from(js, "utf8"));
    } catch { /* the fallback rescues it by inlining */ }
  }

  /** For the srcdoc fallback — replaces `<script src="engine.js">` with the file's contents. */
  private async inlineEngineIfNeeded(html: string): Promise<string> {
    if (!html.includes('<script src="engine.js"></script>')) return html;
    const cwd = this.resolveCoachCwd();
    if (!cwd) return html;
    try {
      const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cwd, "engine.js")));
      return html.replace('<script src="engine.js"></script>', `<script>\n${Buffer.from(buf).toString("utf8")}\n</script>`);
    } catch {
      return html;
    }
  }

  /** Debounce timer for consecutive saves (preview once, after the last save). */
  private revealTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The id of the pre-built world currently on screen. Since #649 it does NOT mean
   * "do not fetch it again" (re-clicking the same world fetches it again, archiving
   * first) — it is used to restore the friend strip's highlight when the webview
   * remounts.
   */
  private get lastPrebuiltWorld(): string | null {
    return this.context.workspaceState.get<string>(openWorldKeyForCohort(this.activeCohortId), "") || null;
  }
  /**
   * 2026-08-20 review — while this was an in-memory field, reopening the window
   * (Reload Window, or closing and reopening the laptop) left index.html holding the
   * world the child had edited while the app alone went back to "no world open": the
   * strip highlight disappeared, the runner ran as ✨, and the world notice on the
   * first send after a Clear never attached again. The value is a single id, so
   * storing it costs nothing.
   */
  private set lastPrebuiltWorld(id: string | null) {
    void this.context.workspaceState.update(openWorldKeyForCohort(this.activeCohortId), id ?? undefined);
  }

  /** revealPrebuiltWorld re-entry guard — a child's rapid clicking must not overlap index.html writes. */
  private worldOpening = false;

  /** The name of the file archived this time (if any). Used to tell the coach "what to roll back to is here". */
  private lastArchivedWorldFile: string | null = null;

  /**
   * 2026-08-19 — fetches the worker's pre-built world (GET /v1/worlds/:id) and shows
   * it through revealBuilt. False on failure — the coach then builds it itself as
   * before (slow, but it works).
   */
  private async revealPrebuiltWorld(id: string, proxyUrl: string, token: string): Promise<boolean> {
    // 2026-08-20 review — when a child hammers the friend buttons (초코, then 나비
    // within a second) this function ran overlapped and the archive and the index.html
    // write raced. It is blocked in two layers, together with the webview's pending
    // guard — the second call opens no world and is passed on as a coach turn.
    if (this.worldOpening) return false;
    this.worldOpening = true;
    try {
      const base = proxyUrl.replace(/\/$/, "");
      const res = await fetch(base + "/worlds/" + encodeURIComponent(id), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const html = await res.text();
      if (!/<!doctype html/i.test(html)) return false;
      // #629 — a world's HTML calls the engine with <script src="engine.js">. It has
      // to be saved into the same folder first for the live server to serve it 200.
      //
      // #644 (2026-08-20, real device) — **that world's own engine** is fetched first
      // now. The shared copy carries all 9 worlds' sprites (S_PENG penguin, S_ICE
      // ice…), so one read by the coach produced ice talk in 초코's world. A per-world
      // engine holds only that world's art, so there is nothing to bleed even if it is
      // read. On a 404 or a failure it falls back to the shared one — with no engine
      // the screen does not come up at all, and that is worse than contamination.
      //
      // 2026-08-20 review — this used to carry on **even when both candidates
      // failed**. Then index.html alone became the new world while engine.js was the
      // previous world's (or missing entirely), so the S_* constants the new HTML
      // calls were undefined → ReferenceError → a black screen — while the coach was
      // told "it is already up" (this is exactly the path when the classroom wifi
      // drops). So the engine is secured **first**, and when it cannot be fetched the
      // child's files are left untouched and false is returned, handing over to the
      // coach-generation path — slow, but the screen does come up.
      let engineJs: string | null = null;
      for (const url of worldEngineUrls(base, id)) {
        try {
          const eng = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
          if (!eng.ok) continue;
          engineJs = await eng.text();
          break;
        } catch {
          /* on to the next candidate (the shared one) — throwing here means the world never opens */
        }
      }
      if (!engineJs) return false;
      // Swapping the engine and writing index.html are one unit, so revealBuilt owns
      // the whole ordering: archive the old world (inlining the engine.js of that
      // moment) → save the new engine → save the new index.html. Swapping the engine
      // in here first would inline **the NEXT world's** engine into the archived copy
      // and misalign its sprites, and if the structure guard then blocks, index.html
      // is left on the old world while engine.js alone is the new one.
      const ok = await this.revealBuilt(html, { artifactSource: "prebuilt", engineJs });
      if (!ok) return false;
      this.lastPrebuiltWorld = id;
      // Tell the webview so its friend strip can highlight the currently open world (#649).
      const w = this.cachedProfile?.worlds?.find((x) => x.id === id);
      void this.post({ type: "worldOpened", id, guest: w?.guest ?? "", emoji: w?.emoji ?? "" });
      return true;
    } catch {
      return false;
    } finally {
      this.worldOpening = false;
    }
  }

  /**
   * 2026-08-19 — shows the .html the SDK coach saved with Write/Edit in the preview.
   * It reads the file and hands it to revealBuilt (exactly the same save/reveal
   * behaviour as the fence path). A missing file, or one that is not HTML, is passed
   * over silently — so that the coach's next utterance does not stand in for the
   * screen, a failure leaves only one tool-log line.
   */
  private async revealWrittenHtml(filePath: string, streamId?: string): Promise<void> {
    try {
      const abs = path.isAbsolute(filePath) ? filePath : path.join(this.resolveCoachCwd() ?? "", filePath);
      const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
      const html = Buffer.from(buf).toString("utf8");
      if (!/<html[\s>]/i.test(html) && !/<!doctype html/i.test(html)) return;
      await this.revealBuilt(html, { streamId, artifactSource: "assistant_tool" });
    } catch (e) {
      if (streamId) {
        this.postToolLog(streamId, { id: randomId(), icon: "🖼️", label: `미리보기 열기 실패: ${String(e).slice(0, 80)}`, state: "error" });
      }
    }
  }

  async revealBuilt(
    html: string,
    opts?: {
      streamId?: string;
      /** #580 — for callers that leave the UI alone and need only spool attribution (the browser loop). */
      spoolTurnId?: string;
      /** Distinguishes a pre-built copy from the student's/AI's edited one, even for identical HTML. */
      artifactSource?: SpoolArtifactSource;
      /**
       * The world engine paired with this HTML (#644). When given, it is swapped in
       * **after the archive and just before the save** — reverse the order and the
       * archived copy gets the NEXT world's engine, and when the structure guard
       * blocks, index.html (old world) and engine.js (new world) are left mismatched.
       */
      engineJs?: string;
    },
  ): Promise<boolean> {
    // #359 — structural guard: auto-repair the known comment-close typo, and
    // refuse to reveal a still-broken document as if it succeeded. Returns
    // false when blocked so the streaming caller can let a corrected block retry.
    const checked = validateAndRepairHtml(html);
    // #580 — "preview open" is one of the 5 MVP events in #552. Every reveal path
    // (stream auto · ▶ Run · show-intent · browser loop) funnels into this method, so
    // it is recorded here, in one place. **After** the structure guard — a blocked
    // reveal never reached the screen, and recording it would overcount "preview
    // opened".
    if (!checked.blocked) {
      const spoolTurn = opts?.streamId ?? opts?.spoolTurnId;
      this.spool?.recordWorkflow({
        ...(spoolTurn ? { turnId: spoolTurn } : {}),
        event: "preview_reveal",
      });
    }
    if (checked.issues.length > 0) this.surfaceStructureIssues(checked, opts?.streamId);
    if (checked.blocked) return false;

    const spoolTurn = opts?.streamId ?? opts?.spoolTurnId;
    this.spool?.recordArtifactSnapshot({
      ...(spoolTurn ? { turnId: spoolTurn } : {}),
      source: opts?.artifactSource ?? (spoolTurn ? "assistant_response" : "manual_preview"),
      path: "index.html",
      content: checked.html,
    });

    // 2026-08-17, Windows real device — the screen stayed blank for a long time
    // **even after** the coach said "완성됐어요!". Between the stream ending and the
    // preview actually coming up sit the live-server startup and opening a tab, and
    // with nothing shown across that stretch it simply looks stopped to the child
    // ("완성된거 안보여").
    //
    // That gap is filled with one timeline line. It turns done when it really comes
    // up and error when it fails, so the state "said it was up but it was not" never
    // stays on screen (R0).
    const revealLogId = randomId();
    const logReveal = (state: "running" | "done" | "error", label: string): void => {
      if (!opts?.streamId) return;
      this.postToolLog(opts.streamId, { id: revealLogId, icon: "🖼️", label, state });
    };

    logReveal("running", "미리보기 여는 중");
    // 2026-08-20 review — the point that actually overwrites the work folder's
    // index.html funnels into this one place (pre-built world · ▶ Run · "보여줘" ·
    // coach fence). With the archive living only inside revealPrebuiltWorld,
    // "보여줘" / ▶ Run overwrote the file the child had edited, with no archive, using
    // an **old fence** out of the history — the loss #649 blocked was still there
    // through another door.
    // Kids track only — an '이전 세상' folder appearing in an adult's work folder
    // would be stranger still.
    // When the content is identical, shouldArchiveWorld filters it out so archived
    // copies do not pile up (the coach's Edit-save path rewrites the file itself, so
    // it is always filtered here).
    if (isWorldCohort(this.cachedProfile)) {
      this.lastArchivedWorldFile = await this.archiveCurrentWorld(checked.html, opts?.streamId);
    }
    // Swap the engine in **after** the archive is done (the archived copy takes the
    // old engine inlined).
    if (opts?.engineJs !== undefined) await this.saveEngineToWorkspace(opts.engineJs);
    await this.saveGameToWorkspace(checked.html);
    if (this.isLiveServerPreview() && (await this.openInLiveServer())) {
      logReveal("done", "미리보기를 열었어요");
      return true;
    }
    // #629 — the srcdoc preview (fallback) cannot read the relative
    // <script src="engine.js">. This path is taken only when the live server did not
    // come up, so the engine is inlined here and only here.
    void this.preview.show(await this.inlineEngineIfNeeded(checked.html));
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
      // #519 — below, the preview tab is pinned as the coach's drive target. Leaving
      // it as `?.` means that when live_preview_start is the first tool call (no
      // instance yet) the pin is silently lost and the screenshot that follows falls
      // back to depending on activeBrowserTab.
      this.mcpBrowser ??= new BrowserControl();
      if (current) {
        this.liveServer.reload();
        // #519 — pin this tab so that it is the target when the coach calls
        // screenshot/read next. This path opens with `preserveFocus: true`, so
        // activeBrowserTab may not be set, and when that happened the inspection tools
        // failed with "열린 탭이 없어요".
        this.mcpBrowser.setTargetTab(current);
        // #525 — this is the flow where the participant said "미리보기 띄워줘". If the
        // already-open tab is in the background, only a reload happens and the screen
        // is unchanged, so it looks like "nothing happened". Bring it forward.
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
          viewColumn: this.editorChat ? vscode.ViewColumn.Two : vscode.ViewColumn.One,
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
   * #507 — corrects the proxy path's (#278) `browser_navigate` right before it runs.
   *
   * When the coach does not know the live server's address it reflexively types a
   * common port such as `127.0.0.1:3000` (3000 appears nowhere in the code — it is
   * the model's guess). The live server takes a random port via `listen(0)` on every
   * run, so that address is always empty and it ends in `ERR_CONNECTION_REFUSED`. The
   * Run button receives the URL directly so it was fine; only the coach failed,
   * because it did not have this path (#470 recurrence).
   *
   * Nothing is corrected when the server is not up — it is never fixed by guessing
   * (if we do not know, leave it as it is).
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
   * Brings an already-open browser tab **to the front of the participant's screen**
   * (#525).
   *
   * The proposed API's `BrowserTab` has no `show()`/`reveal()`, and calling
   * `openBrowserTab` again makes a new tab, undoing #519. So the **plain editor
   * path** is used: activate the group, put that tab in front with
   * `openEditorAtIndex`, and bounce back if the participant was in an editor.
   *
   * Measured on 2026-08-02 (installed 0.1.16, isolated profile):
   *   - a browser tab that was in the background really does come forward
   *   - after the bounce, `activeTextEditor` **and the selection are preserved
   *     exactly**
   *   - that column keeps showing the browser (it does not revert)
   *
   * Two disciplines — both of them "if we are not sure, do not touch the
   * participant's screen":
   *   ① Tab identification is the intersection of `pickRevealTabIndex`'s three
   *      conditions. With two candidates it does nothing (labels were seen tying in
   *      the measurements).
   *   ② With no `activeTextEditor` the bounce is skipped — with no cursor to return
   *      to, the risk of disturbing an IME composition is 0 (when the coach uses a
   *      tool, the participant's focus is usually in the chat sidebar).
   *
   * All of it is best-effort. It never throws on failure — turning the tool result
   * into an error would be the worse state of "it opened but it looks like it
   * failed".
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

      // Grab the bounce target **before** firing the command — after firing it has
      // already moved.
      const restore = vscode.window.activeTextEditor;
      const focusGroup = column === 1 ? FOCUS_FIRST_GROUP : FOCUS_SECOND_GROUP;
      await vscode.commands.executeCommand(focusGroup);
      await vscode.commands.executeCommand(OPEN_EDITOR_AT_INDEX, index);
      if (restore) {
        // Restore the cursor and the selection too. showTextDocument can name the
        // column explicitly, which is more precise than a focus{N}EditorGroup
        // combination (the participant may be in column 3).
        await vscode.window.showTextDocument(restore.document, {
          viewColumn: restore.viewColumn,
          selection: restore.selection,
          preserveFocus: false,
        });
      }
    } catch {
      /* failing to bring it forward does not make the tool itself fail — pass over quietly */
    }
  }

  private buildBrowserMcpHost(): BrowserMcpHost {
    return {
      openBrowser: async (url: string) => {
        // #519 — **this navigates; it does not open.**
        //
        // `openBrowserTab` makes a new editor on every call (mainThreadBrowsers draws
        // a fresh UUID each time) — the platform has no URL reuse at all. There used
        // to be a "close then open" layer on top of that, but loopback (the
        // participant's own artifact) was left out of the cleanup, so tabs piled up
        // every time a sub-page was visited. Now one tab is held per slot (artifact /
        // reference) and navigated with CDP: neither tabs nor columns multiply, the
        // page history (browser_back) survives, and the other slot the participant was
        // looking at is left alone.
        const tabs = vscode.window.browserTabs ?? [];
        const plan = planCoachBrowserTabs(tabs.map((t) => t.url), url);
        // Clean up only the surplus tabs already stacked in the same slot (the legacy pile-up).
        for (const i of plan.close) {
          try {
            await tabs[i]?.close();
          } catch {
            /* a tab we cannot close must not block the navigation */
          }
        }
        this.mcpBrowser ??= new BrowserControl();
        if (plan.reuse !== null) {
          // #526 — grab what this tab was showing **before** navigating. Read it after
          // the navigation and it is already the new address, so there is no way to
          // know "what got pushed out".
          const reused = tabs[plan.reuse];
          const replaced = reused?.url ? { url: reused.url, title: reused.title } : undefined;
          // Pin the reused tab, then CDP navigate — riding the very executor the
          // proxy path (#278) uses. Two copies of the same behaviour means only one of
          // them ever gets fixed (the same reason as #457).
          this.mcpBrowser.setTargetTab(reused);
          const r = await this.mcpBrowser.execute({
            id: "mcp-browser_open",
            name: "browser_navigate",
            input: { url },
          });
          if (!r.isError) {
            // #525 — the navigation succeeded, but with that tab in the background the
            // participant's screen is unchanged. This is the flow where the
            // participant said "열어줘", so bring it forward.
            if (reused) await this.revealBrowserTab(reused);
            return { replaced };
          }
          // A failed navigation (the tab was just closed, say) falls back to opening a
          // new one — to the student it must never become "it did not open".
          this.mcpBrowser.setTargetTab(undefined);
        }
        // Open a new one when the slot is empty. Why the column is named
        // **explicitly**: `Beside` (SIDE_GROUP) looks for the neighbour to the right of
        // the active group and makes a new group when there is none. If the browser
        // tab just opened is the active one (= rightmost), every following call splits
        // off another column and the workspace narrows. preserveFocus prevents that
        // activation in the first place, and the tab handle drives it without focus.
        const opened = await vscode.window.openBrowserTab(url, {
          viewColumn:
            this.editorChat ? vscode.ViewColumn.Two : coachTabSlot(url) === "preview" ? vscode.ViewColumn.One : vscode.ViewColumn.Two,
          preserveFocus: true,
        });
        this.mcpBrowser.setTargetTab(opened);
      },
      screenshot: async () => {
        // #519 — the fallback path also looks at the tab being driven first (the same
        // reason as currentPage above).
        const tab = this.mcpBrowser?.currentTab() ?? vscode.window.activeBrowserTab;
        if (!tab) return null;
        try {
          const ctx = await capturePageContext(tab);
          if (!ctx.imageBase64) {
            // Leave the cause behind. `catch { return null }` swallowed the reason
            // whole, so the 2026-07-26 measurements could not establish why the
            // screenshot was failing.
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
      // #507 — the address of the live server currently up. It does not start one
      // (giving a lookup a side effect would mean "what is the address?" turns the
      // server on). This is the only truth, and anything that does not read it is
      // guessing — that guess was 127.0.0.1:3000.
      livePreviewUrl: async () => this.liveServer.currentUrl() ?? null,
      // #415 — the cheapest path to read the page currently up. BrowserTab already
      // holds url/title as they are, so neither a CDP connection nor a screenshot is
      // needed (taking an image just to learn one URL wastes tokens and time alike).
      //
      // #519 — looking only at `activeBrowserTab` here is wrong. That value is set
      // only when the active editor is a browser, so the moment the participant
      // clicked a code tab it became "no page open" and the duplicate guard silently
      // switched off (the same page opens again and the approval modal appears again).
      // Look at the tab the coach is driving first, and fall back to the active tab
      // only when there is none.
      currentPage: async () => {
        const tab = this.mcpBrowser?.currentTab() ?? vscode.window.activeBrowserTab;
        if (!tab?.url) return null;
        return { url: tab.url, title: tab.title };
      },
      // #519 — for the duplicate check. There are two slots, so "the page currently
      // on screen" alone misses the other slot that is already up and raises an
      // unnecessary approval modal.
      openPages: async () =>
        (vscode.window.browserTabs ?? [])
          .filter((t) => !!t.url)
          .map((t) => ({ url: t.url, title: t.title })),
      // #523 — pins the tab judged "already open" as the drive target. openPages
      // passes URLs only (a tab handle never crosses this boundary), so it is looked
      // up again here — it has to be found with the **same comparison function** as
      // the judgment, or the judged tab and the pinned tab diverge.
      //
      // #525 — pinning alone is invisible to the participant. With that tab in the
      // background the screen is unchanged. It brings it forward as well
      // (revealBrowserTab — a failure is silently ignored).
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
      // #457 — delegates the 3 inspection tools (read/click/type) straight to the CDP
      // executor. It reuses the BrowserControl the proxy path (#278) was using —
      // implementing the same behaviour twice produces the bug where only one of the
      // two gets fixed. The instance is made lazily here and the panel cleanup path
      // owns its dispose.
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
   * #457 — the work folder the coach stands in. The opened folder, then the profile's
   * workspace_root. With neither it returns undefined, but it **does not pass over
   * silently**: that state means the coach cannot find files, and with no log the
   * cause cannot be established after the fact.
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

  private async handleMessage(msg: WebviewMessage, source?: vscode.Webview): Promise<void> {
    const connections=activityConnections(this.context);
    if (connections && msg.activityId && msg.activityId!==connections.scope) return;
    if (msg.type==='saveActivityDraft') {
      if (!connections?.scope || msg.activityId!==connections.scope || !validActivityDraft(msg.draft)) return;
      if (source && !msg.nonce) this.draftSource=source;
      const key='hps.activity.draft.'+msg.activityId;
      const save=this.draftWrites.then(()=>this.context.workspaceState.update(key,msg.draft));
      this.draftWrites=save.catch(()=>{});
      try {
        await save;
        if (msg.nonce && this.draftFlush?.nonce===msg.nonce && this.draftFlush.source===source) this.draftFlush.resolve();
      } catch {
        const error=new Error('입력을 저장하지 못했습니다. 기존 활동을 유지합니다.');
        if (msg.nonce && this.draftFlush?.nonce===msg.nonce) this.draftFlush.reject(error);
        await this.post({type:'activityDraftError',error:'입력을 저장하지 못했습니다. 활동을 바꾸기 전에 내용을 복사해 두세요.'});
      }
      return;
    }
    if (connections && (msg.type==='sendMessage'||msg.type==='retryMessage') && msg.activityId!==connections.scope) {
      await this.post({type:'streamError',streamId:'connection',error:'활동이 바뀌었습니다. 현재 활동에서 요청을 다시 확인해 주세요.'});return;
    }
    // Any message from the panel is evidence of a human. See `lastActivityAt`.
    this.lastActivityAt = Date.now();
    if (this.connectionChanging && (msg.type === "sendMessage" || msg.type === "retryMessage")) {
      await this.post({type:"inputRejected",text:msg.type==="sendMessage"?msg.text:msg.prompt,images:msg.images});
      void this.post({ type: "streamError", streamId: "connection", error: "활동 전환이 끝난 뒤 다시 보내세요. 입력은 초안에 남겨 두었습니다." });
      return;
    }
    switch (msg.type) {
      case 'observationCancel':
        this.observationAssessment?.abort();
        return;
      case 'observationAssess':
      case 'observationCorrect': {
        const token=await this.context.secrets.get(TOKEN_KEY);
        const proxy=vscode.workspace.getConfiguration('hypeproofChat').get<string>('proxyUrl','https://api.hypeproof-ai.xyz/v1');
        const recorder=await this.prepareObservation(proxy,token,await this.ensureProfile());
        if(!recorder||recorder.batch.scope!==msg.scope){await this.post({type:'observationState',learningPath:this.nativeLearningPath,batch:null,error:'수업 연결이 바뀌었습니다. 기록을 다시 확인하세요.'});return;}
        if(msg.type==='observationCorrect'){
          if(typeof msg.text==='string'&&msg.text.trim()&&msg.text.length<=2000){recorder.record(crypto.randomUUID(),'correction',msg.text);this.persistObservation(recorder);await this.observationWrites;}
          await this.post({type:'observationState',learningPath:this.nativeLearningPath,batch:recorder.snapshot(),error:null});return;
        }
        const snapshot=recorder.snapshot();
        if(snapshot.incomplete||recorder.missing.length){await this.post({type:'observationState',learningPath:this.nativeLearningPath,batch:snapshot,error:'빠진 기록이 있어 관찰을 요청할 수 없습니다. 작업 파일은 보존돼 있습니다.'});return;}
        if(this.observationAssessment){await this.post({type:'observationState',learningPath:this.nativeLearningPath,batch:snapshot,error:'이미 관찰 중입니다. 완료하거나 취소한 뒤 다시 요청하세요.'});return;}
        if(JSON.stringify(msg.eventIds)!==JSON.stringify(snapshot.events.map(e=>e.id))){await this.post({type:'observationState',learningPath:this.nativeLearningPath,batch:snapshot,error:'새 작업 기록이 추가됐습니다. 보낼 내용을 다시 확인해 주세요.'});return;}
        const controller=new AbortController();this.observationAssessment=controller;
        try{
          const response=await fetch(proxy.replace(/\/$/,'')+'/observations/assess',{method:'POST',headers:{...observationHeaders(token),'content-type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(65000)])});
          if(!response.ok){const failure=await response.json() as {error?:{code?:string}};throw Error(/^[a-z_0-9]{1,80}$/.test(failure.error?.code??'')?failure.error!.code:'assessment_failed');}
          const result=await response.json() as {findings:unknown};
          const findings=validateFindings(result.findings,snapshot);
          if(this.nativeObservation?.batch.scope!==snapshot.scope || await this.context.secrets.get(TOKEN_KEY)!==token)return;
          await this.context.workspaceState.update('hps.observation.result.'+snapshot.scope+'.'+snapshot.program,{...result,at:Date.now(),event_ids:snapshot.events.map(e=>e.id)});
          await this.post({type:'observationState',learningPath:this.nativeLearningPath,batch:snapshot,error:null,findings,assessedEventCount:snapshot.events.length});
        }catch(error){const code=error instanceof Error&&/^[a-z_0-9]{1,80}$/.test(error.message)?error.message:'assessment_failed';if(await this.context.secrets.get(TOKEN_KEY)===token)await this.post({type:'observationState',learningPath:this.nativeLearningPath,batch:snapshot,error:controller.signal.aborted?'관찰을 취소했습니다. 작업과 기록은 보존돼 있습니다.':'관찰 결과를 확인하지 못했습니다. 작업과 기록은 보존돼 있습니다. ('+code+')'});}finally{if(this.observationAssessment===controller)this.observationAssessment=null;}
        return;
      }
      case 'observationOpen': {
        const token=await this.context.secrets.get(TOKEN_KEY);
        const proxy=vscode.workspace.getConfiguration('hypeproofChat').get<string>('proxyUrl','https://api.hypeproof-ai.xyz/v1');
        const recorder=await this.prepareObservation(proxy,token,await this.ensureProfile());
        const saved=recorder?this.context.workspaceState.get<{findings:unknown;event_ids:string[]}>('hps.observation.result.'+recorder.batch.scope+'.'+recorder.batch.program):undefined;
        let findings;try{if(saved&&recorder&&saved.event_ids.every(id=>recorder.batch.events.some(e=>e.id===id)))findings=validateFindings(saved.findings,recorder.batch);}catch{this.nativeObservationError='이전 관찰 근거를 확인하지 못했습니다.';}
        await this.post({type:'observationState',learningPath:this.nativeLearningPath,batch:recorder?.snapshot()??null,error:this.nativeObservationError,findings,assessedEventCount:saved?.event_ids.length});
        return;
      }
      case 'learningEvent': {
        // SX-45 rule 2 — the **only** place where a learning event is made. The coach
        // stream callback (`recordObservation`) does not call this function.
        const recorder = await this.currentLearningRecorder();
        if (!recorder) { await this.postLearningState(); return; }
        const profile = await this.ensureProfile();
        const step = this.learningStep(profile, msg.stepId);
        const made = learningEventRequest(msg.draft, {
          week: Number(profile?.lesson?.content?.learning?.week ?? 1),
          step_id: step?.id ?? '',
          task: this.learningTaskId(profile?.lesson?.sha256, activityConnections(this.context)?.current?.id),
          module_version: String(profile?.lesson?.version ?? ''),
          sender: 'webview-form',
          stepEvidenceType: step?.evidence as never,
        });
        // A refusal is not swallowed silently — if what the student wrote disappears,
        // they will not write it again.
        if (!made.ok) { this.nativeObservationError = '남긴 내용을 저장하지 못했어요 ('+made.code+'). 다시 한 번 눌러 주세요.'; }
        else {
          try { recorder.recordLearningEvent(made.event); this.persistObservation(recorder); this.nativeObservationError = null; }
          catch (error) { this.nativeObservationError = '남긴 내용을 저장하지 못했어요 ('+(error as Error).message+').'; }
        }
        await this.postLearningState();
        return;
      }
      case 'learningDrawer':
        // A view state. The host only records it and never uses it in a verdict.
        this.learningDrawerOpen = msg.open;
        return;
      case 'submitTask': {
        // SX-14's negative condition — the webview's disabled state is not evidence.
        // Run the same gate again.
        const recorder = await this.currentLearningRecorder();
        const completion = this.learningCompletion(await this.ensureProfile());
        const verdict = acceptSubmit({
          task: msg.task,
          events: recorder?.batch.events ?? [],
          completion,
        });
        if (!verdict.ok) {
          this.nativeObservationError = '아직 완료할 수 없어요: ' + verdict.reasons.join(' · ');
          await this.postLearningState();
          return;
        }
        this.nativeObservationError = null;
        await this.postLearningState();
        return;
      }
      case "ready":
        await this.postConfig();
        await this.postHistory();
        await this.postLearningState();
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
      case 'refreshAccess':
        await this.loadAccess(true);await this.postConfig();return;
      case 'selectFunding':
        await this.loadAccess();
        if(!this.hasActiveStream()&&this.accessState?.view?.choices.some(c=>c.id===msg.id&&c.active))this.accessState={...this.accessState,selected:msg.id,notice:'선택한 이용권을 다음 작업부터 사용합니다.'};
        await this.postConfig();return;
      case 'requestBudget':{
        const token=await this.context.secrets.get(TOKEN_KEY),selected=this.accessState?.selected;
        if(token&&selected){try{await sendBudgetRequest(vscode.workspace.getConfiguration('hypeproofChat').get<string>('proxyUrl','https://api.hypeproof-ai.xyz/v1'),token,selected,msg.note);await this.loadAccess(true);if(this.accessState)this.accessState.notice='강사에게 추가 사용 요청을 보냈습니다.';}catch(error){if(this.accessState)this.accessState.notice=error instanceof Error?error.message:'요청을 보내지 못했습니다.';}}
        await this.postConfig();return;
      }
      case "refreshEffort":
        await this.refreshEffortResult();
        return;
      case "selectEffort": {
        const profile = await this.ensureProfile();
        const cfg = vscode.workspace.getConfiguration('hypeproofChat');
        const selection = availableModelSelection(profile,cfg.get<'proxy'|'agent-sdk'>('coachRuntime','proxy'));
        if (profile && selection) {
          const model = selectedModel(profile,selection,this.context.workspaceState.get<SavedModelChoice>('hps.modelChoice'),cfg.get<string>('model','hypeproof-default'));
          const effort = selectedEffort(profile,selection,model);
          if (effort?.allowed.includes(msg.value)) {
            await this.context.workspaceState.update('hps.effortChoice',{scope:modelSelectionScope(profile),model,value:msg.value});
            this.effortNotice = '다음 요청부터 적용돼요';
          }
        }
        await this.postConfig();
        return;
      }
      case "selectModel": {
        const profile = await this.ensureProfile();
        const cfg = vscode.workspace.getConfiguration('hypeproofChat');
        const selection = availableModelSelection(profile, cfg.get<'proxy' | 'agent-sdk'>('coachRuntime', 'proxy'));
        if (profile && selection?.choices.some(c => c.alias === msg.alias)) {
          const previous = selectedModel(profile,selection,this.context.workspaceState.get<SavedModelChoice>('hps.modelChoice'),cfg.get<string>('model','hypeproof-default'));
          await this.context.workspaceState.update('hps.modelChoice', { scope: modelSelectionScope(profile), alias: msg.alias });
          if (previous !== msg.alias) {
            await this.context.workspaceState.update('hps.effortChoice',undefined);
            this.effortNotice = selection.choices.find(c=>c.alias===msg.alias)?.effort
              ? '모델이 바뀌어 수업 기본 처리 수준을 사용해요' : '이 모델은 처리 수준 조절을 지원하지 않아요';
          }
        }
        await this.postConfig();
        return;
      }
      case "sendMessage":
        await this.handleSend(msg.text, msg.history, msg.images);
        return;
      case "retryMessage":
        // #358 — carry the failed turn's image(s) through the retry so the
        // coach actually re-receives the screenshot (was text-only → "스크린샷을
        // 아직 못 받았어요").
        await this.handleSend(msg.prompt, msg.history, msg.images);
        return;
      case "voiceCapabilityProbeResult": {
        // #897 — hand the raw observation to whoever is waiting for it. No verdict
        // is made here.
        const pending = this.voiceProbes.get(msg.probeId);
        if (pending) {
          this.voiceProbes.delete(msg.probeId);
          pending(msg.observations);
        }
        return;
      }
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
        void this.revealBuilt(msg.html, { artifactSource: "manual_preview" });
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
      case "publishToGallery":
        void this.publishToGallery();
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
      // #580 — a trace event lands in the local spool first (spool-then-forward).
      // Real-time forwarding to the worker (#552, #9d follow-up) can later just read
      // this spool and send, so the two paths share one schema. The mapping is owned
      // by a vscode-free helper (traceMsgToWorkflowRecord), and agreement with
      // trace.ts's field names is pinned by test/trace-workflow-map.smoke.mjs.
      case "traceTrialStart":
      case "traceTrialEnd":
      case "traceValidationRun":
      case "traceHumanAction":
        this.spool?.recordWorkflow(traceMsgToWorkflowRecord(msg));
        return;
    }
  }

  /**
   * #580 — proxy-path usage → spool mapping. The single turn and the browser loop had
   * inlined the same shape twice; this brings it into one place. The field names match
   * SpoolUsageRecord, so it ends in a spread.
   */
  /**
   * #897 H-13 — while recording usage, also look at **whether the model requested and
   * the model that answered differ**.
   *
   * Observed 2026-09-11: echoing a different model back for the same request left the
   * whole screen's innerText completely identical. `usage.model` reached this far but
   * went only into the spool, and not one character of it reached the student — a
   * silent substitution was indistinguishable from success.
   *
   * The verdict is made by `modelEchoHelpers` (warn only on an explicit choice, a date
   * variant counts as a match, no echo means no verdict). Here that result is attached
   * to the turn's text exactly once — stacking only one notice per turn is the same
   * rule as REQ-M39 ④, and it structurally prevents the same sentence repeating on a
   * path like the browser loop where several requests go out within one turn. A seat
   * has only one coach turn at a time (REQ-M37 ③), so one turn-id slot is enough.
   */
  private proxyUsageRecorder(turnId: string, echo?: ModelEchoContext, onNotice?: (text: string) => void) {
    return (u: ProxyStreamUsage & { requestKey: string | null; model: string | null;
      serverSubstituted?: boolean; serverRequested?: string | null }): void => {
      this.spool?.recordUsage({ turnId, source: "proxy", ...u });
      if (!echo || !onNotice) return;
      // REQ-M42 — pass on the verdict the server stated itself. String comparison
      // alone does not distinguish "alias translation" from "the request was thrown
      // away", which is why the verdict layer had to choose silence here.
      const verdict = modelEchoVerdict({
        ...echo, resolved: u.model,
        ...(u.serverSubstituted === true
          ? { serverSubstituted: true, serverRequested: u.serverRequested ?? null }
          : {}),
      });
      this.logChannel?.appendLine(`[model] ${describeModelEcho(verdict)}`);
      const notice = modelEchoNotice(verdict);
      if (!notice || this.modelNoticeTurn === turnId) return;
      this.modelNoticeTurn = turnId;
      onNotice(notice);
    };
  }

  private async handleSend(
    text: string,
    rawHistory: ChatMessage[],
    images?: string[],
  ): Promise<void> {
    this.pendingSends++;
    let releaseActivity: (()=>void) | undefined;
    let preflightComplete=false;
    try {
    const connections=activityConnections(this.context);
    if (connections) {
      releaseActivity=connections.acquire();
      const token=await connections.token();
      await verifyActivity({token:token!,proxyUrl:connections.current!.service},connections.current!.serverId);
    }
    preflightComplete=true;
    // #503 — the webview's history now has tool lines (role:"tool") mixed in. This is
    // the only path out to the model, so they are filtered once right at the entrance.
    // The proxy/SDK gateway calls below are a contract that knows only user/assistant.
    const history = modelHistory(activityConnections(this.context) ? this.getHistory() : rawHistory);
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
          {
            id: aid,
            role: "assistant",
            content: reply,
            createdAt: Date.now(),
            // #747 — an answer the app itself wrote is also labelled with the coach's
            // name on screen. It is stamped here too so it is not dragged along when
            // the name changes later.
            assistantName: this.coachDisplayName(),
          },
        ]);
        void this.revealBuilt(lastGame, { artifactSource: "existing" });
        return;
      }
      // No game yet → fall through to the AI, which will guide them to make one.
    }

    // 2026-08-19 — "다른 친구도 있어?" is answered instantly from the profile's
    // worlds. This used to spend one LLM turn (10–40 s) — the app already holds the
    // list.
    if (isGuestListRequest(text) && (!images || images.length === 0)) {
      const ws = this.cachedProfile?.worlds;
      if (ws?.length) {
        const shown = (this.cachedProfile?.ux?.suggestions?.initial ?? []).map((c) => c.text);
        const reply = guestListMessage(ws, shown);
        const uid = randomId();
        const aid = randomId();
        void this.post({ type: "streamStart", streamId: uid, messageId: aid });
        void this.post({ type: "streamChunk", streamId: uid, delta: reply });
        void this.post({ type: "streamEnd", streamId: uid });
        await this.appendHistory([
          { id: randomId(), role: "user", content: text, createdAt: Date.now() },
          {
            id: aid,
            role: "assistant",
            content: reply,
            createdAt: Date.now(),
            assistantName: this.coachDisplayName(),
          },
        ]);
        return;
      }
    }


    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    const proxyUrl = cfg.get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");
    let model = cfg.get<string>("model", "hypeproof-default");
    const token = await this.context.secrets.get(TOKEN_KEY);
    const coach = this.getCoach();
    // Fixed-naming cohorts must NOT inject a user-supplied coach name carried
    // over from a different cohort's user-data-dir into the LLM context (#140).
    const resolvedProfile = await this.ensureProfile();
    await this.loadAccess();
    const fundingSource=this.accessState?.selected;
    const chosenAccess=this.accessState?.view?.choices.find(c=>c.id===fundingSource);
    const profile=resolvedProfile?accessProfile(resolvedProfile,chosenAccess):null;
    const selection = availableModelSelection(profile, cfg.get<'proxy' | 'agent-sdk'>('coachRuntime', 'proxy'));
    const savedModel = this.context.workspaceState.get<SavedModelChoice>('hps.modelChoice');
    if (profile && selection) model = selectedModel(profile, selection, savedModel, model);
    const effort = profile && selection ? selectedEffort(profile,selection,model,this.context.workspaceState.get<SavedEffortChoice>('hps.effortChoice'))?.value : undefined;
    const { name: effectiveCoachName, personality: effectiveCoachPersonality } =
      resolveCoach(coach, profile);

    // #278 — consume any queued browser-page context for THIS turn only. The
    // user message stored in history keeps their clean text; only the model
    // sees the prepended page context.
    // kids-quest — fold the latest round from the native preview tab (if any).
    await this.pullQuestResultFromPreview();
    const pageContext = this.pendingPageContext;
    this.pendingPageContext = null;
    // #308 — the notice describes the queued context; once consumed, stop
    // resurrecting it on webview remounts (webview clears its copy on userSent).
    this.pendingPageNotice = null;
    let userTextForModel = pageContext ? `${pageContext}\n\n${text}` : text;
    // 2026-08-19 — pre-built guest worlds. When a child picks a guest they are not
    // made to wait 30–40 s for the coach to produce 5 KB: the filled-in HTML is
    // fetched from the worker, saved and shown immediately, and the coach is told
    // "it is already up — just the opening line".
    let openedWorldThisTurn = false;
    {
      const world = matchWorldRef(text, profile?.worlds);
      if (world && token) {
        this.lastArchivedWorldFile = null; // only tell the coach about an archive made this turn

        const shown = await this.revealPrebuiltWorld(world.id, proxyUrl, token);
        if (shown) {
          openedWorldThisTurn = true;
          // 2026-08-20 review — archived copies ('이전 세상/…') are hidden from the
          // coach's file listing (to stop "another world" contamination, #644), so even
          // when the child said "give me 초코's from before back" the coach did not
          // know the path. That one line is given only when an archive actually
          // happened this turn — a rollback request can then Read that file and
          // restore it into index.html.
          const archived = this.lastArchivedWorldFile
            ? `직전에 고치던 세상은 '${WORLD_ARCHIVE_DIR}/${this.lastArchivedWorldFile}' 로 보관해 뒀다 — ` +
              `아이가 되돌려 달라고 하면 그 파일을 Read 해서 index.html 에 되살려라. `
            : "";
          userTextForModel =
            `[Studio 안내: 아이가 ${world.emoji} ${world.guest} 세상을 골랐고, Studio 가 그 세상(문제 상태 기본값)을 ` +
            `이미 작업 폴더 index.html 에 저장하고 오른쪽 화면에 띄웠다. ${archived}코드나 파일 도구 없이 — ` +
            `${world.guest}의 첫 대사 한 줄과 "한번 해보세요" 만 짧게 말해라. 이후 바꾸기 요청부터 index.html 을 Read 하고 고쳐라.]\n\n${userTextForModel}`;
        }
      }
    }
    // #644 (2026-08-20, real device) — clearing the conversation empties only the
    // coach's memory; the world on the right-hand screen stays up. In that state, when
    // a child said "water instead of fire" the coach did not know which world it was
    // and either asked back or made a new file. Only on the first send after a clear,
    // one line about the open world is laid in front of the model input to refill that
    // memory — it is not attached to the child's bubble (the history stores the
    // original `text`). When a world was opened this turn it is skipped, because the
    // notice above already says the same thing.
    if (!openedWorldThisTurn && history.length === 0 && this.lastPrebuiltWorld) {
      const open = profile?.worlds?.find((w) => w.id === this.lastPrebuiltWorld);
      const notice = openWorldNotice(open);
      if (notice) userTextForModel = `${notice}\n\n${userTextForModel}`;
    }
    // #278 Phase 2 — fold any queued page screenshot into this turn's images.
    const pageImage = this.pendingPageImage;
    this.pendingPageImage = null;
    const effectiveImages = pageImage ? [...(images ?? []), pageImage] : images;

    // #580 — streamId becomes the spool's turn_id, and the later spool-then-forward
    // has to be able to resend it to the worker's trace. The worker validates turn_id
    // strictly as a UUID (routes/trace.ts), so a UUID is used instead of randomId().
    const streamId = crypto.randomUUID();
    if (token && profile && selection?.choices.some(c=>c.effort)) {
      this.effortTurn = {id:streamId,url:proxyUrl,token,scope:modelSelectionScope(profile)};
      this.effortResult = {state:'loading',requests:[]};
      void this.postConfig();
    }
    const observation = await this.prepareObservation(proxyUrl, token, profile);
    const recordObservation = (kind: import('./nativeObservationContract').ObservationKind, value: string, extra: Partial<import('./nativeObservationContract').ObservationEvent> = {}) => {
      if (!observation) return;
      try { observation.record(streamId,kind,value,extra);this.persistObservation(observation); }
      catch { observation.batch.incomplete=true;this.persistObservation(observation);this.nativeObservationError='관찰 기록이 불완전합니다. 이 기록으로 수행 능력을 판단하지 않습니다.'; }
    };
    recordObservation('user',text);
    const observationFiles = new Map<string,string>();
    const observationCaptures: Promise<void>[] = [];
    const messageId = randomId();
    const ctrl = new AbortController();
    this.activeStreams.set(streamId, ctrl);

    void this.post({ type: "streamStart", streamId, messageId });
    // #503 — this turn's single timeline. It runs the same reducer as the webview, so
    // the history keeps exactly the on-screen order.
    this.turnTimelines.set(streamId, timelineStart(emptyTimeline(), messageId, Date.now()));

    // #421 — leave a pasted image in the work folder as a file, and lay its path onto
    // this turn's model input. Without saving it the coach has nothing to point
    // `<img src>` at, and it hands the job back to the participant with "could you
    // save it as a file?" (2026-07-24, a live class).
    //
    // Only `images` is saved — `pageImage` (#278 "이 페이지를 코치에게") is a browser
    // capture, not material the participant attached in order to keep it, and saving
    // it would fill the work folder with files the participant never asked for.
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
      void this.revealBuilt(html, { streamId, artifactSource: "assistant_response" }).then((ok) => {
        // #359 — a blocked (still-broken after repair) build didn't ship;
        // let a later, CORRECTED (different) HTML block in the same stream try.
        if (!ok) revealed = false;
      });
    };
    // #173 — accumulate citations across the stream so they persist to history.
    const assistantCitations: import("./protocol").Citation[] = [];
    // #580 — this turn's spool recording state. spoolRuntime is the runtime that
    // **actually ran**, reflecting an SDK→proxy fallback — quantifying the cause of a
    // turn with no usage requires the recorded runtime to match reality (no silent
    // caps).
    let spoolRuntime: "proxy" | "agent-sdk" | null = null;
    let spoolStatus: "ok" | "error" = "ok";
    let spoolErrorKind: string | undefined;
    // Why a holder: TS's CFA cannot see the reassignment inside the callback, so a
    // plain let is narrowed to null by the time finally runs.
    const sdkTurnTotal: {
      current: { usage: Record<string, unknown>; totalCostUsd: number | null } | null;
    } = { current: null };
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
      // The decision is owned by resolveCoachRuntime (chatPanelHelpers) — it was
      // pulled out as a pure function while fixing the asymmetry where the minor check
      // was missing from the setting path alone. Unit test, with controls:
      // test/coach-runtime.smoke.mjs
      const settingRuntime = cfg.get<"proxy" | "agent-sdk">("coachRuntime", "proxy");
      const runtime: "proxy" | "agent-sdk" = selection?.source === "lesson" ? selection.runtime : resolveCoachRuntime({
        settingRuntime,
        profileRuntime: profile?.coach_runtime,
        minorCohort: profile?.minor_cohort,
      });
      // #580 — record the raw question plus the runtime this turn is headed for into
      // the spool. The identity comes from the token payload (u·c·p); with no token it
      // is recorded without an identity (the call below fails anyway and lands as
      // turn_end(status:error)).
      spoolRuntime = runtime;
      this.spool?.noteIdentity(spoolIdentityFromToken(token));
      this.spool?.recordPrompt({
        turnId: streamId,
        runtime,
        text,
        imagesCount: effectiveImages?.length ?? 0,
      });
      const onDelta = (delta: string) => {
        if (pendingShown) clearPending();
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
      // SX-59 / SX-43 — no capability score, grade or badge appears on the working
      // screen. The worker still sends the `asset_score` SSE chunk so the parser has
      // to keep reading it, but the host **throws it away.** The status-bar sink
      // (`assetStatusBar.ts`) and the webview message (`streamAssetScore`) disappeared
      // in this commit.
      // Stopping the chunk itself is a separate Service change (design §디자인 시스템).
      // Why the callback is left as a no-op instead of removed: it is required by
      // `sdkCoach.ts`'s option type, and the `sdk-surface-drift` smoke locks that
      // surface.
      const onAssetScore = (_assetScore: import("./protocol").AssetScoreChunk) => {};
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
      // .html paths Written/Edited during an SDK turn (tool_use id → absolute path) — previewed when the tool_result succeeds.
      const htmlWrites = new Map<string, string>();
      // The "building the next action" notice line (the silent stretch between a tool
      // result and the next call).
      let pendingShown = false;
      const PENDING_ID = `pending-${streamId}`;
      // Between a tool result and the next tool call the stream is completely silent
      // (a call only arrives once complete, in one lump). On a real device that stretch
      // was 3 minutes and the last line was `Read ✓`, so children and adults alike
      // misread it as "still reading". That stretch is filled with one live line.
      const showPending = () => {
        if (pendingShown) return;
        pendingShown = true;
        this.postToolLog(streamId, { id: PENDING_ID, icon: "…", label: "다음 단계를 준비하는 중…", state: "running" });
      };
      // Has a write tool **succeeded** during this turn? It is the only evidence for
      // writing "고쳤어요" when the notice line closes — without it, it becomes a lie
      // told to the child (R0).
      let wroteOk = false;
      const writeToolIds = new Set<string>();
      const clearPending = () => {
        if (!pendingShown) return;
        pendingShown = false;
        this.postToolLog(streamId, {
          id: PENDING_ID,
          icon: "✍️",
          label: pendingCloseLabel(wroteOk),
          state: "done",
        });
      };
      const onActivity = (a: import("./sdkCoachHelpers").SdkActivity) => {
        if (observation && (a.kind==='tool_use' || a.kind==='approval')) {
          try { observation.toolRequest(streamId,a.id,`${a.name}(${summarizeToolInput(a.name,a.input,300,this.resolveCoachCwd())})`); this.persistObservation(observation); }
          catch { observation.batch.incomplete=true;this.persistObservation(observation);this.nativeObservationError='도구 요청 기록이 불완전합니다.'; }
          const file=(a.input as {file_path?:unknown})?.file_path;
          if (['Write','Edit','MultiEdit'].includes(a.name) && typeof file==='string') {
            const absolute=path.resolve(this.resolveCoachCwd()??'',file);
            if (isInsideWorkspace(absolute)) observationFiles.set(a.id,absolute);
          }
        }
        if (a.kind==='approval') recordObservation('approval',a.actor==='user'?'사용자가 승인 창에서 선택했습니다.':'런타임 정책이 처리했습니다.',{tool_id:a.id,actor:a.actor,outcome:a.allowed?'allowed':'denied'});
        if (a.kind==='tool_result') recordObservation('tool_result',a.isError?(a.reason??'도구 실패'):(toolLabels.get(a.id)??'도구 실행 완료'),{tool_id:a.id,outcome:a.isError?'error':'success'});
        if (a.kind==='tool_result' && !a.isError && observationFiles.has(a.id)) {
          const file=observationFiles.get(a.id)!;
          observationCaptures.push((async()=>{
            try {
              if(!vscode.workspace.workspaceFolders?.length||!isInsideWorkspace(file))throw Error('artifact_outside_workspace');
              const stat=await fs.promises.stat(file);
              if(stat.size>20000) {if(observation){observation.batch.incomplete=true;this.persistObservation(observation);}this.nativeObservationError='큰 파일은 관찰 사본에서 제외했습니다.';return;}
              const bytes=await fs.promises.readFile(file);
              recordObservation('artifact',path.basename(file)+'\n'+bytes.toString('utf8'),{sha256:createHash('sha256').update(bytes).digest('hex')});
            }catch {if(observation){observation.batch.incomplete=true;this.persistObservation(observation);}this.nativeObservationError='산출물 사본을 확인하지 못했습니다.';}
          })());
        }
        const log = (id: string, icon: string, label: string, state: "running" | "done" | "error") =>
          // #503 — a.at: the SDK's own timestamp as it sent it. It becomes the persisted line's createdAt.
          this.postToolLog(streamId, { id, icon, label, state, ...(a.at ? { at: a.at } : {}) });
        switch (a.kind) {
          case "thinking_tokens":
            // One entry that ticks in place; the completed block replaces it.
            log(`think-${thinkingIndex}`, "💭", `응답 준비 중 · ${a.tokens} 토큰`, "running");
            break;
          case "thinking":
            // 2026-08-20 — thinking is also "doing something". A child's inner
            // thoughts are hidden (below), so without this line the screen goes
            // completely quiet — 3 minutes of silence after Read ✓ on a real device.
            showPending();
            // 2026-08-19 — a child cohort is not shown the coach's inner thoughts (the
            // English original) as they are. "The user wants me to display the HTML
            // file…" came up verbatim on a child's screen (real device, the guest
            // worlds). The adult track (#414) is unchanged.
            if (profile?.minor_cohort === true) break;
            log(`think-${thinkingIndex}`, "💭", a.text, "done");
            thinkingIndex += 1;
            break;
          case "tool_use": {
            // Pass the workspace root so the path is shown relative to it. Leaving
            // only the filename makes "normal · relative path refused · outside the
            // workspace" all read as the same characters.
            clearPending();
            const label = `${a.name}(${summarizeToolInput(a.name, a.input, 60, this.resolveCoachCwd())})`;
            toolLabels.set(a.id, label);
            // 2026-08-19 — when the SDK coach saves a .html with Write/Edit, that
            // result has to appear on screen. Before, only the chat's ```html fence
            // opened the preview, so on a turn where the coach fixed the file with a
            // tool the screen did not change even as it said "다 됐어요", and the coach
            // drifted into "press ▶ Run / open 127.0.0.1:<port>" (2026-08-19, real
            // device, guest worlds T1). Remember which file is being written.
            {
              const inp = a.input as { file_path?: unknown } | undefined;
              const fp = typeof inp?.file_path === "string" ? inp.file_path : "";
              const isWrite = (WRITE_TOOL_NAMES as readonly string[]).includes(a.name);
              // Separately from the preview case (.html), the "고쳤어요" verdict counts
              // **every write tool** — editing engine.js or any other file is still
              // editing.
              if (isWrite) writeToolIds.add(a.id);
              if (isWrite && /\.html?$/i.test(fp)) {
                htmlWrites.set(a.id, fp);
              }
            }
            log(a.id, "🔧", label, "running");
            break;
          }
          case "tool_result":
            // A failure leaves a mark in the label — an icon alone disappears once the
            // scroll passes it. In real use a Write failure was missed and
            // "저장됐습니다" was believed as it stood (2026-07-26).
            log(
              a.id,
              "🔧",
              a.isError
                ? `${toolLabels.get(a.id) ?? ""} — 실패${a.reason ? `: ${a.reason}` : ""}`
                : (toolLabels.get(a.id) ?? ""),
              a.isError ? "error" : "done",
            );
            // Only a **successful** write tool establishes the evidence for "it was
            // fixed". On a failure, or when it was never a write in the first place,
            // the notice line closes with "생각했어요".
            if (!a.isError && writeToolIds.has(a.id)) wroteOk = true;
            // When a tool successfully wrote a .html, read that file and show it in
            // the preview (the same revealBuilt as the fence path — identical down to
            // the save, the live server and the native tab).
            showPending();
            if (!a.isError && htmlWrites.has(a.id)) {
              const fp = htmlWrites.get(a.id)!;
              htmlWrites.delete(a.id);
              // 2026-08-19 — reopening the preview on every consecutive edit (5 Edits
              // before MultiEdit existed) stacks five "미리보기를 열었어요" lines and
              // reopens the live server just as many times. Open once, after the last
              // save (debounce).
              if (this.revealTimer) clearTimeout(this.revealTimer);
              this.revealTimer = setTimeout(() => {
                this.revealTimer = undefined;
                void this.revealWrittenHtml(fp, streamId);
              }, 900);
            }
            break;
        }
      };
      // The non-SDK runtime: the agentic browser loop when the cohort opted
      // into browser_control (copyclone opens the reference URL / re-checks the
      // live preview), else the plain single-turn proxy. #371 — the SDK path's
      // SdkUnavailableError fallback MUST route here too; falling back to a bare
      // runProxy() drops the browser loop, so the coach only *narrates* "브라우저
      // 열게요" and never opens it (regression from the #380 SDK-runtime flip).
      // #897 H-13 — the context for comparing the model requested against the model
      // that answered. **Passing the source along is the point**: a model the student
      // picked themselves being changed and a lesson default or a legacy alias being
      // resolved on the server are different events, and warning about the latter too
      // means normal behaviour raises a warning every turn and buries the real
      // substitution. Both proxy paths (ordinary send, browser loop) use the same
      // value.
      const modelEcho: ModelEchoContext = {
        requestedAlias: model,
        source: !selection ? 'unknown'
          : profile && savedModel?.scope === modelSelectionScope(profile) ? 'explicit'
          : selection.source === 'lesson' ? 'course_default' : 'legacy_alias',
        choices: selection?.choices ?? [],
        seatProvider: selection?.provider ?? null,
      };
      const runProxyRuntime = async () => {
        if (profile?.browser_control?.enabled) {
          await this.runBrowserLoop({
            modelEcho,
            proxyUrl,
            model,
            effort,
            fundingSource,

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
          effort,
          turnId: streamId,
            fundingSource,

          token,
          history,
          userText: userTextForModel,
          images: effectiveImages,
          signal: ctrl.signal,
          coachName: effectiveCoachName,
          coachPersonality: effectiveCoachPersonality,
          // #507 — send the address of the live server that is up on every turn.
          // Omitted when there is none: the worker then says "it is not up yet + do
          // not guess the port" on our behalf.
          previewUrl: this.liveServer.currentUrl(),
          onDelta,
          onCitations,
          onAssetScore,
          // #580 — the usage of one request (the worker's hps_usage / the upstream
          // usage chunk).
          // #897 H-13 — when that usage's `model` differs from the request, say so to
          // the student. Passing the source along is the point: a model the student
          // **picked themselves** being changed and a lesson default or a legacy alias
          // being resolved on the server are different events, and warning about the
          // latter too means normal behaviour raises a warning every turn and buries
          // the real substitution.
          onUsage: this.proxyUsageRecorder(streamId, modelEcho, onDelta),
        });
      // #749 — a seat runs only one coach turn at a time. The lock has to be
      // **outside** the runtime: it started inside `runSdkCoach`, which left every
      // proxy cohort unprotected, and when the SDK dropped out with
      // `SdkUnavailableError` the lock was released first and then the fallback ran —
      // so **the duplicate turn it was meant to block ran on the other runtime**.
      // Taking it here puts both paths and the fallback inside one fence.
      //
      // The seat key is derived from the token and the profile (only a hash of the
      // token is used). With no token it is blocked below anyway, so the lock is left
      // best-effort.
      await withCoachSeatLock(coachSeatKeyFor({ token: token ?? undefined, profile: profile ?? undefined }), async () => {
      const local = localRuntimeConfig(vscode.env.appName, proxyUrl);
      if (local) {
        if (!profile) throw new Error(profileNotReadyNotice(this.coachDisplayName()));
        if (effectiveImages?.length) throw new Error('로컬 개발 연결의 이미지 입력은 아직 지원하지 않습니다. 텍스트로 요청하세요.');
        const cwd=this.resolveCoachCwd();
        if(!cwd) throw new Error('개발 작업 폴더를 먼저 여세요.');
        const result=await runLocalCoach({config:local,profile,cwd,
          history:history.map(m=>({role:m.role,content:m.content})),userText:userTextForModel,
          signal:ctrl.signal,onDelta,onActivity,
          requestApproval:async action=>{
            let prompted=false;
            const approved=await this.resolveActionApproval({requestId:randomId(),...sdkToolToActionRequest(action)},()=>{prompted=true;});
            return {approved,actor:prompted?'user':'policy'};
          }});
        sdkTurnTotal.current={usage:{local_provider:local.provider,model:result.model,reported_usage:result.usage},totalCostUsd:null};
      } else if (runtime === "agent-sdk") {
        if (!profile) {
          throw new Error(profileNotReadyNotice(this.coachDisplayName()));
        }
        if (!token) {
          throw new ProxyAuthError("missing", TOKEN_MISSING_FRIENDLY);
        }
        try {
          await runSdkCoach({
            gatewayUrl: proxyUrl,
            effort,
            turnId: streamId,
            fundingSource,

            token,
            model,
            profile,
            // #747 — failure copy inside the SDK run names the same AI as the
            // header and the approval modals.
            coachName: this.coachDisplayName(profile),
            // The worker gateway (POST /v1/messages, #316) DROPS the client
            // `system` field and injects the cohort profile blocks server-side
            // (REQ-M10) — the tuned Korean prompt + classroom key never leave
            // the worker, so there is nothing to send from here.
            systemPrompt: "",
            history: history.map((m) => ({ role: m.role, content: m.content })),
            userText: userTextForModel,
            signal: ctrl.signal,
            // #457 — with no folder open, workspaceFolders is empty and cwd goes
            // through as undefined. withWorkspaceContext then returns the prompt
            // **unchanged** (no path injection), so the coach uses relative paths
            // without knowing where it is and every one of them fails. In real use on
            // 2026-07-26, 5 Reads failed in a row and the coach burned 13 of 20 turns
            // ransacking the whole home directory with `find ~` before the session died
            // on maxTurns.
            //
            // The profile already knows workspace_root, so that is the fallback. Only
            // when both sources are absent is it left undefined, and that case is
            // recorded loudly.
            cwd: this.resolveCoachCwd(),
            // #507 — the address of the live server that is up (omitted when there is
            // none). It is also reported through an MCP tool result, but it has to be
            // in the context at the start of the turn for the very first navigation to
            // be right.
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
            // #580 — SDK-path usage: the assistant message is the per-request unit
            // (one record even when a single API response arrives split across several
            // messages, via requestKey dedupe), and the result message is the turn
            // total (the control against the sum of the per-request records), carried
            // on turn_end.
            onUsage: (u) => {
              if (u.kind === "request") {
                this.spool?.recordUsage({
                  turnId: streamId,

                  source: "sdk",
                  requestKey: u.requestKey,
                  model: u.model,
                  inputTokens: u.usage.input_tokens,
                  outputTokens: u.usage.output_tokens,
                  cacheReadInputTokens: u.usage.cache_read_input_tokens,
                  cacheCreationInputTokens: u.usage.cache_creation_input_tokens,
                });
              } else {
                sdkTurnTotal.current = { usage: u.usage, totalCostUsd: u.totalCostUsd };
              }
            },
            onCitations,
            onAssetScore,
            // Map the SDK tool call → an accurate host ActionRequest so the
            // executeShell hard-deny and writeFile workspace-scope actually fire.
            requestApproval: async (action) => {
              let prompted = false;
              const approved = await this.resolveActionApproval({ requestId: randomId(), ...sdkToolToActionRequest(action) }, () => { prompted = true; });
              return {approved, actor: prompted ? 'user' as const : 'policy' as const};
            },
            // #282 P2 slice 2 — native-browser capabilities for the hypeproof
            // MCP tools. Always passed; runSdkCoach registers the server only
            // when the profile grants sdk_tools.browser (minors never do).
            browserHost: this.buildBrowserMcpHost(),
          });
        } catch (err) {
          if (!(err instanceof SdkUnavailableError)||fundingSource) throw err;
          if (selection && (selection.source === 'lesson' || (profile && savedModel?.scope === modelSelectionScope(profile)))) throw new Error('선택한 모델의 실행 환경을 사용할 수 없습니다. Studio의 Agent SDK 설치를 확인하거나 강사에게 알려주세요. 대화와 작업은 보존됩니다.');
          // Pre-Phase-1: the SDK package isn't installed. Keep the classroom
          // working — fall back to the proxy runtime for this turn instead of
          // showing the student a technical error.
          //
          // #476 — the fallback itself is kept (no behaviour change) but made
          // **visible**. Before, one `console.warn` was all there was, and with no
          // output channel in the extension that line survived nowhere: the student,
          // the instructor, the developer and the coach itself all failed to notice
          // the capability had disappeared, and that misdiagnosis produced 3 issues
          // (#470 · #471 · #472).
          assistantText = "";
          assistantCitations.length = 0;
          revealed = false;
          // #503 — discarding the text discards the timeline with it. Otherwise only
          // the tool lines stamped before the fallback survive into the history, making
          // a turn with "actions but no words".
          this.turnTimelines.set(streamId, timelineStart(emptyTimeline(), messageId, Date.now()));
          // #476 — the notice goes in **after** this reset. Put it before and the line
          // just stamped is wiped along with it, surviving in the webview only and not
          // in the history (it disappears when the window is reopened).
          this.noteSdkFallback(err.message, streamId);
          // #580 — the runtime this turn actually ran on is proxy. A fallback is a
          // state, but it is recorded as an event too — the evidence for quantifying
          // "why did a turn with no usage happen?".
          spoolRuntime = "proxy";
          this.spool?.recordWorkflow({
            turnId: streamId,

            event: "sdk_fallback",
            payload: { reason: err.message },
          });
          // #371 — fall back to the browser-loop-aware runtime, NOT bare proxy,
          // so a browser_control cohort (copyclone) still opens the browser when
          // the SDK binary isn't seeded.
          await runProxyRuntime();
        }
      } else {
        // #278 Phase 3 — browser loop for opted-in cohorts, else plain proxy.
        await runProxyRuntime();
      }
      });
      // On user-initiated stop the cancelStream handler already ended the stream
      // in the webview; don't post streamEnd or commit the truncated turn
      // (parity with the proxy path, which throws on abort).
      if (!ctrl.signal.aborted) {
        clearPending();
        void this.post({ type: "streamEnd", streamId });
        // #371 — persist the agent.md handoff fence, if the coach emitted one.
        // #503 — await it **before** the history is frozen. The toolLog line this
        // leaves also has to be in this turn's timeline for it to be visible when the
        // window is reopened.
        await this.saveAgentMdIfPresent(assistantText, streamId);
        await this.appendHistory([
          { id: randomId(), role: "user", content: text, createdAt: Date.now() },
          ...this.finishTurnItems(
            streamId,
            messageId,
            assistantText,
            assistantCitations,
            effectiveCoachName,
          ),
        ]);
        // Fallback reveal in case the stream completed but the per-chunk
        // probe missed it (e.g. the closing ``` was in the very last delta).
        tryReveal(assistantText);
      }
    } catch (err) {
      spoolStatus = "error";
      spoolErrorKind = classifyTurnError(err);
      await this.handleSendError(err, streamId);
    } finally {
      // #580 — always record the end of the turn. A user abort also arrives through
      // catch, so the signal is checked first. When there is an SDK turn total it is
      // carried along — the control against the sum of the per-request usage records.
      const total = sdkTurnTotal.current;
      const finalSpoolStatus = ctrl.signal.aborted ? "aborted" : spoolStatus;
      await Promise.all(observationCaptures);
      if (assistantText) recordObservation('coach',assistantText);
      recordObservation('turn_end',finalSpoolStatus,{outcome:ctrl.signal.aborted?'cancelled':spoolStatus==='ok'?'success':'error'});
      await this.observationWrites;
      if (assistantText.length > 0) {
        this.spool?.recordResponse({
          turnId: streamId,

          status: finalSpoolStatus,
          runtime: spoolRuntime,
          text: assistantText,
        });
      }
      this.spool?.recordTurnEnd({
        turnId: streamId,
        status: finalSpoolStatus,
        runtime: spoolRuntime,
        ...(spoolErrorKind && !ctrl.signal.aborted ? { errorKind: spoolErrorKind } : {}),
        ...(total
          ? {
              totalUsage: total.usage,
              ...(total.totalCostUsd !== null ? { totalCostUsd: total.totalCostUsd } : {}),
            }
          : {}),
      });
      if (this.effortTurn?.id === streamId) void this.refreshEffortResult().catch(() => { /* panel may have closed */ });
      this.activeStreams.delete(streamId);
      void this.loadAccess(true).then(()=>this.postConfig()).catch(()=>{});
      this.turnTimelines.delete(streamId);
    }
    } catch (error) {
      if (preflightComplete) throw error;
      await this.post({type:"inputRejected",text,images});
      await this.post({type:"streamError",streamId:"activity",error:error instanceof ActivityConnectionError || error instanceof ProxyTransportError ? error.message : "활동 연결 또는 작업 폴더를 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 보내 주세요."});
    } finally {
      try { releaseActivity?.(); } finally { this.pendingSends--; }
    }
  }

  /**
   * #503 — closes the turn and produces the items to persist. It is an array with
   * bubbles and tool lines mixed **in the order they happened**. Citations attach to
   * the last assistant bubble (a tool can split the bubbles into several, so the
   * assumption of "one assistant message per turn" can no longer be used).
   *
   * With no timeline (when the call order got out of step) it falls back to a single
   * assistant lump exactly as before — better than an empty history.
   */
  /**
   * #747 (AE-08) — stamps this turn's answer lines with **the name that turn answered
   * under**.
   *
   * This is the common commit point for both runtimes, so only one place needs fixing.
   * The value stamped is exactly the `effectiveCoachName` `handleSend` already
   * computed and handed to the runtime — resolving it again at render time would keep
   * today's behaviour where the past changes along with the name.
   *
   * `chatTimeline.ts` is left alone. It is a pure module with no vscode, so identity
   * is not put into it; it is stamped **on the way out**.
   */
  private finishTurnItems(
    streamId: string,
    messageId: string,
    assistantText: string,
    citations: import("./protocol").Citation[],
    assistantName?: string,
  ): ChatMessage[] {
    const stamp = (items: ChatMessage[]): ChatMessage[] =>
      assistantName
        ? items.map((m) => (m.role === "assistant" ? { ...m, assistantName } : m))
        : items;
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
    if (!t) return stamp(fallback);
    const items = stamp(timelineEnd(t, Date.now()).items);
    if (items.length === 0) return assistantText ? stamp(fallback) : [];
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
    effort?: import('./protocol').CourseEffort;
    fundingSource?: string;
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
    /** #897 H-13 — even when several requests go out within one turn the notice appears once (the recorder blocks the rest). */
    modelEcho?: ModelEchoContext;
  }): Promise<void> {
    const browser = new BrowserControl();
    const maxIter = this.cachedProfile?.browser_control?.max_iterations ?? 8;
    const scratch: Array<{ role: "user" | "assistant"; content: unknown }> = [];
    try {
      for (let iter = 0; ; iter++) {
        if (p.signal.aborted) return;
        const result = await proxyChat({
          proxyUrl: p.proxyUrl,
          model: p.model,
          effort: p.effort,
          turnId: p.streamId,
          fundingSource:p.fundingSource,
          token: p.token,
          history: p.history,
          userText: p.userText,
          images: p.images,
          toolTurns: scratch,
          signal: p.signal,
          coachName: p.coachName,
          coachPersonality: p.coachPersonality,
          // #507 — re-read on every turn inside the loop: the server address that
          // live_preview_start just brought up has to be in the next turn's context for
          // there to be no reason left to guess.
          previewUrl: this.liveServer.currentUrl(),
          onDelta: p.onDelta,
          onCitations: p.onCitations,
          // SX-59 — the browser loop discards the score chunk too. It used to buffer
          // the last turn's and put it on the status bar. The status bar is gone, so
          // the buffer went with it.
          onAssetScore: () => {},
          // #580 — the browser loop issues several requests within one turn. Per
          // iteration, 1 request = 1 record (requestKey is the per-request request id).
          onUsage: this.proxyUsageRecorder(p.streamId, p.modelEcho, p.onDelta),
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
          // #580 — pass spoolTurnId only: passing streamId would create a logReveal
          // timeline line on every iteration and change the UI. Only the spool
          // attribution is added.
          if (iterHtml) {
            await this.revealBuilt(iterHtml, {
              spoolTurnId: p.streamId,
              artifactSource: "assistant_response",
            });
          }
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
          // #507 — correct a guessed loopback port to the real live server before
          // running it. Fix it **before** building the log: if the on-screen line shows
          // the requested address, the participant reads an address different from
          // where it actually opened.
          const fixed = this.retargetLoopbackNavigation(call);
          const line = browserToolLogLine(fixed.call.name, fixed.call.input);
          this.postToolLog(p.streamId, { id: call.id, ...line, state: "running" });
          const tr = await browser.execute(fixed.call);
          this.postToolLog(p.streamId, { id: call.id, ...line, state: tr.isError ? "error" : "done" });
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            // If it was corrected, tell the model too — fix it silently and it
            // guesses again next turn.
            content: fixed.note
              ? [...tr.content, { type: "text" as const, text: fixed.note }]
              : tr.content,
            ...(tr.isError ? { is_error: true } : {}),
          });
        }
        scratch.push({ role: "user", content: toolResults });
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
      // #596 — the moment the session closes is the natural trigger for "send today's
      // records". It raises **a notice with one button**, not an automatic upload
      // (#580 AC: no upload of any kind without an explicit action). If the cohort has
      // not opted in, nothing is shown — the server refuses it anyway (fail closed).
      // Once per activation — if toasts stack up on every resend after the lesson
      // ends, nobody reads them from the second one on (the same judgment as the #476
      // fallback notice).
      if (
        err.kind === "session_window" &&
        !this.sessionEndUploadOffered &&
        this.cachedProfile?.analytics?.upload_session_logs === true
      ) {
        this.sessionEndUploadOffered = true;
        void vscode.window
          .showInformationMessage(
            "수업이 끝났어요 — 오늘 활동 기록을 남겨둘까요?",
            "기록 보내기",
          )
          .then((pick) => {
            if (pick === "기록 보내기") {
              void vscode.commands.executeCommand("hypeproof-chat.uploadSessionLogs");
            }
          });
      }
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
    const reason = err instanceof Error ? err.message : "문제가 발생했습니다. 운영 담당자에게 문의해 주세요.";
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
  async resolveActionApproval(req: ActionRequest, onPrompted?: () => void): Promise<boolean> {
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
        onPrompted?.();
    const pick = await vscode.window.showWarningMessage(
          "⚠️ 되돌리기 어려운 명령이에요. 정말 실행할까요?",
          { modal: true, detail: pretty },
          "실행",
          "취소",
        );
        return pick === "실행";
      }

      const REMEMBER = signature ? `항상 허용 (${signature})` : null;
      const buttons = REMEMBER ? ["실행", REMEMBER] : ["실행"];
      onPrompted?.();
    const pick = await vscode.window.showWarningMessage(
        shellApprovalTitle(this.coachDisplayName()),
        { modal: true, detail: pretty },
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

    // Tier 1.5 — opening the browser. Asked once per origin.
    //
    // Measured (2026-07-26, real use): while the coach read the reference site's
    // sub-pages one after another, a modal appeared for every page — About ·
    // 첨단디지털 · 평생예방 · 시니어 … The judgment is finished after one answer to
    // "may the coach look around this site", and demanding the same answer five times
    // leaves only the habit of clicking without reading — the exact opposite of what
    // the approval gate was meant to train. It is the same device as the shell's
    // `항상 허용` (above) and, likewise, session-scoped.
    if (req.kind === "openBrowser") {
      const url = (req.payload as { url?: string } | null | undefined)?.url ?? "";
      const origin = originOfUrl(url);
      if (origin && this.approvedBrowserOrigins.has(origin)) {
        return true;
      }
      const REMEMBER = origin ? `이 사이트는 항상 허용 (${origin})` : null;
      const buttons = REMEMBER ? ["열기", REMEMBER] : ["열기"];
      onPrompted?.();
    const pick = await vscode.window.showWarningMessage(
        `${browserApprovalTitle(this.coachDisplayName())}\n\n${url || req.description}`,
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
    // writeFile is **out** of this list (원장 decision 2026-07-27, reversing an
    // earlier decision).
    //
    // By the time this modal appears, the safety checks are already done: a path
    // outside the workspace is refused with no modal by evaluateSdkToolUse's
    // containment. So the only function left was not safety but teaching delegation
    // judgment — and in the measurements that teaching did not hold up.
    //
    //   07-27 turn 2: one file-save modal was left sitting for **174 seconds**. The
    //   원장 was not in front of the screen, and the coach was stuck doing nothing the
    //   whole time. The day before, a 42.2-second one was 77% of one turn's approval
    //   wait. There was also a day it appeared 8 times in one turn, and then it was
    //   clicked within 3–4 seconds — the rhythm of clicking without reading.
    //
    // So this modal becomes one of two things: missed, stopping the session; or
    // clicked by reflex, teaching nothing. Delegation judgment is taught on shell,
    // browser and subagents — those are genuinely hard to undo, or they reach outside.
    //
    // Reverting it is one line of settings: add "writeFile" to
    // hypeproofChat.requireApprovalFor.
    // browserClick is **not** in the list → auto-allowed.
    //
    // The delegation judgment was already made in the decision to open the page
    // (openBrowser). Clicking inside that page is verification, not a new outward act,
    // and browser_read on the same page is already auto-allowed. Measured (07-27): a
    // modal appeared on every loop where the coach "fixed it and clicked to check for
    // himself", and thanks to a missing mapping it even appeared **with the shell copy
    // and empty content**.
    // browserType stays — it can enter a value and go as far as submitting, which is a
    // different kind of act.
    //
    // The single source of the policy is `requireApprovalFor.default` in package.json.
    // When the manifest declares a default, **the manifest always wins** and the
    // second argument below is never reached. #499 was the drift caused by missing
    // that fact — only the code was fixed and not the manifest, so the writeFile modal
    // was still alive while browserType, absent from the list, was unconditionally
    // auto-allowed. To change the policy, edit `default` and `items.enum` in
    // package.json (a smoke test locks it).
    const required = cfg.get<string[]>("requireApprovalFor", [
      "executeShell",
      "openBrowser",
      "delegateAgent",
      "browserType",
    ]);
    const needsApproval = required.includes(req.kind);
    if (!needsApproval) return true;

    // Ask in Korean. Shell (`코치가 명령을 실행하려고 해요`) and browser (`코치가
    // 브라우저를 열려고 해요`) were Korean, but file writing alone dropped into this
    // generic fallback and went out as `HypeProof Chat wants to writeFile:` /
    // `Deny·Cancel·Approve`.
    //
    // This is not about removing noise, it is about **speed** (measured 2026-07-27):
    // the Korean modals were clicked within 3–4 seconds while this one English modal
    // ate 42.2 seconds — that single instance was 77% of that turn's approval wait.
    // When English suddenly appears in front of an adult professional audience, it
    // takes time to read.
    //
    // The approval gate itself stays (원장 decision 2026-07-27): consciously approving
    // at every moment your own artifact changes IS this track's delegation-judgment
    // training.
    const coachName = this.coachDisplayName();
    const { title, verb } = approvalCopyFor(coachName)[req.kind] ?? {
      title: approvalFallbackTitle(coachName),
      verb: "허용",
    };
    onPrompted?.();
    const pick = await vscode.window.showWarningMessage(
      `${title}\n\n${req.description}`,
      { modal: true },
      verb,
    );
    return pick === verb;
  }

  private async postConfig(): Promise<void> {
    const activity=activityConnections(this.context)?.current;
    const scope=activity?.id;
    await this.draftWrites;
    await this.loadAccess();
    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    const token = await this.context.secrets.get(TOKEN_KEY);
    const profile = await this.ensureProfile();
    const selection = availableModelSelection(profile, cfg.get<'proxy' | 'agent-sdk'>('coachRuntime', 'proxy'));
    const settingModel = cfg.get<string>('model', 'hypeproof-default');
    const model = profile && selection ? selectedModel(profile, selection, this.context.workspaceState.get<SavedModelChoice>('hps.modelChoice'), settingModel) : settingModel;
    const effort = profile && selection ? selectedEffort(profile,selection,model,this.context.workspaceState.get<SavedEffortChoice>('hps.effortChoice')) : undefined;
    const effortScope = profile ? JSON.stringify([token, modelSelectionScope(profile)]) : undefined;
    if (this.effortScope !== effortScope) {
      this.effortScope = effortScope;
      this.effortTurn = undefined; this.effortResult = undefined; this.effortNotice = undefined;
    }
    if (scope!==activityConnections(this.context)?.scope) return;
    const local=localRuntimeConfig(vscode.env.appName,cfg.get<string>('proxyUrl','https://api.hypeproof-ai.xyz/v1'));
    await this.post({
      type: "config",
      config: {
        proxyUrl: cfg.get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1"),
        model:local?.model??model,
        hasToken: !!token,
        ...(activity ? {activity:{id:activity.id,name:activity.name,kind:activity.kind,workspace:activity.workspace,verified:!!profile},
          activityDraft:this.context.workspaceState.get('hps.activity.draft.'+activity.id,emptyActivityDraft())} : {}),
        access:this.accessState,
        effort, effortNotice:this.effortNotice, effortResult:this.effortResult,
        coach: this.getCoach(),
        profile: profile ? { ...profile, model_selection: local?localModelSelection(local):selection } : null,
        update: local ? undefined : this.availableUpdate,
      },
    });
    // #649 — when the webview remounts (panel hide → show, reload) the highlight
    // disappears. Announce the currently open world once more to restore the strip's
    // aria-pressed.
    if (this.lastPrebuiltWorld) {
      const w = profile?.worlds?.find((x) => x.id === this.lastPrebuiltWorld);
      void this.post({
        type: "worldOpened",
        id: this.lastPrebuiltWorld,
        guest: w?.guest ?? "",
        emoji: w?.emoji ?? "",
      });
    }
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
    // #503 — the cap is counted on 'what was said'. Counting tool lines inside the
    // same 200 lets a single SDK turn (dozens of lines) push the entire conversation
    // history out.
    const next = clampTimeline([...current, ...msgs], HISTORY_MAX);
    await this.context.workspaceState.update(this.historyKey(), next);
  }

  private historyKey(): string {
    return historyKeyForCohort(activityConnections(this.context)?.scope ?? this.nativeHistoryScope??this.activeCohortId);
  }

  private coachKey(): string {
    return coachKeyForCohort(activityConnections(this.context)?.scope ?? this.activeCohortId);
  }

  private coachRitualDoneKey(): string {
    return coachRitualDoneKeyForCohort(activityConnections(this.context)?.scope ?? this.activeCohortId);
  }

  private getHistory(): ChatMessage[] {
    return this.context.workspaceState.get<ChatMessage[]>(this.historyKey(), []);
  }

  private async migrateLegacyStateForActiveCohort(): Promise<void> {
    if(activityConnections(this.context) || this.nativeHistoryScope)return; // Legacy cohort-wide history has no participant provenance.
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
   * #503 — sends one tool line to the webview and leaves **the same line in this
   * turn's timeline** as well. A toolLog that does not pass through this single point
   * becomes a line that shows on screen but is not in the history, and disappears when
   * the window is reopened — the very symptom this issue is meant to catch.
   */
  private postToolLog(streamId: string, entry: ToolEntry): void {
    const t = this.turnTimelines.get(streamId);
    if (t) this.turnTimelines.set(streamId, timelineTool(t, entry, Date.now()));
    void this.post({ type: "toolLog", streamId, ...entry });
  }

  private async post(msg: HostMessage): Promise<boolean | void> {
    msg={...msg,activityId:msg.activityId ?? activityConnections(this.context)?.scope};
    const targets = [this.editorChat?.webview, this.view?.webview].filter((view): view is vscode.Webview => !!view);
    if (!targets.length) return;
    const results = await Promise.all(targets.map(view => view.postMessage(msg)));
    return results.some(Boolean);
  }

  renderHtml(webview: vscode.Webview, distDir: vscode.Uri): string {
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
