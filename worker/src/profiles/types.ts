// Per-cohort profile schema. To add a new cohort (e.g. dental, corporate AX),
// create a new module under profiles/ that exports a Profile and register it
// in profiles/index.ts. No other code changes required.

import type { LLMProvider } from "../env.ts";

export interface Profile {
  /**
   * Explicit opt-in; observation does not grant any execution tools.
   *
   * `format` picks which observation contract this cohort's seats are served
   * (design §관측 이벤트와 필드: "the profile's observation.format decides which one is used").
   * Absent means `hps-observation/1` — every cohort that existed before this
   * field keeps its exact behaviour. `hps-observation/2` is the superset that
   * carries the eight learning kinds, and it is what makes the completion gate
   * and the Evidence drawer reachable at all: with no cohort declaring it, the
   * client never builds a /2 recorder and those screens never render.
   */
  observation?: {
    /**
     * @deprecated ADR 0010. It meant four things — record, assess,
     * `/v1/profile` session gating and individual-trial minting. Steps 1 and 2
     * moved all four out: the last two now read `session.requires_open_session`
     * and `trial.individual`, so this flag is down to being the fallback
     * `observationCapability()` reads for `record` and `assess` on profiles
     * that have not been rewritten. It is still the only field any profile
     * sets. Removed in the ADR's last step, once they have been.
     */
    enabled?: boolean;
    /** Write learning events on the student's device. The drawer and the completion gate turn on with this. */
    record?: boolean;
    /** May call `POST /v1/observations/assess` — the batch leaves the device. Off unless a cohort opts in. */
    assess?: boolean;
    format?: "hps-observation/1" | "hps-observation/2";
  };
  /** Empty starts wait for a task; absent preserves existing web curriculum. */
  workspace_start?: 'empty' | 'html';
  id: string;
  version: number;
  display_name: string;
  /**
   * #1006 IC-02 — a reviewed, institution-neutral execution template that a new
   * course may select instead of a customer profile. Offered only to issuers
   * whose scope already lists this profile; the flag never widens scope, models,
   * tools or budgets. `version` is the template revision. No template is
   * activated by default — activation is a separate admin decision.
   */
  execution_template?: boolean;
  /**
   * Instructor console (/console) presentation. `dashboard_hidden` drops this
   * track from the console's session-open cards AND the token-mint dropdown
   * (does NOT affect /v1/profile resolution — a student token still resolves).
   * `dashboard_order` sorts the visible tracks (lower first); absent → after
   * ordered ones, then registry order. Used to make a cohort's primary track
   * the default and hide a track that won't be run this round (#384).
   */
  dashboard_hidden?: boolean;
  dashboard_order?: number;
  audience: {
    age_range?: [number, number];
    language: "ko" | "en";
    parent_coaching: boolean;
  };
  /**
   * #320 — compliance flag: this cohort serves MINORS (Anthropic minors-guide
   * + PIPA). Drives the gateway moderation layer (lib/moderation.ts) and is
   * exposed via /v1/profile so the client can render minor-specific UX (AI
   * disclosure, etc.). Belt-and-braces: `isMinorCohort()` ALSO treats any
   * `audience.age_range` upper bound < 18 as minor, so forgetting this flag
   * on a future kids profile cannot silently disable moderation (project
   * minor-safety invariant: when in doubt, deny for minors).
   */
  minor_cohort?: boolean;
  model: {
    effort?: import('../lib/model-effort').EffortPolicy;
    default: ModelKey;
    fallback?: ModelKey;
    /** Explicit, reviewed catalogue keys for this cohort. Omission preserves the legacy pair. */
    allowed?: ModelKey[];
    /** Reviewed adult proxy catalogue; explicit model IDs select their provider. */
    cross_provider?: boolean;
    /** Derived from a validated frozen lesson, never from client input. */
    lesson_locked?: boolean;
    /**
     * Sends only this profile to a different upstream. Absent → the deployment
     * default (LLM_PROVIDER) is used.
     *
     * Different uses want different models — a kids' lesson wants the cheap, fast
     * one; a high-risk artifact wants the accurate one even if it costs more. There
     * is no reason to tie the whole deployment to one model.
     * If the key for the provider named here is missing, **only this profile** 502s
     * (the rest are fine).
     */
    provider?: LLMProvider;
    /** Per-profile output-token ceiling used when the client omits max_tokens.
     *  Long-output profiles (e.g. website copyclone → full HTML) set this high so
     *  responses are not truncated at DEFAULT_MAX_TOKENS. Clamped to 1..16384. */
    max_tokens?: number;
  };
  system_prompt: string;            // full text (loaded from prompts/*.md at build time)
  welcome: {
    greeting_md: string;
    example_prompts: string[];
  };
  sandbox: {
    /**
     * @deprecated No code reads it. The canonical owner of tool policy is
     * `sdk_tools.write` (#282 P2 / ADR 0003). This field is a leftover from an
     * earlier period and whatever its value, it has no runtime effect at all.
     *
     * **Why it is kept instead of deleted:** 4 profiles already carry a value, so
     * removing them all is a separate job. Until then this comment stops the
     * misreading — on 2026-08-10 two people (the profile author and the verifier)
     * actually looked at this field and concluded "file writing is on".
     *
     * **The real path by which a child cohort's artifact gets saved:** the coach has
     * no Write tool (chat-only, L3 decision); instead the extension parses the
     * coach's ```html fence and writes it to `index.html` at the workspace root
     * (`chatPanelProvider.ts` `revealBuilt()` → `saveGameToWorkspace()`).
     * That is, the artifact is saved whether this field is false or true.
     */
    file_write: boolean;
    /** The cohort work folder. READ — chat.ts serves it over /v1/profile and the client switches folder. */
    workspace_root?: string;
    /**
     * @deprecated No code reads it. The real shell policy is owned by
     * `sdk_tools.shell` (#431). The same leftover as `file_write` above.
     */
    execute_shell: boolean;
    /** READ — translate.ts filters the client tools array down to this list. empty = no tools */
    mcp_tools_enabled: string[];
  };
  preview: {
    type: "iframe" | "live_server";
    auto_start: boolean;
  };
  /**
   * Optional input capabilities — all default off so minor cohorts never expose
   * them unless a profile opts in. `page_context` (#278) lets "send the current
   * page to the coach" inject the native browser tab's content into a chat turn.
   * `image_paste` is the website-copyclone screenshot path.
   */
  input?: {
    page_context?: boolean;
    image_paste?: boolean;
  };
  /**
   * Which pre-built skeleton library the model customizes from.
   *
   * Game tiers (kids-basic → kids-rich → teen → pro-3d) — for kids/teen
   * cohorts; model picks closest game skeleton and swaps theme/characters/colors.
   *
   * Workshop tier "search-webapp" — for clinical/professional workshops
   * (e.g. 보아치과 v4); model fills %%CLINIC_NAME%%/%%SEARCH_TOPIC%%/
   * %%DECISION%%/%%SOURCES%% in the static webapp skeleton, no game loop.
   *
   * Workshop tier "website" — for website-copyclone (보아치과 원장 v2). No
   * skeleton library is injected; the model reconstructs structure from a
   * pasted target screenshot (needs `input.image_paste`). The system prompt,
   * not a skeleton, drives the output. #278 layers the native browser 3
   * conditions (live_server preview, page→coach vision, agentic browser
   * control) onto this same tier — the reference site can be opened by URL,
   * not only pasted, and the coach drives the browser to clone it.
   */
  game: {
    template_tier: "kids-quest" | "kids-basic" | "kids-rich" | "teen" | "pro-3d" | "search-webapp" | "website";
  };
  publishing: {
    enabled: boolean;
    /**
     * `hypeproof_gallery` — the `/live/**` gallery on our own site. It does not
     * turn up in search (noindex), it is isolated by cohort-session code, and the
     * learning report sits separately behind a password.
     * It is a **different tier** from public GitHub Pages: that one is indexed and
     * permanent and we cannot take it back. For a minor cohort, the former is as
     * far as we can open it.
     */
    strategy: "per_user_github_pages" | "shared_repo" | "local_only" | "hypeproof_gallery";
    repo_template?: string;
    pages_branch?: string;
    shared_repo?: string;
  };
  assets_focus: AssetFocus[];
  /**
   * Deprecated compatibility bridge for v0.1 clients/tests that still expect
   * the old 16-essence numbering. New code should consume `assets_focus`.
   */
  essences_focus?: number[];
  /**
   * #168 M1 — Optional Studio-bundled meta-skills to inject into the cached
   * system prefix at chat time. Names must be present in
   * `worker/src/skills/index.ts` (typos fall through with a console.warn,
   * so the cohort behaves as un-skilled — debuggable, not crash-prone).
   */
  skills?: string[];
  /**
   * #168 M2 — Provider-hosted tools the profile opts into. The worker
   * translates these to the upstream provider's native tool format.
   *
   * - `web_search`: Anthropic `web_search_20250305` (server-hosted); the
   *   model can search the live web during a turn and inline citations into
   *   the response. Gemini native endpoint with `googleSearch` tool is
   *   tracked as follow-up — the prod path (LLM_PROVIDER=anthropic) is
   *   served by this flag today.
   * - `max_uses`: per-turn search call cap (default 5). Caps cost on a
   *   single user message.
   */
  tools?: {
    web_search?: boolean;
    max_uses?: number;
  };
  /**
   * #282 Phase 2 — Agent SDK workspace tools the coach may use when the Studio
   * runs on the agent-sdk runtime ("coach edits index.html directly"). The
   * PROFILE owns this policy (ADR 0003): the client maps these flags to SDK
   * tool names (read → Read/Grep/Glob, write → Write/Edit) and must never
   * widen beyond them.
   *
   * Absent = all false → the coach is chat-only (fail closed). There is
   * deliberately NO shell/exec flag in this schema — shell execution cannot be
   * granted by any cohort profile in Phase 2, period.
   *
   * MINOR-SAFETY INVARIANT: minors' cohorts (parent_coaching / kids tiers)
   * must NEVER set `write: true`. Enforced by the cohort harness
   * (`child_sdk_write` FAIL) and again client-side (write tools are stripped
   * for minor tiers regardless of this flag).
   *
   * `browser` (#282 P2 slice 2): grants the in-process "hypeproof" SDK MCP
   * browser tools (browser_open / browser_screenshot / live_preview_start)
   * built on the #309 native-browser + live-server work. browser_open always
   * passes the client URL policy (safeNavigateUrl) AND the approval modal.
   * Minors follow the #306/#318 safety posture: `browser: true` on a child
   * cohort is a harness FAIL (`child_sdk_browser`) until safe-session ships,
   * and the client strips it for minor tiers regardless.
   *
   * `subagents` (#282 P2 slice 3): grants the Agent SDK subagent feature —
   * the client defines two READ-ONLY Korean subagents ("코드리뷰어" /
   * "리서처") behind this flag and the coach can delegate to them via the
   * SDK's Agent/Task tool. Every delegation is modal-gated (delegation
   * judgment pedagogy) and every subagent tool call routes through the SAME
   * canUseTool policy as the parent. Definition tools are the INTERSECTION
   * of the definition's read-only wishlist and this cohort's permitted set —
   * a subagent can never widen beyond the profile. Minors: `subagents: true`
   * on a child cohort is a harness FAIL (`child_sdk_subagents`) until a
   * pedagogy decision lands, and the client strips it for minor tiers
   * regardless.
   */
  sdk_tools?: {
    read?: boolean;
    write?: boolean;
    browser?: boolean;
    subagents?: boolean;
    /**
     * epic #431 — the SDK Bash tool. ARBITRARY commands are permitted; the
     * approval modal is the gate (Claude Code's posture), because a narrow
     * allowlist makes the coach invent detours for anything off-list — the
     * same gap-filling that produced #428's fabricated `/app/workdir`.
     *
     * Only set this on adult workshop cohorts. Minor cohorts simply leave it
     * absent: there is no separate minor guard on this flag, the profile IS
     * the policy.
     */
    shell?: boolean;
  };
  /**
   * #371/#282 — coach runtime this cohort requests. "agent-sdk" gives the coach
   * real file Read/Write/Edit (durable task/rubric tracking, agentic loop);
   * "proxy" (default/absent) is the single-turn provider proxy. The worker
   * FORCES this to "proxy" for any minor cohort regardless of the value here
   * (see /profile), so only an adult, sdk_tools-opted-in cohort can reach the
   * file/exec-capable runtime. The client also honors the machine-scoped
   * `hypeproofChat.coachRuntime` setting and gates every tool via canUseTool.
   */
  coach_runtime?: "proxy" | "agent-sdk";
  /**
   * #278 Phase 3 — the client-driven agentic browser tool loop. When enabled,
   * the worker injects the browser control tools (lib/browser-tools.ts) into the
   * Anthropic tools array + a usage contract into the cached system prefix, and
   * the extension host executes each tool_use via CDP over the integrated
   * browser. Default off — only adult cohorts that need it opt in.
   */
  browser_control?: {
    enabled: boolean;
    max_iterations?: number;   // client loop cap hint (default 8)
  };
  /**
   * #306 — hardened native-browser session for minor cohorts. When `mode` is
   * `"safe"`, the Studio core (patches/62-hp-safe-session.patch in the
   * vscodium-base fork) backs the integrated browser with the locked-down
   * `persist:hp-safe` Electron session: every permission denied, downloads and
   * popups blocked, devtools disabled, and navigation confined to `allowlist`
   * (plus `file://`, `about:` and localhost, which are always permitted so the
   * participant's own pages / live_server preview keep working). Absent or
   * `"browse"` → the normal integrated browser (adult default; zero change).
   *
   * Inert until the fork patch ships in a build; the Studio extension sets the
   * matching `hypeproof.browser.safeSession` setting, which unpatched builds
   * simply ignore.
   */
  browser_session?: {
    mode: "safe" | "browse";
    allowlist?: string[];
  };
  session: {
    cohort_id: string;
    series_total: number;
    series_index: number;
    hours: number;
    /**
     * ADR 0010 step 2 — does `GET /v1/profile` require an open class session?
     *
     * Scope: this route ONLY. `/v1/chat/completions`, `/v1/messages`,
     * `/v1/observations/*` and `/v1/request-settings` call `gateChatRequest`
     * unconditionally and are not affected either way — a seat that reads its
     * profile before class still cannot send anything.
     *
     * It exists because the answer used to be `observation.enabled`. Nothing
     * about reading your cohort, greeting and model list depends on being
     * observed; the coupling was an accident of one boolean meaning four
     * things, and it is the one that would have flipped seven cohorts from
     * 200 to 403 the day `record` defaults on (ADR step 4).
     *
     * Absent → false: a seat may read its profile before the instructor opens
     * the class. Cohorts whose seat is only meaningful inside a session (the
     * individual trial, whose observation scope IS the session) declare true
     * and keep today's 403.
     */
    requires_open_session?: boolean;
  };
  /**
   * ADR 0010 step 2 — individual ("native") trial seats.
   *
   * Two things read this and they must agree: `POST /admin/tokens/issue` will
   * not mint a `native_trial` token for a cohort that does not declare it, and
   * `gateChatRequest` will not open a grant-backed session for one. Splitting
   * them is how a minted seat that 403s forever gets made, so they move
   * together.
   *
   * Absent → false (fail closed). It used to be `observation.enabled`, which
   * meant turning observation on for a kids cohort silently made that cohort
   * mintable as a personal trial — an admin-authority change riding on a
   * measurement change.
   */
  trial?: {
    individual: boolean;
  };
  analytics: {
    log_user_messages: boolean;     // store message bodies (privacy)
    log_metadata: boolean;          // store token usage + timing
    /**
     * #596 — does this cohort allow uploading the session-log spool on the
     * student's PC (#580) to R2? This is the point where the raw text of the
     * questions leaves the PC, so it is fail-closed: omitted/false = the server
     * refuses the upload. Only a cohort that has consent and a retention policy in
     * place turns it true (the same discipline as log_user_messages).
     */
    upload_session_logs?: boolean;
    /**
     * The consent assertion for a minor cohort turning the flag above on (harness
     * `child.upload_consent_key`). It is not verification, it is a **record of a
     * claim** — a string saying who secured consent and when. Absent → the harness
     * HARD FAILs.
     */
    child_upload_consent?: string;
  };
  /**
   * Per-cohort UX behavior. Drives the in-app chat panel without changing
   * client code — add a new cohort by adjusting these fields.
   */
  ux: UxConfig;
}

export interface UxConfig {
  coach: {
    /** How the participant gets a coach. */
    naming_mode: "user_names_it" | "fixed" | "pick_from_list";
    /** Used when naming_mode = "fixed", or as the placeholder/skip fallback. */
    fallback_name: string;
    /** Heading shown above the name input (markdown, short). */
    naming_prompt_md: string;
    /** Heading shown above the personality input. Leave empty to skip step. */
    personality_prompt_md: string;
    /** When true, the panel re-offers naming on each cohort entry (later sessions). */
    revisit_on_entry?: boolean;
  };
  suggestions: {
    /** Chips shown in the empty-chat state. */
    initial: SuggestionChip[];
    /** Chips shown after each assistant reply. */
    follow_up: SuggestionChip[];
  };
  hints: {
    /** Below-input nudge when the participant's draft is too brief. */
    short_input: {
      enabled: boolean;
      min_chars: number;
      message_md: string;
    };
    /** A small button that turns "vague" input into a guided expansion. */
    roll_input_button: {
      enabled: boolean;
      label: string;            // button text, e.g. "✨ 한 번 더 떠올려보기"
      probe_md: string;         // what the coach asks when clicked
    };
  };
  retry_button: {
    /** Show the small retry icon on assistant messages. */
    enabled: boolean;
    /** When true, an "Nth try" counter is shown — emphasizes Iteration reflex. */
    show_counter: boolean;
    /** Optional encouragement when the counter advances. Empty = no toast. */
    counter_toast_md?: string;
  };
}

export interface SuggestionChip {
  /** Display text. If the user clicks, this is dropped into the input box. */
  text: string;
  /**
   * - "good": highlighted; clickable.
   * - "weak": dimmed; non-clickable. Used to *show* what bad input looks like
   *   alongside good examples — pedagogical contrast.
   */
  style: "good" | "weak";
  /** Optional micro-caption shown under the chip ("이건 너무 막연해요"). */
  caption?: string;
}

export type ModelAlias =
  | "hypeproof-fast"
  | "hypeproof-default"
  | "hypeproof-strong";

// The 7 AI Native Assets — single source of truth. Tooling (scaffold-profile.ts)
// imports this array instead of re-listing the values; the AssetFocus union is
// derived from it so adding an asset here updates both the type and the runtime
// enum. The cohort-harness validator keeps a Python copy in rules.yaml (`assets`)
// — kept in sync by hand (see the keep-in-sync note there).
export const ASSET_FOCUS = [
  "taste",
  "intent_clarity",
  "context_design",
  "verification_reflex",
  "delegation_judgment",
  "iteration_reflex",
  "ownership",
] as const;

export type AssetFocus = (typeof ASSET_FOCUS)[number];

// Anthropic model ids (used when LLM_PROVIDER=anthropic).
//
// `as const satisfies` on purpose (#687): the literal union below is what makes
// MODEL_CAPS in routes/messages.ts exhaustive. Repinning an alias to a model
// with no capability entry then fails TYPECHECK, instead of quietly reaching a
// fail-closed branch and stripping effort in a live classroom.
export const MODEL_MAP = {
  "hypeproof-fast":    "claude-haiku-4-5",
  "hypeproof-default": "claude-sonnet-4-6",
  "hypeproof-strong":  "claude-opus-4-7",
} as const satisfies Record<ModelAlias, string>;

/** Reviewed version catalogue. Existing provider-neutral alias pins above stay unchanged.
 * 2026-09-08: official model IDs + authenticated Models API; execution evidence in #792. */
export const ANTHROPIC_MODELS = {
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
  'claude-opus-5': 'Claude Opus 5',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-opus-4-5-20251101': 'Claude Opus 4.5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
} as const;
export type AnthropicModelId = keyof typeof ANTHROPIC_MODELS;
// Explicit GPT choices; legacy provider-neutral pins remain unchanged.
// Official model docs and local Codex model/list verified 2026-09-08 (#828).
export const OPENAI_MODELS = {
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
} as const;
export type OpenAIModelId = keyof typeof OPENAI_MODELS;
export const GEMINI_MODELS = { 'gemini-2.5-flash': 'Gemini 2.5 Flash', 'gemini-3.5-flash': 'Gemini 3.5 Flash' } as const;
export const GLM_MODELS = { 'glm-5.2': 'GLM 5.2' } as const;
export type ModelKey = ModelAlias | AnthropicModelId | OpenAIModelId | keyof typeof GEMINI_MODELS | keyof typeof GLM_MODELS;

export function explicitModelProvider(key: string): LLMProvider | undefined {
  if (Object.hasOwn(ANTHROPIC_MODELS, key)) return 'anthropic';
  if (Object.hasOwn(OPENAI_MODELS, key)) return 'openai';
  if (Object.hasOwn(GEMINI_MODELS, key)) return 'gemini';
  if (Object.hasOwn(GLM_MODELS, key)) return 'glm';
}

export function crossProviderEnabled(profile: Profile): boolean {
  return profile.model.cross_provider === true && profile.coach_runtime === 'proxy'
    && profile.minor_cohort === false && (profile.audience.age_range?.[0] ?? 0) >= 18;
}

export function permittedModelKeys(profile: Profile): ModelKey[] {
  return [...new Set([profile.model.default, ...(profile.model.allowed ?? (profile.model.fallback ? [profile.model.fallback] : []))])];
}

// Gemini model ids (default provider). Same alias names so profiles are
// provider-agnostic — the alias resolves per-provider at request time.
//
// Pin policy (#307): gemini-2.5-pro was retired for new API keys (upstream
// 404 "no longer available to new users"), which killed the default/strong
// aliases. Repinned to gemini-3.5-flash — the newest GA flash, verified live
// on the OpenAI-compat endpoint 2026-07-13. No pro-class GA id exists today
// (gemini-3.x pro are all `-preview`), so strong shares the flash pin.
export const GEMINI_MODEL_MAP: Record<ModelAlias, string> = {
  "hypeproof-fast":    "gemini-2.5-flash",
  "hypeproof-default": "gemini-3.5-flash",
  "hypeproof-strong":  "gemini-3.5-flash",
};

// OpenAI model ids (third peer). Conservative GA-stable defaults; the team
// can point any alias at a newer GA flagship (e.g. gpt-5*) with a one-line
// edit here — profiles stay untouched.
// All three aliases point at gpt-5.6-luna — the same reason and the same shape as
// GLM_MODEL_MAP.
//
// 2026-09-10 correction: this table was pointing at `gpt-4o-mini`/`gpt-4o`.
// `OPENAI_MODELS` right above is the gpt-5.6 family, checked on 2026-09-08 against
// the official docs + `codex model/list`, but the alias path alone was stuck a
// generation back. It was not dead code either — a profile with no
// `model.provider` (six of them: the kids and dental cohorts among others) has its
// provider decided by env `LLM_PROVIDER`, so in an environment with
// `LLM_PROVIDER=openai` (this repo's test-harness default) `hypeproof-default`
// actually translated to `gpt-4o`. Production runs `LLM_PROVIDER=anthropic` so it
// was not exposed there — but adding one more openai-provider profile, a
// **perfectly natural change**, would have quietly started using a
// previous-generation model.
//
// The fast/default/strong **split has not been decided for the OpenAI side yet.**
// Nothing in this repo justifies reading a strength order out of the names
// luna·terra·sol, and a guess put in here hardens into a contract. So all three are
// collected on the one there is evidence for (the default `studio-gpt-practice`
// declares). The day the split is actually needed, look at `OPENAI_MODELS` and
// decide **explicitly**.
export const OPENAI_MODEL_MAP: Record<ModelAlias, string> = {
  "hypeproof-fast":    "gpt-5.6-luna",
  "hypeproof-default": "gpt-5.6-luna",
  "hypeproof-strong":  "gpt-5.6-luna",
};

// GLM (Z.ai) model ids. For now all three aliases point at glm-5.2 — 5.2 is the
// flagship and there is no reason yet to use a lower model in the family. GLM-5.3
// shipped on 2026-08-14 but its general pay-as-you-go API is still "coming soon",
// so it cannot go in here (hypeprooflab#545). When 5.3's per-token API opens, only
// this one line changes — the base model is the same family.
export const GLM_MODEL_MAP: Record<ModelAlias, string> = {
  "hypeproof-fast":    "glm-5.2",
  "hypeproof-default": "glm-5.2",
  "hypeproof-strong":  "glm-5.2",
};

export function modelIdFor(key: ModelKey, provider: LLMProvider): string {
  if (Object.hasOwn(GEMINI_MODELS, key) || Object.hasOwn(GLM_MODELS, key)) {
    if (explicitModelProvider(key) !== provider) throw new Error('model is unavailable for this provider');
    return key;
  }
  if (Object.hasOwn(ANTHROPIC_MODELS, key)) {
    if (provider !== 'anthropic') throw new Error('model is unavailable for this provider');
    return key;
  }
  if (Object.hasOwn(OPENAI_MODELS, key)) {
    if (provider !== 'openai') throw new Error('model is unavailable for this provider');
    return key;
  }
  const alias = key as ModelAlias;
  switch (provider) {
    case "gemini":    return GEMINI_MODEL_MAP[alias];
    case "openai":    return OPENAI_MODEL_MAP[alias];
    case "glm":       return GLM_MODEL_MAP[alias];
    case "anthropic": return MODEL_MAP[alias];
  }
}
