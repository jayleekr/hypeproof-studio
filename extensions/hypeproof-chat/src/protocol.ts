// Shared message contract between extension host (Node) and webview (browser).
// Import this file from both sides; do not redefine these types anywhere else.

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

export interface ChatConfig {
  proxyUrl: string;
  model: string;
  hasToken: boolean;
}

// Webview → Host
export type WebviewMessage =
  | { type: "ready" }
  | { type: "sendMessage"; text: string; history: ChatMessage[] }
  | { type: "cancelStream"; streamId: string }
  | { type: "requestAction"; action: ActionRequest }
  | { type: "openSettings" }
  | { type: "setToken" }
  | { type: "clearHistory" }
  | { type: "runCode"; html: string }       // from chat panel → host → preview
  | { type: "previewReady" };               // from preview webview only

// Host → Webview
export type HostMessage =
  | { type: "config"; config: ChatConfig }
  | { type: "history"; messages: ChatMessage[] }
  | { type: "streamStart"; streamId: string; messageId: string }
  | { type: "streamChunk"; streamId: string; delta: string }
  | { type: "streamEnd"; streamId: string }
  | { type: "streamError"; streamId: string; error: string }
  | { type: "actionResult"; requestId: string; approved: boolean }
  | { type: "renderPreview"; html: string };

export interface ActionRequest {
  requestId: string;
  kind: "writeFile" | "executeShell";
  description: string;
  payload: unknown;
}
