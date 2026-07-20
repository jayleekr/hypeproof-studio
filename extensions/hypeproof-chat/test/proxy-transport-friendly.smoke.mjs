// Smoke tests for #358 friendly transport-error mapping. Pure — no vscode, no
// fetch. When the region-pinned Anthropic proxy rejects an oversized pasted
// image with 413, the webview should show a specific "image too large" message
// instead of the generic error card.
// Run: node --experimental-strip-types test/proxy-transport-friendly.smoke.mjs

import assert from "node:assert/strict";

const { friendlyTransportMessage, IMAGE_TOO_LARGE_FRIENDLY } = await import(
  "../src/proxyClientHelpers.ts"
);

// ─── 413 → specific, kid-friendly image-size message ─────────────────────────
{
  assert.equal(friendlyTransportMessage(413), IMAGE_TOO_LARGE_FRIENDLY);
  assert.match(IMAGE_TOO_LARGE_FRIENDLY, /이미지가 너무 커요/, "names the actual problem");
  // Never leak raw status/JSON/English error jargon at a 9-10 year old.
  assert.doesNotMatch(IMAGE_TOO_LARGE_FRIENDLY, /413|error|status|json/i, "no raw diagnostics");
}

// ─── Everything else → null → caller falls back to the generic card ──────────
{
  for (const s of [400, 422, 429, 500, 502, 529, 200]) {
    assert.equal(friendlyTransportMessage(s), null, `status ${s} has no special copy`);
  }
}

console.log("proxy-transport-friendly.smoke.mjs — all assertions passed");
