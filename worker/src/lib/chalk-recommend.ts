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

export interface MethodFields {
  id: string;
  best_for: string[];
  weak_for?: string[];
  avoid_when: string[];
}

export interface RecommendInput {
  conditions: string[];
  goals: string[];
}

export interface RecommendResult {
  chosen: Array<{ id: string; rationale: string[] }>;
  excluded: Array<{ id: string; because: string[] }>;
  knowledge_version: number;
}

/**
 * Deterministic recommendation: same input + same method cards + same vocab → same output.
 * Throws VocabError when any input key is outside the closed vocabulary.
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

  const chosen: RecommendResult["chosen"] = [];
  const excluded: RecommendResult["excluded"] = [];

  for (const m of methods) {
    const avoidHits = m.avoid_when.filter((c) => input.conditions.includes(c));
    if (avoidHits.length > 0) {
      excluded.push({ id: m.id, because: avoidHits });
    } else {
      const matched = input.goals.length > 0
        ? m.best_for.filter((g) => input.goals.includes(g))
        : [];
      chosen.push({ id: m.id, rationale: matched.length > 0 ? matched : m.best_for });
    }
  }

  return { chosen, excluded, knowledge_version };
}
