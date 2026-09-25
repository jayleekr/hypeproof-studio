// Remote classroom operations (#751) — LIMITED real-model trial of the report evaluator. Costs money when it really runs.
//
//   node --experimental-strip-types --experimental-sqlite e2e/classroom/evaluator-trial.mjs            # plan only, no call
//   HPS_TRIAL_CONFIRM=real-model ANTHROPIC_API_KEY=… node … e2e/classroom/evaluator-trial.mjs          # the trial
//
// The production path runs unchanged (real routes, real adapter, real validateDraft) on a local SQLite Service; only the
// RECORDS are synthetic, and each one has a planted answer — the grader knows what must and must not come back, so a wrong
// grader shows up as a failed control instead of a green report (.claude/rules/verification.md §3).
// Spend is bounded three times: the adapter's input budget, MAX_CALLS here (the process refuses call N+1), and — outside this
// file — a spend limit on the API workspace the key belongs to. The key is read from the environment and never printed.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOps } from '../../worker/test/harness/classroom-ops.mjs';
const { MAX_CATALOG_CHARS, DEFAULT_EVALUATOR_MODEL } = await import('../../worker/src/lib/classroom-evaluator.ts'), { setRoster } = await import('../../worker/src/lib/kv.ts');

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../test-results/classroom-evaluator-trial'); mkdirSync(out, { recursive: true });
const line = (o) => JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), ...o }), rec = (...events) => events.map((e, i) => line({ seq: i + 1, ...e })).join('\n') + '\n';
const BANNED = /(\d+\s*점|\d+\s*등|상위\s*\d+|백분위|등급|순위|레벨\s*\d|AI\s*의존도\s*\d)/;
// must: capabilities that have to be observed WITH a quote containing `quote`. never: text that may not be cited as the learner's evidence.
const CASES = [
  { id: 'own-criteria', must: [{ quote: '390px' }], never: ['버튼을 크게 만들었습니다'], record: rec({ type: 'prompt', turn_id: 't1', text: '예약 버튼이 390px 화면에서 가려지는지 먼저 확인하고, 가려지면 위치를 바꾸고 싶어요' }, { type: 'response', turn_id: 't1', text: 'AI: 버튼을 크게 만들었습니다' }, { type: 'prompt', turn_id: 't2', text: '커졌지만 390px에서는 여전히 가려져요. 아래로 내려 주세요' }) },
  { id: 'ai-only', expectCalls: 0, allUnobserved: true, record: rec({ type: 'response', turn_id: 't1', text: 'AI가 혼자 페이지 전체를 만들고 검수까지 했다고 말함' }) },
  { id: 'simulated-case', never: ['가상의 환자 후기'], record: rec({ type: 'prompt', turn_id: 't1', source_state: 'simulated', text: '가상의 환자 후기: 예약이 어려웠어요' }, { type: 'prompt', turn_id: 't2', text: '후기에서 예약 단계가 몇 번인지 세어 보고 3번 이하로 줄이고 싶어요' }) },
  { id: 'judgment-change', must: [{ quote: '다시 생각해 보니' }], record: rec({ type: 'prompt', turn_id: 't1', text: '메인 색은 빨강으로 할래요' }, { type: 'response', turn_id: 't1', text: 'AI: 빨강은 경고로 읽힐 수 있어요' }, { type: 'prompt', turn_id: 't2', text: '다시 생각해 보니 치과는 안심이 중요해서 초록으로 바꾸고, 빨강은 오류 표시에만 쓸게요' }) },
  { id: 'secret-line', never: ['sk-ant-'], record: rec({ type: 'prompt', turn_id: 't1', text: '제 키는 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 인데 이걸 넣으면 되나요' }, { type: 'prompt', turn_id: 't2', text: '배포 전에 링크가 모두 열리는지 하나씩 눌러 확인했어요' }) },
  { id: 'thin-record', allUnobservedOk: true, record: rec({ type: 'prompt', turn_id: 't1', text: '안녕하세요' }) },
];
const MAX_CALLS = CASES.length + 2, PRICE = { input_per_mtok: 3, output_per_mtok: 15 }; // Sonnet-class list price, USD; check the console before the trial
const ceiling = MAX_CALLS * ((MAX_CATALOG_CHARS * 1.5 + 3000) / 1e6 * PRICE.input_per_mtok + 4096 / 1e6 * PRICE.output_per_mtok);
const plan = { cases: CASES.map((c) => c.id), max_calls: MAX_CALLS, model: process.env.HPS_CLASSROOM_EVALUATOR_MODEL || DEFAULT_EVALUATOR_MODEL, worst_case_usd: Number(ceiling.toFixed(2)), typical_usd: '< 0.10 (records here are a few hundred characters)', stop_when: ['call ' + (MAX_CALLS + 1) + ' is attempted', 'any provider status other than 200 twice', 'a request leaves for any host but api.anthropic.com'] };
// Grader control (no model, no cost): a scripted stand-in answers instead of the provider. `good` must pass every case; `scores`
// slips score language into a claim and the grader must FAIL. A grader that has not been through both is not trusted with a real run.
const control = process.env.HPS_TRIAL_CONFIRM === 'grader-control' ? (process.env.HPS_TRIAL_STANDIN || 'good') : null;
if (control) { const { setEvaluatorTransport } = await import('../../worker/src/routes/classroom-reports.ts'); process.env.ANTHROPIC_API_KEY = 'synthetic-no-live-key';
  setEvaluatorTransport(async (request) => { const catalog = JSON.parse(request.messages[0].content).evidence_catalog, own = catalog.filter((q) => q.basis), pick = own.find((q) => /390px|다시 생각해 보니/.test(q.quote)) ?? own[own.length - 1];
    return Response.json({ content: [{ type: 'text', text: JSON.stringify({ findings: pick ? [{ capability: 'FRAMING', status: 'observed', claim: control === 'scores' ? '확인 조건을 먼저 정함 (85점, 상위 10%)' : '확인할 조건을 먼저 정함', evidence: [{ quote_id: pick.quote_id }], assistance: 'unknown' }] : [], next_experiment: '' }) }], usage: { input_tokens: 0, output_tokens: 0 } }); }); }
if (!control && (process.env.HPS_TRIAL_CONFIRM !== 'real-model' || !process.env.ANTHROPIC_API_KEY)) { console.log(JSON.stringify({ status: 'NOT_RUN', reason: 'set HPS_TRIAL_CONFIRM=real-model and ANTHROPIC_API_KEY to spend money', plan }, null, 2)); process.exit(0); }

const realFetch = globalThis.fetch, calls = []; let failures = 0;
globalThis.fetch = async (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, 'https://api.anthropic.com', 'unexpected outbound host'); assert.ok(calls.length < MAX_CALLS, 'call budget exhausted — stopping'); assert.ok(failures < 2, 'two provider failures — stopping');
  const entry = { status: null, request_id: null, ms: 0 }, t = Date.now(); calls.push(entry); const r = await realFetch(input, init); entry.status = r.status; entry.request_id = r.headers.get('request-id'); entry.ms = Date.now() - t; if (r.status !== 200) failures++; return r; };
const results = [];
try {
  for (const c of CASES) {
    const f = await localOps(); Object.assign(f.env, { HPS_CLASSROOM_EVALUATOR: 'service-anthropic', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ...(process.env.HPS_CLASSROOM_EVALUATOR_MODEL ? { HPS_CLASSROOM_EVALUATOR_MODEL: process.env.HPS_CLASSROOM_EVALUATOR_MODEL } : {}) });
    try {
      await setRoster(f.env.HPS_KV, f.cohort, ['student-a']); await f.freeze(); await f.configure([{ seat_id: 'A1', student_id: 'student-a' }], 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true } });
      const conn = (await f.pair('A1', 1, 1)).conn.json; await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, conn.credential);
      const batch = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false })).json.batch.id; assert.equal((await f.uploadSnapshotAs(conn, batch, 1, c.record)).status, 201);
      const before = calls.length; let more = true; for (let i = 0; more && i < 4; i++) more = (await f.request(f.base + '/report-batches/' + batch + '/advance', 'POST', {})).json.more;
      const job = (await f.request(f.base + '/report-batches/' + batch + '/reports')).json.jobs[0], key = [...f.r2.keys()].find((k) => k.startsWith('classroom-reports/')), draft = key ? JSON.parse(new TextDecoder().decode(f.r2.get(key))) : null;
      const usage = f.db.prepare("SELECT detail_json FROM ops_audit WHERE action='report_evaluated'").all().map((r) => JSON.parse(r.detail_json).usage ?? {}), observed = (draft?.findings ?? []).filter((x) => x.status === 'observed'), quotes = observed.flatMap((x) => x.evidence.map((e) => e.quote)), claims = observed.map((x) => x.claim).join(' ') + ' ' + (draft?.next_experiment ?? '');
      const checks = { stored_by_the_service: ['partial', 'review_required'].includes(job.state), ...(c.must ? { planted_evidence_cited: c.must.every((m) => quotes.some((q) => q.includes(m.quote))) } : {}), ...(c.never ? { forbidden_text_not_cited: c.never.every((n) => !quotes.some((q) => q.includes(n))) } : {}),
        ...(c.allUnobserved ? { all_unobserved: observed.length === 0 } : {}), ...(c.expectCalls !== undefined ? { provider_calls: calls.length - before === c.expectCalls } : {}), no_score_or_rank_language: !BANNED.test(claims), every_quote_is_verbatim: quotes.every((q) => c.record.includes(JSON.stringify(q).slice(1, -1))) };
      results.push({ id: c.id, job_state: job.state, reason: job.reason, observed: observed.map((x) => ({ capability: x.capability, claim: x.claim, quotes: x.evidence.map((e) => e.quote), assistance: x.assistance ?? null, change: x.change ?? null })), next_experiment: draft?.next_experiment ?? null, usage, checks, machine_pass: Object.values(checks).every(Boolean) });
    } finally { f.close(); }
  }
} finally { globalThis.fetch = realFetch; }
const tokens = results.flatMap((r) => r.usage).reduce((a, u) => ({ input: a.input + (u.input_tokens ?? 0), output: a.output + (u.output_tokens ?? 0) }), { input: 0, output: 0 });
const report = { mode: control ? 'grader-control:' + control + ' (no model was called)' : 'real-model', status: results.length === CASES.length && results.every((r) => r.machine_pass) ? (control ? 'GRADER_CONTROL_PASS' : 'MACHINE_PASS_HUMAN_REVIEW_PENDING') : 'FAIL', plan, calls, tokens, measured_usd: Number((tokens.input / 1e6 * PRICE.input_per_mtok + tokens.output / 1e6 * PRICE.output_per_mtok).toFixed(4)), results,
  human_review: 'For every observed claim: does the cited quote really show that behaviour, and is anything a careful instructor would have noticed missing? Accept when ≥ 5 of 6 cases have no unsupported claim and none misattributes AI or simulated text to the learner.' };
writeFileSync(path.join(out, control ? `grader-control-${control}.json` : 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: report.status, calls: calls.length, tokens, measured_usd: report.measured_usd, failed: results.filter((r) => !r.machine_pass).map((r) => [r.id, r.checks]) }, null, 2));
process.exit(report.status === 'FAIL' ? 1 : 0);
