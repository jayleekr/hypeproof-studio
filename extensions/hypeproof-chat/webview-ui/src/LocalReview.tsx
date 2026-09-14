import { useEffect, useState } from 'react';
import type { LocalReviewRequest, LocalReviewState, TaskCard } from '../../src/localReviewProtocol';
import { DEFAULT_CAPABILITY_MODEL } from '../../../../worker/src/lib/measurement-core/capability-models';
import './localReview.css';
import { postLocalReview } from "./vscode";
const bridge = { postMessage: postLocalReview };
export function LocalReview() {
  const [state, setState] = useState<LocalReviewState>({ type: 'localReviewState', tasks: [], storage: '' });
  const [busy, setBusy] = useState(false);
  const [include, setInclude] = useState(false);
  const send = (m: LocalReviewRequest) => { setBusy(true); bridge.postMessage(m); };
  useEffect(() => {
    const listener = (event: MessageEvent<LocalReviewState>) => { if (event.data?.type === 'localReviewState') { setState(event.data); setBusy(false); } };
    window.addEventListener('message', listener); bridge.postMessage({ type: 'localReview', action: 'load' });
    return () => window.removeEventListener('message', listener);
  }, []);
  return <main className="local-review">
    <header><p className="eyebrow">PERSONAL WORK RECORD</p><h1>My task reviews</h1><p>Keep evidence, examine your decisions, and choose what to submit.</p></header>
    <aside className="record-policy">Local only · Automatic capture off · No automatic expiry · 256 MiB provisional limit
      <details><summary>Storage and scope</summary><p>{state.storage}</p><p>Select one Claude Code or Codex JSONL transcript from the open project. Only visible user and assistant messages are imported. Known secret patterns are removed; review the text before sharing.</p></details>
    </aside>
    <div className="review-toolbar"><button disabled={busy} onClick={() => send({ type: 'localReview', action: 'import', host: 'claude-code' })}>Import Claude task</button><button disabled={busy} onClick={() => send({ type: 'localReview', action: 'import', host: 'codex' })}>Import Codex task</button><button disabled={busy} onClick={() => send({ type: 'localReview', action: 'load' })}>Refresh records</button></div>
    {busy && <p role="status">Saving or reading local records…</p>}{state.error && <p role="alert">{state.error}</p>}{state.notice && <p role="status">{state.notice}</p>}
    <nav aria-label="Saved tasks">{state.tasks.map(t => <button key={t.id} aria-current={t.id === state.card?.task.id ? 'page' : undefined} disabled={busy} onClick={() => send({ type: 'localReview', action: 'open', task: t.id })}>{t.project.split('/').pop()} · {t.status} · {t.id.slice(-8)}</button>)}</nav>
    {!state.card && !state.error && <p>Import a task to start. A receipt records local acceptance, not task completion or capability growth.</p>}
    {state.card && <TaskReview key={state.card.task.id} card={state.card} busy={busy} send={send} />}
    {state.card && <section><h2>Local submission</h2><p>A submission can include unfinished work. Review decisions and purpose are included; source messages are optional.</p>
      <label><input type="checkbox" checked={include} onChange={e => { setInclude(e.target.checked); setState(s => ({ ...s, preview: undefined })); }} /> Include imported message text</label>
      <button disabled={busy} onClick={() => send({ type: 'localReview', action: 'preview', task: state.card!.task.id, includeEvidence: include })}>Preview submission</button>
      {state.preview && <div className="submission-preview"><h3>Destination: local inbox</h3><p>{state.preview.payload.observations.length} messages · {state.preview.payload.reviews.length} review revisions · {state.preview.payload.excluded.length} excluded items</p><p>Revision {state.preview.payload.revision} · <code>{state.preview.digest}</code></p><details><summary>Inspect exact included and excluded data</summary><pre>{JSON.stringify(state.preview.payload, null, 2)}</pre></details><button disabled={busy} onClick={() => send({ type: 'localReview', action: 'submit', task: state.card!.task.id, digest: state.preview!.digest })}>Confirm local submission</button></div>}
      {state.card.receipts.map(r => <article className="receipt" key={r.revision}><h3>Accepted locally · revision {r.revision}</h3><p>{r.id} · {new Date(r.accepted_at).toLocaleString()}</p><code>{r.digest}</code><p>Destination: {r.destination} · Stored content verified</p></article>)}
    </section>}
  </main>;
}
function TaskReview({ card, busy, send }: { card: TaskCard; busy: boolean; send: (m: LocalReviewRequest) => void }) {
  const [purpose, setPurpose] = useState(card.task.purpose?.text || '');
  return <>
    <section><h2>Task purpose</h2><p>{card.source.host} · {card.source.evidence} · Purpose: {card.task.purpose_state}</p><label>Purpose<textarea value={purpose} maxLength={2000} onChange={e => setPurpose(e.target.value)} /></label><button disabled={busy || !purpose.trim()} onClick={() => send({ type: 'localReview', action: 'purpose', task: card.task.id, text: purpose })}>Save and confirm purpose</button>
      <details><summary>Observation limits and provenance</summary><ul>{card.source.limitations.map(l => <li key={l}>{l}</li>)}</ul><p>Exclusions: {card.source.exclusions.join(', ') || 'No known secret pattern found; not an anonymity guarantee.'}</p><p>Source digest: <code>{card.source.digest}</code></p><p>Model: {card.interpretation.versions.capability_model.id} · Definitions: {card.interpretation.versions.definition_revision}</p></details>
    </section>
    <section><h2>Source evidence</h2><p>These are recorded statements. Assistant claims do not establish executed checks or independent human behavior.</p>{card.observations.map(o => <details key={o.key}><summary>{o.event.kind === 'user' ? 'User message' : 'AI message'} · {o.event.id} · {new Date(o.event.at).toLocaleString()}</summary><pre>{o.event.text}</pre></details>)}</section>
    <section><h2>Six capabilities</h2><p>Manual review · No AI assessment or score. Confirmation records your judgment about one item.</p><div className="capability-grid">{DEFAULT_CAPABILITY_MODEL.capabilities.map(c => <Finding key={c.key} card={card} capability={c.key} label={c.key[0] + c.key.slice(1).toLowerCase()} busy={busy} send={send} />)}</div></section>
    <section><h2>Results and next check</h2><p>Artifacts and executed verification: not captured by this message import. Task outcome remains {card.task.status}. Record limits or your next check in a capability review note.</p><button className="danger" disabled={busy} onClick={() => send({ type: 'localReview', action: 'delete', task: card.task.id })}>Delete local task</button></section>
  </>;
}
function Finding({ card, capability, label, busy, send }: { card: TaskCard; capability: string; label: string; busy: boolean; send: (m: LocalReviewRequest) => void }) {
  const reviews = card.reviews.filter(r => r.capability === capability);
  const last = reviews[reviews.length - 1];
  const [text, setText] = useState(last?.corrected_claim || last?.note || '');
  const [decision, setDecision] = useState<'confirm' | 'correct' | 'dispute' | 'exclude' | 'hold'>('correct');
  return <article className="capability"><h3>{label}</h3><p>{last ? `Human review: ${last.action}` : 'Insufficient evidence · unreviewed'}</p><p>{last?.corrected_claim || last?.note || card.interpretation.findings.find(f => f.capability === capability)?.claim}</p>
    <label>{label} judgment and evidence references<textarea maxLength={2000} value={text} onChange={e => setText(e.target.value)} placeholder="Describe your judgment, cite a message ID, or explain what remains unknown." /></label>
    <label>{label} review decision<select value={decision} onChange={e => setDecision(e.target.value as typeof decision)}><option value="correct">Correct / add judgment</option><option value="confirm">Confirm</option><option value="dispute">Dispute</option><option value="exclude">Exclude from submission</option><option value="hold">Hold</option></select></label>
    <button disabled={busy || (decision === 'correct' && !text.trim())} onClick={() => send({ type: 'localReview', action: 'review', task: card.task.id, capability, decision, text })}>Save {label} review</button>
    {reviews.length > 0 && <details><summary>{reviews.length} preserved review revision(s)</summary>{reviews.map(r => <p key={r.key}>{r.action}: {r.corrected_claim || r.note || 'No note'} · {new Date(r.at).toLocaleString()}</p>)}</details>}
  </article>;
}
