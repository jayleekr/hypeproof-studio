// Shared message contract between extension host (Node) and webview (browser).
// Import this file from both sides; do not redefine these types anywhere else.

/**
 * #503 — `"tool"` 은 화면·영속화 전용 역할이다. 대화와 툴 실행이 하나의
 * 타임라인이 되면서 툴 한 줄도 `ChatMessage` 가 됐다. **모델에 보내는
 * 히스토리에는 절대 들어가지 않는다** — `chatTimeline.modelHistory()` 로 거른다.
 */
export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /**
   * #503 — `role: "tool"` 일 때만 채워진다. 툴 한 줄의 표시 내용
   * (`🔧 Write(index.html) ✓`). `id` 는 SDK 의 tool_use id 라 running → done
   * 갱신이 제자리에서 일어난다.
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
}

/**
 * #173 — Source attached to an assistant message. `tier` (1–4) is computed
 * server-side from the URL so the chip palette is consistent across clients.
 * 1 학회·edu·gov, 2 논문·DOI, 3 제조사 공식, 4 블로그·유튜브·기타.
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

export interface ChatConfig {
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
  /** kids-quest — 사전 완성 세상 목록 (GET /v1/worlds/:id 로 HTML). */
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
  /** #596 — 세션 로그 업로드 opt-in. 클라는 UI 노출 판단에만 쓴다(강제는 서버). */
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
export type WebviewMessage =
  | { type: "ready" }
  | { type: "sendMessage"; text: string; history: ChatMessage[]; images?: string[] }
  | { type: "retryMessage"; prompt: string; history: ChatMessage[]; images?: string[] }
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
   * "갤러리에 올리기" — 지금 열려 있는 세상을 lab 갤러리로 보낸다.
   *
   * 웹뷰는 **아무것도 실어 보내지 않는다.** 어떤 세상인지도, 누구 것인지도
   * 호스트가 안다(열린 세상 id + 시크릿 저장소의 토큰 + 작업 폴더의 index.html).
   * 웹뷰가 HTML 을 들고 있지 않은 것이 여기서는 오히려 규약이다 — 화면에 있는
   * 것이 아니라 **디스크에 저장된 것**이 올라가야 한다.
   */
  | { type: "publishToGallery" }
  // Trace signals (#9). Webview fires; host forwards via POST /v1/trace/event.
  // The host-side HTTP forwarding lands in a follow-up — keep these in sync
  // with worker/src/routes/trace.ts TraceEvent union.
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
    };

// Host → Webview
export type HostMessage =
  | { type: "config"; config: ChatConfig }
  | { type: "history"; messages: ChatMessage[] }
  | { type: "streamStart"; streamId: string; messageId: string }
  | { type: "streamChunk"; streamId: string; delta: string }
  | { type: "streamCitations"; streamId: string; citations: Citation[] }  // #173
  | { type: "streamAssetScore"; streamId: string; assetScore: AssetScoreChunk }  // #204
  | { type: "streamEnd"; streamId: string }
  // #497 — user pressed Stop. Distinct from streamEnd (the turn did NOT finish)
  // and from streamError (nothing went wrong — the user asked for this, so no
  // "문제가 생겼어요" banner and no 🚨 신고하기 button). The webview leaves the
  // streaming state and shows a plain notice inviting the next message.
  | { type: "streamStopped"; streamId: string }
  // #278 Phase 3 — agentic browser tool loop action log (auto-run + log, no
  // modal). One line per tool call; `state` flips running → done/error.
  // #503 — 채널이 하나라 도착 순서가 곧 발생 순서다. 웹뷰는 이 줄을 `streamChunk`
  // 와 **같은 배열**에 끼워 넣어 [말풍선] → [툴] → [말풍선] 을 만든다. `at` 은 SDK
  // 가 실어 보낸 자기 시각(ms, 없으면 호스트 시계) — 영속화된 줄의 createdAt.
  | { type: "toolLog"; streamId: string; id: string; icon: string; label: string; state: "running" | "done" | "error"; at?: number }
  // #308 — "페이지를 코치에게" 완료 안내. VS Code 알림 토스트를 띄우면 통합
  // 브라우저가 "Paused due to Notification"으로 멈추므로(코어 동작), 토스트 대신
  // 채팅 패널 인라인 상태줄로 알린다.
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
  // #649 — 사전 완성 세상이 실제로 화면에 떴다. config 와 별개의 메시지인 이유:
  // config 는 프로필이 바뀔 때만 오는데, 세상은 한 세션에서 여러 번 바뀐다.
  // 웹뷰는 이걸로 친구 스트립의 "지금 열린 세상"을 강조한다(aria-pressed).
  | { type: "worldOpened"; id: string; guest: string; emoji: string }
  /**
   * "갤러리에 올리기" 의 결과. `state` 가 셋인 이유: 업로드는 몇 초가 걸리고,
   * 그 동안 아무 표시가 없으면 아이가 버튼을 계속 누른다(그리고 그건 서버
   * 레이트리밋에 걸린다). 시작할 때 `uploading` 을 먼저 보낸다.
   */
  | {
      type: "publishResult";
      state: "uploading" | "done" | "error";
      /** done 일 때 — 아이에게 그대로 보여줄 갤러리 주소. */
      url?: string;
      /** error 일 때 — 서버가 만든 한국어 문구. */
      message?: string;
    }
  | { type: "streamError"; streamId: string; error: string; requestId?: string; runbookUrl?: string }
  | { type: "actionResult"; requestId: string; approved: boolean }
  | { type: "renderPreview"; html: string }
  // Test-only: forces a React render-time throw so e2e can verify the
  // ChatErrorBoundary fallback path (REQ-C7). Only sent from the
  // host-side __test_crashWebview command which is itself env-gated.
  | { type: "webviewTestCrash" };

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
