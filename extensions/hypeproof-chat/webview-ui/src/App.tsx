import { useEffect, useReducer, useState } from "react";
import type { AssetScoreChunk, ChatConfig, ChatMessage, Citation, HostMessage } from "../../src/protocol";
import {
  emptyTimeline,
  timelineCitations,
  timelineDelta,
  timelineEnd,
  timelineReset,
  timelineStart,
  timelineTool,
  type TimelineState,
  type ToolEntry,
} from "../../src/chatTimeline";
import { onHostMessage, postToHost } from "./vscode";
import { ChatPanel } from "./ChatPanel";
import { ChatErrorBoundary } from "./ChatErrorBoundary";

interface State {
  config: ChatConfig | null;
  /**
   * #503 — 대화와 툴 실행이 **하나의 배열**이다. 예전에는 messages 와 toolLog 가
   * 평행선 두 개였고, 그래서 화면이 [말풍선 전부] 아래 [툴 전부] 로 그려졌다.
   */
  timeline: TimelineState;
  streamId: string | null;
  error: string | null;
  errorRequestId: string | null;   // S-07 / #49 — surfaced in ErrorBanner
  errorRunbookUrl: string | null;  // #165 — banner renders as clickable link
  assetScore: AssetScoreChunk | null;
  pageNotice: string | null;        // #308 — "페이지를 코치에게" 인라인 안내 (토스트 대체)
  aiNotice: string | null;          // #320 — AI disclosure at session start (host-gated)
  stopNotice: string | null;        // #497 — Stop 을 눌러 턴이 끊겼음을 알리는 인라인 안내
  /** #649 — 지금 열려 있는 세상 id. 친구 스트립이 이 버튼을 강조한다(aria-pressed). */
  openWorldId: string | null;
}

type Action =
  | { type: "config"; config: ChatConfig }
  | { type: "history"; messages: ChatMessage[] }
  | { type: "streamStart"; streamId: string; messageId: string }
  | { type: "streamChunk"; delta: string }
  | { type: "streamCitations"; citations: Citation[] }
  | { type: "streamAssetScore"; assetScore: AssetScoreChunk }
  | { type: "toolLog"; entry: ToolEntry }
  | { type: "pageAttached"; label: string }
  | { type: "aiDisclosure"; text: string }
  | { type: "streamEnd" }
  | { type: "streamStopped" }
  | { type: "worldOpened"; id: string }
  | { type: "streamError"; error: string; requestId?: string; runbookUrl?: string }
  | { type: "userSent"; text: string; images?: string[] };

// #497 — 사용자가 Stop 을 눌렀을 때의 안내. 오류가 아니므로 에러 배너를 쓰지
// 않는다 ("문제가 생겼어요" + 🚨 신고하기 는 정상 조작을 사고로 만든다).
const STOP_NOTICE = "답변 생성이 중지되었습니다. 다시 채팅을 입력해주세요.";

const initialState: State = {
  config: null,
  timeline: emptyTimeline(),
  streamId: null,
  error: null,
  errorRequestId: null,
  errorRunbookUrl: null,
  assetScore: null,
  pageNotice: null,
  aiNotice: null,
  stopNotice: null,
  openWorldId: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "config":
      return { ...state, config: action.config };
    case "history":
      // 대화·툴·에러가 한 번에 갈린다. Clear 를 눌러도 직전 턴의 툴 호출 목록이
      // 화면에 남아 있었다(2026-07-27 실사용) — 이제 툴이 타임라인의 일부라
      // 배열 하나를 갈아끼우면 끝이다.
      return { ...state, timeline: timelineReset(action.messages), error: null };
    case "streamStart":
      return {
        ...state,
        streamId: action.streamId,
        error: null,
        stopNotice: null,   // #497 — 새 턴이 시작되면 이전 중지 안내는 사라진다
        assetScore: null,
        // #503 — 직전 턴의 툴 줄을 **비우지 않는다**. 예전에는 여기서 toolLog 를
        // [] 로 밀어서, 다음 턴이 시작되는 순간 이전 턴이 무슨 도구를 썼는지가
        // 통째로 증발했다(스크롤을 올려도 말풍선만 남았다).
        timeline: timelineStart(state.timeline, action.messageId, Date.now()),
      };
    case "streamChunk":
      return { ...state, timeline: timelineDelta(state.timeline, action.delta, Date.now()) };
    case "streamCitations":
      return { ...state, timeline: timelineCitations(state.timeline, action.citations) };
    case "streamAssetScore":
      return { ...state, assetScore: action.assetScore };
    case "toolLog":
      // 같은 id 는 제자리 갱신(running → done/error), 새 id 는 지금 이 자리에 삽입.
      return { ...state, timeline: timelineTool(state.timeline, action.entry, Date.now()) };
    case "pageAttached":
      // #308 — inline notice; cleared on the next send (userSent) only.
      return { ...state, pageNotice: action.label };
    case "worldOpened":
      return { ...state, openWorldId: action.id };
    case "aiDisclosure":
      // #320 — session-start AI disclosure. The host gates when this arrives
      // (once per session + after clear); the webview just keeps it visible
      // for the rest of this mount. Replaces, never appends.
      return { ...state, aiNotice: action.text };
    case "streamEnd":
      return {
        ...state,
        streamId: null,
        timeline: timelineEnd(state.timeline, Date.now()),
        error: null,
        errorRequestId: null,
        errorRunbookUrl: null,
      };
    case "streamStopped":
      // #497 — 턴이 완주한 게 아니라 사용자가 끊은 것. streamEnd 와 같은 상태
      // 해제를 하되, 무슨 일이 있었는지 한 줄 남긴다. 여기까지 스트리밍된 부분
      // 답변은 화면에 그대로 두고(무엇이 만들어졌는지 보이는 편이 낫다),
      // 호스트는 이 턴을 영속 히스토리에 커밋하지 않는다.
      return {
        ...state,
        streamId: null,
        // #503 — 끊긴 턴도 타임라인은 닫는다: 보류된 툴 줄이 남아 있으면
        // 흘려 넣고 말풍선을 닫는다. 스트리밍된 부분 답변은 그대로 둔다.
        timeline: timelineEnd(state.timeline, Date.now()),
        error: null,
        errorRequestId: null,
        errorRunbookUrl: null,
        stopNotice: STOP_NOTICE,
      };
    case "streamError":
      return {
        ...state,
        streamId: null,
        timeline: timelineEnd(state.timeline, Date.now()),
        error: action.error,
        errorRequestId: action.requestId ?? null,
        errorRunbookUrl: action.runbookUrl ?? null,
      };
    case "userSent":
      return {
        ...state,
        pageNotice: null,   // #308 — clear the "붙였어요" notice once the user sends
        stopNotice: null,   // #497 — 다시 입력했으면 중지 안내는 역할을 다했다
        timeline: {
          ...state.timeline,
          items: [
            ...state.timeline.items,
            {
              id: `local-${Date.now()}`,
              role: "user",
              content: action.text,
              createdAt: Date.now(),
              ...(action.images && action.images.length > 0 ? { images: action.images } : {}),
            },
          ],
        },
      };
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [shouldCrash, setShouldCrash] = useState(false);
  // #384 — image handed over from the host (an image opened in an editor tab).
  // nonce forces ChatPanel's effect to re-run even for the same dataUrl.
  const [incomingImage, setIncomingImage] = useState<{ dataUrl: string; nonce: number } | null>(null);

  useEffect(() => {
    const off = onHostMessage((msg: HostMessage) => {
      switch (msg.type) {
        case "config":      dispatch({ type: "config", config: msg.config }); break;
        case "history":     dispatch({ type: "history", messages: msg.messages }); break;
        case "streamStart": dispatch({ type: "streamStart", streamId: msg.streamId, messageId: msg.messageId }); break;
        case "streamChunk": dispatch({ type: "streamChunk", delta: msg.delta }); break;
        case "streamCitations": dispatch({ type: "streamCitations", citations: msg.citations }); break;
        case "streamAssetScore": dispatch({ type: "streamAssetScore", assetScore: msg.assetScore }); break;
        case "toolLog": dispatch({ type: "toolLog", entry: { id: msg.id, icon: msg.icon, label: msg.label, state: msg.state, ...(msg.at ? { at: msg.at } : {}) } }); break;
        case "pageAttached": dispatch({ type: "pageAttached", label: msg.label }); break;
        case "aiDisclosure": dispatch({ type: "aiDisclosure", text: msg.text }); break;
        case "worldOpened": dispatch({ type: "worldOpened", id: msg.id }); break;
        case "streamEnd":   dispatch({ type: "streamEnd" }); break;
        case "streamStopped": dispatch({ type: "streamStopped" }); break;
        case "streamError": dispatch({ type: "streamError", error: msg.error, requestId: msg.requestId, runbookUrl: msg.runbookUrl }); break;
        case "actionResult": /* not yet routed to UI */ break;
        case "attachImage": setIncomingImage({ dataUrl: msg.dataUrl, nonce: Date.now() }); break;
        case "webviewTestCrash": setShouldCrash(true); break;
      }
    });
    postToHost({ type: "ready" });
    return off;
  }, []);

  // (REQ-C7 crash injection is performed by <CrashIfFlagged> below, which
  // sits INSIDE the ChatErrorBoundary tree. Throwing here in App() instead
  // would crash above the boundary, leaving nothing to catch it.)

  // #503 — 화면과 히스토리는 같은 배열이다. 호스트로 넘어간 뒤 모델로 나가기
  // 전에 role:"tool" 이 걸러진다(chatTimeline.modelHistory).
  const messages = state.timeline.items;

  const send = (text: string, images?: string[]) => {
    const trimmed = text.trim();
    const hasImages = !!images && images.length > 0;
    if ((!trimmed && !hasImages) || state.streamId) return;
    dispatch({ type: "userSent", text: trimmed, images });
    postToHost({ type: "sendMessage", text: trimmed, history: messages, images });
  };

  const retry = (prompt: string) => {
    if (state.streamId) return;
    // Re-send the same user prompt to get a fresh assistant variant.
    dispatch({ type: "userSent", text: prompt });
    postToHost({ type: "retryMessage", prompt, history: messages });
  };

  // S-04 (#48): "다시 보내기" on a stream error reuses the LAST user prompt
  // that's already in history. The worker idempotently writes turn rows so
  // a retry doesn't double-count.
  const retryLast = () => {
    if (state.streamId) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "user") {
        // #358 — re-attach the failed turn's pending image(s). Without this the
        // retry re-sent text only, so the coach replied "스크린샷을 아직 못
        // 받았어요" even though the student did paste one. Images live only on
        // the in-memory message (single-shot, REQ-C11), which is exactly what a
        // same-session retry needs.
        const images = m.images && m.images.length > 0 ? m.images : undefined;
        postToHost({ type: "retryMessage", prompt: m.content, history: messages, images });
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
  const hasLastUserPrompt = messages.some((m) => m.role === "user");

  return (
    <ChatErrorBoundary>
      <CrashIfFlagged crash={shouldCrash} />
      <ChatPanel
        incomingImage={incomingImage}
        config={state.config}
        messages={messages}
        pageNotice={state.pageNotice}
        aiNotice={state.aiNotice}
        stopNotice={state.stopNotice}
        openWorldId={state.openWorldId}
        streaming={!!state.streamId}
        streamingId={state.timeline.openId}
        error={state.error}
        errorRequestId={state.errorRequestId}
        errorRunbookUrl={state.errorRunbookUrl}
        canRetryLast={hasLastUserPrompt && !state.streamId}
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
