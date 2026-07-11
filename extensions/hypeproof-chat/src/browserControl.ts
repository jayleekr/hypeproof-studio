import * as vscode from "vscode";
import { CdpSession } from "./cdpSession";
import { safeNavigateUrl, quadCenter, buildAxSnapshot } from "./browserControlHelpers";

// #278 Phase 3 — the coach's browser control executor. Runs one tool call
// (from the agentic loop) against the integrated browser via CDP and returns a
// tool_result. Design confirmed by the 2026-07-11 spike:
//   - CdpSession does the Target.attachToTarget handshake; the sessionId
//     survives cross-origin navigation, so one session per tab is reused.
//   - Input.dispatch* lands real clicks/keystrokes; no JS-eval fallback needed.
//   - browser_read builds an AX snapshot with [ref=eN] labels; click/type
//     resolve a ref → backendDOMNodeId → box center → Input events.
//
// Auto-run + log (not approval): the loop posts a compact action-log line per
// call; there is no per-action modal.

export interface BrowserToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool_result the loop appends to the model conversation (OpenAI-ish blocks). */
export interface BrowserToolResult {
  content: Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  >;
  isError: boolean;
}

function ok(text: string): BrowserToolResult {
  return { content: [{ type: "text", text }], isError: false };
}
function fail(text: string): BrowserToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BrowserControl {
  private session: CdpSession | undefined;
  private tabForSession: vscode.BrowserTab | undefined;
  private refs = new Map<string, number>();

  /** Route + run one tool call. Always resolves (errors become is_error results). */
  async execute(call: BrowserToolCall): Promise<BrowserToolResult> {
    try {
      const input = call.input ?? {};
      switch (call.name) {
        case "browser_navigate":
          return await this.navigate(String(input.url ?? ""));
        case "browser_read":
          return await this.read();
        case "browser_screenshot":
          return await this.screenshot();
        case "browser_click":
          return await this.click(String(input.ref ?? ""));
        case "browser_type":
          return await this.type(String(input.ref ?? ""), String(input.text ?? ""), input.submit === true);
        case "browser_back":
          return await this.history(-1);
        case "browser_forward":
          return await this.history(1);
        case "browser_dialog":
          return await this.dialog(
            String(input.action ?? ""),
            typeof input.promptText === "string" ? input.promptText : undefined,
          );
        default:
          return fail(`알 수 없는 도구: ${call.name}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  async dispose(): Promise<void> {
    if (this.session) {
      await this.session.close().catch(() => {});
      this.session = undefined;
      this.tabForSession = undefined;
    }
    this.refs.clear();
  }

  // ---- tools ---------------------------------------------------------------

  private async navigate(rawUrl: string): Promise<BrowserToolResult> {
    const url = safeNavigateUrl(rawUrl);
    if (!url) return fail(`허용되지 않은 주소예요: ${rawUrl} (http/https/localhost/file만 가능)`);
    const tab = vscode.window.activeBrowserTab;
    if (!tab) {
      // No tab yet — open one (this is the only tool that may create a tab).
      await vscode.window.openBrowserTab(url, { viewColumn: vscode.ViewColumn.Beside });
      await sleep(800);
    } else {
      const s = await this.cdp();
      await s.send("Page.navigate", { url });
    }
    await this.waitLoad();
    this.refs.clear(); // navigation invalidates old refs
    const active = vscode.window.activeBrowserTab;
    return ok(`이동 완료 — ${active?.title || ""} (${active?.url || url})`);
  }

  private async read(): Promise<BrowserToolResult> {
    const s = await this.cdp();
    const ax = await s.send("Accessibility.getFullAXTree", {});
    const { text, refs } = buildAxSnapshot(Array.isArray(ax?.nodes) ? ax.nodes : []);
    this.refs = refs;
    const tab = vscode.window.activeBrowserTab;
    return ok(`URL: ${tab?.url ?? ""}\n제목: ${tab?.title ?? ""}\n\n${text}`);
  }

  private async screenshot(): Promise<BrowserToolResult> {
    const s = await this.cdp();
    const shot = await s.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const data = String(shot?.data ?? "");
    if (!data) return fail("화면 캡쳐에 실패했어요.");
    return { content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } }], isError: false };
  }

  private async click(ref: string): Promise<BrowserToolResult> {
    const center = await this.refCenter(ref);
    if ("error" in center) return fail(center.error);
    const s = await this.cdp();
    const { x, y } = center;
    await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return ok(`${ref} 클릭했어요.`);
  }

  private async type(ref: string, text: string, submit: boolean): Promise<BrowserToolResult> {
    const center = await this.refCenter(ref);
    if ("error" in center) return fail(center.error);
    const s = await this.cdp();
    // Focus the field by clicking it, then insert text.
    await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button: "left", clickCount: 1 });
    await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button: "left", clickCount: 1 });
    await s.send("Input.insertText", { text });
    if (submit) {
      const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await s.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
      await s.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
    }
    return ok(submit ? `${ref}에 입력하고 Enter를 눌렀어요.` : `${ref}에 입력했어요.`);
  }

  private async history(dir: -1 | 1): Promise<BrowserToolResult> {
    const s = await this.cdp();
    const h = await s.send("Page.getNavigationHistory", {});
    const entries: Array<{ id?: number }> = h?.entries ?? [];
    const idx = (h?.currentIndex ?? 0) + dir;
    if (idx < 0 || idx >= entries.length || typeof entries[idx]?.id !== "number") {
      return fail(dir < 0 ? "뒤로 갈 페이지가 없어요." : "앞으로 갈 페이지가 없어요.");
    }
    await s.send("Page.navigateToHistoryEntry", { entryId: entries[idx].id });
    await this.waitLoad();
    this.refs.clear();
    return ok(dir < 0 ? "뒤로 갔어요." : "앞으로 갔어요.");
  }

  private async dialog(action: string, promptText?: string): Promise<BrowserToolResult> {
    if (action !== "accept" && action !== "dismiss") return fail(`action은 accept 또는 dismiss여야 해요: ${action}`);
    const s = await this.cdp();
    await s.send("Page.enable", {}).catch(() => {});
    await s.send("Page.handleJavaScriptDialog", {
      accept: action === "accept",
      ...(promptText ? { promptText } : {}),
    });
    return ok("대화상자를 처리했어요.");
  }

  // ---- internals -----------------------------------------------------------

  /** Get (or re-establish) the CDP session for the active tab. */
  private async cdp(): Promise<CdpSession> {
    const tab = vscode.window.activeBrowserTab;
    if (!tab) throw new Error("열린 브라우저 탭이 없어요. 먼저 browser_navigate로 페이지를 여세요.");
    if (this.session && this.tabForSession === tab) return this.session;
    if (this.session) await this.session.close().catch(() => {});
    this.session = await CdpSession.attach(tab);
    this.tabForSession = tab;
    return this.session;
  }

  private async refCenter(ref: string): Promise<{ x: number; y: number } | { error: string }> {
    const backendId = this.refs.get(ref);
    if (backendId === undefined) {
      return { error: `${ref}를 찾을 수 없어요. browser_read로 페이지를 다시 읽어 최신 ref를 받아주세요.` };
    }
    const s = await this.cdp();
    const box = await s.send("DOM.getBoxModel", { backendNodeId: backendId }).catch(() => null);
    const center = box?.model?.content ? quadCenter(box.model.content) : null;
    if (!center) return { error: "요소 위치를 못 찾았어요 — 페이지가 바뀌었을 수 있어요. browser_read로 다시 읽어주세요." };
    // Scroll into view first (best-effort), then return the point.
    await s.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: backendId }).catch(() => {});
    return center;
  }

  private async waitLoad(timeoutMs = 12_000): Promise<void> {
    const s = await this.cdp();
    const start = Date.now();
    for (;;) {
      if (Date.now() - start > timeoutMs) return;
      const r = await s
        .send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true })
        .catch(() => null);
      if (r?.result?.value === "complete") return;
      await sleep(300);
    }
  }
}
