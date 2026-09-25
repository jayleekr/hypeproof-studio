// Remote classroom operations (#751, U3) — the SWITCH: a learner's device, at the start of its next turn, asks the Service to
// record that this participant now runs the lesson version a setting distribution named. One conditional batch.
// Contract: docs/requirements/classroom-admin.md#remote-management-u3-20260921.
//
//  - The INSERT carries every precondition itself; the answer is built from the row that is stored afterwards, never from
//    "the batch succeeded" (the U2 re-acceptance defect: a batch succeeds while its guarded statement changed nothing).
//  - Append-only: the next binding_seq of (run, student). The primary key is the compare-and-swap.
//  - Nothing here changes the run's pinned lesson, the cohort module pin or anybody's token, and an in-flight turn is not
//    touched: it keeps the snapshot it was admitted with.
import type { Env } from '../env';
import { readLesson } from './lesson-delivery';
import { readOpening } from './cohort-binding';
import { deliveryKey, offerKeyInput, sha256Hex, OFFER_KEY_RE } from './classroom-distribution';
import { bindingKeyInput } from './lesson-binding';
import { bindingsEnforced } from './lesson-binding-store';
import { parseLesson } from './classroom-ops';
import { verify } from './tokens';
import { isTokenRevoked } from './kv';

type Db = Env['HPS_DB'];
const KEY_RE = /^[A-Za-z0-9-]{8,64}$/, SHA_RE = /^[a-f0-9]{64}$/;
export interface ActivateGrant { id: string; class_run_id: string; cohort_id: string; profile_id: string; seat_id: string; seat_revision: number; student_id: string; connection_epoch: number; device_registration_id: string | null; flags_json: string; lesson_json: string }
/**
 * `learner_token` is the learner's own signed token. The lesson a switch starts FROM decides where the binding applies, so it
 * is taken from that token after the Service verified it — never from a value the device merely states. `base_lesson_sha256`
 * is optional and only cross-checked: a device that decodes its token differently is refused, not believed.
 */
export interface ActivateRequest { app_instance_id: string; offer_key: string; distribution_id: string; object_id: string; revision: number; content_hash: string; base_lesson_sha256: string | null; learner_token: string | null }

export function normalizeActivate(raw: unknown): ActivateRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>, allowed = ['app_instance_id', 'boot_id', 'offer_key', 'distribution_id', 'object_id', 'revision', 'content_hash', 'base_lesson_sha256', 'learner_token'];
  if (Object.keys(o).some((k) => !allowed.includes(k))) return null;
  if (typeof o.app_instance_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(o.app_instance_id) || typeof o.offer_key !== 'string' || !OFFER_KEY_RE.test(o.offer_key) || typeof o.distribution_id !== 'string' || !KEY_RE.test(o.distribution_id) || typeof o.object_id !== 'string' || !KEY_RE.test(o.object_id)) return null;
  if (!Number.isSafeInteger(o.revision) || (o.revision as number) < 1 || typeof o.content_hash !== 'string' || !SHA_RE.test(o.content_hash)) return null;
  if (o.base_lesson_sha256 !== undefined && (typeof o.base_lesson_sha256 !== 'string' || !SHA_RE.test(o.base_lesson_sha256))) return null;
  if (o.learner_token !== undefined && (typeof o.learner_token !== 'string' || o.learner_token.length > 4096 || !/^[A-Za-z0-9_.-]+$/.test(o.learner_token))) return null;
  return { app_instance_id: o.app_instance_id, offer_key: o.offer_key, distribution_id: o.distribution_id, object_id: o.object_id, revision: o.revision as number, content_hash: o.content_hash, base_lesson_sha256: (o.base_lesson_sha256 as string | undefined) ?? null, learner_token: (o.learner_token as string | undefined) ?? null };
}

/**
 * The lesson this switch starts from, established by the Service: the learner's token is verified (signature, expiry,
 * revocation), it must be THIS grant's learner in THIS cohort, and it must pin a lesson of the run's course. Nothing of the
 * token is logged or stored — only the lesson hash it pins.
 */
async function verifiedBase(env: Env, g: ActivateGrant, req: ActivateRequest, course: string): Promise<{ sha256: string } | { reason: string }> {
  if (!req.learner_token) return { reason: 'learner_token_required' };
  let p: Awaited<ReturnType<typeof verify>>;
  try { p = await verify(req.learner_token, env.HPS_SIGNING_SECRET); } catch { return { reason: 'learner_token_invalid' }; }
  if ((p as any).role === 'issuer' || p.u !== g.student_id || p.c !== g.cohort_id) return { reason: 'learner_token_mismatch' };
  try { if (p.jti && await isTokenRevoked(env.HPS_KV, p.jti)) return { reason: 'learner_token_invalid' }; } catch { return { reason: 'storage' }; }
  const l = p.lesson;
  if (!l || typeof l.sha256 !== 'string' || !SHA_RE.test(l.sha256) || l.course_id !== course) return { reason: 'learner_token_lesson' };
  if (req.base_lesson_sha256 !== null && req.base_lesson_sha256 !== l.sha256) return { reason: 'base_mismatch' };
  return { sha256: l.sha256 };
}

const VIEW = 'binding_key AS key,binding_seq AS seq,source,object_id,revision,course_id,version,lesson_sha256,activated_at';
type View = { key: string; seq: number; source: string; object_id: string; revision: number; course_id: string; version: string; lesson_sha256: string; activated_at: number };
export type Activated = { recorded: true; replayed: boolean; binding: View } | { recorded: false; reason: string; final: boolean; status: 200 | 409 | 503 };

/** Test seam, same purpose as lesson-binding-store's: hold the request between its reads and its conditional INSERT. */
export const activateHooks: { beforeCommit?: () => Promise<void> } = {};

export async function activateBinding(env: Env, g: ActivateGrant, req: ActivateRequest, now: number): Promise<Activated> {
  const db = env.HPS_DB, no = (reason: string, final = true, status: 200 | 409 | 503 = 200): Activated => ({ recorded: false, reason, final, status });
  if (!bindingsEnforced(env)) return no('not_enforced', false, 503);
  const pin = parseLesson(g.lesson_json);
  if (!pin?.course_id) return no('lesson_unavailable');
  const base = await verifiedBase(env, g, req, pin.course_id);
  if ('reason' in base) return base.reason === 'storage' ? no('storage', false, 503) : no(base.reason, true, 409);
  let t: Record<string, any> | null, latest: (View & { seat_id: string; seat_revision: number; content_hash: string }) | null, mine: View | null;
  try {
    const r = await db.batch([
      db.prepare(`SELECT t.state,t.offer_key,t.device_generation,t.seat_revision,t.student_id,t.object_id,t.revision,d.content_hash,d.revoked_at,d.expires_at,ob.kind,ob.retired_at,rv.payload_json
 FROM classroom_distribution_targets t JOIN classroom_distributions d ON d.id=t.distribution_id JOIN classroom_content_objects ob ON ob.object_id=t.object_id JOIN classroom_content_revisions rv ON rv.object_id=t.object_id AND rv.revision=t.revision
 WHERE t.distribution_id=? AND t.class_run_id=? AND t.seat_id=?`).bind(req.distribution_id, g.class_run_id, g.seat_id),
      db.prepare(`SELECT ${VIEW},seat_id,seat_revision,content_hash FROM classroom_lesson_bindings WHERE class_run_id=? AND student_id=? ORDER BY binding_seq DESC LIMIT 1`).bind(g.class_run_id, g.student_id),
      // A replay is an answer to the SAME participant about the SAME offer: run, learner, seat revision and content all have to
      // be the caller's. The previous holder of this seat has a row under (distribution, seat) too — that one is not "mine".
      db.prepare(`SELECT ${VIEW} FROM classroom_lesson_bindings WHERE distribution_id=? AND seat_id=? AND class_run_id=? AND student_id=? AND seat_revision=? AND object_id=? AND revision=? AND content_hash=?`).bind(req.distribution_id, g.seat_id, g.class_run_id, g.student_id, g.seat_revision, req.object_id, req.revision, req.content_hash),
    ]) as Array<{ results?: any[] }>;
    t = r[0]?.results?.[0] ?? null; latest = r[1]?.results?.[0] ?? null; mine = r[2]?.results?.[0] ?? null;
  } catch (err) { console.error('lesson binding switch: state unreadable, nothing recorded:', err); return no('storage', false, 503); }
  // A lost answer, a restart, a re-paired device: the row this distribution already made for this seat is the answer.
  if (mine) return { recorded: true, replayed: true, binding: mine };
  if (!t || t.kind !== 'setting' || t.object_id !== req.object_id || t.revision !== req.revision || t.content_hash !== req.content_hash || t.student_id !== g.student_id || t.seat_revision !== g.seat_revision) return no(t && (t.student_id !== g.student_id || t.seat_revision !== g.seat_revision) ? 'target_changed' : 'stale_offer');
  // The key is re-derived from the connection THIS request came in on: a key minted under an earlier login generation is stale.
  const current = await deliveryKey(offerKeyInput({ distribution_id: req.distribution_id, seat_id: g.seat_id, device_generation: t.device_generation, grant_id: g.id, connection_epoch: g.connection_epoch, object_id: t.object_id, revision: t.revision, content_hash: t.content_hash }));
  if (req.offer_key !== current || t.offer_key !== current) return no('stale_offer');
  if (latest && latest.object_id === req.object_id && latest.revision === req.revision && latest.content_hash === req.content_hash && latest.seat_id === g.seat_id && latest.seat_revision === g.seat_revision) { const { seat_id: _s, seat_revision: _r, content_hash: _h, ...view } = latest; return { recorded: true, replayed: true, binding: view }; }
  let lessonRef: any; try { lessonRef = JSON.parse(t.payload_json).lesson; } catch { lessonRef = undefined; }
  if (lessonRef === undefined) return no('lesson_unavailable');
  // The version must resolve NOW (frozen row + compiled policy — neither changes within a request, so this is not part of the race).
  let row: { source: 'setting' | 'base'; course_id: string; version: string; sha256: string; steps: string[]; runtime: string };
  if (lessonRef === 'base') row = { source: 'base', course_id: pin.course_id, version: '', sha256: base.sha256, steps: [], runtime: '' };
  else {
    let cohort = g.cohort_id; try { cohort = (await readOpening(env, g.cohort_id))?.template_cohort ?? g.cohort_id; } catch { cohort = g.cohort_id; }
    const lesson = await readLesson(env, cohort, lessonRef.course_id, lessonRef.version, g.profile_id);
    if (!lesson || lesson.sha256 !== lessonRef.sha256 || lesson.course_id !== pin.course_id) return no('lesson_unavailable');
    row = { source: 'setting', course_id: lesson.course_id, version: lesson.version, sha256: lesson.sha256, steps: lesson.content.steps.map((s) => s.id), runtime: lesson.content.model?.binding?.runtime ?? '' };
  }
  // The sequence number is taken INSIDE the INSERT (the participant's highest + 1): the device does not have to know it, and
  // two switches that race are ordered by the database — a primary-key collision is the loser.
  const key = (await sha256Hex(bindingKeyInput({ class_run_id: g.class_run_id, seat_id: g.seat_id, seat_revision: g.seat_revision, student_id: g.student_id, source: row.source, distribution_id: req.distribution_id, object_id: req.object_id, revision: req.revision, course_id: row.course_id, version: row.version, lesson_sha256: row.sha256 }))).slice(0, 32);
  if (activateHooks.beforeCommit) await activateHooks.beforeCommit();
  const made = 'EXISTS (SELECT 1 FROM classroom_lesson_bindings WHERE class_run_id=? AND student_id=? AND binding_key=? AND activated_at=?)', madeArgs = [g.class_run_id, g.student_id, key, now];
  try {
    const r = await db.batch([
      db.prepare(`INSERT INTO classroom_lesson_bindings(class_run_id,student_id,binding_seq,seat_id,seat_revision,binding_key,source,distribution_id,object_id,revision,content_hash,course_id,version,lesson_sha256,base_lesson_sha256,steps_json,runtime,grant_id,connection_epoch,device_registration_id,app_instance_id,activated_at)
 SELECT ?,?,COALESCE((SELECT MAX(b0.binding_seq) FROM classroom_lesson_bindings b0 WHERE b0.class_run_id=? AND b0.student_id=?),0)+1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
 WHERE EXISTS (SELECT 1 FROM classroom_distribution_targets t JOIN classroom_distributions d ON d.id=t.distribution_id JOIN classroom_content_objects ob ON ob.object_id=t.object_id
   WHERE t.distribution_id=? AND t.seat_id=? AND t.seat_revision=? AND t.student_id=? AND t.state='reflected' AND t.offer_key=? AND t.device_generation=?
   AND d.revoked_at IS NULL AND d.expires_at>? AND ob.kind='setting' AND ob.retired_at IS NULL)
 AND EXISTS (SELECT 1 FROM class_run_ops r WHERE r.class_run_id=? AND json_extract(r.flags_json,'$.ops_lesson_settings')=1 AND json_extract(r.flags_json,'$.ops_distribute')=1 AND r.ends_at>? AND NOT EXISTS (SELECT 1 FROM sessions z WHERE z.id=r.class_run_id AND z.ended_at IS NOT NULL))
 AND EXISTS (SELECT 1 FROM class_run_seats x WHERE x.class_run_id=? AND x.seat_id=? AND x.seat_revision=? AND x.student_id=? AND x.replaced_at IS NULL)
 AND EXISTS (SELECT 1 FROM ops_grants gg WHERE gg.id=? AND gg.kind='connection' AND gg.state='active' AND gg.connection_epoch=? AND gg.expires_at>?)
 AND EXISTS (SELECT 1 FROM ops_seat_leases l WHERE l.grant_id=? AND l.app_instance_id=?)
 AND NOT EXISTS (SELECT 1 FROM classroom_distribution_targets n JOIN classroom_distributions nd ON nd.id=n.distribution_id WHERE n.class_run_id=? AND n.student_id=? AND n.object_id=? AND n.revision>? AND nd.revoked_at IS NULL AND n.state IN ('accepted','offered','received','reflected','no_change'))
 ON CONFLICT DO NOTHING`).bind(
        g.class_run_id, g.student_id, g.class_run_id, g.student_id, g.seat_id, g.seat_revision, key, row.source, req.distribution_id, req.object_id, req.revision, req.content_hash, row.course_id, row.version, row.sha256, base.sha256, JSON.stringify(row.steps), row.runtime, g.id, g.connection_epoch, g.device_registration_id ?? '', req.app_instance_id, now,
        req.distribution_id, g.seat_id, g.seat_revision, g.student_id, current, t.device_generation, now,
        g.class_run_id, now,
        g.class_run_id, g.seat_id, g.seat_revision, g.student_id,
        g.id, g.connection_epoch, now,
        g.id, req.app_instance_id,
        g.class_run_id, g.student_id, req.object_id, req.revision),
      db.prepare(`INSERT INTO ops_audit(class_run_id,seat_id,actor_kind,actor_id,action,detail_json,at) SELECT ?,?,'device',?,'lesson_binding_switched',?,? WHERE ${made}`).bind(g.class_run_id, g.seat_id, g.device_registration_id || g.id, JSON.stringify({ distribution_id: req.distribution_id, object_id: req.object_id, revision: req.revision, binding_key: key, source: row.source, version: row.version }), now, ...madeArgs),
      db.prepare(`SELECT ${VIEW} FROM classroom_lesson_bindings WHERE class_run_id=? AND student_id=? AND binding_key=? AND activated_at=?`).bind(...madeArgs),
      db.prepare(`SELECT ${VIEW} FROM classroom_lesson_bindings WHERE distribution_id=? AND seat_id=? AND class_run_id=? AND student_id=? AND seat_revision=?`).bind(req.distribution_id, g.seat_id, g.class_run_id, g.student_id, g.seat_revision),
    ]) as Array<{ meta?: { changes?: number }; results?: View[] }>;
    // Only the row this statement actually wrote counts. A successful batch whose INSERT changed nothing recorded nothing.
    const stored = r[2]?.results?.[0];
    if ((r[0]?.meta?.changes ?? 0) === 1 && stored) return { recorded: true, replayed: false, binding: stored };
    // Lost to a sibling request of the SAME switch (a second window, a retry in flight): the row it stored is the answer.
    const sibling = r[3]?.results?.[0]; if (sibling) return { recorded: true, replayed: true, binding: sibling };
  } catch (err) { console.error('lesson binding switch not recorded:', err); return no('storage', false, 503); }
  const reason = await whyNot(db, g, req, now);
  // `changed` = lost the compare-and-swap: not final, the device reads the state as it is now and asks again at its next turn.
  return no(reason, reason !== 'changed', 409);
}

/** Read AFTER a commit that wrote nothing, only to name the part that moved. Never used to decide a write. */
async function whyNot(db: Db, g: ActivateGrant, req: ActivateRequest, now: number): Promise<string> {
  try {
    const s = await db.prepare(`SELECT t.state,d.revoked_at,d.expires_at,json_extract(r.flags_json,'$.ops_lesson_settings') AS on1,json_extract(r.flags_json,'$.ops_distribute') AS on2,r.ends_at,z.ended_at,
 (SELECT 1 FROM class_run_seats x WHERE x.class_run_id=t.class_run_id AND x.seat_id=t.seat_id AND x.seat_revision=t.seat_revision AND x.student_id=t.student_id AND x.replaced_at IS NULL) AS seat_live,
 (SELECT 1 FROM ops_grants gg WHERE gg.id=? AND gg.state='active' AND gg.connection_epoch=? AND gg.expires_at>?) AS grant_ok,
 (SELECT 1 FROM ops_seat_leases l WHERE l.grant_id=? AND l.app_instance_id=?) AS owner,
 (SELECT MAX(b.binding_seq) FROM classroom_lesson_bindings b WHERE b.class_run_id=t.class_run_id AND b.student_id=t.student_id) AS seq
 FROM classroom_distribution_targets t JOIN classroom_distributions d ON d.id=t.distribution_id JOIN class_run_ops r ON r.class_run_id=t.class_run_id LEFT JOIN sessions z ON z.id=t.class_run_id
 WHERE t.distribution_id=? AND t.seat_id=?`).bind(g.id, g.connection_epoch, now, g.id, req.app_instance_id, req.distribution_id, g.seat_id).first<Record<string, any>>();
    if (!s) return 'stale_offer';
    if (s.ended_at || now > s.ends_at) return 'run_ended';
    if (!s.on1 || !s.on2) return 'disabled';
    if (!s.seat_live) return 'target_changed';
    if (!s.grant_ok) return 'stale_offer';
    if (!s.owner) return 'not_owner';
    if (s.revoked_at !== null) return 'revoked';
    if (s.expires_at <= now) return 'expired';
    if (s.state === 'superseded') return 'superseded';
    return s.state === 'reflected' ? 'superseded' : 'stale_offer';
  } catch { return 'changed'; }
}
