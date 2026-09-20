// SX-19 · SX-21 · SX-46 — real / simulated 라벨과 원문 보존의 판정 (P1-D).
// Run: node --experimental-strip-types test/sx-source-state.smoke.mjs
//
// 구현 전에 쓰였다(ux-dag.yaml P1-D control).
//
// 이 파일이 지키려는 한 문장: **가상으로 해 본 것이 실제로 있었던 일처럼 보이면 안 된다.**
// 4주차 가짜 결제가 매출로 읽히는 것이 SX-46 이 막으려는 바로 그것이다.

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

// ── 1. SX-21 — 네 값이 UI 와 데이터에 **같은 어휘**로 있다 ──────────────────

{
  // 라벨 표가 데이터 enum 과 정확히 같은 키를 갖는다. 하나라도 어긋나면 화면에
  // 라벨 없는 상태가 생기고, SX-21 부정 조건("라벨 없는 외부 반응")에 걸린다.
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
  // 네 라벨이 서로 다른 문장이어야 구분이 된다.
  assert.equal(new Set(Object.values(SOURCE_STATE_LABELS)).size, 4, "라벨이 겹친다");
}

{
  // "색만이 아니라 문구로 구분된다" — real 과 simulated 의 문구가 다르다.
  assert.notEqual(SOURCE_STATE_LABELS.real, SOURCE_STATE_LABELS.simulated);
  assert.ok(/실제/.test(SOURCE_STATE_LABELS.real), SOURCE_STATE_LABELS.real);
  assert.ok(/가상|해 본/.test(SOURCE_STATE_LABELS.simulated), SOURCE_STATE_LABELS.simulated);
}

{
  // Amber 는 **혼동 가능한 상태에만** 쓴다. real 에 Amber 를 쓰면 경고가 의미를 잃는다.
  assert.ok(AMBER_STATES.includes("simulated"), "가상인데 표시가 없다");
  assert.ok(!AMBER_STATES.includes("real"), "실제에 경고색을 썼다 — 경고가 의미를 잃는다");
  assert.ok(!AMBER_STATES.includes("self_reported"), "내가 적은 것은 혼동 상태가 아니다");
}

{
  // 라벨 없는 이벤트는 "라벨 없음" 이 아니라 **unverified** 로 읽는다. 절대 real 이 아니다.
  assert.equal(sourceStateLabel(undefined), SOURCE_STATE_LABELS.unverified);
  assert.equal(sourceStateLabel(null), SOURCE_STATE_LABELS.unverified);
  assert.equal(sourceStateLabel("이런_값은_없다"), SOURCE_STATE_LABELS.unverified);
  assert.notEqual(sourceStateLabel(undefined), SOURCE_STATE_LABELS.real);
}

// ── 2. SX-46 — 가상은 실적에 섞이지 않는다 ──────────────────────────────────

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
  // 음성 대조군: simulated 가 real 쪽에 하나라도 들어가면 SX-21 부정 조건이다.
  assert.ok(!real.some((r) => r.source_state === "simulated"), "가상이 실제 칸에 섞였다");
}

{
  // 빈 입력에서 빈 두 칸이 나온다. 던지지 않는다.
  const { real, aside } = partitionBySourceState([]);
  assert.deepEqual(real, []);
  assert.deepEqual(aside, []);
}

// ── 3. SX-46 부정 — provenance 없이 real 로 저장하려 하면 거부한다 ──────────

{
  // `external_feedback_received` 는 kind 표가 이미 provenance 를 필수로 잡는다.
  // 그래서 이 kind 로는 "real 규칙" 이 따로 도는지 **구분되지 않는다** — 심은 결함
  // "출처 없이도 real 을 저장한다" 가 여기서 통과해 버렸다. 규칙이 실제로 갈리는
  // 자리는 provenance 가 필수가 **아닌** kind 다.
  const denied = learningEventRequest(
    { kind: "test_observed", criterion_ref: "cs1", artifact_after: "a".repeat(64), outcome: "match", source_state: "real" },
    { ...CTX, sender: "webview-form" },
  );
  assert.equal(denied.ok, false, "출처도 실행 결과도 없이 '실제로 있었던 일' 로 저장됐다 (SX-46)");
  assert.equal(denied.code, "missing_provenance");

  // 실행된 결과가 묶여 있으면 real 이 된다 — 출처만이 유일한 길은 아니다.
  const executed = learningEventRequest(
    { kind: "test_observed", criterion_ref: "cs1", artifact_after: "a".repeat(64), outcome: "match", source_state: "real", result_ref: "r1" },
    { ...CTX, sender: "webview-form" },
  );
  assert.equal(executed.ok, true, `실행 결과가 묶였는데 막혔다: ${JSON.stringify(executed)}`);

  // 세 칸을 전부 "미기록" 으로 채운 것은 **적은 것이 아니다**(SX-20).
  // 이렇게 통과시키면 센티널이 출처 규칙을 우회하는 뒷문이 된다.
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
  // 양성 대조군: provenance 가 있으면 real 로 저장된다 — 너무 엄격한 계측기를 잡는다.
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
  // simulated 는 provenance 없이도 저장된다. 가상은 출처가 없는 것이 정상이다.
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

// ── 4. SX-19 — KO/EN 혼용 원문을 그대로 저장한다 ────────────────────────────

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

// ── 5. 화면 — 실제 렌더로 판정한다 ──────────────────────────────────────────

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

  // 두 라벨이 문구로 화면에 있다.
  assert.ok(text.includes(SOURCE_STATE_LABELS.real), `실제 라벨이 화면에 없다:\n${text}`);
  assert.ok(text.includes(SOURCE_STATE_LABELS.simulated), `가상 라벨이 화면에 없다:\n${text}`);
  // 가상 표시가 색만이 아니라 마크업에도 있다(색맹·흑백 인쇄에서도 구분돼야 한다).
  // 처음에 `A|B` 로 썼는데 그러면 한쪽만 남아도 통과한다 — 심은 결함
  // "가상 표시를 마크업에서 지운다" 가 그렇게 빠져나갔다. **둘 다** 요구한다.
  assert.ok(/class="[^"]*hp-amber/.test(html), "가상 줄에 표시 class 가 없다");
  assert.ok(/data-source-state="simulated"/.test(html), "가상 표시가 색뿐이다 — 마크업에 남지 않았다");
  assert.ok(/data-source-state="real"/.test(html), "실제 줄에도 상태가 마크업에 있어야 한다");
  // 실제에는 그 표시가 붙지 않는다.
  assert.ok(!/data-source-state="simulated"[^>]*>[^<]*실제로/.test(html));

  // **개수를 세지 않는다.** "외부 반응 2건" 같은 문구가 생기면 가상이 실적에 섞인다.
  assert.ok(!/반응\s*\d+\s*건|\d+\s*명이/.test(text), `근거를 개수로 셌다:\n${text}`);

  const verdict = auditRegionText(text, { region: "work", minLength: 80 });
  assert.equal(verdict.ok, true, `라벨 화면에 금지 표현이 있다: ${JSON.stringify(verdict.findings)}`);

  console.log(`sx-source-state: 렌더 판정 OK (${text.length}자)`);
  console.log("sx-source-state: OK");
}
