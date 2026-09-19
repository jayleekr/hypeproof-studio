// Remote classroom operations R6 (#751): recipients, approval binding, delivery ledger, protected links.
//
//  - Recipients come from the operator's approved import only. Nothing infers a guardian
//    or an address from prompts, models, the gallery or upload lists.
//  - An approval is a hash over exactly what will be sent to whom: report draft digest,
//    recipient revision, channel, template. Change any of them and the approval is dead.
//  - The ledger row is committed before the adapter is called. A timeout is `send_unknown`
//    and stays that way until a provider event or an operator resolves it; it is never re-sent on a guess.
//  - No live provider is configured by this change. Without one, only dry-run can run.
import { Hono } from 'hono';
import type { Env } from '../env';
import { authorizeIssuerForOps, type IssuerAuthz } from '../lib/instructor-auth';
import { ID_RE, parseFlags, sha256Hex, type OpsCapability } from '../lib/classroom-ops';
import { composeReport, modelById } from '../lib/classroom-report';
import { APPROVAL_TTL_MS, EMAIL_RE, LINK_TTL_MS, TEMPLATE_RE, deliveryKey, dryRunAdapter, maskAddress, nextDeliveryState, type DeliveryAdapter } from '../lib/classroom-delivery';
import { opsEnabled } from './classroom-ops';

type Db = Env['HPS_DB'];
const json = async (c: any) => { try { return await c.req.json(); } catch { return null; } };
const audit = (db: Db, run: string, kind: string, id: string, action: string, detail: unknown, at: number) => db.prepare("INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) VALUES(?,'',?,?,?,?,?)").bind(run, kind, id, action, JSON.stringify(detail), at);
// Test seam: a sandbox adapter can be registered; production has none until an operator configures a provider.
const adapters = new Map<string, DeliveryAdapter>([[dryRunAdapter.id, dryRunAdapter]]);
export const registerDeliveryAdapter = (a: DeliveryAdapter) => adapters.set(a.id, a);

export const classroomDeliveryOperator = new Hono<{ Bindings: Env }>();
classroomDeliveryOperator.post('/classroom/recipients', async (c) => {
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!b || !ID_RE.test(b.class_run_id) || typeof b.source_ref !== 'string' || !/^[A-Za-z0-9_.:-]{4,128}$/.test(b.source_ref) || !Array.isArray(b.recipients) || !b.recipients.length || b.recipients.length > 400) return c.json({ error: 'class_run_id, source_ref and recipients[] required' }, 400);
  const seats = new Set((((await db.prepare('SELECT student_id FROM class_run_seats WHERE class_run_id=? AND replaced_at IS NULL').bind(b.class_run_id).all()).results ?? []) as Array<{ student_id: string }>).map((r) => r.student_id));
  for (const r of b.recipients) if (!r || !seats.has(r.student_id) || !ID_RE.test(r.recipient_ref ?? '') || r.channel !== 'email' || !EMAIL_RE.test(r.address ?? '')) return c.json({ error: 'each recipient needs a run student_id, recipient_ref, channel=email and a valid address', reason: 'recipient_invalid' }, 400);
  // Siblings sharing one guardian are separate rows: the unit is (child, recipient), never the address.
  await db.batch([...b.recipients.map((r: any) => db.prepare('INSERT INTO classroom_recipients(class_run_id,student_id,recipient_ref,channel,address,revision,source_ref,imported_by,imported_at) VALUES(?,?,?,?,?,1,?,?,?) ON CONFLICT(class_run_id,student_id,recipient_ref) DO UPDATE SET address=excluded.address,channel=excluded.channel,source_ref=excluded.source_ref,imported_at=excluded.imported_at,revision=CASE WHEN classroom_recipients.address<>excluded.address THEN classroom_recipients.revision+1 ELSE classroom_recipients.revision END').bind(b.class_run_id, r.student_id, r.recipient_ref, r.channel, r.address, b.source_ref, 'operator', now)),
    audit(db, b.class_run_id, 'operator', 'operator', 'recipients_imported', { count: b.recipients.length, source_ref: b.source_ref }, now)]);
  return c.json({ imported: b.recipients.length }, 201);
});
// Provider callbacks. Shared-secret header; duplicates are absorbed by the event id.
classroomDeliveryOperator.post('/classroom/delivery-events', async (c) => {
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!b || !/^[A-Za-z0-9_.:-]{4,128}$/.test(b.provider_event_id ?? '') || !/^[A-Za-z0-9_.:-]{4,128}$/.test(b.provider_message_id ?? '') || !['accepted', 'delivered', 'bounced'].includes(b.kind)) return c.json({ error: 'provider_event_id, provider_message_id and kind required' }, 400);
  const fresh = await db.prepare('INSERT INTO classroom_delivery_events(provider_event_id,provider_message_id,kind,received_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING RETURNING provider_event_id').bind(b.provider_event_id, b.provider_message_id, b.kind, now).first();
  if (!fresh) return c.json({ duplicate: true });
  const d = await db.prepare('SELECT delivery_key,state FROM classroom_report_deliveries WHERE provider_message_id=?').bind(b.provider_message_id).first<{ delivery_key: string; state: string }>();
  const next = d ? nextDeliveryState(d.state, b.kind) : null;
  if (d && next) await db.prepare('UPDATE classroom_report_deliveries SET state=?,updated_at=? WHERE delivery_key=? AND state=?').bind(next, now, d.delivery_key, d.state).run();
  return c.json({ applied: !!next, state: next ?? d?.state ?? 'unmatched' });
});

export const classroomDeliveryTeacher = new Hono<{ Bindings: Env }>();
const root = '/cohorts/:cohort/classroom/runs/:run/report-batches/:batch';
async function teacher(c: any, capability: OpsCapability): Promise<{ auth: IssuerAuthz; run: Record<string, any>; batch: Record<string, any> } | Response> {
  c.header('cache-control', 'no-store');
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const auth = await authorizeIssuerForOps(c, c.req.param('cohort'), capability);
  if (auth instanceof Response) return auth; if (!auth) return c.json({ error: 'instructor Bearer required' }, 401);
  const run = await c.env.HPS_DB.prepare('SELECT * FROM class_run_ops WHERE class_run_id=? AND cohort_id=?').bind(c.req.param('run'), c.req.param('cohort')).first();
  if (!run || !auth.scope.profiles.includes(run.profile_id)) return c.json({ error: 'class run not found in scope', reason: 'run_not_found' }, 404);
  if (!parseFlags(run.flags_json).ops_delivery) return c.json({ error: 'delivery is off for this run', reason: 'ops_delivery_disabled' }, 403);
  const batch = await c.env.HPS_DB.prepare('SELECT * FROM classroom_collect_batches WHERE id=? AND class_run_id=?').bind(c.req.param('batch'), run.class_run_id).first();
  return batch ? { auth, run, batch } : c.json({ error: 'batch not found' }, 404);
}
/** What would be sent, to whom — recomputed from live rows every time, so an approval can be checked against reality. */
async function currentScope(db: Db, batchId: string, runId: string, channel: string, template: string) {
  const rows = ((await db.prepare("SELECT j.id AS job_id,j.student_id,j.draft_digest,r.recipient_ref,r.revision AS recipient_revision,r.address FROM classroom_report_jobs j JOIN classroom_recipients r ON r.class_run_id=j.class_run_id AND r.student_id=j.student_id AND r.channel=? WHERE j.batch_id=? AND j.class_run_id=? AND j.state='approved' AND j.input_revision=(SELECT MAX(x.input_revision) FROM classroom_report_jobs x WHERE x.batch_id=j.batch_id AND x.student_id=j.student_id AND x.capability_model=j.capability_model) ORDER BY j.student_id,r.recipient_ref").bind(channel, batchId, runId).all()).results ?? []) as Array<{ job_id: string; student_id: string; draft_digest: string; recipient_ref: string; recipient_revision: number; address: string }>;
  const hash = await sha256Hex(JSON.stringify([channel, template, rows.map((r) => [r.job_id, r.draft_digest, r.recipient_ref, r.recipient_revision])]));
  return { rows, hash };
}
classroomDeliveryTeacher.get(root + '/recipients', async (c) => {
  const t = await teacher(c, 'review'); if (t instanceof Response) return t; const template = c.req.query('template_revision') ?? '';
  if (!TEMPLATE_RE.test(template)) return c.json({ error: 'template_revision required' }, 400);
  const s = await currentScope(c.env.HPS_DB, t.batch.id, t.run.class_run_id, 'email', template);
  const approved = new Set(s.rows.map((r) => r.student_id)), all = ((await c.env.HPS_DB.prepare("SELECT student_id,state FROM classroom_report_jobs WHERE batch_id=?").bind(t.batch.id).all()).results ?? []) as Array<{ student_id: string; state: string }>;
  // Addresses are masked for instructors. Learners with no approved report or no imported recipient are listed, not dropped.
  return c.json({ scope_hash: s.hash, channel: 'email', template_revision: template, will_send: s.rows.map((r) => ({ student_id: r.student_id, recipient_ref: r.recipient_ref, address: maskAddress(r.address), recipient_revision: r.recipient_revision, report_digest: r.draft_digest })), not_sending: [...new Set(all.map((j) => j.student_id))].filter((u) => !approved.has(u)).map((u) => ({ student_id: u, reason: all.some((j) => j.student_id === u && j.state === 'approved') ? 'no_approved_recipient' : 'no_approved_report' })), expected_messages: s.rows.length });
});
classroomDeliveryTeacher.post(root + '/approve', async (c) => {
  const t = await teacher(c, 'review'); if (t instanceof Response) return t; const b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!b || !TEMPLATE_RE.test(b.template_revision ?? '') || b.channel !== 'email' || typeof b.scope_hash !== 'string') return c.json({ error: 'template_revision, channel=email and scope_hash required' }, 400);
  const s = await currentScope(db, t.batch.id, t.run.class_run_id, b.channel, b.template_revision);
  if (!s.rows.length) return c.json({ error: 'nothing is ready to send', reason: 'empty_scope' }, 409);
  // The approver signs what they were shown. If reports or recipients moved since, they must look again.
  if (s.hash !== b.scope_hash) return c.json({ error: 'reports or recipients changed since this list was shown', reason: 'scope_changed', scope_hash: s.hash }, 409);
  const id = crypto.randomUUID();
  await db.batch([db.prepare('INSERT INTO classroom_delivery_approvals(id,batch_id,class_run_id,template_revision,channel,scope_hash,scope_json,approved_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id, t.batch.id, t.run.class_run_id, b.template_revision, b.channel, s.hash, JSON.stringify(s.rows.map((r) => [r.job_id, r.draft_digest, r.recipient_ref, r.recipient_revision])), t.auth.payload.u, now, now + APPROVAL_TTL_MS),
    audit(db, t.run.class_run_id, 'instructor', t.auth.payload.u, 'delivery_approved', { approval_id: id, scope_hash: s.hash, messages: s.rows.length }, now)]);
  return c.json({ approval_id: id, scope_hash: s.hash, messages: s.rows.length, expires_at: now + APPROVAL_TTL_MS }, 201);
});
classroomDeliveryTeacher.post(root + '/deliver', async (c) => {
  const t = await teacher(c, 'deliver'); if (t instanceof Response) return t; const b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!b || typeof b.approval_id !== 'string' || typeof b.dry_run !== 'boolean') return c.json({ error: 'approval_id and dry_run required' }, 400);
  const ap = await db.prepare('SELECT * FROM classroom_delivery_approvals WHERE id=? AND batch_id=?').bind(b.approval_id, t.batch.id).first<Record<string, any>>();
  if (!ap || ap.revoked_at) return c.json({ error: 'approval not found', reason: 'approval_missing' }, 404);
  if (ap.expires_at <= now) return c.json({ error: 'approval expired; approve again', reason: 'approval_expired' }, 409);
  const s = await currentScope(db, t.batch.id, t.run.class_run_id, ap.channel, ap.template_revision);
  if (s.hash !== ap.scope_hash) return c.json({ error: 'a report or recipient changed after approval; nothing was sent', reason: 'approval_stale' }, 409);
  const adapter = b.dry_run ? dryRunAdapter : adapters.get(c.env.HPS_DELIVERY_PROVIDER ?? '');
  if (!adapter) return c.json({ error: 'no live delivery account is configured; only dry_run is available', reason: 'delivery_provider_not_configured' }, 409);
  const results = [];
  for (const r of s.rows) {
    // One logical message (lib/classroom-delivery.ts deliveryKey). The same message again is a replay; a sibling is not.
    const key = await deliveryKey({ class_run_id: t.run.class_run_id, batch_id: t.batch.id, job_id: r.job_id, student_id: r.student_id, draft_digest: r.draft_digest, recipient_ref: r.recipient_ref, recipient_revision: r.recipient_revision, channel: ap.channel, template_revision: ap.template_revision, live: adapter.external });
    // Ledger first. Only the writer that created the row may call the adapter: retries and replays find the row and stop.
    const mine = await db.prepare("INSERT INTO classroom_report_deliveries(delivery_key,batch_id,class_run_id,student_id,recipient_ref,job_id,report_digest,recipient_revision,channel,template_revision,approval_id,adapter,state,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'sending',1,?,?) ON CONFLICT(delivery_key) DO NOTHING RETURNING delivery_key").bind(key, t.batch.id, t.run.class_run_id, r.student_id, r.recipient_ref, r.job_id, r.draft_digest, r.recipient_revision, ap.channel, ap.template_revision, ap.id, adapter.id, now, now).first();
    if (!mine) { const prior = await db.prepare('SELECT state FROM classroom_report_deliveries WHERE delivery_key=?').bind(key).first<{ state: string }>(); results.push({ student_id: r.student_id, recipient_ref: r.recipient_ref, state: prior?.state, replay: true }); continue; }
    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, ''), linkId = crypto.randomUUID();
    await db.prepare('INSERT INTO classroom_report_links(id,token_hash,job_id,class_run_id,student_id,recipient_ref,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(linkId, await sha256Hex(token), r.job_id, t.run.class_run_id, r.student_id, r.recipient_ref, now, now + LINK_TTL_MS).run();
    let out; try { out = await adapter.send({ to: r.address, link: `/v1/classroom/report-links/${token}`, template_revision: ap.template_revision, idempotency_key: key }); } catch { out = { status: 'unknown' as const }; }
    const state = out.status === 'accepted' ? 'provider_accepted' : out.status === 'unknown' ? 'send_unknown' : out.reason === 'dry_run' ? 'dry_run' : 'failed';
    await db.prepare('UPDATE classroom_report_deliveries SET state=?,provider_message_id=?,link_id=?,detail=?,updated_at=? WHERE delivery_key=?').bind(state, out.status === 'accepted' ? out.provider_message_id : '', linkId, out.status === 'rejected' ? out.reason.slice(0, 64) : '', Date.now(), key).run();
    results.push({ student_id: r.student_id, recipient_ref: r.recipient_ref, state });
  }
  await audit(db, t.run.class_run_id, 'instructor', t.auth.payload.u, b.dry_run ? 'delivery_dry_run' : 'delivery_requested', { approval_id: ap.id, adapter: adapter.id, messages: results.length }, now).run();
  return c.json({ adapter: adapter.id, external_sends: adapter.external ? results.filter((r) => !r.replay).length : 0, results, note: 'provider_accepted is not delivered; delivered is not read' }, 202);
});
classroomDeliveryTeacher.get(root + '/deliveries', async (c) => {
  const t = await teacher(c, 'review'); if (t instanceof Response) return t;
  const rows = ((await c.env.HPS_DB.prepare('SELECT delivery_key,student_id,recipient_ref,state,adapter,attempts,detail,updated_at FROM classroom_report_deliveries WHERE batch_id=? ORDER BY student_id').bind(t.batch.id).all()).results ?? []) as Array<Record<string, any>>;
  const by: Record<string, number> = {}; for (const r of rows) by[r.state] = (by[r.state] ?? 0) + 1;
  return c.json({ summary: { messages: rows.length, by_state: by, needs_operator: by.send_unknown ?? 0 }, deliveries: rows });
});
// An unknown send is settled by a person who checked the provider — never by sending again to find out.
classroomDeliveryTeacher.post(root + '/deliveries/:key/resolve', async (c) => {
  const t = await teacher(c, 'deliver'); if (t instanceof Response) return t; const b = await json(c), now = Date.now();
  if (!b || !['provider_accepted', 'failed'].includes(b.outcome) || typeof b.checked_ref !== 'string' || b.checked_ref.length < 4) return c.json({ error: 'outcome and checked_ref (what was looked up at the provider) required' }, 400);
  const r = await c.env.HPS_DB.prepare("UPDATE classroom_report_deliveries SET state=?,provider_message_id=CASE WHEN ?<>'' THEN ? ELSE provider_message_id END,detail=?,updated_at=? WHERE delivery_key=? AND batch_id=? AND state='send_unknown' RETURNING state").bind(b.outcome, b.provider_message_id ?? '', b.provider_message_id ?? '', 'resolved:' + b.checked_ref.slice(0, 48), now, c.req.param('key'), t.batch.id).first();
  if (!r) return c.json({ error: 'only an unknown send can be resolved', reason: 'not_unknown' }, 409);
  await audit(c.env.HPS_DB, t.run.class_run_id, 'instructor', t.auth.payload.u, 'delivery_resolved', { delivery_key: c.req.param('key'), outcome: b.outcome }, now).run(); return c.json(r);
});
classroomDeliveryTeacher.delete(root + '/deliveries/:key/link', async (c) => {
  const t = await teacher(c, 'deliver'); if (t instanceof Response) return t; const now = Date.now();
  const r = await c.env.HPS_DB.prepare('UPDATE classroom_report_links SET revoked_at=? WHERE id=(SELECT link_id FROM classroom_report_deliveries WHERE delivery_key=? AND batch_id=?) AND revoked_at IS NULL RETURNING id').bind(now, c.req.param('key'), t.batch.id).first();
  return r ? c.json({ revoked: true }) : c.json({ error: 'link not found or already revoked' }, 404);
});

// ── protected link (bearer of an opaque, short-lived token). It proves possession of the message, not who the reader is. ──
export const classroomReportLinks = new Hono<{ Bindings: Env }>();
classroomReportLinks.get('/:token', async (c) => {
  c.header('cache-control', 'no-store'); c.header('referrer-policy', 'no-referrer');
  if (!opsEnabled(c.env)) return c.json({ error: 'not found' }, 404);
  const db = c.env.HPS_DB, now = Date.now(), token = c.req.param('token');
  const link = /^[A-Za-z0-9-]{40,80}$/.test(token) ? await db.prepare('SELECT * FROM classroom_report_links WHERE token_hash=?').bind(await sha256Hex(token)).first<Record<string, any>>() : null;
  // One answer for unknown, expired and revoked.
  if (!link || link.revoked_at || link.expires_at <= now) return c.json({ error: 'this link is not available. Ask the class operator for a new one.' }, 404);
  const job = await db.prepare("SELECT * FROM classroom_report_jobs WHERE id=? AND state='approved'").bind(link.job_id).first<Record<string, any>>();
  if (!job) return c.json({ error: 'this link is not available. Ask the class operator for a new one.' }, 404);
  await db.batch([db.prepare('UPDATE classroom_report_links SET views=views+1 WHERE id=?').bind(link.id), audit(db, link.class_run_id, 'recipient', link.recipient_ref, 'report_link_viewed', { link_id: link.id }, now)]);
  const obj = await c.env.HPS_TRACES.get(`classroom-reports/${job.cohort_id}/${job.class_run_id}/${job.student_id}/${job.id}/draft.json`); if (!obj) return c.json({ error: 'this link is not available. Ask the class operator for a new one.' }, 404);
  return c.json({ report: composeReport(JSON.parse(await obj.text()), { class_runs_with_evidence: 1, coverage: job.input_coverage, model: modelById(job.capability_model)! }) });
});
