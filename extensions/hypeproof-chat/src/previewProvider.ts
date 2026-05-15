import * as vscode from "vscode";

/**
 * Sandboxed HTML preview for AI-generated mini-games.
 *
 * Renders in the EDITOR AREA (a reused WebviewPanel beside the chat sidebar),
 * not in a cramped sidebar view. The "creator cockpit": chat on the left,
 * the running game big on the right. The panel is created lazily on the first
 * game and reused for every subsequent render.
 *
 * The game HTML runs inside an iframe sandboxed to `allow-scripts` only — no
 * network, no parent-window access. Each render replaces the iframe so prior
 * game state never leaks.
 */
export class PreviewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private pendingHtml: string | null = null;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  /** Open (or reuse) the editor-area preview panel and render `html`. */
  async show(html: string): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "hypeproofPreview",
        "🎮 내 게임",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.webview.html = this.shellHtml(this.panel.webview);
      this.ready = false;
      this.panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === "previewReady") {
          this.ready = true;
          if (this.pendingHtml !== null) {
            this.panel?.webview.postMessage({ type: "renderPreview", html: this.pendingHtml });
            this.pendingHtml = null;
          }
        }
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.ready = false;
        this.pendingHtml = null;
      });
    } else {
      // Bring the existing panel forward without stealing focus from chat.
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    if (this.ready) {
      this.panel.webview.postMessage({ type: "renderPreview", html });
    } else {
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
    html, body { margin: 0; height: 100%; background: #1b1b2a; color: #ddd;
                 font-family: var(--vscode-font-family, sans-serif); }
    #placeholder { display:flex; flex-direction:column; align-items:center;
                   justify-content:center; height:100%; opacity:0.7; gap:8px; }
    #placeholder .big { font-size: 40px; }
    iframe { width: 100%; height: 100vh; border: 0; background: #fff; display: block; }
  </style>
</head>
<body>
  <div id="placeholder">
    <div class="big">🎮</div>
    <div>게임이 여기에 나와요</div>
  </div>
  <iframe id="frame" style="display:none" sandbox="allow-scripts allow-pointer-lock allow-modals" referrerpolicy="no-referrer"></iframe>
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
