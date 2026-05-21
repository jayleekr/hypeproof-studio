// Smoke for issuer.html paste-sanitization + Korean error-mapping helpers
// (issue #65). Loads the HTML, extracts the inline <script> block, evals the
// pure-function helpers (no DOM dependencies), runs assertions.
//
// Run: node test/issuer-page.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(
  fileURLToPath(new URL("../src/ui/issuer.html", import.meta.url)),
  "utf8",
);

// Pull the helpers — they live between the start of the <script> block and
// the first `$("issuer").addEventListener` line, which is the first DOM-bound
// statement we cannot safely eval headlessly.
const scriptStart = html.indexOf("<script>");
const scriptEnd = html.indexOf("</script>", scriptStart);
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "could not locate <script> block");
const fullScript = html.slice(scriptStart + "<script>".length, scriptEnd);

// Find a DOM boundary line — keep only the pure top portion.
const domBoundary = fullScript.indexOf("// Persist issuer in sessionStorage");
assert.ok(domBoundary > 0, "expected helper block to precede sessionStorage line");
const pureSrc = fullScript.slice(0, domBoundary);

// Hoist into globalThis so we can call them from this test.
const harness = `
(function () {
  ${pureSrc}
  globalThis.__sanitizeToken = sanitizeToken;
  globalThis.__mapServerError = mapServerError;
  globalThis.__TOKEN_SHAPE = TOKEN_SHAPE;
})();
`;
// eslint-disable-next-line no-new-func
new Function(harness)();

const { __sanitizeToken: sanitize, __mapServerError: mapErr, __TOKEN_SHAPE: SHAPE } = globalThis;

const results = [];
function check(label, fn) {
  try { fn(); results.push({ label, ok: true }); console.log(`✅ ${label}`); }
  catch (err) { results.push({ label, ok: false, err: String(err) }); console.log(`❌ ${label}\n   ${err}`); }
}

// --- sanitizeToken --------------------------------------------------------

const VALID = "eyJjIjoiX19pc3N1ZXJfXyJ9.cxBAUiB6Z60NSy9vLlsrYSAhNiqC8ycmveEjXC0820s";

check("clean token passes through unchanged", () => {
  assert.equal(sanitize(VALID), VALID);
});

check("strips surrounding JSON double quotes", () => {
  assert.equal(sanitize(`"${VALID}"`), VALID);
});

check("strips surrounding single quotes + comma", () => {
  assert.equal(sanitize(`'${VALID}',`), VALID);
});

check("strips JSON object wrapping {...}", () => {
  assert.equal(sanitize(`{"${VALID}"}`), VALID);
});

check("strips array wrapping [...]", () => {
  assert.equal(sanitize(`[ "${VALID}" ]`), VALID);
});

check("strips leading/trailing whitespace", () => {
  assert.equal(sanitize(`   ${VALID}   `), VALID);
});

check("strips embedded newlines (\\n)", () => {
  const broken = VALID.slice(0, 40) + "\n" + VALID.slice(40);
  assert.equal(sanitize(broken), VALID);
});

check("strips embedded CRLF (Discord mobile line wrap)", () => {
  const broken = VALID.slice(0, 30) + "\r\n" + VALID.slice(30, 60) + "\r\n" + VALID.slice(60);
  assert.equal(sanitize(broken), VALID);
});

check("strips tabs", () => {
  const broken = "\t" + VALID.slice(0, 20) + "\t" + VALID.slice(20);
  assert.equal(sanitize(broken), VALID);
});

check("strips zero-width chars (clipboard injection)", () => {
  const broken = "​" + VALID + "﻿";
  assert.equal(sanitize(broken), VALID);
});

check("multiline JSON snippet collapses to clean token", () => {
  // This is the exact failure mode TJ hit — copying a token line out of a
  // pretty-printed JSON dump.
  const broken = `    "token": "${VALID}",`;
  // The leading `"token": ` is text, NOT just JSON sigil chars — our sanitizer
  // strips quotes/commas/whitespace from edges but leaves the inner `token:`
  // word intact. Verify it does NOT incorrectly accept this — the shape check
  // is the next line of defense.
  const out = sanitize(broken);
  // sanitize will strip outer ` "..." ,` and trim whitespace; whether the
  // `token:` prefix remains depends on whether `:` is in the sigil set.
  // We deliberately did NOT add `:` to the sigil set (would break base64url's
  // `+/` if we ever switched, and `:` isn't valid base64url anyway).
  // So this should still NOT match shape; the shape check rejects it.
  assert.ok(!SHAPE.test(out), `expected shape mismatch, got ${out.length}-char string`);
});

check("non-string input returns empty", () => {
  assert.equal(sanitize(null), "");
  assert.equal(sanitize(undefined), "");
  assert.equal(sanitize(42), "");
});

check("garbage string returns garbage (caller validates shape)", () => {
  assert.equal(sanitize("not-a-token"), "not-a-token");
  assert.ok(!SHAPE.test("not-a-token"));
});

check("shape regex accepts real token", () => {
  assert.ok(SHAPE.test(VALID));
});

check("shape regex rejects token with embedded space", () => {
  assert.ok(!SHAPE.test("eyJj. xyz"));
});

check("shape regex rejects token missing dot separator", () => {
  assert.ok(!SHAPE.test("eyJjxyz"));
});

// --- mapServerError -------------------------------------------------------

check("maps 'invalid signature' to paste-corruption Korean", () => {
  assert.match(mapErr("invalid issuer token: invalid signature"), /손상되었거나 잘못 복사/);
});

check("maps 'signature mismatch' phrasing too", () => {
  assert.match(mapErr("signature mismatch"), /손상되었거나/);
});

check("maps 'malformed token' to format guidance", () => {
  assert.match(mapErr("invalid issuer token: malformed token"), /형식이 잘못/);
});

check("maps 'token expired' to re-issue guidance", () => {
  assert.match(mapErr("invalid issuer token: token expired"), /유효기간이 만료/);
});

check("maps 'revoked' to new-token guidance", () => {
  assert.match(mapErr("issuer token revoked"), /무효화/);
});

check("maps 'not an issuer' to wrong-token-type guidance", () => {
  assert.match(mapErr("token is not an issuer"), /issuer 토큰이 아니/);
});

check("maps 'not scoped' to scope explanation", () => {
  assert.match(mapErr("issuer not scoped to (cohort=foo, profile=bar)"), /발급 권한 없는/);
});

check("maps 'exceeds scope max' to hours guidance", () => {
  assert.match(mapErr("requested 24h exceeds scope max 12h"), /최대 발급 시간을 초과/);
});

check("maps 'unsupported token version'", () => {
  assert.match(mapErr("invalid issuer token: unsupported token version: 1"), /버전이 안 맞/);
});

check("maps 'u (user handle) required'", () => {
  assert.match(mapErr("u (user handle) required (1-64 chars)"), /학생 정보/);
});

check("maps 'hours must be 1..1440'", () => {
  assert.match(mapErr("hours must be 1..1440 (60 days max)"), /1 이상 1440/);
});

check("unknown error passes through verbatim under 알 수 없는 prefix", () => {
  const out = mapErr("something completely new I haven't seen");
  assert.match(out, /알 수 없는 오류/);
  assert.match(out, /something completely new/);
});

check("null/undefined error message handled gracefully", () => {
  const out = mapErr(undefined);
  assert.match(out, /알 수 없는/);
});

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
