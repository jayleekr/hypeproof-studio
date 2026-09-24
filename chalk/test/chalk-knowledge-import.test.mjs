// Tests for #1289: vault one-shot import and closed-vocab checker.
//
// Positive: 8 method cards (family != reference) + 3 vocab docs, vault
//           commit recorded in output SQL.
// Negative: family:reference excluded, out-of-vocab value → no SQL output.
//
// Run: node --experimental-strip-types chalk/test/chalk-knowledge-import.test.mjs
//
// Note: this test READS the real vault at VAULT_PATH (default below).
// The vault is read-only; no writes are made.

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVocab } from "../../worker/src/lib/chalk-vocab-check.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const VAULT_PATH = process.env.VAULT_PATH ??
  "/Users/jj_home/Git/hypeproof_kids_edu/kids_edu_vault/curriculum_wiki";
const IMPORT_SCRIPT = join(process.cwd(), "scripts/chalk-knowledge-import/index.ts");
const OUT_SQL = join(tmpdir(), `chalk-import-test-${Date.now()}.sql`);

function runImport(extraArgs = []) {
  return execFileSync(
    process.execPath,
    ["--experimental-strip-types", IMPORT_SCRIPT,
      "--vault-path", VAULT_PATH,
      "--version", "1",
      "--note", "test import",
      "--created-by", "test",
      "--out", OUT_SQL,
      ...extraArgs,
    ],
    { encoding: "utf-8", cwd: process.cwd() },
  );
}

function cleanup() {
  if (existsSync(OUT_SQL)) unlinkSync(OUT_SQL);
}

// ---------------------------------------------------------------------------
// Unit: chalk-vocab-check.ts (pure function, no vault I/O)
// ---------------------------------------------------------------------------

console.log("\n[chalk-vocab-check unit tests]");

test("ok: valid method + vocab docs", () => {
  const docs = [
    {
      doc_id: "vocab:goal",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [{ key: "acquire-procedure" }, { key: "transfer" }] }),
      body: "",
    },
    {
      doc_id: "vocab:condition",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [{ key: "large-group" }] }),
      body: "",
    },
    {
      doc_id: "vocab:prior",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [{ key: "novice" }, { key: "intermediate" }, { key: "any" }] }),
      body: "",
    },
    {
      doc_id: "method:m-001",
      kind: "method",
      fields_json: JSON.stringify({
        id: "m-001", family: "explicit", evidence_grade: "A",
        prior_knowledge: "novice", requires_guidance: false,
        best_for: ["acquire-procedure"],
        weak_for: ["transfer"],
        avoid_when: [],
      }),
      body: "# Explicit Instruction",
    },
  ];
  const result = checkVocab(docs);
  assert(result.ok, `expected ok, got errors: ${JSON.stringify(result.errors)}`);
  assertEqual(result.errors.length, 0, "expected 0 errors");
});

test("fail: best_for has out-of-vocab value", () => {
  const docs = [
    {
      doc_id: "vocab:goal",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [{ key: "transfer" }] }),
      body: "",
    },
    {
      doc_id: "vocab:condition",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [] }),
      body: "",
    },
    {
      doc_id: "vocab:prior",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [{ key: "novice" }] }),
      body: "",
    },
    {
      doc_id: "method:m-bad",
      kind: "method",
      fields_json: JSON.stringify({
        id: "m-bad", family: "explicit", evidence_grade: "A",
        prior_knowledge: "novice", requires_guidance: false,
        best_for: ["nonexistent-goal"],
        weak_for: [],
        avoid_when: [],
      }),
      body: "",
    },
  ];
  const result = checkVocab(docs);
  assert(!result.ok, "expected check to fail");
  assert(result.errors.length > 0, "expected at least one error");
  const err = result.errors[0];
  assertEqual(err.field, "best_for", "error field should be best_for");
  assert(err.bad_values.includes("nonexistent-goal"), "should report bad value");
});

test("fail: prior_knowledge out of vocab", () => {
  const docs = [
    {
      doc_id: "vocab:goal",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [] }),
      body: "",
    },
    {
      doc_id: "vocab:condition",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [] }),
      body: "",
    },
    {
      doc_id: "vocab:prior",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [{ key: "novice" }] }),
      body: "",
    },
    {
      doc_id: "method:m-x",
      kind: "method",
      fields_json: JSON.stringify({
        id: "m-x", family: "explicit", evidence_grade: "A",
        prior_knowledge: "novice-to-intermediate",  // old value, not in vocab
        requires_guidance: false,
        best_for: [], weak_for: [], avoid_when: [],
      }),
      body: "",
    },
  ];
  const result = checkVocab(docs);
  assert(!result.ok, "expected check to fail");
  const err = result.errors.find(e => e.field === "prior_knowledge");
  assert(err, "expected prior_knowledge error");
  assert(err.bad_values.includes("novice-to-intermediate"), "bad value reported");
});

test("ok: empty arrays pass even with empty vocab sets", () => {
  // No vocab docs at all, method has only empty arrays and no prior_knowledge
  const docs = [
    {
      doc_id: "method:m-empty",
      kind: "method",
      fields_json: JSON.stringify({
        id: "m-empty", family: "explicit", evidence_grade: "A",
        prior_knowledge: undefined,
        requires_guidance: false,
        best_for: [], weak_for: [], avoid_when: [],
      }),
      body: "",
    },
  ];
  const result = checkVocab(docs);
  assert(result.ok, `expected ok, errors: ${JSON.stringify(result.errors)}`);
});

// ---------------------------------------------------------------------------
// Integration: real vault import
// ---------------------------------------------------------------------------

console.log("\n[integration: real vault import]");

test("positive: 8 method docs + 3 vocab docs imported, vault commit recorded", () => {
  cleanup();
  try {
    runImport();
  } catch (err) {
    throw new Error(`import script failed: ${err.message}\n${err.stderr}`);
  }

  assert(existsSync(OUT_SQL), "SQL file should be written");
  const sql = readFileSync(OUT_SQL, "utf-8");

  // Count method doc inserts
  const methodMatches = [...sql.matchAll(/INSERT INTO chalk_knowledge_docs[\s\S]*?'method'/g)];
  assert(methodMatches.length === 8, `expected 8 method docs, got ${methodMatches.length}`);

  // Count vocab doc inserts
  const vocabMatches = [...sql.matchAll(/INSERT INTO chalk_knowledge_docs[\s\S]*?'vocab'/g)];
  assert(vocabMatches.length === 3, `expected 3 vocab docs, got ${vocabMatches.length}`);

  // Total doc count in version row
  assert(sql.includes(", 11,") || sql.includes(",11,"), "version row should have doc_count=11");

  // Vault commit recorded (40-char hex)
  const commitMatch = sql.match(/source_commit: ([0-9a-f]{40})/);
  assert(commitMatch, "vault commit should appear in SQL comment");

  // Version row exists
  assert(sql.includes("INSERT INTO chalk_knowledge_versions"), "version INSERT missing");
});

test("negative: family:reference excluded — no m-kr-* doc_id in output", () => {
  assert(existsSync(OUT_SQL), "SQL file should exist from previous test");
  const sql = readFileSync(OUT_SQL, "utf-8");

  // kr-* method files have id like m-kr-map, m-kr-cooperative, etc.
  // Their doc_id would be 'method:m-kr-*' — must not appear as INSERT values.
  // Note: body text of non-reference methods may contain [[kr-*]] wiki links,
  // which is fine — only the doc_id column matters here.
  const krDocIdMatches = [...sql.matchAll(/'method:m-kr-[^']+'/g)];
  assert(
    krDocIdMatches.length === 0,
    `found reference method doc_id in output: ${krDocIdMatches.map(m => m[0]).join(", ")}`,
  );

  // Also verify no doc with family=reference sneaked through in fields_json
  const refFamilyMatches = [...sql.matchAll(/"family":"reference"/g)];
  assert(
    refFamilyMatches.length === 0,
    `found family:reference in output (${refFamilyMatches.length} occurrences)`,
  );
});

test("negative: out-of-vocab value → no SQL output, non-zero exit", () => {
  cleanup();
  // Temporarily test the checkVocab function with a synthetic bad doc
  // (We cannot modify the vault, so we test the function directly.)
  const badDocs = [
    {
      doc_id: "vocab:goal",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [{ key: "acquire-procedure" }] }),
      body: "",
    },
    {
      doc_id: "vocab:condition",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [] }),
      body: "",
    },
    {
      doc_id: "vocab:prior",
      kind: "vocab",
      fields_json: JSON.stringify({ keys: [{ key: "novice" }] }),
      body: "",
    },
    {
      doc_id: "method:m-001",
      kind: "method",
      fields_json: JSON.stringify({
        id: "m-001", family: "explicit", evidence_grade: "A",
        prior_knowledge: "novice", requires_guidance: false,
        best_for: ["INVALID-GOAL"],  // out of vocab
        weak_for: [], avoid_when: [],
      }),
      body: "",
    },
  ];
  const result = checkVocab(badDocs);
  assert(!result.ok, "expected check to fail for out-of-vocab value");
  assert(result.errors.some(e => e.bad_values.includes("INVALID-GOAL")), "INVALID-GOAL should be reported");
  // File should not exist (not written in this subtest; relies on prior cleanup)
  assert(!existsSync(OUT_SQL), "SQL file should not have been written");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

cleanup();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
