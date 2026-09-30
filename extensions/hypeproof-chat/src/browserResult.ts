// Browser results bound to an artifact version (CR-10; recon R4, SX-48).
//
// Every Experiment Browser result (observation, action trace, element capture) names the
// artifact version and file-set digest it was taken against. It persists on the ONE
// measurement-core record as the `text` of the `tool_result` observation event of the
// call that produced it: no browser-result store, validator or schema of its own.
// Screenshots and traces are referenced by content digest, never stored inline.
//
// Deviation from the recon's gap-matrix note ("extend ARTIFACT_REF_KEYS"), recorded in
// docs/plan/curriculum-runtime.md: the version id is not a new `hps-observation/2` key.
// Adding a stored key is a stored-schema change the plan lists as Jay's decision, and an
// `artifact` event per version would change what `observableAssets` counts as a revision.
// The result rides inside the existing `tool_result` text instead, under a format tag.
//
// Pure and vscode-free.

import { createHash } from "node:crypto";
import { canonicalJson, digestOf } from "../../../worker/src/lib/measurement-core/local-record.ts";
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
  screenshot_digest: string | null;
  trace_digest: string;
  records: Array<{ kind: PageRecordKind; level: string; message: string; step: number | null }>;
}

const VERSION = /^sha256:[a-f0-9]{64}$/;

/** sha256 of the decoded image bytes, as `sha256:<hex>`. */
export function imageDigest(base64: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex")}`;
}

/**
 * Build the record of one result. A result with no artifact version is refused
 * (`missing_artifact_version`, CR-10 negative) — it cannot be attributed to anything.
 */
export async function browserResultRecord(input: {
  kind: BrowserResultKind;
  tool: string;
  input?: Record<string, unknown>;
  outcome: "success" | "error";
  at?: number;
  observation: Pick<Observation, "url" | "route" | "documentGeneration" | "step" | "records" | "artifact"> & {
    screenshot?: { data: string } | null;
  };
}): Promise<BrowserResultRecord> {
  const o = input.observation;
  const artifact = o?.artifact;
  if (!artifact || typeof artifact.id !== "string" || !VERSION.test(artifact.id)) throw new Error("missing_artifact_version");
  const trace = { tool: input.tool, input: input.input ?? {}, outcome: input.outcome, step: o.step, document_generation: o.documentGeneration };
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
    screenshot_digest: o.screenshot?.data ? imageDigest(o.screenshot.data) : null,
    trace_digest: await digestOf(trace),
    records: o.records.slice(0, MAX_RECORDS).map((r) => ({ kind: r.kind, level: r.level.slice(0, 20), message: r.message.slice(0, 200), step: r.step })),
  };
  while (browserResultEventText(record).length > MAX_RECORD_TEXT && (record.files.length || record.records.length)) {
    if (record.files.length) record.files.pop();
    else record.records.pop();
  }
  return record;
}

/** The `tool_result` event text that carries a record: format tag, newline, canonical JSON. */
export function browserResultEventText(record: BrowserResultRecord): string {
  if (!VERSION.test(record.artifact_version)) throw new Error("missing_artifact_version");
  return `${BROWSER_RESULT_FORMAT}\n${canonicalJson(record)}`;
}

/** Read a record back from a stored event; null when the event is not a browser result. */
export function readBrowserResultEvent(event: { kind?: unknown; text?: unknown }): BrowserResultRecord | null {
  if (event.kind !== "tool_result" || typeof event.text !== "string") return null;
  if (!event.text.startsWith(`${BROWSER_RESULT_FORMAT}\n`)) return null;
  try {
    const r = JSON.parse(event.text.slice(BROWSER_RESULT_FORMAT.length + 1)) as BrowserResultRecord;
    return r && r.format === BROWSER_RESULT_FORMAT && VERSION.test(String(r.artifact_version)) ? r : null;
  } catch {
    return null;
  }
}

/**
 * Label results with the version they belong to. After the files change, earlier results
 * stay readable and say they belong to the earlier version (CR-10).
 */
export function labelByVersion(
  records: readonly BrowserResultRecord[],
  currentVersion: string | null,
): Array<{ record: BrowserResultRecord; version: string; current: boolean }> {
  return records.map((record) => ({ record, version: record.artifact_version, current: record.artifact_version === currentVersion }));
}
