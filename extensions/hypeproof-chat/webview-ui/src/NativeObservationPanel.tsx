import { useEffect, useRef, useState } from "react";
import { postToHost, onHostMessage } from "./vscode";
import type {
  ObservationBatch,
  ObservationFinding,
} from "../../src/nativeObservationContract";
export function NativeObservationPanel({ scope }: { scope?: string }) {
  const activeScope = useRef<string | null>(scope ?? null);
  const [assessedCount,setAssessedCount]=useState<number|undefined>();
  const [learningPath, setLearningPath] = useState<{
    title: string;
    url: string;
    reason: string;
  } | null>(null);
  const [batch, setBatch] = useState<ObservationBatch | null>(null),
    [error, setError] = useState<string | null>(null),
    [findings, setFindings] = useState<ObservationFinding[]>([]),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [correction, setCorrection] = useState("");
  useEffect(
    () =>
      onHostMessage((msg) => {
        if (msg.type === "config") {
          const nextScope = msg.config.profile?.observation?.scope ?? null;
          if (nextScope === activeScope.current) return;
          activeScope.current = nextScope;
          setCorrection("");
          setError(null);
          setLearningPath(null);
          setAssessedCount(undefined);
          setBatch(null);
          setFindings([]);
          setConsent(false);
          setBusy(false);
        }
        if (msg.type === "observationState") {
          if (msg.batch && msg.batch.scope !== activeScope.current) return;
          setLearningPath(msg.learningPath ?? null);
          setAssessedCount(msg.assessedEventCount);
          setBatch(msg.batch);
          setError(msg.error);
          setFindings(msg.findings ?? []);
          setBusy(false);
          setConsent(false);
        }
      }),
    [],
  );
  const artifacts = batch?.events.filter((e) => e.kind === "artifact") ?? [];
  return (
    <details className="hps-native-observation">
      <summary>내 작업 돌아보기</summary>
      <p>
        내가 요청한 내용과 코치·도구가 수행한 일을 나누어 확인합니다. 관찰은
        점수나 능력 인증이 아닙니다.
      </p>
      <button onClick={() => postToHost({ type: "observationOpen" })}>
        이 작업의 기록 확인
      </button>
      {learningPath && (
        <div>
          <p>{learningPath.reason}</p>
          <button
            onClick={() =>
              postToHost({ type: "openExternal", url: learningPath.url })
            }
          >
            {learningPath.title}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {batch && (
        <>
          <p>
            {batch.events.length}건 · 도움 사용 범위는 확인 전까지 미확인입니다.
          </p>
          {artifacts.length > 0 && (
            <details>
              <summary>보존된 산출물 비교</summary>
              <p>
                첫 저장본과 최근 저장본입니다. 내용을 직접 비교해 달라진 점을
                확인하세요.
              </p>
              <div className="hps-observation-compare">
                {[
                  artifacts[0],
                  ...(artifacts.length > 1
                    ? [artifacts[artifacts.length - 1]]
                    : []),
                ].map((e, i) => (
                  <section key={e.id}>
                    <h4>{i === 0 ? "첫 저장" : "최근 저장"}</h4>
                    <pre>{e.text}</pre>
                    <small>SHA-256: {e.sha256}</small>
                  </section>
                ))}
              </div>
            </details>
          )}
          <details>
            <summary>평가에 보낼 기록 보기</summary>
            <ol>
              {batch.events.map((e) => (
                <li key={e.id}>
                  <strong>
                    {e.kind} · {e.outcome ?? ""}{" "}
                    {e.actor === "policy" ? "자동 정책 처리" : ""}
                  </strong>
                  <pre>{e.text}</pre>
                </li>
              ))}
            </ol>
          </details>
          <label>
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            위 기록을 평가 API에 보내 잠정 관찰을 받겠습니다. 서버에 원문을
            저장하지 않습니다.
          </label>
          <button
            disabled={!consent || busy || batch.events.length === 0}
            onClick={() => {
              setBusy(true);
              postToHost({
                type: "observationAssess",
                scope: batch.scope,
                eventIds: batch.events.map((e) => e.id),
              });
            }}
          >
            {busy ? "관찰 중…" : "관찰 받기"}
          </button>
          {busy && (
            <button onClick={() => postToHost({ type: "observationCancel" })}>
              관찰 취소
            </button>
          )}
          {findings.length>0&&<p>이 관찰은 {assessedCount ?? batch.events.length}개 기록 기준입니다. 이후 추가한 정정과 작업은 다시 관찰을 요청해야 반영됩니다.</p>}
          {findings.map((f) => (
            <article key={f.asset}>
              <h4>
                {f.asset} ·{" "}
                {f.status === "unobserved" ? "아직 관찰하지 못함" : "잠정 관찰"}
              </h4>
              <p>{f.interpretation}</p>
              <small>
                {f.assistance === "independent"
                  ? "독립 수행 근거"
                  : f.assistance === "assisted"
                    ? "도움을 받은 수행"
                    : "도움 사용 범위 미확인"}
              </small>
              {f.evidence.map((r) => (
                <blockquote key={r.event_id}>
                  {r.quote}
                  <small>{r.event_id}</small>
                </blockquote>
              ))}
              <p>{f.next}</p>
            </article>
          ))}
          {findings.length > 0 && (
            <>
              <label>
                내가 다르게 보는 점
                <textarea
                  value={correction}
                  onChange={(e) => setCorrection(e.target.value)}
                  maxLength={2000}
                />
              </label>
              <button
                disabled={!correction.trim()}
                onClick={() => {
                  postToHost({
                    type: "observationCorrect",
                    scope: batch.scope,
                    text: correction,
                  });
                  setCorrection("");
                }}
              >
                정정 기록 남기기
              </button>
            </>
          )}
        </>
      )}
    </details>
  );
}
