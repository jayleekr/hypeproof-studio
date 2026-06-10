// Smoke test for #197 asset status aggregation/formatting.
// Run: node --experimental-strip-types test/asset-status.smoke.mjs

import assert from "node:assert/strict";

const {
  countSeenAssets,
  emptyAssetScores,
  formatAssetHistogramLines,
  formatAssetStatusText,
  mergeAssetScores,
} = await import("../src/assetStatus.ts");

{
  const scores = emptyAssetScores();
  assert.equal(countSeenAssets(scores), 0);
  assert.ok(formatAssetStatusText(scores).includes("7자산 0/7"));
  console.log("ok empty asset status starts at 0/7");
}

{
  const first = {
    ...emptyAssetScores(),
    intent_clarity: 0.5,
    verification_reflex: 0.8,
  };
  const second = {
    ...emptyAssetScores(),
    taste: 0.7,
    verification_reflex: 0.2,
    ownership: 0.34,
  };
  const merged = mergeAssetScores(first, second);
  assert.equal(merged.verification_reflex, 0.8, "cumulative score keeps the max value");
  assert.equal(countSeenAssets(merged), 4);

  const text = formatAssetStatusText(merged);
  assert.ok(text.includes("7자산 4/7"));
  assert.ok(text.includes("✓ Taste"));
  assert.ok(text.includes("◐ Intent"));
  assert.ok(text.includes("✓ Verify"));
  assert.ok(text.includes("◐ Own"));

  const lines = formatAssetHistogramLines(merged);
  assert.equal(lines.length, 7);
  assert.ok(lines.some((line) => line.includes("검증 습관") && line.includes("80%")));
  console.log("ok asset status accumulates max scores and formats markers/histogram");
}
