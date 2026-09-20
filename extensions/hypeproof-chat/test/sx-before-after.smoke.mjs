// SX-15 · SX-16 — 재확인 줄과 변경 전후 보기의 판정 (P1-C).
// Run: node --experimental-strip-types test/sx-before-after.smoke.mjs
//
// 구현 전에 쓰였다(ux-dag.yaml P1-C control). 시료는 **워커의 실제 fixture** 를 쓴다 —
// 게이트를 재는 것과 화면을 재는 것이 같은 데이터를 보게 하려는 것이다. 화면 쪽에서만
// 쓰는 별도 시료를 만들면 둘이 갈라져도 아무도 모른다(verification.md 규칙 1).

import assert from "node:assert/strict";
import { auditRegionText } from "./sx-audit.mjs";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";
import { learningState } from "../src/learningStateHelpers.ts";
import { beforeAfterOf, NO_AI_DRAFT } from "../webview-ui/src/evidenceDrawerLogic.ts";
import * as F from "../../../worker/test/fixtures/measurement-core/learning-cases.mjs";

const stateOf = (caseName) =>
  learningState({ task: "task-1", events: F.gateCases[caseName]().events, completion: [] });

// ── 1. SX-15 — 재확인 줄이 네 상태를 구분해서 말한다 ────────────────────────

{
  const lines = new Map();
  for (const name of ["draft_then_criterion", "change_without_retest", "retest_same_criterion", "criterion_changed_after_confirm"]) {
    const v = stateOf(name).verification;
    lines.set(name, v);
    assert.ok(v.line.trim().length > 0, `${name}: 검증 줄이 비었다`);
    assert.ok(!/\d/.test(v.line), `${name}: 검증 줄에 숫자가 있다 — ${v.line}`);
  }
  assert.equal(lines.get("draft_then_criterion").state, "none");
  assert.equal(lines.get("change_without_retest").state, "unconfirmed");
  assert.equal(lines.get("retest_same_criterion").state, "confirmed");
  assert.equal(lines.get("criterion_changed_after_confirm").state, "needs_recheck");

  // 네 상태가 **서로 다른 문장**이어야 한다. 같은 문장이면 학생은 구분할 수 없고,
  // 그러면 상태를 넷으로 나눈 의미가 없다.
  const sentences = [...lines.values()].map((v) => v.line);
  assert.equal(new Set(sentences).size, 4, `상태가 넷인데 문장은 ${new Set(sentences).size}가지다: ${JSON.stringify(sentences)}`);

  // AE-37 — 재확인이 필요해도 **이전 확인은 남아 있다.**
  const moved = lines.get("criterion_changed_after_confirm");
  assert.ok(moved.previous, "재확인 필요로 내려가면서 이전 확인을 버렸다");
  assert.equal(moved.previous.event_id, "rc1");
  assert.ok(
    moved.line.includes("다시") || moved.line.includes("재확인"),
    `재확인 줄이 무엇을 하라는 말인지 없다: ${moved.line}`,
  );
}

// ── 2. SX-16 — 변경 전후 보기 ───────────────────────────────────────────────

{
  // 양성: AI 초안 → 학생이 고쳐 달라고 함 → 수정본 → 같은 조건으로 재확인.
  const pairs = beforeAfterOf(stateOf("retest_same_criterion").evidence);
  assert.equal(pairs.length, 1, `전후 쌍이 하나여야 하는데 ${pairs.length}개다`);
  const pair = pairs[0];
  assert.equal(pair.before?.sha256, F.SHA_A, "AI 초안이 before 로 잡히지 않았다");
  assert.equal(pair.after?.sha256, F.SHA_B, "학생 수정본이 after 로 잡히지 않았다");
  assert.ok(pair.criterionText.includes("3초"), `그때의 기대 조건이 함께 오지 않았다: ${pair.criterionText}`);
  assert.equal(pair.note, null, "정상 쌍인데 주석이 붙었다");
}

{
  // 음성(SX-16 부정 조건): 학생 수정본만 있고 AI 초안이 없다.
  // **빈 비교를 만들지 않고** "AI 초안 없음" 으로 남긴다.
  const pairs = beforeAfterOf(stateOf("after_without_before").evidence);
  assert.equal(pairs.length, 1, "비교할 것이 하나는 있어야 한다(학생 수정본)");
  assert.equal(pairs[0].before, null, "없는 AI 초안을 지어냈다");
  assert.equal(pairs[0].note, NO_AI_DRAFT, `주석이 "${NO_AI_DRAFT}" 가 아니다: ${pairs[0].note}`);
  assert.ok(pairs[0].after, "학생 수정본조차 없다 — 그러면 쌍을 만들지 말았어야 한다");
}

{
  // 음성: 아무 산출물도 없으면 **쌍을 만들지 않는다.** 빈 비교를 그리지 않는다.
  assert.deepEqual(beforeAfterOf(stateOf("draft_without_criterion").evidence.filter((r) => r.kind !== "artifact")), []);
  assert.deepEqual(beforeAfterOf([]), []);
}

{
  // 두 번 고쳤으면 쌍도 둘이다. 마지막 하나로 뭉뚱그리면 첫 번째 판단이 없었던
  // 일이 된다 — 학생이 무엇을 언제 바꿨는지가 이 화면의 요점이다.
  const twice = beforeAfterOf(stateOf("two_changes").evidence);
  assert.equal(twice.length, 2, `변경이 둘인데 쌍이 ${twice.length}개다`);
  assert.deepEqual(
    twice.map((p) => [p.before?.sha256, p.after.sha256]),
    [[F.SHA_A, F.SHA_B], [F.SHA_B, F.SHA_C]],
    "변경 순서대로 짝지어지지 않았다",
  );
  for (const p of twice) {
    assert.equal(p.note, null, "정상 쌍에 주석이 붙었다");
    assert.notEqual(p.before?.sha256, p.after.sha256, "같은 개정본을 전후로 놓았다");
    assert.ok(p.criterionText.length > 0, "그때의 기대 조건이 빠졌다");
  }
}

{
  // 확인하지 않은 채 또 고쳐 달라고 한 경우. 첫 변경에는 짝지을 확인이 **없다**.
  // 두 번째 확인을 첫 변경 것으로 끌어오면 학생이 보지도 않은 개정본을
  // "확인했다" 로 그리게 된다.
  const skipped = beforeAfterOf(stateOf("change_then_change").evidence);
  assert.equal(skipped.length, 1, `확인이 하나뿐인데 쌍이 ${skipped.length}개다 — 다음 변경의 확인을 끌어왔다`);
  assert.equal(skipped[0].before?.sha256, F.SHA_B, "첫 변경이 두 번째 확인을 가로챘다");
  assert.equal(skipped[0].after.sha256, F.SHA_C);
}

{
  // 여덟 종 전부 있는 배치. 학생이 아직 아무것도 고치지 않은 상태(코치 초안을 그냥
  // 한 번 확인한 것)를 "변경 전후" 로 그리지 않는다 — `test_observed`(SHA_A) 는
  // 변경 요청 **앞**에 있으므로 쌍이 아니다.
  const all = beforeAfterOf(learningState({ task: "task-1", events: F.validCases.all_eight_kinds().events, completion: [] }).evidence);
  assert.equal(all.length, 1, `변경이 하나인데 쌍이 ${all.length}개다`);
  assert.equal(all[0].before?.sha256, F.SHA_A);
  assert.equal(all[0].after.sha256, F.SHA_B);
}

// ── 3. 화면 — 실제 렌더로 판정한다 ──────────────────────────────────────────

const status = rendererStatus();
if (!status.available) {
  console.log(`sx-before-after: 렌더 판정 건너뜀 — ${status.detail}`);
  console.log("sx-before-after: OK (순수 판정만)");
} else {
  const state = stateOf("criterion_changed_after_confirm");
  const html = await renderComponent("EvidenceDrawer", {
    open: true,
    rows: state.evidence,
    verification: state.verification,
    onSubmit: () => {},
    onToggle: () => {},
  });
  const text = visibleText(html);

  assert.ok(text.includes(state.verification.line), "재확인 줄이 화면에 없다");
  // 전후 비교가 실제로 그려진다.
  assert.ok(/변경 전|AI 초안/.test(text), `변경 전후 보기가 화면에 없다:\n${text}`);
  // sha256 전체를 그대로 뿌리지 않는다 — 64자 16진수는 학생에게 아무 의미가 없고
  // 화면만 먹는다. 짧은 머리글자로 줄인다.
  assert.ok(!text.includes(F.SHA_A), "sha256 64자를 통째로 화면에 뿌렸다");

  const verdict = auditRegionText(text, { region: "work", minLength: 80 });
  assert.equal(verdict.ok, true, `전후 보기에 금지 표현이 있다: ${JSON.stringify(verdict.findings)}`);

  console.log(`sx-before-after: 렌더 판정 OK (${text.length}자)`);
  console.log("sx-before-after: OK");
}
