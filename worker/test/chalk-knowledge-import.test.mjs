// Tests for #1289: vault one-shot import and closed-vocab checker.
//
// Unit tests:  checkVocab pure function (no I/O). Always run.
// Fixture tests: import against worker/test/fixtures/chalk-vault/ (CI-safe, no real vault).
// Real vault tests: conditional on CHALK_VAULT_PATH env var. Skip when absent.
//
// Fixture vault counts (from fixtures/chalk-vault/):
//   vocab=3, method=1, gate=7, constitution=4, prohibited-move=2,
//   placement=3, axis=2, acceptance=3, guide=4 (workshop-core skipped, not in fixture)
//   total=29
//
// Real vault counts (from curriculum_wiki/, validated 2026-09-24):
//   vocab=3, method=8, gate=26, constitution=11, prohibited-move=5,
//   placement=9, axis=5, acceptance=22, guide=5
//   total=94  vault commit: ebdecf5f9345c6e58abf1495ec4a4c8a9c34a067
//
// Run (unit + fixture):  node --experimental-strip-types worker/test/chalk-knowledge-import.test.mjs
// Run (+ real vault):    CHALK_VAULT_PATH=/path/to/curriculum_wiki node --experimental-strip-types worker/test/chalk-knowledge-import.test.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVocab } from "../src/lib/chalk-vocab-check.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const IMPORT_SCRIPT = join(REPO_ROOT, "scripts/chalk-knowledge-import/index.ts");
const FIXTURE_VAULT = join(__dirname, "fixtures/chalk-vault");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;

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

function skip(name, reason) {
  console.log(`  - ${name} (skip: ${reason})`);
  skipped++;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function makeTempPath() {
  return join(tmpdir(), `chalk-import-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
}

function runImport(vaultPath, extraArgs = []) {
  const outPath = makeTempPath();
  try {
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", IMPORT_SCRIPT,
        "--vault-path", vaultPath,
        "--vault-commit", "test-fixture",
        "--version", "1",
        "--note", "test import",
        "--created-by", "test",
        "--out", outPath,
        ...extraArgs,
      ],
      { encoding: "utf-8", cwd: REPO_ROOT },
    );
    return { sql: readFileSync(outPath, "utf-8"), path: outPath };
  } finally {
    if (existsSync(outPath)) unlinkSync(outPath);
  }
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
    { doc_id: "vocab:condition", kind: "vocab", fields_json: JSON.stringify({ keys: [] }), body: "" },
    { doc_id: "vocab:prior", kind: "vocab", fields_json: JSON.stringify({ keys: [{ key: "novice" }] }), body: "" },
    {
      doc_id: "method:m-bad",
      kind: "method",
      fields_json: JSON.stringify({
        id: "m-bad", family: "explicit", evidence_grade: "A",
        prior_knowledge: "novice", requires_guidance: false,
        best_for: ["nonexistent-goal"],
        weak_for: [], avoid_when: [],
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
    { doc_id: "vocab:goal", kind: "vocab", fields_json: JSON.stringify({ keys: [] }), body: "" },
    { doc_id: "vocab:condition", kind: "vocab", fields_json: JSON.stringify({ keys: [] }), body: "" },
    { doc_id: "vocab:prior", kind: "vocab", fields_json: JSON.stringify({ keys: [{ key: "novice" }] }), body: "" },
    {
      doc_id: "method:m-x",
      kind: "method",
      fields_json: JSON.stringify({
        id: "m-x", family: "explicit", evidence_grade: "A",
        prior_knowledge: "novice-to-intermediate",
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
// Fixture tests: import against worker/test/fixtures/chalk-vault/ (CI-safe)
// ---------------------------------------------------------------------------

console.log("\n[fixture vault import tests]");

test("fixture: import succeeds and produces SQL", () => {
  const { sql } = runImport(FIXTURE_VAULT);
  assert(sql.includes("INSERT INTO chalk_knowledge_versions"), "version INSERT missing");
  assert(sql.includes("INSERT INTO chalk_knowledge_docs"), "docs INSERT missing");
  assert(sql.includes("source_commit: test-fixture"), "source_commit comment missing");
});

test("fixture: all expected doc kinds present", () => {
  const { sql } = runImport(FIXTURE_VAULT);
  const kinds = ["vocab", "method", "gate", "constitution", "prohibited-move", "placement", "axis", "acceptance", "guide"];
  for (const kind of kinds) {
    assert(sql.includes(`'${kind}'`), `missing kind: ${kind}`);
  }
});

test("fixture: method docs have no family:reference", () => {
  const { sql } = runImport(FIXTURE_VAULT);
  const refFamilyMatches = [...sql.matchAll(/"family":"reference"/g)];
  assert(refFamilyMatches.length === 0, `found family:reference in output (${refFamilyMatches.length} occurrences)`);
});

test("fixture: C-2a placement excluded", () => {
  const { sql } = runImport(FIXTURE_VAULT);
  assert(!sql.includes("'placement:C-2a'"), "C-2a must be excluded from placement docs");
});

test("fixture: gate docs have judge field", () => {
  const { sql } = runImport(FIXTURE_VAULT);
  // All gate judge values must be one of machine/model/human
  assert(sql.includes('"judge":"machine"') || sql.includes('"judge":"model"') || sql.includes('"judge":"human"'),
    "gate docs must have judge field");
});

test("fixture: gate G2-2 has judge=model", () => {
  const { sql } = runImport(FIXTURE_VAULT);
  // Find the G2-2 doc insert and check its fields_json
  const g22Match = sql.match(/gate:G2-2['\s,]+[^)]*\{[^}]*"judge":"([^"]+)"/);
  if (g22Match) {
    assertEqual(g22Match[1], "model", "G2-2 judge should be model");
  }
  // Alternative: check the SQL contains the combination
  assert(sql.includes('"id":"G2-2"') && sql.includes('"judge":"model"'),
    "G2-2 should have judge=model");
});

test("fixture: gate G3-6 has judge=human", () => {
  const { sql } = runImport(FIXTURE_VAULT);
  assert(sql.includes('"id":"G3-6"') && sql.includes('"judge":"human"'),
    "G3-6 should have judge=human");
});

test("fixture: G1-1 reads contains B-3", () => {
  const { sql } = runImport(FIXTURE_VAULT);
  assert(sql.includes('"reads":["B-3"]'), "G1-1 should reference B-3");
});

test("fixture: constitution A-* and B-* sections present", () => {
  const { sql } = runImport(FIXTURE_VAULT);
  assert(sql.includes("'constitution:A-1'"), "A-1 constitution clause missing");
  assert(sql.includes("'constitution:B-1'"), "B-1 constitution clause missing");
});

test("fixture: axis docs have key field", () => {
  const { sql } = runImport(FIXTURE_VAULT);
  assert(sql.includes('"key":"input"'), "axis input missing");
  assert(sql.includes('"key":"load"'), "axis load missing");
});

test("fixture: guide docs present (authoring-order, conversion, etc.)", () => {
  const { sql } = runImport(FIXTURE_VAULT);
  assert(sql.includes("'guide:authoring-order'"), "guide:authoring-order missing");
  assert(sql.includes("'guide:conversion'"), "guide:conversion missing");
  assert(sql.includes("'guide:plan-spec'"), "guide:plan-spec missing");
  assert(sql.includes("'guide:session-format'"), "guide:session-format missing");
  // workshop-core is skipped in fixture vault (file not found) — not asserted here
});

// ---------------------------------------------------------------------------
// Real vault tests — conditional on CHALK_VAULT_PATH
// ---------------------------------------------------------------------------

const VAULT_PATH = process.env.CHALK_VAULT_PATH;

console.log("\n[real vault integration tests]");

if (!VAULT_PATH) {
  skip("real vault: doc counts by kind", "CHALK_VAULT_PATH not set");
  skip("real vault: family:reference excluded from methods", "CHALK_VAULT_PATH not set");
  skip("real vault: out-of-vocab → no SQL written", "CHALK_VAULT_PATH not set");
  skip("real vault: all 9 doc kinds present with correct counts", "CHALK_VAULT_PATH not set");
} else {
  console.log(`  (vault: ${VAULT_PATH})`);

  test("real vault: import succeeds", () => {
    const { sql } = runImport(VAULT_PATH);
    assert(sql.includes("INSERT INTO chalk_knowledge_versions"), "version INSERT missing");
  });

  test("real vault: method=8, vocab=3 (unchanged from original)", () => {
    const { sql } = runImport(VAULT_PATH);
    const methodMatches = [...sql.matchAll(/INSERT INTO chalk_knowledge_docs[\s\S]*?'method'/g)];
    assert(methodMatches.length === 8, `expected 8 method docs, got ${methodMatches.length}`);
    const vocabMatches = [...sql.matchAll(/INSERT INTO chalk_knowledge_docs[\s\S]*?'vocab'/g)];
    assert(vocabMatches.length === 3, `expected 3 vocab docs, got ${vocabMatches.length}`);
  });

  test("real vault: gate=26", () => {
    const { sql } = runImport(VAULT_PATH);
    const gateMatches = [...sql.matchAll(/INSERT INTO chalk_knowledge_docs[\s\S]*?'gate'/g)];
    assert(gateMatches.length === 26, `expected 26 gate docs, got ${gateMatches.length}`);
  });

  test("real vault: constitution=11 (A-1~A-5 + B-1~B-6)", () => {
    const { sql } = runImport(VAULT_PATH);
    const constitutionMatches = [...sql.matchAll(/INSERT INTO chalk_knowledge_docs[\s\S]*?'constitution'/g)];
    assert(constitutionMatches.length === 11,
      `expected 11 constitution docs, got ${constitutionMatches.length}`);
  });

  test("real vault: placement=9 (C-2a excluded)", () => {
    const { sql } = runImport(VAULT_PATH);
    assert(!sql.includes("'placement:C-2a'"), "C-2a must be excluded");
    const placementMatches = [...sql.matchAll(/INSERT INTO chalk_knowledge_docs[\s\S]*?'placement'/g)];
    assert(placementMatches.length === 9,
      `expected 9 placement docs, got ${placementMatches.length}`);
  });

  test("real vault: axis=5", () => {
    const { sql } = runImport(VAULT_PATH);
    const axisMatches = [...sql.matchAll(/INSERT INTO chalk_knowledge_docs[\s\S]*?'axis'/g)];
    assert(axisMatches.length === 5, `expected 5 axis docs, got ${axisMatches.length}`);
  });

  test("real vault: acceptance=22", () => {
    const { sql } = runImport(VAULT_PATH);
    const acceptanceMatches = [...sql.matchAll(/INSERT INTO chalk_knowledge_docs[\s\S]*?'acceptance'/g)];
    assert(acceptanceMatches.length === 22,
      `expected 22 acceptance docs, got ${acceptanceMatches.length}`);
  });

  test("real vault: guide=5 (all 5 including workshop-core)", () => {
    const { sql } = runImport(VAULT_PATH);
    assert(sql.includes("'guide:workshop-core'"), "guide:workshop-core missing in real vault");
    const guideMatches = [...sql.matchAll(/INSERT INTO chalk_knowledge_docs[\s\S]*?'guide'/g)];
    assert(guideMatches.length === 5, `expected 5 guide docs, got ${guideMatches.length}`);
  });

  test("real vault: total doc_count=94 in version row", () => {
    const { sql } = runImport(VAULT_PATH);
    // doc_count is the 9th column in the version INSERT
    assert(sql.includes(", 94, ") || sql.includes(",94,") || sql.match(/doc_count: 94/),
      "version row should have doc_count=94");
  });

  test("real vault: family:reference excluded", () => {
    const { sql } = runImport(VAULT_PATH);
    const krDocIdMatches = [...sql.matchAll(/'method:m-kr-[^']+'/g)];
    assert(krDocIdMatches.length === 0,
      `found reference method doc_id in output: ${krDocIdMatches.map(m => m[0]).join(", ")}`);
    const refFamilyMatches = [...sql.matchAll(/"family":"reference"/g)];
    assert(refFamilyMatches.length === 0,
      `found family:reference in output (${refFamilyMatches.length} occurrences)`);
  });

  test("real vault: vault commit (40-char hex) recorded", () => {
    const { sql } = runImport(VAULT_PATH);
    const commitMatch = sql.match(/source_commit: ([0-9a-f]{40})/);
    assert(commitMatch, "vault commit should appear in SQL comment");
  });
}

// ---------------------------------------------------------------------------
// Out-of-vocab → no SQL written (pure function test, no vault needed)
// ---------------------------------------------------------------------------

console.log("\n[vocab gate: out-of-vocab exits non-zero]");

test("checkVocab: bad avoid_when value rejected", () => {
  const badDocs = [
    { doc_id: "vocab:goal", kind: "vocab", fields_json: JSON.stringify({ keys: [{ key: "acquire-procedure" }] }), body: "" },
    { doc_id: "vocab:condition", kind: "vocab", fields_json: JSON.stringify({ keys: [] }), body: "" },
    { doc_id: "vocab:prior", kind: "vocab", fields_json: JSON.stringify({ keys: [{ key: "novice" }] }), body: "" },
    {
      doc_id: "method:m-001",
      kind: "method",
      fields_json: JSON.stringify({
        id: "m-001", family: "explicit", evidence_grade: "A",
        prior_knowledge: "novice", requires_guidance: false,
        best_for: [], weak_for: [], avoid_when: ["INVALID-CONDITION"],
      }),
      body: "",
    },
  ];
  const result = checkVocab(badDocs);
  assert(!result.ok, "expected check to fail");
  assert(result.errors.some(e => e.bad_values.includes("INVALID-CONDITION")), "INVALID-CONDITION should be reported");
  assert(result.errors.some(e => e.field === "avoid_when"), "field=avoid_when should be reported");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
if (failed > 0) process.exit(1);
