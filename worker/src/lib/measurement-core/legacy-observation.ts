// hps-observation/1 and /2: App/Service data contract.
//
// /1 was moved verbatim from worker/src/lib/native-observation.ts (#1042). App and
// Service both import this one file; /1 behaviour is pinned to the pre-extraction
// verdicts in worker/test/fixtures/measurement-core/legacy-verdicts.json (MC-T01)
// and must reproduce them byte for byte **for that corpus**.
//
// That claim is narrower than it first reads, and the difference matters.
// /2 widened the human-evidence rule from `kind ∈ {user, correction}` to
// `isHumanEvidence()`, which ALSO reads `actor`. /1 never constrained `actor`
// outside `approval`, so a valid /1 event like `{kind:"user", actor:"policy"}`
// is accepted by the old rule and refused by the new one. The golden corpus
// carries no such event, so the fixtures stay byte-identical while the RULE has
// moved. The direction is the one SX-45 wants (AI prose is not the student's),
// but saying "byte for byte" without this paragraph is a scope claim wider than
// its evidence.
//
// /2 (P1-A; SX-44–SX-48) is a SUPERSET handled in this same file, because a second
// validator is exactly what SX-48 forbids. `validateObservation()` looks at
// `format` and applies either the /1 rules or "/1 + the /2 rules". A /1 batch stays
// valid, is not upgraded, and a /2 batch is never downgraded — the batch comes back
// carrying the format it arrived with. Which one a cohort sends is decided by the
// profile's `observation.format`, not here.
//
// The /2 table (kinds, enums, per-kind required fields, defaults) lives in
// ./learning-events.ts so the gates and the session-design schema read the same
// list. This file stays the one place that decides whether a batch is valid.
import {
  ARTIFACT_REF_KEYS,
  EVIDENCE_TYPES,
  LEARNING_EVENT_KEYS,
  LEARNING_EVENT_KINDS,
  LEARNING_EVENT_SPEC,
  LEARNING_OUTCOMES,
  OBSERVATION_ACTORS,
  REF_KEYS,
  SOURCE_KINDS,
  SOURCE_STATES,
  forbidPersonalMetrics,
  isHumanEvidence,
  isLearningEventKind,
  type EvidenceType,
  type LearningEventKind,
  type ObservationActor,
  type SourceKind,
  type SourceState,
} from "./learning-events.ts";

export const OBSERVATION_FORMAT = "hps-observation/1";
export const OBSERVATION_FORMAT_V2 = "hps-observation/2";
export const OBSERVATION_FORMATS = [OBSERVATION_FORMAT, OBSERVATION_FORMAT_V2] as const;
export type ObservationFormat = (typeof OBSERVATION_FORMATS)[number];
export const OBSERVATION_ASSETS = [
  "TASTE",
  "INTENT",
  "CONTEXT",
  "VERIFY",
  "DELEGATE",
  "ITERATE",
  "OWNERSHIP",
] as const;
export type ObservationAsset = (typeof OBSERVATION_ASSETS)[number];
/** /1 kinds. Preserved exactly; the eight learning kinds are a separate layer (SX-47). */
export const LEGACY_OBSERVATION_KINDS = [
  "user",
  "coach",
  "tool_request",
  "approval",
  "tool_result",
  "artifact",
  "turn_end",
  "correction",
] as const;
export type LegacyObservationKind = (typeof LEGACY_OBSERVATION_KINDS)[number];
export type ObservationKind = LegacyObservationKind | LearningEventKind;
export interface ObservationEvent {
  id: string;
  seq: number;
  task: string;
  at: number;
  kind: ObservationKind;
  text: string;
  tool_id?: string;
  outcome?: "allowed" | "denied" | "success" | "error" | "cancelled" | "match" | "mismatch" | "unknown";
  /** /1 carries `user` | `policy`; /2 widens the enum without remapping either value (SX-44). */
  actor?: ObservationActor;
  sha256?: string;
  assistance: "unknown" | "assisted" | "independent";
  // ── /2 only (SX-44). Absent on every /1 event, which is why /1 is untouched. ──
  context?: { week: number; step_id: string; task: string; module_version: string };
  evidence_type?: EvidenceType;
  source_kind?: SourceKind;
  /** Fixed when stored (SX-46). A change is a new `correction` event, never an edit. */
  source_state?: SourceState;
  /** The student's own words. Only on an event the student authored. */
  student_text?: string;
  artifact_before?: string;
  artifact_after?: string;
  criterion_ref?: string;
  turn_ref?: string;
  result_ref?: string;
  evidence_refs?: string[];
  provenance?: { who: string; when: string; where: string };
  /** A coach-proposed criterion the student accepted: the coach's event id (design rule 4). */
  adopted_from?: string;
  decision?: { from: string; to: string };
  next_experiment?: string;
}
export interface ObservationBatch {
  format: ObservationFormat;
  scope: string;
  session: string;
  program: string;
  events: ObservationEvent[];
  incomplete?: boolean;
}
export interface ObservationFinding {
  asset: ObservationAsset;
  status: "observed" | "unobserved";
  interpretation: string;
  evidence: Array<{ event_id: string; quote: string }>;
  assistance: "unknown" | "assisted" | "independent";
  next: string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, n = 200): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= n;
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}

// ── /2 field checks ───────────────────────────────────────────────────────────
// Only ever reached for a /2 batch. Every refusal is named: a student reading
// "invalid event" learns nothing, and a host cannot tell a typo from a policy.

const shapeOf = (v: unknown, keys: readonly string[], max = 200): boolean =>
  object(v) && Object.keys(v).length === keys.length && keys.every((k) => str(v[k], max));

/** Is this /2 field present and well-formed? Presence is the caller's question. */
function fieldOk(e: Record<string, unknown>, field: string): boolean {
  switch (field) {
    case "context":
      return (
        object(e.context) &&
        shapeOf({ step_id: e.context.step_id, task: e.context.task, module_version: e.context.module_version }, ["step_id", "task", "module_version"]) &&
        Object.keys(e.context).length === 4 &&
        Number.isSafeInteger(e.context.week) &&
        Number(e.context.week) >= 1
      );
    case "provenance":
      return shapeOf(e.provenance, ["who", "when", "where"]);
    case "decision":
      return shapeOf(e.decision, ["from", "to"], 500);
    case "evidence_refs":
      return Array.isArray(e.evidence_refs) && e.evidence_refs.length >= 1 && e.evidence_refs.length <= 8 && e.evidence_refs.every((r) => str(r));
    case "outcome":
      return (LEARNING_OUTCOMES as readonly string[]).includes(String(e.outcome));
    case "student_text":
    case "next_experiment":
      return str(e[field], 2000);
    case "source_state":
      return (SOURCE_STATES as readonly string[]).includes(String(e.source_state));
    case "artifact_before":
    case "artifact_after":
      return typeof e[field] === "string" && /^[a-f0-9]{64}$/.test(String(e[field]));
    default:
      return str(e[field]);
  }
}

/**
 * The /2 rules for one event. `/1` events inside a /2 batch pass through this with
 * nothing to check — the new fields are all absent on them.
 */
function checkLearningFields(e: Record<string, unknown>): void {
  const kind = String(e.kind);
  const learning = isLearningEventKind(kind);

  if (e.actor !== undefined) check((OBSERVATION_ACTORS as readonly string[]).includes(String(e.actor)), "invalid_actor");
  if (learning) check((OBSERVATION_ACTORS as readonly string[]).includes(String(e.actor)), "invalid_actor");

  // SX-45 — AI text is never recorded as the student's. The one exception is the
  // quote in `external_feedback_received`, whose own required-field row names
  // `student_text` while its default actor is `external_user`; the student typed
  // that quote in. Every other actor, on every kind, is refused by name.
  if (e.student_text !== undefined) {
    check(fieldOk(e, "student_text"), "invalid_learning_event");
    const quoting = kind === "external_feedback_received" && e.actor === "external_user";
    check(e.actor === "user" || quoting, "ai_text_as_student");
  }

  if (e.evidence_type !== undefined) check((EVIDENCE_TYPES as readonly string[]).includes(String(e.evidence_type)), "invalid_evidence_type");
  if (e.source_kind !== undefined) check((SOURCE_KINDS as readonly string[]).includes(String(e.source_kind)), "invalid_source_kind");
  if (e.source_state !== undefined) check(fieldOk(e, "source_state"), "invalid_source_state");
  if (e.context !== undefined) check(fieldOk(e, "context"), "invalid_context");
  if (e.provenance !== undefined) check(fieldOk(e, "provenance"), "invalid_provenance");

  // SX-46 — `real` is not a word a host gets to write on its own: it takes either
  // provenance (who/when/where) or an executed result bound to the revision.
  if (e.source_state === "real") check(e.provenance !== undefined || e.result_ref !== undefined, "missing_provenance");

  if (!learning) return;
  const spec = LEARNING_EVENT_SPEC[kind as LearningEventKind];
  check(e.evidence_type !== undefined, "invalid_evidence_type");
  if (spec.evidence_type) check(e.evidence_type === spec.evidence_type, "invalid_evidence_type");
  for (const field of spec.required) {
    if (field === "source_state") {
      // No default for this kind: the student picks, and nothing is filled in for them.
      check(e.source_state !== undefined, "missing_source_state");
      continue;
    }
    if (field === "student_text" && e.actor !== "user" && kind !== "external_feedback_received") {
      // A learning event someone else authored (SX-45 keeps an actor=ai decision
      // recordable) has no student_text at all; its own words stay in `text`.
      check(str(e.text, 20000), "invalid_learning_event");
      continue;
    }
    check(e[field] !== undefined && fieldOk(e, field), "invalid_learning_event");
  }
}

export function validateObservation(value: unknown): {
  batch: ObservationBatch;
  missing: number[];
} {
  check(
    object(value) && (OBSERVATION_FORMATS as readonly string[]).includes(String(value.format)),
    "unsupported_observation",
  );
  const v2 = value.format === OBSERVATION_FORMAT_V2;
  check(
    str(value.scope) && str(value.session) && str(value.program),
    "invalid_scope",
  );
  check(
    value.incomplete === undefined || typeof value.incomplete === "boolean",
    "invalid_completeness",
  );
  check(
    Array.isArray(value.events) && value.events.length <= 500,
    "invalid_events",
  );
  const ids = new Map<string, ObservationEvent>(),
    seqs = new Map<number, string>();
  const allowedKeys = [
    "id",
    "seq",
    "task",
    "at",
    "kind",
    "text",
    "tool_id",
    "outcome",
    "actor",
    "sha256",
    "assistance",
    ...(v2 ? LEARNING_EVENT_KEYS : []),
  ];
  for (const e of value.events) {
    // A personal score has no place in an observed event either; named before the
    // key allowlist so the refusal says what it is instead of "unknown field".
    if (v2) forbidPersonalMetrics(e);
    check(
      object(e) &&
        Object.keys(e).every((k) => allowedKeys.includes(k)) &&
        str(e.id) &&
        str(e.task) &&
        Number.isSafeInteger(e.seq) &&
        Number(e.seq) > 0 &&
        Number(e.seq) <= 10000 &&
        Number.isFinite(e.at),
      "invalid_event",
    );
    check(
      (LEGACY_OBSERVATION_KINDS as readonly string[]).includes(String(e.kind)) ||
        (v2 && (LEARNING_EVENT_KINDS as readonly string[]).includes(String(e.kind))),
      "invalid_kind",
    );
    check(
      typeof e.text === "string" &&
        e.text.length <= 20000 &&
        ["unknown", "assisted", "independent"].includes(String(e.assistance)),
      "invalid_event_text",
    );
    if (v2) checkLearningFields(e);
    if (["tool_request", "approval", "tool_result"].includes(String(e.kind)))
      check(str(e.tool_id), "missing_tool_id");
    if (e.kind === "approval")
      check(
        ["user", "policy"].includes(String(e.actor)) &&
          ["allowed", "denied"].includes(String(e.outcome)),
        "invalid_approval",
      );
    if (e.kind === "tool_result")
      check(
        ["success", "error"].includes(String(e.outcome)),
        "invalid_tool_result",
      );
    if (e.kind === "artifact")
      check(
        typeof e.sha256 === "string" && /^[a-f0-9]{64}$/.test(e.sha256),
        "invalid_artifact",
      );
    const previous = ids.get(e.id);
    check(
      !previous || JSON.stringify(previous) === JSON.stringify(e),
      "conflicting_event",
    );
    check(
      !seqs.has(Number(e.seq)) || seqs.get(Number(e.seq)) === e.id,
      "conflicting_sequence",
    );
    ids.set(e.id, e as unknown as ObservationEvent);
    seqs.set(Number(e.seq), e.id);
  }
  const events = [...ids.values()].sort((a, b) => a.seq - b.seq),
    missing: number[] = [];
  for (let i = 1; i <= (events.at(-1)?.seq ?? 0); i++)
    if (!seqs.has(i)) missing.push(i);
  const requests = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool_request") requests.add(e.task + ":" + e.tool_id);
    if (e.kind === "tool_result" || e.kind === "approval")
      check(requests.has(e.task + ":" + e.tool_id), "orphan_tool_event");
  }
  if (v2) {
    // A reference names something that is in this batch, or it names nothing.
    // Order is not required: a criterion may be written after the test that cites
    // it, and the gates are what care about order.
    const artifacts = new Set(events.filter((e) => e.kind === "artifact").map((e) => e.sha256));
    for (const e of events) {
      for (const key of REF_KEYS) {
        const ref = e[key];
        if (ref !== undefined) check(ids.has(String(ref)), "orphan_ref");
      }
      for (const ref of e.evidence_refs ?? []) check(ids.has(ref), "orphan_ref");
      for (const key of ARTIFACT_REF_KEYS) {
        const ref = e[key];
        if (ref !== undefined) check(artifacts.has(String(ref)), "unknown_artifact");
      }
    }
  }
  return {
    batch: {
      format: value.format as ObservationFormat,
      scope: value.scope,
      session: value.session,
      program: value.program,
      events,
      ...(value.incomplete ? { incomplete: true } : {}),
    },
    missing,
  };
}
export function observableAssets(batch: ObservationBatch): ObservationAsset[] {
  const executed = batch.events.some(
    (e) => e.kind === "tool_result" && e.outcome === "success",
  );
  const versions = new Set(
    batch.events.filter((e) => e.kind === "artifact").map((e) => e.sha256),
  );
  return OBSERVATION_ASSETS.filter(
    (asset) =>
      (asset !== "VERIFY" || executed) &&
      (asset !== "ITERATE" || versions.size >= 2),
  );
}
export function validateFindings(
  value: unknown,
  batch: ObservationBatch,
): ObservationFinding[] {
  check(Array.isArray(value) && value.length === 7, "invalid_findings");
  const events = new Map(batch.events.map((e) => [e.id, e]));
  const seen = new Set<string>();
  for (const f of value) {
    check(
      object(f) &&
        OBSERVATION_ASSETS.includes(f.asset as ObservationAsset) &&
        !seen.has(String(f.asset)),
      "invalid_asset",
    );
    seen.add(String(f.asset));
    check(
      ["observed", "unobserved"].includes(String(f.status)) &&
        str(f.interpretation, 2000) &&
        str(f.next, 1000),
      "invalid_interpretation",
    );
    check(
      ["unknown", "assisted", "independent"].includes(String(f.assistance)) &&
        Array.isArray(f.evidence) &&
        f.evidence.length <= 8,
      "invalid_evidence",
    );
    let human = false;
    for (const ref of f.evidence) {
      check(
        object(ref) && str(ref.event_id) && str(ref.quote, 2000),
        "invalid_quote",
      );
      const e = events.get(ref.event_id);
      check(e && e.text.includes(ref.quote), "fabricated_quote");
      // Same predicate as interpretation.ts, one definition (learning-events.ts).
      // For a /1 event it answers exactly what `kind ∈ {user, correction}` did.
      if (isHumanEvidence(e)) human = true;
      if (f.assistance === "independent")
        check(e.assistance === "independent", "unsupported_independence");
    }
    check(f.status !== "observed" || human, "missing_human_evidence");
    check(
      f.status !== "observed" ||
        observableAssets(batch).includes(f.asset as ObservationAsset),
      "missing_execution_evidence",
    );
    check(
      f.status !== "unobserved" ||
        (f.evidence.length === 0 && f.assistance === "unknown"),
      "unobserved_with_evidence",
    );
    check(!("score" in f) && !("level" in f), "unsupported_score");
  }
  return value as ObservationFinding[];
}

/**
 * Which observation contract one seat is actually served (SX-44~48, P1 F-1).
 *
 * Two inputs, both of which can say "only /1":
 *   - `declared` — what the cohort's profile asks for. Absent means /1, so every
 *     cohort that existed before the field keeps its exact behaviour.
 *   - `client` — the `x-hps-observation-format` header, i.e. what the app build
 *     in front of us can parse. An older Studio bundles a validator that has
 *     never heard of /2 and rejects such a batch outright, so serving it /2
 *     would break observation for that seat completely.
 *
 * The cohort's declaration is therefore a **ceiling, not an order**: /2 is
 * served only when both sides can carry it.
 *
 * `/v1/profile` and `/observations/context` both call this, which is the whole
 * point — if they computed it separately the client could build a /2 recorder
 * and then be handed a /1 context, and every learning event would be dropped
 * with `observation_format` while the screen looked fine.
 */
export function servedObservationFormat(
  declared: string | undefined,
  client: string | undefined,
): ObservationFormat {
  const wants = declared === OBSERVATION_FORMAT_V2;
  const canParse = client === OBSERVATION_FORMAT_V2;
  return wants && canParse ? OBSERVATION_FORMAT_V2 : OBSERVATION_FORMAT;
}

/**
 * Is this a contract the app knows how to record against?
 *
 * The screen's question is "is observation on for this seat", not "which
 * version is it". Two places used to ask `=== "hps-observation/1"`, so the
 * moment a cohort was served /2 the observation panel vanished and a
 * "this connection does not support observation" notice appeared next to a
 * perfectly working Evidence drawer.
 */
export const isObservationFormat = (value: unknown): value is ObservationFormat =>
  (OBSERVATION_FORMATS as readonly string[]).includes(String(value));

/**
 * May the observation RESULTS panel be drawn on the work screen for this seat?
 *
 * Not the same question as "is observation on". The panel prints capability keys,
 * "독립 수행 근거 / 도움을 받은 수행 / 도움 사용 범위 미확인" and a "평가에 보낼 기록 보기"
 * button — an assessment, shown to the learner, mid-task. Four P0 rows forbid
 * exactly that during work:
 *
 *   SX-01  헤더 안에 점수·등급·역량 이름이 없다
 *   SX-06  rail 에 점수·자산 라벨·평가 문장이 없다
 *   SX-07  자기평가·변화 기록·역량 라벨은 작업 중 개입 대상에서 제외된다
 *   SX-59  작업 중 어떤 화면에도 역량 점수·등급·배지가 없다
 *
 * SX-59 also names the remedy — "제거하거나 **학습 경험 프로필에서 비활성**한다" — because
 * the trial cohort's own requirement (TUX-OBS-07) is to read observation results.
 * So the panel follows `assess`, the cohort's opt-in to assessment, and recording
 * keeps its own switch. A cohort that records but does not assess gets the drawer
 * and the completion gate with no verdict shown back at the learner.
 *
 * Takes the SERVED block, not the profile: the client is the caller that matters,
 * and a worker too old to send `assess` must read as "no", never as permission.
 */
export const showsObservationResults = (
  served: { format?: unknown; assess?: unknown } | null | undefined,
): boolean => isObservationFormat(served?.format) && served?.assess === true;

/** What a profile's observation block actually permits. */
export interface ObservationCapability {
  /** Write learning events on the student's device. */
  readonly record: boolean;
  /** May call `POST /v1/observations/assess` — the batch leaves the device. */
  readonly assess: boolean;
}

/**
 * The ONE place `observation.record` / `observation.assess` are decided
 * (ADR 0010).
 *
 * There is a reason this is a function and not two `??` expressions at each
 * call site. The P1 repair put the same negotiation in two callers, wrote
 * "same function, so the two answers cannot drift" in a comment, and the two
 * answers drifted — a third literal elsewhere gave every observation seat a
 * "please update Studio" banner. A flag read in eight places gets eight
 * chances to disagree.
 *
 * Step 1 changes nothing that ships: `record` and `assess` both fall back to
 * the legacy `enabled`, and no profile sets either field yet. The
 * profile-serving snapshot is what proves that, not this comment.
 */
export function observationCapability(
  observation: { enabled?: boolean; record?: boolean; assess?: boolean } | undefined,
): ObservationCapability {
  const legacy = observation?.enabled === true;
  return {
    record: observation?.record ?? legacy,
    assess: observation?.assess ?? legacy,
  };
}
