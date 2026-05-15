// Per-cohort profile schema. To add a new cohort (e.g. dental, corporate AX),
// create a new module under profiles/ that exports a Profile and register it
// in profiles/index.ts. No other code changes required.

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
  publishing: {
    enabled: boolean;
    strategy: "per_user_github_pages" | "shared_repo" | "local_only";
    repo_template?: string;
    pages_branch?: string;
    shared_repo?: string;
  };
  essences_focus: number[];          // 1..16
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
}

export type ModelAlias =
  | "hypeproof-fast"
  | "hypeproof-default"
  | "hypeproof-strong";

export const MODEL_MAP: Record<ModelAlias, string> = {
  "hypeproof-fast":    "claude-haiku-4-5",
  "hypeproof-default": "claude-sonnet-4-6",
  "hypeproof-strong":  "claude-opus-4-7",
};
