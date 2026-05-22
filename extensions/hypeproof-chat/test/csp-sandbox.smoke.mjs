// Smoke tests for CSP / iframe sandbox builders (#95 / REQ-D3·L1·L2).
// Pure helpers — no vscode host. Run:
//   node --experimental-strip-types test/csp-sandbox.smoke.mjs

import assert from "node:assert/strict";

const { buildChatPanelCsp, buildPreviewShellCsp, PREVIEW_IFRAME_SANDBOX } =
  await import("../src/cspBuilder.ts");

const CSP_SOURCE = "vscode-webview://abc-123";
const NONCE = "n0nc3-test";

// ─── Chat panel CSP — required directives ──────────────────────────
{
  const csp = buildChatPanelCsp({ cspSource: CSP_SOURCE, nonce: NONCE });

  // Required
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, new RegExp(`script-src 'nonce-${NONCE}' ${escapeRe(CSP_SOURCE)}`));
  assert.match(csp, new RegExp(`connect-src ${escapeRe(CSP_SOURCE)}`));
  assert.match(csp, new RegExp(`img-src ${escapeRe(CSP_SOURCE)} data:`));
  assert.match(csp, new RegExp(`style-src ${escapeRe(CSP_SOURCE)} 'unsafe-inline'`));
  assert.match(csp, new RegExp(`font-src ${escapeRe(CSP_SOURCE)}`));

  // Forbidden — these were never present, must never be added accidentally
  assert.doesNotMatch(csp, /connect-src .*https:/, "connect-src must not include https:");
  assert.doesNotMatch(csp, /unsafe-eval/, "must not include unsafe-eval");
  assert.doesNotMatch(csp, /\*/, "wildcard star is never legitimate in our CSP");
  assert.doesNotMatch(csp, /script-src .*'unsafe-inline'/, "scripts must be nonce-only");

  console.log("✅ chat panel CSP: required directives + forbidden absent");
}

// ─── Preview shell CSP — required directives ───────────────────────
{
  const csp = buildPreviewShellCsp({ cspSource: CSP_SOURCE, nonce: NONCE });

  // Required
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, new RegExp(`script-src 'nonce-${NONCE}'`));
  assert.match(csp, /frame-src 'self' data: blob:/);
  assert.match(csp, new RegExp(`style-src ${escapeRe(CSP_SOURCE)} 'unsafe-inline'`));

  // Forbidden
  assert.doesNotMatch(csp, /frame-src .*https:/, "frame-src must not include https: (no remote frames)");
  assert.doesNotMatch(csp, /default-src \*/, "wildcard default-src forbidden");
  assert.doesNotMatch(csp, /\*/, "wildcard star never legitimate");
  assert.doesNotMatch(csp, /unsafe-eval/);

  console.log("✅ preview shell CSP: required directives + forbidden absent");
}

// ─── Preview iframe sandbox — token set ────────────────────────────
{
  // Must include
  assert.match(PREVIEW_IFRAME_SANDBOX, /\ballow-scripts\b/);
  assert.match(PREVIEW_IFRAME_SANDBOX, /\ballow-pointer-lock\b/);
  assert.match(PREVIEW_IFRAME_SANDBOX, /\ballow-modals\b/);

  // Must NOT include — these are the threat-model breakers
  const forbidden = [
    "allow-same-origin",   // would let game read parent.acquireVsCodeApi()
    "allow-top-navigation",
    "allow-top-navigation-by-user-activation",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
    "allow-forms",
    "allow-downloads",
    "allow-storage-access-by-user-activation",
    "allow-presentation",
  ];
  for (const f of forbidden) {
    assert.ok(
      !PREVIEW_IFRAME_SANDBOX.includes(f),
      `preview iframe sandbox must NOT include "${f}" (found in: "${PREVIEW_IFRAME_SANDBOX}")`,
    );
  }
  console.log(`✅ preview iframe sandbox: 3 allowed, ${forbidden.length} forbidden tokens absent`);
}

// ─── Nonce uniqueness propagates ───────────────────────────────────
{
  const csp1 = buildChatPanelCsp({ cspSource: CSP_SOURCE, nonce: "AAA" });
  const csp2 = buildChatPanelCsp({ cspSource: CSP_SOURCE, nonce: "BBB" });
  assert.notEqual(csp1, csp2);
  assert.match(csp1, /'nonce-AAA'/);
  assert.match(csp2, /'nonce-BBB'/);
  console.log("✅ nonce propagates into script-src");
}

// ─── Builders are pure (no side effects) ──────────────────────────
{
  const a = buildChatPanelCsp({ cspSource: CSP_SOURCE, nonce: NONCE });
  const b = buildChatPanelCsp({ cspSource: CSP_SOURCE, nonce: NONCE });
  assert.equal(a, b, "same inputs → same output");
  console.log("✅ builders are pure");
}

console.log("\nAll CSP / sandbox smoke tests passed.");

// ─── Utility ──────────────────────────────────────────────────────
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
