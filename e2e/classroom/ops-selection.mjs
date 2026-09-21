// Remote classroom operations (#751, U1) — AT-37 in a real browser: the selection and the selected-collection panel of Chalk
// /manage under answers that arrive LATE, OUT OF ORDER, or report a FAILED request.
//
// Two defects were reproduced by an independent review on 2026-09-21 (remote-classroom-evidence/management-20260921/):
//   P1  a delayed preview answer arrived after the roster had changed: the panel re-opened "A1 · student-a — 요청 예정" next to
//       "선택한 좌석이 없습니다", and confirming it asked student-c's device (the revision was read AFTER the await);
//   P2  a request that ended `failed` was still counted as "진행 중", which also hid "다시 선택".
// Real here: the Chalk page and its script in Chromium, the Service router + SQLite, the snapshot upload of one seat.
// Controlled here: WHEN an answer reaches the browser (held at the network layer — the Service has already answered), and the
// terminal state of upload commands (set in the ledger, because a real device cannot be made to fail on cue). Synthetic accounts.
// Not evidence about a real Studio window (that is mac-demo-board.mjs), Windows, a school network, staging or production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { localOps } from '../../worker/test/harness/classroom-ops.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.join(repo, 'e2e/test-results/classroom-ops-selection'); mkdirSync(out, { recursive: true });
const local = await localOps(), { default: chalk } = await import('../../chalk/src/index.ts'), { setRoster } = await import('../../worker/src/lib/kv.ts'), { setEvaluatorTransport } = await import('../../worker/src/routes/classroom-reports.ts');
const realFetch = globalThis.fetch; globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? local.app.fetch(new Request(url, init), local.env, { waitUntil() {} }) : realFetch(url, init);
const chalkServer = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
chalkServer.listen(0, '127.0.0.1'); await once(chalkServer, 'listening');
let n = 0; const ok = (name) => { n++; console.log('PASS ' + name); }; let browser, evaluatorCalls = 0; const evidence = {};
try {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], seats = ids.slice(0, 8).map((x, i) => ({ seat_id: 'A' + (i + 1), student_id: 'student-' + x }));
  await setRoster(local.env.HPS_KV, local.cohort, ids.map((x) => 'student-' + x)); await local.freeze();
  assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true } })).status, 201);
  local.env.HPS_CLASSROOM_EVALUATOR = 'service-anthropic'; local.env.ANTHROPIC_API_KEY = 'synthetic-not-a-key'; setEvaluatorTransport(async () => { evaluatorCalls++; return Response.json({ content: [{ type: 'text', text: '{}' }] }); });
  const consent = (c) => local.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential);
  const conn = {}; for (const [i, s] of seats.entries()) { conn[s.seat_id] = (await local.pair(s.seat_id, 1, i + 1)).conn.json; assert.equal((await consent(conn[s.seat_id])).status, 201); await local.sync(conn[s.seat_id].credential, [local.event(1, 'activation', { stage: 'token_verified' })], i + 1); }
  const live = () => local.db.prepare("SELECT b.roster_revision rev,i.seat_id,i.student_id,i.state FROM classroom_collect_batches b JOIN classroom_collect_items i ON i.batch_id=b.id WHERE b.dry_run=0 AND i.state<>'not_selected' ORDER BY b.created_at,i.seat_id").all(), asked = () => local.db.prepare("SELECT t.seat_id,s.student_id FROM ops_command_targets t JOIN ops_commands c ON c.id=t.command_id JOIN class_run_seats s ON s.class_run_id=t.class_run_id AND s.seat_id=t.seat_id AND s.seat_revision=t.seat_revision WHERE c.action='retry_evidence_upload' ORDER BY t.updated_at").all();

  browser = await chromium.launch(); const origin = 'http://127.0.0.1:' + chalkServer.address().port, page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  // Hold the ANSWER of chosen report-batches POSTs: the Service has already processed the request when the browser is kept waiting.
  const held = []; let holdNext = 0;
  await page.route('**/report-batches', async (route) => { if (route.request().method() !== 'POST' || holdNext <= 0) return route.continue(); holdNext--; const response = await route.fetch(); let release; const gate = new Promise((r) => { release = r; }); held.push({ body: JSON.parse(route.request().postData()), release }); await gate; await route.fulfill({ response }); });
  const heldAnswer = async (k) => { for (let i = 0; i < 100 && held.length <= k; i++) await page.waitForTimeout(50); assert.ok(held[k], 'request ' + k + ' was not intercepted'); return held[k]; };
  await page.goto(origin + '/manage'); await page.locator('#token').fill(local.teacherToken); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill('student-'); await page.locator('#connect button').first().click();
  await page.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await page.locator('#ops-check').click(); const row = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`); await row('A8').waitFor();
  const box = (id) => row(id).getByLabel('선택'), selection = () => page.locator('#ops-selection').innerText(), state = () => page.locator('#ops-pick-state').innerText(), refresh = async () => { await page.locator('#ops-check').click(); await page.waitForTimeout(700); };
  const confirmOpen = () => page.locator('#ops-pick-confirm').isVisible(), checked = async () => { const v = []; for (const s of seats) if (await box(s.seat_id).isChecked()) v.push(s.seat_id); return v; };

  // ── control: the ordinary path still works (preview → confirm → the Service records exactly what was shown) ──
  await box('A8').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); assert.match(await page.locator('#ops-pick-preview').innerText(), /A8 · student-h — 요청 예정/);
  await page.locator('#ops-pick-go').click(); await page.locator('#ops-pick-state').filter({ hasText: /선택 회수 · 대상 1명/ }).waitFor(); assert.deepEqual(live().map((x) => [x.rev, x.seat_id, x.student_id]), [[1, 'A8', 'student-h']]);
  await page.locator('#ops-select-none').click(); ok('control: an undisturbed preview and confirmation request exactly the seat that was shown');

  // ── P1a: a preview answer held back while the selection changes, while it is cleared, and behind a newer preview ──
  await box('A2').check(); holdNext = 1; await page.locator('#ops-pick-collect').click(); const p1 = await heldAnswer(0); assert.deepEqual(p1.body.targets, ['A2']);
  await box('A3').check(); assert.match(await state(), /선택이나 명단·연결 상태가 바뀌었습니다/); p1.release(); await page.waitForTimeout(500);
  assert.equal(await confirmOpen(), false, 'an answer about [A2] must not open a confirmation while [A2, A3] is selected');
  holdNext = 1; await page.locator('#ops-pick-collect').click(); const p2 = await heldAnswer(1); await page.locator('#ops-select-none').click(); p2.release(); await page.waitForTimeout(500);
  assert.equal(await confirmOpen(), false, 'an answer that arrives after "선택 해제" opens nothing'); assert.match(await selection(), /선택한 좌석이 없습니다/); assert.equal(await page.locator('#ops-pick-collect').isDisabled(), true, 'the finishing older request did not re-enable the button for an empty selection');
  // two previews, answers in reverse order: the newer one is shown, the older one changes nothing when it finally lands
  await box('A2').check(); holdNext = 1; await page.locator('#ops-pick-collect').click(); const older = await heldAnswer(2); await box('A2').uncheck(); await box('A3').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor();
  assert.match(await page.locator('#ops-pick-preview').innerText(), /^A3 · student-c — 요청 예정$/); older.release(); await page.waitForTimeout(500); assert.match(await page.locator('#ops-pick-preview').innerText(), /^A3 · student-c — 요청 예정$/, 'the late answer about A2 did not replace the preview of A3');
  await page.locator('#ops-pick-cancel').click(); assert.equal(await confirmOpen(), false); assert.match(await state(), /취소했습니다/); await page.locator('#ops-select-none').click();
  assert.deepEqual(live().length, 1, 'none of the discarded previews requested anything'); ok('P1: a late preview answer is dropped after a selection change, a cleared selection, a newer preview and a cancel');

  // ── P1b (the reproduced defect): preview of A1(student-a) held → the seat changes hands (roster 2) → refresh → the old answer lands ──
  await box('A1').check(); holdNext = 1; await page.locator('#ops-pick-collect').click(); const stale = await heldAnswer(3); assert.deepEqual([stale.body.roster_revision, stale.body.targets], [1, ['A1']]);
  const moved = await local.configure([{ seat_id: 'A1', student_id: 'student-i' }, ...seats.slice(1)], 1); assert.equal(moved.status, 200, moved.raw);
  const newcomer = (await local.pair('A1', 2, 9)).conn.json; assert.equal((await consent(newcomer)).status, 201); // the new learner is connected AND consenting: nothing but the UI stands between the old confirmation and them
  await refresh(); assert.match(await selection(), /선택한 좌석이 없습니다/); assert.match(await state(), /명단이 바뀌어 선택을 비웠습니다/); assert.deepEqual(await checked(), [], 'no checkbox stays ticked for a selection that was emptied');
  evidence.before_late_answer = { selection: await selection(), state: await state(), confirm_open: await confirmOpen() };
  stale.release(); await page.waitForTimeout(800);
  evidence.after_late_answer = { selection: await selection(), state: await state(), confirm_open: await confirmOpen(), preview: await page.locator('#ops-pick-preview').innerText() };
  assert.equal(await confirmOpen(), false, 'the old answer must not re-open "A1 · student-a — 요청 예정"'); assert.equal(await page.locator('#ops-pick-preview').innerText(), '');
  // Even a forced click on the hidden button requests nothing: confirming re-checks the ticket, the roster and the selection.
  await page.evaluate(() => document.getElementById('ops-pick-go').click()); await page.waitForTimeout(500);
  assert.deepEqual(asked().filter((t) => t.student_id === 'student-i'), [], 'the learner who now holds A1 was asked nothing'); assert.equal(live().length, 1); evidence.ledger_after = { live_batches: live(), asked: asked() };
  // …and the honest path for the new holder works: select, preview (names student-i), confirm → revision 2, student-i.
  await box('A1').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); assert.match(await page.locator('#ops-pick-preview').innerText(), /^A1 · student-i — 요청 예정$/);
  await page.locator('#ops-pick-go').click(); await page.locator('#ops-pick-state').filter({ hasText: /선택 회수 · 대상 1명/ }).waitFor(); assert.deepEqual({ ...live().at(-1) }, { rev: 2, seat_id: 'A1', student_id: 'student-i', state: 'requested' }, 'what was confirmed (student-i) is what was requested');
  await page.locator('#ops-select-none').click(); ok('P1 reproduced defect: a preview answered after the seat changed hands opens nothing, ticks nothing and requests nothing');

  // ── P1c: two confirmations whose answers arrive in reverse order ──
  await box('A4').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); holdNext = 1; await page.locator('#ops-pick-go').click(); const firstGo = await heldAnswer(4); assert.deepEqual([firstGo.body.dry_run, firstGo.body.targets], [false, ['A4']]);
  await box('A4').uncheck(); await box('A5').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); await page.locator('#ops-pick-go').click(); await page.locator('#ops-pick-items').filter({ hasText: /A5 · student-e/ }).waitFor();
  firstGo.release(); await page.waitForTimeout(700); assert.match(await page.locator('#ops-pick-items').innerText(), /^A5 · student-e/, 'the older confirmation\'s late answer did not take over the result panel'); assert.match(await page.locator('#ops-pick-older').innerText(), /앞서 확인한 회수 요청\(대상 A4\)도 서버에 접수되었습니다/);
  assert.deepEqual(live().slice(-2).map((x) => x.seat_id).sort(), ['A4', 'A5'], 'both confirmed requests exist once each — neither was lost or doubled'); await page.locator('#ops-select-none').click();
  ok('P1: confirmations answered out of order — the newest owns the panel, the older accepted one is named, nothing is doubled');

  // ── P2: one batch, every way a target can end. The ledger states are set here; the page only reads the Service. ──
  await setRoster(local.env.HPS_KV, local.cohort, ids.map((x) => 'student-' + x));
  for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']) await box(id).check();
  await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); await page.locator('#ops-pick-go').click(); await page.locator('#ops-pick-items').filter({ hasText: /A8 · student-h/ }).waitFor();
  const batch = local.db.prepare("SELECT b.id FROM classroom_collect_batches b JOIN classroom_collect_scopes s ON s.batch_id=b.id WHERE b.dry_run=0 ORDER BY b.created_at DESC LIMIT 1").get().id;
  const target = (seat, st, code = '') => local.db.prepare("UPDATE ops_command_targets SET state=?,result_code=?,updated_at=? WHERE seat_id=? AND command_id=(SELECT id FROM ops_commands WHERE idempotency_key=?)").run(st, code, Date.now(), seat, 'collect-' + batch);
  const line = (o) => JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), ...o }), record = [line({ seq: 1, type: 'prompt', turn_id: 't1', text: 'synthetic' }), line({ seq: 2, type: 'turn_end', turn_id: 't1', status: 'ok' })].join('\n') + '\n';
  assert.equal((await local.uploadSnapshotAs(conn.A2, batch, 1, record)).status, 201); target('A2', 'succeeded', 'receipt_verified');                                     // verified
  const half = await local.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${batch}/1/session.meta.json`, { method: 'PUT', headers: { authorization: 'Bearer ' + conn.A3.credential }, body: local.metaFor(conn.A3) }), local.env, { waitUntil() {} }); assert.equal(half.status, 201); target('A3', 'running'); // bytes arriving
  target('A4', 'failed', 'upload_failed'); target('A5', 'rejected', 'busy'); target('A6', 'expired'); target('A7', 'unsupported'); target('A8', 'outcome_unknown'); // A1 stays queued (no device receipt)
  await page.locator('#ops-pick-state').filter({ hasText: /실패·미도착 4/ }).waitFor({ timeout: 15000 }).catch(async (e) => { throw Error('panel did not settle: ' + (await state()), { cause: e }); });
  const panel = await state(), items = await page.locator('#ops-pick-items').innerText(); evidence.failed_retry = { state: panel, items, retry_visible: await page.locator('#ops-pick-retry').isVisible(), retry_label: await page.locator('#ops-pick-retry').innerText() };
  assert.match(panel, /대상 8명 · 서버 검증됨 1 · 기기 응답 대기 1 · 전송·검증 대기 1 · 실패·미도착 4 · 결과 미확인 1 · 제외 0 .* 진행 중인 대상이 있습니다/, 'a terminal failure is not counted as in progress: ' + panel);
  for (const [seat, text] of [['A1', /서버 접수 · 기기 수신 확인 전|서버가 기기에 배정함 · 기기 수신 확인 전/], ['A2', /서버 검증됨/], ['A3', /전송 중 · 아직 검증 전/], ['A4', /기기에서 실패 \(upload_failed\) · 기록 미도착/], ['A5', /기기가 거절함/], ['A6', /시간 초과 · 기기에 도착하지 않음/], ['A7', /이 앱 버전은 지원하지 않음/], ['A8', /결과 확인 불가 · 현장 확인 필요 · 기록 미도착 · 성공으로 세지 않습니다/]]) assert.match(items.split('\n').find((l) => l.startsWith(seat + ' ')) ?? '', text, seat);
  assert.equal(await page.locator('#ops-pick-retry').isVisible(), true, 'failed targets can be re-selected while others are still in flight'); assert.match(await page.locator('#ops-pick-retry').innerText(), /실패·미확인 5명만 다시 선택 \(진행 중 2명은 제외\)/);
  assert.match(await page.locator('#ops-pick-grace').innerText(), /새 회수 요청입니다.*까지 도착하면 그대로 검증됩니다.*전송 중이거나 검증된 학생은 다시 요청하지 않습니다/);
  await page.screenshot({ path: path.join(out, 'failed-and-in-flight.png'), fullPage: true });
  await page.locator('#ops-pick-retry').click(); assert.deepEqual(await checked(), ['A4', 'A5', 'A6', 'A7', 'A8'], 'only the failed and the unconfirmed seats — not the queued, the sending or the verified one'); assert.match(await selection(), /선택 5 \/ 전체 8석/);
  assert.equal(await confirmOpen(), false, 're-selecting requests nothing by itself'); const before = live().length; await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); assert.match(await page.locator('#ops-pick-impact').innerText(), /선택 5명 중 5명에게/); assert.equal(live().length, before);
  await page.locator('#ops-pick-cancel').click(); ok('P2: failed / rejected / expired / unsupported are failures, outcome_unknown stays unknown, queued·sending·verified are never re-selected');

  assert.equal(evaluatorCalls, 0, 'nothing in this file reached the evaluator'); assert.deepEqual(errors, [], 'no page error');
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ schema: 'hps-classroom-ops-selection/1', at: new Date().toISOString(), checks: n, evidence }, null, 2));
  console.log(`${n} selection / late-answer / failed-request checks passed → ${out}`);
} finally { setEvaluatorTransport(undefined); globalThis.fetch = realFetch; await browser?.close(); chalkServer.close(); local.close(); }
