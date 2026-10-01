// Instructor-mode turn dispatch. Separate from the student path (chatPanelProvider.ts
// handleSend) so the student path — ensureProfile, lesson gates, student spool — is
// never touched when instructor mode is active (chalk-po condition 1, R2).

import type { ResolvedProfile } from "../protocol";
import { runLocalCoach } from "../localRuntime/index.ts";
import type { LocalRuntimeConfig } from "../localRuntime/index.ts";
import type { ChalkToolContext } from "./tools";
import type { SdkActivity, CoachToolAction } from "../sdkCoachHelpers";

// Instructor tool policy — NOT a student profile.
// Grants Read + Write (workspace tools) only.
// Shell, browser, subagents are off — instructor only needs file inspection and Chalk tools.
// Exported for smoke tests only; not part of the public API.
export const INSTRUCTOR_TOOL_PROFILE: ResolvedProfile = {
  profile_id: "chalk-instructor",
  display_name: "강사",
  language: "ko",
  series_index: 0,
  series_total: 1,
  assets_focus: [],
  welcome: { greeting_md: "", example_prompts: [] },
  publishing: { enabled: false, strategy: "none" },
  preview: { type: "iframe", auto_start: false },
  sdk_tools: { read: true, write: true },
  ux: {
    coach: {
      naming_mode: "fixed",
      fallback_name: "코치",
      naming_prompt_md: "",
      personality_prompt_md: "",
    },
    suggestions: { initial: [], follow_up: [] },
    hints: {
      short_input: { enabled: false, min_chars: 0, message_md: "" },
      roll_input_button: { enabled: false, label: "", probe_md: "" },
    },
    retry_button: { enabled: false, show_counter: false },
  },
};

export async function runInstructorTurn(args: {
  local: LocalRuntimeConfig;
  cwd: string;
  history: Array<{ role: string; content: string }>;
  userText: string;
  brief: string | undefined;
  chalkCtx: ChalkToolContext | undefined;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onActivity?: (a: SdkActivity) => void;
  requestApproval: (
    a: CoachToolAction,
  ) => Promise<boolean | { approved: boolean; actor: "user" | "policy" }>;
}) {
  if (!args.brief) {
    throw new Error("강사 지시문을 받지 못했습니다. 연결을 확인하세요.");
  }
  return runLocalCoach({
    config: args.local,
    profile: INSTRUCTOR_TOOL_PROFILE,
    cwd: args.cwd,
    history: args.history,
    userText: args.userText,
    systemPrompt: args.brief,
    chalkCtx: args.chalkCtx,
    signal: args.signal,
    onDelta: args.onDelta,
    onActivity: args.onActivity,
    requestApproval: args.requestApproval,
  });
}
