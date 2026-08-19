// chat.ts integration tests over the FULL app (#255 A#11).
//
// Boots src/index.ts (requestId + signingSecretGuard + all routers in
// production mount order) with a mock Env and a scripted upstream LLM, then
// drives POST /v1/chat/completions end to end: auth → session/roster gates →
// provider call → response shaping → fire-and-forget usage/turn persistence.
//
// Run: node --experimental-strip-types test/chat-integration.test.mjs

import assert from "node:assert/strict";
import {
  bootApp,
  createMockEnv,
  makeCtx,
  withMockUpstream,
  openAIJsonBody,
  openAIStreamBody,
  sseResponse,
  TEST_SECRET,
  COHORT,
  PROFILE,
  USER,
} from "./harness/index.mjs";

const TRIAL_UUID = "11111111-2222-4333-8444-555555555555";

const app = await bootApp();
const { issue } = await import("../src/lib/tokens.ts");
const { token: TOKEN } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET);
const AUTH = `Bearer ${TOKEN}`;

function chatRequest({ prompt = "안녕 코치", stream = false, headers = {} } = {}) {
  return new Request("https://api.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: AUTH, ...headers },
    body: JSON.stringify({
      model: "hypeproof-default",
      stream,
      messages: [{ role: "user", content: prompt }],
    }),
  });
}

// --- 401: full app rejects a missing bearer, request-id middleware ran ------
{
  const env = createMockEnv();
  const ctx = makeCtx();
  const r = await app.fetch(
    new Request("https://api.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    }),
    env,
    ctx,
  );
  assert.equal(r.status, 401, "missing bearer → 401 through the full app");
  assert.ok(r.headers.get("x-request-id"), "requestId middleware stamped the response");
}

// --- 403: no active session --------------------------------------------------
{
  const env = createMockEnv({ withSession: false });
  const r = await app.fetch(chatRequest(), env, makeCtx());
  assert.equal(r.status, 403, "no session → 403");
  const j = await r.json();
  assert.equal(j.error.type, "session_inactive");
}

// --- 503: cohort kill-switch -------------------------------------------------
{
  const env = createMockEnv({ paused: true });
  const r = await app.fetch(chatRequest(), env, makeCtx());
  assert.equal(r.status, 503, "paused cohort → 503");
  const j = await r.json();
  assert.equal(j.error.type, "cohort_paused");
}

// --- 413 passthrough: oversized image → real 413 + request_too_large (#358) --
{
  const env = createMockEnv();
  await withMockUpstream(
    () => new Response("payload too large: image exceeds limit", { status: 413 }),
    async (calls) => {
      const r = await app.fetch(chatRequest({ prompt: "이 화면처럼 만들어줘" }), env, makeCtx());
      assert.equal(r.status, 413, "upstream 413 passes through — NOT masked as a generic 502");
      const j = await r.json();
      assert.equal(j.error.type, "request_too_large", "sanitized passthrough type");
      assert.doesNotMatch(
        JSON.stringify(j),
        /payload too large|exceeds limit/,
        "raw upstream prose stays in logs, never reaches the client",
      );
      assert.ok(j.error.request_id, "request_id surfaced for the operator");
      assert.equal(calls.length, 1, "exactly one upstream call (no retry on a permanent 4xx)");
    },
  );
}

// --- 5xx upstream → still OUR generic 502 gateway failure --------------------
{
  const env = createMockEnv();
  await withMockUpstream(
    () => new Response("boom", { status: 500 }),
    async () => {
      const r = await app.fetch(chatRequest(), env, makeCtx());
      assert.equal(r.status, 502, "upstream 5xx stays a 502 gateway failure (not passed through)");
      const j = await r.json();
      assert.equal(j.error.type, "upstream");
    },
  );
}

// --- 200 non-streaming: upstream JSON → OpenAI response + usage + turn row ---
{
  const env = createMockEnv({ trials: { [TRIAL_UUID]: { user_id: USER, cohort_id: COHORT } } });
  const ctx = makeCtx();
  const PROMPT = "삼각형 점프 게임 만들어줘";
  const REPLY = "좋아, 먼저 캔버스를 만들자!";

  await withMockUpstream(
    () => Response.json(openAIJsonBody({ content: REPLY, tokensIn: 21, tokensOut: 9 })),
    async (calls) => {
      const r = await app.fetch(
        chatRequest({
          prompt: PROMPT,
          headers: { "x-hps-trial-id": TRIAL_UUID, "x-hps-turn-idx": "3" },
        }),
        env,
        ctx,
      );
      assert.equal(r.status, 200, "happy path → 200");
      assert.ok(r.headers.get("x-hps-model"), "x-hps-model header set");
      const j = await r.json();
      assert.equal(j.object, "chat.completion");
      assert.equal(j.choices[0].message.content, REPLY, "upstream text forwarded");
      assert.equal(j.usage.prompt_tokens, 21);
      assert.equal(j.usage.completion_tokens, 9);

      // Upstream got exactly one call, to OpenAI, with the provider key.
      assert.equal(calls.length, 1, "exactly one upstream call");
      assert.match(calls[0].url, /api\.openai\.com/, "openai provider path used");
      assert.equal(calls[0].init.headers.authorization, "Bearer test-openai-key");
      // System prompt is injected by the worker, never taken from the client.
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.messages[0].role, "system", "profile system prompt injected");

      // Fire-and-forget persistence becomes assertable after ctx.settle().
      await ctx.settle();
      const usageInsert = env._dbCalls.find((c) => /INSERT INTO usage_log/.test(c.sql));
      assert.ok(usageInsert, "usage_log INSERT persisted");
      assert.equal(usageInsert.bindings[0], "sess-int-1", "usage row carries session_id");
      assert.equal(usageInsert.bindings[1], COHORT);
      assert.equal(usageInsert.bindings[2], USER);
      assert.ok(
        env._dbCalls.some((c) => /SELECT user_id, cohort_id FROM trials/.test(c.sql)),
        "trial ownership verified before the turn write",
      );
      const turnInsert = env._dbCalls.find((c) => /INSERT INTO turns/.test(c.sql));
      assert.ok(turnInsert, "turns INSERT persisted (trial headers present)");
      // (id, trial_id, turn_idx, prompt_chars, response_chars, tokens_in, tokens_out, ...)
      assert.equal(turnInsert.bindings[1], TRIAL_UUID);
      assert.equal(turnInsert.bindings[2], 3, "turn_idx from x-hps-turn-idx");
      assert.equal(turnInsert.bindings[3], PROMPT.length, "prompt_chars from last user message");
      assert.equal(turnInsert.bindings[4], REPLY.length, "response_chars from upstream text");
      assert.equal(turnInsert.bindings[5], 21);
      assert.equal(turnInsert.bindings[6], 9);
      assert.equal(env._datapoints.length, 1, "analytics datapoint written");
    },
  );
  console.log("✓ integration: non-streaming chat — 200 + usage_log + owned turn row");
}

// --- non-streaming without trial headers: no turn row, chat unaffected -------
{
  const env = createMockEnv();
  const ctx = makeCtx();
  await withMockUpstream(
    () => Response.json(openAIJsonBody({ content: "hi" })),
    async () => {
      const r = await app.fetch(chatRequest(), env, ctx);
      assert.equal(r.status, 200);
      await ctx.settle();
      assert.ok(
        !env._dbCalls.some((c) => /INSERT INTO turns/.test(c.sql)),
        "no trial headers → no turn row",
      );
      assert.ok(
        env._dbCalls.some((c) => /INSERT INTO usage_log/.test(c.sql)),
        "usage_log still persisted",
      );
    },
  );
  console.log("✓ integration: chat without trial headers — no turn row, usage still logged");
}

// --- unowned trial headers: turn silently dropped, response unaffected -------
{
  const env = createMockEnv({ trials: {} }); // ownership SELECT finds nothing
  const ctx = makeCtx();
  await withMockUpstream(
    () => Response.json(openAIJsonBody({ content: "hi" })),
    async () => {
      const r = await app.fetch(
        chatRequest({ headers: { "x-hps-trial-id": TRIAL_UUID, "x-hps-turn-idx": "0" } }),
        env,
        ctx,
      );
      assert.equal(r.status, 200, "chat response unaffected by ownership miss");
      await ctx.settle();
      assert.ok(
        !env._dbCalls.some((c) => /INSERT INTO turns/.test(c.sql)),
        "unowned trial → turn dropped (fail-soft)",
      );
    },
  );
  console.log("✓ integration: unowned trial headers — turn dropped, chat fail-soft");
}

// --- 200 streaming: SSE passthrough + asset_score + usage/turn persistence ---
{
  const env = createMockEnv({ trials: { [TRIAL_UUID]: { user_id: USER, cohort_id: COHORT } } });
  const ctx = makeCtx();
  await withMockUpstream(
    () => sseResponse(openAIStreamBody(["안녕! ", "시작해 볼까?"], { tokensIn: 15, tokensOut: 5 })),
    async () => {
      const r = await app.fetch(
        chatRequest({
          stream: true,
          headers: { "x-hps-trial-id": TRIAL_UUID, "x-hps-turn-idx": "0" },
        }),
        env,
        ctx,
      );
      assert.equal(r.status, 200, "streaming happy path → 200");
      assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
      const text = await r.text(); // drives the transform stream to completion
      assert.match(text, /안녕! /, "first delta forwarded");
      assert.match(text, /시작해 볼까\?/, "second delta forwarded");
      assert.match(text, /asset_score/, "asset_score chunk injected before [DONE]");
      assert.match(text, /data: \[DONE\]\n\n$/, "[DONE] terminates the stream");

      await ctx.settle();
      const usageInsert = env._dbCalls.find((c) => /INSERT INTO usage_log/.test(c.sql));
      assert.ok(usageInsert, "streaming usage persisted from the usage tap");
      assert.equal(usageInsert.bindings[5], 15, "tokens_in from upstream usage chunk");
      assert.equal(usageInsert.bindings[6], 5, "tokens_out from upstream usage chunk");
      const turnInsert = env._dbCalls.find((c) => /INSERT INTO turns/.test(c.sql));
      assert.ok(turnInsert, "streaming turn meta persisted");
      assert.equal(
        turnInsert.bindings[4],
        0,
        "streaming response_chars=0 (body capture is the human-gated A#1 remainder)",
      );
    },
  );
  console.log("✓ integration: streaming chat — SSE forwarded, usage tapped, turn meta row");
}

// --- GET /v1/profile through the full app ------------------------------------
{
  const env = createMockEnv();
  const r = await app.fetch(
    new Request("https://api.test/v1/profile", { headers: { authorization: AUTH } }),
    env,
    makeCtx(),
  );
  assert.equal(r.status, 200, "profile fetch → 200");
  const j = await r.json();
  assert.equal(j.profile_id, PROFILE, "profile resolved from token payload");
  assert.ok(!("system_prompt" in j), "system_prompt never leaves the worker");
  // #282 Phase 2 — sdk_tools is always present with explicit booleans.
  // 2026-08-11 — SK 아동 트랙은 커리큘럼 변경으로 read/write 를 opt-in 했다.
  // 나머지 셋은 여전히 false 로 정규화된다(absent → false, fail closed).
  assert.deepEqual(
    j.sdk_tools,
    { read: true, write: true, browser: false, subagents: false, shell: false },
    "kids profile: read/write opt-in, shell/browser/subagents 는 여전히 닫힘",
  );
  assert.equal(j.coach_runtime, "agent-sdk", "아동 트랙도 프로필 opt-in 시 agent-sdk 를 받는다");
  assert.equal(j.minor_cohort, true, "minor_cohort 는 그대로 true — 모더레이션 계층은 무관하게 유지");
}

// epic #431 — THE gap this suite existed to catch and didn't. The serializer in
// routes/chat.ts builds sdk_tools key-by-key, so a profile can set `shell: true`
// and it still never reaches the client. The client's permittedToolsFor reads
// only what arrives, so the entire grant goes inert — silently, with the profile
// looking correct. Found by probing prod AFTER a green deploy.
//
// Asserting the SERVED shape (not listProfiles()) is the point: profile-level
// tests pass either way. Every sdk_tools flag must be reachable end to end.
{
  const { listProfiles } = await import("../src/profiles/index.ts");
  const shellCohort = listProfiles().find((p) => p.sdk_tools?.shell === true);
  assert.ok(shellCohort, "at least one cohort opts into shell (fixture for this test)");

  const { token } = await issue(
    { u: USER, c: shellCohort.session.cohort_id, p: shellCohort.id },
    1,
    TEST_SECRET,
  );
  const r = await app.fetch(
    new Request("https://api.test/v1/profile", {
      headers: { authorization: `Bearer ${token}` },
    }),
    createMockEnv(),
    makeCtx(),
  );
  assert.equal(r.status, 200, "shell cohort profile fetch → 200");
  const j = await r.json();
  assert.equal(
    j.sdk_tools?.shell,
    true,
    `${shellCohort.id}: sdk_tools.shell must SURVIVE serialization — without it the app never grants Bash`,
  );
}
console.log("✓ #431: sdk_tools.shell survives the /v1/profile serializer");
console.log("✓ integration: GET /v1/profile — token-resolved, system_prompt withheld");

// --- #381: /v1/profile names WHY it failed -----------------------------------
//
// This is the first call a new participant's app makes, and for a while it was
// the last thing they saw: every failure came back shapeless, so the app could
// only say "확인이 안 돼요" for an expired token, an instructor token, and an
// unknown cohort alike. The app cannot classify what the server doesn't say.
{
  const { issueIssuer } = await import("../src/lib/tokens.ts");
  const env = createMockEnv();

  const profileReq = (tok) =>
    new Request("https://api.test/v1/profile", { headers: { authorization: `Bearer ${tok}` } });

  // expired
  const { token: dead } = await issue({ u: USER, c: COHORT, p: PROFILE }, -1, TEST_SECRET);
  const rExpired = await app.fetch(profileReq(dead), env, makeCtx());
  assert.equal(rExpired.status, 401);
  const jExpired = await rExpired.json();
  assert.equal(jExpired.error.code, "expired", "expired token is named 'expired'");
  assert.ok(jExpired.error.request_id, "carries request_id for support (#49)");

  // issuer token pasted into the participant box — used to be a bare 400
  // "unknown profile", because issuer payloads carry a placeholder p.
  const { token: issuerTok } = await issueIssuer(
    { issuer: "jay", scopes: [{ cohort: COHORT, profiles: [PROFILE] }] },
    1,
    TEST_SECRET,
  );
  const rIssuer = await app.fetch(profileReq(issuerTok), env, makeCtx());
  assert.equal(rIssuer.status, 401, "issuer token cannot open a participant session");
  assert.equal((await rIssuer.json()).error.code, "wrong_role");

  // a well-formed token pointing at a cohort this deploy doesn't know
  const { token: strayTok } = await issue(
    { u: USER, c: COHORT, p: "no-such-profile-id" },
    1,
    TEST_SECRET,
  );
  const rStray = await app.fetch(profileReq(strayTok), env, makeCtx());
  assert.equal(rStray.status, 400);
  assert.equal((await rStray.json()).error.code, "unknown_profile");

  // garbage in the box
  const rJunk = await app.fetch(profileReq("not-a-token"), env, makeCtx());
  assert.equal(rJunk.status, 401);
  assert.equal((await rJunk.json()).error.code, "malformed");
}
console.log("✓ #381: GET /v1/profile — every failure carries an actionable error.code");

console.log("All chat integration tests passed.");
