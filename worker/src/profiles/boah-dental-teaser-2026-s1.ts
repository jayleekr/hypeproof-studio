import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/boah-dental-teaser-2026-s1.md";

// 보아치과 HypeProof 티저 (2026-05-26, D-7 강의). 단발 ~3h 체험 세션.
//
// NOTE (scope split): this is the *baseline* profile so the cohort is
// registered and token-issuable now (issue #12). The 4-principle experiential
// curriculum (전심전력·역목표·만족유예·잇기가설) — system prompt + skeleton
// content + the authoritative essences_focus mapping — is issue #13 and will
// enrich `prompts/boah-dental-teaser-2026-s1.md` + `essences_focus` here.
// Assumptions flagged for curriculum review (봉호): adult audience, single
// session, publishing disabled, template_tier reuses the only existing tier.
export const profile: Profile = {
  id: "boah-dental-teaser-2026-s1",
  version: 1,
  display_name: "보아치과 — HypeProof 티저 (2026-05-26)",
  audience: {
    age_range: [20, 60],
    language: "ko",
    parent_coaching: false,
  },
  model: {
    default: "hypeproof-default",
    fallback: "hypeproof-fast",
  },
  system_prompt: systemPromptMd as unknown as string,
  welcome: {
    greeting_md: "안녕하세요! 오늘은 직접 말로 지시해서 작은 게임을 함께 만들어봐요 🎮",
    example_prompts: [
      "공이 좌우로 움직이는 화면 만들어줘",
      "별이 떨어지고 클릭하면 점수가 오르는 게임",
      "캐릭터가 장애물을 피하는 게임 만들어줘",
    ],
  },
  sandbox: {
    file_write: true,
    workspace_root: "~/HypeProofTeaser",
    execute_shell: false,
    mcp_tools_enabled: [],
  },
  preview: {
    type: "live_server",
    auto_start: true,
  },
  game: {
    // 현재 유일 tier. 치과 티저 전용 스켈레톤이 필요하면 #13/커리큘럼에서 결정.
    template_tier: "kids-basic",
  },
  publishing: {
    // 단발 티저 — per-user GitHub Pages 불필요. 로컬 미리보기로 충분.
    enabled: false,
    strategy: "local_only",
  },
  // baseline: 알려진 유효 essence 집합 재사용. 4원칙 ↔ essence 권위 매핑은 #13.
  essences_focus: [1, 2, 5, 7, 16],
  session: {
    cohort_id: "boah-dental-2026-a",
    series_total: 1,
    series_index: 1,
    hours: 3,
  },
  analytics: {
    log_user_messages: false,
    log_metadata: true,
  },
  ux: {
    coach: {
      // 단발 티저: 네이밍 단계 생략(빈 prompt) — 마찰 최소화, 바로 체험.
      naming_mode: "fixed",
      fallback_name: "코치",
      naming_prompt_md: "",
      personality_prompt_md: "",
      revisit_on_entry: false,
    },
    suggestions: {
      initial: [
        { text: "공이 좌우로 움직이는 화면 만들어줘", style: "good" },
        { text: "별이 떨어지고 클릭하면 점수가 오르는 게임", style: "good" },
        { text: "캐릭터가 장애물을 피하는 게임 만들어줘", style: "good" },
        { text: "재밌게 만들어줘", style: "weak", caption: "무엇이 재밌어야 할지 알 수 없어요. 더 구체적으로!" },
      ],
      follow_up: [
        { text: "색을 더 밝고 선명하게 바꿔줘", style: "good" },
        { text: "소리 효과를 추가해줘", style: "good" },
        { text: "점점 빨라지게 해줘", style: "good" },
        { text: "장애물을 하나 더 추가해줘", style: "good" },
      ],
    },
    hints: {
      short_input: {
        enabled: true,
        min_chars: 5,
        message_md: "💭 조금 더 구체적으로 알려주세요 — *주인공·움직임·점수* 중 하나라도요",
      },
      roll_input_button: {
        enabled: true,
        label: "✨ 한 번 더 떠올려보기",
        probe_md: "좋아요! 한 가지만 더 — 캐릭터 모양? 색? 점수 규칙?",
      },
    },
    retry_button: {
      enabled: true,
      show_counter: false,
    },
  },
};
