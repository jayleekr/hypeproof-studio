// Instructor UI review preview (#751) — a local, SYNTHETIC classroom for looking at the Chalk instructor pages.
//
//   node --experimental-strip-types --experimental-sqlite e2e/classroom/ui-review-preview.mjs   # stays up until Control-C
//
// Serves the real Chalk worker (every instructor page) on http://127.0.0.1:$HPS_UI_PREVIEW_PORT (default 18951, loopback
// only) against the real Service router + in-memory SQLite. 24 synthetic seats in mixed states (normal, confirmed fault,
// shared provider incident, waiting for approval, stale signal, never connected, older app). Connected seats run the REAL
// device client code in-process (ops sync loop, command runner, inbox store on a temp dir), so selections, distributions,
// diagnostics and collections produce real per-target outcomes. One seat's inbox disk refuses writes (a partial failure).
// Help requests (shares) cover open, answered, resolved, withdrawn, expired and earlier-class states — see below.
// Nothing here is a real student, a real Studio window, a real model, mail, Windows, a school network, staging or production.
// The synthetic instructor token (signed with the test secret, valid only against this process) is written to
// e2e/test-results/ui-review-preview/instructor-token.txt — never commit or screenshot it.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOps, OPS_ALL } from '../../worker/test/harness/classroom-ops.mjs';
import * as ops from '../../extensions/hypeproof-chat/src/classroomOps.ts';
import { CommandRunner } from '../../extensions/hypeproof-chat/src/classroomOpsCommands.ts';
import { InboxSession, InboxStore, inboxDir } from '../../extensions/hypeproof-chat/src/classroomInboxStore.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.join(repo, 'e2e/test-results/ui-review-preview'); mkdirSync(out, { recursive: true });
const port = Number(process.env.HPS_UI_PREVIEW_PORT || 18951);
const local = await localOps(), { default: chalk } = await import('../../chalk/src/index.ts'), { setRoster } = await import('../../worker/src/lib/kv.ts');
const { issueIssuer } = await import('../../worker/src/lib/tokens.ts'), { TEST_SECRET } = await import('../../worker/test/harness/index.mjs');
const realFetch = globalThis.fetch; globalThis.fetch = (url, init) => String(url).startsWith('https://service.test') ? local.app.fetch(new Request(url, init), local.env, { waitUntil() {} }) : realFetch(url, init);

const rows = ['A', 'B', 'C', 'D'], seats = rows.flatMap((r, ri) => Array.from({ length: 6 }, (_, i) => ({ seat_id: r + (i + 1), student_id: 'synth-' + String(ri * 6 + i + 1).padStart(2, '0') })));
await setRoster(local.env.HPS_KV, local.cohort, seats.map((s) => s.student_id)); await local.freeze();
const FLAGS = { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true, ops_distribute: true, ops_lesson_settings: true };
const configured = await local.configure(seats, 0, { flags: FLAGS }); if (configured.status !== 201) throw Error('configure: ' + configured.raw);
const teacher = (await issueIssuer({ issuer: 'teacher-a', /* the seats are paired by teacher-a (local.pair); only the assigned instructor receives shares (AT-47) */ scopes: [{ cohort: local.cohort, profiles: [local.profile], ops: [...OPS_ALL, 'distribute', 'lesson_settings'] }] }, 8, TEST_SECRET)).token;
writeFileSync(path.join(out, 'instructor-token.txt'), teacher + '\n', { mode: 0o600 });

const CAPS = ['observe', 'observe_step', 'observe_runtime', 'observe_evidence', 'commands', 'retry_diagnostics', 'reset_runtime', 'send_question', 'retry_evidence_upload', 'distribution_inbox'];
const RECORD = [JSON.stringify({ seq: 1, type: 'prompt', turn_id: 't1', text: '[합성 시험 기록]' }), JSON.stringify({ seq: 2, type: 'turn_end', turn_id: 't1', status: 'ok' })].join('\n') + '\n';
const OLD_APP = ['observe', 'commands', 'retry_diagnostics'];
// seat → what the synthetic device reports. `live:false` pairs once and then goes silent; `pair:false` never connects.
const plan = {
  A1: { step: ['intro', 'in_progress'], run: 'running', consent: true }, A2: { step: ['build', 'in_progress'], run: 'idle', consent: true }, A3: { step: ['build', 'in_progress'], run: 'running', diskFault: true },
  A4: { step: ['build', 'in_progress'], run: 'idle', caps: OLD_APP }, A5: { step: ['intro', 'in_progress'], run: 'idle' }, A6: { step: ['build', 'in_progress'], run: 'running' },
  B1: { step: ['build', 'in_progress'], run: 'idle' }, B2: { step: ['intro', 'in_progress'], run: 'running' }, B3: { step: ['build', 'in_progress'], run: 'waiting_user' }, B4: { step: ['build', 'in_progress'], run: 'idle' },
  B5: { step: ['build', 'in_progress'], run: 'waiting_approval' }, B6: { step: ['review', 'submitted'], run: 'idle', consent: true, evidence: true },
  C1: { error: { class: 'auth_signature', code: 'http_401', request_id: 'req-synth-0001', blocking: true }, stage: 'token_rejected' },
  C2: { step: ['build', 'in_progress'], error: { class: 'sdk_not_ready', code: 'sdk_missing', request_id: 'req-synth-0002', blocking: true } },
  C3: { step: ['build', 'in_progress'], error: { class: 'provider_5xx', code: 'http_529', request_id: 'req-synth-0003', blocking: true } },
  C4: { step: ['build', 'in_progress'], error: { class: 'provider_5xx', code: 'http_529', request_id: 'req-synth-0004', blocking: true } },
  C5: { step: ['intro', 'in_progress'], error: { class: 'provider_5xx', code: 'http_529', request_id: 'req-synth-0005', blocking: true } },
  C6: { step: ['build', 'in_progress'], run: 'idle', live: false },
  D1: { pairOnly: true }, D2: { pair: false }, D3: { pair: false }, D4: { pair: false }, D5: { pair: false }, D6: { pair: false },
};
const root = mkdtempSync(path.join(tmpdir(), 'hps-ui-preview-')), memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; };
const conn = {}, loops = {}; let n = 0, eid = 0;
for (const s of seats) {
  const p = plan[s.seat_id]; n++; if (p.pair === false) continue;
  const caps = p.caps ?? CAPS;
  if (p.pairOnly) { const r = await local.request(local.base + '/pairings', 'POST', { seat_id: s.seat_id, roster_revision: 1 }); if (r.status !== 201) throw Error('pairing ' + r.raw); continue; }
  const c = (await local.pair(s.seat_id, 1, n, caps)).conn.json; conn[s.seat_id] = c;
  if (p.consent) await local.request('/v1/classroom/ops/collect/consent', 'POST', { consent: true, purpose: 'class_report', notice_version: 'notice-v1' }, c.credential);
  const inst = local.instance(n, caps), events = [];
  events.push(local.event(1, 'activation', { stage: p.stage ?? 'runtime_ready', ...(p.error?.class === 'auth_signature' ? { reason: 'auth_signature', http_status: 401 } : {}) }));
  if (p.step && caps.includes('observe_step')) events.push(local.event(2, 'step', { lesson_version: local.lesson.version, step_id: p.step[0], status: p.step[1] }));
  if (p.run && caps.includes('observe_runtime')) events.push(local.event(3, 'runtime', { status: p.run }));
  if (p.error) events.push(local.event(4, 'error', p.error));
  if (p.evidence) { const h = (ch) => ch.repeat(64); events.push(local.event(5, 'evidence', { evidence_type: 'action', source_state: 'simulated', step_id: 'build' }, { actor: 'ai' }), local.event(6, 'evidence', { evidence_type: 'change', source_state: 'real', artifact_before: h('a'), artifact_after: h('b') }, { actor: 'student' })); }
  const first = await local.sync(c.credential, events, n); if (first.status !== 200) throw Error('sync ' + s.seat_id + ' ' + first.raw);
  if (p.live === false) continue;
  const store = new InboxStore(inboxDir(root, { cohort: c.student.c, run: c.class_run_id, seat: c.seat_id, student: c.student.u }), { fault: (op, file) => { if (p.diskFault && op === 'write' && file.includes(path.sep + 'rev' + path.sep)) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } });
  const inbox = new InboxSession({ store, alive: () => true, clock: { mono: () => performance.now(), wall: () => Date.now() } });
  let epoch = c.connection_epoch;
  const runner = new CommandRunner({ executors: { retry_diagnostics: { mutating: false, run: async () => (p.error ? { ok: false, code: p.error.class === 'auth_signature' ? 'token_rejected' : 'runtime_not_ready' } : { ok: true, code: 'token_ok' }) }, send_question: { mutating: false, acceptsArgs: (a) => Object.keys(a).join() === 'text', run: async () => ({ ok: true, code: 'shown' }) },
    // Collection: A1 seals a real (synthetic) snapshot; any other consenting seat has recorded nothing yet — the App's own code for that.
    retry_evidence_upload: { mutating: false, acceptsArgs: (a) => typeof a.batch_id === 'string', run: async (_s, cmd) => { if (s.seat_id !== 'A1') return { ok: false, code: 'nothing_recorded' }; const r = await local.uploadSnapshotAs(c, String(cmd.args.batch_id), 1, RECORD); return r.status === 201 ? { ok: true, code: 'receipt_verified' } : { ok: false, code: 'metadata_invalid' }; } } }, journal: memory(), monotonic: () => performance.now(), now: () => Date.now(), epoch: () => epoch });
  await runner.recover();
  const outbox = await ops.OpsOutbox.open(memory(), c.grant_id, 'stream-' + s.seat_id, () => Date.now(), () => `event-ui-${String(++eid).padStart(6, '0')}`);
  loops[s.seat_id] = ops.startOpsSync({ outbox, appInstanceId: inst.app_instance_id, capabilities: caps, commands: runner, ...(caps.includes('distribution_inbox') ? { distribution: inbox } : {}), sample: () => ({ idle_ms: 1 }), onControl() {}, onEpoch: (e) => { epoch = e; }, now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {},
    post: async (body) => { const r = await local.request('/v1/classroom/ops/sync', 'POST', { ...body, boot_id: inst.boot_id }, c.credential); return { status: r.status, body: r.json }; } });
}
// C6 went quiet a while ago: an old signal is "확인 불가", not red.
local.db.prepare("UPDATE ops_latest_state SET last_received_at=? WHERE seat_id='C6'").run(Date.now() - 25 * 60000);
// Voluntary shares addressed to this instructor, in every state the help queue must tell apart (UI pass 2):
//   open now: B2 synth-08 (a working seat), C2 synth-14 (also a confirmed fault), C6 synth-18 (quiet — asked, then went silent);
//   not open: A5 synth-05 answered and waiting for the learner, A6 synth-06 resolved by the learner, B1 synth-07 withdrawn,
//   B3 synth-09 expired, B4 synth-10 asked in an earlier class; B6 synth-12 is a submission, not a help request.
const share = async (sid, kind, content) => { const t = await local.student(sid), id = crypto.randomUUID(); const r = await local.request('/v1/classroom/shares', 'POST', { id, recipient_id: 'teacher-a', kind, consent: true, duration_minutes: 480, content }, t); if (r.status !== 201 && r.status !== 200) throw Error('share ' + sid + ': ' + r.status + ' ' + r.raw); return { id, t, revision: r.json.revision }; };
const answer = (s) => local.request(`/admin/cohorts/${local.cohort}/classroom/shares/${s.id}`, 'PUT', { expected_revision: s.revision, status: 'answered', feedback: '[합성] 확인할 지점을 적었습니다.', next_action: '[합성] 390px에서 다시 보기' }, teacher);
const ask = (sid, text) => share(sid, 'help', { prompt: '[합성] ' + text });
await share('synth-08', 'help', { prompt: '[합성] 미리보기에서 버튼이 안 보여요. 어디부터 확인하면 될까요?', verification: '[합성] 390px 화면에서 확인함' });
await ask('synth-14', 'AI가 대답을 안 해요. 제가 뭘 잘못했나요?'); await ask('synth-18', '다음 단계에서 무엇을 확인해야 할지 모르겠어요.');
await share('synth-12', 'submission', { artifact_url: 'https://example.invalid/synthetic-project', verification: '[합성] 기대 조건 3개 중 2개 확인' });
{ const s = await ask('synth-05', '제출 전에 확인할 것이 있나요?'); if ((await answer(s)).status !== 200) throw Error('answer synth-05'); }
{ const s = await ask('synth-06', '색이 이상해요.'), a = await answer(s); const c = await local.request(`/v1/classroom/shares/${s.id}/confirm`, 'POST', { expected_revision: a.json.revision }, s.t); if (c.status !== 200) throw Error('confirm synth-06 ' + c.raw); }
{ const s = await ask('synth-07', '[철회 예정]'); if ((await local.request('/v1/classroom/shares/' + s.id, 'DELETE', undefined, s.t)).status !== 200) throw Error('withdraw synth-07'); }
{ const s = await ask('synth-09', '[만료된 요청]'); local.db.prepare('UPDATE classroom_shares SET expires_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 60, s.id); }
{ const s = await ask('synth-10', '[지난 수업의 요청]'); local.db.prepare("UPDATE classroom_shares SET session_id='synthetic-earlier-class' WHERE id=?").run(s.id); }
const pump = setInterval(async () => {
  local.db.prepare('UPDATE classroom_distribution_targets SET next_offer_at=0').run(); local.db.prepare('UPDATE classroom_distribution_cards SET next_withdraw_at=0').run();
  for (const l of Object.values(loops)) void l.tick();
}, 1000);

const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await chalk.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), { ...local.env, HPS_SERVICE_ORIGIN: 'https://service.test' }, {}); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch (e) { res.writeHead(500); res.end(String(e)); } });
server.listen(port, '127.0.0.1'); await once(server, 'listening');
const info = { url: `http://127.0.0.1:${port}/manage`, cohort: local.cohort, seat_prefix: 'synth-', seats: seats.length, token_file: path.join(out, 'instructor-token.txt'), pid: process.pid, synthetic: true };
writeFileSync(path.join(out, 'preview.json'), JSON.stringify(info, null, 2) + '\n');
console.log('UI review preview (synthetic) ready: ' + JSON.stringify(info));
const stop = () => { clearInterval(pump); for (const l of Object.values(loops)) l.stop(); server.close(); local.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
