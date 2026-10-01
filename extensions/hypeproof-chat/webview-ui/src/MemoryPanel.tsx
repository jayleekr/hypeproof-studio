// "프로젝트 기억" panel (cr-memory, #1395; CR-35–CR-38, CR-75–CR-79, CR-82).
//
// Draws the team's learning state the host read from the Service (`MemoryView`) and sends the
// student's own decision and version comparison back. It decides nothing: confidence, which
// reference resolves, what a decision rests on, why a belief changed, are the Service's. An AI
// suggestion is drawn apart from the team's decisions (SX-45); a decision with no evidence says
// so; a belief change with nothing linked reads "기록되지 않았어요", never a made-up reason.
import { useEffect, useState } from "react";
import type { Confidence, DecisionForm, MemoryItemView, MemoryView } from "../../src/memoryView";
import { CHANGE_LABEL, CONFIDENCE_LABEL, ENTRY_LABEL, ROLE_CONFIDENCE_SUFFIX, ROLE_LABEL, STATUS_LABEL, beliefSentence, decisionFormProblems, timelineRecord } from "../../src/memoryView";

const time = (t: number | string) => new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const short = (id: string) => id.replace(/^sha256:/, "").slice(0, 8);
const CONFIDENCES: Confidence[] = ["observed", "interpreted", "assumed"];

function Item(props: { item: MemoryItemView; pick?: { checked: boolean; onChange(v: boolean): void } }) {
  const { item } = props;
  const [open, setOpen] = useState(false);
  return (
    <li data-testid="memory-item" data-confidence={item.confidence} data-ref={item.id}>
      {props.pick && <input type="checkbox" aria-label="근거로 고르기" checked={props.pick.checked} onChange={(e) => props.pick!.onChange(e.target.checked)} />}
      <button type="button" className="hps-evidence-claim" aria-expanded={open} onClick={() => setOpen(!open)}>{item.statement}</button>
      <span className="hps-evidence-meta">
        {item.pending_review && <em data-testid="memory-item-unreviewed"> · 아직 검토하지 않은 초안</em>}
        {item.sources_real === false && <em data-testid="memory-item-not-real"> · 실제로 본 기록이 아니에요</em>}
        {item.assumption_status === "observed_later" && <strong data-testid="memory-promoted"> · 처음엔 가정이었는데 나중에 확인했어요</strong>}
        {item.assumption_status === "open" && " · 아직 확인 안 됨"}
        {(item.cited_by?.length ?? 0) > 0 && ` · 결정 ${item.cited_by!.length}개가 씀`}
        {(item.slides?.length ?? 0) > 0 && ` · 슬라이드 ${item.slides!.join(", ")}`}
      </span>
      {open && (
        <ol className="hps-evidence-sources" data-testid="memory-item-revisions">
          {item.revisions.map((r) => (
            <li key={r.revision}>{r.revision}번째 기록 · {CONFIDENCE_LABEL[r.confidence]} · {r.statement}</li>
          ))}
        </ol>
      )}
    </li>
  );
}

const EMPTY: DecisionForm = { statement: "", evidence_refs: [], assumption_refs: [], affected_deck_slides: [], resulting_version_id: null };

export function MemoryPanel(props: {
  view: MemoryView;
  error: string | null;
  done: string | null;
  busy: boolean;
  onRefresh(): void;
  onDiff(from: string, to: string): void;
  onDecide(form: DecisionForm): void;
  onClose(): void;
}) {
  const { view } = props;
  const m = view.memory;
  const [form, setForm] = useState<DecisionForm>(EMPTY);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // The form is cleared only when the Service stored the decision (a `done` with a fresh view);
  // a refusal keeps what the student typed so they can fix it and try again.
  useEffect(() => {
    if (props.done) setForm(EMPTY);
  }, [props.view, props.done]);
  const toggle = (key: "evidence_refs" | "assumption_refs", ref: string, on: boolean) => setForm((f) => ({ ...f, [key]: on ? [...f[key], ref] : f[key].filter((x) => x !== ref) }));
  const ready = decisionFormProblems(form).length === 0;
  return (
    <section className="hps-evidence" data-testid="memory-panel" aria-label="프로젝트 기억">
      <header>
        <strong>프로젝트 기억</strong>
        <button type="button" onClick={props.onRefresh} disabled={props.busy}>새로 불러오기</button>
        <button type="button" onClick={props.onClose} aria-label="닫기">✕</button>
      </header>
      {view.notice && <p data-testid="memory-notice">{view.notice}</p>}
      {props.error && <div className="hps-publish-error" role="alert" data-testid="memory-error">{props.error}</div>}
      {props.done && <div className="hps-evidence-done" role="status">{props.done}</div>}
      {m && (
        <>
          <h4>{m.project.title}</h4>
          <p data-testid="memory-problem">{m.problem ? `문제: ${m.problem}` : "아직 문제를 적지 않았어요."}</p>

          <h4>가설</h4>
          <ul data-testid="memory-hypotheses">
            {m.hypotheses.map((h) => (
              <li key={h.id} data-testid="memory-hypothesis" data-id={h.id}>{h.statement} · {STATUS_LABEL[h.status] ?? h.status}</li>
            ))}
          </ul>
          {m.belief_changes.length > 0 && (
            <ul data-testid="memory-beliefs">
              {m.belief_changes.map((b, i) => (
                <li key={i} data-testid="memory-belief" data-reason={b.reason}>{beliefSentence(b)}</li>
              ))}
            </ul>
          )}

          <h4>실험</h4>
          <ul data-testid="memory-experiments">
            {m.experiments.map((e) => (
              <li key={e.id} data-testid="memory-experiment" data-id={e.id}>{e.week}주차 · {e.question}</li>
            ))}
          </ul>

          <h4>어디까지 확인했나?</h4>
          {CONFIDENCES.map((c) => (
            <div key={c} data-testid={`memory-register-${c}`}>
              <strong>{CONFIDENCE_LABEL[c]} {m.register[c].length}개</strong>
              <ul>
                {m.register[c].map((it) => <Item key={it.id} item={it} />)}
              </ul>
            </div>
          ))}

          <h4>결정</h4>
          <ul data-testid="memory-decisions">
            {m.decisions.map((d) => (
              <li key={d.id} data-testid="memory-decision" data-id={d.id} data-shown-as={d.shown_as}>
                {d.shown_as === "ai_suggestion" ? <em>AI 제안 (팀 결정 아님): </em> : <strong>팀 결정: </strong>}
                {d.statement}
                {d.no_evidence && <span data-testid="memory-no-evidence"> · 근거가 연결되지 않았어요</span>}
                {d.evidence.some((e) => e.state === "missing") && <strong> · 근거 확인 필요</strong>}
                {d.affected_deck_slides.length > 0 && ` · 슬라이드 ${d.affected_deck_slides.join(", ")}`}
                {d.resulting_version_id && ` · 버전 ${short(d.resulting_version_id)}`}
              </li>
            ))}
          </ul>

          <details data-testid="memory-decision-form">
            <summary>결정 기록하기</summary>
            <textarea aria-label="결정" rows={2} value={form.statement} onChange={(e) => setForm({ ...form, statement: e.target.value })} placeholder="무엇을 하기로 했나요?" />
            <div>근거 (확인한 것, 해석)</div>
            <ul>
              {[...m.register.observed, ...m.register.interpreted].filter((it) => !it.pending_review && it.sources_real !== false).map((it) => (
                <Item key={it.id} item={it} pick={{ checked: form.evidence_refs.includes(it.id), onChange: (v) => toggle("evidence_refs", it.id, v) }} />
              ))}
            </ul>
            <div>이 결정이 기대는 가정</div>
            <ul>
              {m.register.assumed.map((it) => (
                <Item key={it.id} item={it} pick={{ checked: form.assumption_refs.includes(it.id), onChange: (v) => toggle("assumption_refs", it.id, v) }} />
              ))}
            </ul>
            <div>
              바뀌는 발표 슬라이드{" "}
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <label key={n}>
                  <input type="checkbox" checked={form.affected_deck_slides.includes(n)} onChange={(e) => setForm({ ...form, affected_deck_slides: e.target.checked ? [...form.affected_deck_slides, n].sort((a, b) => a - b) : form.affected_deck_slides.filter((x) => x !== n) })} />
                  {n}
                </label>
              ))}
            </div>
            <select aria-label="이 결정으로 만든 버전" value={form.resulting_version_id ?? ""} onChange={(e) => setForm({ ...form, resulting_version_id: e.target.value || null })}>
              <option value="">아직 만든 버전 없음</option>
              {m.versions.map((v, i) => <option key={v.id} value={v.id}>v{i} · {short(v.id)}</option>)}
            </select>
            <button type="button" data-testid="memory-decide" disabled={props.busy || !ready} onClick={() => props.onDecide(form)}>결정 저장</button>
          </details>

          <h4>버전</h4>
          <ul data-testid="memory-versions">
            {m.versions.map((v, i) => <li key={v.id} data-testid="memory-version" data-id={v.id}>v{i} · {short(v.id)} · {time(v.created_at)}</li>)}
          </ul>
          {m.versions.length >= 2 && (
            <div>
              <select aria-label="이전 버전" value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">이전 버전</option>
                {m.versions.map((v, i) => <option key={v.id} value={v.id}>v{i}</option>)}
              </select>
              <select aria-label="새 버전" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">새 버전</option>
                {m.versions.map((v, i) => <option key={v.id} value={v.id}>v{i}</option>)}
              </select>
              <button type="button" data-testid="memory-compare" disabled={props.busy || !from || !to || from === to} onClick={() => props.onDiff(from, to)}>비교하기</button>
            </div>
          )}
          {view.diff && (
            <div data-testid="memory-diff" data-reason={view.diff.reason}>
              <ul>{view.diff.files.map((f) => <li key={f.path}>{f.path} · {CHANGE_LABEL[f.change]}</li>)}</ul>
              {view.diff.reason === "no_recorded_decision" ? <p>이 버전을 만든 결정이 기록되지 않았어요.</p> : view.diff.decisions.map((d) => <p key={d.id}>결정: {d.statement} · 근거 {d.evidence.length}개</p>)}
            </div>
          )}

          {m.stakeholders.length > 0 && (
            <>
              <h4>누구의 일인가</h4>
              <ul data-testid="memory-stakeholders">
                {m.stakeholders.map((s) => (
                  <li key={s.id}>{s.label} · {s.roles_shown.map((r) => `${ROLE_LABEL[r.role] ?? r.role}${ROLE_CONFIDENCE_SUFFIX[r.confidence] ?? ""}`).join(", ")}{s.payer_and_user && " · 쓰는 사람이 돈도 내요"}</li>
                ))}
              </ul>
            </>
          )}
          {m.metrics.length > 0 && (
            <>
              <h4>지표</h4>
              <ul data-testid="memory-metrics">
                {m.metrics.map((x) => (
                  <li key={x.id} data-status={x.value.status}>
                    {x.name}:{" "}
                    {x.value.status === "result"
                      ? `${x.value.value}${x.unit} (실제 기록 ${x.value.source_refs.length}개)`
                      : x.value.status === "evidence_only"
                        ? `숫자 없이 근거 ${x.value.source_refs.length}개 (${CONFIDENCES.map((c) => [c, (x.value.evidence ?? []).filter((e) => e.confidence === c).length] as const).filter(([, n]) => n > 0).map(([c, n]) => `${CONFIDENCE_LABEL[c]} ${n}`).join(", ")})`
                        : "근거가 되는 실제 기록이 없어요"}
                    {Object.keys(x.value.not_counted).length > 0 && " · 연습·가상 기록은 세지 않았어요"}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4>지금까지</h4>
          <ol data-testid="memory-timeline">
            {m.timeline.map((e, i) => {
              // CR-78: every entry opens the stored record it names, from the same answer.
              const rec = timelineRecord(m, e.record);
              return (
                <li key={i} data-entry={e.entry} data-record={`${e.record.kind}:${e.record.id}${e.record.revision !== undefined ? `@${e.record.revision}` : ""}`}>
                  <details data-testid="memory-timeline-entry" data-found={rec ? "yes" : "no"}>
                    <summary>{time(e.at)} · {ENTRY_LABEL[e.entry] ?? e.entry} · {e.label}</summary>
                    {rec ? (
                      <div data-testid="memory-record">
                        <strong>{rec.title}</strong>
                        <ul>{rec.lines.map((l, j) => <li key={j}>{l}</li>)}</ul>
                      </div>
                    ) : (
                      <p data-testid="memory-record-missing">이 기록을 찾을 수 없어요.</p>
                    )}
                  </details>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
