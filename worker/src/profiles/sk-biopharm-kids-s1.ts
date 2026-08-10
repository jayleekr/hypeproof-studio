import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/sk-biopharm-kids-s1.md";

export const profile: Profile = {
  // id/cohort_id are unchanged for token + roster compatibility; the "-s1"
  // suffix is legacy (v126 made this a single-session workshop, not a series).
  id: "sk-biopharm-kids-2026-grade-3-4-s1",
  version: 1,
  display_name: "SK바이오팜 가족 AI 창작 워크숍 (3-4학년)",
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
    greeting_md: "안녕하세요! 오늘 같이 게임을 만들어봐요 🎮",
    example_prompts: [
      "삼각형이 점프하는 게임 만들어줘",
      "별이 떨어지는 게임을 만들고 싶어요",
      "캐릭터 색을 무지개로 바꿔줘",
    ],
  },
  sandbox: {
    // 레거시 — 읽는 코드가 없다(types.ts 참조). 코치는 Write 도구가 없고,
    // 산출물은 확장이 ```html 펜스를 파싱해 workspace_root/index.html 로 쓴다
    // (revealBuilt → saveGameToWorkspace). 값과 무관하게 저장은 일어난다.
    // 2026-08-10 에 이 필드를 보고 "파일 쓰기가 켜져 있다"고 오독한 사례가 있다.
    file_write: true,
    workspace_root: "~/HypeProofGames",
    // 레거시 — 실제 셸 정책은 sdk_tools.shell 이 소유한다(#431). 이 트랙은
    // sdk_tools 자체를 두지 않는다: 미성년은 워커가 proxy 로 고정하므로
    // (chat.ts, REQ-O1 계열) 파일·셸 도구가 도달할 런타임이 없다.
    execute_shell: false,
    mcp_tools_enabled: [],              // 1회차는 chat-only per L3 decision
  },
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
    template_tier: "kids-basic",   // 초3·4 트랙. 초5·6 트랙은 "kids-rich".
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
      naming_prompt_md: "같이 게임 만들 친구의 **이름**을 지어주세요 🎮",
      personality_prompt_md: "이 친구는 어떤 친구예요? *(예: 친절한 친구, 엉뚱한 친구. 건너뛰어도 괜찮아요)*",
      revisit_on_entry: false,
    },
    suggestions: {
      // 자세한 vs 막연한 대비. 자녀가 좋은 입력 모양을 패턴 매칭으로 학습.
      // 작은 스코프부터 → 자녀가 첫 시도에 성공 경험.
      initial: [
        { text: "원이 좌우로 움직이는 화면 만들어줘", style: "good" },
        { text: "별이 떨어지고 클릭하면 점수가 오르는 게임", style: "good" },
        { text: "고양이가 점프해서 생선을 먹는 게임", style: "good" },
        { text: "노란 캐릭터가 빨간 적을 피하는 게임", style: "good" },
        { text: "재밌게 만들어줘", style: "weak", caption: "어떤 게 재밌어야 할지 모르겠어요. 자세히!" },
      ],
      // 모두 명령형 — 질문형("...하면 어떻게 돼?")은 AI가 코드 대신 되묻게
      // 만들어 화면이 빈 채로 남는다. 1회차는 "말하면 바로 바뀐다" 체험이 핵심.
      follow_up: [
        { text: "색을 더 밝고 예쁘게 바꿔줘", style: "good" },
        { text: "소리 효과를 추가해줘", style: "good" },
        { text: "점점 빨라지게 해줘", style: "good" },
        { text: "캐릭터를 내가 좋아하는 동물로 바꿔줘", style: "good" },
        { text: "적을 한 명 더 추가해줘", style: "good" },
      ],
    },
    hints: {
      short_input: {
        enabled: true,
        min_chars: 5,
        message_md: "💭 조금 더 자세히 알려줄래요? *주인공·움직임·점수* 같은 걸요",
      },
      roll_input_button: {
        enabled: true,
        label: "✨ 한 번 더 떠올려보기",
        probe_md: "좋아요! 한 가지만 더 떠올려보세요 — 캐릭터 모양? 색? 점수 규칙?",
      },
    },
    retry_button: {
      // 단발 초3·4: 버튼은 보이되 카운터는 숨김 — 다시 요청해서 게임이 바뀌는
      // 경험(Feedback Loop)을 자녀가 자연스럽게 발견하게. 카운터 강조는 초5·6 트랙.
      enabled: true,
      show_counter: false,
    },
  },
};
