// hps-interpretation/1 — versioned interpretation contract (#1042; MC-10, MC-14–MC-20).
//
// An interpretation is a separate revision ABOUT a validated hps-observation/1
// batch. It never edits the batch or an earlier interpretation. Every claim must
// cite real events (or be left unobserved / unclassified), every version field is
// explicit (possibly "unknown"), and nothing here produces a number.
import type { ObservationBatch, ObservationEvent } from "./legacy-observation.ts";
import { capabilityModel } from "./capability-models.ts";

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
const SCORE_KEYS = ["score", "scores", "level", "points", "rank", "percentile", "grade"];
const CONVERSION_KEYS = ["derived_from_legacy", "legacy_scores", "converted_from", "legacy_mapping"];
function forbidKeys(value: unknown): void {
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
 * Nothing is inferred from order alone: any success after an artifact is NOT a check
 * of it. The claim must name one request and its own executed result, in the same
 * task and tool call, and the checked revision is the last revision of the target's
 * task written before that request. Throws a named code on any mismatch.
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
  check(result.outcome === "success", "failed_verification");

  const taskArtifacts = batch.events.filter((e) => e.kind === "artifact" && e.task === request.task);
  const before = taskArtifacts.filter((e) => e.seq < request.seq);
  const checked = before.at(-1)?.sha256;
  // The target only exists after the check started: an earlier result reused for a newer revision.
  check(before.some((e) => e.sha256 === target), "stale_verification");
  check(checked === target, "unverified_revision");
  // The file changed while the check ran; the result is not about the named revision.
  check(!taskArtifacts.some((e) => e.seq > request.seq && e.seq < result.seq && e.sha256 !== target), "stale_verification");
  const current = taskArtifacts.at(-1)!.sha256!;
  return { checked_revision: target, current_revision: current, current: current === target };
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
      // message, a policy approval or a tool result never does (MC-10).
      if (e.kind === "user" || e.kind === "correction") human = true;
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
