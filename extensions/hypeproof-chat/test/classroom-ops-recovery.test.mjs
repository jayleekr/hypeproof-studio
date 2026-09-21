// #751 U4 — the real operations host (VS Code replaced at the bundle boundary) against an in-process stand-in for the Service.
// What this shows: what each recovery executor REPORTS — its result code, the follow-up it links to the command id, and what it
// does not send. It is not a Studio window, not a real SDK stop, not a real preview tab: those are e2e/classroom/mac-recovery.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecoveryWatch, profileCheckClears, recoveryPayload } from '../src/classroomOps.ts';
import { classifyArtifact, isLoopbackPreview, isTabOfServer, previewPagePath, previewPageUrl, recoverLearnerPreview } from '../src/previewRecovery.ts';

const SECRET_MARK = 'SYNTHETIC-TOKEN-BODY-MUST-NOT-LEAVE';
const token = (jti) => `${Buffer.from(JSON.stringify({ jti, u: 'synthetic-student', c: 'synthetic-cohort', exp: 4102444800 })).toString('base64url')}.${SECRET_MARK}`;

test('controls: the next-turn watch answers once, for its own login generation, and never from a learner Stop or an SDK fallback', () => {
  const w = new RecoveryWatch();
  assert.equal(w.onTurn({ ok: true }, 1), null, 'nothing armed, nothing reported');
  w.arm('cmd-00000001', 3);
  assert.equal(w.onTurn({ ok: false, aborted: true }, 3), null); assert.equal(w.pending, 'cmd-00000001', 'a learner Stop keeps the watch armed');
  assert.deepEqual(w.onTurn({ ok: true, runtime: 'agent-sdk' }, 3), { command_id: 'cmd-00000001', check: 'turn_completed', runtime: 'agent-sdk' });
  assert.equal(w.onTurn({ ok: true }, 3), null, 'one answer per command');
  w.arm('cmd-00000002', 3); assert.equal(w.onTurn({ ok: true }, 4), null, 'the learner signed in again: another generation'); assert.equal(w.pending, null);
  w.arm('cmd-00000003', 3); assert.deepEqual(w.onTurn({ ok: true, sdkFallback: true, runtime: 'proxy' }, 3), { command_id: 'cmd-00000003', check: 'turn_failed', error_class: 'sdk_not_ready', runtime: 'proxy' }, 'finishing WITHOUT the SDK is not the SDK working');
  w.arm('cmd-00000004', 3); assert.deepEqual(w.onTurn({ ok: false, status: 503 }, 3), { command_id: 'cmd-00000004', check: 'turn_failed', error_class: 'provider_5xx' });
  w.arm('cmd-00000005', 3); w.arm('cmd-00000006', 3); assert.equal(w.onTurn({ ok: true }, 3).command_id, 'cmd-00000006', 'the latest action owns the next turn');
  assert.deepEqual(Object.keys(recoveryPayload('cmd-00000007', 'turn_completed', { tokenJti: 'issue-0000001', errorClass: 'unknown' })), ['command_id', 'check'], 'fields that do not belong to the check are dropped');
  for (const c of ['auth_expired', 'auth_rejected', 'class_not_open', 'roster_missing', 'network', null]) assert.equal(profileCheckClears(c), true, String(c));
  for (const c of ['unknown', 'sdk_not_ready', 'tool_not_ready', 'provider_5xx', 'provider_rate_limit', 'budget_limit', 'upload_failed']) assert.equal(profileCheckClears(c), false, c);
});

test('controls: a preview "came back" only when the learner\'s page answers as a document — a 404 is a fault with a name', () => {
  assert.equal(classifyArtifact(200, 'text/html; charset=utf-8'), 'opened'); assert.equal(classifyArtifact(404, 'text/plain'), 'missing'); assert.equal(classifyArtifact(403, 'text/plain'), 'missing');
  assert.equal(classifyArtifact(200, 'application/json'), 'missing', 'an answer that is not a page'); assert.equal(classifyArtifact(500, 'text/html'), 'unreachable'); assert.equal(classifyArtifact(null, null), 'unreachable');
  assert.equal(previewPagePath('http://127.0.0.1:51234/game/index.html?level=2'), '/game/index.html?level=2'); assert.equal(previewPagePath(undefined), '/'); assert.equal(previewPagePath('https://example.test/x.html'), '/', 'only the learner\'s own loopback preview');
  assert.equal(previewPageUrl('http://127.0.0.1:60000/', '/game/index.html?level=2'), 'http://127.0.0.1:60000/game/index.html?level=2');
  assert.equal(previewPageUrl('http://127.0.0.1:60000/', '//evil.test/x'), 'http://127.0.0.1:60000/', 'a path can never leave the new server');
  assert.equal(isLoopbackPreview('http://localhost:3000/'), true); assert.equal(isLoopbackPreview('http://127.0.0.1.evil.test/'), false);
});

async function hostFixture(t, actions) {
  const dir = await mkdtemp(join(tmpdir(), 'hps-ops-recovery-')), subscriptions = [], originalFetch = globalThis.fetch;
  const bundled = join(dir, 'host.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/classroomOpsHost.ts', import.meta.url))], outfile: bundled, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'vscode-stub', setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const window={showInformationMessage:async()=>undefined,showWarningMessage:async()=>undefined}; export const workspace={getConfiguration:()=>({get:()=>"https://example.invalid/v1"})};', loader: 'js' })); } }] });
  const { ClassroomOpsHost } = createRequire(import.meta.url)(bundled);
  const student = { u: 'synthetic-student', c: 'synthetic-cohort', p: 'synthetic-profile' }, now = Date.now();
  const state = new Map([['hypeproof.classroomOps.connection', { grant_id: 'recovery-grant', class_run_id: 'recovery-run', seat_id: 'A1', expires_at: now + 3_600_000, poll_after_ms: 1000, student, run: { starts_at: now - 60_000, ends_at: now + 3_600_000 }, lesson: null }]]);
  const secrets = new Map([['hypeproof.classroomOps.credential', 'SYNTHETIC-OPS-CREDENTIAL']]);
  const context = { globalState: { get: (k) => state.get(k), update: async (k, v) => { v === undefined ? state.delete(k) : state.set(k, v); } }, secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) }, globalStorageUri: { fsPath: dir }, subscriptions };
  // The Service stand-in: hands each queued command over once, says "proceed" to `accepted`, and keeps everything it was sent.
  const svc = { queue: [], events: [], receipts: [], wire: [], n: 0 };
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v1/health') return Response.json({ ok: true });
    if (path !== '/v1/classroom/ops/sync') return Response.json({ reason: 'not_in_this_test' }, { status: 404 });
    svc.wire.push(String(init.body)); const b = JSON.parse(init.body);
    svc.events.push(...(b.events ?? [])); svc.receipts.push(...(b.receipts ?? []));
    const receipt_acks = (b.receipts ?? []).map((r) => ({ command_id: r.command_id, state: r.state, proceed: r.state === 'accepted', reason: '' }));
    const commands = svc.queue.splice(0).map((c) => ({ schema_version: 1, args: {}, lease_generation: 1, connection_epoch: 3, issued_at: Date.now(), start_within_ms: 120_000, run_within_ms: 20_000, ...c }));
    return Response.json({ schema_version: 1, server_time: Date.now(), connection_epoch: 3, ack: { boot_id: b.boot_id, contiguous_seq: Math.max(0, ...(b.events ?? []).map((e) => e.seq)), missing: [] }, quarantined: [], rejected: [], commands, receipt_acks, lease: 'owner', control: { paused: false, control_revision: 0 }, poll_after_ms: 1000 });
  };
  const host = new ClassroomOpsHost(context, () => ({ idleMs: 0, status: 'idle' }), { setHold() {}, readSpool: async () => null, runtimeGeneration: () => 0, newGeneration: async () => 1, freezeInput: async () => {}, probeProfile: async () => ({ ok: true }), refreshProfile: async () => true, requestStop() {}, hasActiveRun: () => false, preservation: async () => ({ history_count: 4, history_sha256: 'h', draft_sha256: 'd', spool_session: null, spool_flushed: true }), recoverPreview: async () => ({ state: 'no_preview', artifact: 'unreachable', reopened: false }), ...actions }, () => {});
  t.after(async () => { await host.disconnectInteractively().catch(() => {}); for (const s of subscriptions) s.dispose(); globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); });
  await host.resume(); host.profileResult({ ok: true }, token('issue-current-01'));
  /** Queue one command and wait for ITS final receipt, at the loop's own cadence (about three 1 s polls per command). */
  const run = async (action, id) => {
    svc.queue.push({ command_id: id, action }); const until = Date.now() + 15_000;
    for (;;) { const r = svc.receipts.find((x) => x.command_id === id && !['accepted', 'running'].includes(x.state)); if (r) return r; assert.ok(Date.now() < until, `${action}: no final receipt`); await new Promise((r2) => setTimeout(r2, 100)); }
  };
  const settle = async (pred) => { const until = Date.now() + 8000; while (!pred()) { assert.ok(Date.now() < until, 'the follow-up never reached the Service'); await new Promise((r) => setTimeout(r, 100)); } };
  const recovery = (id) => svc.events.filter((e) => e.kind === 'recovery' && e.payload.command_id === id).map((e) => e.payload);
  return { host, svc, run, settle, recovery };
}

test('token: a re-check names the issue the app holds; the token itself never leaves; a failed re-check reports no follow-up', async (t) => {
  let verified = true; const f = await hostFixture(t, { refreshProfile: async () => verified });
  let r = await f.run('refresh_connection', 'cmd-refresh-0001'); assert.deepEqual([r.state, r.result_code], ['succeeded', 'profile_verified']);
  await f.settle(() => f.recovery('cmd-refresh-0001').length === 1); assert.deepEqual(f.recovery('cmd-refresh-0001'), [{ command_id: 'cmd-refresh-0001', check: 'profile_verified', token_jti: 'issue-current-01' }]);
  // The learner enters the re-issued token; the next re-check names THAT issue.
  f.host.profileResult({ ok: true }, token('issue-reissued-02')); r = await f.run('refresh_connection', 'cmd-refresh-0002'); await f.settle(() => f.recovery('cmd-refresh-0002').length === 1);
  assert.equal(f.recovery('cmd-refresh-0002')[0].token_jti, 'issue-reissued-02');
  verified = false; r = await f.run('refresh_connection', 'cmd-refresh-0003'); assert.deepEqual([r.state, r.result_code], ['failed', 'profile_not_verified']); assert.deepEqual(f.recovery('cmd-refresh-0003'), []);
  assert.equal(f.svc.wire.some((w) => w.includes(SECRET_MARK)), false, 'no part of the token body is ever sent');
  const sent = JSON.parse(f.svc.wire[0]); assert.ok(sent.capabilities.includes('recovery_followup'));
});

test('runtime: a stop and a preserving restart report READY; the learner\'s next finished turn is what answers them — once', async (t) => {
  let active = true, draft = 'd'; const f = await hostFixture(t, { hasActiveRun: () => active, requestStop: () => { active = false; }, preservation: async () => ({ history_count: 4, history_sha256: 'h', draft_sha256: draft, spool_session: null, spool_flushed: true }) });
  let r = await f.run('cancel_current_run', 'cmd-stop-000001'); assert.deepEqual([r.state, r.result_code], ['succeeded', 'run_stopped']); assert.deepEqual(f.recovery('cmd-stop-000001'), [], 'stopping proves nothing about the next run');
  f.host.turnResult({ ok: false, aborted: true }); f.host.turnResult({ ok: false, status: 503, runtime: 'agent-sdk' }); await f.settle(() => f.recovery('cmd-stop-000001').length === 1);
  assert.deepEqual(f.recovery('cmd-stop-000001'), [{ command_id: 'cmd-stop-000001', check: 'turn_failed', error_class: 'provider_5xx', runtime: 'agent-sdk' }]);
  r = await f.run('cancel_current_run', 'cmd-stop-000002'); assert.deepEqual([r.state, r.result_code], ['succeeded', 'no_active_run']);
  r = await f.run('reset_runtime', 'cmd-reset-00001'); assert.deepEqual([r.state, r.result_code], ['succeeded', 'reset_ok']); assert.deepEqual(f.recovery('cmd-reset-00001'), []);
  f.host.turnResult({ ok: true, runtime: 'agent-sdk' }); f.host.turnResult({ ok: true, runtime: 'agent-sdk' }); await f.settle(() => f.recovery('cmd-reset-00001').length >= 1);
  await new Promise((x) => setTimeout(x, 1500)); assert.deepEqual(f.recovery('cmd-reset-00001'), [{ command_id: 'cmd-reset-00001', check: 'turn_completed', runtime: 'agent-sdk' }], 'the second turn is just a turn');
  // The baseline was taken BEFORE the stop: a draft that differs afterwards is reported, and nothing is armed.
  active = true; const stopThatEdits = () => { active = false; draft = 'changed-while-stopping'; };
  const g = await hostFixture(t, { hasActiveRun: () => active, requestStop: stopThatEdits, preservation: async () => ({ history_count: 4, history_sha256: 'h', draft_sha256: draft, spool_session: null, spool_flushed: true }) });
  r = await g.run('cancel_current_run', 'cmd-stop-000003'); assert.deepEqual([r.state, r.result_code], ['failed', 'preservation_mismatch']); g.host.turnResult({ ok: true }); await new Promise((x) => setTimeout(x, 1200)); assert.deepEqual(g.recovery('cmd-stop-000003'), []);
});

test('a token re-check does not clear a runtime fault; a finished turn does', async (t) => {
  const f = await hostFixture(t, {}); const cleared = () => f.svc.events.filter((e) => e.kind === 'error' && e.payload.cleared === true).length;
  await f.settle(() => f.svc.wire.length > 0); const base = cleared();
  f.host.turnResult({ ok: false, errorKind: 'sdk_crash', runtime: 'agent-sdk' }); await f.settle(() => f.svc.events.some((e) => e.kind === 'activation' && e.payload.stage === 'runtime_failed'));
  const r = await f.run('retry_diagnostics', 'cmd-diag-000001'); assert.deepEqual([r.state, r.result_code], ['succeeded', 'token_ok']); await new Promise((x) => setTimeout(x, 1200));
  assert.equal(cleared(), base, 'diagnostics found a good token; the runtime fault is still the runtime fault');
  f.host.turnResult({ ok: true, runtime: 'agent-sdk' }); await f.settle(() => cleared() === base + 1);
  // A fault that IS about the token is cleared by a good re-check.
  f.host.profileResult({ ok: false, status: 401, code: 'expired' }, token('issue-current-01')); await f.settle(() => f.svc.events.some((e) => e.kind === 'error' && e.payload.class === 'auth_expired'));
  f.host.profileResult({ ok: true }, token('issue-current-01')); await f.settle(() => cleared() === base + 2);
});

test('preview: a missing page and a tab left on the dead address are reported as what they are', async (t) => {
  let answer = { state: 'reloaded', artifact: 'opened', tabs: 'loaded' }; const f = await hostFixture(t, { recoverPreview: async () => answer });
  const codes = [];
  for (const [i, a] of [[1, answer], [2, { state: 'reloaded', artifact: 'missing', tabs: 'not_loaded' }], [3, { state: 'restarted', artifact: 'opened', tabs: 'loaded' }], [4, { state: 'restarted', artifact: 'opened', tabs: 'not_loaded' }], [5, { state: 'restarted', artifact: 'unreachable', tabs: 'none' }], [6, { state: 'no_preview', artifact: 'unreachable', tabs: 'none' }], [7, { state: 'restarted', artifact: 'opened', tabs: 'none' }], [8, { state: 'reloaded', artifact: 'opened', tabs: 'none' }], [9, { state: 'reloaded', artifact: 'opened', tabs: 'not_loaded' }]]) { answer = a; const r = await f.run('restart_preview', 'cmd-preview-000' + i); codes.push([r.state, r.result_code]); }
  assert.deepEqual(codes, [['succeeded', 'preview_artifact_ok'], ['failed', 'preview_artifact_missing'], ['succeeded', 'preview_reopened_artifact_ok'], ['failed', 'preview_restarted_new_url'], ['failed', 'preview_unhealthy'], ['failed', 'no_preview'], ['failed', 'preview_restarted_new_url'], ['succeeded', 'preview_reloaded'], ['succeeded', 'preview_reloaded']], 'no own tab = never "reconnected"; a tab that did not load anew = server answer only');
});

// ── #751 U4 — only the learner's own preview tabs. Tabs are fakes; the procedure is the product's recoverLearnerPreview. ──
function tabWorld(urls, { restart = true, page = { status: 200, contentType: 'text/html' }, loadFails = [] } = {}) {
  let n = 0; const tabs = urls.map((url) => ({ id: 'tab-' + (++n), url })), log = { loaded: [], closed: [], opened: [], fetched: [] };
  const deps = {
    tabs: () => tabs, serverUrl: () => 'http://127.0.0.1:41000/',
    recover: async () => (restart ? { state: 'restarted', url: 'http://127.0.0.1:42000/' } : { state: 'reloaded', url: 'http://127.0.0.1:41000/' }),
    fetchPage: async (url) => { log.fetched.push(url); return page; },
    load: async (tab, url) => { if (!tabs.includes(tab) || loadFails.includes(tab.id)) return null; log.loaded.push([tab.id, url]); tab.url = url; return { href: url, complete: true, fresh: true }; },
    close: async (tab) => { log.closed.push(tab.id); tabs.splice(tabs.indexOf(tab), 1); },
    open: async (url) => { const t = { id: 'tab-' + (++n), url }; tabs.push(t); log.opened.push(url); return t; },
  };
  return { tabs, log, deps };
}
const STUDENT = 'http://127.0.0.1:41000/game.html', TOOL = 'http://localhost:5173/admin', SITE = 'https://example.com/';

test('preview identity: a tab belongs to the learner\'s server only by that server\'s scheme + port', () => {
  assert.equal(isTabOfServer(STUDENT, 'http://127.0.0.1:41000/'), true); assert.equal(isTabOfServer('http://localhost:41000/x', 'http://127.0.0.1:41000/'), true, 'two spellings of loopback');
  assert.equal(isTabOfServer(TOOL, 'http://127.0.0.1:41000/'), false); assert.equal(isTabOfServer(SITE, 'http://127.0.0.1:41000/'), false); assert.equal(isTabOfServer('http://127.0.0.1.evil.test:41000/', 'http://127.0.0.1:41000/'), false); assert.equal(isTabOfServer(STUDENT, undefined), false);
});

test('preview recovery: the learner\'s tab moves to the new port at its own path; an unrelated localhost tool and a site are untouched in either order', async () => {
  for (const order of [[TOOL, STUDENT, SITE], [STUDENT, TOOL, SITE]]) {
    const w = tabWorld(order); const before = w.tabs.map((t) => ({ ...t }));
    const r = await recoverLearnerPreview(w.deps);
    assert.deepEqual(r, { state: 'restarted', artifact: 'opened', tabs: 'loaded' }, order.join(' '));
    assert.deepEqual(w.log.fetched, ['http://127.0.0.1:42000/game.html'], 'the page judged is the learner\'s, never /admin');
    const student = before.find((t) => t.url === STUDENT);
    assert.deepEqual(w.log.loaded, [[student.id, 'http://127.0.0.1:42000/game.html']]); assert.deepEqual(w.log.closed, []); assert.deepEqual(w.log.opened, []);
    for (const other of before.filter((t) => t.url !== STUDENT)) assert.equal(w.tabs.find((t) => t.id === other.id)?.url, other.url, 'kept: ' + other.url);
  }
});

test('preview recovery: no own tab is never "reconnected"; a 404 moves nothing; several own sub-pages each keep their path', async () => {
  const none = tabWorld([TOOL, SITE]); assert.deepEqual(await recoverLearnerPreview(none.deps), { state: 'restarted', artifact: 'opened', tabs: 'none' });
  assert.deepEqual([none.log.loaded, none.log.closed, none.log.opened], [[], [], []]);
  const gone = tabWorld([STUDENT, TOOL], { page: { status: 404, contentType: 'text/plain' } }); assert.deepEqual(await recoverLearnerPreview(gone.deps), { state: 'restarted', artifact: 'missing', tabs: 'not_loaded' }); assert.deepEqual(gone.log.loaded, []);
  const two = tabWorld([STUDENT, 'http://127.0.0.1:41000/levels/2.html?x=1', TOOL]); assert.equal((await recoverLearnerPreview(two.deps)).tabs, 'loaded');
  assert.deepEqual(two.log.loaded.map(([, u]) => u), ['http://127.0.0.1:42000/game.html', 'http://127.0.0.1:42000/levels/2.html?x=1']);
  const alive = tabWorld([TOOL, STUDENT], { restart: false }); assert.deepEqual(await recoverLearnerPreview(alive.deps), { state: 'reloaded', artifact: 'opened', tabs: 'loaded' }); assert.deepEqual(alive.log.fetched, ['http://127.0.0.1:41000/game.html'], 'reloaded: judged on the learner\'s path, not the tool\'s');
});

test('preview recovery: a tab that will not load is replaced only when it is the learner\'s own on a dead server — and it must then load', async () => {
  const w = tabWorld([TOOL, STUDENT], { loadFails: ['tab-2'] }); assert.equal((await recoverLearnerPreview(w.deps)).tabs, 'loaded');
  assert.deepEqual(w.log.closed, ['tab-2']); assert.deepEqual(w.log.opened, ['http://127.0.0.1:42000/game.html']); assert.equal(w.tabs.find((t) => t.id === 'tab-1').url, TOOL);
  const stale = tabWorld([STUDENT]); stale.deps.load = async () => ({ href: STUDENT, complete: true, fresh: false });
  assert.equal((await recoverLearnerPreview(stale.deps)).tabs, 'not_loaded', 'an old document that was already complete is not the new page');
  const live = tabWorld([STUDENT], { restart: false, loadFails: ['tab-1'] }); assert.equal((await recoverLearnerPreview(live.deps)).tabs, 'not_loaded'); assert.deepEqual(live.log.closed, [], 'a healthy server\'s tab is never closed');
});
