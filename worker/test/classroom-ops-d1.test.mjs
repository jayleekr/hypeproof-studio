// Remote classroom operations on actual local workerd/D1 (not the SQLite shim):
// migration re-run, batch atomicity of the roster CAS, single-use pairing under
// parallel connects, and the conditional state write. Not production D1.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMiniflare } from './harness/miniflare.mjs';
import { localOps } from './harness/classroom-ops.mjs';
const compatibilityDate = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
const mf = createMiniflare({ modules: true, script: 'export default {fetch(){return new Response("local test")}}', compatibilityDate, d1Databases: ['HPS_DB'] });
let f;
try {
  const db = await mf.getD1Database('HPS_DB');
  const apply = async (sql) => { for (const s of sql.replace(/^--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run(); };
  for (let i = 0; i < 2; i++) for (const m of ['0011-classroom-ops', '0012-classroom-ops-commands', '0013-classroom-ops-control', '0014-classroom-ops-evidence-review']) await apply(readFileSync(new URL(`../migrations/${m}.sql`, import.meta.url), 'utf8'));
  await db.prepare('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, cohort_id TEXT, profile_id TEXT, starts_at TEXT, ends_at TEXT, ended_at TEXT)').run();
  f = await localOps({ binding: db });
  const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }];
  const plain = (s) => f.configure(s, 0, { lesson: undefined });
  const writes = await Promise.all([plain(seats), plain(seats), plain([{ seat_id: 'B1', student_id: 'student-c' }])]);
  assert.deepEqual(writes.map((r) => r.status).sort(), [201, 409, 409]);
  const live = (await db.prepare('SELECT seat_id FROM class_run_seats WHERE replaced_at IS NULL ORDER BY seat_id').all()).results.map((r) => r.seat_id);
  assert.ok(JSON.stringify(live) === '["A1","A2"]' || JSON.stringify(live) === '["B1"]', 'exactly one writer applied its whole roster: ' + live);
  const rev = (await db.prepare('SELECT roster_revision r FROM class_run_ops').first()).r; assert.equal(rev, 1);
  const seat = live[0];
  const p = await f.request(f.base + '/pairings', 'POST', { seat_id: seat, roster_revision: 1 }); assert.equal(p.status, 201, p.raw);
  const connects = await Promise.all([1, 2, 3, 4].map((n) => f.request('/v1/classroom/ops/connect', 'POST', { ticket: p.json.ticket, ...f.instance(n) }, null)));
  assert.deepEqual(connects.map((r) => r.status).sort(), [201, 403, 403, 403]);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM ops_grants WHERE kind='connection' AND state='active'").first()).n, 1);
  const credential = connects.find((r) => r.status === 201).json.credential, n = connects.findIndex((r) => r.status === 201) + 1;
  const r1 = await f.sync(credential, [f.event(1, 'runtime', { status: 'running' }), f.event(2, 'error', { class: 'network', blocking: false })], n); assert.equal(r1.status, 200, r1.raw); assert.equal(r1.json.ack.contiguous_seq, 2);
  // Two syncs racing on the same seat state: events from both are kept, at most one loses the state CAS and is told to resend.
  const race = await Promise.all([f.sync(credential, [f.event(3, 'runtime', { status: 'idle' })], n), f.sync(credential, [f.event(4, 'runtime', { status: 'waiting_user' })], n)]);
  assert.ok(race.every((r) => r.status === 200 || r.status === 409), race.map((r) => r.raw).join());
  for (const [i, r] of race.entries()) if (r.status === 409) assert.equal((await f.sync(credential, [], n)).status, 200, 'resend after conflict ' + i);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM ops_events').first()).n, 4);
  const s = await f.request(f.base + '/status'); assert.equal(s.status, 200, s.raw); assert.equal(s.json.seats.length, live.length);
  // R2 on real D1: same idempotency key in parallel records one command; one window leases it.
  assert.equal((await f.configure(live.map((id) => ({ seat_id: id, student_id: id === 'B1' ? 'student-c' : id === 'A1' ? 'student-a' : 'student-b' })), 1, { lesson: undefined, flags: { ops_commands: true } })).status, 200);
  const key = crypto.randomUUID(), enq = await Promise.all([1, 2, 3, 4].map(() => f.command('retry_diagnostics', [seat], { expected_roster_revision: 2, idempotency_key: key })));
  assert.deepEqual(enq.map((r) => r.status).sort(), [200, 200, 200, 202], enq.map((r) => r.raw).join()); assert.equal((await db.prepare('SELECT count(*) AS n FROM ops_commands').first()).n, 1);
  const windows = await Promise.all([n, 8, 9].map((w) => f.sync(credential, [], w))); assert.equal(windows.filter((r) => r.json?.commands?.length === 1).length, 1, 'exactly one window receives the command'); assert.equal(windows.filter((r) => r.json?.lease === 'owner').length, 1);
  console.log('PASS actual local workerd/D1: re-runnable migration 0011, atomic roster CAS, single-use pairing under 4 parallel connects, state CAS, one-read status, idempotent parallel enqueue, single lease owner');
} finally { f?.close(); await mf.dispose(); }
