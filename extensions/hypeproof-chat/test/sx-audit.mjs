// Render DOM audit instrument — pure decision functions. No DOM, no React, no vscode.
//
// Requirements: SX-35 (6 banned labels) · SX-43 (observation layer) · SX-51 (number cards) ·
//   SX-59 (remove the 7-asset N/7).
// Canonical contract: docs/testing/studio-learning-experience.md §렌더 DOM 감사 계측기.
//   The canonical banned-string list lives in the requirement doc, SX-35·SX-59. This file
//   only enforces that list.
// Decision discipline: .claude/rules/verification.md — especially rule 1 (open the thing you
//   are measuring before you write the criterion) and rule 2 (never trust a scorer without
//   controls). The controls are in test/sx-audit.smoke.mjs.
//
// Three design decisions and why:
//
//   (1) Allowed numerals are handled by "masking". Spans matched by an allow pattern are
//       covered with control characters of the same length, then the banned numerals are
//       searched for. Length is preserved, so a finding's index stays in original-text
//       coordinates. The verification doc nails down that flagging "3주차" / "남은 단계 2"
//       as a numeral is an instrument defect, so allowing must be a pre-scan stage, not
//       exception handling after the fact.
//
//   (2) "점수" / "등급" are soft rules with a **denial exemption**. "점수" appears twice on
//       today's shipped screens and both are denials, not displays:
//         webview-ui/src/NativeObservationPanel.tsx:57 "관찰은 점수나 능력 인증이 아닙니다."
//         webview-ui/src/LocalReview.tsx:41            "대화량은 역량 점수가 아닙니다."
//       The memory "Korean regex single-char trap" records getting bitten by exactly this
//       shape once already (a bare /색/ matched "검색"). So the exemption is decided **per
//       sentence**, and exempted hits are not discarded — they come back in `exempt`. A pass
//       you cannot explain is not a pass.
//
//   (3) A bare "상위" rule is **not shipped** (harness_undecided). "상위" is a common
//       substring of Korean words — this repo itself has "최상위 규칙"
//       (chatPanelHelpers.ts:298), "최상위 type" (sdkCoachHelpers.ts:1744) and
//       "상위 provider 필드" (protocol.ts:142). Narrow it to ranking displays instead:
//       "상위 N(%/위/명/등)" with a number, and "상위 랭킹/순위". The narrowing is recorded
//       in the RANK_PATTERNS comment and in the report.

// ─── Rule table ──────────────────────────────────────────────────────────
// All of these scan the raw source text (not the masked text). No denial exemption.
/** SX-35 banned labels. "낮음 / 높음" is one label in the requirement doc, so it is split into two rows. */
export const BANNED_LABELS = [
  { id: "improvement_needed", label: "개선 필요", re: /개선\s*필요/g },
  { id: "low", label: "낮음", re: /낮음/g },
  { id: "high", label: "높음", re: /높음/g },
  { id: "top_percent", label: "상위 N%", re: /상위\s*\d+(?:\.\d+)?\s*%/g },
  { id: "capability_lacking", label: "역량 부족", re: /역량\s*부족/g },
  { id: "ai_master", label: "AI 활용 고수", re: /AI\s*활용\s*고수/g },
  { id: "growth_score", label: "성장 점수", re: /성장\s*점수/g },
];

/** Banned work-screen strings that need no denial exemption (unique product labels). */
export const BANNED_STRINGS = [
  { id: "seven_assets", label: "7자산", re: /7\s*자산/g },
  { id: "ai_dependence", label: "AI 의존도", re: /AI\s*의존도/g },
  { id: "ranking", label: "랭킹", re: /랭킹/g },
];

/** Word rules with a denial exemption. Exempted when the same sentence carries a denial marker. */
export const SOFT_STRINGS = [
  { id: "score_word", label: "점수", re: /점수/g },
  // The verification doc lists "등급" under the numeral rules, but it is a word with no number,
  // so it is enforced here.
  { id: "grade_word", label: "등급", re: /등급/g },
];

/**
 * Ranking displays. A bare "상위" is not shipped — see (3) above. These scan the masked text,
 * so they never latch onto an allowed numeral such as "상위 3주차".
 */
export const RANK_PATTERNS = [
  { id: "top_rank", label: "상위 N(%/위/명/등)", re: /상위\s*\d+(?:\.\d+)?\s*[%위명등]?/g },
  { id: "top_ranking", label: "상위 랭킹/순위", re: /상위\s*(?:랭킹|순위)/g },
];

/**
 * Banned numerals. These scan the **masked text**.
 * ratio_hundred is required by the negative control ("52.5 / 100") in the plan doc
 * docs/plan/ux-dag.yaml P0-B. Why the denominator is narrowed to 6·7·10·100 is in the
 * ALLOWED_NUMERIC comment below.
 */
export const NUMERIC_PATTERNS = [
  { id: "points", label: "\\d+점", re: /\d+(?:\.\d+)?\s*점/g },
  { id: "percent", label: "\\d+%", re: /\d+(?:\.\d+)?\s*%/g },
  { id: "ratio_small", label: "\\d+/7 · \\d+/6", re: /\d+(?:\.\d+)?\s*\/\s*[67](?!\d)/g },
  { id: "ratio_hundred", label: "\\d+/10 · \\d+/100", re: /\d+(?:\.\d+)?\s*\/\s*(?:100|10)(?!\d)/g },
  // A hole caught in the 2026-09-20 evaluation. The four rules above only look at numerals
  // that carry a **unit**. So `레벨 3` · `Lv 3` · `★★★☆☆` and the bare, unitless number
  // `0.82` all passed. Those are the easiest way to put a score on the screen, so the rules
  // below are added.
  { id: "level", label: "레벨 N · Lv N", re: /(?:레벨|등급|Lv\.?|LEVEL)\s*\d+/gi },
  { id: "stars", label: "별점 ★☆", re: /[★☆✦✧]{3,}/g },
  {
    id: "bare_number",
    label: "단위 없는 맨숫자",
    // Numbers left over after masking. The allowed numerals (week, steps left, date, clock
    // time, N건/N개) are already covered with control characters, so a number that survives
    // this far is a number with no explanation attached. Numbers glued to Hangul or Latin
    // letters (shapes like GPT-4 or 3주차) are excluded by the boundary conditions.
    re: /(?<![\w가-힣])\d+(?:\.\d+)?(?![\w가-힣])/g,
  },
];

/**
 * Allowed numerals. Covered with an equal-length mask before the banned numerals are searched.
 *
 * Why the denominator is not the general form (\d+/\d+): that would flag a date shape like
 * "9/20" as a score. Conversely, allowing dates in the general form (\d{1,2}/\d{1,2}) would
 * exempt "7자산 4/7" as a date. Both are wrong, so it is narrowed to only the denominators the
 * two docs name (6·7·10·100). The general slash ratio is left as harness_undecided (recorded
 * in the report).
 */
export const ALLOWED_NUMERIC = [
  { id: "week", label: "\\d+주차", re: /\d+\s*주차/g },
  { id: "steps_left", label: "남은 단계 \\d+", re: /남은\s*단계\s*\d+/g },
  { id: "date_numeric", label: "날짜(2026-09-20)", re: /\d{4}\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{1,2}\.?/g },
  { id: "date_ko", label: "날짜(9월 20일)", re: /\d{4}\s*년|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*월(?=\s|$)|\d{1,2}\s*일(?=\s|$)/g },
  { id: "time_clock", label: "시각(3:05)", re: /(?:오전|오후)?\s*\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?/g },
  { id: "time_ko", label: "시각(3시 5분)", re: /\d+\s*시간|\d+\s*시(?!\S)|\d+\s*분(?!\S)|\d+\s*초(?!\S)|\d+\s*일째/g },
  // SX-43: the observation panel's "N건" stays as a description of the record's scope.
  // It is not a progress rate.
  { id: "count_ko", label: "N건 · N개", re: /\d+\s*건|\d+\s*개(?!선)|\d+\s*번째|\d+\s*명(?!\s*중)/g },
  // The two below were added because the real ChatPanel render got flagged **immediately**
  // after the `bare_number` rule went in. Both are normal product strings, not scores. This is
  // an error on the "instrument too strict" side, and it is exactly why the verification doc
  // calls the positive control the key one.
  //   1. List numbering — the `1.` in "이번 단계 안내 · 1. 기대 조건"
  //   2. Module version — the trailing `-1` in "버전 m2026.09.20-1".
  //      The pattern was not guessed: it was matched by reading MODULE_VERSION_RE at
  //      `worker/src/lib/modules.ts:146`.
  { id: "module_version", label: "모듈 버전 m2026.09.20-1", re: /m\d{4}\.\d{2}\.\d{2}-\d{1,4}/g },
  { id: "ordinal", label: "목록 번호 N.", re: /(?:^|[\n·]\s*)\d+\.(?=\s)/gm },
];

/**
 * Numerals allowed **in addition** only in the number weeks (week 4 pricing · week 5 GTM ·
 * week 6 metrics) — SX-51. Stacked on top of ALLOWED_NUMERIC when `region: "metric"`.
 * Scores, grades, star ratings and percentages are not here — a metrics week does not make
 * it acceptable to call a person by a score.
 */
export const METRIC_WEEK_NUMERIC = [
  { id: "money", label: "금액", re: /[$₩€£]\s?\d+(?:[,.]\d+)*|\d+(?:[,.]\d+)*\s*(?:원|달러|USD|KRW)/gi },
  { id: "people", label: "인원", re: /\d+\s*(?:명|인)(?!\s*중)/g },
  { id: "period", label: "기간", re: /\d+\s*(?:개월|주|일|년|분기)/g },
  { id: "ratio_metric", label: "전환·재방문 비율", re: /\d+(?:\.\d+)?\s*배/g },
];

/** If the same sentence contains one of these, the soft rules are exempted. */
export const DENIAL_MARKERS = [
  /아닙니다/,
  /아니다/,
  /아니에요/,
  /아니라/,
  /아니며/,
  /않습니다/,
  /않는다/,
  /않아요/,
  /없습니다/,
  /없어요/,
  /만들지\s*않/,
  /쓰지\s*않/,
  /매기지\s*않/,
];

const MASK_CHAR = "\u0001";
const SENTENCE_BOUNDARY = new Set([".", "!", "?", "。", "\n", "\r"]);

function globalize(re) {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

function* matchesOf(rule, haystack) {
  const re = globalize(rule.re);
  let m;
  while ((m = re.exec(haystack)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    yield { start: m.index, end: m.index + m[0].length };
  }
}

/**
 * Covers allowed-numeral spans with control characters of the same length. Length is preserved,
 * so indices from the later scans line up with original-text coordinates.
 */
export function maskAllowedNumerals(source, allow = ALLOWED_NUMERIC) {
  const chars = source.split("");
  const spans = [];
  for (const rule of allow) {
    for (const span of matchesOf(rule, source)) {
      spans.push({ rule: rule.id, ...span });
      for (let i = span.start; i < span.end; i += 1) chars[i] = MASK_CHAR;
    }
  }
  return { masked: chars.join(""), spans };
}

/** Returns the sentence containing `index` (between sentence-boundary characters). */
export function sentenceAt(source, index) {
  let start = Math.max(0, Math.min(index, source.length - 1));
  while (start > 0 && !SENTENCE_BOUNDARY.has(source[start - 1])) start -= 1;
  let end = Math.max(0, Math.min(index, source.length));
  while (end < source.length && !SENTENCE_BOUNDARY.has(source[end])) end += 1;
  return source.slice(start, Math.min(end + 1, source.length));
}

export function isDenialSentence(sentence) {
  return DENIAL_MARKERS.some((re) => re.test(sentence));
}

/**
 * Audits the body text of one region.
 *
 * @param {string} text  the rendered **text** (not the markup). Extract it with visibleText
 *        from sx-render.mjs.
 * @param {object} [opts]
 * @param {"work"|"metric"|"label-only"} [opts.region="work"]
 *        work       — banned labels + banned strings + ranking + soft words + banned
 *                     numerals, all of them.
 *        metric     — the Work canvas of the number weeks SX-51 allows (pricing · GTM ·
 *                     metrics). It does **not** turn the numeral rules off. Finding from the
 *                     2026-09-20 evaluation (D-3): turning them off wholesale means a real
 *                     score card landing in a metrics week goes uncaught. Instead, only the
 *                     shapes those weeks legitimately use (money · headcount · period ·
 *                     ratio) are added to the allow list, and scores, grades, star ratings
 *                     and bare numbers are still caught.
 *        label-only — banned labels only. Used on screens whose region split is not settled yet.
 * @param {number} [opts.minLength=1]
 *        below this length it fails as empty_region (verification.md rule 4: an instrument
 *        that audits an empty string passes anything).
 * @returns {{ok: boolean, findings: Array<{kind: string, rule: string, match: string, index: number, label: string}>, exempt: Array, masked: Array, length: number}}
 */
/**
 * SX-51 · rubric G — a screen has **one** Primary CTA.
 *
 * Without this rule P1 ended up with two (the first action in `MissionHeader` and
 * "이 과제 완료하기" in `ChatPanel`). It was invisible because the auditor was only looking at
 * text — two emphasized buttons means two "do this now"s, and that is what SX-01 exists to
 * prevent.
 *
 * Counts the rendered **markup**. A text dump does not keep the class.
 */
export function countPrimaryCta(html) {
  return String(html ?? "").match(/class="[^"]*\bhp-cta-primary\b/g)?.length ?? 0;
}

/** Is it one or fewer. Returns the count along with the verdict. */
export function auditPrimaryCta(html) {
  const count = countPrimaryCta(html);
  return { ok: count <= 1, count };
}

export function auditRegionText(text, opts = {}) {
  const { region = "work", minLength = 1 } = opts;
  const source = typeof text === "string" ? text : "";
  const findings = [];
  const exempt = [];

  if (source.trim().length < minLength) {
    findings.push({
      kind: "empty_region",
      rule: "min_length",
      label: `본문 ${minLength}자 이상`,
      match: source,
      index: 0,
      detail:
        typeof text === "string"
          ? `본문이 ${source.trim().length}자다 — 빈 영역을 감사하면 무엇이든 통과한다.`
          : `본문이 문자열이 아니다(${typeof text}).`,
    });
    return { ok: false, findings, exempt, masked: [], length: source.length };
  }

  // A metric week has a wider allow list — widen what is allowed, do not turn rules off.
  const allow = region === "metric" ? [...ALLOWED_NUMERIC, ...METRIC_WEEK_NUMERIC] : ALLOWED_NUMERIC;
  const { masked, spans } = maskAllowedNumerals(source, allow);
  const accepted = [];
  const overlaps = (start, end) => accepted.some((s) => start < s.end && s.start < end);

  const scan = (rules, kind, haystack, { denialExempt = false } = {}) => {
    for (const rule of rules) {
      for (const { start, end } of matchesOf(rule, haystack)) {
        if (overlaps(start, end)) continue;
        const match = source.slice(start, end);
        if (denialExempt) {
          const sentence = sentenceAt(source, start);
          if (isDenialSentence(sentence)) {
            exempt.push({ kind, rule: rule.id, label: rule.label, match, index: start, sentence: sentence.trim() });
            continue;
          }
        }
        accepted.push({ start, end });
        findings.push({ kind, rule: rule.id, label: rule.label, match, index: start });
      }
    }
  };

  // Order is priority. Once a label has taken its span, overlapping word and numeral rules do
  // not double-count it ("성장 점수" is 1 finding, not 2).
  scan(BANNED_LABELS, "banned_label", source);
  if (region !== "label-only") {
    scan(BANNED_STRINGS, "banned_string", source);
    scan(RANK_PATTERNS, "banned_string", masked);
    scan(SOFT_STRINGS, "banned_string", source, { denialExempt: true });
  }
  scan(NUMERIC_PATTERNS, "banned_numeral", masked);

  findings.sort((a, b) => a.index - b.index);
  return { ok: findings.length === 0, findings, exempt, masked: spans, length: source.length };
}

/**
 * Extracts only the custom properties, per selector, out of CSS (no nested rules — this repo's
 * token file and the design doc's code block use flat rules only).
 * A pure function for mechanically checking SX-49's "the design doc owns the token values".
 */
export function parseCssCustomProperties(css) {
  const stripped = String(css ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = {};
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = rule.exec(stripped)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    const decls = {};
    for (const decl of m[2].split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      const name = decl.slice(0, at).trim();
      if (!name.startsWith("--")) continue;
      decls[name] = decl.slice(at + 1).trim();
    }
    blocks[selector] = { ...(blocks[selector] ?? {}), ...decls };
  }
  return blocks;
}

/** Several regions at once. Tags each finding with the region name so its origin is recorded. */
export function auditRegions(regions, opts = {}) {
  const findings = [];
  const exempt = [];
  for (const [name, text] of Object.entries(regions)) {
    const r = auditRegionText(text, opts[name] ?? opts.default ?? {});
    for (const f of r.findings) findings.push({ region: name, ...f });
    for (const e of r.exempt) exempt.push({ region: name, ...e });
  }
  return { ok: findings.length === 0, findings, exempt };
}
