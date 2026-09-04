// In-process smoke for Chalk, the instructor surface (plan task F; #352
// console, epic #351). Moved from worker/test with the split.
//
// Covers: page serving, /health version, GET /admin/cohorts/:id/state (the
// issuer-Bearer read the console builds its UI from), the instructor-write
// forwarder (allowlist, header whitelist, pass-through, upstream failure),
// and the signing-secret guard. Invokes the worker's fetch() directly, no
// wrangler.
//
// Run: node --experimental-strip-types chalk/test/instructor-console.test.mjs

import assert from "node:assert/strict";
// Same loader the Service tests use (extensionless .ts + .html/.md as text).
import "../../worker/test/harness/loader.mjs";

const SECRET = "test-secret-" + "x".repeat(20);
const { default: chalk } = await import("../src/index.ts");
// Test-side minting only. Chalk itself imports NO signing code (src/shared.ts).
const { issue, issueIssuer } = await import("../../worker/src/lib/tokens.ts");
const { startSession } = await import("../../worker/src/lib/kv.ts");

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
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    _store: store,
  };
}

const SERVICE = "https://service.test";
function makeEnv(overrides = {}) {
  return {
    HPS_SIGNING_SECRET: SECRET,
    ENVIRONMENT: "production",
    HPS_SERVICE_ORIGIN: SERVICE,
    HPS_KV: makeKV(),
    HPS_DB: { prepare() { throw new Error("D1 must not be touched by task-F routes"); } },
    ...overrides,
  };
}
const env = makeEnv();

const COHORT = "boah-dental-2026-a";
const COPYCLONE = "boah-dental-director-copyclone-2026-s1";

async function fetchOnce(path, { method = "GET", headers = {}, body, env: e = env } = {}) {
  const req = new Request("https://chalk.test" + path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const res = await chalk.fetch(req, e, { waitUntil() {}, passThroughOnException() {} });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers, contentType: res.headers.get("content-type") ?? "" };
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
const { token: instructorToken } = await issueIssuer(
  {
    issuer: "test-instructor",
    scopes: [{ cohort: COHORT, profiles: [COPYCLONE], max_hours: 12, can_start_session: true, max_session_hours: 4 }],
  },
  24,
  SECRET,
);
const BEARER = { authorization: `Bearer ${instructorToken}` };

// --- 1. pages + health -------------------------------------------------------

await check("GET /console serves the instructor console HTML", async () => {
  const { status, text, contentType } = await fetchOnce("/console");
  assert.equal(status, 200);
  assert.match(contentType, /text\/html/);
  assert.match(text, /강사 세션 콘솔/);
});

await check("GET /issuer serves the student-token mint page", async () => {
  const { status, contentType } = await fetchOnce("/issuer");
  assert.equal(status, 200);
  assert.match(contentType, /text\/html/);
});

await check("GET / redirects to /console", async () => {
  const { status, headers } = await fetchOnce("/");
  assert.equal(status, 302);
  assert.equal(headers.get("location"), "/console");
});

await check("GET /health reports the c* version verbatim, 'unknown' when unset", async () => {
  const unset = await fetchOnce("/health");
  assert.equal(unset.status, 200);
  assert.equal(unset.json.service, "hypeproof-chalk");
  assert.equal(unset.json.version, "unknown");
  const set = await fetchOnce("/health", { env: makeEnv({ HPS_CHALK_VERSION: "c0.1.0" }) });
  assert.equal(set.json.version, "c0.1.0");
  assert.ok(set.headers.get("x-request-id"), "request id stamped");
});

// --- 2. state read: issuer Bearer ------------------------------------------

await check("state: scoped issuer sees only its track, with display name + caps", async () => {
  const { status, json, text } = await fetchOnce(`/admin/cohorts/${COHORT}/state`, { headers: BEARER });
  assert.equal(status, 200, `got ${status}: ${text}`);
  assert.equal(json.id, COHORT);
  assert.equal(json.session, null, "no session open yet");
  assert.equal(json.paused, null);
  assert.deepEqual(json.profiles.map((p) => p.id), [COPYCLONE], "scope-filtered to the copyclone track only");
  assert.ok(json.profiles[0].display_name.includes("카피클론"), "human display name, not just the profile id");
  assert.deepEqual(json.scope, { can_start_session: true, max_session_hours: 4, max_hours: 12 });
});

await check("state: reflects a session the Service wrote into the shared KV", async () => {
  // Chalk never writes gate state; the Service does. Seed the same key the
  // Service's startSession writes and confirm Chalk reads it back.
  const now = Date.now();
  await startSession(env.HPS_KV, COHORT, {
    session_id: "sess-1",
    profile_id: COPYCLONE,
    starts_at: new Date(now).toISOString(),
    ends_at: new Date(now + 2 * 3600 * 1000).toISOString(),
  });
  const { status, json } = await fetchOnce(`/admin/cohorts/${COHORT}/state`, { headers: BEARER });
  assert.equal(status, 200);
  assert.equal(json.session?.profile_id, COPYCLONE, "state shows the live session's track");
});

// --- 3. state read: auth boundaries -----------------------------------------

await check("state: no Authorization → 401 (Chalk has no admin path)", async () => {
  const { status, json } = await fetchOnce(`/admin/cohorts/${COHORT}/state`);
  assert.equal(status, 401);
  assert.match(json.error, /issuer token required/);
});

await check("state: admin Basic is NOT an auth path on Chalk → 401", async () => {
  const basic = "Basic " + Buffer.from("admin:whatever").toString("base64");
  const { status } = await fetchOnce(`/admin/cohorts/${COHORT}/state`, { headers: { authorization: basic } });
  assert.equal(status, 401);
});

await check("state: issuer scoped to a different cohort → 403", async () => {
  const { status, text } = await fetchOnce(`/admin/cohorts/sk-biopharm-2026-a/state`, { headers: BEARER });
  assert.equal(status, 403, `got ${status}: ${text}`);
});

await check("state: a student (non-issuer) token → 403", async () => {
  const { token: studentToken } = await issue({ u: "student", c: COHORT, p: COPYCLONE }, 1, SECRET);
  const { status, json } = await fetchOnce(`/admin/cohorts/${COHORT}/state`, {
    headers: { authorization: `Bearer ${studentToken}` },
  });
  assert.equal(status, 403);
  assert.match(json.error, /not an issuer/);
});

await check("state: garbage Bearer → 401", async () => {
  const { status } = await fetchOnce(`/admin/cohorts/${COHORT}/state`, { headers: { authorization: "Bearer not.atoken" } });
  assert.equal(status, 401);
});

// --- 4. instructor-write forwarder -----------------------------------------

async function withMockFetch(responder, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

await check("forward: session open goes to the Service with a whitelisted header set", async () => {
  await withMockFetch(
    () => Response.json({ ok: true, session: { profile_id: COPYCLONE } }, { status: 200, headers: { "x-request-id": "svc12345" } }),
    async (calls) => {
      const { status, json, headers } = await fetchOnce(`/admin/cohorts/${COHORT}/session`, {
        method: "POST",
        headers: { ...BEARER, "cf-access-authenticated-user-email": "spoof@example.com", cookie: "a=b" },
        body: { profile_id: COPYCLONE, starts_at: "2026-09-04T00:00:00Z", ends_at: "2026-09-04T02:00:00Z" },
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(calls.length, 1, "exactly one upstream call");
      assert.equal(calls[0].url, `${SERVICE}/admin/cohorts/${COHORT}/session`);
      assert.equal(calls[0].init.method, "POST");
      const h = calls[0].init.headers;
      assert.equal(h.get("authorization"), `Bearer ${instructorToken}`);
      assert.match(h.get("content-type"), /application\/json/);
      assert.equal(h.get("cf-access-authenticated-user-email"), null, "CF Access header is never forwarded");
      assert.equal(h.get("cookie"), null, "cookies are never forwarded");
      assert.match(h.get("x-hps-forwarded-by"), /^chalk\//);
      const sent = JSON.parse(Buffer.from(calls[0].init.body).toString("utf8"));
      assert.equal(sent.profile_id, COPYCLONE, "body passed through byte-for-byte");
      assert.equal(headers.get("x-hps-forwarded-to"), "service.test");
      assert.equal(headers.get("x-hps-service-request-id"), "svc12345");
    },
  );
});

await check("forward: Service verdict passes through untouched (409 body)", async () => {
  await withMockFetch(
    () => Response.json({ error: "cohort has a live session — pass force:true to replace it" }, { status: 409 }),
    async () => {
      const { status, json } = await fetchOnce(`/admin/cohorts/${COHORT}/session/open`, {
        method: "POST", headers: BEARER, body: { profile_id: COPYCLONE, user: "kid" },
      });
      assert.equal(status, 409);
      assert.match(json.error, /live session/);
    },
  );
});

await check("forward: DELETE session carries no body", async () => {
  await withMockFetch(() => Response.json({ ok: true, ended: null }), async (calls) => {
    const { status } = await fetchOnce(`/admin/cohorts/${COHORT}/session`, { method: "DELETE", headers: BEARER });
    assert.equal(status, 200);
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(calls[0].init.body, undefined);
  });
});

await check("forward: every console/issuer write path is in the allowlist", async () => {
  await withMockFetch(() => Response.json({ ok: true }), async (calls) => {
    for (const [method, path] of [
      ["POST", `/admin/cohorts/${COHORT}/roster/append`],
      ["POST", "/admin/tokens/issue"],
      ["POST", `/admin/cohorts/${COHORT}/session/close`],
    ]) {
      const { status } = await fetchOnce(path, { method, headers: BEARER, body: { x: 1 } });
      assert.equal(status, 200, `${method} ${path}`);
    }
    assert.equal(calls.length, 3);
  });
});

await check("forward: admin-only Service paths are 404 here and never forwarded", async () => {
  await withMockFetch(() => { throw new Error("must not be called"); }, async (calls) => {
    for (const [method, path] of [
      ["GET", "/admin/cohorts"],
      ["GET", "/admin/stats"],
      ["POST", `/admin/cohorts/${COHORT}/roster`],   // full replace — admin only
      ["POST", `/admin/cohorts/${COHORT}/pause`],
      ["GET", "/admin/issuers"],
    ]) {
      const { status, json } = await fetchOnce(path, { method, headers: BEARER, body: method === "POST" ? {} : undefined });
      assert.equal(status, 404, `${method} ${path}`);
      assert.equal(json.error.type, "not_found");
    }
    assert.equal(calls.length, 0);
  });
});

await check("forward: Basic auth is refused (401) and never forwarded", async () => {
  await withMockFetch(() => { throw new Error("must not be called"); }, async (calls) => {
    const basic = "Basic " + Buffer.from("admin:pw").toString("base64");
    const { status, json } = await fetchOnce("/admin/tokens/issue", { method: "POST", headers: { authorization: basic }, body: {} });
    assert.equal(status, 401);
    assert.equal(json.error.type, "auth");
    assert.equal(calls.length, 0);
  });
});

await check("forward: unreachable Service → 502, request id preserved", async () => {
  await withMockFetch(() => { throw new TypeError("fetch failed"); }, async () => {
    const { status, json, headers } = await fetchOnce("/admin/tokens/issue", { method: "POST", headers: BEARER, body: {} });
    assert.equal(status, 502);
    assert.equal(json.error.type, "upstream");
    assert.equal(json.error.request_id, headers.get("x-request-id"));
  });
});

// --- 5. signing-secret guard ---------------------------------------------------

await check("guard: weak secret in production fails closed on /admin/* but pages still serve", async () => {
  const bad = makeEnv({ HPS_SIGNING_SECRET: "x".repeat(32) });
  const api = await fetchOnce(`/admin/cohorts/${COHORT}/state`, { headers: BEARER, env: bad });
  assert.equal(api.status, 503);
  assert.equal(api.json.error.type, "config");
  const pg = await fetchOnce("/console", { env: bad });
  assert.equal(pg.status, 200);
});

// --- summary -----------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
