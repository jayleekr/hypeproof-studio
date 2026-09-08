// hps-observation/1: App/Service data contract. Twin in App, locked by tests.
export const OBSERVATION_FORMAT = "hps-observation/1";
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
export type ObservationKind =
  | "user"
  | "coach"
  | "tool_request"
  | "approval"
  | "tool_result"
  | "artifact"
  | "turn_end"
  | "correction";
export interface ObservationEvent {
  id: string;
  seq: number;
  task: string;
  at: number;
  kind: ObservationKind;
  text: string;
  tool_id?: string;
  outcome?: "allowed" | "denied" | "success" | "error" | "cancelled";
  actor?: "user" | "policy";
  sha256?: string;
  assistance: "unknown" | "assisted" | "independent";
}
export interface ObservationBatch {
  format: typeof OBSERVATION_FORMAT;
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
export function validateObservation(value: unknown): {
  batch: ObservationBatch;
  missing: number[];
} {
  check(
    object(value) && value.format === OBSERVATION_FORMAT,
    "unsupported_observation",
  );
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
  for (const e of value.events) {
    check(
      object(e) &&
        Object.keys(e).every((k) =>
          [
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
          ].includes(k),
        ) &&
        str(e.id) &&
        str(e.task) &&
        Number.isSafeInteger(e.seq) &&
        Number(e.seq) > 0 &&
        Number(e.seq) <= 10000 &&
        Number.isFinite(e.at),
      "invalid_event",
    );
    check(
      [
        "user",
        "coach",
        "tool_request",
        "approval",
        "tool_result",
        "artifact",
        "turn_end",
        "correction",
      ].includes(String(e.kind)),
      "invalid_kind",
    );
    check(
      typeof e.text === "string" &&
        e.text.length <= 20000 &&
        ["unknown", "assisted", "independent"].includes(String(e.assistance)),
      "invalid_event_text",
    );
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
  return {
    batch: {
      format: OBSERVATION_FORMAT,
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
      if (e.kind === "user" || e.kind === "correction") human = true;
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
