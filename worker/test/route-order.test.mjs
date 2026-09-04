// Route-order smoke over the full app (#255 A#8).
//
// Locks in src/index.ts mount-order invariants so a future edit can't
// silently reorder them:
//   1. requestId runs FIRST — every response (incl. 404) carries x-request-id
//   2. signingSecretGuard runs BEFORE the token routes it protects
//      (/v1/chat/*, /v1/profile, /v1/trace/*, /admin/*) and fails closed
//      (503) in production on a bad secret
//   3. the guard exemptions hold: /v1/health (ops probe) and /v1/report
//      (REQ-H6 anonymous bug reporting) and the / HTML page still serve
//      with a broken secret; /issuer + /console (moved to Chalk, plan task
//      F) still answer with their redirect rather than the guard's 503
//   4. both /v1 (chat) and /v1/trace prefixes route to their own routers —
//      the /v1 mount does not shadow /v1/trace
//
// Run: node --experimental-strip-types test/route-order.test.mjs

import assert from "node:assert/strict";
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, COHORT, PROFILE, USER } from "./harness/index.mjs";

const app = await bootApp();
const { issue } = await import("../src/lib/tokens.ts");

// "x" * 32 trips validateSigningSecret's repeated-character placeholder rule
// while being long enough — the guard (not token verify) must catch it.
const BAD_SECRET = "x".repeat(32);

function post(path, { body = "{}", headers = {} } = {}) {
  return new Request(`https://api.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

// --- 1. requestId before everything: 404 still carries x-request-id ---------
{
  const env = createMockEnv();
  const r = await app.fetch(new Request("https://api.test/v1/nope"), env, makeCtx());
  assert.equal(r.status, 404, "unknown /v1 path → app-level 404");
  assert.ok(r.headers.get("x-request-id"), "404 carries x-request-id (middleware first)");
  const j = await r.json();
  assert.equal(j.error.type, "not_found");
  assert.equal(j.error.request_id, r.headers.get("x-request-id"), "body/header ids agree");
}
// cf-ray is preferred for cross-system correlation when present.
{
  const env = createMockEnv();
  const r = await app.fetch(
    new Request("https://api.test/v1/nope", { headers: { "cf-ray": "abcdef1234-ICN" } }),
    env,
    makeCtx(),
  );
  assert.equal(r.headers.get("x-request-id"), "abcdef12", "cf-ray prefix reused as request id");
}
console.log("✓ route-order: requestId middleware runs before routing (404 path)");

// --- 2. guard-before-routes: bad secret fails closed on every guarded prefix -
{
  const env = createMockEnv({ secret: BAD_SECRET, environment: "production" });
  // A syntactically valid token signed with the bad secret — if the guard
  // were mounted AFTER the routes, these would reach token verify (401)
  // instead of failing closed (503).
  const { token } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET).catch(() => ({ token: "" }));
  const auth = { authorization: `Bearer ${token}` };

  for (const [label, req] of [
    ["/v1/chat/completions", post("/v1/chat/completions", { headers: auth })],
    ["/v1/messages", post("/v1/messages", { headers: auth })],
    ["/v1/messages/count_tokens", post("/v1/messages/count_tokens", { headers: auth })],
    ["/v1/profile", new Request("https://api.test/v1/profile", { headers: auth })],
    ["/v1/trace/event", post("/v1/trace/event", { headers: auth })],
    [
      "/v1/logs (upload)",
      new Request("https://api.test/v1/logs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/events.jsonl?day=2026-08-19", {
        method: "PUT", headers: auth, body: "x\n",
      }),
    ],
    ["/admin/cohorts", new Request("https://api.test/admin/cohorts")],
  ]) {
    const r = await app.fetch(req, createMockEnv({ secret: BAD_SECRET, environment: "production" }), makeCtx());
    assert.equal(r.status, 503, `${label} fails closed (503) on bad secret — guard mounted before route`);
    const j = await r.json();
    assert.equal(j.error.type, "config", `${label} error is the guard's config error, not an auth error`);
  }
  void env;
}
console.log("✓ route-order: signingSecretGuard precedes /v1/chat, /v1/messages(+/count_tokens), /v1/profile, /v1/trace, /v1/logs, /admin");

// --- 3. guard exemptions: health, report, HTML pages survive a broken secret -
{
  const badEnv = () => createMockEnv({ secret: BAD_SECRET, environment: "production" });

  const health = await app.fetch(new Request("https://api.test/v1/health"), badEnv(), makeCtx());
  assert.equal(health.status, 200, "/v1/health exempt from the guard");

  const report = await app.fetch(
    post("/v1/report", { body: JSON.stringify({ description: "버그: 미리보기가 안 떠요" }) }),
    badEnv(),
    makeCtx(),
  );
  assert.notEqual(report.status, 503, "/v1/report exempt (REQ-H6: bug reporting survives config breakage)");
  assert.notEqual(report.status, 404, "/v1/report is mounted");

  {
    const r = await app.fetch(new Request("https://api.test/"), badEnv(), makeCtx());
    assert.equal(r.status, 200, "/ HTML page serves without the guard");
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  }

  // Task F — the instructor pages are Chalk's now. The Service answers with a
  // redirect to the Chalk origin (HPS_CHALK_ORIGIN, prod default when unset),
  // path preserved, and stays outside the signing-secret guard: a broken
  // secret must never strand an instructor on a 503 before they even reach
  // the page. Location carries NO fragment so a `#t=<token>` link survives.
  for (const page of ["/issuer", "/console"]) {
    const r = await app.fetch(new Request(`https://api.test${page}#t=abc`), badEnv(), makeCtx());
    assert.equal(r.status, 302, `${page} redirects to Chalk (not 503 — guard-exempt)`);
    assert.equal(r.headers.get("location"), `https://chalk.hypeproof-ai.xyz${page}`, `${page} → prod Chalk origin by default`);
    assert.ok(!(r.headers.get("location") ?? "").includes("#"), "Location has no fragment, so the browser re-attaches the token fragment");

    const custom = await app.fetch(
      new Request(`https://api.test${page}`),
      createMockEnv({ secret: BAD_SECRET, environment: "production", env: { HPS_CHALK_ORIGIN: "http://localhost:8788/" } }),
      makeCtx(),
    );
    assert.equal(custom.headers.get("location"), `http://localhost:8788${page}`, `${page} honours HPS_CHALK_ORIGIN (trailing slash trimmed)`);
  }
}
console.log("✓ route-order: /v1/health, /v1/report and / stay reachable on bad secret; /issuer + /console redirect to Chalk");

// --- 4. /v1 mount does not shadow /v1/trace ----------------------------------
{
  // No token: if /v1/trace/event were swallowed by the /v1 (chat) router it
  // would 404; reaching the trace router yields its own 401 auth error.
  const r = await app.fetch(post("/v1/trace/event"), createMockEnv(), makeCtx());
  assert.equal(r.status, 401, "/v1/trace/event reaches the trace router (401, not 404)");

  // And the chat router still owns its own prefix.
  const chat = await app.fetch(post("/v1/chat/completions"), createMockEnv(), makeCtx());
  assert.equal(chat.status, 401, "/v1/chat/completions reaches the chat router");

  // Authenticated trace round-trip through the FULL app (guard + mount order):
  // trialStart returns a server-assigned trial_id.
  const env = createMockEnv();
  const { token } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET);
  const start = await app.fetch(
    post("/v1/trace/event", {
      body: JSON.stringify({ type: "trialStart", task_label: "route-order smoke" }),
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
    makeCtx(),
  );
  assert.equal(start.status, 200, "trialStart 200 through the full app");
  const j = await start.json();
  assert.match(j.trial_id, /^[0-9a-f-]{36}$/i, "server-assigned trial_id returned");
  assert.ok(
    env._dbCalls.some((c) => /INSERT INTO trials/.test(c.sql)),
    "trials INSERT reached D1 via the mounted trace router",
  );
}
console.log("✓ route-order: /v1 and /v1/trace prefixes each hit their own router");

console.log("All route-order smoke tests passed.");
