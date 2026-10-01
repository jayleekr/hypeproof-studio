// Venture Memory storage for cr-publish (#1393; recon R5): the `cr_*` D1 tables of
// migration 0032. One writer per row kind, plain positional SQL. Every read that a route
// serves to a student goes through `projectFor*`, which resolves the target to its Project
// first; the route then applies R5's ownership rule (`isMember`).

import {
  VENTURE_SCHEMA,
  hypothesisRevisionProblems,
  hypothesisRevisions,
  newLinkId,
  newVentureId,
  type DeckSlide,
  type Decision,
  type Experiment,
  type ExperimentDeclarations,
  type Hypothesis,
  type HypothesisRevision,
  type Metric,
  type Stakeholder,
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

/**
 * Create a Project unless its creator already made `max` in this cohort: the bound and the
 * insert are one statement, so creates sent at the same time cannot pass it together. null
 * when the bound refused it.
 */
export async function createProject(db: DB, input: { cohort_id: string; profile_id: string; creator: string; title: string; now: number; max: number }): Promise<Project | null> {
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
  const r = await db
    .prepare(
      "INSERT INTO cr_projects (id, cohort_id, profile_id, creator, doc, revision, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE (SELECT COUNT(*) FROM cr_projects WHERE cohort_id = ? AND creator = ?) < ?",
    )
    .bind(project.id, project.cohort_id, project.profile_id, input.creator, JSON.stringify(project), input.now, input.now, project.cohort_id, input.creator, input.max)
    .run();
  return Number(r.meta?.changes ?? 0) > 0 ? project : null;
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

export async function countVersions(db: DB, projectId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM cr_product_versions WHERE project_id = ?").bind(projectId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * Record a version of this Project. Idempotent for the same file list; a different list
 * under an existing id cannot happen (the id is the list's digest, re-computed by the route),
 * and an existing row is never updated: INSERT OR IGNORE, then read back. A new version is
 * stored only while the Project holds fewer than `max` (one statement); null when refused.
 */
export async function putVersion(
  db: DB,
  input: { project_id: string; id: string; files: ProductVersionFile[]; entry_html: string; manifest_added?: string[]; verification_report?: string; now: number; max: number },
): Promise<{ version: ProductVersion; created: boolean } | null> {
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
    .prepare("INSERT OR IGNORE INTO cr_product_versions (project_id, id, doc, created_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM cr_product_versions WHERE project_id = ?) < ?")
    .bind(version.project_id, version.id, JSON.stringify(version), input.now, version.project_id, input.max)
    .run();
  const created = Number(r.meta?.changes ?? 0) > 0;
  const stored = await getVersion(db, input.project_id, input.id);
  if (!stored) return null;
  return { version: stored, created };
}

export async function versionsOf(db: DB, projectId: string): Promise<ProductVersion[]> {
  const rows = await db.prepare("SELECT doc FROM cr_product_versions WHERE project_id = ? ORDER BY created_at").bind(projectId).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<ProductVersion>(r)).filter((v): v is ProductVersion => !!v);
}

// ── Hypothesis ───────────────────────────────────────────────────────────────

/** The Project's open hypothesis with exactly this statement (one, by the unique index). */
export async function openHypothesis(db: DB, projectId: string, statement: string): Promise<Hypothesis | null> {
  return parse<Hypothesis>(await db.prepare("SELECT doc FROM cr_hypotheses WHERE project_id = ? AND open_statement = ?").bind(projectId, statement).first());
}

/**
 * The open hypothesis with this statement, stored when there is none. One statement decides
 * (INSERT OR IGNORE on the unique open statement), so starts sent at the same time store one;
 * `created` tells which call stored it.
 */
export async function createHypothesis(db: DB, input: { project_id: string; statement: string; now: number }): Promise<{ hypothesis: Hypothesis; created: boolean }> {
  const h: Hypothesis = { schema: VENTURE_SCHEMA, kind: "hypothesis", id: newVentureId("hyp"), project_id: input.project_id, statement: input.statement, status: "open", revision: 1, created_at: input.now };
  const r = await db
    .prepare("INSERT OR IGNORE INTO cr_hypotheses (id, project_id, doc, revision, open_statement, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)")
    .bind(h.id, h.project_id, JSON.stringify(h), h.statement, input.now, input.now)
    .run();
  if (Number(r.meta?.changes ?? 0) > 0) return { hypothesis: h, created: true };
  const existing = await openHypothesis(db, input.project_id, input.statement);
  if (!existing) throw new Error("storage_failure");
  return { hypothesis: existing, created: false };
}

/**
 * Undo a hypothesis stored by a start that then failed (POST /experiments), so a retry leaves
 * no duplicate. Kept when an experiment already names it (a start sent at the same time that
 * found it and succeeded).
 */
export async function deleteHypothesis(db: DB, id: string): Promise<void> {
  await db.prepare("DELETE FROM cr_hypotheses WHERE id = ? AND NOT EXISTS (SELECT 1 FROM cr_experiments WHERE hypothesis_id = ?)").bind(id, id).run();
}

export async function getHypothesis(db: DB, id: string): Promise<Hypothesis | null> {
  return parse<Hypothesis>(await db.prepare("SELECT doc FROM cr_hypotheses WHERE id = ?").bind(id).first());
}

export async function hypothesesOf(db: DB, projectId: string): Promise<Hypothesis[]> {
  const rows = await db.prepare("SELECT doc FROM cr_hypotheses WHERE project_id = ? ORDER BY created_at").bind(projectId).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<Hypothesis>(r)).filter((h): h is Hypothesis => !!h);
}

// ── Experiment (CR-39) ───────────────────────────────────────────────────────

export type ExperimentRefusal = "hypothesis_unresolved" | "version_unresolved" | "variant_version_unresolved" | "experiment_limit";

/** The running experiment, with no link yet, that a start with this key made. */
export async function openStart(db: DB, projectId: string, startKey: string): Promise<Experiment | null> {
  return parse<Experiment>(await db.prepare("SELECT doc FROM cr_experiments WHERE project_id = ? AND open_start_key = ?").bind(projectId, startKey).first());
}

/**
 * Store an Experiment whose references resolve inside its Project: `hypothesis_id` names a
 * stored Hypothesis of the Project, and `product_version_id` (and every variant's version)
 * a stored version of the Project. Anything else is refused and nothing is written.
 *
 * One statement decides the rest, so starts sent at the same time cannot pass it together:
 * the row is inserted only while the Project holds fewer than `max` experiments, and only
 * when no running experiment without a link has the same `start_key` (the unique open start
 * key). When such an experiment exists it is answered instead (`created: false`).
 */
export async function createExperiment(
  db: DB,
  input: Omit<Experiment, "schema" | "kind" | "created_at" | "id"> & { id?: string; now: number; start_key: string; max: number },
): Promise<{ ok: true; experiment: Experiment; created: boolean } | { ok: false; code: ExperimentRefusal }> {
  const h = await getHypothesis(db, input.hypothesis_id);
  if (!h || h.project_id !== input.project_id) return { ok: false, code: "hypothesis_unresolved" };
  if (!(await getVersion(db, input.project_id, input.product_version_id))) return { ok: false, code: "version_unresolved" };
  for (const v of input.declarations?.variants ?? []) {
    if (v.product_version_id && !(await getVersion(db, input.project_id, v.product_version_id))) return { ok: false, code: "variant_version_unresolved" };
  }
  const { now, start_key: startKey, max, ...rest } = input;
  const experiment: Experiment = {
    schema: VENTURE_SCHEMA,
    kind: "experiment",
    ...rest,
    id: input.id ?? newVentureId("exp"),
    ...(input.declarations ? { declarations: input.declarations as ExperimentDeclarations } : {}),
    created_at: now,
  };
  const r = await db
    .prepare(
      "INSERT OR IGNORE INTO cr_experiments (id, project_id, hypothesis_id, product_version_id, doc, revision, open_start_key, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE (SELECT COUNT(*) FROM cr_experiments WHERE project_id = ?) < ?",
    )
    .bind(experiment.id, experiment.project_id, experiment.hypothesis_id, experiment.product_version_id, JSON.stringify(experiment), startKey, now, now, experiment.project_id, max)
    .run();
  if (Number(r.meta?.changes ?? 0) > 0) return { ok: true, experiment, created: true };
  const same = await openStart(db, experiment.project_id, startKey);
  return same ? { ok: true, experiment: same, created: false } : { ok: false, code: "experiment_limit" };
}

export async function getExperiment(db: DB, id: string): Promise<Experiment | null> {
  return parse<Experiment>(await db.prepare("SELECT doc FROM cr_experiments WHERE id = ?").bind(id).first());
}

export async function experimentsOf(db: DB, projectId: string): Promise<Experiment[]> {
  const rows = await db.prepare("SELECT doc FROM cr_experiments WHERE project_id = ? ORDER BY created_at").bind(projectId).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<Experiment>(r)).filter((e): e is Experiment => !!e);
}

// ── TestLink (CR-18, CR-19, CR-73) ───────────────────────────────────────────

/**
 * Issue a link unless the experiment already holds `max`: the bound and the insert are one
 * statement, so links requested at the same time cannot pass it together. null when refused.
 * The experiment's open start key is cleared first: from its first link on, a start with the
 * same fields is a new run, not a retry.
 */
export async function createLink(db: DB, input: { project_id: string; experiment_id: string; channel?: string; variant_id?: string; expires_at: number; now: number; max: number }): Promise<TestLink | null> {
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
  await db.prepare("UPDATE cr_experiments SET open_start_key = NULL WHERE id = ? AND open_start_key IS NOT NULL").bind(link.experiment_id).run();
  const r = await db
    .prepare(
      "INSERT INTO cr_test_links (id, project_id, experiment_id, doc, expires_at, revoked_at, created_at) SELECT ?, ?, ?, ?, ?, NULL, ? WHERE (SELECT COUNT(*) FROM cr_test_links WHERE experiment_id = ?) < ?",
    )
    .bind(link.id, link.project_id, link.experiment_id, JSON.stringify(link), link.expires_at, input.now, link.experiment_id, input.max)
    .run();
  return Number(r.meta?.changes ?? 0) > 0 ? link : null;
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
 * query, never a read of the sessions themselves (CR-73). The counter is the bound on session
 * keys and an index over them, not a second store of evidence (SX-48): the session keys in the
 * record stay the evidence (`sessionsByChannel` reads them). It can only run ahead of the
 * record by an open whose key write failed after its reservation was kept; it never runs
 * behind. Deleting session keys (the 30-day retention and the delete action, cr-evidence)
 * must recompute the link's counter in the same operation. A link without a label counts as
 * "unlabelled". Every published session is opened through a link, so none is "unknown" here;
 * `unknown` stays in the shape for sessions recorded without a link (participant-record.ts
 * `sessionsByChannel`, the record-side reading).
 */
export type ChannelCounts = { channels: Record<string, number>; unlabelled: number; unknown: number };

function addCount(out: ChannelCounts, r: { doc: string; sessions_opened: number }): void {
  const n = Number(r.sessions_opened ?? 0);
  const link = parse<TestLink>(r);
  if (!link || n <= 0) return;
  if (link.channel) out.channels[link.channel] = (out.channels[link.channel] ?? 0) + n;
  else out.unlabelled += n;
}

export async function channelCounts(db: DB, experimentId: string): Promise<ChannelCounts> {
  const rows = await db.prepare("SELECT doc, sessions_opened FROM cr_test_links WHERE experiment_id = ?").bind(experimentId).all<{ doc: string; sessions_opened: number }>();
  const out: ChannelCounts = { channels: {}, unlabelled: 0, unknown: 0 };
  for (const r of rows.results ?? []) addCount(out, r);
  return out;
}

/** `channelCounts` of every experiment of a Project, in one query (the Project read, CR-73). */
export async function channelCountsOfProject(db: DB, projectId: string): Promise<Record<string, ChannelCounts>> {
  const rows = await db.prepare("SELECT experiment_id, doc, sessions_opened FROM cr_test_links WHERE project_id = ?").bind(projectId).all<{ experiment_id: string; doc: string; sessions_opened: number }>();
  const out: Record<string, ChannelCounts> = {};
  for (const r of rows.results ?? []) addCount((out[r.experiment_id] ??= { channels: {}, unlabelled: 0, unknown: 0 }), r);
  return out;
}

// ── cr-evidence (#1394): rate windows, test-data deletion, cohort controls ─────

/**
 * Admit one more `kind` on a link in its fixed window, atomically and in one statement: false
 * when the window already holds `max` (the request answers 429 and writes nothing). Kinds:
 * `open` (session opens), `event` (event batches, all sessions of the link) and
 * `session:<id>` (one participant session's event batches, bounded per link by its session
 * bound). A rate state, never a log of what was sent.
 */
export async function admitLinkRate(db: DB, linkId: string, kind: "open" | "event" | `session:${string}`, now: number, windowMs: number, max: number): Promise<boolean> {
  const r = await db
    .prepare(
      "INSERT INTO cr_link_rates (link_id, kind, window_start, count) VALUES (?, ?, ?, 1) ON CONFLICT(link_id, kind) DO UPDATE SET " +
        "count = CASE WHEN ? - cr_link_rates.window_start >= ? THEN 1 ELSE cr_link_rates.count + 1 END, " +
        "window_start = CASE WHEN ? - cr_link_rates.window_start >= ? THEN ? ELSE cr_link_rates.window_start END " +
        "WHERE ? - cr_link_rates.window_start >= ? OR cr_link_rates.count < ?",
    )
    .bind(linkId, kind, now, now, windowMs, now, windowMs, now, now, windowMs, max)
    .run();
  return Number(r.meta?.changes ?? 0) > 0;
}

/** The experiment's links (for deletion: revoke, recompute counters). */
export async function linksOfExperiment(db: DB, experimentId: string): Promise<TestLink[]> {
  const rows = await db.prepare("SELECT doc, revoked_at FROM cr_test_links WHERE experiment_id = ? ORDER BY created_at").bind(experimentId).all<{ doc: string; revoked_at: number | null }>();
  return (rows.results ?? []).map((r) => {
    const l = parse<TestLink>(r);
    return l && r.revoked_at !== null && r.revoked_at !== undefined ? { ...l, revoked_at: r.revoked_at } : l;
  }).filter((l): l is TestLink => !!l);
}

/**
 * After an experiment's test data is deleted (CR-69): every link is revoked (no new session
 * can bring data back), its session counter is set to what the record now holds (none), and
 * the experiment is closed with the time its data was deleted. The Experiment record itself
 * stays: it is Venture Memory, and cr-memory reads it (CR-35, CR-39).
 */
/**
 * Close an experiment for the deletion of its test data, BEFORE its record is scanned (CR-69):
 * links revoked, counters reset, the Experiment record closed with `data_deleted_at` and
 * `data_deletion_pending`. From here a note, draft or review sees the deletion (409
 * `experiment_data_deleted`, or `deletedMeanwhile` for one already writing) and no participant
 * session can open. `finishExperimentDeletion` clears the pending mark once the record is clean.
 */
export async function closeExperimentAfterDeletion(db: DB, experiment: Experiment, now: number): Promise<Experiment> {
  const next: Experiment = { ...experiment, status: "closed", data_deleted_at: now, data_deletion_pending: true };
  await db.prepare("UPDATE cr_experiments SET doc = ?, revision = revision + 1, open_start_key = NULL, updated_at = ? WHERE id = ?").bind(JSON.stringify(next), now, experiment.id).run();
  await db.prepare("UPDATE cr_test_links SET revoked_at = ? WHERE experiment_id = ? AND revoked_at IS NULL").bind(now, experiment.id).run();
  await db.prepare("UPDATE cr_test_links SET sessions_opened = 0 WHERE experiment_id = ?").bind(experiment.id).run();
  await db.prepare("DELETE FROM cr_link_rates WHERE kind LIKE 'session:%' AND link_id IN (SELECT id FROM cr_test_links WHERE experiment_id = ?)").bind(experiment.id).run();
  return next;
}

/** The record of a closed experiment is clean: its deletion is no longer pending. */
export async function finishExperimentDeletion(db: DB, experiment: Experiment, now: number): Promise<Experiment> {
  const { data_deletion_pending: _pending, ...next } = experiment;
  await db.prepare("UPDATE cr_experiments SET doc = ?, revision = revision + 1, updated_at = ? WHERE id = ?").bind(JSON.stringify(next), now, experiment.id).run();
  return next;
}

/** One session key removed by a session erase: its link's counter follows the record (store.ts `reserveSession`), and its own rate window goes. */
export async function releaseErasedSession(db: DB, linkId: string, sessionId: string): Promise<void> {
  await releaseSession(db, linkId);
  await db.prepare("DELETE FROM cr_link_rates WHERE link_id = ? AND kind = ?").bind(linkId, `session:${sessionId}`).run();
}

/**
 * A manual record, a draft or a draft review was written for an experiment: its last-record
 * time moves (`cr_experiment_records`), which counts toward when the experiment ended for
 * automatic deletion (`experimentsDueForDeletion`). Never moved by a status change.
 */
export async function touchExperiment(db: DB, experimentId: string, now: number): Promise<void> {
  await db
    .prepare("INSERT INTO cr_experiment_records (experiment_id, last_record_at) VALUES (?, ?) ON CONFLICT(experiment_id) DO UPDATE SET last_record_at = MAX(cr_experiment_records.last_record_at, excluded.last_record_at)")
    .bind(experimentId, now)
    .run();
}

/**
 * The sweep deleted what an experiment that never had a link held: nothing is left to date.
 * Only when no record was written after the time the sweep acted on (`endedAt`): a note or
 * draft written while the sweep ran moved `last_record_at` past it (the routes touch before
 * they write), so the row stays and the experiment is due again 30 days after that record.
 */
export async function forgetExperimentRecords(db: DB, experimentId: string, endedAt: number): Promise<void> {
  await db.prepare("DELETE FROM cr_experiment_records WHERE experiment_id = ? AND last_record_at <= ?").bind(experimentId, endedAt).run();
}

/** Are the curriculum-runtime tables there (migrations 0032 and 0033 applied)? One read of the schema, no table touched. */
export async function curriculumTablesPresent(db: DB): Promise<boolean> {
  const names = ["cr_experiments", "cr_projects", "cr_test_links", "cr_cohort_controls", "cr_link_rates", "cr_experiment_records"];
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => "?").join(", ")})`).bind(...names).first<{ n: number }>();
  return Number(r?.n ?? 0) === names.length;
}

/**
 * Experiments whose test data is due for deletion (Jay's decision 6): the experiment ended at
 * least the cohort's period ago and its data has not been deleted yet. An experiment ends at
 * the later of its last link's end (revoked, or past its expiry) and its last manual record,
 * draft or draft review (`touchExperiment`), so a note written after the link ended keeps the
 * data for the full period from that note. An experiment with a live link has not ended. One
 * with no link and no record holds nothing to delete and is not due: a planned experiment,
 * a draft, or one waiting for a later week stays as it is. `had_links` tells the caller whether
 * the experiment ever ran with participants (the sweep closes only those).
 */
export async function experimentsDueForDeletion(
  db: DB,
  now: number,
  periodFor: (cohortId: string) => number,
): Promise<Array<{ experiment: Experiment; project: Project; ended_at: number; had_links: boolean }>> {
  const rows = await db
    .prepare(
      "SELECT e.doc AS doc, p.doc AS project_doc, r.last_record_at AS last_record_at, COUNT(l.id) AS links, MAX(COALESCE(l.revoked_at, l.expires_at)) AS link_end, " +
        "MAX(CASE WHEN l.id IS NOT NULL AND l.revoked_at IS NULL AND l.expires_at > ? THEN 1 ELSE 0 END) AS live " +
        "FROM cr_experiments e JOIN cr_projects p ON p.id = e.project_id LEFT JOIN cr_experiment_records r ON r.experiment_id = e.id LEFT JOIN cr_test_links l ON l.experiment_id = e.id GROUP BY e.id",
    )
    .bind(now)
    .all<{ doc: string; project_doc: string; last_record_at: number | null; links: number; link_end: number | null; live: number }>();
  const out: Array<{ experiment: Experiment; project: Project; ended_at: number; had_links: boolean }> = [];
  for (const r of rows.results ?? []) {
    if (Number(r.live) > 0) continue;
    const hadLinks = Number(r.links) > 0;
    const lastRecord = r.last_record_at === null || r.last_record_at === undefined ? null : Number(r.last_record_at);
    if (!hadLinks && lastRecord === null) continue;
    const experiment = parse<Experiment>(r);
    const project = parse<Project>({ doc: r.project_doc });
    if (!experiment || !project) continue;
    // A deletion that failed half-way (CR-69) is due again at once, whatever the period.
    if (experiment.data_deletion_pending === true) {
      out.push({ experiment, project, ended_at: experiment.data_deleted_at ?? 0, had_links: hadLinks });
      continue;
    }
    if (experiment.data_deleted_at !== undefined) continue;
    const endedAt = Math.max(hadLinks ? Number(r.link_end) : -Infinity, lastRecord ?? -Infinity);
    if (now - endedAt >= periodFor(project.cohort_id)) out.push({ experiment, project, ended_at: endedAt, had_links: hadLinks });
  }
  return out.sort((a, b) => a.ended_at - b.ended_at);
}

// CR-70 — per-cohort data controls and team ceilings, set by the admin.
export interface CohortControls {
  schema: typeof VENTURE_SCHEMA;
  kind: "cohort_controls";
  cohort_id: string;
  /** Days after an experiment ends before its test data is deleted (decision 6: 30 by default). */
  retention_days_after_end: number;
  /** May an experiment of this cohort declare raw-input retention (CR-67)? Declared input is kept for the retention above, no longer. */
  raw_input_allowed: boolean;
  /** The link expiry the publish panel offers first, in days; null = the student must choose (CR-19). */
  link_expiry_default_days: number | null;
  /** May students delete their experiment's test data themselves (CR-69)? Directors and admins always may. */
  student_deletion: boolean;
  /** Budget ceilings per team (Project), by meter; enforced on the gateway path by cr-gateway (CR-34). */
  team_ceilings: Record<string, Record<string, number>>;
  revision: number;
  updated_at: number;
  updated_by: string;
}

/** Decision 6 (2026-10-01): participant records are deleted 30 days after the experiment ends. */
export const DEFAULT_RETENTION_DAYS = 30;

export function defaultCohortControls(cohortId: string): CohortControls {
  return { schema: VENTURE_SCHEMA, kind: "cohort_controls", cohort_id: cohortId, retention_days_after_end: DEFAULT_RETENTION_DAYS, raw_input_allowed: true, link_expiry_default_days: null, student_deletion: true, team_ceilings: {}, revision: 0, updated_at: 0, updated_by: "default" };
}

export async function getCohortControls(db: DB, cohortId: string): Promise<CohortControls> {
  return parse<CohortControls>(await db.prepare("SELECT doc FROM cr_cohort_controls WHERE cohort_id = ?").bind(cohortId).first()) ?? defaultCohortControls(cohortId);
}

export async function allCohortControls(db: DB): Promise<Map<string, CohortControls>> {
  const rows = await db.prepare("SELECT doc FROM cr_cohort_controls").all<{ doc: string }>();
  const out = new Map<string, CohortControls>();
  for (const r of rows.results ?? []) {
    const c = parse<CohortControls>(r);
    if (c) out.set(c.cohort_id, c);
  }
  return out;
}

/**
 * Write the cohort's controls at `expected_revision` (0 for the first write): one statement
 * decides, so two admins editing at the same time cannot both win (a revision conflict, AB-04).
 */
export async function putCohortControls(db: DB, next: CohortControls, expectedRevision: number): Promise<CohortControls | null> {
  const doc = JSON.stringify(next);
  const r =
    expectedRevision === 0
      ? await db.prepare("INSERT OR IGNORE INTO cr_cohort_controls (cohort_id, doc, revision, updated_by, updated_at) VALUES (?, ?, 1, ?, ?)").bind(next.cohort_id, doc, next.updated_by, next.updated_at).run()
      : await db.prepare("UPDATE cr_cohort_controls SET doc = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE cohort_id = ? AND revision = ?").bind(doc, next.updated_by, next.updated_at, next.cohort_id, expectedRevision).run();
  return Number(r.meta?.changes ?? 0) > 0 ? next : null;
}

// ── cr-memory (#1395): the rest of Venture Memory (migration 0034; CR-35–CR-42, CR-75–CR-79) ──

/** The Projects of one cohort (a director's traversal, CR-37; the route applies the issuer scope). */
export async function projectsOfCohort(db: DB, cohortId: string): Promise<Project[]> {
  const rows = await db.prepare("SELECT doc FROM cr_projects WHERE cohort_id = ? ORDER BY created_at").bind(cohortId).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<Project>(r)).filter((p): p is Project => !!p);
}

/**
 * The team's problem statement, a new revision (CR-35 "Problem"). Written at the Project's
 * current revision only (one statement decides; a concurrent write answers null), and every
 * earlier statement is kept.
 */
export async function reviseProblem(db: DB, project: Project, input: { statement: string; by: string; now: number }): Promise<Project | null> {
  const row = await db.prepare("SELECT doc, revision FROM cr_projects WHERE id = ?").bind(project.id).first<{ doc: string; revision: number }>();
  const current = parse<Project>(row);
  if (!current || !row) return null;
  const next: Project = { ...current, problem: { revisions: [...(current.problem?.revisions ?? []), { statement: input.statement, at: input.now, by: input.by }] } };
  const r = await db.prepare("UPDATE cr_projects SET doc = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?").bind(JSON.stringify(next), input.now, project.id, row.revision).run();
  return Number(r.meta?.changes ?? 0) > 0 ? next : null;
}

/** A hypothesis the team writes directly (not through a test start), with its first revision. */
export async function addHypothesis(db: DB, input: { project_id: string; statement: string; stakeholder_id?: string; by: string; now: number; max: number }): Promise<Hypothesis | null> {
  const first: HypothesisRevision = { revision: 1, statement: input.statement, status: "open", at: input.now, by: input.by };
  const h: Hypothesis = { schema: VENTURE_SCHEMA, kind: "hypothesis", id: newVentureId("hyp"), project_id: input.project_id, statement: input.statement, status: "open", revision: 1, created_at: input.now, ...(input.stakeholder_id ? { stakeholder_id: input.stakeholder_id } : {}), revisions: [first] };
  const r = await db
    .prepare("INSERT OR IGNORE INTO cr_hypotheses (id, project_id, doc, revision, open_statement, created_at, updated_at) SELECT ?, ?, ?, 1, ?, ?, ? WHERE (SELECT COUNT(*) FROM cr_hypotheses WHERE project_id = ?) < ?")
    .bind(h.id, h.project_id, JSON.stringify(h), h.statement, input.now, input.now, h.project_id, input.max)
    .run();
  return Number(r.meta?.changes ?? 0) > 0 ? h : null;
}

/**
 * A new revision of a hypothesis (CR-79): every earlier revision kept unchanged
 * (`hypothesisRevisionProblems`), written only at the revision it was read at (a concurrent
 * revision answers `stale_revision`). The open-statement key follows the status, so a test
 * start reuses a hypothesis only while it is open.
 */
export async function reviseHypothesis(
  db: DB,
  h: Hypothesis,
  input: { statement: string; status: Hypothesis["status"]; by: string; now: number; decision_id?: string; evidence_refs?: string[]; stakeholder_id?: string },
): Promise<{ ok: true; hypothesis: Hypothesis } | { ok: false; code: string; problems?: string[] }> {
  const revs = hypothesisRevisions(h);
  const rev: HypothesisRevision = {
    revision: (revs.at(-1)?.revision ?? 0) + 1,
    statement: input.statement,
    status: input.status,
    at: input.now,
    by: input.by,
    ...(input.decision_id ? { decision_id: input.decision_id } : {}),
    ...(input.evidence_refs?.length ? { evidence_refs: input.evidence_refs } : {}),
  };
  const next: Hypothesis = { ...h, statement: rev.statement, status: rev.status, revision: rev.revision, revisions: [...revs, rev], ...(input.stakeholder_id ? { stakeholder_id: input.stakeholder_id } : {}) };
  const problems = hypothesisRevisionProblems(h, next);
  if (problems.length) return { ok: false, code: "invalid_revision", problems };
  const openStatement = next.status === "open" ? next.statement : null;
  const r = await db
    .prepare("UPDATE OR IGNORE cr_hypotheses SET doc = ?, revision = ?, open_statement = ?, updated_at = ? WHERE id = ? AND revision = ?")
    .bind(JSON.stringify(next), rev.revision, openStatement, input.now, h.id, h.revision ?? 1)
    .run();
  if (Number(r.meta?.changes ?? 0) > 0) return { ok: true, hypothesis: next };
  const fresh = await getHypothesis(db, h.id);
  return { ok: false, code: fresh && fresh.statement !== next.statement && fresh.status === "open" && openStatement !== null ? "open_statement_exists" : "stale_revision" };
}

/** Name the stakeholder an experiment concerns (CR-75): an additive key on the cr-publish record, in place. */
export async function setExperimentStakeholder(db: DB, experiment: Experiment, stakeholderId: string, now: number): Promise<Experiment> {
  const fresh = (await getExperiment(db, experiment.id)) ?? experiment;
  const next: Experiment = { ...fresh, stakeholder_id: stakeholderId };
  await db.prepare("UPDATE cr_experiments SET doc = ?, revision = revision + 1, updated_at = ? WHERE id = ?").bind(JSON.stringify(next), now, experiment.id).run();
  return next;
}

// Decisions (CR-38, CR-41)

export async function addDecision(db: DB, d: Decision, now: number, max: number): Promise<boolean> {
  const r = await db
    .prepare("INSERT INTO cr_decisions (id, project_id, doc, revision, created_at, updated_at) SELECT ?, ?, ?, 1, ?, ? WHERE (SELECT COUNT(*) FROM cr_decisions WHERE project_id = ?) < ?")
    .bind(d.id, d.project_id, JSON.stringify(d), now, now, d.project_id, max)
    .run();
  return Number(r.meta?.changes ?? 0) > 0;
}

export async function getDecision(db: DB, id: string): Promise<Decision | null> {
  return parse<Decision>(await db.prepare("SELECT doc FROM cr_decisions WHERE id = ?").bind(id).first());
}

export async function decisionsOf(db: DB, projectId: string): Promise<Decision[]> {
  const rows = await db.prepare("SELECT doc FROM cr_decisions WHERE project_id = ? ORDER BY created_at, id").bind(projectId).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<Decision>(r)).filter((d): d is Decision => !!d);
}

/** Link the version a decision produced, once (null → id): a decision is otherwise immutable. */
export async function linkDecisionVersion(db: DB, d: Decision, versionId: string, now: number): Promise<Decision | null> {
  const next: Decision = { ...d, resulting_version_id: versionId };
  const r = await db.prepare("UPDATE cr_decisions SET doc = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = 1").bind(JSON.stringify(next), now, d.id).run();
  return Number(r.meta?.changes ?? 0) > 0 ? next : null;
}

// Stakeholders (CR-75), metrics (CR-76), deck slides (CR-35)

export async function addStakeholder(db: DB, s: Stakeholder, max: number): Promise<boolean> {
  const r = await db.prepare("INSERT INTO cr_stakeholders (id, project_id, doc, created_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM cr_stakeholders WHERE project_id = ?) < ?").bind(s.id, s.project_id, JSON.stringify(s), s.created_at, s.project_id, max).run();
  return Number(r.meta?.changes ?? 0) > 0;
}

export async function stakeholdersOf(db: DB, projectId: string): Promise<Stakeholder[]> {
  const rows = await db.prepare("SELECT doc FROM cr_stakeholders WHERE project_id = ? ORDER BY created_at, id").bind(projectId).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<Stakeholder>(r)).filter((x): x is Stakeholder => !!x);
}

export async function addMetric(db: DB, m: Metric, max: number): Promise<boolean> {
  const r = await db.prepare("INSERT INTO cr_metrics (id, project_id, doc, created_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM cr_metrics WHERE project_id = ?) < ?").bind(m.id, m.project_id, JSON.stringify(m), m.created_at, m.project_id, max).run();
  return Number(r.meta?.changes ?? 0) > 0;
}

export async function metricsOf(db: DB, projectId: string): Promise<Metric[]> {
  const rows = await db.prepare("SELECT doc FROM cr_metrics WHERE project_id = ? ORDER BY created_at, id").bind(projectId).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<Metric>(r)).filter((x): x is Metric => !!x);
}

/** One more revision of one slide: the next number after the stored ones, one statement; an earlier revision is never rewritten. */
export async function addSlideRevision(db: DB, slide: Omit<DeckSlide, "revision">, maxRevisions: number): Promise<DeckSlide | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.prepare("SELECT MAX(revision) AS r FROM cr_deck_slides WHERE project_id = ? AND number = ?").bind(slide.project_id, slide.number).first<{ r: number | null }>();
    const revision = Number(row?.r ?? 0) + 1;
    if (revision > maxRevisions) return null;
    const doc: DeckSlide = { ...slide, revision };
    const r = await db.prepare("INSERT OR IGNORE INTO cr_deck_slides (project_id, number, revision, doc, created_at) VALUES (?, ?, ?, ?, ?)").bind(slide.project_id, slide.number, revision, JSON.stringify(doc), slide.at).run();
    if (Number(r.meta?.changes ?? 0) > 0) return doc;
  }
  return null;
}

export async function slidesOf(db: DB, projectId: string): Promise<DeckSlide[]> {
  const rows = await db.prepare("SELECT doc FROM cr_deck_slides WHERE project_id = ? ORDER BY number, revision").bind(projectId).all<{ doc: string }>();
  return (rows.results ?? []).map((r) => parse<DeckSlide>(r)).filter((x): x is DeckSlide => !!x);
}

export async function getStakeholder(db: DB, id: string): Promise<Stakeholder | null> {
  return parse<Stakeholder>(await db.prepare("SELECT doc FROM cr_stakeholders WHERE id = ?").bind(id).first());
}
