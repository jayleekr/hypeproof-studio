// Remote classroom (#751) — native help device storage, AT-47: TWO REAL Studio windows of ONE app on this Mac (two extension
// hosts, one user-data-dir, one globalStorage) writing help records at the same time, then an extension-host restart and a
// full app restart. What must hold: neither window erases the other learner's draft or request; a request that is being sent
// or whose answer is unknown keeps its id, exact content and consented end, and is retried only as that same request.
//
//   HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-help-storage node --experimental-strip-types --experimental-sqlite --no-warnings e2e/classroom/mac-help-windows.mjs
//
// Real: shell copy, current extension build, both windows' extension hosts, the help entry, the ops connections (pairing
// codes typed in each window's palette), the Service router + SQLite, HTTP between app and Service, the store files on disk
// and VS Code's own state.vscdb. MADE HERE (written so in result.json): accounts, class and tokens (synthetic); learner B in the
// second window (each window reads its own learning token because this harness keeps secrets in memory per window —
// an installed app shares one Keychain token across windows, NOT RUN); one POST held before the Service and then answered 503
// (the local HTTP front). NOT RUN: several physical PCs (this is ONE Mac), Windows, school network, hosted D1/R2, real model,
// Keychain-backed install, children (#1175). Own ports (18921/9521), own user-data dir, own HOME. Exits when done.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { localOps, OPS_ALL } from '../../worker/test/harness/classroom-ops.mjs';
import { HelpRecordStore } from '../../extensions/hypeproof-chat/src/classroomHelpStore.ts';
import { macWindow } from './mac-window.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost-help-storage'));
const servicePort = Number(process.env.HPS_HELP_SERVICE_PORT || 18921), debugPort = Number(process.env.HPS_HELP_DEBUG_PORT || 9521), prefix = 'helpwin-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-', HOURS = 12;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'), hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16), json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const out = path.join(home, 'help-windows'); mkdirSync(out, { recursive: true });
const manifest = json(path.join(home, 'manifest.json')), copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
assert.ok(!copy.startsWith('/Applications'), 'never the installed app');
for (const [f, h] of Object.entries(manifest.extension.bundles)) { assert.equal(sha(path.join(ext, f)), h, `${f} changed since prepare`); assert.equal(sha(path.join(repo, 'extensions/hypeproof-chat', f)), h, `${f}: the prepared copy is not the current build — reinject`); }
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', manifest.extension.source_sha, head, '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src'], { cwd: repo, encoding: 'utf8' }), '', 'extension sources changed since prepare');
const steps = []; const step = (name, detail = {}) => { steps.push({ at: new Date().toISOString(), name, ...detail }); console.log('STEP ' + name + (Object.keys(detail).length ? ' ' + JSON.stringify(detail) : '')); };

// ── Service: real router + SQLite; one class, seats A1 (learner A) and A2 (learner B) ──
const local = await localOps(), { setRoster, startSession } = await import('../../worker/src/lib/kv.ts');
const endsAt = new Date(Date.now() + HOURS * 3600_000).toISOString();
await startSession(local.env.HPS_KV, local.cohort, { session_id: local.run, profile_id: local.profile, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: endsAt }); local.db.prepare('UPDATE sessions SET ends_at=? WHERE id=?').run(endsAt, local.run);
const [LA, LB] = ['a', 'b'].map((x) => prefix + x), course = local.lesson.course_id, V1 = local.lesson.version;
await setRoster(local.env.HPS_KV, local.cohort, [LA, LB]); await local.freeze(course, V1, ['intro', 'build', 'review']);
assert.equal((await local.configure([{ seat_id: 'A1', student_id: LA }, { seat_id: 'A2', student_id: LB }], 0, { flags: { ops_observe: true } })).status, 201);
const { issueIssuer } = await import('../../worker/src/lib/tokens.ts'), { TEST_SECRET } = await import('../../worker/test/harness/index.mjs');
const teacherToken = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: [...OPS_ALL] }] }, HOURS + 1, TEST_SECRET)).token;
const invite = async (user) => { const r = await local.request(`/admin/cohorts/${local.cohort}/authoring/${course}/versions/${V1}/participants`, 'POST', { user, hours: HOURS }, teacherToken); assert.equal(r.status, 200, r.raw); return r.json.token; };
const tokens = { [LA]: await invite(LA), [LB]: await invite(LB) };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); assert.equal(url.hostname, '127.0.0.1', 'unexpected outbound request: ' + url.origin); return realFetch(input, init); };

// ── HTTP front between the app and the Service. The one fault made here: a help POST is held BEFORE the Service sees it, then
// answered 503 without forwarding — the request never existed on the Service and its answer is unknown on the device. ──
const wire = []; let holdPost = null;
const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts), url = req.url.split('?')[0];
  if (holdPost && req.method === 'POST' && url === '/v1/classroom/shares') { const h = holdPost; holdPost = null; h.entered(); const verdict = await h.gate; wire.push({ at: Date.now(), injected: 'POST held before the Service, then ' + verdict, id_hash: hash(JSON.parse(body).id) }); if (verdict === 'answer 503') { res.writeHead(503); res.end(); return; } }
  const r = await local.app.fetch(new Request('https://service.test' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), local.env, { waitUntil() {}, passThroughOnException() {} });
  if (url.startsWith('/v1/classroom/shares') && req.method !== 'GET') wire.push({ at: Date.now(), method: req.method, path: url, status: r.status, ...(req.method === 'POST' ? { id_hash: hash(JSON.parse(body).id) } : {}) });
  res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) for await (const chunk of r.body) res.write(chunk); res.end(); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
server.listen(servicePort, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
const holdNextPost = () => { let release, entered; const e = new Promise((r) => (entered = r)); const gate = new Promise((r) => (release = r)); holdPost = { entered, gate }; return { entered: e, release }; };

// ── one Mac, one app, one profile; two work folders (VS Code focuses an existing window for the same folder) ──
const userDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hps-751-hw-'))), fakeHome = path.join(userDir, 'home'), wsA = path.join(userDir, 'ws-a'), wsB = path.join(userDir, 'ws-b');
for (const d of [path.join(userDir, 'User'), fakeHome, wsA, wsB]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(wsA, 'index.html'), '<h1>A</h1>\n'); writeFileSync(path.join(wsB, 'index.html'), '<h1>B</h1>\n');
writeFileSync(path.join(userDir, 'User/settings.json'), JSON.stringify({ 'hypeproofChat.proxyUrl': origin + '/v1', 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none' }));
const tokenPath = path.join(home, 'synthetic-learner-token-windows.txt'), useToken = (u) => writeFileSync(tokenPath, tokens[u], { mode: 0o600 });
const appEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD|_SECRET$|HPS_TEST|ELECTRON_RUN_AS_NODE)/.test(k)));
const childEnv = { ...appEnv, HOME: fakeHome, HPS_DEV_TOKEN_FILE: tokenPath, HPS_TEST_COACH_NAME: '연습 코치', ...(manifest.agent_sdk?.binary?.path ? { HPS_SDK_BINARY: manifest.agent_sdk.binary.path } : {}) };
const appArgs = (ws) => ['--user-data-dir=' + userDir, '--extensions-dir=' + path.join(userDir, 'extensions'), '--use-inmemory-secretstorage', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--remote-debugging-port=' + debugPort, '--new-window', ws];
const bin = path.join(copy, 'Contents/MacOS/HypeProof Studio');
let app = null; const launch = (ws) => { app = spawn(bin, appArgs(ws), { env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] }); app.on('exit', (code, signal) => console.log('APP_EXIT', code, signal)); return app; };
/** A second window of the RUNNING app: the second process hands the folder to the first over its socket and exits. */
const openSecond = async (ws) => { const p = spawn(bin, appArgs(ws), { env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] }); await Promise.race([once(p, 'exit'), new Promise((r) => setTimeout(r, 20000))]); };

const W = macWindow({ debugPort, realFetch, out }), { sleep, wait, attach, toasts, palette, frame, press, enterWork, shot } = W;
const pairing = async (seat) => (await local.request(local.base + '/pairings', 'POST', { seat_id: seat, roster_revision: 1 }, teacherToken)).json.ticket;
const connectSeat = async (w, seat) => { await palette(w, '수업 연결 (강사가 준 코드 입력)', await pairing(seat)); await wait(async () => (await toasts(w)).some((t) => t.includes('수업에 연결했습니다')), 'connected ' + seat); };
const db = (sql, ...a) => local.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const setValue = (chat, selector, value, event = 'input') => chat.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));return true;})()`);
const q = (chat, selector, expr = 'e.textContent') => chat.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e?(${expr}):null;})()`);
const helpOpen = async (chat) => { if (!(await q(chat, '.hp-help', 'e.open'))) await press(chat, '.hp-help > summary', 'the help entry in the coach rail'); await wait(() => q(chat, '.hp-help', 'e.open'), 'help panel open'); await wait(() => q(chat, '[data-help-recipient]', "e.getAttribute('data-help-recipient')"), 'recipient'); };
const keyOf = (chat) => q(chat, '.hp-help', "e.getAttribute('data-help-key')");
const noteIs = (chat, re) => wait(async () => { const t = await q(chat, '[data-help-note]'); return t && re.test(t) ? t : null; }, 'help note ' + re, 60000);

// The device store as it is on disk, read with the shipped store code — and VS Code's own globalState row for this extension.
const storeRoot = path.join(userDir, 'User/globalStorage/hypeproof.hypeproof-chat/classroom-help'), files = new HelpRecordStore(storeRoot);
const vscdbKeys = () => { const f = path.join(userDir, 'User/globalStorage/state.vscdb'); if (!existsSync(f)) return null; const d = new DatabaseSync(f, { readOnly: true }); try { const row = d.prepare("SELECT value FROM ItemTable WHERE key='hypeproof.hypeproof-chat'").get(); return row ? Object.keys(JSON.parse(row.value)).sort() : []; } finally { d.close(); } };
const dkOf = (u) => [local.cohort, local.profile, u, local.run].join('|');

const results = {}; let wA = null, wB = null, chatA = null, chatB = null;
const cleanup = (code) => { try { app?.kill(); } catch {} server.close(); local.close(); process.exit(code); };
process.on('SIGINT', () => cleanup(130));
/** Both windows: which page is whose. The window opened second is the page that was not there before. */
const openBoth = async (label) => {
  useToken(LB); launch(wsB); wB = await attach(); chatB = await enterWork(); await connectSeat(wB, 'A2');
  const skipB = new Set([chatB.id]); useToken(LA); await openSecond(wsA);
  wA = await wait(() => W.workbenches().find((p) => p !== wB && !p.isClosed()), 'the second window', 90000); await wA.waitForTimeout(6000);
  chatA = await enterWork('true', skipB); await connectSeat(wA, 'A1');
  await helpOpen(chatA); await helpOpen(chatB);
  const keys = { a: await keyOf(chatA), b: await keyOf(chatB) }; assert.deepEqual(keys, { a: dkOf(LA), b: dkOf(LB) }, 'each window is its own learner (' + label + ')');
  step(label + ': two windows of one app, learner A (A1) and learner B (A2), each connected with its own pairing code', { windows: W.workbenches().length });
};

try {
  await openBoth('W0');
  // ── W1: both learners type at the same instant, five times, with the second window 0–120 ms behind (the globalState flush is 100 ms) ──
  const rounds = [];
  for (const [i, lag] of [0, 30, 60, 90, 120].entries()) {
    const a = `W1-A${i} 학생 A의 질문 초안`, b = `W1-B${i} 학생 B의 질문 초안`;
    await Promise.all([setValue(chatA, '[data-help-question]', a), sleep(lag).then(() => setValue(chatB, '[data-help-question]', b))]);
    await sleep(1500);
    const disk = { a: (await files.get('draft', dkOf(LA)))?.question, b: (await files.get('draft', dkOf(LB)))?.question };
    rounds.push({ lag_ms: lag, a_kept: disk.a === a, b_kept: disk.b === b });
    assert.deepEqual(disk, { a, b }, `round ${i} (B ${lag} ms after A): an independent draft was lost on disk`);
  }
  const keysNow = vscdbKeys(); assert.ok(keysNow && !keysNow.includes('hypeproof.classroomHelp.v1'), 'no help record in globalState: ' + JSON.stringify(keysNow));
  results.W1 = { rounds, globalstate_row_keys: keysNow };
  await shot(wA, 'hw-01-window-a-draft.png'); await shot(wB, 'hw-01-window-b-draft.png');
  step('W1 five rounds of simultaneous drafts in two windows (B 0–120 ms after A): both drafts on disk every round; no help key in the extension\'s globalState row', { rounds: rounds.length, globalstate_keys: keysNow });

  // ── W2: A consents and sends; the POST is held before the Service; meanwhile B previews and types; then the answer is 503 ──
  const QA = 'W2-A 보내는 중에 다른 창이 써도 내 요청은 그대로여야 해요';
  await setValue(chatA, '[data-help-question]', QA); await sleep(700); await press(chatA, '[data-help-preview]', 'A preview');
  const envA = await wait(() => q(chatA, '[data-help-envelope]', "e.getAttribute('data-help-envelope')"), 'A consent preview');
  const previewA = { end: Number(await q(chatA, '[data-help-preview-expiry]', "e.getAttribute('data-help-preview-end')")), question: await q(chatA, '[data-help-preview-field="question"]') };
  await press(chatA, '[data-help-consent]', 'A consent');
  const held = holdNextPost(); await press(chatA, '[data-help-send]', 'A send'); await held.entered;
  const QB = 'W2-B 다른 학생이 동시에 미리 본 질문';
  await setValue(chatB, '[data-help-question]', QB); await sleep(600); await press(chatB, '[data-help-preview]', 'B preview');
  const envB = await wait(() => q(chatB, '[data-help-envelope]', "e.getAttribute('data-help-envelope')"), 'B consent preview');
  const during = { a_sending: await wait(async () => { for (const k of await envelopeKeys()) { const e = await files.get('envelope', k); if (e?.request_id === envA) return e.state; } return null; }, 'A envelope on disk'), b_prepared: (await findEnvelope(envB))?.state };
  assert.deepEqual([during.a_sending, during.b_prepared], ['sending', 'prepared']);
  held.release('answer 503'); await noteIs(chatA, /보냈는지 확인하지 못했습니다/);
  const afterA = await findEnvelope(envA), afterB = await findEnvelope(envB);
  assert.deepEqual([afterA?.state, afterA?.content?.question, afterA?.consent_expires_at], ['unknown', QA, previewA.end], 'A: unknown, exact content, the consented end');
  assert.deepEqual([afterB?.state, afterB?.content?.question], ['prepared', QB], 'B\'s preview untouched');
  assert.equal(db('SELECT count(*) n FROM classroom_shares WHERE id=?', envA)[0].n, 0, 'the held POST never reached the Service');
  assert.equal(await q(chatA, '[data-help-pending]', "e.getAttribute('data-help-pending')"), envA); assert.equal(await q(chatB, '[data-help-envelope]', "e.getAttribute('data-help-envelope')"), envB);
  await shot(wA, 'hw-02-window-a-unknown.png'); await shot(wB, 'hw-02-window-b-preview.png');
  results.W2 = { a: { request: hash(envA), state: afterA.state, content_is_previewed: afterA.content.question === previewA.question, end_is_previewed: afterA.consent_expires_at === previewA.end }, b: { request: hash(envB), state: afterB.state }, during };
  step('W2 A sending (POST held before the Service) while B previewed in the other window → A unknown with its exact content and consented end; B\'s preview untouched; nothing stored for A', results.W2);

  // ── W3: A's extension host restarts (its in-memory help state is gone; the window, its secrets and its connection stay) ──
  const skipA = new Set([chatA.id, chatB.id]);
  await palette(wA, 'Restart Extension Host'); await sleep(4000);
  chatA = await enterWork('true', skipA); await helpOpen(chatA);
  const restored = { key: await keyOf(chatA), pending: await wait(() => q(chatA, '[data-help-pending]', "e.getAttribute('data-help-pending')"), 'A pending request restored', 60000), summary: await q(chatA, '.hp-help > summary') };
  assert.deepEqual([restored.key, restored.pending], [dkOf(LA), envA]); assert.match(restored.summary, /보냈는지 확인 필요/);
  assert.equal(await q(chatB, '[data-help-envelope]', "e.getAttribute('data-help-envelope')"), envB, 'B\'s window is unaffected by A\'s restart');
  await shot(wA, 'hw-03-window-a-restored.png');
  const postsBefore = wire.filter((x) => x.method === 'POST').length;
  await press(chatA, '[data-help-retry]', 'A retry'); await noteIs(chatA, /강사에게 보냈습니다/);
  const storedA = db('SELECT id,status,content_json,expires_at FROM classroom_shares WHERE student_id=?', LA);
  assert.equal(storedA.length, 1); assert.deepEqual([storedA[0].id, JSON.parse(storedA[0].content_json).question, storedA[0].expires_at], [envA, QA, previewA.end], 'stored as the same request, exact content, consented end');
  assert.equal(wire.filter((x) => x.method === 'POST').length, postsBefore + 1); assert.equal(await findEnvelope(envA), null);
  results.W3 = { restored: { pending_is_same_request: restored.pending === envA }, stored: { same_id: true, content_is_previewed: true, end_is_previewed: storedA[0].expires_at === previewA.end }, posts_for_retry: 1 };
  step('W3 A\'s extension host restarted: the unknown request came back from disk and 다시 확인 stored exactly that request (same id, content, consented end), one POST; B\'s window untouched', results.W3);

  // ── W4: B consents to its preview (made while A was sending) and sends ──
  await press(chatB, '[data-help-consent]', 'B consent'); await press(chatB, '[data-help-send]', 'B send'); await noteIs(chatB, /강사에게 보냈습니다/);
  const storedB = db('SELECT id,content_json FROM classroom_shares WHERE student_id=?', LB); assert.deepEqual([storedB.length, storedB[0].id, JSON.parse(storedB[0].content_json).question], [1, envB, QB]);
  step('W4 B sent the preview it saw during A\'s send: stored as that request', { request: hash(envB) });

  // ── W5: both type again at the same instant, then the WHOLE app quits and comes back; each learner's draft is there ──
  const FA = 'W5-A 앱을 껐다 켜도 남아야 하는 A의 초안', FB = 'W5-B 앱을 껐다 켜도 남아야 하는 B의 초안';
  await Promise.all([setValue(chatA, '[data-help-question]', FA), setValue(chatB, '[data-help-question]', FB)]); await sleep(1500);
  assert.deepEqual([(await files.get('draft', dkOf(LA)))?.question, (await files.get('draft', dkOf(LB)))?.question], [FA, FB]);
  const mainPid = app.pid; app.kill('SIGTERM'); await Promise.race([once(app, 'exit'), sleep(20000)]); await sleep(2000);
  await openBoth('W5 after the app restart');
  const back = { a: await q(chatA, '[data-help-question]', 'e.value'), b: await q(chatB, '[data-help-question]', 'e.value') };
  assert.deepEqual(back, { a: FA, b: FB }, 'each learner\'s draft is restored after the app restart');
  await shot(wA, 'hw-05-window-a-after-restart.png'); await shot(wB, 'hw-05-window-b-after-restart.png');
  results.W5 = { a_restored: back.a === FA, b_restored: back.b === FB, quit_pid: mainPid, globalstate_row_keys: vscdbKeys() };
  step('W5 simultaneous drafts, full app quit and relaunch (new connections for both seats): both drafts restored in their own windows', results.W5);

  const result = { schema: 'hps-classroom-mac-help-windows/1', at: new Date().toISOString(), source_sha: head, extension_source_sha: manifest.extension.source_sha, shell: manifest.shell,
    real: ['Studio shell copy', 'current extension build', 'two windows of one app (two extension hosts, one user-data-dir and globalStorage)', 'ops connections by pairing codes typed in each window', 'the help entry', 'Service router + SQLite', 'HTTP between app and Service', 'store files on disk (read with the shipped store code)', 'VS Code state.vscdb row of the extension', 'extension host restart', 'full app quit and relaunch'],
    made_here: ['accounts, class and tokens (synthetic)', 'learner B in the second window — this harness keeps secrets in memory per window, so each window read its own learning token (an installed app shares one Keychain token across windows)', 'one POST held before the Service, then answered 503 by the local HTTP front'],
    not_run: ['several physical PCs (this is ONE Mac, two windows)', 'Windows', 'school network', 'hosted/staging/production D1/R2', 'real model', 'Keychain-backed installed app', 'children / guardian consent (#1175)', 'power loss during a write'],
    results, wire, steps };
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log('PASS — native help storage, two real windows → ' + path.join(out, 'result.json'));
  cleanup(0);
} catch (e) {
  console.log('HELP WINDOWS FAILED: ' + (e?.stack ?? e));
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), source_sha: head, error: String(e?.message ?? e), steps, results, wire: wire.slice(-30) }, null, 2));
  try { for (const [i, w] of W.workbenches().entries()) await shot(w, `failure-window-${i}.png`); } catch {}
  cleanup(1);
}

async function envelopeKeys() {
  const keys = [];
  for (const d of existsSync(path.join(storeRoot, 'e')) ? readdirSync(path.join(storeRoot, 'e')) : []) { const ns = readdirSync(path.join(storeRoot, 'e', d)).filter((f) => /^\d+\.json$/.test(f)).sort((x, y) => parseInt(y) - parseInt(x)); if (ns[0]) keys.push(json(path.join(storeRoot, 'e', d, ns[0])).key); }
  return keys;
}
async function findEnvelope(id) { for (const k of await envelopeKeys()) { const e = await files.get('envelope', k); if (e?.request_id === id) return e; } return null; }
