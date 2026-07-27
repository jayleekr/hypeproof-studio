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
//   - 배포는 이제 코호트 안에서 끝난다(#431): sdk_tools.shell + github-repo /
//     publish-homepage 스킬. `publishing` 플래그는 클라이언트가 읽지 않는 잔재라
//     local_only로 둔다 — 별도 퍼블리시 위저드는 만들지 않기로 했다.
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
    // 홈페이지 전체 HTML은 기본 8192 토큰을 넘겨 잘림(#1) → 상한(16384)까지 허용.
    max_tokens: 16384,
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
    // 레거시 필드 — 실제 셸 정책은 sdk_tools.shell이 소유한다(#431). 읽는 코드는
    // 없지만 sdk_tools.shell: true 옆에 false로 남아 있으면 다음 사람이 오독한다.
    execute_shell: true,
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
  // #278 — 여기에 네이티브 브라우저 3조건을 얹는다(별도 homepage 코호트 대신 이 트랙에 통합).
  // page_context: "페이지를 코치에게"로 현재 브라우저 화면(스크린샷+DOM 텍스트)을 코치에게 전달.
  input: {
    page_context: true,
    image_paste: true,
  },
  // #278 Phase 3 — 코치 자율 브라우저 제어 루프. 참가자가 참고 사이트 URL만 줘도 코치가
  // 브라우저를 직접 열어 구조를 읽고 클론을 시작한다(스크린샷 첨부는 선택으로 격하).
  // worker가 8개 브라우저 tool + 사용 규약을 주입하고, 확장 host가 CDP로 실행. 성인 cohort.
  browser_control: {
    enabled: true,
    max_iterations: 8,
  },
  // 원장 웹사이트 클론 중 근거 탐색(레퍼런스 사이트·섹션 구성·컴포넌트 구현법 등)을
  // 위해 web_search ON. 프록시 경로의 Anthropic 호스티드 web_search 툴 — teaser와
  // 동일 매핑, 턴당 최대 사용 제한. (claude-code식 WebFetch/에이전트 루프는 Agent SDK
  // 전환(#282) Phase 2 몫으로 별개. 이 플래그는 "간단한 웹서치"를 지금 아키텍처에서 켠다.)
  tools: { web_search: true, max_uses: 5 },
  // #282 Phase 2 — Agent SDK 워크스페이스 도구. 성인(원장) copyclone cohort만
  // read+write: 코치가 index.html을 직접 읽고 고친다("coach edits index.html
  // directly"). write 도구는 클라이언트에서 항상 승인 모달을 거치고 워크스페이스
  // 밖 경로는 거부된다. 미성년 cohort는 이 플래그를 절대 켜지 않는다(harness
  // child_sdk_write FAIL).
  // browser (#282 P2 slice 2): 통합 브라우저 MCP 도구(browser_open/screenshot/
  // live_preview_start). browser_open은 URL 정책 + 승인 모달을 항상 거친다.
  // 성인 cohort 전용 — 미성년은 safe-session 전까지 false (harness
  // child_sdk_browser FAIL, #306/#318).
  // subagents (#282 P2 slice 3): 읽기 전용 코드리뷰어/리서처 서브에이전트.
  // 코치가 "리뷰 맡길까요?"를 위임(delegation_judgment) — 매 위임은 승인 모달,
  // 서브에이전트 도구 호출도 부모와 동일한 canUseTool 정책을 통과한다.
  // 성인(원장) cohort 전용 — 미성년은 pedagogy 결정 전까지 false (harness
  // child_sdk_subagents FAIL).
  // #384 — 이번 라운드 기본(대표) 트랙. 강사 콘솔에서 맨 앞에 온다.
  dashboard_order: 0,
  // epic #431 — shell. 큐시트 20:35 블록(배포 URL·GitHub 저장소)이 이것 없이는
  // 구현 경로가 없다. 스킬만 주고 실행 수단을 안 주면 코치가 가짜 배포 URL을
  // 지어낸다(#428과 같은 실패 계열). 임의 명령 허용 — 승인 모달이 게이트.
  // subagents 를 끈다 (2026-07-27 실측). 서브에이전트 4개를 병렬로 띄운 직후
  // 모든 툴 호출이 `Tool permission request failed: Error: Stream closed` 로
  // 무너졌다 — 한 턴에 28건. SDK 제어 채널 오류이지 우리 정책 코드가 아니다.
  //
  // v0.1.30 에서는 같은 서브에이전트 5개가 멀쩡히 돌았다. 그때는 툴마다 승인
  // 모달이 떠서 사람이 하나씩 눌렀고, 그것이 **우연히 직렬화 장치** 역할을 했다.
  // v0.1.31 에서 승인을 자동 허용으로 바꾸자 권한 요청이 한꺼번에 쏟아지면서
  // 채널이 끊겼다. 미확정 가설이지만 상관관계가 강하고 다른 설명이 맞지 않는다.
  //
  // 잃는 것은 서브페이지 병렬 수집 속도뿐이다 — 코치는 browser_open → read 를
  // 순차로 돌아 같은 일을 한다. 원인이 확정되면 되돌린다.
  sdk_tools: { read: true, write: true, browser: true, subagents: false, shell: true },
  // 스킬 3종. shell과 반드시 짝이다(#431): 스킬만 있고 실행 수단이 없으면 코치가
  // 배포한 척하고, 실행 수단만 있고 스킬이 없으면 git을 부르다 CLT 설치 창(2GB)을
  // 띄운다. design-craft는 코호트 프롬프트에 박혀 있던 80줄을 그대로 옮긴 것(#434).
  skills: ["design-craft", "github-repo", "publish-homepage"],
  // #371/#384 — 원장 트랙은 Agent SDK 런타임: 코치가 파일을 직접 읽고·쓰고·
  // 고쳐 루브릭/agent.md/이미지 참조를 실제 파일로 다룬다(Claude Code와 동일
  // 아키텍처 + canUseTool 교실 정책). 재활성 조건 충족(2026-07-24):
  // ① 클라이언트 폴백 픽스(#387, v0.1.20+) — SDK 미가용이어도 브라우저 루프
  //    유지(2026-07-23 회귀 재발 불가), ② 시딩 스크립트 검증 완료.
  // 미시딩 머신은 자동으로 proxy(+브라우저 루프)로 폴백하므로 안전.
  // 미성년은 워커가 무조건 proxy 강제.
  coach_runtime: "agent-sdk",
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
        // 실사용에서 쓰이지 않는다(원장 확인 2026-07-27). 입력창 옆 버튼은
        // 자리를 차지하고 시선을 나눠 갖는데 눌리지 않으면 순수 잡음이다.
        enabled: false,
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
