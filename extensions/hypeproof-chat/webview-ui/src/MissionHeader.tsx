// Region A — Mission header (SX-01 ~ SX-05).
//
// Requirements: docs/requirements/studio-learning-experience.md A. HOME
// Design: docs/design/studio-learning-experience.md §정보 구조 (region A)
//
// This screen does one thing: **keep you from losing track of what to do right now.**
// So top to bottom it is week → one mission sentence → the 1–3 actions to do now →
// completion conditions → steps remaining, and the growth-record entry sits **below
// that, at link size** (SX-03).
// The largest type is the mission sentence — the 5-second recall test (SX-T01) looks at it.
//
// What is not here, and why:
//   · scores, grades, percentages, badges — SX-59. `test/sx-audit.smoke.mjs` audits the render result.
//   · a progress card — SX-51. "남은 단계 3" is a **sentence**, not a number card.
//   · interpretive sentences — interpretation happens only in the retrospective and the growth record (SX-17).
//
// The webview holding the current step is **P0-only**. The design says the host owns
// the truth and pushes it down as `learningState` (§정보 구조 "호스트·웹뷰·워커의
// 경계"). That state machine is SX-55/P1-B's job, and with no learning events yet there
// is no basis for judging completion. So P0 keeps only a **view state** — "which step am
// I looking at" — and draws every completion condition as unchecked (☐). The check marks
// are filled in by P1, where the events come from — drawing a ✓ with no evidence is the
// one thing this product must most avoid.

import type { ResolvedProfile } from "../../src/protocol";
import { actionsFrom, stepsRemaining, type LessonStep as Step } from "./missionHeaderLogic";

type Lesson = NonNullable<ResolvedProfile["lesson"]>;

export interface MissionHeaderProps {
  lesson: Lesson | null;
  /** The id of the step currently being viewed. null means the first step. */
  currentStepId: string | null;
  onSelectStep: (stepId: string) => void;
  /** Feeds the current step's task to the coach. The screen's only Primary CTA (SX-04). */
  onStartStep: (step: Step) => void;
  /** To the growth record. A single small link (SX-03). */
  onOpenGrowth: () => void;
  /** While streaming the Primary goes busy and no second Primary appears (SX-04). */
  busy: boolean;
  /** Activity kind and name. Demoted to a small line inside the header (design §정보 구조, region A). */
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

      {/* The largest type. If the design file has no mission, say so instead of rendering an empty header (SX-01 negative). */}
      <h1 className="hp-mission-sentence">
        {learning?.mission ?? (content ? "미션이 정해지지 않았습니다." : "아직 연결된 수업이 없습니다.")}
      </h1>

      {activity ? (
        // `aria-label="현재 활동"` is what the old `hps-activity-header` carried.
        // Moving this line into the mission header as a small line dropped the label, and
        // CI's real-browser check (US-UI-DRAFT) broke at `getByLabel('현재 활동')`. The
        // contract — a screen reader must be able to point out that the activity changed —
        // is unchanged by the move.
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
                <button type="button" className="hp-cta-quiet" data-step-id={step.id} onClick={() => props.onSelectStep(step.id)}>
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
              {/* SX-50 — state is never expressed by color alone. Icon + wording together.
                  P0 has no events to judge on, so everything is unchecked, and we say so. */}
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
