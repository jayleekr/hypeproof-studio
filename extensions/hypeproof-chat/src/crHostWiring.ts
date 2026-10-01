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
//     `hps-browser-result/1` tool_result on the turn's record, carrying its artifact
//     references as event keys, its screenshot and trace bytes stored first on the local
//     record (CR-10); and the stored results read back, labelled by version;
//   - which browser control a proxy turn drives, so the scope guard and the picked
//     element's refs outlive the turn (CR-11, CR-09).
// The provider keeps only the calls into these functions.

import { isCurriculumRuntimeEnabled } from "./curriculumRuntime.ts";
import { MCP_CR_BROWSER_TOOLS } from "./browserMcp.ts";
import { elementContextText, type ElementContext } from "./elementPick.ts";
import {
  browserResultParts,
  browserResultEventText,
  browserResultRefs,
  labelByVersion,
  readBrowserResultEvent,
  type BrowserResultBlobs,
  type BrowserResultRecord,
} from "./browserResult.ts";
import type { BlobMediaType } from "../../../worker/src/lib/measurement-core/local-record.ts";
import { BROWSER_RESULT_REF_KEYS } from "../../../worker/src/lib/measurement-core/learning-events.ts";
import type { Observation } from "./experimentBrowser.ts";
import type { ElementPreview } from "./protocol.ts";

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

/** What the webview previews: one declaration, the host-to-webview protocol's. */
export type { ElementPreview };

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

/** The artifact references a browser result's `tool_result` event carries (BROWSER_RESULT_REF_KEYS). */
export interface CrResultRefs {
  artifact_version: string;
  screenshot_digest?: string;
  trace_digest?: string;
}

export type RecordFn = (
  kind: "tool_request" | "tool_result",
  value: string,
  extra?: { tool_id?: string; outcome?: "success" | "error" } & Partial<CrResultRefs>,
) => void;

/**
 * Stores bytes on the local record (`LocalRecord.putBlob`) and resolves to their digest,
 * or to null when they were not stored. Never throws into a turn.
 */
export type BlobSink = (blob: { media_type: BlobMediaType; base64?: string; json?: unknown }) => Promise<string | null>;

/** One browser result as its `tool_result` event: readable text plus the reference keys. */
export interface CrResultEvent {
  text: string;
  refs: CrResultRefs;
}

const OBSERVE_TOOLS = new Set(["browser_observe", "browser_read", "browser_screenshot"]);

/**
 * Store a result's screenshot and trace, then drop from the record every digest whose
 * bytes did not land: an event never names bytes the record does not hold.
 */
async function storeResultBlobs(record: BrowserResultRecord, blobs: BrowserResultBlobs, sink: BlobSink | undefined): Promise<void> {
  const put = async (want: string | null, blob: Parameters<BlobSink>[0] | null): Promise<string | null> => {
    if (!want || !blob || !sink) return null;
    try {
      return (await sink(blob)) === want ? want : null;
    } catch {
      return null;
    }
  };
  record.screenshot_digest = await put(record.screenshot_digest, blobs.screenshot);
  record.trace_digest = await put(record.trace_digest, { media_type: "application/json", json: blobs.trace });
}

/** The `tool_result` event that binds one browser result to its artifact version. */
export async function crResultEvent(
  tool: string,
  input: Record<string, unknown>,
  observation: Observation,
  sink?: BlobSink,
  kind: "observation" | "action" | "capture" = OBSERVE_TOOLS.has(tool.replace(/^mcp__hypeproof__/, "")) ? "observation" : "action",
): Promise<CrResultEvent> {
  const { record, blobs } = await browserResultParts({ kind, tool, input, outcome: "success", observation });
  await storeResultBlobs(record, blobs, sink);
  return { text: browserResultEventText(record), refs: browserResultRefs(record) };
}

/** Proxy runtime: one CR tool call with an observation → a request and a result event. */
export async function recordProxyCrResult(
  record: RecordFn,
  callId: string,
  name: string,
  input: Record<string, unknown>,
  observation: Observation,
  sink?: BlobSink,
): Promise<void> {
  const toolId = `proxy-${callId}`;
  record("tool_request", `${name}(${JSON.stringify(input ?? {}).slice(0, 200)})`, { tool_id: toolId });
  try {
    const r = await crResultEvent(name, input, observation, sink);
    record("tool_result", r.text, { ...r.refs, tool_id: toolId, outcome: "success" });
  } catch {
    record("tool_result", "브라우저 결과를 산출물 버전에 묶지 못했습니다.", { tool_id: toolId, outcome: "error" });
  }
}

/** A pick sent with a turn: a capture result bound to its version. */
export async function recordElementCapture(record: RecordFn, toolId: string, element: QueuedElement, sink?: BlobSink): Promise<void> {
  const ctx = element.context;
  record("tool_request", `pick_element(${ctx.ref})`, { tool_id: toolId });
  try {
    const observation = { ...ctx, step: null, records: [], screenshot: ctx.crop ? { data: ctx.crop.data, mimeType: ctx.crop.mimeType } : null };
    const { record: r, blobs } = await browserResultParts({ kind: "capture", tool: "pick_element", input: { ref: ctx.ref }, outcome: "success", observation });
    await storeResultBlobs(r, blobs, sink);
    record("tool_result", browserResultEventText(r), { ...browserResultRefs(r), tool_id: toolId, outcome: "success" });
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
  private pending: Array<Promise<CrResultEvent>> = [];
  private readonly ids = new Set<string>();

  /** A new turn: nothing carried over. */
  reset(): void {
    this.pending = [];
    this.ids.clear();
  }

  /** The MCP handler produced a CR result with an observation. */
  onInspect(name: string, input: Record<string, unknown>, observation: Observation | undefined, sink?: BlobSink): void {
    if (!observation) return;
    const p = crResultEvent(name, input, observation, sink);
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

  /** The browser-result event for this tool_result, when it is one of ours; else undefined. */
  onToolResult(id: string, isError: boolean): Promise<CrResultEvent> | undefined {
    if (isError || !this.ids.has(id)) return undefined;
    this.ids.delete(id);
    return this.pending.shift();
  }
}

// ── CR-10: the stored results, read back and labelled by version ────────────

export interface CrResultItem {
  /** e.g. "이전 버전 · sha256:1a2b3c4d" — what the list shows first. */
  label: string;
  description: string;
  detail: string;
  version: string;
  state: "current" | "earlier" | "unknown";
  /** Stored screenshot bytes the result names, or null. */
  screenshot_digest: string | null;
  at: number;
}

const STATE_LABEL = { current: "현재 버전", earlier: "이전 버전", unknown: "버전 확인 안 됨" } as const;

/**
 * Every browser result on a stored batch, newest first, each labelled with the version it
 * was taken against compared with the version its page is at now (`currentByEntry`; null
 * when the preview is off or the page is gone). Reads only what the record holds.
 */
export function crResultHistory(
  events: ReadonlyArray<{ kind?: unknown; text?: unknown; at?: unknown; artifact_version?: unknown; screenshot_digest?: unknown; trace_digest?: unknown }>,
  currentByEntry: (entry: string) => string | null,
): CrResultItem[] {
  const records = events.map((e) => readBrowserResultEvent(e)).filter((r): r is BrowserResultRecord => r !== null);
  return labelByVersion(records, currentByEntry)
    .sort((a, b) => b.record.at - a.record.at)
    .map(({ record: r, version, label }) => {
      // The same failure rule the agent reports by (failuresOf, CR-08).
      const errors = r.records.filter((x) => x.kind === "exception" || x.kind === "network" || x.level === "error" || x.level === "assert");
      return {
        label: `${STATE_LABEL[label]} · ${version.slice(0, 15)}`,
        description: `${r.tool.replace(/^mcp__hypeproof__/, "")} · ${r.route || r.url}${r.step === null ? "" : ` · ${r.step}단계`}`,
        detail: errors.length ? `오류 ${errors.length}건: ${errors[0]!.message.slice(0, 120)}` : "기록된 오류 없음",
        version,
        state: label,
        screenshot_digest: r.screenshot_digest,
        at: r.at,
      };
    });
}

/** The distinct entry pages the stored results were taken on (to look up their current version). */
export function crResultEntries(events: ReadonlyArray<{ kind?: unknown; text?: unknown; artifact_version?: unknown }>): string[] {
  return [...new Set(events.map((e) => readBrowserResultEvent(e)?.artifact_entry).filter((e): e is string => !!e))];
}

/**
 * The batch an observation assessment sends to the Service: the CR-10 reference keys
 * left out. They say which stored bytes a result names, which an assessment never reads,
 * and a Service deployed before decision 8 would refuse the whole batch over them
 * (`invalid_event`), because the App and the Service ship independently.
 */
export function assessmentBatch<E extends object, B extends { events: readonly E[] }>(batch: B): B {
  return {
    ...batch,
    events: batch.events.map((e) => {
      if (!BROWSER_RESULT_REF_KEYS.some((k) => k in e)) return e;
      const copy = { ...e } as Record<string, unknown>;
      for (const k of BROWSER_RESULT_REF_KEYS) delete copy[k];
      return copy as unknown as E;
    }),
  };
}

/**
 * CR-11, CR-09 — the BrowserControl one proxy turn drives, and what the turn does with it
 * at the end. With the switch on the turn drives the provider's long-lived control (the
 * one element pick and the SDK path use) and leaves it open: closing its CDP session would
 * drop the scope guard's listener, so an escape a step set off would complete after the
 * turn, and the picked element's ref table would be lost to the next turn. With the switch
 * off a turn keeps its own control and closes it, as before CR.
 */
export function proxyTurnBrowser<B extends { dispose(): Promise<void> }>(
  crOn: boolean,
  shared: () => B,
  fresh: () => B,
): { browser: B; release(): Promise<void> } {
  if (crOn) return { browser: shared(), release: async () => {} };
  const browser = fresh();
  return { browser, release: () => browser.dispose() };
}
