// Remote classroom operations (#751, U3) — AT-45/46 in a real browser: a prompt and a lesson setting sent from Chalk /manage.
//
// Real here: the Chalk page and its script in Chromium (the instructor drives everything through the UI), the Service router +
// SQLite with lesson bindings ENFORCED, for every seat the REAL device client (the extension's sync loop, InboxSession and
// InboxStore on a real directory), the switch request exactly as ClassroomOpsHost sends it, and the BUILT Studio webview in
// Chromium for the learner's "초안에 가져오기".
// Controlled here: the model provider (a recorder that answers a protocol-complete message — it says nothing about a real
// model's quality or cost) and the learner's question (sent on the wire the app speaks, with the app's own headers).
// Synthetic accounts. No real Studio window and no real Agent SDK (that is the Mac run), no Windows, no school network, no
// staging or production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { localOps, OPS_ALL } from '../../worker/test/harness/classroom-ops.mjs';
import { makeCtx, withMockUpstream, anthropicJsonBody, TEST_SECRET } from '../../worker/test/harness/index.mjs';
import * as ops from '../../extensions/hypeproof-chat/src/classroomOps.ts';
import { INBOX_CAPABILITY, INBOX_PROMPT_CAPABILITY, LESSON_BINDING_CAPABILITY, markSettingBound, pendingSetting } from '../../extensions/hypeproof-chat/src/classroomInbox.ts';
import { InboxSession, InboxStore, inboxDir, inboxView } from '../../extensions/hypeproof-chat/src/classroomInboxStore.ts';
import { tokenLessonSha } from '../../extensions/hypeproof-chat/src/lessonBinding.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.join(repo, 'e2e/test-results/classroom-ops-lesson-settings'); mkdirSync(out, { recursive: true });
const dist = path.join(repo, 'extensions/hypeproof-chat/webview-ui/dist'); assert.ok(existsSync(path.join(dist, 'index.html')), 'build the webview first: npm --prefix extensions/hypeproof-chat/webview-ui run build');
const local = await localOps(), { default: chalk } = await import('../../chalk/src/index.ts'), { setRoster } = await import('../../worker/src/lib/kv.ts'), { readLesson } = await import('../../worker/src/lib/lesson-delivery.ts'), { issue } = await import('../../worker/src/lib/tokens.ts');
local.env.HPS_LESSON_BINDINGS = 'enforce'; local.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
const realFetch = globalThis.fetch, toService = (url, init) => local.app.fetch(new Request(url, init), local.env, { waitUntil() {} }); globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? toService(url, init) : realFetch(url, init);
const serve = async (handler) => { const s = createServer(handler); s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s; };
const chalkServer = await serve(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
const webviewServer = await serve((req, res) => { const name = new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html'), file = path.resolve(dist, '.' + name); if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(readFileSync(file)); });
let n = 0; const ok = (name) => { n++; console.log('PASS ' + name); }; let browser; const root = mkdtempSync(path.join(tmpdir(), 'hps-u3-e2e-')), KEY = () => crypto.randomUUID();
try {
  const course = local.lesson.course_id, V1 = local.lesson.version, V2 = 'm2026.09.18-2';
  const seats = ['a', 'b', 'c', 'd'].map((x, i) => ({ seat_id: 'A' + (i + 1), student_id: 'student-' + x }));
  await setRoster(local.env.HPS_KV, local.cohort, seats.map((s) => s.student_id)); await local.freeze(course, V1, ['intro', 'build', 'review']);
  { const a = `/admin/cohorts/${local.cohort}/authoring/${course}`, cur = (await local.request(a)).json, step = (id) => ({ id, title: id, instructions: '합성 단계 ' + id, hint: '', acceptance: '합성 기준' });
    const saved = await local.request(a, 'PUT', { profile_id: local.profile, request_id: KEY(), expected_revision: cur.revision ?? cur.draft?.revision, content: { schema: 'hps-session-design/1', title: '합성 수업 v2', audience: '합성 사용자', duration_minutes: 60, objective: '원격 운영 시험', prerequisites: '없음', starter: '연습 폴더', steps: ['intro', 'craft-v2'].map(step) } }); assert.equal(saved.status, 200, saved.raw);
    assert.equal((await local.request(`${a}/versions/${V2}`, 'PUT', { expected_revision: saved.json.revision })).status, 200); }
  const sha = {}; for (const v of [V1, V2]) sha[v] = (await readLesson(local.env, local.cohort, course, v, local.profile)).sha256;
  const FLAGS = { ops_observe: true, ops_commands: true, ops_distribute: true, ops_lesson_settings: true };
  assert.equal((await local.configure(seats, 0, { flags: FLAGS })).status, 201);
  const L = await local.teacher('teacher-l', [...OPS_ALL, 'distribute', 'lesson_settings']), X = await local.teacher('teacher-x', [...OPS_ALL, 'distribute']);
  const FULL = ['observe', 'commands', INBOX_CAPABILITY, INBOX_PROMPT_CAPABILITY, LESSON_BINDING_CAPABILITY], OLD = ['observe', 'commands', INBOX_CAPABILITY];
  // A1 A2 A3: current app · A4: an app that holds notices and knows nothing of U3
  const conn = {}; for (const [i, s] of seats.entries()) conn[s.seat_id] = (await local.pair(s.seat_id, 1, i + 1, i === 3 ? OLD : FULL)).conn.json;
  const token = {}; for (const s of seats) token[s.seat_id] = (await issue({ u: s.student_id, c: local.cohort, p: local.profile, lesson: { course_id: course, version: V1, sha256: sha[V1] } }, 2, TEST_SECRET)).token;
  const memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; }; let eid = 0; const wire = {};
  async function device(seat, no) {
    const c = conn[seat], caps = no === 4 ? OLD : FULL, store = new InboxStore(inboxDir(root, { cohort: c.student.c, run: c.class_run_id, seat: c.seat_id, student: c.student.u }));
    const inbox = new InboxSession({ store, alive: () => true, clock: { mono: () => performance.now(), wall: () => Date.now() } }), inst = local.instance(no, caps);
    const outbox = await ops.OpsOutbox.open(memory(), c.grant_id, 'stream-' + seat, () => Date.now(), () => `event-u3e-${String(++eid).padStart(6, '0')}`); wire[seat] = [];
    const loop = ops.startOpsSync({ outbox, appInstanceId: inst.app_instance_id, capabilities: caps, distribution: inbox, sample: () => ({ idle_ms: 1 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {},
      post: async (body) => { const r = await local.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: inst.boot_id }, c.credential); wire[seat].push(JSON.stringify(r.json ?? {})); return { status: r.status, body: r.json }; } });
    return { loop, store, inst, cards: async () => (await store.read()).cards };
  }
  const dev = {}; for (const [i, s] of seats.entries()) dev[s.seat_id] = await device(s.seat_id, i + 1);
  const tickAll = async (k = 4) => { for (let i = 0; i < k; i++) { local.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); for (const d of Object.values(dev)) await d.loop.tick(); } };
  const cool = () => local.db.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run();
  await tickAll(1);
  // The learner's question on the wire the app speaks: its turn id, and the binding key the app expects.
  async function ask(seat, { turn = KEY(), key, fail = false } = {}) {
    const ctx = makeCtx();
    return withMockUpstream(() => fail ? new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'synthetic' } }), { status: 529, headers: { 'content-type': 'application/json' } }) : new Response(JSON.stringify(anthropicJsonBody({ text: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } }), async (calls) => {
      const r = await toService('https://service.test/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + token[seat], 'content-type': 'application/json', 'x-hps-turn-id': turn, ...(key ? { 'x-hps-lesson-binding': key } : {}) }, body: JSON.stringify({ model: 'claude-mock', max_tokens: 64, messages: [{ role: 'user', content: '합성 질문' }] }) });
      const text = await r.text(); await ctx.settle(); let json; try { json = JSON.parse(text); } catch {} return { status: r.status, json, sent: calls.map((c) => String(c.init.body)).join('\n'), upstream: calls.length };
    });
  }
  const profileOf = async (seat) => (await toService('https://service.test/v1/profile', { headers: { authorization: 'Bearer ' + token[seat] } })).json();
  /** Exactly what ClassroomOpsHost.switchPendingSetting does: the device's own index names the offer; the Service decides. */
  async function switchOn(seat) { const d = dev[seat], pending = pendingSetting((await d.store.current()).index); if (!pending) return null;
    const r = await local.request('/v1/classroom/ops/lesson-binding', 'POST', { app_instance_id: d.inst.app_instance_id, boot_id: d.inst.boot_id, offer_key: pending.offer_key, distribution_id: pending.distribution_id, object_id: pending.object_id, revision: pending.revision, content_hash: pending.content_hash, base_lesson_sha256: tokenLessonSha(token[seat]), learner_token: token[seat] }, conn[seat].credential);
    if (r.status === 201 || r.status === 200) await d.store.commit((index) => ({ next: markSettingBound(index, { object_id: pending.object_id, revision: pending.revision, content_hash: pending.content_hash, key: r.json.binding.key, seq: r.json.binding.seq }), result: null }));
    return r; }

  browser = await chromium.launch(); const origin = 'http://127.0.0.1:' + chalkServer.address().port, page = await browser.newPage({ viewport: { width: 1440, height: 1300 } }); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const connect = async (t) => { await page.goto(origin + '/manage'); await page.locator('#token').fill(t); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill('student-'); await page.locator('#connect button').first().click(); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await page.locator('#ops-check').click(); await page.locator('#ops-seats .ops-seat[data-seat="A4"]').waitFor(); };
  const box = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`).getByLabel('선택'), T = (id) => page.locator('#' + id).innerText(), Ls = async (id) => (await T(id)).split('\n').filter(Boolean);
  const compose = async () => { if (!(await page.locator('#ops-dist').evaluate((d) => d.open))) await page.locator('#ops-dist-summary').click(); await page.locator('#ops-dist-title').waitFor(); };
  const saveForm = async () => { await page.locator('#ops-dist-save').click(); await page.locator('#ops-dist-saved').filter({ hasText: '저장했습니다' }).waitFor(); };
  const sendNow = async (count) => { await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor(); const impact = await T('ops-dist-impact'), plan = await Ls('ops-dist-plan'), content = await T('ops-dist-content'); assert.equal(await page.locator('#ops-dist-go').innerText(), count + '명에게 보내기'); cool(); await page.locator('#ops-dist-go').click(); await page.locator('#ops-dist-state').filter({ hasText: '대상 ' + count + '명' }).waitFor(); return { impact, plan, content }; };
  const refresh = async () => { await page.locator('#ops-dist-refresh').click(); await page.waitForTimeout(250); return Ls('ops-dist-items'); };
  const bindings = (student) => local.db.prepare('SELECT binding_seq,source,version FROM classroom_lesson_bindings WHERE student_id=? ORDER BY binding_seq').all(student).map((r) => [r.binding_seq, r.source, r.version]);

  // ── E1: what is offered — a prompt to anyone who may distribute; a setting only to who holds it, where it can be enforced ──
  await connect(X); await compose();
  assert.deepEqual(await page.locator('#ops-dist-kind option').evaluateAll((os) => os.filter((o) => !o.hidden && !o.disabled).map((o) => o.value)), ['notice', 'material', 'prompt'], 'this instructor may distribute, not change lesson settings');
  await page.locator('#ops-dist-kind').selectOption('prompt'); assert.match(await T('ops-dist-kind-help'), /초안에 가져오기.*수업 설정은 지금 쓸 수 없습니다: 이 강사 토큰에는 수업 설정 권한/s);
  await connect(L); await compose();
  assert.match(await page.locator('#ops-dist-preview').innerText(), /^선택한 학생에게 보내기 \(공지·자료·프롬프트·수업 설정\) — 먼저 확인$/, 'the entry names everything it can send'); assert.match(await T('ops-dist-summary'), /^공지·자료·프롬프트·수업 설정 작성/);
  assert.deepEqual(await page.locator('#ops-dist-kind option').evaluateAll((os) => os.filter((o) => !o.hidden && !o.disabled).map((o) => o.value)), ['notice', 'material', 'prompt', 'setting']);
  ok('E1 the setting kind is offered only to an instructor who holds `lesson_settings`; the prompt kind needs only `distribute`');

  // ── E2: a prompt — to A1 and the old app A4, not to A2 — and the learner's own press in the BUILT webview ──
  const PROMPT = '이 페이지의 구조를 세 문장으로 설명해 줘.\n<img src=x onerror=alert(1)>';
  await page.locator('#ops-dist-kind').selectOption('prompt'); await page.locator('#ops-dist-title').fill('조사 프롬프트'); await page.locator('#ops-dist-body').fill(PROMPT); await saveForm();
  await box('A1').check(); await box('A4').check(); const p = await sendNow(2);
  assert.match(p.impact, /초안에 가져오기.*자동으로 전송·실행되지 않습니다/s); assert.deepEqual(p.plan.map((l) => l.slice(l.indexOf(' — ') + 3)), ['지금 전달 가능', '이 앱은 이 종류(프롬프트)를 지원하지 않음 — 보내도 적용되지 않습니다']);
  assert.match(p.content, /^\[프롬프트\] 조사 프롬프트/);
  await tickAll(); const pl = await refresh();
  assert.match(pl[0], /^A1 · student-a — 전달: 보관함 반영 · 보관함: 지금 보관함에 있음$/); assert.match(pl[1], /^A4 · student-d — 전달: 이 앱은 보관함을 지원하지 않음/);
  assert.deepEqual((await dev.A1.cards()).map((c) => [c.kind, c.body]), [['prompt', PROMPT]]); assert.deepEqual(await dev.A2.cards(), []); assert.deepEqual(await dev.A4.cards(), []);
  assert.ok(wire.A4.every((w) => !w.includes('세 문장')) && wire.A2.every((w) => !w.includes('세 문장')), 'the body was never sent to the unselected learner or to the app that cannot hold a prompt');
  const app = await browser.newPage({ viewport: { width: 420, height: 900 } }); const appErrors = [], dialogs = []; app.on('pageerror', (e) => appErrors.push(e.message)); app.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await app.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.sent.push(m), getState: () => undefined, setState: () => {} }); });
  await app.goto('http://127.0.0.1:' + webviewServer.address().port + '/'); await app.waitForFunction(() => window.sent.some((m) => m.type === 'ready'));
  const profile1 = await profileOf('A1'); assert.equal(profile1.lesson.version, V1);
  await app.evaluate((config) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'config', config } })), { proxyUrl: 'http://controlled-host.invalid/v1', model: 'controlled-host-only', hasToken: true, coach: { name: '코치', personality: '', configured: true }, profile: profile1 });
  const view = await inboxView(dev.A1.store, { run: local.run, student: 'student-a', generation: 3, ended: false }); await app.evaluate((inbox) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'inboxState', inbox } })), view);
  const input = app.locator('textarea').first(); await input.waitFor(); await input.fill('내가 쓰던 글');
  const inboxEl = app.locator('details.hp-inbox'); await inboxEl.locator('> summary').click(); const card = inboxEl.locator('li.hp-inbox-card').first(); await card.locator('summary').click();
  assert.equal(await card.locator('.hp-inbox-body').innerText(), PROMPT.trim(), 'shown as typed'); assert.equal(await app.locator('details.hp-inbox img').count(), 0, 'no element is made from the text');
  await card.locator('[data-inbox-import]').click(); assert.equal(await input.inputValue(), '내가 쓰던 글\n\n' + PROMPT, 'appended to what the learner had typed — never replaced');
  assert.deepEqual((await app.evaluate(() => window.sent)).filter((m) => m.type === 'sendMessage'), [], 'importing sends nothing and calls no model');
  await card.locator('[data-inbox-undo]').click(); assert.equal(await input.inputValue(), '내가 쓰던 글', 'undo restores the learner\'s own text exactly');
  await card.locator('[data-inbox-import]').click(); await input.press('End'); await input.pressSequentially(' 그리고 내 질문'); assert.equal(await card.locator('[data-inbox-undo]').isDisabled(), true, 'once the learner typed on, the text is theirs: undo no longer touches it');
  assert.deepEqual(dialogs, []); assert.deepEqual(appErrors, []); await app.screenshot({ path: path.join(out, 'learner-prompt-import.png'), fullPage: true }); await app.close();
  // ── E2b (P2·P3·P4·P5·P7): a draft + TWO attachments + a parked message, keyboard only, 390px and 200%, then a withdrawal ──
  const app2 = await browser.newPage({ viewport: { width: 390, height: 844 } }); const app2Errors = []; app2.on('pageerror', (e) => app2Errors.push(e.message));
  await app2.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.sent.push(m), getState: () => undefined, setState: () => {} }); });
  await app2.goto('http://127.0.0.1:' + webviewServer.address().port + '/'); await app2.waitForFunction(() => window.sent.some((m) => m.type === 'ready'));
  const host2 = (m) => app2.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), m), sends2 = async () => (await app2.evaluate(() => window.sent)).filter((m) => m.type === 'sendMessage');
  await host2({ type: 'config', config: { proxyUrl: 'http://controlled-host.invalid/v1', model: 'controlled-host-only', hasToken: true, coach: { name: '코치', personality: '', configured: true }, profile: profile1 } }); await host2({ type: 'inboxState', inbox: view });
  const in2 = app2.locator('textarea').first(); await in2.waitFor();
  // a turn is running (the host said so), and the learner parks the next message
  await in2.fill('첫 질문'); await in2.press('Enter'); await app2.waitForFunction(() => window.sent.some((m) => m.type === 'sendMessage')); const turn1 = (await sends2())[0];
  await host2({ type: 'streamStart', streamId: turn1.streamId ?? 'stream-1', messageId: 'm-1' }); await in2.fill('예약한 입력'); await in2.press('Enter');
  const parked = app2.locator('.hps-queued-text'); await parked.waitFor(); assert.equal(await parked.innerText(), '예약한 입력');
  await in2.fill('내가 쓰던 초안'); const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  for (const name of ['one.png', 'two.png']) await app2.evaluate(([b64, name]) => { const e = document.querySelector('textarea'), bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0) + 0), dt = new DataTransfer(); dt.items.add(new File([bytes, name], name, { type: 'image/png' })); e.focus(); e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, [PNG1, name]);
  await app2.waitForFunction(() => document.querySelectorAll('.hps-attachment').length === 2);
  // keyboard only: open the inbox, open the card, press the import button — every control is reached by Tab and has a name
  const inbox2 = app2.locator('details.hp-inbox'); await inbox2.locator('> summary').focus(); await app2.keyboard.press('Enter'); await inbox2.locator('li.hp-inbox-card summary').first().focus(); await app2.keyboard.press('Enter');
  const importBtn = app2.getByRole('button', { name: '초안에 가져오기' }); await importBtn.waitFor(); assert.equal(await importBtn.count(), 1, 'the import control has an accessible name');
  let tabs = 0; while (tabs++ < 40 && !(await app2.evaluate(() => document.activeElement?.hasAttribute('data-inbox-import')))) await app2.keyboard.press('Tab'); assert.ok(tabs < 40, 'the import button is reachable with Tab alone'); await app2.keyboard.press('Enter');
  assert.equal(await in2.inputValue(), '내가 쓰던 초안\n\n' + PROMPT); assert.equal(await app2.locator('.hps-attachment').count(), 2, 'both attachments are untouched'); assert.equal(await parked.innerText(), '예약한 입력', 'the parked message is untouched'); assert.equal((await sends2()).length, 1, 'importing sent nothing');
  const said = app2.locator('[data-inbox-imported]'); assert.match(await said.innerText(), /입력창 끝에 덧붙였습니다/, 'the result is said in words (role=status), not by colour'); assert.equal(await said.getAttribute('role'), 'status');
  // After an import the focus goes back to the input (the learner keeps typing). Undo is reached from there with the keyboard alone.
  assert.equal(await app2.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', 'focus returns to the learner\'s input'); let hops = 0; while (hops++ < 40 && !(await app2.evaluate(() => document.activeElement?.hasAttribute('data-inbox-undo')))) await app2.keyboard.press('Shift+Tab'); assert.ok(hops < 40, 'undo is reachable with Shift+Tab alone'); await app2.keyboard.press('Enter'); assert.equal(await in2.inputValue(), '내가 쓰던 초안'); assert.equal(await app2.locator('.hps-attachment').count(), 2);
  // undo after ADDING an attachment still restores the text and never drops an attachment; after a keystroke it is disabled WITH its reason in words
  await importBtn.click(); await app2.evaluate(([b64]) => { const e = document.querySelector('textarea'), bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), dt = new DataTransfer(); dt.items.add(new File([bytes, '3'], 'three.png', { type: 'image/png' })); e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, [PNG1]); await app2.waitForFunction(() => document.querySelectorAll('.hps-attachment').length === 3);
  await app2.getByRole('button', { name: '되돌리기' }).click(); assert.equal(await in2.inputValue(), '내가 쓰던 초안'); assert.equal(await app2.locator('.hps-attachment').count(), 3, 'undo restores text only');
  await importBtn.click(); await in2.press('End'); await in2.pressSequentially(' + 내 말'); const undo2 = app2.getByRole('button', { name: '되돌리기' }); assert.equal(await undo2.isDisabled(), true); assert.match(await said.innerText(), /그 뒤에 고친 글이 있어 자동으로 되돌리지 않습니다/, 'disabled is explained in words');
  // 390px, then 200% text: no sideways scrolling, the buttons stay inside the viewport; forced colours keep the words
  const overflow2 = () => app2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok(await overflow2() <= 0, '390px: no sideways scrolling');
  await app2.evaluate(() => { document.documentElement.style.fontSize = '200%'; }); assert.ok(await overflow2() <= 0, '200%: no sideways scrolling'); const box2 = await importBtn.boundingBox(); assert.ok(box2 && box2.x >= 0 && box2.x + box2.width <= 390, 'the import button is inside the 390px viewport at 200%: ' + JSON.stringify(box2));
  await app2.emulateMedia({ forcedColors: 'active' }); assert.equal(await importBtn.isVisible(), true); assert.match(await said.innerText(), /덧붙였습니다/); await app2.screenshot({ path: path.join(out, 'learner-prompt-390-200-forced-colors.png'), fullPage: true }); await app2.emulateMedia({ forcedColors: 'none' }); await app2.evaluate(() => { document.documentElement.style.fontSize = ''; });
  assert.equal(await app2.locator('.studio-primary, .hp-cta-primary').count() <= 1, true, 'no second Primary'); assert.equal(await app2.locator('[role=dialog],dialog[open]').count(), 0, 'no modal');
  // P4 — the instructor withdraws the prompt AFTER it was imported and edited: the card comes down, the learner's text, attachments, parked message and provenance stay
  const edited = await in2.inputValue(); await host2({ type: 'inboxState', inbox: { ...view, cards: view.cards.map((c) => ({ ...c, title: '', body: '', withdrawn: true })) } });
  await app2.waitForFunction(() => !document.querySelector('[data-inbox-import]')); assert.match(await inbox2.innerText(), /강사가 회수한 자료입니다/); assert.equal(await in2.inputValue(), edited, 'withdrawal never touches the learner\'s draft'); assert.equal(await app2.locator('.hps-attachment').count(), 3); assert.equal(await parked.innerText(), '예약한 입력');
  // P5 — the running turn ends: the PARKED message goes out as itself (it carries no provenance of a prompt it never contained); the learner then sends the draft, which does
  await host2({ type: 'streamEnd', streamId: turn1.streamId ?? 'stream-1' }); await app2.waitForFunction(() => window.sent.filter((m) => m.type === 'sendMessage').length === 2); const flushed = (await sends2())[1];
  assert.equal(flushed.text, '예약한 입력'); assert.equal(flushed.imports, undefined, 'the parked message did not import anything'); assert.equal(await in2.inputValue(), edited, 'the draft typed while waiting is still in the input after the parked message went out'); assert.equal(flushed.images.length, 3, 'pasted images ride along with the next turn that goes out — the #416 contract, unchanged');
  await host2({ type: 'streamStart', streamId: flushed.streamId ?? 'stream-2', messageId: 'm-2' }); await host2({ type: 'streamEnd', streamId: flushed.streamId ?? 'stream-2' }); await in2.press('Enter'); await app2.waitForFunction(() => window.sent.filter((m) => m.type === 'sendMessage').length === 3);
  const own = (await sends2())[2]; assert.equal(own.text, edited.trim()); assert.deepEqual(own.imports.map((r) => [r.object_id, r.revision]), [[view.cards[0].object_id, 1]], 'the learner\'s own send names the exact prompt object and revision it imported'); assert.match(own.imports[0].hash16, /^[a-f0-9]{16}$/);
  assert.deepEqual(app2Errors, []); await app2.close();
  ok('E2 prompt: selected+capable device only; the learner\'s own press appends to their draft in the built webview, sends nothing, and can be undone until they type');
  ok('E2b draft + two attachments + a parked message survive import, undo and withdrawal; keyboard only, 390px, 200%, forced colours; the learner\'s own send carries the exact object and revision');

  // ── E3: a setting — picked from the confirmed versions, impact shown, A1+A2 (not A3), prepared ≠ switched ≠ applied ──
  await page.locator('#ops-select-none').click(); await compose() /* the composer closes itself after a send */; await page.locator('#ops-dist-new').click(); await page.locator('#ops-dist-kind').selectOption('setting');
  await page.locator('#ops-dist-setting option[value="' + V2 + '"]').waitFor({ state: 'attached' });
  assert.deepEqual((await page.locator('#ops-dist-setting option').evaluateAll((os) => os.map((o) => o.value))).sort(), ['', V1, V2, 'base'].sort(), 'the picker lists the confirmed versions of this run\'s course and the return — nothing else');
  await page.locator('#ops-dist-title').fill('2번째 판으로'); await page.locator('#ops-dist-body').fill('다음 질문부터 새 단계로 진행합니다.'); await page.locator('#ops-dist-save').click();
  assert.match(await T('ops-dist-saved'), /바꿀 강의 버전.*고르세요/, 'a setting without a version is not saved'); assert.equal(local.db.prepare("SELECT count(*) n FROM classroom_content_objects WHERE kind='setting'").get().n, 0);
  assert.match(await T('ops-dist-about'), /다음 질문부터 실행하는 수업 기준.*이미 쓴 초안·첨부·대화·작업 파일은 그대로/s);
  await page.locator('#ops-dist-setting').selectOption(V2); assert.match(await T('ops-dist-setting-impact'), /비교 기준: 이 수업의 기본 버전/); assert.match(await T('ops-dist-setting-impact'), /새로 생김 craft-v2.*없어짐 build, review.*이전 기준/s); await saveForm();
  assert.match(await T('ops-dist-summary'), /^수업 설정 · ‘2번째 판으로’ 1번째 판/, 'a setting is not called a notice');
  await box('A1').check(); await box('A2').check(); const s1 = await sendNow(2);
  assert.match(s1.impact, new RegExp('수업 설정을 바꿉니다.*강의 버전 ' + V2.replace(/\./g, '\\.') + '.*진행 중인 응답은 끊지 않고 각 학생의 다음 질문부터.*보관함 반영은 ‘준비’일 뿐', 's'));
  // what stays and what changes is said without contradiction, and the change is told FROM what each selected learner runs now
  assert.match(s1.impact, /선택한 학생이 지금 실행하는 버전에서 바뀌는 것 — A1, A2 \(지금 m2026\.09\.18-1 · 이 수업의 기본 버전\): 단계: 그대로 1개 · 새로 생김 craft-v2 · 없어짐 build, review/); assert.match(s1.impact, /이미 쓴 초안·첨부·대화·작업 파일은 그대로입니다\. 바뀌는 것은 다음 질문부터의 수업 기준/); assert.doesNotMatch(s1.impact, /과제·입력·대화·파일은 바뀌지 않습니다/, 'a setting DOES change what the learner works under');
  await tickAll(); let sl = await refresh();
  assert.match(sl[0], /^A1 · student-a — 전달: 보관함 반영 · 보관함: 지금 보관함에 있음 · 설정: 준비 — 기기 보관함에 있음 · 전환 전/); assert.match(await T('ops-dist-state'), /수업 설정: 준비 2 · 전환 0 · 실행 시도 0 · 적용 0/); assert.doesNotMatch(await T('ops-dist-state'), /모두 적용/);
  assert.deepEqual(bindings('student-a'), [], 'delivered to the inbox: nothing is switched yet'); assert.equal((await profileOf('A1')).lesson.version, V1);
  // A1 starts a question under V1 (its turn is admitted), THEN switches, and that turn's next request still runs under V1.
  const K1 = (await profileOf('A1')).lesson_binding.key, running = KEY(); assert.equal((await ask('A1', { turn: running, key: K1 })).status, 200);
  const sw = await switchOn('A1'); assert.equal(sw.status, 201, sw.raw); const K2 = sw.json.binding.key;
  const tail = await ask('A1', { turn: running, key: K1 }); assert.equal(tail.status, 200, 'the running answer is not cut'); assert.ok(!tail.sent.includes('craft-v2'), 'and it keeps running under the version it was admitted with');
  sl = await refresh(); assert.match(sl[0], /설정: 전환됨 — 이 설정으로 실행한 질문은 아직 없음/); assert.match(sl[1], /^A2 .* 설정: 준비/);
  assert.equal((await ask('A1', { key: K1 })).status, 403, 'a NEW question with the old key is refused, not run under either version'); assert.equal((await profileOf('A1')).lesson.version, V2);
  const failed = await ask('A1', { key: K2, fail: true }); assert.ok(failed.status >= 500 || failed.status === 429, String(failed.status)); sl = await refresh(); assert.match(sl[0], /설정: 실행 시도 실패\(상류 오류·중단\) — 적용으로 세지 않음/);
  const good = await ask('A1', { key: K2 }); assert.equal(good.status, 200); assert.ok(good.sent.includes('craft-v2'), 'the next question runs under the switched version');
  sl = await refresh(); assert.match(sl[0], /설정: 적용 — 이 설정으로 보낸 모델 요청이 정상 종료됨 \(m2026\.09\.18-2\) · 이후 실패한 요청도 있음|설정: 적용 — 이 설정으로 보낸 모델 요청이 정상 종료됨 \(m2026\.09\.18-2\)/); assert.match(await T('ops-dist-state'), /준비 1 · 전환 0 · 실행 시도 0 · 적용 1/); assert.doesNotMatch(await T('ops-dist-state'), /모두 적용/);
  assert.match(await T('ops-dist-observed'), /요청 단위/); assert.deepEqual(bindings('student-c'), []); assert.equal((await ask('A3', { key: K1 })).status, 200, 'the unselected learner keeps running the run\'s version'); assert.deepEqual(await dev.A3.cards(), []);
  await page.locator('#ops-check').click(); await page.waitForTimeout(300);
  assert.match(await page.locator('#ops-seats .ops-seat[data-seat="A1"]').innerText(), new RegExp('강의 버전: ' + V2.replace(/\./g, '\\.') + ' · 수업 설정으로 전환됨')); assert.doesNotMatch(await page.locator('#ops-seats .ops-seat[data-seat="A3"]').innerText(), /강의 버전:/);
  await page.screenshot({ path: path.join(out, 'instructor-setting-phases.png'), fullPage: true });
  ok('E3 setting: picked from confirmed versions with the Service\'s impact; prepared → switched → attempt failed → applied are told apart; a running answer is kept; the unselected learner is untouched');

  // ── E4: withdraw is not a return — and the return is an ordinary revision sent through the same steps ──
  await page.locator('#ops-dist-revoke').click(); assert.match(await T('ops-dist-revoke-impact'), /^수업 설정의 회수는 되돌리기가 아닙니다/); await page.locator('#ops-dist-revoke-go').click(); await page.locator('#ops-dist-now').filter({ hasText: '이 배포는 회수했습니다' }).waitFor(); await tickAll();
  assert.equal((await profileOf('A1')).lesson.version, V2, 'withdrawn: the switched learner still runs V2'); assert.equal((await ask('A1', { key: K2 })).status, 200);
  const after = await switchOn('A2'); assert.ok(!after || after.status >= 400, 'withdrawn before A2 switched: A2 can no longer switch to it'); assert.deepEqual(bindings('student-b'), []); assert.equal((await profileOf('A2')).lesson.version, V1);
  await page.locator('#ops-dist-return').click(); assert.match(await T('ops-dist-note'), /복귀를 준비했습니다.*아직 아무것도 보내지 않았습니다/s); assert.equal(await page.locator('#ops-dist-setting').inputValue(), 'base'); assert.equal(local.db.prepare('SELECT count(*) n FROM classroom_distributions').get().n, 2, 'preparing the return sent nothing');
  await box('A2').uncheck(); await saveForm(); assert.match(await T('ops-dist-saved'), /2번째 판/, 'the return is the next revision of the run\'s one setting object'); const s2 = await sendNow(1); assert.match(s2.impact, /기본 수업으로 복귀/);
  assert.match(s2.impact, /A1 \(지금 m2026\.09\.18-2 · 수업 설정으로 전환된 상태\): 단계: 그대로 1개 · 새로 생김 build, review · 없어짐 craft-v2/, 'the return is described from v2, which this learner runs — not as "nothing changes" against the run\'s version'); assert.doesNotMatch(s2.impact, /단계: 그대로 3개/);
  await tickAll(); const back = await switchOn('A1'); assert.equal(back.status, 201, back.raw); assert.deepEqual(bindings('student-a'), [[1, 'setting', V2], [2, 'base', '']], 'a return names no version of its own: it is whatever the participant\'s token pins');
  assert.equal((await profileOf('A1')).lesson.version, V1); const K3 = back.json.binding.key; assert.equal((await ask('A1', { key: K2 })).status, 403); const home = await ask('A1', { key: K3 }); assert.equal(home.status, 200); assert.ok(!home.sent.includes('craft-v2'));
  sl = await refresh(); assert.match(sl[0], /설정: 적용 — 이 설정으로 보낸 모델 요청이 정상 종료됨 \(기본 수업\)/);
  await page.locator('#ops-check').click(); await page.waitForTimeout(300); assert.match(await page.locator('#ops-seats .ops-seat[data-seat="A1"]').innerText(), /기본 수업으로 복귀함/);
  await page.screenshot({ path: path.join(out, 'instructor-return.png'), fullPage: true }); assert.deepEqual(errors, []);
  ok('E4 withdraw stops only who has not switched; the return is a {base:true} revision through save → check → send, and the learner runs the token lesson again');
  console.log(`\n${n} passed`);
} finally { await browser?.close(); chalkServer.close(); webviewServer.close(); globalThis.fetch = realFetch; local.close(); rmSync(root, { recursive: true, force: true }); }
