import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/sk-biopharm-kids-quest-3-4.md";

export const profile: Profile = {
  // id/cohort_id are unchanged for token + roster compatibility; the "-s1"
  // suffix is legacy (v126 made this a single-session workshop, not a series).
  id: "sk-biopharm-kids-2026-grade-3-4-s1",
  version: 1,
  display_name: "SK바이오팜 가족 AI 창작 워크숍 — 게스트 퀘스트 (3-4학년)",
  audience: {
    age_range: [8, 10],          // v126 분반: 초3·4 = 만 8~10세
    language: "ko",
    parent_coaching: true,
  },
  // #320 — minors cohort: enables the gateway moderation layer (REQ-O1/O2).
  minor_cohort: true,
  model: {
    default: "hypeproof-default",       // Sonnet for higher quality; switch to fast if cost pressure
    fallback: "hypeproof-fast",
  },
  system_prompt: systemPromptMd as unknown as string,
  welcome: {
    greeting_md: "안녕하세요! 문제투성이 세상에 사는 친구 아홉 명이 있어요.\n**누구 세상부터 가볼까요?** 🐕 초코 · 🐈 나비 · 🐝 붕붕 · 🐧 뽀로 · 🐁 찍찍 · 🐹 햄찌 · 🦜 앵무 · 🐿️ 도토 · 🦝 라쿤",
    example_prompts: [
      "🐕 초코 세상에 가볼래",
      "🐈 나비 세상에 가볼래",
      "🐝 붕붕 세상에 가볼래",
    ],
  },
  sandbox: {
    // 레거시 — 읽는 코드가 없다(types.ts 참조). 코치는 Write 도구가 없고,
    // 산출물은 확장이 ```html 펜스를 파싱해 workspace_root/index.html 로 쓴다
    // (revealBuilt → saveGameToWorkspace). 값과 무관하게 저장은 일어난다.
    // 2026-08-10 에 이 필드를 보고 "파일 쓰기가 켜져 있다"고 오독한 사례가 있다.
    file_write: true,
    workspace_root: "~/HypeProofQuests",
    // 레거시 — 실제 셸 정책은 sdk_tools.shell 이 소유한다(#431). 이 트랙은
    // sdk_tools 자체를 두지 않는다: 미성년은 워커가 proxy 로 고정하므로
    // (chat.ts, REQ-O1 계열) 파일·셸 도구가 도달할 런타임이 없다.
    execute_shell: false,
    mcp_tools_enabled: [],              // 1회차는 chat-only per L3 decision
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
    auto_start: true,
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
    // 단발 4시간 워크숍 — 로컬 미리보기(▶ Run)로 충분하고 chat-only
    // (sandbox.mcp_tools_enabled [])와 정합한다. 미성년 게임의 공개 퍼블리시는
    // 부모 동의·PII 설계가 끝나기 전엔 켜지 않는다(smoke.mjs §4 불변식).
    enabled: false,
    strategy: "local_only",
  },
  assets_focus: [
    "intent_clarity",
    "context_design",
    "iteration_reflex",
    "taste",
    "ownership",
  ],
  // Deprecated v0.1 bridge for clients that still render old essence ids.
  essences_focus: [1, 2, 5, 7, 16],
  session: {
    cohort_id: "sk-biopharm-2026-a",   // 초3·4·초5·6 두 트랙이 공유하는 cohort
    series_total: 1,                    // v126: 8주×4회 시리즈 → 4시간 단발
    series_index: 1,
    hours: 4,
  },
  analytics: {
    log_user_messages: false,
    log_metadata: true,
  },
  ux: {
    // 단발 4h 초3·4 트랙. 두 레슨(생각 구체화 / 만들고-확인하고-고치기)을 자녀가
    //   몸으로 익히게 하는 UX — "자세히 말하면 멋진 게 나온다" + "한 번 만들고 끝이 아니다".
    coach: {
      naming_mode: "user_names_it",
      fallback_name: "코치",
      naming_prompt_md: "같이 친구들을 도와줄 **AI 캐릭터의 이름**을 지어주세요 ✨",
      personality_prompt_md: "이 친구는 어떤 친구예요? *(예: 친절한 친구, 엉뚱한 친구. 건너뛰어도 괜찮아요)*",
      revisit_on_entry: false,
    },
    suggestions: {
      // 자세한 vs 막연한 대비. 자녀가 좋은 입력 모양을 패턴 매칭으로 학습.
      // 작은 스코프부터 → 자녀가 첫 시도에 성공 경험.
      initial: [
        { text: "🐕 초코 세상에 가볼래", style: "good" },
        { text: "🐈 나비 세상에 가볼래", style: "good" },
        { text: "🐝 붕붕 세상에 가볼래", style: "good" },
        { text: "🐧 뽀로 세상에 가볼래", style: "good" },
        { text: "다른 친구도 있어?", style: "good" },
      ],
      // 모두 명령형 — 질문형("...하면 어떻게 돼?")은 AI가 코드 대신 되묻게
      // 만들어 화면이 빈 채로 남는다. 1회차는 "말하면 바로 바뀐다" 체험이 핵심.
      // 2026-08-19 — 게스트에 묶이지 않는 문구만. 초코 예시("불덩이 대신…")를
      // 나비 세상에서 보여주니 아이가 헷갈렸다(실기기). 정답도 주지 않는다.
      // 2026-08-19 실기기 — "이어서 이런 것도 해볼래요?" 칩은 어떤 문구든 아이에게
      // 개소리로 들렸다(게스트·상황과 안 맞음). 없앤다. 다음 할 말은 아이가 정한다.
      follow_up: [],
    },
    hints: {
      short_input: {
        enabled: true,
        min_chars: 5,
        message_md: "💭 조금 더 자세히 알려줄래요? *누가 사는지·무슨 색인지·나만 아는 것* 같은 걸요",
      },
      // R24 — ✨ 자동 다듬기 버튼 폐지. 그림을 바꾸는 유일한 통로는 아이의 말이어야
      // 한다(탈평균). 원터치 개선은 AI가 대신 잘해주는 통로라 학습 목표와 충돌한다.
      roll_input_button: {
        enabled: false,
        label: "",
        probe_md: "",
      },
    },
    // R24 — 초3·4는 재도전 버튼도 두지 않는다. 카운터는 메타인지 장치라
    // 형식적 조작기부터 작동하고(Flavell), 이 연령엔 주의 분산이다.
    retry_button: {
      enabled: false,
      show_counter: false,
    },
  },
};
