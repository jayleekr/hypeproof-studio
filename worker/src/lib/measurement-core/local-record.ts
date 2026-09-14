// hps-local-record/1 — Jay's local work record (#1020 unit 2; MC-07/08, MC-22–27, MC-30/31, MC-35).
//
// Host-independent: everything persistent goes through an injected StoragePort, so the
// same logic can run in Studio, a local CLI or a test. The core never picks a location,
// never reaches the network and never evicts data to make room. A port's `write` must
// resolve only after the value is durable; `submit` still reads every submission back
// before it issues a receipt, so a port that loses or truncates data cannot fake one.
import { validateObservation, type ObservationEvent } from "./legacy-observation.ts";
import { validateInterpretation, type Interpretation } from "./interpretation.ts";

export const LOCAL_RECORD_FORMAT = "hps-local-record/1";
/** Provisional local capacity (MC-35). Exposed, never enforced by deleting data; fixed with host evidence later. */
export const DEFAULT_LOCAL_MAX_BYTES = 256 * 1024 * 1024;
/** What task deletion cannot reach, reported instead of claimed (MC-31). */
export const DELETE_NOT_COVERED = ["host_original_records", "copies_exported_by_the_user"] as const;

export interface StoragePort {
  /** Optional exact character usage; must include durable writes and never cache receipt reads. */
  usageBytes?(): Promise<number>;
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

export interface Task {
  format: typeof LOCAL_RECORD_FORMAT;
  kind: "task";
  id: string;
  project: string;
  /** null = undecided. Work is still allowed (MC-07). */
  purpose: Purpose | null;
  purpose_state: PurposeState;
  /** Every purpose ever set, oldest first: an AI proposal stays visible after Jay edits it. */
  purpose_history: Purpose[];
  status: TaskStatus;
  sessions: Array<{ host: string; session_id: string; at: number; by: Actor }>;
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

export function setTaskStatus(task: Task, status: TaskStatus, input: { by: Actor; at: number; reason?: string }): Task {
  check(["open", "paused", "completed", "abandoned"].includes(status), "invalid_task_status");
  return { ...task, status, history: [...task.history, { at: input.at, by: input.by, change: `status:${status}`, ...(input.reason ? { reason: input.reason } : {}) }] };
}

// ── Stored records ────────────────────────────────────────────────────────────
interface Assignment {
  task: string | null;
  history: Array<{ from: string | null; to: string | null; by: Actor; reason: string; at: number }>;
}

interface ObservationRecord {
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
}

/** Source-aware identity (MC-08/34): the same scope, session and event id from two hosts are two records. */
const observationBase = (host: string, scope: string, session: string) => `observations/${enc(host)}/${enc(scope)}/${enc(session)}/`;
const assignmentKey = (observationKey: string) => `assignments/${observationKey.slice("observations/".length)}`;
const interpretationKey = (task: string, ref: { id: string; revision: number }) => `interpretations/${task}/${enc(ref.id)}@${ref.revision}`;
const submissionKey = (ref: { id: string; revision: number }) => `submissions/${enc(ref.id)}@${ref.revision}`;
const receiptKey = (ref: { id: string; revision: number }) => `receipts/${enc(ref.id)}@${ref.revision}`;

export class LocalRecord {
  readonly #store: StoragePort;
  readonly #maxBytes: number;

  constructor(store: StoragePort, options: { maxBytes?: number } = {}) {
    this.#store = store;
    this.#maxBytes = options.maxBytes ?? DEFAULT_LOCAL_MAX_BYTES;
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

  async usage(): Promise<{ bytes: number; max_bytes: number }> {
    if (this.#store.usageBytes) {
      try { return { bytes: await this.#store.usageBytes(), max_bytes: this.#maxBytes }; }
      catch { throw new Error("storage_failure"); }
    }
    let bytes = 0;
    for (const key of await this.#keys("")) {
      try {
        bytes += (await this.#store.read(key))?.length ?? 0;
      } catch {
        throw new Error("storage_failure");
      }
    }
    return { bytes, max_bytes: this.#maxBytes };
  }

  /** false when `ifAbsent` found the key taken. Never evicts anything to make room. */
  async #write(key: string, value: unknown, ifAbsent: boolean): Promise<boolean> {
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
    const { bytes } = await this.usage();
    check(bytes - (existing?.length ?? 0) + raw.length <= this.#maxBytes, "capacity_exceeded");
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

  async #deletedEvidence(): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const k of await this.#keys("deleted/")) for (const e of (await this.#read<{ evidence: string[] }>(k))?.evidence ?? []) keys.add(e);
    return keys;
  }

  // ── Tasks and sessions (MC-07/08) ───────────────────────────────────────────
  async createTask(input: Parameters<typeof createTask>[0]): Promise<Task> {
    const task = createTask(input);
    check(await this.#write(`tasks/${task.id}`, task, true), "task_exists");
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
  async linkSession(taskId: string, link: { host: string; session_id: string; by: Actor; at: number }): Promise<Task> {
    check(isObj(link) && text(link.host, 100) && text(link.session_id, 200) && ["user", "adapter_explicit"].includes(String(link.by)), "invalid_session_link");
    const task = await this.getTask(taskId);
    const key = `sessions/${enc(link.host)}/${enc(link.session_id)}`;
    if (!(await this.#write(key, { task: taskId }, true))) {
      check((await this.#read<{ task: string }>(key))?.task === taskId, "session_linked_to_other_task");
      return task;
    }
    return this.saveTask({
      ...task,
      sessions: [...task.sessions, { host: link.host, session_id: link.session_id, at: link.at, by: link.by }],
      history: [...task.history, { at: link.at, by: link.by, change: `session_linked:${link.host}/${link.session_id}` }],
    });
  }

  async taskForSession(host: string, sessionId: string): Promise<string | null> {
    return (await this.#read<{ task: string }>(`sessions/${enc(host)}/${enc(sessionId)}`))?.task ?? null;
  }

  // ── Observations (MC-08/30/34) ──────────────────────────────────────────────
  async appendObservations(
    host: string,
    value: unknown,
    options: { excludedPaths?: readonly string[] } = {},
  ): Promise<{ task: string | null; stored: number; duplicates: number; refused_deleted: number; exclusions: ExclusionNote[]; missing: number[] }> {
    check(text(host, 100), "invalid_host");
    const { batch, missing } = validateObservation(value);
    const task = await this.taskForSession(host, batch.session);
    const deleted = await this.#deletedEvidence();
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
      if (await this.#write(key, record, true)) stored++;
      else {
        // Duplicate delivery is fine; different content under the same id is never overwritten.
        const existing = await this.#read<ObservationRecord>(key);
        check(existing && canonicalJson(existing.event) === canonicalJson(record.event), "conflicting_event");
        duplicates++;
      }
      const first: Assignment = { task, history: [{ from: null, to: task, by: "adapter_explicit", reason: task ? "session_link" : "no_session_link", at: raw.at }] };
      await this.#write(assignmentKey(key), first, true);
    }
    await this.#write(`gaps/${enc(host)}/${enc(batch.scope)}/${enc(batch.session)}`, { host, scope: batch.scope, session: batch.session, missing, incomplete: batch.incomplete === true }, false);
    return { task, stored, duplicates, refused_deleted: refusedDeleted, exclusions, missing };
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
    const removed = { observations: 0, interpretations: 0, reviews: 0, submissions: 0, receipts: 0, improvements: 0, sessions: 0 };
    const evidence: string[] = [];
    for (const aKey of await this.#keys("assignments/")) {
      if ((await this.#read<Assignment>(aKey))?.task !== taskId) continue;
      const oKey = `observations/${aKey.slice("assignments/".length)}`;
      await this.#remove(oKey);
      await this.#remove(aKey);
      evidence.push(oKey);
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
    const deleted = (await this.#keys("deleted/")).map((k) => k.slice("deleted/".length));
    return { tasks, improvements, unassigned_observations: unassigned, gaps, deleted_tasks: deleted };
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
