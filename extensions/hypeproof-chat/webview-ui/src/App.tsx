import { useEffect, useReducer } from "react";
import type { ChatConfig, ChatMessage, HostMessage } from "../../src/protocol";
import { onHostMessage, postToHost } from "./vscode";
import { ChatPanel } from "./ChatPanel";
import { ChatErrorBoundary } from "./ChatErrorBoundary";

interface State {
  config: ChatConfig | null;
  messages: ChatMessage[];
  streamingId: string | null;
  streamId: string | null;
  error: string | null;
  errorRequestId: string | null;   // S-07 / #49 — surfaced in ErrorBanner
}

type Action =
  | { type: "config"; config: ChatConfig }
  | { type: "history"; messages: ChatMessage[] }
  | { type: "streamStart"; streamId: string; messageId: string }
  | { type: "streamChunk"; delta: string }
  | { type: "streamEnd" }
  | { type: "streamError"; error: string; requestId?: string }
  | { type: "userSent"; text: string };

const initialState: State = {
  config: null,
  messages: [],
  streamingId: null,
  streamId: null,
  error: null,
  errorRequestId: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "config":
      return { ...state, config: action.config };
    case "history":
      return { ...state, messages: action.messages };
    case "streamStart":
      return {
        ...state,
        streamingId: action.messageId,
        streamId: action.streamId,
        error: null,
        messages: [
          ...state.messages,
          { id: action.messageId, role: "assistant", content: "", createdAt: Date.now() },
        ],
      };
    case "streamChunk":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === state.streamingId ? { ...m, content: m.content + action.delta } : m,
        ),
      };
    case "streamEnd":
      return { ...state, streamingId: null, streamId: null, error: null, errorRequestId: null };
    case "streamError":
      return {
        ...state,
        streamingId: null,
        streamId: null,
        error: action.error,
        errorRequestId: action.requestId ?? null,
      };
    case "userSent":
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: `local-${Date.now()}`, role: "user", content: action.text, createdAt: Date.now() },
        ],
      };
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const off = onHostMessage((msg: HostMessage) => {
      switch (msg.type) {
        case "config":      dispatch({ type: "config", config: msg.config }); break;
        case "history":     dispatch({ type: "history", messages: msg.messages }); break;
        case "streamStart": dispatch({ type: "streamStart", streamId: msg.streamId, messageId: msg.messageId }); break;
        case "streamChunk": dispatch({ type: "streamChunk", delta: msg.delta }); break;
        case "streamEnd":   dispatch({ type: "streamEnd" }); break;
        case "streamError": dispatch({ type: "streamError", error: msg.error, requestId: msg.requestId }); break;
        case "actionResult": /* not yet routed to UI */ break;
      }
    });
    postToHost({ type: "ready" });
    return off;
  }, []);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || state.streamingId) return;
    dispatch({ type: "userSent", text: trimmed });
    postToHost({ type: "sendMessage", text: trimmed, history: state.messages });
  };

  const retry = (prompt: string) => {
    if (state.streamingId) return;
    // Re-send the same user prompt to get a fresh assistant variant.
    dispatch({ type: "userSent", text: prompt });
    postToHost({ type: "retryMessage", prompt, history: state.messages });
  };

  // S-04 (#48): "다시 보내기" on a stream error reuses the LAST user prompt
  // that's already in history. The worker idempotently writes turn rows so
  // a retry doesn't double-count.
  const retryLast = () => {
    if (state.streamingId) return;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m && m.role === "user") {
        postToHost({ type: "retryMessage", prompt: m.content, history: state.messages });
        return;
      }
    }
  };

  const dismissError = () => dispatch({ type: "streamEnd" });

  const cancel = () => {
    if (state.streamId) postToHost({ type: "cancelStream", streamId: state.streamId });
  };

  // streamEnd dispatches don't carry error info; clear-on-end is fine because
  // the existing reducer only sets error on streamError, never on streamEnd.
  const hasLastUserPrompt = state.messages.some((m) => m.role === "user");

  return (
    <ChatErrorBoundary>
      <ChatPanel
        config={state.config}
        messages={state.messages}
        streaming={!!state.streamingId}
        error={state.error}
        errorRequestId={state.errorRequestId}
        canRetryLast={hasLastUserPrompt && !state.streamingId}
        onSend={send}
        onRetry={retry}
        onRetryLast={retryLast}
        onDismissError={dismissError}
        onCancel={cancel}
        onClear={() => postToHost({ type: "clearHistory" })}
        onSetToken={() => postToHost({ type: "setToken" })}
        onSettings={() => postToHost({ type: "openSettings" })}
        onRunCode={(html) => postToHost({ type: "runCode", html })}
        onNamingRitual={() => postToHost({ type: "namingRitual" })}
        onSaveCoach={(name, personality) =>
          postToHost({ type: "saveCoach", name, personality })
        }
        onReportProblem={() => postToHost({ type: "openReportModal" })}
        onInstallUpdate={() => postToHost({ type: "installUpdate" })}
        onDismissUpdate={(version) => postToHost({ type: "dismissUpdate", version })}
      />
    </ChatErrorBoundary>
  );
}
