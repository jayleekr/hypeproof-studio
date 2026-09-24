// Remote classroom operations R4 (#751) — Service layer of AT-26/27/28 with synthetic
// accounts and an in-memory R2. Real R2/D1, a real spool and a real offline laptop are
// the uploader/real-device layers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { localOps } from './harness/classroom-ops.mjs';
let count = 0; async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const f = await localOps(); const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-c' }];
const sha = (s) => createHash('sha256').update(s).digest('hex'); const admin = { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
const put = (cred, batch, rev, name, body) => f.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${batch}/${rev}/${name}`, { method: 'PUT', headers: { authorization: 'Bearer ' + cred }, body }), f.env, { waitUntil() {} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const seal = (cred, batch, rev, files) => f.request(`/v1/classroom/ops/collect/snapshots/${batch}/${rev}/seal`, 'POST', { schema: 'hps-classroom-snapshot/1', files }, cred);
const consent = (cred, yes = true, notice = 'notice-v1') => f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: yes, purpose: 'class_report', notice_version: notice }, cred);
const batch = (extra = {}, token) => f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false, ...extra }, token);
const events = (n, user = 'student-a', from = 1) => Array.from({ length: n }, (_, i) => JSON.stringify({ seq: from + i, type: 'prompt', user })).join('\n') + '\n'; const meta = JSON.stringify({ session: 's1' });
const manifest = (ev, m = meta) => [{ name: 'session.meta.json', bytes: Buffer.byteLength(m), sha256: sha(m) }, { name: 'events.jsonl', bytes: Buffer.byteLength(ev), sha256: sha(ev) }];
try {
  await f.freeze(); assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true } })).status, 201);
  const a1 = (await f.pair('A1', 1, 1)).conn.json, a2 = (await f.pair('A2', 1, 2)).conn.json;
  await check('AT-26 no consent → every learner stays on the batch with a reason, nothing is requested or stored; the profile upload flag is not consent', async () => {
    assert.equal((await batch({}, await f.teacher('fixer', ['observe', 'command']))).status, 403);
    const b = await batch(); assert.equal(b.status, 201, b.raw); assert.deepEqual(b.json.items.map((i) => [i.seat_id, i.state]), [['A1', 'consent_missing'], ['A2', 'consent_missing'], ['A3', 'consent_missing']]); assert.deepEqual([b.json.summary.roster, b.json.summary.held, b.json.summary.verified], [3, 3, 0]);
    assert.equal(f.db.prepare("SELECT count(*) n FROM ops_commands WHERE action='retry_evidence_upload'").get().n, 0); assert.equal(f.r2.size, 0);
    assert.equal((await put(a1.credential, b.json.batch.id, 1, 'events.jsonl', events(3))).json.reason, 'not_requested', 'a learner held for missing consent was never asked');
    assert.equal((await f.command('retry_evidence_upload', ['A1'], { args: { batch_id: 'x' } })).json.reason, 'action_not_allowed', 'instructors cannot name the collection action or its batch');
  });
  let b1;
  await check('AT-26 consent is per run, purpose and notice version; withdrawal and expiry stop collection; a dry run stores nothing', async () => {
    assert.equal((await consent(a1.credential)).status, 201); assert.equal((await consent(a2.credential, true, 'notice-v0')).status, 201); // A2 agreed to an older notice
    const dry = await batch({ dry_run: true }); assert.deepEqual(dry.json.items.map((i) => i.state), ['requested', 'consent_missing', 'consent_missing']); assert.equal((await put(a1.credential, dry.json.batch.id, 1, 'events.jsonl', events(2))).json.reason, 'dry_run'); assert.equal(f.db.prepare("SELECT count(*) n FROM ops_commands WHERE action='retry_evidence_upload'").get().n, 0);
    b1 = (await batch()).json; assert.deepEqual(b1.items.map((i) => i.state), ['requested', 'consent_missing', 'consent_missing']);
    const cmds = (await f.sync(a1.credential, [], 1)).json.commands; assert.deepEqual([cmds.length, cmds[0].action, cmds[0].args.batch_id], [1, 'retry_evidence_upload', b1.batch.id]); assert.equal((await f.sync(a2.credential, [], 2)).json.commands.length, 0);
    assert.equal((await put(a2.credential, b1.batch.id, 1, 'events.jsonl', events(2, 'student-b'))).status, 404); assert.equal((await put(a2.credential, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 1, 'events.jsonl', 'x')).status, 404);
    assert.equal((await put(a1.credential, b1.batch.id, 1, 'notes.txt', 'x')).status, 400); assert.equal((await put(await f.student('student-a'), b1.batch.id, 1, 'events.jsonl', 'x')).status, 401, 'the learning token is not a collection credential');
  });
  await check('AT-27 PUT 200 is not complete; manifest-only, hash mismatch and a changed file are refused; a verified receipt comes only from re-hashed bytes', async () => {
    const ev = events(5); assert.equal((await seal(a1.credential, b1.batch.id, 1, manifest(ev))).json.reason, 'manifest_only');
    assert.equal((await put(a1.credential, b1.batch.id, 1, 'session.meta.json', meta)).status, 201); assert.equal((await put(a1.credential, b1.batch.id, 1, 'events.jsonl', ev)).status, 201);
    let v = (await f.request(f.base + '/report-batches/' + b1.batch.id)).json; assert.deepEqual([v.items[0].state, v.summary.verified, v.items[0].receipt_id], ['uploading', 0, '']);
    assert.equal((await put(a1.credential, b1.batch.id, 1, 'events.jsonl', ev)).json.retry, true); assert.equal((await put(a1.credential, b1.batch.id, 1, 'events.jsonl', ev + events(1, 'student-a', 6))).json.reason, 'revision_immutable', 'the active file moved on → new revision, not an overwrite');
    const lie = manifest(ev); lie[1].sha256 = sha('something else'); const bad = await seal(a1.credential, b1.batch.id, 1, lie); assert.deepEqual([bad.status, bad.json.reason], [422, 'hash_mismatch']);
    v = (await f.request(f.base + '/report-batches/' + b1.batch.id)).json; assert.deepEqual([v.items[0].state, v.items[0].reason, v.summary.verified], ['incomplete', 'hash_mismatch', 0]); assert.equal(f.db.prepare('SELECT count(*) n FROM classroom_job_outbox').get().n, 0);
    const okr = await seal(a1.credential, b1.batch.id, 1, manifest(ev)); assert.equal(okr.status, 201, okr.raw); assert.deepEqual([okr.json.integrity, okr.json.coverage, okr.json.input_revision], ['verified', 'complete', 1]);
    assert.equal((await seal(a1.credential, b1.batch.id, 1, manifest(ev))).json.replay, true); assert.equal((await put(a1.credential, b1.batch.id, 1, 'session.meta.json', meta)).json.reason, 'revision_sealed');
    assert.equal(f.db.prepare('SELECT count(*) n FROM classroom_job_outbox').get().n, 1, 'one job per verified input, replays included');
    const view = await f.request(f.base + '/report-batches/' + b1.batch.id); assert.ok(!view.raw.includes('"type":"prompt"') && !view.raw.includes('session'), 'the instructor view carries states and digests, never content');
  });
  await check('AT-27 integrity and coverage are different answers: gaps, duplicates and legacy logs without seq are verified bytes but not complete; another learner\'s events are quarantined', async () => {
    const gap = events(2) + events(2, 'student-a', 5); for (const [name, body] of [['session.meta.json', meta], ['events.jsonl', gap]]) await put(a1.credential, b1.batch.id, 2, name, body);
    const g = await seal(a1.credential, b1.batch.id, 2, manifest(gap)); assert.deepEqual([g.json.integrity, g.json.coverage, g.json.input_revision], ['verified', 'gaps', 2]);
    assert.equal(f.db.prepare('SELECT count(*) n FROM classroom_job_outbox').get().n, 2, 'a late revision is a new input, not a silent replacement');
    const legacy = '{"type":"prompt"}\n{"type":"turn_end"}\n'; for (const [name, body] of [['session.meta.json', meta], ['events.jsonl', legacy]]) await put(a1.credential, b1.batch.id, 3, name, body); assert.equal((await seal(a1.credential, b1.batch.id, 3, manifest(legacy))).json.coverage, 'sequence_unavailable');
    const mixed = events(2) + events(1, 'student-b', 3); for (const [name, body] of [['session.meta.json', meta], ['events.jsonl', mixed]]) await put(a1.credential, b1.batch.id, 4, name, body); const q = await seal(a1.credential, b1.batch.id, 4, manifest(mixed)); assert.deepEqual([q.status, q.json.state], [422, 'quarantined']);
    const v = (await f.request(f.base + '/report-batches/' + b1.batch.id)).json; assert.equal(v.summary.verified_complete_coverage, 0);
  });
  await check('AT-27 R2 write succeeded but the row did not: reported as an orphan by reconcile, never counted as collected', async () => {
    assert.equal((await consent(a2.credential)).status, 201); const b2 = (await batch()).json; assert.equal(b2.items[1].state, 'requested');
    f.fail('INSERT INTO classroom_snapshots'); const lost = await put(a2.credential, b2.batch.id, 1, 'events.jsonl', events(2, 'student-b')); f.fail(''); assert.equal(lost.status, 500);
    f.db.prepare("UPDATE classroom_collect_items SET state='uploading',updated_at=1 WHERE batch_id=? AND seat_id='A2'").run(b2.batch.id);
    const rec = (await f.request(f.base + '/report-batches/' + b2.batch.id + '/reconcile', 'POST', {})).json; assert.deepEqual([rec.r2_orphans, rec.never_sealed], [1, ['A2']]); assert.equal(rec.view.summary.verified, 0);
    f.fail('R2 put'); const r2down = await put(a2.credential, b2.batch.id, 2, 'events.jsonl', events(2, 'student-b')); f.fail(''); assert.equal(r2down.status, 500); assert.equal(f.db.prepare('SELECT count(*) n FROM classroom_snapshots WHERE batch_id=? AND revision=2').get(b2.batch.id).n, 0);
  });
  await check('AT-28 after class: the learning token is gone, the upload-only window still takes the learner\'s own snapshot, grants nothing else, and closes', async () => {
    const b3 = (await batch()).json; f.db.prepare("UPDATE ops_grants SET expires_at=1 WHERE id=?").run(a2.grant_id); // class over: the connection's normal life ended
    assert.equal((await f.sync(a2.credential, [], 2)).status, 401, 'no status reporting, no commands after expiry');
    const ev = events(3, 'student-b'); assert.equal((await put(a2.credential, b3.batch.id, 1, 'session.meta.json', meta)).status, 201); assert.equal((await put(a2.credential, b3.batch.id, 1, 'events.jsonl', ev)).status, 201); assert.equal((await seal(a2.credential, b3.batch.id, 1, manifest(ev))).status, 201);
    assert.equal((await f.request('/v1/chat/completions', 'POST', { messages: [] }, a2.credential)).status, 401); assert.equal((await put(a2.credential, b1.batch.id, 9, 'events.jsonl', events(1))).status, 404, 'not another learner\'s batch item');
    f.db.prepare('UPDATE classroom_collect_batches SET upload_until=1 WHERE id=?').run(b3.batch.id); assert.equal((await put(a2.credential, b3.batch.id, 2, 'events.jsonl', ev)).json.reason, 'upload_window_closed');
    f.db.prepare('UPDATE class_run_ops SET ends_at=1').run(); assert.equal((await put(a2.credential, b3.batch.id, 2, 'events.jsonl', ev)).status, 401);
  });
  await check('AT-28 withdrawal leaves a tombstone: a late device outbox cannot recreate the record, and the batch row stays with its reason', async () => {
    f.db.prepare('UPDATE class_run_ops SET ends_at=?').run(Date.now() + 3600000); const before = f.r2.size; const b4 = (await batch()).json;
    assert.equal((await consent(a1.credential, false)).status, 200); assert.equal((await put(a1.credential, b4.batch.id, 1, 'events.jsonl', events(1))).json.reason, 'withdrawn'); assert.equal(f.r2.size, before);
    const b5 = (await batch()).json; assert.deepEqual([b5.items[0].seat_id, b5.items[0].state], ['A1', 'withdrawn']); assert.equal(b5.summary.roster, 3);
  });
  await check('AT-26 a child class cannot consent with a tap: only an operator-recorded verified guardian consent counts, and an instructor cannot record one', async () => {
    const kids = await localOps();
    try {
      f.db; const kp = 'sk-biopharm-kids-2026-grade-3-4-s1'; kids.db.prepare('UPDATE sessions SET profile_id=? WHERE id=?').run(kp, kids.run); const { startSession } = await import('../src/lib/kv.ts'); await startSession(kids.env.HPS_KV, kids.cohort, { session_id: kids.run, profile_id: kp, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString() });
      const t = await kids.teacher('teacher-a', undefined, kids.cohort, [kp]); assert.equal((await kids.request(kids.base, 'PUT', { expected_roster_revision: 0, seats: [{ seat_id: 'K1', student_id: 'student-a' }], flags: { ops_observe: true, ops_commands: true, ops_collect: true } }, t)).status, 201);
      const p = await kids.request(kids.base + '/pairings', 'POST', { seat_id: 'K1', roster_revision: 1 }, t); const k1 = (await kids.request('/v1/classroom/ops/connect', 'POST', { ticket: p.json.ticket, ...kids.instance(1) }, null)).json;
      assert.equal((await kids.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, k1.credential)).json.reason, 'guardian_consent_required');
      const mk = (tok) => kids.request(kids.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false }, tok); assert.equal((await mk(t)).json.items[0].state, 'guardian_consent_missing');
      const body = { class_run_id: kids.run, student_id: 'student-a', purpose: 'class_report', notice_version: 'notice-v1', basis: 'guardian_verified', evidence_ref: 'consent-form:0001', valid_hours: 24 };
      assert.notEqual((await kids.request('/admin/classroom/consents', 'POST', body, t)).status, 201, 'an issuer Bearer cannot record guardian consent'); assert.equal((await kids.request('/admin/classroom/consents', 'POST', { ...body, basis: 'adult_self' }, null, admin)).status, 400);
      assert.equal((await kids.request('/admin/classroom/consents', 'POST', body, null, admin)).status, 201); assert.equal((await mk(t)).json.items[0].state, 'requested');
    } finally { kids.close(); }
  });
  await check('existing manual upload path is untouched by all of the above', async () => {
    const { ALLOWED_UPLOAD_FILENAMES } = await import('../src/routes/logs.ts'); assert.deepEqual(ALLOWED_UPLOAD_FILENAMES, ['session.meta.json', 'events.jsonl', 'manifest.json']); assert.ok(![...f.r2.keys()].some((k) => k.startsWith('studio-logs/')));
  });
  console.log(`${count} remote classroom collection controls passed`);
} finally { f.close(); }
