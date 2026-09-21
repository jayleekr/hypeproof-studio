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
  await row('A2').getByRole('button', { name: '근거·조치' }).click(); await page.locator('#ops-question').fill('어디까지 확인했나요?'); await row('A4').getByLabel('선택').check();
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
  await page.route(/\/classroom\/shares(\?|$)/, async (route) => {
    if (shareMode === 'fail') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '[합성] 공유 기록 일시 장애' }) });
    if (shareMode === 'cap') { const r = await route.fetch(), j = await r.json(); j.limit = j.shares.length; return route.fulfill({ response: r, json: j }); }
    return route.continue();
  });
  await page.locator('#refresh').click(); await page.locator('#ops-help-state').filter({ hasText: '알 수 없습니다' }).waitFor();
  assert.match(await helpState(), /공유 기록을 불러오지 못해 도움 요청이 있는지 알 수 없습니다 \(요청 없음이 아님\)/); assert.doesNotMatch(await helpState(), /도움 요청이 없습니다/);
  assert.equal(await help.count(), 0); assert.match(await page.locator('#ops-summary').innerText(), /도움 요청 확인 불가/); assert.doesNotMatch(await page.locator('#ops-summary').innerText(), /도움 요청 0/);
  assert.equal((await page.locator('#ops-select-help').innerText()).trim(), '도움 요청 학생 선택 (확인 불가)'); assert.equal(await page.locator('#ops-select-help').isDisabled(), true, 'no help selection from an unknown read');
  assert.match(await row('A2').innerText(), /도움 요청 여부 확인 불가/);
  assert.equal(await page.locator('#ops-seats .ops-seat').count(), 10, 'the roster stays'); assert.match(await page.locator('#ops-summary').innerText(), /기술 장애 확인 4/); assert.equal(await row('A4').getByLabel('선택').isChecked(), true, 'the selection stays');
  assert.equal(await page.locator('#detail').isVisible(), true, 'the open record is not closed by a failed list read'); assert.equal(await page.locator('#feedback-text').inputValue(), '작성 중인 답'); assert.match(await page.locator('#detail-status').innerText(), /다음 갱신에서 확인합니다/);
  shareMode = 'cap'; await page.locator('#refresh').click(); await page.locator('#ops-help-state').filter({ hasText: '한도에 닿아' }).waitFor();
  assert.match(await helpState(), /응답할 도움 요청 2건[\s\S]*공유 기록이 \d+건 한도에 닿아 더 오래된 요청은 확인하지 못했습니다/); assert.equal((await page.locator('#ops-select-help').innerText()).trim(), '도움 요청 학생 선택 (2 이상)'); assert.match(await page.locator('#ops-summary').innerText(), /도움 요청 2 이상/);
  shareMode = 'ok'; await page.locator('#refresh').click(); await page.locator('#ops-select-help').filter({ hasText: '(2)' }).waitFor();
  assert.match(await helpState(), /^응답할 도움 요청 2건 · 학생 2명/); assert.equal(await help.count(), 2); assert.match(await page.locator('#ops-summary').innerText(), /도움 요청 2/);
  assert.equal(await page.locator('#detail-status').innerText(), '', 'the stale-list note leaves once the list is read'); assert.equal(await page.locator('#feedback-text').inputValue(), '작성 중인 답'); assert.equal(await row('A4').getByLabel('선택').isChecked(), true);
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
  assert.equal(await page.locator('#ops-question').inputValue(), '', 'the new holder of the seat never inherits the question'); assert.match(await page.locator('#ops-detail-status').innerText(), /학생 또는 수업이 바뀌어 쓰던 질문을 이 학생에게 옮기지 않았습니다/);
  await page.keyboard.press('Escape'); await row('A2').getByRole('button', { name: '근거·조치' }).click(); assert.equal(await page.locator('#ops-question').inputValue(), '', 'reopening does not bring it back either');
  { const c = (await local.pair('A2', 3, 11)).conn.json; assert.equal((await local.sync(c.credential, [local.event(1, 'activation', { stage: 'runtime_ready' })], 11)).status, 200); }
  await page.locator('#refresh').click(); await page.waitForFunction(() => opsData?.seats.find((x) => x.seat_id === 'A2')?.connection?.state === 'active'); await page.keyboard.press('Escape'); await row('A2').getByRole('button', { name: '근거·조치' }).click(); await page.getByRole('button', { name: '질문 보내기' }).and(page.locator(':enabled')).waitFor();
  assert.equal(await page.locator('#ops-question').inputValue(), ''); await page.getByRole('button', { name: '질문 보내기' }).click(); assert.match(await page.locator('#ops-detail-status').innerText(), /보낼 질문을 입력하세요/);
  // Send-time check, with the page's own state made stale on purpose (injected here; a normal refresh redraws the form first).
  await page.locator('#ops-question').fill('[합성] L에게 쓰는 질문'); await page.evaluate(() => { opsData.seats.find((x) => x.seat_id === 'A2').student_id = 'student-x'; });
  await page.getByRole('button', { name: '질문 보내기' }).click(); assert.match(await page.locator('#ops-detail-status').innerText(), /학생 또는 수업이 바뀌어 이 질문을 보내지 않았습니다/); assert.equal(commands(), sentBefore, 'nothing was sent');
  await page.locator('#refresh').click(); await page.locator('#ops-detail-title').filter({ hasText: 'A2 · student-l' }).waitFor(); assert.equal(await page.locator('#ops-question').inputValue(), '[합성] L에게 쓰는 질문', 'student-l keeps their own draft');
  assert.equal((await local.configure(roster({ A10: 'student-k' }), 3, flags)).status, 200, 'student-b is back on A2');
  await page.locator('#refresh').click(); await page.locator('#ops-detail-title').filter({ hasText: 'A2 · student-b' }).waitFor(); assert.equal(await page.locator('#ops-question').inputValue(), '어디까지 확인했나요?', 'the same learner on the same seat in the same class gets their own draft back');
  assert.equal(commands(), sentBefore);

  // The learner withdraws: the request leaves the queue, the count and the open record.
  assert.equal((await local.request('/v1/classroom/shares/' + b2.id, 'DELETE', undefined, b2.t)).status, 200); await page.locator('#refresh').click();
  await page.locator('#ops-help-state').filter({ hasText: '응답할 도움 요청 1건' }).waitFor(); assert.equal(await page.locator('#detail').isHidden(), true); await page.locator('#ops-select-help').filter({ hasText: '(1)' }).waitFor();
  assert.doesNotMatch(await page.locator('#ops-summary').innerText(), /도움 요청 2/);
  // Another class opens: this class's requests are not the current queue, and nothing from the old roster is shown as current.
  await startSession(local.env.HPS_KV, local.cohort, { session_id: 'the-next-class', profile_id: local.profile, starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString() });
  await page.locator('#refresh').click(); await page.locator('#ops-state').filter({ hasText: '운영 명단이 아직 없습니다' }).waitFor();
  assert.equal(await page.locator('#ops-seats .ops-seat').count(), 0); assert.equal(await page.locator('#ops-summary').isHidden(), true); assert.equal(await help.count(), 0);
  assert.match(await page.locator('#ops-help-state').innerText(), /지금 응답할 도움 요청이 없습니다/); assert.match(await page.locator('#shares').innerText(), /student-d · 도움 요청\s*검토 중 · 다른 수업의 기록/);
  assert.deepEqual(errors, []);
  console.log('PASS classroom ops help: auth failure and missing permission named in the class panel, roster loads on connect and never says "not connected" under "connected", unknown seats not counted as fine; help queue from metadata only (open = this class, not answered/resolved/withdrawn/expired), help and fault selection separate with counts, silence not red; first action = Service recommendation (re-issue link to /authoring for a lesson class, pairing first when offline, none for a shared outage); help under "2 수업 진행" keeps detail, draft question (also across closing the detail), selection and share feedback draft; a failed share read is unknown (never no-help) while roster, selection and the open record stay, a capped read is a lower bound, the next read recovers; an unsent question is bound to class run + student + seat (kept across unrelated roster edits, never shown to or sent for the next holder of the seat); withdrawal and a new class leave the queue');
} finally { if (browser) await browser.close(); await new Promise((r) => server.close(r)); globalThis.fetch = realFetch; local.close(); }
