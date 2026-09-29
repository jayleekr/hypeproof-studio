// Synthetic remote-operations fixture: real HTTP routing, real token verifier,
// SQLite with transactional batch. Two teachers, two students, another cohort.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './index.mjs';
// Node SQLite binds positionally; the existing board SQL uses ?N, so numbered
// parameters are mapped here exactly as harness/classroom.mjs does. SQL is unchanged.
function sqliteBinding(db) {
  return { prepare(sql) {
    let args = [];
    const params = () => { const n = [...sql.matchAll(/\?(\d+)/g)]; return n.length ? n.map((m) => args[Number(m[1]) - 1]) : args; };
    const q = () => db.prepare(sql.replace(/\?\d+/g, '?'));
    const stmt = { bind(...a) { args = a; return stmt; },
      // D1 returns the rows of a SELECT inside a batch; the U3 turn admission reads its stored row back that way.
      _run() { if (/^\s*SELECT/i.test(sql)) return { success: true, results: q().all(...params()), meta: { changes: 0 } }; const r = q().run(...params()); return { success: true, results: [], meta: { changes: Number(r.changes) } }; },
      async run() { return stmt._run(); }, async first() { return q().get(...params()) ?? null; },
      async all() { return { success: true, results: q().all(...params()) }; } };
    return stmt;
  }, async batch(statements) { db.exec('BEGIN'); try { const r = statements.map((x) => x._run()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
export const OPS_ALL = ['observe', 'manage', 'command', 'reset', 'pause', 'coach', 'collect', 'review', 'deliver'];
// `profile`: another compiled profile that serves the same synthetic cohort (e.g. a proxy-runtime one) — the run, the frozen lesson and the tokens follow it.
export async function localOps({ enabled = true, binding, profile: profileOverride } = {}) {
  const app = await bootApp();
  const { issue, issueIssuer } = await import('../../src/lib/tokens.ts');
  const { setRoster, startSession } = await import('../../src/lib/kv.ts');
  const db = binding ? null : new DatabaseSync(':memory:');
  if (db) { db.exec('PRAGMA foreign_keys=ON'); db.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8')); }
  let failure = '';
  const inner = binding ?? sqliteBinding(db);
  // D1 fails at execution, not at prepare(): the injected fault does the same.
  const guarded = { prepare(sql) { const st = inner.prepare(sql); if (!(failure && sql.includes(failure))) return st; const boom = () => { throw Error('injected storage failure'); }; return { bind() { return this; }, _run: boom, run: async () => boom(), first: async () => boom(), all: async () => boom() }; }, batch: (s) => inner.batch(s) };
  const env = createMockEnv({ withSession: false, withRoster: false, environment: 'dev', adminPassword: 'pw', env: { HPS_DB: guarded, ...(enabled ? { HPS_CLASSROOM_OPS: 'enabled' } : {}) } });
  // In-memory R2: put/get/list, with the same "object first, row second" failure window as production.
  const r2 = new Map(); env.HPS_TRACES = { async put(key, value) { if (failure === 'R2 put') throw Error('injected R2 failure'); r2.set(key, value instanceof ArrayBuffer ? value.slice(0) : new TextEncoder().encode(String(value)).buffer); }, async get(key) { const v = r2.get(key); return v ? { arrayBuffer: async () => v, text: async () => new TextDecoder().decode(v) } : null; }, async delete(key) { r2.delete(key); }, async list({ prefix = '' } = {}) { return { objects: [...r2.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; } };
  const cohort = 'boah-dental-2026-a', profile = profileOverride ?? 'boah-dental-director-copyclone-2026-s1', run = 'ops-test-run';
  // Mirror what persistSessionStart writes, so usage rows attribute to the run like production.
  if (db) { db.prepare('INSERT OR IGNORE INTO cohorts(id,display_name) VALUES(?,?)').run(cohort, cohort); db.prepare('INSERT OR IGNORE INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES(?,?,?,?,?)').run(run, cohort, profile, new Date(Date.now() - 60000).toISOString(), new Date(Date.now() + 3600000).toISOString()); }
  await setRoster(env.HPS_KV, cohort, ['student-a', 'student-b', 'student-c', 'legacy-test-seat']);
  await startSession(env.HPS_KV, cohort, { session_id: run, profile_id: profile, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString() });
  const teacher = async (name = 'teacher-a', ops = OPS_ALL, c = cohort, profiles = [profile]) => (await issueIssuer({ issuer: name, scopes: [{ cohort: c, profiles, ...(ops ? { ops } : {}) }] }, 1, TEST_SECRET)).token;
  const student = async (name = 'student-a', p = profile, c = cohort) => (await issue({ u: name, c, p }, 2, TEST_SECRET)).token;
  const teacherToken = await teacher();
  async function request(path, method = 'GET', body, token = teacherToken, headers = {}) {
    const r = await app.fetch(new Request('https://service.test' + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env, makeCtx());
    const raw = await r.text(); let json; try { json = JSON.parse(raw); } catch {} return { status: r.status, json, raw, headers: r.headers };
  }
  const base = `/admin/cohorts/${cohort}/classroom/runs/${run}`;
  // The pinned lesson is a real frozen authoring version, drafted and confirmed through the existing API.
  const lesson = { course_id: 'ops-course', version: 'm2026.09.18-1' };
  const step = (id) => ({ id, title: id, instructions: '합성 단계\n제출 증거: ' + id + '.md', hint: '', acceptance: '합성 기준' });
  const design = (ids) => ({ schema: 'hps-session-design/1', title: '합성 수업', audience: '합성 사용자', duration_minutes: 60, objective: '원격 운영 시험', prerequisites: '코딩 경험 불필요', starter: '연습 폴더', steps: ids.map(step) });
  async function freeze(course = lesson.course_id, version = lesson.version, ids = ['intro', 'build', 'review']) {
    const a = `/admin/cohorts/${cohort}/authoring/${course}`;
    const saved = await request(a, 'PUT', { profile_id: profile, request_id: crypto.randomUUID(), expected_revision: 0, content: design(ids) });
    if (saved.status !== 200) throw Error('draft failed: ' + saved.raw);
    const frozen = await request(`${a}/versions/${version}`, 'PUT', { expected_revision: 1 });
    if (frozen.status !== 200) throw Error('freeze failed: ' + frozen.raw);
  }
  const configure = (seats, expected = 0, extra = {}, token) => request(base, 'PUT', { expected_roster_revision: expected, seats, flags: { ops_observe: true }, lesson, ...extra }, token);
  const instance = (n = 1, capabilities = ['observe', 'commands', 'retry_diagnostics', 'refresh_connection', 'restart_preview', 'cancel_current_run', 'reset_runtime', 'retry_evidence_upload', 'send_question', 'mark_checkpoint']) => ({ app_instance_id: `instance-000${n}`, boot_id: `boot-0000-000${n}`, protocol: 1, app_version: '0.1.56', capabilities });
  async function pair(seat, revision, n = 1, capabilities) {
    const p = await request(base + '/pairings', 'POST', { seat_id: seat, roster_revision: revision });
    if (p.status !== 201) throw Error('pairing failed: ' + p.raw);
    const conn = await request('/v1/classroom/ops/connect', 'POST', { ticket: p.json.ticket, ...instance(n, capabilities) }, null);
    return { pairing: p.json, conn };
  }
  let eventN = 0;
  const event = (seq, kind, payload, extra = {}) => ({ event_id: `event-${String(++eventN).padStart(6, '0')}`, seq, observed_at: Date.now(), kind, actor: 'system', payload, ...extra });
  const command = (action, targets, extra = {}, token) => request(base + '/commands', 'POST', { action, targets, idempotency_key: crypto.randomUUID(), reason_code: 'blocked_error', expected_roster_revision: 1, ...extra }, token);
  const receipt = (cmd, state, result_code = '') => ({ command_id: cmd.command_id, lease_generation: cmd.lease_generation, connection_epoch: cmd.connection_epoch, state, result_code, observed_at: Date.now() });
  const sync = (credential, events = [], n = 1, extra = {}) => request('/v1/classroom/ops/sync', 'POST', { schema_version: 1, app_instance_id: instance(n).app_instance_id, boot_id: instance(n).boot_id, capabilities: instance(n).capabilities, events, ...extra }, credential);
  // A snapshot the way the real App issues it (review F1): real-shaped spool metadata, and the binding produced by the
  // App's own freezer from the connect response. Tests never hand-write a binding.
  const { freezeSnapshot, freezeCollection } = await import('../../../extensions/hypeproof-chat/src/evidenceSnapshot.ts');
  const enc = (t) => new TextEncoder().encode(t), hex = (t) => createHash('sha256').update(t).digest('hex');
  // The App freezes a copy once and keeps its binding; the fixture freezes at a fixed instant so a re-seal is the same manifest.
  const opts_now = (conn) => conn.run.ends_at;
  const metaFor = (conn, over = {}) => JSON.stringify({ schema_version: 1, session_id: 'spool-' + conn.grant_id, user: conn.student, app_version: '0.1.56', os: 'synthetic', started_at: new Date(conn.run.starts_at).toISOString(), ...over });
  // `spool` is what the live SessionSpool reported with the bytes (its own counter, and other sessions of this learner in
  // the class window). Default: a healthy single session whose counter equals the last seq in the text. `spool: null`
  // is an App build that predates the sequence contract. A committed spool always ends with a newline.
  const lastSeqOf = (text) => Math.max(0, ...text.split('\n').map((l) => { try { const q = JSON.parse(l).seq; return Number.isSafeInteger(q) ? q : 0; } catch { return 0; } }));
  function sealBody(conn, batchId, eventsText, { meta = metaFor(conn), files, consent = { purpose: 'class_report', notice_version: 'notice-v1' }, spool } = {}) {
    const source = spool === null ? undefined : { sequence: { session_id: JSON.parse(meta).session_id, last_seq: spool?.last_seq ?? lastSeqOf(eventsText) }, other_sessions: spool?.other_sessions === undefined ? 0 : spool.other_sessions };
    const scope = { grant_id: conn.grant_id, class_run_id: conn.class_run_id, seat_id: conn.seat_id, student: conn.student, activity: conn.lesson ? { course_id: conn.lesson.course_id, version: conn.lesson.version } : null, run: conn.run };
    const frozen = freezeSnapshot([{ name: 'session.meta.json', data: enc(meta) }, { name: 'events.jsonl', data: enc(eventsText) }], scope, batchId, consent, opts_now(conn), source);
    if (!frozen.ok) throw Error('the App would not send this: ' + frozen.code);
    return { schema: 'hps-classroom-snapshot/2', files: files ?? [{ name: 'session.meta.json', bytes: Buffer.byteLength(meta), sha256: hex(meta) }, { name: 'events.jsonl', bytes: Buffer.byteLength(eventsText), sha256: hex(eventsText) }], binding: frozen.binding };
  }
  /**
   * #751 U1b — a batch that asked for kinds is collected the way the current App does it: the App's freezeCollection over the
   * current session (this fixture's text), sealed as schema /3. `spool.other_sessions` = sessions the App could not include.
   */
  const kindsOf = (batchId) => { try { const r = db?.prepare('SELECT kinds_json FROM classroom_collect_kinds WHERE batch_id=?').get(batchId); return r ? JSON.parse(r.kinds_json) : null; } catch { return null; } };
  /** The exact /3 files the App would freeze for this fixture text (a test that sends one file by hand sends these bytes). */
  function collectionFiles(conn, batchId, eventsText, kinds, { meta = metaFor(conn), consent = { purpose: 'class_report', notice_version: 'notice-v1' }, spool } = {}) {
    const scope = { grant_id: conn.grant_id, class_run_id: conn.class_run_id, seat_id: conn.seat_id, student: conn.student, activity: conn.lesson ? { course_id: conn.lesson.course_id, version: conn.lesson.version } : null, run: conn.run };
    const src = { current: { files: [{ name: 'session.meta.json', data: enc(meta) }, { name: 'events.jsonl', data: enc(eventsText) }], sequence: { session_id: JSON.parse(meta).session_id, last_seq: spool?.last_seq ?? lastSeqOf(eventsText) } }, others: [], omitted: { unreadable: spool?.other_sessions ?? 0, over_limit: 0 } };
    const frozen = freezeCollection(src, scope, batchId, consent, kinds ?? kindsOf(batchId), opts_now(conn));
    if (!frozen.ok) throw Error('the App would not send this: ' + frozen.code);
    return frozen;
  }
  async function uploadCollectionAs(conn, batchId, revision, eventsText, kinds, { meta = metaFor(conn), consent = { purpose: 'class_report', notice_version: 'notice-v1' }, spool } = {}) {
    const scope = { grant_id: conn.grant_id, class_run_id: conn.class_run_id, seat_id: conn.seat_id, student: conn.student, activity: conn.lesson ? { course_id: conn.lesson.course_id, version: conn.lesson.version } : null, run: conn.run };
    const src = { current: { files: [{ name: 'session.meta.json', data: enc(meta) }, { name: 'events.jsonl', data: enc(eventsText) }], sequence: { session_id: JSON.parse(meta).session_id, last_seq: spool?.last_seq ?? lastSeqOf(eventsText) } }, others: [], omitted: { unreadable: spool?.other_sessions ?? 0, over_limit: 0 } };
    const frozen = freezeCollection(src, scope, batchId, consent, kinds, opts_now(conn));
    if (!frozen.ok) throw Error('the App would not send this: ' + frozen.code);
    for (const f of frozen.files) { const r = await app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${batchId}/${revision}/${f.name}`, { method: 'PUT', headers: { authorization: 'Bearer ' + conn.credential }, body: f.data }), env, { waitUntil() {} }); if (r.status !== 201 && r.status !== 200) { const raw = await r.text(); let json; try { json = JSON.parse(raw); } catch {} return { status: r.status, json, raw }; } }
    return request(`/v1/classroom/ops/collect/snapshots/${batchId}/${revision}/seal`, 'POST', { schema: 'hps-classroom-snapshot/3', files: frozen.files.map((f) => ({ name: f.name, bytes: f.data.byteLength, sha256: createHash('sha256').update(f.data).digest('hex') })), collection: frozen.binding }, conn.credential);
  }
  /** PUT both files and seal, as the device uploader does (schema /3 when the batch asked for kinds). */
  async function uploadSnapshotAs(conn, batchId, revision, eventsText, opts = {}) {
    const kinds = opts.legacy ? null : kindsOf(batchId); if (kinds) return uploadCollectionAs(conn, batchId, revision, eventsText, kinds, opts);
    const meta = opts.meta ?? metaFor(conn);
    for (const [name, body] of [['session.meta.json', meta], ['events.jsonl', eventsText]]) { const r = await app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${batchId}/${revision}/${name}`, { method: 'PUT', headers: { authorization: 'Bearer ' + conn.credential }, body }), env, makeCtx()); if (!r.ok) return { status: r.status, json: await r.json() }; }
    return request(`/v1/classroom/ops/collect/snapshots/${batchId}/${revision}/seal`, 'POST', sealBody(conn, batchId, eventsText, { ...opts, meta }), conn.credential);
  }
  return { r2, app, env, db, cohort, profile, run, base, metaFor, sealBody, uploadSnapshotAs, collectionFiles, lesson, freeze, teacher, student, teacherToken, request, configure, pair, event, sync, command, receipt, instance, fail: (s) => { failure = s; }, close: () => db?.close() };
}
