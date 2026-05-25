import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/boah-dental-teaser-2026-s1.md";

// 보아치과 HypeProof 티저 (2026-05-26). 단발 ~60–90분 체험 세션.
//
// #77: dental supersearch curriculum v4 applied (replaces #13 4-principle
// game frame). The teaser is now a "원장님을 이겨라!" 해커톤 — 직원이
// 치과 지식 슈퍼서치엔진 V1을 만들고 원장님이 PASS/더 확인/위험으로 판정 →
// 깨진 이유가 병원 검색 규칙으로 저장. v3 게임 만들기 프레임은 폐기.
//
// 7 AI Native Assets → Essence 매핑 (vs docs/essence-v0.1.md):
//   Intent Clarity     → Essence 7  (질문으로 공터 만들기)
//   Context Design     → Essence 2  (전심전력)
//   Delegation Judgment→ Essence 12 (수행과 위임의 역전)
//   Iteration Reflex   → Essence 9  (백 번 뽑아보기)
//   Verification Reflex→ Essence 11 (역목표 설계)
//   Taste              → Essence 13 (추상의 사다리)
//   Ownership          → Essence 14 (언러닝)
// → essences_focus = [2, 7, 9, 11, 12, 13, 14].
//
// game.template_tier: v4 산출물은 검색 웹앱. 전용 "search-webapp" tier로 #150
// 에서 분리 (이전엔 kids-basic placeholder로 인해 LLM 응답에 게임 frame 잔재 leak
// #141 발생). search-webapp tier는 게임 루프 없이 정적 HTML/CSS/JS — 검색·필터·
// 출처 신뢰도 UI가 핵심.
// Source: JinyongShin/hypeproof_kids_edu PR #11
// (kids_edu_vault/wiki/specs/track-b/dental-supersearch-curriculum-v4.md).
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
    greeting_md: "안녕하세요! 오늘은 **치과 지식 슈퍼서치엔진**을 함께 만들어요 🔍\n마지막엔 **원장님을 이겨봅니다.**",
    example_prompts: [
      "환자가 임플란트 후 운동 언제부터 되냐고 자주 물어봐요 — 답변 근거 찾기",
      "리뷰 답글 톤이 매번 다른데 우리 병원 표준 표현으로 정리하고 싶어요",
      "스케일링 후 주의사항 안내문 — 공식 학회 자료 기반으로 정리",
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
    // #198 — auto-open이 비결정적 (tryReveal 스트림 race + 닫는 펜스 누락
    // 케이스). v0.1.10 ChatPanel.tsx에 이미 `▶ Run` 버튼이 HTML 응답마다
    // 노출되므로 학생이 명시적으로 트리거. 결정적 + 학생 통제. v2 polish
    // (".app rebuild 필요한 chip 스타일 + 라벨 ▶ Run → 🖼 미리보기) 는
    // epic #200 Stratum 4에서 v0.1.11 출시 시 동반.
    auto_start: false,
  },
  game: {
    // v4 산출물은 검색 웹앱 — #150에서 search-webapp tier로 분리. 게임 frame
    // 잔재 leak (#141) 제거 + sw-dental-v1 skeleton이 system prompt에 inject됨.
    template_tier: "search-webapp",
  },
  publishing: {
    // 단발 티저 — per-user GitHub Pages 불필요. 로컬 미리보기로 충분.
    enabled: false,
    strategy: "local_only",
  },
  // 7 AI Native Assets ↔ essence (위 헤더 매핑 표 참조).
  essences_focus: [2, 7, 9, 11, 12, 13, 14],
  // #168 M1 — Studio-bundled meta-skill. When the worker assembles the
  // cached system prefix it appends `worker/src/skills/<name>.md` for each
  // entry. boa-search-skill-creator drives the 7-asset coaching flow.
  skills: ["boa-search-skill-creator"],
  // #168 M2 — Anthropic web_search ON. The v4 workshop ("원장님을 이겨라")
  // needs live search results + citations for the boss-fight verdict. max_uses
  // caps per-turn cost; 5 is comfortable for a single query exploration loop.
  tools: { web_search: true, max_uses: 5 },
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
      // #168 M4 (option B per #174 comment): boa-search-skill-creator 메타-스킬이
      // system prompt에 bundled되어 7자산 Q&A 흐름을 *대화로* 진행한다. 옛 8개
      // follow_up chip은 그 흐름과 경쟁 + 옛 게임 프레임 잔재 인상 → 제거.
      // 빈 화면에서 학생이 막히지 않게 *시작 한 칩*만 남김. 다른 cohort 무영향.
      initial: [
        { text: "검색 스킬 만들고 싶어 — 같이 시작해줘", style: "good", caption: "이렇게 시작해보세요" },
      ],
      follow_up: [],
    },
    hints: {
      short_input: {
        enabled: true,
        min_chars: 5,
        message_md: "💭 조금 더 구체적으로 — *환자가 묻는 것·내가 헷갈리는 것·확인 필요한 결정* 중 하나라도요",
      },
      roll_input_button: {
        enabled: true,
        label: "✨ 한 번 더 다듬어보기",
        probe_md: "좋아요! 한 가지만 더 — 이 검색이 도와야 하는 *결정*은 뭔가요?",
      },
    },
    retry_button: {
      enabled: true,
      show_counter: false,
    },
  },
};
