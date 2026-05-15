import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ChatPanelProvider } from "./chatPanelProvider";
import { PreviewProvider } from "./previewProvider";

const TOKEN_KEY = "hypeproofChat.workshopToken";

let providerRef: ChatPanelProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
  // Test-only backdoors. Reads from env vars (which Playwright may not always
  // propagate to the extension host) AND a JSON file in the user-data-dir as
  // a more reliable fallback.
  await applyTestBackdoors(context);

  const preview = new PreviewProvider(context);
  const provider = new ChatPanelProvider(context, preview);
  providerRef = provider;

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
        title: "선생님께 받은 토큰을 넣어주세요",
        prompt: "Workshop token",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "eyJ... 로 시작하는 긴 문자열",
      });
      if (token === undefined) return;
      if (token.trim() === "") {
        await context.secrets.delete(TOKEN_KEY);
        vscode.window.showInformationMessage("HypeProof Chat: token cleared.");
        provider.invalidateProfile();
        provider.refreshConfig();
        return;
      }
      await context.secrets.store(TOKEN_KEY, token.trim());
      provider.invalidateProfile();
      // Re-fetch profile with the new token. If it works, surface the coach
      // naming ritual (the degraded state — no chips, default "코치" — happens
      // precisely when the previous token was bad and profile never loaded).
      const profile = await provider.ensureProfile();
      if (profile) {
        vscode.window.showInformationMessage("토큰 확인 완료! 같이 만들어봐요 🎮");
        if (provider.shouldOfferNamingRitual(profile)) {
          await new Promise((r) => setTimeout(r, 300));
          await provider.runCoachNamingRitual();
        }
      } else {
        vscode.window.showWarningMessage(
          "토큰이 맞는지 확인이 안 돼요. 선생님께 토큰을 다시 받아주세요.",
        );
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

    vscode.commands.registerCommand("hypeproof-chat.renameCoach", async () => {
      await provider.runCoachNamingRitual({ force: true });
    }),
  );

  // Auto-onboarding: close the default welcome editor, focus the chat panel,
  // prompt for a token if none stored, then prompt for coach name.
  void autoOnboard(context, provider);
}

const FIRST_RUN_KEY = "hypeproofChat.didFirstRun";

async function autoOnboard(
  context: vscode.ExtensionContext,
  provider: ChatPanelProvider,
): Promise<void> {
  const isFirstRun = !context.globalState.get<boolean>(FIRST_RUN_KEY);

  if (isFirstRun) {
    try {
      await vscode.workspace
        .getConfiguration("workbench")
        .update("startupEditor", "none", vscode.ConfigurationTarget.Global);
    } catch { /* ignore */ }
    try {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    } catch { /* ignore */ }
    await context.globalState.update(FIRST_RUN_KEY, true);
  }

  // Reveal the chat container.
  try {
    await vscode.commands.executeCommand("workbench.view.extension.hypeproof-chat");
    await vscode.commands.executeCommand("hypeproof-chat.panel.focus");
  } catch { /* ignore */ }

  // 1. Token (if missing) — setToken itself re-fetches profile + runs the
  //    naming ritual on success, so we can return early here.
  const existing = await context.secrets.get(TOKEN_KEY);
  if (!existing) {
    await new Promise((r) => setTimeout(r, 400));
    await vscode.commands.executeCommand("hypeproof-chat.setToken");
    return;
  }

  // 2. Token exists — verify it actually works. A stale/expired token would
  //    otherwise silently degrade the whole UX (no chips, no naming, default
  //    "코치", raw 401 on first message). Re-prompt instead.
  const profile = await provider.ensureProfile();
  if (!profile) {
    await new Promise((r) => setTimeout(r, 400));
    await vscode.commands.executeCommand("hypeproof-chat.setToken");
    return;
  }

  // 3. Coach naming is now driven by an in-panel card (kid-friendly), not a
  //    system input box. The webview shows it when coach.configured is false
  //    and the profile requests user_names_it. Nothing to do here.
}

async function applyTestBackdoors(context: vscode.ExtensionContext): Promise<void> {
  // Source 1: env vars (works when Playwright passes them through to the
  // extension host, which is inconsistent across VS Code versions).
  let token = process.env.HPS_TEST_TOKEN;
  let coachName = process.env.HPS_TEST_COACH_NAME;
  let coachPersonality = process.env.HPS_TEST_COACH_PERSONALITY ?? "";

  // Source 2: a JSON file the test fixture writes into the user-data-dir,
  // typically <userDataDir>/User/hps-test-state.json. Always wins over env
  // (file is more explicit + more reliable).
  try {
    const candidates = [
      path.join(context.globalStorageUri.fsPath, "..", "..", "..", "User", "hps-test-state.json"),
      path.join(os.homedir(), ".hps-test-state.json"),
    ];
    for (const f of candidates) {
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, "utf8")) as {
          token?: string;
          coach?: { name?: string; personality?: string };
        };
        if (j.token) token = j.token;
        if (j.coach?.name) coachName = j.coach.name;
        if (j.coach?.personality) coachPersonality = j.coach.personality;
        break;
      }
    }
  } catch { /* ignore — file missing or unparseable */ }

  if (token && token.length > 0) {
    await context.secrets.store(TOKEN_KEY, token);
  }
  if (coachName && coachName.length > 0) {
    await context.globalState.update("hypeproofChat.coach", {
      name: coachName,
      personality: coachPersonality,
      configured: true,
    });
    await context.globalState.update("hypeproofChat.coachRitualDone", true);
  }
}

export function deactivate() {
  providerRef = null;
}

export { TOKEN_KEY };
