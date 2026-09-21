// Remote classroom operations (#751, U3) — the D1 side of targeted lesson settings on the LEARNING path: the one
// resolver the chat gate and GET /v1/profile both call, turn admission, and execution evidence.
// Contract: docs/requirements/classroom-admin.md#remote-management-u3-20260921.
//
//  - Enforcement (`HPS_LESSON_BINDINGS=enforce`) is independent of `HPS_CLASSROOM_OPS`: switching operations off stops NEW
//    changes; it does not undo a setting a participant was already switched to.
//  - A binding that cannot be read is UNKNOWN, and unknown holds execution. It never falls back to the (wider) token lesson.
//    "No such table" is the one error that is a verified absence: without the table no binding can exist.
//  - Every decision about a turn is taken from the row that is actually stored, never from what this request computed.
import type { Env } from '../env';
import type { TokenPayload } from './tokens';
import { readLesson, resolveTokenLesson } from './lesson-delivery';
import {
  LESSON_BINDINGS_ENFORCE, TURN_ID_RE, BINDING_KEY_RE, applicableBinding, decideAdmittedTurn, decideNewTurn, tokenBindingKey, tokenIdentity,
  type BindingRow, type Effective, type Outcome, type Refusal, type TurnRow,
} from './lesson-binding';

type Lesson = NonNullable<Awaited<ReturnType<typeof readLesson>>>;
export const bindingsEnforced = (env: Env) => env.HPS_LESSON_BINDINGS === LESSON_BINDINGS_ENFORCE;
const noSuchTable = (err: unknown) => /no such table/i.test(String((err as Error)?.message ?? err));

export const LATEST_BINDING_SQL = `SELECT b.*,EXISTS (SELECT 1 FROM class_run_seats x WHERE x.class_run_id=b.class_run_id AND x.seat_id=b.seat_id AND x.seat_revision=b.seat_revision AND x.student_id=b.student_id AND x.replaced_at IS NULL) AS seat_live
 FROM classroom_lesson_bindings b WHERE b.class_run_id=? AND b.student_id=? ORDER BY b.binding_seq DESC LIMIT 1`;
const TURN_SQL = 'SELECT * FROM classroom_lesson_turns WHERE class_run_id=? AND student_id=? AND turn_id=?';

export interface BindingView { key: string; seq: number; source: Effective['source']; object_id: string | null; revision: number | null; enforced: boolean; not_applied: Effective['not_applied'] }
export type Resolved =
  | { ok: true; lesson: Lesson; binding: BindingView; effective: Effective | null; turn: TurnRow | null }
  | { ok: false; status: 403 | 409; code: Refusal | 'lesson_unavailable'; current_key?: string; /** true when the version that stopped resolving is a SWITCHED one (not the token's own). */ switched?: boolean };

/** Test seam: lets a test hold the resolver between its read and its conditional INSERT, the way U2's D5 holds a SELECT. */
export const resolverHooks: { afterRead?: () => Promise<void> } = {};

/**
 * `mode: 'turn'` — a model route: the request is admitted into (or found in) a turn. `mode: 'read'` — /v1/profile and the
 * other gate users: the current binding, no turn, the expectation header is not consulted.
 */
export async function resolveEffectiveLesson(env: Env, payload: TokenPayload, o: { classRunId: string | null; lessonCohort: string; mode: 'turn' | 'read'; turnId?: string; expectKey?: string; now: number }): Promise<Resolved> {
  const tokenOnly = async (): Promise<Resolved> => {
    const lesson = await resolveTokenLesson(env, payload, o.lessonCohort);
    return lesson ? { ok: true, lesson, binding: { key: tokenBindingKey(lesson.sha256), seq: 0, source: 'token', object_id: null, revision: null, enforced: false, not_applied: '' }, effective: null, turn: null } : { ok: false, status: 409, code: 'lesson_unavailable' };
  };
  if (!payload.lesson || !bindingsEnforced(env) || !o.classRunId) return tokenOnly();
  const db = env.HPS_DB, run = o.classRunId, student = payload.u, token = payload.lesson;
  const turnId = o.mode === 'turn' && typeof o.turnId === 'string' && TURN_ID_RE.test(o.turnId) ? o.turnId : undefined;
  const expectKey = o.mode === 'turn' && typeof o.expectKey === 'string' && BINDING_KEY_RE.test(o.expectKey) ? o.expectKey : o.mode === 'turn' && o.expectKey !== undefined ? '' : undefined;

  const lessonFor = async (e: { source: string; course_id: string; version: string; lesson_sha256: string }): Promise<Lesson | null> => {
    if (e.source !== 'setting') return resolveTokenLesson(env, payload, o.lessonCohort);
    // Re-validated on every read, exactly like a token lesson: a profile whose grants shrank closes it instead of widening.
    const l = await readLesson(env, o.lessonCohort, e.course_id, e.version, payload.p);
    return l && l.sha256 === e.lesson_sha256 ? l : null;
  };
  const done = async (e: Effective, turn: TurnRow | null, snapshot?: { source: string; course_id: string; version: string; lesson_sha256: string; key: string; seq: number }): Promise<Resolved> => {
    const s = snapshot ?? e, lesson = await lessonFor(s);
    if (!lesson) return { ok: false, status: 409, code: 'lesson_unavailable', switched: s.source === 'setting' };
    const same = !snapshot || snapshot.seq === e.seq;
    return { ok: true, lesson, effective: e, turn, binding: { key: s.key, seq: s.seq, source: (same ? e.source : snapshot!.source) as Effective['source'], object_id: same ? e.object_id : null, revision: same ? e.revision : null, enforced: true, not_applied: same ? e.not_applied : '' } };
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let latest: BindingRow | null, turn: TurnRow | null = null;
    try {
      if (turnId) { const r = await db.batch([db.prepare(TURN_SQL).bind(run, student, turnId), db.prepare(LATEST_BINDING_SQL).bind(run, student)]) as Array<{ results?: unknown[] }>; turn = (r[0]?.results?.[0] ?? null) as TurnRow | null; latest = (r[1]?.results?.[0] ?? null) as BindingRow | null; }
      else latest = await db.prepare(LATEST_BINDING_SQL).bind(run, student).first<BindingRow>();
    } catch (err) {
      if (noSuchTable(err)) { console.error('lesson bindings are enforced but migration 0024 is missing: no binding can exist'); return tokenOnly(); }
      console.error('lesson binding unreadable — execution held, not run under a guessed lesson:', err);
      return { ok: false, status: 403, code: 'lesson_binding_unknown' };
    }
    const current = applicableBinding(latest, token);
    if (o.mode === 'read') return done(current, null);
    if (turn) {
      const d = decideAdmittedTurn(turn, { tokenIdentity: tokenIdentity(payload), expectKey, currentKey: current.key, now: o.now });
      if (!d.ok) return { ok: false, status: 403, code: d.code, current_key: current.key };
      // The snapshot of the row — not the current binding — is what this request runs under.
      return done(current, turn, { source: turn.binding_seq === 0 ? 'token' : turn.lesson_sha256 === token.sha256 ? 'base' : 'setting', course_id: turn.course_id, version: turn.version, lesson_sha256: turn.lesson_sha256, key: turn.binding_key, seq: turn.binding_seq });
    }
    const d = decideNewTurn(current, { expectKey, turnId });
    if (!d.ok) return { ok: false, status: 403, code: d.code, current_key: current.key };
    if (!d.pin) return done(current, null);
    if (resolverHooks.afterRead) await resolverHooks.afterRead();
    // Admission. The INSERT itself re-checks what was read: the participant's latest binding is still this one and its seat
    // is as live as it was read. A switch or a seat change that landed in between admits nothing, and the row that is READ
    // BACK in the same batch — the winner's, if a sibling request of this turn got there first — is what decides.
    const seq = latest?.binding_seq ?? 0;
    let stored: TurnRow | null;
    try {
      const r = await db.batch([
        db.prepare(`INSERT INTO classroom_lesson_turns(class_run_id,student_id,turn_id,token_jti,binding_seq,binding_key,course_id,version,lesson_sha256,admitted_at)
 SELECT ?,?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT MAX(binding_seq) FROM classroom_lesson_bindings WHERE class_run_id=? AND student_id=?),0)=?
 AND (?=0 OR (SELECT EXISTS (SELECT 1 FROM class_run_seats x JOIN classroom_lesson_bindings b ON b.class_run_id=x.class_run_id AND b.seat_id=x.seat_id AND b.seat_revision=x.seat_revision AND b.student_id=x.student_id WHERE b.class_run_id=? AND b.student_id=? AND b.binding_seq=? AND x.replaced_at IS NULL))=?)
 ON CONFLICT(class_run_id,student_id,turn_id) DO NOTHING`).bind(run, student, turnId!, tokenIdentity(payload), current.seq, current.key, current.course_id, current.version, current.lesson_sha256, o.now, run, student, seq, seq, run, student, seq, latest?.seat_live === 1 ? 1 : 0),
        db.prepare(TURN_SQL).bind(run, student, turnId!),
      ]) as Array<{ results?: unknown[] }>;
      stored = (r[1]?.results?.[0] ?? null) as TurnRow | null;
    } catch (err) { console.error('turn admission not recorded — execution held:', err); return { ok: false, status: 403, code: 'lesson_binding_unknown' }; }
    if (stored) {
      const again = decideAdmittedTurn(stored, { tokenIdentity: tokenIdentity(payload), expectKey, currentKey: current.key, now: o.now });
      if (!again.ok) return { ok: false, status: 403, code: again.code, current_key: current.key };
      return done(current, stored, { source: stored.binding_seq === 0 ? 'token' : stored.lesson_sha256 === token.sha256 ? 'base' : 'setting', course_id: stored.course_id, version: stored.version, lesson_sha256: stored.lesson_sha256, key: stored.binding_key, seq: stored.binding_seq });
    }
    // Nothing stored: what was read moved before the commit. Resolve once more against the state as it is now.
  }
  return { ok: false, status: 403, code: 'lesson_binding_changed' };
}

// ── execution evidence ───────────────────────────────────────────────────────
/**
 * Called immediately before the normalized request leaves for the provider. For the FIRST dispatch of a turn the write is
 * awaited and must land: "no dispatch on record" is only allowed to mean "nothing was executed" if the record precedes the
 * execution. If it cannot be written the caller does not call the provider. Later dispatches of the same turn add nothing.
 * The binding row's own first_dispatched_at is filled by a SECOND conditional statement of the same batch (one transaction).
 */
export async function recordDispatch(env: Env, turn: TurnRow | null, o: { request: string; runtime: string; model: string; now: number }): Promise<{ ok: true } | { ok: false; code: Refusal }> {
  if (!turn || turn.first_dispatched_at !== null) return { ok: true };
  const db = env.HPS_DB, pk = [turn.class_run_id, turn.student_id, turn.turn_id];
  try {
    const r = await db.batch([
      db.prepare('UPDATE classroom_lesson_turns SET first_dispatched_at=?,first_dispatch_request=?,runtime=?,model=? WHERE class_run_id=? AND student_id=? AND turn_id=? AND first_dispatched_at IS NULL AND closed_at IS NULL').bind(o.now, o.request, o.runtime, o.model.slice(0, 120), ...pk),
      db.prepare(`UPDATE classroom_lesson_bindings SET first_dispatched_at=? WHERE class_run_id=? AND student_id=? AND binding_seq=? AND first_dispatched_at IS NULL
 AND EXISTS (SELECT 1 FROM classroom_lesson_turns t WHERE t.class_run_id=? AND t.student_id=? AND t.turn_id=? AND t.first_dispatch_request=?)`).bind(o.now, turn.class_run_id, turn.student_id, turn.binding_seq, ...pk, o.request),
      db.prepare('SELECT first_dispatched_at,closed_at FROM classroom_lesson_turns WHERE class_run_id=? AND student_id=? AND turn_id=?').bind(...pk),
    ]) as Array<{ results?: Array<{ first_dispatched_at: number | null; closed_at: number | null }> }>;
    const row = r[2]?.results?.[0];
    // A sibling request of this turn may have recorded it first: that is the same durable fact. A turn the host closed meanwhile is not dispatched.
    if (row && row.first_dispatched_at !== null) return { ok: true };
    return { ok: false, code: row?.closed_at ? 'lesson_turn_closed' : 'lesson_binding_unknown' };
  } catch (err) { console.error('dispatch not recorded — provider not called:', err); return { ok: false, code: 'lesson_binding_unknown' }; }
}

/** After the request ended. A failure to write leaves "dispatched, outcome unknown" — never "completed", never "not started". */
export async function recordOutcome(env: Env, turn: TurnRow | null, outcome: Outcome, o: { status: number | null; now: number }): Promise<void> {
  if (!turn) return;
  const db = env.HPS_DB, pk = [turn.class_run_id, turn.student_id, turn.turn_id];
  try {
    if (outcome === 'completed') await db.batch([
      db.prepare('UPDATE classroom_lesson_turns SET first_completed_at=? WHERE class_run_id=? AND student_id=? AND turn_id=? AND first_completed_at IS NULL AND first_dispatched_at IS NOT NULL').bind(o.now, ...pk),
      db.prepare(`UPDATE classroom_lesson_bindings SET first_completed_at=? WHERE class_run_id=? AND student_id=? AND binding_seq=? AND first_completed_at IS NULL
 AND EXISTS (SELECT 1 FROM classroom_lesson_turns t WHERE t.class_run_id=? AND t.student_id=? AND t.turn_id=? AND t.first_completed_at IS NOT NULL)`).bind(o.now, turn.class_run_id, turn.student_id, turn.binding_seq, ...pk),
    ]);
    else await db.batch([
      db.prepare('UPDATE classroom_lesson_turns SET last_failure_kind=?,last_failure_status=?,last_failure_at=? WHERE class_run_id=? AND student_id=? AND turn_id=? AND first_dispatched_at IS NOT NULL').bind(outcome, o.status, o.now, ...pk),
      db.prepare(`UPDATE classroom_lesson_bindings SET last_failure_kind=?,last_failure_at=? WHERE class_run_id=? AND student_id=? AND binding_seq=? AND first_completed_at IS NULL
 AND EXISTS (SELECT 1 FROM classroom_lesson_turns t WHERE t.class_run_id=? AND t.student_id=? AND t.turn_id=? AND t.last_failure_at=?)`).bind(outcome, o.now, turn.class_run_id, turn.student_id, turn.binding_seq, ...pk, o.now),
    ]);
  } catch (err) { console.error('turn outcome not recorded — it stays "dispatched, outcome unknown":', err); }
}

/** The host says its turn ended. Only the token that was admitted may close it; a closed turn id is refused from then on. */
export async function closeTurn(env: Env, payload: TokenPayload, o: { classRunId: string; turnId: string; outcome: string; now: number }): Promise<'closed' | 'already' | 'not_found' | 'unavailable'> {
  try {
    const r = await env.HPS_DB.batch([
      env.HPS_DB.prepare('UPDATE classroom_lesson_turns SET closed_at=?,close_outcome=? WHERE class_run_id=? AND student_id=? AND turn_id=? AND token_jti=? AND closed_at IS NULL').bind(o.now, o.outcome, o.classRunId, payload.u, o.turnId, tokenIdentity(payload)),
      env.HPS_DB.prepare('SELECT closed_at FROM classroom_lesson_turns WHERE class_run_id=? AND student_id=? AND turn_id=? AND token_jti=?').bind(o.classRunId, payload.u, o.turnId, tokenIdentity(payload)),
    ]) as Array<{ meta?: { changes?: number }; results?: Array<{ closed_at: number | null }> }>;
    if ((r[0]?.meta?.changes ?? 0) === 1) return 'closed';
    return r[1]?.results?.[0] ? 'already' : 'not_found';
  } catch (err) { if (noSuchTable(err)) return 'not_found'; console.error('turn close not recorded:', err); return 'unavailable'; }
}

/** What the Service knows about ONE turn of THIS token. Another learner's, another run's or another token's turn is "none". */
export async function readTurn(env: Env, payload: TokenPayload, classRunId: string, turnId: string): Promise<{ known: true; row: TurnRow | null } | { known: false }> {
  if (!bindingsEnforced(env)) return { known: false };
  try {
    const row = await env.HPS_DB.prepare(TURN_SQL).bind(classRunId, payload.u, turnId).first<TurnRow>();
    // A row admitted under ANOTHER token of this learner is not this caller's turn: that is "not known", never "not started".
    if (row && row.token_jti !== tokenIdentity(payload)) return { known: false };
    return { known: true, row: row ?? null };
  } catch (err) { if (!noSuchTable(err)) console.error('turn state unreadable:', err); return { known: false }; }
}

// ── the OPERATIONS side: board, step disposition, instructor review, collection seal ──
/**
 * The same `applicableBinding()` the gate uses. Operations has no learner token in hand, so the run's pinned lesson stands
 * in for it — which is also today's rule for step events (a seat whose token pins something else than the run is already
 * `lesson_mismatch`). Returns 'unknown' when the binding cannot be read; "no such table" is a verified absence.
 */
export async function effectiveForSeat(db: Env['HPS_DB'], pin: { course_id: string; version: string; sha256?: string } | null, classRunId: string, studentId: string): Promise<Effective | null | 'unknown'> {
  if (!pin || !pin.sha256) return null;
  try { return applicableBinding(await db.prepare(LATEST_BINDING_SQL).bind(classRunId, studentId).first<BindingRow>(), { course_id: pin.course_id, version: pin.version, sha256: pin.sha256 }); }
  catch (err) { if (noSuchTable(err)) return null; console.error('lesson basis unreadable for the board:', err); return 'unknown'; }
}
/** Board: every live seat in ONE statement, one index seek per seat (bounded by seats, not by how many revisions a run has seen). */
export const SEAT_BINDINGS_SQL = `SELECT s.seat_id,(SELECT json_object('class_run_id',b.class_run_id,'student_id',b.student_id,'binding_seq',b.binding_seq,'seat_id',b.seat_id,'seat_revision',b.seat_revision,'binding_key',b.binding_key,'source',b.source,'object_id',b.object_id,'revision',b.revision,'course_id',b.course_id,'version',b.version,'lesson_sha256',b.lesson_sha256,'base_lesson_sha256',b.base_lesson_sha256,'steps_json',b.steps_json,
 'seat_live',CASE WHEN b.seat_id=s.seat_id AND b.seat_revision=s.seat_revision THEN 1 ELSE 0 END)
 FROM classroom_lesson_bindings b WHERE b.class_run_id=s.class_run_id AND b.student_id=s.student_id ORDER BY b.binding_seq DESC LIMIT 1) AS binding
 FROM class_run_seats s WHERE s.class_run_id=? AND s.replaced_at IS NULL`;
export async function effectiveBySeat(db: Env['HPS_DB'], pin: { course_id: string; version: string; sha256?: string } | null, classRunId: string): Promise<Map<string, Effective> | 'unknown'> {
  const out = new Map<string, Effective>();
  if (!pin || !pin.sha256) return out;
  try {
    for (const r of ((await db.prepare(SEAT_BINDINGS_SQL).bind(classRunId).all()).results ?? []) as Array<{ seat_id: string; binding: string | null }>) {
      let row: BindingRow | null = null; try { row = r.binding ? JSON.parse(r.binding) : null; } catch { row = null; }
      out.set(r.seat_id, applicableBinding(row, { course_id: pin.course_id, version: pin.version, sha256: pin.sha256 }));
    }
    return out;
  } catch (err) { if (noSuchTable(err)) return out; console.error('lesson bases unreadable for the board:', err); return 'unknown'; }
}
