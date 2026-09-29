// Remote classroom operations (#751) — AT-27/29: what the Service says about records written by the REAL SessionSpool
// and frozen by the REAL App freezer. Nothing here hand-writes a seq, a range or a binding.
//
// Found 2026-09-21 on a real Mac: the live spool wrote no seq, so even the newest build's record was
// `sequence_unavailable`. The opposite failure matters more: `complete` must never be reachable while something is
// missing. Positive control = a healthy session is `complete`. Every other case is a negative control for `complete`.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { localOps } from './harness/classroom-ops.mjs';
import { setRoster } from '../src/lib/kv.ts';
import { SessionSpool } from '../../extensions/hypeproof-chat/src/sessionSpool.ts';
import { freezeSnapshot, WINDOW_LEAD_MS } from '../../extensions/hypeproof-chat/src/evidenceSnapshot.ts';

let count = 0; async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const f = await localOps();
const students = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x, i) => ({ seat_id: 'A' + (i + 1), student_id: 'student-' + x }));
const put = (cred, batch, rev, name, body) => f.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${batch}/${rev}/${name}`, { method: 'PUT', headers: { authorization: 'Bearer ' + cred }, body }), f.env, { waitUntil() {} }).then((r) => r.status);
const consent = { purpose: 'class_report', notice_version: 'notice-v1' };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hps-ops-spool-seq-'));
const spoolFor = (conn, dir = path.join(root, conn.seat_id)) => { const s = new SessionSpool({ root: dir, appVersion: '0.1.56-test', os: { platform: 'darwin', release: '25.5.0', arch: 'arm64' } }); s.noteIdentity(conn.student); return s; };
const work = (spool, n, tag = 'e') => { for (let i = 0; i < n; i++) spool.recordWorkflow({ event: tag + i, payload: { step_id: 'build' } }); return spool.flush(); };
const scopeOf = (conn) => ({ grant_id: conn.grant_id, class_run_id: conn.class_run_id, seat_id: conn.seat_id, student: conn.student, activity: conn.lesson ? { course_id: conn.lesson.course_id, version: conn.lesson.version } : null, run: conn.run });
/** Exactly the device path: read under the spool queue → freeze → PUT the frozen bytes → seal with the frozen binding. */
async function collect(conn, spool, batch, revision = 1, mutate) {
  const live = await spool.readForSnapshot(conn.run.starts_at - WINDOW_LEAD_MS); assert.ok(live, 'the spool has a session');
  if (mutate) mutate(live);
  const frozen = freezeSnapshot(live.files, scopeOf(conn), batch, consent, Date.now(), live); assert.ok(frozen.ok, frozen.code);
  const sha = async (d) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', d))].map((x) => x.toString(16).padStart(2, '0')).join('');
  for (const file of frozen.files) assert.equal(await put(conn.credential, batch, revision, file.name, file.data), 201);
  const sealed = await f.request(`/v1/classroom/ops/collect/snapshots/${batch}/${revision}/seal`, 'POST', { schema: 'hps-classroom-snapshot/2', files: await Promise.all(frozen.files.map(async (x) => ({ name: x.name, bytes: x.data.byteLength, sha256: await sha(x.data) }))), binding: frozen.binding }, conn.credential);
  assert.equal(sealed.status, 201, sealed.raw); assert.equal(sealed.json.integrity, 'verified');
  return { coverage: sealed.json.coverage, reason: sealed.json.coverage_reason ?? '', range: frozen.binding.range };
}
try {
  await setRoster(f.env.HPS_KV, f.cohort, students.map((x) => x.student_id)); // seven seats: one per way a record can be short of complete
  await f.freeze(); assert.equal((await f.configure(students, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true } })).status, 201);
  const conns = []; for (let i = 0; i < students.length; i++) { const c = (await f.pair(students[i].seat_id, 1, i + 1)).conn.json; assert.equal((await f.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, ...consent }, c.credential)).status, 201); conns.push(c); }
  const batch = (await f.request(f.base + '/report-batches', 'POST', { idempotency_key: crypto.randomUUID(), roster_revision: 1, ...consent, dry_run: false })).json.batch.id;
  const [a, b, c, d, e, g, h] = conns;

  await check('positive control: a healthy real session is complete, and a later revision covers the longer extent', async () => {
    const spool = spoolFor(a); await work(spool, 6);
    const first = await collect(a, spool, batch, 1); assert.deepEqual([first.coverage, first.reason, first.range.first_seq, first.range.last_seq, first.range.session_last_seq, first.range.other_sessions_in_window], ['complete', '', 1, 6, 6, 0]);
    await work(spool, 3, 'later'); // the live spool kept growing after the copy: that is the next revision, never a rewrite of the first
    const second = await collect(a, spool, batch, 2); assert.deepEqual([second.coverage, second.range.first_seq, second.range.last_seq], ['complete', 1, 9]);
  });
  await check('a record without seq stays sequence_unavailable — whatever build wrote it', async () => {
    const spool = spoolFor(b); await work(spool, 4);
    const r = await collect(b, spool, batch, 1, (live) => { const ev = live.files.find((x) => x.name === 'events.jsonl'); ev.data = new TextEncoder().encode(new TextDecoder().decode(ev.data).split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); delete o.seq; return JSON.stringify(o); }).join('\n') + '\n'); });
    assert.deepEqual([r.coverage, r.range.first_seq, r.range.session_last_seq], ['sequence_unavailable', undefined, 4]);
  });
  await check('app restart during the class: the new session is contiguous from 1, yet the class record is NOT complete', async () => {
    const dir = path.join(root, 'restart'), before = spoolFor(c, dir); await work(before, 5, 'before');
    const after = spoolFor(c, dir); await work(after, 3, 'after');
    const r = await collect(c, after, batch, 1); assert.deepEqual([r.coverage, r.reason, r.range.first_seq, r.range.last_seq, r.range.other_sessions_in_window], ['range_unknown', 'other_session_not_included', 1, 3, 1]);
  });
  await check('a lost tail: the spool allocated more events than the file holds → gaps, never complete', async () => {
    const spool = spoolFor(d); await work(spool, 5); const file = path.join(spool.currentSessionDir(), 'events.jsonl');
    const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(0, 4).join('\n') + '\n'; fs.writeFileSync(file, kept); // the last line never reached the disk
    const r = await collect(d, spool, batch, 1); assert.deepEqual([r.coverage, r.reason, r.range.last_seq, r.range.session_last_seq], ['gaps', 'tail_missing', 4, 5]);
  });
  await check('a failed append and a torn append: gaps and damaged, the following events intact', async () => {
    const real = fs.promises.appendFile; let mode = 'off';
    fs.promises.appendFile = async (file, data, enc) => { if (mode === 'off' || !String(file).endsWith('events.jsonl')) return real(file, data, enc); const m = mode; mode = 'off'; if (m === 'torn') await real(file, String(data).slice(0, 20), enc); throw Object.assign(new Error('injected'), { code: 'EIO' }); };
    const quiet = console.warn; console.warn = () => {};
    try {
      const lost = spoolFor(e); await work(lost, 2); mode = 'clean'; await work(lost, 1, 'lost'); await work(lost, 2, 'next');
      const r1 = await collect(e, lost, batch, 1); assert.deepEqual([r1.coverage, r1.range.lines, r1.range.session_last_seq], ['gaps', 4, 5]);
      const torn = spoolFor(g); await work(torn, 2); mode = 'torn'; await work(torn, 1, 'torn'); await work(torn, 2, 'next');
      const r2 = await collect(g, torn, batch, 1); assert.equal(r2.coverage, 'damaged'); assert.equal(r2.range.lines, 5, 'two before, the torn fragment on its own line, two intact after');
    } finally { fs.promises.appendFile = real; console.warn = quiet; }
  });
  await check('the session directory vanished mid-class (retention sweep in another window): the start is not provable → range_unknown', async () => {
    const spool = spoolFor(h); await work(spool, 3); fs.rmSync(spool.currentSessionDir(), { recursive: true, force: true }); await work(spool, 2, 'after');
    const r = await collect(h, spool, batch, 1); assert.deepEqual([r.coverage, r.range.first_seq, r.range.lines], ['range_unknown', undefined, 2]);
  });
  await check('the instructor summary counts only the one truly complete record', async () => {
    const v = (await f.request(f.base + '/report-batches/' + batch)).json; assert.equal(v.summary.verified, 7); assert.equal(v.summary.verified_complete_coverage, 1);
    assert.deepEqual(v.items.map((i) => i.coverage), ['complete', 'sequence_unavailable', 'range_unknown', 'gaps', 'gaps', 'damaged', 'range_unknown']);
  });
  console.log(`${count} real-spool sequence contract checks passed`);
} finally { f.close(); fs.rmSync(root, { recursive: true, force: true }); }
