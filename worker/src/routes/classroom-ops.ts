// Remote classroom operations (#751, R1): run roster snapshot, pairing,
// operations connection, observation sync and the instructor status read.
//
// Boundaries (docs/requirements/classroom-admin.md, 2026-09-18 section):
//  - The Service owns every write. Chalk only forwards.
//  - Authority is read from the D1 primary on every request: grant state,
//    seat binding, epoch and the per-run flag. KV liveness is not consulted.
//  - Nothing here reads session logs, prompts or files, and no response
//    carries a student token or a pairing ticket after the mint response.
//  - A 2xx from /sync means "stored and acked up to `ack.contiguous_seq`".
//    It never means a command ran or that the evidence is complete.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../env';
import { bearer, signOpsCredential, verifyOpsCredential } from '../lib/tokens';
import { authorizeIssuerForOps, type IssuerAuthz } from '../lib/instructor-auth';
import { bumpRateCounter, getActiveSession, getRoster } from '../lib/kv';
import { readLesson } from '../lib/lesson-delivery';
import { readRunControl } from '../lib/classroom-ops-control';
import { scrubSecrets } from '../lib/scrub-secrets';
import { PENDING_PROBE, declaresInbox, deviceRebindStatements, distributionExchange, issuerFenceStatements, type DistributionBlock } from '../lib/classroom-distribution-store';
import {
  ID_RE, MAX_SEATS, MAX_SYNC_BYTES, MAX_SYNC_EVENTS, OPS_FLAGS, OPS_PROTOCOL, OPS_SCHEMA_VERSION, PAIRING_TTL_MS,
  RUNTIME_STATUSES, STALE_AFTER_MS, UUIDISH_RE, attentionOf, canonicalPayload, commonIncidents, contiguousAck, entryStage,
  newPairingTicket, normalizeTicket, parseFlags, parseLesson, pollAfterMs, sha256Hex, shouldApply, signalOf,
  stepDisposition, validateEvent, reduceTokenCheck, tokenCheckOf, type OpsCapability, type SeatState,
  REVIEW_STATES, SERVICE_ISSUED_ACTIONS, COMMAND_ACTIONS, COMMAND_TTL_MS, LEASE_TAKEOVER_MS, REASON_CODES, isTerminal, nextTargetState, summarize, validateReceipt,
} from '../lib/classroom-ops';

type Db = Env['HPS_DB'];
type TeacherEnv = { Bindings: Env; Variables: { teacher: IssuerAuthz } };
type RunRow = { class_run_id: string; cohort_id: string; profile_id: string; flags_json: string; lesson_json: string; roster_revision: number; starts_at: number; ends_at: number; ended_at?: string | null };
type SeatRow = { seat_id: string; seat_revision: number; student_id: string };
type GrantRow = { id: string; kind: string; class_run_id: string; cohort_id: string; profile_id: string; seat_id: string; seat_revision: number; student_id: string; state: string; connection_epoch: number; device_registration_id: string | null; expires_at: number; issuer_id: string; issuer_jti: string | null };

export const opsEnabled = (env: Env) => env.HPS_CLASSROOM_OPS === 'enabled';
const json = async (c: any) => { try { return await c.req.json(); } catch { return null; } };
const audit = (db: Db, run: string, seat: string, actorKind: string, actorId: string, action: string, detail: unknown, at: number) =>
  db.prepare('INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) VALUES(?,?,?,?,?,?,?)').bind(run, seat, actorKind, actorId, action, JSON.stringify(detail), at);

// ── hooks called from routes/admin.ts ───────────────────────────────────────

export async function recordTokenIssue(env: Env, t: { jti: string; cohort: string; student: string; profile: string; issuedBy: string; hours: number }): Promise<{ epoch_advanced: boolean } | null> {
  if (!opsEnabled(env)) return null;
  const at = Date.now();
  // A re-issued learning token is a new login generation for that student:
  // commands addressed to the old epoch must not run afterwards. This is an
  // invariant, so it is written on its own (not inside the best-effort ledger
  // batch) and its failure is REPORTED to the caller. It still must not fail the
  // mint: an operations outage may never block the existing class path (AT-32).
  let epoch_advanced = false;
  for (let attempt = 0; attempt < 2 && !epoch_advanced; attempt++) {
    try {
      await env.HPS_DB.prepare("UPDATE ops_grants SET connection_epoch=connection_epoch+1,revision=revision+1 WHERE kind='connection' AND state='active' AND cohort_id=? AND student_id=?").bind(t.cohort, t.student).run();
      epoch_advanced = true;
    } catch (err) { console.error('ops connection epoch NOT advanced on token re-issue:', err); }
  }
  try {
    // Issuance metadata is best-effort: losing it only degrades the board's "issued" column.
    await env.HPS_DB.prepare('INSERT OR IGNORE INTO ops_token_issues(jti,cohort_id,student_id,profile_id,issued_by,issued_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(t.jti, t.cohort, t.student, t.profile, t.issuedBy, at, at + t.hours * 3_600_000).run();
  } catch (err) {
    console.error('ops token issue ledger unavailable:', err);
  }
  return { epoch_advanced };
}

/** Throws on storage failure: the caller must not report the revocation as complete. */
export async function revokeOpsGrantsForIssuer(env: Env, issuerJti: string, by = 'operator'): Promise<void> {
  if (!opsEnabled(env)) return;
  const now = Date.now(), grants = env.HPS_DB.prepare("UPDATE ops_grants SET state='revoked',revoked_at=?,revoked_reason='issuer_revoked',revision=revision+1 WHERE issuer_jti=? AND state IN ('issued','active')").bind(now, issuerJti);
  // U2: the same transaction records the revocation in D1 (the distribution guards read it, not KV) and closes every open
  // distribution this token created — so it stops reaching learners even when ANOTHER instructor paired their devices.
  try { await env.HPS_DB.batch([grants, ...issuerFenceStatements(env.HPS_DB, issuerJti, { reason: 'issuer_revoked', by, sweep: true, now })]); }
  catch (err) {
    // A database without migration 0023 has no fence table. The pre-existing guarantee (grants closed) must not regress
    // because of that, and the caller is still told the revocation is incomplete.
    await grants.run();
    throw err;
  }
}
/**
 * Issuer re-scope and class close revoke a token in KV only. For distribution that is not a boundary, so the D1 fence is
 * written here. `sweep` = the replaced token's open distributions are closed too (always for a plain revocation; for a
 * re-scope only when the new scope no longer holds `distribute`, so re-issuing a token mid-class does not cancel what is
 * still waiting for offline learners). Throws on storage failure: the caller must not report the fence as written.
 */
export async function fenceIssuerForDistribution(env: Env, issuerJti: string, o: { reason: string; by: string; sweep: boolean; retainedCohorts?: string[] }): Promise<void> {
  if (!opsEnabled(env)) return;
  await env.HPS_DB.batch(issuerFenceStatements(env.HPS_DB, issuerJti, { ...o, now: Date.now() }));
}
export async function liftIssuerFence(env: Env, issuerJti: string): Promise<void> {
  if (!opsEnabled(env)) return;
  const { issuerFenceLiftStatement } = await import('../lib/classroom-distribution-store');
  await issuerFenceLiftStatement(env.HPS_DB, issuerJti, Date.now()).run();
}

// ── instructor surface (/admin/cohorts/:cohort/classroom/runs/…) ────────────

export const classroomOpsTeacher = new Hono<TeacherEnv>();
const root = '/cohorts/:cohort/classroom/runs/:run';
const limit = bodyLimit({ maxSize: MAX_SYNC_BYTES, onError: (c) => c.json({ error: 'request too large' }, 413) });
classroomOpsTeacher.use(root, limit);
classroomOpsTeacher.use(root + '/*', limit);

async function teacher(c: any, capability: OpsCapability): Promise<IssuerAuthz | Response> {
  c.header('cache-control', 'no-store');
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  if (!ID_RE.test(c.req.param('cohort')) || !ID_RE.test(c.req.param('run'))) return c.json({ error: 'invalid cohort or run id' }, 400);
  const auth = await authorizeIssuerForOps(c, c.req.param('cohort'), capability);
  if (auth instanceof Response) return auth;
  if (!auth) return c.json({ error: 'instructor Bearer required' }, 401);
  return auth;
}
async function loadRun(c: any, auth: IssuerAuthz): Promise<RunRow | Response> {
  const run = await c.env.HPS_DB.prepare('SELECT o.*,s.ended_at FROM class_run_ops o LEFT JOIN sessions s ON s.id=o.class_run_id WHERE o.class_run_id=? AND o.cohort_id=?').bind(c.req.param('run'), c.req.param('cohort')).first() as RunRow | null;
  if (!run) return c.json({ error: 'class run not configured', reason: 'run_not_found' }, 404);
  if (!auth.scope.profiles.includes(run.profile_id)) return c.json({ error: 'issuer not scoped to this run profile', reason: 'profile_scope' }, 403);
  return run;
}

// PUT — create or revise the run: flags, pinned lesson and the seat snapshot.
classroomOpsTeacher.put(root, async (c) => {
  const auth = await teacher(c, 'manage'); if (auth instanceof Response) return auth;
  const cohort = c.req.param('cohort')!, runId = c.req.param('run')!, b = await json(c), now = Date.now();
  if (!b || !Number.isInteger(b.expected_roster_revision) || !Array.isArray(b.seats) || b.seats.length > MAX_SEATS) return c.json({ error: `expected_roster_revision and seats[] (≤${MAX_SEATS}) required` }, 400);
  const seats = new Map<string, string>(), students = new Set<string>();
  for (const s of b.seats) {
    if (!s || !ID_RE.test(s.seat_id) || !ID_RE.test(s.student_id) || seats.has(s.seat_id) || students.has(s.student_id)) return c.json({ error: 'each seat needs a unique seat_id and student_id' }, 400);
    seats.set(s.seat_id, s.student_id); students.add(s.student_id);
  }
  const flags: Record<string, boolean> = {};
  if (b.flags !== undefined) {
    if (!b.flags || typeof b.flags !== 'object' || Object.keys(b.flags).some((k) => !(OPS_FLAGS as readonly string[]).includes(k) || typeof b.flags[k] !== 'boolean')) return c.json({ error: `flags must be booleans within [${OPS_FLAGS.join(', ')}]` }, 400);
    Object.assign(flags, b.flags);
  }
  if (b.lesson !== undefined && (!b.lesson || !ID_RE.test(b.lesson.course_id) || typeof b.lesson.version !== 'string' || Object.keys(b.lesson).some((k) => !['course_id', 'version'].includes(k)))) return c.json({ error: 'lesson needs course_id and version only; steps come from the frozen version' }, 400);
  // The run is an existing class session, never a second calendar.
  const active = await getActiveSession(c.env.HPS_KV, cohort);
  const session = active?.session_id === runId ? { profile_id: active.profile_id, starts_at: active.starts_at, ends_at: active.ends_at }
    : await c.env.HPS_DB.prepare('SELECT profile_id,starts_at,ends_at FROM sessions WHERE id=? AND cohort_id=?').bind(runId, cohort).first<{ profile_id: string; starts_at: string; ends_at: string }>();
  if (!session) return c.json({ error: 'no class session with this id in the cohort', reason: 'session_not_found' }, 404);
  if (!auth.scope.profiles.includes(session.profile_id)) return c.json({ error: 'issuer not scoped to this run profile', reason: 'profile_scope' }, 403);
  // Seats come from the cohort roster; a run cannot invent a student.
  const roster = await getRoster(c.env.HPS_KV, cohort);
  const outside = [...students].filter((u) => !roster?.users.includes(u));
  if (outside.length) return c.json({ error: 'students missing from the cohort roster', reason: 'not_in_roster', students: outside.slice(0, 20) }, 409);

  // Step ids are read from the frozen authoring version, never from the request:
  // a board step must be one the confirmed lesson actually defines.
  let lesson: unknown = {};
  if (b.lesson !== undefined) {
    const frozen = await readLesson(c.env, cohort, b.lesson.course_id, b.lesson.version, session.profile_id);
    if (!frozen) return c.json({ error: 'no confirmed lesson version with this id for the run profile', reason: 'lesson_not_found' }, 409);
    lesson = { course_id: frozen.course_id, version: frozen.version, sha256: frozen.sha256, steps: frozen.content.steps.map((x) => x.id) };
  }
  const db = c.env.HPS_DB, prior = await db.prepare('SELECT * FROM class_run_ops WHERE class_run_id=?').bind(runId).first() as RunRow | null;
  if (prior && prior.cohort_id !== cohort) return c.json({ error: 'run belongs to another cohort' }, 409);
  if ((prior?.roster_revision ?? 0) !== b.expected_roster_revision) return c.json({ error: 'roster changed; reload before saving', reason: 'revision_conflict', roster_revision: prior?.roster_revision ?? 0 }, 409);
  const current = ((await db.prepare('SELECT seat_id,seat_revision,student_id FROM class_run_seats WHERE class_run_id=? AND replaced_at IS NULL').bind(runId).all()).results ?? []) as SeatRow[];
  const next = b.expected_roster_revision + 1, writer = crypto.randomUUID(), who = auth.payload.u;
  const mergedFlags = { ...parseFlags(prior?.flags_json), ...flags };
  const lessonJson = b.lesson === undefined ? (prior?.lesson_json ?? '{}') : JSON.stringify(lesson);
  // Every later statement is conditional on this writer winning the CAS:
  // D1 batches are atomic but a zero-row UPDATE does not abort them.
  const won = '(SELECT roster_writer FROM class_run_ops WHERE class_run_id=?)=?';
  const stmts = [prior
    ? db.prepare('UPDATE class_run_ops SET roster_revision=?,roster_writer=?,flags_json=?,lesson_json=?,profile_id=?,starts_at=?,ends_at=?,updated_at=? WHERE class_run_id=? AND roster_revision=?').bind(next, writer, JSON.stringify(mergedFlags), lessonJson, session.profile_id, Date.parse(session.starts_at), Date.parse(session.ends_at), now, runId, b.expected_roster_revision)
    : db.prepare('INSERT INTO class_run_ops(class_run_id,cohort_id,profile_id,flags_json,lesson_json,roster_revision,roster_writer,starts_at,ends_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(class_run_id) DO NOTHING').bind(runId, cohort, session.profile_id, JSON.stringify(mergedFlags), lessonJson, next, writer, Date.parse(session.starts_at), Date.parse(session.ends_at), who, now, now)];
  const changes: Array<{ seat_id: string; from?: string; to?: string }> = [];
  for (const old of current) {
    const to = seats.get(old.seat_id);
    if (to === old.student_id) continue;
    changes.push({ seat_id: old.seat_id, from: old.student_id, to });
    stmts.push(db.prepare(`UPDATE class_run_seats SET replaced_at=?,replaced_reason=? WHERE class_run_id=? AND seat_id=? AND seat_revision=? AND ${won}`).bind(now, to ? 'student_changed' : 'seat_removed', runId, old.seat_id, old.seat_revision, runId, writer));
    // The previous student's grants, pending tickets and board state never pass to the next one.
    stmts.push(db.prepare(`UPDATE ops_grants SET state='revoked',revoked_at=?,revoked_reason='seat_replaced',revision=revision+1 WHERE class_run_id=? AND seat_id=? AND seat_revision=? AND state IN ('issued','active') AND ${won}`).bind(now, runId, old.seat_id, old.seat_revision, runId, writer));
  }
  for (const [seatId, student] of seats) {
    const old = current.find((x) => x.seat_id === seatId);
    if (old?.student_id === student) continue;
    if (!old) changes.push({ seat_id: seatId, to: student });
    stmts.push(db.prepare(`INSERT INTO class_run_seats(class_run_id,seat_id,seat_revision,student_id,roster_revision,changed_by,created_at) SELECT ?,?,COALESCE((SELECT MAX(seat_revision) FROM class_run_seats WHERE class_run_id=? AND seat_id=?),0)+1,?,?,?,? WHERE ${won}`).bind(runId, seatId, runId, seatId, student, next, who, now, runId, writer));
  }
  stmts.push(db.prepare(`INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) SELECT ?,'','instructor',?,'run_configured',?,? WHERE ${won}`).bind(runId, who, JSON.stringify({ roster_revision: next, flags: mergedFlags, changes: changes.slice(0, 50) }), now, runId, writer));
  try { await db.batch(stmts); } catch (err) { console.error('ops run configure failed:', err); return c.json({ error: 'run not saved; nothing was applied', reason: 'storage' }, 503); }
  const saved = await db.prepare('SELECT roster_revision,roster_writer FROM class_run_ops WHERE class_run_id=?').bind(runId).first<{ roster_revision: number; roster_writer: string }>();
  if (saved?.roster_writer !== writer) return c.json({ error: 'roster changed; reload before saving', reason: 'revision_conflict', roster_revision: saved?.roster_revision ?? 0 }, 409);
  return c.json({ class_run_id: runId, roster_revision: next, flags: mergedFlags, seats: seats.size, changes }, prior ? 200 : 201);
});

// POST pairings — one single-use ticket for one seat at the current roster revision.
classroomOpsTeacher.post(root + '/pairings', async (c) => {
  const auth = await teacher(c, 'manage'); if (auth instanceof Response) return auth;
  const run = await loadRun(c, auth); if (run instanceof Response) return run;
  if (!parseFlags(run.flags_json).ops_observe) return c.json({ error: 'observation is off for this run', reason: 'ops_observe_disabled' }, 403);
  const b = await json(c), now = Date.now();
  if (!b || !ID_RE.test(b.seat_id) || !Number.isInteger(b.roster_revision)) return c.json({ error: 'seat_id and roster_revision required' }, 400);
  if (b.roster_revision !== run.roster_revision) return c.json({ error: 'roster changed; reload before pairing', reason: 'revision_conflict', roster_revision: run.roster_revision }, 409);
  const seat = await c.env.HPS_DB.prepare('SELECT seat_id,seat_revision,student_id FROM class_run_seats WHERE class_run_id=? AND seat_id=? AND replaced_at IS NULL').bind(run.class_run_id, b.seat_id).first<SeatRow>();
  if (!seat) return c.json({ error: 'seat is not in this run', reason: 'seat_not_found' }, 404);
  const open = await c.env.HPS_DB.prepare("SELECT count(*) AS n FROM ops_grants WHERE class_run_id=? AND kind='pairing' AND state='issued' AND expires_at>?").bind(run.class_run_id, now).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_SEATS * 2) return c.json({ error: 'too many open pairing tickets' }, 429);
  const ticket = newPairingTicket(), id = crypto.randomUUID(), expires = now + PAIRING_TTL_MS;
  await c.env.HPS_DB.batch([
    // A new ticket supersedes the seat's unused ones: one paper slip per seat is live at a time.
    c.env.HPS_DB.prepare("UPDATE ops_grants SET state='revoked',revoked_at=?,revoked_reason='superseded',revision=revision+1 WHERE class_run_id=? AND seat_id=? AND kind='pairing' AND state='issued'").bind(now, run.class_run_id, seat.seat_id),
    c.env.HPS_DB.prepare("INSERT INTO ops_grants(id,kind,class_run_id,cohort_id,profile_id,seat_id,seat_revision,student_id,secret_hash,state,issuer_id,issuer_jti,created_at,expires_at) VALUES(?,'pairing',?,?,?,?,?,?,?,'issued',?,?,?,?)").bind(id, run.class_run_id, run.cohort_id, run.profile_id, seat.seat_id, seat.seat_revision, seat.student_id, await sha256Hex(normalizeTicket(ticket)), auth.payload.u, auth.payload.jti ?? null, now, expires),
    audit(c.env.HPS_DB, run.class_run_id, seat.seat_id, 'instructor', auth.payload.u, 'pairing_issued', { grant_id: id, expires_at: expires }, now),
  ]);
  return c.json({ pairing_id: id, seat_id: seat.seat_id, ticket, expires_at: expires, single_use: true }, 201);
});

classroomOpsTeacher.delete(root + '/grants/:grant', async (c) => {
  const auth = await teacher(c, 'manage'); if (auth instanceof Response) return auth;
  const run = await loadRun(c, auth); if (run instanceof Response) return run;
  const now = Date.now();
  const r = await c.env.HPS_DB.prepare("UPDATE ops_grants SET state='revoked',revoked_at=?,revoked_reason='instructor_revoked',revision=revision+1 WHERE id=? AND class_run_id=? AND state IN ('issued','active') RETURNING id,seat_id").bind(now, c.req.param('grant'), run.class_run_id).first<{ id: string; seat_id: string }>();
  if (!r) return c.json({ error: 'grant not found or already closed' }, 404);
  await audit(c.env.HPS_DB, run.class_run_id, r.seat_id, 'instructor', auth.payload.u, 'grant_revoked', { grant_id: r.id }, now).run();
  return c.json({ revoked: true, grant_id: r.id });
});

// GET status — the whole run roster in one read, silent seats included.
classroomOpsTeacher.get(root + '/status', async (c) => {
  const auth = await teacher(c, 'observe'); if (auth instanceof Response) return auth;
  const run = await loadRun(c, auth); if (run instanceof Response) return run;
  const now = Date.now(), db = c.env.HPS_DB;
  await settleOverdueRun(db, run.class_run_id, now);
  const rows = ((await db.prepare(`SELECT s.seat_id,s.seat_revision,s.student_id,l.state_json,l.revision AS state_revision,l.last_received_at,
 (SELECT count(*) FROM ops_grants p WHERE p.class_run_id=s.class_run_id AND p.seat_id=s.seat_id AND p.seat_revision=s.seat_revision AND p.kind='pairing' AND p.state='issued' AND p.expires_at>?) AS pairing_open,
 (SELECT g.id||'|'||g.state||'|'||g.connection_epoch||'|'||g.expires_at FROM ops_grants g WHERE g.class_run_id=s.class_run_id AND g.seat_id=s.seat_id AND g.seat_revision=s.seat_revision AND g.kind='connection' ORDER BY g.created_at DESC LIMIT 1) AS conn,
 (SELECT t.jti||'|'||t.expires_at FROM ops_token_issues t WHERE t.cohort_id=? AND t.student_id=s.student_id AND t.profile_id=? AND t.expires_at>? ORDER BY t.issued_at DESC LIMIT 1) AS token,
 (SELECT c.action||'|'||ct.state||'|'||ct.result_code||'|'||ct.updated_at||'|'||ct.command_id FROM ops_command_targets ct JOIN ops_commands c ON c.id=ct.command_id WHERE ct.class_run_id=s.class_run_id AND ct.seat_id=s.seat_id AND ct.seat_revision=s.seat_revision ORDER BY ct.updated_at DESC LIMIT 1) AS last_command,
 (SELECT d.capabilities_json FROM ops_device_connections d JOIN ops_grants g3 ON g3.id=d.grant_id WHERE g3.class_run_id=s.class_run_id AND g3.seat_id=s.seat_id AND g3.seat_revision=s.seat_revision AND g3.kind='connection' AND g3.state='active' ORDER BY d.last_seen_at DESC LIMIT 1) AS device_caps
 FROM class_run_seats s LEFT JOIN ops_latest_state l ON l.class_run_id=s.class_run_id AND l.seat_id=s.seat_id AND l.seat_revision=s.seat_revision
 WHERE s.class_run_id=? AND s.replaced_at IS NULL ORDER BY s.seat_id`).bind(now, run.cohort_id, run.profile_id, now, run.class_run_id).all()).results ?? []) as Array<SeatRow & { state_json: string | null; state_revision: number | null; last_received_at: number | null; pairing_open: number; conn: string | null; token: string | null; last_command: string | null; device_caps: string | null }>;
  const control = await readRunControl(c.env, run.class_run_id) ?? { paused: false, control_revision: 0 };
  const seats = rows.map((r) => {
    let state: SeatState = {}; try { state = JSON.parse(r.state_json ?? '{}'); } catch { state = {}; }
    const [grantId, connState, epoch, connExpires] = (r.conn ?? '|||').split('|');
    const connected = connState === 'active' && Number(connExpires) > now;
    const [issueId, tokenExpires] = (r.token ?? '|').split('|');
    const inputs = { pairing_issued: r.pairing_open > 0, connected, token_issued: !!issueId, state, last_received_at: connected ? r.last_received_at : null, grant_revoked: connState === 'revoked' };
    const { attention, reason } = attentionOf(inputs, now);
    const slot = (k: keyof SeatState) => state[k] ? { ...state[k]!.value, observed_at: state[k]!.observed_at, received_at: state[k]!.received_at, actor: state[k]!.actor } : null;
    return {
      seat_id: r.seat_id, seat_revision: r.seat_revision, student_id: r.student_id,
      entry_stage: entryStage(inputs), signal: signalOf(inputs.last_received_at, now), last_received_at: r.last_received_at,
      attention, reason, state_revision: r.state_revision ?? 0,
      control_applied: !connected || signalOf(inputs.last_received_at, now) !== 'fresh' || state.sample?.value.control_revision === undefined ? 'unknown' : state.sample.value.control_revision === control.control_revision ? 'applied' : 'pending',
      connection: grantId ? { grant_id: grantId, state: connected ? 'active' : connState === 'active' ? 'expired' : connState, epoch: Number(epoch) } : null,
      token: issueId ? { issue_id: issueId, expires_at: Number(tokenExpires), app_verified: tokenCheckOf(state, issueId, grantId ?? '') } : null,
      // The latest instructor action on this seat, in ledger terms: queued is not done.
      last_command: r.last_command ? (([action, state, result_code, updated_at, command_id]) => ({ action, state, result_code, updated_at: Number(updated_at), command_id }))(r.last_command.split('|')) : null,
      // Review F4: which signals this device's build can report from its real runtime path. An absent signal from a
      // build that cannot report it is "unknown", not "nothing happened". A build that predates the declaration says nothing.
      observes: ((): { step: boolean | null; runtime: boolean | null; evidence: boolean | null } => { let caps: string[] | null = null; try { caps = r.device_caps ? JSON.parse(r.device_caps) : null; } catch { caps = null; } const has = (k: string) => (!connected || !caps ? null : caps.includes(k)); return { step: has('observe_step'), runtime: has('observe_runtime'), evidence: has('observe_evidence') }; })(),
      distribution_inbox: ((): 'declared' | 'not_declared' | 'unknown' => { if (!connected || !r.device_caps) return 'unknown'; try { return declaresInbox(JSON.parse(r.device_caps)) ? 'declared' : 'not_declared'; } catch { return 'unknown'; } })(),
      step_seq: state.step?.seq, activation: slot('activation'), step: slot('step'), runtime: slot('runtime'), error: slot('error'), upload: slot('upload'), sample: slot('sample'),
    };
  });
  // Evidence the instructor may want to look at — provenance and review state only, never the learner's words.
  const evidenceRows = ((await db.prepare(`SELECT e.seat_id,e.grant_id,e.boot_id,e.seq,e.actor,e.payload_json,e.observed_at,COALESCE(r.state,'unreviewed') AS review_state,COALESCE(r.revision,0) AS review_revision
 FROM ops_events e JOIN ops_grants g ON g.id=e.grant_id JOIN class_run_seats s ON s.class_run_id=g.class_run_id AND s.seat_id=g.seat_id AND s.seat_revision=g.seat_revision AND s.replaced_at IS NULL
 LEFT JOIN ops_event_reviews r ON r.grant_id=e.grant_id AND r.boot_id=e.boot_id AND r.seq=e.seq
 WHERE e.class_run_id=? AND e.kind='evidence' AND e.disposition='applied' ORDER BY e.received_at DESC LIMIT 1000`).bind(run.class_run_id).all()).results ?? []) as Array<{ seat_id: string; grant_id: string; boot_id: string; seq: number; actor: string; payload_json: string; observed_at: number; review_state: string; review_revision: number }>;
  const stepRows = ((await db.prepare(`SELECT e.seat_id,e.grant_id,e.boot_id,e.seq,e.payload_json,COALESCE(r.state,'unreviewed') AS review_state,COALESCE(r.revision,0) AS review_revision,COALESCE(r.reviewer_id,'') AS reviewer_id
 FROM ops_events e JOIN ops_grants g ON g.id=e.grant_id JOIN class_run_seats s ON s.class_run_id=g.class_run_id AND s.seat_id=g.seat_id AND s.seat_revision=g.seat_revision AND s.replaced_at IS NULL
 LEFT JOIN ops_event_reviews r ON r.grant_id=e.grant_id AND r.boot_id=e.boot_id AND r.seq=e.seq
 WHERE e.class_run_id=? AND e.kind='step' AND e.disposition='applied' ORDER BY e.received_at DESC,e.seq DESC LIMIT 2000`).bind(run.class_run_id).all()).results ?? []) as Array<{ seat_id: string; grant_id: string; boot_id: string; seq: number; payload_json: string; review_state: string; review_revision: number; reviewer_id: string }>;
  for (const seat of seats) {
    // The review belongs to the exact event the board is showing: same seat, same seq, same step. A later step starts unreviewed.
    const st = seat.step as (Record<string, unknown> & { step_id?: string; status?: string }) | null, shown = (seat as unknown as { step_seq?: number }).step_seq;
    if (st && st.status === 'submitted') { const row = stepRows.find((e) => { if (e.seat_id !== seat.seat_id || e.seq !== shown) return false; try { const p = JSON.parse(e.payload_json); return p.step_id === st.step_id && p.status === 'submitted'; } catch { return false; } }); if (row) (seat.step as Record<string, unknown>).review = { ref: `${row.grant_id}.${row.boot_id}.${row.seq}`, state: row.review_state, revision: row.review_revision, reviewed_by: row.reviewer_id || null }; }
    delete (seat as unknown as { step_seq?: number }).step_seq;
  }
  for (const seat of seats) {
    const mine = evidenceRows.filter((e) => e.seat_id === seat.seat_id).map((e) => { let p: Record<string, unknown> = {}; try { p = JSON.parse(e.payload_json); } catch { p = {}; } return { ref: `${e.grant_id}.${e.boot_id}.${e.seq}`, evidence_type: p.evidence_type, source_state: p.source_state ?? 'unverified', step_id: p.step_id ?? null, actor: e.actor, changed: typeof p.artifact_before === 'string' && typeof p.artifact_after === 'string' ? p.artifact_before !== p.artifact_after : null, observed_at: e.observed_at, review_state: e.review_state, review_revision: e.review_revision }; });
    const by: Record<string, number> = {}; for (const e of mine) by[String(e.source_state)] = (by[String(e.source_state)] ?? 0) + 1;
    // Zero is "not seen yet", and the UI says so. It is never a score.
    (seat as Record<string, unknown>).evidence = { observed: mine.length, unreviewed: mine.filter((e) => e.review_state === 'unreviewed').length, by_source_state: by, latest: mine.slice(0, 5) };
  }
  const history = (await db.prepare('SELECT seat_id,seat_revision,student_id,replaced_at,replaced_reason,changed_by FROM class_run_seats WHERE class_run_id=? AND replaced_at IS NOT NULL ORDER BY replaced_at DESC LIMIT 100').bind(run.class_run_id).all()).results ?? [];
  const count = (f: (s: (typeof seats)[number]) => boolean) => seats.filter(f).length;
  return c.json({
    schema_version: OPS_SCHEMA_VERSION, now, stale_after_ms: STALE_AFTER_MS, viewer: auth.payload.u,
    actions: Object.entries(COMMAND_ACTIONS).map(([action, a]) => ({ action, kind: a.kind, capability: a.capability, mutating: a.mutating, enabled: parseFlags(run.flags_json)[a.flag], held: (auth.scope.ops ?? []).includes(a.capability) })),
    // Collection is not a command: an instructor may hold `collect` without `command`, and the board has to know that to offer the selection.
    collection: { enabled: parseFlags(run.flags_json).ops_collect, held: (auth.scope.ops ?? []).includes('collect') },
    // Distribution (U2) is neither a command nor a collection: its own switch, its own authority. `link_hosts_configured` tells the
    // author up front whether a material may carry links at all.
    distribution: { enabled: parseFlags(run.flags_json).ops_distribute, held: (auth.scope.ops ?? []).includes('distribute'), link_hosts_configured: !!(c.env.HPS_CLASSROOM_LINK_HOSTS ?? '').trim() },
    run: { class_run_id: run.class_run_id, profile_id: run.profile_id, roster_revision: run.roster_revision, flags: parseFlags(run.flags_json), lesson: parseLesson(run.lesson_json), starts_at: run.starts_at, ends_at: run.ends_at, ended: !!run.ended_at },
    // Scope note for the UI: this is the run snapshot, not the cumulative cohort roster.
    roster: { source: 'class_run_seats', total: seats.length },
    counts: { total: seats.length, blocked: count((s) => s.attention === 'blocked'), caution: count((s) => s.attention === 'caution'), unknown: count((s) => s.attention === 'unknown'), not_connected: count((s) => !s.connection || s.connection.state !== 'active'), runtime_ready: count((s) => s.entry_stage === 'runtime_ready') },
    // Server admission is applied the moment `control` is saved. Device-side tool admission is per seat:
    // applied / not yet / unknown (old app or no signal) are different answers.
    control: { ...control, devices: { applied: count((s) => s.control_applied === 'applied'), pending: count((s) => s.control_applied === 'pending'), unknown: count((s) => s.control_applied === 'unknown') } },
    incidents: commonIncidents(seats), seats, seat_history: history,
  });
});

// ── app surface (/v1/classroom/ops/…) ───────────────────────────────────────

export const classroomOpsApp = new Hono<{ Bindings: Env }>();
classroomOpsApp.use('*', limit);
classroomOpsApp.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  return next();
});

const instanceOk = (b: any) => b && UUIDISH_RE.test(b.app_instance_id ?? '') && UUIDISH_RE.test(b.boot_id ?? '');

classroomOpsApp.post('/connect', async (c) => {
  const b = await json(c), now = Date.now();
  if (!instanceOk(b) || typeof b.ticket !== 'string' || b.ticket.length > 64 || !Number.isInteger(b.protocol)) return c.json({ error: 'ticket, app_instance_id, boot_id and protocol required' }, 400);
  const caps = Array.isArray(b.capabilities) && b.capabilities.length <= 32 && b.capabilities.every((x: unknown) => typeof x === 'string' && /^[a-z_]{1,48}$/.test(x)) ? b.capabilities : [];
  const version = typeof b.app_version === 'string' && /^[A-Za-z0-9_.+-]{1,64}$/.test(b.app_version) ? b.app_version : '';
  // Only FAILED attempts spend the budget. A computer lab shares one NAT address,
  // so counting every request would lock out a class that pairs at the same time;
  // a learner succeeds once and costs nothing, a ticket guesser fails every time.
  const rateKey = `opsconnect:${c.req.header('cf-connecting-ip') ?? 'unknown'}`;
  const blocked = await c.env.HPS_KV.get<{ n: number; resetAt: number }>(rateKey, 'json');
  if (blocked && blocked.resetAt > now && blocked.n >= 30) return c.json({ error: 'too many pairing attempts', reason: 'rate_limited' }, 429, { 'retry-after': '60' });
  const invalid = async () => { await bumpRateCounter(c.env.HPS_KV, rateKey, 30, 60, now); return c.json({ error: 'pairing ticket is not valid', reason: 'ticket_invalid' }, 403); };
  const db = c.env.HPS_DB, hash = await sha256Hex(normalizeTicket(b.ticket));
  // Single use under concurrency: only one UPDATE can move issued → used.
  const pairing = await db.prepare("UPDATE ops_grants SET state='used',used_at=?,revision=revision+1 WHERE secret_hash=? AND kind='pairing' AND state='issued' AND expires_at>? RETURNING *").bind(now, hash, now).first<GrantRow>();
  // One answer for unknown, reused, expired and superseded tickets: no oracle.
  if (!pairing) return invalid();
  const run = await db.prepare('SELECT o.*,s.ended_at FROM class_run_ops o LEFT JOIN sessions s ON s.id=o.class_run_id WHERE o.class_run_id=?').bind(pairing.class_run_id).first<RunRow>();
  const seat = await db.prepare('SELECT seat_id FROM class_run_seats WHERE class_run_id=? AND seat_id=? AND seat_revision=? AND replaced_at IS NULL').bind(pairing.class_run_id, pairing.seat_id, pairing.seat_revision).first();
  if (!run || !seat || !parseFlags(run.flags_json).ops_observe) return invalid();
  const id = crypto.randomUUID(), device = crypto.randomUUID(), expires = Math.min(run.ends_at + 3_600_000, now + 12 * 3_600_000);
  await db.batch([
    // A new device for the seat ends the old one: the epoch only moves forward.
    db.prepare("UPDATE ops_grants SET state='revoked',revoked_at=?,revoked_reason='device_replaced',revision=revision+1 WHERE class_run_id=? AND seat_id=? AND kind='connection' AND state='active'").bind(now, run.class_run_id, pairing.seat_id),
    db.prepare("INSERT INTO ops_grants(id,kind,class_run_id,cohort_id,profile_id,seat_id,seat_revision,student_id,state,connection_epoch,device_registration_id,parent_grant_id,issuer_id,issuer_jti,created_at,expires_at) SELECT ?,'connection',?,?,?,?,?,?,'active',COALESCE((SELECT MAX(connection_epoch) FROM ops_grants WHERE class_run_id=? AND seat_id=? AND kind='connection'),0)+1,?,?,?,?,?,?").bind(id, run.class_run_id, run.cohort_id, run.profile_id, pairing.seat_id, pairing.seat_revision, pairing.student_id, run.class_run_id, pairing.seat_id, device, pairing.id, pairing.issuer_id, pairing.issuer_jti, now, expires),
    db.prepare('INSERT INTO ops_device_connections(grant_id,app_instance_id,boot_id,protocol,capabilities_json,app_version,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)').bind(id, b.app_instance_id, b.boot_id, b.protocol, JSON.stringify(caps), version, now, now),
    audit(db, run.class_run_id, pairing.seat_id, 'device', device, 'device_connected', { grant_id: id, protocol: b.protocol, app_version: version }, now),
  ]);
  const grant = await db.prepare('SELECT connection_epoch FROM ops_grants WHERE id=?').bind(id).first<{ connection_epoch: number }>();
  // U2: a new device starts with an empty inbox. Intents that are still valid go to it again; what the old device held is no
  // longer what this learner sees. Isolated on purpose — pairing must succeed even on a database without migration 0023,
  // and the instructor's result view derives "not on this device" on its own if this did not run.
  try { await db.batch(deviceRebindStatements(db, { class_run_id: run.class_run_id, seat_id: pairing.seat_id, seat_revision: pairing.seat_revision, student_id: pairing.student_id }, device, now)); }
  catch (err) { console.error('distribution rebind skipped:', err); }
  return c.json({
    credential: await signOpsCredential(id, c.env.HPS_SIGNING_SECRET), grant_id: id, device_registration_id: device,
    class_run_id: run.class_run_id, seat_id: pairing.seat_id, connection_epoch: grant?.connection_epoch ?? 1, expires_at: expires,
    protocol: OPS_PROTOCOL, server_capabilities: ['observe'], lesson: parseLesson(run.lesson_json),
    // What a collected snapshot must be bound to (review F1). The app copies these, it never invents them.
    student: { u: pairing.student_id, c: pairing.cohort_id, p: pairing.profile_id }, run: { starts_at: run.starts_at, ends_at: run.ends_at },
    poll_after_ms: pollAfterMs({ starts_at: run.starts_at, ends_at: run.ends_at, ended: !!run.ended_at }, now),
    // What this credential is for — shown to the student by the app.
    allows: ['status_report', 'own_command_receipts'], denies: ['ai_requests', 'log_bodies', 'other_seats'],
  }, 201);
});

classroomOpsApp.post('/sync', async (c) => {
  const credential = bearer(c.req.header('authorization'));
  const grantId = credential ? await verifyOpsCredential(credential, c.env.HPS_SIGNING_SECRET) : null;
  if (!grantId) return c.json({ error: 'operations credential required', reason: 'ops_credential_invalid' }, 401);
  const db = c.env.HPS_DB, now = Date.now();
  const g = await db.prepare(`SELECT g.*,o.flags_json,o.lesson_json,o.starts_at AS run_starts,o.ends_at AS run_ends,s.ended_at AS run_ended,
 (SELECT 1 FROM class_run_seats x WHERE x.class_run_id=g.class_run_id AND x.seat_id=g.seat_id AND x.seat_revision=g.seat_revision AND x.replaced_at IS NULL) AS seat_live
 FROM ops_grants g JOIN class_run_ops o ON o.class_run_id=g.class_run_id LEFT JOIN sessions s ON s.id=g.class_run_id WHERE g.id=? AND g.kind='connection'`).bind(grantId).first<GrantRow & { flags_json: string; lesson_json: string; run_starts: number; run_ends: number; run_ended: string | null; seat_live: number | null }>();
  if (!g) return c.json({ error: 'operations credential required', reason: 'ops_credential_invalid' }, 401);
  if (g.state !== 'active') return c.json({ error: 'operations connection was closed', reason: 'ops_grant_revoked' }, 401);
  if (g.expires_at <= now) return c.json({ error: 'operations connection expired', reason: 'ops_grant_expired' }, 401);
  if (!g.seat_live) return c.json({ error: 'seat was reassigned', reason: 'seat_replaced' }, 403);
  const poll = pollAfterMs({ starts_at: g.run_starts, ends_at: g.run_ends, ended: !!g.run_ended }, now);
  if (!parseFlags(g.flags_json).ops_observe) return c.json({ error: 'observation is off for this run', reason: 'ops_observe_disabled', poll_after_ms: 60000 }, 403);

  const b = await json(c);
  if (!instanceOk(b) || b.schema_version !== OPS_SCHEMA_VERSION) return c.json({ error: 'schema_version, app_instance_id and boot_id required', reason: 'schema' }, 400);
  const raw: unknown[] = b.events === undefined ? [] : b.events;
  if (!Array.isArray(raw) || raw.length > MAX_SYNC_EVENTS) return c.json({ error: `events[] ≤ ${MAX_SYNC_EVENTS}`, reason: 'batch_limit' }, 400);
  const seqs: number[] = [];
  for (const e of raw) { const s = (e as any)?.seq; if (!Number.isSafeInteger(s) || s < 1 || seqs.includes(s)) return c.json({ error: 'each event needs a unique positive seq', reason: 'schema' }, 400); seqs.push(s); }
  if (seqs.length && Math.max(...seqs) - Math.min(...seqs) >= 1000) return c.json({ error: 'seq range too wide for one batch', reason: 'batch_limit' }, 400);
  let sample: Record<string, unknown> | null = null;
  if (b.sample !== undefined) {
    const s = b.sample;
    if (!s || typeof s !== 'object' || Object.keys(s).some((k) => !['idle_ms', 'runtime_status', 'observed_at', 'control_revision'].includes(k)) || (s.control_revision !== undefined && !(Number.isSafeInteger(s.control_revision) && s.control_revision >= 0)) || !Number.isSafeInteger(s.idle_ms) || s.idle_ms < 0 || (s.runtime_status !== undefined && !(RUNTIME_STATUSES as readonly string[]).includes(s.runtime_status)) || !Number.isSafeInteger(s.observed_at)) return c.json({ error: 'sample carries idle_ms, runtime_status, control_revision and observed_at only', reason: 'schema' }, 400);
    sample = s;
  }

  const receiptsIn: unknown[] = b.receipts === undefined ? [] : b.receipts;
  if (!Array.isArray(receiptsIn) || receiptsIn.length > 50) return c.json({ error: 'receipts[] ≤ 50', reason: 'batch_limit' }, 400);

  let device = await db.prepare('SELECT first_seen_at,last_seen_at,contiguous_seq,capabilities_json FROM ops_device_connections WHERE grant_id=? AND app_instance_id=? AND boot_id=?').bind(g.id, b.app_instance_id, b.boot_id).first<{ first_seen_at: number; last_seen_at: number; contiguous_seq: number; capabilities_json?: string }>();
  const stmts = [];
  if (!device) {
    device = { first_seen_at: now, last_seen_at: 0, contiguous_seq: 0, capabilities_json: JSON.stringify(Array.isArray(b.capabilities) ? b.capabilities.filter((x: unknown) => typeof x === 'string').slice(0, 32) : []) };
    // A window that did not do the pairing itself (second window, restart) declares what it can run here.
    const caps = Array.isArray(b.capabilities) && b.capabilities.length <= 32 && b.capabilities.every((x: unknown) => typeof x === 'string' && /^[a-z_]{1,48}$/.test(x)) ? b.capabilities : [];
    stmts.push(db.prepare("INSERT INTO ops_device_connections(grant_id,app_instance_id,boot_id,protocol,capabilities_json,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(g.id, b.app_instance_id, b.boot_id, OPS_PROTOCOL, JSON.stringify(caps), now, now));
  }
  const lesson = parseLesson(g.lesson_json);
  const existing = new Map<number, string>();
  // Everything stored above the cursor feeds both duplicate detection and the
  // ack: a late event that fills a hole must see the seqs already waiting past it.
  const stored_ = async (sql: string, ...args: unknown[]) => { for (const r of ((await db.prepare(sql).bind(g.id, b.boot_id, ...args).all()).results ?? []) as Array<{ seq: number; payload_hash: string }>) existing.set(r.seq, r.payload_hash); };
  if (seqs.length) {
    await stored_('SELECT seq,payload_hash FROM ops_events WHERE grant_id=? AND boot_id=? AND seq>? ORDER BY seq LIMIT 1000', device.contiguous_seq);
    if (Math.min(...seqs) <= device.contiguous_seq) await stored_('SELECT seq,payload_hash FROM ops_events WHERE grant_id=? AND boot_id=? AND seq BETWEEN ? AND ? LIMIT 1000', Math.min(...seqs), device.contiguous_seq);
  }
  const latest = await db.prepare('SELECT seat_revision,grant_id,revision,state_json,last_received_at FROM ops_latest_state WHERE class_run_id=? AND seat_id=?').bind(g.class_run_id, g.seat_id).first<{ seat_revision: number; grant_id: string; revision: number; state_json: string; last_received_at: number }>();
  // Board state never crosses a seat reassignment: a new binding starts empty.
  let state: SeatState = {}; const carried = latest && latest.seat_revision === g.seat_revision;
  if (carried) { try { state = JSON.parse(latest!.state_json); } catch { state = {}; } }
  let changed = reduceTokenCheck(state, { grantId: g.id, bootId: b.boot_id, bootSeenAt: device.first_seen_at }); const quarantined: number[] = [], rejected: Array<{ seq: number; error: string }> = [], stored: number[] = [];
  for (const e of raw) {
    const seq = (e as any).seq as number, v = validateEvent(e);
    // A malformed event still consumes its seq so the cursor can move, but its content is not kept.
    const hash = v.ok ? await sha256Hex(`${v.value.kind}:${v.value.actor}:${v.value.observed_at}:${canonicalPayload(v.value.payload)}`) : 'rejected_schema';
    if (existing.has(seq)) {
      if (existing.get(seq) !== hash) { quarantined.push(seq); stmts.push(audit(db, g.class_run_id, g.seat_id, 'system', 'sync', 'event_conflict', { grant_id: g.id, boot_id: b.boot_id, seq }, now)); continue; }
    } else {
      const disposition = !v.ok ? 'rejected_schema' : v.value.kind === 'step' ? stepDisposition(v.value.payload, lesson) : 'applied';
      if (!v.ok) rejected.push({ seq, error: v.error });
      stmts.push(db.prepare('INSERT INTO ops_events(grant_id,boot_id,seq,event_id,class_run_id,seat_id,kind,actor,payload_json,payload_hash,disposition,observed_at,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(g.id, b.boot_id, seq, v.ok ? v.value.event_id : '', g.class_run_id, g.seat_id, v.ok ? v.value.kind : 'rejected', v.ok ? v.value.actor : 'unknown', v.ok ? JSON.stringify(v.value.payload) : '{}', hash, disposition, v.ok ? v.value.observed_at : 0, now));
      stored.push(seq);
      if (v.ok && disposition !== 'applied') quarantined.push(seq);
      if (!v.ok || disposition !== 'applied') continue;
    }
    if (!v.ok) continue;
    if (v.value.kind === 'step' && stepDisposition(v.value.payload, lesson) !== 'applied') continue;
    // Token evidence has its own ordering: a stage that arrives later must not erase it, and a resend must not revive it.
    if (v.value.kind === 'activation' && reduceTokenCheck(state, { grantId: g.id, bootId: b.boot_id, bootSeenAt: device.first_seen_at }, { seq, observed_at: v.value.observed_at, received_at: now, actor: v.value.actor, payload: v.value.payload })) changed = true;
    if (shouldApply(state[v.value.kind], device.first_seen_at, seq)) { state[v.value.kind] = { boot_seen_at: device.first_seen_at, seq, observed_at: v.value.observed_at, received_at: now, actor: v.value.actor, value: v.value.payload }; changed = true; }
  }
  const ack = contiguousAck(device.contiguous_seq, [...new Set([...existing.keys(), ...stored])].filter((s) => s > device!.contiguous_seq).sort((x, y) => x - y));
  // Unchanged, recently written state is not rewritten: the 5 s poll must not become a 5 s D1 write.
  const due = !carried || now - latest!.last_received_at >= 45_000 || (sample?.control_revision !== undefined && sample.control_revision !== state.sample?.value.control_revision);
  if (sample && (due || changed)) { state.sample = { boot_seen_at: device.first_seen_at, seq: 0, observed_at: sample.observed_at as number, received_at: now, actor: 'system', value: { idle_ms: sample.idle_ms, ...(sample.runtime_status ? { runtime_status: sample.runtime_status } : {}), ...(sample.control_revision !== undefined ? { control_revision: sample.control_revision } : {}) } }; changed = true; }
  if (changed || due) {
    stmts.push(carried
      ? db.prepare('UPDATE ops_latest_state SET state_json=?,revision=revision+1,last_received_at=?,grant_id=? WHERE class_run_id=? AND seat_id=? AND revision=?').bind(JSON.stringify(state), now, g.id, g.class_run_id, g.seat_id, latest!.revision)
      : db.prepare('INSERT INTO ops_latest_state(class_run_id,seat_id,seat_revision,grant_id,state_json,last_received_at) VALUES(?,?,?,?,?,?) ON CONFLICT(class_run_id,seat_id) DO UPDATE SET seat_revision=excluded.seat_revision,grant_id=excluded.grant_id,revision=ops_latest_state.revision+1,state_json=excluded.state_json,last_received_at=excluded.last_received_at').bind(g.class_run_id, g.seat_id, g.seat_revision, g.id, JSON.stringify(state), now));
    stmts.push(db.prepare('UPDATE ops_device_connections SET last_seen_at=?,contiguous_seq=MAX(contiguous_seq,?) WHERE grant_id=? AND app_instance_id=? AND boot_id=?').bind(now, ack.contiguous, g.id, b.app_instance_id, b.boot_id));
  } else if (ack.contiguous > device.contiguous_seq) {
    // The cursor belongs to the event stream: a batch of only rejected/quarantined events still advances it.
    stmts.push(db.prepare('UPDATE ops_device_connections SET contiguous_seq=MAX(contiguous_seq,?) WHERE grant_id=? AND app_instance_id=? AND boot_id=?').bind(ack.contiguous, g.id, b.app_instance_id, b.boot_id));
  }
  if (stmts.length) {
    let results;
    // No ack without a durable write: the client keeps the events and retries.
    try { results = await db.batch(stmts); } catch (err) { console.error('ops sync store failed:', err); return c.json({ error: 'observations not stored; retry', reason: 'storage', poll_after_ms: poll }, 503); }
    const stateWrite = carried && (changed || due) ? results[results.length - 2] : null;
    // Another window of the same seat won the state CAS. Its events are stored; the board catches up on the next sync.
    if (stateWrite && stateWrite.meta?.changes === 0) return c.json({ error: 'seat state changed concurrently; resend', reason: 'state_conflict', poll_after_ms: 1000 }, 409);
  }
  // Command authority is unknown if this exchange fails: the device gets no commands and keeps its receipts.
  type Exchange = { commands: Array<Record<string, unknown>>; receipt_acks: Array<{ command_id: string; state: string; proceed: boolean; reason: string }>; lease: 'owner' | 'observer' | 'unknown' };
  let exchange: Exchange = { commands: [], receipt_acks: [], lease: 'unknown' };
  if (parseFlags(g.flags_json).ops_commands || receiptsIn.length) {
    try { exchange = await commandExchange(db, g, b.app_instance_id, receiptsIn, now, parseFlags(g.flags_json).ops_commands); }
    catch (err) { console.error('ops command exchange failed:', err); exchange = { commands: [], receipt_acks: [], lease: 'unknown' }; }
  }
  // U2 — targeted distribution. Isolated like the command exchange: a failure here drops this block only, and an absent
  // block is "no news", never success. The probe is a partial-index lookup; it runs when the feature is on for this run,
  // when the device has something to report, or (feature off) at the slow state cadence so that a withdrawal issued
  // during a rollback still reaches the device.
  let distribution: DistributionBlock | null = null;
  let declared = false; try { declared = declaresInbox(JSON.parse(device.capabilities_json ?? '[]')); } catch { declared = false; }
  const distFlag = parseFlags(g.flags_json).ops_distribute, distBody = b.distribution;
  if (distBody !== undefined || (declared && (distFlag || due)) || (!declared && distFlag && due)) {
    try {
      const hint = await db.prepare(`SELECT ${PENDING_PROBE} AS pending FROM ops_grants g WHERE g.id=?`).bind(g.id).first<{ pending: number }>();
      if (hint?.pending || distBody !== undefined) {
        const lease = exchange.lease === 'unknown' ? await seatLease(db, g, b.app_instance_id, now) : { owner: exchange.lease === 'owner' };
        if (lease.owner) distribution = await distributionExchange(db, g, { body: distBody, declared, instance: b.app_instance_id, flagOn: distFlag, runEnded: !!g.run_ended || now > g.run_ends, runEndsAt: g.run_ends, pendingHint: !!hint?.pending, now });
      }
    } catch (err) { console.error('ops distribution exchange failed:', err); distribution = null; }
  }
  return c.json({
    schema_version: OPS_SCHEMA_VERSION, server_time: now, connection_epoch: g.connection_epoch,
    ack: { boot_id: b.boot_id, contiguous_seq: ack.contiguous, missing: ack.missing }, quarantined, rejected,
    commands: exchange.commands, receipt_acks: exchange.receipt_acks, lease: exchange.lease,
    // The device applies this to its own new-run admission and reports the revision it applied.
    control: await readRunControl(c.env, g.class_run_id) ?? { paused: false, control_revision: 0 }, poll_after_ms: exchange.commands.length || distribution?.more || distribution?.items.length ? 1000 : poll,
    ...(distribution ? { distribution } : {}),
  });
});

// ── commands (R2) ───────────────────────────────────────────────────────────

type TargetRow = { command_id: string; class_run_id: string; seat_id: string; seat_revision: number; grant_id: string; connection_epoch: number; mutating: number; state: string; result_code: string; lease_generation: number; lease_instance: string; expires_at: number; updated_at: number };

/** Lazy expiry: nothing here runs on a timer, so every read settles overdue targets first. */
function settleOverdue(db: Db, where: string, args: unknown[], now: number) {
  return [
    db.prepare(`UPDATE ops_command_targets SET state='expired',result_code='ttl',updated_at=? WHERE ${where} AND state IN ('queued','leased') AND expires_at<=?`).bind(now, ...args, now),
    // Started but never reported back: the outcome is unknown, and that is what the board says.
    db.prepare(`UPDATE ops_command_targets SET state='outcome_unknown',result_code='no_receipt',updated_at=? WHERE ${where} AND state IN ('accepted','running') AND expires_at+60000<=?`).bind(now, ...args, now),
  ];
}

/** Seat execution lease: one window per seat may run commands or take inbox items; the others only observe. */
async function seatLease(db: Db, g: GrantRow, instance: string, now: number) {
  let lease = await db.prepare('SELECT app_instance_id,generation,renewed_at FROM ops_seat_leases WHERE grant_id=?').bind(g.id).first<{ app_instance_id: string; generation: number; renewed_at: number }>();
  if (!lease) {
    await db.prepare('INSERT INTO ops_seat_leases(grant_id,app_instance_id,generation,renewed_at) VALUES(?,?,1,?) ON CONFLICT(grant_id) DO NOTHING').bind(g.id, instance, now).run();
    lease = await db.prepare('SELECT app_instance_id,generation,renewed_at FROM ops_seat_leases WHERE grant_id=?').bind(g.id).first();
  } else if (lease.app_instance_id !== instance && now - lease.renewed_at > LEASE_TAKEOVER_MS) {
    const took = await db.prepare('UPDATE ops_seat_leases SET app_instance_id=?,generation=generation+1,renewed_at=? WHERE grant_id=? AND generation=? RETURNING generation').bind(instance, now, g.id, lease.generation).first<{ generation: number }>();
    if (took) lease = { app_instance_id: instance, generation: took.generation, renewed_at: now };
  } else if (lease.app_instance_id === instance && now - lease.renewed_at >= 45_000) {
    await db.prepare('UPDATE ops_seat_leases SET renewed_at=? WHERE grant_id=? AND app_instance_id=?').bind(now, g.id, instance).run();
  }
  return { owner: lease?.app_instance_id === instance, lease };
}

async function commandExchange(db: Db, g: GrantRow, instance: string, receiptsIn: unknown[], now: number, deliver: boolean) {
  const { owner, lease } = await seatLease(db, g, instance, now);
  const scope = 'class_run_id=? AND seat_id=?', scopeArgs = [g.class_run_id, g.seat_id];
  await db.batch([
    ...settleOverdue(db, scope, scopeArgs, now),
    // Addressed to an earlier login generation or device: never deliverable, so say so now.
    db.prepare(`UPDATE ops_command_targets SET state='expired',result_code='epoch_stale',updated_at=? WHERE ${scope} AND state IN ('queued','leased') AND (grant_id<>? OR connection_epoch<>?)`).bind(now, ...scopeArgs, g.id, g.connection_epoch),
  ]);

  const receipt_acks: Array<{ command_id: string; state: string; proceed: boolean; reason: string }> = [];
  for (const raw of receiptsIn) {
    const v = validateReceipt(raw);
    if (!v.ok) { receipt_acks.push({ command_id: String((raw as any)?.command_id ?? '').slice(0, 64), state: '', proceed: false, reason: 'schema' }); continue; }
    const r = v.value, t = await db.prepare('SELECT * FROM ops_command_targets WHERE command_id=? AND class_run_id=? AND seat_id=?').bind(r.command_id, g.class_run_id, g.seat_id).first<TargetRow>();
    const refuse = (reason: string, state = t?.state ?? '') => receipt_acks.push({ command_id: r.command_id, state, proceed: false, reason });
    if (!t || t.grant_id !== g.id) { refuse('not_found'); continue; }
    // Replay of the recorded outcome is fine; anything else after the end is refused and changes nothing.
    if (isTerminal(t.state)) { receipt_acks.push({ command_id: r.command_id, state: t.state, proceed: false, reason: t.state === r.state ? 'recorded' : 'terminal' }); continue; }
    if (r.connection_epoch !== g.connection_epoch || r.connection_epoch !== t.connection_epoch) { refuse('epoch_stale'); continue; }
    if (r.lease_generation !== t.lease_generation || t.lease_instance !== instance || !owner) { refuse('lease_lost'); continue; }
    const step = nextTargetState(t.state, r.state);
    if (!step.ok) { refuse(step.reason); continue; }
    const saved = await db.prepare('UPDATE ops_command_targets SET state=?,result_code=?,receipt_json=?,updated_at=? WHERE command_id=? AND seat_id=? AND state=? AND lease_generation=? RETURNING state').bind(step.state, r.result_code, JSON.stringify({ observed_at: r.observed_at, received_at: now, instance }), now, t.command_id, t.seat_id, t.state, t.lease_generation).first<{ state: string }>();
    if (!saved) { refuse('changed'); continue; }
    if (isTerminal(step.state)) await audit(db, g.class_run_id, g.seat_id, 'device', g.device_registration_id ?? g.id, 'command_' + step.state, { command_id: t.command_id, result_code: r.result_code }, now).run();
    // `accepted` is the device asking "may I still run this?" — answered from the primary, right now.
    receipt_acks.push({ command_id: r.command_id, state: step.state, proceed: step.state === 'accepted' || step.state === 'running', reason: '' });
  }

  let commands: Array<Record<string, unknown>> = [];
  if (deliver && owner && lease) {
    await db.prepare(`UPDATE ops_command_targets SET state='leased',lease_generation=?,lease_instance=?,updated_at=? WHERE ${scope} AND grant_id=? AND connection_epoch=? AND state='queued' AND expires_at>?`).bind(lease.generation, instance, now, ...scopeArgs, g.id, g.connection_epoch, now).run();
    // A lost response is healed here: a target this window already leased is simply handed over again.
    const rows = ((await db.prepare(`SELECT t.command_id,t.lease_generation,t.expires_at,t.connection_epoch,c.action,c.args_json,c.created_at FROM ops_command_targets t JOIN ops_commands c ON c.id=t.command_id WHERE t.class_run_id=? AND t.seat_id=? AND t.grant_id=? AND t.state='leased' AND t.lease_instance=? AND t.lease_generation=? AND t.expires_at>? ORDER BY c.created_at LIMIT 10`).bind(g.class_run_id, g.seat_id, g.id, instance, lease.generation, now).all()).results ?? []) as Array<{ command_id: string; lease_generation: number; expires_at: number; connection_epoch: number; action: string; args_json: string; created_at: number }>;
    commands = rows.map((r) => ({ schema_version: OPS_SCHEMA_VERSION, command_id: r.command_id, action: r.action, args: JSON.parse(r.args_json), lease_generation: r.lease_generation, connection_epoch: r.connection_epoch, issued_at: r.created_at,
      // Relative, so a wrong device clock cannot stretch the window; the device counts it down monotonically.
      start_within_ms: r.expires_at - now, run_within_ms: COMMAND_ACTIONS[r.action]?.runMs ?? SERVICE_ISSUED_ACTIONS[r.action]?.runMs ?? 0 }));
  }
  return { commands, receipt_acks, lease: owner ? 'owner' as const : 'observer' as const };
}

classroomOpsTeacher.post(root + '/commands', async (c) => {
  const b = await json(c), spec = typeof b?.action === 'string' ? COMMAND_ACTIONS[b.action] : undefined;
  // Unknown actions are refused before any authority question: there is no generic "run this" to authorize.
  const auth = await teacher(c, spec?.capability ?? 'command'); if (auth instanceof Response) return auth;
  if (!spec) return c.json({ error: 'action is not in the allowlist', reason: 'action_not_allowed', allowed: Object.keys(COMMAND_ACTIONS) }, 400);
  const run = await loadRun(c, auth); if (run instanceof Response) return run;
  if (!parseFlags(run.flags_json)[spec.flag]) return c.json({ error: 'commands are off for this run', reason: spec.flag + '_disabled' }, 403);
  if (!b || !UUIDISH_RE.test(b.idempotency_key ?? '') || !Array.isArray(b.targets) || !b.targets.length || b.targets.length > spec.maxTargets || b.targets.some((x: unknown) => typeof x !== 'string' || !ID_RE.test(x)) || new Set(b.targets).size !== b.targets.length || !(REASON_CODES as readonly string[]).includes(b.reason_code) || !Number.isInteger(b.expected_roster_revision)) return c.json({ error: 'idempotency_key, unique targets[], reason_code and expected_roster_revision required' }, 400);
  if (b.args !== undefined && (typeof b.args !== 'object' || b.args === null || Array.isArray(b.args))) return c.json({ error: 'args must be an object', reason: 'args_not_allowed' }, 400);
  let args: Record<string, unknown> = {};
  if (spec.args) { const v = spec.args(b.args ?? {}); if (!v.ok) return c.json({ error: v.error, reason: 'args_invalid' }, 400); args = Object.fromEntries(Object.entries(v.value).map(([k, x]) => [k, typeof x === 'string' ? scrubSecrets(x) : x])); }
  else if (b.args && Object.keys(b.args).length) return c.json({ error: 'this action takes no arguments', reason: 'args_not_allowed' }, 400);
  if (args.step_id !== undefined && !parseLesson(run.lesson_json)?.steps.includes(args.step_id as string)) return c.json({ error: 'step is not part of the confirmed lesson for this run', reason: 'unknown_step' }, 400);
  if (b.expected_roster_revision !== run.roster_revision) return c.json({ error: 'roster changed; reload before acting', reason: 'revision_conflict', roster_revision: run.roster_revision }, 409);
  const db = c.env.HPS_DB, now = Date.now(), targets = [...b.targets].sort();
  const payloadHash = await sha256Hex(JSON.stringify([b.action, targets, b.reason_code, run.roster_revision, args]));
  const prior = await db.prepare('SELECT id,payload_hash FROM ops_commands WHERE class_run_id=? AND idempotency_key=?').bind(run.class_run_id, b.idempotency_key).first<{ id: string; payload_hash: string }>();
  if (prior) return prior.payload_hash === payloadHash ? c.json(await commandView(db, run.class_run_id, prior.id, now), 200) : c.json({ error: 'idempotency key was used for a different request', reason: 'idempotency_conflict' }, 409);
  const recent = await db.prepare('SELECT count(*) AS n FROM ops_commands WHERE class_run_id=? AND created_at>?').bind(run.class_run_id, now - 60_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 60) return c.json({ error: 'too many commands in the last minute', reason: 'rate_limited' }, 429, { 'retry-after': '30' });
  const seats = ((await db.prepare(`SELECT s.seat_id,s.seat_revision,(SELECT g.id||'|'||g.connection_epoch FROM ops_grants g WHERE g.class_run_id=s.class_run_id AND g.seat_id=s.seat_id AND g.seat_revision=s.seat_revision AND g.kind='connection' AND g.state='active' AND g.expires_at>? ORDER BY g.created_at DESC LIMIT 1) AS conn,
 (SELECT d.capabilities_json FROM ops_device_connections d JOIN ops_grants g2 ON g2.id=d.grant_id LEFT JOIN ops_seat_leases l ON l.grant_id=d.grant_id WHERE g2.class_run_id=s.class_run_id AND g2.seat_id=s.seat_id AND g2.seat_revision=s.seat_revision AND g2.kind='connection' AND g2.state='active' ORDER BY (l.app_instance_id=d.app_instance_id) DESC,d.last_seen_at DESC LIMIT 1) AS caps
 FROM class_run_seats s WHERE s.class_run_id=? AND s.replaced_at IS NULL`).bind(now, run.class_run_id).all()).results ?? []) as Array<{ seat_id: string; seat_revision: number; conn: string | null; caps: string | null }>;
  const unknown = targets.filter((t) => !seats.some((s) => s.seat_id === t));
  if (unknown.length) return c.json({ error: 'targets outside this run', reason: 'seat_not_found', seats: unknown.slice(0, 20) }, 404);
  await settleOverdueRun(db, run.class_run_id, now);
  const id = crypto.randomUUID(), expires = now + COMMAND_TTL_MS;
  const stmts = [
    db.prepare('INSERT INTO ops_commands(id,class_run_id,cohort_id,action,args_json,payload_hash,idempotency_key,issued_by,issuer_jti,reason_code,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, run.class_run_id, run.cohort_id, b.action, JSON.stringify(args), payloadHash, b.idempotency_key, auth.payload.u, auth.payload.jti ?? null, b.reason_code, now, expires),
    audit(db, run.class_run_id, '', 'instructor', auth.payload.u, 'command_enqueued', { command_id: id, action: b.action, targets: targets.slice(0, 50), reason_code: b.reason_code }, now),
  ];
  for (const t of targets) {
    const s = seats.find((x) => x.seat_id === t)!; const [grantId, epoch] = (s.conn ?? '|').split('|');
    let caps: string[] = []; try { caps = JSON.parse(s.caps ?? '[]'); } catch { caps = []; }
    // Decided before anything is sent, per target: a seat that cannot receive this is not left "pending".
    const state = !grantId ? 'not_connected' : !caps.includes('commands') || !caps.includes(b.action) ? 'unsupported' : 'queued';
    // A seat that already has a state-changing command in flight is reported busy instead of failing the whole batch.
    stmts.push(db.prepare(`INSERT INTO ops_command_targets(command_id,class_run_id,seat_id,seat_revision,grant_id,connection_epoch,mutating,state,result_code,expires_at,updated_at)
 SELECT ?,?,?,?,?,?,?,CASE WHEN ?=1 AND ?='queued' AND EXISTS(SELECT 1 FROM ops_command_targets x WHERE x.class_run_id=? AND x.seat_id=? AND x.mutating=1 AND x.state IN ('queued','leased','accepted','running')) THEN 'rejected' ELSE ? END,
 CASE WHEN ?=1 AND ?='queued' AND EXISTS(SELECT 1 FROM ops_command_targets x WHERE x.class_run_id=? AND x.seat_id=? AND x.mutating=1 AND x.state IN ('queued','leased','accepted','running')) THEN 'seat_busy' ELSE '' END,?,?`).bind(id, run.class_run_id, t, s.seat_revision, grantId || '', Number(epoch) || 0, spec.mutating ? 1 : 0, spec.mutating ? 1 : 0, state, run.class_run_id, t, state, spec.mutating ? 1 : 0, state, run.class_run_id, t, expires, now));
  }
  // Command, audit and every target commit together or not at all.
  try { await db.batch(stmts); }
  catch (err) {
    const again = await db.prepare('SELECT id,payload_hash FROM ops_commands WHERE class_run_id=? AND idempotency_key=?').bind(run.class_run_id, b.idempotency_key).first<{ id: string; payload_hash: string }>();
    if (again) return again.payload_hash === payloadHash ? c.json(await commandView(db, run.class_run_id, again.id, now), 200) : c.json({ error: 'idempotency key was used for a different request', reason: 'idempotency_conflict' }, 409);
    console.error('ops command enqueue failed:', err); return c.json({ error: 'command not recorded; nothing was sent', reason: 'storage' }, 503);
  }
  // 202: recorded and queued. Not delivered, not started, not done.
  return c.json(await commandView(db, run.class_run_id, id, now), 202);
});

const settleOverdueRun = (db: Db, runId: string, now: number) => db.batch(settleOverdue(db, 'class_run_id=?', [runId], now));

async function commandView(db: Db, runId: string, id: string, now: number) {
  const cmd = await db.prepare('SELECT id,action,reason_code,issued_by,created_at,expires_at,cancelled_at FROM ops_commands WHERE id=? AND class_run_id=?').bind(id, runId).first<Record<string, unknown>>();
  if (!cmd) return null;
  const targets = ((await db.prepare('SELECT seat_id,state,result_code,lease_generation,connection_epoch,receipt_json,updated_at FROM ops_command_targets WHERE command_id=? ORDER BY seat_id').bind(id).all()).results ?? []) as Array<{ seat_id: string; state: string; result_code: string; lease_generation: number; connection_epoch: number; receipt_json: string; updated_at: number }>;
  return { command: cmd, now, summary: summarize(targets), targets: targets.map((t) => { let receipt = {}; try { receipt = JSON.parse(t.receipt_json); } catch { receipt = {}; } return { seat_id: t.seat_id, state: t.state, result_code: t.result_code, lease_generation: t.lease_generation, connection_epoch: t.connection_epoch, updated_at: t.updated_at, receipt }; }) };
}

classroomOpsTeacher.get(root + '/commands/:id', async (c) => {
  const auth = await teacher(c, 'observe'); if (auth instanceof Response) return auth;
  const run = await loadRun(c, auth); if (run instanceof Response) return run;
  const now = Date.now(); await settleOverdueRun(c.env.HPS_DB, run.class_run_id, now);
  const view = await commandView(c.env.HPS_DB, run.class_run_id, c.req.param('id')!, now);
  return view ? c.json(view) : c.json({ error: 'command not found' }, 404);
});

// Cancel stops delivery. It cannot recall what a device already started — those targets keep reporting.
classroomOpsTeacher.delete(root + '/commands/:id', async (c) => {
  const auth = await teacher(c, 'command'); if (auth instanceof Response) return auth;
  const run = await loadRun(c, auth); if (run instanceof Response) return run;
  const db = c.env.HPS_DB, now = Date.now(), id = c.req.param('id')!;
  if (!(await db.prepare('SELECT id FROM ops_commands WHERE id=? AND class_run_id=?').bind(id, run.class_run_id).first())) return c.json({ error: 'command not found' }, 404);
  await db.batch([
    db.prepare('UPDATE ops_commands SET cancelled_at=COALESCE(cancelled_at,?) WHERE id=?').bind(now, id),
    db.prepare("UPDATE ops_command_targets SET state='cancelled',result_code='instructor_cancelled',updated_at=? WHERE command_id=? AND state IN ('queued','leased')").bind(now, id),
    audit(db, run.class_run_id, '', 'instructor', auth.payload.u, 'command_cancelled', { command_id: id }, now),
  ]);
  return c.json(await commandView(db, run.class_run_id, id, now));
});

// ── class-run control (R3): pause / resume new runs ─────────────────────────
// Not a device command: the Service's own chat/messages admission enforces it from
// the D1 primary (lib/chat-gate.ts). Devices additionally hold their local tool
// admission and report the revision they applied.
classroomOpsTeacher.put(root + '/control', async (c) => {
  const auth = await teacher(c, 'pause'); if (auth instanceof Response) return auth;
  const run = await loadRun(c, auth); if (run instanceof Response) return run;
  if (!parseFlags(run.flags_json).ops_commands) return c.json({ error: 'commands are off for this run', reason: 'ops_commands_disabled' }, 403);
  const b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!b || typeof b.paused !== 'boolean' || !Number.isInteger(b.expected_control_revision)) return c.json({ error: 'paused and expected_control_revision required' }, 400);
  const prior = await db.prepare('SELECT control_revision FROM class_run_control WHERE class_run_id=?').bind(run.class_run_id).first<{ control_revision: number }>();
  if ((prior?.control_revision ?? 0) !== b.expected_control_revision) return c.json({ error: 'another instructor changed this; reload', reason: 'revision_conflict', control_revision: prior?.control_revision ?? 0 }, 409);
  const next = b.expected_control_revision + 1;
  const results = await db.batch([
    prior
      ? db.prepare('UPDATE class_run_control SET paused=?,control_revision=?,updated_by=?,updated_at=? WHERE class_run_id=? AND control_revision=?').bind(b.paused ? 1 : 0, next, auth.payload.u, now, run.class_run_id, b.expected_control_revision)
      : db.prepare('INSERT INTO class_run_control(class_run_id,cohort_id,paused,control_revision,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(class_run_id) DO NOTHING').bind(run.class_run_id, run.cohort_id, b.paused ? 1 : 0, next, auth.payload.u, now),
    db.prepare("INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) SELECT ?,'','instructor',?,?,?,? WHERE (SELECT control_revision FROM class_run_control WHERE class_run_id=?)=? AND (SELECT updated_by FROM class_run_control WHERE class_run_id=?)=? AND (SELECT updated_at FROM class_run_control WHERE class_run_id=?)=?").bind(run.class_run_id, auth.payload.u, b.paused ? 'new_runs_paused' : 'new_runs_resumed', JSON.stringify({ control_revision: next }), now, run.class_run_id, next, run.class_run_id, auth.payload.u, run.class_run_id, now),
  ]);
  if (results[0]?.meta?.changes !== 1) return c.json({ error: 'another instructor changed this; reload', reason: 'revision_conflict' }, 409);
  return c.json({
    paused: b.paused, control_revision: next,
    applies_to: 'new AI requests of this class run, enforced by the Service now',
    // Said up front so the instructor does not read "paused" as "everything stopped".
    not_applied_to: ['requests already running', 'local file editing, saving, Stop and export', 'devices that are offline or on an app without this feature until they report the revision'],
  });
});

// ── evidence review state (2026-09-18 added criteria) ───────────────────────
// `confirmed` = an instructor looked at this evidence. It is not delivery approval,
// not a grade and not lesson completion, and it changes nothing on the learner's side.
classroomOpsTeacher.put(root + '/evidence/:ref', async (c) => {
  const auth = await teacher(c, 'coach'); if (auth instanceof Response) return auth;
  const run = await loadRun(c, auth); if (run instanceof Response) return run;
  const [grantId, bootId, seqText] = (c.req.param('ref') ?? '').split('.'), seq = Number(seqText), b = await json(c), now = Date.now(), db = c.env.HPS_DB;
  if (!UUIDISH_RE.test(grantId ?? '') || !UUIDISH_RE.test(bootId ?? '') || !Number.isSafeInteger(seq) || !b || !(REVIEW_STATES as readonly string[]).includes(b.state) || !Number.isInteger(b.expected_revision)) return c.json({ error: 'evidence ref, state and expected_revision required' }, 400);
  // An instructor may look at an evidence event, or at a step the LEARNER marked as finished. Nothing else is reviewable:
  // a step the learner has not submitted cannot be "reviewed" into completion from the instructor's side.
  const ev = await db.prepare("SELECT e.seat_id,e.kind,e.payload_json FROM ops_events e JOIN ops_grants g ON g.id=e.grant_id JOIN class_run_seats s ON s.class_run_id=g.class_run_id AND s.seat_id=g.seat_id AND s.seat_revision=g.seat_revision AND s.replaced_at IS NULL WHERE e.grant_id=? AND e.boot_id=? AND e.seq=? AND e.class_run_id=? AND e.kind IN ('evidence','step') AND e.disposition='applied'").bind(grantId, bootId, seq, run.class_run_id).first<{ seat_id: string; kind: string; payload_json: string }>();
  if (!ev) return c.json({ error: 'evidence not found in this run' }, 404);
  if (ev.kind === 'step') { let status = ''; try { status = JSON.parse(ev.payload_json).status; } catch { status = ''; } if (status !== 'submitted') return c.json({ error: 'only a step the learner submitted can be reviewed', reason: 'step_not_submitted' }, 409); }
  const saved = b.expected_revision === 0
    ? await db.prepare('INSERT INTO ops_event_reviews(grant_id,boot_id,seq,class_run_id,seat_id,state,reviewer_id,revision,updated_at) VALUES(?,?,?,?,?,?,?,1,?) ON CONFLICT(grant_id,boot_id,seq) DO NOTHING RETURNING state,revision').bind(grantId, bootId, seq, run.class_run_id, ev.seat_id, b.state, auth.payload.u, now).first<{ state: string; revision: number }>()
    : await db.prepare('UPDATE ops_event_reviews SET state=?,reviewer_id=?,revision=revision+1,updated_at=? WHERE grant_id=? AND boot_id=? AND seq=? AND revision=? RETURNING state,revision').bind(b.state, auth.payload.u, now, grantId, bootId, seq, b.expected_revision).first<{ state: string; revision: number }>();
  if (!saved) return c.json({ error: 'another instructor reviewed this; reload', reason: 'revision_conflict' }, 409);
  await audit(db, run.class_run_id, ev.seat_id, 'instructor', auth.payload.u, (ev.kind === 'step' ? 'step_' : 'evidence_') + b.state, { ref: c.req.param('ref') }, now).run();
  return c.json({ ref: c.req.param('ref'), kind: ev.kind, review_state: saved.state, review_revision: saved.revision, reviewed_by: auth.payload.u, means: ev.kind === 'step' ? 'an instructor looked at the step the learner said they finished' : 'instructor looked at this evidence', does_not_mean: ['delivery approval', 'lesson completion', 'a grade'] });
});
