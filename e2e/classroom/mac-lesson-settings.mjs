// Remote classroom operations (#751, U3) — AT-46 M2: a prompt and lesson settings from the REAL Chalk UI to REAL Studio windows on this Mac.
//
//   HPS_DEVHOST_SOURCE="<official shell>.app" HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-u3 node e2e/classroom/mac-devhost.mjs prepare
//   HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-u3 node --experimental-strip-types --experimental-sqlite --no-warnings e2e/classroom/mac-lesson-settings.mjs
//
// Everything the instructor does is done THROUGH THE CHALK PAGE in a visible browser window. Everything about the learner is
// done in and read from REAL Studio windows (the copied official shell + the current extension build + the real Agent SDK
// binary) over the debugging port: the draft, a pasted image, "초안에 가져오기", real questions, a question that is still
// being answered while the setting changes, a second window, two settings in a row, a withdrawal and the return.
// Real: shell copy, extension, SDK + binary, the ops sync loop, the inbox on disk, the switch request, the turn close, Chalk,
// the Service router + SQLite with lesson bindings enforced, real HTTP between the app and the Service (the proxy path).
// Synthetic: accounts, the lessons, and the MODEL PROVIDER — a scripted recorder that answers protocol-complete streams. It
// says nothing about a real model's quality, latency or cost. Seat A2 runs the real device client in this process and is
// never selected. Own ports (18781/18782/9381), own user-data dir, own HOME: the U2 runner (18771/18772/9371), the older
// demo (18761/18762), the installed app and the user's Studio data are not touched.
// Says nothing about Windows, a school network, several physical devices, staging or production, mail, or the Keychain.
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
import { INBOX_CAPABILITY, INBOX_PROMPT_CAPABILITY, LESSON_BINDING_CAPABILITY } from '../../extensions/hypeproof-chat/src/classroomInbox.ts';
import { InboxSession, InboxStore, inboxDir } from '../../extensions/hypeproof-chat/src/classroomInboxStore.ts';
import { proxyChat } from '../../extensions/hypeproof-chat/src/proxyClient.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost-u3'));
const servicePort = Number(process.env.HPS_U3_SERVICE_PORT || 18781), boardPort = Number(process.env.HPS_U3_BOARD_PORT || 18782), debugPort = Number(process.env.HPS_U3_DEBUG_PORT || 9381), prefix = 'u3-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-', HOURS = 12;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'), json = (p) => JSON.parse(readFileSync(p, 'utf8')), out = path.join(home, 'lesson-settings'); mkdirSync(out, { recursive: true });
const manifest = json(path.join(home, 'manifest.json')), copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
assert.ok(!copy.startsWith('/Applications'), 'never the installed app');
for (const [f, h] of Object.entries(manifest.extension.bundles)) { assert.equal(sha(path.join(ext, f)), h, `${f} changed since prepare`); assert.equal(sha(path.join(repo, 'extensions/hypeproof-chat', f)), h, `${f}: the prepared copy is not the current build — prepare again`); }
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', manifest.extension.source_sha, head, '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src'], { cwd: repo, encoding: 'utf8' }), '', 'extension sources changed since prepare');
assert.ok(manifest.agent_sdk?.vendored === true && manifest.agent_sdk.binary, 'the dev host has no Agent SDK: prepare again');
const steps = []; const step = (name, detail = {}) => { steps.push({ at: new Date().toISOString(), name, ...detail }); console.log('STEP ' + name + (Object.keys(detail).length ? ' ' + JSON.stringify(detail) : '')); };

// ── Service: real router + SQLite. The class and its tokens last HOURS so that a person can keep using what is left running. ──
const local = await localOps(), { setRoster, startSession } = await import('../../worker/src/lib/kv.ts'), { readLesson } = await import('../../worker/src/lib/lesson-delivery.ts');
const endsAt = new Date(Date.now() + HOURS * 3600_000).toISOString();
await startSession(local.env.HPS_KV, local.cohort, { session_id: local.run, profile_id: local.profile, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: endsAt }); local.db.prepare('UPDATE sessions SET ends_at=? WHERE id=?').run(endsAt, local.run);
const seats = ['A1', 'A2'].map((id, i) => ({ seat_id: id, student_id: prefix + (i + 1) })), KEY = () => crypto.randomUUID();
const course = local.lesson.course_id, V1 = local.lesson.version, V2 = 'm2026.09.18-2', V3 = 'm2026.09.18-3';
await setRoster(local.env.HPS_KV, local.cohort, seats.map((s) => s.student_id)); await local.freeze(course, V1, ['intro', 'build', 'review']);
{ const a = `/admin/cohorts/${local.cohort}/authoring/${course}`, st = (id) => ({ id, title: id, instructions: '합성 단계 ' + id, hint: '', acceptance: '합성 기준' });
  for (const [v, ids, title] of [[V2, ['intro', 'craft-v2', 'review'], '합성 수업 2판'], [V3, ['intro', 'craft-v3'], '합성 수업 3판']]) { const cur = (await local.request(a)).json;
    const saved = await local.request(a, 'PUT', { profile_id: local.profile, request_id: KEY(), expected_revision: cur.revision ?? cur.draft?.revision, content: { schema: 'hps-session-design/1', title, audience: '합성 사용자', duration_minutes: 60, objective: '원격 운영 시험', prerequisites: '없음', starter: '연습 폴더', steps: ids.map(st) } }); assert.equal(saved.status, 200, saved.raw);
    assert.equal((await local.request(`${a}/versions/${v}`, 'PUT', { expected_revision: saved.json.revision })).status, 200); } }
const lessonSha = {}; for (const v of [V1, V2, V3]) lessonSha[v] = (await readLesson(local.env, local.cohort, course, v, local.profile)).sha256;
// Stage 0 runs with U3 OFF (no enforcement, no switch): what U1/U2 users have today.
assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_distribute: true } })).status, 201); let roster = 1;
const { issueIssuer } = await import('../../worker/src/lib/tokens.ts'), { TEST_SECRET } = await import('../../worker/test/harness/index.mjs');
const teacherToken = (await issueIssuer({ issuer: 'teacher-a' /* the lesson was drafted and frozen by this instructor id */, scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: [...OPS_ALL, 'distribute', 'lesson_settings'] }] }, HOURS + 1, TEST_SECRET)).token;
const invite = async (user) => { const r = await local.request(`/admin/cohorts/${local.cohort}/authoring/${course}/versions/${V1}/participants`, 'POST', { user, hours: HOURS }, teacherToken); assert.equal(r.status, 200, r.raw); return r.json.token; };
const token = await invite(seats[0].student_id), tokenA2 = await invite(seats[1].student_id);
Object.assign(local.env, { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-no-live-key', OPENAI_API_KEY: undefined, ANTHROPIC_PROXY_URL: undefined });

// ── the ONLY scripted thing: the model provider. It records which lesson each call ran under, and can hold one answer open. ──
const providerCalls = [], realFetch = globalThis.fetch, ANSWER = '[로컬 시험 응답] 실제 AI 모델은 호출하지 않았습니다.'; let releaseHold = null, holding = 0;
const enc = new TextEncoder(), ev = (e, d) => enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
function sse(model, text, gate) { const id = 'synthetic-' + providerCalls.length;
  return new Response(new ReadableStream({ async start(c) {
    c.enqueue(ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })); c.enqueue(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    c.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 8) } })); if (gate) await gate;
    c.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(8) } })); c.enqueue(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
    c.enqueue(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } })); c.enqueue(ev('message_stop', { type: 'message_stop' })); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }); }
const HOLD = 'HOLD-THIS-ANSWER'; let holdGate = null;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.origin === 'https://service.test') return local.app.fetch(new Request(input, init), local.env, { waitUntil() {} });
  assert.equal(url.origin, 'https://api.anthropic.com', 'unexpected outbound request from the Service: ' + url.origin);
  const raw = String(init.body), body = JSON.parse(raw), lesson = raw.includes('craft-v3') ? V3 : raw.includes('craft-v2') ? V2 : V1, held = raw.includes(HOLD) && !!holdGate;
  const marks = ['Q0-OFF', 'Q-PROMPT', 'Q-V2', HOLD, 'Q-WINDOW2', 'Q-V3', 'Q-AFTER-WITHDRAW', 'Q-HOME', 'Q-A2', 'Q-PROXY'].filter((m) => raw.includes(m));
  providerCalls.push({ at: Date.now(), model: body.model, stream: body.stream === true, tools: (body.tools ?? []).length, lesson, marks, held, image: raw.includes('"type":"image"'), prompt_text: raw.includes('세 문장으로 설명') });
  if (held) holding++;
  return body.stream ? sse(body.model, ANSWER, held ? holdGate : null) : Response.json({ id: 'synthetic', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 9 } });
};
// What the app really sent to the Service, over real HTTP: path, status, and the two U3 headers (never the Authorization value).
const wire = [];
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts);
  const r = await local.app.fetch(new Request('https://service.test' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), local.env, { waitUntil() {}, passThroughOnException() {} });
  let switched; if (req.url.startsWith('/v1/classroom/ops/lesson-binding')) { try { const j = await r.clone().json(); switched = { recorded: j.recorded === true, replayed: j.replayed === true, reason: j.reason ?? null, seq: j.binding?.seq ?? null }; } catch { switched = null; } }
  if (/^\/v1\/(messages|chat|profile|lesson-turns|classroom\/ops\/lesson-binding)/.test(req.url)) wire.push({ ...(switched !== undefined ? { switched } : {}), at: Date.now(), method: req.method, path: req.url.split('?')[0].replace(/lesson-turns\/[^/]+/, 'lesson-turns/:turn'), status: r.status, turn: req.headers['x-hps-turn-id'] ? String(req.headers['x-hps-turn-id']).slice(0, 8) : null, binding: req.headers['x-hps-lesson-binding'] ?? null });
  res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) for await (const chunk of r.body) res.write(chunk); res.end(); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
server.listen(servicePort, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
const { default: chalk } = await import('../../chalk/src/index.ts');
const board = createServer(async (req, res) => { try { const parts = []; for await (const b of req) parts.push(b); const body = Buffer.concat(parts);
  const rr = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(rr.status, Object.fromEntries(rr.headers)); res.end(Buffer.from(await rr.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
board.listen(boardPort, '127.0.0.1'); await once(board, 'listening');

// ── the learner's machine: own profile, own HOME, two workspaces (two windows of the same app) ──
const userDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hps-751-u3-'))), ws = path.join(userDir, 'ws'), ws2 = path.join(userDir, 'ws-second-window'), fakeHome = path.join(userDir, 'home'); for (const d of [path.join(userDir, 'User'), ws, ws2, fakeHome]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(ws, 'index.html'), '<!doctype html><title>학생 작업</title><h1>SYNTHETIC LEARNER WORK</h1>\n'); writeFileSync(path.join(ws, 'notes.md'), '# 내 메모\n- 예약 버튼 위치 확인\n'); writeFileSync(path.join(ws2, 'second.md'), '# 두 번째 창\n');
writeFileSync(path.join(userDir, 'User/settings.json'), JSON.stringify({ 'hypeproofChat.proxyUrl': origin + '/v1', 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }));
const tokenPath = path.join(home, 'synthetic-learner-token-u3.txt'); writeFileSync(tokenPath, token, { mode: 0o600 }); const teacherPath = path.join(home, 'synthetic-instructor-token-u3.txt'); writeFileSync(teacherPath, teacherToken, { mode: 0o600 });
const workHashes = () => Object.fromEntries(readdirSync(ws).filter((f) => statSync(path.join(ws, f)).isFile()).sort().map((f) => [f, sha(path.join(ws, f))]));
const appEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD|_SECRET$|HPS_TEST|ELECTRON_RUN_AS_NODE)/.test(k)));
const appArgs = (folder) => ['--user-data-dir=' + userDir, '--extensions-dir=' + path.join(userDir, 'extensions'), '--use-inmemory-secretstorage', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--remote-debugging-port=' + debugPort, '--new-window', folder];
const childEnv = { ...appEnv, HOME: fakeHome, HPS_DEV_TOKEN_FILE: tokenPath, HPS_TEST_COACH_NAME: '연습 코치', HPS_SDK_BINARY: manifest.agent_sdk.binary.path };
let app = null; const launch = () => { app = spawn(path.join(copy, 'Contents/MacOS/HypeProof Studio'), appArgs(ws), { env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] }); app.on('exit', (code, signal) => console.log('APP_EXIT', code, signal)); return app; };

// ── seat A2: connected, fully capable, NEVER selected. It runs the real device client, so "nothing arrived" is measured. ──
const synthRoot = path.join(userDir, 'synthetic-seats'), memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; }; let eid = 0;
const capsA2 = ['observe', INBOX_CAPABILITY, INBOX_PROMPT_CAPABILITY, LESSON_BINDING_CAPABILITY], cA2 = (await local.pair('A2', 1, 2, capsA2)).conn.json, storeA2 = new InboxStore(inboxDir(synthRoot, { cohort: cA2.student.c, run: cA2.class_run_id, seat: cA2.seat_id, student: cA2.student.u })), instA2 = local.instance(2, capsA2), blocksA2 = [];
const loopA2 = ops.startOpsSync({ outbox: await ops.OpsOutbox.open(memory(), cA2.grant_id, 'stream-A2', () => Date.now(), () => `event-u3m-${String(++eid).padStart(6, '0')}`), appInstanceId: instA2.app_instance_id, capabilities: capsA2, distribution: new InboxSession({ store: storeA2, alive: () => true, clock: { mono: () => performance.now(), wall: () => Date.now() } }), sample: () => ({ idle_ms: 1 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {},
  post: async (body) => { const r = await local.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: instA2.boot_id }, cA2.credential); if (r.json?.distribution) blocksA2.push(r.json.distribution); return { status: r.status, body: r.json }; } });
const timer = setInterval(() => { loopA2.tick().catch(() => {}); }, 5000);

// ── driving the real windows (debugging port) ──
let cdp = null;
const wait = async (fn, label, ms = 60000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, 300)); } throw Error('timed out: ' + label + (last instanceof Error ? ' — ' + last.message : '')); };
const workbenches = () => cdp.contexts().flatMap((c) => c.pages()).filter((p) => p.url().includes('workbench'));
async function attach() { cdp = null; for (let i = 0; i < 90 && !cdp; i++) { try { cdp = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort); } catch { await new Promise((r) => setTimeout(r, 1000)); } } assert.ok(cdp, 'the Studio copy did not open its debugging port'); const w = await wait(() => workbenches()[0], 'workbench window', 90000); await w.waitForTimeout(6000); return w; }
const toasts = (w) => w.evaluate(() => [...document.querySelectorAll('.notifications-toasts .notification-list-item-message, .notifications-center .notification-list-item-message')].map((e) => e.textContent));
const palette = async (w, title, typed) => { await w.bringToFront(); await w.keyboard.press('F1'); await w.waitForSelector('.quick-input-widget input', { state: 'visible' }); await w.keyboard.type(title, { delay: 15 }); await wait(() => w.evaluate((t) => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => r.textContent.includes(t)), title), 'command ' + title); await w.keyboard.press('Enter');
  if (typed !== undefined) { await wait(() => w.evaluate(() => document.querySelector('.quick-input-widget')?.textContent.includes('수업 연결 코드')), 'ticket prompt'); await w.keyboard.type(typed, { delay: 10 }); await w.keyboard.press('Enter'); } };
/** A VISIBLE webview of this extension that contains `selector` and satisfies `where` (an expression evaluated inside it). Two windows → two such webviews. */
const frame = (selector, where = 'true', ms = 60000) => wait(async () => { for (const t of (await (await realFetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).filter((x) => x.type === 'iframe' && x.url.includes('hypeproof-chat'))) { const sock = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; }); let id = 0; const pending = new Map();
    sock.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { const [r, j] = pending.get(m.id); pending.delete(m.id); m.error ? j(Error(m.error.message)) : r(m.result); } }; const send = (method, params = {}) => new Promise((r, j) => { const n = ++id; pending.set(n, [r, j]); sock.send(JSON.stringify({ id: n, method, params })); });
    await send('Page.enable'); const { frameTree } = await send('Page.getFrameTree'); for (const f of [frameTree, ...(frameTree.childFrames || [])]) { const contextId = (await send('Page.createIsolatedWorld', { frameId: f.frame.id, worldName: 'u3-m2' })).executionContextId; const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true })).result?.value;
      if (await evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')&&!!(' + where + ')')) return { evaluate }; } sock.close(); } return null; }, 'webview ' + selector + ' where ' + where, ms);
const TEXTAREA = '.hps-input textarea', hasText = (t) => 'document.body.textContent.includes(' + JSON.stringify(t) + ')';
const setDraft = (chat, text) => chat.evaluate(`(()=>{const e=document.querySelector('${TEXTAREA}');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();})()`);
const pressEnter = (chat) => chat.evaluate(`(()=>{const e=document.querySelector('${TEXTAREA}');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));})()`);
const draftOf = (chat) => chat.evaluate(`document.querySelector('${TEXTAREA}').value`), attachments = (chat) => chat.evaluate("document.querySelectorAll('.hps-attachment').length");
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pasteImage = (chat) => chat.evaluate(`(()=>{const e=document.querySelector('${TEXTAREA}'),b=Uint8Array.from(atob('${PNG}'),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([b],'shot.png',{type:'image/png'}));e.focus();e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
const INBOX = (open) => `(async()=>{const d=document.querySelector('details.hp-inbox');if(!d)return null;if(${open}){if(!d.open)d.querySelector('summary').click();await new Promise(r=>setTimeout(r,200));for(const c of d.querySelectorAll('li.hp-inbox-card details'))if(!c.open)c.querySelector('summary').click();await new Promise(r=>setTimeout(r,300));}
 return {open:d.open,summary:d.querySelector('summary').textContent.trim(),cards:[...d.querySelectorAll('li.hp-inbox-card')].map(li=>({revision:li.dataset.inboxRevision,title:li.querySelector('.hp-inbox-title')?.textContent??'',meta:[...li.querySelectorAll('.hp-inbox-meta')].map(m=>m.textContent).join(' | '),body:li.querySelector('.hp-inbox-body')?.textContent??'',setting:li.querySelector('[data-inbox-setting]')?.dataset.inboxSetting??null,canImport:!!li.querySelector('[data-inbox-import]')})),modals:document.querySelectorAll('[role=dialog],dialog[open]').length};})()`;
const enterWork = async (where) => { const e = await frame('.studio-primary, ' + TEXTAREA, where, 120000); if (await e.evaluate("!!document.querySelector('.studio-primary')")) await e.evaluate("document.querySelector('.studio-primary').click()"); return frame(TEXTAREA, where); };
const pairing = async () => (await local.request(local.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: roster }, teacherToken)).json.ticket;
const connectSeat = async (w) => { await palette(w, '수업 연결 (강사가 준 코드 입력)', await pairing()); await wait(async () => (await toasts(w)).some((t) => t.includes('수업에 연결했습니다')), 'connected'); };
const shot = async (w, name) => { try { await w.screenshot({ path: path.join(out, name) }); } catch (e) { console.log('screenshot skipped: ' + e.message); } };
const db = (sql, ...a) => local.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const bindings = () => db('SELECT binding_seq,source,version,first_dispatched_at IS NOT NULL AS dispatched,first_completed_at IS NOT NULL AS completed FROM classroom_lesson_bindings WHERE student_id=? ORDER BY binding_seq', seats[0].student_id);
const turns = () => db('SELECT substr(turn_id,1,8) AS turn,binding_seq,version,closed_at IS NOT NULL AS closed,close_outcome,first_dispatched_at IS NOT NULL AS dispatched,first_completed_at IS NOT NULL AS completed,last_failure_kind FROM classroom_lesson_turns WHERE student_id=? ORDER BY admitted_at', seats[0].student_id);
const ask = async (chat, text, mark) => { const n = providerCalls.length; await setDraft(chat, text); await pressEnter(chat); await wait(() => providerCalls.slice(n).some((c) => c.marks.includes(mark)), 'the provider was called for ' + mark, 120000); };
const answered = (chat, count) => wait(() => chat.evaluate(`(document.body.textContent.match(/로컬 시험 응답/g)||[]).length>=${count}`), count + ' answers on screen', 120000);

const session = { pid: process.pid, service: origin, instructor_url: 'http://127.0.0.1:' + boardPort + '/manage', cohort: local.cohort, student_prefix: prefix, instructor_token_file: teacherPath, learner_token_file: tokenPath, app: copy, real_seat: 'A1', synthetic_seat: 'A2', student: seats[0].student_id, user_data_dir: userDir, workspaces: [ws, ws2], ports: { service: servicePort, instructor: boardPort, app_debug: debugPort }, valid_until: endsAt, source_sha: head, extension_source_sha: manifest.extension.source_sha, shell: manifest.shell.version, agent_sdk: manifest.agent_sdk.version };
writeFileSync(path.join(home, 'lesson-settings-session.json'), JSON.stringify(session, null, 2));
const cleanup = () => { clearInterval(timer); try { app?.kill(); } catch {} server.close(); board.close(); local.close(); process.exit(0); }; process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);

try {
  // ── 0. U3 OFF (the default): a real turn, a U2 notice — and nothing of U3 exists on the wire, in the rows or on the screen ──
  launch(); const win = await attach(); let chat = await enterWork(); await connectSeat(win);
  await ask(chat, 'Q0-OFF 예약 버튼이 모바일에서 눌리는지 먼저 확인하고 싶어요', 'Q0-OFF'); await answered(chat, 1);
  assert.deepEqual(turns(), [], 'U3 off: no turn is admitted or recorded'); assert.ok(wire.filter((w) => w.path === '/v1/lesson-turns/:turn/close').every((w) => w.status === 200 || w.status === 404), 'a close from a U3 app against a Service without enforcement is harmless');
  const profileOff = await (await realFetch(origin + '/v1/profile', { headers: { authorization: 'Bearer ' + token } })).json(); assert.equal(profileOff.lesson_binding, undefined, 'U3 off: the profile says nothing about bindings'); assert.equal(profileOff.lesson.version, V1);
  const browser = await chromium.launch({ headless: process.env.HPS_BOARD_HEADLESS === '1' }), page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.goto('http://127.0.0.1:' + boardPort + '/manage'); await page.locator('#token').fill(teacherToken); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill(prefix); await page.locator('#connect button').first().click(); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await page.locator('#ops-check').click();
  const row = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`), T = (id) => page.locator('#' + id).innerText(); await row('A2').waitFor();
  const compose = async () => { if (!(await page.locator('#ops-dist').evaluate((d) => d.open))) await page.locator('#ops-dist-summary').click(); await page.locator('#ops-dist-title').waitFor(); };
  const kinds = () => page.locator('#ops-dist-kind option').evaluateAll((os) => os.filter((o) => !o.hidden && !o.disabled).map((o) => o.value));
  const onlyA1 = async () => { await page.locator('#ops-check').click(); await page.waitForTimeout(800); await page.locator('#ops-select-none').click(); await row('A1').getByLabel('선택').check(); };
  const saveForm = async () => { await page.locator('#ops-dist-save').click(); await page.locator('#ops-dist-saved').filter({ hasText: '저장했습니다' }).waitFor(); };
  const sendToA1 = async () => { await onlyA1(); local.db.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run(); await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor(); const impact = await T('ops-dist-impact'); assert.equal(await page.locator('#ops-dist-go').innerText(), '1명에게 보내기'); await page.locator('#ops-dist-go').click(); await page.locator('#ops-dist-items').filter({ hasText: /^A1 · / }).waitFor(); return impact; };
  const newMaterial = async (kind, title, body) => { await compose(); await page.locator('#ops-dist-new').click(); await page.locator('#ops-dist-kind').selectOption(kind); await page.locator('#ops-dist-title').fill(title); await page.locator('#ops-dist-body').fill(body); };
  const items = async (re, label, ms = 90000) => wait(async () => { await page.locator('#ops-dist-refresh').click(); await page.waitForTimeout(400); const t = await T('ops-dist-items'); return re.test(t) ? t : null; }, label ?? String(re), ms);
  await compose(); assert.deepEqual(await kinds(), ['notice', 'material', 'prompt'], 'U3 off for this run: the instructor holds `lesson_settings`, and the setting kind is still not offered');
  await newMaterial('notice', '오늘 수업 안내', '끝나기 10분 전에 작업을 저장하세요.'); await saveForm(); await sendToA1(); await items(/A1 · .* — 전달: 보관함 반영 · 보관함: 지금 보관함에 있음/, 'the U2 notice reached the real window');
  const notice = await wait(async () => { const v = await chat.evaluate(INBOX(true)); return v?.cards.length ? v : null; }, 'the notice card in the real window'); assert.deepEqual(notice.cards.map((c) => [c.title, c.canImport, c.setting]), [['오늘 수업 안내', false, null]]);
  await page.screenshot({ path: path.join(out, '00-instructor-u3-off.png'), fullPage: true }); step('U3 OFF: a real turn and a U2 notice work as before; no turn rows, no binding in the profile, no setting kind offered', { provider_calls: providerCalls.length });

  // ── 1. the operator turns U3 on for this Service and this run ──
  local.env.HPS_LESSON_BINDINGS = 'enforce'; const on = await local.request(local.base, 'PUT', { expected_roster_revision: roster, seats, flags: { ops_lesson_settings: true } }, teacherToken); assert.ok(on.status === 200 || on.status === 201, on.raw); roster = on.json.roster_revision ?? roster + 1;
  await page.locator('#ops-check').click(); await page.waitForTimeout(800); await compose(); await wait(async () => (await kinds()).includes('setting'), 'the setting kind is offered once /status allows it', 20000); step('U3 ON for this run (enforcement + the run switch)');

  // ── 2. a prompt: the learner's draft and pasted image stay; the learner's own press appends; undo; then a real question ──
  const PROMPT = '이 페이지의 구조를 세 문장으로 설명해 줘.'; await newMaterial('prompt', '조사 프롬프트', PROMPT); await saveForm(); const pImpact = await sendToA1(); assert.match(pImpact, /초안에 가져오기/); await items(/A1 · .* — 전달: 보관함 반영/, 'the prompt reached the real window');
  const DRAFT = 'Q-PROMPT 내 초안: 버튼 색부터 볼까?'; await setDraft(chat, DRAFT); await pasteImage(chat); const pasted = await wait(async () => (await attachments(chat)) === 1 || null, 'the pasted image is attached', 15000).catch(() => false);
  const card = await wait(async () => { const v = await chat.evaluate(INBOX(true)); return v?.cards.find((c) => c.canImport) ?? null; }, 'the prompt card with its import button'); assert.equal(card.body, PROMPT); assert.equal(await draftOf(chat), DRAFT, 'showing the card changed nothing in the input');
  const callsBefore = providerCalls.length; await chat.evaluate("document.querySelector('[data-inbox-import]').click()"); await wait(async () => (await draftOf(chat)) === DRAFT + '\n\n' + PROMPT || null, 'the prompt was appended to the draft', 10000); assert.equal(await attachments(chat), pasted ? 1 : 0, 'the attachment is untouched'); assert.equal(providerCalls.length, callsBefore, 'importing sent nothing');
  await chat.evaluate("document.querySelector('[data-inbox-undo]').click()"); await wait(async () => (await draftOf(chat)) === DRAFT || null, 'undo restored the draft', 10000); await chat.evaluate("document.querySelector('[data-inbox-import]').click()"); await wait(async () => (await draftOf(chat)).endsWith(PROMPT) || null, 'imported again', 10000); await shot(win, '01-learner-prompt-imported.png');
  await pressEnter(chat); const pc = await wait(() => providerCalls.slice(callsBefore).find((c) => c.marks.includes('Q-PROMPT') && c.prompt_text), 'the learner\'s own send carried the imported prompt', 120000); await answered(chat, 2);
  assert.equal(pc.lesson, V1); const imageConsumed = pasted ? await wait(async () => (await attachments(chat)) === 0 || null, 'the attachment left the composer with the turn', 15000).catch(() => false) : false;
  // This window's profile was cached while U3 was OFF (the operator turned it on mid-session, and nothing was sent to this learner
  // yet): it sends no binding key and closes no turn. The Service admits it because it runs what the token pins. Recorded, not hidden.
  const promptWire = wire.filter((w) => w.path === '/v1/messages').at(-1); step('prompt: appended by the learner\'s press, undone, re-imported, sent by the learner', { image_attached: !!pasted, image_left_with_the_turn: !!imageConsumed, image_note: 'the agent-sdk runtime saves a pasted image to a file for the Read tool; it is not an image block in the first provider request', binding_header_on_that_turn: promptWire.binding, turns: turns() });
  assert.ok(turns().length === 1 && turns()[0].version === V1 && turns()[0].completed === 1, JSON.stringify(turns()));

  // ── 3a. the FIRST setting (V2) reaches a window whose cached profile predates enforcement: it looks again, switches, sends the key, closes the turn ──
  await compose(); await page.locator('#ops-dist-new').click(); await page.locator('#ops-dist-kind').selectOption('setting'); await page.locator(`#ops-dist-setting option[value="${V2}"]`).waitFor({ state: 'attached' }); await page.locator('#ops-dist-setting').selectOption(V2); const impactLine = await T('ops-dist-setting-impact'); assert.match(impactLine, /새로 생김 craft-v2.*없어짐 build/s);
  await page.locator('#ops-dist-title').fill('2판으로 진행'); await page.locator('#ops-dist-body').fill('다음 질문부터 2판 단계로 진행합니다.'); await saveForm(); const sImpact = await sendToA1(); assert.match(sImpact, /진행 중인 응답은 끊지 않고 각 학생의 다음 질문부터/); await page.screenshot({ path: path.join(out, '02-instructor-setting-sent.png'), fullPage: true });
  await items(/A1 · .* 설정: 준비 — 기기 보관함에 있음 · 전환 전/, 'the setting is PREPARED on the real device'); assert.deepEqual(bindings(), [], 'prepared is not switched');
  const settingCard = await wait(async () => { const v = await chat.evaluate(INBOX(true)); return v?.cards.find((c) => c.setting) ?? null; }, 'the setting card in the real window'); assert.equal(settingCard.setting, 'pending'); await shot(win, '02b-learner-setting-pending.png');
  await ask(chat, 'Q-V2 2판에서의 첫 질문', 'Q-V2'); await answered(chat, 3); const v2calls = providerCalls.filter((c) => c.marks.includes('Q-V2')); assert.ok(v2calls.every((c) => c.lesson === V2), 'the next question ran under V2: ' + JSON.stringify(v2calls));
  const K2 = db('SELECT binding_key k FROM classroom_lesson_bindings WHERE student_id=? AND binding_seq=1', seats[0].student_id)[0]?.k; const v2wire = wire.filter((w) => w.path === '/v1/messages').at(-1); assert.equal(v2wire.binding, K2, 'the real app sent the key of the binding it switched to');
  await wait(() => turns().at(-1).closed === 1 || null, 'the real host closed its turn', 30000); assert.deepEqual([turns().at(-1).version, turns().at(-1).binding_seq, turns().at(-1).close_outcome], [V2, 1, 'completed']);
  await items(/A1 · .* 설정: 적용 — 이 설정으로 보낸 모델 요청이 정상 종료됨 \(m2026\.09\.18-2\)/, 'applied'); assert.equal((await chat.evaluate(INBOX(true))).cards.find((c) => c.setting).setting, 'bound'); await page.screenshot({ path: path.join(out, '03-instructor-applied-v2.png'), fullPage: true });
  step('first setting: a window with a profile cached before enforcement looked again, switched, sent the binding key and closed its turn', { bindings: bindings(), wire: v2wire });

  // ── 3b. a question is still being answered (window 1, under V2) while the SECOND setting (V3) arrives and a SECOND window asks the next question ──
  let release; holdGate = new Promise((r) => { release = r; }); const nHold = providerCalls.length;
  await setDraft(chat, HOLD + ' 이 질문의 답이 오는 동안 설정이 바뀝니다'); await pressEnter(chat); await wait(() => holding > 0, 'the provider is holding the answer of window 1 open', 120000);
  const heldTurn = turns().at(-1); assert.deepEqual([heldTurn.version, heldTurn.binding_seq, heldTurn.closed, heldTurn.dispatched, heldTurn.completed], [V2, 1, 0, 1, 0], 'admitted under V2, dispatched, not completed, not closed: ' + JSON.stringify(heldTurn));
  await compose(); await page.locator('#ops-dist-setting').selectOption(V3); await page.locator('#ops-dist-title').fill('3판으로 진행'); await page.locator('#ops-dist-body').fill('다음 질문부터 3판 단계로 진행합니다.'); await saveForm(); assert.match(await T('ops-dist-saved'), /2번째 판/); await sendToA1();
  await items(/A1 · .* 설정: 준비 — 기기 보관함에 있음/, 'V3 is prepared while window 1 is still being answered'); assert.equal(bindings().length, 1);
  // the second window of the same app, same learner
  spawn(path.join(copy, 'Contents/MacOS/HypeProof Studio'), appArgs(ws2), { env: childEnv, stdio: 'ignore' }); const win2 = await wait(() => workbenches().find((w) => w !== win), 'the second window', 90000); await win2.waitForTimeout(6000);
  const notHeld = '!' + hasText(HOLD); let chat2 = await enterWork(notHeld);
  await ask(chat2, 'Q-WINDOW2 두 번째 창에서 보내는 다음 질문', 'Q-WINDOW2');
  let secondWindow = 'shared the first window\'s class connection';
  if (bindings().length === 1) { // this harness keeps secrets in memory PER WINDOW: the second window has no class connection of its own until it is paired
    secondWindow = 'had no class connection of its own (in-memory secrets are per window in this harness); it was connected with a new one-time code';
    const w2first = providerCalls.filter((c) => c.marks.includes('Q-WINDOW2')); assert.ok(w2first.every((c) => c.lesson === V2), 'not switched yet: that question ran under the binding in force (V2), which this window learned from the shared inbox: ' + JSON.stringify(w2first)); providerCalls.forEach((c) => { c.marks = c.marks.map((m) => m === 'Q-WINDOW2' ? 'Q-WINDOW2-UNPAIRED' : m); });
    const v3grant = () => db("SELECT t.grant_id g,t.state s FROM classroom_distribution_targets t WHERE t.seat_id='A1' AND t.revision=2 ORDER BY t.updated_at DESC LIMIT 1")[0], firstGrant = v3grant().g;
    await connectSeat(win2);
    // A new connection gets the offer again under ITS delivery key (the sync loop, a few seconds). A switch asked before that is
    // refused as `stale_offer` and, by design, tried again at the next question — seen on this Mac; here the learner simply waits.
    await wait(() => { const r = v3grant(); return r.g !== firstGrant && r.s === 'reflected' ? r : null; }, 'the second window\'s connection received the setting under its own delivery key', 120000);
    await items(/A1 · .* 설정: 준비 — 기기 보관함에 있음/, 'still prepared after the second window connected', 120000); await ask(chat2, 'Q-WINDOW2 두 번째 창에서 다시 보내는 다음 질문', 'Q-WINDOW2'); }
  await wait(() => bindings().length === 2 || null, 'the second window switched at ITS next question', 60000); const w2 = providerCalls.filter((c) => c.marks.includes('Q-WINDOW2')); assert.ok(w2.length && w2.every((c) => c.lesson === V3), 'the second window\'s question ran under V3: ' + JSON.stringify(w2));
  assert.equal(turns().find((t) => t.turn === heldTurn.turn).completed, 0, 'window 1 is STILL being answered'); await items(/A1 · .* 설정: (적용|실행 시도)/, 'the instructor sees V3 take effect while window 1 still runs'); await shot(win2, '04-second-window-v3.png');
  release(); holdGate = null; await wait(() => turns().find((t) => t.turn === heldTurn.turn)?.closed === 1 || null, 'window 1\'s turn finished and was closed by the host', 120000);
  const heldCalls = providerCalls.slice(nHold).filter((c) => c.marks.includes(HOLD)); assert.ok(heldCalls.length >= 1 && heldCalls.every((c) => c.lesson === V2), 'EVERY provider request of the running question — before and after the switch — ran under V2: ' + JSON.stringify(heldCalls.map((c) => [c.lesson, c.tools, c.held])));
  const heldRow = turns().find((t) => t.turn === heldTurn.turn); assert.deepEqual([heldRow.version, heldRow.binding_seq, heldRow.completed, heldRow.close_outcome], [V2, 1, 1, 'completed'], JSON.stringify(heldRow)); await answered(chat, 4); await shot(win, '05-first-window-finished-under-v2.png');
  await items(/A1 · .* 설정: 적용 .*\(m2026\.09\.18-3\)/, 'V3 applied'); assert.deepEqual(bindings().map((b) => [b.binding_seq, b.source, b.version, b.completed]), [[1, 'setting', V2, 1], [2, 'setting', V3, 1]]);
  await page.locator('#ops-check').click(); await page.waitForTimeout(800); assert.match(await row('A1').innerText(), /강의 버전: m2026\.09\.18-3 · 수업 설정으로 전환됨/); assert.doesNotMatch(await row('A2').innerText(), /강의 버전:/); await page.screenshot({ path: path.join(out, '06-instructor-applied-v3.png'), fullPage: true });
  step('two settings in a row; a running answer was kept under V2 (every request of it) while the second window\'s next question ran under V3', { second_window: secondWindow, held_requests: heldCalls.length, bindings: bindings() });

  // ── 5. withdraw (clicked) is not a return; then the return (clicked) ──
  await page.locator('#ops-dist-revoke').click(); assert.match(await T('ops-dist-revoke-impact'), /^수업 설정의 회수는 되돌리기가 아닙니다/); await page.locator('#ops-dist-revoke-go').click(); await page.locator('#ops-dist-now').filter({ hasText: '이 배포는 회수했습니다' }).waitFor();
  await ask(chat2, 'Q-AFTER-WITHDRAW 회수 뒤의 질문', 'Q-AFTER-WITHDRAW'); assert.ok(providerCalls.filter((c) => c.marks.includes('Q-AFTER-WITHDRAW')).every((c) => c.lesson === V3), 'withdrawn: the switched learner still runs V3'); assert.equal(bindings().length, 2);
  await page.locator('#ops-dist-return').click(); assert.match(await T('ops-dist-note'), /복귀를 준비했습니다.*아직 아무것도 보내지 않았습니다/s); assert.equal(await page.locator('#ops-dist-setting').inputValue(), 'base'); await saveForm(); assert.match(await T('ops-dist-saved'), /3번째 판/); const rImpact = await sendToA1(); assert.match(rImpact, /기본 수업으로 복귀/);
  await items(/A1 · .* 설정: 준비 — 기기 보관함에 있음/, 'the return is prepared'); await ask(chat2, 'Q-HOME 복귀 뒤의 질문', 'Q-HOME'); assert.ok(providerCalls.filter((c) => c.marks.includes('Q-HOME')).every((c) => c.lesson === V1), 'returned: the token lesson again');
  await items(/A1 · .* 설정: 적용 .*\(기본 수업\)/, 'the return is applied'); assert.deepEqual(bindings().map((b) => [b.binding_seq, b.source]), [[1, 'setting'], [2, 'setting'], [3, 'base']]); await page.screenshot({ path: path.join(out, '07-instructor-returned.png'), fullPage: true }); await shot(win2, '08-second-window-home.png');
  step('withdraw clicked: nothing went back; return clicked: the learner runs the token lesson again', { bindings: bindings() });

  // ── 6. what was preserved, the unselected seat, and the OpenAI-compatible proxy route through the same real HTTP path ──
  const kept = await chat.evaluate(`({q0:${hasText('Q0-OFF')},held:${hasText(HOLD)},answers:(document.body.textContent.match(/로컬 시험 응답/g)||[]).length})`); assert.ok(kept.q0 && kept.held && kept.answers >= 4, 'window 1 kept its whole conversation: ' + JSON.stringify(kept));
  assert.deepEqual(workHashes(), { 'index.html': sha(path.join(ws, 'index.html')), 'notes.md': sha(path.join(ws, 'notes.md')) }); const work = workHashes();
  await loopA2.tick(); assert.deepEqual(blocksA2, [], 'A2 was never sent a distribution block'); assert.ok(!existsSync(storeA2.directory), 'A2 has no inbox directory'); assert.deepEqual(db('SELECT count(*) n FROM classroom_lesson_bindings WHERE student_id=?', seats[1].student_id), [{ n: 0 }]);
  assert.deepEqual(db('SELECT DISTINCT seat_id FROM classroom_distribution_targets'), [{ seat_id: 'A1' }], 'only A1 was ever a target');
  let proxyText = ''; const pr = await proxyChat({ proxyUrl: origin + '/v1', model: 'hypeproof-default', token: tokenA2, history: [], userText: 'Q-PROXY Q-A2 선택되지 않은 학생의 질문', turnId: KEY(), lessonBinding: 'token:' + lessonSha[V1].slice(0, 16), signal: new AbortController().signal, onDelta: (d) => { proxyText += d; } });
  const proxyCalls = providerCalls.filter((c) => c.marks.includes('Q-PROXY')); assert.ok(proxyText.includes('로컬 시험 응답') && proxyCalls.length === 1 && proxyCalls[0].lesson === V1, 'the unselected learner, over the real proxy client and route, runs the run\'s version: ' + JSON.stringify([pr.finishReason, proxyCalls]));
  const proxyTurn = db('SELECT version,first_completed_at IS NOT NULL AS completed FROM classroom_lesson_turns WHERE student_id=?', seats[1].student_id); assert.deepEqual(proxyTurn, [{ version: V1, completed: 1 }]);
  step('preserved: conversation, workspace files, the unselected seat; proxy route (chat/completions) admitted and recorded the same way', { wire_paths: [...new Set(wire.map((w) => w.method + ' ' + w.path + ' ' + w.status))] });

  const result = { schema: 'hps-classroom-mac-lesson-settings/1', at: new Date().toISOString(), source_sha: head, extension_source_sha: manifest.extension.source_sha, extension_bundles: manifest.extension.bundles, shell: manifest.shell, agent_sdk: { version: manifest.agent_sdk.version, binary_sha256: manifest.agent_sdk.binary.sha256 }, real_seat: 'A1', synthetic_seat: 'A2', driven_from: 'Chalk /manage in a visible Chromium window; two real Studio windows over the debugging port',
    model: 'scripted recorder (no real model was called; nothing here is evidence of model quality, latency or cost)', second_window: secondWindow, image: { attached_in_real_window: !!pasted, left_the_composer_with_the_turn: !!imageConsumed },
    provider_calls: providerCalls.map((c) => ({ lesson: c.lesson, marks: c.marks, tools: c.tools, held: c.held })), turns: turns(), bindings: bindings(), wire: wire.map(({ at, ...w }) => w), learner: { workspace: work, conversation_kept: kept }, steps,
    not_run: ['Windows', 'school network', 'several physical devices', 'staging or production', 'a real model', 'mail', 'Keychain-backed reconnection (this harness keeps secrets in memory)', 'a Studio window on a proxy-runtime profile (the proxy route was exercised with the real client module over real HTTP)'] };
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log('PASS — M2: prompt and lesson settings from the Chalk UI to real Studio windows → ' + path.join(out, 'result.json'));
  console.log('The instructor page (' + session.instructor_url + ') and the learner app stay open until ' + endsAt + '. Control-C ends the session.'); if (process.env.HPS_BOARD_HEADLESS === '1') { await browser.close(); cleanup(); } await new Promise(() => {});
} catch (e) { console.log('M2 FAILED: ' + (e?.stack ?? e)); writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), error: String(e?.message ?? e), steps, turns: turns(), bindings: bindings(), wire: wire.slice(-30).map(({ at, ...w }) => w), provider_calls: providerCalls.slice(-12), targets: db('SELECT t.revision,t.state,t.device_generation,t.result_code FROM classroom_distribution_targets t JOIN classroom_distributions d ON d.id=t.distribution_id ORDER BY d.created_at,d.rowid') }, null, 2)); if (process.env.HPS_U3_KEEP_ON_FAIL !== '1') cleanup(); }
