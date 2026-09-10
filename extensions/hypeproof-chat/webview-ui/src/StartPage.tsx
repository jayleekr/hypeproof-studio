import { useEffect, useRef, useState } from "react";
import type { StartState } from "../../src/startPageProtocol";
import { onHostMessage, postToHost } from "./vscode";
import { startPageCopy } from "../../src/coachIdentity";
import { Brand } from "./Brand";
import "./start.css";

export function StartPage() {
  const [state, setState] = useState<StartState>({ checking: true, version: "" });
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(false);
  const [entry, setEntry] = useState<"trial" | "classroom" | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const off = onHostMessage(msg => {
      if (msg.type !== "startState") return;
      setState(msg.state);
      if (!msg.state.checking && !msg.state.error && msg.state.profile) { setToken(""); setEditing(false); }
    });
    postToHost({ type: "startReady" });
    return off;
  }, []);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing, entry]);
  const connect = (e: React.FormEvent) => {
    e.preventDefault(); if (!token.trim() || state.checking) return;
    setState(s => ({ ...s, checking: true, error: undefined }));
    postToHost({ type: "connectCourse", token });
    // A submitted credential is never retained in the document, VS Code state or storage.
    setToken("");
  };
  const copy = startPageCopy(state.coachName);
  const activity = state.profile?.kind === "trial" ? "AI 체험" : state.profile?.kind === "personal" ? "개인 작업" : state.profile?.kind === "classroom" ? "수업" : "활동";
  const choose = (next: "trial" | "classroom") => { setToken(""); setEntry(next); setEditing(true); };
  const showProfile = !!state.profile && !editing;

  return <main className="studio-start">
    <header className="studio-top"><Brand/><nav className="studio-nav" aria-label="Studio 탐색"><button onClick={() => postToHost({ type: "openStudioFiles" })}>파일</button><button onClick={() => postToHost({ type: "openStudioSettings" })}>설정</button></nav></header>
    <div className="studio-main">
      <section className="studio-intro" aria-labelledby="start-title">
        <p className="studio-eyebrow"><span/> 생각에서, 나의 결과물로</p>
        <h1 id="start-title">생각을 현실로.<br/><span>완성은 내 손으로.</span></h1>
        <p className="studio-lead">목표를 정하고, AI와 함께 만들고,<br className="studio-wide"/> 결과를 검토하는 나만의 작업 공간.</p>
        <div className="studio-process" aria-label="목표 정하기, 함께 만들기, 직접 검토하기">
          <div><span>01</span><strong>목표 정하기</strong><p>무엇을 바꾸고 싶은가요?</p></div>
          <div><span>02</span><strong>함께 만들기</strong><p>{copy.stepTwo}</p></div>
          <div><span>03</span><strong>직접 검토하기</strong><p>결과를 확인하고 내 것으로.</p></div>
        </div>
      </section>
      <section className="studio-connect" aria-labelledby="connect-title" aria-busy={state.checking}>
        <div className="studio-card-top"><span className="studio-step">GET STARTED</span><span className="studio-dot"/></div>
        <h2 id="connect-title">{showProfile ? (state.started ? copy.startedTitle : "이어서 시작할까요?") : entry === "trial" ? "내 삶에 AI 더하기" : entry === "classroom" ? "수업에 참여하기" : "어떻게 시작할까요?"}</h2>
        <p className="studio-card-description">{showProfile ? (state.started ? copy.startedDescription : "연결된 활동을 확인한 뒤 이어서 시작하세요.") : entry === "trial" ? "일상의 고민부터 만들고 싶은 것까지, AI와 함께 시작해보세요. 지금은 발급받은 체험 코드가 필요합니다." : entry === "classroom" ? "발급받은 참여 코드로 수업을 확인하세요." : "혼자 AI를 체험하거나, 참여한 수업을 이어갈 수 있습니다."}</p>
        {state.profile && !editing ? <>
          <div className="studio-course"><span className="studio-verified">{activity}</span><h3>{state.profile.name}</h3><dl><div><dt>{copy.coachRowLabel}</dt><dd>{state.profile.coach}</dd></div>{state.profile.kind !== "trial" && state.profile.kind !== "personal" && <div><dt>회차</dt><dd>{state.profile.series}</dd></div>}<div><dt>작업 폴더</dt><dd>{state.profile.workspace}</dd></div></dl></div>
          <button className="studio-primary" disabled={state.checking} onClick={() => { setState(s => ({ ...s, checking: true, error: undefined })); postToHost({ type: "beginCourse" }); }}>{state.checking ? "활동 여는 중…" : state.started ? copy.continueButton : "이어서 하기"} <span aria-hidden="true">↗</span></button>
          <div className="studio-course-actions"><button className="studio-text-button" onClick={() => { setEditing(true); setEntry(null); setToken(""); }} disabled={state.checking}>다른 활동 선택</button><button className="studio-text-button" onClick={() => postToHost({ type: "disconnectCourse" })} disabled={state.checking}>연결 해제</button></div>
        </> : entry === null ? <div className="studio-entry-options">
          <button className="studio-primary" disabled={state.checking} onClick={() => choose("trial")}>AI 체험하기 <span aria-hidden="true">→</span></button>
          <button className="studio-primary studio-secondary" disabled={state.checking} onClick={() => choose("classroom")}>수업에 참여하기 <span aria-hidden="true">→</span></button>
          {state.profile && <button className="studio-text-button" onClick={() => setEditing(false)}>기존 활동으로 돌아가기</button>}
        </div> : <form onSubmit={connect}>
          <label htmlFor="course-code">{entry === "trial" ? "체험 참여 코드" : "수업 참여 코드"}</label>
          <input ref={input} id="course-code" type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="받은 코드를 여기에 붙여넣으세요" autoComplete="off" spellCheck={false} disabled={state.checking} aria-describedby="code-help connection-error"/>
          <p id="code-help" className="studio-help">코드는 이 기기에 안전하게 저장됩니다.</p>
          <button className="studio-primary" disabled={state.checking || !token.trim()} type="submit">{state.checking ? "코드 확인 중…" : "코드 확인하기"}<span aria-hidden="true">→</span></button>
          {state.profile && <button className="studio-text-button" type="button" onClick={() => setEditing(false)}>기존 활동으로 돌아가기</button>}
          <button className="studio-text-button" type="button" disabled={state.checking} onClick={() => { setEntry(null); setToken(""); }}>시작 방법 다시 선택</button>
        </form>}
        <div aria-live="polite" role="status" className="studio-status">{state.checking ? "연결 정보를 확인하고 있습니다." : ""}</div>
        {state.error && <div className="studio-error" id="connection-error" role="alert">{state.error}{state.profile && <p>기존 활동 연결은 유지됩니다.</p>}</div>}
        <div className="studio-card-footer">{entry === "trial" && !showProfile ? "체험 코드가 없다면 코드 발급 담당자에게 요청해 주세요. 공개 가입은 아직 지원하지 않습니다." : "참여 코드에 연결된 활동과 이용 조건이 적용됩니다."}</div>
      </section>
    </div>
    <footer className="studio-bottom"><button onClick={() => postToHost({ type: "openLocalFolder" })}>작업 폴더 열기 <span aria-hidden="true">↗</span></button><span>{state.workspace ? `현재 폴더 · ${state.workspace}` : "내 파일은 내 작업 폴더에 남습니다."}</span><span className="studio-build">MAKE · VERIFY · OWN</span></footer>
  </main>;
}

export function DisconnectedChat({ open, coachName }: { open: () => void; coachName?: string }) {
  const [lead1, lead2] = startPageCopy(coachName).disconnectedLead.split("\n");
  return <main className="studio-disconnected"><Brand/><h1>시작할 준비가 됐나요?</h1><p>{lead1}<br/>{lead2}</p><button className="studio-primary" onClick={open}>시작 화면 열기 <span aria-hidden="true">↗</span></button></main>;
}
