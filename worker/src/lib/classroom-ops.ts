// Remote classroom operations (#751) — pure contract shared by the Service
// routes and their tests. No bindings, no clock reads: callers pass `now`.
//
// The board this feeds is metadata-only. Every observation field is either an
// enum or a bounded identifier pattern, so prompt text, file names, stack
// traces and tokens have no field to travel in (docs/requirements/
// classroom-admin.md "API와 사건의 경계").

export const OPS_SCHEMA_VERSION = 1;
export const OPS_PROTOCOL = 1;
export const OPS_FLAGS = ['ops_observe', 'ops_commands', 'ops_collect', 'ops_reports', 'ops_delivery'] as const;
export type OpsFlag = (typeof OPS_FLAGS)[number];
/** Issuer-scope capabilities. Absent on every issuer minted before this landed — new authority is opt-in. */
/** `coach` is deliberately separate from `command`/`reset`: fixing a PC and guiding a learner are different authorities. */
export const OPS_CAPABILITIES = ['observe', 'manage', 'command', 'reset', 'pause', 'coach', 'collect', 'review', 'deliver'] as const;
export type OpsCapability = (typeof OPS_CAPABILITIES)[number];

/** Every ops_* timestamp is unix milliseconds (token expiries included, converted at the edge). */
export const PAIRING_TTL_MS = 600_000;
export const MAX_SEATS = 200;
export const MAX_SYNC_EVENTS = 100;
export const MAX_SYNC_BYTES = 64 * 1024;
/** 3 × 45 s heartbeat + 15 s slack. A seat older than this is "확인 불가", never "정상". */
export const STALE_AFTER_MS = 150_000;
export const POLL_LIVE_MS = 5000;
export const POLL_PREPARE_MS = 30000;
export const POLL_CLOSED_MS = 60000;

export const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const UUIDISH_RE = /^[A-Za-z0-9-]{8,64}$/;
const CODE_RE = /^[a-z0-9_.-]{1,64}$/;
const VERSION_RE = /^[A-Za-z0-9_.+-]{1,64}$/;

/** Who did it. `human`/`operator` are accepted from early clients and read as student/teacher. */
export const ACTORS = ['student', 'ai', 'teacher', 'external_user', 'tool', 'system', 'unknown'] as const;
const ACTOR_ALIASES: Record<string, (typeof ACTORS)[number]> = { human: 'student', operator: 'teacher' };
/** What kind of ground the evidence stands on. Absent means `unverified` — never `real`. */
export const SOURCE_STATES = ['real', 'simulated', 'self_reported', 'unverified'] as const;
export const EVIDENCE_TYPES = ['intent', 'criterion', 'action', 'decision', 'change', 'ownership'] as const;
export const REVIEW_STATES = ['unreviewed', 'confirmed', 'disputed'] as const;
const SHA256_RE = /^[a-f0-9]{64}$/;
export const ACTIVATION_STAGES = ['token_verified', 'token_rejected', 'class_entered', 'runtime_ready', 'runtime_failed'] as const;
export const STEP_STATUSES = ['not_started', 'in_progress', 'submitted', 'reviewed', 'free_activity'] as const;
export const RUNTIME_STATUSES = ['idle', 'running', 'waiting_approval', 'waiting_user', 'error'] as const;
export const UPLOAD_STATUSES = ['pending', 'uploaded', 'failed', 'verified'] as const;
/** HTTP 401 alone never maps to "expired": the client must name what it observed. */
export const ERROR_CLASSES = [
  'auth_expired', 'auth_signature', 'auth_revoked', 'auth_rejected', 'class_not_open', 'profile_mismatch',
  'roster_missing', 'budget_limit', 'provider_rate_limit', 'provider_5xx', 'network', 'sdk_not_ready',
  'tool_not_ready', 'review_error', 'upload_failed', 'unknown',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];
/** Shared-cause classes: many seats at once means one incident, not N broken PCs. */
export const COMMON_CAUSE_CLASSES: readonly ErrorClass[] = ['provider_rate_limit', 'provider_5xx', 'network', 'class_not_open', 'budget_limit'];
export const EVENT_KINDS = ['activation', 'step', 'runtime', 'error', 'upload', 'evidence'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface LessonPin { course_id: string; version: string; steps: string[] }
export interface OpsEvent {
  event_id: string; seq: number; observed_at: number; kind: EventKind;
  actor: (typeof ACTORS)[number]; payload: Record<string, unknown>;
}
export type Verdict<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): Verdict<never> => ({ ok: false, error });
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const exactKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

/** Strict allowlist per kind. An unknown key is a rejection, not something to strip and keep. */
export function validatePayload(kind: EventKind, p: unknown): Verdict<Record<string, unknown>> {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return bad('payload must be an object');
  const o = p as Record<string, unknown>;
  if (kind === 'activation') {
    if (!exactKeys(o, ['stage', 'reason', 'token_jti', 'token_exp', 'http_status'])) return bad('unsupported activation field');
    if (!oneOf(ACTIVATION_STAGES, o.stage)) return bad('activation.stage');
    if (o.reason !== undefined && !oneOf(ERROR_CLASSES, o.reason)) return bad('activation.reason');
    if (o.token_jti !== undefined && (typeof o.token_jti !== 'string' || !UUIDISH_RE.test(o.token_jti))) return bad('activation.token_jti');
    if (o.token_exp !== undefined && !Number.isSafeInteger(o.token_exp)) return bad('activation.token_exp');
    if (o.http_status !== undefined && !(Number.isInteger(o.http_status) && (o.http_status as number) >= 0 && (o.http_status as number) <= 599)) return bad('activation.http_status');
    return { ok: true, value: o };
  }
  if (kind === 'step') {
    if (!exactKeys(o, ['lesson_version', 'step_id', 'status'])) return bad('unsupported step field');
    if (!oneOf(STEP_STATUSES, o.status)) return bad('step.status');
    if (typeof o.lesson_version !== 'string' || !VERSION_RE.test(o.lesson_version)) return bad('step.lesson_version');
    if (o.status === 'free_activity') { if (o.step_id !== undefined) return bad('free activity carries no step'); }
    else if (typeof o.step_id !== 'string' || !ID_RE.test(o.step_id)) return bad('step.step_id');
    return { ok: true, value: o };
  }
  if (kind === 'runtime') {
    if (!exactKeys(o, ['status'])) return bad('unsupported runtime field');
    return oneOf(RUNTIME_STATUSES, o.status) ? { ok: true, value: o } : bad('runtime.status');
  }
  if (kind === 'error') {
    if (!exactKeys(o, ['class', 'code', 'request_id', 'blocking', 'cleared'])) return bad('unsupported error field');
    if (!oneOf(ERROR_CLASSES, o.class)) return bad('error.class');
    if (o.code !== undefined && (typeof o.code !== 'string' || !CODE_RE.test(o.code))) return bad('error.code');
    if (o.request_id !== undefined && (typeof o.request_id !== 'string' || !UUIDISH_RE.test(o.request_id))) return bad('error.request_id');
    if (typeof o.blocking !== 'boolean') return bad('error.blocking');
    if (o.cleared !== undefined && typeof o.cleared !== 'boolean') return bad('error.cleared');
    return { ok: true, value: o };
  }
  if (kind === 'evidence') {
    // Provenance only. The learner's own words stay on the device / in the existing consented share — never on the board.
    if (!exactKeys(o, ['evidence_type', 'source_state', 'step_id', 'artifact_before', 'artifact_after'])) return bad('unsupported evidence field');
    if (!oneOf(EVIDENCE_TYPES, o.evidence_type)) return bad('evidence.evidence_type');
    if (o.source_state !== undefined && !oneOf(SOURCE_STATES, o.source_state)) return bad('evidence.source_state');
    if (o.step_id !== undefined && (typeof o.step_id !== 'string' || !ID_RE.test(o.step_id))) return bad('evidence.step_id');
    for (const k of ['artifact_before', 'artifact_after']) if (o[k] !== undefined && (typeof o[k] !== 'string' || !SHA256_RE.test(o[k] as string))) return bad('evidence.' + k);
    return { ok: true, value: { ...o, source_state: o.source_state ?? 'unverified' } };
  }
  if (!exactKeys(o, ['status', 'snapshot_revision'])) return bad('unsupported upload field');
  if (!oneOf(UPLOAD_STATUSES, o.status)) return bad('upload.status');
  if (o.snapshot_revision !== undefined && !(Number.isInteger(o.snapshot_revision) && (o.snapshot_revision as number) >= 0)) return bad('upload.snapshot_revision');
  return { ok: true, value: o };
}

export function validateEvent(e: unknown): Verdict<OpsEvent> {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return bad('event must be an object');
  const o = e as Record<string, unknown>;
  if (!exactKeys(o, ['event_id', 'seq', 'observed_at', 'kind', 'actor', 'payload'])) return bad('unsupported event field');
  if (typeof o.event_id !== 'string' || !UUIDISH_RE.test(o.event_id)) return bad('event_id');
  if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 1) return bad('seq');
  if (!Number.isSafeInteger(o.observed_at) || (o.observed_at as number) < 0) return bad('observed_at');
  if (!oneOf(EVENT_KINDS, o.kind)) return bad('kind');
  const actor = o.actor === undefined ? 'unknown' : ACTOR_ALIASES[o.actor as string] ?? o.actor;
  if (!oneOf(ACTORS, actor)) return bad('actor');
  const payload = validatePayload(o.kind, o.payload);
  if (!payload.ok) return payload;
  return { ok: true, value: { event_id: o.event_id, seq: o.seq as number, observed_at: o.observed_at as number, kind: o.kind, actor, payload: payload.value } };
}

/** Key order is part of the hash: a resend is compared by meaning, not by byte layout. */
export function canonicalPayload(p: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]));
}

export function parseFlags(json: string | null | undefined): Record<OpsFlag, boolean> {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(json ?? '{}') ?? {}; } catch { raw = {}; }
  return Object.fromEntries(OPS_FLAGS.map((f) => [f, raw[f] === true])) as Record<OpsFlag, boolean>;
}
export function parseLesson(json: string | null | undefined): LessonPin | null {
  try { const l = JSON.parse(json ?? '{}'); return l && typeof l.version === 'string' ? { course_id: String(l.course_id ?? ''), version: l.version, steps: Array.isArray(l.steps) ? l.steps : [] } : null; } catch { return null; }
}

/** Why an otherwise valid step event is not allowed to move the board. */
export function stepDisposition(payload: Record<string, unknown>, lesson: LessonPin | null): 'applied' | 'lesson_mismatch' | 'unknown_step' {
  if (!lesson) return payload.status === 'free_activity' ? 'applied' : 'lesson_mismatch';
  if (payload.lesson_version !== lesson.version) return 'lesson_mismatch';
  if (payload.status === 'free_activity') return 'applied';
  return lesson.steps.includes(payload.step_id as string) ? 'applied' : 'unknown_step';
}

export interface SeatStateSlot { boot_seen_at: number; seq: number; observed_at: number; received_at: number; actor: string; value: Record<string, unknown> }
export type SeatState = Partial<Record<EventKind | 'sample' | 'token_check', SeatStateSlot>>;

/**
 * What the app said about ITS token is evidence, not an entry stage. `activation` holds only the latest stage, so a
 * later `runtime_ready` used to erase the `token_jti` that `token_verified` carried and the board fell back to
 * "unknown". The evidence lives in its own slot, bound to the connection (grant) and the app process (boot) that
 * reported it, and is dropped — never inherited — when either changes or the app reports a rejected token.
 */
export function reduceTokenCheck(state: SeatState, ctx: { grantId: string; bootId: string; bootSeenAt: number }, event?: { seq: number; observed_at: number; received_at: number; actor: string; payload: Record<string, unknown> }): boolean {
  let changed = false;
  const held = state.token_check;
  // A new connection or a newer app process has not verified anything yet. An older boot's late sync clears nothing.
  if (held && (held.value.grant_id !== ctx.grantId || (held.value.boot_id !== ctx.bootId && ctx.bootSeenAt >= held.boot_seen_at))) { delete state.token_check; changed = true; }
  if (!event) return changed;
  const stage = event.payload.stage, jti = event.payload.token_jti;
  const newer = shouldApply(state.token_check, ctx.bootSeenAt, event.seq);
  if (stage === 'token_verified' && typeof jti === 'string' && newer) {
    state.token_check = { boot_seen_at: ctx.bootSeenAt, seq: event.seq, observed_at: event.observed_at, received_at: event.received_at, actor: event.actor, value: { token_jti: jti, grant_id: ctx.grantId, boot_id: ctx.bootId } };
    return true;
  }
  if (stage === 'token_rejected' && state.token_check && newer) { delete state.token_check; return true; }
  return changed;
}

/** `unknown` = this connection's app has not reported a verified token. Never inferred from the entry stage. */
export function tokenCheckOf(state: SeatState, issueId: string, currentGrantId: string): 'unknown' | 'matches_issue' | 'other_token' {
  const held = state.token_check;
  // Rows written before the evidence slot existed kept the jti inside the activation slot itself.
  const legacy = !held && state.activation?.value.stage === 'token_verified' ? state.activation.value.token_jti : undefined;
  const reported = held ? (held.value.grant_id === currentGrantId ? held.value.token_jti : undefined) : legacy;
  return typeof reported !== 'string' ? 'unknown' : reported === issueId ? 'matches_issue' : 'other_token';
}

/** Later boot wins; within a boot, only a higher seq. A delayed resend never rolls the board back. */
export function shouldApply(current: SeatStateSlot | undefined, bootSeenAt: number, seq: number): boolean {
  if (!current) return true;
  if (bootSeenAt !== current.boot_seen_at) return bootSeenAt > current.boot_seen_at;
  return seq > current.seq;
}

export type EntryStage = 'unregistered' | 'pairing_issued' | 'device_connected' | 'token_issued' | 'token_verified' | 'token_rejected' | 'class_entered' | 'runtime_ready';
export interface SeatInputs {
  pairing_issued: boolean; connected: boolean; token_issued: boolean; state: SeatState;
  last_received_at: number | null; grant_revoked: boolean;
}
/** Issuance is server-known; verification, entry and readiness exist only if the app reported them. */
export function entryStage(i: SeatInputs): EntryStage {
  const a = i.state.activation?.value.stage;
  if (i.connected) {
    if (a === 'runtime_ready') return 'runtime_ready';
    if (a === 'class_entered' || a === 'runtime_failed') return 'class_entered';
    if (a === 'token_rejected') return 'token_rejected';
    if (a === 'token_verified') return 'token_verified';
    return i.token_issued ? 'token_issued' : 'device_connected';
  }
  if (i.token_issued) return 'token_issued';
  return i.pairing_issued ? 'pairing_issued' : 'unregistered';
}

export type Signal = 'fresh' | 'stale' | 'none';
export const signalOf = (lastReceivedAt: number | null, now: number): Signal =>
  lastReceivedAt === null ? 'none' : now - lastReceivedAt > STALE_AFTER_MS ? 'stale' : 'fresh';

export type Attention = 'blocked' | 'caution' | 'unknown' | 'ok';
/**
 * `blocked` (the only red) needs a confirmed blocking error or a rejected
 * token, observed on a fresh signal. Silence is `unknown`, never a failure:
 * the 2026-08-22 replay had two seats with zero rows and no known cause.
 */
export function attentionOf(i: SeatInputs, now: number): { attention: Attention; reason: string } {
  const signal = signalOf(i.last_received_at, now);
  if (!i.connected) return { attention: 'unknown', reason: i.grant_revoked ? 'connection_revoked' : 'not_connected' };
  if (signal !== 'fresh') return { attention: 'unknown', reason: signal === 'none' ? 'no_signal' : 'stale_signal' };
  const err = i.state.error?.value;
  if (err && err.cleared !== true && err.blocking === true) return { attention: 'blocked', reason: String(err.class) };
  if (i.state.activation?.value.stage === 'token_rejected') return { attention: 'blocked', reason: String(i.state.activation.value.reason ?? 'auth_rejected') };
  if (i.state.activation?.value.stage === 'runtime_failed') return { attention: 'blocked', reason: String(i.state.activation.value.reason ?? 'sdk_not_ready') };
  if (err && err.cleared !== true) return { attention: 'caution', reason: String(err.class) };
  if (i.state.runtime?.value.status === 'waiting_approval') return { attention: 'ok', reason: 'waiting_approval' };
  return { attention: 'ok', reason: '' };
}

/** One incident with a head count beats N red rows that each suggest resetting a healthy PC. */
export function commonIncidents(seats: Array<{ seat_id: string; attention: Attention; reason: string }>): Array<{ class: string; seats: string[] }> {
  const by = new Map<string, string[]>();
  for (const s of seats) if ((s.attention === 'blocked' || s.attention === 'caution') && (COMMON_CAUSE_CLASSES as readonly string[]).includes(s.reason)) by.set(s.reason, [...(by.get(s.reason) ?? []), s.seat_id]);
  const threshold = Math.max(3, Math.ceil(seats.length * 0.3));
  return [...by].filter(([, ids]) => ids.length >= threshold).map(([cls, ids]) => ({ class: cls, seats: ids }));
}

export function pollAfterMs(run: { starts_at: number; ends_at: number; ended: boolean }, nowMs: number): number {
  if (run.ended || nowMs > run.ends_at) return POLL_CLOSED_MS;
  return nowMs < run.starts_at ? POLL_PREPARE_MS : POLL_LIVE_MS;
}

/** Highest contiguous seq plus the holes after it, from the stored seqs above the old cursor. */
export function contiguousAck(cursor: number, storedAscending: number[]): { contiguous: number; missing: Array<[number, number]> } {
  let contiguous = cursor; const missing: Array<[number, number]> = [];
  let i = 0;
  while (i < storedAscending.length && storedAscending[i] === contiguous + 1) { contiguous++; i++; }
  let expect = contiguous + 1;
  for (; i < storedAscending.length; i++) { const s = storedAscending[i]!; if (s > expect) missing.push([expect, s - 1]); expect = s + 1; }
  return { contiguous, missing };
}

const TICKET_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Typed or scanned once within ten minutes; ambiguous glyphs (0/O, 1/I/L, U) are left out. */
export function newPairingTicket(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  // Rejection sampling: `b % length` would favour the first 256 % length characters.
  const limit = 256 - (256 % TICKET_ALPHABET.length); let out = '';
  for (let round = 0; out.length < 12 && round < 64; round++) for (const b of random(16)) if (b < limit && out.length < 12) out += TICKET_ALPHABET[b % TICKET_ALPHABET.length];
  if (out.length < 12) throw new Error('pairing ticket entropy source exhausted');
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}
export const normalizeTicket = (t: string) => t.toUpperCase().replace(/[^0-9A-Z]/g, '');
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── commands (R2) ───────────────────────────────────────────────────────────
// The allowlist IS the protocol. There is no shell, URL, VS Code command id or
// file path anywhere in it, and `args` is a closed, per-action object.

export const COMMAND_TTL_MS = 120_000;
export const LEASE_TAKEOVER_MS = STALE_AFTER_MS;
export const MAX_COMMAND_TARGETS = MAX_SEATS;
export interface CommandSpec { capability: OpsCapability; flag: OpsFlag; mutating: boolean; maxTargets: number; runMs: number; /** Closed argument schema; absent → the action takes none. */ args?: (a: Record<string, unknown>) => Verdict<Record<string, unknown>>; kind: 'recovery' | 'coaching' }
/**
 * A coaching message is a question or a pointer — not an answer. Code fences, markup and
 * long text have no place in it; the bound keeps "send the fixed code" out of the contract.
 */
const coachText = (v: unknown, max: number): string | null => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/```|<\/?[a-zA-Z]|[{};]\s*$/m.test(v) ? v.trim() : null;
const questionArgs = (a: Record<string, unknown>): Verdict<Record<string, unknown>> => {
  if (!exactKeys(a, ['text'])) return bad('send_question takes text only');
  const text = coachText(a.text, 300); return text ? { ok: true, value: { text } } : bad('text must be a plain question of at most 300 characters');
};
const checkpointArgs = (a: Record<string, unknown>): Verdict<Record<string, unknown>> => {
  if (!exactKeys(a, ['step_id', 'note'])) return bad('mark_checkpoint takes step_id and note only');
  if (a.step_id !== undefined && (typeof a.step_id !== 'string' || !ID_RE.test(a.step_id))) return bad('step_id');
  const note = a.note === undefined ? '' : coachText(a.note, 200); if (note === null) return bad('note must be plain text of at most 200 characters');
  return { ok: true, value: { ...(a.step_id ? { step_id: a.step_id } : {}), ...(note ? { note } : {}) } };
};
export const COMMAND_ACTIONS: Record<string, CommandSpec> = {
  retry_diagnostics: { kind: 'recovery', capability: 'command', flag: 'ops_commands', mutating: false, maxTargets: MAX_SEATS, runMs: 20_000 },
  refresh_connection: { kind: 'recovery', capability: 'command', flag: 'ops_commands', mutating: false, maxTargets: MAX_SEATS, runMs: 30_000 },
  restart_preview: { kind: 'recovery', capability: 'command', flag: 'ops_commands', mutating: false, maxTargets: MAX_SEATS, runMs: 30_000 },
  // R3. State-changing: one in flight per seat, never auto-retried, and `reset_runtime` is one learner at a time.
  // Neither clears history, deletes files, resets credentials or reboots anything — the device contract forbids it.
  cancel_current_run: { kind: 'recovery', capability: 'command', flag: 'ops_commands', mutating: true, maxTargets: MAX_SEATS, runMs: 20_000 },
  reset_runtime: { kind: 'recovery', capability: 'reset', flag: 'ops_commands', mutating: true, maxTargets: 1, runMs: 60_000 },
  // Coaching. Changes no file, conversation or input on the learner's side; `succeeded` means "shown", not "read".
  send_question: { kind: 'coaching', capability: 'coach', flag: 'ops_commands', mutating: false, maxTargets: MAX_SEATS, runMs: 15_000, args: questionArgs },
  mark_checkpoint: { kind: 'coaching', capability: 'coach', flag: 'ops_commands', mutating: false, maxTargets: MAX_SEATS, runMs: 15_000, args: checkpointArgs },
};
/** Issued only by the Service as part of a collection batch. It is not in COMMAND_ACTIONS, so no instructor request can name it or its arguments. */
export const SERVICE_ISSUED_ACTIONS: Record<string, { runMs: number }> = { retry_evidence_upload: { runMs: 120_000 } };
export const REASON_CODES = ['student_request', 'blocked_error', 'no_signal', 'preview_broken', 'class_management', 'other'] as const;
export const TARGET_OPEN_STATES = ['queued', 'leased', 'accepted', 'running'] as const;
export const TARGET_TERMINAL_STATES = ['succeeded', 'failed', 'rejected', 'expired', 'cancelled', 'outcome_unknown', 'unsupported', 'not_connected'] as const;
export type TargetState = (typeof TARGET_OPEN_STATES)[number] | (typeof TARGET_TERMINAL_STATES)[number];
/** States a device may report. `leased`, `expired`, `cancelled` and `not_connected` are the Service's alone. */
export const RECEIPT_STATES = ['accepted', 'running', 'succeeded', 'failed', 'rejected', 'outcome_unknown', 'unsupported'] as const;
const ORDER: Record<string, number> = { queued: 0, leased: 1, accepted: 2, running: 3 };
export const isTerminal = (s: string) => (TARGET_TERMINAL_STATES as readonly string[]).includes(s);

/** Forward only. A terminal state is final: a late or replayed receipt can never rewrite an outcome. */
export function nextTargetState(current: string, reported: string): { ok: true; state: string } | { ok: false; reason: 'terminal' | 'backwards' | 'not_leased' | 'unknown_state' } {
  if (!(RECEIPT_STATES as readonly string[]).includes(reported)) return { ok: false, reason: 'unknown_state' };
  if (isTerminal(current)) return { ok: false, reason: 'terminal' };
  if (current === 'queued') return { ok: false, reason: 'not_leased' };
  if (!isTerminal(reported) && ORDER[reported]! <= ORDER[current]!) return { ok: false, reason: 'backwards' };
  return { ok: true, state: reported };
}

export interface Receipt { command_id: string; lease_generation: number; connection_epoch: number; state: string; result_code: string; observed_at: number }
export function validateReceipt(r: unknown): Verdict<Receipt> {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return bad('receipt must be an object');
  const o = r as Record<string, unknown>;
  if (!exactKeys(o, ['command_id', 'lease_generation', 'connection_epoch', 'state', 'result_code', 'observed_at'])) return bad('unsupported receipt field');
  if (typeof o.command_id !== 'string' || !UUIDISH_RE.test(o.command_id)) return bad('command_id');
  if (!Number.isSafeInteger(o.lease_generation) || !Number.isSafeInteger(o.connection_epoch) || !Number.isSafeInteger(o.observed_at)) return bad('generation, epoch and observed_at');
  if (!oneOf(RECEIPT_STATES, o.state)) return bad('state');
  const code = o.result_code === undefined ? '' : o.result_code;
  if (typeof code !== 'string' || (code !== '' && !CODE_RE.test(code))) return bad('result_code');
  return { ok: true, value: { command_id: o.command_id, lease_generation: o.lease_generation as number, connection_epoch: o.connection_epoch as number, state: o.state, result_code: code, observed_at: o.observed_at as number } };
}

/** `done` is only ever true when every target has a final outcome; `all_succeeded` never rounds up. */
export function summarize(targets: Array<{ state: string }>) {
  const by: Record<string, number> = {}; for (const t of targets) by[t.state] = (by[t.state] ?? 0) + 1;
  const done = targets.every((t) => isTerminal(t.state));
  return { total: targets.length, by_state: by, done, all_succeeded: done && targets.length > 0 && targets.every((t) => t.state === 'succeeded'), unconfirmed: targets.filter((t) => !isTerminal(t.state) || t.state === 'outcome_unknown').length };
}
