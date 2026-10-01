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
import { closeExperimentAfterDeletion, getCohortControls, releaseErasedSession, touchExperiment } from "../lib/curriculum/store";
import { reviseEvidenceDraft, type EvidenceDraft } from "../lib/measurement-core/interpretation";
import { runtimeDraft } from "../lib/measurement-core/participant-evidence";

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
 * A note or draft written after the delete read the experiment would otherwise outlive it in
 * a fresh task. When it was, what the record holds for the experiment now goes too.
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
  await ensureExperimentTask(r.record, r.experiment, now);
  try {
    await addNote(r.record, r.experiment, built.event);
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (/^(invalid_|missing_|identity_field|ai_text_as_student|unsupported_)/.test(code)) return refuse(c, 400, code);
    throw e;
  }
  if (await deletedMeanwhile(c, r)) return refuse(c, 409, "experiment_data_deleted");
  // The experiment's last record moved (when it ends for automatic deletion, decision 6).
  await touchExperiment(c.env.HPS_DB, r.experiment.id, now);
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
  let saved: Awaited<ReturnType<typeof r.record.saveEvidenceDraft>>;
  try {
    saved = await r.record.saveEvidenceDraft(r.experiment.id, draft, { quota: "none", repeatedUse: r.experiment.declarations?.repeated_use === true });
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (/^(invalid_|unsupported_|missing_)/.test(code)) return refuse(c, 400, code);
    throw e;
  }
  if (!saved.ok) return refuse(c, 422, "unresolved_source_refs", { refusals: saved.refusals });
  if (await deletedMeanwhile(c, r)) return refuse(c, 409, "experiment_data_deleted");
  await touchExperiment(c.env.HPS_DB, r.experiment.id, now);
  return c.json({ draft: saved.draft }, 201);
});

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
  const now = Date.now();
  const saved = await r.record.saveEvidenceDraft(r.experiment.id, next, { quota: "none", repeatedUse: r.experiment.declarations?.repeated_use === true });
  if (!saved.ok) return refuse(c, 422, "unresolved_source_refs", { refusals: saved.refusals });
  if (await deletedMeanwhile(c, r)) return refuse(c, 409, "experiment_data_deleted");
  await touchExperiment(c.env.HPS_DB, r.experiment.id, now);
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
  let report: Awaited<ReturnType<typeof r.record.deleteTask>> | null = null;
  try {
    report = await r.record.deleteTask(r.experiment.id, { by: "user", at: now });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "unknown_task") throw e;
  }
  const experiment = await closeExperimentAfterDeletion(c.env.HPS_DB, r.experiment, now);
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
] as const;
