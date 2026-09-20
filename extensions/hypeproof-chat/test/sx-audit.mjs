// 렌더 DOM 감사 계측기 — 순수 판정 함수. DOM 없음, React 없음, vscode 없음.
//
// 요구: SX-35(금지 라벨 6개) · SX-43(관찰 레이어) · SX-51(숫자 카드) · SX-59(7자산 N/7 제거).
// 계약의 정본: docs/testing/studio-learning-experience.md §렌더 DOM 감사 계측기.
//   금지 문자열 목록의 정본은 요구 문서 SX-35·SX-59 다. 이 파일은 그 목록을 집행만 한다.
// 판정 규율: .claude/rules/verification.md — 특히 규칙 1(판정 기준을 세우기 전에 대상을
//   열어본다)과 규칙 2(대조군 없는 채점기는 신뢰하지 않는다). 대조군은 test/sx-audit.smoke.mjs.
//
// 설계 결정 세 가지와 그 근거:
//
//   (1) 허용 수치는 "마스킹" 으로 처리한다. 허용 패턴에 걸린 구간을 같은 길이의
//       제어 문자로 덮은 뒤 금지 수치를 찾는다. 길이를 보존하므로 findings 의
//       index 가 원문 좌표 그대로다. 검증 문서가 "3주차"·"남은 단계 2" 를 수치로
//       잡는 것을 계측기 결함이라고 못박았기 때문에, 허용은 예외 처리가 아니라
//       스캔 전 단계여야 한다.
//
//   (2) "점수"·"등급" 은 **부정문 면제**가 있는 soft 규칙이다. 오늘 출하되는 화면에
//       "점수" 가 두 번 나오는데 둘 다 표시가 아니라 부정이다:
//         webview-ui/src/NativeObservationPanel.tsx:57 "관찰은 점수나 능력 인증이 아닙니다."
//         webview-ui/src/LocalReview.tsx:41            "대화량은 역량 점수가 아닙니다."
//       memory "Korean regex single-char trap" 이 같은 형태로 이미 한 번 물렸다
//       (맨 /색/ 이 "검색" 을 잡았다). 그래서 면제는 **문장 단위**로 판정하고,
//       면제된 건은 버리지 않고 `exempt` 로 돌려준다 — 왜 통과했는지 설명할 수
//       없는 통과는 통과가 아니다.
//
//   (3) 맨 "상위" 규칙은 **싣지 않는다**(harness_undecided). "상위" 는 한국어 낱말의
//       부분 문자열로 흔하다 — 이 저장소 자체에 "최상위 규칙"(chatPanelHelpers.ts:298),
//       "최상위 type"(sdkCoachHelpers.ts:1744), "상위 provider 필드"(protocol.ts:142)가
//       있다. 대신 랭킹 표시로만 좁힌다: 숫자를 동반한 "상위 N(%/위/명/등)" 과
//       "상위 랭킹/순위". 좁힌 사실은 RANK_PATTERNS 주석과 보고서에 남긴다.

// ─── 규칙 표 ─────────────────────────────────────────────────────────────
// 모두 raw 원문을 스캔한다(마스킹된 텍스트가 아니라). 부정문 면제 없음.
/** SX-35 금지 라벨. "낮음 / 높음" 은 요구 문서에서 한 라벨이라 두 행으로 편다. */
export const BANNED_LABELS = [
  { id: "improvement_needed", label: "개선 필요", re: /개선\s*필요/g },
  { id: "low", label: "낮음", re: /낮음/g },
  { id: "high", label: "높음", re: /높음/g },
  { id: "top_percent", label: "상위 N%", re: /상위\s*\d+(?:\.\d+)?\s*%/g },
  { id: "capability_lacking", label: "역량 부족", re: /역량\s*부족/g },
  { id: "ai_master", label: "AI 활용 고수", re: /AI\s*활용\s*고수/g },
  { id: "growth_score", label: "성장 점수", re: /성장\s*점수/g },
];

/** 작업 화면 금지 문자열 중 부정문 면제가 필요 없는 것들(고유한 제품 라벨). */
export const BANNED_STRINGS = [
  { id: "seven_assets", label: "7자산", re: /7\s*자산/g },
  { id: "ai_dependence", label: "AI 의존도", re: /AI\s*의존도/g },
  { id: "ranking", label: "랭킹", re: /랭킹/g },
];

/** 부정문 면제가 있는 낱말 규칙. 같은 문장에 부정 표지가 있으면 면제된다. */
export const SOFT_STRINGS = [
  { id: "score_word", label: "점수", re: /점수/g },
  // 검증 문서는 "등급" 을 수치 목록에 적었지만 숫자가 없는 낱말이므로 여기서 집행한다.
  { id: "grade_word", label: "등급", re: /등급/g },
];

/**
 * 랭킹 표시. 맨 "상위" 는 싣지 않는다 — 위 (3) 참고. 마스킹된 텍스트를 스캔하므로
 * "상위 3주차" 같은 허용 수치와는 붙지 않는다.
 */
export const RANK_PATTERNS = [
  { id: "top_rank", label: "상위 N(%/위/명/등)", re: /상위\s*\d+(?:\.\d+)?\s*[%위명등]?/g },
  { id: "top_ranking", label: "상위 랭킹/순위", re: /상위\s*(?:랭킹|순위)/g },
];

/**
 * 금지 수치. **마스킹된 텍스트**를 스캔한다.
 * ratio_hundred 는 계획 문서 docs/plan/ux-dag.yaml P0-B 의 음성 대조군("52.5 / 100")이
 * 요구한다. 분모를 6·7·10·100 으로 좁힌 이유는 아래 ALLOWED_NUMERIC 주석에 있다.
 */
export const NUMERIC_PATTERNS = [
  { id: "points", label: "\\d+점", re: /\d+(?:\.\d+)?\s*점/g },
  { id: "percent", label: "\\d+%", re: /\d+(?:\.\d+)?\s*%/g },
  { id: "ratio_small", label: "\\d+/7 · \\d+/6", re: /\d+(?:\.\d+)?\s*\/\s*[67](?!\d)/g },
  { id: "ratio_hundred", label: "\\d+/10 · \\d+/100", re: /\d+(?:\.\d+)?\s*\/\s*(?:100|10)(?!\d)/g },
];

/**
 * 허용 수치. 금지 수치를 찾기 전에 같은 길이로 덮는다.
 *
 * 분모가 일반형(\d+/\d+)이 아닌 이유: 그러면 "9/20" 같은 날짜형이 점수로 잡힌다.
 * 반대로 날짜를 일반형(\d{1,2}/\d{1,2})으로 허용하면 "7자산 4/7" 이 날짜로 면제된다.
 * 둘 다 틀리므로 두 문서가 이름을 댄 분모(6·7·10·100)로만 좁혔다. 일반형 슬래시
 * 비율은 harness_undecided 로 남긴다(보고서에 기록).
 */
export const ALLOWED_NUMERIC = [
  { id: "week", label: "\\d+주차", re: /\d+\s*주차/g },
  { id: "steps_left", label: "남은 단계 \\d+", re: /남은\s*단계\s*\d+/g },
  { id: "date_numeric", label: "날짜(2026-09-20)", re: /\d{4}\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{1,2}\.?/g },
  { id: "date_ko", label: "날짜(9월 20일)", re: /\d{4}\s*년|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*월(?=\s|$)|\d{1,2}\s*일(?=\s|$)/g },
  { id: "time_clock", label: "시각(3:05)", re: /(?:오전|오후)?\s*\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?/g },
  { id: "time_ko", label: "시각(3시 5분)", re: /\d+\s*시간|\d+\s*시(?!\S)|\d+\s*분(?!\S)|\d+\s*초(?!\S)|\d+\s*일째/g },
  // SX-43: 관찰 패널의 "N건" 은 기록 범위 설명으로 남는다. 진행률이 아니다.
  { id: "count_ko", label: "N건 · N개", re: /\d+\s*건|\d+\s*개(?!선)|\d+\s*번째|\d+\s*명(?!\s*중)/g },
];

/** 같은 문장에 이 중 하나가 있으면 soft 규칙은 면제된다. */
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
 * 허용 수치 구간을 같은 길이의 제어 문자로 덮는다. 길이를 보존하므로 이후 스캔의
 * index 가 원문 좌표와 일치한다.
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

/** index 를 포함하는 문장(문장 경계 문자 사이)을 돌려준다. */
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
 * 한 영역의 본문 텍스트를 감사한다.
 *
 * @param {string} text  렌더된 **텍스트**(마크업이 아니라). sx-render.mjs 의 visibleText 로 뽑는다.
 * @param {object} [opts]
 * @param {"work"|"metric"|"label-only"} [opts.region="work"]
 *        work       — 금지 라벨 + 금지 문자열 + 랭킹 + soft 낱말 + 금지 수치 전부.
 *        metric     — SX-51 이 허용하는 숫자 주차(가격·GTM·지표)의 Work canvas. 수치 규칙만 끈다.
 *        label-only — 금지 라벨만. 아직 영역 분리가 확정되지 않은 화면에 쓴다.
 * @param {number} [opts.minLength=1]
 *        이 길이 미만이면 empty_region 으로 실패한다(verification.md 규칙 4:
 *        빈 문자열을 감사하는 계측기는 무엇이든 통과시킨다).
 * @returns {{ok: boolean, findings: Array<{kind: string, rule: string, match: string, index: number, label: string}>, exempt: Array, masked: Array, length: number}}
 */
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

  const { masked, spans } = maskAllowedNumerals(source);
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

  // 순서가 곧 우선순위다. 라벨이 먼저 자리를 잡으면 겹치는 낱말·수치 규칙은
  // 중복 계수하지 않는다 ("성장 점수" 는 1건이지 2건이 아니다).
  scan(BANNED_LABELS, "banned_label", source);
  if (region !== "label-only") {
    scan(BANNED_STRINGS, "banned_string", source);
    scan(RANK_PATTERNS, "banned_string", masked);
    scan(SOFT_STRINGS, "banned_string", source, { denialExempt: true });
  }
  if (region === "work") {
    scan(NUMERIC_PATTERNS, "banned_numeral", masked);
  }

  findings.sort((a, b) => a.index - b.index);
  return { ok: findings.length === 0, findings, exempt, masked: spans, length: source.length };
}

/**
 * CSS 에서 선택자별 custom property 만 뽑는다(중첩 규칙 없음 — 이 저장소의 토큰
 * 파일과 설계 문서의 코드 블록은 평평한 규칙만 쓴다).
 * SX-49 의 "토큰 값은 설계 문서가 소유한다" 를 기계적으로 대조하기 위한 순수 함수다.
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

/** 여러 영역을 한 번에. 영역 이름을 finding 에 붙여 어디서 나왔는지 남긴다. */
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
