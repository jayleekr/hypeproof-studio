// The "프로젝트 기억" (Venture Memory) panel's view (cr-memory #1395; CR-35–CR-42, CR-75–CR-79,
// CR-82), shared by the host (memorySession.ts) and the webview (MemoryPanel.tsx): no node or
// vscode imports. Everything here is a reading of what the Service answered
// (`GET /v1/curriculum/projects/:id/memory`); nothing is decided or stored on this side, and no
// chat history is read (CR-36): the view is a function of that answer alone.

export type Confidence = "observed" | "interpreted" | "assumed";

export interface MemoryItemView {
  id: string;
  statement: string;
  confidence: Confidence;
  review: string;
  revision: number;
  experiment_id: string;
  revisions: Array<{ revision: number; confidence: Confidence; statement: string }>;
  assumption_status?: "open" | "observed_later";
  cited_by?: Array<{ decision_id: string; shown_as: "team_decision" | "ai_suggestion" }>;
  slides?: number[];
}

export interface MemoryDecisionView {
  id: string;
  statement: string;
  actor: "student" | "ai";
  shown_as: "team_decision" | "ai_suggestion";
  no_evidence: boolean;
  decided_at: number | string;
  resulting_version_id: string | null;
  affected_deck_slides: number[];
  evidence: Array<{ ref: string; state: "ok" | "missing"; statement?: string }>;
  assumptions: Array<{ ref: string; state: "ok" | "missing"; statement?: string }>;
}

export interface MemoryAnswer {
  format: "hps-venture-memory/1";
  project: { id: string; title: string; members: string[] };
  problem: string | null;
  stakeholders: Array<{ id: string; label: string; payer_and_user: boolean; roles_shown: Array<{ role: string; confidence: "observed" | "assumed" }> }>;
  hypotheses: Array<{ id: string; statement: string; status: string; revision: number; revisions: Array<{ revision: number; statement: string; status: string }> }>;
  experiments: Array<{ id: string; question: string; week: number; status: string; hypothesis_id: string; product_version_id: string }>;
  evidence_items: MemoryItemView[];
  decisions: MemoryDecisionView[];
  versions: Array<{ id: string; created_at: number; entry_html: string }>;
  metrics: Array<{ id: string; name: string; unit: string; metric_kind: string; value: { status: "result" | "unsupported" | "evidence_only"; value: number | null; source_refs: string[]; not_counted: Record<string, number> } }>;
  deck_slides: Array<{ number: number; title: string; revision: number }>;
  register: { observed: MemoryItemView[]; interpreted: MemoryItemView[]; assumed: MemoryItemView[] };
  timeline: Array<{ at: number; entry: string; label: string; record: { kind: string; id: string; revision?: number } }>;
  belief_changes: Array<{ hypothesis_id: string; before: { statement: string; status: string }; after: { statement: string; status: string }; decision: { id: string; statement: string } | null; evidence: Array<{ ref: string; statement: string }>; reason: "recorded" | "reason_not_recorded" }>;
  chains: unknown[];
}

export interface VersionDiffView {
  from: { id: string };
  to: { id: string };
  files: Array<{ path: string; change: "added" | "removed" | "modified" }>;
  decisions: MemoryDecisionView[];
  reason: "recorded" | "no_recorded_decision";
}

export interface MemoryView {
  available: boolean;
  memory: MemoryAnswer | null;
  diff: VersionDiffView | null;
  /** Why the panel is empty or what last went wrong. */
  notice: string | null;
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = { observed: "확인한 것", interpreted: "해석", assumed: "가정" };
export const STATUS_LABEL: Record<string, string> = { open: "아직 확인 중", supported: "맞았어요", refuted: "틀렸어요", revised: "고쳐 썼어요" };
export const ROLE_LABEL: Record<string, string> = { user: "쓰는 사람", payer: "돈 내는 사람", beneficiary: "도움 받는 사람" };
export const ENTRY_LABEL: Record<string, string> = {
  hypothesis: "가설",
  hypothesis_revised: "가설 고침",
  experiment: "실험",
  product_version: "제품 버전",
  evidence_item: "근거",
  decision: "팀 결정",
  ai_suggestion: "AI 제안 (팀 결정 아님)",
  deck_slide: "발표 슬라이드",
};
export const CHANGE_LABEL: Record<string, string> = { added: "새로 생김", removed: "없어짐", modified: "바뀜" };

/** "we believed X; after this evidence we believe Y; so we changed Z" — only from the links; otherwise the fixed sentence. */
export function beliefSentence(b: MemoryAnswer["belief_changes"][number]): string {
  if (b.reason !== "recorded") return `처음엔 "${b.before.statement}"라고 믿었고, 지금은 "${b.after.statement}"라고 믿어요. 왜 바뀌었는지는 기록되지 않았어요.`;
  const why = b.evidence.map((e) => `"${e.statement}"`).join(", ");
  return `처음엔 "${b.before.statement}"라고 믿었어요. ${why}를 보고 "${b.after.statement}"라고 믿게 됐어요.${b.decision ? ` 그래서 "${b.decision.statement}"로 바꿨어요.` : ""}`;
}

/**
 * What a reopened project must show again (CR-36, CR-T36): hypotheses with their revisions,
 * experiments, decisions and versions, keyed by id. A function of the Service's answer only,
 * so it is the same with or without chat history.
 */
export function reconstructionDigest(m: MemoryAnswer): string {
  return JSON.stringify({
    hypotheses: m.hypotheses.map((h) => [h.id, h.statement, h.status, h.revisions.length]).sort(),
    experiments: m.experiments.map((e) => [e.id, e.question, e.status, e.hypothesis_id, e.product_version_id]).sort(),
    decisions: m.decisions.map((d) => [d.id, d.statement, d.actor, d.resulting_version_id, d.evidence.length]).sort(),
    versions: m.versions.map((v) => v.id).sort(),
  });
}

/** The decision form (CR-38, CR-41): checked in the student's words before the Service checks again. */
export interface DecisionForm {
  statement: string;
  evidence_refs: string[];
  assumption_refs: string[];
  affected_deck_slides: number[];
  resulting_version_id: string | null;
}

export function decisionFormProblems(f: DecisionForm): string[] {
  const out: string[] = [];
  if (!f.statement.trim()) out.push("무엇을 하기로 했는지 적어 주세요.");
  if (f.statement.length > 1000) out.push("결정은 1000자 안으로 적어 주세요.");
  if (f.affected_deck_slides.some((n) => !Number.isInteger(n) || n < 1 || n > 8)) out.push("발표 슬라이드는 1번부터 8번까지예요.");
  return out;
}
