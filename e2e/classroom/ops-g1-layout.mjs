// Remote classroom operations (#751) — G1 instructor operating surface in a real browser: the student TABLE and what goes around it.
//
//   the table      one row per learner, the same seven columns, 24 synthetic seats; the default board shows at least 8 complete rows at
//                  1280×720 and 4 at 1024×640 with 14px+ text and no horizontal overflow (row boxes measured, not CSS read);
//   filter/search  the summary chips and the search box change only what is SHOWN — a hidden seat stays selected and is still a target;
//   selection      choosing seats sends nothing; the one primary button follows the context and opens a confirmation, never a request;
//   detail         beside the list at 1280 (the list, its selection and the current-row mark stay), a drawer at 1024 (Escape and focus
//                  return); arrow keys move between the rows that are shown;
//   navigation     below 1200px the left navigation is a drawer: the page behind is inert, Escape closes it and focus comes back;
//   result cards   the first line is the action + final / unknown / still moving + the next step; per-student lines are short until
//                  "세부 근거 펼치기"; failure-only re-selection ticks boxes and sends nothing;
//   wrap-up        four steps from what the Service said, an off switch shown as unavailable — never as done;
//   states         before connecting, a long learner id, a stale signal (neutral, not red), and after disconnecting.
// Real: Chalk page and script in Chromium, the Service router + SQLite. Synthetic: accounts and every device report (no device runs
// the commands, so a sent diagnosis stays "진행 중" for a connected seat and "미전달" for an unconnected one — both are what they are).
// Not evidence about a real Studio window, Windows, a school network, staging or production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { localOps, OPS_ALL } from '../../worker/test/harness/classroom-ops.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.join(repo, 'e2e/test-results/classroom-ops-g1'); mkdirSync(out, { recursive: true });
const local = await localOps(), { default: chalk } = await import('../../chalk/src/index.ts'), { setRoster } = await import('../../worker/src/lib/kv.ts');
const realFetch = globalThis.fetch; globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? local.app.fetch(new Request(url, init), local.env, { waitUntil() {} }) : realFetch(url, init);
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const results = {}; let browser;
const LONG = 'student-긴이름-국제교류-동아리-발표준비-0024'.replace(/[^a-zA-Z0-9_-]/g, '') + '-exchange-program-presenter';
try {
  const seats = ['A', 'B', 'C', 'D'].flatMap((r, ri) => Array.from({ length: 6 }, (_, i) => ({ seat_id: r + (i + 1), student_id: ri * 6 + i === 23 ? LONG : 'student-' + String(ri * 6 + i + 1).padStart(2, '0') })));
  await setRoster(local.env.HPS_KV, local.cohort, seats.map((s) => s.student_id)); await local.freeze();
  assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_distribute: true } })).status, 201);
  // A1 token rejected (blocked) · A2 waiting for the learner's approval · A3 never connected · A4 went quiet (stale) · B1–B3 one provider
  // outage (shared) · the rest ready. D6 has the long learner id. B5 asked for help (a share addressed to the instructor).
  const plan = { A1: [local.event(1, 'activation', { stage: 'token_rejected', reason: 'auth_signature', http_status: 401 }), local.event(2, 'error', { class: 'auth_signature', code: 'http_401', request_id: 'req-g1-0001', blocking: true })],
    A2: [local.event(1, 'activation', { stage: 'runtime_ready' }), local.event(2, 'step', { lesson_version: local.lesson.version, step_id: 'build', status: 'in_progress' }), local.event(3, 'runtime', { status: 'waiting_approval' })] };
  for (const s of ['B1', 'B2', 'B3']) plan[s] = [local.event(1, 'activation', { stage: 'runtime_ready' }), local.event(2, 'error', { class: 'provider_5xx', code: 'http_529', request_id: 'req-g1-' + s, blocking: true })];
  let n = 0; for (const s of seats) { n++; if (s.seat_id === 'A3') continue; const c = (await local.pair(s.seat_id, 1, n)).conn.json; assert.equal((await local.sync(c.credential, plan[s.seat_id] ?? [local.event(1, 'activation', { stage: 'runtime_ready' }), local.event(2, 'step', { lesson_version: local.lesson.version, step_id: 'build', status: 'in_progress' })], n)).status, 200); }
  local.db.prepare("UPDATE ops_latest_state SET last_received_at=? WHERE seat_id='A4'").run(Date.now() - 25 * 60000);
  const teacher = await local.teacher('teacher-a', [...OPS_ALL, 'distribute']), /* distribution on: its buttons share the toolbar */ learner = await local.student('student-11');
  assert.equal((await local.request('/v1/classroom/shares', 'POST', { id: crypto.randomUUID(), recipient_id: 'teacher-a', kind: 'help', consent: true, duration_minutes: 480, content: { prompt: '[합성] 어디부터 확인할까요?' } }, learner)).status, 201);
  const commands = () => local.db.prepare('SELECT COUNT(*) AS n FROM ops_commands').get().n, batches = () => local.db.prepare('SELECT COUNT(*) AS n FROM classroom_collect_batches WHERE dry_run=0').get().n;

  browser = await chromium.launch(); const origin = 'http://127.0.0.1:' + server.address().port, errors = [];
  const open = async (viewport) => { const p = await browser.newPage({ viewport }); p.on('pageerror', (e) => errors.push(e.message)); await p.goto(origin + '/manage'); return p; };
  const connect = async (p) => { await p.locator('#token').fill(teacher); await p.locator('#cohort').fill(local.cohort); await p.locator('#prefix').fill('student-'); await p.locator('#connect-go').click(); await p.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await p.locator('#ops-seats .ops-seat').nth(23).waitFor(); await p.locator('#ops-help-state').filter({ hasText: '응답할 도움 요청 1건' }).waitFor(); };
  // A row is complete when all of it is inside the viewport AND inside the list's own scrolling box (a clipped row does not count).
  const measure = (p) => p.evaluate(() => { const list = document.getElementById('ops-seats').getBoundingClientRect(), bottom = Math.min(innerHeight, list.bottom), rows = [...document.querySelectorAll('#ops-seats .ops-seat')].filter((r) => !r.hidden).map((r) => r.getBoundingClientRect());
    const texts = [...document.querySelectorAll('#ops-seats td *, #ops-seats th')].filter((e) => [...e.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim()) && e.checkVisibility());
    return { complete: rows.filter((b) => b.top >= list.top && b.bottom <= bottom + 0.5).length, first_row_top: Math.round(rows[0]?.top ?? -1), row_heights: rows.slice(0, 8).map((b) => Math.round(b.height)), min_font_px: Math.min(...texts.map((e) => parseFloat(getComputedStyle(e).fontSize))), overflow: document.documentElement.scrollWidth > innerWidth + 1, body_font_px: parseFloat(getComputedStyle(document.body).fontSize), zoom: devicePixelRatio }; });
  const row = (p, id) => p.locator(`#ops-seats .ops-seat[data-seat="${id}"]`);

  // ── states before a connection ──
  let page = await open({ width: 1280, height: 720 });
  assert.equal(await page.locator('#ops-table').isHidden(), true); assert.equal(await page.locator('#ops-seats .ops-seat').count(), 0); assert.match(await page.locator('#status').innerText(), /강사 토큰과 코호트를 입력하세요/);
  await connect(page); console.log('PASS states: before a connection the table is absent and the connection form is the page');
  // HPS_G1_WIDEN=0.06 widens every glyph (letter-spacing, em) to rehearse a wider font on a machine that has a narrow one — the CI
  // runner's Korean font measured one to two toolbar lines taller than the Mac's. The default run measures the page as it is.
  if (process.env.HPS_G1_WIDEN) await page.addStyleTag({ content: `*{letter-spacing:${Number(process.env.HPS_G1_WIDEN)}em!important}` });

  // ── 1. the table at 1280×720 and 1024×640 ──
  const heads = await page.locator('#ops-table thead th').allInnerTexts(); assert.deepEqual(heads, ['선택', '좌석 · 학생', '입장 · 토큰', '현재 단계', '수행 · 도움 · 오류', '마지막 신호', '기록 · 근거']);
  for (const id of ['A1', 'C4', 'D6']) assert.equal(await row(page, id).locator('> td').count(), 7, id + ': every row has the same cells');
  assert.equal(await page.locator('#ops-dist-preview').isVisible(), true, 'distribution is on, so all four actions share the toolbar while measuring');
  const wide = await measure(page); results.default_1280x720 = wide; await page.screenshot({ path: path.join(out, 'g1-default-1280x720.png') });
  assert.ok(wide.complete >= 8, '1280×720: at least 8 complete rows before page scrolling: ' + JSON.stringify(wide)); assert.ok(wide.min_font_px >= 14 && wide.body_font_px >= 14 && !wide.overflow && wide.zoom === 1, JSON.stringify(wide));
  assert.equal(await page.locator('#side').isVisible(), true, 'the left navigation is on screen at 1280'); assert.equal(await page.locator('nav.flow a[aria-current="page"]').innerText(), '운영 보드');
  assert.equal(await row(page, 'A1').locator('p.blocked').innerText(), '토큰이 올바르지 않습니다'); assert.equal(await row(page, 'A4').locator('p.blocked').count(), 0, 'a stale seat is not red'); assert.match(await row(page, 'A4').innerText(), /\? 신호가 끊겼습니다 · 확인 불가|신호가 끊겼습니다 · 확인 불가/);
  assert.equal(await row(page, 'A2').locator('p.blocked, p.caution').count(), 0, 'waiting for approval is not an error'); assert.match(await row(page, 'A2').innerText(), /수행: 학생 승인 대기/);
  assert.match(await row(page, 'B5').locator('p.help').innerText(), /^도움 요청 1건 · 기술 장애 아님$/, 'a learner\'s help request is its own line, not a fault'); assert.equal(await row(page, 'B5').locator('p.blocked').count(), 0);
  assert.match(await page.locator('#ops-summary').innerText(), /기술 장애 확인 4[\s\S]*도움 요청 1[\s\S]*승인 대기 1/);
  const long = await row(page, 'D6').evaluate((r) => { const b = r.querySelector('.who').getBoundingClientRect(), c = r.querySelector('td.c-seat').getBoundingClientRect(); return { inside: b.right <= c.right + 0.5 && b.left >= c.left - 0.5, lines: Math.round(b.height / parseFloat(getComputedStyle(r.querySelector('.who')).lineHeight)) }; });
  assert.ok(long.inside, 'a long learner id wraps inside its cell: ' + JSON.stringify(long));
  { const p = await open({ width: 1024, height: 640 }); await connect(p); const m = await measure(p); results.default_1024x640 = m; await p.screenshot({ path: path.join(out, 'g1-default-1024x640.png') });
    assert.ok(m.complete >= 4 && m.min_font_px >= 14 && !m.overflow, '1024×640: at least 4 complete rows, readable, no sideways scroll: ' + JSON.stringify(m));
    // the navigation is a drawer here: open, the page behind inert, Escape closes it and focus comes back to the menu button
    assert.equal(await p.locator('#side').isVisible(), false); await p.locator('#side-open').click(); assert.equal(await p.locator('#side').isVisible(), true); assert.equal(await p.getAttribute('#side-open', 'aria-expanded'), 'true');
    assert.equal(await p.evaluate(() => document.getElementById('work').inert), true, 'the page behind the drawer is inert'); assert.ok(await p.evaluate(() => document.getElementById('side').contains(document.activeElement)), 'focus moved into the drawer');
    await p.screenshot({ path: path.join(out, 'g1-nav-drawer-1024x640.png') }); await p.keyboard.press('Escape'); assert.equal(await p.locator('#side').isVisible(), false); assert.equal(await p.evaluate(() => document.activeElement?.id), 'side-open'); assert.equal(await p.evaluate(() => document.getElementById('work').inert), false);
    // the detail is a drawer too; Escape returns focus to the row that opened it
    await row(p, 'A1').getByRole('button', { name: '근거·조치' }).click(); const d = await p.evaluate(() => getComputedStyle(document.getElementById('ops-detail')).position); assert.equal(d, 'fixed'); await p.screenshot({ path: path.join(out, 'g1-detail-drawer-1024x640.png') });
    await p.keyboard.press('Escape'); assert.equal(await p.locator('#ops-detail').isHidden(), true); assert.equal(await p.evaluate(() => document.activeElement?.closest('.ops-seat')?.dataset.seat), 'A1'); await p.close(); }
  console.log('PASS table: seven comparable columns; 1280×720 ' + wide.complete + ' complete rows, 1024×640 ' + results.default_1024x640.complete + ' (row boxes measured, 14px+, no overflow); fault ≠ help ≠ stale ≠ approval wait; long id wraps; drawers at 1024 with inert page, Escape and focus return');

  // ── 2. filter and search change the view, never the targets ──
  const before = commands();
  await row(page, 'C1').getByLabel('선택').check(); await row(page, 'A1').getByLabel('선택').check();
  await page.locator('#ops-summary button[data-filter="blocked"]').click(); assert.equal(await page.getAttribute('#ops-summary button[data-filter="blocked"]', 'aria-pressed'), 'true');
  const shown = await page.locator('#ops-seats .ops-seat:visible').evaluateAll((l) => l.map((r) => r.dataset.seat)); assert.deepEqual(shown, ['A1', 'B1', 'B2', 'B3']);
  assert.match(await page.locator('#ops-shown').innerText(), /24명 중 4명 표시 · ‘기술 장애 확인’만 · 선택한 학생 중 1명은 지금 목록에서 가려져 있습니다 \(조치 대상에는 그대로 포함\)/);
  assert.match(await page.locator('#ops-selection').innerText(), /선택 2 \/ 전체 24석 .* — 선택: A1, C1$/, 'the hidden C1 is still a target and is named');
  await page.locator('#ops-summary button[data-filter="blocked"]').click(); assert.equal(await page.locator('#ops-seats .ops-seat:visible').count(), 24, 'pressing it again shows everyone');
  await page.locator('#ops-search').fill('d6'); assert.deepEqual(await page.locator('#ops-seats .ops-seat:visible').evaluateAll((l) => l.map((r) => r.dataset.seat)), ['D6']); await page.locator('#ops-search').fill('없는좌석'); assert.match(await page.locator('#ops-empty').innerText(), /조건에 맞는 학생이 없습니다/); await page.locator('#ops-search').fill('');
  assert.equal(commands(), before, 'filtering and selecting sent nothing'); console.log('PASS filter/search: view only; hidden selected seats stay targets and are counted; nothing sent');

  // ── 3. the primary follows the context and only opens a confirmation ──
  const primary = () => page.locator('.primary:visible');
  await page.locator('#ops-select-none').click(); assert.equal((await primary().innerText()).trim(), '기술 문제 좌석 선택 (장애 4 · 주의 0)', 'nothing selected → selecting the problems is the one step');
  await page.locator('#ops-select-fault').click(); assert.equal((await primary().innerText()).trim(), '좌석 진단', 'faults selected → diagnosing them'); assert.equal(await primary().count(), 1);
  await page.locator('#ops-select-none').click(); await row(page, 'C2').getByLabel('선택').check(); assert.equal((await primary().innerText()).trim(), '기록 회수 — 종류 고르고 확인', 'a working seat selected → collection');
  await primary().click(); await page.locator('#ops-pick-confirm').waitFor(); assert.equal(await page.locator('#ops-pick-kind-record').isChecked(), false, 'no kind is preselected'); assert.equal(batches(), 0, 'the primary opened a confirmation (a dry-run preview); nothing was requested'); assert.equal(commands(), before);
  await page.screenshot({ path: path.join(out, 'g1-bulk-confirm-1280x720.png') }); await page.locator('#ops-pick-cancel').click();
  await page.locator('#ops-pick-by > summary').click(); await page.locator('#ops-select-online').click(); assert.equal(await page.locator('#ops-pick-by').evaluate((d) => d.open), false, 'the menu closes after a pick'); assert.match(await page.locator('#ops-selection').innerText(), /선택 23 \/ 전체 24석/);
  await page.locator('#ops-pick-by > summary').click(); await page.keyboard.press('Escape'); assert.equal(await page.locator('#ops-pick-by').evaluate((d) => d.open), false, 'Escape closes the menu');
  await page.locator('#ops-select-none').click(); assert.equal(commands(), before); console.log('PASS selection: one primary chosen by the context; it opens the confirmation only; the other-conditions menu picks and closes');

  // ── 4. the detail beside the list keeps the list, the selection and the current row; the keyboard moves between rows ──
  await row(page, 'C2').getByLabel('선택').check(); await row(page, 'A1').getByRole('button', { name: '근거·조치' }).click(); await page.locator('#ops-detail-title').filter({ hasText: 'A1' }).waitFor();
  const side = await page.evaluate(() => { const l = document.getElementById('ops-seats').getBoundingClientRect(), d = document.getElementById('ops-detail').getBoundingClientRect(); return { position: getComputedStyle(document.getElementById('ops-detail')).position, beside: d.left >= l.right - 1, list_width: Math.round(l.width) }; });
  assert.ok(side.position === 'sticky' && side.beside, JSON.stringify(side)); assert.equal(await row(page, 'A1').getAttribute('aria-current'), 'true'); assert.equal(await row(page, 'C2').getByLabel('선택').isChecked(), true, 'opening a detail keeps the selection');
  assert.match(await page.locator('#ops-recovery').innerText(), /앱이 보고한 상태: 토큰이 올바르지 않습니다 — /); assert.match(await page.locator('#ops-tech').innerText(), /요청 ID req-g1-0001/, 'technical ids live in the detail');
  await page.keyboard.press('Escape'); await row(page, 'D5').getByRole('button', { name: '근거·조치' }).click(); await page.locator('#ops-detail-title').filter({ hasText: 'D5' }).waitFor();
  assert.ok(await row(page, 'D5').evaluate((r) => { const a = r.getBoundingClientRect(), l = document.getElementById('ops-seats').getBoundingClientRect(); return a.top >= l.top && a.bottom <= Math.min(l.bottom, innerHeight) + 0.5; }), 'the opened row is in sight inside the list and the window'); await page.keyboard.press('Escape');
  await row(page, 'A1').getByRole('button', { name: '근거·조치' }).click(); await page.locator('#ops-detail-title').filter({ hasText: 'A1' }).waitFor();
  results.detail_1280 = { ...side, rows_visible: (await measure(page)).complete }; await page.screenshot({ path: path.join(out, 'g1-detail-error-1280x720.png') });
  await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => document.activeElement?.closest('.ops-seat')?.dataset.seat), 'A1');
  await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement?.closest('.ops-seat')?.dataset.seat), 'A2'); await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement?.closest('.ops-seat')?.dataset.seat), 'D6');
  await page.keyboard.press('Enter'); await page.locator('#ops-detail-title').filter({ hasText: 'D6' }).waitFor(); await page.keyboard.press('Escape');
  await row(page, 'B5').locator('td.c-step').click(); await page.locator('#ops-detail-title').filter({ hasText: 'B5' }).waitFor(); assert.match(await page.locator('#ops-evidence').innerText(), /이 학생이 보낸 도움 요청 1건 — 학습 도움이며 기술 장애가 아닙니다/); await page.keyboard.press('Escape');
  console.log('PASS detail: beside the list at 1280 with the list, selection and current row kept; cause + next step and technical ids in the detail; arrows/Home/End/Enter; a row click opens it');

  // ── 5. a result card: headline first, short lines, the long evidence behind one button; failure-only re-selection sends nothing ──
  await page.locator('#ops-select-none').click(); await row(page, 'A1').getByLabel('선택').check(); await row(page, 'A3').getByLabel('선택').check(); await page.locator('#ops-bulk-diagnose').click();
  const card = page.locator('#ops-ledger-list .ledger-card').first(); await card.waitFor(); await card.locator('.ledger-items > p').nth(1).waitFor();
  await page.waitForFunction(() => /미전달/.test(document.querySelector('#ops-ledger-list .ledger-card .ledger-items')?.textContent || ''));
  const headline = await card.locator('h4').innerText(); assert.match(headline, /^진단 다시 실행 — 결과 확정 1 · 미확인 0 · 진행 중 1 \/ 2명 · 해결 확인 0 · 다음: 실패·미확인·미전달만 다시 고르기 \(고르기만 · 자동 재전송 없음\)$/, headline);
  assert.equal(await card.locator('.ev-full').first().isVisible(), false, 'the long evidence is folded'); assert.match(await card.locator('.ledger-items > p').last().innerText(), /^A3 · student-03 — \[미전달·만료·대상 변경\] 기기 연결 없음 · 전달되지 않음$/);
  await card.locator('.ledger-full').click(); assert.equal(await card.locator('.ledger-full').getAttribute('aria-expanded'), 'true'); assert.equal(await card.locator('.ev-full').first().isVisible(), true); assert.equal(await card.locator('.ledger-extra').isVisible(), true);
  await page.evaluate(() => document.getElementById('ops-results').scrollIntoView()); await page.screenshot({ path: path.join(out, 'g1-result-card-1280x720.png') });
  const sent = commands(); await card.locator('.ledger-again').click(); await page.locator('#ops-selection').filter({ hasText: /선택 1 \/ 전체 24석 .* — 선택: A3$/ }).waitFor(); assert.equal(commands(), sent, 'failure-only re-selection sent nothing');
  console.log('PASS result card: action + final/unknown/moving + next step first; short lines until expanded; failure-only re-selection only ticks boxes');

  // ── 6. wrap-up: from what the Service said; off is unavailable, not done ──
  const steps = await page.locator('#ops-wrap-steps > li').evaluateAll((l) => l.map((x) => ({ cls: x.className, text: x.innerText })));
  assert.equal(steps.length, 4); assert.match(steps[0].text, /1 기록 회수[\s\S]*아직 시작 전/); assert.equal(steps[0].cls, 'now');
  for (const i of [1, 2, 3]) assert.equal(steps[i].cls, 'off', 'reports and delivery are off in this class: ' + steps[i].text);
  assert.match(steps[1].text, /보고서 기능이 꺼져 있어 초안을 만들지 않습니다/); assert.match(steps[3].text, /발송 절차가 꺼져 있습니다/); assert.match(await page.locator('#ops-wrap-note').innerText(), /종류별 회수 기록\(\/3\)을 보고서 입력으로 쓰는 경로/);
  await page.locator('nav.flow a[href="#ops-wrap-title"]').click(); await page.screenshot({ path: path.join(out, 'g1-wrapup-1280x720.png') }); results.wrap_steps = steps;
  console.log('PASS wrap-up: four steps from the Service state; switched-off steps say unavailable and why; not-yet-connected paths named');

  // ── states after disconnecting ──
  await page.locator('#disconnect').click(); assert.equal(await page.locator('#ops-seats .ops-seat').count(), 0); assert.equal(await page.locator('#ops-table').isHidden(), true); assert.equal(await page.locator('#ops-wrap').isHidden(), true); assert.equal(await page.locator('#nav-help').innerText(), '');
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ at: new Date().toISOString(), synthetic: true, seats: 24, ...results }, null, 2) + '\n');
  console.log('PASS states: disconnecting empties the table, the wrap-up and the help badge\n7 G1 layout/behaviour checks passed → ' + out);
} finally { if (browser) await browser.close(); await new Promise((r) => server.close(r)); globalThis.fetch = realFetch; local.close(); }
