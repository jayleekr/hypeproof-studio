import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/boah-homepage-2026-s1.md";

// 보아치과 홈페이지 만들기 코호트 (#278). 성인 직원이 코치와 대화하며 실제
// 멀티파일 병원 홈페이지를 한 페이지씩 만들고, live-server로 네이티브 브라우저에서
// 실동작을 확인하며 다듬는다. 후속 Phase에서 코치가 그 브라우저를 자율로
// 열고/읽고/캡쳐/조작하며 돕는다.
//
// 기존 "website"(copyclone) 코호트와 구분: 저쪽은 타겟 스크린샷을 클론하는 것이고,
// 이쪽은 대화로 새 홈페이지를 처음부터 만드는 것이다 (tier "homepage").
//
// - preview.type: "live_server" — iframe(srcdoc)가 아니라 로컬 HTTP 서버로
//   워크스페이스 루트를 서빙해 멀티파일/상대경로/스토리지가 동작한다 (Phase 1이
//   이 필드를 최초로 소비).
// - game.template_tier: "homepage" — 게임/검색 skeleton 미주입(교육은 프롬프트).
// - input.page_context + image_paste ON (Phase 2): 참가자가 "페이지를 코치에게"로
//   현재 브라우저 화면(스크린샷+DOM 텍스트)을 코치에게 보낼 수 있다. 성인 코호트라 안전.
// - browser_control (Phase 3) 은 후속 Phase에서 켠다.
//
// 7 AI Native Assets focus (홈페이지 제작 맥락):
//   Intent clarity, Taste, Context design, Iteration reflex,
//   Verification reflex, Ownership. (Delegation은 구조=AI / 병원정보·판단=참가자로
//   자연스럽게 체험.)
export const profile: Profile = {
  id: "boah-homepage-2026-s1",
  version: 1,
  display_name: "보아치과 — 홈페이지 만들기 (2026)",
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
    greeting_md:
      "안녕하세요! 오늘은 **보아치과 홈페이지**를 직접 만들어요 🏥\n어떤 페이지부터 만들어볼까요?",
    example_prompts: [
      "우리 병원 소개 페이지를 만들고 싶어요 — 진료과목이랑 인사말 넣어서",
      "예약·오시는 길 페이지 — 진료시간표랑 연락처 넣어줘",
      "이 참고 치과 홈페이지처럼 깔끔한 첫 화면으로 만들어줘",
    ],
  },
  sandbox: {
    file_write: true,
    workspace_root: "~/BoaHomepage",
    execute_shell: false,
    mcp_tools_enabled: [],
  },
  preview: {
    // live-server: 로컬 HTTP로 워크스페이스 루트를 서빙 → 네이티브 브라우저.
    // 멀티파일 홈페이지(상대경로 css/js/img, 페이지 이동, 스토리지)가 동작한다.
    // Phase 1이 이 필드를 iframe 대신 처음으로 소비한다.
    type: "live_server",
    auto_start: false,
  },
  // #278 Phase 2 — 성인 코호트: 현재 브라우저 페이지(화면+DOM)를 코치에게 보내는
  // "페이지를 코치에게" 경로 활성화. page_context가 버튼을 노출하고, image_paste가
  // 스크린샷(vision) 전달을 허용(worker가 동일하게 강제).
  input: {
    page_context: true,
    image_paste: true,
  },
  game: {
    // 홈페이지 tier — 게임/검색 skeleton 미주입(등록된 skeleton 없음).
    // 구조/교육은 system prompt가 담당.
    template_tier: "homepage",
  },
  publishing: {
    // 홈페이지 배포(per-user GitHub Pages)는 별도 스프린트. 지금은 로컬 미리보기.
    enabled: false,
    strategy: "local_only",
  },
  assets_focus: [
    "intent_clarity",
    "taste",
    "context_design",
    "iteration_reflex",
    "verification_reflex",
    "ownership",
  ],
  session: {
    cohort_id: "boah-homepage-2026-a",
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
      // 성인 실무 세션: 네이밍 단계 생략 — 마찰 최소화, 바로 제작.
      naming_mode: "fixed",
      fallback_name: "코치",
      naming_prompt_md: "",
      personality_prompt_md: "",
      revisit_on_entry: false,
    },
    suggestions: {
      initial: [
        { text: "병원 소개 페이지부터 만들어줘", style: "good", caption: "이렇게 시작해보세요" },
      ],
      follow_up: [],
    },
    hints: {
      short_input: {
        enabled: true,
        min_chars: 5,
        message_md:
          "💭 조금 더 구체적으로 — *어떤 페이지·누구에게 보여줄·무엇을 하게 할지* 중 하나라도요",
      },
      roll_input_button: {
        enabled: true,
        label: "✨ 한 번 더 다듬어보기",
        probe_md:
          "좋아요! 한 가지만 더 — 이 페이지를 본 사람이 하길 바라는 *행동*은 뭔가요? (전화·예약·길찾기 등)",
      },
    },
    retry_button: {
      enabled: true,
      show_counter: false,
    },
  },
};
