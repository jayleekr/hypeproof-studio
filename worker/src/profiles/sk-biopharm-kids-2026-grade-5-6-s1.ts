import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/sk-biopharm-kids-2026-grade-5-6-s1.md";

// SK바이오팜 가족 AI 창작 워크숍 — 초5·6학년 트랙 (v126, 4시간 단발).
// 초3·4 트랙(sk-biopharm-kids-s1.ts)과 같은 7단계·두 레슨을 지나되 운전법이
// 다르다: 규칙·점수·난이도·공정함을 정식으로 다루고, 결과를 믿지 않고 직접
// 검증하는 습관(verification_reflex)을 무게중심으로 둔다. 같은 cohort
// (sk-biopharm-2026-a) 안에서 profile_id로만 갈라지는 두 트랙 중 하나.
//
// 자산 매핑(v126): ContextEngineering = intent_clarity + context_design,
// FeedbackLoop = iteration_reflex + verification_reflex, 와우·소유 = taste + ownership.
// 초3·4 대비 verification_reflex가 추가된 게 핵심 차이.
//
// 최초 생성: scripts/scaffold-profile.ts (kids-rich 안전 기본값) → v126 운영 반영.
export const profile: Profile = {
  id: "sk-biopharm-kids-2026-grade-5-6-s1",
  version: 1,
  display_name: "SK바이오팜 가족 AI 창작 워크숍 (5-6학년)",
  audience: {
    age_range: [11, 12],
    language: "ko",
    parent_coaching: true,
  },
  // #320 — minors cohort: enables the gateway moderation layer (REQ-O1/O2).
  minor_cohort: true,
  model: {
    default: "hypeproof-default",
    fallback: "hypeproof-fast",
  },
  system_prompt: systemPromptMd as unknown as string,
  welcome: {
    greeting_md: "안녕하세요! 오늘 같이 **규칙이 있는 게임**을 만들고, 직접 해보면서 더 좋게 고쳐봐요 🎮",
    example_prompts: [
      "별을 모으는 점프 게임 — 점점 빨라지게 만들어줘",
      "장애물을 피하는 게임, 점수 2배 구간이 있으면 좋겠어",
      "시간이 갈수록 어려워지는 슈팅 게임",
    ],
  },
  sandbox: {
    file_write: true,
    workspace_root: "~/HypeProofGames",
    execute_shell: false,
    mcp_tools_enabled: [],
  },
  preview: {
    type: "live_server",
    auto_start: false,
  },
  game: {
    template_tier: "kids-rich",
  },
  publishing: {
    // 미성년 cohort 기본값: 로컬 미리보기만. 공개 퍼블리시는 부모 동의 + PII
    // 설계가 끝난 뒤에만 켠다.
    enabled: false,
    strategy: "local_only",
  },
  assets_focus: [
    "intent_clarity",
    "context_design",
    "verification_reflex",
    "iteration_reflex",
    "taste",
    "ownership",
  ],
  session: {
    cohort_id: "sk-biopharm-2026-a",
    series_total: 1,
    series_index: 1,
    hours: 4,
  },
  analytics: {
    // 미성년 데이터 보호 불변식 — 동의/보존정책 전엔 절대 true 금지.
    log_user_messages: false,
    log_metadata: true,
  },
  ux: {
    coach: {
      naming_mode: "user_names_it",
      fallback_name: "코치",
      naming_prompt_md: "같이 만들 코치의 **이름**을 지어주세요 🎮",
      personality_prompt_md: "이 코치는 어떤 성격이면 좋겠어요? *(예: 까다로운 테스터, 차분한 동료. 건너뛰어도 괜찮아요)*",
      revisit_on_entry: false,
    },
    suggestions: {
      // 초5·6: 규칙·난이도·공정함이 들어간 good 칩 — 자율 입력을 유도하고,
      // 막연한 weak 칩으로 "구체화" 대비를 보여준다.
      initial: [
        { text: "별을 모으는 점프 게임 — 점점 빨라지게", style: "good" },
        { text: "장애물 피하기, 점수 2배 구간 추가", style: "good" },
        { text: "시간이 갈수록 어려워지는 슈팅 게임", style: "good" },
        { text: "그냥 멋진 게임 만들어줘", style: "weak", caption: "규칙·목표가 없으면 AI도 막연해요. 뭘·어떻게?" },
      ],
      // 검증 → 고치기(Feedback Loop)를 굴리는 칩.
      follow_up: [
        { text: "너무 쉬운 것 같아 — 난이도를 더 올려줘", style: "good" },
        { text: "점수 규칙이 공정하게 바꿔줘", style: "good" },
        { text: "실패하면 다시 시작하는 화면 추가해줘", style: "good" },
      ],
    },
    hints: {
      short_input: {
        enabled: true,
        min_chars: 5,
        message_md: "💭 조금 더 구체적으로 — *목표·규칙·난이도* 중 하나라도 정해볼래요?",
      },
      roll_input_button: {
        enabled: true,
        label: "✨ 한 번 더 다듬어보기",
        probe_md: "좋아요! 한 가지만 더 — 이 게임이 **너무 쉽지도 어렵지도 않으려면** 뭘 정해야 할까요?",
      },
    },
    retry_button: {
      // 초5·6: 카운터를 켜서 "다시 요청 → 더 나아짐"의 반복(Iteration/Verification)을
      // 눈에 보이게 한다. 검증 후 고치는 횟수가 곧 성장의 신호.
      enabled: true,
      show_counter: true,
      counter_toast_md: "🔁 다시 고칠수록 좋아져요 — 이번엔 뭐가 나아졌나요?",
    },
  },
};
