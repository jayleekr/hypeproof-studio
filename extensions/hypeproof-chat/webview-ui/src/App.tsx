import { useEffect, useReducer, useState } from "react";
import type { AssetScoreChunk, ChatConfig, ChatMessage, Citation, HostMessage } from "../../src/protocol";
import { onHostMessage, postToHost } from "./vscode";
import { ChatPanel } from "./ChatPanel";
import { ChatErrorBoundary } from "./ChatErrorBoundary";

// #278 Phase 3 — one line in the browser tool action log.
export type ToolLogEntry = { id: string; icon: string; label: string; state: "running" | "done" | "error" };

interface State {
  config: ChatConfig | null;
  messages: ChatMessage[];
  streamingId: string | null;
  streamId: string | null;
  error: string | null;
  errorRequestId: string | null;   // S-07 / #49 — surfaced in ErrorBanner
  errorRunbookUrl: string | null;  // #165 — banner renders as clickable link
  assetScore: AssetScoreChunk | null;
  toolLog: ToolLogEntry[];          // #278 Phase 3 — browser loop action log (current turn)
  pageNotice: string | null;        // #308 — "페이지를 코치에게" 인라인 안내 (토스트 대체)
}

type Action =
  | { type: "config"; config: ChatConfig }
  | { type: "history"; messages: ChatMessage[] }
  | { type: "streamStart"; streamId: string; messageId: string }
  | { type: "streamChunk"; delta: string }
  | { type: "streamCitations"; citations: Citation[] }
  | { type: "streamAssetScore"; assetScore: AssetScoreChunk }
  | { type: "toolLog"; entry: ToolLogEntry }
  | { type: "pageAttached"; label: string }
  | { type: "streamEnd" }
  | { type: "streamError"; error: string; requestId?: string; runbookUrl?: string }
  | { type: "userSent"; text: string; images?: string[] };

const initialState: State = {
  config: null,
  messages: [],
  streamingId: null,
  streamId: null,
  error: null,
  errorRequestId: null,
  errorRunbookUrl: null,
  assetScore: null,
  toolLog: [],
  pageNotice: null,
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
        assetScore: null,
        toolLog: [],
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
    case "streamCitations":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === state.streamingId
            ? { ...m, citations: [...(m.citations ?? []), ...action.citations] }
            : m,
        ),
      };
    case "streamAssetScore":
      return { ...state, assetScore: action.assetScore };
    case "toolLog": {
      // Upsert by id (a running line flips to done/error in place).
      const exists = state.toolLog.some((e) => e.id === action.entry.id);
      const toolLog = exists
        ? state.toolLog.map((e) => (e.id === action.entry.id ? action.entry : e))
        : [...state.toolLog, action.entry];
      return { ...state, toolLog };
    }
    case "pageAttached":
      // #308 — inline notice; cleared on the next send (userSent) only.
      return { ...state, pageNotice: action.label };
    case "streamEnd":
      return {
        ...state,
        streamingId: null,
        streamId: null,
        error: null,
        errorRequestId: null,
        errorRunbookUrl: null,
      };
    case "streamError":
      return {
        ...state,
        streamingId: null,
        streamId: null,
        error: action.error,
        errorRequestId: action.requestId ?? null,
        errorRunbookUrl: action.runbookUrl ?? null,
      };
    case "userSent":
      return {
        ...state,
        pageNotice: null,   // #308 — clear the "붙였어요" notice once the user sends
        messages: [
          ...state.messages,
          {
            id: `local-${Date.now()}`,
            role: "user",
            content: action.text,
            createdAt: Date.now(),
            ...(action.images && action.images.length > 0 ? { images: action.images } : {}),
          },
        ],
      };
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [shouldCrash, setShouldCrash] = useState(false);

  useEffect(() => {
    const off = onHostMessage((msg: HostMessage) => {
      switch (msg.type) {
        case "config":      dispatch({ type: "config", config: msg.config }); break;
        case "history":     dispatch({ type: "history", messages: msg.messages }); break;
        case "streamStart": dispatch({ type: "streamStart", streamId: msg.streamId, messageId: msg.messageId }); break;
        case "streamChunk": dispatch({ type: "streamChunk", delta: msg.delta }); break;
        case "streamCitations": dispatch({ type: "streamCitations", citations: msg.citations }); break;
        case "streamAssetScore": dispatch({ type: "streamAssetScore", assetScore: msg.assetScore }); break;
        case "toolLog": dispatch({ type: "toolLog", entry: { id: msg.id, icon: msg.icon, label: msg.label, state: msg.state } }); break;
        case "pageAttached": dispatch({ type: "pageAttached", label: msg.label }); break;
        case "streamEnd":   dispatch({ type: "streamEnd" }); break;
        case "streamError": dispatch({ type: "streamError", error: msg.error, requestId: msg.requestId, runbookUrl: msg.runbookUrl }); break;
        case "actionResult": /* not yet routed to UI */ break;
        case "webviewTestCrash": setShouldCrash(true); break;
      }
    });
    postToHost({ type: "ready" });
    return off;
  }, []);

  // (REQ-C7 crash injection is performed by <CrashIfFlagged> below, which
  // sits INSIDE the ChatErrorBoundary tree. Throwing here in App() instead
  // would crash above the boundary, leaving nothing to catch it.)

  const send = (text: string, images?: string[]) => {
    const trimmed = text.trim();
    const hasImages = !!images && images.length > 0;
    if ((!trimmed && !hasImages) || state.streamingId) return;
    dispatch({ type: "userSent", text: trimmed, images });
    postToHost({ type: "sendMessage", text: trimmed, history: state.messages, images });
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
      <CrashIfFlagged crash={shouldCrash} />
      <ChatPanel
        config={state.config}
        messages={state.messages}
        toolLog={state.toolLog}
        pageNotice={state.pageNotice}
        streaming={!!state.streamingId}
        error={state.error}
        errorRequestId={state.errorRequestId}
        errorRunbookUrl={state.errorRunbookUrl}
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

/**
 * REQ-C7 crash injection. Sits inside the ErrorBoundary tree so a synthetic
 * render-time throw lands in the boundary's componentDidCatch. Production
 * builds never set the flag — it's only triggered by the env-gated
 * HPS_TEST_CRASH_AFTER_MS path on the host side.
 */
function CrashIfFlagged({ crash }: { crash: boolean }) {
  if (crash) {
    throw new Error("hps-test: forced webview crash for REQ-C7 verification");
  }
  return null;
}
