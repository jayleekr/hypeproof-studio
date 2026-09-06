import * as vscode from "vscode";
import { CdpSession } from "./cdpSession";

// Native integrated browser wiring (#278).
//
// VS Code 1.116 ships an integrated browser (Electron WebContentsView, rendered
// in editor tabs) reachable via the `browser` proposed API
// (vscode.proposed.browser.d.ts, vendored alongside this file). That proposal is
// enabled for this built-in extension via product.json
// `extensionEnabledApiProposals` — see scripts/apply-product-overrides.sh.
//
// This module is the extension-host browser primitives only. The chat-turn
// injection + the `page_context` gate live in chatPanelProvider; the screenshot
// (vision) path waits on the multimodal proxy pipeline, which is not yet wired
// (proxyClient sends text-only) — so today only the DOM text/AX is used.

/** Captured context from a browser tab, ready to feed to the coach (Q2). */
export interface PageContext {
  url: string;
  title: string;
  /** JPEG screenshot of the visible viewport, base64 (no `data:` prefix). */
  imageBase64: string;
  /** Visible text of `<body>`, truncated. */
  text: string;
  /** Accessibility-tree node count — a rough structure signal. */
  axNodeCount: number;
}

/** Open (or reveal) a native browser tab at `url`. Q1. */
export async function openBrowser(urlInput?: string): Promise<void> {
  let url = urlInput;
  if (!url) {
    url = await vscode.window.showInputBox({
      prompt: "열 주소 (URL)",
      placeHolder: "https://example.com  ·  http://localhost:5173  ·  /path/to/index.html",
      value: "https://",
      ignoreFocusOut: true,
    });
  }
  if (!url) return;
  await vscode.window.openBrowserTab(normalizeUrl(url), { viewColumn: vscode.ViewColumn.Beside });
}

function normalizeUrl(input: string): string {
  const v = input.trim();
  if (/^(https?|file):\/\//i.test(v)) return v;
  if (/^localhost(:\d+)?(\/|$)/i.test(v)) return `http://${v}`;
  if (v.startsWith("/")) return vscode.Uri.file(v).toString();
  return `https://${v}`;
}

/**
 * Capture screenshot + visible text + AX summary from a browser tab via CDP. Q2.
 *
 * Uses CdpSession, which does the Target.attachToTarget handshake first — the
 * #278 spike proved page-level CDP methods (Page.captureScreenshot,
 * Runtime.evaluate, Accessibility.*) are "Method not found" without it.
 */
export async function capturePageContext(tab: vscode.BrowserTab): Promise<PageContext> {
  const session = await CdpSession.attach(tab);
  try {
    const shot = await session.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const textRes = await session.send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true,
    });
    let axNodeCount = 0;
    try {
      const ax = await session.send("Accessibility.getFullAXTree", {});
      axNodeCount = Array.isArray(ax?.nodes) ? ax.nodes.length : 0;
    } catch {
      /* AX tree is best-effort; some pages reject it */
    }
    return {
      url: tab.url,
      title: tab.title,
      imageBase64: String(shot?.data ?? ""),
      text: String(textRes?.result?.value ?? "").slice(0, 4000),
      axNodeCount,
    };
  } finally {
    await session.close();
  }
}

/**
 * Capture the currently active browser tab. Returns null (with a nudge) when no
 * tab is open or capture fails — callers should bail quietly.
 */
export async function captureActivePage(): Promise<PageContext | null> {
  const tab = vscode.window.activeBrowserTab;
  if (!tab) {
    vscode.window.showWarningMessage(
      "HypeProof: 먼저 브라우저 탭을 열어주세요 (명령: HypeProof: 브라우저 열기).",
    );
    return null;
  }
  try {
    return await capturePageContext(tab);
  } catch (err) {
    vscode.window.showErrorMessage(
      `HypeProof: 페이지 캡처 실패 — ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Manual layout inspection of the active page; no tool or network grant. */
export function registerPreviewViewport(context: vscode.ExtensionContext): void {
  // Keep the CDP session alive: emulation belongs to it and is reset on detach.
  const sessions = new Map<vscode.BrowserTab, CdpSession>();
  const release = async (tab: vscode.BrowserTab) => {
    const session = sessions.get(tab);
    sessions.delete(tab);
    if (session) await session.close().catch(() => undefined);
  };
  context.subscriptions.push(
    vscode.window.onDidCloseBrowserTab((tab) => { void release(tab); }),
    { dispose: () => { for (const tab of sessions.keys()) void release(tab); } },
    vscode.commands.registerCommand("hypeproof-chat.previewViewport", async () => {
      const tab = vscode.window.activeBrowserTab;
      if (!tab) {
        void vscode.window.showWarningMessage("먼저 검수할 미리보기 탭을 열어주세요.");
        return;
      }
      const choice = await vscode.window.showQuickPick([
        { label: "모바일 390px", width: 390 },
        { label: "데스크톱 1280px", width: 1280 },
        { label: "실제 패널 크기로 복귀", width: 0 },
      ], { title: "미리보기 화면 크기", placeHolder: "레이아웃 검수용 너비를 선택하세요" });
      if (!choice) return;
      let session = sessions.get(tab);
      try {
        if (!session) {
          session = await CdpSession.attach(tab);
          sessions.set(tab, session);
          session.onDidClose(() => { if (sessions.get(tab) === session) sessions.delete(tab); });
        }
        if (choice.width === 0) {
          await session.send("Emulation.clearDeviceMetricsOverride");
          await release(tab);
        } else {
          await session.send("Emulation.setDeviceMetricsOverride", {
            width: choice.width, height: 844, deviceScaleFactor: 1, mobile: false,
          });
          const result = await session.send("Runtime.evaluate", {
            expression: "window.innerWidth", returnByValue: true,
          });
          if (result?.result?.value !== choice.width) throw new Error("선택한 너비가 적용되지 않았습니다.");
        }
      } catch (err) {
        await release(tab);
        void vscode.window.showErrorMessage(`미리보기 크기 변경 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}
