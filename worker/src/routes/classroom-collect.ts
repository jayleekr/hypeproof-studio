// Remote classroom operations R4 (#751): consent scope, collection batch,
// immutable snapshot upload, Service-side manifest verification, outbox.
//
//  - `analytics.upload_session_logs=true` is NOT consent. A collection needs a
//    consent row for this run, student, purpose and notice version. A minor needs
//    an operator-recorded, verified guardian consent; a checkbox cannot stand in.
//  - Learners without consent stay in the batch with the reason. Nothing is asked
//    of their device and nothing is stored.
//  - A snapshot revision is write-once. Changed bytes are a new revision.
//  - `verified` is issued only after the Service re-hashes what it holds.
//  - Instructors get states and digests here. Never content.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../env';
import { bearer, verifyOpsCredential } from '../lib/tokens';
import { authorizeIssuerForOps, type IssuerAuthz } from '../lib/instructor-auth';
import { getProfile } from '../profiles';
import { isMinorCohort } from '../lib/moderation';
import { COMMAND_TTL_MS, ID_RE, UUIDISH_RE, parseFlags, sha256Hex } from '../lib/classroom-ops';
import { CONSENT_BASES, PURPOSES, SNAPSHOT_FILES, UPLOAD_GRACE_MS, eventCoverage, sha256Bytes, snapshotKey, validateManifest } from '../lib/classroom-collect';
import { opsEnabled } from './classroom-ops';

type Db = Env['HPS_DB'];
const json = async (c: any) => { try { return await c.req.json(); } catch { return null; } };
const NOTICE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const audit = (db: Db, run: string, seat: string, kind: string, id: string, action: string, detail: unknown, at: number) => db.prepare('INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) VALUES(?,?,?,?,?,?,?)').bind(run, seat, kind, id, action, JSON.stringify(detail), at);
const liveConsent = (db: Db, run: string, student: string, purpose: string, notice: string, now: number) => db.prepare('SELECT id,basis FROM classroom_consents WHERE class_run_id=? AND student_id=? AND purpose=? AND notice_version=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1').bind(run, student, purpose, notice, now).first<{ id: string; basis: string }>();

// ── operator: record a verified guardian consent / withdraw (admin auth only; never an issuer Bearer) ──
export const classroomCollectOperator = new Hono<{ Bindings: Env }>();
classroomCollectOperator.post('/classroom/consents', async (c) => {
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const b = await json(c), now = Date.now();
  if (!b || !ID_RE.test(b.class_run_id) || !ID_RE.test(b.student_id) || !(PURPOSES as readonly string[]).includes(b.purpose) || !NOTICE_RE.test(b.notice_version ?? '') || b.basis !== 'guardian_verified' || typeof b.evidence_ref !== 'string' || !/^[A-Za-z0-9_.:-]{4,128}$/.test(b.evidence_ref) || !Number.isInteger(b.valid_hours) || b.valid_hours < 1 || b.valid_hours > 24 * 90) return c.json({ error: 'class_run_id, student_id, purpose, notice_version, basis=guardian_verified, evidence_ref and valid_hours required' }, 400);
  const run = await c.env.HPS_DB.prepare('SELECT cohort_id FROM class_run_ops WHERE class_run_id=?').bind(b.class_run_id).first<{ cohort_id: string }>();
  if (!run || !(await c.env.HPS_DB.prepare('SELECT 1 FROM class_run_seats WHERE class_run_id=? AND student_id=? AND replaced_at IS NULL').bind(b.class_run_id, b.student_id).first())) return c.json({ error: 'student is not in this run' }, 404);
  const id = crypto.randomUUID();
  await c.env.HPS_DB.batch([
    c.env.HPS_DB.prepare("INSERT INTO classroom_consents(id,class_run_id,cohort_id,student_id,purpose,notice_version,basis,evidence_ref,recorded_by,created_at,expires_at) VALUES(?,?,?,?,?,?,'guardian_verified',?,'operator',?,?)").bind(id, b.class_run_id, run.cohort_id, b.student_id, b.purpose, b.notice_version, b.evidence_ref, now, now + b.valid_hours * 3_600_000),
    // A fresh, verified consent lifts an earlier withdrawal for this run; the tombstone's effect on already-deleted data is not undone.
    c.env.HPS_DB.prepare('DELETE FROM classroom_collect_tombstones WHERE class_run_id=? AND student_id=?').bind(b.class_run_id, b.student_id),
    audit(c.env.HPS_DB, b.class_run_id, '', 'operator', 'operator', 'guardian_consent_recorded', { consent_id: id, student_id: b.student_id, notice_version: b.notice_version }, now),
  ]);
  return c.json({ consent_id: id }, 201);
});

// ── learner device (operations credential) ──
export const classroomCollectApp = new Hono<{ Bindings: Env; Variables: { grant: Grant } }>();
type Grant = { id: string; class_run_id: string; cohort_id: string; profile_id: string; seat_id: string; seat_revision: number; student_id: string; state: string; expires_at: number; flags_json: string; run_ends: number };
classroomCollectApp.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const credential = bearer(c.req.header('authorization')), id = credential ? await verifyOpsCredential(credential, c.env.HPS_SIGNING_SECRET) : null;
  const g = id ? await c.env.HPS_DB.prepare("SELECT g.*,o.flags_json,o.ends_at AS run_ends FROM ops_grants g JOIN class_run_ops o ON o.class_run_id=g.class_run_id WHERE g.id=? AND g.kind='connection'").bind(id).first<Grant>() : null;
  if (!g) return c.json({ error: 'operations credential required', reason: 'ops_credential_invalid' }, 401);
  const now = Date.now();
  // Upload-only afterlife: past the grant's normal expiry this credential may still finish uploading the
  // learner's OWN requested snapshot until the batch window closes. It can do nothing else (sync refuses it).
  if (g.state !== 'active') return c.json({ error: 'operations connection was closed', reason: 'ops_grant_revoked' }, 401);
  if (g.expires_at <= now && now > g.run_ends + UPLOAD_GRACE_MS) return c.json({ error: 'operations connection expired', reason: 'ops_grant_expired' }, 401);
  if (!parseFlags(g.flags_json).ops_collect) return c.json({ error: 'collection is off for this run', reason: 'ops_collect_disabled' }, 403);
  c.set('grant', g); return next();
});

// An adult learner gives (or withdraws) their own consent, after reading the notice the app shows.
classroomCollectApp.post('/consent', async (c) => {
  const g = c.get('grant'), b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!b || typeof b.consent !== 'boolean' || !(PURPOSES as readonly string[]).includes(b.purpose) || !NOTICE_RE.test(b.notice_version ?? '')) return c.json({ error: 'consent, purpose and notice_version required' }, 400);
  if (!b.consent) {
    await db.batch([
      db.prepare('UPDATE classroom_consents SET revoked_at=? WHERE class_run_id=? AND student_id=? AND purpose=? AND revoked_at IS NULL').bind(now, g.class_run_id, g.student_id, b.purpose),
      db.prepare("INSERT INTO classroom_collect_tombstones(class_run_id,student_id,reason,created_by,created_at) VALUES(?,?,'withdrawn','student',?) ON CONFLICT DO NOTHING").bind(g.class_run_id, g.student_id, now),
      db.prepare("UPDATE classroom_collect_items SET state='withdrawn',reason='withdrawn',updated_at=? WHERE student_id=? AND batch_id IN (SELECT id FROM classroom_collect_batches WHERE class_run_id=?) AND state NOT IN ('verified')").bind(now, g.student_id, g.class_run_id),
      audit(db, g.class_run_id, g.seat_id, 'student', g.student_id, 'collection_consent_withdrawn', { purpose: b.purpose }, now),
    ]);
    return c.json({ consent: false, note: 'nothing further will be collected for this class; copies already delivered cannot be recalled' });
  }
  const profile = getProfile(g.profile_id);
  // A child profile can never opt itself in. Fail closed when the profile is unknown.
  if (!profile || isMinorCohort(profile)) return c.json({ error: 'a verified guardian consent is required for this class', reason: 'guardian_consent_required' }, 403);
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO classroom_consents(id,class_run_id,cohort_id,student_id,purpose,notice_version,basis,recorded_by,created_at,expires_at) VALUES(?,?,?,?,?,?,'adult_self',?,?,?)").bind(id, g.class_run_id, g.cohort_id, g.student_id, b.purpose, b.notice_version, g.student_id, now, g.run_ends + UPLOAD_GRACE_MS),
    db.prepare('DELETE FROM classroom_collect_tombstones WHERE class_run_id=? AND student_id=?').bind(g.class_run_id, g.student_id),
    audit(db, g.class_run_id, g.seat_id, 'student', g.student_id, 'collection_consent_given', { consent_id: id, notice_version: b.notice_version }, now),
  ]);
  return c.json({ consent: true, consent_id: id }, 201);
});

async function ownItem(c: any, g: Grant, batchId: string, now: number) {
  if (!UUIDISH_RE.test(batchId)) return c.json({ error: 'invalid batch' }, 400);
  const db: Db = c.env.HPS_DB;
  const item = await db.prepare('SELECT i.*,b.purpose,b.notice_version,b.upload_until,b.dry_run FROM classroom_collect_items i JOIN classroom_collect_batches b ON b.id=i.batch_id WHERE i.batch_id=? AND i.student_id=? AND i.seat_revision=? AND b.class_run_id=?').bind(batchId, g.student_id, g.seat_revision, g.class_run_id).first<Record<string, any>>();
  // Same answer for "no such batch" and "not yours": a device learns nothing about other learners' batches.
  // A learner held out of the batch when it was created (no consent then, not connected, withdrawn) was never asked.
  // Consent given later applies to the next batch; it does not reopen this one.
  if (item?.state === 'withdrawn') return c.json({ error: 'collection was withdrawn', reason: 'withdrawn' }, 403);
  if (!item || !['requested', 'uploading', 'incomplete', 'verified'].includes(item.state)) return c.json({ error: 'no collection was requested from this learner', reason: 'not_requested' }, 404);
  if (await db.prepare('SELECT 1 FROM classroom_collect_tombstones WHERE class_run_id=? AND student_id=?').bind(g.class_run_id, g.student_id).first()) return c.json({ error: 'collection was withdrawn', reason: 'withdrawn' }, 403);
  if (now > item.upload_until) return c.json({ error: 'the upload window has closed', reason: 'upload_window_closed' }, 403);
  if (item.dry_run) return c.json({ error: 'dry-run batch stores nothing', reason: 'dry_run' }, 409);
  if (!(await liveConsent(db, g.class_run_id, g.student_id, item.purpose, item.notice_version, now))) return c.json({ error: 'consent is missing, expired or withdrawn', reason: 'consent_missing' }, 403);
  return item;
}

classroomCollectApp.put('/snapshots/:batch/:revision/:filename', bodyLimit({ maxSize: 8 * 1024 * 1024 + 1024, onError: (c) => c.json({ error: 'file too large' }, 413) }), async (c) => {
  const g = c.get('grant'), now = Date.now(), db = c.env.HPS_DB, revision = Number(c.req.param('revision')), filename = c.req.param('filename');
  const spec = Object.prototype.hasOwnProperty.call(SNAPSHOT_FILES, filename) ? SNAPSHOT_FILES[filename]! : null;
  if (!spec || !Number.isSafeInteger(revision) || revision < 1 || revision > 1000) return c.json({ error: 'allowed file name and revision required' }, 400);
  const item = await ownItem(c, g, c.req.param('batch'), now); if (item instanceof Response) return item;
  const body = await c.req.arrayBuffer();
  if (!body.byteLength || body.byteLength > spec.maxBytes) return c.json({ error: 'empty or oversized file' }, 413);
  const sha = await sha256Bytes(body), snap = await db.prepare('SELECT state,files_json FROM classroom_snapshots WHERE batch_id=? AND student_id=? AND revision=?').bind(item.batch_id, g.student_id, revision).first<{ state: string; files_json: string }>();
  if (snap?.state === 'sealed') return c.json({ error: 'this revision is sealed; changed bytes need a new revision', reason: 'revision_sealed' }, 409);
  const files: Array<{ name: string; bytes: number; sha256: string }> = snap ? JSON.parse(snap.files_json) : [], prior = files.find((f) => f.name === filename);
  // Write-once per (revision, file): the same bytes again is an idempotent retry, different bytes is refused.
  if (prior) return prior.sha256 === sha ? c.json({ stored: true, sha256: sha, bytes: body.byteLength, retry: true }) : c.json({ error: 'this revision already holds different bytes; use a new revision', reason: 'revision_immutable' }, 409);
  await c.env.HPS_TRACES.put(snapshotKey(g.cohort_id, g.class_run_id, g.student_id, item.batch_id, revision, filename), body, { httpMetadata: { contentType: spec.contentType } });
  files.push({ name: filename, bytes: body.byteLength, sha256: sha });
  // The object exists before this row does. If this write fails the object is an orphan that reconcile() reports — not a "complete" upload.
  await db.batch([
    db.prepare("INSERT INTO classroom_snapshots(batch_id,student_id,revision,state,files_json,created_at) VALUES(?,?,?,'uploading',?,?) ON CONFLICT(batch_id,student_id,revision) DO UPDATE SET files_json=excluded.files_json").bind(item.batch_id, g.student_id, revision, JSON.stringify(files), now),
    db.prepare("UPDATE classroom_collect_items SET state='uploading',updated_at=? WHERE batch_id=? AND seat_id=? AND state IN ('requested','uploading','incomplete')").bind(now, item.batch_id, item.seat_id),
  ]);
  // Stored. Not verified, not complete.
  return c.json({ stored: true, sha256: sha, bytes: body.byteLength }, 201);
});

classroomCollectApp.post('/snapshots/:batch/:revision/seal', async (c) => {
  const g = c.get('grant'), now = Date.now(), db = c.env.HPS_DB, revision = Number(c.req.param('revision'));
  const item = await ownItem(c, g, c.req.param('batch'), now); if (item instanceof Response) return item;
  const m = validateManifest(await json(c)); if (!m.ok) return c.json({ error: m.error, reason: 'manifest_invalid' }, 400);
  const snap = await db.prepare('SELECT state,receipt_id,manifest_digest,integrity,coverage FROM classroom_snapshots WHERE batch_id=? AND student_id=? AND revision=?').bind(item.batch_id, g.student_id, revision).first<Record<string, string>>();
  if (!snap) return c.json({ error: 'nothing was uploaded for this revision', reason: 'manifest_only' }, 409);
  const digest = await sha256Hex(JSON.stringify(m.value.files.map((f) => [f.name, f.bytes, f.sha256]).sort()));
  if (snap.state === 'sealed') return snap.manifest_digest === digest ? c.json({ receipt_id: snap.receipt_id, manifest_digest: digest, integrity: snap.integrity, coverage: snap.coverage, replay: true }) : c.json({ error: 'this revision is sealed with a different manifest', reason: 'revision_sealed' }, 409);
  // Re-hash what the Service actually holds. The device's claim is only what it is compared against.
  let coverage = 'sequence_unavailable', problem = '';
  for (const f of m.value.files) {
    const obj = await c.env.HPS_TRACES.get(snapshotKey(g.cohort_id, g.class_run_id, g.student_id, item.batch_id, revision, f.name));
    if (!obj) { problem = 'file_missing'; break; }
    const bytes = await obj.arrayBuffer();
    if (bytes.byteLength !== f.bytes || (await sha256Bytes(bytes)) !== f.sha256) { problem = 'hash_mismatch'; break; }
    if (f.name === 'events.jsonl') { const cov = eventCoverage(new TextDecoder().decode(bytes), { student: g.student_id }); if (cov.foreign) { problem = 'foreign_events'; break; } coverage = cov.coverage; }
  }
  if (problem) {
    const state = problem === 'foreign_events' ? 'quarantined' : 'incomplete';
    await db.batch([
      db.prepare("UPDATE classroom_collect_items SET state=?,reason=?,updated_at=? WHERE batch_id=? AND seat_id=? AND state<>'verified'").bind(state, problem, now, item.batch_id, item.seat_id),
      audit(db, g.class_run_id, g.seat_id, 'system', 'collect', 'snapshot_' + state, { batch_id: item.batch_id, revision, problem }, now),
    ]);
    return c.json({ error: 'snapshot did not verify', reason: problem, state }, 422);
  }
  const receipt = crypto.randomUUID(), inputRevision = (item.input_revision ?? 0) + 1;
  // Seal, item state and the job outbox commit together: no verified receipt without a queued job, and no job for an unverified input.
  await db.batch([
    db.prepare("UPDATE classroom_snapshots SET state='sealed',manifest_digest=?,integrity='verified',coverage=?,receipt_id=?,sealed_at=? WHERE batch_id=? AND student_id=? AND revision=? AND state='uploading'").bind(digest, coverage, receipt, now, item.batch_id, g.student_id, revision),
    // A later verified revision is a NEW input revision. It never silently replaces what a report was built from.
    db.prepare("UPDATE classroom_collect_items SET state='verified',reason='',manifest_digest=?,integrity='verified',coverage=?,receipt_id=?,input_revision=?,updated_at=? WHERE batch_id=? AND seat_id=?").bind(digest, coverage, receipt, inputRevision, now, item.batch_id, item.seat_id),
    db.prepare("INSERT INTO classroom_job_outbox(kind,dedupe_key,payload_json,created_at) VALUES('report_input',?,?,?) ON CONFLICT(kind,dedupe_key) DO NOTHING").bind(`${item.batch_id}:${g.student_id}:${digest}`, JSON.stringify({ batch_id: item.batch_id, class_run_id: g.class_run_id, student_id: g.student_id, snapshot_revision: revision, input_revision: inputRevision, manifest_digest: digest, coverage }), now),
    audit(db, g.class_run_id, g.seat_id, 'system', 'collect', 'snapshot_verified', { batch_id: item.batch_id, revision, receipt_id: receipt, coverage }, now),
  ]);
  return c.json({ receipt_id: receipt, manifest_digest: digest, integrity: 'verified', coverage, input_revision: inputRevision }, 201);
});

// ── instructor (collect capability) ──
export const classroomCollectTeacher = new Hono<{ Bindings: Env }>();
const root = '/cohorts/:cohort/classroom/runs/:run/report-batches';
async function teacher(c: any): Promise<{ auth: IssuerAuthz; run: Record<string, any> } | Response> {
  c.header('cache-control', 'no-store');
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const auth = await authorizeIssuerForOps(c, c.req.param('cohort'), 'collect');
  if (auth instanceof Response) return auth; if (!auth) return c.json({ error: 'instructor Bearer required' }, 401);
  const run = await c.env.HPS_DB.prepare('SELECT * FROM class_run_ops WHERE class_run_id=? AND cohort_id=?').bind(c.req.param('run'), c.req.param('cohort')).first();
  if (!run) return c.json({ error: 'class run not configured', reason: 'run_not_found' }, 404);
  if (!auth.scope.profiles.includes(run.profile_id)) return c.json({ error: 'issuer not scoped to this run profile', reason: 'profile_scope' }, 403);
  // Missing execution authority or a switched-off feature refuses the whole batch; a missing consent only holds that learner.
  if (!parseFlags(run.flags_json).ops_collect) return c.json({ error: 'collection is off for this run', reason: 'ops_collect_disabled' }, 403);
  return { auth, run };
}
async function batchView(db: Db, runId: string, id: string) {
  const b = await db.prepare('SELECT id,roster_revision,purpose,notice_version,dry_run,created_by,created_at,upload_until FROM classroom_collect_batches WHERE id=? AND class_run_id=?').bind(id, runId).first<Record<string, unknown>>();
  if (!b) return null;
  const items = ((await db.prepare('SELECT seat_id,student_id,state,reason,input_revision,manifest_digest,integrity,coverage,receipt_id,updated_at FROM classroom_collect_items WHERE batch_id=? ORDER BY seat_id').bind(id).all()).results ?? []) as Array<Record<string, any>>;
  const by: Record<string, number> = {}; for (const i of items) by[i.state] = (by[i.state] ?? 0) + 1;
  return { batch: { ...b, dry_run: b.dry_run === 1 }, summary: { roster: items.length, by_state: by,
    // "Collected" is only what the Service verified. Arrived bytes and complete behaviour coverage are separate counts.
    verified: by.verified ?? 0, verified_complete_coverage: items.filter((i) => i.state === 'verified' && i.coverage === 'complete').length, held: items.filter((i) => ['consent_missing', 'guardian_consent_missing', 'withdrawn'].includes(i.state)).length }, items };
}
classroomCollectTeacher.post(root, bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
  const t = await teacher(c); if (t instanceof Response) return t; const { auth, run } = t, b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!b || !UUIDISH_RE.test(b.idempotency_key ?? '') || !Number.isInteger(b.roster_revision) || typeof b.dry_run !== 'boolean' || !(PURPOSES as readonly string[]).includes(b.purpose) || !NOTICE_RE.test(b.notice_version ?? '')) return c.json({ error: 'idempotency_key, roster_revision, purpose, notice_version and dry_run required' }, 400);
  if (b.roster_revision !== run.roster_revision) return c.json({ error: 'roster changed; reload before finishing the class', reason: 'revision_conflict', roster_revision: run.roster_revision }, 409);
  const prior = await db.prepare('SELECT id FROM classroom_collect_batches WHERE class_run_id=? AND idempotency_key=?').bind(run.class_run_id, b.idempotency_key).first<{ id: string }>();
  if (prior) return c.json(await batchView(db, run.class_run_id, prior.id), 200);
  // The batch is the class-run roster snapshot — never the gallery, never "whoever uploaded something".
  const seats = ((await db.prepare(`SELECT s.seat_id,s.seat_revision,s.student_id,(SELECT g.id||'|'||g.connection_epoch FROM ops_grants g WHERE g.class_run_id=s.class_run_id AND g.seat_id=s.seat_id AND g.seat_revision=s.seat_revision AND g.kind='connection' AND g.state='active' ORDER BY g.created_at DESC LIMIT 1) AS conn,
 (SELECT 1 FROM classroom_collect_tombstones t WHERE t.class_run_id=s.class_run_id AND t.student_id=s.student_id) AS withdrawn FROM class_run_seats s WHERE s.class_run_id=? AND s.replaced_at IS NULL ORDER BY s.seat_id`).bind(run.class_run_id).all()).results ?? []) as Array<{ seat_id: string; seat_revision: number; student_id: string; conn: string | null; withdrawn: number | null }>;
  const profile = getProfile(run.profile_id), minor = !profile || isMinorCohort(profile), id = crypto.randomUUID(), commandId = crypto.randomUUID();
  const stmts = [db.prepare('INSERT INTO classroom_collect_batches(id,class_run_id,cohort_id,profile_id,roster_revision,purpose,notice_version,dry_run,idempotency_key,created_by,created_at,upload_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, run.class_run_id, run.cohort_id, run.profile_id, run.roster_revision, b.purpose, b.notice_version, b.dry_run ? 1 : 0, b.idempotency_key, auth.payload.u, now, Math.max(run.ends_at, now) + UPLOAD_GRACE_MS)];
  const ask: typeof seats = [];
  for (const s of seats) {
    const consent = await liveConsent(db, run.class_run_id, s.student_id, b.purpose, b.notice_version, now);
    const okConsent = consent && (CONSENT_BASES as readonly string[]).includes(consent.basis) && (!minor || consent.basis === 'guardian_verified');
    const state = s.withdrawn ? 'withdrawn' : !okConsent ? (minor ? 'guardian_consent_missing' : 'consent_missing') : !s.conn ? 'not_connected' : 'requested';
    if (state === 'requested' && !b.dry_run) ask.push(s);
    stmts.push(db.prepare('INSERT INTO classroom_collect_items(batch_id,seat_id,seat_revision,student_id,state,reason,consent_id,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(id, s.seat_id, s.seat_revision, s.student_id, state, state === 'requested' ? '' : state, okConsent ? consent!.id : '', now));
  }
  if (ask.length) {
    // The request to devices rides the existing command ledger: same lease, epoch, TTL and receipts. The batch id is set here, never by the instructor.
    stmts.push(db.prepare("INSERT INTO ops_commands(id,class_run_id,cohort_id,action,args_json,payload_hash,idempotency_key,issued_by,issuer_jti,reason_code,created_at,expires_at) VALUES(?,?,?,'retry_evidence_upload',?,?,?,?,?,'class_management',?,?)").bind(commandId, run.class_run_id, run.cohort_id, JSON.stringify({ batch_id: id, purpose: b.purpose, notice_version: b.notice_version }), await sha256Hex(id), 'collect-' + id, auth.payload.u, auth.payload.jti ?? null, now, now + COMMAND_TTL_MS));
    for (const s of ask) { const [grantId, epoch] = s.conn!.split('|'); stmts.push(db.prepare("INSERT INTO ops_command_targets(command_id,class_run_id,seat_id,seat_revision,grant_id,connection_epoch,mutating,state,expires_at,updated_at) VALUES(?,?,?,?,?,?,0,'queued',?,?)").bind(commandId, run.class_run_id, s.seat_id, s.seat_revision, grantId, Number(epoch), now + COMMAND_TTL_MS, now)); }
  }
  stmts.push(audit(db, run.class_run_id, '', 'instructor', auth.payload.u, 'collect_batch_created', { batch_id: id, dry_run: b.dry_run, requested: ask.length, roster: seats.length }, now));
  try { await db.batch(stmts); } catch (err) { console.error('collect batch failed:', err); return c.json({ error: 'batch not recorded; nothing was requested', reason: 'storage' }, 503); }
  return c.json(await batchView(db, run.class_run_id, id), 201);
});
classroomCollectTeacher.get(root + '/:id', async (c) => {
  const t = await teacher(c); if (t instanceof Response) return t;
  const v = await batchView(c.env.HPS_DB, t.run.class_run_id, c.req.param('id')!); return v ? c.json(v) : c.json({ error: 'batch not found' }, 404);
});

/**
 * DB↔R2 reconciliation for one batch. Reports, never repairs by guessing:
 *  - uploads that never sealed within the window → `incomplete`
 *  - R2 objects with no snapshot row (the PUT landed, the row did not) → listed as orphans
 */
classroomCollectTeacher.post(root + '/:id/reconcile', async (c) => {
  const t = await teacher(c); if (t instanceof Response) return t; const db = c.env.HPS_DB, now = Date.now(), id = c.req.param('id')!;
  const b = await db.prepare('SELECT id,cohort_id,class_run_id FROM classroom_collect_batches WHERE id=? AND class_run_id=?').bind(id, t.run.class_run_id).first<{ id: string; cohort_id: string; class_run_id: string }>();
  if (!b) return c.json({ error: 'batch not found' }, 404);
  const stale = await db.prepare("UPDATE classroom_collect_items SET state='incomplete',reason='never_sealed',updated_at=? WHERE batch_id=? AND state='uploading' AND updated_at<? RETURNING seat_id").bind(now, id, now - 10 * 60_000).all();
  const rows = ((await db.prepare('SELECT student_id,revision,files_json FROM classroom_snapshots WHERE batch_id=?').bind(id).all()).results ?? []) as Array<{ student_id: string; revision: number; files_json: string }>;
  const known = new Set(rows.flatMap((r) => (JSON.parse(r.files_json) as Array<{ name: string }>).map((f) => snapshotKey(b.cohort_id, b.class_run_id, r.student_id, id, r.revision, f.name))));
  const listed = await c.env.HPS_TRACES.list({ prefix: `classroom-snapshots/${b.cohort_id}/${b.class_run_id}/`, limit: 1000 });
  const orphans = listed.objects.map((o) => o.key).filter((k) => k.includes(`/${id}/`) && !known.has(k));
  await audit(db, b.class_run_id, '', 'system', 'collect', 'batch_reconciled', { batch_id: id, never_sealed: (stale.results ?? []).length, r2_orphans: orphans.length }, now).run();
  return c.json({ never_sealed: (stale.results ?? []).map((r: any) => r.seat_id), r2_orphans: orphans.length, view: await batchView(db, b.class_run_id, id) });
});
