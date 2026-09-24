// #751 native voluntary help — the Service side of the Studio help loop (ADM-03/05, AT-03/05/14/47).
// Real router, real token verifier, SQLite with transactional batch (harness/classroom-ops.mjs). Synthetic accounts only.
// What is proved here: the recipient is derived from the learner's live class assignment and re-checked at submission; a
// retried id is the same request only inside the same consent envelope and class; history stays withdrawable; revoked,
// fenced, replaced and unreadable assignments fail closed; revision checks hold on both sides.
import assert from 'node:assert/strict';
import { localOps } from './harness/classroom-ops.mjs';

const { setRoster, startSession } = await import('../src/lib/kv.ts');
const { verify } = await import('../src/lib/tokens.ts');
const L = await localOps(), req = L.request, SH = '/v1/classroom/shares', HR = '/v1/classroom/help-recipient';
const T = `/admin/cohorts/${L.cohort}/classroom/shares`;
let count = 0; const check = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
const rows = (sql, ...a) => L.db.prepare(sql).all(...a);
const shareCount = () => rows('SELECT count(*) n FROM classroom_shares')[0].n;
const body = (id, a, patch = {}) => ({ id, recipient_id: a.recipient_id, kind: 'help', consent: true, duration_minutes: 30, class_run_id: a.class_run_id, grant_id: a.grant_id, content: { question: '[합성] 예약 버튼이 안 보여요' }, ...patch });
/** A second class of the same cohort/profile: the first one ends, this one becomes the active session and gets its own run. */
async function startClassB(run = 'ops-test-run-b') {
  const now = Date.now(), starts = new Date(now - 30000).toISOString(), ends = new Date(now + 3600000).toISOString();
  L.db.prepare("UPDATE sessions SET ends_at=? WHERE id='ops-test-run'").run(new Date(now - 60000).toISOString());
  L.db.prepare('INSERT OR IGNORE INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES(?,?,?,?,?)').run(run, L.cohort, L.profile, starts, ends);
  await startSession(L.env.HPS_KV, L.cohort, { session_id: run, profile_id: L.profile, starts_at: starts, ends_at: ends });
  const base = `/admin/cohorts/${L.cohort}/classroom/runs/${run}`;
  assert.equal((await req(base, 'PUT', { expected_roster_revision: 0, seats: [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }], flags: { ops_observe: true } })).status, 201);
  const p = await req(base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: 1 }); assert.equal(p.status, 201, p.raw);
  const conn = await req('/v1/classroom/ops/connect', 'POST', { ticket: p.json.ticket, ...L.instance(7) }, null); assert.equal(conn.status, 201, conn.raw);
  return { run, base, conn: conn.json };
}

try {
  await setRoster(L.env.HPS_KV, L.cohort, ['student-a', 'student-b', 'student-c']); await L.freeze();
  const sa = await L.student('student-a'), sb = await L.student('student-b');

  await check('AT-47 no assignment source yet: not connected, no recipient, nothing written', async () => {
    assert.equal((await L.configure([{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }], 0)).status, 201);
    const r = await req(HR, 'GET', undefined, sa); assert.equal(r.status, 200); assert.deepEqual(r.json, { available: false, reason: 'not_connected' });
    assert.ok(!r.raw.includes('teacher-a'), 'no instructor is named before an assignment exists');
    const post = await req(SH, 'POST', { id: 'no-assign', recipient_id: 'teacher-a', kind: 'help', consent: true, duration_minutes: 30, content: { question: 'q' } }, sa);
    assert.deepEqual([post.status, post.json.reason], [403, 'not_connected'], 'an ops run without a live connection refuses even the syntactically valid recipient'); assert.equal(shareCount(), 0);
  });

  const conn = (await L.pair('A1', 1, 1)).conn.json; let A;
  await check('AT-47 recipient = the instructor who connected this learner\'s live seat in this class; no credential leaves', async () => {
    const r = await req(HR, 'GET', undefined, sa); assert.equal(r.status, 200, r.raw); A = r.json;
    assert.deepEqual([A.available, A.recipient_id, A.class_run_id, A.seat_id, A.grant_id], [true, 'teacher-a', L.run, 'A1', conn.grant_id]);
    assert.ok(!/eyJ|secret|ticket|credential/i.test(r.raw), 'no token, ticket or credential in the answer'); assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await req(HR, 'GET', undefined, sb)).json, { available: false, reason: 'not_connected' }, 'the unconnected second learner gets no recipient');
    assert.equal((await req(HR, 'GET', undefined, L.teacherToken)).status, 403, 'an instructor token is not a learner');
  });

  await check('AT-47 submission re-validates recipient, class and connection before writing', async () => {
    for (const [patch, status, reason] of [[{ recipient_id: 'teacher-b' }, 409, 'recipient_not_assigned'], [{ class_run_id: 'another-class' }, 409, 'class_changed'], [{ grant_id: 'a-replaced-grant' }, 409, 'connection_changed'], [{ class_run_id: '../x' }, 400, undefined]]) {
      const r = await req(SH, 'POST', body('bad-' + status + (reason ?? ''), A, patch), sa); assert.deepEqual([r.status, r.json.reason], [status, reason], JSON.stringify(patch));
    }
    // A web request (no class named) in a class the Service has an assignment for is held to the same recipient.
    const web = await req(SH, 'POST', { id: 'web-other', recipient_id: 'teacher-b', kind: 'help', consent: true, duration_minutes: 30, content: { prompt: 'p' } }, sa); assert.deepEqual([web.status, web.json.reason], [409, 'recipient_not_assigned']);
    assert.equal(shareCount(), 0, 'no refused request wrote a row');
  });

  let first;
  await check('AT-03/47 a help request with only the learner\'s own question; exact content, recipient and token-capped expiry are what was stored', async () => {
    const r = await req(SH, 'POST', body('help-1', A), sa); assert.equal(r.status, 201, r.raw); first = r.json;
    assert.deepEqual(first.content, { question: '[합성] 예약 버튼이 안 보여요', prompt: '', response: '', tool_summary: '', artifact_url: '', verification: '' });
    assert.deepEqual([first.recipient_id, first.session_id, first.status, first.revision], ['teacher-a', L.run, 'received', 1]);
    const p = await verify(sa, L.env.HPS_SIGNING_SECRET); assert.equal(first.expires_at, Math.min(p.exp, first.created_at + 30 * 60));
    // a request without the new field keeps the exact stored shape it always had (no `question` key)
    const legacy = await req(SH, 'POST', body('help-legacy', A, { content: { prompt: '내 질문', response: 'AI 답' } }), sa); assert.equal(legacy.status, 201); assert.ok(!('question' in legacy.json.content));
    assert.equal((await req(SH + '/help-legacy', 'DELETE', undefined, sa)).status, 200);
    const empty = await req(SH, 'POST', body('help-empty', A, { content: { question: '   ' } }), sa); assert.equal(empty.status, 400, 'nothing selected is not a request');
    const secret = await req(SH, 'POST', body('help-secret', A, { content: { question: 'ANTHROPIC_API_KEY=sk-ant-' + 'x'.repeat(40) } }), sa); assert.equal(secret.status, 201); assert.ok(!secret.raw.includes('x'.repeat(40)), 'secrets are masked in the learner\'s own words too');
    assert.equal((await req(SH + '/help-secret', 'DELETE', undefined, sa)).status, 200);
  });

  await check('AT-03/47 lost response: the same id and envelope returns the stored record; any change of the envelope is a conflict', async () => {
    const again = await req(SH, 'POST', body('help-1', A), sa); assert.equal(again.status, 200); assert.deepEqual(again.json, first);
    for (const [patch, what] of [[{ duration_minutes: 60 }, 'longer expiry'], [{ duration_minutes: 10 }, 'shorter expiry'], [{ content: { question: '다른 질문' } }, 'content'], [{ kind: 'submission' }, 'kind']]) {
      const r = await req(SH, 'POST', body('help-1', A, patch), sa); assert.deepEqual([r.status, r.json.reason], [409, 'request_id_conflict'], what);
    }
    assert.equal((await req(SH, 'POST', body('help-1', A), sb)).status, 403, 'another learner (not connected) never adopts the id');
    assert.equal(rows("SELECT count(*) n FROM classroom_shares WHERE id='help-1'")[0].n, 1); assert.equal(rows("SELECT expires_at FROM classroom_shares WHERE id='help-1'")[0].expires_at, first.expires_at, 'the granted expiry did not move');
  });

  await check('AT-05 instructor sees the native request in the class help queue; stale revisions lose; answered is not resolved', async () => {
    const q = await req(T + `?kind=help&status=open&session_id=${L.run}`); assert.deepEqual(q.json.shares.map((s) => s.id), ['help-1']); assert.ok(!q.raw.includes('예약 버튼'), 'the list is metadata only');
    const opened = await req(T + '/help-1'); assert.equal(opened.json.content.question, '[합성] 예약 버튼이 안 보여요');
    assert.equal((await req(T + '/help-1', 'GET', undefined, await L.teacher('teacher-b'))).status, 404, 'another instructor of the same cohort cannot open it');
    assert.equal((await req(SH + '/help-1/confirm', 'POST', { expected_revision: 1 }, sa)).status, 409, 'nothing to confirm before an answer');
    const answer = { expected_revision: 1, status: 'answered', feedback: '[합성] 화면 오른쪽 위를 보세요', next_action: '[합성] 미리보기에서 다시 확인' };
    const [x, y] = await Promise.all([req(T + '/help-1', 'PUT', answer), req(T + '/help-1', 'PUT', { ...answer, feedback: '다른 답' })]); assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    const mine = (await req(SH + `?session_id=${L.run}`, 'GET', undefined, sa)).json.shares.find((s) => s.id === 'help-1'); assert.deepEqual([mine.status, mine.revision], ['answered', 2]);
    assert.equal((await req(SH + '/help-1/confirm', 'POST', { expected_revision: 1 }, sa)).status, 409, 'a stale revision cannot confirm');
    assert.equal((await req(SH + '/help-1/confirm', 'POST', { expected_revision: 2 }, sb)).status, 409, 'another learner matches no row'); assert.equal(rows("SELECT status FROM classroom_shares WHERE id='help-1'")[0].status, 'answered', 'only the learner confirms');
  });

  await check('AT-47 class A ends, class B starts: A\'s id is not a new B request, a class change is refused before writing, history stays withdrawable', async () => {
    const B = await startClassB(), rb = await req(HR, 'GET', undefined, sa); assert.equal(rb.status, 200, rb.raw);
    assert.deepEqual([rb.json.class_run_id, rb.json.grant_id], [B.run, B.conn.grant_id], 'the recipient now comes from class B');
    // the lost-response retry of A's request, arriving in B with the same cohort/profile/student/recipient/content
    const retry = await req(SH, 'POST', { ...body('help-1', A), class_run_id: undefined, grant_id: undefined }, sa); assert.deepEqual([retry.status, retry.json.reason], [409, 'class_changed']);
    // the envelope still names class A while B is active: refused before any read/write
    const stale = await req(SH, 'POST', body('help-a-late', A), sa); assert.deepEqual([stale.status, stale.json.reason], [409, 'class_changed']); assert.equal(rows("SELECT count(*) n FROM classroom_shares WHERE id='help-a-late'")[0].n, 0);
    const now = await req(SH + `?session_id=${B.run}`, 'GET', undefined, sa); assert.deepEqual(now.json.shares, [], 'B\'s own queue does not show A\'s request');
    assert.equal((await req(SH + '?session_id=../x', 'GET', undefined, sa)).status, 400);
    const history = await req(SH, 'GET', undefined, sa); assert.deepEqual(history.json.shares.map((s) => [s.id, s.session_id]), [['help-1', L.run]], 'history keeps it, labelled with its own class');
    const inB = await req(SH, 'POST', body('help-b', rb.json), sa); assert.equal(inB.status, 201, inB.raw); assert.equal(inB.json.session_id, B.run);
    assert.equal((await req(SH + '/help-1', 'DELETE', undefined, sa)).status, 200, 'the old share is still withdrawable during class B'); assert.equal((await req(T + '/help-1')).status, 404);
    Object.assign(A, rb.json);
  });

  await check('AT-47 revoked or fenced instructor, replaced seat and unreadable storage all leave no recipient and write nothing', async () => {
    const before = shareCount(), rb = A;
    // 1. the instructor's token is revoked in KV (as an operator revocation writes it)
    const tp = await verify(L.teacherToken, L.env.HPS_SIGNING_SECRET); L.env._kv.set('revoked:' + tp.jti, JSON.stringify({ ts: new Date().toISOString() }));
    assert.deepEqual((await req(HR, 'GET', undefined, sa)).json, { available: false, reason: 'instructor_revoked' });
    assert.deepEqual([(await req(SH, 'POST', body('help-rev', rb), sa)).json.reason], ['instructor_revoked']); L.env._kv.delete('revoked:' + tp.jti);
    // 2. the D1 fence alone (re-scope / class close path) is enough
    L.db.prepare("INSERT INTO ops_issuer_fences(issuer_jti,state,reason,recorded_by,created_at,updated_at) VALUES(?,'revoked','issuer_revoked','test',?,?)").run(tp.jti, Date.now(), Date.now());
    assert.equal((await req(HR, 'GET', undefined, sa)).json.reason, 'instructor_revoked'); L.db.prepare('DELETE FROM ops_issuer_fences').run();
    assert.equal((await req(HR, 'GET', undefined, sa)).json.available, true, 'control: lifted → available again');
    // 3. unreadable assignment storage is unknown (503), never "no instructor" and never a write
    L.fail('FROM ops_grants g JOIN class_run_ops'); const u = await req(HR, 'GET', undefined, sa), up = await req(SH, 'POST', body('help-unk', rb), sa); L.fail('');
    assert.deepEqual([u.status, u.json.reason, up.status, up.json.reason], [503, 'unknown', 503, 'unknown']);
    // 4. the seat goes to another learner: the previous learner loses the recipient; the new one sees none of their shares
    const base = `/admin/cohorts/${L.cohort}/classroom/runs/ops-test-run-b`;
    assert.equal((await req(base, 'PUT', { expected_roster_revision: 1, seats: [{ seat_id: 'A1', student_id: 'student-c' }, { seat_id: 'A2', student_id: 'student-b' }], flags: { ops_observe: true } })).status, 200);
    assert.deepEqual((await req(HR, 'GET', undefined, sa)).json, { available: false, reason: 'not_connected' });
    assert.equal((await req(SH, 'POST', body('help-after-replace', rb), sa)).status, 403);
    const sc = await L.student('student-c'); assert.deepEqual([(await req(SH, 'GET', undefined, sc)).json.shares.length, (await req(HR, 'GET', undefined, sc)).json.reason], [0, 'not_connected'], 'the new learner inherits neither shares nor the old connection');
    assert.equal(shareCount(), before, 'nothing was written by any refused request');
  });

  await check('AT-14 expired share: unreadable to the instructor and not confirmable; withdrawal by its owner still answers', async () => {
    const id = 'help-b'; L.db.prepare('UPDATE classroom_shares SET expires_at=?,status=?,revision=2 WHERE id=?').run(Math.floor(Date.now() / 1000) - 5, 'answered', id);
    assert.equal((await req(T + '/' + id)).status, 404); assert.equal((await req(SH + '/' + id + '/confirm', 'POST', { expected_revision: 2 }, sa)).status, 409);
    assert.deepEqual((await req(SH, 'GET', undefined, sa)).json.shares, [], 'an expired share is not listed as open work'); assert.equal((await req(SH + '/' + id, 'DELETE', undefined, sa)).status, 200);
  });

  await check('AT-47 without operations the earlier web behaviour is unchanged and the native endpoint says so', async () => {
    const off = await localOps({ enabled: false });
    try {
      const t = await off.student('student-a'); assert.deepEqual((await off.request(HR, 'GET', undefined, t)).json, { available: false, reason: 'ops_disabled' });
      const r = await off.request(SH, 'POST', { id: 'web-1', recipient_id: 'teacher-a', kind: 'help', consent: true, duration_minutes: 30, content: { prompt: 'p' } }, t); assert.equal(r.status, 201, r.raw);
      const n = await off.request(SH, 'POST', { id: 'native-1', recipient_id: 'teacher-a', kind: 'help', consent: true, duration_minutes: 30, class_run_id: off.run, content: { question: 'q' } }, t); assert.deepEqual([n.status, n.json.reason], [403, 'ops_disabled'], 'a request that names its class needs an assignment');
    } finally { off.close(); }
  });

  await check('AT-07 a minor cohort stays closed before any help route (guardian-consent contract #1175 not in place)', async () => {
    const kid = await L.student('kid01', 'sk-biopharm-kids-2026-grade-3-4-s1', 'sk-biopharm-2026-a');
    for (const [p, m] of [[HR, 'GET'], [SH, 'GET'], [SH, 'POST']]) assert.equal((await req(p, m, m === 'POST' ? { id: 'k', recipient_id: 'teacher-a', kind: 'help', consent: true, duration_minutes: 30, content: { question: 'q' } } : undefined, kid)).status, 403, p + ' ' + m);
  });
  console.log(`${count} native help controls passed`);
} finally { L.close(); }
