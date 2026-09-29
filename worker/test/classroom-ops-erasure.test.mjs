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
  await f.request('/admin/classroom/recipients', 'POST', { class_run_id: f.run, source_ref: 'synthetic-import', recipients: seats.map((s) => ({ student_id: s.student_id, recipient_ref: 'guardian-' + s.seat_id, channel: 'email', address: s.seat_id.toLowerCase() + '@example.invalid', viewer_check: { kind: 'phone_last4', value: '4821' } })) }, null, admin);
  const sent = [], id = 'erasure-adapter-' + crypto.randomUUID(); registerDeliveryAdapter({ id, external: true, send: async (m) => { sent.push(m); return { status: 'accepted', provider_message_id: 'synthetic-' + sent.length }; } }); f.env.HPS_DELIVERY_PROVIDER = id;
  const scope = (await f.request(B + '/recipients?template_revision=t1')).json, approval = (await f.request(B + '/approve', 'POST', { template_revision: 't1', channel: 'email', scope_hash: scope.scope_hash })).json.approval_id;
  assert.equal((await f.request(B + '/deliver', 'POST', { approval_id: approval, dry_run: false })).status, 202);
  const holds = (needle) => [...f.r2.entries()].filter(([, v]) => new TextDecoder().decode(v).includes(needle)).map(([k]) => k);
  return { ...f, conns, batch, B, sent, holds, ev };
}

test('withdrawal removes the learner\'s stored words, drafts and links — for that learner only — and keeps a content-free record', async (t) => {
  const f = await delivered(t), linkA = f.sent.find((m) => m.to.startsWith('a1')).link, linkB = f.sent.find((m) => m.to.startsWith('a2')).link;
  assert.equal(f.holds(words).length, 4, 'precondition: two snapshots and two drafts hold the words'); const openWith = (l) => f.request(l + '?format=json', 'POST', { check: '4821' }, null); assert.equal((await openWith(linkA)).status, 200);
  const w = await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: false, purpose: 'class_report', notice_version: 'notice-v1' }, f.conns[0].credential);
  assert.equal(w.status, 200, w.raw); assert.deepEqual(w.json.erased, { snapshot_objects: 2, report_objects: 1, links_revoked: 1, jobs_closed: 1, outbox_cancelled: 0, deliveries_already_sent: 1 }); assert.match(w.json.note, /cannot be recalled/);
  assert.deepEqual(f.holds(words).map((k) => k.includes('/student-b/')), [true, true], 'only the other learner\'s objects remain');
  assert.equal((await openWith(linkA)).status, 404, 'the mail already sent now opens nothing, even with the right check'); assert.equal((await openWith(linkB)).status, 200);
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

// ── scheduled retention: OFF by default, dry-run before enforce, fake clock, interrupted erasures are retried ──
const { runClassroomRetention, retentionConfig, runClassroomErasureRecovery, SETTLE_AFTER_MS, ERASURE_RETRY_STEPS_MS, MAX_ERASURE_ATTEMPTS } = await import('../src/lib/classroom-erasure.ts');
const DAY = 86_400_000;
test('retention is OFF unless a period is set; an invalid period switches it off instead of being guessed; a period alone only reports', async (t) => {
  const f = await delivered(t), future = Date.now() + 400 * DAY;
  assert.deepEqual(retentionConfig(f.env), { mode: 'off', days: null }); assert.deepEqual(await runClassroomRetention(f.env, future), { mode: 'off', days: null, due_runs: 0, due_learners: 0, erased: 0, failed: 0, remaining: 0 });
  for (const bad of ['0', '-5', '30.5', 'ninety', '99999', ' 30']) { f.env.HPS_CLASSROOM_RETENTION_DAYS = bad; f.env.HPS_CLASSROOM_RETENTION = 'enforce'; const r = await runClassroomRetention(f.env, future); assert.deepEqual([r.mode, r.problem, r.erased], ['off', 'retention_days_invalid', 0], bad); }
  assert.equal(f.holds(words).length, 4, 'nothing was deleted by any of the above');
  f.env.HPS_CLASSROOM_RETENTION_DAYS = '90'; delete f.env.HPS_CLASSROOM_RETENTION;
  assert.deepEqual(await runClassroomRetention(f.env, Date.now() + 30 * DAY), { mode: 'dry-run', days: 90, due_runs: 0, due_learners: 0, erased: 0, failed: 0, remaining: 0 }, 'before the period ends nothing is even due');
  assert.deepEqual(await runClassroomRetention(f.env, future), { mode: 'dry-run', days: 90, due_runs: 1, due_learners: 2, erased: 0, failed: 0, remaining: 2 }); assert.equal(f.holds(words).length, 4, 'a dry run reports and deletes nothing');
  f.env.HPS_CLASSROOM_RETENTION = 'enforce'; delete f.env.HPS_CLASSROOM_OPS; assert.equal((await runClassroomRetention(f.env, future)).mode, 'off', 'the global operations switch gates it too');
});
test('retention enforce: due runs only, bounded per tick; an interrupted erasure is finished by recovery under its own reason; running again is harmless', async (t) => {
  const f = await delivered(t), future = Date.now() + 400 * DAY; Object.assign(f.env, { HPS_CLASSROOM_RETENTION_DAYS: '90', HPS_CLASSROOM_RETENTION: 'enforce' });
  const realDelete = f.env.HPS_TRACES.delete; let broken = true; f.env.HPS_TRACES.delete = async (k) => { if (broken && k.includes('/student-b/')) throw Error('injected R2 outage'); return realDelete(k); };
  const first = await runClassroomRetention(f.env, future, 50); assert.deepEqual([first.due_learners, first.erased, first.failed, first.remaining], [2, 1, 1, 1]);
  assert.deepEqual(f.db.prepare('SELECT student_id,state,attempts,last_error FROM classroom_erasure_log ORDER BY student_id').all().map((r) => ({ ...r })), [{ student_id: 'student-a', state: 'done', attempts: 1, last_error: '' }, { student_id: 'student-b', state: 'started', attempts: 1, last_error: 'content_delete_failed' }]);
  assert.ok(f.holds(words).every((k) => k.includes('/student-b/')), 'student-a is gone; student-b\'s content is still there and known to be'); assert.equal(f.db.prepare("SELECT count(*) n FROM classroom_report_links WHERE revoked_at IS NULL").get().n, 0, 'but nothing of it can be opened any more');
  broken = false; const again = await runClassroomRetention(f.env, future + DAY, 50); assert.deepEqual([again.due_learners, again.erased], [0, 0], 'an erasure that is already in the ledger is recovery\'s, not a new retention erasure');
  const second = await runClassroomErasureRecovery(f.env, future + DAY); assert.deepEqual([second.finished, second.failed], [1, 0]); assert.equal(f.holds(words).length, 0); assert.equal(f.db.prepare("SELECT reason FROM classroom_erasure_log WHERE student_id='student-b'").get().reason, 'retention', 'finished under the reason it was started for');
  assert.deepEqual(await runClassroomRetention(f.env, future + 2 * DAY, 50), { mode: 'enforce', days: 90, due_runs: 0, due_learners: 0, erased: 0, failed: 0, remaining: 0 }, 'a finished run is never selected again');
  assert.equal(f.db.prepare("SELECT count(*) n FROM ops_audit WHERE action='collection_erased'").get().n, 2, 'one audit row per learner, not one per tick');
});
test('retention rides the existing daily cron and nothing else: the 15-minute tick does not run it, and the per-tick bound leaves the rest for the next day', async (t) => {
  const f = await delivered(t); Object.assign(f.env, { HPS_CLASSROOM_RETENTION_DAYS: '1', HPS_CLASSROOM_RETENTION: 'enforce' }); f.db.prepare('UPDATE class_run_ops SET ends_at=?').run(Date.now() - 2 * DAY);
  const { default: worker } = await import('../src/index.ts'), pending = [], ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) , passThroughOnException() {} };
  await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, f.env, ctx); await Promise.all(pending); assert.equal(f.holds(words).length, 4, 'the heartbeat tick leaves classroom data alone');
  pending.length = 0; await worker.scheduled({ cron: '0 17 * * *', scheduledTime: Date.now() }, f.env, ctx); await Promise.all(pending); assert.equal(f.holds(words).length, 0, 'the daily tick applied the configured period');
  const g = await delivered(t); Object.assign(g.env, { HPS_CLASSROOM_RETENTION_DAYS: '1', HPS_CLASSROOM_RETENTION: 'enforce' });
  const bounded = await runClassroomRetention(g.env, Date.now() + 10 * DAY, 1); assert.deepEqual([bounded.erased, bounded.remaining], [1, 1]);
});

// ── 2026-09-20 review: a result that arrives after the erasure, and a withdrawal whose deletion was interrupted ──
// Order is forced with barriers at the provider and at the R2 write, never with a sleep. R2 and D1 share no transaction,
// so "done" has to stay true when the late party finishes — and when it never gets the chance to clean up after itself.
const { setEvaluatorTransport } = await import('../src/routes/classroom-reports.ts');
const sha = async (buf) => Buffer.from(await crypto.subtle.digest('SHA-256', buf)).toString('hex');
const gate = () => { let open, reached; const wait = new Promise((r) => { open = r; }), hit = new Promise((r) => { reached = r; }); return { wait, hit, open: () => open(), reached: () => reached() }; };
const answer = async (request) => { const own = JSON.parse(request.messages[0].content).evidence_catalog.find((q) => q.basis);
  return Response.json({ content: [{ type: 'text', text: JSON.stringify({ findings: [{ capability: 'FRAMING', status: 'observed', claim: '기대 조건을 먼저 적음', evidence: [{ quote_id: own.quote_id }], assistance: 'unknown' }], next_experiment: '' }) }] }); };
async function collected(t) {
  const f = await localOps(); t.after(() => { setEvaluatorTransport(undefined); f.close(); }); Object.assign(f.env, { HPS_CLASSROOM_EVALUATOR: 'service-anthropic', ANTHROPIC_API_KEY: 'synthetic-not-a-key' });
  await f.freeze(); assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true } })).status, 201);
  const conns = []; for (let i = 0; i < 2; i++) { const c = (await f.pair(seats[i].seat_id, 1, i + 1)).conn.json; conns.push(c); await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential); }
  const batch = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false })).json.batch.id, B = f.base + '/report-batches/' + batch;
  const ev = JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), type: 'prompt', turn_id: 't1', text: words }) + '\n'; for (const c of conns) assert.equal((await f.uploadSnapshotAs(c, batch, 1, ev)).status, 201);
  const of = (student, kind = '') => [...f.r2.keys()].filter((k) => k.startsWith('classroom-' + kind) && k.includes(`/${student}/`)), ledger = () => f.db.prepare('SELECT student_id,reason,state,attempts,last_error FROM classroom_erasure_log ORDER BY student_id').all().map((r) => ({ ...r }));
  const withdraw = (i) => f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: false, purpose: 'class_report', notice_version: 'notice-v1' }, conns[i].credential);
  return { ...f, conns, batch, B, of, ledger, withdraw, advance: () => f.request(B + '/advance', 'POST', {}) };
}

test('erasure race (Codex reproduction): the learner withdraws and the erasure is DONE while the provider is still answering — the late answer stores nothing, now or 40 days later', async (t) => {
  const f = await collected(t), g = gate(); let calls = 0; setEvaluatorTransport(async (req) => { const r = await answer(req); if (++calls === 1) { g.reached(); await g.wait; } return r; });
  const advancing = f.advance(); await g.hit;
  const w = await f.withdraw(0); assert.equal(w.status, 200, w.raw); assert.deepEqual(f.ledger(), [{ student_id: 'student-a', reason: 'withdrawn', state: 'done', attempts: 1, last_error: '' }]); assert.deepEqual(f.of('student-a'), []);
  g.open(); const late = await advancing; assert.equal(late.status, 200, late.raw);
  assert.deepEqual(f.of('student-a'), [], 'the answer that came back after the erasure did not become an object');
  assert.equal(f.db.prepare("SELECT state FROM classroom_report_jobs WHERE student_id='student-a'").get().state, 'withdrawn'); assert.equal(f.ledger()[0].state, 'done');
  // The next learner is evaluated as usual: one body, exactly the committed one.
  let more = late.json.more; for (let i = 0; more && i < 5; i++) more = (await f.advance()).json.more;
  const b = f.db.prepare("SELECT state,draft_digest FROM classroom_report_jobs WHERE student_id='student-b'").get(), kept = f.of('student-b', 'reports'); assert.equal(b.state, 'partial'); assert.equal(kept.length, 1); assert.equal(await sha(f.r2.get(kept[0])), b.draft_digest);
  assert.equal(calls, 2, 'the withdrawn learner was not sent to the provider a second time'); assert.equal(f.of('student-b', 'snapshots').length, 2);
  Object.assign(f.env, { HPS_CLASSROOM_RETENTION_DAYS: '30', HPS_CLASSROOM_RETENTION: 'enforce' }); await runClassroomErasureRecovery(f.env, Date.now() + 40 * DAY); await runClassroomRetention(f.env, Date.now() + 40 * DAY);
  assert.equal([...f.r2.keys()].length, 0, 'and after the period nothing of either learner is left');
});

test('erasure race: the body write is in flight when the erasure finishes — D1 refuses the result and the body is removed in the same request', async (t) => {
  const f = await collected(t), g = gate(), put = f.env.HPS_TRACES.put; let held = false; setEvaluatorTransport(answer);
  f.env.HPS_TRACES.put = async (k, v, o) => { if (!held && k.startsWith('classroom-reports/')) { held = true; g.reached(); await g.wait; } return put(k, v, o); };
  const advancing = f.advance(); await g.hit; const e = await f.request('/admin/classroom/erasures', 'POST', { class_run_id: f.run, reason: 'withdrawn', student_id: 'student-a', dry_run: false }, null, admin); assert.equal(e.status, 200, e.raw);
  assert.equal(f.ledger()[0].state, 'done'); g.open(); const late = await advancing; assert.deepEqual([late.json.step.state, late.json.step.draft_digest], ['withdrawn', ''], 'refused as a withdrawal; nothing was stored'); assert.deepEqual(f.of('student-a'), []);
});

test('erasure race: the process dies right after the late write — "done" is re-checked once the write window has closed, the leftover is removed and counted, nobody else is touched', async (t) => {
  const f = await collected(t), g = gate(), landed = gate(), put = f.env.HPS_TRACES.put; let held = false; setEvaluatorTransport(answer);
  // The write lands, and then this request never runs another line: no CAS, no compensation.
  f.env.HPS_TRACES.put = async (k, v, o) => { if (!held && k.startsWith('classroom-reports/')) { held = true; g.reached(); await g.wait; await put(k, v, o); landed.reached(); return new Promise(() => {}); } return put(k, v, o); };
  void f.advance(); await g.hit; const at = Date.now(); assert.equal((await f.withdraw(0)).status, 200); g.open(); await landed.hit;
  assert.equal(f.of('student-a', 'reports').length, 1, 'precondition: the orphan exists and holds the learner\'s words'); assert.equal(f.ledger()[0].state, 'done');
  assert.equal((await f.request(f.B + '/reports/' + f.db.prepare("SELECT id FROM classroom_report_jobs WHERE student_id='student-a'").get().id)).json.draft, null, 'it was never reachable: the job is withdrawn and has no digest');
  const early = await runClassroomErasureRecovery(f.env, at + 60_000); assert.deepEqual([early.waiting, early.settled], [1, 0], 'not before the write window has closed');
  const bBefore = f.of('student-b').sort(), tick = await runClassroomErasureRecovery(f.env, at + SETTLE_AFTER_MS + 60_000); assert.deepEqual([tick.settled, tick.late_objects, tick.failed], [1, 1, 0]);
  assert.deepEqual(f.of('student-a'), []); assert.deepEqual(f.of('student-b').sort(), bBefore); assert.equal(f.ledger()[0].state, 'settled');
  const note = f.db.prepare("SELECT detail_json FROM ops_audit WHERE action='collection_erased_late_objects'").get().detail_json; assert.deepEqual(JSON.parse(note), { student_id: 'student-a', objects: 1 });
  assert.deepEqual(await runClassroomErasureRecovery(f.env, at + 10 * DAY), { open: 0, finished: 0, failed: 0, waiting: 0, stalled: 0, settled: 0, late_objects: 0 }, 'a settled erasure is never selected again');
});

test('withdrawal retry (Codex reproduction): storage fails during the deletion — the withdrawal stands, recovery finishes it with retention OFF, and no retention erasure starts', async (t) => {
  const f = await delivered(t), del = f.env.HPS_TRACES.delete, at = Date.now(), openB = () => f.request(f.sent.find((m) => m.to.startsWith('a2')).link + '?format=json', 'POST', { check: '4821' }, null);
  f.env.HPS_TRACES.delete = async () => { throw Error('synthetic R2 unavailable'); };
  const w = await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: false, purpose: 'class_report', notice_version: 'notice-v1' }, f.conns[0].credential);
  assert.deepEqual([w.status, w.json.consent, w.json.erasure], [202, false, 'pending'], 'the withdrawal is recorded; only the removal is pending'); const led = () => ({ ...f.db.prepare("SELECT reason,state,attempts,last_error FROM classroom_erasure_log WHERE student_id='student-a'").get() });
  assert.deepEqual(led(), { reason: 'withdrawn', state: 'started', attempts: 1, last_error: 'content_delete_failed' }); assert.equal(f.db.prepare("SELECT count(*) n FROM classroom_report_links WHERE student_id='student-a' AND revoked_at IS NULL").get().n, 0, 'nothing of it opens meanwhile');
  f.env.HPS_TRACES.delete = del; assert.equal(retentionConfig(f.env).mode, 'off');
  const soon = await runClassroomErasureRecovery(f.env, at + 5 * 60_000); assert.deepEqual([soon.waiting, soon.finished], [1, 0], 'paced: not retried before the first step'); assert.equal(led().attempts, 1);
  const tick = await runClassroomErasureRecovery(f.env, at + ERASURE_RETRY_STEPS_MS[0] + 60_000); assert.deepEqual([tick.finished, tick.failed], [1, 0]);
  assert.deepEqual(led(), { reason: 'withdrawn', state: 'done', attempts: 2, last_error: '' }); assert.deepEqual(f.holds(words).map((k) => k.includes('/student-b/')), [true, true], 'what is left is the OTHER learner\'s record and draft, untouched');
  assert.equal((await openB()).status, 200); assert.equal(f.db.prepare("SELECT count(*) n FROM classroom_erasure_log WHERE student_id='student-b'").get().n, 0, 'recovery never starts an erasure nobody asked for');
  // Same with a period configured but not over: the withdrawal is still finished, retention still has nothing due.
  Object.assign(f.env, { HPS_CLASSROOM_RETENTION_DAYS: '30', HPS_CLASSROOM_RETENTION: 'enforce' }); const r = await runClassroomRetention(f.env, at + DAY); assert.deepEqual([r.due_learners, r.erased], [0, 0]); assert.equal(f.holds(words).length, 2);
});

test('withdrawal retry: paced and bounded — 15 min, 1 h, 6 h, then daily; after the limit it stops by itself, says so once, and an operator finishes it', async (t) => {
  const f = await delivered(t), del = f.env.HPS_TRACES.delete; let now = Date.now(); f.env.HPS_TRACES.delete = async () => { throw Error('synthetic R2 unavailable'); };
  assert.equal((await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: false, purpose: 'class_report', notice_version: 'notice-v1' }, f.conns[0].credential)).status, 202);
  const attempts = () => f.db.prepare("SELECT attempts FROM classroom_erasure_log WHERE student_id='student-a'").get().attempts, waits = [];
  while (attempts() < MAX_ERASURE_ATTEMPTS) { const before = attempts(), step = ERASURE_RETRY_STEPS_MS[Math.min(before, ERASURE_RETRY_STEPS_MS.length) - 1];
    assert.equal((await runClassroomErasureRecovery(f.env, now + step - 1000)).waiting, 1); assert.equal(attempts(), before, 'never earlier than the step'); now += step + 1000; const r = await runClassroomErasureRecovery(f.env, now); assert.equal(r.failed, 1); f.db.prepare("UPDATE classroom_erasure_log SET updated_at=? WHERE student_id='student-a'").run(now); waits.push(step); }
  assert.deepEqual(waits.slice(0, 5), [15 * 60_000, 3_600_000, 6 * 3_600_000, DAY, DAY]);
  for (let i = 0; i < 3; i++) { now += 2 * DAY; const r = await runClassroomErasureRecovery(f.env, now); assert.deepEqual([r.stalled, r.failed, r.finished], [1, 0, 0]); }
  assert.equal(attempts(), MAX_ERASURE_ATTEMPTS, 'no further automatic attempts'); assert.equal(f.db.prepare("SELECT count(*) n FROM ops_audit WHERE action='collection_erasure_stalled'").get().n, 1, 'said once, not on every tick');
  const view = (await f.request('/admin/classroom/erasures?class_run_id=' + f.run, 'GET', undefined, null, admin)).json.erasures; assert.deepEqual(view.map((e) => [e.student_id, e.state, e.last_error, e.needs_operator, e.next_attempt_at]), [['student-a', 'started', 'retry_limit', true, null]]);
  assert.equal((await f.request('/admin/classroom/erasures?class_run_id=' + f.run)).status, 401, 'an instructor cannot read the ledger');
  f.env.HPS_TRACES.delete = del; const done = await f.request('/admin/classroom/erasures', 'POST', { class_run_id: f.run, reason: 'withdrawn', student_id: 'student-a', dry_run: false }, null, admin); assert.equal(done.status, 200, done.raw);
  assert.equal(f.holds(words).filter((k) => k.includes('/student-a/')).length, 0); assert.equal(f.holds(words).length, 2, 'the other learner kept everything throughout');
});

test('recovery rides EVERY scheduled tick and needs no retention setting; with retention OFF the daily tick still starts nothing new, however old the run is', async (t) => {
  const f = await delivered(t), del = f.env.HPS_TRACES.delete; f.env.HPS_TRACES.delete = async () => { throw Error('synthetic R2 unavailable'); };
  await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: false, purpose: 'class_report', notice_version: 'notice-v1' }, f.conns[0].credential); f.env.HPS_TRACES.delete = del;
  f.db.prepare('UPDATE classroom_erasure_log SET updated_at=updated_at-?').run(2 * 3_600_000); f.db.prepare('UPDATE class_run_ops SET ends_at=?').run(Date.now() - 900 * DAY);
  const { default: worker } = await import('../src/index.ts'), pending = [], ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})), passThroughOnException() {} };
  await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, f.env, ctx); await Promise.all(pending);
  assert.equal(f.holds(words).filter((k) => k.includes('/student-a/')).length, 0, 'the heartbeat tick finished the withdrawal'); assert.equal(f.holds(words).length, 2);
  pending.length = 0; await worker.scheduled({ cron: '0 17 * * *', scheduledTime: Date.now() }, f.env, ctx); await Promise.all(pending); assert.equal(f.holds(words).length, 2, 'retention is not configured: a 900-day-old run is left alone');
  assert.equal(f.db.prepare("SELECT count(*) n FROM classroom_erasure_log WHERE student_id='student-b'").get().n, 0);
});

test('recovery quota excludes stalled and backoff rows so fresh erasures and settling continue', async (t) => {
  const f = await delivered(t), del = f.env.HPS_TRACES.delete, now = Date.now() + 3 * DAY;
  f.env.HPS_TRACES.delete = async () => { throw Error('synthetic outage'); };
  await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: false, purpose: 'class_report', notice_version: 'notice-v1' }, f.conns[0].credential); f.env.HPS_TRACES.delete = del;
  f.db.prepare("UPDATE classroom_erasure_log SET updated_at=? WHERE student_id='student-a'").run(now - DAY);
  const insert = f.db.prepare("INSERT INTO classroom_erasure_log(class_run_id,student_id,reason,state,attempts,last_error,started_at,updated_at) VALUES(?,?,'withdrawn','started',?,'content_delete_failed',0,?)");
  for (let i = 0; i < 25; i++) insert.run(f.run, 'stalled-' + i, MAX_ERASURE_ATTEMPTS, now - 10 * DAY);
  for (let i = 0; i < 25; i++) insert.run(f.run, 'waiting-' + i, 4, now - 2 * 3600000);
  const first = await runClassroomErasureRecovery(f.env, now);
  assert.deepEqual([first.stalled, first.waiting, first.finished], [25,25,1]);
  for (let i = 1; i <= 5; i++) await runClassroomErasureRecovery(f.env, now + SETTLE_AFTER_MS + i);
  assert.equal(f.db.prepare("SELECT state FROM classroom_erasure_log WHERE student_id='student-a'").get().state, 'settled');
  assert.equal(f.db.prepare("SELECT count(*) n FROM ops_audit WHERE action='collection_erasure_stalled'").get().n, 25);
  assert.ok(f.holds(words).every((k) => k.includes('/student-b/')));
});
