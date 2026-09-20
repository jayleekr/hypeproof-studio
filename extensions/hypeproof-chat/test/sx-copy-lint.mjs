// 카피 lint — 순수 판정 함수. SX-11(대화 설계 5상황) · SX-12(언어 규칙 5개와 문구 원칙 5쌍).
//
// 계약의 정본: docs/requirements/studio-learning-experience.md SX-11 · SX-12.
// 반례·정례의 정본: docs/design/ui-philosophy-2026-09-18.md §10 표와 Appendix 표.
// 이 파일은 그 목록을 **집행만** 한다. 문장을 새로 짓지 않는다.
//
// sx-audit.mjs 와 무엇이 다른가:
//   sx-audit   화면에 **있으면 안 되는 문자열·수치**를 센다 (점수·등급·배지).
//   여기       문장의 **형태**를 본다 — 사람을 평가하는 문형인가, 학생 대신 결정을
//              확정하는 문형인가. 같은 낱말이 없어도 걸린다.
//
// 왜 형태를 보는가. §12 의 요구는 "평가형 형용사 대신 관찰 가능한 행동", "'당신은
// ~한 사람' 대신 '이번 작업에서는 ~가 관찰됐다'" 다. 금지어 목록만으로는 "문제 정의
// 역량이 낮습니다" 를 잡아도 "당신은 검증에 약한 편이군요" 를 놓친다.
//
// 한계와 그 처리 (harness_undecided 로 기록):
//   이 lint 는 **한국어 문형 규칙**이고 자연어 이해가 아니다. 반례 목록 밖의 새로운
//   평가 문형은 놓친다. 그래서 이 lint 의 통과는 "나쁜 문형이 없다" 가 아니라
//   "알려진 나쁜 문형이 없다" 는 뜻이고, SX-T15·T18 의 사람 원문 검토를 대신하지
//   않는다. 검사 결과에 그 사실을 `covers` 로 실어 보낸다.

/** §10 "나쁜 UX" 다섯 문장. 코치 응답이 이 형태로 끝나면 실패한다(SX-11). */
export const BAD_UX_SENTENCES = [
  { id: "define_for_student", text: "이 문제를 이렇게 정의하세요." },
  { id: "perfect_ship_it", text: "완벽합니다. 배포하세요." },
  { id: "price_decided", text: "$4.99가 적절합니다." },
  { id: "market_more", text: "마케팅을 더 하세요." },
  { id: "capability_improved", text: "검증 역량이 향상되었습니다." },
];

/** Appendix "피한다" 다섯 문장. 어떤 화면 문구도 이 형태면 실패한다(SX-12). */
export const AVOID_SENTENCES = [
  { id: "framing_low", text: "문제 정의 역량이 낮습니다" },
  { id: "verify_score", text: "검증 점수 62점" },
  { id: "adapt_improved", text: "적응 능력이 향상됐습니다" },
  { id: "ownership_held", text: "책임 역량 보류" },
  { id: "ai_skilled", text: "AI 활용 능숙" },
];

/** Appendix "쓴다" 다섯 문장. 양성 대조군 — 이것들이 걸리면 계측기가 너무 엄격하다. */
export const PREFERRED_SENTENCES = [
  "이번 작업에서는 완료 기준이 아직 적히지 않았어요.",
  "AI 결과를 원자료와 비교하고 수정 후 다시 확인했습니다.",
  "최근 3개 과제에서 사용자 반응 뒤 아이디어를 수정했습니다.",
  "운영 담당과 다음 확인일은 아직 정하지 않았습니다.",
  "AI에 맡긴 일과 직접 확인한 지점이 구분되어 있습니다.",
];

/**
 * 문형 규칙. 낱말 하나로 판정하지 않는다 — memory "Korean regex single-char trap"
 * (맨 /색/ 이 "검색" 을 잡았다). 평가 낱말은 **평가 대상과 붙어 있을 때만** 잡는다.
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
 * 학생·강사에게 보이는 문구 한 덩어리를 판정한다.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.minLength=1] 이보다 짧으면 empty_region 실패(규칙 4).
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

/** 코치 응답 시료가 §10 "나쁜 UX" 문장을 **그대로** 담고 있는가. 문자열 동일 비교. */
export function containsBadUxSentence(text) {
  const source = String(text ?? "");
  return BAD_UX_SENTENCES.filter((s) => source.includes(s.text)).map((s) => s.id);
}
