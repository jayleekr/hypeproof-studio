import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/sk-biopharm-kids-s1.md";

export const profile: Profile = {
  id: "sk-biopharm-kids-2026-grade-3-4-s1",
  version: 1,
  display_name: "SK바이오팜 가족 워크숍 (3-4학년) — 1회차",
  audience: {
    age_range: [9, 10],
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
  game: {
    template_tier: "kids-basic",   // 초3-4. 5-6학년 profile은 "kids-rich"로.
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
  ux: {
    // 1회차 Foundation: "입력이 결과를 결정한다". UX 전체가 자녀에게
    //   "자세히 말하면 멋진 게 나온다"를 몸으로 가르치는 도구.
    coach: {
      naming_mode: "user_names_it",
      fallback_name: "코치",
      naming_prompt_md: "같이 게임 만들 친구의 **이름**을 지어주세요 🎮",
      personality_prompt_md: "이 친구는 어떤 친구예요? *(예: 친절한 친구, 엉뚱한 친구. 건너뛰어도 괜찮아요)*",
      revisit_on_entry: false,
    },
    suggestions: {
      // 자세한 vs 막연한 대비. 자녀가 좋은 입력 모양을 패턴 매칭으로 학습.
      // 작은 스코프부터 → 자녀가 첫 시도에 성공 경험.
      initial: [
        { text: "원이 좌우로 움직이는 화면 만들어줘", style: "good" },
        { text: "별이 떨어지고 클릭하면 점수가 오르는 게임", style: "good" },
        { text: "고양이가 점프해서 생선을 먹는 게임", style: "good" },
        { text: "노란 캐릭터가 빨간 적을 피하는 게임", style: "good" },
        { text: "재밌게 만들어줘", style: "weak", caption: "어떤 게 재밌어야 할지 모르겠어요. 자세히!" },
      ],
      // 모두 명령형 — 질문형("...하면 어떻게 돼?")은 AI가 코드 대신 되묻게
      // 만들어 화면이 빈 채로 남는다. 1회차는 "말하면 바로 바뀐다" 체험이 핵심.
      follow_up: [
        { text: "색을 더 밝고 예쁘게 바꿔줘", style: "good" },
        { text: "소리 효과를 추가해줘", style: "good" },
        { text: "점점 빨라지게 해줘", style: "good" },
        { text: "캐릭터를 내가 좋아하는 동물로 바꿔줘", style: "good" },
        { text: "적을 한 명 더 추가해줘", style: "good" },
      ],
    },
    hints: {
      short_input: {
        enabled: true,
        min_chars: 5,
        message_md: "💭 조금 더 자세히 알려줄래요? *주인공·움직임·점수* 같은 걸요",
      },
      roll_input_button: {
        enabled: true,
        label: "✨ 한 번 더 떠올려보기",
        probe_md: "좋아요! 한 가지만 더 떠올려보세요 — 캐릭터 모양? 색? 점수 규칙?",
      },
    },
    retry_button: {
      // 1회차: 버튼은 보이지만 카운터 숨김. 자녀가 자연스럽게 발견하는 게 목표.
      // 2회차 Load(만족유예)에서 show_counter true로 켜져 의미가 노출됨.
      enabled: true,
      show_counter: false,
    },
  },
};
