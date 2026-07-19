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

// Presence proxies for the medical-ad-law disclaimer. Advisory only: we warn
// if none appears, but never re-inject (that would make Studio the owner of a
// legal string it does not author).
const DISCLAIMER_MARKERS = ["의료광고", "치료 효과"];

/**
 * Validate and, where safe, repair coach-generated HTML before it is shown.
 * Never throws; on any unexpected input it returns the text unchanged with
 * `blocked: false` so it can only ever ADD safety, never break the happy path.
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

  // 3. Advisory: medical-ad disclaimer presence (warn-only).
  if (!DISCLAIMER_MARKERS.some((m) => html.includes(m))) {
    issues.push("⚠️ 의료광고 면책 문구가 출력물에 보이지 않습니다 — 확인해 주세요.");
  }

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

/**
 * Rewrite a mistyped comment close back to `-->`, but ONLY when the comment is
 * genuinely unterminated: there is no `-->` before the next `<!--` (or EOF),
 * and a CSS-style close sits in that gap. A well-formed CSS/JS close (its own
 * comment balanced, and not inside an open `<!--`) is never rewritten.
 */
export function repairCommentCloseTypo(html: string): string {
  let out = html;
  let i = 0;
  for (;;) {
    const open = out.indexOf("<!--", i);
    if (open === -1) break;

    const close = out.indexOf("-->", open + 4);
    const nextOpen = out.indexOf("<!--", open + 4);
    const properlyClosed = close !== -1 && (nextOpen === -1 || close < nextOpen);
    if (properlyClosed) {
      i = close + 3;
      continue;
    }

    // Unterminated comment at `open`. Look for a `*/` (the mistyped close)
    // before the next comment opener / EOF.
    const gapEnd = nextOpen === -1 ? out.length : nextOpen;
    const typo = out.indexOf("*/", open + 4);
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
