// AI Verify — "Test my product" (cr-verify, #1392; CR-12–CR-16, CR-81; recon §7 `cr-verify`).
//
// The verification report `hps-verification/1` is a VIEW over events already on the one
// measurement-core record (SX-48): no report store, no second validator of observation
// batches, no scorer. A run leaves, per criterion, on the same `hps-observation/2` batch:
//
//   artifact          the R4 artifact version, recorded once before a run when the batch's
//                     latest artifact is another one (`sha256` = the version digest, text
//                     tagged `hps-artifact-version/1`). `test_observed.artifact_after` must
//                     name an artifact event of the batch (ARTIFACT_REF_KEYS), which is why
//                     the version is recorded this way; `observableAssets` does not count
//                     these events as revisions (`isVersionArtifact`).
//   tool_request      `verify_criterion` for the criterion, `sha256` = the version digest
//   tool_result       the per-criterion verdict, text tagged `hps-verify-result/1`, carrying
//                     the CR-10 browser-result keys (`artifact_version`, `screenshot_digest`)
//   test_observed     actor `ai` (the runner tested, the student did not), `criterion_ref` →
//   or retest_confirmed   the student's `criterion_set`, `artifact_after` → the version,
//                     `result_ref` → the tool_result, outcome match / mismatch / unknown
//
// `verificationReport()` reads those back. CR-14 compares runs of a criterion by its text
// (`criterionKey`), plan, version and viewport, across every run on the version. Everything here is pure and provider-free
// (CR-03): plain data in, plain data out.
//
// Imports: TYPES only from the validator, like learning-events.ts, so the core stays acyclic.
import type { ObservationEvent } from "./legacy-observation.ts";

export const VERIFICATION_FORMAT = "hps-verification/1";
export const VERIFY_RESULT_FORMAT = "hps-verify-result/1";
export const VERSION_ARTIFACT_FORMAT = "hps-artifact-version/1";
/** The coach tool that hands a criterion's browser plan to the runner (both runtimes). */
export const VERIFY_TOOL = "verify_criterion";
export const CRITERIA_MIN = 1;
export const CRITERIA_MAX = 5;
const MAX_STEPS = 12;
const MAX_EXPECT = 6;
const MAX_TEXT = 300;

/** A verdict the runner can reach (CR-13 pass / fail / warning, CR-15 "not verified"). */
export type VerdictStatus = "pass" | "fail" | "warning" | "not_verified";
/** What a report shows: a verdict, or CR-14's non-reproducible. */
export type ReportStatus = VerdictStatus | "non_reproducible";

const VERSION_ID = /^sha256:[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]{64}$/;

/** `sha256:<hex>` (an R4 version id) → the plain hex an `artifact` event carries. */
export const versionHex = (id: string): string => (VERSION_ID.test(id) ? id.slice(7) : "");

// ── CR-12: the criteria of a run ────────────────────────────────────────────

export interface CriterionInput {
  text?: unknown;
  /** Who wrote it. An AI proposal never starts a run until the student confirms it. */
  proposed_by?: unknown;
  confirmed?: unknown;
  /** The coach event an adopted proposal came from (design rule 4, SX-14, HC-04). */
  adopted_from?: unknown;
}
export interface AcceptedCriterion {
  text: string;
  adopted_from?: string;
}

/**
 * The criteria a "Test my product" run may start with: 1–5, each with text, none an
 * unconfirmed AI proposal. Refused by name, never trimmed to fit.
 */
export function checkCriteria(list: unknown): { ok: true; criteria: AcceptedCriterion[] } | { ok: false; code: string } {
  if (!Array.isArray(list) || list.length < CRITERIA_MIN || list.length > CRITERIA_MAX) return { ok: false, code: "criteria_count" };
  const out: AcceptedCriterion[] = [];
  for (const raw of list as CriterionInput[]) {
    if (!raw || typeof raw !== "object") return { ok: false, code: "empty_criterion" };
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text) return { ok: false, code: "empty_criterion" };
    if (text.length > MAX_TEXT) return { ok: false, code: "criterion_too_long" };
    if (raw.proposed_by === "ai" && raw.confirmed !== true) return { ok: false, code: "unconfirmed_ai_criterion" };
    if (raw.proposed_by === "ai" && typeof raw.adopted_from !== "string") return { ok: false, code: "missing_adopted_from" };
    if (out.some((c) => c.text === text)) return { ok: false, code: "duplicate_criterion" };
    out.push({ text, ...(raw.proposed_by === "ai" ? { adopted_from: raw.adopted_from as string } : {}) });
  }
  return { ok: true, criteria: out };
}

// ── The plan the agent hands the runner (CR-15: DOM / accessibility first) ──

export type PlanAction = "click" | "type" | "select" | "scroll" | "hover" | "reload" | "navigate";
export interface PlanStep {
  action: PlanAction;
  /** An element by its accessibility role and name, resolved against the latest snapshot. */
  target?: { role: string; name: string };
  text?: string;
  value?: string;
  dy?: number;
  /** navigate: a path on the preview origin (anything else is refused by CR-11). */
  path?: string;
  submit?: boolean;
}
export type Expectation =
  | { kind: "text"; text: string; absent?: boolean }
  | { kind: "element"; role: string; name: string; absent?: boolean }
  | { kind: "route"; path: string }
  | { kind: "no_errors" }
  /**
   * Needs visual judgment. The plan only asks the question: a judgment written into the
   * plan would be the coach deciding before anything was observed (CR-15, CR-81), so it is
   * refused at parse time. This slice has no vision step, so a visual expectation stays
   * "not verified" until a judgment made on the stored screenshot exists.
   */
  | { kind: "visual"; question: string };
export interface VerifyPlan {
  steps: PlanStep[];
  expect: Expectation[];
}

const ACTIONS: readonly PlanAction[] = ["click", "type", "select", "scroll", "hover", "reload", "navigate"];
const NEEDS_TARGET = new Set<PlanAction>(["click", "type", "select", "hover"]);
const s = (v: unknown, n = MAX_TEXT): string | null => (typeof v === "string" && v.trim() && v.length <= n ? v.trim() : null);

/** Parse the agent's plan (a JSON string or an object). Refused by name, never repaired. */
export function parsePlan(raw: unknown): { ok: true; plan: VerifyPlan } | { ok: false; code: string } {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return { ok: false, code: "plan_not_json" };
    }
  }
  if (!v || typeof v !== "object") return { ok: false, code: "invalid_plan" };
  const p = v as { steps?: unknown; expect?: unknown };
  if (!Array.isArray(p.steps) || p.steps.length > MAX_STEPS) return { ok: false, code: "invalid_steps" };
  if (!Array.isArray(p.expect) || p.expect.length < 1 || p.expect.length > MAX_EXPECT) return { ok: false, code: "invalid_expect" };
  const steps: PlanStep[] = [];
  for (const raw of p.steps as Array<Record<string, unknown>>) {
    const action = raw?.action as PlanAction;
    if (!ACTIONS.includes(action)) return { ok: false, code: "unknown_action" };
    const step: PlanStep = { action };
    const t = raw.target as Record<string, unknown> | undefined;
    if (t !== undefined) {
      const role = s(t?.role, 40);
      const name = s(t?.name);
      if (!role || !name) return { ok: false, code: "invalid_target" };
      step.target = { role, name };
    }
    if (NEEDS_TARGET.has(action) && !step.target) return { ok: false, code: "missing_target" };
    if (action === "type") {
      if (typeof raw.text !== "string" || raw.text.length > MAX_TEXT) return { ok: false, code: "invalid_text" };
      step.text = raw.text;
      if (raw.submit === true) step.submit = true;
    }
    if (action === "select") {
      const value = s(raw.value);
      if (!value) return { ok: false, code: "invalid_value" };
      step.value = value;
    }
    if (action === "scroll" && !step.target) {
      const dy = Number(raw.dy);
      if (!Number.isFinite(dy) || dy === 0) return { ok: false, code: "invalid_scroll" };
      step.dy = dy;
    }
    if (action === "navigate") {
      const path = s(raw.path, 500);
      if (!path) return { ok: false, code: "invalid_path" };
      step.path = path;
    }
    steps.push(step);
  }
  const expect: Expectation[] = [];
  for (const raw of p.expect as Array<Record<string, unknown>>) {
    switch (raw?.kind) {
      case "text": {
        const text = s(raw.text);
        if (!text) return { ok: false, code: "invalid_expectation" };
        expect.push({ kind: "text", text, ...(raw.absent === true ? { absent: true } : {}) });
        break;
      }
      case "element": {
        const role = s(raw.role, 40);
        const name = s(raw.name);
        if (!role || !name) return { ok: false, code: "invalid_expectation" };
        expect.push({ kind: "element", role, name, ...(raw.absent === true ? { absent: true } : {}) });
        break;
      }
      case "route": {
        const path = s(raw.path, 500);
        if (!path) return { ok: false, code: "invalid_expectation" };
        expect.push({ kind: "route", path });
        break;
      }
      case "no_errors":
        expect.push({ kind: "no_errors" });
        break;
      case "visual": {
        const question = s(raw.question);
        if (!question) return { ok: false, code: "invalid_expectation" };
        // CR-15/CR-81 — a verdict the coach wrote before the page was observed is not a judgment.
        if (raw.judgment !== undefined || raw.method !== undefined) return { ok: false, code: "plan_judgment" };
        expect.push({ kind: "visual", question });
        break;
      }
      default:
        return { ok: false, code: "invalid_expectation" };
    }
  }
  return { ok: true, plan: { steps, expect } };
}

// ── Verdicts (CR-15) ────────────────────────────────────────────────────────

export interface StepLog {
  index: number;
  action: string;
  target?: string;
  ok: boolean;
  message: string;
  route?: string;
}
/** The observation a verdict rests on. `step` is the step after which it was read. */
export interface Citation {
  step: number;
  kind: "snapshot" | "record" | "screenshot" | "route";
  detail: string;
}
export interface ErrorRecord {
  kind: string;
  message: string;
  step: number | null;
}
export interface ExpectationResult {
  kind: Expectation["kind"];
  ok: boolean | null;
  detail: string;
}
export interface CriterionVerdict {
  status: VerdictStatus;
  /**
   * `vision` only when a labelled visual judgment made on the stored screenshot decided
   * part of it (CR-15). The runner of this slice has no vision step and always says `dom`.
   */
  method: "dom" | "vision";
  steps: StepLog[];
  cites: Citation[];
  expectations: ExpectationResult[];
  runtime_errors: ErrorRecord[];
  network_errors: ErrorRecord[];
  /** Digest of the stored screenshot the verdict was read with, or null. */
  screenshot: string | null;
  viewport: { width: number; height: number } | null;
  reason?: string;
}

/** What the runner observed last: a plain-data slice of the Experiment Browser observation. */
export interface FinalObservation {
  step: number;
  snapshot: string;
  route: string;
  /** Failures (errors, exceptions, failed requests) of the run's document(s). */
  errors: ErrorRecord[];
  screenshot: string | null;
  viewport: { width: number; height: number } | null;
  /**
   * The snapshot was cut at its line cap, so text past the cap was never read: an absent
   * text or element, or a missing one, is then undecided, never pass or fail.
   */
  truncated?: boolean;
}

/** The same criterion across runs: its text, whitespace-normalized (CR-14 compares by text, not by event id). */
export const criterionKey = (text: string): string => text.normalize("NFC").replace(/\s+/g, " ").trim();

const OBSERVATION_KINDS = new Set<Citation["kind"]>(["snapshot", "record", "screenshot", "route"]);
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const refLineRe = (role: string, name: string) => new RegExp(`^\\[ref=(e\\d+)\\] ${escapeRe(role)} ${escapeRe(JSON.stringify(name))}$`, "m");

/**
 * The snapshot line for an element, or null: `[ref=eN] role "name"` for an interactive
 * element, `role: name` for a text role (heading, paragraph, text), which has no ref.
 */
export function elementLine(snapshot: string, role: string, name: string): string | null {
  return refLineRe(role, name).exec(snapshot)?.[0] ?? new RegExp(`^${escapeRe(role)}: ${escapeRe(name)}$`, "m").exec(snapshot)?.[0] ?? null;
}
/** The ref of an interactive element, or null (a text role has none to act on). */
export function elementRef(snapshot: string, role: string, name: string): string | null {
  return refLineRe(role, name).exec(snapshot)?.[1] ?? null;
}
/** The text a snapshot line shows: an element's accessible name, or a text role's text; never the ref or role tokens. */
function lineText(line: string): string | null {
  const ref = /^\[ref=e\d+\] [A-Za-z]+ (".*")$/.exec(line);
  if (ref) {
    try {
      const v: unknown = JSON.parse(ref[1]!);
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }
  return /^[A-Za-z]+: (.*)$/.exec(line)?.[1] ?? null;
}
const TRUNCATED = "화면 내용이 길어 앞부분만 읽었어요";
const textLine = (snapshot: string, text: string): string | null => snapshot.split("\n").find((l) => lineText(l)?.includes(text)) ?? null;

/**
 * Judge a plan's expectations against what the runner observed last. Pure: the same
 * observation always gives the same verdict, which is what CR-14 compares across runs.
 */
export function evaluate(final: FinalObservation, expect: readonly Expectation[], steps: StepLog[]): CriterionVerdict {
  const cites: Citation[] = [];
  const results: ExpectationResult[] = [];
  const at = final.step;
  for (const e of expect) {
    switch (e.kind) {
      case "text": {
        const line = textLine(final.snapshot, e.text);
        const ok = line === null && final.truncated ? null : e.absent ? line === null : line !== null;
        cites.push({ step: at, kind: "snapshot", detail: line ?? `(스냅샷에 "${e.text}" 없음)` });
        results.push({ kind: e.kind, ok, detail: `${e.absent ? "보이지 않아야 함" : "보여야 함"}: ${e.text}${ok === null ? ` (${TRUNCATED})` : ""}` });
        break;
      }
      case "element": {
        const line = elementLine(final.snapshot, e.role, e.name);
        const ok = line === null && final.truncated ? null : e.absent ? line === null : line !== null;
        cites.push({ step: at, kind: "snapshot", detail: line ?? `(스냅샷에 ${e.role} "${e.name}" 없음)` });
        results.push({ kind: e.kind, ok, detail: `${e.absent ? "없어야 함" : "있어야 함"}: ${e.role} "${e.name}"${ok === null ? ` (${TRUNCATED})` : ""}` });
        break;
      }
      case "route": {
        const ok = final.route === e.path || final.route.startsWith(`${e.path}?`) || final.route.startsWith(`${e.path}#`);
        cites.push({ step: at, kind: "route", detail: final.route });
        results.push({ kind: e.kind, ok, detail: `경로: ${e.path}` });
        break;
      }
      case "no_errors": {
        const ok = final.errors.length === 0;
        cites.push({ step: at, kind: "record", detail: ok ? "오류·실패한 요청 기록 0건" : final.errors.map((r) => `${r.kind}${r.step === null ? "" : ` 단계 ${r.step}`}: ${r.message}`).join(" | ").slice(0, 500) });
        results.push({ kind: e.kind, ok, detail: "콘솔 오류·실행 오류·실패한 요청 없음" });
        break;
      }
      case "visual": {
        // No vision judgment exists in this slice: undecided, never the coach's word.
        results.push({ kind: e.kind, ok: null, detail: `눈으로 판단해야 함(판단 없음): ${e.question}` });
        break;
      }
    }
  }
  const failedStep = steps.find((x) => !x.ok);
  let status: VerdictStatus;
  if (failedStep && !results.some((r) => r.ok === false)) {
    // A step that could not run (its element missing) is itself an observed failure.
    status = "fail";
    cites.push({ step: failedStep.index, kind: "snapshot", detail: failedStep.message.slice(0, 300) });
  } else if (results.some((r) => r.ok === false)) status = "fail";
  else if (results.some((r) => r.ok === null)) status = "not_verified";
  else if (final.errors.length && !expect.some((e) => e.kind === "no_errors")) status = "warning";
  else status = "pass";
  if (status === "warning") {
    for (const r of final.errors) cites.push({ step: at, kind: "record", detail: `${r.kind}${r.step === null ? "" : ` 단계 ${r.step}`}: ${r.message}`.slice(0, 300) });
  }
  return finalizeVerdict({
    status,
    method: "dom",
    steps,
    cites,
    expectations: results,
    runtime_errors: final.errors.filter((r) => r.kind !== "network"),
    network_errors: final.errors.filter((r) => r.kind === "network"),
    screenshot: final.screenshot,
    viewport: final.viewport,
  });
}

/**
 * CR-15 — a verdict must cite an observation. One that does not is "not verified", never
 * "pass" (nor fail: an uncited fail is an unfounded claim too). A vision verdict must cite
 * the screenshot it was judged on.
 */
export function finalizeVerdict(v: CriterionVerdict): CriterionVerdict {
  if (v.status === "not_verified") return v;
  const observed = v.cites.filter((c) => OBSERVATION_KINDS.has(c.kind) && typeof c.detail === "string" && c.detail.length > 0);
  if (!observed.length) return { ...v, status: "not_verified", reason: "판정의 근거가 된 관찰이 없어요" };
  if (v.method === "vision" && !observed.some((c) => c.kind === "screenshot")) return { ...v, status: "not_verified", reason: "화면 판단인데 근거 화면이 없어요" };
  return v;
}

/** A verdict refused outright when read back: unknown status or an unlabelled vision claim. */
export function verdictProblems(v: unknown): string[] {
  const p: string[] = [];
  const x = v as Partial<CriterionVerdict> | null;
  if (!x || typeof x !== "object") return ["invalid_verdict"];
  if (!["pass", "fail", "warning", "not_verified"].includes(String(x.status))) p.push("invalid_status");
  if (x.method !== "dom" && x.method !== "vision") p.push("invalid_method");
  if (!Array.isArray(x.steps)) p.push("missing_steps");
  if (!Array.isArray(x.cites)) p.push("missing_cites");
  const visualDecided = (x.expectations ?? []).some((e) => e?.kind === "visual" && e.ok !== null);
  if (visualDecided && x.method !== "vision") p.push("unlabelled_vision");
  return p;
}

// ── The per-criterion result event (tool_result text) ───────────────────────

export interface VerifyResult {
  format: typeof VERIFY_RESULT_FORMAT;
  run_id: string;
  /** The student's `criterion_set` event id. */
  criterion_id: string;
  criterion_text: string;
  /** Every criterion of the run, so a criterion the run never reached shows as not verified. */
  run_criteria?: Array<{ id: string; text: string }>;
  artifact_version: string;
  tested_at: number;
  plan: VerifyPlan;
  verdict: CriterionVerdict;
}

/** The recorder's event text cap: a longer text is cut and marks the whole batch incomplete. */
export const VERIFY_RESULT_TEXT_CAP = 20_000;
/** Room left under the cap for what the recorder's secret scrub may add. */
const RESULT_BUDGET = VERIFY_RESULT_TEXT_CAP - 1_000;

/**
 * Serialized under the recorder's 20,000-character event text cap, measured, not assumed:
 * the verdict's evidence is shortened step by step until it fits, and a result that still
 * does not fit is refused by name (`result_too_long`). The plan is never shortened, because
 * a re-test runs it exactly as stored.
 */
export function verifyResultText(r: VerifyResult): string {
  if (!VERSION_ID.test(r.artifact_version)) throw new Error("missing_artifact_version");
  const LEVELS = [
    { steps: 300, target: 400, cites: 20, cite: 500, errors: 10, error: 200, detail: 400, run: 300 },
    { steps: 120, target: 200, cites: 12, cite: 200, errors: 5, error: 120, detail: 200, run: 300 },
    { steps: 60, target: 80, cites: 8, cite: 120, errors: 2, error: 80, detail: 80, run: 80 },
  ];
  for (const l of LEVELS) {
    const capped: VerifyResult = {
      ...r,
      criterion_text: r.criterion_text.slice(0, MAX_TEXT),
      ...(r.run_criteria ? { run_criteria: r.run_criteria.map((c) => ({ id: c.id, text: c.text.slice(0, l.run) })) } : {}),
      verdict: {
        ...r.verdict,
        steps: r.verdict.steps.slice(0, MAX_STEPS + 2).map((x) => ({ ...x, message: x.message.slice(0, l.steps), ...(x.target !== undefined ? { target: x.target.slice(0, l.target) } : {}) })),
        cites: r.verdict.cites.slice(0, l.cites).map((c) => ({ ...c, detail: c.detail.slice(0, l.cite) })),
        expectations: r.verdict.expectations.map((e) => ({ ...e, detail: e.detail.slice(0, l.detail) })),
        runtime_errors: r.verdict.runtime_errors.slice(0, l.errors).map((e) => ({ ...e, message: e.message.slice(0, l.error) })),
        network_errors: r.verdict.network_errors.slice(0, l.errors).map((e) => ({ ...e, message: e.message.slice(0, l.error) })),
      },
    };
    const text = `${VERIFY_RESULT_FORMAT}\n${JSON.stringify(capped)}`;
    if (text.length <= RESULT_BUDGET) return text;
  }
  throw new Error("result_too_long");
}

/** Read a result back from a `tool_result` event; null when it is not one, or is malformed. */
export function readVerifyResult(e: { kind?: unknown; text?: unknown; artifact_version?: unknown }): VerifyResult | null {
  if (e.kind !== "tool_result" || typeof e.text !== "string" || !e.text.startsWith(`${VERIFY_RESULT_FORMAT}\n`)) return null;
  let r: VerifyResult;
  try {
    r = JSON.parse(e.text.slice(VERIFY_RESULT_FORMAT.length + 1));
  } catch {
    return null;
  }
  if (!r || r.format !== VERIFY_RESULT_FORMAT || !VERSION_ID.test(String(r.artifact_version))) return null;
  if (e.artifact_version !== undefined && e.artifact_version !== r.artifact_version) return null;
  if (verdictProblems(r.verdict).length) return null;
  return r;
}

/** A version-artifact event (recorded for `artifact_after`); not a revision of a file. */
export function isVersionArtifact(e: { kind?: unknown; text?: unknown }): boolean {
  return e.kind === "artifact" && typeof e.text === "string" && e.text.startsWith(`${VERSION_ARTIFACT_FORMAT}\n`);
}

/** The text of that event: the tag and the version's entry and file list. */
export function versionArtifactText(v: { id: string; entry: string; files: ReadonlyArray<{ path: string; sha256: string | null; bytes: number }> }): string {
  return `${VERSION_ARTIFACT_FORMAT}\n${JSON.stringify({ id: v.id, entry: v.entry, files: v.files.slice(0, 40) })}`.slice(0, 18_000);
}

/** The outcome a test event carries for a verdict (LEARNING_OUTCOMES). */
export const outcomeOf = (status: VerdictStatus): "match" | "mismatch" | "unknown" =>
  status === "pass" ? "match" : status === "fail" ? "mismatch" : "unknown";

/**
 * Which learning event a verdict is recorded as. The re-test SX-15 asks for is
 * `retest_confirmed`: a pass, in a run the student started with "다시 테스트", on a version
 * other than the one the criterion last failed on, with a fix request (change_requested)
 * after that failure. Everything else, a coach's own check included, is `test_observed`.
 */
export function testEventKind(
  events: readonly ObservationEvent[],
  criterionId: string,
  status: VerdictStatus,
  run: { retest: boolean; versionHex: string },
): "test_observed" | "retest_confirmed" {
  if (status !== "pass" || !run.retest) return "test_observed";
  const mine = [...events].sort((a, b) => a.seq - b.seq).filter((e) => e.criterion_ref === criterionId);
  const lastFail = [...mine].reverse().find((e) => (e.kind === "test_observed" || e.kind === "retest_confirmed") && e.outcome === "mismatch");
  if (!lastFail || lastFail.artifact_after === run.versionHex) return "test_observed";
  return mine.some((e) => e.kind === "change_requested" && e.seq > lastFail.seq) ? "retest_confirmed" : "test_observed";
}

// ── The report: a view over the events (CR-13, CR-14) ───────────────────────

export interface ReportCriterion {
  id: string;
  text: string;
  status: ReportStatus;
  method: "dom" | "vision";
  /** CR-14: false when another run on the same version and viewport disagreed. */
  reproducible: boolean;
  steps: StepLog[];
  cites: Citation[];
  expectations: ExpectationResult[];
  /** The console, runtime and network failures of this criterion's run. */
  errors: ErrorRecord[];
  reason?: string;
  /** The tool_result event the verdict is read from, and the test event that binds it; null when the run never tested it. */
  result_ref: string | null;
  test_ref: string | null;
  test_kind: "test_observed" | "retest_confirmed" | null;
}
export interface VerificationReport {
  format: typeof VERIFICATION_FORMAT;
  run_id: string;
  artifact_version_id: string;
  tested_at: string;
  viewport: { width: number; height: number } | null;
  criteria: ReportCriterion[];
  runtime_errors: ErrorRecord[];
  network_errors: ErrorRecord[];
  screenshots: string[];
  steps: Array<StepLog & { criterion_id: string }>;
}

interface BoundResult {
  result: VerifyResult;
  resultEvent: ObservationEvent;
  test: ObservationEvent;
}

/** Every verdict that is bound to a test event (no test event, no verdict). */
function boundResults(events: readonly ObservationEvent[]): BoundResult[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const out: BoundResult[] = [];
  for (const test of events) {
    if (test.kind !== "test_observed" && test.kind !== "retest_confirmed") continue;
    const ev = typeof test.result_ref === "string" ? byId.get(test.result_ref) : undefined;
    const result = ev ? readVerifyResult(ev) : null;
    if (!ev || !result) continue;
    // The test event and the result must agree on the criterion and the version.
    if (test.criterion_ref !== result.criterion_id || test.artifact_after !== versionHex(result.artifact_version)) continue;
    out.push({ result, resultEvent: ev, test });
  }
  return out.sort((a, b) => a.test.seq - b.test.seq);
}

/** Run ids in the order they were tested. */
export function runIds(events: readonly ObservationEvent[]): string[] {
  const ids: string[] = [];
  for (const b of boundResults(events)) if (!ids.includes(b.result.run_id)) ids.push(b.result.run_id);
  return ids;
}

const vpKey = (v: { width: number; height: number } | null) => (v ? `${v.width}x${v.height}` : "?");

/**
 * The `hps-verification/1` report of one run, computed from the events every time, or null
 * when the run left no bound verdict. A criterion whose decided verdict differs from another
 * run's on the same criterion, version and viewport is `non_reproducible` (CR-14), never
 * the pass of either run.
 */
export function verificationReport(events: readonly ObservationEvent[], runId: string): VerificationReport | null {
  const all = boundResults(events);
  const mine = all.filter((b) => b.result.run_id === runId);
  if (!mine.length) return null;
  const criterionText = (id: string, fallback: string) => {
    const c = events.find((e) => e.id === id && e.kind === "criterion_set");
    return typeof c?.student_text === "string" ? c.student_text : fallback;
  };
  const version = mine[0]!.result.artifact_version;
  // One verdict per criterion per run: the last one bound (the session refuses a second
  // call; this keeps an older record that has one readable).
  const lastOf = new Map<string, BoundResult>();
  for (const b of mine) if (b.result.artifact_version === version) lastOf.set(b.result.criterion_id, b);
  const planKey = (r: VerifyResult) => JSON.stringify(r.plan);
  const criteria: ReportCriterion[] = [];
  for (const b of lastOf.values()) {
    const v = b.result.verdict;
    const decided = (x: VerdictStatus) => x !== "not_verified";
    // CR-14 compares re-runs of the same plan: a different plan is a different test. The
    // criterion is matched by its text, not its event id, so pressing "테스트 시작" again with
    // the same words (a new criterion_set event) is still compared with the earlier runs.
    const key = criterionKey(b.result.criterion_text);
    const others = all.filter(
      (o) =>
        o.result.run_id !== runId &&
        criterionKey(o.result.criterion_text) === key &&
        o.result.artifact_version === version &&
        vpKey(o.result.verdict.viewport) === vpKey(v.viewport) &&
        planKey(o.result) === planKey(b.result),
    );
    const reproducible = !decided(v.status) || others.every((o) => !decided(o.result.verdict.status) || o.result.verdict.status === v.status);
    criteria.push({
      id: b.result.criterion_id,
      text: criterionText(b.result.criterion_id, b.result.criterion_text),
      status: reproducible ? v.status : "non_reproducible",
      method: v.method,
      reproducible,
      steps: v.steps,
      cites: v.cites,
      expectations: v.expectations,
      errors: [...v.runtime_errors, ...v.network_errors],
      ...(v.reason ? { reason: v.reason } : {}),
      result_ref: b.resultEvent.id,
      test_ref: b.test.id,
      test_kind: b.test.kind as "test_observed" | "retest_confirmed",
    });
  }
  // A criterion of the run that has no bound verdict was not tested: shown, never dropped,
  // so a run that skipped a criterion can never read as all-pass (CR-81).
  for (const c of mine.flatMap((b) => b.result.run_criteria ?? [])) {
    if (criteria.some((x) => x.id === c.id)) continue;
    criteria.push({ id: c.id, text: criterionText(c.id, c.text), status: "not_verified", method: "dom", reproducible: true, steps: [], cites: [], expectations: [], errors: [], reason: "이 실행에서 테스트하지 않았어요", result_ref: null, test_ref: null, test_kind: null });
  }
  const last = mine.at(-1)!.result;
  return {
    format: VERIFICATION_FORMAT,
    run_id: runId,
    artifact_version_id: version,
    tested_at: new Date(last.tested_at).toISOString(),
    viewport: last.verdict.viewport,
    criteria,
    runtime_errors: mine.flatMap((b) => b.result.verdict.runtime_errors),
    network_errors: mine.flatMap((b) => b.result.verdict.network_errors),
    screenshots: [...new Set(mine.map((b) => b.result.verdict.screenshot).filter((d): d is string => typeof d === "string"))],
    steps: mine.flatMap((b) => b.result.verdict.steps.map((x) => ({ ...x, criterion_id: b.result.criterion_id }))),
  };
}

/** CR-13 — a report missing a required field, or with criteria out of shape, is refused. */
export function validateVerificationReport(r: unknown): string[] {
  const p: string[] = [];
  const x = r as Partial<VerificationReport> | null;
  if (!x || typeof x !== "object") return ["invalid_report"];
  if (x.format !== VERIFICATION_FORMAT) p.push("invalid_format");
  if (typeof x.artifact_version_id !== "string" || !VERSION_ID.test(x.artifact_version_id)) p.push("missing_artifact_version_id");
  if (typeof x.tested_at !== "string" || Number.isNaN(Date.parse(x.tested_at))) p.push("missing_tested_at");
  if (!Array.isArray(x.steps)) p.push("missing_steps");
  if (!Array.isArray(x.criteria) || x.criteria.length < CRITERIA_MIN || x.criteria.length > CRITERIA_MAX) p.push("invalid_criteria");
  for (const c of x.criteria ?? []) {
    if (!["pass", "fail", "warning", "not_verified", "non_reproducible"].includes(String(c?.status))) p.push("invalid_status");
    if (typeof c?.text !== "string" || !c.text) p.push("invalid_criterion_text");
  }
  for (const k of ["runtime_errors", "network_errors", "screenshots"] as const) if (!Array.isArray(x[k])) p.push(`missing_${k}`);
  return [...new Set(p)];
}

// ── CR-81: "verified" only for an all-pass report on that exact version ─────

export type ProductVerificationState = "verified" | "failed" | "incomplete" | "needs_recheck" | "not_verified";
export interface ProductVerification {
  state: ProductVerificationState;
  run_id?: string;
  /** The report's criteria that are not pass, for the screen. */
  open: Array<{ id: string; text: string; status: ReportStatus }>;
  /** AE-37: the latest report of an earlier version, kept and shown, never erased. */
  previous?: { run_id: string; artifact_version_id: string };
}

/**
 * The verification state of a product version, read from the events only. Source
 * inspection, a build, a tool success or a coach message never set it (AE-05): the only
 * way to "verified" is an `hps-verification/1` report bound to `versionId` with every
 * criterion at pass.
 */
export function productVerification(events: readonly ObservationEvent[], versionId: string | null): ProductVerification {
  const reports = runIds(events)
    .map((id) => verificationReport(events, id))
    .filter((r): r is VerificationReport => !!r && validateVerificationReport(r).length === 0);
  const latestOther = [...reports].reverse().find((r) => r.artifact_version_id !== versionId);
  const previous = latestOther ? { run_id: latestOther.run_id, artifact_version_id: latestOther.artifact_version_id } : undefined;
  const sameVersion = versionId ? reports.filter((r) => r.artifact_version_id === versionId) : [];
  const here = sameVersion.at(-1);
  if (!here) return { state: previous ? "needs_recheck" : "not_verified", open: [], ...(previous ? { previous } : {}) };
  const open = here.criteria.filter((c) => c.status !== "pass").map((c) => ({ id: c.id, text: c.text, status: c.status }));
  // A later report never hides a decided fail or non-reproducible result for the same
  // criterion on the same files (CR-14, CR-81): not by a start with fewer criteria, and not
  // by a different plan that passed. The same files can only be fixed by changing them.
  for (const r of sameVersion) {
    if (r === here) continue;
    for (const c of r.criteria) {
      if (c.status !== "fail" && c.status !== "non_reproducible") continue;
      const at = open.findIndex((o) => criterionKey(o.text) === criterionKey(c.text));
      if (at === -1) open.push({ id: c.id, text: c.text, status: c.status });
      else if (open[at]!.status !== "fail" && open[at]!.status !== "non_reproducible") open[at] = { id: c.id, text: c.text, status: c.status };
    }
  }
  const state: ProductVerificationState = open.length === 0 ? "verified" : open.some((c) => c.status === "fail") ? "failed" : "incomplete";
  return { state, run_id: here.run_id, open, ...(previous ? { previous } : {}) };
}

// ── CR-16: a failed criterion as a structured fix request ──────────────────

export const FIX_REQUEST_FORMAT = "hps-fix-request/1";

export interface FixRequest {
  /** What the coach receives: the student's words, then the structured context. */
  coach_text: string;
  /** The `change_requested` learning event fields (the host adds actor and context). */
  event: { kind: "change_requested"; student_text: string; criterion_ref: string; artifact_before: string; turn_ref: string };
}

/**
 * A fix request references the report, the failing criterion and the version it failed
 * on, or it is refused: never sent to the coach as free text. `turn_ref` names the test
 * event the failure was recorded by.
 */
export function buildFixRequest(input: {
  report: VerificationReport | null | undefined;
  criterion_id: string | null | undefined;
  version: string | null | undefined;
  student_text: string | null | undefined;
}): { ok: true; request: FixRequest } | { ok: false; code: string } {
  const report = input.report;
  if (!report || typeof report.run_id !== "string" || !report.run_id) return { ok: false, code: "missing_report_ref" };
  if (!input.criterion_id) return { ok: false, code: "missing_criterion_ref" };
  if (!input.version || !VERSION_ID.test(input.version)) return { ok: false, code: "missing_version_ref" };
  if (report.artifact_version_id !== input.version) return { ok: false, code: "version_mismatch" };
  const c = report.criteria.find((x) => x.id === input.criterion_id);
  if (!c) return { ok: false, code: "criterion_not_in_report" };
  if (c.status === "pass") return { ok: false, code: "criterion_passed" };
  if (!c.test_ref) return { ok: false, code: "criterion_not_tested" };
  const text = typeof input.student_text === "string" ? input.student_text.trim() : "";
  if (!text) return { ok: false, code: "missing_student_text" };
  const context = {
    format: FIX_REQUEST_FORMAT,
    report: report.run_id,
    artifact_version: report.artifact_version_id,
    criterion: { id: c.id, text: c.text, status: c.status },
    steps: c.steps,
    observation: c.cites,
    expectations: c.expectations,
    errors: c.errors,
  };
  return {
    ok: true,
    request: {
      coach_text: `${text.slice(0, 2000)}\n\n[${FIX_REQUEST_FORMAT}] 아래는 "${c.text}" 조건이 ${c.status === "fail" ? "실패한" : "확인되지 않은"} 검증 결과예요. 이 결과를 근거로 고쳐 주세요. 고친 뒤 확인은 학생이 "다시 테스트"로 같은 조건을 돌려서 해요.\n${JSON.stringify(context).slice(0, 12_000)}`,
      event: { kind: "change_requested", student_text: text.slice(0, 2000), criterion_ref: c.id, artifact_before: versionHex(report.artifact_version_id), turn_ref: c.test_ref },
    },
  };
}

/** Is `hex` a plain sha256 hex digest (an `artifact` event's `sha256`)? */
export const isHexDigest = (hex: unknown): hex is string => typeof hex === "string" && HEX.test(hex);
