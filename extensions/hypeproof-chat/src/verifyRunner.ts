// AI Verify runner (cr-verify, #1392; CR-11, CR-14, CR-15, CR-68). Pure and vscode-free.
//
// Runs one criterion's plan on the student's own preview with the Experiment Browser's CR
// executor (recon §7 `cr-verify`: "Runner steps reuse BrowserControl.execute"), then
// judges the plan's expectations against what it observed last (`evaluate`,
// measurement-core verification.ts). DOM and accessibility first: targets are found by
// role and name in the `[ref=eN]` snapshot, and only a `visual` expectation is judged by
// vision, labelled as such (CR-15).
//
// Every run starts from a fresh load of the entry page, so the same plan on the same
// version and viewport meets the same page (CR-14). The executor keeps every step on the
// allowed origins and refuses anything else with a reason before any CDP call (CR-11), and
// draws the page outline for each step (CR-68); the run adds the chat-panel line around
// the whole run (`onRun`).
//
// Plain data in and out, no provider SDK (CR-03).

import { checkAgentOrigin, failuresOf, type CrToolResult, type Observation } from "./experimentBrowser.ts";
import { AX_SNAPSHOT_MAX_LINES } from "./browserControlHelpers.ts";
import {
  SNAPSHOT_TRUNCATED,
  elementRef,
  evaluate,
  finalizeVerdict,
  type CriterionVerdict,
  type ErrorRecord,
  type PlanStep,
  type StepLog,
  type VerifyPlan,
} from "../../../worker/src/lib/measurement-core/verification.ts";

/** What the runner needs: the CR executor (BrowserControl.crExecutor() in the App). */
export interface VerifyExecutor {
  execute(name: string, input?: Record<string, unknown>): Promise<CrToolResult>;
}

export interface RunOptions {
  /** The preview entry page every run starts from (the live server's URL). */
  startUrl: string;
  /** CR-11: the same allowed origins the executor enforces; checked before any step. */
  allowedOrigins(): readonly string[];
  /** Stores a screenshot and answers its digest, or null when nothing was stored (CR-10). */
  storeScreenshot?(base64: string, mimeType: string): Promise<string | null>;
  /** The chat-panel half of the indicator, around the whole run (CR-68). */
  onRun?(running: boolean): void;
}

export interface RunOutcome {
  verdict: CriterionVerdict;
  /**
   * The R4 version of the entry page at step 0, which every verdict of the run is bound to
   * (the version the student is testing), even when the run ends on another page of the
   * product; null when nothing was observed.
   */
  artifact: Observation["artifact"] | null;
  /** The last observation, for the coach's tool result (never stored as is). */
  observation: Observation | null;
}

const ACTION_TOOL: Record<PlanStep["action"], string> = {
  click: "browser_click",
  type: "browser_type",
  select: "browser_select",
  scroll: "browser_scroll",
  hover: "browser_hover",
  reload: "browser_reload",
  navigate: "browser_navigate",
};

/** The reason a run whose files changed while it ran is not verified. */
export const VERSION_CHANGED = "테스트하는 동안 파일이 바뀌어서 판정하지 않았어요. 다시 테스트해 주세요.";

/** Did the snapshot stop at its line cap (so lines past it were never read)? */
const isTruncated = (snapshot: string) => snapshot.split("\n").length >= AX_SNAPSHOT_MAX_LINES;
const textOf = (r: CrToolResult) => r.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n");
const notVerified = (steps: StepLog[], reason: string, artifact: Observation["artifact"] | null = null, observation: Observation | null = null): RunOutcome => ({
  verdict: finalizeVerdict({ status: "not_verified", method: "dom", steps, cites: [], expectations: [], runtime_errors: [], network_errors: [], screenshot: null, viewport: observation?.viewport ?? null, reason }),
  artifact,
  observation,
});

/** Run one criterion's plan and judge it. Never throws: a refusal is a not-verified verdict with its reason. */
export async function runCriterionPlan(ex: VerifyExecutor, plan: VerifyPlan, opts: RunOptions): Promise<RunOutcome> {
  const steps: StepLog[] = [];
  const scope = checkAgentOrigin(opts.startUrl, opts.allowedOrigins());
  if (!scope.ok) return notVerified(steps, scope.reason);
  opts.onRun?.(true);
  try {
    // Step 0: a fresh load of the entry page (CR-14: same start every run).
    const first = await ex.execute("browser_navigate", { url: opts.startUrl });
    steps.push({ index: 0, action: "navigate", target: opts.startUrl, ok: !first.isError, message: textOf(first).split("\n")[0]!.slice(0, 300), ...(first.observation ? { route: first.observation.route } : {}) });
    if (first.isError || !first.observation) return notVerified(steps, textOf(first).slice(0, 300) || "미리보기를 열지 못했어요");
    let last: Observation = first.observation;
    const artifact = last.artifact;
    // The failures of every document the run visited, not just the last one (a console
    // error before a navigate or reload still counts). A record carries the executor's step
    // counter, which runs on across the turn; it is mapped to this run's step index, so
    // "단계 N" names the runner step that observed it (a load error of the entry page is 0).
    const seen = new Set<string>();
    const errors: ErrorRecord[] = [];
    const runnerStep = new Map<number, number>();
    // A document whose event log dropped records past its cap, or began after it loaded, may
    // have had an error the run never read (CR-15): carried into the verdict, never ignored.
    let recordsIncomplete = false;
    const collect = (o: Observation, index: number) => {
      if (typeof o.step === "number") runnerStep.set(o.step, index);
      if (o.droppedRecords > 0 || o.recordsPartial) recordsIncomplete = true;
      for (const f of failuresOf(o.records)) {
        const key = `${o.documentGeneration}|${f.kind}|${f.step}|${f.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        errors.push({ kind: f.kind, message: f.message, step: f.step === null ? null : runnerStep.get(f.step) ?? null });
      }
    };
    collect(last, 0);
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      const index = i + 1;
      const input: Record<string, unknown> = {};
      let target: string | undefined;
      if (step.target) {
        target = `${step.target.role} "${step.target.name}"`;
        const ref = elementRef(last.snapshot, step.target.role, step.target.name);
        if (!ref) {
          // A snapshot cut at its line cap was never read past the cut: the element may be
          // there, so this is not an observed failure (CR-15).
          if (isTruncated(last.snapshot)) {
            steps.push({ index, action: step.action, target, ok: false, message: `${target}을(를) 읽은 화면 안에서 찾지 못했어요 (${SNAPSHOT_TRUNCATED})`, route: last.route });
            return notVerified(steps, SNAPSHOT_TRUNCATED, artifact, last);
          }
          // The element the plan needs is not on the page: an observed failure of this step.
          steps.push({ index, action: step.action, target, ok: false, message: `${target}을(를) 화면에서 찾지 못했어요`, route: last.route });
          break;
        }
        input.ref = ref;
      }
      if (step.action === "type") Object.assign(input, { text: step.text ?? "", ...(step.submit ? { submit: true } : {}) });
      if (step.action === "select") input.value = step.value;
      if (step.action === "scroll" && !step.target) input.dy = step.dy;
      if (step.action === "navigate") {
        let url: string;
        try {
          url = new URL(step.path!, opts.startUrl).href;
        } catch {
          return notVerified(steps, `주소를 해석할 수 없어요: ${step.path}`, artifact, last);
        }
        target = url;
        input.url = url;
        // CR-11: refused with its reason before the executor is even asked.
        const v = checkAgentOrigin(url, opts.allowedOrigins());
        if (!v.ok) {
          steps.push({ index, action: step.action, target, ok: false, message: v.reason });
          return notVerified(steps, v.reason, artifact, last);
        }
      }
      const r = await ex.execute(ACTION_TOOL[step.action], input);
      if (r.isError || !r.observation) {
        const message = textOf(r).slice(0, 300) || "단계를 실행하지 못했어요";
        steps.push({ index, action: step.action, ...(target ? { target } : {}), ok: false, message });
        // A refusal (scope, stale ref, no tab) is not an observation of the product.
        return notVerified(steps, message, artifact, last);
      }
      last = r.observation;
      collect(last, index);
      steps.push({ index, action: step.action, ...(target ? { target } : {}), ok: true, message: textOf(r).split("\n")[0]!.slice(0, 300), route: last.route });
    }
    // The entry page's files changed under the run: what was observed is not one version.
    if (artifact && last.artifact && last.artifact.entry === artifact.entry && last.artifact.id !== artifact.id) {
      return notVerified(steps, VERSION_CHANGED, artifact, last);
    }
    let screenshot: string | null = null;
    if (opts.storeScreenshot && last.screenshot?.data) screenshot = await opts.storeScreenshot(last.screenshot.data, last.screenshot.mimeType).catch(() => null);
    const verdict = evaluate(
      {
        step: steps.at(-1)!.index,
        snapshot: last.snapshot,
        route: last.route,
        errors,
        screenshot,
        viewport: last.viewport,
        // The snapshot stops at its line cap; text past it was never read (CR-15).
        truncated: isTruncated(last.snapshot),
        recordsIncomplete,
      },
      plan.expect,
      steps,
    );
    return { verdict, artifact, observation: last };
  } catch (err) {
    return notVerified(steps, err instanceof Error ? err.message : String(err));
  } finally {
    opts.onRun?.(false);
  }
}

/** One line per verdict for the coach's tool result and the chat panel. */
export function verdictLine(criterionText: string, v: CriterionVerdict): string {
  const label = { pass: "통과", fail: "실패", warning: "주의", not_verified: "확인 안 됨" }[v.status];
  const why = v.status === "fail"
    ? v.expectations.filter((e) => e.ok === false).map((e) => e.detail).join(", ") || v.steps.find((s) => !s.ok)?.message || ""
    : v.reason ?? "";
  return `[${label}] ${criterionText}${why ? ` — ${why}` : ""}${v.method === "vision" ? " (화면 판단)" : ""}`;
}
