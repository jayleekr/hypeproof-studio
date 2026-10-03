// The "프로젝트 기억" (Venture Memory) panel, App side (cr-memory #1395; CR-35–CR-38, CR-77–CR-79,
// CR-82). Pure over its ports and vscode-free, so a smoke drives exactly what the provider runs.
//
// It reads the team's learning state from the Service (`GET /v1/curriculum/projects/:id/memory`)
// and nothing else: no chat history, no workspaceState copy (CR-36, SX-48). The Project is the
// one the publish panel remembers; when nothing is remembered (a new machine, cleared local
// state), the newest Project the student is a member of is read, never created. The student's
// own writes are a decision (CR-38, author "user") and the version diff (CR-77).

import { curriculumRequest } from "./galleryPublish.ts";
import { decisionFormProblems, type DecisionForm, type MemoryAnswer, type MemoryView, type VersionDiffView } from "./memoryView.ts";

export interface MemoryPorts {
  switchOn(): boolean;
  token(): Promise<string | null>;
  base(): string;
  fetchImpl?: typeof fetch;
  /** The student's Project, as the publish panel remembered it (crProjectMemory). */
  projectId(): string | undefined;
}

export const MEMORY_MESSAGES: Record<string, string> = {
  unresolved_decision_refs: "고른 근거 중에 찾을 수 없는 것이 있어서 저장하지 않았어요. 화면을 새로 불러온 뒤 다시 골라 주세요.",
  invalid_decision: "결정을 저장하지 못했어요. 내용을 다시 확인해 주세요.",
  decision_limit: "이 프로젝트에는 결정을 더 저장할 수 없어요.",
  cross_project: "같은 프로젝트의 두 버전만 비교할 수 있어요.",
  same_version: "서로 다른 두 버전을 골라 주세요.",
};

const OFF = "이 수업에서는 프로젝트 기억을 쓸 수 없어요.";
const SIGN_IN = "참여 코드를 먼저 입력해 주세요.";
const msg = (r: { code: string; message: string; status?: number }) => MEMORY_MESSAGES[r.code] ?? (r.message.startsWith("공개하지 못했어요") ? `프로젝트 기억을 읽지 못했어요 (${r.status ?? "?"})` : r.message);

export class MemorySession {
  private readonly ports: MemoryPorts;
  private diff: VersionDiffView | null = null;
  constructor(ports: MemoryPorts) {
    this.ports = ports;
  }

  private async client() {
    const token = await this.ports.token();
    return token ? { base: this.ports.base(), token, ...(this.ports.fetchImpl ? { fetchImpl: this.ports.fetchImpl } : {}) } : null;
  }

  /** The remembered Project, else the newest one the student is a member of (read only). */
  private async project(client: { base: string; token: string; fetchImpl?: typeof fetch }): Promise<string | null> {
    const remembered = this.ports.projectId();
    if (remembered) return remembered;
    const list = await curriculumRequest<{ projects?: Array<{ id: string; created_at: number }> }>(client, "GET", "/projects");
    if (!list.ok) return null;
    return [...(list.body.projects ?? [])].sort((a, b) => b.created_at - a.created_at)[0]?.id ?? null;
  }

  /** The panel's view, read now. */
  async view(): Promise<MemoryView> {
    const none = (notice: string): MemoryView => ({ available: false, memory: null, diff: null, notice });
    if (!this.ports.switchOn()) return none(OFF);
    const client = await this.client();
    if (!client) return none(SIGN_IN);
    const projectId = await this.project(client);
    if (!projectId) return none("아직 프로젝트가 없어요. 먼저 사용자 테스트용으로 공개해 주세요.");
    const r = await curriculumRequest<{ memory: MemoryAnswer }>(client, "GET", `/projects/${encodeURIComponent(projectId)}/memory`);
    if (!r.ok) return none(msg(r));
    if (this.diff && !r.body.memory.versions.some((v) => v.id === this.diff!.to.id)) this.diff = null;
    return { available: true, memory: r.body.memory, diff: this.diff, notice: null };
  }

  /** CR-77 — two versions of the Project, compared by the Service. */
  async compare(from: string, to: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!this.ports.switchOn()) return { ok: false, message: OFF };
    const client = await this.client();
    if (!client) return { ok: false, message: SIGN_IN };
    const projectId = await this.project(client);
    if (!projectId) return { ok: false, message: "아직 프로젝트가 없어요." };
    const r = await curriculumRequest<{ diff: VersionDiffView }>(client, "GET", `/projects/${encodeURIComponent(projectId)}/memory/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!r.ok) return { ok: false, message: msg(r) };
    this.diff = r.body.diff;
    return { ok: true };
  }

  /** CR-38 — the team's decision, written by the student (never as an AI suggestion). */
  async decide(form: DecisionForm): Promise<{ ok: true } | { ok: false; message: string }> {
    const problems = decisionFormProblems(form);
    if (problems.length) return { ok: false, message: problems.join(" ") };
    if (!this.ports.switchOn()) return { ok: false, message: OFF };
    const client = await this.client();
    if (!client) return { ok: false, message: SIGN_IN };
    const projectId = await this.project(client);
    if (!projectId) return { ok: false, message: "아직 프로젝트가 없어요." };
    const r = await curriculumRequest(client, "POST", `/projects/${encodeURIComponent(projectId)}/decisions`, {
      author: "user",
      statement: form.statement.trim(),
      evidence_refs: form.evidence_refs,
      assumption_refs: form.assumption_refs,
      affected_deck_slides: form.affected_deck_slides,
      resulting_version_id: form.resulting_version_id,
    });
    return r.ok ? { ok: true } : { ok: false, message: msg(r) };
  }
}
