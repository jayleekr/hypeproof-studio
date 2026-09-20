// SX-01 ~ SX-05 — 학생 홈은 "오늘의 작업" 이다. Mission header 의 판정.
// Run: node --experimental-strip-types test/sx-mission-header.smoke.mjs
//
// 왜 이 파일이 있나. "첫 화면 5초 안에 지금 할 것을 말할 수 있다"(SX-T01)는 사람이
// 판정하는 행이지만, 그 앞에 기계가 먼저 배제할 수 있는 것이 있다: **미션 문장이
// 화면에서 가장 큰 활자인가**, **강조 버튼이 하나인가**, **변화 기록이 action 보다
// 아래에 있고 작은가**, 그리고 **어디에도 점수·등급이 없는가**.
// 사람 판정이 남는 것은 문장 자체가 모호한 경우이고, 그건 spec 문제다.
//
// 판정 대상은 **실제 렌더 결과**다(verification.md 규칙 1). 소스 grep 으로는 조건부
// 분기를 놓친다. 시료는 실제 세션 설계 파일(worker/test/fixtures/session-design/
// week-3.json)이다 — 화면이 읽는 그 데이터로 판정한다.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditRegionText } from "./sx-audit.mjs";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";
// 순수 판정은 `.ts` 에 있다 — `.tsx` 는 --experimental-strip-types 가 못 읽는다
// (JSX 는 스트립되지 않는다). 컴포넌트 자체는 아래 렌더 계측기로 본다.
import { MAX_ACTIONS, actionsFrom, stepsRemaining } from "../webview-ui/src/missionHeaderLogic.ts";

const week3 = JSON.parse(
  readFileSync(new URL("../../../worker/test/fixtures/session-design/week-3.json", import.meta.url), "utf8"),
);
const lesson = { course_id: "globalbuddy", version: "m2026.09.20-1", sha256: "f".repeat(64), content: week3 };
const noop = () => {};
const homeProps = {
  lesson,
  currentStepId: null,
  onSelectStep: noop,
  onStartStep: noop,
  onOpenGrowth: noop,
  busy: false,
  activity: { label: "수업", name: "GlobalBuddy", verified: true },
};

// ─── 순수 함수 — 앱 없이 밀리초에 돈다 ────────────────────────────────────
{
  const steps = week3.steps;
  assert.equal(steps.length, 6, "3주차 시료의 단계 수가 바뀌었다 — 아래 기대값을 갱신하라");

  // SX-02 — 중앙 action 은 1~3개다. 6단계짜리 설계에서도 3을 넘지 않는다.
  assert.equal(actionsFrom(steps, null).length, MAX_ACTIONS);
  assert.equal(actionsFrom(steps, "expect")[0].id, "expect");
  assert.equal(actionsFrom(steps, "retest").length, 1, "마지막 단계에서는 남은 만큼만 보인다");
  assert.deepEqual(actionsFrom([], null), [], "단계가 없으면 action 도 없다");

  // 알 수 없는 단계 id 는 첫 단계로 떨어진다. 빈 화면이 되지 않는다.
  assert.equal(actionsFrom(steps, "없는단계")[0].id, steps[0].id);

  // "남은 단계" 는 위치이지 진행률이 아니다 — 완료를 세지 않는다(P1 이 센다).
  assert.equal(stepsRemaining(steps, null), 6);
  assert.equal(stepsRemaining(steps, "fix"), 2);
  assert.equal(stepsRemaining([], null), 0);
  console.log("ok 순수 함수: action 1~3개 · 미지의 단계는 첫 단계 · 남은 단계는 위치다");
}

const status = rendererStatus();
if (!status.available) {
  // 조용히 통과시키지 않는다. 무엇을 못 쟀는지 말하고 끝낸다.
  console.log(`NOT RUN 렌더 판정 — ${status.detail}`);
  console.log("PASS sx-mission-header: 순수 함수만 판정했다 (렌더 계측기 사용 불가)");
  process.exit(0);
}

const html = await renderComponent("MissionHeader", homeProps);
const text = visibleText(html);

{
  // 규칙 4 — 빈 렌더를 판정하면 무엇이든 통과한다. 길이와 알려진 문장을 먼저 본다.
  assert.ok(text.length >= 60, `렌더 텍스트가 ${text.length}자다: ${JSON.stringify(text)}`);
  assert.ok(text.includes(week3.learning.mission), "미션 문장이 렌더되지 않았다");
  console.log(`ok 렌더 가드: ${text.length}자, 미션 문장 포함`);
}

{
  // SX-01 — 첫 화면의 제목은 미션 문장 그 자체다. 활동 이름도 점수도 아니다.
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  assert.ok(h1, "h1 이 없다 — 가장 큰 활자가 무엇인지 판정할 수 없다");
  assert.equal(visibleText(h1[1]), week3.learning.mission);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, "h1 이 둘 이상이면 무엇이 가장 큰지 모호하다");
  console.log("ok SX-01: 첫 제목(h1)이 미션 문장이고 하나뿐이다");
}

{
  // SX-04 — 강조 버튼(Primary)은 정확히 하나다.
  const primaries = (html.match(/class="[^"]*\bhp-cta-primary\b[^"]*"/g) ?? []).length;
  assert.equal(primaries, 1, `Primary CTA 가 ${primaries}개다`);
  console.log("ok SX-04: Primary CTA 가 정확히 1개다");
}

{
  // SX-03 — 변화 기록 진입은 링크 하나이고, action 보다 **아래**에 있으며
  // Primary 스타일을 쓰지 않는다. 위치는 마크업 순서로 판정한다.
  const growthAt = html.indexOf("hp-mission-growth");
  const actionsAt = html.indexOf("hp-mission-actions");
  assert.ok(growthAt > 0, "변화 기록 진입이 없다");
  assert.ok(actionsAt > 0 && growthAt > actionsAt, "변화 기록 링크가 action 보다 위에 있다");
  const growthTag = /<button[^>]*hp-mission-growth[^>]*>/.exec(html);
  assert.ok(growthTag && !/hp-cta-primary/.test(growthTag[0]), "변화 기록이 Primary 스타일이다");
  assert.ok(text.includes("나의 변화 기록"), "화면 이름은 '나의 변화 기록' 이다(요구 §용어)");
  assert.doesNotMatch(text, /변화 기록[^\n]*\d/, "링크에 카운트 배지가 붙었다(SX-03 부정)");
  console.log("ok SX-03: 변화 기록은 action 아래의 작은 링크 하나이고 카운트가 없다");
}

{
  // SX-59 / SX-51 — 홈에 점수·등급·배지·금지 라벨이 없다. 허용 수치는 주차와 남은 단계뿐.
  const r = auditRegionText(text, { region: "work", minLength: 60 });
  assert.equal(r.ok, true, `홈 렌더가 감사에 걸렸다: ${JSON.stringify(r.findings)}`);
  assert.ok(text.includes("3주차"), "주차 표기가 사라졌다 — 허용 수치 대조군이 무의미해진다");
  assert.ok(/남은 단계 \d/.test(text), "남은 단계 문장이 없다");
  console.log("ok SX-59/SX-51: 홈 렌더에 금지 문자열·수치 0건 (주차·남은 단계는 통과)");
}

{
  // SX-50 — 완료 조건은 아이콘 + 문구다. 색을 지워도 읽힌다.
  for (const item of week3.learning.completion) {
    assert.ok(text.includes(item.text), `완료 조건이 빠졌다: ${item.text}`);
  }
  assert.ok(html.includes("hp-mark"), "상태 아이콘 자리가 없다");
  assert.ok(text.includes("아직 확인 전입니다"), "P0 에는 판정 근거가 없다는 사실을 말해야 한다");
  assert.doesNotMatch(text, /✓|✔/, "근거 없는 확인 표시가 그려졌다 — P1 이전에는 붙지 않는다");
  console.log("ok SX-50: 완료 조건이 아이콘+문구이고, 근거 없는 ✓ 가 없다");
}

// ─── 음성 대조군 — 계측기가 실제로 무언가를 센다 ─────────────────────────
{
  // (a) Primary 가 둘인 시료는 SX-04 판정에서 실패해야 한다.
  const twoPrimaries = html.replace('class="hp-cta-quiet"', 'class="hp-cta-primary"');
  const primaries = (twoPrimaries.match(/class="[^"]*\bhp-cta-primary\b[^"]*"/g) ?? []).length;
  assert.equal(primaries, 2, "음성 시료를 만들지 못했다 — hp-cta-quiet 이 렌더되지 않았다");

  // (b) 미션이 없는 설계는 빈 헤더가 아니라 없다고 말한다(SX-01 부정).
  const { learning, ...withoutLearning } = week3;
  const bare = await renderComponent("MissionHeader", {
    ...homeProps,
    lesson: { ...lesson, content: withoutLearning },
  });
  const bareText = visibleText(bare);
  assert.ok(bareText.includes("미션이 정해지지 않았습니다"), bareText);
  assert.doesNotMatch(bareText, /주차/, "learning 이 없는데 주차를 지어냈다");

  // (c) 수업이 아예 없어도 헤더는 무엇인가를 말한다.
  const none = visibleText(await renderComponent("MissionHeader", { ...homeProps, lesson: null }));
  assert.ok(none.includes("아직 연결된 수업이 없습니다"), none);

  // (d) 금지 라벨을 심은 미션은 감사에 걸려야 한다 — 이 화면의 감사가 살아 있다.
  const planted = await renderComponent("MissionHeader", {
    ...homeProps,
    lesson: { ...lesson, content: { ...week3, learning: { ...week3.learning, mission: "검증 점수 62점 · 개선 필요" } } },
  });
  const plantedAudit = auditRegionText(visibleText(planted), { region: "work", minLength: 60 });
  assert.equal(plantedAudit.ok, false, "심은 금지 라벨이 통과했다 — 이 화면의 감사가 아무것도 세지 않는다");
  console.log("ok 음성 대조군 4종: Primary 2개 · 미션 없음 · 수업 없음 · 심은 금지 라벨");
}

console.log("PASS sx-mission-header: 미션이 가장 큰 활자 · Primary 1개 · 변화 기록은 아래 작은 링크 · 홈 수치 0건");
