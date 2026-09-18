// Synthetic remote-operations fixture: real HTTP routing, real token verifier,
// SQLite with transactional batch. Two teachers, two students, another cohort.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './index.mjs';
// Node SQLite binds positionally; the existing board SQL uses ?N, so numbered
// parameters are mapped here exactly as harness/classroom.mjs does. SQL is unchanged.
function sqliteBinding(db) {
  return { prepare(sql) {
    let args = [];
    const params = () => { const n = [...sql.matchAll(/\?(\d+)/g)]; return n.length ? n.map((m) => args[Number(m[1]) - 1]) : args; };
    const q = () => db.prepare(sql.replace(/\?\d+/g, '?'));
    const stmt = { bind(...a) { args = a; return stmt; },
      _run() { const r = q().run(...params()); return { success: true, results: [], meta: { changes: Number(r.changes) } }; },
      async run() { return stmt._run(); }, async first() { return q().get(...params()) ?? null; },
      async all() { return { success: true, results: q().all(...params()) }; } };
    return stmt;
  }, async batch(statements) { db.exec('BEGIN'); try { const r = statements.map((x) => x._run()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
export const OPS_ALL = ['observe', 'manage', 'command', 'reset', 'pause', 'coach', 'collect', 'review', 'deliver'];
export async function localOps({ enabled = true, binding } = {}) {
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
  const r2 = new Map(); env.HPS_TRACES = { async put(key, value) { if (failure === 'R2 put') throw Error('injected R2 failure'); r2.set(key, value instanceof ArrayBuffer ? value.slice(0) : new TextEncoder().encode(String(value)).buffer); }, async get(key) { const v = r2.get(key); return v ? { arrayBuffer: async () => v, text: async () => new TextDecoder().decode(v) } : null; }, async list({ prefix = '' } = {}) { return { objects: [...r2.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; } };
  const cohort = 'boah-dental-2026-a', profile = 'boah-dental-director-copyclone-2026-s1', run = 'ops-test-run';
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
  const step = (id) => ({ id, title: id, instructions: '합성 단계', hint: '', acceptance: '합성 기준' });
  const design = (ids) => ({ schema: 'hps-session-design/1', title: '합성 수업', audience: '합성 사용자', duration_minutes: 60, objective: '원격 운영 시험', prerequisites: '', starter: '연습 폴더', steps: ids.map(step) });
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
  return { r2, app, env, db, cohort, profile, run, base, lesson, freeze, teacher, student, teacherToken, request, configure, pair, event, sync, command, receipt, instance, fail: (s) => { failure = s; }, close: () => db?.close() };
}
