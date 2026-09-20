/**
 * 호스트가 학습 상태를 계산하는 순수 함수들 (P1-B, SX-14·15·17·45).
 *
 * 왜 `vscode` 를 import 하지 않나: 이 저장소의 관용대로 판정 로직은 `xxxHelpers.ts`
 * 에 두고 orchestration 만 `chatPanelProvider.ts` 에 남긴다. 그래야 게이트를
 * Electron 없이 `node --experimental-strip-types` 로 잴 수 있다.
 *
 * 경계(설계 §정보 구조 "호스트·웹뷰·워커의 경계"):
 *   - **호스트가 진실을 갖는다.** 게이트는 여기서 계산해 `learningState` 로 내려보낸다.
 *   - **웹뷰는 다시 계산하지 않는다.** CTA 비활성은 `complete.ok` 를 그대로 그린다.
 *   - 게이트 결과는 **저장하지 않는다.** 매번 이벤트에서 계산한다.
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
  type SourceKind,
  type SourceState,
} from "../../../worker/src/lib/measurement-core/learning-events.ts";
import type { ObservationEvent } from "../../../worker/src/lib/measurement-core/legacy-observation.ts";

/** 세션 설계 `learning.completion[]` 한 줄. `label` 은 화면에 그대로 나간다. */
export interface CompletionItem {
  id: string;
  event: LearningEventKind;
  label?: string;
}

export interface EvidenceRow {
  id: string;
  kind: string;
  /** 없으면 `null`. 여섯 중 하나로 **추정하지 않는다** (SX-18 부정 조건). */
  evidence_type: EvidenceType | null;
  at: number;
  /** 학생 원문 그대로. 없으면 이벤트 본문 (SX-44). */
  text: string;
  actor: ObservationActor;
  source_kind: SourceKind;
  source_state: SourceState;
  provenance: { who: string; when: string; where: string } | null;
  /** 코치 제안을 채택한 경우 그 코치 이벤트 id (설계 §관측 이벤트와 필드 규칙 4). */
  adopted_from: string | null;
}

export interface LearningStatePayload {
  task: string;
  phase: "assigned" | "working" | "submitted" | "reflected";
  currentStep: string | null;
  /** SX-14. `ok=false` 면 완료 CTA 가 비활성이고 `reasons` 가 버튼 옆에 나온다. */
  complete: { ok: boolean; reasons: string[]; missing: GateMiss[] };
  /** 세션 설계가 이 과제에 완료 조건을 **선언했는가**. 선언이 없다는 사실도 화면에 보인다. */
  declared: boolean;
  verification: { state: GatesResult["verification"]["state"]; source_state: SourceState; line: string };
  evidence: EvidenceRow[];
}

/** 서랍이 보여 주는 kind. `artifact` 는 변경 전후 비교에 필요해서 함께 온다. */
const DRAWER_KINDS = new Set<string>([...Object.keys(LEARNING_EVENT_SPEC), "artifact"]);

/**
 * 막힌 이유 한 문장.
 *
 * 숫자를 쓰지 않는다. "2개 중 1개" 같은 문구는 진행률로 읽히고, 진행률은 점수의
 * 다른 이름이다 (SX-59). 모르는 code 도 빈 줄을 돌려주지 않는다 — 버튼 옆이
 * 비어 있으면 학생은 왜 막혔는지 알 방법이 없다.
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

/** 완료 조건에 라벨이 없을 때 쓰는 kind 이름. 화면 문구이므로 숫자가 없다. */
const KIND_LABELS: Record<LearningEventKind, string> = {
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
  };
}

/**
 * 한 Task 의 학습 상태. 읽기만 한다.
 *
 * `completion` 이 비어 있으면 세션 설계가 이 과제에 완료 조건을 선언하지 않은 것이고,
 * 그 사실을 `declared: false` 로 함께 내보낸다 (SX-14 예외 조항 "그 선언이 화면에 보인다").
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
    },
    evidence: mine
      .filter((e) => DRAWER_KINDS.has(e.kind))
      .sort((a, b) => a.seq - b.seq)
      .map(rowOf),
  };
}

/**
 * SX-14 부정 조건 — 완료 제출을 호스트가 **다시** 판정한다.
 *
 * 웹뷰의 `disabled` 는 그림이지 잠금이 아니다. 개발자 도구로 속성 하나를 지우거나
 * `postMessage` 를 직접 던지면 그냥 눌린다. 그래서 같은 게이트를 같은 이벤트로
 * 여기서 한 번 더 돌린다. 두 곳이 **같은 함수**(`learningState`)를 부르므로 규칙이
 * 두 벌로 갈라지지 않는다.
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

/** 웹뷰가 보내도 되는 칸. 나머지는 호스트가 채우거나 버린다. */
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
 * 웹뷰 폼 제출 하나를 학습 이벤트 초안으로 바꾼다 (SX-45 규칙 2).
 *
 * 세 가지를 **웹뷰가 정하지 못하게** 한다:
 *   - `actor` — 호스트가 kind 표에서 정한다. 웹뷰가 보낸 값은 버린다.
 *   - `context` — Task.curriculum 에서 호스트가 채운다.
 *   - 호출 경로 — `sender: "webview-form"` 이 아니면 아무것도 만들지 않는다.
 *     코치 스트림 콜백이 학습 이벤트를 만들 수 있으면 SX-45 전체가 무의미해진다.
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
     * 세션 설계 단계의 `evidence` 값. `external_feedback_received` 처럼 kind 표가
     * evidence_type 을 정하지 않는 것에만 쓴다(설계 표의 "단계 `evidence`에 따름").
     * 웹뷰가 보내지 않는다 — 학생이 근거의 종류를 고르는 것이 아니라 단계가 정한다.
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
  // `/2` 검증기는 학습 kind 전부에 evidence_type 을 요구한다. kind 표가 정하지 않는
  // 것은 단계가 정하고, 둘 다 없으면 **거절한다**. 여섯 중 하나를 골라 넣지 않는다
  // (SX-18 부정 조건: "evidence_type 없는 이벤트를 여섯 중 하나로 추정하지 않는다").
  const evidenceType = spec.evidence_type ?? ctx.stepEvidenceType;
  if (!evidenceType) return { ok: false, code: "missing_evidence_type" };
  draft.evidence_type = evidenceType;
  if (spec.source_state) draft.source_state = spec.source_state;

  for (const field of WEBVIEW_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (field === "student_text") {
      const text = String(value).trim();
      // 공백만 보낸 것은 "적었다" 가 아니다. 대신 채워 주지 않는다.
      if (text.length === 0) return { ok: false, code: "missing_student_text" };
      draft.student_text = text.slice(0, 2000);
      continue;
    }
    // `source_state` 등 좁은 리터럴 타입 칸이 섞여 있다. 값의 **정당성**은 `/2`
    // 검증기가 이름을 붙여 거절하므로(`invalid_source_state`), 여기서 두 벌로
    // 검사하지 않는다 — 규칙이 두 곳에 있으면 갈라진다.
    (draft as Record<string, unknown>)[field] = value;
  }

  // kind 표의 **모든** 필수 칸을 본다. `student_text` 하나만 보던 판을 넓힌 이유:
  // `/2` 검증기는 `decision_revised` 에 `decision{from,to}` 와 비어 있지 않은
  // `evidence_refs[]` 를 요구한다. 여기서 통과시키면 저장은 되고 **다음 읽기에서**
  // 배치 전체가 거절된다 — 한 칸 빠진 것 때문에 그 자리의 기록이 통째로 날아간다.
  // 막을 거면 만드는 자리에서 막는다.
  for (const field of spec.required) {
    if (field === "context") continue; // 호스트가 방금 채웠다
    if (draft[field] === undefined) {
      return { ok: false, code: field === "student_text" ? "missing_student_text" : `missing_${field}` };
    }
  }
  if (Array.isArray(draft.evidence_refs) && draft.evidence_refs.length === 0) {
    return { ok: false, code: "missing_evidence_refs" };
  }
  return { ok: true, event: draft };
}
