// CR-T01 (doc check, CR-01): the Curriculum Runtime reconnaissance is complete and true
// on its own commit. Run: node --experimental-strip-types test/cr-recon.test.mjs
//
// The recon (docs/plan/curriculum-runtime-recon.md) is what every later cr-* slice builds on,
// so a stale or invented line there sends a slice to a file or symbol that is not in the
// repository. That is the failure verification.md rule 1b and rule 7 record: a scope claim
// written from structure instead of from the code. This test makes the claims mechanical:
//
//   1. the ten PRD §13 Phase 0 areas are all mapped, each area titled after its PRD item and
//      each entry naming a path and a symbol that exist, the symbol outside comments
//      (entries outside the repository must use a pin the page declares, and are checked only
//      when a checkout is supplied: HPS_VSCODE_SRC at the pinned version, HPS_VSCODIUM_SRC,
//      HPS_LAB);
//   2. the gap matrix has exactly one row per CR requirement, a verdict of reuse / extend /
//      new, a path and symbol that exist, and an item that really cites the row in the ledger;
//   3. the decisions R1–R11 each state a decision, not a placeholder;
//   4. the verification strategy has one row per cr-* item, every requirement the item
//      cites is targeted by a CR-T in its row, and every CR-T there targets one of them;
//   5. every later cr-* item has implementation notes; the interface proposal exists;
//   6. the plan no longer carries a provisional matrix and links here.
//
// "True on its own commit" decides which tree the verdict reads (CR-T01's wording is "at the
// map's commit"). Later slices rename symbols and edit the ledger; once cr-recon is recorded
// that must not turn CI red, because the recon is not rewritten per slice (the page says why).
// "Recorded state" = the page and the frozen control inputs (FROZEN_PATH) are byte-identical to
// the ones cr-recon's completion pins.
//   - live: no cr-recon completion yet, or not the recorded state. The page is being written
//     or re-verified, so the verdict reads this tree. Until the record lands on main this is
//     every run: a rename of a mapped symbol fails worker `npm test`, and so does an edit to
//     what FROZEN_PATH projects (CR rows, CR-T targets, cr-* cited IDs, PRD Phase 0), until the
//     fixture is regenerated (the page says so).
//   - commit: the recorded state, and the completion's commit is in this clone. The verdict
//     reads that commit through git, so a later rename or ledger edit cannot fail it.
//   - unresolved: the recorded state, and the commit is absent. CI is always here after the
//     record: `pr-ci.yml` checks out at depth 1. The verdict is not re-run; the pins hold the
//     page and the frozen inputs to what was verified.
// This tree's divergence from the map is printed as information in the last two modes.
//
// The negative controls at the bottom plant one defect of each kind into a copy of the page and
// require exactly the planted problem back. A check that cannot fail is not a check. They never
// read this tree beyond the page: the ledger, testing contract, requirements and PRD come from
// FROZEN_PATH (the projection of the verdict's inputs, which the verdict asserts while it runs;
// regenerate it with HPS_CR_RECON_FREEZE=1 in live mode, as the failure message says), and paths and
// symbols resolve against the page's own entries. The resolver itself is tested on a temp
// directory. So no later tree state can make a control pass or fail, in any mode.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RECON_PATH = "docs/plan/curriculum-runtime-recon.md";
const REQ_PATH = "docs/requirements/curriculum-runtime.md";
const PLAN_PATH = "docs/plan/curriculum-runtime.md";
const TESTING_PATH = "docs/testing/curriculum-runtime.md";
const LEDGER_PATH = "config/requirement-work.json";
const PRD_PATH = "docs/design/curriculum-runtime-prd-v1.0-2026-09-28.md";
const FROZEN_PATH = "worker/test/fixtures/cr-recon/frozen-inputs.json";
const RECON_ITEM = "cr-recon";

const AREAS = 10;
const DECISIONS = 11;
const MIN_DECISION_WORDS = 12;
const VERDICTS = new Set(["reuse", "extend", "new"]);
// A decision paragraph that defers the decision. Plain "later" is not in it: "later exposable"
// describes a consequence, not a deferral. These phrasings are what it catches; a deferral worded
// otherwise passes, and the reviewer's reading is what stands behind it.
const PLACEHOLDER = new RegExp(
  [
    String.raw`\b(TBD|TBC|TODO|FIXME|undecided|unresolved)\b`,
    String.raw`\bto be (decided|determined|confirmed|agreed|defined|settled)\b`,
    String.raw`\b(decide|decided|determine|determined|settle|settled) later\b`,
    String.raw`\bnot (yet )?(decided|determined|settled)\b`,
    String.raw`\bopen question\b`,
    String.raw`\bpending\b`,
    String.raw`\bdefer(s|red|ring|ral)?\b`,
    String.raw`\brevisit(s|ed|ing)?\b`,
    String.raw`\bleft open\b`,
    // "`cr-browser` decides …", "the slice picks …": the choice handed to an item.
    String.raw`(\bcr-[a-z]+\x60?|\b(slice|item))\s+(decides|chooses|picks)\b`,
  ].join("|"),
  "i",
);

// ── Where the inputs are read ────────────────────────────────────────────────
const git = (args) =>
  execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 });

const cached = (map, key, fn) => (map.has(key) ? map.get(key) : (map.set(key, fn()), map.get(key)));

/** A cached, read-only view of a directory's working tree (this repository, or a temp fixture). */
function treeSource(root, where = "this tree") {
  const texts = new Map();
  const kinds = new Map();
  return {
    where,
    read: (p) => cached(texts, p, () => readFileSync(join(root, p), "utf8")),
    kind: (p) => cached(kinds, p, () => {
      const f = join(root, p);
      return existsSync(f) ? (statSync(f).isFile() ? "file" : "dir") : null;
    }),
  };
}

/** A cached, read-only view of one commit of this repository, through git. */
function commitSource(commit) {
  const texts = new Map();
  const kinds = new Map();
  return {
    where: `commit ${commit.slice(0, 12)}`,
    read: (p) => cached(texts, p, () => git(["show", `${commit}:${p}`])),
    kind: (p) => cached(kinds, p, () => {
      try {
        const t = git(["cat-file", "-t", `${commit}:${p}`]).trim();
        return t === "blob" ? "file" : t === "tree" ? "dir" : null;
      } catch {
        return null;
      }
    }),
  };
}

/** An in-memory source: exactly the files given, nothing else exists. */
function memorySource(files, where) {
  return { where, read: (p) => files.get(p), kind: (p) => (files.has(p) ? "file" : null) };
}

/**
 * Which tree holds the map's truth (see the header). `pinned` maps each file of the recorded
 * state (the page, the frozen control inputs) to its bytes in this tree.
 */
function chooseSource(ledger, pinned) {
  const done = ledger.work_items.find((i) => i.id === RECON_ITEM)?.completion;
  if (!done) return { mode: "live", why: "cr-recon has no completion yet" };
  for (const [p, bytes] of Object.entries(pinned)) {
    const now = createHash("sha256").update(bytes).digest("hex");
    if (done.inputs?.[p] !== now) return { mode: "live", why: `${p} differs from the one cr-recon's completion pins` };
  }
  const commit = String(done.commit ?? "");
  if (!/^[0-9a-f]{40}$/.test(commit)) return { mode: "unresolved", why: "cr-recon's completion names no full commit" };
  try {
    git(["cat-file", "-e", `${commit}^{commit}`]);
  } catch {
    return { mode: "unresolved", commit, why: `this clone lacks ${commit.slice(0, 12)}, where cr-recon was recorded (shallow checkout)` };
  }
  return { mode: "commit", commit, why: `the page and frozen inputs are the ones cr-recon recorded at ${commit.slice(0, 12)}` };
}

// ── Parsers ──────────────────────────────────────────────────────────────────
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

/** The numbered list under the PRD's "## Phase 0" heading. */
function phaseZero(prd) {
  const lines = prd.split("\n");
  const start = lines.findIndex((l) => /^## Phase 0\b/.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && !/^#{1,2} /.test(lines[i]); i++) {
    const m = lines[i].match(/^\d+\.\s+(.+)$/);
    if (m) out.push(m[1]);
  }
  return out;
}

const STOP = new Set(["a", "an", "and", "or", "the", "of", "from", "to", "in", "for", "with", "existing", "current"]);
const words = (s) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).map((w) => w.replace(/s$/, "")));
const overlap = (a, b) => [...a].filter((w) => b.has(w)).length;

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
 * The file text a symbol must appear in, without comments: a word that only a comment
 * mentions is not a symbol of the file. JS/TS line and block comments (string- and
 * escape-aware) and SQL `--` comments; other files are taken as they are.
 */
function withoutComments(text, path) {
  const ext = extname(path);
  if (ext === ".sql") return text.replace(/--[^\n]*/g, "");
  if (![".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(ext)) return text;
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\\") { out += ch + (next ?? ""); i++; continue; }
    if (quote) { out += ch; if (ch === quote) quote = null; continue; }
    if (ch === "/" && next === "/") { while (i + 1 < text.length && text[i + 1] !== "\n") i++; continue; }
    if (ch === "/" && next === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 1; out += " "; continue; }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    out += ch;
  }
  return out;
}

/**
 * The resolver for one source. Returns null when the path and symbol exist, a problem
 * string otherwise, or { external } when the entry is outside the repository and no
 * checkout was supplied for it.
 */
function makeResolver(pins, src, env = process.env) {
  // A VS Code checkout is read at its git HEAD when it is one: a prepared build tree has its
  // working-tree package.json rewritten to the product version and the fork's patches applied.
  let vscode;
  const vscodeAt = (dir) => {
    const opts = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 };
    try {
      const version = JSON.parse(execFileSync("git", ["-C", dir, "show", "HEAD:./package.json"], opts)).version;
      return { version, read: (rel) => { try { return execFileSync("git", ["-C", dir, "show", `HEAD:./${rel}`], opts); } catch { return null; } } };
    } catch { /* not a git checkout: read the files */ }
    let version = "unreadable";
    try { version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? "unknown"; } catch { /* stays unreadable */ }
    return { version, read: (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null) };
  };
  return (path, symbol) => {
    const ext = path.match(/^((vscodium|vscode)@[0-9A-Za-z.]+|lab):(.+)$/);
    const has = (text, where) => (symbolPattern(symbol).test(withoutComments(text, where)) ? null : `${path}: symbol \`${symbol}\` not found`);
    if (ext) {
      const [, pin, kind, rel] = ext;
      if (pin !== "lab" && !pins.has(pin)) return `external pin ${pin} is not declared in the page header`;
      if (kind === "vscodium" && env.HPS_VSCODIUM_SRC) {
        let text;
        try { text = execFileSync("git", ["-C", env.HPS_VSCODIUM_SRC, "show", `${pin.split("@")[1]}:${rel}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 }); }
        catch { return `${path}: not found in ${env.HPS_VSCODIUM_SRC}`; }
        return has(text, rel);
      }
      if (kind === "vscode" && env.HPS_VSCODE_SRC) {
        vscode ??= vscodeAt(env.HPS_VSCODE_SRC);
        const want = pin.split("@")[1];
        if (vscode.version !== want) return `HPS_VSCODE_SRC is vscode ${vscode.version}, not the pinned ${want}`;
        const text = vscode.read(rel);
        if (text === null) return `${path}: not found in ${env.HPS_VSCODE_SRC}`;
        return has(text, rel);
      }
      if (pin === "lab" && env.HPS_LAB) {
        const f = join(env.HPS_LAB, rel);
        if (!existsSync(f)) return `${path}: not found in ${env.HPS_LAB}`;
        return has(readFileSync(f, "utf8"), rel);
      }
      return { external: path };
    }
    const kind = src.kind(path);
    if (!kind) return `${path}: path does not exist`;
    if (kind !== "file") return `${path}: not a file, so no symbol can be checked`;
    return has(src.read(path), path);
  };
}

/** Every input of the check, read from one source. */
function inputsFrom(src) {
  const recon = src.read(RECON_PATH);
  return {
    recon,
    plan: src.read(PLAN_PATH),
    requirements: src.read(REQ_PATH),
    testing: src.read(TESTING_PATH),
    ledger: JSON.parse(src.read(LEDGER_PATH)),
    prd: src.read(PRD_PATH),
    resolve: makeResolver(declaredPins(recon), src),
  };
}

// ── Frozen control inputs ────────────────────────────────────────────────────
const byId = (a, b) => a.localeCompare(b, "en", { numeric: true });

/** What checkRecon reads from everything but the page, as data (FROZEN_PATH holds this). */
function freeze(inp) {
  const ids = (s) => [...s].sort(byId);
  return {
    about: `CR-T01 negative-control inputs: the projection of ${REQ_PATH}, ${TESTING_PATH}, ${LEDGER_PATH} and ${PRD_PATH} that worker/test/cr-recon.test.mjs reads. Generated; regenerate with HPS_CR_RECON_FREEZE=1 while the recon page is being written.`,
    requirements: ids(requirementIds(inp.requirements)),
    tests: Object.fromEntries([...testTargets(inp.testing)].sort(([a], [b]) => byId(a, b)).map(([t, s]) => [t, ids(s)])),
    items: Object.fromEntries([...ledgerItems(inp.ledger)].map(([i, s]) => [i, ids(s)])),
    phase0: phaseZero(inp.prd),
  };
}

/** Every in-repository [path, symbol] pair the page's map and matrix name. */
function pageEntries(recon) {
  const out = [];
  for (const name of ["1. Architecture map", "4. Gap matrix"]) {
    for (const line of (section(recon, name) ?? "").split("\n")) {
      if (!/^\|\s*(M\d+\.\d+|CR-\d+)\s*\|/.test(line)) continue;
      const c = cells(line);
      const [path, symbol] = name.startsWith("1.") ? [ticked(c[1]), ticked(c[2])] : [ticked(c[2]), ticked(c[3])];
      if (path && symbol && !/^((vscodium|vscode)@[0-9A-Za-z.]+|lab):/.test(path)) out.push([path, symbol]);
    }
  }
  return out;
}

/**
 * The control world: the page itself, the frozen projection rendered back into the shapes the
 * parsers read, and a source in which exactly the page's own entries exist. A plant is then the
 * only thing that can be wrong, whatever this tree looks like.
 */
function frozenInputs(recon, frozen) {
  const files = new Map();
  for (const [path, symbol] of pageEntries(recon)) files.set(path, `${files.get(path) ?? ""}${symbol}\n`);
  return {
    recon,
    plan: "The reconnaissance is [curriculum-runtime-recon.md](curriculum-runtime-recon.md).\n",
    requirements: frozen.requirements.map((id) => `| ${id} | frozen |`).join("\n") + "\n",
    testing: Object.entries(frozen.tests).map(([t, crs]) => `| ${t} | frozen | ${crs.join(", ")} |`).join("\n") + "\n",
    ledger: { work_items: Object.entries(frozen.items).map(([id, ids]) => ({ id, requirements: [{ path: REQ_PATH, ids }] })) },
    prd: `## Phase 0 — frozen\n\n${frozen.phase0.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`,
    resolve: makeResolver(declaredPins(recon), memorySource(files, "the page's own entries"), {}),
  };
}

// ── The check ────────────────────────────────────────────────────────────────
/** The whole CR-T01 check. Pure over its inputs; returns problems and the unchecked external entries. */
function checkRecon({ recon, plan, requirements, testing, ledger, prd, resolve }) {
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
  const phase0 = phaseZero(prd).map(words);
  if (phase0.length !== AREAS) problems.push(`prd: ${PRD_PATH} lists ${phase0.length} Phase 0 items, not ${AREAS}`);

  // 1. Architecture map.
  const map = section(recon, "1. Architecture map");
  if (!map) problems.push("map: no '## 1. Architecture map' section");
  else {
    const areas = new Map();
    let area = null;
    for (const line of map.split("\n")) {
      const h = line.match(/^### A(\d+) · (.*)$/);
      if (h) {
        area = Number(h[1]);
        if (areas.has(area)) problems.push(`map: area A${area} appears twice`);
        areas.set(area, 0);
        if (phase0.length === AREAS && area >= 1 && area <= AREAS) {
          const title = words(h[2]);
          const own = overlap(title, phase0[area - 1]);
          const rival = Math.max(...phase0.map((p, i) => (i === area - 1 ? 0 : overlap(title, p))));
          if (own < 2 || own <= rival) problems.push(`map: A${area} title "${h[2]}" does not name PRD Phase 0 item ${area}`);
        }
        continue;
      }
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

  // 2. Decisions: each states one, in a sentence, not a placeholder.
  const dec = section(recon, "2. Decisions");
  if (!dec) problems.push("decisions: no '## 2. Decisions' section");
  else {
    const blocks = dec.split(/\n(?=### R\d+ · )/);
    for (let r = 1; r <= DECISIONS; r++) {
      const block = blocks.find((b) => b.startsWith(`### R${r} · `));
      if (!block) { problems.push(`decisions: R${r} is missing`); continue; }
      const stated = block.match(/\*\*Decision\.\*\*([^\n]*(?:\n(?!\n)[^\n]*)*)/)?.[1] ?? "";
      const n = stated.trim().split(/\s+/).filter(Boolean).length;
      if (n < MIN_DECISION_WORDS || PLACEHOLDER.test(stated)) problems.push(`decisions: R${r} states no decision`);
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

  // 6. The plan points here instead of carrying a provisional matrix, under any heading.
  const provisional = plan.split("\n").some((l) => /^#{1,6} /.test(l) && /gap matrix/i.test(l) && /provisional/i.test(l));
  if (provisional || /provisional, to be confirmed by `cr-recon`/.test(plan)) problems.push("plan: still carries the provisional gap matrix");
  if (!plan.includes("(curriculum-runtime-recon.md)")) problems.push("plan: does not link the recon");

  return { problems, external };
}

// ── Positive control: the page on the map's commit ───────────────────────────
const live = treeSource(ROOT);
const pageBytes = readFileSync(join(ROOT, RECON_PATH));
let frozenBytes = Buffer.alloc(0);
try { frozenBytes = readFileSync(join(ROOT, FROZEN_PATH)); } catch { /* missing: never the recorded state */ }
const chosen = chooseSource(JSON.parse(live.read(LEDGER_PATH)), { [RECON_PATH]: pageBytes, [FROZEN_PATH]: frozenBytes });
const sane = (inp) => {
  // Empty inputs make every check pass vacuously.
  assert.ok(requirementIds(inp.requirements).size >= 84, "read fewer than 84 CR rows — the parser is broken");
  assert.ok(testTargets(inp.testing).size >= 80, "read fewer than 80 CR-T rows — the parser is broken");
  assert.ok(ledgerItems(inp.ledger).size >= 11, "read fewer than 11 cr-* items — the parser is broken");
  assert.ok(declaredPins(inp.recon).size >= 2, "the page header declares no upstream pins");
  assert.equal(phaseZero(inp.prd).length, AREAS, "the PRD Phase 0 list did not parse");
};
let real = null;
if (chosen.mode !== "unresolved") {
  const src = chosen.mode === "live" ? live : commitSource(chosen.commit);
  const inp = inputsFrom(src);
  sane(inp);
  real = checkRecon(inp);
  assert.deepEqual(real.problems, [], `CR-T01 on ${RECON_PATH} (${src.where}):\n  ${real.problems.join("\n  ")}`);
  // The controls' frozen inputs are these inputs, projected.
  const want = `${JSON.stringify(freeze(inp), null, 2)}\n`;
  let have = null;
  try { have = src.read(FROZEN_PATH); } catch { /* missing: stale */ }
  if (have !== want) {
    if (chosen.mode === "live" && process.env.HPS_CR_RECON_FREEZE === "1") {
      mkdirSync(join(ROOT, FROZEN_PATH, ".."), { recursive: true });
      writeFileSync(join(ROOT, FROZEN_PATH), want);
      console.log(`wrote ${FROZEN_PATH} from ${src.where}`);
    } else {
      const what = have === null
        ? "is missing"
        : `is not the projection of the verdict's inputs: since it was generated, a CR row of ${REQ_PATH}, a CR-T's ` +
          `Targets cell in ${TESTING_PATH}, a cr-* item's cited CR IDs in ${LEDGER_PATH} or the PRD Phase 0 list changed`;
      assert.fail(`${FROZEN_PATH} ${what} (${src.where}; ${chosen.why}). The verdict passes on this tree, so regenerate ` +
        "the fixture: run this test from worker/ with HPS_CR_RECON_FREEZE=1 and commit the fixture with the change. Before " +
        "cr-recon's record lands, that is all an unrelated PR needs (or it waits for the record; recon header). After the " +
        "record, reaching this line means the page or the fixture was edited, which reopens cr-recon: re-verify and re-record it too");
    }
  }
}

// ── Negative controls: each planted defect is reported, exactly once ─────────
// The control world is the page plus the frozen inputs, never this tree's ledger, testing
// contract or files (header). It must be clean before anything is planted.
const page = pageBytes.toString("utf8");
const ctl = frozenInputs(page, JSON.parse(readFileSync(join(ROOT, FROZEN_PATH), "utf8")));
sane(ctl);
assert.deepEqual(checkRecon(ctl).problems, [], "the page on its frozen inputs must be clean before anything is planted");
let controls = 0;
{
  const run = (text, extra = {}) => checkRecon({ ...ctl, recon: text, ...extra }).problems;
  const plant = (from, to) => {
    assert.ok(page.includes(from), `negative control anchor missing: ${from}`);
    return page.replace(from, to);
  };
  const expectOne = (problems, needle, what) => {
    const hits = problems.filter((p) => p.includes(needle));
    assert.equal(hits.length, 1, `${what}: expected exactly one problem naming "${needle}", got:\n  ${problems.join("\n  ")}`);
    assert.equal(problems.length, 1, `${what}: the plant produced unrelated problems:\n  ${problems.join("\n  ")}`);
    controls++;
  };
  const decision = (r, text) => {
    const out = page.replace(new RegExp(`(### R${r} · [^\\n]*\\n\\n\\*\\*Decision\\.\\*\\*)[^\\n]*`), `$1 ${text}`);
    assert.notEqual(out, page, `negative control anchor missing: R${r}'s decision paragraph`);
    return out;
  };

  expectOne(run(plant("| M1.5 | `extensions/hypeproof-chat/src/cdpSession.ts`", "| M1.5 | `extensions/hypeproof-chat/src/cdpSessionGone.ts`")),
    "cdpSessionGone.ts: path does not exist", "non-existent map path");
  expectOne(run(plant("| M1.5 | `extensions/hypeproof-chat/src/cdpSession.ts` | `CdpSession` |", "| M1.5 | `extensions/hypeproof-chat/src/cdpSession.ts` | `CdpSessionPool` |")),
    "symbol `CdpSessionPool` not found", "non-existent map symbol");
  expectOne(run(page.replace(/\n### A7 · [^\n]*\n[\s\S]*?(?=\n### A8 · )/, "\n")), "area A7 is missing", "missing area");
  expectOne(run(page.replace(/^### A9 · [^\n]*$/m, "### A9 · x")), "A9 title \"x\" does not name PRD Phase 0 item 9", "area retitled away from its PRD item");
  expectOne(run(page.replace(/^\| CR-47 \|[^\n]*\n/m, "")), "CR-47 has no row", "CR row absent from the matrix");
  expectOne(run(page.replace(/^(\| CR-47 \|[^\n]*\n)/m, "$1$1")), "CR-47 has 2 rows", "duplicated CR row");
  expectOne(run(plant("| CR-59 | reuse |", "| CR-59 | maybe |")), "CR-59: verdict \"maybe\"", "invalid verdict");
  expectOne(run(plant("| CR-12 | new | `worker/src/lib/measurement-core/learning-events.ts` | `criterion_set` | `cr-verify` |",
    "| CR-12 | new | `worker/src/lib/measurement-core/learning-events.ts` | `criterion_set` | `cr-deck` |")),
    "cr-deck does not cite CR-12", "row owned by an item that does not cite it");
  expectOne(run(plant("`vscode@1.116.0:src/vs/workbench/contrib/browserView/electron-browser/tools/browserTools.contribution.ts`",
    "`vscode@1.117.0:src/vs/workbench/contrib/browserView/electron-browser/tools/browserTools.contribution.ts`")),
    "external pin vscode@1.117.0 is not declared", "external entry with an undeclared pin");
  expectOne(run(plant("### R6 · ", "### R6-dropped · ")), "R6 is missing", "missing decision");
  expectOne(run(decision(3, "TBD.")), "R3 states no decision", "placeholder decision");
  expectOne(run(decision(3, "To be determined after cr-browser measures the options in its own tree first.")),
    "R3 states no decision", "a deferral long enough to pass the word count");
  expectOne(run(decision(5, "Storage stays undecided until the director has seen how the first cohort uses the product.")),
    "R5 states no decision", "a decision left undecided in other words");
  expectOne(run(decision(1, "Deferred to cr-browser, which picks between the CDP path and the upstream tools after measuring both.")),
    "R1 states no decision", "a decision deferred to a later item");
  expectOne(run(decision(1, "`cr-browser` decides between the CDP path and the upstream tools once it has measured both in its own tree.")),
    "R1 states no decision", "the choice handed to a later item");
  expectOne(run(page.replace(/^\| `cr-skills` \|[^\n]*\n/m, "")), "cr-skills has no row", "item absent from the strategy");
  expectOne(run(plant("| `cr-skills` | CR-T02, CR-T40–T44 |", "| `cr-skills` | CR-T02, CR-T40–T43 |")),
    "CR-47 is not targeted", "strategy row missing a requirement's test");
  expectOne(run(plant("### `cr-deck`", "### `cr-deck-notes`")), "cr-deck has no subsection", "missing per-slice notes");
  expectOne(run(page, { plan: `${ctl.plan}\n## Gap matrix — provisional, to be confirmed by \`cr-recon\`\n` }),
    "provisional gap matrix", "plan still carrying the provisional matrix");
  expectOne(run(page, { plan: `${ctl.plan}\n## Gap matrix (provisional)\n| PRD item | x |\n` }),
    "provisional gap matrix", "plan carrying a provisional matrix under another heading");
}

// The resolver itself, on a temp directory rather than on this repository's files, so that no
// later edit to a mapped file can fail it: every refusal it must make, and the acceptances.
{
  const tmp = mkdtempSync(join(tmpdir(), "cr-recon-resolver-"));
  try {
    const repo = join(tmp, "repo"), vscodeOk = join(tmp, "vscode-pinned"), vscodeOther = join(tmp, "vscode-other");
    for (const d of [join(repo, "lib"), vscodeOk, vscodeOther]) mkdirSync(d, { recursive: true });
    writeFileSync(join(repo, "lib/tokens.ts"), [
      "// spike only in a line comment",
      "/* spikeBlock only in a block comment */",
      "export async function verify(token: string) { return 'a // stringTail'; }",
      "const label = \"spikeString\";",
      "",
    ].join("\n"));
    writeFileSync(join(repo, "schema.sql"), "-- sqlOnlyInComment\nCREATE TABLE usage_log (id INTEGER);\n");
    writeFileSync(join(vscodeOk, "package.json"), JSON.stringify({ version: "1.116.0" }));
    writeFileSync(join(vscodeOther, "package.json"), JSON.stringify({ version: "9.9.9" }));
    const pins = new Set(["vscode@1.116.0"]);
    const r = makeResolver(pins, treeSource(repo, "temp repo"), { HPS_VSCODE_SRC: vscodeOk });
    const cases = [
      [r("lib/tokens.ts", "verify"), null, "resolver refused a real path and symbol"],
      [r("lib/tokens.ts", "spikeString"), null, "resolver refused a symbol inside a string literal"],
      [r("schema.sql", "usage_log"), null, "resolver refused a SQL identifier"],
      [r("lib/tokens.ts", "verif"), /symbol `verif` not found/, "resolver matched a symbol by prefix"],
      [r("lib/tokens.ts", "spike"), /symbol `spike` not found/, "resolver accepted a word only a line comment mentions"],
      [r("lib/tokens.ts", "spikeBlock"), /symbol `spikeBlock` not found/, "resolver accepted a word only a block comment mentions"],
      [r("schema.sql", "sqlOnlyInComment"), /not found/, "resolver accepted a word only a SQL comment mentions"],
      [r("lib/gone.ts", "verify"), /path does not exist/, "resolver accepted a missing path"],
      [r("lib", "verify"), /not a file/, "resolver accepted a directory as a symbol source"],
      [r("vscode@1.116.0:no/such/file.ts", "x"), /not found in/, "resolver accepted a missing external file"],
      [r("vscode@1.117.0:lib/tokens.ts", "verify"), /external pin vscode@1\.117\.0 is not declared/, "resolver accepted an undeclared pin"],
      [makeResolver(pins, treeSource(repo, "temp repo"), { HPS_VSCODE_SRC: vscodeOther })("vscode@1.116.0:lib/tokens.ts", "verify"),
        /HPS_VSCODE_SRC is vscode 9\.9\.9, not the pinned 1\.116\.0/, "resolver accepted a VS Code checkout at another version"],
      [JSON.stringify(makeResolver(pins, treeSource(repo, "temp repo"), {})("vscode@1.116.0:lib/tokens.ts", "verify")),
        /"external"/, "resolver claimed to check an external entry with no checkout supplied"],
    ];
    for (const [got, want, what] of cases) {
      if (want === null) assert.equal(got, null, `${what}: ${got}`);
      else assert.match(String(got), want, what);
      controls++;
    }
    assert.equal(withoutComments("const a = 'x // y'; // spike\n/* spike */ b", "f.ts"), "const a = 'x // y'; \n  b", "comment stripping mangled code or strings");
    controls++;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const entries = (page.match(/^\| M\d+\.\d+ \|/gm) ?? []).length;
const verdict = chosen.mode === "unresolved"
  ? `verdict NOT RE-RUN (${chosen.why}); the page and the frozen inputs are the recorded ones`
  : `verdict read at ${chosen.mode === "live" ? "this tree" : `commit ${chosen.commit.slice(0, 12)}`} (${chosen.why})`;
const ext = real?.external ?? [];
console.log(
  `cr-recon (CR-T01): OK — ${verdict} · ${AREAS} areas · ${entries} map entries · ${requirementIds(ctl.requirements).size} matrix rows · ` +
    `${DECISIONS} decisions · ${controls} negative controls each caught, on the frozen inputs and a temp directory` +
    (real ? ` · external not checked here: ${ext.length}` + (ext.length ? ` (${ext.join(", ")})` : "") : ""),
);
if (chosen.mode !== "live") {
  // Information only: nothing below can fail the test.
  let info;
  try {
    const now = checkRecon(inputsFrom(live)).problems;
    info = now.length
      ? `INFO  this tree differs from the recorded map in ${now.length} place(s); record them as deviations in ${PLAN_PATH}, not by editing the recon:\n  ${now.join("\n  ")}`
      : "INFO  this tree still matches the recorded map";
  } catch (err) {
    info = `INFO  this tree could not be compared with the recorded map: ${err instanceof Error ? err.message : String(err)}`;
  }
  console.log(info);
}
