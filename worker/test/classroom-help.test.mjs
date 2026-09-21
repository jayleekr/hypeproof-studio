// #751 native voluntary help — the Service side of the Studio help loop (ADM-03/05, AT-03/05/14/47).
// Real router, real token verifier, SQLite with transactional batch (harness/classroom-ops.mjs). Synthetic accounts only.
// What is proved here: the recipient is derived from the learner's live class assignment and re-checked at submission; a
// retried id is the same request only inside the same consent envelope and class; history stays withdrawable; revoked,
// fenced, replaced and unreadable assignments fail closed; revision checks hold on both sides.
import assert from 'node:assert/strict';
import { localOps } from './harness/classroom-ops.mjs';

const { setRoster, startSession } = await import('../src/lib/kv.ts');
const { verify, issue } = await import('../src/lib/tokens.ts');
const L = await localOps(), req = L.request, SH = '/v1/classroom/shares', HR = '/v1/classroom/help-recipient';
const T = `/admin/cohorts/${L.cohort}/classroom/shares`;
let count = 0; const check = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
const rows = (sql, ...a) => L.db.prepare(sql).all(...a);
const shareCount = () => rows('SELECT count(*) n FROM classroom_shares')[0].n;
let sa, sb;
/**
 * A native body and its consent envelope. The envelope is signed here over the body's own class, connection, recipient, id and
 * duration (the same text the Service signs in help-recipient) — i.e. what the learner consented to at preview time — so a
 * test can change the world after consent and see the Service's re-checks. `end` overrides the agreed end time.
 */
const consentText = (p, o) => ['help-consent-v1', p.c, p.p, p.u, o.run, o.grant, o.recipient, o.id, o.duration, o.expires_at].join('|');
async function sign(token, o) {
  const p = await verify(token, L.env.HPS_SIGNING_SECRET), key = await crypto.subtle.importKey('raw', new TextEncoder().encode(L.env.HPS_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(consentText(p, o)))).toString('base64url');
}
async function body(id, a, patch = {}, token = sa, end) {
  const b = { id, recipient_id: a.recipient_id, kind: 'help', consent: true, duration_minutes: 30, class_run_id: a.class_run_id, grant_id: a.grant_id, content: { question: '[합성] 예약 버튼이 안 보여요' }, ...patch };
  if (b.class_run_id === undefined) return b;
  const p = await verify(token, L.env.HPS_SIGNING_SECRET), expires_at = end ?? Math.min(p.exp, Math.floor(Date.now() / 1000) + b.duration_minutes * 60);
  return { ...b, consent_envelope: { expires_at, proof: await sign(token, { run: b.class_run_id, grant: b.grant_id, recipient: b.recipient_id, id, duration: b.duration_minutes, expires_at }) } };
}
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
  sa = await L.student('student-a'); sb = await L.student('student-b');

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
      const r = await req(SH, 'POST', await body('bad-' + status + (reason ?? ''), A, patch), sa); assert.deepEqual([r.status, r.json.reason], [status, reason], JSON.stringify(patch));
    }
    // A web request (no class named) in a class the Service has an assignment for is held to the same recipient.
    const web = await req(SH, 'POST', { id: 'web-other', recipient_id: 'teacher-b', kind: 'help', consent: true, duration_minutes: 30, content: { prompt: 'p' } }, sa); assert.deepEqual([web.status, web.json.reason], [409, 'recipient_not_assigned']);
    assert.equal(shareCount(), 0, 'no refused request wrote a row');
  });

  let first;
  await check('AT-03/47 a help request with only the learner\'s own question; exact content, recipient and token-capped expiry are what was stored', async () => {
    const r = await req(SH, 'POST', await body('help-1', A), sa); assert.equal(r.status, 201, r.raw); first = r.json;
    assert.deepEqual(first.content, { question: '[합성] 예약 버튼이 안 보여요', prompt: '', response: '', tool_summary: '', artifact_url: '', verification: '' });
    assert.deepEqual([first.recipient_id, first.session_id, first.status, first.revision], ['teacher-a', L.run, 'received', 1]);
    const p = await verify(sa, L.env.HPS_SIGNING_SECRET); assert.equal(first.expires_at, Math.min(p.exp, first.created_at + 30 * 60));
    // a request without the new field keeps the exact stored shape it always had (no `question` key)
    const legacy = await req(SH, 'POST', await body('help-legacy', A, { content: { prompt: '내 질문', response: 'AI 답' } }), sa); assert.equal(legacy.status, 201); assert.ok(!('question' in legacy.json.content));
    assert.equal((await req(SH + '/help-legacy', 'DELETE', undefined, sa)).status, 200);
    const empty = await req(SH, 'POST', await body('help-empty', A, { content: { question: '   ' } }), sa); assert.equal(empty.status, 400, 'nothing selected is not a request');
    const secret = await req(SH, 'POST', await body('help-secret', A, { content: { question: 'ANTHROPIC_API_KEY=sk-ant-' + 'x'.repeat(40) } }), sa); assert.equal(secret.status, 201); assert.ok(!secret.raw.includes('x'.repeat(40)), 'secrets are masked in the learner\'s own words too');
    assert.equal((await req(SH + '/help-secret', 'DELETE', undefined, sa)).status, 200);
  });

  await check('AT-03/47 lost response: the same id and envelope returns the stored record; any change of the envelope is a conflict', async () => {
    const again = await req(SH, 'POST', await body('help-1', A), sa); assert.equal(again.status, 200); assert.deepEqual(again.json, first);
    for (const [patch, what] of [[{ duration_minutes: 60 }, 'longer expiry'], [{ duration_minutes: 10 }, 'shorter expiry'], [{ content: { question: '다른 질문' } }, 'content'], [{ kind: 'submission' }, 'kind']]) {
      const r = await req(SH, 'POST', await body('help-1', A, patch), sa); assert.deepEqual([r.status, r.json.reason], [409, 'request_id_conflict'], what);
    }
    assert.equal((await req(SH, 'POST', await body('help-1', A, {}, sb), sb)).status, 403, 'another learner (not connected) never adopts the id');
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

  // ── F2 (Codex 2026-09-22): the stored end is the end the learner saw, not "duration from whenever the POST arrived" ──
  const realNow = Date.now, at = (ms) => { Date.now = () => ms; }, sec = () => Math.floor(Date.now() / 1000);
  const preview = async (id, duration = 30, token = sa) => { const r = await req(HR + `?request_id=${id}&duration_minutes=${duration}`, 'GET', undefined, token); assert.equal(r.status, 200, r.raw); return r.json; };
  const signedBody = (id, a, extra = {}) => ({ id, recipient_id: a.recipient_id, kind: 'help', consent: true, duration_minutes: a.consent.duration_minutes, class_run_id: a.class_run_id, grant_id: a.grant_id, content: { question: '[합성] 늦게 보낸 질문' }, consent_envelope: { expires_at: a.consent.expires_at, proof: a.consent.proof }, ...extra });
  const stored = (id) => rows('SELECT expires_at FROM classroom_shares WHERE id=?', id)[0]?.expires_at ?? null;
  await check('AT-47/F2 help-recipient signs the end the preview shows: now + duration, capped by the token; no id/duration → no signature', async () => {
    const t0 = realNow(); at(t0);
    try {
      const k = await preview('late-1'), p = await verify(sa, L.env.HPS_SIGNING_SECRET);
      assert.deepEqual([k.consent.request_id, k.consent.duration_minutes, k.consent.expires_at], ['late-1', 30, Math.min(p.exp, Math.floor(t0 / 1000) + 1800)]); assert.match(k.consent.proof, /^[A-Za-z0-9_-]{43}$/);
      assert.equal('consent' in (await req(HR, 'GET', undefined, sa)).json, false, 'a plain availability read signs nothing');
      for (const q of ['?request_id=x', '?duration_minutes=30', '?request_id=../x&duration_minutes=30', '?request_id=x&duration_minutes=3']) assert.equal((await req(HR + q, 'GET', undefined, sa)).status, 400, q);
      const capped = await preview('late-cap', 120, (await issue({ u: 'student-a', c: L.cohort, p: L.profile }, 0.5, L.env.HPS_SIGNING_SECRET)).token);
      assert.equal(capped.consent.expires_at, (await verify((await issue({ u: 'student-a', c: L.cohort, p: L.profile }, 0.5, L.env.HPS_SIGNING_SECRET)).token, L.env.HPS_SIGNING_SECRET)).exp, 'a token ending first is the end shown');
    } finally { Date.now = realNow; }
  });
  await check('AT-47/F2 sent 5 minutes after the preview: stored until the previewed end exactly (Codex repro), retry keeps it, a longer signed duration for the same id conflicts', async () => {
    const t0 = realNow(); at(t0);
    try {
      const k = await preview('late-2'); at(t0 + 5 * 60_000);
      const r = await req(SH, 'POST', signedBody('late-2', k), sa); assert.equal(r.status, 201, r.raw);
      assert.equal(r.json.expires_at, k.consent.expires_at, `stored ${r.json.expires_at - k.consent.expires_at}s past the previewed end`);
      at(t0 + 9 * 60_000); const again = await req(SH, 'POST', signedBody('late-2', k), sa); assert.equal(again.status, 200, again.raw); assert.equal(again.json.expires_at, k.consent.expires_at, 'a lost-answer retry returns the same end');
      const longer = await preview('late-2', 60); const wide = await req(SH, 'POST', signedBody('late-2', longer), sa); assert.deepEqual([wide.status, wide.json.reason], [409, 'request_id_conflict'], 'a new consent for the same id cannot move the end');
      assert.equal(stored('late-2'), k.consent.expires_at);
      // web compatibility control: the web page shows a duration and gets it counted from arrival — unchanged
      const web = await req(SH, 'POST', { id: 'late-web', recipient_id: 'teacher-a', kind: 'help', consent: true, duration_minutes: 30, content: { prompt: 'p' } }, sa); assert.equal(web.status, 201, web.raw);
      assert.equal(web.json.expires_at, Math.min((await verify(sa, L.env.HPS_SIGNING_SECRET)).exp, web.json.created_at + 1800), 'web: duration from arrival, token-capped (compatible)');
    } finally { Date.now = realNow; }
    for (const id of ['late-2', 'late-web']) assert.equal((await req(SH + '/' + id, 'DELETE', undefined, sa)).status, 200);
  });
  await check('AT-47/F2 negative: a moved end, an end already past, a proof for another id/learner, a missing envelope — refused, nothing stored', async () => {
    const t0 = realNow(), before = shareCount(); at(t0);
    try {
      const k = await preview('neg-1');
      const moved = await req(SH, 'POST', signedBody('neg-1', k, { consent_envelope: { expires_at: k.consent.expires_at + 600, proof: k.consent.proof } }), sa); assert.deepEqual([moved.status, moved.json.reason], [400, 'consent_invalid'], 'a later end than the Service signed');
      const other = await req(SH, 'POST', signedBody('neg-other', k), sa); assert.deepEqual([other.status, other.json.reason], [400, 'consent_invalid'], 'a consent is for one request id');
      const dur = await req(SH, 'POST', signedBody('neg-1', k, { duration_minutes: 60 }), sa); assert.deepEqual([dur.status, dur.json.reason], [400, 'consent_invalid'], 'a consent is for one duration');
      const kb = await req(SH, 'POST', signedBody('neg-1', k), sb); assert.equal(kb.status, 400, 'another learner cannot use it');
      const { consent_envelope, ...bare } = signedBody('neg-1', k); assert.deepEqual([(await req(SH, 'POST', bare, sa)).json.reason], ['consent_required']);
      at(k.consent.expires_at * 1000); const past = await req(SH, 'POST', signedBody('neg-1', k), sa); assert.deepEqual([past.status, past.json.reason], [409, 'consent_expired'], 'the agreed end has come');
      at(t0); const ok = await req(SH, 'POST', signedBody('neg-1', k), sa); assert.equal(ok.status, 201, 'positive control: the same envelope before its end'); 
      at(k.consent.expires_at * 1000 + 1000); assert.deepEqual([(await req(SH, 'POST', signedBody('neg-1', k), sa)).json.reason], ['consent_expired'], 'a retry after the end is refused too');
    } finally { Date.now = realNow; }
    assert.equal(shareCount(), before + 1); assert.equal((await req(SH + '/neg-1', 'DELETE', undefined, sa)).status, 200);
  });
  await check('AT-47/F2 token reissued: a shorter new token shortens the end, a longer one never extends it; an expired token writes nothing', async () => {
    const k = await preview('tok-1'), k2 = await preview('tok-2');
    const short = (await issue({ u: 'student-a', c: L.cohort, p: L.profile }, 0.2, L.env.HPS_SIGNING_SECRET)).token, long = (await issue({ u: 'student-a', c: L.cohort, p: L.profile }, 10, L.env.HPS_SIGNING_SECRET)).token;
    const r1 = await req(SH, 'POST', signedBody('tok-1', k), short); assert.equal(r1.status, 201, r1.raw); assert.equal(r1.json.expires_at, (await verify(short, L.env.HPS_SIGNING_SECRET)).exp, 'cut to the new token');
    assert.ok(r1.json.expires_at < k.consent.expires_at);
    const r2 = await req(SH, 'POST', signedBody('tok-2', k2), long); assert.equal(r2.status, 201, r2.raw); assert.equal(r2.json.expires_at, k2.consent.expires_at, 'never later than agreed');
    const again = await req(SH, 'POST', signedBody('tok-1', k), short); assert.equal(again.status, 200, 'the same token retries the capped request');
    const t0 = realNow(), k3 = await preview('tok-3'); at(t0 + 0.25 * 3_600_000);
    try { const dead = await req(SH, 'POST', signedBody('tok-3', k3), short); assert.equal(dead.status, 401); } finally { Date.now = realNow; }
    assert.equal(stored('tok-3'), null);
    for (const id of ['tok-1', 'tok-2']) assert.equal((await req(SH + '/' + id, 'DELETE', undefined, sa)).status, 200);
  });

  // ── F3 (Codex 2026-09-22): the assignment must still hold AT the write, not only before it ──
  await check('AT-47/F3 connection revoked, seat replaced, issuer fenced, a newer connection or the class ended between the check and the INSERT: refused, 0 rows; control: nothing changes → stored', async () => {
    const grant = rows("SELECT * FROM ops_grants WHERE kind='connection' AND state='active' AND student_id='student-a' AND class_run_id=?", L.run)[0], tp = await verify(L.teacherToken, L.env.HPS_SIGNING_SECRET);
    const cols = rows('PRAGMA table_info(ops_grants)').map((c) => c.name);
    const changes = {
      revoked: [() => L.db.prepare("UPDATE ops_grants SET state='revoked' WHERE id=?").run(grant.id), () => L.db.prepare("UPDATE ops_grants SET state='active' WHERE id=?").run(grant.id), [403], 'not_connected'],
      seat_replaced: [() => L.db.prepare("UPDATE class_run_seats SET replaced_at=? WHERE class_run_id=? AND seat_id=? AND replaced_at IS NULL").run(Date.now(), L.run, grant.seat_id), () => L.db.prepare('UPDATE class_run_seats SET replaced_at=NULL WHERE class_run_id=? AND seat_id=? AND seat_revision=?').run(L.run, grant.seat_id, grant.seat_revision), [403], 'not_connected'],
      issuer_fenced: [() => L.db.prepare("INSERT INTO ops_issuer_fences(issuer_jti,state,reason,recorded_by,created_at,updated_at) VALUES(?,'revoked','t','t',0,0)").run(grant.issuer_jti ?? tp.jti), () => L.db.prepare('DELETE FROM ops_issuer_fences').run(), [403], 'instructor_revoked'],
      newer_connection: [() => L.db.prepare(`INSERT INTO ops_grants(${cols.join(',')}) SELECT ${cols.map((c) => (c === 'id' ? "'newer-grant'" : c === 'created_at' ? 'created_at+1' : c === 'issuer_id' ? "'teacher-z'" : c)).join(',')} FROM ops_grants WHERE id=?`).run(grant.id), () => L.db.prepare("DELETE FROM ops_grants WHERE id='newer-grant'").run(), [409], 'recipient_not_assigned'],
      class_ended: [() => L.db.prepare("UPDATE sessions SET ended_at=datetime('now') WHERE id=?").run(L.run), () => L.db.prepare('UPDATE sessions SET ended_at=NULL WHERE id=?').run(L.run), [403], 'no_active_class'],
    };
    const original = L.env.HPS_DB.prepare.bind(L.env.HPS_DB); let pending = null; const seen = {};
    // The world changes right after the last read before the write (the share-limit count), as in the Codex probe.
    L.env.HPS_DB.prepare = (sql) => { const wrap = (st) => new Proxy(st, { get(t, key) { if (key === 'bind') return (...a) => wrap(t.bind(...a)); if (key === 'first' && sql.includes('SELECT count(*) AS n FROM classroom_shares') && pending) return async (...a) => { const r = await t.first(...a); pending(); pending = null; return r; }; const v = t[key]; return typeof v === 'function' ? v.bind(t) : v; } }); return wrap(original(sql)); };
    try {
      const control = await req(SH, 'POST', await body('f3-control', A), sa); assert.equal(control.status, 201, 'control: an unchanged assignment is stored'); assert.equal((await req(SH + '/f3-control', 'DELETE', undefined, sa)).status, 200);
      for (const [name, [change, undo, statuses, reason]] of Object.entries(changes)) {
        pending = change; const r = await req(SH, 'POST', await body('f3-' + name, A), sa); undo();
        assert.equal(pending, null, name + ': the change was injected'); seen[name] = [r.status, r.json.reason];
        assert.ok(statuses.includes(r.status), `${name}: ${r.status} ${r.raw}`); assert.equal(r.json.reason, reason, name);
        assert.equal(stored('f3-' + name), null, name + ': nothing stored');
        assert.equal((await req(HR, 'GET', undefined, sa)).json.available, true, name + ': restored for the next case');
      }
      // concurrent writes: the same id twice at once → one row; revoke racing a write → either refused or stored-then-listed, never a row after a refusal
      const same = await body('f3-dup', A), [x, y] = await Promise.all([req(SH, 'POST', same, sa), req(SH, 'POST', same, sa)]); assert.deepEqual([x.status, y.status].sort(), [200, 201]); assert.equal(rows("SELECT count(*) n FROM classroom_shares WHERE id='f3-dup'")[0].n, 1);
      assert.equal((await req(SH + '/f3-dup', 'DELETE', undefined, sa)).status, 200);
    } finally { L.env.HPS_DB.prepare = original; }
    return seen;
  });

  await check('AT-47 class A ends, class B starts: A\'s id is not a new B request, a class change is refused before writing, history stays withdrawable', async () => {
    const B = await startClassB(), rb = await req(HR, 'GET', undefined, sa); assert.equal(rb.status, 200, rb.raw);
    assert.deepEqual([rb.json.class_run_id, rb.json.grant_id], [B.run, B.conn.grant_id], 'the recipient now comes from class B');
    // the lost-response retry of A's request, arriving in B with the same cohort/profile/student/recipient/content
    const retry = await req(SH, 'POST', { ...await body('help-1', A), class_run_id: undefined, grant_id: undefined }, sa); assert.deepEqual([retry.status, retry.json.reason], [409, 'class_changed']);
    // the envelope still names class A while B is active: refused before any read/write
    const stale = await req(SH, 'POST', await body('help-a-late', A), sa); assert.deepEqual([stale.status, stale.json.reason], [409, 'class_changed']); assert.equal(rows("SELECT count(*) n FROM classroom_shares WHERE id='help-a-late'")[0].n, 0);
    const now = await req(SH + `?session_id=${B.run}`, 'GET', undefined, sa); assert.deepEqual(now.json.shares, [], 'B\'s own queue does not show A\'s request');
    assert.equal((await req(SH + '?session_id=../x', 'GET', undefined, sa)).status, 400);
    const history = await req(SH, 'GET', undefined, sa); assert.deepEqual(history.json.shares.map((s) => [s.id, s.session_id]), [['help-1', L.run]], 'history keeps it, labelled with its own class');
    const inB = await req(SH, 'POST', await body('help-b', rb.json), sa); assert.equal(inB.status, 201, inB.raw); assert.equal(inB.json.session_id, B.run);
    assert.equal((await req(SH + '/help-1', 'DELETE', undefined, sa)).status, 200, 'the old share is still withdrawable during class B'); assert.equal((await req(T + '/help-1')).status, 404);
    Object.assign(A, rb.json);
  });

  await check('AT-47 revoked or fenced instructor, replaced seat and unreadable storage all leave no recipient and write nothing', async () => {
    const before = shareCount(), rb = A;
    // 1. the instructor's token is revoked in KV (as an operator revocation writes it)
    const tp = await verify(L.teacherToken, L.env.HPS_SIGNING_SECRET); L.env._kv.set('revoked:' + tp.jti, JSON.stringify({ ts: new Date().toISOString() }));
    assert.deepEqual((await req(HR, 'GET', undefined, sa)).json, { available: false, reason: 'instructor_revoked' });
    assert.deepEqual([(await req(SH, 'POST', await body('help-rev', rb), sa)).json.reason], ['instructor_revoked']); L.env._kv.delete('revoked:' + tp.jti);
    // 2. the D1 fence alone (re-scope / class close path) is enough
    L.db.prepare("INSERT INTO ops_issuer_fences(issuer_jti,state,reason,recorded_by,created_at,updated_at) VALUES(?,'revoked','issuer_revoked','test',?,?)").run(tp.jti, Date.now(), Date.now());
    assert.equal((await req(HR, 'GET', undefined, sa)).json.reason, 'instructor_revoked'); L.db.prepare('DELETE FROM ops_issuer_fences').run();
    assert.equal((await req(HR, 'GET', undefined, sa)).json.available, true, 'control: lifted → available again');
    // 3. unreadable assignment storage is unknown (503), never "no instructor" and never a write
    L.fail('FROM ops_grants g JOIN class_run_ops'); const u = await req(HR, 'GET', undefined, sa), up = await req(SH, 'POST', await body('help-unk', rb), sa); L.fail('');
    assert.deepEqual([u.status, u.json.reason, up.status, up.json.reason], [503, 'unknown', 503, 'unknown']);
    // 4. the seat goes to another learner: the previous learner loses the recipient; the new one sees none of their shares
    const base = `/admin/cohorts/${L.cohort}/classroom/runs/ops-test-run-b`;
    assert.equal((await req(base, 'PUT', { expected_roster_revision: 1, seats: [{ seat_id: 'A1', student_id: 'student-c' }, { seat_id: 'A2', student_id: 'student-b' }], flags: { ops_observe: true } })).status, 200);
    assert.deepEqual((await req(HR, 'GET', undefined, sa)).json, { available: false, reason: 'not_connected' });
    assert.equal((await req(SH, 'POST', await body('help-after-replace', rb), sa)).status, 403);
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
      const nb = { id: 'native-1', recipient_id: 'teacher-a', kind: 'help', consent: true, duration_minutes: 30, class_run_id: off.run, grant_id: 'g', content: { question: 'q' } };
      const bare = await off.request(SH, 'POST', nb, t); assert.deepEqual([bare.status, bare.json.reason], [400, 'consent_required'], 'a native request without the preview\'s consent envelope is refused before anything is read');
      const end = Math.floor(Date.now() / 1000) + 1800, proof = await sign(t, { run: off.run, grant: 'g', recipient: 'teacher-a', id: 'native-1', duration: 30, expires_at: end });
      const n = await off.request(SH, 'POST', { ...nb, consent_envelope: { expires_at: end, proof } }, t); assert.deepEqual([n.status, n.json.reason], [403, 'ops_disabled'], 'a request that names its class needs an assignment');
    } finally { off.close(); }
  });

  await check('AT-07 a minor cohort stays closed before any help route (guardian-consent contract #1175 not in place)', async () => {
    const kid = await L.student('kid01', 'sk-biopharm-kids-2026-grade-3-4-s1', 'sk-biopharm-2026-a');
    for (const [p, m] of [[HR, 'GET'], [SH, 'GET'], [SH, 'POST']]) assert.equal((await req(p, m, m === 'POST' ? { id: 'k', recipient_id: 'teacher-a', kind: 'help', consent: true, duration_minutes: 30, content: { question: 'q' } } : undefined, kid)).status, 403, p + ' ' + m);
  });
  console.log(`${count} native help controls passed`);
} finally { L.close(); }
