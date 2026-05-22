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
    auto_start: true,
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
      // 직군별 실 검색 문제 — 자기 업무에서 반복·헷갈림·확인필요한 것.
      // weak 칩으로 막연한 입력의 모양을 *대비*로 보여준다 (Intent Clarity 학습).
      initial: [
        { text: "환자가 임플란트 후 운동 언제부터 되냐고 자주 물어봐요 — 답변 근거 찾기", style: "good", caption: "위생사" },
        { text: "스케일링 후 주의사항 안내문 — 공식 학회 자료 기반으로 정리", style: "good", caption: "위생사" },
        { text: "리뷰 답글 톤이 매번 다른데 우리 병원 표준 표현으로 정리하고 싶어요", style: "good", caption: "코디" },
        { text: "임플란트 신제품 후보 3개 비교 — 우리 케이스에 맞는 기준으로", style: "good", caption: "사모님" },
        { text: "치과 관련 질문 답해줘", style: "weak", caption: "어떤 결정에 쓸지 모르면 검색이 안 잡혀요." },
      ],
      // 5블록 흐름의 다음 한 수 — 7 AI Native Assets 행동 + V1 first-shot action.
      // 첫 chip은 의도적으로 V1 즉시 만들기 (#157) — 참가자가 reframe loop에
      // 갇히지 않도록.
      follow_up: [
        { text: "이걸로 V1 한 번 만들어줘 — 우측에 띄워줘", style: "good", caption: "V1 First Shot" },
        { text: "이걸 무슨 결정에 쓸지 한 줄로 다시 써줘", style: "good", caption: "Intent Clarity (E7)" },
        { text: "환자군·상황·금지표현·판단 기준을 처음부터 풀로 적어줘", style: "good", caption: "Context Design (E2)" },
        { text: "검색어를 한국어·영어·전문용어 3가지로 변주해줘", style: "good", caption: "Iteration Reflex (E9)" },
        { text: "이 검색을 *틀리게* 만드는 가장 확실한 방법은?", style: "good", caption: "Verification Reflex (E11)" },
        { text: "환자용 / 내부용 / 원장님 컨펌용 표현으로 각각 한 줄씩", style: "good", caption: "Taste (E13)" },
        { text: "방금 깨진 이유를 다음 검색에 자동 적용될 규칙으로 저장해줘", style: "good", caption: "Ownership (E14)" },
        { text: "이건 AI가 결론 내릴 일이 아닌 것 같아 — 원장님께 물어볼 질문으로 바꿔줘", style: "good", caption: "Delegation Judgment (E12)" },
      ],
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
