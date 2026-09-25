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
//
// Progress is a ledger row per learner and run (classroom_erasure_log), because R2 and D1 share no transaction:
//   started  — the request is recorded and nothing can be opened any more; the content may still be there.
//   done     — the content was deleted, and D1 refuses every later result for this learner (tombstone + withdrawn job).
//   settled  — re-checked after the window in which a write that was ALREADY in flight could still land
//              (SETTLE_AFTER_MS); anything found then is removed and counted. Never selected again.
// Two different things act on that ledger and must not be confused:
//   - RECOVERY finishes what somebody already asked for (`started`, `done`). It needs no retention setting and runs on
//     every scheduled tick: a withdrawal must not wait for a retention period that may never be configured.
//   - RETENTION starts NEW erasures, and only when a period is configured and enforcement is switched on.
import type { Env } from '../env';
import { LEASE_MS } from './classroom-report';

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
    // Progress marker: `started` until the content is really gone. A failure below leaves it `started`, and recovery retries it.
    db.prepare("INSERT INTO classroom_erasure_log(class_run_id,student_id,reason,state,attempts,started_at,updated_at) VALUES(?,?,?,'started',1,?,?) ON CONFLICT(class_run_id,student_id) DO UPDATE SET state='started',attempts=attempts+1,updated_at=excluded.updated_at").bind(who.class_run_id, who.student_id, reason, now, now),
  ]);
  const links = await db.prepare('UPDATE classroom_report_links SET revoked_at=? WHERE class_run_id=? AND student_id=? AND revoked_at IS NULL RETURNING id').bind(now, who.class_run_id, who.student_id).all();
  const jobs = await db.prepare("UPDATE classroom_report_jobs SET state='withdrawn',reason=?,draft_digest='',summary_json='{}',lease_expires_at=0,revision=revision+1,updated_at=? WHERE class_run_id=? AND student_id=? AND state<>'withdrawn' RETURNING id").bind(reason, now, who.class_run_id, who.student_id).all();
  const outbox = await db.prepare("UPDATE classroom_job_outbox SET state='cancelled',processed_at=? WHERE kind='report_input' AND state='pending' AND json_extract(payload_json,'$.class_run_id')=? AND json_extract(payload_json,'$.student_id')=? RETURNING id").bind(now, who.class_run_id, who.student_id).all();
  await db.prepare("UPDATE classroom_collect_items SET state='withdrawn',reason=?,manifest_digest='',receipt_id='',updated_at=? WHERE student_id=? AND batch_id IN (SELECT id FROM classroom_collect_batches WHERE class_run_id=?)").bind(reason, now, who.student_id, who.class_run_id).run();
  const sent = await db.prepare("SELECT count(*) AS n FROM classroom_report_deliveries WHERE class_run_id=? AND student_id=? AND state IN ('provider_accepted','delivered','send_unknown')").bind(who.class_run_id, who.student_id).first<{ n: number }>();
  // Content last, after nothing points at it any more. A failure here leaves the log at `started`; the same call (or recovery) finishes it.
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
/** One bounded pass. `now` is a parameter so the clock can be faked. Safe to run again: a learner who is already in the erasure ledger is never selected. */
export async function runClassroomRetention(env: Env, now: number, limit = 50): Promise<RetentionTick> {
  const cfg = retentionConfig(env), tick: RetentionTick = { mode: cfg.mode, days: cfg.days, ...(cfg.problem ? { problem: cfg.problem } : {}), due_runs: 0, due_learners: 0, erased: 0, failed: 0, remaining: 0 };
  if (cfg.mode === 'off' || cfg.days === null) return tick;
  const cutoff = now - cfg.days * 86_400_000, db = env.HPS_DB;
  // Learners of runs whose retention period is over and for whom no erasure was ever requested. One that is already in
  // the ledger — finished or interrupted, for any reason — belongs to runClassroomErasureRecovery, not to this pass.
  const due = ((await db.prepare(`SELECT DISTINCT o.class_run_id,o.cohort_id,i.student_id FROM class_run_ops o JOIN classroom_collect_batches x ON x.class_run_id=o.class_run_id JOIN classroom_collect_items i ON i.batch_id=x.id
 LEFT JOIN classroom_erasure_log l ON l.class_run_id=o.class_run_id AND l.student_id=i.student_id WHERE o.ends_at<=? AND l.state IS NULL ORDER BY o.ends_at,o.class_run_id,i.student_id`).bind(cutoff).all()).results ?? []) as Array<{ class_run_id: string; cohort_id: string; student_id: string }>;
  tick.due_learners = due.length; tick.due_runs = new Set(due.map((d) => d.class_run_id)).size;
  if (cfg.mode === 'dry-run') { tick.remaining = due.length; return tick; }
  for (const d of due.slice(0, limit)) {
    try { await eraseLearnerCollection(env, d, 'retention', { kind: 'system', id: 'retention' }, now); tick.erased++; }
    catch (err) { tick.failed++; console.error('classroom retention: erasure did not finish; recovery will retry it', d.class_run_id, (err as Error)?.name ?? 'error'); }
  }
  tick.remaining = due.length - tick.erased;
  return tick;
}

// ── recovery of erasures that were already requested (every scheduled tick; independent of retention) ──
/** Pause before the n-th retry of an interrupted erasure. The 15-minute tick is the finest grain there is. */
export const ERASURE_RETRY_STEPS_MS = [15 * 60_000, 60 * 60_000, 6 * 3_600_000, 24 * 3_600_000] as const;
/** After this many attempts recovery stops retrying by itself and says so; an operator repeats the request once the cause is fixed. */
export const MAX_ERASURE_ATTEMPTS = 12;
/**
 * A result write can only start while D1 still shows a live lease and no tombstone, and it is a single R2 request.
 * One full lease plus the provider timeout, doubled, is far longer than such a request can stay in flight.
 */
export const SETTLE_AFTER_MS = 2 * (LEASE_MS + 90_000);
export interface RecoveryTick { open: number; finished: number; failed: number; waiting: number; stalled: number; settled: number; late_objects: number; not_migrated?: true }
export async function runClassroomErasureRecovery(env: Env, now: number, limit = 25): Promise<RecoveryTick> {
  const db = env.HPS_DB, tick: RecoveryTick = { open: 0, finished: 0, failed: 0, waiting: 0, stalled: 0, settled: 0, late_objects: 0 };
  let rows: Array<{ class_run_id: string; student_id: string; cohort_id: string; reason: 'withdrawn' | 'retention'; state: string; attempts: number; last_error: string; updated_at: number }>;
  try {
    // Count/mark stalled work independently; it must never consume the runnable quota.
    const delay = `CASE WHEN l.state='done' THEN ${SETTLE_AFTER_MS} WHEN l.attempts<=1 THEN ${ERASURE_RETRY_STEPS_MS[0]} WHEN l.attempts=2 THEN ${ERASURE_RETRY_STEPS_MS[1]} WHEN l.attempts=3 THEN ${ERASURE_RETRY_STEPS_MS[2]} ELSE ${ERASURE_RETRY_STEPS_MS[3]} END`;
    const counts = await db.prepare(`SELECT COUNT(*) AS open, COALESCE(SUM(state='started' AND attempts>=?),0) AS stalled, COALESCE(SUM((state='done' OR attempts<?) AND updated_at+${delay}>?),0) AS waiting FROM classroom_erasure_log l WHERE state IN ('started','done')`).bind(MAX_ERASURE_ATTEMPTS, MAX_ERASURE_ATTEMPTS, now).first<{ open: number; stalled: number; waiting: number }>();
    Object.assign(tick, counts);
    const stalled = ((await db.prepare("SELECT class_run_id,student_id,attempts FROM classroom_erasure_log WHERE state='started' AND attempts>=? AND last_error!='retry_limit' ORDER BY updated_at LIMIT ?").bind(MAX_ERASURE_ATTEMPTS, limit).all()).results ?? []) as Array<{class_run_id: string; student_id: string; attempts: number}>;
    for (const r of stalled) await db.batch([
      db.prepare("INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) SELECT class_run_id,'','system','erasure-recovery','collection_erasure_stalled',?,? FROM classroom_erasure_log WHERE class_run_id=? AND student_id=? AND state='started' AND last_error!='retry_limit'").bind(JSON.stringify({ student_id: r.student_id, attempts: r.attempts }), now, r.class_run_id, r.student_id),
      db.prepare("UPDATE classroom_erasure_log SET last_error='retry_limit' WHERE class_run_id=? AND student_id=? AND state='started'").bind(r.class_run_id, r.student_id),
    ]);
    rows = ((await db.prepare(`SELECT l.class_run_id,l.student_id,o.cohort_id,l.reason,l.state,l.attempts,l.last_error,l.updated_at FROM classroom_erasure_log l JOIN class_run_ops o ON o.class_run_id=l.class_run_id WHERE (l.state='done' OR (l.state='started' AND l.attempts<?)) AND l.updated_at+${delay}<=? ORDER BY l.updated_at,l.class_run_id,l.student_id LIMIT ?`).bind(MAX_ERASURE_ATTEMPTS, now, limit).all()).results ?? []) as typeof rows;
  } catch (err) { if (/no such table/i.test(String((err as Error)?.message))) return { ...tick, not_migrated: true }; throw err; }
  for (const r of rows) {
    const who = { class_run_id: r.class_run_id, cohort_id: r.cohort_id, student_id: r.student_id };
    if (r.state === 'done') {
      try {
        const late = (await deletePrefix(env.HPS_TRACES, `classroom-snapshots/${who.cohort_id}/${who.class_run_id}/${who.student_id}/`)) + (await deletePrefix(env.HPS_TRACES, `classroom-reports/${who.cohort_id}/${who.class_run_id}/${who.student_id}/`));
        const stmts = [db.prepare("UPDATE classroom_erasure_log SET state='settled',last_error='',updated_at=? WHERE class_run_id=? AND student_id=? AND state='done'").bind(now, r.class_run_id, r.student_id)];
        if (late) stmts.push(db.prepare("INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) VALUES(?,'','system','erasure-recovery','collection_erased_late_objects',?,?)").bind(r.class_run_id, JSON.stringify({ student_id: r.student_id, objects: late }), now));
        await db.batch(stmts); tick.settled++; tick.late_objects += late;
      } catch { tick.failed++; } // stays `done`; the next tick looks again
      continue;
    }
    // The reason that was recorded is kept: a withdrawal is finished as a withdrawal, whatever retention is set to today.
    try { await eraseLearnerCollection(env, who, r.reason === 'retention' ? 'retention' : 'withdrawn', { kind: 'system', id: 'erasure-recovery' }, now); tick.finished++; }
    catch (err) { tick.failed++; console.error('classroom erasure recovery: still not finished', r.class_run_id, (err as Error)?.name ?? 'error'); }
  }
  return tick;
}
