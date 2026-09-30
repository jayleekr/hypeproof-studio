// Experiment Browser core (cr-browser, #1391; CR-04, CR-05, CR-06, CR-08, CR-11, CR-68).
//
// Pure and vscode-free: every function takes a `CdpLike` (a `CdpSession`, or a mock in
// the smokes), so the CDP logic is unit-testable under `node --strip-types`.
// `BrowserControl` (browserControl.ts) owns the tab and wires this in only when the
// Curriculum Runtime switch is on (CR-02); with the switch off none of this runs.
//
// Decisions it implements (docs/plan/curriculum-runtime-recon.md):
//   R1  — extend the extension's CDP path; no second browser-control framework.
//   §7  — document generation = main-frame `loaderId`; the current document is seeded
//         from `Page.getFrameTree` BEFORE `Runtime.enable`, because enabling replays the
//         attach-time document's console messages before any `Page.frameNavigated`.
//         Console and exceptions attribute through `executionContextId`, network through
//         the request's loader. A 404 is a response >= 400, not a loading failure;
//         cancelled loads and requests seen only before `Network.enable` are dropped.
//   R11 — the page-level automation indicator is an inspector-overlay outline drawn for
//         the duration of each agent step and cleared before an evidence screenshot.
//
// Provider-neutral by construction (CR-03): plain data in and out, no model SDK types.

import { buildAxSnapshot, safeNavigateUrl } from "./browserControlHelpers.ts";

export interface CdpLike {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  onEvent(listener: (event: { method: string; params: Record<string, any> }) => void): { dispose(): void };
}

// ── Page records (CR-05, CR-08) ─────────────────────────────────────────────

export type PageRecordKind = "console" | "exception" | "network" | "log";

export interface PageRecord {
  kind: PageRecordKind;
  /** console type (`log`, `error`, `warning`, …) or `error` / `warning` for the others. */
  level: string;
  message: string;
  source?: { url?: string; line?: number; column?: number };
  /** Epoch milliseconds. */
  time: number;
  /** The main-frame document (loaderId) the record belongs to. */
  documentGeneration: string;
  /** The agent step during which it was captured, or null outside any step. */
  step: number | null;
}

const MAX_MESSAGE = 500;
/** A Log entry without a request id arriving this soon after a commit may be the old document's. */
const LOG_COMMIT_WINDOW_MS = 1000;
/** HTTP errors of the current document's own resource loads (Resource Timing, Chromium 109+). */
const LOAD_FAILURES_EXPR =
  "JSON.stringify(performance.getEntriesByType('resource').filter(function(e){return e.responseStatus>=400}).map(function(e){return {u:e.name,s:e.responseStatus}}))";
/** Log sources already covered by Runtime/Network events, so they would be counted twice. */
const DUPLICATE_LOG_SOURCES = new Set(["network", "javascript", "console-api"]);

function remoteObjectText(arg: any): string {
  if (!arg || typeof arg !== "object") return String(arg);
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  if (typeof arg.unserializableValue === "string") return arg.unserializableValue;
  if (typeof arg.description === "string") return arg.description;
  return String(arg.type ?? "");
}

function frameSource(frame: any): PageRecord["source"] | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const src: NonNullable<PageRecord["source"]> = {};
  if (typeof frame.url === "string" && frame.url) src.url = frame.url;
  if (Number.isFinite(frame.lineNumber)) src.line = Number(frame.lineNumber) + 1;
  if (Number.isFinite(frame.columnNumber)) src.column = Number(frame.columnNumber) + 1;
  return Object.keys(src).length ? src : undefined;
}

/**
 * Per-document buffer of console output, uncaught errors and failed requests.
 *
 * Bounded: at most `maxPerDocument` records per document (the overflow is counted, not
 * kept) and the last `keepDocuments` documents. Records of an earlier document are never
 * returned for the current one.
 */
export class PageEventLog {
  private readonly maxPerDocument: number;
  private readonly keepDocuments: number;
  private readonly now: () => number;
  private mainFrameId: string | null = null;
  private generation: string | null = null;
  private step: number | null = null;
  private readonly contexts = new Map<number, string>();
  private readonly requests = new Map<string, { url: string; generation: string }>();
  private readonly failedRequests = new Set<string>();
  private readonly byGeneration = new Map<string, { records: PageRecord[]; dropped: number }>();
  private readonly docListeners = new Set<(generation: string) => void>();
  private sub: { dispose(): void } | undefined;
  private dialog: string | null = null;
  /** When the main frame last committed a new document (epoch ms), for Log attribution. */
  private committedAt = 0;
  /** Documents this log first saw after they had loaded: their load-time records are partial. */
  private readonly lateAttached = new Set<string>();

  constructor(opts: { maxPerDocument?: number; keepDocuments?: number; now?: () => number } = {}) {
    this.maxPerDocument = opts.maxPerDocument ?? 100;
    this.keepDocuments = opts.keepDocuments ?? 4;
    this.now = opts.now ?? Date.now;
  }

  /** Subscribe, enable the domains once, and seed the current document. */
  async attach(cdp: CdpLike): Promise<void> {
    this.sub?.dispose();
    this.sub = cdp.onEvent((e) => this.handle(e.method, e.params));
    await cdp.send("Page.enable", {});
    // Seed BEFORE Runtime.enable: its replayed console messages belong to this document.
    const tree = await cdp.send("Page.getFrameTree", {});
    const frame = tree?.frameTree?.frame;
    if (frame && typeof frame.id === "string") {
      this.mainFrameId = frame.id;
      if (typeof frame.loaderId === "string" && frame.loaderId) this.setGeneration(frame.loaderId, false);
    }
    await cdp.send("Runtime.enable", {});
    await cdp.send("Network.enable", {});
    await cdp.send("Log.enable", {}).catch(() => {
      /* Log is supplementary; the three required record kinds come from Runtime/Network */
    });
    // Network events are not replayed, so a document that loaded before this attach has
    // lost its load-time request failures. Recover the HTTP errors from the document's own
    // Resource Timing (it belongs to this document by construction) and mark the rest as
    // unknown rather than reporting a clean page.
    const seeded = this.generation;
    if (seeded && typeof frame?.url === "string" && frame.url && frame.url !== "about:blank") {
      this.lateAttached.add(seeded);
      const r = await cdp
        .send("Runtime.evaluate", { expression: LOAD_FAILURES_EXPR, returnByValue: true })
        .catch(() => null);
      let failures: Array<{ u?: unknown; s?: unknown }> = [];
      try {
        const parsed = JSON.parse(String(r?.result?.value ?? "[]"));
        if (Array.isArray(parsed)) failures = parsed;
      } catch {
        /* not a page we can read: the generation stays marked partial */
      }
      for (const f of failures) {
        const url = String(f.u ?? "");
        const status = Number(f.s);
        if (!url || !Number.isFinite(status) || status < 400) continue;
        this.push(seeded, { kind: "network", level: "error", message: `${status} ${url}`, source: { url }, time: this.now() });
      }
    }
  }

  /** Did this log start after `generation` had loaded (its load-time records may be partial)? */
  attachedLate(generation: string | null = this.generation): boolean {
    return !!generation && this.lateAttached.has(generation);
  }

  get mainFrame(): string | null {
    return this.mainFrameId;
  }

  dispose(): void {
    this.sub?.dispose();
    this.sub = undefined;
    this.docListeners.clear();
  }

  get documentGeneration(): string | null {
    return this.generation;
  }

  /** The agent step now running (CR-08); records captured meanwhile carry it. */
  setStep(step: number | null): void {
    this.step = step;
  }

  get currentStep(): number | null {
    return this.step;
  }

  /** Called with the new generation whenever the main frame commits a new document. */
  onNewDocument(listener: (generation: string) => void): { dispose(): void } {
    this.docListeners.add(listener);
    return { dispose: () => this.docListeners.delete(listener) };
  }

  records(generation: string | null = this.generation): PageRecord[] {
    if (!generation) return [];
    return [...(this.byGeneration.get(generation)?.records ?? [])];
  }

  dropped(generation: string | null = this.generation): number {
    if (!generation) return 0;
    return this.byGeneration.get(generation)?.dropped ?? 0;
  }

  /** The message of a JavaScript dialog that is open now, or null. */
  get openDialog(): string | null {
    return this.dialog;
  }

  /** Visible for tests: feed one CDP event. */
  handle(method: string, p: Record<string, any>): void {
    switch (method) {
      case "Page.javascriptDialogOpening":
        this.dialog = `${String(p.type ?? "dialog")}: ${String(p.message ?? "")}`;
        return;
      case "Page.javascriptDialogClosed":
        this.dialog = null;
        return;
      case "Page.frameNavigated": {
        const frame = p.frame;
        if (!frame || frame.parentId) return;
        this.mainFrameId = frame.id ?? this.mainFrameId;
        if (typeof frame.loaderId === "string" && frame.loaderId) this.setGeneration(frame.loaderId, true);
        return;
      }
      case "Runtime.executionContextCreated": {
        const ctx = p.context;
        if (!ctx || !Number.isFinite(ctx.id) || !this.generation) return;
        // A context belongs to the main document that existed when it was created.
        this.contexts.set(Number(ctx.id), this.generation);
        return;
      }
      case "Runtime.executionContextDestroyed":
        if (Number.isFinite(p.executionContextId)) this.contexts.delete(Number(p.executionContextId));
        return;
      case "Runtime.consoleAPICalled": {
        const gen = this.contexts.get(Number(p.executionContextId));
        const args: any[] = Array.isArray(p.args) ? p.args : [];
        this.push(gen, {
          kind: "console",
          level: String(p.type ?? "log"),
          message: args.map(remoteObjectText).join(" "),
          source: frameSource(p.stackTrace?.callFrames?.[0]),
          time: Number.isFinite(p.timestamp) ? Number(p.timestamp) : this.now(),
        });
        return;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails ?? {};
        const gen = this.contexts.get(Number(d.executionContextId));
        const description = typeof d.exception?.description === "string" ? d.exception.description.split("\n")[0] : "";
        this.push(gen, {
          kind: "exception",
          level: "error",
          message: description || String(d.text ?? "Uncaught exception"),
          source: frameSource(d.stackTrace?.callFrames?.[0]) ?? frameSource({ url: d.url, lineNumber: d.lineNumber, columnNumber: d.columnNumber }),
          time: Number.isFinite(p.timestamp) ? Number(p.timestamp) : this.now(),
        });
        return;
      }
      case "Network.requestWillBeSent": {
        if (typeof p.requestId !== "string" || !this.generation) return;
        const mainFrameRequest = p.frameId && p.frameId === this.mainFrameId && typeof p.loaderId === "string";
        this.requests.set(p.requestId, {
          url: String(p.request?.url ?? ""),
          generation: mainFrameRequest ? p.loaderId : this.generation,
        });
        return;
      }
      case "Network.responseReceived": {
        const req = this.requests.get(p.requestId);
        const status = Number(p.response?.status);
        if (!req || !Number.isFinite(status) || status < 400) return;
        this.failedRequests.add(p.requestId);
        this.push(req.generation, {
          kind: "network",
          level: "error",
          message: `${status} ${String(p.response?.statusText ?? "").trim()} ${req.url}`.replace(/\s+/g, " ").trim(),
          source: req.url ? { url: req.url } : undefined,
          time: this.now(),
        });
        return;
      }
      case "Network.loadingFailed": {
        const req = this.requests.get(p.requestId);
        // Seen only before Network.enable, cancelled (reload aborts), or already reported
        // as an HTTP error: none of these is a new failure.
        if (!req || p.canceled === true || this.failedRequests.has(p.requestId)) return;
        this.failedRequests.add(p.requestId);
        this.push(req.generation, {
          kind: "network",
          level: "error",
          message: `${String(p.errorText ?? "request failed")} ${req.url}`.trim(),
          source: req.url ? { url: req.url } : undefined,
          time: this.now(),
        });
        return;
      }
      case "Log.entryAdded": {
        const entry = p.entry ?? {};
        if (DUPLICATE_LOG_SOURCES.has(String(entry.source))) return;
        if (entry.level !== "error" && entry.level !== "warning") return;
        // Attribute through the request when the entry names one; otherwise an entry that
        // arrives right after a commit may be the previous document's, so it is dropped
        // rather than guessed onto the new one (CR-05 negative).
        const viaRequest = typeof entry.networkRequestId === "string" ? this.requests.get(entry.networkRequestId)?.generation : undefined;
        if (!viaRequest && this.now() - this.committedAt < LOG_COMMIT_WINDOW_MS) return;
        this.push(viaRequest ?? this.generation ?? undefined, {
          kind: "log",
          level: String(entry.level),
          message: String(entry.text ?? ""),
          source: frameSource({ url: entry.url, lineNumber: entry.lineNumber }),
          time: Number.isFinite(entry.timestamp) ? Number(entry.timestamp) : this.now(),
        });
        return;
      }
      default:
        return;
    }
  }

  private setGeneration(generation: string, notify: boolean): void {
    if (generation === this.generation) return;
    this.generation = generation;
    if (notify) this.committedAt = this.now();
    if (!this.byGeneration.has(generation)) this.byGeneration.set(generation, { records: [], dropped: 0 });
    while (this.byGeneration.size > this.keepDocuments) {
      const oldest = this.byGeneration.keys().next().value as string;
      this.byGeneration.delete(oldest);
    }
    if (notify) for (const fn of [...this.docListeners]) fn(generation);
  }

  private push(generation: string | undefined, rec: Omit<PageRecord, "documentGeneration" | "step">): void {
    // A record we cannot attribute to a known document is dropped, never guessed onto
    // the current one (CR-05 negative).
    if (!generation) return;
    // A main-frame request names its loader before `Page.frameNavigated` commits it, so
    // a bucket may not exist yet; it is created for that loader, never merged into another.
    let bucket = this.byGeneration.get(generation);
    if (!bucket) {
      bucket = { records: [], dropped: 0 };
      this.byGeneration.set(generation, bucket);
    }
    if (bucket.records.length >= this.maxPerDocument) {
      bucket.dropped++;
      return;
    }
    bucket.records.push({
      ...rec,
      message: rec.message.slice(0, MAX_MESSAGE),
      ...(rec.source ? { source: rec.source } : {}),
      documentGeneration: generation,
      step: this.step,
    } as PageRecord);
  }
}

// ── Artifact version reference (CR-10; recon R4) ────────────────────────────

export interface ArtifactFileRef {
  path: string;
  sha256: string;
  bytes: number;
}

/** The artifact version a browser result was taken against. */
export interface ArtifactVersionRef {
  /** sha256 of the canonical JSON of the sorted file list (recon R4), `sha256:<hex>`. */
  id: string;
  /** Entry HTML path relative to the served root. */
  entry: string;
  files: ArtifactFileRef[];
}

// ── Observation (CR-04) ─────────────────────────────────────────────────────

export interface Observation {
  url: string;
  /** URL path relative to the served root, with query and hash. */
  route: string;
  title: string;
  /** AX snapshot text with `[ref=eN]` labels. */
  snapshot: string;
  refs: string[];
  screenshot: { mimeType: "image/jpeg"; data: string };
  viewport: { width: number; height: number };
  documentGeneration: string;
  records: PageRecord[];
  droppedRecords: number;
  /** True when observation began after this document had loaded: load-time records may be missing. */
  recordsPartial?: boolean;
  step: number | null;
  artifact: ArtifactVersionRef | null;
}

export const OBSERVATION_REQUIRED = ["url", "route", "snapshot", "screenshot", "viewport", "documentGeneration", "artifact"] as const;

/**
 * An observation missing any required part is an explicit error, never a partial success
 * (CR-04 negative). `artifact` is required too: a browser result with no artifact version
 * is refused (CR-10 negative).
 */
export function observationProblems(o: Partial<Observation> | null | undefined): string[] {
  if (!o || typeof o !== "object") return [...OBSERVATION_REQUIRED];
  const missing: string[] = [];
  if (typeof o.url !== "string" || !o.url) missing.push("url");
  if (typeof o.route !== "string" || !o.route) missing.push("route");
  if (typeof o.snapshot !== "string" || !o.snapshot) missing.push("snapshot");
  if (!o.screenshot || typeof o.screenshot.data !== "string" || !o.screenshot.data) missing.push("screenshot");
  if (!o.viewport || !(o.viewport.width > 0) || !(o.viewport.height > 0)) missing.push("viewport");
  if (typeof o.documentGeneration !== "string" || !o.documentGeneration) missing.push("documentGeneration");
  if (!o.artifact || typeof o.artifact.id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(o.artifact.id)) missing.push("artifact");
  return missing;
}

/** Route = URL path relative to the served root; `__hp_viewport?path=` unwraps to its target. */
export function routeOf(href: string): string {
  try {
    const u = new URL(href);
    if (u.pathname === "/__hp_viewport") return u.searchParams.get("path") || "/";
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return "";
  }
}

// ── Origin scope (CR-11) ────────────────────────────────────────────────────

export type OriginVerdict = { ok: true } | { ok: false; reason: string };

/** The live server's viewport-inspection wrapper (hypeproof-chat.previewViewport). */
export const VIEWPORT_WRAPPER_PATH = "/__hp_viewport";

/** An agent action moved the tab out of scope (CR-11); `url` is where it went. */
export class ScopeEscapeError extends Error {
  readonly url: string;
  constructor(url: string, reason: string) {
    super(reason);
    this.name = "ScopeEscapeError";
    this.url = url;
  }
}

/**
 * May an agent browser action act on `url`? Only the student's own artifact origins
 * (`allowedOrigins`: the live-server origin today; published test origins of the same
 * project arrive with cr-publish). Everything else, file:// included, is refused with a
 * reason before any CDP call.
 */
export function checkAgentOrigin(url: string, allowedOrigins: readonly string[]): OriginVerdict {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { ok: false, reason: `주소를 해석할 수 없어요: ${url}` };
  }
  const allowed = allowedOrigins.filter(Boolean);
  if (origin !== "null" && new URL(url).pathname === VIEWPORT_WRAPPER_PATH) {
    // The viewport wrapper shows the student's page in an iframe; the main-frame tree,
    // refs and document generation would all be the wrapper's, not the student's page.
    return { ok: false, reason: "화면 크기 비교 보기(__hp_viewport)에서는 실험 브라우저가 움직이지 않아요. 원래 미리보기 주소로 연 뒤에 다시 시도하세요." };
  }
  if (allowed.length === 0) {
    return { ok: false, reason: "학생 미리보기가 켜져 있지 않아요. 실험 브라우저는 미리보기 주소에서만 움직여요 — 먼저 미리보기를 시작하세요." };
  }
  if (allowed.includes(origin)) return { ok: true };
  return {
    ok: false,
    reason: `실험 브라우저는 학생 자신의 미리보기(${allowed.join(", ")})에서만 움직여요. ${origin === "null" ? url : origin} 은(는) 범위 밖이라 거절했어요.`,
  };
}

// ── Element actions (CR-06) ─────────────────────────────────────────────────

/** CDP answers for a node that belonged to an earlier document (AE-18). */
const STALE_NODE = /could not compute box model|no node with given id|does not belong to the document|node is detached|cannot find context with specified id|no node found/i;

export class StaleRefError extends Error {
  constructor(ref: string) {
    super(`${ref}는 이전 문서의 ref라 실행하지 않았어요. browser_observe로 다시 읽어 최신 ref를 받아주세요.`);
    this.name = "StaleRefError";
  }
}

export const isStaleNodeError = (err: unknown): boolean => STALE_NODE.test(err instanceof Error ? err.message : String(err));

async function objectIdOf(cdp: CdpLike, backendNodeId: number, ref: string): Promise<string> {
  try {
    const r = await cdp.send("DOM.resolveNode", { backendNodeId });
    const id = r?.object?.objectId;
    if (typeof id !== "string") throw new StaleRefError(ref);
    return id;
  } catch (err) {
    if (err instanceof StaleRefError || isStaleNodeError(err)) throw new StaleRefError(ref);
    throw err;
  }
}

async function callOn(cdp: CdpLike, objectId: string, fn: string, args: unknown[] = []): Promise<any> {
  const r = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
  });
  if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "script error"));
  return r?.result?.value;
}

const SELECT_FN = `function(v){
  if (!this || this.tagName !== 'SELECT') return { ok: false, reason: 'not_select' };
  if (this.disabled) return { ok: false, reason: 'disabled' };
  var opts = Array.prototype.slice.call(this.options);
  var o = opts.find(function(x){ return x.value === v; }) || opts.find(function(x){ return (x.text || '').trim() === v; });
  if (!o) return { ok: false, reason: 'no_option', options: opts.map(function(x){ return x.value; }) };
  this.value = o.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: o.value };
}`;

export async function selectByNode(cdp: CdpLike, backendNodeId: number, ref: string, value: string): Promise<string> {
  const objectId = await objectIdOf(cdp, backendNodeId, ref);
  const r = await callOn(cdp, objectId, SELECT_FN, [value]);
  if (!r?.ok) {
    if (r?.reason === "not_select") throw new Error(`${ref}는 선택 상자가 아니에요.`);
    if (r?.reason === "disabled") throw new Error(`${ref} 선택 상자가 비활성 상태예요.`);
    throw new Error(`${ref}에 "${value}" 선택지가 없어요${Array.isArray(r?.options) ? ` (있는 값: ${r.options.join(", ")})` : ""}.`);
  }
  return String(r.value);
}

/**
 * DOM-level scrolling (`scrollIntoView` / `scrollBy`): it worked in every probe run,
 * locked or not, while CDP `mouseWheel` needs composited frames (recon F7, F8).
 */
export async function scrollByNode(cdp: CdpLike, backendNodeId: number, ref: string): Promise<void> {
  const objectId = await objectIdOf(cdp, backendNodeId, ref);
  await callOn(cdp, objectId, "function(){ this.scrollIntoView({ block: 'center', inline: 'nearest' }); return true; }");
}

export async function scrollPage(cdp: CdpLike, dy: number): Promise<number> {
  const r = await cdp.send("Runtime.evaluate", { expression: `window.scrollBy(0, ${Math.trunc(dy)}); window.scrollY`, returnByValue: true });
  return Number(r?.result?.value ?? 0);
}

export async function nodeCenter(cdp: CdpLike, backendNodeId: number, ref: string): Promise<{ x: number; y: number }> {
  let box: any;
  try {
    await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch((err: unknown) => {
      if (isStaleNodeError(err)) throw err;
    });
    box = await cdp.send("DOM.getBoxModel", { backendNodeId });
  } catch (err) {
    if (isStaleNodeError(err)) throw new StaleRefError(ref);
    throw err;
  }
  const q: number[] | undefined = box?.model?.content;
  if (!Array.isArray(q) || q.length < 8) throw new StaleRefError(ref);
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

export async function hoverByNode(cdp: CdpLike, backendNodeId: number, ref: string): Promise<void> {
  const { x, y } = await nodeCenter(cdp, backendNodeId, ref);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

/** `Page.reload`, then wait until a NEW document is loaded (a new generation). */
export async function reloadAndWait(cdp: CdpLike, log: PageEventLog, timeoutMs = 12_000, sleep = defaultSleep): Promise<string> {
  const before = log.documentGeneration;
  await cdp.send("Page.reload", { ignoreCache: false });
  const until = Date.now() + timeoutMs;
  for (;;) {
    const gen = log.documentGeneration;
    if (gen && gen !== before) {
      const ready = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }).catch(() => null);
      if (ready?.result?.value === "complete") return gen;
    }
    if (Date.now() > until) throw new Error("새로 고친 페이지가 제때 뜨지 않았어요.");
    await sleep(100);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Automation indicator (CR-68; recon R11) ─────────────────────────────────

/**
 * The page-level half of the automation indicator: an inspector-overlay outline around
 * the viewport while an agent step runs. It leaves the page DOM and AX tree unchanged,
 * but it does reach CDP screenshots, so evidence captures run inside `withHidden`.
 * The chat-panel half is the existing tool-log line (`browserToolLogLine`).
 */
export class AutomationIndicator {
  private shown = false;
  private enabled = false;
  private rect = { width: 0, height: 0 };
  private readonly cdp: CdpLike;
  private readonly onChange?: (visible: boolean) => void;
  constructor(cdp: CdpLike, onChange?: (visible: boolean) => void) {
    this.cdp = cdp;
    this.onChange = onChange;
  }

  get visible(): boolean {
    return this.shown;
  }

  async show(): Promise<void> {
    if (!this.enabled) {
      await this.cdp.send("DOM.enable", {});
      await this.cdp.send("Overlay.enable", {});
      this.enabled = true;
    }
    const vp = await readViewport(this.cdp).catch(() => ({ width: 0, height: 0 }));
    this.rect = { width: Math.max(1, vp.width), height: Math.max(1, vp.height) };
    await this.draw();
    this.shown = true;
    this.onChange?.(true);
  }

  async hide(): Promise<void> {
    if (!this.shown) return;
    await this.cdp.send("Overlay.hideHighlight", {}).catch(() => {});
    this.shown = false;
    this.onChange?.(false);
  }

  /** Run `fn` with the outline cleared (an evidence screenshot), then redraw it. */
  async withHidden<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.shown) return fn();
    await this.cdp.send("Overlay.hideHighlight", {}).catch(() => {});
    try {
      return await fn();
    } finally {
      await this.draw().catch(() => {});
    }
  }

  private draw(): Promise<unknown> {
    return this.cdp.send("Overlay.highlightRect", {
      x: 0,
      y: 0,
      width: this.rect.width,
      height: this.rect.height,
      color: { r: 255, g: 122, b: 0, a: 0.04 },
      outlineColor: { r: 255, g: 122, b: 0, a: 0.95 },
    });
  }
}

export async function readViewport(cdp: CdpLike): Promise<{ width: number; height: number }> {
  // innerWidth/innerHeight, not Emulation: the shipped shell ignores
  // Emulation.setDeviceMetricsOverride (recon §8); fixed widths come from __hp_viewport.
  const r = await cdp.send("Runtime.evaluate", {
    expression: "JSON.stringify({w: window.innerWidth, h: window.innerHeight})",
    returnByValue: true,
  });
  const v = JSON.parse(String(r?.result?.value ?? "{}"));
  return { width: Number(v.w) || 0, height: Number(v.h) || 0 };
}

// ── Result shape and text (CR-04, CR-06, CR-08) ─────────────────────────────

/** Text the model reads for an observation. Plain data; the screenshot rides separately. */
export function observationText(o: Observation): string {
  const lines = [
    `URL: ${o.url}`,
    `경로: ${o.route}`,
    `제목: ${o.title}`,
    `뷰포트: ${o.viewport.width}x${o.viewport.height}`,
    `문서 세대: ${o.documentGeneration}`,
    `산출물 버전: ${o.artifact ? `${o.artifact.id} (${o.artifact.entry}, 파일 ${o.artifact.files.length}개)` : "없음"}`,
  ];
  if (o.records.length === 0) {
    lines.push(
      o.recordsPartial
        ? "이 문서의 콘솔·오류·실패한 요청: 확인된 것 없음 — 단, 관찰이 페이지가 뜬 뒤에 시작돼 로드 중의 요청 실패는 HTTP 오류만 되살렸어요. 확실히 보려면 browser_reload 하세요."
        : "이 문서의 콘솔·오류·실패한 요청: 없음",
    );
  } else {
    if (o.recordsPartial) lines.push("(관찰이 페이지가 뜬 뒤에 시작돼 로드 중의 요청 실패는 HTTP 오류만 되살렸어요.)");
    lines.push(`이 문서의 콘솔·오류·실패한 요청 ${o.records.length}건${o.droppedRecords ? ` (+${o.droppedRecords}건 생략)` : ""}:`);
    for (const r of o.records) {
      const where = r.source?.url ? ` @ ${r.source.url}${r.source.line ? `:${r.source.line}` : ""}` : "";
      lines.push(`- [${r.kind}/${r.level}]${r.step !== null ? ` 단계 ${r.step}` : ""} ${r.message}${where}`);
    }
  }
  lines.push("", o.snapshot);
  return lines.join("\n");
}

/**
 * The failures an agent must report (CR-08): errors and failed requests, each with the
 * step it happened in. Plain `console.log` output is kept in the observation but is not
 * a failure.
 */
export function failuresOf(records: readonly PageRecord[]): Array<{ step: number | null; kind: PageRecordKind; message: string }> {
  return records
    .filter((r) => r.kind === "exception" || r.kind === "network" || r.level === "error" || r.level === "assert")
    .map((r) => ({ step: r.step, kind: r.kind, message: r.message }));
}

// ── The CR executor (CR-04, CR-06, CR-11, CR-68) ────────────────────────────

/** A tool result in the same plain shape BrowserControl returns, plus the observation. */
export interface CrToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  isError: boolean;
  observation?: Observation;
}

/** What the executor needs from the tab owner (BrowserControl, or a mock in the smokes). */
export interface CrTabPort {
  /** The CDP session of the tab being driven; throws when there is none. */
  session(): Promise<CdpLike>;
  /** URL of the tab being driven, or undefined when there is no tab. */
  tabUrl(): string | undefined;
  /** Open a tab at, or navigate the driven tab to, an already-scoped URL and wait for load. */
  navigate(url: string): Promise<void>;
}

export interface CrHooks {
  /** Origins agent actions may act on (CR-11): the live-server origin today. */
  allowedOrigins(): readonly string[];
  /** The artifact version of the page at `url` (CR-10); throws with a reason. */
  artifactVersion(url: string): Promise<ArtifactVersionRef>;
  /** Chat-panel half of the indicator and anything else that follows a step (CR-68). */
  onIndicator?(visible: boolean, tool: string): void;
  /** Every successful result, for persistence on the measurement-core record (CR-10). */
  onResult?(tool: string, input: Record<string, unknown>, observation: Observation): void;
  /** Wait after an action before observing, so its console/network events arrive. */
  settleMs?: number;
  sleep?(ms: number): Promise<void>;
}

/** Tools the executor runs with the switch on: the existing eight plus the CR five. */
export const CR_EXECUTOR_TOOLS = [
  "browser_navigate",
  "browser_read",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_back",
  "browser_forward",
  "browser_dialog",
  "browser_observe",
  "browser_select",
  "browser_scroll",
  "browser_hover",
  "browser_reload",
] as const;

const OBSERVE_ONLY = new Set(["browser_observe", "browser_read", "browser_screenshot"]);

/**
 * CR-06 contract: an action result without its resulting observation is not a result.
 * Returns the problems; empty means the result honours the contract.
 */
export function actionResultProblems(name: string, result: CrToolResult): string[] {
  if (result.isError) return [];
  if (!(CR_EXECUTOR_TOOLS as readonly string[]).includes(name)) return [`unknown tool ${name}`];
  if (!result.observation) return ["missing observation"];
  return observationProblems(result.observation).map((m) => `observation missing ${m}`);
}

function crFail(text: string): CrToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export class CrExecutor {
  private readonly logs = new WeakMap<CdpLike, PageEventLog>();
  private readonly indicators = new WeakMap<CdpLike, AutomationIndicator>();
  private refs = new Map<string, number>();
  private refsGeneration: string | null = null;
  private step = 0;

  private readonly port: CrTabPort;
  private readonly hooks: CrHooks;

  constructor(port: CrTabPort, hooks: CrHooks) {
    this.port = port;
    this.hooks = hooks;
  }

  /** The event log of the tab's session, attached on first use. */
  async logFor(cdp: CdpLike): Promise<PageEventLog> {
    let log = this.logs.get(cdp);
    if (!log) {
      log = new PageEventLog();
      this.logs.set(cdp, log);
      await log.attach(cdp);
    }
    return log;
  }

  /** Remember the ref table of an observation (also used by element capture, CR-09). */
  adoptRefs(refs: Map<string, number>, generation: string): void {
    this.refs = refs;
    this.refsGeneration = generation;
  }

  refFor(backendNodeId: number): string | null {
    for (const [ref, id] of this.refs) if (id === backendNodeId) return ref;
    return null;
  }

  async execute(name: string, input: Record<string, unknown> = {}): Promise<CrToolResult> {
    if (!(CR_EXECUTOR_TOOLS as readonly string[]).includes(name)) return crFail(`알 수 없는 도구: ${name}`);
    // Scope first, before any CDP call (CR-11).
    const allowed = this.hooks.allowedOrigins();
    let target: string | null = null;
    if (name === "browser_navigate") {
      target = safeNavigateUrl(String(input.url ?? ""));
      if (!target) return crFail(`허용되지 않은 주소예요: ${String(input.url ?? "")}`);
      const v = checkAgentOrigin(target, allowed);
      if (!v.ok) return crFail(v.reason);
    } else {
      const url = this.port.tabUrl();
      if (!url) return crFail("열린 브라우저 탭이 없어요. 먼저 미리보기를 여세요.");
      const v = checkAgentOrigin(url, allowed);
      if (!v.ok) return crFail(v.reason);
    }
    const observeOnly = OBSERVE_ONLY.has(name);
    const step = observeOnly ? (this.step || null) : ++this.step;
    const startUrl = name === "browser_navigate" ? null : this.port.tabUrl() ?? null;
    let cdp: CdpLike | null = null;
    let log: PageEventLog | null = null;
    let indicator: AutomationIndicator | null = null;
    /** The first out-of-scope main-frame navigation the step caused, if any (CR-11). */
    const escape: { to: string | null } = { to: null };
    let watch: { dispose(): void } | undefined;
    const watchNavigations = (c: CdpLike, l: PageEventLog) => {
      watch = c.onEvent((e) => {
        if (escape.to) return;
        const url = mainFrameNavigationUrl(e, l.mainFrame);
        if (url && !checkAgentOrigin(url, allowed).ok) {
          escape.to = url;
          // Stop it before it commits where we can; the post-step check restores otherwise.
          void c.send("Page.stopLoading", {}).catch(() => {});
        }
      });
    };
    const showIndicator = async () => {
      if (!cdp) return;
      indicator ??= this.indicatorFor(cdp, name);
      await indicator.show().catch(() => {});
    };
    try {
      if (name === "browser_navigate") {
        // The tab may not exist yet; the indicator starts once there is a page to draw on.
        this.hooks.onIndicator?.(true, name);
        await this.port.navigate(target!);
        cdp = await this.port.session();
        log = await this.logFor(cdp);
        log.setStep(step);
        await showIndicator();
      } else {
        cdp = await this.port.session();
        log = await this.logFor(cdp);
        log.setStep(step);
        watchNavigations(cdp, log);
        this.hooks.onIndicator?.(true, name);
        // A native JS dialog blocks page evaluation, so the page outline cannot be drawn
        // while one is open; the dialog itself and the chat-panel line are what show.
        if (!log.openDialog) await showIndicator();
        const message = await this.act(cdp, log, name, input);
        if (message === null) return crFail(`알 수 없는 도구: ${name}`);
        if (!observeOnly) await (this.hooks.sleep ?? defaultSleep)(this.hooks.settleMs ?? 250);
        if (escape.to) {
          const v = checkAgentOrigin(escape.to, allowed);
          throw new ScopeEscapeError(escape.to, v.ok ? "" : v.reason);
        }
        return await this.finish(cdp, name, input, message, step, indicator);
      }
      return await this.finish(cdp, name, input, `이동 완료 — ${target}`, step, indicator);
    } catch (err) {
      if (err instanceof ScopeEscapeError && cdp && log) return crFail(await this.refuseEscape(cdp, log, name, err, startUrl));
      return crFail(err instanceof Error ? err.message : String(err));
    } finally {
      watch?.dispose();
      if (indicator) await (indicator as AutomationIndicator).hide().catch(() => {});
      this.hooks.onIndicator?.(false, name);
      // Records captured after this step belong to no step (CR-08): not carried over.
      log?.setStep(null);
    }
  }

  /**
   * An action navigated the tab off scope (a link, a script setting location, a form
   * submit, a redirect). Nothing of that page is observed or returned: the load is
   * stopped, the tab is taken back to where the step started, and the result is a
   * refusal with the reason (CR-11). The refs are dropped, since they were the old page's.
   */
  private async refuseEscape(cdp: CdpLike, log: PageEventLog, name: string, err: ScopeEscapeError, startUrl: string | null): Promise<string> {
    this.refs = new Map();
    this.refsGeneration = null;
    const allowed = this.hooks.allowedOrigins();
    await cdp.send("Page.stopLoading", {}).catch(() => {});
    let where = "";
    const now = await currentHref(cdp).catch(() => null);
    if (now && checkAgentOrigin(now, allowed).ok) where = `탭은 그대로 ${now} 에 있어요.`;
    else if (startUrl && checkAgentOrigin(startUrl, allowed).ok) {
      const before = log.documentGeneration;
      try {
        await cdp.send("Page.navigate", { url: startUrl });
        await waitForDocument(cdp, log, before, this.hooks.sleep);
        where = `탭을 ${startUrl} (으)로 되돌렸어요.`;
      } catch {
        where = `탭을 ${startUrl} (으)로 되돌리지 못했어요 — 미리보기를 다시 여세요.`;
      }
    } else where = "탭을 되돌릴 주소가 없어요 — 미리보기를 다시 여세요.";
    return `${name} 때문에 페이지가 범위 밖(${err.url})으로 가려 해서 멈췄어요. ${err.message} ${where} 그 페이지는 관찰하지 않았어요. browser_observe로 다시 읽어 최신 ref를 받아주세요.`;
  }

  private indicatorFor(cdp: CdpLike, _tool: string): AutomationIndicator {
    let ind = this.indicators.get(cdp);
    if (!ind) {
      ind = new AutomationIndicator(cdp);
      this.indicators.set(cdp, ind);
    }
    return ind;
  }

  /** Run one action; the message describes what was done. */
  private async act(cdp: CdpLike, log: PageEventLog, name: string, input: Record<string, unknown>): Promise<string | null> {
    switch (name) {
      case "browser_observe":
      case "browser_read":
      case "browser_screenshot":
        return "관찰했어요.";
      case "browser_click": {
        const ref = String(input.ref ?? "");
        const { x, y } = await nodeCenter(cdp, this.node(ref, log), ref);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        return `${ref} 클릭했어요.`;
      }
      case "browser_type": {
        const ref = String(input.ref ?? "");
        const { x, y } = await nodeCenter(cdp, this.node(ref, log), ref);
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        await cdp.send("Input.insertText", { text: String(input.text ?? "") });
        if (input.submit === true) {
          const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
        }
        return input.submit === true ? `${ref}에 입력하고 Enter를 눌렀어요.` : `${ref}에 입력했어요.`;
      }
      case "browser_select": {
        const ref = String(input.ref ?? "");
        const value = await selectByNode(cdp, this.node(ref, log), ref, String(input.value ?? ""));
        return `${ref}에서 "${value}"를 골랐어요.`;
      }
      case "browser_scroll": {
        const ref = typeof input.ref === "string" && input.ref ? input.ref : null;
        if (ref) {
          await scrollByNode(cdp, this.node(ref, log), ref);
          return `${ref}가 보이게 스크롤했어요.`;
        }
        const dy = Number(input.dy);
        if (!Number.isFinite(dy) || dy === 0) throw new Error("browser_scroll에는 ref 또는 0이 아닌 dy가 필요해요.");
        const y = await scrollPage(cdp, dy);
        return `페이지를 ${Math.trunc(dy)}px 스크롤했어요 (scrollY=${y}).`;
      }
      case "browser_hover": {
        const ref = String(input.ref ?? "");
        await hoverByNode(cdp, this.node(ref, log), ref);
        return `${ref} 위에 마우스를 올렸어요.`;
      }
      case "browser_reload":
        await reloadAndWait(cdp, log, 12_000, this.hooks.sleep);
        return "새로 고쳤어요.";
      case "browser_back":
      case "browser_forward": {
        const dir = name === "browser_back" ? -1 : 1;
        const h = await cdp.send("Page.getNavigationHistory", {});
        const entries: Array<{ id?: number; url?: string }> = h?.entries ?? [];
        const entry = entries[(h?.currentIndex ?? 0) + dir];
        if (!entry || typeof entry.id !== "number") throw new Error(dir < 0 ? "뒤로 갈 페이지가 없어요." : "앞으로 갈 페이지가 없어요.");
        const v = checkAgentOrigin(String(entry.url ?? ""), this.hooks.allowedOrigins());
        if (!v.ok) throw new Error(v.reason);
        const before = log.documentGeneration;
        await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
        await waitForDocument(cdp, log, before, this.hooks.sleep);
        return dir < 0 ? "뒤로 갔어요." : "앞으로 갔어요.";
      }
      case "browser_dialog": {
        const action = String(input.action ?? "");
        if (action !== "accept" && action !== "dismiss") throw new Error(`action은 accept 또는 dismiss여야 해요: ${action}`);
        await cdp.send("Page.handleJavaScriptDialog", {
          accept: action === "accept",
          ...(typeof input.promptText === "string" ? { promptText: input.promptText } : {}),
        });
        return "대화상자를 처리했어요.";
      }
      default:
        return null;
    }
  }

  /** The node behind a ref, refused when the ref belongs to an earlier document (AE-18). */
  private node(ref: string, log: PageEventLog): number {
    const id = this.refs.get(ref);
    if (id === undefined) throw new Error(`${ref}를 찾을 수 없어요. browser_observe로 페이지를 다시 읽어 최신 ref를 받아주세요.`);
    if (!this.refsGeneration || this.refsGeneration !== log.documentGeneration) throw new StaleRefError(ref);
    return id;
  }

  private async finish(
    cdp: CdpLike,
    name: string,
    input: Record<string, unknown>,
    message: string,
    step: number | null,
    indicator: AutomationIndicator | null,
  ): Promise<CrToolResult> {
    const log = await this.logFor(cdp);
    if (log.openDialog) {
      // A JS dialog blocks page evaluation, so there is nothing to observe: say so.
      return crFail(`${message} 페이지에 대화상자가 열려 있어 관찰할 수 없어요 (${log.openDialog}). browser_dialog로 먼저 처리하세요.`);
    }
    const observation = await observePage(cdp, log, {
      step,
      indicator,
      scope: (url) => checkAgentOrigin(url, this.hooks.allowedOrigins()),
      artifactVersion: (url) => this.hooks.artifactVersion(url),
    });
    this.adoptRefs(observation.refMap, observation.documentGeneration);
    const { refMap: _refs, ...obs } = observation;
    const missing = observationProblems(obs);
    if (missing.length) return crFail(`관찰이 완전하지 않아 결과로 쓰지 않았어요 — 빠진 것: ${missing.join(", ")}`);
    this.hooks.onResult?.(name, input, obs);
    return {
      content: [
        { type: "text", text: `${message}\n\n${observationText(obs)}` },
        { type: "image_url", image_url: { url: `data:${obs.screenshot.mimeType};base64,${obs.screenshot.data}` } },
      ],
      isError: false,
      observation: obs,
    };
  }
}

/** The URL a main-frame navigation event is heading to, or null for anything else. */
function mainFrameNavigationUrl(e: { method: string; params: Record<string, any> }, mainFrameId: string | null): string | null {
  const p = e.params ?? {};
  if (e.method === "Page.frameRequestedNavigation" || e.method === "Page.frameStartedNavigating") {
    if (mainFrameId && p.frameId !== mainFrameId) return null;
    return typeof p.url === "string" ? p.url : null;
  }
  if (e.method === "Page.frameNavigated") {
    if (!p.frame || p.frame.parentId) return null;
    return typeof p.frame.url === "string" ? p.frame.url : null;
  }
  return null;
}

async function currentHref(cdp: CdpLike): Promise<string> {
  const r = await cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, 3000);
  return String(r?.result?.value ?? "");
}

async function waitForDocument(cdp: CdpLike, log: PageEventLog, before: string | null, sleep = defaultSleep, timeoutMs = 12_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (log.documentGeneration !== before) {
      const r = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }).catch(() => null);
      if (r?.result?.value === "complete") return;
    }
    if (Date.now() > until) return;
    await sleep(100);
  }
}

/**
 * One observation of the page (CR-04). A missing part is left missing, never filled in,
 * so `observationProblems` can refuse the result; a failing part throws with its reason.
 */
export async function observePage(
  cdp: CdpLike,
  log: PageEventLog,
  opts: {
    step: number | null;
    indicator?: AutomationIndicator | null;
    /** CR-11: a page out of scope is never observed; it throws ScopeEscapeError instead. */
    scope?(url: string): OriginVerdict;
    artifactVersion(url: string): Promise<ArtifactVersionRef>;
  },
): Promise<Observation & { refMap: Map<string, number> }> {
  const loc = await cdp.send("Runtime.evaluate", {
    expression: "JSON.stringify({h: location.href, t: document.title})",
    returnByValue: true,
  });
  const page = JSON.parse(String(loc?.result?.value ?? "{}"));
  const url = String(page.h ?? "");
  const inScope = opts.scope?.(url);
  if (inScope && !inScope.ok) throw new ScopeEscapeError(url, inScope.reason);
  let generation = log.documentGeneration;
  let ax = await cdp.send("Accessibility.getFullAXTree", {});
  if (log.documentGeneration !== generation) {
    // A new document committed while the tree was read: read again, once.
    generation = log.documentGeneration;
    ax = await cdp.send("Accessibility.getFullAXTree", {});
  }
  const { text, refs } = buildAxSnapshot(Array.isArray(ax?.nodes) ? ax.nodes : []);
  const viewport = await readViewport(cdp);
  const capture = () => cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
  const shot = opts.indicator ? await opts.indicator.withHidden(capture) : await capture();
  let artifact: ArtifactVersionRef;
  try {
    artifact = await opts.artifactVersion(url);
  } catch (err) {
    throw new Error(`이 페이지의 산출물 버전을 정하지 못해 결과로 쓰지 않았어요 (${err instanceof Error ? err.message : String(err)}).`);
  }
  return {
    url,
    route: routeOf(url),
    title: String(page.t ?? ""),
    snapshot: text,
    refs: [...refs.keys()],
    refMap: refs,
    screenshot: { mimeType: "image/jpeg", data: String(shot?.data ?? "") },
    viewport,
    documentGeneration: generation ?? "",
    records: log.records(generation),
    droppedRecords: log.dropped(generation),
    ...(log.attachedLate(generation) ? { recordsPartial: true } : {}),
    step: opts.step,
    artifact,
  };
}
