import { useEffect, useRef, useState } from "react";
import type { StartState } from "../../src/startPageProtocol";
import { onHostMessage, postToHost } from "./vscode";
import { Brand } from "./Brand";
import "./start.css";

export function StartPage() {
  const [state, setState] = useState<StartState>({ checking: true, version: "" });
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(false);
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
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  const connect = (e: React.FormEvent) => {
    e.preventDefault(); if (!token.trim() || state.checking) return;
    setState(s => ({ ...s, checking: true, error: undefined }));
    postToHost({ type: "connectCourse", token });
    // A submitted credential is never retained in the document, VS Code state or storage.
    setToken("");
  };
  return <main className="studio-start">
    <header className="studio-top"><Brand/><span className="studio-edition">A SPACE TO MAKE IT YOURS</span></header>
    <div className="studio-main">
      <section className="studio-intro" aria-labelledby="start-title">
        <p className="studio-eyebrow"><span/> 생각에서, 나의 결과물로</p>
        <h1 id="start-title">생각을 현실로.<br/><span>완성은 내 손으로.</span></h1>
        <p className="studio-lead">목표를 정하고, AI와 함께 만들고,<br className="studio-wide"/> 결과를 검토하는 나만의 작업 공간.</p>
        <div className="studio-process" aria-label="목표 정하기, 함께 만들기, 직접 검토하기">
          <div><span>01</span><strong>목표 정하기</strong><p>무엇을 바꾸고 싶은가요?</p></div>
          <div><span>02</span><strong>함께 만들기</strong><p>코치와 작은 시도부터.</p></div>
          <div><span>03</span><strong>직접 검토하기</strong><p>결과를 확인하고 내 것으로.</p></div>
        </div>
      </section>
      <section className="studio-connect" aria-labelledby="connect-title" aria-busy={state.checking}>
        <div className="studio-card-top"><span className="studio-step">GET STARTED</span><span className="studio-dot"/></div>
        <h2 id="connect-title">{state.profile && !editing ? "이 수업으로 시작할까요?" : "내 수업에 연결하기"}</h2>
        <p className="studio-card-description">{state.profile && !editing ? "수업과 코치를 확인한 뒤 작업을 시작하세요." : "강사에게 받은 참여 코드를 붙여넣으세요. 연결할 수업을 먼저 확인할 수 있습니다."}</p>
        {state.profile && !editing ? <>
          <div className="studio-course"><span className="studio-verified">연결된 수업</span><h3>{state.profile.name}</h3><dl><div><dt>코치</dt><dd>{state.profile.coach}</dd></div><div><dt>회차</dt><dd>{state.profile.series}</dd></div><div><dt>수업 작업 폴더</dt><dd>{state.profile.workspace}</dd></div></dl></div>
          <button className="studio-primary" disabled={state.checking} onClick={() => postToHost({ type: "beginCourse" })}>수업 시작하기 <span aria-hidden="true">↗</span></button>
          <div className="studio-course-actions"><button className="studio-text-button" onClick={() => setEditing(true)} disabled={state.checking}>다른 수업에 연결</button><button className="studio-text-button" onClick={() => postToHost({ type: "disconnectCourse" })} disabled={state.checking}>연결 해제</button></div>
        </> : <form onSubmit={connect}>
          <label htmlFor="course-code">수업 참여 코드</label>
          <input ref={input} id="course-code" type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="받은 코드를 여기에 붙여넣으세요" autoComplete="off" spellCheck={false} disabled={state.checking} aria-describedby="code-help connection-error"/>
          <p id="code-help" className="studio-help">코드는 이 기기에 안전하게 저장됩니다.</p>
          <button className="studio-primary" disabled={state.checking || !token.trim()} type="submit">{state.checking ? "수업 확인 중…" : "수업 확인하기"}<span aria-hidden="true">→</span></button>
          {state.profile && <button className="studio-text-button" type="button" onClick={() => setEditing(false)}>기존 수업으로 돌아가기</button>}
        </form>}
        <div aria-live="polite" role="status" className="studio-status">{state.checking ? "연결 정보를 확인하고 있습니다." : ""}</div>
        {state.error && <div className="studio-error" id="connection-error" role="alert">{state.error}{state.profile && <p>기존 수업 연결은 유지됩니다.</p>}</div>}
        <div className="studio-card-footer">코드가 없다면 강사에게 참여 코드를 요청하세요.</div>
      </section>
    </div>
    <footer className="studio-bottom"><button onClick={() => postToHost({ type: "openLocalFolder" })}>작업 폴더 열기 <span aria-hidden="true">↗</span></button><span>{state.workspace ? `현재 폴더 · ${state.workspace}` : "내 파일은 내 작업 폴더에 남습니다."}</span><span className="studio-build">MAKE · VERIFY · OWN</span></footer>
  </main>;
}

export function DisconnectedChat({ open }: { open: () => void }) {
  return <main className="studio-disconnected"><Brand/><h1>시작할 준비가 됐나요?</h1><p>수업을 연결하면 이곳에서<br/>내 코치와 작업을 이어갈 수 있습니다.</p><button className="studio-primary" onClick={open}>시작 화면 열기 <span aria-hidden="true">↗</span></button></main>;
}
