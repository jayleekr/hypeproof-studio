import * as vscode from "vscode";
import { ChatPanelProvider } from "./chatPanelProvider";
import { PreviewProvider } from "./previewProvider";

const TOKEN_KEY = "hypeproofChat.workshopToken";

export function activate(context: vscode.ExtensionContext) {
  const preview = new PreviewProvider(context);
  const provider = new ChatPanelProvider(context, preview);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("hypeproof-chat.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("hypeproof-chat.preview", preview, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("hypeproof-chat.focus", () => {
      vscode.commands.executeCommand("hypeproof-chat.panel.focus");
    }),

    vscode.commands.registerCommand("hypeproof-chat.clearHistory", async () => {
      await provider.clearHistory();
      vscode.window.showInformationMessage("HypeProof Chat: conversation cleared.");
    }),

    vscode.commands.registerCommand("hypeproof-chat.setToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Workshop token (will be stored in VS Code Secret Storage)",
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined) return;
      if (token === "") {
        await context.secrets.delete(TOKEN_KEY);
        vscode.window.showInformationMessage("HypeProof Chat: token cleared.");
      } else {
        await context.secrets.store(TOKEN_KEY, token);
        vscode.window.showInformationMessage("HypeProof Chat: token saved.");
      }
      provider.refreshConfig();
    }),

    vscode.commands.registerCommand("hypeproof-chat.runLastCode", async () => {
      const html = provider.extractLastRenderableCode();
      if (!html) {
        vscode.window.showWarningMessage("HypeProof Chat: 마지막 응답에서 실행할 코드가 없어요.");
        return;
      }
      await preview.show(html);
    }),
  );
}

export function deactivate() {
  /* no-op */
}

export { TOKEN_KEY };
