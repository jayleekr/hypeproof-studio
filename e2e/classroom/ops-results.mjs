// Remote classroom operations (#751, AT-41 / RM-5) — the per-target results of commands, record collection and distribution in
// one Chalk /manage page, in a real browser, while several actions of different kinds are open at once.
//
// What is checked: every action keeps its own card keyed by (kind, server id) and its own observation; a new action never erases
// an earlier pending result or paints it onto another student; the common stages (접수 / 기기 수신 확인 전 / 기기 수신 / 적용 or
// 실패 / 미확인 / 미전달·만료·대상 변경) are derived per flow — a distribution `accepted` (Service record) is not a command
// `accepted` (device receipt), `leased`/`offered` are not receipt, a device's upload report is not server verification, server
// verification is not a whole lesson, execution is not resolution — and a failed read is shown as unknown, never as zero.
//
// Real here: the Chalk page and its script in Chromium (the instructor clicks), the Service router + SQLite, the device protocol
// for every command lease and receipt (/sync with receipts, recovery follow-up events), the App's own snapshot freezer for the
// collected record, and one seat's real inbox client (InboxSession/InboxStore on a real directory) for the distribution.
// Controlled here: WHEN a device syncs (called here rather than on a timer), which receipt it reports, one read held to fail
// (503 at the network layer), and the slow sync cadence of an old app (its last state time moved back). Synthetic accounts.
// Not evidence about a real Studio window (the Mac run), Windows, a school network, staging or production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { localOps, OPS_ALL } from '../../worker/test/harness/classroom-ops.mjs';
import * as ops from '../../extensions/hypeproof-chat/src/classroomOps.ts';
import { InboxSession, InboxStore, inboxDir } from '../../extensions/hypeproof-chat/src/classroomInboxStore.ts';
import { FOLLOWUP_CAPABILITY } from '../../worker/src/lib/classroom-recovery.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = process.env.HPS_AT41_OUT || path.join(repo, 'e2e/test-results/classroom-ops-results'); mkdirSync(out, { recursive: true });
const local = await localOps(), { default: chalk } = await import('../../chalk/src/index.ts'), { setRoster } = await import('../../worker/src/lib/kv.ts');
const realFetch = globalThis.fetch; globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? local.app.fetch(new Request(url, init), local.env, { waitUntil() {} }) : realFetch(url, init);
const chalkServer = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
chalkServer.listen(0, '127.0.0.1'); await once(chalkServer, 'listening');
let n = 0; const ok = (name) => { n++; console.log('PASS ' + name); }; let browser; const evidence = {}, shots = []; const root = mkdtempSync(path.join(tmpdir(), 'hps-at41-'));
try {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'], seats = ids.slice(0, 6).map((x, i) => ({ seat_id: 'A' + (i + 1), student_id: 'student-' + x }));
  await setRoster(local.env.HPS_KV, local.cohort, ids.map((x) => 'student-' + x)); await local.freeze();
  assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_distribute: true } })).status, 201);
  const X = await local.teacher('teacher-x', [...OPS_ALL, 'distribute']);
  // A1 A2: current app with follow-up reports · A3: current app with an inbox · A4: an OLD app (no diagnostics, no inbox) ·
  // A5: paired, consented, then offline · A6: never paired.
  const FULL = ['observe', 'commands', 'retry_diagnostics', 'refresh_connection', 'restart_preview', 'cancel_current_run', 'reset_runtime', 'retry_evidence_upload', 'send_question', 'mark_checkpoint', 'distribution_inbox', FOLLOWUP_CAPABILITY], OLD = ['observe', 'commands'];
  const caps = { A1: FULL, A2: FULL, A3: FULL, A4: OLD, A5: FULL }, conn = {}, no = { A1: 1, A2: 2, A3: 3, A4: 4, A5: 5 };
  for (const s of seats.slice(0, 5)) conn[s.seat_id] = (await local.pair(s.seat_id, 1, no[s.seat_id], caps[s.seat_id])).conn.json;
  const consent = (c) => local.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential);
  for (const id of ['A1', 'A2', 'A3', 'A5']) assert.equal((await consent(conn[id])).status, 201); // A4 never consents
  const sync = (seat, extra = {}, events = []) => local.sync(conn[seat].credential, events, no[seat], { capabilities: caps[seat], ...extra });
  for (const id of ['A1', 'A2', 'A3', 'A4']) assert.equal((await sync(id, {}, [local.event(1, 'activation', { stage: 'token_verified' })])).status, 200);
  await local.request(local.base + '/grants/' + conn.A5.grant_id, 'DELETE');
  // The device side of one command on one seat: lease (a sync that returns it), then receipts — the real protocol, called on cue.
  const seq = { A1: 1, A2: 1, A3: 1, A4: 1 }, leased = {};
  const lease = async (seat, commandId) => { const r = await sync(seat); const got = (r.json.commands || []).find((x) => x.command_id === commandId); assert.ok(got, seat + ' was not handed ' + commandId + ': ' + r.raw); leased[seat + commandId] = got; return got; };
  const report = async (seat, commandId, state, code = '', events = []) => { const r = await sync(seat, { receipts: [local.receipt(leased[seat + commandId], state, code)] }, events.map((e) => local.event(++seq[seat], 'recovery', { command_id: commandId, ...e }))); assert.equal(r.status, 200, r.raw); return r.json; };
  const commandsNow = () => local.db.prepare('SELECT id,action FROM ops_commands ORDER BY created_at,rowid').all();

  browser = await chromium.launch(); const origin = 'http://127.0.0.1:' + chalkServer.address().port, page = await browser.newPage({ viewport: { width: 1440, height: 1200 } }); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const connect = async () => { await page.goto(origin + '/manage'); await page.locator('#token').fill(X); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill('student-'); await page.locator('#connect button').first().click(); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await page.locator('#ops-check').click(); await page.locator('#ops-seats .ops-seat[data-seat="A6"]').waitFor(); };
  const box = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`).getByLabel('선택'), none = () => page.locator('#ops-select-none').click();
  const pick = async (list) => { await none(); for (const id of list) await box(id).check(); };
  const checked = async () => { const v = []; for (const s of seats) if (await box(s.seat_id).isChecked()) v.push(s.seat_id); return v; };
  const card = (key) => page.locator(`#ops-ledger-list .ledger-card[data-key="${key}"]`), keys = () => page.locator('#ops-ledger-list .ledger-card').evaluateAll((l) => l.map((x) => x.dataset.key));
  const sum = (key) => card(key).locator('.ledger-sum').innerText(), extra = (key) => card(key).locator('.ledger-extra').innerText(), seen = (key) => card(key).locator('.ledger-seen').innerText();
  // textContent: a settled earlier card folds its student list, and its lines are still what it says when opened.
  const line = async (key, seat) => (await card(key).locator('.ledger-items > p').allTextContents()).find((l) => l.startsWith(seat + ' ')) ?? '', lines = (key) => card(key).locator('.ledger-items > p').allTextContents();
  const until = async (what, f, ms = 20000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await f(); if (last) return last; await page.waitForTimeout(250); } throw Error('timed out waiting for ' + what + '\n' + await page.locator('#ops-ledger').innerText().catch(() => '')); };
  const more = async (key) => { await card(key).locator('.ledger-more').click(); await page.waitForTimeout(400); };
  const shot = async (name, note) => { const file = path.join(out, name + '.png'); await page.screenshot({ path: file, fullPage: true }); shots.push({ file: path.relative(repo, file), note }); };

  await connect(); assert.equal(await page.locator('#ops-ledger').isVisible(), false, 'no action, no result card'); ok('control: before any action there is no result card');

  // ── C1: whole class (전체 선택) → 진단. Offline, never-paired and old-app seats are named at once; delivery is not receipt. ──
  await page.locator('#ops-pick-by > summary').click(); await page.locator('#ops-select-all').click(); /* G1: under ‘다른 조건으로 선택’ */ await page.locator('#ops-bulk-diagnose').click(); await page.locator('#ops-ledger').waitFor();
  const C1 = 'command:' + commandsNow().at(-1).id; await card(C1).waitFor();
  assert.match(await sum(C1), /^적용 \(기기가 실행함\) 0 · 실패 1 · 미확인 0 · 미전달·만료·대상 변경 2 · 접수 3$/, await sum(C1));
  assert.match(await line(C1, 'A4'), /^A4 · student-d — \[실패\] 이 앱 버전은 지원하지 않음/); assert.match(await line(C1, 'A5'), /^A5 · student-e — \[미전달·만료·대상 변경\] 기기 연결 없음/); assert.match(await line(C1, 'A6'), /^A6 · student-f — \[미전달·만료·대상 변경\]/);
  const c1id = C1.slice(8); await lease('A1', c1id); await lease('A2', c1id); await report('A2', c1id, 'accepted');
  await until('A1 leased, A2 received', async () => /\[기기 수신 확인 전\] 서버가 기기에 배정함/.test(await line(C1, 'A1')) && /\[기기 수신\] 기기가 확인함/.test(await line(C1, 'A2')));
  assert.doesNotMatch(await line(C1, 'A1'), /\[기기 수신\]/, 'leased is the Service assigning it, not the device receiving it'); assert.match(await seen(C1), /진행 중 — 자동으로 다시 확인합니다/);
  evidence.c1_in_flight = { sum: await sum(C1), lines: await lines(C1) };
  ok('C1 whole class: old app = 실패(unsupported), offline and never-paired = 미전달, leased = 수신 확인 전, a device receipt = 기기 수신');

  // ── C2 while C1 is still open: another action must not erase C1 or paint onto its students ──
  await pick(['A3']); await page.locator('#ops-bulk-diagnose').click(); await until('second card', async () => (await keys()).length === 2);
  const C2 = 'command:' + commandsNow().at(-1).id; assert.deepEqual(await keys(), [C2, C1], 'newest first, the earlier card is still there');
  assert.match(await line(C1, 'A1'), /\[기기 수신 확인 전\]/); assert.match(await line(C1, 'A2'), /\[기기 수신\]/); assert.equal((await lines(C2)).length, 1, 'C2 names only its own target'); assert.match(await line(C2, 'A3'), /^A3 · student-c — \[접수\]/);
  assert.match(await page.locator('#ops-bulk-result').innerText(), /대상 1 /, 'the line under the button now belongs to C2'); assert.doesNotMatch(await page.locator('#ops-bulk-result').innerText(), /A1:|A2:/);
  // C1 settles AFTER C2 started: its own card follows it; the status line of C2 is not overwritten.
  // A3 (also in C1 — the whole class was selected) starts and never says how it ended: 미확인, not success and not failure.
  await report('A1', c1id, 'accepted'); await report('A1', c1id, 'succeeded', 'token_ok'); await report('A2', c1id, 'succeeded', 'service_unreachable'); await lease('A3', c1id); await report('A3', c1id, 'accepted'); await report('A3', c1id, 'outcome_unknown');
  await until('C1 settled', async () => /미확인 1 · 미전달/.test(await sum(C1)) && /결과 미확인 1/.test(await extra(C1)));
  assert.match(await seen(C1), /확정 아님: 해결 여부는 학생의 다음 실행·관측 뒤 바뀔 수 있습니다/, 'every device has answered, yet a 미확인 is not called final');
  assert.match(await sum(C1), /^적용 \(기기가 실행함\) 2 · 실패 1 · 미확인 1 · 미전달·만료·대상 변경 2$/); assert.doesNotMatch(await sum(C1), /모두/);
  assert.match(await extra(C1), /해결 여부 \(기기 실행과 별개\): 해결 확인 1 · 문제 남음 1 · 실행됨·해결 확인 전 0 · 결과 미확인 1 · 실행 안 됨 3/, 'two devices executed, one cause is gone');
  assert.match(await line(C1, 'A3'), /^A3 · student-c — \[미확인\] 결과 확인 불가 · 현장 확인 필요 → 결과 미확인/);
  await until('C2 independently reflects A3 lease', async () => /^A3 · student-c — \[기기 수신 확인 전\]/.test(await line(C2, 'A3')));
  assert.match(await line(C2, 'A3'), /^A3 · student-c — \[기기 수신 확인 전\]/, 'the same sync also assigned C2 to A3 (the Service\'s fact); C1\'s unknown on A3 did not spill into C2');
  assert.match(await line(C1, 'A2'), /\[적용 \(기기가 실행함\)\] 성공 — .* → 문제 남음 — 원인: 학생 PC에서 서버에 닿지 않음/); assert.doesNotMatch(await page.locator('#ops-bulk-result').innerText(), /A1:|A2:/, 'C1 did not write into C2\'s line');
  await shot('two-commands', 'C1 settled (executed ≠ resolved) while C2 is still 접수; newest first'); evidence.two_commands = { c1: await lines(C1), c2: await lines(C2), bulk_line: await page.locator('#ops-bulk-result').innerText() };
  ok('two successive commands: the earlier one keeps its card, settles later in its own card, and never writes into the newer one');

  // ── C3 from A1's detail (reset_runtime): the detail of ANOTHER student never shows it; execution first, resolution later ──
  const openDetail = async (seat) => { await page.locator(`#ops-seats .ops-seat[data-seat="${seat}"]`).getByRole('button', { name: '근거·조치' }).click(); await page.locator('#ops-detail-title').filter({ hasText: seat + ' · ' }).waitFor(); };
  await openDetail('A1'); await page.locator('#ops-actions button[data-act="reset_runtime"]').first().click(); await page.locator('#ops-actions .confirm button[data-act="reset_runtime"]').click();
  await until('C3 card', async () => (await keys()).length === 3); const C3 = 'command:' + commandsNow().at(-1).id, c3id = C3.slice(8);
  assert.match(await page.locator('#ops-detail-status').innerText(), /A1:/);
  await openDetail('A2'); assert.equal(await page.locator('#ops-detail-status').innerText(), '', 'A2\'s detail starts empty — not A1\'s command'); await lease('A1', c3id); await report('A1', c3id, 'accepted'); await report('A1', c3id, 'succeeded', 'reset_ok');
  await until('C3 executed', async () => /실행됨·해결 확인 전 1/.test(await extra(C3)));
  assert.equal(await page.locator('#ops-detail-status').innerText(), '', 'A1\'s progress was not painted under A2'); assert.match(await line(C3, 'A1'), /\[적용 \(기기가 실행함\)\] .* → 명령 실행 완료 · 해결 여부는 아직 확인 전/);
  assert.match(await seen(C3), /확정 아님: 해결 여부는 학생의 다음 실행·관측 뒤 바뀔 수 있습니다/, 'execution done is not "final" for the resolution'); evidence.c3_executed = { line: await line(C3, 'A1'), seen: await seen(C3) };
  // The learner's next question completes — linked to C3 by its id. The card picks it up by itself (no click).
  await sync('A1', {}, [local.event(++seq.A1, 'recovery', { command_id: c3id, check: 'turn_completed' })]);
  await until('C3 resolved without a click', async () => /해결 확인 1/.test(await extra(C3)), 30000); assert.match(await line(C3, 'A1'), /문제 해결 확인 .* 조치 뒤 학생의 다음 AI 실행이 끝까지 완료됨/); evidence.c3_resolved = { line: await line(C3, 'A1'), seen: await seen(C3) };
  await page.locator('#ops-close').click();
  ok('a command from one student\'s detail never appears under another; "executed" becomes "resolved" later, on its card, without a click');

  // ── K1: selected collection. Upload report ≠ server verified; server verified ≠ the whole lesson. ──
  const line2 = (o) => JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), ...o }), record = [line2({ seq: 1, type: 'prompt', turn_id: 't1', text: 'synthetic' }), line2({ seq: 2, type: 'turn_end', turn_id: 't1', status: 'ok' })].join('\n') + '\n';
  const batches = () => local.db.prepare("SELECT b.id FROM classroom_collect_batches b JOIN classroom_collect_scopes s ON s.batch_id=b.id WHERE b.dry_run=0 ORDER BY b.created_at,b.rowid").all().map((r) => r.id);
  const collect = async (list) => { await pick(list); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); await page.locator('#ops-pick-kind-record').check(); await page.locator('#ops-pick-go').click(); await page.locator('#ops-last-what').filter({ hasText: '요청 접수' }).waitFor(); return batches().at(-1); };
  const k1 = await collect(['A1', 'A2', 'A4', 'A5']), K1 = 'collect:' + k1; await card(K1).waitFor();
  assert.deepEqual((await lines(K1)).map((l) => l.split(' — ')[0]), ['A1 · student-a', 'A2 · student-b', 'A4 · student-d', 'A5 · student-e'], 'only the selected; A3 and A6 are not recipients');
  assert.match(await line(K1, 'A4'), /\[미전달·만료·대상 변경\] 제외 · 동의 없음 · 회수하지 않음/); assert.match(await line(K1, 'A5'), /\[미전달·만료·대상 변경\] 기기에 전달되지 않음 · 기기 연결 없음/);
  const upCmd = local.db.prepare("SELECT id FROM ops_commands WHERE idempotency_key=?").get('collect-' + k1).id; await lease('A1', upCmd);
  await until('A1 leased', async () => /^A1 · student-a — \[기기 수신 확인 전\]/.test(await line(K1, 'A1')));
  await report('A1', upCmd, 'accepted'); await report('A1', upCmd, 'succeeded', 'receipt_verified'); // the device SAYS it sent — nothing was sealed
  assert.equal((await local.uploadSnapshotAs(conn.A2, k1, 1, record, { spool: { other_sessions: 1 } })).status, 201); // A2: a valid record; the App could not read one earlier session of this class (U1b: said, never guessed)
  await until('K1 moved', async () => /\[적용 \(서버 검증\)\]/.test(await line(K1, 'A2')) && /\[기기 수신\]/.test(await line(K1, 'A1')));
  assert.match(await line(K1, 'A1'), /\[기기 수신\] 전송·검증 진행 중 · 기기 요청: 기기가 전송을 마쳤다고 보고함/, 'the device reporting "sent" is not verified');
  const a2 = await line(K1, 'A2'); assert.match(a2, /\[적용 \(서버 검증\)\] 서버 검증됨 · 기록의 시작·끝 또는 다른 세션 포함 여부 확인 불가 — 같은 수업 시간의 세션 일부를 읽지 못했거나 한도를 넘어 포함하지 않음 · 세션 1개: 1\) [^·–]+–[^·]+ 현재 세션 · 시작 확인 · 끝 확인 · 받음: 프롬프트 1 · 작업 기록 1 · .* · 수업 전체의 기록이 아님 — 앱을 다시 시작한 뒤 새 회수로 다시 요청할 수 있습니다/, a2);
  assert.match(await extra(K1), /서버 검증 1명 중 기록 범위: 시작·끝·순번 확인 0 · 범위 제한·확인 불가 1 — 서버 검증은 받은 파일이 온전하다는 뜻이고 수업 전체를 담았다는 뜻이 아닙니다/);
  assert.equal(local.db.prepare("SELECT reason FROM classroom_collect_items WHERE batch_id=? AND seat_id='A2'").get(k1).reason, 'session_not_included', 'the reason is persisted, not recomputed in the page');
  assert.match(await page.locator('#ops-pick-items').innerText(), /세션 일부를 읽지 못했거나/, 'the detail panel says the same');
  evidence.k1 = { lines: await lines(K1), extra: await extra(K1) };
  ok('selected collection: nonselected absent, consent/offline named, leased ≠ receipt, a device\'s "sent" ≠ verified, verified shows its real extent and why it is not the whole lesson');

  // ── K2 right after: the pick panel moves to K2, K1 keeps its card and keeps being observed on its own ──
  const k2 = await collect(['A3']), K2 = 'collect:' + k2; await card(K2).waitFor(); assert.deepEqual((await keys()).slice(0, 2), [K2, K1]);
  assert.match(await page.locator('#ops-pick-items').innerText(), /^A3 · student-c/, 'the detail panel now shows K2'); assert.match(await line(K1, 'A2'), /\[적용 \(서버 검증\)\]/, 'K1 was not erased');
  assert.equal((await local.uploadSnapshotAs(conn.A1, k1, 1, record)).status, 201); // A1's record for K1 arrives late, after K2 was started
  await until('K1 follows by itself', async () => /\[적용 \(서버 검증\)\] 서버 검증됨 · 기록 순번 연속/.test(await line(K1, 'A1')), 30000);
  assert.doesNotMatch(await line(K2, 'A3'), /서버 검증/, 'A1\'s late record was not painted into K2'); assert.match(await line(K1, 'A1'), /기기 요청: 기기가 전송을 마쳤다고 보고함/, 'the historical command result stays beside the present verification');
  // a double confirmation is one request and one card
  await pick(['A3']); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); await page.locator('#ops-pick-kind-record').check(); await page.evaluate(() => { const b = document.getElementById('ops-pick-go'); b.click(); b.disabled = false; b.click(); }); await page.waitForTimeout(1200);
  const k3 = batches().at(-1); assert.equal(batches().length, 3, 'two clicks, one batch'); assert.equal((await keys()).filter((k) => k === 'collect:' + k3).length, 1, 'and one card');
  await shot('collections', 'K1 (upload report vs verified, current-session extent) kept and re-observed after K2/K3'); ok('a second collection does not erase the first; the first is re-observed on its own; a double confirmation is one card');

  // ── D1: distribution. `accepted` here is the SERVICE's record; `offered` is not receipt; an old app's refusal arrives on its slow cadence ──
  const store3 = new InboxStore(inboxDir(root, { cohort: conn.A3.student.c, run: conn.A3.class_run_id, seat: 'A3', student: conn.A3.student.u }));
  const inbox3 = new InboxSession({ store: store3, alive: () => true, clock: { mono: () => performance.now(), wall: () => Date.now() } });
  const memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; }; let eid = 0;
  const outbox3 = await ops.OpsOutbox.open(memory(), conn.A3.grant_id, 'stream-A3', () => Date.now(), () => `event-at41-${String(++eid).padStart(6, '0')}`);
  // A3's own pending commands (C2 diagnose, K2/K3 upload) are settled first so its real client only has the distribution to handle.
  for (const id of local.db.prepare("SELECT t.command_id id FROM ops_command_targets t WHERE t.seat_id='A3' AND t.state IN ('queued','leased')").all().map((r) => r.id)) { await lease('A3', id); await report('A3', id, 'rejected', 'busy'); }
  const loop3 = ops.startOpsSync({ outbox: outbox3, appInstanceId: local.instance(3).app_instance_id, capabilities: FULL, distribution: inbox3, sample: () => ({ idle_ms: 1 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {}, post: async (body) => { const r = await local.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: local.instance(3).boot_id }, conn.A3.credential); return { status: r.status, body: r.json }; } });
  const compose = async () => { if (!(await page.locator('#ops-dist').evaluate((d) => d.open))) await page.locator('#ops-dist-summary').click(); await page.locator('#ops-dist-title').waitFor(); };
  await compose(); await page.locator('#ops-dist-title').fill('다음 시간 준비물'); await page.locator('#ops-dist-body').fill('노트북 충전기를 가져오세요.'); await page.locator('#ops-dist-save').click(); await page.locator('#ops-dist-saved').filter({ hasText: '저장했습니다' }).waitFor();
  await pick(['A1', 'A3', 'A4', 'A5']); await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor(); await page.locator('#ops-dist-go').click(); await page.locator('#ops-dist-items').filter({ hasText: 'A1 · student-a' }).waitFor();
  const d1 = local.db.prepare('SELECT id FROM classroom_distributions ORDER BY created_at DESC,rowid DESC LIMIT 1').get().id, D1 = 'distribution:' + d1; await card(D1).waitFor();
  assert.match(await sum(D1), /^적용 \(보관함 반영\) 0 · 미확인 0 · 접수 4$/, 'the Service recorded four targets — nothing was sent to a device yet'); assert.doesNotMatch(await lines(D1).then((l) => l.join('\n')), /\[기기 수신\]/, 'a distribution `accepted` is not a device receipt');
  local.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); await sync('A1'); // the Service offers A1 in its answer; this "device" never reports back
  local.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); await loop3.tick(); await loop3.tick(); // A3's real inbox client receives and reflects
  await sync('A4'); await more(D1); assert.match(await line(D1, 'A4'), /^A4 · student-d — \[접수\] 전달: 접수 — 아직 보내지 않음/, 'an old app is still 접수 before its slow sync cadence — true, not "sent"');
  local.db.prepare("UPDATE ops_latest_state SET last_received_at=0 WHERE seat_id='A4'").run(); await sync('A4'); // the old app's next slow-cadence sync
  await until('D1 moved', async () => /\[실패\]/.test(await line(D1, 'A4')) && /\[적용 \(보관함 반영\)\]/.test(await line(D1, 'A3')));
  assert.match(await line(D1, 'A1'), /^A1 · student-a — \[기기 수신 확인 전\] 전달: 수신 확인 전 — 서버가 응답에 실었음\(기기가 받았다는 증거 아님\)/); assert.match(await line(D1, 'A3'), /\[적용 \(보관함 반영\)\] 전달: 보관함 반영 · 지금 보관함: 지금 보관함에 있음/);
  assert.match(await line(D1, 'A4'), /\[실패\] 전달: 이 앱은 보관함을 지원하지 않음/); assert.match(await line(D1, 'A5'), /\[접수\] 전달: 접수 — 기기 연결 없음/); assert.match(await extra(D1), /읽음·이해를 뜻하지 않습니다/);
  assert.match(await sum(D1), /^적용 \(보관함 반영\) 1 · 실패 1 · 미확인 0 · 기기 수신 확인 전 1 · 접수 1$/); assert.equal((await store3.read()).cards.length, 1);
  evidence.d1 = { sum: await sum(D1), lines: await lines(D1) }; await shot('mixed-actions', 'commands, collections and a distribution side by side; each card its own stages and evidence');
  ok('distribution: `accepted` = Service record (접수), `offered` = 수신 확인 전, a real inbox = 보관함 반영, an old app refuses on its slow cadence');

  // ── D1 withdrawn: the delivery history stays, the current card state is said apart, and it is not called "기록 회수" ──
  await page.locator('#ops-dist-revoke').click(); await page.locator('#ops-dist-revoke-go').click(); await page.locator('#ops-dist-now').filter({ hasText: '회수했습니다' }).waitFor();
  await until('D1 withdrawn in its card', async () => /이 배포는 거뒀습니다\(보관함에서 내리기 — 기록 회수와 다름\)/.test(await extra(D1)));
  assert.match(await line(D1, 'A3'), /\[적용 \(보관함 반영\)\] 전달: 보관함 반영 · 지금 보관함: 회수 요청 — 기기 확인 전/, 'history (reflected) and the present (withdrawal pending) side by side');
  local.db.prepare('UPDATE classroom_distribution_cards SET next_withdraw_at=0').run(); await loop3.tick(); await loop3.tick(); await more(D1);
  assert.match(await line(D1, 'A3'), /지금 보관함: 기기 보관함에서 회수됨/); assert.match(await extra(D1), /내려감 확인 1/); assert.equal((await store3.read()).cards.filter((c) => !c.withdrawn).length, 0);
  ok('withdrawing a distribution keeps its delivery history and says the current card state apart, in words distinct from record collection');

  // ── a failed read is unknown, never zero; the card says what it last saw and when ──
  const before1 = await sum(C1); await page.route('**/commands/' + c1id, (route) => route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { reason: 'storage' } }) : route.continue());
  await more(C1); assert.match(await card(C1).locator('.ledger-err').innerText(), /새로 읽지 못함 \(storage\) — 위 내용은 .* 관측 그대로이며 그 뒤의 변화는 모릅니다\. 실패 0·전원 성공으로 읽지 마세요/); assert.equal(await sum(C1), before1, 'the last observation stays, it is not zeroed');
  evidence.read_failure = { err: await card(C1).locator('.ledger-err').innerText(), sum: await sum(C1) }; await shot('read-failure', 'a failed re-read keeps the last observation and says it is stale');
  await page.unroute('**/commands/' + c1id); await more(C1); assert.equal(await card(C1).locator('.ledger-err').isVisible(), false);
  ok('a failed re-read is shown as stale/unknown with its time — never as zero failures or all success');

  // ── failure-only re-selection reads first, sends nothing, and drops a seat that changed hands ──
  const sent = commandsNow().length; await card(C1).locator('.ledger-again').click(); await card(C1).locator('.ledger-note').filter({ hasText: '다시 선택' }).waitFor();
  assert.deepEqual(await checked(), ['A3', 'A4', 'A5', 'A6'], 'unknown + failed + not delivered, from the latest record — not the two that executed'); assert.equal(commandsNow().length, sent, 're-selecting sent nothing');
  const moved = await local.configure([...seats.slice(0, 4), { seat_id: 'A5', student_id: 'student-g' }, seats[5]], 1); assert.equal(moved.status, 200, moved.raw);
  await page.locator('#ops-check').click(); await page.waitForTimeout(600); await card(C1).locator('.ledger-again').click(); await card(C1).locator('.ledger-note').filter({ hasText: '좌석 주인이 바뀐 1명은 제외' }).waitFor();
  assert.deepEqual(await checked(), ['A3', 'A4', 'A6']); assert.match(await line(C1, 'A5'), /^A5 · student-e — .* · 지금 이 좌석은 명단이 바뀌었습니다 \(이 결과는 왼쪽 학생의 것\)/, 'the result stays with the learner it was sent to');
  assert.equal(commandsNow().length, sent); evidence.reselect = { note: await card(C1).locator('.ledger-note').innerText(), a5: await line(C1, 'A5') };
  ok('failure-only re-selection: reads the record and the board first, ticks only failed/undelivered seats of the same learner, sends nothing');

  // ── nonselected learners never became recipients anywhere ──
  assert.equal(local.db.prepare("SELECT count(*) n FROM classroom_distribution_targets WHERE seat_id IN ('A2','A6')").get().n, 0); assert.equal(local.db.prepare("SELECT count(*) n FROM ops_command_targets t JOIN ops_commands c ON c.id=t.command_id WHERE c.action='retry_evidence_upload' AND t.seat_id IN ('A4','A5','A6')").get().n, 0);
  for (const k of await keys()) if (k.startsWith('distribution:')) assert.doesNotMatch((await lines(k)).join('\n'), /^A2 |^A6 /m);
  ok('negative: no unselected, unconsented or unreachable learner was asked or sent anything');

  // ── another connection starts empty: nothing from before is shown against it ──
  await page.locator('#disconnect').click(); await connect(); assert.equal(await page.locator('#ops-ledger').isVisible(), false); assert.equal(await page.locator('#ops-ledger-list .ledger-card').count(), 0);
  ok('reconnecting starts without result cards (the server records stay; nothing is repainted onto a new roster)');


  // ── W: the whole-roster finish path, clicked. A dry run asks nothing and makes no card; the live one names every roster seat with
  // its exclusion; a record that arrives late lands in THAT card, not in a selected collection started in the same connection. ──
  const k4 = await collect(['A2']), K4 = 'collect:' + k4; await card(K4).waitFor();
  const cmdsBefore = commandsNow().length, liveBefore = batches().length, dryBefore = local.db.prepare('SELECT count(*) n FROM classroom_collect_batches WHERE dry_run=1').get().n;
  assert.equal(await page.locator('#ops-finish-dry').isChecked(), true, 'the finish starts as a dry run'); await page.locator('#ops-finish-go').click();
  await page.locator('#ops-finish-state').filter({ hasText: '미리 확인 결과 (요청·저장 없음)' }).waitFor();
  assert.equal(commandsNow().length, cmdsBefore, 'dry run: no device request'); assert.equal(batches().length, liveBefore, 'dry run: no live batch');
  assert.equal(local.db.prepare('SELECT count(*) n FROM classroom_collect_batches WHERE dry_run=1').get().n, dryBefore + 1, 'the dry run is the Service\'s own preview row');
  assert.deepEqual(await keys(), [K4], 'dry run: no result card'); const dryLines = await page.locator('#ops-finish-items > p').allTextContents(); assert.equal(dryLines.length, 6, 'the preview names the whole roster');
  await page.locator('#ops-finish-dry').uncheck(); await page.locator('#ops-finish-go').click(); await until('whole-roster card', async () => batches().length === liveBefore + 1 && (await keys()).length === 2);
  const kw = batches().at(-1), KW = 'collect:' + kw; assert.deepEqual(await keys(), [KW, K4]);
  assert.match(await card(KW).locator('h4').innerText(), /^기록 회수 \(수업 마무리 · 명단 전체\) — 결과 확정 \d+ · 미확인 \d+ · 진행 중 \d+ \/ 6명 · 다음: /, 'G1: the first line is the action, final / unknown / still moving, and the next step'); assert.match(await card(KW).locator('.ledger-meta').innerText(), /^회수 .* · 명단 전체 6명 · 보낼 때의 대상 기준/);
  const wl = await lines(KW); assert.deepEqual(wl.map((l) => l.split(' — ')[0]), ['A1 · student-a', 'A2 · student-b', 'A3 · student-c', 'A4 · student-d', 'A5 · student-g', 'A6 · student-f'], 'every roster seat, the current holder of A5');
  assert.match(await line(KW, 'A4'), /\[미전달·만료·대상 변경\] 제외 · 동의 없음 · 회수하지 않음/); assert.match(await line(KW, 'A5'), /\[미전달·만료·대상 변경\] .*(동의 없음|기기 연결 없음)/); assert.match(await line(KW, 'A6'), /\[미전달·만료·대상 변경\] .*(동의 없음|기기 연결 없음)/);
  for (const id of ['A1', 'A2', 'A3']) assert.doesNotMatch(await line(KW, id), /\[적용|\[미전달/, id + ' was asked, nothing arrived yet');
  const finishRows = await page.locator('#ops-finish-items > p').allTextContents(); assert.equal(finishRows.length, 6); assert.match(await page.locator('#ops-finish-state').innerText(), /^명단 6명 · 서버 검증됨 0 /);
  evidence.whole_roster = { dry_run_rows: dryLines, card_lines: wl, finish_state: await page.locator('#ops-finish-state').innerText() };
  assert.equal((await local.uploadSnapshotAs(conn.A1, kw, 1, record)).status, 201); // A1's record for the finish arrives late, nothing clicked
  await until('late record in the whole-roster card', async () => /\[적용 \(서버 검증\)\] 서버 검증됨/.test(await line(KW, 'A1')), 30000);
  assert.deepEqual((await lines(K4)).map((l) => l.split(' — ')[0]), ['A2 · student-b'], 'the selected collection still names only A2'); assert.doesNotMatch(await line(K4, 'A2'), /서버 검증/, 'and nothing of A1 was painted into it');
  assert.match(await sum(KW), /적용 \(서버 검증\) 1 /); assert.doesNotMatch(await sum(KW), /모두|전원/);
  evidence.whole_roster.late = { a1: await line(KW, 'A1'), sum: await sum(KW), k4: await lines(K4) }; await shot('whole-roster', 'finish (whole roster): dry run made no card; live card names all six with exclusions; late A1 record in this card only');
  ok('whole-roster finish, clicked: the dry run requests and shows nothing as a card; the live card names every roster seat with its exclusion; a late verified record lands in that card only');

  // ── H: a hidden tab pauses the card's polling and says so; the observation keeps its time; coming back reads it at once. A manual
  // re-read racing an older automatic one keeps the newer answer and the card goes on watching the action still in flight. ──
  const hidden = (v) => page.evaluate((v) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => v }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v ? 'hidden' : 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }, v);
  // A1's queue is drained first (the whole-roster upload request), so its next lease is this diagnosis.
  for (const id of local.db.prepare("SELECT t.command_id id FROM ops_command_targets t WHERE t.seat_id='A1' AND t.state IN ('queued','leased')").all().map((r) => r.id)) { await lease('A1', id); await report('A1', id, 'rejected', 'busy'); }
  await pick(['A1']); await page.locator('#ops-bulk-diagnose').click(); await until('H card', async () => (await keys()).length === 3); const H = 'command:' + commandsNow().at(-1).id, hid = H.slice(8);
  assert.match(await seen(H), /진행 중 — 자동으로 다시 확인합니다/); const gets = []; page.on('request', (r) => { if (r.method() === 'GET' && r.url().endsWith('/commands/' + hid)) gets.push(Date.now()); });
  await hidden(true); await until('paused', async () => /이 화면이 가려진 동안 자동 확인을 멈췄습니다/.test(await seen(H)), 10000); const pausedAt = Date.now(), seenPaused = await seen(H);
  await lease('A1', hid); await report('A1', hid, 'accepted'); await report('A1', hid, 'succeeded', 'token_ok'); await page.waitForTimeout(5000);
  assert.equal(gets.filter((t) => t > pausedAt).length, 0, 'no read while hidden'); assert.match(await line(H, 'A1'), /^A1 · student-a — \[접수\]/, 'the paused card still shows what it last saw, not a guess');
  assert.equal(await seen(H), seenPaused, 'and says it is paused with the time of that observation'); assert.match(seenPaused, /^서버 시각 .* 관측 · /);
  evidence.hidden = { paused: seenPaused, line_while_hidden: await line(H, 'A1') }; await hidden(false);
  await until('read on return', async () => /\[적용 \(기기가 실행함\)\]/.test(await line(H, 'A1')), 3000); assert.ok(gets.some((t) => t > pausedAt), 'returning read it'); assert.doesNotMatch(await seen(H), /가려진/);
  evidence.hidden.after_return = { line: await line(H, 'A1'), seen: await seen(H) };
  ok('hidden tab: the card stops reading and says so with its last observation time; the device settled meanwhile; coming back reads it at once');
  // Manual re-read vs an older automatic read still in flight.
  await pick(['A1']); await page.locator('#ops-bulk-diagnose').click(); await until('M card', async () => (await keys()).length === 4); const M = 'command:' + commandsNow().at(-1).id, mid = M.slice(8);
  let release, held = new Promise((r) => { release = r; }), stale = null;
  await page.route('**/commands/' + mid, async (route) => { if (route.request().method() !== 'GET' || stale) return route.continue(); const resp = await route.fetch(); stale = resp; await held; await route.fulfill({ response: resp }); });
  await until('an automatic read is held', async () => !!stale, 10000);
  await lease('A1', mid); await report('A1', mid, 'accepted'); await more(M); // later reads pass through; only the first one is held
  assert.match(await line(M, 'A1'), /^A1 · student-a — \[기기 수신\]/, 'the manual read shows the newer state'); release(); await page.waitForTimeout(600); await page.unroute('**/commands/' + mid);
  assert.match(await line(M, 'A1'), /\[기기 수신\]/, 'the older automatic answer arriving later did not roll it back'); assert.match(await seen(M), /진행 중 — 자동으로 다시 확인합니다/, 'still watching the action in flight');
  await report('A1', mid, 'succeeded', 'token_ok'); await until('M settles by itself', async () => /\[적용 \(기기가 실행함\)\]/.test(await line(M, 'A1')), 10000);
  evidence.manual_race = { final: await line(M, 'A1'), seen: await seen(M) };
  ok('manual re-read racing an older automatic read: the newer answer stays, the in-flight action keeps being watched and settles on its own');

  // ── R: more than twelve actions, settled and pending mixed. The settled action sent EARLIEST leaves the cards first; no pending one
  // ever does; what leaves is listed and can be read again by its id for this connection. ──
  await page.locator('#disconnect').click(); await connect();
  const diag = async (seat) => { await pick([seat]); await page.locator('#ops-bulk-diagnose').click(); const id = await until('command recorded', async () => { const c = commandsNow().at(-1); return c && !made.includes('command:' + c.id) ? c.id : null; }); await card('command:' + id).waitFor(); made.push('command:' + id); return 'command:' + id; };
  const made = []; const shelf = () => page.locator('#ops-ledger-shelf-list > p').evaluateAll((l) => l.map((x) => x.dataset.key));
  for (const id of local.db.prepare("SELECT t.command_id id FROM ops_command_targets t WHERE t.seat_id IN ('A1','A3') AND t.state IN ('queued','leased')").all().map((r) => r.id)) for (const seat of ['A1', 'A3']) { const r = await sync(seat); const got = (r.json.commands || []).find((x) => x.command_id === id); if (got) { leased[seat + id] = got; await report(seat, id, 'rejected', 'busy'); } }
  const P1 = await diag('A1'); const S = []; for (let i = 0; i < 6; i++) S.push(await diag('A6')); const P2 = await diag('A3'); for (let i = 0; i < 7; i++) S.push(await diag('A6'));
  // 15 actions: P1, S1–S6, P2, S7–S13. Twelve fit; the three earliest settled (S1 S2 S3) leave; P1 — the oldest of all — stays.
  assert.deepEqual(await keys(), [...S.slice(6).reverse(), P2, ...S.slice(3, 6).reverse(), P1], 'newest first; S1–S3 gone; both pending kept');
  assert.deepEqual(await shelf(), [S[2], S[1], S[0]], 'the shelf lists what left, most recent first');
  assert.match(await page.locator('#ops-ledger-note').innerText(), /결과가 확정된 이전 조치 3건은 카드를 아래 ‘화면에서 내린 결과’로 옮겼습니다 — 이 연결 동안 거기서 다시 열 수 있습니다/);
  assert.match(await page.locator('#ops-ledger-shelf').textContent(), /명령·기록 회수 결과를 다시 찾는 목록 화면은 아직 없어, 연결을 끊거나 이 페이지를 닫으면 이 목록도 사라집니다/); assert.doesNotMatch(await page.locator('#ops-ledger').innerText(), /기록 회수·보낸 자료에서 다시 찾기/);
  assert.match(await sum(P1), /접수 1/); assert.match(await sum(P2), /접수 1/);
  // P1 settles; the next action makes it — now the earliest settled — the one that leaves, while the later P2 (still pending) stays.
  const p1 = P1.slice(8); await lease('A1', p1); await report('A1', p1, 'accepted'); await report('A1', p1, 'succeeded', 'token_ok'); await until('P1 settled', async () => /결과 확정/.test(await seen(P1)), 10000);
  S.push(await diag('A6')); assert.deepEqual(await keys(), [S[13], ...S.slice(6, 13).reverse(), P2, ...S.slice(3, 6).reverse()], 'P1 (earliest, now settled) left; P2 pending stays');
  assert.deepEqual(await shelf(), [P1, S[2], S[1], S[0]]); await shot('retention', 'more than twelve: earliest settled leave to the shelf, pending stay');
  evidence.retention = { created: made, cards: await keys(), shelf: await shelf(), note: await page.locator('#ops-ledger-note').innerText() };
  ok('more than twelve mixed actions: the earliest-sent settled ones leave first, every pending one stays, and the note says where they went and its limit');
  // Reopen S1: read again by its id, back on top; the next earliest settled (S4) leaves in its place. A failed read keeps it listed.
  await page.locator('#ops-ledger-shelf-sum').click(); await page.locator(`#ops-ledger-shelf-list > p[data-key="${S[0]}"] .ledger-reopen`).click(); await card(S[0]).waitFor();
  assert.equal((await keys())[0], S[0]); assert.match(await line(S[0], 'A6'), /^A6 · student-f — \[미전달·만료·대상 변경\]/); assert.match(await seen(S[0]), /결과 확정/);
  assert.deepEqual(await shelf(), [S[3], P1, S[2], S[1]], 'S4 left for it'); assert.equal(await card(S[3]).count(), 0);
  const s2 = S[1].slice(8); await page.route('**/commands/' + s2, (route) => route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { reason: 'storage' } }) : route.continue());
  await page.locator(`#ops-ledger-shelf-list > p[data-key="${S[1]}"] .ledger-reopen`).click(); await page.locator(`#ops-ledger-shelf-list > p[data-key="${S[1]}"] .ledger-reopen-note`).filter({ hasText: '다시 읽지 못했습니다 (storage) — 목록에 그대로 둡니다.' }).waitFor();
  assert.equal(await card(S[1]).count(), 0); assert.ok((await shelf()).includes(S[1])); await page.unroute('**/commands/' + s2);
  evidence.reopen = { cards: await keys(), shelf: await shelf() }; await shot('reopen', 'S1 reopened from the shelf; a failed reopen stays listed');
  ok('a card that left can be reopened by its id (fresh read, back on top, the next earliest settled leaves); a failed reopen keeps it listed and says so');
  await page.locator('#disconnect').click(); await connect(); assert.equal(await page.locator('#ops-ledger-shelf').isVisible(), false); assert.deepEqual(await shelf(), []);
  ok('the shelf belongs to the connection: reconnecting starts without it, as the page said');

  assert.deepEqual(errors, [], 'no page error');
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ schema: 'hps-classroom-ops-results/1', at: new Date().toISOString(), checks: n, screenshots: shots, evidence, not_run: ['real Studio window (see the Mac run)', 'Windows', 'school network', 'staging/production D1·R2', 'real model', 'mail'] }, null, 2));
  console.log(`${n} AT-41 per-target result checks passed → ${out}`);
} finally { globalThis.fetch = realFetch; await browser?.close(); chalkServer.close(); local.close(); rmSync(root, { recursive: true, force: true }); }
