// hps-interpretation/1 — versioned interpretation contract (#1042; MC-10, MC-14–MC-20).
//
// An interpretation is a separate revision ABOUT a validated hps-observation/1
// batch. It never edits the batch or an earlier interpretation. Every claim must
// cite real events (or be left unobserved / unclassified), every version field is
// explicit (possibly "unknown"), and nothing here produces a number.
import type { ObservationBatch, ObservationEvent } from "./legacy-observation.ts";
import { capabilityModel } from "./capability-models.ts";
import { isAdoptedFromCoach, isHumanEvidence } from "./learning-events.ts";

export const INTERPRETATION_FORMAT = "hps-interpretation/1";

export type Unknown = "unknown";
export type FindingStatus = "observed" | "unobserved" | "insufficient_evidence";
export type ReviewState = "unreviewed" | "confirmed" | "disputed" | "retracted";
export type Assistance = "unknown" | "assisted" | "independent";

export interface EvidenceRef {
  event_id: string;
  quote: string;
}

export interface InterpretationFinding {
  capability: string;
  status: FindingStatus;
  claim: string;
  evidence: EvidenceRef[];
  assistance: Assistance;
  review: ReviewState;
  /** Who moved it out of "unreviewed". Only the person, never the model. */
  reviewed_by?: "user";
  /** Artifact revision a VERIFY claim is about (MC-14). Required when VERIFY is observed. */
  target_artifact?: string;
  /** The executed check behind an observed VERIFY claim (MC-14). Required when VERIFY is observed. */
  verification?: VerificationLink;
}

/** Names the exact request and executed result that checked `target_artifact`. */
export interface VerificationLink {
  /** How it was checked, quoted from the request event text (e.g. "npm test"). */
  method: string;
  request_event_id: string;
  result_event_id: string;
}

export interface Interpretation {
  format: typeof INTERPRETATION_FORMAT;
  id: string;
  revision: number;
  supersedes: null | { id: string; revision: number };
  reason?: string;
  batch: { format: string; scope: string; session: string; program: string };
  versions: {
    bundle_format: string;
    capability_model: { id: string; revision: number };
    definition_revision: string;
    rubric: { id: string; version: string } | Unknown;
    evaluator: { id: string; version: string } | Unknown;
    /** AI model that produced this interpretation. */
    analysis_ai_model: string | Unknown;
    /** AI models used while doing the observed work. */
    work_ai_models: string[] | Unknown;
  };
  findings: InterpretationFinding[];
  /** Judgments and counter-examples that fit no capability (MC-20). */
  unclassified: Array<{ claim: string; evidence: EvidenceRef[] }>;
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, n = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= n;
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
const keysWithin = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every((k) => allowed.includes(k));

// Anything that looks like a personal score, level or ranking is refused wherever
// it appears (MC-19), and so is any trace of arithmetic legacy conversion (MC-17).
// `learning-events.ts` refuses the same seven names inside a /2 event and keeps its
// own copy on purpose: this walk also refuses CONVERSION_KEYS and the per-key order
// between the two lists is part of this function's behaviour. The two copies are
// locked by a test that drives both refusals from one key list
// (worker/test/learning-events.test.mjs), not by a shared export — the core
// deliberately exports nothing whose name reads like a score (MC-T09).
const SCORE_KEYS = ["score", "scores", "level", "points", "rank", "percentile", "grade"];
const CONVERSION_KEYS = ["derived_from_legacy", "legacy_scores", "converted_from", "legacy_mapping"];
/** Exported for the classroom report queue (#751 R5): the same refusal, not a second list. */
export function forbidKeys(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(forbidKeys);
  if (!object(value)) return;
  for (const [k, v] of Object.entries(value)) {
    check(!SCORE_KEYS.includes(k), "unsupported_score");
    check(!CONVERSION_KEYS.includes(k), "legacy_conversion");
    forbidKeys(v);
  }
}

const AI_MODEL_ID = /^(claude|gpt|o[0-9]|gemini|llama|mistral|codex|anthropic|openai)/i;

function versionRef(v: unknown): boolean {
  return v === "unknown" || (object(v) && keysWithin(v, ["id", "version"]) && str(v.id) && str(v.version));
}

function citedEvent(events: Map<string, ObservationEvent>, ref: unknown): ObservationEvent {
  check(object(ref) && keysWithin(ref, ["event_id", "quote"]) && str(ref.event_id) && str(ref.quote, 2000), "invalid_quote");
  const e = events.get(ref.event_id);
  check(e && e.text.includes(ref.quote), "fabricated_quote");
  return e;
}

/**
 * Resolves an explicit verification link to the artifact revision it checked (MC-14).
 *
 * Nothing is inferred from order or from the claim's own wording: a success after an
 * artifact is NOT a check of it, even when the claim names that command honestly.
 * The claim must name one request and its own executed result (same task and tool
 * call), and BOTH events must carry the checked artifact revision in `sha256` — set
 * by the host adapter only when the tool actually took that revision as its input —
 * equal to `target_artifact`. The revision must already exist when the check starts
 * and must not change while it runs. Throws a named code on any mismatch.
 */
export function resolveVerification(
  batch: ObservationBatch,
  target: unknown,
  link: unknown,
): { checked_revision: string; current_revision: string; current: boolean } {
  check(typeof target === "string" && target.length > 0, "missing_target_artifact");
  const targetEvents = batch.events.filter((e) => e.kind === "artifact" && e.sha256 === target);
  check(targetEvents.length > 0, "unknown_artifact");
  check(
    object(link) && keysWithin(link, ["method", "request_event_id", "result_event_id"]) &&
      str(link.method) && str(link.request_event_id) && str(link.result_event_id),
    "missing_verification_link",
  );
  const byId = new Map(batch.events.map((e) => [e.id, e]));
  const request = byId.get(link.request_event_id);
  check(request && request.kind === "tool_request", "invalid_verification_request");
  check(request.text.includes(link.method), "unverified_method");
  const result = byId.get(link.result_event_id);
  check(result && result.kind === "tool_result", "missing_execution_evidence");
  check(result.task === request.task && result.tool_id === request.tool_id && result.seq > request.seq, "mismatched_verification_link");
  check(targetEvents.some((e) => e.task === request.task), "mismatched_verification_link");
  // Machine-checkable binding: the request and the result both name the revision they checked.
  check(typeof request.sha256 === "string", "unbound_verification_request");
  check(typeof result.sha256 === "string", "unbound_verification_result");
  check(request.sha256 === target && result.sha256 === target, "unverified_revision");
  check(result.outcome === "success", "failed_verification");

  const taskArtifacts = batch.events.filter((e) => e.kind === "artifact" && e.task === request.task);
  // The bound revision did not exist yet when the check started.
  check(taskArtifacts.some((e) => e.seq < request.seq && e.sha256 === target), "stale_verification");
  // The file changed while the check ran; the result is not about the named revision.
  check(!taskArtifacts.some((e) => e.seq > request.seq && e.seq < result.seq && e.sha256 !== target), "stale_verification");
  const current = taskArtifacts.at(-1)!.sha256!;
  return { checked_revision: target, current_revision: current, current: current === target };
}

/**
 * Which of a finding's cited events are a criterion the coach proposed and the
 * student accepted (design "관측 이벤트와 필드" rule 4).
 *
 * The student did submit the string, so this is not a refusal — the validator
 * accepts the finding. It is what lets an interpretation, or a reviewer, leave the
 * claim at `insufficient_evidence` instead of reading an adopted sentence as the
 * student's own judgment. Nothing here guesses: it reads the `adopted_from` marker
 * the host wrote, or it returns nothing.
 */
export function adoptedEvidence(batch: ObservationBatch, finding: { evidence?: unknown }): string[] {
  const events = new Map(batch.events.map((e) => [e.id, e]));
  const refs = Array.isArray(finding.evidence) ? finding.evidence : [];
  const out: string[] = [];
  for (const ref of refs) {
    if (!object(ref) || typeof ref.event_id !== "string") continue;
    const e = events.get(ref.event_id);
    if (e && isAdoptedFromCoach(e) && !out.includes(e.id)) out.push(e.id);
  }
  return out;
}

export function validateInterpretation(value: unknown, batch: ObservationBatch): Interpretation {
  check(object(value) && value.format === INTERPRETATION_FORMAT, "unsupported_interpretation");
  // Named refusal first: a score or a legacy conversion is reported as such,
  // not as a generic unknown field.
  forbidKeys(value);
  check(
    keysWithin(value, ["format", "id", "revision", "supersedes", "reason", "batch", "versions", "findings", "unclassified"]),
    "invalid_interpretation_fields",
  );

  // Revision chain: a revision never rewrites its predecessor (MC-15, MC-20).
  check(str(value.id) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1, "invalid_revision");
  if (value.revision === 1) check(value.supersedes === null, "invalid_supersedes");
  else
    check(
      object(value.supersedes) &&
        value.supersedes.id === value.id &&
        value.supersedes.revision === Number(value.revision) - 1 &&
        str(value.reason, 1000),
      "invalid_supersedes",
    );

  // Bound to exactly this batch.
  const b = value.batch;
  check(
    object(b) && b.format === batch.format && b.scope === batch.scope && b.session === batch.session && b.program === batch.program,
    "batch_mismatch",
  );

  // Versions: every field present; "unknown" is allowed, silence is not (MC-16).
  const v = value.versions;
  check(
    object(v) &&
      keysWithin(v, ["bundle_format", "capability_model", "definition_revision", "rubric", "evaluator", "analysis_ai_model", "work_ai_models"]) &&
      ["bundle_format", "capability_model", "definition_revision", "rubric", "evaluator", "analysis_ai_model", "work_ai_models"].every((k) => k in v),
    "invalid_versions",
  );
  check(v.bundle_format === batch.format, "invalid_versions");
  check(versionRef(v.rubric) && versionRef(v.evaluator), "invalid_versions");
  check(v.analysis_ai_model === "unknown" || str(v.analysis_ai_model), "invalid_versions");
  check(v.work_ai_models === "unknown" || (Array.isArray(v.work_ai_models) && v.work_ai_models.every((m) => str(m))), "invalid_versions");
  const cm = v.capability_model;
  check(object(cm) && keysWithin(cm, ["id", "revision"]), "invalid_versions");
  // An AI model id is not a capability model, and vice versa.
  const aiModels = [v.analysis_ai_model, ...(Array.isArray(v.work_ai_models) ? v.work_ai_models : [])];
  check(!AI_MODEL_ID.test(String(cm.id)) && !aiModels.some((m) => m === cm.id), "capability_model_confusion");
  check(!aiModels.some((m) => capabilityModel(m, cm.revision) || String(m).startsWith("candidate-capability") || String(m).startsWith("legacy-seven")), "capability_model_confusion");
  const model = capabilityModel(cm.id, cm.revision);
  check(model, "unknown_capability_model");
  check(v.definition_revision === model.definition_revision, "definition_revision_mismatch");
  const keys = model.capabilities.map((c) => c.key);

  const events = new Map(batch.events.map((e) => [e.id, e]));
  const artifacts = new Set(batch.events.filter((e) => e.kind === "artifact").map((e) => e.sha256));

  // Findings: a subset is fine; not every capability has to be filled (MC-20).
  check(Array.isArray(value.findings) && value.findings.length <= keys.length, "invalid_findings");
  const seen = new Set<string>();
  for (const f of value.findings) {
    check(
      object(f) && keysWithin(f, ["capability", "status", "claim", "evidence", "assistance", "review", "reviewed_by", "target_artifact", "verification"]),
      "invalid_finding",
    );
    check(keys.includes(String(f.capability)), "unknown_capability");
    check(!seen.has(String(f.capability)), "duplicate_capability");
    seen.add(String(f.capability));
    check(["observed", "unobserved", "insufficient_evidence"].includes(String(f.status)) && str(f.claim, 2000), "invalid_finding");
    check(["unknown", "assisted", "independent"].includes(String(f.assistance)), "invalid_finding");
    check(["unreviewed", "confirmed", "disputed", "retracted"].includes(String(f.review)), "invalid_review");
    check(f.review === "unreviewed" ? f.reviewed_by === undefined : f.reviewed_by === "user", "invalid_review");
    check(Array.isArray(f.evidence) && f.evidence.length <= 8, "invalid_evidence");

    let human = false;
    for (const ref of f.evidence) {
      const e = citedEvent(events, ref);
      // Only the person's own messages count as human behaviour. An assistant
      // message, a policy approval or a tool result never does (MC-10). /2 adds the
      // student's own learning events and keeps actor=ai out (design rule 3); the
      // predicate has one definition, in learning-events.ts.
      if (isHumanEvidence(e)) human = true;
      if (f.assistance === "independent") check(e.assistance === "independent", "unsupported_independence");
    }
    if (f.status === "observed") check(human, "missing_human_evidence");
    if (f.status === "unobserved") check(f.evidence.length === 0 && f.assistance === "unknown", "unobserved_with_evidence");

    if (f.target_artifact !== undefined) {
      check(typeof f.target_artifact === "string" && artifacts.has(f.target_artifact), "unknown_artifact");
    }
    if (f.capability === "VERIFY" && f.status === "observed") {
      // A hash, a request, a claim or an unrelated success is not an executed check
      // of this revision (MC-14): name the revision, the request and its result.
      resolveVerification(batch, f.target_artifact, f.verification);
    } else {
      check(f.verification === undefined, "invalid_finding");
    }
  }

  check(Array.isArray(value.unclassified) && value.unclassified.length <= 20, "invalid_unclassified");
  for (const u of value.unclassified) {
    check(object(u) && keysWithin(u, ["claim", "evidence"]) && str(u.claim, 2000) && Array.isArray(u.evidence) && u.evidence.length <= 8, "invalid_unclassified");
    for (const ref of u.evidence) citedEvent(events, ref);
  }

  return value as unknown as Interpretation;
}

/** A reinterpretation is a new revision of the same id; the previous one is left untouched (MC-20). */
export function validateReinterpretation(previous: unknown, next: unknown, batch: ObservationBatch): Interpretation {
  const prev = validateInterpretation(previous, batch);
  const nxt = validateInterpretation(next, batch);
  check(nxt.id === prev.id && nxt.revision === prev.revision + 1, "invalid_supersedes");
  return nxt;
}

// ── hps-evidence-draft/1 — Observed / Interpreted / Assumed / Next (cr-evidence; CR-25, CR-26, CR-74) ──
//
// The PRD P0-4 evidence draft of one experiment. It lives here, beside hps-interpretation/1,
// because it is the same kind of thing: a revision ABOUT stored observations that never edits
// them, whose every observed statement cites real records. It is not an hps-interpretation/1:
// that contract is bound to exactly one batch (one session) and to capability findings, while
// a participant-evidence draft spans many participant sessions and the student's notes, and
// sorts statements into the PRD's four sections. Nothing here produces a number about a
// person; counts in a statement's text are the runtime's reading of the cited records.
//
// A source reference names a record of the SAME experiment's record (local-record.ts
// `evidenceRefKey` turns it into a key):
//   session:<participant session id>              a participant session (CR-23)
//   event:<participant session id>/<event id>     one participant event
//   note:<event id>                               one manual record (CR-24)
// Resolution is the store's (`resolve`): a reference to another project's or another
// experiment's record, to nothing, or to a deleted record does not resolve, and a draft
// carrying such an item is refused with every refused item named (CR-25, CR-69).

export const EVIDENCE_DRAFT_FORMAT = "hps-evidence-draft/1";
export const DRAFT_SECTIONS = ["observation", "interpretation", "assumption", "next_experiment"] as const;
export type DraftSection = (typeof DRAFT_SECTIONS)[number];
/** An interpretation is a draft until the student reviews it (CR-25, CR-26); `edited` is a reviewed, changed one. */
export const DRAFT_REVIEW_STATES = ["draft", "accepted", "edited", "rejected"] as const;
export type DraftReviewState = (typeof DRAFT_REVIEW_STATES)[number];
export const EVIDENCE_REF = /^(?:session:[A-Za-z0-9_-]{1,100}|event:[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_.:-]{1,128}|note:[A-Za-z0-9_.:-]{1,128})$/;

export interface DraftItem {
  id: string;
  section: DraftSection;
  text: string;
  source_refs: string[];
  review: DraftReviewState;
  /** Only the person moves an item out of `draft` (MC-22: an AI never reviews itself). */
  reviewed_by?: "user";
  /** A comparison claim: the variants it compares (CR-74). Its support is computed on read (`comparisonSupport`), never stored. */
  compares?: string[];
  /** Counts in this statement are per device pseudonym, never per person (CR-72). */
  basis?: "per_device_pseudonym";
  /**
   * With `basis`: the return count the statement claims (CR-72), structured so the store can
   * check it against the cited sessions (sessions cited = return_count + 1, one pseudonym).
   * Additive (decision 8).
   */
  return_count?: number;
}

export interface EvidenceDraft {
  format: typeof EVIDENCE_DRAFT_FORMAT;
  id: string;
  revision: number;
  supersedes: null | { id: string; revision: number };
  reason?: string;
  experiment: string;
  /** Who wrote this revision: the runtime's reading of the records, an AI summary, or the student. */
  author: "runtime" | "ai" | "user";
  created_at: number;
  items: DraftItem[];
}

export type RefResolution = "ok" | "missing" | "deleted" | "foreign";

export interface DraftRefusal {
  item: string;
  code: "missing_source_refs" | "unresolved_source_ref" | "deleted_source_ref" | "foreign_source_ref" | "return_without_sessions" | "return_count_mismatch" | "return_sessions_not_one_device" | "return_not_measured";
  ref?: string;
}

/**
 * Shape of a draft revision. Throws a named code for a malformed document; reference
 * resolution is `draftRefusals`, so a refusal can name every item it refuses.
 */
export function validateEvidenceDraftShape(value: unknown): EvidenceDraft {
  check(object(value) && value.format === EVIDENCE_DRAFT_FORMAT, "unsupported_evidence_draft");
  forbidKeys(value);
  check(keysWithin(value, ["format", "id", "revision", "supersedes", "reason", "experiment", "author", "created_at", "items"]), "invalid_draft_fields");
  check(str(value.id, 100) && /^[A-Za-z0-9_-]+$/.test(String(value.id)) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1 && Number(value.revision) <= 200, "invalid_revision");
  if (value.revision === 1) check(value.supersedes === null, "invalid_supersedes");
  else check(object(value.supersedes) && value.supersedes.id === value.id && value.supersedes.revision === Number(value.revision) - 1 && str(value.reason, 1000), "invalid_supersedes");
  check(str(value.experiment, 100) && ["runtime", "ai", "user"].includes(String(value.author)) && Number.isFinite(value.created_at), "invalid_evidence_draft");
  check(Array.isArray(value.items) && value.items.length >= 1 && value.items.length <= 60, "invalid_draft_items");
  const ids = new Set<string>();
  for (const it of value.items) {
    check(object(it) && keysWithin(it, ["id", "section", "text", "source_refs", "review", "reviewed_by", "compares", "basis", "return_count"]), "invalid_draft_item");
    check(str(it.id, 60) && !ids.has(String(it.id)), "invalid_draft_item");
    ids.add(String(it.id));
    check((DRAFT_SECTIONS as readonly string[]).includes(String(it.section)) && str(it.text, 2000), "invalid_draft_item");
    check(Array.isArray(it.source_refs) && it.source_refs.length <= 50 && it.source_refs.every((r) => typeof r === "string" && EVIDENCE_REF.test(r)), "invalid_source_ref");
    check((DRAFT_REVIEW_STATES as readonly string[]).includes(String(it.review)), "invalid_review");
    check(it.review === "draft" ? it.reviewed_by === undefined : it.reviewed_by === "user", "invalid_review");
    // An AI or the runtime writes drafts; only the student reviews (MC-22).
    if (value.author !== "user") check(it.review === "draft", "invalid_review");
    if (it.compares !== undefined) check(Array.isArray(it.compares) && it.compares.length >= 2 && it.compares.length <= 4 && it.compares.every((v) => str(v, 64)) && new Set(it.compares).size === it.compares.length, "invalid_compares");
    if (it.basis !== undefined) check(it.basis === "per_device_pseudonym", "invalid_draft_item");
    if (it.return_count !== undefined) check(it.basis === "per_device_pseudonym" && Number.isSafeInteger(it.return_count) && Number(it.return_count) >= 0 && Number(it.return_count) <= 1000, "invalid_draft_item");
  }
  return value as unknown as EvidenceDraft;
}

/**
 * The items of a draft that may not be stored (CR-25): an observed statement with no
 * reference, and any statement whose reference does not resolve to a live record of this
 * experiment. Empty means every reference resolves.
 */
export async function draftRefusals(draft: EvidenceDraft, resolve: (ref: string) => Promise<RefResolution>): Promise<DraftRefusal[]> {
  const out: DraftRefusal[] = [];
  for (const it of draft.items) {
    if (it.section === "observation" && it.source_refs.length === 0) {
      out.push({ item: it.id, code: "missing_source_refs" });
      continue;
    }
    for (const ref of it.source_refs) {
      const r = await resolve(ref);
      if (r === "ok") continue;
      out.push({ item: it.id, ref, code: r === "deleted" ? "deleted_source_ref" : r === "foreign" ? "foreign_source_ref" : "unresolved_source_ref" });
      break;
    }
  }
  return out;
}

/**
 * Is a comparison claim supported (CR-74)? It must cite evidence from every variant it
 * compares; one that cites only one side is `unsupported`, flagged on read, not refused.
 */
export function comparisonSupport(item: Pick<DraftItem, "compares" | "source_refs">, variantOf: (ref: string) => string | null): "supported" | "unsupported" | null {
  if (!item.compares) return null;
  const cited = new Set(item.source_refs.map(variantOf).filter((v): v is string => !!v));
  return item.compares.every((v) => cited.has(v)) ? "supported" : "unsupported";
}

/**
 * The student's review of one revision (CR-26): accept, edit or reject items. Returns the
 * next revision; the previous one and every raw record are untouched (MC-22). Only
 * `interpretation`, `assumption` and `next_experiment` items take an edit of their text; an
 * observed statement is the records' reading, so it is accepted or rejected, never rewritten.
 */
export function reviseEvidenceDraft(
  previous: EvidenceDraft,
  actions: Array<{ item: string; action: "accept" | "edit" | "reject"; text?: string }>,
  input: { at: number; reason: string },
): EvidenceDraft {
  check(Array.isArray(actions) && actions.length >= 1 && actions.length <= 60 && str(input.reason, 1000), "invalid_review");
  const byId = new Map(previous.items.map((i) => [i.id, i]));
  const next = previous.items.map((i) => ({ ...i, source_refs: [...i.source_refs] }));
  for (const a of actions) {
    check(object(a) && byId.has(String(a.item)) && ["accept", "edit", "reject"].includes(String(a.action)), "invalid_review");
    const item = next.find((i) => i.id === a.item)!;
    if (a.action === "edit") {
      check(item.section !== "observation", "observation_not_editable");
      check(str(a.text, 2000), "invalid_review");
      item.text = a.text!;
      item.review = "edited";
    } else item.review = a.action === "accept" ? "accepted" : "rejected";
    item.reviewed_by = "user";
  }
  return {
    ...previous,
    revision: previous.revision + 1,
    supersedes: { id: previous.id, revision: previous.revision },
    reason: input.reason,
    author: "user",
    created_at: input.at,
    items: next,
  };
}
