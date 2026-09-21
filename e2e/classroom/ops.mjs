// Browser -> actual Chalk /manage -> actual Service ops routes + SQLite (synthetic accounts).
// AT-16/18 browser layer and DES checks for the operations panel. Not a real Studio app.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { localOps } from '../../worker/test/harness/classroom-ops.mjs';
const local = await localOps(); const { default: chalk } = await import('../../chalk/src/index.ts');
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? local.app.fetch(new Request(url, init), local.env, { waitUntil() {} }) : realFetch(url, init);
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: body.length ? body : undefined }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch { res.writeHead(500).end(); } });
let browser;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch(); const page = await browser.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin + '/manage'); await page.locator('#token').fill(local.teacherToken); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill('student-');
  await page.locator('#connect button').first().click(); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor();
  // No run yet: the panel says so and opens the roster form instead of showing an empty "all fine" board.
  await page.locator('#ops-check').click(); await page.locator('#ops-state').filter({ hasText: '운영 명단이 아직 없습니다' }).waitFor(); assert.equal(await page.locator('#ops-setup').getAttribute('open') !== null, true);
  await page.locator('#ops-roster').fill('A1,student-a\nA2,student-b\nA3,ghost'); await page.locator('#ops-observe').check(); await page.locator('#ops-commands').check(); await page.locator('#ops-collect').check(); await page.getByRole('button', { name: '명단·설정 저장' }).click();
  await page.locator('#ops-state').filter({ hasText: '코호트 명단에 없는 학생: ghost' }).waitFor(); assert.match(await page.locator('#ops-roster').inputValue(), /A3,ghost/, 'input is preserved on failure');
  await local.freeze(); await page.locator('#ops-course').fill(local.lesson.course_id); await page.locator('#ops-version').fill(local.lesson.version);
  await page.locator('#ops-roster').fill('A1,student-a\nA2,student-b\nA3,student-c'); await page.getByRole('button', { name: '명단·설정 저장' }).click(); await page.locator('#ops-seats .ops-seat').nth(2).waitFor();
  assert.equal(await page.locator('#ops-seats .ops-seat').count(), 3, 'every run seat is listed before any signal'); assert.equal(await page.locator('#ops-seats').getByText('legacy-test-seat').count(), 0);
  assert.equal(await page.locator('#ops-seats .tag.unknown').count(), 3); assert.equal(await page.locator('#ops-seats p.blocked').count(), 0, 'silence is never red');
  // Pair A1 by keyboard only, then drive the seat through the Service as the app would.
  await page.locator('#ops-seats .ops-seat button').first().focus(); await page.keyboard.press('Enter'); await page.locator('#ops-detail').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ops-detail-title');
  await page.getByRole('button', { name: /연결 코드 발급/ }).focus(); await page.keyboard.press('Enter'); await page.locator('.ticket').waitFor();
  const ticket = (await page.locator('.ticket').innerText()).trim(); assert.match(ticket, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.match(await page.locator('#ops-detail-status').innerText(), /발급은 연결 완료가 아닙니다/);
  await page.locator('#ops-seats').getByText('연결 코드 발급 · 입력 대기').waitFor();
  const conn = await local.request('/v1/classroom/ops/connect', 'POST', { ticket, ...local.instance() }, null); assert.equal(conn.status, 201, conn.raw);
  const mint = await local.request('/admin/tokens/issue', 'POST', { u: 'student-a', c: local.cohort, p: local.profile, hours: 2 });
  await local.sync(conn.json.credential, [local.event(1, 'activation', { stage: 'token_rejected', reason: 'auth_signature', http_status: 401 }), local.event(2, 'error', { class: 'auth_signature', code: 'http_401', request_id: 'req-e2e-0001', blocking: true })]);
  await page.locator('#refresh').click(); await page.locator('#ops-seats p.blocked').waitFor();
  assert.match(await page.locator('#ops-seats p.blocked').innerText(), /토큰이 올바르지 않습니다 — .+확인하세요/); assert.equal(await page.locator('#ops-seats p.blocked').count(), 1);
  assert.doesNotMatch(await page.locator('#ops-seats').innerText(), /기한이 지났습니다/, '401 is not rendered as expiry');
  const blocked = await page.locator('#ops-seats p.blocked').evaluate((e) => { const s = getComputedStyle(e); return { color: s.color, size: parseFloat(s.fontSize) }; }); assert.ok(blocked.size >= 14);
  // A student on a learning step, waiting for approval, is not an error.
  const c2 = await local.pair('A2', 1, 2); await local.sync(c2.conn.json.credential, [local.event(1, 'activation', { stage: 'runtime_ready' }), local.event(2, 'step', { lesson_version: local.lesson.version, step_id: 'build', status: 'in_progress' }), local.event(3, 'runtime', { status: 'waiting_approval' })], 2);
  await page.locator('#refresh').click(); await page.locator('#ops-seats').getByText(/build · 진행 중 · 수행: 학생 승인 대기/).waitFor(); assert.equal(await page.locator('#ops-seats p.blocked').count(), 1);
  await page.locator('#ops-evidence').getByText(/오류 보고: .*req-e2e-0001/).waitFor(); assert.ok(!(await page.content()).includes(mint.json.token)); assert.ok(!(await page.content()).includes(conn.json.credential));
  // ── R2: browser → Chalk → Service ledger ← the real device client code (sync loop + command runner), in-process ──
  const opsClient = await import('../../extensions/hypeproof-chat/src/classroomOps.ts'); const { CommandRunner } = await import('../../extensions/hypeproof-chat/src/classroomOpsCommands.ts');
  const mem = () => { let v = null; return { async load() { return v && JSON.parse(v); }, async save(x) { v = JSON.stringify(x); } }; }; let deviceRuns = 0, deviceEpoch = c2.conn.json.connection_epoch, evN = 0;
  const { runPreservingReset } = await import('../../extensions/hypeproof-chat/src/runtimeReset.ts'); const shownToStudent = []; const studentWork = { history: ['q1', 'a1'], draft: '쓰던 글', files: ['index.html'], generation: 1 }; let applied = 0;
  const resetSteps = { freezeInput: async () => {}, unfreezeInput: async () => {}, requestStop: () => {}, isStopped: () => true, preserve: async () => ({ history_count: studentWork.history.length, history_sha256: studentWork.history.join('|'), draft_sha256: studentWork.draft, spool_session: 's1', spool_flushed: true }), generation: () => studentWork.generation, persistManifest: async () => {}, newGeneration: async () => ++studentWork.generation, probe: async () => true, wait: async () => {}, now: () => Date.now() };
  const runner = new CommandRunner({ executors: { retry_diagnostics: { mutating: false, run: async () => { deviceRuns++; return { ok: true, code: 'token_ok' }; } }, reset_runtime: { mutating: true, run: (sig, cmd) => runPreservingReset(cmd.command_id, resetSteps, sig) }, send_question: { mutating: false, acceptsArgs: (a) => Object.keys(a).join() === 'text', run: async (_s, cmd) => { shownToStudent.push(cmd.args.text); return { ok: true, code: 'shown' }; } } }, journal: mem(), monotonic: () => performance.now(), now: () => Date.now(), epoch: () => deviceEpoch }); await runner.recover();
  const deviceLoop = opsClient.startOpsSync({ outbox: await opsClient.OpsOutbox.open(mem(), c2.conn.json.grant_id, 'stream-e2e-0002', () => Date.now(), () => `event-dev-${String(++evN).padStart(6, '0')}`), appInstanceId: local.instance(2).app_instance_id, capabilities: ['observe', 'commands', 'retry_diagnostics', 'reset_runtime', 'send_question'], commands: runner, sample: () => ({ idle_ms: 1, control_revision: applied }), onControl: (c) => { applied = c.control_revision; }, now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {}, onEpoch: (e) => { deviceEpoch = e; }, post: async (body) => { const r = await local.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: local.instance(2).boot_id, events: deviceEvents.splice(0) }, c2.conn.json.credential); return { status: r.status, body: r.json }; } });
  const deviceEvents = [];
  const pump = setInterval(() => void deviceLoop.tick(), 300);
  try {
    await page.locator('#ops-seats .ops-seat').nth(1).getByRole('button', { name: '근거·조치' }).click(); await page.getByRole('button', { name: '진단 다시 실행' }).click();
    await page.locator('#ops-detail-status').filter({ hasText: /성공 1 .*해결 확인 1 \/ 문제 남음 0 .*선택한 전원 해결 확인[\s\S]*A2: 성공 — 토큰 정상 → 문제 해결 확인 · 학생 PC에서 서버 연결과 토큰이 정상임을 확인함/ }).waitFor(); assert.equal(deviceRuns, 1);
    await page.locator('#ops-seats').getByText(/조치: 진단 다시 실행 — 성공 — 토큰 정상 → 문제 해결 확인/).waitFor();
    // Bulk on "needs help" + an unconnected seat: A1 has a connection but no running app, A3 has no device at all.
    await page.locator('#ops-select-help').click(); await page.locator('#ops-seats .ops-seat').nth(2).getByLabel('선택').check();
    assert.match(await page.locator('#ops-selection').innerText(), /선택 2 \/ 전체 3석 \(명단 1차\) · 기기 연결됨 1 · 기기 연결 없음 1/);
    await page.locator('#ops-bulk-diagnose').click(); await page.locator('#ops-bulk-result').filter({ hasText: /A3: 기기 연결 없음 · 전달되지 않음/ }).waitFor();
    const bulk = await page.locator('#ops-bulk-result').innerText(); assert.match(bulk, /대상 2 · 성공 0 .*전달 안 됨 1 .*진행 중 1 ‖ 해결 확인 0 .*실행 안 됨 1 · 아직 확정되지 않음/); assert.doesNotMatch(bulk, /모두 완료|전원 해결/, 'a recorded request is never shown as done');
    assert.match(bulk, /A3: 기기 연결 없음 · 전달되지 않음 → 실행되지 않음 · 문제 상태는 그대로 · 학생 앱에 도달하지 못함/, 'U4: an offline seat is not a success and not a resolution');
    assert.match(bulk, /A1: 접수됨 · 기기 전달 전/);
    // ── 2026-09-18 added criteria: DT-07 CTA priority, AT-35 coaching vs recovery, AT-36 provenance, AT-37 not-enough-evidence ──
    const primaries = (scope) => page.locator(scope + ' button.primary:visible');
    // DT-07 (2026-09-19): one primary CTA on the SCREEN. With a student's detail open, its action is the one and the list's steps back.
    assert.equal(await primaries('body').count(), 1, 'one primary CTA on the screen'); assert.equal((await primaries('body').innerText()).trim(), '질문 보내기', 'no technical fault on A2 → coaching is the primary action');
    await page.locator('#ops-seats .ops-seat').nth(0).getByRole('button', { name: '근거·조치' }).click(); assert.equal(await primaries('body').count(), 1); assert.equal((await primaries('#ops-detail').innerText()).trim(), '진단 다시 실행', 'confirmed fault on A1 → recovery is the primary action, offered without any coaching step first');
    { const t = await page.locator('#ops-evidence').innerText(); assert.match(t, /토큰을 거부당했습니다\. ‘연결 다시 확인’으로는 해결되지 않습니다/, 're-verify is not re-issue'); assert.equal(await page.locator('#ops-evidence a[href="/issuer"]').count(), 1, 'the existing issue/re-issue screen is the way to a new token'); assert.ok(!/[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}/.test(t), 'no bearer on the board'); }
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#ops-detail').isHidden(), true, 'Escape closes the detail'); assert.equal(await page.evaluate(() => document.activeElement?.closest('.ops-seat')?.dataset.seat), 'A1', 'focus returns to the row that opened it'); assert.equal((await primaries('body').innerText()).trim(), '도움 필요한 학생 선택', 'with the detail closed the list\'s call to action is primary again');
    await page.locator('#ops-seats .ops-seat').nth(0).getByRole('button', { name: '근거·조치' }).click();
    assert.match(await page.locator('#ops-evidence').innerText(), /아직 충분히 보지 못함 — 점수나 미달이 아니라/); assert.doesNotMatch((await page.locator('#ops').innerText()).replaceAll('점수나 미달이 아니라', ''), /점수|순위|의존도|상위|하위|역량 부족/, 'no evaluative wording on the operations board (saying that missing evidence is NOT a score is the one allowed mention)');
    assert.match(await page.locator('#ops-state').innerText(), /운영 집계\(학생 평가 아님\)/);
    // Coaching: a question reaches the learner's device as text to show; code is refused and the typed text is kept.
    await page.locator('#ops-seats .ops-seat').nth(1).getByRole('button', { name: '근거·조치' }).click(); await page.locator('#ops-question').fill('```js\nfix()\n```'); await page.getByRole('button', { name: '질문 보내기' }).click();
    await page.locator('#ops-detail-status').filter({ hasText: '코드·마크업·정답은 보낼 수 없습니다' }).waitFor(); assert.match(await page.locator('#ops-question').inputValue(), /fix\(\)/); assert.deepEqual(shownToStudent, []);
    await page.locator('#ops-question').fill('테스트 전에 어떤 결과를 기대했나요?'); await page.getByRole('button', { name: '질문 보내기' }).click(); await page.locator('#ops-detail-status').filter({ hasText: /학생 화면에 표시됨 · 읽음·수행 여부는 알 수 없음/ }).waitFor();
    assert.deepEqual(shownToStudent, ['테스트 전에 어떤 결과를 기대했나요?']); assert.deepEqual([studentWork.history, studentWork.draft, studentWork.files], [['q1', 'a1'], '쓰던 글', ['index.html']], 'coaching changed nothing on the learner side');
    // Provenance: simulated / unverified evidence is marked in the caution colour, never counted as real; review is not approval.
    const h = (c) => c.repeat(64); deviceEvents.push(local.event(50, 'evidence', { evidence_type: 'action', source_state: 'simulated', step_id: 'build' }, { actor: 'ai' }), local.event(51, 'evidence', { evidence_type: 'change', source_state: 'real', artifact_before: h('a'), artifact_after: h('b') }, { actor: 'student' }));
    await page.locator('#ops-seats').getByText(/확인할 근거: 2건 · 강사 확인 전 2건/).waitFor(); assert.match(await page.locator('#ops-seats .ops-seat').nth(1).locator('.amber').innerText(), /가상·미확인 1건 포함/);
    await page.locator('#ops-evidence').getByText(/실제 수행 · 행위자 AI · 단계 build/).waitFor(); await page.locator('#ops-evidence').getByText(/변경 · 행위자 학생 .*변경 전후가 다름/).waitFor();
    await page.locator('#ops-evidence').getByRole('button', { name: '근거 확인' }).first().click(); await page.locator('#ops-detail-status').filter({ hasText: '발송 승인이나 학습 완료와는 별개입니다' }).waitFor(); await page.locator('#ops-evidence').getByText('강사가 근거 확인함').waitFor();
    assert.equal((await local.request(local.base + '/status')).json.seats[1].step.step_id, 'build', 'reviewing evidence did not move the step');
    // R3: reset needs an inline confirmation naming the learner; the result names what was preserved.
    await page.getByRole('button', { name: 'AI 실행 환경 초기화' }).click(); const go = page.getByRole('button', { name: /대상 A2 · student-b 확인하고 실행/ }); await go.waitFor(); assert.equal(await go.evaluate((e) => e === document.activeElement), true); await page.keyboard.press('Enter');
    await page.locator('#ops-detail-status').filter({ hasText: /성공 1 [\s\S]*대화·입력·파일 보존 확인/ }).waitFor(); assert.deepEqual([studentWork.history, studentWork.draft, studentWork.files, studentWork.generation], [['q1', 'a1'], '쓰던 글', ['index.html'], 2]);
    // U4 (AT-40): the device ran the restart — that is NOT yet "resolved". It becomes resolved only when the learner's next run,
    // named by this command id and reported over the same connection, completed. A follow-up naming another command changes nothing.
    { const status = await page.locator('#ops-detail-status').innerText(); assert.match(status, /해결 확인 0 .*실행됨·해결 확인 전 1/); assert.match(status, /명령 실행 완료 · 해결 여부는 아직 확인 전/); assert.doesNotMatch(status, /전원 해결 확인/);
      const resetId = local.db.prepare("SELECT c.id FROM ops_commands c WHERE c.action='reset_runtime' ORDER BY c.created_at DESC").get().id;
      deviceEvents.push(local.event(60, 'recovery', { command_id: 'not-this-command-0001', check: 'turn_completed' })); await page.locator('#refresh').click();
      await page.locator('#ops-seats .ops-seat').nth(1).getByText(/조치: AI 실행 환경 초기화 — 성공 .*→ 명령 실행 완료 · 해결 여부는 아직 확인 전/).waitFor();
      deviceEvents.push(local.event(61, 'recovery', { command_id: resetId, check: 'turn_completed', runtime: 'agent-sdk' }));
      await page.locator('#ops-seats .ops-seat').nth(1).getByText(/조치: AI 실행 환경 초기화 — 성공 .*→ 문제 해결 확인/).waitFor({ timeout: 40000 });
      await page.locator('#ops-seats .ops-seat').nth(1).getByRole('button', { name: '근거·조치' }).click(); await page.locator('#ops-recovery').getByText(/조치 뒤 검증: 문제 해결 확인 · 조치 뒤 학생의 다음 AI 실행이 끝까지 완료됨 · 관측 /).waitFor();
      assert.equal((await local.request(local.base + '/status')).json.seats[0].last_command.outcome.verdict, 'pending', 'the seat that was only queued stays unresolved'); }
    // R3: pause says what it does not stop, and counts only devices that reported the revision.
    await page.locator('#ops-pause').click(); assert.match(await page.locator('#ops-pause-impact').innerText(), /이미 응답을 받고 있는 요청은 끊지 않습니다\. .*다음 AI 요청은 새 요청이므로 서버가 받지 않습니다.*적용된 것으로 세지 않습니다/); await page.locator('#ops-pause-go').click();
    await page.locator('#ops-control-state').filter({ hasText: /일시정지 중 · 기기 적용 1 \/ 적용 대기 \d \/ 확인 불가 \d/ }).waitFor({ timeout: 40000 });
    await page.locator('#ops-pause').click(); await page.locator('#ops-pause-go').click(); await page.locator('#ops-control-state').filter({ hasText: /허용 중/ }).waitFor({ timeout: 40000 });
    // R4: finishing the class is a secondary action; the roster stays whole and nothing is called collected before the Service verified it.
    assert.equal(await page.locator('#ops-finish-go').evaluate((e) => e.classList.contains('primary')), false, 'finish is not the primary CTA');
    await page.locator('#ops-finish-go').click(); await page.locator('#ops-finish-state').filter({ hasText: /미리 확인 결과 \(요청·저장 없음\) · 명단 3명 · 서버 검증됨 0/ }).waitFor(); assert.equal(await page.locator('#ops-finish-items p').count(), 3);
    assert.match(await page.locator('#ops-finish-items').innerText(), /A1 · student-a — 동의 없음 · 회수하지 않음/); assert.equal(local.r2.size, 0);
    assert.equal((await local.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c2.conn.json.credential)).status, 201);
    await page.locator('#ops-finish-dry').uncheck(); await page.locator('#ops-finish-go').click(); await page.locator('#ops-finish-items').getByText(/A2 · student-b — 요청함 · 기록 미도착/).waitFor(); assert.doesNotMatch(await page.locator('#ops-finish-state').innerText(), /회수 완료$/);
    // §14 tokens, measured.
    const css = async (sel, prop) => page.locator(sel).first().evaluate((e, p) => getComputedStyle(e)[p], prop); const lum = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((x) => x / 255).map((x) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((a, x, i) => a + x * [.2126, .7152, .0722][i], 0); const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
    assert.equal(await css('html', 'backgroundColor'), 'rgb(21, 29, 25)'); const panel = await css('#ops', 'backgroundColor'); assert.equal(panel, 'rgb(32, 44, 36)'); assert.equal(await css('#ops button.primary', 'backgroundColor'), 'rgb(213, 242, 121)');
    assert.ok(ratio(await css('#ops button.primary', 'color'), 'rgb(213, 242, 121)') >= 4.5); for (const sel of ['#ops h2', '#ops .muted', '#ops .amber', '#ops-seats p.blocked', '#ops .unknown']) assert.ok(ratio(await css(sel, 'color'), panel) >= 4.5, 'contrast on panel: ' + sel + ' ' + ratio(await css(sel, 'color'), panel).toFixed(2));
    assert.ok(ratio(await css('#ops-question', 'borderTopColor'), await css('#ops-question', 'backgroundColor')) >= 3, 'control boundary 3:1');
    await page.setViewportSize({ width: 1280, height: 900 }); await page.screenshot({ path: `${process.env.HPS_CLASSROOM_OUT || 'test-results/classroom'}/ops-commands-1280.png`, fullPage: true });
  } finally { clearInterval(pump); deviceLoop.stop(); }
  // Stale signal turns the red row neutral: an old error is not a current confirmed block.
  local.db.prepare('UPDATE ops_latest_state SET last_received_at=1').run(); await page.locator('#refresh').click(); await page.locator('#ops-seats').getByText(/신호가 끊겼습니다 · 확인 불가/).first().waitFor(); assert.equal(await page.locator('#ops-seats p.blocked').count(), 0);
  const luminance = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((x) => x / 255).map((x) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((a, x, i) => a + x * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  const bg = await page.locator('#ops').evaluate((e) => getComputedStyle(e).backgroundColor); assert.ok(contrast(blocked.color, bg) >= 4.5, 'DES-11 blocked text contrast');
  for (const cls of ['.unknown', '.muted']) assert.ok(contrast(await page.locator('#ops-seats ' + cls).first().evaluate((e) => getComputedStyle(e).color), bg) >= 4.5, 'DES-11 ' + cls);
  const out = process.env.HPS_CLASSROOM_OUT || 'test-results/classroom'; mkdirSync(out, { recursive: true });
  for (const width of [375, 390, 768, 1280, 1440]) { await page.setViewportSize({ width, height: 900 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at ' + width); assert.equal(await page.locator('#ops-seats .ops-seat').count(), 3); await page.screenshot({ path: `${out}/ops-${width}.png`, fullPage: true }); }
  for (const b of await page.locator('#ops button:visible, #ops-detail button:visible').all()) { const box = await b.boundingBox(); assert.ok(box.height >= 44, 'DES-06 44px target'); }
  await page.locator('#disconnect').click(); assert.equal(await page.locator('#ops-seats .ops-seat').count(), 0); assert.equal(await page.locator('.ticket').count(), 0, 'ticket leaves the page on disconnect');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []);
  console.log('PASS classroom ops browser: empty-run guidance, preserved input on roster error, full run roster with silent seats neutral, keyboard pairing, issued≠connected, named 401 cause in red only while fresh, approval wait not an error, stale→unknown, contrast, 5 widths, 44px targets, no credential storage; R2 single action to success through the real device client, bulk with per-target outcomes and no premature done; added criteria: one primary CTA (recovery on fault, question otherwise), coaching refused for code and shown without changing learner work, provenance with simulated in caution colour, review≠approval, confirmed preserving reset, pause scope and per-device application, §14 tokens measured; R4 finish as secondary CTA, dry run stores nothing, whole roster with reasons, requested≠arrived');
} finally { if (browser) await browser.close(); await new Promise((r) => server.close(r)); globalThis.fetch = realFetch; local.close(); }
