import { useEffect, useRef, useState } from "react";
import { HELP_DURATIONS, REASON_TEXT, type HelpCard, type HelpDraft, type HelpView } from "../../src/classroomHelp";

/**
 * #751 native help — the learner asks the instructor of THIS class for help, from the coach rail (SX-05/06), closed by
 * default, no Primary (SX-04), no modal: the learner's work stays the centre of the screen (AT-39).
 *
 *   - The recipient is shown, never typed. The learner writes their own question and may add ONE turn they pick. Nothing is
 *     attached by default and consent is never pre-ticked (DES-09).
 *   - The preview shows exactly what the Service will store, to whom, until when, and how to withdraw — then consent + send.
 *   - Instructor feedback is drawn here as text only. It is not put into the chat, the input or the model's context.
 *   - "강사 답변 도착" is not "해결": only the learner's own "해결됐어요" resolves. A failed read says so; it never shows zero.
 * Every message to the host names the key (learner in class) this view was drawn under; the host ignores a stale one.
 */
type Post = (msg: any) => void;
const time = (ms: number | null) => { if (!ms) return ""; try { return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
const DURATION_LABEL: Record<number, string> = { 30: "30분", 60: "1시간", 120: "2시간" };

function Card(props: { card: HelpCard; k: string; post: Post; history?: boolean }) {
  const c = props.card;
  return (
    <li className="hp-inbox-card hp-help-card" data-help-share={c.id} data-help-status={c.status} data-help-revision={c.revision}>
      <p className="hp-inbox-meta"><span className="hp-help-status">{c.label}</span> · 보낸 시각 {time(c.created_at * 1000)} · {time(c.expires_at * 1000)}까지 공유</p>
      <details><summary>보낸 내용</summary>
        {c.content.map((f) => <div key={f.field}><p className="hp-inbox-meta">{f.label}</p><p className="hp-inbox-body" data-help-sent={f.field}>{f.text}</p></div>)}
      </details>
      {(c.feedback || c.next_action) && <div className="hp-help-feedback" data-help-feedback="">
        <p className="hp-inbox-meta">강사 피드백 (대화나 AI에게 자동으로 넘어가지 않습니다)</p>
        {c.feedback && <p className="hp-inbox-body" data-help-feedback-text="">{c.feedback}</p>}
        {c.next_action && <><p className="hp-inbox-meta">다음에 해 볼 것</p><p className="hp-inbox-body" data-help-next="">{c.next_action}</p></>}
      </div>}
      <div className="hp-help-actions">
        {c.can_confirm && !props.history && <button type="button" className="hp-cta-quiet" data-help-confirm="" onClick={() => props.post({ type: "helpConfirm", key: props.k, id: c.id, revision: c.revision })}>해결됐어요</button>}
        <button type="button" className="hp-cta-quiet" data-help-withdraw="" onClick={() => props.post({ type: "helpWithdraw", key: props.k, id: c.id })}>공유 철회</button>
      </div>
      {c.can_confirm && !props.history && <p className="hp-inbox-meta">아직 안 풀렸다면 누르지 않아도 됩니다. 강사는 내가 확인하기 전까지 해결로 보지 않습니다.</p>}
    </li>
  );
}

export function HelpRequest(props: { view: HelpView | null; post: Post }) {
  const v = props.view, key = v?.draft_key ?? null;
  const [draft, setDraft] = useState<HelpDraft | null>(null), [consent, setConsent] = useState(false), [open, setOpen] = useState(false);
  const drawnFor = useRef<string | null>(null), saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The local draft is (re)loaded only when the view is for another learner-in-class; typing is never overwritten by a refresh.
  useEffect(() => { if (!v) return; if (drawnFor.current !== key) { drawnFor.current = key; setDraft(v.draft); setConsent(false); } }, [v, key]);
  // A preview being made, sent or dropped is the host's decision about the draft (a sent question is cleared there): take it.
  // The form is hidden while a preview is open, so no typing can be lost here.
  const envSig = v?.envelope ? v.envelope.request_id + ":" + v.envelope.state : "";
  useEffect(() => { setConsent(false); if (v) setDraft(v.draft); }, [envSig]);
  // While open, read again now and then (the instructor's answer arrives without the learner doing anything).
  useEffect(() => { if (!open) return; props.post({ type: "helpRequest" }); const t = setInterval(() => { if (document.visibilityState !== "hidden") props.post({ type: "helpRequest" }); }, 15000); const stop = () => clearInterval(t); return stop; }, [open]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);
  if (!v) return null;
  const edit = (next: HelpDraft) => { setDraft(next); if (!key) return; if (saveTimer.current) clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => props.post({ type: "helpDraft", key, draft: { question: next.question, turnId: next.turnId, duration: next.duration } }), 400); };
  const a = v.availability, answered = v.current.filter((c) => c.status === "answered").length, e = v.envelope, d = draft ?? v.draft;
  const summary = `강사에게 도움 요청${answered ? ` · 강사 답변 ${answered}개 도착` : ""}${e && e.state !== "prepared" ? " · 보냈는지 확인 필요" : ""}`;
  return (
    <details className="hp-inbox hp-rail-lesson hp-help" data-help-key={key ?? ""} data-help-availability={a.state} onToggle={(ev) => setOpen((ev.currentTarget as HTMLDetailsElement).open)}>
      <summary>{summary}</summary>
      <p className="hp-rail-lesson-note">내 과제·대화·파일은 그대로입니다. 보내기 전에 받는 강사와 보낼 내용을 먼저 보여 드립니다.</p>
      {a.state === "unavailable" && <p className="hp-rail-lesson-note" data-help-unavailable={a.reason}>{REASON_TEXT[a.reason] ?? "지금은 앱에서 도움 요청을 보낼 수 없습니다. 강사에게 직접 알려 주세요."}</p>}
      {a.state === "unknown" && <p className="hp-rail-lesson-note" data-help-unknown="">받는 강사를 지금 확인할 수 없습니다(서버 응답 없음). 쓰던 질문은 이 기기에 남아 있고, 연결되면 다시 확인합니다.</p>}
      {a.state === "ready" && <p className="hp-inbox-meta" data-help-recipient={a.assignment.recipient_id}>받는 강사: {a.assignment.recipient_id} · 이번 수업에서 내 자리({a.assignment.seat_id})를 연결한 강사</p>}

      {key && !e && a.state !== "unavailable" && d && <div className="hp-help-form">
        <label className="hp-help-label">무엇이 막혔나요? (내가 직접 쓰는 질문)
          <textarea data-help-question="" rows={3} maxLength={8000} value={d.question} onChange={(ev) => edit({ ...d, question: ev.target.value })} placeholder="예: 예약 버튼을 눌러도 아무 일도 안 일어나요" />
        </label>
        <label className="hp-help-label">함께 보낼 대화 (선택)
          <select data-help-turn="" value={d.turnId ?? ""} onChange={(ev) => edit({ ...d, turnId: ev.target.value || null })}>
            <option value="">대화는 보내지 않음</option>
            {v.turns.map((t) => <option key={t.id} value={t.id}>{time(t.at)} · {t.text}</option>)}
          </select>
        </label>
        <label className="hp-help-label">강사가 볼 수 있는 기간
          <select data-help-duration="" value={d.duration} onChange={(ev) => edit({ ...d, duration: Number(ev.target.value) })}>
            {HELP_DURATIONS.map((m) => <option key={m} value={m}>{DURATION_LABEL[m]}</option>)}
          </select>
        </label>
        <button type="button" className="hp-cta-quiet" data-help-preview="" disabled={a.state !== "ready" || (!d.question.trim() && !d.turnId)} onClick={() => props.post({ type: "helpPreview", key, draft: { question: d.question, turnId: d.turnId, duration: d.duration } })}>보낼 내용 미리 보기</button>
      </div>}

      {key && e && e.state === "prepared" && <section className="hp-help-preview" data-help-envelope={e.request_id} aria-label="보내기 전 확인">
        <p className="hp-inbox-meta">받는 강사: <strong data-help-preview-recipient="">{e.recipient_id}</strong> · 이번 수업 · 내 자리 {e.seat_id}</p>
        <p className="hp-inbox-meta">아래 내용이 이 글자 그대로 저장됩니다. 비밀번호·키처럼 보이는 글자는 저장할 때 가려집니다.</p>
        {Object.entries(e.content).map(([field, text]) => <div key={field}><p className="hp-inbox-meta">{({ question: "내가 쓴 질문", prompt: "내가 AI에게 보낸 말", response: "AI의 답" } as Record<string, string>)[field] ?? field}</p><p className="hp-inbox-body" data-help-preview-field={field}>{text}</p></div>)}
        {e.truncated.length > 0 && <p className="hp-inbox-meta">길어서 앞부분 8,000자만 보냅니다.</p>}
        <p className="hp-inbox-meta" data-help-preview-expiry="">강사는 {time(e.expiry_estimate)}까지 볼 수 있습니다(수업 참여 기간이 먼저 끝나면 그때까지). 기간이 지나면 강사도 나도 더 열 수 없습니다.</p>
        <p className="hp-inbox-meta">보낸 뒤에도 여기의 ‘공유 철회’로 언제든 거둘 수 있고, 철회하면 강사는 더 열 수 없습니다. 강사가 이미 읽은 것은 되돌릴 수 없습니다.</p>
        <label className="hp-help-consent"><input type="checkbox" data-help-consent="" checked={consent} onChange={(ev) => setConsent(ev.target.checked)} /> 위 내용을 이 강사에게 보내는 데 동의합니다</label>
        <div className="hp-help-actions">
          <button type="button" className="hp-cta-quiet" data-help-send="" disabled={!consent} onClick={() => props.post({ type: "helpSend", key, requestId: e.request_id, consent })}>동의하고 보내기</button>
          <button type="button" className="hp-cta-quiet" data-help-cancel="" onClick={() => props.post({ type: "helpCancel", key })}>보내지 않기</button>
        </div>
      </section>}
      {key && e && e.state !== "prepared" && <section className="hp-help-preview" data-help-pending={e.request_id}>
        <p className="hp-inbox-meta">보낸 요청이 서버에 저장됐는지 아직 확인하지 못했습니다. 같은 요청으로 다시 확인하므로 두 번 보내지지 않습니다.</p>
        <div className="hp-help-actions">
          <button type="button" className="hp-cta-quiet" data-help-retry="" onClick={() => props.post({ type: "helpRetry", key })}>다시 확인</button>
          <button type="button" className="hp-cta-quiet" data-help-discard="" onClick={() => props.post({ type: "helpDiscard", key })}>보내지 않기(지우기)</button>
        </div>
      </section>}

      {v.note && <p className="hp-rail-lesson-note" role="status" data-help-note="">{v.note}</p>}
      {key && v.refresh.state === "failed" && <p className="hp-rail-lesson-note" data-help-stale="">지금 상태를 확인할 수 없습니다. 아래는 {time(v.refresh.at)}에 확인한 내용입니다.</p>}
      {key && v.refresh.state === "never" && a.state !== "unavailable" && <p className="hp-rail-lesson-note" data-help-stale="">보낸 요청 목록을 아직 확인하지 못했습니다.</p>}
      {key && v.refresh.state !== "never" && <>
        <p className="hp-inbox-meta">이번 수업에서 보낸 도움 요청 {v.current.length}개</p>
        <ul className="hp-inbox-list" data-help-current="">{v.current.map((c) => <Card key={c.id} card={c} k={key} post={props.post} />)}</ul>
        {v.history.length > 0 && <details data-help-history=""><summary>이전 수업에서 공유한 것 {v.history.length}개 (철회만 할 수 있음)</summary>
          <ul className="hp-inbox-list">{v.history.map((c) => <Card key={c.id} card={c} k={key} post={props.post} history />)}</ul>
        </details>}
      </>}
    </details>
  );
}
