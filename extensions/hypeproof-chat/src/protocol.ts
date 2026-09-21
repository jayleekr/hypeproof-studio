import type { StartRequest, StartResponse } from "./startPageProtocol";
// Shared message contract between extension host (Node) and webview (browser).
// Import this file from both sides; do not redefine these types anywhere else.

/**
 * #503 — `"tool"` is a display/persistence-only role. Once the conversation and tool
 * execution became one timeline, a tool line became a `ChatMessage` too. **It never
 * enters the history sent to the model** — `chatTimeline.modelHistory()` filters it
 * out.
 */
export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /**
   * #503 — filled in only when `role: "tool"`. The display content of a single tool
   * line (`🔧 Write(index.html) ✓`). `id` is the SDK's tool_use id, so the
   * running → done update happens in place.
   */
  tool?: { icon: string; label: string; state: "running" | "done" | "error" };
  /**
   * #173 — Web search citations attached to an assistant message. Populated
   * by the worker's SSE translator (`hps_citations` delta), accumulated by
   * the chat panel during streaming, persisted with the message.
   */
  citations?: Citation[];
  /**
   * Pasted-image context attached to a user message (website-copyclone
   * curriculum). Each entry is a `data:image/<type>;base64,...` URL produced
   * by the webview's clipboard-paste handler. Carried so the webview can
   * render a thumbnail on the bubble; the model only receives the image on
   * the turn it was pasted (see proxyClient — history is sent text-only, so
   * a screenshot is injected exactly once and never re-sent / persisted).
   */
  images?: string[];
  /**
   * #747 (AE-08) — **the name this turn actually answered under**.
   *
   * Without it: every answer line rendered the one live `coachName` (`hps-msg-role`
   * in `ChatPanel.tsx`). Both child cohorts are `user_names_it`, so when a child
   * renamed the coach mid-lesson, **even what the coach had said BEFORE that was
   * retroactively rewritten as the new name's words.** In a product that claims
   * evidence-based observation, the record was editing itself.
   *
   * The value is defined as **the exact string handed to the runtime when that turn
   * ran**, not "the name currently on screen" — the same value that went out as
   * `coachName` on the SDK path and as `x-hps-coach-name` on the proxy path. When
   * the name changes mid-turn, what the model believed itself to be called while it
   * answered has to survive in the record.
   *
   * Absent → render with the live name; lines written before this change and a
   * bubble still streaming take that path. **It is not backfilled.** It is never
   * attached to a `user` or `tool` line.
   */
  assistantName?: string;
}

/**
 * #173 — Source attached to an assistant message. `tier` (1–4) is computed
 * server-side from the URL so the chip palette is consistent across clients.
 * 1 academic society·edu·gov, 2 paper·DOI, 3 official manufacturer, 4 blog·YouTube·other.
 */
export interface Citation {
  url: string;
  title: string;
  domain: string;
  tier: 1 | 2 | 3 | 4;
}

export type AssetKey =
  | "taste"
  | "intent_clarity"
  | "context_design"
  | "verification_reflex"
  | "delegation_judgment"
  | "iteration_reflex"
  | "ownership";

export type AssetScores = Record<AssetKey, number>;

export interface AssetScoreChunk {
  type: "asset_score";
  version: 1;
  method: "heuristic-v1";
  scores: AssetScores;
}

export type CourseEffort = 'low' | 'medium' | 'high';
export interface EffortRequestRecord {
  request_id: string; model: string; requested: CourseEffort | null; applied: CourseEffort | null;
  reason: 'selected' | 'course_default' | 'unsupported_model'; status: number; created_at: string;
}
export interface ChatConfig {
  activity?: {id:string;name:string;kind?:'trial'|'personal'|'classroom';workspace:string;verified:boolean};
  activityDraft?: import('./activityDraft').ActivityDraft;
  access?: import('./accessClient').AccessState;
  effort?: { value: CourseEffort; allowed: CourseEffort[] };
  effortNotice?: string;
  effortResult?: { state: 'loading' | 'observed' | 'unknown'; requests: EffortRequestRecord[]; truncated?: boolean };
  proxyUrl: string;
  model: string;
  hasToken: boolean;
  coach: CoachInfo;
  profile: ResolvedProfile | null;
  update?: UpdateOffer | null;             // #72 — auto-update banner state
}

/**
 * Update offer surfaced in the chat panel via a banner (#72). Host computes
 * + pushes; webview only renders + can ask host to install/dismiss.
 */
export interface UpdateOffer {
  version: string;          // "0.1.2"
  notes: string;            // markdown — webview renders as plain text for now
  releaseUrl: string;
  sizeBytes: number;
}

export interface CoachInfo {
  name: string;
  personality: string;
  configured: boolean;        // has the user gone through the naming ritual?
}

/**
 * The UX-relevant subset of a server profile, fetched via GET /v1/profile and
 * cached client-side. Stays in sync with Worker's UxConfig type — keep both
 * sides updated together.
 */
export interface ResolvedProfile {
  /** Server-verified identity; never an execution grant. */
  activity_id?: string;
  /** Presentation only; derived from authenticated Service access, never grants authority. */
  activity_kind?: "trial" | "personal" | "classroom";
  access_identity?:{kind:'account';scope:string};
  model_selection?: {
    revision: 'hps-model-selection/1'; runtime: 'proxy' | 'agent-sdk'; provider: string;
    default: string; source: 'profile' | 'lesson';
    // `provider` arrives **only for a cross-provider cohort**
    // (`worker/src/lib/lesson-model-policy.ts:57` — it is added only when
    // `crossProviderEnabled(profile)`). Outside that, the one top-level `provider`
    // field describes the whole seat, so it is not duplicated per choice.
    //
    // Nothing broke while this field was missing — the webview renders only
    // `alias`/`label`. The problem is that **someone reading the type concludes "the
    // server does not send provider"**, and then the next change that wants to show
    // the provider on a choice cannot see the value already arriving and goes off to
    // fix the server first. What the server sends belongs in the type.
    choices: Array<{
      alias: string; id: string; label: string;
      provider?: string;
      effort?: {default: CourseEffort; allowed: CourseEffort[]};
    }>;
  };
  observation?: { format: string; scope?: string };
  /** Immutable teaching content; capability policy remains in the profile. */
  lesson?: {
    course_id: string; version: string; sha256: string;
    content: {
      schema: 'hps-session-design/1'; title: string; audience: string;
      duration_minutes: number; objective: string; prerequisites: string; starter: string;
      /**
       * `help` (#1008) and `ui`/`evidence`/`gate` (SX-56) are **optional keys**, and
       * the Service really does send them (`worker/test/lesson-help-mode.test.mjs`
       * and `worker/test/session-design-learning.test.mjs` confirm it on the
       * `/v1/profile` response). When the type hides what the server sends, the next
       * change cannot see the value already arriving and goes off to fix the server
       * first — which is what happened with `model_selection.provider`.
       */
      steps: Array<{
        id: string; title: string; instructions: string; hint: string; acceptance: string;
        help?: { default: string; allowed: string[] };
        ui?: string; evidence?: string; gate?: string;
      }>;
      /**
       * SX-55~58 — week, mission, completion conditions, observation items, forbidden
       * list. The 6-week curriculum is six data files filling this slot. Definition
       * and validation: `worker/src/lib/learning-design.ts`.
       *
       * `observe` is **kept out of** this type. It is not for the student's screen to
       * read (design §세션 설계 파일: "not shown to the student"), and if it is in the
       * type someone will render it.
       */
      learning?: {
        week: number;
        mission: string;
        completion?: Array<{ id: string; text: string; event: string }>;
        never?: string[];
        evidence_types?: string[];
        source_kinds?: string[];
        reflection?: { changed_mind: boolean; next_experiment: boolean };
      };
      /**
       * #747 — optional lesson-level AI display name. Informational here: the
       * Service already projects it onto `ux.coach` (fixed + fallback_name),
       * which is what the header, message labels and start page render.
       */
      assistant?: { display_name: string };
    };
  };
  profile_id: string;
  display_name: string;
  language: "ko" | "en";
  series_index: number;
  series_total: number;
  assets_focus?: string[];
  welcome: {
    greeting_md: string;
    example_prompts: string[];
  };
  ux: UxConfig;
  publishing: { enabled: boolean; strategy: string };
  preview: { type: "iframe" | "live_server"; auto_start: boolean };
  // #422 — the cohort's on-disk workspace folder (e.g. "~/HypeProofClinic" for
  // the dental website cohort, "~/HypeProofGames" for kids). The extension opens
  // this folder on onboarding. Absent → the legacy default folder is used.
  workspace_root?: string | null;
  workspace_start?: 'empty' | 'html';
  /** Optional input capabilities (default off). #278 / website-copyclone. */
  input?: { page_context?: boolean; image_paste?: boolean };
  /** #278 Phase 3 — coach's client-driven browser control loop (default off). */
  browser_control?: { enabled: boolean; max_iterations?: number };
  /**
   * #306 — hardened native-browser session for minor cohorts. `mode: "safe"`
   * makes the host enable the locked-down `persist:hp-safe` integrated-browser
   * session (via the hypeproof.browser.safeSession setting). Absent / "browse"
   * → normal browser. Inert on a Studio build without the fork core patch.
   */
  browser_session?: { mode: "safe" | "browse"; allowlist?: string[] };
  // #320 — true when the cohort is a minor cohort (explicit flag or age_range
  // upper bound < 18). Drives minor-specific UX and force-pins the coach to the
  // proxy runtime (#371).
  minor_cohort?: boolean;
  // Drives chat-panel tone (game vs search-webapp UI copy) (#159).
  game?: { template_tier: string };
  /** kids-quest — the list of pre-built worlds (GET /v1/worlds/:id returns the HTML). */
  worlds?: Array<{ id: string; guest: string; emoji: string; chip: string; aliases: string[]; line?: string }>;
  // #282 — provider-hosted tools the cohort profile opted into (sourced from the
  // worker, not inferred client-side). Drives which Agent SDK tools the coach may
  // use. Absent/false → the coach is chat-only for that capability.
  tools?: { web_search?: boolean };
  // #282 Phase 2 — Agent SDK workspace tools, owned by the worker profile
  // (ADR 0003). read → Read/Grep/Glob, write → Write/Edit. Absent/false →
  // chat-only (fail closed). No shell/exec flag exists in the schema; minors'
  // cohorts never carry write:true (harness child_sdk_write FAIL + client-side
  // strip for minor tiers).
  // `browser` (#282 P2 slice 2) grants the in-process "hypeproof" MCP browser
  // tools (browser_open / browser_screenshot / live_preview_start). Adults
  // only — minors never carry browser:true (harness child_sdk_browser FAIL +
  // client-side strip), per the #306/#318 safety posture.
  // `subagents` (#282 P2 slice 3) grants the read-only 코드리뷰어/리서처 SDK
  // subagents (delegation modal-gated; definition tools intersected with the
  // cohort's permitted set). Adults only — minors never carry subagents:true
  // (harness child_sdk_subagents FAIL + client-side strip).
  // `shell` (epic #431) grants the SDK Bash tool. Arbitrary commands are
  // allowed by design — the approval modal is the gate, same as Claude Code.
  sdk_tools?: {
    read?: boolean;
    write?: boolean;
    browser?: boolean;
    subagents?: boolean;
    shell?: boolean;
  };
  // #371 — coach runtime the worker resolved for this cohort. "agent-sdk" only
  // for an adult, sdk_tools-opted-in cohort (worker force-pins minors to
  // "proxy"). Absent → proxy. The client ORs this with the machine-scoped
  // setting; either can select agent-sdk, and canUseTool still gates tools.
  coach_runtime?: "proxy" | "agent-sdk";
  /** #596 — session-log upload opt-in. The client uses it only to decide UI exposure (the server enforces). */
  analytics?: { upload_session_logs?: boolean };
}

export interface UxConfig {
  coach: {
    naming_mode: "user_names_it" | "fixed" | "pick_from_list";
    fallback_name: string;
    naming_prompt_md: string;
    personality_prompt_md: string;
    revisit_on_entry?: boolean;
  };
  suggestions: {
    initial: SuggestionChip[];
    follow_up: SuggestionChip[];
  };
  hints: {
    short_input: { enabled: boolean; min_chars: number; message_md: string };
    roll_input_button: { enabled: boolean; label: string; probe_md: string };
  };
  retry_button: {
    enabled: boolean;
    show_counter: boolean;
    counter_toast_md?: string;
  };
}

export interface SuggestionChip {
  text: string;
  style: "good" | "weak";
  caption?: string;
}

// Webview → Host
export type WebviewMessage = (
  | {type:'saveActivityDraft';activityId:string;draft:import('./activityDraft').ActivityDraft;nonce?:string}
  /**
   * #897 (VO-01) — the **raw observation** from the voice capability probe. It
   * carries no verdict: the webview measures, the host's voiceCapabilityHelpers
   * judges. Observing and judging in the same place mixes up "could not measure"
   * with "measured, and it is blocked".
   */
  | { type: 'voiceCapabilityProbeResult'; probeId: string;
      observations: import('./voiceCapabilityHelpers').VoiceProbeObservations }
  | {type:'refreshAccess'}
  | {type:'selectFunding';id:string}
  | {type:'requestBudget';note:string}
  | { type: 'observationOpen' }
  /**
   * SX-45 rule 2 — a learning event is made **only by a webview form submission**.
   * The host calls `learningEventRequest(..., {sender:"webview-form"})` only where it
   * receives this message, and never from a coach stream callback. The webview does
   * not send `actor` or `context` — and if it does, the host throws them away.
   */
  | { type: 'learningEvent'; draft: { kind: string } & Record<string, unknown>; stepId?: string }
  /** The open state of drawer D. A view state, so the webview owns it and the host only records it. */
  | { type: 'learningDrawer'; open: boolean }
  /**
   * SX-14 — "완료" was pressed. **The webview's disabled state is not evidence**:
   * the host re-judges the gate with `acceptSubmit()` and refuses when it does not
   * pass. The requirement document's negative condition ("sending a completion by
   * keyboard or by calling the API directly is still refused") means exactly this
   * re-judgment.
   */
  | { type: 'submitTask'; task: string }
  | { type: 'observationCancel' }
  | { type: 'observationAssess'; scope: string; eventIds: string[] }
  | { type: 'observationCorrect'; scope: string; text: string }
  | StartRequest
  | { type: "ready" }
  | { type: "selectModel"; alias: string }
  | { type: "selectEffort"; value: CourseEffort }
  | { type: "refreshEffort" }
  | { type: "sendMessage"; activityId?:string; text: string; history: ChatMessage[]; images?: string[] }
  | { type: "retryMessage"; activityId?:string; prompt: string; history: ChatMessage[]; images?: string[] }
  | { type: "cancelStream"; streamId: string }
  | { type: "requestAction"; action: ActionRequest }
  | { type: "openSettings" }
  | { type: "setToken" }
  | { type: "openReportModal" }            // #64: user clicked 🚨 on error banner
  | { type: "installUpdate" }              // #72: user clicked "Install Now" on update banner
  | { type: "dismissUpdate"; version: string }  // #72: user clicked "Later" — silence for 7d
  | { type: "clearHistory" }
  | { type: "namingRitual" }
  | { type: "saveCoach"; name: string; personality: string }
  | { type: "runCode"; html: string }       // from chat panel → host → preview
  | { type: "previewReady" }                // from preview webview only
  | { type: "openExternal"; url: string }   // #173 — citation chip click → host opens browser
  /**
   * "갤러리에 올리기" — sends the world currently open to the lab gallery.
   *
   * The webview **carries nothing with it.** Which world it is and whose it is are
   * both known to the host (the open world id + the token in secret storage + the
   * index.html in the work folder). The webview NOT holding the HTML is the contract
   * here rather than an oversight — what goes up must be **what is saved on disk**,
   * not what is on screen.
   */
  | { type: "publishToGallery" }
  // Trace signals (#9). Webview fires; host forwards via POST /v1/trace/event.
  // The host-side HTTP forwarding lands in a follow-up — keep these in sync
  // with worker/src/routes/trace.ts TraceEvent union.
  // #751 F4 — explicit learner step action in the lesson panel (never inferred from chat volume).
  | { type: "lessonStep"; stepId: string; status: "in_progress" | "submitted" }
  | { type: "traceTrialStart"; taskLabel?: string }
  | { type: "traceTrialEnd"; trialId: string }
  | {
      type: "traceValidationRun";
      trialId: string;
      turnId?: string;
      outcome: "pass" | "fail" | "partial" | "error";
      errorsFound?: number;
      errorsFixed?: number;
    }
  | {
      type: "traceHumanAction";
      trialId: string;
      turnId?: string;
      kind: "accept" | "reject" | "edit" | "replace";
      diffChars?: number;
    }
  // S-04 (#48): React render-time crash caught by ChatErrorBoundary. Host
  // logs to output channel so post-incident reconstruction has a trail.
  | {
      type: "webviewError";
      message: string;
      stack: string;
      componentStack: string;
    }) & {activityId?:string};

// Host → Webview
export type HostMessage = (
  | {type:'inputRejected';text:string;images?:string[]}
  | {type:'activityFreeze';frozen:boolean;nonce?:string}
  | {type:'activityDraftError';error:string}
  /** #897 (VO-01) — a request to run the probe. Raised only by a command, never at activation time. */
  | { type: 'probeVoiceCapability'; probeId: string }
  | { type: 'observationState'; assessedEventCount?: number; learningPath?: {title:string;url:string;reason:string} | null; batch: import('./nativeObservationContract').ObservationBatch | null; error: string | null; findings?: import('./nativeObservationContract').ObservationFinding[] }
  /**
   * SX-14·15·17 — the learning state the host computed. **The webview does not
   * recompute it** (design §정보 구조 "호스트·웹뷰·워커의 경계"). The disabled
   * Complete CTA also just draws `complete.ok` as given. The gate result is never
   * stored, so this message always carries a freshly computed value.
   */
  | { type: 'learningState'; state: import('./learningStateHelpers').LearningStatePayload }
  | StartResponse
  | { type: "config"; config: ChatConfig }
  | { type: "history"; messages: ChatMessage[] }
  | { type: "streamStart"; streamId: string; messageId: string }
  | { type: "streamChunk"; streamId: string; delta: string }
  | { type: "streamCitations"; streamId: string; citations: Citation[] }  // #173
  // SX-59 — the host message that used to leak capability scores to the webview
  // (#204) has been removed. A score reaches the working screen in no shape at all.
  // The `AssetScoreChunk` type above **stays** — the proxy SSE parser still has to
  // keep reading and discarding the worker's `asset_score` chunk (`proxyClient.ts`,
  // `test/proxy-client-asset-score.smoke.mjs`).
  // The message name is deliberately not written here again:
  // `test/sx-legacy-score-removed.smoke.mjs` checks this file for the absence of
  // that name.
  | { type: "streamEnd"; streamId: string }
  // #497 — user pressed Stop. Distinct from streamEnd (the turn did NOT finish)
  // and from streamError (nothing went wrong — the user asked for this, so no
  // "문제가 생겼어요" banner and no 🚨 신고하기 button). The webview leaves the
  // streaming state and shows a plain notice inviting the next message.
  /** `by: "instructor"` — stopped by a classroom command (#751), so the learner is told who stopped it and that nothing was lost. */
  | { type: "streamStopped"; streamId: string; by?: "instructor" }
  // #278 Phase 3 — agentic browser tool loop action log (auto-run + log, no
  // modal). One line per tool call; `state` flips running → done/error.
  // #503 — there is one channel, so arrival order IS occurrence order. The webview
  // splices this line into the **same array** as `streamChunk` to build
  // [bubble] → [tool] → [bubble]. `at` is the SDK's own timestamp as it sent it (ms;
  // the host clock when absent) — the createdAt of the persisted line.
  | { type: "toolLog"; streamId: string; id: string; icon: string; label: string; state: "running" | "done" | "error"; at?: number }
  // #308 — the "페이지를 코치에게" completion notice. Raising a VS Code notification
  // toast stops the integrated browser with "Paused due to Notification" (core
  // behaviour), so this is announced on the chat panel's inline status line instead
  // of a toast.
  | { type: "pageAttached"; label: string }
  // #320 — AI disclosure notice (Anthropic Usage Policy: consumer-facing chat
  // must disclose "you are interacting with AI" at minimum at session start).
  // Host posts once per session — first webview mount of this run and again
  // right after a history clear; hide/show remounts within the same session
  // stay silent (host-side AiDisclosureGate remembers). Webview renders a
  // compact role=note + aria-live=polite banner at the top of the messages.
  | { type: "aiDisclosure"; text: string }
  // #384 — an image opened in an editor tab (VS Code intercepts file drops onto
  // the editor and opens them). The host reads the bytes and hands the webview
  // a data URL to attach to the next turn — making "drag a screenshot in" work
  // WITH VS Code's drop behavior instead of fighting it. image_paste-gated.
  | { type: "attachImage"; dataUrl: string; name: string }
  // #649 — a pre-built world actually came up on screen. Why it is a message
  // separate from config: config arrives only when the profile changes, whereas the
  // world changes several times within one session. The webview uses this to
  // highlight the currently open world in the friend strip (aria-pressed).
  | { type: "worldOpened"; id: string; guest: string; emoji: string }
  /**
   * The result of "갤러리에 올리기". Why `state` has three values: the upload takes a
   * few seconds, and with nothing shown during them a child keeps pressing the button
   * (and that hits the server rate limit). `uploading` is sent first, at the start.
   */
  | {
      type: "publishResult";
      state: "uploading" | "done" | "error";
      /** When done — the gallery URL, shown to the child exactly as it is. */
      url?: string;
      /** When error — the Korean sentence the server produced. */
      message?: string;
    }
  | { type: "streamError"; streamId: string; error: string; requestId?: string; runbookUrl?: string }
  | { type: "actionResult"; requestId: string; approved: boolean }
  | { type: "renderPreview"; html: string }
  // Test-only: forces a React render-time throw so e2e can verify the
  // ChatErrorBoundary fallback path (REQ-C7). Only sent from the
  // host-side __test_crashWebview command which is itself env-gated.
  | { type: "webviewTestCrash" }) & {activityId?:string};

export interface ActionRequest {
  requestId: string;
  // #282 — extended beyond writeFile/executeShell so Agent SDK tool calls map to
  // an accurate kind: Read/Glob → readFile, WebSearch/WebFetch → webSearch. The
  // approval policy (resolveActionApproval) keys its tiers on these.
  // "openBrowser" (#282 P2 slice 2): the hypeproof MCP browser_open tool — an
  // outward action, modal-gated by default (requireApprovalFor).
  // "delegateAgent" (#282 P2 slice 3): the coach wants to hand a task to a
  // read-only subagent (코드리뷰어/리서처) via the SDK Agent/Task tool. The
  // modal makes the student consciously decide the delegation — the
  // delegation_judgment asset IS this decision (docs/seven-assets.md §5).
  kind: "writeFile" | "executeShell" | "readFile" | "webSearch" | "openBrowser" | "delegateAgent" | "browserClick" | "browserType";
  /**
   * epic #431, shell only — the command is unrecoverable if approved by
   * reflex (`rm`, `sudo`, `git push --force`, pipe-to-shell). The host shows
   * the strong confirm and refuses to remember it under "항상 허용".
   */
  destructive?: boolean;
  description: string;
  payload: unknown;
}
