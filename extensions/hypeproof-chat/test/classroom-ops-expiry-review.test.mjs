// #751 / F5: execute the actual host with VS Code replaced at the bundle boundary.
// Frozen files are synthetic; fetch is intercepted and never reaches a network.
// This is a host lifecycle test, not evidence of installed macOS/Windows behaviour.
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freezeSnapshot, uploadSnapshot } from '../src/evidenceSnapshot.ts';

// `opts.pendingGrant`: the grant the frozen copy was made under (default: this connection's).
// `opts.endedMsAgo`: how long ago the class run ended.
async function hostFixture(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hps-ops-expiry-review-'));
  const subscriptions = [], originalFetch = globalThis.fetch;
  t.after(async () => { for (const s of subscriptions) s.dispose(); globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); });
  const bundled = join(dir, 'host.cjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/classroomOpsHost.ts', import.meta.url))],
    outfile: bundled, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'vscode-review-stub', setup(b) {
      b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const window={showInformationMessage:async()=>undefined}; export const workspace={getConfiguration:()=>({get:()=>"https://example.invalid/v1"})};', loader: 'js',
      }));
    } }],
  });
  const { ClassroomOpsHost } = createRequire(import.meta.url)(bundled);
  const batch = 'pending-review-batch', snapshots = join(dir, 'classroom-snapshots'), copy = join(snapshots, batch, 'r1');
  await mkdir(copy, { recursive: true });
  const files = [
    { name: 'session.meta.json', data: new TextEncoder().encode(JSON.stringify({ schema_version: 1, session_id: 'review-run', user: { u: 'synthetic-student', c: 'synthetic-cohort', p: 'synthetic-profile' } })) },
    { name: 'events.jsonl', data: new TextEncoder().encode('{"schema_version":1,"type":"prompt","text":"SYNTHETIC ONLY"}\n') },
  ];
  // The binding contract (review F1): the copy is frozen for one student, run and consent scope, through the real freezer.
  const ended = Date.now() - (opts.endedMsAgo ?? 2000);
  const student = { u: 'synthetic-student', c: 'synthetic-cohort', p: 'synthetic-profile' }, run = { starts_at: ended - 3_600_000, ends_at: ended };
  const scope = { grant_id: opts.pendingGrant ?? 'review-grant', class_run_id: 'review-run', seat_id: 'A1', student, activity: null, run };
  const frozen = freezeSnapshot(files, scope, batch, { purpose: 'class_report', notice_version: 'notice-v1' }, Date.now());
  assert.equal(frozen.ok, true, 'precondition: the learner\'s own spool freezes');
  for (const f of frozen.files) await writeFile(join(copy, f.name), f.data);
  await writeFile(join(copy, 'binding.json'), JSON.stringify(frozen.binding));
  const stateFile = join(snapshots, batch + '.state.json');
  const pending = await uploadSnapshot(batch, {
    scope: () => scope, copy: async () => ({ files: frozen.files, binding: frozen.binding }), loadState: async () => null,
    saveState: async (s) => writeFile(stateFile, JSON.stringify(s)),
    put: async () => ({ status: 0 }), seal: async () => { throw Error('offline cannot seal'); },
  });
  assert.equal(pending.code, 'offline_pending', 'precondition: a real uploader-created pending snapshot');
  const state = new Map([['hypeproof.classroomOps.connection', {
    grant_id: 'review-grant', class_run_id: 'review-run', seat_id: 'A1', expires_at: opts.live ? Date.now() + 3_600_000 : ended + 1000, poll_after_ms: 5000, student, run, lesson: null,
  }]]);
  const secrets = new Map([['hypeproof.classroomOps.credential', 'SYNTHETIC-UPLOAD-GRACE-CREDENTIAL']]);
  const context = {
    globalState: { get: (k) => state.get(k), update: async (k, v) => { v === undefined ? state.delete(k) : state.set(k, v); } },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) },
    globalStorageUri: { fsPath: dir }, subscriptions,
  };
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname; requests.push(path);
    if (opts.onFetch) { const r = await opts.onFetch(path, init); if (r) return r; }
    if (!path.startsWith('/v1/classroom/ops/collect/snapshots/')) return Response.json({ reason: 'ops_credential_expired' }, { status: 401 });
    return Response.json(path.endsWith('/seal') ? { receipt_id: 'synthetic-receipt', coverage: 'sequence_unavailable' } : {}, { status: 201 });
  };
  const host = new ClassroomOpsHost(context, () => ({ idleMs: 0, status: 'idle' }), {
    setHold() {}, readSpool: async () => { throw Error('resume must use the frozen copy, never read a new live spool'); },
    ...(opts.probeProfile ? { probeProfile: opts.probeProfile } : {}),
  }, () => {});
  return { host, requests, stateFile, secrets };
}

test('F5 normal expiry resumes the previously authorized frozen upload, without sync or commands', async (t) => {
  const f = await hostFixture(t);
  await f.host.resume();
  // Host currently starts uploads in the background. Wait for receipt, bounded at 1 s.
  const until = Date.now() + 1000;
  let state;
  do {
    state = JSON.parse(await readFile(f.stateFile, 'utf8'));
    if (state.receipt_id) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < until);
  assert.equal(state.receipt_id, 'synthetic-receipt', 'normal connection expiry must not strand an approved pending snapshot');
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every((p) => p.startsWith('/v1/classroom/ops/collect/snapshots/')), 'expired observation/command access must not resume');
});

test('F5 negative control: explicit disconnect does not resume a pending upload', async (t) => {
  const f = await hostFixture(t);
  await f.host.disconnectInteractively();
  await f.host.resume();
  assert.deepEqual(f.requests, []);
  assert.equal(JSON.parse(await readFile(f.stateFile, 'utf8')).receipt_id, undefined);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
test('F5 shared PC: a copy frozen under another learner\'s grant is never sent with this credential', async (t) => {
  const f = await hostFixture(t, { pendingGrant: 'previous-learner-grant' });
  await f.host.resume(); await settle();
  assert.deepEqual(f.requests, [], 'the previous learner\'s pending files must not be walked with the current credential');
  assert.equal(JSON.parse(await readFile(f.stateFile, 'utf8')).receipt_id, undefined);
});
test('F5 the upload-only afterlife ends with the window: 24 h after class nothing is resumed and the credential is dropped', async (t) => {
  const f = await hostFixture(t, { endedMsAgo: 25 * 3_600_000 });
  await f.host.resume(); await settle();
  assert.deepEqual(f.requests, []);
  assert.equal(f.secrets.size, 0, 'a credential with nothing left to do is not kept');
});
test('F5 a Service refusal (withdrawn) ends the resume: recorded once, not retried on the next start', async (t) => {
  const f = await hostFixture(t);
  globalThis.fetch = async (url) => { f.requests.push(new URL(url).pathname); return Response.json({ reason: 'withdrawn' }, { status: 403 }); };
  await f.host.resume(); await settle();
  assert.equal(JSON.parse(await readFile(f.stateFile, 'utf8')).result, 'withdrawn');
  const before = f.requests.length; await f.host.resume(); await settle();
  assert.equal(f.requests.length, before, 'a withdrawn upload is not attempted again');
});

// Found in the real Mac GUI run (2026-09-20): in a class the token is verified FIRST and the seat is paired LATER. The
// verification that happened before the connection existed had nowhere to go, so the board showed the token as unknown.
test('token verified before pairing still reaches the board: the host asks once when the connection starts', async (t) => {
  const bodies = [], jwt = (o) => Buffer.from(JSON.stringify(o)).toString('base64url') + '.synthetic-signature'; // HPS tokens are payload.signature
  const token = jwt({ u: 'synthetic-student', c: 'synthetic-cohort', p: 'synthetic-profile', jti: 'issue-0001', exp: Math.floor(Date.now() / 1000) + 3600 });
  let probes = 0; const f = await hostFixture(t, { live: true, endedMsAgo: -3_600_000, probeProfile: async () => { probes++; return { ok: true }; },
    onFetch: async (path, init) => { if (path !== '/v1/classroom/ops/sync') return null; const b = JSON.parse(init.body); bodies.push(b); return Response.json({ ack: { contiguous: Math.max(0, ...b.events.map((e) => e.seq)), results: [] }, connection_epoch: 1, poll_after_ms: 60000, control: { paused: false, control_revision: 0 } }); } });
  f.host.profileResult({ ok: true }, token); // before any connection: nothing to report to yet
  await f.host.resume();
  const until = Date.now() + 2000; while (Date.now() < until && !bodies.some((b) => b.events.some((e) => e.kind === 'activation'))) await new Promise((r) => setTimeout(r, 20));
  const activation = bodies.flatMap((b) => b.events).find((e) => e.kind === 'activation'); assert.ok(activation, 'an activation event was sent after the connection started');
  assert.deepEqual([activation.payload.stage, activation.payload.token_jti], ['token_verified', 'issue-0001']); assert.equal(probes, 1, 'asked once, not polled');
  await f.host.disconnectInteractively();
});
test('negative control: no token on the device → starting a connection reports no token verification', async (t) => {
  const bodies = []; const f = await hostFixture(t, { live: true, endedMsAgo: -3_600_000, probeProfile: async () => ({ ok: false, noToken: true }),
    onFetch: async (path, init) => { if (path !== '/v1/classroom/ops/sync') return null; const b = JSON.parse(init.body); bodies.push(b); return Response.json({ ack: { contiguous: 0, results: [] }, connection_epoch: 1, poll_after_ms: 60000, control: { paused: false, control_revision: 0 } }); } });
  await f.host.resume(); await new Promise((r) => setTimeout(r, 300));
  assert.ok(!bodies.flatMap((b) => b.events).some((e) => e.kind === 'activation')); await f.host.disconnectInteractively();
});

test('a slow connect-time token check never overwrites what the learner\'s first turn already reported', async (t) => {
  const bodies = []; let release; const held = new Promise((r) => { release = r; });
  const f = await hostFixture(t, { live: true, endedMsAgo: -3_600_000, probeProfile: async () => { await held; return { ok: true }; },
    onFetch: async (path, init) => { if (path !== '/v1/classroom/ops/sync') return null; const b = JSON.parse(init.body); bodies.push(b); return Response.json({ ack: { contiguous: Math.max(0, ...b.events.map((e) => e.seq)), results: [] }, connection_epoch: 1, poll_after_ms: 60000, control: { paused: false, control_revision: 0 } }); } });
  await f.host.resume(); f.host.turnResult({ ok: false, runtime: 'agent-sdk', errorKind: 'upstream', status: 500 }); // a fault is reported while the check is still in flight
  release(); await new Promise((r) => setTimeout(r, 300));
  const sent = bodies.flatMap((b) => b.events), kinds = sent.map((e) => [e.kind, e.payload.stage ?? e.payload.class, e.payload.cleared === true]);
  assert.ok(sent.some((e) => e.kind === 'error' && e.payload.blocking === true), 'precondition: the fault was sent'); assert.ok(!kinds.some(([k, , cleared]) => k === 'error' && cleared), 'the late check did not clear it: ' + JSON.stringify(kinds));
  assert.ok(!kinds.some(([k, v]) => k === 'activation' && v === 'token_verified'), 'and did not move the entry stage back'); await f.host.disconnectInteractively();
});
