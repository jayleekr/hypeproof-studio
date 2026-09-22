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
// Review at d32a191 added: every learner control is pressed with REAL mouse input at its on-screen position after checking
// that it is visible and not covered (a DOM node is not a card the learner can open); the inbox is checked in BOTH windows
// after the second one connects; the learner's files are compared with the bytes written BEFORE the app started; a draft
// with two pasted images and a parked message; a withdrawal after import; the spool's provenance; injected switch timeout,
// lost switch answer and profile 5xx; the run switch going off and a read fault in the MIDDLE of a multi-request SDK turn.
// HPS_U3_MODE=proxy runs the short proxy-runtime variant (another compiled profile of the same synthetic cohort) and exits.
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
const MODE = process.env.HPS_U3_MODE === 'proxy' ? 'proxy' : 'full';
const servicePort = Number(process.env.HPS_U3_SERVICE_PORT || 18781), boardPort = Number(process.env.HPS_U3_BOARD_PORT || 18782), debugPort = Number(process.env.HPS_U3_DEBUG_PORT || 9381), prefix = 'u3-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-', HOURS = 12;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'), json = (p) => JSON.parse(readFileSync(p, 'utf8')), out = path.join(home, MODE === 'proxy' ? 'lesson-settings-proxy' : 'lesson-settings'); mkdirSync(out, { recursive: true });
const manifest = json(path.join(home, 'manifest.json')), copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
assert.ok(!copy.startsWith('/Applications'), 'never the installed app');
for (const [f, h] of Object.entries(manifest.extension.bundles)) { assert.equal(sha(path.join(ext, f)), h, `${f} changed since prepare`); assert.equal(sha(path.join(repo, 'extensions/hypeproof-chat', f)), h, `${f}: the prepared copy is not the current build — prepare again`); }
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', manifest.extension.source_sha, head, '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src'], { cwd: repo, encoding: 'utf8' }), '', 'extension sources changed since prepare');
assert.ok(manifest.agent_sdk?.vendored === true && manifest.agent_sdk.binary, 'the dev host has no Agent SDK: prepare again');
const steps = []; const step = (name, detail = {}) => { steps.push({ at: new Date().toISOString(), name, ...detail }); console.log('STEP ' + name + (Object.keys(detail).length ? ' ' + JSON.stringify(detail) : '')); };

// ── Service: real router + SQLite. The class and its tokens last HOURS so that a person can keep using what is left running. ──
const local = await localOps(MODE === 'proxy' ? { profile: 'boah-dental-teaser-2026-s1' /* same synthetic cohort, proxy runtime */ } : {}), { setRoster, startSession } = await import('../../worker/src/lib/kv.ts'), { readLesson } = await import('../../worker/src/lib/lesson-delivery.ts');
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

// ── the learner's machine: own profile, own HOME, two workspaces. The bytes are fixed HERE, before anything starts. ──
const userDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hps-751-u3-'))), ws = path.join(userDir, 'ws'), ws2 = path.join(userDir, 'ws-second-window'), fakeHome = path.join(userDir, 'home'); for (const d of [path.join(userDir, 'User'), ws, ws2, fakeHome]) mkdirSync(d, { recursive: true });
const ORIGINALS = { [path.join(ws, 'index.html')]: '<!doctype html><title>학생 작업</title><h1>SYNTHETIC LEARNER WORK</h1>\n', [path.join(ws, 'notes.md')]: '# 내 메모\n- 예약 버튼 위치 확인\n', [path.join(ws2, 'second.md')]: '# 두 번째 창\n- 이 파일은 학생의 것입니다\n' };
for (const [file, text] of Object.entries(ORIGINALS)) writeFileSync(file, text);
const digest = (buf) => createHash('sha256').update(buf).digest('hex'), ORIGINAL_HASHES = Object.fromEntries(Object.entries(ORIGINALS).map(([f, text]) => [f, digest(Buffer.from(text, 'utf8'))]));
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
/** The learner's files NOW against the bytes written before the app started — not against themselves. New files are listed, never ignored. */
const workFiles = () => { const now = Object.fromEntries([ws, ws2].flatMap(walk).sort().map((f) => [f, digest(readFileSync(f))])); return { changed: Object.keys(ORIGINAL_HASHES).filter((f) => now[f] !== ORIGINAL_HASHES[f]), added: Object.keys(now).filter((f) => !(f in ORIGINAL_HASHES)).map((f) => path.relative(userDir, f)) }; };
{ // the comparator catches a change (it used to compare the current files with themselves)
  const probe = path.join(ws, 'notes.md'); writeFileSync(probe, ORIGINALS[probe] + 'tampered'); assert.deepEqual(workFiles().changed, [probe], 'negative control: a changed learner file is caught'); writeFileSync(probe, ORIGINALS[probe]); assert.deepEqual(workFiles(), { changed: [], added: [] }, 'positive control'); }

// ── the ONLY scripted thing: the model provider. It records which lesson each call ran under, can hold one answer open, and can ask for one tool. ──
const providerCalls = [], realFetch = globalThis.fetch, ANSWER = '[로컬 시험 응답] 실제 AI 모델은 호출하지 않았습니다.'; let holding = 0, holdGate = null; const onToolUse = {};
const enc = new TextEncoder(), ev = (e, d) => enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
function sse(model, blocks, stop, gate) { const id = 'synthetic-' + providerCalls.length;
  return new Response(new ReadableStream({ async start(c) {
    c.enqueue(ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
    for (const [i, b] of blocks.entries()) { c.enqueue(ev('content_block_start', { type: 'content_block_start', index: i, content_block: b.start })); c.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: i, delta: b.first })); if (gate && i === 0) await gate; c.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: i, delta: b.delta })); c.enqueue(ev('content_block_stop', { type: 'content_block_stop', index: i })); }
    c.enqueue(ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 9 } })); c.enqueue(ev('message_stop', { type: 'message_stop' })); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }); }
const textBlock = (t) => [{ start: { type: 'text', text: '' }, first: { type: 'text_delta', text: t.slice(0, 8) }, delta: { type: 'text_delta', text: t.slice(8) } }];
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.origin === 'https://service.test') return local.app.fetch(new Request(input, init), local.env, { waitUntil() {} });
  assert.equal(url.origin, 'https://api.anthropic.com', 'unexpected outbound request from the Service: ' + url.origin);
  const raw = String(init.body), body = JSON.parse(raw), lesson = raw.includes('craft-v3') ? V3 : raw.includes('craft-v2') ? V2 : V1, marks = [...new Set(raw.match(/\b(?:Q|HOLD)-[A-Z0-9]+(?:-[A-Z0-9]+)*/g) ?? [])];
  // Which question is this request about? The mark that appears LAST in the conversation it carries (the SDK does not put the
  // learner's text in a predictable message slot — assuming "the last message" was an instrument error of the first run).
  const convo = JSON.stringify(body.messages ?? []), current = marks.map((m) => [m, convo.lastIndexOf(m)]).filter(([, i]) => i >= 0).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null, at = current ? convo.lastIndexOf(current) : -1;
  const held = !!holdGate && !!current && current.startsWith('HOLD-'), toolMark = current && current.startsWith('Q-TOOLS') ? current : null;
  const hasToolResult = convo.lastIndexOf('"tool_result"') > at, wantsTool = !!toolMark && (body.tools ?? []).some((t) => t.name === 'Read') && !hasToolResult;
  providerCalls.push({ at: Date.now(), model: body.model, stream: body.stream === true, tools: (body.tools ?? []).length, lesson, marks, last_marks: current ? [current] : [], held, answered: wantsTool ? 'tool_use' : 'end_turn', prompt_text: at >= 0 && convo.indexOf('세 문장으로 설명', at) >= 0 });
  if (held) holding++;
  if (wantsTool) { await onToolUse[toolMark]?.(); return sse(body.model, [{ start: { type: 'tool_use', id: 'toolu_' + providerCalls.length, name: 'Read', input: {} }, first: { type: 'input_json_delta', partial_json: '' }, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: path.join(ws2, 'second.md') }) } }], 'tool_use', null); }
  return body.stream ? sse(body.model, textBlock(ANSWER), 'end_turn', held ? holdGate : null) : Response.json({ id: 'synthetic', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 9 } });
};
const callsFor = (mark) => providerCalls.filter((c) => c.last_marks.includes(mark));
// What the app really sent to the Service over real HTTP (never the Authorization value) — and the three injected transport faults of S4.
const wire = [], faults = { switchDrop: false, switchLate: false, profile503: false }, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts), url = req.url.split('?')[0], note = (o) => wire.push({ at: Date.now(), method: req.method, path: url.replace(/lesson-turns\/[^/]+/, 'lesson-turns/:turn'), turn: req.headers['x-hps-turn-id'] ? String(req.headers['x-hps-turn-id']).slice(0, 8) : null, binding: req.headers['x-hps-lesson-binding'] ?? null, ...o });
  if (url === '/v1/classroom/ops/lesson-binding' && faults.switchDrop) { note({ status: 'dropped (no answer for 5 s, never forwarded)' }); await sleep(5000); res.writeHead(504); res.end(); return; }
  if (url === '/v1/profile' && faults.profile503) { note({ status: 503, injected: true }); res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'unavailable', message: 'injected' } })); return; }
  const r = await local.app.fetch(new Request('https://service.test' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), local.env, { waitUntil() {}, passThroughOnException() {} });
  let switched; if (url === '/v1/classroom/ops/lesson-binding') { try { const j = await r.clone().json(); switched = { recorded: j.recorded === true, replayed: j.replayed === true, reason: j.reason ?? null, seq: j.binding?.seq ?? null }; } catch { switched = null; } if (faults.switchLate) { note({ status: r.status, switched, injected: 'answer held for 5 s (the app gives up after 4)' }); await sleep(5000); } }
  if (/^\/v1\/(messages|chat|profile|lesson-turns|classroom\/ops\/lesson-binding)/.test(url) && !(url === '/v1/classroom/ops/lesson-binding' && faults.switchLate)) note({ status: r.status, ...(switched !== undefined ? { switched } : {}) });
  res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) for await (const chunk of r.body) res.write(chunk); res.end(); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
server.listen(servicePort, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
const { default: chalk } = await import('../../chalk/src/index.ts');
const board = createServer(async (req, res) => { try { const parts = []; for await (const b of req) parts.push(b); const body = Buffer.concat(parts);
  const rr = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(rr.status, Object.fromEntries(rr.headers)); res.end(Buffer.from(await rr.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
board.listen(boardPort, '127.0.0.1'); await once(board, 'listening');

writeFileSync(path.join(userDir, 'User/settings.json'), JSON.stringify({ 'hypeproofChat.proxyUrl': origin + '/v1', 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }));
const tokenPath = path.join(home, 'synthetic-learner-token-u3.txt'); writeFileSync(tokenPath, token, { mode: 0o600 }); const teacherPath = path.join(home, 'synthetic-instructor-token-u3.txt'); writeFileSync(teacherPath, teacherToken, { mode: 0o600 });
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
const wait = async (fn, label, ms = 60000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(300); } throw Error('timed out: ' + label + (last instanceof Error ? ' — ' + last.message : '')); };
const workbenches = () => cdp.contexts().flatMap((c) => c.pages()).filter((p) => p.url().includes('workbench'));
async function attach() { cdp = null; for (let i = 0; i < 90 && !cdp; i++) { try { cdp = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort); } catch { await sleep(1000); } } assert.ok(cdp, 'the Studio copy did not open its debugging port'); const w = await wait(() => workbenches()[0], 'workbench window', 90000); await w.waitForTimeout(6000); return w; }
const toasts = (w) => w.evaluate(() => [...document.querySelectorAll('.notifications-toasts .notification-list-item-message, .notifications-center .notification-list-item-message')].map((e) => e.textContent));
const palette = async (w, title, typed) => { await w.bringToFront(); await w.keyboard.press('F1'); await w.waitForSelector('.quick-input-widget input', { state: 'visible' }); await w.keyboard.type(title, { delay: 15 }); await wait(() => w.evaluate((t) => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => r.textContent.includes(t)), title), 'command ' + title); await w.keyboard.press('Enter');
  if (typed !== undefined) { await wait(() => w.evaluate(() => document.querySelector('.quick-input-widget')?.textContent.includes('수업 연결 코드')), 'ticket prompt'); await w.keyboard.type(typed, { delay: 10 }); await w.keyboard.press('Enter'); } };
/** A webview of this extension that contains `selector` and satisfies `where`. Returns an evaluator AND the raw input channel of that webview. */
const frame = (selector, where = 'true', ms = 60000) => wait(async () => { for (const t of (await (await realFetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).filter((x) => x.type === 'iframe' && x.url.includes('hypeproof-chat'))) { const sock = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; }); let id = 0; const pending = new Map();
    sock.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { const [r, j] = pending.get(m.id); pending.delete(m.id); m.error ? j(Error(m.error.message)) : r(m.result); } }; const send = (method, params = {}) => new Promise((r, j) => { const n = ++id; pending.set(n, [r, j]); sock.send(JSON.stringify({ id: n, method, params })); });
    await send('Page.enable'); const { frameTree } = await send('Page.getFrameTree'); for (const f of [frameTree, ...(frameTree.childFrames || [])]) { const contextId = (await send('Page.createIsolatedWorld', { frameId: f.frame.id, worldName: 'u3-m2' })).executionContextId; const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true })).result?.value;
      if (await evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')&&!!(' + where + ')')) return { evaluate, send }; } sock.close(); } return null; }, 'webview ' + selector + ' where ' + where, ms);
const TEXTAREA = '.hps-input textarea', hasText = (t) => 'document.body.textContent.includes(' + JSON.stringify(t) + ')';
/**
 * What a learner does: look at the control, move the mouse there, press. The control must have a size, be inside the webview's
 * viewport after scrolling to it, be the topmost element at its centre, be enabled and visible — a node in the DOM that fails
 * any of these is not something a learner can use, and the run fails instead of calling .click() on it.
 */
async function press(chat, selector, label) {
  const r = await chat.evaluate(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,250));const b=e.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2,hit=document.elementFromPoint(x,y),cs=getComputedStyle(e);return {x,y,w:Math.round(b.width),h:Math.round(b.height),in_view:b.top>=0&&b.bottom<=innerHeight&&b.left>=0&&b.right<=innerWidth,topmost:!!hit&&(hit===e||e.contains(hit)),disabled:!!e.disabled,visible:cs.visibility==='visible'&&cs.display!=='none'&&Number(cs.opacity)>0,text:e.textContent.trim().slice(0,40)};})()`);
  assert.ok(r && r.w > 0 && r.h > 0 && r.in_view && r.topmost && !r.disabled && r.visible, label + ' is not a visible control a learner can press: ' + JSON.stringify(r));
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await chat.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await sleep(350); return r; }
const setDraft = (chat, text) => chat.evaluate(`(()=>{const e=document.querySelector('${TEXTAREA}');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();})()`);
const pressEnter = (chat) => chat.evaluate(`(()=>{const e=document.querySelector('${TEXTAREA}');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));})()`);
const draftOf = (chat) => chat.evaluate(`document.querySelector('${TEXTAREA}').value`), attachments = (chat) => chat.evaluate("document.querySelectorAll('.hps-attachment').length"), parkedOf = (chat) => chat.evaluate("document.querySelector('.hps-queued-text')?.textContent ?? null");
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pasteImage = (chat, name) => chat.evaluate(`(()=>{const e=document.querySelector('${TEXTAREA}'),b=Uint8Array.from(atob('${PNG}'),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([b,${JSON.stringify(name)}],${JSON.stringify(name)},{type:'image/png'}));e.focus();e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
/** What the learner can SEE of the inbox: whether it is drawn, where, and the cards once opened (read-only; opening is done with press()). */
const INBOX = `(()=>{const d=document.querySelector('details.hp-inbox[data-inbox-generation]');if(!d)return null;const s=d.querySelector('summary'),b=s.getBoundingClientRect();return {open:d.open,summary:s.textContent.trim(),summary_on_screen:b.width>0&&b.height>0&&b.bottom>0&&b.top<innerHeight,cards:[...d.querySelectorAll('li.hp-inbox-card')].map(li=>({object:li.dataset.inboxObject,revision:li.dataset.inboxRevision,open:!!li.querySelector('details')?.open,title:li.querySelector('.hp-inbox-title')?.textContent??'',meta:[...li.querySelectorAll('.hp-inbox-meta')].map(m=>m.textContent).join(' | '),body:li.querySelector('.hp-inbox-body')?.textContent??'',setting:li.querySelector('[data-inbox-setting]')?.dataset.inboxSetting??null,canImport:!!li.querySelector('[data-inbox-import]'),withdrawn:/회수한 자료/.test(li.textContent)})),modals:document.querySelectorAll('[role=dialog],dialog[open]').length};})()`;
const inboxOf = (chat) => chat.evaluate(INBOX);
/** Open the list, then the card whose title contains `title`, the way a learner does. Returns that card as drawn. */
async function openCard(chat, title) { let v = await wait(async () => { const x = await inboxOf(chat); return x && x.cards.some((c) => c.title.includes(title) || (!title && c.withdrawn)) ? x : null; }, 'the inbox shows ‘' + title + '’', 90000);
  assert.equal(v.summary_on_screen, true, 'the inbox line is on the learner\'s screen'); if (!v.open) await press(chat, 'details.hp-inbox > summary', 'the inbox line');
  const i = (await inboxOf(chat)).cards.findIndex((c) => c.title.includes(title)); const sel = `details.hp-inbox li.hp-inbox-card:nth-of-type(${i + 1})`; if (!(await inboxOf(chat)).cards[i].open) await press(chat, sel + ' details > summary', 'the card ‘' + title + '’');
  v = await inboxOf(chat); assert.equal(v.cards[i].open, true, 'the card opened'); return { card: v.cards[i], sel }; }
const enterWork = async (where) => { const e = await frame('.studio-primary, ' + TEXTAREA, where, 120000); if (await e.evaluate("!!document.querySelector('.studio-primary')")) await press(e, '.studio-primary', 'the entry screen\'s Primary'); return frame(TEXTAREA, where); };
const pairing = async () => (await local.request(local.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: roster }, teacherToken)).json.ticket;
const connectSeat = async (w) => { await palette(w, '수업 연결 (강사가 준 코드 입력)', await pairing()); await wait(async () => (await toasts(w)).some((t) => t.includes('수업에 연결했습니다')), 'connected'); };
const shot = async (w, name) => { try { await w.screenshot({ path: path.join(out, name) }); } catch (e) { console.log('screenshot skipped: ' + e.message); } };
const db = (sql, ...a) => local.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const bindings = () => db('SELECT binding_seq,source,version,first_dispatched_at IS NOT NULL AS dispatched,first_completed_at IS NOT NULL AS completed FROM classroom_lesson_bindings WHERE student_id=? ORDER BY binding_seq', seats[0].student_id);
const turns = () => db('SELECT substr(turn_id,1,8) AS turn,binding_seq,version,(SELECT COUNT(*) FROM classroom_lesson_requests q WHERE q.class_run_id=classroom_lesson_turns.class_run_id AND q.student_id=classroom_lesson_turns.student_id AND q.turn_id=classroom_lesson_turns.turn_id) AS requests,closed_at IS NOT NULL AS closed,close_outcome,first_dispatched_at IS NOT NULL AS dispatched,first_completed_at IS NOT NULL AS completed,last_failure_kind FROM classroom_lesson_turns WHERE student_id=? ORDER BY admitted_at', seats[0].student_id);
const ask = async (chat, text, mark, ms = 120000) => { const n = providerCalls.length; await setDraft(chat, text); await pressEnter(chat); await wait(() => providerCalls.slice(n).some((c) => c.last_marks.includes(mark)), 'the provider was called for ' + mark, ms); };
const answers = (chat) => chat.evaluate(`(document.body.textContent.match(/로컬 시험 응답/g)||[]).length`), answered = (chat, count) => wait(async () => (await answers(chat)) >= count, count + ' answers on screen', 120000);
const idle = (chat) => wait(() => chat.evaluate("![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Stop')"), 'the turn ended on screen', 120000);
const spool = () => walk(path.join(fakeHome, 'Library/Application Support/HypeProof-Studio/logs/sessions')).filter((f) => f.endsWith('events.jsonl')).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));

const session = { mode: MODE, pid: process.pid, service: origin, instructor_url: 'http://127.0.0.1:' + boardPort + '/manage', cohort: local.cohort, profile: local.profile, student_prefix: prefix, instructor_token_file: teacherPath, learner_token_file: tokenPath, app: copy, real_seat: 'A1', synthetic_seat: 'A2', student: seats[0].student_id, user_data_dir: userDir, workspaces: [ws, ws2], ports: { service: servicePort, instructor: boardPort, app_debug: debugPort }, valid_until: endsAt, source_sha: head, extension_source_sha: manifest.extension.source_sha, extension_bundles: manifest.extension.bundles, shell: manifest.shell.version, agent_sdk: manifest.agent_sdk.version };
writeFileSync(path.join(home, MODE === 'proxy' ? 'lesson-settings-proxy-session.json' : 'lesson-settings-session.json'), JSON.stringify(session, null, 2));
const cleanup = () => { clearInterval(timer); try { app?.kill(); } catch {} server.close(); board.close(); local.close(); process.exit(0); }; process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);

let browser = null;
async function instructor() { browser = await chromium.launch({ headless: process.env.HPS_BOARD_HEADLESS === '1' }); const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.goto('http://127.0.0.1:' + boardPort + '/manage'); await page.locator('#token').fill(teacherToken); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill(prefix); await page.locator('#connect button').first().click(); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await page.locator('#ops-check').click();
  const row = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`), T = (id) => page.locator('#' + id).innerText(); await row('A2').waitFor();
  const compose = async () => { if (!(await page.locator('#ops-dist').evaluate((d) => d.open))) await page.locator('#ops-dist-summary').click(); await page.locator('#ops-dist-title').waitFor(); };
  const kinds = () => page.locator('#ops-dist-kind option').evaluateAll((os) => os.filter((o) => !o.hidden && !o.disabled).map((o) => o.value));
  const onlyA1 = async () => { await page.locator('#ops-check').click(); await page.waitForTimeout(800); await page.locator('#ops-select-none').click(); await row('A1').getByLabel('선택').check(); };
  const saveForm = async () => { await page.locator('#ops-dist-save').click(); await page.locator('#ops-dist-saved').filter({ hasText: '저장했습니다' }).waitFor(); };
  const sendToA1 = async () => { await onlyA1(); local.db.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run(); await page.locator('#ops-dist-preview').click(); await page.locator('#ops-dist-confirm').waitFor(); const impact = await T('ops-dist-impact'); assert.equal(await page.locator('#ops-dist-go').innerText(), '1명에게 보내기'); await page.locator('#ops-dist-go').click(); await page.locator('#ops-dist-items').filter({ hasText: /^A1 · / }).waitFor(); return impact; };
  const newMaterial = async (kind, title, body) => { await compose(); await page.locator('#ops-dist-new').click(); await page.locator('#ops-dist-kind').selectOption(kind); await page.locator('#ops-dist-title').fill(title); await page.locator('#ops-dist-body').fill(body); };
  // `fresh`: the run's first setting starts a new material; every later change is the next revision of that one setting object.
  const setting = async (value, title, body, fresh = false) => { await compose(); if (fresh) { await page.locator('#ops-dist-new').click(); await page.locator('#ops-dist-kind').selectOption('setting'); } await page.locator(`#ops-dist-setting option[value="${value}"]`).waitFor({ state: 'attached' }); await page.locator('#ops-dist-setting').selectOption(value); await page.locator('#ops-dist-title').fill(title); await page.locator('#ops-dist-body').fill(body); await saveForm(); return sendToA1(); };
  const items = async (re, label, ms = 90000) => wait(async () => { await page.locator('#ops-dist-refresh').click(); await page.waitForTimeout(400); const t = await T('ops-dist-items'); return re.test(t) ? t : null; }, label ?? String(re), ms);
  const revoke = async () => { await page.locator('#ops-dist-revoke').click(); const impact = await T('ops-dist-revoke-impact'); await page.locator('#ops-dist-revoke-go').click(); await page.locator('#ops-dist-now').filter({ hasText: '이 배포는 회수했습니다' }).waitFor(); return impact; };
  return { page, row, T, compose, kinds, saveForm, sendToA1, newMaterial, setting, items, revoke }; }
const PREPARED = /A1 · .* 설정: 준비 — 기기 보관함에 있음/;

try {
  // The proxy variant models the ordinary order of a class: enforcement and the run switch are ON before the learner's app starts,
  // so its very first question already carries the binding key and is closed by the host (the full run models the other order).
  if (MODE === 'proxy') { local.env.HPS_LESSON_BINDINGS = 'enforce'; const on = await local.request(local.base, 'PUT', { expected_roster_revision: roster, seats, flags: { ops_lesson_settings: true } }, teacherToken); assert.ok(on.status === 200 || on.status === 201, on.raw); roster = on.json.roster_revision ?? roster + 1; }
  launch(); const win = await attach(); let chat = await enterWork(); await connectSeat(win);
  const runtimePath = MODE === 'proxy' ? '/v1/chat/completions' : '/v1/messages';
  if (MODE === 'proxy') {
    // ── the proxy-runtime variant: another compiled profile of the same cohort. The REAL window, the REAL proxy client inside it. ──
    const I = await instructor(); await ask(chat, 'Q-P0 설정 전의 질문', 'Q-P0'); await answered(chat, 1); assert.ok(callsFor('Q-P0').every((c) => c.lesson === V1));
    assert.equal(wire.filter((w) => w.path === runtimePath).at(-1).binding, 'token:' + lessonSha[V1].slice(0, 16), 'enforcement was on before the app started: the FIRST question already carries the token key'); await wait(() => turns().at(-1)?.closed === 1 || null, 'and its turn is closed by the host', 30000);
    const impact = await I.setting(V2, '2판으로 진행', '다음 질문부터 2판 단계로 진행합니다.', true); assert.match(impact, /지금 m2026\.09\.18-1 · 이 수업의 기본 버전/); await I.items(PREPARED, 'prepared'); const { card } = await openCard(chat, '2판으로 진행'); assert.equal(card.setting, 'pending');
    await ask(chat, 'Q-P2 2판에서의 질문', 'Q-P2'); await answered(chat, 2); assert.ok(callsFor('Q-P2').every((c) => c.lesson === V2), JSON.stringify(callsFor('Q-P2')));
    const K2 = db('SELECT binding_key k FROM classroom_lesson_bindings WHERE student_id=? AND binding_seq=1', seats[0].student_id)[0]?.k, sent = wire.filter((w) => w.path === runtimePath); assert.ok(sent.length >= 2 && sent.every((w) => w.turn), 'the proxy runtime sent its turn id on every request'); assert.equal(sent.at(-1).binding, K2, 'and the key of the binding it switched to');
    await wait(() => turns().at(-1)?.closed === 1 || null, 'the host closed its turn', 30000); await I.items(/A1 · .* 설정: 적용 .*\(m2026\.09\.18-2\)/, 'applied'); await I.page.screenshot({ path: path.join(out, '01-instructor-applied-v2.png'), fullPage: true }); await shot(win, '02-learner-proxy-window-v2.png');
    await I.page.locator('#ops-dist-return').click(); await I.saveForm(); await I.sendToA1(); await I.items(PREPARED, 'return prepared'); await ask(chat, 'Q-P1 복귀 뒤의 질문', 'Q-P1'); assert.ok(callsFor('Q-P1').every((c) => c.lesson === V1)); await I.items(/설정: 적용 .*\(기본 수업\)/, 'return applied');
    assert.ok(wire.every((w) => w.path !== '/v1/messages'), 'this window never used the agent-sdk route'); assert.deepEqual(workFiles().changed, []);
    const result = { schema: 'hps-classroom-mac-lesson-settings-proxy/1', at: new Date().toISOString(), source_sha: head, extension_source_sha: manifest.extension.source_sha, profile: local.profile, runtime_route: runtimePath, model: 'scripted recorder (no real model was called)', provider_calls: providerCalls.map((c) => ({ lesson: c.lesson, marks: c.last_marks })), turns: turns(), bindings: bindings(), wire: wire.map(({ at, ...w }) => w), work_files: workFiles(), steps };
    writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log('PASS — M2 proxy-runtime window: setting switched, key sent on ' + runtimePath + ', applied, returned → ' + path.join(out, 'result.json')); await browser.close(); cleanup();
  }

  // ── 0. U3 OFF (the default): a real turn, a U2 notice the learner OPENS — and nothing of U3 on the wire, in the rows or on the screen ──
  await ask(chat, 'Q-OFF 예약 버튼이 모바일에서 눌리는지 먼저 확인하고 싶어요', 'Q-OFF'); await answered(chat, 1); await idle(chat);
  assert.deepEqual(turns(), [], 'U3 off: no turn is admitted or recorded');
  const profileOff = await (await realFetch(origin + '/v1/profile', { headers: { authorization: 'Bearer ' + token } })).json(); assert.equal(profileOff.lesson_binding, undefined, 'U3 off: the profile says nothing about bindings'); assert.equal(profileOff.lesson.version, V1);
  const I = await instructor(), { page, row, T } = I;
  await I.compose(); assert.deepEqual(await I.kinds(), ['notice', 'material', 'prompt'], 'U3 off for this run: the setting kind is not offered'); assert.match(await page.locator('#ops-dist-preview').innerText(), /^보내기 — 먼저 확인$/);
  await I.newMaterial('notice', '오늘 수업 안내', '끝나기 10분 전에 작업을 저장하세요.'); await I.saveForm(); await I.sendToA1(); await I.items(/A1 · .* — 전달: 보관함 반영 · 보관함: 지금 보관함에 있음/, 'the U2 notice reached the real window');
  const notice = await openCard(chat, '오늘 수업 안내'); assert.deepEqual([notice.card.body, notice.card.canImport, notice.card.setting], ['끝나기 10분 전에 작업을 저장하세요.', false, null]);
  await page.screenshot({ path: path.join(out, '00-instructor-u3-off.png'), fullPage: true }); await shot(win, '00b-learner-notice-opened-by-mouse.png'); step('U3 OFF: a real turn and a U2 notice (opened with the mouse) work as before; no turn rows, no binding in the profile, no setting kind', { provider_calls: providerCalls.length });

  // ── 1. the operator turns U3 on for this Service and this run (this window's profile was cached BEFORE that) ──
  local.env.HPS_LESSON_BINDINGS = 'enforce'; const on = await local.request(local.base, 'PUT', { expected_roster_revision: roster, seats, flags: { ops_lesson_settings: true } }, teacherToken); assert.ok(on.status === 200 || on.status === 201, on.raw); roster = on.json.roster_revision ?? roster + 1;
  await page.locator('#ops-check').click(); await page.waitForTimeout(800); await I.compose(); await wait(async () => (await I.kinds()).includes('setting'), 'the setting kind is offered once /status allows it', 20000); step('U3 ON for this run (enforcement + the run switch)');

  // ── 2. a prompt meets a draft, TWO pasted images and a PARKED message while an answer is still running; then it is withdrawn ──
  let release; holdGate = new Promise((r) => { release = r; }); const beforeHold = holding;
  await setDraft(chat, 'HOLD-ONE 이 질문의 답이 오는 동안 프롬프트가 도착합니다'); await pressEnter(chat); await wait(() => holding > beforeHold, 'the provider holds answer one open', 120000);
  await setDraft(chat, 'Q-PARKED 예약한 입력'); await pressEnter(chat); await wait(async () => (await parkedOf(chat)) === 'Q-PARKED 예약한 입력' || null, 'the message is parked, not sent', 15000);
  const DRAFT = 'Q-PROMPT 내 초안: 버튼 색부터 볼까?'; await setDraft(chat, DRAFT); await pasteImage(chat, 'one.png'); await pasteImage(chat, 'two.png'); await wait(async () => (await attachments(chat)) === 2 || null, 'two pasted images are attached', 15000);
  const PROMPT = '이 페이지의 구조를 세 문장으로 설명해 줘.'; await I.newMaterial('prompt', '조사 프롬프트', PROMPT); await I.saveForm(); const pImpact = await I.sendToA1(); assert.match(pImpact, /초안에 가져오기/); assert.match(pImpact, /학생이 누르기 전에는 학생의 입력·대화·파일이 바뀌지 않습니다/); await I.items(/A1 · .* — 전달: 보관함 반영/, 'the prompt reached the real window');
  const promptObject = db("SELECT object_id o FROM classroom_content_objects WHERE kind='prompt'")[0].o; const before2 = providerCalls.length;
  const p = await openCard(chat, '조사 프롬프트'); assert.equal(p.card.body, PROMPT); assert.equal(await draftOf(chat), DRAFT, 'showing the card changed nothing in the input');
  await press(chat, p.sel + ' [data-inbox-import]', '초안에 가져오기'); await wait(async () => (await draftOf(chat)) === DRAFT + '\n\n' + PROMPT || null, 'the prompt was appended to the draft', 10000);
  assert.deepEqual([await attachments(chat), await parkedOf(chat), providerCalls.length], [2, 'Q-PARKED 예약한 입력', before2], 'both attachments and the parked message are untouched, and importing sent nothing'); await shot(win, '01-learner-prompt-imported-with-attachments-and-parked.png');
  await press(chat, p.sel + ' [data-inbox-undo]', '되돌리기'); await wait(async () => (await draftOf(chat)) === DRAFT || null, 'undo restored the draft', 10000); await press(chat, p.sel + ' [data-inbox-import]', '초안에 가져오기 (again)');
  const EDITED = DRAFT + '\n\n' + PROMPT + ' 그리고 내 말로 한 줄 더.'; await setDraft(chat, EDITED);
  // P4 — the instructor withdraws the prompt AFTER it was imported and edited
  const wImpact = await I.revoke(); assert.match(wImpact, /이미 초안에 가져온 글은 학생의 글이므로 지워지지 않습니다/);
  await wait(async () => { const v = await inboxOf(chat); return v?.cards.some((c) => c.withdrawn && !c.canImport) && !v.cards.some((c) => c.body === PROMPT) ? v : null; }, 'the prompt card came down in the real window', 90000);
  assert.deepEqual([await draftOf(chat), await attachments(chat), await parkedOf(chat)], [EDITED, 2, 'Q-PARKED 예약한 입력'], 'the withdrawal touched neither the draft, nor the attachments, nor the parked message'); await shot(win, '02-learner-after-prompt-withdrawn.png');
  // the running answer ends: the PARKED message goes out as itself; the draft stays for the learner to send
  release(); holdGate = null; await wait(() => callsFor('Q-PARKED').length > 0, 'the parked message went out by itself', 120000); assert.ok(callsFor('Q-PARKED').every((c) => !c.prompt_text), 'the parked message never contained the prompt');
  await answered(chat, 3); await idle(chat); assert.equal(await draftOf(chat), EDITED, 'the draft typed while waiting is still in the input after the parked message went out');
  await pressEnter(chat); const own = await wait(() => callsFor('Q-PROMPT').find((c) => c.prompt_text), 'the learner\'s own send carried the imported prompt', 120000); assert.equal(own.lesson, V1); await answered(chat, 4); await idle(chat);
  const prompts = spool().filter((e) => e.type === 'prompt'), mineEv = prompts.find((e) => String(e.text ?? '').includes('Q-PROMPT')), parkedEv = prompts.find((e) => String(e.text ?? '').includes('Q-PARKED'));
  assert.deepEqual(mineEv?.instructor_prompt_refs, [{ object_id: promptObject, revision: 1 }], 'P5: the spool\'s prompt event of THAT turn names the exact object and revision: ' + JSON.stringify(mineEv)); assert.equal(parkedEv?.instructor_prompt_refs, undefined, 'and the parked turn names none');
  const staleWire = wire.filter((w) => w.path === '/v1/messages').slice(-3);
  step('prompt: appended by a real press next to two attachments and a parked message; undone; withdrawn after the edit without touching anything; sent by the learner; provenance in the spool', { attachments_kept: 2, binding_header_on_these_turns: staleWire.map((w) => w.binding), note: 'this window cached its profile before enforcement began and has not been sent a setting yet: it sends no binding key and closes no turn; the Service admits these turns because they run the token lesson', turns: turns() });

  // ── 3a. S4-① the switch request gets no answer within 4 s: the question goes out as it would have; the NEXT question switches ──
  const sImpact = await I.setting(V2, '2판으로 진행', '다음 질문부터 2판 단계로 진행합니다.', true); assert.match(sImpact, /진행 중인 응답은 끊지 않고 각 학생의 다음 질문부터/); assert.match(sImpact, /A1 \(지금 m2026\.09\.18-1 · 이 수업의 기본 버전\): 단계: 그대로 2개 · 새로 생김 craft-v2 · 없어짐 build/); assert.match(sImpact, /이미 쓴 초안·첨부·대화·작업 파일은 그대로입니다/); await page.screenshot({ path: path.join(out, '03-instructor-setting-sent.png'), fullPage: true });
  await I.items(PREPARED, 'the setting is PREPARED on the real device'); assert.deepEqual(bindings(), [], 'prepared is not switched');
  const sc = await openCard(chat, '2판으로 진행'); assert.equal(sc.card.setting, 'pending'); await shot(win, '03b-learner-setting-pending.png');
  faults.switchDrop = true; const t0 = Date.now(); await ask(chat, 'Q-S4A 전환 요청이 응답하지 않는 동안의 질문', 'Q-S4A'); faults.switchDrop = false; await answered(chat, 5); await idle(chat);
  assert.ok(callsFor('Q-S4A').every((c) => c.lesson === V1) && bindings().length === 0, 'no answer to the switch: the question ran as it would have (v1) and nothing was switched'); assert.ok(Date.now() - t0 >= 3500, 'the app waited its 4 s and went on');
  const K1 = 'token:' + lessonSha[V1].slice(0, 16); assert.equal(wire.filter((w) => w.path === '/v1/messages').at(-1).binding, K1, 'the window looked at its profile again (it holds a setting now) and sent the token key');
  await ask(chat, 'Q-V2 2판에서의 첫 질문', 'Q-V2'); await answered(chat, 6); assert.ok(callsFor('Q-V2').every((c) => c.lesson === V2), JSON.stringify(callsFor('Q-V2')));
  const K2 = db('SELECT binding_key k FROM classroom_lesson_bindings WHERE student_id=? AND binding_seq=1', seats[0].student_id)[0]?.k; assert.equal(wire.filter((w) => w.path === '/v1/messages').at(-1).binding, K2, 'the real app sent the key of the binding it switched to');
  await wait(() => turns().at(-1).closed === 1 || null, 'the real host closed its turn', 30000); assert.deepEqual([turns().at(-1).version, turns().at(-1).binding_seq, turns().at(-1).close_outcome], [V2, 1, 'completed']);
  await I.items(/A1 · .* 설정: 적용 — 이 설정으로 보낸 모델 요청이 정상 종료됨 \(m2026\.09\.18-2\)/, 'applied'); assert.equal((await inboxOf(chat)).cards.find((c) => c.setting).setting, 'bound'); await page.screenshot({ path: path.join(out, '04-instructor-applied-v2.png'), fullPage: true });
  step('S4-① no answer to the switch for 4 s: the question ran under v1 with the token key; the next question switched, sent the new key and closed its turn', { bindings: bindings() });

  // ── 3b. window 1 is still being answered (under V2) while V3 arrives and a SECOND window asks; S4-② its first profile read fails ──
  holdGate = new Promise((r) => { release = r; }); const nHold = providerCalls.length, h0 = holding;
  await setDraft(chat, 'HOLD-TWO 이 질문의 답이 오는 동안 설정이 바뀝니다'); await pressEnter(chat); await wait(() => holding > h0, 'the provider holds answer two open', 120000);
  const heldTurn = turns().at(-1); assert.deepEqual([heldTurn.version, heldTurn.binding_seq, heldTurn.closed, heldTurn.dispatched, heldTurn.completed], [V2, 1, 0, 1, 0], JSON.stringify(heldTurn));
  const v3Impact = await I.setting(V3, '3판으로 진행', '다음 질문부터 3판 단계로 진행합니다.'); assert.match(v3Impact, /A1 \(지금 m2026\.09\.18-2 · 수업 설정으로 전환된 상태\)/); await I.items(PREPARED, 'V3 is prepared while window 1 is still being answered'); assert.equal(bindings().length, 1);
  spawn(path.join(copy, 'Contents/MacOS/HypeProof Studio'), appArgs(ws2), { env: childEnv, stdio: 'ignore' }); const win2 = await wait(() => workbenches().find((w) => w !== win), 'the second window', 90000); await win2.waitForTimeout(6000);
  const notHeld = '!' + hasText('HOLD-TWO'); let chat2 = await enterWork(notHeld);
  const v3grant = () => db("SELECT t.grant_id g,t.state s FROM classroom_distribution_targets t WHERE t.seat_id='A1' AND t.revision=2 ORDER BY t.updated_at DESC LIMIT 1")[0], firstGrant = v3grant().g;
  await connectSeat(win2); // this harness keeps secrets in memory PER WINDOW: the second window needs its own one-time code, which REPLACES window 1's connection
  await wait(() => { const r = v3grant(); return r.g !== firstGrant && r.s === 'reflected' ? r : null; }, 'the second window\'s connection received the setting under its own delivery key', 120000);
  // review 0 — the replaced window must not hide the inbox the newer connection owns: BOTH windows still draw it, and the learner can open it
  await sleep(12000); // two sync periods: window 1 has been told its connection was replaced by now
  const in2 = await openCard(chat2, '3판으로 진행'); assert.equal(in2.card.setting, 'pending'); assert.ok((await inboxOf(chat2)).cards.length >= 2, 'the second window shows the shared inbox'); await shot(win2, '05-second-window-inbox-opened-by-mouse.png');
  await win.bringToFront(); await sleep(1500); const in1 = await wait(async () => { const v = await inboxOf(chat); return v && v.summary_on_screen && v.cards.length >= 2 ? v : null; }, 'window 1 — whose connection was replaced — still draws the inbox', 30000); await shot(win, '05b-first-window-still-shows-inbox.png'); await win2.bringToFront();
  faults.profile503 = true; const n503 = providerCalls.length; await setDraft(chat2, 'Q-WINDOW2 두 번째 창에서 보내는 다음 질문'); await pressEnter(chat2);
  await wait(() => chat2.evaluate(hasText('수업 설정을 확인하지 못했습니다')), 'S4-②: the window says it could not verify the setting', 60000); faults.profile503 = false;
  assert.equal(providerCalls.length, n503, 'switched at the Service but not verified here: NOTHING was sent'); assert.equal(await draftOf(chat2), 'Q-WINDOW2 두 번째 창에서 보내는 다음 질문', 'the learner\'s text is still in the input'); assert.equal(bindings().length, 2, 'the Service did record the switch'); await shot(win2, '06-second-window-setting-not-verified.png');
  await pressEnter(chat2); await wait(() => callsFor('Q-WINDOW2').length > 0, 'the same text, sent again by the learner', 120000); assert.ok(callsFor('Q-WINDOW2').every((c) => c.lesson === V3), JSON.stringify(callsFor('Q-WINDOW2')));
  assert.equal(turns().find((t) => t.turn === heldTurn.turn).completed, 0, 'window 1 is STILL being answered'); await I.items(/A1 · .* 설정: (적용|실행 시도)/, 'the instructor sees V3 take effect while window 1 still runs');
  release(); holdGate = null; await wait(() => turns().find((t) => t.turn === heldTurn.turn)?.closed === 1 || null, 'window 1\'s turn finished and was closed by the host', 120000);
  const heldCalls = providerCalls.slice(nHold).filter((c) => c.last_marks.includes('HOLD-TWO')); assert.ok(heldCalls.length >= 1 && heldCalls.every((c) => c.lesson === V2), 'EVERY provider request of the running question ran under V2: ' + JSON.stringify(heldCalls.map((c) => [c.lesson, c.tools, c.held])));
  const heldRow = turns().find((t) => t.turn === heldTurn.turn); assert.deepEqual([heldRow.version, heldRow.binding_seq, heldRow.completed, heldRow.close_outcome], [V2, 1, 1, 'completed'], JSON.stringify(heldRow)); await shot(win, '07-first-window-finished-under-v2.png');
  await I.items(/A1 · .* 설정: 적용 .*\(m2026\.09\.18-3\)/, 'V3 applied'); assert.deepEqual(bindings().map((b) => [b.binding_seq, b.source, b.version, b.completed]), [[1, 'setting', V2, 1], [2, 'setting', V3, 1]]);
  await page.locator('#ops-check').click(); await page.waitForTimeout(800); assert.match(await row('A1').innerText(), /강의 버전: m2026\.09\.18-3 · 수업 설정으로 전환됨/); assert.doesNotMatch(await row('A2').innerText(), /강의 버전:/); await page.screenshot({ path: path.join(out, '08-instructor-applied-v3.png'), fullPage: true });
  step('two settings in a row; the inbox stays visible and openable in BOTH windows after the second one replaced the first one\'s connection; S4-② an unverifiable profile sends nothing and keeps the input; a running answer stayed under V2', { held_requests: heldCalls.length, window1_inbox_cards: in1.cards.length, bindings: bindings() });

  // ── 3c. S13-ⓒ in the MIDDLE of a multi-request SDK turn: the run switch goes off; then the binding becomes unreadable ──
  onToolUse['Q-TOOLS1'] = async () => { local.db.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_lesson_settings',json('false')) WHERE class_run_id=?").run(local.run); };
  await ask(chat2, 'Q-TOOLS1 second.md 를 읽고 한 줄로 말해 줘', 'Q-TOOLS1'); await wait(() => callsFor('Q-TOOLS1').some((c) => c.answered === 'end_turn'), 'the SDK came back with the tool result', 120000);
  local.db.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_lesson_settings',json('true')) WHERE class_run_id=?").run(local.run); const tools1 = callsFor('Q-TOOLS1');
  assert.ok(tools1.length >= 2 && tools1.every((c) => c.lesson === V3), 'the run switch went off between two requests of one SDK turn: every request still ran V3 — none fell back to the token lesson: ' + JSON.stringify(tools1.map((c) => [c.lesson, c.answered]))); await idle(chat2);
  onToolUse['Q-TOOLS2'] = async () => { local.fail('x.replaced_at IS NULL) AS seat_live'); }; const nT2 = providerCalls.length;
  await setDraft(chat2, 'Q-TOOLS2 second.md 를 다시 읽고 한 줄로 말해 줘'); await pressEnter(chat2); await wait(() => chat2.evaluate(hasText('끝까지 실행되지 않았습니다') + '||' + hasText('실행됐는지 확인하지 못했습니다')), 'the learner is told the question did not finish', 180000); local.fail('');
  await sleep(8000); const tools2 = providerCalls.slice(nT2).filter((c) => c.last_marks.includes('Q-TOOLS2')); assert.equal(tools2.length, 1, 'unreadable binding in mid-turn: the next request was held and NOTHING was re-sent automatically: ' + JSON.stringify(tools2.map((c) => c.answered)));
  assert.equal(await chat2.evaluate(hasText('끝까지 실행되지 않았습니다')), true, 'the Service\'s record said "dispatched": partially executed, not "not sent"'); assert.notEqual(await draftOf(chat2), 'Q-TOOLS2 second.md 를 다시 읽고 한 줄로 말해 줘', 'the input is NOT handed back as if nothing had run'); await shot(win2, '09-second-window-partial-execution.png');
  step('S13-ⓒ real SDK multi-request turn: the run switch going off changed nothing for the running turn; an unreadable binding held the next request — shown as partially executed, no automatic re-send', { tools1: tools1.map((c) => [c.lesson, c.answered]), tools2: tools2.length });

  // ── 4. withdraw (clicked) is not a return; S4-③ the ANSWER to the return's switch is lost; the return applies on the learner's own re-send ──
  const rImpact0 = await I.revoke(); assert.match(rImpact0, /^수업 설정의 회수는 되돌리기가 아닙니다/);
  await ask(chat2, 'Q-AFTERWITHDRAW 회수 뒤의 질문', 'Q-AFTERWITHDRAW'); assert.ok(callsFor('Q-AFTERWITHDRAW').every((c) => c.lesson === V3), 'withdrawn: the switched learner still runs V3'); assert.equal(bindings().length, 2); await idle(chat2);
  await page.locator('#ops-dist-return').click(); assert.match(await T('ops-dist-note'), /복귀를 준비했습니다.*아직 아무것도 보내지 않았습니다/s); assert.equal(await page.locator('#ops-dist-setting').inputValue(), 'base'); await I.saveForm(); assert.match(await T('ops-dist-saved'), /3번째 판/); const rImpact = await I.sendToA1();
  assert.match(rImpact, /기본 수업으로 복귀/); assert.match(rImpact, /A1 \(지금 m2026\.09\.18-3 · 수업 설정으로 전환된 상태\): 단계: 그대로 1개 · 새로 생김 build, review · 없어짐 craft-v3/, 'the return is described from what THIS learner runs now'); assert.doesNotMatch(rImpact, /단계: 그대로 3개/); await page.screenshot({ path: path.join(out, '10-instructor-return-confirm.png'), fullPage: true });
  await I.items(PREPARED, 'the return is prepared'); faults.switchLate = true; const nLate = providerCalls.length; await setDraft(chat2, 'Q-HOME 복귀 뒤의 질문'); await pressEnter(chat2);
  await wait(() => chat2.evaluate(hasText('수업 설정이 바뀌어 보내지 않았습니다')), 'S4-③: refused with the old key, and the learner is told nothing was sent', 90000); faults.switchLate = false;
  assert.equal(providerCalls.length, nLate, 'the Service had switched, the app did not know: the question with the old key was refused BEFORE the provider'); await wait(async () => (await draftOf(chat2)) === 'Q-HOME 복귀 뒤의 질문' || null, 'the text is back in the input (nothing had been dispatched)', 20000); await shot(win2, '11-second-window-input-restored.png');
  await pressEnter(chat2); await wait(() => callsFor('Q-HOME').length > 0, 'sent again by the learner', 120000); assert.ok(callsFor('Q-HOME').every((c) => c.lesson === V1), 'returned: the token lesson again');
  await I.items(/A1 · .* 설정: 적용 .*\(기본 수업\)/, 'the return is applied'); assert.deepEqual(bindings().map((b) => [b.binding_seq, b.source]), [[1, 'setting'], [2, 'setting'], [3, 'base']]); await page.screenshot({ path: path.join(out, '12-instructor-returned.png'), fullPage: true }); await shot(win2, '13-second-window-home.png');
  step('withdraw clicked: nothing went back; S4-③ lost switch answer: refused before the provider, input restored, re-sent by the learner under the token lesson', { bindings: bindings() });

  // ── 5. what was preserved — against the bytes written before the app started — the unselected seat, and the proxy route ──
  const kept = await chat.evaluate(`({off:${hasText('Q-OFF')},held1:${hasText('HOLD-ONE')},held2:${hasText('HOLD-TWO')},answers:(document.body.textContent.match(/로컬 시험 응답/g)||[]).length})`); assert.ok(kept.off && kept.held1 && kept.held2 && kept.answers >= 6, 'window 1 kept its whole conversation: ' + JSON.stringify(kept));
  const files = workFiles(); assert.deepEqual(files.changed, [], 'every learner file has the bytes it had before the app started'); 
  await loopA2.tick(); assert.deepEqual(blocksA2, [], 'A2 was never sent a distribution block'); assert.ok(!existsSync(storeA2.directory), 'A2 has no inbox directory'); assert.deepEqual(db('SELECT count(*) n FROM classroom_lesson_bindings WHERE student_id=?', seats[1].student_id), [{ n: 0 }]);
  assert.deepEqual(db('SELECT DISTINCT seat_id FROM classroom_distribution_targets'), [{ seat_id: 'A1' }], 'only A1 was ever a target');
  let proxyText = ''; await proxyChat({ proxyUrl: origin + '/v1', model: 'hypeproof-default', token: tokenA2, history: [], userText: 'Q-PROXYA2 선택되지 않은 학생의 질문', turnId: KEY(), lessonBinding: 'token:' + lessonSha[V1].slice(0, 16), signal: new AbortController().signal, onDelta: (d) => { proxyText += d; } });
  assert.ok(proxyText.includes('로컬 시험 응답') && callsFor('Q-PROXYA2').length === 1 && callsFor('Q-PROXYA2')[0].lesson === V1, 'the unselected learner runs the run\'s version');
  step('preserved: both windows\' files byte-identical to before launch, the conversation, the unselected seat', { added_files: files.added, wire_paths: [...new Set(wire.map((w) => w.method + ' ' + w.path + ' ' + w.status))] });

  const ledger = db("SELECT (SELECT COUNT(*) FROM classroom_lesson_requests WHERE student_id=?1) AS permitted,(SELECT COUNT(*) FROM classroom_lesson_requests WHERE student_id=?1 AND usage_row_id IS NOT NULL) AS linked,(SELECT COUNT(*) FROM usage_log WHERE user_id=?1) AS usage_rows,(SELECT COUNT(*) FROM usage_log u WHERE u.user_id=?1 AND u.status BETWEEN 200 AND 299 AND u.id NOT IN (SELECT usage_row_id FROM classroom_lesson_requests WHERE student_id=?1 AND usage_row_id IS NOT NULL)) AS answered_unattributed", seats[0].student_id)[0];
  assert.equal(ledger.permitted, ledger.linked, 'every request the Service permitted for the real learner points at its own usage row: ' + JSON.stringify(ledger)); assert.equal(ledger.answered_unattributed, 1, 'the ONE answered request nobody points at is the question asked while U3 was still OFF (stage 0)');
  const allTurns = turns(), result = { request_ledger: ledger, schema: 'hps-classroom-mac-lesson-settings/2', at: new Date().toISOString(), source_sha: head, extension_source_sha: manifest.extension.source_sha, extension_bundles: manifest.extension.bundles, shell: manifest.shell, agent_sdk: { version: manifest.agent_sdk.version, binary_sha256: manifest.agent_sdk.binary.sha256 }, real_seat: 'A1', synthetic_seat: 'A2',
    driven_from: 'Chalk /manage in a visible Chromium window; two real Studio windows; learner controls pressed with real mouse input after a visibility/hit test', model: 'scripted recorder (no real model was called; nothing here is evidence of model quality, latency or cost)',
    second_window: 'in-memory secrets are per window in this harness: the second window was connected with a new one-time code, which replaced the first window\'s connection. Keychain-backed sharing of one connection between windows was NOT run.',
    provider_calls: providerCalls.map((c) => ({ lesson: c.lesson, marks: c.last_marks, tools: c.tools, held: c.held, answered: c.answered })), turns: allTurns, turns_closed_by_host: allTurns.filter((t) => t.closed).length, turns_not_closed: allTurns.filter((t) => !t.closed).map((t) => ({ ...t, why: t.binding_seq === 0 && t.last_failure_kind === '' ? 'sent by the window whose profile was cached before enforcement began (no key, no close)' : 'held or failed in mid-turn' })),
    bindings: bindings(), wire: wire.map(({ at, ...w }) => w), learner: { work_files: files, originals: Object.fromEntries(Object.entries(ORIGINAL_HASHES).map(([f, h]) => [path.relative(userDir, f), h])), conversation_kept: kept }, steps,
    not_run: ['Windows', 'school network', 'several physical devices', 'staging or production', 'a real model', 'mail', 'Keychain-backed reconnection and connection sharing between windows', 'an old app build'] };
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log('PASS — M2: prompt and lesson settings from the Chalk UI to real Studio windows → ' + path.join(out, 'result.json'));
  console.log('The instructor page (' + session.instructor_url + ') and the learner app stay open until ' + endsAt + '. Control-C ends the session.'); if (process.env.HPS_BOARD_HEADLESS === '1') { await browser.close(); cleanup(); } await new Promise(() => {});
} catch (e) { console.log('M2 FAILED: ' + (e?.stack ?? e)); writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), error: String(e?.message ?? e), steps, turns: turns(), bindings: bindings(), faults, wire: wire.slice(-30).map(({ at, ...w }) => w), provider_calls: providerCalls.slice(-12).map((c) => ({ lesson: c.lesson, marks: c.last_marks, answered: c.answered, held: c.held })), targets: db('SELECT t.revision,t.state,t.device_generation,t.result_code FROM classroom_distribution_targets t JOIN classroom_distributions d ON d.id=t.distribution_id ORDER BY d.created_at,d.rowid') }, null, 2)); if (process.env.HPS_U3_KEEP_ON_FAIL !== '1') cleanup(); }
