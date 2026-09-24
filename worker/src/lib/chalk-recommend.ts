// #1293 — Chalk method recommendation: deterministic closed-vocabulary match.
// Pure function — no I/O, no fuzzy matching.
// Route handler reads method cards and vocab from chalk_knowledge_docs, then calls this.

export class VocabError extends Error {
  readonly field: string;
  readonly unknown_values: string[];
  constructor(field: string, unknown_values: string[]) {
    super(`unknown ${field} values: ${unknown_values.join(", ")}`);
    this.name = "VocabError";
    this.field = field;
    this.unknown_values = unknown_values;
  }
}

// Level order for prior_knowledge comparison. 'any' means no prerequisite.
const LEVEL_RANK: Record<string, number> = { any: 0, novice: 1, intermediate: 2, advanced: 3 };

export interface MethodFields {
  id: string;
  best_for: string[];
  weak_for?: string[];
  avoid_when: string[];
  prior_knowledge?: string;   // 'any' | 'novice' | 'intermediate' | 'advanced'
  requires_guidance?: boolean;
}

export interface RecommendInput {
  conditions: string[];
  goals: string[];
  learner_level?: string;  // 'novice' | 'intermediate' | 'advanced'
  has_guidance?: boolean;  // false → methods requiring guidance are excluded
}

export interface RecommendResult {
  chosen: Array<{ id: string; rationale: string[]; weak_overlap?: string[] }>;
  excluded: Array<{ id: string; because: string[] }>;
  knowledge_version: number;
}

/**
 * Deterministic recommendation: same input + same method cards + same vocab → same output.
 * Throws VocabError when any input condition/goal key is outside the closed vocabulary.
 *
 * Exclusion rules (applied in order; first match wins):
 *   1. avoid_when overlaps with input conditions
 *   2. prior_knowledge level exceeds learner_level (novice < intermediate < advanced)
 *   3. requires_guidance: true when input.has_guidance is explicitly false
 *
 * Candidates are sorted: methods with weak_for ∩ goals come after those without.
 */
export function recommendMethods(
  input: RecommendInput,
  methods: MethodFields[],
  vocab: { goals: string[]; conditions: string[] },
  knowledge_version: number,
): RecommendResult {
  const badConditions = input.conditions.filter((c) => !vocab.conditions.includes(c));
  if (badConditions.length > 0) throw new VocabError("condition", badConditions);

  const badGoals = input.goals.filter((g) => !vocab.goals.includes(g));
  if (badGoals.length > 0) throw new VocabError("goal", badGoals);

  const learnerRank = input.learner_level ? (LEVEL_RANK[input.learner_level] ?? -1) : -1;

  const candidates: Array<{ id: string; rationale: string[]; weak_overlap: string[] }> = [];
  const excluded: RecommendResult["excluded"] = [];

  for (const m of methods) {
    const because: string[] = [];

    // Rule 1: avoid_when
    const avoidHits = m.avoid_when.filter((c) => input.conditions.includes(c));
    if (avoidHits.length > 0) because.push(...avoidHits);

    // Rule 2: prior_knowledge exceeds learner level
    if (because.length === 0 && m.prior_knowledge && m.prior_knowledge !== "any") {
      const required = LEVEL_RANK[m.prior_knowledge] ?? 0;
      if (learnerRank >= 0 && required > learnerRank) {
        because.push("prior_knowledge");
      }
    }

    // Rule 3: requires_guidance when no guidance available
    if (because.length === 0 && m.requires_guidance === true && input.has_guidance === false) {
      because.push("requires_guidance");
    }

    if (because.length > 0) {
      excluded.push({ id: m.id, because });
    } else {
      const matched = input.goals.length > 0
        ? m.best_for.filter((g) => input.goals.includes(g))
        : [];
      const weakOverlap = input.goals.length > 0
        ? (m.weak_for ?? []).filter((g) => input.goals.includes(g))
        : [];
      candidates.push({
        id: m.id,
        rationale: matched.length > 0 ? matched : m.best_for,
        weak_overlap: weakOverlap,
      });
    }
  }

  // Sort: methods without weak_for overlap first (stable sort)
  candidates.sort((a, b) => {
    const wa = a.weak_overlap.length > 0 ? 1 : 0;
    const wb = b.weak_overlap.length > 0 ? 1 : 0;
    return wa - wb;
  });

  const chosen: RecommendResult["chosen"] = candidates.map((c) => {
    const entry: RecommendResult["chosen"][number] = { id: c.id, rationale: c.rationale };
    if (c.weak_overlap.length > 0) entry.weak_overlap = c.weak_overlap;
    return entry;
  });

  return { chosen, excluded, knowledge_version };
}
