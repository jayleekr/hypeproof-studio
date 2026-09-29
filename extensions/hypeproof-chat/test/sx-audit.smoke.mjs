// Checking the design tokens against the doc, and the **self-verification** of the render DOM
// audit instrument — the instrument measuring the instrument.
//
// Requirements: SX-49~54 (design tokens / presentation rules) · SX-35 (6 banned labels) ·
// SX-43 (observation panel) · SX-59 (remove the 7-asset N/7).
// Contract: docs/testing/studio-learning-experience.md §렌더 DOM 감사 계측기.
//       Decision discipline: .claude/rules/verification.md rules 1·2·3·4.
//
// Why this TC exists (two real incidents):
//
//   1) 2026-07-25~27: over three days the instrument was **wrong fifteen times, and 9 of
//      those were all** "wrote the criterion by guessing, without checking the thing being
//      measured". All 9 were wrong toward *failure*, which is why they surfaced. Had they
//      been wrong toward passing, a false green would have been reported as is. So this file
//      puts the **positive controls first** — catching an instrument that is too strict is
//      the key part.
//
//   2) memory "Korean regex single-char trap": a bare /색/ matched "검색". The same trap is
//      actually here. "점수" appears **twice** on today's shipped screens and both are
//      *denials*, not *displays* —
//        webview-ui/src/NativeObservationPanel.tsx:57  "관찰은 점수나 능력 인증이 아닙니다."
//        webview-ui/src/LocalReview.tsx:41             "대화량은 역량 점수가 아닙니다."
//      Both sentences are correct copy. If the instrument bites them, it is the instrument
//      that is wrong, not the product, and someone goes off to delete perfectly good
//      sentences. So **both sentences are pinned verbatim** into the positive controls.
//
//   3) For the same reason "3주차" and "남은 단계 2" are positive controls too. The
//      verification doc states outright that flagging these as numerals is an instrument
//      defect.
//
// If even one control is wrong, every audit result from that run is void (verification doc).
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
  auditPrimaryCta,
  auditRegionText,
  parseCssCustomProperties,
} = await import("./sx-audit.mjs");

const { rendererStatus, renderComponent, visibleText } = await import("./sx-render.mjs");

// Strings that actually ship today. Taken verbatim from the files above (a quotation, not a
// copy — the render control re-checks the same sentence against the real render output).
const REAL_DENIAL_OBSERVATION =
  "내가 요청한 내용과 코치·도구가 수행한 일을 나누어 확인합니다. 관찰은 점수나 능력 인증이 아닙니다.";
const REAL_DENIAL_LOCAL_REVIEW =
  "대화량은 역량 점수가 아닙니다. 작업 성공·실제 소요 시간·학습 변화는 미측정입니다.";
const REAL_OBSERVATION_COUNT_LINE =
  "12건 · 도움 사용 범위는 확인 전까지 미확인입니다.";

const describe = (r) => r.findings.map((f) => `${f.rule}:${JSON.stringify(f.match)}@${f.index}`).join(", ");

// ─── Design tokens (SX-49 ~ SX-54) ───────────────────────────────────
// The design doc is canonical for the values. So the expected values are not written here —
// the **design doc is read** and checked against tokens.css. If only one of the two changes,
// this block catches it.
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

// start.css must be aliases, and each alias target's value must be **the same as the literal
// before this change**. That is what turns "the rendered colors are unchanged" from a claim
// into a check.
{
  const startCss = readFileSync(new URL("../webview-ui/src/start.css", import.meta.url), "utf8");
  const block = parseCssCustomProperties(startCss)[".studio-start,.studio-disconnected"];
  assert.ok(block, ".studio-start,.studio-disconnected 블록을 찾지 못했다");

  // Left is the alias target, right is the literal in start.css immediately before this
  // 2026-09-20 change (confirmed with
  // git show HEAD:extensions/hypeproof-chat/webview-ui/src/start.css).
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

// ─── Check that the rule lists match the docs ─────────────────────────
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

// ─── Positive controls — a good sample must pass (catches an instrument that is too strict) ──
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
  // The two below are normal strings that the real ChatPanel render got flagged on right
  // after the `bare_number` rule was added.
  const ord = auditRegionText("이번 단계 안내 · 1. 기대 조건\n3주차 · Underlying Magic", { region: "work" });
  assert.equal(ord.ok, true, `목록 번호를 수치로 잡았다 → 계측기가 너무 엄격하다: ${describe(ord)}`);
  const ver = auditRegionText("Underlying Magic · 버전 m2026.09.20-1 · 120분", { region: "work" });
  assert.equal(ver.ok, true, `모듈 버전을 수치로 잡았다 → 계측기가 너무 엄격하다: ${describe(ver)}`);
  console.log("ok 양성: 날짜·시각·N개 카운트 · 목록 번호 · 모듈 버전은 허용 수치다");
}

// ─── Negative controls — each bad sample must fail (catches an instrument that is too lax) ──
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
    // A hole caught in the 2026-09-20 evaluation, D-3. If a rule is added, a control is added
    // with it — with no control there is no way to know whether a rule is running at all.
    ["레벨 3", "level"],
    ["Lv 7", "level"],
    ["★★★☆☆", "stars"],
    ["오늘의 성과 0.82", "bare_number"],
    ["확인함 12", "bare_number"],
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

// ─── Planted answer — plant 6 labels and check it counts exactly 6 ──────
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

// ─── Rule 4 guard — auditing an empty string always comes back ok ───────
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

// ─── Does it catch a string the product actually shipped (the instrument reads reality) ──
//
// This sample is the **real thing** that `formatAssetStatusText(emptyAssetScores())` in
// `src/assetStatus.ts` drew in the status bar before 2026-09-20. The exact string SX-59 says
// to delete.
//
// Why it is pinned as a literal. If this block were written as
// `await import("../src/assetStatus.ts")`, this test would go red the moment SX-59 is
// implemented (= that module is deleted). Then **a green test that took the defect as its
// measurement target blocks the fix for that defect** — a shape this repo already suffered
// once, in #904→#910. A check that guards an absence does not import the thing that is
// supposed to be absent.
//
// While the module is still alive, it also checks that the literal matches the real thing. If
// the module is gone, that comparison is skipped — but **not silently**: it prints that the
// module is gone. The literal sample itself stays as a permanent negative control.
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
    live = null;   // The normal state after SX-59 is implemented.
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

// ─── A control for the skip itself — does the CI path really fall through as 'no deps' ──
// The render block below skips when react is absent. So the skip does not become a silent
// pass, the same function is first run against a root with no react (the extension root does
// not install react) to confirm available=false · reason="webview-deps-missing".
{
  const { createRequire } = await import("node:module");
  const extensionRequire = createRequire(new URL("../package.json", import.meta.url));
  const simulated = rendererStatus((id) => extensionRequire.resolve(id));
  assert.equal(simulated.available, false, "확장 루트에서 react 가 resolve 됐다 — 대조군 전제가 바뀌었다");
  assert.equal(simulated.reason, "webview-deps-missing", simulated.detail);
  assert.ok(simulated.detail.includes("react"), simulated.detail);
  console.log("ok 건너뛰기 대조군: react 없는 루트에서 reason='webview-deps-missing' 으로 떨어진다");
}

// ─── Render control — audit the real component render output ────────────
// Rule 4 applied to the real thing: so a silently empty render cannot pass as "clean", the
// length and a known substring are asserted alongside it.
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

// ─── Audit the real work screen and entry screen (2026-09-20 evaluation, D-1) ─────────
//
// Up to here the render control was `NativeObservationPanel` alone. But the body of the
// "working screen" C1 talks about is `ChatPanel` (the coach rail), and home is the Mission
// header inside it. Without rendering those two, C1's basis for passing is a source grep
// rather than a render — the exact method that misses conditional branches.
{
  const status = rendererStatus();
  if (!status.available) {
    console.log("ok 화면 감사 SKIP — " + status.detail);
  } else {
    const { chatPanelProps } = await import("./sx-screen-fixtures.mjs");

    const chatHtml = await renderComponent("ChatPanel", chatPanelProps());
    const chat = visibleText(chatHtml);

    // SX-51 · rubric G — there is **one** emphasized button on a screen.
    //
    // Without this assertion P1 ended up with two (region A's first action + "이 과제 완료하기").
    // A text dump does not keep the class, so the **markup** is counted. Two emphasized
    // buttons means two "do this now"s, and that is what SX-01 exists to prevent.
    const primary = auditPrimaryCta(chatHtml);
    assert.equal(primary.ok, true, `작업 화면의 Primary CTA 가 ${primary.count}개다`);

    // Positive control — shows the rule does not demand "zero". There must be one.
    assert.equal(primary.count, 1, "강조 버튼이 하나도 없다 — 학생이 어디를 눌러야 할지 모른다");

    // Negative control — does the counting rule actually count. Planted markup must be caught.
    assert.equal(auditPrimaryCta('<button class="hp-cta-primary">A</button><button class="a hp-cta-primary b">B</button>').ok, false);
    assert.equal(auditPrimaryCta('<button class="hp-cta-quiet">A</button>').count, 0);

    // The render above does **not include** region D (completion CTA + drawer) — that region
    // is only drawn when the host has sent `learningState`, and SSR does not run `useEffect`.
    // So "one emphasis on the screen" is, with this render, a count taken with D excluded.
    // Be honest about it and count once more **statically over the source**. The class is a
    // literal, so it can be counted.
    const chatSource = readFileSync(new URL("../webview-ui/src/ChatPanel.tsx", import.meta.url), "utf8");
    const sourcePrimary = chatSource.match(/className="hp-cta-primary"/g)?.length ?? 0;
    assert.equal(
      sourcePrimary,
      0,
      `ChatPanel 이 Primary CTA 를 ${sourcePrimary}개 직접 그린다 — 강조 자리는 영역 A(MissionHeader)가 갖는다`,
    );
    const headerSource = readFileSync(new URL("../webview-ui/src/MissionHeader.tsx", import.meta.url), "utf8");
    assert.equal(
      headerSource.match(/hp-cta-primary/g)?.length,
      1,
      "영역 A 의 강조 버튼이 하나가 아니다",
    );
    // Rule 4 — auditing an empty render passes anything. Check what was rendered first.
    assert.ok(chat.length >= 200, `ChatPanel 렌더가 ${chat.length}자다: ${JSON.stringify(chat.slice(0, 200))}`);
    assert.ok(chat.includes("AI가 만든 걸 내가 확인했나?"), "작업 화면에 미션 문장이 없다");
    assert.ok(chat.includes("기대 조건"), "작업 화면에 단계 action 이 없다");
    const chatAudit = auditRegionText(chat, { region: "work", minLength: 200 });
    assert.equal(chatAudit.ok, true, `실제 작업 화면(ChatPanel) 이 감사에 걸렸다: ${describe(chatAudit)}`);

    const start = visibleText(await renderComponent("StartPage", {}));
    assert.ok(start.length >= 200, `StartPage 렌더가 ${start.length}자다`);
    assert.ok(start.includes("나의 변화 기록"), "진입 화면의 변화 기록 진입이 없다");
    const startAudit = auditRegionText(start, { region: "work", minLength: 200 });
    assert.equal(startAudit.ok, true, `진입 화면(StartPage) 이 감사에 걸렸다: ${describe(startAudit)}`);

    // Negative control — is the audit of these two screens alive. Plant a score in the
    // mission the instructor wrote.
    const planted = visibleText(await renderComponent("ChatPanel", chatPanelProps({
      config: {
        ...chatPanelProps().config,
        profile: {
          ...chatPanelProps().config.profile,
          lesson: {
            ...chatPanelProps().config.profile.lesson,
            content: {
              ...chatPanelProps().config.profile.lesson.content,
              learning: {
                ...chatPanelProps().config.profile.lesson.content.learning,
                mission: "검증 점수 62점 · 개선 필요",
              },
            },
          },
        },
      },
    })));
    const plantedAudit = auditRegionText(planted, { region: "work", minLength: 200 });
    assert.equal(plantedAudit.ok, false, "작업 화면에 심은 점수가 통과했다 — 이 화면의 감사가 아무것도 세지 않는다");

    console.log(`ok 화면 감사: ChatPanel 실제 렌더(${chat.length}자) 0건 · StartPage(${start.length}자) 0건 · 심은 점수는 잡힌다`);
  }
}

console.log(
  "PASS sx-audit: 토큰 2종(설계 문서 대조 · start.css 별칭) · 규칙 목록 · 양성 6종(실제 출하 부정 문장 2개 포함) · " +
    "음성 18종 · 심은 정답 6건 · 빈 영역 가드 · 출하 문자열 · 실제 화면 3종(관찰 패널 · ChatPanel · StartPage)",
);
