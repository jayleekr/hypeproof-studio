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
  const box = (id) => row(id).getByLabel('선택'), selection = () => page.locator('#ops-selection').innerText(), state = () => page.locator('#ops-pick-state').innerText(), note = () => page.locator('#ops-pick-note').innerText(), refresh = async () => { await page.locator('#ops-check').click(); await page.waitForTimeout(700); };
  const confirmOpen = () => page.locator('#ops-pick-confirm').isVisible(), checked = async () => { const v = []; for (const s of seats) if (await box(s.seat_id).isChecked()) v.push(s.seat_id); return v; };

  // ── control: the ordinary path still works (preview → confirm → the Service records exactly what was shown) ──
  await box('A8').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); assert.match(await page.locator('#ops-pick-preview').innerText(), /A8 · student-h — 요청 예정/);
  await page.locator('#ops-pick-kind-record').check(); await page.locator('#ops-pick-go').click(); await page.locator('#ops-pick-items').filter({ hasText: /^A8 · student-h/ }).waitFor(); assert.deepEqual(live().map((x) => [x.rev, x.seat_id, x.student_id]), [[1, 'A8', 'student-h']]);
  // Seen on the real Mac run (2026-09-21): the confirm-step notice stayed next to "서버 검증됨 · 결과 확정". Once confirmed it must be replaced.
  assert.doesNotMatch(await note(), /확인만 했습니다/, 'the notice of the confirm step does not survive the confirmation'); assert.equal(await note(), '', 'the confirm-step note is cleared'); assert.match(await page.locator('#ops-last-what').innerText(), /회수\(수업 기록 전체\) 요청 접수 → A8 \(지금 선택과 같은 대상\)/, 'the accepted request is named with its targets, apart from the current selection');
  await page.locator('#ops-select-none').click(); ok('control: an undisturbed preview and confirmation request exactly the seat that was shown');

  // ── P1a: a preview answer held back while the selection changes, while it is cleared, and behind a newer preview ──
  await box('A2').check(); holdNext = 1; await page.locator('#ops-pick-collect').click(); const p1 = await heldAnswer(0); assert.deepEqual(p1.body.targets, ['A2']);
  await box('A3').check(); assert.match(await note(), /선택이나 명단·연결 상태가 바뀌었습니다/); p1.release(); await page.waitForTimeout(500);
  assert.equal(await confirmOpen(), false, 'an answer about [A2] must not open a confirmation while [A2, A3] is selected');
  holdNext = 1; await page.locator('#ops-pick-collect').click(); const p2 = await heldAnswer(1); await page.locator('#ops-select-none').click(); p2.release(); await page.waitForTimeout(500);
  assert.equal(await confirmOpen(), false, 'an answer that arrives after "선택 해제" opens nothing'); assert.match(await selection(), /선택한 좌석이 없습니다/); assert.equal(await page.locator('#ops-pick-collect').isDisabled(), true, 'the finishing older request did not re-enable the button for an empty selection');
  // two previews, answers in reverse order: the newer one is shown, the older one changes nothing when it finally lands
  await box('A2').check(); holdNext = 1; await page.locator('#ops-pick-collect').click(); const older = await heldAnswer(2); await box('A2').uncheck(); await box('A3').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor();
  assert.match(await page.locator('#ops-pick-preview').innerText(), /^A3 · student-c — 요청 예정$/); older.release(); await page.waitForTimeout(500); assert.match(await page.locator('#ops-pick-preview').innerText(), /^A3 · student-c — 요청 예정$/, 'the late answer about A2 did not replace the preview of A3');
  await page.locator('#ops-pick-cancel').click(); assert.equal(await confirmOpen(), false); assert.match(await note(), /취소했습니다/); await page.locator('#ops-select-none').click();
  assert.deepEqual(live().length, 1, 'none of the discarded previews requested anything'); ok('P1: a late preview answer is dropped after a selection change, a cleared selection, a newer preview and a cancel');

  // ── P1b (the reproduced defect): preview of A1(student-a) held → the seat changes hands (roster 2) → refresh → the old answer lands ──
  await box('A1').check(); holdNext = 1; await page.locator('#ops-pick-collect').click(); const stale = await heldAnswer(3); assert.deepEqual([stale.body.roster_revision, stale.body.targets], [1, ['A1']]);
  const moved = await local.configure([{ seat_id: 'A1', student_id: 'student-i' }, ...seats.slice(1)], 1); assert.equal(moved.status, 200, moved.raw);
  const newcomer = (await local.pair('A1', 2, 9)).conn.json; assert.equal((await consent(newcomer)).status, 201); // the new learner is connected AND consenting: nothing but the UI stands between the old confirmation and them
  await refresh(); assert.match(await selection(), /선택한 좌석이 없습니다/); assert.match(await note(), /명단이 바뀌어 선택을 비웠습니다/); assert.deepEqual(await checked(), [], 'no checkbox stays ticked for a selection that was emptied');
  evidence.before_late_answer = { selection: await selection(), state: await note(), confirm_open: await confirmOpen() };
  stale.release(); await page.waitForTimeout(800);
  evidence.after_late_answer = { selection: await selection(), state: await note(), confirm_open: await confirmOpen(), preview: await page.locator('#ops-pick-preview').innerText() };
  assert.equal(await confirmOpen(), false, 'the old answer must not re-open "A1 · student-a — 요청 예정"'); assert.equal(await page.locator('#ops-pick-preview').innerText(), '');
  // Even a forced click on the hidden button requests nothing: confirming re-checks the ticket, the roster and the selection.
  await page.evaluate(() => { document.getElementById('ops-pick-kind-record').checked = true; document.getElementById('ops-pick-go').click(); }); await page.waitForTimeout(500);
  assert.deepEqual(asked().filter((t) => t.student_id === 'student-i'), [], 'the learner who now holds A1 was asked nothing'); assert.equal(live().length, 1); evidence.ledger_after = { live_batches: live(), asked: asked() };
  // …and the honest path for the new holder works: select, preview (names student-i), confirm → revision 2, student-i.
  await box('A1').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); assert.match(await page.locator('#ops-pick-preview').innerText(), /^A1 · student-i — 요청 예정$/);
  await page.locator('#ops-pick-kind-record').check(); await page.locator('#ops-pick-go').click(); await page.locator('#ops-pick-items').filter({ hasText: /^A1 · student-i/ }).waitFor({ timeout: 10000 }).catch(async (e) => { throw Error('the honest confirmation did not go through: ' + await note() + ' | ' + await state(), { cause: e }); }); assert.deepEqual(live().filter((x) => x.rev === 2).map((x) => [x.seat_id, x.student_id, x.state]), [['A1', 'student-i', 'requested']], 'what was confirmed (student-i) is what was requested');
  await page.locator('#ops-select-none').click(); ok('P1 reproduced defect: a preview answered after the seat changed hands opens nothing, ticks nothing and requests nothing');

  // ── P1c: two confirmations whose answers arrive in reverse order ──
  await box('A4').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); holdNext = 1; await page.locator('#ops-pick-kind-record').check(); await page.locator('#ops-pick-go').click(); const firstGo = await heldAnswer(4); assert.deepEqual([firstGo.body.dry_run, firstGo.body.targets], [false, ['A4']]);
  await box('A4').uncheck(); await box('A5').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); await page.locator('#ops-pick-kind-record').check(); await page.locator('#ops-pick-go').click(); await page.locator('#ops-pick-items').filter({ hasText: /A5 · student-e/ }).waitFor();
  firstGo.release(); await page.waitForTimeout(700); assert.match(await page.locator('#ops-pick-items').innerText(), /^A5 · student-e/, 'the older confirmation\'s late answer did not take over the result panel'); assert.match(await page.locator('#ops-pick-older').innerText(), /앞서 확인한 회수 요청\(대상 A4\)도 서버에 접수되었습니다/);
  assert.deepEqual(live().filter((x) => ['A4', 'A5'].includes(x.seat_id)).map((x) => x.seat_id).sort(), ['A4', 'A5'], 'both confirmed requests exist once each — neither was lost or doubled'); await page.locator('#ops-select-none').click();
  ok('P1: confirmations answered out of order — the newest owns the panel, the older accepted one is named, nothing is doubled');

  // ── Lifecycle (item × device request × upload grace). Every leg below CHANGES state on the real Service while the page is open
  //    and checks what the page says before and after. Command outcomes are written to the ledger (a real device cannot be made to
  //    fail on cue); PUT, seal, the batch view, Chalk and the page are real. ──
  const line = (o) => JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), ...o }), record = [line({ seq: 1, type: 'prompt', turn_id: 't1', text: 'synthetic' }), line({ seq: 2, type: 'turn_end', turn_id: 't1', status: 'ok' })].join('\n') + '\n';
  const newest = () => local.db.prepare("SELECT b.id FROM classroom_collect_batches b JOIN classroom_collect_scopes s ON s.batch_id=b.id WHERE b.dry_run=0 ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1").get().id;
  const target = (batch, seat, st, code = '') => local.db.prepare("UPDATE ops_command_targets SET state=?,result_code=?,updated_at=? WHERE seat_id=? AND command_id=(SELECT id FROM ops_commands WHERE idempotency_key=?)").run(st, code, Date.now(), seat, 'collect-' + batch);
  const putMeta = async (batch, c) => (await local.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${batch}/1/p1.meta.json`, { method: 'PUT', headers: { authorization: 'Bearer ' + c.credential }, body: local.metaFor(c) }), local.env, { waitUntil() {} })).status;
  const rowOf = async (seat) => (await page.locator('#ops-pick-items').innerText()).split('\n').find((l) => l.startsWith(seat + ' ')) ?? '', observed = () => page.locator('#ops-pick-observed').innerText(), retry = page.locator('#ops-pick-retry'), manual = async () => { await page.locator('#ops-pick-refresh').click(); await page.waitForTimeout(500); };
  const collect = async (ids) => { await page.locator('#ops-select-none').click(); for (const id of ids) await box(id).check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); await page.locator('#ops-pick-kind-record').check(); await page.locator('#ops-pick-go').click(); await page.locator('#ops-pick-items').filter({ hasText: new RegExp('^' + [...ids].sort()[0] + ' ') }).waitFor(); return newest(); };

  // L1 — mixed batch, watched while it moves: queued · verified · bytes arriving · four kinds of failure · unknown
  let batch = await collect(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']); assert.match(await state(), /기기 수신 확인 전 8/, 'asked, no device receipt yet: ' + await state());
  assert.equal((await local.uploadSnapshotAs(conn.A2, batch, 1, record)).status, 201); target(batch, 'A2', 'succeeded', 'receipt_verified'); assert.equal(await putMeta(batch, conn.A3), 201); target(batch, 'A3', 'running');
  target(batch, 'A4', 'failed', 'upload_failed'); target(batch, 'A5', 'rejected', 'busy'); target(batch, 'A6', 'expired'); target(batch, 'A7', 'unsupported'); target(batch, 'A8', 'outcome_unknown');
  await page.locator('#ops-pick-state').filter({ hasText: /최종 거부 1 · 전달 안 됨 3 · 결과 미확인 1/ }).waitFor({ timeout: 15000 }).catch(async (e) => { throw Error('the page did not follow the ledger by itself: ' + await state(), { cause: e }); });
  assert.match(await state(), /대상 8명 · 서버 검증됨 1 · 기기 수신 확인 전 1 · 전송·검증 진행 중 1 · 재전송 대기 0 · 최종 거부 1 · 전달 안 됨 3 · 결과 미확인 1 · 유예 종료 0 · 제외 0/); assert.match(await observed(), /서버 시각 .* 관측 · 진행 중인 대상 2명 — 자동으로 다시 확인합니다/);
  for (const [seat, text] of [['A1', /현재: 서버 접수 · 기기 수신 확인 전 · 기기 요청: (서버 접수|서버가 기기에 배정함) · 기기 수신 확인 전/], ['A2', /현재: 서버 검증됨 · 기록 순번 연속.*기기 요청: 기기가 전송을 마쳤다고 보고함/], ['A3', /현재: 전송·검증 진행 중 · 일부 파일만 도착\(검증 전\) · 기기 요청: 기기가 보내는 중/], ['A4', /현재: 최종 거부 .* 기기 요청: 기기에서 실패 \(upload_failed\)/], ['A5', /현재: 기기에 전달되지 않음 · 기기 요청: 기기가 거절함 \(busy\)/], ['A6', /기기 요청: 시간 초과/], ['A7', /기기 요청: 이 앱 버전은 지원하지 않음/], ['A8', /현재: 결과 미확인 · 성공으로도 실패로도 세지 않습니다 · 기기 요청: 결과 확인 불가/]]) assert.match(await rowOf(seat), text, seat + ': ' + await rowOf(seat));
  assert.equal(await retry.isVisible(), true, 'failed targets can be re-selected while others are still in flight'); assert.match(await retry.innerText(), /도착하지 않은 5명만 다시 선택 \(진행 중 2명은 제외\)/); await page.screenshot({ path: path.join(out, 'failed-and-in-flight.png'), fullPage: true });
  await retry.click(); await page.locator('#ops-pick-note').filter({ hasText: /도착하지 않은 5명만 다시 선택했습니다/ }).waitFor(); assert.deepEqual(await checked(), ['A4', 'A5', 'A6', 'A7', 'A8'], 'not the queued, the sending or the verified seat'); assert.equal(await confirmOpen(), false, 're-selecting requests nothing by itself');
  ok('lifecycle: a mixed batch is followed as it moves; failures are re-selectable while others are in flight, and only they are');

  // L2 — ORDER. "meta arrived, THEN the device reported failure" is a failure from the first second; "failure, THEN a file arrived" is a
  //      transfer again. Real PUTs and real batch reads, no clock moved: only the ORDER of the PUT and the terminal report differs.
  batch = await collect(['A4', 'A5', 'A6']); for (const id of ['A4', 'A5', 'A6']) assert.equal(await putMeta(batch, conn[id]), 201); await page.waitForTimeout(10);
  target(batch, 'A4', 'failed', 'offline_pending'); target(batch, 'A5', 'failed', 'upload_refused'); target(batch, 'A6', 'failed', 'verify_failed'); await manual();
  assert.match(await state(), /전송·검증 진행 중 0 · 재전송 대기 1 · 최종 거부 2/, 'a file that arrived BEFORE the failure report is not "in progress" — immediately, not after 90 s: ' + await state());
  assert.match(await rowOf('A4'), /현재: 재전송 대기 · 기기가 사본을 보관 중.*일부 파일만 도착\(검증 전\) · 기기 요청: 기기에서 실패 \(offline_pending\)/); assert.match(await rowOf('A5'), /현재: 최종 거부 .*일부 파일만 도착\(검증 전\) · 기기 요청: 기기에서 실패 \(upload_refused\)/); assert.match(await rowOf('A6'), /기기 요청: 기기에서 실패 \(verify_failed\)/);
  assert.equal(await retry.isVisible(), true, 're-select is offered right after the failure'); assert.match(await retry.innerText(), /도착하지 않은 3명만 다시 선택$/); assert.match(await observed(), /확정 아님: 업로드 유예\(.*까지\) 동안 늦게 도착한 기록이 검증될 수 있습니다/);
  evidence.file_then_failure = { state: await state(), a4: await rowOf('A4'), a5: await rowOf('A5'), retry: await retry.innerText(), observed: await observed() };
  // failure → new file: A4's device really sends its next file AFTER the failure was reported. Progress comes back, and A4 leaves the retry set.
  await page.waitForTimeout(10); const nextFile = await local.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${batch}/1/p1.index.jsonl`, { method: 'PUT', headers: { authorization: 'Bearer ' + conn.A4.credential }, body: local.collectionFiles(conn.A4, batch, record).files.find((x) => x.name === 'p1.index.jsonl').data }), local.env, { waitUntil() {} }); assert.equal(nextFile.status, 201); await manual();
  assert.match(await state(), /전송·검증 진행 중 1 · 재전송 대기 0 · 최종 거부 2/, 'a file received after the request ended is a resumed transfer: ' + await state()); assert.match(await rowOf('A4'), /현재: 전송·검증 진행 중 · 일부 파일만 도착\(검증 전\) · 기기 요청: 기기에서 실패 \(offline_pending\)/);
  assert.match(await retry.innerText(), /도착하지 않은 2명만 다시 선택 \(진행 중 1명은 제외\)/); assert.match(await observed(), /진행 중인 대상 1명 — 자동으로 다시 확인합니다/); evidence.failure_then_file = { state: await state(), a4: await rowOf('A4'), retry: await retry.innerText() };
  // The resumed upload completes (identical re-sends + seal). Nobody presses anything: the active re-observation sees it.
  assert.equal((await local.uploadSnapshotAs(conn.A4, batch, 1, record)).status, 201); await page.locator('#ops-pick-state').filter({ hasText: /서버 검증됨 1 · .*전송·검증 진행 중 0 · 재전송 대기 0/ }).waitFor({ timeout: 20000 }).catch(async (e) => { throw Error('the resumed upload was not re-observed: ' + await state(), { cause: e }); });
  assert.match(await rowOf('A4'), /현재: 서버 검증됨 .*기기 요청: 기기에서 실패 \(offline_pending\)/, 'the past command result stays next to the present, verified, result'); assert.match(await retry.innerText(), /도착하지 않은 2명만/);
  // The grace of this batch closes: said as such, and "new request" is a separate fact that changes when the class ends.
  local.db.prepare('UPDATE classroom_collect_batches SET upload_until=? WHERE id=?').run(Date.now() - 1, batch); await manual();
  assert.match(await state(), /최종 거부 0 · .*유예 종료 2/); assert.match(await rowOf('A5'), /현재: 업로드 유예 종료 · 이 요청으로는 더 받을 수 없음 · 일부 파일만 도착/); assert.match(await observed(), /결과 확정 \(업로드 유예 종료\)/); assert.equal(await retry.isEnabled(), true); assert.match(await page.locator('#ops-pick-grace').innerText(), /새 회수 요청입니다\. 앞선 요청의 업로드 유예는 끝났습니다/);
  const endsAt = local.db.prepare('SELECT ends_at e FROM class_run_ops WHERE class_run_id=?').get(local.run).e; local.db.prepare('UPDATE class_run_ops SET ends_at=? WHERE class_run_id=?').run(Date.now() - 1, local.run); await manual();
  assert.equal(await retry.isDisabled(), true, 'no new request on an ended class'); assert.match(await page.locator('#ops-pick-grace').innerText(), /이 수업은 끝나 새 회수를 요청할 수 없습니다\. 업로드 유예도 끝났습니다/); evidence.grace_over = { state: await state(), grace: await page.locator('#ops-pick-grace').innerText(), observed: await observed() };
  await page.screenshot({ path: path.join(out, 'grace-over-class-ended.png'), fullPage: true }); local.db.prepare('UPDATE class_run_ops SET ends_at=? WHERE class_run_id=?').run(endsAt, local.run);
  ok('lifecycle: file→failure is a failure at once, failure→new file is a transfer again, the resumed upload is re-observed without a click, the closed grace, the ended class');

  // L3 — the reviewed defect: a failed / unknown target verifies LATE, the panel is stale, and the instructor goes to re-select.
  batch = await collect(['A6', 'A7']); target(batch, 'A6', 'failed', 'upload_failed'); assert.equal(await putMeta(batch, conn.A7), 201); await page.waitForTimeout(10); target(batch, 'A7', 'outcome_unknown'); await manual(); // meta first, THEN no receipt: unknown at once
  assert.match(await state(), /최종 거부 1 · 전달 안 됨 0 · 결과 미확인 1/); assert.match(await rowOf('A7'), /현재: 결과 미확인 .*일부 파일만 도착/); assert.doesNotMatch(await observed(), /결과 확정/, 'failed and unknown inside the grace are not final');
  for (const id of ['A6', 'A7']) assert.equal((await local.uploadSnapshotAs(conn[id], batch, 1, record)).status, 201); // both records arrive late, inside the grace
  // (a) the board's own "현황 새로 확인" re-reads the collection result too
  await page.locator('#ops-check').click(); await page.locator('#ops-pick-state').filter({ hasText: /서버 검증됨 2/ }).waitFor({ timeout: 8000 }).catch(async (e) => { throw Error('"현황 새로 확인" did not re-read the batch: ' + await state(), { cause: e }); });
  assert.equal(await retry.isHidden(), true); assert.match(await observed(), /결과 확정/); assert.match(await rowOf('A7'), /현재: 서버 검증됨 .*기기 요청: 결과 확인 불가/);
  // (b) the same race against the re-select button itself: the page still shows "failed", the Service already says verified
  batch = await collect(['A8', 'A3']); target(batch, 'A8', 'failed', 'upload_failed'); target(batch, 'A3', 'failed', 'upload_failed'); await manual(); assert.match(await retry.innerText(), /도착하지 않은 2명만/);
  assert.equal((await local.uploadSnapshotAs(conn.A8, batch, 1, record)).status, 201); // …A8 verifies after the page last looked
  const again = await local.configure([{ seat_id: 'A1', student_id: 'student-i' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-a' }, ...seats.slice(3)], 2); assert.equal(again.status, 200, again.raw); // …and A3 changes hands
  await retry.click(); await page.locator('#ops-pick-note').filter({ hasText: /다시 선택/ }).waitFor();
  assert.deepEqual(await checked(), [], 'the verified learner and the seat that changed hands are not re-selected: ' + await state()); assert.match(await note(), /다시 선택할 대상이 없습니다|좌석 주인이 바뀐 1명은 제외/); assert.match(await rowOf('A8'), /현재: 서버 검증됨/, 're-selecting re-read the batch first');
  assert.equal(await confirmOpen(), false); evidence.late_verified = { state: await state(), a8: await rowOf('A8'), checked: await checked() };
  ok('lifecycle: a late verified record is re-observed by the manual refresh, and re-selecting reads the batch and the board first');

  // L4 — a Service that does not send the status yet (an older deploy): nothing is guessed and nothing is offered for retry.
  await page.route('**/report-batches/*', async (route) => { if (route.request().method() !== 'GET') return route.continue(); const response = await route.fetch(), body = await response.json(); for (const i of body.items) delete i.status; delete body.observed_at; delete body.batch.upload_open; delete body.batch.new_request_allowed; await route.fulfill({ response, json: body }); });
  await manual(); assert.match(await state(), /구분 불가 2/); assert.match(await rowOf('A8'), /현재: 서버가 상태 구분을 보내지 않음 · 확인 불가/); assert.equal(await retry.isHidden(), true); await page.unroute('**/report-batches/*');
  ok('compatibility: without the Service status the page says "unclassified" and offers no retry');

  assert.equal(evaluatorCalls, 0, 'nothing in this file reached the evaluator'); assert.deepEqual(errors, [], 'no page error');
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ schema: 'hps-classroom-ops-selection/1', at: new Date().toISOString(), checks: n, evidence }, null, 2));
  console.log(`${n} selection / late-answer / failed-request checks passed → ${out}`);
} finally { setEvaluatorTransport(undefined); globalThis.fetch = realFetch; await browser?.close(); chalkServer.close(); local.close(); }
