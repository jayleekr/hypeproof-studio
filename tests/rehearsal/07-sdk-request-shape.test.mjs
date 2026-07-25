// R7 — SDK request-shape contract against the LIVE gateway (#406).
//
// Why this file exists, in one sentence: on 2026-07-24 every agent-sdk coach
// turn was dying on an upstream 400 while the unit suite stayed green, because
// the unit suite mocks the Anthropic upstream and therefore cannot know what
// the real model accepts.
//
// The failure: the gateway OWNS the model (`resolveMessagesModel` rewrites the
// SDK's requested model into the cohort catalog) but forwarded the rest of the
// body spread-first. Claude Code CLI 2.x shapes its whole request for the model
// IT picked (a newer generation), so the upstream received "old pinned model +
// new generation's params" and 400'd. The SDK CLI swallowed that 400 in its own
// retry loop → the student saw an endless "생각하는 중… ✨" with no error
// (#403). A mocked upstream returns 200 for any body, so `messages-integration`
// asserted `context_management` "passes through untouched" and PASSED for weeks
// while production was dead.
//
// So this layer's job is exactly the part a mock cannot do: send the bytes the
// real SDK sends to the REAL gateway and assert the real upstream accepts them.
//
// This is a live-contract (R) test — it needs a workshop TOKEN for a cohort
// whose session is open. Without one every case skips, so it is safe to run
// anywhere. Mint one with:
//   TOKEN=$(bash worker/scripts/issue-boah-student.sh copyclone r7 1) \
//   WORKER_URL=https://api.hypeproof-ai.xyz/v1 npm run test:sdkshape

import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKER_URL, TOKEN } from "./helpers/env.mjs";
import { fetchJson, LLM_TIMEOUT_MS } from "./helpers/api.mjs";

const skip = !TOKEN && "TOKEN not set";

/**
 * The Agent SDK CLI's real request shape, captured from claude-cli/2.1.207 via
 * a logging sink. Only the parts that matter to the gateway contract are kept:
 * its OWN model id (the gateway must clamp it), and the generation-specific
 * params that ride along with it. `max_tokens` is small so the assertions are
 * about acceptance, not about burning classroom budget.
 */
function sdkShapedBody(extra = {}) {
  return {
    model: "claude-fable-5", // the CLI's own default — NOT our catalog
    max_tokens: 64,
    messages: [{ role: "user", content: "하이" }],
    ...extra,
  };
}

async function postMessages(body, { beta = true } = {}) {
  return fetchJson(`${WORKER_URL}/messages${beta ? "?beta=true" : ""}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      // The CLI sends this alongside the context_management body field; the
      // gateway merges it with its own betas (#282 e2e blocker).
      "anthropic-beta": "context-management-2025-06-27",
    },
    body: JSON.stringify(body),
    timeoutMs: LLM_TIMEOUT_MS,
  });
}

test("R7.1 — baseline SDK-shaped request is accepted and the model is clamped", { skip }, async () => {
  const r = await postMessages(sdkShapedBody());
  assert.equal(r.status, 200, `baseline SDK shape rejected: ${r.text.slice(0, 300)}`);
  // The clamp is the whole reason the rest of this file exists: prove it still
  // happens (a participant must never escalate to a model the profile didn't
  // list) while the request still succeeds.
  assert.notEqual(r.json?.model, "claude-fable-5", "client model must NOT reach upstream verbatim");
  assert.match(r.json?.model ?? "", /^claude-/, `unexpected model in response: ${JSON.stringify(r.json?.model)}`);
});

// Each case below is a param the CLI ships for its own model generation. Every
// one of these returned 400 from the live gateway before #406 and 200 after —
// that transition is exactly what this file locks.
const MODEL_GATED_CASES = [
  {
    name: "R7.2 — output_config{effort} (newer-generation effort control)",
    body: { output_config: { effort: "xhigh" } },
  },
  {
    name: "R7.3 — context_management{clear_thinking} (server-side context editing)",
    body: { context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } },
  },
  {
    name: "R7.4 — all of them at once, as the CLI actually sends them",
    body: {
      output_config: { effort: "xhigh" },
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      thinking: { type: "adaptive", display: "omitted" },
      metadata: { user_id: "rehearsal-device" },
    },
  },
];

for (const c of MODEL_GATED_CASES) {
  test(c.name, { skip }, async () => {
    const r = await postMessages(sdkShapedBody(c.body));
    assert.equal(
      r.status,
      200,
      `#406 regression — the gateway pinned a model that cannot accept this param ` +
        `and forwarded it anyway. Every agent-sdk turn 400s (and the SDK CLI hides it ` +
        `behind its retry loop, so the student just sees an endless spinner). ` +
        `Fix: add the param to MODEL_GATED_PARAMS in worker/src/routes/messages.ts, ` +
        `or repin the profile model to a generation that supports it. ` +
        `Upstream said: ${r.text.slice(0, 300)}`,
    );
  });
}

test("R7.5 — mid-conversation role:\"system\" survives (the #384 twin of this bug)", { skip }, async () => {
  // Same failure class, found first: the pinned models reject role:"system"
  // entries the CLI 2.x emits, so the gateway downgrades them to user context.
  // Kept here because a model repin could silently break the downgrade path.
  const r = await postMessages(
    sdkShapedBody({
      messages: [
        { role: "user", content: "안녕" },
        { role: "system", content: "Available agent types: ..." },
      ],
    }),
  );
  assert.equal(r.status, 200, `role:"system" no longer tolerated: ${r.text.slice(0, 300)}`);
});

test("R7.6 — count_tokens takes the same shape (SDK budgets against it)", { skip }, async () => {
  // The SDK calls count_tokens during the loop to budget context. It reuses the
  // messages body, so it inherits the same params — and a 400 here degrades the
  // SDK's budgeting just as silently.
  const body = sdkShapedBody({
    output_config: { effort: "xhigh" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  });
  delete body.max_tokens; // count_tokens has no max_tokens in its contract
  const r = await fetchJson(`${WORKER_URL}/messages/count_tokens?beta=true`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "context-management-2025-06-27",
    },
    body: JSON.stringify(body),
    timeoutMs: LLM_TIMEOUT_MS,
  });
  assert.equal(r.status, 200, `count_tokens rejected the SDK's shape: ${r.text.slice(0, 300)}`);
  assert.equal(
    typeof r.json?.input_tokens,
    "number",
    `count_tokens must return input_tokens: ${r.text.slice(0, 200)}`,
  );
});
