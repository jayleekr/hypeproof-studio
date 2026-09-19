// Independent review regressions for #751, baseline 1432b27 (2026-09-19).
// These assert the required behaviour and intentionally fail before the fixes.
// Synthetic identities, SQLite/in-memory R2 and a no-network delivery adapter only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { localOps } from './harness/classroom-ops.mjs';
import { eventCoverage } from '../src/lib/classroom-collect.ts';
import { validateDraft } from '../src/lib/classroom-report.ts';
import { CANDIDATE_CAPABILITY_V1 } from '../src/lib/measurement-core/index.ts';
import { emptyDraft } from '../../scripts/classroom-report-runner.mjs';

// The established worker harness registers the extensionless TS import resolver.
const { registerDeliveryAdapter } = await import('../src/routes/classroom-delivery.ts');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }];

async function fixture(t, count = 1) {
  const f = await localOps();
  t.after(() => f.close());
  await f.freeze();
  assert.equal((await f.configure(seats.slice(0, count), 0, {
    flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true, ops_delivery: true },
  })).status, 201);
  const connections = [];
  for (let i = 0; i < count; i++) {
    const c = (await f.pair(seats[i].seat_id, 1, i + 1)).conn.json;
    connections.push(c);
    assert.equal((await f.request('/v1/classroom/ops/collect/consent', 'POST', {
      consent: true, purpose: 'class_report', notice_version: 'notice-v1',
    }, c.credential)).status, 201);
  }
  const b = await f.request(f.base + '/report-batches', 'POST', {
    idempotency_key: crypto.randomUUID(), roster_revision: 1,
    purpose: 'class_report', notice_version: 'notice-v1', dry_run: false,
  });
  assert.equal(b.status, 201, b.raw);
  return { ...f, connections, batch: b.json.batch.id, B: f.base + '/report-batches/' + b.json.batch.id };
}

async function upload(f, index, meta, events) {
  const credential = f.connections[index].credential;
  const files = [['session.meta.json', JSON.stringify(meta)], ['events.jsonl', events]];
  for (const [name, body] of files) {
    const r = await f.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${f.batch}/1/${name}`, {
      method: 'PUT', headers: { authorization: 'Bearer ' + credential }, body,
    }), f.env, { waitUntil() {} });
    // A new implementation may reject bad metadata at PUT instead of seal.
    if (!r.ok) return { status: r.status, json: await r.json() };
  }
  return f.request(`/v1/classroom/ops/collect/snapshots/${f.batch}/1/seal`, 'POST', {
    schema: 'hps-classroom-snapshot/1',
    files: files.map(([name, body]) => ({ name, bytes: Buffer.byteLength(body), sha256: sha(body) })),
  }, credential);
}

const metaFor = (f, student) => ({
  schema_version: 1, session_id: f.run,
  user: { u: student, c: f.cohort, p: f.profile }, started_at: new Date().toISOString(),
});
// Actual spool shape: identity belongs to metadata, not every event line.
const legacyEvents = JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), type: 'prompt', turn_id: 'turn-1', text: 'SYNTHETIC ONLY' }) + '\n';

for (const [field, wrong] of [['u', 'student-b'], ['c', 'other-cohort'], ['p', 'other-profile']]) {
  test(`F1 rejects actual-spool metadata with a different ${field}`, async (t) => {
    const f = await fixture(t);
    const meta = metaFor(f, 'student-a'); meta.user[field] = wrong;
    const r = await upload(f, 0, meta, legacyEvents);
    const row = f.db.prepare('SELECT state FROM classroom_collect_items WHERE batch_id=? AND seat_id=?').get(f.batch, 'A1');
    assert.notEqual(row.state, 'verified', 'foreign student/cohort/profile must never become this seat\'s verified report input');
    assert.ok(r.status >= 400 || r.json.state === 'quarantined', JSON.stringify(r));
    assert.equal(f.db.prepare('SELECT count(*) n FROM classroom_job_outbox').get().n, 0);
  });
}

test('F3 two siblings with identical reports each receive one logical delivery; retry sends none', async (t) => {
  const f = await fixture(t, 2);
  for (let i = 0; i < 2; i++) {
    const r = await upload(f, i, metaFor(f, seats[i].student_id), legacyEvents);
    assert.equal(r.status, 201, JSON.stringify(r));
  }
  assert.equal((await f.request(f.B + '/jobs', 'POST', {})).status, 201);
  const runner = (await f.request(f.B + '/runner-grants', 'POST', {})).json.runner_credential;
  for (let i = 0; i < 2; i++) {
    const job = (await f.request('/v1/classroom/ops/runner/claim', 'POST', {}, runner)).json.job;
    assert.ok(job);
    assert.equal((await f.request(`/v1/classroom/ops/runner/jobs/${job.id}/result`, 'POST', {
      lease_generation: job.lease_generation, draft: emptyDraft(job),
    }, runner)).status, 201);
  }
  const jobs = (await f.request(f.B + '/reports')).json.jobs;
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].draft_digest, jobs[1].draft_digest, 'precondition: identical content, different learners');
  for (const j of jobs) assert.equal((await f.request(f.B + `/reports/${j.id}/review`, 'PUT', {
    decision: 'approve', expected_revision: j.revision, draft_digest: j.draft_digest,
  })).status, 200);
  assert.equal((await f.request('/admin/classroom/recipients', 'POST', {
    class_run_id: f.run, source_ref: 'synthetic-review', recipients: seats.map((s) => ({
      student_id: s.student_id, recipient_ref: 'same-guardian', channel: 'email', address: 'guardian@example.invalid',
    })),
  }, null, { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') })).status, 201);
  const scope = (await f.request(f.B + '/recipients?template_revision=review-v1')).json;
  assert.equal(scope.expected_messages, 2);
  const approval = (await f.request(f.B + '/approve', 'POST', {
    template_revision: 'review-v1', channel: 'email', scope_hash: scope.scope_hash,
  })).json;
  let sends = 0;
  const adapterId = 'review-no-network-' + crypto.randomUUID();
  registerDeliveryAdapter({ id: adapterId, external: true, send: async () => ({ status: 'accepted', provider_message_id: 'synthetic-' + (++sends) }) });
  f.env.HPS_DELIVERY_PROVIDER = adapterId;
  assert.equal((await f.request(f.B + '/deliver', 'POST', { approval_id: approval.approval_id, dry_run: false })).status, 202);
  assert.equal(sends, 2, 'identical report text must not merge two students');
  assert.equal(f.db.prepare('SELECT count(*) n FROM classroom_report_deliveries').get().n, 2);
  const again = await f.request(f.B + '/deliver', 'POST', { approval_id: approval.approval_id, dry_run: false });
  assert.equal(again.status, 202);
  assert.equal(sends, 2, 'retry of the same two messages must send zero additional messages');
  assert.ok(again.json.results.every((r) => r.replay));
});

const job = { capability_model: CANDIDATE_CAPABILITY_V1.id, rubric: 'unknown', evaluator: 'none', input_coverage: 'complete' };
const event = (id, text) => ({ schema_version: 1, event_id: id, type: 'prompt', actor: 'student', source_state: 'actual', text });
function observedDraft(id, quote) {
  const d = emptyDraft(job);
  d.findings[0] = { ...d.findings[0], status: 'observed', claim: '합성 근거를 기록함', evidence: [{ event_id: id, quote }] };
  return d;
}

test('F6 positive: an exact quote belongs to the identified student event', () => {
  assert.equal(validateDraft(observedDraft('event-a', 'SYNTHETIC ONLY'), job, JSON.stringify(event('event-a', 'SYNTHETIC ONLY'))).ok, true);
});
test('F6 rejects an invented event_id even when the quote exists elsewhere', () => {
  assert.equal(validateDraft(observedDraft('missing-event', 'SYNTHETIC ONLY'), job, JSON.stringify(event('event-a', 'SYNTHETIC ONLY'))).ok, false);
});
test('F6 rejects a real event_id with a quote from another event', () => {
  const input = [event('event-a', 'FIRST EVENT'), event('event-b', 'SECOND EVENT')].map((e) => JSON.stringify(e)).join('\n');
  assert.equal(validateDraft(observedDraft('event-a', 'SECOND EVENT'), job, input).ok, false);
});
test('F6 positive: a valid quote is checked against decoded JSON, including quotes and newlines', () => {
  const quote = '첫 줄의 "조건"\n다음 줄';
  assert.equal(validateDraft(observedDraft('event-a', quote), job, JSON.stringify(event('event-a', quote))).ok, true);
});
test('F7 malformed lines cannot be counted as complete coverage', () => {
  assert.notEqual(eventCoverage('{"seq":1}\nBROKEN JSON\n{"seq":2}\n', { student: 'student-a' }).coverage, 'complete');
});
test('F7 positive: legacy records retain unknown sequence coverage', () => {
  assert.equal(eventCoverage(legacyEvents, { student: 'student-a' }).coverage, 'sequence_unavailable');
});

// ── added with the fix: run / activity / consent scope / window / legacy attribution (F1) and boundaries (F7) ──
const sealAs = (f, body) => f.request(`/v1/classroom/ops/collect/snapshots/${f.batch}/1/seal`, 'POST', body, f.connections[0].credential);
async function putBoth(f, meta, events) {
  for (const [name, body] of [['session.meta.json', meta], ['events.jsonl', events]]) {
    const r = await f.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${f.batch}/1/${name}`, { method: 'PUT', headers: { authorization: 'Bearer ' + f.connections[0].credential }, body }), f.env, { waitUntil() {} });
    assert.equal(r.status, 201);
  }
}
const itemState = (f) => ({ ...f.db.prepare("SELECT state,reason FROM classroom_collect_items WHERE batch_id=? AND seat_id='A1'").get(f.batch) });

test('F1 positive: the App-issued binding of the learner\'s own record verifies and is stored with the snapshot', async (t) => {
  const f = await fixture(t), r = await f.uploadSnapshotAs(f.connections[0], f.batch, 1, legacyEvents);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const b = f.db.prepare('SELECT * FROM classroom_snapshot_bindings WHERE batch_id=?').get(f.batch);
  assert.deepEqual([b.student_id, b.cohort_id, b.profile_id, b.class_run_id, b.seat_id, b.attribution], ['student-a', f.cohort, f.profile, f.run, 'A1', 'bound']);
  assert.ok(b.consent_id, 'the consent the batch was created under is part of the record');
  assert.deepEqual(JSON.parse(b.activity_json), { course_id: f.lesson.course_id, version: f.lesson.version });
});
for (const [name, mutate, reason] of [
  ['another class run', (b) => { b.class_run_id = 'another-run'; }, 'foreign_run'],
  ['another activity (lesson version)', (b) => { b.activity = { course_id: b.activity.course_id, version: 'm1999.01.01-1' }; }, 'foreign_activity'],
  ['no activity when the run pinned one', (b) => { b.activity = null; }, 'foreign_activity'],
  ['another consent scope', (b) => { b.consent = { purpose: 'class_report', notice_version: 'notice-v0' }; }, 'consent_scope_mismatch'],
  ['another seat', (b) => { b.seat_id = 'A2'; }, 'foreign_seat'],
  ['another spool session than the metadata names', (b) => { b.spool_session_id = 'spool-of-someone-else'; }, 'binding_mismatch'],
]) test(`F1 quarantines a binding that names ${name}`, async (t) => {
  const f = await fixture(t), conn = f.connections[0], meta = f.metaFor(conn), body = f.sealBody(conn, f.batch, legacyEvents, { meta });
  mutate(body.binding); await putBoth(f, meta, legacyEvents);
  const r = await sealAs(f, body);
  assert.deepEqual([r.status, r.json.state, r.json.reason], [422, 'quarantined', reason]);
  assert.deepEqual(itemState(f), { state: 'quarantined', reason });
  assert.equal(f.db.prepare('SELECT count(*) n FROM classroom_job_outbox').get().n, 0, 'nothing reaches evaluation');
});
test('F1 an unattributed legacy record is not assumed to be this run\'s: no binding and a spool session id that is not the run', async (t) => {
  const f = await fixture(t), meta = JSON.stringify({ ...JSON.parse(f.metaFor(f.connections[0])) }); // real spool: session_id is the spool's own uuid
  await putBoth(f, meta, legacyEvents);
  const r = await sealAs(f, { schema: 'hps-classroom-snapshot/1', files: [['session.meta.json', meta], ['events.jsonl', legacyEvents]].map(([name, body]) => ({ name, bytes: Buffer.byteLength(body), sha256: sha(body) })) });
  assert.deepEqual([r.status, r.json.reason], [422, 'run_unbound']);
});
test('F1 a record that names nobody is not assumed to be the learner in the seat', async (t) => {
  const f = await fixture(t), r = await upload(f, 0, { schema_version: 1, session_id: f.run, user: null }, legacyEvents);
  assert.deepEqual([r.status, r.json.reason], [422, 'identity_unbound']);
});
test('F1/F7 a manifest without the spool metadata cannot be attributed and is refused', async (t) => {
  const f = await fixture(t);
  const r = await sealAs(f, { schema: 'hps-classroom-snapshot/1', files: [{ name: 'events.jsonl', bytes: Buffer.byteLength(legacyEvents), sha256: sha(legacyEvents) }] });
  assert.deepEqual([r.status, r.json.reason], [400, 'manifest_invalid']);
});
test('F7 a damaged record is verified bytes with coverage "damaged" — never complete, and the damage is counted', async (t) => {
  const f = await fixture(t), damaged = '{"seq":1,"type":"prompt"}\nBROKEN JSON\n{"seq":2,"type":"turn_end"}\n';
  const r = await f.uploadSnapshotAs(f.connections[0], f.batch, 1, damaged);
  assert.deepEqual([r.status, r.json.integrity, r.json.coverage], [201, 'verified', 'damaged']);
  assert.equal(f.db.prepare('SELECT malformed_lines n FROM classroom_snapshot_bindings WHERE batch_id=?').get(f.batch).n, 1);
  assert.equal((await f.request(f.B)).json.summary.verified_complete_coverage, 0);
});
test('F7 sequenced events are complete only against the declared start and end', () => {
  const tail = '{"seq":5,"type":"prompt"}\n{"seq":6,"type":"turn_end"}\n', range = (first_seq, last_seq, lines = 2) => ({ lines, from_ts: '2026-09-19T00:00:00.000Z', to_ts: '2026-09-19T00:00:00.000Z', final_line_sha256: 'a'.repeat(64), first_seq, last_seq });
  assert.equal(eventCoverage(tail, { student: 'student-a' }).coverage, 'range_unknown', 'a contiguous tail alone says nothing about what came before it');
  assert.equal(eventCoverage(tail, { student: 'student-a' }, range(5, 6)).coverage, 'complete');
  assert.equal(eventCoverage(tail, { student: 'student-a' }, range(1, 6)).coverage, 'gaps', 'the declared start is missing');
  assert.equal(eventCoverage(tail, { student: 'student-a' }, range(5, 9)).coverage, 'gaps', 'the declared end is missing');
  assert.equal(eventCoverage(tail, { student: 'student-a' }, range(5, 6, 3)).range_problem, 'line_count_mismatch');
  assert.equal(eventCoverage('[1,2]\n"text"\n', { student: 'student-a' }).coverage, 'damaged', 'JSON that is not an event object is damage too');
});
test('F7 the declared final event must be the last one the Service holds', async (t) => {
  const f = await fixture(t), conn = f.connections[0], meta = f.metaFor(conn), ev = '{"seq":1,"type":"prompt"}\n{"seq":2,"type":"turn_end"}\n';
  const body = f.sealBody(conn, f.batch, ev, { meta }); body.binding.range.final_line_sha256 = sha('{"seq":2,"type":"something else"}');
  await putBoth(f, meta, ev);
  assert.deepEqual([(await sealAs(f, body)).json.reason, itemState(f).state], ['range_mismatch', 'quarantined']);
});
test('F1 quarantines a record whose events are from before this class run (another activity on the same PC)', async (t) => {
  // The App's freezer drops such events; this is a device that did not. The extent is declared truthfully, and refused.
  const f = await fixture(t), conn = f.connections[0], meta = f.metaFor(conn), ts = '2020-01-01T00:00:00.000Z';
  const old = JSON.stringify({ schema_version: 1, ts, type: 'prompt', turn_id: 'turn-0', text: 'SYNTHETIC EARLIER WORK' }) + '\n';
  const body = f.sealBody(conn, f.batch, legacyEvents, { meta });
  body.files = [['session.meta.json', meta], ['events.jsonl', old]].map(([name, b]) => ({ name, bytes: Buffer.byteLength(b), sha256: sha(b) }));
  body.binding.range = { lines: 1, from_ts: ts, to_ts: ts, final_line_sha256: sha(old.trimEnd()) };
  await putBoth(f, meta, old);
  const r = await sealAs(f, body);
  assert.deepEqual([r.status, r.json.state, r.json.reason], [422, 'quarantined', 'outside_run_window']);
});
test('F3 the delivery key is the logical message: learner, run, job and recipient revision each make it a different message', async () => {
  const { deliveryKey } = await import('../src/lib/classroom-delivery.ts');
  const base = { class_run_id: 'run-1', batch_id: 'batch-1', job_id: 'job-a', student_id: 'student-a', draft_digest: 'd'.repeat(64), recipient_ref: 'same-guardian', recipient_revision: 1, channel: 'email', template_revision: 'review-v1', live: true };
  const k = await deliveryKey(base);
  assert.equal(await deliveryKey({ ...base }), k, 'the same message again is the same key: a retry sends nothing');
  for (const [what, other] of [['sibling', { job_id: 'job-b', student_id: 'student-b' }], ['recipient_ref reused in another class run', { class_run_id: 'run-2', batch_id: 'batch-2', job_id: 'job-c' }], ['same guardian, corrected address', { recipient_revision: 2 }], ['revised report', { draft_digest: 'e'.repeat(64) }], ['dry run', { live: false }]])
    assert.notEqual(await deliveryKey({ ...base, ...other }), k, what);
});
