// Venture Memory records created by cr-publish (#1393; recon R5, §6; CR-17, CR-39, CR-73).
//
// One module, one validator per kind, the `hps-session-design/1` convention: a record is a
// versioned JSON document (`schema: "hps-venture/1"`) stored in the D1 tables of migration
// 0032 (`cr_*`), holding structure and references only. Evidence and observations are never
// copied here; they stay in the measurement-core record (SX-48, R6). cr-memory extends these
// same records and tables instead of creating its own (CR-35).
//
// cr-publish creates Project, Hypothesis, Experiment (CR-39, every PRD §10.1 field),
// ProductVersion (the R4 published file set) and TestLink. Pure: no env, no storage.

import { identityFieldProblems } from "../measurement-core/learning-events.ts";

export const VENTURE_SCHEMA = "hps-venture/1";

export const HYPOTHESIS_STATUSES = ["open", "supported", "refuted", "revised"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];
export const EXPERIMENT_STATUSES = ["draft", "running", "closed"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export const DEVICES = ["microphone", "camera"] as const;
export type Device = (typeof DEVICES)[number];

/** PRD §10.1, in order. Every one is required; none is dropped by the adaptation (CR-39). */
export const EXPERIMENT_FIELDS = ["id", "project_id", "week", "hypothesis_id", "question", "method", "success_criteria", "product_version_id", "status"] as const;

export interface Project {
  schema: typeof VENTURE_SCHEMA;
  kind: "project";
  id: string;
  cohort_id: string;
  profile_id: string;
  /** Student ids of the team, each on the cohort roster (R5 "Ownership"). */
  members: string[];
  title: string;
  created_at: number;
  /**
   * The team's problem statement (cr-memory, CR-35 "Problem"; additive, decision 8). Every
   * statement the team wrote is kept, oldest first; the last is the current one. Absent until
   * the team writes one.
   */
  problem?: { revisions: Array<{ statement: string; at: number; by: string }> };
}

export interface Hypothesis {
  schema: typeof VENTURE_SCHEMA;
  kind: "hypothesis";
  id: string;
  project_id: string;
  statement: string;
  status: HypothesisStatus;
  revision: number;
  created_at: number;
  /** The stakeholder this hypothesis concerns (cr-memory, CR-75; additive). */
  stakeholder_id?: string;
  /**
   * Every revision, oldest first (cr-memory, CR-79; additive). The top-level `statement`,
   * `status` and `revision` are the last entry's. A record written before cr-memory has no
   * list and reads as its one revision (`hypothesisRevisions`). A later revision never
   * rewrites an earlier one (`hypothesisRevisionProblems`).
   */
  revisions?: HypothesisRevision[];
}

/** One revision of a hypothesis and what caused it (CR-79). */
export interface HypothesisRevision {
  revision: number;
  statement: string;
  status: HypothesisStatus;
  at: number;
  /** The team member who recorded it, or "service" for the first revision a test start stored. */
  by: string;
  /** The Decision that caused this revision (a student decision of the same Project), when recorded. */
  decision_id?: string;
  /** The evidence items (`ev:` refs) the revision cites, when recorded. */
  evidence_refs?: string[];
}

/**
 * What an experiment declares for other rows. Absent until declared (CR-39): repeated-use
 * measurement (CR-65, CR-72), device need (CR-66), raw-input retention (CR-67, CR-83) and
 * comparison variants (CR-74). cr-evidence and cr-memory add theirs to this same object.
 */
export interface ExperimentDeclarations {
  repeated_use?: true;
  devices?: Device[];
  raw_input?: { fields: string[] };
  variants?: Array<{ id: string; product_version_id?: string; alternative?: string }>;
  /**
   * The task and milestone names the app reports through `window.hypeproof.test.task/milestone`
   * (cr-evidence, CR-23, CR-67; additive per decision 8). A label is free text the page sends,
   * so only a declared name is stored: an event naming anything else (a typed value passed as a
   * label) is dropped, never kept.
   */
  labels?: string[];
}

export interface Experiment {
  schema: typeof VENTURE_SCHEMA;
  kind: "experiment";
  id: string;
  project_id: string;
  week: number;
  hypothesis_id: string;
  question: string;
  method: string;
  success_criteria: string[];
  product_version_id: string;
  status: ExperimentStatus;
  declarations?: ExperimentDeclarations;
  /** The stakeholder this experiment concerns (cr-memory, CR-75; additive). */
  stakeholder_id?: string;
  /** When the experiment's test data was deleted (cr-evidence, CR-69); absent until then. */
  data_deleted_at?: number;
  /**
   * Set with `data_deleted_at` before the record is scanned and cleared once the scan finished
   * (cr-evidence, CR-69): a deletion that failed half-way is due again on the next sweep.
   */
  data_deletion_pending?: true;
  created_at: number;
}

export interface ProductVersionFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ProductVersion {
  schema: typeof VENTURE_SCHEMA;
  kind: "product_version";
  /** The R4 digest of `files` (`digestOf` of the sorted list). */
  id: string;
  project_id: string;
  files: ProductVersionFile[];
  entry_html: string;
  /** Files the student added beyond static reach (R4 manifest). */
  manifest_added?: string[];
  /** The `run_id` of an all-pass `hps-verification/1` report on this version, as the App read it (CR-81). */
  verification_report?: string;
  created_at: number;
}

export interface TestLink {
  schema: typeof VENTURE_SCHEMA;
  kind: "test_link";
  /** Random; the URL token. */
  id: string;
  project_id: string;
  experiment_id: string;
  variant_id?: string;
  /** The channel the student uses this link in (CR-73); absent = no label. */
  channel?: string;
  /** Required while no default expiry is set (CR-19, an open decision of Jay's). */
  expires_at: number;
  revoked_at?: number;
  created_at: number;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; problems: string[] };

// Ids are opaque. The PRD §10.1 sample uses `exp_001`; Service-made ids use a hyphen so a
// project id is also a DNS label of its test origin.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

export const isVentureId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

/** A channel label: the student's own short words (a school notice board, a direct message). */
export const CHANNEL_MAX = 40;
export function normalizeChannel(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > CHANNEL_MAX) return null;
  return t;
}

/**
 * The Experiment contract of PRD §10.1 (CR-39). Shape only: the PRD sample validates, a
 * sample missing any one field is refused. Whether `hypothesis_id` and `product_version_id`
 * resolve is the store's check (`createExperiment`), not this one.
 */
export function validateExperimentContract(v: unknown): Validation<Omit<Experiment, "schema" | "kind" | "created_at">> {
  const problems: string[] = [];
  if (!isObj(v)) return { ok: false, problems: ["not_an_object"] };
  for (const f of EXPERIMENT_FIELDS) if (!(f in v) || v[f] === undefined || v[f] === null) problems.push(`missing:${f}`);
  if ("id" in v && v.id != null && !isVentureId(v.id)) problems.push("invalid:id");
  if ("project_id" in v && v.project_id != null && !isVentureId(v.project_id)) problems.push("invalid:project_id");
  if ("hypothesis_id" in v && v.hypothesis_id != null && !isVentureId(v.hypothesis_id)) problems.push("invalid:hypothesis_id");
  if ("week" in v && v.week != null && !(Number.isInteger(v.week) && (v.week as number) >= 1 && (v.week as number) <= 52)) problems.push("invalid:week");
  if ("question" in v && v.question != null && !str(v.question, 500)) problems.push("invalid:question");
  if ("method" in v && v.method != null && !str(v.method, 100)) problems.push("invalid:method");
  if ("success_criteria" in v && v.success_criteria != null) {
    const sc = v.success_criteria;
    if (!Array.isArray(sc) || sc.length < 1 || sc.length > 10 || !sc.every((x) => str(x, 300))) problems.push("invalid:success_criteria");
  }
  if ("product_version_id" in v && v.product_version_id != null && !str(v.product_version_id, 100)) problems.push("invalid:product_version_id");
  if ("status" in v && v.status != null && !(EXPERIMENT_STATUSES as readonly string[]).includes(String(v.status))) problems.push("invalid:status");
  if (v.declarations !== undefined) problems.push(...declarationProblems(v.declarations));
  if (v.stakeholder_id !== undefined && !isVentureId(v.stakeholder_id)) problems.push("invalid:stakeholder_id");
  if (problems.length) return { ok: false, problems };
  const out: Omit<Experiment, "schema" | "kind" | "created_at"> = {
    id: v.id as string,
    project_id: v.project_id as string,
    week: v.week as number,
    hypothesis_id: v.hypothesis_id as string,
    question: (v.question as string).trim(),
    method: (v.method as string).trim(),
    success_criteria: (v.success_criteria as string[]).map((s) => s.trim()),
    product_version_id: v.product_version_id as string,
    status: v.status as ExperimentStatus,
    ...(v.declarations !== undefined ? { declarations: v.declarations as ExperimentDeclarations } : {}),
    ...(v.stakeholder_id !== undefined ? { stakeholder_id: v.stakeholder_id as string } : {}),
  };
  return { ok: true, value: out };
}

/** Task and milestone names one experiment may declare (`declarations.labels`). */
export const MAX_DECLARED_LABELS = 30;

export function declarationProblems(d: unknown): string[] {
  if (!isObj(d)) return ["invalid:declarations"];
  const problems: string[] = [];
  for (const k of Object.keys(d)) if (!["repeated_use", "devices", "raw_input", "variants", "labels"].includes(k)) problems.push(`invalid:declarations.${k}`);
  if (d.repeated_use !== undefined && d.repeated_use !== true) problems.push("invalid:declarations.repeated_use");
  if (d.devices !== undefined) {
    const ds = d.devices;
    if (!Array.isArray(ds) || ds.length === 0 || !ds.every((x) => (DEVICES as readonly string[]).includes(String(x))) || new Set(ds).size !== ds.length) problems.push("invalid:declarations.devices");
  }
  if (d.raw_input !== undefined) {
    const r = d.raw_input;
    if (!isObj(r) || !Array.isArray(r.fields) || r.fields.length === 0 || !r.fields.every((x) => str(x, 60))) problems.push("invalid:declarations.raw_input");
    // CR-65: no name, e-mail or phone field, so an identity-like field is never declared for keeping.
    else if (identityFieldProblems((r.fields as string[]).map((x) => x.trim())).length) problems.push("invalid:declarations.raw_input");
  }
  if (d.labels !== undefined) {
    const ls = d.labels;
    if (!Array.isArray(ls) || ls.length === 0 || ls.length > MAX_DECLARED_LABELS || !ls.every((x) => str(x, 80)) || new Set(ls.map((x) => String(x).trim())).size !== ls.length) problems.push("invalid:declarations.labels");
  }
  if (d.variants !== undefined) {
    const vs = d.variants;
    if (!Array.isArray(vs) || vs.length === 0 || vs.length > 4 || !vs.every((x) => isObj(x) && isVentureId(x.id) && (x.product_version_id === undefined || str(x.product_version_id, 100)) && (x.alternative === undefined || str(x.alternative, 300))))
      problems.push("invalid:declarations.variants");
  }
  return problems;
}

export function validateHypothesisStatement(v: unknown): string | null {
  return str(v, 500) ? v.trim() : null;
}

/** The R4 published-file-set path rule, shared by the App's set builder and the Worker. */
export function publishPathProblem(p: unknown): string | null {
  if (typeof p !== "string" || !p || p.length > 300) return "invalid_path";
  if (p.includes("\\") || p.startsWith("/") || /[\u0000-\u001f\u007f]/.test(p)) return "invalid_path";
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "invalid_path";
  if (segs.some((s) => s.startsWith(".") || s === "node_modules")) return "excluded_path";
  return null;
}

/** A Service-made id: prefix + 16 random hex characters, also a DNS label. */
export function newVentureId(prefix: "prj" | "hyp" | "exp" | "drf" | "note" | "dec" | "stk" | "met"): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `${prefix}-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** A link id is the URL token: 128 random bits, base64url. */
export function newLinkId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export const LINK_ID = /^[A-Za-z0-9_-]{22}$/;

/** Is the link serving right now? Revoked or expired links answer 410 with no content (CR-19). */
export function linkState(link: Pick<TestLink, "expires_at" | "revoked_at">, now: number): "live" | "revoked" | "expired" {
  if (link.revoked_at !== undefined && link.revoked_at !== null) return "revoked";
  if (!(now < link.expires_at)) return "expired";
  return "live";
}

/** The version a link of this experiment serves: the variant's when it names one, else the experiment's (CR-22). */
export function pinnedVersion(experiment: Pick<Experiment, "product_version_id" | "declarations">, variantId?: string): string | null {
  if (!variantId) return experiment.product_version_id;
  const v = experiment.declarations?.variants?.find((x) => x.id === variantId);
  if (!v) return null;
  return v.product_version_id ?? experiment.product_version_id;
}

// ── cr-memory (#1395): the rest of Venture Memory (PRD §10, P0-6; CR-35–CR-42, CR-75–CR-79, CR-82) ──
//
// Same convention: one validator per kind in this module, `hps-venture/1` documents in the
// `cr_*` tables (migration 0034 adds decisions, stakeholders, metrics and deck slides), holding
// structure and references only. Evidence items and observations are NOT stored here: an
// evidence item is an item of an `hps-evidence-draft/1` revision in the measurement-core record
// (cr-evidence), named by an `ev:` reference (below) and read from that record every time
// (SX-48, MC-15). The Hypothesis and Experiment records cr-publish created are extended in
// place (`revisions`, `stakeholder_id` above); no second hypothesis or experiment record exists.

/**
 * An evidence item's reference: `ev:<experiment>/<draft>/<item>`. The item is that draft's
 * item in the experiment's measurement-core record; its current revision is the draft's latest.
 */
export const EVIDENCE_ITEM_REF = /^ev:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/([A-Za-z0-9_-]{1,100})\/(.{1,60})$/;
export const evidenceItemRef = (experimentId: string, draftId: string, itemId: string) => `ev:${experimentId}/${draftId}/${itemId}`;
export function parseEvidenceItemRef(ref: unknown): { experiment: string; draft: string; item: string } | null {
  const m = typeof ref === "string" ? EVIDENCE_ITEM_REF.exec(ref) : null;
  return m ? { experiment: m[1]!, draft: m[2]!, item: m[3]! } : null;
}

export const CONFIDENCES = ["observed", "interpreted", "assumed"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** PRD §10.2 (CR-40). `created_at` is a time (ms) or an ISO date; `type` names what the item is. */
export const EVIDENCE_ITEM_FIELDS = ["id", "type", "source_refs", "statement", "confidence", "created_by", "created_at"] as const;
export interface EvidenceItem {
  id: string;
  type: string;
  source_refs: string[];
  statement: string;
  confidence: Confidence;
  created_by: "student" | "system";
  created_at: number | string;
}

/** PRD §10.3 (CR-41), plus the repository's project, actor (SX-45) and member (SX-24). */
export const DECISION_FIELDS = ["id", "statement", "evidence_refs", "assumption_refs", "resulting_version_id", "affected_deck_slides", "decided_at"] as const;
export const DECK_SLIDES = 8;
export interface Decision {
  schema: typeof VENTURE_SCHEMA;
  kind: "decision";
  id: string;
  project_id: string;
  statement: string;
  /** Evidence items (`ev:` refs) the decision rests on; may be empty, and is then shown as such (CR-38). */
  evidence_refs: string[];
  /** Evidence items whose confidence is `assumed` (CR-82's rule, checked by the store). */
  assumption_refs: string[];
  /** The product version this decision produced; null until the team links it. */
  resulting_version_id: string | null;
  /** Deck slides 1–8 this decision affects. */
  affected_deck_slides: number[];
  decided_at: number | string;
  /** SX-45: a student decision, or an AI suggestion that is never shown as the team's decision. */
  actor: "student" | "ai";
  /** SX-24: the team member who recorded a student decision. */
  decided_by?: string;
  experiment_id?: string;
}

/** PRD §10.4 (CR-42). HTML is the entry format for every type. */
export const ARTIFACT_FIELDS = ["artifact_id", "type", "schema_version", "entry_html", "project_id", "version", "source_refs", "evidence_refs"] as const;
export const ARTIFACT_TYPES = ["product", "deck", "review", "report"] as const;
export interface Artifact {
  artifact_id: string;
  type: (typeof ARTIFACT_TYPES)[number];
  schema_version: number;
  entry_html: string;
  project_id: string;
  version: number;
  source_refs: string[];
  evidence_refs: string[];
}

/** CR-75. Payer and user are separate roles even when one stakeholder holds both. */
export const STAKEHOLDER_ROLES = ["user", "payer", "beneficiary"] as const;
export type StakeholderRole = (typeof STAKEHOLDER_ROLES)[number];
export interface Stakeholder {
  schema: typeof VENTURE_SCHEMA;
  kind: "stakeholder";
  id: string;
  project_id: string;
  label: string;
  /** `basis: "observed"` claims the role is observed and needs resolvable `evidence_refs`; without it the role is assumed. */
  roles: Array<{ role: StakeholderRole; evidence_refs: string[]; basis?: "observed" }>;
  created_at: number;
}

/** CR-76. A metric's value is computed on read from its source, never stored. */
export const METRIC_KINDS = ["impact", "usage", "financial"] as const;
export interface Metric {
  schema: typeof VENTURE_SCHEMA;
  kind: "metric";
  id: string;
  project_id: string;
  name: string;
  metric_kind: (typeof METRIC_KINDS)[number];
  definition: string;
  unit: string;
  stakeholder_id?: string;
  baseline?: number;
  target?: number;
  /** A count over recorded participant events of one experiment, or a set of evidence items. */
  source: { type: "event_count"; experiment_id: string; event_kind: string; label?: string } | { type: "evidence_items"; refs: string[] };
  created_at: number;
}

/** One revision of one of the deck's eight slides (CR-35 "DeckSlides (8)"; cr-deck builds on it, R10). */
export interface DeckSlide {
  schema: typeof VENTURE_SCHEMA;
  kind: "deck_slide";
  project_id: string;
  number: number;
  revision: number;
  title: string;
  body: string;
  evidence_refs: string[];
  decision_id?: string;
  at: number;
  by: string;
}

const isTime = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0) || (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)));
const strList = (v: unknown, max: number, each: (x: unknown) => boolean) => Array.isArray(v) && v.length <= max && v.every(each);
const missing = (v: Record<string, unknown>, fields: readonly string[]) => fields.filter((f) => !(f in v) || v[f] === undefined).map((f) => `missing:${f}`);
const refStr = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 300;

/**
 * The Evidence item contract (CR-40). Shape only; whether `source_refs` resolve is the store's
 * check. An `observed` item with no source reference is refused here already.
 */
export function validateEvidenceItem(v: unknown): Validation<EvidenceItem> {
  if (!isObj(v)) return { ok: false, problems: ["not_an_object"] };
  const problems = missing(v, EVIDENCE_ITEM_FIELDS);
  if (v.id !== undefined && !str(v.id, 300)) problems.push("invalid:id");
  if (v.type !== undefined && !str(v.type, 60)) problems.push("invalid:type");
  if (v.statement !== undefined && !str(v.statement, 2000)) problems.push("invalid:statement");
  if (v.source_refs !== undefined && !strList(v.source_refs, 50, refStr)) problems.push("invalid:source_refs");
  if (v.confidence !== undefined && !(CONFIDENCES as readonly string[]).includes(String(v.confidence))) problems.push("invalid:confidence");
  if (v.created_by !== undefined && v.created_by !== "student" && v.created_by !== "system") problems.push("invalid:created_by");
  if (v.created_at !== undefined && !isTime(v.created_at)) problems.push("invalid:created_at");
  if (v.confidence === "observed" && Array.isArray(v.source_refs) && v.source_refs.length === 0) problems.push("observed_without_source_refs");
  return problems.length ? { ok: false, problems } : { ok: true, value: v as unknown as EvidenceItem };
}

/** The Decision contract (CR-41). A slide outside 1–8 is refused; references are resolved by the store. */
export function validateDecisionContract(v: unknown): Validation<Omit<Decision, "schema" | "kind" | "project_id" | "actor">> {
  if (!isObj(v)) return { ok: false, problems: ["not_an_object"] };
  const problems = missing(v, DECISION_FIELDS);
  if (v.id !== undefined && !isVentureId(v.id)) problems.push("invalid:id");
  if (v.statement !== undefined && !str(v.statement, 1000)) problems.push("invalid:statement");
  for (const f of ["evidence_refs", "assumption_refs"] as const) if (v[f] !== undefined && !(strList(v[f], 30, refStr) && new Set(v[f] as string[]).size === (v[f] as string[]).length)) problems.push(`invalid:${f}`);
  if (v.resulting_version_id !== undefined && v.resulting_version_id !== null && !str(v.resulting_version_id, 100)) problems.push("invalid:resulting_version_id");
  if (v.affected_deck_slides !== undefined) {
    const s = v.affected_deck_slides;
    if (!Array.isArray(s) || s.length > DECK_SLIDES || new Set(s).size !== s.length || !s.every((n) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= DECK_SLIDES)) problems.push("invalid:affected_deck_slides");
  }
  if (v.decided_at !== undefined && !isTime(v.decided_at)) problems.push("invalid:decided_at");
  return problems.length ? { ok: false, problems } : { ok: true, value: v as unknown as Omit<Decision, "schema" | "kind" | "project_id" | "actor"> };
}

/** The Artifact contract (CR-42): an artifact without `entry_html`, or whose entry is not HTML, is refused. */
export function validateArtifactContract(v: unknown): Validation<Artifact> {
  if (!isObj(v)) return { ok: false, problems: ["not_an_object"] };
  const problems = missing(v, ARTIFACT_FIELDS);
  if (v.artifact_id !== undefined && !str(v.artifact_id, 200)) problems.push("invalid:artifact_id");
  if (v.type !== undefined && !(ARTIFACT_TYPES as readonly string[]).includes(String(v.type))) problems.push("invalid:type");
  if (v.schema_version !== undefined && !(Number.isInteger(v.schema_version) && (v.schema_version as number) >= 1)) problems.push("invalid:schema_version");
  if (v.entry_html !== undefined && !(typeof v.entry_html === "string" && publishPathProblem(v.entry_html) === null && /\.html?$/i.test(v.entry_html))) problems.push("invalid:entry_html");
  if (v.project_id !== undefined && !str(v.project_id, 100)) problems.push("invalid:project_id");
  if (v.version !== undefined && !(Number.isInteger(v.version) && (v.version as number) >= 0)) problems.push("invalid:version");
  for (const f of ["source_refs", "evidence_refs"] as const) if (v[f] !== undefined && !strList(v[f], 100, refStr)) problems.push(`invalid:${f}`);
  return problems.length ? { ok: false, problems } : { ok: true, value: v as unknown as Artifact };
}

/** The Artifact of one product version (R4 digest, its ordinal in the Project, the evidence of the decision behind it). */
export function artifactOfVersion(version: Pick<ProductVersion, "id" | "project_id" | "entry_html">, ordinal: number, evidenceRefs: string[]): Artifact {
  return { artifact_id: version.id, type: "product", schema_version: 1, entry_html: version.entry_html, project_id: version.project_id, version: ordinal, source_refs: [], evidence_refs: evidenceRefs };
}

/** Stakeholder (CR-75): at least one role; a role claimed observed must name evidence (resolved by the store). */
export function validateStakeholder(v: unknown): Validation<{ label: string; roles: Stakeholder["roles"] }> {
  if (!isObj(v)) return { ok: false, problems: ["not_an_object"] };
  const problems: string[] = [];
  if (!str(v.label, 80)) problems.push(v.label === undefined ? "missing:label" : "invalid:label");
  const roles = v.roles;
  if (!Array.isArray(roles) || roles.length === 0) problems.push("missing:roles");
  else {
    const seen = new Set<string>();
    for (const r of roles) {
      if (!isObj(r) || !(STAKEHOLDER_ROLES as readonly string[]).includes(String(r.role)) || seen.has(String(r.role))) {
        problems.push("invalid:roles");
        continue;
      }
      seen.add(String(r.role));
      const refs = r.evidence_refs ?? [];
      if (!strList(refs, 30, refStr)) problems.push(`invalid:roles.${r.role}.evidence_refs`);
      if (r.basis !== undefined && r.basis !== "observed") problems.push(`invalid:roles.${r.role}.basis`);
      if (r.basis === "observed" && Array.isArray(refs) && refs.length === 0) problems.push(`observed_role_without_evidence:${r.role}`);
    }
  }
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    value: {
      label: (v.label as string).trim(),
      roles: (roles as Array<Record<string, unknown>>).map((r) => ({ role: r.role as StakeholderRole, evidence_refs: [...((r.evidence_refs as string[] | undefined) ?? [])], ...(r.basis === "observed" ? { basis: "observed" as const } : {}) })),
    },
  };
}

/** Metric definition (CR-76): an impact metric names its stakeholder; the source is a count over events or a set of evidence items. */
export function validateMetric(v: unknown): Validation<Omit<Metric, "schema" | "kind" | "id" | "project_id" | "created_at">> {
  if (!isObj(v)) return { ok: false, problems: ["not_an_object"] };
  const problems: string[] = [];
  for (const f of ["name", "definition", "unit"] as const) if (!str(v[f], f === "definition" ? 500 : 80)) problems.push(v[f] === undefined ? `missing:${f}` : `invalid:${f}`);
  if (!(METRIC_KINDS as readonly string[]).includes(String(v.metric_kind))) problems.push(v.metric_kind === undefined ? "missing:metric_kind" : "invalid:metric_kind");
  if (v.stakeholder_id !== undefined && !isVentureId(v.stakeholder_id)) problems.push("invalid:stakeholder_id");
  if (v.metric_kind === "impact" && v.stakeholder_id === undefined) problems.push("impact_without_stakeholder");
  for (const f of ["baseline", "target"] as const) if (v[f] !== undefined && !(typeof v[f] === "number" && Number.isFinite(v[f]))) problems.push(`invalid:${f}`);
  const s = v.source;
  if (!isObj(s)) problems.push("missing:source");
  else if (s.type === "event_count") {
    if (!isVentureId(s.experiment_id) || !str(s.event_kind, 40) || (s.label !== undefined && !str(s.label, 80))) problems.push("invalid:source");
  } else if (s.type === "evidence_items") {
    if (!strList(s.refs, 30, (x) => parseEvidenceItemRef(x) !== null) || (s.refs as string[]).length === 0) problems.push("invalid:source");
  } else problems.push("invalid:source");
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    value: {
      name: (v.name as string).trim(),
      metric_kind: v.metric_kind as Metric["metric_kind"],
      definition: (v.definition as string).trim(),
      unit: (v.unit as string).trim(),
      ...(v.stakeholder_id !== undefined ? { stakeholder_id: v.stakeholder_id as string } : {}),
      ...(v.baseline !== undefined ? { baseline: v.baseline as number } : {}),
      ...(v.target !== undefined ? { target: v.target as number } : {}),
      source: s as Metric["source"],
    },
  };
}

/** A slide revision's fields (1–8, a title, a body, the evidence it cites). */
export function validateDeckSlide(v: unknown): Validation<Pick<DeckSlide, "number" | "title" | "body" | "evidence_refs" | "decision_id">> {
  if (!isObj(v)) return { ok: false, problems: ["not_an_object"] };
  const problems: string[] = [];
  if (!(Number.isInteger(v.number) && (v.number as number) >= 1 && (v.number as number) <= DECK_SLIDES)) problems.push("invalid:number");
  if (!str(v.title, 200)) problems.push("invalid:title");
  if (v.body !== undefined && !(typeof v.body === "string" && v.body.length <= 4000)) problems.push("invalid:body");
  if (v.evidence_refs !== undefined && !strList(v.evidence_refs, 30, refStr)) problems.push("invalid:evidence_refs");
  if (v.decision_id !== undefined && !isVentureId(v.decision_id)) problems.push("invalid:decision_id");
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { number: v.number as number, title: (v.title as string).trim(), body: typeof v.body === "string" ? v.body : "", evidence_refs: [...((v.evidence_refs as string[] | undefined) ?? [])], ...(v.decision_id !== undefined ? { decision_id: v.decision_id as string } : {}) } };
}

/** A hypothesis's revisions; a record written before cr-memory reads as its one revision. */
export function hypothesisRevisions(h: Hypothesis): HypothesisRevision[] {
  if (Array.isArray(h.revisions) && h.revisions.length) return h.revisions;
  return [{ revision: h.revision ?? 1, statement: h.statement, status: h.status, at: h.created_at, by: "service" }];
}

/**
 * Does `next` keep every revision of `previous` unchanged and add exactly one (CR-79)? A
 * revision that rewrites, drops or reorders an earlier statement is refused.
 */
export function hypothesisRevisionProblems(previous: Hypothesis, next: Hypothesis): string[] {
  const before = hypothesisRevisions(previous);
  const after = next.revisions ?? [];
  const problems: string[] = [];
  if (after.length !== before.length + 1) problems.push("revision_count");
  for (let i = 0; i < before.length; i++) if (JSON.stringify(after[i]) !== JSON.stringify(before[i])) problems.push(`revision_rewritten:${before[i]!.revision}`);
  const last = after.at(-1);
  if (!last || last.revision !== (before.at(-1)?.revision ?? 0) + 1) problems.push("revision_number");
  else if (next.statement !== last.statement || next.status !== last.status || next.revision !== last.revision) problems.push("current_not_last_revision");
  if (last && !(HYPOTHESIS_STATUSES as readonly string[]).includes(last.status)) problems.push("invalid:status");
  if (last && !str(last.statement, 500)) problems.push("invalid:statement");
  return problems;
}
