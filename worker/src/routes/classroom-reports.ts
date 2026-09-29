// Remote classroom operations R5 (#751): report jobs from verified inputs, a
// leased batch runner, and the human review queue.
//
//  - A job exists only for a Service-verified input (the R4 outbox). Its key pins
//    student + run + input digest + model/rubric/evaluator/renderer revisions.
//  - The runner holds a per-batch capability. It can claim jobs of that batch, read
//    that job's verified input, and return a draft. Nothing else.
//  - Six-capability candidate model and legacy seven Assets are separate versions.
//    There is no conversion, and a draft in the wrong model is quarantined.
//  - A draft is never "done": it lands in review_required (or partial). Approval is
//    a human act by a `review`-capable instructor and is bound to the draft digest.
//  - Opening a draft is audited before any content leaves (it quotes the learner).
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../env';
import { bearer, signOpsCredential, verifyOpsCredential } from '../lib/tokens';
import { authorizeIssuerForOps, type IssuerAuthz } from '../lib/instructor-auth';
import { parseFlags, sha256Hex, type OpsCapability } from '../lib/classroom-ops';
import { readReportInput, reportInputFiles } from '../lib/classroom-report-input';
import { snapshotKey } from '../lib/classroom-collect';
import { batchScope, scopeRefusal } from './classroom-collect';
import { LEASE_MS, RENDERER_REVISION, composeReport, draftKey, draftPrefix, modelById, validateDraft } from '../lib/classroom-report';
import { DEFAULT_CAPABILITY_MODEL } from '../lib/measurement-core/index.ts';
import { evaluateInput, evaluatorConfig, rubricVersion, type Transport } from '../lib/classroom-evaluator';
import { getProfile } from '../profiles';
import { modelIdFor } from '../profiles/types';
import { opsEnabled } from './classroom-ops';
import { basisAllows, basisTables, inputBasisVerdict } from '../lib/lesson-basis';

type Db = Env['HPS_DB'];
type Job = { id: string; job_key: string; batch_id: string; class_run_id: string; cohort_id: string; student_id: string; input_manifest_digest: string; input_revision: number; snapshot_revision: number; input_coverage: string; capability_model: string; rubric: string; evaluator: string; renderer_revision: string; state: string; reason: string; lease_owner: string; lease_generation: number; lease_expires_at: number; draft_digest: string; summary_json: string; revision: number };
const json = async (c: any) => { try { return await c.req.json(); } catch { return null; } };
const audit = (db: Db, run: string, kind: string, id: string, action: string, detail: unknown, at: number) => db.prepare("INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) VALUES(?,'',?,?,?,?,?)").bind(run, kind, id, action, JSON.stringify(detail), at);
const VERSION_RE = /^[A-Za-z0-9_.:+-]{1,64}$/;

export const classroomReportsTeacher = new Hono<{ Bindings: Env }>();
const root = '/cohorts/:cohort/classroom/runs/:run/report-batches/:batch';
async function teacher(c: any, capability: OpsCapability): Promise<{ auth: IssuerAuthz; run: Record<string, any>; batch: Record<string, any> } | Response> {
  c.header('cache-control', 'no-store');
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const auth = await authorizeIssuerForOps(c, c.req.param('cohort'), capability);
  if (auth instanceof Response) return auth; if (!auth) return c.json({ error: 'instructor Bearer required' }, 401);
  const run = await c.env.HPS_DB.prepare('SELECT * FROM class_run_ops WHERE class_run_id=? AND cohort_id=?').bind(c.req.param('run'), c.req.param('cohort')).first();
  if (!run || !auth.scope.profiles.includes(run.profile_id)) return c.json({ error: 'class run not found in scope', reason: 'run_not_found' }, 404);
  if (!parseFlags(run.flags_json).ops_reports) return c.json({ error: 'reports are off for this run', reason: 'ops_reports_disabled' }, 403);
  const batch = await c.env.HPS_DB.prepare('SELECT * FROM classroom_collect_batches WHERE id=? AND class_run_id=?').bind(c.req.param('batch'), run.class_run_id).first();
  if (!batch) return c.json({ error: 'batch not found' }, 404);
  // Selected collection is collection only (#751 U1): it never becomes an evaluation or a delivery by a later click.
  let scope; try { scope = await batchScope(c.env.HPS_DB, String(batch.id)); } catch (err) { const no = scopeRefusal(c, err); if (no) return no; throw err; }
  if (scope.mode === 'collect_only') return c.json({ error: 'this batch collected records only; evaluation and delivery belong to the class wrap-up', reason: 'collect_only_batch' }, 409);
  return { auth, run, batch };
}

/** Test seam only: replaces the provider call. Production never sets it. */
let evaluatorTransport: Transport | undefined;
export const setEvaluatorTransport = (t: Transport | undefined) => { evaluatorTransport = t; };
const profileModel = (profileId: string): string | undefined => { try { const p = getProfile(profileId); return p ? modelIdFor(p.model.default, 'anthropic') : undefined; } catch { return undefined; } };

/**
 * Verified inputs (the collection outbox) → jobs. Idempotent: the job key pins student + run + input digest + model/rubric/
 * evaluator/renderer, so a second click, a restart or two tabs create nothing twice. Learners without a verified input get an
 * explicit `missing` job — absence is not a zero.
 */
async function createJobs(db: Db, run: Record<string, any>, batch: Record<string, any>, v: { model: { id: string; revision: number }; rubric: string; evaluator: string }, now: number): Promise<{ inputs: number; without_input: number }> {
  const pending = ((await db.prepare("SELECT id,payload_json FROM classroom_job_outbox WHERE kind='report_input' AND state='pending' AND json_extract(payload_json, '$.batch_id')=? ORDER BY id LIMIT 500").bind(batch.id).all()).results ?? []) as Array<{ id: number; payload_json: string }>;
  const stmts = []; let created = 0;
  for (const o of pending) {
    const p = JSON.parse(o.payload_json); if (p.batch_id !== batch.id) continue;
    const key = await sha256Hex([p.student_id, run.class_run_id, p.manifest_digest, v.model.id, v.model.revision, v.rubric, v.evaluator, RENDERER_REVISION].join('|'));
    // #751 U3 — an input made under more than one lesson basis (or whose basis cannot be established) becomes a HELD job:
    // visible in the review queue with its reason, never leased, never evaluated. One verdict for every consumer (lib/lesson-basis.ts).
    const basis = await inputBasisVerdict(db, { class_run_id: run.class_run_id, student_id: p.student_id, batch_id: batch.id, snapshot_revision: p.snapshot_revision });
    stmts.push(db.prepare("INSERT INTO classroom_report_jobs(id,job_key,batch_id,class_run_id,cohort_id,student_id,input_manifest_digest,input_revision,snapshot_revision,input_coverage,capability_model,rubric,evaluator,renderer_revision,state,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_key) DO NOTHING").bind(crypto.randomUUID(), key, batch.id, run.class_run_id, run.cohort_id, p.student_id, p.manifest_digest, p.input_revision, p.snapshot_revision, p.coverage, v.model.id, v.rubric, v.evaluator, RENDERER_REVISION, basis.allow ? 'queued' : 'held', basis.allow ? '' : basis.reason, now, now));
    stmts.push(db.prepare("UPDATE classroom_job_outbox SET state='processed',processed_at=? WHERE id=?").bind(now, o.id)); created++;
  }
  // A learner whose job in this batch was closed by a withdrawal already has their (content-free) row: no second "missing" row for them.
  const without = ((await db.prepare("SELECT student_id,state FROM classroom_collect_items i WHERE batch_id=?1 AND state<>'verified' AND NOT EXISTS (SELECT 1 FROM classroom_report_jobs j WHERE j.batch_id=?1 AND j.student_id=i.student_id AND j.state='withdrawn')").bind(batch.id).all()).results ?? []) as Array<{ student_id: string; state: string }>;
  for (const w of without) { const key = await sha256Hex([w.student_id, run.class_run_id, 'no-input', batch.id].join('|')); stmts.push(db.prepare("INSERT INTO classroom_report_jobs(id,job_key,batch_id,class_run_id,cohort_id,student_id,input_manifest_digest,input_revision,snapshot_revision,input_coverage,capability_model,rubric,evaluator,renderer_revision,state,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,'',0,0,'none',?,?,?,?,'missing',?,?,?) ON CONFLICT(job_key) DO NOTHING").bind(crypto.randomUUID(), key, batch.id, run.class_run_id, run.cohort_id, w.student_id, v.model.id, v.rubric, v.evaluator, RENDERER_REVISION, w.state, now, now)); }
  if (stmts.length) await db.batch(stmts);
  return { inputs: created, without_input: without.length };
}
classroomReportsTeacher.post(root + '/jobs', async (c) => {
  const t = await teacher(c, 'collect'); if (t instanceof Response) return t; const { auth, run, batch } = t, b = (await json(c)) ?? {}, now = Date.now(), db = c.env.HPS_DB;
  const model = modelById(b.capability_model ?? DEFAULT_CAPABILITY_MODEL.id), rubric = b.rubric ?? 'unknown', evaluator = b.evaluator ?? 'none';
  if (!model || !VERSION_RE.test(rubric) || !VERSION_RE.test(evaluator)) return c.json({ error: 'capability_model must be a registered model id; rubric and evaluator are version strings', reason: 'versions_invalid' }, 400);
  const made = await createJobs(db, run, batch, { model, rubric, evaluator }, now);
  await audit(db, run.class_run_id, 'instructor', auth.payload.u, 'report_jobs_created', { batch_id: batch.id, capability_model: model.id, ...made }, now).run();
  return c.json(await queueView(db, batch.id), 201);
});

/**
 * Store a validated result on a leased job. One learner's broken draft is isolated; every other job keeps going.
 *
 * R2 and D1 do not share a transaction, so the order is: ask D1 → write the body → let D1 DECIDE → undo the body if D1 said no.
 *   - D1 decides with one statement: the lease generation is still the live one AND the learner has no withdrawal tombstone.
 *     A result that arrives after a withdrawal, an erasure or a re-claim therefore never becomes a draft.
 *   - The body is written under this generation's own key (see draftKey), so undoing it cannot touch a draft that another
 *     generation committed, and a late write cannot replace one.
 *   - The check before the write only saves work; it is not the guarantee. A write that was already in flight when the
 *     learner withdrew is removed right here. If this process dies between the write and the removal, the object is one
 *     the erasure ledger re-checks after the write window has closed (lib/classroom-erasure.ts, `settled`).
 */
const liveLease = " state='leased' AND lease_generation=?2 AND NOT EXISTS (SELECT 1 FROM classroom_collect_tombstones t WHERE t.class_run_id=classroom_report_jobs.class_run_id AND t.student_id=classroom_report_jobs.student_id)";
async function discardBody(env: Env, job: Job, key: string, actor: { kind: string; id: string }, now: number) {
  try { await env.HPS_TRACES.delete(key); }
  catch { // Content-free note; the object itself is found again by prefix (erasure re-check, or the next stored result of this job).
    await audit(env.HPS_DB, job.class_run_id, actor.kind, actor.id, 'report_draft_discard_failed', { job_id: job.id }, now).run().catch(() => {});
    console.error('classroom reports: a discarded draft body could not be removed yet', job.id);
  }
}
/** The learner withdrew while this job was leased: the job ends here. It is not re-queued, so their words are not read or sent to a provider again. */
const WITHDRAWN = { state: 'withdrawn', reason: 'withdrawn', draft_digest: '', ok: false } as const;
const closeIfWithdrawn = (db: Db, job: Job, generation: number, now: number) => db.prepare("UPDATE classroom_report_jobs SET state='withdrawn',reason='withdrawn',draft_digest='',summary_json='{}',lease_expires_at=0,revision=revision+1,updated_at=?3 WHERE id=?1 AND state='leased' AND lease_generation=?2 AND EXISTS (SELECT 1 FROM classroom_collect_tombstones t WHERE t.class_run_id=classroom_report_jobs.class_run_id AND t.student_id=classroom_report_jobs.student_id) RETURNING id").bind(job.id, generation, now).first();
/** Refused because the learner withdrew — whether this call closed the job or the erasure already had. Anything else refused is a lost lease. */
const refusedAs = async (db: Db, job: Job, generation: number, now: number) => ((await closeIfWithdrawn(db, job, generation, now)) || (await db.prepare("SELECT 1 FROM classroom_report_jobs WHERE id=? AND state='withdrawn'").bind(job.id).first())) ? WITHDRAWN : null;
/**
 * #751 U3 — a job whose input may not be evaluated ends here as `held`. Used right after a lease (a job queued before its
 * basis was known), before the evaluator or a runner sees a byte of the input, and when a result arrives for it anyway.
 */
async function holdForBasis(env: Env, job: Job, generation: number, actor: { kind: string; id: string }, now: number): Promise<{ state: 'held'; reason: string; draft_digest: ''; ok: false } | null> {
  const verdict = await inputBasisVerdict(env.HPS_DB, { class_run_id: job.class_run_id, student_id: job.student_id, batch_id: job.batch_id, snapshot_revision: job.snapshot_revision });
  if (verdict.allow) return null;
  await env.HPS_DB.batch([
    env.HPS_DB.prepare("UPDATE classroom_report_jobs SET state='held',reason=?,draft_digest='',summary_json='{}',lease_expires_at=0,revision=revision+1,updated_at=? WHERE id=? AND state='leased' AND lease_generation=?").bind(verdict.reason, now, job.id, generation),
    audit(env.HPS_DB, job.class_run_id, actor.kind, actor.id, 'report_job_held', { job_id: job.id, reason: verdict.reason }, now),
  ]);
  return { state: 'held', reason: verdict.reason, draft_digest: '', ok: false };
}
async function saveResult(env: Env, job: Job, generation: number, v: ReturnType<typeof validateDraft> | { ok: false; state: 'failed'; reason: string }, actor: { kind: string; id: string }, now: number) {
  const db = env.HPS_DB; let digest = '', summary = {}, key = '';
  // The commit below carries the basis rule itself (a basis row may land between this check and the write); this check only
  // saves writing a body that would be discarded. The predicate names the U3 tables, so it is attached only where they exist.
  const held = await holdForBasis(env, job, generation, actor, now); if (held) return held;
  const tables = await basisTables(db); if (tables === 'unreadable') return { state: 'held', reason: 'lesson_basis_unreadable', draft_digest: '', ok: false } as const;
  const basisGuard = tables ? ` AND ${basisAllows('classroom_report_jobs')}` : '';
  if (v.ok) {
    if (!(await db.prepare(`SELECT 1 FROM classroom_report_jobs WHERE id=?1 AND${liveLease}`).bind(job.id, generation).first())) return refusedAs(db, job, generation, now);
    const body = JSON.stringify(v.draft); digest = await sha256Hex(body); key = draftKey(job, generation);
    await env.HPS_TRACES.put(key, body, { httpMetadata: { contentType: 'application/json' } });
    summary = { observed: v.draft.findings.filter((f) => f.status === 'observed').length, not_yet_seen: v.draft.findings.filter((f) => f.status !== 'observed').length };
  }
  let saved: { state: string } | null = null;
  try { saved = await db.prepare(`UPDATE classroom_report_jobs SET state=?3,reason=?4,draft_digest=?5,summary_json=?6,lease_expires_at=0,revision=revision+1,updated_at=?7 WHERE id=?1 AND${liveLease}${basisGuard} RETURNING state`).bind(job.id, generation, v.state, v.reason, digest, JSON.stringify(summary), now).first<{ state: string }>(); }
  catch (err) { if (key) await discardBody(env, job, key, actor, now); throw err; }
  if (!saved) { if (key) await discardBody(env, job, key, actor, now); return (await holdForBasis(env, job, generation, actor, now)) ?? refusedAs(db, job, generation, now); }
  if (key) { // Bodies left by earlier generations of this job (a lease that died after its write) are not the draft: remove them.
    try { for (const o of (await env.HPS_TRACES.list({ prefix: draftPrefix(job), limit: 100 })).objects) if (o.key !== key) await env.HPS_TRACES.delete(o.key); } catch { /* found again at erasure */ }
  }
  await audit(db, job.class_run_id, actor.kind, actor.id, 'report_draft_' + v.state, { job_id: job.id, reason: v.reason, draft_digest: digest }, now).run();
  return { state: v.state, reason: v.reason, draft_digest: digest, ok: v.ok };
}
/**
 * Evaluate ONE leased job inside the Service: verified input → evaluator adapter → validateDraft → review queue.
 * The learner's words never leave the Service for this. A provider failure releases the job back to the queue (bounded
 * attempts) instead of inventing a draft; an unconfigured evaluator is reported as exactly that.
 */
async function evaluateLeased(env: Env, job: Job, profileId: string, actor: { kind: string; id: string }, now: number) {
  const db = env.HPS_DB, cfg = evaluatorConfig(env, profileModel(profileId)), model = modelById(job.capability_model);
  // Back to the queue WITH a pause: a job that cannot run right now must not be the next one picked again.
  const release = async (reason: string, attempted = false) => { const increment = attempted ? 1 : 0; await db.batch([
    db.prepare("UPDATE classroom_report_jobs SET state='queued',reason=?,lease_expires_at=0,updated_at=? WHERE id=? AND state='leased' AND lease_generation=?").bind(reason, now, job.id, job.lease_generation),
    db.prepare('INSERT INTO classroom_report_job_attempts(job_id,attempts,next_attempt_at,last_reason,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET attempts=attempts+excluded.attempts,next_attempt_at=?,last_reason=excluded.last_reason,updated_at=excluded.updated_at').bind(job.id, increment, now + RETRY_STEPS_MS[0]!, reason, now, now + RETRY_STEPS_MS[attempted ? Math.min(await attemptsOf(db, job.id), RETRY_STEPS_MS.length - 1) : 0]!),
  ]); };
  if (!cfg) { await release('evaluator_not_configured'); return { state: 'queued', reason: 'evaluator_not_configured', ok: false }; }
  // The job is pinned to an evaluator/rubric. This Service evaluates only jobs pinned to what it actually runs.
  if (!model || job.evaluator !== cfg.id || job.rubric !== rubricVersion(model)) { await release('evaluator_mismatch'); return { state: 'queued', reason: 'evaluator_mismatch', ok: false }; }
  if (model.status === 'legacy') { await release('legacy_engine_required'); return { state: 'queued', reason: 'legacy_engine_required', ok: false }; }
  if (await closeIfWithdrawn(db, job, job.lease_generation, now)) return WITHDRAWN;
  // #751 U3 — BEFORE the input is read or a provider is called.
  { const held = await holdForBasis(env, job, job.lease_generation, actor, now); if (held) return held; }
  let text: import('../lib/classroom-report').ReportInput;
  try { text = await readReportInput(env, job); }
  catch (err) { return saveResult(env, job, job.lease_generation, { ok: false, state: 'failed', reason: String((err as Error).message).startsWith('input_') ? (err as Error).message : 'input_unreadable' }, actor, now); }
  try {
    const out = await evaluateInput(env, cfg, model, job, text, evaluatorTransport);
    await audit(db, job.class_run_id, 'system', 'evaluator', 'report_evaluated', { job_id: job.id, evaluator: cfg.id, analysis_ai_model: out.analysis_ai_model, usage: out.usage, ...(out.truncated ? { input_truncated: out.truncated } : {}) }, now).run();
    const verdict = validateDraft(out.draft, job, text);
    // Only part of the record was read (cost guard): the reviewer is told, whatever the record's own coverage says.
    return saveResult(env, job, job.lease_generation, verdict.ok && out.truncated ? { ...verdict, state: 'partial', reason: 'input_truncated' } : verdict, actor, now);
  } catch (err) {
    const code = String((err as Error)?.message ?? 'evaluator_failed').replace(/[^a-z0-9_]/g, '').slice(0, 48) || 'evaluator_failed';
    // Transient provider trouble: back to the queue, at most 3 leases. After that it is a visible failure, not a silent loop.
    if ((await attemptsOf(db, job.id)) < MAX_TRANSIENT_ATTEMPTS - 1 && /^evaluator_provider_(429|5\d\d)$/.test(code)) { await release(code, true); return { state: 'queued', reason: code, ok: false }; }
    return saveResult(env, job, job.lease_generation, { ok: false, state: 'failed', reason: code }, actor, now);
  }
}
export const RETRY_STEPS_MS = [30_000, 120_000, 600_000] as const;
const MAX_TRANSIENT_ATTEMPTS = 3;
const attemptsOf = async (db: Db, jobId: string) => (await db.prepare('SELECT attempts FROM classroom_report_job_attempts WHERE job_id=?').bind(jobId).first<{ attempts: number }>())?.attempts ?? 0;
/** What the caller is able to run. A job outside of it is not handed out, so it cannot sit in front of jobs that can run. */
interface Runnable { service: { evaluator: string; rubric: string; model: string } | null; legacy: boolean; local: boolean }
function runnableSql(can: Runnable): { sql: string; binds: string[] } {
  const parts: string[] = [], binds: string[] = [];
  if (can.service) { parts.push('(capability_model=? AND evaluator=? AND rubric=?)'); binds.push(can.service.model, can.service.evaluator, can.service.rubric); }
  if (can.legacy) parts.push("capability_model='legacy-seven-assets'");
  // A locally supplied evaluator takes jobs pinned to no Service evaluator (evaluator='none' or an operator-named one) of the non-legacy models.
  if (can.local) { parts.push("(capability_model<>'legacy-seven-assets' AND evaluator NOT LIKE 'service-%')"); }
  return { sql: parts.length ? '(' + parts.join(' OR ') + ')' : '0', binds };
}
const claimNext = (db: Db, batchId: string, owner: string, now: number, can: Runnable) => { const r = runnableSql(can); return db.prepare(`UPDATE classroom_report_jobs SET state='leased',lease_owner=?,lease_generation=lease_generation+1,lease_expires_at=?,updated_at=? WHERE id=(SELECT j.id FROM classroom_report_jobs j LEFT JOIN classroom_report_job_attempts a ON a.job_id=j.id WHERE j.batch_id=? AND (j.state='queued' OR (j.state='leased' AND j.lease_expires_at<=?)) AND COALESCE(a.next_attempt_at,0)<=? AND ${r.sql} ORDER BY j.created_at LIMIT 1) RETURNING *`).bind(owner, now + LEASE_MS, now, batchId, now, now, ...r.binds).first<Job>(); };
/**
 * Re-preparation policy. A job is pinned to the evaluator/rubric it was created for, and that pin is never rewritten.
 * When the Service's evaluator is (re)configured, a job of the default model that was NEVER evaluated and is pinned to
 * something else is closed as `superseded`, and a NEW job with the current versions is created for the same verified
 * input (its own job_key, so repeating this creates nothing twice). A job that already has a draft — whatever version
 * produced it — is left exactly as it is: no silent re-evaluation, no second draft for the same input and version.
 */
async function reprepare(db: Db, run: Record<string, any>, batch: Record<string, any>, v: { model: { id: string; revision: number }; rubric: string; evaluator: string }, actor: string, now: number): Promise<number> {
  const stale = ((await db.prepare("SELECT * FROM classroom_report_jobs WHERE batch_id=? AND state='queued' AND draft_digest='' AND input_manifest_digest<>'' AND capability_model=? AND (evaluator<>? OR rubric<>?)").bind(batch.id, v.model.id, v.evaluator, v.rubric).all()).results ?? []) as Job[];
  if (!stale.length) return 0;
  const stmts = [];
  for (const j of stale) {
    const key = await sha256Hex([j.student_id, run.class_run_id, j.input_manifest_digest, v.model.id, v.model.revision, v.rubric, v.evaluator, RENDERER_REVISION].join('|'));
    stmts.push(db.prepare("INSERT INTO classroom_report_jobs(id,job_key,batch_id,class_run_id,cohort_id,student_id,input_manifest_digest,input_revision,snapshot_revision,input_coverage,capability_model,rubric,evaluator,renderer_revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?) ON CONFLICT(job_key) DO NOTHING").bind(crypto.randomUUID(), key, batch.id, run.class_run_id, run.cohort_id, j.student_id, j.input_manifest_digest, j.input_revision, j.snapshot_revision, j.input_coverage, v.model.id, v.rubric, v.evaluator, RENDERER_REVISION, now, now));
    stmts.push(db.prepare("UPDATE classroom_report_jobs SET state='superseded',reason='evaluator_changed',revision=revision+1,updated_at=? WHERE id=? AND state='queued' AND draft_digest=''").bind(now, j.id));
  }
  stmts.push(audit(db, run.class_run_id, 'instructor', actor, 'report_jobs_reprepared', { batch_id: batch.id, superseded: stale.map((j) => ({ job_id: j.id, from: { evaluator: j.evaluator, rubric: j.rubric } })), to: { evaluator: v.evaluator, rubric: v.rubric } }, now));
  await db.batch(stmts);
  return stale.length;
}

/**
 * "수업 마무리" drives this: one bounded unit of work per call — verified receipts → jobs (deduplicated) → claim ONE job →
 * evaluate → review queue. The page calls it until `more` is false; closing the page, going offline or a restart loses
 * nothing (jobs and leases live in D1) and repeating it creates nothing twice. It never approves and never sends.
 */
classroomReportsTeacher.post(root + '/advance', async (c) => {
  const t = await teacher(c, 'collect'); if (t instanceof Response) return t; const { auth, run, batch } = t, now = Date.now(), db = c.env.HPS_DB;
  const model = DEFAULT_CAPABILITY_MODEL, cfg = evaluatorConfig(c.env, profileModel(run.profile_id));
  const made = await createJobs(db, run, batch, { model, rubric: cfg ? rubricVersion(model) : 'unknown', evaluator: cfg ? cfg.id : 'none' }, now);
  let step: Record<string, unknown> | null = null;
  const can: Runnable = { service: cfg ? { evaluator: cfg.id, rubric: rubricVersion(model), model: model.id } : null, legacy: false, local: false };
  const reprepared = cfg ? await reprepare(db, run, batch, { model, rubric: rubricVersion(model), evaluator: cfg.id }, auth.payload.u, now) : 0;
  if (cfg) { const job = await claimNext(db, batch.id, 'advance:' + auth.payload.u, now, can); if (job) step = { job_id: job.id, ...(await evaluateLeased(c.env, job, run.profile_id, { kind: 'instructor', id: auth.payload.u }, now)) }; }
  const view = await queueView(db, batch.id), uploading = await db.prepare("SELECT count(*) AS n FROM classroom_collect_items WHERE batch_id=? AND state IN ('requested','uploading')").bind(batch.id).first<{ n: number }>();
  // What can still move, by the SAME rule the claim uses: runnable here and now / runnable here after its pause / needs something else.
  const r = runnableSql(can), open = ((await db.prepare(`SELECT j.id,COALESCE(a.next_attempt_at,0) AS next_at,j.state,j.lease_expires_at,${r.sql} AS runnable FROM classroom_report_jobs j LEFT JOIN classroom_report_job_attempts a ON a.job_id=j.id WHERE j.batch_id=? AND j.state IN ('queued','leased')`).bind(...r.binds, batch.id).all()).results ?? []) as Array<{ next_at: number; state: string; lease_expires_at: number; runnable: number }>;
  const mine = open.filter((j) => j.runnable === 1), ready = mine.filter((j) => j.next_at <= now && !(j.state === 'leased' && j.lease_expires_at > now)), paused = mine.filter((j) => j.next_at > now);
  return c.json({ ...view, created: made, reprepared, step, evaluator: cfg ? { id: cfg.id, configured: true } : { configured: false, reason: 'evaluator_not_configured' },
    // `more` = calling again makes progress right now. A paused retry says when; work that needs another engine (legacy, a local evaluator) is counted, never spun on.
    more: ready.length > 0, retry_after_ms: !ready.length && paused.length ? Math.max(1000, Math.min(...paused.map((j) => j.next_at)) - now) : null, needs_other_engine: open.length - mine.length, uploads_pending: uploading?.n ?? 0 });
});

async function queueView(db: Db, batchId: string) {
  const storedJobs = ((await db.prepare('SELECT id,student_id,state,reason,capability_model,rubric,evaluator,renderer_revision,input_revision,input_coverage,input_manifest_digest,draft_digest,summary_json,revision,reviewed_by,lease_owner,lease_expires_at,updated_at FROM classroom_report_jobs WHERE batch_id=? ORDER BY student_id,input_revision').bind(batchId).all()).results ?? []) as Array<Record<string, any>>;
  // A no-input placeholder is historical once this batch has verified input for
  // the same learner. Preserve its row, but do not call that learner both missing
  // and drafted in the instructor's current queue or totals.
  const received = new Set(storedJobs.filter((j) => j.input_manifest_digest).map((j) => j.student_id));
  const jobs = storedJobs.filter((j) => j.state !== 'missing' || !received.has(j.student_id));
  const by: Record<string, number> = {}; for (const j of jobs) by[j.state] = (by[j.state] ?? 0) + 1;
  const now = Date.now(), waiting = jobs.filter((j) => j.state === 'queued' || j.state === 'leased');
  return { summary: { jobs: jobs.length, by_state: by,
    // A powered-off runner is visible as such; the jobs simply stay in D1.
    runner: !waiting.length ? 'idle' : waiting.some((j) => j.state === 'leased' && j.lease_expires_at > now) ? 'working' : 'runner_offline_or_not_started' },
    jobs: jobs.map((j) => ({ ...j, summary: JSON.parse(j.summary_json), summary_json: undefined })) };
}
classroomReportsTeacher.get(root + '/reports', async (c) => { const t = await teacher(c, 'review'); if (t instanceof Response) return t; return c.json(await queueView(c.env.HPS_DB, t.batch.id)); });

// Runner capability for ONE batch. Minted by a collect-capable instructor for the operator's machine; shown once.
classroomReportsTeacher.post(root + '/runner-grants', async (c) => {
  const t = await teacher(c, 'collect'); if (t instanceof Response) return t; const { auth, run, batch } = t, now = Date.now(), id = crypto.randomUUID();
  await c.env.HPS_DB.batch([
    c.env.HPS_DB.prepare("INSERT INTO ops_grants(id,kind,class_run_id,cohort_id,profile_id,seat_id,seat_revision,student_id,state,parent_grant_id,issuer_id,issuer_jti,created_at,expires_at) VALUES(?,'runner',?,?,?,'',0,'','active',?,?,?,?,?)").bind(id, run.class_run_id, run.cohort_id, run.profile_id, batch.id, auth.payload.u, auth.payload.jti ?? null, now, now + 12 * 3_600_000),
    audit(c.env.HPS_DB, run.class_run_id, 'instructor', auth.payload.u, 'runner_grant_issued', { grant_id: id, batch_id: batch.id }, now),
  ]);
  return c.json({ runner_credential: await signOpsCredential(id, c.env.HPS_SIGNING_SECRET), batch_id: batch.id, expires_at: now + 12 * 3_600_000, allows: ['claim jobs of this batch', 'read the verified input of a claimed job', 'return a draft'], denies: ['other batches', 'approval', 'delivery', 'learner devices'] }, 201);
});

async function openJob(c: any, t: { run: Record<string, any>; batch: Record<string, any> }) {
  return await c.env.HPS_DB.prepare('SELECT * FROM classroom_report_jobs WHERE id=? AND batch_id=?').bind(c.req.param('job'), t.batch.id).first() as Job | null;
}
classroomReportsTeacher.get(root + '/reports/:job', async (c) => {
  const t = await teacher(c, 'review'); if (t instanceof Response) return t; const job = await openJob(c, t), now = Date.now();
  if (!job) return c.json({ error: 'report not found' }, 404);
  if (!job.draft_digest) return c.json({ id: job.id, student_id: job.student_id, state: job.state, reason: job.reason, draft: null });
  // Fail closed: the view is recorded before the learner's words leave.
  await audit(c.env.HPS_DB, t.run.class_run_id, 'instructor', t.auth.payload.u, 'report_draft_viewed', { job_id: job.id, draft_digest: job.draft_digest }, now).run();
  const obj = await c.env.HPS_TRACES.get(draftKey(job, job.lease_generation)); if (!obj) return c.json({ error: 'draft body is missing', reason: 'draft_missing' }, 409);
  const draft = JSON.parse(await obj.text()), model = modelById(job.capability_model)!;
  const cumulative = await c.env.HPS_DB.prepare("SELECT count(DISTINCT class_run_id) AS n FROM classroom_report_jobs WHERE cohort_id=? AND student_id=? AND state IN ('review_required','approved','partial')").bind(job.cohort_id, job.student_id).first<{ n: number }>();
  return c.json({ id: job.id, student_id: job.student_id, state: job.state, reason: job.reason, revision: job.revision, draft_digest: job.draft_digest, input: { manifest_digest: job.input_manifest_digest, revision: job.input_revision, coverage: job.input_coverage }, report: composeReport(draft, { class_runs_with_evidence: cumulative?.n ?? 1, coverage: job.input_coverage, model }) });
});
classroomReportsTeacher.put(root + '/reports/:job/review', async (c) => {
  const t = await teacher(c, 'review'); if (t instanceof Response) return t; const job = await openJob(c, t), b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!job) return c.json({ error: 'report not found' }, 404);
  if (!b || !['approve', 'needs_observation', 'quarantine'].includes(b.decision) || !Number.isInteger(b.expected_revision) || typeof b.draft_digest !== 'string') return c.json({ error: 'decision, expected_revision and draft_digest required' }, 400);
  if (!['review_required', 'partial', 'approved'].includes(job.state)) return c.json({ error: 'this report is not waiting for review', reason: 'not_reviewable', state: job.state }, 409);
  // Approval is about the exact draft the reviewer read. A re-run or late input changes the digest and needs a new look.
  if (b.draft_digest !== job.draft_digest) return c.json({ error: 'the draft changed since it was opened', reason: 'draft_changed' }, 409);
  if (b.decision === 'approve' && job.reason === 'marker_review_missing') return c.json({ error: 'the legacy 28-marker review is not complete', reason: 'marker_review_missing' }, 409);
  // #751 U3 — a draft made before its input's basis was known is not approved either. Checked here AND in the commit.
  let approveGuard = '';
  if (b.decision === 'approve') {
    const verdict = await inputBasisVerdict(db, { class_run_id: job.class_run_id, student_id: job.student_id, batch_id: job.batch_id, snapshot_revision: job.snapshot_revision });
    if (!verdict.allow) return c.json({ error: 'this record was produced under more than one lesson basis (or its basis cannot be established); it is held until reports are written per basis', reason: verdict.reason }, 409);
    if (verdict.tables) approveGuard = ` AND ${basisAllows('classroom_report_jobs')}`;
  }
  const state = b.decision === 'approve' ? 'approved' : b.decision === 'quarantine' ? 'quarantined' : 'review_required';
  const saved = await db.prepare('UPDATE classroom_report_jobs SET state=?,reason=?,reviewed_by=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?' + approveGuard + ' RETURNING state,revision').bind(state, b.decision === 'needs_observation' ? 'needs_observation' : b.decision === 'quarantine' ? 'reviewer_quarantined' : job.reason, t.auth.payload.u, now, job.id, b.expected_revision).first<{ state: string; revision: number }>();
  if (!saved) return c.json({ error: 'another reviewer changed this report; reload', reason: 'revision_conflict' }, 409);
  await audit(db, t.run.class_run_id, 'instructor', t.auth.payload.u, 'report_' + b.decision, { job_id: job.id, draft_digest: job.draft_digest }, now).run();
  return c.json({ id: job.id, state: saved.state, revision: saved.revision, approved_draft_digest: state === 'approved' ? job.draft_digest : null, note: 'approval of the report content is not approval to send it' });
});

// ── runner (per-batch capability) ──
export const classroomReportsRunner = new Hono<{ Bindings: Env; Variables: { batch: string; run: string; runner: string } }>();
classroomReportsRunner.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const cred = bearer(c.req.header('authorization')), id = cred ? await verifyOpsCredential(cred, c.env.HPS_SIGNING_SECRET) : null;
  const g = id ? await c.env.HPS_DB.prepare("SELECT g.id,g.state,g.expires_at,g.parent_grant_id,g.class_run_id,o.flags_json FROM ops_grants g JOIN class_run_ops o ON o.class_run_id=g.class_run_id WHERE g.id=? AND g.kind='runner'").bind(id).first<Record<string, any>>() : null;
  if (!g || g.state !== 'active' || g.expires_at <= Date.now()) return c.json({ error: 'runner credential required', reason: 'runner_credential_invalid' }, 401);
  if (!parseFlags(g.flags_json).ops_reports) return c.json({ error: 'reports are off for this run', reason: 'ops_reports_disabled' }, 403);
  c.set('batch', g.parent_grant_id); c.set('run', g.class_run_id); c.set('runner', g.id); return next();
});
classroomReportsRunner.post('/claim', async (c) => {
  const db = c.env.HPS_DB, now = Date.now(), batch = c.get('batch'), runner = c.get('runner');
  // Expired leases return to the queue with a new generation: whatever the old runner sends later is refused.
  const b = (await json(c)) ?? {}, run = await db.prepare('SELECT profile_id FROM class_run_ops WHERE class_run_id=?').bind(c.get('run')).first<{ profile_id: string }>();
  const cfg = evaluatorConfig(c.env, profileModel(run?.profile_id ?? '')), want = b.can && typeof b.can === 'object' ? b.can : { service: true, legacy: true, local: true };
  const can: Runnable = { service: want.service && cfg ? { evaluator: cfg.id, rubric: rubricVersion(DEFAULT_CAPABILITY_MODEL), model: DEFAULT_CAPABILITY_MODEL.id } : null, legacy: want.legacy === true, local: want.local === true };
  // A learner who withdrew is never handed to a runner: their leased job is closed instead and the next one is tried.
  let job = await claimNext(db, batch, runner, now, can);
  for (let i = 0; job && i < 50 && ((await closeIfWithdrawn(db, job, job.lease_generation, now)) || (await holdForBasis(c.env, job, job.lease_generation, { kind: 'runner', id: runner }, now))); i++) job = await claimNext(db, batch, runner, now, can);
  if (!job) {
    // Nothing for THIS runner. Say why work may still be waiting, so an operator sees "not configured" instead of an idle runner.
    const waiting = ((await db.prepare("SELECT j.capability_model,j.evaluator,COALESCE(a.next_attempt_at,0) AS next_at FROM classroom_report_jobs j LEFT JOIN classroom_report_job_attempts a ON a.job_id=j.id WHERE j.batch_id=? AND j.state='queued'").bind(batch).all()).results ?? []) as Array<{ capability_model: string; evaluator: string; next_at: number }>;
    const legacy = waiting.filter((j) => j.capability_model === 'legacy-seven-assets').length, service = waiting.filter((j) => j.capability_model !== 'legacy-seven-assets' && j.evaluator.startsWith('service-')).length;
    return c.json({ job: null, waiting: { queued: waiting.length, paused: waiting.filter((j) => j.next_at > now).length, needs_legacy_engine: can.legacy ? 0 : legacy, needs_service_evaluator: can.service ? 0 : service, needs_local_evaluator: can.local ? 0 : waiting.length - legacy - service, service_evaluator_configured: !!cfg } });
  }
  return c.json({ job: { id: job.id, student_id: job.student_id, lease_generation: job.lease_generation, lease_ms: LEASE_MS, capability_model: job.capability_model, rubric: job.rubric, evaluator: job.evaluator, renderer_revision: job.renderer_revision, input: { manifest_digest: job.input_manifest_digest, coverage: job.input_coverage, files: (await reportInputFiles(c.env, job)).map((f) => f.name) } } });
});
const leased = (c: any, generation: unknown) => c.env.HPS_DB.prepare("SELECT * FROM classroom_report_jobs WHERE id=? AND batch_id=? AND state='leased' AND lease_owner=? AND lease_generation=? AND lease_expires_at>? AND NOT EXISTS (SELECT 1 FROM classroom_collect_tombstones t WHERE t.class_run_id=classroom_report_jobs.class_run_id AND t.student_id=classroom_report_jobs.student_id)").bind(c.req.param('job'), c.get('batch'), c.get('runner'), Number(generation), Date.now()).first() as Promise<Job | null>;
classroomReportsRunner.get('/jobs/:job/input/:file', async (c) => {
  const job = await leased(c, c.req.query('generation')); if (!job) return c.json({ error: 'no live lease on this job', reason: 'lease_lost' }, 409);
  if (!(await reportInputFiles(c.env, job)).some((f) => f.name === c.req.param('file'))) return c.json({ error: 'not an input file' }, 400);
  // #751 U3 — no byte of a held input leaves the Service, even for a job leased before its basis was known.
  { const held = await holdForBasis(c.env, job, job.lease_generation, { kind: 'runner', id: c.get('runner') }, Date.now()); if (held) return c.json({ error: 'this input is held: it was produced under more than one lesson basis, or its basis cannot be established', reason: held.reason }, 409); }
  const obj = await c.env.HPS_TRACES.get(snapshotKey(job.cohort_id, job.class_run_id, job.student_id, job.batch_id, job.snapshot_revision, c.req.param('file')));
  return obj ? new Response(await obj.arrayBuffer(), { headers: { 'cache-control': 'no-store', 'content-type': 'application/octet-stream' } }) : c.json({ error: 'input missing' }, 404);
});
classroomReportsRunner.post('/jobs/:job/heartbeat', async (c) => {
  const b = await json(c), job = await leased(c, b?.lease_generation); if (!job) return c.json({ error: 'no live lease on this job', reason: 'lease_lost' }, 409);
  await c.env.HPS_DB.prepare('UPDATE classroom_report_jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND lease_generation=?').bind(Date.now() + LEASE_MS, Date.now(), job.id, job.lease_generation).run(); return c.json({ lease_ms: LEASE_MS });
});
classroomReportsRunner.post('/jobs/:job/result', bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
  const b = await json(c), job = await leased(c, b?.lease_generation), now = Date.now(); if (!job) return c.json({ error: 'no live lease on this job; result discarded', reason: 'lease_lost' }, 409);
  { const held = await holdForBasis(c.env, job, job.lease_generation, { kind: 'runner', id: c.get('runner') }, now); if (held) return c.json(held, 409); }
  let v: ReturnType<typeof validateDraft>;
  try { v = b?.failed ? { ok: false, state: 'failed', reason: /^[a-z_]{1,48}$/.test(b.failed) ? b.failed : 'runner_failed' } : validateDraft(b?.draft, job, await readReportInput(c.env, job)); }
  catch { v = { ok: false, state: 'failed', reason: 'input_unreadable' }; }
  const saved = await saveResult(c.env, job, job.lease_generation, v, { kind: 'runner', id: c.get('runner') }, now);
  if (!saved) return c.json({ error: 'lease changed while saving; result discarded', reason: 'lease_lost' }, 409);
  return c.json({ state: saved.state, reason: saved.reason, draft_digest: saved.draft_digest }, saved.ok ? 201 : saved.state === 'withdrawn' ? 409 : 422);
});
// The restricted runner can also ask the Service to evaluate the job it holds: the input never leaves the Service.
classroomReportsRunner.post('/jobs/:job/evaluate', async (c) => {
  const b = await json(c), job = await leased(c, b?.lease_generation), now = Date.now(); if (!job) return c.json({ error: 'no live lease on this job', reason: 'lease_lost' }, 409);
  const run = await c.env.HPS_DB.prepare('SELECT profile_id FROM class_run_ops WHERE class_run_id=?').bind(job.class_run_id).first<{ profile_id: string }>();
  const r = await evaluateLeased(c.env, job, run?.profile_id ?? '', { kind: 'runner', id: c.get('runner') }, now);
  if (!r) return c.json({ error: 'lease changed while saving; result discarded', reason: 'lease_lost' }, 409);
  return c.json(r, r.ok ? 201 : r.state === 'queued' || r.state === 'withdrawn' ? 409 : 422);
});
