// SX-15 · SX-16 — verdicts for the recheck line and the before/after view (P1-C).
// Run: node --experimental-strip-types test/sx-before-after.smoke.mjs
//
// Written before the implementation (ux-dag.yaml P1-C control). The samples are **the
// worker's real fixtures** — so that what measures the gate and what measures the screen
// look at the same data. Build a separate sample for the screen side only and nobody will
// know when the two drift apart (verification.md rule 1).

import assert from "node:assert/strict";
import { auditRegionText } from "./sx-audit.mjs";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";
import { learningState } from "../src/learningStateHelpers.ts";
import { beforeAfterOf, NO_AI_DRAFT } from "../webview-ui/src/evidenceDrawerLogic.ts";
import * as F from "../../../worker/test/fixtures/measurement-core/learning-cases.mjs";

const stateOf = (caseName) =>
  learningState({ task: "task-1", events: F.gateCases[caseName]().events, completion: [] });

// ── 1. SX-15 — the recheck line speaks the four states distinctly ───────────

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

  // The four states must be **four different sentences**. Same sentence and the student
  // cannot tell them apart, which makes splitting the state into four meaningless.
  const sentences = [...lines.values()].map((v) => v.line);
  assert.equal(new Set(sentences).size, 4, `상태가 넷인데 문장은 ${new Set(sentences).size}가지다: ${JSON.stringify(sentences)}`);

  // AE-37 — even when a recheck is needed, **the earlier confirmation stays.**
  const moved = lines.get("criterion_changed_after_confirm");
  assert.ok(moved.previous, "재확인 필요로 내려가면서 이전 확인을 버렸다");
  assert.equal(moved.previous.event_id, "rc1");
  assert.ok(
    moved.line.includes("다시") || moved.line.includes("재확인"),
    `재확인 줄이 무엇을 하라는 말인지 없다: ${moved.line}`,
  );
}

// ── 2. SX-16 — the before/after view ───────────────────────────────────────

{
  // Positive: AI draft → student asks for a change → revision → recheck on the same criterion.
  const pairs = beforeAfterOf(stateOf("retest_same_criterion").evidence);
  assert.equal(pairs.length, 1, `전후 쌍이 하나여야 하는데 ${pairs.length}개다`);
  const pair = pairs[0];
  assert.equal(pair.before?.sha256, F.SHA_A, "AI 초안이 before 로 잡히지 않았다");
  assert.equal(pair.after?.sha256, F.SHA_B, "학생 수정본이 after 로 잡히지 않았다");
  assert.ok(pair.criterionText.includes("3초"), `그때의 기대 조건이 함께 오지 않았다: ${pair.criterionText}`);
  assert.equal(pair.note, null, "정상 쌍인데 주석이 붙었다");
}

{
  // Negative (SX-16 negative condition): only the student's revision exists, no AI draft.
  // **We do not build an empty comparison** — we leave it as "no AI draft".
  const pairs = beforeAfterOf(stateOf("after_without_before").evidence);
  assert.equal(pairs.length, 1, "비교할 것이 하나는 있어야 한다(학생 수정본)");
  assert.equal(pairs[0].before, null, "없는 AI 초안을 지어냈다");
  assert.equal(pairs[0].note, NO_AI_DRAFT, `주석이 "${NO_AI_DRAFT}" 가 아니다: ${pairs[0].note}`);
  assert.ok(pairs[0].after, "학생 수정본조차 없다 — 그러면 쌍을 만들지 말았어야 한다");
}

{
  // Negative: with no artifact at all, **no pair is built.** We do not draw an empty comparison.
  assert.deepEqual(beforeAfterOf(stateOf("draft_without_criterion").evidence.filter((r) => r.kind !== "artifact")), []);
  assert.deepEqual(beforeAfterOf([]), []);
}

{
  // Two changes means two pairs. Lumping them into the last one makes the first judgment
  // never have happened — what the student changed and when is the point of this view.
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
  // Asking for another change without confirming first. The first change has **no**
  // confirmation to pair with. Dragging the second confirmation onto the first change
  // would draw a revision the student never even looked at as "confirmed".
  const skipped = beforeAfterOf(stateOf("change_then_change").evidence);
  assert.equal(skipped.length, 1, `확인이 하나뿐인데 쌍이 ${skipped.length}개다 — 다음 변경의 확인을 끌어왔다`);
  assert.equal(skipped[0].before?.sha256, F.SHA_B, "첫 변경이 두 번째 확인을 가로챘다");
  assert.equal(skipped[0].after.sha256, F.SHA_C);
}

{
  // The batch with all eight kinds. A state where the student has changed nothing yet
  // (just confirmed the coach's draft once) is not drawn as "before/after" —
  // `test_observed`(SHA_A) sits **before** the change request, so it is not a pair.
  const all = beforeAfterOf(learningState({ task: "task-1", events: F.validCases.all_eight_kinds().events, completion: [] }).evidence);
  assert.equal(all.length, 1, `변경이 하나인데 쌍이 ${all.length}개다`);
  assert.equal(all[0].before?.sha256, F.SHA_A);
  assert.equal(all[0].after.sha256, F.SHA_B);
}

// ── 3. Screen — judged on the actual render ────────────────────────────────

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
  // The before/after comparison is actually drawn.
  assert.ok(/변경 전|AI 초안/.test(text), `변경 전후 보기가 화면에 없다:\n${text}`);
  // The whole sha256 is not dumped as-is — 64 hex characters mean nothing to a student
  // and only eat screen. It is cut down to a short leading prefix.
  assert.ok(!text.includes(F.SHA_A), "sha256 64자를 통째로 화면에 뿌렸다");

  const verdict = auditRegionText(text, { region: "work", minLength: 80 });
  assert.equal(verdict.ok, true, `전후 보기에 금지 표현이 있다: ${JSON.stringify(verdict.findings)}`);

  console.log(`sx-before-after: 렌더 판정 OK (${text.length}자)`);
  console.log("sx-before-after: OK");
}
