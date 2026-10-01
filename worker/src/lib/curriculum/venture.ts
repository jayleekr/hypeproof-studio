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
export function newVentureId(prefix: "prj" | "hyp" | "exp" | "drf" | "note"): string {
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
