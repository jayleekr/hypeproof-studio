import { useEffect, useRef, useState } from "react";
import type { ChatConfig, ChatMessage } from "../../src/protocol";

interface Props {
  config: ChatConfig | null;
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onCancel: () => void;
  onClear: () => void;
  onSetToken: () => void;
  onSettings: () => void;
  onRunCode: (html: string) => void;
}

function extractRenderableHtml(text: string): string | null {
  const htmlFence = /```(?:html|HTML)\s*\n([\s\S]*?)\n```/.exec(text);
  if (htmlFence) return htmlFence[1].trim();
  const doctype = /<!doctype\s+html[\s\S]*?<\/html\s*>/i.exec(text);
  if (doctype) return doctype[0];
  const jsFence = /```(?:javascript|js)\s*\n([\s\S]*?)\n```/.exec(text);
  if (jsFence) {
    const js = jsFence[1].trim();
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:sans-serif;padding:12px}</style></head><body><script>try{${js}}catch(e){document.body.innerHTML='<pre style="color:#c00">'+e+'</pre>';}</script></body></html>`;
  }
  return null;
}

export function ChatPanel(props: Props) {
  const { config, messages, streaming, error } = props;
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, streaming]);

  const submit = () => {
    if (!draft.trim() || streaming) return;
    props.onSend(draft);
    setDraft("");
  };

  return (
    <div className="hps-shell">
      <header className="hps-header">
        <strong>HypeProof Chat</strong>
        <div className="hps-actions">
          <button onClick={props.onSetToken} title="Set workshop token">
            {config?.hasToken ? "Token ✓" : "Set token"}
          </button>
          <button onClick={props.onClear} title="Clear conversation">Clear</button>
          <button onClick={props.onSettings} title="Open settings">⚙</button>
        </div>
      </header>

      <div className="hps-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="hps-empty">
            <p>HypeProof Studio에 오신 걸 환영합니다.</p>
            <p>아래에 무엇이든 입력해보세요 — 예: "삼각형을 그리는 게임을 만들어줘".</p>
          </div>
        )}
        {messages.map((m) => {
          const renderable = m.role === "assistant" ? extractRenderableHtml(m.content) : null;
          return (
            <div key={m.id} className={`hps-msg hps-msg-${m.role}`}>
              <div className="hps-msg-role">
                <span>{m.role === "user" ? "You" : "HypeProof"}</span>
                {renderable && (
                  <button
                    className="hps-msg-run"
                    onClick={() => props.onRunCode(renderable)}
                    title="미리보기 패널에서 실행"
                  >
                    ▶ Run
                  </button>
                )}
              </div>
              <div className="hps-msg-body">{m.content || (streaming && m.role === "assistant" ? "…" : "")}</div>
            </div>
          );
        })}
        {error && <div className="hps-error">{error}</div>}
      </div>

      <footer className="hps-input">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={streaming ? "응답 중..." : "메시지를 입력하고 Enter (Shift+Enter 줄바꿈)"}
          disabled={streaming}
          rows={3}
        />
        {streaming ? (
          <button onClick={props.onCancel} className="hps-btn-stop">Stop</button>
        ) : (
          <button onClick={submit} disabled={!draft.trim()} className="hps-btn-send">Send</button>
        )}
      </footer>
    </div>
  );
}
