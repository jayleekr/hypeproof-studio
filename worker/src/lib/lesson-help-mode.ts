// #1008 (AE-10, AE-36, EDU-02) — a frozen lesson step offers help modes; the
// student picks one for the NEXT run, and the Service carries it to the model.
// Design contract: docs/design/learning-agent-experience.md "도움을 조절하는 계약".
//
// Three values the design keeps apart, and this file must not merge:
//
//   help strategy      what the lesson step offers and the student selected (here)
//   execution grant    lesson-feature-policy.ts — a help mode NEVER touches it
//   observed performance  not produced here. Choosing `independent` is not
//                      evidence of independent work, so the receipt says
//                      `performance=unobserved` for every mode.
//
// A step ID in a request is a teaching pointer, not authority: step transition
// is not Service-verifiable (ADR-0007 AE-09). That is acceptable only because
// nothing here widens anything — an unknown step or a mode outside the step's
// allowed set is refused with a reason, never silently unlocked.

export const HELP_MODES = ['demonstrate', 'hint', 'co_edit', 'independent'] as const;
export type HelpMode = (typeof HELP_MODES)[number];

/** 학생·강사에게 보이는 이름. 키가 날것으로 화면에 뜨지 않게 여기서 강제한다. */
export const HELP_MODE_LABELS: Record<HelpMode, string> = {
  demonstrate: '시연 보기',
  hint: '힌트 받기',
  co_edit: '함께 수정',
  independent: '직접 해보기',
};

export interface StepHelpPolicy {
  /** Applied when the student has not chosen. Must be one of `allowed`. */
  default: HelpMode;
  allowed: HelpMode[];
}

export interface ResolvedHelp {
  step_id: string;
  mode: HelpMode;
  source: 'lesson_default' | 'student';
}

export type HelpResolution =
  | { ok: true; help: ResolvedHelp | null }
  | { ok: false; status: 400 | 409; code: string; message: string };

const STEP_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isMode = (x: unknown): x is HelpMode => typeof x === 'string' && (HELP_MODES as readonly string[]).includes(x);

export function validateStepHelp(value: unknown): string | null {
  if (!object(value) || Object.keys(value).length !== 2 || !('default' in value) || !('allowed' in value)) return 'invalid step help fields';
  if (!Array.isArray(value.allowed) || !value.allowed.length || !value.allowed.every(isMode)
    || new Set(value.allowed).size !== value.allowed.length) return 'invalid help mode selection';
  if (!isMode(value.default) || !value.allowed.includes(value.default)) return 'help default must be one of the allowed modes';
  return null;
}

/**
 * Resolve the help for one request from the frozen steps and two request
 * headers. Absent headers keep today's behavior (no help instruction), so an
 * app that does not know help modes is unchanged.
 */
export function resolveHelpMode(
  steps: ReadonlyArray<{ id: string; help?: StepHelpPolicy }>,
  stepHeader: string | undefined,
  modeHeader: string | undefined,
): HelpResolution {
  const stepId = stepHeader?.trim() || undefined;
  const requested = modeHeader?.trim() || undefined;
  if (!stepId) {
    return requested
      ? { ok: false, status: 400, code: 'help_mode_step_required', message: '도움 방식을 적용할 수업 단계를 알 수 없습니다.' }
      : { ok: true, help: null };
  }
  const step = STEP_ID.test(stepId) ? steps.find(s => s.id === stepId) : undefined;
  if (!step) return { ok: false, status: 409, code: 'lesson_step_unknown', message: '이 수업에 없는 단계입니다. 수업을 다시 열어 주세요.' };
  if (requested !== undefined && !isMode(requested)) return { ok: false, status: 400, code: 'invalid_help_mode', message: '알 수 없는 도움 방식입니다.' };
  if (!step.help) {
    return requested
      ? { ok: false, status: 409, code: 'help_mode_not_offered', message: '이 단계는 도움 방식을 선택할 수 없습니다. 필요하면 강사에게 요청하세요.' }
      : { ok: true, help: null };
  }
  if (requested && !step.help.allowed.includes(requested)) {
    const offered = step.help.allowed.map(m => HELP_MODE_LABELS[m]).join(', ');
    return { ok: false, status: 409, code: 'help_mode_not_allowed', message: `이 단계에서는 '${HELP_MODE_LABELS[requested]}'을(를) 쓸 수 없습니다. 가능한 방식: ${offered}. 더 필요한 도움은 강사에게 요청하세요.` };
  }
  return { ok: true, help: requested
    ? { step_id: step.id, mode: requested, source: 'student' }
    : { step_id: step.id, mode: step.help.default, source: 'lesson_default' } };
}

const MODE_INSTRUCTIONS: Record<HelpMode, string> = {
  demonstrate: '학생의 과제 파일이 아닌 별도 예제로 과정을 보여주고, 각 선택과 검수 이유를 설명하세요. 무엇을 자기 과제에 적용할지는 학생이 고르게 하세요.',
  hint: '다음 한 단계나 확인할 위치만 제시하세요. 완성된 수정안을 대신 쓰거나 실행하지 말고, 실제 수정과 실행 여부는 학생이 정하게 하세요.',
  co_edit: '허용된 범위 안에서 초안을 만들고 수정·검사하되, 범위·대안·채택 여부는 학생에게 확인하세요.',
  independent: '정답이나 완성된 수정을 먼저 제시하지 마세요. 학생이 요청한 검수나 질문에만 답하고, 목표부터 수정·검수·복구까지 학생이 결정하게 하세요.',
};

/** Model-facing instruction. Teaching strategy only — it states that it changes no grant. */
export function helpModeInstruction(help: ResolvedHelp): string {
  const how = help.source === 'student' ? '학생이 직접 골랐습니다' : '수업 기본값입니다';
  return `\n[도움 방식] 단계 '${help.step_id}'의 도움 방식은 '${HELP_MODE_LABELS[help.mode]}'이며 ${how}. `
    + MODE_INSTRUCTIONS[help.mode]
    + ' 도움 방식은 교수 전략이며 도구 권한이나 정책을 바꾸지 않습니다. 이 선택만으로 학생이 독립적으로 수행했다고 말하거나 판정하지 마세요.'
    + ' 목표가 분명하면 되묻지 말고 진행하고, 모호하면 다음 행동을 정하는 데 필요한 질문 하나만 하세요.\n';
}

/** `x-hps-help-mode` receipt. `performance=unobserved` for every mode, by design. */
export function helpModeReceipt(help: ResolvedHelp): string {
  return `mode=${help.mode}; source=${help.source}; step=${help.step_id}; performance=unobserved`;
}
