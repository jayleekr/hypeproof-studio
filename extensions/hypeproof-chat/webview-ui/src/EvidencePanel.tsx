// "실험 증거" panel (cr-evidence, #1394; CR-24–CR-27, CR-69, CR-72, CR-74).
//
// Draws what the host read from the Service (`EvidenceView`) and sends the student's own actions
// back. It decides nothing: which reference resolves, whether a comparison claim is supported,
// how many times a device came back, are the Service's. Opening an observed claim shows the
// participant sessions and notes it cites (CR-27); a reference that no longer resolves reads
// "확인 필요". Counts of returns are per device, never per person (CR-72).
import { useState } from "react";
import type { EvidenceItemView, EvidenceView, NoteForm } from "../../src/evidenceView";
import { NOTE_KIND_CHOICES, REVIEW_LABEL, SECTION_LABEL, SOURCE_STATE_CHOICES, claimSources, noteFormProblems } from "../../src/evidenceView";

type ReviewAction = { item: string; action: "accept" | "edit" | "reject"; text?: string };
const time = (ms: number) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const days = (ms: number) => `${Math.round((ms / 86_400_000) * 10) / 10}일`;

function Claim(props: { view: EvidenceView; item: EvidenceItemView; onReview?(a: ReviewAction): void; busy: boolean }) {
  const { item } = props;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const sources = claimSources(props.view, item);
  const needsReview = sources.some((s) => s.state !== "ok");
  return (
    <li className="hps-evidence-item" data-testid="evidence-item" data-section={item.section} data-review={item.review}>
      <button type="button" className="hps-evidence-claim" data-testid="evidence-claim" aria-expanded={open} onClick={() => setOpen(!open)} disabled={item.source_refs.length === 0}>
        {item.text}
      </button>
      <span className="hps-evidence-meta">
        {REVIEW_LABEL[item.review]}
        {item.source_refs.length > 0 && ` · 근거 ${item.source_refs.length}개`}
        {needsReview && <strong data-testid="evidence-needs-review"> · 확인 필요</strong>}
        {item.comparison === "unsupported" && <strong data-testid="evidence-unsupported"> · 한쪽 근거만 있어요</strong>}
        {item.basis === "per_device_pseudonym" && " · 기기 기준 (사람 수 아님)"}
      </span>
      {open && (
        <ul className="hps-evidence-sources" data-testid="evidence-sources">
          {sources.map((s) => (
            <li key={s.ref} data-testid="evidence-source" data-state={s.state} data-ref={s.ref}>
              <strong>{s.label}</strong> {s.detail}
            </li>
          ))}
        </ul>
      )}
      {props.onReview && item.review !== "rejected" && (
        <div className="hps-evidence-review">
          {editing !== null ? (
            <>
              <textarea value={editing} onChange={(e) => setEditing(e.target.value)} aria-label="고친 문장" rows={2} />
              <button type="button" disabled={props.busy || !editing.trim()} onClick={() => { props.onReview!({ item: item.id, action: "edit", text: editing.trim() }); setEditing(null); }}>저장</button>
              <button type="button" onClick={() => setEditing(null)}>취소</button>
            </>
          ) : (
            <>
              {item.review === "draft" && <button type="button" disabled={props.busy} data-testid="evidence-accept" onClick={() => props.onReview!({ item: item.id, action: "accept" })}>받아들이기</button>}
              {item.section !== "observation" && <button type="button" disabled={props.busy} data-testid="evidence-edit" onClick={() => setEditing(item.text)}>고치기</button>}
              <button type="button" disabled={props.busy} data-testid="evidence-reject" onClick={() => props.onReview!({ item: item.id, action: "reject" })}>버리기</button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

const EMPTY_NOTE: NoteForm = { note_kind: "", text: "", who: "", when: "", where: "", source_state: "" };

export function EvidencePanel(props: {
  view: EvidenceView;
  error: string | null;
  done: string | null;
  busy: boolean;
  onSelect(experimentId: string): void;
  onNote(experimentId: string, note: NoteForm): void;
  onDraft(experimentId: string): void;
  onReview(experimentId: string, draftId: string, revision: number, actions: ReviewAction[]): void;
  onDelete(experimentId: string, sessionId?: string): void;
  onClose(): void;
}) {
  const { view } = props;
  const [note, setNote] = useState<NoteForm>(EMPTY_NOTE);
  const exp = view.experiments.find((e) => e.id === view.selected) ?? null;
  const kind = NOTE_KIND_CHOICES.find((k) => k.id === note.note_kind);
  const comparison = (exp?.variants.length ?? 0) >= 2;
  const noteReady = noteFormProblems(note).length === 0 && (!comparison || !!note.variant);
  const disabled = props.busy || !view.available || !exp || exp.data_deleted;
  return (
    <section className="hps-evidence" data-testid="evidence-panel" aria-label="실험 증거">
      <header>
        <strong>실험 증거</strong>
        <button type="button" onClick={props.onClose} aria-label="닫기">✕</button>
      </header>
      {view.notice && <p data-testid="evidence-notice">{view.notice}</p>}
      {props.error && <div className="hps-publish-error" role="alert" data-testid="evidence-error">{props.error}</div>}
      {props.done && <div className="hps-evidence-done" role="status">{props.done}</div>}
      {view.experiments.length > 0 && (
        <select value={view.selected ?? ""} onChange={(e) => props.onSelect(e.target.value)} aria-label="실험 고르기" data-testid="evidence-experiment">
          {view.experiments.map((e) => (
            <option key={e.id} value={e.id}>{e.week}주차 · {e.question}{e.data_deleted ? " (기록 지움)" : ""}</option>
          ))}
        </select>
      )}
      {exp && (
        <>
          <div className="hps-evidence-summary" data-testid="evidence-summary">
            참가 세션 {view.sessions.length}개 · 메모 {view.notes.length}개
            {view.returns.status === "not_measured" ? (
              <div data-testid="evidence-returns">다시 온 횟수: 측정하지 않음 (공개할 때 &lsquo;다시 와서 쓰는지 볼래요&rsquo;를 고르지 않았어요)</div>
            ) : (
              <div data-testid="evidence-returns">
                다시 온 기기:{" "}
                {view.returns.devices.filter((d) => d.return_count > 0).map((d) => `${d.pseudonym.slice(3, 9)} ${d.return_count}번 (간격 ${d.intervals_ms.map(days).join(", ")})`).join(" · ") || "아직 없음"}
                <div className="hps-publish-note">기기 기준이에요. 사람 수가 아니에요.</div>
              </div>
            )}
            {view.bursts.some((b) => b.flagged) && <div className="hps-publish-error" data-testid="evidence-burst">한 링크에서 한 시간에 세션이 너무 많이 열렸어요. 같은 사람이 여러 번 열었을 수 있어요.</div>}
          </div>

          {comparison && (
            <table className="hps-evidence-variants" data-testid="evidence-variants">
              <thead>
                <tr><th>비교 대상</th><th>세션</th><th>메모</th><th>과제 (시작/마침)</th></tr>
              </thead>
              <tbody>
                {view.variants.map((v) => (
                  <tr key={v.variant}>
                    <td>{v.variant}{v.kind === "alternative" ? ` (${v.subject})` : ""}</td>
                    <td>{v.sessions}</td>
                    <td>{v.notes}</td>
                    <td>{Object.entries(v.tasks).map(([k, t]) => `${k} ${t.started}/${t.completed}`).join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="hps-evidence-drafts">
            <div className="hps-evidence-row">
              <strong>정리</strong>
              <button type="button" disabled={disabled} data-testid="evidence-make-draft" onClick={() => props.onDraft(exp.id)}>기록에서 초안 만들기</button>
            </div>
            {view.drafts.length === 0 && <p className="hps-publish-note">아직 초안이 없어요. 초안은 기록을 읽어서 만들고, 근거 없는 문장은 저장되지 않아요.</p>}
            {view.drafts.map((d) => (
              <div key={d.id} data-testid="evidence-draft" data-draft={d.id} data-revision={d.revision}>
                {(["observation", "interpretation", "assumption", "next_experiment"] as const).map((section) => {
                  const items = d.items.filter((i) => i.section === section);
                  if (!items.length) return null;
                  return (
                    <div key={section}>
                      <div className="hps-evidence-section">{SECTION_LABEL[section]}</div>
                      <ul>
                        {items.map((it) => (
                          <Claim key={it.id} view={view} item={it} busy={disabled} onReview={(a) => props.onReview(exp.id, d.id, d.revision, [a])} />
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <details className="hps-evidence-note" data-testid="evidence-note-form">
            <summary>기록 남기기</summary>
            <select value={note.note_kind} onChange={(e) => setNote({ ...note, note_kind: e.target.value })} aria-label="기록 종류">
              <option value="">기록 종류 고르기</option>
              {NOTE_KIND_CHOICES.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <textarea value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} placeholder="본 것 · 들은 말을 그대로 적어 주세요" aria-label="내용" rows={3} />
            <input value={note.who} onChange={(e) => setNote({ ...note, who: e.target.value })} placeholder={kind?.who ?? "누가"} aria-label="누가" />
            <input value={note.when} onChange={(e) => setNote({ ...note, when: e.target.value })} placeholder="언제 (예: 10월 1일 오후 2시)" aria-label="언제" />
            <input value={note.where} onChange={(e) => setNote({ ...note, where: e.target.value })} placeholder={kind?.where ?? "어떤 상황"} aria-label="어떤 상황" />
            {note.note_kind === "external_source" && <input value={note.locator ?? ""} onChange={(e) => setNote({ ...note, locator: e.target.value })} placeholder="어느 부분인지 (쪽, 주소)" aria-label="자료 위치" />}
            {comparison && (
              <select value={note.variant ?? ""} onChange={(e) => setNote({ ...note, variant: e.target.value || undefined })} aria-label="비교 대상">
                <option value="">어느 쪽에 대한 기록인가요</option>
                {exp.variants.map((v) => <option key={v.id} value={v.id}>{v.id}{v.alternative ? ` (${v.alternative})` : ""}</option>)}
              </select>
            )}
            <div role="radiogroup" aria-label="실제로 있었던 일인가요" className="hps-publish-expiry">
              {SOURCE_STATE_CHOICES.map((s) => (
                <label key={s.id}><input type="radio" name="evidence-source-state" checked={note.source_state === s.id} onChange={() => setNote({ ...note, source_state: s.id })} /> {s.label}</label>
              ))}
            </div>
            <button type="button" disabled={disabled || !noteReady} data-testid="evidence-note-save" onClick={() => { props.onNote(exp.id, note); setNote(EMPTY_NOTE); }}>저장</button>
          </details>

          <details className="hps-evidence-records">
            <summary>원래 기록 보기 · 지우기</summary>
            <ul>
              {view.sessions.map((s) => (
                <li key={s.session_id} data-testid="evidence-session" data-session={s.session_id}>
                  참가 세션 {s.session_id.slice(3, 9)} · {time(s.at)} · 화면 {s.pages} · 누름 {s.clicks}
                  {Object.entries(s.tasks).map(([k, t]) => ` · ${k} ${t.completed ? "마침" : "시작만 함"}`).join("")}
                  {s.unnamed ? <span data-testid="evidence-session-unnamed"> · 선언하지 않은 과제 이름 {s.unnamed}개는 이름 없이 기록했어요</span> : null}
                  <button type="button" disabled={disabled} data-testid="evidence-delete-session" onClick={() => props.onDelete(exp.id, s.session_id)}>이 세션 지우기</button>
                </li>
              ))}
              {view.notes.map((n) => (
                <li key={n.id} data-testid="evidence-note">{NOTE_KIND_CHOICES.find((k) => k.id === n.note_kind)?.label ?? n.note_kind}: {n.text}</li>
              ))}
            </ul>
            <button type="button" disabled={disabled} data-testid="evidence-delete-experiment" onClick={() => props.onDelete(exp.id)}>이 실험의 기록 전부 지우기</button>
          </details>
        </>
      )}
    </section>
  );
}
