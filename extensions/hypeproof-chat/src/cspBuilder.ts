// Pure CSP / sandbox string builders. Kept vscode-free so the security
// posture is unit-testable under plain Node — sandbox laxness is silent
// (the .app still launches), so a failing unit test on CI is the only thing
// that catches a stray `allow-same-origin` slipping in via PR review.

interface ChatPanelCspArgs {
  cspSource: string;          // value of `webview.cspSource`
  nonce: string;
}

/**
 * CSP for the main chat panel webview (host: extension's webview).
 *
 * default-src 'none' forces every directive to be enumerated. We allow:
 *  - img/style/script/font/connect from the webview's own cspSource
 *  - inline styles (Vite emits some) and the per-render nonce'd script tags
 *
 * Do NOT loosen `connect-src` to https: — the chat panel never talks directly
 * to a model API; the host bridges over postMessage to the worker via fetch.
 */
export function buildChatPanelCsp(args: ChatPanelCspArgs): string {
  const { cspSource, nonce } = args;
  return [
    `default-src 'none'`,
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `font-src ${cspSource}`,
    `connect-src ${cspSource}`,
  ].join("; ");
}

interface PreviewShellCspArgs {
  cspSource: string;
  nonce: string;
}

/**
 * CSP for the preview shell webview. The preview hosts an iframe whose
 * srcdoc holds the AI-generated game; the shell itself only renders a
 * placeholder + the iframe and listens for renderPreview messages.
 *
 * frame-src includes 'self' data: blob: so the iframe can use srcdoc
 * (which resolves to about:srcdoc, treated as 'self' for CSP purposes).
 * Crucially, we do NOT include https: — generated game code must not be
 * able to embed remote frames.
 */
export function buildPreviewShellCsp(args: PreviewShellCspArgs): string {
  const { cspSource, nonce } = args;
  return [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `frame-src 'self' data: blob:`,
  ].join("; ");
}

/**
 * Sandbox attribute for the preview iframe that hosts AI-generated game HTML.
 *
 * Allowed: scripts (the game needs JS), pointer-lock (canvas games), modals
 * (alert/confirm).
 *
 * Forbidden by omission:
 *  - allow-same-origin: the game must NOT be able to read parent.acquireVsCodeApi()
 *  - allow-top-navigation: no navigating away from Studio
 *  - allow-popups / allow-popups-to-escape-sandbox: no surprise tabs
 *  - allow-forms: not needed; reduces phishing surface
 *
 * If you change this, you also change the threat model — get a second pair
 * of eyes.
 */
export const PREVIEW_IFRAME_SANDBOX = "allow-scripts allow-pointer-lock allow-modals";
