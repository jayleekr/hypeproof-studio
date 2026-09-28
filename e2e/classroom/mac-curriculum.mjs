// #751 G2 · #1012 · #1008 — curriculum → actual execution on THIS Mac: two deliberately different valid curricula authored in the
// real Chalk page, each rehearsed in a REAL Studio window under a learner rehearsal code, confirmed, sent to a selected learner,
// and observed at the execution boundary of that learner's REAL Studio window.
//
//   HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-g2 node e2e/classroom/mac-devhost.mjs prepare
//   HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-g2 node --experimental-strip-types --experimental-sqlite --no-warnings e2e/classroom/mac-curriculum.mjs
//
// Real: the copied official shell + the current extension/webview build + the real Agent SDK binary, the Chalk pages in a
// browser, the Service router + SQLite (bindings enforced, confirmation required) over real HTTP, the ops sync loop, the inbox,
// the switch, the turn close, the rehearsal report the window sends. Synthetic: accounts, the curricula, and the MODEL PROVIDER —
// a recorder that answers protocol-complete streams and records what reached it (lesson, help instruction, tools, the learner's
// saved work). It proves transport and enforcement, never a real model's quality, latency or cost.
// #751 G2 mission: A and B also get DIFFERENT missions and completion conditions through the visible /authoring controls; the
// mission the real window's header draws and the mission the Service puts in the model request are read at each step.
// Seat A1 is the real window (selected). A2 runs the real device client in this process and is never selected. A3 is registered
// and invited but never connects (offline). Own ports 18991/18992/9591, own user-data dirs and HOME; the installed app, other
// sessions' hosts and the user's Studio data are not touched. Nothing about Windows, a school network, staging/production or mail.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { localOps, OPS_ALL } from '../../worker/test/harness/classroom-ops.mjs';
import * as ops from '../../extensions/hypeproof-chat/src/classroomOps.ts';
import { INBOX_CAPABILITY, INBOX_PROMPT_CAPABILITY, LESSON_BINDING_CAPABILITY } from '../../extensions/hypeproof-chat/src/classroomInbox.ts';
import { InboxSession, InboxStore, inboxDir } from '../../extensions/hypeproof-chat/src/classroomInboxStore.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost-g2'));
const servicePort = 18991, boardPort = 18992, debugPort = 9591, HOURS = 12, prefix = 'g2-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'), json = (p) => JSON.parse(readFileSync(p, 'utf8')), out = path.join(home, process.env.HPS_G2_RUN || 'curriculum'); mkdirSync(out, { recursive: true });
const manifest = json(path.join(home, 'manifest.json')), copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
assert.ok(!copy.startsWith('/Applications'), 'never the installed app');
for (const [f, h] of Object.entries(manifest.extension.bundles)) { assert.equal(sha(path.join(ext, f)), h, `${f} changed since prepare`); assert.equal(sha(path.join(repo, 'extensions/hypeproof-chat', f)), h, `${f}: the prepared copy is not the current build — prepare again`); }
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', manifest.extension.source_sha, head, '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src'], { cwd: repo, encoding: 'utf8' }), '', 'extension sources changed since prepare');
assert.ok(manifest.agent_sdk?.vendored === true && manifest.agent_sdk.binary, 'the dev host has no Agent SDK: prepare again');
const steps = []; const step = (name, detail = {}) => { steps.push({ at: new Date().toISOString(), name, ...detail }); console.log('STEP ' + name + (Object.keys(detail).length ? ' ' + JSON.stringify(detail) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Service: real router + SQLite; bindings enforced; the class and its codes last HOURS. ──
const local = await localOps(), { setRoster, startSession } = await import('../../worker/src/lib/kv.ts'), { issueIssuer } = await import('../../worker/src/lib/tokens.ts'), { TEST_SECRET } = await import('../../worker/test/harness/index.mjs');
local.env.HPS_LESSON_BINDINGS = 'enforce';
const endsAt = new Date(Date.now() + HOURS * 3600_000).toISOString();
await startSession(local.env.HPS_KV, local.cohort, { session_id: local.run, profile_id: local.profile, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: endsAt }); local.db.prepare('UPDATE sessions SET ends_at=? WHERE id=?').run(endsAt, local.run);
const seats = ['A1', 'A2', 'A3'].map((id, i) => ({ seat_id: id, student_id: prefix + (i + 1) })), REHEARSER = prefix + 'rehearsal';
await setRoster(local.env.HPS_KV, local.cohort, [...seats.map((s) => s.student_id), REHEARSER]);
const course = local.lesson.course_id, V1 = local.lesson.version, VA = 'm2026.09.22-31', VB = 'm2026.09.22-32';
await local.freeze(course, V1, ['intro', 'build', 'review']);
let roster = (await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_distribute: true, ops_lesson_settings: true } })).json?.roster_revision ?? 1;
const teacherToken = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: [...OPS_ALL, 'distribute', 'lesson_settings'] }] }, HOURS + 1, TEST_SECRET)).token;
// The class was opened on V1 BEFORE this Service required confirmation: its codes stay usable (old lessons keep their contract).
const invite = async (user) => { const r = await local.request(`/admin/cohorts/${local.cohort}/authoring/${course}/versions/${V1}/participants`, 'POST', { user, hours: HOURS }, teacherToken); assert.equal(r.status, 200, r.raw); return r.json.token; };
const codes = {}; for (const s of seats) codes[s.seat_id] = await invite(s.student_id);
local.env.HPS_LESSON_CONFIRMATION = 'require';
Object.assign(local.env, { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-no-live-key', OPENAI_API_KEY: undefined, ANTHROPIC_PROXY_URL: undefined });

// ── the learner's machine: own profiles, own HOME. The learner's files are fixed BEFORE anything starts. ──
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'hps-g2-'))), fakeHome = path.join(root, 'home'), ws = path.join(root, 'ws-learner'), wsR = path.join(root, 'ws-rehearsal');
for (const d of [fakeHome, ws, wsR]) mkdirSync(d, { recursive: true });
const ORIGINALS = { [path.join(ws, 'index.html')]: '<!doctype html><title>예약 안내</title><h1>SYNTHETIC LEARNER WORK</h1>\n', [path.join(ws, 'notes.md')]: '# 내 메모\n- 토요일 진료시간 확인\n' };
for (const [f, t] of Object.entries(ORIGINALS)) writeFileSync(f, t);
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const workFiles = () => { const now = Object.fromEntries(walk(ws).map((f) => [f, sha(f)])); return { changed: Object.keys(ORIGINALS).filter((f) => now[f] !== createHash('sha256').update(ORIGINALS[f]).digest('hex')), added: Object.keys(now).filter((f) => !(f in ORIGINALS)).map((f) => path.relative(root, f)) }; };

// ── the ONLY scripted thing: the model provider. It records what reached it and can hold one answer open. ──
const seenMarks = new Set(), providerCalls = [], realFetch = globalThis.fetch, ANSWER = '[로컬 시험 응답] 실제 AI 모델은 호출하지 않았습니다.'; let holdGate = null, releaseHold = null;
const enc = new TextEncoder(), ev = (e, d) => enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
const sse = (model, gate) => new Response(new ReadableStream({ async start(c) {
  c.enqueue(ev('message_start', { type: 'message_start', message: { id: 'synthetic-' + providerCalls.length, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
  c.enqueue(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })); c.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER.slice(0, 8) } }));
  if (gate) await gate; c.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER.slice(8) } })); c.enqueue(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
  c.enqueue(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } })); c.enqueue(ev('message_stop', { type: 'message_stop' })); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const LESSON_OF = [['첫 판을 만든 원장님', VB], ['처음 만들어 보는 원장님', VA], ['합성 사용자', V1]];
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.origin === 'https://service.test') return local.app.fetch(new Request(input, init), local.env, { waitUntil() {} });
  assert.equal(url.origin, 'https://api.anthropic.com', 'unexpected outbound request from the Service: ' + url.origin);
  const raw = String(init.body), body = JSON.parse(raw), convo = JSON.stringify(body.messages ?? []);
  // `\b` is wrong here: in the serialized body a question that follows the learner's saved work reads `…\\nQ-LA2`, and
  // there is no word boundary between that `n` and `Q` (run 2 lost Q-LA2 that way). Only an upper-case/digit/dash neighbour disqualifies.
  // Which question is this request about? The mark no earlier request carried (a new question); a follow-up request of the
  // same turn carries no new mark and falls back to the mark placed last. (Run 1: "placed last" alone mislabelled Q-LA2 as
  // Q-LA1 — the SDK does not keep the newest message last in the serialized conversation.)
  const marks = [...new Set(raw.match(/(?<![A-Z0-9-])(?:Q|HOLD)-[A-Z0-9]+(?:-[A-Z0-9]+)*/g) ?? [])], fresh = marks.filter((m) => !seenMarks.has(m));
  const current = fresh.length === 1 ? fresh[0] : marks.map((m) => [m, raw.lastIndexOf(m)]).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null; for (const m of marks) seenMarks.add(m);
  const help = /\[도움 방식\] 단계 '([^']+)'의 도움 방식은 '([^']+)'이며 ([^.]+)\./.exec(raw);
  // The mission the Service put into THIS request's coach context (learning-prompt.ts), as it crossed to the provider.
  const mission = /\[학습 설계\] (\d+)주차 · 이번 주 미션: \\"((?:[^"\\]|\\.)+?)\\"/.exec(raw);
  const held = !!holdGate && !!current && current.startsWith('HOLD-');
  providerCalls.push({ at: Date.now(), mission: mission ? [Number(mission[1]), mission[2]] : null, model: body.model, lesson: LESSON_OF.find(([m]) => raw.includes(m))?.[1] ?? 'unknown', mark: current, help: help ? { step: help[1], mode: help[2], source: help[3] } : null,
    tools: (body.tools ?? []).map((t) => t.name).filter(Boolean).sort(), in_messages: !!current && convo.includes(current), criterion: /학생이 직접 저장한 확인 기준\]\\n([^\\[]+)/.exec(raw)?.[1] ?? null, decision: /결정: ([^\\]+)\\n이유: ([^\\]+)/.exec(raw)?.slice(1, 3) ?? null, held });
  return body.stream ? sse(body.model, held ? holdGate : null) : Response.json({ id: 'synthetic', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 9 } });
};
const callsFor = (mark) => providerCalls.filter((c) => c.mark === mark);
const wire = [];
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts), url = req.url.split('?')[0];
  const r = await local.app.fetch(new Request('https://service.test' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), local.env, { waitUntil() {}, passThroughOnException() {} });
  if (/^\/v1\/(messages|profile|classroom\/rehearsal|classroom\/ops\/lesson-binding)/.test(url)) wire.push({ at: Date.now(), method: req.method, path: url, status: r.status, step: req.headers['x-hps-lesson-step'] ?? null, help: req.headers['x-hps-help-mode'] ?? null, binding: req.headers['x-hps-lesson-binding'] ?? null });
  res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) for await (const chunk of r.body) res.write(chunk); res.end(); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
server.listen(servicePort, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + servicePort;
const { default: chalk } = await import('../../chalk/src/index.ts');
const board = createServer(async (req, res) => { try { const parts = []; for await (const b of req) parts.push(b); const body = Buffer.concat(parts);
  const rr = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(rr.status, Object.fromEntries(rr.headers)); res.end(Buffer.from(await rr.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
board.listen(boardPort, '127.0.0.1'); await once(board, 'listening');

// ── seat A2: connected, fully capable, NEVER selected: "nothing arrived" is measured on its real device client. ──
const memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; }; let eid = 0;
const capsA2 = ['observe', INBOX_CAPABILITY, INBOX_PROMPT_CAPABILITY, LESSON_BINDING_CAPABILITY], cA2 = (await local.pair('A2', roster, 2, capsA2)).conn.json, storeA2 = new InboxStore(inboxDir(path.join(root, 'synthetic-A2'), { cohort: cA2.student.c, run: cA2.class_run_id, seat: cA2.seat_id, student: cA2.student.u })), instA2 = local.instance(2, capsA2), blocksA2 = [];
const loopA2 = ops.startOpsSync({ outbox: await ops.OpsOutbox.open(memory(), cA2.grant_id, 'stream-A2', () => Date.now(), () => `event-g2m-${String(++eid).padStart(6, '0')}`), appInstanceId: instA2.app_instance_id, capabilities: capsA2, distribution: new InboxSession({ store: storeA2, alive: () => true, clock: { mono: () => performance.now(), wall: () => Date.now() } }), sample: () => ({ idle_ms: 1 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {},
  post: async (body) => { const r = await local.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: instA2.boot_id }, cA2.credential); if (r.json?.distribution) blocksA2.push(r.json.distribution); return { status: r.status, body: r.json }; } });
const timer = setInterval(() => { loopA2.tick().catch(() => {}); }, 5000);

// ── the real Studio windows (debugging port) ──
const appEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD|_SECRET$|HPS_TEST|ELECTRON_RUN_AS_NODE)/.test(k)));
let app = null, cdp = null;
function launch(kind, token, folder) {
  const userDir = path.join(root, 'user-' + kind); mkdirSync(path.join(userDir, 'User'), { recursive: true });
  writeFileSync(path.join(userDir, 'User/settings.json'), JSON.stringify({ 'hypeproofChat.proxyUrl': origin + '/v1', 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }));
  const tokenPath = path.join(root, 'code-' + kind + '.txt'); writeFileSync(tokenPath, token, { mode: 0o600 });
  app = spawn(path.join(copy, 'Contents/MacOS/HypeProof Studio'), ['--user-data-dir=' + userDir, '--extensions-dir=' + path.join(userDir, 'extensions'), '--use-inmemory-secretstorage', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--remote-debugging-port=' + debugPort, '--new-window', folder],
    { env: { ...appEnv, HOME: fakeHome, HPS_DEV_TOKEN_FILE: tokenPath, HPS_TEST_COACH_NAME: '연습 코치', HPS_SDK_BINARY: manifest.agent_sdk.binary.path }, stdio: ['ignore', 'ignore', 'inherit'] });
  app.on('exit', (code, signal) => console.log('APP_EXIT', kind, code, signal)); step('launch ' + kind, { folder: path.relative(root, folder) });
}
async function quit() { if (!app) return; const a = app; app = null; try { await cdp?.close(); } catch {} cdp = null; a.kill('SIGTERM'); await Promise.race([once(a, 'exit'), sleep(15000)]); try { a.kill('SIGKILL'); } catch {} await sleep(1500); }
const wait = async (fn, label, ms = 60000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(300); } throw Error('timed out: ' + label + (last instanceof Error ? ' — ' + last.message : '')); };
const workbenches = () => cdp.contexts().flatMap((c) => c.pages()).filter((p) => p.url().includes('workbench'));
async function attach() { cdp = null; for (let i = 0; i < 90 && !cdp; i++) { try { cdp = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort); } catch { await sleep(1000); } } assert.ok(cdp, 'the Studio copy did not open its debugging port'); const w = await wait(() => workbenches()[0], 'workbench window', 90000); await w.waitForTimeout(6000); return w; }
const toasts = (w) => w.evaluate(() => [...document.querySelectorAll('.notifications-toasts .notification-list-item-message, .notifications-center .notification-list-item-message')].map((e) => e.textContent));
const palette = async (w, title, typed) => { await w.bringToFront(); await w.keyboard.press('F1'); await w.waitForSelector('.quick-input-widget input', { state: 'visible' }); await w.keyboard.type(title, { delay: 15 }); await wait(() => w.evaluate((t) => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => r.textContent.includes(t)), title), 'command ' + title); await w.keyboard.press('Enter');
  if (typed !== undefined) { await wait(() => w.evaluate(() => document.querySelector('.quick-input-widget')?.textContent.includes('수업 연결 코드')), 'ticket prompt'); await w.keyboard.type(typed, { delay: 10 }); await w.keyboard.press('Enter'); } };
const frame = (selector, where = 'true', ms = 60000) => wait(async () => { for (const t of (await (await realFetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).filter((x) => x.type === 'iframe' && x.url.includes('hypeproof-chat'))) { const sock = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; }); let id = 0; const pending = new Map();
    sock.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { const [r, j] = pending.get(m.id); pending.delete(m.id); m.error ? j(Error(m.error.message)) : r(m.result); } }; const send = (method, params = {}) => new Promise((r, j) => { const n = ++id; pending.set(n, [r, j]); sock.send(JSON.stringify({ id: n, method, params })); });
    await send('Page.enable'); const { frameTree } = await send('Page.getFrameTree'); for (const f of [frameTree, ...(frameTree.childFrames || [])]) { const contextId = (await send('Page.createIsolatedWorld', { frameId: f.frame.id, worldName: 'g2' })).executionContextId; const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true })).result?.value;
      if (await evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')&&!!(' + where + ')')) return { evaluate, send }; } sock.close(); } return null; }, 'webview ' + selector, ms);
const TEXTAREA = '.hps-input textarea';
/** A learner's press: the control must be visible, in view, topmost and enabled; then real mouse input at its centre. */
async function press(chat, selector, label) {
  const r = await chat.evaluate(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,250));const b=e.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2,hit=document.elementFromPoint(x,y),cs=getComputedStyle(e);return {x,y,w:Math.round(b.width),h:Math.round(b.height),in_view:b.top>=0&&b.bottom<=innerHeight,topmost:!!hit&&(hit===e||e.contains(hit)||hit.contains(e)||(hit.tagName==='LABEL'&&hit.contains(e))),disabled:!!e.disabled,visible:cs.visibility!=='hidden'&&cs.display!=='none'};})()`);
  assert.ok(r && r.w > 0 && r.h > 0 && r.in_view && r.topmost && !r.disabled && r.visible, label + ' is not a visible control a learner can press: ' + JSON.stringify(r));
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await chat.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await sleep(350); return r; }
const setValue = (chat, selector, text) => chat.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();})()`);
const pressEnter = (chat) => chat.evaluate(`(()=>{const e=document.querySelector('${TEXTAREA}');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));})()`);
const ask = async (chat, text, mark, ms = 120000) => { const n = providerCalls.length; await setValue(chat, TEXTAREA, text); await pressEnter(chat); await wait(() => providerCalls.slice(n).some((c) => c.mark === mark), 'the provider was called for ' + mark, ms); };
const idle = (chat) => wait(() => chat.evaluate("![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Stop')"), 'the turn ended on screen', 120000);
const enterWork = async (where = 'true') => { const e = await frame('.studio-primary, ' + TEXTAREA, where, 120000); if (await e.evaluate("!!document.querySelector('.studio-primary')")) await press(e, '.studio-primary', 'the entry screen\'s Primary'); return frame(TEXTAREA, where); };
/** What the learner SEES of the current step: help choices (checked), the work surface, saved work, rehearsal line. */
const PANEL = `(()=>{const p=document.querySelector('[data-lesson-step-panel]');if(!p)return null;return {step:p.dataset.lessonStepPanel,help:[...p.querySelectorAll('input[name="hp-help-mode"]')].map(i=>[i.value,i.checked]),surface:p.querySelector('[data-surface]')?.dataset.surface??null,saved:p.querySelector('[data-saved-work]')?.textContent??null,rehearsal:p.querySelector('.hp-rehearsal')?.textContent??null,result:p.querySelector('[data-rehearsal-result]')?.textContent??null,text:p.textContent.slice(0,600)};})()`;
const panelOf = (chat) => chat.evaluate(PANEL);
/** The mission header as drawn in the real window (MissionHeader.tsx): week line, sentence, completion items and their marks. */
const HEADER = `(()=>{const h=document.querySelector('header.hp-mission');if(!h)return null;return {week:h.querySelector('.hp-mission-week')?.textContent??null,sentence:h.querySelector('.hp-mission-sentence')?.textContent??null,completion:[...h.querySelectorAll('.hp-mission-completion-text')].map(e=>e.textContent),marks:[...h.querySelectorAll('.hp-mission-completion li:not(.hp-mission-completion-note) .hp-mark')].map(e=>e.textContent)};})()`;
const headerOf = (chat) => chat.evaluate(HEADER);
const UNSET = { week: null, sentence: '미션이 정해지지 않았습니다.', completion: [], marks: [] };
const headerFor = (m) => m ? { week: m.week + '주차', sentence: m.mission, completion: m.completion.map((c) => c[0]), marks: m.completion.map(() => '☐') } : UNSET;
const waitHeader = (chat, m, label) => wait(async () => { const h = await headerOf(chat); return JSON.stringify(h) === JSON.stringify(headerFor(m)) ? h : null; }, label + ' — the header draws ' + (m ? '‘' + m.mission + '’' : 'no mission'));
const shot = async (w, name) => { try { await w.screenshot({ path: path.join(out, name) }); } catch (e) { console.log('screenshot skipped: ' + e.message); } };
const db = (sql, ...a) => local.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const bindingsOf = (student) => db('SELECT binding_seq,source,version,first_completed_at IS NOT NULL AS applied FROM classroom_lesson_bindings WHERE student_id=? ORDER BY binding_seq', student);

// ── the instructor: the real Chalk pages in a visible browser ──
let browser = null, teacher = null;
async function authoringPage() {
  browser = browser ?? await chromium.launch({ headless: process.env.HPS_BOARD_HEADLESS === '1' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }); page.on('dialog', (d) => d.accept());
  const waitStatus = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout: 60000 });
  await page.goto('http://127.0.0.1:' + boardPort + '/authoring'); await page.locator('#token').fill(teacherToken); await page.locator('#connect').click(); await page.locator('#connection-status').filter({ hasText: '연결되었습니다' }).waitFor();
  await page.locator('summary', { hasText: '저장한 강의 열기' }).click(); await page.locator('#course').fill(course); await page.locator('#load').click(); await waitStatus(/저장본을 열었습니다/);
  await page.locator('summary', { hasText: '추가 자료 · AI 설정' }).click(); await page.locator('#features-load').click(); await page.locator('#features-status').filter({ hasText: '이 코호트가 가진 기능' }).waitFor();
  return { page, waitStatus };
}
/** Edit the saved draft into a curriculum with the ordinary controls: text, step-1 help and surface, allowed features. */
async function author(t, c) {
  const { page, waitStatus } = t, s0 = page.locator('.step').nth(0);
  for (const [id, v] of Object.entries({ title: c.title, audience: c.audience, objective: c.objective, starter: c.starter })) await page.locator('#' + id).fill(v);
  await s0.locator('[data-field="title"]').fill(c.step.title); await s0.locator('[data-field="acceptance"]').fill(c.step.acceptance);
  for (const box of await s0.locator('[data-help-mode]').all()) { const m = await box.getAttribute('data-help-mode'); if (c.step.help.includes(m)) await box.check(); else await box.uncheck(); }
  await s0.locator('[data-help-default]').selectOption(c.step.default); await s0.locator('[data-ui]').selectOption(c.step.ui);
  await page.locator('#feature-mode').selectOption('narrow'); for (const box of await page.locator('#feature-allowed input').all()) { const k = await box.getAttribute('value'); if (c.features.includes(k)) await box.check(); else await box.uncheck(); }
  // The mission with the visible controls: on, week, sentence, and the completion rows replaced one by one.
  await page.locator('#learning-on').check(); await page.locator('#learning-week').fill(String(c.mission.week)); await page.locator('#learning-mission').fill(c.mission.mission);
  while (await page.locator('#learning-completion li').count()) await page.locator('#learning-completion li').first().getByRole('button', { name: '삭제' }).click();
  for (const [text, event] of c.mission.completion) { await page.locator('#completion-add').click(); const row = page.locator('#learning-completion li').last(); await row.locator('[data-completion-text]').fill(text); await row.locator('[data-completion-event]').selectOption(event); }
  await page.locator('#learning').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, 'g2-mac-00-mission-' + c.key + '.png') });
  await page.locator('#save').click(); await waitStatus(/저장했습니다/);
  const saved = (await local.request(`/admin/cohorts/${local.cohort}/authoring/${course}`, 'GET', undefined, teacherToken)).json.content.learning;
  assert.deepEqual([saved.week, saved.mission, saved.completion.map((x) => [x.text, x.event])], [c.mission.week, c.mission.mission, c.mission.completion], 'the controls saved the mission');
}
async function reviewAgainst(t, version, file) { const { page } = t; await page.locator('#versions-load').click(); await page.locator(`#base-version option[value="${version}"]`).waitFor({ state: 'attached' }); await page.locator('#base-version').selectOption(version); await page.waitForTimeout(400); await page.locator('#impact').click(); await page.locator('#impact-view li').first().waitFor(); const lines = await page.locator('#impact-view li').allInnerTexts(); await page.locator('#review').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, file) }); return lines; }
async function candidate(t, version) { const { page } = t; await page.locator('#version').evaluate((e) => { e.closest('details').open = true; }); await page.locator('#version').fill(version); await page.locator('#freeze').click(); await page.locator('#completion').filter({ hasText: version }).waitFor();
  await page.locator('#rehearsal-learner').fill(REHEARSER); await page.locator('#rehearsal-issue').click(); await t.waitStatus(/리허설 코드를 발급했습니다/); return page.locator('#rehearsal-token').inputValue(); }
const readinessText = async (t) => { await t.page.locator('#readiness-load').click(); await t.page.waitForTimeout(500); return t.page.locator('#readiness').innerText(); };
async function confirm(t, file) { const { page } = t; assert.equal(await page.locator('#confirm-go').isDisabled(), false, 'a passed candidate can be confirmed'); await page.locator('#confirm-go').click(); await page.locator('#confirm-status').filter({ hasText: '확정했습니다' }).waitFor(); await page.locator('#confirm').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, file) }); }

/** One rehearsal in a REAL Studio window under the rehearsal code: every step opened, one question, the result sent. */
async function rehearse(code, label, expect) {
  launch('rehearsal-' + label, code, wsR); const win = await attach(); const chat = await enterWork();
  const p0 = await wait(() => panelOf(chat), 'the rehearsal panel'); assert.match(p0.rehearsal, /강사 리허설/);
  assert.deepEqual([p0.step, p0.help, p0.surface], expect.first, 'the rehearsal window draws exactly the candidate\'s first step');
  const header = await waitHeader(chat, expect.mission, 'rehearsal ' + label);
  // "Not executed" is its own answer: sending before any request is refused and nothing is judged.
  await press(chat, '[data-rehearsal-send]', 'the rehearsal send button'); const early = await wait(() => chat.evaluate("document.querySelector('[data-rehearsal-result]')?.textContent"), 'the not-yet answer'); assert.match(early, /아직 AI에게 한 번도 묻지 않았습니다/);
  await shot(win, `g2-mac-${label}-rehearsal-not-executed.png`);
  await ask(chat, `Q-R${label} 이 단계에서 무엇부터 확인할까요`, `Q-R${label}`); await idle(chat);
  for (const id of expect.rest) { await press(chat, `.hp-mission-actions [data-step-id="${id}"]`, 'step ' + id); await wait(async () => (await panelOf(chat))?.step === id, 'panel of ' + id); }
  await press(chat, '[data-rehearsal-send]', 'the rehearsal send button'); const verdict = await wait(() => chat.evaluate("document.querySelector('[data-rehearsal-result]')?.dataset.rehearsalResult"), 'the verdict');
  const p1 = await panelOf(chat); await shot(win, `g2-mac-${label}-rehearsal-${verdict}.png`); await quit();
  const judged = db('SELECT verdict_json FROM authoring_rehearsals WHERE learner_id=? AND verdict IS NOT NULL ORDER BY judged_at DESC LIMIT 1', REHEARSER)[0];
  return { verdict, header, first: p0, last: p1, call: callsFor(`Q-R${label}`).findLast((c) => c.tools.length > 0) ?? callsFor(`Q-R${label}`).at(-1), mission_check: JSON.parse(judged.verdict_json).checks.mission };
}

const session = { pid: process.pid, service: origin, instructor: 'http://127.0.0.1:' + boardPort + '/authoring', cohort: local.cohort, profile: local.profile, app: copy, source_sha: head, extension_source_sha: manifest.extension.source_sha, extension_bundles: manifest.extension.bundles, shell: manifest.shell, agent_sdk: { version: manifest.agent_sdk.version, binary_sha256: manifest.agent_sdk.binary.sha256 }, ports: { service: servicePort, instructor: boardPort, app_debug: debugPort } };
writeFileSync(path.join(out, 'session.json'), JSON.stringify(session, null, 2));
const cleanup = async (code = 0) => { clearInterval(timer); try { await quit(); } catch {} try { await browser?.close(); } catch {} server.close(); board.close(); local.close(); process.exit(code); }; process.on('SIGINT', () => cleanup(130));
const result = { schema: 'hps-classroom-mac-curriculum/1', at: new Date().toISOString(), ...session, model: 'scripted recorder (no real model was called)' };
try {
  // ── A: author → review → candidate → rehearsal in a real window → confirm ──
  teacher = await authoringPage();
  const A = { title: '첫 시제품 — 예약 안내 페이지', audience: '처음 만들어 보는 원장님', objective: '예약 안내 페이지의 첫 판을 만들고 확인 기준을 스스로 정한다', starter: '예약 안내 페이지 예제 폴더', step: { title: '확인 기준 정하기', acceptance: '저장한 확인 기준 한 줄이 있다', help: ['hint', 'independent'], default: 'hint', ui: 'criterion_form' }, features: ['read'],
    key: 'A', mission: { week: 1, mission: '예약 안내 첫 판을 만들고 확인 기준을 먼저 정한다', completion: [['확인 기준을 한 줄로 적었다', 'criterion_set'], ['첫 판을 직접 열어 확인했다', 'test_observed']] } };
  await author(teacher, A); await teacher.page.screenshot({ path: path.join(out, 'g2-mac-01-authoring-A.png') });
  result.impact_A = await reviewAgainst(teacher, V1, 'g2-mac-02-review-A-vs-V1.png');
  assert.ok(result.impact_A.includes('학생 미션: 미션 없음 → 1주차 ‘' + A.mission.mission + '’'), result.impact_A.join('\n'));
  assert.ok(result.impact_A.includes('완료 조건: 없음 → ‘확인 기준을 한 줄로 적었다’(기대 조건 적기), ‘첫 판을 직접 열어 확인했다’(직접 확인하기)'), result.impact_A.join('\n'));
  const codeA = await candidate(teacher, VA); assert.match(await readinessText(teacher), /리허설 중 — .*\(준비 완료 아님\)/); await teacher.page.locator('#readiness').evaluate((e) => e.scrollIntoView({ block: 'center' })); await teacher.page.screenshot({ path: path.join(out, 'g2-mac-03-rehearsal-A-running.png') });
  step('candidate A frozen, rehearsal code issued');
  assert.match(await readinessText(teacher), new RegExp('이 후보의 학생 미션: 1주차 ‘' + A.mission.mission + '’ · 완료 조건 2개'));
  result.rehearsal_A = await rehearse(codeA, 'A', { first: ['intro', [['hint', true], ['independent', false]], 'criterion_form'], rest: ['build', 'review'], mission: A.mission });
  assert.equal(result.rehearsal_A.mission_check.result, 'match', JSON.stringify(result.rehearsal_A.mission_check)); assert.deepEqual(result.rehearsal_A.call.mission, [1, A.mission.mission], 'the rehearsal request carried A\'s mission');
  assert.equal(result.rehearsal_A.verdict, 'passed', JSON.stringify(result.rehearsal_A)); assert.deepEqual([result.rehearsal_A.call.lesson, result.rehearsal_A.call.help?.mode], [VA, '힌트 받기']);
  assert.ok(!result.rehearsal_A.call.tools.some((n) => ['Write', 'Edit', 'MultiEdit'].includes(n)), 'A is read-only at the model boundary: ' + result.rehearsal_A.call.tools);
  const readyA = await readinessText(teacher); assert.match(readyA, /통과 — 학생 조건에서 설계대로 실행됐습니다/); assert.match(readyA, /리허설 학생 화면의 미션: 이 후보와 같았습니다/); await teacher.page.locator('#readiness-detail').evaluate((e) => { e.closest('details').open = true; }); await teacher.page.locator('#readiness').evaluate((e) => e.scrollIntoView({ block: 'center' })); await teacher.page.screenshot({ path: path.join(out, 'g2-mac-04-rehearsal-A-passed.png') });
  await confirm(teacher, 'g2-mac-05-confirmed-A.png'); step('A confirmed');

  // ── B: a deliberately different curriculum from the same controls ──
  const B = { title: '고쳐 보기 — 진료시간 수정', audience: '첫 판을 만든 원장님', objective: '진료시간 안내를 고치고 무엇을 왜 바꿨는지 남긴다', starter: '첫 판 index.html', step: { title: '고치고 이유 남기기', acceptance: '고친 index.html과 바꾼 이유 한 줄이 있다', help: ['co_edit', 'independent'], default: 'co_edit', ui: 'decision_form' }, features: ['read', 'write'],
    key: 'B', mission: { week: 2, mission: '진료시간을 고치고 왜 바꿨는지 남긴다', completion: [['바꾼 이유를 적었다', 'decision_revised']] } };
  await author(teacher, B); result.impact_B = await reviewAgainst(teacher, VA, 'g2-mac-06-review-B-vs-A.png');
  assert.ok(result.impact_B.includes('학생 미션: 1주차 ‘' + A.mission.mission + '’ → 2주차 ‘' + B.mission.mission + '’'), result.impact_B.join('\n'));
  assert.ok(result.impact_B.includes('완료 조건: ‘확인 기준을 한 줄로 적었다’(기대 조건 적기), ‘첫 판을 직접 열어 확인했다’(직접 확인하기) → ‘바꾼 이유를 적었다’(고른 이유 적기)'), result.impact_B.join('\n'));
  assert.ok(result.impact_B.some((l) => /도움 방식 힌트 받기·직접 해보기 \(처음: 힌트 받기\) → 함께 수정·직접 해보기 \(처음: 함께 수정\)/.test(l)) && result.impact_B.some((l) => /작업 화면 확인 기준 적기 양식 → 결정과 이유 적기 양식/.test(l)) && result.impact_B.some((l) => /허용 기능: read → read, write/.test(l)), result.impact_B.join('\n'));
  const codeB = await candidate(teacher, VB);
  result.rehearsal_B = await rehearse(codeB, 'B', { first: ['intro', [['co_edit', true], ['independent', false]], 'decision_form'], rest: ['build', 'review'], mission: B.mission });
  assert.equal(result.rehearsal_B.mission_check.result, 'match'); assert.deepEqual(result.rehearsal_B.call.mission, [2, B.mission.mission]);
  assert.equal(result.rehearsal_B.verdict, 'passed', JSON.stringify(result.rehearsal_B)); assert.deepEqual([result.rehearsal_B.call.lesson, result.rehearsal_B.call.help?.mode], [VB, '함께 수정']);
  assert.ok(result.rehearsal_B.call.tools.includes('Write'), 'B admits writing at the model boundary: ' + result.rehearsal_B.call.tools);
  assert.match(await readinessText(teacher), /통과/); await confirm(teacher, 'g2-mac-07-confirmed-B.png'); step('B confirmed');

  if (process.env.HPS_G4_JOURNEY === '1') {
    result.journey = await (await import('./g4-journey.mjs')).journey({ local, course, VA, seats, teacherToken, browser, boardPort, prefix, launch, attach, enterWork, palette, toasts, wait, ask, idle, quit, ws, shot, out, press, setValue, step, workFiles, A, waitHeader });
    result.steps = steps; writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log('PASS G4 integrated Mac journey'); await cleanup(0);
  }

  // ── the class: A1 in a real window on V1; A2 connected and never selected; A3 invited but offline ──
  launch('learner', codes.A1, ws); const win = await attach(); let chat = await enterWork();
  const pairing = async () => (await local.request(local.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: roster }, teacherToken)).json.ticket;
  await palette(win, '수업 연결 (강사가 준 코드 입력)', await pairing()); await wait(async () => (await toasts(win)).some((t) => t.includes('수업에 연결했습니다')), 'connected');
  await ask(chat, 'Q-L0 첫 질문입니다', 'Q-L0'); await idle(chat); assert.equal(callsFor('Q-L0')[0].lesson, V1); assert.deepEqual(await panelOf(chat).then((p) => [p.help, p.surface]), [[], 'chat'], 'V1 has no help choice and no work surface');
  result.header_V1 = await waitHeader(chat, null, 'V1 (legacy, no mission)'); assert.equal(callsFor('Q-L0')[0].mission, null, 'V1 has no mission, and none reaches the model');
  await shot(win, 'g2-mac-08-learner-V1.png');

  const manage = await browser.newPage({ viewport: { width: 1280, height: 720 } }); const T = (id) => manage.locator('#' + id).innerText();
  await manage.goto('http://127.0.0.1:' + boardPort + '/manage'); await manage.locator('#token').fill(teacherToken); await manage.locator('#cohort').fill(local.cohort); await manage.locator('#prefix').fill(prefix); await manage.locator('#connect button').first().click(); await manage.locator('#status').filter({ hasText: '연결됨' }).waitFor();
  const row = (id) => manage.locator(`#ops-seats .ops-seat[data-seat="${id}"]`); await row('A2').waitFor();
  const compose = async () => { if (!(await manage.locator('#ops-dist').evaluate((d) => d.open))) await manage.locator('#ops-dist-summary').click(); await manage.locator('#ops-dist-title').waitFor(); };
  const saveForm = async () => { await manage.locator('#ops-dist-save').click(); await manage.locator('#ops-dist-saved').filter({ hasText: '저장했습니다' }).waitFor(); };
  const select = async (ids) => { await manage.locator('#ops-check').click(); await manage.waitForTimeout(800); await manage.locator('#ops-select-none').click(); for (const id of ids) await row(id).getByLabel('선택').check(); };
  const sendTo = async (ids) => { await select(ids); local.db.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run(); await manage.locator('#ops-dist-preview').click(); await manage.locator('#ops-dist-confirm').waitFor(); const impact = await T('ops-dist-impact'), plan = await T('ops-dist-plan'); await manage.locator('#ops-dist-go').click(); await manage.locator('#ops-dist-items').filter({ hasText: /^A1 · / }).waitFor(); return { impact, plan }; };
  let lastItems = '';
  const items = (re, label, ms = 90000) => wait(async () => { await manage.locator('#ops-dist-refresh').click(); await manage.waitForTimeout(400); const t = lastItems = await T('ops-dist-items'); return re.test(t) ? t : null; }, label ?? String(re), ms).catch(async (e) => { await manage.screenshot({ path: path.join(out, 'failed-' + (label ?? 'items').replace(/\W+/g, '-') + '.png') }); throw Error(e.message + ' | board said: ' + lastItems.slice(0, 600)); });
  await compose(); await manage.locator('#ops-dist-new').click(); await manage.locator('#ops-dist-kind').selectOption('setting'); await manage.locator(`#ops-dist-setting option[value="${VA}"]`).waitFor({ state: 'attached' });
  result.setting_options = await manage.locator('#ops-dist-setting option').evaluateAll((os) => os.map((o) => [o.value, o.textContent, o.disabled]));
  assert.ok(result.setting_options.some(([v, t, d]) => v === VA && /리허설 통과·확정됨/.test(t) && !d));

  // Old turn stable: a question under V1 is still being answered while A is sent to A1 (and to offline A3).
  let release; holdGate = new Promise((r) => { release = r; });
  await ask(chat, 'HOLD-L1 V1에서 시작한 질문입니다', 'HOLD-L1');
  await manage.locator('#ops-dist-setting').selectOption(VA); await manage.locator('#ops-dist-title').fill('A — 첫 시제품'); await manage.locator('#ops-dist-body').fill('다음 질문부터 확인 기준을 먼저 정합니다.'); await saveForm();
  result.send_A = await sendTo(['A1', 'A3']); await manage.screenshot({ path: path.join(out, 'g2-mac-09-manage-send-A-A1-A3.png') });
  result.items_A_prepared = await items(/A1 · .* 설정: 준비 — 기기 보관함에 있음/, 'A1 prepared'); assert.match(result.items_A_prepared, /A3 · .*(연결 없음|오프라인|연결되면|미확인|대기)/, 'A3 is offline: pending, never shown as applied');
  release(); holdGate = null; await idle(chat);
  assert.deepEqual(callsFor('HOLD-L1').map((c) => c.lesson), callsFor('HOLD-L1').map(() => V1), 'the running turn kept V1 to its end');
  assert.deepEqual(callsFor('HOLD-L1').map((c) => c.mission), callsFor('HOLD-L1').map(() => null), 'the running turn kept V1\'s (absent) mission context to its end');
  // Next turn: the switch, then A's help/surface/tools at the execution boundary.
  await ask(chat, 'Q-LA1 이제 무엇을 할까요', 'Q-LA1'); await idle(chat);
  const la1 = callsFor('Q-LA1').at(-1); assert.deepEqual([la1.lesson, la1.help?.mode, la1.help?.source], [VA, '힌트 받기', '수업 기본값입니다']);
  assert.deepEqual(la1.mission, [1, A.mission.mission], 'the next turn carried A\'s mission'); result.header_A = await waitHeader(chat, A.mission, 'A1 on A'); assert.ok(!la1.tools.some((n) => ['Write', 'Edit', 'MultiEdit'].includes(n)), 'A1 on A: no write tool');
  let p = await wait(async () => { const x = await panelOf(chat); return x?.surface === 'criterion_form' ? x : null; }, 'A\'s work surface on the learner\'s screen'); assert.deepEqual(p.help, [['hint', true], ['independent', false]]);
  await press(chat, 'input[name="hp-help-mode"][value="independent"]', 'the help choice 직접 해보기');
  await setValue(chat, '[data-surface="criterion_form"] textarea', '예약 버튼이 첫 화면에서 바로 보인다'); await press(chat, '[data-surface="criterion_form"] button[type="submit"]', 'the criterion save button');
  await wait(async () => /저장한 기준: 예약 버튼이 첫 화면에서 바로 보인다/.test((await panelOf(chat))?.saved ?? ''), 'the saved criterion on screen'); await shot(win, 'g2-mac-10-learner-A-criterion.png');
  await ask(chat, 'Q-LA2 기준대로 확인해 주세요', 'Q-LA2'); await idle(chat);
  const la2 = callsFor('Q-LA2').at(-1); assert.deepEqual([la2.lesson, la2.help?.mode, la2.help?.source], [VA, '직접 해보기', '학생이 직접 골랐습니다']); assert.match(la2.criterion ?? '', /예약 버튼이 첫 화면에서 바로 보인다/, 'the learner\'s saved criterion reached the model with the next turn');
  result.items_A_applied = await items(/A1 · .* 설정: 적용/, 'A1 applied'); await manage.screenshot({ path: path.join(out, 'g2-mac-11-manage-A-applied.png') });
  // A2 was never selected: no setting reached its device and its binding did not move.
  assert.equal(blocksA2.flatMap((b) => b.items ?? []).filter((i) => i.kind === 'setting').length, 0, 'nothing of the setting reached A2'); assert.deepEqual(bindingsOf(seats[1].student_id), [], 'A2 still runs its token lesson (V1)');
  assert.deepEqual(bindingsOf(seats[2].student_id), [], 'A3 (offline) is not switched');
  step('A applied to A1 only');

  // ── B to A1: the other teaching role at the execution boundary ──
  await compose(); await manage.locator(`#ops-dist-setting option[value="${VB}"]`).waitFor({ state: 'attached' }); await manage.locator('#ops-dist-setting').selectOption(VB); await manage.locator('#ops-dist-title').fill('B — 고쳐 보기'); await manage.locator('#ops-dist-body').fill('다음 질문부터 함께 고치고 이유를 남깁니다.'); await saveForm();
  result.send_B = await sendTo(['A1']); await items(/A1 · .* 설정: 준비 — 기기 보관함에 있음/, 'B prepared');
  await ask(chat, 'Q-LB1 진료시간을 고치고 싶어요', 'Q-LB1'); await idle(chat);
  const lb1 = callsFor('Q-LB1').at(-1); assert.deepEqual([lb1.lesson, lb1.help?.mode], [VB, '함께 수정']);
  assert.deepEqual(lb1.mission, [2, B.mission.mission], 'the next turn carried B\'s mission'); result.header_B = await waitHeader(chat, B.mission, 'A1 on B'); assert.ok(lb1.tools.includes('Write'), 'B admits writing: ' + lb1.tools);
  p = await wait(async () => { const x = await panelOf(chat); return x?.surface === 'decision_form' ? x : null; }, 'B\'s decision surface'); assert.deepEqual(p.help, [['co_edit', true], ['independent', false]]);
  await setValue(chat, '[data-surface="decision_form"] input', '토요일 진료시간을 오후 2시까지로 고친다'); await setValue(chat, '[data-surface="decision_form"] textarea', '원장님이 확인한 실제 시간이라서');
  await press(chat, '[data-surface="decision_form"] button[type="submit"]', 'the decision save button'); await wait(async () => /저장한 결정: 토요일/.test((await panelOf(chat))?.saved ?? ''), 'the saved decision'); await shot(win, 'g2-mac-12-learner-B-decision.png');
  await ask(chat, 'Q-LB2 이유까지 반영해 주세요', 'Q-LB2'); await idle(chat); const lb2 = callsFor('Q-LB2').at(-1); assert.deepEqual(lb2.decision, ['토요일 진료시간을 오후 2시까지로 고친다', '원장님이 확인한 실제 시간이라서']);
  await items(/A1 · .* 설정: 적용/, 'B applied'); step('B applied to A1');

  // ── restart: the window comes back on B with the learner's files untouched ──
  await quit(); launch('learner', codes.A1, ws); const win2 = await attach(); chat = await enterWork();
  await ask(chat, 'Q-LB3 다시 열었습니다', 'Q-LB3'); await idle(chat); assert.equal(callsFor('Q-LB3').at(-1).lesson, VB, 'after a restart the next turn still runs B');
  assert.deepEqual(callsFor('Q-LB3').at(-1).mission, [2, B.mission.mission]); result.header_restart = await waitHeader(chat, B.mission, 'after restart'); await shot(win2, 'g2-mac-12b-learner-B-after-restart.png');
  assert.equal((await panelOf(chat)).surface, 'decision_form'); step('restart kept B');
  // This host keeps secrets in memory (--use-inmemory-secretstorage), so the class-connection credential does not survive the
  // restart: the learner enters a fresh connection code, as after a lost device credential. The lesson binding is the
  // Service's and did not need it (Q-LB3 above ran B before reconnecting). Keychain persistence of an installed app: NOT RUN.
  await palette(win2, '수업 연결 (강사가 준 코드 입력)', await pairing()); await wait(async () => (await toasts(win2)).some((t) => t.includes('수업에 연결했습니다')), 'reconnected'); step('reconnected after restart');
  // ── rollback: the return to the class's own version is an ordinary setting revision ──
  await manage.locator('#ops-dist-return').click(); await saveForm(); await sendTo(['A1']); await items(/A1 · .* 설정: 준비 — 기기 보관함에 있음/, 'return prepared');
  await ask(chat, 'Q-L9 복귀 뒤 질문', 'Q-L9'); await idle(chat); assert.equal(callsFor('Q-L9').at(-1).lesson, V1, 'the return runs V1 again');
  assert.equal(callsFor('Q-L9').at(-1).mission, null); result.header_return = await waitHeader(chat, null, 'after the return to V1'); await shot(win2, 'g2-mac-14-learner-returned-V1.png'); await items(/설정: 적용 .*\(기본 수업\)/, 'return applied');
  await manage.screenshot({ path: path.join(out, 'g2-mac-13-manage-returned.png') }); step('rollback to V1');
  assert.deepEqual(workFiles(), { changed: [], added: [] }, 'the learner\'s files are the bytes written before the app started');

  Object.assign(result, { provider_calls: providerCalls.map(({ at, ...c }) => c), wire: wire.map(({ at, ...w }) => w), bindings: { A1: bindingsOf(seats[0].student_id), A2: bindingsOf(seats[1].student_id), A3: bindingsOf(seats[2].student_id) }, work_files: workFiles(), rehearsals: db('SELECT version,learner_id,verdict,judged_at IS NOT NULL AS judged FROM authoring_rehearsals ORDER BY created_at'), confirmations: db('SELECT version,rehearsal_id,confirmed_by FROM authoring_confirmations'), steps });
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log('PASS — G2 on this Mac: A and B authored, rehearsed in real windows, confirmed, applied to A1 only; old turn kept V1; restart and return safe → ' + path.join(out, 'result.json'));
  await cleanup(0);
} catch (e) { console.error(e); writeFileSync(path.join(out, 'result-failed.json'), JSON.stringify({ ...result, error: String(e?.stack ?? e), provider_calls: providerCalls, wire, steps }, null, 2)); await cleanup(1); }
