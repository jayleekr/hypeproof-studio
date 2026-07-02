import * as vscode from "vscode";

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

let cdpMessageId = 0;

/**
 * One CDP request over the proposed-API raw message channel. The channel is
 * fire-and-forget (`sendMessage` + `onDidReceiveMessage`), so we correlate
 * responses by a monotonic `id` ourselves.
 */
function cdpRequest(
  session: vscode.BrowserCDPSession,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<any> {
  const id = ++cdpMessageId;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`CDP ${method} timed out`));
    }, timeoutMs);
    const sub = session.onDidReceiveMessage((raw) => {
      const m = raw as { id?: number; result?: unknown; error?: { message?: string } };
      if (!m || m.id !== id) return;
      clearTimeout(timer);
      sub.dispose();
      if (m.error) reject(new Error(m.error.message ?? `CDP ${method} failed`));
      else resolve(m.result);
    });
    void session.sendMessage({ id, method, params });
  });
}

/** Capture screenshot + visible text + AX summary from a browser tab via CDP. Q2. */
export async function capturePageContext(tab: vscode.BrowserTab): Promise<PageContext> {
  const session = await tab.startCDPSession();
  try {
    const shot = await cdpRequest(session, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const textRes = await cdpRequest(session, "Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true,
    });
    let axNodeCount = 0;
    try {
      const ax = await cdpRequest(session, "Accessibility.getFullAXTree", {});
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
