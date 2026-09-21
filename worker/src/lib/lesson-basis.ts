// Remote classroom operations (#751, U3) — under how many lesson bases was a sealed collection input produced, and may the
// existing report pipeline evaluate, approve or deliver it? ONE verdict for every consumer.
// Contract: docs/requirements/classroom-admin.md#remote-management-u3-20260921 ("기준이 바뀔 때").
//
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

export async function inputBasisVerdict(db: Db, i: { class_run_id: string; student_id: string; batch_id: string; snapshot_revision: number }): Promise<BasisVerdict> {
  try {
    const r = await db.prepare(`SELECT (SELECT basis FROM classroom_input_basis WHERE batch_id=? AND student_id=? AND revision=?) AS basis,
 EXISTS (SELECT 1 FROM classroom_lesson_bindings WHERE class_run_id=? AND student_id=?) AS changed`).bind(i.batch_id, i.student_id, i.snapshot_revision, i.class_run_id, i.student_id).first<{ basis: string | null; changed: number }>();
    if (r?.basis === 'single') return { allow: true, kind: 'single', tables: true };
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
export const basisAllows = (j: string) => `(EXISTS (SELECT 1 FROM classroom_input_basis ib WHERE ib.batch_id=${j}.batch_id AND ib.student_id=${j}.student_id AND ib.revision=${j}.snapshot_revision AND ib.basis='single')
 OR (NOT EXISTS (SELECT 1 FROM classroom_input_basis ib WHERE ib.batch_id=${j}.batch_id AND ib.student_id=${j}.student_id AND ib.revision=${j}.snapshot_revision)
 AND NOT EXISTS (SELECT 1 FROM classroom_lesson_bindings lb WHERE lb.class_run_id=${j}.class_run_id AND lb.student_id=${j}.student_id)))`;
/** Do the U3 tables exist in this database? Decides whether `basisAllows` may be attached to a statement at all. */
export async function basisTables(db: Db): Promise<boolean | 'unreadable'> {
  try { await db.prepare('SELECT 1 FROM classroom_input_basis LIMIT 1').first(); await db.prepare('SELECT 1 FROM classroom_lesson_turns LIMIT 1').first(); return true; }
  catch (err) { return noSuchTable(err) ? false : 'unreadable'; }
}

/**
 * Written INSIDE the seal batch, computed in SQL so that it is atomic with the seal. The basis is what the participant's
 * model requests ACTUALLY ran under, and it is established from two ledgers that are compared, not from clocks:
 *   - the turn ledger: every request the Service permitted under an admitted turn is counted on that turn's row
 *     (`requests`, written by the same statement that permits the provider call), and the row names the lesson;
 *   - the usage ledger: one row per answered model request of this participant in this run, written by the existing path
 *     whatever the lesson policy is — including while enforcement is switched off.
 * `mixed`   = admitted turns ran under more than one lesson, or the participant was ever switched and there are answered
 *             requests that no admitted turn accounts for while a turn ran under a switched lesson (a rollback, a request
 *             without a turn id).
 * `unknown` = the participant was ever switched and there are unaccounted requests, but no turn shows which lesson they
 *             ran under. Held as well: a guess is not a basis.
 * `single`  = everything else: one lesson among the turns and nothing unaccounted, or a participant who was never switched
 *             (every request of theirs ran the token's lesson, turn row or not).
 * No timestamp is compared: `usage_log.created_at` has one-second resolution and `activated_at` has milliseconds, and a
 * request in the same second as the switch was read as "before it" (a single-basis record was held for nothing).
 * A usage row whose session attribution was lost (the existing NULL retry) is still counted, by cohort and run window.
 * What this cannot see: a usage row that was never written. That is an existing, logged loss and can only hide a request.
 */
// (`WHERE 1` below is required by SQLite's grammar: after INSERT … SELECT … FROM <subquery>, a bare ON would parse as a join constraint.)
export const sealBasisStatement = (db: Db, i: { batch_id: string; student_id: string; revision: number; class_run_id: string; now: number }) => db.prepare(`INSERT INTO classroom_input_basis(batch_id,student_id,revision,class_run_id,basis,lessons,turns,created_at)
 SELECT ?1,?2,?3,?4,CASE WHEN x.n>1 THEN 'mixed' WHEN x.switched=0 OR x.executed<=x.accounted THEN 'single' WHEN x.ran_switched>0 THEN 'mixed' ELSE 'unknown' END,x.n,x.t,?5 FROM (SELECT
 (SELECT COUNT(DISTINCT lesson_sha256) FROM classroom_lesson_turns WHERE class_run_id=?4 AND student_id=?2 AND requests>0) AS n,
 (SELECT COUNT(*) FROM classroom_lesson_turns WHERE class_run_id=?4 AND student_id=?2) AS t,
 (SELECT COALESCE(SUM(requests),0) FROM classroom_lesson_turns WHERE class_run_id=?4 AND student_id=?2) AS accounted,
 (SELECT COUNT(*) FROM classroom_lesson_bindings b WHERE b.class_run_id=?4 AND b.student_id=?2 AND b.source='setting' AND b.lesson_sha256<>b.base_lesson_sha256) AS switched,
 (SELECT COUNT(*) FROM classroom_lesson_turns t JOIN classroom_lesson_bindings b ON b.class_run_id=t.class_run_id AND b.student_id=t.student_id AND b.binding_seq=t.binding_seq WHERE t.class_run_id=?4 AND t.student_id=?2 AND t.requests>0 AND b.source='setting' AND b.lesson_sha256<>b.base_lesson_sha256) AS ran_switched,
 (SELECT COUNT(*) FROM usage_log u WHERE u.user_id=?2 AND u.status BETWEEN 200 AND 299 AND (u.session_id=?4 OR (u.session_id IS NULL
   AND u.cohort_id=(SELECT r.cohort_id FROM class_run_ops r WHERE r.class_run_id=?4) AND u.created_at>=(SELECT datetime(r.starts_at/1000,'unixepoch') FROM class_run_ops r WHERE r.class_run_id=?4)))) AS executed) x WHERE 1
 ON CONFLICT(batch_id,student_id,revision) DO NOTHING`).bind(i.batch_id, i.student_id, i.revision, i.class_run_id, i.now);
