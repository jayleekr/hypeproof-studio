// "커리큘럼 스킬" panel (cr-skills, #1396; CR-43–CR-47).
//
// Lists the skills the Service serves, takes the few inputs each one needs and draws the
// result the Service accepted, or why it refused the AI's answer. It decides nothing: whether
// an answer keeps the skill's rules, and what is stored, are the Service's (CR-44). The week's
// question is the curriculum data the Service serves, never a string in this file (CR-45).
import { useState } from "react";
import type { SkillForm, SkillsView } from "../../src/skillView";
import { problemLine, skillFormProblems } from "../../src/skillView";

export function SkillsPanel(props: {
  view: SkillsView;
  error: string | null;
  done: string | null;
  running: boolean;
  onRefresh(): void;
  onRun(skill: string, form: SkillForm): void;
  onClose(): void;
}) {
  const { view } = props;
  const [skill, setSkill] = useState("");
  const [form, setForm] = useState<SkillForm>({});
  const chosen = view.skills.find((s) => s.skill === skill) ?? null;
  const problems = chosen ? skillFormProblems(chosen.skill, form) : ["스킬을 골라 주세요."];
  const pick = (id: string) => {
    setSkill(id);
    setForm({});
  };
  const toggle = (ref: string, on: boolean) => setForm((f) => ({ ...f, evidence_refs: on ? [...(f.evidence_refs ?? []), ref] : (f.evidence_refs ?? []).filter((x) => x !== ref) }));
  const r = view.result;
  return (
    <section className="hps-evidence" data-testid="skills-panel" aria-label="커리큘럼 스킬">
      <header>
        <strong>커리큘럼 스킬</strong>
        <button type="button" onClick={props.onRefresh} disabled={props.running}>새로 불러오기</button>
        <button type="button" onClick={props.onClose} aria-label="닫기">✕</button>
      </header>
      {view.notice && <p data-testid="skills-notice">{view.notice}</p>}
      {props.error && <div className="hps-publish-error" role="alert" data-testid="skills-error">{props.error}</div>}
      {props.done && <div className="hps-evidence-done" role="status">{props.done}</div>}
      {view.week && <p data-testid="skills-week">{view.week.week}주차 질문: {view.week.question}</p>}
      {view.available && (
        <>
          <ul data-testid="skills-list">
            {view.skills.map((s) => (
              <li key={s.skill}>
                <label>
                  <input type="radio" name="skill" value={s.skill} checked={skill === s.skill} onChange={() => pick(s.skill)} data-testid={`skill-${s.skill}`} />
                  {s.title}
                </label>
              </li>
            ))}
          </ul>
          {chosen && (
            <div data-testid="skill-form">
              {chosen.skill === "evidence" && (
                <select aria-label="정리할 실험" value={form.experiment_id ?? ""} onChange={(e) => setForm({ ...form, experiment_id: e.target.value || undefined })}>
                  <option value="">실험 고르기</option>
                  {view.pickers.experiments.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                </select>
              )}
              {chosen.skill === "deck-builder" && (
                <select aria-label="팀의 결정" value={form.decision_id ?? ""} onChange={(e) => setForm({ ...form, decision_id: e.target.value || undefined })}>
                  <option value="">결정 고르기</option>
                  {view.pickers.decisions.map((d) => <option key={d.id} value={d.id}>{d.label} (슬라이드 {d.slides.join(", ")})</option>)}
                </select>
              )}
              {chosen.skill === "product-builder" && (
                <ul aria-label="고칠 근거">
                  {view.pickers.evidence.map((e) => (
                    <li key={e.id}>
                      <label>
                        <input type="checkbox" checked={(form.evidence_refs ?? []).includes(e.id)} onChange={(ev) => toggle(e.id, ev.target.checked)} />
                        {e.label}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {["experiment", "evidence", "product-builder", "interview", "critic"].includes(chosen.skill) && (
                <textarea
                  aria-label="스킬에 줄 내용"
                  placeholder={chosen.skill === "interview" ? "인터뷰로 알고 싶은 것" : chosen.skill === "critic" ? "검토할 주장 (한 줄에 하나, 비워도 돼요)" : "더 알려 줄 것 (비워도 돼요)"}
                  value={form.text ?? ""}
                  onChange={(e) => setForm({ ...form, text: e.target.value })}
                />
              )}
              {chosen.skill === "interview" && <textarea aria-label="인터뷰 메모" placeholder="인터뷰하며 적은 메모 (있으면)" value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}
              <button type="button" data-testid="skill-run" disabled={props.running || problems.length > 0} onClick={() => props.onRun(chosen.skill, form)}>
                {props.running ? "실행 중…" : "실행하기"}
              </button>
              {problems.length > 0 && <p className="hps-evidence-meta">{problems.join(" ")}</p>}
            </div>
          )}
        </>
      )}
      {r && (
        <div data-testid="skill-result" data-ok={r.ok ? "true" : "false"} data-tag={r.tag}>
          {r.ok ? (
            <>
              {(r.sections ?? []).map((s) => (
                <div key={s.heading}>
                  <h4>{s.heading}</h4>
                  <ul>{s.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
                </div>
              ))}
              {(r.written ?? []).map((w) => <p key={w} data-testid="skill-written">{w}</p>)}
              {(r.written ?? []).length === 0 && <p className="hps-evidence-meta">제안이에요. 저장한 것은 없어요.</p>}
            </>
          ) : (
            <>
              <p role="alert">{r.message}</p>
              {(r.problems ?? []).length > 0 && (
                <ul data-testid="skill-problems">{(r.problems ?? []).map((p) => <li key={p} data-code={p}>{problemLine(p)}</li>)}</ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
