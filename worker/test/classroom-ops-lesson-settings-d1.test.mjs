// Remote classroom operations (#751, U3) — what lesson settings cost and whether their conditional batches hold, measured on
// actual LOCAL workerd/D1 (miniflare), not the SQLite shim. Quantities are kept apart because they are not each other:
//   T  a learner question the Service ADMITS (one turn row)            R  a later model/SDK request of a turn (auxiliary, tool loop):
//                                                                          its dispatch permission is its own request row, and its usage row is linked to it
//   E  execution evidence written for a request (dispatch, outcome)    B  one instructor board refresh
// R is not T: the pinned Agent SDK sends an auxiliary request before the main loop under the SAME turn id, so a question is
// one T and several R. D1's own `meta.rows_read` / `meta.rows_written` are what is reported (rows scanned, rows written
// INCLUDING index maintenance) — not statements prepared, not rows returned. A statement without meta is UNMETERED and fails.
//
// This is NOT production D1: no network latency, no quota, no contention from other tenants, and the account's plan is
// unknown. The numbers gate regressions and check the model in docs/requirements/classroom-admin.md; they are not a bill.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createMiniflare } from './harness/miniflare.mjs';
import { localOps, OPS_ALL } from './harness/classroom-ops.mjs';
import { makeCtx, withMockUpstream, anthropicJsonBody, TEST_SECRET } from './harness/index.mjs';
const { setRoster } = await import('../src/lib/kv.ts');
const { issue } = await import('../src/lib/tokens.ts');
const { readLesson } = await import('../src/lib/lesson-delivery.ts');
const B = await import('../src/lib/lesson-binding.ts');
const compatibilityDate = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
const mf = createMiniflare({ modules: true, script: 'export default {fetch(){return new Response("local test")}}', compatibilityDate, d1Databases: ['HPS_DB'] });
const KEY = () => crypto.randomUUID(), FULL = ['observe', 'commands', 'distribution_inbox', 'inbox_prompt', 'lesson_binding'];
const U3 = ['classroom_lesson_bindings', 'classroom_lesson_turns', 'classroom_lesson_requests', 'classroom_input_basis', 'classroom_lesson_bindings_distribution', 'classroom_content_objects_setting'];
const squash = (sql) => String(sql).replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').replace(/ IF NOT EXISTS/g, '').trim();
let f;
try {
  const raw = await mf.getD1Database('HPS_DB');
  const apply = async (sql) => { for (const s of sql.replace(/^--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await raw.prepare(s).run(); };
  await raw.prepare('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, cohort_id TEXT, profile_id TEXT, starts_at TEXT, ends_at TEXT, ended_at TEXT)').run();
  const files = readdirSync(new URL('../migrations/', import.meta.url)).filter((x) => /^\d{4}-.*\.sql$/.test(x) && Number(x.slice(0, 4)) >= 11 && Number(x.slice(0, 4)) <= 24).sort();
  assert.equal(files.at(-1), '0024-classroom-lesson-bindings.sql', 'this test describes the newest classroom-ops migration');
  for (const m of files.slice(0, -1)) await apply(readFileSync(new URL(`../migrations/${m}`, import.meta.url), 'utf8'));
  const master = async () => Object.fromEntries((await raw.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results.map((r) => [r.name, r.sql]));
  const before = await master();
  for (let pass = 0; pass < 2; pass++) await apply(readFileSync(new URL('../migrations/0024-classroom-lesson-bindings.sql', import.meta.url), 'utf8'));
  const after = await master();
  for (const [name, sql] of Object.entries(before)) assert.equal(after[name], sql, 'unchanged by 0024: ' + name);
  assert.deepEqual(Object.keys(after).filter((n) => !(n in before)).sort(), [...U3].sort(), '0024 adds exactly these objects, and applying it twice adds nothing more');
  // fresh = cumulative: schema.sql (what a new database gets) defines the U3 objects exactly as the migration chain does.
  const fresh = new DatabaseSync(':memory:'); fresh.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  for (const n of U3) assert.equal(squash(fresh.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(n)?.sql), squash(after[n]), 'schema.sql and the migration agree on ' + n);
  fresh.close();
  // The measurements below need the tables that predate 0011 (usage, authoring): schema.sql is all IF NOT EXISTS, so applying it
  // on top supplies them and must leave every object the migration chain made exactly as it was.
  await apply(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '')); { const now = await master(); for (const [name, sql] of Object.entries(after)) assert.equal(now[name], sql, 'unchanged by schema.sql: ' + name); }
  console.log('PASS local D1: 0011→0023 then 0024 twice — earlier objects byte-identical, exactly six objects added, schema.sql agrees');

  // ── metering wrapper: counts what the Service really sends to D1 ──
  let m = null; const meter = () => (m = { statements: 0, batches: 0, max_binds: 0, rows_read: 0, rows_written: 0, unmetered: 0 });
  const take = (r) => { if (!m) return; m.statements++; const meta = r?.meta; if (meta && typeof meta.rows_read === 'number' && typeof meta.rows_written === 'number') { m.rows_read += meta.rows_read; m.rows_written += meta.rows_written; } else m.unmetered++; };
  const db = { prepare(sql) { let st = raw.prepare(sql); const w = { _st: () => st, bind(...a) { if (m) m.max_binds = Math.max(m.max_binds, a.length); st = st.bind(...a); return w; }, async run() { const r = await st.run(); take(r); return r; }, async all() { const r = await st.all(); take(r); return r; },
    // `first()` returns no meta on D1. The same statement is run through all() so that it is metered; the result is the same row.
    async first() { const r = await st.all(); take(r); return r.results?.[0] ?? null; } }; return w; },
    async batch(list) { const r = await raw.batch(list.map((x) => x._st())); if (m) m.batches++; for (const x of r) take(x); return r; } };
  const measured = async (fn) => { meter(); const out = await fn(); const cost = m; m = null; assert.equal(cost.unmetered, 0, 'every statement reported rows'); return { out, cost }; };
  const delta = (a, b) => ({ statements: a.statements - b.statements, rows_read: a.rows_read - b.rows_read, rows_written: a.rows_written - b.rows_written });
  const one = async (sql, ...a) => (await raw.prepare(sql).bind(...a).all()).results?.[0] ?? null, all = async (sql, ...a) => (await raw.prepare(sql).bind(...a).all()).results ?? [];

  f = await localOps({ binding: db }); f.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  // The usage row references sessions(id). Production has that row; without it every request here would pay a retry that is not the steady state.
  await raw.prepare('INSERT OR IGNORE INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)').bind(f.run, f.cohort, f.profile, new Date().toISOString(), new Date(Date.now() + 7200000).toISOString()).run();
  const course = f.lesson.course_id, V1 = f.lesson.version, V2 = 'm2026.09.18-2';
  const big = Array.from({ length: 200 }, (_, i) => ({ seat_id: 'S' + String(i + 1).padStart(3, '0'), student_id: 'big-' + String(i + 1).padStart(3, '0') }));
  await setRoster(f.env.HPS_KV, f.cohort, big.map((s) => s.student_id)); await f.freeze(course, V1, ['intro', 'build', 'review']);
  const authoring = `/admin/cohorts/${f.cohort}/authoring/${course}`, step = (id) => ({ id, title: id, instructions: '합성 단계 ' + id, hint: '', acceptance: '합성 기준' });
  { const cur = (await f.request(authoring)).json; const saved = await f.request(authoring, 'PUT', { profile_id: f.profile, request_id: KEY(), expected_revision: cur.revision ?? cur.draft?.revision, content: { schema: 'hps-session-design/1', title: '합성 수업 v2', audience: '합성 사용자', duration_minutes: 60, objective: '원격 운영 시험', prerequisites: '없음', starter: '연습 폴더', steps: ['intro', 'craft-v2', 'review'].map(step) } }); assert.equal(saved.status, 200, saved.raw);
    const fr = await f.request(`${authoring}/versions/${V2}`, 'PUT', { expected_revision: saved.json.revision ?? saved.json.draft?.revision, request_id: KEY() }); assert.ok(fr.status === 200 || fr.status === 201, fr.raw); }
  const sha = {}; for (const v of [V1, V2]) sha[v] = (await readLesson(f.env, f.cohort, course, v, f.profile)).sha256;
  const FLAGS = { ops_observe: true, ops_commands: true, ops_distribute: true, ops_lesson_settings: true };
  const L = await f.teacher('teacher-l', [...OPS_ALL, 'distribute', 'lesson_settings']);
  const token = async (s) => (await issue({ u: s.student_id, c: f.cohort, p: f.profile, lesson: { course_id: course, version: V1, sha256: sha[V1] } }, 2, TEST_SECRET)).token;
  const KEY1 = B.tokenBindingKey(sha[V1]);
  const minted = new Map(), tokenOf = async (u) => { if (!minted.has(u)) minted.set(u, await token({ student_id: u })); return minted.get(u); };
  async function ask(tok, { turn = KEY(), key, path = '/v1/messages' } = {}) {
    const ctx = makeCtx();
    return withMockUpstream(() => new Response(JSON.stringify(anthropicJsonBody({ text: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } }), async (calls) => {
      const r = await f.app.fetch(new Request('https://service.test' + path, { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', 'x-hps-turn-id': turn, ...(key ? { 'x-hps-lesson-binding': key } : {}) }, body: JSON.stringify({ model: 'claude-mock', max_tokens: 64, messages: [{ role: 'user', content: '합성 질문' }] }) }), f.env, ctx);
      await r.text(); await ctx.settle(); return { status: r.status, upstream: calls.length };
    });
  }
  const learner = (tok, path, method = 'GET', body) => f.app.fetch(new Request('https://service.test' + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), f.env, makeCtx());

  // ── the board at 30, 100 and 200 seats: off, on with no binding, on with every seat switched, on with three revisions of history ──
  const board = {}; let roster = 0;
  for (const n of [30, 100, 200]) {
    const put = await f.request(f.base, 'PUT', { expected_roster_revision: roster, seats: big.slice(0, n), flags: FLAGS, lesson: f.lesson }); assert.ok(put.status === 200 || put.status === 201, put.raw); roster++;
    await raw.prepare('DELETE FROM classroom_lesson_bindings').run();
    const status = () => measured(async () => { const r = await f.request(f.base + '/status', 'GET', undefined, L); assert.equal(r.status, 200, r.raw); assert.equal(r.json.seats.length, n); return r.json; });
    f.env.HPS_LESSON_BINDINGS = undefined; await raw.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_lesson_settings',json('false'))").run();
    const off = await status(); assert.equal(off.out.seats[0].lesson?.source ?? 'run', 'run');
    f.env.HPS_LESSON_BINDINGS = 'enforce'; await raw.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_lesson_settings',json('true'))").run();
    const none = await status();
    const seats = await all('SELECT seat_id,seat_revision,student_id FROM class_run_seats WHERE class_run_id=? AND replaced_at IS NULL', f.run); assert.equal(seats.length, n);
    const insert = async (seq) => { for (let i = 0; i < seats.length; i += 10) await raw.batch(seats.slice(i, i + 10).map((s) => raw.prepare("INSERT INTO classroom_lesson_bindings(class_run_id,student_id,binding_seq,seat_id,seat_revision,binding_key,source,distribution_id,object_id,revision,content_hash,course_id,version,lesson_sha256,base_lesson_sha256,steps_json,activated_at) VALUES (?,?,?,?,?,?,'setting',?,?,?,?,?,?,?,?,'[\"intro\",\"craft-v2\",\"review\"]',?)").bind(f.run, s.student_id, seq, s.seat_id, s.seat_revision, (seq + s.seat_id).padEnd(32, '0').slice(0, 32).replace(/[^a-f0-9]/g, 'a'), 'dist-' + seq, 'obj', seq, 'c'.repeat(64), course, V2, sha[V2], sha[V1], Date.now()))); };
    await insert(1); const bound = await status(); assert.deepEqual([...new Set(bound.out.seats.map((s) => s.lesson.source + '/' + s.lesson.version))], ['setting/' + V2]);
    await insert(2); await insert(3); const deep = await status(); assert.deepEqual([...new Set(deep.out.seats.map((s) => s.lesson.binding_seq))], [3]);
    board[n] = { off: off.cost, none: none.cost, bound: bound.cost, deep: deep.cost };
  }
  console.log('  B — one board refresh (GET …/status), whole request:');
  for (const n of [30, 100, 200]) console.log(`    ${n} seats → off ${JSON.stringify(board[n].off)} · on, no binding +${JSON.stringify(delta(board[n].none, board[n].off))} · every seat switched +${JSON.stringify(delta(board[n].bound, board[n].off))} · 3 revisions each +${JSON.stringify(delta(board[n].deep, board[n].off))}`);
  for (const n of [30, 100, 200]) { const b = board[n], on = delta(b.deep, b.off);
    assert.equal(on.statements, 1, 'the board adds ONE statement for every seat together, not one per seat'); assert.equal(b.deep.rows_written, b.off.rows_written, 'a refresh writes nothing because of settings');
    assert.ok(on.rows_read <= 2 * n + 10, `rows read for ${n} seats are bounded by seats: ${on.rows_read}`);
    assert.ok(delta(b.deep, b.bound).rows_read <= 5, `…and not by how many revisions a run has seen (${delta(b.deep, b.bound).rows_read} more rows for 3× the history)`); }
  console.log('PASS local D1: board +1 statement, +0 writes; rows read grow with seats, not with binding history');
  await raw.prepare('DELETE FROM classroom_lesson_bindings').run();

  // ── one learner: what a request costs with enforcement off, as the first request of a turn (T+R+E), and as a later one (R) ──
  const seat = big[0], tok = await token(seat);
  f.env.HPS_LESSON_BINDINGS = undefined; await ask(tok); // warm: the first request of a student writes usage rows that are not the steady state
  const offReq = await measured(() => ask(tok)); assert.deepEqual([offReq.out.status, offReq.out.upstream], [200, 1]);
  const offProfile = await measured(async () => (await learner(tok, '/v1/profile')).status); assert.equal(offProfile.out, 200);
  f.env.HPS_LESSON_BINDINGS = 'enforce';
  const turn = KEY(), first = await measured(() => ask(tok, { turn, key: KEY1 })); assert.deepEqual([first.out.status, first.out.upstream], [200, 1]);
  const later = await measured(() => ask(tok, { turn, key: KEY1 })); assert.equal(later.out.status, 200);
  const profile = await measured(async () => (await learner(tok, '/v1/profile')).status); assert.equal(profile.out, 200);
  const state = await measured(async () => { const r = await learner(tok, '/v1/lesson-turns/' + turn); return { status: r.status, json: await r.json() }; }); assert.equal(state.out.status, 200, JSON.stringify(state.out.json)); assert.equal(state.out.json.state, 'completed');
  const close = await measured(async () => (await learner(tok, `/v1/lesson-turns/${turn}/close`, 'POST', { outcome: 'completed' })).status); assert.equal(close.out, 200);
  assert.equal((await ask(tok, { turn, key: KEY1 })).status, 403, 'a closed turn id is refused on real D1 as well');
  const refused = await measured(() => ask(tok, { turn: KEY(), key: 'a'.repeat(32) })); assert.deepEqual([refused.out.status, refused.out.upstream], [403, 0]);
  const T = delta(first.cost, offReq.cost), R = delta(later.cost, offReq.cost);
  console.log(`  request, enforcement OFF (baseline)        → ${JSON.stringify(offReq.cost)}`);
  console.log(`  T — first request of a turn (admit+E)      → ${JSON.stringify(first.cost)}  Δ ${JSON.stringify(T)}`);
  console.log(`  R — later request of the same turn         → ${JSON.stringify(later.cost)}  Δ ${JSON.stringify(R)}`);
  console.log(`  refused before admission (stale key)       → ${JSON.stringify(refused.cost)}`);
  console.log(`  /v1/profile off → enforce                  → ${JSON.stringify(offProfile.cost)} → ${JSON.stringify(profile.cost)}`);
  console.log(`  turn state read · turn close               → ${JSON.stringify(state.cost)} · ${JSON.stringify(close.cost)}`);
  const turnRow = await one('SELECT * FROM classroom_lesson_turns WHERE turn_id=?', turn);
  assert.ok(turnRow.first_dispatched_at && turnRow.first_completed_at && turnRow.closed_at, 'admitted, dispatched, completed and closed are all on the ONE turn row');
  assert.equal((await one('SELECT count(*) n FROM classroom_lesson_turns WHERE student_id=?', seat.student_id)).n, 1, 'two requests of one turn are one T; a refusal admits nothing');
  // Identity on REAL D1: each permitted request has its row, and the usage row stored for it is the one it points at —
  // `last_insert_rowid()` inside a D1 batch is the usage row that batch just stored (not assumed: read back and joined).
  const linked = await all("SELECT q.request_id,q.usage_row_id,u.id,u.status,u.user_id FROM classroom_lesson_requests q LEFT JOIN usage_log u ON u.id=q.usage_row_id WHERE q.student_id=? ORDER BY q.permitted_at", seat.student_id);
  assert.equal(linked.length, 2, 'two permitted requests, two request rows'); assert.ok(linked.every((r) => r.usage_row_id !== null && r.id === r.usage_row_id && r.user_id === seat.student_id && r.status === 200), 'each points at its own usage row: ' + JSON.stringify(linked)); assert.equal(new Set(linked.map((r) => r.usage_row_id)).size, 2);
  const stray = await one("SELECT count(*) n FROM usage_log u WHERE u.user_id=? AND u.status BETWEEN 200 AND 299 AND u.id NOT IN (SELECT usage_row_id FROM classroom_lesson_requests WHERE student_id=? AND usage_row_id IS NOT NULL)", seat.student_id, seat.student_id); assert.equal(stray.n, 2, 'the two answered requests made BEFORE enforcement was switched on (the warm-up and the baseline) are exactly the unattributed ones');
  assert.ok(T.statements <= 10 && T.rows_written <= 7, 'T: ' + JSON.stringify(T)); assert.ok(R.statements <= 4 && R.rows_written <= 3, 'R = the gate\'s read batch + ONE conditional INSERT (the last permission check and the request\'s own record) + the link written in the usage row\'s batch: ' + JSON.stringify(R));
  assert.ok(state.cost.statements === 1 && state.cost.rows_written === 0 && close.cost.statements === 2 && close.cost.rows_written === 1, 'a turn is read and closed where it was admitted (the cohort\'s runs), in one and two statements');
  assert.equal(profile.cost.rows_written, offProfile.cost.rows_written, 'reading a profile writes nothing'); assert.ok(profile.cost.statements - offProfile.cost.statements <= 2);
  assert.ok(first.cost.statements <= 45, 'a whole model request stays under D1\'s 50 queries per invocation (Free plan)');
  assert.equal(refused.cost.rows_written - 0 <= offReq.cost.rows_written, true, 'a refusal writes no evidence');
  // The seal's basis statement: two ledgers compared (turn rows of this participant + their answered usage rows), one written row.
  const { sealBasisStatement } = await import('../src/lib/lesson-basis.ts');
  const seal = await measured(async () => { await sealBasisStatement(db, { batch_id: 'd1-seal-probe', student_id: seat.student_id, revision: 1, class_run_id: f.run, now: Date.now() }).run(); return (await one("SELECT basis,lessons,turns FROM classroom_input_basis WHERE batch_id='d1-seal-probe'")); });
  console.log(`  seal basis statement (this learner: ${seal.out.turns} turns) → ${JSON.stringify(seal.cost)} → ${JSON.stringify(seal.out)}`);
  // never switched → single, although two of this learner's answered requests predate enforcement (a token-lesson learner is single whether or not enforcement recorded it)
  assert.deepEqual([seal.out.basis, seal.cost.statements, seal.cost.rows_written <= 2], ['single', 1, true], JSON.stringify(seal)); assert.ok(seal.cost.rows_read <= 40, 'bounded by this participant\'s own turns and usage rows: ' + seal.cost.rows_read);
  console.log('PASS local D1: T = turn row + request row + first dispatch + outcome + usage link; R = request row + usage link; every request points at its own usage row; profile/state reads write nothing');

  // ── D: "one batch, two tables" is real on D1 — row counts, and a batch whose guard fails changes NEITHER table ──
  const { recordDispatch, recordOutcome } = await import('../src/lib/lesson-binding-store.ts');
  const conn = (await f.pair(seat.seat_id, roster, 1, FULL)).conn.json;
  const setting = (await f.request(f.base + '/contents', 'POST', { idempotency_key: KEY(), kind: 'setting', title: '2번째 판', body: '다음 질문부터 새 단계로 진행합니다.', lesson: { course_id: course, version: V2, sha256: sha[V2] } }, L)).json; assert.ok(setting.object_id, JSON.stringify(setting));
  const distribute = async (targets) => { await raw.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run(); const r = await f.request(f.base + '/distributions', 'POST', { idempotency_key: KEY(), expected_roster_revision: roster, object_id: setting.object_id, revision: 1, content_hash: setting.content_hash, targets }, L); assert.equal(r.status, 201, r.raw); return r.json; };
  const takeItem = async (c, n) => { await raw.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); const r = await f.sync(c.credential, [], n, {}); const item = r.json.distribution?.items?.[0]; assert.ok(item, r.raw); const rc = (stage) => ({ offer_key: item.offer_key, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, seq: item.seq, stage, result_code: '', observed_at: Date.now() }); await f.sync(c.credential, [], n, { distribution: { receipts: [rc('received'), rc('reflected')] } }); return item; };
  const activate = async (c, n, item) => f.request('/v1/classroom/ops/lesson-binding', 'POST', { app_instance_id: f.instance(n).app_instance_id, boot_id: f.instance(n).boot_id, offer_key: item.offer_key, distribution_id: item.distribution_id, object_id: item.object_id, revision: item.revision, content_hash: item.content_hash, base_lesson_sha256: sha[V1], learner_token: await tokenOf(c.student.u) }, c.credential);
  await distribute([seat.seat_id]); const item = await takeItem(conn, 1);
  const act = await measured(() => activate(conn, 1, item)); assert.equal(act.out.status, 201, act.out.raw); assert.equal(act.out.json.recorded, true);
  const replay = await measured(() => activate(conn, 1, item)); assert.deepEqual([replay.out.status, replay.out.json.replayed, replay.out.json.binding.key], [200, true, act.out.json.binding.key], replay.out.raw);
  console.log(`  switch (POST …/lesson-binding) · its replay → ${JSON.stringify(act.cost)} · ${JSON.stringify(replay.cost)}`);
  assert.ok(act.cost.statements <= 20 && act.cost.rows_written <= 8, JSON.stringify(act.cost)); assert.equal((await one('SELECT count(*) n FROM classroom_lesson_bindings WHERE student_id=?', seat.student_id)).n, 1, 'a replay is not a second binding');
  const K2 = act.out.json.binding.key, t2 = KEY(); assert.equal((await ask(tok, { turn: t2, key: K2 })).status, 200);
  let rows = [await one('SELECT first_dispatched_at d,first_completed_at c,binding_seq s FROM classroom_lesson_turns WHERE turn_id=?', t2), await one('SELECT first_dispatched_at d,first_completed_at c FROM classroom_lesson_bindings WHERE student_id=? AND binding_seq=1', seat.student_id)];
  assert.ok(rows[0].d && rows[0].c && rows[0].s === 1 && rows[1].d === rows[0].d && rows[1].c === rows[0].c, 'turn and binding carry the SAME dispatch and completion instants: ' + JSON.stringify(rows));
  // A turn the host closed before dispatch: the batch's guards fail, and NEITHER table changes (checked by meta.changes and by reading both rows).
  await raw.prepare('UPDATE classroom_lesson_bindings SET first_dispatched_at=NULL,first_completed_at=NULL WHERE student_id=?').bind(seat.student_id).run();
  const t3 = KEY(); await raw.prepare("INSERT INTO classroom_lesson_turns(class_run_id,student_id,turn_id,token_jti,binding_seq,binding_key,course_id,version,lesson_sha256,admitted_at,closed_at,close_outcome) VALUES (?,?,?,?,1,?,?,?,?,?,?,'aborted')").bind(f.run, seat.student_id, t3, 'jti', K2, course, V2, sha[V2], Date.now(), Date.now()).run();
  const t3row = await one('SELECT * FROM classroom_lesson_turns WHERE turn_id=?', t3);
  const changes = []; const spy = { ...f.env, HPS_DB: { prepare: (s) => db.prepare(s), batch: async (l) => { const r = await db.batch(l); changes.push(r.map((x) => x.meta?.changes ?? null)); return r; } } };
  assert.deepEqual(await recordDispatch(spy, { ...t3row, first_dispatched_at: null }, { request: 'req-1', runtime: 'proxy', model: 'claude-mock', now: Date.now() }), { ok: false, code: 'lesson_turn_closed' });
  assert.deepEqual(changes.at(-1).slice(0, 2), [0, 0], 'D1 reports zero rows changed in BOTH statements of the refused batch');
  assert.equal((await one('SELECT first_dispatched_at d FROM classroom_lesson_bindings WHERE student_id=? AND binding_seq=1', seat.student_id)).d, null, 'the binding is not marked attempted by a dispatch that did not happen');
  await raw.prepare('UPDATE classroom_lesson_turns SET closed_at=NULL WHERE turn_id=?').bind(t3).run();
  assert.deepEqual(await recordDispatch(spy, { ...t3row, first_dispatched_at: null, closed_at: null }, { request: 'req-2', runtime: 'proxy', model: 'claude-mock', now: 1234567 }), { ok: true }); assert.deepEqual(changes.at(-1).slice(0, 2), [1, 1], 'one row in each table, in one batch');
  await recordOutcome(spy, { ...t3row, first_dispatched_at: 1234567, closed_at: null }, 'completed', { status: 200, now: 1234999 }); assert.deepEqual(changes.at(-1), [1, 1]);
  await recordOutcome(spy, { ...t3row, first_dispatched_at: 1234567, closed_at: null }, 'completed', { status: 200, now: 9999999 }); assert.deepEqual(changes.at(-1), [0, 0], 'first-only: a second completion changes nothing');
  rows = [await one('SELECT first_dispatched_at d,first_completed_at c FROM classroom_lesson_turns WHERE turn_id=?', t3), await one('SELECT first_dispatched_at d,first_completed_at c FROM classroom_lesson_bindings WHERE student_id=? AND binding_seq=1', seat.student_id)];
  assert.deepEqual(rows, [{ d: 1234567, c: 1234999 }, { d: 1234567, c: 1234999 }]);
  console.log('PASS local D1: dispatch and outcome change the turn row and the binding row in ONE batch — [1,1] when the guard holds, [0,0] when it does not');

  // ── contention on real D1: 30 learners switch at once, and one learner is switched by two distributions at once ──
  const crowd = big.slice(1, 31), conns = []; for (const [i, s] of crowd.entries()) conns.push((await f.pair(s.seat_id, roster, i + 2, FULL)).conn.json);
  await distribute(crowd.map((s) => s.seat_id)); const items = []; for (const [i, c] of conns.entries()) items.push(await takeItem(c, i + 2));
  const burst = await measured(() => Promise.all(conns.map((c, i) => activate(c, i + 2, items[i]))));
  assert.deepEqual([...new Set(burst.out.map((r) => r.status + ':' + r.json.recorded))], ['201:true'], JSON.stringify(burst.out.find((r) => r.status !== 201)?.json));
  assert.deepEqual(await all('SELECT count(*) n,min(binding_seq) lo,max(binding_seq) hi,count(DISTINCT student_id) s FROM classroom_lesson_bindings WHERE distribution_id=?', items[0].distribution_id), [{ n: 30, lo: 1, hi: 1, s: 30 }]);
  console.log(`  30 concurrent switches (whole burst)       → ${JSON.stringify(burst.cost)} · per learner ≈ ${JSON.stringify({ statements: burst.cost.statements / 30, rows_read: Math.round(burst.cost.rows_read / 30), rows_written: burst.cost.rows_written / 30 })}`);
  // The seal for a SWITCHED learner with many requests: the identity join reads requests + usage rows ONCE each (linear), it is
  // not a per-usage-row probe of the request table (quadratic). 50 then 100 linked requests of one learner; then one stray answered row.
  const heavy = crowd[5].student_id, sealFor = async (batch) => measured(async () => { await sealBasisStatement(db, { batch_id: batch, student_id: heavy, revision: 1, class_run_id: f.run, now: Date.now() }).run(); return (await one('SELECT basis FROM classroom_input_basis WHERE batch_id=?', batch)).basis; });
  const addLinked = async (from, to) => { for (let i = from; i < to; i += 10) { const ids = []; for (let k = i; k < Math.min(to, i + 10); k++) { const r = await raw.prepare("INSERT INTO usage_log(session_id,cohort_id,user_id,profile_id,model,status) VALUES(?,?,?,?,?,200)").bind(f.run, f.cohort, heavy, f.profile, 'm').run(); ids.push([k, r.meta.last_row_id]); }
    await raw.batch(ids.map(([k, id]) => raw.prepare('INSERT INTO classroom_lesson_requests(class_run_id,student_id,request_id,turn_id,binding_seq,lesson_sha256,permitted_at,usage_row_id) VALUES(?,?,?,?,1,?,?,?)').bind(f.run, heavy, 'heavy-' + k, 'heavy-turn-' + k, sha[V2], Date.now(), id))); } };
  await addLinked(0, 50); const s50 = await sealFor('d1-heavy-50'); await addLinked(50, 100); const s100 = await sealFor('d1-heavy-100');
  console.log(`  seal basis, switched learner: 50 requests → ${JSON.stringify(s50.cost)} · 100 requests → ${JSON.stringify(s100.cost)}`);
  assert.deepEqual([s50.out, s100.out], ['single', 'single']); assert.ok(s100.cost.rows_read <= 2.4 * s50.cost.rows_read && s100.cost.rows_read <= 100 * 6, 'linear in the learner\'s own rows: ' + s50.cost.rows_read + ' → ' + s100.cost.rows_read);
  await raw.prepare("INSERT INTO usage_log(session_id,cohort_id,user_id,profile_id,model,status) VALUES(?,?,?,?,?,200)").bind(f.run, f.cohort, heavy, f.profile, 'm').run(); assert.equal((await sealFor('d1-heavy-stray')).out, 'unknown', 'one answered row that no permitted request points at, among 100 that are: held');

  // The same switch sent twice at once (a retry racing its original): one row, the loser answers with that row as a replay.
  const solo = big[31], cs = (await f.pair(solo.seat_id, roster, 40, FULL)).conn.json; await distribute([solo.seat_id]); const it1 = await takeItem(cs, 40);
  const dup = await Promise.all([activate(cs, 40, it1), activate(cs, 40, it1), activate(cs, 40, it1)]);
  assert.deepEqual(dup.map((r) => r.status).sort(), [200, 200, 201], JSON.stringify(dup.map((r) => r.json))); assert.equal(new Set(dup.map((r) => r.json.binding.key)).size, 1);
  // A newer revision (the explicit return) reaches the same learner; the device answers the old and the new offer at once.
  // By design the newer revision wins: the old one is a replay of what already happened, the new one takes the NEXT sequence number.
  const back = (await f.request(f.base + '/contents', 'POST', { idempotency_key: KEY(), kind: 'setting', title: '기본 수업으로 복귀', body: '기본으로 돌아갑니다.', base: true, object_id: setting.object_id, expected_latest_revision: 1 }, L)).json; assert.equal(back.revision, 2, JSON.stringify(back));
  await raw.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run();
  const r2 = await f.request(f.base + '/distributions', 'POST', { idempotency_key: KEY(), expected_roster_revision: roster, object_id: setting.object_id, revision: 2, content_hash: back.content_hash, targets: [solo.seat_id] }, L); assert.equal(r2.status, 201, r2.raw); const it2 = await takeItem(cs, 40);
  const race = await Promise.all([activate(cs, 40, it1), activate(cs, 40, it2), activate(cs, 40, it2)]); assert.deepEqual(race.map((r) => r.status).sort(), [200, 200, 201], JSON.stringify(race.map((r) => r.json)));
  const seqs = await all('SELECT binding_seq,source FROM classroom_lesson_bindings WHERE student_id=? ORDER BY binding_seq', solo.student_id);
  assert.deepEqual(seqs, [{ binding_seq: 1, source: 'setting' }, { binding_seq: 2, source: 'base' }], 'no sequence number is lost, reused or doubled under contention');
  console.log('PASS local D1: 30 concurrent switches → 30 rows, one each; a tripled switch → one row; old and new offers answered at once → consecutive sequence numbers');
} finally { f?.close(); await mf.dispose(); }
