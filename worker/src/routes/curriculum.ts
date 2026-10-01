// Publish for User Test — the student routes (cr-publish #1393; recon §6, R4, R5; CR-17–CR-22,
// CR-39, CR-73). Mounted at /v1/curriculum.
//
// Every route sits behind the CR switch `curriculum_runtime.enabled` (recon R3): until the
// caller's served profile is known to have it on, every answer is exactly what an unknown
// route answers (`app.notFound` in src/index.ts: 404 `not_found` "endpoint not found"), a
// missing or unreadable token included, so the switch-off Service reveals nothing.
//
// Every target (project, version, experiment, link) is resolved to its Project before
// anything is read or written, and served only to a member of it (R5 "Ownership"): the
// token's cohort is the Project's and its student is in `members`. Anyone else, and any id
// that does not exist, gets the same 404 and nothing is recorded.

import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { bearer, verify, type TokenPayload } from "../lib/tokens";
import { getRoster, isTokenRevoked } from "../lib/kv";
import { resolveProfile } from "../lib/modules";
import { profileServesCohort } from "../lib/cohort-binding";
import { curriculumRuntimeAllowed } from "../lib/moderation";
import { makeErrorBody } from "../middleware/request-id";
import { digestOf } from "../lib/measurement-core/local-record";
import {
  CHANNEL_MAX,
  LINK_ID,
  isVentureId,
  linkState,
  newVentureId,
  normalizeChannel,
  publishPathProblem,
  validateExperimentContract,
  validateHypothesisStatement,
  type Experiment,
  type Project,
  type TestLink,
} from "../lib/curriculum/venture";
import {
  channelCounts,
  countExperiments,
  countLinks,
  createExperiment,
  createHypothesis,
  createLink,
  createProject,
  deleteHypothesis,
  experimentsOf,
  getExperiment,
  getHypothesis,
  getLink,
  getProject,
  getVersion,
  hypothesesOf,
  isMember,
  linksOf,
  projectsOf,
  putVersion,
  revokeLink,
  setMembers,
  versionsOf,
} from "../lib/curriculum/store";
import { hypeproofTokensIn, judgeToken, scanFile, type ScanHit } from "../lib/curriculum/publish-scan";
import { originFor, parseTestOrigin, shareUrl } from "../lib/curriculum/test-origin";
import { ensureExperimentTask, participantRecord, type R2Like } from "../lib/curriculum/participant-record";

type Ctx = Context<{ Bindings: Env; Variables: { requestId: string } }>;

/** Policy values (R4 "values are policy"). */
export const PUBLISH_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxSetBytes: 20 * 1024 * 1024,
  /** A link's expiry is chosen by the student; this only bounds it. */
  maxLinkLifetimeMs: 90 * 24 * 3600_000,
  /** Participant sessions one link may open (each one fixed-size session key on R2). */
  maxSessionsPerLink: 5000,
  /** Experiments one Project may start (each one fixed-size record task, written outside the review quota). */
  maxExperimentsPerProject: 200,
  /** Links one experiment may issue; with `maxSessionsPerLink` this bounds an experiment's session keys. */
  maxLinksPerExperiment: 20,
} as const;

/** Exactly what an unknown route answers (src/index.ts `app.notFound`). */
export const unknownRoute = (c: Ctx) => c.json(makeErrorBody(c, "not_found", "endpoint not found", { path: c.req.path }), 404);
const refuse = (c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 503, code: string, extra: Record<string, unknown> = {}) =>
  c.json({ error: { type: "curriculum", code, ...extra } }, status);

/** R2 key of one published file; the version digest names the directory (content-addressed). */
export const testFileKey = (versionId: string, path: string) => `test-versions/${versionId.replace(/^sha256:/, "")}/${path}`;

type Student = { payload: TokenPayload };

/**
 * The caller as a student of a switch-on profile, or the unknown-route answer. After the
 * switch is known to be on, ordinary auth answers apply (revoked, roster, cohort).
 */
async function student(c: Ctx): Promise<Student | Response> {
  const raw = bearer(c.req.header("authorization"));
  if (!raw) return unknownRoute(c);
  let payload: TokenPayload;
  try {
    payload = await verify(raw, c.env.HPS_SIGNING_SECRET);
  } catch {
    return unknownRoute(c);
  }
  // Role allow-list (recon F9): a student token only. Issuer, app, account tokens: unknown route.
  if ((payload.role !== undefined && payload.role !== "student") || payload.account || !payload.c) return unknownRoute(c);
  const resolved = await resolveProfile(c.env, payload.p);
  if (!resolved || !curriculumRuntimeAllowed(resolved.profile)) return unknownRoute(c);
  noStore(c);
  if (payload.jti && (await isTokenRevoked(c.env.HPS_KV, payload.jti))) return refuse(c, 401, "revoked");
  if (!(await profileServesCohort(c.env, resolved.profile, payload)).ok) return refuse(c, 401, "cohort_profile_mismatch");
  if (!(await getRoster(c.env.HPS_KV, payload.c))?.users.includes(payload.u)) return refuse(c, 403, "not_in_roster");
  return { payload };
}

/** The Project a member may act on, or the unknown-route answer (R5: a guessed id reveals nothing). */
async function memberProject(c: Ctx, s: Student, projectId: unknown): Promise<Project | Response> {
  if (!isVentureId(projectId)) return unknownRoute(c);
  const project = await getProject(c.env.HPS_DB, projectId);
  if (!project || !isMember(project, s.payload)) return unknownRoute(c);
  return project;
}

/**
 * `no-store` on every answer once the switch is known to be on, and only then: a switch-off
 * answer carries exactly the unknown route's headers (CR-T02 compares them).
 */
function noStore(c: Ctx): void {
  c.header("cache-control", "no-store");
}

const testOrigin = (env: Env) => parseTestOrigin(env.HPS_TEST_ORIGIN, env.ENVIRONMENT);

function b64ToBytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const curriculum = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

// ── Projects (R5) ────────────────────────────────────────────────────────────

curriculum.get("/projects", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  return c.json({ projects: await projectsOf(c.env.HPS_DB, s.payload) });
});

curriculum.post("/projects", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  let body: { title?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return refuse(c, 400, "invalid_json");
  }
  const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (!title) return refuse(c, 400, "title_required");
  const project = await createProject(c.env.HPS_DB, { cohort_id: s.payload.c, profile_id: s.payload.p, creator: s.payload.u, title, now: Date.now() });
  return c.json({ project }, 201);
});

curriculum.get("/projects/:id", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  const project = await memberProject(c, s, c.req.param("id"));
  if (project instanceof Response) return project;
  const db = c.env.HPS_DB;
  const origin = testOrigin(c.env);
  const now = Date.now();
  const links = (await linksOf(db, project.id)).map((l) => ({
    ...l,
    state: linkState(l, now),
    share_url: origin.ok ? shareUrl(origin.config, project.id, l.id) : null,
  }));
  return c.json({
    project,
    test_origin: origin.ok ? originFor(origin.config, project.id) : null,
    versions: await versionsOf(db, project.id),
    hypotheses: await hypothesesOf(db, project.id),
    experiments: await experimentsOf(db, project.id),
    links,
  });
});

/** The team is set by an issuer whose scope covers the Project's cohort (R5); students cannot call it. */
curriculum.put("/projects/:id/members", async (c) => {
  const raw = bearer(c.req.header("authorization"));
  if (!raw) return unknownRoute(c);
  let payload: TokenPayload;
  try {
    payload = await verify(raw, c.env.HPS_SIGNING_SECRET);
  } catch {
    return unknownRoute(c);
  }
  if (payload.role !== "issuer") return unknownRoute(c);
  const id = c.req.param("id");
  if (!isVentureId(id)) return unknownRoute(c);
  const project = await getProject(c.env.HPS_DB, id);
  // The issuer's scope must cover the Project's cohort AND its profile; the switch is the
  // served profile's, read exactly as the student routes and the test origin read it.
  if (!project || !(payload.scopes ?? []).some((sc) => sc.cohort === project.cohort_id && (sc.profiles ?? []).includes(project.profile_id))) return unknownRoute(c);
  const resolved = await resolveProfile(c.env, project.profile_id);
  if (!resolved || !curriculumRuntimeAllowed(resolved.profile)) return unknownRoute(c);
  noStore(c);
  if (payload.jti && (await isTokenRevoked(c.env.HPS_KV, payload.jti))) return refuse(c, 401, "revoked");
  let body: { members?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return refuse(c, 400, "invalid_json");
  }
  const members = body.members;
  if (!Array.isArray(members) || members.length === 0 || members.length > 12 || !members.every((m) => typeof m === "string" && m.length > 0 && m.length <= 100)) return refuse(c, 400, "invalid_members");
  const roster = (await getRoster(c.env.HPS_KV, project.cohort_id))?.users ?? [];
  const missing = (members as string[]).filter((m) => !roster.includes(m));
  if (missing.length) return refuse(c, 400, "members_not_in_roster", { members: missing });
  return c.json({ project: await setMembers(c.env.HPS_DB, project, members as string[], Date.now()) });
});

// ── Versions (CR-17; R4) ─────────────────────────────────────────────────────

interface UploadFile {
  path: string;
  sha256: string;
  bytes: number;
  data: string;
}

curriculum.put("/projects/:id/versions/:digest", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  const project = await memberProject(c, s, c.req.param("id"));
  if (project instanceof Response) return project;
  const digest = decodeURIComponent(c.req.param("digest"));
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return refuse(c, 400, "invalid_version_id");
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > PUBLISH_LIMITS.maxSetBytes * 1.5) return refuse(c, 413, "set_too_large");
  let body: { entry_html?: unknown; manifest_added?: unknown; verification_report?: unknown; files?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return refuse(c, 400, "invalid_json");
  }
  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) return refuse(c, 400, "files_required");
  if (files.length > PUBLISH_LIMITS.maxFiles) return refuse(c, 413, "too_many_files");
  const decoded: Array<{ meta: { path: string; sha256: string; bytes: number }; data: Uint8Array }> = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of files as UploadFile[]) {
    const problem = publishPathProblem(f?.path);
    if (problem) return refuse(c, 422, problem, { file: typeof f?.path === "string" ? f.path : null });
    if (seen.has(f.path)) return refuse(c, 422, "duplicate_path", { file: f.path });
    seen.add(f.path);
    const data = typeof f.data === "string" ? b64ToBytes(f.data) : null;
    if (!data || data.length !== f.bytes) return refuse(c, 422, "file_bytes_mismatch", { file: f.path });
    if (data.length > PUBLISH_LIMITS.maxFileBytes) return refuse(c, 413, "file_too_large", { file: f.path });
    total += data.length;
    if (total > PUBLISH_LIMITS.maxSetBytes) return refuse(c, 413, "set_too_large");
    if (hex(await crypto.subtle.digest("SHA-256", data)) !== f.sha256) return refuse(c, 409, "file_digest_mismatch", { file: f.path });
    decoded.push({ meta: { path: f.path, sha256: f.sha256, bytes: data.length }, data });
  }
  const list = decoded.map((d) => d.meta).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // The id IS the digest of the list: changing any file behind a version changes the id.
  if ((await digestOf(list)) !== digest) return refuse(c, 409, "version_digest_mismatch");
  const entry = body.entry_html;
  if (typeof entry !== "string" || !seen.has(entry) || !/\.html?$/i.test(entry)) return refuse(c, 422, "entry_not_in_set");
  const manifest = body.manifest_added;
  if (manifest !== undefined && (!Array.isArray(manifest) || !manifest.every((m) => typeof m === "string" && seen.has(m)))) return refuse(c, 422, "invalid_manifest");
  const report = body.verification_report;
  if (report !== undefined && (typeof report !== "string" || report.length > 200)) return refuse(c, 422, "invalid_verification_report");
  // R4's publish scan, again on receipt, with the signature check only the Service can do.
  const origin = testOrigin(c.env);
  const ctx = { projectId: project.id, testOrigin: origin.ok ? originFor(origin.config, project.id) : null };
  const hits: ScanHit[] = [];
  for (const d of decoded) {
    const text = new TextDecoder().decode(d.data);
    hits.push(...scanFile(d.meta.path, text, ctx));
    for (const t of hypeproofTokensIn(text)) {
      if (judgeToken(t.value, ctx) !== null) continue; // already a hit above
      try {
        await verify(t.value, c.env.HPS_SIGNING_SECRET);
      } catch {
        hits.push({ file: d.meta.path, line: t.line, rule: "hypeproof_token", detail: "signature" });
      }
    }
  }
  if (hits.length) return refuse(c, 422, "secret_found", { hits });
  const existing = await getVersion(c.env.HPS_DB, project.id, digest);
  if (!existing) {
    for (const d of decoded) await c.env.HPS_TRACES.put(testFileKey(digest, d.meta.path), d.data);
  }
  const { version, created } = await putVersion(c.env.HPS_DB, {
    project_id: project.id,
    id: digest,
    files: list,
    entry_html: entry,
    ...(Array.isArray(manifest) && manifest.length ? { manifest_added: manifest as string[] } : {}),
    ...(typeof report === "string" ? { verification_report: report } : {}),
    now: Date.now(),
  });
  return c.json({ version, created }, created ? 201 : 200);
});

// ── Experiments (CR-39, CR-22) ───────────────────────────────────────────────

/** The experiment fields a retried start must repeat exactly to be the same start. */
const startKey = (e: Pick<Experiment, "hypothesis_id" | "product_version_id" | "week" | "question" | "method" | "success_criteria" | "declarations">) =>
  JSON.stringify([e.hypothesis_id, e.product_version_id, e.week, e.question, e.method, e.success_criteria, e.declarations ?? null]);

/**
 * Start a test. Every precondition is checked before anything is written (the test origin, the
 * contract, the version, the hypothesis and variant references, the per-project bound). Then
 * the experiment's record task is created first, under the experiment id chosen here, and only
 * then the D1 rows: a failure before the rows leaves at most an unreferenced task, never a
 * `running` experiment whose sessions cannot open. A retried start is idempotent: an open
 * hypothesis with the same statement is reused, and a running experiment with the same fields
 * and no link yet is answered again (200) instead of a second one being made.
 */
curriculum.post("/experiments", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return refuse(c, 400, "invalid_json");
  }
  const project = await memberProject(c, s, body.project_id);
  if (project instanceof Response) return project;
  const db = c.env.HPS_DB;
  // A test no link can be issued for is not started (the link route would answer the same).
  const origin = testOrigin(c.env);
  if (!origin.ok) return refuse(c, 503, "test_origin_unavailable", { problem: origin.problem });
  const hypothesisId = typeof body.hypothesis_id === "string" ? body.hypothesis_id : undefined;
  const statement = body.hypothesis === undefined ? null : validateHypothesisStatement(body.hypothesis);
  if (body.hypothesis !== undefined && statement === null) return refuse(c, 400, "invalid_hypothesis");
  if (!hypothesisId && !statement) return refuse(c, 400, "hypothesis_required");
  // The whole contract is checked before anything is written (a placeholder stands for a
  // hypothesis this call would create).
  const draft = {
    id: "exp-pending",
    project_id: project.id,
    week: body.week,
    hypothesis_id: hypothesisId ?? "hyp-pending",
    question: body.question,
    method: body.method,
    success_criteria: body.success_criteria,
    product_version_id: body.product_version_id,
    status: "running",
    ...(body.declarations !== undefined ? { declarations: body.declarations } : {}),
  };
  const contract = validateExperimentContract(draft);
  if (!contract.ok) return refuse(c, 400, "invalid_experiment", { problems: contract.problems });
  const version = await getVersion(db, project.id, contract.value.product_version_id);
  if (!version) return refuse(c, 409, "version_unresolved");
  if (hypothesisId) {
    const h = await getHypothesis(db, hypothesisId);
    if (!h || h.project_id !== project.id) return refuse(c, 409, "hypothesis_unresolved");
  }
  for (const v of contract.value.declarations?.variants ?? []) {
    if (v.product_version_id && !(await getVersion(db, project.id, v.product_version_id))) return refuse(c, 409, "variant_version_unresolved");
  }
  const { id: _pending, ...rest } = contract.value;
  // A retry of the same start (the App retries after a failed or unanswered call).
  const reused = hypothesisId ? null : ((await hypothesesOf(db, project.id)).find((h) => h.status === "open" && h.statement === statement) ?? null);
  const hypId = hypothesisId ?? reused?.id;
  if (hypId) {
    const key = startKey({ ...rest, hypothesis_id: hypId });
    const linked = new Set((await linksOf(db, project.id)).map((l) => l.experiment_id));
    const same = (await experimentsOf(db, project.id)).find((e) => e.status === "running" && !linked.has(e.id) && startKey(e) === key);
    if (same) {
      await ensureExperimentTask(participantRecord(c.env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id), same, Date.now());
      return c.json({ experiment: same, hypothesis: reused, verification_report: version.verification_report ?? null, reused: true }, 200);
    }
  }
  if ((await countExperiments(db, project.id)) >= PUBLISH_LIMITS.maxExperimentsPerProject) return refuse(c, 409, "experiment_limit", { max: PUBLISH_LIMITS.maxExperimentsPerProject });
  // The record task first: nothing in D1 names this experiment until its sessions can open.
  const experimentId = newVentureId("exp");
  await ensureExperimentTask(participantRecord(c.env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id), { id: experimentId, project_id: project.id, question: rest.question }, Date.now());
  const hypothesis = hypId ? null : await createHypothesis(db, { project_id: project.id, statement: statement!, now: Date.now() });
  let created: Awaited<ReturnType<typeof createExperiment>>;
  try {
    created = await createExperiment(db, { ...rest, id: experimentId, hypothesis_id: hypothesis?.id ?? hypId!, now: Date.now() });
  } catch (e) {
    if (hypothesis) await deleteHypothesis(db, hypothesis.id);
    throw e;
  }
  if (!created.ok) {
    if (hypothesis) await deleteHypothesis(db, hypothesis.id);
    return refuse(c, 409, created.code);
  }
  return c.json({ experiment: created.experiment, hypothesis: hypothesis ?? reused, verification_report: version.verification_report ?? null }, 201);
});

curriculum.get("/experiments/:id/channels", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  const id = c.req.param("id");
  const experiment = isVentureId(id) ? await getExperiment(c.env.HPS_DB, id) : null;
  if (!experiment) return unknownRoute(c);
  const project = await memberProject(c, s, experiment.project_id);
  if (project instanceof Response) return project;
  // Sessions opened per channel, from the per-link counters (one query, no session read):
  // a usage observation, never a demand claim (SX-58).
  const counts = await channelCounts(c.env.HPS_DB, experiment.id);
  return c.json({ experiment_id: experiment.id, sessions_opened: counts, note: "usage_observation" });
});

// ── Links (CR-18, CR-19, CR-73) ──────────────────────────────────────────────

curriculum.post("/experiments/:id/links", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  const id = c.req.param("id");
  const experiment = isVentureId(id) ? await getExperiment(c.env.HPS_DB, id) : null;
  if (!experiment) return unknownRoute(c);
  const project = await memberProject(c, s, experiment.project_id);
  if (project instanceof Response) return project;
  let body: { expires_at?: unknown; channel?: unknown; variant_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return refuse(c, 400, "invalid_json");
  }
  const now = Date.now();
  // No default expiry exists until Jay sets one (CR-19): the student must choose it.
  if (body.expires_at === undefined || body.expires_at === null) return refuse(c, 400, "expiry_required");
  const expires = body.expires_at;
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= now || expires > now + PUBLISH_LIMITS.maxLinkLifetimeMs) return refuse(c, 400, "invalid_expiry");
  const channel = normalizeChannel(body.channel);
  if (channel === null) return refuse(c, 400, "invalid_channel", { max: CHANNEL_MAX });
  const variant = body.variant_id;
  if (variant !== undefined && !(typeof variant === "string" && experiment.declarations?.variants?.some((v) => v.id === variant))) return refuse(c, 400, "unknown_variant");
  if (experiment.status !== "running") return refuse(c, 409, "experiment_not_running");
  const origin = testOrigin(c.env);
  if (!origin.ok) return refuse(c, 503, "test_origin_unavailable", { problem: origin.problem });
  if ((await countLinks(c.env.HPS_DB, experiment.id)) >= PUBLISH_LIMITS.maxLinksPerExperiment) return refuse(c, 409, "link_limit", { max: PUBLISH_LIMITS.maxLinksPerExperiment });
  const link = await createLink(c.env.HPS_DB, { project_id: project.id, experiment_id: experiment.id, ...(channel ? { channel } : {}), ...(typeof variant === "string" ? { variant_id: variant } : {}), expires_at: expires, now });
  return c.json({ link: { ...link, state: linkState(link, now) }, share_url: shareUrl(origin.config, project.id, link.id), test_origin: originFor(origin.config, project.id) }, 201);
});

curriculum.post("/links/:id/revoke", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  const id = c.req.param("id");
  const link = LINK_ID.test(id) ? await getLink(c.env.HPS_DB, id) : null;
  if (!link) return unknownRoute(c);
  const project = await memberProject(c, s, link.project_id);
  if (project instanceof Response) return project;
  const now = Date.now();
  await revokeLink(c.env.HPS_DB, link.id, now);
  const after = (await getLink(c.env.HPS_DB, link.id)) as TestLink;
  return c.json({ link: { ...after, state: linkState(after, now) } });
});

/** The CR-T02 Worker inventory of this router, as `METHOD /path` under /v1/curriculum. */
export const CURRICULUM_ROUTES = [
  "GET /v1/curriculum/projects",
  "POST /v1/curriculum/projects",
  "GET /v1/curriculum/projects/:id",
  "PUT /v1/curriculum/projects/:id/members",
  "PUT /v1/curriculum/projects/:id/versions/:digest",
  "POST /v1/curriculum/experiments",
  "GET /v1/curriculum/experiments/:id/channels",
  "POST /v1/curriculum/experiments/:id/links",
  "POST /v1/curriculum/links/:id/revoke",
] as const;
