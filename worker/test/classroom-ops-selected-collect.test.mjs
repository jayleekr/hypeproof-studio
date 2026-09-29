// Remote classroom operations (#751, U1) — AT-38: collecting the class record of SELECTED learners only.
//
// Reproduced on 2026-09-21 (remote-classroom-evidence/management-20260921/selected-collection-check.mjs): the batch route
// ignored an unknown `targets` field and answered 201 with the whole roster. An API that does not know `targets` must never
// be read as "selected collection". The positive control is small; most of this file is what must NOT happen: a seat that
// was not selected gets no command, no upload door, no R2 object and no evaluation, and nothing here ever widens to everybody.
// Synthetic accounts, SQLite and an in-memory R2. The real App half is e2e/classroom/ops-roster.mjs and the Mac run.
import assert from 'node:assert/strict';
import { localOps } from './harness/classroom-ops.mjs';
// Loaded after the harness: it registers the resolver the Service's extensionless imports need.
const { setRoster } = await import('../src/lib/kv.ts'), { normalizeCollectRequest, collectRequestCanonical } = await import('../src/lib/classroom-collect.ts'), { setEvaluatorTransport } = await import('../src/routes/classroom-reports.ts');

let count = 0; async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const KEY = () => crypto.randomUUID(), base = { roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false };

await check('controls: what a request means is decided once — legacy stays whole-roster finish, a selection is collect-only, and nothing widens', async () => {
  const n = (b) => normalizeCollectRequest({ idempotency_key: '11111111-1111-4111-8111-111111111111', ...base, ...b }, 200);
  assert.deepEqual([n({}).value.scope, n({}).value.mode, n({}).value.targets], ['roster', 'finish', []], 'positive: no targets = the class wrap-up it always was');
  assert.deepEqual([n({ targets: ['A3', 'A1'] }).value.scope, n({ targets: ['A3', 'A1'] }).value.mode, n({ targets: ['A3', 'A1'] }).value.targets], ['targets', 'collect_only', ['A1', 'A3']], 'positive: a selection, order-free');
  for (const [body, reason] of [[{ targets: [] }, 'targets_empty'], [{ target: ['A1'] }, 'unknown_field'], [{ seats: ['A1'] }, 'unknown_field'], [{ targets: ['A1', 'A1'] }, 'targets_duplicate'], [{ targets: ['A 1'] }, 'targets_invalid'], [{ targets: [7] }, 'targets_invalid'], [{ targets: 'A1' }, 'targets_invalid'], [{ targets: null }, 'targets_invalid'],
    [{ targets: ['A1'], mode: 'finish' }, 'mode_not_allowed'], [{ mode: 'collect_only' }, 'targets_required'], [{ mode: 'everything' }, 'mode_invalid'], [{ dry_run: 'yes' }, 'request_invalid']]) assert.equal(n(body).reason, reason, JSON.stringify(body));
  const ledger = await import('../src/lib/classroom-ops.ts'), mine = await import('../src/lib/classroom-collect.ts'); assert.deepEqual([mine.COLLECT_SEAT_RE.source, mine.COLLECT_KEY_RE.source], [ledger.ID_RE.source, ledger.UUIDISH_RE.source], 'seat and key shapes are the command ledger\'s');
  const c = (o) => collectRequestCanonical({ scope: 'targets', mode: 'collect_only', targets: ['A1'], purpose: 'class_report', notice_version: 'notice-v1', dry_run: false, roster_revision: 1, ...o });
  for (const o of [{ targets: ['A1', 'A3'] }, { notice_version: 'notice-v2' }, { dry_run: true }, { roster_revision: 2 }, { scope: 'roster', mode: 'finish', targets: [] }]) assert.notEqual(c(o), c({}), 'a different request is a different hash: ' + JSON.stringify(o));
});

await check('controls: the collection lifecycle table — item × device request × grace, and how each row moves over time', async () => {
  const { collectStatus, COLLECT_ACTIVE_MS, COLLECT_SETTLE_MS } = await import('../src/lib/classroom-collect.ts'), T = 1_000_000_000_000, until = T + 3_600_000;
  const at = (state, request, o = {}) => { const r = collectStatus({ state, updated_at: 'item_at' in o ? o.item_at : T, request: request ? { state: request[0], result_code: request[1] ?? '', updated_at: 'req_at' in o ? o.req_at : T } : null }, { now: o.now ?? T + 1000, upload_until: o.until ?? until }); return [r.phase, r.active, r.retryable, r.may_change, r.partial].join(' '); };
  const table = [
    // item         request                                   → phase            active retry may_change partial
    ['verified',   ['failed', 'upload_failed'], {},            'verified false false false false'],          // a failed command before a verified record is history
    ['withdrawn',  ['succeeded', 'receipt_verified'], {},      'excluded false false false false'],
    ['consent_missing', null, {},                              'excluded false false false false'],
    ['quarantined', ['succeeded'], {},                         'held false false false false'],
    ['not_connected', null, {},                                'not_delivered false true false false'],
    ['requested',  ['queued'], {},                             'awaiting_device true false true false'],
    ['requested',  ['leased'], {},                             'awaiting_device true false true false'],     // assigned by the server ≠ received by the device
    ['requested',  ['accepted'], {},                           'transferring true false true false'],
    ['uploading',  ['running'], {},                            'transferring true false true true'],
    // ── the request ENDED. What it ended as is the answer, unless a file arrived strictly AFTER it ended. ──
    // file → failure: the bytes are how that attempt went. Not "sending", from the first second (no waiting for them to age).
    ['uploading',  ['failed', 'offline_pending'], { item_at: T, req_at: T + 1000, now: T + 3000 }, 'resend_wait false true true true'],
    ['uploading',  ['failed', 'upload_refused'],  { item_at: T, req_at: T + 1000, now: T + 3000 }, 'refused false true true true'],
    ['uploading',  ['failed', 'verify_failed'],   { item_at: T, req_at: T + 1000, now: T + 3000 }, 'refused false true true true'],
    ['uploading',  ['outcome_unknown'],           { item_at: T, req_at: T + 1000, now: T + 3000 }, 'unknown false true true true'],
    ['uploading',  ['failed', 'upload_refused'],  { item_at: T - 120_000, req_at: T + 1000, now: T + 3000 }, 'refused false true true true'],
    // failure → new file: a resumed upload, for as long as the bytes are recent
    ['uploading',  ['failed', 'offline_pending'], { item_at: T + 2000, req_at: T + 1000, now: T + 3000 }, 'transferring true false true true'],
    ['uploading',  ['failed', 'upload_refused'],  { item_at: T + 2000, req_at: T + 1000, now: T + 3000 }, 'transferring true false true true'],
    ['uploading',  ['expired'],                   { item_at: T + 2000, req_at: T + 1000, now: T + 3000 }, 'transferring true false true true'],   // an older pending copy resumed after this command expired
    ['uploading',  ['outcome_unknown'],           { item_at: T + 2000, req_at: T + 1000, now: T + 3000 }, 'transferring true false true true'],
    ['uploading',  ['failed', 'offline_pending'], { item_at: T + 2000, req_at: T + 1000, now: T + 2000 + COLLECT_ACTIVE_MS }, 'resend_wait false true true true'], // …and then it went quiet again
    // an order that cannot be proven is never "in progress": same millisecond, a missing time, an unreadable time
    ['uploading',  ['failed', 'upload_refused'],  { item_at: T + 1000, req_at: T + 1000, now: T + 3000 }, 'refused false true true true'],
    ['uploading',  ['failed', 'offline_pending'], { item_at: T + 2000, req_at: null, now: T + 3000 }, 'resend_wait false true true true'],
    ['uploading',  ['failed', 'offline_pending'], { item_at: T + 2000, req_at: NaN, now: T + 3000 }, 'resend_wait false true true true'],
    ['uploading',  ['failed', 'upload_refused'],  { item_at: undefined, req_at: T + 1000, now: T + 3000 }, 'refused false true true true'],
    ['requested',  ['failed', 'nothing_recorded'], {},         'refused false true true false'],
    ['requested',  ['rejected', 'busy'], {},                   'not_delivered false true true false'],
    ['requested',  ['expired'], {},                            'not_delivered false true true false'],
    ['requested',  ['unsupported'], {},                        'not_delivered false true true false'],
    ['requested',  ['cancelled'], {},                          'not_delivered false true true false'],
    ['requested',  ['outcome_unknown'], {},                    'unknown false true true false'],
    ['requested',  ['succeeded', 'receipt_verified'], {},      'transferring true false true false'],        // "sent", verification pending — for a bounded time
    ['requested',  ['succeeded', 'receipt_verified'], { now: T + COLLECT_SETTLE_MS + 1 }, 'unknown false true true false'],
    ['incomplete', ['failed', 'hash_mismatch'], {},            'refused false true true false'],
    ['some_future_state', ['queued'], {},                      'unknown false false true false'],            // not guessed at, and not offered for retry
    // the grace window closed: nothing of THIS batch can arrive any more, whatever the command said
    ['uploading',  ['failed', 'offline_pending'], { now: until }, 'grace_over false true false true'],
    ['requested',  ['queued'], { now: until + 1 },             'grace_over false true false false'],
    ['verified',   ['failed'], { now: until + 1 },             'verified false false false false'],
  ];
  for (const [state, request, o, want] of table) assert.equal(at(state, request, o), want, `${state} × ${JSON.stringify(request)} × ${JSON.stringify(o)}`);
  // One seat over time: partial upload → the device gives up for now → the same copy resumes → verified. Status follows each step; "failed" never sticks.
  const steps = [['requested', ['queued'], {}, 'awaiting_device'], ['uploading', ['running'], { item_at: T + 500, req_at: T + 400, now: T + 600 }, 'transferring'], ['uploading', ['failed', 'offline_pending'], { item_at: T + 500, req_at: T + 900, now: T + 1000 }, 'resend_wait'] /* one tenth of a second after the failure report: already not "sending" */, ['uploading', ['failed', 'offline_pending'], { item_at: T + 200_000, req_at: T + 900, now: T + 200_500 }, 'transferring'] /* the device came back and a file arrived */, ['uploading', ['failed', 'offline_pending'], { item_at: T + 200_000, req_at: T + 900, now: T + 200_000 + COLLECT_ACTIVE_MS + 1 }, 'resend_wait'], ['verified', ['failed', 'offline_pending'], { now: T + 300_000 }, 'verified']];
  for (const [state, request, o, phase] of steps) assert.equal(at(state, request, o).split(' ')[0], phase);
});

const f = await localOps(); let evaluatorCalls = 0;
const students = ['a', 'b', 'c', 'd', 'e', 'f'].map((x, i) => ({ seat_id: 'A' + (i + 1), student_id: 'student-' + x }));
const B = f.base + '/report-batches', post = (body, token) => f.request(B, 'POST', body, token);
const consent = (cred, yes = true) => f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: yes, purpose: 'class_report', notice_version: 'notice-v1' }, cred);
const put = (cred, batch, name, body) => f.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${batch}/1/${name}`, { method: 'PUT', headers: { authorization: 'Bearer ' + cred }, body }), f.env, { waitUntil() {} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const record = (who) => [1, 2].map((seq) => JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), seq, type: seq === 1 ? 'prompt' : 'turn_end', turn_id: 't1', ...(seq === 1 ? { text: 'synthetic words of ' + who } : { status: 'ok' }) })).join('\n') + '\n';
const counts = () => ({ batches: f.db.prepare('SELECT count(*) n FROM classroom_collect_batches').get().n, commands: f.db.prepare("SELECT count(*) n FROM ops_commands WHERE action='retry_evidence_upload'").get().n, targets: f.db.prepare("SELECT count(*) n FROM ops_command_targets t JOIN ops_commands c ON c.id=t.command_id WHERE c.action='retry_evidence_upload'").get().n, r2: f.r2.size, outbox: f.db.prepare('SELECT count(*) n FROM classroom_job_outbox').get().n });
try {
  await setRoster(f.env.HPS_KV, f.cohort, students.map((s) => s.student_id)); await f.freeze();
  assert.equal((await f.configure(students, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true, ops_delivery: true } })).status, 201);
  f.env.HPS_CLASSROOM_EVALUATOR = 'service-anthropic'; f.env.ANTHROPIC_API_KEY = 'synthetic-not-a-key'; setEvaluatorTransport(async () => { evaluatorCalls++; return Response.json({ content: [{ type: 'text', text: '{"findings":[],"next_experiment":"x"}' }], usage: { input_tokens: 1, output_tokens: 1 } }); });
  // A1 A2 A3 connected + consented · A4 connected, no consent · A5 connected, consented then withdrew · A6 consented, then its connection was closed (offline)
  const conn = {}; for (const [i, s] of students.entries()) conn[s.seat_id] = (await f.pair(s.seat_id, 1, i + 1)).conn.json;
  for (const id of ['A1', 'A2', 'A3', 'A5', 'A6']) assert.equal((await consent(conn[id].credential)).status, 201);
  assert.equal((await f.request(f.base + '/grants/' + conn.A6.grant_id, 'DELETE')).status, 200, 'A6 went offline');
  assert.ok([200, 201].includes((await consent(conn.A5.credential, false)).status), 'A5 withdrew');

  await check('the reproduced defect: targets:[A1] no longer answers with the whole roster', async () => {
    const r = await post({ idempotency_key: KEY(), ...base, dry_run: true, targets: ['A1'] }); assert.equal(r.status, 201, r.raw);
    assert.deepEqual(r.json.items.map((i) => [i.seat_id, i.state]), [['A1', 'requested'], ['A2', 'not_selected'], ['A3', 'not_selected'], ['A4', 'not_selected'], ['A5', 'not_selected'], ['A6', 'not_selected']]);
    assert.deepEqual([r.json.batch.scope, r.json.batch.mode, r.json.batch.targets, r.json.summary.selected, r.json.summary.not_selected], ['targets', 'collect_only', ['A1'], 1, 5]); assert.equal(counts().commands, 0, 'a dry run asks no device');
  });

  let batch;
  await check('AT-38 selected A1+A3, not A2: only the selected seats get a command, an upload door, objects — and nobody gets an evaluation', async () => {
    const before = counts(), r = await post({ idempotency_key: KEY(), ...base, targets: ['A3', 'A1'] }); assert.equal(r.status, 201, r.raw); batch = r.json.batch.id;
    assert.deepEqual(r.json.items.filter((i) => i.state !== 'not_selected').map((i) => [i.seat_id, i.state, i.request?.state]), [['A1', 'requested', 'queued'], ['A3', 'requested', 'queued']], 'asked is "queued" — not yet received by any device');
    assert.deepEqual(f.db.prepare("SELECT t.seat_id FROM ops_command_targets t JOIN ops_commands c ON c.id=t.command_id WHERE c.idempotency_key=? ORDER BY 1").all('collect-' + batch).map((x) => x.seat_id), ['A1', 'A3']);
    assert.deepEqual((await f.sync(conn.A1.credential, [], 1)).json.commands.map((c) => [c.action, c.args.batch_id]), [['retry_evidence_upload', batch]]);
    assert.equal((await f.sync(conn.A2.credential, [], 2)).json.commands.length, 0, 'the unselected device is told nothing');
    // The unselected learner's device cannot push its record into this batch even if it tries.
    assert.deepEqual([(await put(conn.A2.credential, batch, 'events.jsonl', record('student-b'))).status, (await put(conn.A2.credential, batch, 'events.jsonl', record('student-b'))).json.reason], [404, 'not_requested']);
    for (const id of ['A1', 'A3']) { const u = await f.uploadSnapshotAs(conn[id], batch, 1, record(conn[id].student.u)); assert.equal(u.status, 201, u.raw); assert.equal(u.json.coverage, 'complete'); }
    const keys = [...f.r2.keys()]; assert.equal(keys.length, 4); assert.ok(keys.every((k) => k.includes('/student-a/') || k.includes('/student-c/')), 'objects exist for the selected learners only: ' + keys.join(' '));
    assert.ok(!keys.some((k) => /student-(b|d|e|f)\//.test(k)));
    const after = counts(); assert.deepEqual([after.commands - before.commands, after.targets - before.targets, after.outbox - before.outbox], [1, 2, 0], 'one command, two targets, NO evaluation input queued');
    const v = (await f.request(B + '/' + batch)).json; assert.deepEqual(v.items.map((i) => i.state), ['verified', 'not_selected', 'verified', 'not_selected', 'not_selected', 'not_selected']); assert.deepEqual([v.summary.selected, v.summary.verified], [2, 2]);
    // U4 — the same verdict words as recovery: `resolved` only where the SERVICE verified the receipt; an unselected seat has no verdict at all.
    assert.deepEqual(v.items.map((i) => i.outcome ?? null), ['resolved', null, 'resolved', null, null, null]);
    // Collecting is not evaluating and not sending, now or by a later click.
    for (const [path, method, body] of [['/advance', 'POST', {}], ['/jobs', 'POST', {}], ['/reports', 'GET'], ['/runner-grants', 'POST', {}], ['/recipients?template_revision=report-link-ko-1', 'GET'], ['/deliver', 'POST', { approval_id: 'x', dry_run: true }]]) { const x = await f.request(B + '/' + batch + path, method, body); assert.deepEqual([x.status, x.json.reason], [409, 'collect_only_batch'], path); }
    assert.equal(evaluatorCalls, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM classroom_report_jobs').get().n, 0);
  });

  await check('AT-38 a selection does not override consent, withdrawal or presence: each selected seat stays on the batch with its own reason', async () => {
    const before = counts(), r = await post({ idempotency_key: KEY(), ...base, targets: ['A2', 'A4', 'A5', 'A6'] }); assert.equal(r.status, 201, r.raw);
    assert.deepEqual(r.json.items.map((i) => [i.seat_id, i.state]), [['A1', 'not_selected'], ['A2', 'requested'], ['A3', 'not_selected'], ['A4', 'consent_missing'], ['A5', 'withdrawn'], ['A6', 'not_connected']]);
    const seen = (await f.request(B + '/' + r.json.batch.id)).json.items.map((i) => [i.seat_id, i.outcome ?? null]); assert.deepEqual(seen, [['A1', null], ['A2', 'pending'], ['A3', null], ['A4', 'not_executed'], ['A5', 'not_executed'], ['A6', 'not_executed']], 'U4: asked is pending, no consent / no device is never a success');
    assert.deepEqual([r.json.summary.selected, r.json.summary.held], [4, 2]); assert.equal(counts().targets - before.targets, 1, 'only the one reachable, consenting learner is asked');
    assert.equal((await put(conn.A4.credential, r.json.batch.id, 'events.jsonl', record('student-d'))).json.reason, 'not_requested');
  });

  await check('AT-38 refused, and never widened: empty selection, a misspelt field, a duplicate, a seat outside this run', async () => {
    const before = counts();
    for (const [body, status, reason] of [[{ targets: [] }, 400, 'targets_empty'], [{ target: ['A1'] }, 400, 'unknown_field'], [{ targets: ['A1'], seat_ids: ['A2'] }, 400, 'unknown_field'], [{ targets: ['A1', 'A1'] }, 400, 'targets_duplicate'], [{ targets: ['A1', 'Z9'] }, 404, 'seat_not_found'], [{ targets: ['A1'], mode: 'finish' }, 400, 'mode_not_allowed'], [{ mode: 'collect_only' }, 400, 'targets_required']]) {
      const r = await post({ idempotency_key: KEY(), ...base, ...body }); assert.deepEqual([r.status, r.json.reason], [status, reason], JSON.stringify(body));
    }
    assert.deepEqual(counts(), before, 'a refused request records and requests nothing');
  });

  await check('AT-38 double click, lost response, same key for something else', async () => {
    const key = KEY(), body = { idempotency_key: key, ...base, targets: ['A1', 'A2'] }, before = counts();
    const [x, y] = await Promise.all([post(body), post(body)]), first = [x, y].find((r) => r.status === 201) ?? x; assert.ok([x, y].every((r) => [200, 201].includes(r.status)), x.raw + y.raw); assert.equal(x.json.batch.id, y.json.batch.id, 'a double click is one batch');
    const again = await post({ ...body, targets: ['A2', 'A1'], mode: 'collect_only' }); assert.deepEqual([again.status, again.json.batch.id], [200, first.json.batch.id], 'the same request in another order, after a lost response, is the same result');
    assert.deepEqual([counts().batches - before.batches, counts().commands - before.commands], [1, 1]);
    for (const other of [{ targets: ['A1'] }, { targets: ['A1', 'A2', 'A3'] }, { notice_version: 'notice-v2' }, { dry_run: true }, { targets: undefined }]) { const r = await post({ ...body, ...other }); assert.deepEqual([r.status, r.json.reason], [409, 'idempotency_conflict'], JSON.stringify(other)); }
    assert.deepEqual([counts().batches - before.batches, counts().commands - before.commands], [1, 1], 'a conflicting reuse changes nothing');
  });

  await check('AT-38 the whole-class wrap-up is unchanged and explicit: no targets = everyone, evaluation may follow; an older batch without a scope row still replays', async () => {
    const key = KEY(), r = await post({ idempotency_key: key, ...base }); assert.equal(r.status, 201, r.raw);
    assert.deepEqual([r.json.batch.scope, r.json.batch.mode, r.json.summary.selected, r.json.items.some((i) => i.state === 'not_selected')], ['roster', 'finish', 6, false]);
    const u = await f.uploadSnapshotAs(conn.A1, r.json.batch.id, 1, record('student-a')); assert.equal(u.status, 201, u.raw);
    assert.equal(f.db.prepare("SELECT count(*) n FROM classroom_job_outbox WHERE payload_json LIKE ?").get('%' + r.json.batch.id + '%').n, 1, 'the wrap-up still feeds evaluation');
    assert.equal((await f.request(B + '/' + r.json.batch.id + '/reports')).status, 200);
    f.db.prepare('DELETE FROM classroom_collect_scopes WHERE batch_id=?').run(r.json.batch.id); // a batch created before migration 0022
    assert.deepEqual([(await post({ idempotency_key: key, ...base })).status, (await post({ idempotency_key: key, ...base, targets: ['A1'] })).json.reason], [200, 'idempotency_conflict']);
    assert.equal((await f.request(B + '/' + r.json.batch.id)).json.batch.mode, 'finish');
  });

  await check('AT-37/38 authority and switches: collect without command is enough; no collect, the run flag off and operations off are refused', async () => {
    const collector = await f.teacher('collector', ['observe', 'collect']), status = await f.request(f.base + '/status', 'GET', undefined, collector);
    assert.deepEqual(status.json.collection, { enabled: true, held: true }); assert.ok(status.json.actions.every((a) => !a.held), 'this instructor holds no command capability at all');
    assert.equal((await post({ idempotency_key: KEY(), ...base, dry_run: true, targets: ['A1'] }, collector)).status, 201);
    assert.equal((await f.command('retry_diagnostics', ['A1'], {}, collector)).status, 403, 'and still cannot run a command');
    const fixer = await f.teacher('fixer', ['observe', 'command']); assert.equal((await f.request(f.base + '/status', 'GET', undefined, fixer)).json.collection.held, false); assert.equal((await post({ idempotency_key: KEY(), ...base, targets: ['A1'] }, fixer)).status, 403);
  });

  await check('AT-38 roster change and class boundary: a stale selection is refused; after the run ends an asked-for upload still arrives, a NEW request does not', async () => {
    const open = await post({ idempotency_key: KEY(), ...base, targets: ['A3'] }); assert.equal(open.status, 201, open.raw);
    f.db.prepare('UPDATE class_run_ops SET ends_at=? WHERE class_run_id=?').run(Date.now() - 60_000, f.run);
    const late = await post({ idempotency_key: KEY(), ...base, targets: ['A1'] }); assert.deepEqual([late.status, late.json.reason], [409, 'run_ended']);
    const u = await f.uploadSnapshotAs(conn.A3, open.json.batch.id, 1, record('student-c')); assert.equal(u.status, 201, 'the upload that was already requested is still inside its grace window: ' + u.raw);
    f.db.prepare('UPDATE class_run_ops SET ends_at=? WHERE class_run_id=?').run(Date.now() + 3_600_000, f.run);
    const moved = await f.configure([...students.slice(0, 5), { seat_id: 'A6', student_id: 'student-a' }].filter((s, i, all) => all.findIndex((x) => x.student_id === s.student_id) === i), 1); assert.equal(moved.status, 200, moved.raw);
    const stale = await post({ idempotency_key: KEY(), ...base, targets: ['A1'] }); assert.deepEqual([stale.status, stale.json.reason, stale.json.roster_revision], [409, 'revision_conflict', 2]);
  });

  await check('AT-38 fail closed: an unreadable scope is never promoted to the whole-class wrap-up — seal, reports, delivery, view and replay all refuse', async () => {
    const k = await localOps(); try {
      await k.freeze(); assert.equal((await k.configure([{ seat_id: 'A1', student_id: 'student-a' }], 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true, ops_delivery: true } })).status, 201);
      const c = (await k.pair('A1', 1)).conn.json; assert.equal((await k.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential)).status, 201);
      const key = KEY(), made = await k.request(k.base + '/report-batches', 'POST', { idempotency_key: key, ...base, targets: ['A1'] }); assert.equal(made.status, 201, made.raw); const id = made.json.batch.id, P = k.base + '/report-batches/' + id;
      const rec = record('student-a'); // the device re-sends the SAME frozen bytes after a 503
      const inputs = () => k.db.prepare("SELECT count(*) n FROM classroom_job_outbox WHERE kind='report_input'").get().n, sealed = () => k.db.prepare("SELECT count(*) n FROM classroom_snapshots WHERE batch_id=? AND state='sealed'").get(id).n;
      const refusedEverywhere = async (reason, label) => {
        const up = await k.uploadSnapshotAs(c, id, 1, rec); assert.deepEqual([up.status, up.json.reason], [503, reason], label + ': seal');
        assert.deepEqual([inputs(), sealed()], [0, 0], label + ': nothing sealed, no evaluation input');
        for (const [path, method, body] of [['', 'GET'], ['/advance', 'POST', {}], ['/jobs', 'POST', {}], ['/reports', 'GET'], ['/recipients?template_revision=report-link-ko-1', 'GET']]) { const r = await k.request(P + path, method, body); assert.deepEqual([r.status, r.json.reason], [503, reason], label + ': ' + (path || 'view')); }
        const replay = await k.request(k.base + '/report-batches', 'POST', { idempotency_key: key, ...base, targets: ['A1'] }); assert.deepEqual([replay.status, replay.json.reason], [503, reason], label + ': replay');
      };
      k.fail('SELECT scope,mode,targets_json,request_hash'); await refusedEverywhere('scope_unavailable', 'D1 lookup throws'); k.fail('');
      const good = k.db.prepare('SELECT * FROM classroom_collect_scopes WHERE batch_id=?').get(id), set = (col, v) => k.db.prepare(`UPDATE classroom_collect_scopes SET ${col}=? WHERE batch_id=?`).run(v, id);
      for (const [col, bad, label] of [['targets_json', '{not json', 'unparseable seats'], ['targets_json', '[]', 'a selection with no seats'], ['mode', 'finish', 'targets + finish'], ['mode', 'everything', 'an unknown mode'], ['scope', 'cohort', 'an unknown scope'], ['request_hash', '', 'no request hash']]) { set(col, bad); await refusedEverywhere('scope_invalid', label); set(col, good[col]); }
      // Positive control: with the scope readable again the same upload verifies, and still queues no evaluation.
      const up = await k.uploadSnapshotAs(c, id, 1, rec); assert.deepEqual([up.status, up.json.coverage, inputs()], [201, 'complete', 0]);
      // Backward compatibility is a SUCCESSFUL lookup that finds no row — not an error. Such a batch is the old whole-roster wrap-up.
      const old = await k.request(k.base + '/report-batches', 'POST', { idempotency_key: KEY(), ...base }); k.db.prepare('DELETE FROM classroom_collect_scopes WHERE batch_id=?').run(old.json.batch.id);
      assert.deepEqual([(await k.uploadSnapshotAs(c, old.json.batch.id, 1, record('student-a'))).status, inputs()], [201, 1], 'a batch that really predates the scope table still feeds evaluation');
    } finally { k.close(); }
  });

  await check('AT-38 commit boundary: a seat, the run, the switch or a consent that changes BETWEEN the read and the write refuses the whole request — nothing is recorded, nobody new is asked', async () => {
    // Reproduced 2026-09-21 (management-20260921/selected-roster-race-check.mjs): the request named student-a's seat, the seat
    // changed hands after the revision check, and the command went to student-b. A stale revision sent from the start does
    // not catch this; the change has to land between the read and the commit, which is where it is injected here.
    const cases = {
      'seat changes hands, revision bumped': [(d, run, now) => { d.prepare("UPDATE class_run_seats SET replaced_at=?,replaced_reason='student_changed' WHERE class_run_id=? AND seat_id='A1' AND replaced_at IS NULL").run(now, run); d.prepare("INSERT INTO class_run_seats(class_run_id,seat_id,seat_revision,student_id,roster_revision,changed_by,created_at) VALUES(?,'A1',2,'student-c',2,'other-instructor',?)").run(run, now); d.prepare('UPDATE class_run_ops SET roster_revision=2 WHERE class_run_id=?').run(run); }, 409, 'revision_conflict'],
      'seat changes hands, revision NOT bumped (defence in depth)': [(d, run, now) => { d.prepare("UPDATE class_run_seats SET replaced_at=? WHERE class_run_id=? AND seat_id='A1' AND replaced_at IS NULL").run(now, run); d.prepare("INSERT INTO class_run_seats(class_run_id,seat_id,seat_revision,student_id,roster_revision,changed_by,created_at) VALUES(?,'A1',2,'student-c',1,'x',?)").run(run, now); }, 409, 'changed_during_request'],
      'collection switched off': [(d, run) => d.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_collect',json('false')) WHERE class_run_id=?").run(run), 403, 'ops_collect_disabled'],
      'the instructor ended the class': [(d, run) => d.prepare("UPDATE sessions SET ended_at='2026-09-21T00:00:00Z' WHERE id=?").run(run), 409, 'run_ended'],
      'the class window closed': [(d, run, now) => d.prepare('UPDATE class_run_ops SET ends_at=? WHERE class_run_id=?').run(now - 1, run), 409, 'run_ended'],
      'the learner withdrew consent': [(d, run, now) => d.prepare("UPDATE classroom_consents SET revoked_at=? WHERE class_run_id=? AND student_id='student-a'").run(now, run), 409, 'changed_during_request'],
      'an erasure tombstone appeared': [(d, run, now) => d.prepare("INSERT INTO classroom_collect_tombstones(class_run_id,student_id,reason,created_by,created_at) VALUES(?,'student-a','withdrawn','operator',?)").run(run, now), 409, 'changed_during_request'],
    };
    for (const [label, [mutate, status, reason]] of Object.entries(cases)) {
      const k = await localOps(); try {
        await k.freeze(); assert.equal((await k.configure([{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }], 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true } })).status, 201);
        const c = (await k.pair('A1', 1)).conn.json; assert.equal((await k.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential)).status, 201);
        const snapshot = () => JSON.stringify(['classroom_collect_batches', 'classroom_collect_scopes', 'classroom_collect_items', 'ops_commands', 'ops_command_targets'].map((t) => k.db.prepare('SELECT count(*) n FROM ' + t).get().n));
        // Positive control first: the same request without interference is accepted and asks student-a's device.
        const okay = await k.request(k.base + '/report-batches', 'POST', { idempotency_key: KEY(), ...base, targets: ['A1'] }); assert.deepEqual([okay.status, okay.json.items[0].state], [201, 'requested'], label + ': control');
        const before = snapshot(), inner = k.env.HPS_DB; let fired = false;
        // The batch INSERT is prepared after every read and immediately before the commit: the change lands exactly there.
        k.env.HPS_DB = { ...inner, prepare(sql) { if (!fired && sql.includes('INSERT INTO classroom_collect_batches')) { fired = true; mutate(k.db, k.run, Date.now()); } return inner.prepare(sql); }, batch: (...a) => inner.batch(...a) };
        const r = await k.request(k.base + '/report-batches', 'POST', { idempotency_key: KEY(), ...base, targets: ['A1'] }); k.env.HPS_DB = inner;
        assert.ok(fired, label + ': the change was injected'); assert.deepEqual([r.status, r.json.reason], [status, reason], label + ': ' + r.raw); assert.equal(snapshot(), before, label + ': no batch, scope, item, command or target was written');
        assert.equal(k.db.prepare("SELECT count(*) n FROM ops_command_targets t JOIN class_run_seats s ON s.class_run_id=t.class_run_id AND s.seat_id=t.seat_id AND s.seat_revision=t.seat_revision WHERE s.student_id='student-c'").get().n, 0, label + ': the learner who now holds the seat was asked nothing');
      } finally { k.close(); }
    }
  });

  await check('AT-38 lifecycle through the real routes: a partial upload that failed is not "sending"; an unknown outcome that later seals is verified; the closed grace is said as such', async () => {
    const k = await localOps(); try {
      const three = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-c' }];
      await k.freeze(); assert.equal((await k.configure(three, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true } })).status, 201);
      const c = {}; for (const [i, s] of three.entries()) { c[s.seat_id] = (await k.pair(s.seat_id, 1, i + 1)).conn.json; assert.equal((await k.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c[s.seat_id].credential)).status, 201); }
      const made = await k.request(k.base + '/report-batches', 'POST', { idempotency_key: KEY(), ...base, targets: ['A1', 'A2', 'A3'] }); assert.equal(made.status, 201, made.raw); const id = made.json.batch.id;
      const view = async () => { const v = (await k.request(k.base + '/report-batches/' + id)).json; return { v, of: (seat) => { const i = v.items.find((x) => x.seat_id === seat); return [i.state, i.request?.state, i.request?.result_code || '', i.status.phase, i.status.retryable, i.status.partial].join(' '); } }; };
      const target = (seat, st, code = '', at = Date.now()) => k.db.prepare("UPDATE ops_command_targets SET state=?,result_code=?,updated_at=? WHERE seat_id=? AND command_id=(SELECT id FROM ops_commands WHERE idempotency_key=?)").run(st, code, at, seat, 'collect-' + id);
      const putMeta = (seat) => k.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${id}/1/session.meta.json`, { method: 'PUT', headers: { authorization: 'Bearer ' + c[seat].credential }, body: k.metaFor(c[seat]) }), k.env, { waitUntil() {} }).then((r) => r.status);
      const old = (seat) => k.db.prepare('UPDATE classroom_collect_items SET updated_at=? WHERE batch_id=? AND seat_id=?').run(Date.now() - 120_000, id, seat); // "the bytes arrived two minutes ago and nothing since"
      let s = await view(); assert.equal(s.of('A1'), 'requested queued  awaiting_device false false'); assert.ok(Math.abs(s.v.observed_at - Date.now()) < 5000); assert.deepEqual([s.v.batch.upload_open, s.v.batch.new_request_allowed], [true, true]);
      // file → failure, through the real routes and with no clock moved: A1 meta arrives, THEN the device reports it stopped for now
      // (offline_pending); A2 meta arrives, THEN a final refusal; A3 started and never reported.
      const tick = () => new Promise((r) => setTimeout(r, 5)); // two Service timestamps in one millisecond prove no order — and that case is a table row, not this one
      assert.equal(await putMeta('A1'), 201); assert.equal(await putMeta('A2'), 201); await tick(); target('A1', 'failed', 'offline_pending'); target('A2', 'failed', 'upload_refused'); target('A3', 'outcome_unknown');
      s = await view(); assert.equal(s.of('A1'), 'uploading failed offline_pending resend_wait true true', 'a file that arrived BEFORE the failure report is not a transfer in progress — not for 90 s, not for one'); assert.equal(s.of('A2'), 'uploading failed upload_refused refused true true'); assert.equal(s.of('A3'), 'requested outcome_unknown  unknown true false');
      // failure → new file: A2's device sends the NEXT file after the refusal was reported. That is a transfer again.
      await tick(); const next = await k.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${id}/1/events.jsonl`, { method: 'PUT', headers: { authorization: 'Bearer ' + c.A2.credential }, body: record('student-b') }), k.env, { waitUntil() {} }); assert.equal(next.status, 201);
      s = await view(); assert.equal(s.of('A2'), 'uploading failed upload_refused transferring false true', 'a file received after the request ended is resumed activity');
      // …and so is an identical re-send (the way a resuming device starts): it stores nothing, but the Service saw an upload after the failure.
      await tick(); assert.equal(await putMeta('A1'), 200); s = await view(); assert.equal(s.of('A1'), 'uploading failed offline_pending transferring false true', 'an idempotent re-send after the failure is upload activity too');
      old('A1'); old('A2'); s = await view(); assert.equal(s.of('A1'), 'uploading failed offline_pending resend_wait true true', 'activity that went quiet falls back to what the request ended as'); assert.equal(s.of('A2'), 'uploading failed upload_refused refused true true');
      // A3's record arrives late, inside the grace: the past command result stays visible next to the present, verified, collection result.
      const late = await k.uploadSnapshotAs(c.A3, id, 1, record('student-c')); assert.equal(late.status, 201, late.raw); s = await view(); assert.equal(s.of('A3'), 'verified outcome_unknown  verified false false');
      // A1's device comes back and finishes the SAME frozen revision: resend_wait → verified.
      const resumed = await k.uploadSnapshotAs(c.A1, id, 1, record('student-a'), { meta: k.metaFor(c.A1) }); assert.equal(resumed.status, 201, resumed.raw); s = await view(); assert.equal(s.of('A1'), 'verified failed offline_pending verified false false');
      // The grace of this batch closes with A2 still partial: said as such, and the Service refuses the bytes too.
      k.db.prepare('UPDATE classroom_collect_batches SET upload_until=? WHERE id=?').run(Date.now() - 1, id); s = await view();
      assert.equal(s.of('A2'), 'uploading failed upload_refused grace_over true true'); assert.equal(s.v.batch.upload_open, false); assert.equal(await putMeta('A2'), 403);
      // …and whether a NEW request is possible is a separate fact: the class is still open here, then it ends.
      assert.equal(s.v.batch.new_request_allowed, true); k.db.prepare('UPDATE class_run_ops SET ends_at=? WHERE class_run_id=?').run(Date.now() - 1, k.run);
      s = await view(); assert.deepEqual([s.v.batch.new_request_allowed, s.v.batch.new_request_blocked_by], [false, 'run_ended']);
    } finally { k.close(); }
  });

  await check('AT-32 switches off: the run flag and the Service switch each refuse selection and wrap-up alike', async () => {
    const off = await localOps(); try { await off.freeze(); await off.configure([{ seat_id: 'A1', student_id: 'student-a' }], 0, { flags: { ops_observe: true } });
      for (const body of [{ targets: ['A1'] }, {}]) { const r = await off.request(off.base + '/report-batches', 'POST', { idempotency_key: KEY(), ...base, ...body }); assert.deepEqual([r.status, r.json.reason], [403, 'ops_collect_disabled']); }
      delete off.env.HPS_CLASSROOM_OPS; const r = await off.request(off.base + '/report-batches', 'POST', { idempotency_key: KEY(), ...base, targets: ['A1'] }); assert.deepEqual([r.status, r.json.reason], [404, 'ops_disabled']);
    } finally { off.close(); }
  });
  assert.equal(evaluatorCalls, 0, 'no selected collection in this file ever reached the evaluator');
  console.log(`${count} selected-collection controls passed`);
} finally { setEvaluatorTransport(undefined); f.close(); }
