// #359 — post-generation structural guard for coach-built HTML.
//
// A copyclone V1→V2 iteration once mistyped an HTML comment close: the model
// wrote `<!-- ── Footer ── */` instead of `<!-- ── Footer ── -->`. The `*/`
// (a CSS/JS comment close) left the HTML comment unterminated, so the parser
// swallowed the whole footer — including the legally-required medical-ad
// disclaimer — plus the hero-slider <script>, to end of document. Nothing in
// the pipeline caught it; the coach declared "V2 완성" over a broken page.
//
// This module is a PURE, vscode-free validator run at the single reveal
// chokepoint (chatPanelProvider.revealBuilt). It:
//   1. auto-repairs the known `*/`→`-->` typo (only inside a genuinely
//      unterminated comment, so valid CSS `*/` is never touched),
//   2. blocks a still-broken document from being revealed as if it succeeded,
//   3. warns (advisory, no re-injection) if the medical-ad disclaimer text is
//      absent from the output.
//
// Design decisions (#359): auto-repair + block-and-warn on residual breakage;
// disclaimer is warn-only.

export interface HtmlStructureResult {
  /** Input HTML, possibly auto-repaired. Callers should render THIS, not the input. */
  html: string;
  /** An auto-fix was applied to reach `html`. */
  repaired: boolean;
  /** Still structurally broken after repair → caller must NOT treat as a success. */
  blocked: boolean;
  /** Human-readable notes (Korean) for surfacing in-chat. Empty when clean. */
  issues: string[];
}

/**
 * Validate and, where safe, repair coach-generated HTML before it is shown.
 * Never throws; on any unexpected input it returns the text unchanged with
 * `blocked: false` so it can only ever ADD safety, never break the happy path.
 *
 * Purely STRUCTURAL — repairs a broken comment close and blocks a document
 * that would render broken. No legal/medical-ad checks (removed per product
 * decision: the coach builds freely, legal review is the publisher's).
 */
export function validateAndRepairHtml(input: string): HtmlStructureResult {
  if (typeof input !== "string" || input.length === 0) {
    return { html: input, repaired: false, blocked: false, issues: [] };
  }

  const issues: string[] = [];

  // 1. Auto-repair the known corruption.
  const fixed = repairCommentCloseTypo(input);
  const repaired = fixed !== input;
  if (repaired) {
    issues.push("HTML 주석 닫기 오타(*/ → -->)를 자동 복구했습니다.");
  }
  const html = fixed;

  // 2. Structural balance (post-repair). These BLOCK the reveal.
  const commentUnterminated = hasUnterminatedComment(html);
  const scriptUnbalanced = !isScriptBalanced(html);
  if (commentUnterminated) {
    issues.push("닫히지 않은 HTML 주석(<!-- …)이 남아 있어 이후 내용이 렌더되지 않습니다.");
  }
  if (scriptUnbalanced) {
    issues.push("<script>와 </script> 짝이 맞지 않습니다.");
  }
  const blocked = commentUnterminated || scriptUnbalanced;

  return { html, repaired, blocked, issues };
}

/** True if some `<!--` has no `-->` after it. HTML comments do not nest. */
export function hasUnterminatedComment(html: string): boolean {
  let i = 0;
  for (;;) {
    const open = html.indexOf("<!--", i);
    if (open === -1) return false;
    const close = html.indexOf("-->", open + 4);
    if (close === -1) return true;
    i = close + 3;
  }
}

/** Balanced count of `<script …>` openers vs `</script>` closers. */
export function isScriptBalanced(html: string): boolean {
  const opens = (html.match(/<script\b[^>]*>/gi) ?? []).length;
  const closes = (html.match(/<\/script\s*>/gi) ?? []).length;
  return opens === closes;
}

// Ranges [start, end) covered by `<style>…</style>` and `<script>…</script>`.
// A `*/` inside these is a legitimate CSS/JS comment close and must NEVER be
// treated as a mistyped HTML-comment close (Jay review #364).
// (Line comments, not JSDoc: a literal `*/` would prematurely close a block.)
function styleScriptRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Two literals instead of a backreference (`\1` reads as an octal escape
  // under TS strict parsing). Body range = just inside the open tag to the
  // start of the close tag.
  for (const re of [
    /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,
    /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const bodyStart = m.index + m[0].indexOf(">") + 1;
      ranges.push([bodyStart, m.index + m[0].length]);
    }
  }
  return ranges;
}

function inRanges(pos: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([a, b]) => pos >= a && pos < b);
}

// Rewrite a mistyped comment close back to `-->`, but ONLY when the comment is
// genuinely unterminated AND the mistaken `*/` sits in ordinary markup — never
// inside a `<style>`/`<script>` body, where `*/` is a real CSS/JS comment close
// (Jay review #364: an unterminated comment BEFORE a stylesheet must not cause
// the stylesheet's `*/` to be silently rewritten). A well-formed CSS/JS close
// is never rewritten. (Line comments, not JSDoc — a literal `*/` would close a
// block comment early.)
export function repairCommentCloseTypo(html: string): string {
  let out = html;
  let i = 0;
  for (;;) {
    // Recompute per iteration: an earlier rewrite shifts later offsets.
    const ranges = styleScriptRanges(out);
    const open = out.indexOf("<!--", i);
    if (open === -1) break;

    const close = out.indexOf("-->", open + 4);
    const nextOpen = out.indexOf("<!--", open + 4);
    const properlyClosed = close !== -1 && (nextOpen === -1 || close < nextOpen);
    if (properlyClosed) {
      i = close + 3;
      continue;
    }

    // Unterminated comment at `open`. Look for the FIRST `*/` before the next
    // comment opener / EOF that is NOT inside a <style>/<script> body.
    const gapEnd = nextOpen === -1 ? out.length : nextOpen;
    let typo = out.indexOf("*/", open + 4);
    while (typo !== -1 && typo < gapEnd && inRanges(typo, ranges)) {
      typo = out.indexOf("*/", typo + 2);
    }
    if (typo !== -1 && typo < gapEnd) {
      out = out.slice(0, typo) + "-->" + out.slice(typo + 2);
      i = typo + 3;
      continue;
    }

    // No repairable typo here; advance past this opener so the structural
    // check (not this repair) decides whether to block.
    i = open + 4;
  }
  return out;
}
