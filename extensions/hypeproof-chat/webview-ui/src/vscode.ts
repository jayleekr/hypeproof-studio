import type { HostMessage, WebviewMessage } from "../../src/protocol";

interface VSCodeApi {
  postMessage(msg: WebviewMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VSCodeApi;
  }
}

let api: VSCodeApi | null = null;
if (typeof window.acquireVsCodeApi === "function") {
  api = window.acquireVsCodeApi();
}

export function postToHost(msg: WebviewMessage): void {
  if (api) api.postMessage(msg);
  else console.warn("[hypeproof-chat] no vscode api — running outside webview?", msg.type);
}

export function onHostMessage(handler: (m: HostMessage) => void): () => void {
  const listener = (ev: MessageEvent) => handler(ev.data as HostMessage);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
