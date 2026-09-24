// Remote classroom operations R7 (#751) — AT-32/33 Service layer and a SYNTHETIC in-process load for AT-25/34.
// The load numbers are Node + SQLite on this machine. They are not Workers CPU, not D1 latency, not a school
// network and not 100 real laptops; they only show the handler's shape (writes per idle poll, no cross-seat leak).
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { localOps } from './harness/classroom-ops.mjs';
let count = 0; async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const OPS_TABLES = ['class_run_ops', 'class_run_seats', 'ops_grants', 'ops_device_connections', 'ops_latest_state', 'ops_events', 'ops_audit', 'ops_token_issues', 'ops_commands', 'ops_command_targets', 'ops_seat_leases', 'class_run_control', 'ops_event_reviews', 'classroom_consents', 'classroom_collect_batches', 'classroom_collect_items', 'classroom_snapshots', 'classroom_job_outbox', 'classroom_collect_tombstones', 'classroom_report_jobs', 'classroom_recipients', 'classroom_delivery_approvals', 'classroom_report_deliveries', 'classroom_report_links', 'classroom_delivery_events', 'classroom_snapshot_bindings', 'classroom_report_job_attempts', 'classroom_recipient_checks', 'classroom_link_attempts', 'classroom_erasure_log'];
{
  const off = await localOps({ enabled: false });
  try {
    await check('AT-32 global switch OFF: every new route answers "not enabled", the existing class surface works, and no operations row is ever written', async () => {
      const R = off.base, B = R + '/report-batches/b', admin = { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') }, cred = 'hpsops1.11111111-1111-4111-8111-111111111111.sig';
      for (const [path, method, token, headers] of [[R, 'PUT'], [R + '/status', 'GET'], [R + '/pairings', 'POST'], [R + '/commands', 'POST'], [R + '/commands/x', 'GET'], [R + '/control', 'PUT'], [R + '/evidence/a.b.1', 'PUT'], [R + '/report-batches', 'POST'], [B + '/jobs', 'POST'], [B + '/advance', 'POST'], [B + '/reports', 'GET'], [B + '/runner-grants', 'POST'], [B + '/recipients', 'GET'], [B + '/approve', 'POST'], [B + '/deliver', 'POST'], [B + '/deliveries', 'GET'], ['/v1/classroom/ops/connect', 'POST', null], ['/v1/classroom/ops/sync', 'POST', cred], ['/v1/classroom/ops/collect/consent', 'POST', cred], ['/v1/classroom/ops/runner/claim', 'POST', cred], ['/v1/classroom/report-links/' + 'a'.repeat(64), 'GET', null], ['/v1/classroom/delivery-webhooks/resend', 'POST', null], ['/v1/classroom/ops/runner/jobs/x/evaluate', 'POST', cred], ['/admin/classroom/consents', 'POST', null, admin], ['/admin/classroom/erasures', 'POST', null, admin], ['/admin/classroom/recipients', 'POST', null, admin], ['/admin/classroom/delivery-events', 'POST', null, admin]]) { const r = await off.request(path, method, method === 'GET' ? undefined : {}, token === undefined ? off.teacherToken : token, headers ?? {}); assert.equal(r.status, 404, `${method} ${path} → ${r.status}`); }
      const student = await off.student('student-a'); assert.equal((await off.request('/admin/tokens/issue', 'POST', { u: 'student-a', c: off.cohort, p: off.profile, hours: 2 })).status, 200); assert.equal((await off.request('/v1/profile', 'GET', undefined, student)).status, 200);
      assert.equal((await off.request('/v1/trace/event', 'POST', { type: 'heartbeat', idle_ms: 1000 }, student)).status < 300, true, 'the existing 45 s heartbeat is unchanged'); assert.equal((await off.request('/v1/classroom/shares', 'GET', undefined, student)).status, 200);
      const issuerJti = (await (await import('../src/lib/tokens.ts')).verify(off.teacherToken, off.env.HPS_SIGNING_SECRET)).jti; assert.equal((await off.request('/admin/tokens/revoke', 'POST', { jti: issuerJti }, null, admin)).status, 200, 'revocation keeps its old contract when the ledger is off');
      for (const t of OPS_TABLES) assert.equal(off.db.prepare(`SELECT count(*) n FROM ${t}`).get().n, 0, t);
    });
  } finally { off.close(); }
}
const f = await localOps();
try {
  await f.freeze();
  await check('AT-32 switch ON but every per-run flag OFF (the default): a configured run observes, commands, collects, reports and sends nothing', async () => {
    assert.equal((await f.request(f.base, 'PUT', { expected_roster_revision: 0, seats: [{ seat_id: 'A1', student_id: 'student-a' }] })).status, 201); assert.deepEqual((await f.request(f.base + '/status')).json.run.flags, { ops_observe: false, ops_commands: false, ops_collect: false, ops_reports: false, ops_delivery: false, ops_distribute: false });
    assert.equal((await f.request(f.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: 1 })).json.reason, 'ops_observe_disabled'); assert.equal((await f.command('retry_diagnostics', ['A1'])).json.reason, 'ops_commands_disabled'); assert.equal((await f.request(f.base + '/control', 'PUT', { paused: true, expected_control_revision: 0 })).json.reason, 'ops_commands_disabled');
    assert.equal((await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'n1', dry_run: true })).json.reason, 'ops_collect_disabled');
  });
  await check('AT-33 rollback: turning commands off leaves queued work to expire by TTL, never delivers it, and keeps receipts and audit readable', async () => {
    assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'student-a' }], 1, { flags: { ops_observe: true, ops_commands: true } })).status, 200); const a1 = (await f.pair('A1', 2, 1)).conn.json;
    const done = (await f.command('retry_diagnostics', ['A1'], { expected_roster_revision: 2 })).json, got = (await f.sync(a1.credential, [], 1)).json.commands[0]; for (const s of ['accepted', 'running', 'succeeded']) await f.sync(a1.credential, [], 1, { receipts: [f.receipt(got, s, s === 'succeeded' ? 'token_ok' : '')] });
    const pending = (await f.command('restart_preview', ['A1'], { expected_roster_revision: 2 })).json; assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'student-a' }], 2, { flags: { ops_commands: false }, lesson: undefined })).status, 200);
    assert.deepEqual((await f.sync(a1.credential, [], 1)).json.commands, [], 'rollback stops delivery at once'); f.db.prepare('UPDATE ops_command_targets SET expires_at=1 WHERE command_id=?').run(pending.command.id);
    assert.equal((await f.request(f.base + '/commands/' + pending.command.id)).json.targets[0].state, 'expired'); assert.deepEqual([(await f.request(f.base + '/commands/' + done.command.id)).json.targets[0].state, (await f.request(f.base + '/commands/' + done.command.id)).json.targets[0].result_code], ['succeeded', 'token_ok']);
    assert.ok(f.db.prepare("SELECT count(*) n FROM ops_audit WHERE action LIKE 'command_%'").get().n >= 3); assert.equal((await f.sync(a1.credential, [f.event(1, 'runtime', { status: 'idle' })], 1)).status, 200, 'observation keeps working while commands are rolled back');
  });
} finally { f.close(); }
{
  const N = 100, ROUNDS = 12, load = await localOps();
  try {
    await load.freeze(); const { setRoster } = await import('../src/lib/kv.ts'); const ids = Array.from({ length: N }, (_, i) => 'load-' + String(i + 1).padStart(3, '0')); await setRoster(load.env.HPS_KV, load.cohort, ids);
    assert.equal((await load.configure(ids.map((u, i) => ({ seat_id: 'S' + String(i + 1).padStart(3, '0'), student_id: u })), 0, { flags: { ops_observe: true, ops_commands: true } })).status, 201);
    const creds = []; for (let i = 0; i < N; i++) { const p = await load.request(load.base + '/pairings', 'POST', { seat_id: 'S' + String(i + 1).padStart(3, '0'), roster_revision: 1 }); const c = await load.request('/v1/classroom/ops/connect', 'POST', { ticket: p.json.ticket, app_instance_id: 'inst-' + String(i).padStart(8, '0'), boot_id: 'boot-' + String(i).padStart(8, '0'), protocol: 1, capabilities: ['observe', 'commands', 'retry_diagnostics'] }, null, { 'cf-connecting-ip': '10.0.' + (i % 250) + '.' + i }); assert.equal(c.status, 201, c.raw); creds.push(c.json.credential); }
    await check(`AT-25/34 synthetic: ${N} seats × ${ROUNDS} polls with 20% dropping out and returning, bulk command to 30, two instructors reading — roster stays whole, no cross-seat leak, idle polls do not write`, async () => {
      const times = [], statusTimes = [], seq = new Array(N).fill(0), sync = (i, events = []) => load.request('/v1/classroom/ops/sync', 'POST', { schema_version: 1, app_instance_id: 'inst-' + String(i).padStart(8, '0'), boot_id: 'boot-' + String(i).padStart(8, '0'), events, sample: { idle_ms: 1000, observed_at: Date.now() } }, creds[i]);
      for (let i = 0; i < N; i++) await sync(i, [load.event(++seq[i], 'activation', { stage: 'runtime_ready' })]);
      const writesBefore = load.db.prepare('SELECT sum(revision) r FROM ops_latest_state').get().r; const t2 = await load.teacher('teacher-b');
      for (let round = 0; round < ROUNDS; round++) {
        const offline = new Set(round >= 4 && round < 8 ? Array.from({ length: N / 5 }, (_, k) => k * 5) : []);
        if (round === 6) { const bulk = await load.command('retry_diagnostics', Array.from({ length: 30 }, (_, k) => 'S' + String(k + 1).padStart(3, '0'))); assert.equal(bulk.status, 202); assert.equal(bulk.json.targets.length, 30); }
        await Promise.all(Array.from({ length: N }, async (_, i) => { if (offline.has(i)) return; const t = performance.now(); const events = round === 8 && offline.size === 0 && i % 5 === 0 ? [load.event(++seq[i], 'runtime', { status: 'running' })] : []; const r = await sync(i, events); times.push(performance.now() - t); assert.equal(r.status, 200); for (const c of r.json.commands) assert.ok(c.command_id); }));
        for (const tok of [load.teacherToken, t2]) { const t = performance.now(); const s = await load.request(load.base + '/status', 'GET', undefined, tok); statusTimes.push(performance.now() - t); assert.equal(s.json.seats.length, N, 'the whole roster is always listed'); }
      }
      const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)]; const idleWrites = load.db.prepare('SELECT sum(revision) r FROM ops_latest_state').get().r - writesBefore;
      // 12 rounds ≈ one minute of 5 s polling. The 45 s write floor allows at most ~2 state writes per seat for idle seats, plus the 20 event writes.
      assert.ok(idleWrites <= N * 2 + 20, `state writes stayed bounded: ${idleWrites}`); const cmds = load.db.prepare("SELECT state,count(*) n FROM ops_command_targets GROUP BY state").all(); assert.deepEqual(cmds.map((c) => c.state), ['leased'], 'each of the 30 targets was handed to its own seat once');
      assert.equal(load.db.prepare('SELECT count(*) n FROM ops_command_targets t JOIN ops_grants g ON g.id=t.grant_id WHERE g.seat_id<>t.seat_id').get().n, 0, 'no command crossed seats'); assert.equal(load.db.prepare('SELECT count(*) n FROM ops_events e JOIN ops_grants g ON g.id=e.grant_id WHERE g.seat_id<>e.seat_id').get().n, 0);
      console.log(`  synthetic only (Node+SQLite, this Mac): sync n=${times.length} p95=${p95(times).toFixed(1)}ms · status(100 seats) n=${statusTimes.length} p95=${p95(statusTimes).toFixed(1)}ms · state writes during ${ROUNDS} polls=${idleWrites}`);
    });
  } finally { load.close(); }
}
console.log(`${count} remote classroom regression/load controls passed`);
