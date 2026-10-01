// The "사용자 테스트용으로 공개" panel state (cr-publish, #1393). Types only, shared by the
// host (publishSession.ts) and the webview (PublishPanel.tsx): no node or vscode imports.
import type { ProductVerification } from "../../../worker/src/lib/measurement-core/verification.ts";

export interface PublishLinkView {
  id: string;
  channel: string | null;
  share_url: string | null;
  /** The QR of `share_url` as an image data URL, drawn on this machine; null when not live. */
  qr: string | null;
  expires_at: number;
  state: "live" | "revoked" | "expired";
}

export interface PublishExperimentView {
  id: string;
  week: number;
  question: string;
  method: string;
  success_criteria: string[];
  hypothesis: string | null;
  product_version_id: string;
  /** Is this the version now in the preview? */
  current_version: boolean;
  status: string;
  links: PublishLinkView[];
  /** Link opens per channel (a usage observation, never a demand claim; SX-58). */
  sessions: { channels: Record<string, number>; unlabelled: number; unknown: number } | null;
}

export interface PublishView {
  available: boolean;
  reason: string | null;
  project: { id: string; title: string } | null;
  /** The version in the preview now, as it would be published (R4 set plus manifest). */
  version: { id: string | null; files: Array<{ path: string; bytes: number }>; manifest_added: string[]; refusal: string | null; refusal_lines: string[] };
  /** CR-81: read from the record's events for exactly `version.id`; never set here. */
  verification: ProductVerification;
  hypotheses: Array<{ id: string; statement: string }>;
  experiments: PublishExperimentView[];
  /** The last publish's timing (CR-64): under 10 s, or a recorded miss with its cause. */
  timing: { ms: number; ok: boolean; cause: string | null } | null;
  notice: string | null;
}

/** What the student fills in to start a test (CR-39 fields the student owns). */
export interface PublishForm {
  title?: string;
  /** Curriculum week (1–6 for the v5 course); the lesson's week when the panel knows it. */
  week?: number;
  hypothesis_id?: string;
  hypothesis?: string;
  question: string;
  method: string;
  success_criteria: string[];
  channel?: string;
  /** Days until the link expires; required while no default is set (CR-19). */
  expires_in_days?: number;
  manifest?: string[];
  devices?: Array<"microphone" | "camera">;
  repeated_use?: boolean;
}

export const EXPIRY_CHOICES = [1, 3, 7, 14] as const;
export const METHOD_CHOICES = [
  { id: "task_test", label: "과제 해 보기" },
  { id: "interview", label: "인터뷰" },
  { id: "observation", label: "지켜보기" },
] as const;
