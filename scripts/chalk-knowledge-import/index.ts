#!/usr/bin/env node
// Chalk knowledge vault importer — one-shot vault read → SQL file (KB-01·02·03).
//
// Usage:
//   node --experimental-strip-types scripts/chalk-knowledge-import/index.ts \
//     --vault-path /path/to/kids_edu_vault/curriculum_wiki \
//     [--vault-commit <sha>]   (defaults to git HEAD of vault-path)
//     --version <n>            (integer, must not already exist in target DB)
//     --note "Initial import"
//     --created-by "worker3"
//     --out output.sql
//
// Outputs a .sql file with one chalk_knowledge_versions INSERT and N
// chalk_knowledge_docs INSERTs. Load with:
//   wrangler d1 execute <db> --local --file=output.sql
//
// Vocab check (KB-04): if any method doc has out-of-vocabulary field values,
// the script exits non-zero and writes no file.
//
// Design: docs/design/chalk-knowledge-and-plan-spec.md §1

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { checkVocab, type KnowledgeDoc } from "../../worker/src/lib/chalk-vocab-check.ts";

// --- CLI ---------------------------------------------------------------

function parseArgs(): {
  vaultPath: string;
  vaultCommit: string | null;
  version: number;
  note: string;
  createdBy: string;
  out: string;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const vaultPath = get("--vault-path");
  if (!vaultPath) { console.error("--vault-path required"); process.exit(1); }
  const versionStr = get("--version");
  if (!versionStr) { console.error("--version required"); process.exit(1); }
  const version = parseInt(versionStr, 10);
  if (!Number.isFinite(version) || version < 1) { console.error("--version must be a positive integer"); process.exit(1); }
  const note = get("--note");
  if (!note) { console.error("--note required"); process.exit(1); }
  const createdBy = get("--created-by");
  if (!createdBy) { console.error("--created-by required"); process.exit(1); }
  const out = get("--out");
  if (!out) { console.error("--out required"); process.exit(1); }

  return {
    vaultPath,
    vaultCommit: get("--vault-commit"),
    version,
    note,
    createdBy,
    out,
  };
}

// --- Frontmatter parser ------------------------------------------------

interface MethodFrontmatter {
  id: string;
  family: string;
  evidence_grade: string;
  prior_knowledge: string;
  requires_guidance: boolean;
  best_for: string[];
  weak_for: string[];
  avoid_when: string[];
}

function parseInlineArray(raw: string): string[] {
  const m = raw.match(/^\[([^\]]*)\]$/);
  if (!m) return [];
  const inner = m[1].trim();
  if (!inner) return [];
  return inner.split(",").map(s => s.trim());
}

function parseFrontmatter(content: string): { fm: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const yaml = match[1];
  const body = content.slice(match[0].length);
  const fm: Record<string, unknown> = {};

  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^([\w-]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const trimmed = raw.trim();
    if (/^\[/.test(trimmed)) {
      fm[key] = parseInlineArray(trimmed);
    } else if (trimmed === "true") {
      fm[key] = true;
    } else if (trimmed === "false") {
      fm[key] = false;
    } else if (/^\d+$/.test(trimmed)) {
      fm[key] = parseInt(trimmed, 10);
    } else {
      fm[key] = trimmed;
    }
  }
  return { fm, body };
}

// --- Vocab doc builder from curriculum-schema.md -----------------------

interface VocabEntry { key: string; label: string }

function parseVocabTable(section: string): VocabEntry[] {
  const entries: VocabEntry[] = [];
  const re = /^\|\s+`?([a-z][a-z0-9-]*)`?\s+\|\s+(.+?)\s+\|/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    entries.push({ key: m[1], label: m[2].replace(/\*\*/g, "").trim() });
  }
  return entries;
}

function buildVocabDocs(schemaPath: string, schemaRelPath: string): KnowledgeDoc[] {
  const content = readFileSync(schemaPath, "utf-8");

  const methodSectionMatch = content.match(/## method[^\n]*\n([\s\S]*?)(?=\n## |\n# |$)/);
  if (!methodSectionMatch) throw new Error("curriculum-schema.md: '## method' section not found");
  const methodSection = methodSectionMatch[1];

  const goalMatch = methodSection.match(/### 목표 어휘[^\n]*\n([\s\S]*?)(?=\n### |\n## |\n# |$)/);
  if (!goalMatch) throw new Error("curriculum-schema.md: goal vocab section not found");
  const goalKeys = parseVocabTable(goalMatch[1]);

  const condMatch = methodSection.match(/### 조건 어휘[^\n]*\n([\s\S]*?)(?=\n### |\n## |\n# |$)/);
  if (!condMatch) throw new Error("curriculum-schema.md: condition vocab section not found");
  const condKeys = parseVocabTable(condMatch[1]);

  const priorMatch = methodSection.match(/###[^\n]*`prior_knowledge`[^\n]*\n([\s\S]*?)(?=\n###|\n##|\n#|$)/);
  if (!priorMatch) throw new Error("curriculum-schema.md: prior_knowledge section not found");
  const priorKeys = parseVocabTable(priorMatch[1]);

  if (goalKeys.length === 0) throw new Error("curriculum-schema.md: zero goal keys parsed");
  if (condKeys.length === 0) throw new Error("curriculum-schema.md: zero condition keys parsed");
  if (priorKeys.length === 0) throw new Error("curriculum-schema.md: zero prior keys parsed");

  return [
    {
      doc_id: "vocab:goal",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: goalKeys }),
      body: "",
      source_path: schemaRelPath,
    },
    {
      doc_id: "vocab:condition",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: condKeys }),
      body: "",
      source_path: schemaRelPath,
    },
    {
      doc_id: "vocab:prior",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: priorKeys }),
      body: "",
      source_path: schemaRelPath,
    },
  ];
}

// --- Method doc builder ------------------------------------------------

function buildMethodDocs(methodsDir: string, vaultRoot: string): KnowledgeDoc[] {
  const files = readdirSync(methodsDir).filter(f => f.match(/^m-.*\.md$/) && !f.match(/^methods-index/));
  const docs: KnowledgeDoc[] = [];

  for (const filename of files) {
    const fullPath = join(methodsDir, filename);
    const content = readFileSync(fullPath, "utf-8");
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      console.error(`  skip: ${filename} — no frontmatter`);
      continue;
    }
    const fm = parsed.fm as Partial<MethodFrontmatter>;

    // Exclude family: reference (design §1-2 and product-read-contract §3-3)
    if (fm.family === "reference") {
      console.log(`  skip (reference): ${filename}`);
      continue;
    }
    if (!fm.id) {
      console.error(`  skip: ${filename} — no id in frontmatter`);
      continue;
    }

    const fields = {
      id: fm.id,
      family: fm.family ?? "",
      evidence_grade: fm.evidence_grade ?? "",
      prior_knowledge: fm.prior_knowledge ?? "",
      requires_guidance: fm.requires_guidance ?? false,
      best_for: fm.best_for ?? [],
      weak_for: fm.weak_for ?? [],
      avoid_when: fm.avoid_when ?? [],
    };

    docs.push({
      doc_id: `method:${fm.id}`,
      kind: "method",
      fields_json: JSON.stringify(fields),
      body: parsed.body.trim(),
      source_path: relative(vaultRoot, fullPath),
    });
  }

  docs.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  return docs;
}

// --- Gate doc builder from lesson-plan-quality-checklist.md -----------

// Judge assignments from product-read-contract.md §4.
// Items not in the explicit machine/model/human table default to machine
// (structural field checks). Only G2-2, G2-3, G3-2 are model; G2-12, G3-6 human.
const GATE_JUDGE: Record<string, "machine" | "model" | "human"> = {
  "G2-2": "model", "G2-3": "model", "G3-2": "model",
  "G2-12": "human", "G3-6": "human",
};
function gateJudge(id: string): "machine" | "model" | "human" {
  return GATE_JUDGE[id] ?? "machine";
}

// Extract parenthetical clause refs like "(B-3)" or "(A-5, B-4)".
function extractReads(text: string): string[] {
  const m = text.match(/\(([AB]-\d+(?:[a-z])?(?:,\s*[AB]-\d+(?:[a-z])?)*)\)\s*$/);
  if (!m) return [];
  return m[1].split(",").map(s => s.trim());
}

function buildGateDocs(checklistPath: string, relPath: string): KnowledgeDoc[] {
  const content = readFileSync(checklistPath, "utf-8");
  const docs: KnowledgeDoc[] = [];
  let currentGate = 0;

  for (const line of content.split(/\r?\n/)) {
    // Heading: ## 관문 1 …
    const headingMatch = line.match(/^## 관문\s+(\d+)/);
    if (headingMatch) {
      currentGate = parseInt(headingMatch[1], 10);
      continue;
    }

    // Item: - [ ] `G1-1` text (B-3)
    const itemMatch = line.match(/^- \[ \] `(G\d+-\d+[a-z]?)` (.+)/);
    if (!itemMatch || currentGate === 0) continue;

    const id = itemMatch[1];
    const text = itemMatch[2].trim();
    const reads = extractReads(text);
    const cleanText = text.replace(/\s*\([^)]+\)\s*$/, "").trim();

    docs.push({
      doc_id: `gate:${id}`,
      kind: "gate",
      fields_json: JSON.stringify({ id, gate: currentGate, judge: gateJudge(id), reads }),
      body: cleanText,
      source_path: relPath,
    });
  }

  docs.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  return docs;
}

// --- Constitution doc builder from edu-constitution.md ----------------

function buildConstitutionDocs(constitutionPath: string, relPath: string): KnowledgeDoc[] {
  const content = readFileSync(constitutionPath, "utf-8");
  const docs: KnowledgeDoc[] = [];

  // A-* from the table: | A-1 | **text...** | violation |
  const tableRe = /^\|\s+(A-\d+)\s+\|\s+\*\*(.+?)\*\*[^|]*\|/gm;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(content)) !== null) {
    const id = m[1];
    const clauseText = m[2].trim();
    docs.push({
      doc_id: `constitution:${id}`,
      kind: "constitution",
      fields_json: JSON.stringify({ id, section: "A" }),
      body: clauseText,
      source_path: relPath,
    });
  }

  // B-* from section headings: ### B-1. title
  const bHeadingRe = /^### (B-\d+)\.\s+(.+)/gm;
  while ((m = bHeadingRe.exec(content)) !== null) {
    const id = m[1];
    const headingText = m[2].trim();
    // Body: text from after heading until next B-* heading or ## heading
    const headingEnd = m.index + m[0].length;
    const nextMatch = content.slice(headingEnd).match(/\n(?:###\s+B-\d+|\n##)/);
    const bodyEnd = nextMatch
      ? headingEnd + (nextMatch.index ?? 0)
      : content.length;
    const body = content.slice(headingEnd, bodyEnd).trim();

    docs.push({
      doc_id: `constitution:${id}`,
      kind: "constitution",
      fields_json: JSON.stringify({ id, section: "B" }),
      body: `${headingText}\n\n${body}`,
      source_path: relPath,
    });
  }

  docs.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  return docs;
}

// --- Prohibited-move doc builder from prohibited-moves.md -------------

function buildProhibitedMoveDocs(prohibitedPath: string, relPath: string): KnowledgeDoc[] {
  const content = readFileSync(prohibitedPath, "utf-8");
  const docs: KnowledgeDoc[] = [];

  // Table row: | **P1 선취** | description | destruction |
  const re = /^\|\s+\*\*P(\d)\s+([^*]+)\*\*\s+\|\s+(.+?)\s+\|/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const id = `P${m[1]}`;
    const family = m[2].trim();
    const description = m[3].trim();

    docs.push({
      doc_id: `prohibited-move:${id}`,
      kind: "prohibited-move",
      fields_json: JSON.stringify({ id, family }),
      body: description,
      source_path: relPath,
    });
  }

  docs.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  return docs;
}

// --- Placement doc builder from placement-rules.md --------------------

function buildPlacementDocs(placementPath: string, relPath: string): KnowledgeDoc[] {
  const content = readFileSync(placementPath, "utf-8");
  const docs: KnowledgeDoc[] = [];
  const seenIds = new Set<string>();

  // Two row formats in the vault:
  //   plain:  | C-1 | text | `requires` | reason |
  //   bold:   | **C-6** | **text** | `pairing` | reason |
  // A single flexible regex handles both by making ** optional.
  const re = /^\|\s+\*{0,2}(C-\d+[a-z]?)\*{0,2}\s+\|\s+\*{0,2}(.+?)\*{0,2}\s+\|\s+`([^`]+)`/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    if (id === "C-2a") {
      // Excluded per design §1-2 (model-age constraint, not a generator placement rule).
      console.log(`  skip (excluded): placement ${id}`);
      continue;
    }
    if (seenIds.has(id)) continue;
    const text = m[2].trim();
    const type = m[3].trim();

    docs.push({
      doc_id: `placement:${id}`,
      kind: "placement",
      fields_json: JSON.stringify({ id, type }),
      body: text,
      source_path: relPath,
    });
    seenIds.add(id);
  }

  docs.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  return docs;
}

// --- Axis doc builder from measurement-axes.md -----------------------

const AXIS_KEY_MAP: Record<string, string> = {
  "입력": "input",
  "부하": "load",
  "검증": "verify",
  "전이": "transfer",
  "거리": "distance",
};

function buildAxisDocs(axesPath: string, relPath: string): KnowledgeDoc[] {
  const content = readFileSync(axesPath, "utf-8");
  const docs: KnowledgeDoc[] = [];

  // Table: | N | **name (EnglishName)** | description |
  // E.g.: | 1 | **입력 (Input)** | 문제 정의... |
  const re = /^\|\s+(\d+)\s+\|\s+\*\*([^*]+)\*\*[^|]*\|\s+(.+?)\s+\|/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const num = parseInt(m[1], 10);
    const rawName = m[2].trim();
    const description = m[3].replace(/\*\*/g, "").trim();

    // Extract Korean name key (first word before space or parenthesis)
    const koreanName = rawName.split(/[\s(★]/)[0].trim();
    const key = AXIS_KEY_MAP[koreanName];
    if (!key) {
      console.log(`  skip unknown axis name: ${rawName}`);
      continue;
    }

    // Extract display name (strip ★)
    const name = rawName.replace(/\s*★/, "").trim();

    docs.push({
      doc_id: `axis:${key}`,
      kind: "axis",
      fields_json: JSON.stringify({ key, name, order: num }),
      body: description,
      source_path: relPath,
    });
  }

  docs.sort((a, b) => {
    const fa = JSON.parse(a.fields_json) as { order: number };
    const fb = JSON.parse(b.fields_json) as { order: number };
    return fa.order - fb.order;
  });
  return docs;
}

// --- Acceptance doc builder from activity-acceptance-checklist.md ----

function buildAcceptanceDocs(acceptancePath: string, relPath: string): KnowledgeDoc[] {
  const content = readFileSync(acceptancePath, "utf-8");
  const docs: KnowledgeDoc[] = [];

  let currentGate = "";

  for (const line of content.split(/\r?\n/)) {
    // Section heading: "## 관문 A1 — title" or "## A1. title"
    const headingMatch = line.match(/^## (?:관문\s+)?(A\d+)/);
    if (headingMatch) {
      currentGate = headingMatch[1];
      continue;
    }

    // Item: - [ ] `A1-1` text  or  - [x] `A1-1` text
    const itemMatch = line.match(/^- \[[ x]\] `(A\d+-\d+)` (.+)/);
    if (!itemMatch || !currentGate) continue;

    const id = itemMatch[1];
    const text = itemMatch[2].trim();

    docs.push({
      doc_id: `acceptance:${id}`,
      kind: "acceptance",
      fields_json: JSON.stringify({ id, gate: currentGate }),
      body: text,
      source_path: relPath,
    });
  }

  docs.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  return docs;
}

// --- Guide doc builder ------------------------------------------------

interface GuideSpec {
  key: string;
  relPath: string;
}

function buildGuideDocs(vaultPath: string): KnowledgeDoc[] {
  // vaultPath = curriculum_wiki root. workshop-core lives in ../wiki/specs/core/
  const guideSpecs: GuideSpec[] = [
    { key: "authoring-order", relPath: "design/lesson-plan-authoring-guide.md" },
    { key: "plan-spec", relPath: "_templates/lesson-plan.md" },
    { key: "conversion", relPath: "design/lesson-plan-to-steps-mapping.md" },
    { key: "session-format", relPath: "rules/edu-11-16-session-format.md" },
    // workshop-core is outside curriculum_wiki (in wiki/ sibling)
    { key: "workshop-core", relPath: "../wiki/specs/core/curriculum-core.md" },
  ];

  const docs: KnowledgeDoc[] = [];
  for (const spec of guideSpecs) {
    const fullPath = join(vaultPath, spec.relPath);
    if (!existsSync(fullPath)) {
      console.log(`  skip (not found): guide:${spec.key} — ${spec.relPath}`);
      continue;
    }
    const content = readFileSync(fullPath, "utf-8");
    const parsed = parseFrontmatter(content);
    const body = parsed ? parsed.body.trim() : content.trim();

    docs.push({
      doc_id: `guide:${spec.key}`,
      kind: "guide",
      fields_json: JSON.stringify({ key: spec.key }),
      body,
      source_path: spec.relPath,
    });
  }

  return docs;
}

// --- SQL generation ----------------------------------------------------

function sqlLiteral(s: string | null | undefined): string {
  if (s === null || s === undefined) return "NULL";
  return `'${s.replace(/'/g, "''")}'`;
}

function buildSql(
  version: number,
  sourceCommit: string,
  note: string,
  createdBy: string,
  docs: KnowledgeDoc[],
): string {
  const createdAt = Math.floor(Date.now() / 1000);

  const digestInput = docs
    .slice()
    .sort((a, b) => a.doc_id.localeCompare(b.doc_id))
    .map(d => `${d.doc_id}|${d.fields_json}|${d.body}`)
    .join("\n");
  const digest = createHash("sha256").update(digestInput, "utf-8").digest("hex");

  const lines: string[] = [
    `-- chalk knowledge import v${version} — generated by scripts/chalk-knowledge-import`,
    `-- source_commit: ${sourceCommit}`,
    `-- doc_count: ${docs.length}`,
    `-- digest: ${digest}`,
    "",
    `INSERT INTO chalk_knowledge_versions`,
    `  (version, parent_version, origin, source_repo, source_commit, note, created_by, created_at, doc_count, digest)`,
    `VALUES`,
    `  (${version}, NULL, 'vault-import', 'hypeproof_kids_edu', ${sqlLiteral(sourceCommit)},`,
    `   ${sqlLiteral(note)}, ${sqlLiteral(createdBy)}, ${createdAt}, ${docs.length}, ${sqlLiteral(digest)});`,
    "",
  ];

  for (const doc of docs) {
    lines.push(
      `INSERT INTO chalk_knowledge_docs`,
      `  (version, doc_id, kind, fields_json, body, source_path)`,
      `VALUES`,
      `  (${version}, ${sqlLiteral(doc.doc_id)}, ${sqlLiteral(doc.kind)},`,
      `   ${sqlLiteral(doc.fields_json)},`,
      `   ${sqlLiteral(doc.body)},`,
      `   ${sqlLiteral(doc.source_path ?? null)});`,
      "",
    );
  }

  return lines.join("\n");
}

// --- Main --------------------------------------------------------------

const args = parseArgs();

// Resolve vault commit
let vaultCommit = args.vaultCommit;
if (!vaultCommit) {
  try {
    vaultCommit = execSync(`git -C ${args.vaultPath} rev-parse HEAD`, { encoding: "utf-8" }).trim();
  } catch {
    console.error("Could not determine vault commit. Pass --vault-commit explicitly.");
    process.exit(1);
  }
}

console.log(`Chalk knowledge import — vault: ${args.vaultPath}`);
console.log(`  commit: ${vaultCommit}`);
console.log(`  version: ${args.version}`);

// Build vocab docs
const schemaPath = join(args.vaultPath, "rules/curriculum-schema.md");
const vocabDocs = buildVocabDocs(schemaPath, "rules/curriculum-schema.md");
console.log(`  vocab docs: ${vocabDocs.length} (goal/condition/prior)`);

// Build method docs
const methodsDir = join(args.vaultPath, "methods");
const methodDocs = buildMethodDocs(methodsDir, args.vaultPath);
console.log(`  method docs: ${methodDocs.length}`);

// Build gate docs
const checklistPath = join(args.vaultPath, "design/lesson-plan-quality-checklist.md");
const gateDocs = buildGateDocs(checklistPath, "design/lesson-plan-quality-checklist.md");
console.log(`  gate docs: ${gateDocs.length}`);

// Build constitution docs
const constitutionPath = join(args.vaultPath, "rules/edu-constitution.md");
const constitutionDocs = buildConstitutionDocs(constitutionPath, "rules/edu-constitution.md");
console.log(`  constitution docs: ${constitutionDocs.length}`);

// Build prohibited-move docs
const prohibitedPath = join(args.vaultPath, "rules/prohibited-moves.md");
const prohibitedDocs = buildProhibitedMoveDocs(prohibitedPath, "rules/prohibited-moves.md");
console.log(`  prohibited-move docs: ${prohibitedDocs.length}`);

// Build placement docs
const placementPath = join(args.vaultPath, "rules/placement-rules.md");
const placementDocs = buildPlacementDocs(placementPath, "rules/placement-rules.md");
console.log(`  placement docs: ${placementDocs.length} (C-2a excluded)`);

// Build axis docs
const axesPath = join(args.vaultPath, "rules/measurement-axes.md");
const axisDocs = buildAxisDocs(axesPath, "rules/measurement-axes.md");
console.log(`  axis docs: ${axisDocs.length}`);

// Build acceptance docs
const acceptancePath = join(args.vaultPath, "design/activity-acceptance-checklist.md");
const acceptanceDocs = buildAcceptanceDocs(acceptancePath, "design/activity-acceptance-checklist.md");
console.log(`  acceptance docs: ${acceptanceDocs.length}`);

// Build guide docs (workshop-core may be outside curriculum_wiki)
const guideDocs = buildGuideDocs(args.vaultPath);
console.log(`  guide docs: ${guideDocs.length}`);

const allDocs: KnowledgeDoc[] = [
  ...vocabDocs,
  ...methodDocs,
  ...gateDocs,
  ...constitutionDocs,
  ...prohibitedDocs,
  ...placementDocs,
  ...axisDocs,
  ...acceptanceDocs,
  ...guideDocs,
];

// Vocab check (KB-04)
const check = checkVocab(allDocs);
if (!check.ok) {
  console.error("\nVocab check FAILED — out-of-vocabulary values:");
  for (const err of check.errors) {
    console.error(`  ${err.doc_id}.${err.field}: ${err.bad_values.join(", ")}`);
  }
  console.error("\nNo SQL file written.");
  process.exit(1);
}
console.log("  vocab check: OK");

// Generate SQL
const sql = buildSql(args.version, vaultCommit, args.note, args.createdBy, allDocs);
writeFileSync(args.out, sql, "utf-8");
console.log(`\nWrote ${allDocs.length} docs → ${args.out}`);
console.log(`Load with: wrangler d1 execute <db> --local --file=${args.out}`);
