// Remote classroom operations (#751, U2) — AT-44 in a real browser: distribution of notices/materials from Chalk /manage.
//
// Real here: the Chalk page and its script in Chromium (the instructor drives everything through the UI), the Service router +
// SQLite, and for every seat the REAL device client — the extension's sync loop, InboxSession and InboxStore on a real
// directory — plus the real learner component (InstructorInbox.tsx) bundled and mounted in Chromium.
// Controlled here: WHEN an answer reaches the browser (held at the network layer; the Service has already answered) and one
// seat's disk (made to refuse writes). Synthetic accounts. No model, no mail, no real Studio window (that is the Mac run),
// no Windows, no school network, no staging or production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { localOps, OPS_ALL } from '../../worker/test/harness/classroom-ops.mjs';
import * as ops from '../../extensions/hypeproof-chat/src/classroomOps.ts';
import { InboxSession, InboxStore, inboxDir, inboxView } from '../../extensions/hypeproof-chat/src/classroomInboxStore.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.join(repo, 'e2e/test-results/classroom-ops-distribution'); mkdirSync(out, { recursive: true });
const local = await localOps(), { default: chalk } = await import('../../chalk/src/index.ts'), { setRoster } = await import('../../worker/src/lib/kv.ts');
const realFetch = globalThis.fetch; globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? local.app.fetch(new Request(url, init), local.env, { waitUntil() {} }) : realFetch(url, init);
const chalkServer = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
chalkServer.listen(0, '127.0.0.1'); await once(chalkServer, 'listening');
let n = 0; const ok = (name) => { n++; console.log('PASS ' + name); }; let browser; const root = mkdtempSync(path.join(tmpdir(), 'hps-dist-e2e-'));
try {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'], seats = ids.slice(0, 5).map((x, i) => ({ seat_id: 'A' + (i + 1), student_id: 'student-' + x }));
  await setRoster(local.env.HPS_KV, local.cohort, ids.map((x) => 'student-' + x)); await local.freeze();
  const FLAGS = { ops_observe: true, ops_commands: true, ops_collect: true, ops_distribute: true };
  assert.equal((await local.configure(seats, 0, { flags: FLAGS })).status, 201);
  const X = await local.teacher('teacher-x', [...OPS_ALL, 'distribute']), CAPS = ['observe', 'commands', 'retry_diagnostics', 'distribution_inbox'];
  // A1 A2 A3: current app, connected · A4: an app without an inbox · A5: paired, then offline
  const conn = {}; for (const [i, s] of seats.entries()) conn[s.seat_id] = (await local.pair(s.seat_id, 1, i + 1, i === 3 ? ['observe', 'commands', 'retry_diagnostics'] : CAPS)).conn.json;
  await local.request(local.base + '/grants/' + conn.A5.grant_id, 'DELETE');
  const memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; }; let eid = 0;
  const bodies = {}; const faults = { A3: false };
  async function device(seat, no) {
    const c = conn[seat], store = new InboxStore(inboxDir(root, { cohort: c.student.c, run: c.class_run_id, seat: c.seat_id, student: c.student.u }), { fault: (op, file) => { if (faults[seat] && op === 'write' && file.includes(path.sep + 'rev' + path.sep)) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } });
    const inbox = new InboxSession({ store, alive: () => true, clock: { mono: () => performance.now(), wall: () => Date.now() } }), inst = local.instance(no, no === 4 ? ['observe', 'commands', 'retry_diagnostics'] : CAPS);
    const outbox = await ops.OpsOutbox.open(memory(), c.grant_id, 'stream-' + seat, () => Date.now(), () => `event-e2e-${String(++eid).padStart(6, '0')}`); bodies[seat] = [];
    const loop = ops.startOpsSync({ outbox, appInstanceId: inst.app_instance_id, capabilities: inst.capabilities, ...(no === 4 ? {} : { distribution: inbox }), sample: () => ({ idle_ms: 1 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {},
      post: async (body) => { const r = await local.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: inst.boot_id }, c.credential); bodies[seat].push(r.json); return { status: r.status, body: r.json }; } });
    return { loop, store, cards: async () => (await store.read()).cards.map((x) => [x.title, x.revision, x.withdrawn ? 'withdrawn' : x.body]) };
  }
  const dev = {}; for (const [i, s] of seats.slice(0, 4).entries()) dev[s.seat_id] = await device(s.seat_id, i + 1);
  const now0 = () => local.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(), cool = () => local.db.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run();
  const tickAll = async (k = 4) => { for (let i = 0; i < k; i++) { now0(); local.db.prepare('UPDATE classroom_distribution_cards SET next_withdraw_at=0').run(); for (const d of Object.values(dev)) await d.loop.tick(); } };
  await tickAll(1);

  browser = await chromium.launch(); const origin = 'http://127.0.0.1:' + chalkServer.address().port, page = await browser.newPage({ viewport: { width: 1440, height: 1200 } }); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const held = []; let holdNext = 0;
  await page.route('**/distributions', async (route) => { if (route.request().method() !== 'POST' || holdNext <= 0) return route.continue(); holdNext--; const response = await route.fetch(); let release; const gate = new Promise((r) => { release = r; }); held.push({ body: JSON.parse(route.request().postData()), release }); await gate; await route.fulfill({ response }); });
  const heldAnswer = async (k) => { for (let i = 0; i < 100 && held.length <= k; i++) await page.waitForTimeout(50); assert.ok(held[k], 'request ' + k + ' was not intercepted'); return held[k]; };
  const connect = async (token) => { await page.goto(origin + '/manage'); await page.locator('#token').fill(token); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill('student-'); await page.locator('#connect button').first().click(); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await page.locator('#ops-check').click(); await page.locator('#ops-seats .ops-seat[data-seat="A5"]').waitFor(); };
  const box = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`).getByLabel('선택'), T = (id) => page.locator('#' + id).innerText(), L = async (id) => (await T(id)).split('\n').filter(Boolean); // one <p> per line; innerText puts a blank line between paragraphs
  const compose = async () => { if (!(await page.locator('#ops-dist').evaluate((d) => d.open))) await page.locator('#ops-dist-summary').click(); await page.locator('#ops-dist-title').waitFor(); }; // authoring is closed until the instructor asks for it
  const write = async (title, body, kind = 'notice') => { await compose(); await page.locator('#ops-dist-kind').selectOption(kind).catch(() => {}); await page.locator('#ops-dist-title').fill(title); await page.locator('#ops-dist-body').fill(body); await page.locator('#ops-dist-save').click(); await page.locator('#ops-dist-saved').filter({ hasText: '저장했습니다' }).waitFor(); };
  const runs = () => local.db.prepare('SELECT d.id,d.revision,d.targets_json FROM classroom_distributions d ORDER BY d.created_at,d.rowid').all(), targetsOf = (id) => local.db.prepare('SELECT seat_id,student_id,state FROM classroom_distribution_targets WHERE distribution_id=? ORDER BY seat_id').all(id).map((r) => [r.seat_id, r.student_id, r.state]);
  const waitState = async (re) => { for (let i = 0; i < 40; i++) { await page.locator('#ops-dist-refresh').click(); await page.waitForTimeout(150); if (re.test(await T('ops-dist-state'))) return; } assert.match(await T('ops-dist-state'), re); };

  // ── authority: an instructor with EVERY other capability does not even see the feature ──
  await connect(local.teacherToken); assert.deepEqual([await page.locator('#ops-dist').isVisible(), await page.locator('#ops-dist-preview').isVisible(), await page.locator('#ops-dist-results').isVisible()], [false, false, false], 'observe, coach, collect, command, deliver … none of them shows the composer, the send action or its results'); assert.equal(await page.locator('#ops-pick-collect').isVisible(), true, 'while what that token DOES hold is there');
  ok('authority: distribution is offered only to a token that holds `distribute`');

  // ── D1: write → select A1+A3 (not A2) → preview → confirm → the learners' devices → per-target result ──
  await connect(X); assert.equal(await page.locator('#ops-dist').isVisible(), true);
  // The instructor's work starts with the students: status → selection → actions in the first screen; authoring and history open on demand.
  // (An independent review measured the first student row at 1742px of a 720px viewport on 51708c7.)
  await page.setViewportSize({ width: 1280, height: 720 }); await page.evaluate(() => scrollTo(0, 0));
  const place = await page.evaluate(() => { const top = (s) => { const e = document.querySelector(s); return e && e.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }) ? Math.round(e.getBoundingClientRect().top + scrollY) : null; }; return { row: top('#ops-seats .ops-seat'), select: top('#ops-select-all'), action: top('#ops-dist-preview'), shares: top('#shares-title'), results: top('#ops-results'), composerOpen: document.querySelector('#ops-dist').open, historyOpen: document.querySelector('#ops-dist-history').open, title: top('#ops-dist-title') }; });
  await page.screenshot({ path: path.join(out, 'first-screen-720.png') });
  assert.ok(place.select < place.action && place.action < place.row && place.row < 720, 'selection, then actions, then the first student — all inside the first 720px: ' + JSON.stringify(place)); assert.ok(place.row < place.results && place.results < place.shares, 'results and history come after the students; the share panels after that');
  assert.deepEqual([place.composerOpen, place.historyOpen, place.title], [false, false, null], 'the composer and the history are closed until asked for'); await page.setViewportSize({ width: 1440, height: 1200 });
  // the same missing connection means different things to different actions — the shared summary does not pick one
  await box('A1').check(); await box('A5').check(); assert.doesNotMatch(await T('ops-selection'), /전달되지 않습니다/); assert.match(await T('ops-selection'), /기기 연결됨 1 · 기기 연결 없음 1 — 선택: A1, A5$/);
  assert.match(await T('ops-selection-policy'), /^기기 연결 없는 A5 — 진단: 요청이 전달되지 않습니다 · 기록 회수: 요청이 전달되지 않습니다 · 공지·자료: 접수해 두었다가 수업이 끝나기 전에 다시 연결되면 그때 전달합니다/); await box('A5').uncheck(); assert.equal(await page.locator('#ops-selection-policy').isVisible(), false, 'nothing to say when every selected seat is connected'); await page.locator('#ops-select-none').click();
  assert.equal(await page.locator('#ops-dist-preview').isDisabled(), true, 'nothing is selected and nothing is saved: nothing can be sent');
  await write('다음 시간 준비물', '노트북 충전기를 가져오세요.\n<script>alert(1)</script>'); assert.match(await T('ops-dist-saved'), /저장했습니다 · 1번째 판\. 저장만으로는 아무에게도 보내지지 않습니다/); assert.doesNotMatch((await T('ops-dist-saved')) + (await T('ops-dist-editing')), /[0-9a-f]{8}/, 'ids and hashes are not part of the main flow'); assert.match(await page.locator('#ops-dist-ids').textContent(), /자료 ID [0-9a-f-]{8,} · 1번째 판 · 내용 확인값\(sha256\) [0-9a-f]{64}/, '…they are one click away, whole'); assert.equal(runs().length, 0); assert.equal(await page.locator('#ops-dist-preview').isDisabled(), true, 'saved, but the default target is still the empty selection');
  await box('A1').check(); await box('A3').check(); await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor();
  assert.match(await T('ops-dist-impact'), /선택 2명에게 .*1번째 판.*선택하지 않은 3명에게는 아무것도 가지 않습니다/s); assert.match(await T('ops-dist-content'), /\[공지\] 다음 시간 준비물\n\n노트북 충전기를 가져오세요\.\n<script>alert\(1\)<\/script>/, 'the instructor sees exactly what will be sent, markup as characters');
  assert.deepEqual((await L('ops-dist-plan')), ['A1 · student-a — 지금 전달 가능', 'A3 · student-c — 지금 전달 가능']); assert.match(await T('ops-dist-note'), /확인만 했습니다/); assert.equal(runs().length, 0, 'a preview sends and writes nothing');
  await page.locator('#ops-dist-go').click(); await page.locator('#ops-dist-items').filter({ hasText: 'A1 · student-a' }).waitFor();
  assert.doesNotMatch(await T('ops-dist-note'), /확인만 했습니다/, 'once confirmed, the confirm-step notice is gone'); assert.match(await T('ops-dist-note'), /접수는 전달이 아닙니다/); assert.match(await T('ops-dist-state'), /대상 2명 · 보관함 반영 0 · 접수 2/, 'recorded is not delivered');
  assert.equal(await page.locator('#ops-dist').evaluate((d) => d.open), false, 'sent: the composer folds away'); assert.match(await T('ops-dist-summary'), /‘다음 시간 준비물’ 1번째 판 · 저장됨 · 이 판을 보낸 배포가 아래/); assert.doesNotMatch(await page.locator('#ops-dist-saved').textContent(), /보내지지 않습니다|보내지 않았습니다/, 'the saved line no longer says nobody was sent anything'); assert.match(await page.locator('#ops-dist-saved').textContent(), /이 판을 보낸 배포가 있습니다/);
  const first = runs()[0]; assert.deepEqual(targetsOf(first.id), [['A1', 'student-a', 'accepted'], ['A3', 'student-c', 'accepted']]);
  await tickAll(); await waitState(/보관함 반영 2 .* 모두 반영/); assert.match(await T('ops-dist-observed'), /결과 확정 .* 읽음·이해를 뜻하지 않습니다/); assert.doesNotMatch(await T('ops-dist-note'), /확인만 했습니다/, 'and it does not come back next to a final result');
  assert.deepEqual(await dev.A1.cards(), [['다음 시간 준비물', 1, '노트북 충전기를 가져오세요.\n<script>alert(1)</script>']]); assert.deepEqual(await dev.A2.cards(), []); assert.ok(bodies.A2.every((b) => b.distribution === undefined), 'the unselected learner was never sent a distribution block'); assert.ok(!existsSync(dev.A2.store.directory), 'and has no inbox directory');
  await page.screenshot({ path: path.join(out, 'd1-result.png'), fullPage: true }); ok('D1 write → select A1+A3 → preview → confirm → both devices hold it; A2 untouched; "confirmed" replaces the confirm-step notice');

  // ── late answers and a changed draft: a confirmation is only valid for what is on screen ──
  await page.locator('#ops-select-none').click(); await box('A2').check(); holdNext = 1; await page.locator('#ops-dist-preview').click(); const late = await heldAnswer(0); assert.deepEqual(late.body.targets, ['A2']);
  await box('A1').check(); assert.match(await T('ops-dist-note'), /선택이나 명단·연결·권한이 바뀌었습니다/); late.release(); await page.waitForTimeout(500); assert.equal(await page.locator('#ops-dist-confirm').isVisible(), false, 'an answer about [A2] opens nothing while [A1, A2] is selected');
  await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor(); await compose(); await page.locator('#ops-dist-body').fill('본문을 확인 뒤에 고쳤다'); assert.equal(await page.locator('#ops-dist-confirm').isVisible(), false, 'editing after the preview voids it'); assert.match(await T('ops-dist-note'), /내용이 바뀌었습니다/); assert.equal(await page.locator('#ops-dist-preview').isDisabled(), true, 'an unsaved draft cannot be sent');
  await page.evaluate(() => { document.getElementById('ops-dist-confirm').hidden = false; document.getElementById('ops-dist-go').disabled = false; document.getElementById('ops-dist-go').click(); }); await page.waitForTimeout(300); assert.equal(runs().length, 1, 'forcing the hidden button sends nothing');
  ok('late preview answer, changed selection, edited draft, forced button: nothing is sent');

  // ── D3+D4+D9+D10: v2 to everybody — an old app, an offline learner, a disk that refuses, and "failed only" re-selection ──
  await page.locator('#ops-dist-save').click(); await page.locator('#ops-dist-saved').filter({ hasText: '2번째 판' }).waitFor(); assert.match(await T('ops-dist-editing'), /2번째 판/);
  await page.locator('#ops-select-all').click(); faults.A3 = true; cool(); await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor();
  assert.deepEqual((await L('ops-dist-plan')).map((l) => l.slice(l.indexOf(' — ') + 3)), ['지금 전달 가능', '지금 전달 가능', '지금 전달 가능', '이 앱은 보관함을 지원하지 않음', '미연결 — 수업이 끝나기 전에 다시 연결되면 전달']);
  await page.locator('#ops-dist-go').click(); await page.locator('#ops-dist-items').filter({ hasText: 'A5 · student-e' }).waitFor(); local.db.prepare("UPDATE ops_latest_state SET last_received_at=0 WHERE seat_id='A4'").run(); await tickAll();
  await waitState(/보관함 반영 2 · 접수 1 · .* 실패 2/); const lines = (await L('ops-dist-items'));
  assert.match(lines[0], /^A1 · student-a — 전달: 보관함 반영 · 보관함: 지금 보관함에 있음$/); assert.match(lines[2], /^A3 · student-c — 전달: 실패 \(기기 저장 실패\)/); assert.match(lines[3], /^A4 · student-d — 전달: 이 앱은 보관함을 지원하지 않음$/); assert.match(lines[4], /^A5 · student-e — 전달: 접수 — 기기 연결 없음 · 수업이 끝나기 전에 다시 연결되면 전달$/);
  assert.deepEqual(await dev.A3.cards(), [['다음 시간 준비물', 1, '노트북 충전기를 가져오세요.\n<script>alert(1)</script>']], 'the learner whose disk refused v2 still has v1, whole'); assert.doesNotMatch(await T('ops-dist-state'), /모두 반영/);
  assert.match(await T('ops-dist-observed'), /확정 아님/, 'an offline learner may still get it: not final'); assert.match(await page.locator('#ops-dist-retry').innerText(), /실패·미확인 2명만 다시 선택/);
  // …meanwhile A3's disk recovers and the instructor has not looked yet: re-selecting reads first
  const before = runs().length; await page.locator('#ops-dist-retry').click(); await page.locator('#ops-dist-note').filter({ hasText: '다시 선택했습니다' }).waitFor();
  assert.equal(runs().length, before, 're-selecting sends nothing'); const chosen = []; for (const s of seats) if (await box(s.seat_id).isChecked()) chosen.push(s.seat_id); assert.deepEqual(chosen, ['A3', 'A4'], 'only the failed ones — not the two that hold it, not the offline one that is still pending');
  faults.A3 = false; cool(); await box('A4').uncheck(); await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor(); await page.locator('#ops-dist-go').click(); await page.locator('#ops-dist-items').filter({ hasText: /^A3 · student-c/ }).waitFor(); await tickAll(); await waitState(/대상 1명 · 보관함 반영 1 .* 모두 반영/);
  assert.deepEqual(await dev.A3.cards(), [['다음 시간 준비물', 2, '본문을 확인 뒤에 고쳤다']], 'one card, now v2'); assert.deepEqual(await dev.A1.cards(), [['다음 시간 준비물', 2, '본문을 확인 뒤에 고쳤다']]);
  await page.screenshot({ path: path.join(out, 'partial-and-reselect.png'), fullPage: true }); ok('D3/D4/D9/D10 old app = unsupported, offline = pending until reconnect, refused disk = failed with v1 kept; "failed only" re-selects exactly those and sends nothing');

  // ── D8+D13: the same v2 again, then withdrawing the runs in order — shown as delivery evidence AND present availability ──
  await page.locator('#ops-select-none').click(); await box('A1').check(); cool(); await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor(); assert.match(await T('ops-dist-plan'), /이미 같은 판이 이 기기 보관함에 있음\(예상\)/);
  await page.locator('#ops-dist-go').click(); await page.locator('#ops-dist-items').filter({ hasText: /^A1 · student-a/ }).waitFor(); await tickAll(); await waitState(/보관함 반영 1 .* 모두 반영/); assert.match(await T('ops-dist-items'), /이미 같은 판이 이 기기 보관함에 있음 · 보관함: 지금 보관함에 있음/); assert.equal((await dev.A1.cards()).length, 1, 'no second card');
  await page.locator('#ops-dist-revoke').click(); assert.match(await T('ops-dist-revoke-impact'), /같은 판을 보낸 다른 배포가 남아 있지 않을 때만 카드가 내려갑니다.*이미 본 내용은 되돌릴 수 없습니다/s); await page.locator('#ops-dist-revoke-go').click(); await page.locator('#ops-dist-now').filter({ hasText: '이 배포는 회수했습니다' }).waitFor(); await tickAll();
  assert.match(await T('ops-dist-items'), /보관함: 이 배포는 회수됨 · 같은 판의 다른 배포가 보관함을 유지/); assert.match(await T('ops-dist-state'), /^회수한 배포 · .* 보관함 반영 1/); assert.doesNotMatch(await T('ops-dist-state'), /모두 반영/, 'a withdrawn run does not end as "all reflected"'); assert.match(await T('ops-dist-now'), /회수 전의 전달 기록입니다\. 지금 기기: 회수 요청·기기 확인 전 0 · 기기 보관함에서 회수 확인 0 · 회수 확인 불가 0 · 다른 배포로 보관함에 남아 있음 1$/); assert.deepEqual(await dev.A1.cards(), [['다음 시간 준비물', 2, '본문을 확인 뒤에 고쳤다']], 'another run of v2 still permits the card');
  // the sent-materials list finds the earlier run again; withdrawing it takes v2 down — and the un-revoked v1 run does not bring v1 back
  await page.locator('#ops-dist-history summary').click(); await page.locator('#ops-dist-list button').first().click(); await page.locator('#ops-dist-object h3').waitFor(); assert.match(await T('ops-dist-object'), /2번째 판/); assert.match(await T('ops-dist-object'), /배포 4회/);
  const v2all = runs().filter((r) => r.revision === 2 && JSON.parse(r.targets_json).length === 5)[0]; await page.locator('#ops-dist-object p', { hasText: '대상 5명' }).getByRole('button').click(); await page.locator('#ops-dist-state').filter({ hasText: '대상 5명' }).waitFor(); assert.equal(runs().length, 4, 'opening results re-sends nothing');
  await page.locator('#ops-dist-revoke').click(); await page.locator('#ops-dist-revoke-go').click(); await page.locator('#ops-dist-now').filter({ hasText: '이 배포는 회수했습니다' }).waitFor(); await tickAll(); await page.locator('#ops-dist-refresh').click(); await page.waitForTimeout(300);
  assert.deepEqual(await dev.A1.cards(), [['', 2, 'withdrawn']], 'the last run that permitted v2 is gone: the card came down, and v1 did not return'); const after = (await L('ops-dist-items'));
  assert.match(await T('ops-dist-state'), /^회수한 배포 · 2번째 판 · 대상 5명 · 보관함 반영 2 /); assert.match(await T('ops-dist-now'), /지금 기기: 회수 요청·기기 확인 전 0 · 기기 보관함에서 회수 확인 2 · 회수 확인 불가 0 — 이 배포로 기기에 남은 자료는 없습니다$/, 'history (2 were delivered) and the present (both confirmed gone) are two sentences');
  assert.match(after[0], /^A1 · student-a — 전달: 보관함 반영 · 보관함: 기기 보관함에서 회수됨$/, 'it WAS delivered; it is NOT there now — both said'); assert.match(after[4], /A5 · student-e — 전달: 회수됨 — 반영 전에 멈춤/, 'the offline learner will not get it after all');
  assert.deepEqual(await dev.A2.cards(), [['', 2, 'withdrawn']]); assert.deepEqual(targetsOf(v2all.id).map((r) => r[2]), ['reflected', 'reflected', 'failed', 'unsupported', 'revoked']);
  await page.screenshot({ path: path.join(out, 'withdraw-order.png'), fullPage: true }); ok('D8/D13 same revision again = no second card; first withdrawal is covered, the last one takes the card down; evidence and availability shown side by side; sent materials re-found without re-sending');

  // ── retire a material; ended class ──
  await compose(); await page.locator('#ops-dist-new').click(); await write('자료 회수 시험', '곧 회수할 글'); await page.locator('#ops-select-none').click(); await box('A2').check(); cool(); await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor(); await page.locator('#ops-dist-go').click(); await page.locator('#ops-dist-items').filter({ hasText: /^A2 · student-b/ }).waitFor(); await tickAll(); await waitState(/모두 반영/);
  await page.locator('#ops-dist-list-go').click(); await page.locator('#ops-dist-list p', { hasText: '자료 회수 시험' }).getByRole('button').click(); await page.locator('#ops-dist-object h3').waitFor(); await page.locator('#ops-dist-object button', { hasText: '자료 회수' }).click(); await page.locator('#ops-dist-object button', { hasText: '확인하고 자료 회수' }).click(); await page.locator('#ops-dist-object .confirm').filter({ hasText: '자료를 회수했습니다' }).waitFor(); await tickAll();
  assert.ok((await dev.A2.cards()).some((c) => c[2] === 'withdrawn' && c[1] === 1)); assert.equal(await page.locator('#ops-dist-preview').isDisabled(), true, 'a withdrawn material cannot be sent again from the form');
  local.db.prepare("UPDATE sessions SET ended_at='2026-01-01T00:00:00Z' WHERE id=?").run(local.run); await compose(); await page.locator('#ops-dist-new').click(); await page.locator('#ops-dist-title').fill('끝난 뒤'); await page.locator('#ops-dist-body').fill('x'); await page.locator('#ops-dist-save').click(); await page.locator('#ops-dist-saved').filter({ hasText: '이 수업은 끝났습니다' }).waitFor();
  local.db.prepare('UPDATE sessions SET ended_at=NULL WHERE id=?').run(local.run); ok('retire takes the material down everywhere; an ended class accepts nothing new and says why');

  // ── D12+D16: the REAL learner component, mounted in Chromium with hostile text ──
  const require = createRequire(path.join(repo, 'e2e/package.json')) /* esbuild comes with the e2e package's own dependencies, which the CI browser job installs */, esbuild = require('esbuild');
  const built = await esbuild.build({ stdin: { contents: `import { createRoot } from "react-dom/client"; import { createElement } from "react"; import { InstructorInbox } from "./webview-ui/src/InstructorInbox.tsx"; window.mount = (inbox) => { window.posted = []; (window.__inboxRoot ??= createRoot(document.getElementById("root"))).render(createElement(InstructorInbox, { inbox, post: (m) => window.posted.push(m) })); };`, resolveDir: path.join(repo, 'extensions/hypeproof-chat'), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', nodePaths: [path.join(repo, 'extensions/hypeproof-chat/webview-ui/node_modules')], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const css = (await import('node:fs')).readFileSync(path.join(repo, 'extensions/hypeproof-chat/webview-ui/src/styles.css'), 'utf8');
  const learner = await browser.newPage({ viewport: { width: 390, height: 800 } }); const requests = []; learner.on('request', (r) => requests.push(r.url())); const dialogs = []; learner.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await learner.setContent(`<!doctype html><html><head><style>:root{--hp-line:#555;--hp-muted:#999;--hp-accent:#9c0}body{margin:0;font:16px system-ui}${css}</style></head><body><main style="width:100%"><div id="root"></div></main></body></html>`); await learner.addScriptTag({ content: built.outputFiles[0].text });
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script> [click](javascript:alert(3)) ![x](https://evil.example/p.png) `rm -rf ~` /etc/passwd ' + '가나다라마바사'.repeat(40) + ' https://example.org/' + 'a'.repeat(300);
  const view = await inboxView(dev.A1.store, { run: local.run, student: 'student-a', generation: 7, ended: false });
  await learner.evaluate(([v, h]) => window.mount({ ...v, unread: 1, cards: [{ object_id: '99999999-9999-4999-8999-999999999999', kind: 'material', title: h.slice(0, 80), body: h, links: [{ label: '수업 안내', url: 'https://docs.example.org/guide?x=1' }], revision: 2, received_at: Date.now(), is_new: true, withdrawn: false, unreadable: false }, ...v.cards] }), [view, hostile]);
  const inbox = learner.locator('details.hp-inbox'); await inbox.waitFor(); assert.equal(await inbox.evaluate((d) => d.open), false, 'closed by default: it never opens itself over the learner\'s work'); assert.match(await inbox.locator('> summary').innerText(), /강사가 보낸 공지·자료 1개 · 새 자료 1개/, '"new" is said in words');
  await inbox.locator('> summary').focus(); await learner.keyboard.press('Enter'); const cardEl = inbox.locator('li.hp-inbox-card').first(); await cardEl.locator('summary').focus(); await learner.keyboard.press('Enter'); assert.equal(await cardEl.locator('details').evaluate((d) => d.open), true, 'keyboard only');
  assert.equal(await cardEl.locator('.hp-inbox-body').innerText(), hostile.trim(), 'every character is shown as typed'); assert.equal(await learner.locator('#root img, #root script, #root a, #root iframe').count(), 0, 'no element was created from the text — not even a link'); assert.deepEqual(dialogs, []);
  assert.deepEqual(requests.filter((u) => !u.startsWith('about:') && !u.startsWith('data:')), [], 'nothing was fetched, opened or downloaded by showing it'); await learner.waitForFunction(() => window.posted.length > 0) /* `toggle` is dispatched as a task after the element opens */; assert.deepEqual(await learner.evaluate(() => window.posted), [{ type: 'inboxOpen', objectId: '99999999-9999-4999-8999-999999999999', generation: 7 }], 'opening is told to the host (to stop saying "new") and nothing else happens');
  assert.match(await cardEl.locator('.hp-inbox-meta').first().innerText(), /강사가 보냄 · 자료 · .* · 수정됨 \(2번째 판\) · 새 자료/, 'the source is always named'); await cardEl.getByRole('button', { name: '주소 복사' }).click();
  assert.deepEqual((await learner.evaluate(() => window.posted)).at(-1), { type: 'inboxLink', objectId: '99999999-9999-4999-8999-999999999999', url: 'https://docs.example.org/guide?x=1', generation: 7, action: 'copy' }, 'a link does something only when the learner presses its button — and the host decides what');
  assert.match(await inbox.locator('li.hp-inbox-card').last().innerText(), /강사가 회수한 자료입니다.*내가 따로 적어 둔 글과 파일은 그대로입니다/s);
  const overflow = () => learner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok(await overflow() <= 0, '390px: no sideways scrolling, even with a 300-character URL'); await learner.evaluate(() => { document.documentElement.style.fontSize = '200%'; document.body.style.fontSize = '32px'; }); assert.ok(await overflow() <= 0, '200% text: still none');
  assert.equal(await learner.locator('.studio-primary, button.primary, .hp-cta-primary').count(), 0, 'no Primary button is added to the learner\'s screen'); await learner.screenshot({ path: path.join(out, 'learner-card-390.png'), fullPage: true });
  // "not connected" is not "the class ended": after an app restart in a running class the learner is told the first, never the second
  for (const [flags, want, never, note] of [[{ offline: true, ended: false }, /수업 연결 확인 전/, /끝난 수업/, 1], [{ offline: false, ended: true }, /끝난 수업의 자료/, /연결 확인 전/, 0], [{ offline: false, ended: false }, /^강사가 보낸 공지·자료 \d+개/, /끝난 수업|연결 확인 전/, 0]]) {
    await learner.evaluate(([v, f]) => window.mount({ ...v, ...f }), [view, flags]); await learner.waitForFunction((n) => document.querySelectorAll('[data-inbox-offline]').length === n, note); const said = await inbox.locator('> summary').innerText(); assert.match(said, want); assert.doesNotMatch(said, never); }
  await page.setViewportSize({ width: 390, height: 900 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'the instructor panel at 390px'); await page.setViewportSize({ width: 1440, height: 1200 });
  ok('D12/D16 the real learner component: text stays text, nothing loads or opens by itself, links act only on a press, closed by default, keyboard, 390px and 200% without sideways scrolling');

  assert.deepEqual(errors, [], 'no script error on the instructor page'); console.log(`\n${n} distribution browser checks passed`);
} finally { await browser?.close(); chalkServer.close(); local.close(); rmSync(root, { recursive: true, force: true }); }
