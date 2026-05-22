// In-process smoke test for student token lifecycle (#110 P0).
//
// Covers what the issuer-flow smoke (PR #61) doesn't:
//   - Expired student token → 401 expired
//   - Revoked student token → 401 revoked + Korean user copy
//   - Concurrent revoked calls (race) → all 401 (deny-by-default)
//   - Revoke entry removed → token works again (self-heal)
//   - KV propagation lag (simulated via delayed `get`) → still denies
//
// Run: node --experimental-strip-types worker/test/token-lifecycle.smoke.mjs
//
// Memory ref: cf-kv-eventual-consistency — revoke ↔ read can lag 1-2s in
// production CF KV. We can't reproduce real KV lag in-process, but we can
// verify the worker's deny-by-default behavior under a slowed-down mock get.

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

const { issue } = await import("../src/lib/tokens.ts");
const { default: worker } = await import("../src/index.ts");

const COHORT = "boah-dental-2026-a";
const PROFILE = "boah-dental-teaser-2026-s1";

// In-memory KV mock — same shape as issuer-flow.smoke.mjs. The `getDelayMs`
// hook simulates real CF KV's eventual-consistency lag.
function makeKV({ getDelayMs = 0 } = {}) {
  const store = new Map();
  return {
    async get(key, type) {
      if (getDelayMs > 0) {
        await new Promise((r) => setTimeout(r, getDelayMs));
      }
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

function makeEnv(kv) {
  return {
    HPS_SIGNING_SECRET: SECRET,
    HPS_ADMIN_PASSWORD: "test-admin-pw",
    HPS_KV: kv,
    ENVIRONMENT: "test",
    LLM_PROVIDER: "anthropic",
    // No real LLM key — but the auth path returns 401 before we ever hit the
    // provider, which is exactly what we want to test.
  };
}

async function fetchOnce(req, env) {
  const res = await worker.fetch(req, env, {
    waitUntil() {},
    passThroughOnException() {},
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

function chatRequest(token) {
  return new Request("https://x/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "hypeproof-default",
      stream: false,
      max_tokens: 10,
      messages: [{ role: "user", content: "안녕" }],
    }),
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
// 1. Expired token → 401 expired
// ─────────────────────────────────────────────────────────────────────
await check("1. expired student token → 401 expired", async () => {
  // hours = -1 → exp is one hour in the past
  const { token } = await issue({ u: "alice", c: COHORT, p: PROFILE }, -1, SECRET);
  const env = makeEnv(makeKV());
  const { status, json } = await fetchOnce(chatRequest(token), env);
  assert.equal(status, 401, `got ${status}`);
  assert.equal(json?.error?.code, "expired", `code=${json?.error?.code}`);
});

// ─────────────────────────────────────────────────────────────────────
// 2. Fresh token chats OK (auth passes — provider error is fine here)
// ─────────────────────────────────────────────────────────────────────
let aliveToken, aliveJti;
await check("2. fresh token: auth passes (no 401)", async () => {
  const minted = await issue({ u: "alice", c: COHORT, p: PROFILE }, 1, SECRET);
  aliveToken = minted.token;
  aliveJti = minted.jti;
  const env = makeEnv(makeKV());
  const { status, json } = await fetchOnce(chatRequest(aliveToken), env);
  // Anything except a 401 means auth let it through. Provider failure (5xx /
  // 500 / 400 from anthropic mock-missing) is acceptable here — we only care
  // that the auth gate didn't reject.
  assert.notEqual(status, 401, `auth blocked unexpectedly: ${status} ${JSON.stringify(json)}`);
});

// ─────────────────────────────────────────────────────────────────────
// 3. Revoke entry present → 401 revoked + Korean copy
// ─────────────────────────────────────────────────────────────────────
await check("3. revoke jti → 401 revoked + Korean user copy", async () => {
  const kv = makeKV();
  await kv.put(
    `revoked:${aliveJti}`,
    JSON.stringify({ jti: aliveJti, ts: Math.floor(Date.now() / 1000), reason: "session end" }),
  );
  const env = makeEnv(kv);
  const { status, json } = await fetchOnce(chatRequest(aliveToken), env);
  assert.equal(status, 401, `got ${status}`);
  assert.equal(json?.error?.code, "revoked");
  // User-facing copy must be Korean — workshop participants see this verbatim.
  assert.match(json.error.message, /더이상 사용할 수 없|만료|사용할 수 없|종료/);
});

// ─────────────────────────────────────────────────────────────────────
// 4. Concurrent revoked requests (race) → all 401
//    Verifies no early-pass leak under contention.
// ─────────────────────────────────────────────────────────────────────
await check("4. 6 concurrent revoked requests → all 401 (race-safe)", async () => {
  const kv = makeKV();
  await kv.put(
    `revoked:${aliveJti}`,
    JSON.stringify({ jti: aliveJti, ts: Math.floor(Date.now() / 1000), reason: "test" }),
  );
  const env = makeEnv(kv);
  const responses = await Promise.all(
    Array.from({ length: 6 }, () => fetchOnce(chatRequest(aliveToken), env)),
  );
  const statuses = responses.map((r) => r.status);
  assert.deepEqual(
    [...new Set(statuses)],
    [401],
    `got mixed statuses: ${statuses.join(",")}`,
  );
  for (const r of responses) {
    assert.equal(r.json?.error?.code, "revoked");
  }
});

// ─────────────────────────────────────────────────────────────────────
// 5. KV lag simulated (50ms get delay) — still denies (deny-by-default)
//    Real CF KV can lag 1-2s after a put; what matters is that once the
//    revoke read happens, the verdict is consistent.
// ─────────────────────────────────────────────────────────────────────
await check("5. KV get lag 50ms — revoked token still denied", async () => {
  const kv = makeKV({ getDelayMs: 50 });
  await kv.put(
    `revoked:${aliveJti}`,
    JSON.stringify({ jti: aliveJti, ts: Math.floor(Date.now() / 1000), reason: "test" }),
  );
  const env = makeEnv(kv);
  const t0 = Date.now();
  const { status, json } = await fetchOnce(chatRequest(aliveToken), env);
  const dt = Date.now() - t0;
  assert.equal(status, 401, `got ${status}`);
  assert.equal(json?.error?.code, "revoked");
  // Sanity: the KV delay actually took effect (≥40ms accounting for clock skew)
  assert.ok(dt >= 40, `expected ≥40ms latency, got ${dt}ms`);
});

// ─────────────────────────────────────────────────────────────────────
// 6. Revoke removed → token usable again (self-heal)
// ─────────────────────────────────────────────────────────────────────
await check("6. delete revoke entry → token usable again", async () => {
  const kv = makeKV();
  await kv.put(
    `revoked:${aliveJti}`,
    JSON.stringify({ jti: aliveJti, ts: Math.floor(Date.now() / 1000), reason: "test" }),
  );
  await kv.delete(`revoked:${aliveJti}`);
  const env = makeEnv(kv);
  const { status } = await fetchOnce(chatRequest(aliveToken), env);
  assert.notEqual(status, 401, "auth should have passed after revoke removed");
});

// ─────────────────────────────────────────────────────────────────────
// 7. Same token from 3 "devices" simultaneously → all auth-pass
//    Studio doesn't lock a token to one device; verify chat policy is consistent.
// ─────────────────────────────────────────────────────────────────────
await check("7. same fresh token from 3 concurrent callers → all pass auth", async () => {
  const { token } = await issue({ u: "bob", c: COHORT, p: PROFILE }, 1, SECRET);
  const env = makeEnv(makeKV());
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => fetchOnce(chatRequest(token), env)),
  );
  for (const r of responses) {
    assert.notEqual(r.status, 401, `auth blocked at status=${r.status}`);
  }
});

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} failed`);
  process.exit(1);
}
console.log(`\nAll ${results.length} token-lifecycle checks passed.`);
