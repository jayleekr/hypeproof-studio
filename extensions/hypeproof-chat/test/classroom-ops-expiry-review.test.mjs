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
import { uploadSnapshot } from '../src/evidenceSnapshot.ts';

async function hostFixture(t) {
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
  for (const f of files) await writeFile(join(copy, f.name), f.data);
  const stateFile = join(snapshots, batch + '.state.json');
  const pending = await uploadSnapshot(batch, {
    copy: async () => files, loadState: async () => null,
    saveState: async (s) => writeFile(stateFile, JSON.stringify(s)),
    put: async () => ({ status: 0 }), seal: async () => { throw Error('offline cannot seal'); },
  });
  assert.equal(pending.code, 'offline_pending', 'precondition: a real uploader-created pending snapshot');
  const state = new Map([['hypeproof.classroomOps.connection', {
    grant_id: 'review-grant', class_run_id: 'review-run', seat_id: 'A1', expires_at: Date.now() - 1000, poll_after_ms: 5000,
  }]]);
  const secrets = new Map([['hypeproof.classroomOps.credential', 'SYNTHETIC-UPLOAD-GRACE-CREDENTIAL']]);
  const context = {
    globalState: { get: (k) => state.get(k), update: async (k, v) => { v === undefined ? state.delete(k) : state.set(k, v); } },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) },
    globalStorageUri: { fsPath: dir }, subscriptions,
  };
  const requests = [];
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname; requests.push(path);
    if (!path.startsWith('/v1/classroom/ops/collect/snapshots/')) return Response.json({ reason: 'ops_credential_expired' }, { status: 401 });
    return Response.json(path.endsWith('/seal') ? { receipt_id: 'synthetic-receipt', coverage: 'sequence_unavailable' } : {}, { status: 201 });
  };
  const host = new ClassroomOpsHost(context, () => ({ idleMs: 0, status: 'idle' }), {
    setHold() {}, readSpool: async () => { throw Error('resume must use the frozen copy, never read a new live spool'); },
  }, () => {});
  return { host, requests, stateFile };
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
