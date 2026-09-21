import rubricCandidate from "../../../docs/curriculum/studio-trial/native-rubric.json" with { type: "json" };
// Kept, not archived. An installed Studio bundles a seven-key validator, so the
// seven-Asset prompt is what its seat still has to be assessed with until it
// updates (`servedCapabilityModel`).
import rubricLegacy from "../../../docs/curriculum/studio-trial/native-rubric-legacy-seven.json" with { type: "json" };
import {
  makeModuleDoc,
  moduleDocKey,
  modulePinKey,
  validatePin,
  validateModuleDoc,
} from "./modules";
import { callAnthropic } from "./anthropic";
import { scrubSecrets } from "./scrub-secrets";
import {
  capabilityKeys,
  observableAssets,
  validateFindings,
  type CapabilityModelId,
  type ObservationBatch,
} from "./native-observation";
import {
  makeEvidenceCatalog,
  resolveEvidenceSelections,
} from "./native-evidence";
import type { Env } from "../env";
/**
 * The model a new assessment is written against when the client can read it
 * (Jay's 2026-09-13 decision, #1020; `capability-models.ts`).
 *
 * It is NOT unconditional. An app that does not declare
 * `x-hps-capability-model` bundles the seven-key validator and is served the
 * seven Assets — see `servedCapabilityModel`. Each model has its own rubric,
 * because the prompt names the keys it must return.
 */
export const ASSESSMENT_CAPABILITY_MODEL: CapabilityModelId = "candidate-capability-v1";

const RUBRIC_FOR: Record<CapabilityModelId, typeof rubricCandidate> = {
  "candidate-capability-v1": rubricCandidate,
  "legacy-seven-assets": rubricLegacy as typeof rubricCandidate,
};

export async function getObservationRubric(
  env: Env,
  profileId: string,
  capability: CapabilityModelId = "legacy-seven-assets",
) {
  // The prompt names the keys it must return, so the rubric and the model are one
  // choice, not two. Default legacy for the same reason `validateFindings` does:
  // a caller that has not negotiated is an old caller.
  const rubric = RUBRIC_FOR[capability];
  const rawPin = await env.HPS_KV.get(
    modulePinKey("observation-rubric", profileId),
    "json",
  );
  let doc = await makeModuleDoc({
    kind: "observation-rubric",
    profileId,
    version: rubric.version,
    content: rubric,
  });
  if (rawPin) {
    const pin = validatePin(rawPin);
    if (!pin.ok) throw Error("rubric_unavailable");
    const raw = await env.HPS_KV.get(
      moduleDocKey("observation-rubric", profileId, pin.pin.version),
      "json",
    );
    const checked = await validateModuleDoc(raw, {
      kind: "observation-rubric",
      profileId,
      version: pin.pin.version,
    });
    if (!checked.ok) throw Error("rubric_unavailable");
    doc = checked.doc;
  }
  if (
    doc.content.schema !== "hps-observation-rubric/1" ||
    typeof doc.content.system_prompt !== "string" ||
    doc.content.system_prompt.length > 20000
  )
    throw Error("rubric_unavailable");
  const path = doc.content.next_learning as
    | { title?: unknown; url?: unknown; reason?: unknown }
    | undefined;
  if (
    !path ||
    typeof path.title !== "string" ||
    path.title.length > 100 ||
    typeof path.reason !== "string" ||
    path.reason.length > 1000 ||
    typeof path.url !== "string" ||
    !/^https:\/\/hypeproof-ai\.xyz\/training(?:[/?#]|$)/.test(path.url)
  )
    throw Error("rubric_unavailable");
  return {
    ...doc,
    content: {
      ...doc.content,
      system_prompt: doc.content.system_prompt,
      next_learning: { title: path.title, url: path.url, reason: path.reason },
    },
  };
}
export async function assessNativeObservation(
  env: Env,
  profileId: string,
  model: string,
  batch: ObservationBatch,
  signal?: AbortSignal,
  onUsage?: (
    usage: Record<string, number>,
    status: number,
    version: string,
  ) => void,
  // What THIS client can read back. Serving six keys to an app that bundles a
  // seven-key validator burns the provider call and then fails in the app, which
  // is the one failure this parameter exists to prevent.
  capability: CapabilityModelId = "legacy-seven-assets",
) {
  const doc = await getObservationRubric(env, profileId, capability);
  if (!env.ANTHROPIC_API_KEY) throw Error("assessment_provider_unavailable");
  // No automatic retries, no tools, bounded output and deadline. No input/output logging.
  const safeBatch = {
    ...batch,
    events: batch.events.map((e) => ({ ...e, text: scrubSecrets(e.text) })),
  };
  const catalog = makeEvidenceCatalog(safeBatch);
  const common = {
    asset: { type: "string", enum: [...capabilityKeys(capability)] },
    interpretation: { type: "string" },
    next: { type: "string" },
  };
  const observed = {
    type: "object",
    additionalProperties: false,
    required: [
      "asset",
      "status",
      "interpretation",
      "evidence",
      "assistance",
      "next",
    ],
    properties: {
      ...common,
      asset: { type: "string", enum: observableAssets(safeBatch, capability) },
      status: { type: "string", enum: ["observed"] },
      assistance: {
        type: "string",
        enum: [
          ...new Set(["unknown", ...safeBatch.events.map((e) => e.assistance)]),
        ],
      },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["quote_id"],
          properties: { quote_id: { type: "string" } },
        },
      },
    },
  };
  const unobserved = {
    type: "object",
    additionalProperties: false,
    required: ["asset", "status", "interpretation", "next"],
    properties: { ...common, status: { type: "string", enum: ["unobserved"] } },
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: { type: "array", items: { anyOf: [observed, unobserved] } },
    },
  };
  const request = {
    model,
    output_config: { format: { type: "json_schema", schema } },
    max_tokens: 4096,
    stream: false,
    system: [{ type: "text" as const, text: doc.content.system_prompt }],
    messages: [
      {
        role: "user" as const,
        content: JSON.stringify({
          batch: safeBatch,
          evidence_catalog: catalog,
        }),
      },
    ],
  };
  const response = await callAnthropic(request, env.ANTHROPIC_API_KEY, {
    url: env.ANTHROPIC_PROXY_URL,
    proxySecret: env.ANTHROPIC_PROXY_SECRET,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    onUsage?.({}, response.status, doc.version);
    throw Error("assessment_provider_" + response.status);
  }
  const result = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: Record<string, number>;
  };
  const text = (result.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  let findings;
  try {
    findings = validateFindings(
      resolveEvidenceSelections(
        JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""))
          .findings,
        catalog,
      ),
      safeBatch,
      capability,
    );
  } catch (error) {
    onUsage?.(result.usage ?? {}, 502, doc.version);
    throw error;
  }
  onUsage?.(result.usage ?? {}, 200, doc.version);
  return {
    findings,
    capability_model: capability,
    rubric: { version: doc.version, sha256: doc.sha256 },
    provider_request_id: response.headers.get("request-id"),
    usage: result.usage,
    provenance: "host-reported; not device-attested",
    human_validation: "not_assessed",
  };
}
