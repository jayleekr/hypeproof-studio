// Remote classroom operations (#751, U2) — the instructor side of targeted distribution: author an immutable revision,
// preview and confirm a distribution to SELECTED seats, read per-target results, withdraw one run or retire the material.
// Contract: docs/requirements/classroom-admin.md#remote-management-u2-20260921.
//
//  - Own switch (`ops_distribute`) and own authority (`distribute`). No other capability implies it, and `ops_delivery`
//    (report sending) is a different feature that this file never reads.
//  - Learners have NO content endpoint. A body leaves the Service only inside the /sync answer of a device whose
//    eligibility was just checked (lib/classroom-distribution-store.ts).
//  - Every commit is one conditional D1 batch whose statement count does not depend on the number of seats: the first
//    INSERT carries the whole precondition, everything else exists only if that row does.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../env';
import { authorizeIssuerForOps, type IssuerAuthz } from '../lib/instructor-auth';
import { scrubSecrets } from '../lib/scrub-secrets';
import { ID_RE, MAX_SEATS, MAX_SYNC_BYTES, UUIDISH_RE, parseFlags } from '../lib/classroom-ops';
import {
  CONTENT_SCHEMA, LIST_PAGE, MAX_DISTRIBUTIONS_PER_MINUTE, MAX_DISTRIBUTIONS_PER_RUN, MAX_OBJECTS_PER_RUN, MAX_REVISIONS_PER_OBJECT,
  contentCanonical, contentHash, distStatus, distributionRequestCanonical, normalizeContentRequest, normalizeDistributionRequest,
  parseLinkHosts, sha256Hex, summarizeDistribution, type CardFacts,
} from '../lib/classroom-distribution';
import { NOT_FENCED, coverageStatements, settleStatements } from '../lib/classroom-distribution-store';
import { opsEnabled } from './classroom-ops';
import { parseLesson } from '../lib/classroom-ops';
import { confirmationRequired, readinessOf, versionUsable } from '../lib/lesson-rehearsal-store';
import { readLesson } from '../lib/lesson-delivery';
import { readOpening } from '../lib/cohort-binding';
import { getProfile } from '../profiles';
import { bindingsEnforced } from '../lib/lesson-binding-store';
import { lessonImpact, settingPhase } from '../lib/lesson-binding';
import { effectiveBySeat } from '../lib/lesson-binding-store';
import { declaresKind, type Content } from '../lib/classroom-distribution';

type Db = Env['HPS_DB'];
type Run = { class_run_id: string; cohort_id: string; profile_id: string; flags_json: string; lesson_json?: string; roster_revision: number; starts_at: number; ends_at: number; ended_at?: string | null };
const json = async (c: any) => { try { return await c.req.json(); } catch { return null; } };
const auditIf = (db: Db, run: string, who: string, action: string, detail: unknown, at: number, cond: string, condArgs: unknown[]) =>
  db.prepare(`INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) SELECT ?,'','instructor',?,?,?,? WHERE ${cond}`).bind(run, who, action, JSON.stringify(detail), at, ...condArgs);
const ended = (run: Run, now: number) => !!run.ended_at || now > run.ends_at;

export const classroomDistributionTeacher = new Hono<{ Bindings: Env }>();
const root = '/cohorts/:cohort/classroom/runs/:run';
const limit = bodyLimit({ maxSize: MAX_SYNC_BYTES, onError: (c) => c.json({ error: 'request too large' }, 413) });
classroomDistributionTeacher.use(root + '/contents', limit); classroomDistributionTeacher.use(root + '/contents/*', limit);
classroomDistributionTeacher.use(root + '/distributions', limit); classroomDistributionTeacher.use(root + '/distributions/*', limit);

/** `creating` = the request makes something new and therefore needs the run switch. Reading results and withdrawing do not: switching the feature off is a rollback, not a gag. */
async function teacher(c: any, creating: boolean): Promise<{ auth: IssuerAuthz; run: Run } | Response> {
  c.header('cache-control', 'no-store');
  if (!opsEnabled(c.env)) return c.json({ error: 'classroom operations are not enabled', reason: 'ops_disabled' }, 404);
  if (!ID_RE.test(c.req.param('cohort')) || !ID_RE.test(c.req.param('run'))) return c.json({ error: 'invalid cohort or run id' }, 400);
  const auth = await authorizeIssuerForOps(c, c.req.param('cohort'), 'distribute');
  if (auth instanceof Response) return auth; if (!auth) return c.json({ error: 'instructor Bearer required' }, 401);
  const run = await c.env.HPS_DB.prepare('SELECT o.*,s.ended_at FROM class_run_ops o LEFT JOIN sessions s ON s.id=o.class_run_id WHERE o.class_run_id=? AND o.cohort_id=?').bind(c.req.param('run'), c.req.param('cohort')).first() as Run | null;
  if (!run) return c.json({ error: 'class run not configured', reason: 'run_not_found' }, 404);
  if (!auth.scope.profiles.includes(run.profile_id)) return c.json({ error: 'issuer not scoped to this run profile', reason: 'profile_scope' }, 403);
  if (creating && !parseFlags(run.flags_json).ops_distribute) return c.json({ error: 'distribution is off for this run', reason: 'ops_distribute_disabled' }, 403);
  return { auth, run };
}
/** Read once more, AFTER a conditional commit wrote nothing, to name the part that moved. Never used to decide a write. */
async function whyRefused(db: Db, run: Run, jti: string | undefined, now: number, extra: () => Promise<string | null>): Promise<{ reason: string; status: 403 | 409; roster_revision?: number }> {
  const live = await db.prepare('SELECT o.roster_revision,o.flags_json,o.ends_at,s.ended_at FROM class_run_ops o LEFT JOIN sessions s ON s.id=o.class_run_id WHERE o.class_run_id=?').bind(run.class_run_id).first<{ roster_revision: number; flags_json: string; ends_at: number; ended_at: string | null }>();
  if (jti && await db.prepare("SELECT 1 FROM ops_issuer_fences WHERE issuer_jti=? AND state='revoked'").bind(jti).first()) return { reason: 'issuer_revoked', status: 403 };
  if (live && !parseFlags(live.flags_json).ops_distribute) return { reason: 'ops_distribute_disabled', status: 403 };
  if (!live || live.ended_at || now > live.ends_at) return { reason: 'run_ended', status: 409 };
  if (live.roster_revision !== run.roster_revision) return { reason: 'revision_conflict', status: 409, roster_revision: live.roster_revision };
  return { reason: (await extra()) ?? 'changed_during_request', status: 409, roster_revision: live.roster_revision };
}
// ── U3: a SETTING changes what a participant executes, so it has its own switch, its own authority and its own checks ──
const SETTINGS_ON = "EXISTS (SELECT 1 FROM class_run_ops o2 WHERE o2.class_run_id=? AND json_extract(o2.flags_json,'$.ops_lesson_settings')=1)";
const runtimeOf = (lesson: { content: { model?: { binding?: { runtime?: string } } } }, profileId: string) => { const p = getProfile(profileId); return lesson.content.model?.binding?.runtime ?? (p?.minor_cohort ? 'proxy' : p?.coach_runtime ?? 'proxy'); };
/** Where the frozen versions of this run's course live: the template cohort for a class opening, the cohort itself otherwise. */
async function lessonCohortOf(env: Env, cohort: string): Promise<string> { try { return (await readOpening(env, cohort))?.template_cohort ?? cohort; } catch { return cohort; } }
/** Who may create or send a setting, and whether this Service can enforce one at all. Returns a Response to refuse. */
function settingAuthority(c: any, auth: IssuerAuthz, run: Run): Response | null {
  if (!(auth.scope.ops ?? []).includes('lesson_settings')) return c.json({ error: "issuer scope lacks operations capability 'lesson_settings'", reason: 'ops_capability_missing' }, 403);
  if (!parseFlags(run.flags_json).ops_lesson_settings) return c.json({ error: 'lesson settings are off for this run', reason: 'ops_lesson_settings_disabled' }, 403);
  // A binding row may only ever exist where it is enforced: otherwise a "switched" learner would silently keep the old version.
  if (!bindingsEnforced(c.env)) return c.json({ error: 'this Service does not enforce lesson bindings; a setting cannot be created or sent', reason: 'lesson_bindings_not_enforced' }, 503);
  return null;
}
/** A setting names a frozen version of THE RUN'S course that resolves NOW for the run's profile, on the run's runtime. */
async function settingAdmissible(c: any, run: Run, content: Content): Promise<Response | { pin: NonNullable<ReturnType<typeof parseLesson>>; target: Awaited<ReturnType<typeof readLesson>>; base: NonNullable<Awaited<ReturnType<typeof readLesson>>> }> {
  const pin = parseLesson(run.lesson_json);
  if (!pin || !pin.course_id) return c.json({ error: 'this run has no pinned lesson; a setting needs a base to change from', reason: 'run_lesson_not_pinned' }, 409);
  const cohort = await lessonCohortOf(c.env, run.cohort_id), base = await readLesson(c.env, cohort, pin.course_id, pin.version, run.profile_id);
  if (!base) return c.json({ error: "the run's pinned lesson cannot be opened", reason: 'lesson_unavailable' }, 409);
  if (content.lesson === 'base') return { pin, target: null, base };
  const ref = content.lesson!;
  if (ref.course_id !== pin.course_id) return c.json({ error: "a setting names a version of this run's course", reason: 'setting_course_mismatch' }, 409);
  const target = await readLesson(c.env, cohort, ref.course_id, ref.version, run.profile_id);
  if (!target) return c.json({ error: 'no confirmed version with this id resolves for the run profile (a draft, another cohort, or a policy that no longer fits)', reason: 'lesson_unavailable' }, 409);
  if (target.sha256 !== ref.sha256) return c.json({ error: 'the version differs from what was reviewed', reason: 'lesson_mismatch' }, 409);
  if (runtimeOf(target, run.profile_id) !== runtimeOf(base, run.profile_id)) return c.json({ error: 'this version runs on another runtime; a class does not switch runtime mid-session', reason: 'setting_runtime_change' }, 409);
  // #1012 · #751 G2 — where confirmation is required, a switch goes only to a version confirmed on a passed rehearsal. The
  // return to the run's own version ('base') is never blocked: it is what the class was opened with.
  if (target.version !== base.version && !(await versionUsable(c.env, { cohort, course: ref.course_id, version: target.version, profileId: run.profile_id, lessonSha: target.sha256, content: target.content })))
    return c.json({ error: 'confirm this version after a passed learner-condition rehearsal first', reason: 'version_not_confirmed' }, 409);
  return { pin, target, base };
}
const RUN_OPEN = "EXISTS (SELECT 1 FROM class_run_ops o WHERE o.class_run_id=? AND json_extract(o.flags_json,'$.ops_distribute')=1 AND o.ends_at>? AND NOT EXISTS (SELECT 1 FROM sessions z WHERE z.id=o.class_run_id AND z.ended_at IS NOT NULL))";

// What an instructor may pick for a setting: the confirmed versions of THE RUN'S course, each judged by the same rule that
// admits a setting. A picker over frozen rows — nothing is authored here. Read-only, instructor-initiated, bounded.
const MAX_SETTING_OPTIONS = 20;
classroomDistributionTeacher.get(root + '/setting-options', async (c) => {
  const t = await teacher(c, false); if (t instanceof Response) return t; const { auth, run } = t;
  const no = settingAuthority(c, auth, run); if (no) return no;
  const pin = parseLesson(run.lesson_json);
  if (!pin || !pin.course_id) return c.json({ error: 'this run has no pinned lesson; a setting needs a base to change from', reason: 'run_lesson_not_pinned' }, 409);
  try {
    const cohort = await lessonCohortOf(c.env, run.cohort_id), base = await readLesson(c.env, cohort, pin.course_id, pin.version, run.profile_id);
    if (!base) return c.json({ error: "the run's pinned lesson cannot be opened", reason: 'lesson_unavailable' }, 409);
    const rows = await c.env.HPS_DB.prepare('SELECT version FROM authoring_versions WHERE cohort_id=? AND course_id=? ORDER BY source_revision DESC, version DESC LIMIT ?').bind(cohort, pin.course_id, MAX_SETTING_OPTIONS + 1).all<{ version: string }>();
    const options = [];
    for (const r of (rows.results ?? []).slice(0, MAX_SETTING_OPTIONS)) {
      const l = r.version === base.version ? base : await readLesson(c.env, cohort, pin.course_id, r.version, run.profile_id);
      const ready = l ? await readinessOf(c.env, { cohort, course: pin.course_id, version: r.version, profileId: run.profile_id, lessonSha: l.sha256, content: l.content }) : null;
      const confirmedNow = !!ready?.confirmed && ready.confirmation_current;
      const why = !l ? 'lesson_unavailable' : runtimeOf(l, run.profile_id) !== runtimeOf(base, run.profile_id) ? 'setting_runtime_change'
        : r.version !== base.version && confirmationRequired(c.env) && !confirmedNow ? 'not_confirmed' : '';
      options.push({ version: r.version, is_run_version: r.version === base.version, selectable: !why, reason: why, rehearsal: ready?.state ?? 'not_run', confirmed: confirmedNow, ...(l ? { sha256: l.sha256, title: l.content.title ?? '', mission: l.content.learning?.mission ?? null, impact: lessonImpact(base.content, l.content) } : {}) });
    }
    return c.json({ course_id: pin.course_id, run_version: base.version, options, truncated: (rows.results ?? []).length > MAX_SETTING_OPTIONS, applies: 'next_question', confirmation_required: confirmationRequired(c.env) }, 200);
  } catch (err) { console.error('setting options unreadable:', err); return c.json({ error: 'setting options cannot be read right now', reason: 'distribution_unavailable' }, 503); }
});

// ── contents: immutable revisions of a per-run object ────────────────────────
classroomDistributionTeacher.post(root + '/contents', async (c) => {
  const t = await teacher(c, true); if (t instanceof Response) return t; const { auth, run } = t, db = c.env.HPS_DB, now = Date.now();
  const norm = normalizeContentRequest(await json(c), parseLinkHosts(c.env.HPS_CLASSROOM_LINK_HOSTS));
  if (!norm.ok) return c.json({ error: norm.detail, reason: norm.reason, ...(norm.field ? { field: norm.field } : {}) }, 400);
  const req = norm.value, isSetting = req.content.kind === 'setting';
  if (ended(run, now)) return c.json({ error: 'this class run has ended; nothing new can be authored for it', reason: 'run_ended' }, 409);
  if (isSetting) {
    const no = settingAuthority(c, auth, run); if (no) return no;
    const okay = await settingAdmissible(c, run, req.content); if (okay instanceof Response) return okay;
    // One setting object per run (unique partial index): a second choice is the NEXT REVISION of that object.
    if (req.object_id === null) { const prior = await db.prepare("SELECT object_id,latest_revision FROM classroom_content_objects WHERE class_run_id=? AND kind='setting'").bind(run.class_run_id).first<{ object_id: string; latest_revision: number }>(); if (prior) return c.json({ error: 'this run already has its setting object; save the next revision of it', reason: 'setting_object_exists', object_id: prior.object_id, latest_revision: prior.latest_revision }, 409); }
  }
  // Secrets are masked BEFORE hashing: what is stored, hashed, reviewed and delivered is one and the same text.
  const content = { ...req.content, title: scrubSecrets(req.content.title), body: scrubSecrets(req.content.body) };
  const hash = await contentHash(content), requestHash = await sha256Hex(JSON.stringify([req.object_id, req.expected_latest_revision, contentCanonical(content)]));
  const replay = async () => {
    const prior = await db.prepare('SELECT object_id,revision,content_hash,kind,title,created_at,request_hash FROM classroom_content_revisions WHERE class_run_id=? AND idempotency_key=?').bind(run.class_run_id, req.idempotency_key).first<Record<string, any>>();
    if (!prior) return null;
    const { request_hash, ...view } = prior;
    return request_hash === requestHash ? c.json({ ...view, replayed: true }, 200) : c.json({ error: 'this idempotency key was used for different content', reason: 'idempotency_conflict' }, 409);
  };
  const again = await replay(); if (again) return again;
  const jti = auth.payload.jti ?? '', objectId = req.object_id ?? crypto.randomUUID(), revision = (req.expected_latest_revision ?? 0) + 1;
  if (revision > MAX_REVISIONS_PER_OBJECT) return c.json({ error: `a material has at most ${MAX_REVISIONS_PER_OBJECT} revisions`, reason: 'content_limit' }, 429);
  const made = 'EXISTS (SELECT 1 FROM classroom_content_revisions WHERE object_id=? AND revision=? AND idempotency_key=?)', madeArgs = [objectId, revision, req.idempotency_key];
  const payload = JSON.stringify({ body: content.body, links: content.links, ...(isSetting ? { lesson: content.lesson } : {}) });
  // The revision row carries the whole precondition: the run is open with the switch on, the token is not fenced, and the
  // object is where the author saw it (absent for a new one; at the expected revision, same kind, not retired otherwise).
  const where = req.object_id === null
    ? `${RUN_OPEN} AND ${NOT_FENCED} AND (SELECT count(*) FROM classroom_content_objects WHERE class_run_id=?)<?${isSetting ? ` AND ${SETTINGS_ON}` : ''}`
    : `${RUN_OPEN} AND ${NOT_FENCED} AND EXISTS (SELECT 1 FROM classroom_content_objects x WHERE x.object_id=? AND x.class_run_id=? AND x.latest_revision=? AND x.kind=? AND x.retired_at IS NULL)${isSetting ? ` AND ${SETTINGS_ON}` : ''}`;
  const whereArgs = [...(req.object_id === null ? [run.class_run_id, now, jti, run.class_run_id, MAX_OBJECTS_PER_RUN] : [run.class_run_id, now, jti, objectId, run.class_run_id, req.expected_latest_revision, content.kind]), ...(isSetting ? [run.class_run_id] : [])];
  const stmts = [
    db.prepare(`INSERT INTO classroom_content_revisions(object_id,revision,class_run_id,kind,title,payload_json,content_hash,content_schema,request_hash,idempotency_key,created_by,issuer_jti,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${where}`).bind(objectId, revision, run.class_run_id, content.kind, content.title, payload, hash, CONTENT_SCHEMA, requestHash, req.idempotency_key, auth.payload.u, jti || null, now, ...whereArgs),
    req.object_id === null
      ? db.prepare(`INSERT INTO classroom_content_objects(object_id,class_run_id,cohort_id,kind,latest_revision,created_by,created_at) SELECT ?,?,?,?,1,?,? WHERE ${made}`).bind(objectId, run.class_run_id, run.cohort_id, content.kind, auth.payload.u, now, ...madeArgs)
      : db.prepare(`UPDATE classroom_content_objects SET latest_revision=? WHERE object_id=? AND latest_revision=? AND ${made}`).bind(revision, objectId, req.expected_latest_revision, ...madeArgs),
    auditIf(db, run.class_run_id, auth.payload.u, 'distribution_content_saved', { object_id: objectId, revision, kind: content.kind, content_hash: hash }, now, made, madeArgs),
  ];
  try { await db.batch(stmts); } catch (err) { const raced = await replay(); if (raced) return raced; console.error('distribution content not saved:', err); return c.json({ error: 'not saved; nothing was created', reason: 'storage' }, 503); }
  const saved = await db.prepare('SELECT object_id,revision,content_hash,kind,title,created_at FROM classroom_content_revisions WHERE object_id=? AND revision=? AND idempotency_key=?').bind(...madeArgs).first();
  if (saved) return c.json(saved, 201);
  const raced = await replay(); if (raced) return raced;
  const no = await whyRefused(db, run, jti, now, async () => {
    if (req.object_id === null) return (await db.prepare('SELECT count(*) AS n FROM classroom_content_objects WHERE class_run_id=?').bind(run.class_run_id).first<{ n: number }>())!.n >= MAX_OBJECTS_PER_RUN ? 'content_limit' : null;
    const o = await db.prepare('SELECT latest_revision,kind,retired_at FROM classroom_content_objects WHERE object_id=? AND class_run_id=?').bind(objectId, run.class_run_id).first<{ latest_revision: number; kind: string; retired_at: number | null }>();
    return !o ? 'object_not_found' : o.retired_at ? 'object_retired' : o.kind !== content.kind ? 'kind_mismatch' : 'revision_conflict';
  });
  return c.json({ error: no.reason === 'revision_conflict' ? 'someone saved a newer revision of this material; your text is unchanged — reload and compare' : 'not saved; nothing was created', reason: no.reason }, no.reason === 'content_limit' ? 429 : no.reason === 'object_not_found' ? 404 : no.status);
});

classroomDistributionTeacher.get(root + '/contents', async (c) => {
  const t = await teacher(c, false); if (t instanceof Response) return t; const { run } = t, db = c.env.HPS_DB;
  const before = Number(c.req.query('cursor') ?? '') || Number.MAX_SAFE_INTEGER;
  // Metadata only. Result counts are deliberately absent: they would scan the target ledger of the whole run on every list.
  const rows = ((await db.prepare(`SELECT o.object_id,o.kind,o.latest_revision,o.retired_at,o.created_at,r.title,r.content_hash,
 (SELECT count(*) FROM classroom_distributions d WHERE d.class_run_id=o.class_run_id AND d.object_id=o.object_id) AS distributions,
 (SELECT max(d.created_at) FROM classroom_distributions d WHERE d.class_run_id=o.class_run_id AND d.object_id=o.object_id) AS last_distributed_at
 FROM classroom_content_objects o JOIN classroom_content_revisions r ON r.object_id=o.object_id AND r.revision=o.latest_revision
 WHERE o.class_run_id=? AND o.created_at<? ORDER BY o.created_at DESC LIMIT ?`).bind(run.class_run_id, before, LIST_PAGE + 1).all()).results ?? []) as Array<Record<string, any>>;
  return c.json({ contents: rows.slice(0, LIST_PAGE).map((r) => ({ ...r, retired: r.retired_at !== null })), next_cursor: rows.length > LIST_PAGE ? rows[LIST_PAGE - 1]!.created_at : null });
});

classroomDistributionTeacher.get(root + '/contents/:object/revisions/:rev', async (c) => {
  const t = await teacher(c, false); if (t instanceof Response) return t;
  const r = await c.env.HPS_DB.prepare('SELECT object_id,revision,kind,title,payload_json,content_hash,content_schema,created_by,created_at FROM classroom_content_revisions WHERE object_id=? AND revision=? AND class_run_id=?').bind(c.req.param('object')!, Number(c.req.param('rev')), t.run.class_run_id).first<Record<string, any>>();
  if (!r) return c.json({ error: 'no such revision in this run', reason: 'not_found' }, 404);
  let payload: { body?: unknown; links?: unknown }; try { payload = JSON.parse(r.payload_json); } catch { return c.json({ error: 'this revision cannot be read right now', reason: 'content_unavailable' }, 503); }
  const { payload_json, ...meta } = r;
  return c.json({ ...meta, body: payload.body, links: payload.links ?? [], ...((payload as any).lesson !== undefined ? { lesson: (payload as any).lesson } : {}) });
});

// ── distributions ────────────────────────────────────────────────────────────
type SeatNow = { seat_id: string; seat_revision: number; student_id: string; conn: string | null; caps: string | null };
const seatsNow = async (db: Db, runId: string, now: number) => ((await db.prepare(`SELECT s.seat_id,s.seat_revision,s.student_id,
 (SELECT g.id||'|'||COALESCE(g.device_registration_id,'') FROM ops_grants g WHERE g.class_run_id=s.class_run_id AND g.seat_id=s.seat_id AND g.seat_revision=s.seat_revision AND g.kind='connection' AND g.state='active' AND g.expires_at>? ORDER BY g.created_at DESC LIMIT 1) AS conn,
 (SELECT d.capabilities_json FROM ops_device_connections d JOIN ops_grants g2 ON g2.id=d.grant_id WHERE g2.class_run_id=s.class_run_id AND g2.seat_id=s.seat_id AND g2.seat_revision=s.seat_revision AND g2.kind='connection' AND g2.state='active' ORDER BY d.last_seen_at DESC LIMIT 1) AS caps
 FROM class_run_seats s WHERE s.class_run_id=? AND s.replaced_at IS NULL`).bind(now, runId).all()).results ?? []) as SeatNow[];

classroomDistributionTeacher.post(root + '/distributions', async (c) => {
  const t = await teacher(c, true); if (t instanceof Response) return t; const { auth, run } = t, db = c.env.HPS_DB, now = Date.now();
  const norm = normalizeDistributionRequest(await json(c), MAX_SEATS); if (!norm.ok) return c.json({ error: norm.detail, reason: norm.reason }, 400);
  const req = norm.value, jti = auth.payload.jti ?? '';
  const expires = Math.min(req.expires_at ?? run.ends_at, run.ends_at);
  const requestHash = await sha256Hex(distributionRequestCanonical({ object_id: req.object_id, revision: req.revision, content_hash: req.content_hash, targets: req.targets, expires_at: expires, roster_revision: req.roster_revision }));
  const replay = async () => {
    // Fail closed: a prior row that cannot be read is a 503, never "no such request" (which would create a second run).
    let prior: { id: string; request_hash: string } | null;
    try { prior = await db.prepare('SELECT id,request_hash FROM classroom_distributions WHERE class_run_id=? AND idempotency_key=?').bind(run.class_run_id, req.idempotency_key).first(); }
    catch (err) { console.error('distribution replay lookup failed:', err); return c.json({ error: 'earlier requests cannot be read right now; nothing was sent — retry', reason: 'distribution_unavailable' }, 503, { 'retry-after': '30' }); }
    if (!prior) return null;
    return prior.request_hash === requestHash ? c.json({ ...(await distributionView(db, run, prior.id, now)), replayed: true }, 200) : c.json({ error: 'this idempotency key was used for a different distribution', reason: 'idempotency_conflict' }, 409);
  };
  if (!req.dry_run) { const again = await replay(); if (again) return again; }
  if (req.roster_revision !== run.roster_revision) return c.json({ error: 'roster changed; reload before distributing', reason: 'revision_conflict', roster_revision: run.roster_revision }, 409);
  if (ended(run, now)) return c.json({ error: 'this class run has ended; nothing new can be distributed', reason: 'run_ended' }, 409);
  if (expires <= now) return c.json({ error: 'expires.at is in the past', reason: 'request_invalid' }, 400);
  const revision = await db.prepare('SELECT r.content_hash,r.kind,r.title,o.retired_at,o.latest_revision FROM classroom_content_revisions r JOIN classroom_content_objects o ON o.object_id=r.object_id WHERE r.object_id=? AND r.revision=? AND r.class_run_id=?').bind(req.object_id, req.revision, run.class_run_id).first<{ content_hash: string; kind: string; title: string; retired_at: number | null; latest_revision: number }>();
  if (!revision) return c.json({ error: 'no such revision in this run', reason: 'content_not_found' }, 404);
  if (revision.retired_at !== null) return c.json({ error: 'this material was withdrawn; author a new one', reason: 'object_retired' }, 409);
  if (revision.content_hash !== req.content_hash) return c.json({ error: 'the content differs from what was reviewed', reason: 'content_mismatch' }, 409);
  // U3 — sending a SETTING needs its own authority and switch, and the version must still resolve at this moment. The
  // impact summary is computed here from the two frozen rows; the instructor does not type it.
  const isSetting = revision.kind === 'setting'; let impact: unknown = null, settingLesson: unknown = null, settled: Exclude<Awaited<ReturnType<typeof settingAdmissible>>, Response> | null = null;
  if (isSetting) {
    const no = settingAuthority(c, auth, run); if (no) return no;
    const rev = await db.prepare('SELECT payload_json,title FROM classroom_content_revisions WHERE object_id=? AND revision=?').bind(req.object_id, req.revision).first<{ payload_json: string; title: string }>();
    let lesson: Content['lesson']; try { lesson = JSON.parse(rev?.payload_json ?? '{}').lesson; } catch { lesson = undefined; }
    if (lesson === undefined) return c.json({ error: 'this setting cannot be read right now', reason: 'content_unavailable' }, 503);
    const okay = await settingAdmissible(c, run, { kind: 'setting', title: revision.title, body: '', links: [], lesson }); if (okay instanceof Response) return okay;
    settingLesson = lesson === 'base' ? { base: true, course_id: okay.pin.course_id } : lesson;
    impact = lessonImpact(okay.base.content, (okay.target ?? okay.base).content); settled = okay;
  }
  const seats = await seatsNow(db, run.class_run_id, now), chosen = req.targets.map((id) => seats.find((s) => s.seat_id === id));
  const unknown = req.targets.filter((_, i) => !chosen[i]);
  if (unknown.length) return c.json({ error: 'targets outside this run', reason: 'seat_not_found', seats: unknown.slice(0, 20) }, 404);
  const picked = chosen as SeatNow[];
  // The preview is a pure read. What a learner already holds is a PREDICTION here; it is decided for real at offer time.
  const held = ((await db.prepare("SELECT seat_id,student_id,revision,content_hash,device_registration_id FROM classroom_distribution_cards WHERE class_run_id=? AND object_id=? AND state='present'").bind(run.class_run_id, req.object_id).all()).results ?? []) as Array<{ seat_id: string; student_id: string; revision: number; content_hash: string; device_registration_id: string }>;
  const plan = picked.map((s) => {
    const [grant, device] = (s.conn ?? '|').split('|'), card = held.find((h) => h.seat_id === s.seat_id && h.student_id === s.student_id);
    let caps: unknown = null; try { caps = s.caps ? JSON.parse(s.caps) : null; } catch { caps = null; }
    const expect = card && card.revision > req.revision ? 'has_newer_revision' : !grant ? 'offline_until_reconnect' : !declaresKind(caps, revision.kind) ? 'unsupported_app' : card && card.device_registration_id === device && card.revision === req.revision && card.content_hash === req.content_hash ? 'already_held' : 'deliverable_now';
    return { seat_id: s.seat_id, student_id: s.student_id, expect };
  });
  // What changes FOR EACH SELECTED LEARNER, from the version that learner runs now — not only against the run's version. A
  // learner already on v2 who is sent the return loses v2's steps; "nothing changes" is true only for one who never left the base.
  // Grouped by the version they run now (a handful of groups, one lesson read each). Unknown stays unknown.
  let byCurrent: unknown = null;
  if (req.dry_run && isSetting && settled) {
    const pin = { course_id: settled.pin.course_id, version: settled.pin.version, sha256: settled.base.sha256 }, now_by_seat = await effectiveBySeat(db, pin, run.class_run_id);
    if (now_by_seat === 'unknown') byCurrent = 'unknown';
    else { const cohort = await lessonCohortOf(c.env, run.cohort_id), groups = new Map<string, { version: string; source: string; seats: string[] }>();
      for (const s of picked) { const e = now_by_seat.get(s.seat_id), version = e?.version ?? settled.pin.version, source = e?.source === 'setting' ? 'setting' : 'run'; const g = groups.get(version) ?? { version, source, seats: [] }; g.seats.push(s.seat_id); groups.set(version, g); }
      const out = []; for (const g of [...groups.values()].slice(0, 8)) { const from = g.version === settled.base.version ? settled.base : await readLesson(c.env, cohort, settled.pin.course_id, g.version, run.profile_id); out.push({ ...g, impact: from ? lessonImpact(from.content, (settled.target ?? settled.base).content) : null }); }
      byCurrent = out; }
  }
  if (req.dry_run) return c.json({ dry_run: true, object_id: req.object_id, revision: req.revision, content_hash: req.content_hash, kind: revision.kind, title: revision.title, latest_revision: revision.latest_revision, expires_at: expires, roster_revision: run.roster_revision, targets: plan, not_selected: seats.length - picked.length,
    // For a setting: what changes (against the run's pinned version) and when. A learner's running answer is never cut.
    ...(isSetting ? { setting: { lesson: settingLesson, impact, impact_basis: 'run_version', run_version: settled?.base.version ?? null, by_current: byCurrent, applies: 'next_question' } } : {}) }, 200);
  const count = await db.prepare('SELECT count(*) AS n,sum(CASE WHEN created_at>? THEN 1 ELSE 0 END) AS recent FROM classroom_distributions WHERE class_run_id=?').bind(now - 60_000, run.class_run_id).first<{ n: number; recent: number | null }>();
  if ((count?.n ?? 0) >= MAX_DISTRIBUTIONS_PER_RUN || (count?.recent ?? 0) >= MAX_DISTRIBUTIONS_PER_MINUTE) return c.json({ error: 'too many distributions for this run right now', reason: 'rate_limited' }, 429, { 'retry-after': '30' });

  // ── one conditional batch, five statements for 1 or 200 seats. The selection travels as ONE bound JSON value. ──
  const id = crypto.randomUUID(), targets = JSON.stringify(picked.map((s) => [s.seat_id, s.seat_revision, s.student_id]));
  const guard = `EXISTS (SELECT 1 FROM class_run_ops o WHERE o.class_run_id=? AND o.roster_revision=? AND json_extract(o.flags_json,'$.ops_distribute')=1 AND o.ends_at>? AND NOT EXISTS (SELECT 1 FROM sessions z WHERE z.id=o.class_run_id AND z.ended_at IS NOT NULL))
 AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM class_run_seats x WHERE x.class_run_id=? AND x.replaced_at IS NULL AND x.seat_id=json_extract(j.value,'$[0]') AND x.seat_revision=json_extract(j.value,'$[1]') AND x.student_id=json_extract(j.value,'$[2]')))
 AND EXISTS (SELECT 1 FROM classroom_content_revisions r JOIN classroom_content_objects ob ON ob.object_id=r.object_id WHERE r.object_id=? AND r.revision=? AND r.class_run_id=? AND r.content_hash=? AND ob.retired_at IS NULL)
 AND ${NOT_FENCED}${isSetting ? ` AND ${SETTINGS_ON}` : ''}`;
  const committed = 'EXISTS (SELECT 1 FROM classroom_distributions WHERE id=?)';
  const stmts = [
    db.prepare(`INSERT INTO classroom_distributions(id,class_run_id,cohort_id,object_id,revision,content_hash,seq,roster_revision,targets_json,request_hash,idempotency_key,expires_at,created_by,issuer_jti,created_at)
 SELECT ?,?,?,?,?,?,(SELECT event_seq+1 FROM classroom_content_objects WHERE object_id=?),?,?,?,?,?,?,?,? WHERE ${guard}`).bind(id, run.class_run_id, run.cohort_id, req.object_id, req.revision, req.content_hash, req.object_id, req.roster_revision, JSON.stringify(req.targets), requestHash, req.idempotency_key, expires, auth.payload.u, jti || null, now,
      run.class_run_id, req.roster_revision, now, targets, run.class_run_id, req.object_id, req.revision, run.class_run_id, req.content_hash, jti, ...(isSetting ? [run.class_run_id] : [])),
    // A learner who already has (or is already being sent) a NEWER revision of this object is not walked back to this one.
    db.prepare(`INSERT INTO classroom_distribution_targets(distribution_id,class_run_id,seat_id,seat_revision,student_id,object_id,revision,state,result_code,pending,updated_at)
 SELECT ?,?,json_extract(j.value,'$[0]'),json_extract(j.value,'$[1]'),json_extract(j.value,'$[2]'),?,?,
 CASE WHEN EXISTS (SELECT 1 FROM classroom_distribution_targets n JOIN classroom_distributions nd ON nd.id=n.distribution_id WHERE n.class_run_id=? AND n.student_id=json_extract(j.value,'$[2]') AND n.seat_id=json_extract(j.value,'$[0]') AND n.object_id=? AND n.revision>? AND nd.revoked_at IS NULL AND n.state IN ('accepted','offered','received','reflected','no_change')) THEN 'superseded' ELSE 'accepted' END,
 CASE WHEN EXISTS (SELECT 1 FROM classroom_distribution_targets n JOIN classroom_distributions nd ON nd.id=n.distribution_id WHERE n.class_run_id=? AND n.student_id=json_extract(j.value,'$[2]') AND n.seat_id=json_extract(j.value,'$[0]') AND n.object_id=? AND n.revision>? AND nd.revoked_at IS NULL AND n.state IN ('accepted','offered','received','reflected','no_change')) THEN 'newer_revision' ELSE '' END,
 CASE WHEN EXISTS (SELECT 1 FROM classroom_distribution_targets n JOIN classroom_distributions nd ON nd.id=n.distribution_id WHERE n.class_run_id=? AND n.student_id=json_extract(j.value,'$[2]') AND n.seat_id=json_extract(j.value,'$[0]') AND n.object_id=? AND n.revision>? AND nd.revoked_at IS NULL AND n.state IN ('accepted','offered','received','reflected','no_change')) THEN 0 ELSE 1 END,?
 FROM json_each(?) j WHERE ${committed}`).bind(id, run.class_run_id, req.object_id, req.revision, run.class_run_id, req.object_id, req.revision, run.class_run_id, req.object_id, req.revision, run.class_run_id, req.object_id, req.revision, now, targets, id),
    // …and an older revision still on its way to these learners stops: v2 after a late v1 must never become v1.
    db.prepare(`UPDATE classroom_distribution_targets SET state='superseded',result_code='newer_revision',pending=0,updated_at=? WHERE class_run_id=? AND object_id=? AND revision<? AND state IN ('accepted','offered','received')
 AND student_id IN (SELECT json_extract(value,'$[2]') FROM json_each(?)) AND ${committed}`).bind(now, run.class_run_id, req.object_id, req.revision, targets, id),
    db.prepare(`UPDATE classroom_content_objects SET event_seq=event_seq+1 WHERE object_id=? AND ${committed}`).bind(req.object_id, id),
    auditIf(db, run.class_run_id, auth.payload.u, 'distribution_created', { distribution_id: id, object_id: req.object_id, revision: req.revision, targets: req.targets.slice(0, 50), selected: req.targets.length, roster: seats.length, expires_at: expires }, now, committed, [id]),
  ];
  try { await db.batch(stmts); } catch (err) { const raced = await replay(); if (raced) return raced; console.error('distribution not recorded:', err); return c.json({ error: 'not recorded; nothing was sent', reason: 'storage' }, 503); }
  if (await db.prepare('SELECT 1 FROM classroom_distributions WHERE id=?').bind(id).first()) return c.json(await distributionView(db, run, id, now), 201);
  const raced = await replay(); if (raced) return raced;
  // The precondition did not hold at the commit: nothing at all was written. Say which part moved, from a fresh read.
  const no = await whyRefused(db, { ...run, roster_revision: req.roster_revision }, jti, now, async () => {
    const o = await db.prepare('SELECT retired_at FROM classroom_content_objects WHERE object_id=?').bind(req.object_id).first<{ retired_at: number | null }>();
    return o?.retired_at ? 'object_retired' : null;
  });
  return c.json({ error: 'the class run, a seat, the material or your authority changed while this was being recorded; nothing was sent — reload and select again', reason: no.reason, ...(no.roster_revision !== undefined ? { roster_revision: no.roster_revision } : {}) }, no.status);
});

async function distributionView(db: Db, run: Run, id: string, now: number) {
  const runEnded = ended(run, now);
  // Lazy settlement of THIS run of the distribution (primary-key prefix) and of the cards of its object. No timers anywhere.
  const head = await db.prepare('SELECT d.id,d.object_id,d.revision,d.content_hash,d.seq,d.roster_revision,d.targets_json,d.expires_at,d.created_by,d.created_at,d.revoked_at,d.revoked_by,d.revoke_reason,d.row_revision,o.kind FROM classroom_distributions d JOIN classroom_content_objects o ON o.object_id=d.object_id WHERE d.id=? AND d.class_run_id=?').bind(id, run.class_run_id).first<Record<string, any>>();
  if (!head) return null;
  await db.batch(settleStatements(db, { scope: 'distribution_id=?', args: [id], cardScope: 'class_run_id=? AND object_id=?', cardArgs: [run.class_run_id, head.object_id], runEnded, now }));
  const rows = ((await db.prepare(`SELECT t.seat_id,t.seat_revision,t.student_id,t.state,t.result_code,t.offers,t.device_registration_id,t.first_offered_at,t.received_at,t.reflected_at,t.updated_at,
 c.state AS card_state,c.revision AS card_revision,c.content_hash AS card_hash,c.device_registration_id AS card_device,
 (SELECT COALESCE(g.device_registration_id,'') FROM ops_grants g WHERE g.class_run_id=t.class_run_id AND g.seat_id=t.seat_id AND g.seat_revision=t.seat_revision AND g.kind='connection' AND g.state='active' AND g.expires_at>? ORDER BY g.created_at DESC LIMIT 1) AS device_now
 FROM classroom_distribution_targets t LEFT JOIN classroom_distribution_cards c ON c.class_run_id=t.class_run_id AND c.seat_id=t.seat_id AND c.student_id=t.student_id AND c.object_id=t.object_id
 WHERE t.distribution_id=? ORDER BY t.seat_id`).bind(now, id).all()).results ?? []) as Array<Record<string, any>>;
  const allowed = !runEnded && parseFlags(run.flags_json).ops_distribute, blocked = runEnded ? 'run_ended' : !parseFlags(run.flags_json).ops_distribute ? 'ops_distribute_disabled' : '';
  const targets = rows.map((r) => {
    // A card recorded for another device of this learner is not what the learner sees now, whatever the ledger row says.
    const elsewhere = r.card_state === 'present' && r.device_now !== null && r.device_now !== '' && r.card_device !== r.device_now;
    const card: CardFacts | null = r.card_state ? { state: elsewhere ? 'detached' : r.card_state, revision: r.card_revision, content_hash: r.card_hash } : null;
    const s = distStatus({ state: r.state, result_code: r.result_code, revision: head.revision, content_hash: head.content_hash, offers: r.offers, distribution_revoked: head.revoked_at !== null, connected: r.device_now !== null }, card, { new_request_allowed: allowed });
    return { seat_id: r.seat_id, seat_revision: r.seat_revision, student_id: r.student_id, state: r.state, result_code: r.result_code, offers: r.offers, first_offered_at: r.first_offered_at, received_at: r.received_at, reflected_at: r.reflected_at, updated_at: r.updated_at, status: s };
  });
  let selected: string[] = []; try { selected = JSON.parse(head.targets_json); } catch { selected = []; }
  const { targets_json, ...meta } = head;
  const view = { distribution: { ...meta, targets: selected, revoked: head.revoked_at !== null }, targets, summary: summarizeDistribution(targets.map((x) => x.status)), observed_at: now, new_request_allowed: allowed, new_request_blocked_by: blocked };
  if (head.kind !== 'setting') return view;
  // U3 — for a setting, "in the inbox" is only PREPARED. What happened next is the Service's own record: the binding row
  // this distribution switched the participant to, and the execution evidence on it. One row per target, read by the
  // unique (distribution, seat) index; the participant's newest sequence comes from the primary key. Unreadable = said so.
  let bindings: Array<Record<string, any>> | null = null;
  try { bindings = ((await db.prepare(`SELECT b.seat_id,b.binding_seq,b.binding_key,b.source,b.version,b.activated_at,b.first_dispatched_at,b.first_completed_at,b.last_failure_kind,b.last_failure_at,
 (SELECT MAX(n.binding_seq) FROM classroom_lesson_bindings n WHERE n.class_run_id=b.class_run_id AND n.student_id=b.student_id) AS latest_seq
 FROM classroom_distribution_targets t JOIN classroom_lesson_bindings b ON b.distribution_id=t.distribution_id AND b.seat_id=t.seat_id WHERE t.distribution_id=?`).bind(id).all()).results ?? []) as Array<Record<string, any>>; }
  catch (err) { console.error('setting results unreadable:', err); bindings = null; }
  const withSetting = targets.map((x) => {
    if (!bindings) return { ...x, setting: { phase: 'unknown' } };
    const b = bindings.find((r) => r.seat_id === x.seat_id) ?? null;
    const prepared = x.state === 'reflected' || x.state === 'no_change';
    return { ...x, setting: b ? { phase: settingPhase(b as any, { latestSeq: b.latest_seq ?? b.binding_seq, now }), binding_seq: b.binding_seq, version: b.version, source: b.source, activated_at: b.activated_at, first_dispatched_at: b.first_dispatched_at, first_completed_at: b.first_completed_at, last_failure_kind: b.last_failure_kind || null } : { phase: prepared ? 'prepared' : 'not_prepared' } };
  });
  const phases: Record<string, number> = {}; for (const x of withSetting) phases[x.setting.phase] = (phases[x.setting.phase] ?? 0) + 1;
  // `all_applied` never rounds up: prepared, switched, attempted and unknown are not applied.
  return { ...view, targets: withSetting, setting_summary: { by_phase: phases, applied: phases.applied ?? 0, all_applied: withSetting.length > 0 && (phases.applied ?? 0) === withSetting.length } };
}

classroomDistributionTeacher.get(root + '/distributions', async (c) => {
  const t = await teacher(c, false); if (t instanceof Response) return t; const { run } = t;
  const object = c.req.query('object_id'), before = Number(c.req.query('cursor') ?? '') || Number.MAX_SAFE_INTEGER;
  if (object !== undefined && !UUIDISH_RE.test(object)) return c.json({ error: 'object_id' }, 400);
  const rows = ((await c.env.HPS_DB.prepare(`SELECT id,object_id,revision,content_hash,seq,expires_at,created_by,created_at,revoked_at,revoke_reason,row_revision,json_array_length(targets_json) AS selected FROM classroom_distributions WHERE class_run_id=?${object ? ' AND object_id=?' : ''} AND created_at<? ORDER BY created_at DESC LIMIT ?`).bind(...[run.class_run_id, ...(object ? [object] : []), before, LIST_PAGE + 1]).all()).results ?? []) as Array<Record<string, any>>;
  return c.json({ distributions: rows.slice(0, LIST_PAGE), next_cursor: rows.length > LIST_PAGE ? rows[LIST_PAGE - 1]!.created_at : null });
});

classroomDistributionTeacher.get(root + '/distributions/:id', async (c) => {
  const t = await teacher(c, false); if (t instanceof Response) return t;
  if (!UUIDISH_RE.test(c.req.param('id')!)) return c.json({ error: 'distribution id' }, 400);
  let view; try { view = await distributionView(c.env.HPS_DB, t.run, c.req.param('id')!, Date.now()); }
  catch (err) { console.error('distribution view failed:', err); return c.json({ error: 'results cannot be read right now; nothing is assumed', reason: 'distribution_unavailable' }, 503, { 'retry-after': '30' }); }
  return view ? c.json(view) : c.json({ error: 'no such distribution in this run', reason: 'not_found' }, 404);
});

// Withdraw ONE run of a distribution. Learners who have not taken it stop being offered it. A learner who already holds
// it keeps the card only while ANOTHER run still permits the revision that card shows (coverage, settled in the same batch).
classroomDistributionTeacher.post(root + '/distributions/:id/revoke', async (c) => {
  const t = await teacher(c, false); if (t instanceof Response) return t; const { auth, run } = t, db = c.env.HPS_DB, now = Date.now(), id: string = c.req.param('id')!, b = await json(c);
  if (!UUIDISH_RE.test(id) || !b || Object.keys(b).some((k) => k !== 'expected_row_revision') || !Number.isSafeInteger(b.expected_row_revision)) return c.json({ error: 'expected_row_revision required' }, 400);
  const head = await db.prepare('SELECT object_id,revoked_at,row_revision FROM classroom_distributions WHERE id=? AND class_run_id=?').bind(id, run.class_run_id).first<{ object_id: string; revoked_at: number | null; row_revision: number }>();
  if (!head) return c.json({ error: 'no such distribution in this run', reason: 'not_found' }, 404);
  if (head.revoked_at !== null) return c.json({ ...(await distributionView(db, run, id, now)), replayed: true }, 200);
  const jti = auth.payload.jti ?? '', mine = 'EXISTS (SELECT 1 FROM classroom_distributions WHERE id=? AND revoked_at=? AND revoked_by=?)', mineArgs = [id, now, auth.payload.u];
  const stmts = [
    db.prepare(`UPDATE classroom_distributions SET revoked_at=?,revoked_by=?,revoke_reason='revoked',revoke_seq=(SELECT o.event_seq+1 FROM classroom_content_objects o WHERE o.object_id=classroom_distributions.object_id),row_revision=row_revision+1 WHERE id=? AND class_run_id=? AND revoked_at IS NULL AND row_revision=? AND ${NOT_FENCED}`).bind(now, auth.payload.u, id, run.class_run_id, b.expected_row_revision, jti),
    db.prepare(`UPDATE classroom_content_objects SET event_seq=event_seq+1 WHERE object_id=? AND ${mine}`).bind(head.object_id, ...mineArgs),
    db.prepare(`UPDATE classroom_distribution_targets SET state='revoked',result_code='revoked',pending=0,updated_at=? WHERE distribution_id=? AND state IN ('accepted','offered','received') AND ${mine}`).bind(now, id, ...mineArgs),
    ...coverageStatements(db, 'class_run_id=? AND object_id=?', [run.class_run_id, head.object_id], now),
    auditIf(db, run.class_run_id, auth.payload.u, 'distribution_revoked', { distribution_id: id, object_id: head.object_id }, now, mine, mineArgs),
  ];
  let res; try { res = await db.batch(stmts); } catch (err) { console.error('distribution revoke failed:', err); return c.json({ error: 'not withdrawn; nothing changed', reason: 'storage' }, 503); }
  if ((res[0] as any)?.meta?.changes !== 1) { const no = await whyRefused(db, run, jti, now, async () => 'revision_conflict'); return c.json({ error: 'not withdrawn: it changed meanwhile or your token was revoked — reload', reason: ['issuer_revoked'].includes(no.reason) ? no.reason : 'revision_conflict' }, no.reason === 'issuer_revoked' ? 403 : 409); }
  return c.json(await distributionView(db, run, id, now), 200);
});

// Retire the MATERIAL: every run of every revision of it is withdrawn, every card of it comes down, and nothing of it can
// be authored or distributed again. Coverage is not consulted — that is the difference from withdrawing one run.
classroomDistributionTeacher.post(root + '/contents/:object/retire', async (c) => {
  const t = await teacher(c, false); if (t instanceof Response) return t; const { auth, run } = t, db = c.env.HPS_DB, now = Date.now(), object = c.req.param('object')!, b = await json(c);
  if (!UUIDISH_RE.test(object) || !b || Object.keys(b).some((k) => k !== 'expected_latest_revision') || !Number.isSafeInteger(b.expected_latest_revision)) return c.json({ error: 'expected_latest_revision required' }, 400);
  const head = await db.prepare('SELECT retired_at,latest_revision,kind FROM classroom_content_objects WHERE object_id=? AND class_run_id=?').bind(object, run.class_run_id).first<{ retired_at: number | null; latest_revision: number; kind: string }>();
  if (!head) return c.json({ error: 'no such material in this run', reason: 'not_found' }, 404);
  // Retiring forbids every later revision, and a run has ONE setting object: retiring it would end settings for the run.
  // Stopping a setting = withdrawing its distribution; going back = sending the explicit return.
  if (head.kind === 'setting') return c.json({ error: 'a setting is not retired: withdraw its distribution, or send the return to the base lesson', reason: 'setting_not_retirable' }, 409);
  if (head.retired_at !== null) return c.json({ object_id: object, retired: true, retired_at: head.retired_at, replayed: true }, 200);
  const jti = auth.payload.jti ?? '', mine = 'EXISTS (SELECT 1 FROM classroom_content_objects WHERE object_id=? AND retired_at=? AND retired_by=?)', mineArgs = [object, now, auth.payload.u];
  const stmts = [
    db.prepare(`UPDATE classroom_content_objects SET retired_at=?,retired_by=?,retire_seq=event_seq+1,event_seq=event_seq+1 WHERE object_id=? AND class_run_id=? AND retired_at IS NULL AND latest_revision=? AND ${NOT_FENCED}`).bind(now, auth.payload.u, object, run.class_run_id, b.expected_latest_revision, jti),
    db.prepare(`UPDATE classroom_distribution_targets SET state='revoked',result_code='retired',pending=0,updated_at=? WHERE class_run_id=? AND object_id=? AND state IN ('accepted','offered','received') AND ${mine}`).bind(now, run.class_run_id, object, ...mineArgs),
    db.prepare(`UPDATE classroom_distributions SET revoked_at=?,revoked_by=?,revoke_reason='retired',revoke_seq=(SELECT o.event_seq FROM classroom_content_objects o WHERE o.object_id=classroom_distributions.object_id),row_revision=row_revision+1 WHERE class_run_id=? AND object_id=? AND revoked_at IS NULL AND ${mine}`).bind(now, auth.payload.u, run.class_run_id, object, ...mineArgs),
    ...coverageStatements(db, 'class_run_id=? AND object_id=?', [run.class_run_id, object], now),
    auditIf(db, run.class_run_id, auth.payload.u, 'distribution_content_retired', { object_id: object }, now, mine, mineArgs),
  ];
  let res; try { res = await db.batch(stmts); } catch (err) { console.error('distribution retire failed:', err); return c.json({ error: 'not withdrawn; nothing changed', reason: 'storage' }, 503); }
  if ((res[0] as any)?.meta?.changes !== 1) { const no = await whyRefused(db, run, jti, now, async () => 'revision_conflict'); return c.json({ error: 'not withdrawn: the material changed meanwhile or your token was revoked — reload', reason: no.reason === 'issuer_revoked' ? no.reason : 'revision_conflict' }, no.reason === 'issuer_revoked' ? 403 : 409); }
  return c.json({ object_id: object, retired: true, retired_at: now }, 200);
});
