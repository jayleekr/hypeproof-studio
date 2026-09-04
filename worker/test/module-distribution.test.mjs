// dag task H — module distribution (curriculum out of the binary).
//
// Drift lock for the `hps-module/1` document format (products.yaml entry
// "curriculum-module"). The worker and the publisher (scripts/publish-module.ts)
// share ONE builder (makeModuleDoc) and ONE validator (validateModuleDoc); this
// file is what keeps them from drifting.
//
// Controls (docs/plan/dag.yaml → H.control):
//
//   POSITIVE  — swapping the module version does not break the prompt-cache
//               prefix beyond the one expected miss: the prefix is byte-stable
//               across builds, carries no version stamp, and does not flap when
//               KV hiccups. The live measurement needs a key and money, so it
//               is not in `npm test`; the properties that make it hold are
//               here. Live run 2026-09-04, claude-sonnet-4-6, these exact
//               blocks: compiled R1 cache_creation=14668 → R2 cache_read=14668;
//               after pinning m2026.09.04-1: R3 cache_creation=14699 (the one
//               expected miss) → R4 cache_read=14699. Script + numbers are in
//               lib/modules.ts's header.
//   NEGATIVE  — a malformed module disables ONLY itself: the cohort falls back
//               to `previous`, then to the compiled text, console.error fires,
//               an Analytics datapoint is written, and the turn record names
//               both the served version and the failed pin. Never an empty
//               prompt. A sibling profile is untouched.
//   ALSO      — the module version is on the turn record (Analytics blob) and
//               on the response (x-hps-module) for both LLM routes and on
//               GET /v1/profile.
//
// Run: node --experimental-strip-types test/module-distribution.test.mjs

import assert from "node:assert/strict";
import {
  bootApp,
  createMockEnv,
  makeCtx,
  withMockUpstream,
  openAIJsonBody,
  anthropicJsonBody,
  COHORT,
  PROFILE,
  USER,
  TEST_SECRET,
} from "./harness/index.mjs";

const app = await bootApp();
const { issue } = await import("../src/lib/tokens.ts");
const { getProfile } = await import("../src/profiles/index.ts");
const { buildAnthropicSystemBlocks } = await import("../src/lib/translate.ts");
const mod = await import("../src/lib/modules.ts");
const {
  MODULE_FORMAT,
  MODULE_VERSION_RE,
  CURRICULUM_MIN_CHARS,
  PIN_MEMO_MS,
  makeModuleDoc,
  validateModuleDoc,
  validatePin,
  resolveProfile,
  moduleDocKey,
  modulePinKey,
  sha256Hex,
  _resetModuleMemoForTests,
} = mod;

const { token: TOKEN } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET);
const AUTH = `Bearer ${TOKEN}`;

const base = getProfile(PROFILE);
assert.ok(base, "harness profile exists in the compiled registry");
const SIBLING = "sk-biopharm-kids-2026-grade-5-6-s1";
assert.ok(getProfile(SIBLING), "sibling profile exists");

const V1 = "m2026.09.04-1";
const V2 = "m2026.09.04-2";
const MARKER_V1 = "# [module v1 marker — 이 줄은 KV 에서 왔다]\n";
const MARKER_V2 = "# [module v2 marker — 두 번째 배포]\n";
// Real curriculum bytes + a marker on top, so the band/checksum are exercised on
// realistic content and the served text is still trivially recognisable.
const TEXT_V1 = MARKER_V1 + base.system_prompt;
const TEXT_V2 = MARKER_V2 + base.system_prompt;

const doc = (version, text, over = {}) =>
  makeModuleDoc({ kind: "curriculum", profileId: PROFILE, version, content: { system_prompt: text }, ...over });

function seed(env, { pin, docs = [] }) {
  for (const d of docs) env._kv.set(moduleDocKey("curriculum", d.profile_id, d.version), JSON.stringify(d));
  if (pin) env._kv.set(modulePinKey("curriculum", PROFILE), JSON.stringify(pin));
}

/** Capture console.error calls during fn(). */
async function captureErrors(fn) {
  const real = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = real;
  }
}

const compiledVersionOf = async (p) => `compiled:${(await sha256Hex(p.system_prompt)).slice(0, 12)}`;

// ─── 1. format: the drift lock ───────────────────────────────────────────────
{
  const good = await doc(V1, TEXT_V1, { notes: "test" });
  assert.equal(good.format, MODULE_FORMAT);
  assert.match(good.version, MODULE_VERSION_RE);
  const v = await validateModuleDoc(good, { kind: "curriculum", profileId: PROFILE, version: V1 });
  assert.equal(v.ok, true, "the builder's output passes the validator (양성 대조군)");

  // Forward compat: an unknown envelope field from a NEWER publisher is ignored.
  const withExtra = { ...good, future_field: { anything: 1 } };
  assert.equal((await validateModuleDoc(withExtra, { kind: "curriculum", profileId: PROFILE })).ok, true);

  const rejects = async (label, mutate) => {
    const d = JSON.parse(JSON.stringify(good));
    mutate(d);
    const r = await validateModuleDoc(d, { kind: "curriculum", profileId: PROFILE, version: V1 });
    assert.equal(r.ok, false, `${label} must be rejected`);
    assert.ok(r.reason.length > 10, `${label}: rejection names the problem (${r.reason})`);
    return r.reason;
  };
  await rejects("wrong format tag", (d) => (d.format = "hps-module/0"));
  await rejects("wrong kind", (d) => (d.kind = "session-design"));
  await rejects("wrong profile_id", (d) => (d.profile_id = SIBLING));
  await rejects("version not m*", (d) => (d.version = "v1.2.3"));
  await rejects("version/key mismatch", (d) => (d.version = V2));
  await rejects("bad published_at", (d) => (d.published_at = "yesterday"));
  await rejects("content not an object", (d) => (d.content = "x"));
  await rejects("sha256 not hex", (d) => (d.sha256 = "nope"));
  const r1 = await rejects("content edited after publish (checksum)", (d) => (d.content.system_prompt += " "));
  assert.match(r1, /sha256 mismatch/);
  const r2 = await rejects("truncated prompt (checksum catches it before the band)", (d) => {
    d.content.system_prompt = d.content.system_prompt.slice(0, 2000);
  });
  assert.match(r2, /sha256 mismatch/);

  // Band checks need a consistent checksum, so build real docs.
  const empty = await doc(V1, "");
  const e = await validateModuleDoc(empty, { kind: "curriculum", profileId: PROFILE });
  assert.equal(e.ok, false);
  assert.match(e.reason, new RegExp(`floor is ${CURRICULUM_MIN_CHARS}`));
  const notString = await makeModuleDoc({ kind: "curriculum", profileId: PROFILE, version: V1, content: { system_prompt: 42 } });
  assert.match((await validateModuleDoc(notString, { kind: "curriculum", profileId: PROFILE })).reason, /must be a string/);
  const nul = await doc(V1, TEXT_V1 + "\u0000");
  assert.match((await validateModuleDoc(nul, { kind: "curriculum", profileId: PROFILE })).reason, /NUL/);
  assert.equal((await validateModuleDoc(null, { kind: "curriculum", profileId: PROFILE })).ok, false);
  assert.equal((await validateModuleDoc("str", { kind: "curriculum", profileId: PROFILE })).ok, false);

  assert.equal(validatePin({ version: V1 }).ok, true);
  assert.equal(validatePin({ version: V1, previous: V2 }).ok, true);
  assert.equal(validatePin({ version: V1, previous: null }).ok, true);
  assert.equal(validatePin({ version: "latest" }).ok, false);
  assert.equal(validatePin({ version: V1, previous: "old" }).ok, false);
  assert.equal(validatePin("m2026.09.04-1").ok, false);
}
console.log("✓ module: hps-module/1 format — builder ⇄ validator drift lock, 14 rejection shapes");

// ─── 2. resolver: open on absence ────────────────────────────────────────────
{
  _resetModuleMemoForTests();
  const env = createMockEnv();
  const { result: r, lines } = await captureErrors(() => resolveProfile(env, PROFILE));
  assert.equal(r.module.source, "compiled");
  assert.equal(r.module.version, await compiledVersionOf(base));
  assert.match(r.module.version, /^compiled:[0-9a-f]{12}$/);
  assert.equal(r.module.fallback, undefined);
  assert.equal(r.profile.system_prompt, base.system_prompt, "no pin → the compiled text, untouched");
  assert.equal(r.profile, base, "no pin → the very same profile object (nothing copied, nothing lost)");
  assert.deepEqual(lines, [], "no pin is the normal state — no log noise");
  assert.equal(await resolveProfile(env, "no-such-profile"), null);
}
console.log("✓ module: no pin → compiled text, versioned by content hash, silent");

// ─── 3. resolver: pinned module is served ────────────────────────────────────
{
  _resetModuleMemoForTests();
  const env = createMockEnv();
  seed(env, { pin: { version: V1, pinned_at: new Date().toISOString() }, docs: [await doc(V1, TEXT_V1)] });
  const r = await resolveProfile(env, PROFILE);
  assert.equal(r.module.source, "kv");
  assert.equal(r.module.version, V1);
  assert.equal(r.module.fallback, undefined);
  assert.equal(r.profile.system_prompt, TEXT_V1, "system_prompt is the module's");
  // Everything that is NOT curriculum is still the compiled policy.
  assert.equal(r.profile.minor_cohort, base.minor_cohort);
  assert.deepEqual(r.profile.sdk_tools, base.sdk_tools);
  assert.deepEqual(r.profile.ux, base.ux);
  assert.equal(r.profile.id, base.id);
  assert.equal(base.system_prompt.startsWith(MARKER_V1), false, "the compiled registry object was not mutated");

  // Swap: publish V2 and re-pin (previous = V1). Next resolve after the memo
  // window serves V2.
  seed(env, { pin: { version: V2, previous: V1, pinned_at: new Date().toISOString() }, docs: [await doc(V2, TEXT_V2)] });
  const stillV1 = await resolveProfile(env, PROFILE);
  assert.equal(stillV1.module.version, V1, "inside the memo window the isolate keeps its pin");
  const later = Date.now() + PIN_MEMO_MS + 1;
  const nowV2 = await resolveProfile(env, PROFILE, later);
  assert.equal(nowV2.module.version, V2, "after the memo window the new pin is served — no code deploy");
  assert.equal(nowV2.profile.system_prompt, TEXT_V2);

  // Rollback = re-pin the previous version. Its doc is immutable and memoised.
  seed(env, { pin: { version: V1, previous: V2, pinned_at: new Date().toISOString() } });
  const back = await resolveProfile(env, PROFILE, later + PIN_MEMO_MS + 1);
  assert.equal(back.module.version, V1);
  assert.equal(back.profile.system_prompt, TEXT_V1);
}
console.log("✓ module: pin → served; re-pin → swapped within one memo window; rollback = re-pin previous");

// ─── 4. POSITIVE CONTROL — the cache prefix survives the module layer ────────
{
  _resetModuleMemoForTests();
  const env = createMockEnv();
  seed(env, { pin: { version: V1, pinned_at: new Date().toISOString() }, docs: [await doc(V1, TEXT_V1)] });

  const a = await resolveProfile(env, PROFILE);
  const b = await resolveProfile(env, PROFILE);
  for (const runtime of ["proxy", "sdk"]) {
    const pa = buildAnthropicSystemBlocks(a.profile, {}, runtime);
    const pb = buildAnthropicSystemBlocks(b.profile, {}, runtime);
    assert.equal(pa[0].text, pb[0].text, `${runtime}: two builds of the same version are byte-identical`);
    assert.deepEqual(pa[0].cache_control, { type: "ephemeral" }, `${runtime}: the breakpoint is still on the prefix`);
    assert.ok(pa[0].text.startsWith(MARKER_V1), `${runtime}: the prefix opens with the module text`);
    assert.equal(pa[0].text.includes(V1), false, `${runtime}: the version stamp is NOT in the prefix`);
    assert.equal(pa[0].text.includes("compiled:"), false);
  }

  // A transient KV failure must not flap the prefix back to the compiled text.
  const realGet = env.HPS_KV.get;
  env.HPS_KV.get = async () => {
    throw new Error("simulated KV outage");
  };
  const realWarn = console.warn;
  const warns = [];
  console.warn = (...x) => warns.push(x.map(String).join(" "));
  let duringOutage;
  try {
    duringOutage = await resolveProfile(env, PROFILE, Date.now() + PIN_MEMO_MS + 1);
  } finally {
    console.warn = realWarn;
    env.HPS_KV.get = realGet;
  }
  assert.equal(duringOutage.module.version, V1, "KV outage → last observed pin is served (no flap)");
  assert.equal(duringOutage.profile.system_prompt, TEXT_V1);
  assert.equal(
    buildAnthropicSystemBlocks(duringOutage.profile, {}, "sdk")[0].text,
    buildAnthropicSystemBlocks(a.profile, {}, "sdk")[0].text,
    "prefix bytes during the outage == prefix bytes before it",
  );
  assert.ok(warns.some((w) => w.includes("[module] KV read failed")), "…and the outage is logged");

  // Swapping the version DOES change the prefix (that one miss is the point —
  // it is a new curriculum), and it changes it deterministically.
  seed(env, { pin: { version: V2, previous: V1, pinned_at: new Date().toISOString() }, docs: [await doc(V2, TEXT_V2)] });
  const c = await resolveProfile(env, PROFILE, Date.now() + 2 * PIN_MEMO_MS + 2);
  const pc = buildAnthropicSystemBlocks(c.profile, {}, "sdk")[0].text;
  assert.notEqual(pc, buildAnthropicSystemBlocks(a.profile, {}, "sdk")[0].text);
  assert.ok(pc.startsWith(MARKER_V2));
  const c2 = await resolveProfile(env, PROFILE, Date.now() + 2 * PIN_MEMO_MS + 3);
  assert.equal(buildAnthropicSystemBlocks(c2.profile, {}, "sdk")[0].text, pc, "second build after the swap is identical → cacheable");
}
console.log("✓ module: POSITIVE — prefix byte-stable per version, no version stamp, no flap on KV outage");

// ─── 5. NEGATIVE CONTROL — malformed module: loud, self-contained, floored ───
{
  // 5a. pinned doc missing → compiled, announced.
  _resetModuleMemoForTests();
  const env = createMockEnv();
  seed(env, { pin: { version: V1, pinned_at: new Date().toISOString() } });
  const { result: r, lines } = await captureErrors(() => resolveProfile(env, PROFILE));
  assert.equal(r.module.source, "compiled");
  assert.equal(r.module.version, await compiledVersionOf(base));
  assert.deepEqual(r.module.fallback?.pinned, V1);
  assert.match(r.module.fallback.reason, /no document/);
  assert.equal(r.profile.system_prompt, base.system_prompt, "never an empty prompt — compiled is the floor");
  assert.ok(r.profile.system_prompt.length > CURRICULUM_MIN_CHARS);
  assert.equal(lines.length, 1, "exactly one console.error per (pin, served) — loud, not spam");
  assert.match(lines[0], /\[module\] curriculum for .* pinned m2026\.09\.04-1 is NOT servable/);
  assert.match(lines[0], /serving compiled:[0-9a-f]{12} instead/);
  const dp = env._datapoints.find((d) => d.blobs?.[0] === "module_fallback");
  assert.ok(dp, "an Analytics datapoint marks the fallback");
  assert.equal(dp.blobs[2], V1);
  assert.equal(dp.indexes[0], PROFILE);
  // Second resolve in the same window: served the same, NOT re-announced.
  const { lines: again } = await captureErrors(() => resolveProfile(env, PROFILE));
  assert.deepEqual(again, []);

  // 5b. pinned doc malformed, previous good → previous served, fallback recorded.
  _resetModuleMemoForTests();
  const env2 = createMockEnv();
  const badV2 = await doc(V2, TEXT_V2);
  badV2.content.system_prompt = badV2.content.system_prompt.slice(0, 3000); // truncated upload
  seed(env2, { pin: { version: V2, previous: V1, pinned_at: new Date().toISOString() }, docs: [await doc(V1, TEXT_V1), badV2] });
  const { result: r2, lines: l2 } = await captureErrors(() => resolveProfile(env2, PROFILE));
  assert.equal(r2.module.source, "kv");
  assert.equal(r2.module.version, V1, "falls to pin.previous");
  assert.equal(r2.profile.system_prompt, TEXT_V1);
  assert.equal(r2.module.fallback.pinned, V2);
  assert.match(r2.module.fallback.reason, /sha256 mismatch/);
  assert.equal(l2.length, 1);
  assert.match(l2[0], /pinned m2026\.09\.04-2 is NOT servable \(sha256 mismatch/);
  assert.match(l2[0], /serving m2026\.09\.04-1 instead/);

  // 5c. both bad → compiled.
  _resetModuleMemoForTests();
  const env3 = createMockEnv();
  seed(env3, { pin: { version: V2, previous: V1, pinned_at: new Date().toISOString() }, docs: [badV2] });
  const { result: r3 } = await captureErrors(() => resolveProfile(env3, PROFILE));
  assert.equal(r3.module.source, "compiled");
  assert.equal(r3.module.fallback.pinned, V2);
  assert.equal(r3.profile.system_prompt, base.system_prompt);

  // 5d. malformed PIN (not a version) → treated as unpinned, logged.
  _resetModuleMemoForTests();
  const env4 = createMockEnv();
  env4._kv.set(modulePinKey("curriculum", PROFILE), JSON.stringify({ version: "latest" }));
  const { result: r4, lines: l4 } = await captureErrors(() => resolveProfile(env4, PROFILE));
  assert.equal(r4.module.source, "compiled");
  assert.equal(r4.module.fallback, undefined);
  assert.equal(l4.length, 1);
  assert.match(l4[0], /pin is malformed/);

  // 5e. unparseable JSON at the doc key → rejected like any other bad doc.
  _resetModuleMemoForTests();
  const env5 = createMockEnv();
  seed(env5, { pin: { version: V1, pinned_at: new Date().toISOString() } });
  env5._kv.set(moduleDocKey("curriculum", PROFILE, V1), "{ not json");
  const { result: r5 } = await captureErrors(() => resolveProfile(env5, PROFILE));
  assert.equal(r5.module.source, "compiled");
  assert.equal(r5.module.fallback.pinned, V1);

  // 5f. CLOSED ON ERROR — a bad module for one profile is invisible to another.
  _resetModuleMemoForTests();
  const env6 = createMockEnv();
  seed(env6, { pin: { version: V1, pinned_at: new Date().toISOString() } }); // PROFILE: dangling pin
  const { result: sib, lines: l6 } = await captureErrors(() => resolveProfile(env6, SIBLING));
  assert.equal(sib.module.source, "compiled");
  assert.equal(sib.module.fallback, undefined, "sibling profile: no fallback, nothing to announce");
  assert.deepEqual(l6, []);
  assert.equal(sib.profile, getProfile(SIBLING));
}
console.log("✓ module: NEGATIVE — bad pin → previous → compiled, one loud line + datapoint, sibling untouched");

// ─── 6. end to end: the version is on the turn record, both routes ───────────
const chatRequest = (over = {}) =>
  new Request("https://api.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: AUTH },
    body: JSON.stringify({ model: "hypeproof-default", messages: [{ role: "user", content: "안녕" }], ...over }),
  });
const messagesRequest = () =>
  new Request("https://api.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: AUTH },
    body: JSON.stringify({ model: "claude-mock", max_tokens: 64, messages: [{ role: "user", content: "안녕" }] }),
  });

{
  // 6a. /v1/chat/completions (OpenAI-shape upstream): the system message the
  // upstream receives opens with the module text, the datapoint carries the
  // version, the response header names it, usage_log INSERT is unchanged.
  _resetModuleMemoForTests();
  const env = createMockEnv();
  seed(env, { pin: { version: V1, pinned_at: new Date().toISOString() }, docs: [await doc(V1, TEXT_V1)] });
  const ctx = makeCtx();
  await withMockUpstream(
    () => Response.json(openAIJsonBody({ content: "hi" })),
    async (calls) => {
      const r = await app.fetch(chatRequest(), env, ctx);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-hps-module"), V1, "x-hps-module on the JSON response");
      assert.equal(r.headers.get("x-hps-module-fallback"), null);
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.messages[0].role, "system");
      assert.ok(sent.messages[0].content.startsWith(MARKER_V1), "upstream got the MODULE curriculum");
      assert.equal(sent.messages[0].content.includes(V1), false, "…without a version stamp in it");
    },
  );
  await ctx.settle();
  const chatDp = env._datapoints.find((d) => d.blobs?.[1] === PROFILE && d.blobs?.[0] === USER);
  assert.ok(chatDp, "chat datapoint written");
  assert.equal(chatDp.blobs[5], V1, "blobs[5] = served module version");
  assert.equal(chatDp.blobs[6], "", "blobs[6] = no fallback");
  const ins = env._dbCalls.find((c) => /INSERT INTO usage_log/.test(c.sql));
  assert.ok(ins, "usage_log row still written");
  assert.equal(ins.bindings.length, 11, "usage_log INSERT shape unchanged (no migration in this task)");

  // 6b. Streaming: the raw Response carries the header too.
  const ctx2 = makeCtx();
  await withMockUpstream(
    () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
    async () => {
      const r = await app.fetch(chatRequest({ stream: true }), env, ctx2);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-hps-module"), V1, "x-hps-module on the streaming response");
    },
  );
  await ctx2.settle();

  // 6c. /v1/messages (Anthropic-native): system[0].text opens with module text.
  const envM = createMockEnv({ env: { ANTHROPIC_API_KEY: "k" } });
  seed(envM, { pin: { version: V1, pinned_at: new Date().toISOString() }, docs: [await doc(V1, TEXT_V1)] });
  const ctx3 = makeCtx();
  await withMockUpstream(
    () => Response.json(anthropicJsonBody({ text: "hi", cacheRead: 1234 })),
    async (calls) => {
      const r = await app.fetch(messagesRequest(), envM, ctx3);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-hps-module"), V1);
      const sent = JSON.parse(calls[0].init.body);
      assert.ok(sent.system[0].text.startsWith(MARKER_V1), "/v1/messages: system[0] is the module curriculum");
      assert.deepEqual(sent.system[0].cache_control, { type: "ephemeral" });
    },
  );
  await ctx3.settle();
  const mDp = envM._datapoints.find((d) => d.blobs?.[1] === PROFILE && d.blobs?.[0] === USER);
  assert.equal(mDp.blobs[5], V1);

  // 6d. GET /v1/profile names the module (no prompt text, as before).
  const rp = await app.fetch(
    new Request("https://api.test/v1/profile", { headers: { authorization: AUTH } }),
    env,
    makeCtx(),
  );
  assert.equal(rp.status, 200);
  const jp = await rp.json();
  assert.deepEqual(jp.module, { version: V1, source: "kv", fallback: null });
  assert.equal("system_prompt" in jp, false, "/v1/profile still never carries the prompt");
}
console.log("✓ module: e2e — both routes serve the module, record the version (blob[5]), header it, /v1/profile names it");

{
  // 6e. NEGATIVE e2e — dangling pin: the turn still runs on the compiled text,
  // the record says which pin failed, headers say so, and the log is loud.
  _resetModuleMemoForTests();
  const env = createMockEnv();
  seed(env, { pin: { version: V2, pinned_at: new Date().toISOString() } });
  const ctx = makeCtx();
  const compiledV = await compiledVersionOf(base);
  const { lines } = await captureErrors(() =>
    withMockUpstream(
      () => Response.json(openAIJsonBody({ content: "hi" })),
      async (calls) => {
        const r = await app.fetch(chatRequest(), env, ctx);
        assert.equal(r.status, 200, "a bad module never fails the turn");
        assert.equal(r.headers.get("x-hps-module"), compiledV);
        assert.equal(r.headers.get("x-hps-module-fallback"), V2);
        const sent = JSON.parse(calls[0].init.body);
        assert.ok(sent.messages[0].content.startsWith(base.system_prompt.slice(0, 200)), "compiled curriculum served");
        assert.ok(sent.messages[0].content.length > CURRICULUM_MIN_CHARS, "never empty");
      },
    ),
  );
  await ctx.settle();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /NOT servable/);
  const dp = env._datapoints.find((d) => d.blobs?.[1] === PROFILE && d.blobs?.[0] === USER);
  assert.equal(dp.blobs[5], compiledV);
  assert.equal(dp.blobs[6], V2, "blobs[6] = the pin that failed");
  assert.ok(env._datapoints.some((d) => d.blobs?.[0] === "module_fallback"));
}
console.log("✓ module: NEGATIVE e2e — turn runs on compiled, record + headers name the failed pin");

console.log("module-distribution: all green");
