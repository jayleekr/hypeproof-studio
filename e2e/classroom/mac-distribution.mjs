// Remote classroom operations (#751, U2) — AT-44 M1: distribution of a notice from the REAL Chalk UI to a REAL Studio window on this Mac.
//
//   HPS_DEVHOST_SOURCE="<official shell>.app" HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-u2 node e2e/classroom/mac-devhost.mjs prepare
//   HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-u2 node --experimental-strip-types --experimental-sqlite e2e/classroom/mac-distribution.mjs
//
// Everything the instructor does is done THROUGH THE CHALK PAGE in a visible browser window (write → select A1 → preview →
// send → results → same revision again → withdraw, in order). Everything about the learner is read from the REAL Studio
// window (the copied official shell + the current extension build + the Agent SDK), over its debugging port: the card on the
// work screen, opening it again, a FULL quit and restart, the entry card and the work screen after the restart, revision 2,
// and what is left after the withdrawals. The learner's workspace files, conversation and input draft are compared before/after.
// Real: shell copy, extension, SDK + binary, ops sync loop, the inbox on disk, Chalk, Service router + SQLite.
// Synthetic: accounts, lesson, MODEL answers, seats A2/A3 (connected, inbox-capable, NOT selected — they run the real device
// client in this process). Own ports, own user-data dir, own HOME: the other demo on :18761/:18762, the installed app and the
// user's Studio data are not touched. Says nothing about Windows, a school network, staging or production, a real model or mail.
// It stays up afterwards (instructor page + learner app) until Control-C, so that a person can continue by hand.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { localOps, OPS_ALL } from '../../worker/test/harness/classroom-ops.mjs';
import * as ops from '../../extensions/hypeproof-chat/src/classroomOps.ts';
import { InboxSession, InboxStore, inboxDir } from '../../extensions/hypeproof-chat/src/classroomInboxStore.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost-u2'));
const servicePort = Number(process.env.HPS_DIST_SERVICE_PORT || 18771), boardPort = Number(process.env.HPS_DIST_BOARD_PORT || 18772), debugPort = Number(process.env.HPS_DIST_DEBUG_PORT || 9371), prefix = 'u2-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'), json = (p) => JSON.parse(readFileSync(p, 'utf8')), out = path.join(home, 'distribution'); mkdirSync(out, { recursive: true });
const manifest = json(path.join(home, 'manifest.json')), copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
assert.ok(!copy.startsWith('/Applications'), 'never the installed app');
for (const [f, h] of Object.entries(manifest.extension.bundles)) { assert.equal(sha(path.join(ext, f)), h, `${f} changed since prepare`); assert.equal(sha(path.join(repo, 'extensions/hypeproof-chat', f)), h, `${f}: the prepared copy is not the current build — prepare again`); }
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', manifest.extension.source_sha, head, '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src'], { cwd: repo, encoding: 'utf8' }), '', 'extension sources changed since prepare');
assert.ok(manifest.agent_sdk?.vendored === true && manifest.agent_sdk.binary, 'the dev host has no Agent SDK: prepare again');
const steps = []; const step = (name, detail = {}) => { steps.push({ at: new Date().toISOString(), name, ...detail }); console.log('STEP ' + name + (Object.keys(detail).length ? ' ' + JSON.stringify(detail) : '')); };

// ── Service: real router + SQLite, synthetic class of three seats, distribution switched ON for this run only ──
const local = await localOps(), { setRoster } = await import('../../worker/src/lib/kv.ts');
const seats = ['A1', 'A2', 'A3'].map((id, i) => ({ seat_id: id, student_id: prefix + (i + 1) }));
await setRoster(local.env.HPS_KV, local.cohort, seats.map((s) => s.student_id)); await local.freeze();
assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_distribute: true } })).status, 201);
const { issueIssuer } = await import('../../worker/src/lib/tokens.ts'), { TEST_SECRET } = await import('../../worker/test/harness/index.mjs');
const teacherToken = (await issueIssuer({ issuer: 'teacher-a' /* the lesson was drafted and frozen by this instructor id; the invite endpoint is per author */, scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: [...OPS_ALL, 'distribute'] }] }, 4, TEST_SECRET)).token;
const invite = await local.request(`/admin/cohorts/${local.cohort}/authoring/${local.lesson.course_id}/versions/${local.lesson.version}/participants`, 'POST', { user: seats[0].student_id, hours: 3 }, teacherToken);
assert.equal(invite.status, 200, invite.raw); const token = invite.json.token;
Object.assign(local.env, { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-no-live-key', OPENAI_API_KEY: undefined, ANTHROPIC_PROXY_URL: undefined });
const providerCalls = [], realFetch = globalThis.fetch, ANSWER = '[로컬 시험 응답] 모바일 화면에서 예약 버튼이 보이고 눌리는지 먼저 확인해 보세요. 실제 AI 모델은 호출하지 않았습니다.';
const sse = (model, text) => new Response([['message_start', { type: 'message_start', message: { id: 'synthetic-' + providerCalls.length, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }], ['message_stop', { type: 'message_stop' }]].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.origin === 'https://service.test') return local.app.fetch(new Request(input, init), local.env, { waitUntil() {} });
  assert.equal(url.origin, 'https://api.anthropic.com', 'unexpected outbound request from the Service: ' + url.origin); // the ONLY scripted thing
  const body = JSON.parse(init.body); providerCalls.push({ model: body.model, stream: body.stream === true });
  return body.stream ? sse(body.model, ANSWER) : Response.json({ id: 'synthetic', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 9 } });
};
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts);
  const r = await local.app.fetch(new Request('https://service.test' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), local.env, { waitUntil() {}, passThroughOnException() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) for await (const chunk of r.body) res.write(chunk); res.end(); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
server.listen(servicePort, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
const { default: chalk } = await import('../../chalk/src/index.ts');
const board = createServer(async (req, res) => { try { const parts = []; for await (const b of req) parts.push(b); const body = Buffer.concat(parts);
  const rr = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(rr.status, Object.fromEntries(rr.headers)); res.end(Buffer.from(await rr.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
board.listen(boardPort, '127.0.0.1'); await once(board, 'listening');

// ── the learner's machine: own profile, own HOME, own workspace ──
const userDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hps-751-u2-'))), ws = path.join(userDir, 'ws'), fakeHome = path.join(userDir, 'home'); mkdirSync(path.join(userDir, 'User'), { recursive: true }); mkdirSync(ws, { recursive: true }); mkdirSync(fakeHome, { recursive: true });
writeFileSync(path.join(ws, 'index.html'), '<!doctype html><title>학생 작업</title><h1>SYNTHETIC LEARNER WORK</h1>\n'); writeFileSync(path.join(ws, 'notes.md'), '# 내 메모\n- 예약 버튼 위치 확인\n');
writeFileSync(path.join(userDir, 'User/settings.json'), JSON.stringify({ 'hypeproofChat.proxyUrl': origin + '/v1', 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }));
const tokenPath = path.join(home, 'synthetic-learner-token-u2.txt'); writeFileSync(tokenPath, token, { mode: 0o600 });
const workHashes = () => Object.fromEntries(readdirSync(ws).filter((f) => statSync(path.join(ws, f)).isFile()).sort().map((f) => [f, sha(path.join(ws, f))]));
const appEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD|_SECRET$|HPS_TEST|ELECTRON_RUN_AS_NODE)/.test(k)));
let app = null; const launch = () => { app = spawn(path.join(copy, 'Contents/MacOS/HypeProof Studio'), ['--user-data-dir=' + userDir, '--extensions-dir=' + path.join(userDir, 'extensions'), '--use-inmemory-secretstorage', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--remote-debugging-port=' + debugPort, '--new-window', ws], { env: { ...appEnv, HOME: fakeHome, HPS_DEV_TOKEN_FILE: tokenPath, HPS_TEST_COACH_NAME: '연습 코치', HPS_SDK_BINARY: manifest.agent_sdk.binary.path }, stdio: ['ignore', 'ignore', 'inherit'] }); app.on('exit', (code, signal) => console.log('APP_EXIT', code, signal)); return app; };

// ── seats A2/A3: connected, inbox-capable, NOT selected. They run the real device client, so "nothing arrived" is measured. ──
const synthRoot = path.join(userDir, 'synthetic-seats'), synth = {}; const memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; }; let eid = 0;
for (const [i, s] of seats.slice(1).entries()) { const caps = ['observe', 'distribution_inbox'], c = (await local.pair(s.seat_id, 1, i + 2, caps)).conn.json, store = new InboxStore(inboxDir(synthRoot, { cohort: c.student.c, run: c.class_run_id, seat: c.seat_id, student: c.student.u })), inst = local.instance(i + 2, caps), blocks = [];
  const loop = ops.startOpsSync({ outbox: await ops.OpsOutbox.open(memory(), c.grant_id, 'stream-' + s.seat_id, () => Date.now(), () => `event-u2-${String(++eid).padStart(6, '0')}`), appInstanceId: inst.app_instance_id, capabilities: caps, distribution: new InboxSession({ store, alive: () => true, clock: { mono: () => performance.now(), wall: () => Date.now() } }), sample: () => ({ idle_ms: 1 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {},
    post: async (body) => { const r = await local.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: inst.boot_id }, c.credential); if (r.json?.distribution) blocks.push(r.json.distribution); return { status: r.status, body: r.json }; } });
  synth[s.seat_id] = { loop, store, blocks }; }
const timer = setInterval(() => { for (const s of Object.values(synth)) s.loop.tick().catch(() => {}); }, 5000);

// ── driving the real window (debugging port): the workbench page for the palette, the webviews through the raw CDP target list ──
let cdp = null, win = null;
const wait = async (fn, label, ms = 60000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, 300)); } throw Error('timed out: ' + label + (last instanceof Error ? ' — ' + last.message : '')); };
async function attach() { cdp = null; win = null; for (let i = 0; i < 90 && !cdp; i++) { try { cdp = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort); } catch { await new Promise((r) => setTimeout(r, 1000)); } } assert.ok(cdp, 'the Studio copy did not open its debugging port');
  win = await wait(() => cdp.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench')), 'workbench window', 90000); await win.waitForTimeout(6000); }
const toasts = () => win.evaluate(() => [...document.querySelectorAll('.notifications-toasts .notification-list-item-message, .notifications-center .notification-list-item-message')].map((e) => e.textContent));
const palette = async (title, typed) => { await win.bringToFront(); await win.keyboard.press('F1'); await win.waitForSelector('.quick-input-widget input', { state: 'visible' }); await win.keyboard.type(title, { delay: 15 }); await wait(() => win.evaluate((t) => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => r.textContent.includes(t)), title), 'command ' + title); await win.keyboard.press('Enter');
  if (typed !== undefined) { await wait(() => win.evaluate(() => document.querySelector('.quick-input-widget')?.textContent.includes('수업 연결 코드')), 'ticket prompt'); await win.keyboard.type(typed, { delay: 10 }); await win.keyboard.press('Enter'); } };
/** A webview of this extension that is VISIBLE and contains `selector`. Returns an evaluator inside it. */
const frame = (selector, ms = 60000) => wait(async () => { for (const t of (await (await realFetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).filter((x) => x.type === 'iframe' && x.url.includes('hypeproof-chat'))) { const sock = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; }); let id = 0; const pending = new Map();
    sock.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { const [r, j] = pending.get(m.id); pending.delete(m.id); m.error ? j(Error(m.error.message)) : r(m.result); } }; const send = (method, params = {}) => new Promise((r, j) => { const n = ++id; pending.set(n, [r, j]); sock.send(JSON.stringify({ id: n, method, params })); });
    await send('Page.enable'); const { frameTree } = await send('Page.getFrameTree'); for (const f of [frameTree, ...(frameTree.childFrames || [])]) { const contextId = (await send('Page.createIsolatedWorld', { frameId: f.frame.id, worldName: 'u2-m1' })).executionContextId; const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true })).result?.value;
      if (await evaluate('document.visibilityState==="visible"&&!!document.querySelector(' + JSON.stringify(selector) + ')')) return { evaluate }; } sock.close(); } return null; }, 'webview ' + selector, ms);
/** What the learner's card list says, read from the DOM of a visible surface. `open` also opens the list and every card, as a learner would. */
const INBOX = (open) => `(async()=>{const d=document.querySelector('details.hp-inbox');if(!d)return null;if(${open}){if(!d.open)d.querySelector('summary').click();await new Promise(r=>setTimeout(r,200));for(const c of d.querySelectorAll('li.hp-inbox-card details'))if(!c.open)c.querySelector('summary').click();await new Promise(r=>setTimeout(r,300));}
 return {open:d.open,summary:d.querySelector('summary').textContent.trim(),quiet:d.classList.contains('hp-inbox-quiet'),cards:[...d.querySelectorAll('li.hp-inbox-card')].map(li=>({revision:li.dataset.inboxRevision,title:li.querySelector('.hp-inbox-title')?.textContent??'',meta:li.querySelector('.hp-inbox-meta')?.textContent??'',body:li.querySelector('.hp-inbox-body')?.textContent??''})),primaries:document.querySelectorAll('.studio-primary').length,modals:document.querySelectorAll('[role=dialog],dialog[open]').length};})()`;
const workScreen = () => frame('.hps-input textarea'), entryScreen = () => frame('.studio-connect');
const learnerState = async (chat) => chat.evaluate(`({answer:document.body.textContent.includes('로컬 시험 응답'),asked:document.body.textContent.includes('예약 버튼이 모바일에서 눌리는지'),draft:document.querySelector('.hps-input textarea').value})`);
const enterWork = async () => { const e = await frame('.studio-primary, .hps-input textarea', 120000); if (await e.evaluate("!!document.querySelector('.studio-primary')")) await e.evaluate("document.querySelector('.studio-primary').click()"); return workScreen(); };
const pairing = async () => (await local.request(local.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: 1 }, teacherToken)).json.ticket;
const connectSeat = async () => { await palette('수업 연결 (강사가 준 코드 입력)', await pairing()); await wait(async () => (await toasts()).some((t) => t.includes('수업에 연결했습니다')), 'connected'); };
const shot = async (name) => { try { await win.screenshot({ path: path.join(out, name) }); } catch (e) { console.log('screenshot skipped: ' + e.message); } };

const cleanup = () => { clearInterval(timer); try { app?.kill(); } catch {} server.close(); board.close(); local.close(); process.exit(0); }; process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);
writeFileSync(path.join(home, 'distribution-session.json'), JSON.stringify({ pid: process.pid, service: origin, board: 'http://127.0.0.1:' + boardPort + '/manage', cohort: local.cohort, instructor_token_file: path.join(home, 'synthetic-instructor-token-u2.txt'), learner_token_file: tokenPath, real_seat: 'A1', synthetic_seats: ['A2', 'A3'], student: seats[0].student_id, user_data_dir: userDir, workspace: ws, debug_port: debugPort, source_sha: head, shell: manifest.shell.version, agent_sdk: manifest.agent_sdk.version }, null, 2));
writeFileSync(path.join(home, 'synthetic-instructor-token-u2.txt'), teacherToken, { mode: 0o600 });

try {
  // ── 0. the learner: real window, class entered, paired with a one-time code, one real turn, and a draft left in the input ──
  launch(); await attach(); let chat = await enterWork(); await connectSeat();
  await chat.evaluate("(()=>{const e=document.querySelector('.hps-input textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'예약 버튼이 모바일에서 눌리는지 먼저 확인하고 싶어요');e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));})()");
  await wait(() => chat.evaluate("document.body.textContent.includes('로컬 시험 응답')"), 'first real turn answered', 120000);
  const DRAFT = '내 초안: 버튼 색을 먼저 바꿔 볼까?'; await chat.evaluate(`(()=>{const e=document.querySelector('.hps-input textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(DRAFT)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const before = { work: workHashes(), learner: await learnerState(chat) }; assert.deepEqual([before.learner.answer, before.learner.asked, before.learner.draft], [true, true, DRAFT]); assert.equal(await chat.evaluate(INBOX(false)), null, 'no inbox is drawn before anything was sent');
  step('learner ready', { seat: 'A1', turns: providerCalls.length, workspace_files: Object.keys(before.work) });

  // ── 1. the instructor, in a visible Chalk window: write → select A1 only → preview → send ──
  const browser = await chromium.launch({ headless: process.env.HPS_BOARD_HEADLESS === '1' }), page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto('http://127.0.0.1:' + boardPort + '/manage'); await page.locator('#token').fill(teacherToken); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill(prefix); await page.locator('#connect button').first().click(); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await page.locator('#ops-check').click();
  const row = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`), T = (id) => page.locator('#' + id).innerText(); await row('A3').waitFor();
  const onlyA1 = async () => { await page.locator('#ops-check').click(); await page.waitForTimeout(800); await page.locator('#ops-select-none').click(); await row('A1').getByLabel('선택').check(); };
  const sendToA1 = async (expectPlan) => { await onlyA1(); local.db.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run(); await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor(); if (expectPlan) assert.match(await T('ops-dist-plan'), expectPlan); await page.locator('#ops-dist-go').click(); await page.locator('#ops-dist-items').filter({ hasText: /^A1 · / }).waitFor(); };
  const waitResult = async (re, ms = 90000) => wait(async () => { await page.locator('#ops-dist-refresh').click(); await page.waitForTimeout(400); return re.test(await T('ops-dist-state')) || null; }, 'result ' + re, ms);
  // The instructor's first screen (1280×720, as an independent review measured it): status → selection → actions → the first student, composer and history closed.
  await page.setViewportSize({ width: 1280, height: 720 }); await page.evaluate(() => scrollTo(0, 0)); const firstScreen = await page.evaluate(() => { const top = (s) => Math.round(document.querySelector(s).getBoundingClientRect().top + scrollY); return { select: top('#ops-select-help'), action: top('#ops-dist-preview'), first_student_row: top('#ops-seats .ops-seat'), composer_open: document.querySelector('#ops-dist').open, history_open: document.querySelector('#ops-dist-history').open }; });
  assert.ok(firstScreen.select < firstScreen.action && firstScreen.action < firstScreen.first_student_row && firstScreen.first_student_row < 720, JSON.stringify(firstScreen)); assert.deepEqual([firstScreen.composer_open, firstScreen.history_open], [false, false]); await page.screenshot({ path: path.join(out, '00-instructor-first-screen-720.png') }); await page.setViewportSize({ width: 1440, height: 1100 }); step('instructor first screen', firstScreen);
  const compose = async () => { if (!(await page.locator('#ops-dist').evaluate((d) => d.open))) await page.locator('#ops-dist-summary').click(); await page.locator('#ops-dist-title').waitFor(); };
  const V1 = '오늘 수업은 3시에 끝납니다.\n끝나기 10분 전에 작업을 저장하세요.\n<b>이 글은 글자 그대로 보여야 합니다</b>';
  await compose(); await page.locator('#ops-dist-title').fill('오늘 수업 안내'); await page.locator('#ops-dist-body').fill(V1); await page.locator('#ops-dist-save').click(); await page.locator('#ops-dist-saved').filter({ hasText: '저장했습니다' }).waitFor();
  assert.equal(local.db.prepare('SELECT count(*) n FROM classroom_distributions').get().n, 0, 'saving sends nothing');
  await onlyA1(); await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor(); const impact = await T('ops-dist-impact'); assert.match(impact, /선택 1명에게 .*1번째 판.*선택하지 않은 2명에게는 아무것도 가지 않습니다/s); await page.screenshot({ path: path.join(out, '01-instructor-preview.png'), fullPage: true });
  await page.locator('#ops-dist-go').click(); await page.locator('#ops-dist-items').filter({ hasText: /^A1 · / }).waitFor(); assert.doesNotMatch(await T('ops-dist-note'), /확인만 했습니다/);
  assert.equal(await page.locator('#ops-dist').evaluate((d) => d.open), false, 'sent: the composer folds away'); assert.match(await T('ops-dist-summary'), /이 판을 보낸 배포가 아래/); assert.doesNotMatch(await page.locator('#ops-dist-saved').textContent(), /보내지지 않습니다|보내지 않았습니다/, 'the editor no longer says nobody was sent anything');
  await waitResult(/대상 1명 · 보관함 반영 1 .* 모두 반영/); assert.match(await T('ops-dist-items'), /A1 · .* — 전달: 보관함 반영 · 보관함: 지금 보관함에 있음/); await page.screenshot({ path: path.join(out, '02-instructor-result-v1.png'), fullPage: true });
  step('v1 sent from the Chalk UI', { state: await T('ops-dist-state'), observed: await T('ops-dist-observed') });

  // ── 2. the learner's real window: the card on the work screen, closed by default, opened, closed, opened AGAIN ──
  const closed = await wait(() => chat.evaluate(INBOX(false)), 'the card list on the work screen'); assert.equal(closed.open, false, 'it does not open itself over the learner\'s work'); assert.match(closed.summary, /강사가 보낸 공지·자료 1개 · 새 자료 1개/); assert.equal(closed.modals, 0);
  const opened = await chat.evaluate(INBOX(true)); assert.deepEqual(opened.cards.map((c) => [c.title, c.body, c.revision]), [['오늘 수업 안내', V1, '1']], 'the text is shown as typed, markup as characters'); assert.match(opened.cards[0].meta, /강사가 보냄 · 공지/); await shot('03-learner-work-screen-v1.png');
  await chat.evaluate("document.querySelector('details.hp-inbox').open=false"); const again = await chat.evaluate(INBOX(true)); assert.equal(again.cards[0].body, V1, 'opened again'); await wait(async () => /새 자료/.test((await chat.evaluate(INBOX(false))).summary) ? null : true, '"new" goes away once it was opened', 15000);
  const mid = await learnerState(chat); assert.deepEqual([mid.answer, mid.asked, mid.draft], [true, true, DRAFT], 'conversation and the draft in the input are untouched'); assert.deepEqual(workHashes(), before.work, 'workspace files are untouched');
  await palette('HypeProof: 시작 화면'); const entry1 = await wait(async () => (await entryScreen()).evaluate(INBOX(true)), 'the entry card shows the same list'); assert.equal(entry1.quiet, true); assert.deepEqual(entry1.cards.map((c) => [c.title, c.body]), [['오늘 수업 안내', V1]]); assert.ok(entry1.primaries <= 1, 'no second Primary on the entry card'); await shot('04-learner-entry-card-v1.png');
  step('learner sees v1 on both surfaces', { work_summary: closed.summary, entry_summary: entry1.summary });

  // ── 3. FULL quit and restart of the real app. The card must come back from disk on both surfaces. ──
  const exited = once(app, 'exit'); app.kill('SIGTERM'); await Promise.race([exited, new Promise((r) => setTimeout(r, 20000))]); try { await cdp.close(); } catch {} await new Promise((r) => setTimeout(r, 3000));
  launch(); await attach(); const entry2 = await wait(async () => { const e = await frame('.studio-connect', 120000); const v = await e.evaluate(INBOX(true)); return v && v.cards.length ? v : null; }, 'the entry card after the restart', 180000);
  assert.deepEqual(entry2.cards.map((c) => [c.title, c.body, c.revision]), [['오늘 수업 안내', V1, '1']], 'after a full restart the entry card shows the same material, from disk'); await shot('05-learner-entry-card-after-restart.png');
  chat = await enterWork(); const work2 = await wait(() => chat.evaluate(INBOX(true)), 'the work screen after the restart'); assert.deepEqual(work2.cards.map((c) => [c.title, c.body]), [['오늘 수업 안내', V1]]); assert.equal(work2.cards.length, 1, 'one card, not two'); await shot('06-learner-work-screen-after-restart.png');
  // The harness keeps secrets in memory (no Keychain prompts on an ad-hoc signed copy), so the operations credential did not
  // survive the quit and this restart shows the card WITHOUT a connection — read from disk only. The learner pairs again.
  assert.match(work2.summary, /수업 연결 확인 전/, 'not connected after the restart in this harness: the material is still readable, and the learner is told the connection is unconfirmed'); assert.doesNotMatch(work2.summary, /끝난 수업/, 'the run is still open: the device must not call it ended'); await shot('06b-learner-unconfirmed-connection.png'); await connectSeat();
  await wait(async () => /연결 확인 전|끝난 수업/.test((await chat.evaluate(INBOX(false))).summary) ? null : true, 'connected again: neither is said', 60000);
  const after = await learnerState(chat); assert.deepEqual([after.answer, after.asked], [true, true], 'the conversation is still there after the restart'); assert.deepEqual(workHashes(), before.work);
  step('full restart: the card is back on the entry card and the work screen', { reconnected_with_new_code: true, note: 'in-memory secret storage in this harness drops the operations credential on quit' });

  // ── 4. revision 2, then the same revision once more ──
  const V2 = '오늘 수업은 3시 10분에 끝납니다. (수정)\n끝나기 10분 전에 작업을 저장하세요.'; await compose(); await page.locator('#ops-dist-body').fill(V2); await page.locator('#ops-dist-save').click(); await page.locator('#ops-dist-saved').filter({ hasText: '2번째 판' }).waitFor();
  await sendToA1(/지금 전달 가능/); await waitResult(/2번째 판 · 대상 1명 · 보관함 반영 1 .* 모두 반영/); const v2card = await wait(async () => { const v = await chat.evaluate(INBOX(true)); return v.cards[0]?.revision === '2' ? v : null; }, 'the card became revision 2');
  assert.deepEqual(v2card.cards.map((c) => [c.title, c.body, c.revision]), [['오늘 수업 안내', V2, '2']], 'one card, now revision 2'); assert.match(v2card.cards[0].meta, /수정됨 \(2번째 판\)/); await shot('07-learner-work-screen-v2.png');
  await sendToA1(/이미 같은 판이 이 기기 보관함에 있음/); await waitResult(/2번째 판 · 대상 1명 · 보관함 반영 1 .* 모두 반영/); assert.match(await T('ops-dist-items'), /이미 같은 판이 이 기기 보관함에 있음 · 보관함: 지금 보관함에 있음/); assert.equal((await chat.evaluate(INBOX(true))).cards.length, 1, 'the same revision again made no second card');
  await page.screenshot({ path: path.join(out, '08-instructor-same-revision-again.png'), fullPage: true }); step('v2 replaced the card; the same revision again changed nothing on the device');

  // ── 5. withdraw the two v2 runs IN ORDER. The v1 run is never withdrawn — and must not keep or bring back anything. ──
  await page.locator('#ops-dist-revoke').click(); await page.locator('#ops-dist-revoke-go').click(); await page.locator('#ops-dist-now').filter({ hasText: '이 배포는 회수했습니다' }).waitFor(); await new Promise((r) => setTimeout(r, 12000));
  await page.locator('#ops-dist-refresh').click(); await page.waitForTimeout(500); assert.match(await T('ops-dist-items'), /같은 판의 다른 배포가 보관함을 유지/); assert.doesNotMatch(await T('ops-dist-state'), /모두 반영/); assert.match(await T('ops-dist-now'), /회수 전의 전달 기록입니다.*다른 배포로 보관함에 남아 있음 1/); assert.deepEqual((await chat.evaluate(INBOX(true))).cards.map((c) => [c.body, c.revision]), [[V2, '2']], 'the other v2 run still permits what is shown'); await page.screenshot({ path: path.join(out, '09-instructor-first-withdrawal-covered.png'), fullPage: true });
  await page.locator('#ops-dist-history summary').click(); await page.locator('#ops-dist-list button').first().click(); await page.locator('#ops-dist-object h3').waitFor(); const runsShown = page.locator('#ops-dist-object p', { hasText: '2번째 판 · 대상 1명' }); assert.equal(await runsShown.count(), 2);
  await runsShown.filter({ hasNotText: '회수됨' }).getByRole('button').click(); await page.locator('#ops-dist-state').filter({ hasNotText: '회수한 배포' }).waitFor(); await page.locator('#ops-dist-revoke').click(); await page.locator('#ops-dist-revoke-go').click(); await page.locator('#ops-dist-now').filter({ hasText: '이 배포는 회수했습니다' }).waitFor();
  const gone = await wait(async () => { const v = await chat.evaluate(INBOX(true)); return v.cards.length === 1 && !v.cards[0].body ? v : null; }, 'the card came down on the real device', 90000); assert.match(await chat.evaluate("document.querySelector('li.hp-inbox-card').textContent"), /강사가 회수한 자료입니다/); assert.equal(gone.cards[0].title, '', 'neither v2 nor v1 is shown');
  await wait(async () => { await page.locator('#ops-dist-refresh').click(); await page.waitForTimeout(400); return /보관함: 기기 보관함에서 회수됨/.test(await T('ops-dist-items')) || null; }, 'the instructor sees the device confirm the withdrawal', 90000); assert.match(await T('ops-dist-state'), /^회수한 배포 · .*보관함 반영 1/); assert.doesNotMatch(await T('ops-dist-state'), /모두 반영/); assert.match(await T('ops-dist-now'), /기기 보관함에서 회수 확인 1 · 회수 확인 불가 0 — 이 배포로 기기에 남은 자료는 없습니다/); await page.screenshot({ path: path.join(out, '10-instructor-withdrawn.png'), fullPage: true }); await shot('11-learner-work-screen-withdrawn.png');
  const end = await learnerState(chat); assert.deepEqual([end.answer, end.asked], [true, true]); assert.deepEqual(workHashes(), before.work, 'the learner\'s files were never touched');
  step('withdrawn in order: covered, then down; v1 not restored; the device confirmed it');

  // ── 6. the unselected seats, from the Service's own rows and their own disks ──
  for (const s of Object.values(synth)) await s.loop.tick(); const targets = local.db.prepare('SELECT seat_id,count(*) n FROM classroom_distribution_targets GROUP BY seat_id').all().map((r) => [r.seat_id, r.n]); assert.deepEqual(targets, [['A1', 3]], 'only A1 was ever a target');
  for (const [id, s] of Object.entries(synth)) { assert.deepEqual(s.blocks, [], id + ' was never sent a distribution block'); assert.ok(!existsSync(s.store.directory), id + ' has no inbox directory'); }
  const result = { schema: 'hps-classroom-mac-distribution/1', at: new Date().toISOString(), source_sha: head, extension_bundles: manifest.extension.bundles, shell: manifest.shell.version, agent_sdk: manifest.agent_sdk.version, real_seat: 'A1', synthetic_seats: Object.keys(synth), driven_from: 'Chalk /manage in a visible Chromium window', model: 'scripted (no real model was called)', provider_calls: providerCalls.length,
    distributions: local.db.prepare('SELECT revision,revoked_at IS NOT NULL AS revoked,revoke_reason FROM classroom_distributions ORDER BY created_at,rowid').all(), targets: local.db.prepare('SELECT t.seat_id,t.revision,t.state,t.result_code,t.device_generation FROM classroom_distribution_targets t JOIN classroom_distributions d ON d.id=t.distribution_id ORDER BY d.created_at,d.rowid').all(), card: local.db.prepare('SELECT seat_id,revision,state FROM classroom_distribution_cards').all(),
    learner: { workspace_before: before.work, workspace_after: workHashes(), conversation_kept: end.answer && end.asked, draft_kept_until_restart: mid.draft === DRAFT }, steps };
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); console.log('PASS — M1: distribution from the Chalk UI to the real Studio window → ' + path.join(out, 'result.json'));
  console.log('The instructor page (' + 'http://127.0.0.1:' + boardPort + '/manage' + ') and the learner app stay open. Control-C ends the session.'); if (process.env.HPS_BOARD_HEADLESS === '1') { await browser.close(); cleanup(); } await new Promise(() => {});
} catch (e) { console.log('M1 FAILED: ' + (e?.stack ?? e)); writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), error: String(e?.message ?? e), steps }, null, 2)); if (process.env.HPS_DIST_KEEP_ON_FAIL !== '1') cleanup(); }
