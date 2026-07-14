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
  // #282 Phase 2 — sdk_tools is always present with explicit booleans, and a
  // kids profile (no opt-in) normalizes to all-false (fail closed, minor-safe).
  assert.deepEqual(
    j.sdk_tools,
    { read: false, write: false, browser: false },
    "kids profile exposes sdk_tools all-false (absent flags normalize to false)",
  );
}
console.log("✓ integration: GET /v1/profile — token-resolved, system_prompt withheld");

console.log("All chat integration tests passed.");
