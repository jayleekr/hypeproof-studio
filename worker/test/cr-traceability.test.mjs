// Counts the Curriculum Runtime (CR) requirement ↔ verification trace in both directions,
// and checks that every "Reuses" reference points at a requirement that really exists.
// Run: node --experimental-strip-types test/cr-traceability.test.mjs
//
// Modelled on sx-traceability.test.mjs, which exists because 42 of 60 SX rows once named a
// verifying test that was verifying something else, while a one-directional link checker
// scored the documents 100/100. CR adds two failure modes of its own:
//
//   - A CR row says "Reuses AE-37" instead of restating it. If AE-37 is renumbered or never
//     existed, the row silently claims coverage it does not have. Every reuse ID must be in
//     the requirement ledger (config/requirement-work.json) AND appear as a row or heading in
//     the document the ledger names for it.
//   - SX-48 (no second store, no second scorer) must bind every evidence and memory row.
//     A row in those sections that drops SX-48 is the first step toward a parallel store.
//
// The checks are pure functions over parsed documents. The negative controls at the bottom
// feed each check a drifted copy and require it to complain; a check that cannot fail is not
// a check.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const REQ_PATH = "docs/requirements/curriculum-runtime.md";
const REQ = read(`../../${REQ_PATH}`);
const TST = read("../../docs/testing/curriculum-runtime.md");
const INT = read("../../docs/intents/curriculum-runtime.md");
const LEDGER = JSON.parse(read("../../config/requirement-work.json"));

const WEEKS = new Set(["W1", "W2", "W3", "W4", "W5", "W6"]);
// Sections whose rows store or read evidence and memory; SX-48 must bind each of them.
const SX48_SECTIONS = new Set(["E", "G"]);
// Rows outside those sections that read or write the same store. The set is locked in both
// directions: dropping SX-48 from a listed row fails (check 6), citing it on an unlisted row
// outside E/G fails (check 6c), and the requirements doc's "SX-48 constraint" sentence must
// name the same set (check 6b).
const SX48_EXTRA_ROWS = new Set([
  "CR-10", "CR-12", "CR-13", "CR-16", "CR-21", "CR-44", "CR-46", "CR-47", "CR-48",
  "CR-52", "CR-55", "CR-56", "CR-58", "CR-67", "CR-69", "CR-73", "CR-81",
]);

/** Requirement rows: `| CR-xx | stage / intent | weeks | requirement | reuses | verification |`. */
function parseRequirements(text) {
  const rows = new Map();
  const problems = [];
  let section = null;
  for (const line of text.split("\n")) {
    const heading = line.match(/^## ([A-Z])\. /);
    if (heading) section = heading[1];
    else if (line.startsWith("## ")) section = null;
    const m = line.match(/^\|\s*(CR-\d+)\s*\|(.*)\|\s*$/);
    if (!m) continue;
    const cells = m[2].split("|").map((c) => c.trim());
    if (cells.length !== 5) {
      problems.push(`${m[1]}: expected 6 cells, found ${cells.length + 1} (a stray "|" inside a cell?)`);
      continue;
    }
    if (rows.has(m[1])) problems.push(`${m[1]}: duplicate requirement row`);
    const [stage, weeks, , reuses, verification] = cells;
    rows.set(m[1], {
      section,
      priority: stage.match(/^(P[0-2])\b/)?.[1] ?? null,
      intents: stage.match(/INT-CR-\d+/g) ?? [],
      weeks: weeks.split(/[,\s]+/).filter(Boolean),
      reuses: reuses === "—" ? [] : reuses.split(/[,\s]+/).filter(Boolean),
      tests: new Set(verification.match(/CR-T\d+/g) ?? []),
    });
  }
  return { rows, problems };
}

/** Test rows: `| CR-Txx | layer | what | positive | negative | targets |`; targets are the last cell. */
function parseTests(text) {
  const rows = new Map();
  const problems = [];
  for (const m of text.matchAll(/^\|\s*(CR-T\d+)\s*\|(.*)\|\s*$/gm)) {
    const cells = m[2].split("|");
    if (cells.length !== 5) problems.push(`${m[1]}: expected 6 cells, found ${cells.length + 1}`);
    if (rows.has(m[1])) problems.push(`${m[1]}: duplicate test row`);
    rows.set(m[1], new Set(cells.pop().match(/CR-\d+(?!\d)/g) ?? []));
  }
  return { rows, problems };
}

/** The `## Coverage` table: `| CR-xx | CR-Txx, ... |`. */
function parseCoverage(text) {
  const out = new Map();
  let inside = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## Coverage")) { inside = true; continue; }
    if (inside && line.startsWith("## ")) break;
    if (!inside) continue;
    const m = line.match(/^\|\s*(CR-\d+)\s*\|\s*([^|]*)\|\s*$/);
    if (m) out.set(m[1], new Set(m[2].match(/CR-T\d+/g) ?? []));
  }
  return out;
}

/** Ledger ID → the text of the document the ledger registers it under. */
function ledgerIndex(ledger) {
  const out = new Map();
  for (const doc of ledger.documents) {
    for (const id of doc.ids) out.set(id, doc.path);
  }
  return out;
}

const invert = (tests) => {
  const out = new Map();
  for (const [t, targets] of tests) {
    for (const cr of targets) {
      if (!out.has(cr)) out.set(cr, new Set());
      out.get(cr).add(t);
    }
  }
  return out;
};
const same = (a, b) => [...a].sort().join(",") === [...b].sort().join(",");

// ── Checks (pure: data in, list of problems out) ───────────────────────────

/** 1. Requirement → test: every named test exists and lists the requirement as a target. */
function requirementToTest(req, tests) {
  const bad = [];
  for (const [cr, row] of req) {
    if (row.tests.size === 0) bad.push(`${cr}: no verification test`);
    for (const t of row.tests) {
      if (!tests.has(t)) bad.push(`${cr} → ${t}: ${t} is not defined in the testing doc`);
      else if (!tests.get(t).has(cr)) bad.push(`${cr} → ${t}: ${t} does not list ${cr} as a target`);
    }
  }
  return bad;
}

/** 2. Test → requirement: every test targets something, and every target points back. */
function testToRequirement(req, tests) {
  const bad = [];
  for (const [t, targets] of tests) {
    if (targets.size === 0) bad.push(`${t}: targets no requirement (orphan test)`);
    for (const cr of targets) {
      if (!req.has(cr)) bad.push(`${t} → ${cr}: ${cr} is not a requirement row`);
      else if (!req.get(cr).tests.has(t)) bad.push(`${t} → ${cr}: ${cr}'s verification column omits ${t}`);
    }
  }
  return bad;
}

/** 3. The coverage table equals the per-row targets, both ways. */
function coverageAgrees(tests, coverage) {
  const byReq = invert(tests);
  const bad = [];
  for (const cr of new Set([...byReq.keys(), ...coverage.keys()])) {
    const a = byReq.get(cr) ?? new Set();
    const b = coverage.get(cr) ?? new Set();
    if (!same(a, b)) bad.push(`${cr}: rows=[${[...a].sort()}] coverage=[${[...b].sort()}]`);
  }
  return bad;
}

/** 4. Stage, intent and week tags are well formed and resolve. */
function rowTags(req, intents) {
  const bad = [];
  for (const [cr, row] of req) {
    if (!row.priority) bad.push(`${cr}: stage cell has no P0/P1/P2`);
    if (row.intents.length === 0) bad.push(`${cr}: no INT-CR intent link`);
    for (const i of row.intents) if (!intents.has(i)) bad.push(`${cr}: intent ${i} is not defined in the intents doc`);
    if (row.weeks.length === 0) bad.push(`${cr}: no curriculum week tag`);
    for (const w of row.weeks) if (!WEEKS.has(w)) bad.push(`${cr}: "${w}" is not a week tag (W1–W6)`);
  }
  return bad;
}

/** 5. Every reuse ID is in the ledger, is not a CR ID, and is a row or heading of its document. */
function reusesResolve(req, index, docText) {
  const bad = [];
  for (const [cr, row] of req) {
    for (const id of row.reuses) {
      if (id.startsWith("CR-")) { bad.push(`${cr}: reuses ${id}, but reuse must point outside CR`); continue; }
      const path = index.get(id);
      if (!path) { bad.push(`${cr}: reuses ${id}, which is not in config/requirement-work.json`); continue; }
      const text = docText(path);
      const esc = id.replace(/[-]/g, "\\-");
      const defined = new RegExp(`^\\|\\s*\`?${esc}\`?\\s*\\|`, "m").test(text) || new RegExp(`^###\\s+${esc}\\s*$`, "m").test(text);
      if (!defined) bad.push(`${cr}: reuses ${id}, but ${path} has no row or heading for it`);
    }
  }
  return bad;
}

/** 6. SX-48 binds every evidence and memory row. */
function sx48Binds(req) {
  const bad = [];
  for (const [cr, row] of req) {
    if ((SX48_SECTIONS.has(row.section) || SX48_EXTRA_ROWS.has(cr)) && !row.reuses.includes("SX-48")) {
      bad.push(`${cr}: section ${row.section} stores or reads evidence/memory but does not cite SX-48`);
    }
  }
  return bad;
}

/** 6b. The requirements doc's "SX-48 constraint" sentence names exactly the locked extra rows. */
function sx48SentenceAgrees(text) {
  const line = text.split("\n").find((l) => l.includes("**SX-48 constraint**"));
  if (!line) return ['no "**SX-48 constraint**" line in the requirements doc'];
  const named = new Set(line.match(/CR-\d+/g) ?? []);
  return same(named, SX48_EXTRA_ROWS) ? [] : [`sentence names [${[...named].sort()}], test locks [${[...SX48_EXTRA_ROWS].sort()}]`];
}

/** 6c. The rows outside E/G that actually cite SX-48 are exactly the locked set. */
function sx48CitationsLocked(req) {
  const citing = new Set([...req].filter(([, row]) => !SX48_SECTIONS.has(row.section) && row.reuses.includes("SX-48")).map(([cr]) => cr));
  return same(citing, SX48_EXTRA_ROWS) ? [] : [`rows outside E/G citing SX-48 [${[...citing].sort()}], test locks [${[...SX48_EXTRA_ROWS].sort()}]`];
}

/** 7. The ledger registers exactly the rows the document defines. */
function ledgerMatches(req, ledger) {
  const doc = ledger.documents.find((d) => d.path === REQ_PATH);
  if (!doc) return [`${REQ_PATH} is not registered in config/requirement-work.json`];
  return same(new Set(doc.ids), new Set(req.keys())) ? [] : [`ledger ids differ from document rows`];
}

// ── Parse the real documents ────────────────────────────────────────────────

const { rows: req, problems: reqProblems } = parseRequirements(REQ);
const { rows: tests, problems: testProblems } = parseTests(TST);
const coverage = parseCoverage(TST);
const intents = new Set([...INT.matchAll(/^\|\s*(INT-CR-\d+)\s*\|/gm)].map((m) => m[1]));
const index = ledgerIndex(LEDGER);
const docCache = new Map();
const docText = (path) => {
  if (!docCache.has(path)) docCache.set(path, read(`../../${path}`));
  return docCache.get(path);
};

// 0. Empty samples make every check below pass vacuously.
assert.ok(req.size >= 84, `read only ${req.size} requirement rows — the parser is broken`);
assert.ok(tests.size >= 80, `read only ${tests.size} test rows — the parser is broken`);
assert.ok(coverage.size >= 84, `read only ${coverage.size} coverage rows — the parser is broken`);
assert.ok(intents.size >= 10, `read only ${intents.size} intents — the parser is broken`);
assert.deepEqual(reqProblems, [], `malformed requirement rows:\n  ${reqProblems.join("\n  ")}`);
assert.deepEqual(testProblems, [], `malformed test rows:\n  ${testProblems.join("\n  ")}`);

const checks = {
  "requirement → test": requirementToTest(req, tests),
  "test → requirement": testToRequirement(req, tests),
  "coverage table": coverageAgrees(tests, coverage),
  "stage / intent / week tags": rowTags(req, intents),
  "reuse references": reusesResolve(req, index, docText),
  "SX-48 constraint": sx48Binds(req),
  "SX-48 sentence": sx48SentenceAgrees(REQ),
  "SX-48 citations": sx48CitationsLocked(req),
  "ledger registration": ledgerMatches(req, LEDGER),
};
for (const [name, bad] of Object.entries(checks)) {
  assert.deepEqual(bad, [], `${name}:\n  ${bad.join("\n  ")}`);
}

// ── Negative controls: each check must catch a drifted copy ────────────────
{
  const clone = (m) => new Map([...m].map(([k, v]) => [k, v instanceof Set ? new Set(v) : { ...v, tests: new Set(v.tests), reuses: [...v.reuses], weeks: [...v.weeks] }]));

  const r1 = clone(req); r1.get("CR-01").tests.add("CR-T99");
  assert.ok(requirementToTest(r1, tests).some((p) => p.includes("CR-T99")), "check 1 missed a reference to an undefined test");

  const t2 = clone(tests); t2.set("CR-T99", new Set());
  assert.ok(testToRequirement(req, t2).some((p) => p.includes("orphan")), "check 2 missed an orphan test");

  const c3 = new Map(coverage); c3.set("CR-05", new Set(["CR-T05"]));
  assert.ok(coverageAgrees(tests, c3).some((p) => p.startsWith("CR-05")), "check 3 missed a coverage row that dropped a test");

  const r4 = clone(req); r4.get("CR-02").weeks = ["W7"];
  assert.ok(rowTags(r4, intents).some((p) => p.includes("W7")), "check 4 missed an invalid week tag");

  const r5 = clone(req); r5.get("CR-10").reuses.push("AE-99");
  assert.ok(reusesResolve(r5, index, docText).some((p) => p.includes("AE-99")), "check 5 missed a reuse ID that does not exist");

  const r6 = clone(req); r6.get("CR-23").reuses = r6.get("CR-23").reuses.filter((id) => id !== "SX-48");
  assert.ok(sx48Binds(r6).some((p) => p.startsWith("CR-23")), "check 6 missed an evidence row without SX-48");

  const r6x = clone(req); r6x.get("CR-48").reuses = r6x.get("CR-48").reuses.filter((id) => id !== "SX-48");
  assert.ok(sx48Binds(r6x).some((p) => p.startsWith("CR-48")), "check 6 missed a locked row outside E/G without SX-48");

  assert.ok(sx48SentenceAgrees(REQ.replace(/(\*\*SX-48 constraint\*\*[^\n]*?)CR-52, /, "$1")).length > 0, "check 6b missed a sentence that dropped a locked row");

  const r6c = clone(req); r6c.get("CR-11").reuses.push("SX-48");
  assert.ok(sx48CitationsLocked(r6c).some((p) => p.includes("CR-11")), "check 6c missed an unlisted row outside E/G citing SX-48");

  const r7 = clone(req); r7.delete("CR-71");
  assert.ok(ledgerMatches(r7, LEDGER).length > 0, "check 7 missed a ledger/document mismatch");

  const parsed = parseRequirements("## E. X\n\n| CR-99 | P0 / INT-CR-04 | W1 | text | — | CR-T01 |\n| CR-98 | P0 | W1 | a | b | c | CR-T01 |\n");
  assert.equal(parsed.rows.get("CR-99")?.section, "E", "the parser does not track sections");
  assert.ok(parsed.problems.some((p) => p.startsWith("CR-98")), "the parser accepted a row with a stray cell");
}

const referenced = new Set([...req.values()].flatMap((r) => [...r.tests]));
const reuses = new Set([...req.values()].flatMap((r) => r.reuses));
console.log(
  `cr-traceability: OK — ${req.size} requirements · ${referenced.size} tests · ${reuses.size} reuse IDs resolved · both directions agree`,
);
