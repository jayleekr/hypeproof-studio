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
import { readLesson } from '../lib/lesson-delivery';
import { issue } from '../lib/tokens';
import { getRoster, getActiveSession } from '../lib/kv';

type Bindings = { Bindings: Env; Variables: { author: IssuerAuthz } };
interface Draft { cohort_id: string; course_id: string; owner_id: string; profile_id: string; revision: number; content_json: string; request_id: string; request_hash: string; updated_at: string }
interface Version { source_revision: number; module_json: string }
const root = "/cohorts/:cohort/authoring/:course";
const validId = (s: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(s);
const draftView = (d: Draft) => ({ course_id: d.course_id, profile_id: d.profile_id, revision: d.revision, content: JSON.parse(d.content_json), updated_at: d.updated_at });
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
  const lesson = await readLesson(c.env, cohort, course, c.req.param('version')!, d.profile_id);
  if (!lesson) return c.json({ error: 'valid frozen version required' }, 409);
  const session = await getActiveSession(c.env.HPS_KV, cohort);
  if (!session || session.profile_id !== d.profile_id || !Number.isFinite(Date.parse(session.starts_at)) || !Number.isFinite(Date.parse(session.ends_at)) || Date.parse(session.starts_at) > Date.now() || Date.parse(session.ends_at) <= Date.now())
    return c.json({ error: 'open a matching practice session first' }, 403);
  const roster = await getRoster(c.env.HPS_KV, cohort);
  if (!roster?.users.includes(b.user)) return c.json({ error: 'register this student in the session console first' }, 403);
  const ref = { course_id: course, version: lesson.version, sha256: lesson.sha256 };
  const { token } = await issue({ u: b.user, c: cohort, p: d.profile_id, lesson: ref }, b.hours, c.env.HPS_SIGNING_SECRET);
  return c.json({ token, lesson: ref, user: b.user, expires_at: Math.floor(Date.now() / 1000) + b.hours * 3600, session_ends_at: session.ends_at, rehearsal: 'not_run' });
});

async function readDraft(db: D1Database, cohort: string, course: string) {
  return db.prepare("SELECT * FROM authoring_drafts WHERE cohort_id=? AND course_id=?").bind(cohort, course).first<Draft>();
}
function owns(d: Draft, a: IssuerAuthz) {
  return d.owner_id === a.payload.u && a.scope.profiles.includes(d.profile_id);
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
  const profile = getProfile(b.profile_id);
  if (!profile || profile.session.cohort_id !== cohort || !a.scope.profiles.includes(b.profile_id)) return c.json({ error: "profile not permitted" }, 403);
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
  const content = JSON.stringify(b.content);
  const hash = await sha256Hex(JSON.stringify([b.expected_revision, b.profile_id, b.content]));
  const prior = await readDraft(c.env.HPS_DB, cohort, course);
  if (prior && !owns(prior, a)) return c.json({ error: "course not found" }, 404);
  if (prior && prior.request_id === b.request_id) {
    if (prior.request_hash !== hash) return c.json({ error: "request id reused with different content" }, 409);
    return c.json(draftView(prior));
  }
  const now = new Date().toISOString();
  const d = b.expected_revision === 0
    ? await c.env.HPS_DB.prepare(`INSERT INTO authoring_drafts (cohort_id,course_id,owner_id,profile_id,revision,content_json,request_id,request_hash,updated_at)
        VALUES (?,?,?,?,1,?,?,?,?) ON CONFLICT(cohort_id,course_id) DO NOTHING RETURNING *`)
        .bind(cohort,course,a.payload.u,b.profile_id,content,b.request_id,hash,now).first<Draft>()
    : await c.env.HPS_DB.prepare(`UPDATE authoring_drafts SET profile_id=?,revision=revision+1,content_json=?,request_id=?,request_hash=?,updated_at=?
        WHERE cohort_id=? AND course_id=? AND owner_id=? AND revision=? RETURNING *`)
        .bind(b.profile_id,content,b.request_id,hash,now,cohort,course,a.payload.u,b.expected_revision).first<Draft>();
  if (d) return c.json(draftView(d));
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
    return c.json({ module: JSON.parse(existing.module_json), source_revision: existing.source_revision, rehearsal: "not_run", activated: false });
  }
  if (d.revision !== b.expected_revision) return c.json({ error: "revision conflict" }, 409);
  const content = JSON.parse(d.content_json);
  const invalid = validateSessionDesign(content,true);
  if (invalid) return c.json({ error: invalid }, 400);
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
  return c.json({ module: JSON.parse(saved.module_json), source_revision: saved.source_revision, rehearsal: "not_run", activated: false });
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
  return c.json({ module, source_revision: v.source_revision, rehearsal: "not_run", activated: false });
});
