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
   * Which pre-built skeleton library the model customizes from.
   *
   * Game tiers (kids-basic → kids-rich → teen → pro-3d) — for kids/teen
   * cohorts; model picks closest game skeleton and swaps theme/characters/colors.
   *
   * Workshop tier "search-webapp" — for clinical/professional workshops
   * (e.g. 보아치과 v4); model fills %%CLINIC_NAME%%/%%SEARCH_TOPIC%%/
   * %%DECISION%%/%%SOURCES%% in the static webapp skeleton, no game loop.
   */
  game: {
    template_tier: "kids-basic" | "kids-rich" | "teen" | "pro-3d" | "search-webapp";
  };
  publishing: {
    enabled: boolean;
    strategy: "per_user_github_pages" | "shared_repo" | "local_only";
    repo_template?: string;
    pages_branch?: string;
    shared_repo?: string;
  };
  essences_focus: number[];          // 1..16
  /**
   * #168 M1 — Optional Studio-bundled meta-skills to inject into the cached
   * system prefix at chat time. Names must be present in
   * `worker/src/skills/index.ts` (typos fall through with a console.warn,
   * so the cohort behaves as un-skilled — debuggable, not crash-prone).
   */
  skills?: string[];
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
    /** When true, an "Nth try" counter is shown — emphasizes essence 9 (백 번 뽑기). */
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
