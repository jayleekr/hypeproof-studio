// Instructor authoring API. Service owns writes; Chalk forwards the same HTTP contract.
import { FEATURE_LABELS, permittedFeatureKeys, validateFeatureSubset, featureBinding } from '../lib/lesson-feature-policy';
import { validateModelSubset, modelBinding, servedModelSelection } from '../lib/lesson-model-policy';
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../env";
import { authorizeIssuerForCohort, type IssuerAuthz } from "../lib/instructor-auth";
import { getProfile } from "../profiles";
import { isModuleVersion, makeModuleDoc, sha256Hex } from "../lib/modules";
import { validateSessionDesign } from "../lib/session-design";
import { checkLessonPedagogy, blockingPedagogyFindings } from "../lib/lesson-pedagogy";
import { readLesson } from '../lib/lesson-delivery';
import { issue } from '../lib/tokens';
import { getRoster, getActiveSession } from '../lib/kv';
import { recordTokenIssue } from './classroom-ops';
import { lessonImpact } from '../lib/lesson-binding';
import { policyDigest, REHEARSAL_HOURS, AUTHORABLE_STEP_UI } from '../lib/lesson-rehearsal';
import { confirmationOf, confirmationRequired, currentDigest, latestRehearsal, readinessOf, rehearsalHistory, versionUsable } from '../lib/lesson-rehearsal-store';

type Bindings = { Bindings: Env; Variables: { author: IssuerAuthz } };
interface Draft { cohort_id: string; course_id: string; owner_id: string; profile_id: string; revision: number; content_json: string; request_id: string; request_hash: string; updated_at: string; independent?: number }
interface Version { source_revision: number; module_json: string }
const root = "/cohorts/:cohort/authoring/:course";
const validId = (s: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(s);
// #1006 IC-01 — an empty profile_id is a draft whose execution template is not
// chosen yet. It saves and reopens, but cannot freeze or open; the reason is explicit.
// #1006 IC-02 — the single admission rule shared by save and new freeze. An independent
// course (persisted marker) may use only a profile that is currently a reviewed execution
// template; losing the flag blocks further binding and new versions, never prior versions.
const reviewedTemplate = (id: string) => getProfile(id)?.execution_template === true;
const templateAdmission = (independent: boolean, profileId: string) =>
  independent && profileId !== '' && !reviewedTemplate(profileId) ? 'template_not_reviewed' : null;
const openingBlockedBy = (d: Draft) => !d.profile_id ? ['template_required'] : templateAdmission(!!d.independent, d.profile_id) ? ['template_not_reviewed'] : [];
const draftView = (d: Draft) => ({ course_id: d.course_id, profile_id: d.profile_id || null, independent: !!d.independent, revision: d.revision, content: JSON.parse(d.content_json), updated_at: d.updated_at, opening_blocked_by: openingBlockedBy(d) });
const TEMPLATE_REQUIRED = { error: 'select an execution template first', reason: 'template_required' };
const TEMPLATE_NOT_REVIEWED = { error: 'independent course requires a reviewed execution template', reason: 'template_not_reviewed' };
export const authoring = new Hono<Bindings>();

const authenticate: MiddlewareHandler<Bindings> = async (c, next) => {
  // Explicit issuer identity even if the enclosing admin middleware admits Basic/Access.
  const auth = await authorizeIssuerForCohort(c, c.req.param("cohort")! ?? "");
  if (auth instanceof Response) return auth;
  if (!auth) return c.json({ error: "instructor Bearer required" }, 401);
  c.set("author", auth);
  c.header("cache-control", "no-store");
  if (!validId(c.req.param("course")! ?? "")) return c.json({ error: "invalid course id" }, 400);
  return next();
};
for (const path of [root, root + "/models/:profile", root + "/features/:profile", root + "/versions/:version", root + '/versions/:version/participants', root + '/versions', root + '/impact', root + '/versions/:version/readiness', root + '/versions/:version/rehearsals', root + '/versions/:version/confirmation']) {
  authoring.use(path, authenticate);
  authoring.use(path, bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: "request too large" }, 413) }));
}

authoring.get(root + '/models/:profile', c => {
  const profile = getProfile(c.req.param('profile')!);
  if (!profile || profile.session.cohort_id !== c.req.param('cohort') || !c.get('author').scope.profiles.includes(profile.id))
    return c.json({ error: 'profile not permitted' }, 403);
  try { const selection=servedModelSelection(c.env,profile); if (!selection) throw new Error('unconfigured'); return c.json({ ...selection, effort: profile.model.effort, default: profile.model.default }); }
  catch { return c.json({ error: 'model provider is not configured' }, 409); }
});

// #748 — 이 코호트가 실제로 가진 기능. 강사는 여기서 **줄이기만** 한다.
// 별도 저장소가 아니라 컴파일된 프로필에서 파생하므로, 프로필이 바뀌면 다음
// 호출부터 목록이 따라 움직인다 — 강사 화면이 이미 없는 기능을 계속 보여주는
// 상태가 생기지 않는다.
authoring.get(root + '/features/:profile', c => {
  const profile = getProfile(c.req.param('profile')!);
  if (!profile || profile.session.cohort_id !== c.req.param('cohort') || !c.get('author').scope.profiles.includes(profile.id))
    return c.json({ error: 'profile not permitted' }, 403);
  const catalogue = permittedFeatureKeys(profile);
  return c.json({ choices: catalogue.map(key => ({ key, label: FEATURE_LABELS[key] })) });
});

// Explicit delivery to an already registered student; never opens/replaces a session.
authoring.post(root + '/versions/:version/participants', async c => {
  const a = c.get('author'), cohort = c.req.param('cohort')!, course = c.req.param('course')!;
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b.user !== 'string' || !validId(b.user) || b.user.length > 64 || !Number.isInteger(b.hours) || b.hours < 1 || b.hours > 24)
    return c.json({ error: 'student ID and hours (1–24) required' }, 400);
  if (b.hours > (a.scope.max_hours ?? 24) || Date.now() / 1000 + b.hours * 3600 > a.payload.exp)
    return c.json({ error: 'duration exceeds instructor authorization' }, 403);
  const d = await readDraft(c.env.HPS_DB, cohort, course);
  if (!d || !owns(d, a)) return c.json({ error: 'course not found' }, 404);
  if (!d.profile_id) return c.json(TEMPLATE_REQUIRED, 409);
  const lesson = await readLesson(c.env, cohort, course, c.req.param('version')!, d.profile_id);
  if (!lesson) return c.json({ error: 'valid frozen version required' }, 409);
  const session = await getActiveSession(c.env.HPS_KV, cohort);
  if (!session || session.profile_id !== d.profile_id || !Number.isFinite(Date.parse(session.starts_at)) || !Number.isFinite(Date.parse(session.ends_at)) || Date.parse(session.starts_at) > Date.now() || Date.parse(session.ends_at) <= Date.now())
    return c.json({ error: 'open a matching practice session first' }, 403);
  const roster = await getRoster(c.env.HPS_KV, cohort);
  if (!roster?.users.includes(b.user)) return c.json({ error: 'register this student in the session console first' }, 403);
  const ref = { course_id: course, version: lesson.version, sha256: lesson.sha256 };
  // #1012 · #751 G2 — where confirmation is required, only a version the instructor confirmed on a passed rehearsal reaches learners.
  const which = { cohort, course, version: lesson.version, profileId: d.profile_id, lessonSha: lesson.sha256, content: lesson.content };
  if (!(await versionUsable(c.env, which))) return c.json({ error: 'confirm this version after a passed learner-condition rehearsal first', reason: 'version_not_confirmed' }, 409);
  const { token, jti } = await issue({ u: b.user, c: cohort, p: d.profile_id, lesson: ref }, b.hours, c.env.HPS_SIGNING_SECRET);
  // Lesson-bound invitations are token issuance too: mirror the normal mint
  // ledger and reissue fence without letting an ops outage block the lesson.
  const opsIssue = await recordTokenIssue(c.env, { jti, cohort, student: b.user, profile: d.profile_id, issuedBy: a.payload.u, hours: b.hours });
  return c.json({ token, lesson: ref, user: b.user, expires_at: Math.floor(Date.now() / 1000) + b.hours * 3600, session_ends_at: session.ends_at, rehearsal: (await readinessOf(c.env, which)).state, ...(opsIssue ? { ops: opsIssue } : {}) });
});

async function readDraft(db: D1Database, cohort: string, course: string) {
  return db.prepare(`SELECT d.*, EXISTS(SELECT 1 FROM authoring_independent_courses m WHERE m.cohort_id=d.cohort_id AND m.course_id=d.course_id) AS independent
    FROM authoring_drafts d WHERE d.cohort_id=? AND d.course_id=?`).bind(cohort, course).first<Draft>();
}
function owns(d: Draft, a: IssuerAuthz) {
  return d.owner_id === a.payload.u && (d.profile_id === '' || a.scope.profiles.includes(d.profile_id));
}

authoring.get(root, async (c) => {
  const d = await readDraft(c.env.HPS_DB, c.req.param("cohort")!, c.req.param("course")!);
  if (!d || !owns(d, c.get("author"))) return c.json({ error: "course not found" }, 404);
  return c.json(draftView(d));
});

authoring.put(root, async (c) => {
  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
  if (!b || !Number.isSafeInteger(b.expected_revision) || b.expected_revision < 0 || typeof b.request_id !== "string" || !validId(b.request_id) || typeof b.profile_id !== "string") return c.json({ error: "expected_revision, request_id and profile_id required" }, 400);
  const invalid = validateSessionDesign(b.content);
  if (invalid) return c.json({ error: invalid }, 400);
  const cohort = c.req.param("cohort")!, course = c.req.param("course")!, a = c.get("author");
  const prior = await readDraft(c.env.HPS_DB, cohort, course);
  if (prior && !owns(prior, a)) return c.json({ error: "course not found" }, 404);
  // #1006 IC-02 — independence is decided once, at creation (no template, or a reviewed
  // template), and persisted; it is never re-derived from a flag that can later change.
  // Courses created on a customer profile have no marker and keep their existing contract.
  const independent = prior ? !!prior.independent : b.profile_id === '' || reviewedTemplate(b.profile_id);
  if (b.profile_id === '') {
    // Model/feature narrowing is relative to a template's grants; without one there is nothing to narrow.
    if (b.content.model || b.content.features) return c.json(TEMPLATE_REQUIRED, 400);
  } else {
  const profile = getProfile(b.profile_id);
  if (!profile || profile.session.cohort_id !== cohort || !a.scope.profiles.includes(b.profile_id)) return c.json({ error: "profile not permitted" }, 403);
  if (templateAdmission(independent, profile.id)) return c.json(TEMPLATE_NOT_REVIEWED, 403);
  if (b.content.model) {
    if (b.content.model.binding) return c.json({ error: 'model binding is produced by the Service at freeze' }, 400);
    const bad = validateModelSubset(b.content.model, profile);
    if (bad) return c.json({ error: bad }, 403);
  }
  if (b.content.features) {
    if (b.content.features.binding) return c.json({ error: 'feature binding is produced by the Service at freeze' }, 400);
    const bad = validateFeatureSubset(b.content.features, profile);
    if (bad) return c.json({ error: bad }, 403);
  }
  }
  const content = JSON.stringify(b.content);
  const hash = await sha256Hex(JSON.stringify([b.expected_revision, b.profile_id, b.content]));
  if (prior && prior.request_id === b.request_id) {
    if (prior.request_hash !== hash) return c.json({ error: "request id reused with different content" }, 409);
    return c.json(draftView(prior));
  }
  const now = new Date().toISOString();
  let d: Draft | null;
  if (b.expected_revision === 0) {
    const insert = c.env.HPS_DB.prepare(`INSERT INTO authoring_drafts (cohort_id,course_id,owner_id,profile_id,revision,content_json,request_id,request_hash,updated_at)
        VALUES (?,?,?,?,1,?,?,?,?) ON CONFLICT(cohort_id,course_id) DO NOTHING RETURNING *`)
        .bind(cohort,course,a.payload.u,b.profile_id,content,b.request_id,hash,now);
    if (independent) {
      // Draft and marker commit together (D1 batch is transactional); the marker SELECT only
      // matches the row this request created, so a lost create race never marks another course.
      await c.env.HPS_DB.batch([insert, c.env.HPS_DB.prepare(`INSERT INTO authoring_independent_courses (cohort_id,course_id)
          SELECT cohort_id,course_id FROM authoring_drafts WHERE cohort_id=? AND course_id=? AND owner_id=? AND request_id=? AND request_hash=? AND revision=1
          ON CONFLICT(cohort_id,course_id) DO NOTHING`).bind(cohort,course,a.payload.u,b.request_id,hash)]);
      const created = await readDraft(c.env.HPS_DB, cohort, course);
      d = created && created.independent && created.revision === 1 && created.request_id === b.request_id && created.request_hash === hash ? created : null;
    } else d = await insert.first<Draft>();
  } else {
    d = await c.env.HPS_DB.prepare(`UPDATE authoring_drafts SET profile_id=?,revision=revision+1,content_json=?,request_id=?,request_hash=?,updated_at=?
        WHERE cohort_id=? AND course_id=? AND owner_id=? AND revision=? RETURNING *`)
        .bind(b.profile_id,content,b.request_id,hash,now,cohort,course,a.payload.u,b.expected_revision).first<Draft>();
  }
  if (d) return c.json(draftView({ ...d, independent: independent ? 1 : 0 }));
  // Concurrent retry may have won the conditional write after our first read.
  const latest = await readDraft(c.env.HPS_DB, cohort, course);
  if (latest && owns(latest,a) && latest.request_id === b.request_id && latest.request_hash === hash) return c.json(draftView(latest));
  return c.json({ error: "revision conflict; reload before saving" }, 409);
});

authoring.put(root + "/versions/:version", async (c) => {
  const cohort = c.req.param("cohort")!, course = c.req.param("course")!, version = c.req.param("version")!, a = c.get("author");
  if (!isModuleVersion(version)) return c.json({ error: "invalid module version" }, 400);
  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
  if (!b || !Number.isSafeInteger(b.expected_revision) || b.expected_revision < 1) return c.json({ error: "expected_revision required" }, 400);
  const d = await readDraft(c.env.HPS_DB,cohort,course);
  if (!d || !owns(d,a)) return c.json({ error: "course not found" }, 404);
  const existing = await c.env.HPS_DB.prepare("SELECT source_revision,module_json FROM authoring_versions WHERE cohort_id=? AND course_id=? AND version=?").bind(cohort,course,version).first<Version>();
  if (existing) {
    if (!a.scope.profiles.includes(JSON.parse(existing.module_json).profile_id)) return c.json({ error: "profile not permitted" }, 403);
    if (existing.source_revision !== b.expected_revision) return c.json({ error: "version already frozen" }, 409);
    return c.json({ module: JSON.parse(existing.module_json), source_revision: existing.source_revision, rehearsal: await stateOf(c.env, cohort, course, version, existing.module_json), activated: false });
  }
  if (d.revision !== b.expected_revision) return c.json({ error: "revision conflict" }, 409);
  if (!d.profile_id) return c.json(TEMPLATE_REQUIRED, 409);
  // Same admission as save. Runs after the `existing` branch above, so already frozen
  // versions stay readable/idempotent; only a NEW version needs a still-reviewed template.
  if (templateAdmission(!!d.independent, d.profile_id)) return c.json(TEMPLATE_NOT_REVIEWED, 403);
  const content = JSON.parse(d.content_json);
  const invalid = validateSessionDesign(content,true);
  if (invalid) return c.json({ error: invalid }, 400);
  // 교육 원칙 관문 v0. 형태 검증(위)을 통과한 뒤 설계를 본다. fail이 하나라도 있으면
  // 확정을 막고 판정 목록 전체를 돌려준다 — 강사가 무엇을 채우면 열리는지 알아야 하므로
  // 막은 항목만이 아니라 warn·skip까지 함께 보낸다. warn만 있으면 확정은 진행되고
  // 같은 목록이 성공 응답에 실린다. 400/403/409와 겹치지 않도록 422를 쓴다.
  const pedagogy = checkLessonPedagogy(content);
  if (blockingPedagogyFindings(pedagogy).length)
    return c.json({ error: '수업 설계가 교육 원칙 검사를 통과하지 못했습니다', reason: 'pedagogy_blocked', findings: pedagogy }, 422);
  if (content.model) {
    const profile = getProfile(d.profile_id);
    if (!profile || validateModelSubset(content.model, profile)) return c.json({ error: 'model is not permitted by the cohort' }, 403);
    try { content.model.binding = modelBinding(c.env, profile, content.model); }
    catch { return c.json({ error: 'model provider is not configured' }, 409); }
  }
  if (content.features) {
    const profile = getProfile(d.profile_id);
    if (!profile || validateFeatureSubset(content.features, profile)) return c.json({ error: 'feature is not permitted by the cohort' }, 403);
    content.features.binding = featureBinding(profile, content.features);
  }
  const module = await makeModuleDoc({ kind: "session-design", profileId: d.profile_id, version, content });
  // INSERT SELECT checks the revision at the write, not merely at the earlier read.
  await c.env.HPS_DB.prepare(`INSERT INTO authoring_versions (cohort_id,course_id,version,source_revision,module_json)
    SELECT cohort_id,course_id,?,revision,? FROM authoring_drafts WHERE cohort_id=? AND course_id=? AND owner_id=? AND revision=?
    ON CONFLICT(cohort_id,course_id,version) DO NOTHING`)
    .bind(version,JSON.stringify(module),cohort,course,a.payload.u,b.expected_revision).run();
  const saved = await c.env.HPS_DB.prepare("SELECT source_revision,module_json FROM authoring_versions WHERE cohort_id=? AND course_id=? AND version=?").bind(cohort,course,version).first<Version>();
  if (!saved || saved.source_revision !== b.expected_revision) return c.json({ error: "revision or version conflict" }, 409);
  // 확정은 됐지만 남은 판정이 있으면 함께 보낸다. 비어 있지 않은 목록은 전부 warn/skip이다
  // (fail이 있었다면 위에서 422로 끝났다). 확정을 성공으로 보고하면서 미확인을 숨기지 않는다.
  return c.json({ module: JSON.parse(saved.module_json), source_revision: saved.source_revision, rehearsal: "not_run", activated: false, pedagogy });
});

authoring.get(root + "/versions/:version", async (c) => {
  const d = await readDraft(c.env.HPS_DB,c.req.param("cohort")!,c.req.param("course")!);
  if (!d || !owns(d,c.get("author"))) return c.json({ error: "course not found" }, 404);
  const v = await c.env.HPS_DB.prepare("SELECT source_revision,module_json FROM authoring_versions WHERE cohort_id=? AND course_id=? AND version=?")
    .bind(d.cohort_id,d.course_id,c.req.param("version")!).first<Version>();
  if (!v) return c.json({ error: "version not found" }, 404);
  // A subsequent profile change must not expose a version outside current scope.
  const module = JSON.parse(v.module_json);
  if (!c.get("author").scope.profiles.includes(module.profile_id)) return c.json({ error: "profile not permitted" }, 403);
  return c.json({ module, source_revision: v.source_revision, rehearsal: await stateOf(c.env, d.cohort_id, d.course_id, c.req.param("version")!, v.module_json), activated: false });
});

// ── #1012 · #751 G2 — reuse, review, learner-condition rehearsal and confirmation of one frozen candidate ──────────
// Contract: docs/requirements/chalk-authoring.md#g2-curriculum-runtime-20260922. A frozen version is the candidate; it is
// never edited. Its readiness is keyed by (version, sha256): a draft saved while a rehearsal runs is not that candidate.

async function versionRow(db: D1Database, cohort: string, course: string, version: string) {
  return db.prepare('SELECT source_revision,module_json FROM authoring_versions WHERE cohort_id=? AND course_id=? AND version=?').bind(cohort, course, version).first<Version>();
}
/** The rehearsal state of a stored version, from its own bytes (an unreadable/invalid version has none). */
async function stateOf(env: Env, cohort: string, course: string, version: string, moduleJson: string) {
  const m = JSON.parse(moduleJson);
  const lesson = await readLesson(env, cohort, course, version, m.profile_id);
  if (!lesson) return 'not_run';
  return (await readinessOf(env, { cohort, course, version, profileId: m.profile_id, lessonSha: lesson.sha256, content: lesson.content })).state;
}
/** Service-produced bindings are stripped: a reused version's content is an ordinary draft body again. */
const reusable = (content: any) => { const x = structuredClone(content); if (x.model) delete x.model.binding; if (x.features) delete x.features.binding; return x; };
const MAX_VERSIONS = 20;

// The course's frozen versions, newest first, each with what a teacher needs to pick one: title, readiness, confirmation.
authoring.get(root + '/versions', async (c) => {
  const cohort = c.req.param('cohort')!, course = c.req.param('course')!, a = c.get('author');
  const d = await readDraft(c.env.HPS_DB, cohort, course);
  if (!d || !owns(d, a)) return c.json({ error: 'course not found' }, 404);
  const rows = (await c.env.HPS_DB.prepare('SELECT version,source_revision,module_json FROM authoring_versions WHERE cohort_id=? AND course_id=? ORDER BY source_revision DESC, version DESC LIMIT ?').bind(cohort, course, MAX_VERSIONS + 1).all<{ version: string; source_revision: number; module_json: string }>()).results ?? [];
  const versions = [];
  for (const r of rows.slice(0, MAX_VERSIONS)) {
    const m = JSON.parse(r.module_json);
    if (!a.scope.profiles.includes(m.profile_id)) continue;
    const lesson = await readLesson(c.env, cohort, course, r.version, m.profile_id);
    const ready = lesson ? await readinessOf(c.env, { cohort, course, version: r.version, profileId: m.profile_id, lessonSha: lesson.sha256, content: lesson.content }) : null;
    versions.push({ version: r.version, source_revision: r.source_revision, title: m.content?.title ?? '', mission: m.content?.learning ? { week: m.content.learning.week, mission: m.content.learning.mission } : null, lesson_sha256: lesson?.sha256 ?? null, readable: !!lesson,
      rehearsal: ready?.state ?? 'not_run', confirmed: !!ready?.confirmed, confirmation_current: !!ready?.confirmation_current, steps: (m.content?.steps ?? []).map((s: any) => ({ id: s.id, title: s.title })) });
  }
  return c.json({ draft_revision: d.revision, versions, truncated: rows.length > MAX_VERSIONS, confirmation_required: confirmationRequired(c.env), authorable_step_ui: AUTHORABLE_STEP_UI });
});

// One frozen version's content, ready to be reused as a draft body (bindings stripped). Only the course owner reads it.
authoring.get(root + '/versions/:version/readiness', async (c) => {
  const cohort = c.req.param('cohort')!, course = c.req.param('course')!, version = c.req.param('version')!, a = c.get('author');
  const d = await readDraft(c.env.HPS_DB, cohort, course);
  if (!d || !owns(d, a)) return c.json({ error: 'course not found' }, 404);
  const row = await versionRow(c.env.HPS_DB, cohort, course, version);
  if (!row) return c.json({ error: 'version not found' }, 404);
  const m = JSON.parse(row.module_json);
  if (!a.scope.profiles.includes(m.profile_id)) return c.json({ error: 'profile not permitted' }, 403);
  const lesson = await readLesson(c.env, cohort, course, version, m.profile_id);
  if (!lesson) return c.json({ error: 'this version cannot be opened under the current profile', reason: 'lesson_unavailable', version, source_revision: row.source_revision }, 409);
  const ready = await readinessOf(c.env, { cohort, course, version, profileId: m.profile_id, lessonSha: lesson.sha256, content: lesson.content });
  const history = (await rehearsalHistory(c.env.HPS_DB, cohort, course, version)).map((h) => ({ id: h.rehearsal_id, learner_id: h.learner_id, created_at: h.created_at, expires_at: h.expires_at, verdict: h.verdict, judged_at: h.judged_at, current: h.lesson_sha256 === lesson.sha256 }));
  return c.json({ version, lesson_sha256: lesson.sha256, source_revision: row.source_revision, draft_revision: d.revision, draft_changed_since: d.revision !== row.source_revision,
    profile_id: m.profile_id, ...ready, history, confirmation_required: confirmationRequired(c.env), content: reusable(lesson.content) });
});

// Concrete differences between two frozen versions, or a frozen version and the current draft (`to=draft`). Computed here,
// never typed by the teacher. Read-only.
authoring.get(root + '/impact', async (c) => {
  const cohort = c.req.param('cohort')!, course = c.req.param('course')!, a = c.get('author');
  const d = await readDraft(c.env.HPS_DB, cohort, course);
  if (!d || !owns(d, a)) return c.json({ error: 'course not found' }, 404);
  const side = async (v: string | undefined) => {
    if (v === 'draft') return { label: 'draft', revision: d.revision, content: JSON.parse(d.content_json) };
    if (!v || !isModuleVersion(v)) return null;
    const row = await versionRow(c.env.HPS_DB, cohort, course, v);
    if (!row) return null;
    const m = JSON.parse(row.module_json);
    return a.scope.profiles.includes(m.profile_id) ? { label: v, revision: row.source_revision, content: m.content } : null;
  };
  const from = await side(c.req.query('from')), to = await side(c.req.query('to'));
  if (!from || !to) return c.json({ error: 'from and to must name a frozen version of this course (or to=draft)' }, 400);
  return c.json({ from: { version: from.label, revision: from.revision }, to: { version: to.label, revision: to.revision }, impact: lessonImpact(from.content, to.content) });
});

// A learner-condition rehearsal code for exactly this candidate. The learner ID must already be on the roster of an open
// matching session — the SAME admission as a real invitation, so the rehearsal runs under the learner's own gate, never an
// instructor credential. Issuing it is not readiness: the version stays `running` until the Service judges a report.
authoring.post(root + '/versions/:version/rehearsals', async (c) => {
  const a = c.get('author'), cohort = c.req.param('cohort')!, course = c.req.param('course')!, version = c.req.param('version')!;
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b.learner !== 'string' || !validId(b.learner) || b.learner.length > 64 || typeof b.request_id !== 'string' || !validId(b.request_id))
    return c.json({ error: 'rehearsal learner ID and request_id required' }, 400);
  // The code lives at most REHEARSAL_HOURS and never beyond the instructor's own authorization.
  const hours = Math.min(REHEARSAL_HOURS, a.scope.max_hours ?? 24, Math.floor(a.payload.exp - Date.now() / 1000) / 3600);
  if (!(hours >= 0.25)) return c.json({ error: 'the instructor authorization ends too soon for a rehearsal', reason: 'authorization_too_short' }, 403);
  const d = await readDraft(c.env.HPS_DB, cohort, course);
  if (!d || !owns(d, a)) return c.json({ error: 'course not found' }, 404);
  if (!d.profile_id) return c.json(TEMPLATE_REQUIRED, 409);
  const lesson = await readLesson(c.env, cohort, course, version, d.profile_id);
  const profile = getProfile(d.profile_id);
  if (!lesson || !profile) return c.json({ error: 'valid frozen version required', reason: 'lesson_unavailable' }, 409);
  const session = await getActiveSession(c.env.HPS_KV, cohort);
  if (!session || session.profile_id !== d.profile_id || Date.parse(session.starts_at) > Date.now() || Date.parse(session.ends_at) <= Date.now())
    return c.json({ error: 'open a matching practice session first', reason: 'session_not_open' }, 403);
  const roster = await getRoster(c.env.HPS_KV, cohort);
  if (!roster?.users.includes(b.learner)) return c.json({ error: 'register the rehearsal learner ID in the session console first', reason: 'learner_not_in_roster' }, 403);
  const ref = { course_id: course, version: lesson.version, sha256: lesson.sha256 };
  const prior = await c.env.HPS_DB.prepare('SELECT * FROM authoring_rehearsals WHERE cohort_id=? AND course_id=? AND request_id=?').bind(cohort, course, b.request_id).first<any>();
  if (prior) {
    // A retried request (lost response) gets a fresh signature for the SAME rehearsal and jti; a reused id elsewhere is refused.
    if (prior.version !== version || prior.learner_id !== b.learner || prior.created_by !== a.payload.u) return c.json({ error: 'request id reused with different content' }, 409);
    const { token } = await issue({ u: prior.learner_id, c: cohort, p: prior.profile_id, lesson: ref, rehearsal: prior.rehearsal_id }, Math.max(0, prior.expires_at - Date.now()) / 3600_000, c.env.HPS_SIGNING_SECRET, { jti: prior.token_jti });
    return c.json({ token, rehearsal_id: prior.rehearsal_id, lesson: ref, learner: prior.learner_id, expires_at: prior.expires_at, state: 'running' });
  }
  const rid = 'rh-' + crypto.randomUUID(), jti = crypto.randomUUID(), now = Date.now(), expires = now + Math.floor(hours * 3600) * 1000;
  const digest = await policyDigest(profile, lesson.content);
  const made = await c.env.HPS_DB.prepare(`INSERT INTO authoring_rehearsals(rehearsal_id,cohort_id,course_id,version,lesson_sha256,source_revision,profile_id,learner_id,token_jti,policy_digest,created_by,created_at,expires_at,request_id)
 SELECT ?,?,?,?,?,v.source_revision,?,?,?,?,?,?,?,? FROM authoring_versions v WHERE v.cohort_id=? AND v.course_id=? AND v.version=? ON CONFLICT DO NOTHING`)
    .bind(rid, cohort, course, version, lesson.sha256, d.profile_id, b.learner, jti, digest, a.payload.u, now, expires, b.request_id, cohort, course, version).run() as { meta?: { changes?: number } };
  if ((made.meta?.changes ?? 0) !== 1) return c.json({ error: 'rehearsal could not be recorded; nothing was issued' }, 409);
  const { token } = await issue({ u: b.learner, c: cohort, p: d.profile_id, lesson: ref, rehearsal: rid }, Math.floor(hours * 3600) / 3600, c.env.HPS_SIGNING_SECRET, { jti });
  await recordTokenIssue(c.env, { jti, cohort, student: b.learner, profile: d.profile_id, issuedBy: a.payload.u, hours: Math.max(1, Math.ceil(hours)) });
  return c.json({ token, rehearsal_id: rid, lesson: ref, learner: b.learner, expires_at: expires, state: 'running' });
});

// The teacher's deliberate confirmation of THIS candidate on its latest, passed, still-current rehearsal. Written once.
authoring.post(root + '/versions/:version/confirmation', async (c) => {
  const a = c.get('author'), cohort = c.req.param('cohort')!, course = c.req.param('course')!, version = c.req.param('version')!;
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b.rehearsal_id !== 'string' || !/^rh-[a-f0-9-]{36}$/.test(b.rehearsal_id) || typeof b.request_id !== 'string' || !validId(b.request_id))
    return c.json({ error: 'rehearsal_id and request_id required' }, 400);
  const d = await readDraft(c.env.HPS_DB, cohort, course);
  if (!d || !owns(d, a)) return c.json({ error: 'course not found' }, 404);
  const row = await versionRow(c.env.HPS_DB, cohort, course, version);
  if (!row) return c.json({ error: 'version not found' }, 404);
  const m = JSON.parse(row.module_json);
  if (!a.scope.profiles.includes(m.profile_id)) return c.json({ error: 'profile not permitted' }, 403);
  const lesson = await readLesson(c.env, cohort, course, version, m.profile_id);
  if (!lesson) return c.json({ error: 'this version cannot be opened under the current profile', reason: 'lesson_unavailable' }, 409);
  const existing = await confirmationOf(c.env.HPS_DB, cohort, course, version);
  if (existing) return existing.rehearsal_id === b.rehearsal_id ? c.json({ version, confirmed: { at: existing.confirmed_at, by: existing.confirmed_by, rehearsal_id: existing.rehearsal_id } })
    : c.json({ error: 'this version is already confirmed on another rehearsal', reason: 'already_confirmed' }, 409);
  const latest = await latestRehearsal(c.env.HPS_DB, cohort, course, version);
  const digest = await currentDigest(m.profile_id, lesson.content);
  const why = !latest || latest.rehearsal_id !== b.rehearsal_id ? 'rehearsal_not_latest' : latest.lesson_sha256 !== lesson.sha256 ? 'rehearsal_other_candidate'
    : latest.verdict !== 'passed' ? 'rehearsal_not_passed' : digest === null || latest.policy_digest !== digest ? 'rehearsal_stale' : '';
  if (why) return c.json({ error: 'only the latest passed, current rehearsal of this exact version can be confirmed', reason: why }, 409);
  await c.env.HPS_DB.prepare(`INSERT INTO authoring_confirmations(cohort_id,course_id,version,lesson_sha256,rehearsal_id,policy_digest,confirmed_by,confirmed_at,request_id)
 SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM authoring_rehearsals r WHERE r.rehearsal_id=? AND r.verdict='passed' AND r.lesson_sha256=? AND r.policy_digest=?) ON CONFLICT DO NOTHING`)
    .bind(cohort, course, version, lesson.sha256, b.rehearsal_id, digest, a.payload.u, Date.now(), b.request_id, b.rehearsal_id, lesson.sha256, digest).run();
  const saved = await confirmationOf(c.env.HPS_DB, cohort, course, version);
  if (!saved || saved.rehearsal_id !== b.rehearsal_id) return c.json({ error: 'confirmation conflict; reload' }, 409);
  return c.json({ version, confirmed: { at: saved.confirmed_at, by: saved.confirmed_by, rehearsal_id: saved.rehearsal_id } });
});
