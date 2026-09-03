// 모델별 요청 파라미터 수용 표 + 정리기 (#687).
//
// routes/messages.ts 에서 떼어낸 이유는 저장소 관례 그대로다 — 순수 로직은 확장자
// 없는 내부 import 를 끌고 오지 않는 모듈에 두어 **플레인 Node 로 테스트**할 수 있게
// 한다(test/model-gated-params.test.mjs). 라우트 안에 있을 때는 import 사슬 때문에
// 단위 테스트가 불가능했고, 그래서 이 표가 죽어 있는 것을 아무도 못 잡았다.

import type { AnthropicModelId } from "../profiles/types";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 미성년 코호트에 적용할 effort. 상수로 두는 이유는 테스트가 "프롬프트에 적힌 값"이
 * 아니라 **상류에 실제로 나가는 값**을 이것과 대조하기 위해서다 — 이 파일에서 값이
 * 죽어 있던 것이 #687 이었다.
 */
export const MINOR_EFFORT: EffortLevel = "medium";

/** Cheapest → most expensive. Downgrades walk DOWN this list, never up. */
const EFFORT_LADDER: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

type ModelCaps = {
  /** effort levels this model accepts inside `output_config`. [] = no effort param at all. */
  readonly effort: readonly EffortLevel[];
  /** `context_management` (context-management-2025-06-27 beta) accepted. */
  readonly contextManagement: boolean;
  /** DATED evidence for the two flags above. Non-empty + dated, enforced by the lock test. */
  readonly verifiedBy: string;
};

/**
 * `contextManagement` is false everywhere ON PURPOSE, and NOT because it is
 * known to be model-gated. Context editing is BETA-gated
 * (`context-management-2025-06-27`, beta on 1P for every model), and
 * lib/anthropic.ts mergeAnthropicBeta DOES forward the client's beta header —
 * so the 2026-07-24 curl probe, which sent the field without that header, does
 * not distinguish "model rejects it" from "beta not enabled on the probe".
 * We keep stripping it because (a) it is unverified and this route fails
 * closed, and (b) context editing prunes the transcript and breaks the prompt
 * cache from the clear point on — no upside in a 90-minute session. Flipping it
 * needs a fresh prod probe WITH the beta header, on its own issue.
 */
const MODEL_CAPS: Record<AnthropicModelId, ModelCaps> = {
  "claude-haiku-4-5": {
    effort: [],
    contextManagement: false,
    verifiedBy:
      "2026-09-03 docs: effort is an Opus 4.5/4.6 + Sonnet 4.6 parameter; `max` errors on Haiku 4.5. " +
      "Reachable here via resolveMessagesModel's /claude-.*haiku/ fast pin (CLI aux calls).",
  },
  "claude-sonnet-4-6": {
    effort: ["low", "medium", "high", "max"],
    contextManagement: false,
    verifiedBy:
      '2026-07-24 prod probe (same token+cohort): output_config{effort:"xhigh"} → 400. ' +
      "2026-09-03 docs: xhigh is new on Opus 4.7; the 4.6 ladder is low|medium|high|max, default high.",
  },
  "claude-opus-4-7": {
    effort: ["low", "medium", "high", "xhigh", "max"],
    contextManagement: false,
    verifiedBy: "2026-09-03 docs: Opus 4.7 carries the full ladder incl. xhigh (introduced on 4.7).",
  },
};

/** Highest level at or below `requested` that the model accepts, else undefined. */
function downgradeEffort(
  requested: string,
  allowed: readonly EffortLevel[],
): EffortLevel | undefined {
  // An unrecognised level string yields -1 → the loop never runs → drop it.
  for (let i = EFFORT_LADDER.indexOf(requested as EffortLevel); i >= 0; i--) {
    const level = EFFORT_LADDER[i]!;
    if (allowed.includes(level)) return level;
  }
  return undefined;
}

/**
 * Drop or downgrade the model-gated params the resolved model cannot accept.
 * Pure; returns a new body plus a human-readable list of what changed so the
 * caller can log it — an SDK bump that introduces the NEXT such param must
 * surface as a log line, not as another silent classroom outage.
 *
 * Unknown model id → fail closed (strip both), because an unpinned model is by
 * definition unverified. MODEL_CAPS is exhaustive over AnthropicModelId, so
 * that branch is only reachable for a client-supplied id that escaped
 * resolveMessagesModel — never for one of our own pins.
 */
export function stripModelGatedParams(
  body: Record<string, unknown>,
  resolvedModel: string,
): { body: Record<string, unknown>; dropped: string[] } {
  const caps = (MODEL_CAPS as Record<string, ModelCaps | undefined>)[resolvedModel];
  const allowedEffort = caps?.effort ?? [];
  const dropped: string[] = [];
  let out = body;
  const mutate = () => {
    if (out === body) out = { ...body };
    return out;
  };

  const oc = body.output_config;
  if (oc && typeof oc === "object" && !Array.isArray(oc)) {
    const cfg = oc as Record<string, unknown>;
    if ("effort" in cfg && cfg.effort !== undefined) {
      const requested = String(cfg.effort);
      const settled = downgradeEffort(requested, allowedEffort);
      if (settled !== requested) {
        const next = { ...cfg };
        if (settled === undefined) {
          delete next.effort;
          dropped.push(`output_config.effort (${requested} — ${resolvedModel} takes no effort)`);
        } else {
          next.effort = settled;
          dropped.push(`output_config.effort ${requested}→${settled}`);
        }
        // `format` and every other sub-key survive — output_config.format is
        // API-wide, and nuking the object took it down with the effort.
        const o = mutate();
        if (Object.keys(next).length === 0) delete o.output_config;
        else o.output_config = next;
      }
    }
  }

  if ("context_management" in body && body.context_management !== undefined && !caps?.contextManagement) {
    delete mutate().context_management;
    dropped.push("context_management");
  }

  return { body: out, dropped };
}
