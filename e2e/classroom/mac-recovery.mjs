// Remote classroom operations (#751, U4) — AT-40 M3: cause → action → follow-up verification, from the REAL Chalk page to a REAL Studio window on this Mac.
//
//   HPS_DEVHOST_SOURCE="<official shell>.app" HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-u4 node e2e/classroom/mac-devhost.mjs prepare
//   HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-u4 node --experimental-strip-types --experimental-sqlite --no-warnings e2e/classroom/mac-recovery.mjs
//
// Every instructor action is a click on the Chalk page in a visible browser window: pick the learner, press the action, confirm,
// read the result there. Everything about the learner happens in, and is read from, a REAL Studio window (copied official shell +
// the current extension build + the real Agent SDK binary): a question that is really running when it is stopped, the unsent
// draft / pasted image / parked message, the learner's files, a real preview tab on the real live server, a held send.
// Real: shell copy, extension, SDK + binary, the ops sync loop and command runner, Chalk, the Service router + SQLite, real HTTP
// between the app and the Service. MADE HERE (and labelled so in result.json): the faults (the HTTP front answers /v1/health or
// the provider stand-in answers 500; a learner page is moved away and back), the accounts, the class, and the MODEL PROVIDER —
// a scripted stand-in. It says nothing about a real model, a school network, Windows, several physical devices, staging or
// production D1/R2, mail, or the Keychain. A re-issued token reaches the app through the dev token file + a restart of the copy;
// typing it into the start page is NOT run here.
// Seats: A1 = this Mac (selected). A2 = the real device client in this process, fully capable, NEVER selected. A3 = never
// connected. A4 = connected by an app that declares no commands (an older build).
// Own ports (18841/18842/9441), own user-data dir, own HOME. It stays up afterwards until Control-C.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { localOps, OPS_ALL } from '../../worker/test/harness/classroom-ops.mjs';
import * as ops from '../../extensions/hypeproof-chat/src/classroomOps.ts';
import { CommandRunner } from '../../extensions/hypeproof-chat/src/classroomOpsCommands.ts';
import { draftAfterStop } from '../../extensions/hypeproof-chat/webview-ui/src/sendQueue.ts';
import { macWindow } from './mac-window.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost-u4'));
const servicePort = Number(process.env.HPS_U4_SERVICE_PORT || 18841), boardPort = Number(process.env.HPS_U4_BOARD_PORT || 18842), debugPort = Number(process.env.HPS_U4_DEBUG_PORT || 9441), prefix = 'u4-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-', HOURS = 12;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'), json = (p) => JSON.parse(readFileSync(p, 'utf8')), out = path.join(home, 'recovery'); mkdirSync(out, { recursive: true });
const manifest = json(path.join(home, 'manifest.json')), copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
assert.ok(!copy.startsWith('/Applications'), 'never the installed app');
for (const [f, h] of Object.entries(manifest.extension.bundles)) { assert.equal(sha(path.join(ext, f)), h, `${f} changed since prepare`); assert.equal(sha(path.join(repo, 'extensions/hypeproof-chat', f)), h, `${f}: the prepared copy is not the current build — prepare again`); }
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', manifest.extension.source_sha, head, '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src'], { cwd: repo, encoding: 'utf8' }), '', 'extension sources changed since prepare');
assert.ok(manifest.agent_sdk?.vendored === true && manifest.agent_sdk.binary, 'the dev host has no Agent SDK: prepare again');
const steps = []; const step = (name, detail = {}) => { steps.push({ at: new Date().toISOString(), name, ...detail }); console.log('STEP ' + name + (Object.keys(detail).length ? ' ' + JSON.stringify(detail) : '')); };

// ── Service: real router + SQLite; a class and tokens that last HOURS so a person can keep using what is left running ──
const local = await localOps(), { setRoster, startSession } = await import('../../worker/src/lib/kv.ts');
const endsAt = new Date(Date.now() + HOURS * 3600_000).toISOString();
await startSession(local.env.HPS_KV, local.cohort, { session_id: local.run, profile_id: local.profile, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: endsAt }); local.db.prepare('UPDATE sessions SET ends_at=? WHERE id=?').run(endsAt, local.run);
const seats = ['A1', 'A2', 'A3', 'A4'].map((id, i) => ({ seat_id: id, student_id: prefix + (i + 1) })), course = local.lesson.course_id, V1 = local.lesson.version;
await setRoster(local.env.HPS_KV, local.cohort, seats.map((s) => s.student_id)); await local.freeze(course, V1, ['intro', 'build', 'review']);
assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true } })).status, 201);
const { issueIssuer } = await import('../../worker/src/lib/tokens.ts'), { TEST_SECRET } = await import('../../worker/test/harness/index.mjs');
const teacherToken = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: [...OPS_ALL] }] }, HOURS + 1, TEST_SECRET)).token;
/** The instructor's existing issuing path (it records the issue and moves the learner's login generation). */
const invite = async (user) => { const r = await local.request(`/admin/cohorts/${local.cohort}/authoring/${course}/versions/${V1}/participants`, 'POST', { user, hours: HOURS }, teacherToken); assert.equal(r.status, 200, r.raw); return r.json.token; };
const token = await invite(seats[0].student_id);
Object.assign(local.env, { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-no-live-key', OPENAI_API_KEY: undefined, ANTHROPIC_PROXY_URL: undefined });

// ── the learner's machine: own profile, own HOME. The bytes are fixed HERE, before anything starts. ──
const userDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hps-751-u4-'))), ws = path.join(userDir, 'ws'), fakeHome = path.join(userDir, 'home'); for (const d of [path.join(userDir, 'User'), ws, fakeHome]) mkdirSync(d, { recursive: true });
const PAGE = '<!doctype html><title>학생 결과물</title><h1>SYNTHETIC LEARNER PAGE U4</h1>\n';
const ORIGINALS = { [path.join(ws, 'index.html')]: '<!doctype html><title>학생 작업</title><h1>SYNTHETIC LEARNER WORK</h1>\n', [path.join(ws, 'notes.md')]: '# 내 메모\n- 예약 버튼 위치 확인\n', [path.join(ws, 'page.html')]: PAGE };
for (const [file, text] of Object.entries(ORIGINALS)) writeFileSync(file, text);
const digest = (buf) => createHash('sha256').update(buf).digest('hex'), ORIGINAL_HASHES = Object.fromEntries(Object.entries(ORIGINALS).map(([f, text]) => [f, digest(Buffer.from(text, 'utf8'))]));
const walk = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
/** The learner's files NOW against the bytes written before the app started — never against a second reading of themselves. */
const workFiles = () => { const now = Object.fromEntries(walk(ws).sort().map((f) => [f, digest(readFileSync(f))])); return { changed: Object.keys(ORIGINAL_HASHES).filter((f) => now[f] !== ORIGINAL_HASHES[f]).map((f) => path.relative(ws, f)), added: Object.keys(now).filter((f) => !(f in ORIGINAL_HASHES)).map((f) => path.relative(ws, f)) }; };
{ const probe = path.join(ws, 'notes.md'); writeFileSync(probe, ORIGINALS[probe] + 'tampered'); assert.deepEqual(workFiles().changed, ['notes.md'], 'negative control: a changed learner file is caught'); writeFileSync(probe, ORIGINALS[probe]); assert.deepEqual(workFiles(), { changed: [], added: [] }, 'positive control'); }

// ── the scripted thing: the model provider. It records each call, can hold one answer open, and can be made to fail. ──
const providerCalls = [], realFetch = globalThis.fetch, ANSWER = '[로컬 시험 응답] 실제 AI 모델은 호출하지 않았습니다.'; let holdGate = null; const faults = { health503: false, provider500: false }, slowMarks = new Set(), SLOW_MS = 9000;
const enc = new TextEncoder(), ev = (e, d) => enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
function sse(model, text, gate) { const id = 'synthetic-' + providerCalls.length;
  return new Response(new ReadableStream({ async start(c) {
    c.enqueue(ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
    c.enqueue(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })); c.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 8) } }));
    if (gate) await gate;
    c.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(8) } })); c.enqueue(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
    c.enqueue(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } })); c.enqueue(ev('message_stop', { type: 'message_stop' })); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }); }
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.origin === 'https://service.test') return local.app.fetch(new Request(input, init), local.env, { waitUntil() {} });
  assert.equal(url.origin, 'https://api.anthropic.com', 'unexpected outbound request from the Service: ' + url.origin);
  const raw = String(init.body), body = JSON.parse(raw), convo = JSON.stringify(body.messages ?? []), marks = [...new Set(raw.match(/\b(?:Q|HOLD)-[A-Z0-9]+(?:-[A-Z0-9]+)*/g) ?? [])];
  const current = marks.map((m) => [m, convo.lastIndexOf(m)]).filter(([, i]) => i >= 0).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null, held = !!holdGate && !!current && current.startsWith('HOLD-');
  providerCalls.push({ at: Date.now(), model: body.model, stream: body.stream === true, mark: current, held, failed: faults.provider500 });
  // A real model takes seconds. The app reads its runtime status when it syncs (about every 5 s), so an answer that comes back
  // instantly is a run the board can never see as `running` (found on real run 5). These marks answer after SLOW_MS instead.
  if (current && slowMarks.has(current)) await new Promise((r) => setTimeout(r, SLOW_MS));
  if (faults.provider500) return Response.json({ type: 'error', error: { type: 'api_error', message: 'synthetic injected provider failure' } }, { status: 500 });
  return body.stream ? sse(body.model, ANSWER, held ? holdGate : null) : Response.json({ id: 'synthetic', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 9 } });
};
const callsFor = (mark) => providerCalls.filter((c) => c.mark === mark);
// real HTTP between the app and the Service; the ONE transport fault made here is "/v1/health does not answer OK"
const wire = [];
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts), url = req.url.split('?')[0];
  if (url === '/v1/health' && faults.health503) { wire.push({ at: Date.now(), path: url, status: 503, injected: true }); res.writeHead(503); res.end(); return; }
  const r = await local.app.fetch(new Request('https://service.test' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), local.env, { waitUntil() {}, passThroughOnException() {} });
  if (/^\/v1\/(messages|chat|profile|health)/.test(url)) wire.push({ at: Date.now(), path: url, status: r.status });
  res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) for await (const chunk of r.body) res.write(chunk); res.end(); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
server.listen(servicePort, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
const { default: chalk } = await import('../../chalk/src/index.ts');
const board = createServer(async (req, res) => { try { const parts = []; for await (const b of req) parts.push(b); const body = Buffer.concat(parts);
  const rr = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(rr.status, Object.fromEntries(rr.headers)); res.end(Buffer.from(await rr.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
board.listen(boardPort, '127.0.0.1'); await once(board, 'listening');

writeFileSync(path.join(userDir, 'User/settings.json'), JSON.stringify({ 'hypeproofChat.proxyUrl': origin + '/v1', 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }));
const tokenPath = path.join(home, 'synthetic-learner-token-u4.txt'); writeFileSync(tokenPath, token, { mode: 0o600 }); const teacherPath = path.join(home, 'synthetic-instructor-token-u4.txt'); writeFileSync(teacherPath, teacherToken, { mode: 0o600 });
const appEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD|_SECRET$|HPS_TEST|ELECTRON_RUN_AS_NODE)/.test(k)));
const appArgs = ['--user-data-dir=' + userDir, '--extensions-dir=' + path.join(userDir, 'extensions'), '--use-inmemory-secretstorage', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--remote-debugging-port=' + debugPort, '--new-window', ws];
const faultFile = path.join(userDir, 'drop-preview-server'); // test-only: its appearance drops the app's live preview server (HPS_TEST_PREVIEW_FAULT)
const childEnv = { ...appEnv, HOME: fakeHome, HPS_DEV_TOKEN_FILE: tokenPath, HPS_TEST_COACH_NAME: '연습 코치', HPS_SDK_BINARY: manifest.agent_sdk.binary.path, HPS_TEST_PREVIEW_FAULT: faultFile };
let app = null; const launch = () => { app = spawn(path.join(copy, 'Contents/MacOS/HypeProof Studio'), appArgs, { env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] }); app.on('exit', (code, signal) => console.log('APP_EXIT', code, signal)); return app; };

// ── seat A2: the real device client with a real command runner. It is never selected, so its executors must never run. ──
const memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; }; let eid = 0, a2Runs = 0, a2Epoch = 0;
const RECOVERY = ['retry_diagnostics', 'refresh_connection', 'restart_preview', 'cancel_current_run', 'reset_runtime'], capsA2 = ['observe', ops.RECOVERY_FOLLOWUP_CAPABILITY, 'commands', ...RECOVERY];
const cA2 = (await local.pair('A2', 1, 2, capsA2)).conn.json, instA2 = local.instance(2, capsA2);
const runnerA2 = new CommandRunner({ executors: Object.fromEntries(RECOVERY.map((a) => [a, { mutating: false, run: async () => { a2Runs++; return { ok: true, code: 'ran_on_unselected_seat' }; } }])), journal: memory(), monotonic: () => performance.now(), now: () => Date.now(), epoch: () => a2Epoch }); await runnerA2.recover();
const loopA2 = ops.startOpsSync({ outbox: await ops.OpsOutbox.open(memory(), cA2.grant_id, 'stream-A2', () => Date.now(), () => `event-u4m-${String(++eid).padStart(6, '0')}`), appInstanceId: instA2.app_instance_id, capabilities: capsA2, commands: runnerA2, onEpoch: (e) => { a2Epoch = e; }, sample: () => ({ idle_ms: 1, runtime_status: 'idle', control_revision: 0 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {},
  post: async (body) => { const r = await local.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: instA2.boot_id }, cA2.credential); return { status: r.status, body: r.json }; } });
const timer = setInterval(() => { loopA2.tick().catch(() => {}); }, 3000);
// seat A4: connected by an app that declares no commands at all (what an older build looks like to the Service)
const cA4 = (await local.pair('A4', 1, 4, ['observe'])).conn.json; await local.sync(cA4.credential, [], 4);

const W = macWindow({ debugPort, realFetch, out }), { sleep, wait, attach, toasts, palette, frame, TEXTAREA, press, setDraft, pressEnter, draftOf, attachments, parkedOf, pasteImage, enterWork, shot, answers, answered, idle } = W;
const pairing = async () => (await local.request(local.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: 1 }, teacherToken)).json.ticket;
const connectSeat = async (w) => { await palette(w, '수업 연결 (강사가 준 코드 입력)', await pairing()); await wait(async () => (await toasts(w)).some((t) => t.includes('수업에 연결했습니다')), 'connected'); };
const db = (sql, ...a) => local.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const ask = async (chat, text, mark, ms = 120000) => { const n = providerCalls.length; await setDraft(chat, text); await pressEnter(chat); await wait(() => providerCalls.slice(n).some((c) => c.mark === mark), 'the provider was called for ' + mark, ms); };
const stopShown = (chat) => chat.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Stop')");
const seatNow = async (id) => (await local.request(local.base + '/status', 'GET', undefined, teacherToken)).json.seats.find((s) => s.seat_id === id);
const lastCommand = (action) => db("SELECT c.id,t.state,t.result_code FROM ops_commands c JOIN ops_command_targets t ON t.command_id=c.id WHERE c.action=? AND t.seat_id='A1' ORDER BY c.created_at DESC LIMIT 1", action)[0];
const followups = (id) => db("SELECT disposition,payload_json FROM ops_events WHERE kind='recovery' AND seat_id='A1' ORDER BY received_at,seq").map((r) => ({ disposition: r.disposition, ...JSON.parse(r.payload_json) })).filter((r) => r.command_id === id);

/** The learner app's own turn log (#580 spool under the copy's HOME): what the app recorded for each finished turn. */
const spoolRoot = path.join(fakeHome, 'Library/Application Support/HypeProof-Studio/logs/sessions');
const turnEnds = () => walk(spoolRoot).filter((f) => f.endsWith('events.jsonl')).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })).filter((e) => e?.type === 'turn_end').sort((a, b) => (a.ts ?? a.at ?? 0) > (b.ts ?? b.at ?? 0) ? 1 : -1);
/** Integrated-browser tabs of the learner window as the debugging port lists them (id = the tab's own target id). */
const browserTabsNow = async () => (await (await realFetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).filter((t) => t.type !== 'iframe' && !/^(vscode-|devtools:|chrome)/.test(t.url) && !t.url.includes('workbench'));
async function tabCdp(target, method, params = {}) { const sock = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; }); try { return await new Promise((r, j) => { sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) m.error ? j(Error(m.error.message)) : r(m.result); }; sock.send(JSON.stringify({ id: 1, method, params })); }); } finally { sock.close(); } }
// An unrelated localhost tool the instructor/learner might also have open. It counts every request it gets.
const toolHits = []; const tool = createServer((req, res) => { toolHits.push({ at: Date.now(), url: req.url }); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>다른 로컬 도구</title><h1>UNRELATED LOCAL TOOL</h1>'); });
tool.listen(0, '127.0.0.1'); await once(tool, 'listening'); const TOOL_URL = 'http://localhost:' + tool.address().port + '/admin', SITE_URL = 'https://example.com/';

const session = { pid: process.pid, service: origin, instructor_url: 'http://127.0.0.1:' + boardPort + '/manage', cohort: local.cohort, profile: local.profile, student_prefix: prefix, instructor_token_file: teacherPath, learner_token_file: tokenPath, app: copy, real_seat: 'A1', never_selected_seat: 'A2', offline_seat: 'A3', old_app_seat: 'A4', user_data_dir: userDir, workspace: ws, ports: { service: servicePort, board: boardPort, debug: debugPort }, class_ends_at: endsAt, source_sha: head, stop: 'Control-C in the terminal that runs this script (or kill -INT <pid>); it closes the Studio copy, both local servers and the browser window' };
writeFileSync(path.join(home, 'recovery-session.json'), JSON.stringify(session, null, 2));
let browser = null; const cleanup = () => { clearInterval(timer); try { app?.kill(); } catch {} try { void browser?.close(); } catch {} server.close(); board.close(); tool.close(); local.close(); process.exit(0); }; process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);

async function instructor() { browser = await chromium.launch({ headless: process.env.HPS_BOARD_HEADLESS === '1' }); const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.goto('http://127.0.0.1:' + boardPort + '/manage'); await page.locator('#token').fill(teacherToken); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill(prefix); await page.locator('#connect button').first().click(); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor(); await page.locator('#ops-check').click();
  const row = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`), T = (id) => page.locator('#' + id).innerText(); await row('A4').waitFor();
  const refresh = async () => { await page.locator('#ops-check').click(); await page.waitForTimeout(700); };
  const open = async (id) => { await refresh(); await row(id).getByRole('button', { name: '근거·조치' }).click(); await page.locator('#ops-detail-title').filter({ hasText: id }).waitFor(); };
  /** Press a recovery action in the open detail; a state-changing one asks for the learner by name first. Returns the final status line. */
  const act = async (id, label, until) => { await open(id); await page.locator('#ops-actions').getByRole('button', { name: label, exact: true }).click(); const go = page.getByRole('button', { name: new RegExp(`대상 ${id} · .* 확인하고 실행`) }); if (await go.isVisible().catch(() => false)) await go.click(); await page.locator('#ops-detail-status').filter({ hasText: until }).waitFor({ timeout: 90000 }); return T('ops-detail-status'); };
  const rowText = (id, re, ms = 90000) => wait(async () => { await refresh(); const t = await row(id).innerText(); return re.test(t.replace(/\s+/g, ' ')) ? t.replace(/\s+/g, ' ') : null; }, `${id} row ${re}`, ms);
  const recovery = async (id) => { await open(id); return (await page.locator('#ops-recovery').innerText()).replace(/\s+/g, ' '); };
  return { page, row, T, refresh, open, act, rowText, recovery, shot: (name) => page.screenshot({ path: path.join(out, name), fullPage: true }) };
}

const results = {};
// HPS_U4_SCENARIOS=R4 (comma list) runs R0 + only those scenarios — e.g. to re-check the preview path without repeating the
// three-minute provider failure of R3. Unset = all of R1..R7. What was skipped is written into result.json.
const SCENARIOS = (process.env.HPS_U4_SCENARIOS || 'R1,R2,R3,R4,R5,R6,R7').split(',').map((x) => x.trim()).filter(Boolean), want = (id) => SCENARIOS.includes(id);
let KEPT = { changed: [], added: [] }, release;
try {
  launch(); let win = await attach(); let chat = await enterWork(); await connectSeat(win);
  const I = await instructor(), { page } = I;
  await ask(chat, 'Q-ONE 첫 질문', 'Q-ONE'); await answered(chat, 1); await idle(chat);
  await I.rowText('A1', /입장: 준비 완료/); const sdkRoute = wire.some((w) => w.path === '/v1/messages' && w.status === 200); assert.ok(sdkRoute, 'the learner window really ran the Agent SDK route');
  step('R0 a real window is connected and a real Agent SDK turn completed', { provider_calls: providerCalls.length });

  if (want('R1')) {
  // ── R1 diagnostics: selected A1 + offline A3 + old-app A4; A2 is NOT selected. The fault is a /v1/health that does not answer OK. ──
  faults.health503 = true; await I.refresh(); await page.locator('#ops-select-none').click(); for (const id of ['A1', 'A3', 'A4']) await I.row(id).getByLabel('선택').check();
  assert.match(await I.T('ops-selection'), /선택 3 \/ 전체 4석/); const targetsBefore = db("SELECT count(*) n FROM ops_command_targets WHERE seat_id='A2'")[0].n;
  await page.locator('#ops-bulk-diagnose').click(); await page.locator('#ops-bulk-result').filter({ hasText: /A1: 성공 .*문제 남음/ }).waitFor({ timeout: 90000 }); const bulk = (await I.T('ops-bulk-result')).replace(/\s+/g, ' ');
  assert.match(bulk, /해결 확인 0 \/ 문제 남음 1 \/ 실행됨·해결 확인 전 0 \/ 결과 미확인 0 \/ 실행 안 됨 2/); assert.match(bulk, /A1: 성공 — 학생 PC에서 서버에 연결되지 않음 → 문제 남음 — 원인: 학생 PC에서 서버에 닿지 않음 \(네트워크\).*다음: PC 초기화로 해결되지 않습니다/);
  assert.match(bulk, /A3: 기기 연결 없음 · 전달되지 않음 → 실행되지 않음 · 문제 상태는 그대로 · 학생 앱에 도달하지 못함/); assert.match(bulk, /A4: 이 앱 버전은 지원하지 않음 → 실행되지 않음/); assert.doesNotMatch(bulk, /전원 해결|모두 완료/);
  assert.deepEqual([db("SELECT count(*) n FROM ops_command_targets WHERE seat_id='A2'")[0].n, a2Runs], [targetsBefore, 0], 'the unselected seat got no target and ran nothing'); await I.shot('r1-bulk-diagnostics-fault.png');
  faults.health503 = false; const fixed = (await I.act('A1', '진단 다시 실행', /해결 확인 1/)).replace(/\s+/g, ' '); assert.match(fixed, /선택한 전원 해결 확인.*A1: 성공 — 토큰 정상 → 문제 해결 확인 · 학생 PC에서 서버 연결과 토큰이 정상임을 확인함/);
  results.R1 = { bulk, fixed, unselected_A2: { new_targets: 0, executor_runs: a2Runs } }; step('R1 diagnosis that finished is not a fix: fault → 문제 남음, offline/old app → 실행되지 않음, unselected untouched; fault removed → 해결 확인', { a2Runs });

  }
  if (want('R2')) {
  // ── R2 a REAL running SDK turn is stopped; the unsent draft, a pasted image and a parked message are compared with what was there BEFORE ──
  holdGate = new Promise((r) => { release = r; }); const before = providerCalls.length;
  await setDraft(chat, 'HOLD-STOP 오래 걸리는 질문'); await pressEnter(chat); await wait(() => callsFor('HOLD-STOP').length > 0, 'the held question reached the provider'); await wait(() => stopShown(chat), 'the turn is running on screen');
  await setDraft(chat, 'Q-PARKED 예약해 둔 다음 질문'); await pressEnter(chat); await wait(async () => (await parkedOf(chat)) !== null, 'the message is parked');
  await setDraft(chat, 'DRAFT-U4 아직 보내지 않은 글'); await pasteImage(chat, 'u4.png'); await wait(async () => (await attachments(chat)) === 1, 'the pasted image is attached');
  const baseline = { draft: await draftOf(chat), parked: await parkedOf(chat), attachments: await attachments(chat), files: workFiles(), provider_calls: providerCalls.length, answers: await answers(chat) }; assert.deepEqual(baseline.files, { changed: [], added: [] });
  await I.rowText('A1', /수행: AI 실행 중/); const stopLine = (await I.act('A1', '현재 AI 실행 중지', /실행이 멈춘 것을 확인함/)).replace(/\s+/g, ' ');
  assert.match(stopLine, /해결 확인 0 .*실행됨·해결 확인 전 1/); assert.match(stopLine, /A1: 성공 — 실행이 멈춘 것을 확인함 → 명령 실행 완료 · 해결 여부는 아직 확인 전 .*실제 AI 실행은 학생의 다음 질문에서 확인됩니다.*다음: 학생에게 다음 질문을 보내 보게 하세요/);
  await wait(async () => !(await stopShown(chat)), 'the turn stopped on the learner\'s screen'); await wait(() => chat.evaluate(W.hasText('강사가 지금 실행 중이던 작업을 멈췄어요')), 'the learner is told who stopped it'); await sleep(6000);
  const afterStop = { draft: await draftOf(chat), parked: await parkedOf(chat), attachments: await attachments(chat), files: workFiles(), provider_calls: providerCalls.length };
  assert.equal(afterStop.draft, draftAfterStop(baseline.draft, baseline.parked), 'every word the learner had (parked + typed) is in the draft, in the order written'); assert.equal(afterStop.parked, null); assert.equal(afterStop.attachments, baseline.attachments);
  assert.deepEqual(afterStop.files, { changed: [], added: [] }); assert.equal(afterStop.provider_calls, baseline.provider_calls, 'nothing was sent on the learner\'s behalf after the stop (no auto-resend, no paid call)'); release(); holdGate = null;
  const stopCmd = lastCommand('cancel_current_run'); assert.deepEqual([stopCmd.state, stopCmd.result_code, followups(stopCmd.id)], ['succeeded', 'run_stopped', []]); await I.shot('r2-stopped-not-yet-resolved.png'); await shot(win, 'r2-learner-after-stop.png');
  // the LEARNER sends what they had kept (the runner presses Enter as the learner; the app sent nothing by itself)
  await pressEnter(chat); await wait(() => callsFor('Q-PARKED').length > 0, 'the learner\'s own next question ran'); await answered(chat, baseline.answers + 1); await idle(chat);
  // Sending a pasted image stores it as the LEARNER'S own file (existing behaviour). It is the only file that may appear, it appears
  // because the learner sent it, and from here on it is part of what must not change.
  const learnerMade = workFiles().added; assert.deepEqual(workFiles().changed, []); assert.ok(learnerMade.length === 1 && /^assets\/pasted-\d{8}-\d{6}-\d+\.png$/.test(learnerMade[0]), 'only the image the learner sent was added: ' + learnerMade.join(' ')); KEPT = { changed: [], added: learnerMade };
  const resumed = await I.rowText('A1', /조치: 현재 AI 실행 중지 — 성공 .*→ 문제 해결 확인/); const stopProof = await I.recovery('A1'); assert.match(stopProof, /조치 뒤 검증: 문제 해결 확인 · 조치 뒤 학생의 다음 AI 실행이 끝까지 완료됨 · 관측 /);
  assert.deepEqual(followups(stopCmd.id).map((f) => [f.disposition, f.check, f.runtime]), [['applied', 'turn_completed', 'agent-sdk']]);
  results.R2 = { baseline: { ...baseline, draft_sha256: digest(baseline.draft), parked_sha256: digest(baseline.parked ?? '') }, after_stop: { ...afterStop, draft_sha256: digest(afterStop.draft) }, stop_line: stopLine, resumed_row: resumed, recovery_block: stopProof, followups: followups(stopCmd.id), held_provider_calls: providerCalls.slice(before).filter((c) => c.held).length };
  step('R2 a running Agent SDK turn was stopped from Chalk; draft + image + parked message + files preserved against the BEFORE values; nothing auto-sent; resolved only after the learner\'s own next run', { followups: followups(stopCmd.id).length });

  }
  if (want('R3')) {
  // ── R3 preserving restart while the PROVIDER is down (a shared cause): ready ≠ running, and the PC is not blamed ──
  await setDraft(chat, 'DRAFT-RESET 초기화 전에 쓰던 글'); const draftBeforeReset = await draftOf(chat); faults.provider500 = true;
  const resetLine = (await I.act('A1', 'AI 실행 환경 초기화', /대화·입력·파일 보존 확인/)).replace(/\s+/g, ' '); assert.match(resetLine, /해결 확인 0 .*실행됨·해결 확인 전 1/); assert.match(resetLine, /멈춤·보존 대조·재시작까지 확인함\(비용 없는 준비 확인\)/);
  assert.equal(await draftOf(chat), draftBeforeReset, 'the draft typed before the restart is still there'); assert.deepEqual(workFiles(), KEPT); const n3 = providerCalls.length; await sleep(4000); assert.equal(providerCalls.length, n3, 'the restart itself called no model');
  // Seen on the first real runs: the real Agent SDK does not give up on a provider 5xx quickly — it retried for more than two minutes
  // (9 attempts) while the turn stayed "running". Until it ends there is no follow-up, and the verdict honestly stays "실행만 됨".
  const tAsk = Date.now(); await ask(chat, 'Q-AFTER-RESET 초기화 뒤 첫 질문', 'Q-AFTER-RESET'); const resetCmd = lastCommand('reset_runtime');
  await sleep(20000); assert.deepEqual(followups(resetCmd.id), [], 'a turn that is still retrying has proven nothing yet'); assert.match(await I.rowText('A1', /조치: AI 실행 환경 초기화/), /→ 명령 실행 완료 · 해결 여부는 아직 확인 전/);
  await wait(async () => !(await stopShown(chat)), 'the failing turn ended on screen', 900000); const failAfterMs = Date.now() - tAsk, attempts = callsFor('Q-AFTER-RESET').length;
  const failedRow = await I.rowText('A1', /조치: AI 실행 환경 초기화 — 성공 .*→ 문제 남음/); const failedProof = await I.recovery('A1'); assert.match(failedProof, /조치 뒤 검증: 문제 남음 — 원인: .*조치 뒤 학생의 다음 AI 실행이 실패함/);
  const f3 = followups(resetCmd.id); assert.deepEqual(f3.map((f) => [f.disposition, f.check, f.error_class]), [['applied', 'turn_failed', 'provider_5xx']], 'the provider\'s own 5xx, carried from this turn\'s SDK stream'); assert.match(failedProof, /공통 장애입니다 — 이 PC를 다시 초기화하지 마세요/);
  const sdkExit = await wait(() => turnEnds().filter((e) => e.status === 'error').at(-1), 'the failed turn is in the learner\'s own log'); assert.match(sdkExit.error_kind, /^(stall|error|sdk_result:[a-z_]+)$/, 'how the SDK ended it is recorded (run 7: the real SDK threw a plain Error after its retries)');
  faults.provider500 = false; await ask(chat, 'Q-RECOVERED 다시 질문', 'Q-RECOVERED'); await idle(chat); await I.rowText('A1', /입장: 준비 완료/);
  assert.equal((await wait(() => turnEnds().at(-1)?.status === 'ok' && turnEnds().at(-1), 'the good turn is logged as ok')).status, 'ok', 'control: a completed SDK turn stays a success in the same log');
  assert.equal(followups(resetCmd.id).length, 1, 'one answer per action: a later good run does not rewrite what followed the restart'); await I.shot('r3-reset-ready-then-provider-down.png');
  results.R3 = { reset_line: resetLine, failed_row: failedRow, recovery_block: failedProof, followups: f3, draft_kept: true, provider_attempts_before_the_sdk_gave_up: attempts, ms_until_the_failing_turn_ended: failAfterMs, sdk_exit: sdkExit.error_kind, spool_status: sdkExit.status }; step('R3 restart = READY (no model call); the next run failed for a shared cause → 문제 남음, never "fixed by resetting the PC"', { error_class: f3[0].error_class });

  }
  if (want('R4')) {
  // ── R4 preview: the learner's REAL preview tab on the real live server, next to an unrelated localhost tool tab (opened FIRST)
  // and an outside site. Only the learner's tab may be judged, re-loaded or moved; the others keep their tab, address and page. ──
  const openTab = async (url) => { const before = new Set((await browserTabsNow()).map((t) => t.id)); await palette(win, 'Open Integrated Browser');
    const t = await wait(async () => (await browserTabsNow()).find((x) => !before.has(x.id)), 'a new integrated browser tab'); await tabCdp(t, 'Page.navigate', { url }); return wait(async () => (await browserTabsNow()).find((x) => x.id === t.id && x.url.startsWith(url.slice(0, 20))), 'the tab is on ' + url); };
  const toolTab = await openTab(TOOL_URL), siteTab = await openTab(SITE_URL);
  await win.bringToFront(); await win.keyboard.press('Meta+P'); await win.waitForSelector('.quick-input-widget input', { state: 'visible' }); await win.keyboard.type('page.html', { delay: 15 }); await sleep(1200); await win.keyboard.press('Enter'); await sleep(1500);
  await palette(win, 'HypeProof: HTML 미리보기 (옆 패널)'); const studentTabs = async () => (await browserTabsNow()).filter((t) => /^http:\/\/127\.0\.0\.1:\d+\/page\.html/.test(t.url));
  const tab = await wait(async () => (await studentTabs())[0], 'the learner\'s preview tab is open'); const previewUrl = tab.url; assert.match(await (await realFetch(previewUrl)).text(), /SYNTHETIC LEARNER PAGE U4/);
  const others = async () => { const now = await browserTabsNow(); return [toolTab, siteTab].map((o) => ({ id: o.id, was: o.url, now: now.find((x) => x.id === o.id)?.url ?? null })); };
  const kept = async (label) => { for (const o of await others()) assert.equal(o.now, o.was, label + ': an unrelated tab kept its tab and address'); };
  const away = path.join(userDir, 'page.html.moved-by-the-runner'); renameSync(path.join(ws, 'page.html'), away); assert.equal((await realFetch(previewUrl)).status, 404, 'the fault is real: the live server answers 404 for the learner\'s page');
  let hits = toolHits.length; const missingLine = (await I.act('A1', '미리보기 복구', /결과물 페이지가 없음/)).replace(/\s+/g, ' '); assert.match(missingLine, /해결 확인 0 \/ 문제 남음 1/); assert.match(missingLine, /A1: 실패 — 서버는 응답하나 결과물 페이지가 없음\(404\) → 문제 남음 — 원인: 미리보기 서버는 정상이나 학생 결과물 페이지가 없음 \(404\)/);
  await kept('404'); assert.equal(toolHits.length, hits, 'the unrelated tool got no request: its /admin path was never judged');
  renameSync(away, path.join(ws, 'page.html')); assert.equal(sha(path.join(ws, 'page.html')), ORIGINAL_HASHES[path.join(ws, 'page.html')], 'the same bytes are back');
  hits = toolHits.length; const openedLine = (await I.act('A1', '미리보기 복구', /해결 확인 1/)).replace(/\s+/g, ' '); assert.match(openedLine, /A1: 성공 — 학생 결과물 페이지가 열림 → 문제 해결 확인 · 학생 결과물 페이지가 다시 열리는 것을 확인함/);
  assert.ok((await studentTabs()).some((t) => t.url === previewUrl), 'the learner\'s tab is still on the same address'); await kept('same address'); assert.equal(toolHits.length, hits);
  // New port: the app's own preview server dies (test-only trigger, see HPS_TEST_PREVIEW_FAULT) — the address in the tab is dead.
  const oldPort = new URL(previewUrl).port; writeFileSync(faultFile, ''); await wait(() => !existsSync(faultFile), 'the app took the fault'); await wait(async () => { try { await realFetch(previewUrl, { signal: AbortSignal.timeout(1500) }); return false; } catch { return true; } }, 'the old address is dead');
  hits = toolHits.length; const movedLine = (await I.act('A1', '미리보기 복구', /해결 확인 1/)).replace(/\s+/g, ' '); assert.match(movedLine, /A1: 성공 — 새 주소로 다시 연결했고 결과물 페이지가 열림 → 문제 해결 확인 · 미리보기 서버를 다시 시작했고 학생 미리보기 탭을 새 주소의 같은 페이지로 다시 연결함/);
  const moved = await wait(async () => (await studentTabs()).find((t) => new URL(t.url).port !== oldPort), 'the learner\'s tab is on the new port'); assert.equal((await studentTabs()).length, 1, 'one learner tab, not a second one');
  const sameTab = moved.id === tab.id; const shown = await tabCdp(moved, 'Runtime.evaluate', { expression: 'JSON.stringify({text:document.body.innerText,state:document.readyState,visible:document.visibilityState,href:location.href})', returnByValue: true }); const doc = JSON.parse(shown.result.value);
  assert.match(doc.text, /SYNTHETIC LEARNER PAGE U4/, 'the learner\'s own page content is in that tab'); assert.equal(doc.state, 'complete'); assert.equal(new URL(doc.href).pathname, '/page.html');
  const png = await tabCdp(moved, 'Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(out, 'r4-new-port-learner-tab.png'), Buffer.from(png.data, 'base64'));
  await kept('new port'); assert.equal(toolHits.length, hits, 'the unrelated tool got no request during the new-port recovery'); assert.deepEqual(workFiles(), KEPT); await W.shot(win, 'r4-window-after-new-port.png'); await I.shot('r4-preview-404-then-opened-then-new-port.png');
  results.R4 = { preview_url: previewUrl.replace(/:\d+\//, ':<port>/'), missing_line: missingLine, opened_line: openedLine, new_port_line: movedLine, new_port: { old_port_differs: true, same_tab_target: sameTab, document: { state: doc.state, visibility: doc.visible, path: new URL(doc.href).pathname, marker_seen: true } }, unrelated_tabs_kept: await others(), unrelated_tool_requests_during_recovery: 0, fault: 'HPS_TEST_PREVIEW_FAULT (test-only env; the app closes its own preview server socket, keeps root/address)' };
  step('R4 preview: 404 = 문제 남음; same address re-loaded = 해결 확인; a dead server moved ONLY the learner\'s tab to a new port and its page is in that tab; the unrelated tool/site tabs were untouched', { same_tab_target: sameTab });

  }
  if (want('R5')) {
  // ── R5 pause / resume: the Service's block, this device's hold and a run after the resume are three observations ──
  holdGate = new Promise((r) => { release = r; }); await setDraft(chat, 'HOLD-PAUSE 일시정지 전에 시작한 질문'); await pressEnter(chat); await wait(() => callsFor('HOLD-PAUSE').length > 0, 'a request is streaming'); const a5 = await answers(chat);
  await I.refresh(); await page.locator('#ops-pause').click(); assert.match(await I.T('ops-pause-impact'), /이미 응답을 받고 있는 요청은 끊지 않습니다/); await page.locator('#ops-pause-go').click();
  await page.locator('#ops-control-state').filter({ hasText: /일시정지 중 · 기기 적용 1 / }).waitFor({ timeout: 90000 }); const pausedLine = await I.T('ops-control-state'); assert.match(pausedLine, /확인 불가 [23]/, 'offline and old-app seats are not counted as applied');
  release(); holdGate = null; await answered(chat, a5 + 1); await idle(chat); // the request that was already streaming finished
  const n5 = providerCalls.length; await setDraft(chat, 'Q-WHILE-PAUSED 일시정지 중에 보낸 글'); await pressEnter(chat); await wait(() => chat.evaluate(W.hasText('강사가 새 AI 실행을 잠시 멈췄습니다')), 'the learner is told why nothing ran'); await sleep(2500);
  assert.equal(providerCalls.length, n5, 'no model call while paused'); assert.equal(await draftOf(chat), 'Q-WHILE-PAUSED 일시정지 중에 보낸 글', 'the input went back into the box');
  assert.match(await I.recovery('A1'), /새 AI 실행 제어 — 서버: 새 요청 차단 중 · 이 기기: 반영 확인/); assert.match(await I.recovery('A3'), /이 기기: 확인 불가/);
  await I.refresh(); await page.locator('#ops-pause').click(); await page.locator('#ops-pause-go').click(); await page.locator('#ops-control-state').filter({ hasText: /허용 중/ }).waitFor({ timeout: 90000 });
  await wait(async () => /재개 뒤 AI 실행은 아직 관측 전/.test(await I.recovery('A1')), 'resumed, and no run seen yet'); assert.equal(providerCalls.length, n5, 'resuming sent nothing by itself');
  // The Service admits again the moment the control row is saved; THIS DEVICE lifts its own hold at its next sync. The two are
  // separate observations (run 3 pressed Enter in between and the app, correctly, still held the send and kept the text).
  await wait(async () => { const c = (await seatNow('A1')).control_outcome; return c.service === 'admitting' && c.device === 'applied'; }, 'this device reported that it lifted the hold', 90000); assert.equal(providerCalls.length, n5);
  slowMarks.add('Q-WHILE-PAUSED'); await pressEnter(chat); await wait(() => callsFor('Q-WHILE-PAUSED').length > 0, 'the learner sent it again themselves'); await idle(chat);
  await wait(async () => /재개 뒤 AI 실행 관측됨/.test(await I.recovery('A1')), 'a run after the resume was seen'); const resumedLine = await I.T('ops-control-state'); assert.match(resumedLine, /재개 뒤 AI 실행이 관측된 좌석 1석/); assert.equal((await seatNow('A1')).step?.lesson_version ?? V1, V1); await I.shot('r5-pause-resume.png');
  results.R5 = { paused_line: pausedLine, resumed_line: resumedLine, in_flight_request_finished: true, resumed_run_length: `the stand-in answered after ${SLOW_MS} ms so that the run spans the app's ~5 s status sample; a run SHORTER than the sample interval is not reported as running and stays "not observed" (conservative: never a false "observed")`, mid_turn_followup_request_during_pause: 'NOT RUN in a real window (needs a multi-request turn crossing the pause)' }; step('R5 pause held a new run (input kept), let the streaming request finish, counted only devices that reported; after resume the learner\'s own run was seen', {});

  }
  if (want('R6')) {
  // ── R6 upload (U1 contract, reused): consent on the device, request from Chalk, and only the Service's verification counts ──
  await palette(win, '수업 기록 보내기 동의·철회'); const agree = '동의하고 보내기 허용';
  await wait(() => win.evaluate((t) => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button, .monaco-dialog-box a.monaco-button')].find((x) => x.textContent.trim() === t); if (!b) return false; b.click(); return true; }, agree), 'the consent dialog'); await wait(async () => (await toasts(win)).some((t) => t.includes('동의를 기록했습니다')), 'consent recorded');
  await I.refresh(); await page.locator('#ops-select-none').click(); await I.row('A1').getByLabel('선택').check(); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor(); await page.locator('#ops-pick-go').click();
  await page.locator('#ops-pick-items').filter({ hasText: /A1 · .* — 현재: 서버 검증됨/ }).waitFor({ timeout: 120000 }); await page.locator('#ops-pick-observed').filter({ hasText: /결과 확정/ }).waitFor({ timeout: 60000 }); const pickState = (await I.T('ops-pick-state')).replace(/\s+/g, ' ');
  const batchId = db('SELECT id FROM classroom_collect_batches ORDER BY created_at DESC LIMIT 1')[0].id, items = (await local.request(`${local.base}/report-batches/${batchId}`, 'GET', undefined, teacherToken)).json.items;
  const mine = items.find((i) => i.seat_id === 'A1'); assert.deepEqual([mine.state, mine.outcome], ['verified', 'resolved']); assert.ok(items.filter((i) => i.seat_id !== 'A1').every((i) => i.outcome === undefined || i.outcome === null), 'unselected seats have no verdict');
  const uploadRow = await I.rowText('A1', /조치: 수업 기록 다시 보내기 — 성공 .*→ 명령 실행 완료/); results.R6 = { pick_state: pickState, item: { state: mine.state, outcome: mine.outcome, coverage: mine.coverage }, board_row: uploadRow }; await I.shot('r6-upload-verified.png');
  step('R6 upload: the device\'s "sent" reads as executed; the Service\'s verification is what reads as resolved', { coverage: mine.coverage });

  }
  if (want('R7')) {
  // ── R7 token: issuing is not receiving. Issued on the instructor's real issuing page, typed by the learner into the app's own
  // start page — no dev token file, no restart. Old issue re-checked → 문제 남음; the new issue in the app → 해결 확인. ──
  const recheck = (await I.act('A1', '연결 다시 확인', /해결 확인 1/)).replace(/\s+/g, ' '); assert.match(recheck, /수업 정보 재확인됨 → 문제 해결 확인 · 기존 발급분을 다시 확인함 \(재발급 아님\)/);
  const tokenFileBefore = sha(tokenPath), issuesBefore = db('SELECT jti FROM ops_token_issues WHERE student_id=?', seats[0].student_id).map((r) => r.jti), a2IssuesBefore = db('SELECT count(*) n FROM ops_token_issues WHERE student_id=?', seats[1].student_id)[0].n;
  // The instructor's issuing page for a lesson class (the board sends lesson classes there, see the seat link below).
  const issuing = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); await issuing.goto('http://127.0.0.1:' + boardPort + '/authoring');
  // What the instructor does on that page: token → open "연결 정보 직접 입력" → open the saved draft → the frozen version →
  // open "학생 초대 · 참여 코드 발급" → student + hours → issue. Every field is filled only after its section is opened by a click.
  const section = async (summary) => { const d = issuing.locator('details', { has: issuing.locator('summary', { hasText: summary }) }); if (!(await d.getAttribute('open') !== null)) await d.locator('summary').click(); };
  await issuing.locator('#token').fill(teacherToken); await section('연결 정보 직접 입력'); await issuing.locator('#cohort').fill(local.cohort); await issuing.locator('#profile').fill(local.profile);
  await section('저장한 강의 열기'); await issuing.locator('#course').fill(course); await issuing.locator('#load').click(); await issuing.locator('#status').filter({ hasNotText: '초안을 선택하세요' }).waitFor({ timeout: 30000 });
  await section('버전 정보'); await issuing.locator('#version').fill(V1);
  await section('학생 초대'); await issuing.locator('#student').fill(seats[0].student_id); await issuing.locator('#hours').fill(String(HOURS));
  await issuing.locator('#deliver').click(); await issuing.locator('#delivery-status').filter({ hasText: V1 }).waitFor({ timeout: 30000 });
  const reissued = await issuing.locator('#student-token').inputValue(); assert.ok(reissued.length > 20 && reissued !== token, 'a new code is on the issuing page');
  await issuing.screenshot({ path: path.join(out, 'r7-issuing-page.png'), mask: [issuing.locator('#token'), issuing.locator('#student-token')] });
  await wait(async () => (await seatNow('A1')).token?.app_verified === 'other_token', 'the board shows the app is on another issue'); assert.equal((await seatNow('A1')).recommended.action, 'refresh_connection');
  await I.open('A1'); const link = page.locator('#ops-evidence a', { hasText: '재발급' }); assert.equal(await link.getAttribute('href'), '/authoring', 'a lesson class is sent to the lesson code page, not to the plain token issuer'); assert.match(await link.innerText(), new RegExp('강의 ' + V1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' 유지'));
  const oldLine = (await I.act('A1', '연결 다시 확인', /문제 남음 1/)).replace(/\s+/g, ' '); assert.match(oldLine, /→ 문제 남음 — 원인: 새로 발급한 토큰이 학생 앱에 없음 · 학생 앱이 확인한 것은 이전 발급분.*다음: 새 토큰을 학생에게 전달/); await I.shot('r7-issued-not-yet-entered.png');
  // The learner: work in progress first (a draft and the conversation), then 활동 변경 → 다른 활동 선택 → 수업에 참여하기 → paste the code → 코드 확인하기 → start.
  await setDraft(chat, 'DRAFT-TOKEN 코드 바꾸기 전에 쓰던 글'); const draftBefore = await draftOf(chat), answersBefore = await answers(chat); await sleep(1500);
  const panelButton = async (chatFrame, text) => { const sel = await chatFrame.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!b)return null;b.setAttribute('data-hps-runner','x');return '[data-hps-runner="x"]';})()`); assert.ok(sel, text + ' button'); await press(chatFrame, sel, text); await chatFrame.evaluate(`document.querySelector('[data-hps-runner]')?.removeAttribute('data-hps-runner')`); };
  await panelButton(chat, '활동 변경');
  const start = await frame('.studio-start'); const startButton = async (text) => { await wait(() => start.evaluate(`[...document.querySelectorAll('button')].some(x=>x.textContent.includes(${JSON.stringify(text)})&&!x.disabled)`), text); await panelButton(start, (await start.evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)}))`+'.textContent.trim()'))); };
  await startButton('다른 활동 선택'); await startButton('수업에 참여하기'); await press(start, '#course-code', 'the code field'); await start.send('Input.insertText', { text: reissued }); await startButton('코드 확인하기');
  await W.shot(win, 'r7-start-page-code-checked.png');
  const primary = await wait(() => start.evaluate("(()=>{const b=document.querySelector('.studio-primary');return b&&!b.disabled?b.textContent.trim():null})()"), 'the start button for the checked code'); await press(start, '.studio-primary', 'start: ' + primary);
  // Asked of the webviews open NOW: the entry panel turns into the work screen, and its old debugging socket may never answer.
  await wait(async () => !(await frame('.studio-start', 'true', 2500).then(() => true, () => false)), 'the start page handed over to the work screen', 120000);
  chat = await frame(TEXTAREA); let repaired = false;
  if (!(await seatNow('A1')).connected) { repaired = true; await connectSeat(win); } // a new issue fences the old connection generation; the instructor's pairing code is the existing way back
  await wait(async () => (await seatNow('A1')).token?.app_verified === 'matches_issue', 'the app verified the newest issue', 120000);
  const newLine = (await I.act('A1', '연결 다시 확인', /해결 확인 1/)).replace(/\s+/g, ' '); assert.match(newLine, /→ 문제 해결 확인 · 재발급한 새 토큰을 학생 앱이 확인함/);
  const refreshCmd = lastCommand('refresh_connection'), f7 = followups(refreshCmd.id); assert.equal(f7.length, 1); const latest = (await seatNow('A1')).token.issue_id; assert.equal(f7[0].token_jti, latest); assert.ok(!issuesBefore.includes(latest), 'the verified issue is the one made on the issuing page');
  assert.equal(sha(tokenPath), tokenFileBefore, 'the dev token file was not touched'); assert.equal(await draftOf(chat), draftBefore, 'the draft typed before the code change is kept'); assert.ok((await answers(chat)) >= answersBefore, 'the conversation is kept');
  assert.equal(db('SELECT count(*) n FROM ops_token_issues WHERE student_id=?', seats[1].student_id)[0].n, a2IssuesBefore, 'the unselected learner got no issue');
  assert.match(await I.recovery('A3'), /연결 코드 발급/, 'never connected: the first step is pairing — nothing is delivered remotely');
  await issuing.locator('#clear-student').click(); assert.equal(await issuing.locator('#student-token').inputValue(), '');
  const leaked = [JSON.stringify(results), await page.content(), await issuing.content(), ...db('SELECT payload_json FROM ops_events').map((r) => r.payload_json), ...db('SELECT detail_json FROM ops_audit').map((r) => r.detail_json)].some((t) => t.includes(token) || t.includes(reissued) || t.includes(teacherToken)); assert.equal(leaked, false, 'no token text on the board, the issuing page after clearing, the ledgers or this evidence');
  await issuing.close(); assert.deepEqual(workFiles(), KEPT); await I.shot('r7-reissued-token-active.png'); await W.shot(win, 'r7-learner-window-after-entry.png');
  results.R7 = { existing_issue_rechecked: recheck, old_issue_line: oldLine, reissued_active_line: newLine, issued_on: 'Chalk /authoring 참여 코드 발급 (clicked)', delivered_by: 'typed into the app\'s own start page (활동 변경 → 수업에 참여하기 → 코드 확인하기); no dev token file change, no restart', start_button: primary, re_paired_after_entry: repaired, draft_kept: true, issues_recorded: db('SELECT count(*) n FROM ops_token_issues WHERE student_id=?', seats[0].student_id)[0].n, never_connected_seat: 'A3 → first step is pairing (not delivered)' };
  step('R7 token: issued on the issuing page / typed on the start page / the newest issue verified — the old issue re-checked stays 문제 남음', { re_paired: repaired });

  }
  assert.equal(a2Runs, 0, 'the never-selected seat ran nothing in the whole session'); assert.equal(db("SELECT count(*) n FROM ops_command_targets WHERE seat_id='A2'")[0].n, 0);
  const result = { schema: 'hps-classroom-mac-recovery/1', at: new Date().toISOString(), scenarios_run: ['R0', ...SCENARIOS], scenarios_not_run_here: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'].filter((x) => !want(x)), source_sha: head, extension_source_sha: manifest.extension.source_sha, extension_bundles: manifest.extension.bundles, shell: manifest.shell, agent_sdk: { version: manifest.agent_sdk.version, binary_sha256: manifest.agent_sdk.binary.sha256, route_seen: '/v1/messages' }, how: 'instructor = clicks on the Chalk page (visible Chromium); learner = real Studio window over the debugging port (real mouse input for webview controls)',
    real: ['Studio shell copy', 'current extension build', 'Agent SDK + binary', 'ops sync loop and command runner', 'Chalk page', 'Service router + SQLite', 'HTTP between app and Service', 'live preview server and browser tab'],
    made_here: ['accounts, class and tokens (synthetic)', 'model provider (scripted stand-in; "provider down" = it answers 500)', '"/v1/health does not answer OK" at the local HTTP front', 'the learner page moved away and back by the runner', 'the preview server dropped by the test-only HPS_TEST_PREVIEW_FAULT trigger', 'an unrelated localhost tool served by the runner', 'seat A2 (real device client in this process), A3 (never connected), A4 (no command capability)', 'the new code carried from the issuing page to the start page by the runner (as a person would read it out)'],
    not_run: ['real model', 'school network / real outage', 'Windows', 'several physical devices', 'staging or production D1/R2', 'mail', 'Keychain-backed installed app', 'a multi-request turn crossing a pause in a real window'],
    results, never_selected_seat: { seat: 'A2', command_targets: 0, executor_runs: a2Runs }, provider_calls: providerCalls.length, wire_tail: wire.slice(-12), steps };
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log('PASS — M3: cause → action → follow-up verification from the Chalk page to a real Studio window → ' + path.join(out, 'result.json'));
  console.log('The instructor page (' + session.instructor_url + ') and the learner app stay open until ' + endsAt + '. Control-C ends the session.'); if (process.env.HPS_BOARD_HEADLESS === '1') cleanup(); await new Promise(() => {});
} catch (e) { console.log('M3 FAILED: ' + (e?.stack ?? e)); writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), error: String(e?.message ?? e), steps, results, faults, provider_calls: providerCalls.slice(-10), wire: wire.slice(-20), a1: await seatNow('A1').catch(() => null) }, null, 2)); if (process.env.HPS_KEEP_ON_FAIL !== '1') cleanup(); await new Promise(() => {}); }
