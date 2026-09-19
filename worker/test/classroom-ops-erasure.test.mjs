// Remote classroom operations (#751) — withdrawal and retention reach what was already collected,
// and nothing late can bring it back. Real routes, SQLite, in-memory R2; synthetic learners.
import assert from 'node:assert/strict';
import test from 'node:test';
import { localOps } from './harness/classroom-ops.mjs';
import { CANDIDATE_CAPABILITY_V1 } from '../src/lib/measurement-core/index.ts';
const { registerDeliveryAdapter } = await import('../src/routes/classroom-delivery.ts');
const admin = { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') }, seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }];
const words = 'SYNTHETIC LEARNER WORDS 기대 조건을 먼저 적음';
async function delivered(t) {
  const f = await localOps(); t.after(() => f.close());
  await f.freeze(); assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true, ops_delivery: true } })).status, 201);
  const conns = []; for (let i = 0; i < 2; i++) { const c = (await f.pair(seats[i].seat_id, 1, i + 1)).conn.json; conns.push(c); await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential); }
  const batch = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false })).json.batch.id, B = f.base + '/report-batches/' + batch;
  const ev = JSON.stringify({ type: 'prompt', event_id: 'e1', text: words }) + '\n'; for (const c of conns) assert.equal((await f.uploadSnapshotAs(c, batch, 1, ev)).status, 201);
  await f.request(B + '/jobs', 'POST', {}); const runner = (await f.request(B + '/runner-grants', 'POST', {})).json.runner_credential, keys = CANDIDATE_CAPABILITY_V1.capabilities.map((c) => c.key);
  for (let i = 0; i < 2; i++) { const j = (await f.request('/v1/classroom/ops/runner/claim', 'POST', {}, runner)).json.job; await f.request(`/v1/classroom/ops/runner/jobs/${j.id}/result`, 'POST', { lease_generation: j.lease_generation, draft: { format: 'hps-classroom-report-draft/1', versions: { capability_model: { id: CANDIDATE_CAPABILITY_V1.id, revision: 1 }, rubric: 'unknown', evaluator: 'none', renderer_revision: 'observation-report/1' }, findings: [{ capability: keys[0], status: 'observed', claim: 'c', evidence: [{ event_id: 'e1', quote: words }] }, ...keys.slice(1).map((capability) => ({ capability, status: 'unobserved', claim: '', evidence: [] }))], next_experiment: '' } }, runner); }
  for (const j of (await f.request(B + '/reports')).json.jobs) await f.request(B + `/reports/${j.id}/review`, 'PUT', { decision: 'approve', expected_revision: j.revision, draft_digest: j.draft_digest });
  await f.request('/admin/classroom/recipients', 'POST', { class_run_id: f.run, source_ref: 'synthetic-import', recipients: seats.map((s) => ({ student_id: s.student_id, recipient_ref: 'guardian-' + s.seat_id, channel: 'email', address: s.seat_id.toLowerCase() + '@example.invalid' })) }, null, admin);
  const sent = [], id = 'erasure-adapter-' + crypto.randomUUID(); registerDeliveryAdapter({ id, external: true, send: async (m) => { sent.push(m); return { status: 'accepted', provider_message_id: 'synthetic-' + sent.length }; } }); f.env.HPS_DELIVERY_PROVIDER = id;
  const scope = (await f.request(B + '/recipients?template_revision=t1')).json, approval = (await f.request(B + '/approve', 'POST', { template_revision: 't1', channel: 'email', scope_hash: scope.scope_hash })).json.approval_id;
  assert.equal((await f.request(B + '/deliver', 'POST', { approval_id: approval, dry_run: false })).status, 202);
  const holds = (needle) => [...f.r2.entries()].filter(([, v]) => new TextDecoder().decode(v).includes(needle)).map(([k]) => k);
  return { ...f, conns, batch, B, sent, holds, ev };
}

test('withdrawal removes the learner\'s stored words, drafts and links — for that learner only — and keeps a content-free record', async (t) => {
  const f = await delivered(t), linkA = f.sent.find((m) => m.to.startsWith('a1')).link, linkB = f.sent.find((m) => m.to.startsWith('a2')).link;
  assert.equal(f.holds(words).length, 4, 'precondition: two snapshots and two drafts hold the words'); assert.equal((await f.request(linkA, 'GET', undefined, null)).status, 200);
  const w = await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: false, purpose: 'class_report', notice_version: 'notice-v1' }, f.conns[0].credential);
  assert.equal(w.status, 200, w.raw); assert.deepEqual(w.json.erased, { snapshot_objects: 2, report_objects: 1, links_revoked: 1, jobs_closed: 1, outbox_cancelled: 0, deliveries_already_sent: 1 }); assert.match(w.json.note, /cannot be recalled/);
  assert.deepEqual(f.holds(words).map((k) => k.includes('/student-b/')), [true, true], 'only the other learner\'s objects remain');
  assert.equal((await f.request(linkA, 'GET', undefined, null)).status, 404, 'the mail already sent now opens nothing'); assert.equal((await f.request(linkB, 'GET', undefined, null)).status, 200);
  const jobs = (await f.request(f.B + '/reports')).json.jobs; assert.deepEqual(jobs.map((j) => [j.student_id, j.state, j.draft_digest === '']), [['student-a', 'withdrawn', true], ['student-b', 'approved', false]]);
  assert.equal((await f.request(f.B + '/reports/' + jobs[0].id)).json.draft, null, 'a reviewer can no longer open the withdrawn draft');
  // What stays is content-free: states, ids, digests, and the audit of the erasure itself.
  const kept = JSON.stringify([f.db.prepare('SELECT * FROM classroom_report_deliveries').all(), f.db.prepare("SELECT * FROM ops_audit WHERE action='collection_erased'").all(), f.db.prepare('SELECT * FROM classroom_collect_items').all()]);
  assert.ok(!kept.includes('SYNTHETIC LEARNER WORDS')); assert.equal(f.db.prepare("SELECT count(*) n FROM classroom_report_deliveries WHERE student_id='student-a'").get().n, 1, 'the delivery ledger is not rewritten');
});

test('nothing late brings it back: a device retry, a re-run of "수업 마무리", a new batch and a new send all leave the withdrawn learner out', async (t) => {
  const f = await delivered(t); await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: false, purpose: 'class_report', notice_version: 'notice-v1' }, f.conns[0].credential);
  const before = f.r2.size, late = await f.uploadSnapshotAs(f.conns[0], f.batch, 2, f.ev); assert.deepEqual([late.status, late.json.reason], [403, 'withdrawn']); assert.equal(f.r2.size, before);
  const adv = await f.request(f.B + '/advance', 'POST', {}); assert.equal(adv.json.created.inputs, 0); assert.ok(!adv.json.jobs.some((j) => j.student_id === 'student-a' && !['withdrawn', 'missing'].includes(j.state)));
  const next = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false })).json; assert.equal(next.items.find((i) => i.student_id === 'student-a').state, 'withdrawn');
  const scope = (await f.request(f.B + '/recipients?template_revision=t2')).json; assert.deepEqual(scope.will_send.map((x) => x.student_id), ['student-b']); assert.deepEqual(scope.not_sending.map((x) => x.student_id), ['student-a']);
});

test('operator erasure: a guardian\'s instruction for one child, and retention for a finished run — stated period, dry run first, never before it is due', async (t) => {
  const f = await delivered(t), E = (body) => f.request('/admin/classroom/erasures', 'POST', body, null, admin);
  assert.equal((await f.request('/admin/classroom/erasures', 'POST', { class_run_id: f.run, reason: 'withdrawn', student_id: 'student-b', dry_run: true })).status, 401, 'an instructor cannot erase');
  assert.equal((await E({ class_run_id: f.run, reason: 'retention', dry_run: true })).status, 400, 'there is no default retention period');
  assert.equal((await E({ class_run_id: f.run, reason: 'retention', retention_days: 90, dry_run: false })).json.reason, 'retention_not_due');
  assert.deepEqual((await E({ class_run_id: f.run, reason: 'withdrawn', student_id: 'student-b', dry_run: true })).json, { dry_run: true, students: 1 }); assert.equal(f.holds(words).length, 4, 'a dry run removes nothing');
  const one = await E({ class_run_id: f.run, reason: 'withdrawn', student_id: 'student-b', dry_run: false }); assert.equal(one.json.erased[0].snapshot_objects, 2); assert.equal(f.holds(words).filter((k) => k.includes('/student-b/')).length, 0);
  f.db.prepare('UPDATE class_run_ops SET ends_at=?').run(Date.now() - 91 * 86_400_000);
  const all = await E({ class_run_id: f.run, reason: 'retention', retention_days: 90, dry_run: false }); assert.equal(all.status, 200, all.raw); assert.equal(f.holds(words).length, 0, 'after the period no learner text of this run is left');
  assert.equal(f.db.prepare("SELECT count(*) n FROM classroom_report_jobs WHERE state<>'withdrawn'").get().n, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM classroom_report_links WHERE revoked_at IS NULL').get().n, 0);
  assert.deepEqual((await E({ class_run_id: f.run, reason: 'retention', retention_days: 90, dry_run: false })).json.erased.map((x) => x.snapshot_objects), [0, 0], 'running it again is harmless');
});
