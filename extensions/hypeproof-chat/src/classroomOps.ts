// Remote classroom operations (#751) — client half of the observation contract.
//
// Rules this file obeys (same discipline as heartbeat.ts / sessionSpool.ts):
//   - **No `vscode` import.** Storage, clock, fetch and timers are injected, so
//     test/*.smoke.mjs drives it under plain Node and
//     worker/test/classroom-ops.test.mjs feeds these builders straight into the
//     Service validator (drift lock — the two sides ship on different trains).
//   - **Metadata only.** Every payload field is an enum or a bounded id. There
//     is no field a prompt, a file name, a stack trace or a token could ride in.
//   - **An HTTP 2xx is an ack of storage, nothing more.** Events leave the
//     outbox only when the Service's contiguous cursor has passed them.
//   - The learning path never waits on this: every call is fire-and-forget with
//     a bounded queue, a 4 s timeout and single-flight.

export const OPS_SCHEMA_VERSION = 1;
export const OPS_PROTOCOL = 1;
/** Base capability. The host appends "commands" plus each action it registered an executor for. */
export const OPS_CLIENT_CAPABILITIES = ["observe"] as const;
export const SYNC_TIMEOUT_MS = 4000;
export const BACKOFF_STEPS_MS = [5000, 10000, 20000, 60000] as const;
export const MAX_BATCH_EVENTS = 100;
export const MAX_BATCH_BYTES = 60 * 1024;
/** Beyond this the outbox stops accepting and says so; it never silently drops the oldest evidence. */
export const OUTBOX_CAP = 2000;

export type OpsErrorClass =
  | "auth_expired" | "auth_signature" | "auth_revoked" | "auth_rejected" | "class_not_open" | "profile_mismatch"
  | "roster_missing" | "budget_limit" | "provider_rate_limit" | "provider_5xx" | "network" | "sdk_not_ready"
  | "tool_not_ready" | "review_error" | "upload_failed" | "unknown";
export type OpsEventKind = "activation" | "step" | "runtime" | "error" | "upload" | "evidence";
/** Who acted. Kept per event so a learner's own decision is never merged with what the AI or an instructor did. */
export type OpsActor = "student" | "ai" | "teacher" | "external_user" | "tool" | "system" | "unknown";
export type SourceState = "real" | "simulated" | "self_reported" | "unverified";
export type EvidenceType = "intent" | "criterion" | "action" | "decision" | "change" | "ownership";
export type RuntimeStatus = "idle" | "running" | "waiting_approval" | "waiting_user" | "error";

export interface OpsEvent {
  event_id: string;
  seq: number;
  observed_at: number;
  kind: OpsEventKind;
  actor: OpsActor;
  payload: Record<string, unknown>;
}

/** Drift lock — mirrored by worker/src/lib/classroom-ops.ts validatePayload. */
export const CLIENT_OPS_PAYLOAD_KEYS = {
  activation: ["stage", "reason", "token_jti", "token_exp", "http_status"],
  step: ["lesson_version", "step_id", "status"],
  runtime: ["status"],
  error: ["class", "code", "request_id", "blocking", "cleared"],
  upload: ["status", "snapshot_revision"],
  evidence: ["evidence_type", "source_state", "step_id", "artifact_before", "artifact_after"],
} as const;

const SAFE_CODE = /^[a-z0-9_.-]{1,64}$/;
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Name what was observed; never upgrade a bare status into a cause.
 * A 401 without the Service's own `code` stays `auth_rejected` — the 2026-07-28
 * incident was two days lost to a banner that called every 401 "expired".
 */
export function classifyFailure(o: { status?: number; code?: string; networkError?: boolean; provider?: boolean }): OpsErrorClass {
  if (o.networkError || o.status === 0) return "network";
  const code = (o.code ?? "").toLowerCase();
  if (o.status === 401) {
    if (code === "expired") return "auth_expired";
    if (code === "signature" || code === "malformed") return "auth_signature";
    if (code === "revoked") return "auth_revoked";
    return "auth_rejected";
  }
  if (o.status === 403) {
    if (code === "session_inactive" || code === "session_closed" || code === "no_active_session") return "class_not_open";
    if (code === "not_in_roster") return "roster_missing";
    if (code === "profile_mismatch" || code === "cohort_mismatch") return "profile_mismatch";
    if (code.startsWith("budget")) return "budget_limit";
    return "unknown";
  }
  if (o.status === 402 || code.startsWith("budget")) return "budget_limit";
  if (o.status === 429) return "provider_rate_limit";
  if (o.status !== undefined && o.status >= 500) return "provider_5xx";
  return "unknown";
}

const safeCode = (s: string | undefined) => (s && SAFE_CODE.test(s) ? s : undefined);
const safeId = (s: string | undefined) => (s && SAFE_ID.test(s) ? s : undefined);

export const activationPayload = (stage: "token_verified" | "token_rejected" | "class_entered" | "runtime_ready" | "runtime_failed", o: { reason?: OpsErrorClass; tokenJti?: string; tokenExp?: number; httpStatus?: number } = {}) => ({
  stage,
  ...(o.reason ? { reason: o.reason } : {}),
  ...(safeId(o.tokenJti) ? { token_jti: o.tokenJti } : {}),
  ...(Number.isSafeInteger(o.tokenExp) ? { token_exp: o.tokenExp } : {}),
  ...(Number.isInteger(o.httpStatus) ? { http_status: o.httpStatus } : {}),
});
/** A step is reported only from an explicit lesson-step transition — never inferred from chat volume or an AI "done". */
export const stepPayload = (lessonVersion: string, status: "not_started" | "in_progress" | "submitted" | "reviewed" | "free_activity", stepId?: string) =>
  status === "free_activity" ? { lesson_version: lessonVersion, status } : { lesson_version: lessonVersion, step_id: stepId, status };
export const runtimePayload = (status: RuntimeStatus) => ({ status });
export const errorPayload = (cls: OpsErrorClass, o: { code?: string; requestId?: string; blocking: boolean; cleared?: boolean }) => ({
  class: cls,
  ...(safeCode(o.code) ? { code: o.code } : {}),
  ...(safeId(o.requestId) ? { request_id: o.requestId } : {}),
  blocking: o.blocking,
  ...(o.cleared ? { cleared: true } : {}),
});
export const uploadPayload = (status: "pending" | "uploaded" | "failed" | "verified", snapshotRevision?: number) => ({
  status,
  ...(Number.isInteger(snapshotRevision) ? { snapshot_revision: snapshotRevision } : {}),
});

/**
 * Provenance of something the learner (or the AI, or an outside user) did. Digests only:
 * the learner's own words stay in the local spool and the existing consented share.
 * An unstated source is sent as `unverified` — a simulation is never reported as real.
 */
export const evidencePayload = (type: EvidenceType, o: { sourceState?: SourceState; stepId?: string; before?: string; after?: string } = {}) => ({
  evidence_type: type,
  source_state: o.sourceState ?? "unverified",
  ...(o.stepId && /^[A-Za-z0-9_-]{1,128}$/.test(o.stepId) ? { step_id: o.stepId } : {}),
  ...(o.before && /^[a-f0-9]{64}$/.test(o.before) ? { artifact_before: o.before } : {}),
  ...(o.after && /^[a-f0-9]{64}$/.test(o.after) ? { artifact_after: o.after } : {}),
});

/** jti/exp are not secrets; the token itself never enters this module. */
export function tokenIdentityUnverified(token: string): { jti?: string; exp?: number; u?: string; c?: string } {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"));
    return { ...(typeof p.jti === "string" ? { jti: p.jti } : {}), ...(typeof p.exp === "number" ? { exp: p.exp } : {}), ...(typeof p.u === "string" ? { u: p.u } : {}), ...(typeof p.c === "string" ? { c: p.c } : {}) };
  } catch {
    return {};
  }
}

// ── durable outbox ──────────────────────────────────────────────────────────

export interface OutboxState {
  /** Bound to one connection: a new grant or boot never resends another seat's events. */
  grant_id: string;
  boot_id: string;
  next_seq: number;
  events: OpsEvent[];
  /** Set when the cap refused events: the gap is reported, not hidden. */
  refused: number;
}
export interface OutboxStore {
  load(): Promise<OutboxState | null>;
  save(s: OutboxState): Promise<void>;
}

export class OpsOutbox {
  private state: OutboxState;
  private store: OutboxStore;
  private now: () => number;
  private uuid: () => string;
  // Explicit fields: the smoke tests load this file with Node's type stripping, which has no parameter properties.
  private constructor(store: OutboxStore, state: OutboxState, now: () => number, uuid: () => string) { this.store = store; this.state = state; this.now = now; this.uuid = uuid; }

  /**
   * `boot_id` names this outbox stream, and the stream survives a restart: unacked
   * events keep their seqs and the counter continues, so a crash never opens a hole
   * or reuses a seq. A different grant (new pairing, another seat) starts a new stream.
   */
  static async open(store: OutboxStore, grantId: string, newStreamId: string, now: () => number, uuid: () => string): Promise<OpsOutbox> {
    const prior = await store.load().catch(() => null);
    const valid = prior && prior.grant_id === grantId && typeof prior.boot_id === "string" && Number.isSafeInteger(prior.next_seq) && Array.isArray(prior.events);
    const state = valid ? prior! : { grant_id: grantId, boot_id: newStreamId, next_seq: 1, events: [], refused: 0 };
    if (!valid) await store.save(state);
    return new OpsOutbox(store, state, now, uuid);
  }

  get pending(): number { return this.state.events.length; }
  get refused(): number { return this.state.refused; }
  get bootId(): string { return this.state.boot_id; }

  /** Persisted before it is ever sent. Returns false when the cap refused it. */
  async add(kind: OpsEventKind, payload: Record<string, unknown>, actor: OpsActor = "system"): Promise<boolean> {
    if (this.state.events.length >= OUTBOX_CAP) { this.state.refused++; await this.store.save(this.state); return false; }
    this.state.events.push({ event_id: this.uuid(), seq: this.state.next_seq++, observed_at: this.now(), kind, actor, payload });
    await this.store.save(this.state);
    return true;
  }

  /** Oldest first, bounded by count and by serialized size. */
  batch(): OpsEvent[] {
    const out: OpsEvent[] = []; let bytes = 0;
    for (const e of this.state.events) {
      const size = JSON.stringify(e).length + 1;
      if (out.length >= MAX_BATCH_EVENTS || bytes + size > MAX_BATCH_BYTES) break;
      out.push(e); bytes += size;
    }
    return out;
  }

  /** Only the contiguous cursor deletes. A 2xx without it deletes nothing. */
  async acked(bootId: string, contiguousSeq: number): Promise<number> {
    if (bootId !== this.state.boot_id || !Number.isSafeInteger(contiguousSeq)) return 0;
    const before = this.state.events.length;
    this.state.events = this.state.events.filter((e) => e.seq > contiguousSeq);
    if (this.state.events.length !== before) await this.store.save(this.state);
    return before - this.state.events.length;
  }
}

// ── sync loop ───────────────────────────────────────────────────────────────

export interface SyncResponse {
  status: number;
  /** Parsed JSON body when there was one. */
  body?: { reason?: string; poll_after_ms?: number; connection_epoch?: number; ack?: { boot_id: string; contiguous_seq: number; missing: Array<[number, number]> }; commands?: unknown[]; receipt_acks?: unknown[]; control?: { paused: boolean; control_revision: number } };
  retryAfterSec?: number;
}
export interface SyncDeps {
  /** POST /v1/classroom/ops/sync. Must not throw: status 0 for anything that never reached the Service. */
  post(body: unknown, timeoutMs: number): Promise<SyncResponse>;
  outbox: OpsOutbox;
  appInstanceId: string;
  sample(): { idle_ms: number; runtime_status?: RuntimeStatus; control_revision?: number };
  /** R3 — the run's pause state, to be applied to local new-run admission. Absent on an older Service. */
  onControl?(control: { paused: boolean; control_revision: number }): void;
  now(): number;
  random(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  log?(line: string): void;
  /** 401: the connection is gone for good — the host drops the credential and asks to pair again. */
  onDisconnected(reason: string): void;
  onEpoch?(epoch: number): void;
  /** Declared on every sync: a window that did not pair itself still says what it can run. */
  capabilities?: string[];
  /** R2 command ledger. Absent → this client observes only. */
  commands?: { pendingReceipts(): unknown[]; onAcks(acks: unknown[]): Promise<boolean>; onCommands(cmds: unknown[]): Promise<void>; /** The connection ended: nothing new may start, a running action is told to stop. */ close?(): void };
}
export interface OpsSyncLoop { stop(): void; tick(): Promise<void>; nudge(): void; readonly state: "running" | "stopped"; }

const jitter = (ms: number, random: () => number) => Math.round(ms * (0.8 + random() * 0.4));

export function startOpsSync(deps: SyncDeps, initialPollMs = 5000): OpsSyncLoop {
  let stopped = false, inflight = false, failures = 0, handle: unknown = null, pollMs = initialPollMs;
  const schedule = (ms: number) => { if (stopped) return; if (handle !== null) deps.clearTimeout(handle); handle = deps.setTimeout(() => { handle = null; void tick(); }, ms); };

  const tick = async (): Promise<void> => {
    if (stopped || inflight) return; // single-flight: a slow request is never doubled
    inflight = true;
    let next = pollMs;
    try {
      const events = deps.outbox.batch();
      const r = await deps.post({ schema_version: OPS_SCHEMA_VERSION, app_instance_id: deps.appInstanceId, boot_id: deps.outbox.bootId, events, sample: { ...deps.sample(), observed_at: deps.now() }, ...(deps.capabilities ? { capabilities: deps.capabilities } : {}), ...(deps.commands ? { receipts: deps.commands.pendingReceipts() } : {}) }, SYNC_TIMEOUT_MS);
      // The learner disconnected (or re-paired) while this request was in flight. Whatever it carries — a pause,
      // an approval to run, new commands — was addressed to a connection that no longer exists: drop all of it.
      if (stopped) return;
      if (r.status === 200 && r.body?.ack) {
        failures = 0;
        await deps.outbox.acked(r.body.ack.boot_id, r.body.ack.contiguous_seq);
        if (stopped) return;
        if (typeof r.body.poll_after_ms === "number") pollMs = Math.min(Math.max(r.body.poll_after_ms, 1000), 120000);
        if (typeof r.body.connection_epoch === "number") deps.onEpoch?.(r.body.connection_epoch);
        if (r.body.control && typeof r.body.control.paused === "boolean") deps.onControl?.(r.body.control);
        next = deps.outbox.pending ? 1000 : pollMs;
        if (deps.commands) {
          // Epoch first, then the Service's answers, then new work: a command never runs on a stale epoch or an unanswered ask.
          const ran = await deps.commands.onAcks(r.body.receipt_acks ?? []);
          if (stopped) return;
          await deps.commands.onCommands(r.body.commands ?? []);
          if (ran || deps.commands.pendingReceipts().length) next = 1000;
        }
      } else if (r.status === 401) {
        deps.log?.(`[ops] connection closed by the Service (${r.body?.reason ?? "401"}) — stopping`);
        loop.stop(); deps.onDisconnected(r.body?.reason ?? "ops_credential_invalid"); return;
      } else if (r.status === 403 && r.body?.reason === "seat_replaced") {
        loop.stop(); deps.onDisconnected("seat_replaced"); return;
      } else if (r.status === 404 || (r.status === 403 && r.body?.reason === "ops_observe_disabled")) {
        // Feature off for this run or this Service: keep the evidence, poll rarely, never bother the learner.
        next = Math.max(r.body?.poll_after_ms ?? 60000, 60000);
      } else if (r.status === 409) {
        next = 1000; // state CAS lost to another window; the events were stored
      } else if (r.status === 429) {
        next = Math.max((r.retryAfterSec ?? 60) * 1000, BACKOFF_STEPS_MS[0]);
      } else {
        next = BACKOFF_STEPS_MS[Math.min(failures, BACKOFF_STEPS_MS.length - 1)]!; failures++;
        deps.log?.(`[ops] sync failed (${r.status}) — retry in ${next} ms, ${deps.outbox.pending} event(s) kept`);
      }
    } finally {
      inflight = false;
    }
    if (stopped) return;
    schedule(jitter(next, deps.random));
  };

  const loop: OpsSyncLoop = {
    stop() { if (!stopped) deps.commands?.close?.(); stopped = true; if (handle !== null) deps.clearTimeout(handle); handle = null; },
    tick,
    /** A step/error/result should not wait out a 30 s prepare poll. */
    nudge() { if (!stopped && !inflight) schedule(0); },
    get state() { return stopped ? "stopped" as const : "running" as const; },
  };
  schedule(jitter(initialPollMs, deps.random));
  return loop;
}

/** Report a transition once: repeated identical status is not a new event. */
export class ChangeGate<T> {
  private last: string | null = null;
  next(value: T): T | null { const k = JSON.stringify(value); if (k === this.last) return null; this.last = k; return value; }
  reset(): void { this.last = null; }
}
