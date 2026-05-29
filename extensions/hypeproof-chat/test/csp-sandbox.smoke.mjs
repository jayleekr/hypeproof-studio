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
  const csp = buildPreviewShellCsp({ cspSource: CSP_SOURCE });

  // Required. Inner srcdoc inherits this CSP (CSP3 §4.2.3) regardless of
  // sandbox, so script-src MUST include 'unsafe-inline'/'unsafe-eval' or
  // every AI-generated game's click/key handler dies silently.
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, new RegExp(`script-src ${escapeRe(CSP_SOURCE)} 'unsafe-inline' 'unsafe-eval'`));
  assert.match(csp, /frame-src 'self' data: blob:/);
  assert.match(csp, new RegExp(`style-src ${escapeRe(CSP_SOURCE)} 'unsafe-inline'`));
  assert.match(csp, new RegExp(`connect-src ${escapeRe(CSP_SOURCE)}`));
  assert.match(csp, new RegExp(`img-src ${escapeRe(CSP_SOURCE)} data: blob:`));
  assert.match(csp, new RegExp(`base-uri ${escapeRe(CSP_SOURCE)}`));
  assert.match(csp, /object-src 'none'/);

  // Forbidden — exfil gate: connect/frame/img must not allow https: so
  // generated code can't phone home. (Inherited into inner CSP.)
  for (const dir of ["connect-src", "frame-src", "img-src", "media-src"]) {
    const m = csp.match(new RegExp(`${dir} [^;]+`));
    assert.ok(m, `${dir} must be present`);
    assert.doesNotMatch(m[0], / https:/, `${dir} must not include https:`);
  }
  // No wildcards anywhere
  assert.doesNotMatch(csp, /\*/, "wildcard star never legitimate");
  // No nonce: shell must not require a nonce since inner srcdoc inherits
  // and inline-script-heavy games have no nonce attribute.
  assert.doesNotMatch(csp, /'nonce-/, "shell must not use a nonce (would break inner inline scripts via inheritance)");

  console.log("✅ preview shell CSP: inline-permissive, exfil gates closed, no nonce");
}

// ─── Preview iframe sandbox — token set ────────────────────────────
{
  // Must include
  assert.match(PREVIEW_IFRAME_SANDBOX, /\ballow-scripts\b/);
  assert.match(PREVIEW_IFRAME_SANDBOX, /\ballow-pointer-lock\b/);
  assert.match(PREVIEW_IFRAME_SANDBOX, /\ballow-modals\b/);

  // allow-same-origin is DELIBERATELY forbidden — see cspBuilder.ts header
  // comment. With it, srcdoc inherits parent-shell CSP (CSP3 §4.2.2,
  // intersected with meta CSP), so the shell's `script-src 'nonce-XXX'`
  // blocks all inline scripts in the AI-generated game → rendered but inert.
  // Opaque-origin (no allow-same-origin) restores inline-script capability;
  // cost is CORS fetch/XHR to workspace assets.
  const forbidden = [
    "allow-same-origin",
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
      !new RegExp(`\\b${f}\\b`).test(PREVIEW_IFRAME_SANDBOX),
      `preview iframe sandbox must NOT include "${f}" (found in: "${PREVIEW_IFRAME_SANDBOX}")`,
    );
  }
  console.log(`✅ preview iframe sandbox: 3 allowed, ${forbidden.length} forbidden tokens absent (incl. same-origin)`);
}

// ─── Nonce uniqueness propagates (chat panel only — preview shell has no nonce)
{
  const csp1 = buildChatPanelCsp({ cspSource: CSP_SOURCE, nonce: "AAA" });
  const csp2 = buildChatPanelCsp({ cspSource: CSP_SOURCE, nonce: "BBB" });
  assert.notEqual(csp1, csp2);
  assert.match(csp1, /'nonce-AAA'/);
  assert.match(csp2, /'nonce-BBB'/);
  console.log("✅ chat panel nonce propagates into script-src");
}

// ─── Builders are pure (no side effects) ──────────────────────────
{
  const a = buildChatPanelCsp({ cspSource: CSP_SOURCE, nonce: NONCE });
  const b = buildChatPanelCsp({ cspSource: CSP_SOURCE, nonce: NONCE });
  assert.equal(a, b, "same inputs → same output");
  const c = buildPreviewShellCsp({ cspSource: CSP_SOURCE });
  const d = buildPreviewShellCsp({ cspSource: CSP_SOURCE });
  assert.equal(c, d, "preview shell same inputs → same output");
  console.log("✅ builders are pure");
}

console.log("\nAll CSP / sandbox smoke tests passed.");

// ─── Utility ──────────────────────────────────────────────────────
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
