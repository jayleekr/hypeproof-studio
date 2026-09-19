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
