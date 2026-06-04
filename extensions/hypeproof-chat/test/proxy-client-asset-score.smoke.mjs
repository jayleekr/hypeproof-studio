// Smoke test for #204 asset_score SSE parsing.
// Run: node --experimental-strip-types test/proxy-client-asset-score.smoke.mjs

import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(specifier, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { proxyChat } = await import("../src/proxyClient.ts");

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

const realFetch = globalThis.fetch;
try {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "결정을 먼저 정하고 " } }] })}`,
    "",
    `data: ${JSON.stringify({
      type: "asset_score",
      version: 1,
      method: "heuristic-v1",
      scores: {
        taste: 0,
        intent_clarity: 0.5,
        context_design: 0,
        verification_reflex: 0.75,
        delegation_judgment: 0,
        iteration_reflex: 0,
        ownership: 0,
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  globalThis.fetch = async () => new Response(streamFromText(sse), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  let text = "";
  let score = null;
  await proxyChat({
    proxyUrl: "https://api.hypeproof-ai.xyz/v1",
    model: "hypeproof-default",
    token: "tok",
    history: [],
    userText: "테스트",
    signal: new AbortController().signal,
    onDelta: (delta) => { text += delta; },
    onAssetScore: (assetScore) => { score = assetScore; },
  });

  assert.equal(text, "결정을 먼저 정하고 ");
  assert.equal(score?.type, "asset_score");
  assert.equal(score?.version, 1);
  assert.equal(score?.scores?.verification_reflex, 0.75);
  console.log("ok proxyChat parses asset_score SSE chunks without disrupting deltas");
} finally {
  globalThis.fetch = realFetch;
}
