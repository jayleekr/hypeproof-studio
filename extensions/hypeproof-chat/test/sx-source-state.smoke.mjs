// SX-19 · SX-21 · SX-46 — judging the real / simulated labels and verbatim preservation (P1-D).
// Run: node --experimental-strip-types test/sx-source-state.smoke.mjs
//
// Written before the implementation (ux-dag.yaml P1-D control).
//
// The one sentence this file defends: **something tried out in simulation must not look
// like something that actually happened.**
// Week 4's fake checkout being read as revenue is exactly what SX-46 blocks.

import assert from "node:assert/strict";
import { auditRegionText } from "./sx-audit.mjs";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";
import { learningEventRequest } from "../src/learningStateHelpers.ts";
import {
  SOURCE_STATE_LABELS,
  AMBER_STATES,
  partitionBySourceState,
  sourceStateLabel,
} from "../webview-ui/src/evidenceDrawerLogic.ts";
import { SOURCE_STATES } from "../../../worker/src/lib/measurement-core/learning-events.ts";

const CTX = { week: 4, step_id: "s1", task: "task-1", module_version: "m2026.09.20-1" };
const row = (extra = {}) => ({
  id: "e1",
  kind: "external_feedback_received",
  evidence_type: "intent",
  at: 1,
  text: "사고 싶어요",
  actor: "external_user",
  source_kind: "interview",
  source_state: "real",
  provenance: null,
  adopted_from: null,
  ...extra,
});

// ── 1. SX-21 — the four values exist in the UI and the data in the **same vocabulary** ──

{
  // The label table holds exactly the same keys as the data enum. One mismatch and a
  // state with no label appears on screen, tripping SX-21's negative condition
  // ("an external reaction with no label").
  assert.deepEqual(
    Object.keys(SOURCE_STATE_LABELS).sort(),
    [...SOURCE_STATES].sort(),
    "UI 라벨과 데이터 enum 이 갈라졌다",
  );
  for (const state of SOURCE_STATES) {
    const label = SOURCE_STATE_LABELS[state];
    assert.ok(label && label.trim().length > 0, `${state}: 라벨이 비었다`);
    assert.ok(!/\d/.test(label), `${state}: 라벨에 숫자가 있다 — ${label}`);
  }
  // The four labels have to be four different sentences or they distinguish nothing.
  assert.equal(new Set(Object.values(SOURCE_STATE_LABELS)).size, 4, "라벨이 겹친다");
}

{
  // "distinguished by wording, not only by color" — real and simulated read differently.
  assert.notEqual(SOURCE_STATE_LABELS.real, SOURCE_STATE_LABELS.simulated);
  assert.ok(/실제/.test(SOURCE_STATE_LABELS.real), SOURCE_STATE_LABELS.real);
  assert.ok(/가상|해 본/.test(SOURCE_STATE_LABELS.simulated), SOURCE_STATE_LABELS.simulated);
}

{
  // Amber is used **only on states that can be confused**. Amber on real drains the warning of meaning.
  assert.ok(AMBER_STATES.includes("simulated"), "가상인데 표시가 없다");
  assert.ok(!AMBER_STATES.includes("real"), "실제에 경고색을 썼다 — 경고가 의미를 잃는다");
  assert.ok(!AMBER_STATES.includes("self_reported"), "내가 적은 것은 혼동 상태가 아니다");
}

{
  // An event with no label reads as **unverified**, not as "no label". Never as real.
  assert.equal(sourceStateLabel(undefined), SOURCE_STATE_LABELS.unverified);
  assert.equal(sourceStateLabel(null), SOURCE_STATE_LABELS.unverified);
  assert.equal(sourceStateLabel("이런_값은_없다"), SOURCE_STATE_LABELS.unverified);
  assert.notEqual(sourceStateLabel(undefined), SOURCE_STATE_LABELS.real);
}

// ── 2. SX-46 — simulation never mixes into the record of what happened ──────

{
  const rows = [
    row({ id: "r1", source_state: "real" }),
    row({ id: "s1", source_state: "simulated", text: "가짜 결제 버튼을 눌러 봤다" }),
    row({ id: "u1", source_state: "unverified" }),
    row({ id: "sr1", source_state: "self_reported" }),
  ];
  const { real, aside } = partitionBySourceState(rows);
  assert.deepEqual(real.map((r) => r.id), ["r1"], "실제 칸에 실제가 아닌 것이 섞였다");
  assert.deepEqual(aside.map((r) => r.id).sort(), ["s1", "sr1", "u1"], "별도 칸이 빠뜨린 것이 있다");
  // Negative control: a single simulated row landing on the real side is SX-21's negative condition.
  assert.ok(!real.some((r) => r.source_state === "simulated"), "가상이 실제 칸에 섞였다");
}

{
  // Empty input yields two empty buckets. It does not throw.
  const { real, aside } = partitionBySourceState([]);
  assert.deepEqual(real, []);
  assert.deepEqual(aside, []);
}

// ── 3. SX-46 negative — an attempt to save as real without provenance is refused ──

{
  // For `external_feedback_received` the kind table already makes provenance required.
  // So this kind **cannot tell** whether the "real rule" runs on its own — the planted
  // defect "saves real even without a source" passed right here. The place where the
  // rule actually branches is a kind where provenance is **not** required.
  const denied = learningEventRequest(
    { kind: "test_observed", criterion_ref: "cs1", artifact_after: "a".repeat(64), outcome: "match", source_state: "real" },
    { ...CTX, sender: "webview-form" },
  );
  assert.equal(denied.ok, false, "출처도 실행 결과도 없이 '실제로 있었던 일' 로 저장됐다 (SX-46)");
  assert.equal(denied.code, "missing_provenance");

  // An attached execution result makes it real — provenance is not the only path.
  const executed = learningEventRequest(
    { kind: "test_observed", criterion_ref: "cs1", artifact_after: "a".repeat(64), outcome: "match", source_state: "real", result_ref: "r1" },
    { ...CTX, sender: "webview-form" },
  );
  assert.equal(executed.ok, true, `실행 결과가 묶였는데 막혔다: ${JSON.stringify(executed)}`);

  // Filling all three fields with the "미기록" sentinel is **not writing anything
  // down** (SX-20). Letting that through turns the sentinel into a back door around
  // the provenance rule.
  const sentinel = learningEventRequest(
    {
      kind: "external_feedback_received",
      student_text: "사고 싶어요",
      source_kind: "interview",
      source_state: "real",
      provenance: { who: "미기록", when: "미기록", where: "미기록" },
    },
    { ...CTX, sender: "webview-form", stepEvidenceType: "intent" },
  );
  assert.equal(sentinel.ok, false, "'미기록' 세 칸으로 실제 라벨을 얻었다 — 센티널이 뒷문이 됐다");
  assert.equal(sentinel.code, "missing_provenance");
}

{
  // Positive control: with provenance it does save as real — this catches an over-strict instrument.
  const allowed = learningEventRequest(
    {
      kind: "external_feedback_received",
      student_text: "사고 싶어요",
      source_kind: "interview",
      source_state: "real",
      provenance: { who: "옆 반 친구", when: "어제", where: "쉬는 시간" },
    },
    { ...CTX, sender: "webview-form", stepEvidenceType: "intent" },
  );
  assert.equal(allowed.ok, true, `출처를 적었는데도 막혔다: ${JSON.stringify(allowed)}`);
  assert.equal(allowed.event.source_state, "real");
}

{
  // simulated saves without provenance. Having no source is normal for a simulation.
  const sim = learningEventRequest(
    {
      kind: "external_feedback_received",
      student_text: "가짜 결제 버튼을 눌러 봤다",
      source_kind: "test",
      source_state: "simulated",
      provenance: { who: "미기록", when: "미기록", where: "미기록" },
    },
    { ...CTX, sender: "webview-form", stepEvidenceType: "intent" },
  );
  assert.equal(sim.ok, true, `가상 기록이 막혔다: ${JSON.stringify(sim)}`);
  assert.equal(sim.event.source_state, "simulated");
}

// ── 4. SX-19 — mixed KO/EN source text is stored verbatim ───────────────────

{
  const mixed = "I'd buy this, 근데 가격이 too expensive 예요";
  const made = learningEventRequest(
    {
      kind: "external_feedback_received",
      student_text: mixed,
      source_kind: "interview",
      source_state: "unverified",
      provenance: { who: "Minjun", when: "미기록", where: "미기록" },
    },
    { ...CTX, sender: "webview-form", stepEvidenceType: "intent" },
  );
  assert.equal(made.ok, true);
  assert.equal(made.event.student_text, mixed, "혼용 원문이 정규화·번역됐다 (SX-19 부정 조건)");
}

// ── 5. Screen — judged on the actual render ─────────────────────────────────

const status = rendererStatus();
if (!status.available) {
  console.log(`sx-source-state: 렌더 판정 건너뜀 — ${status.detail}`);
  console.log("sx-source-state: OK (순수 판정만)");
} else {
  const rows = [
    row({ id: "r1", source_state: "real", text: "실제로 사고 싶다고 했어요", provenance: { who: "옆 반 친구", when: "어제", where: "교실" } }),
    row({ id: "s1", source_state: "simulated", text: "가짜 결제 버튼을 눌러 봤다" }),
  ];
  const html = await renderComponent("EvidenceDrawer", {
    open: true,
    rows,
    verification: { state: "none", source_state: "unverified", line: "아직 고쳐 달라고 한 것이 없어요" },
    onSubmit: () => {},
    onToggle: () => {},
  });
  const text = visibleText(html);

  // Both labels are on screen as wording.
  assert.ok(text.includes(SOURCE_STATE_LABELS.real), `실제 라벨이 화면에 없다:\n${text}`);
  assert.ok(text.includes(SOURCE_STATE_LABELS.simulated), `가상 라벨이 화면에 없다:\n${text}`);
  // The simulated marker is in the markup and not only in the color (it has to be
  // distinguishable for the color-blind and in black-and-white print).
  // This was first written as `A|B`, which passes when only one side survives — the
  // planted defect "erase the simulated marker from the markup" escaped exactly that
  // way. We require **both**.
  assert.ok(/class="[^"]*hp-amber/.test(html), "가상 줄에 표시 class 가 없다");
  assert.ok(/data-source-state="simulated"/.test(html), "가상 표시가 색뿐이다 — 마크업에 남지 않았다");
  assert.ok(/data-source-state="real"/.test(html), "실제 줄에도 상태가 마크업에 있어야 한다");

  // F-9 — even when an unknown value arrives, **the markup and the label say the same
  // thing.** Originally only the label was normalized while `data-source-state` and
  // amber used the raw value, so one row could be read two ways.
  const odd = await renderComponent("EvidenceDrawer", {
    open: true,
    rows: [row({ id: "x1", source_state: "이런_값은_없다", text: "출처를 모르는 말" })],
    verification: { state: "none", source_state: "unverified", line: "아직 고쳐 달라고 한 것이 없어요" },
    onSubmit: () => {},
    onToggle: () => {},
  });
  assert.ok(!/data-source-state="이런_값은_없다"/.test(odd), "모르는 값이 마크업에 그대로 새어 나갔다");
  assert.ok(/data-source-state="unverified"/.test(odd), "모르는 값이 unverified 로 떨어지지 않았다");
  assert.ok(visibleText(odd).includes(SOURCE_STATE_LABELS.unverified), "라벨과 마크업이 다른 말을 한다");
  assert.ok(!/data-source-state="real"/.test(odd), "모르는 값이 real 로 승격됐다");
  // A real row never carries that marker.
  assert.ok(!/data-source-state="simulated"[^>]*>[^<]*실제로/.test(html));

  // **No counting.** Wording like "외부 반응 2건" mixes simulation into the record.
  assert.ok(!/반응\s*\d+\s*건|\d+\s*명이/.test(text), `근거를 개수로 셌다:\n${text}`);

  const verdict = auditRegionText(text, { region: "work", minLength: 80 });
  assert.equal(verdict.ok, true, `라벨 화면에 금지 표현이 있다: ${JSON.stringify(verdict.findings)}`);

  console.log(`sx-source-state: 렌더 판정 OK (${text.length}자)`);
  console.log("sx-source-state: OK");
}
