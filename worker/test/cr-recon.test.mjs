// CR-T01 (doc check, CR-01): the Curriculum Runtime reconnaissance is complete and true
// on its own commit. Run: node --experimental-strip-types test/cr-recon.test.mjs
//
// The recon (docs/plan/curriculum-runtime-recon.md) is what every later cr-* slice builds on,
// so a stale or invented line there sends a slice to a file or symbol that is not in the
// repository. That is the failure verification.md rule 1b and rule 7 record: a scope claim
// written from structure instead of from the code. This test makes the claims mechanical:
//
//   1. the ten PRD §13 Phase 0 areas are all mapped, each entry naming a path and a symbol
//      that exist here (entries outside the repository must use a pin the page declares,
//      and are checked only when a checkout is supplied: HPS_VSCODE_SRC, HPS_VSCODIUM_SRC,
//      HPS_LAB);
//   2. the gap matrix has exactly one row per CR requirement, a verdict of reuse / extend /
//      new, a path and symbol that exist, and an item that really cites the row in the ledger;
//   3. the decisions R1–R11 each state their decision;
//   4. the verification strategy has one row per cr-* item, every requirement the item
//      cites is targeted by a CR-T in its row, and every CR-T there targets one of them;
//   5. every later cr-* item has implementation notes; the interface proposal exists;
//   6. the plan no longer carries the provisional matrix and links here.
//
// The negative controls at the bottom plant one defect of each kind into a copy of the page
// and require exactly the planted problem back. A check that cannot fail is not a check.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const RECON_PATH = "docs/plan/curriculum-runtime-recon.md";
const REQ_PATH = "docs/requirements/curriculum-runtime.md";

const AREAS = 10;
const DECISIONS = 11;
const VERDICTS = new Set(["reuse", "extend", "new"]);

/** Text between `## <prefix>` and the next `## ` heading. */
function section(text, prefix) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${prefix}`));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const cells = (line) => line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
const ticked = (cell) => cell.match(/^`([^`]+)`$/)?.[1] ?? null;

/** CR-T ids in a cell, with ranges (`CR-T70–T74`) expanded. */
function testIds(cell) {
  const out = new Set();
  for (const m of cell.matchAll(/CR-T(\d+)(?:\s*[–-]\s*(?:CR-)?T?(\d+))?/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= b; n++) out.add(`CR-T${String(n).padStart(2, "0")}`);
  }
  return out;
}

/** Requirement IDs defined by the requirements document (its table rows). */
const requirementIds = (text) => new Set([...text.matchAll(/^\|\s*(CR-\d+)\s*\|/gm)].map((m) => m[1]));

/** CR-T → the CR IDs its Targets (last) cell names. */
function testTargets(text) {
  const out = new Map();
  for (const m of text.matchAll(/^\|\s*(CR-T\d+)\s*\|(.*)\|\s*$/gm)) {
    out.set(m[1], new Set(m[2].split("|").pop().match(/CR-\d+(?!\d)/g) ?? []));
  }
  return out;
}

/** cr-* item id → the CR IDs it cites. */
function ledgerItems(ledger) {
  const out = new Map();
  for (const it of ledger.work_items) {
    if (!it.id.startsWith("cr-")) continue;
    const ids = new Set(it.requirements.filter((r) => r.path === REQ_PATH).flatMap((r) => r.ids));
    out.set(it.id, ids);
  }
  return out;
}

/** Declared upstream pins from the page header (`vscodium@<sha>`, `vscode@<version>`). */
function declaredPins(text) {
  const head = text.split("\n## ")[0];
  return new Set([...head.matchAll(/`((?:vscodium|vscode)@[0-9A-Za-z.]+)`/g)].map((m) => m[1]));
}

function symbolPattern(symbol) {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pre = /^[A-Za-z0-9_$]/.test(symbol) ? "(?<![A-Za-z0-9_$])" : "";
  const post = /[A-Za-z0-9_$]$/.test(symbol) ? "(?![A-Za-z0-9_$])" : "";
  return new RegExp(pre + esc + post);
}

/**
 * The resolver for this checkout. Returns null when the path and symbol exist, a problem
 * string otherwise, or { external } when the entry is outside the repository and no
 * checkout was supplied for it.
 */
function makeResolver(pins, env = process.env) {
  return (path, symbol) => {
    const ext = path.match(/^((vscodium|vscode)@[0-9A-Za-z.]+|lab):(.+)$/);
    if (ext) {
      const [, pin, kind, rel] = ext;
      if (pin !== "lab" && !pins.has(pin)) return `external pin ${pin} is not declared in the page header`;
      let text = null;
      if (kind === "vscodium" && env.HPS_VSCODIUM_SRC) {
        try { text = execFileSync("git", ["-C", env.HPS_VSCODIUM_SRC, "show", `${pin.split("@")[1]}:${rel}`], { encoding: "utf8", maxBuffer: 1 << 26 }); }
        catch { return `${path}: not found in ${env.HPS_VSCODIUM_SRC}`; }
      } else if (kind === "vscode" && env.HPS_VSCODE_SRC) {
        const f = join(env.HPS_VSCODE_SRC, rel);
        if (!existsSync(f)) return `${path}: not found in ${env.HPS_VSCODE_SRC}`;
        text = readFileSync(f, "utf8");
      } else if (pin === "lab" && env.HPS_LAB) {
        const f = join(env.HPS_LAB, rel);
        if (!existsSync(f)) return `${path}: not found in ${env.HPS_LAB}`;
        text = readFileSync(f, "utf8");
      } else {
        return { external: path };
      }
      return symbolPattern(symbol).test(text) ? null : `${path}: symbol \`${symbol}\` not found`;
    }
    const f = join(ROOT, path);
    if (!existsSync(f)) return `${path}: path does not exist`;
    if (!statSync(f).isFile()) return `${path}: not a file, so no symbol can be checked`;
    return symbolPattern(symbol).test(readFileSync(f, "utf8")) ? null : `${path}: symbol \`${symbol}\` not found`;
  };
}

/** The whole CR-T01 check. Pure over its inputs; returns problems and the unchecked external entries. */
function checkRecon({ recon, plan, requirements, testing, ledger, resolve }) {
  const problems = [];
  const external = [];
  const resolveInto = (where, path, symbol) => {
    const r = resolve(path, symbol);
    if (r && typeof r === "object") external.push(r.external);
    else if (r) problems.push(`${where}: ${r}`);
  };
  const reqs = requirementIds(requirements);
  const items = ledgerItems(ledger);
  const targets = testTargets(testing);

  // 1. Architecture map.
  const map = section(recon, "1. Architecture map");
  if (!map) problems.push("map: no '## 1. Architecture map' section");
  else {
    const areas = new Map();
    let area = null;
    for (const line of map.split("\n")) {
      const h = line.match(/^### A(\d+) · /);
      if (h) { area = Number(h[1]); if (areas.has(area)) problems.push(`map: area A${area} appears twice`); areas.set(area, 0); continue; }
      const m = line.match(/^\|\s*(M\d+\.\d+)\s*\|/);
      if (!m) continue;
      const [id, pathCell, symbolCell] = cells(line);
      if (!area) { problems.push(`map ${id}: entry outside an area`); continue; }
      if (!id.startsWith(`M${area}.`)) problems.push(`map ${id}: filed under A${area}`);
      areas.set(area, areas.get(area) + 1);
      const path = ticked(pathCell), symbol = ticked(symbolCell);
      if (!path || !symbol) { problems.push(`map ${id}: path and symbol must each be one backticked value`); continue; }
      resolveInto(`map ${id}`, path, symbol);
    }
    for (let a = 1; a <= AREAS; a++) {
      if (!areas.has(a)) problems.push(`map: area A${a} is missing`);
      else if (areas.get(a) === 0) problems.push(`map: area A${a} has no entry`);
    }
    for (const a of areas.keys()) if (a < 1 || a > AREAS) problems.push(`map: unknown area A${a}`);
  }

  // 2. Decisions.
  const dec = section(recon, "2. Decisions");
  if (!dec) problems.push("decisions: no '## 2. Decisions' section");
  else {
    const blocks = dec.split(/\n(?=### R\d+ · )/);
    for (let r = 1; r <= DECISIONS; r++) {
      const block = blocks.find((b) => b.startsWith(`### R${r} · `));
      if (!block) problems.push(`decisions: R${r} is missing`);
      else if (!block.includes("**Decision.**")) problems.push(`decisions: R${r} states no decision`);
    }
  }

  // 3. Gap matrix.
  const gap = section(recon, "4. Gap matrix");
  if (!gap) problems.push("matrix: no '## 4. Gap matrix' section");
  else {
    const seen = new Map();
    for (const line of gap.split("\n")) {
      const m = line.match(/^\|\s*(CR-\d+)\s*\|/);
      if (!m) continue;
      const [cr, verdict, pathCell, symbolCell, itemCell] = cells(line);
      seen.set(cr, (seen.get(cr) ?? 0) + 1);
      if (!reqs.has(cr)) problems.push(`matrix ${cr}: not a requirement row`);
      if (!VERDICTS.has(verdict)) problems.push(`matrix ${cr}: verdict "${verdict}" is not reuse / extend / new`);
      const path = ticked(pathCell), symbol = ticked(symbolCell), item = ticked(itemCell ?? "");
      if (!path || !symbol) problems.push(`matrix ${cr}: path and symbol must each be one backticked value`);
      else resolveInto(`matrix ${cr}`, path, symbol);
      if (!item || !items.has(item)) problems.push(`matrix ${cr}: item ${itemCell} is not a cr-* work item`);
      else if (!items.get(item).has(cr)) problems.push(`matrix ${cr}: ${item} does not cite ${cr} in the ledger`);
    }
    for (const cr of reqs) if (!seen.has(cr)) problems.push(`matrix: ${cr} has no row`);
    for (const [cr, n] of seen) if (n > 1) problems.push(`matrix: ${cr} has ${n} rows`);
  }

  // 4. Verification strategy.
  const strat = section(recon, "5. Verification strategy per slice");
  if (!strat) problems.push("strategy: no '## 5. Verification strategy per slice' section");
  else {
    const rows = new Map();
    for (const line of strat.split("\n")) {
      const m = line.match(/^\|\s*`(cr-[a-z0-9-]+)`\s*\|/);
      if (!m) continue;
      if (rows.has(m[1])) problems.push(`strategy: ${m[1]} has two rows`);
      rows.set(m[1], testIds(cells(line).slice(1).join(" ")));
    }
    for (const [item, cited] of items) {
      const tests = rows.get(item);
      if (!tests) { problems.push(`strategy: ${item} has no row`); continue; }
      for (const t of tests) {
        const tg = targets.get(t);
        if (!tg) problems.push(`strategy ${item}: ${t} is not defined in the testing doc`);
        else if (![...tg].some((cr) => cited.has(cr))) problems.push(`strategy ${item}: ${t} targets none of the item's requirements`);
      }
      for (const cr of cited) {
        if (![...tests].some((t) => targets.get(t)?.has(cr))) problems.push(`strategy ${item}: ${cr} is not targeted by any CR-T in its row`);
      }
    }
    for (const item of rows.keys()) if (!items.has(item)) problems.push(`strategy: ${item} is not a cr-* work item`);
  }

  // 5. Interface proposal and per-slice notes.
  const iface = section(recon, "6. Interface proposal");
  if (!iface) problems.push("interface: no '## 6. Interface proposal' section");
  else {
    const named = new Set(iface.match(/CR-\d+(?!\d)/g) ?? []);
    for (const cr of named) if (!reqs.has(cr)) problems.push(`interface: names ${cr}, which is not a requirement row`);
    for (const item of ["cr-publish", "cr-evidence"]) {
      if (![...named].some((cr) => items.get(item)?.has(cr))) problems.push(`interface: names no requirement of ${item}`);
    }
  }
  const notes = section(recon, "7. Per-slice implementation notes");
  if (!notes) problems.push("notes: no '## 7. Per-slice implementation notes' section");
  else {
    for (const item of items.keys()) {
      if (item === "cr-recon") continue;
      if (!new RegExp(`^### \`${item}\`\\s*$`, "m").test(notes)) problems.push(`notes: ${item} has no subsection`);
    }
  }

  // 6. The plan points here instead of carrying the provisional matrix.
  if (/provisional, to be confirmed by `cr-recon`/.test(plan)) problems.push("plan: still carries the provisional gap matrix");
  if (!plan.includes("(curriculum-runtime-recon.md)")) problems.push("plan: does not link the recon");

  return { problems, external };
}

// ── Positive control: the committed page on its own commit ──────────────────
const recon = read(RECON_PATH);
const inputs = {
  recon,
  plan: read("docs/plan/curriculum-runtime.md"),
  requirements: read(REQ_PATH),
  testing: read("docs/testing/curriculum-runtime.md"),
  ledger: JSON.parse(read("config/requirement-work.json")),
  resolve: makeResolver(declaredPins(recon)),
};
// Empty inputs make every check pass vacuously.
assert.ok(requirementIds(inputs.requirements).size >= 84, "read fewer than 84 CR rows — the parser is broken");
assert.ok(testTargets(inputs.testing).size >= 80, "read fewer than 80 CR-T rows — the parser is broken");
assert.ok(ledgerItems(inputs.ledger).size >= 11, "read fewer than 11 cr-* items — the parser is broken");
assert.ok(declaredPins(recon).size >= 2, "the page header declares no upstream pins");
const real = checkRecon(inputs);
assert.deepEqual(real.problems, [], `CR-T01 on ${RECON_PATH}:\n  ${real.problems.join("\n  ")}`);

// ── Negative controls: each planted defect is reported, exactly once ─────────
{
  const run = (text, extra = {}) => checkRecon({ ...inputs, recon: text, ...extra }).problems;
  const plant = (from, to) => {
    assert.ok(recon.includes(from), `negative control anchor missing: ${from}`);
    return recon.replace(from, to);
  };
  const expectOne = (problems, needle, what) => {
    const hits = problems.filter((p) => p.includes(needle));
    assert.equal(hits.length, 1, `${what}: expected exactly one problem naming "${needle}", got:\n  ${problems.join("\n  ")}`);
    assert.equal(problems.length, 1, `${what}: the plant produced unrelated problems:\n  ${problems.join("\n  ")}`);
  };

  expectOne(run(plant("| M1.5 | `extensions/hypeproof-chat/src/cdpSession.ts`", "| M1.5 | `extensions/hypeproof-chat/src/cdpSessionGone.ts`")),
    "cdpSessionGone.ts: path does not exist", "non-existent map path");
  expectOne(run(plant("| M1.5 | `extensions/hypeproof-chat/src/cdpSession.ts` | `CdpSession` |", "| M1.5 | `extensions/hypeproof-chat/src/cdpSession.ts` | `CdpSessionPool` |")),
    "symbol `CdpSessionPool` not found", "non-existent map symbol");
  expectOne(run(recon.replace(/\n### A7 · [^\n]*\n[\s\S]*?(?=\n### A8 · )/, "\n")), "area A7 is missing", "missing area");
  expectOne(run(recon.replace(/^\| CR-47 \|[^\n]*\n/m, "")), "CR-47 has no row", "CR row absent from the matrix");
  expectOne(run(recon.replace(/^(\| CR-47 \|[^\n]*\n)/m, "$1$1")), "CR-47 has 2 rows", "duplicated CR row");
  expectOne(run(plant("| CR-59 | reuse |", "| CR-59 | maybe |")), "CR-59: verdict \"maybe\"", "invalid verdict");
  expectOne(run(plant("| CR-12 | new | `worker/src/lib/measurement-core/learning-events.ts` | `criterion_set` | `cr-verify` |",
    "| CR-12 | new | `worker/src/lib/measurement-core/learning-events.ts` | `criterion_set` | `cr-deck` |")),
    "cr-deck does not cite CR-12", "row owned by an item that does not cite it");
  expectOne(run(recon.replace("`vscode@1.116.0:src/vs/workbench/contrib/browserView/electron-browser/tools/browserTools.contribution.ts`",
    "`vscode@1.117.0:src/vs/workbench/contrib/browserView/electron-browser/tools/browserTools.contribution.ts`")),
    "external pin vscode@1.117.0 is not declared", "external entry with an undeclared pin");
  expectOne(run(recon.replace("### R6 · ", "### R6-dropped · ")), "R6 is missing", "missing decision");
  expectOne(run(recon.replace(/^\| `cr-skills` \|[^\n]*\n/m, "")), "cr-skills has no row", "item absent from the strategy");
  expectOne(run(recon.replace("| `cr-skills` | CR-T02, CR-T40–T44 |", "| `cr-skills` | CR-T02, CR-T40–T43 |")),
    "CR-47 is not targeted", "strategy row missing a requirement's test");
  expectOne(run(recon.replace("### `cr-deck`", "### `cr-deck-notes`")), "cr-deck has no subsection", "missing per-slice notes");
  expectOne(checkRecon({ ...inputs, plan: `${inputs.plan}\n## Gap matrix — provisional, to be confirmed by \`cr-recon\`\n` }).problems,
    "provisional gap matrix", "plan still carrying the provisional matrix");

  // The resolver itself: a real external checkout path must be able to fail too.
  const fake = makeResolver(new Set(["vscode@1.116.0"]), { HPS_VSCODE_SRC: ROOT });
  assert.match(String(fake("vscode@1.116.0:no/such/file.ts", "x")), /not found in/, "resolver accepted a missing external file");
  assert.equal(fake("worker/src/lib/tokens.ts", "verify"), null, "resolver refused a real path and symbol");
  assert.match(String(fake("worker/src/lib/tokens.ts", "verif")), /not found/, "resolver matched a symbol by prefix");
  assert.match(String(fake("worker/src/lib", "verify")), /not a file/, "resolver accepted a directory as a symbol source");
}

const entries = (recon.match(/^\| M\d+\.\d+ \|/gm) ?? []).length;
console.log(
  `cr-recon (CR-T01): OK — ${AREAS} areas · ${entries} map entries · ${requirementIds(inputs.requirements).size} matrix rows · ` +
    `${DECISIONS} decisions · 13 planted defects each caught · external not checked here: ${real.external.length}` +
    (real.external.length ? ` (${real.external.join(", ")})` : ""),
);
