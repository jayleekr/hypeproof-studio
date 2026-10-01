// The "Test my product" panel state (cr-verify, #1392). Types only, shared by the host
// (verifySession.ts) and the webview (VerifyPanel.tsx): no node or vscode imports, so the
// webview build can read it.
import type { ProductVerification, VerificationReport } from "../../../worker/src/lib/measurement-core/verification.ts";

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
}

/** What the panel draws. Plain data, computed from the record every time. */
export interface VerifyView {
  available: boolean;
  reason: string | null;
  version: string | null;
  verification: ProductVerification;
  report: VerificationReport | null;
  run: ActiveRun | null;
  proposals: VerifyProposal[];
  running: boolean;
  notice: string | null;
}
