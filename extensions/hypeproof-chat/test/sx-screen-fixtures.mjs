// 실제 화면을 렌더하는 데 필요한 최소 시료.
//
// 왜 따로 두나. 2026-09-20 평가가 이렇게 지적했다: 감사 계측기가 `MissionHeader` 와
// `NativeObservationPanel` 둘만 렌더하고, **C1 이 말하는 "작업 중 화면" 의 본체인
// `ChatPanel` 과 홈인 `StartPage` 는 렌더도 감사도 되지 않는다.** 그 말이 맞았다.
// 판정을 소스 grep 에 기대면 조건부 분기를 놓친다(verification.md 규칙 1).
//
// 수업 데이터는 **지어내지 않는다** — 실제 세션 설계 파일
// `worker/test/fixtures/session-design/week-N.json` 을 읽는다. 화면이 읽는 그 데이터로
// 판정해야 판정이 실물에 붙는다.

import { readFileSync } from "node:fs";

export function weekFixture(n) {
  return JSON.parse(
    readFileSync(new URL(`../../../worker/test/fixtures/session-design/week-${n}.json`, import.meta.url), "utf8"),
  );
}

export const noop = () => {};

/** `/v1/profile` 이 실제로 돌려주는 모양의 최소 부분집합. */
export function resolvedProfile(week = 3, over = {}) {
  const content = weekFixture(week);
  return {
    profile_id: "sx-fixture",
    display_name: content.title,
    language: "ko",
    series_index: week,
    series_total: 6,
    welcome: { greeting_md: `오늘 수업: ${content.title}`, example_prompts: [] },
    ux: {
      coach: { naming_mode: "fixed", fallback_name: "코치", naming_prompt_md: "", personality_prompt_md: "" },
      suggestions: { initial: [], follow_up: [] },
      hints: {
        short_input: { enabled: false, min_chars: 0, message_md: "" },
        roll_input_button: { enabled: false, label: "", probe_md: "" },
      },
      retry_button: { enabled: true, show_counter: false },
    },
    lesson: { course_id: "globalbuddy", version: "m2026.09.20-1", sha256: "f".repeat(64), content },
    ...over,
  };
}

export function chatConfig(week = 3, over = {}) {
  return {
    proxyUrl: "http://localhost:8787/v1",
    model: "claude-sonnet-5",
    hasToken: true,
    coach: { name: "코치", personality: "", configured: true },
    activity: { id: "a1", name: "GlobalBuddy", kind: "classroom", workspace: "/w", verified: true },
    profile: resolvedProfile(week),
    ...over,
  };
}

/** `ChatPanel` 의 25개 prop 중 렌더에 필요한 것 전부. 콜백은 전부 no-op 이다. */
export function chatPanelProps(over = {}) {
  return {
    config: chatConfig(),
    incomingImage: null,
    messages: [],
    pageNotice: null,
    aiNotice: null,
    stopNotice: null,
    openWorldId: null,
    publish: null,
    onPublish: noop,
    streaming: false,
    streamingId: null,
    error: null,
    errorRequestId: null,
    errorRunbookUrl: null,
    canRetryLast: false,
    onSend: noop,
    onRetry: noop,
    onRetryLast: noop,
    onDismissError: noop,
    onCancel: noop,
    onClear: noop,
    onSetToken: noop,
    onSettings: noop,
    onRunCode: noop,
    onNamingRitual: noop,
    onSaveCoach: noop,
    onReportProblem: noop,
    onInstallUpdate: noop,
    onDismissUpdate: noop,
    ...over,
  };
}
