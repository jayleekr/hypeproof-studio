// Remote classroom operations (#751) — LIMITED real-mail trial of report delivery (Resend). Sends real e-mail when it really runs.
//
//   node --experimental-strip-types --experimental-sqlite e2e/classroom/delivery-trial.mjs     # plan + local controls, no network
//   HPS_TRIAL_CONFIRM=real-mail RESEND_API_KEY=… HPS_DELIVERY_FROM='Name <reports@sub.domain>' \
//     [HPS_TRIAL_OPERATOR_MAILBOXES=a@x,b@y] node … e2e/classroom/delivery-trial.mjs           # the trial
//
// The production path runs unchanged (real routes, real Resend adapter, real ledger) on a local SQLite Service; the class,
// the learners, the record and the report evaluator are synthetic. Spend and reach are bounded:
//   - recipients are ONLY the provider's own test addresses plus at most two operator mailboxes named in the environment;
//   - MAX_SENDS is enforced by this process (send N+1 aborts), and every outbound host except api.resend.com is refused;
//   - the key and the mailboxes are read from the environment and never printed (addresses are masked in the output).
// What a LOCAL Service cannot show, and this file therefore reports as NOT_RUN: the signed webhook reaching the Service
// (delivered / bounced / complained → ledger), and a person opening the link from a real mailbox (viewer check, lock after
// five wrong answers, 404 after withdrawal). Those need the staging Service: docs/testing/classroom-admin.md "메일(Resend)".
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOps } from '../../worker/test/harness/classroom-ops.mjs';
const { setEvaluatorTransport } = await import('../../worker/src/routes/classroom-reports.ts'), { setResendFetch } = await import('../../worker/src/routes/classroom-delivery.ts'), { setRoster } = await import('../../worker/src/lib/kv.ts');

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../test-results/classroom-delivery-trial'); mkdirSync(out, { recursive: true });
const PROVIDER_TEST = ['delivered@resend.dev', 'bounced@resend.dev', 'complained@resend.dev'], MAX_SENDS = 10, MAX_OPERATOR = 2, TEMPLATE = 'report-link-ko-1';
const real = process.env.HPS_TRIAL_CONFIRM === 'real-mail', mask = (a) => a.replace(/^(.).*(@.*)$/, '$1***$2');
const operators = (process.env.HPS_TRIAL_OPERATOR_MAILBOXES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
assert.ok(operators.length <= MAX_OPERATOR, `at most ${MAX_OPERATOR} operator mailboxes`); for (const a of operators) assert.match(a, /^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'operator mailbox is not an address');
const addresses = [...PROVIDER_TEST, ...operators]; assert.ok(addresses.length <= MAX_SENDS);
const plan = { mode: real ? 'REAL MAIL' : 'plan + local controls (no network)', recipients: addresses.map(mask), max_sends: MAX_SENDS, template: TEMPLATE,
  machine_checks: ['① provider_accepted right after the send, never "delivered"', '③ the same approval pressed again sends nothing new (ledger + Idempotency-Key)', '④ a webhook with a wrong signature is refused and changes nothing; the same event twice applies once (LOCAL, synthetic events signed with a throwaway secret)', 'a recipient without a viewer check is not sent a real mail'],
  not_run_here: ['② delivered/bounced/complained arriving by signed webhook from Resend (needs a public staging Service)', '⑤ opening the link from a real mailbox: wrong answer → right answer → report; lock after five wrong answers', '⑥ the same link is 404 after withdrawal', 'provider timeout → send_unknown cannot be forced on a real account'],
  stop_when: [`send ${MAX_SENDS + 1} is attempted`, 'a request leaves for any host but api.resend.com', 'any address outside the list above would be written to'] };
console.log(JSON.stringify({ plan }, null, 2));
if (real) { assert.ok(process.env.RESEND_API_KEY, 'RESEND_API_KEY is not set'); assert.match(process.env.HPS_DELIVERY_FROM ?? '', /<[^@\s]+@[^@\s>]+>$/, "HPS_DELIVERY_FROM must be 'Name <address@verified-subdomain>'"); }

const f = await localOps(), realFetch = globalThis.fetch, sent = [], results = { schema: 'hps-classroom-delivery-trial/1', started_at: new Date().toISOString(), mode: plan.mode, checks: [] };
const check = (id, status, detail) => { results.checks.push({ id, status, ...detail }); console.log(`${status} ${id}`); };
const admin = { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
try {
  // ── a synthetic class with one approved report per recipient ──
  // One learner per address, plus a negative control: a learner whose recipient has NO viewer check. A real mail must never leave for it.
  const seats = [...addresses, 'no-viewer-check'].map((_, i) => ({ seat_id: 'T' + (i + 1), student_id: 'trial-learner-' + (i + 1) })); await setRoster(f.env.HPS_KV, f.cohort, seats.map((s) => s.student_id)); await f.freeze();
  assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true, ops_delivery: true } })).status, 201);
  f.env.HPS_CLASSROOM_EVALUATOR = 'service-anthropic'; f.env.ANTHROPIC_API_KEY = 'synthetic-not-a-key';
  setEvaluatorTransport(async (request) => { const own = JSON.parse(request.messages[0].content).evidence_catalog.find((q) => q.basis); return Response.json({ content: [{ type: 'text', text: JSON.stringify({ findings: own ? [{ capability: 'FRAMING', status: 'observed', claim: '확인할 조건을 말로 제시했습니다.', evidence: [{ quote_id: own.quote_id }], assistance: 'unknown' }] : [], next_experiment: '다음에는 확인 기준을 먼저 적어 보세요.' }) }], usage: { input_tokens: 100, output_tokens: 40 } }); });
  const conns = []; for (let i = 0; i < seats.length; i++) { const c = (await f.pair(seats[i].seat_id, 1, i + 1)).conn.json; assert.equal((await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential)).status, 201); conns.push(c); }
  const batch = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false })).json.batch.id, B = f.base + '/report-batches/' + batch;
  const line = (o) => JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), ...o });
  for (const c of conns) assert.equal((await f.uploadSnapshotAs(c, batch, 1, [line({ seq: 1, type: 'prompt', turn_id: 't1', text: '[합성 시험 기록] 예약 버튼이 390px 화면에서 가려지는지 먼저 확인하고 싶어요' }), line({ seq: 2, type: 'turn_end', turn_id: 't1', status: 'ok' })].join('\n') + '\n')).status, 201);
  for (let i = 0; i < 6; i++) { await f.request(B + '/advance', 'POST', {}); if ((await f.request(B + '/reports')).json.jobs.every((j) => j.state === 'review_required')) break; }
  for (const j of (await f.request(B + '/reports')).json.jobs) { const d = (await f.request(B + '/reports/' + j.id)).json; assert.equal((await f.request(B + '/reports/' + j.id + '/review', 'PUT', { decision: 'approve', expected_revision: d.revision, draft_digest: d.draft_digest })).json.state, 'approved'); }
  const recipients = seats.map((s, i) => ({ student_id: s.student_id, recipient_ref: 'trial-recipient-' + (i + 1), channel: 'email', address: addresses[i] ?? PROVIDER_TEST[0], ...(i < addresses.length ? { viewer_check: { kind: 'passphrase', value: 'trial-only-' + (1000 + i) } } : {}) }));
  assert.equal((await f.request('/admin/classroom/recipients', 'POST', { class_run_id: f.run, source_ref: 'delivery-trial', recipients }, null, admin)).status, 201);

  // ── the only door to the network ──
  Object.assign(f.env, { HPS_DELIVERY_PROVIDER: 'resend', RESEND_API_KEY: real ? process.env.RESEND_API_KEY : 'synthetic-not-a-key', HPS_DELIVERY_FROM: real ? process.env.HPS_DELIVERY_FROM : 'Trial <reports@example.invalid>', HPS_PUBLIC_BASE_URL: 'https://local-trial.invalid' });
  setResendFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url), body = JSON.parse(init.body); assert.equal(url.origin, 'https://api.resend.com', 'unexpected outbound host: ' + url.origin);
    assert.ok(sent.length < MAX_SENDS, `send ${MAX_SENDS + 1} attempted — stopping`); for (const to of [].concat(body.to)) assert.ok(addresses.includes(to), 'a recipient outside the trial list');
    sent.push({ to: [].concat(body.to).map(mask), idempotency_key: init.headers?.['Idempotency-Key'] ?? init.headers?.['idempotency-key'] ?? null, has_link: /report-links\//.test(JSON.stringify(body)) });
    return real ? realFetch(input, init) : Response.json({ id: 'plan-only-' + sent.length });
  });
  const scope = (await f.request(`${B}/recipients?template_revision=${TEMPLATE}`)).json; assert.equal(scope.will_send.length, seats.length, JSON.stringify(scope)); assert.ok(scope.will_send.every((r) => r.address.includes('***')), 'addresses are masked for the instructor');
  const approval = await f.request(B + '/approve', 'POST', { template_revision: TEMPLATE, channel: 'email', scope_hash: scope.scope_hash }); assert.equal(approval.status, 201, approval.raw); assert.equal(sent.length, 0, 'approval sends nothing');
  const first = await f.request(B + '/deliver', 'POST', { approval_id: approval.json.approval_id, dry_run: false }); assert.equal(first.status, 202, first.raw);
  const expectSent = addresses.length, states = first.json.results.map((r) => r.state);
  check('accepted_is_not_delivered', states.filter((s) => s === 'provider_accepted').length === expectSent && !states.includes('delivered') ? 'PASS' : 'FAIL', { states, sends: sent.length, provider: real ? 'api.resend.com' : 'plan-only stand-in' });
  check('viewer_check_required_for_real_mail', first.json.results.find((r) => r.recipient_ref === 'trial-recipient-' + seats.length)?.state === 'not_sent_viewer_check_missing' && sent.length === expectSent ? 'PASS' : 'FAIL', { control_state: first.json.results.find((r) => r.recipient_ref === 'trial-recipient-' + seats.length)?.state });
  const again = await f.request(B + '/deliver', 'POST', { approval_id: approval.json.approval_id, dry_run: false });
  check('second_press_sends_nothing', sent.length === expectSent && again.json.results.filter((r) => r.replay).length === expectSent ? 'PASS' : 'FAIL', { sends_total: sent.length, idempotency_keys_unique: new Set(sent.map((s) => s.idempotency_key)).size === sent.length && sent.every((s) => s.idempotency_key) });

  // ── webhook handling, LOCAL: events signed with a throwaway secret (the real signing secret is never needed here) ──
  const secretBytes = Buffer.from('local-trial-webhook-secret-000000'), whsec = 'whsec_' + secretBytes.toString('base64'); f.env.RESEND_WEBHOOK_SECRET = whsec;
  const row = f.db.prepare("SELECT delivery_key,provider_message_id FROM classroom_report_deliveries WHERE batch_id=? AND state='provider_accepted' LIMIT 1").get(batch);
  const hook = (id, payload, sign = true) => { const ts = String(Math.floor(Date.now() / 1000)), raw = JSON.stringify(payload), sig = createHmac('sha256', sign ? secretBytes : Buffer.from('wrong-secret')).update(`${id}.${ts}.${raw}`).digest('base64'); return f.app.fetch(new Request('https://service.test/v1/classroom/delivery-webhooks/resend', { method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,' + sig, 'content-type': 'application/json' }, body: raw }), f.env, { waitUntil() {} }); };
  const event = { type: 'email.delivered', data: { email_id: row.provider_message_id, tags: [{ name: 'delivery_key', value: row.delivery_key }] } }, stateOf = () => f.db.prepare('SELECT state FROM classroom_report_deliveries WHERE delivery_key=?').get(row.delivery_key).state;
  const forged = await hook('msg_forged', event, false), afterForged = stateOf(), ok1 = await hook('msg_local_1', event), afterFirst = stateOf(), ok2 = await hook('msg_local_1', event), events = f.db.prepare("SELECT count(*) n FROM classroom_delivery_events WHERE provider_event_id='resend:msg_local_1'").get().n;
  check('webhook_signature_and_replay_local', forged.status === 401 && afterForged === 'provider_accepted' && ok1.status < 300 && afterFirst === 'delivered' && ok2.status < 300 && events === 1 ? 'PASS' : 'FAIL', { forged_status: forged.status, state_after_forged: afterForged, state_after_signed: afterFirst, stored_events_for_one_id: events, note: 'synthetic event, throwaway secret — not evidence that Resend\'s real webhook reaches the Service' });
  for (const id of plan.not_run_here) results.checks.push({ id, status: 'NOT_RUN' });
  results.sent = sent; results.status = results.checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'PASS_MACHINE_PART';
} catch (err) { results.status = 'ERROR'; results.error = String(err?.stack ?? err).slice(0, 1200); console.error(err); process.exitCode = 1;
} finally { setEvaluatorTransport(undefined); setResendFetch(undefined); f.close(); results.finished_at = new Date().toISOString(); writeFileSync(path.join(out, real ? 'result-real.json' : 'result-plan.json'), JSON.stringify(results, null, 2)); console.log(`${results.status} → ${path.join(out, real ? 'result-real.json' : 'result-plan.json')}`); if (results.status === 'FAIL') process.exitCode = 1; }
