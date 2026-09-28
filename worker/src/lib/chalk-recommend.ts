// #1293 — Chalk method recommendation: deterministic closed-vocabulary match.
// Pure function — no I/O, no fuzzy matching.
// Route handler reads method cards and vocab from chalk_knowledge_docs, then calls this.
// TODO: E2-6 will replace body-supplied goals/conditions with the draft's input log.
// TODO: knowledge_version will be pinned to the draft's knowledge version once that field exists.

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

export class KnowledgeIncompatibleError extends Error {
  readonly field: string;
  readonly unranked: string[];
  constructor(field: string, unranked: string[]) {
    super(`knowledge incompatible: ${field} has unranked values: ${unranked.join(", ")}`);
    this.name = "KnowledgeIncompatibleError";
    this.field = field;
    this.unranked = unranked;
  }
}

// Level rank for prior_knowledge comparison. 'any' (card value = no prerequisite) is
// excluded from learner input but accepted on method cards.
const LEVEL_RANK: Record<string, number> = { novice: 1, intermediate: 2 };

export interface MethodFields {
  id: string;
  best_for: string[];
  weak_for?: string[];
  avoid_when: string[];
  prior_knowledge?: string;   // 'any' | 'novice' | 'intermediate' (from vault vocab:prior)
  requires_guidance?: boolean;
}

export interface RecommendInput {
  conditions: string[];
  goals: string[];
  learner_level?: string;  // 'novice' | 'intermediate' — 'any' is a card value, not a learner input
  has_guidance?: boolean;  // false → methods requiring guidance are excluded
}

export interface RecommendResult {
  chosen: Array<{ id: string; rationale: string[]; no_goal_match?: boolean; weak_overlap?: string[] }>;
  excluded: Array<{ id: string; because: string[] }>;
  knowledge_version: number;
}

/**
 * Deterministic recommendation: same input + same method cards + same vocab → same output.
 * Throws VocabError when any input condition/goal/learner_level key is outside the closed vocabulary.
 *
 * Exclusion rules (applied in order; first match wins):
 *   1. Card prior_knowledge outside vocab:prior → excluded with 'invalid_card_field' (defensive)
 *   2. avoid_when overlaps with input conditions
 *   3. prior_knowledge level exceeds learner_level (novice < intermediate)
 *   4. requires_guidance: true when input.has_guidance is explicitly false
 *
 * Sort: ① no weak_for overlap first ② best_for ∩ goals count descending ③ id ascending.
 */
export function recommendMethods(
  input: RecommendInput,
  methods: MethodFields[],
  vocab: { goals: string[]; conditions: string[]; prior: string[] },
  knowledge_version: number,
): RecommendResult {
  const unranked = vocab.prior.filter((v) => v !== "any" && !(v in LEVEL_RANK));
  if (unranked.length > 0) throw new KnowledgeIncompatibleError("vocab:prior", unranked);

  const badConditions = input.conditions.filter((c) => !vocab.conditions.includes(c));
  if (badConditions.length > 0) throw new VocabError("condition", badConditions);

  const badGoals = input.goals.filter((g) => !vocab.goals.includes(g));
  if (badGoals.length > 0) throw new VocabError("goal", badGoals);

  if (input.learner_level !== undefined) {
    const validLevels = vocab.prior.filter((v) => v !== "any");
    if (!validLevels.includes(input.learner_level)) {
      throw new VocabError("learner_level", [input.learner_level]);
    }
  }

  const learnerRank = input.learner_level ? (LEVEL_RANK[input.learner_level] ?? -1) : -1;

  const candidates: Array<{
    id: string;
    rationale: string[];
    no_goal_match: boolean;
    match_count: number;
    weak_overlap: string[];
  }> = [];
  const excluded: RecommendResult["excluded"] = [];

  for (const m of methods) {
    // Rule 0 (defensive): card prior_knowledge outside closed vocab
    if (m.prior_knowledge !== undefined && !vocab.prior.includes(m.prior_knowledge)) {
      excluded.push({ id: m.id, because: ["invalid_card_field"] });
      continue;
    }

    const because: string[] = [];

    // Rule 1: avoid_when
    const avoidHits = m.avoid_when.filter((c) => input.conditions.includes(c));
    if (avoidHits.length > 0) because.push(...avoidHits);

    // Rule 2: prior_knowledge exceeds learner level
    if (because.length === 0 && m.prior_knowledge && m.prior_knowledge !== "any") {
      const required = LEVEL_RANK[m.prior_knowledge]!;
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
      const matched = m.best_for.filter((g) => input.goals.includes(g));
      const weakOverlap = (m.weak_for ?? []).filter((g) => input.goals.includes(g));
      candidates.push({
        id: m.id,
        rationale: matched,
        no_goal_match: matched.length === 0,
        match_count: matched.length,
        weak_overlap: weakOverlap,
      });
    }
  }

  // Sort: ① no weak_overlap first ② best_for ∩ goals count descending ③ id ascending
  candidates.sort((a, b) => {
    const wa = a.weak_overlap.length > 0 ? 1 : 0;
    const wb = b.weak_overlap.length > 0 ? 1 : 0;
    if (wa !== wb) return wa - wb;
    if (a.match_count !== b.match_count) return b.match_count - a.match_count;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const chosen: RecommendResult["chosen"] = candidates.map((c) => {
    const entry: RecommendResult["chosen"][number] = { id: c.id, rationale: c.rationale };
    if (c.no_goal_match) entry.no_goal_match = true;
    if (c.weak_overlap.length > 0) entry.weak_overlap = c.weak_overlap;
    return entry;
  });

  return { chosen, excluded, knowledge_version };
}
