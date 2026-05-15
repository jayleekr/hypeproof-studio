import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/sk-biopharm-kids-s1.md";

export const profile: Profile = {
  id: "sk-biopharm-kids-2026-grade-3-4-s1",
  version: 1,
  display_name: "SK바이오팜 가족 워크숍 (3-4학년) — 1회차",
  audience: {
    age_range: [8, 10],
    language: "ko",
    parent_coaching: true,
  },
  model: {
    default: "hypeproof-default",       // Sonnet for higher quality; switch to fast if cost pressure
    fallback: "hypeproof-fast",
  },
  system_prompt: systemPromptMd as unknown as string,
  welcome: {
    greeting_md: "안녕하세요! 오늘 같이 게임을 만들어봐요 🎮",
    example_prompts: [
      "삼각형이 점프하는 게임 만들어줘",
      "별이 떨어지는 게임을 만들고 싶어요",
      "캐릭터 색을 무지개로 바꿔줘",
    ],
  },
  sandbox: {
    file_write: true,
    workspace_root: "~/HypeProofGames",
    execute_shell: false,
    mcp_tools_enabled: [],              // 1회차는 chat-only per L3 decision
  },
  preview: {
    type: "live_server",
    auto_start: true,
  },
  publishing: {
    enabled: true,
    strategy: "per_user_github_pages",
    repo_template: "my-hypeproof-games",
    pages_branch: "main",
  },
  essences_focus: [1, 2, 5, 7, 16],
  session: {
    cohort_id: "sk-biopharm-2026-a",
    series_total: 4,
    series_index: 1,
    hours: 8,
  },
  analytics: {
    log_user_messages: false,
    log_metadata: true,
  },
};
