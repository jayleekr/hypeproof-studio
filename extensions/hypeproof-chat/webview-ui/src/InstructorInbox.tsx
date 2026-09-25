import type { InboxCard, InboxView } from "../../src/classroomInbox";
import { canUndoImport, type LastImport } from "./draftImport";

/**
 * #751 U2 — notices and materials an instructor sent to THIS learner. The same component on both surfaces (the coach rail
 * of the work screen, and the "이어서 하기" entry card), fed by the same host message that the host reads from disk.
 *
 * What it must never do, because the learner's own work is the centre of the screen:
 *   - no modal, no auto-open, no auto-scroll, no second Primary (SX-04). Closed by default; "new" is said in WORDS.
 *   - text is drawn as text. No markdown, no HTML: a `<script>` or a `[link](javascript:…)` shows as the characters typed.
 *   - a link is a label and an address in plain characters, plus two explicit buttons. Nothing opens, downloads or is sent
 *     to the AI unless the learner presses one; the host checks the link again before opening it.
 *   - it writes nothing into the input, the conversation or the workspace — with ONE exception the learner makes themselves:
 *     `초안에 가져오기` on a prompt card (#751 U3) appends that text to their own draft. It never sends and never replaces.
 *   - a lesson SETTING card is a notice that the next question runs under another lesson version. It claims no more than the
 *     device knows: "다음 질문부터" while pending, "바뀌었습니다" once this device switched. It never says the AI already used it.
 * Opening a card is remembered on this device only (to stop saying "new"). It is not reported to anyone.
 */
const KIND_LABEL: Record<string, string> = { notice: "공지", material: "자료", prompt: "프롬프트", setting: "수업 설정" };
/** The draft lives in ChatPanel; this component only asks. Absent on the entry page, which has no composer — and then no button. */
export interface PromptImport { onImport: (card: InboxCard) => void; onUndo: () => void; disabled: boolean; draft: string; last: LastImport | null; note: string | null }
export function InstructorInbox(props: { inbox: InboxView | null; post: (msg: { type: "inboxOpen"; objectId: string; generation: number } | { type: "inboxLink"; objectId: string; url: string; generation: number; action: "open" | "copy" }) => void; quiet?: boolean; promptImport?: PromptImport }) {
  const inbox = props.inbox;
  if (!inbox || !inbox.cards.length) return null;
  const time = (ms: number) => { try { return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  return (
    <details className={props.quiet ? "hp-inbox hp-inbox-quiet" : "hp-inbox hp-rail-lesson"} data-inbox-generation={inbox.generation}>
      <summary>강사가 보낸 공지·자료 {inbox.cards.filter(c => !c.withdrawn).length}개{inbox.unread ? ` · 새 자료 ${inbox.unread}개` : ""}{inbox.ended ? " · 끝난 수업의 자료" : inbox.offline ? " · 수업 연결 확인 전" : ""}</summary>
      <p className="hp-rail-lesson-note">강사가 보낸 글입니다. 내 과제·대화·파일은 바뀌지 않았고, 읽지 않아도 작업은 계속할 수 있습니다.</p>
      {inbox.offline && <p className="hp-rail-lesson-note" data-inbox-offline="">지금은 수업 연결이 확인되지 않았습니다. 이미 받은 자료는 그대로 볼 수 있고, 그 뒤에 강사가 고치거나 회수한 내용은 다시 연결되면 반영됩니다.</p>}
      <ul className="hp-inbox-list">
        {inbox.cards.map(card => (
          <li key={card.object_id} className="hp-inbox-card" data-inbox-object={card.object_id} data-inbox-revision={card.revision}>
            {card.withdrawn ? <p className="hp-inbox-meta">강사가 회수한 자료입니다. 내용은 더 볼 수 없습니다. 내가 따로 적어 둔 글과 파일은 그대로입니다.</p>
              : card.unreadable ? <p className="hp-inbox-meta">이 자료를 읽을 수 없습니다. 강사에게 다시 보내 달라고 요청하세요.</p>
              : <details onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open && card.is_new) props.post({ type: "inboxOpen", objectId: card.object_id, generation: inbox.generation }); }}>
                  <summary><span className="hp-inbox-title">{card.title}</span> <span className="hp-inbox-meta">강사가 보냄 · {KIND_LABEL[card.kind] ?? "자료"} · {time(card.received_at)}{card.revision > 1 ? ` · 수정됨 (${card.revision}번째 판)` : ""}{card.is_new ? " · 새 자료" : ""}</span></summary>
                  <p className="hp-inbox-body">{card.body}</p>
                  {card.kind === "setting" && <p className="hp-inbox-meta" data-inbox-setting={card.setting ?? "pending"}>{card.setting === "bound" ? "이 수업 설정으로 바뀌었습니다. 대화·입력·파일은 그대로입니다." : "다음 질문을 보낼 때부터 적용됩니다. 지금 진행 중인 답변은 그대로 끝나고, 대화·입력·파일은 바뀌지 않습니다."}</p>}
                  {card.kind === "prompt" && props.promptImport && (() => { const pi = props.promptImport!, mine = pi.last?.object_id === card.object_id && pi.last.revision === card.revision, undo = mine && canUndoImport(pi.draft, pi.last); return (
                    <div className="hp-inbox-import">
                      <button type="button" className="hp-cta-quiet" data-inbox-import="" disabled={pi.disabled} onClick={() => pi.onImport(card)}>초안에 가져오기</button>
                      <span className="hp-inbox-meta"> 입력창의 글 끝에 덧붙입니다. 보내지는 않습니다.</span>
                      {mine && <p className="hp-inbox-meta" role="status" data-inbox-imported="">입력창 끝에 덧붙였습니다. <button type="button" className="hp-cta-quiet" data-inbox-undo="" disabled={!undo} onClick={pi.onUndo}>되돌리기</button>{!undo && " 그 뒤에 고친 글이 있어 자동으로 되돌리지 않습니다."}</p>}
                      {pi.note && <p className="hp-inbox-meta" role="status">{pi.note}</p>}
                    </div>); })()}
                  {card.links.length > 0 && <ul className="hp-inbox-links" aria-label="강사가 함께 보낸 링크">
                    {card.links.map(link => <li key={link.url}>
                      <span className="hp-inbox-link-label">{link.label}</span> <span className="hp-inbox-link-url">{link.url}</span>
                      <button type="button" className="hp-cta-quiet" onClick={() => props.post({ type: "inboxLink", objectId: card.object_id, url: link.url, generation: inbox.generation, action: "open" })}>브라우저에서 열기</button>
                      <button type="button" className="hp-cta-quiet" onClick={() => props.post({ type: "inboxLink", objectId: card.object_id, url: link.url, generation: inbox.generation, action: "copy" })}>주소 복사</button>
                    </li>)}
                  </ul>}
                </details>}
          </li>
        ))}
      </ul>
    </details>
  );
}
