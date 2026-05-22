import * as vscode from "vscode";
import * as path from "node:path";
import { buildPreviewShellCsp, PREVIEW_IFRAME_SANDBOX } from "./cspBuilder";
import { sanitizeArtifactEntry, ARTIFACT_FILES, applyPlaceholderDefaults } from "./previewArtifacts";

/**
 * Sandboxed HTML preview for AI-generated webapps.
 *
 * Renders in the EDITOR AREA (a reused WebviewPanel beside the chat sidebar),
 * not in a cramped sidebar view. The "creator cockpit": chat on the left,
 * the running webapp big on the right. The panel is created lazily on the
 * first render and reused for every subsequent render.
 *
 * The HTML runs inside an iframe sandboxed to `allow-scripts` only — no
 * `allow-same-origin`, no network, no `acquireVsCodeApi` access. The iframe
 * can still post messages to its parent (cross-document `postMessage` is
 * allowed regardless of sandbox); the shell forwards `request_action`
 * messages to the host, which surfaces a manual-approve modal (#155).
 */
export class PreviewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private pendingHtml: string | null = null;
  private labels: { title: string; placeholder: string; emoji: string } = {
    title: "🎮 내 게임",
    placeholder: "게임이 여기에 나와요",
    emoji: "🎮",
  };

  constructor(private readonly _context: vscode.ExtensionContext) {}

  /**
   * Update the panel title + placeholder copy for the current cohort tone.
   * Call this whenever the resolved profile changes (e.g. after token set).
   */
  setLabels(labels: { title: string; placeholder: string; emoji: string }): void {
    this.labels = labels;
    if (this.panel) {
      this.panel.title = labels.title;
      // Re-render shell to update inline placeholder (cheap; iframe contents
      // are re-posted on the next show()).
      this.panel.webview.html = this.shellHtml(this.panel.webview);
      this.ready = false;
    }
  }

  /** Open (or reuse) the editor-area preview panel and render `html`. */
  async show(html: string): Promise<void> {
    // Replace any unresolved `%%KEY%%` with sensible defaults (#161). Lets
    // partial LLM responses still render a recognizable V1.
    html = applyPlaceholderDefaults(html);
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "hypeproofPreview",
        this.labels.title,
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
        } else if (msg?.type === "preview_request_action") {
          void this.handlePreviewRequestAction(msg);
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

  /**
   * Handle a `request_action` postMessage that bubbled up from the
   * inner sandboxed iframe (e.g. verdict-card's [규칙 저장] button).
   *
   * Flow: modal-gated approval (REQ-E1/E2) → append to
   * `workshop-output/<artifact>.{md,log}` in the active workspace.
   * No write happens without explicit user click.
   */
  private async handlePreviewRequestAction(
    msg: { action?: string; payload?: { artifact?: string; entry?: string } },
  ): Promise<void> {
    if (msg.action !== "append_artifact") {
      vscode.window.showWarningMessage(`HypeProof: 알 수 없는 preview action: ${msg.action ?? "(none)"}`);
      return;
    }
    const artifact = msg.payload?.artifact;
    const entry = msg.payload?.entry;
    if (typeof artifact !== "string" || typeof entry !== "string") {
      return;
    }
    const target = ARTIFACT_FILES[artifact as keyof typeof ARTIFACT_FILES];
    if (!target) {
      vscode.window.showWarningMessage(`HypeProof: 지원하지 않는 artifact: ${artifact}`);
      return;
    }

    const safeEntry = sanitizeArtifactEntry(entry);
    if (!safeEntry) return;

    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage("HypeProof: 작업 폴더가 열려있지 않아요. 폴더를 먼저 열어주세요.");
      return;
    }

    const folderUri = vscode.Uri.joinPath(ws.uri, "workshop-output");
    const fileUri = vscode.Uri.joinPath(folderUri, target);

    const pick = await vscode.window.showWarningMessage(
      `다음 ${target} 항목을 저장할까요?\n\n${safeEntry}`,
      { modal: true },
      "저장",
      "취소",
    );
    if (pick !== "저장") {
      this.panel?.webview.postMessage({ type: "previewActionResult", action: "append_artifact", artifact, ok: false });
      return;
    }

    try {
      await vscode.workspace.fs.createDirectory(folderUri);
    } catch { /* exists is fine */ }

    let existing = "";
    try {
      const buf = await vscode.workspace.fs.readFile(fileUri);
      existing = Buffer.from(buf).toString("utf8");
    } catch { /* fresh file */ }

    const stamp = new Date().toISOString();
    const line = `- ${stamp} · ${safeEntry}\n`;
    const next = existing ? existing + line : `# ${path.basename(target)}\n\n${line}`;
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(next, "utf8"));

    this.panel?.webview.postMessage({ type: "previewActionResult", action: "append_artifact", artifact, ok: true });
    vscode.window.showInformationMessage(`HypeProof: ${target}에 저장됐어요.`);
  }

  private shellHtml(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const csp = buildPreviewShellCsp({ cspSource: webview.cspSource, nonce });
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
    <div class="big">${this.labels.emoji}</div>
    <div>${this.labels.placeholder}</div>
  </div>
  <iframe id="frame" style="display:none" sandbox="${PREVIEW_IFRAME_SANDBOX}" referrerpolicy="no-referrer"></iframe>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById("frame");
    const placeholder = document.getElementById("placeholder");

    // host → shell → inner iframe
    window.addEventListener("message", (ev) => {
      const m = ev.data || {};
      if (m.type === "renderPreview" && typeof m.html === "string") {
        placeholder.style.display = "none";
        frame.style.display = "block";
        frame.srcdoc = m.html;
        return;
      }
      // Inner iframe (cross-document postMessage from srcdoc) → forward to host (#155).
      // We only accept a known message shape; everything else is ignored.
      if (ev.source === frame.contentWindow && m && typeof m === "object") {
        if (m.type === "request_action" && typeof m.action === "string") {
          vscode.postMessage({
            type: "preview_request_action",
            action: m.action,
            payload: m.payload ?? null,
          });
        }
        return;
      }
      // host → shell: forward action result back into the inner iframe so the
      // card can flip its status. (sandboxed iframe still receives postMessage.)
      if (m.type === "previewActionResult" && frame.contentWindow) {
        try { frame.contentWindow.postMessage(m, "*"); } catch (_) { /* sandbox quirk */ }
      }
    });

    vscode.postMessage({ type: "previewReady" });
  </script>
</body>
</html>`;
  }
}
