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
export const OPS_CAPABILITIES = ['observe', 'manage', 'command', 'reset', 'pause', 'collect', 'review', 'deliver'] as const;
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

export const ACTORS = ['human', 'ai', 'tool', 'operator', 'system', 'unknown'] as const;
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
export const EVENT_KINDS = ['activation', 'step', 'runtime', 'error', 'upload'] as const;
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
  const actor = o.actor === undefined ? 'unknown' : o.actor;
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
export type SeatState = Partial<Record<EventKind | 'sample', SeatStateSlot>>;

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
