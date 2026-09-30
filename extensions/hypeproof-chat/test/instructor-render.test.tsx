// Webview render test for instructor mode (#1298).
// Bundled with esbuild (JSX + CSS stripped) and run with plain Node.
// Tests:
//   (a) config=null + instructor=true → DisconnectedChat (studio-disconnected)
//   (b) config present, no profile/activity, instructor=true → hps-instructor-badge present,
//       student surfaces absent, textarea present
//   (c) config present, no profile/activity, instructor=false → DisconnectedChat
//   (d) config present + profile, instructor=false → MissionHeader present

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatPanel } from "../webview-ui/src/ChatPanel";
import { InstructorChatPanel } from "../webview-ui/src/InstructorChatPanel";
import type { ChatConfig } from "../src/protocol";

// ── stubs ────────────────────────────────────────────────────────────────────
// vscode.ts checks window.acquireVsCodeApi at module load time.
(globalThis as unknown as Record<string, unknown>).window = { acquireVsCodeApi: undefined };

const noop = () => {};
const noopStr = (_: string) => {};
const noopTwo = (_: string, __: string) => {};

const BASE_PROPS = {
  messages: [],
  streaming: false,
  streamingId: null,
  error: null,
  errorRequestId: null,
  errorRunbookUrl: null,
  canRetryLast: false,
  pageNotice: null,
  aiNotice: null,
  stopNotice: null,
  openWorldId: null,
  publish: null,
  incomingImage: null,
  onSend: noop,
  onRetry: noopStr,
  onRetryLast: noop,
  onDismissError: noop,
  onCancel: noop,
  onClear: noop,
  onSetToken: noop,
  onSettings: noop,
  onRunCode: noopStr,
  onNamingRitual: noop,
  onSaveCoach: noopTwo,
  onReportProblem: noop,
  onInstallUpdate: noop,
  onDismissUpdate: noopStr,
  onPublish: noop,
};

const BASE_CONFIG: ChatConfig = {
  model: "claude-opus-4-5",
  hasToken: true,
  proxyUrl: "http://localhost:8787",
  coach: { name: "HypeProof", personality: "", configured: true },
  profile: null,
};

// ── test harness ─────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;

function t(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${label}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${label}: ${(e as Error).message}`);
    fail++;
  }
}

function assertContains(html: string, selector: string, msg: string) {
  if (!html.includes(selector)) throw new Error(`${msg} — expected "${selector}" in HTML`);
}

function assertAbsent(html: string, selector: string, msg: string) {
  if (html.includes(selector)) throw new Error(`${msg} — unexpected "${selector}" found in HTML`);
}

// ── (a) config null + instructor=true → DisconnectedChat ─────────────────────
console.log("=== (a) config null + instructor:true → DisconnectedChat ===");
t("config null + instructor:true → studio-disconnected present (postConfig not yet received)", () => {
  const html = renderToStaticMarkup(
    <ChatPanel {...BASE_PROPS} config={null} instructor={true} />
  );
  assertContains(html, "studio-disconnected", "DisconnectedChat must be shown when config is null");
  assertAbsent(html, "hps-instructor-badge", "instructor badge must NOT show without config");
});

// ── (b) config present, no profile/activity, instructor=true ──────────────────
console.log("=== (b) instructor=true, config present, no profile/activity ===");
t("hps-instructor-badge present (via InstructorChatPanel)", () => {
  const html = renderToStaticMarkup(
    <InstructorChatPanel {...BASE_PROPS} config={BASE_CONFIG} />
  );
  assertContains(html, "hps-instructor-badge", "instructor band badge must be present");
});

t("student-only: '시작할 준비가 됐나요?' absent in instructor mode", () => {
  const html = renderToStaticMarkup(
    <InstructorChatPanel {...BASE_PROPS} config={BASE_CONFIG} />
  );
  assertAbsent(html, "시작할 준비가 됐나요?", "student start-page copy must not appear for instructor");
});

t("student-only: data-artifact-approval absent in instructor mode", () => {
  const html = renderToStaticMarkup(
    <InstructorChatPanel {...BASE_PROPS} config={BASE_CONFIG} />
  );
  assertAbsent(html, "data-artifact-approval", "artifact approval must not appear for instructor");
});

t("textarea (message input) present in instructor mode", () => {
  const html = renderToStaticMarkup(
    <InstructorChatPanel {...BASE_PROPS} config={BASE_CONFIG} />
  );
  assertContains(html, "<textarea", "message textarea must be present for instructor");
});

// ── (c) config present, no profile/activity, instructor=false → DisconnectedChat ──
console.log("=== (c) student, config present, no profile/activity → DisconnectedChat ===");
t("student without profile/activity → studio-disconnected", () => {
  const html = renderToStaticMarkup(
    <ChatPanel {...BASE_PROPS} config={BASE_CONFIG} instructor={false} />
  );
  assertContains(html, "studio-disconnected", "student without profile must see DisconnectedChat");
});

// ── (d) config present + profile, instructor=false → no DisconnectedChat ─────
console.log("=== (d) student with profile → no DisconnectedChat ===");
const STUB_UX = {
  coach: {
    naming_mode: "fixed" as const,
    fallback_name: "HypeProof",
    naming_prompt_md: "",
    personality_prompt_md: "",
  },
  suggestions: { initial: [], follow_up: [] },
  hints: {
    short_input: { enabled: false, min_chars: 0, message_md: "" },
    roll_input_button: { enabled: false, label: "", probe_md: "" },
  },
  retry_button: { enabled: false, show_counter: false },
};

const CONFIG_WITH_PROFILE: ChatConfig = {
  ...BASE_CONFIG,
  profile: {
    profile_id: "test",
    observation: null,
    lesson: null,
    rehearsal: null,
    welcome: { greeting_md: "안녕하세요" },
    model_selection: null,
    ux: STUB_UX,
  } as unknown as NonNullable<ChatConfig["profile"]>,
};

t("student with profile → studio-disconnected absent", () => {
  const html = renderToStaticMarkup(
    <ChatPanel {...BASE_PROPS} config={CONFIG_WITH_PROFILE} instructor={false} />
  );
  assertAbsent(html, "studio-disconnected", "student with profile must NOT see DisconnectedChat");
  assertContains(html, "<textarea", "message textarea must be present");
});

// ── summary ───────────────────────────────────────────────────────────────────
const total = pass + fail;
console.log(`\n${total} render tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
