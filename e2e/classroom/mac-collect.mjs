// Remote classroom operations (#751, U1b) — AT-48 on this Mac: collection KINDS and the sessions of the same learner in the
// class window, from the REAL Chalk page to a REAL Studio window.
//
//   HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-u1b node e2e/classroom/mac-devhost.mjs reinject
//   HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-u1b node --experimental-strip-types --experimental-sqlite --no-warnings e2e/classroom/mac-collect.mjs
//
// Real: the Studio shell copy + current extension build + Agent SDK binary, its spool on disk, the ops sync loop / command runner /
// freezer / uploader of that window, a graceful quit (⌘Q), a forced kill, an extension-host restart, Chalk in a visible browser,
// the Service router + SQLite + in-memory R2, real HTTP between the app and the Service. MADE HERE (and written into result.json):
// the accounts and the class, the model provider (a scripted stand-in), two spool sessions planted in the window's spool folder (another
// learner on this PC; this learner's earlier class), one refused R2 write, and the synthetic seats A2 (consenting, connected, never
// selected), A3 (an older app that does not know kinds) and A4 (never connected). It is ONE Mac: it says nothing about several
// physical PCs, Windows, a school network, staging/production D1/R2, a real model, mail, the Keychain or a real learner/guardian.
// Own ports (18901/18902/9501), own user-data dir, own HOME. It stays up afterwards until Control-C.
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
import * as ops from '../../extensions/hypeproof-chat/src/classroomOps.ts';
import { CommandRunner } from '../../extensions/hypeproof-chat/src/classroomOpsCommands.ts';
import { macWindow } from './mac-window.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost-u1b'));
const servicePort = Number(process.env.HPS_U1B_SERVICE_PORT || 18901), boardPort = Number(process.env.HPS_U1B_BOARD_PORT || 18902), debugPort = Number(process.env.HPS_U1B_DEBUG_PORT || 9501), HOURS = 6;
const prefix = 'u1b-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'), json = (p) => JSON.parse(readFileSync(p, 'utf8')), out = path.join(home, 'collect'); mkdirSync(out, { recursive: true });
const manifest = json(path.join(home, 'manifest.json')), copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
assert.ok(!copy.startsWith('/Applications'), 'never the installed app');
for (const [f, h] of Object.entries(manifest.extension.bundles)) { assert.equal(sha(path.join(ext, f)), h, `${f} changed since reinject`); assert.equal(sha(path.join(repo, 'extensions/hypeproof-chat', f)), h, `${f}: the copy is not the current build — reinject`); }
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', manifest.extension.source_sha, head, '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src'], { cwd: repo, encoding: 'utf8' }), '', 'extension sources changed since reinject');
assert.ok(manifest.extension.commands.includes('hypeproof-chat.classroomApproveArtifact'), 'the copy does not carry the approval command — reinject');
const steps = []; const step = (name, detail = {}) => { steps.push({ at: new Date().toISOString(), name, ...detail }); console.log('STEP ' + name + (Object.keys(detail).length ? ' ' + JSON.stringify(detail) : '')); };
const digest = (buf) => createHash('sha256').update(buf).digest('hex');

// ── Service: real router + SQLite + in-memory R2; a class that lasts hours ──
const local = await localOps(), { setRoster, startSession } = await import('../../worker/src/lib/kv.ts');
const endsAt = new Date(Date.now() + HOURS * 3600_000).toISOString();
await startSession(local.env.HPS_KV, local.cohort, { session_id: local.run, profile_id: local.profile, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: endsAt }); local.db.prepare('UPDATE sessions SET ends_at=? WHERE id=?').run(endsAt, local.run);
const seats = ['A1', 'A2', 'A3', 'A4'].map((id, i) => ({ seat_id: id, student_id: prefix + (i + 1) })), course = local.lesson.course_id, V1 = local.lesson.version;
await setRoster(local.env.HPS_KV, local.cohort, [...seats.map((s) => s.student_id), prefix + '9']); await local.freeze(course, V1, ['intro', 'build', 'review']);
assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true } })).status, 201);
const { issueIssuer } = await import('../../worker/src/lib/tokens.ts'), { TEST_SECRET } = await import('../../worker/test/harness/index.mjs');
const teacherToken = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: [...OPS_ALL] }] }, HOURS + 1, TEST_SECRET)).token;
const invite = async (user) => { const r = await local.request(`/admin/cohorts/${local.cohort}/authoring/${course}/versions/${V1}/participants`, 'POST', { user, hours: HOURS }, teacherToken); assert.equal(r.status, 200, r.raw); return r.json.token; };
const token = await invite(seats[0].student_id);
Object.assign(local.env, { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-no-live-key', OPENAI_API_KEY: undefined, ANTHROPIC_PROXY_URL: undefined });
const runStarts = local.db.prepare('SELECT starts_at FROM class_run_ops WHERE class_run_id=?').get(local.run).starts_at;

// ── the learner's machine: own profile, own HOME, a workspace with the learner's page ──
const userDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hps-751-u1b-'))), ws = path.join(userDir, 'ws'), fakeHome = path.join(userDir, 'home'); for (const d of [path.join(userDir, 'User'), ws, fakeHome]) mkdirSync(d, { recursive: true });
const PAGE_V1 = '<!doctype html><title>학생 결과물</title><h1>SYNTHETIC APPROVED PAGE V1</h1>\n', PAGE_V2 = '<!doctype html><title>학생 결과물</title><h1>SYNTHETIC UNAPPROVED PAGE V2</h1>\n';
writeFileSync(path.join(ws, 'index.html'), PAGE_V1);
// Planted in the SAME spool folder the window writes to: another learner who used this PC during this class, and this learner's earlier class.
const spoolRoot = path.join(fakeHome, 'Library/Application Support/HypeProof-Studio/logs/sessions'), day = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const plant = (id, user, lines) => { const dir = path.join(spoolRoot, day, id); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'session.meta.json'), JSON.stringify({ schema_version: 1, session_id: id, user, app_version: 'planted', os: 'synthetic', started_at: lines[0].ts }) + '\n'); writeFileSync(path.join(dir, 'events.jsonl'), lines.map((l, i) => JSON.stringify({ schema_version: 1, ...l, seq: i + 1 })).join('\n') + '\n'); };
const learnerId = { u: seats[0].student_id, c: local.cohort, p: local.profile };
plant('planted-other-learner', { u: prefix + '9', c: local.cohort, p: local.profile }, [{ ts: new Date(runStarts + 5_000).toISOString(), type: 'prompt', turn_id: 'x-1', runtime: 'proxy', text: 'OTHER-LEARNER-MAC-SECRET' }, { ts: new Date(runStarts + 6_000).toISOString(), type: 'session_close', reason: 'shutdown' }]);
plant('planted-earlier-class', learnerId, [{ ts: new Date(runStarts - 2 * 3600_000).toISOString(), type: 'prompt', turn_id: 'e-1', runtime: 'proxy', text: 'EARLIER-CLASS-MAC-PROMPT' }, { ts: new Date(runStarts - 2 * 3600_000 + 1000).toISOString(), type: 'session_close', reason: 'shutdown' }]);

// ── the scripted model provider ──
const providerCalls = [], realFetch = globalThis.fetch, ANSWER = '[로컬 시험 응답] 실제 AI 모델은 호출하지 않았습니다.';
const encoder = new TextEncoder(), ev = (e, d) => encoder.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
const sse = (model) => new Response(new ReadableStream({ start(c) {
  c.enqueue(ev('message_start', { type: 'message_start', message: { id: 'synthetic-' + providerCalls.length, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
  c.enqueue(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })); c.enqueue(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } }));
  c.enqueue(ev('content_block_stop', { type: 'content_block_stop', index: 0 })); c.enqueue(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } })); c.enqueue(ev('message_stop', { type: 'message_stop' })); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.origin === 'https://service.test') return local.app.fetch(new Request(input, init), local.env, { waitUntil() {} });
  assert.equal(url.origin, 'https://api.anthropic.com', 'unexpected outbound request from the Service: ' + url.origin);
  const raw = String(init.body), body = JSON.parse(raw), mark = (raw.match(/\bQ-[A-Z]+\b/g) ?? []).at(-1) ?? null; providerCalls.push({ at: Date.now(), mark });
  return body.stream ? sse(body.model) : Response.json({ id: 'synthetic', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 9 } });
};
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts);
  const r = await local.app.fetch(new Request('https://service.test' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), local.env, { waitUntil() {}, passThroughOnException() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) for await (const chunk of r.body) res.write(chunk); res.end(); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
server.listen(servicePort, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
const { default: chalk } = await import('../../chalk/src/index.ts');
const board = createServer(async (req, res) => { try { const parts = []; for await (const b of req) parts.push(b); const body = Buffer.concat(parts);
  const rr = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(rr.status, Object.fromEntries(rr.headers)); res.end(Buffer.from(await rr.arrayBuffer())); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
board.listen(boardPort, '127.0.0.1'); await once(board, 'listening');

writeFileSync(path.join(userDir, 'User/settings.json'), JSON.stringify({ 'hypeproofChat.proxyUrl': origin + '/v1', 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'window.confirmBeforeClose': 'never' }));
const tokenPath = path.join(home, 'synthetic-learner-token-u1b.txt'); writeFileSync(tokenPath, token, { mode: 0o600 }); const teacherPath = path.join(home, 'synthetic-instructor-token-u1b.txt'); writeFileSync(teacherPath, teacherToken, { mode: 0o600 });
const appEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD|_SECRET$|HPS_TEST|ELECTRON_RUN_AS_NODE)/.test(k)));
const appArgs = ['--user-data-dir=' + userDir, '--extensions-dir=' + path.join(userDir, 'extensions'), '--use-inmemory-secretstorage', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--remote-debugging-port=' + debugPort, '--new-window', ws];
const childEnv = { ...appEnv, HOME: fakeHome, HPS_DEV_TOKEN_FILE: tokenPath, HPS_TEST_COACH_NAME: '연습 코치', HPS_SDK_BINARY: manifest.agent_sdk.binary.path };
let app = null; const pids = []; const launch = () => { app = spawn(path.join(copy, 'Contents/MacOS/HypeProof Studio'), appArgs, { env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] }); pids.push(app.pid); app.on('exit', (code, signal) => console.log('APP_EXIT', code, signal)); return app; };

// ── synthetic seats in this process ──
const memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; }; let eid = 0, a2Runs = 0, a3Runs = 0;
const consentOf = async (c) => assert.equal((await local.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential)).status, 201);
const device = async (seat, n, executors) => { const caps = ['observe', 'commands', 'retry_evidence_upload'], c = (await local.pair(seat, 1, n, caps)).conn.json, inst = local.instance(n, caps); await consentOf(c);
  const runner = new CommandRunner({ executors, journal: memory(), monotonic: () => performance.now(), now: () => Date.now(), epoch: () => 0 });
  const loop = ops.startOpsSync({ outbox: await ops.OpsOutbox.open(memory(), c.grant_id, 'stream-' + seat, () => Date.now(), () => `event-u1b-${String(++eid).padStart(6, '0')}`), appInstanceId: inst.app_instance_id, capabilities: caps, commands: runner, sample: () => ({ idle_ms: 1, runtime_status: 'idle', control_revision: 0 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {},
    post: async (body) => { const r = await local.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: inst.boot_id }, c.credential); return { status: r.status, body: r.json }; } }); return { c, loop }; };
// A2: consenting, connected, fully capable, NEVER selected — its executor must never run.
const A2 = await device('A2', 2, { retry_evidence_upload: { mutating: false, acceptsArgs: () => true, run: async () => { a2Runs++; return { ok: true, code: 'ran_on_unselected_seat' }; } } });
// A3: an older app — its executor accepts exactly the U1 arguments (the code before U1b), so a kinds request is refused before anything runs.
const A3 = await device('A3', 3, { retry_evidence_upload: { mutating: false, acceptsArgs: (a) => typeof a.batch_id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(a.batch_id) && Object.keys(a).every((k) => ['batch_id', 'purpose', 'notice_version'].includes(k)), run: async () => { a3Runs++; return { ok: false, code: 'nothing_recorded' }; } } });
const timer = setInterval(() => { A2.loop.tick().catch(() => {}); A3.loop.tick().catch(() => {}); }, 3000);

const W = macWindow({ debugPort, realFetch, out }), { sleep, wait, attach, toasts, palette, setDraft, pressEnter, enterWork, shot, answered, idle } = W;
const pairing = async () => (await local.request(local.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: 1 }, teacherToken)).json.ticket;
const connectSeat = async (w) => { await palette(w, '수업 연결 (강사가 준 코드 입력)', await pairing()); await wait(async () => (await toasts(w)).some((t) => t.includes('수업에 연결했습니다')), 'connected'); };
const db = (sql, ...a) => local.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const ask = async (chat, text, mark) => { const n = providerCalls.length; await setDraft(chat, text); await pressEnter(chat); await wait(() => providerCalls.slice(n).some((c) => c.mark === mark), 'the provider was called for ' + mark, 120000); };
const dialog = (w, label) => wait(() => w.evaluate((t) => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button, .monaco-dialog-box a.monaco-button')].find((x) => x.textContent.trim() === t); if (!b) return false; b.click(); return true; }, label), 'dialog button ' + label);
const quickPick = async (w, label) => { await wait(() => w.evaluate(() => !!document.querySelector('.quick-input-widget') && getComputedStyle(document.querySelector('.quick-input-widget')).display !== 'none'), 'quick pick'); await w.keyboard.type(label, { delay: 10 }); await sleep(400); await w.keyboard.press('Enter'); };
const walk = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
/** The window's own spool (not the planted sessions): each session with its lines, oldest first. */
const mySessions = () => readdirSync(path.join(spoolRoot, day)).filter((d) => !d.startsWith('planted-')).map((d) => { const f = path.join(spoolRoot, day, d); const meta = existsSync(path.join(f, 'session.meta.json')) ? json(path.join(f, 'session.meta.json')) : null; const lines = existsSync(path.join(f, 'events.jsonl')) ? readFileSync(path.join(f, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { torn: true }; } }) : []; return { id: d, user: meta?.user?.u ?? null, started: meta?.started_at ?? '', lines }; }).filter((s) => s.user === learnerId.u).sort((a, b) => a.started.localeCompare(b.started));
const r2Of = (batch) => [...local.r2.entries()].filter(([k]) => k.includes('/' + batch + '/')).map(([k, v]) => [k, new TextDecoder().decode(v.body ?? v)]);

const session = { pid: process.pid, service: origin, instructor_url: 'http://127.0.0.1:' + boardPort + '/manage', debug_port: debugPort, cohort: local.cohort, student_prefix: prefix, instructor_token_file: teacherPath, learner_token_file: tokenPath, app: copy, user_data_dir: userDir, class_ends_at: endsAt, synthetic: true };
writeFileSync(path.join(home, 'collect-session.json'), JSON.stringify(session, null, 2));
let browser = null; const cleanup = () => { clearInterval(timer); try { app?.kill(); } catch {} try { void browser?.close(); } catch {} server.close(); board.close(); local.close(); process.exit(0); }; process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);

async function instructor() { browser = await chromium.launch({ headless: process.env.HPS_BOARD_HEADLESS === '1' }); const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('http://127.0.0.1:' + boardPort + '/manage'); await page.locator('#token').fill(teacherToken); await page.locator('#cohort').fill(local.cohort); await page.locator('#prefix').fill(prefix); await page.locator('#connect button').first().click(); await page.locator('#status').filter({ hasText: '연결됨' }).waitFor();
  const row = (id) => page.locator(`#ops-seats .ops-seat[data-seat="${id}"]`); await row('A4').waitFor();
  const refresh = async () => { await page.locator('#ops-check').click(); await page.waitForTimeout(700); };
  const pick = async (ids) => { await refresh(); await page.locator('#ops-select-none').click(); for (const id of ids) await row(id).getByLabel('선택').check(); };
  const toBulk = () => page.evaluate(() => scrollTo(0, document.querySelector('#ops-bulk').getBoundingClientRect().top + scrollY - 8));
  const card = (k) => page.locator(`#ops-ledger-list .ledger-card[data-key="${k}"]`), line = async (k, seat) => ((await card(k).locator('.ledger-items > p').allTextContents()).find((l) => l.startsWith(seat + ' ')) ?? '');
  const toCard = (k) => card(k).evaluate((c) => scrollTo(0, c.getBoundingClientRect().top + scrollY - 8));
  /** Select → preview → choose kinds → confirm, as an instructor does. Returns the new batch id. */
  const collect = async (ids, kinds, { capture, dbl } = {}) => {
    await pick(ids); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor();
    assert.equal(await page.locator('#ops-pick-go').isDisabled(), true, 'nothing is asked before a kind is chosen');
    for (const k of kinds) await page.locator('#ops-pick-kind-' + k).check();
    if (capture) { await toBulk(); await page.screenshot({ path: path.join(out, capture) }); }
    const before = db('SELECT count(*) n FROM classroom_collect_batches WHERE dry_run=0')[0].n;
    if (dbl) await page.locator('#ops-pick-go').dblclick(); else await page.locator('#ops-pick-go').click();
    await page.locator('#ops-last-what').filter({ hasText: '요청 접수' }).waitFor();
    const batches = db('SELECT id FROM classroom_collect_batches WHERE dry_run=0 ORDER BY created_at DESC, rowid DESC'); assert.equal(batches.length, before + 1, 'exactly one batch per confirmation');
    return batches[0].id;
  };
  return { page, row, refresh, pick, toBulk, card, line, toCard, collect, shot: (name) => page.screenshot({ path: path.join(out, name) }) };
}

const results = {}; let win, chat, I;
try {
  // ── M0: a real window, connected and consenting; a real Agent SDK turn ──
  launch(); win = await attach(); chat = await enterWork(); await connectSeat(win);
  await palette(win, '수업 기록 보내기 동의·철회'); await dialog(win, '동의하고 보내기 허용'); await wait(async () => (await toasts(win)).some((t) => t.includes('동의를 기록했습니다')), 'consent recorded');
  await ask(chat, 'Q-ONE 버튼 위치를 먼저 확인할래요', 'Q-ONE'); await answered(chat, 1); await idle(chat);
  I = await instructor(); const { page } = I;
  step('M0 real window connected, consent given in the app, one Agent SDK turn', { provider_calls: providerCalls.length });

  // ── M1: the learner approves version 1 of their page, changes it, and withdraws approval of version 2 (both versions are in the record) ──
  await palette(win, '지금 결과물을 수업 결과물로 승인·취소'); await quickPick(win, '이 결과물을 수업 결과물로 승인'); await wait(async () => (await toasts(win)).some((t) => t.includes('수업 결과물로 승인했습니다')), 'approved v1');
  await shot(win, 'm1-app-approved-v1.png');
  writeFileSync(path.join(ws, 'index.html'), PAGE_V2);
  await palette(win, '지금 결과물을 수업 결과물로 승인·취소'); await quickPick(win, '이 결과물의 승인 취소'); await wait(async () => (await toasts(win)).some((t) => t.includes('승인을 취소했습니다')), 'v2 not approved');
  results.M1 = { v1: digest(PAGE_V1).slice(0, 12), v2: digest(PAGE_V2).slice(0, 12) }; step('M1 approved v1 in the app, v2 recorded and not approved', results.M1);

  // ── M2: a graceful quit (⌘Q): the session ends with session_close; relaunch = a second session of the same learner ──
  const exited = once(app, 'exit'); await win.keyboard.press('Meta+q'); const graceful = await Promise.race([exited.then(() => true), sleep(20000).then(() => false)]);
  if (!graceful) { app.kill('SIGTERM'); await Promise.race([once(app, 'exit'), sleep(15000)]); }
  await sleep(1500); const afterQuit = mySessions(); results.M2 = { graceful_quit: graceful, sessions: afterQuit.length, last_line: afterQuit.at(-1)?.lines.at(-1)?.type ?? null };
  assert.equal(results.M2.last_line, 'session_close', 'a graceful quit ends the session with session_close: ' + JSON.stringify(results.M2));
  launch(); win = await attach(); chat = await enterWork(); await connectSeat(win);
  await ask(chat, 'Q-TWO 이제 색을 바꿔 볼게요', 'Q-TWO'); await answered(chat, 1); await idle(chat);
  results.M2.sessions_after_relaunch = mySessions().length; step('M2 graceful quit (session_close written) and relaunch: a second session of the same learner', results.M2);

  // ── M3: ONE learner, prompts only ──
  const callsBeforeCollect = providerCalls.length;
  const K1 = await I.collect(['A1'], ['prompts'], { capture: 'm3-confirm-prompts-1280x720.png' });
  const l1 = await wait(async () => { const l = await I.line('collect:' + K1, 'A1'); return /\[적용 \(서버 검증\)\]/.test(l) ? l : null; }, 'A1 prompts verified on its card', 180000);
  await I.toCard('collect:' + K1); await I.shot('m3-card-prompts-1280x720.png');
  const s1 = r2Of(K1).map(([, v]) => v).join('\n'), item1 = (await local.request(local.base + '/report-batches/' + K1, 'GET', undefined, teacherToken)).json.items.find((i) => i.seat_id === 'A1');
  results.M3 = { line: l1, stored_objects: r2Of(K1).length, bytes: r2Of(K1).reduce((n, [, v]) => n + Buffer.byteLength(v), 0), extent: item1.extent, coverage: item1.coverage, reason: item1.coverage_reason,
    has: Object.fromEntries(['Q-ONE', 'Q-TWO'].map((m) => [m, s1.includes(m)])), has_not: Object.fromEntries(['로컬 시험 응답', 'SYNTHETIC APPROVED PAGE', 'SYNTHETIC UNAPPROVED PAGE', 'OTHER-LEARNER-MAC-SECRET', 'EARLIER-CLASS-MAC-PROMPT'].map((m) => [m, !s1.includes(m)])) };
  assert.ok(Object.values(results.M3.has).every(Boolean) && Object.values(results.M3.has_not).every(Boolean), 'prompts only, both sessions, nothing else: ' + JSON.stringify(results.M3));
  assert.equal(item1.extent.sessions, 2, 'the restart is two parts'); assert.equal(item1.extent.received.prompt, 2); assert.equal(item1.extent.not_sent.response, 2);
  step('M3 one learner · prompts: both sessions, prompts only; responses, pages, the other learner and the earlier class never left the Mac', { coverage: item1.coverage, reason: item1.coverage_reason, sessions: item1.extent.sessions });

  // ── M4: several learners, approved artifacts: A1 (real), A3 (an older app), A4 (never connected); A2 is never selected ──
  const K2 = await I.collect(['A1', 'A3', 'A4'], ['artifacts'], { capture: 'm4-confirm-artifacts-1280x720.png' });
  const l2 = await wait(async () => { const l = await I.line('collect:' + K2, 'A1'); return /\[적용 \(서버 검증\)\]/.test(l) ? l : null; }, 'A1 approved artifact verified', 180000);
  const l3 = await wait(async () => { const l = await I.line('collect:' + K2, 'A3'); return /종류별 회수를 모름/.test(l) ? l : null; }, 'A3 named as an app that does not know kinds', 90000);
  const l4 = await I.line('collect:' + K2, 'A4');
  await I.toCard('collect:' + K2); await I.shot('m4-card-artifacts-1280x720.png');
  const s2 = r2Of(K2).map(([, v]) => v).join('\n'), item2 = (await local.request(local.base + '/report-batches/' + K2, 'GET', undefined, teacherToken)).json.items.find((i) => i.seat_id === 'A1');
  results.M4 = { a1: l2, a3: l3, a4: l4, a1_extent: item2.extent, approved_v1_stored: s2.includes('SYNTHETIC APPROVED PAGE V1'), unapproved_v2_stored: s2.includes('SYNTHETIC UNAPPROVED PAGE V2'), prompts_stored: s2.includes('Q-ONE'), a3_runs: a3Runs, a3_objects: [...local.r2.keys()].filter((k) => k.includes('/' + seats[2].student_id + '/')).length };
  assert.deepEqual([results.M4.approved_v1_stored, results.M4.unapproved_v2_stored, results.M4.prompts_stored, results.M4.a3_runs, results.M4.a3_objects], [true, false, false, 0, 0], JSON.stringify(results.M4));
  step('M4 several learners · approved artifacts: A1 only v1 (v2 counted, not sent); A3 refused the kinds before running; A4 not connected', { a1_received: item2.extent.received, a1_not_sent: item2.extent.not_sent });

  // ── M5: the whole record, double click on confirm = one batch ──
  const K3 = await I.collect(['A1'], ['record'], { dbl: true });
  const l5 = await wait(async () => { const l = await I.line('collect:' + K3, 'A1'); return /\[적용 \(서버 검증\)\]/.test(l) ? l : null; }, 'A1 record verified', 180000);
  const s3 = r2Of(K3).map(([, v]) => v).join('\n'); results.M5 = { line: l5, responses_in_record: s3.includes('로컬 시험 응답'), both_pages: s3.includes('V1') && s3.includes('V2'), other_learner: s3.includes('OTHER-LEARNER-MAC-SECRET'), earlier_class: s3.includes('EARLIER-CLASS-MAC-PROMPT') };
  assert.deepEqual([results.M5.responses_in_record, results.M5.both_pages, results.M5.other_learner, results.M5.earlier_class], [true, true, false, false], JSON.stringify(results.M5));
  results.M5.provider_calls_during_collections = providerCalls.length - callsBeforeCollect; assert.equal(results.M5.provider_calls_during_collections, 0, 'collecting calls no model');
  step('M5 record · double click → one batch; the record holds both sessions (responses and both page versions) and still never the other learner or the earlier class');

  // ── M6: partial failure, then the SAME frozen copy is finished after an extension-host restart (same connection) ──
  local.fail('R2 put'); const K4 = await I.collect(['A1'], ['prompts']);
  const l6a = await wait(async () => { const l = await I.line('collect:' + K4, 'A1'); return /재전송 대기|offline_pending/.test(l) ? l : null; }, 'A1 waits to resend', 120000); local.fail('');
  await I.toCard('collect:' + K4); await I.shot('m6-card-resend-wait-1280x720.png');
  const oldChat = chat.id; await palette(win, 'Restart Extension Host'); await sleep(5000); chat = await enterWork('true', new Set([oldChat]));
  const l6b = await wait(async () => { await I.card('collect:' + K4).locator('.ledger-more').click().catch(() => {}); const l = await I.line('collect:' + K4, 'A1'); return /\[적용 \(서버 검증\)\]/.test(l) ? l : null; }, 'the same copy verified after the restart', 180000);
  const rev = db('SELECT revision FROM classroom_snapshots WHERE batch_id=? AND state=?', K4, 'sealed'); results.M6 = { before: l6a, after: l6b, sealed_revisions: rev.map((r) => r.revision) };
  assert.deepEqual(results.M6.sealed_revisions, [1], 'the resumed upload finished revision 1 — the immutable copy, not a re-read of the grown spool');
  step('M6 one refused write → 재전송 대기; after an extension-host restart the same frozen copy (revision 1) verified in the same batch', results.M6);

  // ── M7: a crash (SIGKILL) — the session before it has no session_close; a collection says that end is unproven ──
  await ask(chat, 'Q-MID 재시작 뒤에 한 번 더', 'Q-MID'); await answered(chat, 1); await idle(chat);
  results.M6.after_restart_sessions = mySessions().map((x) => [x.lines.length, x.lines.at(-1)?.type ?? null]);
  process.kill(app.pid, 'SIGKILL'); await Promise.race([once(app, 'exit'), sleep(10000)]); await sleep(1500);
  launch(); win = await attach(); chat = await enterWork(); await connectSeat(win);
  await ask(chat, 'Q-THREE 다시 켰어요', 'Q-THREE'); await answered(chat, 1); await idle(chat);
  const K5 = await I.collect(['A1'], ['prompts']);
  const l7 = await wait(async () => { const l = await I.line('collect:' + K5, 'A1'); return /\[적용 \(서버 검증\)\]/.test(l) ? l : null; }, 'A1 after crash verified', 180000);
  await I.toCard('collect:' + K5); await I.shot('m7-card-after-crash-1280x720.png');
  const item5 = (await local.request(local.base + '/report-batches/' + K5, 'GET', undefined, teacherToken)).json.items.find((i) => i.seat_id === 'A1');
  results.M7 = { line: l7, coverage: item5.coverage, reasons: item5.extent.reasons, parts: item5.extent.parts.map((p) => [p.current, p.end_proven]) };
  assert.notEqual(item5.coverage, 'complete'); assert.ok(item5.extent.reasons.includes('earlier_session_end_unproven'), JSON.stringify(results.M7));
  step('M7 crash then relaunch: the crashed session\'s end is unproven and the result is not complete', results.M7);

  // ── M8: the previous run stands apart from the current selection ──
  await I.pick(['A2']); await I.toBulk(); results.M8 = { selection: await page.locator('#ops-selection').innerText(), last: await page.locator('#ops-last-what').innerText() };
  assert.match(results.M8.last, /→ A1 \(지금 선택과 다른 대상\)/); await I.shot('m8-current-a2-previous-a1-1280x720.png');
  await page.locator('#ops-select-none').click(); step('M8 current selection A2 vs previous run A1 are labelled apart', results.M8);

  // ── M9: the learner withdraws in the app: nothing further is asked, what was held is removed ──
  await palette(win, '수업 기록 보내기 동의·철회'); await dialog(win, '동의 철회'); await wait(async () => (await toasts(win)).some((t) => t.includes('동의를 철회했습니다')), 'withdrawn');
  await I.pick(['A1']); await page.locator('#ops-pick-collect').click(); await page.locator('#ops-pick-confirm').waitFor();
  const preview = await page.locator('#ops-pick-preview').innerText(); await page.locator('#ops-pick-kind-prompts').check(); const goDisabled = await page.locator('#ops-pick-go').isDisabled();
  await I.toBulk(); await I.shot('m9-withdrawn-preview-1280x720.png'); await page.locator('#ops-pick-cancel').click();
  results.M9 = { preview, go_disabled: goDisabled, a1_objects_left: [...local.r2.keys()].filter((k) => k.includes('/' + seats[0].student_id + '/')).length };
  assert.match(preview, /학생이 철회함/); assert.equal(goDisabled, true); assert.equal(results.M9.a1_objects_left, 0, 'withdrawal removed what the Service held for this learner');
  step('M9 withdrawal in the app: A1 is held out with the reason, nothing can be requested, stored objects removed', results.M9);

  results.never_selected = { a2_runs: a2Runs, a2_targets: db("SELECT count(*) n FROM ops_command_targets WHERE seat_id='A2'")[0].n, a2_objects: [...local.r2.keys()].filter((k) => k.includes('/' + seats[1].student_id + '/')).length };
  assert.deepEqual(Object.values(results.never_selected), [0, 0, 0]);
  results.no_evaluation = { report_inputs: db("SELECT count(*) n FROM classroom_job_outbox WHERE kind='report_input'")[0].n, delivery_events: db('SELECT count(*) n FROM classroom_delivery_events')[0].n, provider_calls_by_collection: results.M5.provider_calls_during_collections, provider_marks: providerCalls.map((c) => c.mark) };
  assert.equal(results.no_evaluation.report_inputs, 0);
  const served = Buffer.from(await (await realFetch('http://127.0.0.1:' + boardPort + '/manage')).arrayBuffer());
  const result = { schema: 'hps-classroom-mac-collect/1', at: new Date().toISOString(), status: 'PASS', source_sha: head, extension_source_sha: manifest.extension.source_sha, bundles: manifest.extension.bundles, served_manage_sha256: digest(served), manage_source_sha256: sha(path.join(repo, 'chalk/src/ui/manage.html')), shell: manifest.shell, agent_sdk: manifest.agent_sdk?.version, app_pids: pids, runner_pid: process.pid, ports: { service: servicePort, board: boardPort, debug: debugPort }, class_ends_at: endsAt, steps, results,
    real: ['Studio shell copy (0.1.56, not a release of this branch)', 'current extension build', 'Agent SDK binary', 'the window spool on disk', 'ops sync, command runner, freezer, uploader of the window', '⌘Q quit, SIGKILL, extension-host restart', 'Chalk in a visible browser 1280x720', 'Service router + SQLite + in-memory R2', 'real HTTP app↔Service'],
    made_here: ['accounts, class and tokens', 'model provider stand-in', 'two planted spool sessions (another learner; this learner\'s earlier class)', 'one refused R2 write (M6)', 'A2/A3/A4 synthetic seats'],
    not_run: ['several physical PCs (this is one Mac)', 'Windows', 'school network', 'staging/production D1 or R2', 'real model', 'mail', 'Keychain-based installed app', 'real learners or guardian consent (#1175)', 'a new class run and a device replacement on this Mac (covered in-process: worker/test/classroom-ops-collect-kinds.test.mjs and earlier AT-43/44 tests)'] };
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log('RESULT PASS ' + path.join(out, 'result.json'));
} catch (e) {
  console.error('FAIL', e); writeFileSync(path.join(out, 'result.json'), JSON.stringify({ schema: 'hps-classroom-mac-collect/1', at: new Date().toISOString(), status: 'FAIL', error: String(e?.stack || e), source_sha: head, steps, results }, null, 2));
  try { if (win) await shot(win, 'fail-app.png'); } catch {} try { if (I) await I.shot('fail-board.png'); } catch {}
}
console.log('staying up for inspection (Control-C to stop) — session: ' + path.join(home, 'collect-session.json'));
