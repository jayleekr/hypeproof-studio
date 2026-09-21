// Remote classroom operations (#751, U2) — AT-44: targeted distribution of notices and materials, Service side.
//
// What is proven here is mostly what must NOT happen: a learner who was not selected gets no offer, no content and no
// row; nothing ever widens to everybody; an HTTP 200 or an offer is never counted as applied; a revoked instructor's
// queued distribution stops reaching learners EVEN WHEN another instructor paired them; a withdrawn v2 does not quietly
// become v1 again. Every interference case is preceded by its positive control in the same fixture.
// Synthetic accounts, SQLite. The device here speaks the wire protocol by hand; the real App inbox is exercised against
// these routes in classroom-ops-distribution-device.test.mjs, the browser e2e and the Mac run.
import assert from 'node:assert/strict';
import { localOps, OPS_ALL } from './harness/classroom-ops.mjs';
const { setRoster } = await import('../src/lib/kv.ts');
const lib = await import('../src/lib/classroom-distribution.ts');

let count = 0, cool = () => {}; async function check(name, fn) { cool(); await fn(); count++; console.log('PASS ' + name); }
const KEY = () => crypto.randomUUID();
const CAPS = ['observe', 'commands', 'retry_diagnostics', 'send_question', 'distribution_inbox'];

await check('controls: content is plain text, links are https on an allowlist that is EMPTY by default, and a selection is never widened', async () => {
  const ok = (o, hosts = []) => lib.normalizeContent({ kind: 'notice', title: '공지', body: '본문', ...o }, hosts);
  assert.equal(ok({}).ok, true, 'positive: a plain notice');
  assert.equal(ok({ kind: 'material', links: [{ label: '문서', url: 'https://docs.example.org/a?b=1' }] }, ['docs.example.org']).ok, true, 'positive: a material with an allowed link');
  // Markup is not refused — it is text. It is stored as typed and DRAWN as text on both ends (browser and webview tests).
  assert.equal(ok({ body: '<script>alert(1)</script> [x](javascript:alert(1)) rm -rf ~ /etc/passwd' }).ok, true);
  for (const [o, hosts, reason] of [
    [{ kind: 'video' }, [], 'content_invalid'], [{ kind: 'setting' }, [], 'content_invalid'] /* U3: a setting without a lesson reference (prompt/setting themselves are covered in classroom-ops-lesson-settings) */, [{ title: '' }, [], 'content_invalid'], [{ title: 'a\nb' }, [], 'content_invalid'], [{ title: 'x'.repeat(81) }, [], 'content_invalid'],
    [{ body: '가'.repeat(2001) }, [], 'content_invalid'], [{ body: 'bad\u0000byte' }, [], 'content_invalid'], [{ body: 'rtl\u202Eoverride' }, [], 'content_invalid'], [{ links: [{ label: 'a', url: 'https://docs.example.org/' }] }, ['docs.example.org'], 'content_invalid'] /* a notice carries no links */,
    [{ kind: 'material', links: [{ label: 'a', url: 'https://docs.example.org/' }] }, [], 'link_host_not_allowed'] /* empty allowlist = no link at all */,
    [{ kind: 'material', links: [{ label: 'a', url: 'https://evil.example.com/' }] }, ['docs.example.org'], 'link_host_not_allowed'],
    ...['http://docs.example.org/', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@docs.example.org/', 'https://docs.example.org:8443/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://printer.local/', 'https://0x7f000001/', 'https://docs.example.org/a b'].map((url) => [{ kind: 'material', links: [{ label: 'a', url }] }, ['docs.example.org', '127.0.0.1', 'localhost', 'printer.local'], 'content_invalid']),
    [{ kind: 'material', links: Array.from({ length: 6 }, () => ({ label: 'a', url: 'https://docs.example.org/' })) }, ['docs.example.org'], 'content_invalid'],
    [{ kind: 'material', links: [{ label: 'a', url: 'https://docs.example.org/', open: true }] }, ['docs.example.org'], 'content_invalid'],
  ]) assert.equal(ok(o, hosts).reason, reason, JSON.stringify(o));
  assert.deepEqual(lib.parseLinkHosts(' Docs.Example.org , ,bad host, x '), ['docs.example.org']);
  const base = { idempotency_key: KEY(), object_id: KEY(), revision: 1, content_hash: 'a'.repeat(64), expected_roster_revision: 1 }, n = (o) => lib.normalizeDistributionRequest({ ...base, ...o }, 200);
  assert.deepEqual(n({ targets: ['A3', 'A1'] }).value.targets, ['A1', 'A3'], 'positive: a selection, order-free');
  for (const [o, reason] of [[{}, 'targets_invalid'], [{ targets: [] }, 'targets_empty'], [{ targets: ['A1', 'A1'] }, 'targets_duplicate'], [{ targets: ['A 1'] }, 'targets_invalid'], [{ targets: 'all' }, 'targets_invalid'], [{ targets: ['A1'], all: true }, 'unknown_field'], [{ targets: ['A1'], seats: ['A2'] }, 'unknown_field'], [{ target: ['A1'] }, 'unknown_field'], [{ targets: ['A1'], expires: { at: -1 } }, 'request_invalid'], [{ targets: ['A1'], dry_run: 'yes' }, 'request_invalid'], [{ targets: Array.from({ length: 201 }, (_, i) => 'S' + i) }, 'targets_invalid']]) assert.equal(n(o).reason, reason, JSON.stringify(o));
  const c = (o) => lib.distributionRequestCanonical({ object_id: 'o', revision: 1, content_hash: 'h', targets: ['A1'], expires_at: 9, roster_revision: 1, ...o });
  for (const o of [{ revision: 2 }, { content_hash: 'i' }, { targets: ['A1', 'A3'] }, { expires_at: 10 }, { roster_revision: 2 }]) assert.notEqual(c(o), c({}), 'a different request is a different hash: ' + JSON.stringify(o));
});

await check('controls: delivery evidence only moves forward; an offer or a 200 is never "applied"; the card is a separate fact', async () => {
  const step = (a, b) => { const r = lib.nextDistState(a, b); return r.ok ? r.state : r.reason; };
  assert.deepEqual([step('accepted', 'received'), step('offered', 'received'), step('offered', 'reflected'), step('received', 'reflected'), step('offered', 'failed'), step('received', 'superseded')], ['received', 'received', 'reflected', 'reflected', 'failed', 'superseded']);
  assert.deepEqual([step('reflected', 'received'), step('reflected', 'failed'), step('failed', 'reflected'), step('revoked', 'reflected'), step('expired', 'reflected'), step('target_changed', 'reflected'), step('no_change', 'reflected'), step('received', 'received'), step('offered', 'applied')], ['final', 'final', 'final', 'final', 'final', 'final', 'final', 'backwards', 'unknown_stage']);
  assert.deepEqual([step('unconfirmed', 'reflected'), step('unconfirmed', 'failed')], ['reflected', 'final'], 'a late truthful reflected is the one thing that moves an unconfirmed target');
  const s = (t, card, allowed = true) => { const r = lib.distStatus({ state: 'reflected', result_code: '', revision: 2, content_hash: 'h2', offers: 1, distribution_revoked: false, connected: true, ...t }, card, { new_request_allowed: allowed }); return [r.phase, r.card, r.in_progress, r.can_change, r.reselectable].join(' '); };
  const table = [
    [{ state: 'accepted', connected: false }, null, 'accepted_offline none false true false'], [{ state: 'accepted' }, null, 'accepted none true true false'], [{ state: 'offered' }, null, 'offered none true true false'],
    [{ state: 'received' }, null, 'received none true true false'], [{}, { state: 'present', revision: 2, content_hash: 'h2' }, 'reflected present false false false'],
    [{ state: 'no_change' }, { state: 'present', revision: 2, content_hash: 'h2' }, 'no_change present false false false'],
    [{ distribution_revoked: true }, { state: 'present', revision: 2, content_hash: 'h2' }, 'reflected covered false false false'],          // withdrawn run, card kept by another run of the SAME revision
    [{ revision: 1, content_hash: 'h1' }, { state: 'present', revision: 2, content_hash: 'h2' }, 'reflected replaced false false false'],       // evidence of v1 stays; what is shown now is v2
    [{ revision: 1, content_hash: 'h1' }, { state: 'withdrawn', revision: 2, content_hash: 'h2' }, 'reflected none false false false'],          // …and an old v1 run does NOT make a withdrawn v2 "present"
    [{}, { state: 'withdraw_pending', revision: 2, content_hash: 'h2' }, 'reflected withdraw_pending false true false'], [{}, { state: 'withdrawn', revision: 2, content_hash: 'h2' }, 'reflected withdrawn false false false'],
    [{}, { state: 'withdraw_unconfirmed', revision: 2, content_hash: 'h2' }, 'reflected withdraw_unconfirmed false false false'], [{}, { state: 'detached', revision: 2, content_hash: 'h2' }, 'reflected detached false false false'],
    [{ state: 'failed', result_code: 'store_failed' }, null, 'failed none false false true'], [{ state: 'unconfirmed' }, null, 'unconfirmed none false true true'], [{ state: 'expired' }, null, 'expired none false false true'],
    [{ state: 'expired' }, null, 'expired none false false false', false], [{ state: 'superseded' }, null, 'superseded none false false false'], [{ state: 'revoked' }, null, 'revoked none false false false'],
    // withdrawn while a RECORDED offer was in flight: no delivery was proved, but the card the Service is taking down is shown — never when nothing was offered, never a card another run keeps
    [{ state: 'revoked' }, { state: 'withdraw_pending', revision: 2, content_hash: 'h2' }, 'revoked withdraw_pending false true false'], [{ state: 'revoked' }, { state: 'withdrawn', revision: 2, content_hash: 'h2' }, 'revoked withdrawn false false false'],
    [{ state: 'revoked', offers: 0 }, { state: 'withdrawn', revision: 2, content_hash: 'h2' }, 'revoked none false false false'], [{ state: 'revoked' }, { state: 'present', revision: 2, content_hash: 'h2' }, 'revoked none false false false'],
    [{ state: 'revoked', revision: 1, content_hash: 'h1' }, { state: 'withdrawn', revision: 2, content_hash: 'h2' }, 'revoked none false false false'],
    [{ state: 'target_changed' }, null, 'target_changed none false false false'], [{ state: 'some_future_state' }, null, 'unknown none false true false'],
  ];
  for (const [t, card, want, allowed] of table) assert.equal(s(t, card, allowed ?? true), want, JSON.stringify([t, card]));
  const sum = lib.summarizeDistribution([lib.distStatus({ state: 'reflected', result_code: '', revision: 1, content_hash: 'h', offers: 1, distribution_revoked: false, connected: true }, { state: 'present', revision: 1, content_hash: 'h' }, { new_request_allowed: true }), lib.distStatus({ state: 'offered', result_code: '', revision: 1, content_hash: 'h', offers: 3, distribution_revoked: false, connected: true }, null, { new_request_allowed: true })]);
  assert.deepEqual([sum.all_reflected, sum.reflected, sum.in_progress, sum.settled], [false, 1, 1, false], 'one open target = not "all reflected", not settled');
  assert.deepEqual([lib.applyWithinMs(100_000), lib.applyWithinMs(20_000), lib.applyWithinMs(5_000), lib.applyWithinMs(-1)], [30_000, 15_000, 0, 0], 'the device never gets more time than is left, minus its own request limit');
  assert.deepEqual([1, 2, 3, 4, 10, 11].map(lib.offerDelayMs), [5000, 10000, 20000, 60000, 300000, 300000]);
  assert.notEqual(await lib.deliveryKey(lib.offerKeyInput({ distribution_id: 'd', seat_id: 's', device_generation: 0, grant_id: 'g', connection_epoch: 1, object_id: 'o', revision: 1, content_hash: 'h' })), await lib.deliveryKey(lib.offerKeyInput({ distribution_id: 'd', seat_id: 's', device_generation: 0, grant_id: 'g', connection_epoch: 2, object_id: 'o', revision: 1, content_hash: 'h' })), 'a new login generation is a new key');
});

const f = await localOps();
const students = ['a', 'b', 'c', 'd', 'e'].map((x, i) => ({ seat_id: 'A' + (i + 1), student_id: 'student-' + x }));
const ALL_FLAGS = { ops_observe: true, ops_commands: true, ops_collect: true, ops_distribute: true };
const rows = (sql, ...a) => f.db.prepare(sql).all(...a).map((r) => ({ ...r })), one = (sql, ...a) => { const r = f.db.prepare(sql).get(...a); return r ? { ...r } : r; };
// The per-minute limit is a clock. Each check starts a minute later; the limit itself is exercised in D14.
cool = () => f.db.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run();
const tables = () => Object.fromEntries(['classroom_content_objects', 'classroom_content_revisions', 'classroom_distributions', 'classroom_distribution_targets', 'classroom_distribution_cards'].map((t) => [t, one(`SELECT count(*) n FROM ${t}`).n]));
try {
  await setRoster(f.env.HPS_KV, f.cohort, [...students.map((s) => s.student_id), 'student-z']); await f.freeze();
  assert.equal((await f.configure(students, 0, { flags: ALL_FLAGS })).status, 201);
  let roster = 1;
  // X may distribute. Y holds EVERY other capability (the harness default). A only distributes and paired nobody; B paired everyone.
  const X = await f.teacher('teacher-x', [...OPS_ALL, 'distribute']), Y = f.teacherToken, A = await f.teacher('teacher-a-dist', ['observe', 'distribute']);
  const save = (body, token = X, key = KEY()) => f.request(f.base + '/contents', 'POST', { idempotency_key: key, ...body }, token);
  const send = (o, token = X, key = KEY()) => f.request(f.base + '/distributions', 'POST', { idempotency_key: key, expected_roster_revision: roster, ...o }, token);
  const view = (id, token = X) => f.request(f.base + '/distributions/' + id, 'GET', undefined, token);
  const dsync = (conn, n, distribution) => f.sync(conn.credential, [], n, distribution === undefined ? {} : { distribution });
  const receipt = (item, stage, result_code = '') => ({ offer_key: item.offer_key, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, seq: item.seq, stage, result_code, observed_at: Date.now() });
  const now0 = () => f.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); // the re-offer spacing is a clock; tests skip the wait, never the rule
  const hold = async (conn, n, item) => { const r = await dsync(conn, n, { receipts: [receipt(item, 'received'), receipt(item, 'reflected')] }); assert.deepEqual(r.json.distribution.receipt_acks.map((a) => [a.stage, a.recorded]), [['received', true], ['reflected', true]], r.raw); return r; };
  const stateOf = (id, seat) => one('SELECT state,result_code,offers,pending FROM classroom_distribution_targets WHERE distribution_id=? AND seat_id=?', id, seat);
  const card = (seat, object) => one('SELECT state,revision,withdraw_seq FROM classroom_distribution_cards WHERE class_run_id=? AND seat_id=? AND object_id=?', f.run, seat, object) ?? null;

  const conn = {}; for (const [i, s] of students.entries()) conn[s.seat_id] = (await f.pair(s.seat_id, 1, i + 1, i === 3 ? ['observe', 'commands'] /* A4: an app without an inbox */ : CAPS)).conn.json;
  await f.request(f.base + '/grants/' + conn.A5.grant_id, 'DELETE'); // A5 is offline

  let notice;
  await check('D2 authority: no other capability implies `distribute`; learners and other cohorts have no way in; the switches refuse', async () => {
    const before = tables();
    assert.deepEqual([(await save({ kind: 'notice', title: 't', body: 'b' }, Y)).json.reason, (await send({ object_id: KEY(), revision: 1, content_hash: 'a'.repeat(64), targets: ['A1'] }, Y)).json.reason, (await f.request(f.base + '/contents', 'GET', undefined, Y)).json.reason], ['ops_capability_missing', 'ops_capability_missing', 'ops_capability_missing'], 'Y holds observe, manage, command, reset, pause, coach, collect, review and DELIVER — none of them distributes');
    const other = await f.teacher('teacher-z', [...OPS_ALL, 'distribute'], 'another-cohort'); assert.equal((await save({ kind: 'notice', title: 't', body: 'b' }, other)).status, 403);
    for (const token of [await f.student('student-a'), conn.A1.credential, null]) { const r = await save({ kind: 'notice', title: 't', body: 'b' }, token); assert.ok([401, 403].includes(r.status), 'a learner token, an operations credential and no token: ' + r.status); }
    const status = await f.request(f.base + '/status', 'GET', undefined, X); assert.deepEqual(status.json.distribution, { enabled: true, held: true, link_hosts_configured: false });
    assert.deepEqual((await f.request(f.base + '/status')).json.distribution, { enabled: true, held: false, link_hosts_configured: false }, 'Y sees that the feature is on and that Y does not hold it');
    assert.deepEqual(status.json.seats.map((s) => s.distribution_inbox), ['declared', 'declared', 'declared', 'not_declared', 'unknown']);
    assert.deepEqual(tables(), before, 'every refusal wrote nothing');
  });

  await check('contents: an immutable revision per object; same key same content = same answer, same key other content = 409; a lost race keeps the author\'s text out of the way', async () => {
    const key = KEY(), r = await save({ kind: 'notice', title: '다음 시간 준비물', body: '노트북 충전기를 가져오세요.\nAPI key sk-ant-REDACTEDREDACTEDREDACTEDREDACTED00 는 공유하지 마세요.' }, X, key); assert.equal(r.status, 201, r.raw); notice = r.json;
    assert.equal(notice.revision, 1); assert.match(notice.content_hash, /^[a-f0-9]{64}$/);
    const stored = await f.request(`${f.base}/contents/${notice.object_id}/revisions/1`, 'GET', undefined, X); assert.ok(!stored.json.body.includes('sk-ant-REDACTED'), 'a pasted secret is masked before it is hashed or stored');
    assert.equal(await lib.contentHash({ kind: 'notice', title: stored.json.title, body: stored.json.body, links: [] }), notice.content_hash, 'the hash is of exactly what is stored — what a device re-hashes');
    const again = await save({ kind: 'notice', title: '다음 시간 준비물', body: '노트북 충전기를 가져오세요.\nAPI key sk-ant-REDACTEDREDACTEDREDACTEDREDACTED00 는 공유하지 마세요.' }, X, key); assert.deepEqual([again.status, again.json.object_id, again.json.replayed], [200, notice.object_id, true]);
    assert.equal((await save({ kind: 'notice', title: '다른 제목', body: 'x' }, X, key)).json.reason, 'idempotency_conflict');
    const v2 = await save({ kind: 'notice', title: '다음 시간 준비물 (수정)', body: '노트북과 충전기.', object_id: notice.object_id, expected_latest_revision: 1 }); assert.deepEqual([v2.status, v2.json.revision], [201, 2]);
    assert.equal((await save({ kind: 'notice', title: '늦은 수정', body: 'x', object_id: notice.object_id, expected_latest_revision: 1 })).json.reason, 'revision_conflict', 'two authors: the second one is told, not overwritten');
    assert.equal((await save({ kind: 'material', title: '종류 변경', body: 'x', object_id: notice.object_id, expected_latest_revision: 2 })).json.reason, 'kind_mismatch');
    assert.equal((await save({ kind: 'material', title: '링크', body: 'x', links: [{ label: 'a', url: 'https://docs.example.org/' }] })).json.reason, 'link_host_not_allowed', 'no host is allowed until the operator names one');
    assert.deepEqual(one('SELECT count(*) n FROM classroom_content_revisions WHERE object_id=?', notice.object_id), { n: 2 }); assert.equal(one('SELECT title FROM classroom_content_revisions WHERE object_id=? AND revision=1', notice.object_id).title, '다음 시간 준비물', 'revision 1 is still what it was');
    const list = await f.request(f.base + '/contents', 'GET', undefined, X); assert.deepEqual(list.json.contents.map((c) => [c.object_id, c.latest_revision, c.distributions, c.retired]), [[notice.object_id, 2, 0, false]]); assert.ok(!JSON.stringify(list.json).includes('충전기'), 'the list carries no body');
  });

  let d1;
  await check('D1 selected A1+A3, not A2: only the selected learners are offered anything — and an offer is not "applied"', async () => {
    const preview = await send({ object_id: notice.object_id, revision: 1, content_hash: notice.content_hash, targets: ['A1', 'A3', 'A4', 'A5'], dry_run: true }); assert.equal(preview.status, 200, preview.raw);
    assert.deepEqual(preview.json.targets.map((t) => [t.seat_id, t.expect]), [['A1', 'deliverable_now'], ['A3', 'deliverable_now'], ['A4', 'unsupported_app'], ['A5', 'offline_until_reconnect']]); assert.equal(preview.json.not_selected, 1);
    assert.equal(one('SELECT count(*) n FROM classroom_distributions').n, 0, 'a preview writes nothing');
    const r = await send({ object_id: notice.object_id, revision: 1, content_hash: notice.content_hash, targets: ['A3', 'A1'] }); assert.equal(r.status, 201, r.raw); d1 = r.json.distribution;
    assert.deepEqual(r.json.targets.map((t) => [t.seat_id, t.status.phase]), [['A1', 'accepted'], ['A3', 'accepted']]); assert.equal(r.json.summary.all_reflected, false, '201 = recorded. Nothing has been sent, let alone applied.');
    const a2 = await dsync(conn.A2, 2); assert.equal(a2.status, 200); assert.equal(a2.json.distribution, undefined, 'the unselected learner\'s sync carries no distribution block at all');
    const a1 = await dsync(conn.A1, 1); assert.equal(a1.json.distribution.items.length, 1, a1.raw); const item = a1.json.distribution.items[0];
    assert.deepEqual([item.object_id, item.revision, item.content_hash, item.kind, item.from, item.title], [notice.object_id, 1, notice.content_hash, 'notice', 'instructor', '다음 시간 준비물']); assert.ok(item.apply_within_ms > 0 && item.apply_within_ms <= 30000);
    assert.equal(await lib.contentHash({ kind: item.kind, title: item.title, body: item.body, links: item.links }), item.content_hash, 'the device can verify what it received');
    assert.deepEqual((await view(d1.id)).json.targets.map((t) => t.status.phase), ['offered', 'accepted'], 'offered = the Service put it in a response. Not received, not applied.');
    assert.equal((await dsync(conn.A1, 1)).json.distribution, undefined, 'not offered again inside the back-off');
    await hold(conn.A1, 1, item);
    const after = await view(d1.id); assert.deepEqual(after.json.targets.map((t) => [t.seat_id, t.status.phase, t.status.card]), [['A1', 'reflected', 'present'], ['A3', 'accepted', 'none']]); assert.deepEqual([after.json.summary.all_reflected, after.json.summary.reflected], [false, 1]);
    assert.deepEqual(rows('SELECT seat_id FROM classroom_distribution_targets ORDER BY seat_id').map((x) => x.seat_id), ['A1', 'A3'], 'A2 has no row');
    const a3 = await dsync(conn.A3, 3); await hold(conn.A3, 3, a3.json.distribution.items[0]); assert.equal((await view(d1.id)).json.summary.all_reflected, true, '"all reflected" only when every selected learner reported it');
    assert.deepEqual((await dsync(conn.A1, 1, { receipts: [receipt(item, 'reflected')] })).json.distribution.receipt_acks.map((a) => [a.recorded, a.reason]), [[true, 'recorded']], 'a resent receipt (lost ack) is the same answer and changes nothing');
    assert.ok(!JSON.stringify((await f.request(f.base + '/status', 'GET', undefined, X)).json).includes('충전기') && !rows('SELECT detail_json FROM ops_audit').some((a) => a.detail_json.includes('충전기')), 'the body is in neither the board nor the audit trail');
  });

  await check('D3+D4 an app without an inbox is "unsupported", an offline learner is "will be delivered when they reconnect" — neither is a silent success or a dead end', async () => {
    const r = await send({ object_id: notice.object_id, revision: 1, content_hash: notice.content_hash, targets: ['A4', 'A5'] }); assert.equal(r.status, 201, r.raw);
    assert.deepEqual(r.json.targets.map((t) => [t.seat_id, t.status.phase]), [['A4', 'accepted'], ['A5', 'accepted_offline']], 'offline is NOT decided as not_connected at enqueue time');
    f.db.prepare("UPDATE ops_latest_state SET last_received_at=0 WHERE seat_id='A4'").run(); // make this sync a state-cadence sync: the probe for an undeclared app rides that cadence
    const a4 = await dsync(conn.A4, 4); assert.equal(a4.status, 200); assert.equal(a4.json.distribution, undefined); assert.deepEqual(stateOf(r.json.distribution.id, 'A4'), { state: 'unsupported', result_code: 'capability_missing', offers: 0, pending: 0 });
    assert.equal((await f.command('retry_diagnostics', ['A4'], {}, X)).status, 202, 'the older app keeps every flow it had');
    const back = (await f.pair('A5', 1, 5, CAPS)).conn.json; const a5 = await dsync(back, 5); assert.equal(a5.json.distribution.items.length, 1, 'the SAME intent reaches the learner who came back — re-checked against the connection they have now');
    await hold(back, 5, a5.json.distribution.items[0]); conn.A5 = back; assert.equal(stateOf(r.json.distribution.id, 'A5').state, 'reflected');
  });

  await check('D7 duplicates: double click, lost response, the same key for something else, the same revision again', async () => {
    const key = KEY(), body = { object_id: notice.object_id, revision: 1, content_hash: notice.content_hash, targets: ['A2'] }, n = one('SELECT count(*) n FROM classroom_distributions').n;
    const [p, q] = await Promise.all([send(body, X, key), send(body, X, key)]); assert.deepEqual([p.status, q.status].sort(), [200, 201]); assert.equal(p.json.distribution.id, q.json.distribution.id);
    const lost = await send(body, X, key); assert.deepEqual([lost.status, lost.json.replayed, lost.json.distribution.id], [200, true, p.json.distribution.id], 'the response was lost: asking again is the same distribution');
    for (const other of [{ targets: ['A2', 'A3'] }, { revision: 2, content_hash: one('SELECT content_hash h FROM classroom_content_revisions WHERE object_id=? AND revision=2', notice.object_id).h }, { expires: { at: Date.now() + 60_000 } }]) assert.equal((await send({ ...body, ...other }, X, key)).json.reason, 'idempotency_conflict', JSON.stringify(other));
    assert.equal(one('SELECT count(*) n FROM classroom_distributions').n, n + 1);
    for (const [o, status, reason] of [[{ targets: [] }, 400, 'targets_empty'], [{ targets: ['A1'], all: true }, 400, 'unknown_field'], [{ targets: ['A1', 'Z9'] }, 404, 'seat_not_found'], [{ targets: ['A1'], content_hash: 'f'.repeat(64) }, 409, 'content_mismatch'], [{ targets: ['A1'], revision: 9 }, 404, 'content_not_found'], [{ targets: ['A1'], expected_roster_revision: 7 }, 409, 'revision_conflict']]) { const r = await send({ ...body, ...o }); assert.deepEqual([r.status, r.json.reason], [status, reason]); }
    assert.equal(one('SELECT count(*) n FROM classroom_distributions').n, n + 1, 'nothing was widened, nothing was written');
    // the same revision again, to a learner whose device already holds it: no new application, no second card
    const again = await send({ object_id: notice.object_id, revision: 1, content_hash: notice.content_hash, targets: ['A1'] }); assert.equal(again.json.targets[0].status.phase, 'accepted');
    assert.equal((await dsync(conn.A1, 1)).json.distribution, undefined, 'nothing is sent'); assert.deepEqual([stateOf(again.json.distribution.id, 'A1').state, stateOf(again.json.distribution.id, 'A1').result_code], ['no_change', 'same_revision_held']); assert.equal(one("SELECT count(*) n FROM classroom_distribution_cards WHERE seat_id='A1'").n, 1);
    const a2 = await dsync(conn.A2, 2); await hold(conn.A2, 2, a2.json.distribution.items[0]);
  });

  let m, m1, m2;
  await check('D8 order and units: v2 never becomes a late v1; a card stays only while something still permits the revision IT SHOWS', async () => {
    m = (await save({ kind: 'material', title: '자료 M', body: 'v1 본문' })).json; m2 = (await save({ kind: 'material', title: '자료 M', body: 'v2 본문', object_id: m.object_id, expected_latest_revision: 1 })).json; m1 = m;
    const dv1 = (await send({ object_id: m.object_id, revision: 1, content_hash: m1.content_hash, targets: ['A1', 'A2', 'A3'] })).json.distribution;
    const i1 = (await dsync(conn.A1, 1)).json.distribution.items[0]; await hold(conn.A1, 1, i1);              // A1 holds v1
    const held2 = (await dsync(conn.A2, 2)).json.distribution.items[0];                                          // A2's v1 is in flight (offered, not yet reported)
    const dv2 = (await send({ object_id: m.object_id, revision: 2, content_hash: m2.content_hash, targets: ['A1', 'A2', 'A3'] })).json.distribution;
    assert.deepEqual(['A2', 'A3'].map((s) => stateOf(dv1.id, s).state), ['superseded', 'superseded'], 'v1 that was still on its way stops the moment v2 is confirmed');
    assert.deepEqual((await dsync(conn.A2, 2, { receipts: [receipt(held2, 'reflected')] })).json.distribution.receipt_acks.map((a) => [a.recorded, a.reason]), [[false, 'final']], 'the late v1 report cannot turn the superseded target into "applied"');
    now0(); const i2 = (await dsync(conn.A1, 1)).json.distribution.items.find((x) => x.revision === 2); assert.ok(i2.seq > i1.seq, 'events of one object are numbered; a device applies only a higher number'); await hold(conn.A1, 1, i2);
    assert.deepEqual(card('A1', m.object_id), { state: 'present', revision: 2, withdraw_seq: null }, 'one card per object, now v2');
    assert.equal((await send({ object_id: m.object_id, revision: 1, content_hash: m1.content_hash, targets: ['A1'] })).json.targets[0].state, 'superseded', 'going back to v1 is refused at the commit; to go back, author v3 with the old text');
    // the same v2 once more (D3). D2 is then withdrawn: D3 still permits v2 → the card stays, no tombstone.
    const dv3 = (await send({ object_id: m.object_id, revision: 2, content_hash: m2.content_hash, targets: ['A1'] })).json.distribution; await dsync(conn.A1, 1); assert.equal(stateOf(dv3.id, 'A1').state, 'no_change');
    const rv2 = await f.request(`${f.base}/distributions/${dv2.id}/revoke`, 'POST', { expected_row_revision: 0 }, X); assert.equal(rv2.status, 200, rv2.raw);
    assert.deepEqual(rv2.json.targets.find((t) => t.seat_id === 'A1').status, { phase: 'reflected', card: 'covered', in_progress: false, can_change: false, reselectable: false }, 'the evidence of delivery stays; the card is kept by the other run of the same revision');
    assert.equal((await dsync(conn.A1, 1)).json.distribution, undefined, 'no tombstone for a covered card'); assert.equal(card('A1', m.object_id).state, 'present');
    // …now the LAST run that permits v2 is withdrawn. The old v1 run is still un-revoked — it must NOT keep (or bring back) anything.
    assert.equal(one('SELECT revoked_at FROM classroom_distributions WHERE id=?', dv1.id).revoked_at, null);
    assert.equal((await f.request(`${f.base}/distributions/${dv3.id}/revoke`, 'POST', { expected_row_revision: 0 }, X)).status, 200);
    assert.equal(card('A1', m.object_id).state, 'withdraw_pending', 'v2 has nothing left that permits it → it comes down; v1 is not quietly shown again');
    const w = (await dsync(conn.A1, 1)).json.distribution.withdraw; assert.equal(w.length, 1); assert.deepEqual([w[0].object_id, w[0].revision, w[0].reason], [m.object_id, 2, 'revoked']); assert.ok(w[0].seq > i2.seq, 'a withdrawal is a later event of the object than anything the device applied');
    assert.deepEqual((await view(dv1.id)).json.targets.find((t) => t.seat_id === 'A1').status.card, 'none', 'the v1 run shows delivered-then, not present-now');
    // an acknowledgement of an OFFER cannot settle a withdrawal, and the other way round
    assert.deepEqual((await dsync(conn.A1, 1, { withdraw_receipts: [{ withdraw_key: i2.offer_key, object_id: m.object_id, seq: w[0].seq, result: 'withdrawn', observed_at: Date.now() }] })).json.distribution.withdraw_acks.map((a) => [a.recorded, a.reason]), [[false, 'stale_withdraw']]);
    assert.deepEqual((await dsync(conn.A1, 1, { receipts: [{ ...receipt(i2, 'reflected'), offer_key: w[0].withdraw_key }] })).json.distribution.receipt_acks.map((a) => [a.recorded, a.reason]), [[false, 'stale_offer']]);
    const done = await dsync(conn.A1, 1, { withdraw_receipts: [{ withdraw_key: w[0].withdraw_key, object_id: m.object_id, seq: w[0].seq, result: 'withdrawn', observed_at: Date.now() }] }); assert.deepEqual(done.json.distribution.withdraw_acks.map((a) => [a.recorded, a.reason]), [[true, 'recorded']]);
    assert.equal(card('A1', m.object_id).state, 'withdrawn'); assert.deepEqual((await view(dv3.id)).json.targets[0].status, { phase: 'no_change', card: 'withdrawn', in_progress: false, can_change: false, reselectable: false }, 'past evidence and present availability agree: it WAS there, it is NOT there now');
    assert.deepEqual((await dsync(conn.A1, 1, { withdraw_receipts: [{ withdraw_key: w[0].withdraw_key, object_id: m.object_id, seq: w[0].seq, result: 'withdrawn', observed_at: Date.now() }] })).json.distribution.withdraw_acks.map((a) => a.recorded), [true], 'a duplicate acknowledgement is the same answer');
    // a PENDING run counts as coverage only while it is alive: D4 (v2, A3 offline-ish) covers, then fails → the card must come down after all
    now0(); const a3v2 = (await dsync(conn.A3, 3)).json.distribution; assert.equal(a3v2, undefined, 'A3 was only in the revoked run');
    const d5 = (await send({ object_id: m.object_id, revision: 2, content_hash: m2.content_hash, targets: ['A3'] })).json.distribution, i5 = (await dsync(conn.A3, 3)).json.distribution.items[0]; await hold(conn.A3, 3, i5);
    const d6 = (await send({ object_id: m.object_id, revision: 2, content_hash: m2.content_hash, targets: ['A3'] })).json.distribution; // pending second run for the same learner
    f.db.prepare("UPDATE classroom_distribution_targets SET state='offered',pending=1,offers=1 WHERE distribution_id=?").run(d6.id); // …that is mid-flight rather than already no_change
    await f.request(`${f.base}/distributions/${d5.id}/revoke`, 'POST', { expected_row_revision: 0 }, X); assert.equal(card('A3', m.object_id).state, 'present', 'covered by the run that is still on its way');
    f.db.prepare('UPDATE classroom_distributions SET expires_at=? WHERE id=?').run(Date.now() - 1, d6.id); await view(d6.id);
    assert.deepEqual([stateOf(d6.id, 'A3').state, card('A3', m.object_id).state], ['unconfirmed', 'withdraw_pending'], 'the covering run ended without delivering: coverage is settled again and the card comes down');
  });

  await check('D13 retire: the whole material comes down, nothing of it can be sent again — and a device whose connection is gone is "cannot be confirmed", never "removed"', async () => {
    // A2 holds notice v1 (from D7). A5 too. A5 then loses its connection for good.
    assert.deepEqual([card('A2', notice.object_id)?.state, card('A5', notice.object_id)?.state], ['present', 'present']);
    await f.request(f.base + '/grants/' + conn.A5.grant_id, 'DELETE', undefined, X);
    assert.equal((await f.request(`${f.base}/contents/${notice.object_id}/retire`, 'POST', { expected_latest_revision: 1 }, X)).json.reason, 'revision_conflict');
    const r = await f.request(`${f.base}/contents/${notice.object_id}/retire`, 'POST', { expected_latest_revision: 2 }, X); assert.deepEqual([r.status, r.json.retired], [200, true], r.raw);
    assert.equal((await f.request(`${f.base}/contents/${notice.object_id}/retire`, 'POST', { expected_latest_revision: 2 }, X)).json.replayed, true);
    assert.equal(one('SELECT count(*) n FROM classroom_distributions WHERE object_id=? AND revoked_at IS NULL', notice.object_id).n, 0);
    assert.equal((await send({ object_id: notice.object_id, revision: 1, content_hash: notice.content_hash, targets: ['A1'] })).json.reason, 'object_retired'); assert.equal((await save({ kind: 'notice', title: 'x', body: 'y', object_id: notice.object_id, expected_latest_revision: 2 })).json.reason, 'object_retired');
    const w = (await dsync(conn.A2, 2)).json.distribution.withdraw; assert.deepEqual([w[0].object_id, w[0].reason], [notice.object_id, 'retired']);
    await dsync(conn.A2, 2, { withdraw_receipts: [{ withdraw_key: w[0].withdraw_key, object_id: notice.object_id, seq: w[0].seq, result: 'withdrawn', observed_at: Date.now() }] }); assert.equal(card('A2', notice.object_id).state, 'withdrawn');
    const dist = one("SELECT distribution_id id FROM classroom_distribution_targets WHERE seat_id='A5' AND object_id=?", notice.object_id).id;
    assert.equal((await view(dist)).json.targets.find((t) => t.seat_id === 'A5').status.card, 'withdraw_unconfirmed', 'nobody can tell that device: not counted as removed');
  });

  await check('D2 revoking the DISTRIBUTING instructor: A distributes, B paired the learners — A\'s queued distribution stops at the D1 boundary, not at KV', async () => {
    const { verify } = await import('../src/lib/tokens.ts'), jtiOf = async (token) => (await verify(token, f.env.HPS_SIGNING_SECRET ?? (await import('./harness/index.mjs')).TEST_SECRET)).jti;
    const aJti = await jtiOf(A), admin = (path, method, body) => f.app.fetch(new Request('https://service.test' + path, { method, headers: { authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64'), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), f.env, { waitUntil() {} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const q = (await save({ kind: 'notice', title: 'A의 공지', body: 'A가 보냄' }, A)).json;
    // positive control: A's distribution reaches a learner paired by someone else
    const ok = (await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A1'] }, A)).json.distribution; now0(); const got = (await dsync(conn.A1, 1)).json.distribution.items.find((x) => x.distribution_id === ok.id); assert.ok(got, 'control'); await hold(conn.A1, 1, got);
    // ① queued for A2 and A3, then A is revoked. KV is made to LAG (the revocation never reaches the verifier here).
    const queued = (await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A2', 'A3'] }, A)).json.distribution;
    const inFlight = (await dsync(conn.A2, 2)).json.distribution.items.find((x) => x.distribution_id === queued.id); assert.ok(inFlight, 'A2 already has the response in hand when the revocation happens');
    const kvPut = f.env.HPS_KV.put.bind(f.env.HPS_KV); f.env.HPS_KV.put = async (k, ...rest) => (String(k).includes(aJti) ? undefined : kvPut(k, ...rest));
    // ⑤ the D1 half fails first: the answer is NOT ok, and the fence is NOT up — this is said, not hidden
    f.fail('ops_issuer_fences'); const failed = await admin('/admin/tokens/revoke', 'POST', { jti: aJti }); f.fail('');
    assert.deepEqual([failed.status, failed.json.ok, failed.json.kv_revoked], [500, false, true]); assert.equal((await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A5'] }, A)).status, 201, 'an incomplete revocation does not stop A yet — which is exactly what the 500 told the operator');
    const revoked = await admin('/admin/tokens/revoke', 'POST', { jti: aJti }); assert.deepEqual([revoked.status, revoked.json.ok], [200, true], 'the retry is idempotent');
    assert.deepEqual(['A2', 'A3'].map((s) => [stateOf(queued.id, s).state, stateOf(queued.id, s).result_code]), [['revoked', 'issuer_revoked'], ['revoked', 'issuer_revoked']]); assert.equal(one('SELECT revoke_reason r FROM classroom_distributions WHERE id=?', queued.id).r, 'issuer_revoked');
    now0(); assert.equal((await dsync(conn.A3, 3)).json.distribution?.items?.length ?? 0, 0, 'B\'s connection is alive and well — and A\'s distribution is no longer offered over it');
    assert.equal(one("SELECT state FROM ops_grants WHERE id=?", conn.A3.grant_id).state, 'active', 'B-paired connections were NOT closed by revoking A (they are B\'s)');
    // ② A's token still VERIFIES (KV lag). The enqueue guard reads D1.
    const late = await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A3'] }, A); assert.deepEqual([late.status, late.json.reason], [403, 'issuer_revoked']); assert.equal((await save({ kind: 'notice', title: 'x', body: 'y' }, A)).json.reason, 'issuer_revoked');
    // what had already LEFT cannot be recalled: A2 stored it. The Service does not pretend otherwise — it refuses the receipt and sends a withdrawal.
    const r = await dsync(conn.A2, 2, { receipts: [receipt(inFlight, 'received'), receipt(inFlight, 'reflected')] }); assert.deepEqual(r.json.distribution.receipt_acks.map((a) => [a.recorded, a.reason]), [[false, 'revoked'], [false, 'revoked']]);
    assert.equal(stateOf(queued.id, 'A2').state, 'revoked', 'never recorded as delivered'); assert.equal(r.json.distribution.withdraw.length, 1, 'the device that stored it is told to take it down on this very sync');
    assert.equal(card('A1', q.object_id).state, 'present', 'what A delivered BEFORE the revocation stays: revoking ends the authority to send, it does not retract what was sent');
    // ⑥ un-revoke restores the token, not the swept distributions
    const un = await admin('/admin/tokens/revoke/' + aJti, 'DELETE'); assert.equal(un.json.ok, true); assert.equal(one('SELECT state FROM ops_issuer_fences WHERE issuer_jti=?', aJti).state, 'lifted');
    assert.equal(stateOf(queued.id, 'A3').state, 'revoked', 'a swept distribution does not come back to life'); assert.equal((await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A3'] }, A)).status, 201, '…A sends it again if it is still wanted');
    f.env.HPS_KV.put = kvPut;
    // ③ re-scope: the replaced token is fenced in D1 before KV. Without `distribute` in the new scope its open distributions close; with it they stay.
    const mint = (body) => admin('/admin/issuers', 'POST', body), scope = (ops) => [{ cohort: f.cohort, profiles: [f.profile], ops }];
    const keep = await f.teacher('teacher-keep', ['observe', 'distribute']), keepJti = await jtiOf(keep), kq = (await save({ kind: 'notice', title: 'keep', body: 'k' }, keep)).json, kd = (await send({ object_id: kq.object_id, revision: 1, content_hash: kq.content_hash, targets: ['A3'] }, keep)).json.distribution;
    f.env.HPS_KV.put = async (k, ...rest) => (String(k).includes(keepJti) ? undefined : kvPut(k, ...rest)); // KV lags again: the replaced token still verifies
    const re1 = await mint({ instructor: 'teacher-keep', scopes: scope(['observe', 'distribute']), days: 1, revoke_jti: keepJti }); assert.equal(re1.status, 200, JSON.stringify(re1.json));
    assert.equal(stateOf(kd.id, 'A3').state, 'accepted', 're-issued WITH distribute: what is waiting for a learner is not cancelled'); assert.equal((await send({ object_id: kq.object_id, revision: 1, content_hash: kq.content_hash, targets: ['A2'] }, keep)).json.reason, 'issuer_revoked', '…but the OLD token cannot distribute any more');
    f.env.HPS_KV.put = kvPut;
    const drop = re1.json.token, dropJti = re1.json.jti, dd = (await send({ object_id: kq.object_id, revision: 1, content_hash: kq.content_hash, targets: ['A2'] }, drop)).json.distribution;
    f.fail('ops_issuer_fences'); const bad = await mint({ instructor: 'teacher-keep', scopes: scope(['observe']), days: 1, revoke_jti: dropJti }); f.fail('');
    assert.deepEqual([bad.status, bad.json.reason, bad.json.token], [500, 'distribute_fence_failed', undefined], 'the fence could not be written: no new token is handed out and nothing was revoked'); assert.equal((await send({ object_id: kq.object_id, revision: 1, content_hash: kq.content_hash, targets: ['A5'] }, drop)).status, 201);
    assert.equal((await mint({ instructor: 'teacher-keep', scopes: scope(['observe']), days: 1, revoke_jti: dropJti })).status, 200); assert.deepEqual([stateOf(dd.id, 'A2').state, stateOf(dd.id, 'A2').result_code], ['revoked', 'issuer_revoked'], 're-issued WITHOUT distribute: the authority was withdrawn, so what it queued stops');
  });

  await check('D5 commit boundary: a seat, the run, the switch or the material that changes BETWEEN the read and the write refuses the whole request — nothing is written', async () => {
    const q = (await save({ kind: 'notice', title: '경합', body: 'x' })).json, body = () => ({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A2', 'A3'] });
    assert.equal((await send(body())).status, 201, 'positive control: the same request without interference is recorded');
    const base = f.env.HPS_DB, inject = (fn) => { let done = false; f.env.HPS_DB = { prepare: (sql) => base.prepare(sql), batch: async (s) => { if (!done) { done = true; await fn(); } return base.batch(s); } }; }, restore = () => { f.env.HPS_DB = base; };
    const before = () => [tables().classroom_distributions, tables().classroom_distribution_targets];
    for (const [name, change, reason, undo] of [
      ['the switch goes off', () => f.db.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_distribute',json('false'))").run(), 'ops_distribute_disabled', () => f.db.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_distribute',json('true'))").run()],
      ['the instructor ends the class', () => f.db.prepare("UPDATE sessions SET ended_at='2026-01-01T00:00:00Z' WHERE id=?").run(f.run), 'run_ended', () => f.db.prepare('UPDATE sessions SET ended_at=NULL WHERE id=?').run(f.run)],
      ['the material is withdrawn', () => f.db.prepare('UPDATE classroom_content_objects SET retired_at=1 WHERE object_id=?').run(q.object_id), 'object_retired', () => f.db.prepare('UPDATE classroom_content_objects SET retired_at=NULL WHERE object_id=?').run(q.object_id)],
      ['a seat changes hands without a roster revision', () => f.db.prepare("UPDATE class_run_seats SET student_id='student-z' WHERE class_run_id=? AND seat_id='A3' AND replaced_at IS NULL").run(f.run), 'changed_during_request', () => f.db.prepare("UPDATE class_run_seats SET student_id='student-c' WHERE class_run_id=? AND seat_id='A3' AND replaced_at IS NULL").run(f.run)],
    ]) { const n = before(); inject(change); const r = await send(body()); restore(); await undo(); assert.deepEqual([r.status >= 400, r.json.reason], [true, reason], name + ': ' + r.raw); assert.deepEqual(before(), n, name + ': no run, no target'); }
    // the real path: the seat is re-assigned through the API (roster revision 2) while a request holds revision 1
    const n = before(); inject(async () => { restore(); const swapped = students.map((s) => s.seat_id === 'A3' ? { seat_id: 'A3', student_id: 'student-z' } : s); const r = await f.configure(swapped, roster, { flags: ALL_FLAGS }, X); assert.equal(r.status, 200, r.raw); });
    const raced = await send(body()); restore(); assert.deepEqual([raced.status, raced.json.reason], [409, 'revision_conflict']); assert.deepEqual(before(), n); roster = 2;
    assert.equal(one("SELECT count(*) n FROM classroom_distribution_targets WHERE student_id='student-z'").n, 0, 'the learner who took the seat was never a target');
    const open = rows("SELECT distribution_id id FROM classroom_distribution_targets WHERE seat_id='A3' AND state IN ('accepted','offered','received')"); assert.ok(open.length > 0, 'student-c had intents waiting');
    for (const o of open) assert.equal((await view(o.id)).json.targets.find((t) => t.seat_id === 'A3').status.phase, 'target_changed', 'student-c\'s intents end as "target changed"; nothing migrates to the new holder');
    const z = (await f.pair('A3', 2, 6, CAPS)).conn.json; now0(); assert.equal((await dsync(z, 6)).json.distribution, undefined, 'the new holder of A3 is offered nothing that was meant for the previous one');
    assert.equal((await dsync(conn.A3, 3)).status, 401, 'and the previous holder\'s connection was closed with the seat');
  });

  await check('D5 the OFFER commit boundary: what changes between reading the candidates and recording the offer keeps the item OUT of the answer — and an offer that WAS recorded is still withdrawn from the device', async () => {
    // Reproduced by an independent review on 51708c7 (management-20260921/u2-revoke-inbox-impact.mjs, u2-deferred-boundary-check.mjs):
    // a withdrawal that landed after the candidate SELECT left the item in the sync answer while its row said `revoked, offers=0`;
    // the device stored it, its receipts were refused as stale, and no withdrawal ever followed. Same for the switch and the seat.
    const { recordTokenIssue } = await import('../src/routes/classroom-ops.ts');
    const g = await localOps(); try {
      const two = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }]; await g.freeze(); let rev = 0;
      const configure = async (seats, flags) => { const r = await g.configure(seats, rev, { flags }, T2); assert.ok([200, 201].includes(r.status), r.raw); rev++; return r; };
      const T2 = await g.teacher('teacher-x', [...OPS_ALL, 'distribute']); await configure(two, { ops_observe: true, ops_distribute: true });
      let c1 = (await g.pair('A1', rev, 1, CAPS)).conn.json; const sync1 = (distribution) => g.sync(c1.credential, [], 1, distribution ? { distribution } : {});
      const call = (path, body) => g.request(g.base + path, 'POST', body, T2), fresh = async (title) => { const c = (await call('/contents', { idempotency_key: KEY(), kind: 'notice', title, body: '본문 ' + title })).json; g.db.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run(); const d = (await call('/distributions', { idempotency_key: KEY(), object_id: c.object_id, revision: 1, content_hash: c.content_hash, targets: ['A1'], expected_roster_revision: rev })).json.distribution; assert.ok(d?.id, title); return { c, d }; };
      const row = (d) => ({ ...g.db.prepare('SELECT state,offers,offer_key,pending FROM classroom_distribution_targets WHERE distribution_id=?').get(d.id) });
      // Freeze the result of ONE real SELECT and run a real competing request before it is used. The hook must fire, or the case proves nothing.
      const between = (match, action) => { const inner = g.env.HPS_DB; let fired = false; g.env.HPS_DB = { prepare(sql) { const st = inner.prepare(sql), w = { bind(...a) { st.bind(...a); return w; }, _run: () => st._run(), run: () => st.run(), first: (...a) => st.first(...a), all: async (...a) => { const r = await st.all(...a); if (!fired && match(sql)) { fired = true; g.env.HPS_DB = inner; await action(); } return r; } }; return w; }, batch: (s) => inner.batch(s) }; return () => { g.env.HPS_DB = inner; assert.equal(fired, true, 'the injection point no longer matches the SQL — fix the test before trusting it'); }; };
      const candidates = (sql) => sql.includes('c.revision AS card_revision') && sql.includes('t.next_offer_at'), receiptRead = (sql) => sql.includes('ob.retired_at FROM classroom_distribution_targets t');
      const rc = (item, stage) => ({ offer_key: item.offer_key, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, seq: item.seq, stage, result_code: '', observed_at: Date.now() });

      // positive control: nothing interferes → the item is in the answer AND its row says so
      const ok = await fresh('대조군'); const first = await sync1(); assert.equal(first.json.distribution.items.length, 1); assert.deepEqual([row(ok.d).state, row(ok.d).offers, row(ok.d).offer_key], ['offered', 1, first.json.distribution.items[0].offer_key], 'answer and ledger agree');
      await sync1({ receipts: [rc(first.json.distribution.items[0], 'received'), rc(first.json.distribution.items[0], 'reflected')] });

      for (const [name, interfere, expectState, restore] of [
        ['the instructor withdraws the run', (x) => call(`/distributions/${x.d.id}/revoke`, { expected_row_revision: 0 }), 'revoked'],
        ['the material is retired', (x) => call(`/contents/${x.c.object_id}/retire`, { expected_latest_revision: 1 }), 'revoked'],
        ['the run switch goes off (through the API)', () => configure(two, { ops_observe: true, ops_distribute: false }), 'accepted', () => configure(two, { ops_observe: true, ops_distribute: true })],
        ['the instructor ends the class', () => g.db.prepare("UPDATE sessions SET ended_at='2026-01-01T00:00:00Z' WHERE id=?").run(g.run), 'accepted', () => g.db.prepare('UPDATE sessions SET ended_at=NULL WHERE id=?').run(g.run)],
        ['the learner logs in again (new login generation)', () => recordTokenIssue(g.env, { jti: KEY(), cohort: g.cohort, student: 'student-a', profile: g.profile, issuedBy: 'teacher-x', hours: 1 }), 'accepted'],
        ['another window takes the seat lease', () => g.db.prepare("UPDATE ops_seat_leases SET app_instance_id='instance-other',generation=generation+1 WHERE grant_id=?").run(c1.grant_id), 'accepted', () => g.db.prepare('UPDATE ops_seat_leases SET app_instance_id=? WHERE grant_id=?').run(g.instance(1).app_instance_id, c1.grant_id)],
      ]) {
        const x = await fresh(name), audits = g.db.prepare('SELECT count(*) n FROM ops_audit').get().n, done = between(candidates, () => interfere(x)), r = await sync1(); done();
        assert.equal(r.status, 200, name); assert.equal((r.json.distribution?.items ?? []).filter((i) => i.distribution_id === x.d.id).length, 0, name + ': an offer that was not recorded must not be in the answer');
        assert.deepEqual([row(x.d).state, row(x.d).offers, row(x.d).offer_key], [expectState, 0, ''], name + ': the ledger says it was never offered — and that is now true');
        if (restore) { await restore(); g.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); const again = await sync1(); assert.equal((again.json.distribution?.items ?? []).filter((i) => i.distribution_id === x.d.id).length, 1, name + ': once the condition holds again, the same intent is offered'); await sync1({ receipts: [rc(again.json.distribution.items.find((i) => i.distribution_id === x.d.id), 'reflected')] }); }
        else if (expectState === 'accepted') { g.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); const again = await sync1(); const it = (again.json.distribution?.items ?? []).find((i) => i.distribution_id === x.d.id); assert.ok(it, name + ': offered again under the connection as it is NOW'); assert.equal(row(x.d).offer_key, it.offer_key); await sync1({ receipts: [rc(it, 'reflected')] }); }
      }
      // the seat changes hands through the API between the read and the write: the previous learner's device gets nothing
      const moved = await fresh('좌석 교체'), swap = between(candidates, () => configure([{ seat_id: 'A1', student_id: 'student-c' }, two[1]], { ops_observe: true, ops_distribute: true })), late = await sync1(); swap();
      assert.equal((late.json.distribution?.items ?? []).length, 0, 'the seat was re-assigned: nothing for the learner who just lost it'); assert.deepEqual([row(moved.d).offers, row(moved.d).offer_key], [0, '']); assert.equal((await sync1()).status, 401);
      await configure(two, { ops_observe: true, ops_distribute: true }); c1 = (await g.pair('A1', rev, 1, CAPS)).conn.json;

      // an offer that WAS recorded and is merely in flight when the run is withdrawn: the device stored it — it must come down
      const inflight = await fresh('이미 기록된 제안'); const sent = (await sync1()).json.distribution.items.find((i) => i.distribution_id === inflight.d.id); assert.equal(row(inflight.d).offers, 1);
      await call(`/distributions/${inflight.d.id}/revoke`, { expected_row_revision: 0 }); const told = await sync1({ receipts: [rc(sent, 'received'), rc(sent, 'reflected')] });
      assert.deepEqual(told.json.distribution.receipt_acks.map((a) => [a.recorded, a.reason, a.final]), [[false, 'revoked', true], [false, 'revoked', true]]); assert.equal(told.json.distribution.withdraw.length, 1, 'the device that holds it is sent the withdrawal at once'); assert.equal(row(inflight.d).state, 'revoked', 'and it is never recorded as delivered');

      // a RECEIPT that loses its compare-and-swap leaves nothing behind: no card, no audit row, and the answer is not final
      const cas = await fresh('receipt 경합'); const held = (await sync1()).json.distribution.items.find((i) => i.distribution_id === cas.d.id), auditsBefore = g.db.prepare("SELECT count(*) n FROM ops_audit WHERE action='distribution_reflected'").get().n;
      const lose = between(receiptRead, () => call(`/distributions/${cas.d.id}/revoke`, { expected_row_revision: 0 })), lost = await sync1({ receipts: [rc(held, 'reflected')] }); lose();
      assert.deepEqual(lost.json.distribution.receipt_acks.map((a) => [a.recorded, a.reason, a.final]), [[false, 'changed', false]], 'not recorded, and the device keeps the receipt'); assert.equal(g.db.prepare("SELECT count(*) n FROM ops_audit WHERE action='distribution_reflected'").get().n, auditsBefore, 'no audit row for a transition that did not happen');
      assert.equal(g.db.prepare('SELECT count(*) n FROM classroom_distribution_cards WHERE object_id=?').get(cas.c.object_id).n, 0, 'and no card'); assert.equal(row(cas.d).state, 'revoked');
      const retry = await sync1({ receipts: [rc(held, 'reflected')] }); assert.deepEqual(retry.json.distribution.receipt_acks.map((a) => [a.recorded, a.reason, a.final]), [[false, 'revoked', true]]); assert.equal(retry.json.distribution.withdraw.filter((w) => w.object_id === cas.c.object_id).length, 1, 'the resent receipt is read against the row as it is now: the device is told to take it down');

      // "already held" is decided at the commit too: the card is withdrawn between the read and the write → not no_change
      const base = await fresh('no_change 경합'); const b1 = (await sync1()).json.distribution.items.find((i) => i.distribution_id === base.d.id); await sync1({ receipts: [rc(b1, 'reflected')] });
      g.db.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run(); const dup = (await call('/distributions', { idempotency_key: KEY(), object_id: base.c.object_id, revision: 1, content_hash: base.c.content_hash, targets: ['A1'], expected_roster_revision: rev })).json.distribution;
      const gone = between(candidates, () => g.db.prepare("UPDATE classroom_distribution_cards SET state='withdrawn' WHERE object_id=?").run(base.c.object_id)), r2 = await sync1(); gone();
      assert.notEqual(row(dup).state, 'no_change', 'the card it relied on is gone: "already held" is not claimed'); assert.equal((r2.json.distribution?.items ?? []).filter((i) => i.distribution_id === dup.id).length, 0);
      g.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); assert.equal(((await sync1()).json.distribution?.items ?? []).filter((i) => i.distribution_id === dup.id).length, 1, '…so it is sent for real on the next sync');

      // A RECEIPT is recorded only under the identity it was read under (an independent review, u2-receipt-binding-boundary-check.mjs:
      // a re-login or a seat change landing after the receipt's row was read was still recorded as `reflected`, with a card and an audit row).
      const reflectedAudits = () => g.db.prepare("SELECT count(*) n FROM ops_audit WHERE action='distribution_reflected'").get().n, cardsOf = (x) => g.db.prepare('SELECT count(*) n FROM classroom_distribution_cards WHERE object_id=?').get(x.c.object_id).n;
      const idn = await fresh('receipt 신원'); g.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); const it1 = (await sync1()).json.distribution.items.find((i) => i.distribution_id === idn.d.id); assert.ok(it1); let audits0 = reflectedAudits();
      const relog = between(receiptRead, () => recordTokenIssue(g.env, { jti: KEY(), cohort: g.cohort, student: 'student-a', profile: g.profile, issuedBy: 'teacher-x', hours: 1 })), a1 = await sync1({ receipts: [rc(it1, 'reflected')] }); relog();
      assert.deepEqual(a1.json.distribution.receipt_acks.map((a) => [a.recorded, a.reason, a.final]), [[false, 'changed', false]], 're-login after the read: not recorded, not final'); assert.deepEqual([row(idn.d).state, cardsOf(idn), reflectedAudits() - audits0], ['offered', 0, 0], 'no state, no card, no audit row under the identity that was replaced');
      g.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); const a2 = await sync1({ receipts: [rc(it1, 'reflected')] }); assert.deepEqual(a2.json.distribution.receipt_acks.map((a) => [a.reason, a.final]), [['stale_offer', true]], 'the resend is judged under the login generation as it is now');
      const it1b = a2.json.distribution.items.find((i) => i.distribution_id === idn.d.id); assert.ok(it1b && it1b.offer_key !== it1.offer_key, 'and the same intent is offered again under it'); assert.deepEqual((await sync1({ receipts: [rc(it1b, 'reflected')] })).json.distribution.receipt_acks.map((a) => [a.recorded, a.final]), [[true, true]], 'positive control: under an unchanged identity the receipt is recorded'); assert.deepEqual([row(idn.d).state, cardsOf(idn)], ['reflected', 1]);
      // …the same for the device's confirmation of a withdrawal
      await call(`/distributions/${idn.d.id}/revoke`, { expected_row_revision: 0 }); const tomb = (await sync1()).json.distribution.withdraw.find((w) => w.object_id === idn.c.object_id); assert.ok(tomb);
      const wr = { withdraw_key: tomb.withdraw_key, object_id: tomb.object_id, seq: tomb.seq, result: 'withdrawn', observed_at: Date.now() }, cardRead = (sql) => sql.includes('SELECT state,withdraw_key,withdraw_seq FROM classroom_distribution_cards');
      const relog2 = between(cardRead, () => recordTokenIssue(g.env, { jti: KEY(), cohort: g.cohort, student: 'student-a', profile: g.profile, issuedBy: 'teacher-x', hours: 1 })), w1 = await sync1({ withdraw_receipts: [wr] }); relog2();
      assert.deepEqual(w1.json.distribution.withdraw_acks.map((a) => [a.recorded, a.reason, a.final]), [[false, 'changed', false]]); assert.equal(g.db.prepare('SELECT state FROM classroom_distribution_cards WHERE object_id=?').get(idn.c.object_id).state, 'withdraw_pending', 'the card is not marked removed under a replaced identity — the device keeps its receipt');
      // the seat changes hands after the receipt's row was read (this ends the connection, so it comes last)
      const sc = await fresh('receipt 좌석'); g.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); const it2 = (await sync1()).json.distribution.items.find((i) => i.distribution_id === sc.d.id); assert.ok(it2); audits0 = reflectedAudits();
      const swap2 = between(receiptRead, () => configure([{ seat_id: 'A1', student_id: 'student-c' }, two[1]], { ops_observe: true, ops_distribute: true })), a3 = await sync1({ receipts: [rc(it2, 'reflected')] }); swap2();
      assert.deepEqual((a3.json.distribution?.receipt_acks ?? []).map((a) => [a.recorded, a.final]), [[false, false]]); assert.deepEqual([cardsOf(sc), reflectedAudits() - audits0], [0, 0], 'nothing is recorded for a learner who no longer holds the seat'); assert.notEqual(row(sc.d).state, 'reflected');
    } finally { g.close(); }
  });

  await check('D6 token re-issue and device change: the old key is refused, the intent is offered again under the connection the learner has NOW', async () => {
    const { recordTokenIssue } = await import('../src/routes/classroom-ops.ts');
    const q = (await save({ kind: 'notice', title: '재발급', body: 'x' })).json, d = (await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A2'] })).json.distribution;
    now0(); const first = (await dsync(conn.A2, 2)).json.distribution.items.find((x) => x.distribution_id === d.id);
    await recordTokenIssue(f.env, { jti: KEY(), cohort: f.cohort, student: 'student-b', profile: f.profile, issuedBy: 'teacher-x', hours: 1 }); // the learner logged in again: login generation +1
    assert.deepEqual((await dsync(conn.A2, 2, { receipts: [receipt(first, 'reflected')] })).json.distribution.receipt_acks.map((a) => [a.recorded, a.reason]), [[false, 'stale_offer']], 'a receipt under the old login generation proves nothing about this one');
    now0(); const second = (await dsync(conn.A2, 2)).json.distribution.items.find((x) => x.distribution_id === d.id); assert.notEqual(second.offer_key, first.offer_key); await hold(conn.A2, 2, second);
    // an acknowledgement for the OLD key must not be able to clear the NEW journal entry: keys differ, so the device cannot match it
    assert.notEqual(first.offer_key, second.offer_key);
    // device change: same learner, a new one-time code on another PC
    const moved = (await f.pair('A2', 2, 7, CAPS)).conn.json; assert.deepEqual(stateOf(d.id, 'A2'), { state: 'accepted', result_code: '', offers: 0, pending: 1 }, 'the still-valid intent is owed to the new device');
    assert.equal(card('A2', q.object_id).state, 'detached', 'what the old PC held is not what this learner sees any more');
    assert.equal((await dsync(conn.A2, 2, { receipts: [receipt(second, 'reflected')] })).status, 401, 'the old device\'s connection is closed');
    const third = (await dsync(moved, 7)).json.distribution.items.find((x) => x.distribution_id === d.id); assert.notEqual(third.offer_key, second.offer_key); await hold(moved, 7, third); assert.equal(card('A2', q.object_id).state, 'present'); conn.A2 = moved;
    assert.ok(rows('SELECT grant_id FROM classroom_distribution_targets WHERE distribution_id=?', d.id).every((r) => r.grant_id === moved.grant_id), 'the row names the connection of the LAST offer; nothing was copied forward at enqueue time');
  });

  await check('D13+D5 the sync table: switching the feature off stops NEW offers only; receipts and withdrawals still flow; an ended class offers nothing new', async () => {
    const q = (await save({ kind: 'notice', title: '스위치', body: 'x' })).json, d = (await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A1', 'A2'] })).json.distribution;
    now0(); const i1 = (await dsync(conn.A1, 1)).json.distribution.items.find((x) => x.distribution_id === d.id);
    f.db.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_distribute',json('false'))").run();
    assert.equal((await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A1'] })).json.reason, 'ops_distribute_disabled');
    f.db.prepare("UPDATE ops_latest_state SET last_received_at=0").run(); now0(); assert.equal((await dsync(conn.A2, 7)).json.distribution, undefined, 'off = no new offer');
    await hold(conn.A1, 1, i1); assert.equal(stateOf(d.id, 'A1').state, 'reflected', 'a receipt of an offer that had already gone out is still evidence');
    assert.equal((await f.request(`${f.base}/distributions/${d.id}/revoke`, 'POST', { expected_row_revision: 0 }, X)).status, 200, 'withdrawing is a safety action: it works during a rollback');
    f.db.prepare("UPDATE ops_latest_state SET last_received_at=0").run(); const w = (await dsync(conn.A1, 1)).json.distribution.withdraw; assert.equal(w.length, 1, 'and the withdrawal reaches the device with the feature off');
    f.db.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_distribute',json('true'))").run();
    const e = (await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A1', 'A2'] })).json.distribution; now0(); const offered = (await dsync(conn.A2, 7)).json.distribution.items.find((x) => x.distribution_id === e.id);
    f.db.prepare("UPDATE sessions SET ended_at='2026-01-01T00:00:00Z' WHERE id=?").run(f.run);
    assert.equal((await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A1'] })).json.reason, 'run_ended'); assert.equal((await save({ kind: 'notice', title: 'x', body: 'y' })).json.reason, 'run_ended');
    now0(); const after = await dsync(conn.A1, 1); assert.equal(after.json.distribution?.items?.length ?? 0, 0, 'an ended class offers nothing new');
    await view(e.id); // nothing runs on a timer: the instructor's read (or that learner's own sync) settles what is overdue
    assert.deepEqual([stateOf(e.id, 'A1').state, stateOf(e.id, 'A2').state], ['expired', 'unconfirmed'], 'never offered = did not go; offered without a final receipt = unknown, NOT success');
    const late = await dsync(conn.A2, 7, { receipts: [receipt(offered, 'reflected')] }); assert.deepEqual(late.json.distribution.receipt_acks.map((a) => a.recorded), [true]); assert.equal(stateOf(e.id, 'A2').state, 'reflected', 'a late, truthful report after the end is accepted: it was offered before the end');
    assert.deepEqual((await view(e.id)).json.new_request_blocked_by, 'run_ended'); assert.equal((await view(e.id)).json.targets.find((t) => t.seat_id === 'A1').status.reselectable, false, 'nothing can be re-selected into an ended class');
    f.db.prepare('UPDATE sessions SET ended_at=NULL WHERE id=?').run(f.run);
  });

  await check('D14 limits and failure isolation: every list is bounded, a broken exchange drops only its block, an unreadable ledger is a 503 — never "everyone" and never "done"', async () => {
    const q = (await save({ kind: 'notice', title: '한도', body: '가'.repeat(1500) })).json; const ids = [];
    for (let i = 0; i < 4; i++) { const o = (await save({ kind: 'notice', title: '한도 ' + i, body: '나'.repeat(1900) })).json; ids.push((await send({ object_id: o.object_id, revision: 1, content_hash: o.content_hash, targets: ['A1'] })).json.distribution.id); }
    now0(); const first = (await dsync(conn.A1, 1)).json; assert.deepEqual([first.distribution.items.length, first.distribution.more, first.poll_after_ms], [2, true, 1000], 'two items per response, the rest on the next poll');
    assert.ok(new TextEncoder().encode(JSON.stringify(first.distribution.items)).length <= 24 * 1024);
    const seven = Array.from({ length: 7 }, () => receipt(first.distribution.items[0], 'received')); const capped = (await dsync(conn.A1, 1, { receipts: seven })).json.distribution; assert.deepEqual([capped.receipt_acks.length, capped.more], [6, true], 'six receipts per sync, never an error for the seventh');
    assert.ok([1, 2, 3, 4, 5].map(lib.offerDelayMs).reduce((a, b) => a + b) > 0 && lib.offerDelayMs(40) === 300000, 'offers are spaced, then once per five minutes: bounded until the intent expires');
    // failure isolation
    f.fail('classroom_distribution_targets'); const broken = await dsync(conn.A1, 1); f.fail('');
    assert.equal(broken.status, 200); assert.equal(broken.json.distribution, undefined, 'no block = no news'); assert.ok(Array.isArray(broken.json.commands) && broken.json.ack, 'observation and commands are untouched');
    f.fail('FROM classroom_distributions WHERE class_run_id=? AND idempotency_key'); const unreadable = await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A1'] }); f.fail('');
    assert.deepEqual([unreadable.status, unreadable.json.reason], [503, 'distribution_unavailable'], 'an unreadable ledger is never read as "no such request"');
    f.fail('FROM classroom_distribution_targets t LEFT JOIN'); const noView = await view(ids[0]); f.fail(''); assert.deepEqual([noView.status, noView.json.reason], [503, 'distribution_unavailable']);
    // rate and size limits
    const many = []; for (let i = 0; i < 25; i++) many.push((await send({ object_id: q.object_id, revision: 1, content_hash: q.content_hash, targets: ['A1'] })).status); assert.ok(many.includes(429), 'distributions per minute are limited');
    f.db.prepare('UPDATE classroom_content_objects SET latest_revision=20 WHERE object_id=?').run(q.object_id); assert.equal((await save({ kind: 'notice', title: 'r21', body: 'x', object_id: q.object_id, expected_latest_revision: 20 })).status, 429);
  });

  await check('D14 the statement count of a commit does not grow with the class: 200 seats are ONE batch of five statements', async () => {
    const g = await localOps(), big = Array.from({ length: 200 }, (_, i) => ({ seat_id: 'S' + String(i + 1).padStart(3, '0'), student_id: 'big-' + String(i + 1).padStart(3, '0') }));
    try {
      await setRoster(g.env.HPS_KV, g.cohort, big.map((s) => s.student_id)); await g.freeze(); assert.equal((await g.configure(big, 0, { flags: ALL_FLAGS })).status, 201);
      const T2 = await g.teacher('teacher-x', [...OPS_ALL, 'distribute']), o = (await g.request(g.base + '/contents', 'POST', { idempotency_key: KEY(), kind: 'notice', title: '전체', body: 'x' }, T2)).json;
      const inner = g.env.HPS_DB; let statements = 0, batches = 0, maxBinds = 0;
      g.env.HPS_DB = { prepare(sql) { const st = inner.prepare(sql); const wrap = { bind(...a) { maxBinds = Math.max(maxBinds, a.length); st.bind(...a); return wrap; }, _run: () => st._run(), run: async () => { statements++; return st.run(); }, first: async () => { statements++; return st.first(); }, all: async () => { statements++; return st.all(); } }; return wrap; }, batch: async (s) => { batches++; statements += s.length; return inner.batch(s); } };
      const counts = {}; for (const n of [30, 100, 200]) { statements = 0; batches = 0; const r = await g.request(g.base + '/distributions', 'POST', { idempotency_key: KEY(), expected_roster_revision: 1, object_id: o.object_id, revision: 1, content_hash: o.content_hash, targets: big.slice(0, n).map((s) => s.seat_id) }, T2); assert.equal(r.status, 201, r.raw); assert.equal(r.json.targets.length, n); counts[n] = [statements, batches]; }
      g.env.HPS_DB = inner;
      assert.deepEqual(counts[30], counts[200], 'the same number of statements for 30 and for 200 seats: ' + JSON.stringify(counts)); assert.ok(counts[200][0] <= 24, 'statements per commit incl. authorization reads, settlement and the result view: ' + counts[200][0]); assert.ok(maxBinds <= 30, 'bound parameters per statement: ' + maxBinds);
      assert.equal(g.db.prepare("SELECT count(*) n FROM classroom_distribution_targets WHERE state='accepted' AND pending=1").get().n, 330);
      console.log(`  statements per commit (SQLite shim; D1 row counts are measured in classroom-ops-distribution-d1.test.mjs): ${JSON.stringify(counts)} · max binds ${maxBinds}`);
    } finally { g.close(); }
  });

  await check('D15 off means absent: with the run switch never on, a sync answers exactly as it did before; with operations off, the routes do not exist', async () => {
    const g = await localOps(); try {
      await g.freeze(); assert.equal((await g.configure([{ seat_id: 'A1', student_id: 'student-a' }], 0, { flags: { ops_observe: true, ops_commands: true } })).status, 201);
      const c1 = (await g.pair('A1', 1, 1, CAPS)).conn.json, r = await g.sync(c1.credential, [], 1); assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json).sort(), ['ack', 'commands', 'connection_epoch', 'control', 'lease', 'poll_after_ms', 'quarantined', 'receipt_acks', 'rejected', 'schema_version', 'server_time'], 'no new key in the answer');
      const T2 = await g.teacher('teacher-x', [...OPS_ALL, 'distribute']); assert.equal((await g.request(g.base + '/contents', 'POST', { idempotency_key: KEY(), kind: 'notice', title: 't', body: 'b' }, T2)).json.reason, 'ops_distribute_disabled');
      assert.equal((await g.request(g.base, 'PUT', { expected_roster_revision: 1, seats: [{ seat_id: 'A1', student_id: 'student-a' }], flags: { ops_distribution: true } })).status, 400, 'a misspelt switch is refused, not ignored');
    } finally { g.close(); }
    const off = await localOps({ enabled: false }); try { const T3 = await off.teacher('teacher-x', [...OPS_ALL, 'distribute']); assert.equal((await off.request(off.base + '/contents', 'GET', undefined, T3)).status, 404); } finally { off.close(); }
  });

  console.log(`\n${count} passed`);
} finally { f.close(); }
