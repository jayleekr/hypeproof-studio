// 영역 A — Mission header (SX-01 ~ SX-05).
//
// 요구: docs/requirements/studio-learning-experience.md A. HOME
// 설계: docs/design/studio-learning-experience.md §정보 구조 (영역 A)
//
// 이 화면이 하는 일은 하나다: **지금 무엇을 해야 하는지 잃지 않게 하는 것.**
// 그래서 위에서 아래로 주차 → 미션 한 문장 → 지금 할 1~3개 action → 완료 조건 →
// 남은 단계 순이고, 변화 기록 진입은 그 **아래에, 링크 크기로** 있다(SX-03).
// 가장 큰 활자는 미션 문장이다 — 5초 회상 테스트(SX-T01)가 그것을 본다.
//
// 여기에 없는 것과 그 이유:
//   · 점수·등급·퍼센트·배지 — SX-59. `test/sx-audit.smoke.mjs` 가 렌더 결과를 감사한다.
//   · 진행률 카드 — SX-51. "남은 단계 3" 은 **문장**이지 숫자 카드가 아니다.
//   · 해석 문장 — 해석은 회고와 변화 기록에서만 한다(SX-17).
//
// 현재 단계를 웹뷰가 들고 있는 것은 **P0 한정**이다. 설계는 호스트가 진실을 갖고
// `learningState` 로 내려보내라고 한다(§정보 구조 "호스트·웹뷰·워커의 경계"). 그
// 상태 기계는 SX-55/P1-B 의 일이고, 아직 학습 이벤트가 없어 완료를 판정할 근거가
// 없다. 그래서 P0 는 "어느 단계를 보고 있나" 라는 **보기 상태**만 두고, 완료 조건은
// 전부 미확인(☐)으로 그린다. 확인 표시는 이벤트가 생기는 P1 이 채운다 —
// 근거 없이 ✓ 를 그리는 것이 이 제품이 가장 하지 말아야 할 일이다.

import type { ResolvedProfile } from "../../src/protocol";
import { actionsFrom, stepsRemaining, type LessonStep as Step } from "./missionHeaderLogic";

type Lesson = NonNullable<ResolvedProfile["lesson"]>;

export interface MissionHeaderProps {
  lesson: Lesson | null;
  /** 지금 보고 있는 단계 id. null 이면 첫 단계. */
  currentStepId: string | null;
  onSelectStep: (stepId: string) => void;
  /** 현재 단계 과제를 코치에게 넣는다. 화면의 유일한 Primary CTA(SX-04). */
  onStartStep: (step: Step) => void;
  /** 변화 기록으로. 작은 링크 하나다(SX-03). */
  onOpenGrowth: () => void;
  /** 스트리밍 중에는 Primary 가 busy 가 되고 두 번째 Primary 가 생기지 않는다(SX-04). */
  busy: boolean;
  /** 활동 종류·이름. 헤더 안 작은 줄로 내려간다(설계 §정보 구조 영역 A). */
  activity: { label: string; name: string; verified: boolean } | null;
}

export function MissionHeader(props: MissionHeaderProps) {
  const { lesson, currentStepId, activity } = props;
  const content = lesson?.content ?? null;
  const learning = content?.learning ?? null;
  const steps = content?.steps ?? [];
  const actions = actionsFrom(steps, currentStepId);
  const remaining = stepsRemaining(steps, currentStepId);
  const current = actions[0] ?? null;

  return (
    <header className="hp-mission" aria-label="현재 과제">
      {learning ? (
        <p className="hp-mission-week">{learning.week}주차</p>
      ) : null}

      {/* 가장 큰 활자. 설계 파일에 미션이 없으면 빈 헤더가 아니라 없다고 말한다(SX-01 부정). */}
      <h1 className="hp-mission-sentence">
        {learning?.mission ?? (content ? "미션이 정해지지 않았습니다." : "아직 연결된 수업이 없습니다.")}
      </h1>

      {activity ? (
        // `aria-label="현재 활동"` 은 예전 `hps-activity-header` 가 갖고 있던 것이다.
        // 이 줄을 미션 헤더 안 작은 줄로 옮기면서 라벨을 빠뜨렸더니 CI 의 실제 브라우저
        // 검사(US-UI-DRAFT)가 `getByLabel('현재 활동')` 에서 끊겼다. 활동이 바뀐 것을
        // 스크린 리더가 짚을 수 있어야 한다는 계약은 자리 이동과 무관하게 그대로다.
        <p className="hp-mission-activity" aria-label="현재 활동">
          {activity.label} · {activity.name}
          {!activity.verified ? (
            <span role="status"> · 연결을 확인하지 못했습니다. 저장된 기록을 볼 수 있으며, 다시 연결한 뒤 보낼 수 있습니다.</span>
          ) : null}
        </p>
      ) : null}

      {actions.length ? (
        <ol className="hp-mission-actions" aria-label="지금 할 것">
          {actions.map((step, index) => (
            <li key={step.id} className={index === 0 ? "hp-mission-action hp-mission-action-now" : "hp-mission-action"}>
              {index === 0 ? (
                <button
                  type="button"
                  className="hp-cta-primary"
                  disabled={props.busy}
                  onClick={() => props.onStartStep(step)}
                >
                  {step.title}
                </button>
              ) : (
                <button type="button" className="hp-cta-quiet" onClick={() => props.onSelectStep(step.id)}>
                  {step.title}
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : null}

      {current ? <p className="hp-mission-acceptance">이번 단계가 끝났다고 볼 조건: {current.acceptance}</p> : null}

      {learning?.completion?.length ? (
        <ul className="hp-mission-completion" aria-label="이번 주차의 완료 조건">
          {learning.completion.map((item) => (
            <li key={item.id}>
              {/* SX-50 — 상태는 색만으로 표현하지 않는다. 아이콘 + 문구를 함께 쓴다.
                  P0 에는 판정할 이벤트가 없으므로 전부 미확인이고, 그 사실을 말한다. */}
              <span className="hp-mark" aria-hidden="true">☐</span>
              <span className="hp-mission-completion-text">{item.text}</span>
            </li>
          ))}
          <li className="hp-mission-completion-note">
            <span className="hp-mark" aria-hidden="true">·</span>
            <span>확인 표시는 직접 적고 시험한 기록이 쌓일 때 붙습니다. 지금은 아직 확인 전입니다.</span>
          </li>
        </ul>
      ) : null}

      <p className="hp-mission-foot">
        {steps.length ? <span className="hp-mission-remaining">남은 단계 {remaining}</span> : null}
        <button type="button" className="hp-mission-growth" onClick={props.onOpenGrowth}>
          나의 변화 기록 ›
        </button>
      </p>
    </header>
  );
}
