import { logChat, persistUsage } from "../lib/analytics";
import { nativeTrialSignal } from "../middleware/native-trial-budget";
import {
  assessNativeObservation,
  getObservationRubric,
} from "../lib/native-assessment";
import { modelIdFor } from "../profiles/types";
import { Hono } from "hono";
import type { Env } from "../env";
import { gateChatRequest } from "../lib/chat-gate";
import { nativeObservationScope } from "../lib/native-observation-scope";
import {
  OBSERVATION_FORMAT,
  validateObservation,
} from "../lib/native-observation";
export const observations = new Hono<{ Bindings: Env }>();
observations.use("*", async (c, next) => {
  c.header("cache-control", "no-store");
  await next();
});
export async function observationContext(
  gate: Extract<Awaited<ReturnType<typeof gateChatRequest>>, { ok: true }>,
) {
  return {
    format: OBSERVATION_FORMAT,
    scope: await nativeObservationScope(gate.payload,gate.session),
    session: gate.session.session_id,
    program: gate.module.version,
  };
}
observations.get("/context", async (c) => {
  const gate = await gateChatRequest(c);
  if (!gate.ok) return gate.response;
  if (!gate.profile.observation?.enabled)
    return c.json({ error: { code: "observation_unavailable" } }, 404);
  const doc = await getObservationRubric(c.env, gate.profile.id);
  return c.json({
    ...(await observationContext(gate)),
    learning_path: doc.content.next_learning,
  });
});
// Contract validation is read-only: no transcript storage or automatic assessment.
observations.post("/validate", async (c) => {
  const gate = await gateChatRequest(c);
  if (!gate.ok) return gate.response;
  if (!gate.profile.observation?.enabled)
    return c.json({ error: { code: "observation_unavailable" } }, 404);
  const raw = await c.req.text();
  if (raw.length > 300000)
    return c.json({ error: { code: "observation_too_large" } }, 413);
  try {
    const { batch, missing } = validateObservation(JSON.parse(raw));
    const context = await observationContext(gate);
    if (
      batch.scope !== context.scope ||
      batch.session !== context.session ||
      batch.program !== context.program
    )
      return c.json({ error: { code: "observation_scope_changed" } }, 409);
    return c.json({
      format: OBSERVATION_FORMAT,
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
  if (!gate.profile.observation?.enabled)
    return c.json({ error: { code: "observation_unavailable" } }, 404);
  const raw = await c.req.text();
  if (raw.length > 300000)
    return c.json({ error: { code: "observation_too_large" } }, 413);
  let batch;
  try {
    const checked = validateObservation(JSON.parse(raw));
    batch = checked.batch;
    if (checked.missing.length || batch.incomplete)
      return c.json({ error: { code: "observation_incomplete" } }, 409);
    const context = await observationContext(gate);
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
        modelIdFor(gate.profile.model.default, 'anthropic'),
        batch,
        nativeTrialSignal(c.req.raw),
        (usage, status, version) => {
          const log = {
            cohort_id: gate.payload.c,
            user_id: gate.payload.u,
            profile_id: gate.profile.id,
            model: modelIdFor(gate.profile.model.default, 'anthropic'),
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
