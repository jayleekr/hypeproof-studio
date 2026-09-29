// SX-17 · SX-18 · SX-20 · SX-22 · SX-23 — verdicts for region D (Evidence drawer).
// Run: node --experimental-strip-types test/sx-evidence-drawer.smoke.mjs
//
// Written before the implementation (ux-dag.yaml P1-B control). Pure verdicts are called
// straight from the `.ts`; screen claims (closed by default · no interpretation · no score)
// are judged on the **actual render output** (verification.md rule 1). If react is missing
// we do not silently pass — we print the fact that we skipped.

import assert from "node:assert/strict";
import { auditRegionText } from "./sx-audit.mjs";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";
import {
  EVIDENCE_TYPE_LABELS,
  SOURCE_KIND_LABELS,
  PROVENANCE_FIELDS,
  provenanceLine,
  groupByEvidenceType,
  filterBySourceKind,
  decisionReason,
} from "../webview-ui/src/evidenceDrawerLogic.ts";

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

// ── 1. SX-18 — six evidence types. An absent one is not guessed into the six ──

{
  const types = Object.keys(EVIDENCE_TYPE_LABELS);
  assert.deepEqual(
    types,
    ["intent", "criterion", "action", "decision", "change", "ownership"],
    "설계 §관측 이벤트와 필드의 여섯 값과 달라졌다",
  );
  for (const [type, label] of Object.entries(EVIDENCE_TYPE_LABELS)) {
    assert.ok(label.trim().length > 0, `${type} 의 라벨이 비었다`);
    assert.ok(!/\d/.test(label), `${type} 라벨에 숫자가 있다: ${label}`);
  }
}

{
  // Negative control: pushing an event with no evidence_type into one of the six fails.
  const groups = groupByEvidenceType([row(), row({ id: "e2", evidence_type: undefined, kind: "artifact", actor: "ai" })]);
  const unknown = groups.find((g) => g.type === null);
  assert.ok(unknown, "종류를 모르는 근거를 담을 자리가 없다 — 어딘가로 추정해 넣었다는 뜻이다");
  assert.equal(unknown.rows.length, 1);
  assert.ok(unknown.label.includes("미기록"), `종류 미기록 라벨이 아니다: ${unknown.label}`);
  const criterionGroup = groups.find((g) => g.type === "criterion");
  assert.equal(criterionGroup.rows.length, 1, "종류가 있는 근거가 엉뚱한 묶음으로 갔다");
}

{
  // Positive control: the six types each land in their own group.
  const rows = ["intent", "criterion", "action", "decision", "change", "ownership"].map((t, i) =>
    row({ id: `e${i}`, evidence_type: t }),
  );
  const groups = groupByEvidenceType(rows).filter((g) => g.rows.length > 0);
  assert.equal(groups.length, 6, "여섯 종류가 한 묶음으로 뭉쳤다");
}

// ── 2. SX-20 — provenance. Blank reads "source not recorded", never guessed ───

{
  assert.equal(provenanceLine(row({ provenance: null })), "출처 미기록");
  assert.equal(
    provenanceLine(row({ provenance: { who: "옆 반 친구", when: "어제", where: "쉬는 시간 교실" } })),
    "옆 반 친구 · 어제 · 쉬는 시간 교실",
  );
}

{
  // Negative control: a half-filled provenance that looks complete is a failure.
  const partial = provenanceLine(row({ provenance: { who: "친구", when: "", where: "" } }));
  assert.ok(partial.includes("미기록"), `빠진 칸이 있는데 완성된 출처처럼 보인다: ${partial}`);
  assert.ok(partial.includes("친구"), "적어 준 것까지 지우면 안 된다");
}

{
  // A generalized statement is stored, but carries the unverified label.
  const line = provenanceLine(row({ source_state: "unverified", provenance: null }));
  assert.ok(line.includes("미기록"), line);
}

// ── 3. SX-22 — each source kind needs different provenance fields ───────────

{
  const kinds = Object.keys(SOURCE_KIND_LABELS);
  assert.deepEqual(
    kinds,
    ["link", "article", "policy", "interview", "test", "none"],
    "설계 §관측 이벤트와 필드의 source_kind 와 달라졌다",
  );
  // interview: speaker · date. policy: document name · clause.
  assert.deepEqual(PROVENANCE_FIELDS.interview.map((f) => f.key), ["who", "when"]);
  assert.deepEqual(PROVENANCE_FIELDS.policy.map((f) => f.key), ["where", "who"]);
  assert.ok(PROVENANCE_FIELDS.policy.some((f) => f.label.includes("조항")), "규정에 조항 칸이 없다");
  assert.ok(PROVENANCE_FIELDS.interview.some((f) => f.label.includes("화자") || f.label.includes("말한")), "인터뷰에 화자 칸이 없다");
  // Negative control: if every kind demands the same fields, SX-22 cannot be met.
  const shapes = new Set(kinds.map((k) => PROVENANCE_FIELDS[k].map((f) => f.key).join(",")));
  assert.ok(shapes.size > 1, "종류를 구분하지 않고 같은 칸을 쓰고 있다");
}

{
  // The list can be filtered by kind.
  const rows = [row({ source_kind: "interview" }), row({ id: "e2", source_kind: "policy" })];
  assert.equal(filterBySourceKind(rows, "interview").length, 1);
  assert.equal(filterBySourceKind(rows, null).length, 2, "필터 없음이 전부를 뜻하지 않는다");
}

// ── 4. SX-23 — decision reason. Blank reads "reason not recorded"; AI never fills it ──

{
  assert.equal(decisionReason(row({ kind: "decision_revised", text: "" })), "이유 미기록");
  assert.equal(decisionReason(row({ kind: "decision_revised", text: "더 빨리 만들 수 있어서" })), "더 빨리 만들 수 있어서");
  // A reason with actor=ai must not read as the student's own judgment.
  const byAi = decisionReason(row({ kind: "decision_revised", actor: "ai", text: "코치가 요약한 이유" }));
  assert.ok(byAi.includes("미기록"), `코치가 쓴 문장이 학생 이유로 보인다: ${byAi}`);
}

// ── 5. Screen claims — judged on the actual render ──────────────────────────

const status = rendererStatus();
if (!status.available) {
  console.log(`sx-evidence-drawer: 렌더 판정 건너뜀 — ${status.detail}`);
  console.log("sx-evidence-drawer: OK (순수 판정만)");
} else {
  const props = {
    open: false,
    rows: [
      row(),
      row({ id: "e2", kind: "external_feedback_received", evidence_type: "intent", actor: "external_user", source_kind: "interview", source_state: "simulated", text: "이름이 크면 좋겠어요", provenance: { who: "옆 반 친구", when: "어제", where: "교실" } }),
      row({ id: "e3", kind: "decision_revised", evidence_type: "decision", text: "더 빨리 만들 수 있어서" }),
    ],
    verification: { state: "unconfirmed", source_state: "unverified", line: "아직 같은 조건으로 다시 확인하지 않음" },
    onSubmit: () => {},
    onToggle: () => {},
  };

  const closed = await renderComponent("EvidenceDrawer", props);
  // SX-17 — closed by default. <details> must not carry the open attribute.
  assert.ok(/<details\b/.test(closed), "서랍이 details 가 아니다 — 접히지 않는다");
  assert.ok(!/<details\b[^>]*\bopen\b/.test(closed), "서랍이 작업 시작 시 열려 있다 (SX-17 부정 조건)");

  const opened = await renderComponent("EvidenceDrawer", { ...props, open: true });
  assert.ok(/<details\b[^>]*\bopen\b/.test(opened), "열라고 했는데 닫혀 있다");

  const text = visibleText(opened);
  // The student's own wording shows verbatim (SX-44).
  assert.ok(text.includes("버튼을 누르면 이름이 보여야 한다"), "학생이 쓴 기대 조건이 서랍에 없다");
  assert.ok(text.includes("이름이 크면 좋겠어요"), "인용한 외부 근거가 서랍에 없다");
  // The verification line shows (SX-15).
  assert.ok(text.includes("아직 같은 조건으로 다시 확인하지 않음"), "재확인 줄이 서랍에 없다");
  // No score · grade · rank (SX-17 negative condition, SX-59).
  //
  // `minLength` is half of this assertion. This line was first written as
  // `auditRegionText("EvidenceDrawer", text)`, but the signature is `(text, opts)`, so it
  // **audited the string "EvidenceDrawer"** and came back green — planting "성장 점수"
  // into the open drawer still passed. A hollow assertion caught by a planted defect, and
  // a textbook case of what rule 1 calls "setting the criterion without opening the subject".
  const verdict = auditRegionText(text, { region: "work", minLength: 80 });
  assert.equal(verdict.ok, true, `서랍에 금지 표현이 있다: ${JSON.stringify(verdict.findings)}`);

  console.log(`sx-evidence-drawer: 렌더 판정 OK (${text.length}자)`);
  console.log("sx-evidence-drawer: OK");
}
