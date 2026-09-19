// Remote classroom operations (#751) — withdrawal and retention: what is removed, what is kept, and why.
//
// A learner (or, for a child, the operator on the guardian's instruction) withdraws, or the operator applies the
// retention period. Following the links from the consent outward, this removes the CONTENT the Service holds:
//   - the verified snapshot objects (the learner's words),
//   - the report drafts built from them (they quote those words),
//   - every protected link to those reports (revoked, so a mail already sent opens nothing),
//   - queued work that would read them again (outbox rows, jobs not yet sent).
// It keeps the content-free record that the thing happened: batch item state, job row (state `withdrawn`), delivery
// ledger rows and the audit trail. Those rows hold ids, states and digests — never the learner's text.
// The tombstone stays, so a late device upload, a re-run of job creation or a replayed webhook cannot bring any of it
// back. What already reached a recipient's inbox is NOT recalled, and nothing here claims it was.
import type { Env } from '../env';

export interface ErasureResult { snapshot_objects: number; report_objects: number; links_revoked: number; jobs_closed: number; outbox_cancelled: number; deliveries_already_sent: number }
async function deletePrefix(bucket: Env['HPS_TRACES'], prefix: string): Promise<number> {
  let n = 0, cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) }) as { objects: Array<{ key: string }>; truncated?: boolean; cursor?: string };
    for (const o of page.objects) { await bucket.delete(o.key); n++; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}

export async function eraseLearnerCollection(env: Env, who: { class_run_id: string; cohort_id: string; student_id: string }, reason: 'withdrawn' | 'retention', actor: { kind: string; id: string }, now: number): Promise<ErasureResult> {
  const db = env.HPS_DB;
  // Tombstone first: from this line on, nothing new for this learner and run can be stored, even if a later step fails.
  await db.batch([
    db.prepare('INSERT INTO classroom_collect_tombstones(class_run_id,student_id,reason,created_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').bind(who.class_run_id, who.student_id, reason, actor.kind, now),
    // Progress marker: `started` until the content is really gone. A failure below leaves it `started`, and the scheduled run retries it.
    db.prepare("INSERT INTO classroom_erasure_log(class_run_id,student_id,reason,state,attempts,started_at,updated_at) VALUES(?,?,?,'started',1,?,?) ON CONFLICT(class_run_id,student_id) DO UPDATE SET state='started',attempts=attempts+1,updated_at=excluded.updated_at").bind(who.class_run_id, who.student_id, reason, now, now),
  ]);
  const links = await db.prepare('UPDATE classroom_report_links SET revoked_at=? WHERE class_run_id=? AND student_id=? AND revoked_at IS NULL RETURNING id').bind(now, who.class_run_id, who.student_id).all();
  const jobs = await db.prepare("UPDATE classroom_report_jobs SET state='withdrawn',reason=?,draft_digest='',summary_json='{}',lease_expires_at=0,revision=revision+1,updated_at=? WHERE class_run_id=? AND student_id=? AND state<>'withdrawn' RETURNING id").bind(reason, now, who.class_run_id, who.student_id).all();
  const outbox = await db.prepare("UPDATE classroom_job_outbox SET state='cancelled',processed_at=? WHERE kind='report_input' AND state='pending' AND json_extract(payload_json,'$.class_run_id')=? AND json_extract(payload_json,'$.student_id')=? RETURNING id").bind(now, who.class_run_id, who.student_id).all();
  await db.prepare("UPDATE classroom_collect_items SET state='withdrawn',reason=?,manifest_digest='',receipt_id='',updated_at=? WHERE student_id=? AND batch_id IN (SELECT id FROM classroom_collect_batches WHERE class_run_id=?)").bind(reason, now, who.student_id, who.class_run_id).run();
  const sent = await db.prepare("SELECT count(*) AS n FROM classroom_report_deliveries WHERE class_run_id=? AND student_id=? AND state IN ('provider_accepted','delivered','send_unknown')").bind(who.class_run_id, who.student_id).first<{ n: number }>();
  // Content last, after nothing points at it any more. A failure here leaves the log at `started`; the same call (or the scheduled run) finishes it.
  let snapshot_objects = 0, report_objects = 0;
  try {
    snapshot_objects = await deletePrefix(env.HPS_TRACES, `classroom-snapshots/${who.cohort_id}/${who.class_run_id}/${who.student_id}/`);
    report_objects = await deletePrefix(env.HPS_TRACES, `classroom-reports/${who.cohort_id}/${who.class_run_id}/${who.student_id}/`);
  } catch (err) {
    await db.prepare("UPDATE classroom_erasure_log SET last_error='content_delete_failed',updated_at=? WHERE class_run_id=? AND student_id=?").bind(now, who.class_run_id, who.student_id).run();
    throw err;
  }
  const result: ErasureResult = { snapshot_objects, report_objects, links_revoked: (links.results ?? []).length, jobs_closed: (jobs.results ?? []).length, outbox_cancelled: (outbox.results ?? []).length, deliveries_already_sent: sent?.n ?? 0 };
  await db.batch([
    db.prepare("UPDATE classroom_erasure_log SET state='done',last_error='',updated_at=? WHERE class_run_id=? AND student_id=?").bind(now, who.class_run_id, who.student_id),
    db.prepare("INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) VALUES(?,'',?,?,?,?,?)").bind(who.class_run_id, actor.kind, actor.id, 'collection_erased', JSON.stringify({ student_id: who.student_id, reason, ...result }), now),
  ]);
  return result;
}

// ── scheduled retention (hooked into the existing daily cron) ──
export type RetentionMode = 'off' | 'dry-run' | 'enforce';
export interface RetentionConfig { mode: RetentionMode; days: number | null; problem?: string }
/**
 * OFF unless a period is set, and even then it only REPORTS until someone also sets HPS_CLASSROOM_RETENTION=enforce.
 * The period itself is an operations decision: there is no default, and a value that is not a whole number of days
 * between 1 and 3650 switches the run off rather than being "corrected".
 */
export function retentionConfig(env: Env): RetentionConfig {
  if (env.HPS_CLASSROOM_OPS !== 'enabled') return { mode: 'off', days: null };
  const raw = env.HPS_CLASSROOM_RETENTION_DAYS;
  if (raw === undefined || raw === '') return { mode: 'off', days: null };
  if (!/^[1-9]\d{0,3}$/.test(raw) || Number(raw) > 3650) return { mode: 'off', days: null, problem: 'retention_days_invalid' };
  return { mode: env.HPS_CLASSROOM_RETENTION === 'enforce' ? 'enforce' : 'dry-run', days: Number(raw) };
}
export interface RetentionTick { mode: RetentionMode; days: number | null; problem?: string; due_runs: number; due_learners: number; erased: number; failed: number; remaining: number }
/** One bounded pass. `now` is a parameter so the clock can be faked. Safe to run again: a learner whose erasure is `done` is never selected. */
export async function runClassroomRetention(env: Env, now: number, limit = 50): Promise<RetentionTick> {
  const cfg = retentionConfig(env), tick: RetentionTick = { mode: cfg.mode, days: cfg.days, ...(cfg.problem ? { problem: cfg.problem } : {}), due_runs: 0, due_learners: 0, erased: 0, failed: 0, remaining: 0 };
  if (cfg.mode === 'off' || cfg.days === null) return tick;
  const cutoff = now - cfg.days * 86_400_000, db = env.HPS_DB;
  // Learners of runs whose retention period is over and whose stored content is not confirmed gone. Interrupted erasures of ANY reason are picked up too.
  const due = ((await db.prepare(`SELECT DISTINCT o.class_run_id,o.cohort_id,i.student_id FROM class_run_ops o JOIN classroom_collect_batches x ON x.class_run_id=o.class_run_id JOIN classroom_collect_items i ON i.batch_id=x.id
 LEFT JOIN classroom_erasure_log l ON l.class_run_id=o.class_run_id AND l.student_id=i.student_id WHERE o.ends_at<=? AND COALESCE(l.state,'')<>'done' ORDER BY o.ends_at,o.class_run_id,i.student_id`).bind(cutoff).all()).results ?? []) as Array<{ class_run_id: string; cohort_id: string; student_id: string }>;
  tick.due_learners = due.length; tick.due_runs = new Set(due.map((d) => d.class_run_id)).size;
  if (cfg.mode === 'dry-run') { tick.remaining = due.length; return tick; }
  for (const d of due.slice(0, limit)) {
    try { await eraseLearnerCollection(env, d, 'retention', { kind: 'system', id: 'retention' }, now); tick.erased++; }
    catch (err) { tick.failed++; console.error('classroom retention: erasure did not finish; it will be retried', d.class_run_id, (err as Error)?.name ?? 'error'); }
  }
  tick.remaining = due.length - tick.erased;
  return tick;
}
