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
  // The deploy order is rehearsed here on real local D1, with the same checker the runbook uses against a remote target
  // (worker/scripts/classroom-ops-d1-check.mjs): nothing applied → half applied → all applied → applied again.
  const { compare } = await import('../scripts/classroom-ops-d1-check.mjs'), files = ['0011-classroom-ops', '0012-classroom-ops-commands', '0013-classroom-ops-control', '0014-classroom-ops-evidence-review', '0015-classroom-collection', '0016-classroom-report-jobs', '0017-classroom-delivery', '0018-classroom-snapshot-binding', '0019-classroom-report-attempts', '0020-classroom-viewer-check', '0021-classroom-erasure-log', '0022-classroom-collect-scope', '0023-classroom-distribution', '0024-classroom-lesson-bindings'];
  const present = async () => (await db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results.map((r) => r.name);
  let seen = compare(await present()); assert.equal(seen.none, true); assert.deepEqual(seen.next, files.map((m) => m + '.sql'), 'the checker lists every migration file of this feature, in order');
  for (const m of files.slice(0, 5)) await apply(readFileSync(new URL(`../migrations/${m}.sql`, import.meta.url), 'utf8'));
  seen = compare(await present()); assert.deepEqual([seen.all, seen.none, seen.out_of_order, seen.next[0]], [false, false, false, files[5] + '.sql'], 'an interrupted rollout says exactly where to continue');
  for (let i = 0; i < 2; i++) for (const m of files) await apply(readFileSync(new URL(`../migrations/${m}.sql`, import.meta.url), 'utf8'));
  seen = compare(await present()); assert.deepEqual([seen.all, seen.partial, seen.rows.flatMap((r) => r.not_additive)], [true, [], []], 'all applied, re-applied without error, and every statement is CREATE … IF NOT EXISTS');
  assert.equal(compare((await present()).filter((n) => n !== 'classroom_erasure_log_state')).partial[0], '0021-classroom-erasure-log.sql', 'negative control: a half-created migration is reported, not counted as applied');
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
  // U4 on real D1: the follow-up join (json_each + the (run, seat, received_at) index), the outcome in both reads, and what the join costs.
  { const owner = windows.find((r) => r.json?.commands?.length === 1), w = [n, 8, 9][windows.indexOf(owner)], cmd = owner.json.commands[0];
    assert.equal((await f.sync(credential, [], w, { receipts: [f.receipt(cmd, 'accepted')] })).json.receipt_acks[0].proceed, true);
    const done = await f.sync(credential, [f.event(5, 'recovery', { command_id: cmd.command_id, check: 'turn_completed' }), f.event(6, 'recovery', { command_id: 'not-this-command-0001', check: 'turn_completed' })], n, { receipts: [] });
    assert.deepEqual(done.json.quarantined, [6], 'a follow-up that names no command of this connection is unlinked on real D1 too');
    await f.sync(credential, [], w, { receipts: [f.receipt(cmd, 'succeeded', 'token_ok')] });
    const view = (await f.request(f.base + '/commands/' + cmd.command_id)).json; assert.deepEqual([view.targets[0].state, view.targets[0].outcome.verdict, view.summary.outcomes.resolved], ['succeeded', 'resolved', 1]);
    const board = (await f.request(f.base + '/status')).json.seats.find((x) => x.seat_id === seat); assert.deepEqual([board.last_command.outcome.verdict, board.recommended.action !== undefined, board.control_outcome.service], ['resolved', true, 'never_set']);
    const cost = await db.prepare("SELECT e.seat_id FROM json_each(?) j JOIN ops_events e ON e.class_run_id=? AND e.seat_id=json_extract(j.value,'$[0]') AND e.received_at>=json_extract(j.value,'$[1]') WHERE e.kind='recovery' AND e.disposition='applied'").bind(JSON.stringify([[seat, 0]]), f.run).all();
    const total = (await db.prepare('SELECT count(*) AS n FROM ops_events').first()).n, mine = (await db.prepare('SELECT count(*) AS n FROM ops_events WHERE seat_id=?').bind(seat).first()).n;
    console.log(`U4 follow-up read on local D1: rows_read=${cost.meta.rows_read} for ${mine} event(s) of the seat, ${total} in the run`); assert.ok(cost.meta.rows_read <= mine + 2, 'the read is bounded by the seat\'s own events, not the run\'s ledger'); }
  console.log('PASS actual local workerd/D1: re-runnable migration 0011, atomic roster CAS, single-use pairing under 4 parallel connects, state CAS, one-read status, idempotent parallel enqueue, single lease owner, U4 linked follow-up + outcome + bounded follow-up read');
} finally { f?.close(); await mf.dispose(); }
