import type { Task, Review, Receipt, SubmissionBundle } from '../../../worker/src/lib/measurement-core/local-record.ts';
import type { Interpretation } from '../../../worker/src/lib/measurement-core/interpretation.ts';
import type { ObservationEvent } from '../../../worker/src/lib/measurement-core/legacy-observation.ts';
export type ReviewHost = 'claude-code' | 'codex';
export interface TaskCard {
  task: Task;
  source: { host: ReviewHost; session: string; digest: string; evidence: 'captured-replay'; limitations: string[]; exclusions: string[] };
  observations: Array<{ key: string; event: ObservationEvent }>;
  interpretation: Interpretation;
  reviews: Review[];
  receipts: Receipt[];
}
export type LocalReviewRequest =
  | { type: 'localReview'; action: 'load' }
  | { type: 'localReview'; action: 'import'; host: ReviewHost }
  | { type: 'localReview'; action: 'open'; task: string }
  | { type: 'localReview'; action: 'purpose'; task: string; text: string }
  | { type: 'localReview'; action: 'review'; task: string; capability: string; decision: Review['action']; text: string }
  | { type: 'localReview'; action: 'preview'; task: string; includeEvidence: boolean }
  | { type: 'localReview'; action: 'submit'; task: string; digest: string }
  | { type: 'localReview'; action: 'delete'; task: string };
export interface LocalReviewState {
  type: 'localReviewState';
  tasks: Array<{ id: string; project: string; status: string }>;
  storage: string;
  card?: TaskCard;
  preview?: SubmissionBundle;
  error?: string;
  notice?: string;
}
