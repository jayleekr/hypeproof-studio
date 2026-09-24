// #751 U3 — AT-46 S19: a collection input that was produced under MORE THAN ONE lesson basis (or whose basis cannot be
// established) is never evaluated, approved, delivered or shown through the existing report path — and a single-basis input
// goes through exactly as before. One verdict (lib/lesson-basis.ts) at every consumer; the basis comes from the turns the
// Service admitted, never from `activated_at`. Synthetic accounts, SQLite.
import assert from 'node:assert/strict';
import { localOps } from './harness/classroom-ops.mjs';
import { CANDIDATE_CAPABILITY_V1 } from '../src/lib/measurement-core/index.ts';
const { inputBasisVerdict, sealBasisStatement } = await import('../src/lib/lesson-basis.ts');
let count = 0; async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const admin = { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') }, keys = CANDIDATE_CAPABILITY_V1.capabilities.map((c) => c.key);
const f = await localOps();
const rows = (sql, ...a) => f.db.prepare(sql).all(...a).map((r) => ({ ...r })), one = (sql, ...a) => { const r = f.db.prepare(sql).get(...a); return r ? { ...r } : r; };
// P: never switched · Q: switched before the first question, ran v2 only · R: ran v1, then v2 · T: v2 switched while a v1 turn of another window kept running
const seats = [['A1', 'student-a'], ['A2', 'student-b'], ['A3', 'student-c'], ['A4', 'student-d']].map(([seat_id, student_id]) => ({ seat_id, student_id }));
const SHA1 = '1'.repeat(64), SHA2 = '2'.repeat(64), T0 = Date.now() - 600_000;
const bind = (student, seat, seq, sha, at, source = 'setting') => f.db.prepare('INSERT INTO classroom_lesson_bindings(class_run_id,student_id,binding_seq,seat_id,seat_revision,binding_key,source,distribution_id,object_id,revision,content_hash,course_id,version,lesson_sha256,base_lesson_sha256,activated_at) VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)')
  .run(f.run, student, seq, seat, (student + seq).padEnd(32, '0').slice(0, 32), source, 'dist-' + student + seq, 'obj-setting', seq, 'h'.repeat(64), 'ops-course', 'v' + seq, sha, SHA1, at);
// One admitted turn = one permitted provider request (its row, written before the provider call) and, as in the real path, one
// answered row in the usage ledger that the request row points at.
const turn = (student, id, seq, sha, admitted, dispatched) => { f.db.prepare('INSERT INTO classroom_lesson_turns(class_run_id,student_id,turn_id,token_jti,binding_seq,binding_key,course_id,version,lesson_sha256,admitted_at,first_dispatched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(f.run, student, id, 'jti-' + student, seq, 'k' + seq, 'ops-course', 'v', sha, admitted, dispatched);
  const u = f.db.prepare("INSERT INTO usage_log(session_id,cohort_id,user_id,profile_id,model,status,created_at) VALUES(?,?,?,?,?,200,datetime(?,'unixepoch'))").run(f.run, f.cohort, student, f.profile, 'm', Math.floor(dispatched / 1000));
  f.db.prepare('INSERT INTO classroom_lesson_requests(class_run_id,student_id,request_id,turn_id,binding_seq,lesson_sha256,permitted_at,usage_row_id) VALUES(?,?,?,?,?,?,?,?)').run(f.run, student, 'req-' + id, id, seq, sha, dispatched, Number(u.lastInsertRowid)); };
try {
  const { setRoster } = await import('../src/lib/kv.ts'); await setRoster(f.env.HPS_KV, f.cohort, seats.map((s) => s.student_id)); await f.freeze();
  assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true, ops_delivery: true, ops_distribute: true, ops_lesson_settings: true } })).status, 201);
  const conn = {}; for (const [i, s] of seats.entries()) { conn[s.student_id] = (await f.pair(s.seat_id, 1, i + 1)).conn.json; await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, conn[s.student_id].credential); }
  // what the Service admitted during the class
  turn('student-a', 'p-1', 0, SHA1, T0, T0 + 1);
  bind('student-b', 'A2', 1, SHA2, T0); turn('student-b', 'q-1', 1, SHA2, T0 + 10, T0 + 11); turn('student-b', 'q-2', 1, SHA2, T0 + 20, T0 + 21);
  turn('student-c', 'r-1', 0, SHA1, T0, T0 + 1); bind('student-c', 'A3', 1, SHA2, T0 + 100); turn('student-c', 'r-2', 1, SHA2, T0 + 200, T0 + 201);
  turn('student-d', 't-old-window', 0, SHA1, T0, T0 + 1); bind('student-d', 'A4', 1, SHA2, T0 + 100); turn('student-d', 't-new', 1, SHA2, T0 + 150, T0 + 151);
  const batch = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false })).json.batch.id, Bp = f.base + '/report-batches/' + batch;
  const ev = (u) => `{"seq":1,"event_id":"e","type":"prompt","text":"${u} 가 기대 조건을 먼저 적음"}\n`;

  await check('seal: the basis is computed from the ADMITTED TURNS inside the seal batch; a slicing by `activated_at` would mislabel the overlapping turn', async () => {
    for (const s of seats) assert.equal((await f.uploadSnapshotAs(conn[s.student_id], batch, 1, ev(s.student_id))).status, 201);
    assert.deepEqual(rows('SELECT student_id,basis,lessons,turns FROM classroom_input_basis WHERE batch_id=? ORDER BY student_id', batch), [
      { student_id: 'student-a', basis: 'single', lessons: 1, turns: 1 }, { student_id: 'student-b', basis: 'single', lessons: 1, turns: 2 },
      { student_id: 'student-c', basis: 'mixed', lessons: 2, turns: 2 }, { student_id: 'student-d', basis: 'mixed', lessons: 2, turns: 2 }]);
    assert.equal(rows("SELECT 1 FROM classroom_job_outbox WHERE kind='report_input'").length, 4, 'the outbox row is always written: a held learner must stay visible');
    // NEGATIVE CONTROL — "everything after activated_at is v2". T's old window DISPATCHED a v1 request after the switch.
    const byTime = (eventAt, activatedAt) => (eventAt < activatedAt ? SHA1 : SHA2), lateV1Request = T0 + 300;
    assert.equal(byTime(lateV1Request, T0 + 100), SHA2, 'control: the time rule calls it v2 …'); assert.equal(one("SELECT lesson_sha256 s FROM classroom_lesson_turns WHERE turn_id='t-old-window'").s, SHA1, '… while the admitted turn says v1: the record cannot be cut by a timestamp');
    // a learner who ran v2 only in ADMITTED turns but had model requests BEFORE the first switch is mixed as well (those ran the token lesson)
    f.db.prepare("INSERT INTO usage_log(session_id,cohort_id,user_id,profile_id,model,status,created_at) VALUES(?,?,?,?,?,200,datetime(?,'unixepoch'))").run(f.run, f.cohort, 'student-b', f.profile, 'm', Math.floor((T0 - 60_000) / 1000));
    const b2 = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false, targets: ['A2'], mode: 'collect_only' })).json.batch.id;
    assert.equal((await f.uploadSnapshotAs(conn['student-b'], b2, 1, ev('student-b'))).status, 201); assert.equal(one('SELECT basis b FROM classroom_input_basis WHERE batch_id=?', b2).b, 'unknown', 'an answered request no permitted request points at, for a switched participant: not attributable — held, not guessed');
    f.db.prepare("DELETE FROM usage_log WHERE id=(SELECT MAX(id) FROM usage_log)").run();
    // Codex review 2 · rollback: the participant ran v2 under an admitted turn, then enforcement was switched off and the SAME token
    // ran v1 — a usage row that no admitted turn accounts for. The record is mixed; the flag being off now changes nothing.
    f.db.prepare("INSERT INTO usage_log(session_id,cohort_id,user_id,profile_id,model,status) VALUES(?,?,?,?,?,200)").run(f.run, f.cohort, 'student-b', f.profile, 'm');
    const b3 = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false, targets: ['A2'], mode: 'collect_only' })).json.batch.id;
    assert.equal((await f.uploadSnapshotAs(conn['student-b'], b3, 1, ev('student-b'))).status, 201); assert.equal(one('SELECT basis b FROM classroom_input_basis WHERE batch_id=?', b3).b, 'unknown', 'an answered request outside the request ledger, for a participant who ran a switched lesson');
    f.db.prepare("DELETE FROM usage_log WHERE id=(SELECT MAX(id) FROM usage_log)").run();
    // a usage row whose session attribution was lost (the existing NULL retry) still counts
    f.db.prepare("INSERT INTO usage_log(session_id,cohort_id,user_id,profile_id,model,status) VALUES(NULL,?,?,?,?,200)").run(f.cohort, 'student-b', f.profile, 'm');
    assert.equal({ ...(await sealBasisStatement(f.env.HPS_DB, { batch_id: 'probe-null-session', student_id: 'student-b', revision: 1, class_run_id: f.run, now: Date.now() }).run(), f.db.prepare("SELECT basis b FROM classroom_input_basis WHERE batch_id='probe-null-session'").get()) }.b, 'unknown');
    f.db.prepare("DELETE FROM usage_log WHERE id=(SELECT MAX(id) FROM usage_log)").run();
    // Codex review 6 · same second: ONE v2 request in the very second of the switch is a single basis (no clock is compared)
    assert.equal({ ...(await sealBasisStatement(f.env.HPS_DB, { batch_id: 'probe-same-second', student_id: 'student-b', revision: 1, class_run_id: f.run, now: Date.now() }).run(), f.db.prepare("SELECT basis b FROM classroom_input_basis WHERE batch_id='probe-same-second'").get()) }.b, 'single');
    // unaccounted requests for a switched participant whose turns all ran the BASE lesson: nothing shows what they ran under
    bind('student-a', 'A1', 1, SHA2, T0 + 500); f.db.prepare("INSERT INTO usage_log(session_id,cohort_id,user_id,profile_id,model,status) VALUES(?,?,?,?,?,200)").run(f.run, f.cohort, 'student-a', f.profile, 'm');
    await sealBasisStatement(f.env.HPS_DB, { batch_id: 'probe-unknown', student_id: 'student-a', revision: 1, class_run_id: f.run, now: Date.now() }).run(); assert.equal(one("SELECT basis b FROM classroom_input_basis WHERE batch_id='probe-unknown'").b, 'unknown');
    assert.deepEqual(await inputBasisVerdict(f.env.HPS_DB, { class_run_id: f.run, student_id: 'student-a', batch_id: 'probe-unknown', snapshot_revision: 1 }), { allow: false, reason: 'lesson_basis_unknown', tables: true });
    f.db.prepare("DELETE FROM usage_log WHERE id=(SELECT MAX(id) FROM usage_log)").run(); f.db.prepare("DELETE FROM classroom_lesson_bindings WHERE student_id='student-a'").run();
  });

  let runner; const R = (path, method, body) => f.request('/v1/classroom/ops/runner' + path, method, body, runner);
  const draftFor = (u) => ({ format: 'hps-classroom-report-draft/1', versions: { capability_model: { id: CANDIDATE_CAPABILITY_V1.id, revision: CANDIDATE_CAPABILITY_V1.revision }, rubric: 'unknown', evaluator: 'none', renderer_revision: 'observation-report/1' }, findings: [{ capability: keys[0], status: 'observed', claim: '기대 조건을 먼저 정함', evidence: [{ event_id: 'e', quote: '기대 조건을 먼저 적음' }] }, ...keys.slice(1).map((capability) => ({ capability, status: 'unobserved', claim: '', evidence: [] }))], next_experiment: '다음에는 대안 2개를 먼저 적기' });
  const jobOf = (student) => one("SELECT * FROM classroom_report_jobs WHERE batch_id=? AND student_id=? ORDER BY created_at DESC LIMIT 1", batch, student);

  await check('positive control: single-basis inputs (never switched, or one switched version only) go queued → result → review → approve → delivery scope, as before', async () => {
    const q = await f.request(Bp + '/jobs', 'POST', {}); assert.equal(q.status, 201, q.raw);
    assert.deepEqual(q.json.jobs.map((j) => [j.student_id, j.state, j.reason]), [['student-a', 'queued', ''], ['student-b', 'queued', ''], ['student-c', 'held', 'mixed_lesson_basis'], ['student-d', 'held', 'mixed_lesson_basis']], 'the held learners are IN the review queue with their reason');
    runner = (await f.request(Bp + '/runner-grants', 'POST', {})).json.runner_credential;
    const done = []; for (let i = 0; i < 4; i++) { const j = (await R('/claim', 'POST', {})).json.job; if (!j) break; done.push(j.student_id); const r = await R(`/jobs/${j.id}/result`, 'POST', { lease_generation: j.lease_generation, draft: draftFor(j.student_id) }); assert.equal(r.status, 201, r.raw); }
    assert.deepEqual(done.sort(), ['student-a', 'student-b'], 'a held job is never leased — to the Service evaluator or to a runner');
    for (const u of ['student-a', 'student-b']) { const j = jobOf(u), o = (await f.request(Bp + '/reports/' + j.id)).json; assert.equal((await f.request(Bp + `/reports/${j.id}/review`, 'PUT', { decision: 'approve', expected_revision: o.revision, draft_digest: o.draft_digest })).status, 200); }
    await f.request('/admin/classroom/recipients', 'POST', { class_run_id: f.run, source_ref: 'roster', recipients: seats.map((s) => ({ student_id: s.student_id, recipient_ref: 'g-' + s.seat_id, channel: 'email', address: s.seat_id.toLowerCase() + '@example.test' })) }, null, admin);
    assert.deepEqual((await f.request(Bp + '/recipients?template_revision=tmpl-1')).json.will_send.map((r) => r.student_id), ['student-a', 'student-b']);
    const again = await f.request(Bp + '/advance', 'POST', {}); assert.equal(again.status, 200, again.raw); assert.deepEqual(again.json.jobs.filter((j) => j.state === 'held').map((j) => j.student_id), ['student-c', 'student-d'], 'advance and its retries leave them held'); assert.equal(again.json.more, false);
  });

  await check('negative: a job that was ALREADY leased, or already approved, before its basis was known is stopped at every remaining boundary', async () => {
    // R's job as an older deployment would have left it: queued, then leased by a runner, with no basis row yet.
    const held = jobOf('student-c'); f.db.prepare('DELETE FROM classroom_input_basis WHERE batch_id=? AND student_id=?').run(batch, 'student-c'); f.db.prepare('DELETE FROM classroom_lesson_bindings WHERE student_id=?').run('student-c');
    f.db.prepare("UPDATE classroom_report_jobs SET state='queued',reason='' WHERE id=?").run(held.id);
    const leased = (await R('/claim', 'POST', {})).json.job; assert.equal(leased.student_id, 'student-c', 'fixture: leased while nothing said "mixed"');
    bind('student-c', 'A3', 1, SHA2, T0 + 100); f.db.prepare("INSERT INTO classroom_input_basis(batch_id,student_id,revision,class_run_id,basis,lessons,turns,created_at) VALUES(?,?,1,?,'mixed',2,2,?)").run(batch, 'student-c', f.run, Date.now()); // the late basis
    const input = await f.request(`/v1/classroom/ops/runner/jobs/${leased.id}/input/events.jsonl?generation=${leased.lease_generation}`, 'GET', undefined, runner); assert.equal(input.status, 409); assert.equal(input.json.reason, 'mixed_lesson_basis', 'no byte of the input leaves for a runner');
    assert.equal(jobOf('student-c').state, 'held');
    // the same, but the runner already HAS the input and submits a draft directly
    f.db.prepare('DELETE FROM classroom_input_basis WHERE batch_id=? AND student_id=?').run(batch, 'student-d'); f.db.prepare('DELETE FROM classroom_lesson_bindings WHERE student_id=?').run('student-d'); f.db.prepare("UPDATE classroom_report_jobs SET state='queued',reason='' WHERE id=?").run(jobOf('student-d').id);
    const l2 = (await R('/claim', 'POST', {})).json.job; assert.equal(l2.student_id, 'student-d'); bind('student-d', 'A4', 1, SHA2, T0 + 100); // a change history appears, and there is NO basis row for it
    const r2 = await R(`/jobs/${l2.id}/result`, 'POST', { lease_generation: l2.lease_generation, draft: draftFor('student-d') }); assert.notEqual(r2.status, 201); assert.equal(r2.json.state, 'held'); assert.equal(r2.json.reason, 'lesson_basis_unknown', 'a change history without a basis row is not "legacy": it is held');
    assert.equal(jobOf('student-d').draft_digest, ''); assert.equal([...f.r2.keys()].filter((k) => k.includes('student-d') && k.includes('draft')).length, 0, 'the draft body was not kept');
    // an OLD draft waiting for review, and an OLD approved report
    f.db.prepare("UPDATE classroom_report_jobs SET state='review_required',draft_digest=? WHERE id=?").run('d'.repeat(64), l2.id);
    const o = one('SELECT revision r FROM classroom_report_jobs WHERE id=?', l2.id); const ap = await f.request(Bp + `/reports/${l2.id}/review`, 'PUT', { decision: 'approve', expected_revision: o.r, draft_digest: 'd'.repeat(64) }); assert.equal(ap.status, 409); assert.equal(ap.json.reason, 'lesson_basis_unknown'); assert.equal(jobOf('student-d').state, 'review_required', 'refused, unchanged');
    f.db.prepare("UPDATE classroom_report_jobs SET state='approved' WHERE id=?").run(l2.id);
    assert.deepEqual((await f.request(Bp + '/recipients?template_revision=tmpl-1')).json.will_send.map((r) => r.student_id), ['student-a', 'student-b'], 'an approved report of a held input is in no delivery scope');
    // re-preparation after an evaluator change does not bring a held job back
    f.env.HPS_CLASSROOM_EVALUATOR = 'service-anthropic'; f.env.ANTHROPIC_API_KEY = 'test'; const adv = await f.request(Bp + '/advance', 'POST', {}); f.env.HPS_CLASSROOM_EVALUATOR = undefined;
    assert.equal(adv.status, 200, adv.raw); assert.equal(jobOf('student-c').state, 'held'); assert.equal(rows("SELECT 1 FROM classroom_report_jobs WHERE batch_id=? AND student_id='student-c' AND state IN ('queued','leased')", batch).length, 0);
  });

  await check('the hold does not depend on the execution policy: flags off, enforcement unset and an explicit return to the base lesson all leave a mixed input held', async () => {
    const v = (student) => inputBasisVerdict(f.env.HPS_DB, { class_run_id: f.run, student_id: student, batch_id: batch, snapshot_revision: 1 });
    await f.request(f.base, 'PUT', { expected_roster_revision: 1, seats, flags: { ops_lesson_settings: false, ops_distribute: false } }); f.env.HPS_LESSON_BINDINGS = undefined; f.env.HPS_CLASSROOM_OPS = 'enabled';
    bind('student-c', 'A3', 2, SHA1, Date.now(), 'base');
    assert.deepEqual([(await v('student-c')).allow, (await v('student-c')).reason], [false, 'mixed_lesson_basis']); assert.deepEqual([(await v('student-a')).allow, (await v('student-a')).kind], [true, 'single']);
    f.fail('JOIN classroom_input_basis') /* the verdict's own read */; assert.deepEqual([(await v('student-a')).allow, (await v('student-a')).reason], [false, 'lesson_basis_unreadable'], 'unreadable is held — for everybody, including a learner who was never switched'); f.fail('');
    f.fail('FROM classroom_input_basis'); const b3 = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 2, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false, targets: ['A1'], mode: 'collect_only' })).json.batch.id; const sealed = await f.uploadSnapshotAs(conn['student-a'], b3, 1, ev('student-a')); f.fail('');
    assert.equal(sealed.status, 503); assert.equal(sealed.json.reason, 'lesson_basis_unreadable'); assert.equal(rows('SELECT 1 FROM classroom_snapshots WHERE batch_id=? AND state=?', b3, 'sealed').length, 0, 'there is no seal without a basis');
  });

  await check('a database without migration 0024: nothing of this exists, and collection and reports behave exactly as before', async () => {
    f.db.exec('DROP TABLE classroom_input_basis; DROP TABLE classroom_lesson_turns; DROP TABLE classroom_lesson_bindings;');
    assert.deepEqual(await inputBasisVerdict(f.env.HPS_DB, { class_run_id: f.run, student_id: 'student-c', batch_id: batch, snapshot_revision: 1 }), { allow: true, kind: 'legacy', tables: false });
    const b4 = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 2, purpose: 'class_report', notice_version: 'notice-v1', dry_run: false })).json.batch.id;
    assert.equal((await f.uploadSnapshotAs(conn['student-a'], b4, 1, ev('student-a'))).status, 201); const q = await f.request(f.base + '/report-batches/' + b4 + '/jobs', 'POST', {}); assert.equal(q.json.jobs.find((j) => j.student_id === 'student-a').state, 'queued');
    const g = (await f.request(f.base + '/report-batches/' + b4 + '/runner-grants', 'POST', {})).json.runner_credential, j = (await f.request('/v1/classroom/ops/runner/claim', 'POST', {}, g)).json.job;
    assert.equal((await f.request(`/v1/classroom/ops/runner/jobs/${j.id}/result`, 'POST', { lease_generation: j.lease_generation, draft: draftFor('student-a') }, g)).status, 201);
  });
} finally { f.close(); }
console.log(`\n${count} passed`);
