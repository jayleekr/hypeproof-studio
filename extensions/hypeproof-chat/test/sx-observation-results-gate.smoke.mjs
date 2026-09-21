// The observation RESULTS panel must not be drawn on the work screen unless the
// cohort opted into assessment (SX-01·06·07·59; SX-59 remedy = "학습 경험 프로필에서 비활성").
//
// ## The trap this file is written around
//
// An "it is not on the screen" assertion passes for two very different reasons:
// the thing is gated off, or the render produced nothing at all. #904 -> #910 in
// this repo was exactly that — a green absence test that was measuring the cause
// of the bug and blocking its fix.
//
// So every absence case here also asserts that the SAME render produced the rest
// of the panel. Absence only counts when the neighbourhood is present.

import test from "node:test";
import assert from "node:assert/strict";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";
import { chatPanelProps } from "./sx-screen-fixtures.mjs";

const status = rendererStatus();

/**
 * Copy that exists only inside NativeObservationPanel — verified by rendering the
 * component alone, not guessed. The first draft of this list had "관찰 받기" and
 * "평가에 보낼 기록 보기"; both live behind runtime state and never reach a static
 * render, so the positive control below failed and caught it. What the work screen
 * actually carries is the panel's entry point, and the verdict wording
 * ("독립 수행 근거", "도움을 받은 수행"…) is one button press further in.
 */
const RESULTS_ONLY = [
  "내 작업 돌아보기",
  "관찰은 점수나 능력 인증이 아닙니다",
  "이 작업의 기록 확인",
];
/** Copy from the rest of the work screen — the proof that the render is alive. */
const NEIGHBOUR = "이번 단계가 끝났다고 볼 조건";

function propsWith(observation) {
  const base = chatPanelProps();
  return {
    ...base,
    config: { ...base.config, profile: { ...base.config.profile, observation } },
  };
}

const workScreen = async (observation) =>
  visibleText(await renderComponent("ChatPanel", propsWith(observation)));

test("assess off: no verdict is shown back at the learner while they work", { skip: !status.available && status.detail }, async () => {
  const text = await workScreen({ format: "hps-observation/2", scope: "seat-1", assess: false });

  assert.ok(text.includes(NEIGHBOUR), "렌더 자체가 죽었다 — 아래 '없다' 단언이 의미를 잃는다");
  for (const phrase of RESULTS_ONLY) {
    assert.ok(!text.includes(phrase), `작업 화면에 "${phrase}" 가 보인다 (SX-59)`);
  }
});

test("assess on: the trial cohort still reads its observation results (TUX-OBS-07)", { skip: !status.available && status.detail }, async () => {
  const text = await workScreen({ format: "hps-observation/2", scope: "seat-1", assess: true });

  assert.ok(text.includes(NEIGHBOUR));
  for (const phrase of RESULTS_ONLY) {
    assert.ok(text.includes(phrase), `"${phrase}" 가 사라졌다 — 게이트가 너무 엄격하다`);
  }
});

test("a worker too old to send `assess` reads as no, never as permission", { skip: !status.available && status.detail }, async () => {
  const text = await workScreen({ format: "hps-observation/2", scope: "seat-1" });

  assert.ok(text.includes(NEIGHBOUR));
  assert.ok(!text.includes("이 작업의 기록 확인"), "assess 가 없는 응답을 허가로 읽으면 안 된다");
});

test("recording still runs with assess off — the drawer is a separate switch", { skip: !status.available && status.detail }, async () => {
  // The point of the split. If gating the panel also killed the recording path,
  // this fix would have traded one P0 for another.
  const off = await workScreen({ format: "hps-observation/2", scope: "seat-1", assess: false });
  const on = await workScreen({ format: "hps-observation/2", scope: "seat-1", assess: true });

  // The gate must remove the panel's three lines and nothing else. An earlier
  // version of this check sliced each render at the panel's first line, which in
  // the `off` case is not there at all — so it compared the whole screen against
  // half of one and failed for a reason that had nothing to do with the product.
  const PANEL_LINES = [
    "내 작업 돌아보기",
    "내가 요청한 내용과 코치·도구가 수행한 일을 나누어 확인합니다. 관찰은 점수나 능력 인증이 아닙니다.",
    "이 작업의 기록 확인",
  ];
  const withoutPanel = on.split("\n").filter((line) => !PANEL_LINES.includes(line));

  assert.equal(on.split("\n").length - withoutPanel.length, PANEL_LINES.length, "패널 세 줄이 렌더에 없다");
  assert.equal(
    withoutPanel.join("\n"),
    off,
    "assess 를 끄자 결과 패널 말고 다른 것도 사라졌다 — 게이트가 기록 경로까지 건드렸다",
  );
});

test("the phrases above really are the panel's, not something a broken render loses anyway", { skip: !status.available && status.detail }, async () => {
  // Positive control for the instrument itself (verification.md rule 2). If these
  // strings never appeared in ANY configuration, all the absence assertions above
  // would be vacuous.
  const text = await workScreen({ format: "hps-observation/2", scope: "seat-1", assess: true });
  const found = RESULTS_ONLY.filter((p) => text.includes(p));
  assert.deepEqual(found, RESULTS_ONLY, "결과 패널 문구가 어떤 설정에서도 안 나오면 위 단언은 공허하다");
});
