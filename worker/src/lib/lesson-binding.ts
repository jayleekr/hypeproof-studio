// Remote classroom operations (#751, U3) — targeted lesson settings: the pure contract.
// No imports, no bindings, no clock reads (callers pass `now`), so tests load this file directly.
// Contract: docs/requirements/classroom-admin.md#remote-management-u3-20260921.
//
// Four facts that must not blur:
//   binding   which frozen lesson version a participant of a class run is switched to (append-only history)
//   turn      one learner turn the Service ADMITTED, and the execution snapshot every request of it runs under
//   evidence  what actually left for the provider under that snapshot, and how the protocol said it ended
//   header    `x-hps-lesson-binding` — what the App EXPECTS. It selects nothing and proves nothing.

export const BINDING_HEADER = 'x-hps-lesson-binding';
export const TURN_HEADER = 'x-hps-turn-id';
export const LESSON_BINDINGS_ENFORCE = 'enforce';
/**
 * Upper bound for a turn the host never closed. It is NOT how a turn ends: the host closes a turn, and a closed turn is
 * refused whatever its age. This only bounds what a client that does not close can keep pinned.
 */
export const TURN_PIN_MAX_MS = 30 * 60_000;
export const TURN_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
export const BINDING_KEY_RE = /^(token:[a-f0-9]{16}|[a-f0-9]{32})$/;
export const CLOSE_OUTCOMES = ['completed', 'aborted', 'failed'] as const;

export interface TokenLessonRef { course_id: string; version: string; sha256: string }
export interface BindingRow {
  class_run_id: string; student_id: string; binding_seq: number; seat_id: string; seat_revision: number; binding_key: string;
  source: string; distribution_id: string; object_id: string; revision: number; course_id: string; version: string;
  lesson_sha256: string; base_lesson_sha256: string; steps_json: string; activated_at: number;
  first_dispatched_at: number | null; first_completed_at: number | null; last_failure_kind: string; last_failure_at: number | null;
  /** 1 when the seat this row was switched on is still that learner's, at the same seat revision. */
  seat_live: number;
}
export interface TurnRow {
  class_run_id: string; student_id: string; turn_id: string; token_jti: string; binding_seq: number; binding_key: string;
  course_id: string; version: string; lesson_sha256: string; admitted_at: number; closed_at: number | null; close_outcome: string;
  first_dispatched_at: number | null; first_completed_at: number | null; last_failure_kind: string; last_failure_status: number | null; last_failure_at: number | null;
}

export const tokenBindingKey = (sha256: string) => 'token:' + sha256.slice(0, 16);
/** Named by the distribution that switched it (one distribution switches one participant once), so the key exists before the sequence number does. */
export const bindingKeyInput = (b: { class_run_id: string; seat_id: string; seat_revision: number; student_id: string; source: string; distribution_id: string; object_id: string; revision: number; course_id: string; version: string; lesson_sha256: string }) =>
  ['binding', b.class_run_id, b.seat_id, b.seat_revision, b.student_id, b.source, b.distribution_id, b.object_id, b.revision, b.course_id, b.version, b.lesson_sha256].join('|');
/** A legacy token has no jti; its issue time stands in so that a turn is still bound to ONE token. */
export const tokenIdentity = (p: { jti?: string; iat?: number }) => p.jti ?? 'iat:' + String(p.iat ?? 0);

export interface Effective { key: string; seq: number; source: 'token' | 'setting' | 'base'; course_id: string; version: string; lesson_sha256: string; object_id: string | null; revision: number | null; steps: string[] | null; token_equivalent: boolean; not_applied: '' | 'course_mismatch' | 'token_lesson_changed' | 'seat_replaced' }
/**
 * What this participant executes under NOW. Used by the gate, /v1/profile, the board, step disposition, instructor review
 * and the collection seal — none of them reads "the latest row" on its own. A row is not applied when the course differs
 * from the token's, when the token it was switched under has been reissued for ANOTHER version (that is the newer explicit
 * decision; the same version keeps the binding), or when its seat changed hands.
 */
export function applicableBinding(row: BindingRow | null, token: TokenLessonRef): Effective {
  const base: Effective = { key: tokenBindingKey(token.sha256), seq: 0, source: 'token', course_id: token.course_id, version: token.version, lesson_sha256: token.sha256, object_id: null, revision: null, steps: null, token_equivalent: true, not_applied: '' };
  if (!row) return base;
  const why = row.course_id !== token.course_id ? 'course_mismatch' : row.base_lesson_sha256 !== token.sha256 ? 'token_lesson_changed' : row.seat_live !== 1 ? 'seat_replaced' : '';
  if (why) return { ...base, not_applied: why };
  let steps: string[] | null = null; try { const s = JSON.parse(row.steps_json); steps = Array.isArray(s) ? s.filter((x) => typeof x === 'string') : null; } catch { steps = null; }
  if (row.source === 'base') return { ...base, key: row.binding_key, seq: row.binding_seq, source: 'base', object_id: row.object_id, revision: row.revision };
  return { key: row.binding_key, seq: row.binding_seq, source: 'setting', course_id: row.course_id, version: row.version, lesson_sha256: row.lesson_sha256, object_id: row.object_id, revision: row.revision, steps, token_equivalent: row.lesson_sha256 === token.sha256, not_applied: '' };
}

export type Refusal = 'lesson_binding_changed' | 'lesson_binding_app_unsupported' | 'lesson_turn_mismatch' | 'lesson_turn_expired' | 'lesson_turn_closed' | 'lesson_binding_unknown';
/** A request that carries no turn row yet: admit it under the CURRENT binding or refuse it. It never gets an older one. */
export function decideNewTurn(current: Effective, o: { expectKey: string | undefined; turnId: string | undefined }): { ok: true; pin: boolean } | { ok: false; code: Refusal } {
  if (o.expectKey === undefined) {
    // A binding-unaware app builds its tool policy from a cached profile. Where the Service would run another version than
    // that profile's, the two would disagree on the route where the Service is not the tool boundary (ADR 0007).
    return current.token_equivalent ? { ok: true, pin: o.turnId !== undefined } : { ok: false, code: 'lesson_binding_app_unsupported' };
  }
  if (o.expectKey !== current.key) return { ok: false, code: 'lesson_binding_changed' };
  return { ok: true, pin: o.turnId !== undefined };
}
/** A request of a turn that was admitted before. The row decides; later bindings do not. */
export function decideAdmittedTurn(row: Pick<TurnRow, 'token_jti' | 'binding_key' | 'admitted_at' | 'closed_at'>, o: { tokenIdentity: string; expectKey: string | undefined; currentKey: string; now: number }): { ok: true } | { ok: false; code: Refusal } {
  if (row.token_jti !== o.tokenIdentity) return { ok: false, code: 'lesson_turn_mismatch' };
  if (row.closed_at !== null) return { ok: false, code: 'lesson_turn_closed' };
  if (o.expectKey !== undefined && o.expectKey !== row.binding_key) return { ok: false, code: 'lesson_turn_mismatch' };
  if (o.now - row.admitted_at > TURN_PIN_MAX_MS && row.binding_key !== o.currentKey) return { ok: false, code: 'lesson_turn_expired' };
  return { ok: true };
}

// ── evidence ─────────────────────────────────────────────────────────────────
export type Outcome = 'completed' | 'truncated' | 'empty' | 'stream_error' | 'upstream_error' | 'refused_after_dispatch';
/**
 * How a dispatched request ended, from what the protocol said — never from "2xx and a body". `protocolComplete` is the
 * provider's own end marker (message_stop / the final chunk), `streamError` an error event or a broken stream.
 */
export function classifyOutcome(f: { upstreamStatus: number | null; protocolComplete: boolean; streamError: boolean; outputTokens: number; recordedStatus: number }): Outcome {
  if (f.upstreamStatus === null || f.upstreamStatus >= 400) return 'upstream_error';
  if (f.streamError) return 'stream_error';
  if (!f.protocolComplete) return 'truncated';
  if (f.recordedStatus >= 400) return 'refused_after_dispatch';
  return f.outputTokens > 0 ? 'completed' : 'empty';
}

export type TurnState = 'not_started' | 'dispatched' | 'completed' | 'failed' | 'unknown';
/** What a device may be told about ITS turn. Absence is only meaningful when the read succeeded (the caller decides that). */
export function turnState(row: Pick<TurnRow, 'first_dispatched_at' | 'first_completed_at' | 'last_failure_kind'> | null): TurnState {
  if (!row || row.first_dispatched_at === null) return 'not_started';
  if (row.first_completed_at !== null) return 'completed';
  return row.last_failure_kind ? 'failed' : 'dispatched';
}

export type SettingPhase = 'prepared' | 'switched' | 'attempted' | 'attempt_failed' | 'outcome_unknown' | 'applied' | 'replaced';
/**
 * The instructor's words for one target of a setting distribution. `applied` is a protocol-complete provider response under
 * the binding, nothing less — and nothing more: it is REQUEST-level. A learner question is several requests (the pinned Agent
 * SDK sends an auxiliary request before its main loop under the same turn id), and the Service cannot tell them apart without
 * guessing from the body, so it does not. `applied` is not "the question succeeded"; a later failure stays on the row beside it.
 */
export function settingPhase(b: Pick<BindingRow, 'binding_seq' | 'activated_at' | 'first_dispatched_at' | 'first_completed_at' | 'last_failure_kind'> | null, o: { latestSeq: number; now: number }): SettingPhase {
  if (!b) return 'prepared';
  if (b.first_completed_at !== null) return b.binding_seq < o.latestSeq ? 'replaced' : 'applied';
  if (b.binding_seq < o.latestSeq) return 'replaced';
  if (b.first_dispatched_at === null) return 'switched';
  if (b.last_failure_kind) return 'attempt_failed';
  return o.now - b.first_dispatched_at > TURN_PIN_MAX_MS ? 'outcome_unknown' : 'attempted';
}

// ── what the instructor is shown before sending a setting ────────────────────
interface LessonShape { title?: string; steps?: Array<{ id: string; title?: string }>; assistant?: { display_name?: string }; model?: { default?: string; allowed?: string[] }; features?: { allowed?: string[] } }
/**
 * Computed by the Service from the two frozen rows — never typed by the instructor. `null` sides mean "the compiled
 * profile's own rule" (no lesson-level narrowing), which is a wider set than any list.
 */
export function lessonImpact(from: LessonShape, to: LessonShape) {
  const ids = (l: LessonShape) => (l.steps ?? []).map((s) => s.id), a = ids(from), b = ids(to);
  const list = (x?: string[]) => (x ? [...x].sort() : null), same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  return {
    title: from.title === to.title ? null : { from: from.title ?? '', to: to.title ?? '' },
    steps: { kept: a.filter((x) => b.includes(x)), removed: a.filter((x) => !b.includes(x)), added: b.filter((x) => !a.includes(x)) },
    assistant_name: (from.assistant?.display_name ?? null) === (to.assistant?.display_name ?? null) ? null : { from: from.assistant?.display_name ?? null, to: to.assistant?.display_name ?? null },
    model: same([from.model?.default, list(from.model?.allowed)], [to.model?.default, list(to.model?.allowed)]) ? null : { from: from.model ? { default: from.model.default, allowed: list(from.model.allowed) } : null, to: to.model ? { default: to.model.default, allowed: list(to.model.allowed) } : null },
    features: same(list(from.features?.allowed), list(to.features?.allowed)) ? null : { from: list(from.features?.allowed), to: list(to.features?.allowed) },
  };
}
