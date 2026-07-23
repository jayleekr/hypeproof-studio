// In-process smoke for the instructor console (#352, epic #351).
// Covers: GET /console page serving, and GET /admin/cohorts/:id/state —
// the issuer-Bearer-readable state read the console builds its UI from.
// Invokes worker.fetch() directly, no wrangler.
//
// Run: node --experimental-strip-types worker/test/instructor-console.test.mjs

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
const { issue } = await import("../src/lib/tokens.ts");

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
const COPYCLONE = "boah-dental-director-copyclone-2026-s1";
const TEASER = "boah-dental-teaser-2026-s1";

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
  return { status: res.status, text, json, contentType: res.headers.get("content-type") ?? "" };
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

// --- fixtures ---------------------------------------------------------------

// Instructor scoped to ONE track (copyclone) with session rights.
let instructorToken;
await check("setup: admin mints session-capable instructor (copyclone-only scope)", async () => {
  const { status, json, text } = await fetchOnce("/admin/issuers", {
    method: "POST",
    headers: { authorization: ADMIN },
    body: {
      instructor: "test-instructor",
      scopes: [{
        cohort: COHORT,
        profiles: [COPYCLONE],
        max_hours: 12,
        can_start_session: true,
        max_session_hours: 4,
      }],
    },
  });
  assert.equal(status, 200, `got ${status}: ${text}`);
  instructorToken = json.token;
});

// --- 1. /console page serves ------------------------------------------------

await check("GET /console serves the instructor console HTML", async () => {
  const { status, text, contentType } = await fetchOnce("/console");
  assert.equal(status, 200);
  assert.match(contentType, /text\/html/);
  assert.match(text, /강사 세션 콘솔/);
});

// --- 2. state read: issuer Bearer ------------------------------------------

await check("state: scoped issuer sees only its track, with display name + caps", async () => {
  const { status, json, text } = await fetchOnce(`/admin/cohorts/${COHORT}/state`, {
    headers: { authorization: `Bearer ${instructorToken}` },
  });
  assert.equal(status, 200, `got ${status}: ${text}`);
  assert.equal(json.id, COHORT);
  assert.equal(json.session, null, "no session open yet");
  assert.equal(json.paused, null);
  assert.deepEqual(json.profiles.map((p) => p.id), [COPYCLONE], "scope-filtered to the copyclone track only");
  assert.ok(json.profiles[0].display_name.includes("카피클론"), "human display name, not just the profile id");
  assert.deepEqual(json.scope, { can_start_session: true, max_session_hours: 4, max_hours: 12 });
});

await check("state: reflects a session opened via the issuer session endpoint", async () => {
  const now = Date.now();
  const open = await fetchOnce(`/admin/cohorts/${COHORT}/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${instructorToken}` },
    body: {
      profile_id: COPYCLONE,
      starts_at: new Date(now).toISOString(),
      ends_at: new Date(now + 2 * 3600 * 1000).toISOString(),
    },
  });
  assert.equal(open.status, 200, `session open got ${open.status}: ${open.text}`);
  const { status, json } = await fetchOnce(`/admin/cohorts/${COHORT}/state`, {
    headers: { authorization: `Bearer ${instructorToken}` },
  });
  assert.equal(status, 200);
  assert.equal(json.session?.profile_id, COPYCLONE, "state shows the live session's track");
});

// --- 3. state read: auth boundaries -----------------------------------------

await check("state: admin Basic path — dashboard_hidden track excluded, scope=null", async () => {
  const { status, json, text } = await fetchOnce(`/admin/cohorts/${COHORT}/state`, {
    headers: { authorization: ADMIN },
  });
  assert.equal(status, 200, `got ${status}: ${text}`);
  // #384 — teaser is dashboard_hidden this round; the console must not list it
  // (in the cards OR the mint dropdown). copyclone (dashboard_order 0) leads.
  assert.deepEqual(json.profiles.map((p) => p.id), [COPYCLONE], "hidden teaser excluded, copyclone first");
  assert.equal(json.scope, null);
});

await check("state: issuer scoped to a different cohort → 403", async () => {
  const { status, text } = await fetchOnce(`/admin/cohorts/sk-biopharm-2026-a/state`, {
    headers: { authorization: `Bearer ${instructorToken}` },
  });
  assert.equal(status, 403, `got ${status}: ${text}`);
});

await check("state: a student (non-issuer) token → 403", async () => {
  const { token: studentToken } = await issue(
    { u: "student", c: COHORT, p: COPYCLONE },
    1,
    SECRET,
  );
  const { status, json } = await fetchOnce(`/admin/cohorts/${COHORT}/state`, {
    headers: { authorization: `Bearer ${studentToken}` },
  });
  assert.equal(status, 403);
  assert.match(json.error, /not an issuer/);
});

await check("state: garbage Bearer → 401", async () => {
  const { status } = await fetchOnce(`/admin/cohorts/${COHORT}/state`, {
    headers: { authorization: "Bearer not.atoken" },
  });
  assert.equal(status, 401);
});

// --- summary -----------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
