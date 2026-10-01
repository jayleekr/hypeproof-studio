// Browser results bound to an artifact version (CR-10; recon R4, SX-48).
//
// Every Experiment Browser result (observation, action trace, element capture) names the
// artifact version and file-set digest it was taken against. It persists on the ONE
// measurement-core record: the `tool_result` observation event of the call that produced
// it carries the artifact references as event keys (`artifact_version`,
// `screenshot_digest`, `trace_digest`; BROWSER_RESULT_REF_KEYS, Jay's decision 8 of
// 2026-10-01: additive optional keys on hps-observation/1), and its `text` keeps the
// readable record under the `hps-browser-result/1` tag. The screenshot and trace bytes go
// to the same local record, content-addressed (`LocalRecord.putBlob`). There is no
// browser-result store, validator or schema of its own.
//
// A browser result does not record the version as an `artifact` event; the keys above
// reference it. cr-verify does record versions that way for `artifact_after`, tagged
// `hps-artifact-version/1`, and `observableAssets` skips those (`isVersionArtifact`,
// measurement-core verification.ts), so they never count as revisions.
//
// Pure and vscode-free.

import { createHash } from "node:crypto";
import { canonicalJson, digestOf, redactDeep } from "../../../worker/src/lib/measurement-core/local-record.ts";
import type { ArtifactFileRef, Observation, PageRecordKind } from "./experimentBrowser.ts";

export const BROWSER_RESULT_FORMAT = "hps-browser-result/1";
const MAX_FILES = 40;
const MAX_RECORDS = 20;
const MAX_URL = 1_000;
const MAX_PATH = 200;
/**
 * The recorder keeps the first 20,000 characters of an event's text
 * (nativeObservationRecorder.ts). A record over that would be cut mid-JSON and read back
 * as nothing, so the serialized record is held under this bound: fields are capped, and
 * listed files, then records, are dropped until it fits (`file_count` keeps the real count).
 */
export const MAX_RECORD_TEXT = 18_000;

export type BrowserResultKind = "observation" | "action" | "capture";

export interface BrowserResultRecord {
  format: typeof BROWSER_RESULT_FORMAT;
  kind: BrowserResultKind;
  tool: string;
  at: number;
  outcome: "success" | "error";
  url: string;
  route: string;
  document_generation: string;
  step: number | null;
  artifact_version: string;
  artifact_entry: string;
  file_count: number;
  /** The first files of the set; the full set is named by `artifact_version`. */
  files: ArtifactFileRef[];
  /** null when the result had no screenshot, or its bytes could not be stored. */
  screenshot_digest: string | null;
  /** null only when the trace bytes could not be stored. */
  trace_digest: string | null;
  /**
   * `earlier_request` (additive, decision 8) marks a record captured during an earlier agent
   * request's step (CR-08): the list then counts failures by the same rule the agent did.
   */
  records: Array<{ kind: PageRecordKind; level: string; message: string; step: number | null; earlier_request?: true }>;
}

const VERSION = /^sha256:[a-f0-9]{64}$/;

/** sha256 of the decoded image bytes, as `sha256:<hex>`. */
export function imageDigest(base64: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex")}`;
}

/** The bytes a record names by digest, to be stored before the event that names them. */
export interface BrowserResultBlobs {
  screenshot: { media_type: "image/jpeg" | "image/png"; base64: string } | null;
  /** MC-30-redacted, so `trace_digest` = `digestOf(trace)` = what the record stores. */
  trace: Record<string, unknown>;
}

type ResultInput = {
  kind: BrowserResultKind;
  tool: string;
  input?: Record<string, unknown>;
  outcome: "success" | "error";
  at?: number;
  observation: Pick<Observation, "url" | "route" | "documentGeneration" | "step" | "records" | "artifact"> & {
    screenshot?: { data: string; mimeType?: string } | null;
  };
};

/**
 * Build the record of one result and the bytes it names. A result with no artifact
 * version is refused (`missing_artifact_version`, CR-10 negative): it cannot be
 * attributed to anything.
 */
export async function browserResultParts(input: ResultInput): Promise<{ record: BrowserResultRecord; blobs: BrowserResultBlobs }> {
  const o = input.observation;
  const artifact = o?.artifact;
  if (!artifact || typeof artifact.id !== "string" || !VERSION.test(artifact.id)) throw new Error("missing_artifact_version");
  // Redacted before it is digested, so the digest names exactly the bytes the record keeps
  // (a key typed into a page by the agent never reaches storage, MC-30).
  const trace = redactDeep({ tool: input.tool, input: input.input ?? {}, outcome: input.outcome, step: o.step, document_generation: o.documentGeneration });
  const shot = o.screenshot?.data ? o.screenshot : null;
  const record: BrowserResultRecord = {
    format: BROWSER_RESULT_FORMAT,
    kind: input.kind,
    tool: input.tool.slice(0, 64),
    at: input.at ?? Date.now(),
    outcome: input.outcome,
    url: o.url.slice(0, MAX_URL),
    route: o.route.slice(0, MAX_URL),
    document_generation: o.documentGeneration.slice(0, 100),
    step: o.step,
    artifact_version: artifact.id,
    artifact_entry: artifact.entry.slice(0, MAX_PATH),
    file_count: artifact.files.length,
    files: artifact.files.slice(0, MAX_FILES).map((f) => ({ ...f, path: f.path.slice(0, MAX_PATH) })),
    screenshot_digest: shot ? imageDigest(shot.data) : null,
    trace_digest: await digestOf(trace),
    records: o.records.slice(0, MAX_RECORDS).map((r) => ({ kind: r.kind, level: r.level.slice(0, 20), message: r.message.slice(0, 200), step: r.step, ...(r.earlierRequest ? { earlier_request: true as const } : {}) })),
  };
  while (browserResultEventText(record).length > MAX_RECORD_TEXT && (record.files.length || record.records.length)) {
    if (record.files.length) record.files.pop();
    else record.records.pop();
  }
  const media_type = shot?.mimeType === "image/png" ? "image/png" : "image/jpeg";
  return { record, blobs: { screenshot: shot ? { media_type, base64: shot.data } : null, trace } };
}

/** The record alone (see `browserResultParts`). */
export async function browserResultRecord(input: ResultInput): Promise<BrowserResultRecord> {
  return (await browserResultParts(input)).record;
}

/** The event keys that carry a record's artifact references (BROWSER_RESULT_REF_KEYS). */
export function browserResultRefs(record: BrowserResultRecord): { artifact_version: string; screenshot_digest?: string; trace_digest?: string } {
  return {
    artifact_version: record.artifact_version,
    ...(record.screenshot_digest ? { screenshot_digest: record.screenshot_digest } : {}),
    ...(record.trace_digest ? { trace_digest: record.trace_digest } : {}),
  };
}

/** The `tool_result` event text that carries a record: format tag, newline, canonical JSON. */
export function browserResultEventText(record: BrowserResultRecord): string {
  if (!VERSION.test(record.artifact_version)) throw new Error("missing_artifact_version");
  return `${BROWSER_RESULT_FORMAT}\n${canonicalJson(record)}`;
}

/**
 * Read a record back from a stored event; null when the event is not a browser result.
 * When the event carries the artifact-reference keys they are the stored references and
 * must agree with the text; a record whose text names another version is not one.
 */
export function readBrowserResultEvent(event: { kind?: unknown; text?: unknown; artifact_version?: unknown; screenshot_digest?: unknown; trace_digest?: unknown }): BrowserResultRecord | null {
  if (event.kind !== "tool_result" || typeof event.text !== "string") return null;
  if (!event.text.startsWith(`${BROWSER_RESULT_FORMAT}\n`)) return null;
  let r: BrowserResultRecord;
  try {
    r = JSON.parse(event.text.slice(BROWSER_RESULT_FORMAT.length + 1)) as BrowserResultRecord;
  } catch {
    return null;
  }
  if (!r || r.format !== BROWSER_RESULT_FORMAT || !VERSION.test(String(r.artifact_version))) return null;
  if (event.artifact_version !== undefined && event.artifact_version !== r.artifact_version) return null;
  // The event keys say which bytes were stored; the text is only the readable copy.
  return {
    ...r,
    screenshot_digest: typeof event.screenshot_digest === "string" ? event.screenshot_digest : event.artifact_version !== undefined ? null : r.screenshot_digest,
    trace_digest: typeof event.trace_digest === "string" ? event.trace_digest : event.artifact_version !== undefined ? null : r.trace_digest,
  };
}

/**
 * Label results with the version they belong to. After the files change, earlier results
 * stay readable and say they belong to the earlier version (CR-10). `current` is the
 * version the files are at now, or a lookup by entry page (a result taken on `about.html`
 * is compared with the current version of `about.html`); null means the current version is
 * not known (the preview is off), and such a result is labelled `unknown`, never `earlier`.
 */
export function labelByVersion(
  records: readonly BrowserResultRecord[],
  current: string | null | ((entry: string) => string | null),
): Array<{ record: BrowserResultRecord; version: string; current: boolean; label: "current" | "earlier" | "unknown" }> {
  return records.map((record) => {
    const now = typeof current === "function" ? current(record.artifact_entry) : current;
    const label = now === null ? "unknown" : record.artifact_version === now ? "current" : "earlier";
    return { record, version: record.artifact_version, current: label === "current", label };
  });
}
