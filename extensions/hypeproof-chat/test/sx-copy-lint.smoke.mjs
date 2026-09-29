// SX-11 · SX-12 — the copy lint's self-verification, then applied to real screen copy.
// Run: node --experimental-strip-types test/sx-copy-lint.smoke.mjs
//
// A grader with no control is not trusted (.claude/rules/verification.md rule 2).
// What the lint itself has to prove here:
//   positive  the five Appendix "쓴다" sentences **pass** → catches a lint that is too strict.
//   negative  the five Appendix "피한다" + the five §10 "나쁜 UX" **fail** → a lint that is too lax.
//   planted   ten counter-examples planted in one sample, and whether it counts exactly ten.
//   guard     an empty string is not a pass but an empty_region failure (rule 4).
// Only after that do we hold it up against the product copy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AVOID_SENTENCES,
  BAD_UX_SENTENCES,
  PREFERRED_SENTENCES,
  containsBadUxSentence,
  lintCopy,
} from "./sx-copy-lint.mjs";
import { auditRegionText } from "./sx-audit.mjs";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";

const describe = (r) => JSON.stringify(r.findings, null, 1);

{
  // Positive — the five sentences the source doc wrote down as "이렇게 쓴다" must pass.
  for (const sentence of PREFERRED_SENTENCES) {
    const r = lintCopy(sentence);
    assert.equal(r.ok, true, `원문의 권장 문장이 걸렸다 → 너무 엄격한 lint: ${sentence}\n${describe(r)}`);
  }
  // Common shapes of observation sentences must pass too — a word-only check trips here.
  for (const sentence of [
    "이번 작업에서는 기대 조건을 먼저 적고 같은 조건으로 다시 확인했습니다.",
    "최근 3개 과제에서 사용자 반응 뒤 결정을 바꿨습니다.",
    "검색 결과를 원자료와 대조했습니다.",
    "이 단계가 끝났다고 볼 조건: 기대 조건이 학생의 말로 1개 이상 적혀 있다.",
  ]) {
    const r = lintCopy(sentence);
    assert.equal(r.ok, true, `정상 관찰 문장이 걸렸다: ${sentence}\n${describe(r)}`);
  }
  console.log(`ok 양성 ${PREFERRED_SENTENCES.length + 4}종: 원문 "쓴다" 열과 정상 관찰 문장이 통과한다`);
}

{
  // Negative — the five Appendix "피한다".
  //
  // These five **straddle two instruments.** One requirement (SX-12) is enforced split across two tools:
  //   "문제 정의 역량이 낮습니다" → shape   → lintCopy
  //   "검증 점수 62점"            → number  → auditRegionText (\d+점)
  // So the judgement is a **union**. Claiming either one alone catches all five
  // is false — when this test was first run "검증 점수 62점" passed on lintCopy
  // alone and went red, and that fact is left here.
  const caughtBy = (text) => [
    ...(lintCopy(text).ok ? [] : ["copy-lint"]),
    ...(auditRegionText(text, { region: "work" }).ok ? [] : ["audit"]),
  ];
  for (const s of AVOID_SENTENCES) {
    const by = caughtBy(s.text);
    assert.ok(by.length > 0, `원문이 "피한다" 고 적은 문장을 두 계측기 모두 놓쳤다: ${s.text}`);
  }
  // And pin that the split really does fall that way — if one side quietly empties out, it shows.
  assert.deepEqual(caughtBy("문제 정의 역량이 낮습니다"), ["copy-lint"]);
  assert.deepEqual(caughtBy("검증 점수 62점"), ["audit"]);
  // The five §10 "나쁜 UX". Look at both what the shape rules catch and what exact string comparison catches.
  for (const s of BAD_UX_SENTENCES) {
    const byShape = lintCopy(s.text).ok === false;
    const byExact = containsBadUxSentence(s.text).includes(s.id);
    assert.ok(byExact, `§10 나쁜 UX 문장이 동일 비교에서도 안 잡힌다: ${s.text}`);
    assert.ok(byShape || byExact, `§10 나쁜 UX 문장이 전혀 안 잡힌다: ${s.text}`);
  }
  console.log(`ok 음성 ${AVOID_SENTENCES.length + BAD_UX_SENTENCES.length}종: "피한다" 다섯과 "나쁜 UX" 다섯이 잡힌다`);
}

{
  // Variants that must not be missed — do the rules catch shapes outside the counter-example list?
  for (const sample of [
    "당신은 검증에 약한 사람이군요.",
    "이 학생은 적응 능력이 향상됐습니다.",
    "AI 활용 능숙 단계입니다.",
    "그냥 이걸로 하죠.",
    "완벽합니다. 이제 배포하세요.",
  ]) {
    const r = lintCopy(sample);
    assert.equal(r.ok, false, `반례 목록 밖의 평가 문형이 통과했다: ${sample}`);
  }
  console.log("ok 변형 5종: 목록에 없는 평가·확정 문형도 형태로 잡는다");
}

{
  // Planted answers — ten counter-examples in one sample. Exactly ten cannot be
  // guaranteed because the rules overlap, so count whether **at least one hit per
  // sentence** came out (0 missed).
  // The judgement is the union of the two instruments (see the negative block
  // above) — shape · number · exact comparison.
  const planted = [...AVOID_SENTENCES, ...BAD_UX_SENTENCES].map((s) => s.text);
  let missed = [];
  for (const text of planted) {
    const caught = lintCopy(text).ok === false
      || auditRegionText(text, { region: "work" }).ok === false
      || containsBadUxSentence(text).length > 0;
    if (!caught) missed.push(text);
  }
  assert.deepEqual(missed, [], `심은 반례 ${planted.length}개 중 놓친 것: ${missed.join(" / ")}`);
  console.log(`ok 심은 정답: 반례 ${planted.length}개를 하나도 놓치지 않는다`);
}

{
  // Rule 4 — empty copy is not a pass.
  assert.equal(lintCopy("", { minLength: 20 }).ok, false);
  assert.equal(lintCopy("   \n ", { minLength: 20 }).ok, false);
  assert.equal(lintCopy(null).ok, false);
  assert.equal(lintCopy("").findings[0].rule, "empty_region");
  console.log("ok 규칙 4: 빈/공백/비문자열은 통과가 아니라 empty_region 실패다");
}

// ─── Applied to product copy ──────────────────────────────────────────────
{
  // Copy baked into the source: read and check the source text of the two components the student sees.
  // (Do not grep the bundle for Hangul — esbuild escapes it as \uXXXX.
  //  Here we read the **source file**, so it is safe.)
  const files = ["webview-ui/src/MissionHeader.tsx", "webview-ui/src/NativeObservationPanel.tsx"];
  for (const rel of files) {
    const source = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    const r = lintCopy(source, { minLength: 200 });
    assert.equal(r.ok, true, `${rel} 의 문구가 카피 lint 에 걸렸다:\n${describe(r)}`);
    assert.deepEqual(containsBadUxSentence(source), [], `${rel} 에 §10 나쁜 UX 문장이 있다`);
  }
  console.log(`ok 제품 소스 ${files.length}개: 카피 lint 0건`);
}

const status = rendererStatus();
if (!status.available) {
  console.log(`NOT RUN 렌더 적용 — ${status.detail}`);
  console.log("PASS sx-copy-lint: 대조군과 소스 판정까지 (렌더 계측기 사용 불가)");
  process.exit(0);
}

{
  // The actual render result. Real screen copy, conditional branches included.
  const week3 = JSON.parse(
    readFileSync(new URL("../../../worker/test/fixtures/session-design/week-3.json", import.meta.url), "utf8"),
  );
  const noop = () => {};
  const text = visibleText(await renderComponent("MissionHeader", {
    lesson: { course_id: "globalbuddy", version: "m2026.09.20-1", sha256: "f".repeat(64), content: week3 },
    currentStepId: null, onSelectStep: noop, onStartStep: noop, onOpenGrowth: noop,
    busy: false, activity: { label: "수업", name: "GlobalBuddy", verified: true },
  }));
  const r = lintCopy(text, { minLength: 60 });
  assert.equal(r.ok, true, `Mission header 렌더 문구가 카피 lint 에 걸렸다:\n${describe(r)}`);

  // Negative control — is this screen's lint alive? Plant an evaluative shape in the instructor-written mission.
  const planted = visibleText(await renderComponent("MissionHeader", {
    lesson: {
      course_id: "globalbuddy", version: "m2026.09.20-1", sha256: "f".repeat(64),
      content: { ...week3, learning: { ...week3.learning, mission: "당신은 검증에 약한 사람이군요." } },
    },
    currentStepId: null, onSelectStep: noop, onStartStep: noop, onOpenGrowth: noop,
    busy: false, activity: null,
  }));
  assert.equal(lintCopy(planted, { minLength: 60 }).ok, false, "심은 평가 문형이 통과했다 — 이 화면의 lint 가 아무것도 세지 않는다");
  console.log("ok 렌더 적용: Mission header 문구 0건 · 심은 평가 문형은 잡힌다");
}

console.log("PASS sx-copy-lint: 양성 9 · 음성 10 · 변형 5 · 심은 정답 10 · 빈 영역 가드 · 소스와 렌더 적용");
