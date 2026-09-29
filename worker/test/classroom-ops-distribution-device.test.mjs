// Remote classroom operations (#751, U2) — the REAL device inbox (extension sources: sync loop, InboxSession, InboxStore on
// a real directory) against the REAL Service routes + SQLite ledger, in-process. It lives in the Service suite because it
// needs the Service's dependencies. Not a real Studio window, a real network or a real D1 — those are the browser e2e, the
// Mac run and classroom-ops-distribution-d1.test.mjs.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localOps, OPS_ALL } from './harness/classroom-ops.mjs';
import * as ops from '../../extensions/hypeproof-chat/src/classroomOps.ts';
import { INBOX_CAPABILITY } from '../../extensions/hypeproof-chat/src/classroomInbox.ts';
import { InboxSession, InboxStore, inboxDir } from '../../extensions/hypeproof-chat/src/classroomInboxStore.ts';

let n = 0; const ok = (name) => { n++; console.log('  ✓ ' + name); };
const root = mkdtempSync(path.join(tmpdir(), 'hps-inbox-device-')), f = await localOps(), KEY = () => crypto.randomUUID();
try {
  await f.freeze(); const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }];
  assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_distribute: true } })).status, 201); // commands OFF on purpose: the seat lease must still be taken
  const X = await f.teacher('teacher-x', [...OPS_ALL, 'distribute']), caps = ['observe', INBOX_CAPABILITY];
  const memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; };
  let id = 0;
  async function device(seat, instanceNo, conn, o = {}) {
    const dir = inboxDir(root, { cohort: conn.student.c, run: conn.class_run_id, seat: conn.seat_id, student: conn.student.u }), store = new InboxStore(dir); let alive = true, drop = 0;
    const inbox = new InboxSession({ store, alive: () => alive, clock: { mono: () => performance.now(), wall: () => Date.now() } });
    const outbox = await ops.OpsOutbox.open(memory(), conn.grant_id, 'stream-' + seat + '-' + instanceNo, () => Date.now(), () => `event-dist-${String(++id).padStart(6, '0')}`);
    const inst = f.instance(instanceNo, caps);
    const loop = ops.startOpsSync({ outbox, appInstanceId: inst.app_instance_id, capabilities: caps, distribution: inbox, sample: () => ({ idle_ms: 1 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() { alive = false; },
      post: async (body) => { const sent = { ...body, boot_id: inst.boot_id }; const r = await f.request('/v1/classroom/ops/sync', 'POST', sent, conn.credential); o.seen?.(sent, r); if (drop-- > 0) return { status: 0 }; return { status: r.status, body: r.json }; } });
    return { loop, store, dir, lose: (k) => { drop = k; }, cards: async () => (await store.read()).cards.map((c) => [c.title, c.revision, c.withdrawn ? 'withdrawn' : c.body]), end: () => { alive = false; loop.stop(); } };
  }
  const connA = (await f.pair('A1', 1, 1, caps)).conn.json, connB = (await f.pair('A2', 1, 2, caps)).conn.json;
  const bodiesB = []; const A = await device('A1', 1, connA), B = await device('A2', 2, connB, { seen: (sent, r) => bodiesB.push(r.json) });
  const save = (b) => f.request(f.base + '/contents', 'POST', { idempotency_key: KEY(), ...b }, X), send = (o) => f.request(f.base + '/distributions', 'POST', { idempotency_key: KEY(), expected_roster_revision: 1, ...o }, X);
  const view = async (d) => (await f.request(f.base + '/distributions/' + d, 'GET', undefined, X)).json, spin = async (dev, k = 4) => { for (let i = 0; i < k; i++) await dev.loop.tick(); };
  const now0 = () => f.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run();

  const v1 = (await save({ kind: 'notice', title: '공지', body: '첫 번째 판' })).json, d1 = (await send({ object_id: v1.object_id, revision: 1, content_hash: v1.content_hash, targets: ['A1'] })).json.distribution;
  await spin(A); await spin(B);
  assert.deepEqual(await A.cards(), [['공지', 1, '첫 번째 판']]); assert.deepEqual((await view(d1.id)).targets.map((t) => [t.seat_id, t.status.phase, t.status.card]), [['A1', 'reflected', 'present']]);
  assert.deepEqual(await B.cards(), []); assert.ok(bodiesB.every((b) => b.distribution === undefined), 'the unselected learner\'s device was never sent a distribution block'); assert.equal(readdirSync(root + '/classroom-inbox/' + f.cohort.replace(/[^A-Za-z0-9_-]/g, '_') + '/' + f.run).join(), 'A1.student-a', 'and has no inbox directory at all');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ops_seat_leases').get().n, 1, 'the seat lease is taken for distribution even with commands switched off');
  ok('selected A1 / not selected A2 through the real sync loop: stored, read back, reported — and nothing anywhere for A2');

  // lost responses: the Service offers again, the device writes nothing twice and the receipt arrives once
  const v2 = (await save({ kind: 'notice', title: '공지', body: '두 번째 판', object_id: v1.object_id, expected_latest_revision: 1 })).json, d2 = (await send({ object_id: v1.object_id, revision: 2, content_hash: v2.content_hash, targets: ['A1'] })).json.distribution;
  A.lose(2); await spin(A, 2); assert.deepEqual(await A.cards(), [['공지', 1, '첫 번째 판']], 'two answers were lost on the way: nothing changed yet'); assert.equal((await view(d2.id)).targets[0].status.phase, 'offered', 'offered ≠ received');
  now0(); await spin(A); assert.deepEqual(await A.cards(), [['공지', 2, '두 번째 판']]); assert.equal((await view(d2.id)).targets[0].status.phase, 'reflected'); assert.equal((await A.store.current()).index.journal.length, 0, 'every receipt was acknowledged');
  ok('lost responses: re-offered, applied once, one card (v2), receipts acknowledged');

  // restart: a NEW process (new session, same directory) shows the same card without the Service, and owes nothing
  A.end(); const A2 = await device('A1', 1, connA); assert.deepEqual(await A2.cards(), [['공지', 2, '두 번째 판']]);
  // re-login (token re-issue): the login generation moves. A third run of the SAME v2 is decided by the Service as "already held".
  const { recordTokenIssue } = await import('../src/routes/classroom-ops.ts'); await recordTokenIssue(f.env, { jti: KEY(), cohort: f.cohort, student: 'student-a', profile: f.profile, issuedBy: 'teacher-x', hours: 1 });
  const d3 = (await send({ object_id: v1.object_id, revision: 2, content_hash: v2.content_hash, targets: ['A1'] })).json.distribution; await spin(A2); assert.deepEqual((await view(d3.id)).targets.map((t) => [t.status.phase, t.status.card]), [['no_change', 'present']]);
  ok('restart keeps the card; the same revision again is "already held", not a second card');

  // the handoff case: v1 run still alive, both v2 runs withdrawn in order → the card stays for the first, comes down with the second, v1 never returns
  await f.request(`${f.base}/distributions/${d2.id}/revoke`, 'POST', { expected_row_revision: 0 }, X); await spin(A2); assert.deepEqual(await A2.cards(), [['공지', 2, '두 번째 판']], 'the other v2 run still permits what is shown');
  await f.request(`${f.base}/distributions/${d3.id}/revoke`, 'POST', { expected_row_revision: 0 }, X); await spin(A2);
  assert.deepEqual(await A2.cards(), [['', 2, 'withdrawn']], 'the last run that permitted v2 is gone: the card came down — and the un-revoked v1 run did NOT bring v1 back');
  assert.deepEqual([(await view(d1.id)).targets[0].status, (await view(d3.id)).targets[0].status.card], [{ phase: 'reflected', card: 'none', in_progress: false, can_change: false, reselectable: false }, 'withdrawn'], 'evidence of the v1 delivery stays; what is on the device now is "withdrawn", confirmed by the device');
  assert.equal((await A2.store.current()).index.journal.length, 0);
  ok('withdrawal in order: covered → withdrawn, confirmed by the device, v1 not restored');
  // The offer commit boundary, on the REAL device (reproduced on 51708c7: the run was withdrawn between the Service reading its candidates
  // and recording the offer; the item still went out, the device stored it, its receipts were refused as final and no withdrawal ever came).
  const onDisk = (dir, text) => existsSync(dir) && readdirSync(dir, { recursive: true, withFileTypes: true }).some((e) => e.isFile() && readFileSync(path.join(e.parentPath ?? e.path, e.name), 'utf8').includes(text));
  const raced = (await save({ kind: 'notice', title: '경합', body: '기록되지 않은 제안의 본문' })).json, dr = (await send({ object_id: raced.object_id, revision: 1, content_hash: raced.content_hash, targets: ['A2'] })).json.distribution;
  const inner = f.env.HPS_DB; let fired = false;
  f.env.HPS_DB = { prepare(sql) { const st = inner.prepare(sql), w = { bind(...a) { st.bind(...a); return w; }, run: () => st.run(), _run: () => st._run(), first: (...a) => st.first(...a), all: async (...a) => { const r = await st.all(...a); if (!fired && sql.includes('c.revision AS card_revision') && sql.includes('t.next_offer_at')) { fired = true; f.env.HPS_DB = inner; assert.equal((await f.request(`${f.base}/distributions/${dr.id}/revoke`, 'POST', { expected_row_revision: 0 }, X)).status, 200); } return r; } }; return w; }, batch: (s) => inner.batch(s) };
  bodiesB.length = 0; await spin(B); f.env.HPS_DB = inner; assert.equal(fired, true, 'the injection point no longer matches the SQL — fix the test before trusting it');
  assert.ok(bodiesB.every((b) => !(b.distribution?.items ?? []).length), 'the unrecorded offer never left the Service'); assert.deepEqual(await B.cards(), []); assert.equal(onDisk(B.dir, '기록되지 않은 제안의 본문'), false, 'nothing of it is on the disk');
  assert.deepEqual([(await view(dr.id)).targets[0].status.phase, (await view(dr.id)).targets[0].status.card], ['revoked', 'none'], 'the instructor sees a withdrawn run that was never on the device — which is what happened');
  // positive control: the offer WAS recorded and stored; the withdrawal lands before the receipts → the device takes it down and says so
  const held = (await save({ kind: 'notice', title: '이미 받은 공지', body: '기기가 이미 저장한 본문' })).json, dh = (await send({ object_id: held.object_id, revision: 1, content_hash: held.content_hash, targets: ['A2'] })).json.distribution;
  now0(); await B.loop.tick(); assert.deepEqual(await B.cards(), [['이미 받은 공지', 1, '기기가 이미 저장한 본문']], 'control: it is on the device'); assert.equal(onDisk(B.dir, '기기가 이미 저장한 본문'), true);
  await f.request(`${f.base}/distributions/${dh.id}/revoke`, 'POST', { expected_row_revision: 0 }, X); await spin(B);
  assert.deepEqual(await B.cards(), [['', 1, 'withdrawn']]); assert.equal(onDisk(B.dir, '기기가 이미 저장한 본문'), false, 'the body left the disk'); assert.equal((await B.store.current()).index.journal.length, 0, 'and the device owes nothing');
  assert.deepEqual([(await view(dh.id)).targets[0].status.phase, (await view(dh.id)).targets[0].status.card], ['revoked', 'withdrawn'], 'never recorded as delivered; the withdrawal is confirmed by the device');
  ok('offer commit boundary on the real device: an unrecorded offer never reaches the disk; a recorded one is withdrawn from it');
  A2.end(); B.end();
  console.log(`classroom-ops-distribution-device: ${n} checks passed`);
} finally { f.close(); rmSync(root, { recursive: true, force: true }); }
