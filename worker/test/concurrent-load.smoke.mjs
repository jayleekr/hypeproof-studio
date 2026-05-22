// In-process concurrent-load smoke for #116 P2.
//
// Workshop 1회차 = 6 instructor·boojo-instructor tokens + N participants.
// This smoke verifies the worker's auth path holds under concurrency, with
// no jti collisions and no early-pass leaks.
//
// We hit `/v1/profile` (auth-only, no cohort gating, no LLM call) — perfect
// for stress-testing the auth path without a real Anthropic key and without
// setting up KV active_session + roster fixtures.
//
// Run: node --experimental-strip-types worker/test/concurrent-load.smoke.mjs
//
// Rate-limit user copy (429 from Anthropic) is a separate Studio-side product
// gap — forked from this scope.

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

const { issueIssuer, issue } = await import("../src/lib/tokens.ts");
const { default: worker } = await import("../src/index.ts");

const COHORT = "boah-dental-2026-a";
const PROFILE = "boah-dental-teaser-2026-s1";

function makeKV() {
  const store = new Map();
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (!raw) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value /* , opts */) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      const keys = [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

const sharedKV = makeKV();

const env = {
  HPS_SIGNING_SECRET: SECRET,
  HPS_ADMIN_PASSWORD: "test-admin-pw",
  HPS_KV: sharedKV,
  ENVIRONMENT: "test",
  LLM_PROVIDER: "anthropic",
  // No real ANTHROPIC_API_KEY — auth path runs to completion, provider call fails.
  // That's fine for this smoke; we only assert non-401/403 for chat.
};

async function fetchOnce(req) {
  const res = await worker.fetch(req, env, {
    waitUntil() {},
    passThroughOnException() {},
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

function profileRequest(token) {
  return new Request("https://x/v1/profile", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
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

// ─────────────────────────────────────────────────────────────────────
// 1. 6 issuer tokens minted in parallel → 6 unique jti
// ─────────────────────────────────────────────────────────────────────
let issuerTokens = [];
let issuerJtis = [];
await check("1. 6 issuer tokens minted in parallel → 6 unique jti", async () => {
  const issuers = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      issueIssuer(
        {
          issuer: `instructor-${i + 1}`,
          scopes: [{ cohort: COHORT, profiles: [PROFILE], max_hours: 6 }],
        },
        12,
        SECRET,
      ),
    ),
  );
  issuerTokens = issuers.map((x) => x.token);
  issuerJtis = issuers.map((x) => x.jti);
  assert.equal(new Set(issuerJtis).size, 6, "jti collisions");
});

// ─────────────────────────────────────────────────────────────────────
// 2. 6 student tokens minted directly in parallel → 6 unique jti
//    (lib/tokens.ts:issue — skips the admin endpoint surface)
// ─────────────────────────────────────────────────────────────────────
let studentTokens = [];
let studentJtis = [];
await check("2. 6 student tokens minted in parallel → 6 unique jti", async () => {
  const minted = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      issue({ u: `student-${i + 1}`, c: COHORT, p: PROFILE }, 2, SECRET),
    ),
  );
  studentTokens = minted.map((x) => x.token);
  studentJtis = minted.map((x) => x.jti);
  assert.equal(new Set(studentJtis).size, 6, "student jti collisions");
});

// ─────────────────────────────────────────────────────────────────────
// 3. 6 student tokens concurrent /v1/profile — auth path holds
// ─────────────────────────────────────────────────────────────────────
await check("3. 6 concurrent /v1/profile → all 200", async () => {
  const responses = await Promise.all(studentTokens.map((t) => fetchOnce(profileRequest(t))));
  for (const r of responses) {
    assert.equal(r.status, 200, `expected 200: ${r.status} ${r.text}`);
    assert.equal(r.json?.profile_id, PROFILE);
  }
});

// ─────────────────────────────────────────────────────────────────────
// 4. 6 tokens × 3 calls each (18 calls) — auth-gate latency ≤ 10s
// ─────────────────────────────────────────────────────────────────────
await check("4. 18 concurrent /v1/profile (6 tokens × 3) → ≤10s, all 200", async () => {
  const t0 = Date.now();
  await Promise.all(
    studentTokens.map(async (t) => {
      for (let turn = 0; turn < 3; turn++) {
        const r = await fetchOnce(profileRequest(t));
        assert.equal(r.status, 200, `turn ${turn}: ${r.text}`);
      }
    }),
  );
  const dt = Date.now() - t0;
  assert.ok(dt < 10_000, `auth-gate too slow under load: ${dt}ms`);
});

// ─────────────────────────────────────────────────────────────────────
// 5. Token contention: same student token from 5 concurrent callers
// ─────────────────────────────────────────────────────────────────────
await check("5. same student token × 5 concurrent /v1/profile → all 200", async () => {
  const t = studentTokens[0];
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => fetchOnce(profileRequest(t))),
  );
  for (const r of responses) {
    assert.equal(r.status, 200);
  }
});

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} failed`);
  process.exit(1);
}
console.log(`\nAll ${results.length} concurrent-load checks passed.`);
