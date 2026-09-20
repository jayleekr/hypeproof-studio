// SX-55~59 — the `learning` block of the session design file and the per-step
// learning fields (ui·evidence·gate).
//
// Siblings: lesson-feature-policy.ts(#748) · lesson-model-policy.ts(#795) ·
// lesson-help-mode.ts(#1008) · lesson-pedagogy.ts(#1115). Same place, same shape:
// pure functions returning `string | null`. One thing splits this file from those
// three, and it sets this file's character:
//
//   lesson-feature-policy / lesson-model-policy  handle **authority** — narrowing only
//   lesson-help-mode                             handles **teaching strategy** — authority unchanged
//   this file                                    handles **learning design data** —
//                                                neither authority nor strategy, but the
//                                                instructor's declaration of what gets built
//                                                and what gets observed
//
// It is only data, but not just any data. Two things are blocked at the validator level:
//
//   SX-57  do not distort the task for the sake of observation. A step that declares
//          evidence·gate must have an acceptance that names an artifact — a step whose
//          only purpose is observation cannot be authored (validateStepLearning).
//   SX-59  the learning block does not carry scores. A key whose name looks like a
//          score is rejected, and so is any numeric value other than `week`
//          (forbidScores).
//
// The 6-week curriculum is **six data files** of this schema, not code constants (SX-56).
// Putting a week string or a mission sentence into this file breaks that requirement.
//
// The schema id does not go up, because not one required key changes —
// `learning` is an optional key, and without it the behavior is exactly today's.
// Design: docs/design/studio-learning-experience.md "세션 설계 파일 (Module)".

/** The 8 learning event kinds (SX-47). `hps-observation/2` uses the same list. */
export const LEARNING_EVENT_KINDS = [
  'problem_committed',
  'criterion_set',
  'test_observed',
  'change_requested',
  'retest_confirmed',
  'external_feedback_received',
  'decision_revised',
  'reflection_submitted',
] as const;
export type LearningEventKind = (typeof LEARNING_EVENT_KINDS)[number];

/** The 6 evidence types (SX-18). Not a judgment about a person — the kind of thing left behind. */
export const EVIDENCE_TYPES = ['intent', 'criterion', 'action', 'decision', 'change', 'ownership'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** The 6 source kinds (SX-22). */
export const SOURCE_KINDS = ['link', 'article', 'policy', 'interview', 'test', 'none'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** The 7 work surfaces a step can open. `metric_board` is only used in the numbers week (SX-51). */
export const STEP_UI_KINDS = [
  'canvas_editor',
  'canvas_preview',
  'criterion_form',
  'evidence_note',
  'coach_request',
  'decision_form',
  'metric_board',
] as const;
export type StepUiKind = (typeof STEP_UI_KINDS)[number];

export interface LearningCompletionItem {
  id: string;
  text: string;
  event: LearningEventKind;
}

export interface LearningBlock {
  week: number;
  mission: string;
  completion?: LearningCompletionItem[];
  /** Not visible to the student. Input for the interpretation prompt and the instructor screen. */
  observe?: string[];
  /** Things never to do (SX-58). Carried into the coach prompt verbatim. */
  never?: string[];
  evidence_types?: EvidenceType[];
  source_kinds?: SourceKind[];
  reflection?: { changed_mind: boolean; next_experiment: boolean };
}

/** Learning fields laid on top of a step. All three are optional; without them a step is today's step. */
export interface StepLearningFields {
  ui?: StepUiKind;
  evidence?: EvidenceType;
  gate?: LearningEventKind;
}

export const LEARNING_KEYS = [
  'week', 'mission', 'completion', 'observe', 'never', 'evidence_types', 'source_kinds', 'reflection',
] as const;
/**
 * Only `week` and `mission` are required. A learning block without those two
 * leaves screen A nothing to read, so writing the block was pointless. The rest
 * are optional because each week uses different fields (week 3 uses all eight
 * fields, week 6 has only two completion items).
 */
export const LEARNING_REQUIRED_KEYS = ['week', 'mission'] as const;

export const MISSION_MAX = 200;
export const COMPLETION_TEXT_MAX = 200;
export const LEARNING_LINE_MAX = 400;
export const COMPLETION_MAX_ITEMS = 10;
export const OBSERVE_MAX_ITEMS = 20;
export const WEEK_MAX = 52;

const COMPLETION_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const line = (x: unknown, max: number): x is string =>
  typeof x === 'string' && !!x.trim() && x.length <= max && !x.includes('\0');
const allowKeys = (x: Record<string, unknown>, required: readonly string[], allowed: readonly string[]) =>
  Object.keys(x).every(k => allowed.includes(k)) && required.every(k => k in x);
const listOf = <T>(x: unknown, values: readonly T[], max: number): x is T[] =>
  Array.isArray(x) && x.length >= 1 && x.length <= max
  && x.every(v => values.includes(v as T)) && new Set(x).size === x.length;

/** SX-59's refusal message. Pinned as one line so it can be grepped. */
export const SCORE_REFUSAL = 'learning must not carry a score';

// Keys whose names look like scores. Same list as SCORE_KEYS in interpretation.ts.
const SCORE_KEYS = ['score', 'scores', 'level', 'points', 'rank', 'percentile', 'grade'];

/**
 * SX-59 / C4 — keeps scores and grades out of every corner of the learning block.
 *
 * Same shape as `forbidKeys()` in `measurement-core/interpretation.ts`: walks
 * arrays and objects recursively, and emits the **named refusal** ahead of the
 * generic "unknown field". Three differences:
 *
 *   1. It returns `string | null` instead of throwing — the house rule of session-design.ts.
 *   2. It looks at the **shape of the value**, not just the key name. The only
 *      legitimate number in a learning block is `week`, so any other number is
 *      rejected whatever it is called (`mastery`, `count`, `stars`). A list of
 *      names alone cannot block the name someone invents next.
 *   3. It does not look at `CONVERSION_KEYS` (legacy conversion). The legacy score
 *      conversion path does not reach the session design file — that one is the
 *      observation batch's problem.
 */
function forbidScores(value: unknown, atLearningRoot = false): string | null {
  if (Array.isArray(value)) {
    for (const v of value) { const bad = forbidScores(v); if (bad) return bad; }
    return null;
  }
  if (!isObject(value)) return null;
  for (const [k, v] of Object.entries(value)) {
    if (SCORE_KEYS.includes(k)) return SCORE_REFUSAL;
    if (typeof v === 'number' && !(atLearningRoot && k === 'week')) return SCORE_REFUSAL;
    const bad = forbidScores(v);
    if (bad) return bad;
  }
  return null;
}

/**
 * Validation of the optional key `learning`. Not called when it is absent; when
 * it is present, everything about it is checked here.
 *
 * The order is part of the contract: the score refusal comes **first**.
 * `completion[0].level = 3` is a shape violation too, but reported as "unknown
 * field" the instructor cannot tell what the problem is. interpretation.ts puts
 * forbidKeys at the very front for the same reason.
 */
export function validateLearningBlock(value: unknown): string | null {
  if (!isObject(value)) return 'invalid learning fields';
  const score = forbidScores(value, true);
  if (score) return score;
  if (!allowKeys(value, LEARNING_REQUIRED_KEYS, LEARNING_KEYS)) return 'invalid learning fields';

  if (!Number.isInteger(value.week) || (value.week as number) < 1 || (value.week as number) > WEEK_MAX) return 'invalid learning.week';
  if (!line(value.mission, MISSION_MAX)) return 'invalid learning.mission';

  if ('completion' in value) {
    const items = value.completion;
    if (!Array.isArray(items) || !items.length || items.length > COMPLETION_MAX_ITEMS) return 'invalid learning.completion';
    const ids = new Set<string>();
    for (const item of items) {
      if (!isObject(item) || !allowKeys(item, ['id', 'text', 'event'], ['id', 'text', 'event'])) return 'invalid learning.completion';
      if (typeof item.id !== 'string' || !COMPLETION_ID.test(item.id) || ids.has(item.id)) return 'invalid learning.completion';
      ids.add(item.id);
      if (!line(item.text, COMPLETION_TEXT_MAX)) return 'invalid learning.completion';
      if (!(LEARNING_EVENT_KINDS as readonly string[]).includes(item.event as string)) return 'invalid learning.completion';
    }
  }

  for (const k of ['observe', 'never'] as const) {
    if (!(k in value)) continue;
    const list = value[k];
    if (!Array.isArray(list) || !list.length || list.length > OBSERVE_MAX_ITEMS
      || !list.every(s => line(s, LEARNING_LINE_MAX))) return `invalid learning.${k}`;
  }

  if ('evidence_types' in value && !listOf(value.evidence_types, EVIDENCE_TYPES, EVIDENCE_TYPES.length)) return 'invalid learning.evidence_types';
  if ('source_kinds' in value && !listOf(value.source_kinds, SOURCE_KINDS, SOURCE_KINDS.length)) return 'invalid learning.source_kinds';

  if ('reflection' in value) {
    const r = value.reflection;
    if (!isObject(r) || !allowKeys(r, ['changed_mind', 'next_experiment'], ['changed_mind', 'next_experiment'])
      || typeof r.changed_mind !== 'boolean' || typeof r.next_experiment !== 'boolean') return 'invalid learning.reflection';
  }
  return null;
}

/**
 * Validation of a step's `ui` · `evidence` · `gate`, plus SX-57.
 *
 * **SX-57 (do not plant a trap for the sake of observation)** — a step that
 * declares `evidence` or `gate` cannot have an empty acceptance. A step with only
 * observation items and no artifact is a trap built to elicit "behavior that is
 * good to observe", and the requirement names it as something the validator must
 * block (SX-57 negative: "a step with observation items but no acceptance fails").
 *
 * This is blocked in a draft (complete=false) too. A step carrying evidence·gate is
 * not "a step that is not written out yet" but **a step that has already declared
 * what will be observed**. An empty acceptance on a step that declares nothing
 * still passes in a draft, exactly as today — this rule only reaches steps
 * carrying evidence·gate, so it does not touch a single existing lesson draft.
 *
 * The returned string is a suffix. The caller (session-design.ts) prepends `step <id>: `.
 */
export function validateStepLearning(step: Record<string, unknown>): string | null {
  if ('ui' in step && !(STEP_UI_KINDS as readonly string[]).includes(step.ui as string)) {
    return 'ui must be one of the allowed step interfaces';
  }
  if ('evidence' in step && !(EVIDENCE_TYPES as readonly string[]).includes(step.evidence as string)) {
    return 'evidence must be one of the six evidence types';
  }
  if ('gate' in step && !(LEARNING_EVENT_KINDS as readonly string[]).includes(step.gate as string)) {
    return 'gate must be one of the learning event kinds';
  }
  const observed = 'evidence' in step || 'gate' in step;
  if (observed && (typeof step.acceptance !== 'string' || !step.acceptance.trim())) {
    return 'a step that declares evidence or gate must name an acceptance';
  }
  return null;
}

// ─── `steps[].evidence` is **not the same thing** as lesson-pedagogy.ts's artifact check ──
//
// The word is the same, so it is tempting to wire them together — do not. It was
// actually wired together once during implementation on 2026-09-20 and reverted.
//
//   `evidence` here        SX-18's 6-value enum of evidence **types**. It is the
//                          default for the drawer-D form.
//   lesson-pedagogy's      curriculum wiki `rules/curriculum-schema.md` Lint 2 —
//                          `evidence: ""  # 이 활동이 남기는 증거물 1개`,
//                          i.e. **the name of the thing left behind** (free text).
//                          Gate 2-1 nails it down: it must be a thing a third party
//                          can look at, and reflections or impressions are not evidence.
//
// Choosing `evidence: "ownership"` does not mean that step leaves behind something a
// third party can look at. So switching off the `step_evidence` warning because this
// field is present would be disabling a live check with an unrelated field.
// `lesson-pedagogy.ts` was left untouched and its prose regex (`제출 증거:`) remains
// the only judgment.
//
// This conflict is filed under "요구 개정 제안" in `.claude/hypeproof/ux/STATE.md`:
// rename the SX-side key to `evidence_type` and open a separate field for the thing
// left behind. Until that decision, no function in this file reaches into lesson-pedagogy.
