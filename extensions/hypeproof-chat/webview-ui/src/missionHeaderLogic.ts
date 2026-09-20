// Mission header 의 순수 판정 (SX-01, SX-02). JSX 없음 — `.tsx` 는
// `node --experimental-strip-types` 가 못 읽으므로, 테스트가 직접 부를 값은 여기 둔다.
// `sendQueue.ts` · `runner.ts` 와 같은 자리, 같은 이유다.

import type { ResolvedProfile } from "../../src/protocol";

type Lesson = NonNullable<ResolvedProfile["lesson"]>;
export type LessonStep = Lesson["content"]["steps"][number];

/**
 * 홈 중앙에 세우는 action 최대 개수(SX-02 "중앙 1~3개 action").
 *
 * 이것은 **창의 크기**이지 설계 파일의 상한이 아니다. 세션 설계 스키마에는 action
 * 배열이 따로 없고 단계(step) 만 있으며, 단계는 최대 30개까지 유효하다
 * (`worker/src/lib/session-design.ts`). SX-02 의 부정("action 이 4개 이상인 설계
 * 파일은 잘라서 보이지 않고 설계 파일 검증에서 거부한다")은 설계 파일이 action 을
 * 직접 선언한다고 전제하는데 실제 스키마는 그렇지 않다 —
 * `.claude/hypeproof/ux/STATE.md` "요구 개정 제안" 에 올려 두었다.
 * 그때까지는 **현재 단계부터 세 개만 보여 준다**. 뒤의 단계를 숨기는 것이 아니라
 * 지금 할 것을 앞에 두는 것이고, 남은 단계 수는 문장으로 같이 말한다.
 */
export const MAX_ACTIONS = 3;

/** 현재 단계의 위치. 모르는 id 는 첫 단계로 떨어진다 — 빈 화면을 만들지 않는다. */
export function stepIndex(steps: readonly LessonStep[], currentStepId: string | null): number {
  if (!steps.length) return -1;
  const at = steps.findIndex((s) => s.id === currentStepId);
  return at < 0 ? 0 : at;
}

/** 현재 단계부터 최대 MAX_ACTIONS 개. 남은 단계가 적으면 있는 만큼만. */
export function actionsFrom(steps: readonly LessonStep[], currentStepId: string | null): LessonStep[] {
  const at = stepIndex(steps, currentStepId);
  return at < 0 ? [] : steps.slice(at, at + MAX_ACTIONS);
}

/**
 * 현재 단계를 포함해 아직 지나지 않은 단계 수.
 *
 * **진행률이 아니라 위치다.** 무엇을 완료했는지는 학습 이벤트가 있어야 알 수 있고
 * P0 에는 그 이벤트가 없다(SX-55 는 P1-B). 완료를 세는 척하지 않는다.
 */
export function stepsRemaining(steps: readonly LessonStep[], currentStepId: string | null): number {
  const at = stepIndex(steps, currentStepId);
  return at < 0 ? 0 : steps.length - at;
}
