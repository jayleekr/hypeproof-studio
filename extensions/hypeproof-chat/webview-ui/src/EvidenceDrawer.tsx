import { useState } from "react";
import {
  EVIDENCE_TYPE_LABELS,
  PROVENANCE_FIELDS,
  SOURCE_KIND_LABELS,
  AMBER_STATES,
  SOURCE_STATE_LABELS,
  UNRECORDED,
  beforeAfterOf,
  rowTitle,
  filterBySourceKind,
  groupByEvidenceType,
  normalizeSourceState,
  partitionBySourceState,
  provenanceLine,
  shortRevision,
  sourceStateLabel,
  type EvidenceRowView,
} from "./evidenceDrawerLogic";
import type { SourceKind } from "../../../../worker/src/lib/measurement-core/learning-events.ts";

/**
 * Area D — Evidence drawer (SX-17·18·20·22·23).
 *
 * It keeps three things.
 *   1. **Closed by default.** It does not open automatically when work starts (SX-17
 *      negative condition). `open` is decided by the host from the stage `ui`. The
 *      webview never opens itself.
 *   2. **No interpretation.** It only shows what happened. Interpretation is the E
 *      retrospective and the F change record.
 *   3. **No score.** It draws no count, no progress rate and no grade (SX-59).
 *
 * The gate is not recomputed here — `verification` is a value the host sent.
 */
export interface EvidenceDrawerProps {
  open: boolean;
  rows: EvidenceRowView[];
  verification: {
    state: string;
    source_state: string;
    line: string;
    previous?: { event_id: string; criterion_ref?: string; artifact_after?: string; source_state: string };
  };
  /** Form submit. The host's `learningEventRequest` fills in actor and context. */
  onSubmit: (draft: { kind: string } & Record<string, unknown>) => void;
  onToggle: (open: boolean) => void;
  /**
   * The state where the coach offered alternatives and the student picked one (SX-23).
   *
   * Without it the reason form is **not drawn.** In the `/2` schema `decision_revised`
   * requires `decision{from,to}` and a non-empty `evidence_refs[]`, so taking only a
   * reason with nothing picked builds an event that cannot be stored. Better to draw no
   * form at all than one that fails when pressed.
   */
  pendingDecision?: { from: string; to: string; evidenceRefs: string[] } | null;
}

export function EvidenceDrawer({ open, rows, verification, onSubmit, onToggle, pendingDecision = null }: EvidenceDrawerProps) {
  const [criterion, setCriterion] = useState("");
  const [reason, setReason] = useState("");
  const [quote, setQuote] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("interview");
  const [provenance, setProvenance] = useState<{ who: string; when: string; where: string }>({ who: "", when: "", where: "" });
  // SX-46 — the default is `unverified`. If it started at "really happened" before the
  // student picks anything, every record where nothing was picked becomes an achievement.
  const [sourceState, setSourceState] = useState<string>("unverified");
  const [filter, setFilter] = useState<SourceKind | null>(null);

  const visible = filterBySourceKind(rows, filter);
  const groups = groupByEvidenceType(visible).filter((g) => g.rows.length > 0);

  return (
    <details className="hp-evidence" open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>근거 · 기대 조건 · 전후 · 출처</summary>

      {/* SX-15 — the re-confirmation line. Draws the sentence the host computed and sent, verbatim. */}
      <p className="hp-evidence-verify">{verification.line}</p>
      {/* AE-37 — even when a re-confirmation becomes necessary, **the previous
          confirmation is not erased.** It is a confirmation the student actually did,
          and erasing it makes it never have happened. */}
      {verification.previous && (
        <p className="hp-evidence-previous">
          이전에 확인한 것: {shortRevision(verification.previous.artifact_after ?? "")} 판
        </p>
      )}

      {/* SX-16 — before/after view. Opens the AI draft, the student's revision and the expected condition of that moment together. */}
      {beforeAfterOf(rows).map((pair) => (
        <details key={pair.id} className="hp-evidence-diff">
          <summary>변경 전후 보기</summary>
          {pair.criterionText ? (
            <p className="hp-evidence-diff-criterion">그때의 기대 조건: {pair.criterionText}</p>
          ) : (
            <p className="hp-evidence-diff-criterion">그때 적어 둔 기대 조건이 없어요</p>
          )}
          <div className="hp-evidence-compare">
            <section>
              <h5>AI 초안</h5>
              {pair.before ? (
                <>
                  <pre>{pair.before.text || "본문 없음"}</pre>
                  <small>{shortRevision(pair.before.sha256)} 판</small>
                </>
              ) : (
                // Do not build an empty comparison (SX-16 negative condition).
                <p className="hp-evidence-diff-note">{pair.note}</p>
              )}
            </section>
            <section>
              <h5>내가 바꾼 것</h5>
              <pre>{pair.after.text || "본문 없음"}</pre>
              <small>{shortRevision(pair.after.sha256)} 판</small>
            </section>
          </div>
        </details>
      ))}

      <form
        className="hp-evidence-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!criterion.trim()) return;
          onSubmit({ kind: "criterion_set", student_text: criterion });
          setCriterion("");
        }}
      >
        <label htmlFor="hp-criterion">어떤 결과여야 맞다고 볼까요</label>
        <textarea
          id="hp-criterion"
          value={criterion}
          maxLength={2000}
          placeholder="예: 버튼을 누르면 내 이름이 화면에 보인다"
          onChange={(e) => setCriterion(e.target.value)}
        />
        <button type="submit" disabled={!criterion.trim()}>기대 조건 남기기</button>
      </form>

      {pendingDecision && (
        <form
          className="hp-evidence-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reason.trim()) return;
            onSubmit({
              kind: "decision_revised",
              student_text: reason,
              decision: { from: pendingDecision.from, to: pendingDecision.to },
              evidence_refs: pendingDecision.evidenceRefs,
            });
            setReason("");
          }}
        >
          <label htmlFor="hp-reason">이걸 고른 이유 (한 줄이면 충분해요)</label>
          <input
            id="hp-reason"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="submit" disabled={!reason.trim()}>이유 남기기</button>
        </form>
      )}

      <form
        className="hp-evidence-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!quote.trim()) return;
          onSubmit({
            kind: "external_feedback_received",
            student_text: quote,
            source_kind: sourceKind,
            // A field left empty is **recorded** as "not recorded". We invent nothing
            // (SX-20), and we do not send an empty string and get the whole batch
            // rejected either.
            provenance: {
              who: provenance.who.trim() || UNRECORDED,
              when: provenance.when.trim() || UNRECORDED,
              where: provenance.where.trim() || UNRECORDED,
            },
            // Exactly what the student picked. `real` is never filled in as a default (SX-46).
            source_state: sourceState,
          });
          setQuote("");
          setProvenance({ who: "", when: "", where: "" });
        }}
      >
        <label htmlFor="hp-quote">다른 사람이 한 말을 그대로 적어요</label>
        <textarea id="hp-quote" value={quote} maxLength={2000} onChange={(e) => setQuote(e.target.value)} />
        <label htmlFor="hp-source-kind">어디서 온 것인가요</label>
        <select id="hp-source-kind" value={sourceKind} onChange={(e) => setSourceKind(e.target.value as SourceKind)}>
          {(Object.keys(SOURCE_KIND_LABELS) as SourceKind[]).map((kind) => (
            <option key={kind} value={kind}>{SOURCE_KIND_LABELS[kind]}</option>
          ))}
        </select>
        {/* SX-22 — each kind needs different fields. Left empty it stays as "source not
            recorded", and we do not fill it in by guessing (SX-20 negative condition). */}
        {PROVENANCE_FIELDS[sourceKind].map((field) => (
          <label key={field.key}>
            {field.label}
            <input
              value={provenance[field.key]}
              onChange={(e) => setProvenance((p) => ({ ...p, [field.key]: e.target.value }))}
            />
          </label>
        ))}
        <label htmlFor="hp-source-state">이건 실제로 있었던 일인가요</label>
        <select id="hp-source-state" value={sourceState} onChange={(e) => setSourceState(e.target.value)}>
          {Object.keys(SOURCE_STATE_LABELS).map((state) => (
            <option key={state} value={state}>{SOURCE_STATE_LABELS[state]}</option>
          ))}
        </select>
        {sourceState === "real" && (
          // SX-46 negative condition — "real" without a source is not stored. Better to
          // say so before they press than to reject them after they press.
          <p className="hp-evidence-hint">"실제로 있었던 일" 로 남기려면 누가·언제·어디서를 적어 주세요.</p>
        )}
        <button type="submit" disabled={!quote.trim()}>들은 말 남기기</button>
      </form>

      <label className="hp-evidence-filter" htmlFor="hp-evidence-filter">
        종류로 추리기
        <select
          id="hp-evidence-filter"
          value={filter ?? ""}
          onChange={(e) => setFilter(e.target.value === "" ? null : (e.target.value as SourceKind))}
        >
          <option value="">모두 보기</option>
          {(Object.keys(SOURCE_KIND_LABELS) as SourceKind[]).map((kind) => (
            <option key={kind} value={kind}>{SOURCE_KIND_LABELS[kind]}</option>
          ))}
        </select>
      </label>

      {groups.length === 0 ? (
        <p className="hp-evidence-empty">아직 남긴 근거가 없어요. 위에 한 줄만 적어도 여기 쌓입니다.</p>
      ) : (
        groups.map((group) => {
          // SX-46 — even within one type, **what really happened** is not mixed with the
          // rest. What this split prevents is the week-4 fake payment reading as revenue.
          const { real, aside } = partitionBySourceState(group.rows);
          return (
            <section key={group.type ?? "untyped"} className="hp-evidence-group">
              <h4>{group.label}</h4>
              {real.length > 0 && <ol>{real.map(renderRow)}</ol>}
              {aside.length > 0 && (
                <div className="hp-evidence-aside">
                  <h5>아직 실제로 확인되지 않은 것</h5>
                  <ol>{aside.map(renderRow)}</ol>
                </div>
              )}
            </section>
          );
        })
      )}
    </details>
  );
}

/**
 * One evidence row. The real column and the everything-else column are drawn by the
 * **same function** — writing two copies means dropping the label on one side, and that
 * is the "unlabeled external reaction" SX-21 forbids.
 */
function renderRow(row: EvidenceRowView) {
  // **Normalize once and let all three use that value.** Originally `amber` and
  // `data-source-state` used the raw value and only the label used the normalized one.
  // If a path that skips the host appears and an unknown string comes in, the markup says
  // that string while the label says "not verified yet" — the same row reading two ways
  // is exactly what SX-21 is there to prevent.
  const state = normalizeSourceState(row.source_state);
  const amber = AMBER_STATES.includes(state);
  return (
    <li
      key={row.id}
      className={amber ? "hp-evidence-row hp-amber" : "hp-evidence-row"}
      // Color alone loses the distinction for a color-blind student and in black-and-white print. Leave it in the markup too.
      data-source-state={state}
    >
      <p className="hp-evidence-text">
        {(() => {
          const title = rowTitle(row);
          // A kind name is not the student's sentence. Marked so, rather than
          // printed as if they had written it (SX-12 rule 5).
          return title.student ? title.text : <span className="hp-evidence-kindonly">{title.text}</span>;
        })()}
      </p>
      <p className="hp-evidence-meta">
        <span>{SOURCE_KIND_LABELS[row.source_kind] ?? SOURCE_KIND_LABELS.none}</span>
        <span>{provenanceLine(row)}</span>
        <span className="hp-evidence-state">{sourceStateLabel(state)}</span>
      </p>
      {row.adopted_from && <p className="hp-evidence-adopted">코치가 제안한 문장을 받아서 적었어요</p>}
    </li>
  );
}

/** Re-exported so the label table can be used outside the screen too (auditors, tests). */
export { EVIDENCE_TYPE_LABELS };
