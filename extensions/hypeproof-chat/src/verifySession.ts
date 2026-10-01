// "Test my product" orchestration (cr-verify, #1392; CR-12–CR-16, CR-68, CR-81). Pure and
// vscode-free: ChatPanelProvider supplies the ports (the record, the preview, the CR
// executor) and keeps only the calls into this class, so the smokes drive the whole flow.
//
// The flow a student sees:
//   1. 1–5 criteria, typed by the student or adopted from the coach's proposals (an AI
//      proposal never runs until the student confirms it). Each becomes a `criterion_set`
//      learning event on the one record (SX-14, SX-45, HC-04).
//   2. The coach is asked to test them: for each criterion it hands the runner a plan
//      through `verify_criterion`, and the runner executes it on the student's own preview
//      and judges it (verifyRunner.ts). Each verdict is recorded against the artifact
//      version it ran on (measurement-core verification.ts).
//   3. A failed criterion becomes a fix request that references the report, the criterion
//      and the version (CR-16), recorded as `change_requested` and sent to the coach.
//   4. "다시 테스트" re-runs the stored plans with no model call (CR-14); a pass after a fix
//      request, on a version other than the failing one, is `retest_confirmed` (SX-15).
//
// A run is pinned to the version current when it started and closes once every criterion
// has a verdict, when the turn it rode with ends, or when the files change; a closed run
// takes no more coach calls. One run acts on the browser tab at a time (`exclusive`).
//   5. "검증됨" only for a version with an all-pass report bound to it (CR-81).

import { randomUUID } from "node:crypto";
import type { ObservationEvent } from "../../../worker/src/lib/measurement-core/legacy-observation.ts";
import {
  CRITERIA_MAX,
  VERIFY_TOOL,
  buildFixRequest,
  checkCriteria,
  outcomeOf,
  parsePlan,
  productVerification,
  readVerifyResult,
  runIds,
  testEventKind,
  verificationReport,
  verifyResultText,
  versionArtifactText,
  versionHex,
  type CriterionInput,
  type VerifyPlan,
} from "../../../worker/src/lib/measurement-core/verification.ts";
import { VERSION_CHANGED, runCriterionPlan, verdictLine, type VerifyExecutor } from "./verifyRunner.ts";
import type { ActiveRun, VerifyCriterion, VerifyProposal, VerifyView } from "./verifyView.ts";

export const VERIFY_PROPOSE_TOOL = "verify_propose_criteria";
export const VERIFY_PROPOSAL_FORMAT = "hps-verify-proposal/1";

export type VerifyLearningKind = "criterion_set" | "test_observed" | "retest_confirmed" | "change_requested";
export type VerifyLearningDraft = { kind: VerifyLearningKind; actor: "user" | "ai"; evidence_type: "criterion" | "action" | "change"; source_state: "self_reported" | "real" } & Record<string, unknown>;

/** The record a verify action writes to: the turn's recorder inside a turn, else the seat's. */
export interface VerifyRecorderPort {
  events(): readonly ObservationEvent[];
  /** A /1 event on the learning task. Throws when it cannot be recorded. */
  record(kind: "artifact" | "tool_request" | "tool_result", text: string, extra: Partial<ObservationEvent>): ObservationEvent;
  /** A learning event with actor fixed here and context by the host; throws (with a code) when the batch would not validate. */
  recordLearning(draft: VerifyLearningDraft): ObservationEvent;
  persist(): void;
}

export interface VerifyHostPorts {
  switchOn(): boolean;
  recorder(): Promise<VerifyRecorderPort | null>;
  /** The preview entry page (live server URL), or null when the preview is off. */
  startUrl(): string | null;
  allowedOrigins(): readonly string[];
  executor(): VerifyExecutor | undefined;
  /** The R4 version of the preview entry as it is now, or null. */
  currentVersion(): Promise<string | null>;
  storeScreenshot?(base64: string, mimeType: string): Promise<string | null>;
  /** CR-68, chat-panel half: a run is acting on the page. */
  onRun?(running: boolean): void;
  now?(): number;
}

export type { ActiveRun, VerifyCriterion, VerifyProposal, VerifyView } from "./verifyView.ts";

export type ToolAnswer = { isError: boolean; text: string };

const REFUSAL: Record<string, string> = {
  criteria_count: `기대 조건은 1개에서 ${CRITERIA_MAX}개까지 적을 수 있어요.`,
  empty_criterion: "비어 있는 조건이 있어요. 내용을 적거나 빼 주세요.",
  criterion_too_long: "조건 하나가 너무 길어요. 300자 안으로 줄여 주세요.",
  unconfirmed_ai_criterion: "코치가 제안한 조건은 내가 확인해야 쓸 수 있어요. '이대로 쓰기'를 누르거나 고쳐 써 주세요.",
  missing_adopted_from: "코치 제안을 확인하지 못했어요. 다시 골라 주세요.",
  duplicate_criterion: "같은 조건이 두 번 있어요.",
  switch_off: "지금 수업에서는 제품 테스트를 쓸 수 없어요.",
  no_record: "이 수업에서는 테스트 기록을 남길 수 없어 시작하지 않았어요.",
  no_preview: "먼저 미리보기를 켜야 테스트할 수 있어요.",
  busy: "테스트가 이미 진행 중이에요.",
  missing_report_ref: "고칠 근거가 될 테스트 결과가 없어요.",
  missing_criterion_ref: "어느 조건을 고칠지 골라 주세요.",
  missing_version_ref: "어느 버전에서 실패했는지 확인하지 못했어요.",
  version_mismatch: "그 결과는 다른 버전의 결과예요.",
  criterion_not_in_report: "그 조건은 이 테스트 결과에 없어요.",
  criterion_passed: "통과한 조건은 고쳐 달라고 할 필요가 없어요.",
  criterion_not_tested: "그 조건은 아직 테스트하지 않았어요. 먼저 테스트해 주세요.",
  missing_student_text: "무엇을 고쳐 달라고 할지 내 말로 적어 주세요.",
  no_plans: "다시 돌릴 테스트가 없어요. 먼저 '테스트 시작'을 해 주세요.",
  turn_running: "코치가 답하는 중이에요. 답이 끝난 뒤에 다시 눌러 주세요.",
  record_failed: "조건을 기록하지 못해 테스트를 시작하지 않았어요. 다시 시도해 주세요.",
};
export const refusalText = (code: string): string => REFUSAL[code] ?? `처리하지 못했어요 (${code}).`;

export class VerifySession {
  private run: ActiveRun | null = null;
  private proposals: VerifyProposal[] = [];
  /** Runs acting on the page right now (CR-68): the coach's verify calls and a re-test. */
  private acting = 0;
  /** Set synchronously when a re-test is asked for, before its first await. */
  private retesting = false;
  /** The one browser tab: every run on it goes through this chain, one at a time. */
  private tab: Promise<unknown> = Promise.resolve();
  private coachContext: string | null = null;
  private notice: string | null = null;
  private readonly ports: VerifyHostPorts;
  private readonly newId: () => string;

  constructor(ports: VerifyHostPorts, newId: () => string = randomUUID) {
    this.ports = ports;
    this.newId = newId;
  }

  /** The model-only context the next turn carries (consumed once), or null. */
  takeCoachContext(): string | null {
    const c = this.coachContext;
    this.coachContext = null;
    return c;
  }

  /** The turn ended: an open run takes no more coach calls (a later turn cannot test on its own). */
  endTurn(): void {
    this.run = null;
  }

  /** Run `fn` when the tab is free; one run on the tab at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tab.then(fn, fn);
    this.tab = next.catch(() => undefined);
    return next;
  }

  get activeRun(): ActiveRun | null {
    return this.run;
  }

  /** Is a run acting on the page, or a re-test under way? */
  get running(): boolean {
    return this.acting > 0 || this.retesting;
  }

  /**
   * CR-12 — start a run with 1–5 criteria. Records each as the student's `criterion_set`
   * and returns the text the student sends; the coach context rides with it, model-only.
   */
  async start(drafts: unknown): Promise<{ ok: true; sendText: string } | { ok: false; code: string }> {
    if (!this.ports.switchOn()) return { ok: false, code: "switch_off" };
    if (this.running) return { ok: false, code: "busy" };
    const checked = checkCriteria(Array.isArray(drafts) ? drafts.map((d: CriterionInput) => this.withProposal(d)) : drafts);
    if (!checked.ok) return checked;
    const startUrl = this.ports.startUrl();
    if (!startUrl) return { ok: false, code: "no_preview" };
    const version = await this.ports.currentVersion().catch(() => null);
    const rec = await this.ports.recorder();
    if (!rec) return { ok: false, code: "no_record" };
    const criteria: VerifyCriterion[] = [];
    try {
      for (const c of checked.criteria) {
        const e = rec.recordLearning({
          kind: "criterion_set",
          actor: "user",
          evidence_type: "criterion",
          source_state: "self_reported",
          student_text: c.text,
          ...(c.adopted_from ? { adopted_from: c.adopted_from } : {}),
        });
        criteria.push({ id: e.id, text: c.text });
      }
    } catch {
      // Refused by name; criteria already written stay as the student's own (never a run).
      return { ok: false, code: "record_failed" };
    } finally {
      rec.persist();
    }
    this.run = { run_id: this.newId(), criteria, done: [], version, origin: "coach" };
    this.proposals = this.proposals.filter((p) => !checked.criteria.some((c) => c.adopted_from === p.id));
    this.coachContext = coachRunContext(this.run, startUrl);
    this.notice = null;
    return { ok: true, sendText: `내 제품을 이 기대 조건 ${criteria.length}개로 테스트해 주세요:\n${criteria.map((c, i) => `${i + 1}. ${c.text}`).join("\n")}` };
  }

  /** A proposal the student adopted keeps the id of the event that recorded it (design rule 4). */
  private withProposal(d: CriterionInput): CriterionInput {
    if (d?.proposed_by !== "ai") return { ...d, proposed_by: "student" };
    const p = this.proposals.find((x) => x.id === d.adopted_from);
    // A proposal the session does not know is not a coach proposal: refused as unconfirmed.
    return p ? d : { ...d, confirmed: false };
  }

  /** `verify_propose_criteria` from the coach: drafts the student must confirm (SX-14, HC-04). */
  async propose(input: Record<string, unknown>): Promise<ToolAnswer> {
    if (!this.ports.switchOn()) return { isError: true, text: refusalText("switch_off") };
    const raw = input.criteria;
    let list: unknown = raw;
    if (typeof raw === "string") {
      try {
        list = JSON.parse(raw);
      } catch {
        list = raw.split("\n");
      }
    }
    const texts = (Array.isArray(list) ? list : []).map((t) => (typeof t === "string" ? t.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim() : "")).filter((t) => t && t.length <= 300).slice(0, CRITERIA_MAX);
    if (!texts.length) return { isError: true, text: "제안할 기대 조건이 없어요. criteria에 1~5개를 적어 주세요." };
    const rec = await this.ports.recorder();
    if (!rec) return { isError: true, text: refusalText("no_record") };
    const toolId = `verify-propose-${this.newId()}`;
    try {
      rec.record("tool_request", `${VERIFY_PROPOSE_TOOL}(${texts.length})`, { tool_id: toolId });
      const res = rec.record("tool_result", `${VERIFY_PROPOSAL_FORMAT}\n${JSON.stringify(texts)}`, { tool_id: toolId, outcome: "success" });
      this.proposals = texts.map((text, i) => ({ id: res.id, text, index: i })).map(({ id, text }) => ({ id, text }));
    } finally {
      rec.persist();
    }
    return { isError: false, text: `제안 ${texts.length}개를 학생 화면에 보여 줬어요. 학생이 확인하거나 고쳐 쓴 조건만 테스트에 쓰여요. 학생이 확인하기 전에는 테스트를 시작하지 마세요.` };
  }

  /**
   * `verify_criterion` from the coach: run the plan for one criterion of the active run on
   * the preview, record the verdict, and answer the coach with it (CR-13, CR-15).
   */
  async runTool(input: Record<string, unknown>): Promise<ToolAnswer> {
    if (!this.ports.switchOn()) return { isError: true, text: refusalText("switch_off") };
    if (this.retesting) return { isError: true, text: refusalText("busy") };
    const run = this.run;
    if (!run) return { isError: true, text: `진행 중인 테스트가 없어요. 학생이 "테스트 시작"을 눌러야 ${VERIFY_TOOL}을 쓸 수 있어요.` };
    const criterion = run.criteria.find((c) => c.id === input.criterion_id);
    if (!criterion) return { isError: true, text: `이 테스트의 조건이 아니에요: ${String(input.criterion_id)}. 조건 id: ${run.criteria.map((c) => c.id).join(", ")}` };
    // One verdict per criterion per run: a second plan is not a retry, it is shopping for a pass.
    if (run.done.includes(criterion.id)) return { isError: true, text: `이 조건은 이번 테스트에서 이미 판정했어요: ${criterion.id}. 다시 확인은 학생의 "다시 테스트"가 해요.` };
    const parsed = parsePlan(input.plan);
    if (!parsed.ok) return { isError: true, text: `계획을 읽지 못했어요 (${parsed.code}). steps와 expect를 다시 보내 주세요.` };
    return this.exclusive(async () => {
      // The run may have closed, or been tested, while this call waited for the tab.
      if (this.run !== run || run.done.includes(criterion.id)) return { isError: true, text: "이 테스트는 이미 끝났어요." };
      // The run is pinned to the version it started on: changed files close it.
      const now = await this.ports.currentVersion().catch(() => null);
      if (run.version !== now) {
        this.run = null;
        return { isError: true, text: `테스트를 시작한 뒤 파일이 바뀌어 이 테스트를 닫았어요. 학생이 다시 "테스트 시작"이나 "다시 테스트"를 해야 해요.` };
      }
      const answer = await this.execute(run, criterion, parsed.plan);
      if (!answer.isError && !run.done.includes(criterion.id)) run.done.push(criterion.id);
      const left = run.criteria.filter((c) => !run.done.includes(c.id));
      if (!left.length && this.run === run) this.run = null;
      return { ...answer, text: `${answer.text}${left.length ? `\n남은 조건: ${left.map((c) => c.id).join(", ")}` : "\n모든 조건을 테스트했어요. 결과를 학생에게 짧게 알려 주세요 — 통과로 바꾸어 말하지 마세요."}` };
    });
  }

  /**
   * CR-14, CR-16 — "다시 테스트": every criterion of the latest run, with its stored plan,
   * on the preview as it is now, and no model call. A new run. Always the whole set, so a
   * version is never "verified" by re-testing only the criterion that was fixed.
   */
  async retest(): Promise<{ ok: true; run_id: string } | { ok: false; code: string }> {
    if (!this.ports.switchOn()) return { ok: false, code: "switch_off" };
    if (this.running) return { ok: false, code: "busy" };
    // Claimed before the first await, so a second click or a coach call is refused.
    this.retesting = true;
    try {
      const rec = await this.ports.recorder();
      if (!rec) return { ok: false, code: "no_record" };
      const events = rec.events();
      const latest = runIds(events).at(-1);
      const report = latest ? verificationReport(events, latest) : null;
      // Every criterion of the latest run, untested ones included: those have no plan and
      // stay in the new run as not verified, so a re-test never shrinks the set (CR-81).
      const criteria: VerifyCriterion[] = (report?.criteria ?? []).map((c) => ({ id: c.id, text: c.text }));
      const plans: Array<{ criterion: VerifyCriterion; plan: VerifyPlan }> = [];
      for (const c of criteria) {
        const r = [...events].reverse().map((e) => readVerifyResult(e)).find((x) => x?.criterion_id === c.id);
        if (r) plans.push({ criterion: { id: c.id, text: r.criterion_text }, plan: r.plan });
      }
      if (!plans.length) return { ok: false, code: "no_plans" };
      const version = await this.ports.currentVersion().catch(() => null);
      const run: ActiveRun = { run_id: this.newId(), criteria, done: [], version, origin: "retest" };
      this.run = null;
      await this.exclusive(async () => {
        for (const p of plans) {
          const a = await this.execute(run, p.criterion, p.plan, rec);
          if (!a.isError) run.done.push(p.criterion.id);
        }
      });
      return { ok: true, run_id: run.run_id };
    } finally {
      this.retesting = false;
    }
  }

  /** CR-16 — a failed criterion as a fix request to the coach. */
  async fix(criterionId: unknown, studentText: unknown): Promise<{ ok: true; sendText: string } | { ok: false; code: string }> {
    if (!this.ports.switchOn()) return { ok: false, code: "switch_off" };
    const rec = await this.ports.recorder();
    if (!rec) return { ok: false, code: "no_record" };
    const events = rec.events();
    const id = typeof criterionId === "string" ? criterionId : null;
    // The latest report that holds this criterion: the result the request is about.
    const report = [...runIds(events)].reverse().map((r) => verificationReport(events, r)).find((r) => r?.criteria.some((c) => c.id === id)) ?? null;
    const built = buildFixRequest({ report, criterion_id: id, version: report?.artifact_version_id ?? null, student_text: typeof studentText === "string" ? studentText : null });
    if (!built.ok) return built;
    try {
      rec.recordLearning({ ...built.request.event, actor: "user", evidence_type: "change", source_state: "self_reported" });
    } finally {
      rec.persist();
    }
    const [studentLine, ...rest] = built.request.coach_text.split("\n\n");
    this.coachContext = rest.join("\n\n");
    return { ok: true, sendText: studentLine! };
  }

  private async execute(run: ActiveRun, criterion: VerifyCriterion, plan: VerifyPlan, given?: VerifyRecorderPort): Promise<ToolAnswer> {
    const ex = this.ports.executor();
    const startUrl = this.ports.startUrl();
    if (!ex || !startUrl) return { isError: true, text: refusalText("no_preview") };
    this.acting++;
    let outcome: Awaited<ReturnType<typeof runCriterionPlan>>;
    try {
      outcome = await runCriterionPlan(ex, plan, {
        startUrl,
        allowedOrigins: () => this.ports.allowedOrigins(),
        ...(this.ports.storeScreenshot ? { storeScreenshot: (b, m) => this.ports.storeScreenshot!(b, m) } : {}),
        onRun: (r) => this.ports.onRun?.(r),
      });
    } finally {
      this.acting--;
    }
    // The files changed under the run (the entry page is not the version it started on):
    // bound to the start version, but not verified.
    if (outcome.artifact && outcome.verdict.status !== "not_verified") {
      const now = await this.ports.currentVersion().catch(() => null);
      if (now !== null && now !== outcome.artifact.id) {
        outcome = { ...outcome, verdict: { ...outcome.verdict, status: "not_verified", reason: VERSION_CHANGED } };
      }
    }
    const line = verdictLine(criterion.text, outcome.verdict);
    // A run that observed nothing has no version to bind to: answered, never recorded.
    if (!outcome.artifact) return { isError: true, text: `${line}\n(산출물 버전을 정하지 못해 결과를 기록하지 않았어요.)` };
    const rec = given ?? (await this.ports.recorder());
    if (!rec) return { isError: true, text: `${line}\n(${refusalText("no_record")})` };
    const version = outcome.artifact.id;
    const hex = versionHex(version);
    try {
      const lastArtifact = [...rec.events()].reverse().find((e) => e.kind === "artifact");
      if (lastArtifact?.sha256 !== hex) rec.record("artifact", versionArtifactText(outcome.artifact), { sha256: hex });
      const toolId = `verify-${run.run_id}-${criterion.id}`.slice(0, 200);
      rec.record("tool_request", `${VERIFY_TOOL}(${criterion.text.slice(0, 120)})`, { tool_id: toolId, sha256: hex });
      const result = rec.record(
        "tool_result",
        verifyResultText({
          format: "hps-verify-result/1",
          run_id: run.run_id,
          criterion_id: criterion.id,
          criterion_text: criterion.text,
          run_criteria: run.criteria.map((c) => ({ id: c.id, text: c.text.slice(0, 300) })),
          artifact_version: version,
          tested_at: this.ports.now?.() ?? Date.now(),
          plan,
          verdict: outcome.verdict,
        }),
        { tool_id: toolId, outcome: "success", sha256: hex, artifact_version: version, ...(outcome.verdict.screenshot ? { screenshot_digest: outcome.verdict.screenshot } : {}) },
      );
      const status = outcome.verdict.status;
      rec.recordLearning({
        kind: testEventKind(rec.events(), criterion.id, status, { retest: run.origin === "retest", versionHex: hex }),
        actor: "ai",
        evidence_type: "action",
        source_state: "real",
        criterion_ref: criterion.id,
        artifact_after: hex,
        outcome: outcomeOf(status),
        result_ref: result.id,
      });
    } catch (err) {
      return { isError: true, text: `${line}\n(결과를 기록하지 못했어요: ${err instanceof Error ? err.message : String(err)})` };
    } finally {
      rec.persist();
    }
    return { isError: false, text: line };
  }

  /** The panel state, computed from the record every time (never stored). */
  async view(): Promise<VerifyView> {
    const on = this.ports.switchOn();
    const rec = on ? await this.ports.recorder() : null;
    const events = rec?.events() ?? [];
    const version = on ? await this.ports.currentVersion().catch(() => null) : null;
    const verification = productVerification(events, version);
    const ids = runIds(events);
    const here = [...ids].reverse().map((id) => verificationReport(events, id)).find((r) => r && r.artifact_version_id === version) ?? null;
    const report = here ?? (ids.length ? verificationReport(events, ids.at(-1)!) : null);
    const reason = !on ? refusalText("switch_off") : !rec ? refusalText("no_record") : !this.ports.startUrl() ? refusalText("no_preview") : null;
    return { available: on && !!rec, reason, version, verification, report, run: this.run, proposals: [...this.proposals], running: this.running, notice: this.notice };
  }

  setNotice(text: string | null): void {
    this.notice = text;
  }
}

/** What the coach is told when a run starts (model-only; the student sees their own sentence). */
export function coachRunContext(run: ActiveRun, startUrl: string): string {
  return [
    `[Studio 제품 테스트 ${run.run_id}] 학생이 "테스트 시작"을 눌렀다. 아래 기대 조건마다 ${VERIFY_TOOL}를 한 번씩 불러라.`,
    `- criterion_id: 아래 id 그대로. plan: JSON 문자열 {"steps":[...],"expect":[...]}.`,
    `- steps는 미리보기(${startUrl})를 새로 연 상태에서 시작한다. action: click·type·select·scroll·hover·reload·navigate, 요소는 {"target":{"role":"button","name":"주문하기"}}처럼 접근성 역할과 이름으로.`,
    `- expect: {"kind":"text","text":"..."} · {"kind":"element","role":"...","name":"..."} · {"kind":"route","path":"/..."} · {"kind":"no_errors"} · 눈으로만 판단할 것만 {"kind":"visual","question":"..."}(판단은 적지 않는다: 적으면 거절되고, visual은 확인 안 됨으로 남는다).`,
    `- 조건마다 한 번만 부른다. 같은 조건을 다른 계획으로 다시 부르면 거절된다.`,
    `- 판정은 러너가 관찰로 한다. 결과를 통과로 바꾸어 말하지 말고, 실패하면 실패라고 전해라.`,
    ...run.criteria.map((c) => `- ${c.id}: ${c.text}`),
  ].join("\n");
}

/**
 * Record one event and keep it only if the batch still validates. A stored batch that no
 * longer validates is unreadable on the next load (every record of the seat lost), so a
 * verify event the validator would refuse is taken back here and the refusal thrown.
 */
export function recordChecked<E>(batch: { events: E[] }, validate: (batch: unknown) => unknown, write: () => E): E {
  const before = batch.events.length;
  const event = write();
  try {
    validate(batch);
  } catch (err) {
    batch.events.splice(before);
    throw err;
  }
  return event;
}

/**
 * The learning-event context of a verify event. The /2 validator requires a non-empty step
 * id and module version, which a profile without a lesson does not have; such a seat gets
 * named placeholders instead of empty strings that would make the batch unreadable.
 */
export function verifyContext(input: { week?: unknown; stepId?: unknown; task: string; moduleVersion?: unknown }): { week: number; step_id: string; task: string; module_version: string } {
  const week = Number(input.week);
  return {
    week: Number.isSafeInteger(week) && week >= 1 ? week : 1,
    step_id: typeof input.stepId === "string" && input.stepId ? input.stepId : "test-my-product",
    task: input.task,
    module_version: input.moduleVersion !== undefined && input.moduleVersion !== null && String(input.moduleVersion) ? String(input.moduleVersion) : "unversioned",
  };
}

/** A verify answer as a browser tool result, so both runtimes convert it the same way (CR-03). */
export function verifyToolResult(a: ToolAnswer): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  return { content: [{ type: "text", text: a.text }], isError: a.isError };
}
