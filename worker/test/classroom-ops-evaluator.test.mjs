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
  return { ...f, conns, batch, B: f.base + '/report-batches/' + batch, advance: () => f.request(f.base + '/report-batches/' + batch + '/advance', 'POST', {}) };
}
const fixtureWithConns = (t, inputs = [record, record]) => fixture(t, { inputs });
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
  const draft = JSON.parse(new TextDecoder().decode([...f.r2.entries()].find(([k]) => /\/draft\.g\d+\.json$/.test(k))[1]));
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
  const states = []; for (let i = 0; i < 8; i++) { const r = await f.advance(); states.push([r.json.step?.state, r.json.step?.reason]); f.db.prepare('UPDATE classroom_report_job_attempts SET next_attempt_at=1').run(); /* fake clock: every pause is over */ if (!r.json.more && !r.json.retry_after_ms) break; }
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

// ── follow-up review (Codex, 2026-09-19): a job that cannot run must not block the jobs behind it ──
const jobsOf = (f) => f.db.prepare("SELECT student_id,state,evaluator,rubric,capability_model,reason,lease_generation,draft_digest<>'' AS drafted FROM classroom_report_jobs WHERE state<>'missing' ORDER BY created_at,student_id").all().map((r) => ({ ...r }));
test('queue: evaluator OFF → ON. The earlier evaluator=none job is closed as superseded (never rewritten), each learner is evaluated once, repeats add nothing', async (t) => {
  const f = await fixture(t, { configured: false, inputs: [record] }); await f.advance();
  assert.deepEqual(jobsOf(f).map((j) => [j.student_id, j.state, j.evaluator]), [['student-a', 'queued', 'none']]);
  f.env.HPS_CLASSROOM_EVALUATOR = 'service-anthropic'; f.env.ANTHROPIC_API_KEY = 'synthetic-not-a-key'; const calls = []; setEvaluatorTransport(careful(calls));
  const late = (await f.pair('A2', 1, 2)).conn.json; await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, late.credential);
  assert.equal((await f.uploadSnapshotAs(late, f.batch, 1, record)).status, 404, 'precondition: a learner who was not asked by this batch cannot upload into it');
  const steps = []; for (let i = 0; i < 4; i++) { const r = await f.advance(); steps.push([r.json.step?.state ?? null, r.json.more, r.json.reprepared]); }
  assert.deepEqual(steps, [['partial', false, 1], [null, false, 0], [null, false, 0], [null, false, 0]]); assert.equal(calls.length, 1);
  const jobs = jobsOf(f); assert.deepEqual(jobs.map((j) => [j.state, j.evaluator, j.drafted]), [['superseded', 'none', 0], ['partial', EVALUATOR_REVISION, 1]]);
  assert.equal(f.db.prepare("SELECT count(*) n FROM ops_audit WHERE action='report_jobs_reprepared'").get().n, 1, 'the re-preparation is on the audit trail');
});
test('queue: Codex reproduction — a=none job first, evaluator configured, b arrives. Both are evaluated once; a is not retried forever', async (t) => {
  const f = await localOps(); t.after(() => { setEvaluatorTransport(undefined); f.close(); });
  await f.freeze(); await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true } });
  const a = (await f.pair('A1', 1, 1)).conn.json, b = (await f.pair('A2', 1, 2)).conn.json; for (const c of [a, b]) await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential);
  const batch = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false })).json.batch.id, advance = () => f.request(f.base + '/report-batches/' + batch + '/advance', 'POST', {});
  await f.uploadSnapshotAs(a, batch, 1, record); await advance();
  f.env.HPS_CLASSROOM_EVALUATOR = 'service-anthropic'; f.env.ANTHROPIC_API_KEY = 'synthetic-not-a-key'; const calls = []; setEvaluatorTransport(careful(calls)); await f.uploadSnapshotAs(b, batch, 1, record);
  const more = []; for (let i = 0; i < 5; i++) more.push((await advance()).json.more);
  assert.deepEqual(more, [true, false, false, false, false]); assert.equal(calls.length, 2, 'one evaluation per learner');
  assert.deepEqual(jobsOf(f).filter((j) => j.state !== 'superseded').map((j) => [j.student_id, j.state, j.lease_generation]).sort(), [['student-a', 'partial', 1], ['student-b', 'partial', 1]]);
});
test('queue: an evaluator/rubric VERSION change re-prepares only never-evaluated jobs; a draft that exists is not re-evaluated or overwritten', async (t) => {
  const f = await fixture(t), calls = []; setEvaluatorTransport(careful(calls)); await f.advance(); // student-a evaluated under the current version
  const before = jobsOf(f); assert.deepEqual(before.map((j) => j.state).sort(), ['partial', 'queued']);
  // Simulate the older pin on both rows (as if the Service had moved from :0 to :1 since they were created).
  f.db.prepare("UPDATE classroom_report_jobs SET evaluator='service-anthropic:0',job_key=job_key||':v0'").run(); /* rows as an older Service version would have created them: their key pins that version */ const digest = f.db.prepare("SELECT draft_digest d FROM classroom_report_jobs WHERE state='partial'").get().d;
  for (let i = 0; i < 3; i++) await f.advance();
  const after = jobsOf(f); assert.equal(calls.length, 2, 'only the never-evaluated learner is evaluated under the new version');
  assert.deepEqual(after.map((j) => [j.state, j.evaluator]).sort(), [['partial', 'service-anthropic:0'], ['partial', EVALUATOR_REVISION], ['superseded', 'service-anthropic:0']].sort());
  assert.equal(f.db.prepare("SELECT draft_digest d FROM classroom_report_jobs WHERE evaluator='service-anthropic:0' AND state='partial'").get().d, digest, 'the existing draft and its version pin are untouched');
});
test('queue: a legacy seven-axis job in front does not block six-capability jobs, and is never evaluated by the Service path', async (t) => {
  const f = await fixture(t), calls = []; setEvaluatorTransport(careful(calls));
  assert.equal((await f.request(f.B + '/jobs', 'POST', { capability_model: 'legacy-seven-assets', rubric: 'hain7-studio-signal-1.0.0', evaluator: 'hain7-replay' })).status, 201);
  f.db.prepare("UPDATE classroom_report_jobs SET created_at=1 WHERE capability_model='legacy-seven-assets'").run(); // oldest in the queue
  let last; for (let i = 0; i < 4; i++) last = (await f.advance()).json;
  assert.equal(calls.length, 0, 'the verified inputs were consumed by the legacy jobs; nothing six-capability exists to evaluate'); assert.deepEqual([last.more, last.needs_other_engine], [false, 2]);
  assert.ok(jobsOf(f).every((j) => j.capability_model === 'legacy-seven-assets' && j.state === 'queued' && j.lease_generation === 0), 'the Service never leased a job it cannot run');
});
test('queue: provider trouble pauses THAT job (30 s, 2 min, …) — the next learner runs now; two callers never evaluate the same job; after 3 tries it fails visibly', async (t) => {
  const f = await fixture(t), calls = []; let failFor = 'first';
  setEvaluatorTransport(async (request, signal) => { calls.push(request); if (failFor === 'first' && calls.length === 1) return new Response('busy', { status: 503 }); if (failFor === 'always') return new Response('busy', { status: 503 }); return careful([])(request, signal); });
  const [x, y] = await Promise.all([f.advance(), f.advance()]); // two tabs / two runners at once
  const states = [x.json.step?.state, y.json.step?.state].sort(); assert.deepEqual(states, ['partial', 'queued'], 'one paused on 503, the other learner evaluated — by different callers, different jobs');
  const third = (await f.advance()).json; assert.deepEqual([third.step, third.more], [null, false]); assert.ok(third.retry_after_ms > 0 && third.retry_after_ms <= 30_000, 'the page is told when to come back instead of spinning: ' + third.retry_after_ms);
  assert.equal(calls.length, 2); const paused = f.db.prepare('SELECT job_id,attempts,next_attempt_at,last_reason FROM classroom_report_job_attempts').get(); assert.deepEqual([paused.attempts, paused.last_reason], [1, 'evaluator_provider_503']);
  // fake clock: move the pause into the past, keep failing → 2 min pause, then a visible failure on the third try
  failFor = 'always'; const due = () => f.db.prepare('UPDATE classroom_report_job_attempts SET next_attempt_at=1').run();
  due(); assert.equal((await f.advance()).json.step.reason, 'evaluator_provider_503'); const second = f.db.prepare('SELECT attempts,next_attempt_at n FROM classroom_report_job_attempts').get(); assert.equal(second.attempts, 2); assert.ok(second.n - Date.now() > 100_000, 'the second pause is longer than the first');
  due(); const final = (await f.advance()).json; assert.deepEqual([final.step.state, final.step.reason, final.more, final.retry_after_ms], ['failed', 'evaluator_provider_503', false, null]);
  assert.deepEqual(jobsOf(f).map((j) => j.state).sort(), ['failed', 'partial']);
});
test('queue: the restricted runner is only handed what it said it can run', async (t) => {
  const f = await fixture(t, { configured: false, inputs: [record] }); await f.request(f.B + '/jobs', 'POST', {}); // evaluator=none job
  const runner = (await f.request(f.B + '/runner-grants', 'POST', {})).json.runner_credential, claim = (can) => f.request('/v1/classroom/ops/runner/claim', 'POST', can ? { can } : {}, runner);
  assert.equal((await claim({ service: true, legacy: false, local: false })).json.job, null, 'no Service evaluator configured → a service-only runner gets nothing, and does not spin on it');
  assert.equal((await claim({ service: false, legacy: true, local: false })).json.job, null);
  const got = (await claim({ service: true, legacy: false, local: true })).json.job; assert.equal(got.evaluator, 'none', 'a runner with its own evaluator takes the job pinned to no Service evaluator');
});

// ── a result that arrives late (#751, 2026-09-20 review) ──
// R2 and D1 share no transaction. These tests hold the provider or the R2 write at a barrier — never a sleep — and
// let the other party finish first. What must hold: D1 decides, a refused body does not stay, and nobody else's draft is touched.
const sha = async (buf) => Buffer.from(await crypto.subtle.digest('SHA-256', buf)).toString('hex');
const reportObjects = (f, student) => [...f.r2.keys()].filter((k) => k.startsWith('classroom-reports/') && k.includes(`/${student}/`));
function barrier() { let open, reached; const gate = new Promise((r) => { open = r; }), hit = new Promise((r) => { reached = r; }); return { gate, hit, open: () => open(), reached: () => reached() }; }
/** Blocks the FIRST draft write until released; every later write goes straight through. The write itself still lands. */
function holdFirstDraftPut(f) { const b = barrier(), put = f.env.HPS_TRACES.put; let held = false;
  f.env.HPS_TRACES.put = async (key, value, opts) => { if (!held && key.startsWith('classroom-reports/')) { held = true; b.reached(); await b.gate; } return put(key, value, opts); }; return b; }
const withdraw = (f, conn) => f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: false, purpose: 'class_report', notice_version: 'notice-v1' }, conn.credential);

test('late result: the learner withdraws while the provider is still answering — nothing is stored for them, the job ends, the next learner is unaffected', async (t) => {
  const f = await fixtureWithConns(t), calls = [], b = barrier(), answer = careful(calls);
  setEvaluatorTransport(async (req) => { if (!calls.length) { const r = answer(req); b.reached(); await b.gate; return r; } return answer(req); });
  const first = f.advance(); await b.hit; assert.equal((await withdraw(f, f.conns[0])).status, 200); b.open();
  const r = await first; assert.equal(r.status, 200, r.raw); assert.deepEqual([r.json.step.state, r.json.step.reason], ['withdrawn', 'withdrawn']);
  assert.deepEqual(reportObjects(f, 'student-a'), [], 'the late answer did not become an object');
  let more = r.json.more; for (let i = 0; more && i < 5; i++) more = (await f.advance()).json.more;
  const jobs = (await f.request(f.B + '/reports')).json.jobs; assert.deepEqual(jobs.map((j) => [j.student_id, j.state, j.draft_digest === '']), [['student-a', 'withdrawn', true], ['student-b', 'partial', false]]);
  assert.equal(calls.length, 2, 'the withdrawn learner is not sent to the provider again'); const kept = reportObjects(f, 'student-b'); assert.equal(kept.length, 1);
  assert.equal(await sha(f.r2.get(kept[0])), jobs[1].draft_digest, 'the other learner has exactly the draft that was committed');
});
test('late result: the withdrawal lands while the body is being written — D1 refuses the result and the body that was just written is removed', async (t) => {
  const f = await fixtureWithConns(t), calls = []; setEvaluatorTransport(careful(calls)); const b = holdFirstDraftPut(f);
  const first = f.advance(); await b.hit; assert.equal((await withdraw(f, f.conns[0])).status, 200); b.open();
  const r = await first; assert.equal(r.json.step.state, 'withdrawn'); assert.deepEqual(reportObjects(f, 'student-a'), [], 'the write landed and was undone');
  assert.equal(f.db.prepare("SELECT count(*) n FROM ops_audit WHERE action LIKE 'report_draft_%' AND detail_json LIKE '%student-a%'").get().n, 0);
});
test('late result: a lease that expired and was re-claimed — the stale writer cannot replace or delete the draft the new generation committed', async (t) => {
  const f = await fixtureWithConns(t, [record]), calls = []; setEvaluatorTransport(careful(calls)); const b = holdFirstDraftPut(f);
  const stale = f.advance(); await b.hit; f.db.prepare("UPDATE classroom_report_jobs SET lease_expires_at=1 WHERE state='leased'").run();
  const fresh = await f.advance(); assert.equal(fresh.json.step.state, 'partial'); const committed = reportObjects(f, 'student-a'); assert.deepEqual(committed.map((k) => k.slice(-13)), ['draft.g2.json']);
  b.open(); const late = await stale; assert.equal(late.status, 200); assert.equal(late.json.step.state, undefined, 'the stale lease stored nothing');
  assert.deepEqual(reportObjects(f, 'student-a'), committed, 'generation 1 wrote its own object and removed it again');
  const job = (await f.request(f.B + '/reports')).json.jobs[0]; assert.equal(await sha(f.r2.get(committed[0])), job.draft_digest);
  const opened = await f.request(f.B + '/reports/' + job.id); assert.equal(opened.status, 200, opened.raw); assert.equal(opened.json.draft_digest, job.draft_digest); assert.ok(opened.json.report.sections.length > 0, 'the reviewer opens the committed draft');
  assert.equal(f.db.prepare("SELECT count(*) n FROM ops_audit WHERE action='report_draft_partial'").get().n, 1, 'one stored result, not two');
});
test('late result: the removal itself fails — the request still answers, a content-free note is kept, and the next stored result of the job clears the leftover', async (t) => {
  const f = await fixtureWithConns(t, [record]), calls = []; setEvaluatorTransport(careful(calls)); const b = holdFirstDraftPut(f), del = f.env.HPS_TRACES.delete;
  const stale = f.advance(); await b.hit; f.db.prepare("UPDATE classroom_report_jobs SET state='queued',lease_expires_at=0 WHERE state='leased'").run(); // the lease is gone, nobody has re-claimed yet
  f.env.HPS_TRACES.delete = async () => { throw Error('synthetic R2 unavailable'); }; b.open();
  const late = await stale; assert.equal(late.status, 200, late.raw); assert.equal(reportObjects(f, 'student-a').length, 1, 'precondition: the leftover exists');
  const note = f.db.prepare("SELECT detail_json FROM ops_audit WHERE action='report_draft_discard_failed'").get(); assert.ok(note && !note.detail_json.includes('예약'), 'the note holds ids only');
  f.env.HPS_TRACES.delete = del; const again = await f.advance(); assert.equal(again.json.step.state, 'partial');
  assert.deepEqual(reportObjects(f, 'student-a').map((k) => k.slice(-13)), ['draft.g2.json'], 'only the committed generation is left');
});
