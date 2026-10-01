// The experiment evidence panel, App side (cr-evidence #1394; CR-24–CR-27, CR-69, CR-72, CR-74).
// Pure over its ports and vscode-free, so a smoke drives exactly what the provider runs.
//
// It reads the student's Project's experiments and one experiment's evidence from the Service
// (`GET /v1/curriculum/experiments/:id/evidence`), and sends the student's own actions back: a
// manual record with the provenance its kind needs (CR-24), "기록에서 초안 만들기" (the
// runtime's observed statements over the records, CR-25), accept / edit / reject of draft items
// (a new revision, CR-26), and deletion of one participant session or the whole experiment's
// test data (CR-69). Nothing is copied into the App's workspaceState: the record lives on the
// Service (recon R6, SX-48).

import { curriculumRequest, type CurriculumResult } from "./galleryPublish.ts";
import { latestDrafts, noteBody, noteFormProblems, type EvidenceDraftView, type EvidenceExperimentView, type EvidenceView, type NoteForm } from "./evidenceView.ts";

export interface EvidencePorts {
  switchOn(): boolean;
  token(): Promise<string | null>;
  base(): string;
  fetchImpl?: typeof fetch;
  /** The student's Project, as the publish panel remembered it (crProjectMemory). */
  projectId(): string | undefined;
}

type Client = { base: string; token: string; fetchImpl?: typeof fetch };

/** Refusals the Service names, in the student's words. */
export const EVIDENCE_MESSAGES: Record<string, string> = {
  missing_provenance: "누가 · 언제 · 어떤 상황인지 모두 적어 주세요.",
  missing_source_state: "실제로 있었던 일인지 골라 주세요.",
  missing_locator: "자료의 어느 부분인지(쪽, 주소) 적어 주세요.",
  variant_required: "비교 실험에서는 어느 쪽에 대한 기록인지 골라 주세요.",
  unknown_variant: "고른 비교 대상이 이 실험에 없어요.",
  invalid_note: "기록을 저장하지 못했어요. 내용을 다시 확인해 주세요.",
  note_limit: "이 실험에는 기록을 더 저장할 수 없어요.",
  no_evidence_recorded: "아직 기록된 참가 세션이나 메모가 없어요. 링크를 나눠 주거나 메모를 먼저 남겨 주세요.",
  unresolved_source_refs: "근거를 찾을 수 없는 문장이 있어서 저장하지 않았어요.",
  observation_not_editable: "관찰한 것은 기록 그대로라 고칠 수 없어요. 받아들이거나 버릴 수 있어요.",
  stale_revision: "다른 곳에서 먼저 바뀌었어요. 화면을 새로 불러온 뒤 다시 해 주세요.",
  deletion_reserved: "이 수업에서는 기록 지우기를 강사만 할 수 있어요.",
  experiment_data_deleted: "이 실험의 기록은 이미 지워졌어요.",
  draft_limit: "이 실험에는 초안을 더 저장할 수 없어요.",
};

/** The publish client's fallback says "공개하지 못했어요"; here the action is about records, so it says so. */
const msg = (r: { code: string; message: string; status?: number }) => EVIDENCE_MESSAGES[r.code] ?? (r.message.startsWith("공개하지 못했어요") ? `실험 기록을 처리하지 못했어요 (${r.status ?? "?"})` : r.message);
const SIGN_IN = "참여 코드를 먼저 입력해 주세요.";

type ProjectState = { experiments?: Array<{ id: string; question: string; week: number; status: string; data_deleted_at?: number; declarations?: { repeated_use?: true; variants?: EvidenceExperimentView["variants"] } }> };
type EvidenceAnswer = { evidence: Omit<EvidenceView, "available" | "experiments" | "selected" | "notice" | "drafts"> & { drafts: EvidenceDraftView[] } };

const EMPTY: Omit<EvidenceView, "available" | "experiments" | "selected" | "notice"> = { sessions: [], notes: [], drafts: [], returns: { status: "not_measured" }, variants: [], bursts: [] };

export class EvidenceSession {
  private selected: string | null = null;
  private readonly ports: EvidencePorts;
  constructor(ports: EvidencePorts) {
    this.ports = ports;
  }

  private async client(): Promise<Client | null> {
    const token = await this.ports.token();
    return token ? { base: this.ports.base(), token, ...(this.ports.fetchImpl ? { fetchImpl: this.ports.fetchImpl } : {}) } : null;
  }

  /** The panel's view: the Project's experiments and the selected one's evidence, read now. */
  async view(select?: string): Promise<EvidenceView> {
    const none = (notice: string): EvidenceView => ({ available: false, experiments: [], selected: null, notice, ...EMPTY });
    if (!this.ports.switchOn()) return none("이 수업에서는 실험 증거를 쓸 수 없어요.");
    const client = await this.client();
    if (!client) return none(SIGN_IN);
    const projectId = this.ports.projectId();
    if (!projectId) return none("아직 공개한 테스트가 없어요. 먼저 사용자 테스트용으로 공개해 주세요.");
    const p = await curriculumRequest<ProjectState>(client, "GET", `/projects/${encodeURIComponent(projectId)}`);
    if (!p.ok) return none(msg(p));
    const experiments: EvidenceExperimentView[] = (p.body.experiments ?? []).map((e) => ({
      id: e.id,
      question: e.question,
      week: e.week,
      status: e.status,
      data_deleted: e.data_deleted_at !== undefined,
      repeated_use: e.declarations?.repeated_use === true,
      variants: e.declarations?.variants ?? [],
    }));
    if (select !== undefined) this.selected = select;
    if (!this.selected || !experiments.some((e) => e.id === this.selected)) this.selected = experiments.at(-1)?.id ?? null;
    if (!this.selected) return { available: true, experiments, selected: null, notice: "아직 시작한 실험이 없어요.", ...EMPTY };
    const ev = await curriculumRequest<EvidenceAnswer>(client, "GET", `/experiments/${encodeURIComponent(this.selected)}/evidence`);
    if (!ev.ok) return { available: true, experiments, selected: this.selected, notice: msg(ev), ...EMPTY };
    const e = ev.body.evidence;
    return {
      available: true,
      experiments,
      selected: this.selected,
      notice: null,
      sessions: e.sessions,
      notes: e.notes,
      drafts: latestDrafts(e.drafts),
      returns: e.returns,
      variants: e.variants,
      bursts: e.bursts,
    };
  }

  private async act<T>(fn: (c: Client) => Promise<CurriculumResult<T>>): Promise<{ ok: true; body: T } | { ok: false; message: string; detail?: unknown }> {
    if (!this.ports.switchOn()) return { ok: false, message: "이 수업에서는 실험 증거를 쓸 수 없어요." };
    const client = await this.client();
    if (!client) return { ok: false, message: SIGN_IN };
    const r = await fn(client);
    return r.ok ? { ok: true, body: r.body } : { ok: false, message: msg(r), detail: r.detail };
  }

  /** CR-24 — a manual record. The form is checked first in the student's words; the Service refuses again by name. */
  async addNote(experimentId: string, form: NoteForm) {
    const problems = noteFormProblems(form);
    if (problems.length) return { ok: false as const, message: problems.join(" ") };
    return this.act((c) => curriculumRequest(c, "POST", `/experiments/${encodeURIComponent(experimentId)}/notes`, noteBody(form)));
  }

  /** CR-25 — the runtime's observed statements over the records, stored as a draft the student reviews. */
  makeDraft(experimentId: string) {
    return this.act((c) => curriculumRequest(c, "POST", `/experiments/${encodeURIComponent(experimentId)}/drafts`, { from_runtime: true }));
  }

  /** CR-26 — accept / edit / reject: a new revision; nothing raw changes. */
  review(experimentId: string, draftId: string, revision: number, actions: Array<{ item: string; action: "accept" | "edit" | "reject"; text?: string }>) {
    return this.act((c) => curriculumRequest(c, "POST", `/experiments/${encodeURIComponent(experimentId)}/drafts/${encodeURIComponent(draftId)}/review`, { revision, actions, reason: "학생이 읽고 고름" }));
  }

  /** CR-69 — one participant session, or (no session) the whole experiment's test data. */
  delete(experimentId: string, sessionId?: string) {
    const path = sessionId ? `/experiments/${encodeURIComponent(experimentId)}/sessions/${encodeURIComponent(sessionId)}` : `/experiments/${encodeURIComponent(experimentId)}`;
    return this.act<{ receipt: Record<string, unknown> }>((c) => curriculumRequest(c, "DELETE", path));
  }
}
