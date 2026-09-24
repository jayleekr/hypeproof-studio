// #1298 — Instructor-mode wrapper. Renders the standard ChatPanel beneath an
// instructor header band that shows connection status, the active model, and
// a model-select UI (dropdown + free-form input). Only mounted when
// config.isInstructor is true (host verified the token via GET /admin/chalk/whoami).

import { useState, useRef } from "react";
import type { ChatConfig, ChatMessage } from "../../src/protocol";
import { postToHost } from "./vscode";
import { ChatPanel } from "./ChatPanel";

interface Props {
  config: ChatConfig | null;
  incomingImage: { dataUrl: string; nonce: number } | null;
  messages: ChatMessage[];
  pageNotice: string | null;
  aiNotice: string | null;
  stopNotice: string | null;
  openWorldId: string | null;
  publish:
    | { state: "uploading" }
    | { state: "done"; url: string }
    | { state: "error"; message: string }
    | null;
  onPublish: () => void;
  streaming: boolean;
  streamingId: string | null;
  error: string | null;
  errorRequestId: string | null;
  errorRunbookUrl: string | null;
  canRetryLast: boolean;
  onSend: (text: string, images?: string[]) => void;
  onRetry: (prompt: string) => void;
  onRetryLast: () => void;
  onDismissError: () => void;
  onCancel: () => void;
  onClear: () => void;
  onSetToken: () => void;
  onSettings: () => void;
  onRunCode: (html: string) => void;
  onNamingRitual: () => void;
  onSaveCoach: (name: string, personality: string) => void;
  onReportProblem: () => void;
  onInstallUpdate: () => void;
  onDismissUpdate: (version: string) => void;
}

export function InstructorChatPanel(props: Props) {
  const { config } = props;
  const [directInput, setDirectInput] = useState("");
  const [directError, setDirectError] = useState<string | null>(null);
  // Keep the last confirmed model so we can revert on invalid input.
  const lastGoodModel = useRef(config?.model ?? "");

  if (config?.model && config.model !== lastGoodModel.current && !directError) {
    lastGoodModel.current = config.model;
  }

  function handleDropdownChange(alias: string) {
    setDirectInput("");
    setDirectError(null);
    postToHost({ type: "selectModel", alias });
  }

  function handleDirectSubmit() {
    const id = directInput.trim();
    if (!id) return;
    // Optimistic: post immediately; the host validates and either applies or
    // returns an error via config (the error path is handled in chatPanelProvider).
    postToHost({ type: "selectModelDirect", modelId: id });
    setDirectInput("");
  }

  function handleDirectKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleDirectSubmit();
    }
    if (e.key === "Escape") {
      setDirectInput("");
      setDirectError(null);
    }
  }

  // Surface model validation errors pushed by the host as config updates.
  // The host sets config.model back to the previous value on invalid input.
  const choices = config?.profile?.model_selection?.choices ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="hps-instructor-band" role="status" aria-live="polite">
        <span className="hps-instructor-badge">강사 모드</span>
        <span className="hps-instructor-model">{config?.model ?? "—"}</span>

        {choices.length > 0 && (
          <select
            aria-label="모델 선택"
            value={config?.model ?? ""}
            onChange={(e) => handleDropdownChange(e.target.value)}
            disabled={props.streaming}
          >
            {choices.map((c) => (
              <option key={c.id} value={c.alias}>{c.label}</option>
            ))}
          </select>
        )}

        <input
          type="text"
          className="hps-instructor-model-input"
          placeholder="model-id 직접 입력 후 Enter"
          value={directInput}
          onChange={(e) => { setDirectInput(e.target.value); setDirectError(null); }}
          onKeyDown={handleDirectKeyDown}
          onBlur={handleDirectSubmit}
          disabled={props.streaming}
          aria-label="모델 ID 직접 입력"
        />
        {directError && (
          <span className="hps-instructor-model-error" role="alert">{directError}</span>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatPanel {...props} />
      </div>
    </div>
  );
}
