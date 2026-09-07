/** Start-page messages contain presentation state, never saved credentials. */
export interface StartState {
  checking: boolean;
  error?: string;
  profile?: { id: string; name: string; coach: string; series: string; workspace: string };
  workspace?: string;
  version: string;
}
export type StartRequest =
  | { type: "startReady" }
  | { type: "connectCourse"; token: string }
  | { type: "beginCourse" }
  | { type: "disconnectCourse" }
  | { type: "openLocalFolder" };
export type StartResponse = { type: "startState"; state: StartState };
