// In-process smoke for the issuer mint-lineage query (#313).
// Verifies GET /admin/issuers?minted_by=<u> answers "which instructor issuers
// did minter X create?" — the ops tool that makes a minter revoke actionable.
// Same code path deployed to prod; only HPS_SIGNING_SECRET differs. Invokes
// worker.fetch() directly, no wrangler.
//
// Run: node --experimental-strip-types worker/test/issuer-lineage.test.mjs

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Mirror wrangler's [[rules]] type="Text" + extensionless relative imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(ts|js|mjs|cjs|json|html|md)$/.test(specifier)
    ) {
      const base = new URL(specifier, context.parentURL);
      for (const candidate of [".ts", "/index.ts"]) {
        const tryUrl = new URL(base.href + candidate);
        try {
          statSync(fileURLToPath(tryUrl));
          return nextResolve(specifier + candidate, context);
        } catch { /* try next */ }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".html") || url.endsWith(".md")) {
      const text = readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(text)};`,
      };
    }
    return nextLoad(url, context);
  },
});

const SECRET = "test-secret-" + "x".repeat(20);
const { default: worker } = await import("../src/index.ts");

// In-memory KV mock with cursor-less list (list_complete always true) — enough
// for the audit-prefix scan listIssuerAudits performs.
function makeKV() {
  const store = new Map();
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      const keys = [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

const env = {
  HPS_SIGNING_SECRET: SECRET,
  HPS_ADMIN_PASSWORD: "test-admin-pw",
  HPS_KV: makeKV(),
  ENVIRONMENT: "test",
  LLM_PROVIDER: "anthropic",
};

const ADMIN = "Basic " + Buffer.from("admin:test-admin-pw").toString("base64");
const COHORT = "boah-dental-2026-a";
const PROFILE = "boah-dental-teaser-2026-s1";

async function fetchOnce(path, { method = "GET", headers = {}, body } = {}) {
  const req = new Request("https://x" + path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const res = await worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`✅ ${label}`);
  } catch (err) {
    results.push({ label, ok: false, err: String(err) });
    console.log(`❌ ${label}\n   ${err}`);
  }
}

// --- fixtures: build a minter → instructor lineage via the real POST path ----

// 1. Admin mints instructor "alice" (minted_by = "admin").
let aliceJti;
await check("setup: admin mints instructor alice", async () => {
  const { status, json, text } = await fetchOnce("/admin/issuers", {
    method: "POST",
    headers: { authorization: ADMIN },
    body: { instructor: "alice", scopes: [{ cohort: COHORT, profiles: [PROFILE], max_hours: 24 }] },
  });
  assert.equal(status, 200, `got ${status}: ${text}`);
  assert.equal(json.minted_by, "admin");
  aliceJti = json.jti;
});

// 2. Admin mints an ADMIN-TIER MINTER "bob" (can_issue_issuers, minted_by=admin).
let bobToken;
await check("setup: admin mints minter bob (can_issue_issuers)", async () => {
  const { status, json, text } = await fetchOnce("/admin/issuers", {
    method: "POST",
    headers: { authorization: ADMIN },
    body: {
      instructor: "bob",
      can_issue_issuers: true,
      scopes: [{ cohort: COHORT, profiles: [PROFILE], max_hours: 168 }],
    },
  });
  assert.equal(status, 200, `got ${status}: ${text}`);
  assert.equal(json.can_issue_issuers, true);
  bobToken = json.token;
});

// 3. Bob (Bearer) mints instructor "carol" within his scope (minted_by = "bob").
let carolJti;
await check("setup: minter bob mints instructor carol via Bearer", async () => {
  const { status, json, text } = await fetchOnce("/admin/issuers", {
    method: "POST",
    headers: { authorization: `Bearer ${bobToken}` },
    body: { instructor: "carol", scopes: [{ cohort: COHORT, profiles: [PROFILE], max_hours: 24 }] },
  });
  assert.equal(status, 200, `got ${status}: ${text}`);
  assert.equal(json.minted_by, "bob");
  carolJti = json.jti;
});

// --- the #313 lineage query -------------------------------------------------

await check("GET /admin/issuers (admin) lists the full trail", async () => {
  const { status, json, text } = await fetchOnce("/admin/issuers", {
    headers: { authorization: ADMIN },
  });
  assert.equal(status, 200, `got ${status}: ${text}`);
  assert.equal(json.count, 3, `expected 3 audits, got ${json.count}`);
  const byInstructor = Object.fromEntries(json.issuers.map((i) => [i.instructor, i]));
  assert.ok(byInstructor.alice && byInstructor.bob && byInstructor.carol);
  assert.equal(byInstructor.bob.can_issue_issuers, true);
  // Each row carries the lineage + revocation columns an operator acts on.
  assert.deepEqual(byInstructor.carol.cohorts, [COHORT]);
  assert.equal(byInstructor.carol.revoked, null);
});

await check("GET ?minted_by=bob returns only bob's lineage (carol)", async () => {
  const { status, json, text } = await fetchOnce("/admin/issuers?minted_by=bob", {
    headers: { authorization: ADMIN },
  });
  assert.equal(status, 200, `got ${status}: ${text}`);
  assert.equal(json.minted_by, "bob");
  assert.equal(json.count, 1, `expected 1, got ${json.count}`);
  assert.equal(json.issuers[0].instructor, "carol");
  assert.equal(json.issuers[0].jti, carolJti);
});

await check("GET ?minted_by=admin returns admin's direct mints (alice + bob)", async () => {
  const { status, json, text } = await fetchOnce("/admin/issuers?minted_by=admin", {
    headers: { authorization: ADMIN },
  });
  assert.equal(status, 200, `got ${status}: ${text}`);
  assert.equal(json.count, 2, `expected 2, got ${json.count}`);
  const names = json.issuers.map((i) => i.instructor).sort();
  assert.deepEqual(names, ["alice", "bob"]);
});

await check("GET ?minted_by=nobody returns empty", async () => {
  const { status, json } = await fetchOnce("/admin/issuers?minted_by=nobody", {
    headers: { authorization: ADMIN },
  });
  assert.equal(status, 200);
  assert.equal(json.count, 0);
});

// Revoking a lineage token surfaces in the query — the operator's confirmation
// that the cascade landed.
await check("after revoke, carol shows revoked in bob's lineage", async () => {
  const rev = await fetchOnce("/admin/tokens/revoke", {
    method: "POST",
    headers: { authorization: ADMIN },
    body: { jti: carolJti, reason: "minter revoke cascade" },
  });
  assert.equal(rev.status, 200, `revoke got ${rev.status}: ${rev.text}`);
  const { json } = await fetchOnce("/admin/issuers?minted_by=bob", {
    headers: { authorization: ADMIN },
  });
  assert.equal(json.issuers[0].instructor, "carol");
  assert.ok(json.issuers[0].revoked, "carol should read as revoked");
  assert.equal(json.issuers[0].revoked.reason, "minter revoke cascade");
});

// --- authz: a Bearer minter must NOT be able to enumerate the trail ----------

await check("GET /admin/issuers with issuer Bearer → 401 (admin-only)", async () => {
  const { status, text } = await fetchOnce("/admin/issuers", {
    headers: { authorization: `Bearer ${bobToken}` },
  });
  assert.equal(status, 401, `got ${status}: ${text}`);
});

await check("GET /admin/issuers with no auth → 401", async () => {
  const { status } = await fetchOnce("/admin/issuers");
  assert.equal(status, 401, `got ${status}`);
});

await check("limit=1 caps the returned rows", async () => {
  const { status, json } = await fetchOnce("/admin/issuers?limit=1", {
    headers: { authorization: ADMIN },
  });
  assert.equal(status, 200);
  assert.equal(json.count, 1);
  assert.equal(json.limit, 1);
});

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\nissuer-lineage.test.mjs: ${failed.length} FAILED`);
  process.exit(1);
}
console.log("\nissuer-lineage.test.mjs: all tests passed");
