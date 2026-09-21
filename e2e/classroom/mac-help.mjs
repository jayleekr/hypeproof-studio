// Remote classroom (#751) — native voluntary help, AT-47: a REAL Studio window on this Mac → the local Service → the REAL Chalk
// /manage page → the same Studio window → the learner's own confirmation.
//
//   HPS_DEVHOST_SOURCE="<official shell>.app" HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-help node e2e/classroom/mac-devhost.mjs prepare
//   HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-help node --experimental-strip-types --experimental-sqlite --no-warnings e2e/classroom/mac-help.mjs
//
// Learner side: every control is pressed with real mouse input on the webview after checking it is visible and topmost
// (mac-window.mjs press). Instructor side: clicks on the Chalk page in a browser. Seats: A1 = this Mac (the learner who asks
// for help); A2 = a second synthetic learner, connected by the in-process device client, whose own help request (made here
// through the Service learner route) must stay untouched; A3 = the learner who takes over seat A1 in H9.
// Real: shell copy, current extension build, Agent SDK + binary, the ops connection, the help entry, Chalk, the Service router
// + SQLite, HTTP between app and Service. MADE HERE (and written so in result.json): accounts, class and tokens (synthetic),
// the model provider (scripted stand-in), the one lost answer (the local HTTP front stores the POST, then drops the socket),
// A2's request (Service learner route). NOT RUN: real model, Windows, school network, hosted D1/R2, production, children.
// Own ports (18921/18922/9521), own user-data dir, own HOME. Stays up afterwards until Control-C (HPS_BOARD_HEADLESS=1 exits).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { localOps, OPS_ALL } from '../../worker/test/harness/classroom-ops.mjs';
import { macWindow } from './mac-window.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost-help'));
const servicePort = Number(process.env.HPS_HELP_SERVICE_PORT || 18921), boardPort = Number(process.env.HPS_HELP_BOARD_PORT || 18922), debugPort = Number(process.env.HPS_HELP_DEBUG_PORT || 9521), prefix = 'help-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-', HOURS = 12;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'), json = (p) => JSON.parse(readFileSync(p, 'utf8')), out = path.join(home, 'help'); mkdirSync(out, { recursive: true });
const manifest = json(path.join(home, 'manifest.json')), copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
assert.ok(!copy.startsWith('/Applications'), 'never the installed app');
for (const [f, h] of Object.entries(manifest.extension.bundles)) { assert.equal(sha(path.join(ext, f)), h, `${f} changed since prepare`); assert.equal(sha(path.join(repo, 'extensions/hypeproof-chat', f)), h, `${f}: the prepared copy is not the current build — prepare again`); }
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', manifest.extension.source_sha, head, '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src'], { cwd: repo, encoding: 'utf8' }), '', 'extension sources changed since prepare');
assert.ok(manifest.agent_sdk?.vendored === true && manifest.agent_sdk.binary, 'the dev host has no Agent SDK: prepare again');
const steps = []; const step = (name, detail = {}) => { steps.push({ at: new Date().toISOString(), name, ...detail }); console.log('STEP ' + name + (Object.keys(detail).length ? ' ' + JSON.stringify(detail) : '')); };

// ── Service: real router + SQLite; a class and tokens that last HOURS ──
const local = await localOps(), { setRoster, startSession } = await import('../../worker/src/lib/kv.ts');
const endsAt = new Date(Date.now() + HOURS * 3600_000).toISOString();
await startSession(local.env.HPS_KV, local.cohort, { session_id: local.run, profile_id: local.profile, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: endsAt }); local.db.prepare('UPDATE sessions SET ends_at=? WHERE id=?').run(endsAt, local.run);
const learners = [1, 2, 3].map((i) => prefix + i), seats = [{ seat_id: 'A1', student_id: learners[0] }, { seat_id: 'A2', student_id: learners[1] }], course = local.lesson.course_id, V1 = local.lesson.version;
await setRoster(local.env.HPS_KV, local.cohort, learners); await local.freeze(course, V1, ['intro', 'build', 'review']);
assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true } })).status, 201);
const { issueIssuer } = await import('../../worker/src/lib/tokens.ts'), { TEST_SECRET } = await import('../../worker/test/harness/index.mjs');
const teacherToken = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: [...OPS_ALL] }] }, HOURS + 1, TEST_SECRET)).token;
const invite = async (user) => { const r = await local.request(`/admin/cohorts/${local.cohort}/authoring/${course}/versions/${V1}/participants`, 'POST', { user, hours: HOURS }, teacherToken); assert.equal(r.status, 200, r.raw); return r.json.token; };
const token = await invite(learners[0]);
Object.assign(local.env, { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-no-live-key', OPENAI_API_KEY: undefined, ANTHROPIC_PROXY_URL: undefined });

// ── the learner's machine: own profile, own HOME; the work files are fixed HERE, before anything starts ──
const userDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hps-751-help-'))), ws = path.join(userDir, 'ws'), fakeHome = path.join(userDir, 'home'); for (const d of [path.join(userDir, 'User'), ws, fakeHome]) mkdirSync(d, { recursive: true });
const ORIGINALS = { [path.join(ws, 'index.html')]: '<!doctype html><title>학생 작업</title><h1>SYNTHETIC LEARNER WORK HELP</h1>\n', [path.join(ws, 'notes.md')]: '# 내 메모\n- 예약 버튼 위치 확인\n' };
for (const [file, text] of Object.entries(ORIGINALS)) writeFileSync(file, text);
const digest = (buf) => createHash('sha256').update(buf).digest('hex'), ORIGINAL_HASHES = Object.fromEntries(Object.entries(ORIGINALS).map(([f, text]) => [f, digest(Buffer.from(text, 'utf8'))]));
const walk = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
const workFiles = () => { const now = Object.fromEntries(walk(ws).sort().map((f) => [f, digest(readFileSync(f))])); return { changed: Object.keys(ORIGINAL_HASHES).filter((f) => now[f] !== ORIGINAL_HASHES[f]).map((f) => path.relative(ws, f)), added: Object.keys(now).filter((f) => !(f in ORIGINAL_HASHES)).map((f) => path.relative(ws, f)) }; };
{ const probe = path.join(ws, 'notes.md'); writeFileSync(probe, ORIGINALS[probe] + 'tampered'); assert.deepEqual(workFiles().changed, ['notes.md'], 'negative control: a changed learner file is caught'); writeFileSync(probe, ORIGINALS[probe]); assert.deepEqual(workFiles(), { changed: [], added: [] }, 'positive control'); }

// ── the scripted model provider (no real model, no paid call) ──
const providerCalls = [], realFetch = globalThis.fetch, ANSWER = '[로컬 시험 응답] 실제 AI 모델은 호출하지 않았습니다. 예약 버튼은 화면 오른쪽 위에 있습니다.';
const enc = new TextEncoder(), ev = (e, d) => enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
const sse = (model, text) => new Response(new ReadableStream({ start(c) {
  c.enqueue(ev('message_start', { type: 'message_start', message: { id: 'synthetic-' + providerCalls.length, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
  c.enqueue(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })); c.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })); c.enqueue(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
  c.enqueue(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } })); c.enqueue(ev('message_stop', { type: 'message_stop' })); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.origin === 'https://service.test') return local.app.fetch(new Request(input, init), local.env, { waitUntil() {} });
  assert.equal(url.origin, 'https://api.anthropic.com', 'unexpected outbound request from the Service: ' + url.origin);
  const body = JSON.parse(String(init.body)); providerCalls.push({ at: Date.now(), model: body.model, stream: body.stream === true });
  return body.stream ? sse(body.model, ANSWER) : Response.json({ id: 'synthetic', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 9 } });
};
// real HTTP between the app and the Service. The faults made here: after the Service STORED a help POST its answer is dropped,
// and (at the same time) the learner's share list cannot be read — so the device cannot tell whether the request exists.
const wire = []; let dropNextHelpPost = false, failShareReads = false;
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts), url = req.url.split('?')[0];
  if (failShareReads && req.method === 'GET' && url === '/v1/classroom/shares') { wire.push({ at: Date.now(), method: 'GET', path: req.url, status: 503, injected: 'list read unavailable' }); res.writeHead(503); res.end(); return; }
  const r = await local.app.fetch(new Request('https://service.test' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), local.env, { waitUntil() {}, passThroughOnException() {} });
  if (url.startsWith('/v1/classroom/shares') || url === '/v1/classroom/help-recipient') wire.push({ at: Date.now(), method: req.method, path: req.url, status: r.status });
  if (dropNextHelpPost && req.method === 'POST' && url === '/v1/classroom/shares') { dropNextHelpPost = false; wire.push({ at: Date.now(), injected: 'answer dropped after the Service stored it', status: r.status }); req.socket.destroy(); return; }
  res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) for await (const chunk of r.body) res.write(chunk); res.end(); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
server.listen(servicePort, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
const { default: chalk } = await import('../../chalk/src/index.ts');
const board = createServer(async (req, res) => { try { const parts = []; for await (const b of req) parts.push(b); const body = Buffer.concat(parts);
  const rr = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(rr.status, Object.fromEntries(rr.headers)); res.end(Buffer.from(await rr.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
board.listen(boardPort, '127.0.0.1'); await once(board, 'listening');

writeFileSync(path.join(userDir, 'User/settings.json'), JSON.stringify({ 'hypeproofChat.proxyUrl': origin + '/v1', 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }));
const tokenPath = path.join(home, 'synthetic-learner-token-help.txt'); writeFileSync(tokenPath, token, { mode: 0o600 }); const teacherPath = path.join(home, 'synthetic-instructor-token-help.txt'); writeFileSync(teacherPath, teacherToken, { mode: 0o600 });
const appEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD|_SECRET$|HPS_TEST|ELECTRON_RUN_AS_NODE)/.test(k)));
const appArgs = ['--user-data-dir=' + userDir, '--extensions-dir=' + path.join(userDir, 'extensions'), '--use-inmemory-secretstorage', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--remote-debugging-port=' + debugPort, '--new-window', ws];
const childEnv = { ...appEnv, HOME: fakeHome, HPS_DEV_TOKEN_FILE: tokenPath, HPS_TEST_COACH_NAME: '연습 코치', HPS_SDK_BINARY: manifest.agent_sdk.binary.path };
let app = null; const launch = () => { app = spawn(path.join(copy, 'Contents/MacOS/HypeProof Studio'), appArgs, { env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] }); app.on('exit', (code, signal) => console.log('APP_EXIT', code, signal)); return app; };

// ── seat A2: a second learner connected by the real device client in this process; its help request must never change ──
const cA2 = (await local.pair('A2', 1, 2, ['observe'])).conn.json; assert.ok(cA2.grant_id, 'A2 connected');
const tokenA2 = await local.student(learners[1]);

const W = macWindow({ debugPort, realFetch, out }), { sleep, wait, attach, toasts, palette, frame, TEXTAREA, press, setDraft, pressEnter, draftOf, enterWork, shot, answers, answered, idle } = W;
const pairing = async () => (await local.request(local.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: rosterRevision }, teacherToken)).json.ticket;
let rosterRevision = 1;
const connectSeat = async (w) => { await palette(w, '수업 연결 (강사가 준 코드 입력)', await pairing()); await wait(async () => (await toasts(w)).some((t) => t.includes('수업에 연결했습니다')), 'connected'); };
const db = (sql, ...a) => local.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const sharesOf = (student) => db('SELECT id,student_id,recipient_id,session_id,kind,status,revision,content_json,feedback,next_action,expires_at FROM classroom_shares WHERE student_id=? ORDER BY created_at', student);
// Learner-side helpers on the chat webview. Values go through the element's own setter + the event React listens for.
const setValue = (chat, selector, value, event = 'input') => chat.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));return e.value;})()`);
const q = (chat, selector, expr = 'e.textContent') => chat.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e?(${expr}):null;})()`);
const helpOpen = async (chat) => { if (!(await q(chat, '.hp-help', 'e.open'))) await press(chat, '.hp-help > summary', 'the help entry in the coach rail'); await wait(() => q(chat, '.hp-help', 'e.open'), 'help panel open'); };
const helpText = (chat) => q(chat, '.hp-help', 'e.textContent') ;
const noteIs = (chat, re) => wait(async () => { const t = await q(chat, '[data-help-note]'); return t && re.test(t) ? t : null; }, 'help note ' + re, 60000);
const chatAnswers = (chat) => outsideHelp(chat, '로컬 시험 응답');
const outsideHelp = (chat, text) => chat.evaluate(`(()=>{const t=${JSON.stringify(text)};const all=(document.body.textContent.split(t).length-1);const inHelp=[...document.querySelectorAll('.hp-help')].reduce((n,e)=>n+e.textContent.split(t).length-1,0);return all-inHelp;})()`);

const session = { pid: process.pid, service: origin, instructor_url: 'http://127.0.0.1:' + boardPort + '/manage', cohort: local.cohort, profile: local.profile, student_prefix: prefix, instructor_token_file: teacherPath, learner_token_file: tokenPath, app: copy, real_seat: 'A1', second_learner_seat: 'A2', user_data_dir: userDir, workspace: ws, ports: { service: servicePort, board: boardPort, debug: debugPort }, class_ends_at: endsAt, source_sha: head, stop: 'Control-C in the terminal that runs this script (or kill -INT <pid>)' };
writeFileSync(path.join(home, 'help-session.json'), JSON.stringify(session, null, 2));
let browser = null; const cleanup = () => { try { app?.kill(); } catch {} try { void browser?.close(); } catch {} server.close(); board.close(); local.close(); process.exit(0); }; process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);

async function instructor() { browser = await chromium.launch({ headless: process.env.HPS_BOARD_HEADLESS === '1' }); const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.goto('http://127.0.0.1:' + boardPort + '/manage'); await page.locator('#token').fill(teacherToken); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill(prefix); await page.locator('#connect button').first().click(); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor();
  return { page, shot: (name) => page.screenshot({ path: path.join(out, name), fullPage: true }) }; }

const results = {};
try {
  launch(); let win = await attach(); let chat = await enterWork(); await connectSeat(win);
  const I = await instructor(), { page } = I;
  // ── R0: the learner works: one real Agent SDK turn, then an unsent draft in the composer ──
  await setDraft(chat, 'Q-HELP 예약 버튼을 만들어 줘'); await pressEnter(chat); await answered(chat, 1); await idle(chat);
  await setDraft(chat, 'DRAFT-HELP 아직 보내지 않은 내 초안'); const baseline = { draft: await draftOf(chat), answers: await chatAnswers(chat), files: workFiles(), provider_calls: providerCalls.length };
  assert.deepEqual(baseline.files, { changed: [], added: [] }); step('R0 connected real window; one Agent SDK turn; an unsent composer draft', { provider_calls: providerCalls.length });

  // A2's own help request (the second learner; made through the Service learner route, as its device would). It must stay as it is.
  const a2Assign = (await local.request('/v1/classroom/help-recipient', 'GET', undefined, tokenA2)).json; assert.equal(a2Assign.recipient_id, 'teacher-a');
  const a2 = await local.request('/v1/classroom/shares', 'POST', { id: crypto.randomUUID(), recipient_id: a2Assign.recipient_id, kind: 'help', consent: true, duration_minutes: 120, class_run_id: a2Assign.class_run_id, grant_id: a2Assign.grant_id, content: { question: '[합성] A2의 질문 — 바뀌면 안 됨' } }, tokenA2); assert.equal(a2.status, 201, a2.raw);
  const a2Before = sharesOf(learners[1]);

  // ── H1 help entry: closed by default, opened by the learner; the recipient comes from the Service, not from typing ──
  assert.equal(await q(chat, '.hp-help', 'e.open'), false, 'closed by default'); assert.equal(await q(chat, '.hp-help .primary, .hp-help .studio-primary', '1'), null, 'no Primary inside');
  await helpOpen(chat); const recipient = await wait(() => q(chat, '[data-help-recipient]', "e.getAttribute('data-help-recipient')"), 'the verified recipient');
  assert.equal(recipient, 'teacher-a'); assert.equal(await q(chat, '[data-help-question]', 'e.tagName'), 'TEXTAREA'); assert.equal(await q(chat, 'input[name=recipient], #recipient', '1'), null, 'no recipient field to type into');
  await shot(win, 'help-01-entry.png'); step('H1 help entry: rail, closed by default, recipient shown from the Service', { recipient });

  // ── H2 consent preview: the learner's question + ONE picked turn; exact content, recipient, expiry, withdrawal; consent unticked ──
  const QUESTION = 'HELP-Q1 예약 버튼을 눌러도 아무 반응이 없어요. 어디를 봐야 하나요?';
  await setValue(chat, '[data-help-question]', QUESTION); const turnValue = await q(chat, '[data-help-turn]', "[...e.options].map(o=>o.value).find(v=>v)"); assert.ok(turnValue, 'a turn of this class is offered');
  const turnLabel = await q(chat, '[data-help-turn]', `[...e.options].find(o=>o.value===${JSON.stringify(turnValue)}).textContent`); assert.match(turnLabel, /Q-HELP/);
  await setValue(chat, '[data-help-turn]', turnValue, 'change'); await setValue(chat, '[data-help-duration]', '60', 'change'); await sleep(700);
  assert.equal(sharesOf(learners[0]).length, 0, 'nothing is sent while writing');
  await press(chat, '[data-help-preview]', 'preview'); const envId = await wait(() => q(chat, '[data-help-envelope]', "e.getAttribute('data-help-envelope')"), 'the consent preview');
  const preview = { recipient: await q(chat, '[data-help-preview-recipient]'), question: await q(chat, '[data-help-preview-field="question"]'), prompt: await q(chat, '[data-help-preview-field="prompt"]'), response: await q(chat, '[data-help-preview-field="response"]'), expiry: await q(chat, '[data-help-preview-expiry]'), consent_checked: await q(chat, '[data-help-consent]', 'e.checked'), send_disabled: await q(chat, '[data-help-send]', 'e.disabled'), text: (await q(chat, '[data-help-envelope]')).replace(/\s+/g, ' ') };
  assert.deepEqual([preview.recipient, preview.question, preview.consent_checked, preview.send_disabled], ['teacher-a', QUESTION, false, true]); assert.match(preview.prompt, /Q-HELP/); assert.match(preview.response, /로컬 시험 응답/);
  assert.match(preview.text, /공유 철회/); assert.match(preview.expiry, /\d{1,2}:\d{2}.*까지 볼 수 있습니다/); assert.equal(sharesOf(learners[0]).length, 0, 'the preview sent nothing');
  await shot(win, 'help-02-consent-preview.png'); step('H2 consent preview: exact content, recipient, expiry and withdrawal shown; consent unticked; nothing stored', { envelope: envId });

  // ── H3 send ──
  await press(chat, '[data-help-consent]', 'consent'); assert.equal(await q(chat, '[data-help-send]', 'e.disabled'), false); await press(chat, '[data-help-send]', 'send');
  await noteIs(chat, /강사에게 보냈습니다/); const stored = sharesOf(learners[0]); assert.equal(stored.length, 1); const S1 = stored[0], c1 = JSON.parse(S1.content_json);
  assert.deepEqual([S1.id, S1.recipient_id, S1.session_id, S1.kind, S1.status], [envId, 'teacher-a', local.run, 'help', 'received']); assert.equal(c1.question, QUESTION); assert.match(c1.prompt, /Q-HELP/); assert.match(c1.response, /로컬 시험 응답/);
  await wait(() => q(chat, `[data-help-share="${S1.id}"]`, "e.getAttribute('data-help-status')"), 'the sent request is listed');
  assert.equal(await draftOf(chat), baseline.draft, 'the composer draft is untouched'); step('H3 sent after explicit consent; the Service stored exactly the previewed content for teacher-a in this class', { share: S1.id });

  // ── H4 instructor: the existing /manage help queue shows it; open, answer; A2 untouched; the selection stays on A1 ──
  await page.locator('#refresh').click(); const helpItem = page.locator('#ops-help-list li').filter({ hasText: learners[0] }); await helpItem.waitFor({ timeout: 30000 });
  const queue = (await page.locator('#ops-help-list').innerText()).replace(/\s+/g, ' '); assert.match(queue, new RegExp(learners[1]), 'the second learner\'s request is listed too');
  await helpItem.getByRole('button', { name: '요청 열기' }).click(); await page.locator('#detail-title').filter({ hasText: learners[0] }).waitFor();
  const opened = (await page.locator('#content').innerText()).replace(/\s+/g, ' '); assert.match(opened, /학생이 직접 쓴 질문/); assert.ok(opened.includes(QUESTION.replace(/\s+/g, ' '))); assert.match(opened, /Q-HELP/);
  await I.shot('help-03-instructor-queue-content.png');
  const FEEDBACK = 'HELP-FB1 미리보기 오른쪽 위에 예약 버튼이 있어요. 눌렀을 때 콘솔 오류가 있는지 보세요.', NEXT = 'HELP-NEXT1 버튼 onclick 이 연결됐는지 AI에게 물어보고 직접 확인하기';
  await page.locator('#review-state').selectOption('answered'); await page.locator('#feedback-text').fill(FEEDBACK); await page.locator('#next-action').fill(NEXT); await page.locator('#feedback button').click();
  await page.locator('#detail-status').filter({ hasText: '저장했습니다' }).waitFor(); await page.waitForTimeout(1500);
  const afterSave = { detail_visible: await page.locator('#detail').isVisible(), detail_title: await page.locator('#detail-title').innerText(), feedback_field: await page.locator('#feedback-text').inputValue() };
  assert.equal(afterSave.detail_visible, true); assert.match(afterSave.detail_title, new RegExp(learners[0]), 'the selected target is kept while viewing the saved feedback');
  const S1a = sharesOf(learners[0])[0]; assert.deepEqual([S1a.status, S1a.revision, S1a.feedback, S1a.next_action], ['answered', 2, FEEDBACK, NEXT]);
  assert.deepEqual(sharesOf(learners[1]), a2Before, 'the unselected learner\'s request (content, status, revision) is unchanged');
  assert.deepEqual(db("SELECT share_id FROM classroom_share_audit").map((r) => r.share_id), [S1.id], 'only the selected request was opened');
  await I.shot('help-04-instructor-answered.png'); step('H4 instructor queue → open → answered with feedback + next action; selection kept; A2 unchanged and unopened', { a2: a2Before[0].id });

  // ── H5 the same Studio window: feedback appears in the help panel only; answered ≠ resolved; work intact ──
  await wait(() => q(chat, `[data-help-share="${S1.id}"]`, "e.getAttribute('data-help-status')==='answered'"), 'the answer reached the learner window', 60000);
  const fb = { feedback: await q(chat, `[data-help-share="${S1.id}"] [data-help-feedback-text]`), next: await q(chat, `[data-help-share="${S1.id}"] [data-help-next]`), label: await q(chat, `[data-help-share="${S1.id}"] .hp-help-status`), outside: await outsideHelp(chat, 'HELP-FB1') };
  assert.deepEqual([fb.feedback, fb.next, fb.label, fb.outside], [FEEDBACK, NEXT, '강사 답변 도착 · 내 확인 전', 0]);
  assert.equal(sharesOf(learners[0])[0].status, 'answered', 'still not resolved'); assert.equal(await draftOf(chat), baseline.draft); assert.equal(await chatAnswers(chat), baseline.answers, 'nothing entered the conversation'); assert.equal(providerCalls.length, baseline.provider_calls, 'the feedback went to no model'); assert.deepEqual(workFiles(), baseline.files);
  await shot(win, 'help-05-learner-feedback.png'); step('H5 feedback shown in the help panel only (not chat, not model); status answered, not resolved; draft/files/conversation intact');

  // ── H6 the learner confirms ──
  await press(chat, `[data-help-share="${S1.id}"] [data-help-confirm]`, 'resolved'); await noteIs(chat, /해결됐다고 강사에게 알렸습니다/);
  assert.equal(sharesOf(learners[0])[0].status, 'resolved'); await page.locator('#refresh').click(); await page.waitForTimeout(1500);
  const boardAfter = (await page.locator('#shares').innerText()).replace(/\s+/g, ' '); assert.match(boardAfter, /학생 해결 확인/); assert.doesNotMatch((await page.locator('#ops-help-list').innerText()), new RegExp(learners[0]), 'a resolved request leaves the open help queue');
  await shot(win, 'help-06-learner-resolved.png'); await I.shot('help-06-instructor-resolved.png'); step('H6 only the learner\'s own confirmation resolved it; the board shows 학생 해결 확인');

  // ── H7 a lost answer: the Service stored the POST but the answer never arrives → unknown, retried with the same id, one row ──
  await setValue(chat, '[data-help-question]', 'HELP-Q2 응답이 사라져도 한 번만 저장되나요?'); await sleep(600); await press(chat, '[data-help-preview]', 'preview 2');
  const env2 = await wait(() => q(chat, '[data-help-envelope]', "e.getAttribute('data-help-envelope')"), 'second preview'); await press(chat, '[data-help-consent]', 'consent 2');
  dropNextHelpPost = true; failShareReads = true; await press(chat, '[data-help-send]', 'send 2'); await noteIs(chat, /보냈는지 확인하지 못했습니다/);
  assert.ok(await q(chat, '[data-help-stale]', '1'), 'the failed list read is said, not shown as zero'); assert.match(await q(chat, '.hp-help > summary'), /보냈는지 확인 필요/);
  assert.equal(await q(chat, '[data-help-pending]', "e.getAttribute('data-help-pending')"), env2); assert.equal(db('SELECT count(*) n FROM classroom_shares WHERE id=?', env2)[0].n, 1, 'the Service did store it');
  await shot(win, 'help-07-lost-answer.png'); failShareReads = false; const postsBefore = wire.filter((w) => w.method === 'POST' && w.path?.startsWith('/v1/classroom/shares')).length; await press(chat, '[data-help-retry]', 'retry'); await wait(async () => !(await q(chat, '[data-help-pending]', '1')), 'the pending request was reconciled');
  assert.equal(db('SELECT count(*) n FROM classroom_shares WHERE id=?', env2)[0].n, 1); assert.equal(db('SELECT count(*) n FROM classroom_shares WHERE student_id=?', learners[0])[0].n, 2, 'no duplicate');
  const retryWire = wire.filter((w) => w.path?.startsWith('/v1/classroom/shares') && w.method === 'POST'); assert.equal(retryWire.length, postsBefore, 'the retry found it by reading — no second POST');
  step('H7 lost answer + unreadable list → unknown (not zero, not sent) → 다시 확인 found the stored request by id; one row, no second POST', { posts: retryWire.length });

  // ── H8 withdraw: the learner withdraws the second request; the instructor can no longer open it ──
  await wait(() => q(chat, `[data-help-share="${env2}"]`, '1'), 'second request listed'); await press(chat, `[data-help-share="${env2}"] [data-help-withdraw]`, 'withdraw'); await noteIs(chat, /공유를 철회했습니다/);
  assert.equal(db('SELECT count(*) n FROM classroom_shares WHERE id=?', env2)[0].n, 0); assert.equal((await local.request(`/admin/cohorts/${local.cohort}/classroom/shares/${env2}`, 'GET', undefined, teacherToken)).status, 404);
  step('H8 withdrawal removes the share; the instructor read is 404');

  // ── H9 learner replacement: an unsent help draft of learner 1; seat A1 goes to learner 3; nothing of learner 1 is shown or sent ──
  const OLD = 'OLD-LEARNER-DRAFT 이전 학생의 보내지 않은 질문'; await setValue(chat, '[data-help-question]', OLD); await sleep(1200);
  const replaced = await local.request(local.base, 'PUT', { expected_roster_revision: rosterRevision, seats: [{ seat_id: 'A1', student_id: learners[2] }, seats[1]], flags: { ops_observe: true } }, teacherToken); assert.equal(replaced.status, 200, replaced.raw); rosterRevision++;
  await wait(async () => (await q(chat, '[data-help-unavailable]', "e.getAttribute('data-help-unavailable')")) === 'not_paired', 'the old learner\'s window lost its class connection', 90000);
  assert.equal(await q(chat, '[data-help-question]', '1'), null, 'the draft is not shown once the class connection is gone'); assert.equal((await helpText(chat)).includes('OLD-LEARNER-DRAFT'), false);
  await shot(win, 'help-08-seat-replaced.png');
  // Learner 3 enters the way a learner does on a shared PC: the app is restarted (no dev token file), and on the start page
  // 수업에 참여하기 → the code the instructor issued → 코드 확인하기 → start.
  const token3 = await invite(learners[2]); writeFileSync(tokenPath, '', { mode: 0o600 }); app.kill(); await once(app, 'exit'); await sleep(1500);
  launch(); win = await attach();
  const start = await frame('.studio-start', 'true', 120000);
  const startButton = async (text) => { await wait(() => start.evaluate(`[...document.querySelectorAll('button')].some(x=>x.textContent.includes(${JSON.stringify(text)})&&!x.disabled)`), text);
    await start.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)})&&!x.disabled);b.setAttribute('data-hps-runner',${JSON.stringify(text)});})()`); await press(start, `[data-hps-runner=${JSON.stringify(text)}]`, text); };
  await startButton('수업에 참여하기'); await press(start, '#course-code', 'the code field'); await start.send('Input.insertText', { text: token3 }); await startButton('코드 확인하기');
  await wait(() => start.evaluate("(()=>{const b=document.querySelector('.studio-primary');return !!b&&!b.disabled})()"), 'the start button for the checked code', 60000);
  // Starting opens the lesson's work folder, which reloads the window. This harness keeps secrets in memory only
  // (--use-inmemory-secretstorage), so the reloaded window would forget the code just typed; the same code is handed to it
  // through the dev token file (a harness seam — a real install keeps it in the Keychain, NOT RUN here).
  writeFileSync(tokenPath, token3, { mode: 0o600 }); await press(start, '.studio-primary', 'start');
  await sleep(8000); win = (await wait(() => W.workbenches().find((p) => !p.isClosed()), 'the reloaded workbench', 90000)); chat = await enterWork(); await connectSeat(win); await helpOpen(chat);
  await wait(() => q(chat, '[data-help-recipient]', "e.getAttribute('data-help-recipient')"), 'learner 3 sees a recipient');
  const l3 = { question: await q(chat, '[data-help-question]', 'e.value'), cards: await chat.evaluate("document.querySelectorAll('[data-help-share]').length"), leaked: (await helpText(chat)).includes('OLD-LEARNER-DRAFT') || (await helpText(chat)).includes('HELP-Q1') || (await helpText(chat)).includes('HELP-FB1'), turns: await q(chat, '[data-help-turn]', '[...e.options].filter(o=>o.value).length') };
  assert.deepEqual(l3, { question: '', cards: 0, leaked: false, turns: 0 }, 'learner 3 inherits no draft, no request, no feedback and no earlier turn');
  assert.equal(db('SELECT count(*) n FROM classroom_shares WHERE student_id=?', learners[2])[0].n, 0, 'nothing was sent as learner 3');
  await shot(win, 'help-09-new-learner.png'); step('H9 seat A1 → learner 3: old draft hidden when the connection ended; after re-entry learner 3 sees no draft, request, feedback or earlier turn', l3);

  results.H = { recipient, preview, stored: { id: S1.id, recipient_id: S1.recipient_id, session_id: S1.session_id, fields: Object.keys(c1).filter((k) => c1[k]) }, instructor: { queue, opened_fields: ['학생이 직접 쓴 질문', '학생 프롬프트', 'AI 응답'].filter((l) => opened.includes(l)), after_save: afterSave }, learner_feedback: fb, a2_unchanged: true, lost_answer: { id: env2, rows: 1, posts: retryWire.length }, learner_replacement: l3 };
  const result = { schema: 'hps-classroom-mac-help/1', at: new Date().toISOString(), source_sha: head, extension_source_sha: manifest.extension.source_sha, shell: manifest.shell, agent_sdk: { version: manifest.agent_sdk.version, binary_sha256: manifest.agent_sdk.binary.sha256 },
    served_manage_sha256: digest(Buffer.from(await (await realFetch('http://127.0.0.1:' + boardPort + '/manage')).arrayBuffer())), manage_source_sha256: sha(path.join(repo, 'chalk/src/ui/manage.html')), service_classroom_ts_sha256: sha(path.join(repo, 'worker/src/routes/classroom.ts')),
    real: ['Studio shell copy', 'current extension build', 'Agent SDK + binary', 'ops connection (pairing code typed in the palette)', 'the help entry in the coach rail', 'Chalk /manage page', 'Service router + SQLite', 'HTTP between app and Service'],
    made_here: ['accounts, class and tokens (synthetic)', 'model provider (scripted stand-in)', 'A2\'s help request through the Service learner route', 'one dropped answer after the Service stored a POST, with the share list unreadable until the learner retried (local HTTP front)', 'learner 3 entering after an app restart by typing their issued code on the start page; the reloaded lesson window receives the same code through the dev token file (in-memory secret storage)'],
    not_run: ['real model', 'Windows', 'school network', 'hosted/staging/production D1/R2', 'children / guardian consent (#1175)', 'several physical devices', 'Keychain-backed installed app'],
    results, provider_calls: providerCalls.length, wire, steps };
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log('PASS — AT-47 native help loop → ' + path.join(out, 'result.json'));
  console.log('The instructor page (' + session.instructor_url + ') and the learner app stay open until ' + endsAt + '. Control-C ends the session.'); if (process.env.HPS_BOARD_HEADLESS === '1') cleanup(); await new Promise(() => {});
} catch (e) {
  console.log('HELP FAILED: ' + (e?.stack ?? e)); writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), error: String(e?.message ?? e), steps, results, wire: wire.slice(-30), shares: db('SELECT id,student_id,status,revision FROM classroom_shares') }, null, 2));
  try { const w = W.workbenches()[0]; if (w) await shot(w, 'failure-learner.png'); } catch {} if (process.env.HPS_BOARD_HEADLESS === '1') cleanup(); await new Promise(() => {});
}
