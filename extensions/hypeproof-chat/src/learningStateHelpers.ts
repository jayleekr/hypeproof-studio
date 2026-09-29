/**
 * The pure functions the host uses to compute learning state (P1-B, SX-14·15·17·45).
 *
 * Why this does not import `vscode`: per this repo's convention the verdict logic lives in
 * `xxxHelpers.ts` and only the orchestration stays in `chatPanelProvider.ts`. That is what
 * lets the gate be measured without Electron, under `node --experimental-strip-types`.
 *
 * Boundaries (design §정보 구조 "호스트·웹뷰·워커의 경계"):
 *   - **The host holds the truth.** The gate is computed here and sent down as `learningState`.
 *   - **The webview does not recompute it.** A disabled CTA just draws `complete.ok` as it came.
 *   - The gate result is **never stored.** It is computed from the events every time.
 */
import {
  gates,
  isLearningEventKind,
  LEARNING_EVENT_SPEC,
  type GateMiss,
  type GatesResult,
  type EvidenceType,
  type LearningEventKind,
  type ObservationActor,
  type PreviousVerification,
  type SourceKind,
  type SourceState,
} from "../../../worker/src/lib/measurement-core/learning-events.ts";
import type { ObservationEvent } from "../../../worker/src/lib/measurement-core/legacy-observation.ts";

/** One row of the session design's `learning.completion[]`. `label` goes to the screen verbatim. */
export interface CompletionItem {
  id: string;
  event: LearningEventKind;
  label?: string;
}

export interface EvidenceRow {
  id: string;
  kind: string;
  /** `null` when absent. We do **not guess** one of the six (SX-18 negative condition). */
  evidence_type: EvidenceType | null;
  at: number;
  /** The student's own wording, verbatim. The event body when there is none (SX-44). */
  text: string;
  actor: ObservationActor;
  source_kind: SourceKind;
  source_state: SourceState;
  provenance: { who: string; when: string; where: string } | null;
  /** When a coach suggestion was adopted, that coach event's id (design §관측 이벤트와 필드 규칙 4). */
  adopted_from: string | null;
  /** SX-16 — the fields the before/after view uses. Only `artifact` events carry a `sha256`. */
  sha256: string | null;
  artifact_before: string | null;
  artifact_after: string | null;
  criterion_ref: string | null;
}

export interface LearningStatePayload {
  task: string;
  phase: "assigned" | "working" | "submitted" | "reflected";
  currentStep: string | null;
  /** SX-14. When `ok=false` the completion CTA is disabled and `reasons` shows up next to the button. */
  complete: { ok: boolean; reasons: string[]; missing: GateMiss[] };
  /** Whether the session design **declared** a completion condition for this task. The absence of a declaration is shown on screen too. */
  declared: boolean;
  verification: {
    state: GatesResult["verification"]["state"];
    source_state: SourceState;
    line: string;
    /** AE-37 — even when a recheck becomes necessary, **the earlier confirmation stays.** Erase it and it becomes something that never happened. */
    previous?: PreviousVerification;
  };
  evidence: EvidenceRow[];
}

/** The kinds the drawer shows. `artifact` comes along because the before/after comparison needs it. */
const DRAWER_KINDS = new Set<string>([...Object.keys(LEARNING_EVENT_SPEC), "artifact"]);

/**
 * One sentence for why it is blocked.
 *
 * No numbers. Phrasing like "1 of 2" reads as a progress rate, and a progress rate is another
 * name for a score (SX-59). An unknown code does not get an empty line back either — if the
 * space next to the button is blank, the student has no way to know why it is blocked.
 */
export function gateSentence(miss: GateMiss, completion: readonly CompletionItem[] = []): string {
  const item = completion.find((c) => c.id === miss.item);
  const label = item?.label ?? (miss.event ? KIND_LABELS[miss.event] : undefined);
  switch (miss.code) {
    case "missing_completion_event":
      return label ? `아직 안 한 것: ${label}` : "아직 남은 것이 있어요";
    case "criterion_after_artifact":
      return "기대 조건을 먼저 적어 주세요";
    default:
      return "아직 남은 것이 있어요";
  }
}

/**
 * The kind names used when a completion item has no label, and when an evidence row
 * has no words of the student's own. Screen copy, so no numbers.
 *
 * Exported because the Evidence drawer needs the same table. `test_observed` and
 * `retest_confirmed` do not require `student_text` by spec (learning-events.ts), so
 * a perfectly valid row of either kind has nothing to print — a second copy of
 * these strings in the webview is how the two would drift apart.
 */
export const KIND_LABELS: Record<LearningEventKind, string> = {
  problem_committed: "무엇을 할지 정하기",
  criterion_set: "기대 조건 적기",
  test_observed: "직접 확인하기",
  change_requested: "고쳐 달라고 말하기",
  retest_confirmed: "같은 조건으로 다시 확인하기",
  external_feedback_received: "다른 사람 반응 적기",
  decision_revised: "고른 이유 적기",
  reflection_submitted: "바뀐 생각 적기",
};

const VERIFICATION_LINES: Record<GatesResult["verification"]["state"], string> = {
  none: "아직 고쳐 달라고 한 것이 없어요",
  unconfirmed: "아직 같은 조건으로 다시 확인하지 않음",
  confirmed: "같은 조건으로 다시 확인했어요",
  // AE-37 — the confirmation did happen. It is only that the criterion or the artifact moved
  // afterwards, so it no longer covers the current screen. It has to be a different sentence
  // from "you have not confirmed yet" for the student to tell the two apart.
  needs_recheck: "확인한 뒤에 달라진 것이 있어요. 다시 한 번 봐 주세요",
};

function rowOf(event: ObservationEvent): EvidenceRow {
  const text = typeof event.student_text === "string" && event.student_text.length > 0 ? event.student_text : event.text;
  const type = event.evidence_type;
  return {
    id: event.id,
    kind: event.kind,
    evidence_type: (type as EvidenceType | undefined) ?? null,
    at: event.at,
    text,
    actor: (event.actor as ObservationActor | undefined) ?? "user",
    source_kind: (event.source_kind as SourceKind | undefined) ?? "none",
    source_state: (event.source_state as SourceState | undefined) ?? "unverified",
    provenance: event.provenance ?? null,
    adopted_from: typeof event.adopted_from === "string" ? event.adopted_from : null,
    sha256: typeof event.sha256 === "string" ? event.sha256 : null,
    artifact_before: typeof event.artifact_before === "string" ? event.artifact_before : null,
    artifact_after: typeof event.artifact_after === "string" ? event.artifact_after : null,
    criterion_ref: typeof event.criterion_ref === "string" ? event.criterion_ref : null,
  };
}

/**
 * One Task's learning state. Read-only.
 *
 * An empty `completion` means the session design declared no completion condition for this task,
 * and that fact goes out alongside as `declared: false` (SX-14 exception clause, "that declaration
 * is visible on screen").
 */
export function learningState(input: {
  task: string;
  events: readonly ObservationEvent[];
  completion?: readonly CompletionItem[];
  phase?: LearningStatePayload["phase"];
  currentStep?: string | null;
}): LearningStatePayload {
  const completion = input.completion ?? [];
  const mine = input.events.filter((e) => e.task === input.task);
  const verdict = gates({ events: mine, task: input.task, completion });
  return {
    task: input.task,
    phase: input.phase ?? "working",
    currentStep: input.currentStep ?? null,
    complete: {
      ok: verdict.complete.ok,
      reasons: verdict.complete.missing.map((m) => gateSentence(m, completion)),
      missing: verdict.complete.missing,
    },
    declared: completion.length > 0,
    verification: {
      state: verdict.verification.state,
      source_state: verdict.verification.source_state,
      line: VERIFICATION_LINES[verdict.verification.state],
      ...(verdict.verification.previous ? { previous: verdict.verification.previous } : {}),
    },
    evidence: mine
      .filter((e) => DRAWER_KINDS.has(e.kind))
      .sort((a, b) => a.seq - b.seq)
      .map(rowOf),
  };
}

/**
 * SX-14 negative condition — the host judges the completion submit **again**.
 *
 * The webview's `disabled` is a picture, not a lock. Delete one attribute in devtools or throw
 * a `postMessage` directly and it just presses. So the same gate runs once more here over the
 * same events. Both places call the **same function** (`learningState`), so the rule never
 * splits into two copies.
 */
export function acceptSubmit(input: {
  task: string;
  events: readonly ObservationEvent[];
  completion?: readonly CompletionItem[];
}): { ok: true } | { ok: false; reasons: string[]; missing: GateMiss[] } {
  const state = learningState(input);
  if (state.complete.ok) return { ok: true };
  return { ok: false, reasons: state.complete.reasons, missing: state.complete.missing };
}

export type LearningEventDraft = {
  kind: LearningEventKind;
  actor: ObservationActor;
  context: { week: number; step_id: string; task: string; module_version: string };
  evidence_type?: EvidenceType;
  source_state?: SourceState;
  student_text?: string;
} & Record<string, unknown>;

export type LearningEventRequestResult =
  | { ok: true; event: LearningEventDraft }
  | { ok: false; code: string };

/** The fields the webview is allowed to send. The host fills or discards the rest. */
const WEBVIEW_FIELDS = [
  "student_text",
  "source_kind",
  "source_state",
  "provenance",
  "criterion_ref",
  "turn_ref",
  "result_ref",
  "evidence_refs",
  "artifact_before",
  "artifact_after",
  "outcome",
  "decision",
  "next_experiment",
  "adopted_from",
] as const;

/**
 * Turns one webview form submit into a learning-event draft (SX-45 rule 2).
 *
 * Three things the **webview does not get to decide**:
 *   - `actor` — the host decides it from the kind table. Whatever the webview sent is discarded.
 *   - `context` — the host fills it from Task.curriculum.
 *   - the call path — nothing is made unless `sender: "webview-form"`.
 *     If a coach stream callback can make a learning event, all of SX-45 is pointless.
 */
export function learningEventRequest(
  request: unknown,
  ctx: {
    week: number;
    step_id: string;
    task: string;
    module_version: string;
    sender: string;
    /**
     * The `evidence` value of the session design step. Used only for kinds whose evidence_type
     * the kind table does not set, like `external_feedback_received` (design table: "follows the
     * step's `evidence`"). The webview does not send it — the student does not pick the kind of
     * evidence, the step decides it.
     */
    stepEvidenceType?: EvidenceType;
  },
): LearningEventRequestResult {
  if (ctx.sender !== "webview-form") return { ok: false, code: "sender_not_form" };
  if (typeof request !== "object" || request === null) return { ok: false, code: "not_learning_kind" };
  const body = request as Record<string, unknown>;
  const kind = body.kind;
  if (!isLearningEventKind(kind)) return { ok: false, code: "not_learning_kind" };

  const spec = LEARNING_EVENT_SPEC[kind];
  const draft: LearningEventDraft = {
    kind,
    actor: spec.actor,
    context: { week: ctx.week, step_id: ctx.step_id, task: ctx.task, module_version: ctx.module_version },
  };
  // The `/2` validator requires evidence_type on every learning kind. What the kind table does
  // not set, the step sets; when neither has it, we **reject**. We do not pick one of the six
  // (SX-18 negative condition: "do not guess one of the six for an event with no evidence_type").
  const evidenceType = spec.evidence_type ?? ctx.stepEvidenceType;
  if (!evidenceType) return { ok: false, code: "missing_evidence_type" };
  draft.evidence_type = evidenceType;
  if (spec.source_state) draft.source_state = spec.source_state;

  for (const field of WEBVIEW_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (field === "student_text") {
      const text = String(value).trim();
      // Sending only whitespace is not "wrote it". We do not fill it in on their behalf.
      if (text.length === 0) return { ok: false, code: "missing_student_text" };
      draft.student_text = text.slice(0, 2000);
      continue;
    }
    // Narrow literal-type fields like `source_state` are mixed in here. Whether a value is
    // **legitimate** is rejected by name in the `/2` validator (`invalid_source_state`), so we
    // do not run a second copy of that check here — a rule kept in two places splits.
    (draft as Record<string, unknown>)[field] = value;
  }

  // Look at **every** required field in the kind table. Why this widened from checking only
  // `student_text`: the `/2` validator requires `decision{from,to}` and a non-empty
  // `evidence_refs[]` on `decision_revised`. Let it through here and it saves, and then **on the
  // next read** the whole batch is rejected — one missing field and every record in that spot is
  // gone. If we are going to block it, block it where it is made.
  for (const field of spec.required) {
    if (field === "context") continue; // the host just filled it in
    if (draft[field] === undefined) {
      return { ok: false, code: field === "student_text" ? "missing_student_text" : `missing_${field}` };
    }
  }
  if (Array.isArray(draft.evidence_refs) && draft.evidence_refs.length === 0) {
    return { ok: false, code: "missing_evidence_refs" };
  }
  // SX-46 negative condition — `real` is not a word the host gets to use on its own. There has
  // to be a provenance, or an executed result tied to it. The validator rejects on the same rule
  // (`missing_provenance`), but letting it save and blow up on the next read makes everything
  // the student wrote disappear. Block it where it is made, by name.
  if (draft.source_state === "real" && !hasProvenance(draft) && draft.result_ref === undefined) {
    return { ok: false, code: "missing_provenance" };
  }
  return { ok: true, event: draft };
}

/** Are all three fields actually written in? `"미기록"` does not count as written (SX-20). */
function hasProvenance(draft: Record<string, unknown>): boolean {
  const p = draft.provenance;
  if (typeof p !== "object" || p === null) return false;
  const fields = p as Record<string, unknown>;
  return ["who", "when", "where"].some((k) => {
    const v = fields[k];
    return typeof v === "string" && v.trim().length > 0 && v.trim() !== "미기록";
  });
}
