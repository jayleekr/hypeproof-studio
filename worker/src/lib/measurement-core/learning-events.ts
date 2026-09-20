// Learning events, their fields and the two task-flow gates (P1-A; SX-14, SX-15,
// SX-18, SX-22, SX-44–SX-48, SX-55).
//
// This file is a TABLE and two PURE FUNCTIONS. It is not a second validator, not a
// second store and not a grader (SX-48, rubric C4):
//
//   - the table is read by `legacy-observation.ts`, which stays the ONE validator;
//   - `gates()` and `nextStep()` read events and answer a yes/no with a named
//     reason. They produce no number, keep no state and are never stored — the
//     design says the gate result is computed from the events every time, so a
//     stored copy can never disagree with the events.
//
// Field names, enums, per-kind required fields and defaults are copied from
// docs/design/studio-learning-experience.md "관측 이벤트와 필드" and
// "과제 흐름 상태 기계". Where this file had to decide something the design leaves
// open, the comment says so in place rather than quietly picking.
//
// Imports: TYPES only. `legacy-observation.ts` imports this file for real, so a
// value import back would make the core cyclic.
import type { ObservationEvent } from "./legacy-observation.ts";

/** 학습 이벤트 8종 (SX-47). The order is the design table's order. */
export const LEARNING_EVENT_KINDS = [
  "problem_committed",
  "criterion_set",
  "test_observed",
  "change_requested",
  "retest_confirmed",
  "external_feedback_received",
  "decision_revised",
  "reflection_submitted",
] as const;
export type LearningEventKind = (typeof LEARNING_EVENT_KINDS)[number];

/** 근거 종류 6종 (SX-18). A kind of thing left behind, never a judgment about a person. */
export const EVIDENCE_TYPES = ["intent", "criterion", "action", "decision", "change", "ownership"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** 출처 종류 6종 (SX-22). */
export const SOURCE_KINDS = ["link", "article", "policy", "interview", "test", "none"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** 실제/가상 (SX-46). Fixed when the event is stored; a correction is a new event, never an edit. */
export const SOURCE_STATES = ["real", "simulated", "self_reported", "unverified"] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

/**
 * Who acted. `user` is the student themselves — the /1 value is kept so nothing has
 * to be remapped; the screen label is "학생" (SX-44).
 */
export const OBSERVATION_ACTORS = ["user", "ai", "teacher", "external_user", "policy"] as const;
export type ObservationActor = (typeof OBSERVATION_ACTORS)[number];

/** 강사 확인 (SX-42). Never stored on an event: observations are append-only. */
export const TEACHER_STATES = ["unreviewed", "confirmed", "disputed"] as const;
export type TeacherState = (typeof TEACHER_STATES)[number];

/** Outcome of a check the student ran. Separate from the /1 tool outcome enum. */
export const LEARNING_OUTCOMES = ["match", "mismatch", "unknown"] as const;
export type LearningOutcome = (typeof LEARNING_OUTCOMES)[number];

/**
 * Anything shaped like a personal score, level or ranking, refused wherever it
 * appears inside a /2 event (SX-48, MC-19) — including nested, so a `context` or a
 * `provenance` cannot smuggle one in.
 *
 * The list is NOT exported. `interpretation.ts` keeps its own copy (its walk also
 * refuses legacy-conversion keys, and the per-key order there is behaviour), and
 * MC-T09 asserts the core exports nothing whose name reads like a score. The
 * copies are locked behaviourally instead: worker/test/learning-events.test.mjs
 * drives both refusals from one key list, so a key added to one and not the other
 * fails the suite.
 */
const PERSONAL_METRIC_KEYS = ["score", "scores", "level", "points", "rank", "percentile", "grade"];

/** Throws `unsupported_score` if `value` carries one of those names at any depth. */
export function forbidPersonalMetrics(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(forbidPersonalMetrics);
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (PERSONAL_METRIC_KEYS.includes(k)) throw new Error("unsupported_score");
    forbidPersonalMetrics(v);
  }
}

/** The `/2`-only keys an event may carry, on top of the `/1` ones. */
export const LEARNING_EVENT_KEYS = [
  "context",
  "evidence_type",
  "source_kind",
  "source_state",
  "student_text",
  "artifact_before",
  "artifact_after",
  "criterion_ref",
  "turn_ref",
  "result_ref",
  "evidence_refs",
  "provenance",
  "adopted_from",
  "decision",
  "next_experiment",
] as const;

/** Keys that name another event in the same batch. A missing target is `orphan_ref`. */
export const REF_KEYS = ["criterion_ref", "turn_ref", "result_ref", "adopted_from"] as const;
/** Keys that name an `artifact` event's sha256 in the same batch. Missing is `unknown_artifact`. */
export const ARTIFACT_REF_KEYS = ["artifact_before", "artifact_after"] as const;

export interface LearningKindSpec {
  /** The actor the host fills in by default. NOT forced: SX-45 needs an actor=ai decision to be recordable. */
  actor: ObservationActor;
  /** Required fields, from the design's per-kind table. `context` is required for every learning kind. */
  required: readonly string[];
  /** The fixed evidence_type, or null when the session design's step decides it. */
  evidence_type: EvidenceType | null;
  /** The default source_state, or null when the student must pick (nothing is filled in for them). */
  source_state: SourceState | null;
}

/**
 * The per-kind table. Read it against the design document line by line — that is
 * what it is for.
 *
 * `context` appears in every `required` list because the /2 field table makes it
 * mandatory for learning kinds; the per-kind table only lists the extras.
 */
export const LEARNING_EVENT_SPEC: Readonly<Record<LearningEventKind, LearningKindSpec>> = {
  problem_committed: { actor: "user", required: ["student_text", "context"], evidence_type: "intent", source_state: "self_reported" },
  criterion_set: { actor: "user", required: ["student_text", "context"], evidence_type: "criterion", source_state: "self_reported" },
  test_observed: { actor: "user", required: ["criterion_ref", "artifact_after", "outcome", "context"], evidence_type: "action", source_state: "self_reported" },
  change_requested: { actor: "user", required: ["student_text", "criterion_ref", "artifact_before", "turn_ref", "context"], evidence_type: "change", source_state: "self_reported" },
  retest_confirmed: { actor: "user", required: ["criterion_ref", "artifact_after", "outcome", "context"], evidence_type: "action", source_state: "self_reported" },
  external_feedback_received: { actor: "external_user", required: ["student_text", "provenance", "source_state", "context"], evidence_type: null, source_state: null },
  decision_revised: { actor: "user", required: ["student_text", "decision", "evidence_refs", "context"], evidence_type: "decision", source_state: "self_reported" },
  reflection_submitted: { actor: "user", required: ["student_text", "next_experiment", "context"], evidence_type: "ownership", source_state: "self_reported" },
};

export const isLearningEventKind = (kind: unknown): kind is LearningEventKind =>
  (LEARNING_EVENT_KINDS as readonly string[]).includes(String(kind));

/** The default source_state for a kind, or null when there is none and the student must say. */
export function defaultSourceState(kind: unknown): SourceState | null {
  if (!isLearningEventKind(kind)) return "unverified";
  return LEARNING_EVENT_SPEC[kind].source_state;
}

/**
 * What an event's source_state IS, stored value first.
 *
 * A stored value wins; absent falls back to the kind default; an event with no
 * kind default at all (every legacy kind) is `unverified` — 출처 미확인. Nothing is
 * ever promoted to `real` here; that takes provenance or a bound executed result,
 * and the validator is what enforces it.
 */
export function sourceStateOf(event: { kind?: unknown; source_state?: unknown }): SourceState {
  const stored = event.source_state;
  if (typeof stored === "string" && (SOURCE_STATES as readonly string[]).includes(stored)) return stored as SourceState;
  return defaultSourceState(event.kind) ?? "unverified";
}

/** The student acted themselves. `user` is the student; every other actor is someone (or something) else. */
export const isStudentAuthored = (event: { actor?: unknown }): boolean => event.actor === "user";

/** A coach-proposed criterion the student accepted keeps this marker (design, rule 4). */
export const isAdoptedFromCoach = (event: { adopted_from?: unknown }): boolean => typeof event.adopted_from === "string";

const studentText = (event: { student_text?: unknown }): string =>
  typeof event.student_text === "string" ? event.student_text.trim() : "";

/**
 * Human evidence (MC-10, extended by /2 rule 3).
 *
 * /1: only the person's own messages — `user` and `correction`. An assistant
 * message, a policy approval and a tool result never counted and still do not.
 * /2 adds the student's own learning events. `actor=ai` is never human, whatever
 * the kind; neither is a teacher's or an external person's event.
 */
export function isHumanEvidence(event: { kind?: unknown; actor?: unknown }): boolean {
  if (event.actor === "ai" || event.actor === "teacher" || event.actor === "external_user" || event.actor === "policy") return false;
  if (event.kind === "user" || event.kind === "correction") return true;
  return isLearningEventKind(event.kind) && isStudentAuthored(event);
}

/**
 * Does this event satisfy a gate that names `kind`?
 *
 * SX-14 spells the completion rule as "actor=user, student_text 비어 있지 않은".
 * Two of the eight kinds (`test_observed`, `retest_confirmed`) have no
 * `student_text` at all, so requiring it for them would make a gate naming them
 * unsatisfiable — an instructor can name any of the eight in `learning.completion`.
 * So the text requirement is applied where the kind's own table has the field.
 */
export function satisfiesGate(event: ObservationEvent, kind: LearningEventKind): boolean {
  if (event.kind !== kind || !isStudentAuthored(event)) return false;
  if (!LEARNING_EVENT_SPEC[kind].required.includes("student_text")) return true;
  return studentText(event) !== "";
}

// ── Gates ─────────────────────────────────────────────────────────────────────

export interface GateMiss {
  /** Named reason. The UI shows a sentence for it; it never shows a number. */
  code: string;
  /** The `learning.completion[]` item that is missing, when the miss came from one. */
  item?: string;
  event?: LearningEventKind;
  /** The criterion or artifact revision the miss is about. */
  ref?: string;
}

export interface GatesInput {
  events: readonly ObservationEvent[];
  /** Restrict to one task's events. Omitted means the caller already filtered. */
  task?: string;
  /** `learning.completion[]` from the session design file. */
  completion?: readonly { id: string; event: LearningEventKind }[];
}

export interface GatesResult {
  /** SX-14. `ok=false` disables the 완료 CTA and `missing` is what the screen lists. */
  complete: { ok: boolean; missing: GateMiss[] };
  /** SX-15. */
  verification: { state: "none" | "unconfirmed" | "confirmed"; source_state: SourceState; missing: GateMiss[] };
}

/**
 * The two gates, computed from the events every time (design: never stored).
 *
 * Nothing here writes; `events` is only read.
 */
export function gates(input: GatesInput): GatesResult {
  const events = [...input.events]
    .filter((e) => input.task === undefined || e.task === input.task)
    .sort((a, b) => a.seq - b.seq);
  return { complete: completionGate(events, input.completion ?? []), verification: verificationGate(events) };
}

function completionGate(events: ObservationEvent[], completion: readonly { id: string; event: LearningEventKind }[]): GatesResult["complete"] {
  const missing: GateMiss[] = [];
  // 1. every declared completion item exists as the student's own event.
  for (const item of completion) {
    if (!events.some((e) => satisfiesGate(e, item.event))) {
      missing.push({ code: "missing_completion_event", item: item.id, event: item.event });
    }
  }
  // 2. an AI draft exists ⇒ the student's criterion came before that draft, or at
  //    least before the first check. No check yet means the criterion still
  //    precedes every check there is, so the gate opens — that is the whole point
  //    of SX-14: write the expectation, then look.
  const firstArtifact = events.find((e) => e.kind === "artifact");
  if (firstArtifact) {
    const firstTest = events.find((e) => e.kind === "test_observed");
    const ok = events.some(
      (e) => satisfiesGate(e, "criterion_set") && (e.seq < firstArtifact.seq || firstTest === undefined || e.seq < firstTest.seq),
    );
    if (!ok) missing.push({ code: "criterion_after_artifact", event: "criterion_set" });
  }
  return { ok: missing.length === 0, missing };
}

/**
 * SX-15 — after a change, the same expectation has to be checked again.
 *
 * The LAST `change_requested` is the one that has to be answered: an older change
 * that was re-confirmed does not cover a newer one.
 */
function verificationGate(events: ObservationEvent[]): GatesResult["verification"] {
  const changes = events.filter((e) => e.kind === "change_requested");
  const change = changes.at(-1);
  if (!change) return { state: "none", source_state: "unverified", missing: [] };

  const unconfirmed = (miss: GateMiss): GatesResult["verification"] => ({ state: "unconfirmed", source_state: "unverified", missing: [miss] });
  const criterion = typeof change.criterion_ref === "string" ? change.criterion_ref : undefined;
  const after = events.filter((e) => e.kind === "artifact" && e.seq > change.seq);
  const latest = after.at(-1)?.sha256;

  const retests = events.filter((e) => e.kind === "retest_confirmed" && e.seq > change.seq);
  if (!retests.length) return unconfirmed({ code: "missing_retest", ...(criterion ? { ref: criterion } : {}) });
  // 1. same criterion id. A retest against a different expectation is not this one.
  const sameCriterion = retests.filter((e) => criterion !== undefined && e.criterion_ref === criterion);
  if (!sameCriterion.length) return unconfirmed({ code: "criterion_mismatch", ...(criterion ? { ref: criterion } : {}) });
  // 2. bound to the artifact that exists after the change, not the one before it.
  const bound = sameCriterion.filter((e) => latest !== undefined && e.artifact_after === latest);
  if (!bound.length) return unconfirmed({ code: "stale_artifact", ...(latest ? { ref: latest } : {}) });
  // 3. real only when an executed result is bound to that revision; otherwise the
  //    student says so and it stays self_reported.
  const real = bound.some((e) => hasBoundResult(events, e));
  return { state: "confirmed", source_state: real ? "real" : "self_reported", missing: [] };
}

/**
 * The `resolveVerification()` rule (interpretation.ts, MC-14) applied to the single
 * `result_ref` a retest carries.
 *
 * It is not a call to that function: `resolveVerification` takes a request, a
 * result and the method quoted from the request, which a retest event does not
 * have, and importing it here would make the core cyclic. The rule it enforces is
 * the same one and just as strict — request AND result both name the revision, the
 * result is an executed success, and it belongs to the same tool call.
 */
function hasBoundResult(events: readonly ObservationEvent[], retest: ObservationEvent): boolean {
  const ref = retest.result_ref;
  if (typeof ref !== "string") return false;
  const result = events.find((e) => e.id === ref);
  if (!result || result.kind !== "tool_result" || result.outcome !== "success") return false;
  if (result.sha256 !== retest.artifact_after) return false;
  return events.some(
    (e) => e.kind === "tool_request" && e.tool_id === result.tool_id && e.task === result.task && e.seq < result.seq && e.sha256 === retest.artifact_after,
  );
}

// ── The step move (SX-16, SX-55) ──────────────────────────────────────────────

export interface StepGate {
  id: string;
  /** If present, this event must exist as the student's own before the step can be left. */
  gate?: LearningEventKind;
}

export type NextStepResult = { ok: true; step: string } | { ok: false; code: string; gate?: LearningEventKind };

/**
 * "다음으로" and "이전으로".
 *
 * Going back is always allowed (SX-16) — a student revisiting an earlier step is
 * not a failure state. Going forward is refused by name when the step being left
 * declares a gate the student has not met; the UI shows that name, never a bypass.
 */
export function nextStep(input: {
  steps: readonly StepGate[];
  current: string;
  events: readonly ObservationEvent[];
  direction?: "next" | "back";
}): NextStepResult {
  const index = input.steps.findIndex((s) => s.id === input.current);
  const here = input.steps[index];
  if (index < 0 || !here) return { ok: false, code: "unknown_step" };
  if (input.direction === "back") {
    const previous = input.steps[index - 1];
    return previous ? { ok: true, step: previous.id } : { ok: false, code: "at_first_step" };
  }
  const following = input.steps[index + 1];
  if (!following) return { ok: false, code: "at_last_step" };
  const gate = here.gate;
  if (gate && !input.events.some((e) => satisfiesGate(e, gate))) return { ok: false, code: "gate_not_met", gate };
  return { ok: true, step: following.id };
}
