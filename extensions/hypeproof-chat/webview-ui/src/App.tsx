import { useEffect, useReducer } from "react";
import type { ChatConfig, ChatMessage, HostMessage } from "../../src/protocol";
import { onHostMessage, postToHost } from "./vscode";
import { ChatPanel } from "./ChatPanel";

interface State {
  config: ChatConfig | null;
  messages: ChatMessage[];
  streamingId: string | null;
  streamId: string | null;
  error: string | null;
}

type Action =
  | { type: "config"; config: ChatConfig }
  | { type: "history"; messages: ChatMessage[] }
  | { type: "streamStart"; streamId: string; messageId: string }
  | { type: "streamChunk"; delta: string }
  | { type: "streamEnd" }
  | { type: "streamError"; error: string }
  | { type: "userSent"; text: string };

const initialState: State = {
  config: null,
  messages: [],
  streamingId: null,
  streamId: null,
  error: null,
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
      return { ...state, streamingId: null, streamId: null };
    case "streamError":
      return { ...state, streamingId: null, streamId: null, error: action.error };
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
        case "streamError": dispatch({ type: "streamError", error: msg.error }); break;
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

  const cancel = () => {
    if (state.streamId) postToHost({ type: "cancelStream", streamId: state.streamId });
  };

  return (
    <ChatPanel
      config={state.config}
      messages={state.messages}
      streaming={!!state.streamingId}
      error={state.error}
      onSend={send}
      onCancel={cancel}
      onClear={() => postToHost({ type: "clearHistory" })}
      onSetToken={() => postToHost({ type: "setToken" })}
      onSettings={() => postToHost({ type: "openSettings" })}
      onRunCode={(html) => postToHost({ type: "runCode", html })}
    />
  );
}
