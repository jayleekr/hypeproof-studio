// hps-local-record/1 — Jay's local work record (#1020 unit 2; MC-07/08, MC-22–27, MC-30/31, MC-35).
//
// Host-independent: everything persistent goes through an injected StoragePort, so the
// same logic can run in Studio, a local CLI or a test. The core never picks a location,
// never reaches the network and never evicts data to make room. A port's `write` must
// resolve only after the value is durable; `submit` still reads every submission back
// before it issues a receipt, so a port that loses or truncates data cannot fake one.
import { validateObservation, type ObservationEvent } from "./legacy-observation.ts";
import { returnItemProblem } from "./participant-evidence.ts";
import { draftRefusals, validateEvidenceDraftShape, validateInterpretation, type DraftRefusal, type EvidenceDraft, type Interpretation, type RefResolution } from "./interpretation.ts";
import type { TeacherState } from "./learning-events.ts";

export const LOCAL_RECORD_FORMAT = "hps-local-record/1";
/** Provisional local capacity (MC-35). Exposed, never enforced by deleting data; fixed with host evidence later. */
export const DEFAULT_LOCAL_MAX_BYTES = 256 * 1024 * 1024;
/**
 * What task deletion cannot reach, reported instead of claimed (MC-31). Browser-result
 * bytes (CR-10) that no observation of the task names are not the task's: they are
 * removed by `deleteBlobs` (the results command's "저장된 화면·동작 기록 지우기" row),
 * never by `deleteTask`. In Studio today no local-record observation names them at all:
 * the events that do live in the workspace's native observation batch, so `deleteTask`
 * removes browser-result bytes only for a future import that carries the digests.
 */
export const DELETE_NOT_COVERED = ["host_original_records", "copies_exported_by_the_user", "browser_result_bytes_not_named_by_the_task"] as const;

export interface StoragePort {
  /** Optional exact character usage; must include durable writes and never cache receipt reads. */
  usageBytes?(): Promise<number>;
  /** Optional exact character usage of the keys under one prefix (same rules as `usageBytes`). */
  usageOf?(prefix: string): Promise<number>;
  read(key: string): Promise<string | null>;
  /** Resolves only once durable. With `ifAbsent`, atomically rejects with Error("exists") if the key is taken. */
  write(key: string, value: string, options?: { ifAbsent?: boolean }): Promise<void>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const text = (v: unknown, n = 2000): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= n;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
const enc = encodeURIComponent;

/** Key-order independent JSON, so a digest names content rather than a serialization. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Content digest. Integrity of a local copy only — not an identity or third-party guarantee (MC-25). */
export async function digestOf(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return `sha256:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ── Content-addressed bytes (CR-10) ───────────────────────────────────────────
// The bytes an observation event names by digest (a browser result's screenshot and
// action trace), kept on this record next to the events instead of in a store of their
// own (SX-48). Keyed by digest, so the same bytes are stored once. A digest resolved
// when it was handed out (putBlob reads the bytes back first); the bytes can later be
// evicted by the bound or deleted by the person, and the digest then resolves to nothing.
export const BLOB_MEDIA_TYPES = ["image/jpeg", "image/png", "application/json"] as const;
export type BlobMediaType = (typeof BLOB_MEDIA_TYPES)[number];
/** Provisional, like DEFAULT_LOCAL_MAX_BYTES (MC-35): one screenshot or trace, decoded. */
export const MAX_BLOB_BYTES = 4 * 1024 * 1024;
/**
 * Provisional bound on all stored browser-result bytes (CR-10), kept apart from
 * DEFAULT_LOCAL_MAX_BYTES: screenshots never count against, or crowd out, the review
 * data MC-35 protects. When a new capture does not fit, the OLDEST captures are removed
 * first, silently. A capture of an earlier artifact version cannot be taken again once the
 * files changed, so eviction does lose what the person could otherwise still look at; the
 * bound keeps a student's disk from filling with screenshots instead. The events that named
 * evicted bytes stay, and the results list then finds no stored screen for them.
 */
export const DEFAULT_BLOB_MAX_BYTES = 64 * 1024 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PSEUDONYM = /^pp-[0-9a-f]{32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BLOB_PREFIX = "blobs/";
/** Age order of stored bytes: `blob-order/<at, zero-padded>-<hex>` → { size }. Listing is enough to find the oldest. */
const BLOB_ORDER_PREFIX = "blob-order/";
const blobKey = (digest: string) => `${BLOB_PREFIX}${digest.slice("sha256:".length)}`;
const blobOrderKey = (at: number, digest: string) => `${BLOB_ORDER_PREFIX}${String(Math.max(0, Math.floor(at))).padStart(15, "0")}-${digest.slice("sha256:".length)}`;
/**
 * Who stored which bytes: `blob-owners/<owner>/<hex>` → { at }. An owner is an opaque id the
 * host derives from the signed-in identity (a digest, never the identity itself), so on a
 * shared PC one person's count and delete never reach what another person stored. Bytes two
 * owners stored are kept until both have deleted them.
 */
const BLOB_OWNER_PREFIX = "blob-owners/";
const OWNER = /^[A-Za-z0-9._-]{1,80}$/;
const blobOwnerKey = (owner: string, hex: string) => `${BLOB_OWNER_PREFIX}${owner}/${hex}`;
const isBlobKey = (key: string) => key.startsWith(BLOB_PREFIX) || key.startsWith(BLOB_ORDER_PREFIX) || key.startsWith(BLOB_OWNER_PREFIX);

interface BlobRecord {
  format: typeof LOCAL_RECORD_FORMAT;
  kind: "blob";
  digest: string;
  media_type: BlobMediaType;
  bytes: number;
  /** When these bytes were first stored (age order for the bound). */
  at?: number;
  /** base64 of exactly the bytes `digest` names. */
  data: string;
}

const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
async function sha256Of(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return `sha256:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ── Exclusions before storage (MC-30) ─────────────────────────────────────────
// Known formats only. This is not anonymisation; Jay still reviews before submitting.
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
];

export interface ExclusionNote {
  kind: string;
  count: number;
}

export function redactText(input: string): { text: string; exclusions: ExclusionNote[] } {
  let out = input;
  const exclusions: ExclusionNote[] = [];
  for (const [kind, pattern] of SECRET_PATTERNS) {
    let count = 0;
    out = out.replace(pattern, () => {
      count++;
      return `[excluded:${kind}]`;
    });
    if (count) exclusions.push({ kind, count });
  }
  return { text: out, exclusions };
}

/** redactText on every string of a JSON value (object keys are left as they are). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value).text as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}

function redactEvent(event: ObservationEvent, excludedPaths: readonly string[]): { event: ObservationEvent; exclusions: ExclusionNote[] } {
  const firstLine = event.text.split("\n", 1)[0] ?? "";
  if (["artifact", "tool_request", "tool_result"].includes(event.kind) && excludedPaths.some((p) => p.length > 0 && firstLine.includes(p))) {
    return { event: { ...event, text: "[excluded:path]" }, exclusions: [{ kind: "excluded_path", count: 1 }] };
  }
  const r = redactText(event.text);
  return { event: { ...event, text: r.text }, exclusions: r.exclusions };
}

// ── Task and purpose (MC-07) ──────────────────────────────────────────────────
export type PurposeSource = "user" | "issue" | "ai_proposed";
export type PurposeState = "undecided" | "ai_proposed" | "provided" | "confirmed";
export type TaskStatus = "open" | "paused" | "completed" | "abandoned";
export type Actor = "user" | "adapter_explicit";

export interface Purpose {
  text: string;
  source: PurposeSource;
  ref?: string;
  at: number;
  /** Known secret formats removed from `text` before storage (MC-30). */
  exclusions?: ExclusionNote[];
}

/**
 * The learning phase of the task flow (SX-55). Deliberately NOT merged with `Task.status`
 * (open/paused/completed/abandoned), which is the work axis: a submitted task can
 * still be paused, and an abandoned one can still have been reflected on (MC-23).
 */
export type CurriculumPhase = "assigned" | "working" | "submitted" | "reflected";
const PHASES: readonly CurriculumPhase[] = ["assigned", "working", "submitted", "reflected"];

/**
 * One Task ↔ one session design file (one week). Extends `hps-local-record/1`'s
 * Task; no new record kind (SX-48).
 *
 * No gate result is stored here. The design is explicit: the gates are computed
 * from the observed events every time, so a stored copy can never drift from them.
 */
export interface TaskCurriculum {
  /** Copied from the profile's lesson so the record says which version it was. */
  module: { course_id: string; version: string; sha256: string };
  week: number;
  phase: CurriculumPhase;
  current_step: string;
  steps: Record<string, { entered_at: number; left_at?: number }>;
  submitted_at?: number;
  /** The previous Task's Improvement id, carried into this week. */
  carry_in?: string;
}

/**
 * Where a session's traffic belongs (CR-21, CR-73; cr-publish #1393). An additive key on the
 * session link (Jay's decision 8): a participant session opened from a published test link
 * carries its project, experiment, product version, link and channel, and the events that
 * cr-evidence adds inherit them from the session. Plain ids only, never identity.
 */
export interface SessionAttribution {
  project: string;
  experiment: string;
  product_version: string;
  /** The test link the session was opened from; absent means "unknown channel" (CR-73). */
  link?: string;
  channel?: string;
  variant?: string;
}

const ATTRIBUTION_KEYS = ["project", "experiment", "product_version", "link", "channel", "variant"] as const;
function checkAttribution(a: unknown): asserts a is SessionAttribution {
  check(isObj(a), "invalid_session_attribution");
  for (const k of Object.keys(a)) check((ATTRIBUTION_KEYS as readonly string[]).includes(k), "invalid_session_attribution");
  for (const k of ["project", "experiment", "product_version"] as const) check(text(a[k], 200), "invalid_session_attribution");
  for (const k of ["link", "channel", "variant"] as const) check(a[k] === undefined || text(a[k], 200), "invalid_session_attribution");
}

export interface Task {
  format: typeof LOCAL_RECORD_FORMAT;
  kind: "task";
  id: string;
  project: string;
  /** Absent on every task created before the curriculum layer, and on any task outside it. */
  curriculum?: TaskCurriculum;
  /** null = undecided. Work is still allowed (MC-07). */
  purpose: Purpose | null;
  purpose_state: PurposeState;
  /** Every purpose ever set, oldest first: an AI proposal stays visible after Jay edits it. */
  purpose_history: Purpose[];
  status: TaskStatus;
  /** `attribution` is absent on every link made before cr-publish (#1393) and on App-side links. */
  sessions: Array<{ host: string; session_id: string; at: number; by: Actor; attribution?: SessionAttribution }>;
  history: Array<{ at: number; by: Actor; change: string; reason?: string }>;
}

const purposeState = (p: Purpose | null): PurposeState =>
  !p ? "undecided" : p.source === "user" ? "confirmed" : p.source === "ai_proposed" ? "ai_proposed" : "provided";

export function createTask(input: { id: string; project: string; at: number; purpose?: { text: string; source: PurposeSource; ref?: string } }): Task {
  check(isObj(input) && ID.test(String(input.id)) && text(input.project, 200) && Number.isFinite(input.at), "invalid_task");
  let purpose: Purpose | null = null;
  if (input.purpose !== undefined) {
    const p = input.purpose;
    check(isObj(p) && text(p.text) && ["user", "issue", "ai_proposed"].includes(String(p.source)), "invalid_purpose");
    const r = redactText(p.text);
    purpose = { text: r.text, source: p.source, ...(p.ref ? { ref: p.ref } : {}), at: input.at, ...(r.exclusions.length ? { exclusions: r.exclusions } : {}) };
  }
  return {
    format: LOCAL_RECORD_FORMAT,
    kind: "task",
    id: input.id,
    project: input.project,
    purpose,
    purpose_state: purposeState(purpose),
    purpose_history: purpose ? [purpose] : [],
    status: "open",
    sessions: [],
    history: [{ at: input.at, by: "user", change: "created" }],
  };
}

/** Only the person confirms or edits a purpose. Whatever was there before is kept in history. */
export function confirmPurpose(task: Task, input: { by: "user"; at: number; text?: string }): Task {
  check(isObj(input) && input.by === "user", "purpose_confirmation_requires_user");
  const next = input.text ?? task.purpose?.text;
  check(text(next), "invalid_purpose");
  const r = redactText(next);
  const purpose: Purpose = { text: r.text, source: "user", at: input.at, ...(r.exclusions.length ? { exclusions: r.exclusions } : {}) };
  const change = task.purpose && r.text !== task.purpose.text ? "purpose_edited" : "purpose_confirmed";
  return { ...task, purpose, purpose_state: "confirmed", purpose_history: [...task.purpose_history, purpose], history: [...task.history, { at: input.at, by: "user", change }] };
}

/**
 * The task-flow state machine (SX-55). Every curriculum change goes through here so it
 * lands in `history` as well, and a phase can only move the way the design's
 * transition table allows.
 *
 * Forward one step at a time: assigned → working → submitted → reflected. A skip
 * (`reflected` without `submitted`) and a move backwards are both refused by name —
 * SX-55's negative is exactly "if reflected happens without submitted, it fails". Staying in
 * the same phase is how a step move is recorded.
 *
 * The work axis is untouched: this never changes `Task.status`.
 */
export function updateCurriculum(
  task: Task,
  patch: Partial<TaskCurriculum>,
  input: { by: Actor; at: number },
): Task {
  check(isObj(patch) && isObj(input) && Number.isFinite(input.at) && ["user", "adapter_explicit"].includes(String(input.by)), "invalid_curriculum");
  const current = task.curriculum;
  const phase = patch.phase ?? current?.phase ?? "assigned";
  check(PHASES.includes(phase), "invalid_phase_transition");
  if (current) {
    const from = PHASES.indexOf(current.phase);
    const to = PHASES.indexOf(phase);
    check(to === from || to === from + 1, "invalid_phase_transition");
  } else {
    check(phase === "assigned" || phase === "working", "invalid_phase_transition");
  }
  const module = patch.module ?? current?.module;
  check(
    isObj(module) && text(module.course_id, 200) && text(module.version, 100) && /^[a-f0-9]{64}$/.test(String(module.sha256)),
    "invalid_curriculum",
  );
  const week = patch.week ?? current?.week;
  check(Number.isSafeInteger(week) && Number(week) >= 1, "invalid_curriculum");
  const step = patch.current_step ?? current?.current_step ?? "";
  check(text(step, 200), "invalid_curriculum");

  const history = [...task.history];
  const steps: TaskCurriculum["steps"] = { ...(current?.steps ?? {}) };
  if (phase !== current?.phase) history.push({ at: input.at, by: input.by, change: `curriculum:phase:${phase}` });
  if (step !== current?.current_step) {
    const leaving = current?.current_step ? steps[current.current_step] : undefined;
    if (current?.current_step && leaving) steps[current.current_step] = { ...leaving, left_at: input.at };
    steps[step] = { entered_at: input.at };
    history.push({ at: input.at, by: input.by, change: `curriculum:step:${step}:entered` });
  }
  const carry_in = patch.carry_in ?? current?.carry_in;
  const submitted_at = phase === "submitted" && current?.phase !== "submitted" ? input.at : current?.submitted_at;
  return {
    ...task,
    curriculum: {
      module: module as TaskCurriculum["module"],
      week: week as number,
      phase,
      current_step: step,
      steps,
      ...(submitted_at !== undefined ? { submitted_at } : {}),
      ...(carry_in ? { carry_in } : {}),
    },
    history,
  };
}

export function setTaskStatus(task: Task, status: TaskStatus, input: { by: Actor; at: number; reason?: string }): Task {
  check(["open", "paused", "completed", "abandoned"].includes(status), "invalid_task_status");
  return { ...task, status, history: [...task.history, { at: input.at, by: input.by, change: `status:${status}`, ...(input.reason ? { reason: input.reason } : {}) }] };
}

// ── Stored records ────────────────────────────────────────────────────────────
interface Assignment {
  task: string | null;
  history: Array<{ from: string | null; to: string | null; by: Actor; reason: string; at: number }>;
}

export interface ObservationRecord {
  format: typeof LOCAL_RECORD_FORMAT;
  kind: "observation";
  key: string;
  host: string;
  scope: string;
  session: string;
  program: string;
  event: ObservationEvent;
  exclusions: ExclusionNote[];
}

interface InterpretationRecord {
  format: typeof LOCAL_RECORD_FORMAT;
  kind: "interpretation";
  task: string;
  interpretation: Interpretation;
}

export type ReviewAction = "confirm" | "correct" | "dispute" | "exclude" | "hold";

export interface Review {
  format: typeof LOCAL_RECORD_FORMAT;
  kind: "review";
  key: string;
  task: string;
  interpretation: { id: string; revision: number };
  capability: string;
  action: ReviewAction;
  by: "user";
  at: number;
  previous: string | null;
  note?: string;
  corrected_claim?: string;
}

/**
 * Instructor confirmation (SX-42). Shaped like `Review`, kept as its own record for the same
 * reason: an observation is append-only, so a teacher's confirmation is a NEW
 * record about an event, never an edit of it. `teacher_state` is therefore not a
 * field on the event — it is computed by reading the newest record for that event.
 *
 * P4 writes these. Until then only the shape, the key layout and the default
 * exist: `teacherState()` answers `unreviewed` because no record exists, which is
 * a different statement from "a teacher looked and had no opinion".
 */
export interface TeacherReview {
  format: typeof LOCAL_RECORD_FORMAT;
  kind: "teacher_review";
  key: string;
  task: string;
  /** The observed event this is about. */
  event: string;
  action: "confirmed" | "disputed";
  by: "teacher";
  at: number;
  previous: string | null;
  note?: string;
}

const teacherReviewPrefix = (task: string, eventId: string) => `reviews/${task}/teacher/${enc(eventId)}/`;

export interface SubmissionPayload {
  format: typeof LOCAL_RECORD_FORMAT;
  kind: "submission_payload";
  id: string;
  revision: number;
  parent: { id: string; revision: number } | null;
  task: { id: string; status: TaskStatus; purpose: Purpose | null; purpose_state: PurposeState };
  reason?: string;
  created_at: number;
  destination: "local-inbox";
  observations: ObservationRecord[];
  interpretations: InterpretationRecord[];
  reviews: Review[];
  excluded: Array<{ ref: string; why: string }>;
}

export interface SubmissionBundle {
  format: typeof LOCAL_RECORD_FORMAT;
  kind: "submission";
  payload: SubmissionPayload;
  digest: string;
}

export interface Receipt {
  format: typeof LOCAL_RECORD_FORMAT;
  kind: "receipt";
  state: "accepted-local";
  id: string;
  revision: number;
  task: string;
  digest: string;
  destination: "local-inbox";
  accepted_at: number;
}

export type ImprovementChoice = "selected" | "skipped" | "edited";
export type FollowUpAttempt = "tried" | "not_tried" | "unknown";

export interface Improvement {
  format: typeof LOCAL_RECORD_FORMAT;
  kind: "improvement";
  id: string;
  task: string;
  text: string;
  choice: ImprovementChoice;
  evidence: string[];
  history: Array<{ choice: ImprovementChoice; text: string; at: number }>;
  follow_ups: Array<{ task: string; attempt: FollowUpAttempt; result: "observed" | "not_tried" | "unconfirmed"; observed?: string; by: Actor; at: number }>;
}

export interface MyRecords {
  tasks: Array<{ id: string; project: string; status: TaskStatus; purpose_state: PurposeState; receipts: Receipt[]; interpretations: number; unreviewed_findings: number }>;
  improvements: Improvement[];
  unassigned_observations: number;
  gaps: Array<{ host: string; scope: string; session: string; missing: number[]; incomplete: boolean }>;
  deleted_tasks: string[];
  /** CR-10 — stored browser-result bytes (screenshots, action traces): shown, not hidden (MC-27). */
  browser_results: { stored: number; bytes: number; max_bytes: number };
}

/** Source-aware identity (MC-08/34): the same scope, session and event id from two hosts are two records. */
const observationBase = (host: string, scope: string, session: string) => `observations/${enc(host)}/${enc(scope)}/${enc(session)}/`;
const assignmentKey = (observationKey: string) => `assignments/${observationKey.slice("observations/".length)}`;
const interpretationKey = (task: string, ref: { id: string; revision: number }) => `interpretations/${task}/${enc(ref.id)}@${ref.revision}`;
const draftKey = (task: string, ref: { id: string; revision: number }) => `drafts/${task}/${enc(ref.id)}@${ref.revision}`;
/** Where participant sessions and their events are recorded (cr-publish, cr-evidence). */
export const PARTICIPANT_HOST = "published";
/** Where the student's manual records of an experiment are recorded: one session per task, its id the task id (cr-evidence). */
export const NOTES_HOST = "notes";
const submissionKey = (ref: { id: string; revision: number }) => `submissions/${enc(ref.id)}@${ref.revision}`;
const receiptKey = (ref: { id: string; revision: number }) => `receipts/${enc(ref.id)}@${ref.revision}`;

export class LocalRecord {
  readonly #store: StoragePort;
  readonly #maxBytes: number;
  readonly #maxBlobBytes: number;

  constructor(store: StoragePort, options: { maxBytes?: number; maxBlobBytes?: number } = {}) {
    this.#store = store;
    this.#maxBytes = options.maxBytes ?? DEFAULT_LOCAL_MAX_BYTES;
    this.#maxBlobBytes = options.maxBlobBytes ?? DEFAULT_BLOB_MAX_BYTES;
  }

  // Every port failure is reported as a named failure, never as success (MC-35).
  async #read<T>(key: string): Promise<T | null> {
    let raw: string | null;
    try {
      raw = await this.#store.read(key);
    } catch {
      throw new Error("storage_failure");
    }
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error("corrupt_record");
    }
  }

  async #keys(prefix: string): Promise<string[]> {
    try {
      return await this.#store.list(prefix);
    } catch {
      throw new Error("storage_failure");
    }
  }

  /** Characters stored under one prefix, through the port's exact count when it has one. */
  async #usageOf(prefix: string): Promise<number> {
    if (this.#store.usageOf) {
      try { return await this.#store.usageOf(prefix); }
      catch { throw new Error("storage_failure"); }
    }
    let bytes = 0;
    for (const key of await this.#keys(prefix)) {
      try {
        bytes += (await this.#store.read(key))?.length ?? 0;
      } catch {
        throw new Error("storage_failure");
      }
    }
    return bytes;
  }

  async #blobUsage(): Promise<number> {
    return (await this.#usageOf(BLOB_PREFIX)) + (await this.#usageOf(BLOB_ORDER_PREFIX)) + (await this.#usageOf(BLOB_OWNER_PREFIX));
  }

  /** The review data's usage against MC-35's limit. Browser-result bytes have their own bound (DEFAULT_BLOB_MAX_BYTES). */
  async usage(): Promise<{ bytes: number; max_bytes: number }> {
    if (this.#store.usageBytes) {
      let total: number;
      try { total = await this.#store.usageBytes(); }
      catch { throw new Error("storage_failure"); }
      return { bytes: total - (await this.#blobUsage()), max_bytes: this.#maxBytes };
    }
    let bytes = 0;
    for (const key of await this.#keys("")) {
      if (isBlobKey(key)) continue;
      try {
        bytes += (await this.#store.read(key))?.length ?? 0;
      } catch {
        throw new Error("storage_failure");
      }
    }
    return { bytes, max_bytes: this.#maxBytes };
  }

  /**
   * false when `ifAbsent` found the key taken. Never evicts review data to make room;
   * browser-result bytes are checked against their own bound (`quota: "blob"`). An owner
   * marker (`quota: "none"`, a few characters) is not checked: refusing it would leave bytes
   * their owner cannot count or delete.
   */
  async #write(key: string, value: unknown, ifAbsent: boolean, quota: "review" | "blob" | "none" = "review"): Promise<boolean> {
    // Last line of MC-30: no known secret format reaches storage, whichever field carries it.
    const raw = canonicalJson(redactDeep(value));
    let existing: string | null;
    try {
      existing = await this.#store.read(key);
    } catch {
      throw new Error("storage_failure");
    }
    // An existing record answers an ifAbsent write before any quota check, so an identical
    // retry stays idempotent when storage is full (MC-25/35). The port write itself stays atomic.
    if (ifAbsent && existing !== null) return false;
    if (quota !== "none") {
      const [bytes, max] = quota === "blob" ? [await this.#blobUsage(), this.#maxBlobBytes] : [(await this.usage()).bytes, this.#maxBytes];
      check(bytes - (existing?.length ?? 0) + raw.length <= max, "capacity_exceeded");
    }
    try {
      await this.#store.write(key, raw, { ifAbsent });
      return true;
    } catch (e) {
      if (e instanceof Error && e.message === "exists") return false;
      throw new Error("storage_failure");
    }
  }

  async #remove(key: string): Promise<void> {
    try {
      await this.#store.remove(key);
    } catch {
      throw new Error("storage_failure");
    }
  }

  /** The keys the named tombstones list (a participant batch reads only its session's and its task's). */
  async #deletedFor(tombstones: readonly string[]): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const k of tombstones) for (const e of (await this.#read<{ evidence: string[] }>(k))?.evidence ?? []) keys.add(e);
    return keys;
  }

  async #deletedEvidence(): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const k of await this.#keys("deleted/")) for (const e of (await this.#read<{ evidence: string[] }>(k))?.evidence ?? []) keys.add(e);
    return keys;
  }

  // ── Tasks and sessions (MC-07/08) ───────────────────────────────────────────
  /**
   * `quota: "none"` is for a caller that bounds its own tasks (cr-publish: one fixed-size task
   * per experiment, experiments capped per project), so creating one costs the same however
   * many session keys the record holds; the default checks the review quota (MC-35).
   */
  async createTask(input: Parameters<typeof createTask>[0], options: { quota?: "review" | "none" } = {}): Promise<Task> {
    const task = createTask(input);
    check(await this.#write(`tasks/${task.id}`, task, true, options.quota ?? "review"), "task_exists");
    return task;
  }

  async getTask(id: string): Promise<Task> {
    check(ID.test(String(id)), "invalid_task");
    const task = await this.#read<Task>(`tasks/${id}`);
    check(task, "unknown_task");
    return task;
  }

  async saveTask(task: Task): Promise<Task> {
    const current = await this.getTask(task.id);
    check(current.project === task.project, "invalid_task");
    await this.#write(`tasks/${task.id}`, task, false);
    return task;
  }

  /** Attribution is explicit. A shared folder or project never merges two tasks (MC-08). */
  async linkSession(taskId: string, link: { host: string; session_id: string; by: Actor; at: number; attribution?: SessionAttribution }): Promise<Task> {
    check(isObj(link) && text(link.host, 100) && text(link.session_id, 200) && ["user", "adapter_explicit"].includes(String(link.by)), "invalid_session_link");
    if (link.attribution !== undefined) {
      checkAttribution(link.attribution);
      // The task is the experiment; a session can only be attributed to the task it links to.
      check(link.attribution.experiment === taskId, "invalid_session_attribution");
    }
    const task = await this.getTask(taskId);
    if (link.attribution) check(task.project === link.attribution.project, "invalid_session_attribution");
    const key = `sessions/${enc(link.host)}/${enc(link.session_id)}`;
    const attribution = link.attribution ? { ...link.attribution } : undefined;
    if (!(await this.#write(key, { task: taskId, ...(attribution ? { attribution } : {}) }, true))) {
      check((await this.#read<{ task: string }>(key))?.task === taskId, "session_linked_to_other_task");
      return task;
    }
    return this.saveTask({
      ...task,
      sessions: [...task.sessions, { host: link.host, session_id: link.session_id, at: link.at, by: link.by, ...(attribution ? { attribution } : {}) }],
      history: [...task.history, { at: link.at, by: link.by, change: `session_linked:${link.host}/${link.session_id}` }],
    });
  }

  /**
   * A session link written as its per-session key only (cr-publish #1393: participant
   * sessions opened from a published test link). Constant cost per call, whatever the record
   * holds: the task document is read once and never rewritten (it would otherwise grow by one
   * entry per open), and the review quota is not scanned, because the caller bounds how many
   * such keys exist (one fixed-size key per session, capped per link). Every read of a
   * session (`taskForSession`, `sessionAttribution`, `sessionLinks`) uses this key.
   * `created` is false when the session was already linked to this task (an idempotent retry).
   */
  async linkSessionKey(taskId: string, link: { host: string; session_id: string; by: Actor; at: number; attribution: SessionAttribution; pseudonym?: string }): Promise<{ created: boolean }> {
    check(isObj(link) && text(link.host, 100) && text(link.session_id, 200) && ["user", "adapter_explicit"].includes(String(link.by)), "invalid_session_link");
    // cr-evidence (CR-65): the participant's random per-experiment pseudonym, an additive key
    // (decision 8). Never derived from identity or device data; the page makes it.
    check(link.pseudonym === undefined || PSEUDONYM.test(String(link.pseudonym)), "invalid_session_link");
    checkAttribution(link.attribution);
    check(link.attribution.experiment === taskId, "invalid_session_attribution");
    const task = await this.getTask(taskId);
    check(task.project === link.attribution.project, "invalid_session_attribution");
    const key = `sessions/${enc(link.host)}/${enc(link.session_id)}`;
    // A session erased by `deleteSession` never comes back through a replayed open (CR-69).
    check(!(await this.sessionDeleted(link.host, link.session_id)), "session_deleted");
    // CR-65: one pseudonym belongs to one experiment, and to the one link it was made under (it
    // ends when that link expires or is revoked). Its index key is written once; a pseudonym
    // already recorded under another task of this record, or under another link, is refused.
    if (link.pseudonym) {
      const pKey = `pseudonyms/${enc(link.host)}/${link.pseudonym}`;
      const owner = link.attribution.link ? { task: taskId, link: link.attribution.link } : { task: taskId };
      if (!(await this.#write(pKey, owner, true, "none"))) {
        const held = await this.#read<{ task: string; link?: string }>(pKey);
        check(held?.task === taskId, "pseudonym_in_other_experiment");
        check(!held?.link || !link.attribution.link || held.link === link.attribution.link, "pseudonym_from_other_link");
      }
    }
    if (await this.#write(key, { task: taskId, attribution: { ...link.attribution }, at: link.at, ...(link.pseudonym ? { pseudonym: link.pseudonym } : {}) }, true, "none")) return { created: true };
    check((await this.#read<{ task: string }>(key))?.task === taskId, "session_linked_to_other_task");
    return { created: false };
  }

  /** Was this session erased (`deleteSession`'s tombstone)? */
  async sessionDeleted(host: string, sessionId: string): Promise<boolean> {
    return (await this.#read(`deleted/sessions/${enc(host)}/${enc(sessionId)}`)) !== null;
  }

  /** The keys every deletion so far removed, read once so a caller resolving many references does not re-read them per reference. */
  async deletedEvidenceKeys(): Promise<Set<string>> {
    return this.#deletedEvidence();
  }

  async taskForSession(host: string, sessionId: string): Promise<string | null> {
    return (await this.#read<{ task: string }>(`sessions/${enc(host)}/${enc(sessionId)}`))?.task ?? null;
  }

  /**
   * A session's attribution, read from its per-session key (written once, atomically), not
   * from `task.sessions`. null when the session is not linked or was linked without one.
   */
  async sessionAttribution(host: string, sessionId: string): Promise<SessionAttribution | null> {
    return (await this.#read<{ attribution?: SessionAttribution }>(`sessions/${enc(host)}/${enc(sessionId)}`))?.attribution ?? null;
  }

  /** Every session linked on one host, from the per-session keys (cr-publish CR-73 channel reads). */
  async sessionLinks(host: string): Promise<Array<{ session_id: string; task: string; attribution: SessionAttribution | null; at?: number; pseudonym?: string }>> {
    check(text(host, 100), "invalid_host");
    const prefix = `sessions/${enc(host)}/`;
    const out: Array<{ session_id: string; task: string; attribution: SessionAttribution | null; at?: number; pseudonym?: string }> = [];
    for (const k of await this.#keys(prefix)) {
      const v = await this.#read<{ task: string; attribution?: SessionAttribution; at?: number; pseudonym?: string }>(k);
      if (!v) continue;
      out.push({
        session_id: decodeURIComponent(k.slice(prefix.length)),
        task: v.task,
        attribution: v.attribution ?? null,
        ...(typeof v.at === "number" ? { at: v.at } : {}),
        ...(typeof v.pseudonym === "string" ? { pseudonym: v.pseudonym } : {}),
      });
    }
    return out;
  }

  /** One session's link record (task, attribution, open time, pseudonym), or null. */
  async sessionLink(host: string, sessionId: string): Promise<{ task: string; attribution: SessionAttribution | null; at?: number; pseudonym?: string } | null> {
    const v = await this.#read<{ task: string; attribution?: SessionAttribution; at?: number; pseudonym?: string }>(`sessions/${enc(host)}/${enc(sessionId)}`);
    return v ? { task: v.task, attribution: v.attribution ?? null, ...(typeof v.at === "number" ? { at: v.at } : {}), ...(typeof v.pseudonym === "string" ? { pseudonym: v.pseudonym } : {}) } : null;
  }

  // ── Observations (MC-08/30/34) ──────────────────────────────────────────────
  async appendObservations(
    host: string,
    value: unknown,
    options: {
      excludedPaths?: readonly string[];
      quota?: "review" | "none";
      gaps?: boolean;
      /**
       * Is an event already stored under the same id the same event? Default: byte-identical
       * canonical JSON. A caller that stamps its own receive time on each event (the participant
       * events route) passes a comparison of what the client sent, so a redelivered batch is a
       * duplicate, not a conflict.
       */
      sameEvent?: (stored: ObservationEvent, incoming: ObservationEvent) => boolean;
      /**
       * A participant session's batch (cr-evidence, CR-69): the session must be linked when the
       * batch is written (`session_deleted` / `session_not_open` otherwise, nothing written),
       * only its own and its task's tombstones are read (not every deletion in the record), and
       * when the session was erased while the batch was being written, what the batch wrote is
       * removed again and `session_deleted` is thrown.
       */
      participant?: boolean;
    } = {},
  ): Promise<{ task: string | null; stored: number; duplicates: number; refused_deleted: number; exclusions: ExclusionNote[]; missing: number[] }> {
    check(text(host, 100), "invalid_host");
    const { batch, missing } = validateObservation(value);
    const task = await this.taskForSession(host, batch.session);
    if (options.participant && task === null) throw new Error((await this.sessionDeleted(host, batch.session)) ? "session_deleted" : "session_not_open");
    const deleted = options.participant ? await this.#deletedFor([`deleted/sessions/${enc(host)}/${enc(batch.session)}`, `deleted/${task}`]) : await this.#deletedEvidence();
    const written: string[] = [];
    const base = observationBase(host, batch.scope, batch.session);
    let stored = 0;
    let duplicates = 0;
    let refusedDeleted = 0;
    const exclusions: ExclusionNote[] = [];
    for (const raw of batch.events) {
      const key = base + enc(raw.id);
      // A retried hook must not bring back evidence Jay deleted.
      if (deleted.has(key)) {
        refusedDeleted++;
        continue;
      }
      const redacted = redactEvent(raw, options.excludedPaths ?? []);
      exclusions.push(...redacted.exclusions);
      const record: ObservationRecord = {
        format: LOCAL_RECORD_FORMAT,
        kind: "observation",
        key,
        host,
        scope: batch.scope,
        session: batch.session,
        program: batch.program,
        event: redacted.event,
        exclusions: redacted.exclusions,
      };
      // `quota: "none"` is for a caller that bounds its own writes (cr-evidence: events per
      // participant session and notes per experiment are capped), so a write costs the same
      // however much the record holds; the default checks the review quota (MC-35).
      if (await this.#write(key, record, true, options.quota ?? "review")) {
        stored++;
        written.push(key);
      } else {
        // Duplicate delivery is fine; different content under the same id is never overwritten.
        const existing = await this.#read<ObservationRecord>(key);
        check(existing && (options.sameEvent ? options.sameEvent(existing.event, record.event) : canonicalJson(existing.event) === canonicalJson(record.event)), "conflicting_event");
        duplicates++;
      }
      const first: Assignment = { task, history: [{ from: null, to: task, by: "adapter_explicit", reason: task ? "session_link" : "no_session_link", at: raw.at }] };
      await this.#write(assignmentKey(key), first, true, options.quota ?? "review");
    }
    // The session was erased (or its task deleted) while this batch was being written: what the
    // batch wrote must not outlive it. `deleteTask` also sweeps the task's scope for anything a
    // race still leaves.
    if (options.participant && (await this.taskForSession(host, batch.session)) !== task) {
      for (const k of written) {
        await this.#remove(k);
        await this.#remove(assignmentKey(k));
      }
      throw new Error("session_deleted");
    }
    // A caller that delivers one session in many small batches (the participant snippet)
    // passes `gaps: false`: each batch's own numbering would report the earlier batches missing.
    if (options.gaps !== false) await this.#write(`gaps/${enc(host)}/${enc(batch.scope)}/${enc(batch.session)}`, { host, scope: batch.scope, session: batch.session, missing, incomplete: batch.incomplete === true }, false);
    return { task, stored, duplicates, refused_deleted: refusedDeleted, exclusions, missing };
  }

  // ── Content-addressed bytes (CR-10) ─────────────────────────────────────────
  /**
   * Store bytes an event names by digest and return that digest. JSON is stored as the
   * canonical JSON of its MC-30-redacted value, so no known secret format reaches storage
   * through it, and its digest equals `digestOf(redactDeep(json))`. Images are stored as
   * given. Storing the same bytes again is a no-op that returns the same digest. When the
   * bytes do not fit DEFAULT_BLOB_MAX_BYTES the oldest stored bytes are removed first; review
   * data is never touched to make room (MC-35). With `owner`, the bytes are also recorded as
   * that owner's (`blobCount`/`deleteBlobs` with the same owner see only those).
   */
  async putBlob(input: { media_type: BlobMediaType; base64?: string; json?: unknown }, options: { at?: number; owner?: string } = {}): Promise<string> {
    check(isObj(input) && (BLOB_MEDIA_TYPES as readonly string[]).includes(String(input.media_type)), "invalid_blob");
    check(options.owner === undefined || (typeof options.owner === "string" && OWNER.test(options.owner)), "invalid_owner");
    let bytes: Uint8Array;
    if (input.media_type === "application/json") {
      check(input.json !== undefined && input.base64 === undefined, "invalid_blob");
      bytes = new TextEncoder().encode(canonicalJson(redactDeep(input.json)));
    } else {
      check(typeof input.base64 === "string" && input.json === undefined && BASE64.test(input.base64), "invalid_blob");
      bytes = fromBase64(input.base64);
    }
    check(bytes.length > 0, "invalid_blob");
    check(bytes.length <= MAX_BLOB_BYTES, "blob_too_large");
    const digest = await sha256Of(bytes);
    let present: string | null;
    try {
      present = await this.#store.read(blobKey(digest));
    } catch {
      throw new Error("storage_failure");
    }
    const at = Number.isFinite(options.at) ? Number(options.at) : Date.now();
    // The owner marker goes before the bytes: a crash between them leaves a marker that
    // names nothing (never counted, cleared by the next delete), never bytes their owner
    // cannot count or delete.
    if (options.owner !== undefined) await this.#write(blobOwnerKey(options.owner, digest.slice("sha256:".length)), { at }, false, "none");
    if (present === null) {
      const record: BlobRecord = { format: LOCAL_RECORD_FORMAT, kind: "blob", digest, media_type: input.media_type, bytes: bytes.length, at, data: toBase64(bytes) };
      const size = canonicalJson(redactDeep(record)).length;
      const marker = { size };
      const need = size + canonicalJson(marker).length;
      check(need <= this.#maxBlobBytes, "capacity_exceeded");
      await this.#evictBlobsFor(need);
      // The age marker goes first: a crash between the two leaves a marker without bytes
      // (removed by the next eviction), never bytes that no bound or delete can find.
      await this.#write(blobOrderKey(at, digest), marker, false, "blob");
      await this.#write(blobKey(digest), record, true, "blob");
    }
    // Read back before handing the digest out: a port that loses or alters the bytes (or
    // a redaction pattern that happened to match inside the base64) must not leave a
    // digest on an event that resolves to nothing.
    check((await this.getBlob(digest)) !== null, "storage_failure");
    return digest;
  }

  /** Remove the oldest stored bytes until `need` more characters fit the bound. */
  async #evictBlobsFor(need: number): Promise<void> {
    let used = await this.#blobUsage();
    if (used + need <= this.#maxBlobBytes) return;
    const owners = await this.#keys(BLOB_OWNER_PREFIX);
    for (const order of await this.#keys(BLOB_ORDER_PREFIX)) {
      if (used + need <= this.#maxBlobBytes) return;
      const key = BLOB_PREFIX + order.slice(-64);
      let sizes: number;
      try {
        sizes = ((await this.#store.read(key))?.length ?? 0) + ((await this.#store.read(order))?.length ?? 0);
      } catch {
        throw new Error("storage_failure");
      }
      await this.#remove(key);
      await this.#remove(order);
      for (const o of owners) if (o.endsWith(`/${order.slice(-64)}`)) await this.#remove(o);
      used -= sizes;
    }
  }

  /**
   * How many stored browser-result bytes there are: all of them, or those `owner` stored.
   * Reads keys only, never a review record, so an unrelated corrupt task or review cannot
   * hide stored screenshots (MC-27).
   */
  async blobCount(options: { owner?: string } = {}): Promise<number> {
    const stored = (await this.#keys(BLOB_PREFIX)).map((k) => k.slice(BLOB_PREFIX.length));
    if (options.owner === undefined) return stored.length;
    check(typeof options.owner === "string" && OWNER.test(options.owner), "invalid_owner");
    const present = new Set(stored);
    return (await this.#keys(`${BLOB_OWNER_PREFIX}${options.owner}/`)).filter((k) => present.has(k.slice(-64))).length;
  }

  /**
   * Delete stored browser-result bytes, all of them or the named digests, at the person's
   * request (the results command's "저장된 화면·동작 기록 지우기" row). The events that named
   * them stay. Each blob goes before its age marker, as in eviction: an interruption leaves
   * a marker without bytes (cleared by the next eviction or delete), never bytes no bound
   * or delete can find.
   *
   * With `owner`, only what that owner stored is deleted, and `removed` counts it: their
   * owner markers go, and the bytes go unless another owner stored the same bytes too.
   */
  async deleteBlobs(input: { by: "user"; at: number; digests?: readonly string[]; owner?: string }): Promise<{ removed: number }> {
    check(isObj(input) && input.by === "user", "delete_requires_user");
    let wanted: Set<string> | null = null;
    if (input.digests !== undefined) {
      check(Array.isArray(input.digests) && input.digests.every((d) => typeof d === "string" && DIGEST.test(d)), "invalid_digest");
      wanted = new Set(input.digests.map((d) => d.slice("sha256:".length)));
    }
    const owners = await this.#keys(BLOB_OWNER_PREFIX);
    if (input.owner !== undefined) {
      check(typeof input.owner === "string" && OWNER.test(input.owner), "invalid_owner");
      const mine = `${BLOB_OWNER_PREFIX}${input.owner}/`;
      const present = new Set((await this.#keys(BLOB_PREFIX)).map((k) => k.slice(BLOB_PREFIX.length)));
      const scope = new Set(owners.filter((k) => k.startsWith(mine)).map((k) => k.slice(-64)).filter((h) => !wanted || wanted.has(h)));
      let removed = 0;
      for (const hex of scope) {
        await this.#remove(blobOwnerKey(input.owner, hex));
        if (present.has(hex)) removed++;
      }
      const others = new Set(owners.filter((k) => !k.startsWith(mine)).map((k) => k.slice(-64)));
      const orphaned = [...scope].filter((h) => !others.has(h));
      if (orphaned.length) await this.#removeBlobs(new Set(orphaned), []);
      return { removed };
    }
    return { removed: await this.#removeBlobs(wanted, owners) };
  }

  /** Remove stored bytes (all, or the named hex digests) with their age and owner markers. */
  async #removeBlobs(wanted: Set<string> | null, owners: readonly string[]): Promise<number> {
    const markers = new Map<string, string[]>();
    for (const order of await this.#keys(BLOB_ORDER_PREFIX)) {
      const hex = order.slice(-64);
      if (wanted && !wanted.has(hex)) continue;
      markers.set(hex, [...(markers.get(hex) ?? []), order]);
    }
    let removed = 0;
    for (const key of await this.#keys(BLOB_PREFIX)) {
      const hex = key.slice(BLOB_PREFIX.length);
      if (wanted && !wanted.has(hex)) continue;
      await this.#remove(key);
      removed++;
      for (const order of markers.get(hex) ?? []) await this.#remove(order);
      markers.delete(hex);
    }
    // Markers whose bytes were already gone (an earlier interruption).
    for (const orders of markers.values()) for (const order of orders) await this.#remove(order);
    for (const o of owners) if (!wanted || wanted.has(o.slice(-64))) await this.#remove(o);
    return removed;
  }

  /** The bytes a digest names, checked against it; null when they are not stored. */
  async getBlob(digest: string): Promise<{ media_type: BlobMediaType; bytes: Uint8Array } | null> {
    check(typeof digest === "string" && DIGEST.test(digest), "invalid_digest");
    const record = await this.#read<BlobRecord>(blobKey(digest));
    if (!record) return null;
    check(record.kind === "blob" && record.digest === digest && typeof record.data === "string" && BASE64.test(record.data), "corrupt_record");
    const bytes = fromBase64(record.data);
    check((await sha256Of(bytes)) === digest, "corrupt_record");
    return { media_type: record.media_type, bytes };
  }

  /** A wrong attribution is corrected by the person, with a reason, keeping the earlier assignment (MC-08). */
  async reassignObservation(key: string, toTask: string | null, input: { by: "user"; reason: string; at: number }): Promise<Assignment> {
    check(isObj(input) && input.by === "user" && text(input.reason, 500), "invalid_reassignment");
    check(key.startsWith("observations/") && (await this.#read(key)), "unknown_observation");
    if (toTask !== null) await this.getTask(toTask);
    const current = await this.#read<Assignment>(assignmentKey(key));
    const next: Assignment = {
      task: toTask,
      history: [...(current?.history ?? []), { from: current?.task ?? null, to: toTask, by: "user", reason: input.reason, at: input.at }],
    };
    await this.#write(assignmentKey(key), next, false);
    return next;
  }

  // ── Interpretations and reviews (MC-15/20/22) ───────────────────────────────
  /** `host` names the source whose stored observations the interpretation cites. */
  async saveInterpretation(taskId: string, value: unknown, batchValue: unknown, host: string): Promise<Interpretation> {
    check(text(host, 100), "invalid_host");
    await this.getTask(taskId);
    const { batch } = validateObservation(batchValue);
    const interpretation = validateInterpretation(value, batch);
    const base = observationBase(host, batch.scope, batch.session);
    const cited = [...interpretation.findings.flatMap((f) => f.evidence), ...interpretation.unclassified.flatMap((u) => u.evidence)].map((r) => base + enc(r.event_id));
    const deleted = await this.#deletedEvidence();
    check(!cited.some((k) => deleted.has(k)), "deleted_evidence");
    const events = new Map(batch.events.map((e) => [base + enc(e.id), e]));
    for (const k of cited) {
      const stored = await this.#read<ObservationRecord>(k);
      check(stored, "unstored_evidence");
      // Quotes are checked against what is actually stored (after exclusions), not an unredacted copy.
      check(canonicalJson(stored.event) === canonicalJson(events.get(k)), "evidence_mismatch");
    }
    if (interpretation.revision > 1) check(await this.#read(interpretationKey(taskId, { id: interpretation.id, revision: interpretation.revision - 1 })), "missing_previous_revision");
    const record: InterpretationRecord = { format: LOCAL_RECORD_FORMAT, kind: "interpretation", task: taskId, interpretation };
    const key = interpretationKey(taskId, interpretation);
    if (!(await this.#write(key, record, true))) check(canonicalJson(await this.#read(key)) === canonicalJson(redactDeep(record)), "revision_exists");
    return interpretation;
  }

  /** A review is a new record about one finding. The interpretation and the observations are never edited. */
  async reviewFinding(
    taskId: string,
    input: { interpretation: { id: string; revision: number }; capability: string; action: ReviewAction; by: "user"; at: number; note?: string; corrected_claim?: string },
  ): Promise<Review> {
    check(isObj(input) && input.by === "user", "review_requires_user");
    check(["confirm", "correct", "dispute", "exclude", "hold"].includes(String(input.action)), "invalid_review");
    if (input.action === "correct") check(text(input.corrected_claim), "invalid_review");
    await this.getTask(taskId);
    const record = await this.#read<InterpretationRecord>(interpretationKey(taskId, input.interpretation));
    check(record, "unknown_interpretation");
    check(record.interpretation.findings.some((f) => f.capability === input.capability), "unknown_finding");
    const prefix = `reviews/${taskId}/${enc(input.interpretation.id)}@${input.interpretation.revision}/${enc(input.capability)}/`;
    const n = (await this.#keys(prefix)).length + 1;
    const review: Review = {
      format: LOCAL_RECORD_FORMAT,
      kind: "review",
      key: prefix + String(n).padStart(6, "0"),
      task: taskId,
      interpretation: { id: input.interpretation.id, revision: input.interpretation.revision },
      capability: input.capability,
      action: input.action,
      by: "user",
      at: input.at,
      previous: n > 1 ? prefix + String(n - 1).padStart(6, "0") : null,
      ...(input.note ? { note: input.note } : {}),
      ...(input.corrected_claim ? { corrected_claim: input.corrected_claim } : {}),
    };
    check(await this.#write(review.key, review, true), "concurrent_review");
    return review;
  }

  // ── Participant evidence (cr-evidence #1394; CR-23–CR-27, CR-69) ─────────────
  /** Every stored observation of one host and scope (an experiment's participant events or notes), oldest key first. */
  async observationsOf(host: string, scope: string): Promise<ObservationRecord[]> {
    check(text(host, 100) && text(scope, 200), "invalid_host");
    const out: ObservationRecord[] = [];
    for (const k of await this.#keys(`observations/${enc(host)}/${enc(scope)}/`)) {
      const r = await this.#read<ObservationRecord>(k);
      if (r) out.push(r);
    }
    return out;
  }

  /** The key a draft source reference names inside this task's record (interpretation.ts `EVIDENCE_REF`). */
  evidenceRefKey(taskId: string, ref: string): string | null {
    const m = /^(session|event|note):(.+)$/.exec(String(ref));
    if (!m) return null;
    if (m[1] === "session") return `sessions/${enc(PARTICIPANT_HOST)}/${enc(m[2]!)}`;
    if (m[1] === "note") return `${observationBase(NOTES_HOST, taskId, taskId)}${enc(m[2]!)}`;
    const slash = m[2]!.indexOf("/");
    if (slash < 1) return null;
    return `${observationBase(PARTICIPANT_HOST, taskId, m[2]!.slice(0, slash))}${enc(m[2]!.slice(slash + 1))}`;
  }

  /**
   * Does a draft source reference resolve to a live record of THIS task (CR-25, CR-27)? A
   * participant session must be linked to this task (`foreign` when it is another
   * experiment's); a record removed by a deletion is `deleted` (CR-69), anything else absent
   * is `missing`. Another project's ids are never in this record at all.
   */
  async resolveEvidenceRef(taskId: string, ref: string, deleted?: Set<string>): Promise<RefResolution> {
    const key = this.evidenceRefKey(taskId, ref);
    if (!key) return "missing";
    if ((deleted ?? (await this.#deletedEvidence())).has(key)) return "deleted";
    if (key.startsWith("sessions/")) {
      const s = await this.#read<{ task: string }>(key);
      return !s ? "missing" : s.task === taskId ? "ok" : "foreign";
    }
    return (await this.#read(key)) ? "ok" : "missing";
  }

  /**
   * Store one revision of an Observed / Interpreted / Assumed / Next draft (CR-25, CR-26). Every
   * reference must resolve to a live record of this task, or nothing is written and every
   * refused item is named. A revision > 1 needs its predecessor; a stored revision is never
   * rewritten (MC-22). `quota: "none"` for a caller that bounds drafts per task.
   * `repeatedUse` is whether the experiment declared repeated-use measurement (CR-72): when it
   * did not, every session has a fresh pseudonym and returns are not measured, so any item
   * carrying a return basis or count is refused (`return_not_measured`), zero included.
   */
  async saveEvidenceDraft(taskId: string, value: unknown, options: { quota?: "review" | "none"; repeatedUse?: boolean } = {}): Promise<{ ok: true; draft: EvidenceDraft } | { ok: false; refusals: DraftRefusal[] }> {
    await this.getTask(taskId);
    const draft = validateEvidenceDraftShape(value);
    check(draft.experiment === taskId, "invalid_evidence_draft");
    const deleted = await this.#deletedEvidence();
    const refusals = await draftRefusals(draft, (ref) => this.resolveEvidenceRef(taskId, ref, deleted));
    // CR-72: a statement counted per device pseudonym is a return count over the sessions it
    // cites; the count, the sessions and their one pseudonym must agree, or it is refused.
    for (const it of draft.items) {
      if ((it.basis !== undefined || it.return_count !== undefined) && options.repeatedUse !== true) {
        if (!refusals.some((r) => r.item === it.id)) refusals.push({ item: it.id, code: "return_not_measured" });
        continue;
      }
      if (it.basis !== "per_device_pseudonym" || refusals.some((r) => r.item === it.id)) continue;
      const pseudonyms = new Map<string, string | null>();
      for (const ref of it.source_refs) {
        const key = ref.startsWith("session:") ? this.evidenceRefKey(taskId, ref) : null;
        if (key) pseudonyms.set(ref, (await this.#read<{ pseudonym?: string }>(key))?.pseudonym ?? null);
      }
      const problem = returnItemProblem(it, (ref) => pseudonyms.get(ref) ?? null);
      if (problem) refusals.push({ item: it.id, code: problem });
    }
    if (refusals.length) return { ok: false, refusals };
    if (draft.revision > 1) check(await this.#read(draftKey(taskId, { id: draft.id, revision: draft.revision - 1 })), "missing_previous_revision");
    const key = draftKey(taskId, draft);
    if (!(await this.#write(key, draft, true, options.quota ?? "review"))) check(canonicalJson(await this.#read(key)) === canonicalJson(redactDeep(draft)), "revision_exists");
    return { ok: true, draft };
  }

  /** Every stored draft revision of a task, by id then revision. */
  async evidenceDrafts(taskId: string): Promise<EvidenceDraft[]> {
    check(ID.test(String(taskId)), "invalid_task");
    const out: EvidenceDraft[] = [];
    for (const k of await this.#keys(`drafts/${taskId}/`)) {
      const d = await this.#read<EvidenceDraft>(k);
      if (d) out.push(d);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
  }

  /**
   * Erase one session (CR-69; recon R6): its session link, every observation recorded in it
   * with their assignments and gap note, every hps-interpretation/1 about it, and every draft
   * (all revisions) that cites it, so no derived item keeps citing deleted records. Like
   * `deleteTask`, it leaves a keys-only tombstone so a retried delivery and a later draft
   * refuse the deleted evidence, and it reports what it removed and what it cannot reach.
   */
  async deleteSession(host: string, sessionId: string, input: { by: "user"; at: number }): Promise<{ task: string; removed: Record<string, number>; not_covered: readonly string[] }> {
    check(isObj(input) && input.by === "user", "delete_requires_user");
    check(text(host, 100) && text(sessionId, 200), "invalid_session_link");
    const sessionKey = `sessions/${enc(host)}/${enc(sessionId)}`;
    const link = await this.#read<{ task: string }>(sessionKey);
    check(link, "unknown_session");
    const taskId = link.task;
    const removed = { observations: 0, interpretations: 0, drafts: 0, sessions: 0 };
    const evidence: string[] = [sessionKey];
    const sessionSeg = enc(sessionId);
    for (const k of await this.#keys(`observations/${enc(host)}/`)) {
      if (k.split("/")[3] !== sessionSeg) continue;
      await this.#remove(k);
      await this.#remove(assignmentKey(k));
      evidence.push(k);
      removed.observations++;
    }
    for (const k of await this.#keys(`gaps/${enc(host)}/`)) if (k.split("/")[3] === sessionSeg) await this.#remove(k);
    for (const k of await this.#keys(`interpretations/${taskId}/`)) {
      if ((await this.#read<InterpretationRecord>(k))?.interpretation.batch.session !== sessionId) continue;
      await this.#remove(k);
      removed.interpretations++;
    }
    const cites = (ref: string) => ref === `session:${sessionId}` || ref.startsWith(`event:${sessionId}/`);
    const doomed = new Set<string>();
    for (const d of await this.evidenceDrafts(taskId)) if (d.items.some((i) => i.source_refs.some(cites))) doomed.add(d.id);
    for (const k of await this.#keys(`drafts/${taskId}/`)) {
      const id = decodeURIComponent(k.slice(`drafts/${taskId}/`.length).replace(/@\d+$/, ""));
      if (!doomed.has(id)) continue;
      await this.#remove(k);
      removed.drafts++;
    }
    // Keys only, no content, under the deleted/ prefix every append and draft check reads.
    await this.#write(`deleted/sessions/${enc(host)}/${sessionSeg}`, { task: taskId, session: sessionId, at: input.at, evidence }, false, "none");
    await this.#remove(sessionKey);
    removed.sessions = 1;
    return { task: taskId, removed, not_covered: DELETE_NOT_COVERED };
  }

  /**
   * Instructor confirmation state (SX-42): the newest teacher record about one observed event, or
   * `unreviewed` when there is none. Computed on read, never stored on the event.
   */
  async teacherState(taskId: string, eventId: string): Promise<TeacherState> {
    check(ID.test(String(taskId)) && text(eventId, 200), "invalid_task");
    const keys = (await this.#keys(teacherReviewPrefix(taskId, eventId))).sort();
    const latest = keys.at(-1);
    if (!latest) return "unreviewed";
    return (await this.#read<TeacherReview>(latest))?.action ?? "unreviewed";
  }

  // ── Submission and local receipt (MC-23/24/25) ──────────────────────────────
  /** One selection validator for building and receiving: ownership, stored content, duplicates, exclusions. */
  async #validatePayload(p: SubmissionPayload): Promise<void> {
    check(Array.isArray(p.observations) && Array.isArray(p.interpretations) && Array.isArray(p.reviews) && Array.isArray(p.excluded), "corrupt_bundle");
    check(p.excluded.every((e) => isObj(e) && text(e.ref, 500) && text(e.why, 500)), "invalid_exclusion");
    const task = await this.getTask(p.task.id);
    const included: string[] = [];
    for (const o of p.observations) {
      check(isObj(o) && typeof o.key === "string", "corrupt_bundle");
      const stored = await this.#read<ObservationRecord>(o.key);
      check(stored && (await this.#read<Assignment>(assignmentKey(o.key)))?.task === task.id, "foreign_item");
      check(canonicalJson(stored) === canonicalJson(o), "payload_mismatch");
      included.push(o.key);
    }
    for (const r of p.interpretations) {
      check(isObj(r) && isObj(r.interpretation), "corrupt_bundle");
      const k = interpretationKey(task.id, r.interpretation);
      const stored = await this.#read<InterpretationRecord>(k);
      check(stored?.task === task.id && r.task === task.id, "foreign_item");
      check(canonicalJson(stored) === canonicalJson(r), "payload_mismatch");
      included.push(k);
    }
    for (const r of p.reviews) {
      check(isObj(r) && typeof r.key === "string", "corrupt_bundle");
      const stored = await this.#read<Review>(r.key);
      check(stored?.task === task.id, "foreign_item");
      check(canonicalJson(stored) === canonicalJson(r), "payload_mismatch");
      included.push(r.key);
    }
    check(new Set(included).size === included.length, "duplicate_item");
    const excluded = new Set(p.excluded.map((e) => e.ref));
    check(!included.some((k) => excluded.has(k)), "excluded_item_included");
  }

  async buildSubmission(selection: {
    id: string;
    revision: number;
    task: string;
    reason?: string;
    at: number;
    observations: string[];
    interpretations: Array<{ id: string; revision: number }>;
    reviews: string[];
    excluded: Array<{ ref: string; why: string }>;
  }): Promise<SubmissionBundle> {
    check(isObj(selection) && ID.test(String(selection.id)) && Number.isSafeInteger(selection.revision) && selection.revision >= 1, "invalid_submission");
    const task = await this.getTask(selection.task);
    check(Array.isArray(selection.excluded) && selection.excluded.every((e) => isObj(e) && text(e.ref, 500) && text(e.why, 500)), "invalid_exclusion");
    const load = async <T>(key: string): Promise<T> => {
      const value = await this.#read<T>(key);
      check(value, "foreign_item");
      return value;
    };
    const observations: ObservationRecord[] = [];
    for (const key of selection.observations) observations.push(await load<ObservationRecord>(key));
    const interpretations: InterpretationRecord[] = [];
    for (const ref of selection.interpretations) interpretations.push(await load<InterpretationRecord>(interpretationKey(task.id, ref)));
    const reviews: Review[] = [];
    for (const key of selection.reviews) reviews.push(await load<Review>(key));
    // Any task state can be submitted, incomplete and abandoned included (MC-23).
    const payload: SubmissionPayload = {
      format: LOCAL_RECORD_FORMAT,
      kind: "submission_payload",
      id: selection.id,
      revision: selection.revision,
      parent: selection.revision > 1 ? { id: selection.id, revision: selection.revision - 1 } : null,
      task: { id: task.id, status: task.status, purpose: task.purpose, purpose_state: task.purpose_state },
      ...(selection.reason ? { reason: redactText(selection.reason).text } : {}),
      created_at: selection.at,
      destination: "local-inbox",
      observations,
      interpretations,
      reviews,
      excluded: selection.excluded.map((e) => ({ ref: e.ref, why: redactText(e.why).text })),
    };
    await this.#validatePayload(payload);
    return { format: LOCAL_RECORD_FORMAT, kind: "submission", payload, digest: await digestOf(payload) };
  }

  /** Accepts a bundle into the local inbox. A receipt exists only after the bundle is stored and read back intact. */
  async submit(bundle: unknown, at: number): Promise<Receipt> {
    check(isObj(bundle) && bundle.format === LOCAL_RECORD_FORMAT && bundle.kind === "submission" && isObj(bundle.payload) && typeof bundle.digest === "string", "corrupt_bundle");
    const payload = bundle.payload as unknown as SubmissionPayload;
    const digest = bundle.digest;
    check(ID.test(String(payload.id)) && Number.isSafeInteger(payload.revision) && payload.revision >= 1 && isObj(payload.task), "corrupt_bundle");
    check((await digestOf(payload)) === digest, "corrupt_bundle");
    check(payload.destination === "local-inbox", "unsupported_destination");
    // An identical retry of an accepted bundle returns its receipt, even if later edits
    // (reassignment, quota) would refuse a new submission (MC-25/35).
    const accepted = await this.#read<Receipt>(receiptKey(payload));
    if (accepted && accepted.digest === digest) return accepted;
    check(canonicalJson(redactDeep(payload)) === canonicalJson(payload), "unredacted_secret");
    // Receiving validation: a caller can recompute the digest, so the selection itself is re-checked.
    await this.#validatePayload(payload);
    if (payload.revision === 1) check(payload.parent === null, "corrupt_bundle");
    else
      check(
        payload.parent?.id === payload.id && payload.parent.revision === payload.revision - 1 && (await this.#read(receiptKey(payload.parent))),
        "missing_parent_receipt",
      );

    const sKey = submissionKey(payload);
    if (!(await this.#write(sKey, { format: LOCAL_RECORD_FORMAT, kind: "submission", payload, digest }, true))) {
      check((await this.#read<{ digest: string }>(sKey))?.digest === digest, "submission_conflict");
    }
    // Read back: a write that did not persist intact (lost, truncated, altered) is a storage failure.
    let back: { payload: unknown; digest: string } | null;
    try {
      back = await this.#read<{ payload: unknown; digest: string }>(sKey);
    } catch {
      throw new Error("storage_failure");
    }
    check(back && back.digest === digest && (await digestOf(back.payload)) === digest, "storage_failure");

    const receipt: Receipt = {
      format: LOCAL_RECORD_FORMAT,
      kind: "receipt",
      state: "accepted-local",
      id: payload.id,
      revision: payload.revision,
      task: payload.task.id,
      digest,
      destination: "local-inbox",
      accepted_at: at,
    };
    if (!(await this.#write(receiptKey(payload), receipt, true))) {
      const existing = await this.#read<Receipt>(receiptKey(payload));
      check(existing && existing.digest === digest, "submission_conflict");
      return existing;
    }
    return receipt;
  }

  /** A file export for Jay. Not an acceptance: no receipt is written (MC-24). */
  async exportTask(taskId: string): Promise<{ state: "exported"; receipt: null; data: Record<string, unknown> }> {
    const task = await this.getTask(taskId);
    const observations = [];
    for (const aKey of await this.#keys("assignments/")) {
      if ((await this.#read<Assignment>(aKey))?.task === taskId) observations.push(await this.#read(`observations/${aKey.slice("assignments/".length)}`));
    }
    const collect = async (prefix: string, keep: (v: Record<string, unknown>) => boolean) => {
      const out = [];
      for (const k of await this.#keys(prefix)) {
        const v = await this.#read<Record<string, unknown>>(k);
        if (v && keep(v)) out.push(v);
      }
      return out;
    };
    return {
      state: "exported",
      receipt: null,
      data: {
        format: LOCAL_RECORD_FORMAT,
        task,
        observations,
        interpretations: await collect(`interpretations/${taskId}/`, () => true),
        reviews: await collect(`reviews/${taskId}/`, () => true),
        receipts: await collect("receipts/", (v) => v.task === taskId),
        improvements: await collect("improvements/", (v) => v.task === taskId),
      },
    };
  }

  /** Deletes what the core manages for one task and says what it cannot reach (MC-31). */
  async deleteTask(taskId: string, input: { by: "user"; at: number }): Promise<{ removed: Record<string, number>; not_covered: readonly string[] }> {
    check(isObj(input) && input.by === "user", "delete_requires_user");
    await this.getTask(taskId);
    const removed = { observations: 0, interpretations: 0, reviews: 0, submissions: 0, receipts: 0, improvements: 0, sessions: 0, browser_result_bytes: 0, drafts: 0 };
    const evidence: string[] = [];
    // CR-10 — the stored bytes this task's observations name go with them.
    const named = new Set<string>();
    const namesOf = (o: ObservationRecord | null): string[] =>
      (["screenshot_digest", "trace_digest"] as const)
        .map((k) => (o?.event as Record<string, unknown> | undefined)?.[k])
        .filter((d): d is string => typeof d === "string" && DIGEST.test(d));
    for (const aKey of await this.#keys("assignments/")) {
      if ((await this.#read<Assignment>(aKey))?.task !== taskId) continue;
      const oKey = `observations/${aKey.slice("assignments/".length)}`;
      for (const d of namesOf(await this.#read<ObservationRecord>(oKey))) named.add(d);
      await this.#remove(oKey);
      await this.#remove(aKey);
      evidence.push(oKey);
      removed.observations++;
    }
    // cr-evidence (CR-69): every observation scoped to the task (participant events and manual
    // records name their experiment as scope) goes too, whatever its assignment says, so an
    // event a race stored with no task cannot outlive the experiment's deletion.
    for (const k of await this.#keys("observations/")) {
      if (k.split("/")[2] !== enc(taskId)) continue;
      for (const d of namesOf(await this.#read<ObservationRecord>(k))) named.add(d);
      await this.#remove(k);
      await this.#remove(assignmentKey(k));
      evidence.push(k);
      removed.observations++;
    }
    for (const k of await this.#keys(`interpretations/${taskId}/`)) {
      await this.#remove(k);
      removed.interpretations++;
    }
    for (const k of await this.#keys(`reviews/${taskId}/`)) {
      await this.#remove(k);
      removed.reviews++;
    }
    // cr-evidence (CR-69): the task's evidence drafts are derived from its records and go with them.
    for (const k of await this.#keys(`drafts/${taskId}/`)) {
      await this.#remove(k);
      removed.drafts++;
    }
    for (const k of await this.#keys("submissions/")) {
      if ((await this.#read<{ payload: { task: { id: string } } }>(k))?.payload.task.id !== taskId) continue;
      await this.#remove(k);
      removed.submissions++;
      const r = `receipts/${k.slice("submissions/".length)}`;
      if (await this.#read(r)) {
        await this.#remove(r);
        removed.receipts++;
      }
    }
    for (const k of await this.#keys("improvements/")) {
      if ((await this.#read<Improvement>(k))?.task !== taskId) continue;
      await this.#remove(k);
      removed.improvements++;
    }
    for (const k of await this.#keys("sessions/")) {
      if ((await this.#read<{ task: string }>(k))?.task !== taskId) continue;
      await this.#remove(k);
      removed.sessions++;
    }
    // cr-evidence (CR-65): the task's pseudonym index keys go with its sessions.
    for (const k of await this.#keys("pseudonyms/")) if ((await this.#read<{ task: string }>(k))?.task === taskId) await this.#remove(k);
    if (named.size) {
      // Bytes another remaining observation still names stay (content-addressed, shared).
      for (const k of await this.#keys("observations/")) for (const d of namesOf(await this.#read<ObservationRecord>(k))) named.delete(d);
      removed.browser_result_bytes = (await this.deleteBlobs({ by: "user", at: input.at, digests: [...named] })).removed;
    }
    // Keys only, no content: lets later collection and reinterpretation refuse the deleted evidence.
    await this.#write(`deleted/${taskId}`, { task: taskId, at: input.at, evidence }, false);
    await this.#remove(`tasks/${taskId}`);
    return { removed, not_covered: DELETE_NOT_COVERED };
  }

  // ── Improvement follow-up (MC-26) ───────────────────────────────────────────
  async chooseImprovement(taskId: string, input: { id: string; text: string; choice: ImprovementChoice; evidence: string[]; by: "user"; at: number }): Promise<Improvement> {
    check(isObj(input) && input.by === "user", "improvement_requires_user");
    check(ID.test(String(input.id)) && text(input.text, 500) && ["selected", "skipped", "edited"].includes(String(input.choice)), "invalid_improvement");
    await this.getTask(taskId);
    for (const k of input.evidence) check(k.startsWith("observations/") && (await this.#read(k)), "unknown_evidence");
    const key = `improvements/${input.id}`;
    const existing = await this.#read<Improvement>(key);
    if (existing) check(existing.task === taskId, "foreign_item");
    const entry = { choice: input.choice, text: input.text, at: input.at };
    const improvement: Improvement = existing
      ? { ...existing, text: input.text, choice: input.choice, evidence: input.evidence, history: [...existing.history, entry] }
      : { format: LOCAL_RECORD_FORMAT, kind: "improvement", id: input.id, task: taskId, text: input.text, choice: input.choice, evidence: input.evidence, history: [entry], follow_ups: [] };
    await this.#write(key, improvement, false);
    return improvement;
  }

  /** Records whether the next task tried it. "Tried" without an observed result stays unconfirmed. */
  async recordFollowUp(improvementId: string, input: { task: string; attempt: FollowUpAttempt; observed?: string; by: Actor; at: number }): Promise<Improvement> {
    check(isObj(input) && ["tried", "not_tried", "unknown"].includes(String(input.attempt)) && ["user", "adapter_explicit"].includes(String(input.by)), "invalid_follow_up");
    const improvement = await this.#read<Improvement>(`improvements/${improvementId}`);
    check(improvement, "unknown_improvement");
    check(improvement.choice !== "skipped", "improvement_skipped");
    check(input.task !== improvement.task, "same_task_follow_up");
    await this.getTask(input.task);
    const result = input.attempt === "not_tried" ? "not_tried" : input.attempt === "tried" && text(input.observed) ? "observed" : "unconfirmed";
    const next: Improvement = {
      ...improvement,
      follow_ups: [...improvement.follow_ups, { task: input.task, attempt: input.attempt, result, ...(text(input.observed) ? { observed: input.observed } : {}), by: input.by, at: input.at }],
    };
    await this.#write(`improvements/${improvementId}`, next, false);
    return next;
  }

  // ── My records (MC-27) ──────────────────────────────────────────────────────
  /** Everything, failed and abandoned included, with known gaps. Nothing is filtered to look good. */
  async records(): Promise<MyRecords> {
    const receipts: Receipt[] = [];
    for (const k of await this.#keys("receipts/")) {
      const r = await this.#read<Receipt>(k);
      if (r) receipts.push(r);
    }
    const tasks: MyRecords["tasks"] = [];
    for (const k of await this.#keys("tasks/")) {
      const task = await this.#read<Task>(k);
      if (!task) continue;
      let interpretations = 0;
      let unreviewed = 0;
      for (const ik of await this.#keys(`interpretations/${task.id}/`)) {
        const rec = await this.#read<InterpretationRecord>(ik);
        if (!rec) continue;
        interpretations++;
        const i = rec.interpretation;
        for (const f of i.findings) {
          const reviewed = (await this.#keys(`reviews/${task.id}/${enc(i.id)}@${i.revision}/${enc(f.capability)}/`)).length > 0;
          if (f.review === "unreviewed" && !reviewed) unreviewed++;
        }
      }
      tasks.push({
        id: task.id,
        project: task.project,
        status: task.status,
        purpose_state: task.purpose_state,
        receipts: receipts.filter((r) => r.task === task.id).sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision),
        interpretations,
        unreviewed_findings: unreviewed,
      });
    }
    const improvements: Improvement[] = [];
    for (const k of await this.#keys("improvements/")) {
      const imp = await this.#read<Improvement>(k);
      if (imp) improvements.push(imp);
    }
    let unassigned = 0;
    for (const k of await this.#keys("assignments/")) if ((await this.#read<Assignment>(k))?.task === null) unassigned++;
    const gaps: MyRecords["gaps"] = [];
    for (const k of await this.#keys("gaps/")) {
      const g = await this.#read<MyRecords["gaps"][number]>(k);
      if (g && (g.missing.length > 0 || g.incomplete)) gaps.push(g);
    }
    // Session tombstones (deleteSession) are not deleted tasks.
    const deleted = (await this.#keys("deleted/")).filter((k) => !k.startsWith("deleted/sessions/")).map((k) => k.slice("deleted/".length));
    const browser_results = { stored: await this.blobCount(), bytes: await this.#blobUsage(), max_bytes: this.#maxBlobBytes };
    return { tasks, improvements, unassigned_observations: unassigned, gaps, deleted_tasks: deleted, browser_results };
  }
}

/**
 * Independent check of a local receipt against what is actually stored (MC-25). Uses only
 * the port and the digest function, not LocalRecord, so a bug in `submit` cannot vouch for itself.
 */
export async function verifyReceipt(store: StoragePort, receipt: unknown): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!isObj(receipt) || receipt.kind !== "receipt" || receipt.state !== "accepted-local" || typeof receipt.id !== "string" || !Number.isSafeInteger(receipt.revision)) {
    return { ok: false, code: "invalid_receipt" };
  }
  const ref = { id: receipt.id, revision: Number(receipt.revision) };
  let rawSubmission: string | null;
  let rawReceipt: string | null;
  try {
    rawSubmission = await store.read(submissionKey(ref));
    rawReceipt = await store.read(receiptKey(ref));
  } catch {
    return { ok: false, code: "storage_failure" };
  }
  if (rawSubmission === null) return { ok: false, code: "missing_submission" };
  let stored: unknown;
  let issued: unknown;
  try {
    stored = JSON.parse(rawSubmission);
    issued = rawReceipt === null ? null : JSON.parse(rawReceipt);
  } catch {
    return { ok: false, code: "corrupt_submission" };
  }
  if (!isObj(stored) || (await digestOf(stored.payload)) !== receipt.digest || stored.digest !== receipt.digest) return { ok: false, code: "digest_mismatch" };
  if (issued === null || canonicalJson(issued) !== canonicalJson(receipt)) return { ok: false, code: "receipt_not_issued" };
  return { ok: true };
}
