// Venture Memory storage for cr-publish (#1393; recon R5): the `cr_*` D1 tables of
// migration 0032. One writer per row kind, plain positional SQL. Every read that a route
// serves to a student goes through `projectFor*`, which resolves the target to its Project
// first; the route then applies R5's ownership rule (`isMember`).

import {
  VENTURE_SCHEMA,
  newLinkId,
  newVentureId,
  type Experiment,
  type ExperimentDeclarations,
  type Hypothesis,
  type ProductVersion,
  type ProductVersionFile,
  type Project,
  type TestLink,
} from "./venture.ts";

type DB = D1Database;

const parse = <T>(row: { doc?: unknown } | null | undefined): T | null => {
  if (!row || typeof row.doc !== "string") return null;
  try {
    return JSON.parse(row.doc) as T;
  } catch {
    return null;
  }
};

/** R5 "Ownership": the token's cohort is the Project's, and its student is a member. */
export function isMember(project: Project, token: { c: string; u: string }): boolean {
  return project.cohort_id === token.c && project.members.includes(token.u);
}

// ── Project ──────────────────────────────────────────────────────────────────

export async function createProject(db: DB, input: { cohort_id: string; profile_id: string; creator: string; title: string; now: number }): Promise<Project> {
  const project: Project = {
    schema: VENTURE_SCHEMA,
    kind: "project",
    id: newVentureId("prj"),
    cohort_id: input.cohort_id,
    profile_id: input.profile_id,
    // A student-created Project starts with its creator only (Jay's decision 7).
    members: [input.creator],
    title: input.title,
    created_at: input.now,
  };
  await db
    .prepare("INSERT INTO cr_projects (id, cohort_id, profile_id, doc, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .bind(project.id, project.cohort_id, project.profile_id, JSON.stringify(project), input.now, input.now)
    .run();
  return project;
}

export async function getProject(db: DB, id: string): Promise<Project | null> {
  return parse<Project>(await db.prepare("SELECT doc FROM cr_projects WHERE id = ?").bind(id).first());
}

export async function projectsOf(db: DB, token: { c: string; u: string }): Promise<Project[]> {
  const rows = await db.prepare("SELECT doc FROM cr_projects WHERE cohort_id = ? ORDER BY created_at").bind(token.c).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<Project>(r)).filter((p): p is Project => !!p && isMember(p, token));
}

/** Members are set by the cohort's director (an issuer scoped to it), never by a student (R5). */
export async function setMembers(db: DB, project: Project, members: string[], now: number): Promise<Project> {
  const next: Project = { ...project, members: [...new Set(members)] };
  await db.prepare("UPDATE cr_projects SET doc = ?, revision = revision + 1, updated_at = ? WHERE id = ?").bind(JSON.stringify(next), now, project.id).run();
  return next;
}

// ── ProductVersion (content-addressed; immutable) ───────────────────────────

export async function getVersion(db: DB, projectId: string, id: string): Promise<ProductVersion | null> {
  return parse<ProductVersion>(await db.prepare("SELECT doc FROM cr_product_versions WHERE project_id = ? AND id = ?").bind(projectId, id).first());
}

/**
 * Record a version of this Project. Idempotent for the same file list; a different list
 * under an existing id cannot happen (the id is the list's digest, re-computed by the route),
 * and an existing row is never updated: INSERT OR IGNORE, then read back.
 */
export async function putVersion(
  db: DB,
  input: { project_id: string; id: string; files: ProductVersionFile[]; entry_html: string; manifest_added?: string[]; verification_report?: string; now: number },
): Promise<{ version: ProductVersion; created: boolean }> {
  const version: ProductVersion = {
    schema: VENTURE_SCHEMA,
    kind: "product_version",
    id: input.id,
    project_id: input.project_id,
    files: input.files,
    entry_html: input.entry_html,
    ...(input.manifest_added?.length ? { manifest_added: input.manifest_added } : {}),
    ...(input.verification_report ? { verification_report: input.verification_report } : {}),
    created_at: input.now,
  };
  const r = await db
    .prepare("INSERT OR IGNORE INTO cr_product_versions (project_id, id, doc, created_at) VALUES (?, ?, ?, ?)")
    .bind(version.project_id, version.id, JSON.stringify(version), input.now)
    .run();
  const created = Number(r.meta?.changes ?? 0) > 0;
  const stored = await getVersion(db, input.project_id, input.id);
  if (!stored) throw new Error("storage_failure");
  return { version: stored, created };
}

export async function versionsOf(db: DB, projectId: string): Promise<ProductVersion[]> {
  const rows = await db.prepare("SELECT doc FROM cr_product_versions WHERE project_id = ? ORDER BY created_at").bind(projectId).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<ProductVersion>(r)).filter((v): v is ProductVersion => !!v);
}

// ── Hypothesis ───────────────────────────────────────────────────────────────

export async function createHypothesis(db: DB, input: { project_id: string; statement: string; now: number }): Promise<Hypothesis> {
  const h: Hypothesis = { schema: VENTURE_SCHEMA, kind: "hypothesis", id: newVentureId("hyp"), project_id: input.project_id, statement: input.statement, status: "open", revision: 1, created_at: input.now };
  await db.prepare("INSERT INTO cr_hypotheses (id, project_id, doc, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").bind(h.id, h.project_id, JSON.stringify(h), input.now, input.now).run();
  return h;
}

export async function getHypothesis(db: DB, id: string): Promise<Hypothesis | null> {
  return parse<Hypothesis>(await db.prepare("SELECT doc FROM cr_hypotheses WHERE id = ?").bind(id).first());
}

export async function hypothesesOf(db: DB, projectId: string): Promise<Hypothesis[]> {
  const rows = await db.prepare("SELECT doc FROM cr_hypotheses WHERE project_id = ? ORDER BY created_at").bind(projectId).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<Hypothesis>(r)).filter((h): h is Hypothesis => !!h);
}

// ── Experiment (CR-39) ───────────────────────────────────────────────────────

export type ExperimentRefusal = "hypothesis_unresolved" | "version_unresolved" | "variant_version_unresolved";

/**
 * Store an Experiment whose references resolve inside its Project: `hypothesis_id` names a
 * stored Hypothesis of the Project, and `product_version_id` (and every variant's version)
 * a stored version of the Project. Anything else is refused and nothing is written.
 */
export async function createExperiment(
  db: DB,
  input: Omit<Experiment, "schema" | "kind" | "created_at" | "id"> & { id?: string; now: number },
): Promise<{ ok: true; experiment: Experiment } | { ok: false; code: ExperimentRefusal }> {
  const h = await getHypothesis(db, input.hypothesis_id);
  if (!h || h.project_id !== input.project_id) return { ok: false, code: "hypothesis_unresolved" };
  if (!(await getVersion(db, input.project_id, input.product_version_id))) return { ok: false, code: "version_unresolved" };
  for (const v of input.declarations?.variants ?? []) {
    if (v.product_version_id && !(await getVersion(db, input.project_id, v.product_version_id))) return { ok: false, code: "variant_version_unresolved" };
  }
  const { now, ...rest } = input;
  const experiment: Experiment = {
    schema: VENTURE_SCHEMA,
    kind: "experiment",
    ...rest,
    id: input.id ?? newVentureId("exp"),
    ...(input.declarations ? { declarations: input.declarations as ExperimentDeclarations } : {}),
    created_at: now,
  };
  await db
    .prepare("INSERT INTO cr_experiments (id, project_id, hypothesis_id, product_version_id, doc, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
    .bind(experiment.id, experiment.project_id, experiment.hypothesis_id, experiment.product_version_id, JSON.stringify(experiment), now, now)
    .run();
  return { ok: true, experiment };
}

export async function getExperiment(db: DB, id: string): Promise<Experiment | null> {
  return parse<Experiment>(await db.prepare("SELECT doc FROM cr_experiments WHERE id = ?").bind(id).first());
}

export async function experimentsOf(db: DB, projectId: string): Promise<Experiment[]> {
  const rows = await db.prepare("SELECT doc FROM cr_experiments WHERE project_id = ? ORDER BY created_at").bind(projectId).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<Experiment>(r)).filter((e): e is Experiment => !!e);
}

// ── TestLink (CR-18, CR-19, CR-73) ───────────────────────────────────────────

export async function createLink(db: DB, input: { project_id: string; experiment_id: string; channel?: string; variant_id?: string; expires_at: number; now: number }): Promise<TestLink> {
  const link: TestLink = {
    schema: VENTURE_SCHEMA,
    kind: "test_link",
    id: newLinkId(),
    project_id: input.project_id,
    experiment_id: input.experiment_id,
    ...(input.variant_id ? { variant_id: input.variant_id } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    expires_at: input.expires_at,
    created_at: input.now,
  };
  await db
    .prepare("INSERT INTO cr_test_links (id, project_id, experiment_id, doc, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)")
    .bind(link.id, link.project_id, link.experiment_id, JSON.stringify(link), link.expires_at, input.now)
    .run();
  return link;
}

/** The link as stored; `revoked_at` is the column (set once), merged over the document. */
export async function getLink(db: DB, id: string): Promise<TestLink | null> {
  const row = await db.prepare("SELECT doc, revoked_at FROM cr_test_links WHERE id = ?").bind(id).first<{ doc: string; revoked_at: number | null }>();
  const link = parse<TestLink>(row);
  if (!link || !row) return null;
  return row.revoked_at === null || row.revoked_at === undefined ? link : { ...link, revoked_at: row.revoked_at };
}

export async function linksOf(db: DB, projectId: string): Promise<TestLink[]> {
  const rows = await db.prepare("SELECT doc, revoked_at FROM cr_test_links WHERE project_id = ? ORDER BY created_at").bind(projectId).all<{ doc: string; revoked_at: number | null }>();
  return (rows.results ?? []).map((r) => {
    const l = parse<TestLink>(r);
    return l && r.revoked_at !== null && r.revoked_at !== undefined ? { ...l, revoked_at: r.revoked_at } : l;
  }).filter((l): l is TestLink => !!l);
}

/** Revocation is final and idempotent: the first revocation time stays. */
export async function revokeLink(db: DB, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE cr_test_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run();
}

// ── Participant sessions per link (CR-21, CR-73) ─────────────────────────────

/**
 * Reserve one participant session on a link, atomically and in one statement: false when the
 * link already holds `max` (the per-link bound on session keys in the record). A reservation
 * whose session turns out to exist already is handed back with `releaseSession`.
 */
export async function reserveSession(db: DB, linkId: string, max: number): Promise<boolean> {
  const r = await db.prepare("UPDATE cr_test_links SET sessions_opened = sessions_opened + 1 WHERE id = ? AND sessions_opened < ?").bind(linkId, max).run();
  return Number(r.meta?.changes ?? 0) > 0;
}

export async function releaseSession(db: DB, linkId: string): Promise<void> {
  await db.prepare("UPDATE cr_test_links SET sessions_opened = sessions_opened - 1 WHERE id = ? AND sessions_opened > 0").bind(linkId).run();
}

/**
 * Sessions opened per channel for one experiment, from the per-link counters: one indexed
 * query, never a read of the sessions themselves (CR-73). A link without a label counts as
 * "unlabelled". Every published session is opened through a link, so none is "unknown" here;
 * `unknown` stays in the shape for sessions recorded without a link (participant-record.ts
 * `sessionsByChannel`, the record-side reading).
 */
export async function channelCounts(db: DB, experimentId: string): Promise<{ channels: Record<string, number>; unlabelled: number; unknown: number }> {
  const rows = await db.prepare("SELECT doc, sessions_opened FROM cr_test_links WHERE experiment_id = ?").bind(experimentId).all<{ doc: string; sessions_opened: number }>();
  const out = { channels: {} as Record<string, number>, unlabelled: 0, unknown: 0 };
  for (const r of rows.results ?? []) {
    const n = Number(r.sessions_opened ?? 0);
    const link = parse<TestLink>(r);
    if (!link || n <= 0) continue;
    if (link.channel) out.channels[link.channel] = (out.channels[link.channel] ?? 0) + n;
    else out.unlabelled += n;
  }
  return out;
}
