// One curriculum skill run's context (cr-skills #1396; CR-43–CR-47). Pure: the routes read the
// Project's Venture Memory, the product version and, for the Evidence skill, the experiment's
// records, and these functions shape what the model reads (`modelContextOf`, limited to the
// contract's `required_context`) and what the validation rules check against (`skillContextOf`).
// Both come from stored state only (SX-48); no chat history is read.

import type { SkillContract } from "../../skills/curriculum/contract.ts";
import type { SkillContext } from "../../skills/curriculum/rules.ts";
import { curriculumWeek } from "../../skills/curriculum/registry.ts";
import type { MemoryState } from "./memory.ts";
import type { ExperimentEvidence } from "./participant-record.ts";

export interface VersionForSkill {
  id: string;
  entry_html: string;
  files: Array<{ path: string; text?: string }>;
}

/** Text files of a version a skill may read (`version_sources`), and the bound on what is read. */
export const SOURCE_LIMITS = { files: 20, bytes: 200_000 } as const;
export const isSourcePath = (p: string) => /\.(html?|m?js|css)$/i.test(p);

/** The week a run is for: the input's, else the newest running experiment's, else 1. */
export function runWeek(memory: Pick<MemoryState, "experiments">, input: { week?: unknown }): number {
  if (Number.isInteger(input.week)) return input.week as number;
  const running = [...memory.experiments].filter((e) => e.status === "running").sort((a, b) => b.created_at - a.created_at)[0];
  return running?.week ?? 1;
}

/** What the validation rules check an output against. */
export function skillContextOf(memory: MemoryState, week: number, version: VersionForSkill | null): SkillContext {
  return {
    project_id: memory.project.id,
    week,
    items: memory.evidence_items.map((i) => ({
      id: i.id,
      statement: i.statement,
      confidence: i.confidence,
      pending_review: i.pending_review,
      sources_real: i.sources_real,
      ...(i.assumption_status ? { assumption_status: i.assumption_status } : {}),
      experiment_id: i.experiment_id,
    })),
    decisions: memory.decisions.map((d) => ({ id: d.id, actor: d.actor, statement: d.statement, affected_deck_slides: d.affected_deck_slides, evidence_refs: d.evidence_refs })),
    slides: memory.deck_slides.map((s) => ({ number: s.number, title: s.title, body: s.body, evidence_refs: s.evidence_refs })),
    hypotheses: memory.hypotheses.map((h) => ({ id: h.id, statement: h.statement, status: h.status })),
    experiments: memory.experiments.map((e) => ({ id: e.id, hypothesis_id: e.hypothesis_id, question: e.question, success_criteria: e.success_criteria, week: e.week })),
    version,
  };
}

/** The context the model reads: only the keys the contract requires. */
export function modelContextOf(
  contract: SkillContract,
  memory: MemoryState,
  extras: { week: number; version: VersionForSkill | null; records: ExperimentEvidence | null },
): Record<string, unknown> {
  const item = (i: MemoryState["evidence_items"][number]) => ({ id: i.id, statement: i.statement, confidence: i.confidence, pending_review: i.pending_review, sources_real: i.sources_real, ...(i.assumption_status ? { assumption_status: i.assumption_status } : {}) });
  const out: Record<string, unknown> = {};
  for (const key of contract.required_context) {
    switch (key) {
      case "curriculum_week": {
        const w = curriculumWeek(extras.week);
        out.curriculum_week = { week: w.week, question: w.question, required_behaviour: w.required_behaviour };
        break;
      }
      case "problem":
        out.problem = memory.problem;
        break;
      case "hypotheses":
        out.hypotheses = memory.hypotheses.map((h) => ({ id: h.id, statement: h.statement, status: h.status }));
        break;
      case "experiments":
        out.experiments = memory.experiments.map((e) => ({ id: e.id, hypothesis_id: e.hypothesis_id, week: e.week, question: e.question, method: e.method, success_criteria: e.success_criteria, status: e.status }));
        break;
      case "register":
        out.register = { observed: memory.register.observed.map(item), interpreted: memory.register.interpreted.map(item), assumed: memory.register.assumed.map(item) };
        break;
      case "evidence_items":
        out.evidence_items = memory.evidence_items.map(item);
        break;
      case "experiment_records":
        out.experiment_records = extras.records
          ? {
              experiment_id: extras.records.experiment_id,
              sessions: extras.records.sessions.map((s) => ({ ref: `session:${s.session_id}`, events: s.events, pages: s.pages, clicks: s.clicks, inputs: s.inputs, tasks: s.tasks, milestones: s.milestones, event_refs: s.event_ids.slice(0, 50).map((e) => `event:${s.session_id}/${e}`) })),
              notes: extras.records.notes.map((n) => ({ ref: `note:${n.id}`, note_kind: n.note_kind, text: n.text, source_state: n.source_state })),
            }
          : null;
        break;
      case "decisions":
        out.decisions = memory.decisions.map((d) => ({ id: d.id, shown_as: d.shown_as, statement: d.statement, affected_deck_slides: d.affected_deck_slides, evidence_refs: d.evidence_refs }));
        break;
      case "deck_slides":
        out.deck_slides = memory.deck_slides.map((s) => ({ claim_id: `slide:${s.number}`, number: s.number, title: s.title, body: s.body, evidence_refs: s.evidence_refs }));
        break;
      case "stakeholders":
        out.stakeholders = memory.stakeholders.map((s) => ({ id: s.id, label: s.label, roles: s.roles }));
        break;
      case "version_files":
        out.version_files = extras.version ? { id: extras.version.id, entry_html: extras.version.entry_html, files: extras.version.files.map((f) => f.path) } : null;
        break;
      case "version_sources":
        out.version_sources = extras.version ? extras.version.files.filter((f) => typeof f.text === "string").map((f) => ({ path: f.path, text: f.text })) : [];
        break;
    }
  }
  return out;
}
