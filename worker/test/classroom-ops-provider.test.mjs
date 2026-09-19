// Remote classroom operations R6 (#751) — the live email adapter (Resend) and its signed webhook.
// Contract tests only: the provider's HTTP API is replaced at the fetch seam and events are signed with a
// synthetic secret. NOTHING here talks to Resend, a sandbox or a real inbox — those stay NOT RUN.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { localOps } from './harness/classroom-ops.mjs';
import { CANDIDATE_CAPABILITY_V1 } from '../src/lib/measurement-core/index.ts';
const { verifySvix, resendAdapter, resendConfigured, resendEventKind, EMAIL_TEMPLATES } = await import('../src/lib/classroom-delivery-resend.ts');
const { setResendFetch } = await import('../src/routes/classroom-delivery.ts');

test('Svix signature: the published test vector verifies; a changed body, a wrong secret and a replayed timestamp do not', async () => {
  // Vector from the Svix/Resend verification docs.
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', h = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330', signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' }, body = '{"test": 2432232314}', at = 1614265330_000;
  assert.equal(await verifySvix(secret, h, body, at), 'ok');
  assert.equal(await verifySvix(secret, h, '{"test": 2432232315}', at), 'bad_signature', 'the raw body is what is signed');
  assert.equal(await verifySvix('whsec_' + Buffer.from('another secret').toString('base64'), h, body, at), 'bad_signature');
  assert.equal(await verifySvix(secret, h, body, at + 6 * 60_000), 'stale', 'a captured event cannot be replayed later');
  assert.equal(await verifySvix(secret, { ...h, signature: 'v1,AAAA v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' }, body, at), 'ok', 'any listed signature may match (key rotation)');
  assert.equal(await verifySvix(secret, { ...h, signature: undefined }, body, at), 'missing');
});

const env = { HPS_DELIVERY_PROVIDER: 'resend', RESEND_API_KEY: 'synthetic-not-a-key', HPS_DELIVERY_FROM: 'HypeProof <reports@example.invalid>', HPS_PUBLIC_BASE_URL: 'https://service.example.invalid' };
const msg = { to: 'guardian@example.invalid', link: '/v1/classroom/report-links/' + 'a'.repeat(48), template_revision: 'report-link-ko-1', idempotency_key: 'f'.repeat(64) };
test('adapter: what it sends, and how each provider answer maps — accepted ≠ delivered, a lost answer is unknown, a refusal is not', async () => {
  let seen; const answer = (r) => resendAdapter(env, async (url, init) => { seen = { url, init }; return typeof r === 'function' ? r() : r; }).send(msg);
  assert.deepEqual(await answer(Response.json({ id: 'b1946ac9-2493-4e5c-9d1a-000000000001' })), { status: 'accepted', provider_message_id: 'b1946ac9-2493-4e5c-9d1a-000000000001' });
  const body = JSON.parse(seen.init.body); assert.equal(seen.url, 'https://api.resend.com/emails'); assert.equal(seen.init.headers['idempotency-key'], msg.idempotency_key);
  assert.deepEqual(body.tags, [{ name: 'delivery_key', value: msg.idempotency_key }]); assert.ok(body.text.includes('https://service.example.invalid/v1/classroom/report-links/')); assert.deepEqual(body.to, ['guardian@example.invalid']);
  assert.ok(!/student-|점수|등급/.test(body.subject + body.text.replace('점수나 순위가 아니라', '')), 'the mail carries a link, not the report and not the learner');
  assert.deepEqual(await answer(() => { throw new Error('network'); }), { status: 'unknown' });
  assert.deepEqual(await answer(new Response('x', { status: 503 })), { status: 'unknown' });
  assert.deepEqual(await answer(Response.json({ name: 'concurrent_idempotent_requests' }, { status: 409 })), { status: 'unknown' }, 'the first request may be going out');
  assert.deepEqual(await answer(Response.json({ ok: true })), { status: 'unknown' }, '2xx without a message id proves nothing');
  assert.deepEqual(await answer(Response.json({ name: 'validation_error' }, { status: 422 })), { status: 'rejected', reason: 'validation_error' });
  assert.deepEqual(await answer(Response.json({ name: 'rate_limit_exceeded' }, { status: 429 })), { status: 'rejected', reason: 'rate_limit_exceeded' });
  assert.deepEqual(await resendAdapter(env, async () => { throw Error('must not be called'); }).send({ ...msg, template_revision: 'made-up' }), { status: 'rejected', reason: 'template_unknown' });
  assert.equal(resendConfigured(env), true); for (const k of ['RESEND_API_KEY', 'HPS_DELIVERY_FROM', 'HPS_PUBLIC_BASE_URL']) assert.equal(resendConfigured({ ...env, [k]: undefined }), false, k);
  assert.equal(resendConfigured({ ...env, HPS_PUBLIC_BASE_URL: 'http://insecure.example.invalid' }), false);
  assert.deepEqual(['email.sent', 'email.delivered', 'email.bounced', 'email.failed', 'email.suppressed', 'email.opened', 'email.clicked', 'email.complained'].map(resendEventKind), ['accepted', 'delivered', 'bounced', 'bounced', 'bounced', null, null, null], 'opens and clicks are not read');
  assert.ok(Object.keys(EMAIL_TEMPLATES).includes('report-link-ko-1'));
});

// ── the real routes: approve → deliver through the adapter → signed events ──
const SECRET = 'whsec_' + Buffer.from('synthetic webhook secret').toString('base64');
const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }];
async function fixture(t) {
  const f = await localOps(); t.after(() => { setResendFetch(undefined); f.close(); }); Object.assign(f.env, env, { RESEND_WEBHOOK_SECRET: SECRET });
  await f.freeze(); assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true, ops_delivery: true } })).status, 201);
  const conns = []; for (let i = 0; i < 2; i++) { const c = (await f.pair(seats[i].seat_id, 1, i + 1)).conn.json; conns.push(c); await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential); }
  const batch = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false })).json.batch.id, B = f.base + '/report-batches/' + batch;
  for (const c of conns) assert.equal((await f.uploadSnapshotAs(c, batch, 1, JSON.stringify({ type: 'prompt', event_id: 'e1', text: '기대 조건을 먼저 적음' }) + '\n')).status, 201);
  await f.request(B + '/jobs', 'POST', {}); const runner = (await f.request(B + '/runner-grants', 'POST', {})).json.runner_credential, keys = CANDIDATE_CAPABILITY_V1.capabilities.map((c) => c.key);
  for (let i = 0; i < 2; i++) { const j = (await f.request('/v1/classroom/ops/runner/claim', 'POST', {}, runner)).json.job; await f.request(`/v1/classroom/ops/runner/jobs/${j.id}/result`, 'POST', { lease_generation: j.lease_generation, draft: { format: 'hps-classroom-report-draft/1', versions: { capability_model: { id: CANDIDATE_CAPABILITY_V1.id, revision: 1 }, rubric: 'unknown', evaluator: 'none', renderer_revision: 'observation-report/1' }, findings: [{ capability: keys[0], status: 'observed', claim: 'c', evidence: [{ event_id: 'e1', quote: '기대 조건' }] }, ...keys.slice(1).map((capability) => ({ capability, status: 'unobserved', claim: '', evidence: [] }))], next_experiment: '' } }, runner); }
  for (const j of (await f.request(B + '/reports')).json.jobs) assert.equal((await f.request(B + `/reports/${j.id}/review`, 'PUT', { decision: 'approve', expected_revision: j.revision, draft_digest: j.draft_digest })).status, 200);
  assert.equal((await f.request('/admin/classroom/recipients', 'POST', { class_run_id: f.run, source_ref: 'synthetic-import', recipients: seats.map((s) => ({ student_id: s.student_id, recipient_ref: 'guardian-' + s.seat_id, channel: 'email', address: s.seat_id.toLowerCase() + '@example.invalid', viewer_check: { kind: 'phone_last4', value: '4821' } })) }, null, { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') })).status, 201);
  const approve = async (template) => { const scope = (await f.request(B + '/recipients?template_revision=' + template)).json; return (await f.request(B + '/approve', 'POST', { template_revision: template, channel: 'email', scope_hash: scope.scope_hash })).json.approval_id; };
  let n = 0; const event = (type, emailId, tags, { id = 'msg_' + (++n), at = Date.now(), secret = SECRET } = {}) => { const raw = JSON.stringify({ type, created_at: new Date(at).toISOString(), data: { email_id: emailId, ...(tags ? { tags } : {}) } }), ts = String(Math.floor(at / 1000)); const sig = 'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
    return f.app.fetch(new Request('https://service.test/v1/classroom/delivery-webhooks/resend', { method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig, 'content-type': 'application/json' }, body: raw }), f.env, { waitUntil() {} }).then(async (r) => ({ status: r.status, json: await r.json() })); };
  const rows = () => f.db.prepare('SELECT student_id,state,provider_message_id,attempts,detail FROM classroom_report_deliveries ORDER BY student_id').all().map((r) => ({ ...r }));
  return { ...f, B, approve, event, rows, deliver: (approval_id) => f.request(B + '/deliver', 'POST', { approval_id, dry_run: false }) };
}

test('live send through the adapter: a reviewed template only; accepted, unknown and failed are different rows; only a definite failure may be retried', async (t) => {
  const f = await fixture(t), calls = [];
  assert.equal((await f.deliver(await f.approve('made-up-template'))).json.reason, 'template_unknown'); assert.equal(f.rows().length, 0, 'refused before anything was written or sent');
  const approval = await f.approve('report-link-ko-1');
  setResendFetch(async (_url, init) => { const b = JSON.parse(init.body); calls.push(b.to[0]); return b.to[0].startsWith('a1') ? Response.json({ id: 'resend-msg-000001' }) : Response.json({ name: 'rate_limit_exceeded' }, { status: 429 }); });
  let r = await f.deliver(approval); assert.equal(r.status, 202, r.raw);
  assert.deepEqual(f.rows().map((x) => [x.student_id, x.state, x.detail]), [['student-a', 'provider_accepted', ''], ['student-b', 'failed', 'rate_limit_exceeded']]);
  setResendFetch(async (_url, init) => { calls.push(JSON.parse(init.body).to[0]); throw new Error('timeout'); });
  r = await f.deliver(approval); assert.deepEqual(calls, ['a1@example.invalid', 'a2@example.invalid', 'a2@example.invalid'], 'the accepted message is a replay; only the definite failure is tried again');
  assert.deepEqual(f.rows().map((x) => [x.state, x.attempts]), [['provider_accepted', 1], ['send_unknown', 2]]);
  r = await f.deliver(approval); assert.equal(calls.length, 3, 'an unknown send is never sent again to find out'); assert.ok(r.json.results.every((x) => x.replay));
  // The signed event that names the delivery_key settles the unknown send — without another send.
  const key = f.db.prepare("SELECT delivery_key k FROM classroom_report_deliveries WHERE state='send_unknown'").get().k;
  const settled = await f.event('email.delivered', 'resend-msg-000002', [{ name: 'delivery_key', value: key }]); assert.deepEqual(settled.json, { applied: true, state: 'delivered' });
  assert.deepEqual(f.rows()[1], { student_id: 'student-b', state: 'delivered', provider_message_id: 'resend-msg-000002', attempts: 2, detail: 'settled_by_provider_event' });
});

test('webhook: only a valid signature is read; duplicates are absorbed; out-of-order events never move a state backwards; opens are ignored', async (t) => {
  const f = await fixture(t); setResendFetch(async (_u, init) => Response.json({ id: 'resend-msg-' + JSON.parse(init.body).to[0].slice(0, 2) + '0000' }));
  await f.deliver(await f.approve('report-link-ko-1')); const before = JSON.stringify(f.rows());
  assert.equal((await f.event('email.delivered', 'resend-msg-a10000', null, { secret: 'whsec_' + Buffer.from('attacker').toString('base64') })).status, 401);
  assert.equal((await f.event('email.delivered', 'resend-msg-a10000', null, { at: Date.now() - 10 * 60_000 })).status, 400, 'replayed event');
  assert.equal(JSON.stringify(f.rows()), before, 'an unauthenticated event changes nothing');
  // delivered arrives BEFORE sent (providers do not promise order), then sent arrives late, then the same event again.
  assert.deepEqual((await f.event('email.delivered', 'resend-msg-a10000', null, { id: 'msg_fixed_1' })).json, { applied: true, state: 'delivered' });
  assert.deepEqual((await f.event('email.sent', 'resend-msg-a10000')).json, { applied: false, state: 'delivered' }, 'a late "sent" does not undo "delivered"');
  assert.deepEqual((await f.event('email.delivered', 'resend-msg-a10000', null, { id: 'msg_fixed_1' })).json, { duplicate: true });
  assert.deepEqual((await f.event('email.bounced', 'resend-msg-a20000')).json, { applied: true, state: 'bounced' });
  assert.deepEqual((await f.event('email.opened', 'resend-msg-a10000')).json, { ignored: true }); assert.deepEqual((await f.event('email.delivered', 'resend-msg-unknown-0')).json, { applied: false, state: 'unmatched' });
  assert.deepEqual(f.rows().map((x) => x.state), ['delivered', 'bounced']);
  // A key tag cannot hijack a row that already has its own message id.
  const key = f.db.prepare("SELECT delivery_key k FROM classroom_report_deliveries WHERE student_id='student-a'").get().k;
  assert.deepEqual((await f.event('email.bounced', 'resend-msg-forged-1', [{ name: 'delivery_key', value: key }])).json, { applied: false, state: 'unmatched' });
  delete f.env.RESEND_WEBHOOK_SECRET; assert.equal((await f.event('email.delivered', 'resend-msg-a10000')).status, 404, 'no secret configured → the route does not exist');
});

test('not configured: without every setting the live path refuses and only dry-run works', async (t) => {
  const f = await fixture(t); delete f.env.RESEND_API_KEY; const approval = await f.approve('report-link-ko-1');
  assert.equal((await f.deliver(approval)).json.reason, 'delivery_provider_not_configured'); assert.equal(f.rows().length, 0);
  assert.equal((await f.request(f.B + '/deliver', 'POST', { approval_id: approval, dry_run: true })).status, 202); assert.deepEqual(f.rows().map((x) => x.state), ['dry_run', 'dry_run']);
});
