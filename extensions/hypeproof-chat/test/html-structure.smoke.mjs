// Smoke tests for the #359 post-generation structural guard. Pure — no vscode.
// Reproduces the copyclone V1→V2 corruption where an HTML comment close was
// mistyped `<!-- ── Footer ── */` (should be `-->`), leaving the comment
// unterminated so the footer + medical-ad disclaimer + slider <script> were
// swallowed to end of document.
// Run: node --experimental-strip-types test/html-structure.smoke.mjs

import assert from "node:assert/strict";

const {
  validateAndRepairHtml,
  hasUnterminatedComment,
  isScriptBalanced,
  repairCommentCloseTypo,
} = await import("../src/htmlStructure.ts");

// A V2-shaped document with the exact reported corruption: the footer comment
// closes with `*/` instead of `-->`, so everything after it is one open
// comment (footer, disclaimer, slider script, </body></html>).
const CORRUPTED = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>보아치과</title>
<style>.hero{color:#a33} /* warm palette */</style></head>
<body>
  <section class="hero"><h1>건강한 미소, 보아치과</h1></section>
  <!-- ── Footer ── */
  <footer>
    <p class="disclaimer">치료 효과를 단정하는 표현은 의료광고법상 사용이 제한됩니다.</p>
  </footer>
  <script>/* hero slider */ startSlider();</script>
</body></html>`;

// ─── 1. The reported bug: repaired, not blocked, footer/disclaimer survive ───
{
  const r = validateAndRepairHtml(CORRUPTED);
  assert.equal(r.repaired, true, "the */ typo must be auto-repaired");
  assert.equal(r.blocked, false, "after repair the document is well-formed → not blocked");
  assert.match(r.html, /── Footer ── -->/, "the mistyped */ became -->");
  assert.doesNotMatch(r.html, /── Footer ── \*\//, "no corrupted close remains");
  assert.equal(hasUnterminatedComment(r.html), false, "no open comment left");
  assert.ok(r.html.includes("의료광고법상"), "disclaimer text preserved");
  // The valid CSS comment close inside <style>/<script> must be untouched.
  assert.ok(r.html.includes("/* warm palette */"), "valid CSS */ untouched");
  assert.ok(r.html.includes("/* hero slider */"), "valid script /* */ untouched");
  assert.ok(
    r.issues.some((i) => i.includes("자동 복구")),
    "a repair note is surfaced",
  );
}

// ─── 2. Clean document: no issues, not blocked, unchanged ────────────────────
{
  const clean = CORRUPTED.replace("── Footer ── */", "── Footer ── -->");
  const r = validateAndRepairHtml(clean);
  assert.equal(r.repaired, false, "nothing to repair");
  assert.equal(r.blocked, false, "well-formed → not blocked");
  assert.equal(r.issues.length, 0, "no notes for a clean, compliant doc");
  assert.equal(r.html, clean, "clean HTML passes through byte-identical");
}

// ─── 3. Unterminated comment with no */ to fix → blocked ─────────────────────
{
  const broken = `<body><!-- open forever\n<footer>x</footer></body>`;
  const r = validateAndRepairHtml(broken);
  assert.equal(r.repaired, false, "no */ typo present → nothing to auto-repair");
  assert.equal(r.blocked, true, "residual unterminated comment blocks the reveal");
  assert.ok(
    r.issues.some((i) => i.includes("닫히지 않은 HTML 주석")),
    "blocks with a comment note",
  );
}

// ─── 4. Unbalanced <script> → blocked ────────────────────────────────────────
{
  const broken = `<body><p>치료 효과 관련 안내</p><script>doStuff();</body>`;
  const r = validateAndRepairHtml(broken);
  assert.equal(r.blocked, true, "missing </script> blocks");
  assert.ok(r.issues.some((i) => i.includes("script")), "script imbalance noted");
}

// ─── 5. Disclaimer absent + medicalAdCohort → advisory (not blocked) ─────────
{
  const noDisclaimer = `<!doctype html><html><body><h1>홈페이지</h1><footer>© 2026</footer></body></html>`;
  const r = validateAndRepairHtml(noDisclaimer, { medicalAdCohort: true });
  assert.equal(r.blocked, false, "missing disclaimer is advisory only, never blocks");
  assert.ok(
    r.issues.some((i) => i.includes("의료광고 면책")),
    "advisory disclaimer warning surfaced for a medical cohort",
  );
}

// ─── 5b. #364 — NON-medical cohort must NOT get the disclaimer warning ───────
{
  const kidsGame = `<!doctype html><html><body><h1>내 게임</h1><script>start()</script></body></html>`;
  const r = validateAndRepairHtml(kidsGame); // no medicalAdCohort flag
  assert.equal(r.blocked, false);
  assert.ok(
    !r.issues.some((i) => i.includes("의료광고")),
    "a kids game build must never see a medical-ad disclaimer warning",
  );
  // Structural checks still run for everyone:
  assert.equal(isScriptBalanced(r.html), true);
}

// ─── 6. Empty / non-string input → safe passthrough ──────────────────────────
{
  for (const bad of ["", null, undefined, 42]) {
    const r = validateAndRepairHtml(bad);
    assert.equal(r.blocked, false, `${String(bad)} must never block`);
    assert.equal(r.repaired, false, `${String(bad)} must never claim a repair`);
    assert.deepEqual(r.issues, [], `${String(bad)} produces no notes`);
  }
}

// ─── 7. Helper units ─────────────────────────────────────────────────────────
{
  assert.equal(hasUnterminatedComment("<!-- a --><!-- b -->"), false);
  assert.equal(hasUnterminatedComment("<!-- a --><!-- b"), true);
  assert.equal(hasUnterminatedComment("no comments here"), false);

  assert.equal(isScriptBalanced("<script>x</script>"), true);
  assert.equal(isScriptBalanced('<script src="a.js"></script><script>y</script>'), true);
  assert.equal(isScriptBalanced("<script>x"), false);

  // repairCommentCloseTypo only touches an unterminated comment's */.
  assert.equal(repairCommentCloseTypo("<!-- x */"), "<!-- x -->");
  assert.equal(repairCommentCloseTypo("<style>a{} /* ok */</style>"), "<style>a{} /* ok */</style>");
  assert.equal(repairCommentCloseTypo("<!-- x --><!-- y */"), "<!-- x --><!-- y -->");
}

console.log("html-structure.smoke.mjs — all assertions passed");
