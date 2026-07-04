import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/boah-dental-director-copyclone-2026-s1.md";

// 보아치과 원장 website-copyclone (v2). 단발 ~3.5시간 해커톤.
//
// 같은 cohort(`boah-dental-2026-a`)의 두 번째 트랙 — 직원 teaser
// (boah-dental-teaser-2026-s1, search-webapp)와 나란히 도는 병렬 단발 트랙이다
// (SK 2-트랙 패턴: 같은 cohort_id, series_total 일치, profile_id로만 분기).
// teaser는 직원이 검색엔진을 만들고, 이 트랙은 원장이 "잘 만든 홈페이지 정답지"를
// 스크린샷으로 붙여 그 겉껍데기를 클론한다. 베끼기가 아니라 벤치마킹.
// 출처: HypeProof Lab — dental-website-copyclone-v2 (2026-06-21 draft).
//
// 핵심 차이:
//   - input.image_paste: true  → 타겟 스크린샷을 모델에 맥락 주입 (이 트랙의 전제)
//   - game.template_tier: "website" → 스켈레톤 라이브러리 미주입. 구조는 정답지
//     (스크린샷)에서 오고 system prompt가 행동을 전부 드라이브한다.
//   - publishing: local_only/false — Studio 퍼블리시 위저드는 별도 스프린트.
//     실제 배포는 워크숍 후반 외부 도구 단계(이 프로필 범위 밖).
//
// 7 AI Native Assets focus: Context Design · Taste · Verification 전면 강화,
// 나머지 4종 유지. `essences_focus`는 v0.1 호환 브리지로만 남겨둔다.
export const profile: Profile = {
  id: "boah-dental-director-copyclone-2026-s1",
  version: 1,
  display_name: "보아치과 — 원장 웹사이트 카피클론 (v2)",
  audience: {
    age_range: [30, 65],
    language: "ko",
    parent_coaching: false,
  },
  model: {
    default: "hypeproof-default",   // claude-sonnet-4-6 — vision + 견고한 HTML 생성
    fallback: "hypeproof-fast",
  },
  system_prompt: systemPromptMd as unknown as string,
  welcome: {
    greeting_md:
      "안녕하세요! 오늘은 **잘 만든 치과 홈페이지를 정답지 삼아 내 병원 화면으로 클론**해요 🌐\n참고할 화면을 **스크린샷으로 붙여넣기(⌘V)** 하면 바로 시작할 수 있어요.",
    example_prompts: [
      "참고 사이트 스크린샷을 붙여넣고 — 이 화면처럼 우리 병원 홈페이지 골격을 만들어줘",
      "Hero 섹션을 이 톤으로, 진료과목은 우리 병원 5개로 바꿔줘",
      "로고·사진은 데모 자리표시자로 두고 의료광고 과장 표현은 빼줘",
    ],
  },
  sandbox: {
    file_write: true,
    workspace_root: "~/HypeProofClinic",
    execute_shell: false,
    mcp_tools_enabled: [],
  },
  preview: {
    // 정적 웹사이트 — live_server로 미리보기. auto_start는 비결정성(#198) 때문에
    // off, 학생이 HTML 응답마다 노출되는 ▶ Run으로 명시적으로 띄운다.
    type: "live_server",
    auto_start: false,
  },
  game: {
    // website-copyclone tier — 스켈레톤 미주입(구조는 스크린샷에서). #141류 프레임
    // 누수 방지: getSkeletonsForTier("website")가 []를 반환 → buildSkeletonLibrary "".
    template_tier: "website",
  },
  publishing: {
    enabled: false,
    strategy: "local_only",
  },
  assets_focus: [
    // v2 전면 강화 3종 먼저
    "context_design",
    "taste",
    "verification_reflex",
    // 유지 4종
    "intent_clarity",
    "iteration_reflex",
    "delegation_judgment",
    "ownership",
  ],
  // Deprecated v0.1 bridge (teaser와 동일 매핑) — 신규 코드는 assets_focus 사용.
  essences_focus: [2, 7, 9, 11, 12, 13, 14],
  // website-copyclone의 핵심 전제: 타겟 스크린샷 맥락 주입. 성인(원장/직원) cohort라
  // 켠다. 미성년 cohort는 default OFF (COHORT-AUTHORING 가드레일 §5).
  input: {
    image_paste: true,
  },
  session: {
    cohort_id: "boah-dental-2026-a",   // teaser와 같은 cohort, profile_id로만 분기
    series_total: 1,                   // 단발 — cohort 내 모든 profile의 series_total 일치(validator 강제)
    series_index: 1,                   // teaser와 병렬 트랙 (둘 다 series_index 1)
    hours: 4,
  },
  analytics: {
    log_user_messages: false,          // PII 동의·보존정책 전까지 전 cohort 고정 false
    log_metadata: true,
  },
  ux: {
    coach: {
      // 단발 해커톤: 네이밍 단계 생략 — 마찰 최소화, 바로 클론.
      naming_mode: "fixed",
      fallback_name: "코치",
      naming_prompt_md: "",
      personality_prompt_md: "",
      revisit_on_entry: false,
    },
    suggestions: {
      initial: [
        {
          text: "참고할 치과 홈페이지 스크린샷을 붙여넣고 — 이 화면처럼 만들어줘",
          style: "good",
          caption: "이렇게 시작해보세요 (⌘V로 이미지 붙여넣기)",
        },
      ],
      follow_up: [],
    },
    hints: {
      short_input: {
        enabled: true,
        min_chars: 5,
        message_md:
          "💭 조금 더 구체적으로 — *어느 섹션*을 *어떤 톤*으로, 또는 *참고 화면 스크린샷*을 붙여주세요",
      },
      roll_input_button: {
        enabled: true,
        label: "✨ 한 번 더 다듬어보기",
        probe_md: "좋아요! 한 가지만 더 — 이 화면으로 환자가 하길 바라는 *행동*(전화·예약·약도)은 뭔가요?",
      },
    },
    retry_button: {
      enabled: true,
      show_counter: false,
    },
  },
};
