// A curriculum skill's model request on the existing coach route (cr-skills #1396; CR-45).
//
// Until cr-gateway's capability routing lands, a skill calls the model through
// `/v1/chat/completions` like the coach does. The request carries its metadata in two headers:
// `x-hps-skill: <skill>@<version>` and `x-hps-capability: <capability>`. The route checks them
// here, records them (response headers and the request's log line), and lets the existing lesson
// model policy resolve the model: the capability is recorded, not yet routed. A request that names
// a skill must not name a model: the body's `model` is refused, and so is a capability that is a
// model id. Writing the skill and capability onto the usage ledgers is cr-gateway's (CR-34).
//
// With the CR switch off the headers mean nothing and the request is an ordinary chat request.

import { isCapabilityName, looksLikeModelId, parseSkillTag, type CapabilityName } from "./contract.ts";
import { CURRICULUM_SKILLS } from "./registry.ts";

export type SkillRequest = null | { ok: true; tag: string; capability: CapabilityName } | { ok: false; code: "unknown_skill" | "invalid_capability" | "capability_is_model_id" | "capability_not_declared" | "skill_request_names_model" };

export function skillRequestOf(headers: { skill?: string | null; capability?: string | null }, body: unknown, switchOn: boolean): SkillRequest {
  if (!headers.skill && !headers.capability) return null;
  if (!switchOn) return null;
  const tag = parseSkillTag(headers.skill);
  const skill = tag ? CURRICULUM_SKILLS.get(tag.skill) : undefined;
  if (!tag || !skill || skill.contract.version !== tag.version) return { ok: false, code: "unknown_skill" };
  if (!isCapabilityName(headers.capability)) return { ok: false, code: looksLikeModelId(headers.capability) ? "capability_is_model_id" : "invalid_capability" };
  if (headers.capability !== skill.contract.preferred_capability) return { ok: false, code: "capability_not_declared" };
  if (body && typeof body === "object" && (body as { model?: unknown }).model !== undefined) return { ok: false, code: "skill_request_names_model" };
  return { ok: true, tag: skill.tag, capability: headers.capability };
}
