// Curriculum Runtime host wiring (cr-browser, #1391; CR-02, CR-09, CR-10). Pure and vscode-free.
//
// ChatPanelProvider owns the webview, the tabs and the turn loop, and cannot be driven in
// a unit test. The decisions it makes for the Experiment Browser live here instead, so a
// smoke can check the behaviour a student and the record see:
//   - which switch value is mirrored to the context key, and whether the SDK server
//     registers the CR tools (CR-02);
//   - the picked element queued for the next turn: removed means nothing of it is sent,
//     and what is sent equals what was previewed (CR-09);
//   - every browser result, from either runtime and from a pick, written as a
//     `hps-browser-result/1` tool_result on the turn's record (CR-10).
// The provider keeps only the calls into these functions.

import { isCurriculumRuntimeEnabled } from "./curriculumRuntime.ts";
import { MCP_CR_BROWSER_TOOLS } from "./browserMcp.ts";
import { elementContextText, type ElementContext } from "./elementPick.ts";
import { browserResultRecord, browserResultEventText } from "./browserResult.ts";
import type { Observation } from "./experimentBrowser.ts";

// ── CR-02 glue ──────────────────────────────────────────────────────────────

/** The value mirrored to `CR_CONTEXT_KEY` for a served profile: exactly the switch. */
export function crContextKeyValue(profile: { curriculum_runtime?: { enabled?: unknown } | null } | null | undefined): boolean {
  return isCurriculumRuntimeEnabled(profile);
}

/** Does the SDK server register the CR tools? Only when the grant carries them. */
export function crMcpRegistration(permittedMcpTools: readonly string[]): { curriculumRuntime: boolean } {
  return { curriculumRuntime: permittedMcpTools.some((t) => (MCP_CR_BROWSER_TOOLS as readonly string[]).includes(t)) };
}

// ── CR-09: the picked element, queued for the next turn ─────────────────────

export interface QueuedElement {
  context: ElementContext;
  /** Exactly the text the model receives for this element. */
  text: string;
  /** The crop as a data URL, or null when the cohort takes no images. */
  image: string | null;
}

/** What the webview previews: `sentText` and `imageDataUrl` are what the turn will carry. */
export interface ElementPreview {
  ref: string;
  tag: string;
  text: string;
  source: string;
  sentText: string;
  imageDataUrl: string | null;
}

export class ElementQueue {
  private pending: QueuedElement | null = null;

  /** Queue a picked element, replacing any earlier one; returns its preview. */
  attach(ctx: ElementContext, opts: { imagesAllowed: boolean }): ElementPreview {
    this.pending = {
      context: ctx,
      text: elementContextText(ctx),
      image: ctx.crop && opts.imagesAllowed ? `data:${ctx.crop.mimeType};base64,${ctx.crop.data}` : null,
    };
    return this.preview()!;
  }

  /** The student removed it: nothing of it goes. Returns whether something was queued. */
  clear(): boolean {
    const had = this.pending !== null;
    this.pending = null;
    return had;
  }

  get queued(): boolean {
    return this.pending !== null;
  }

  preview(): ElementPreview | null {
    const e = this.pending;
    if (!e) return null;
    return {
      ref: e.context.ref,
      tag: e.context.tag,
      text: e.context.text,
      source: e.context.source === "unmapped" ? "unmapped" : `${e.context.source.file}:${e.context.source.line}`,
      sentText: e.text,
      imageDataUrl: e.image,
    };
  }

  /** Consume the queued element for this turn; with the switch off nothing is sent (and it is dropped). */
  take(switchOn: boolean): QueuedElement | null {
    const e = this.pending;
    this.pending = null;
    return switchOn ? e : null;
  }
}

/** The model text of a turn that carries a picked element: the element first, as previewed. */
export function withElementText(userText: string, element: QueuedElement | null): string {
  return element ? `${element.text}\n\n${userText}` : userText;
}

/**
 * The images of a turn: the student's own, the queued page screenshot, and the element
 * crop. Neither of the last two replaces the other; both were shown as attached.
 */
export function turnImages(images: readonly string[] | undefined, pageImage: string | null, element: QueuedElement | null): string[] | undefined {
  const extra = [...(pageImage ? [pageImage] : []), ...(element?.image ? [element.image] : [])];
  if (!extra.length) return images ? [...images] : undefined;
  return [...(images ?? []), ...extra];
}

// ── CR-10: every browser result on the turn's record ────────────────────────

export type RecordFn = (
  kind: "tool_request" | "tool_result",
  value: string,
  extra?: { tool_id?: string; outcome?: "success" | "error" },
) => void;

const OBSERVE_TOOLS = new Set(["browser_observe", "browser_read", "browser_screenshot"]);

/** The `tool_result` text that binds one browser result to its artifact version. */
export async function crResultText(
  tool: string,
  input: Record<string, unknown>,
  observation: Observation,
  kind: "observation" | "action" | "capture" = OBSERVE_TOOLS.has(tool.replace(/^mcp__hypeproof__/, "")) ? "observation" : "action",
): Promise<string> {
  return browserResultEventText(await browserResultRecord({ kind, tool, input, outcome: "success", observation }));
}

/** Proxy runtime: one CR tool call with an observation → a request and a result event. */
export async function recordProxyCrResult(
  record: RecordFn,
  callId: string,
  name: string,
  input: Record<string, unknown>,
  observation: Observation,
): Promise<void> {
  const toolId = `proxy-${callId}`;
  record("tool_request", `${name}(${JSON.stringify(input ?? {}).slice(0, 200)})`, { tool_id: toolId });
  try {
    record("tool_result", await crResultText(name, input, observation), { tool_id: toolId, outcome: "success" });
  } catch {
    record("tool_result", "브라우저 결과를 산출물 버전에 묶지 못했습니다.", { tool_id: toolId, outcome: "error" });
  }
}

/** A pick sent with a turn: a capture result bound to its version. */
export async function recordElementCapture(record: RecordFn, toolId: string, element: QueuedElement): Promise<void> {
  const ctx = element.context;
  record("tool_request", `pick_element(${ctx.ref})`, { tool_id: toolId });
  try {
    const text = browserResultEventText(
      await browserResultRecord({
        kind: "capture",
        tool: "pick_element",
        input: { ref: ctx.ref },
        outcome: "success",
        observation: { ...ctx, step: null, records: [], screenshot: ctx.crop ? { data: ctx.crop.data } : null },
      }),
    );
    record("tool_result", text, { tool_id: toolId, outcome: "success" });
  } catch {
    record("tool_result", "요소 캡처를 산출물 버전에 묶지 못했습니다.", { tool_id: toolId, outcome: "error" });
  }
}

/**
 * SDK runtime. The MCP handler cannot see the SDK tool-use id, so each delegated browser
 * tool's observation is queued when the handler runs and taken by the next browser
 * tool_result activity (browser tools run one at a time).
 */
export class SdkCrResults {
  private pending: Array<Promise<string>> = [];
  private readonly ids = new Set<string>();

  /** A new turn: nothing carried over. */
  reset(): void {
    this.pending = [];
    this.ids.clear();
  }

  /** The MCP handler produced a CR result with an observation. */
  onInspect(name: string, input: Record<string, unknown>, observation: Observation | undefined): void {
    if (!observation) return;
    const p = crResultText(name, input, observation);
    p.catch(() => {});
    this.pending.push(p);
  }

  /** A tool_use activity: remember the delegated browser tools' ids while the switch is on. */
  onToolUse(id: string, name: string, switchOn: boolean): void {
    if (!switchOn) return;
    const short = name.replace(/^mcp__hypeproof__/, "");
    if (short === name) return;
    if (short === "browser_open" || short === "live_preview_start") return;
    this.ids.add(id);
  }

  /** The browser-result text for this tool_result, when it is one of ours; else undefined. */
  onToolResult(id: string, isError: boolean): Promise<string> | undefined {
    if (isError || !this.ids.has(id)) return undefined;
    this.ids.delete(id);
    return this.pending.shift();
  }
}
