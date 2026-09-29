import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { HELP_MODE_LABELS, REHEARSAL_REASON_WORDS, helpChoices, surfaceOf, type HelpMode, type RenderedStep, type StepWork } from "../../src/lessonFocus";
import type { ResolvedProfile, WebviewMessage } from "../../src/protocol";

type Lesson = NonNullable<ResolvedProfile["lesson"]>;
type Step = Lesson["content"]["steps"][number];

/**
 * #751 G2 — the part of the current step that CHANGES what the learner does: the help modes this step offers (applied to
 * the next question), the step's work surface, and — in an instructor's rehearsal — the report of what this panel drew.
 * Quiet controls only: the screen's one Primary stays region A's "지금 할 행동" (SX-01·SX-04).
 */
/**
 * The mission header as the learner sees it right now, read from the rendered DOM (MissionHeader.tsx) — never from the lesson
 * data. The Service compares it word for word with the candidate, so a stale or missing header cannot pass a rehearsal.
 */
function drawnMission() {
  const h = document.querySelector<HTMLElement>("header.hp-mission");
  if (!h) return undefined;
  return {
    week: h.querySelector(".hp-mission-week")?.textContent ?? null,
    sentence: h.querySelector(".hp-mission-sentence")?.textContent ?? "",
    completion: [...h.querySelectorAll(".hp-mission-completion-text")].map((e) => e.textContent ?? ""),
  };
}

export function LessonStepPanel(props: {
  lesson: Lesson;
  step: Step;
  rehearsal: ResolvedProfile["rehearsal"] | undefined;
  work: Record<string, StepWork>;
  rehearsalState: { state: "sending" | "sent" | "error"; verdict?: string; reasons?: string[]; message?: string } | null;
  busy: boolean;
  post: (m: WebviewMessage) => void;
}) {
  const { lesson, step, post } = props;
  const choices = helpChoices(step), surface = surfaceOf(step);
  const [picked, setPicked] = useState<Record<string, HelpMode>>({});
  const key = lesson.sha256 + ":" + step.id;
  const chosen = picked[key] ?? null;
  const effective = chosen ?? (choices.includes(step.help?.default as HelpMode) ? (step.help!.default as HelpMode) : null);

  // The host holds the focus for the NEXT turn; a running turn keeps what it started with.
  useEffect(() => { post({ type: "lessonFocus", stepId: step.id, helpMode: chosen }); }, [lesson.sha256, step.id, chosen]);

  // Read back what was actually drawn, per step, for a rehearsal report (never recomputed from the lesson).
  const panel = useRef<HTMLDivElement>(null), drawn = useRef<{ sha: string; steps: Record<string, RenderedStep> }>({ sha: "", steps: {} });
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    if (drawn.current.sha !== lesson.sha256) drawn.current = { sha: lesson.sha256, steps: {} };
    const radios = [...el.querySelectorAll<HTMLInputElement>('input[name="hp-help-mode"]')];
    drawn.current.steps[step.id] = { id: step.id, visited: true, help_offered: radios.map((r) => r.value), help_default: el.querySelector<HTMLElement>("[data-help-default]")?.dataset.helpDefault ?? null, surface: el.querySelector<HTMLElement>("[data-surface]")?.dataset.surface ?? "not_drawn" };
  });

  const saved = props.work[step.id];
  const [text, setText] = useState(""), [reason, setReason] = useState("");
  useEffect(() => { setText(saved?.text ?? ""); setReason(saved?.reason ?? ""); }, [key, saved?.savedAt]);

  const r = props.rehearsal, rs = props.rehearsalState;
  return (
    <div ref={panel} className="hp-rail-lesson hp-step-work" data-lesson-step-panel={step.id}>
      {r && (
        <section className="hp-rehearsal" aria-label="강사 리허설">
          <p><strong>강사 리허설</strong> — 이 수업 후보(버전 {r.version})를 학생 조건으로 시험하고 있습니다. 단계마다 열어 보고 AI에게 한 번 이상 물어본 뒤 결과를 보내세요. 실제 학생 기록이 아닙니다.</p>
          <button type="button" className="hp-cta-quiet" data-rehearsal-send="" disabled={props.busy || r.judged || rs?.state === "sending" || rs?.state === "sent"}
            onClick={() => post({ type: "rehearsalSend", steps: Object.values(drawn.current.sha === lesson.sha256 ? drawn.current.steps : {}), mission: drawnMission() })}>
            {rs?.state === "sending" ? "보내는 중…" : "리허설 결과 보내기"}
          </button>
          {rs && rs.state !== "sending" && <p role="status" data-rehearsal-result={rs.verdict ?? rs.state}>
            {rs.state === "error" ? rs.message : rs.verdict === "passed" ? "통과 — 강사 화면에서 확정할 수 있습니다." : rs.verdict === "unsupported" ? "지원 안 됨 — " + (rs.reasons ?? []).map((x) => REHEARSAL_REASON_WORDS[x] ?? x).join(", ") : "통과하지 못함 — " + (rs.reasons ?? []).map((x) => REHEARSAL_REASON_WORDS[x] ?? x).join(", ")}
          </p>}
        </section>
      )}
      {(lesson.content.objective || lesson.content.starter) && (
        <p className="hp-rail-lesson-meta">{lesson.content.objective ? "수업 목표: " + lesson.content.objective : ""}{lesson.content.objective && lesson.content.starter ? " · " : ""}{lesson.content.starter ? "시작 자료: " + lesson.content.starter : ""}</p>
      )}
      {choices.length > 0 && (
        <fieldset className="hp-help-modes" data-help-default={step.help?.default ?? ""}>
          <legend>이 단계의 도움 방식 · 다음 질문부터 적용</legend>
          {choices.map((m) => (
            <label key={m}>
              <input type="radio" name="hp-help-mode" value={m} checked={effective === m}
                onChange={() => setPicked((p) => ({ ...p, [key]: m }))} />
              {HELP_MODE_LABELS[m]}{m === step.help?.default ? " (수업 기본)" : ""}
            </label>
          ))}
          <p className="hp-rail-lesson-note">도움 방식은 AI가 돕는 방법만 바꿉니다. 쓸 수 있는 도구나 권한은 바뀌지 않고, 직접 해보기를 골라도 혼자 했다고 기록되지는 않습니다.</p>
        </fieldset>
      )}
      {surface === "criterion_form" ? (
        <form data-surface="criterion_form" className="hp-surface" onSubmit={(e) => { e.preventDefault(); post({ type: "lessonWork", stepId: step.id, kind: "criterion", text }); }}>
          <label>이 단계의 확인 기준 — 무엇이 되면 잘 된 것인지 한 줄로 적으세요
            <textarea value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} rows={2} />
          </label>
          <button type="submit" className="hp-cta-quiet" disabled={!text.trim()}>기준 저장</button>
          {saved && <p className="hp-rail-lesson-note" data-saved-work="criterion">저장한 기준: {saved.text} · 다음 질문에 함께 보냅니다</p>}
        </form>
      ) : surface === "decision_form" ? (
        <form data-surface="decision_form" className="hp-surface" onSubmit={(e) => { e.preventDefault(); post({ type: "lessonWork", stepId: step.id, kind: "decision", text, reason }); }}>
          <label>무엇을 바꾸기로 했나요
            <input value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
          </label>
          <label>왜 그렇게 정했나요
            <textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} rows={2} />
          </label>
          <button type="submit" className="hp-cta-quiet" disabled={!text.trim() || !reason.trim()}>결정 저장</button>
          {saved && <p className="hp-rail-lesson-note" data-saved-work="decision">저장한 결정: {saved.text} · 이유: {saved.reason} · 다음 질문에 함께 보냅니다</p>}
        </form>
      ) : surface.startsWith("unsupported:") ? (
        <p className="hp-rail-lesson-note" data-surface={surface}>이 단계의 작업 화면({surface.slice(12)})은 이 Studio에서 아직 열 수 없습니다. 대화로 진행하고 강사에게 알려 주세요.</p>
      ) : (
        <span hidden data-surface="chat" />
      )}
    </div>
  );
}
