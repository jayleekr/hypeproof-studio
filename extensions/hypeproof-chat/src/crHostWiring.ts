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

/** One set of bytes a result names: a screenshot (base64) or a trace (JSON). */
export type ResultBlob = { media_type: BlobMediaType; base64?: string; json?: unknown };

/**
 * Stores one result's bytes on the local record (`LocalRecord.putBlob`) in ONE write
 * session and resolves to their digests, in order, each null when it was not stored.
 * Never throws into a turn.
 */
export type BlobSink = (blobs: readonly ResultBlob[]) => Promise<Array<string | null>>;

/**
 * Events a result may still need after its bytes are checked for room: its own
 * tool_result plus what the turn records while the bytes are written.
 */
export const CR_RESULT_EVENT_HEADROOM = 8;

/**
 * The turn's sink, refused (every digest null, nothing stored) once the turn's recorder
 * cannot take the result's event: bytes are written before their event, and a full
 * recorder refuses that event (observation_capacity), which would leave stored bytes no
 * event names. `hasRoom(n)` is the recorder's own check.
 */
export function roomGuardedSink(sink: BlobSink | undefined, hasRoom: ((n: number) => boolean) | undefined): BlobSink | undefined {
  if (!sink || !hasRoom) return undefined;
  return (blobs) => (hasRoom(CR_RESULT_EVENT_HEADROOM) ? sink(blobs) : Promise.resolve(blobs.map(() => null)));
}

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
  const wanted: Array<{ want: string; blob: ResultBlob; set: (d: string | null) => void }> = [];
  if (record.screenshot_digest && blobs.screenshot) wanted.push({ want: record.screenshot_digest, blob: blobs.screenshot, set: (d) => { record.screenshot_digest = d; } });
  else record.screenshot_digest = null;
  if (record.trace_digest) wanted.push({ want: record.trace_digest, blob: { media_type: "application/json", json: blobs.trace }, set: (d) => { record.trace_digest = d; } });
  if (!sink || !wanted.length) {
    for (const w of wanted) w.set(null);
    return;
  }
  let got: Array<string | null> = [];
  try {
    const answer = await sink(wanted.map((w) => w.blob));
    got = Array.isArray(answer) ? answer : [];
  } catch {
    got = [];
  }
  wanted.forEach((w, i) => w.set(got[i] === w.want ? w.want : null));
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
  private pending: Array<() => Promise<CrResultEvent>> = [];
  private readonly ids = new Set<string>();
  private sink: BlobSink | undefined;

  /**
   * A new turn: nothing carried over. `sink` is given only when the turn has a recorder,
   * so no bytes are stored that no recorded event will name (CR-10).
   */
  reset(sink?: BlobSink): void {
    this.pending = [];
    this.ids.clear();
    this.sink = sink;
  }

  /**
   * The MCP handler produced a CR result with an observation. Nothing is stored yet: the
   * bytes go to the record only when the SDK reports this call's tool_result, which is
   * when the event that names them is written.
   */
  onInspect(name: string, input: Record<string, unknown>, observation: Observation | undefined): void {
    if (!observation) return;
    const sink = this.sink;
    this.pending.push(() => crResultEvent(name, input, observation, sink));
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
    return this.pending.shift()?.();
  }
}

// ── CR-10: the stored results, read back and labelled by version ────────────

export interface CrResultItem {
  /** e.g. "이전 버전 · 버전 1" — what the list shows first. */
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
 * Versions numbered per entry page in the order they were first seen ("버전 1", "버전 2"),
 * instead of a digest prefix a student cannot read.
 */
function versionNumbers(records: readonly BrowserResultRecord[]): (entry: string, version: string) => number {
  const byEntry = new Map<string, string[]>();
  for (const r of [...records].sort((a, b) => a.at - b.at)) {
    const seen = byEntry.get(r.artifact_entry) ?? [];
    if (!seen.includes(r.artifact_version)) seen.push(r.artifact_version);
    byEntry.set(r.artifact_entry, seen);
  }
  return (entry, version) => (byEntry.get(entry)?.indexOf(version) ?? -1) + 1;
}

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
  const numberOf = versionNumbers(records);
  return labelByVersion(records, currentByEntry)
    .sort((a, b) => b.record.at - a.record.at)
    .map(({ record: r, version, label }) => {
      // The same failure rule the agent reports by (failuresOf, CR-08).
      const errors = r.records.filter((x) => x.kind === "exception" || x.kind === "network" || x.level === "error" || x.level === "assert");
      return {
        label: `${STATE_LABEL[label]} · 버전 ${numberOf(r.artifact_entry, version)}`,
        description: `${r.tool.replace(/^mcp__hypeproof__/, "")} · ${r.route || r.url}${r.step === null ? "" : ` · ${r.step}단계`}`,
        detail: errors.length ? `오류 ${errors.length}건: ${errors[0]!.message.slice(0, 120)}` : "기록된 오류 없음",
        version,
        state: label,
        screenshot_digest: r.screenshot_digest,
        at: r.at,
      };
    });
}

/** One row of the results command, vscode-free (the provider maps it to a QuickPickItem). */
export type CrResultsRow =
  | { kind: "result"; label: string; description: string; detail: string; item: CrResultItem }
  | { kind: "separator" }
  | { kind: "clear"; label: string; description: string; detail: string };

export const CR_CLEAR_LABEL = "$(trash) 저장된 화면·동작 기록 지우기";

/**
 * Context key: browser-result bytes are stored on this seat's local record. It gates the
 * delete command (CR_BYTES_CLEAR_COMMAND) and deliberately NOT the CR switch: after a
 * cohort or tier change turns the switch off, the stored screenshots of the student's pages
 * must still be visible and deletable (MC-27), while every CR surface stays hidden (CR-02).
 */
export const CR_BYTES_CONTEXT_KEY = "hypeproof-chat.crBrowserBytesStored";
export const CR_BYTES_CLEAR_COMMAND = "hypeproof-chat.clearBrowserResultBytes";

/**
 * What the results command shows (switch on): the results, then a delete row when bytes
 * are stored. `notice` replaces the list when there is nothing to show.
 */
export function crResultsMenu(input: { items: readonly CrResultItem[]; stored: number }): { notice: string | null; rows: CrResultsRow[] } {
  const stored = Math.max(0, Math.floor(input.stored || 0));
  if (!input.items.length && !stored) return { notice: "아직 기록된 실험 브라우저 결과가 없어요.", rows: [] };
  const rows: CrResultsRow[] = input.items.map((item) => ({ kind: "result", label: item.label, description: item.description, detail: item.detail, item }));
  if (stored) {
    if (rows.length) rows.push({ kind: "separator" });
    rows.push({ kind: "clear", label: CR_CLEAR_LABEL, description: `${stored}개`, detail: "이 컴퓨터에 저장된 실험 브라우저 화면과 동작 기록을 모두 지워요. 결과 목록은 남아요." });
  }
  return { notice: null, rows };
}

/**
 * The student deletes every stored browser-result byte, only after confirming with
 * "지우기"; anything else (Escape, closing the dialog) deletes nothing.
 */
export async function clearStoredResults(
  stored: number,
  confirm: (message: string) => Promise<string | undefined>,
  remove: () => Promise<{ removed: number }>,
): Promise<{ removed: number } | null> {
  const ok = await confirm(`저장된 실험 브라우저 화면과 동작 기록 ${stored}개를 지울까요? 되돌릴 수 없어요.`);
  if (ok !== "지우기") return null;
  return remove();
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
