// In-process smoke test for the issuer-role token flow (PR #61).
// Same code path that's deployed to prod — only difference is HPS_SIGNING_SECRET
// (deterministic test value here). Invokes app.fetch() directly, no wrangler.
//
// Run: node --experimental-strip-types worker/test/issuer-flow.smoke.mjs

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Mirror wrangler's [[rules]] type="Text" — .html/.md imports become text modules.
// Also: src/index.ts uses bare extensionless relative imports ("./routes/chat")
// which wrangler/esbuild resolve to ".ts" — replicate that here.
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

// In-memory KV mock — enough for the issuer + chat paths we exercise.
function makeKV() {
  const store = new Map();
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (!raw) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value /*, opts */) { store.set(key, value); },
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
  // The chat path won't reach D1/R2/Analytics — issuer guard rejects before then.
};

const COHORT_OK = "boah-dental-2026-a";
const COHORT_OTHER = "sk-biopharm-2026-a";
const PROFILE_OK = "boah-dental-teaser-2026-s1";

// Mint a TJ-scoped issuer token (boah only).
const { token: issuerToken, jti: issuerJti } = await issueIssuer(
  {
    issuer: "tj-test",
    scopes: [{ cohort: COHORT_OK, profiles: [PROFILE_OK], max_hours: 12 }],
  },
  24,
  SECRET,
);

const results = [];

// Helper: read body once, return { status, text, json }. Avoids the
// "Body has already been read" trap when assertion messages also touch the body.
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

// 1. Happy path: in-scope mint → 200 + student token
let mintedStudentToken;
await check("1. issuer mints in-scope student token → 200", async () => {
  const { status, text, json } = await fetchOnce(new Request("https://x/admin/tokens/issue", {
    method: "POST",
    headers: { authorization: `Bearer ${issuerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ u: "alice", c: COHORT_OK, p: PROFILE_OK, hours: 6 }),
  }));
  assert.equal(status, 200, `got ${status}: ${text}`);
  assert.equal(json.ok, true);
  assert.equal(json.user, "alice");
  assert.equal(json.cohort, COHORT_OK);
  assert.equal(json.profile, PROFILE_OK);
  assert.equal(json.hours, 6);
  assert.match(json.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  mintedStudentToken = json.token;
});

// 2. Out-of-scope cohort → 403
await check("2. out-of-scope cohort → 403", async () => {
  const { status, text, json } = await fetchOnce(new Request("https://x/admin/tokens/issue", {
    method: "POST",
    headers: { authorization: `Bearer ${issuerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ u: "bob", c: COHORT_OTHER, p: PROFILE_OK, hours: 1 }),
  }));
  assert.equal(status, 403, `got ${status}: ${text}`);
  assert.match(json.error, /not scoped/i);
});

// 2b. Exceeds max_hours → 403
await check("2b. hours > scope.max_hours → 403", async () => {
  const { status, text, json } = await fetchOnce(new Request("https://x/admin/tokens/issue", {
    method: "POST",
    headers: { authorization: `Bearer ${issuerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ u: "alice", c: COHORT_OK, p: PROFILE_OK, hours: 24 }),
  }));
  assert.equal(status, 403, `got ${status}: ${text}`);
  assert.match(json.error, /exceeds scope max/i);
});

// 3. Pause cohort with issuer Bearer → 401 (only admin endpoint that accepts issuer is /tokens/issue)
await check("3. POST /admin/cohorts/.../pause with issuer Bearer → 401", async () => {
  const { status, text } = await fetchOnce(new Request(`https://x/admin/cohorts/${COHORT_OK}/pause`, {
    method: "POST",
    headers: { authorization: `Bearer ${issuerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ reason: "test" }),
  }));
  assert.equal(status, 401, `got ${status}: ${text}`);
});

// 4. Stats with issuer Bearer → 401
await check("4. GET /admin/stats with issuer Bearer → 401", async () => {
  const { status, text } = await fetchOnce(new Request("https://x/admin/stats", {
    method: "GET",
    headers: { authorization: `Bearer ${issuerToken}` },
  }));
  assert.equal(status, 401, `got ${status}: ${text}`);
});

// 5. Revoke another token with issuer Bearer → 401
await check("5. POST /admin/tokens/revoke with issuer Bearer → 401", async () => {
  const { status, text } = await fetchOnce(new Request("https://x/admin/tokens/revoke", {
    method: "POST",
    headers: { authorization: `Bearer ${issuerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ jti: "11111111-2222-4333-8444-555555555555" }),
  }));
  assert.equal(status, 401, `got ${status}: ${text}`);
});

// 6. Chat as issuer → 401 wrong_role
await check("6. POST /v1/chat/completions with issuer token → 401 wrong_role", async () => {
  const { status, text, json } = await fetchOnce(new Request("https://x/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${issuerToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "hypeproof-default",
      stream: false,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    }),
  }));
  assert.equal(status, 401, `got ${status}: ${text}`);
  assert.equal(json?.error?.code, "wrong_role", `code=${json?.error?.code}`);
});

// 7. Revoke the issuer, then minting fails
await check("7. revoke issuer jti → subsequent mint → 401", async () => {
  await env.HPS_KV.put(
    `revoked:${issuerJti}`,
    JSON.stringify({ jti: issuerJti, ts: Math.floor(Date.now() / 1000), reason: "test" }),
  );
  const { status, text, json } = await fetchOnce(new Request("https://x/admin/tokens/issue", {
    method: "POST",
    headers: { authorization: `Bearer ${issuerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ u: "carol", c: COHORT_OK, p: PROFILE_OK, hours: 1 }),
  }));
  assert.equal(status, 401, `got ${status}: ${text}`);
  assert.match(json.error, /revoked/i);
  await env.HPS_KV.delete(`revoked:${issuerJti}`);
});

// 8. Garbage Bearer → 401
await check("8. garbage Bearer → 401", async () => {
  const { status, text } = await fetchOnce(new Request("https://x/admin/tokens/issue", {
    method: "POST",
    headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
    body: JSON.stringify({ u: "x", c: COHORT_OK, p: PROFILE_OK, hours: 1 }),
  }));
  assert.equal(status, 401, `got ${status}: ${text}`);
});

// 9. Student token (not issuer) trying to mint another token → 403
await check("9. student-role Bearer on /tokens/issue → 403", async () => {
  const { token: studentToken } = await issue(
    { u: "alice", c: COHORT_OK, p: PROFILE_OK },
    1,
    SECRET,
  );
  const { status, text, json } = await fetchOnce(new Request("https://x/admin/tokens/issue", {
    method: "POST",
    headers: { authorization: `Bearer ${studentToken}`, "content-type": "application/json" },
    body: JSON.stringify({ u: "y", c: COHORT_OK, p: PROFILE_OK, hours: 1 }),
  }));
  assert.equal(status, 403, `got ${status}: ${text}`);
  assert.match(json.error, /not an issuer/i);
});

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed`);
if (failed > 0) process.exit(1);
