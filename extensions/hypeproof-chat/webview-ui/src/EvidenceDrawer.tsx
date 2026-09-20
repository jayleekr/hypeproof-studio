import { useState } from "react";
import {
  EVIDENCE_TYPE_LABELS,
  PROVENANCE_FIELDS,
  SOURCE_KIND_LABELS,
  UNRECORDED,
  beforeAfterOf,
  decisionReason,
  filterBySourceKind,
  groupByEvidenceType,
  provenanceLine,
  shortRevision,
  type EvidenceRowView,
} from "./evidenceDrawerLogic";
import type { SourceKind } from "../../../../worker/src/lib/measurement-core/learning-events.ts";

/**
 * 영역 D — Evidence drawer (SX-17·18·20·22·23).
 *
 * 세 가지를 지킨다.
 *   1. **기본 닫힘.** 작업 시작 시 자동으로 열리지 않는다(SX-17 부정 조건).
 *      `open` 은 호스트가 단계 `ui` 를 보고 정한다. 웹뷰가 스스로 열지 않는다.
 *   2. **해석이 없다.** 무엇이 있었는지만 보여 준다. 해석은 E 회고와 F 변화 기록.
 *   3. **점수가 없다.** 개수·진행률·등급 어느 것도 그리지 않는다(SX-59).
 *
 * 게이트를 여기서 다시 계산하지 않는다 — `verification` 은 호스트가 보낸 값이다.
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
  /** 폼 제출. 호스트의 `learningEventRequest` 가 actor·context 를 채운다. */
  onSubmit: (draft: { kind: string } & Record<string, unknown>) => void;
  onToggle: (open: boolean) => void;
  /**
   * 코치가 대안을 제시했고 학생이 하나를 고른 상태 (SX-23).
   *
   * 없으면 이유 폼을 **그리지 않는다.** `decision_revised` 는 `/2` 스키마에서
   * `decision{from,to}` 와 비어 있지 않은 `evidence_refs[]` 를 요구하므로, 고른 것이
   * 없는 상태에서 이유만 받으면 저장할 수 없는 이벤트가 만들어진다. 누르면 실패하는
   * 폼을 그리느니 그리지 않는다.
   */
  pendingDecision?: { from: string; to: string; evidenceRefs: string[] } | null;
}

const SOURCE_STATE_LABELS: Record<string, string> = {
  real: "실제로 있었던 일",
  simulated: "가상으로 해 본 것",
  self_reported: "내가 그렇다고 적은 것",
  unverified: "아직 확인 안 됨",
};

export function EvidenceDrawer({ open, rows, verification, onSubmit, onToggle, pendingDecision = null }: EvidenceDrawerProps) {
  const [criterion, setCriterion] = useState("");
  const [reason, setReason] = useState("");
  const [quote, setQuote] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("interview");
  const [provenance, setProvenance] = useState<{ who: string; when: string; where: string }>({ who: "", when: "", where: "" });
  const [filter, setFilter] = useState<SourceKind | null>(null);

  const visible = filterBySourceKind(rows, filter);
  const groups = groupByEvidenceType(visible).filter((g) => g.rows.length > 0);

  return (
    <details className="hp-evidence" open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>근거 · 기대 조건 · 전후 · 출처</summary>

      {/* SX-15 — 재확인 줄. 호스트가 계산해 보낸 문장을 그대로 그린다. */}
      <p className="hp-evidence-verify">{verification.line}</p>
      {/* AE-37 — 재확인이 필요해져도 **이전 확인은 지우지 않는다.** 학생이 실제로
          한 확인이고, 지우면 없었던 일이 된다. */}
      {verification.previous && (
        <p className="hp-evidence-previous">
          이전에 확인한 것: {shortRevision(verification.previous.artifact_after ?? "")} 판
        </p>
      )}

      {/* SX-16 — 변경 전후 보기. AI 초안 · 학생 수정본 · 그때의 기대 조건을 함께 연다. */}
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
                // 빈 비교를 만들지 않는다(SX-16 부정 조건).
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
            // 비워 둔 칸은 "미기록" 으로 **기록한다**. 지어내지 않고(SX-20), 빈
            // 문자열로 보내 배치 전체를 거절당하지도 않는다.
            provenance: {
              who: provenance.who.trim() || UNRECORDED,
              when: provenance.when.trim() || UNRECORDED,
              where: provenance.where.trim() || UNRECORDED,
            },
            // 학생이 고르기 전까지 채우지 않는다. `real` 을 기본으로 넣지 않는다(SX-46).
            source_state: "unverified",
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
        {/* SX-22 — 종류마다 필요한 칸이 다르다. 비워 두면 "출처 미기록" 으로 남고,
            추정으로 채우지 않는다(SX-20 부정 조건). */}
        {PROVENANCE_FIELDS[sourceKind].map((field) => (
          <label key={field.key}>
            {field.label}
            <input
              value={provenance[field.key]}
              onChange={(e) => setProvenance((p) => ({ ...p, [field.key]: e.target.value }))}
            />
          </label>
        ))}
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
        groups.map((group) => (
          <section key={group.type ?? "untyped"} className="hp-evidence-group">
            <h4>{group.label}</h4>
            <ol>
              {group.rows.map((row) => (
                <li key={row.id} className="hp-evidence-row">
                  <p className="hp-evidence-text">
                    {row.evidence_type === "decision" ? decisionReason(row) : row.text}
                  </p>
                  <p className="hp-evidence-meta">
                    <span>{SOURCE_KIND_LABELS[row.source_kind] ?? SOURCE_KIND_LABELS.none}</span>
                    <span>{provenanceLine(row)}</span>
                    <span>{SOURCE_STATE_LABELS[row.source_state] ?? SOURCE_STATE_LABELS.unverified}</span>
                  </p>
                  {row.adopted_from && <p className="hp-evidence-adopted">코치가 제안한 문장을 받아서 적었어요</p>}
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
    </details>
  );
}

/** 라벨 표를 화면 밖에서도 쓰기 위해 다시 내보낸다(감사기·테스트). */
export { EVIDENCE_TYPE_LABELS };
