// Worker version identifier — dag.yaml task C.
//
// GET /v1/health's `version` field used to be a hardcoded "0.1.0" literal
// that never changed (the same defect class as #684/task B: a constant
// masquerading as an observation). resolveWorkerVersion() (src/env.ts) now
// backs it, and this locks in the committed control the plan requires:
//   positive — HPS_WORKER_VERSION injected -> exact string in the JSON body
//   negative — var unset            -> 200, "unknown", never a crash
//   negative — var set to ""        -> "unknown", never an empty string
//
// Run: node --experimental-strip-types test/worker-version.test.mjs

import assert from "node:assert/strict";
import { bootApp, createMockEnv, makeCtx } from "./harness/index.mjs";
import { resolveWorkerVersion } from "../src/env.ts";

const app = await bootApp();

// --- positive: injected version appears verbatim in GET /v1/health --------
{
  const env = createMockEnv();
  env.HPS_WORKER_VERSION = "w2026.09.04-1";
  const r = await app.fetch(new Request("https://api.test/v1/health"), env, makeCtx());
  assert.equal(r.status, 200, "GET /v1/health is 200 with the version set");
  const j = await r.json();
  assert.equal(j.version, "w2026.09.04-1", "JSON `version` carries the injected tag verbatim");
}
console.log("✓ worker-version: injected HPS_WORKER_VERSION appears verbatim in GET /v1/health");

// --- negative: var unset -> 200, "unknown", never a crash ------------------
{
  const env = createMockEnv();
  assert.equal(env.HPS_WORKER_VERSION, undefined, "sanity: harness doesn't set this var by default");
  const r = await app.fetch(new Request("https://api.test/v1/health"), env, makeCtx());
  assert.equal(r.status, 200, "GET /v1/health still 200 with the var unset");
  const j = await r.json();
  assert.equal(j.version, "unknown", "unset var reports 'unknown', never empty, never a crash");
}
console.log("✓ worker-version: unset HPS_WORKER_VERSION -> 200 + 'unknown' on GET /v1/health");

// --- negative: var set to "" -> "unknown", never a raw empty string --------
{
  const env = createMockEnv();
  env.HPS_WORKER_VERSION = "";
  const r = await app.fetch(new Request("https://api.test/v1/health"), env, makeCtx());
  assert.equal(r.status, 200, "GET /v1/health still 200 with an empty-string var");
  const j = await r.json();
  assert.equal(j.version, "unknown", "empty-string var collapses to 'unknown', not ''");
}
console.log("✓ worker-version: empty-string HPS_WORKER_VERSION -> 'unknown', not ''");

// --- unit coverage on the pure helper itself (both call sites share it) ----
{
  assert.equal(resolveWorkerVersion({ HPS_WORKER_VERSION: "w2026.09.04-1" }), "w2026.09.04-1");
  assert.equal(resolveWorkerVersion({ HPS_WORKER_VERSION: undefined }), "unknown");
  assert.equal(resolveWorkerVersion({ HPS_WORKER_VERSION: "" }), "unknown");
  assert.equal(resolveWorkerVersion({ HPS_WORKER_VERSION: "   " }), "unknown", "whitespace-only also collapses");
  assert.equal(resolveWorkerVersion({}), "unknown", "field entirely absent from the object");
}
console.log("✓ worker-version: resolveWorkerVersion() pure-function control (both call sites depend on this)");

// --- GET / still carries the same value, and its HTML contract is untouched
{
  const env = createMockEnv();
  env.HPS_WORKER_VERSION = "w2026.09.04-1";
  const r = await app.fetch(new Request("https://api.test/"), env, makeCtx());
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/, "GET / stays text/html (route-order.test.mjs pins this)");
  assert.equal(r.headers.get("x-hps-worker-version"), "w2026.09.04-1", "GET / exposes the same version as a header");
}
console.log("✓ worker-version: GET / carries the same version as a header without disturbing its HTML contract");

console.log("All worker-version tests passed.");
