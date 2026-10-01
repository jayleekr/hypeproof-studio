// Curriculum skill contracts (cr-skills #1396; CR-43, CR-45; recon R7).
//
// A curriculum skill is a bundled pair next to this file: `<id>.md` (the instructions the
// model reads) and `<id>.contract.json` (the eight PRD P0-7 contract fields plus `skill` and
// `version`). The loader in `./registry.ts` validates every contract here; a contract that
// misses a field, names a tool outside the read-only set, a capability that is not a
// capability, an unknown validation rule or an unknown write-back target is REFUSED, never
// warned about (CR-43; today's `resolveSkills` only warns, which is fine for the coaching
// skills and wrong for these).
//
// Nothing in a student's workspace is a skill source: contracts are bundled with the Service,
// and the App lists skills from the Service only. A contract cannot widen what the coach may
// do either: `allowed_tools` names read-only Service reads, never a coach tool.
//
// The schemas a contract declares are a small JSON Schema subset (`validateAgainstSchema`):
// object / array / string / integer / number / boolean, `properties`, `required`,
// `additionalProperties: false`, `items`, `enum`, `minItems`, `maxItems`, `minLength`,
// `maxLength`, `minimum`, `maximum`. It validates skill input and output only; evidence
// records are still validated by the measurement-core validators they are stored through
// (SX-48: no second evidence validator).

/** The eight contract fields of PRD P0-7, in the PRD's order. */
export const CONTRACT_FIELDS = [
  "intent",
  "required_context",
  "allowed_tools",
  "preferred_capability",
  "input_schema",
  "output_schema",
  "validation_rules",
  "write_back_targets",
] as const;
export type ContractField = (typeof CONTRACT_FIELDS)[number];

/**
 * Capability names (PRD §5.4). A skill names one of these, never a model ID (CR-30, CR-45).
 * Until cr-gateway's policy table exists, the coach route records the name and the existing
 * lesson model policy resolves the model.
 */
export const CAPABILITY_NAMES = [
  "text.fast",
  "reasoning.high",
  "coding",
  "vision",
  "research.grounded",
  "browser.agent",
  "image.generate",
  "speech.transcribe",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export const isCapabilityName = (v: unknown): v is CapabilityName => typeof v === "string" && (CAPABILITY_NAMES as readonly string[]).includes(v);

/** A string that names a model or provider rather than a capability. */
const MODEL_ID = /(claude|sonnet|opus|haiku|gpt|o[134](-|$)|gemini|gemma|glm|llama|mistral|qwen|deepseek|anthropic|openai)/i;
export const looksLikeModelId = (v: unknown): boolean => typeof v === "string" && MODEL_ID.test(v);

/** Read-only Service reads a skill's context may come from. No coach tool, no write, no shell. */
export const SKILL_TOOLS = ["memory_read", "evidence_read", "version_read"] as const;

/** Context keys the Service assembles for a skill (`required_context`). */
export const CONTEXT_KEYS = [
  "curriculum_week",
  "problem",
  "hypotheses",
  "experiments",
  "register",
  "evidence_items",
  "experiment_records",
  "decisions",
  "deck_slides",
  "stakeholders",
  "version_files",
  "version_sources",
] as const;
export type ContextKey = (typeof CONTEXT_KEYS)[number];

/** Where a skill may write. Anything else is returned to the student and stored nowhere. */
export const WRITE_BACK_TARGETS = ["evidence_draft"] as const;
export type WriteBackTarget = (typeof WRITE_BACK_TARGETS)[number];

export type JsonSchema = {
  type: "object" | "array" | "string" | "integer" | "number" | "boolean";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
  enum?: Array<string | number>;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
};

export interface SkillContract {
  skill: string;
  version: string;
  /** Student-facing name (Korean product copy). */
  title: string;
  intent: string;
  required_context: ContextKey[];
  allowed_tools: Array<(typeof SKILL_TOOLS)[number]>;
  preferred_capability: CapabilityName;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  validation_rules: string[];
  write_back_targets: WriteBackTarget[];
}

export const SKILL_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const SKILL_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** `skill@version`, the tag every output and every model request a skill issues carries (CR-45). */
export const skillTag = (c: Pick<SkillContract, "skill" | "version">) => `${c.skill}@${c.version}`;
export function parseSkillTag(v: unknown): { skill: string; version: string } | null {
  if (typeof v !== "string") return null;
  const m = /^([a-z][a-z0-9-]{1,39})@(\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v);
  return m ? { skill: m[1]!, version: m[2]! } : null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const SCHEMA_TYPES = ["object", "array", "string", "integer", "number", "boolean"];
const SCHEMA_KEYS = ["type", "properties", "required", "additionalProperties", "items", "enum", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "description"];

/** Problems with a schema definition itself (it must be the supported subset). */
export function schemaDefinitionProblems(s: unknown, at = "$"): string[] {
  if (!isObj(s)) return [`${at}: not_a_schema`];
  const out: string[] = [];
  for (const k of Object.keys(s)) if (!SCHEMA_KEYS.includes(k)) out.push(`${at}: unsupported_keyword:${k}`);
  if (!SCHEMA_TYPES.includes(String(s.type))) out.push(`${at}: invalid_type`);
  if (s.type === "object") {
    if (!isObj(s.properties)) out.push(`${at}: object_without_properties`);
    else for (const [k, v] of Object.entries(s.properties)) out.push(...schemaDefinitionProblems(v, `${at}.${k}`));
    if (s.additionalProperties !== false) out.push(`${at}: additional_properties_must_be_false`);
    if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((r) => typeof r === "string" && isObj(s.properties) && Object.hasOwn(s.properties, r)))) out.push(`${at}: invalid_required`);
  }
  if (s.type === "array") {
    if (s.items === undefined) out.push(`${at}: array_without_items`);
    else out.push(...schemaDefinitionProblems(s.items, `${at}[]`));
    if (!(Number.isInteger(s.maxItems) && (s.maxItems as number) >= 1)) out.push(`${at}: array_without_max_items`);
  }
  if (s.type === "string" && !(Number.isInteger(s.maxLength) && (s.maxLength as number) >= 1)) out.push(`${at}: string_without_max_length`);
  return out;
}

/** Validate a value against a schema of the subset. Returns problems as `path: code`; empty means valid. */
export function validateAgainstSchema(schema: JsonSchema, value: unknown, at = "$"): string[] {
  const out: string[] = [];
  switch (schema.type) {
    case "object": {
      if (!isObj(value)) return [`${at}: expected_object`];
      const props = schema.properties ?? {};
      // Own keys only: an inherited name ("constructor", "__proto__") is not a property of the schema.
      for (const r of schema.required ?? []) if (!Object.hasOwn(value, r) || value[r] === undefined) out.push(`${at}.${r}: missing`);
      for (const [k, v] of Object.entries(value)) {
        if (!Object.hasOwn(props, k)) {
          out.push(`${at}.${k}: not_allowed`);
          continue;
        }
        if (v !== undefined) out.push(...validateAgainstSchema(props[k]!, v, `${at}.${k}`));
      }
      return out;
    }
    case "array": {
      if (!Array.isArray(value)) return [`${at}: expected_array`];
      if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at}: too_few_items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at}: too_many_items`);
      value.forEach((v, i) => out.push(...validateAgainstSchema(schema.items!, v, `${at}[${i}]`)));
      return out;
    }
    case "string": {
      if (typeof value !== "string") return [`${at}: expected_string`];
      const trimmed = value.trim();
      if (schema.minLength !== undefined && trimmed.length < schema.minLength) out.push(`${at}: too_short`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${at}: too_long`);
      if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: not_in_enum`);
      return out;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) return [`${at}: expected_${schema.type}`];
      if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: below_minimum`);
      if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: above_maximum`);
      if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: not_in_enum`);
      return out;
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [`${at}: expected_boolean`];
    default:
      return [`${at}: unsupported_schema`];
  }
}

export type ContractCheck = { ok: true; contract: SkillContract } | { ok: false; problems: string[] };

/**
 * Validate one contract (CR-43). `knownRules` is the rule vocabulary of `./rules.ts`, passed in
 * so this file stays free of the rules' imports.
 */
export function validateSkillContract(raw: unknown, knownRules: ReadonlySet<string>): ContractCheck {
  if (!isObj(raw)) return { ok: false, problems: ["not_an_object"] };
  const problems: string[] = [];
  for (const f of ["skill", "version", "title", ...CONTRACT_FIELDS]) if (raw[f] === undefined || raw[f] === null) problems.push(`missing:${f}`);
  const known = new Set(["skill", "version", "title", ...CONTRACT_FIELDS]);
  for (const k of Object.keys(raw)) if (!known.has(k)) problems.push(`unknown_field:${k}`);
  if (raw.skill !== undefined && !(typeof raw.skill === "string" && SKILL_ID.test(raw.skill))) problems.push("invalid:skill");
  if (raw.version !== undefined && !(typeof raw.version === "string" && SKILL_VERSION.test(raw.version))) problems.push("invalid:version");
  if (raw.title !== undefined && !(typeof raw.title === "string" && raw.title.trim() && raw.title.length <= 40)) problems.push("invalid:title");
  if (raw.intent !== undefined && !(typeof raw.intent === "string" && raw.intent.trim().length >= 10 && raw.intent.length <= 600)) problems.push("invalid:intent");
  const list = (k: string, vocab: readonly string[]) => {
    const v = raw[k];
    if (v === undefined) return;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string") || new Set(v).size !== v.length) {
      problems.push(`invalid:${k}`);
      return;
    }
    for (const x of v) if (!vocab.includes(x)) problems.push(`${k}_not_allowed:${x}`);
  };
  list("required_context", CONTEXT_KEYS);
  // A contract can only name read-only Service reads: a workspace-supplied or bundled contract
  // that names a coach tool ("Bash", "Write", "browser_act"…) is refused, so a skill never widens tools.
  list("allowed_tools", SKILL_TOOLS);
  list("validation_rules", [...knownRules]);
  list("write_back_targets", WRITE_BACK_TARGETS);
  if (raw.preferred_capability !== undefined && !isCapabilityName(raw.preferred_capability)) problems.push(looksLikeModelId(raw.preferred_capability) ? "preferred_capability_is_model_id" : "invalid:preferred_capability");
  for (const k of ["input_schema", "output_schema"] as const) {
    if (raw[k] === undefined) continue;
    const p = schemaDefinitionProblems(raw[k]);
    if (p.length) problems.push(...p.map((x) => `${k}:${x}`));
    else if ((raw[k] as JsonSchema).type !== "object") problems.push(`${k}:root_must_be_object`);
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, contract: raw as unknown as SkillContract };
}
