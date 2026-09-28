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
import { basisTables, sealBasisStatement } from '../lib/lesson-basis';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../env';
import { bearer, verifyOpsCredential } from '../lib/tokens';
import { authorizeIssuerForOps, type IssuerAuthz } from '../lib/instructor-auth';
import { getProfile } from '../profiles';
import { isMinorCohort } from '../lib/moderation';
import { COMMAND_TTL_MS, ID_RE, MAX_SEATS, UUIDISH_RE, parseFlags, parseLesson, sha256Hex } from '../lib/classroom-ops';
import { CONSENT_BASES, PURPOSES, SNAPSHOT_SCHEMA_V3, V3_FILE_RE, collectRequestCanonical, collectStatus, normalizeCollectRequest, normalizeKinds, snapshotFileSpec, UPLOAD_GRACE_MS, attributionProblem, eventCoverage, finalLineSha, sha256Bytes, snapshotKey, validateManifest, verifyCollection, type CollectKind } from '../lib/classroom-collect';
import { collectOutcome } from '../lib/classroom-recovery';
import { ERASURE_RETRY_STEPS_MS, MAX_ERASURE_ATTEMPTS, eraseLearnerCollection } from '../lib/classroom-erasure';
import { opsEnabled } from './classroom-ops';

type Db = Env['HPS_DB'];
const json = async (c: any) => { try { return await c.req.json(); } catch { return null; } };
const NOTICE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const audit = (db: Db, run: string, seat: string, kind: string, id: string, action: string, detail: unknown, at: number) => db.prepare('INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) VALUES(?,?,?,?,?,?,?)').bind(run, seat, kind, id, action, JSON.stringify(detail), at);
/**
 * #751 U1b — a seal decides from bytes it read BEFORE it commits, and R2 and D1 share no transaction: a withdrawal or an erasure
 * can land in between (reproduced 2026-09-22 in classroom-ops-collect-kinds: a withdrawn item came back `verified` with a receipt
 * and a fresh binding, or `incomplete` when the erasure had already removed the objects). So the admission is re-read INSIDE the
 * commit (`sealAdmitted`), and every other statement of the seal hangs on that snapshot row carrying this seal's receipt
 * (`sealedWith`): a withdrawn learner stays withdrawn, and no binding, basis, outbox or audit row appears for a seal that did not commit.
 */
const sealAdmitted = (g: Grant, item: Record<string, any>) => ({ sql: "NOT EXISTS (SELECT 1 FROM classroom_collect_tombstones t WHERE t.class_run_id=? AND t.student_id=?) AND EXISTS (SELECT 1 FROM classroom_collect_items x WHERE x.batch_id=? AND x.seat_id=? AND x.state<>'withdrawn')", binds: [g.class_run_id, g.student_id, item.batch_id, item.seat_id] });
const sealedWith = (g: Grant, item: Record<string, any>, revision: number, receipt: string) => ({ sql: 'EXISTS (SELECT 1 FROM classroom_snapshots s WHERE s.batch_id=? AND s.student_id=? AND s.revision=? AND s.receipt_id=?)', binds: [item.batch_id, g.student_id, revision, receipt] });
const auditIf = (db: Db, when: { sql: string; binds: unknown[] }, run: string, seat: string, action: string, detail: unknown, at: number) => db.prepare(`INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) SELECT ?,?,'system','collect',?,?,? WHERE ${when.sql}`).bind(run, seat, action, JSON.stringify(detail), at, ...when.binds);
/** The seal did not commit: say why from what D1 holds now. A withdrawal wins; a concurrent seal of the same revision is replayed or refused as before. */
const withdrawnNow = async (db: Db, g: Grant, item: Record<string, any>) => !!(await db.prepare('SELECT 1 FROM classroom_collect_tombstones WHERE class_run_id=? AND student_id=?').bind(g.class_run_id, g.student_id).first()) || (await db.prepare('SELECT state FROM classroom_collect_items WHERE batch_id=? AND seat_id=?').bind(item.batch_id, item.seat_id).first<{ state: string }>())?.state === 'withdrawn';
const withdrawnReply = (c: any) => c.json({ error: 'collection was withdrawn', reason: 'withdrawn' }, 403);
async function sealNotCommitted(c: any, g: Grant, item: Record<string, any>, revision: number, digest: string): Promise<Response> {
  const db: Db = c.env.HPS_DB;
  if (await withdrawnNow(db, g, item)) return withdrawnReply(c);
  const snap = await db.prepare('SELECT state,receipt_id,manifest_digest,integrity,coverage FROM classroom_snapshots WHERE batch_id=? AND student_id=? AND revision=?').bind(item.batch_id, g.student_id, revision).first<Record<string, string>>();
  if (snap?.state === 'sealed' && snap.manifest_digest === digest) return c.json({ receipt_id: snap.receipt_id, manifest_digest: digest, integrity: snap.integrity, coverage: snap.coverage, replay: true });
  return c.json({ error: 'this revision is sealed with a different manifest', reason: 'revision_sealed' }, 409);
}
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

// The operator withdraws for a learner (a guardian asked), or applies the retention period to a finished run.
// `retention_days` is an operations decision: there is no default, the caller states it, and `dry_run` shows what would go.
classroomCollectOperator.post('/classroom/erasures', async (c) => {
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!b || !ID_RE.test(b.class_run_id) || !['withdrawn', 'retention'].includes(b.reason) || typeof b.dry_run !== 'boolean' || (b.reason === 'withdrawn' && !ID_RE.test(b.student_id ?? '')) || (b.reason === 'retention' && (!Number.isInteger(b.retention_days) || b.retention_days < 1 || b.retention_days > 3650))) return c.json({ error: 'class_run_id, reason (withdrawn+student_id | retention+retention_days) and dry_run required' }, 400);
  const run = await db.prepare('SELECT cohort_id,ends_at FROM class_run_ops WHERE class_run_id=?').bind(b.class_run_id).first<{ cohort_id: string; ends_at: number }>();
  if (!run) return c.json({ error: 'class run not found' }, 404);
  if (b.reason === 'retention' && run.ends_at + b.retention_days * 86_400_000 > now) return c.json({ error: 'the retention period of this run has not ended', reason: 'retention_not_due', due_at: run.ends_at + b.retention_days * 86_400_000 }, 409);
  const students = b.reason === 'withdrawn' ? [b.student_id as string] : (((await db.prepare('SELECT DISTINCT i.student_id FROM classroom_collect_items i JOIN classroom_collect_batches x ON x.id=i.batch_id WHERE x.class_run_id=?').bind(b.class_run_id).all()).results ?? []) as Array<{ student_id: string }>).map((r) => r.student_id);
  if (b.dry_run) return c.json({ dry_run: true, students: students.length });
  // One learner's storage trouble does not stop the others. What did not finish is in the ledger as `started` and recovery retries it.
  const results = []; let pending = 0;
  for (const student_id of students) {
    try { results.push({ student_id, ...(await eraseLearnerCollection(c.env, { class_run_id: b.class_run_id, cohort_id: run.cohort_id, student_id }, b.reason, { kind: 'operator', id: 'operator' }, now)) }); }
    catch { pending++; results.push({ student_id, erasure: 'pending', reason: 'content_delete_failed' }); }
  }
  if (b.reason === 'withdrawn') await db.prepare('UPDATE classroom_consents SET revoked_at=? WHERE class_run_id=? AND student_id=? AND revoked_at IS NULL').bind(now, b.class_run_id, b.student_id).run();
  return c.json({ erased: results, pending, note: 'copies already delivered to a recipient are not recalled' }, pending ? 202 : 200);
});
// Where each requested erasure stands. Ids, states, counts and error codes only.
classroomCollectOperator.get('/classroom/erasures', async (c) => {
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const run = c.req.query('class_run_id') ?? ''; if (!ID_RE.test(run)) return c.json({ error: 'class_run_id required' }, 400);
  const rows = ((await c.env.HPS_DB.prepare('SELECT student_id,reason,state,attempts,last_error,started_at,updated_at FROM classroom_erasure_log WHERE class_run_id=? ORDER BY student_id').bind(run).all()).results ?? []) as Array<{ state: string; attempts: number; last_error: string; updated_at: number }>;
  return c.json({ erasures: rows.map((r) => ({ ...r, needs_operator: r.state === 'started' && r.attempts >= MAX_ERASURE_ATTEMPTS, next_attempt_at: r.state === 'started' && r.attempts < MAX_ERASURE_ATTEMPTS ? r.updated_at + ERASURE_RETRY_STEPS_MS[Math.min(Math.max(r.attempts, 1), ERASURE_RETRY_STEPS_MS.length) - 1]! : null })) });
});

// ── learner device (operations credential) ──
export const classroomCollectApp = new Hono<{ Bindings: Env; Variables: { grant: Grant } }>();
type Grant = { id: string; class_run_id: string; cohort_id: string; profile_id: string; seat_id: string; seat_revision: number; student_id: string; state: string; expires_at: number; flags_json: string; lesson_json: string; run_starts: number; run_ends: number };
classroomCollectApp.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const credential = bearer(c.req.header('authorization')), id = credential ? await verifyOpsCredential(credential, c.env.HPS_SIGNING_SECRET) : null;
  const g = id ? await c.env.HPS_DB.prepare("SELECT g.*,o.flags_json,o.lesson_json,o.starts_at AS run_starts,o.ends_at AS run_ends FROM ops_grants g JOIN class_run_ops o ON o.class_run_id=g.class_run_id WHERE g.id=? AND g.kind='connection'").bind(id).first<Grant>() : null;
  if (!g) return c.json({ error: 'operations credential required', reason: 'ops_credential_invalid' }, 401);
  const now = Date.now();
  // Upload-only afterlife: past the grant's normal expiry this credential may still finish uploading the
  // learner's OWN snapshot for a batch that asked for it BEFORE the expiry (new batches skip expired grants),
  // until the batch window closes. It can withdraw consent; it cannot give new consent, sync or take commands.
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
    // Withdrawal reaches what was already collected: snapshots, drafts, links and queued work go; the content-free record stays.
    // The withdrawal itself is already recorded above. If the stored content cannot be removed right now, that is said
    // as "pending" — not as a failed withdrawal — and recovery finishes it without the learner having to ask again.
    let erased; try { erased = await eraseLearnerCollection(c.env, { class_run_id: g.class_run_id, cohort_id: g.cohort_id, student_id: g.student_id }, 'withdrawn', { kind: 'student', id: g.student_id }, now); }
    catch {
      // "Retried automatically" is only true if the ledger knows about it. If even that cannot be written, this is an error the device sees.
      await db.prepare("INSERT INTO classroom_erasure_log(class_run_id,student_id,reason,state,attempts,last_error,started_at,updated_at) VALUES(?,?,'withdrawn','started',1,'content_delete_failed',?,?) ON CONFLICT(class_run_id,student_id) DO NOTHING").bind(g.class_run_id, g.student_id, now, now).run();
      return c.json({ consent: false, erased: null, erasure: 'pending', note: 'nothing further will be collected for this class and report links are closed. Removing what the Service held did not finish yet; it is retried automatically.' }, 202);
    }
    return c.json({ consent: false, erased, note: 'nothing further will be collected for this class; what the Service held was removed and report links were closed. Copies already delivered to a recipient cannot be recalled.' });
  }
  // Past its normal expiry this credential only finishes an upload that was already authorized: no new consent, no new scope.
  if (g.expires_at <= now) return c.json({ error: 'this connection can only finish an upload that was already requested', reason: 'upload_only' }, 403);
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
  if (!(snapshotFileSpec(filename, false) || V3_FILE_RE.test(filename)) || !Number.isSafeInteger(revision) || revision < 1 || revision > 1000) return c.json({ error: 'allowed file name and revision required' }, 400);
  const item = await ownItem(c, g, c.req.param('batch'), now); if (item instanceof Response) return item;
  // U1b — the names a batch accepts follow what it asked for: a kinds batch stores part files only, an older batch the two legacy files.
  let asked: BatchScope; try { asked = await batchScope(db, item.batch_id); } catch (err) { const no = scopeRefusal(c, err); if (no) return no; throw err; }
  const spec = snapshotFileSpec(filename, !!asked.kinds); if (!spec) return c.json({ error: 'this file is not part of what this collection asked for', reason: 'file_not_in_scope' }, 400);
  const body = await c.req.arrayBuffer();
  if (!body.byteLength || body.byteLength > spec.maxBytes) return c.json({ error: 'empty or oversized file' }, 413);
  const sha = await sha256Bytes(body), snap = await db.prepare('SELECT state,files_json FROM classroom_snapshots WHERE batch_id=? AND student_id=? AND revision=?').bind(item.batch_id, g.student_id, revision).first<{ state: string; files_json: string }>();
  if (snap?.state === 'sealed') return c.json({ error: 'this revision is sealed; changed bytes need a new revision', reason: 'revision_sealed' }, 409);
  const files: Array<{ name: string; bytes: number; sha256: string }> = snap ? JSON.parse(snap.files_json) : [], prior = files.find((f) => f.name === filename);
  // Write-once per (revision, file): the same bytes again is an idempotent retry, different bytes is refused.
  if (prior) {
    if (prior.sha256 !== sha) return c.json({ error: 'this revision already holds different bytes; use a new revision', reason: 'revision_immutable' }, 409);
    // An identical re-send stores nothing, but it IS upload activity: a device that resumes begins by re-sending what it holds.
    // `updated_at` of an uploading item means "the Service last received an upload PUT for this seat", which is what the
    // lifecycle compares with the time the request ended. Best effort: a failed touch must not fail an idempotent retry.
    await db.prepare("UPDATE classroom_collect_items SET updated_at=? WHERE batch_id=? AND seat_id=? AND state='uploading'").bind(now, item.batch_id, item.seat_id).run().catch(() => undefined);
    return c.json({ stored: true, sha256: sha, bytes: body.byteLength, retry: true });
  }
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
  // U1b — a kinds batch is sealed only as schema /3 and an older batch only as /1–/2: a manifest never widens or narrows what was asked.
  let asked: BatchScope; try { asked = await batchScope(db, item.batch_id); } catch (err) { const no = scopeRefusal(c, err); if (no) return no; throw err; }
  const v3 = m.value.schema === SNAPSHOT_SCHEMA_V3;
  if (!!asked.kinds !== v3) return c.json({ error: v3 ? 'this collection did not ask for kinds; the whole record is sealed as schema /2' : 'this collection asked for kinds; it is sealed as schema /3', reason: v3 ? 'schema_not_in_scope' : 'kinds_schema_required' }, 409);
  const snap = await db.prepare('SELECT state,receipt_id,manifest_digest,integrity,coverage,files_json FROM classroom_snapshots WHERE batch_id=? AND student_id=? AND revision=?').bind(item.batch_id, g.student_id, revision).first<Record<string, string>>();
  if (!snap) return c.json({ error: 'nothing was uploaded for this revision', reason: 'manifest_only' }, 409);
  // The binding is part of what was sealed: the same bytes under another binding are another manifest.
  const digest = await sha256Hex(JSON.stringify([m.value.files.map((f) => [f.name, f.bytes, f.sha256]).sort(), (v3 ? m.value.collection : m.value.binding) ?? null]));
  if (snap.state === 'sealed') return snap.manifest_digest === digest ? c.json({ receipt_id: snap.receipt_id, manifest_digest: digest, integrity: snap.integrity, coverage: snap.coverage, ...(item.state === 'verified' && item.receipt_id === snap.receipt_id && item.reason ? { coverage_reason: item.reason } : {}), replay: true }) : c.json({ error: 'this revision is sealed with a different manifest', reason: 'revision_sealed' }, 409);
  if (v3) return sealCollection(c, g, item, revision, m.value.files, m.value.collection!, digest, snap.files_json ?? "[]", asked, now);
  // Re-hash what the Service actually holds. The device's claim is only what it is compared against.
  let coverage = 'sequence_unavailable', coverageReason = '', problem = '', malformed = 0, metaText = '', sessionId = '';
  for (const f of m.value.files) {
    const obj = await c.env.HPS_TRACES.get(snapshotKey(g.cohort_id, g.class_run_id, g.student_id, item.batch_id, revision, f.name));
    if (!obj) { problem = 'file_missing'; break; }
    const bytes = await obj.arrayBuffer();
    if (bytes.byteLength !== f.bytes || (await sha256Bytes(bytes)) !== f.sha256) { problem = 'hash_mismatch'; break; }
    if (f.name === 'session.meta.json') metaText = new TextDecoder().decode(bytes);
    if (f.name === 'events.jsonl') {
      const text = new TextDecoder().decode(bytes), range = m.value.binding?.range, cov = eventCoverage(text, { student: g.student_id }, range);
      if (cov.foreign) { problem = 'foreign_events'; break; }
      // The declared final event must be the one the Service sees last; a different tail is another extent.
      if (range && (cov.range_problem === 'line_count_mismatch' || cov.range_problem === 'declared_extent_mismatch' || range.final_line_sha256 !== (await finalLineSha(text)))) { problem = 'range_mismatch'; break; }
      // A verified record that is not `complete` always says why: an undeclared extent is a reason too (AT-41).
      coverage = cov.coverage; coverageReason = cov.range_problem || (cov.coverage === 'range_unknown' ? 'range_not_declared' : ''); malformed = cov.malformed;
    }
  }
  // Identity lives in the spool metadata. A record of another learner, cohort, profile, class run or activity —
  // or one that names nobody — is held apart; it never becomes this seat's verified report input.
  if (!problem) {
    const lesson = parseLesson(g.lesson_json);
    problem = attributionProblem(metaText, m.value.binding, { student: g.student_id, cohort: g.cohort_id, profile: g.profile_id, class_run_id: g.class_run_id, batch_id: item.batch_id, seat_id: g.seat_id, purpose: item.purpose, notice_version: item.notice_version, activity: lesson ? { course_id: lesson.course_id, version: lesson.version } : null, run_starts_at: g.run_starts, upload_until: item.upload_until });
    if (!problem) sessionId = String(JSON.parse(metaText).session_id);
  }
  if (problem) {
    const state = ['file_missing', 'hash_mismatch'].includes(problem) ? 'incomplete' : 'quarantined', open = sealAdmitted(g, item);
    const res = await db.batch([
      db.prepare(`UPDATE classroom_collect_items SET state=?,reason=?,updated_at=? WHERE batch_id=? AND seat_id=? AND state<>'verified' AND ${open.sql}`).bind(state, problem, now, item.batch_id, item.seat_id, ...open.binds),
      auditIf(db, open, g.class_run_id, g.seat_id, 'snapshot_' + state, { batch_id: item.batch_id, revision, problem }, now),
    ]);
    if (!(res[1] as any)?.meta?.changes && await withdrawnNow(db, g, item)) return withdrawnReply(c);
    return c.json({ error: 'snapshot did not verify', reason: problem, state }, 422);
  }
  const receipt = crypto.randomUUID(), inputRevision = (item.input_revision ?? 0) + 1;
  // A collect-only batch ends at the verified receipt: it queues no evaluation input, so collecting can never start an evaluation by itself.
  const feedsEvaluation = asked.mode === 'finish';
  // #751 U3 — under how many lesson bases was this input made? Computed in SQL INSIDE the seal batch (atomic with it) wherever
  // the U3 tables exist. If they cannot be read the seal fails and the device retries: there is no seal without a basis row.
  // The outbox row is still written: the report pipeline turns a non-single basis into a HELD job that the reviewer can see.
  const u3 = await basisTables(db); if (u3 === 'unreadable') return c.json({ error: 'the lesson basis of this input cannot be established right now; nothing was sealed — retry', reason: 'lesson_basis_unreadable' }, 503, { 'retry-after': '30' });
  // Seal, item state and the job outbox commit together: no verified receipt without a queued job, and no job for an unverified input.
  const open = sealAdmitted(g, item), sealed = sealedWith(g, item, revision, receipt);
  const res = await db.batch([
    db.prepare(`UPDATE classroom_snapshots SET state='sealed',manifest_digest=?,integrity='verified',coverage=?,receipt_id=?,sealed_at=? WHERE batch_id=? AND student_id=? AND revision=? AND state='uploading' AND ${open.sql}`).bind(digest, coverage, receipt, now, item.batch_id, g.student_id, revision, ...open.binds),
    ...(u3 ? [sealBasisStatement(db, { batch_id: item.batch_id, student_id: g.student_id, revision, class_run_id: g.class_run_id, now, receipt })] : []),
    // A later verified revision is a NEW input revision. It never silently replaces what a report was built from.
    // `reason` of a verified item is the coverage reason: integrity=verified is not coverage=complete, and the teacher view needs why (AT-41).
    db.prepare(`UPDATE classroom_collect_items SET state='verified',reason=?,manifest_digest=?,integrity='verified',coverage=?,receipt_id=?,input_revision=?,updated_at=? WHERE batch_id=? AND seat_id=? AND ${sealed.sql}`).bind(coverageReason, digest, coverage, receipt, inputRevision, now, item.batch_id, item.seat_id, ...sealed.binds),
    db.prepare(`INSERT INTO classroom_snapshot_bindings(batch_id,student_id,revision,class_run_id,cohort_id,profile_id,seat_id,grant_id,consent_id,spool_session_id,attribution,activity_json,range_json,malformed_lines,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${sealed.sql} ON CONFLICT DO NOTHING`).bind(item.batch_id, g.student_id, revision, g.class_run_id, g.cohort_id, g.profile_id, g.seat_id, g.id, item.consent_id ?? '', sessionId, m.value.binding ? 'bound' : 'metadata_run', JSON.stringify(m.value.binding?.activity ?? null), JSON.stringify(m.value.binding?.range ?? null), malformed, now, ...sealed.binds),
    ...(feedsEvaluation ? [db.prepare(`INSERT INTO classroom_job_outbox(kind,dedupe_key,payload_json,created_at) SELECT 'report_input',?,?,? WHERE ${sealed.sql} ON CONFLICT(kind,dedupe_key) DO NOTHING`).bind(`${item.batch_id}:${g.student_id}:${digest}`, JSON.stringify({ batch_id: item.batch_id, class_run_id: g.class_run_id, student_id: g.student_id, snapshot_revision: revision, input_revision: inputRevision, manifest_digest: digest, coverage }), now, ...sealed.binds)] : []),
    auditIf(db, sealed, g.class_run_id, g.seat_id, 'snapshot_verified', { batch_id: item.batch_id, revision, receipt_id: receipt, coverage, ...(coverageReason ? { coverage_reason: coverageReason } : {}) }, now),
  ]);
  if ((res[0] as any)?.meta?.changes !== 1) return sealNotCommitted(c, g, item, revision, digest);
  return c.json({ receipt_id: receipt, manifest_digest: digest, integrity: 'verified', coverage, ...(coverageReason ? { coverage_reason: coverageReason } : {}), input_revision: inputRevision }, 201);
});

/**
 * U1b — seal a /3 snapshot. The Service re-hashes every part file it holds and reads the parts itself (verifyCollection):
 * whose they are, whether every sent line is an indexed line of an asked kind, and how far each session's window is proven.
 * A line of a kind that was NOT asked for is never kept: the revision's stored bytes are deleted and the item is quarantined.
 * A collect-only batch never queues evaluation input, whatever it holds.
 */
async function sealCollection(c: any, g: Grant, item: Record<string, any>, revision: number, files: Array<{ name: string; bytes: number; sha256: string }>, col: import('../lib/classroom-collect').CollectionBinding, digest: string, storedJson: string, asked: BatchScope, now: number): Promise<Response> {
  const db: Db = c.env.HPS_DB, key = (name: string) => snapshotKey(g.cohort_id, g.class_run_id, g.student_id, item.batch_id, revision, name), texts = new Map<string, string>();
  let problem = '';
  for (const f of files) {
    const obj = await c.env.HPS_TRACES.get(key(f.name));
    if (!obj) { problem = 'file_missing'; break; }
    const bytes = await obj.arrayBuffer();
    if (bytes.byteLength !== f.bytes || (await sha256Bytes(bytes)) !== f.sha256) { problem = 'hash_mismatch'; break; }
    texts.set(f.name, new TextDecoder().decode(bytes));
  }
  const lesson = parseLesson(g.lesson_json);
  const v = problem ? { problem } : await verifyCollection(texts, col, { student: g.student_id, cohort: g.cohort_id, profile: g.profile_id, class_run_id: g.class_run_id, batch_id: item.batch_id, seat_id: g.seat_id, purpose: item.purpose, notice_version: item.notice_version, activity: lesson ? { course_id: lesson.course_id, version: lesson.version } : null, run_starts_at: g.run_starts, upload_until: item.upload_until, kinds: asked.kinds! });
  if ('problem' in v) {
    const state = ['file_missing', 'hash_mismatch'].includes(v.problem) ? 'incomplete' : 'quarantined';
    // Content that was not asked for is not held "for a person to look at": it is removed now. Everything else stays as before.
    let removed = 0;
    if (v.problem === 'kind_violation') {
      for (const f of (JSON.parse(storedJson || '[]') as Array<{ name: string }>)) { await c.env.HPS_TRACES.delete(key(f.name)); removed++; }
      await db.prepare("UPDATE classroom_snapshots SET files_json='[]' WHERE batch_id=? AND student_id=? AND revision=? AND state='uploading'").bind(item.batch_id, g.student_id, revision).run();
    }
    const open = sealAdmitted(g, item), res = await db.batch([
      db.prepare(`UPDATE classroom_collect_items SET state=?,reason=?,updated_at=? WHERE batch_id=? AND seat_id=? AND state<>'verified' AND ${open.sql}`).bind(state, v.problem, now, item.batch_id, item.seat_id, ...open.binds),
      auditIf(db, open, g.class_run_id, g.seat_id, 'snapshot_' + state, { batch_id: item.batch_id, revision, problem: v.problem, ...(removed ? { removed_files: removed } : {}) }, now),
    ]);
    if (!(res[1] as any)?.meta?.changes && await withdrawnNow(db, g, item)) return withdrawnReply(c);
    return c.json({ error: 'snapshot did not verify', reason: v.problem, state }, 422);
  }
  const receipt = crypto.randomUUID(), inputRevision = (item.input_revision ?? 0) + 1;
  const u3 = await basisTables(db); if (u3 === 'unreadable') return c.json({ error: 'the lesson basis of this input cannot be established right now; nothing was sealed — retry', reason: 'lesson_basis_unreadable' }, 503, { 'retry-after': '30' });
  const current = col.parts.find((p) => p.current) ?? col.parts[0]!;
  const open = sealAdmitted(g, item), sealed = sealedWith(g, item, revision, receipt);
  const res = await db.batch([
    db.prepare(`UPDATE classroom_snapshots SET state='sealed',manifest_digest=?,integrity='verified',coverage=?,receipt_id=?,sealed_at=? WHERE batch_id=? AND student_id=? AND revision=? AND state='uploading' AND ${open.sql}`).bind(digest, v.coverage, receipt, now, item.batch_id, g.student_id, revision, ...open.binds),
    ...(u3 ? [sealBasisStatement(db, { batch_id: item.batch_id, student_id: g.student_id, revision, class_run_id: g.class_run_id, now, receipt })] : []),
    db.prepare(`UPDATE classroom_collect_items SET state='verified',reason=?,manifest_digest=?,integrity='verified',coverage=?,receipt_id=?,input_revision=?,updated_at=? WHERE batch_id=? AND seat_id=? AND ${sealed.sql}`).bind(v.reason, digest, v.coverage, receipt, inputRevision, now, item.batch_id, item.seat_id, ...sealed.binds),
    // range_json holds the extent the instructor view reads — numbers, times, flags and kinds. The parts' session ids stay in the part files.
    db.prepare(`INSERT INTO classroom_snapshot_bindings(batch_id,student_id,revision,class_run_id,cohort_id,profile_id,seat_id,grant_id,consent_id,spool_session_id,attribution,activity_json,range_json,malformed_lines,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,'bound',?,?,0,? WHERE ${sealed.sql} ON CONFLICT DO NOTHING`).bind(item.batch_id, g.student_id, revision, g.class_run_id, g.cohort_id, g.profile_id, g.seat_id, g.id, item.consent_id ?? '', current.spool_session_id, JSON.stringify(col.activity ?? null), JSON.stringify(v.extent), now, ...sealed.binds),
    auditIf(db, sealed, g.class_run_id, g.seat_id, 'snapshot_verified', { batch_id: item.batch_id, revision, receipt_id: receipt, coverage: v.coverage, kinds: col.kinds, sessions: col.parts.length, lines: v.extent.lines, included: v.extent.included, ...(v.reason ? { coverage_reason: v.reason } : {}) }, now),
  ]);
  if ((res[0] as any)?.meta?.changes !== 1) return sealNotCommitted(c, g, item, revision, digest);
  return c.json({ receipt_id: receipt, manifest_digest: digest, integrity: 'verified', coverage: v.coverage, ...(v.reason ? { coverage_reason: v.reason } : {}), coverage_reasons: v.reasons, input_revision: inputRevision }, 201);
}

// ── instructor (collect capability) ──
export const classroomCollectTeacher = new Hono<{ Bindings: Env }>();
// The batch view reads the scope too: an unreadable scope is a 503 here as everywhere else, never a guessed mode.
classroomCollectTeacher.onError((err, c) => { const no = scopeRefusal(c, err); if (no) return no; throw err; });
const root = '/cohorts/:cohort/classroom/runs/:run/report-batches';
async function teacher(c: any): Promise<{ auth: IssuerAuthz; run: Record<string, any> } | Response> {
  c.header('cache-control', 'no-store');
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  const auth = await authorizeIssuerForOps(c, c.req.param('cohort'), 'collect');
  if (auth instanceof Response) return auth; if (!auth) return c.json({ error: 'instructor Bearer required' }, 401);
  const run = await c.env.HPS_DB.prepare('SELECT o.*,s.ended_at FROM class_run_ops o LEFT JOIN sessions s ON s.id=o.class_run_id WHERE o.class_run_id=? AND o.cohort_id=?').bind(c.req.param('run'), c.req.param('cohort')).first();
  if (!run) return c.json({ error: 'class run not configured', reason: 'run_not_found' }, 404);
  if (!auth.scope.profiles.includes(run.profile_id)) return c.json({ error: 'issuer not scoped to this run profile', reason: 'profile_scope' }, 403);
  // Missing execution authority or a switched-off feature refuses the whole batch; a missing consent only holds that learner.
  if (!parseFlags(run.flags_json).ops_collect) return c.json({ error: 'collection is off for this run', reason: 'ops_collect_disabled' }, 403);
  return { auth, run };
}
/**
 * What a batch was asked to cover — and the one place that decides whether collected bytes may become evaluation input.
 *
 * Fail closed. Only a SUCCESSFUL lookup that finds no row means "a batch from before migration 0022" (whole roster, finish).
 * A lookup that throws (D1 unavailable, the table not migrated), a row that does not parse, or a scope/mode this code does
 * not know is NOT read as that older batch: it raises, and every caller — seal, reports, delivery, the batch view, the
 * idempotency check — answers 503 without changing anything. Promoting an unreadable scope to `finish` would let a
 * collect-only batch queue an evaluation (reproduced 2026-09-21, management-20260921/scope-read-failure-check.mjs).
 */
export class CollectScopeUnavailable extends Error { reason: 'scope_unavailable' | 'scope_invalid'; constructor(reason: 'scope_unavailable' | 'scope_invalid') { super(reason); this.reason = reason; } }
/** `kinds` absent = the batch did not ask for kinds (U1 or earlier): the whole record of the current session, schema /1–/2. */
export interface BatchScope { scope: 'roster' | 'targets'; mode: 'finish' | 'collect_only'; targets: string[]; request_hash: string; kinds?: CollectKind[] }
export async function batchScope(db: Db, batchId: string): Promise<BatchScope> {
  let row: { scope: string; mode: string; targets_json: string; request_hash: string; kinds_json: string | null } | null;
  try { row = await db.prepare('SELECT scope,mode,targets_json,request_hash,(SELECT k.kinds_json FROM classroom_collect_kinds k WHERE k.batch_id=classroom_collect_scopes.batch_id) AS kinds_json FROM classroom_collect_scopes WHERE batch_id=?').bind(batchId).first(); }
  catch (err) { console.error('collect scope lookup failed:', err); throw new CollectScopeUnavailable('scope_unavailable'); }
  if (!row) return { scope: 'roster', mode: 'finish', targets: [], request_hash: '' };
  let targets: unknown; try { targets = JSON.parse(row.targets_json); } catch { throw new CollectScopeUnavailable('scope_invalid'); }
  const seats = Array.isArray(targets) && targets.every((t) => typeof t === 'string' && ID_RE.test(t)) ? (targets as string[]) : null;
  const known = (row.scope === 'roster' && row.mode === 'finish' && seats?.length === 0) || (row.scope === 'targets' && row.mode === 'collect_only' && !!seats?.length);
  if (!known || !/^[a-f0-9]{64}$/.test(row.request_hash)) throw new CollectScopeUnavailable('scope_invalid');
  // Kinds that do not parse, or kinds on the class wrap-up, are not guessed at: the batch is unreadable, not "the whole record".
  let kinds: CollectKind[] | undefined;
  if (row.kinds_json != null) { let k: unknown; try { k = JSON.parse(row.kinds_json); } catch { throw new CollectScopeUnavailable('scope_invalid'); } kinds = normalizeKinds(k) ?? undefined; if (!kinds || row.mode !== 'collect_only') throw new CollectScopeUnavailable('scope_invalid'); }
  return { scope: row.scope as BatchScope['scope'], mode: row.mode as BatchScope['mode'], targets: seats!, request_hash: row.request_hash, ...(kinds ? { kinds } : {}) };
}
/** The single refusal every route gives when the scope cannot be read. No evaluation input, job or delivery is created on this path; the caller may retry. */
export const scopeRefusal = (c: any, err: unknown) => err instanceof CollectScopeUnavailable ? c.json({ error: 'the scope of this collection batch cannot be read right now; retry', reason: err.reason }, 503, { 'retry-after': '30' }) : null;
async function batchView(db: Db, runId: string, id: string) {
  const b = await db.prepare('SELECT id,roster_revision,purpose,notice_version,dry_run,created_by,created_at,upload_until FROM classroom_collect_batches WHERE id=? AND class_run_id=?').bind(id, runId).first<Record<string, unknown>>();
  if (!b) return null;
  const items = ((await db.prepare('SELECT seat_id,seat_revision,student_id,state,reason,input_revision,manifest_digest,integrity,coverage,receipt_id,updated_at FROM classroom_collect_items WHERE batch_id=? ORDER BY seat_id').bind(id).all()).results ?? []) as Array<Record<string, any>>;
  const by: Record<string, number> = {}; for (const i of items) by[i.state] = (by[i.state] ?? 0) + 1;
  const sc = await batchScope(db, id), selected = items.filter((i) => i.state !== 'not_selected');
  // Per selected seat, what the device-side request did — in ledger terms, so "asked" is never read as "received".
  const delivery = new Map((((await db.prepare("SELECT t.seat_id,t.state,t.result_code,t.updated_at FROM ops_command_targets t JOIN ops_commands c ON c.id=t.command_id WHERE c.class_run_id=? AND c.idempotency_key=?").bind(runId, 'collect-' + id).all()).results ?? []) as Array<{ seat_id: string; state: string; result_code: string; updated_at: number }>).map((t) => [t.seat_id, { state: t.state, result_code: t.result_code, updated_at: t.updated_at }]));
  // One observation: the same `now` decides the grace, what counts as recent bytes, and what the instructor is told was seen when.
  const now = Date.now(), live = await db.prepare('SELECT o.flags_json,o.ends_at,s.ended_at FROM class_run_ops o LEFT JOIN sessions s ON s.id=o.class_run_id WHERE o.class_run_id=?').bind(runId).first<{ flags_json: string; ends_at: number; ended_at: string | null }>();
  const closed = !live ? 'run_not_found' : !parseFlags(live.flags_json).ops_collect ? 'ops_collect_disabled' : live.ended_at || now > live.ends_at ? 'run_ended' : '';
  // AT-41 — what a verified record actually spans, from the binding it was sealed under (not from the device's later claims).
  // Unreadable → `extent` is absent and the page says so; it is never filled in as "the whole lesson".
  const extents = new Map<string, Record<string, unknown>>();
  try {
    for (const r of ((await db.prepare("SELECT i.seat_id,g.range_json FROM classroom_collect_items i JOIN classroom_snapshots s ON s.batch_id=i.batch_id AND s.student_id=i.student_id AND s.receipt_id=i.receipt_id JOIN classroom_snapshot_bindings g ON g.batch_id=s.batch_id AND g.student_id=s.student_id AND g.revision=s.revision WHERE i.batch_id=? AND i.state='verified'").bind(id).all()).results ?? []) as Array<{ seat_id: string; range_json: string }>) {
      const r0 = JSON.parse(r.range_json) as Record<string, unknown> | null; if (!r0) continue;
      // Numbers and times only, under view names — the view never carries a spool session id or any content.
      // U1b extents add kinds, per-session parts, what arrived / was not sent by category and every reason — still no session id.
      extents.set(r.seat_id, Object.fromEntries(([['lines', 'lines'], ['from_ts', 'from_ts'], ['to_ts', 'to_ts'], ['first_seq', 'first_seq'], ['last_seq', 'last_seq'], ['spool_last_seq', 'session_last_seq'], ['others_in_window', 'other_sessions_in_window'], ['included', 'included'], ['kinds', 'kinds'], ['sessions', 'sessions'], ['parts', 'parts'], ['received', 'received'], ['not_sent', 'not_sent'], ['omitted', 'omitted'], ['reasons', 'reasons']] as const).filter(([, k]) => r0[k] !== undefined).map(([v, k]) => [v, r0[k]])));
    }
  } catch (err) { console.error('collect extent unavailable:', err); }
  // U3 → U1b: under how many lesson bases the verified input was made (the Service's turn ledger, sealed with it). Absent = unknown.
  const bases = new Map<string, { basis: string; lessons: number }>();
  try {
    for (const r of ((await db.prepare("SELECT i.seat_id,ib.basis,ib.lessons FROM classroom_collect_items i JOIN classroom_snapshots s ON s.batch_id=i.batch_id AND s.student_id=i.student_id AND s.receipt_id=i.receipt_id JOIN classroom_input_basis ib ON ib.batch_id=s.batch_id AND ib.student_id=s.student_id AND ib.revision=s.revision WHERE i.batch_id=? AND i.state='verified'").bind(id).all()).results ?? []) as Array<{ seat_id: string; basis: string; lessons: number }>) bases.set(r.seat_id, { basis: r.basis, lessons: r.lessons });
  } catch { /* no U3 tables, or unreadable: the view says the basis is unknown */ }
  for (const i of items) {
    i.request = delivery.get(i.seat_id) ?? null;
    if (i.state !== 'not_selected') { i.status = collectStatus(i as never, { now, upload_until: Number(b.upload_until) }); i.outcome = collectOutcome(i.status.phase); } // U4: the same verdict words as recovery; `resolved` = the Service verified the receipt, never the device's 'sent'
    if (i.state === 'verified') { i.coverage_reason = i.reason ?? ''; const e = extents.get(i.seat_id); if (e) i.extent = e; const bs = bases.get(i.seat_id); if (bs) i.basis = bs; }
  }
  return { observed_at: now, batch: { ...b, dry_run: b.dry_run === 1, scope: sc.scope, mode: sc.mode, targets: sc.targets, ...(sc.kinds ? { kinds: sc.kinds } : {}), upload_open: now < Number(b.upload_until), new_request_allowed: !closed, new_request_blocked_by: closed }, summary: { roster: items.length, selected: selected.length, not_selected: items.length - selected.length, by_state: by,
    // "Collected" is only what the Service verified. Arrived bytes and complete behaviour coverage are separate counts.
    verified: by.verified ?? 0, verified_complete_coverage: items.filter((i) => i.state === 'verified' && i.coverage === 'complete').length, held: items.filter((i) => ['consent_missing', 'guardian_consent_missing', 'withdrawn'].includes(i.state)).length }, items };
}
classroomCollectTeacher.post(root, bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
  const t = await teacher(c); if (t instanceof Response) return t; const { auth, run } = t, b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  const norm = normalizeCollectRequest(b, MAX_SEATS); if (!norm.ok) return c.json({ error: norm.detail, reason: norm.reason }, 400);
  const req = norm.value, requestHash = await sha256Hex(collectRequestCanonical(req));
  // Same key + same request = the same batch, even if the response was lost and the roster has moved since. Same key +
  // anything else (other seats, purpose, notice, mode, dry-run, revision) is a different request and is refused.
  const prior = await db.prepare('SELECT id,roster_revision,purpose,notice_version,dry_run FROM classroom_collect_batches WHERE class_run_id=? AND idempotency_key=?').bind(run.class_run_id, req.idempotency_key).first<{ id: string; roster_revision: number; purpose: string; notice_version: string; dry_run: number }>();
  if (prior) {
    let held: BatchScope; try { held = await batchScope(db, prior.id); } catch (err) { const no = scopeRefusal(c, err); if (no) return no; throw err; }
    const priorHash = held.request_hash || await sha256Hex(collectRequestCanonical({ scope: 'roster', mode: 'finish', targets: [], purpose: prior.purpose, notice_version: prior.notice_version, dry_run: prior.dry_run === 1, roster_revision: prior.roster_revision }));
    return priorHash === requestHash ? c.json(await batchView(db, run.class_run_id, prior.id), 200) : c.json({ error: 'this idempotency key was used for a different collection request', reason: 'idempotency_conflict' }, 409);
  }
  if (req.roster_revision !== run.roster_revision) return c.json({ error: 'roster changed; reload before collecting', reason: 'revision_conflict', roster_revision: run.roster_revision }, 409);
  // A NEW selected collection is a request made during the class. After the run has ended only uploads that were already
  // asked for may still arrive (upload_until); asking again would only produce a list of unreachable seats.
  if (req.scope === 'targets' && (run.ended_at || now > run.ends_at)) return c.json({ error: 'this class run has ended; no new collection can be requested', reason: 'run_ended' }, 409);
  // The batch is the class-run roster snapshot — never the gallery, never "whoever uploaded something".
  const seats = ((await db.prepare(`SELECT s.seat_id,s.seat_revision,s.student_id,(SELECT g.id||'|'||g.connection_epoch FROM ops_grants g WHERE g.class_run_id=s.class_run_id AND g.seat_id=s.seat_id AND g.seat_revision=s.seat_revision AND g.kind='connection' AND g.state='active' AND g.expires_at>?2 ORDER BY g.created_at DESC LIMIT 1) AS conn,
 (SELECT 1 FROM classroom_collect_tombstones t WHERE t.class_run_id=s.class_run_id AND t.student_id=s.student_id) AS withdrawn FROM class_run_seats s WHERE s.class_run_id=?1 AND s.replaced_at IS NULL ORDER BY s.seat_id`).bind(run.class_run_id, now).all()).results ?? []) as Array<{ seat_id: string; seat_revision: number; student_id: string; conn: string | null; withdrawn: number | null }>;
  if (req.scope === 'targets') { const outside = req.targets.filter((t) => !seats.some((s) => s.seat_id === t)); if (outside.length) return c.json({ error: 'a selected seat is not in this class run', reason: 'seat_not_found', seats: outside.slice(0, 20) }, 404); }
  const chosen = req.scope === 'targets' ? new Set(req.targets) : null;
  const profile = getProfile(run.profile_id), minor = !profile || isMinorCohort(profile), id = crypto.randomUUID(), commandId = crypto.randomUUID();
  // ── decide from what was read … ──
  const ask: typeof seats = [], items: Array<{ s: (typeof seats)[number]; state: string; consentId: string }> = [];
  for (const s of seats) {
    // A seat that was not selected is listed and nothing else: no consent is looked up, no command, no upload door.
    if (chosen && !chosen.has(s.seat_id)) { items.push({ s, state: 'not_selected', consentId: '' }); continue; }
    const consent = await liveConsent(db, run.class_run_id, s.student_id, req.purpose, req.notice_version, now);
    const okConsent = consent && (CONSENT_BASES as readonly string[]).includes(consent.basis) && (!minor || consent.basis === 'guardian_verified');
    const state = s.withdrawn ? 'withdrawn' : !okConsent ? (minor ? 'guardian_consent_missing' : 'consent_missing') : !s.conn ? 'not_connected' : 'requested';
    if (state === 'requested' && !req.dry_run) ask.push(s);
    items.push({ s, state, consentId: okConsent ? consent!.id : '' });
  }
  // ── … and commit only if all of it is STILL true at the commit. Reads above and writes below are not one transaction by
  // themselves: between them a seat can change hands, the class can end, collection can be switched off, a learner can
  // withdraw (reproduced 2026-09-21, management-20260921/selected-roster-race-check.mjs: the request named student-a's seat
  // and the command went to student-b). The first INSERT carries the whole precondition; every other write exists only if
  // that row does. One D1 batch = one transaction, so the outcome is all of it or none of it — never a re-read and a hope.
  const roster = JSON.stringify(seats.map((s) => [s.seat_id, s.seat_revision, s.student_id])), askedConsents = JSON.stringify(items.filter((x) => x.state === 'requested').map((x) => x.consentId)), askedStudents = JSON.stringify(items.filter((x) => x.state === 'requested').map((x) => x.s.student_id));
  const guard = `EXISTS (SELECT 1 FROM class_run_ops o WHERE o.class_run_id=?1 AND o.roster_revision=?2 AND json_extract(o.flags_json,'$.ops_collect')=1 AND (?3=0 OR (o.ends_at>?4 AND NOT EXISTS (SELECT 1 FROM sessions z WHERE z.id=o.class_run_id AND z.ended_at IS NOT NULL))))
 AND (SELECT count(*) FROM class_run_seats x WHERE x.class_run_id=?1 AND x.replaced_at IS NULL)=json_array_length(?5)
 AND NOT EXISTS (SELECT 1 FROM json_each(?5) j WHERE NOT EXISTS (SELECT 1 FROM class_run_seats x WHERE x.class_run_id=?1 AND x.replaced_at IS NULL AND x.seat_id=json_extract(j.value,'$[0]') AND x.seat_revision=json_extract(j.value,'$[1]') AND x.student_id=json_extract(j.value,'$[2]')))
 AND (SELECT count(*) FROM classroom_consents k WHERE k.id IN (SELECT value FROM json_each(?6)) AND k.revoked_at IS NULL AND k.expires_at>?4)=json_array_length(?6)
 AND NOT EXISTS (SELECT 1 FROM classroom_collect_tombstones t WHERE t.class_run_id=?1 AND t.student_id IN (SELECT value FROM json_each(?7)))`;
  const committed = 'EXISTS (SELECT 1 FROM classroom_collect_batches WHERE id=?)';
  const stmts = [
    db.prepare(`INSERT INTO classroom_collect_batches(id,class_run_id,cohort_id,profile_id,roster_revision,purpose,notice_version,dry_run,idempotency_key,created_by,created_at,upload_until) SELECT ?8,?1,?9,?10,?2,?11,?12,?13,?14,?15,?4,?16 WHERE ${guard}`).bind(run.class_run_id, req.roster_revision, req.scope === 'targets' ? 1 : 0, now, roster, askedConsents, askedStudents, id, run.cohort_id, run.profile_id, req.purpose, req.notice_version, req.dry_run ? 1 : 0, req.idempotency_key, auth.payload.u, Math.max(run.ends_at, now) + UPLOAD_GRACE_MS),
    db.prepare(`INSERT INTO classroom_collect_scopes(batch_id,class_run_id,scope,mode,targets_json,request_hash,created_at) SELECT ?,?,?,?,?,?,? WHERE ${committed}`).bind(id, run.class_run_id, req.scope, req.mode, JSON.stringify(req.targets), requestHash, now, id),
    ...(req.kinds ? [db.prepare(`INSERT INTO classroom_collect_kinds(batch_id,class_run_id,kinds_json,created_at) SELECT ?,?,?,? WHERE ${committed}`).bind(id, run.class_run_id, JSON.stringify(req.kinds), now, id)] : []),
  ];
  for (const x of items) stmts.push(db.prepare(`INSERT INTO classroom_collect_items(batch_id,seat_id,seat_revision,student_id,state,reason,consent_id,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE ${committed}`).bind(id, x.s.seat_id, x.s.seat_revision, x.s.student_id, x.state, x.state === 'requested' ? '' : x.state, x.consentId, now, id));
  if (ask.length) {
    // The request to devices rides the existing command ledger: same lease, epoch, TTL and receipts. The batch id is set here, never by the instructor.
    stmts.push(db.prepare(`INSERT INTO ops_commands(id,class_run_id,cohort_id,action,args_json,payload_hash,idempotency_key,issued_by,issuer_jti,reason_code,created_at,expires_at) SELECT ?,?,?,'retry_evidence_upload',?,?,?,?,?,'class_management',?,? WHERE ${committed}`).bind(commandId, run.class_run_id, run.cohort_id, JSON.stringify({ batch_id: id, purpose: req.purpose, notice_version: req.notice_version, ...(req.kinds ? { kinds: req.kinds, sessions: 'window' } : {}) }), await sha256Hex(id), 'collect-' + id, auth.payload.u, auth.payload.jti ?? null, now, now + COMMAND_TTL_MS, id));
    for (const s of ask) { const [grantId, epoch] = s.conn!.split('|'); stmts.push(db.prepare(`INSERT INTO ops_command_targets(command_id,class_run_id,seat_id,seat_revision,grant_id,connection_epoch,mutating,state,expires_at,updated_at) SELECT ?,?,?,?,?,?,0,'queued',?,? WHERE ${committed}`).bind(commandId, run.class_run_id, s.seat_id, s.seat_revision, grantId, Number(epoch), now + COMMAND_TTL_MS, now, id)); }
  }
  stmts.push(db.prepare(`INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) SELECT ?,'','instructor',?,'collect_batch_created',?,? WHERE ${committed}`).bind(run.class_run_id, auth.payload.u, JSON.stringify({ batch_id: id, dry_run: req.dry_run, scope: req.scope, mode: req.mode, ...(req.kinds ? { kinds: req.kinds } : {}), selected: chosen ? chosen.size : seats.length, requested: ask.length, roster: seats.length }), now, id));
  try { await db.batch(stmts); } catch (err) {
    // Two clicks raced: the other one created the batch for this key. The loser gets that batch if it asked for the same thing.
    const won = await db.prepare('SELECT id FROM classroom_collect_batches WHERE class_run_id=? AND idempotency_key=?').bind(run.class_run_id, req.idempotency_key).first<{ id: string }>().catch(() => null);
    if (won) { let w: BatchScope; try { w = await batchScope(db, won.id); } catch (e2) { const no = scopeRefusal(c, e2); if (no) return no; throw e2; } return w.request_hash === requestHash ? c.json(await batchView(db, run.class_run_id, won.id), 200) : c.json({ error: 'this idempotency key was used for a different collection request', reason: 'idempotency_conflict' }, 409); }
    console.error('collect batch failed:', err); return c.json({ error: 'batch not recorded; nothing was requested', reason: 'storage' }, 503);
  }
  // The precondition did not hold at the commit: nothing at all was written. Say which part moved, from a fresh read.
  if (!(await db.prepare('SELECT 1 AS ok FROM classroom_collect_batches WHERE id=?').bind(id).first())) {
    const live = await db.prepare('SELECT o.roster_revision,o.flags_json,o.ends_at,s.ended_at FROM class_run_ops o LEFT JOIN sessions s ON s.id=o.class_run_id WHERE o.class_run_id=?').bind(run.class_run_id).first<{ roster_revision: number; flags_json: string; ends_at: number; ended_at: string | null }>();
    const reason = !live || live.roster_revision !== req.roster_revision ? 'revision_conflict' : !parseFlags(live.flags_json).ops_collect ? 'ops_collect_disabled' : req.scope === 'targets' && (live.ended_at || Date.now() > live.ends_at) ? 'run_ended' : 'changed_during_request';
    return c.json({ error: 'the class run, a seat or a consent changed while this collection was being recorded; nothing was requested — reload and select again', reason, ...(live ? { roster_revision: live.roster_revision } : {}) }, reason === 'ops_collect_disabled' ? 403 : 409);
  }
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
