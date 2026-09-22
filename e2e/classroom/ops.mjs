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
  await page.locator('#ops-roster').fill('A1,student-a\nA2,student-b\nA3,ghost'); await page.locator('#ops-observe').check(); await page.locator('#ops-commands').check(); await page.getByRole('button', { name: '명단·설정 저장' }).click();
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
  const runner = new CommandRunner({ executors: { retry_diagnostics: { mutating: false, run: async () => { deviceRuns++; return { ok: true, code: 'token_ok' }; } } }, journal: mem(), monotonic: () => performance.now(), now: () => Date.now(), epoch: () => deviceEpoch }); await runner.recover();
  const deviceLoop = opsClient.startOpsSync({ outbox: await opsClient.OpsOutbox.open(mem(), c2.conn.json.grant_id, 'stream-e2e-0002', () => Date.now(), () => `event-dev-${String(++evN).padStart(6, '0')}`), appInstanceId: local.instance(2).app_instance_id, capabilities: ['observe', 'commands', 'retry_diagnostics'], commands: runner, sample: () => ({ idle_ms: 1 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {}, onEpoch: (e) => { deviceEpoch = e; }, post: async (body) => { const r = await local.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: local.instance(2).boot_id, events: [] }, c2.conn.json.credential); return { status: r.status, body: r.json }; } });
  const pump = setInterval(() => void deviceLoop.tick(), 300);
  try {
    await page.locator('#ops-seats .ops-seat').nth(1).getByRole('button', { name: '근거·조치' }).click(); await page.getByRole('button', { name: '진단 다시 실행' }).click();
    await page.locator('#ops-detail-status').filter({ hasText: /성공 1 .*모두 완료.*A2: 성공 — 토큰 정상/ }).waitFor(); assert.equal(deviceRuns, 1);
    await page.locator('#ops-seats').getByText(/조치: 진단 다시 실행 — 성공 — 토큰 정상/).waitFor();
    // Bulk on "needs help" + an unconnected seat: A1 has a connection but no running app, A3 has no device at all.
    await page.locator('#ops-select-help').click(); await page.locator('#ops-seats .ops-seat').nth(2).getByLabel('선택').check();
    assert.match(await page.locator('#ops-selection').innerText(), /선택 2 \/ 전체 3석 · 전달 가능 1 · 기기 연결 없음 1/);
    await page.locator('#ops-bulk-diagnose').click(); await page.locator('#ops-bulk-result').filter({ hasText: /A3: 기기 연결 없음 · 전달되지 않음/ }).waitFor();
    const bulk = await page.locator('#ops-bulk-result').innerText(); assert.match(bulk, /대상 2 · 성공 0 .*전달 안 됨 1 .*진행 중 1 · 아직 확정되지 않음/); assert.doesNotMatch(bulk, /모두 완료/, 'a recorded request is never shown as done');
    assert.match(bulk, /A1: 접수됨 · 기기 전달 전/);
    await page.setViewportSize({ width: 1280, height: 900 }); await page.screenshot({ path: `${process.env.HPS_CLASSROOM_OUT || 'test-results/classroom'}/ops-commands-1280.png`, fullPage: true });
  } finally { clearInterval(pump); deviceLoop.stop(); }
  // Stale signal turns the red row neutral: an old error is not a current confirmed block.
  local.db.prepare('UPDATE ops_latest_state SET last_received_at=1').run(); await page.locator('#refresh').click(); await page.locator('#ops-seats').getByText(/신호가 끊겼습니다 · 확인 불가/).first().waitFor(); assert.equal(await page.locator('#ops-seats p.blocked').count(), 0);
  const luminance = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((x) => x / 255).map((x) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((a, x, i) => a + x * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor); assert.ok(contrast(blocked.color, bg) >= 4.5, 'DES-11 blocked text contrast');
  for (const cls of ['.unknown', '.muted']) assert.ok(contrast(await page.locator('#ops-seats ' + cls).first().evaluate((e) => getComputedStyle(e).color), bg) >= 4.5, 'DES-11 ' + cls);
  const out = process.env.HPS_CLASSROOM_OUT || 'test-results/classroom'; mkdirSync(out, { recursive: true });
  for (const width of [375, 390, 768, 1280, 1440]) { await page.setViewportSize({ width, height: 900 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at ' + width); assert.equal(await page.locator('#ops-seats .ops-seat').count(), 3); await page.screenshot({ path: `${out}/ops-${width}.png`, fullPage: true }); }
  for (const b of await page.locator('#ops button:visible, #ops-detail button:visible').all()) { const box = await b.boundingBox(); assert.ok(box.height >= 44, 'DES-06 44px target'); }
  await page.locator('#disconnect').click(); assert.equal(await page.locator('#ops-seats .ops-seat').count(), 0); assert.equal(await page.locator('.ticket').count(), 0, 'ticket leaves the page on disconnect');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []);
  console.log('PASS classroom ops browser: empty-run guidance, preserved input on roster error, full run roster with silent seats neutral, keyboard pairing, issued≠connected, named 401 cause in red only while fresh, approval wait not an error, stale→unknown, contrast, 5 widths, 44px targets, no credential storage; R2 single action to success through the real device client, bulk with per-target outcomes and no premature done');
} finally { if (browser) await browser.close(); await new Promise((r) => server.close(r)); globalThis.fetch = realFetch; local.close(); }
