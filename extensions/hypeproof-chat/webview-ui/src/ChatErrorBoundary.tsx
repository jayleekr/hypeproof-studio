// React error boundary — catches render-time crashes in ChatPanel and shows
// a friendly fallback instead of a blank panel.
//
// S-04 (#48). Pre-this, an exception inside any sub-component (CodePill,
// AssistantContent, etc.) blanked the whole webview — fatal in front of an
// audience. This boundary keeps the shell alive, surfaces the error, and
// offers a reload button that re-mounts the tree.
//
// SSE transport errors are a separate path (they come in as `streamError`
// messages and are rendered as an inline banner inside ChatPanel — this
// boundary only sees React render/lifecycle exceptions).

import { Component, type ErrorInfo, type ReactNode } from "react";
import { postToHost } from "./vscode";

interface Props {
  children: ReactNode;
}

interface State {
  err: Error | null;
}

export class ChatErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    // Post a structured signal to the host so it lands in Workers Logs /
    // wrangler tail with the component stack. The host already logs to its
    // own output channel; this just makes the trace land somewhere we can
    // recover post-incident.
    try {
      postToHost({
        type: "webviewError",
        message: err.message,
        stack: err.stack ?? "",
        componentStack: info.componentStack ?? "",
      });
    } catch {
      /* postMessage can fail during teardown — swallow */
    }
  }

  private reload = (): void => {
    // Clearing state remounts children. If the error is in a sub-component
    // and only triggered by certain data, the new mount avoids it.
    this.setState({ err: null });
  };

  render(): ReactNode {
    const { err } = this.state;
    if (!err) return this.props.children;

    return (
      <div className="hps-shell">
        <div className="hps-fatal">
          <div className="hps-fatal-icon">⚠️</div>
          <h2 className="hps-fatal-title">화면을 그리다가 멈췄어요</h2>
          <p className="hps-fatal-sub">
            대화는 안전하게 저장됐어요. 아래 버튼으로 다시 열 수 있어요.
          </p>
          <pre className="hps-fatal-detail">{err.message}</pre>
          <div className="hps-fatal-row">
            <button className="hps-fatal-btn" onClick={this.reload}>
              다시 열기
            </button>
            <button
              className="hps-fatal-btn-ghost"
              onClick={() => postToHost({ type: "openSettings" })}
              title="문제가 계속되면 설정 → 다시 시작"
            >
              설정 열기
            </button>
          </div>
        </div>
      </div>
    );
  }
}
