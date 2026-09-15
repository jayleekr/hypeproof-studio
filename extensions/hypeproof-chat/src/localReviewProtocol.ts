import type { Task, Review, Receipt, SubmissionBundle, Improvement } from '../../../worker/src/lib/measurement-core/local-record.ts';
import type { Interpretation } from '../../../worker/src/lib/measurement-core/interpretation.ts';
import type { ObservationEvent } from '../../../worker/src/lib/measurement-core/legacy-observation.ts';
export type ReviewHost = 'claude-code' | 'codex';
export interface TaskCard {
  task: Task;
  source: { host: ReviewHost; session: string; digest: string; evidence: 'captured-replay'; limitations: string[]; exclusions: string[]; conditions?: Array<{ line: number; at: string | null; model: string; reasoning: string | null }>; snapshots?: Array<{ digest: string; at: number; messages: number }> };
  observations: Array<{ key: string; event: ObservationEvent }>;
  interpretation: Interpretation;
  reviews: Review[];
  receipts: Receipt[];
  improvements: Improvement[];
}
export type LocalReviewRequest =
  | { type: 'localReview'; action: 'load' }
  | { type: 'localReview'; action: 'import'; host: ReviewHost }
  | { type: 'localReview'; action: 'recent'; host: ReviewHost }
  | { type: 'localReview'; action: 'open'; task: string }
  | { type: 'localReview'; action: 'purpose'; task: string; text: string }
  | { type: 'localReview'; action: 'review'; task: string; capability: string; decision: Review['action']; text: string; evidence?: string[] }
  | { type: 'localReview'; action: 'improvement'; task: string; text: string }
  | { type: 'localReview'; action: 'followUp'; task: string; improvement: string; attempt: 'tried' | 'not_tried' | 'unknown'; observed: string }
  | { type: 'localReview'; action: 'preview'; task: string; includeEvidence: boolean }
  | { type: 'localReview'; action: 'submit'; task: string; digest: string }
  | { type: 'localReview'; action: 'delete'; task: string };
export interface LocalReviewState {
  type: 'localReviewState';
  tasks: Array<{ id: string; project: string; status: string }>;
  storage: string;
  improvements?: Improvement[];
  card?: TaskCard;
  preview?: SubmissionBundle;
  error?: string;
  notice?: string;
}
