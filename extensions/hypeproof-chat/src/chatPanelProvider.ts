import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { TOKEN_KEY } from "./extension";
import { proxyChat } from "./proxyClient";
import { PreviewProvider } from "./previewProvider";
import { ChatMessage, HostMessage, WebviewMessage, ActionRequest } from "./protocol";

const HISTORY_KEY = "hypeproofChat.history";
const HISTORY_MAX = 200;

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private activeStreams = new Map<string, AbortController>();
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly preview: PreviewProvider,
  ) {}

  extractLastRenderableCode(): string | null {
    const messages = this.context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const html = extractRenderableHtml(m.content);
      if (html) return html;
    }
    return null;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webviewDist = vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewDist],
    };
    view.webview.html = this.renderHtml(view.webview, webviewDist);

    view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg));
    view.onDidDispose(() => {
      for (const ctrl of this.activeStreams.values()) ctrl.abort();
      this.activeStreams.clear();
    });
  }

  refreshConfig() {
    void this.postConfig();
  }

  async clearHistory(): Promise<void> {
    await this.context.workspaceState.update(HISTORY_KEY, []);
    void this.post({ type: "history", messages: [] });
  }

  // ---- internals ----

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.postConfig();
        await this.postHistory();
        return;
      case "sendMessage":
        await this.handleSend(msg.text, msg.history);
        return;
      case "cancelStream":
        this.activeStreams.get(msg.streamId)?.abort();
        return;
      case "requestAction":
        await this.handleActionRequest(msg.action);
        return;
      case "openSettings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "hypeproofChat");
        return;
      case "setToken":
        void vscode.commands.executeCommand("hypeproof-chat.setToken");
        return;
      case "clearHistory":
        void this.clearHistory();
        return;
      case "runCode":
        void this.preview.show(msg.html);
        return;
      case "previewReady":
        return;
    }
  }

  private async handleSend(text: string, history: ChatMessage[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    const proxyUrl = cfg.get<string>("proxyUrl", "https://api.hypeproof.ai/v1");
    const model = cfg.get<string>("model", "hypeproof-default");
    const token = await this.context.secrets.get(TOKEN_KEY);

    const streamId = randomId();
    const messageId = randomId();
    const ctrl = new AbortController();
    this.activeStreams.set(streamId, ctrl);

    void this.post({ type: "streamStart", streamId, messageId });

    let assistantText = "";
    try {
      await proxyChat({
        proxyUrl,
        model,
        token,
        history,
        userText: text,
        signal: ctrl.signal,
        onDelta: (delta) => {
          assistantText += delta;
          void this.post({ type: "streamChunk", streamId, delta });
        },
      });
      void this.post({ type: "streamEnd", streamId });
      await this.appendHistory([
        { id: randomId(), role: "user", content: text, createdAt: Date.now() },
        { id: messageId, role: "assistant", content: assistantText, createdAt: Date.now() },
      ]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      void this.post({ type: "streamError", streamId, error: reason });
    } finally {
      this.activeStreams.delete(streamId);
    }
  }

  private async handleActionRequest(req: ActionRequest): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    const required = cfg.get<string[]>("requireApprovalFor", ["writeFile", "executeShell"]);
    const needsApproval = required.includes(req.kind);

    let approved = !needsApproval;
    if (needsApproval) {
      const pick = await vscode.window.showWarningMessage(
        `HypeProof Chat wants to ${req.kind}:\n\n${req.description}`,
        { modal: true },
        "Approve",
        "Deny",
      );
      approved = pick === "Approve";
    }

    void this.post({ type: "actionResult", requestId: req.requestId, approved });
  }

  private async postConfig(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("hypeproofChat");
    const token = await this.context.secrets.get(TOKEN_KEY);
    await this.post({
      type: "config",
      config: {
        proxyUrl: cfg.get<string>("proxyUrl", "https://api.hypeproof.ai/v1"),
        model: cfg.get<string>("model", "hypeproof-default"),
        hasToken: !!token,
      },
    });
  }

  private async postHistory(): Promise<void> {
    const messages = this.context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
    await this.post({ type: "history", messages });
  }

  private async appendHistory(msgs: ChatMessage[]): Promise<void> {
    const current = this.context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
    const next = [...current, ...msgs].slice(-HISTORY_MAX);
    await this.context.workspaceState.update(HISTORY_KEY, next);
  }

  private async post(msg: HostMessage): Promise<boolean | void> {
    if (!this.view) return;
    return this.view.webview.postMessage(msg);
  }

  private renderHtml(webview: vscode.Webview, distDir: vscode.Uri): string {
    const indexPath = path.join(distDir.fsPath, "index.html");
    if (!fs.existsSync(indexPath)) {
      return /* html */ `<!doctype html><html><body style="font-family:sans-serif;padding:20px">
        <h3>HypeProof Chat — webview not built</h3>
        <p>Run <code>npm run build:webview</code> in <code>extensions/hypeproof-chat/</code>.</p>
      </body></html>`;
    }
    let html = fs.readFileSync(indexPath, "utf8");
    // Rewrite asset URIs to vscode-resource scheme.
    html = html.replace(/(src|href)="(\/[^"]+)"/g, (_m, attr, src) => {
      const onDisk = vscode.Uri.joinPath(distDir, src.replace(/^\//, ""));
      return `${attr}="${webview.asWebviewUri(onDisk)}"`;
    });
    const nonce = randomId();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
    ].join("; ");
    html = html.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);
    return html;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Pull renderable HTML out of an assistant message. Order of preference:
 *   1. ```html fenced block
 *   2. Full <!doctype html...> document anywhere in the text
 *   3. ```javascript or ```js block → wrap into a minimal HTML shell
 * Returns null if nothing renderable found.
 */
export function extractRenderableHtml(text: string): string | null {
  // 1. ```html fenced block
  const htmlFence = /```(?:html|HTML)\s*\n([\s\S]*?)\n```/.exec(text);
  if (htmlFence) return htmlFence[1].trim();

  // 2. Inline <!doctype html> ... </html>
  const doctype = /<!doctype\s+html[\s\S]*?<\/html\s*>/i.exec(text);
  if (doctype) return doctype[0];

  // 3. JS block → wrap
  const jsFence = /```(?:javascript|js)\s*\n([\s\S]*?)\n```/.exec(text);
  if (jsFence) {
    const js = jsFence[1].trim();
    return `<!doctype html>
<html><head><meta charset="utf-8"><style>body{margin:0;font-family:sans-serif;padding:12px}</style></head>
<body><script>
try { ${js} } catch (err) { document.body.innerHTML = '<pre style="color:#c00">'+ err +'</pre>'; }
</script></body></html>`;
  }

  return null;
}
