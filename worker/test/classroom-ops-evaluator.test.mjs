// Remote classroom operations R5 (#751) — the evaluator adapter and the automatic path
// "verified receipt → deduplicated job → evaluation → review queue".
// Real routes, SQLite and in-memory R2. The provider is replaced at the transport seam:
// this proves the adapter's contract, NOT the quality of a real model's observations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { localOps } from './harness/classroom-ops.mjs';
import { CANDIDATE_CAPABILITY_V1 } from '../src/lib/measurement-core/index.ts';
const { setEvaluatorTransport } = await import('../src/routes/classroom-reports.ts');
const { rubricVersion, buildCatalog, draftFromSelections, EVALUATOR_REVISION, systemPrompt } = await import('../src/lib/classroom-evaluator.ts');

const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }];
const line = (o) => JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), ...o });
const record = [
  line({ type: 'prompt', turn_id: 't1', text: '예약 버튼이 모바일에서 눌리는지 먼저 확인하고 싶어요' }),
  line({ type: 'response', turn_id: 't1', text: 'AI: 버튼을 크게 만들었습니다' }),
  line({ type: 'prompt', turn_id: 't2', text: '390px에서 버튼이 가려져서 위치를 바꿔 주세요' }),
  line({ type: 'turn_end', turn_id: 't2', status: 'ok' }),
].join('\n') + '\n';
const aiOnly = line({ type: 'response', turn_id: 't1', text: 'AI가 혼자 만든 결과' }) + '\n';

async function fixture(t, { configured = true, inputs = [record, record] } = {}) {
  const f = await localOps(); t.after(() => { setEvaluatorTransport(undefined); f.close(); });
  if (configured) { f.env.HPS_CLASSROOM_EVALUATOR = 'service-anthropic'; f.env.ANTHROPIC_API_KEY = 'synthetic-not-a-key'; }
  await f.freeze(); assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true } })).status, 201);
  const conns = []; for (let i = 0; i < inputs.length; i++) { const c = (await f.pair(seats[i].seat_id, 1, i + 1)).conn.json; conns.push(c); assert.equal((await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential)).status, 201); }
  const batch = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false })).json.batch.id;
  for (let i = 0; i < inputs.length; i++) assert.equal((await f.uploadSnapshotAs(conns[i], batch, 1, inputs[i])).status, 201);
  return { ...f, batch, B: f.base + '/report-batches/' + batch, advance: () => f.request(f.base + '/report-batches/' + batch + '/advance', 'POST', {}) };
}
/** A stand-in provider that behaves like a careful one: it picks the learner's own first excerpt for FRAMING. */
const careful = (calls) => async (request) => { calls.push(request); const catalog = JSON.parse(request.messages[0].content).evidence_catalog, own = catalog.find((q) => q.basis);
  return Response.json({ content: [{ type: 'text', text: JSON.stringify({ findings: [{ capability: 'FRAMING', status: 'observed', claim: '확인할 조건을 먼저 정함', evidence: [{ quote_id: own.quote_id }], assistance: 'independent' }, { capability: 'JUDGMENT', status: 'unobserved' }], next_experiment: '다음에는 확인 조건을 두 개 적어 보기' }) }], usage: { input_tokens: 10, output_tokens: 5 } }); };

test('R5 not configured is a visible state: jobs wait, nothing is drafted, nothing pretends to be evaluated', async (t) => {
  const f = await fixture(t, { configured: false }), r = await f.advance();
  assert.equal(r.status, 200, r.raw); assert.deepEqual(r.json.evaluator, { configured: false, reason: 'evaluator_not_configured' }); assert.equal(r.json.more, false);
  assert.deepEqual(r.json.jobs.map((j) => [j.state, j.evaluator, j.draft_digest]), [['queued', 'none', ''], ['queued', 'none', '']]);
  assert.equal([...f.r2.keys()].filter((k) => k.startsWith('classroom-reports/')).length, 0, 'an empty draft is not written in place of an evaluation');
});
test('R5 "수업 마무리" path: receipts → one job per learner → evaluated → review queue; repeating it creates and evaluates nothing twice', async (t) => {
  const f = await fixture(t), calls = []; setEvaluatorTransport(careful(calls));
  let r = await f.advance(); assert.equal(r.json.created.inputs, 2); assert.equal(r.json.step.state, 'partial', 'a legacy spool has no seq: the draft says its coverage is unknown'); assert.equal(r.json.more, true);
  r = await f.advance(); assert.equal(r.json.more, false); r = await f.advance(); r = await f.advance();
  assert.equal(calls.length, 2, 'one provider call per learner, however often the page asks');
  assert.equal(f.db.prepare('SELECT count(*) n FROM classroom_report_jobs').get().n, 2);
  const jobs = (await f.request(f.B + '/reports')).json.jobs;
  assert.deepEqual(jobs.map((j) => [j.state, j.evaluator, j.rubric, j.summary.observed, j.summary.not_yet_seen]), Array(2).fill(['partial', EVALUATOR_REVISION, rubricVersion(CANDIDATE_CAPABILITY_V1), 1, CANDIDATE_CAPABILITY_V1.capabilities.length - 1]));
  assert.ok(jobs.every((j) => j.state !== 'approved'), 'evaluation never approves; review stays a human act');
  const draft = JSON.parse(new TextDecoder().decode([...f.r2.entries()].find(([k]) => k.endsWith('/draft.json'))[1]));
  assert.deepEqual(draft.findings[0].evidence, [{ locator: { line: 1, turn_id: 't1' }, quote: '예약 버튼이 모바일에서 눌리는지 먼저 확인하고 싶어요', actor: 'student', source_state: 'unverified' }], 'legacy locator + verified provenance, verbatim quote');
  assert.equal(draft.findings[0].assistance, 'independent'); assert.ok(!JSON.stringify(draft).match(/score|rank|level|percentile/));
  // The provider saw the rubric that already exists (capability definitions), and no raw metadata.
  assert.ok(calls[0].system[0].text.includes(CANDIDATE_CAPABILITY_V1.capabilities[0].observe)); assert.ok(!calls[0].messages[0].content.includes('student-a'));
});
test('R5 insufficient evidence: a record with no learner input is "not seen yet" for every capability, without calling a provider', async (t) => {
  const f = await fixture(t, { inputs: [aiOnly] }), calls = []; setEvaluatorTransport(careful(calls));
  const r = await f.advance(); assert.equal(calls.length, 0); assert.equal(r.json.step.ok, true);
  assert.deepEqual([r.json.jobs[0].summary.observed, r.json.jobs[0].summary.not_yet_seen], [0, CANDIDATE_CAPABILITY_V1.capabilities.length]);
});
test('R5 a provider that cites what is not in the catalog, or only the AI, never becomes a draft', async (t) => {
  const f = await fixture(t, { inputs: [record] });
  setEvaluatorTransport(async () => Response.json({ content: [{ type: 'text', text: JSON.stringify({ findings: [{ capability: 'FRAMING', status: 'observed', claim: 'x', evidence: [{ quote_id: 'q999' }], assistance: 'unknown' }], next_experiment: '' }) }] }));
  let r = await f.advance(); assert.deepEqual([r.json.step.state, r.json.step.reason], ['failed', 'invalid_quote_selection']);
  const g = await fixture(t, { inputs: [record] });
  setEvaluatorTransport(async (request) => { const ai = JSON.parse(request.messages[0].content).evidence_catalog.find((q) => !q.basis); return Response.json({ content: [{ type: 'text', text: JSON.stringify({ findings: [{ capability: 'FRAMING', status: 'observed', claim: 'AI가 한 일', evidence: [{ quote_id: ai.quote_id }], assistance: 'unknown' }], next_experiment: '' }) }] }); });
  r = await g.advance(); assert.deepEqual([r.json.step.state, r.json.step.reason], ['quarantined', 'evidence_not_student_work']);
});
test('R5 provider trouble returns the job to the queue (bounded), then fails visibly; other learners keep going', async (t) => {
  const f = await fixture(t), calls = []; let n = 0;
  setEvaluatorTransport(async (request, signal) => (++n <= 3 ? new Response('busy', { status: 503 }) : careful(calls)(request, signal)));
  const states = []; for (let i = 0; i < 6; i++) { const r = await f.advance(); states.push([r.json.step?.state, r.json.step?.reason]); if (!r.json.more) break; }
  const jobs = (await f.request(f.B + '/reports')).json.jobs.map((j) => j.state).sort();
  assert.ok(states.some(([s, reason]) => s === 'queued' && reason === 'evaluator_provider_503'), 'a transient failure is not a draft and not a terminal failure');
  assert.ok(jobs.includes('partial'), JSON.stringify({ states, jobs })); assert.ok(jobs.every((s) => ['partial', 'failed'].includes(s)), 'nothing is left silently looping');
});
test('R5 the restricted runner can ask the Service to evaluate the job it holds; it gets a state, never the learner\'s words', async (t) => {
  const f = await fixture(t, { inputs: [record] }); setEvaluatorTransport(careful([]));
  assert.equal((await f.request(f.B + '/jobs', 'POST', { evaluator: EVALUATOR_REVISION, rubric: rubricVersion(CANDIDATE_CAPABILITY_V1) })).status, 201);
  const runner = (await f.request(f.B + '/runner-grants', 'POST', {})).json.runner_credential, job = (await f.request('/v1/classroom/ops/runner/claim', 'POST', {}, runner)).json.job;
  const r = await f.request(`/v1/classroom/ops/runner/jobs/${job.id}/evaluate`, 'POST', { lease_generation: job.lease_generation }, runner);
  assert.equal(r.status, 201, r.raw); assert.equal(r.json.state, 'partial'); assert.ok(!r.raw.includes('예약 버튼'));
});
test('R5 contract: the catalog is verbatim and provenance-tagged; a secret-bearing line is left out; every capability appears once', () => {
  const secret = line({ type: 'prompt', turn_id: 't9', text: 'token sk-ant-api03-' + 'A'.repeat(90) });
  const built = buildCatalog(record + secret + '\n');
  assert.deepEqual(built.catalog.map((q) => [q.event_id, q.basis, q.actor]), [['L1', true, 'student'], ['L2', false, 'ai'], ['L3', true, 'student']]);
  const draft = draftFromSelections({ findings: [{ capability: 'FRAMING', status: 'observed', claim: 'c', evidence: [{ quote_id: 'q0' }], assistance: 'assisted' }, { capability: 'FRAMING', status: 'observed', claim: 'duplicate', evidence: [{ quote_id: 'q2' }], assistance: 'unknown' }], next_experiment: 'x' }, CANDIDATE_CAPABILITY_V1, { rubric: 'r', evaluator: 'e' }, built);
  assert.deepEqual(draft.findings.map((f) => f.capability), CANDIDATE_CAPABILITY_V1.capabilities.map((c) => c.key)); assert.equal(draft.findings[0].claim, 'c');
  assert.match(systemPrompt(CANDIDATE_CAPABILITY_V1), /점수·등급·순위/);
});
