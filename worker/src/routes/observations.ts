import { resolveExecutionAccess, budgetErrorResponse } from '../lib/budget-admission';
import { AccessError } from '../lib/access-contracts';
import { logChat, persistUsage } from "../lib/analytics";
import { nativeTrialSignal } from "../middleware/native-trial-budget";
import {
  ASSESSMENT_PROVIDER,
  assessNativeObservation,
  getObservationRubric,
} from "../lib/native-assessment";
import { modelIdFor } from "../profiles/types";
import { Hono } from "hono";
import type { Env } from "../env";
import { gateChatRequest } from "../lib/chat-gate";
import { nativeObservationScope } from "../lib/native-observation-scope";
import { servedObservationFormat, observationCapability, servedCapabilityModel, CAPABILITY_MODEL_HEADER } from "../lib/measurement-core/legacy-observation.ts";
import { validateObservation } from "../lib/native-observation";
export const observations = new Hono<{ Bindings: Env }>();
observations.use("*", async (c, next) => {
  c.header("cache-control", "no-store");
  await next();
});
export async function observationContext(
  gate: Extract<Awaited<ReturnType<typeof gateChatRequest>>, { ok: true }>,
  /** `x-hps-observation-format` — what the calling app build can parse. */
  clientFormat: string | undefined,
) {
  return {
    // Must agree with what /v1/profile served for the SAME seat and the SAME
    // client. If these two disagree the client builds a /2 recorder and then
    // gets a /1 context, and `recordLearningEvent()` throws
    // `observation_format` — the feature looks configured and records nothing.
    // Same negotiation, same function, so the two answers cannot drift.
    format: servedObservationFormat(gate.profile.observation?.format, clientFormat),
    scope: await nativeObservationScope(gate.payload,gate.session),
    session: gate.session.session_id,
    program: gate.module.version,
  };
}
observations.get("/context", async (c) => {
  const gate = await gateChatRequest(c);
  if (!gate.ok) return gate.response;
  if (!observationCapability(gate.profile.observation).record)
    return c.json({ error: { code: "observation_unavailable" } }, 404);
  const doc = await getObservationRubric(
    c.env,
    gate.profile.id,
    servedCapabilityModel(c.req.header(CAPABILITY_MODEL_HEADER)),
  );
  return c.json({
    ...(await observationContext(gate, c.req.header("x-hps-observation-format"))),
    learning_path: doc.content.next_learning,
  });
});
// Contract validation is read-only: no transcript storage or automatic assessment.
observations.post("/validate", async (c) => {
  const gate = await gateChatRequest(c);
  if (!gate.ok) return gate.response;
  if (!observationCapability(gate.profile.observation).record)
    return c.json({ error: { code: "observation_unavailable" } }, 404);
  const raw = await c.req.text();
  if (raw.length > 300000)
    return c.json({ error: { code: "observation_too_large" } }, 413);
  try {
    const { batch, missing } = validateObservation(JSON.parse(raw));
    const context = await observationContext(gate, c.req.header("x-hps-observation-format"));
    if (
      batch.scope !== context.scope ||
      batch.session !== context.session ||
      batch.program !== context.program
    )
      return c.json({ error: { code: "observation_scope_changed" } }, 409);
    return c.json({
      // Report the format this seat actually runs, not a constant (#F-1).
      format: context.format,
      events: batch.events.length,
      missing,
    });
  } catch {
    return c.json({ error: { code: "invalid_observation" } }, 400);
  }
});
observations.post("/assess", async (c) => {
  const gate = await gateChatRequest(c);
  if (!gate.ok) return gate.response;
  try{if(await resolveExecutionAccess(c.env,gate.payload,c.req.header('x-hps-funding-source')))throw new AccessError('assessment_budget_not_supported',403);}
  catch(error){return budgetErrorResponse(c,error);}
  if (!observationCapability(gate.profile.observation).assess)
    return c.json({ error: { code: "observation_unavailable" } }, 404);
  // ADR 0010 step 3 — a named refusal, decided before the batch is even read.
  //
  // `modelIdFor` throws for a model key that does not belong to the assessment
  // provider, and every throw inside that try is pattern-matched against a
  // fixed allowlist and otherwise reported as 502 `assessment_failed`. So a
  // cohort whose coach runs on GPT or GLM would have got a server-error card
  // that says nothing about why, on a button that can never work for it. The
  // ADR calls that the "설정은 맞는데 동작이 없는" shape.
  //
  // Refusing is the whole fix; there is no model to pick instead.
  // `ASSESSMENT_PROVIDER` is a fact about `native-assessment.ts` (it posts to
  // Anthropic with no branch), so "just use a Claude model" would send this
  // cohort's student prose and workspace file bodies to a vendor its profile
  // never names. Which cohorts may be assessed on a provider they did not run
  // on is Jay's decision, not a default.
  //
  // It sits here, above the body, on purpose. Whether this cohort CAN be
  // assessed is a property of the cohort, not of the batch it sent, so it is
  // answered before 300 KB is parsed — and a request that can never succeed
  // should not be told its body is malformed. Computed once and reused: the
  // second call site used to be inside the usage callback, which runs AFTER
  // the provider call is made and billed, so a throw there would still have
  // landed in the 502.
  //
  // Not reachable today, and that is stated rather than implied: the only two
  // profiles whose `model.default` is not an Anthropic key (`studio-gpt-practice`,
  // `studio-model-practice`) both have `assess` off and are stopped by the 404
  // above. This closes the hole before ADR step 4 opens it.
  let assessmentModel: string;
  try {
    assessmentModel = modelIdFor(gate.profile.model.default, ASSESSMENT_PROVIDER);
  } catch {
    return c.json(
      {
        error: {
          type: "config",
          code: "assessment_provider_mismatch",
          message:
            "이 수업의 모델로는 관찰 결과를 확인할 수 없습니다. 기록은 그대로 보존됩니다.",
        },
      },
      409,
    );
  }
  const raw = await c.req.text();
  if (raw.length > 300000)
    return c.json({ error: { code: "observation_too_large" } }, 413);
  let batch;
  try {
    const checked = validateObservation(JSON.parse(raw));
    batch = checked.batch;
    if (checked.missing.length || batch.incomplete)
      return c.json({ error: { code: "observation_incomplete" } }, 409);
    const context = await observationContext(gate, c.req.header("x-hps-observation-format"));
    if (
      batch.scope !== context.scope ||
      batch.session !== context.session ||
      batch.program !== context.program
    )
      return c.json({ error: { code: "observation_scope_changed" } }, 409);
  } catch {
    return c.json({ error: { code: "invalid_observation" } }, 400);
  }
  const started = Date.now();
  try {
    return c.json(
      await assessNativeObservation(
        c.env,
        gate.profile.id,
        assessmentModel,
        batch,
        nativeTrialSignal(c.req.raw),
        (usage, status, version) => {
          const log = {
            cohort_id: gate.payload.c,
            user_id: gate.payload.u,
            profile_id: gate.profile.id,
            model: assessmentModel,
            status,
            error_kind: status >= 400 ? "observation_failed" : null,
            tokens_in: usage.input_tokens ?? 0,
            tokens_out: usage.output_tokens ?? 0,
            cache_read: usage.cache_read_input_tokens ?? 0,
            cache_create: usage.cache_creation_input_tokens ?? 0,
            latency_ms: Date.now() - started,
            module_version: version,
          };
          logChat(c.env, log);
          c.executionCtx.waitUntil(
            persistUsage(c.env, {
              ...log,
              session_id: gate.session.session_id,
            }),
          );
        },
        // What this app can read back (`servedCapabilityModel`). An installed
        // build sends no such header and is served the seven Assets, which is
        // what its bundled validator accepts.
        servedCapabilityModel(c.req.header(CAPABILITY_MODEL_HEADER)),
      ),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    const code =
      /^(assessment_provider_(?:unavailable|401|429|503)|rubric_unavailable|invalid_findings|invalid_asset|invalid_interpretation|invalid_evidence|invalid_quote_selection|invalid_quote|fabricated_quote|unsupported_independence|missing_human_evidence|missing_execution_evidence|unobserved_with_evidence|unsupported_score)$/.test(
        detail,
      )
        ? detail
        : "assessment_failed";
    return c.json(
      {
        error: {
          code,
          message:
            "관찰 결과를 확인하지 못했습니다. 기록을 보존한 채 다시 시도할 수 있습니다.",
        },
      },
      502,
    );
  }
});
