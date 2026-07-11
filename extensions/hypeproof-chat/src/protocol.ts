// Shared message contract between extension host (Node) and webview (browser).
// Import this file from both sides; do not redefine these types anywhere else.

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
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
  /** Optional input capabilities (default off). #278 / website-copyclone. */
  input?: { page_context?: boolean; image_paste?: boolean };
  /** #278 Phase 3 — coach's client-driven browser control loop (default off). */
  browser_control?: { enabled: boolean; max_iterations?: number };
  // Drives chat-panel tone (game vs search-webapp UI copy) (#159).
  game?: { template_tier: string };
  // #282 — provider-hosted tools the cohort profile opted into (sourced from the
  // worker, not inferred client-side). Drives which Agent SDK tools the coach may
  // use. Absent/false → the coach is chat-only for that capability.
  tools?: { web_search?: boolean };
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
  | { type: "retryMessage"; prompt: string; history: ChatMessage[] }
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
  kind: "writeFile" | "executeShell" | "readFile" | "webSearch";
  description: string;
  payload: unknown;
}
