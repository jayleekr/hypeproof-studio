import * as vscode from "vscode";

const VIEW_TYPE = "hypeproof-chat.preview";

/**
 * Sandboxed HTML preview for AI-generated mini-games. Renders user-supplied
 * HTML inside an iframe sandboxed to `allow-scripts` only — no network access,
 * no parent-window access. Each render replaces the iframe completely so prior
 * state doesn't leak.
 */
export class PreviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pendingHtml: string | null = null;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.shellHtml(view.webview);

    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "previewReady" && this.pendingHtml !== null) {
        view.webview.postMessage({ type: "renderPreview", html: this.pendingHtml });
        this.pendingHtml = null;
      }
    });
  }

  async show(html: string): Promise<void> {
    // Focus the preview view first
    await vscode.commands.executeCommand(`${VIEW_TYPE}.focus`);

    if (this.view) {
      this.view.webview.postMessage({ type: "renderPreview", html });
    } else {
      // View not yet resolved; queue and let resolveWebviewView pick it up via previewReady
      this.pendingHtml = html;
    }
  }

  private shellHtml(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `frame-src 'self' data: blob:`,
    ].join("; ");
    return /* html */ `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    html, body { margin: 0; height: 100%; background: #1e1e1e; color: #ddd; font-family: var(--vscode-font-family, sans-serif); }
    #placeholder { padding: 16px; opacity: 0.7; line-height: 1.5; }
    iframe { width: 100%; height: 100%; border: 0; background: #fff; }
  </style>
</head>
<body>
  <div id="placeholder">
    <p>🎮 게임 미리보기</p>
    <p>채팅에서 "▶ Run" 버튼을 누르면 여기에 결과가 보입니다.</p>
  </div>
  <iframe id="frame" style="display:none" sandbox="allow-scripts allow-pointer-lock" referrerpolicy="no-referrer"></iframe>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById("frame");
    const placeholder = document.getElementById("placeholder");
    window.addEventListener("message", (ev) => {
      const m = ev.data || {};
      if (m.type === "renderPreview" && typeof m.html === "string") {
        placeholder.style.display = "none";
        frame.style.display = "block";
        frame.srcdoc = m.html;
      }
    });
    vscode.postMessage({ type: "previewReady" });
  </script>
</body>
</html>`;
  }
}
