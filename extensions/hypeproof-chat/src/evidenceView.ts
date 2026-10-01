// The experiment evidence panel's view (cr-evidence #1394; CR-24–CR-27, CR-69, CR-72, CR-74),
// shared by the host (evidenceSession.ts) and the webview (EvidencePanel.tsx): no node or vscode
// imports. Everything here is a reading of what the Service answered; nothing is decided or
// stored on this side (SX-48).

export type SourceState = "ok" | "missing" | "deleted" | "foreign";

export interface EvidenceSessionView {
  session_id: string;
  at: number;
  variant: string | null;
  channel: string | null;
  pages: number;
  clicks: number;
  inputs: number;
  tasks: Record<string, { started: boolean; completed: boolean }>;
  milestones: string[];
}

export interface EvidenceNoteView {
  id: string;
  note_kind: string;
  text: string;
  provenance: { who: string; when: string; where: string };
  source_state: string;
  locator?: string;
  variant?: string;
}

export interface EvidenceItemView {
  id: string;
  section: "observation" | "interpretation" | "assumption" | "next_experiment";
  text: string;
  review: "draft" | "accepted" | "edited" | "rejected";
  source_refs: string[];
  /** How each reference resolves now (CR-27); absent on the runtime's unsaved items. */
  sources?: Array<{ ref: string; state: SourceState }>;
  comparison?: "supported" | "unsupported";
  basis?: "per_device_pseudonym";
}

export interface EvidenceDraftView {
  id: string;
  revision: number;
  author: "runtime" | "ai" | "user";
  created_at: number;
  items: EvidenceItemView[];
}

export interface EvidenceExperimentView {
  id: string;
  question: string;
  week: number;
  status: string;
  data_deleted: boolean;
  repeated_use: boolean;
  variants: Array<{ id: string; alternative?: string; product_version_id?: string }>;
}

export interface EvidenceView {
  available: boolean;
  experiments: EvidenceExperimentView[];
  selected: string | null;
  sessions: EvidenceSessionView[];
  notes: EvidenceNoteView[];
  /** The latest revision of each draft. */
  drafts: EvidenceDraftView[];
  returns: { status: "not_measured" } | { status: "measured"; devices: Array<{ pseudonym: string; return_count: number; intervals_ms: number[]; source_refs: string[] }> };
  variants: Array<{ variant: string; kind: "version" | "alternative"; subject: string; sessions: number; notes: number; tasks: Record<string, { started: number; completed: number }> }>;
  bursts: Array<{ link: string; busiest_hour_sessions: number; flagged: boolean }>;
  /** Why the panel is empty or what last went wrong. */
  notice: string | null;
}

/** The five manual record kinds (CR-24), in the student's words. */
export const NOTE_KIND_CHOICES = [
  { id: "observer_note", label: "관찰 메모", who: "누가 봤나요", where: "어떤 상황이었나요" },
  { id: "interview_note", label: "인터뷰 메모", who: "누구와 이야기했나요", where: "어떤 상황이었나요" },
  { id: "quote", label: "인용 · 바꿔 쓴 말", who: "누가 한 말인가요", where: "어떤 상황이었나요" },
  { id: "anomaly", label: "이상한 점", who: "누가 발견했나요", where: "어떤 상황이었나요" },
  { id: "external_source", label: "외부 자료", who: "누가 쓴 자료인가요", where: "자료 이름" },
] as const;

/** Real vs. simulated (SX-46): the student picks; nothing is preselected (CR-24). */
export const SOURCE_STATE_CHOICES = [
  { id: "real", label: "실제로 있었던 일" },
  { id: "simulated", label: "연습 · 가정해 본 것" },
  { id: "self_reported", label: "본인이 말해 준 것" },
  { id: "unverified", label: "아직 확인하지 못한 것" },
] as const;

export const SECTION_LABEL: Record<EvidenceItemView["section"], string> = {
  observation: "관찰한 것",
  interpretation: "해석",
  assumption: "아직 확인하지 않은 가정",
  next_experiment: "다음 실험",
};

export const REVIEW_LABEL: Record<EvidenceItemView["review"], string> = {
  draft: "초안",
  accepted: "받아들임",
  edited: "고침",
  rejected: "버림",
};

export interface NoteForm {
  note_kind: string;
  text: string;
  who: string;
  when: string;
  where: string;
  source_state: string;
  locator?: string;
  variant?: string;
}

/** What the student must still fill before a note can be saved, in their words (nothing is filled for them). */
export function noteFormProblems(form: NoteForm): string[] {
  const out: string[] = [];
  if (!NOTE_KIND_CHOICES.some((k) => k.id === form.note_kind)) out.push("기록 종류를 골라 주세요.");
  if (!form.text.trim()) out.push("내용을 적어 주세요.");
  if (!form.who.trim() || !form.when.trim() || !form.where.trim()) out.push("누가 · 언제 · 어떤 상황인지 모두 적어 주세요.");
  if (!SOURCE_STATE_CHOICES.some((s) => s.id === form.source_state)) out.push("실제로 있었던 일인지 골라 주세요.");
  if (form.note_kind === "external_source" && !form.locator?.trim()) out.push("자료의 어느 부분인지(쪽, 주소) 적어 주세요.");
  return out;
}

export function noteBody(form: NoteForm): Record<string, unknown> {
  return {
    note_kind: form.note_kind,
    text: form.text,
    provenance: { who: form.who.trim(), when: form.when.trim(), where: form.where.trim() },
    source_state: form.source_state,
    ...(form.note_kind === "external_source" ? { locator: (form.locator ?? "").trim() } : {}),
    ...(form.variant ? { variant: form.variant } : {}),
  };
}

const time = (ms: number) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** One row of what a claim cites, as the student reads it when they open the claim (CR-27). */
export interface SourceRow {
  ref: string;
  state: SourceState;
  /** "확인 필요" when the reference no longer resolves (SX-32, MC-15). */
  label: string;
  detail: string;
}

/**
 * The sources a claim opens to (CR-27): its sessions and notes in THIS experiment's evidence.
 * A reference the Service says does not resolve, or that is not among this experiment's
 * records, reads "확인 필요" and opens nothing.
 */
export function claimSources(view: Pick<EvidenceView, "sessions" | "notes">, item: Pick<EvidenceItemView, "source_refs" | "sources">): SourceRow[] {
  const states = new Map((item.sources ?? []).map((s) => [s.ref, s.state]));
  return item.source_refs.map((ref) => {
    const state: SourceState = states.get(ref) ?? "ok";
    const needs = { ref, state, label: "확인 필요", detail: "이 근거를 더 이상 찾을 수 없어요." };
    if (state !== "ok") return { ...needs, state };
    if (ref.startsWith("session:") || ref.startsWith("event:")) {
      const sid = ref.startsWith("session:") ? ref.slice(8) : ref.slice(6).split("/")[0]!;
      const s = view.sessions.find((x) => x.session_id === sid);
      if (!s) return { ...needs, state: "missing" };
      const tasks = Object.entries(s.tasks).map(([k, t]) => `${k} ${t.completed ? "마침" : t.started ? "시작만 함" : ""}`.trim());
      return { ref, state, label: `참가 세션 ${sid.slice(3, 9)}`, detail: [`${time(s.at)}`, `화면 ${s.pages} · 누름 ${s.clicks}`, ...tasks, ...(s.variant ? [`비교: ${s.variant}`] : [])].join(" · ") };
    }
    const n = view.notes.find((x) => `note:${x.id}` === ref);
    if (!n) return { ...needs, state: "missing" };
    const kind = NOTE_KIND_CHOICES.find((k) => k.id === n.note_kind)?.label ?? n.note_kind;
    return { ref, state, label: kind, detail: `${n.text} — ${n.provenance.who}, ${n.provenance.when}, ${n.provenance.where}` };
  });
}

/** The latest revision of each draft, newest draft first. */
export function latestDrafts<T extends { id: string; revision: number; created_at: number }>(drafts: readonly T[]): T[] {
  const by = new Map<string, T>();
  for (const d of drafts) if ((by.get(d.id)?.revision ?? 0) < d.revision) by.set(d.id, d);
  return [...by.values()].sort((a, b) => b.created_at - a.created_at);
}
