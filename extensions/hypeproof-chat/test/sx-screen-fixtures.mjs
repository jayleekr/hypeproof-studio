// The minimum fixtures needed to render the real screens.
//
// Why keep them separate. The 2026-09-20 evaluation pointed this out: the audit
// instrument renders only `MissionHeader` and `NativeObservationPanel`, and
// **`ChatPanel` — the body of what C1 calls the "작업 중 화면" — and the home
// screen `StartPage` are neither rendered nor audited.** That was right.
// Leaning the judgement on a source grep misses conditional branches
// (verification.md rule 1).
//
// Lesson data is **not made up** — it reads the real session-design file
// `worker/test/fixtures/session-design/week-N.json`. Judging on the same data the
// screen reads is what makes the judgement stick to the real thing.

import { readFileSync } from "node:fs";

export function weekFixture(n) {
  return JSON.parse(
    readFileSync(new URL(`../../../worker/test/fixtures/session-design/week-${n}.json`, import.meta.url), "utf8"),
  );
}

export const noop = () => {};

/** The minimum subset of the shape `/v1/profile` actually returns. */
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

/** All of `ChatPanel`'s 25 props that rendering needs. Every callback is a no-op. */
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
