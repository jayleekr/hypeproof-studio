// Every evidence row says what it is — SX-17's "각 항목은 실제 이벤트 id를 가지고" is
// worth nothing if the item itself is blank.
// Run: node --experimental-strip-types test/sx-evidence-row-title.smoke.mjs
//
// ## How this was found, and why no test had it
//
// `test_observed` and `retest_confirmed` do not require `student_text`
// (`learning-events.ts` LEARNING_EVENT_SPEC), and the drawer rendered `row.text`
// with no fallback. A valid row of either kind therefore drew as
//
//     1.
//        종류 없음  출처 미기록  내가 그렇다고 적은 것
//
// — a numbered line with no line. Every drawer test passed: they asserted on the
// badges, the grouping, the labels, and never on the row's own sentence. It
// surfaced by photographing the rendered drawer, not by reading code.
//
// So this file asserts the one thing they all skipped.

import assert from "node:assert/strict";
import { rowTitle } from "../webview-ui/src/evidenceDrawerLogic.ts";
import { KIND_LABELS } from "../src/learningStateHelpers.ts";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";

const row = (extra = {}) => ({
  id: "e1",
  kind: "criterion_set",
  evidence_type: "criterion",
  at: 1_700_000_000_000,
  text: "버튼을 누르면 이름이 보여야 한다",
  actor: "user",
  source_kind: "none",
  source_state: "self_reported",
  provenance: null,
  adopted_from: null,
  ...extra,
});

// ── 1. The student's own words win, and are marked as theirs ─────────────────
{
  const t = rowTitle(row());
  assert.equal(t.text, "버튼을 누르면 이름이 보여야 한다");
  assert.equal(t.student, true, "학생이 쓴 문장은 학생 것으로 표시돼야 한다");
}

// ── 2. Every kind that may legally arrive without student text still says something ──
{
  // Straight from the spec, not from a guess about which kinds are affected.
  const spec = await import(
    "../../../worker/src/lib/measurement-core/learning-events.ts"
  );
  const textless = Object.entries(spec.LEARNING_EVENT_SPEC)
    .filter(([, s]) => !s.required.includes("student_text"))
    .map(([kind]) => kind);

  assert.ok(
    textless.length > 0,
    "student_text 가 선택인 kind 가 하나도 없다면 이 버그는 애초에 불가능하다 — 스펙 읽기가 틀렸다",
  );

  for (const kind of textless) {
    for (const empty of ["", "   ", undefined]) {
      const t = rowTitle(row({ kind, text: empty, evidence_type: "action" }));
      assert.ok(t.text.trim().length > 0, `${kind}: 빈 줄이 그려진다`);
      assert.equal(t.student, false, `${kind}: 종류 이름을 학생의 문장으로 내보내면 안 된다`);
      assert.equal(t.text, KIND_LABELS[kind], `${kind}: 이름표가 공용 표에서 오지 않았다`);
    }
  }
}

// ── 3. Negative control — the fallback must not swallow real text ────────────
{
  // If `rowTitle` returned the kind name unconditionally, case 1 would already
  // fail. This pins the other direction: a kind with a fallback available still
  // prefers what the student wrote.
  const t = rowTitle(row({ kind: "retest_confirmed", text: "3초 안에 보였다", evidence_type: "action" }));
  assert.equal(t.text, "3초 안에 보였다");
  assert.equal(t.student, true);
  assert.notEqual(t.text, KIND_LABELS.retest_confirmed);
}

// ── 4. The rendered drawer, not the function ────────────────────────────────
const status = rendererStatus();
if (!status.available) {
  console.log(`sx-evidence-row-title: 렌더 건너뜀 — ${status.detail}`);
} else {
  const rows = [
    row({ id: "r1", kind: "retest_confirmed", text: "", evidence_type: "action" }),
    row({ id: "r2", kind: "criterion_set", text: "3초 안에 보인다", evidence_type: "criterion" }),
  ];
  const text = visibleText(
    await renderComponent("EvidenceDrawer", {
      open: true,
      rows,
      verification: { state: "none", before: null, after: null, criterion: null },
      onSubmit: () => {},
      onToggle: () => {},
    }),
  );

  assert.ok(text.includes("3초 안에 보인다"), "렌더가 죽었다 — 아래 단언이 의미를 잃는다");
  assert.ok(
    text.includes(KIND_LABELS.retest_confirmed),
    `말 없는 행이 이름 없이 그려진다 — 화면 전문:\n${text}`,
  );
  console.log("sx-evidence-row-title: OK — 말 없는 행도 이름을 가진다");
}
