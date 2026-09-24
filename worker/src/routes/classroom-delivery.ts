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
import { composeReport, draftKey, modelById } from '../lib/classroom-report';
import { REPORT_PAGE_CSP, renderReportHtml } from '../lib/classroom-report-html';
import { APPROVAL_TTL_MS, EMAIL_RE, LINK_TTL_MS, MAX_VIEWER_ATTEMPTS, TEMPLATE_RE, VIEWER_CHECK_KINDS, VIEWER_CHECK_PROMPT, deliveryKey, dryRunAdapter, maskAddress, nextDeliveryState, sameHash, viewerCheckHash, type DeliveryAdapter, type ViewerCheckKind } from '../lib/classroom-delivery';
import { EMAIL_TEMPLATES, resendAdapter, resendConfigured, resendEventKind, verifySvix } from '../lib/classroom-delivery-resend';
import { opsEnabled } from './classroom-ops';
import { batchScope, scopeRefusal } from './classroom-collect';

type Db = Env['HPS_DB'];
const json = async (c: any) => { try { return await c.req.json(); } catch { return null; } };
const audit = (db: Db, run: string, kind: string, id: string, action: string, detail: unknown, at: number) => db.prepare("INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) VALUES(?,'',?,?,?,?,?)").bind(run, kind, id, action, JSON.stringify(detail), at);
// Test seam: a sandbox adapter can be registered; production has none until an operator configures a provider.
const adapters = new Map<string, DeliveryAdapter>([[dryRunAdapter.id, dryRunAdapter]]);
export const registerDeliveryAdapter = (a: DeliveryAdapter) => adapters.set(a.id, a);
/** Test seam only: the transport of the live adapter. Production uses global fetch. */
let resendFetch: typeof fetch | undefined;
export const setResendFetch = (f: typeof fetch | undefined) => { resendFetch = f; };
/** The live adapter exists only when the provider, its key, a sender and the public origin are ALL configured. */
const liveAdapter = (env: Env): DeliveryAdapter | undefined => (env.HPS_DELIVERY_PROVIDER === 'resend' ? (resendConfigured(env) ? resendAdapter(env, resendFetch) : undefined) : adapters.get(env.HPS_DELIVERY_PROVIDER ?? ''));

/**
 * Apply one provider event to the ledger. Forward-only (nextDeliveryState), so a late `sent` after `delivered` changes
 * nothing, and an event for a send whose HTTP answer was lost (`send_unknown`) settles it through the delivery_key tag.
 */
async function applyProviderEvent(db: Db, e: { event_id: string; message_id: string; kind: 'accepted' | 'delivered' | 'bounced'; delivery_key?: string }, now: number) {
  const fresh = await db.prepare('INSERT INTO classroom_delivery_events(provider_event_id,provider_message_id,kind,received_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING RETURNING provider_event_id').bind(e.event_id, e.message_id, e.kind, now).first();
  if (!fresh) return { duplicate: true as const };
  let d = await db.prepare('SELECT delivery_key,state FROM classroom_report_deliveries WHERE provider_message_id=?').bind(e.message_id).first<{ delivery_key: string; state: string }>();
  if (!d && e.delivery_key) {
    // Only a send that is genuinely unresolved may be claimed by its key; a row that already has another message id is left alone.
    d = await db.prepare("UPDATE classroom_report_deliveries SET provider_message_id=?,detail='settled_by_provider_event',updated_at=? WHERE delivery_key=? AND provider_message_id='' AND state IN ('send_unknown','sending') RETURNING delivery_key,state").bind(e.message_id, now, e.delivery_key).first<{ delivery_key: string; state: string }>();
  }
  const next = d ? nextDeliveryState(d.state, e.kind) : null;
  if (d && next) await db.prepare('UPDATE classroom_report_deliveries SET state=?,updated_at=? WHERE delivery_key=? AND state=?').bind(next, now, d.delivery_key, d.state).run();
  return { duplicate: false as const, applied: !!next, state: next ?? d?.state ?? 'unmatched' };
}

export const classroomDeliveryOperator = new Hono<{ Bindings: Env }>();
classroomDeliveryOperator.post('/classroom/recipients', async (c) => {
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!b || !ID_RE.test(b.class_run_id) || typeof b.source_ref !== 'string' || !/^[A-Za-z0-9_.:-]{4,128}$/.test(b.source_ref) || !Array.isArray(b.recipients) || !b.recipients.length || b.recipients.length > 400) return c.json({ error: 'class_run_id, source_ref and recipients[] required' }, 400);
  const seats = new Set((((await db.prepare('SELECT student_id FROM class_run_seats WHERE class_run_id=? AND replaced_at IS NULL').bind(b.class_run_id).all()).results ?? []) as Array<{ student_id: string }>).map((r) => r.student_id));
  for (const r of b.recipients) if (!r || !seats.has(r.student_id) || !ID_RE.test(r.recipient_ref ?? '') || r.channel !== 'email' || !EMAIL_RE.test(r.address ?? '')) return c.json({ error: 'each recipient needs a run student_id, recipient_ref, channel=email and a valid address', reason: 'recipient_invalid' }, 400);
  // The viewer check is agreed with the recipient out of band and arrives with the list. It is hashed here and never stored, logged or echoed.
  for (const r of b.recipients) if (r.viewer_check !== undefined && (!r.viewer_check || !Object.hasOwn(VIEWER_CHECK_KINDS, r.viewer_check.kind) || typeof r.viewer_check.value !== 'string' || !VIEWER_CHECK_KINDS[r.viewer_check.kind as ViewerCheckKind].test(r.viewer_check.value.trim()))) return c.json({ error: 'viewer_check needs kind (phone_last4 | birth_mmdd | passphrase) and a value of that shape', reason: 'viewer_check_invalid' }, 400);
  const checks = []; for (const r of b.recipients) if (r.viewer_check) { const salt = crypto.randomUUID(), hash = await viewerCheckHash(c.env.HPS_SIGNING_SECRET, salt, r.viewer_check.kind, r.viewer_check.value); checks.push(db.prepare('INSERT INTO classroom_recipient_checks(class_run_id,student_id,recipient_ref,kind,salt,check_hash,revision,updated_at) VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(class_run_id,student_id,recipient_ref) DO UPDATE SET kind=excluded.kind,salt=excluded.salt,check_hash=excluded.check_hash,revision=classroom_recipient_checks.revision+1,updated_at=excluded.updated_at').bind(b.class_run_id, r.student_id, r.recipient_ref, r.viewer_check.kind, salt, hash, now)); }
  // Siblings sharing one guardian are separate rows: the unit is (child, recipient), never the address.
  await db.batch([...b.recipients.map((r: any) => db.prepare('INSERT INTO classroom_recipients(class_run_id,student_id,recipient_ref,channel,address,revision,source_ref,imported_by,imported_at) VALUES(?,?,?,?,?,1,?,?,?) ON CONFLICT(class_run_id,student_id,recipient_ref) DO UPDATE SET address=excluded.address,channel=excluded.channel,source_ref=excluded.source_ref,imported_at=excluded.imported_at,revision=CASE WHEN classroom_recipients.address<>excluded.address THEN classroom_recipients.revision+1 ELSE classroom_recipients.revision END').bind(b.class_run_id, r.student_id, r.recipient_ref, r.channel, r.address, b.source_ref, 'operator', now)),
    ...checks,
    audit(db, b.class_run_id, 'operator', 'operator', 'recipients_imported', { count: b.recipients.length, viewer_checks: checks.length, source_ref: b.source_ref }, now)]);
  return c.json({ imported: b.recipients.length, viewer_checks: checks.length }, 201);
});
// Manual entry by an operator who looked the message up at the provider (admin auth). Signed provider callbacks have their own route below.
classroomDeliveryOperator.post('/classroom/delivery-events', async (c) => {
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!b || !/^[A-Za-z0-9_.:-]{4,128}$/.test(b.provider_event_id ?? '') || !/^[A-Za-z0-9_.:-]{4,128}$/.test(b.provider_message_id ?? '') || !['accepted', 'delivered', 'bounced'].includes(b.kind)) return c.json({ error: 'provider_event_id, provider_message_id and kind required' }, 400);
  const r = await applyProviderEvent(db, { event_id: b.provider_event_id, message_id: b.provider_message_id, kind: b.kind }, now);
  return c.json(r.duplicate ? { duplicate: true } : { applied: r.applied, state: r.state });
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
  if (!batch) return c.json({ error: 'batch not found' }, 404);
  // Selected collection is collection only (#751 U1): nothing collected that way can be sent.
  let scope; try { scope = await batchScope(c.env.HPS_DB, String(batch.id)); } catch (err) { const no = scopeRefusal(c, err); if (no) return no; throw err; }
  if (scope.mode === 'collect_only') return c.json({ error: 'this batch collected records only; evaluation and delivery belong to the class wrap-up', reason: 'collect_only_batch' }, 409);
  return { auth, run, batch };
}
/** What would be sent, to whom — recomputed from live rows every time, so an approval can be checked against reality. */
async function currentScope(db: Db, batchId: string, runId: string, channel: string, template: string) {
  const rows = ((await db.prepare("SELECT j.id AS job_id,j.student_id,j.draft_digest,r.recipient_ref,r.revision AS recipient_revision,r.address,COALESCE(k.revision,0) AS check_revision FROM classroom_report_jobs j JOIN classroom_recipients r ON r.class_run_id=j.class_run_id AND r.student_id=j.student_id AND r.channel=? LEFT JOIN classroom_recipient_checks k ON k.class_run_id=r.class_run_id AND k.student_id=r.student_id AND k.recipient_ref=r.recipient_ref WHERE j.batch_id=? AND j.class_run_id=? AND j.state='approved' AND j.input_revision=(SELECT MAX(x.input_revision) FROM classroom_report_jobs x WHERE x.batch_id=j.batch_id AND x.student_id=j.student_id AND x.capability_model=j.capability_model) ORDER BY j.student_id,r.recipient_ref").bind(channel, batchId, runId).all()).results ?? []) as Array<{ job_id: string; student_id: string; draft_digest: string; recipient_ref: string; recipient_revision: number; address: string; check_revision: number }>;
  // A changed or removed viewer check is a changed delivery: the approval no longer matches.
  const hash = await sha256Hex(JSON.stringify([channel, template, rows.map((r) => [r.job_id, r.draft_digest, r.recipient_ref, r.recipient_revision, r.check_revision])]));
  return { rows, hash };
}
classroomDeliveryTeacher.get(root + '/recipients', async (c) => {
  const t = await teacher(c, 'review'); if (t instanceof Response) return t; const template = c.req.query('template_revision') ?? '';
  if (!TEMPLATE_RE.test(template)) return c.json({ error: 'template_revision required' }, 400);
  const s = await currentScope(c.env.HPS_DB, t.batch.id, t.run.class_run_id, 'email', template);
  const approved = new Set(s.rows.map((r) => r.student_id)), all = ((await c.env.HPS_DB.prepare("SELECT student_id,state FROM classroom_report_jobs WHERE batch_id=?").bind(t.batch.id).all()).results ?? []) as Array<{ student_id: string; state: string }>;
  // Addresses are masked for instructors. Learners with no approved report or no imported recipient are listed, not dropped.
  return c.json({ scope_hash: s.hash, channel: 'email', template_revision: template, will_send: s.rows.map((r) => ({ student_id: r.student_id, recipient_ref: r.recipient_ref, address: maskAddress(r.address), recipient_revision: r.recipient_revision, report_digest: r.draft_digest, viewer_check: r.check_revision ? 'set' : 'missing' })), live_send_blocked: s.rows.filter((r) => !r.check_revision).length, not_sending: [...new Set(all.map((j) => j.student_id))].filter((u) => !approved.has(u)).map((u) => ({ student_id: u, reason: all.some((j) => j.student_id === u && j.state === 'approved') ? 'no_approved_recipient' : 'no_approved_report' })), expected_messages: s.rows.length });
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
  const adapter = b.dry_run ? dryRunAdapter : liveAdapter(c.env);
  if (!adapter) return c.json({ error: 'no live delivery account is configured; only dry_run is available', reason: 'delivery_provider_not_configured' }, 409);
  // A live send needs reviewed wording: an unknown template revision is refused before anything is written.
  if (adapter.id === 'resend' && !EMAIL_TEMPLATES[ap.template_revision]) return c.json({ error: 'this template revision is not a reviewed email template', reason: 'template_unknown', templates: Object.keys(EMAIL_TEMPLATES) }, 409);
  const results = [];
  for (const r of s.rows) {
    // A report leaves for a real address only if the reader will have to prove more than possession of the link.
    if (adapter.external && !r.check_revision) { results.push({ student_id: r.student_id, recipient_ref: r.recipient_ref, state: 'not_sent_viewer_check_missing' }); continue; }
    // One logical message (lib/classroom-delivery.ts deliveryKey). The same message again is a replay; a sibling is not.
    const key = await deliveryKey({ class_run_id: t.run.class_run_id, batch_id: t.batch.id, job_id: r.job_id, student_id: r.student_id, draft_digest: r.draft_digest, recipient_ref: r.recipient_ref, recipient_revision: r.recipient_revision, channel: ap.channel, template_revision: ap.template_revision, live: adapter.external });
    // Ledger first. Only the writer that created the row may call the adapter: retries and replays find the row and stop.
    const mine = await db.prepare("INSERT INTO classroom_report_deliveries(delivery_key,batch_id,class_run_id,student_id,recipient_ref,job_id,report_digest,recipient_revision,channel,template_revision,approval_id,adapter,state,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'sending',1,?,?) ON CONFLICT(delivery_key) DO NOTHING RETURNING delivery_key").bind(key, t.batch.id, t.run.class_run_id, r.student_id, r.recipient_ref, r.job_id, r.draft_digest, r.recipient_revision, ap.channel, ap.template_revision, ap.id, adapter.id, now, now).first();
    if (!mine) {
      const prior = await db.prepare('SELECT state,link_id FROM classroom_report_deliveries WHERE delivery_key=?').bind(key).first<{ state: string; link_id: string }>();
      // `failed` means the provider definitely did not take it (validation, auth, rate limit): that one message may be tried again,
      // by the single writer that wins this CAS. Everything else — accepted, delivered, and above all send_unknown — is a replay.
      const retry = prior?.state === 'failed' ? await db.prepare("UPDATE classroom_report_deliveries SET state='sending',attempts=attempts+1,approval_id=?,updated_at=? WHERE delivery_key=? AND state='failed' RETURNING link_id").bind(ap.id, now, key).first<{ link_id: string }>() : null;
      if (!retry) { results.push({ student_id: r.student_id, recipient_ref: r.recipient_ref, state: prior?.state, replay: true }); continue; }
      if (retry.link_id) await db.prepare('UPDATE classroom_report_links SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(now, retry.link_id).run(); // the token of the failed attempt was never delivered
    }
    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, ''), linkId = crypto.randomUUID();
    await db.prepare('INSERT INTO classroom_report_links(id,token_hash,job_id,class_run_id,student_id,recipient_ref,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(linkId, await sha256Hex(token), r.job_id, t.run.class_run_id, r.student_id, r.recipient_ref, now, now + LINK_TTL_MS).run();
    await db.prepare("UPDATE classroom_report_deliveries SET link_id=? WHERE delivery_key=? AND state='sending'").bind(linkId, key).run();
    let out; try { out = await adapter.send({ to: r.address, link: `/v1/classroom/report-links/${token}`, template_revision: ap.template_revision, idempotency_key: key }); } catch { out = { status: 'unknown' as const }; }
    const state = out.status === 'accepted' ? 'provider_accepted' : out.status === 'unknown' ? 'send_unknown' : out.reason === 'dry_run' ? 'dry_run' : 'failed';
    // A signed provider event can settle this row while send() is still in flight.
    // Only the still-sending writer may apply its HTTP result; terminal evidence wins.
    const applied = await db.prepare("UPDATE classroom_report_deliveries SET state=?,provider_message_id=CASE WHEN provider_message_id='' THEN ? ELSE provider_message_id END,link_id=?,detail=?,updated_at=? WHERE delivery_key=? AND state='sending' RETURNING state").bind(state, out.status === 'accepted' ? out.provider_message_id : '', linkId, out.status === 'rejected' ? out.reason.slice(0, 64) : '', Date.now(), key).first<{ state: string }>();
    const finalState = applied?.state ?? (await db.prepare('SELECT state FROM classroom_report_deliveries WHERE delivery_key=?').bind(key).first<{ state: string }>())?.state ?? 'send_unknown';
    results.push({ student_id: r.student_id, recipient_ref: r.recipient_ref, state: finalState });
  }
  await audit(db, t.run.class_run_id, 'instructor', t.auth.payload.u, b.dry_run ? 'delivery_dry_run' : 'delivery_requested', { approval_id: ap.id, adapter: adapter.id, messages: results.length }, now).run();
  return c.json({ adapter: adapter.id, external_sends: adapter.external ? results.filter((r) => !r.replay && r.state !== 'not_sent_viewer_check_missing').length : 0, results, note: 'provider_accepted is not delivered; delivered is not read' }, 202);
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
const NOT_AVAILABLE = 'this link is not available. Ask the class operator for a new one.';
const checkPage = (prompt: string, message: string, status: number) => new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>수업 관찰 보고서 열기</title><style>:root{color-scheme:dark}body{margin:0;background:#151D19;color:#F2F4E8;font:1rem/1.7 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}main{max-width:28rem;margin:0 auto;padding:2rem 1.25rem}form{background:#202C24;border-radius:.75rem;padding:1.25rem}label{display:block;margin-bottom:.5rem}input{width:100%;font:inherit;color:inherit;background:#1A241E;border:1px solid #8A9A86;border-radius:.45rem;padding:.7rem;min-height:44px}button{margin-top:1rem;width:100%;font:inherit;font-weight:600;min-height:44px;border-radius:.45rem;border:1px solid #D5F279;background:#D5F279;color:#151D19;cursor:pointer}:focus-visible{outline:.2rem solid #D5F279;outline-offset:.15rem}.msg{color:#E6A373}p{color:#B9C2B0}</style></head><body><main><h1>수업 관찰 보고서</h1><form method="post" autocomplete="off"><label for="check">${prompt}</label><input id="check" name="check" inputmode="${/자리/.test(prompt) ? 'numeric' : 'text'}" required autofocus>${message ? `<p class="msg" role="alert">${message}</p>` : ''}<button type="submit">보고서 열기</button></form><p>이 확인은 메일이 다른 사람에게 전달됐을 때 보고서를 보호하기 위한 것입니다. 값을 모르면 수업 운영자에게 문의하세요.</p></main></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': REPORT_PAGE_CSP, 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' } });
async function openLink(c: any, supplied: string | null): Promise<Response> {
  c.header('cache-control', 'no-store'); c.header('referrer-policy', 'no-referrer');
  if (!opsEnabled(c.env)) return c.json({ error: 'not found' }, 404);
  const db: Db = c.env.HPS_DB, now = Date.now(), token = c.req.param('token'), wantsJson = c.req.query('format') === 'json';
  const link = /^[A-Za-z0-9-]{40,80}$/.test(token) ? await db.prepare('SELECT * FROM classroom_report_links WHERE token_hash=?').bind(await sha256Hex(token)).first<Record<string, any>>() : null;
  // One answer for unknown, expired, revoked and locked.
  if (!link || link.revoked_at || link.expires_at <= now) return c.json({ error: NOT_AVAILABLE }, 404);
  const job = await db.prepare("SELECT * FROM classroom_report_jobs WHERE id=? AND state='approved'").bind(link.job_id).first<Record<string, any>>();
  if (!job) return c.json({ error: NOT_AVAILABLE }, 404);
  const check = await db.prepare('SELECT kind,salt,check_hash FROM classroom_recipient_checks WHERE class_run_id=? AND student_id=? AND recipient_ref=?').bind(link.class_run_id, link.student_id, link.recipient_ref).first<{ kind: ViewerCheckKind; salt: string; check_hash: string }>();
  if (check) {
    const tries = await db.prepare('SELECT failed,locked_at FROM classroom_link_attempts WHERE link_id=?').bind(link.id).first<{ failed: number; locked_at: number | null }>();
    if (tries?.locked_at) return c.json({ error: NOT_AVAILABLE }, 404);
    const prompt = VIEWER_CHECK_PROMPT[check.kind] ?? VIEWER_CHECK_PROMPT.passphrase;
    if (supplied === null) return wantsJson ? c.json({ error: 'viewer check required', reason: 'viewer_check_required', kind: check.kind }, 401) : checkPage(prompt, '', 200);
    // Reserve a guess before hashing: at most five failed or in-flight guesses.
    // A successful check releases its reservation; failures cannot lose increments.
    const reserved = await db.prepare("INSERT INTO classroom_link_attempts(link_id,failed,locked_at,updated_at) VALUES(?,1,NULL,?) ON CONFLICT(link_id) DO UPDATE SET failed=classroom_link_attempts.failed+1,updated_at=excluded.updated_at WHERE classroom_link_attempts.locked_at IS NULL AND classroom_link_attempts.failed<? RETURNING failed").bind(link.id, now, MAX_VIEWER_ATTEMPTS).first<{ failed: number }>();
    if (!reserved) return c.json({ error: NOT_AVAILABLE }, 404);
    if (!sameHash(await viewerCheckHash(c.env.HPS_SIGNING_SECRET, check.salt, check.kind, supplied.slice(0, 128)), check.check_hash)) {
      const result = await db.prepare("UPDATE classroom_link_attempts SET locked_at=CASE WHEN failed>=? THEN COALESCE(locked_at,?) ELSE locked_at END,updated_at=? WHERE link_id=? RETURNING failed,locked_at").bind(MAX_VIEWER_ATTEMPTS, now, now, link.id).first<{ failed: number; locked_at: number | null }>();
      const failed = result!.failed, locked = result!.locked_at != null;
      await audit(db, link.class_run_id, 'recipient', link.recipient_ref, locked ? 'report_link_locked' : 'report_link_check_failed', { link_id: link.id, failed }, now).run();
      if (locked) return c.json({ error: NOT_AVAILABLE }, 404);
      return wantsJson ? c.json({ error: 'viewer check did not match', reason: 'viewer_check_failed', attempts_left: MAX_VIEWER_ATTEMPTS - failed }, 403) : checkPage(prompt, `확인 값이 맞지 않습니다. 남은 시도 ${MAX_VIEWER_ATTEMPTS - failed}회. 모두 틀리면 이 주소는 닫히고 새 주소를 받아야 합니다.`, 403);
    }
    const released = await db.prepare('UPDATE classroom_link_attempts SET failed=failed-1,updated_at=? WHERE link_id=? AND locked_at IS NULL RETURNING failed').bind(now, link.id).first();
    if (!released) return c.json({ error: NOT_AVAILABLE }, 404);
  }
  await db.batch([db.prepare('UPDATE classroom_report_links SET views=views+1 WHERE id=?').bind(link.id), audit(db, link.class_run_id, 'recipient', link.recipient_ref, 'report_link_viewed', { link_id: link.id, viewer_check: check ? 'passed' : 'not_configured' }, now)]);
  const obj = await c.env.HPS_TRACES.get(draftKey(job as never, job.lease_generation)); if (!obj) return c.json({ error: NOT_AVAILABLE }, 404);
  const report = composeReport(JSON.parse(await obj.text()), { class_runs_with_evidence: 1, coverage: job.input_coverage, model: modelById(job.capability_model)! });
  // A person opens this in a browser: they get a page. `?format=json` keeps the data form for tools; both are the same composeReport().
  if (wantsJson) return c.json({ report });
  const run = await db.prepare('SELECT starts_at FROM class_run_ops WHERE class_run_id=?').bind(link.class_run_id).first<{ starts_at: number }>();
  return new Response(renderReportHtml(report, { student_label: job.student_id, class_label: `${new Date(run?.starts_at ?? job.created_at).toISOString().slice(0, 10)} 수업`, approved_at: job.updated_at, expires_at: link.expires_at }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': REPORT_PAGE_CSP, 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' } });
}
// GET never carries the check (it would land in URLs, history and logs): it asks. POST answers — a form from the page, or JSON from a tool.
classroomReportLinks.get('/:token', (c) => openLink(c, null));
classroomReportLinks.post('/:token', async (c) => {
  const type = c.req.header('content-type') ?? ''; let value = '';
  try { if (type.includes('application/json')) { const b = await c.req.json(); value = typeof b?.check === 'string' ? b.check : ''; } else { const f = await c.req.parseBody(); value = typeof f.check === 'string' ? f.check : ''; } } catch { value = ''; }
  return openLink(c, value);
});

// ── signed provider callbacks (no admin session: the signature over the raw body IS the authentication) ──
export const classroomDeliveryWebhooks = new Hono<{ Bindings: Env }>();
classroomDeliveryWebhooks.post('/resend', async (c) => {
  c.header('cache-control', 'no-store');
  if (!opsEnabled(c.env) || !c.env.RESEND_WEBHOOK_SECRET) return c.json({ error: 'not found' }, 404);
  const raw = await c.req.text(), now = Date.now();
  if (raw.length > 256 * 1024) return c.json({ error: 'too large' }, 413);
  const verdict = await verifySvix(c.env.RESEND_WEBHOOK_SECRET, { id: c.req.header('svix-id'), timestamp: c.req.header('svix-timestamp'), signature: c.req.header('svix-signature') }, raw, now);
  if (verdict !== 'ok') return c.json({ error: 'signature not accepted', reason: verdict }, verdict === 'stale' ? 400 : 401);
  let body: { type?: unknown; data?: { email_id?: unknown; tags?: unknown } } | null = null; try { body = JSON.parse(raw); } catch { body = null; }
  const kind = resendEventKind(body?.type), id = body?.data?.email_id;
  // Anything that is not a delivery state (opened, clicked, complained, domain events…) is acknowledged and ignored.
  if (!kind || typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) return c.json({ ignored: true });
  const tags = body?.data?.tags, tag = Array.isArray(tags) ? (tags as Array<{ name?: unknown; value?: unknown }>).find((x) => x?.name === 'delivery_key')?.value : tags && typeof tags === 'object' ? (tags as Record<string, unknown>).delivery_key : undefined;
  const r = await applyProviderEvent(c.env.HPS_DB, { event_id: 'resend:' + c.req.header('svix-id'), message_id: id, kind, ...(typeof tag === 'string' && /^[a-f0-9]{64}$/.test(tag) ? { delivery_key: tag } : {}) }, now);
  return c.json(r.duplicate ? { duplicate: true } : { applied: r.applied, state: r.state });
});
