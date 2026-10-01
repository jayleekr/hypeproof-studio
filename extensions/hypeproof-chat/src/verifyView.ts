// The "Test my product" panel state (cr-verify, #1392). Types only, shared by the host
// (verifySession.ts) and the webview (VerifyPanel.tsx): no node or vscode imports, so the
// webview build can read it.
import type { ProductVerification, ReportCriterion, VerificationReport } from "../../../worker/src/lib/measurement-core/verification.ts";

export interface VerifyCriterion {
  id: string;
  text: string;
}
export interface VerifyProposal {
  /** The event the proposal is recorded by; `adopted_from` of an accepted criterion. */
  id: string;
  text: string;
}
export interface ActiveRun {
  run_id: string;
  criteria: VerifyCriterion[];
  /** Criterion ids the runner has a recorded verdict for, in this run. */
  done: string[];
  /** The version current when the run started; coach calls on another version are refused. */
  version: string | null;
  /** Who started it: the student's "테스트 시작" (the coach plans) or "다시 테스트" (stored plans). */
  origin: "coach" | "retest";
}

/** What the panel draws. Plain data, computed from the record every time. */
export interface VerifyView {
  available: boolean;
  reason: string | null;
  version: string | null;
  verification: ProductVerification;
  report: VerificationReport | null;
  /**
   * CR-81, CR-16 — results from earlier reports on this version that keep it from
   * "verified" but are not in `report` (a later start with other words or another plan),
   * each its own report's row, so the student sees why and can ask for a fix.
   */
  held: ReportCriterion[];
  run: ActiveRun | null;
  proposals: VerifyProposal[];
  running: boolean;
  notice: string | null;
}
