// The instructor's own surface inside Studio — a native view, not a webview. (#1184)
//
// BASE-01 (역할에 따라 화면을 구분한다) · BASE-02 (수업 설계·구성·리허설·운영) ·
// ARC-02 ("웹 진입과 내장 화면을 구분한다").
//
// ── Why native ────────────────────────────────────────────────────────────
// A webview here would throw away the reason Studio exists for the 강사: the
// editor, the files, the terminal, the preview. A lesson plan is a markdown
// file; Studio already edits markdown. So this surface holds no form and no
// editor of its own — it is a short list of ways into things that already
// work.
//
// ── Why it is not a new activity-bar container ────────────────────────────
// The manifest ships `workbench.activityBar.location: "hidden"` in
// `configurationDefaults`. A second viewsContainer would be addressable only
// by command — invisible. Adding a second VIEW to the existing
// `hypeproof-chat` container makes it a collapsible section of the sidebar
// the 강사 is already looking at, and needs no icon asset (the Dev launcher
// does not copy `media/`, so an icon added there renders as a blank).
//
// ── Why the subtitle is on the view, not the status bar ───────────────────
// Same manifest ships `workbench.statusBar.visible: false`. A status bar item
// would be created and never seen. `TreeView.description` is the visible
// equivalent and follows the same refresh.

import * as vscode from "vscode";
import {
  AUTHORING_CONTEXT_KEY,
  authoringSubtitle,
  resolveAuthoringAccess,
  type AuthoringAccess,
} from "./authoringAccess.ts";
import { ISSUER_TOKEN_KEY } from "./mintStudentTokenHelpers.ts";
import {
  CHALK_ACTIONS,
  CHALK_VIEW_ID,
  LESSON_PLAN_FILENAME,
  chalkConsoleUrl,
  lessonPlanTemplate,
  type ChalkAction,
} from "./chalkSurfaceHelpers.ts";

export * from "./chalkSurfaceHelpers.ts";

class ChalkTreeProvider implements vscode.TreeDataProvider<ChalkAction> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(element?: ChalkAction): ChalkAction[] {
    return element ? [] : [...CHALK_ACTIONS];
  }

  getTreeItem(action: ChalkAction): vscode.TreeItem {
    const item = new vscode.TreeItem(action.label, vscode.TreeItemCollapsibleState.None);
    item.description = action.detail;
    item.tooltip = action.detail;
    item.iconPath = new vscode.ThemeIcon(action.icon);
    item.command = { command: action.command, title: action.label };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export interface ChalkSurfaceDeps {
  context: vscode.ExtensionContext;
  /** The participant token this window is connected with, if any. */
  participantToken: () => Thenable<string | undefined>;
  /** `hypeproofChat.proxyUrl`, for deriving the Chalk web entry. */
  proxyUrl: () => string;
}

export interface ChalkSurface {
  /** Re-read the tokens and update both the `when` key and the subtitle. */
  sync: () => Promise<AuthoringAccess>;
}

export function registerChalkSurface(deps: ChalkSurfaceDeps): ChalkSurface {
  const { context } = deps;
  const provider = new ChalkTreeProvider();
  const view = vscode.window.createTreeView(CHALK_VIEW_ID, { treeDataProvider: provider });

  const sync = async (): Promise<AuthoringAccess> => {
    let issuerToken: string | undefined;
    let participantToken: string | undefined;
    try {
      issuerToken = await context.secrets.get(ISSUER_TOKEN_KEY);
    } catch { /* an unreadable keychain must not take the window down */ }
    try {
      participantToken = await deps.participantToken();
    } catch { /* same */ }
    const access = resolveAuthoringAccess({ issuerToken, participantToken });
    // The `when` key is what hides the view. It is presentation only — the
    // Service is what refuses an unauthorized call (#1185).
    await vscode.commands.executeCommand("setContext", AUTHORING_CONTEXT_KEY, access.canAuthor);
    view.description = authoringSubtitle(access);
    provider.refresh();
    return access;
  };

  context.subscriptions.push(
    view,
    provider,
    // 발급(store) · 삭제(delete) · 참여 코드 교체 — 전부 SecretStorage를 지나간다.
    // 키를 가리지 않고 다시 판정한다: 참여 코드는 `hps.activity.credential.<id>`
    // 라는 다른 이름으로 저장되므로 ISSUER_TOKEN_KEY 만 보면 놓친다.
    context.secrets.onDidChange(() => void sync()),
    // NOT `<viewId>.focus` — VS Code auto-registers that id for every
    // contributed view, so naming ours the same shadowed the built-in and the
    // handler below called *itself*. The view then never opened, while the
    // palette happily listed both entries. Caught only by driving the real
    // window (#1184).
    vscode.commands.registerCommand("hypeproof-chat.openChalkSurface", async () => {
      await sync();
      await vscode.commands.executeCommand(`${CHALK_VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand("hypeproof-chat.chalk.openLessonPlan", () =>
      openLessonPlan(),
    ),
    vscode.commands.registerCommand("hypeproof-chat.chalk.openWeb", async () => {
      // ARC-02 — 웹 진입에 인증을 싣지 않는다. 주소만 연다.
      const target = chalkConsoleUrl(deps.proxyUrl());
      await vscode.env.openExternal(vscode.Uri.parse(target));
    }),
  );

  void sync();
  return { sync };
}

async function openLessonPlan(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    const pick = await vscode.window.showWarningMessage(
      "지도안을 둘 작업 폴더가 없어요. 폴더를 먼저 여세요.",
      "폴더 열기",
    );
    if (pick === "폴더 열기") {
      await vscode.commands.executeCommand("workbench.action.files.openFolder");
    }
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, LESSON_PLAN_FILENAME);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(lessonPlanTemplate(), "utf8"));
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}
