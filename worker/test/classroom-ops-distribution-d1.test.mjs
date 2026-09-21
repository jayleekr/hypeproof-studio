// Remote classroom operations (#751, U2) — what distribution costs, measured on actual LOCAL workerd/D1 (miniflare), not the
// SQLite shim: statements per invocation, bound parameters, and D1's own `meta.rows_read` / `meta.rows_written` (rows
// scanned and rows written INCLUDING index maintenance — that is what D1 bills and limits, not rows returned).
//
// This is NOT production D1: no network latency, no quota, no 30-second batch limit under load, and the account's plan is
// unknown. The numbers gate regressions and check the model in docs/requirements/classroom-admin.md; they are not a claim
// about a Cloudflare bill. A statement whose result carried no meta is counted as UNMETERED and fails the gate — never as 0.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createMiniflare } from './harness/miniflare.mjs';
import { localOps, OPS_ALL } from './harness/classroom-ops.mjs';
const { setRoster } = await import('../src/lib/kv.ts');
const compatibilityDate = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
const mf = createMiniflare({ modules: true, script: 'export default {fetch(){return new Response("local test")}}', compatibilityDate, d1Databases: ['HPS_DB'] });
const KEY = () => crypto.randomUUID(), CAPS = ['observe', 'distribution_inbox'];
let f;
try {
  const raw = await mf.getD1Database('HPS_DB');
  const apply = async (sql) => { for (const s of sql.replace(/^--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await raw.prepare(s).run(); };
  await raw.prepare('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, cohort_id TEXT, profile_id TEXT, starts_at TEXT, ends_at TEXT, ended_at TEXT)').run();
  const files = readdirSync(new URL('../migrations/', import.meta.url)).filter((x) => /^\d{4}-.*\.sql$/.test(x) && Number(x.slice(0, 4)) >= 11).sort();
  assert.equal(files.at(-1), '0023-classroom-distribution.sql');
  const before = (await raw.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
  for (let pass = 0; pass < 2; pass++) for (const m of files) await apply(readFileSync(new URL(`../migrations/${m}`, import.meta.url), 'utf8'));
  // additive: every object that existed before 0023 is byte-identical after it, and applying twice is a no-op
  const schema = Object.fromEntries((await raw.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results.map((r) => [r.name, r.sql]));
  for (const b of before) assert.equal(schema[b.name], b.sql, 'unchanged by the migrations: ' + b.name);
  for (const t of ['classroom_content_objects', 'classroom_content_revisions', 'classroom_distributions', 'classroom_distribution_targets', 'classroom_distribution_cards', 'ops_issuer_fences', 'classroom_distribution_targets_pending', 'classroom_distribution_cards_pending']) assert.ok(schema[t], 'created: ' + t);
  console.log('PASS local D1: 0011→0023 applied twice, earlier objects unchanged, U2 tables and partial indexes present');

  // ── metering wrapper: counts what the Service really sends to D1 ──
  let m = null; const meter = () => (m = { statements: 0, batches: 0, max_binds: 0, rows_read: 0, rows_written: 0, unmetered: 0 });
  const take = (r) => { if (!m) return; m.statements++; const meta = r?.meta; if (meta && typeof meta.rows_read === 'number' && typeof meta.rows_written === 'number') { m.rows_read += meta.rows_read; m.rows_written += meta.rows_written; } else m.unmetered++; };
  const db = { prepare(sql) { let st = raw.prepare(sql); const w = { _st: () => st, bind(...a) { if (m) m.max_binds = Math.max(m.max_binds, a.length); st = st.bind(...a); return w; }, async run() { const r = await st.run(); take(r); return r; }, async all() { const r = await st.all(); take(r); return r; },
    // `first()` returns no meta on D1. The same statement is run through all() so that it is metered; the result is the same row.
    async first() { const r = await st.all(); take(r); return r.results?.[0] ?? null; } }; return w; },
    async batch(list) { const r = await raw.batch(list.map((x) => x._st())); if (m) m.batches++; for (const x of r) take(x); return r; } };
  f = await localOps({ binding: db });
  const big = Array.from({ length: 200 }, (_, i) => ({ seat_id: 'S' + String(i + 1).padStart(3, '0'), student_id: 'big-' + String(i + 1).padStart(3, '0') }));
  await setRoster(f.env.HPS_KV, f.cohort, big.map((s) => s.student_id));
  const plain = (flags) => f.request(f.base, 'PUT', { expected_roster_revision: 0, seats: big, flags });
  assert.equal((await plain({ ops_observe: true, ops_distribute: true })).status, 201);
  const X = await f.teacher('teacher-x', [...OPS_ALL, 'distribute']);
  const o = (await f.request(f.base + '/contents', 'POST', { idempotency_key: KEY(), kind: 'notice', title: '전체 공지', body: '가'.repeat(1500) }, X)).json;

  const commit = {}; for (const n of [30, 100, 200]) {
    await raw.prepare('UPDATE classroom_distributions SET created_at=created_at-120000').run(); meter();
    const r = await f.request(f.base + '/distributions', 'POST', { idempotency_key: KEY(), expected_roster_revision: 1, object_id: o.object_id, revision: 1, content_hash: o.content_hash, targets: big.slice(0, n).map((s) => s.seat_id) }, X);
    assert.equal(r.status, 201, r.raw); assert.equal(r.json.targets.length, n); commit[n] = m; m = null;
  }
  console.log('  commit (incl. authorization reads, the conditional batch, settlement and the result view):'); for (const n of [30, 100, 200]) console.log(`    ${n} seats → ${JSON.stringify(commit[n])}`);
  for (const n of [30, 100, 200]) { assert.equal(commit[n].unmetered, 0, 'every statement reported rows'); assert.equal(commit[n].statements, commit[30].statements, 'the statement count does not grow with the class'); assert.ok(commit[n].statements <= 24 && commit[n].max_binds <= 30, JSON.stringify(commit[n])); }
  assert.ok(commit[200].rows_written <= 200 * 5 + 40, 'rows written per target at commit (row + indexes): ' + commit[200].rows_written);
  console.log('PASS local D1: one conditional batch for 30, 100 and 200 seats — same statements, ≤ 30 binds, no per-seat fan-out');

  // ── sync cost for one seat ──
  const conn = (await f.pair('S001', 1, 1, CAPS)).conn.json, sync = (extra) => f.sync(conn.credential, [], 1, extra);
  // The harness's sync declares instance(n)'s default capabilities for a NEW window; this device paired with CAPS, so its row already says distribution_inbox.
  await raw.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_distribute',json('false'))").run();
  await sync(); // first contact writes the device/state rows; not what an idle sync costs
  const measure = async (extra) => { meter(); const r = await sync(extra); const got = m; m = null; assert.equal(r.status, 200, r.raw); return { r, cost: got }; };
  const off = await measure(); assert.equal(off.r.json.distribution, undefined);
  await raw.prepare("UPDATE class_run_ops SET flags_json=json_set(flags_json,'$.ops_distribute',json('true'))").run();
  await raw.prepare('UPDATE classroom_distribution_targets SET pending=0 WHERE seat_id=?').bind('S001').run(); // nothing to say to this seat: the idle case
  const idle = await measure(); assert.equal(idle.r.json.distribution, undefined);
  await raw.prepare("UPDATE classroom_distribution_targets SET pending=1 WHERE seat_id=? AND state='accepted'").bind('S001').run();
  const offer = await measure(); assert.deepEqual([offer.r.json.distribution.items.length, offer.r.json.distribution.more], [2, true], 'three runs are waiting for this seat: two now, the third on the next poll');
  const it = offer.r.json.distribution.items, rc = (x, stage) => ({ offer_key: x.offer_key, distribution_id: x.distribution_id, object_id: x.object_id, revision: x.revision, content_hash: x.content_hash, seq: x.seq, stage, result_code: '', observed_at: Date.now() });
  const receipts = await measure({ distribution: { receipts: [rc(it[0], 'received'), rc(it[0], 'reflected')] } }); assert.deepEqual(receipts.r.json.distribution.receipt_acks.map((a) => a.recorded), [true, true]);
  console.log(`  sync, feature OFF (idle)         → ${JSON.stringify(off.cost)}`); console.log(`  sync, feature ON, nothing pending → ${JSON.stringify(idle.cost)}`); console.log(`  sync carrying 2 offers           → ${JSON.stringify(offer.cost)}`); console.log(`  sync with received+reflected     → ${JSON.stringify(receipts.cost)}`);
  for (const c of [off.cost, idle.cost, offer.cost, receipts.cost]) assert.equal(c.unmetered, 0);
  assert.equal(idle.cost.rows_written, off.cost.rows_written, 'an idle sync writes nothing because of distribution'); assert.ok(idle.cost.statements - off.cost.statements <= 1, 'at most one extra statement (the partial-index probe) when the feature is on'); assert.ok(idle.cost.rows_read - off.cost.rows_read <= 2, 'and it scans next to nothing: ' + (idle.cost.rows_read - off.cost.rows_read));
  assert.ok(offer.cost.statements <= 45 && receipts.cost.statements <= 45, 'one sync stays under D1\'s 50 queries per invocation (Free plan) with room to spare');
  assert.ok(receipts.cost.rows_written - idle.cost.rows_written <= 20, 'rows written to deliver to one learner: ' + (receipts.cost.rows_written - idle.cost.rows_written));
  console.log('PASS local D1: idle sync +0 writes and ≤ +1 statement; a sync with offers or receipts ≤ 45 statements; ≤ 20 rows written per delivered learner');
} finally { f?.close(); await mf.dispose(); }
