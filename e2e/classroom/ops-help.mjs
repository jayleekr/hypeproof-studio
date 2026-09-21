// Instructor UI pass 2 (#751) — Chalk /manage in a real browser: the four operating defects found in the first UI review
// (remote-classroom-evidence/management-20260921/instructor-ui-review/codex/review.json):
//   1  connected at the top while the class panel said "not connected" until a separate button was pressed;
//   2  "select students who need help" picked technical faults only and left out the learner who had asked for help;
//   3  a rejected token named "re-issue" as the first action but made "run diagnostics again" the primary button;
//   4  help during the class was only reachable under "3 wrap-up".
// Real here: the Chalk page and its script in Chromium, the Service router + SQLite, shares made through the learner routes.
// Integration (#751): also a failed share read and a capped one (the browser's request answered by page.route), and a seat
// handed to another learner while a question is unsent (roster through the Service API; one stale-state injection is named).
// Controlled here: device reports (synced as the app would), one seat's signal age and one share's expiry (set in SQLite).
// Synthetic accounts. Not evidence about a real Studio window, Windows, a school network, staging or production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { localOps } from '../../worker/test/harness/classroom-ops.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.join(repo, 'e2e/test-results/classroom-ops-help'); mkdirSync(out, { recursive: true });
const local = await localOps(), { default: chalk } = await import('../../chalk/src/index.ts'), { setRoster, startSession } = await import('../../worker/src/lib/kv.ts');
const realFetch = globalThis.fetch; globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? local.app.fetch(new Request(url, init), local.env, { waitUntil() {} }) : realFetch(url, init);
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  const ids = 'abcdefghij'.split(''), seats = ids.map((x, i) => ({ seat_id: 'A' + (i + 1), student_id: 'student-' + x }));
  await setRoster(local.env.HPS_KV, local.cohort, seats.map((s) => s.student_id)); await local.freeze();
  assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true } })).status, 201);
  // A1 token rejected · A2 fine · A3 never connected · A4 connected, then quiet · A5–A7 the same provider outage (a shared incident) · A8–A10 fine.
  const plan = { A1: [local.event(1, 'activation', { stage: 'token_rejected', reason: 'auth_signature', http_status: 401 }), local.event(2, 'error', { class: 'auth_signature', code: 'http_401', request_id: 'req-help-0001', blocking: true })] };
  for (const s of ['A5', 'A6', 'A7']) plan[s] = [local.event(1, 'activation', { stage: 'runtime_ready' }), local.event(2, 'error', { class: 'provider_5xx', code: 'http_529', request_id: 'req-help-' + s, blocking: true })];
  let n = 0; for (const s of seats) { n++; if (s.seat_id === 'A3') continue; const c = (await local.pair(s.seat_id, 1, n)).conn.json; assert.equal((await local.sync(c.credential, plan[s.seat_id] ?? [local.event(1, 'activation', { stage: 'runtime_ready' })], n)).status, 200); }
  local.db.prepare("UPDATE ops_latest_state SET last_received_at=? WHERE seat_id='A4'").run(Date.now() - 25 * 60000);
  // Shares, addressed to the instructor that connects below. Only metadata decides what is open; the content is never read here.
  const recipient = 'teacher-help', teacher = await local.teacher(recipient);
  const share = async (student, kind = 'help') => { const t = await local.student(student), id = crypto.randomUUID(); const r = await local.request('/v1/classroom/shares', 'POST', { id, recipient_id: recipient, kind, consent: true, duration_minutes: 480, content: { prompt: '[합성] ' + student + ' 질문' } }, t); assert.equal(r.status, 201, r.raw); return { id, t, revision: r.json.revision }; };
  const answer = (s, status = 'answered') => local.request(`/admin/cohorts/${local.cohort}/classroom/shares/${s.id}`, 'PUT', { expected_revision: s.revision, status, feedback: '[합성] 답변', next_action: '[합성] 다음' }, teacher);
  const b2 = await share('student-b'), d4 = await share('student-d'); assert.equal((await answer(d4, 'reviewing')).status, 200);
  const h8 = await share('student-h'), a8 = await answer(h8); assert.equal(a8.status, 200);
  const i9 = await share('student-i'), a9 = await answer(i9); assert.equal((await local.request(`/v1/classroom/shares/${i9.id}/confirm`, 'POST', { expected_revision: a9.json.revision }, i9.t)).status, 200);
  const j10 = await share('student-j'); assert.equal((await local.request('/v1/classroom/shares/' + j10.id, 'DELETE', undefined, j10.t)).status, 200);
  const jx = await share('student-j'); local.db.prepare('UPDATE classroom_shares SET expires_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 60, jx.id);
  const jo = await share('student-j'); local.db.prepare("UPDATE classroom_shares SET session_id='an-earlier-class' WHERE id=?").run(jo.id);
  await share('student-e', 'submission');

  browser = await chromium.launch(); const origin = 'http://127.0.0.1:' + server.address().port, page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const connect = async (token) => { await page.locator('#conn-edit').isVisible() && await page.locator('#conn-edit').click(); await page.locator('#token').fill(token); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill('student-'); await page.locator('#connect-go').click(); };
  const opsState = () => page.locator('#ops-state').innerText(), row = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`), primaries = () => page.locator('.primary:visible');
  await page.goto(origin + '/manage');

  // ── 1. Connection and the roster tell the same story ──
  await connect('not-a-token'); await page.locator('#status').filter({ hasText: '인증이 거부' }).waitFor();
  assert.match(await opsState(), /강사 인증이 거부돼 이번 수업 명단을 불러오지 않았습니다/); assert.equal(await page.locator('#ops-seats .ops-seat').count(), 0); assert.equal(await page.locator('#ops-summary').isHidden(), true);
  await connect(await local.teacher('no-ops', null)); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor();
  await page.locator('#ops-state').filter({ hasText: '원격 운영 권한이 없습니다' }).waitFor(); assert.equal(await page.locator('#ops-seats .ops-seat').count(), 0, 'the roster is read with the token\'s own permission');
  await page.locator('#disconnect').click(); await connect(teacher);
  await page.locator('#status').filter({ hasText: '연결됨' }).waitFor(); assert.doesNotMatch(await opsState(), /연결하지 않았습니다/, 'connected at the top is never "not connected" below');
  await row('A10').waitFor(); assert.match(await opsState(), /명단 10명 중 앱 준비 완료/, 'the roster loaded without pressing anything');
  const chips = await page.locator('#ops-summary').innerText();
  assert.match(chips, /기술 장애 확인 4/); assert.match(chips, /도움 요청 2/); assert.match(chips, /확인 불가 2/); assert.match(chips, /정상 4/, 'connected is not "everyone fine": A3 (never connected) and A4 (quiet) are unknown');
  for (const s of ['A3', 'A4']) assert.equal(await row(s).locator('p.blocked').count(), 0, s + ': silence is never red');

  // ── 2. Learning help and technical problems are different targets ──
  const help = page.locator('#ops-help-list li');
  assert.equal(await help.count(), 2); assert.match(await help.nth(0).innerText() + await help.nth(1).innerText(), /A2 · student-b[\s\S]*A4 · student-d|A4 · student-d[\s\S]*A2 · student-b/);
  for (const gone of ['student-h', 'student-i', 'student-j', 'student-e']) assert.doesNotMatch(await page.locator('#ops-help-list').innerText(), new RegExp(gone), gone + ' is not an open help request');
  assert.match(await page.locator('#ops-help-state').innerText(), /응답할 도움 요청 2건 · 학생 2명 · 답변함·학생 확인 대기 1건은 뺐습니다/);
  assert.match(await page.locator('#shares').innerText(), /student-j · 도움 요청\s*접수 · 다른 수업의 기록/, 'another class\'s request stays in the records, marked, and out of the queue');
  assert.equal((await page.locator('#ops-select-help').innerText()).trim(), '도움 요청 학생 선택 (2)'); assert.equal((await page.locator('#ops-select-fault').innerText()).trim(), '기술 문제 좌석 선택 (장애 4 · 주의 0)');
  await page.locator('#ops-select-help').click(); assert.match(await page.locator('#ops-selection').innerText(), /선택 2 \/ 전체 10석 .* — 선택: A2, A4$/, 'the learner who asked is selected; the faults are not');
  await page.locator('#ops-select-fault').click(); assert.match(await page.locator('#ops-selection').innerText(), /— 선택: A1, A5, A6, A7$/);
  assert.equal((await primaries().innerText()).trim(), '기술 문제 좌석 선택 (장애 4 · 주의 0)', 'one primary on the list');

  // ── 3. The Service's first action is the one primary ──
  await row('A1').getByRole('button', { name: '근거·조치' }).click();
  assert.equal(await primaries().count(), 1, 'one primary CTA on the screen'); const first = page.locator('#ops-actions .primary');
  assert.equal(await first.evaluate((e) => e.tagName), 'A'); assert.equal(await first.getAttribute('href'), '/authoring', 'a lesson class re-issues on the lesson code page'); assert.match(await first.innerText(), new RegExp('강의 ' + local.lesson.version.replaceAll('.', '\\.') + ' 유지'));
  assert.equal(await first.getAttribute('target'), '_blank', 'opening it keeps this page');
  assert.deepEqual(await first.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color, e.getBoundingClientRect().height >= 44]), ['rgb(213, 242, 121)', 'rgb(21, 29, 25)', true], 'the link looks like the one primary button (it was dark-on-dark before the style covered links)');
  assert.equal(await page.getByRole('button', { name: '진단 다시 실행' }).evaluate((e) => e.classList.contains('primary')), false, 'diagnostics is not the first step for a rejected token');
  assert.match(await page.locator('#ops-recovery').innerText(), /먼저 할 조치: 수업 참여 코드 발급 화면에서 재발급/);
  assert.equal(await page.locator('#ops-evidence a[href="/authoring"]').count(), 1); assert.equal(await page.locator('#ops-evidence a[href="/issuer"]').count(), 0);
  await row('A3').getByRole('button', { name: '근거·조치' }).click();
  assert.equal((await page.locator('#ops-actions .primary').innerText()).trim(), '이 좌석의 연결 코드 발급 (10분 · 1회)'); assert.equal(await page.locator('#ops-actions > .group').first().locator('h3').innerText(), '기기 연결', 'pairing comes first when nothing can be sent');
  await row('A6').getByRole('button', { name: '근거·조치' }).click();
  assert.equal(await page.locator('#ops-detail .primary').count(), 0, 'a shared outage has no per-PC primary'); assert.match(await page.locator('#ops-actions').innerText(), /PC 초기화는 이 원인을 해결하지 못합니다\. 이 좌석에서 먼저 할 개별 조치는 없습니다/);
  assert.match(await page.locator('#ops-incidents').innerText(), /영향 3명/);

  // ── 4. Help during the class is under "2 수업 진행", and going there keeps the page's state ──
  const running = page.locator('nav.flow .flow-step').nth(1); assert.match(await running.innerText(), /2 수업 진행[\s\S]*운영 보드[\s\S]*도움 요청 응대/); assert.doesNotMatch(await page.locator('nav.flow .flow-step').nth(2).innerText(), /도움/);
  await row('A2').getByRole('button', { name: '근거·조치' }).click(); await page.locator('#ops-question').fill('어디까지 확인했나요?'); await page.locator('#ops-checkpoint-note').fill('[합성] B 확인 메모'); await row('A4').getByLabel('선택').check();
  await running.getByRole('link', { name: '도움 요청 응대' }).click(); assert.ok(page.url().endsWith('#ops-help-title'));
  assert.equal(await page.locator('#ops-detail').isVisible(), true); assert.equal(await page.locator('#ops-question').inputValue(), '어디까지 확인했나요?'); assert.equal(await row('A4').getByLabel('선택').isChecked(), true); assert.match(await page.locator('#status').innerText(), /연결됨/);
  await page.keyboard.press('Escape'); await row('A2').getByRole('button', { name: '근거·조치' }).click(); assert.equal(await page.locator('#ops-question').inputValue(), '어디까지 확인했나요?', 'closing the detail (a phone must, to reach the flow bar) keeps the unsent question');
  await help.filter({ hasText: 'student-b' }).getByRole('button', { name: '요청 열기' }).click(); await page.locator('#detail').waitFor(); assert.match(await page.locator('#content').innerText(), /student-b 질문/);
  await page.locator('#feedback-text').fill('작성 중인 답'); await page.locator('#refresh').click(); await page.waitForTimeout(500);
  assert.equal(await page.locator('#feedback-text').inputValue(), '작성 중인 답'); assert.equal(await page.locator('#ops-question').inputValue(), '어디까지 확인했나요?'); assert.equal(await row('A4').getByLabel('선택').isChecked(), true, 'a refresh keeps the selection');
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at 390'); await page.setViewportSize({ width: 1280, height: 900 });
  // ── 5. A failed share read is "unknown", never "no help": board, selection, open record and typed feedback stay; the next read recovers ──
  const helpState = () => page.locator('#ops-help-state').innerText(), commands = () => local.db.prepare("SELECT COUNT(*) AS n FROM ops_commands WHERE action='send_question'").get().n;
  let shareMode = 'fail';
  const helpRead = (u) => u.searchParams.get('kind') === 'help';
  await page.route(/\/classroom\/shares(\?|$)/, async (route) => {
    const u = new URL(route.request().url());
    if (shareMode === 'fail') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '[합성] 공유 기록 일시 장애' }) });
    // The Service says older rows exist; the next page fails. The general page no longer carries the open record.
    if (shareMode === 'cap') { if (u.searchParams.get('before')) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '[합성] 다음 페이지 장애' }) }); const r = await route.fetch(), j = await r.json(); j.has_more = true; j.next_cursor = '1:synthetic-next'; if (!helpRead(u)) j.shares = j.shares.filter((x) => x.id !== b2.id); return route.fulfill({ response: r, json: j }); }
    // An older Service: no completeness or counts, and a page in which no help request of this class is visible.
    if (shareMode === 'legacy') { const r = await route.fetch(), j = await r.json(); delete j.has_more; delete j.next_cursor; delete j.counts; if (helpRead(u)) j.shares = []; return route.fulfill({ response: r, json: j }); }
    return route.continue();
  });
  await page.locator('#refresh').click(); await page.locator('#ops-help-state').filter({ hasText: '알 수 없습니다' }).waitFor();
  assert.match(await helpState(), /공유 기록을 불러오지 못해 도움 요청이 있는지 알 수 없습니다 \(요청 없음이 아님\)/); assert.doesNotMatch(await helpState(), /도움 요청이 없습니다/);
  assert.equal(await help.count(), 0); assert.match(await page.locator('#ops-summary').innerText(), /도움 요청 확인 불가/); assert.doesNotMatch(await page.locator('#ops-summary').innerText(), /도움 요청 0/);
  assert.equal((await page.locator('#ops-select-help').innerText()).trim(), '도움 요청 학생 선택 (확인 불가)'); assert.equal(await page.locator('#ops-select-help').isDisabled(), true, 'no help selection from an unknown read');
  assert.match(await row('A2').innerText(), /도움 요청 여부 확인 불가/);
  assert.equal(await page.locator('#ops-seats .ops-seat').count(), 10, 'the roster stays'); assert.match(await page.locator('#ops-summary').innerText(), /기술 장애 확인 4/); assert.equal(await row('A4').getByLabel('선택').isChecked(), true, 'the selection stays');
  assert.equal(await page.locator('#detail').isVisible(), true, 'the open record is not closed by a failed list read'); assert.equal(await page.locator('#feedback-text').inputValue(), '작성 중인 답'); assert.match(await page.locator('#detail-status').innerText(), /다음 갱신에서 확인합니다/);
  // Partial: the Service's counts keep the number exact, the student count is a lower bound, and the instructor can read on.
  const helpUrls = []; page.on('request', (r) => { const u = new URL(r.url()); if (/\/classroom\/shares$/.test(u.pathname) && u.searchParams.get('kind') === 'help') helpUrls.push(u.searchParams.get('status')); });
  shareMode = 'cap'; await page.locator('#refresh').click(); await page.locator('#ops-help-state').filter({ hasText: '최근' }).waitFor();
  assert.match(await helpState(), /^응답할 도움 요청 2건 · 학생 2명 이상 · 답변함·학생 확인 대기 1건은 뺐습니다[\s\S]*이번 수업 도움 요청 중 최근 2건만 불러왔습니다/); assert.equal((await page.locator('#ops-select-help').innerText()).trim(), '도움 요청 학생 선택 (2 이상)'); assert.match(await page.locator('#ops-summary').innerText(), /도움 요청 2 이상/);
  assert.equal(await page.locator('#detail').isVisible(), true, 'absence from one partial page is not withdrawal'); assert.equal(await page.locator('#feedback-text').inputValue(), '작성 중인 답');
  assert.match(await page.locator('#shares').innerText(), /더 오래된 공유 기록이 있을 수 있습니다 \(목록에 없다고 철회된 것이 아닙니다\)/);
  assert.ok(helpUrls.length && helpUrls.every((x) => x === 'open'), 'the help read lists only requests awaiting the instructor (answered ones are counted, not paged through)');
  // The next page fails: the whole help read is unknown again, not the first page presented as complete.
  await help.getByRole('button', { name: '더 오래된 도움 요청 불러오기' }).click(); await page.locator('#ops-help-state').filter({ hasText: '알 수 없습니다' }).waitFor(); assert.equal(await help.count(), 0);
  assert.equal(await page.locator('#detail').isVisible(), true); assert.equal(await page.locator('#feedback-text').inputValue(), '작성 중인 답');
  // An older Service with no counts and none visible: never "no requests", with a next action.
  shareMode = 'legacy'; await page.locator('#refresh').click(); await page.locator('#ops-help-state').filter({ hasText: '불러온 범위' }).waitFor();
  assert.match(await helpState(), /^불러온 범위에는 응답할 도움 요청이 없습니다 · 더 오래된 요청은 확인하지 못했습니다 \(요청 없음이 아님\)/); assert.doesNotMatch(await helpState(), /지금 응답할 도움 요청이 없습니다/);
  assert.equal(await help.getByRole('button', { name: '다시 확인' }).count(), 1); assert.match(await page.locator('#ops-summary').innerText(), /도움 요청 0 이상/);
  shareMode = 'ok'; await help.getByRole('button', { name: '다시 확인' }).click(); await page.locator('#ops-select-help').filter({ hasText: '(2)' }).waitFor();
  assert.match(await helpState(), /^응답할 도움 요청 2건 · 학생 2명 ·/); assert.doesNotMatch(await helpState(), /최근|불러온 범위/, 'the partial note leaves with a complete read'); assert.equal(await help.count(), 2); assert.match(await page.locator('#ops-summary').innerText(), /도움 요청 2/);
  assert.equal(await page.locator('#detail-status').innerText(), '', 'the stale-list note leaves once the list is read'); assert.equal(await page.locator('#feedback-text').inputValue(), '작성 중인 답'); assert.equal(await row('A4').getByLabel('선택').isChecked(), true);
  await page.locator('#shares').filter({ hasNotText: '더 오래된 공유 기록' }).waitFor({ timeout: 15000 }); // a 10-second refresh already under way may have read the list in the previous mode
  await page.unroute(/\/classroom\/shares(\?|$)/);

  // ── 6. An unsent question belongs to class run + student + seat ──
  await setRoster(local.env.HPS_KV, local.cohort, [...seats.map((s) => s.student_id), 'student-k', 'student-l']);
  const flags = { flags: { ops_observe: true, ops_commands: true, ops_collect: true } }, sentBefore = commands();
  const roster = (over) => seats.map((s) => ({ ...s, student_id: over[s.seat_id] ?? s.student_id }));
  assert.equal((await local.configure(roster({ A10: 'student-k' }), 1, flags)).status, 200, 'an unrelated seat changes hands');
  await page.locator('#refresh').click(); await row('A10').filter({ hasText: 'student-k' }).waitFor();
  assert.match(await page.locator('#ops-detail-title').innerText(), /A2 · student-b/); assert.equal(await page.locator('#ops-question').inputValue(), '어디까지 확인했나요?', 'an unrelated roster edit keeps the draft');
  assert.equal((await local.configure(roster({ A10: 'student-k', A2: 'student-l' }), 2, flags)).status, 200, 'A2 is handed to another learner');
  await page.locator('#refresh').click(); await page.locator('#ops-detail-title').filter({ hasText: 'A2 · student-l' }).waitFor();
  assert.equal(await page.locator('#ops-question').inputValue(), '', 'the new holder of the seat never inherits the question'); assert.equal(await page.locator('#ops-checkpoint-note').inputValue(), '', 'nor the checkpoint note'); assert.match(await page.locator('#ops-detail-status').innerText(), /학생 또는 수업이 바뀌어 쓰던 질문을 이 학생에게 옮기지 않았습니다/);
  await page.keyboard.press('Escape'); await row('A2').getByRole('button', { name: '근거·조치' }).click(); assert.equal(await page.locator('#ops-question').inputValue(), '', 'reopening does not bring it back either');
  { const c = (await local.pair('A2', 3, 11)).conn.json; assert.equal((await local.sync(c.credential, [local.event(1, 'activation', { stage: 'runtime_ready' })], 11)).status, 200); }
  await page.locator('#refresh').click(); await page.waitForFunction(() => opsData?.seats.find((x) => x.seat_id === 'A2')?.connection?.state === 'active'); assert.equal(await page.getByRole('button', { name: '질문 보내기', exact: true }).isEnabled(), true, 'LIVE_ACTIONS: newly connected same student enables send without closing the detail');
  assert.equal(await page.locator('#ops-question').inputValue(), ''); await page.getByRole('button', { name: '질문 보내기' }).click(); assert.match(await page.locator('#ops-detail-status').innerText(), /보낼 질문을 입력하세요/);
  // Send-time check, with the page's own state made stale on purpose (injected here; a normal refresh redraws the form first).
  await page.locator('#ops-question').fill('[합성] L에게 쓰는 질문'); await page.evaluate(() => { opsData.seats.find((x) => x.seat_id === 'A2').student_id = 'student-x'; });
  await page.getByRole('button', { name: '질문 보내기' }).click(); assert.match(await page.locator('#ops-detail-status').innerText(), /학생 또는 수업이 바뀌어 이 질문을 보내지 않았습니다/); assert.equal(commands(), sentBefore, 'nothing was sent');
  await page.locator('#refresh').click(); await page.locator('#ops-detail-title').filter({ hasText: 'A2 · student-l' }).waitFor(); assert.equal(await page.locator('#ops-question').inputValue(), '[합성] L에게 쓰는 질문', 'student-l keeps their own draft');
  assert.equal((await local.configure(roster({ A10: 'student-k' }), 3, flags)).status, 200, 'student-b is back on A2');
  await page.locator('#refresh').click(); await page.locator('#ops-detail-title').filter({ hasText: 'A2 · student-b' }).waitFor(); assert.equal(await page.locator('#ops-question').inputValue(), '어디까지 확인했나요?', 'the same learner on the same seat in the same class gets their own draft back'); assert.equal(await page.locator('#ops-checkpoint-note').inputValue(), '[합성] B 확인 메모');
  assert.equal(commands(), sentBefore);

  // ── 7. The open detail follows live changes without reopening: connection (both ways), cause, flag/permission ──
  // Same learner/run/seat throughout (student-b on A2); the unsent question, the focus and the list selection stay.
  // tick = the page's own 10-second refresh (a click on 갱신 would move the focus this block checks).
  const tick = () => page.evaluate(() => refresh()), q = page.locator('#ops-question'), send = () => page.getByRole('button', { name: '질문 보내기', exact: true }), actionsPrimary = () => page.locator('#ops-actions .primary').innerText();
  const seatA2 = () => page.evaluate(() => { const s = opsData.seats.find((x) => x.seat_id === 'A2'); return { state: s.connection?.state ?? null, rec: s.recommended?.action ?? null }; });
  if (!(await row('A4').getByLabel('선택').isChecked())) await row('A4').getByLabel('선택').check(); // roster edits above clear a selection by design
  assert.equal(await send().isDisabled(), true, 'student-b is not connected on A2 yet (the seat was handed back)'); await q.focus();
  const b2c = (await local.pair('A2', 4, 12)).conn.json; assert.equal((await local.sync(b2c.credential, [local.event(1, 'activation', { stage: 'runtime_ready' })], 12)).status, 200);
  await tick(); await send().and(page.locator(':enabled')).waitFor();
  assert.equal((await seatA2()).state, 'active'); assert.match(await page.locator('#ops-detail-title').innerText(), /A2 · student-b/); assert.equal(await q.inputValue(), '어디까지 확인했나요?', 'disconnected -> connected keeps the same learner\'s question');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ops-question', 'focus stays in the question'); assert.equal(await page.locator('#ops-checkpoint-note').inputValue(), '[합성] B 확인 메모', 'a same-owner live redraw keeps the checkpoint note'); assert.equal((await actionsPrimary()).trim(), '질문 보내기'); assert.match(await page.locator('#ops-actions').innerText(), /지금 할 수 있는 조치를 다시 표시했습니다/);
  assert.equal(await row('A4').getByLabel('선택').isChecked(), true, 'the list selection stays');
  await page.screenshot({ path: path.join(out, 'live-01-connected.png') });
  // A heartbeat changes nothing the actions depend on: the form is not rebuilt.
  await page.evaluate(() => { document.getElementById('ops-question').dataset.same = '1'; });
  assert.equal((await local.sync(b2c.credential, [local.event(2, 'activation', { stage: 'runtime_ready' })], 12)).status, 200); await tick(); await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => document.getElementById('ops-question').dataset.same), '1', 'a heartbeat does not rebuild the inputs');
  // The cause changes (a runtime fault): the Service's first action becomes the primary in place; the question stays.
  assert.equal((await local.sync(b2c.credential, [local.event(3, 'error', { class: 'sdk_not_ready', code: 'sdk_missing', request_id: 'req-live-0001', blocking: true })], 12)).status, 200);
  await tick(); await page.waitForFunction(() => opsData.seats.find((x) => x.seat_id === 'A2').recommended?.action === 'reset_runtime');
  await page.locator('#ops-actions .primary').filter({ hasText: 'AI 실행 환경 초기화' }).waitFor(); assert.equal(await page.locator('.primary:visible').count(), 1); assert.equal(await q.inputValue(), '어디까지 확인했나요?');
  assert.match(await page.locator('#ops-recovery').innerText(), /먼저 할 조치: AI 실행 환경 초기화/);
  await page.screenshot({ path: path.join(out, 'live-02-cause-changed.png') });
  // Coaching turned off for the class (flag): the question form leaves; turned back on, the same learner's question returns.
  const offFlags = { flags: { ops_observe: true, ops_commands: false, ops_collect: true } };
  assert.equal((await local.configure(roster({ A10: 'student-k' }), 4, offFlags)).status, 200);
  await tick(); await page.locator('#ops-actions').filter({ hasText: '학습 지원 권한이 없거나 이 수업에서 조치가 꺼져 있습니다' }).waitFor();
  assert.equal(await q.count(), 0); assert.equal(await send().count(), 0);
  await page.screenshot({ path: path.join(out, 'live-03-commands-off.png') });
  assert.equal((await local.configure(roster({ A10: 'student-k' }), 5, flags)).status, 200);
  await tick(); await send().and(page.locator(':enabled')).waitFor(); assert.equal(await q.inputValue(), '어디까지 확인했나요?', 'the same learner\'s question comes back with the flag'); assert.equal(await page.locator('#ops-checkpoint-note').inputValue(), '[합성] B 확인 메모');
  // The connection is revoked: send is disabled in place, the question is kept, and even a forced click dispatches nothing.
  const sentLive = commands(); assert.equal((await local.request(`${local.base}/grants/${b2c.grant_id}`, 'DELETE')).status, 200);
  await tick(); await send().and(page.locator(':disabled')).waitFor();
  assert.equal((await seatA2()).state, 'revoked'); assert.equal(await q.inputValue(), '어디까지 확인했나요?', 'connected -> disconnected keeps the question'); assert.equal((await actionsPrimary()).trim(), '이 좌석의 연결 코드 발급 (10분 · 1회)');
  await page.evaluate(() => { const b = [...document.querySelectorAll('#ops-actions button')].find((x) => x.textContent === '질문 보내기'); b.disabled = false; b.click(); });
  assert.match(await page.locator('#ops-detail-status').innerText(), /기기 연결이 끊겨 이 질문을 보내지 않았습니다/); assert.equal(commands(), sentLive, 'no command after revocation');
  await page.screenshot({ path: path.join(out, 'live-04-revoked.png') });
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at 390 with the live note'); await page.screenshot({ path: path.join(out, 'live-04-revoked-390.png'), fullPage: false }); await page.setViewportSize({ width: 1280, height: 900 });

  // ── 8. Unsent drafts belong to the signed-in instructor: disconnect / another instructor / reconnect never carry them over ──
  await page.locator('#disconnect').click(); await connect(await local.teacher('teacher-other')); await row('A2').waitFor();
  await row('A2').getByRole('button', { name: '근거·조치' }).click(); await page.locator('#ops-checkpoint-note').waitFor();
  assert.deepEqual([await page.locator('#ops-checkpoint-note').inputValue(), await page.locator('#ops-question').inputValue()], ['', ''], 'another instructor inherits neither the checkpoint note nor the question');
  await page.locator('#disconnect').click(); await connect(teacher); await row('A2').waitFor(); await row('A2').getByRole('button', { name: '근거·조치' }).click(); await page.locator('#ops-checkpoint-note').waitFor();
  assert.deepEqual([await page.locator('#ops-checkpoint-note').inputValue(), await page.locator('#ops-question').inputValue()], ['', ''], 'a new sign-in (even the same instructor) starts empty: drafts live only in that connection');
  await help.filter({ hasText: 'student-b' }).getByRole('button', { name: '요청 열기' }).click(); await page.locator('#detail').waitFor();

  // The learner withdraws: the request leaves the queue, the count and the open record.
  assert.equal((await local.request('/v1/classroom/shares/' + b2.id, 'DELETE', undefined, b2.t)).status, 200); await page.locator('#refresh').click();
  await page.locator('#ops-help-state').filter({ hasText: '응답할 도움 요청 1건' }).waitFor(); assert.equal(await page.locator('#detail').isHidden(), true); await page.locator('#ops-select-help').filter({ hasText: '(1)' }).waitFor();
  assert.doesNotMatch(await page.locator('#ops-summary').innerText(), /도움 요청 2/);
  // Another class opens: this class's requests are not the current queue, and nothing from the old roster is shown as current.
  await startSession(local.env.HPS_KV, local.cohort, { session_id: 'the-next-class', profile_id: local.profile, starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString() });
  await page.locator('#refresh').click(); await page.locator('#ops-state').filter({ hasText: '운영 명단이 아직 없습니다' }).waitFor();
  assert.equal(await page.locator('#ops-seats .ops-seat').count(), 0); assert.equal(await page.locator('#ops-summary').isHidden(), true); assert.equal(await help.count(), 0);
  assert.match(await page.locator('#ops-help-state').innerText(), /지금 응답할 도움 요청이 없습니다/); assert.match(await page.locator('#shares').innerText(), /student-d · 도움 요청\s*검토 중 · 다른 수업의 기록/);

  // ── 9. Every authorized request stays reachable (F2b), at a bounded cost per refresh ──
  // Rows are copied in SQLite from a real share of this cohort (metadata only; same recipient, profile, learner), for the class now open.
  const src = local.db.prepare('SELECT * FROM classroom_shares WHERE id=?').get(d4.id), cols = Object.keys(src), t0 = src.created_at + 10;
  const ins = local.db.prepare(`INSERT INTO classroom_shares(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`), put = (id, over) => ins.run(...cols.map((k) => ({ ...src, id, session_id: 'the-next-class', ...over })[k]));
  // 9a. The reproduced case at the real page size: one old open request of this class behind 1000 newer answered ones (1001 rows).
  put('old-open', { status: 'received', created_at: t0 }); for (let i = 0; i < 1000; i++) put('answered-' + String(i).padStart(4, '0'), { status: 'answered', created_at: t0 + 1 + i });
  await page.locator('#refresh').click(); await help.filter({ hasText: 'student-d' }).waitFor();
  assert.equal(await help.getByRole('button', { name: '요청 열기', exact: true }).count(), 1, 'the old open request is on the first read');
  assert.match(await helpState(), /^응답할 도움 요청 1건 · 학생 1명 · 답변함·학생 확인 대기 1000건은 뺐습니다/); assert.doesNotMatch(await helpState(), /최근|이 화면에 0건/);
  // 9b. Continuation beyond the window, with the Service's page bound set to 2 for help reads (the request is rewritten; the Service is real).
  const pageTwo = (route) => { const u = new URL(route.request().url()); if (u.searchParams.get('kind') !== 'help') return route.continue(); u.searchParams.set('limit', '2'); return route.continue({ url: u.toString() }); };
  await page.route(/\/classroom\/shares(\?|$)/, pageTwo);
  for (let i = 1; i <= 7; i++) put('open-' + i, { status: 'reviewing', created_at: t0 + 100 * i });
  const shown = () => page.evaluate(() => helpRows.map((r) => r.id).join(','));
  const settled = (cond, arg) => page.waitForFunction(cond, arg, { timeout: 25000 });
  const step = async (name) => { const before = await shown(); await help.getByRole('button', { name, exact: true }).click(); await settled((b) => !busy && helpRows.map((r) => r.id).join(',') !== b, before); return shown(); };
  await tick(); await settled(() => !busy && helpRows.length === 2 && helpState === 'partial');
  assert.equal(await shown(), 'open-7,open-6'); assert.match(await helpState(), /^응답할 도움 요청 8건 \(이 화면에 2건 표시\) · 학생 1명 이상[\s\S]*최근 2건만 불러왔습니다/);
  assert.equal(await step('더 오래된 도움 요청 불러오기'), 'open-7,open-6,open-5,open-4'); assert.equal(await step('더 오래된 도움 요청 불러오기'), 'open-7,open-6,open-5,open-4,open-3,open-2');
  assert.equal(await step('더 오래된 도움 요청 불러오기'), 'open-1,old-open', 'past the window it moves to the next cursor: the oldest open request is reached');
  assert.match(await helpState(), /더 오래된 도움 요청 2건을 보고 있습니다/); assert.equal(await help.getByRole('button', { name: '더 오래된 도움 요청 불러오기' }).count(), 0); assert.equal(await help.getByRole('button', { name: '최신 요청부터 보기' }).count(), 1);
  await help.nth(1).getByRole('button', { name: '요청 열기' }).click(); await settled(() => selected?.id === 'old-open'); await page.locator('#feedback-text').fill('[합성] 오래된 요청에 쓰는 답');
  // A refresh reads the window only (one page here), from its own cursor — not every page before it.
  const reads = []; const onReq = (r) => { const u = new URL(r.url()); if (/\/classroom\/shares$/.test(u.pathname) && u.searchParams.get('kind') === 'help') reads.push(u.searchParams.get('before')); }; page.on('request', onReq);
  await settled(() => !busy); reads.length = 0; await tick(); await settled(() => !busy); page.off('request', onReq);
  assert.equal(reads.length, 1, 'one help page per refresh in this window'); assert.equal(reads[0], await page.evaluate(() => helpWin.start));
  // A newer request arrives and one in the window is withdrawn (the learner's DELETE removes the row): the window keeps its place.
  put('open-8', { status: 'received', created_at: t0 + 5000 }); local.db.prepare("DELETE FROM classroom_shares WHERE id='open-1'").run();
  await tick(); await settled(() => !busy && helpRows.map((r) => r.id).join(',') === 'old-open'); assert.match(await helpState(), /^응답할 도움 요청 8건 \(이 화면에 1건 표시\)/);
  assert.equal(await page.locator('#detail').isVisible(), true, 'a window that does not start at the newest row never closes the open record'); assert.equal(await page.locator('#feedback-text').inputValue(), '[합성] 오래된 요청에 쓰는 답');
  // The window's page fails: unknown, the window and the typed answer stay; the next read returns to the same window, not the newest.
  let failHelp = true; await page.route(/\/classroom\/shares(\?|$)/, (route) => failHelp && new URL(route.request().url()).searchParams.get('kind') === 'help' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '[합성] 도움 요청 쪽 장애' }) }) : route.fallback());
  await tick(); await page.locator('#ops-help-state').filter({ hasText: '알 수 없습니다' }).waitFor(); assert.equal(await help.count(), 0); assert.ok(await page.evaluate(() => helpWin.start), 'the window is kept');
  assert.equal(await page.locator('#feedback-text').inputValue(), '[합성] 오래된 요청에 쓰는 답');
  failHelp = false; await tick(); await settled(() => !busy && helpState === 'partial'); assert.equal(await shown(), 'old-open', 'the same window, not the newest');
  assert.equal(await step('최신 요청부터 보기'), 'open-8,open-7'); assert.equal(await help.getByRole('button', { name: '최신 요청부터 보기' }).count(), 0);
  await page.unroute(/\/classroom\/shares(\?|$)/);
  // 9c. The general share list (all of this instructor's records, 100 per page, >1000 rows) is walked to its end the same way.
  const all = (await local.request(`/admin/cohorts/${local.cohort}/classroom/shares?limit=1`, 'GET', undefined, teacher)).json.counts.matched;
  const seen = new Set(), rowsNow = () => page.evaluate(() => shareRows.map((r) => r.id)), older = page.locator('#shares').getByRole('button', { name: '더 오래된 기록 불러오기' });
  await tick(); await settled(() => !busy && shareState === 'partial'); for (const id of await rowsNow()) seen.add(id);
  let clicks = 0; while (await older.count()) { const before = (await rowsNow()).join(); await older.click(); await settled((b) => !busy && shareRows.map((r) => r.id).join() !== b, before); for (const id of await rowsNow()) seen.add(id); assert.ok(++clicks < 30); }
  assert.equal(seen.size, all, 'every authorized record was reachable'); assert.ok(seen.has('old-open') && seen.has(jo.id)); assert.ok(all > 1000);
  assert.match(await page.locator('#shares').innerText(), /최신 기록은 이 목록 밖에 있습니다/); assert.ok((await rowsNow()).length <= 300, 'at most three pages rendered');
  await page.locator('#shares').getByRole('button', { name: '최신 기록부터 보기' }).click(); await settled(() => !busy && shareWin.start === null && shareRows.length === 100);
  assert.deepEqual(errors, []);
  console.log('PASS classroom ops help: auth failure and missing permission named in the class panel, roster loads on connect and never says "not connected" under "connected", unknown seats not counted as fine; help queue from metadata only (open = this class, not answered/resolved/withdrawn/expired), help and fault selection separate with counts, silence not red; first action = Service recommendation (re-issue link to /authoring for a lesson class, pairing first when offline, none for a shared outage); help under "2 수업 진행" keeps detail, draft question (also across closing the detail), selection and share feedback draft; a failed share read is unknown (never no-help) while roster, selection and the open record stay; a partial read keeps the Service-counted exact open count, a lower-bound student count and a next action, a failed next page is unknown, an older Service without counts never says no-help, absence from a partial page does not close the open record, the next read recovers; an unsent question is bound to class run + student + seat (kept across unrelated roster edits, never shown to or sent for the next holder of the seat); the open detail follows live connection (both ways), cause and flag changes without reopening, keeping the question, focus and selection, not rebuilding on a heartbeat, and dispatching nothing after revocation; withdrawal and a new class leave the queue; unsent question and checkpoint drafts never cross a disconnect or another instructor; open help is read with status=open, so an old open request behind 1000 answered ones is on the first read, and past the refresh window the cursor moves on until every open request and every share record is reached, a refresh reading only its window, keeping its place across new rows, withdrawal and a failed page');
} finally { if (browser) await browser.close(); await new Promise((r) => server.close(r)); globalThis.fetch = realFetch; local.close(); }
