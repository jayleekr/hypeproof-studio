// The curriculum skill registry and loader (cr-skills #1396; CR-43–CR-47; recon R7).
//
// One loader, extending the Worker skill registry (`../index.ts`), reads the bundled pairs
// `<id>.md` + `<id>.contract.json` and the curriculum data file. Every contract is validated
// at load (`validateSkillContract`); a refused skill is not in the registry and is listed in
// `CURRICULUM_SKILLS_REFUSED` with its problems. There is no other source: the student's
// workspace is never read, so a workspace file cannot add a skill or widen a tool.
//
// The curriculum (v5: weeks, their questions, required behaviour and the skills in focus) is
// data (`curriculum-v5.json`, SX-56): no week string is written in Service or App source, and a
// scan in the CR-T42 test refuses one.

// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import experimentMd from "./experiment.md";
// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import evidenceMd from "./evidence.md";
// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import productBuilderMd from "./product-builder.md";
// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import deckBuilderMd from "./deck-builder.md";
// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import interviewMd from "./interview.md";
// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import criticMd from "./critic.md";
// @ts-ignore — string import enabled via wrangler text rules (wrangler.toml).
import demoCoachMd from "./demo-coach.md";
import experimentContract from "./experiment.contract.json" with { type: "json" };
import evidenceContract from "./evidence.contract.json" with { type: "json" };
import productBuilderContract from "./product-builder.contract.json" with { type: "json" };
import deckBuilderContract from "./deck-builder.contract.json" with { type: "json" };
import interviewContract from "./interview.contract.json" with { type: "json" };
import criticContract from "./critic.contract.json" with { type: "json" };
import demoCoachContract from "./demo-coach.contract.json" with { type: "json" };
import curriculumV5 from "./curriculum-v5.json" with { type: "json" };
import { skillTag, validateAgainstSchema, validateSkillContract, type SkillContract } from "./contract.ts";
import { RULES, RULE_IDS, type SkillContext } from "./rules.ts";

export interface CurriculumSkill {
  contract: SkillContract;
  /** The instructions the model reads. */
  instructions: string;
  tag: string;
}

export interface SkillSource {
  name: string;
  md: unknown;
  contract: unknown;
}

/** Load skill sources; a source whose contract or instructions fail is refused, never warned about (CR-43). */
export function loadCurriculumSkills(sources: readonly SkillSource[]): { skills: Map<string, CurriculumSkill>; refused: Array<{ name: string; problems: string[] }> } {
  const skills = new Map<string, CurriculumSkill>();
  const refused: Array<{ name: string; problems: string[] }> = [];
  for (const s of sources) {
    const checked = validateSkillContract(s.contract, RULE_IDS);
    const problems = checked.ok ? [] : [...checked.problems];
    if (typeof s.md !== "string" || s.md.trim().length < 40) problems.push("missing:instructions");
    if (checked.ok && checked.contract.skill !== s.name) problems.push("skill_name_mismatch");
    if (checked.ok && skills.has(checked.contract.skill)) problems.push("duplicate_skill");
    if (problems.length || !checked.ok) {
      refused.push({ name: s.name, problems });
      continue;
    }
    skills.set(checked.contract.skill, { contract: checked.contract, instructions: s.md as string, tag: skillTag(checked.contract) });
  }
  return { skills, refused };
}

export const BUNDLED_SKILL_SOURCES: readonly SkillSource[] = [
  { name: "experiment", md: experimentMd, contract: experimentContract },
  { name: "evidence", md: evidenceMd, contract: evidenceContract },
  { name: "product-builder", md: productBuilderMd, contract: productBuilderContract },
  { name: "deck-builder", md: deckBuilderMd, contract: deckBuilderContract },
  { name: "interview", md: interviewMd, contract: interviewContract },
  { name: "critic", md: criticMd, contract: criticContract },
  { name: "demo-coach", md: demoCoachMd, contract: demoCoachContract },
];

const loaded = loadCurriculumSkills(BUNDLED_SKILL_SOURCES);
/** The registry. A bundled skill that failed its contract is absent here (and fails CR-T40's positive control). */
export const CURRICULUM_SKILLS: ReadonlyMap<string, CurriculumSkill> = loaded.skills;
export const CURRICULUM_SKILLS_REFUSED = loaded.refused;
for (const r of loaded.refused) console.error(`[skills] curriculum skill refused: ${r.name} (${r.problems.join(", ")})`);

// ── Curriculum data (CR-45, SX-56) ──────────────────────────────────────────

export interface CurriculumWeek {
  week: number;
  key: string;
  question: string;
  required_behaviour: string;
  skills: string[];
}
export interface Curriculum {
  format: "hps-curriculum/1";
  curriculum: string;
  version: string;
  source: string;
  weeks: CurriculumWeek[];
}

/** Problems with a curriculum data file; empty means valid. `skillIds` are the skills it may name. */
export function curriculumProblems(raw: unknown, skillIds: ReadonlySet<string>): string[] {
  const d = raw as Partial<Curriculum> | null;
  if (!d || typeof d !== "object") return ["not_an_object"];
  const out: string[] = [];
  if (d.format !== "hps-curriculum/1") out.push("invalid:format");
  if (!(typeof d.version === "string" && /^v\d+$/.test(d.version))) out.push("invalid:version");
  if (!(typeof d.curriculum === "string" && d.curriculum)) out.push("invalid:curriculum");
  if (!Array.isArray(d.weeks) || d.weeks.length < 1) return [...out, "invalid:weeks"];
  d.weeks.forEach((w, i) => {
    if (w.week !== i + 1 || w.key !== `W${i + 1}`) out.push(`weeks[${i}]: not_in_order`);
    if (!(typeof w.question === "string" && w.question.trim())) out.push(`weeks[${i}]: missing:question`);
    if (!(typeof w.required_behaviour === "string" && w.required_behaviour.trim())) out.push(`weeks[${i}]: missing:required_behaviour`);
    if (!Array.isArray(w.skills) || !w.skills.length) out.push(`weeks[${i}]: missing:skills`);
    else for (const s of w.skills) if (!skillIds.has(s)) out.push(`weeks[${i}]: unknown_skill:${s}`);
  });
  return out;
}

export const CURRICULUM: Curriculum = curriculumV5 as Curriculum;
const curriculumErrors = curriculumProblems(CURRICULUM, new Set(CURRICULUM_SKILLS.keys()));
if (curriculumErrors.length) console.error(`[skills] curriculum ${CURRICULUM.version} invalid: ${curriculumErrors.join(", ")}`);

/** The week's entry, clamped to the curriculum's weeks. */
export function curriculumWeek(n: unknown): CurriculumWeek {
  const w = Number.isInteger(n) ? (n as number) : 1;
  return CURRICULUM.weeks[Math.min(Math.max(w, 1), CURRICULUM.weeks.length) - 1]!;
}

// ── One run: the prompt, then the output gate ──────────────────────────────

/** The one user message a skill run sends through the coach route: instructions, schema, context, input. */
export function skillPrompt(skill: CurriculumSkill, context: Record<string, unknown>, input: unknown): string {
  return [
    skill.instructions.trim(),
    `## Skill\n${skill.tag}`,
    `## Output schema\n${JSON.stringify(skill.contract.output_schema)}`,
    `## Context\n${JSON.stringify(context)}`,
    `## Input\n${JSON.stringify(input ?? {})}`,
  ].join("\n\n");
}

export type SkillOutputCheck = { ok: true } | { ok: false; code: "invalid_input" | "invalid_output"; problems: string[] };

/**
 * The output gate (CR-44): the input against the input schema, the output against the output
 * schema, then every validation rule the contract names. Any problem refuses the whole output.
 */
export function checkSkillOutput(skill: CurriculumSkill, ctx: SkillContext, input: unknown, output: unknown): SkillOutputCheck {
  const inputProblems = validateAgainstSchema(skill.contract.input_schema, input ?? {});
  if (inputProblems.length) return { ok: false, code: "invalid_input", problems: inputProblems };
  const shape = validateAgainstSchema(skill.contract.output_schema, output);
  if (shape.length) return { ok: false, code: "invalid_output", problems: shape };
  const problems: string[] = [];
  for (const id of skill.contract.validation_rules) problems.push(...RULES[id]!(ctx, (input ?? {}) as Record<string, unknown>, output as Record<string, unknown>).map((p) => `${id} ${p}`));
  return problems.length ? { ok: false, code: "invalid_output", problems } : { ok: true };
}
