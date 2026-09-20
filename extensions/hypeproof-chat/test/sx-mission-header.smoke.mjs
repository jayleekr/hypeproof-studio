// SX-01 ~ SX-05 — the student home is "today's work". Judging the mission header.
// Run: node --experimental-strip-types test/sx-mission-header.smoke.mjs
//
// Why this file exists. "can say what to do now within 5 seconds of the first screen"
// (SX-T01) is a row a human judges, but there is something a machine can rule out
// first: **is the mission sentence the largest type on screen**, **is there exactly one
// emphasized button**, **is the growth record below the actions and smaller**, and
// **is there a score or grade anywhere**.
// What is left to human judgment is a sentence that is itself ambiguous, and that is a
// spec problem.
//
// What gets judged is the **actual render result** (verification.md rule 1). A source
// grep misses conditional branches. The sample is a real session-design file
// (worker/test/fixtures/session-design/week-3.json) — we judge on the same data the
// screen reads.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditRegionText } from "./sx-audit.mjs";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";
// The pure judgments live in `.ts` — --experimental-strip-types cannot read `.tsx`
// (JSX is not stripped). The component itself is seen through the render instrument below.
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

// ─── Pure functions — they run in milliseconds with no app ────────────────
{
  const steps = week3.steps;
  assert.equal(steps.length, 6, "3주차 시료의 단계 수가 바뀌었다 — 아래 기대값을 갱신하라");

  // SX-02 — the central actions are 1–3. Even a 6-step design never exceeds 3.
  assert.equal(actionsFrom(steps, null).length, MAX_ACTIONS);
  assert.equal(actionsFrom(steps, "expect")[0].id, "expect");
  assert.equal(actionsFrom(steps, "retest").length, 1, "마지막 단계에서는 남은 만큼만 보인다");
  assert.deepEqual(actionsFrom([], null), [], "단계가 없으면 action 도 없다");

  // An unknown step id falls back to the first step. It never becomes an empty screen.
  assert.equal(actionsFrom(steps, "없는단계")[0].id, steps[0].id);

  // "steps remaining" is a position, not a progress rate — it does not count completions (P1 does).
  assert.equal(stepsRemaining(steps, null), 6);
  assert.equal(stepsRemaining(steps, "fix"), 2);
  assert.equal(stepsRemaining([], null), 0);
  console.log("ok 순수 함수: action 1~3개 · 미지의 단계는 첫 단계 · 남은 단계는 위치다");
}

const status = rendererStatus();
if (!status.available) {
  // Do not pass silently. Say what could not be measured, then stop.
  console.log(`NOT RUN 렌더 판정 — ${status.detail}`);
  console.log("PASS sx-mission-header: 순수 함수만 판정했다 (렌더 계측기 사용 불가)");
  process.exit(0);
}

const html = await renderComponent("MissionHeader", homeProps);
const text = visibleText(html);

{
  // Rule 4 — judging an empty render passes anything. Check the length and a known sentence first.
  assert.ok(text.length >= 60, `렌더 텍스트가 ${text.length}자다: ${JSON.stringify(text)}`);
  assert.ok(text.includes(week3.learning.mission), "미션 문장이 렌더되지 않았다");
  console.log(`ok 렌더 가드: ${text.length}자, 미션 문장 포함`);
}

{
  // SX-01 — the first screen's heading is the mission sentence itself. Not the activity name, not a score.
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  assert.ok(h1, "h1 이 없다 — 가장 큰 활자가 무엇인지 판정할 수 없다");
  assert.equal(visibleText(h1[1]), week3.learning.mission);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, "h1 이 둘 이상이면 무엇이 가장 큰지 모호하다");
  // The activity line must keep its accessible label. Moving it is not the same as
  // losing the label — on 2026-09-20 CI's real-browser check (US-UI-DRAFT) broke at
  // `getByLabel('현재 활동')` and caught it, and this local check had no such
  // assertion. Now it does.
  assert.match(html, /aria-label="현재 활동"/, "활동 줄의 접근 라벨이 없다");
  assert.ok(text.includes("GlobalBuddy"), "활동 이름이 렌더되지 않았다");
  console.log("ok SX-01: 첫 제목(h1)이 미션 문장이고 하나뿐이다 · 활동 줄은 접근 라벨을 유지한다");
}

{
  // SX-04 — there is exactly one emphasized (Primary) button.
  const primaries = (html.match(/class="[^"]*\bhp-cta-primary\b[^"]*"/g) ?? []).length;
  assert.equal(primaries, 1, `Primary CTA 가 ${primaries}개다`);
  console.log("ok SX-04: Primary CTA 가 정확히 1개다");
}

{
  // SX-03 — the growth-record entry is a single link, sits **below** the actions, and
  // does not use the Primary style. Position is judged by markup order.
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
  // SX-59 / SX-51 — no score, grade, badge or forbidden label on the home. The only allowed numbers are the week and the steps remaining.
  const r = auditRegionText(text, { region: "work", minLength: 60 });
  assert.equal(r.ok, true, `홈 렌더가 감사에 걸렸다: ${JSON.stringify(r.findings)}`);
  assert.ok(text.includes("3주차"), "주차 표기가 사라졌다 — 허용 수치 대조군이 무의미해진다");
  assert.ok(/남은 단계 \d/.test(text), "남은 단계 문장이 없다");
  console.log("ok SX-59/SX-51: 홈 렌더에 금지 문자열·수치 0건 (주차·남은 단계는 통과)");
}

{
  // SX-50 — the completion conditions are icon + wording. They still read with the color removed.
  for (const item of week3.learning.completion) {
    assert.ok(text.includes(item.text), `완료 조건이 빠졌다: ${item.text}`);
  }
  assert.ok(html.includes("hp-mark"), "상태 아이콘 자리가 없다");
  assert.ok(text.includes("아직 확인 전입니다"), "P0 에는 판정 근거가 없다는 사실을 말해야 한다");
  assert.doesNotMatch(text, /✓|✔/, "근거 없는 확인 표시가 그려졌다 — P1 이전에는 붙지 않는다");
  console.log("ok SX-50: 완료 조건이 아이콘+문구이고, 근거 없는 ✓ 가 없다");
}

// ─── Negative controls — the instrument actually counts something ─────────
{
  // (a) A sample with two Primaries must fail the SX-04 judgment.
  const twoPrimaries = html.replace('class="hp-cta-quiet"', 'class="hp-cta-primary"');
  const primaries = (twoPrimaries.match(/class="[^"]*\bhp-cta-primary\b[^"]*"/g) ?? []).length;
  assert.equal(primaries, 2, "음성 시료를 만들지 못했다 — hp-cta-quiet 이 렌더되지 않았다");

  // (b) A design with no mission says so instead of rendering an empty header (SX-01 negative).
  const { learning, ...withoutLearning } = week3;
  const bare = await renderComponent("MissionHeader", {
    ...homeProps,
    lesson: { ...lesson, content: withoutLearning },
  });
  const bareText = visibleText(bare);
  assert.ok(bareText.includes("미션이 정해지지 않았습니다"), bareText);
  assert.doesNotMatch(bareText, /주차/, "learning 이 없는데 주차를 지어냈다");

  // (c) Even with no lesson at all, the header says something.
  const none = visibleText(await renderComponent("MissionHeader", { ...homeProps, lesson: null }));
  assert.ok(none.includes("아직 연결된 수업이 없습니다"), none);

  // (d) A mission with a planted forbidden label must trip the audit — this screen's audit is alive.
  const planted = await renderComponent("MissionHeader", {
    ...homeProps,
    lesson: { ...lesson, content: { ...week3, learning: { ...week3.learning, mission: "검증 점수 62점 · 개선 필요" } } },
  });
  const plantedAudit = auditRegionText(visibleText(planted), { region: "work", minLength: 60 });
  assert.equal(plantedAudit.ok, false, "심은 금지 라벨이 통과했다 — 이 화면의 감사가 아무것도 세지 않는다");
  console.log("ok 음성 대조군 4종: Primary 2개 · 미션 없음 · 수업 없음 · 심은 금지 라벨");
}

// ─── A stand-in for a human to look at (2026-09-20 evaluation, D-8) ───────
//
// Rubric C said to judge "is the largest type on the first screen the task sentence"
// **by proxy, from a screenshot**. An app build is a user-approval matter, so this
// session cannot produce a screenshot. Instead we drop the render result together with
// the tokens as HTML, so a human can open it in a browser.
//
// **This is not real-device evidence.** Of the three labels in
// `docs/testing/studio-learning-experience.md` §실기 증거 규칙 it is `synthetic` — a
// server render of a synthetic sample, not the real app's layout, fonts or VS Code
// theme. That label is stamped on the file's first line.
{
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const out = new URL("../../../e2e/test-results/sx-screens/", import.meta.url);
  mkdirSync(out, { recursive: true });
  const tokens = readFileSync(new URL("../webview-ui/src/tokens.css", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../webview-ui/src/styles.css", import.meta.url), "utf8");
  const page = [
    "<!doctype html>",
    '<html lang="ko"><head><meta charset="utf-8">',
    "<title>SX synthetic — Mission header</title>",
    `<style>${tokens}${styles}</style>`,
    '<style>body{margin:0;background:var(--hp-bg);color:var(--hp-ink);font-family:Inter,-apple-system,sans-serif}',
    ".sx-note{padding:12px;font-size:12px;color:var(--hp-muted);border-bottom:1px solid var(--hp-line)}",
    ".sx-frame{max-width:420px;border-right:1px solid var(--hp-line)}</style></head><body>",
    '<p class="sx-note">synthetic · 2026-09-20 · week-3.json · 서버 렌더(react-dom/server). ',
    "실제 앱 레이아웃·폰트·VS Code 테마가 아니다. 실기 증거가 아니다.</p>",
    `<div class="sx-frame">${html}</div>`,
    "</body></html>",
  ].join("");
  writeFileSync(new URL("mission-header.html", out), page);
  console.log(`ok 대리물: e2e/test-results/sx-screens/mission-header.html (synthetic, 실기 증거 아님)`);
}

console.log("PASS sx-mission-header: 미션이 가장 큰 활자 · Primary 1개 · 변화 기록은 아래 작은 링크 · 홈 수치 0건");
