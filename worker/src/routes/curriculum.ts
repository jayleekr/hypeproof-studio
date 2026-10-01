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
import { digestOf, NOTES_HOST } from "../lib/measurement-core/local-record";
import {
  CHANNEL_MAX,
  HYPOTHESIS_STATUSES,
  LINK_ID,
  VENTURE_SCHEMA,
  isVentureId,
  parseEvidenceItemRef,
  validateDecisionContract,
  validateDeckSlide,
  validateMetric,
  validateStakeholder,
  type Decision,
  type Hypothesis,
  type Metric,
  type Stakeholder,
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
  channelCountsOfProject,
  countVersions,
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
  openHypothesis,
  openStart,
  projectsOf,
  putVersion,
  revokeLink,
  setMembers,
  versionsOf,
} from "../lib/curriculum/store";
import { hypeproofTokensIn, judgeToken, scanFile, type ScanHit } from "../lib/curriculum/publish-scan";
import { originFor, parseTestOrigin, shareUrl } from "../lib/curriculum/test-origin";
import { EVIDENCE_LIMITS, addNote, ensureExperimentTask, experimentEvidence, noteEvent, participantRecord, PUBLISHED_HOST, type R2Like } from "../lib/curriculum/participant-record";
import { getCohortControls, releaseErasedSession, touchExperiment } from "../lib/curriculum/store";
import {
  addDecision,
  addHypothesis,
  addMetric,
  addSlideRevision,
  addStakeholder,
  decisionsOf,
  getDecision,
  getStakeholder,
  linkDecisionVersion,
  metricsOf,
  projectsOfCohort,
  reviseHypothesis,
  reviseProblem,
  setExperimentStakeholder,
  slidesOf,
  stakeholdersOf,
} from "../lib/curriculum/store";
import { decisionRefProblems, decisionView, evidenceItemsOf, evidenceRefProblems, memoryState, supportsObservedRole, supportsTeamEvidence, versionDiff, type EvidenceItemView, type MemoryState } from "../lib/curriculum/memory";
import type { ObservationEvent } from "../lib/measurement-core/legacy-observation";
import { deleteExperimentData } from "../lib/curriculum/retention";
import { reviseEvidenceDraft, type EvidenceDraft } from "../lib/measurement-core/interpretation";
import { runtimeDraft } from "../lib/measurement-core/participant-evidence";
import { CURRICULUM, CURRICULUM_SKILLS, checkSkillOutput, curriculumWeek, skillPrompt, type CurriculumSkill } from "../skills/index";
import { evidenceDraftOf } from "../skills/curriculum/rules";
import { validateAgainstSchema } from "../skills/curriculum/contract";
import { SOURCE_LIMITS, isSourcePath, modelContextOf, runWeek, skillContextOf, type VersionForSkill } from "../lib/curriculum/skill-run";

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
  /** Test versions one Project may hold (each up to `maxSetBytes` on R2, never deleted by this slice). */
  maxVersionsPerProject: 100,
  /** Projects one student may create in a cohort (a team Project the director sets up does not count). */
  maxProjectsPerStudent: 10,
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
  const project = await createProject(c.env.HPS_DB, { cohort_id: s.payload.c, profile_id: s.payload.p, creator: s.payload.u, title, now: Date.now(), max: PUBLISH_LIMITS.maxProjectsPerStudent });
  if (!project) return refuse(c, 409, "project_limit", { max: PUBLISH_LIMITS.maxProjectsPerStudent });
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
    // Sessions opened per channel for every experiment, in one query (CR-73; a usage
    // observation, never a demand claim, SX-58). An experiment with no session is absent.
    sessions_opened: await channelCountsOfProject(db, project.id),
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
  // No D1 read before the switch is known to be on for a profile this issuer serves: with the
  // switch off everywhere the cr_* tables may not exist (migration 0032 is applied only when Jay
  // approves it), and the answer must stay the unknown route's (CR-02).
  const scoped = [...new Set((payload.scopes ?? []).flatMap((sc) => sc.profiles ?? []))];
  let anyOn = false;
  for (const p of scoped) {
    const r = await resolveProfile(c.env, p);
    if (r && curriculumRuntimeAllowed(r.profile)) {
      anyOn = true;
      break;
    }
  }
  if (!anyOn) return unknownRoute(c);
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
  // Hono hands the param over decoded already; a second decode could only throw (a lone `%`).
  const digest = c.req.param("digest");
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
  const full = () => refuse(c, 409, "version_limit", { max: PUBLISH_LIMITS.maxVersionsPerProject });
  if (!existing) {
    // Checked before the bytes go to R2; the insert below decides atomically.
    if ((await countVersions(c.env.HPS_DB, project.id)) >= PUBLISH_LIMITS.maxVersionsPerProject) return full();
    for (const d of decoded) await c.env.HPS_TRACES.put(testFileKey(digest, d.meta.path), d.data);
  }
  const put = await putVersion(c.env.HPS_DB, {
    project_id: project.id,
    id: digest,
    files: list,
    entry_html: entry,
    ...(Array.isArray(manifest) && manifest.length ? { manifest_added: manifest as string[] } : {}),
    ...(typeof report === "string" ? { verification_report: report } : {}),
    now: Date.now(),
    max: PUBLISH_LIMITS.maxVersionsPerProject,
  });
  if (!put) return full();
  const { version, created } = put;
  return c.json({ version, created }, created ? 201 : 200);
});

// ── Experiments (CR-39, CR-22) ───────────────────────────────────────────────

/** The experiment fields a retried start must repeat exactly to be the same start (stored as their digest). */
const startKey = async (e: Pick<Experiment, "hypothesis_id" | "product_version_id" | "week" | "question" | "method" | "success_criteria" | "declarations">) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([e.hypothesis_id, e.product_version_id, e.week, e.question, e.method, e.success_criteria, e.declarations ?? null]))));

/**
 * Start a test. Every precondition is checked before anything is written (the test origin, the
 * contract, the version, the hypothesis and variant references, the per-project bound). Then
 * the experiment's record task is created first, under the experiment id chosen here, and only
 * then the D1 rows: a failure before the rows leaves at most an unreferenced task, never a
 * `running` experiment whose sessions cannot open. A retried start is idempotent, also when
 * the retries arrive at the same time: an open hypothesis with the same statement is reused,
 * and a running experiment with the same fields and no link yet is answered again (200)
 * instead of a second one being made. Both are decided by single statements on unique keys
 * (store.ts `createHypothesis`, `createExperiment`), as is the per-project bound.
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
    ...(body.stakeholder_id !== undefined ? { stakeholder_id: body.stakeholder_id } : {}),
  };
  const contract = validateExperimentContract(draft);
  if (!contract.ok) return refuse(c, 400, "invalid_experiment", { problems: contract.problems });
  const version = await getVersion(db, project.id, contract.value.product_version_id);
  if (!version) return refuse(c, 409, "version_unresolved");
  // cr-evidence (CR-67, CR-70): the cohort's admin decides whether raw input may be declared at all.
  if (contract.value.declarations?.raw_input && !(await getCohortControls(db, project.cohort_id)).raw_input_allowed) return refuse(c, 403, "raw_input_not_allowed");
  if (hypothesisId) {
    const h = await getHypothesis(db, hypothesisId);
    if (!h || h.project_id !== project.id) return refuse(c, 409, "hypothesis_unresolved");
  }
  for (const v of contract.value.declarations?.variants ?? []) {
    if (v.product_version_id && !(await getVersion(db, project.id, v.product_version_id))) return refuse(c, 409, "variant_version_unresolved");
  }
  // cr-memory (CR-75): the stakeholder the experiment concerns is one of this Project's.
  if (contract.value.stakeholder_id !== undefined) {
    const st = await getStakeholder(db, contract.value.stakeholder_id);
    if (!st || st.project_id !== project.id) return refuse(c, 409, "stakeholder_unresolved");
  }
  const { id: _pending, ...rest } = contract.value;
  const record = participantRecord(c.env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id);
  const reusedAnswer = async (same: Experiment, hypothesis: unknown) => {
    await ensureExperimentTask(record, same, Date.now());
    return c.json({ experiment: same, hypothesis, verification_report: version.verification_report ?? null, reused: true }, 200);
  };
  // A retry of the same start (the App retries after a failed or unanswered call).
  const found = hypothesisId ? null : await openHypothesis(db, project.id, statement!);
  if (hypothesisId || found) {
    const same = await openStart(db, project.id, await startKey({ ...rest, hypothesis_id: hypothesisId ?? found!.id }));
    if (same) return reusedAnswer(same, found);
  }
  // The record task first: nothing in D1 names this experiment until its sessions can open.
  const experimentId = newVentureId("exp");
  await ensureExperimentTask(record, { id: experimentId, project_id: project.id, question: rest.question }, Date.now());
  const stored = hypothesisId ? null : await createHypothesis(db, { project_id: project.id, statement: statement!, now: Date.now() });
  const hypId = hypothesisId ?? stored!.hypothesis.id;
  // Taken back only when this call stored it and its start then failed.
  const undo = async () => {
    if (stored?.created) await deleteHypothesis(db, hypId);
  };
  let created: Awaited<ReturnType<typeof createExperiment>>;
  try {
    created = await createExperiment(db, { ...rest, id: experimentId, hypothesis_id: hypId, now: Date.now(), start_key: await startKey({ ...rest, hypothesis_id: hypId }), max: PUBLISH_LIMITS.maxExperimentsPerProject });
  } catch (e) {
    await undo();
    throw e;
  }
  if (!created.ok) {
    await undo();
    return refuse(c, 409, created.code, created.code === "experiment_limit" ? { max: PUBLISH_LIMITS.maxExperimentsPerProject } : {});
  }
  // Another start with the same fields stored its row first (sent at the same time).
  if (!created.created) return reusedAnswer(created.experiment, stored?.hypothesis ?? null);
  return c.json({ experiment: created.experiment, hypothesis: stored?.hypothesis ?? null, verification_report: version.verification_report ?? null }, 201);
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
  // No default expiry exists until one is set (CR-19): the student must choose it, unless the
  // cohort's admin set a default (CR-70, cr-evidence).
  if (body.expires_at === undefined || body.expires_at === null) {
    const d = (await getCohortControls(c.env.HPS_DB, project.cohort_id)).link_expiry_default_days;
    if (d === null) return refuse(c, 400, "expiry_required");
    body.expires_at = now + d * 24 * 3600_000;
  }
  const expires = body.expires_at;
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= now || expires > now + PUBLISH_LIMITS.maxLinkLifetimeMs) return refuse(c, 400, "invalid_expiry");
  const channel = normalizeChannel(body.channel);
  if (channel === null) return refuse(c, 400, "invalid_channel", { max: CHANNEL_MAX });
  const variant = body.variant_id;
  if (variant !== undefined && !(typeof variant === "string" && experiment.declarations?.variants?.some((v) => v.id === variant))) return refuse(c, 400, "unknown_variant");
  // cr-evidence (CR-74): in a comparison experiment every session carries exactly one variant,
  // so a link must name one; an outside alternative is observed through notes, never served.
  if (variant === undefined && (experiment.declarations?.variants?.length ?? 0) >= 2) return refuse(c, 400, "variant_required");
  if (typeof variant === "string" && experiment.declarations?.variants?.find((v) => v.id === variant)?.alternative) return refuse(c, 400, "variant_is_alternative");
  if (experiment.status !== "running") return refuse(c, 409, "experiment_not_running");
  const origin = testOrigin(c.env);
  if (!origin.ok) return refuse(c, 503, "test_origin_unavailable", { problem: origin.problem });
  // The record task its sessions link to: a no-link experiment whose manual records the sweep
  // deleted (decision 6) lost it with them, and stays running so it can still be tested.
  await ensureExperimentTask(participantRecord(c.env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id), experiment, now);
  const link = await createLink(c.env.HPS_DB, {
    project_id: project.id,
    experiment_id: experiment.id,
    ...(channel ? { channel } : {}),
    ...(typeof variant === "string" ? { variant_id: variant } : {}),
    expires_at: expires,
    now,
    max: PUBLISH_LIMITS.maxLinksPerExperiment,
  });
  if (!link) return refuse(c, 409, "link_limit", { max: PUBLISH_LIMITS.maxLinksPerExperiment });
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

// ── Evidence (cr-evidence #1394; CR-24–CR-28, CR-69, CR-72, CR-74) ────────────

/** An experiment a member may act on, with its Project and the Project's record, or the unknown-route answer. */
async function memberExperiment(c: Ctx, s: Student, id: string) {
  const experiment = isVentureId(id) ? await getExperiment(c.env.HPS_DB, id) : null;
  if (!experiment) return unknownRoute(c);
  const project = await memberProject(c, s, experiment.project_id);
  if (project instanceof Response) return project;
  return { experiment, project, record: participantRecord(c.env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id) };
}

/**
 * The reader of an experiment's evidence: a member of its Project, or a director whose issuer
 * scope covers the Project's cohort and profile (R5, CR-37). Anyone else, an id that does not
 * exist, and every caller while the switch is off get the unknown-route answer.
 */
async function evidenceReader(c: Ctx, id: string) {
  const raw = bearer(c.req.header("authorization"));
  if (!raw) return unknownRoute(c);
  let payload: TokenPayload;
  try {
    payload = await verify(raw, c.env.HPS_SIGNING_SECRET);
  } catch {
    return unknownRoute(c);
  }
  if (payload.role !== "issuer") {
    const s = await student(c);
    if (s instanceof Response) return s;
    const m = await memberExperiment(c, s, id);
    return m instanceof Response ? m : { ...m, by: "student" as const };
  }
  // A director: no D1 read before the switch is known to be on for a profile this issuer serves (CR-02).
  let anyOn = false;
  for (const p of [...new Set((payload.scopes ?? []).flatMap((sc) => sc.profiles ?? []))]) {
    const r = await resolveProfile(c.env, p);
    if (r && curriculumRuntimeAllowed(r.profile)) {
      anyOn = true;
      break;
    }
  }
  if (!anyOn || !isVentureId(id)) return unknownRoute(c);
  const experiment = await getExperiment(c.env.HPS_DB, id);
  const project = experiment ? await getProject(c.env.HPS_DB, experiment.project_id) : null;
  if (!experiment || !project || !(payload.scopes ?? []).some((sc) => sc.cohort === project.cohort_id && (sc.profiles ?? []).includes(project.profile_id))) return unknownRoute(c);
  const resolved = await resolveProfile(c.env, project.profile_id);
  if (!resolved || !curriculumRuntimeAllowed(resolved.profile)) return unknownRoute(c);
  noStore(c);
  if (payload.jti && (await isTokenRevoked(c.env.HPS_KV, payload.jti))) return refuse(c, 401, "revoked");
  return { experiment, project, record: participantRecord(c.env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id), by: "director" as const };
}

/**
 * Who may delete an experiment's test data (CR-69, CR-70): the evidence reader's rule. A member
 * of the Project, unless the cohort reserved deletion for directors (`student_deletion: false`,
 * then 403 `deletion_reserved`); a director whose scope covers the Project always may. Anyone
 * else gets the unknown-route answer.
 */
async function evidenceDeleter(c: Ctx, id: string) {
  const r = await evidenceReader(c, id);
  if (r instanceof Response) return r;
  if (r.by === "student" && !(await getCohortControls(c.env.HPS_DB, r.project.cohort_id)).student_deletion) return refuse(c, 403, "deletion_reserved");
  return r;
}

curriculum.get("/experiments/:id/evidence", async (c) => {
  const r = await evidenceReader(c, c.req.param("id"));
  if (r instanceof Response) return r;
  return c.json({ evidence: await experimentEvidence(r.record, r.experiment, Date.now()) });
});

/**
 * Was the experiment's test data deleted while this request was writing (CR-69, decision 6)?
 * The delete closes the experiment (`data_deleted_at`) before it scans the record, so a write
 * that finished before the close is in the scan, and one checked here after the close sees it.
 * When it was deleted, what the record holds for the experiment now goes too (the write's own
 * record included). Also answers a write that lost its record task to the deletion (`unknown_task`).
 */
async function deletedMeanwhile(c: Ctx, r: { experiment: { id: string }; record: { deleteTask(id: string, input: { by: "user"; at: number }): Promise<unknown> } }): Promise<boolean> {
  const fresh = await getExperiment(c.env.HPS_DB, r.experiment.id);
  if (fresh?.data_deleted_at === undefined) return false;
  try {
    await r.record.deleteTask(r.experiment.id, { by: "user", at: Date.now() });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "unknown_task") throw e;
  }
  return true;
}

/** A manual record (CR-24): five kinds, the provenance each needs and the student's source state; nothing guessed. */
curriculum.post("/experiments/:id/notes", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  const r = await memberExperiment(c, s, c.req.param("id"));
  if (r instanceof Response) return r;
  if (r.experiment.data_deleted_at !== undefined) return refuse(c, 409, "experiment_data_deleted");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return refuse(c, 400, "invalid_json");
  }
  const now = Date.now();
  const built = noteEvent({ experiment: r.experiment, note: body, id: newVentureId("note"), now });
  if (!built.ok) return refuse(c, 400, built.code);
  if ((await r.record.observationsOf("notes", r.experiment.id)).length >= EVIDENCE_LIMITS.maxNotesPerExperiment) return refuse(c, 409, "note_limit", { max: EVIDENCE_LIMITS.maxNotesPerExperiment });
  // The experiment's last record moves (when it ends for automatic deletion, decision 6)
  // BEFORE the write: a sweep running meanwhile then keeps the row and the note stays due.
  await touchExperiment(c.env.HPS_DB, r.experiment.id, now);
  await ensureExperimentTask(r.record, r.experiment, now);
  try {
    await addNote(r.record, r.experiment, built.event);
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (/^(invalid_|missing_|identity_field|ai_text_as_student|unsupported_)/.test(code)) return refuse(c, 400, code);
    if (code === "unknown_task" && (await deletedMeanwhile(c, r))) return refuse(c, 409, "experiment_data_deleted");
    throw e;
  }
  if (await deletedMeanwhile(c, r)) return refuse(c, 409, "experiment_data_deleted");
  return c.json({ note: built.event }, 201);
});

/**
 * Store an evidence draft, revision 1 (CR-25): the runtime's observed items over the records
 * (`from_runtime`), or items an AI summary or the student wrote. Every observed statement must
 * cite records of this experiment that resolve; otherwise nothing is stored and every refused
 * item is named (422).
 */
curriculum.post("/experiments/:id/drafts", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  const r = await memberExperiment(c, s, c.req.param("id"));
  if (r instanceof Response) return r;
  let body: { from_runtime?: unknown; items?: unknown; author?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return refuse(c, 400, "invalid_json");
  }
  if (r.experiment.data_deleted_at !== undefined) return refuse(c, 409, "experiment_data_deleted");
  const now = Date.now();
  if ((await r.record.evidenceDrafts(r.experiment.id).catch(() => [])).length >= EVIDENCE_LIMITS.maxDraftRevisionsPerExperiment) return refuse(c, 409, "draft_limit");
  await ensureExperimentTask(r.record, r.experiment, now);
  const id = newVentureId("drf");
  let draft: unknown;
  if (body.from_runtime === true) {
    const ev = await experimentEvidence(r.record, r.experiment, now);
    const d = runtimeDraft({ id, experiment: r.experiment, sessions: ev.sessions, notes: ev.notes, at: now });
    if (!d) return refuse(c, 409, "no_evidence_recorded");
    draft = d;
  } else {
    // The author is stated, never defaulted: an AI tool that left it out would otherwise be
    // stored as the student (cr-skills calls this route). And revision 1 holds drafts only:
    // accepting or editing is the review route's, a new revision by the student (CR-26, MC-22).
    if (body.author !== "ai" && body.author !== "user") return refuse(c, 400, "missing_author");
    if (Array.isArray(body.items) && body.items.some((i) => !i || typeof i !== "object" || (i as { review?: unknown }).review !== "draft")) return refuse(c, 400, "invalid_review");
    draft = { format: "hps-evidence-draft/1", id, revision: 1, supersedes: null, experiment: r.experiment.id, author: body.author, created_at: now, items: body.items };
  }
  const saved = await saveDraft(c, r, draft, now);
  return saved instanceof Response ? saved : c.json({ draft: saved }, 201);
});

/**
 * Store one draft revision 1 on the experiment's record (the drafts route and the Evidence
 * skill's write-back, cr-skills): every reference must resolve, else nothing is stored and every
 * refused item is named (422). The caller has checked the experiment is not deleted and has
 * created its record task.
 */
async function saveDraft(c: Ctx, r: Exclude<Awaited<ReturnType<typeof memberExperiment>>, Response>, draft: unknown, now: number): Promise<EvidenceDraft | Response> {
  let saved: Awaited<ReturnType<typeof r.record.saveEvidenceDraft>>;
  await touchExperiment(c.env.HPS_DB, r.experiment.id, now);
  try {
    saved = await r.record.saveEvidenceDraft(r.experiment.id, draft, { quota: "none", repeatedUse: r.experiment.declarations?.repeated_use === true });
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (/^(invalid_|unsupported_|missing_)/.test(code)) return refuse(c, 400, code);
    if (code === "unknown_task" && (await deletedMeanwhile(c, r))) return refuse(c, 409, "experiment_data_deleted");
    throw e;
  }
  if (!saved.ok) return refuse(c, 422, "unresolved_source_refs", { refusals: saved.refusals });
  if (await deletedMeanwhile(c, r)) return refuse(c, 409, "experiment_data_deleted");
  return saved.draft as EvidenceDraft;
}

/** Accept, edit or reject items (CR-26): a new revision; the previous one and every raw record keep their bytes. */
curriculum.post("/experiments/:id/drafts/:draft/review", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  const r = await memberExperiment(c, s, c.req.param("id"));
  if (r instanceof Response) return r;
  let body: { revision?: unknown; actions?: unknown; reason?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return refuse(c, 400, "invalid_json");
  }
  const draftId = c.req.param("draft");
  const all = (await r.record.evidenceDrafts(r.experiment.id).catch(() => [] as EvidenceDraft[])).filter((d) => d.id === draftId);
  const latest = all.at(-1);
  if (!latest) return unknownRoute(c);
  if (body.revision !== latest.revision) return refuse(c, 409, "stale_revision", { latest: latest.revision });
  let next: EvidenceDraft;
  try {
    next = reviseEvidenceDraft(latest, body.actions as Parameters<typeof reviseEvidenceDraft>[1], { at: Date.now(), reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 1000) : "student review" });
  } catch (e) {
    return refuse(c, 400, e instanceof Error ? e.message : "invalid_review");
  }
  if (r.experiment.data_deleted_at !== undefined) return refuse(c, 409, "experiment_data_deleted");
  // cr-memory (CR-82, SX-46): an assumption becomes observed only on real records. Participant
  // sessions and events are always real; a manual record carries the source_state the student
  // chose, and one marked simulated, self-reported or unverified cannot confirm anything.
  const promoted = Array.isArray(body.actions) ? (body.actions as Array<{ action?: unknown; source_refs?: unknown }>).filter((a) => a && a.action === "promote").flatMap((a) => (Array.isArray(a.source_refs) ? a.source_refs.map(String) : [])) : [];
  const noteRefs = promoted.filter((ref) => ref.startsWith("note:"));
  if (noteRefs.length) {
    // Fail closed: a note whose state is not known to be real confirms nothing, and a failed
    // read of the notes refuses the promotion rather than reading as "no note is unreal".
    let states: Map<string, string | undefined>;
    try {
      states = await noteStatesOf(r.record, r.experiment.id);
    } catch {
      return refuse(c, 503, "evidence_unavailable");
    }
    const notReal = noteRefs.filter((ref) => states.get(ref.slice(5)) !== "real");
    if (notReal.length) return refuse(c, 422, "promotion_source_not_real", { refs: notReal });
  }
  const now = Date.now();
  await touchExperiment(c.env.HPS_DB, r.experiment.id, now);
  let saved: Awaited<ReturnType<typeof r.record.saveEvidenceDraft>>;
  try {
    saved = await r.record.saveEvidenceDraft(r.experiment.id, next, { quota: "none", repeatedUse: r.experiment.declarations?.repeated_use === true });
  } catch (e) {
    if (e instanceof Error && e.message === "unknown_task" && (await deletedMeanwhile(c, r))) return refuse(c, 409, "experiment_data_deleted");
    throw e;
  }
  if (!saved.ok) return refuse(c, 422, "unresolved_source_refs", { refusals: saved.refusals });
  if (await deletedMeanwhile(c, r)) return refuse(c, 409, "experiment_data_deleted");
  return c.json({ draft: saved.draft }, 201);
});

/**
 * Delete an experiment's test data (CR-69): every participant session, event, manual record
 * and evidence draft in its record (`deleteTask`, MC-31), with the receipt it returns. Its
 * links are revoked and its session counters follow; the Experiment record stays, closed, with
 * when its data was deleted. A cohort may reserve deletion for directors (CR-70); an in-scope
 * director can always delete (`evidenceDeleter`), so the action never disappears for a cohort.
 */
curriculum.delete("/experiments/:id", async (c) => {
  const r = await evidenceDeleter(c, c.req.param("id"));
  if (r instanceof Response) return r;
  const now = Date.now();
  const { experiment, report } = await deleteExperimentData(c.env.HPS_DB, r.record, r.experiment, now);
  return c.json({ receipt: { kind: "experiment_test_data_deleted", experiment_id: experiment.id, at: now, deleted_by: r.by, removed: report?.removed ?? {}, not_covered: report?.not_covered ?? [], links_revoked: true }, experiment });
});

/** Delete one participant session (CR-69; recon R6's per-session erase), with its receipt; the link's counter follows. */
curriculum.delete("/experiments/:id/sessions/:sid", async (c) => {
  const r = await evidenceDeleter(c, c.req.param("id"));
  if (r instanceof Response) return r;
  const sid = c.req.param("sid");
  if (!/^ps-[0-9a-f]{32}$/.test(sid)) return unknownRoute(c);
  const link = await r.record.sessionLink(PUBLISHED_HOST, sid);
  if (!link || link.task !== r.experiment.id) return unknownRoute(c);
  const now = Date.now();
  const report = await r.record.deleteSession(PUBLISHED_HOST, sid, { by: "user", at: now });
  if (link.attribution?.link) await releaseErasedSession(c.env.HPS_DB, link.attribution.link, sid);
  return c.json({ receipt: { kind: "participant_session_deleted", experiment_id: r.experiment.id, session_id: sid, at: now, deleted_by: r.by, removed: report.removed, not_covered: report.not_covered } });
});

// ── Venture Memory (cr-memory #1395; CR-35–CR-42, CR-75–CR-79, CR-82) ─────────
//
// Structure lives in the `cr_*` documents (migrations 0032, 0034); evidence items are read from
// the experiments' measurement-core records on every request and never copied (SX-48). Reads
// serve a member of the Project or a director whose issuer scope covers its cohort and profile
// (CR-37, SX-38: the issuer identity, no new role); writes serve members only.

/** Policy bounds on what one Project's memory may hold (each a fixed-size D1 row). */
export const MEMORY_LIMITS = { decisionsPerProject: 500, stakeholdersPerProject: 30, metricsPerProject: 30, hypothesesPerProject: 100, slideRevisions: 200, problemRevisions: 50, hypothesisRevisions: 50 } as const;

/** The issuer scope covers this Project's cohort and profile (R5, CR-37). */
const scopeCovers = (payload: TokenPayload, project: Project) => (payload.scopes ?? []).some((sc) => sc.cohort === project.cohort_id && (sc.profiles ?? []).includes(project.profile_id));

/** An issuer for whom at least one scoped profile has the switch on, else the unknown-route answer (no D1 read before, CR-02). */
async function director(c: Ctx): Promise<{ payload: TokenPayload } | Response> {
  const raw = bearer(c.req.header("authorization"));
  if (!raw) return unknownRoute(c);
  let payload: TokenPayload;
  try {
    payload = await verify(raw, c.env.HPS_SIGNING_SECRET);
  } catch {
    return unknownRoute(c);
  }
  if (payload.role !== "issuer") return unknownRoute(c);
  for (const p of [...new Set((payload.scopes ?? []).flatMap((sc) => sc.profiles ?? []))]) {
    const r = await resolveProfile(c.env, p);
    if (r && curriculumRuntimeAllowed(r.profile)) return { payload };
  }
  return unknownRoute(c);
}

/** The reader of a Project's memory: a member, or a director in scope (CR-37). Anyone else: the unknown route. */
async function memoryReader(c: Ctx, projectId: string): Promise<{ project: Project; by: "student" | "director" } | Response> {
  const raw = bearer(c.req.header("authorization"));
  if (!raw) return unknownRoute(c);
  let payload: TokenPayload;
  try {
    payload = await verify(raw, c.env.HPS_SIGNING_SECRET);
  } catch {
    return unknownRoute(c);
  }
  if (payload.role !== "issuer") {
    const s = await student(c);
    if (s instanceof Response) return s;
    const project = await memberProject(c, s, projectId);
    return project instanceof Response ? project : { project, by: "student" };
  }
  const d = await director(c);
  if (d instanceof Response) return d;
  if (!isVentureId(projectId)) return unknownRoute(c);
  const project = await getProject(c.env.HPS_DB, projectId);
  if (!project || !scopeCovers(d.payload, project)) return unknownRoute(c);
  const resolved = await resolveProfile(c.env, project.profile_id);
  if (!resolved || !curriculumRuntimeAllowed(resolved.profile)) return unknownRoute(c);
  noStore(c);
  if (d.payload.jti && (await isTokenRevoked(c.env.HPS_KV, d.payload.jti))) return refuse(c, 401, "revoked");
  return { project, by: "director" };
}

/** A member writing to a Project's memory, with the parsed body, or the answer to send. */
async function memberWrite(c: Ctx, projectId: string): Promise<{ s: Student; project: Project; body: Record<string, unknown> } | Response> {
  const s = await student(c);
  if (s instanceof Response) return s;
  const project = await memberProject(c, s, projectId);
  if (project instanceof Response) return project;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return refuse(c, 400, "invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse(c, 400, "invalid_json");
  return { s, project, body: body as Record<string, unknown> };
}

const recordOf = (env: Env, project: Project) => participantRecord(env.HPS_TRACES as unknown as R2Like, project.cohort_id, project.id);

/** An experiment's manual records by id, with the source_state the student gave each (SX-46). */
async function noteStatesOf(record: ReturnType<typeof participantRecord>, experimentId: string): Promise<Map<string, string | undefined>> {
  return new Map((await record.observationsOf(NOTES_HOST, experimentId)).map((o) => [o.event.id, o.event.source_state]));
}

/** An experiment's evidence items; a failed notes read leaves every note-backed item not real (fail closed). */
async function experimentItems(record: ReturnType<typeof participantRecord>, experimentId: string): Promise<EvidenceItemView[]> {
  const drafts = await record.evidenceDrafts(experimentId).catch(() => []);
  if (!drafts.length) return [];
  const states = await noteStatesOf(record, experimentId).catch(() => new Map<string, string | undefined>());
  return evidenceItemsOf(experimentId, drafts, states);
}

/**
 * The evidence items of the named experiments (or every experiment of the Project), read from
 * their records now. Refs naming an experiment of another Project are simply not found.
 */
async function itemsFor(env: Env, project: Project, experimentIds: Iterable<string>): Promise<Map<string, EvidenceItemView>> {
  const own = new Set((await experimentsOf(env.HPS_DB, project.id)).map((e) => e.id));
  const record = recordOf(env, project);
  const out = new Map<string, EvidenceItemView>();
  for (const id of new Set(experimentIds)) {
    if (!own.has(id)) continue;
    for (const it of await experimentItems(record, id)) out.set(it.id, it);
  }
  return out;
}
const experimentsOfRefs = (refs: readonly string[]) => refs.map((r) => parseEvidenceItemRef(r)?.experiment).filter((x): x is string => !!x);
const refList = (v: unknown): string[] | null => (v === undefined ? [] : Array.isArray(v) && v.length <= 30 && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 300) ? [...new Set(v as string[])] : null);
const unresolved = (refs: readonly string[], items: ReadonlyMap<string, EvidenceItemView>) => refs.filter((r) => !items.has(r));

/** Everything the Project's memory holds, assembled with no model call (CR-36): no chat history is read anywhere. */
async function loadMemory(env: Env, project: Project): Promise<MemoryState> {
  const db = env.HPS_DB;
  const [hypotheses, experiments, versions, decisions, stakeholders, metrics, slides] = await Promise.all([
    hypothesesOf(db, project.id),
    experimentsOf(db, project.id),
    versionsOf(db, project.id),
    decisionsOf(db, project.id),
    stakeholdersOf(db, project.id),
    metricsOf(db, project.id),
    slidesOf(db, project.id),
  ]);
  const record = recordOf(env, project);
  const items: EvidenceItemView[] = [];
  for (const e of experiments) items.push(...(await experimentItems(record, e.id)));
  // Participant events are read only for the experiments a metric counts over.
  const events = new Map<string, ObservationEvent[]>();
  for (const m of metrics) {
    if (m.source.type !== "event_count" || events.has(m.source.experiment_id) || !experiments.some((e) => e.id === (m.source as { experiment_id: string }).experiment_id)) continue;
    events.set(m.source.experiment_id, (await record.observationsOf(PUBLISHED_HOST, m.source.experiment_id)).map((r) => r.event));
  }
  return memoryState({ project, hypotheses, experiments, versions, decisions, stakeholders, metrics, slides, items }, events);
}

curriculum.get("/projects/:id/memory", async (c) => {
  const r = await memoryReader(c, c.req.param("id"));
  if (r instanceof Response) return r;
  return c.json({ memory: await loadMemory(c.env, r.project), read_by: r.by });
});

/** CR-77: two versions of this Project, compared by content digest; the decision behind the newer one or "no recorded decision". */
curriculum.get("/projects/:id/memory/diff", async (c) => {
  const r = await memoryReader(c, c.req.param("id"));
  if (r instanceof Response) return r;
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const [a, b] = await Promise.all([getVersion(c.env.HPS_DB, r.project.id, from), getVersion(c.env.HPS_DB, r.project.id, to)]);
  // A version of another Project is not a version of this one: the comparison is refused.
  if (!a || !b) return refuse(c, 409, "cross_project");
  const decisions = await decisionsOf(c.env.HPS_DB, r.project.id);
  const items = await itemsFor(c.env, r.project, decisions.flatMap((d) => experimentsOfRefs(d.evidence_refs)));
  const diff = versionDiff(r.project.id, a, b, decisions, items);
  if (!diff.ok) return refuse(c, 409, diff.code);
  return c.json({ diff });
});

/** CR-37: the Projects a director may traverse (issuer scope covering their cohort and profile, switch on). */
curriculum.get("/director/projects", async (c) => {
  const d = await director(c);
  if (d instanceof Response) return d;
  noStore(c);
  if (d.payload.jti && (await isTokenRevoked(c.env.HPS_KV, d.payload.jti))) return refuse(c, 401, "revoked");
  const out: Array<Pick<Project, "id" | "title" | "cohort_id" | "profile_id" | "members">> = [];
  for (const cohort of [...new Set((d.payload.scopes ?? []).map((s) => s.cohort))]) {
    for (const p of await projectsOfCohort(c.env.HPS_DB, cohort)) {
      if (!scopeCovers(d.payload, p)) continue;
      const resolved = await resolveProfile(c.env, p.profile_id);
      if (resolved && curriculumRuntimeAllowed(resolved.profile)) out.push({ id: p.id, title: p.title, cohort_id: p.cohort_id, profile_id: p.profile_id, members: p.members });
    }
  }
  return c.json({ projects: out });
});

/** CR-35 "Problem": the team's statement, a new revision; earlier statements stay. */
curriculum.put("/projects/:id/problem", async (c) => {
  const w = await memberWrite(c, c.req.param("id"));
  if (w instanceof Response) return w;
  const statement = validateHypothesisStatement(w.body.statement);
  if (!statement) return refuse(c, 400, "invalid_problem");
  if ((w.project.problem?.revisions.length ?? 0) >= MEMORY_LIMITS.problemRevisions) return refuse(c, 409, "problem_revision_limit");
  const next = await reviseProblem(c.env.HPS_DB, w.project, { statement, by: w.s.payload.u, now: Date.now() });
  if (!next) return refuse(c, 409, "stale_revision");
  return c.json({ project: next });
});

/** Resolve a stakeholder id to this Project's, or null (a missing key is "absent", not an error). */
async function ownStakeholder(env: Env, project: Project, id: unknown): Promise<string | null | undefined> {
  if (id === undefined) return undefined;
  if (!isVentureId(id)) return null;
  const s = await getStakeholder(env.HPS_DB, id);
  return s && s.project_id === project.id ? s.id : null;
}

curriculum.post("/projects/:id/hypotheses", async (c) => {
  const w = await memberWrite(c, c.req.param("id"));
  if (w instanceof Response) return w;
  const statement = validateHypothesisStatement(w.body.statement);
  if (!statement) return refuse(c, 400, "invalid_hypothesis");
  const stakeholder = await ownStakeholder(c.env, w.project, w.body.stakeholder_id);
  if (stakeholder === null) return refuse(c, 409, "stakeholder_unresolved");
  if (await openHypothesis(c.env.HPS_DB, w.project.id, statement)) return refuse(c, 409, "open_statement_exists");
  const h = await addHypothesis(c.env.HPS_DB, { project_id: w.project.id, statement, ...(stakeholder ? { stakeholder_id: stakeholder } : {}), by: w.s.payload.u, now: Date.now(), max: MEMORY_LIMITS.hypothesesPerProject });
  if (!h) {
    // INSERT OR IGNORE also swallows the unique open-statement index: a request that raced
    // another for the same statement is told so, not that the Project is full.
    if (await openHypothesis(c.env.HPS_DB, w.project.id, statement)) return refuse(c, 409, "open_statement_exists");
    return refuse(c, 409, "hypothesis_limit", { max: MEMORY_LIMITS.hypothesesPerProject });
  }
  return c.json({ hypothesis: h }, 201);
});

/**
 * CR-79: a new revision of a hypothesis. The earlier statement is kept; the revision may cite the
 * team's Decision and the evidence items that caused it. Without them the belief change reads
 * "reason not recorded", never a generated reason.
 */
curriculum.post("/projects/:id/hypotheses/:hid/revisions", async (c) => {
  const w = await memberWrite(c, c.req.param("id"));
  if (w instanceof Response) return w;
  const hid = c.req.param("hid");
  const h = isVentureId(hid) ? await getHypothesis(c.env.HPS_DB, hid) : null;
  if (!h || h.project_id !== w.project.id) return unknownRoute(c);
  if (w.body.revision !== (h.revision ?? 1)) return refuse(c, 409, "stale_revision", { latest: h.revision ?? 1 });
  if ((h.revisions?.length ?? 1) >= MEMORY_LIMITS.hypothesisRevisions) return refuse(c, 409, "hypothesis_revision_limit");
  const statement = w.body.statement === undefined ? h.statement : validateHypothesisStatement(w.body.statement);
  if (!statement) return refuse(c, 400, "invalid_hypothesis");
  const status = w.body.status;
  if (!(HYPOTHESIS_STATUSES as readonly string[]).includes(String(status))) return refuse(c, 400, "invalid_status");
  const refs = refList(w.body.evidence_refs);
  if (!refs) return refuse(c, 400, "invalid_evidence_refs");
  let decisionId: string | undefined;
  if (w.body.decision_id !== undefined) {
    const d = isVentureId(w.body.decision_id) ? await getDecision(c.env.HPS_DB, w.body.decision_id) : null;
    // Only the team's own decision can be the reason a belief changed (SX-45).
    if (!d || d.project_id !== w.project.id) return refuse(c, 409, "decision_unresolved");
    if (d.actor !== "student") return refuse(c, 409, "decision_is_ai_suggestion");
    decisionId = d.id;
  }
  const items = await itemsFor(c.env, w.project, experimentsOfRefs(refs));
  const missingRefs = unresolved(refs, items);
  if (missingRefs.length) return refuse(c, 409, "unresolved_evidence_ref", { refs: missingRefs });
  // What the team cites as the reason its belief changed follows the decision rules (CR-79,
  // CR-38): no assumption, no AI item the student has not reviewed, no unreal record.
  const refProblems = evidenceRefProblems(refs, items, "student");
  if (refProblems.length) return refuse(c, 409, "evidence_ref_refused", { problems: refProblems });
  const stakeholder = await ownStakeholder(c.env, w.project, w.body.stakeholder_id);
  if (stakeholder === null) return refuse(c, 409, "stakeholder_unresolved");
  const r = await reviseHypothesis(c.env.HPS_DB, h, { statement, status: status as Hypothesis["status"], by: w.s.payload.u, now: Date.now(), ...(decisionId ? { decision_id: decisionId } : {}), ...(refs.length ? { evidence_refs: refs } : {}), ...(stakeholder ? { stakeholder_id: stakeholder } : {}) });
  if (!r.ok) return refuse(c, 409, r.code, r.problems ? { problems: r.problems } : {});
  return c.json({ hypothesis: r.hypothesis }, 201);
});

/** CR-75: a stakeholder with its roles; a role claimed observed must cite evidence items that resolve. */
curriculum.post("/projects/:id/stakeholders", async (c) => {
  const w = await memberWrite(c, c.req.param("id"));
  if (w instanceof Response) return w;
  const v = validateStakeholder(w.body);
  if (!v.ok) return refuse(c, 400, "invalid_stakeholder", { problems: v.problems });
  const refs = v.value.roles.flatMap((r) => r.evidence_refs);
  const items = await itemsFor(c.env, w.project, experimentsOfRefs(refs));
  const missingRefs = unresolved(refs, items);
  if (missingRefs.length) return refuse(c, 409, "unresolved_evidence_ref", { refs: missingRefs });
  // A role claimed observed rests on at least one reviewed observed item; resting only on
  // assumptions or interpretations it would turn them into an observed fact (CR-75, CR-82).
  const weak = v.value.roles.filter((r) => r.basis === "observed" && !r.evidence_refs.some((ref) => supportsObservedRole(items.get(ref))));
  if (weak.length) return refuse(c, 409, "observed_role_without_observed_evidence", { problems: weak.map((r) => `observed_role_without_observed_evidence:${r.role}`) });
  const s: Stakeholder = { schema: VENTURE_SCHEMA, kind: "stakeholder", id: newVentureId("stk"), project_id: w.project.id, label: v.value.label, roles: v.value.roles, created_at: Date.now() };
  if (!(await addStakeholder(c.env.HPS_DB, s, MEMORY_LIMITS.stakeholdersPerProject))) return refuse(c, 409, "stakeholder_limit", { max: MEMORY_LIMITS.stakeholdersPerProject });
  return c.json({ stakeholder: s }, 201);
});

/** CR-75: name the stakeholder an experiment concerns (an additive key on its cr-publish record). */
curriculum.post("/experiments/:id/stakeholder", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  const id = c.req.param("id");
  const experiment = isVentureId(id) ? await getExperiment(c.env.HPS_DB, id) : null;
  if (!experiment) return unknownRoute(c);
  const project = await memberProject(c, s, experiment.project_id);
  if (project instanceof Response) return project;
  let body: { stakeholder_id?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return refuse(c, 400, "invalid_json");
  }
  const stakeholder = await ownStakeholder(c.env, project, body.stakeholder_id);
  if (!stakeholder) return refuse(c, 409, "stakeholder_unresolved");
  const set = await setExperimentStakeholder(c.env.HPS_DB, experiment, stakeholder, Date.now());
  if (!set.ok) return refuse(c, 409, set.code);
  return c.json({ experiment: set.experiment });
});

/** CR-76: a metric definition; its value is computed on every read from its source. */
curriculum.post("/projects/:id/metrics", async (c) => {
  const w = await memberWrite(c, c.req.param("id"));
  if (w instanceof Response) return w;
  const v = validateMetric(w.body);
  if (!v.ok) return refuse(c, 400, "invalid_metric", { problems: v.problems });
  if (v.value.stakeholder_id !== undefined && !(await ownStakeholder(c.env, w.project, v.value.stakeholder_id))) return refuse(c, 409, "stakeholder_unresolved");
  const src = v.value.source;
  if (src.type === "event_count") {
    const e = await getExperiment(c.env.HPS_DB, src.experiment_id);
    if (!e || e.project_id !== w.project.id) return refuse(c, 409, "experiment_unresolved");
  } else {
    const items = await itemsFor(c.env, w.project, experimentsOfRefs(src.refs));
    const missingRefs = unresolved(src.refs, items);
    if (missingRefs.length) return refuse(c, 409, "unresolved_evidence_ref", { refs: missingRefs });
  }
  const m: Metric = { schema: VENTURE_SCHEMA, kind: "metric", id: newVentureId("met"), project_id: w.project.id, ...v.value, created_at: Date.now() };
  if (!(await addMetric(c.env.HPS_DB, m, MEMORY_LIMITS.metricsPerProject))) return refuse(c, 409, "metric_limit", { max: MEMORY_LIMITS.metricsPerProject });
  return c.json({ metric: m }, 201);
});

/**
 * CR-38, CR-41, CR-82: a decision of the team (`author: "user"`, actor student, SX-45) or an AI
 * suggestion (`author: "ai"`, never shown as the team's decision). Every evidence reference must
 * be an evidence item of this Project, every assumption reference an item whose current
 * confidence is assumed, the resulting version one of this Project's; otherwise nothing is stored.
 */
curriculum.post("/projects/:id/decisions", async (c) => {
  const w = await memberWrite(c, c.req.param("id"));
  if (w instanceof Response) return w;
  if (w.body.author !== "user" && w.body.author !== "ai") return refuse(c, 400, "missing_author");
  const now = Date.now();
  const candidate = {
    id: newVentureId("dec"),
    statement: typeof w.body.statement === "string" ? w.body.statement.trim() : w.body.statement,
    evidence_refs: w.body.evidence_refs ?? [],
    assumption_refs: w.body.assumption_refs ?? [],
    resulting_version_id: w.body.resulting_version_id ?? null,
    affected_deck_slides: w.body.affected_deck_slides ?? [],
    decided_at: now,
  };
  const v = validateDecisionContract(candidate);
  if (!v.ok) return refuse(c, 400, "invalid_decision", { problems: v.problems });
  const experimentId = w.body.experiment_id;
  if (experimentId !== undefined && !isVentureId(experimentId)) return refuse(c, 400, "invalid_decision", { problems: ["invalid:experiment_id"] });
  const d = v.value;
  const items = await itemsFor(c.env, w.project, experimentsOfRefs([...d.evidence_refs, ...d.assumption_refs]));
  const versions = new Set((await versionsOf(c.env.HPS_DB, w.project.id)).map((x) => x.id));
  const experiments = new Set((await experimentsOf(c.env.HPS_DB, w.project.id)).map((x) => x.id));
  const problems = decisionRefProblems({ ...d, actor: w.body.author === "user" ? "student" : "ai", ...(experimentId !== undefined ? { experiment_id: experimentId as string } : {}) }, { items, versions, experiments });
  if (problems.length) return refuse(c, 409, "unresolved_decision_refs", { problems });
  const decision: Decision = {
    schema: VENTURE_SCHEMA,
    kind: "decision",
    ...d,
    project_id: w.project.id,
    actor: w.body.author === "user" ? "student" : "ai",
    ...(w.body.author === "user" ? { decided_by: w.s.payload.u } : {}),
    ...(experimentId !== undefined ? { experiment_id: experimentId as string } : {}),
  };
  if (!(await addDecision(c.env.HPS_DB, decision, now, MEMORY_LIMITS.decisionsPerProject))) return refuse(c, 409, "decision_limit", { max: MEMORY_LIMITS.decisionsPerProject });
  return c.json({ decision: decisionView(decision, items) }, 201);
});

/** Link the product version a decision produced, once (CR-41 `resulting_version_id`, CR-77). */
curriculum.post("/decisions/:id/version", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  const id = c.req.param("id");
  const d = isVentureId(id) ? await getDecision(c.env.HPS_DB, id) : null;
  if (!d) return unknownRoute(c);
  const project = await memberProject(c, s, d.project_id);
  if (project instanceof Response) return project;
  let body: { version_id?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return refuse(c, 400, "invalid_json");
  }
  if (typeof body.version_id !== "string" || !(await getVersion(c.env.HPS_DB, project.id, body.version_id))) return refuse(c, 409, "unresolved_version");
  if (d.resulting_version_id !== null) return refuse(c, 409, "version_already_linked");
  const next = await linkDecisionVersion(c.env.HPS_DB, d, body.version_id, Date.now());
  if (!next) return refuse(c, 409, "version_already_linked");
  return c.json({ decision: next });
});

/** One revision of one of the eight deck slides (CR-35 DeckSlides; cr-deck builds on these rows, R10). */
curriculum.put("/projects/:id/slides/:n", async (c) => {
  const w = await memberWrite(c, c.req.param("id"));
  if (w instanceof Response) return w;
  const v = validateDeckSlide({ ...w.body, number: Number(c.req.param("n")) });
  if (!v.ok) return refuse(c, 400, "invalid_slide", { problems: v.problems });
  const items = await itemsFor(c.env, w.project, experimentsOfRefs(v.value.evidence_refs));
  const missingRefs = unresolved(v.value.evidence_refs, items);
  if (missingRefs.length) return refuse(c, 409, "unresolved_evidence_ref", { refs: missingRefs });
  if (v.value.decision_id !== undefined) {
    const d = await getDecision(c.env.HPS_DB, v.value.decision_id);
    if (!d || d.project_id !== w.project.id) return refuse(c, 409, "decision_unresolved");
    // A slide changes because of the team's decision, never an AI suggestion (SX-45), as for a hypothesis revision.
    if (d.actor !== "student") return refuse(c, 409, "decision_is_ai_suggestion");
  }
  const slide = await addSlideRevision(c.env.HPS_DB, { schema: VENTURE_SCHEMA, kind: "deck_slide", project_id: w.project.id, ...v.value, at: Date.now(), by: w.s.payload.u }, MEMORY_LIMITS.slideRevisions);
  if (!slide) return refuse(c, 409, "slide_revision_limit");
  return c.json({ slide }, 201);
});

// ── Curriculum skills (cr-skills #1396; CR-43–CR-47; recon R7) ─────────────────
//
// A run is three calls. The App reads the registry, asks `prepare` for the run's prompt (the
// skill's instructions, its output schema, the context its contract requires, read from stored
// state, and the input), sends that prompt through the existing coach route
// (`/v1/chat/completions`) naming the skill tag and the capability in `x-hps-skill` /
// `x-hps-capability`, never a model id (CR-45), and posts the model's answer to `output`.
// `output` is the gate (CR-44): input and output schemas, then every validation rule, against
// the Project's state read again now; any problem refuses the whole answer, writes nothing and
// names every problem (422). Only the contract's write-back targets are written, evidence
// through the existing draft store (SX-48). Behind the CR switch like every route here.

/** The registry as the App lists it: the student-facing name, the tag, the input and where it writes. */
const skillListing = (s: CurriculumSkill) => ({
  skill: s.contract.skill,
  version: s.contract.version,
  tag: s.tag,
  title: s.contract.title,
  intent: s.contract.intent,
  preferred_capability: s.contract.preferred_capability,
  input_schema: s.contract.input_schema,
  write_back_targets: s.contract.write_back_targets,
});

/**
 * With `?project_id=`, also the run state of that Project as the Service reads it, so the App
 * re-derives nothing: the week a run is for (the same `runWeek` the prompt uses) and the evidence
 * items a team may act on (memory.ts `supportsTeamEvidence`, the Product Builder's choices).
 */
curriculum.get("/skills", async (c) => {
  const s = await student(c);
  if (s instanceof Response) return s;
  const listing = { curriculum: CURRICULUM, skills: [...CURRICULUM_SKILLS.values()].map(skillListing) };
  const projectId = c.req.query("project_id");
  if (projectId === undefined) return c.json(listing);
  const project = await memberProject(c, s, projectId);
  if (project instanceof Response) return project;
  const memory = await loadMemory(c.env, project);
  const w = curriculumWeek(runWeek(memory, {}));
  return c.json({
    ...listing,
    run: {
      project_id: project.id,
      week: { week: w.week, question: w.question },
      team_evidence: memory.evidence_items.filter((i) => supportsTeamEvidence(i)).map((i) => ({ id: i.id, statement: i.statement })),
    },
  });
});

/**
 * The product version a run reads: the input's (of this Project only) or the newest; texts only
 * when the contract needs them. Every source file is read for the rules (an AI call in file 21 or
 * in a file over the model's bound still counts); only those within `SOURCE_LIMITS` go to the
 * model. A source file that cannot be read is named in `unread`.
 */
async function versionForSkill(env: Env, project: Project, memory: MemoryState, versionId: unknown, withSources: boolean): Promise<VersionForSkill | null | "unresolved"> {
  const v = typeof versionId === "string" ? await getVersion(env.HPS_DB, project.id, versionId) : (memory.versions.at(-1) ?? null);
  if (typeof versionId === "string" && !v) return "unresolved";
  if (!v) return null;
  const files: VersionForSkill["files"] = v.files.map((f) => ({ path: f.path }));
  const unread: string[] = [];
  if (withSources) {
    let bytes = 0;
    let read = 0;
    for (const f of files) {
      const meta = v.files.find((x) => x.path === f.path)!;
      if (!isSourcePath(f.path)) continue;
      const obj = await env.HPS_TRACES.get(testFileKey(v.id, f.path));
      if (!obj) {
        unread.push(f.path);
        continue;
      }
      f.text = await obj.text();
      if (read < SOURCE_LIMITS.files && bytes + meta.bytes <= SOURCE_LIMITS.bytes) {
        f.context = true;
        bytes += meta.bytes;
        read++;
      }
    }
  }
  return { id: v.id, entry_html: v.entry_html, files, ...(unread.length ? { unread } : {}) };
}

/** Everything one run needs, read now from stored state; or the answer to send. */
async function skillRun(c: Ctx, projectId: string, skillId: string) {
  const w = await memberWrite(c, projectId);
  if (w instanceof Response) return w;
  const skill = CURRICULUM_SKILLS.get(skillId);
  if (!skill) return refuse(c, 404, "unknown_skill");
  const input = (w.body.input ?? {}) as Record<string, unknown>;
  // The input is the skill's input schema or nothing is read (CR-44's gate starts here).
  const inputProblems = validateAgainstSchema(skill.contract.input_schema, input);
  if (inputProblems.length) return refuse(c, 422, "invalid_input", { skill: skill.tag, problems: inputProblems });
  const memory = await loadMemory(c.env, w.project);
  const needs = new Set<string>(skill.contract.required_context);
  const version = needs.has("version_files") || needs.has("version_sources") || skill.contract.validation_rules.some((r) => r.startsWith("product_") || r.startsWith("critic_")) ? await versionForSkill(c.env, w.project, memory, input.version_id, needs.has("version_sources") || skill.contract.validation_rules.includes("critic_reviews_ai_failure")) : null;
  if (version === "unresolved") return refuse(c, 409, "version_unresolved");
  let experiment: Awaited<ReturnType<typeof memberExperiment>> | null = null;
  if (needs.has("experiment_records") || skill.contract.write_back_targets.includes("evidence_draft")) {
    experiment = typeof input.experiment_id === "string" ? await memberExperiment(c, w.s, input.experiment_id) : null;
    // An experiment of another Project is not this Project's: refused like a missing one.
    if (!experiment || experiment instanceof Response || experiment.project.id !== w.project.id) return refuse(c, 409, "experiment_unresolved");
  }
  const week = runWeek(memory, input);
  return { ...w, skill, input, memory, version, week, experiment: experiment as Exclude<typeof experiment, Response> };
}

curriculum.post("/projects/:id/skills/:skill/prepare", async (c) => {
  const r = await skillRun(c, c.req.param("id"), c.req.param("skill"));
  if (r instanceof Response) return r;
  const records = r.experiment && r.skill.contract.required_context.includes("experiment_records") ? await experimentEvidence(r.experiment.record, r.experiment.experiment, Date.now()) : null;
  const context = modelContextOf(r.skill.contract, r.memory, { week: r.week, version: r.version, records });
  return c.json({
    skill: r.skill.tag,
    capability: r.skill.contract.preferred_capability,
    // The coach route's request metadata for this run (CR-45): the skill tag and a capability, never a model id.
    headers: { "x-hps-skill": r.skill.tag, "x-hps-capability": r.skill.contract.preferred_capability },
    prompt: skillPrompt(r.skill, context, r.input),
  });
});

curriculum.post("/projects/:id/skills/:skill/output", async (c) => {
  const r = await skillRun(c, c.req.param("id"), c.req.param("skill"));
  if (r instanceof Response) return r;
  const output = r.body.output;
  const ctx = skillContextOf(r.memory, r.week, r.version);
  const checked = checkSkillOutput(r.skill, ctx, r.input, output);
  // CR-44: an invalid output writes nothing and says why.
  if (!checked.ok) return refuse(c, 422, checked.code, { skill: r.skill.tag, problems: checked.problems });
  const written: Array<{ target: string; id: string }> = [];
  for (const target of r.skill.contract.write_back_targets) {
    if (target !== "evidence_draft" || !r.experiment) continue;
    const e = r.experiment;
    if (e.experiment.data_deleted_at !== undefined) return refuse(c, 409, "experiment_data_deleted");
    const now = Date.now();
    if ((await e.record.evidenceDrafts(e.experiment.id).catch(() => [])).length >= EVIDENCE_LIMITS.maxDraftRevisionsPerExperiment) return refuse(c, 409, "draft_limit");
    await ensureExperimentTask(e.record, e.experiment, now);
    // Written as the AI (MC-22: every item a draft the student reviews), tagged with the skill (CR-45).
    const saved = await saveDraft(c, e, evidenceDraftOf(output as Record<string, unknown>, r.input, { id: newVentureId("drf"), now, skill: r.skill.tag }), now);
    if (saved instanceof Response) return saved;
    written.push({ target, id: saved.id });
  }
  return c.json({ skill: r.skill.tag, capability: r.skill.contract.preferred_capability, output, written }, written.length ? 201 : 200);
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
  // cr-evidence (#1394)
  "GET /v1/curriculum/experiments/:id/evidence",
  "POST /v1/curriculum/experiments/:id/notes",
  "POST /v1/curriculum/experiments/:id/drafts",
  "POST /v1/curriculum/experiments/:id/drafts/:draft/review",
  "DELETE /v1/curriculum/experiments/:id",
  "DELETE /v1/curriculum/experiments/:id/sessions/:sid",
  // cr-memory (#1395)
  "GET /v1/curriculum/projects/:id/memory",
  "GET /v1/curriculum/projects/:id/memory/diff",
  "GET /v1/curriculum/director/projects",
  "PUT /v1/curriculum/projects/:id/problem",
  "POST /v1/curriculum/projects/:id/hypotheses",
  "POST /v1/curriculum/projects/:id/hypotheses/:hid/revisions",
  "POST /v1/curriculum/projects/:id/stakeholders",
  "POST /v1/curriculum/experiments/:id/stakeholder",
  "POST /v1/curriculum/projects/:id/metrics",
  "POST /v1/curriculum/projects/:id/decisions",
  "POST /v1/curriculum/decisions/:id/version",
  "PUT /v1/curriculum/projects/:id/slides/:n",
  // cr-skills (#1396)
  "GET /v1/curriculum/skills",
  "POST /v1/curriculum/projects/:id/skills/:skill/prepare",
  "POST /v1/curriculum/projects/:id/skills/:skill/output",
] as const;
