import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/sk-biopharm-kids-quest-5-6.md";

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
  display_name: "SK바이오팜 가족 AI 창작 워크숍 — 게스트 퀘스트 (5-6학년)",
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
    // #649 (2026-08-20) — "누구 세상부터 가볼까요?" 였다. 이제 세상은 **버튼으로만**
    // 열린다(앱 matchWorldRef · 워커 matchWorld 둘 다 칩 문구 정확일치만): 아이가
    // 이름을 타이핑하면 세상이 안 열리고 그냥 코치 턴이 된다. 화면에서 가장 큰 글씨가
    // 안 되는 길을 가리키면 안 되므로, 작성란 바로 위 친구 스트립을 가리킨다.
    greeting_md: "안녕하세요! 문제투성이 세상에 사는 친구 아홉 명이 있어요.\n🐕 초코 · 🐈 나비 · 🐝 붕붕 · 🐧 뽀로 · 🐁 찍찍 · 🐹 햄찌 · 🦜 앵무 · 🐿️ 도토 · 🦝 라쿤\n**아래 친구 버튼을 눌러요 👇**",
    example_prompts: [
      "🐝 붕붕 세상에 가볼래",
      "🐧 뽀로 세상에 가볼래",
    ],
  },
  sandbox: {
    // 레거시 — 읽는 코드가 없다(types.ts 참조). 코치는 Write 도구가 없고,
    // 산출물은 확장이 ```html 펜스를 파싱해 workspace_root/index.html 로 쓴다
    // (revealBuilt → saveGameToWorkspace). 값과 무관하게 저장은 일어난다.
    file_write: true,
    workspace_root: "~/HypeProofQuests",
    // 레거시 — 실제 셸 정책은 sdk_tools.shell 이 소유한다(#431). 미성년은
    // 워커가 proxy 로 고정하므로 파일·셸 도구가 도달할 런타임이 없다.
    execute_shell: false,
    mcp_tools_enabled: [],              // B반과 동일 — chat-only (L3 결정)
  },
  // 2026-08-11 결정 — 아동 트랙에 **파일 도구만** 연다.
  //
  // 왜: 커리큘럼이 "코치가 워크스페이스의 파일을 읽고 고친다" 를 전제로 바뀌었다.
  // 이전에는 코치가 채팅에 ```html 을 뱉고 확장이 index.html 로 저장하는 단방향
  // 이었다 — 아이가 넣어둔 파일을 코치가 못 읽고, 고친 결과를 파일에 못 썼다.
  //
  // 무엇을 열지 않았는가 (의도적):
  //   shell      — 임의 명령 실행. 아동 코호트는 열지 않는다
  //   browser    — 외부 탐색. browser_session.mode:"safe" 와 함께 닫아 둔다
  //   subagents  — 위임 판단은 성인 트랙 전용
  //
  // 함께 유지되는 것: 인바운드/아웃바운드 모더레이션(REQ-O2/O3)은 이 플래그와
  // 무관하게 그대로 돈다. 모든 툴 호출은 canUseTool 승인 게이트를 지나고,
  // 워크스페이스(workspace_root) 밖 경로는 evaluateSdkToolUse 가 거부한다.
  sdk_tools: { read: true, write: true },
  // 위 sdk_tools 가 실행될 런타임. 워커는 프로필이 명시적으로 요청할 때만
  // agent-sdk 를 내려준다(routes/chat.ts) — 미설정 아동 코호트는 proxy 그대로.
  coach_runtime: "agent-sdk",
  preview: {
    type: "live_server",
    auto_start: false,
  },
  // #306 — 미성년 코호트: 통합 브라우저가 열릴 경우 하드닝된 persist:hp-safe
  // 세션을 쓴다(권한 전부 deny, 다운로드·팝업 차단, devtools off). allowlist는
  // 비워 둠 → file://·localhost(live_server 미리보기)만 허용, 외부 사이트 차단.
  browser_session: {
    mode: "safe",
    allowlist: [],
  },
  game: {
    template_tier: "kids-quest",   // 게스트 퀘스트 — kq-* 5개. "게임" 낱말을 쓰지 않는 tier.
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
      naming_prompt_md: "같이 친구들을 도와줄 **AI 캐릭터의 이름**을 지어주세요 ✨",
      personality_prompt_md: "이 친구는 어떤 성격이면 좋겠어요? *(예: 꼼꼼한 친구, 엉뚱한 친구. 건너뛰어도 괜찮아요)*",
      revisit_on_entry: false,
    },
    suggestions: {
      // 초5·6: 규칙·난이도·공정함이 들어간 good 칩 — 자율 입력을 유도하고,
      // 막연한 weak 칩으로 "구체화" 대비를 보여준다.
      initial: [
        { text: "🐕 초코 세상에 가볼래", style: "good" },
        { text: "🐈 나비 세상에 가볼래", style: "good" },
        { text: "🐝 붕붕 세상에 가볼래", style: "good" },
        { text: "🐧 뽀로 세상에 가볼래", style: "good" },
        { text: "🐁 찍찍 세상에 가볼래", style: "good" },
        { text: "🐹 햄찌 세상에 가볼래", style: "good" },
        { text: "🦜 앵무 세상에 가볼래", style: "good" },
        { text: "🐿️ 도토 세상에 가볼래", style: "good" },
        { text: "🦝 라쿤 세상에 가볼래", style: "good" },
      ],
      // 검증 → 고치기(Feedback Loop)를 굴리는 칩.
      // 2026-08-19 — 게스트에 묶이지 않는 문구만(실기기: 나비 세상에 붕붕·초코 예시가 떴다).
      // 2026-08-19 실기기 — "이어서 이런 것도 해볼래요?" 칩은 어떤 문구든 아이에게
      // 개소리로 들렸다(게스트·상황과 안 맞음). 없앤다. 다음 할 말은 아이가 정한다.
      follow_up: [],
    },
    hints: {
      short_input: {
        enabled: true,
        min_chars: 5,
        message_md: "💭 조금 더 구체적으로 — *뭘·얼마나·몇 개* 중 하나라도 정해볼래요?",
      },
      // R24 — ✨ 자동 다듬기 버튼 폐지(3·4와 동일). 바꾸는 유일한 통로는 아이의 말.
      roll_input_button: {
        enabled: false,
        label: "",
        probe_md: "",
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
