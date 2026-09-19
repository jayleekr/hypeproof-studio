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
  await db.prepare('INSERT INTO classroom_collect_tombstones(class_run_id,student_id,reason,created_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').bind(who.class_run_id, who.student_id, reason, actor.kind, now).run();
  const links = await db.prepare('UPDATE classroom_report_links SET revoked_at=? WHERE class_run_id=? AND student_id=? AND revoked_at IS NULL RETURNING id').bind(now, who.class_run_id, who.student_id).all();
  const jobs = await db.prepare("UPDATE classroom_report_jobs SET state='withdrawn',reason=?,draft_digest='',summary_json='{}',lease_expires_at=0,revision=revision+1,updated_at=? WHERE class_run_id=? AND student_id=? AND state<>'withdrawn' RETURNING id").bind(reason, now, who.class_run_id, who.student_id).all();
  const outbox = await db.prepare("UPDATE classroom_job_outbox SET state='cancelled',processed_at=? WHERE kind='report_input' AND state='pending' AND json_extract(payload_json,'$.class_run_id')=? AND json_extract(payload_json,'$.student_id')=? RETURNING id").bind(now, who.class_run_id, who.student_id).all();
  await db.prepare("UPDATE classroom_collect_items SET state='withdrawn',reason=?,manifest_digest='',receipt_id='',updated_at=? WHERE student_id=? AND batch_id IN (SELECT id FROM classroom_collect_batches WHERE class_run_id=?)").bind(reason, now, who.student_id, who.class_run_id).run();
  const sent = await db.prepare("SELECT count(*) AS n FROM classroom_report_deliveries WHERE class_run_id=? AND student_id=? AND state IN ('provider_accepted','delivered','send_unknown')").bind(who.class_run_id, who.student_id).first<{ n: number }>();
  // Content last, after nothing points at it any more. A failure here leaves orphans that the next run of the same call removes.
  const snapshot_objects = await deletePrefix(env.HPS_TRACES, `classroom-snapshots/${who.cohort_id}/${who.class_run_id}/${who.student_id}/`);
  const report_objects = await deletePrefix(env.HPS_TRACES, `classroom-reports/${who.cohort_id}/${who.class_run_id}/${who.student_id}/`);
  const result: ErasureResult = { snapshot_objects, report_objects, links_revoked: (links.results ?? []).length, jobs_closed: (jobs.results ?? []).length, outbox_cancelled: (outbox.results ?? []).length, deliveries_already_sent: sent?.n ?? 0 };
  await db.prepare("INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) VALUES(?,'',?,?,?,?,?)").bind(who.class_run_id, actor.kind, actor.id, 'collection_erased', JSON.stringify({ student_id: who.student_id, reason, ...result }), now).run();
  return result;
}
