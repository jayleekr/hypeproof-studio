// Pure vocabulary checker for Chalk knowledge documents (KB-04).
// Shared by the import script (scripts/chalk-knowledge-import/) and the
// server write path. Never import I/O or runtime deps from here.
//
// Design: docs/design/chalk-knowledge-and-plan-spec.md §1-3

export interface KnowledgeDoc {
  doc_id: string;
  kind: string;
  fields_json: string;
  body: string;
  source_path?: string;
}

export interface VocabError {
  doc_id: string;
  field: string;
  bad_values: string[];
}

export interface VocabCheckResult {
  ok: boolean;
  errors: VocabError[];
}

interface VocabSets {
  goal: Set<string>;
  condition: Set<string>;
  prior: Set<string>;
}

// Builds vocabulary sets from vocab:* docs in the same version batch.
// Caller passes the full doc list; only vocab:* docs are used.
function buildVocabSets(docs: KnowledgeDoc[]): VocabSets {
  const sets: VocabSets = {
    goal: new Set(),
    condition: new Set(),
    prior: new Set(),
  };

  for (const doc of docs) {
    if (doc.kind !== "vocab") continue;
    let fields: { keys?: { key: string; label?: string }[] };
    try {
      fields = JSON.parse(doc.fields_json);
    } catch {
      continue;
    }
    if (!Array.isArray(fields.keys)) continue;

    if (doc.doc_id === "vocab:goal") {
      for (const { key } of fields.keys) sets.goal.add(key);
    } else if (doc.doc_id === "vocab:condition") {
      for (const { key } of fields.keys) sets.condition.add(key);
    } else if (doc.doc_id === "vocab:prior") {
      for (const { key } of fields.keys) sets.prior.add(key);
    }
  }
  return sets;
}

// Checks that all method docs use only keys defined in the same-version
// vocab:* docs. Returns ok:true when all values pass, or a list of errors.
// If any vocab:* doc is missing, method fields that depend on it will fail
// unless they are empty arrays / absent.
export function checkVocab(docs: KnowledgeDoc[]): VocabCheckResult {
  const vocab = buildVocabSets(docs);
  const errors: VocabError[] = [];

  for (const doc of docs) {
    if (doc.kind !== "method") continue;
    let fields: {
      best_for?: string[];
      weak_for?: string[];
      avoid_when?: string[];
      prior_knowledge?: string;
    };
    try {
      fields = JSON.parse(doc.fields_json);
    } catch {
      errors.push({ doc_id: doc.doc_id, field: "fields_json", bad_values: ["<invalid JSON>"] });
      continue;
    }

    const checkArray = (arr: string[] | undefined, set: Set<string>, field: string) => {
      if (!arr || arr.length === 0) return;
      const bad = arr.filter(v => !set.has(v));
      if (bad.length > 0) errors.push({ doc_id: doc.doc_id, field, bad_values: bad });
    };

    checkArray(fields.best_for, vocab.goal, "best_for");
    checkArray(fields.weak_for, vocab.goal, "weak_for");
    checkArray(fields.avoid_when, vocab.condition, "avoid_when");

    if (fields.prior_knowledge !== undefined && fields.prior_knowledge !== null) {
      if (!vocab.prior.has(fields.prior_knowledge)) {
        errors.push({
          doc_id: doc.doc_id,
          field: "prior_knowledge",
          bad_values: [fields.prior_knowledge],
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
