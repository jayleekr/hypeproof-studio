// Remote classroom operations R1 (#751) — Service contract with synthetic accounts.
// Covers the Service+SQLite layer of AT-15~19/23/25/32. It is NOT the App, the
// browser, real D1 concurrency or a school network: those rows stay NOT RUN
// until their own layer runs (docs/testing/classroom-admin.md).
import assert from 'node:assert/strict';
import { localOps, OPS_ALL } from './harness/classroom-ops.mjs';
import * as ops from '../src/lib/classroom-ops.ts';
let count = 0; async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }

// ── instrument first: the pure verdicts must actually split their inputs ──
await check('controls: payload allowlist rejects free text and accepts the documented shapes', async () => {
  assert.equal(ops.validatePayload('error', { class: 'network', blocking: true }).ok, true);
  assert.equal(ops.validatePayload('step', { lesson_version: 'v1', status: 'free_activity' }).ok, true);
  for (const [kind, p] of [['error', { class: 'network', blocking: true, message: '학생이 쓴 프롬프트' }], ['error', { class: 'token expired!!', blocking: true }], ['error', { class: 'network', blocking: true, code: '/Users/kid/secret.html' }], ['step', { lesson_version: 'v1', step_id: 'intro', status: 'done' }], ['runtime', { status: 'idle', prompt: 'x' }], ['activation', { stage: 'token_verified', token: 'abc.def' }], ['upload', { status: 'uploaded', path: 'a.jsonl' }]]) assert.equal(ops.validatePayload(kind, p).ok, false, JSON.stringify(p));
});
await check('controls: silence is unknown, only a fresh confirmed block is red, approval wait is not a failure', async () => {
  const now = 1_000_000, slot = (value) => ({ boot_seen_at: 1, seq: 1, observed_at: now, received_at: now, actor: 'system', value });
  const base = { pairing_issued: false, connected: true, token_issued: true, grant_revoked: false };
  assert.equal(ops.attentionOf({ ...base, state: {}, last_received_at: null }, now).attention, 'unknown');
  assert.equal(ops.attentionOf({ ...base, state: { error: slot({ class: 'auth_expired', blocking: true }) }, last_received_at: now - ops.STALE_AFTER_MS - 1 }, now).attention, 'unknown');
  assert.equal(ops.attentionOf({ ...base, state: { error: slot({ class: 'auth_expired', blocking: true }) }, last_received_at: now }, now).attention, 'blocked');
  assert.equal(ops.attentionOf({ ...base, state: { error: slot({ class: 'auth_expired', blocking: true, cleared: true }) }, last_received_at: now }, now).attention, 'ok');
  assert.equal(ops.attentionOf({ ...base, state: { error: slot({ class: 'provider_rate_limit', blocking: false }) }, last_received_at: now }, now).attention, 'caution');
  assert.deepEqual(ops.attentionOf({ ...base, state: { runtime: slot({ status: 'waiting_approval' }) }, last_received_at: now }, now), { attention: 'ok', reason: 'waiting_approval' });
  assert.equal(ops.entryStage({ ...base, connected: false, state: {}, last_received_at: null }), 'token_issued');
  assert.equal(ops.entryStage({ ...base, state: { activation: slot({ stage: 'token_verified' }) }, last_received_at: now }), 'token_verified');
});
await check('controls: ack is the highest contiguous seq with explicit holes; stale boots and lower seqs never win', async () => {
  assert.deepEqual(ops.contiguousAck(0, [1, 2, 3]), { contiguous: 3, missing: [] });
  assert.deepEqual(ops.contiguousAck(2, [3, 5, 6, 9]), { contiguous: 3, missing: [[4, 4], [7, 8]] });
  assert.deepEqual(ops.contiguousAck(0, [2]), { contiguous: 0, missing: [[1, 1]] });
  const cur = { boot_seen_at: 10, seq: 5 };
  assert.equal(ops.shouldApply(cur, 10, 6), true); assert.equal(ops.shouldApply(cur, 10, 5), false); assert.equal(ops.shouldApply(cur, 9, 99), false); assert.equal(ops.shouldApply(cur, 11, 1), true);
  const seats = (n, cls) => Array.from({ length: 10 }, (_, i) => ({ seat_id: 's' + i, attention: i < n ? 'blocked' : 'ok', reason: i < n ? cls : '' }));
  assert.equal(ops.commonIncidents(seats(4, 'provider_5xx')).length, 1); assert.equal(ops.commonIncidents(seats(2, 'provider_5xx')).length, 0); assert.equal(ops.commonIncidents(seats(6, 'auth_expired')).length, 0);
});

// ── AT-32 slice: with the switch off nothing new answers and the old surface is untouched ──
{
  const off = await localOps({ enabled: false });
  try {
    await check('AT-32 switch OFF: every new route is 404, token mint and student sharing still work', async () => {
      assert.equal((await off.configure([{ seat_id: 'A1', student_id: 'student-a' }])).status, 404);
      assert.equal((await off.request(off.base + '/status')).status, 404);
      assert.equal((await off.request('/v1/classroom/ops/connect', 'POST', { ticket: 'X', ...off.instance() }, null)).status, 404);
      assert.equal((await off.request('/v1/classroom/ops/sync', 'POST', {}, 'hpsops1.x.y')).status, 404);
      const mint = await off.request('/admin/tokens/issue', 'POST', { u: 'student-a', c: off.cohort, p: off.profile, hours: 2 });
      assert.equal(mint.status, 200, mint.raw); assert.equal(off.db.prepare('SELECT count(*) n FROM ops_token_issues').get().n, 0);
      assert.equal((await off.request('/v1/classroom/shares', 'GET', undefined, await off.student())).status, 200);
    });
  } finally { off.close(); }
}

const f = await localOps();
const seats2 = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }];
try {
  await check('AT-19 operations authority is opt-in: a plain issuer, another cohort, a student and a forged scope are refused', async () => {
    assert.equal((await f.configure(seats2, 0, {}, await f.teacher('teacher-plain', null))).status, 403);
    assert.equal((await f.configure(seats2, 0, {}, await f.teacher('teacher-observer', ['observe']))).status, 403);
    assert.equal((await f.configure(seats2, 0, {}, await f.teacher('teacher-x', undefined, 'other-cohort'))).status, 403);
    assert.equal((await f.configure(seats2, 0, {}, await f.student())).status, 403);
    assert.equal((await f.configure(seats2, 0, {}, await f.teacher('teacher-p', undefined, f.cohort, ['other-profile']))).status, 403);
    assert.equal((await f.configure(seats2, 0, {}, null)).status, 401);
    assert.equal(f.db.prepare('SELECT count(*) n FROM class_run_ops').get().n, 0);
    const minted = await f.request('/admin/issuers', 'POST', { instructor: 'child', days: 1, scopes: [{ cohort: f.cohort, profiles: [f.profile], ops: ['shell'] }] }, null, { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') });
    assert.equal(minted.status, 400, minted.raw);
    // A Bearer minter cannot hand out operations authority it does not hold.
    const { issueIssuer } = await import('../src/lib/tokens.ts'); const { TEST_SECRET } = await import('./harness/index.mjs');
    const minter = (await issueIssuer({ issuer: 'lead', scopes: [{ cohort: f.cohort, profiles: [f.profile], max_hours: 24, ops: ['observe'] }], can_issue_issuers: true }, 1, TEST_SECRET)).token;
    const child = (ops) => f.request('/admin/issuers', 'POST', { instructor: 'child', days: 1, scopes: [{ cohort: f.cohort, profiles: [f.profile], max_hours: 24, ops }] }, minter);
    assert.equal((await child(['observe', 'reset'])).status, 403); assert.equal((await child(['observe'])).status, 200);
  });
  await check('AT-17 the run pins a confirmed lesson version; drafts, unknown versions and client-supplied steps are refused', async () => {
    assert.equal((await f.configure(seats2)).status, 409);
    assert.equal((await f.configure(seats2, 0, { lesson: { course_id: 'ops-course', version: 'm2026.09.18-1', steps: ['anything'] } })).status, 400);
    await f.freeze(); assert.equal(f.db.prepare('SELECT count(*) n FROM class_run_ops').get().n, 0);
  });
  await check('AT-16 run snapshot: roster-only students, CAS on revision, unknown flags and non-roster students refused', async () => {
    assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'ghost' }])).status, 409);
    assert.equal((await f.configure(seats2, 0, { flags: { ops_shell: true } })).status, 400);
    assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A1', student_id: 'student-b' }])).status, 400);
    assert.equal((await f.request(`/admin/cohorts/${f.cohort}/classroom/runs/no-such-session`, 'PUT', { expected_roster_revision: 0, seats: seats2 })).status, 404);
    const both = await Promise.all([f.configure(seats2), f.configure(seats2)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
    assert.equal(f.db.prepare('SELECT count(*) n FROM class_run_seats').get().n, 2);
    const s = await f.request(f.base + '/status'); assert.equal(s.status, 200, s.raw); assert.equal(s.headers.get('cache-control'), 'no-store');
    // Both seats are listed before any device, token or signal exists; the cumulative roster's other ids are not.
    assert.deepEqual(s.json.seats.map((x) => [x.seat_id, x.entry_stage, x.signal, x.attention]), [['A1', 'unregistered', 'none', 'unknown'], ['A2', 'unregistered', 'none', 'unknown']]);
    assert.ok(!s.raw.includes('legacy-test-seat')); assert.equal(s.json.roster.total, 2);
    assert.equal((await f.request(f.base + '/status', 'GET', undefined, await f.teacher('teacher-plain', null))).status, 403);
  });
  let credential, conn;
  await check('AT-15 pairing: ticket is single-use, expiring, seat-bound; issuance is not activation', async () => {
    assert.equal((await f.request(f.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: 99 })).status, 409);
    assert.equal((await f.request(f.base + '/pairings', 'POST', { seat_id: 'Z9', roster_revision: 1 })).status, 404);
    const expired = await f.request(f.base + '/pairings', 'POST', { seat_id: 'A2', roster_revision: 1 });
    f.db.prepare('UPDATE ops_grants SET expires_at=1 WHERE id=?').run(expired.json.pairing_id);
    assert.equal((await f.request('/v1/classroom/ops/connect', 'POST', { ticket: expired.json.ticket, ...f.instance(2) }, null)).status, 403);
    assert.equal((await f.request('/v1/classroom/ops/connect', 'POST', { ticket: 'AAAA-BBBB-CCCC', ...f.instance() }, null)).status, 403);
    const superseded = await f.request(f.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: 1 });
    const mint = await f.request('/admin/tokens/issue', 'POST', { u: 'student-a', c: f.cohort, p: f.profile, hours: 2 }); assert.equal(mint.status, 200, mint.raw);
    let s = await f.request(f.base + '/status'); assert.equal(s.json.seats[0].entry_stage, 'token_issued'); assert.equal(s.json.seats[0].token.issue_id, mint.json.jti); assert.ok(!s.raw.includes(mint.json.token));
    const p = await f.pair('A1', 1); conn = p.conn; assert.equal(conn.status, 201, conn.raw); credential = conn.json.credential;
    assert.equal((await f.request('/v1/classroom/ops/connect', 'POST', { ticket: superseded.json.ticket, ...f.instance() }, null)).status, 403);
    // The same ticket twice, in parallel and afterwards: exactly the one connection above exists.
    assert.equal((await f.request('/v1/classroom/ops/connect', 'POST', { ticket: p.pairing.ticket, ...f.instance() }, null)).status, 403);
    assert.equal(f.db.prepare("SELECT count(*) n FROM ops_grants WHERE kind='connection'").get().n, 1);
    assert.ok(!f.db.prepare('SELECT group_concat(secret_hash) h FROM ops_grants').get().h.includes(p.pairing.ticket));
    s = await f.request(f.base + '/status'); assert.equal(s.json.seats[0].entry_stage, 'token_issued'); assert.equal(s.json.seats[0].signal, 'none'); assert.equal(s.json.seats[0].token.app_verified, 'unknown');
    await f.sync(credential, [f.event(1, 'activation', { stage: 'token_verified', token_jti: mint.json.jti })]);
    s = await f.request(f.base + '/status'); assert.equal(s.json.seats[0].entry_stage, 'token_verified'); assert.equal(s.json.seats[0].token.app_verified, 'matches_issue');
    await f.sync(credential, [f.event(2, 'activation', { stage: 'class_entered' }), f.event(3, 'activation', { stage: 'runtime_ready' })]);
    s = await f.request(f.base + '/status'); assert.equal(s.json.seats[0].entry_stage, 'runtime_ready'); assert.equal(s.json.counts.runtime_ready, 1);
    assert.equal(s.json.seats[1].entry_stage, 'unregistered');
  });
  await check('AT-19 the operations credential is not a student token, and a student token is not a credential', async () => {
    for (const path of ['/v1/profile', '/v1/classroom/shares']) assert.equal((await f.request(path, 'GET', undefined, credential)).status, 401);
    assert.equal((await f.request('/v1/chat/completions', 'POST', { messages: [] }, credential)).status, 401);
    assert.equal((await f.sync(await f.student())).status, 401);
    assert.equal((await f.sync(credential.slice(0, -3) + 'AAA')).status, 401);
    assert.equal((await f.sync('hpsops1.' + crypto.randomUUID() + '.' + credential.split('.')[2])).status, 401);
  });
  await check('AT-17 step events: pinned lesson, duplicates, reordering, conflicting resend, unknown step and free activity', async () => {
    const step = (seq, step_id, status, v = f.lesson.version) => f.event(seq, 'step', { lesson_version: v, step_id, status });
    const six = step(6, 'build', 'in_progress');
    let r = await f.sync(credential, [six]); assert.equal(r.status, 200, r.raw); assert.deepEqual(r.json.ack, { boot_id: f.instance().boot_id, contiguous_seq: 3, missing: [[4, 5]] });
    let s = await f.request(f.base + '/status'); assert.equal(s.json.seats[0].step.step_id, 'build'); assert.ok(s.json.seats[0].step.received_at >= s.json.seats[0].step.observed_at - 5000);
    // Older seqs arriving late fill the hole but do not move the board backwards.
    r = await f.sync(credential, [step(4, 'intro', 'in_progress'), step(5, 'intro', 'submitted')]); assert.equal(r.json.ack.contiguous_seq, 6);
    s = await f.request(f.base + '/status'); assert.deepEqual([s.json.seats[0].step.step_id, s.json.seats[0].step.status], ['build', 'in_progress']);
    r = await f.sync(credential, [six]); assert.equal(r.status, 200); assert.deepEqual(r.json.quarantined, []);
    r = await f.sync(credential, [{ ...six, payload: { ...six.payload, status: 'reviewed' } }]); assert.deepEqual(r.json.quarantined, [6]);
    s = await f.request(f.base + '/status'); assert.equal(s.json.seats[0].step.status, 'in_progress');
    r = await f.sync(credential, [step(7, 'review', 'submitted', 'm2026.09.18-2'), step(8, 'not-a-step', 'submitted'), f.event(9, 'step', { lesson_version: f.lesson.version, step_id: 'review', status: 'submitted', note: '완료했어요' })]);
    assert.deepEqual(r.json.quarantined, [7, 8]); assert.deepEqual(r.json.rejected.map((x) => x.seq), [9]); assert.equal(r.json.ack.contiguous_seq, 9);
    assert.ok(!f.db.prepare('SELECT group_concat(payload_json) p FROM ops_events').get().p.includes('완료했어요'));
    s = await f.request(f.base + '/status'); assert.equal(s.json.seats[0].step.step_id, 'build');
    r = await f.sync(credential, [f.event(10, 'step', { lesson_version: f.lesson.version, status: 'free_activity' })]);
    s = await f.request(f.base + '/status'); assert.equal(s.json.seats[0].step.status, 'free_activity');
    // Runtime chatter never becomes step completion.
    await f.sync(credential, [f.event(11, 'runtime', { status: 'idle' })]); s = await f.request(f.base + '/status'); assert.equal(s.json.seats[0].step.status, 'free_activity');
  });
  await check('AT-18 errors: cause is named by the app, only confirmed blocks are red, shared causes are grouped', async () => {
    await f.sync(credential, [f.event(12, 'error', { class: 'auth_signature', code: 'http_401', request_id: 'req-1234-abcd', blocking: true })]);
    let s = await f.request(f.base + '/status'); assert.deepEqual([s.json.seats[0].attention, s.json.seats[0].reason], ['blocked', 'auth_signature']); assert.equal(s.json.counts.blocked, 1);
    await f.sync(credential, [f.event(13, 'error', { class: 'auth_signature', blocking: true, cleared: true }), f.event(14, 'runtime', { status: 'waiting_approval' })]);
    s = await f.request(f.base + '/status'); assert.deepEqual([s.json.seats[0].attention, s.json.seats[0].reason], ['ok', 'waiting_approval']);
    f.db.prepare('UPDATE ops_latest_state SET last_received_at=1').run();
    s = await f.request(f.base + '/status'); assert.deepEqual([s.json.seats[0].attention, s.json.seats[0].signal], ['unknown', 'stale']); assert.equal(s.json.incidents.length, 0);
  });
  await check('AT-25 sync is cheap and honest: idle polls skip writes, a failed store is not acked, oversized batches are refused', async () => {
    await f.sync(credential, [], 1, { sample: { idle_ms: 1000, observed_at: Date.now() } });
    const before = f.db.prepare('SELECT revision FROM ops_latest_state').get().revision;
    for (let i = 0; i < 3; i++) assert.equal((await f.sync(credential, [], 1, { sample: { idle_ms: 2000 + i, observed_at: Date.now() } })).status, 200);
    assert.equal(f.db.prepare('SELECT revision FROM ops_latest_state').get().revision, before);
    f.fail('INSERT INTO ops_events'); const lost = await f.sync(credential, [f.event(15, 'runtime', { status: 'running' })]); f.fail('');
    assert.equal(lost.status, 503); assert.equal(lost.json.ack, undefined); assert.equal(f.db.prepare('SELECT count(*) n FROM ops_events WHERE seq=15').get().n, 0);
    assert.equal((await f.sync(credential, Array.from({ length: 101 }, (_, i) => f.event(100 + i, 'runtime', { status: 'idle' })))).status, 400);
    assert.equal((await f.sync(credential, [f.event(20, 'runtime', { status: 'idle' }), f.event(5000, 'runtime', { status: 'idle' })])).status, 400);
    assert.equal((await f.sync(credential, [], 1, { sample: { idle_ms: 1, observed_at: 1, window_title: 'x' } })).status, 400);
    const r = await f.sync(credential); assert.ok([5000, 30000, 60000].includes(r.json.poll_after_ms)); assert.deepEqual(r.json.commands, []);
  });
  await check('AT-23 device replacement, token re-issue, seat reassignment and issuer revocation close the old authority', async () => {
    const epoch1 = conn.json.connection_epoch;
    await f.request('/admin/tokens/issue', 'POST', { u: 'student-a', c: f.cohort, p: f.profile, hours: 2 });
    assert.equal((await f.sync(credential)).json.connection_epoch, epoch1 + 1);
    const second = (await f.pair('A1', 1, 2)).conn; assert.equal(second.status, 201); assert.ok(second.json.connection_epoch > epoch1 + 1);
    const old = await f.sync(credential); assert.equal(old.status, 401); assert.equal(old.json.reason, 'ops_grant_revoked');
    // Seat A1 passes to student-c: the previous student's board state must not be shown under the new one.
    const moved = await f.configure([{ seat_id: 'A1', student_id: 'student-c' }, { seat_id: 'A2', student_id: 'student-b' }], 1); assert.equal(moved.status, 200, moved.raw);
    assert.equal((await f.sync(second.json.credential, [], 2)).status, 401);
    let s = await f.request(f.base + '/status'); assert.deepEqual([s.json.seats[0].student_id, s.json.seats[0].entry_stage, s.json.seats[0].step], ['student-c', 'unregistered', null]);
    assert.deepEqual(s.json.seat_history.map((h) => [h.seat_id, h.student_id, h.replaced_reason]), [['A1', 'student-a', 'student_changed']]);
    const third = (await f.pair('A1', 2, 3)).conn; assert.equal(third.status, 201);
    await f.sync(third.json.credential, [f.event(1, 'runtime', { status: 'running' })], 3);
    s = await f.request(f.base + '/status'); assert.equal(s.json.seats[0].runtime.status, 'running'); assert.equal(s.json.seats[0].step, null);
    const { verify } = await import('../src/lib/tokens.ts'); const issuer = await verify(f.teacherToken, f.env.HPS_SIGNING_SECRET);
    f.fail('UPDATE ops_grants SET state=\'revoked\',revoked_at=?,revoked_reason=\'issuer_revoked\'');
    const half = await f.request('/admin/tokens/revoke', 'POST', { jti: issuer.jti }, null, { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') }); f.fail('');
    assert.equal(half.status, 500); assert.equal(half.json.ok, false);
    const done = await f.request('/admin/tokens/revoke', 'POST', { jti: issuer.jti }, null, { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') });
    assert.equal(done.status, 200, done.raw); assert.equal((await f.sync(third.json.credential, [], 3)).status, 401); assert.equal((await f.request(f.base + '/status')).status, 401);
  });
  await check('AT-25 flag rollback: turning observation off stops sync and pairing without touching stored rows', async () => {
    const t = await f.teacher('teacher-b'); const rev = f.db.prepare('SELECT roster_revision r FROM class_run_ops').get().r;
    const fresh = await f.request(f.base + '/pairings', 'POST', { seat_id: 'A2', roster_revision: rev }, t); assert.equal(fresh.status, 201, fresh.raw);
    const c2 = await f.request('/v1/classroom/ops/connect', 'POST', { ticket: fresh.json.ticket, ...f.instance(4) }, null); assert.equal(c2.status, 201);
    const events = f.db.prepare('SELECT count(*) n FROM ops_events').get().n;
    assert.equal((await f.configure([{ seat_id: 'A1', student_id: 'student-c' }, { seat_id: 'A2', student_id: 'student-b' }], rev, { flags: { ops_observe: false } }, t)).status, 200);
    const r = await f.sync(c2.json.credential, [f.event(1, 'runtime', { status: 'idle' })], 4); assert.equal(r.status, 403); assert.equal(r.json.reason, 'ops_observe_disabled'); assert.equal(r.json.poll_after_ms, 60000);
    assert.equal((await f.request(f.base + '/pairings', 'POST', { seat_id: 'A2', roster_revision: rev + 1 }, t)).status, 403);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ops_events').get().n, events);
  });
  await check('no token, ticket or credential is stored or audited', async () => {
    const dump = ['ops_grants', 'ops_audit', 'ops_events', 'ops_latest_state', 'ops_token_issues'].map((t) => JSON.stringify(f.db.prepare('SELECT * FROM ' + t).all())).join('\n');
    assert.ok(!dump.includes('hpsops1.')); assert.ok(!dump.includes(credential.split('.')[2])); assert.ok(!/[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{40,}/.test(dump));
  });
  await check('review #1120: one NAT address pairs 100 seats, only failed tickets spend the rate budget', async () => {
    const nat = await localOps(); try {
      await nat.freeze(); const seats = Array.from({ length: 100 }, (_, i) => ({ seat_id: `S${i + 1}`, student_id: `student-${i + 1}` }));
      const { setRoster } = await import('../src/lib/kv.ts'); await setRoster(nat.env.HPS_KV, nat.cohort, seats.map((x) => x.student_id));
      assert.equal((await nat.configure(seats)).status, 201);
      for (const seat of seats) { const r = await nat.pair(seat.seat_id, 1); assert.equal(r.conn.status, 201, `${seat.seat_id}: ${r.conn.raw}`); }
      const guess = () => nat.request('/v1/classroom/ops/connect', 'POST', { ticket: 'AAAA-BBBB-CCCC', ...nat.instance(1) }, null);
      for (let i = 0; i < 30; i++) assert.equal((await guess()).status, 403);
      const limited = await guess(); assert.equal(limited.status, 429); assert.equal(limited.json.reason, 'rate_limited');
      // A valid ticket is refused too while the address is blocked: the guesser cannot keep probing.
      const p = await nat.request(nat.base + '/pairings', 'POST', { seat_id: 'S1', roster_revision: 1 });
      assert.equal((await nat.request('/v1/classroom/ops/connect', 'POST', { ticket: p.json.ticket, ...nat.instance(2) }, null)).status, 429);
    } finally { nat.close(); }
  });
  await check('review #1120: a failed epoch advance is reported, never hidden, and never fails the mint', async () => {
    const e = await localOps(); try {
      await e.freeze(); assert.equal((await e.configure([{ seat_id: 'A1', student_id: 'student-a' }])).status, 201); await e.pair('A1', 1);
      const okMint = await e.request('/admin/tokens/issue', 'POST', { u: 'student-a', c: e.cohort, p: e.profile, hours: 2 }); assert.deepEqual(okMint.json.ops, { epoch_advanced: true });
      e.fail('connection_epoch=connection_epoch+1');
      const mint = await e.request('/admin/tokens/issue', 'POST', { u: 'student-a', c: e.cohort, p: e.profile, hours: 2 }); e.fail(null);
      assert.equal(mint.status, 200, mint.raw); assert.ok(mint.json.token); assert.deepEqual(mint.json.ops, { epoch_advanced: false });
    } finally { e.close(); }
  });
  await check('review #1120: the ack cursor advances for a batch of rejected events without a state write', async () => {
    const k = await localOps(); try {
      await k.freeze(); assert.equal((await k.configure([{ seat_id: 'A1', student_id: 'student-a' }])).status, 201); const cred = (await k.pair('A1', 1)).conn.json.credential;
      assert.equal((await k.sync(cred, [k.event(1, 'runtime', { status: 'ready' })])).status, 200);
      const r = await k.sync(cred, [k.event(2, 'runtime', { status: 'ready', secret: 'x' }), k.event(3, 'runtime', { status: 'ready', secret: 'y' })]);
      assert.equal(r.status, 200, r.raw); assert.equal(r.json.ack.contiguous_seq, 3); assert.equal(r.json.rejected.length, 2);
      assert.equal(k.db.prepare('SELECT contiguous_seq n FROM ops_device_connections').get().n, 3, 'stored cursor follows the acked stream');
    } finally { k.close(); }
  });
  await check('AT-15/23 lesson participant mint records issuance and fences only that student on reissue', async () => {
    const e = await localOps(); try {
      const { issueIssuer, verify } = await import('../src/lib/tokens.ts');
      const teacher = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: e.cohort, profiles: [e.profile], ops: OPS_ALL }] }, 4, e.env.HPS_SIGNING_SECRET)).token;
      await e.freeze(); assert.equal((await e.configure(seats2)).status, 201);
      const path = `/admin/cohorts/${e.cohort}/authoring/${e.lesson.course_id}/versions/${e.lesson.version}/participants`;
      const mint = () => e.request(path, 'POST', { user: 'student-a', hours: 1 }, teacher);
      const first = await mint(); assert.equal(first.status, 200, first.raw);
      const payload = await verify(first.json.token, e.env.HPS_SIGNING_SECRET);
      assert.deepEqual(payload.lesson, first.json.lesson, 'lesson binding is preserved');
      const before = await e.request(e.base + '/status');
      assert.equal(before.json.seats[0].entry_stage, 'token_issued');
      assert.equal(before.json.seats[0].token.issue_id, payload.jti);
      assert.ok(!before.raw.includes(first.json.token));
      const a = (await e.pair('A1', 1)).conn.json, b = (await e.pair('A2', 1, 2)).conn.json;
      const second = await mint(); assert.equal(second.status, 200, second.raw);
      assert.deepEqual(second.json.ops, { epoch_advanced: true });
      assert.equal((await e.sync(a.credential)).json.connection_epoch, a.connection_epoch + 1);
      assert.equal((await e.sync(b.credential, [], 2)).json.connection_epoch, b.connection_epoch);
      assert.equal(e.db.prepare('SELECT count(*) n FROM ops_token_issues').get().n, 2);
      e.fail('connection_epoch=connection_epoch+1');
      const degraded = await mint(); e.fail(null);
      assert.equal(degraded.status, 200, degraded.raw); assert.ok(degraded.json.token);
      assert.deepEqual(degraded.json.ops, { epoch_advanced: false }, 'storage outage is reported without blocking lesson entry');
    } finally { e.close(); }
  });
  await check('AT-32 lesson participant mint with operations OFF preserves the existing route without a ledger', async () => {
    const e = await localOps({ enabled: false }); try {
      const { issueIssuer } = await import('../src/lib/tokens.ts');
      const teacher = (await issueIssuer({ issuer: 'teacher-a', scopes: [{ cohort: e.cohort, profiles: [e.profile] }] }, 4, e.env.HPS_SIGNING_SECRET)).token;
      await e.freeze();
      const minted = await e.request(`/admin/cohorts/${e.cohort}/authoring/${e.lesson.course_id}/versions/${e.lesson.version}/participants`, 'POST', { user: 'student-a', hours: 1 }, teacher);
      assert.equal(minted.status, 200, minted.raw); assert.ok(minted.json.token); assert.equal(minted.json.ops, undefined);
      assert.equal(e.db.prepare('SELECT count(*) n FROM ops_token_issues').get().n, 0);
    } finally { e.close(); }
  });
  console.log(`${count} remote classroom operations controls passed`);
} finally { f.close(); }
