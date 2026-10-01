// CR-T02, Worker half (cr-browser #1391; recon R3). The Curriculum Runtime switch
// `curriculum_runtime.enabled` is off unless a profile says so; with it off, no CR tool,
// contract or route is reachable on the Service, and with it on the CR surfaces appear.
//
// The switch-off inventory is the App's `CR_SURFACES` (extensions/hypeproof-chat/src/
// curriculumRuntime.ts): each later cr-* item appends its routes there, and this test
// walks every one of them. cr-browser adds proxy tools and a contract, no route; cr-verify
// (#1392) adds the two AI Verify tools and a contract section, no route either.
//
// Run: node --experimental-strip-types --experimental-sqlite test/cr-switch.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { localAuthoring } from "./harness/dental-authoring.mjs";
import { TEST_SECRET } from "./harness/index.mjs";

const { translate, buildAnthropicSystemBlocks } = await import("../src/lib/translate.ts");
const { BROWSER_TOOLS, CR_BROWSER_TOOLS, CR_VERIFY_TOOLS } = await import("../src/lib/browser-tools.ts");
const { getProfile, listProfiles } = await import("../src/profiles/index.ts");
const { issue } = await import("../src/lib/tokens.ts");
const { CR_SURFACES } = await import("../../extensions/hypeproof-chat/src/curriculumRuntime.ts");
const { MCP_CR_BROWSER_TOOLS, MCP_CR_VERIFY_TOOLS } = await import("../../extensions/hypeproof-chat/src/browserMcp.ts");

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}\n   ${err.stack ?? err.message}`);
  }
}

const COPYCLONE = getProfile("boah-dental-director-copyclone-2026-s1");
const withSwitch = (p, enabled) => ({ ...p, curriculum_runtime: { enabled } });
const toolNames = (profile) =>
  (translate({ model: "hypeproof-default", messages: [{ role: "user", content: "hi" }] }, profile).tools ?? []).map((t) => t.name);
const CR_NAMES = [...CR_BROWSER_TOOLS, ...CR_VERIFY_TOOLS].map((t) => t.name);
const MCP_CR_ALL = [...MCP_CR_BROWSER_TOOLS, ...MCP_CR_VERIFY_TOOLS];
const CR_CONTRACT = "실험 브라우저 추가 도구";

await test("inventory: the App's CR tool lists are exactly the Worker's (one name set, both runtimes)", () => {
  assert.deepEqual([...CR_SURFACES.proxyTools].sort(), [...CR_NAMES].sort());
  assert.deepEqual([...CR_SURFACES.mcpTools].sort(), [...MCP_CR_ALL].sort());
  assert.deepEqual(MCP_CR_ALL.map((n) => n.replace(/^mcp__hypeproof__/, "")).sort(), [...CR_NAMES].sort());
  assert.ok(CR_NAMES.includes("verify_criterion") && CR_NAMES.includes("verify_propose_criteria"), "cr-verify: both verify tools are inventoried");
  assert.ok(CR_NAMES.every((n) => !BROWSER_TOOLS.some((t) => t.name === n)), "CR tools are not in the always-on list");
});

await test("switch OFF: no CR proxy tool and no CR contract in either runtime (absent and false)", () => {
  for (const p of [COPYCLONE, withSwitch(COPYCLONE, false)]) {
    const names = toolNames(p);
    assert.ok(BROWSER_TOOLS.every((t) => names.includes(t.name)), "the existing browser tools stay");
    assert.deepEqual(names.filter((n) => CR_NAMES.includes(n)), [], "no CR tool with the switch off");
    for (const runtime of ["proxy", "sdk"]) {
      assert.ok(!buildAnthropicSystemBlocks(p, {}, runtime)[0].text.includes(CR_CONTRACT), `${runtime}: no CR contract`);
    }
  }
});

await test("switch ON: the CR browser and verify tools and the CR contract appear (both runtimes)", () => {
  const on = withSwitch(COPYCLONE, true);
  const names = toolNames(on);
  assert.deepEqual(names.filter((n) => CR_NAMES.includes(n)).sort(), [...CR_NAMES].sort());
  for (const runtime of ["proxy", "sdk"]) {
    const prefix = buildAnthropicSystemBlocks(on, {}, runtime)[0].text;
    assert.ok(prefix.includes(CR_CONTRACT), `${runtime}: CR contract present`);
    for (const n of CR_NAMES) assert.ok(prefix.includes(n), `${runtime}: contract names ${n}`);
    assert.ok(prefix.includes("제품 테스트 (AI Verify)"), `${runtime}: the verify section of the contract is present`);
  }
});

await test("switch ON without browser tools: nothing CR appears (the switch never grants browsing)", () => {
  const kids = withSwitch(getProfile("sk-biopharm-kids-2026-grade-3-4-s1"), true);
  assert.deepEqual(toolNames(kids).filter((n) => CR_NAMES.includes(n)), []);
  for (const runtime of ["proxy", "sdk"]) assert.ok(!buildAnthropicSystemBlocks(kids, {}, runtime)[0].text.includes(CR_CONTRACT));
});

await test("switch ON for a minor cohort WITH browser_control: still no CR tool or contract on either runtime", () => {
  const kids = getProfile("sk-biopharm-kids-2026-grade-3-4-s1");
  const kidsBrowsing = { ...withSwitch(kids, true), browser_control: { ...(kids.browser_control ?? {}), enabled: true } };
  const names = toolNames(kidsBrowsing);
  assert.ok(names.includes("browser_navigate"), "control: the planted browser_control really injects the base tools");
  assert.deepEqual(names.filter((n) => CR_NAMES.includes(n)), [], "no CR tool for a minor");
  for (const runtime of ["proxy", "sdk"]) assert.ok(!buildAnthropicSystemBlocks(kidsBrowsing, {}, runtime)[0].text.includes(CR_CONTRACT), `${runtime}: no CR contract for a minor`);
});

await test("switch ON for a 14-17 workshop-tier cohort: no CR tool, no contract, served off (one minor test)", async () => {
  const teen = { ...withSwitch(COPYCLONE, true), audience: { ...COPYCLONE.audience, age_range: [14, 17] } };
  assert.equal(teen.game.template_tier, "website", "control: a workshop tier, above the child threshold");
  assert.ok(toolNames(teen).includes("browser_navigate"), "control: its base browser tools are injected");
  assert.deepEqual(toolNames(teen).filter((n) => CR_NAMES.includes(n)), [], "no CR tool for a teen");
  for (const runtime of ["proxy", "sdk"]) assert.ok(!buildAnthropicSystemBlocks(teen, {}, runtime)[0].text.includes(CR_CONTRACT), `${runtime}: no CR contract for a teen`);
  const original = { cr: COPYCLONE.curriculum_runtime, audience: COPYCLONE.audience };
  COPYCLONE.curriculum_runtime = { enabled: true };
  COPYCLONE.audience = teen.audience;
  try {
    const served = await profileJson(COPYCLONE.id);
    assert.equal(served.json.minor_cohort, true);
    assert.deepEqual(served.json.curriculum_runtime, { enabled: false }, "the served switch is off for a minor, so the App's SDK grant, pick and executor stay off");
  } finally {
    COPYCLONE.audience = original.audience;
    if (original.cr === undefined) delete COPYCLONE.curriculum_runtime;
    else COPYCLONE.curriculum_runtime = original.cr;
  }
});

await test("switch ON for a mixed-age [15, 40] or unknown-age workshop cohort: no CR tool or contract (adult lower bound)", async () => {
  for (const [label, audience] of [["mixed-age 15-40", { ...COPYCLONE.audience, age_range: [15, 40] }], ["no age_range", (({ age_range: _a, ...rest }) => rest)(COPYCLONE.audience)]]) {
    const p = { ...withSwitch(COPYCLONE, true), audience };
    assert.ok(toolNames(p).includes("browser_navigate"), `${label}: control, its base browser tools are injected`);
    assert.deepEqual(toolNames(p).filter((n) => CR_NAMES.includes(n)), [], `${label}: no CR tool`);
    for (const runtime of ["proxy", "sdk"]) assert.ok(!buildAnthropicSystemBlocks(p, {}, runtime)[0].text.includes(CR_CONTRACT), `${label} ${runtime}: no CR contract`);
  }
  const original = { cr: COPYCLONE.curriculum_runtime, audience: COPYCLONE.audience };
  COPYCLONE.curriculum_runtime = { enabled: true };
  COPYCLONE.audience = { ...COPYCLONE.audience, age_range: [15, 40] };
  try {
    const served = await profileJson(COPYCLONE.id);
    assert.equal(served.json.minor_cohort, false, "control: the upper-bound minor test alone would let it through");
    assert.deepEqual(served.json.curriculum_runtime, { enabled: false }, "served off, so the App's CR surfaces stay off");
  } finally {
    COPYCLONE.audience = original.audience;
    if (original.cr === undefined) delete COPYCLONE.curriculum_runtime;
    else COPYCLONE.curriculum_runtime = original.cr;
  }
});

await test("registry: no shipped cohort turns the switch on", () => {
  const on = listProfiles().filter((p) => p.curriculum_runtime?.enabled === true).map((p) => p.id);
  assert.deepEqual(on, [], "default off; turning a cohort on is a deliberate, reviewed change");
});

async function profileJson(profileId) {
  const local = await localAuthoring({ profileId });
  local.db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const { token } = await issue({ u: "student", c: local.cohort, p: local.profileId }, 1, TEST_SECRET);
  const res = await local.fetcher(local.origin + "/v1/profile", { headers: { authorization: "Bearer " + token } });
  return { status: res.status, json: await res.json(), local };
}

await test("/v1/profile serves curriculum_runtime.enabled=false by default and true only when the profile says so", async () => {
  const off = await profileJson(COPYCLONE.id);
  assert.equal(off.status, 200);
  assert.deepEqual(off.json.curriculum_runtime, { enabled: false });
  const original = COPYCLONE.curriculum_runtime;
  COPYCLONE.curriculum_runtime = { enabled: true };
  try {
    const on = await profileJson(COPYCLONE.id);
    assert.deepEqual(on.json.curriculum_runtime, { enabled: true });
  } finally {
    if (original === undefined) delete COPYCLONE.curriculum_runtime;
    else COPYCLONE.curriculum_runtime = original;
  }
});

/**
 * The route check every CR item's routes go through: with the switch off, a CR route
 * must answer exactly as an unknown route does (404, `not_found`, its own path).
 */
async function unknownRouteProblems(fetcher, origin, route, token) {
  const [method, path] = route.split(" ");
  if (path.startsWith("<test-origin>")) return testOriginProblems(fetcher, route);
  const res = await fetcher(origin + path, { method, headers: { authorization: "Bearer " + token } });
  const body = await res.json().catch(() => null);
  const problems = [];
  if (res.status !== 404) problems.push(`${route}: status ${res.status}, not 404`);
  if (body?.error?.type !== "not_found" || body?.error?.path !== path) problems.push(`${route}: body differs from app.notFound`);
  // The headers too (minus the per-request id): a header only CR routes send reveals them.
  const unknown = await fetcher(origin + "/v1/cr-never-registered", { method, headers: { authorization: "Bearer " + token } });
  if (headerShape(res) !== headerShape(unknown)) problems.push(`${route}: headers ${headerShape(res)} differ from the unknown route's ${headerShape(unknown)}`);
  return problems;
}

const headerShape = (res) => JSON.stringify([...res.headers].filter(([k]) => k !== "x-request-id").sort());

/**
 * A published-runtime route (cr-publish) lives on a test origin, whose unknown-path answer
 * is an empty 404. With no link behind it the route must answer exactly that; the same
 * check against a live link whose project is switched off is in cr-publish.test.mjs.
 */
const TEST_ORIGIN_SAMPLE = "http://prj-0000000000000000.test.invalid";
async function testOriginProblems(fetcher, route) {
  const [method, path] = route.split(" ");
  const url = TEST_ORIGIN_SAMPLE + path.replace("<test-origin>", "").replace(":link", "AAAAAAAAAAAAAAAAAAAAAA").replace("*", "index.html");
  const answer = async (u) => { const r = await fetcher(u, { method }); return { status: r.status, body: await r.text() }; };
  const got = await answer(url);
  const unknown = await answer(TEST_ORIGIN_SAMPLE + "/cr-never-registered");
  return got.status === unknown.status && got.body === unknown.body && unknown.status === 404 ? [] : [`${route}: ${got.status} ${got.body.slice(0, 80)} differs from the test origin's unknown path`];
}

await test("switch OFF: every inventoried CR Worker route answers as an unknown route (cr-browser and cr-verify add none; cr-publish adds the curriculum routes)", async () => {
  const { local } = await profileJson(COPYCLONE.id);
  local.env.HPS_TEST_ORIGIN = "http://{project}.test.invalid";
  const { token } = await issue({ u: "student", c: local.cohort, p: local.profileId }, 1, TEST_SECRET);
  // Instrument positive control: a path nobody registered passes the check.
  assert.deepEqual(await unknownRouteProblems(local.fetcher, local.origin, "GET /v1/cr-never-registered", token), []);
  for (const route of CR_SURFACES.workerRoutes) {
    assert.deepEqual(await unknownRouteProblems(local.fetcher, local.origin, route, token), [], route);
  }
  // Instrument negative control: a planted CR route that answers with the switch off is caught.
  const planted = async (url, init) =>
    new URL(url).pathname === "/v1/cr-planted" ? new Response(JSON.stringify({ ok: true }), { status: 200 }) : local.fetcher(url, init);
  const caught = await unknownRouteProblems(planted, local.origin, "GET /v1/cr-planted", token);
  assert.ok(caught.length >= 2, `planted route must be caught: ${JSON.stringify(caught)}`);
  // A planted route whose status and body are the unknown route's but which adds a header
  // (cache-control: no-store on a switch-off answer) is caught by the header comparison alone.
  const headerPlant = async (url, init) => {
    if (new URL(url).pathname !== "/v1/cr-header-plant") return local.fetcher(url, init);
    const r = await local.fetcher(url, init);
    const h = new Headers(r.headers);
    h.set("cache-control", "no-store");
    return new Response(await r.text(), { status: r.status, headers: h });
  };
  const headerCaught = await unknownRouteProblems(headerPlant, local.origin, "GET /v1/cr-header-plant", token);
  assert.equal(headerCaught.length, 1, JSON.stringify(headerCaught));
  assert.match(headerCaught[0], /headers/);
});

if (failed) {
  console.error(`\n${failed} cr-switch check(s) failed`);
  process.exit(1);
}
console.log("\ncr-switch (CR-T02 Worker half): OK");
