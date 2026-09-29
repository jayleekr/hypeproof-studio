// Remote classroom operations (#751, U3) — under how many lesson bases was a sealed collection input produced, and may the
// existing report pipeline evaluate, approve or deliver it? ONE verdict for every consumer.
// Contract: docs/requirements/classroom-admin.md#remote-management-u3-20260921 ("기준이 바뀔 때").
//
//  - The basis is established by IDENTITY, not by counting: every request the Service permitted under enforcement has a row
//    (request id, turn, lesson) written before the provider was called, and the usage ledger row of that request points back
//    at it. An answered usage row of the participant that NO permitted request points at cannot be attributed to a lesson.
//  - Allowed are exactly two cases: the input revision's basis row says `single`, or there is no basis row AND a successful
//    read shows this participant of this run was never switched (a verified legacy input). Everything else is HELD: mixed,
//    unknown, a change history without a basis row, an unreadable table. "No such table" alone (a database before migration
//    0024) means no change history can exist.
//  - The verdict reads no run flag, no HPS_CLASSROOM_OPS and no HPS_LESSON_BINDINGS: switching the execution policy off, or
//    sending learners back to the base lesson, is not a decision to evaluate a record that was made under two bases.
//  - Per-segment reporting (splitting a record by the turns that ran under each basis) is later work. Until then a held
//    input is visible in the review queue with its reason and is never scored as zero, missing or failed.
import type { Env } from '../env';
type Db = Env['HPS_DB'];
export type HoldReason = 'mixed_lesson_basis' | 'lesson_basis_unknown' | 'lesson_basis_unreadable';
export type BasisVerdict = { allow: true; kind: 'single' | 'legacy'; tables: boolean } | { allow: false; reason: HoldReason; tables: boolean };
const noSuchTable = (err: unknown) => /no such table/i.test(String((err as Error)?.message ?? err));

/**
 * "This participant was switched at some point AND has an answered usage row, inside the window of this input, that no
 * permitted request points at." Such a row is a request the Service cannot attribute to a lesson: enforcement was off when
 * it ran (it ran the token's lesson), or its link was lost. Either way the input is not provably of one basis.
 * `run`/`student` are SQL expressions; `upto` is the input's seal time in ms (usage rows stored up to two minutes after it
 * still belong to requests made before it — the usage row is written after the answer). Usage rows whose session attribution
 * was lost (the existing NULL retry) are found by cohort and run window. No timestamp is compared with a switch.
 */
const unattributed = (run: string, student: string, upto: string) => `(EXISTS (SELECT 1 FROM classroom_lesson_bindings sb WHERE sb.class_run_id=${run} AND sb.student_id=${student} AND sb.source='setting' AND sb.lesson_sha256<>sb.base_lesson_sha256)
 AND EXISTS (SELECT 1 FROM usage_log u WHERE u.user_id=${student} AND u.status BETWEEN 200 AND 299 AND u.created_at<=datetime((${upto})/1000+120,'unixepoch')
  AND (u.session_id=${run} OR (u.session_id IS NULL AND u.cohort_id=(SELECT r.cohort_id FROM class_run_ops r WHERE r.class_run_id=${run}) AND u.created_at>=(SELECT datetime(r.starts_at/1000,'unixepoch') FROM class_run_ops r WHERE r.class_run_id=${run})))
  AND u.id NOT IN (SELECT q.usage_row_id FROM classroom_lesson_requests q WHERE q.class_run_id=${run} AND q.student_id=${student} AND q.usage_row_id IS NOT NULL)))`;
// (`NOT IN (subquery)` and not a per-row `NOT EXISTS`: the participant's request rows are read once, by their primary-key prefix —
// rows read grow with requests + usage rows, not with their product, and no index on usage_row_id has to be written per request.)

export async function inputBasisVerdict(db: Db, i: { class_run_id: string; student_id: string; batch_id: string; snapshot_revision: number }): Promise<BasisVerdict> {
  try {
    // The sealed row AND the same attribution rule read again now: a usage row of a request made before the seal may be
    // stored after it (it is written once the answer ended), and a sealed `single` must not outlive that.
    const r = await db.prepare(`SELECT ib.basis AS basis,
 EXISTS (SELECT 1 FROM classroom_lesson_bindings WHERE class_run_id=?4 AND student_id=?2) AS changed,
 CASE WHEN ib.basis IS NULL THEN 0 ELSE ${unattributed('?4', '?2', 'ib.created_at')} END AS late
 FROM (SELECT 1) one LEFT JOIN classroom_input_basis ib ON ib.batch_id=?1 AND ib.student_id=?2 AND ib.revision=?3`).bind(i.batch_id, i.student_id, i.snapshot_revision, i.class_run_id).first<{ basis: string | null; changed: number; late: number }>();
    if (r?.basis === 'single') return r.late ? { allow: false, reason: 'lesson_basis_unknown', tables: true } : { allow: true, kind: 'single', tables: true };
    if (r?.basis === 'mixed') return { allow: false, reason: 'mixed_lesson_basis', tables: true };
    if (r?.basis) return { allow: false, reason: 'lesson_basis_unknown', tables: true };
    return r && !r.changed ? { allow: true, kind: 'legacy', tables: true } : { allow: false, reason: 'lesson_basis_unknown', tables: true };
  } catch (err) {
    if (noSuchTable(err)) return { allow: true, kind: 'legacy', tables: false };
    console.error('lesson basis unreadable — the input is held, not evaluated on a guess:', err);
    return { allow: false, reason: 'lesson_basis_unreadable', tables: true };
  }
}
/**
 * The same rule as a predicate over `classroom_report_jobs` (alias or table name `j`), for the statements that COMMIT: saving
 * a result, approving, selecting what is sent. Attached only when the verdict read proved the tables exist.
 */
export const basisAllows = (j: string) => `(EXISTS (SELECT 1 FROM classroom_input_basis ib WHERE ib.batch_id=${j}.batch_id AND ib.student_id=${j}.student_id AND ib.revision=${j}.snapshot_revision AND ib.basis='single'
   AND NOT ${unattributed(`${j}.class_run_id`, `${j}.student_id`, 'ib.created_at')})
 OR (NOT EXISTS (SELECT 1 FROM classroom_input_basis ib WHERE ib.batch_id=${j}.batch_id AND ib.student_id=${j}.student_id AND ib.revision=${j}.snapshot_revision)
 AND NOT EXISTS (SELECT 1 FROM classroom_lesson_bindings lb WHERE lb.class_run_id=${j}.class_run_id AND lb.student_id=${j}.student_id)))`;
/** Do the U3 tables exist in this database? Decides whether `basisAllows` may be attached to a statement at all. */
export async function basisTables(db: Db): Promise<boolean | 'unreadable'> {
  try { await db.prepare('SELECT 1 FROM classroom_input_basis LIMIT 1').first(); await db.prepare('SELECT 1 FROM classroom_lesson_requests LIMIT 1').first(); return true; }
  catch (err) { return noSuchTable(err) ? false : 'unreadable'; }
}

/**
 * Written INSIDE the seal batch, computed in SQL so that it is atomic with the seal. The basis is what the participant's
 * model requests ACTUALLY ran under, established by identity:
 *   - `classroom_lesson_requests`: one row per request the Service permitted under enforcement — request id, turn, lesson —
 *     written BEFORE the provider is called (no row → the provider was not called). Failed, cut and retried requests have
 *     their rows too: they ran under that lesson as far as they ran.
 *   - the usage ledger row of each such request points back at it (`usage_row_id`, written in the usage row's own batch).
 * `mixed`   = the permitted requests ran under more than one lesson (a row with an EMPTY lesson is a model call that is not a
 *             lesson execution — the opt-in observation assessment — and is no basis).
 * `unknown` = the participant was switched at some point and an answered usage row exists that no permitted request points
 *             at (see `unattributed`): enforcement was rolled back and the token lesson ran, or a link was lost. Held.
 * `single`  = everything else — including a participant who was never switched, whose every request ran the token's lesson
 *             whether or not enforcement recorded it.
 * Counting was tried and is wrong: permitted-request counts against answered-usage counts let one FAILED enforced request
 * cover one successful request made with enforcement off (independent review, 5a476f7); comparing the usage row's
 * one-second timestamp with the switch's milliseconds held a single-basis record (a92301d). Neither is used.
 * What this cannot see: a request made while enforcement was OFF whose usage row was never written (the existing, logged
 * "usage row LOST") — nothing of it exists anywhere. Under enforcement nothing depends on the usage row being written.
 */
// (`WHERE 1` below is required by SQLite's grammar: after INSERT … SELECT … FROM <subquery>, a bare ON would parse as a join constraint.)
// `receipt` (#751 U1b): write the basis only if that very seal committed in the same batch — a seal refused inside its own commit
// (a withdrawal landed meanwhile) leaves no basis row behind.
export const sealBasisStatement = (db: Db, i: { batch_id: string; student_id: string; revision: number; class_run_id: string; now: number; receipt?: string }) => db.prepare(`INSERT INTO classroom_input_basis(batch_id,student_id,revision,class_run_id,basis,lessons,turns,created_at)
 SELECT ?1,?2,?3,?4,CASE WHEN x.n>1 THEN 'mixed' WHEN x.unattributed THEN 'unknown' ELSE 'single' END,x.n,x.t,?5 FROM (SELECT
 (SELECT COUNT(DISTINCT lesson_sha256) FROM classroom_lesson_requests WHERE class_run_id=?4 AND student_id=?2 AND lesson_sha256<>'') AS n,
 (SELECT COUNT(*) FROM classroom_lesson_turns WHERE class_run_id=?4 AND student_id=?2) AS t,
 ${unattributed('?4', '?2', '?5')} AS unattributed) x WHERE ${i.receipt === undefined ? '1' : 'EXISTS (SELECT 1 FROM classroom_snapshots s WHERE s.batch_id=?1 AND s.student_id=?2 AND s.revision=?3 AND s.receipt_id=?6)'}
 ON CONFLICT(batch_id,student_id,revision) DO NOTHING`).bind(i.batch_id, i.student_id, i.revision, i.class_run_id, i.now, ...(i.receipt === undefined ? [] : [i.receipt]));
