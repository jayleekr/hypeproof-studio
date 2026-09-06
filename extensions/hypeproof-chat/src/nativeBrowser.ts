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

/** Open local HTML in a width-controlled iframe; the shipped shell ignores CDP emulation. */
export function registerPreviewViewport(context: vscode.ExtensionContext, liveServer: import("./liveServer").LiveServer): void {
  context.subscriptions.push(vscode.commands.registerCommand("hypeproof-chat.previewViewport", async () => {
    const tab = vscode.window.activeBrowserTab;
    const base = liveServer.currentUrl();
    if (!tab || !base) {
      void vscode.window.showWarningMessage("먼저 검수할 HTML 미리보기를 실행하세요.");
      return;
    }
    try {
      const current = new URL(tab.url);
      if (current.origin !== new URL(base).origin) throw new Error("현재 작업 폴더의 로컬 미리보기에서 사용할 수 있습니다.");
      const target = current.pathname === "/__hp_viewport"
        ? current.searchParams.get("path") || "/index.html"
        : current.pathname + current.search + current.hash;
      const url = new URL("__hp_viewport", base);
      url.searchParams.set("path", target);
      await vscode.window.openBrowserTab(url.href, { viewColumn: vscode.ViewColumn.Beside });
    } catch (err) {
      void vscode.window.showErrorMessage(`화면 검수 열기 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}
