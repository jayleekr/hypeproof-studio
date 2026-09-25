/** Start-page messages contain presentation state, never saved credentials. */
export interface ActivitySummary {
  ref: string;
  id: string;
  name: string;
  kind?: 'trial' | 'personal' | 'classroom';
  workspace: string;
}
export interface StartState {
  activities?: ActivitySummary[];
  legacyConnection?: boolean;
  legacyHistory?: boolean;
  checking: boolean;
  started?: boolean;
  candidate?: boolean;
  previousConnected?: boolean;
  error?: string;
  profile?: { kind?: "trial" | "personal" | "classroom"; id: string; name: string; coach: string; series: string; workspace: string };
  /** #747 — resolved AI display name for the connected seat; absent → "코치". */
  coachName?: string;
  workspace?: string;
  version: string;
  /** #751 U2 — instructor notices/materials of the connected class, read from disk by the host. */
  inbox?: import("./classroomInbox").InboxView;
}
export type StartRequest =
  | { type: "startReady" }
  | { type: "exportLegacyHistory" }
  | { type: "selectActivity"; ref: string }
  | { type: "chooseActivityFolder" }
  | { type: "openLocalReview" }
  | { type: "openStudioFiles" }
  | { type: "openStudioSettings" }
  | { type: "connectCourse"; token: string }
  | { type: "beginCourse" }
  | { type: "disconnectCourse" }
  | { type: "cancelCandidate" }
  | { type: "openLocalFolder" }
  | { type: "inboxOpen"; objectId: string; generation: number }
  | { type: "inboxLink"; objectId: string; url: string; generation: number; action: "open" | "copy" };
export type StartResponse = { type: "startState"; state: StartState };
