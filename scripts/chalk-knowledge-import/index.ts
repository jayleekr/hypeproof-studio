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

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
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
  // Match: | `key` | label |  (backtick-wrapped or plain)
  const re = /^\|\s+`?([a-z][a-z0-9-]*)`?\s+\|\s+(.+?)\s+\|/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    entries.push({ key: m[1], label: m[2].replace(/\*\*/g, "").trim() });
  }
  return entries;
}

function buildVocabDocs(schemaPath: string, schemaRelPath: string): KnowledgeDoc[] {
  const content = readFileSync(schemaPath, "utf-8");

  // Extract the method section (from "## method" onward to next "##")
  const methodSectionMatch = content.match(/## method[^\n]*\n([\s\S]*?)(?=\n## |\n# |$)/);
  if (!methodSectionMatch) throw new Error("curriculum-schema.md: '## method' section not found");
  const methodSection = methodSectionMatch[1];

  // goal vocab
  const goalMatch = methodSection.match(/### 목표 어휘[^\n]*\n([\s\S]*?)(?=\n### |\n## |\n# |$)/);
  if (!goalMatch) throw new Error("curriculum-schema.md: goal vocab section not found");
  const goalKeys = parseVocabTable(goalMatch[1]);

  // condition vocab
  const condMatch = methodSection.match(/### 조건 어휘[^\n]*\n([\s\S]*?)(?=\n### |\n## |\n# |$)/);
  if (!condMatch) throw new Error("curriculum-schema.md: condition vocab section not found");
  const condKeys = parseVocabTable(condMatch[1]);

  // prior vocab — from the prior_knowledge table in the same section
  const priorMatch = methodSection.match(/###[^\n]*`prior_knowledge`[^\n]*\n([\s\S]*?)(?=\n###|\n##|\n#|$)/);
  if (!priorMatch) throw new Error("curriculum-schema.md: prior_knowledge section not found");
  const priorKeys = parseVocabTable(priorMatch[1]);

  if (goalKeys.length === 0) throw new Error("curriculum-schema.md: zero goal keys parsed");
  if (condKeys.length === 0) throw new Error("curriculum-schema.md: zero condition keys parsed");
  if (priorKeys.length === 0) throw new Error("curriculum-schema.md: zero prior keys parsed");

  const vocabDocs: KnowledgeDoc[] = [
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
  return vocabDocs;
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

    // Exclude family: reference (design §1-2)
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

    const relPath = relative(vaultRoot, fullPath);

    docs.push({
      doc_id: `method:${fm.id}`,
      kind: "method",
      fields_json: JSON.stringify(fields),
      body: parsed.body.trim(),
      source_path: relPath,
    });
  }

  // Sort by doc_id for deterministic output
  docs.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
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

  // Digest: sha256 of sorted doc_id:fields_json:body concatenation
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

const allDocs: KnowledgeDoc[] = [...vocabDocs, ...methodDocs];

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
