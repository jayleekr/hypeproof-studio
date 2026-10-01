// The "커리큘럼 스킬" panel, App side (cr-skills #1396; CR-43–CR-47). Pure over its ports and
// vscode-free, so a smoke drives exactly what the provider runs.
//
// A run is three steps, and the App decides none of the outcome:
//   1. `POST …/skills/:skill/prepare` — the Service builds the prompt from the bundled skill, its
//      contract and the Project's stored state, and names the request metadata (the skill tag and
//      a capability, never a model id; CR-45).
//   2. `complete` — the prompt goes through the existing coach route (`/v1/chat/completions`)
//      with that metadata; the lesson model policy picks the model.
//   3. `POST …/skills/:skill/output` — the Service validates the answer and writes only the
//      contract's write-back targets (CR-44). A refusal shows its problems; nothing was stored.
//
// The skill list comes from the Service only: a file in the student's workspace is never a skill.

import { curriculumRequest } from "./galleryPublish.ts";
import type { MemoryAnswer } from "./memoryView.ts";
import { SKILL_MESSAGES, extractJsonObject, resultSections, skillFormProblems, skillInput, writtenLines, type SkillForm, type SkillListing, type SkillResult, type SkillsView, type SkillWeek } from "./skillView.ts";

export interface SkillCompletion {
  ok: boolean;
  text?: string;
  /** The model the coach route answered with (`x-hps-model`), for the record. */
  model?: string | null;
  status?: number;
}

export interface SkillPorts {
  switchOn(): boolean;
  token(): Promise<string | null>;
  base(): string;
  fetchImpl?: typeof fetch;
  projectId(): string | undefined;
  /** One coach-route request with the run's metadata headers. */
  complete(prompt: string, headers: Record<string, string>): Promise<SkillCompletion>;
}

const OFF = "이 수업에서는 커리큘럼 스킬을 쓸 수 없어요.";
const SIGN_IN = "참여 코드를 먼저 입력해 주세요.";
const NO_PROJECT = "아직 프로젝트가 없어요. 먼저 사용자 테스트용으로 공개해 주세요.";
const msg = (r: { code: string; message: string; status?: number }) => SKILL_MESSAGES[r.code] ?? (r.message.startsWith("공개하지 못했어요") ? `스킬을 실행하지 못했어요 (${r.status ?? "?"})` : r.message);

/** Usable evidence for a team's work: reviewed, real, not an assumption (memory.ts `supportsTeamEvidence`). */
const usable = (i: MemoryAnswer["evidence_items"][number]) => i.confidence !== "assumed" && !i.pending_review && i.sources_real !== false;

export class SkillSession {
  private readonly ports: SkillPorts;
  private result: SkillResult | null = null;
  private running = false;
  constructor(ports: SkillPorts) {
    this.ports = ports;
  }

  private async client() {
    const token = await this.ports.token();
    return token ? { base: this.ports.base(), token, ...(this.ports.fetchImpl ? { fetchImpl: this.ports.fetchImpl } : {}) } : null;
  }

  private async project(client: { base: string; token: string; fetchImpl?: typeof fetch }): Promise<string | null> {
    const remembered = this.ports.projectId();
    if (remembered) return remembered;
    const list = await curriculumRequest<{ projects?: Array<{ id: string; created_at: number }> }>(client, "GET", "/projects");
    if (!list.ok) return null;
    return [...(list.body.projects ?? [])].sort((a, b) => b.created_at - a.created_at)[0]?.id ?? null;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** The panel's view, read now: the Service's skills and curriculum week, and the form choices from Venture Memory. */
  async view(): Promise<SkillsView> {
    const none = (notice: string): SkillsView => ({ available: false, notice, week: null, skills: [], pickers: { experiments: [], decisions: [], evidence: [] }, result: this.result });
    if (!this.ports.switchOn()) return none(OFF);
    const client = await this.client();
    if (!client) return none(SIGN_IN);
    const reg = await curriculumRequest<{ curriculum: { weeks: SkillWeek[] }; skills: SkillListing[] }>(client, "GET", "/skills");
    if (!reg.ok) return none(msg(reg));
    const projectId = await this.project(client);
    if (!projectId) return { ...none(NO_PROJECT), skills: reg.body.skills };
    const mem = await curriculumRequest<{ memory: MemoryAnswer }>(client, "GET", `/projects/${encodeURIComponent(projectId)}/memory`);
    if (!mem.ok) return { ...none(msg(mem)), skills: reg.body.skills };
    const m = mem.body.memory;
    const running = [...m.experiments].filter((e) => e.status === "running").sort((a, b) => b.week - a.week)[0];
    const weekNo = running?.week ?? 1;
    const week = reg.body.curriculum.weeks.find((w) => w.week === weekNo) ?? reg.body.curriculum.weeks[0] ?? null;
    return {
      available: true,
      notice: null,
      week: week ? { week: week.week, question: week.question } : null,
      skills: reg.body.skills,
      pickers: {
        experiments: m.experiments.map((e) => ({ id: e.id, label: `${e.week}주차 · ${e.question}` })),
        decisions: m.decisions.filter((d) => d.shown_as === "team_decision" && d.affected_deck_slides.length).map((d) => ({ id: d.id, label: d.statement, slides: d.affected_deck_slides })),
        evidence: m.evidence_items.filter(usable).map((i) => ({ id: i.id, label: i.statement })),
      },
      result: this.result,
    };
  }

  /** Run one skill. Refused before any call when the switch is off or the form is incomplete. */
  async run(skill: string, form: SkillForm): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!this.ports.switchOn()) return { ok: false, message: OFF };
    const formProblems = skillFormProblems(skill, form);
    if (formProblems.length) return { ok: false, message: formProblems.join(" ") };
    if (this.running) return { ok: false, message: "스킬이 이미 실행 중이에요." };
    const client = await this.client();
    if (!client) return { ok: false, message: SIGN_IN };
    this.running = true;
    try {
      const projectId = await this.project(client);
      if (!projectId) return { ok: false, message: NO_PROJECT };
      const path = `/projects/${encodeURIComponent(projectId)}/skills/${encodeURIComponent(skill)}`;
      const input = skillInput(skill, form);
      const prep = await curriculumRequest<{ skill: string; capability: string; headers: Record<string, string>; prompt: string }>(client, "POST", `${path}/prepare`, { input });
      if (!prep.ok) return this.fail(skill, "", msg(prep), (prep.detail?.problems as string[] | undefined) ?? []);
      const answer = await this.ports.complete(prep.body.prompt, prep.body.headers);
      if (!answer.ok || typeof answer.text !== "string") return this.fail(skill, prep.body.skill, SKILL_MESSAGES.model_failed!, []);
      const output = extractJsonObject(answer.text);
      if (!output) return this.fail(skill, prep.body.skill, SKILL_MESSAGES.not_json!, []);
      const done = await curriculumRequest<{ skill: string; output: Record<string, unknown>; written: Array<{ target: string; id: string }> }>(client, "POST", `${path}/output`, { input, output, request: { model: answer.model ?? null } });
      if (!done.ok) return this.fail(skill, prep.body.skill, msg(done), (done.detail?.problems as string[] | undefined) ?? []);
      this.result = { skill, tag: done.body.skill, ok: true, sections: resultSections(skill, done.body.output as Record<string, any>), written: writtenLines(done.body.written) };
      return { ok: true };
    } finally {
      this.running = false;
    }
  }

  private fail(skill: string, tag: string, message: string, problems: string[]): { ok: false; message: string } {
    this.result = { skill, tag, ok: false, message, problems };
    return { ok: false, message };
  }
}
