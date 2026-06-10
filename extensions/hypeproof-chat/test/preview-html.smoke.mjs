// Smoke tests for preview HTML helpers — base-href injection + attribute
// escape. The injection runs on every preview render and gets the iframe
// pointed at workspace assets. A bug here either breaks asset loading
// (cosmetic) OR opens an HTML-injection escape vector (security). Pure
// helpers, vscode-free. Run:
//   node --experimental-strip-types test/preview-html.smoke.mjs

import assert from "node:assert/strict";

const { injectBaseHref, escapeHtmlAttribute, injectInnerCsp, buildInnerCsp } =
  await import("../src/previewHtml.ts");

// ─── escapeHtmlAttribute ───────────────────────────────────────────
{
  // The six characters that can break out of double-quoted attribute values.
  // If any of these come through unescaped, an attacker can close the base
  // tag and inject arbitrary HTML.
  assert.equal(escapeHtmlAttribute(`"`), "&quot;");
  assert.equal(escapeHtmlAttribute(`'`), "&#39;");
  assert.equal(escapeHtmlAttribute(`<`), "&lt;");
  assert.equal(escapeHtmlAttribute(`>`), "&gt;");
  assert.equal(escapeHtmlAttribute(`&`), "&amp;");
  assert.equal(escapeHtmlAttribute("`"), "&#96;");

  // Encode order matters: ampersands must encode first so they don't
  // double-encode the entities we emit. Verify with mixed input.
  assert.equal(escapeHtmlAttribute(`a&"<b`), "a&amp;&quot;&lt;b");

  // Already-safe strings pass through unchanged
  assert.equal(escapeHtmlAttribute("abc-123/path"), "abc-123/path");

  console.log("✅ escapeHtmlAttribute: 6 dangerous chars encoded, no double-encoding");
}

// ─── injectBaseHref — happy path: <head> exists ───────────────────
{
  const html = `<!doctype html><html><head><title>x</title></head><body></body></html>`;
  const out = injectBaseHref(html, "https://webview.local/ws");
  // Trailing slash forced (otherwise "asset.png" resolves to parent dir).
  assert.match(out, /<base href="https:\/\/webview\.local\/ws\/">/);
  // Original <head> contents preserved
  assert.match(out, /<title>x<\/title>/);
  // Inserted right after <head> open, before <title>
  const headIdx = out.indexOf("<head>");
  const baseIdx = out.indexOf("<base ");
  const titleIdx = out.indexOf("<title>");
  assert.ok(headIdx < baseIdx && baseIdx < titleIdx, "base must sit between <head> and <title>");
  console.log("✅ injectBaseHref: happy path (head exists, trailing slash forced, ordering correct)");
}

// ─── injectBaseHref — fallback: no <head>, has <html> ─────────────
{
  const html = `<html><body><p>x</p></body></html>`;
  const out = injectBaseHref(html, "https://webview.local/ws/");
  assert.match(out, /<html><head><base href="https:\/\/webview\.local\/ws\/"><\/head><body>/);
  console.log("✅ injectBaseHref: no <head> → synthesizes head with base inside");
}

// ─── injectBaseHref — fallback: bare fragment ─────────────────────
{
  const html = `<p>just a fragment</p>`;
  const out = injectBaseHref(html, "https://webview.local/ws/");
  assert.equal(out, `<head><base href="https://webview.local/ws/"></head><p>just a fragment</p>`);
  console.log("✅ injectBaseHref: bare fragment → prepends head");
}

// ─── injectBaseHref — case + attribute insensitive on <head> match ─
{
  // Source HTML in the wild has <HEAD>, <head lang="en">, <Head>. All must
  // match — failing to match means we emit a duplicate <head> and the inner
  // page may end up with two heads (browsers tolerate, but it's ugly).
  for (const opener of ["<HEAD>", "<head>", "<Head>", `<head lang="en">`, `<head\n  data-x="y">`]) {
    const html = `<html>${opener}</head><body></body></html>`;
    const out = injectBaseHref(html, "https://x/");
    assert.match(out, /<base href="https:\/\/x\/">/);
    // Critically: exactly ONE <base> tag was inserted, not two
    assert.equal((out.match(/<base /gi) || []).length, 1,
      `expected exactly 1 base tag for opener ${JSON.stringify(opener)}`);
  }
  console.log("✅ injectBaseHref: matches <head> regardless of case/attributes");
}

// ─── SECURITY: attribute injection via baseHref string ────────────
{
  // The malicious scenario: somehow a webview URI string contains a quote.
  // asWebviewUri *should* URL-encode, but defense-in-depth: even if it
  // doesn't, the HTML-attr escape must prevent the breakout.
  const malicious = `https://x/abc"><script>window.parent.postMessage('pwned','*')</script><base href="`;
  const out = injectBaseHref(`<html><head></head><body></body></html>`, malicious);

  // The original characters must NOT appear unescaped — that would mean
  // the attacker closed our base tag and injected real <script>.
  assert.doesNotMatch(out, /"><script>/, "double-quote breakout must be escaped");
  assert.doesNotMatch(out, /<script>window\.parent/, "injected script must not survive");

  // Positive assertion: dangerous chars encoded
  assert.match(out, /&quot;/);
  assert.match(out, /&lt;script&gt;/);

  console.log("✅ injectBaseHref: HTML-attribute injection via baseHref blocked");
}

// ─── SECURITY: injecting nothing reasonable for ${nonce}-style payload ─
{
  // Attacker controls baseHref but tries to inject a `${jsString}` or
  // backtick template — these are JS-context concerns, not HTML, but defense-
  // in-depth: backtick should still be encoded so it can't open a template
  // literal if the value ever leaks into a JS string.
  const malicious = "https://x/`+alert(1)+`";
  const out = injectBaseHref(`<html><head></head></html>`, malicious);
  assert.doesNotMatch(out, /`\+alert/, "backtick injection must be encoded");
  assert.match(out, /&#96;/);
  console.log("✅ injectBaseHref: backtick encoded (JS-context defense-in-depth)");
}

// ─── injectBaseHref — idempotence-ish: trailing slash already present ──
{
  // Don't double-slash. "https://x/" + "/" should still be one slash.
  const out = injectBaseHref(`<html><head></head></html>`, "https://x/");
  assert.match(out, /href="https:\/\/x\/"/);
  assert.doesNotMatch(out, /href="https:\/\/x\/\/"/);
  console.log("✅ injectBaseHref: trailing slash not duplicated");
}

// ─── buildInnerCsp ────────────────────────────────────────────────
{
  const csp = buildInnerCsp("vscode-webview://abc");

  // Must grant unsafe-inline + unsafe-eval to scripts (AI-generated games
  // rely on inline <script> + canvas eval patterns; without these, click
  // handlers never bind and the preview looks rendered but inert).
  assert.match(csp, /script-src[^;]*'unsafe-inline'[^;]*'unsafe-eval'/);
  assert.match(csp, /script-src[^;]*vscode-webview:\/\/abc/);

  // Exfil gate: connect/frame/img must NOT include https: — generated code
  // must be unable to phone home via fetch/WebSocket/remote frame/1×1 GIF.
  for (const dir of ["connect-src", "frame-src", "img-src", "media-src"]) {
    const m = csp.match(new RegExp(`${dir} [^;]+`));
    assert.ok(m, `${dir} must be present`);
    assert.doesNotMatch(m[0], / https:/,
      `${dir} must NOT include https: (exfil gate)`);
  }

  // frame-src 'none' so the inner page can't nest its own iframes
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /object-src 'none'/);
  // base-uri MUST include cspSource so injected <base href> isn't blocked
  // (verified empirically — 'self' alone matches only about:srcdoc).
  assert.match(csp, /base-uri vscode-webview:\/\/abc/);

  console.log("✅ buildInnerCsp: inline+eval allowed, exfil gates closed");
}

// ─── injectInnerCsp — happy path ──────────────────────────────────
{
  const html = `<html><head><base href="x/"><title>g</title></head><body></body></html>`;
  const out = injectInnerCsp(html, "vscode-webview://uuid");
  // Meta CSP inserted right after <head>, BEFORE base (since both inject at
  // the same slot and CSP should be the very first child per spec).
  assert.match(out, /<head><meta http-equiv="Content-Security-Policy"/);
  const headIdx = out.indexOf("<head>");
  const cspIdx = out.indexOf("Content-Security-Policy");
  const baseIdx = out.indexOf("<base ");
  assert.ok(headIdx < cspIdx && cspIdx < baseIdx,
    "CSP meta must sit between <head> and <base>");
  // Original contents preserved
  assert.match(out, /<title>g<\/title>/);
  console.log("✅ injectInnerCsp: happy path (meta is first head child, contents preserved)");
}

// ─── injectInnerCsp — no head, has html ───────────────────────────
{
  const out = injectInnerCsp(`<html><body></body></html>`, "vscode-webview://uuid");
  assert.match(out, /<html><head><meta http-equiv="Content-Security-Policy"[^>]+><\/head><body>/);
  console.log("✅ injectInnerCsp: no head → synthesizes head with meta inside");
}

// ─── injectInnerCsp — bare fragment fallback ──────────────────────
{
  const out = injectInnerCsp(`<p>game</p>`, "vscode-webview://uuid");
  assert.match(out, /^<head><meta http-equiv="Content-Security-Policy"[^>]+><\/head><p>game<\/p>$/);
  console.log("✅ injectInnerCsp: bare fragment → prepends head");
}

// ─── SECURITY: cspSource attribute injection blocked ──────────────
{
  // cspSource is a vscode-webview://... URL in practice, but defense-in-depth:
  // even if a hostile string slips in, attribute escape must prevent breakout.
  const malicious = `vscode-webview://x"><script>alert(1)</script><meta x="`;
  const out = injectInnerCsp(`<html><head></head></html>`, malicious);
  assert.doesNotMatch(out, /"><script>/, "double-quote breakout must be escaped");
  assert.doesNotMatch(out, /<script>alert/, "injected script must not survive");
  // Browser will decode &quot; back to " inside the attribute value, so CSP
  // parser still receives the literal `"` — and a `"` inside a CSP directive
  // is just garbage that the parser ignores. No XSS, no shell escape.
  assert.match(out, /&quot;/);
  console.log("✅ injectInnerCsp: HTML-attribute injection via cspSource blocked");
}

console.log("\nAll preview-html smoke tests passed.");
