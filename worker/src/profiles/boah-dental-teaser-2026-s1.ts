import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/boah-dental-teaser-2026-s1.md";

// 보아치과 HypeProof 티저 (2026-05-26, D-7 강의). 단발 ~3h 체험 세션.
//
// #13: 4-principle experiential curriculum applied. The teaser embodies four
// essences (authoritative mapping vs docs/essence-v0.1.md):
//   전심전력 → Essence 2 · 만족유예 → Essence 4 ·
//   잇기가설 → Essence 6 · 역목표 → Essence 11
// → essences_focus = [2, 4, 6, 11]; system prompt rewritten experiential;
//   follow-up suggestions nudge 만족유예/역목표/잇기.
// Skeleton: intentionally unchanged — the 4 principles are taught via prompt +
// UX (not a bespoke dental skeleton); keeps scope tight + skeleton contract
// test green. Assumptions still flagged for curriculum review (봉호): adult
// audience, single session, publishing disabled, template_tier reuses tier.
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
  // 4원칙 ↔ essence (vs docs/essence-v0.1.md): 전심전력=2 · 만족유예=4 ·
  // 잇기가설=6 · 역목표=11.
  essences_focus: [2, 4, 6, 11],
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
        // 4원칙 체험형 넛지: 만족유예(4) · 역목표(11) · 잇기(6) · 전심전력(2)
        { text: "더 좋아질 수 있을 것 같아 — 한 번 더 밀어붙여줘", style: "good", caption: "만족 유예: 적정선까지 더 추궁" },
        { text: "이걸 일부러 재미없게 만드는 방법을 보여줘", style: "good", caption: "역목표: 약점을 드러내기" },
        { text: "내가 잘 모르는 부분은 네가 가설로 이어줘", style: "good", caption: "잇기: 못 해도 모델은 잇는다" },
        { text: "색을 더 밝고 선명하게 바꿔줘", style: "good" },
        { text: "소리 효과를 추가해줘", style: "good" },
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
