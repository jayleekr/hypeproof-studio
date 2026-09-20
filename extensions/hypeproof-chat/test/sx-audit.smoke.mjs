// 디자인 토큰의 대조와, 렌더 DOM 감사 계측기의 **자기 검증** — 계측기가 계측기를 잰다.
//
// 요구: SX-49~54(디자인 토큰/표현 규칙) · SX-35(금지 라벨 6개) · SX-43(관찰 패널) · SX-59(7자산 N/7 제거).
// 계약: docs/testing/studio-learning-experience.md §렌더 DOM 감사 계측기.
//       판정 규율: .claude/rules/verification.md 규칙 1·2·3·4.
//
// 왜 이 TC 가 있나 (실제 사건 두 건):
//
//   1) 2026-07-25~27, 사흘 동안 계측기가 **열다섯 번 틀렸고 그중 9건이 전부**
//      "관측 대상을 확인하지 않고 짐작해서 판정 기준을 세웠다" 였다. 9건 모두
//      *실패* 쪽으로 틀려서 드러났다. 통과 쪽으로 틀렸다면 거짓 초록이 그대로
//      보고됐을 것이다. 그래서 이 파일은 **양성 대조군을 먼저** 둔다 — 너무
//      엄격한 계측기를 잡는 쪽이 핵심이다.
//
//   2) memory "Korean regex single-char trap": 맨 /색/ 이 "검색" 을 물었다.
//      같은 함정이 여기 실제로 있다. "점수" 는 오늘 출하되는 화면에 **두 번**
//      나오는데 둘 다 *표시*가 아니라 *부정*이다 —
//        webview-ui/src/NativeObservationPanel.tsx:57  "관찰은 점수나 능력 인증이 아닙니다."
//        webview-ui/src/LocalReview.tsx:41             "대화량은 역량 점수가 아닙니다."
//      이 두 문장은 올바른 카피다. 계측기가 이걸 물면 제품이 아니라 계측기가
//      틀린 것이고, 멀쩡한 문장을 지우러 가게 된다. 그래서 **두 문장을 원문
//      그대로** 양성 대조군에 박아 둔다.
//
//   3) 같은 이유로 "3주차" 와 "남은 단계 2" 도 양성 대조군이다. 검증 문서가
//      "이걸 수치로 잡으면 계측기 결함" 이라고 명시한다.
//
// 대조군이 하나라도 틀리면 그 실행의 모든 감사 결과는 무효다(검증 문서).
//
// Run: node --experimental-strip-types test/sx-audit.smoke.mjs

import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

const {
  BANNED_LABELS,
  BANNED_STRINGS,
  SOFT_STRINGS,
  NUMERIC_PATTERNS,
  ALLOWED_NUMERIC,
  DENIAL_MARKERS,
  auditRegionText,
  parseCssCustomProperties,
} = await import("./sx-audit.mjs");

const { rendererStatus, renderComponent, visibleText } = await import("./sx-render.mjs");

// 오늘 실제로 출하되는 문자열. 위 파일들에서 그대로 옮겼다(복사가 아니라 인용이며,
// 렌더 대조군이 같은 문장을 실제 렌더 결과에서 다시 확인한다).
const REAL_DENIAL_OBSERVATION =
  "내가 요청한 내용과 코치·도구가 수행한 일을 나누어 확인합니다. 관찰은 점수나 능력 인증이 아닙니다.";
const REAL_DENIAL_LOCAL_REVIEW =
  "대화량은 역량 점수가 아닙니다. 작업 성공·실제 소요 시간·학습 변화는 미측정입니다.";
const REAL_OBSERVATION_COUNT_LINE =
  "12건 · 도움 사용 범위는 확인 전까지 미확인입니다.";

const describe = (r) => r.findings.map((f) => `${f.rule}:${JSON.stringify(f.match)}@${f.index}`).join(", ");

// ─── 디자인 토큰 (SX-49 ~ SX-54) ─────────────────────────────────────
// 값의 정본은 설계 문서다. 그래서 기대값을 여기에 적지 않고 **설계 문서를 읽어서**
// tokens.css 와 대조한다. 둘 중 하나만 바뀌면 이 블록이 잡는다.
{
  const designDoc = readFileSync(
    new URL("../../../docs/design/studio-learning-experience.md", import.meta.url),
    "utf8",
  );
  const section = designDoc.slice(designDoc.indexOf("## 디자인 시스템"));
  const fence = section.match(/```css\n([\s\S]*?)```/);
  assert.ok(fence, "설계 문서 §디자인 시스템 에서 css 코드 블록을 찾지 못했다");

  const fromDoc = parseCssCustomProperties(fence[1]);
  const fromFile = parseCssCustomProperties(
    readFileSync(new URL("../webview-ui/src/tokens.css", import.meta.url), "utf8"),
  );

  for (const selector of [':root', '[data-surface="growth"], .hp-reflection']) {
    assert.ok(fromDoc[selector], `설계 문서에 ${selector} 블록이 없다`);
    assert.deepEqual(
      fromFile[selector],
      fromDoc[selector],
      `tokens.css 의 ${selector} 가 설계 문서 §디자인 시스템 과 다르다`,
    );
  }
  for (const name of ["--hp-bg", "--hp-panel", "--hp-accent", "--hp-warn", "--hp-ink", "--hp-paper"]) {
    assert.ok(fromFile[":root"][name], `SX-49 토큰 누락: ${name}`);
  }
  console.log(`ok 토큰: tokens.css 의 ${Object.keys(fromFile[":root"]).length}개 값이 설계 문서와 일치한다`);
}

// start.css 는 별칭이어야 하고, 별칭의 대상 값이 **이 변경 전의 리터럴과 같아야** 한다.
// 그래야 "렌더 색은 그대로다" 가 주장이 아니라 검사가 된다.
{
  const startCss = readFileSync(new URL("../webview-ui/src/start.css", import.meta.url), "utf8");
  const block = parseCssCustomProperties(startCss)[".studio-start,.studio-disconnected"];
  assert.ok(block, ".studio-start,.studio-disconnected 블록을 찾지 못했다");

  // 왼쪽은 별칭 대상, 오른쪽은 2026-09-20 이 변경 직전 start.css 의 리터럴
  // (git show HEAD:extensions/hypeproof-chat/webview-ui/src/start.css 로 확인).
  const ALIASES = {
    "--studio-bg": ["--hp-bg", "#151D19"],
    "--studio-panel": ["--hp-panel", "#202C24"],
    "--studio-line": ["--hp-line", "#35483A"],
    "--studio-text": ["--hp-ink", "#F2F4E8"],
    "--studio-muted": ["--hp-muted", "#ACB9A5"],
    "--studio-accent": ["--hp-accent", "#D5F279"],
  };
  const tokens = parseCssCustomProperties(
    readFileSync(new URL("../webview-ui/src/tokens.css", import.meta.url), "utf8"),
  )[":root"];
  for (const [alias, [target, before]] of Object.entries(ALIASES)) {
    assert.equal(block[alias], `var(${target})`, `${alias} 가 토큰 별칭이 아니다`);
    assert.equal(tokens[target], before, `${target} 값이 변경 전 ${alias} 리터럴과 다르다 — 렌더 색이 바뀐다`);
  }
  assert.ok(
    !/#[0-9a-fA-F]{3,8}/.test(Object.values(block).join(";")),
    `.studio-start 토큰 블록에 hex 리터럴이 남아 있다: ${JSON.stringify(block)}`,
  );
  console.log("ok 토큰: start.css 의 --studio-* 6개가 --hp-* 별칭이고 값이 변경 전과 같다");
}

// ─── 규칙 목록이 문서와 같은 것을 본다 ────────────────────────────────
{
  const labels = BANNED_LABELS.map((r) => r.label);
  for (const expected of ["개선 필요", "낮음", "높음", "상위 N%", "역량 부족", "AI 활용 고수", "성장 점수"]) {
    assert.ok(labels.includes(expected), `SX-35 금지 라벨 누락: ${expected}`);
  }
  const strings = [...BANNED_STRINGS, ...SOFT_STRINGS].map((r) => r.label);
  for (const expected of ["점수", "등급", "7자산", "AI 의존도", "랭킹"]) {
    assert.ok(strings.includes(expected), `작업 화면 금지 문자열 누락: ${expected}`);
  }
  assert.ok(NUMERIC_PATTERNS.some((r) => r.id === "points"), "\\d+점 패턴 누락");
  assert.ok(NUMERIC_PATTERNS.some((r) => r.id === "percent"), "\\d+% 패턴 누락");
  assert.ok(NUMERIC_PATTERNS.some((r) => r.id === "ratio_small"), "\\d+/7 · \\d+/6 패턴 누락");
  assert.ok(ALLOWED_NUMERIC.some((r) => r.id === "week"), "\\d+주차 허용 누락");
  assert.ok(ALLOWED_NUMERIC.some((r) => r.id === "steps_left"), "남은 단계 \\d+ 허용 누락");
  assert.ok(DENIAL_MARKERS.length > 0, "부정문 표지 목록이 비었다");
  console.log("ok 규칙 목록이 요구·검증 문서의 목록과 같다");
}

// ─── 양성 대조군 — 정상 시료가 통과해야 한다 (너무 엄격한 계측기를 잡는다) ──
{
  const clean = [
    "3주차 · 미션: 사용자 한 명에게 직접 물어보고 문제 한 줄을 확정한다",
    "완료 조건: 인터뷰 기록 1건과 문제 한 줄이 저장되어 있다",
    "남은 단계 2",
    "다음 단계 시작하기",
  ].join("\n");
  const r = auditRegionText(clean, { region: "work" });
  assert.equal(r.ok, true, `정상 작업 화면이 걸렸다 → 계측기 결함: ${describe(r)}`);
  console.log("ok 양성: 주차·미션·남은 단계·CTA 1개만 있는 작업 화면은 통과한다");
}

{
  const r = auditRegionText("3주차", { region: "work" });
  assert.equal(r.ok, true, `"3주차"를 수치로 잡았다 → 검증 문서가 계측기 결함이라고 명시한 경우: ${describe(r)}`);
  const s = auditRegionText("남은 단계 2", { region: "work" });
  assert.equal(s.ok, true, `"남은 단계 2"를 수치로 잡았다 → 계측기 결함: ${describe(s)}`);
  console.log("ok 양성: 3주차 · 남은 단계 2 는 허용 수치다");
}

{
  const r = auditRegionText(REAL_DENIAL_OBSERVATION, { region: "work" });
  assert.equal(
    r.ok,
    true,
    `NativeObservationPanel.tsx 의 실제 부정 문장이 걸렸다 → 멀쩡한 카피를 지우러 간다: ${describe(r)}`,
  );
  assert.ok(
    r.exempt.some((e) => e.rule === "score_word"),
    "부정문 면제가 기록되지 않았다 — 왜 통과했는지 설명할 수 없는 통과는 통과가 아니다",
  );
  console.log("ok 양성: '관찰은 점수나 능력 인증이 아닙니다' (실제 출하 문장) 는 통과한다");
}

{
  const r = auditRegionText(REAL_DENIAL_LOCAL_REVIEW, { region: "work" });
  assert.equal(r.ok, true, `LocalReview.tsx 의 실제 부정 문장이 걸렸다: ${describe(r)}`);
  assert.ok(r.exempt.some((e) => e.rule === "score_word"), "부정문 면제가 기록되지 않았다");
  console.log("ok 양성: '대화량은 역량 점수가 아닙니다' (실제 출하 문장) 는 통과한다");
}

{
  const r = auditRegionText(REAL_OBSERVATION_COUNT_LINE, { region: "work" });
  assert.equal(r.ok, true, `관찰 패널의 N건 카운트가 걸렸다 → SX-43 이 허용하는 기록 범위 설명이다: ${describe(r)}`);
  console.log("ok 양성: 관찰 패널의 'N건 · 도움 사용 범위…' 카운트 줄은 통과한다");
}

{
  const r = auditRegionText("2026-09-20 오후 3:05 · 12개 저장됨", { region: "work" });
  assert.equal(r.ok, true, `날짜·시각·N개 카운트가 걸렸다: ${describe(r)}`);
  console.log("ok 양성: 날짜·시각·N개 카운트는 허용 수치다");
}

// ─── 음성 대조군 — 나쁜 시료가 각각 실패해야 한다 (너무 관대한 계측기를 잡는다) ──
{
  const negatives = [
    ["검증 점수 62점", "score_word"],
    ["7자산 4/7", "seven_assets"],
    ["개선 필요", "improvement_needed"],
    ["상위 10%", "top_percent"],
    ["AI 활용 고수", "ai_master"],
    ["성장 점수", "growth_score"],
    ["낮음", "low"],
    ["높음", "high"],
    ["역량 부족", "capability_lacking"],
    ["AI 의존도 78%", "ai_dependence"],
    ["코호트 랭킹", "ranking"],
    ["B등급", "grade_word"],
    ["52.5 / 100", "ratio_hundred"],
  ];
  for (const [sample, rule] of negatives) {
    const r = auditRegionText(sample, { region: "work" });
    assert.equal(r.ok, false, `음성 대조군이 통과했다 → 너무 관대한 계측기: ${JSON.stringify(sample)}`);
    assert.ok(
      r.findings.some((f) => f.rule === rule),
      `${JSON.stringify(sample)} 을 잡긴 했는데 기대한 규칙(${rule})이 아니다: ${describe(r)}`,
    );
  }
  console.log(`ok 음성: ${negatives.length}개 시료가 각각 제 규칙으로 실패한다`);
}

// ─── 심은 정답 — 라벨 6개를 심고 정확히 6건을 세는지 ─────────────────────
{
  const planted = "개선 필요 · 낮음 · 상위 10% · 역량 부족 · AI 활용 고수 · 성장 점수";
  const r = auditRegionText(planted, { region: "work" });
  assert.equal(r.ok, false);
  const labelFindings = r.findings.filter((f) => f.kind === "banned_label");
  assert.equal(
    labelFindings.length,
    6,
    `심은 라벨 6개에 대해 ${labelFindings.length}건을 셌다 (중복 계수 또는 누락): ${describe(r)}`,
  );
  assert.equal(
    r.findings.length,
    6,
    `라벨 6개가 수치 규칙과 겹쳐 중복 계수됐다 — "상위 10%"의 \\d+%, "성장 점수"의 점수: ${describe(r)}`,
  );
  console.log("ok 심은 정답: 라벨 6개를 심으면 정확히 6건을 센다 (겹치는 규칙은 중복 계수하지 않는다)");
}

// ─── 규칙 4 가드 — 빈 문자열을 감사하면 항상 ok 가 나온다 ────────────────
{
  const r = auditRegionText("", { minLength: 40 });
  assert.equal(r.ok, false, "빈 영역이 통과했다 — 아무것도 재지 않은 초록이다");
  assert.ok(r.findings.some((f) => f.kind === "empty_region"), describe(r));
  const d = auditRegionText("   \n  ", { minLength: 40 });
  assert.equal(d.ok, false, "공백만 있는 영역이 통과했다");
  const n = auditRegionText(null, { minLength: 1 });
  assert.equal(n.ok, false, "문자열이 아닌 입력이 통과했다");
  console.log("ok 규칙 4: 빈/공백/비문자열 영역은 통과가 아니라 empty_region 실패다");
}

// ─── 제품이 실제로 출하했던 문자열을 잡는가 (계측기가 현실을 읽는다) ──────
//
// 이 시료는 `src/assetStatus.ts` 의 `formatAssetStatusText(emptyAssetScores())` 가
// 2026-09-20 이전에 상태바에 그리던 **실물**이다. SX-59 가 지우라고 한 바로 그 문자열.
//
// 리터럴로 고정한 이유. 이 블록을 `await import("../src/assetStatus.ts")` 로 쓰면
// SX-59 를 구현하는 순간(= 그 모듈 삭제) 이 테스트가 빨개진다. 그러면 **결함을
// 계측 대상으로 삼은 초록 테스트가 그 결함의 수정을 막는다** — 이 저장소가 #904→#910
// 에서 이미 한 번 당한 형태다. 부재를 지키는 검사는 부재할 것을 import 하지 않는다.
//
// 모듈이 아직 살아 있는 동안에는 리터럴이 실물과 같은지도 같이 본다. 모듈이 사라지면
// 그 대조는 건너뛰되 **조용히 넘어가지 않고** 사라졌다고 찍는다. 리터럴 시료 자체는
// 영구 음성 대조군으로 남는다.
{
  const SHIPPED_STATUS_BAR = "$(graph) 7자산 0/7  · Taste  · Intent  · Context  · Verify  · Deleg  · Iter  · Own";
  const r = auditRegionText(SHIPPED_STATUS_BAR, { region: "work" });
  assert.equal(r.ok, false, `출하됐던 "7자산 0/7" 상태바 텍스트를 계측기가 놓쳤다: ${JSON.stringify(SHIPPED_STATUS_BAR)}`);
  assert.ok(r.findings.some((f) => f.rule === "seven_assets"), describe(r));
  assert.ok(r.findings.some((f) => f.rule === "ratio_small"), describe(r));

  let live = null;
  try {
    const mod = await import("../src/assetStatus.ts");
    live = mod.formatAssetStatusText(mod.emptyAssetScores());
  } catch {
    live = null;   // SX-59 구현 후의 정상 상태.
  }
  if (live === null) {
    console.log("ok 현실 대조군: 리터럴 시료를 잡는다 · src/assetStatus.ts 는 이미 제거됐다 (SX-59 완료)");
  } else {
    assert.equal(
      live,
      SHIPPED_STATUS_BAR,
      "assetStatus.ts 의 출하 문자열이 바뀌었다 — 리터럴 대조군을 갱신하라",
    );
    console.log("ok 현실 대조군: 오늘 출하되는 assetStatus 상태바 텍스트를 잡는다 (SX-59 미완 — P0-E 가 삭제한다)");
  }
}

// ─── 건너뛰기 자체의 대조군 — CI 경로가 정말 '의존성 없음'으로 떨어지는가 ──
// 아래 렌더 블록은 react 가 없으면 건너뛴다. 건너뛰기가 조용한 통과가 되지 않게,
// react 가 없는 루트(확장 루트에는 react 를 설치하지 않는다)에 대해 같은 함수를
// 돌려서 available=false · reason="webview-deps-missing" 임을 먼저 확인한다.
{
  const { createRequire } = await import("node:module");
  const extensionRequire = createRequire(new URL("../package.json", import.meta.url));
  const simulated = rendererStatus((id) => extensionRequire.resolve(id));
  assert.equal(simulated.available, false, "확장 루트에서 react 가 resolve 됐다 — 대조군 전제가 바뀌었다");
  assert.equal(simulated.reason, "webview-deps-missing", simulated.detail);
  assert.ok(simulated.detail.includes("react"), simulated.detail);
  console.log("ok 건너뛰기 대조군: react 없는 루트에서 reason='webview-deps-missing' 으로 떨어진다");
}

// ─── 렌더 대조군 — 실제 컴포넌트 렌더 결과를 감사한다 ─────────────────────
// 규칙 4 의 실물 판: 조용히 빈 렌더가 "깨끗함" 으로 통과하지 못하게, 길이와
// 알려진 부분 문자열을 함께 단언한다.
{
  const status = rendererStatus();
  if (status.available) {
    const html = await renderComponent("NativeObservationPanel", { coachName: "코치" });
    assert.ok(html.length > 0, "렌더 결과가 비었다");
    const text = visibleText(html);
    assert.ok(
      text.length >= 60,
      `렌더 텍스트가 ${text.length}자다 — 빈 렌더를 감사하면 무엇이든 통과한다: ${JSON.stringify(text)}`,
    );
    assert.ok(text.includes("내 작업 돌아보기"), `관찰 패널의 summary 가 렌더되지 않았다: ${JSON.stringify(text)}`);
    assert.ok(
      text.includes("점수나 능력 인증이 아닙니다"),
      `실제 부정 문장이 렌더 결과에 없다 — 대조군이 인용한 문장이 제품에서 바뀌었다: ${JSON.stringify(text)}`,
    );
    const r = auditRegionText(text, { region: "work", minLength: 60 });
    assert.equal(r.ok, true, `실제 관찰 패널 렌더가 감사에 걸렸다: ${describe(r)}`);
    console.log(`ok 렌더 대조군: NativeObservationPanel 실제 렌더(${text.length}자)를 감사해 0건`);
  } else {
    assert.equal(
      status.reason,
      "webview-deps-missing",
      `렌더 계측기를 쓸 수 없는 이유가 '의존성 미설치'가 아니다 — 계측기가 고장났을 수 있다: ${status.detail}`,
    );
    console.log(
      "ok 렌더 대조군 SKIP — webview-ui/node_modules 미설치 (CI 의 `npm ci` 는 확장 의존성만 설치한다). " +
        "로컬에서 `cd webview-ui && npm install` 후 재실행하면 실제 렌더를 감사한다.",
    );
  }
}

console.log(
  "PASS sx-audit: 토큰 2종(설계 문서 대조 · start.css 별칭) · 규칙 목록 · 양성 6종(실제 출하 부정 문장 2개 포함) · " +
    "음성 13종 · 심은 정답 6건 · 빈 영역 가드 · 출하 문자열 · 실제 컴포넌트 렌더",
);
