// Pure helpers for the preview HTML pipeline. Kept vscode-free so the
// injection / escape logic is unit-testable under plain Node. If a security
// check here is wrong, the .app still launches and renders happily — only a
// failing unit test surfaces the regression.

/**
 * HTML-attribute-escape a string. Encodes the subset that can break out of a
 * double-quoted attribute value: `&`, `"`, `<`, `>`, `'`. Backtick is also
 * encoded because IE used to treat it as an attribute delimiter.
 *
 * NOT a general HTML escape — only safe for use inside `attr="..."`.
 */
export function escapeHtmlAttribute(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;");
}

/**
 * Inject `<base href="${escaped(baseHref)}/">` as the first child of `<head>`
 * inside `html`. If no `<head>` exists (raw fragment), prepends a minimal
 * `<head><base ...></head>`.
 *
 * The trailing slash on baseHref matters — without it, `asset.png` resolves
 * against the *parent* of basePath instead of inside it.
 *
 * `baseHref` MUST already be a webview-loadable URL (e.g., the string form of
 * `webview.asWebviewUri(uri)`); this function does not validate or normalize
 * the URL itself, only escapes it for attribute insertion. Callers that pass
 * arbitrary user-controlled strings here would still get HTML-escape safety
 * (no `"><script>` breakout), but should resolve to a trusted scheme first.
 */
export function injectBaseHref(html: string, baseHref: string): string {
  const withSlash = baseHref.endsWith("/") ? baseHref : `${baseHref}/`;
  const baseTag = `<base href="${escapeHtmlAttribute(withSlash)}">`;
  // Match opening <head ...> tag (any attributes, any case) and inject right
  // after it. Doesn't disturb existing <head> contents.
  const headOpen = /<head\b[^>]*>/i;
  if (headOpen.test(html)) {
    return html.replace(headOpen, (m) => `${m}${baseTag}`);
  }
  // No <head>: try to insert just after <html ...>. Otherwise prepend.
  const htmlOpen = /<html\b[^>]*>/i;
  if (htmlOpen.test(html)) {
    return html.replace(htmlOpen, (m) => `${m}<head>${baseTag}</head>`);
  }
  return `<head>${baseTag}</head>${html}`;
}

/**
 * Build the inner-iframe CSP. AI-generated games rely on inline `<script>`
 * blocks and (occasionally) `eval`-style patterns (canvas loops, function
 * constructors), so we MUST grant `'unsafe-inline' 'unsafe-eval'` here —
 * without them the game's click/keyboard handlers never bind and the preview
 * looks rendered but inert.
 *
 * The exfil gate is `connect-src`/`frame-src`/`img-src`/etc. excluding
 * `https:` so generated code can't reach attacker.com via fetch, WebSocket,
 * remote frame, or 1×1 image beacon. Workspace assets are reachable via the
 * webview's own `cspSource` (vscode-webview://...).
 *
 * Why this is necessary: with `allow-same-origin` on the iframe sandbox,
 * `about:srcdoc` documents inherit the parent shell's CSP (CSP3 §4.2.2).
 * The shell's `script-src 'nonce-XXX'` would otherwise block every inline
 * script in the generated game.
 */
export function buildInnerCsp(cspSource: string): string {
  return [
    `default-src 'self' ${cspSource} data: blob:`,
    `script-src 'self' ${cspSource} 'unsafe-inline' 'unsafe-eval'`,
    `style-src 'self' ${cspSource} 'unsafe-inline'`,
    `img-src 'self' ${cspSource} data: blob:`,
    `media-src 'self' ${cspSource} data: blob:`,
    `font-src 'self' ${cspSource} data:`,
    `connect-src 'self' ${cspSource}`,
    `frame-src 'none'`,
    `object-src 'none'`,
    // base-uri must allow cspSource so the injected `<base href="${webview
    // URI}">` isn't blocked. 'self' alone matches only about:srcdoc, not
    // the webview-resource URL.
    `base-uri ${cspSource}`,
  ].join("; ");
}

/**
 * Inject `<meta http-equiv="Content-Security-Policy" content="...">` as the
 * first child of `<head>` so it takes effect before any inline script in the
 * inner page runs. Same insertion strategy as `injectBaseHref`.
 *
 * Call AFTER `injectBaseHref` so the meta tag ends up *before* `<base>` in
 * source order — both prepend right after `<head>`, so the last call wins
 * the leftmost slot. The CSP meta should be the very first child per spec
 * recommendation.
 */
export function injectInnerCsp(html: string, cspSource: string): string {
  const csp = buildInnerCsp(cspSource);
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`;
  const headOpen = /<head\b[^>]*>/i;
  if (headOpen.test(html)) {
    return html.replace(headOpen, (m) => `${m}${metaTag}`);
  }
  const htmlOpen = /<html\b[^>]*>/i;
  if (htmlOpen.test(html)) {
    return html.replace(htmlOpen, (m) => `${m}<head>${metaTag}</head>`);
  }
  return `<head>${metaTag}</head>${html}`;
}
