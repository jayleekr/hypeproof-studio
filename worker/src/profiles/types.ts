// Per-cohort profile schema. To add a new cohort (e.g. dental, corporate AX),
// create a new module under profiles/ that exports a Profile and register it
// in profiles/index.ts. No other code changes required.

import type { LLMProvider } from "../env.ts";

export interface Profile {
  id: string;
  version: number;
  display_name: string;
  audience: {
    age_range?: [number, number];
    language: "ko" | "en";
    parent_coaching: boolean;
  };
  model: {
    default: ModelAlias;
    fallback?: ModelAlias;
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
    file_write: boolean;
    workspace_root?: string;
    execute_shell: boolean;
    mcp_tools_enabled: string[];    // empty array = no tools
  };
  preview: {
    type: "iframe" | "live_server";
    auto_start: boolean;
  };
  /**
   * Optional input capabilities — all default off so minor cohorts never expose
   * them unless a profile opts in. `page_context` (#278) lets "현재 페이지를
   * 코치에게" inject the native browser tab's content into a chat turn.
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
   * not a skeleton, drives the output.
   *
   * Homepage tier "homepage" (#278) — 보아치과 홈페이지 만들기. Adult builds a
   * real multi-file clinic homepage *from scratch by conversation* (distinct
   * from "website" copyclone). No skeleton is injected — structure is taught
   * by the cohort system prompt, and `preview.type: "live_server"` + the
   * browser tools drive the workflow.
   */
  game: {
    template_tier: "kids-basic" | "kids-rich" | "teen" | "pro-3d" | "search-webapp" | "website" | "homepage";
  };
  publishing: {
    enabled: boolean;
    strategy: "per_user_github_pages" | "shared_repo" | "local_only";
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
  session: {
    cohort_id: string;
    series_total: number;
    series_index: number;
    hours: number;
  };
  analytics: {
    log_user_messages: boolean;     // store message bodies (privacy)
    log_metadata: boolean;          // store token usage + timing
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
export const MODEL_MAP: Record<ModelAlias, string> = {
  "hypeproof-fast":    "claude-haiku-4-5",
  "hypeproof-default": "claude-sonnet-4-6",
  "hypeproof-strong":  "claude-opus-4-7",
};

// Gemini model ids (default provider). Same alias names so profiles are
// provider-agnostic — the alias resolves per-provider at request time.
export const GEMINI_MODEL_MAP: Record<ModelAlias, string> = {
  "hypeproof-fast":    "gemini-2.5-flash",
  "hypeproof-default": "gemini-2.5-pro",
  "hypeproof-strong":  "gemini-2.5-pro",
};

// OpenAI model ids (third peer). Conservative GA-stable defaults; the team
// can point any alias at a newer GA flagship (e.g. gpt-5*) with a one-line
// edit here — profiles stay untouched.
export const OPENAI_MODEL_MAP: Record<ModelAlias, string> = {
  "hypeproof-fast":    "gpt-4o-mini",
  "hypeproof-default": "gpt-4o",
  "hypeproof-strong":  "gpt-4o",
};

export function modelIdFor(alias: ModelAlias, provider: LLMProvider): string {
  switch (provider) {
    case "gemini":    return GEMINI_MODEL_MAP[alias];
    case "openai":    return OPENAI_MODEL_MAP[alias];
    case "anthropic": return MODEL_MAP[alias];
  }
}
