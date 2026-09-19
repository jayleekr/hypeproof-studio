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
for (const path of [root, root + "/models/:profile", root + "/features/:profile", root + "/versions/:version", root + '/versions/:version/participants']) {
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
  const { token } = await issue({ u: b.user, c: cohort, p: d.profile_id, lesson: ref }, b.hours, c.env.HPS_SIGNING_SECRET);
  return c.json({ token, lesson: ref, user: b.user, expires_at: Math.floor(Date.now() / 1000) + b.hours * 3600, session_ends_at: session.ends_at, rehearsal: await readRehearsal(c.env.HPS_DB, cohort, course, lesson.version) });
});

/**
 * 이 버전에 대해 서버가 아는 리허설 상태. 증거 행이 없으면 `not_run` 이다.
 *
 * **저장된 사실만 돌려준다.** 예전에는 네 군데가 각각 `'not_run'` 이라는 상수를
 * 실어 보냈고, 실제로 리허설을 돌려도 응답은 똑같았다 — 화면이 아니라 서버가
 * 거짓말을 하고 있었다(#1012, RUN-01·VER-02).
 *
 * **VER-02 는 여기서 코드로 지켜지는 게 아니라 스키마 모양으로 성립한다.** 증거는
 * (cohort, course, version) 에 매달리고 확정된 버전은 불변이므로, 내용이 바뀌면
 * 그것은 새 버전이고 새 버전에는 증거 행이 없다 → 자동으로 `not_run`. 무효화를
 * 수행하는 코드가 없다는 것이 이 설계의 요점이다.
 *
 * 테이블이 없을 때(마이그레이션 전)는 `not_run` 으로 떨어진다. 배포는
 * 마이그레이션을 먼저 적용하므로 정상 경로에서는 일어나지 않지만, 만약 일어난다면
 * **수업 중 저작 API 전체가 500 이 되는 것보다 "증거 없음" 이 낫다** — 그리고
 * 그것은 오보가 아니라 사실이다(증거가 실제로 없다). 이 방향은
 * authoring-rehearsal.test.mjs 가 테이블을 지우고 고정한다.
 */
async function readRehearsal(db: D1Database, cohort: string, course: string, version: string): Promise<string> {
  try {
    const row = await db.prepare(
      "SELECT status FROM authoring_version_rehearsals WHERE cohort_id=? AND course_id=? AND version=?",
    ).bind(cohort, course, version).first<{ status: string }>();
    return row?.status ?? 'not_run';
  } catch {
    return 'not_run';
  }
}

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
    return c.json({ module: JSON.parse(existing.module_json), source_revision: existing.source_revision, rehearsal: await readRehearsal(c.env.HPS_DB, cohort, course, version), activated: false });
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
  // 방금 만든 버전이므로 증거 행이 있을 수 없다 — 그래도 상수로 쓰지 않고 같은
  // 경로로 읽는다. 상수를 하나라도 남기면 그 자리가 다음에 또 거짓말을 한다.
  return c.json({ module: JSON.parse(saved.module_json), source_revision: saved.source_revision, rehearsal: await readRehearsal(c.env.HPS_DB, cohort, course, version), activated: false, pedagogy });
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
  return c.json({ module, source_revision: v.source_revision, rehearsal: await readRehearsal(c.env.HPS_DB, d.cohort_id, d.course_id, c.req.param("version")!), activated: false });
});
