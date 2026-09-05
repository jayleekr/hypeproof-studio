// Positive control for dag.yaml task F: deploying Chalk does NOT change the
// Service worker's version. "The whole point is that the two artifacts
// become independent. Prove it."
//
// Two layers of proof:
//   1. Static — the c* train cannot reach the Service. chalk/wrangler.toml
//      names a different Worker; deploy-chalk.yml deploys from chalk/ only,
//      injects HPS_CHALK_VERSION and never HPS_WORKER_VERSION; no other
//      workflow's tag trigger matches a c* tag; deploy-worker.yml knows
//      nothing of chalk. (deploy-chalk.yml additionally OBSERVES the live
//      Service version before and after every real deploy and fails if it
//      moved — this file pins that step exists.)
//   2. Runtime — each worker reports its own identifier from its own env;
//      Chalk's version has the same unset/empty → "unknown" contract as task C.
//
// Run: node --experimental-strip-types chalk/test/deploy-isolation.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootApp, createMockEnv, makeCtx } from "../../worker/test/harness/index.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const tomlValue = (toml, key) => {
  const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(toml);
  return m ? m[1] : null;
};

// --- 1a. two Workers, one KV, one D1 ------------------------------------------------
const chalkToml = read("chalk/wrangler.toml");
const workerToml = read("worker/wrangler.toml");
assert.equal(tomlValue(chalkToml, "name"), "hypeproof-chalk");
assert.equal(tomlValue(workerToml, "name"), "hypeproof-studio-api");
assert.notEqual(tomlValue(chalkToml, "name"), tomlValue(workerToml, "name"), "different Worker names → different artifacts");
assert.equal(tomlValue(chalkToml, "main"), "src/index.ts", "chalk deploys its own entry, relative to chalk/");
// Uncommented section header only — the toml's own comment mentions the word.
assert.ok(!/^\s*\[triggers\]/m.test(chalkToml), "chalk has no cron — the scheduler stays with the Service");
assert.ok(/^\s*\[triggers\]/m.test(workerToml), "sanity: the same regex does find the Service's cron block");
assert.ok(!/HPS_CHALK_VERSION\s*=/.test(chalkToml), "HPS_CHALK_VERSION is injected per-deploy, never static");
// Same bindings by id — acceptance "binds the same D1/KV".
const kvId = (t) => /binding = "HPS_KV"\s*\nid = "([0-9a-f]+)"/.exec(t)?.[1];
const d1Id = (t) => /database_id = "([0-9a-f-]+)"/.exec(t)?.[1];
assert.ok(kvId(chalkToml) && kvId(chalkToml) === kvId(workerToml), "HPS_KV is the same namespace on both");
assert.ok(d1Id(chalkToml) && d1Id(chalkToml) === d1Id(workerToml), "HPS_DB is the same database on both");
console.log("✓ deploy-isolation: separate Worker names, shared KV/D1 ids, no cron on chalk");

// --- 1b. the c* train touches chalk/ only --------------------------------------------
// Assertions run on the workflow with `#` comment lines removed — the
// header comments name the very things the invariants forbid.
const stripComments = (y) => y.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const chalkWf = stripComments(read(".github/workflows/deploy-chalk.yml"));
assert.match(chalkWf, /tags:\s*\n\s*-\s*"c\[0-9\]\*"/, "deploy-chalk.yml triggers on c<digit>… tags");
assert.ok(!chalkWf.includes("HPS_WORKER_VERSION"), "deploy-chalk.yml never injects the Service's version var");
// The command itself, not the dry-run step's "skipping wrangler deploy" echo.
const deploySteps = chalkWf.split(/\n\s*- name:/).filter((s) => /npx wrangler deploy\b/.test(s));
assert.equal(deploySteps.length, 1, "exactly one wrangler deploy step");
assert.match(deploySteps[0], /working-directory:\s*chalk\b/, "the deploy step runs in chalk/");
assert.match(deploySteps[0], /HPS_CHALK_VERSION/, "the deploy step injects HPS_CHALK_VERSION");
assert.match(chalkWf, /Service version unchanged/, "the workflow observes the live Service version before/after (task F positive control)");
assert.match(chalkWf, /\/v1\/health/, "…by reading GET /v1/health, task C's identifier");

const workerWf = stripComments(read(".github/workflows/deploy-worker.yml"));
assert.ok(!/chalk/i.test(workerWf), "deploy-worker.yml knows nothing of chalk");
assert.ok(!/^\s*tags:/m.test(workerWf), "deploy-worker.yml has no tag trigger at all (dispatch only) — a c* tag cannot start it");

// No other tag-triggered workflow can be started by a c* tag.
for (const wf of [".github/workflows/build-mac.yml", ".github/workflows/build-windows.yml"]) {
  const y = read(wf);
  const block = /tags:\s*\n((?:\s*-\s*"[^"]*"\s*\n)+)/.exec(y);
  assert.ok(block, `${wf} has a tags trigger block`);
  const patterns = [...block[1].matchAll(/-\s*"([^"]*)"/g)].map((m) => m[1]);
  for (const p of patterns) assert.match(p, /^v/, `${wf} tag pattern "${p}" must not match a c* tag`);
}
console.log("✓ deploy-isolation: c* tags start deploy-chalk only; no other train listens to them");

// --- 2. runtime: each worker reports its own identifier -----------------------------------
const service = await bootApp();
const { default: chalk } = await import("../src/index.ts");
const { resolveChalkVersion } = await import("../src/env.ts");

const sEnv = createMockEnv();
sEnv.HPS_WORKER_VERSION = "w2026.09.04-1";
const cEnv = { HPS_SIGNING_SECRET: sEnv.HPS_SIGNING_SECRET, ENVIRONMENT: "production", HPS_KV: sEnv.HPS_KV, HPS_DB: sEnv.HPS_DB, HPS_CHALK_VERSION: "c0.1.0" };

const s = await (await service.fetch(new Request("https://api.test/v1/health"), sEnv, makeCtx())).json();
const c = await (await chalk.fetch(new Request("https://chalk.test/health"), cEnv, makeCtx())).json();
assert.equal(s.version, "w2026.09.04-1");
assert.equal(s.service, "hypeproof-studio-api");
assert.equal(c.version, "c0.1.0");
assert.equal(c.service, "hypeproof-chalk");

assert.equal(resolveChalkVersion({ HPS_CHALK_VERSION: undefined }), "unknown");
assert.equal(resolveChalkVersion({ HPS_CHALK_VERSION: "" }), "unknown");
assert.equal(resolveChalkVersion({ HPS_CHALK_VERSION: "   " }), "unknown");
assert.equal(resolveChalkVersion({}), "unknown");
const unset = await (await chalk.fetch(new Request("https://chalk.test/health"), { ...cEnv, HPS_CHALK_VERSION: "" }, makeCtx())).json();
assert.equal(unset.version, "unknown", "empty var → 'unknown', never ''");
console.log("✓ deploy-isolation: w* and c* identifiers are independent; chalk's unset → 'unknown'");

console.log("All deploy-isolation tests passed.");
