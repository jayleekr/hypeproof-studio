// Copy lint — a pure judgement function. SX-11 (5 conversation-design situations) ·
// SX-12 (5 language rules and 5 phrasing-principle pairs).
//
// Canonical source of the contract: docs/requirements/studio-learning-experience.md
// SX-11 · SX-12.
// Canonical source of the counter-examples and examples:
// docs/design/ui-philosophy-2026-09-18.md §10 table and Appendix table.
// This file **only enforces** that list. It does not write new sentences.
//
// How this differs from sx-audit.mjs:
//   sx-audit   counts the **strings and numbers that must not be on screen**
//              (scores, grades, badges).
//   here       looks at the **shape** of the sentence — is it a sentence pattern
//              that evaluates a person, or one that settles a decision on the
//              student's behalf. It is caught even when the same words are absent.
//
// Why look at shape. §12's requirement is "평가형 형용사 대신 관찰 가능한 행동",
// "'당신은 ~한 사람' 대신 '이번 작업에서는 ~가 관찰됐다'". A banned-word list alone
// catches "문제 정의 역량이 낮습니다" but misses "당신은 검증에 약한 편이군요".
//
// Limits and how they are handled (recorded as harness_undecided):
//   This lint is a set of **Korean sentence-pattern rules**, not natural-language
//   understanding. It misses new evaluative sentence patterns outside the
//   counter-example list. So a pass from this lint does not mean "there is no bad
//   sentence pattern", it means "there is no known bad sentence pattern", and it
//   does not replace the human review of the source text in SX-T15 · T18. The
//   check result carries that fact along as `covers`.

/** The five §10 "나쁜 UX" sentences. A coach response that lands in this shape fails (SX-11). */
export const BAD_UX_SENTENCES = [
  { id: "define_for_student", text: "이 문제를 이렇게 정의하세요." },
  { id: "perfect_ship_it", text: "완벽합니다. 배포하세요." },
  { id: "price_decided", text: "$4.99가 적절합니다." },
  { id: "market_more", text: "마케팅을 더 하세요." },
  { id: "capability_improved", text: "검증 역량이 향상되었습니다." },
];

/** The five Appendix "피한다" sentences. Any screen copy in this shape fails (SX-12). */
export const AVOID_SENTENCES = [
  { id: "framing_low", text: "문제 정의 역량이 낮습니다" },
  { id: "verify_score", text: "검증 점수 62점" },
  { id: "adapt_improved", text: "적응 능력이 향상됐습니다" },
  { id: "ownership_held", text: "책임 역량 보류" },
  { id: "ai_skilled", text: "AI 활용 능숙" },
];

/** The five Appendix "쓴다" sentences. Positive control — if these get caught, the instrument is too strict. */
export const PREFERRED_SENTENCES = [
  "이번 작업에서는 완료 기준이 아직 적히지 않았어요.",
  "AI 결과를 원자료와 비교하고 수정 후 다시 확인했습니다.",
  "최근 3개 과제에서 사용자 반응 뒤 아이디어를 수정했습니다.",
  "운영 담당과 다음 확인일은 아직 정하지 않았습니다.",
  "AI에 맡긴 일과 직접 확인한 지점이 구분되어 있습니다.",
];

/**
 * Sentence-pattern rules. Do not judge on a single word — memory "Korean regex
 * single-char trap" (a bare /색/ matched "검색"). An evaluative word is caught
 * **only when it sits next to the thing being evaluated.**
 */
export const COPY_RULES = [
  {
    id: "capability_judged",
    label: "역량/능력을 사람에 대해 판정하는 문형",
    // "문제 정의 역량이 낮습니다", "검증 역량이 향상되었습니다", "적응 능력이 향상됐습니다"
    re: /(역량|능력)[이가]?\s*(낮|높|부족|우수|뛰어|향상|상승|개선|늘|줄)/g,
    why: "SX-12 (1)(2) — 평가형 형용사 대신 관찰 가능한 행동을, 사람에 대한 판정 대신 이번 작업에서 관찰된 것을 쓴다.",
  },
  {
    id: "capability_pending",
    label: "역량을 보류·유예로 표시하는 문형",
    re: /(역량|능력)\s*(보류|미달|불충분|미흡)/g,
    why: "SX-12 (1) · SX-33 — 근거가 없으면 0 이나 보류가 아니라 '아직 충분히 보지 못함' 이다.",
  },
  {
    id: "person_is_type",
    label: "'당신은 ~한 사람' 문형",
    re: /(당신|학생|너)[은는이가]?\s*[^.\n]{0,20}(한\s*사람|인\s*편|타입|스타일)/g,
    why: "SX-12 (2) — 사람의 유형이 아니라 이번 작업에서 관찰된 행동을 말한다.",
  },
  {
    id: "skill_label",
    label: "숙련도 라벨",
    re: /(활용|사용)\s*(능숙|미숙|고수|초보)/g,
    why: "SX-12 · SX-35 — 'AI 활용 능숙/고수' 는 사람에 대한 라벨이다.",
  },
  {
    id: "decide_for_student",
    label: "학생 대신 결정을 확정하는 문형",
    // "이 문제를 이렇게 정의하세요", "배포하세요", "마케팅을 더 하세요", "$4.99가 적절합니다"
    re: /(이렇게\s*정의하|그냥\s*이걸로\s*하|배포하세요|출시하세요|마케팅을\s*더\s*하)/g,
    why: "SX-06 · SX-11 — 코치는 답·대안·최종 선택을 대신하지 않는다. 질문·기준·비교 틀로 돌려준다.",
  },
  {
    id: "verdict_perfect",
    label: "완결 판정",
    re: /(완벽합니다|완벽해요|문제\s*없습니다\s*[.!]|이\s*답이\s*맞습니다)/g,
    why: "SX-11 — 초안이 왔을 때 할 말은 '어떤 결과여야 맞다고 볼지 먼저 정해볼까요?' 다.",
  },
  {
    id: "price_asserted",
    label: "가격을 코치가 확정하는 문형",
    re: /[$₩]\s?[\d,.]+\s*(이|가)\s*적절/g,
    why: "SX-11 — 누가 지불하는지부터 비교하게 한다. 숫자를 코치가 고르지 않는다.",
  },
];

const globalize = (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

/**
 * Judges one chunk of copy that students and instructors see.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.minLength=1] Shorter than this is an empty_region failure (rule 4).
 * @returns {{ok:boolean, findings:Array, covers:string}}
 */
export function lintCopy(text, opts = {}) {
  const { minLength = 1 } = opts;
  const source = typeof text === "string" ? text : "";
  const covers = "알려진 반례 문형만. 사람 원문 검토(SX-T15·T18)를 대신하지 않는다.";
  if (source.trim().length < minLength) {
    return {
      ok: false,
      covers,
      findings: [{
        rule: "empty_region",
        label: `본문 ${minLength}자 이상`,
        match: source,
        index: 0,
        why: "빈 문구를 검사하면 무엇이든 통과한다(verification.md 규칙 4).",
      }],
    };
  }
  const findings = [];
  for (const rule of COPY_RULES) {
    const re = globalize(rule.re);
    let m;
    while ((m = re.exec(source)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      findings.push({ rule: rule.id, label: rule.label, match: m[0], index: m.index, why: rule.why });
    }
  }
  findings.sort((a, b) => a.index - b.index);
  return { ok: findings.length === 0, findings, covers };
}

/** Does a coach-response sample carry a §10 "나쁜 UX" sentence **verbatim**? Exact string comparison. */
export function containsBadUxSentence(text) {
  const source = String(text ?? "");
  return BAD_UX_SENTENCES.filter((s) => source.includes(s.text)).map((s) => s.id);
}
