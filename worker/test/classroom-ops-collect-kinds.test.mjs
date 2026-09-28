// #751 U1b (AT-48) — collection KINDS and the sessions of the same learner in the class window, end to end in-process:
// the REAL Service routes (SQLite + in-memory R2), the App's REAL freezer and uploader, and a REAL SessionSpool writing to a
// temp directory (restart = a second SessionSpool on the same root; a shared PC = another learner's session in that root).
// Not a real Studio window, a real offline laptop, real R2/D1 or a network. Every learner and value here is synthetic.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localOps } from './harness/classroom-ops.mjs';
import { SessionSpool } from '../../extensions/hypeproof-chat/src/sessionSpool.ts';
import * as App from '../../extensions/hypeproof-chat/src/evidenceSnapshot.ts';
const Svc = await import('../src/lib/classroom-collect.ts');
let n = 0; const check = async (name, fn) => { await fn(); n++; console.log('PASS ' + name); };
const NOTICE = { purpose: 'class_report', notice_version: 'notice-v1' }, KEY = () => crypto.randomUUID();
const f = await localOps();
try {
  await f.freeze();
  const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }, { seat_id: 'A3', student_id: 'student-c' }];
  assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true } })).status, 201);
  const conn = {}; let pn = 0; for (const s of seats) conn[s.seat_id] = (await f.pair(s.seat_id, 1, ++pn)).conn.json;
  for (const s of ['A1', 'A2']) assert.equal((await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, ...NOTICE }, conn[s].credential)).status, 201);
  const a1 = conn.A1, run = a1.run, scope = { grant_id: a1.grant_id, class_run_id: a1.class_run_id, seat_id: a1.seat_id, student: a1.student, activity: a1.lesson ? { course_id: a1.lesson.course_id, version: a1.lesson.version } : null, run };
  const decode = (v) => new TextDecoder().decode(v.body ?? v), stored = () => [...f.r2.entries()].map(([k, v]) => [k, decode(v)]);
  const holds = (needle) => stored().some(([, v]) => v.includes(needle)), keysOf = (student) => [...f.r2.keys()].filter((k) => k.includes('/' + student + '/'));
  const post = (body) => f.request(f.base + '/report-batches', 'POST', { idempotency_key: KEY(), roster_revision: 1, ...NOTICE, dry_run: false, ...body });
  const view = async (id) => (await f.request(f.base + '/report-batches/' + id)).json;

  // ── the learner's spool: one session before a graceful app restart, one after, plus what must never travel ──
  const root = mkdtempSync(path.join(tmpdir(), 'u1b-spool-'));
  const clock = { t: 0 }, tick = (ms) => { clock.t = ms; }, spoolAt = () => new SessionSpool({ root, appVersion: 'synthetic', os: { platform: 'darwin', release: 't', arch: 'arm64' }, now: () => new Date(run.starts_at + clock.t) });
  const ident = { u: a1.student.u, c: a1.student.c, p: a1.student.p };
  const APPROVED = '<html><body>APPROVED-HTML-v2</body></html>', UNAPPROVED = '<html><body>UNAPPROVED-HTML-v1</body></html>';
  const { createHash } = await import('node:crypto'); const h = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
  // Another activity of the same learner earlier that day, and another learner on the same PC during class: neither is this collection's.
  { tick(-2 * 3_600_000); const early = spoolAt(); early.noteIdentity(ident); early.recordPrompt({ turnId: 'e-1', runtime: 'proxy', text: 'EARLIER-CLASS-PROMPT' }); await early.close('shutdown'); }
  { tick(-10 * 60_000); const lead = spoolAt(); lead.noteIdentity(ident); lead.recordPrompt({ turnId: 'l-1', runtime: 'proxy', text: 'LEAD-IN-EARLIER-SESSION' }); await lead.close('shutdown'); }
  { tick(3_000); const other = spoolAt(); other.noteIdentity({ u: 'student-b', c: ident.c, p: ident.p }); other.recordPrompt({ turnId: 'o-1', runtime: 'proxy', text: 'OTHER-LEARNER-SECRET' }); await other.close('shutdown'); }
  const s1 = spoolAt(); s1.noteIdentity(ident);
  tick(5_000); s1.recordPrompt({ turnId: 't-1', runtime: 'proxy', text: 'PROMPT-ONE', instructorPromptRefs: [{ object_id: 'obj-1', revision: 2 }] });
  tick(6_000); s1.recordResponse({ turnId: 't-1', runtime: 'proxy', status: 'ok', text: 'RESPONSE-ONE-SECRET' });
  tick(7_000); s1.recordArtifactSnapshot({ turnId: 't-1', source: 'assistant_response', path: '/Users/someone/work/index.html', content: UNAPPROVED });
  tick(8_000); s1.recordTurnEnd({ turnId: 't-1', status: 'ok', runtime: 'proxy' });
  tick(9_000); s1.recordArtifactSnapshot({ source: 'existing', path: 'index.html', content: APPROVED }); s1.recordArtifactApproval({ sha256: h(APPROVED), path: 'index.html', approved: true });
  tick(10_000); await s1.close('shutdown'); // graceful quit → session_close
  const s2 = spoolAt(); s2.noteIdentity(ident);
  tick(12_000); s2.recordPrompt({ turnId: 't-2', runtime: 'agent-sdk', text: 'PROMPT-TWO' });
  tick(13_000); s2.recordResponse({ turnId: 't-2', runtime: 'agent-sdk', status: 'ok', text: 'RESPONSE-TWO-SECRET' }); s2.recordTurnEnd({ turnId: 't-2', status: 'ok', runtime: 'agent-sdk' });
  await s2.flush();
  const since = run.starts_at - App.WINDOW_LEAD_MS;

  // The device half, as the host wires it: copy frozen once per (batch, revision) from the live spool, then PUT + seal.
  let puts = [];
  const device = (kinds, source = () => s2.readForCollection(since, ident)) => { const frozen = new Map(); let saved = null; return {
    scope: () => scope,
    copy: async (b, rev) => { const k = b + ':' + rev; if (!frozen.has(k)) { const src = await source(); if (!src) return null; const fr = App.freezeCollection(src, scope, b, NOTICE, kinds, Date.now()); if (!fr.ok) return { code: fr.code }; frozen.set(k, { files: fr.files, collection: fr.binding }); } return frozen.get(k); },
    loadState: async () => (saved ? JSON.parse(saved) : null), saveState: async (s) => { saved = JSON.stringify(s); }, peek: () => JSON.parse(saved), frozen,
    put: async (b, rev, name, data) => { puts.push(name); const r = await f.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${b}/${rev}/${name}`, { method: 'PUT', headers: { authorization: 'Bearer ' + a1.credential }, body: data }), f.env, { waitUntil() {} }); const j = await r.json().catch(() => ({})); return { status: r.status, reason: j.reason }; },
    seal: async (b, rev, manifest) => { const r = await f.request(`/v1/classroom/ops/collect/snapshots/${b}/${rev}/seal`, 'POST', manifest, a1.credential); return { status: r.status, reason: r.json?.reason, receipt_id: r.json?.receipt_id, coverage: r.json?.coverage, coverage_reason: r.json?.coverage_reason }; },
  }; };
  const collect = async (kinds, extra = {}) => { const made = await post({ targets: ['A1'], mode: 'collect_only', kinds, ...extra }); assert.equal(made.status, 201, made.raw); return made.json.batch.id; };

  await check('AT-48 contract: kinds are ["record"], one of or both "prompts"/"artifacts"; never on the wrap-up; part of the request identity', async () => {
    for (const [k, ok] of [[['record'], 1], [['prompts'], 1], [['artifacts'], 1], [['prompts', 'artifacts'], 1], [['record', 'prompts'], 0], [[], 0], [['prompts', 'prompts'], 0], [['files'], 0], ['record', 0]]) {
      assert.equal(!!Svc.normalizeKinds(k), !!ok, 'service ' + JSON.stringify(k)); assert.equal(!!App.normalizeKinds(k), !!ok, 'app ' + JSON.stringify(k));
    }
    assert.deepEqual([(await post({ kinds: ['record'] })).json.reason, (await post({ targets: ['A1'], kinds: ['record', 'prompts'] })).json.reason], ['kinds_not_allowed', 'kinds_invalid']);
    const key = KEY(), first = await post({ idempotency_key: key, targets: ['A1'], kinds: ['prompts'], dry_run: true }), again = await post({ idempotency_key: key, targets: ['A1'], kinds: ['prompts'], dry_run: true }), other = await post({ idempotency_key: key, targets: ['A1'], kinds: ['artifacts'], dry_run: true });
    assert.deepEqual([first.status, again.status, again.json.batch.id === first.json.batch.id, other.status, other.json.reason], [201, 200, true, 409, 'idempotency_conflict']);
    assert.deepEqual(first.json.batch.kinds, ['prompts'], 'the view echoes what was asked');
    // U1 hashes are unchanged: a request without kinds hashes exactly as before this change.
    const legacy = { scope: 'targets', mode: 'collect_only', targets: ['A1'], purpose: 'class_report', notice_version: 'notice-v1', dry_run: false, roster_revision: 1 };
    assert.equal(Svc.collectRequestCanonical(legacy), JSON.stringify(['targets', 'collect_only', ['A1'], 'class_report', 'notice-v1', false, 1]));
    // The App and the Service select exactly the same lines for every kind set, type and approval state.
    const approved = new Set(['aaa']);
    for (const kinds of [['record'], ['prompts'], ['artifacts'], ['artifacts', 'prompts']]) for (const type of ['prompt', 'response', 'artifact_snapshot', 'artifact_approval', 'lesson_binding', 'usage', 'turn_end', 'workflow', 'session_close', null]) for (const art of ['aaa', 'bbb', undefined])
      assert.equal(App.kindSelects(kinds, type, art, approved), Svc.kindSelects(kinds, type, art, approved), `${kinds}/${type}/${art}`);
  });

  let promptsBatch;
  await check('AT-48 prompts: only the learner\'s prompts of both sessions travel — no AI response, artifact, other learner or earlier class; restart kept as two parts', async () => {
    puts = []; const b = promptsBatch = await collect(['prompts']), d = device(['prompts']);
    const cmd = f.db.prepare("SELECT args_json FROM ops_commands WHERE idempotency_key=?").get('collect-' + b); assert.deepEqual(JSON.parse(cmd.args_json), { batch_id: b, ...NOTICE, kinds: ['prompts'], sessions: 'window' }, 'the device is told what to collect');
    assert.deepEqual(await App.uploadSnapshot(b, d), { ok: true, code: 'receipt_verified' });
    assert.deepEqual(puts.sort(), ['p1.events.jsonl', 'p1.index.jsonl', 'p1.meta.json', 'p2.events.jsonl', 'p2.index.jsonl', 'p2.meta.json']);
    for (const needle of ['PROMPT-ONE', 'PROMPT-TWO', '"instructor_prompt_refs"']) assert.ok(holds(needle), needle + ' is collected');
    for (const needle of ['RESPONSE-ONE-SECRET', 'RESPONSE-TWO-SECRET', 'UNAPPROVED-HTML', 'APPROVED-HTML', 'OTHER-LEARNER-SECRET', 'EARLIER-CLASS-PROMPT', 'LEAD-IN-EARLIER-SESSION', '/Users/someone']) assert.ok(!holds(needle), needle + ' never reaches the Service');
    const bind = d.peek().collection; assert.deepEqual(bind.parts.map((p) => [p.current, p.included]), [[false, 1], [true, 1]]); assert.notEqual(bind.parts[0].spool_session_id, bind.parts[1].spool_session_id, 'each session keeps its own id');
    const it = (await view(b)).items.find((i) => i.seat_id === 'A1');
    assert.deepEqual([it.state, it.coverage, it.coverage_reason], ['verified', 'complete', ''], 'graceful restart: both ends proven, nothing asked for is missing');
    assert.deepEqual([it.extent.kinds, it.extent.sessions, it.extent.parts.map((p) => [p.start_proven, p.end_proven])], [['prompts'], 2, [[true, true], [true, true]]]);
    assert.deepEqual([it.extent.received.prompt, it.extent.received.instructor_refs, it.extent.received.response, it.extent.not_sent.response, it.extent.not_sent.artifact_unapproved, it.extent.not_sent.artifact_approved], [2, 1, 0, 2, 1, 1]);
    assert.ok(!JSON.stringify(await view(b)).includes(bind.parts[0].spool_session_id), 'the instructor view carries no session id');
    assert.equal(f.db.prepare("SELECT count(*) n FROM classroom_job_outbox WHERE kind='report_input'").get().n, 0, 'collect-only: no evaluation input');
    assert.equal((await f.request(f.base + '/report-batches/' + b + '/reports')).json.reason, 'collect_only_batch');
  });

  await check('AT-48 artifacts: only the version the learner approved travels (with its approval); the unapproved version is counted, not sent', async () => {
    const b = await collect(['artifacts']), before = new Set(f.r2.keys()), d = device(['artifacts']);
    assert.deepEqual(await App.uploadSnapshot(b, d), { ok: true, code: 'receipt_verified' });
    const mine = stored().filter(([k]) => !before.has(k)).map(([, v]) => v).join('\n');
    assert.ok(mine.includes('APPROVED-HTML-v2') && mine.includes('"artifact_approval"'));
    for (const needle of ['UNAPPROVED-HTML-v1', 'PROMPT-ONE', 'RESPONSE-ONE-SECRET']) assert.ok(!mine.includes(needle), needle + ' is not part of an artifacts collection');
    const it = (await view(b)).items.find((i) => i.seat_id === 'A1');
    assert.deepEqual([it.coverage, it.extent.received.artifact_approved, it.extent.not_sent.artifact_unapproved, it.extent.not_sent.prompt], ['complete', 1, 1, 2]);
    assert.deepEqual(d.peek().collection.parts.map((p) => p.included), [2, 0], 'the part without an approved artifact sends only its index');
  });

  await check('AT-48 record: every event of this learner in the window across the restart — still never the other learner or the earlier class', async () => {
    const b = await collect(['record']), before = new Set(f.r2.keys()), d = device(['record']);
    assert.deepEqual(await App.uploadSnapshot(b, d), { ok: true, code: 'receipt_verified' });
    const mine = stored().filter(([k]) => !before.has(k)).map(([, v]) => v).join('\n');
    for (const needle of ['PROMPT-ONE', 'RESPONSE-ONE-SECRET', 'UNAPPROVED-HTML-v1', 'APPROVED-HTML-v2', 'PROMPT-TWO', '"session_close"']) assert.ok(mine.includes(needle), needle);
    for (const needle of ['OTHER-LEARNER-SECRET', 'EARLIER-CLASS-PROMPT', 'LEAD-IN-EARLIER-SESSION']) assert.ok(!mine.includes(needle), needle);
    const it = (await view(b)).items.find((i) => i.seat_id === 'A1'); assert.deepEqual([it.coverage, it.extent.sessions, it.extent.included, it.extent.lines], ['complete', 2, it.extent.lines, it.extent.lines]);
    assert.deepEqual(keysOf('student-b'), [], 'the unselected / other learner has no object at all');
  });

  await check('AT-48 not selected: A2 consented and is connected but was not selected — no command target, no item beyond metadata, nothing stored', async () => {
    const v = await view(promptsBatch); assert.deepEqual(v.items.filter((i) => i.seat_id !== 'A1').map((i) => [i.seat_id, i.state]), [['A2', 'not_selected'], ['A3', 'not_selected']]);
    assert.equal(f.db.prepare("SELECT count(*) n FROM ops_command_targets WHERE seat_id IN ('A2','A3')").get().n, 0);
  });

  await check('AT-48 distinguishes: crash (no close) · torn in-flight tail · truncated prompt · unreadable session · lead-in of an earlier session — none is "complete"', async () => {
    const base = await s2.readForCollection(since, ident);
    // crash: the earlier session ends without session_close → its end is unproven
    const crashed = { ...base, others: base.others.map((o) => ({ ...o, events: new TextEncoder().encode(new TextDecoder().decode(o.events).split('\n').filter((l) => l && !l.includes('"session_close"')).join('\n') + '\n') })) };
    let b = await collect(['prompts']); assert.deepEqual(await App.uploadSnapshot(b, device(['prompts'], async () => crashed)), { ok: true, code: 'receipt_verified' });
    let it = (await view(b)).items.find((i) => i.seat_id === 'A1'); assert.deepEqual([it.coverage, it.coverage_reason, it.extent.parts[0].end_proven], ['range_unknown', 'earlier_session_end_unproven', false]);
    // torn: an append in flight in the current session (its seq is already allocated) — the partial bytes are not sent and the tail is missing
    const cur = base.current, torn = { ...base, current: { files: cur.files.map((x) => x.name === 'events.jsonl' ? { ...x, data: new Uint8Array([...x.data, ...new TextEncoder().encode('{"schema_version":1,"ts":"' + new Date(run.starts_at + 14_000).toISOString() + '","type":"prompt","text":"TORN-')]) } : x), sequence: { ...cur.sequence, last_seq: cur.sequence.last_seq + 1 } } };
    b = await collect(['prompts']); const before = new Set(f.r2.keys()); assert.deepEqual(await App.uploadSnapshot(b, device(['prompts'], async () => torn)), { ok: true, code: 'receipt_verified' });
    it = (await view(b)).items.find((i) => i.seat_id === 'A1'); assert.deepEqual([it.coverage, it.extent.reasons.includes('tail_missing'), it.extent.reasons.includes('torn_tail_dropped'), it.extent.parts[1].torn_tail], ['gaps', true, true, true]);
    assert.ok(!stored().filter(([k]) => !before.has(k)).some(([, v]) => v.includes('TORN-')), 'torn bytes never travel');
    // truncated prompt: the spool kept 20,000 of more characters and said so — the prompt content is not complete
    const long = spoolAt(); tick(15_000); long.noteIdentity(ident); long.recordPrompt({ turnId: 't-9', runtime: 'proxy', text: 'L'.repeat(20_050) }); await long.flush();
    b = await collect(['prompts']); assert.deepEqual(await App.uploadSnapshot(b, device(['prompts'], () => long.readForCollection(since, ident))), { ok: true, code: 'receipt_verified' });
    it = (await view(b)).items.find((i) => i.seat_id === 'A1'); assert.deepEqual([it.coverage, it.extent.received.truncated_prompts >= 1, it.extent.reasons.includes('prompt_truncated')], ['gaps', true, true]);
    await long.close('shutdown');
    // unreadable: a recent session whose metadata cannot be read is counted, never guessed to be this learner's
    const day = readdirSync(root).sort().at(-1), bad = path.join(root, day, 'broken-session'); mkdirSync(bad); writeFileSync(path.join(bad, 'session.meta.json'), '{not json'); writeFileSync(path.join(bad, 'events.jsonl'), '{"seq":1}\n');
    b = await collect(['prompts']); assert.deepEqual(await App.uploadSnapshot(b, device(['prompts'])), { ok: true, code: 'receipt_verified' });
    // (the truncated-prompt session above is in the same window, so the worst answer is still `gaps`; both reasons are listed)
    it = (await view(b)).items.find((i) => i.seat_id === 'A1'); assert.deepEqual([it.coverage, it.extent.reasons.includes('session_not_included'), it.extent.reasons.includes('prompt_truncated'), it.extent.omitted.unreadable], ['gaps', true, true, 1]);
    rmSync(bad, { recursive: true });
  });

  await check('AT-48 fail closed at the Service: an unasked line is quarantined AND its bytes deleted; a mislabelled index, a /2 seal for a kinds batch and part files for a U1 batch are refused', async () => {
    const b = await collect(['prompts']), src = await s2.readForCollection(since, ident), fr = App.freezeCollection(src, scope, b, NOTICE, ['record'], Date.now()); assert.ok(fr.ok);
    // A device that sends the WHOLE record under a prompts batch (declaring prompts): every file hashes, but responses were not asked for.
    const coll = { ...fr.binding, kinds: ['prompts'] };
    for (const file of fr.files) assert.equal((await f.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${b}/1/${file.name}`, { method: 'PUT', headers: { authorization: 'Bearer ' + a1.credential }, body: file.data }), f.env, { waitUntil() {} })).status, 201);
    assert.ok(holds('RESPONSE-ONE-SECRET'), 'the negative control: the unasked bytes did reach storage before the seal');
    const sealed = await f.request(`/v1/classroom/ops/collect/snapshots/${b}/1/seal`, 'POST', { schema: App.SNAPSHOT_SCHEMA_V3, files: fr.files.map((x) => ({ name: x.name, bytes: x.data.byteLength, sha256: createHash('sha256').update(x.data).digest('hex') })), collection: coll }, a1.credential);
    assert.deepEqual([sealed.status, sealed.json.reason, sealed.json.state], [422, 'kind_violation', 'quarantined']);
    assert.deepEqual(keysOf('student-a').filter((k) => k.includes('/' + b + '/')), [], 'nothing of that revision is kept');
    assert.ok(!stored().some(([k, v]) => k.includes('/' + b + '/') || (v.includes('RESPONSE-ONE-SECRET') && k.includes(b))));
    // A mislabelled index: the response line is sent under prompts and its index entry claims it is a prompt. The Service parses the
    // line itself, so the label does not carry it through (pure check on the same verifier the route uses).
    const rec = App.freezeCollection(src, scope, b, NOTICE, ['record'], Date.now()); assert.ok(rec.ok);
    const texts = new Map(rec.files.map((x) => [x.name, new TextDecoder().decode(x.data)])), part = rec.binding.parts.find((p) => p.current).part;
    const relabel = texts.get(`p${part}.index.jsonl`).split('\n').filter(Boolean).map((l) => { const e = JSON.parse(l); return JSON.stringify(e.type === 'response' ? { ...e, type: 'prompt' } : e); });
    texts.set(`p${part}.index.jsonl`, relabel.join('\n') + '\n');
    // send exactly the lines the relabelled index calls prompts (the real prompt and the disguised response)
    const claimed = new Set(relabel.map((l) => JSON.parse(l)).filter((e) => e.type === 'prompt').map((e) => e.sha256)), sentLines = texts.get(`p${part}.events.jsonl`).split('\n').filter((l) => l && claimed.has(createHash('sha256').update(l).digest('hex')));
    texts.set(`p${part}.events.jsonl`, sentLines.join('\n') + '\n'); assert.ok(sentLines.some((l) => l.includes('"type":"response"')), 'the disguised line is in the sent set');
    const bindings = { ...rec.binding, kinds: ['prompts'], parts: rec.binding.parts.map((p) => p.part !== part ? { ...p, included: 0 } : { ...p, included: sentLines.length, final_index_sha256: createHash('sha256').update(relabel.at(-1)).digest('hex') }) };
    for (const p of bindings.parts) if (p.part !== part) texts.delete(`p${p.part}.events.jsonl`);
    const owner = { student: a1.student.u, cohort: a1.student.c, profile: a1.student.p, class_run_id: a1.class_run_id, batch_id: b, seat_id: 'A1', ...NOTICE, activity: scope.activity, run_starts_at: run.starts_at, upload_until: run.ends_at + 86_400_000, kinds: ['prompts'] };
    assert.deepEqual(await Svc.verifyCollection(texts, bindings, owner), { problem: 'index_mismatch' });
    // /2 for a kinds batch, and part names for a batch without kinds
    const u1 = (await post({ targets: ['A1'], mode: 'collect_only' })).json.batch.id, k2 = await collect(['record']);
    assert.equal((await f.uploadSnapshotAs(a1, k2, 1, '{"seq":1,"type":"prompt"}\n', { legacy: true })).json.reason, 'file_not_in_scope', 'the legacy files are refused at PUT for a kinds batch');
    const s2seal = await f.request(`/v1/classroom/ops/collect/snapshots/${k2}/1/seal`, 'POST', f.sealBody(a1, k2, '{"seq":1,"type":"prompt"}\n'), a1.credential);
    assert.deepEqual([s2seal.status, s2seal.json.reason], [409, 'kinds_schema_required'], 'and a /2 seal is refused before anything is read');
    const put = await f.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${u1}/1/p1.meta.json`, { method: 'PUT', headers: { authorization: 'Bearer ' + a1.credential }, body: '{}' }), f.env, { waitUntil() {} });
    assert.deepEqual([put.status, (await put.json()).reason], [400, 'file_not_in_scope']);
    // Lines without ts (an older spool) are indexed with ts=null and still verify under /3 (regression found while wiring the harness).
    const k3 = await collect(['record']); assert.equal((await f.uploadSnapshotAs(a1, k3, 1, '{"seq":1,"type":"prompt"}\n')).status, 201);
    // A U1 batch still collects the current session exactly as before (schema /2): no kinds, no parts.
    assert.equal((await f.uploadSnapshotAs(a1, u1, 1, '{"seq":1,"type":"prompt"}\n')).status, 201);
  });

  await check('AT-48 duplicates and withdrawal: re-running a proven batch sends nothing; a new batch is its own input; withdrawal mid-upload keeps nothing', async () => {
    puts = []; const d = device(['prompts']), b = await collect(['prompts']);
    assert.deepEqual(await App.uploadSnapshot(b, d), { ok: true, code: 'receipt_verified' }); const sent = puts.length; puts = [];
    assert.deepEqual(await App.uploadSnapshot(b, d), { ok: true, code: 'receipt_verified' }); assert.deepEqual(puts, [], 'a proven batch is not sent again');
    assert.equal(f.db.prepare('SELECT input_revision r FROM classroom_collect_items WHERE batch_id=? AND seat_id=?').get(b, 'A1').r, 1); assert.ok(sent >= 4);
    // Withdrawal between the first PUT and the seal: the seal is refused and what was stored is removed.
    const w = await collect(['record']), dw = device(['record']), first = dw.put; let calls = 0;
    dw.put = async (...args) => { const r = await first(...args); if (++calls === 1) await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: false, ...NOTICE }, a1.credential); return r; };
    const r = await App.uploadSnapshot(w, dw); assert.equal(r.ok, false); assert.equal(r.code, 'withdrawn');
    assert.deepEqual(keysOf('student-a'), [], 'withdrawal removes everything this learner had in this run, including the half upload');
    assert.equal((await post({ targets: ['A1'], mode: 'collect_only', kinds: ['prompts'] })).json.items.find((i) => i.seat_id === 'A1').state, 'withdrawn', 'a withdrawn learner is not asked again');
  });

  await check('AT-48 cost: a prompts collection sends and stores less than the record; statements per /3 seal are bounded', async () => {
    // fresh consent for a second measurement run (the withdrawal above tombstoned student-a in this run)
    assert.equal((await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, ...NOTICE }, a1.credential)).status, 201);
    const bytes = {}, objects = {}, stmts = {}, realPrepare = f.env.HPS_DB.prepare.bind(f.env.HPS_DB);
    for (const kinds of [['record'], ['prompts'], ['artifacts']]) {
      const b = await collect(kinds), before = new Set(f.r2.keys()), d = device(kinds); let count = 0;
      const seal = d.seal; d.seal = async (...a) => { f.env.HPS_DB.prepare = (sql) => { count++; return realPrepare(sql); }; try { return await seal(...a); } finally { f.env.HPS_DB.prepare = realPrepare; } };
      assert.deepEqual(await App.uploadSnapshot(b, d), { ok: true, code: 'receipt_verified' });
      const added = [...f.r2.entries()].filter(([k]) => !before.has(k)); objects[kinds] = added.length; bytes[kinds] = added.reduce((s, [, v]) => s + (v.byteLength ?? v.body?.byteLength ?? 0), 0); stmts[kinds] = count;
    }
    console.log('  measured (synthetic spool — this learner\'s 3 sessions in the window, in-process; not R2/D1 billing):', JSON.stringify({ bytes, r2_objects: objects, d1_statements_per_seal: stmts }));
    assert.ok(bytes.prompts < bytes.record && bytes.artifacts < bytes.record, 'a subset kind stores less than the record');
    for (const k of Object.keys(stmts)) assert.ok(stmts[k] <= 16, 'a /3 seal stays a bounded number of statements: ' + k + '=' + stmts[k]);
  });
} finally { f.close(); }
console.log(`classroom-ops-collect-kinds: ${n} checks passed`);
