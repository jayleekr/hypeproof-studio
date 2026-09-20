// SX-55~59 — 세션 설계 파일의 `learning` 블록과 단계별 학습 칸(ui·evidence·gate).
//
// 형제: lesson-feature-policy.ts(#748) · lesson-model-policy.ts(#795) ·
// lesson-help-mode.ts(#1008) · lesson-pedagogy.ts(#1115). 같은 자리, 같은 모양의
// 순수 함수이고 `string | null` 을 돌려준다. 저 셋과 갈리는 점 하나가 이 파일의
// 성격이다:
//
//   lesson-feature-policy / lesson-model-policy  **권한**을 다룬다 — 좁히기만 가능
//   lesson-help-mode                             **교수 전략**을 다룬다 — 권한 불변
//   이 파일                                      **학습 설계 데이터**를 다룬다 —
//                                                권한도 전략도 아니고, 무엇을 만들고
//                                                무엇이 관찰되는지에 대한 강사의 선언
//
// 데이터일 뿐이지만 아무 데이터나 되는 것은 아니다. 두 가지를 검증기 수준에서 막는다:
//
//   SX-57  관측을 위해 과제를 왜곡하지 않는다. evidence·gate 를 선언한 단계는
//          산출물을 지목하는 완료 기준을 반드시 가진다 — 관찰만 목적인 단계는
//          만들 수 없다(validateStepLearning).
//   SX-59  학습 블록은 점수를 나르지 않는다. 이름이 점수처럼 생긴 키도, `week`
//          말고 다른 숫자 값도 거부한다(forbidScores).
//
// 6주 커리큘럼은 이 스키마의 **데이터 파일 여섯 개**이지 코드 상수가 아니다(SX-56).
// 이 파일에 주차 문자열이나 미션 문장이 들어가면 그 요구를 어기는 것이다.
//
// 스키마 id 는 오르지 않는다. 필수 키가 하나도 바뀌지 않기 때문이다 —
// `learning` 은 선택 키이고, 없으면 오늘과 완전히 같은 동작이다.
// 설계: docs/design/studio-learning-experience.md "세션 설계 파일 (Module)".

/** 학습 이벤트 8종(SX-47). `hps-observation/2` 가 같은 목록을 쓴다. */
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

/** 근거 종류 6종(SX-18). 사람에 대한 판정이 아니라 남는 물건의 종류다. */
export const EVIDENCE_TYPES = ['intent', 'criterion', 'action', 'decision', 'change', 'ownership'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** 출처 종류 6종(SX-22). */
export const SOURCE_KINDS = ['link', 'article', 'policy', 'interview', 'test', 'none'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** 단계가 여는 작업 화면 7종. `metric_board` 는 숫자 주차에서만 쓴다(SX-51). */
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
  /** 학생에게 보이지 않는다. 해석 프롬프트와 강사 화면의 입력이다. */
  observe?: string[];
  /** 절대 하지 않을 것(SX-58). 코치 프롬프트에 그대로 실려 나간다. */
  never?: string[];
  evidence_types?: EvidenceType[];
  source_kinds?: SourceKind[];
  reflection?: { changed_mind: boolean; next_experiment: boolean };
}

/** 단계에 얹히는 학습 칸. 셋 다 선택이고, 없으면 오늘의 단계와 같다. */
export interface StepLearningFields {
  ui?: StepUiKind;
  evidence?: EvidenceType;
  gate?: LearningEventKind;
}

export const LEARNING_KEYS = [
  'week', 'mission', 'completion', 'observe', 'never', 'evidence_types', 'source_kinds', 'reflection',
] as const;
/**
 * `week` 와 `mission` 만 필수다. 둘이 없는 learning 블록은 화면 A 가 읽을 것이
 * 하나도 없어서 블록을 쓴 의미가 없다. 나머지는 주차마다 쓰는 칸이 달라서 선택이다
 * (3주차는 여덟 칸을 다 쓰고, 6주차는 completion 이 둘뿐이다).
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

/** SX-59 의 거부 문구. 한 줄로 grep 되게 고정한다. */
export const SCORE_REFUSAL = 'learning must not carry a score';

// 이름이 점수처럼 생긴 키. interpretation.ts 의 SCORE_KEYS 와 같은 목록이다.
const SCORE_KEYS = ['score', 'scores', 'level', 'points', 'rank', 'percentile', 'grade'];

/**
 * SX-59 / C4 — 학습 블록 어디에도 점수·등급이 들어오지 못하게 한다.
 *
 * `measurement-core/interpretation.ts` 의 `forbidKeys()` 와 같은 모양이다:
 * 배열과 객체를 재귀로 훑고, **이름이 붙은 거절**을 일반적인 "알 수 없는 필드"보다
 * 먼저 낸다. 다른 점 세 가지:
 *
 *   1. 던지지 않고 `string | null` 을 돌려준다 — session-design.ts 의 집 규칙이다.
 *   2. 키 이름뿐 아니라 **값의 모양**도 본다. 학습 블록에서 정당한 숫자는 `week`
 *      하나뿐이므로, 다른 숫자는 이름이 무엇이든(`mastery`, `count`, `stars`)
 *      거절한다. 이름 목록만으로는 다음에 누가 지을 이름을 막지 못한다.
 *   3. `CONVERSION_KEYS`(legacy 환산) 는 보지 않는다. 수업 설계 파일에는 legacy
 *      점수 환산 경로가 닿지 않는다 — 그쪽은 관측 배치의 문제다.
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
 * 선택 키 `learning` 의 검증. 없으면 호출되지 않고, 있으면 전부 여기서 본다.
 *
 * 순서가 계약의 일부다: 점수 거절이 **먼저**다. `completion[0].level = 3` 은
 * 모양 위반이기도 하지만 "알 수 없는 필드" 로 보고되면 강사가 무엇이 문제인지
 * 모른다. interpretation.ts 가 같은 이유로 forbidKeys 를 맨 앞에 둔다.
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
 * 단계의 `ui` · `evidence` · `gate` 검증 + SX-57.
 *
 * **SX-57 (관측을 위해 함정을 넣지 않는다)** — `evidence` 나 `gate` 를 선언한
 * 단계는 완료 기준이 비어 있을 수 없다. 관찰 항목만 있고 산출물이 없는 단계는
 * "관측하기 좋은 행동" 을 유도하려고 만든 함정이며, 요구가 검증기에서 막으라고
 * 명시한 대상이다(SX-57 부정: "단계에 acceptance 없이 관찰 항목만 있으면 실패").
 *
 * 초안(complete=false)에서도 막는다. evidence·gate 를 단 단계는 "아직 덜 쓴 단계"
 * 가 아니라 **무엇이 관찰될지 이미 선언한 단계**이기 때문이다. 아무것도 선언하지
 * 않은 단계의 빈 완료 기준은 오늘처럼 초안에서 그대로 통과한다 — 이 규칙은
 * evidence·gate 를 단 단계에만 닿으므로 기존 수업 초안을 한 건도 건드리지 않는다.
 *
 * 돌려주는 문자열은 접미사다. 호출자(session-design.ts)가 `step <id>: ` 를 붙인다.
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

// ─── `steps[].evidence` 는 lesson-pedagogy.ts 의 증거물 판정과 **다른 것이다** ──
//
// 같은 낱말이라 붙이고 싶어지지만 붙이면 안 된다. 실제로 2026-09-20 구현 중에
// 한 번 붙였다가 되돌렸다.
//
//   여기의 `evidence`      SX-18 의 근거 **종류** 6종 enum. D 서랍 폼의 기본값이다.
//   lesson-pedagogy 의 것  curriculum wiki `rules/curriculum-schema.md` Lint 2 —
//                          `evidence: ""  # 이 활동이 남기는 증거물 1개`,
//                          즉 **남는 물건의 이름**(자유 텍스트). 관문2-1 은
//                          "제3자가 볼 수 있는 물건이고 성찰·소감은 증거가 아니다"
//                          라고 못박는다.
//
// `evidence: "ownership"` 을 골랐다고 그 단계가 제3자가 볼 수 있는 물건을 남기는
// 것은 아니다. 그러므로 이 칸이 있다고 `step_evidence` 경고를 끄면, 무관한 필드로
// 살아 있는 검사를 무력화하는 것이 된다. `lesson-pedagogy.ts` 는 건드리지 않았고
// 산문 정규식(`제출 증거:`)이 그대로 유일한 판정이다.
//
// 이 충돌은 `.claude/hypeproof/ux/STATE.md` "요구 개정 제안" 에 올려 두었다:
// SX 쪽 키를 `evidence_type` 으로 개칭하고, 남는 물건은 별도 칸으로 여는 안.
// 그 결정 전까지 이 파일에서 lesson-pedagogy 로 가는 함수는 만들지 않는다.
