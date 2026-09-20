// SX-11 · SX-12 — 카피 lint 의 자기 검증, 그리고 실제 화면 문구에 적용.
// Run: node --experimental-strip-types test/sx-copy-lint.smoke.mjs
//
// 대조군 없는 채점기는 신뢰하지 않는다(.claude/rules/verification.md 규칙 2).
// 여기서 lint 자신이 증명해야 하는 것:
//   양성  Appendix "쓴다" 다섯 문장이 **통과**한다 → 너무 엄격한 lint 를 잡는다.
//   음성  Appendix "피한다" 다섯 + §10 "나쁜 UX" 다섯이 **실패**한다 → 너무 관대한 lint.
//   정답  열 반례를 한 시료에 심고 정확히 열 건을 세는지.
//   가드  빈 문자열은 통과가 아니라 empty_region 실패(규칙 4).
// 그런 다음에야 제품 문구에 들이댄다.

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
  // 양성 — 원문이 "이렇게 쓴다" 고 적은 다섯 문장은 반드시 통과한다.
  for (const sentence of PREFERRED_SENTENCES) {
    const r = lintCopy(sentence);
    assert.equal(r.ok, true, `원문의 권장 문장이 걸렸다 → 너무 엄격한 lint: ${sentence}\n${describe(r)}`);
  }
  // 관찰 문장의 흔한 형태도 통과해야 한다 — 낱말만 보면 여기서 걸린다.
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
  // 음성 — Appendix "피한다" 다섯.
  //
  // 이 다섯은 **두 계측기에 걸쳐 있다.** 하나의 요구(SX-12)를 두 도구가 나눠 집행한다:
  //   "문제 정의 역량이 낮습니다" → 문형   → lintCopy
  //   "검증 점수 62점"            → 수치   → auditRegionText (\d+점)
  // 그래서 판정은 **합집합**이다. 어느 한쪽만으로 다섯을 다 잡는다고 주장하면
  // 그게 거짓이다 — 실제로 이 테스트를 처음 돌렸을 때 "검증 점수 62점" 이
  // lintCopy 만으로는 통과해서 빨갛게 났고, 그 사실을 여기 남긴다.
  const caughtBy = (text) => [
    ...(lintCopy(text).ok ? [] : ["copy-lint"]),
    ...(auditRegionText(text, { region: "work" }).ok ? [] : ["audit"]),
  ];
  for (const s of AVOID_SENTENCES) {
    const by = caughtBy(s.text);
    assert.ok(by.length > 0, `원문이 "피한다" 고 적은 문장을 두 계측기 모두 놓쳤다: ${s.text}`);
  }
  // 그리고 분담이 실제로 그렇게 나뉘는지 고정한다 — 한쪽이 조용히 비어 가면 드러난다.
  assert.deepEqual(caughtBy("문제 정의 역량이 낮습니다"), ["copy-lint"]);
  assert.deepEqual(caughtBy("검증 점수 62점"), ["audit"]);
  // §10 "나쁜 UX" 다섯. 문형 규칙으로 잡히는 것과, 문자열 동일 비교로 잡는 것 둘 다 본다.
  for (const s of BAD_UX_SENTENCES) {
    const byShape = lintCopy(s.text).ok === false;
    const byExact = containsBadUxSentence(s.text).includes(s.id);
    assert.ok(byExact, `§10 나쁜 UX 문장이 동일 비교에서도 안 잡힌다: ${s.text}`);
    assert.ok(byShape || byExact, `§10 나쁜 UX 문장이 전혀 안 잡힌다: ${s.text}`);
  }
  console.log(`ok 음성 ${AVOID_SENTENCES.length + BAD_UX_SENTENCES.length}종: "피한다" 다섯과 "나쁜 UX" 다섯이 잡힌다`);
}

{
  // 놓치면 안 되는 변형 — 반례 목록에 없는 문형도 규칙이 잡는가.
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
  // 심은 정답 — 열 반례를 한 시료에. 정확히 열 건인지는 규칙 겹침 때문에 보장할 수
  // 없으므로, **문장마다 적어도 한 건**이 나왔는지를 센다(누락 0).
  // 판정은 두 계측기의 합집합이다(위 음성 블록 참고) — 문형 · 수치 · 동일 비교.
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
  // 규칙 4 — 빈 문구는 통과가 아니다.
  assert.equal(lintCopy("", { minLength: 20 }).ok, false);
  assert.equal(lintCopy("   \n ", { minLength: 20 }).ok, false);
  assert.equal(lintCopy(null).ok, false);
  assert.equal(lintCopy("").findings[0].rule, "empty_region");
  console.log("ok 규칙 4: 빈/공백/비문자열은 통과가 아니라 empty_region 실패다");
}

// ─── 제품 문구에 적용 ─────────────────────────────────────────────────────
{
  // 소스에 박힌 문구: 학생이 보는 두 컴포넌트의 원문을 읽어 검사한다.
  // (번들을 한글로 grep 하지 않는다 — esbuild 가 \uXXXX 로 이스케이프한다.
  //  여기서는 **소스 파일**을 읽으므로 안전하다.)
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
  // 실제 렌더 결과. 조건부 분기까지 포함한 진짜 화면 문구다.
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

  // 음성 대조군 — 이 화면의 lint 가 살아 있는가. 강사가 쓴 미션에 평가 문형을 심는다.
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
