// Remote classroom operations (#751) — G1 wrap-up steps ("수업 마무리 단계") after the independent review hold of 2026-09-22.
//
// The hold: renderWrap called collection and drafts DONE for a live batch with 0 of 24 records and 24 queued jobs (Codex probe,
// direct render). Each step now derives its state from counts the page read for THIS run and THIS finish batch and says it in words.
//
//   A  direct render (synthetic, labelled): the reviewer's pending-only fixture verbatim, then the same numbers bound to a batch
//   B  route-backed pending-only: a live finish, nothing arrived yet → in progress, never done
//   C  route-backed mixed: a missing evaluator is "needs attention", one arrival is "partly", an unconnected seat and an
//      evaluator refusal are "needs attention", partial approval is not "review done", approval / provider acceptance are not sent
//   D  stale answers: a held read of the previous batch (collection, queue, deliveries) arriving after a new batch is dropped
//   E  route-backed finished: every eligible record verified, every draft approved, every message delivered → done, in words
//   F  transient errors: a failed re-read is "unknown" (last value named as such) and recovers on the next good read
//   G  another class run: nothing of the previous run's batch; everyone excluded is "nothing to do", not done
// Real: Chalk page and script in Chromium, the Service router + SQLite, the upload/seal routes, the report queue, the review
// route, the delivery routes and the operator delivery-event route. Synthetic: accounts, the device uploads (the App's own freezer
// via the harness, not a Studio window), the model (transport stub), the mail provider (transport stub) and its "delivered" events.
// Not evidence about a real Studio window, a real model or mailbox, staging or production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { localOps } from '../../worker/test/harness/classroom-ops.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.join(repo, 'e2e/test-results/classroom-ops-g1-wrap'); mkdirSync(out, { recursive: true });
const local = await localOps(), { default: chalk } = await import('../../chalk/src/index.ts'), { setRoster, startSession } = await import('../../worker/src/lib/kv.ts');
const { setEvaluatorTransport } = await import('../../worker/src/routes/classroom-reports.ts'), { setResendFetch } = await import('../../worker/src/routes/classroom-delivery.ts');
const realFetch = globalThis.fetch; globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? local.app.fetch(new Request(url, init), local.env, { waitUntil() {} }) : realFetch(url, init);
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const admin = { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') }, results = {}; let browser, n = 0;
const ok = (name) => { n++; console.log('PASS ' + name); };
try {
  const seats = [1, 2, 3, 4, 5].map((i) => ({ seat_id: 'S' + i, student_id: 'student-0' + i }));
  await setRoster(local.env.HPS_KV, local.cohort, seats.map((s) => s.student_id)); await local.freeze();
  assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true, ops_delivery: true } })).status, 201);
  // S1–S3 connected and consenting · S4 consented, then its connection lapsed (grant expiry moved into the past in SQLite — the
  // Service then reports the seat as not connected; re-paired for batch 2) · S5 never consented (excluded).
  const conns = {}; for (const [i, s] of seats.slice(0, 4).entries()) conns[s.seat_id] = (await local.pair(s.seat_id, 1, i + 1)).conn.json;
  const consent = (c) => local.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential);
  for (const c of Object.values(conns)) assert.equal((await consent(c)).status, 201);
  local.db.prepare("UPDATE ops_grants SET expires_at=1 WHERE seat_id='S4' AND kind='connection'").run();
  const upload = async (seat, batch) => { const r = await local.uploadSnapshotAs(conns[seat], batch, 1, `{"seq":1,"event_id":"e-${seat}","type":"prompt","text":"${seat} 좌석이 확인 조건을 먼저 적음"}\n`); assert.equal(r.status, 201, seat + ' seal: ' + r.raw); return r.json; };

  // The model is a transport stub: S3's request is refused (HTTP 400 → the Service records a failed job, no invented draft).
  let evalCalls = 0; setEvaluatorTransport(async (request) => { evalCalls++; const body = request.messages[0].content; if (body.includes('S3 좌석')) return new Response('{"error":"synthetic refusal"}', { status: 400 }); const cat = JSON.parse(body).evidence_catalog, own = cat.find((q) => q.basis) ?? cat[0];
    return Response.json({ content: [{ type: 'text', text: JSON.stringify({ findings: [{ capability: 'FRAMING', status: 'observed', claim: '확인할 조건을 먼저 정함', evidence: [{ quote_id: own.quote_id }], assistance: 'independent' }], next_experiment: '확인 조건을 두 개 적어 보기' }) }] }); });
  const evaluatorOn = (on) => { if (on) Object.assign(local.env, { HPS_CLASSROOM_EVALUATOR: 'service-anthropic', ANTHROPIC_API_KEY: 'synthetic-not-a-key' }); else { delete local.env.HPS_CLASSROOM_EVALUATOR; delete local.env.ANTHROPIC_API_KEY; } };
  // The mail provider is a transport stub; "delivered" comes later from the operator delivery-event route, as a provider webhook would.
  const mails = []; Object.assign(local.env, { HPS_DELIVERY_PROVIDER: 'resend', RESEND_API_KEY: 'synthetic-not-a-key', HPS_DELIVERY_FROM: 'HypeProof <reports@example.invalid>', HPS_PUBLIC_BASE_URL: 'https://service.example.invalid' });
  setResendFetch(async (_u, init) => { mails.push(JSON.parse(init.body)); return Response.json({ id: 'resend-wrap-' + String(mails.length).padStart(4, '0') }); });
  const recipients = (list) => local.request('/admin/classroom/recipients', 'POST', { class_run_id: local.run, source_ref: 'synthetic-import-' + crypto.randomUUID().slice(0, 8), recipients: list.map((s) => ({ student_id: s, recipient_ref: 'guardian-' + s, channel: 'email', address: s + '@example.invalid', viewer_check: { kind: 'phone_last4', value: '4821' } })) }, null, admin);
  const delivered = async (id) => assert.equal((await local.request('/admin/classroom/delivery-events', 'POST', { provider_event_id: 'evt-' + id, provider_message_id: id, kind: 'delivered' }, null, admin)).json.state, 'delivered');

  browser = await chromium.launch(); const origin = 'http://127.0.0.1:' + server.address().port, errors = [], teacher = await local.teacher('teacher-a');
  const open = async () => { const p = await browser.newPage({ viewport: { width: 1280, height: 720 } }); p.on('pageerror', (e) => errors.push(e.message)); await p.goto(origin + '/manage');
    await p.locator('#token').fill(teacher); await p.locator('#cohort').fill(local.cohort); await p.locator('#prefix').fill('student-'); await p.locator('#connect-go').click(); await p.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await p.locator('#ops-wrap-steps > li').first().waitFor(); return p; };
  const steps = (p) => p.locator('#ops-wrap-steps > li').evaluateAll((l) => l.map((x) => ({ state: x.dataset.state, cls: x.className, badge: x.querySelector('.wrap-badge')?.textContent, text: x.innerText.replace(/\n+/g, '\n') })));
  const states = async (p) => (await steps(p)).map((s) => s.state);
  // Wait until the four steps read as expected (the page polls and advances on its own); fail with what it did show.
  const until = async (p, want, why, timeout = 30000) => { const end = Date.now() + timeout; let got; while (Date.now() < end) { got = await steps(p); if (want.every((w, i) => w === null || got[i].state === w)) return got; await p.waitForTimeout(150); } throw Error(why + ': want ' + JSON.stringify(want) + ' got ' + JSON.stringify(got, null, 1)); };
  const shot = async (p, name) => { await p.locator('#ops-wrap').scrollIntoViewIfNeeded(); await p.locator('#ops-wrap').screenshot({ path: path.join(out, name) }); };
  const finish = async (p) => { const prev = await p.evaluate(() => finishBatch); await p.locator('#ops-finish-dry').uncheck(); await p.locator('#ops-finish-go').click(); await p.waitForFunction((x) => finishBatch && finishBatch !== x, prev); return p.evaluate(() => finishBatch); };
  const refresh = (p) => p.locator('#refresh').click();

  // ── A. the reviewer's direct-render counterexample (synthetic presentation fixture — no Service state behind it) ──
  { const p = await open(); await until(p, ['idle', 'idle', 'idle', 'idle'], 'before any finish');
    const verbatim = await p.evaluate(() => { opsData.run.flags.ops_collect = true; opsData.run.flags.ops_reports = true; lastFinish = { batch: { dry_run: false }, summary: { verified: 0, roster: 24, held: 0 } }; wrapQueue = { summary: { jobs: 24, by_state: { queued: 24 } } }; wrapEval = true; renderWrap(); return [...document.querySelectorAll('#ops-wrap-steps > li')].map((e) => e.dataset.state); });
    assert.ok(!verbatim.includes('done'), 'the reviewer fixture (no batch identity) is not shown as done: ' + verbatim);
    const bound = await p.evaluate(() => { finishBatch = 'synthetic-batch'; finishRun = opsData.run.class_run_id; lastFinish = { batch: { id: 'synthetic-batch', dry_run: false, upload_open: true }, summary: { verified: 0, verified_complete_coverage: 0, roster: 24, held: 0, by_state: { requested: 24 } } }; wrapQueue = { batch: 'synthetic-batch', d: { summary: { jobs: 24, by_state: { queued: 24 }, runner: 'runner_offline_or_not_started' } } }; wrapEval = { batch: 'synthetic-batch', on: true }; renderWrap();
      const r = [...document.querySelectorAll('#ops-wrap-steps > li')].map((e) => ({ state: e.dataset.state, text: e.innerText.replace(/\n+/g, '\n') })); finishForget(); renderWrap(); return r; });
    assert.deepEqual(bound.map((s) => s.state), ['pending', 'pending', 'idle', 'idle']); assert.match(bound[0].text, /^1 기록 회수 … 진행 중\n서버 검증 0 \/ 회수 대상 24명 · 도착 전 24 — 아직 도착한 기록이 없습니다/);
    assert.match(bound[1].text, /^2 보고서 초안 … 진행 중\n초안 0 \/ 대상 24건 · 초안 대기 24 \(실행기 꺼짐·시작 전\) — 아직 초안이 없습니다/); assert.match(bound[2].text, /검수할 초안이 아직 없습니다/);
    results.direct_render = { verbatim, bound }; await p.close(); ok('A direct render (synthetic): the reviewer\'s pending-only fixture is not done; bound to a batch it reads 진행 중 / 진행 중 / 시작 전 / 시작 전 in words'); }

  const page = await open(); evaluatorOn(true);
  // ── B. route-backed pending-only: a live finish, no record arrived ──
  const b1 = await finish(page);
  let s = await until(page, ['pending', 'pending', 'idle', 'idle'], 'pending-only'); results.pending_only = s;
  assert.match(s[0].text, /^1 기록 회수 … 진행 중\n서버 검증 0 \/ 회수 대상 4명 · 도착 전 3 · 도착하지 않음: 기기 연결 없음 1 · 동의 없어 제외 1 — 아직 도착한 기록이 없습니다/);
  assert.match(s[1].text, /초안 0 \/ 대상 3건 · 기록 도착 대기 3 · 검증된 기록 없음 2 \(0점 아님\) — 아직 초안이 없습니다/, 'jobs of learners whose records are still coming are waiting, not "nothing to do"');
  assert.equal(s.filter((x) => x.state === 'done').length, 0); assert.equal(evalCalls, 0); await shot(page, 'wrap-pending-only-1280.png');
  ok('B route-backed pending-only: 0 of 4 arrived and 3 jobs waiting on records read 진행 중, never 완료');

  // ── C. mixed, route-backed ──
  evaluatorOn(false); await upload('S1', b1); await page.locator('#ops-jobs-go').click();
  s = await until(page, ['partial', 'blocked', 'idle', 'idle'], 'no evaluator on this server');
  assert.match(s[1].text, /이 서버에는 평가기가 설정돼 있지 않아 초안을 만들지 못합니다/); assert.match(s[0].text, /서버 검증 1 \/ 회수 대상 4명 · 그중 기록 범위 전체 확인 1 · 도착 전 2 .* 일부만 도착했습니다/);
  ok('C1 evaluator missing: collection 일부만, drafts 확인 필요 (no empty draft stands in)');
  evaluatorOn(true); await upload('S2', b1); await upload('S3', b1); await page.locator('#ops-jobs-go').click();
  s = await until(page, ['blocked', 'blocked', 'pending', 'idle'], 'mixed arrivals, one refusal'); results.mixed = s;
  assert.match(s[0].text, /서버 검증 3 \/ 회수 대상 4명 .* 도착하지 않음: 기기 연결 없음 1 · 동의 없어 제외 1 — 더 기다려도 오지 않을 수 있습니다/);
  assert.match(s[1].text, /초안 2 \/ 대상 3건 · 실패·격리 1 · 검증된 기록 없음 2 \(0점 아님\) — 초안을 만들지 못한 학생이 있습니다/); assert.match(s[2].text, /내용 승인 0 \/ 초안 2건 · 검수 대기 2/);
  const approve = async (student) => { await page.locator('#ops-reports-list p').filter({ hasText: student }).getByRole('button', { name: '초안 열기' }).click(); await page.getByRole('button', { name: '근거 확인하고 내용 승인' }).click(); await page.locator('#ops-reports-state').filter({ hasText: '검수 결과를 저장했습니다' }).waitFor(); };
  await approve('student-01'); s = await until(page, ['blocked', 'blocked', 'partial', 'idle'], 'one of two approved');
  assert.match(s[2].text, /^3 검수 ◐ 일부만\n내용 승인 1 \/ 초안 2건 · 검수 대기 1/); await shot(page, 'wrap-mixed-partial-1280.png');
  assert.equal((await recipients(['student-01'])).status, 201); await page.locator('#ops-recipients-go').click(); await page.locator('#ops-delivery-state').filter({ hasText: '보낼 메시지 1건' }).waitFor();
  await page.locator('#ops-approve-go').click(); await page.locator('#ops-delivery-state').filter({ hasText: '아직 아무것도 보내지 않았습니다' }).waitFor(); s = await until(page, [null, null, null, 'idle'], 'approved, not sent'); assert.match(s[3].text, /발송 승인 1건 · 아직 보내지 않았습니다/); assert.equal(mails.length, 0);
  await page.locator('#ops-send-go').click(); await page.locator('#ops-send-yes').click(); s = await until(page, [null, null, null, 'pending'], 'provider accepted');
  assert.match(s[3].text, /^4 발송 … 진행 중\n전달 확인 0 \/ 보낸 메시지 1건 · 제공자 접수 1 \(전달 미확인\) — 요청·접수는 전달이 아닙니다/); assert.equal(mails.length, 1);
  ok('C2 mixed: 3 of 4 verified + an unconnected seat = 확인 필요; a refused draft = 확인 필요; 1 of 2 approved = 일부만; approval = 시작 전 (not sent); provider acceptance = 진행 중 (not delivered)');

  // ── D. stale answers from batch 1 arriving after batch 2 started ──
  const held = []; let holding = true; const hold = (re) => page.route(re, async (route) => { if (!holding || route.request().method() !== 'GET') return route.continue(); held.push(route); });
  const b1url = new RegExp('/report-batches/' + b1 + '(/reports|/deliveries)?$'); await hold(b1url);
  await refresh(page); await page.locator('#ops-reports-refresh').click(); await page.locator('#ops-deliveries-go').click();
  { const end = Date.now() + 10000; while (held.length < 3 && Date.now() < end) await page.waitForTimeout(50); } assert.equal(held.length, 3, 'batch 1 collection, queue and deliveries reads are in flight');
  conns.S4 = (await local.pair('S4', 1, 5)).conn.json; holding = false;
  const b2 = await finish(page); assert.notEqual(b2, b1);
  s = await until(page, ['pending', 'pending', 'idle', 'idle'], 'batch 2 right after its start');
  for (const r of held.splice(0)) await r.continue(); await page.waitForTimeout(800); await page.unroute(b1url);
  s = await steps(page); results.stale_answers = s; assert.deepEqual(s.map((x) => x.state), ['pending', 'pending', 'idle', 'idle'], 'batch 1 answers landing late label nothing of batch 2');
  assert.match(s[0].text, /서버 검증 0 \/ 회수 대상 4명 · 도착 전 4/); assert.doesNotMatch(s.map((x) => x.text).join('\n'), /내용 승인 1 |제공자 접수|발송 승인 \d/);
  assert.equal(await page.locator('#ops-send-go').isDisabled(), true, 'the batch 1 approval is not armed against batch 2');
  ok('D stale: batch 1 collection / queue / delivery answers held until batch 2 started are dropped; batch 1\'s approval and send do not label batch 2');

  // ── E. genuinely finished, route-backed ──
  for (const seat of ['S1', 'S2', 'S4']) await upload(seat, b2);
  setEvaluatorTransport(async (request) => { evalCalls++; const cat = JSON.parse(request.messages[0].content).evidence_catalog, own = cat.find((q) => q.basis) ?? cat[0]; return Response.json({ content: [{ type: 'text', text: JSON.stringify({ findings: [{ capability: 'FRAMING', status: 'observed', claim: '확인할 조건을 먼저 정함', evidence: [{ quote_id: own.quote_id }], assistance: 'independent' }], next_experiment: '확인 조건을 두 개 적어 보기' }) }] }); });
  await refresh(page); s = await until(page, ['partial', null, null, null], 'three of four arrived'); assert.doesNotMatch(s[0].badge, /완료/);
  await upload('S3', b2); await refresh(page); await page.locator('#ops-jobs-go').click();
  s = await until(page, ['done', 'done', 'pending', 'idle'], 'all arrived and drafted'); assert.match(s[0].text, /^1 기록 회수 ✓ 완료\n서버 검증 4 \/ 회수 대상 4명 · 그중 기록 범위 전체 확인 4 · 동의 없어 제외 1 — 모두 도착해 서버가 검증했습니다/);
  assert.match(s[1].text, /^2 보고서 초안 ✓ 완료\n초안 4 \/ 대상 4건 · 검증된 기록 없음 1 \(0점 아님\) — 대상 모두 초안이 있습니다 \(검수 전\)/);
  for (const st of ['student-01', 'student-02', 'student-03']) await approve(st); s = await until(page, [null, null, 'partial', null], '3 of 4 approved'); assert.doesNotMatch(s[2].text, /✓ 완료/);
  await approve('student-04'); s = await until(page, ['done', 'done', 'done', 'idle'], 'all approved'); assert.match(s[2].text, /^3 검수 ✓ 완료\n내용 승인 4 \/ 초안 4건 · 검수 대기 0 — 승인은 내용 확인이며 발송 승인이 아닙니다/);
  assert.equal((await recipients(['student-01', 'student-02', 'student-03', 'student-04'])).status, 201); await page.locator('#ops-recipients-go').click(); await page.locator('#ops-delivery-state').filter({ hasText: '보낼 메시지 4건' }).waitFor();
  await page.locator('#ops-approve-go').click(); await page.locator('#ops-delivery-state').filter({ hasText: '이 목록 4건에 대한 발송을 승인했습니다' }).waitFor(); assert.match((await steps(page))[3].text, /발송 승인 4건 · 아직 보내지 않았습니다/); const before = mails.length; await page.locator('#ops-send-go').click(); await page.locator('#ops-send-yes').click();
  s = await until(page, [null, null, null, 'pending'], 'batch 2 accepted'); assert.match(s[3].text, /제공자 접수 4 \(전달 미확인\)/); assert.equal(mails.length, before + 4); await shot(page, 'wrap-accepted-not-delivered-1280.png');
  for (let i = before + 1; i <= before + 3; i++) await delivered('resend-wrap-' + String(i).padStart(4, '0'));
  await page.locator('#ops-deliveries-go').click(); s = await until(page, [null, null, null, 'partial'], 'three delivered'); assert.match(s[3].text, /전달 확인 3 \/ 보낸 메시지 4건 · 제공자 접수 1 \(전달 미확인\)/);
  await delivered('resend-wrap-' + String(before + 4).padStart(4, '0')); await page.locator('#ops-deliveries-go').click();
  s = await until(page, ['done', 'done', 'done', 'done'], 'everything delivered'); results.finished = s; assert.match(s[3].text, /^4 발송 ✓ 완료\n전달 확인 4 \/ 보낸 메시지 4건 — 전달은 열람이 아닙니다/);
  const done = await page.locator('#ops-wrap-steps > li.done .wrap-badge').first().evaluate((e) => ({ color: getComputedStyle(e).color, size: parseFloat(getComputedStyle(e).fontSize) })); assert.ok(done.size >= 14, JSON.stringify(done));
  await shot(page, 'wrap-finished-1280.png'); ok('E route-backed finished: 4/4 verified with whole coverage, 4/4 drafted, 4/4 approved, 4/4 delivered (after 3/4 = 일부만) read ✓ 완료 in words');

  // ── F. transient errors ──
  const b2only = new RegExp('/report-batches/' + b2 + '$'); await page.route(b2only, (r) => r.request().method() === 'GET' ? r.fulfill({ status: 503, body: '{"reason":"synthetic"}' }) : r.continue());
  await refresh(page); s = await until(page, ['unknown', null, null, null], 'collection re-read failed'); assert.match(s[0].text, /^1 기록 회수 \? 확인 불가\n.*지금 서버에서 다시 읽지 못했습니다 — 마지막으로 읽은 값입니다/);
  await page.unroute(b2only); await refresh(page); await until(page, ['done', null, null, null], 'recovered');
  const dl = new RegExp('/report-batches/' + b2 + '/deliveries$'); await page.route(dl, (r) => r.abort()); await page.locator('#ops-deliveries-go').click();
  s = await until(page, [null, null, null, 'unknown'], 'delivery re-read failed'); assert.match(s[3].text, /전달 확인 4 \/ 보낸 메시지 4건 .*다시 읽지 못했습니다/); await page.unroute(dl);
  await page.locator('#ops-deliveries-go').click(); await until(page, ['done', 'done', 'done', 'done'], 'delivery recovered');
  ok('F transient: a failed collection or delivery re-read is ? 확인 불가 with the last value named as such, and recovers on the next good read');

  // ── G. another class run; everyone excluded ──
  const run2 = 'ops-test-run-2', t = Date.now(); local.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES(?,?,?,?,?)').run(run2, local.cohort, local.profile, new Date(t - 60000).toISOString(), new Date(t + 3600000).toISOString());
  await startSession(local.env.HPS_KV, local.cohort, { session_id: run2, profile_id: local.profile, starts_at: new Date(t - 60000).toISOString(), ends_at: new Date(t + 3600000).toISOString() });
  assert.equal((await local.request(`/admin/cohorts/${local.cohort}/classroom/runs/${run2}`, 'PUT', { expected_roster_revision: 0, seats: seats.slice(0, 2).map((x) => ({ seat_id: 'T' + x.seat_id.slice(1), student_id: x.student_id })), flags: { ops_observe: true, ops_collect: true, ops_reports: true, ops_delivery: true }, lesson: local.lesson })).status, 201);
  await refresh(page); await page.locator('#ops-state').filter({ hasText: run2 }).waitFor(); s = await until(page, ['idle', 'idle', 'idle', 'idle'], 'another run shows nothing of run 1');
  assert.equal(await page.locator('#ops-finish-items p').count(), 0); assert.equal(await page.locator('#ops-reports').isHidden(), true);
  await finish(page); await page.locator('#ops-finish-state').filter({ hasText: /^명단 2명/ }).waitFor();
  s = await until(page, ['none', 'none', 'none', 'idle'], 'everyone excluded'); results.all_excluded = s;
  assert.match(s[0].text, /^1 기록 회수 – 대상 없음\n서버 검증 0 \/ 회수 대상 0명 · 동의 없어 제외 2 — 회수할 학생이 없습니다\. 완료가 아니라 할 일이 없는 것입니다/); assert.match(s[1].text, /검증된 기록 없음 2 \(0점 아님\) — 초안을 만들 대상이 없습니다\. 완료가 아닙니다/);
  await shot(page, 'wrap-all-excluded-1280.png'); ok('G another run: nothing of run 1\'s batch; all excluded reads – 대상 없음, not 완료');

  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ at: new Date().toISOString(), synthetic: { accounts: true, device_uploads: 'harness freezer', model: 'transport stub', mail: 'transport stub + operator delivery events', direct_render: 'A only' }, ...results }, null, 2) + '\n');
  console.log(n + ' G1 wrap-state checks passed → ' + out);
} finally { if (browser) await browser.close(); await new Promise((r) => server.close(r)); globalThis.fetch = realFetch; local.close(); }
