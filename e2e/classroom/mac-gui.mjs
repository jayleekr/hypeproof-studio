// Remote classroom operations (#751) — REAL Mac GUI acceptance of the current build.
//
//   node e2e/classroom/mac-devhost.mjs prepare      # isolated copy + current extension + vendored SDK JS
//   node e2e/classroom/mac-gui.mjs                  # this file: drives that copy's real window
//
// Real here: the Studio shell process (the prepared COPY, never /Applications), the extension host, the webview, the
// command palette, VS Code notifications, the pinned Agent SDK + native `claude` binary, real HTTP to a real Service
// router with SQLite, the real ClassroomOpsHost sync loop and command runner, files in a real workspace folder.
// Synthetic here: accounts, the lesson, and the MODEL PROVIDER (scripted SSE / errors / stall at api.anthropic.com).
// Therefore NOT evidence about: a current official release shell (see manifest.shell), updater/signing, the seeded-binary
// path, a school network, production or staging D1/R2, a real model's answers, Windows.
// Every step writes to result.json; a step that did not run is NOT_RUN there, never PASS.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from '@playwright/test';
import { localOps } from '../../worker/test/harness/classroom-ops.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost'));
const out = path.join(home, 'gui'); rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'), json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const manifest = json(path.join(home, 'manifest.json')), copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
assert.ok(!copy.startsWith('/Applications'), 'never the installed app');
for (const [f, h] of Object.entries(manifest.extension.bundles)) { assert.equal(sha(path.join(ext, f)), h, `${f} changed since prepare`); assert.equal(sha(path.join(repo, 'extensions/hypeproof-chat', f)), h, `${f}: the prepared copy is not the current build — prepare again`); }
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', manifest.extension.source_sha, head, '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src'], { cwd: repo, encoding: 'utf8' }), '', 'extension sources changed since prepare');
const sdk = manifest.agent_sdk?.vendored === true && manifest.agent_sdk.binary && process.env.HPS_GUI_NO_SDK !== '1';

const steps = [], result = { schema: 'hps-classroom-mac-gui/1', started_at: new Date().toISOString(), source_sha: head, prepared_extension_sha: manifest.extension.source_sha, shell: manifest.shell, agent_sdk: sdk ? { version: manifest.agent_sdk.version, sdk_mjs_sha256: manifest.agent_sdk.sdk_mjs_sha256, binary_sha256: manifest.agent_sdk.binary.sha256, binary_via: 'HPS_SDK_BINARY', js_source: manifest.agent_sdk.source } : null,
  real: ['Studio shell process (isolated copy)', 'extension host + webview', 'command palette + notifications', ...(sdk ? ['Agent SDK ' + manifest.agent_sdk.version + ' + native claude binary'] : []), 'HTTP → Service router + SQLite', 'ops sync loop + command runner', 'workspace files'],
  synthetic: ['accounts', 'lesson', 'model provider (scripted at api.anthropic.com)', 'in-memory R2', 'in-memory secret storage'], steps };
const save = (status, error) => writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ...result, status, ...(error ? { error } : {}), finished_at: new Date().toISOString() }, null, 2));
const PLAN = ['token', 'connect', 'step', 'reviewed', 'error', 'resolved', 'reset', 'reconnect', 'disconnect'];
const record = (id, data) => { steps.push({ id, status: 'PASS', ...data }); console.log('PASS ' + id); save('IN_PROGRESS'); };

// ── Service: real router + SQLite, synthetic class run ──
const local = await localOps(), { setRoster } = await import('../../worker/src/lib/kv.ts');
const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }];
await setRoster(local.env.HPS_KV, local.cohort, seats.map((s) => s.student_id)); await local.freeze();
assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true } })).status, 201);
// The harness instructor token lives one hour; a participant token may not outlive its issuer, so this one is issued for longer.
const { issueIssuer } = await import('../../worker/src/lib/tokens.ts'), { TEST_SECRET } = await import('../../worker/test/harness/index.mjs'), { OPS_ALL } = await import('../../worker/test/harness/classroom-ops.mjs');
const inviter = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: OPS_ALL }] }, 4, TEST_SECRET)).token;
const invite = await local.request(`/admin/cohorts/${local.cohort}/authoring/${local.lesson.course_id}/versions/${local.lesson.version}/participants`, 'POST', { user: 'student-a', hours: 1 }, inviter);
assert.equal(invite.status, 200, invite.raw); const token = invite.json.token;
Object.assign(local.env, { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-no-live-key', OPENAI_API_KEY: undefined, ANTHROPIC_PROXY_URL: undefined });

// ── provider: scripted, and the only thing that is. Nothing in this process may reach a real provider. ──
let provider = 'ok'; const providerCalls = [], realFetch = globalThis.fetch;
const sse = (model, text) => new Response([['message_start', { type: 'message_start', message: { id: 'synthetic-' + providerCalls.length, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }], ['message_stop', { type: 'message_stop' }]].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  assert.equal(url.origin, 'https://api.anthropic.com', 'unexpected outbound request from the Service: ' + url.origin);
  const body = JSON.parse(init.body), mode = provider; providerCalls.push({ mode, model: body.model, stream: body.stream === true, tools: (body.tools ?? []).length });
  if (mode === '500') return Response.json({ type: 'error', error: { type: 'api_error', message: 'synthetic provider failure' } }, { status: 500 });
  if (mode === 'stall') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const text = 'SYNTHETIC-PROVIDER-ANSWER 확인할 조건을 먼저 적어 보세요.';
  return body.stream ? sse(body.model, text) : Response.json({ id: 'synthetic', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 9 } });
};
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts);
  const r = await local.app.fetch(new Request('https://service.test' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), local.env, { waitUntil() {}, passThroughOnException() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) for await (const chunk of r.body) res.write(chunk); res.end(); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;

const userDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hps-ops-gui-'))), ws = path.join(userDir, 'ws'); mkdirSync(path.join(userDir, 'User'), { recursive: true }); mkdirSync(ws);
writeFileSync(path.join(ws, 'index.html'), '<!doctype html><title>학생 작업</title><h1>SYNTHETIC LEARNER WORK</h1>\n'); writeFileSync(path.join(ws, 'notes.md'), '# 내 메모\n- 예약 버튼 위치 확인\n');
writeFileSync(path.join(userDir, 'User/settings.json'), JSON.stringify({ 'hypeproofChat.proxyUrl': origin + '/v1', 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }));
writeFileSync(path.join(userDir, 'User/hps-test-state.json'), JSON.stringify({ token, coach: { name: '연습 코치', personality: '' } }), { mode: 0o600 });
const workHashes = () => Object.fromEntries(readdirSync(ws).filter((f) => statSync(path.join(ws, f)).isFile()).sort().map((f) => [f, sha(path.join(ws, f))]));

let app; const sockets = [], port = 9351;
const status = async () => (await local.request(local.base + '/status')).json, seat = async (id = 'A1') => (await status()).seats.find((s) => s.seat_id === id);
try {
  const appEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD|_SECRET$)/.test(k)));
  app = await electron.launch({ executablePath: path.join(copy, 'Contents/MacOS/HypeProof Studio'), timeout: 45000, env: { ...appEnv, HPS_TEST_E2E: '1', ...(sdk ? { HPS_SDK_BINARY: manifest.agent_sdk.binary.path } : {}) },
    args: ['--user-data-dir=' + userDir, '--extensions-dir=' + path.join(userDir, 'extensions'), '--disable-workspace-trust', '--use-inmemory-secretstorage', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--remote-debugging-port=' + port, '--folder-uri', pathToFileURL(ws).href] });
  const window = await app.firstWindow(); await window.waitForTimeout(6000);
  const wait = async (fn, label, ms = 30000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await window.waitForTimeout(250); } throw Error('timed out: ' + label + (last instanceof Error ? ' — ' + last.message : '')); };
  const shot = async (name) => { await window.waitForTimeout(400); const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); writeFileSync(path.join(out, name + '.png'), Buffer.from(png, 'base64')); };
  const targets = async () => (await (await realFetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((x) => x.type === 'iframe' && x.url.includes('hypeproof-chat'));
  async function connect(t) { const sock = new WebSocket(t.webSocketDebuggerUrl); sockets.push(sock); await new Promise((r) => { sock.onopen = r; }); let id = 0; const pending = new Map();
    sock.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { const [r, j] = pending.get(m.id); pending.delete(m.id); m.error ? j(Error(m.error.message)) : r(m.result); } };
    const send = (method, params = {}) => new Promise((r, j) => { const n = ++id; pending.set(n, [r, j]); sock.send(JSON.stringify({ id: n, method, params })); });
    await send('Page.enable'); const { frameTree } = await send('Page.getFrameTree'), contexts = [];
    for (const f of [frameTree, ...(frameTree.childFrames || [])]) contexts.push((await send('Page.createIsolatedWorld', { frameId: f.frame.id, worldName: 'ops-gui' })).executionContextId);
    return { send, contexts }; }
  async function findContext(selector) { for (const t of await targets()) { const c = await connect(t); for (const contextId of c.contexts) { const evaluate = async (expression) => (await c.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true })).result?.value;
    if (await evaluate('document.visibilityState==="visible" && !!document.querySelector(' + JSON.stringify(selector) + ')')) return { ...c, contextId, evaluate }; } } return null; }
  const frame = (selector, ms) => wait(() => findContext(selector), 'webview ' + selector, ms);
  const toasts = () => window.evaluate(() => [...document.querySelectorAll('.notifications-toasts .notification-list-item-message, .notifications-center .notification-list-item-message')].map((e) => e.textContent));
  const palette = async (title, typed) => { await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); }); await window.keyboard.press('F1'); await window.waitForSelector('.quick-input-widget input', { state: 'visible' });
    await window.keyboard.type('>' === title[0] ? title : title, { delay: 15 }); await wait(() => window.evaluate((t) => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => r.textContent.includes(t)), title), 'command ' + title); await window.keyboard.press('Enter');
    if (typed !== undefined) { await wait(() => window.evaluate(() => document.querySelector('.quick-input-widget')?.textContent.includes('수업 연결 코드')), 'ticket prompt'); await shot('connect-prompt-' + steps.length); await window.keyboard.type(typed, { delay: 10 }); await window.keyboard.press('Enter'); } };
  const clickText = (c, text) => c.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().includes(${JSON.stringify(text)})&&!x.disabled);if(!b)return false;b.click();return true;})()`);
  const say = async (c, text) => { await c.evaluate(`(()=>{const e=document.querySelector('.hps-input textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await window.waitForTimeout(150);
    await c.evaluate("(()=>{const e=document.querySelector('.hps-input textarea');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));})()"); };

  // 1 — the token the learner was given is active in the real app (real /v1/profile through the real window)
  const entry = await frame('.studio-course, .hps-lesson, .hps-input textarea', 60000); await shot('01-launched');
  if (await entry.evaluate("!!document.querySelector('.studio-primary')")) await entry.evaluate("document.querySelector('.studio-primary').click()");
  const chat = await frame('.hps-input textarea', 30000), lessonTitle = await wait(() => chat.evaluate("document.querySelector('.hps-lesson')?.textContent||''"), 'lesson panel');
  record('token', { lesson_panel: lessonTitle.slice(0, 60), note: 'participant token bound to the frozen synthetic lesson; verified by the app against /v1/profile' });

  // 2 — connect with the one-time code, typed into the real command palette prompt
  const pairing = (await local.request(local.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: 1 })).json; assert.ok(pairing.ticket, 'pairing ticket');
  await palette('수업 연결 (강사가 준 코드 입력)', pairing.ticket);
  const connected = await wait(async () => (await toasts()).find((t) => t.includes('수업에 연결했습니다')), 'connected notification'); await shot('02-connected');
  const s1 = await wait(async () => { const s = await seat(); return s?.connection?.state === 'active' && s.activation ? s : null; }, 'seat A1 reports'); writeFileSync(path.join(out, 'status-after-connect.json'), JSON.stringify(s1, null, 2));
  record('connect', { notification: connected.slice(0, 40), seat: { entry_stage: s1.entry_stage, connection: s1.connection, token: s1.token, activation: s1.activation, observes: s1.observes } });
  assert.ok(!JSON.stringify(s1).includes('SYNTHETIC LEARNER WORK'), 'the board never carries file content');

  // 3 — the learner's own step buttons → the instructor's board
  await chat.evaluate("document.querySelector('.hps-lesson').open=true"); assert.ok(await clickText(chat, '채팅에 과제 넣기'), 'step button');
  const s2 = await wait(async () => { const s = await seat(); return s?.step?.status === 'in_progress' ? s : null; }, 'step in_progress on the board');
  assert.ok(await clickText(chat, '이 단계를 마쳤어요')); const s3 = await wait(async () => { const s = await seat(); return s?.step?.status === 'submitted' ? s : null; }, 'step submitted on the board'); await shot('03-step-submitted');
  assert.ok(await chat.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('마쳤다고 표시함 · 강사 확인 전')&&b.disabled)"), 'shown as the learner\'s own statement');
  record('step', { in_progress: s2.step, submitted: { ...s3.step, review: s3.step.review ?? null } });

  // 4 — the instructor confirms that submitted step (same API the Chalk detail pane calls)
  const ref = s3.step.review?.ref ?? s3.step.ref; assert.ok(ref, 'a submitted step exposes a review ref: ' + JSON.stringify(s3.step));
  const reviewed = await local.request(`${local.base}/evidence/${ref}`, 'PUT', { state: 'reviewed', expected_revision: s3.step.review?.revision ?? 0 }); assert.ok([200, 201].includes(reviewed.status), reviewed.raw);
  const s4 = await seat(); assert.equal(s4.step.status, 'submitted', 'the device\'s own report is not rewritten'); assert.equal(s4.step.review.state, 'reviewed');
  record('reviewed', { step_status_from_device: s4.step.status, review: s4.step.review, note: 'instructor action sent through the Service API; the Chalk page itself is covered by the browser e2e in CI' });

  // 5 — a real turn fails at the provider → the board shows a technical fault, the learner sees a retry message
  provider = '500'; const before = providerCalls.length; await say(chat, '예약 버튼이 모바일에서 눌리는지 확인하고 싶어요');
  const s5 = await wait(async () => { const s = await seat(); return s?.error && s.error.blocking === true && !s.error.cleared ? s : null; }, 'blocking fault on the board', 90000); await shot('05-error');
  record('error', { provider_calls: providerCalls.length - before, attention: s5.attention, reason: s5.reason, activation: s5.activation, error: s5.error, runtime_used: providerCalls.slice(before).map((c) => ({ stream: c.stream, tools: c.tools })) });

  // 6 — the next real turn succeeds → the fault is cleared by an observed success, not by a timeout
  provider = 'ok'; await wait(() => chat.evaluate("!document.querySelector('.hps-input textarea').disabled"), 'input ready'); await say(chat, '다시 시도할게요. 어떤 조건부터 확인하면 좋을까요?');
  await wait(() => chat.evaluate("document.body.textContent.includes('SYNTHETIC-PROVIDER-ANSWER')"), 'answer rendered', 90000);
  const s6 = await wait(async () => { const s = await seat(); return s?.error?.cleared === true || (s?.error && s.error.blocking === false) ? s : null; }, 'fault cleared on the board', 60000); await shot('06-resolved');
  record('resolved', { attention: s6.attention, reason: s6.reason, activation: s6.activation, error: s6.error, answered_by: sdk ? 'agent-sdk runtime (vendored SDK + native binary) against the scripted provider' : 'proxy runtime against the scripted provider' });

  // 7 — preserving reset: conversation, files and the record survive; a new runtime generation starts
  const messagesBefore = await chat.evaluate("document.body.textContent.includes('예약 버튼이 모바일에서')&&document.body.textContent.includes('SYNTHETIC-PROVIDER-ANSWER')"), filesBefore = workHashes(); assert.ok(messagesBefore);
  const cmd = await local.command('reset_runtime', ['A1']); assert.ok([201, 202].includes(cmd.status), cmd.raw); const commandId = cmd.json.command_id ?? cmd.json.command?.id;
  const done = await wait(async () => { const v = (await local.request(local.base + '/commands/' + commandId)).json; const t = (v.targets ?? [])[0]; return t && !['queued', 'leased', 'accepted', 'running'].includes(t.state) ? t : null; }, 'reset receipt', 90000); await shot('07-after-reset');
  assert.equal(done.state, 'succeeded', JSON.stringify(done)); assert.deepEqual(workHashes(), filesBefore, 'workspace files are byte-identical');
  assert.ok(await chat.evaluate("document.body.textContent.includes('예약 버튼이 모바일에서')&&document.body.textContent.includes('SYNTHETIC-PROVIDER-ANSWER')"), 'the conversation is still on screen');
  await say(chat, '초기화 뒤에도 이어서 질문합니다'); await wait(() => chat.evaluate("(document.body.textContent.match(/SYNTHETIC-PROVIDER-ANSWER/g)||[]).length>=2"), 'a turn works after the reset', 90000);
  record('reset', { receipt: { state: done.state, result_code: done.result_code }, files: filesBefore, conversation_kept: true, turn_after_reset: true });

  // 8 — reconnect: a new one-time code replaces the connection; the old one cannot act
  const again = (await local.request(local.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: 1 })).json; const grantBefore = (await seat()).connection?.grant_id ?? null;
  await palette('수업 연결 (강사가 준 코드 입력)', again.ticket); await wait(async () => (await toasts()).filter((t) => t.includes('수업에 연결했습니다')).length >= 1 && local.db.prepare("SELECT count(*) n FROM ops_grants WHERE kind='connection' AND seat_id='A1'").get().n >= 2, 'second connection');
  const grants = local.db.prepare("SELECT state FROM ops_grants WHERE kind='connection' AND seat_id='A1' ORDER BY created_at").all().map((g) => g.state); const s8 = await wait(async () => { const s = await seat(); return s?.connection?.state === 'active' && s.connection.grant_id !== grantBefore && s.signal === 'fresh' ? s : null; }, 'reports under the new connection');
  record('reconnect', { connection_grants: grants, seat_connection: s8.connection, signal: s8.signal });

  // 9 — the learner can always leave; work stays
  await palette('수업 연결 끊기'); await wait(async () => (await toasts()).some((t) => t.includes('수업 연결을 끊었습니다')), 'disconnected notification'); await shot('09-disconnected'); assert.deepEqual(workHashes(), filesBefore);
  record('disconnect', { files_unchanged: true });
  for (const id of PLAN) if (!steps.some((s) => s.id === id)) steps.push({ id, status: 'NOT_RUN' });
  result.provider_calls = providerCalls; save('PASS'); console.log(`${steps.filter((s) => s.status === 'PASS').length}/${PLAN.length} real Mac GUI checks passed → ${path.join(out, 'result.json')}`);
} catch (err) {
  for (const id of PLAN) if (!steps.some((s) => s.id === id)) steps.push({ id, status: 'NOT_RUN' });
  result.provider_calls = providerCalls; save('FAIL', String(err?.stack ?? err).slice(0, 1500)); console.error(err); process.exitCode = 1;
  try { if (app) { const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); writeFileSync(path.join(out, 'failure.png'), Buffer.from(png, 'base64')); } } catch { /* window already gone */ }
} finally {
  for (const s of sockets) s.close(); if (app) await app.close().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(r)); globalThis.fetch = realFetch; local.close();
  rmSync(path.join(userDir, 'User/hps-test-state.json'), { force: true });
}
