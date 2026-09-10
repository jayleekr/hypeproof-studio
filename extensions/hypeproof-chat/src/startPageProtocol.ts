/** Start-page messages contain presentation state, never saved credentials. */
export interface StartState {
  checking: boolean;
  started?: boolean;
  error?: string;
  profile?: { kind?: "trial" | "personal" | "classroom"; id: string; name: string; coach: string; series: string; workspace: string };
  /** #747 — resolved AI display name for the connected seat; absent → "코치". */
  coachName?: string;
  workspace?: string;
  version: string;
}
export type StartRequest =
  | { type: "startReady" }
  | { type: "openStudioFiles" }
  | { type: "openStudioSettings" }
  | { type: "connectCourse"; token: string }
  | { type: "beginCourse" }
  | { type: "disconnectCourse" }
  | { type: "openLocalFolder" };
export type StartResponse = { type: "startState"; state: StartState };
