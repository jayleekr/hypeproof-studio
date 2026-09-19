// Remote classroom operations R5 (#751) — Service layer of AT-29/30/37/38 with synthetic
// inputs. The runner process, fonts/PDF and any LLM evaluator are other layers (evaluator OFF here).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { localOps } from './harness/classroom-ops.mjs';
import { composeReport, validateDraft, NOT_YET_SEEN, RENDERER_REVISION } from '../src/lib/classroom-report.ts';
import { CANDIDATE_CAPABILITY_V1, LEGACY_SEVEN_ASSETS } from '../src/lib/measurement-core/index.ts';
let count = 0; async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const sha = (s) => createHash('sha256').update(s).digest('hex'); const meta = '{"session":"s1"}';
const evA = '{"seq":1,"event_id":"e1","type":"prompt","text":"예약 버튼이 모바일에서 눌리는지 먼저 확인하고 싶어요"}\n{"seq":2,"type":"prompt","text":"390px에서 버튼이 가려져서 위치를 바꿔 주세요"}\n';
const six = CANDIDATE_CAPABILITY_V1.capabilities.map((c) => c.key), seven = LEGACY_SEVEN_ASSETS.capabilities.map((c) => c.key);
const draft = (model, findings, extra = {}) => ({ format: 'hps-classroom-report-draft/1', versions: { capability_model: { id: model.id, revision: model.revision }, rubric: 'unknown', evaluator: 'none', renderer_revision: RENDERER_REVISION }, findings, next_experiment: '다음 과제에서 결정 전에 대안 2개를 먼저 적어 보기', ...extra });
const unseen = (keys) => keys.map((capability) => ({ capability, status: 'unobserved', claim: '', evidence: [] }));
await check('controls (AT-29/37/38): draft validator and report composition split their inputs', async () => {
  const job = { capability_model: CANDIDATE_CAPABILITY_V1.id, rubric: 'unknown', evaluator: 'none', input_coverage: 'complete' };
  const good = draft(CANDIDATE_CAPABILITY_V1, [{ capability: six[0], status: 'observed', claim: '확인할 조건을 먼저 정함', evidence: [{ event_id: 'e1', quote: '모바일에서 눌리는지 먼저 확인' }], change: { before: '버튼 위치 유지', after: '390px 확인 뒤 위치 변경' } }, ...unseen(six.slice(1))]);
  assert.deepEqual([validateDraft(good, job, evA).ok, validateDraft(good, job, evA).state], [true, 'review_required']);
  assert.equal(validateDraft(good, { ...job, input_coverage: 'gaps' }, evA).state, 'partial');
  for (const [bad, reason] of [[{ ...good, findings: [{ ...good.findings[0], evidence: [{ event_id: 'e1', quote: '다른 학생이 쓴 문장' }] }] }, 'evidence_not_in_event'], [{ ...good, findings: [{ ...good.findings[0], evidence: [] }] }, 'observed_without_evidence'], [{ ...good, findings: [{ ...good.findings[0], score: 78 }] }, 'score_in_draft'], [{ ...good, rank: 3 }, 'score_in_draft'], [{ ...good, derived_from_legacy: true }, 'legacy_conversion'], [draft(LEGACY_SEVEN_ASSETS, unseen(seven), { legacy: { fingerprint: 'a'.repeat(32), marker_review_complete: true } }), 'model_mismatch'], [{ ...good, legacy: { fingerprint: 'a'.repeat(32), marker_review_complete: true } }, 'legacy_conversion'], [{ ...good, findings: [{ capability: seven.find((k) => !six.includes(k)) ?? 'INTENT', status: 'unobserved', claim: '', evidence: [] }] }, 'finding_invalid']]) assert.equal(validateDraft(bad, job, evA).reason, reason);
  // AI-only sentences are not learner evidence: a quote must be in the learner's verified input.
  { // review F6 — provenance is read from the event itself: an AI response, a teacher's words or a simulated case cannot be the basis of "observed".
    const mixed = evA + '{"seq":3,"event_id":"r1","type":"response","text":"AI가 버튼 위치를 바꿨습니다"}\n{"seq":4,"event_id":"t1","type":"prompt","actor":"teacher","text":"강사가 대신 쓴 문장"}\n{"seq":5,"event_id":"s1","type":"prompt","source_state":"simulated","text":"가상 사례의 학생 발화"}\n';
    const withEv = (evidence) => ({ ...good, findings: [{ ...good.findings[0], evidence }, ...good.findings.slice(1)] });
    for (const [id, quote] of [['r1', 'AI가 버튼 위치를 바꿨습니다'], ['t1', '강사가 대신 쓴 문장'], ['s1', '가상 사례의 학생 발화']]) assert.equal(validateDraft(withEv([{ event_id: id, quote }]), job, mixed).reason, 'evidence_not_student_work', id);
    // The same AI line is fine as context next to the learner's own words, and keeps its provenance in the stored draft.
    const ctx = validateDraft(withEv([{ event_id: 'e1', quote: '모바일에서 눌리는지 먼저 확인' }, { event_id: 'r1', quote: 'AI가 버튼 위치를 바꿨습니다' }]), job, mixed);
    assert.equal(ctx.ok, true); assert.deepEqual(ctx.draft.findings[0].evidence.map((e) => [e.actor, e.source_state]), [['student', 'unverified'], ['ai', 'unverified']]);
    assert.equal(validateDraft(withEv([{ event_id: 'e1', quote: '모바일에서 눌리는지 먼저 확인', actor: 'ai' }]), job, mixed).reason, 'evidence_provenance_mismatch', 'a draft cannot relabel who said it');
    // Legacy spool lines carry no event_id: a 1-based line (+ turn) locator names the event instead.
    const legacyInput = '{"type":"prompt","turn_id":"t-1","text":"조건을 먼저 적었어요"}\n{"type":"response","turn_id":"t-1","text":"조건을 먼저 적었어요 라고 하셨네요"}\n';
    assert.equal(validateDraft(withEv([{ locator: { line: 1, turn_id: 't-1' }, quote: '조건을 먼저 적었어요' }]), job, legacyInput).ok, true);
    assert.equal(validateDraft(withEv([{ locator: { line: 2, turn_id: 't-1' }, quote: '조건을 먼저 적었어요' }]), job, legacyInput).reason, 'evidence_not_student_work', 'the AI echoing the learner is not the learner');
    assert.equal(validateDraft(withEv([{ locator: { line: 1, turn_id: 't-9' }, quote: '조건을 먼저 적었어요' }]), job, legacyInput).reason, 'evidence_event_not_found');
  }
  assert.equal(validateDraft({ ...good, findings: [{ ...good.findings[0], evidence: [{ event_id: 'ai', quote: 'AI가 생성한 요약 문장' }] }] }, job, evA).state, 'quarantined');
  const single = composeReport(good, { class_runs_with_evidence: 1, coverage: 'complete', model: CANDIDATE_CAPABILITY_V1 }), titles = single.sections.map((s) => s.title);
  assert.deepEqual(titles, ['이번 수업에서 관찰된 행동', '판단이 바뀐 과정', NOT_YET_SEEN, '다음에 실험해볼 것'], 'observed → evidence → how the judgement changed → next experiment');
  assert.ok(!titles.includes('최근 반복된 패턴'), 'one class never yields a growth pattern'); assert.equal(single.sections[0].items[0].evidence[0].quote, '모바일에서 눌리는지 먼저 확인'); assert.equal(single.sections[2].items.length, six.length - 1);
  assert.ok(composeReport(good, { class_runs_with_evidence: 3, coverage: 'complete', model: CANDIDATE_CAPABILITY_V1 }).sections.some((s) => s.title === '최근 반복된 패턴')); assert.equal(composeReport(good, { class_runs_with_evidence: 1, coverage: 'gaps', model: CANDIDATE_CAPABILITY_V1 }).sections[0].title, '이 보고서가 본 범위');
  const text = JSON.stringify(single.sections.map((x) => [x.title, x.items.map((i) => [i.label, i.text])])); assert.match(single.sections[2].note, /점수나 미달이 아닙니다/); assert.ok(!/점수|순위|상위|하위|의존도|낮음|높음|역량 부족|\d+\s*%|\d+점/.test(text), 'no score, rank or dependency estimate in the reading surface'); assert.ok(!('score' in single.method) && single.method.scope === 'single_class');
  const empty = composeReport(draft(CANDIDATE_CAPABILITY_V1, unseen(six), { next_experiment: '' }), { class_runs_with_evidence: 1, coverage: 'complete', model: CANDIDATE_CAPABILITY_V1 }); assert.match(empty.sections[0].note, /아직 충분히 보지 못함/); assert.equal(empty.sections[2].items.every((i) => i.text === NOT_YET_SEEN), true, 'no evidence is "not seen yet", never zero');
});
const f = await localOps(); const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-c' }];
const upload = (conn, batch, ev) => f.uploadSnapshotAs(conn, batch, 1, ev);
try {
  await f.freeze(); assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true } })).status, 201);
  const a1 = (await f.pair('A1', 1, 1)).conn.json, a2 = (await f.pair('A2', 1, 2)).conn.json; for (const c of [a1, a2]) await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential);
  const batch = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false })).json.batch.id, B = f.base + '/report-batches/' + batch;
  const evB = '{"seq":1,"event_id":"e1","type":"prompt","text":"진료시간 표를 먼저 원본과 대조했어요"}\n'; assert.equal((await upload(a1, batch, evA)).status, 201); assert.equal((await upload(a2, batch, evB)).status, 201);
  let runner, R = (path, method, body) => f.request('/v1/classroom/ops/runner' + path, method, body, runner);
  await check('AT-29 jobs come only from verified inputs; a learner without input is an explicit `missing`, and re-running job creation adds nothing', async () => {
    assert.equal((await f.request(B + '/jobs', 'POST', {}, await f.teacher('fixer', ['observe', 'command']))).status, 403); assert.equal((await f.request(B + '/jobs', 'POST', { capability_model: 'hain7-to-six' })).json.reason, 'versions_invalid');
    const q = await f.request(B + '/jobs', 'POST', {}); assert.equal(q.status, 201, q.raw); assert.deepEqual(q.json.jobs.map((j) => [j.student_id, j.state, j.capability_model]), [['student-a', 'queued', 'candidate-capability-v1'], ['student-b', 'queued', 'candidate-capability-v1'], ['student-c', 'missing', 'candidate-capability-v1']]);
    assert.equal(q.json.summary.runner, 'runner_offline_or_not_started'); assert.equal((await f.request(B + '/jobs', 'POST', {})).json.jobs.length, 3);
    // The same verified input under the legacy model is a separate job and a separate version — never a conversion of the first.
    f.db.prepare("UPDATE classroom_job_outbox SET state='pending' WHERE dedupe_key LIKE '%student-a%'").run(); const legacy = await f.request(B + '/jobs', 'POST', { capability_model: 'legacy-seven-assets', rubric: 'hain7-rubric-1', evaluator: 'hain7-report-1' }); assert.equal(legacy.json.jobs.filter((j) => j.student_id === 'student-a').length, 2);
  });
  await check('AT-30 runner capability is per batch; claim leases one job; a stale runner cannot overwrite after takeover; one broken learner does not stop the rest', async () => {
    assert.equal((await f.request(B + '/runner-grants', 'POST', {}, await f.teacher('reviewer', ['observe', 'review']))).status, 403); const g = await f.request(B + '/runner-grants', 'POST', {}); assert.equal(g.status, 201); runner = g.json.runner_credential;
    assert.equal((await f.sync(runner)).status, 401, 'a runner credential is not a learner connection'); assert.equal((await R('/claim', 'POST', {})).status, 200); assert.equal((await f.request('/v1/classroom/ops/runner/claim', 'POST', {}, a1.credential)).status, 401);
    f.db.prepare("UPDATE classroom_report_jobs SET state='queued',lease_owner='',lease_expires_at=0,lease_generation=0 WHERE state='leased'").run();
    f.db.prepare("UPDATE classroom_report_jobs SET created_at=created_at+1000 WHERE capability_model='legacy-seven-assets'").run(); const j1 = (await R('/claim', 'POST', {})).json.job; assert.equal(j1.lease_generation, 1); const input = await f.app.fetch(new Request(`https://service.test/v1/classroom/ops/runner/jobs/${j1.id}/input/events.jsonl?generation=1`, { headers: { authorization: 'Bearer ' + runner } }), f.env, { waitUntil() {} }); assert.equal(input.status, 200); const text = await input.text(); assert.ok(text === evA || text === evB);
    assert.equal((await f.app.fetch(new Request(`https://service.test/v1/classroom/ops/runner/jobs/${j1.id}/input/../../x?generation=1`, { headers: { authorization: 'Bearer ' + runner } }), f.env, { waitUntil() {} })).status >= 400, true);
    // The Mac sleeps: lease expires, another claim takes the job over with generation 2; the first runner's late result is discarded.
    f.db.prepare('UPDATE classroom_report_jobs SET lease_expires_at=1 WHERE id=?').run(j1.id); const again = (await R('/claim', 'POST', {})).json.job; assert.deepEqual([again.id, again.lease_generation], [j1.id, 2]);
    const late = await R(`/jobs/${j1.id}/result`, 'POST', { lease_generation: 1, draft: draft(CANDIDATE_CAPABILITY_V1, unseen(six)) }); assert.deepEqual([late.status, late.json.reason], [409, 'lease_lost']); assert.equal((await R(`/jobs/${j1.id}/heartbeat`, 'POST', { lease_generation: 2 })).status, 200);
    const mine = text === evA ? '모바일에서 눌리는지 먼저 확인' : '먼저 원본과 대조'; const okr = await R(`/jobs/${j1.id}/result`, 'POST', { lease_generation: 2, draft: draft(CANDIDATE_CAPABILITY_V1, [{ capability: six[0], status: 'observed', claim: '확인 조건을 먼저 정함', evidence: [{ event_id: 'e1', quote: mine }] }, ...unseen(six.slice(1))]) }); assert.deepEqual([okr.status, okr.json.state], [201, 'review_required']);
    assert.equal((await R(`/jobs/${j1.id}/result`, 'POST', { lease_generation: 2, draft: {} })).status, 409, 'a finished job takes no second result');
    // Second learner: the draft quotes the OTHER learner's words → quarantined, alone.
    f.db.prepare("UPDATE classroom_report_jobs SET created_at=created_at+1000 WHERE capability_model='legacy-seven-assets'").run(); const j2 = (await R('/claim', 'POST', {})).json.job; assert.equal(j2.capability_model, 'candidate-capability-v1'); const own = await (await f.app.fetch(new Request(`https://service.test/v1/classroom/ops/runner/jobs/${j2.id}/input/events.jsonl?generation=${j2.lease_generation}`, { headers: { authorization: 'Bearer ' + runner } }), f.env, { waitUntil() {} })).text(); const stolen = await R(`/jobs/${j2.id}/result`, 'POST', { lease_generation: j2.lease_generation, draft: draft(CANDIDATE_CAPABILITY_V1, [{ capability: six[0], status: 'observed', claim: 'x', evidence: [{ event_id: 'e1', quote: own === evA ? '먼저 원본과 대조' : '모바일에서 눌리는지 먼저 확인' }] }, ...unseen(six.slice(1))]) }); assert.deepEqual([stolen.status, stolen.json.state, stolen.json.reason], [422, 'quarantined', 'evidence_not_in_event'], 'another learner\'s words under this learner\'s real event id');
    const j3 = (await R('/claim', 'POST', {})).json.job; assert.equal(j3.capability_model, 'legacy-seven-assets'); const leg = await R(`/jobs/${j3.id}/result`, 'POST', { lease_generation: j3.lease_generation, draft: { ...draft(LEGACY_SEVEN_ASSETS, unseen(seven), { legacy: { fingerprint: 'b'.repeat(32), marker_review_complete: false } }), versions: { capability_model: { id: LEGACY_SEVEN_ASSETS.id, revision: LEGACY_SEVEN_ASSETS.revision }, rubric: 'hain7-rubric-1', evaluator: 'hain7-report-1', renderer_revision: RENDERER_REVISION } } }); assert.deepEqual([leg.json.state, leg.json.reason], ['review_required', 'marker_review_missing']);
    assert.equal((await R('/claim', 'POST', {})).json.job, null);
  });
  await check('AT-29/38 review queue: audited open, digest-bound approval, legacy marker gate, approval ≠ send; six and seven stay separate rows', async () => {
    const reviewer = await f.teacher('reviewer', ['observe', 'review']); assert.equal((await f.request(B + '/reports', 'GET', undefined, await f.teacher('collector', ['observe', 'collect']))).status, 403);
    const q = (await f.request(B + '/reports', 'GET', undefined, reviewer)).json; assert.ok(!JSON.stringify(q).includes('모바일에서'), 'the queue lists states and digests, not the learner\'s words'); assert.deepEqual(q.summary.by_state, { review_required: 2, quarantined: 1, missing: 1 });
    const ready = q.jobs.find((j) => j.state === 'review_required' && j.capability_model === 'candidate-capability-v1'), legacy = q.jobs.find((j) => j.capability_model === 'legacy-seven-assets');
    f.fail('INSERT INTO ops_audit'); const blocked = await f.request(B + '/reports/' + ready.id, 'GET', undefined, reviewer); f.fail(''); assert.equal(blocked.status, 500); assert.ok(!blocked.raw.includes('확인'));
    const open = await f.request(B + '/reports/' + ready.id, 'GET', undefined, reviewer); assert.equal(open.status, 200); assert.deepEqual(open.json.report.sections.map((s) => s.title), ['이번 수업에서 관찰된 행동', '판단이 바뀐 과정', '아직 충분히 보지 못함', '다음에 실험해볼 것']); assert.equal(open.json.report.method.scope, 'single_class');
    assert.equal((await f.request(B + `/reports/${ready.id}/review`, 'PUT', { decision: 'approve', expected_revision: open.json.revision, draft_digest: 'f'.repeat(64) }, reviewer)).json.reason, 'draft_changed');
    const two = await Promise.all([f.request(B + `/reports/${ready.id}/review`, 'PUT', { decision: 'approve', expected_revision: open.json.revision, draft_digest: open.json.draft_digest }, reviewer), f.request(B + `/reports/${ready.id}/review`, 'PUT', { decision: 'needs_observation', expected_revision: open.json.revision, draft_digest: open.json.draft_digest }, reviewer)]); assert.deepEqual(two.map((r) => r.status).sort(), [200, 409]);
    const lo = await f.request(B + '/reports/' + legacy.id, 'GET', undefined, reviewer); assert.equal((await f.request(B + `/reports/${legacy.id}/review`, 'PUT', { decision: 'approve', expected_revision: lo.json.revision, draft_digest: lo.json.draft_digest }, reviewer)).json.reason, 'marker_review_missing');
    assert.equal((await f.request(B + `/reports/${q.jobs.find((j) => j.state === 'missing').id}/review`, 'PUT', { decision: 'approve', expected_revision: 1, draft_digest: '' }, reviewer)).json.reason, 'not_reviewable', 'a missing input cannot be approved into a report');
    assert.ok(f.db.prepare("SELECT count(*) n FROM classroom_report_jobs WHERE capability_model='legacy-seven-assets'").get().n === 1 && f.db.prepare("SELECT count(*) n FROM classroom_report_jobs WHERE capability_model='candidate-capability-v1'").get().n === 3);
  });
  await check('AT-30 the operator runner script drives the same lease API; with no evaluator configured the job goes back to the queue and says so — an empty draft is never sent as an evaluation — and a broken local evaluator fails one job only', async () => {
    const { runOnce, emptyDraft } = await import('../../scripts/classroom-report-runner.mjs'); assert.throws(() => emptyDraft({ capability_model: 'made-up' }));
    f.db.prepare("UPDATE classroom_report_jobs SET state='queued',reason='',lease_owner='',lease_expires_at=0,draft_digest='' WHERE state<>'missing' AND capability_model='candidate-capability-v1'").run();
    const fetchImpl = (url, init) => f.app.fetch(new Request(String(url).replace('https://runner.test', 'https://service.test'), init), f.env, { waitUntil() {} }); const lines = [];
    const drafts = () => [...f.r2.keys()].filter((k) => k.endsWith('/draft.json')).length, before = drafts();
    // No Service evaluator and no local one: the runner is NOT handed the job (so it cannot spin on it or block others), and it is told why work waits.
    const a = await runOnce({ service: 'https://runner.test', credential: runner, fetchImpl, log: (l) => lines.push(l) }); assert.equal(a.claimed, false); assert.deepEqual([a.waiting.needs_local_evaluator > 0, a.waiting.service_evaluator_configured], [true, false]); assert.match(lines.join('\n'), /the Service evaluator is NOT configured/);
    assert.equal(drafts(), before, 'no draft was written'); const reviewer = await f.teacher('reviewer', ['observe', 'review']);
    const waiting = (await f.request(B + '/reports', 'GET', undefined, reviewer)).json.jobs.filter((j) => j.capability_model === 'candidate-capability-v1' && j.state === 'queued'); assert.ok(waiting.length > 0 && waiting.every((j) => j.draft_digest === '' && j.lease_owner === ''), 'still queued, never leased, no empty draft');
    const b = await runOnce({ service: 'https://runner.test', credential: runner, fetchImpl, log: (l) => lines.push(l), evaluate: async () => { throw new Error('boom /Users/x'); } }); assert.deepEqual([b.state, b.status], ['failed', 422]);
    assert.ok(!lines.join().includes(runner) && !lines.join().includes('/Users'));
    // A locally supplied evaluator that finds nothing is an honest "not seen yet" — and it is reviewed like any draft.
    const c = await runOnce({ service: 'https://runner.test', credential: runner, fetchImpl, log: () => {}, evaluate: async ({ empty }) => empty }); assert.deepEqual([c.status, c.state], [201, 'review_required']);
    const open = (await f.request(B + '/reports/' + c.job, 'GET', undefined, reviewer)).json; assert.match(open.report.sections[0].note, /아직 충분히 보지 못함/);
  });
  await check('AT-30 legacy seven-axis jobs run the EXISTING HAIN7 engine (real python replay): seven stays seven, no score is carried, the learner\'s words are verbatim, and the missing 28-marker review keeps it out of approval', async () => {
    const { runOnce } = await import('../../scripts/classroom-report-runner.mjs'), { legacyEvaluator, legacyDraftFromAnalysis } = await import('../../scripts/classroom-legacy-hain7.mjs'), { readFileSync } = await import('node:fs');
    const sample = readFileSync(new URL('../../skills/hain7-report/examples/sample-session/events.jsonl', import.meta.url), 'utf8');
    // Pure mapping first, on the engine's real sample through the real CLI.
    const draft = await legacyEvaluator({ context: new URL('../../skills/hain7-report/examples/sample-context.json', import.meta.url).pathname })({ job: { capability_model: 'legacy-seven-assets', rubric: 'hain7-studio-signal-1.0.0', evaluator: 'hain7-replay' }, events: sample, rendererRevision: 'observation-report/1' });
    assert.deepEqual(draft.findings.map((x) => x.capability), seven); assert.ok(draft.findings.some((x) => x.status === 'observed'), 'the sample session has learner evidence');
    assert.ok(!/"(score|level|rank|percentile|criterion_band)"/.test(JSON.stringify(draft))); assert.equal(draft.legacy.marker_review_complete, false); assert.match(draft.legacy.fingerprint, /^[a-f0-9]{64}$/);
    const v = validateDraft(draft, { capability_model: 'legacy-seven-assets', rubric: 'hain7-studio-signal-1.0.0', evaluator: 'hain7-replay', input_coverage: 'sequence_unavailable' }, sample);
    assert.deepEqual([v.ok, v.state, v.reason], [true, 'review_required', 'marker_review_missing'], 'every quote is in the learner event it points at; the human marker review is still owed');
    assert.ok(draft.findings.filter((x) => x.status === 'observed').every((x) => x.evidence.every((e) => e.locator && e.actor === 'student')), 'AI prose is never legacy learner evidence');
    // An analysis with no learner evidence maps to "not seen yet" on all seven axes; and nothing can smuggle a 7→6 conversion in.
    const none = legacyDraftFromAnalysis({ axes: {}, evidence_index: [], session_fingerprint: 'a'.repeat(64), review: { status: 'complete' } }, { rubric: 'r', evaluator: 'e' }, '', 'observation-report/1'); assert.ok(none.findings.every((x) => x.status === 'unobserved')); assert.equal(none.legacy.marker_review_complete, true);
    assert.equal(validateDraft({ ...draft, derived_from_legacy: true }, { capability_model: 'legacy-seven-assets', rubric: 'hain7-studio-signal-1.0.0', evaluator: 'hain7-replay', input_coverage: 'sequence_unavailable' }, sample).reason, 'legacy_conversion');
    // Without the adapter a legacy job is not handed out at all; it is never evaluated by the six-capability path.
    f.db.prepare("UPDATE classroom_report_jobs SET state='queued',reason='',lease_owner='',lease_expires_at=0,draft_digest='',created_at=1 WHERE capability_model='legacy-seven-assets'").run();
    const fetchImpl = (url, init) => f.app.fetch(new Request(String(url).replace('https://runner.test', 'https://service.test'), init), f.env, { waitUntil() {} });
    f.db.prepare("UPDATE classroom_report_jobs SET state='approved' WHERE state='queued' AND capability_model<>'legacy-seven-assets'").run(); // leave only the legacy job waiting
    const r = await runOnce({ service: 'https://runner.test', credential: runner, fetchImpl, log: () => {} }); assert.equal(r.claimed, false, 'a runner without the legacy engine is never handed a legacy job'); assert.ok(r.waiting.needs_legacy_engine >= 1);
    assert.equal(f.db.prepare("SELECT state FROM classroom_report_jobs WHERE capability_model='legacy-seven-assets' ORDER BY created_at LIMIT 1").get().state, 'queued', 'it waits for the right engine instead of being failed or evaluated by the wrong one');
  });
  console.log(`${count} remote classroom report controls passed`);
} finally { f.close(); }
