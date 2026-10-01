// "내 제품 테스트" panel (cr-verify, #1392; CR-12–CR-16, CR-68, CR-81).
//
// Draws what the host computed (`VerifyView`) and sends the student's own actions back. It
// decides nothing: the 1–5 rule, the confirmation of coach proposals, the verdicts and the
// "검증됨" state are the host's, recomputed from the record on every post. A disabled
// button here is a picture, not a lock (the host refuses the same things by name).
import { useState } from "react";
import type { VerifyView } from "../../src/verifyView";

type Draft = { text: string; proposed_by: "student" | "ai"; confirmed: boolean; adopted_from?: string };

const STATE_LINE: Record<VerifyView["verification"]["state"], string> = {
  verified: "검증됨 · 이 버전에서 기대 조건을 모두 통과했어요",
  failed: "통과하지 못한 조건이 있어요",
  incomplete: "확인되지 않은 조건이 있어요",
  needs_recheck: "파일이 바뀌었어요 · 다시 테스트해 주세요 (이전 결과는 남아 있어요)",
  not_verified: "이 버전은 아직 테스트하지 않았어요",
};
const STATUS_LABEL: Record<string, string> = {
  pass: "통과",
  fail: "실패",
  warning: "주의",
  not_verified: "확인 안 됨",
  non_reproducible: "결과가 매번 달라요",
};

export function VerifyPanel(props: {
  view: VerifyView;
  error: string | null;
  busy: boolean;
  onStart(criteria: Draft[]): void;
  onRetest(): void;
  onFix(criterionId: string, text: string): void;
  onClose(): void;
}) {
  const { view } = props;
  const [drafts, setDrafts] = useState<Draft[]>([{ text: "", proposed_by: "student", confirmed: true }]);
  const [fixText, setFixText] = useState<Record<string, string>>({});
  const disabled = props.busy || view.running || !view.available;
  const set = (i: number, d: Partial<Draft>) => setDrafts((all) => all.map((x, j) => (j === i ? { ...x, ...d } : x)));

  return (
    <section className="hps-verify" aria-label="내 제품 테스트" data-testid="verify-panel">
      <header className="hps-verify-head">
        <strong>내 제품 테스트</strong>
        <span className={`hps-verify-state hps-verify-state-${view.verification.state}`} data-testid="verify-status" data-state={view.verification.state}>
          {STATE_LINE[view.verification.state]}
        </span>
        <button type="button" className="hps-verify-close" aria-label="테스트 창 닫기" onClick={props.onClose}>
          ✕
        </button>
      </header>

      {view.running && (
        <div className="hps-verify-running" role="status" aria-live="polite" data-testid="verify-running">
          🧪 테스트 중 — 실험 브라우저가 화면을 움직이고 있어요
        </div>
      )}
      {(props.error || view.reason) && (
        <div className="hps-verify-error" role="alert" data-testid="verify-error">
          {props.error ?? view.reason}
        </div>
      )}

      <div className="hps-verify-form">
        <div className="hps-verify-label">기대 조건 (1~5개) — 화면에서 확인할 수 있게 적어요</div>
        {drafts.map((d, i) => (
          <div className="hps-verify-row" key={i}>
            {d.proposed_by === "ai" && (
              <span className="hps-verify-ai" data-testid="verify-ai-badge">
                코치 제안{d.confirmed ? " · 확인함" : " · 확인 필요"}
              </span>
            )}
            <input
              type="text"
              value={d.text}
              maxLength={300}
              placeholder="예: 주문하기를 누르면 '주문이 완료되었어요'가 보인다"
              data-testid="verify-criterion-input"
              onChange={(e) => set(i, { text: e.target.value, ...(d.proposed_by === "ai" ? { confirmed: true } : {}) })}
            />
            {d.proposed_by === "ai" && !d.confirmed && (
              <button type="button" data-testid="verify-confirm" onClick={() => set(i, { confirmed: true })}>
                이대로 쓰기
              </button>
            )}
            <button type="button" aria-label="이 조건 빼기" onClick={() => setDrafts((all) => all.filter((_, j) => j !== i))}>
              빼기
            </button>
          </div>
        ))}
        <div className="hps-verify-actions">
          <button type="button" disabled={drafts.length >= 5} onClick={() => setDrafts((all) => [...all, { text: "", proposed_by: "student", confirmed: true }])}>
            조건 더하기
          </button>
          <button type="button" className="hps-verify-primary" data-testid="verify-start" disabled={disabled} onClick={() => props.onStart(drafts)}>
            테스트 시작
          </button>
        </div>
        {view.proposals.length > 0 && (
          <div className="hps-verify-proposals">
            <div className="hps-verify-label">코치가 제안한 조건 — 확인해야 테스트에 쓰여요</div>
            {view.proposals.map((p, i) => (
              <button
                type="button"
                key={`${p.id}-${i}`}
                data-testid="verify-proposal"
                disabled={drafts.length >= 5}
                onClick={() => setDrafts((all) => [...all.filter((x) => x.text.trim()), { text: p.text, proposed_by: "ai", confirmed: false, adopted_from: p.id }])}
              >
                + {p.text}
              </button>
            ))}
          </div>
        )}
      </div>

      {view.report && (
        <div className="hps-verify-report" data-testid="verify-report" data-run={view.report.run_id} data-version={view.report.artifact_version_id}>
          <div className="hps-verify-label">
            {view.report.artifact_version_id === view.version ? "이 버전의 테스트 결과" : "이전 버전의 테스트 결과"}
          </div>
          {view.report.criteria.map((c) => (
            <div className={`hps-verify-result hps-verify-${c.status}`} key={c.id} data-testid="verify-result" data-status={c.status} data-criterion={c.id} data-test-kind={c.test_kind ?? ""}>
              <div>
                <span className="hps-verify-badge">{STATUS_LABEL[c.status] ?? c.status}</span> {c.text}
                {c.method === "vision" && <span className="hps-verify-vision"> · 화면 판단</span>}
              </div>
              {c.reason && <div className="hps-verify-reason">{c.reason}</div>}
              {c.steps.length > 0 && (
                <details>
                  <summary>한 일과 근거 보기</summary>
                  <ol>
                    {c.steps.map((s) => (
                      <li key={s.index}>
                        {s.ok ? "✓" : "✗"} {s.action}
                        {s.target ? ` · ${s.target}` : ""} — {s.message}
                      </li>
                    ))}
                  </ol>
                  <ul>
                    {c.cites.map((x, i) => (
                      <li key={i}>
                        근거({x.kind}): {x.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {(c.status === "fail" || c.status === "warning") && c.test_ref && view.report?.artifact_version_id === view.version && (
                <div className="hps-verify-fix">
                  <input
                    type="text"
                    maxLength={500}
                    placeholder="무엇을 고쳐 달라고 할지 내 말로 적어요"
                    data-testid="verify-fix-text"
                    value={fixText[c.id] ?? ""}
                    onChange={(e) => setFixText((all) => ({ ...all, [c.id]: e.target.value }))}
                  />
                  <button type="button" data-testid="verify-fix" disabled={disabled} onClick={() => props.onFix(c.id, fixText[c.id] ?? "")}>
                    고쳐 달라고 하기
                  </button>
                </div>
              )}
            </div>
          ))}
          <button type="button" data-testid="verify-retest" disabled={disabled} onClick={props.onRetest}>
            같은 조건으로 다시 테스트
          </button>
        </div>
      )}
    </section>
  );
}
