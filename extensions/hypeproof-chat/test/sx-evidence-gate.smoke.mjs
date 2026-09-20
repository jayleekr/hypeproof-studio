// SX-14 · SX-45 — 완료 게이트와 "학습 이벤트는 폼에서만 생긴다" 의 판정.
// Run: node --experimental-strip-types test/sx-evidence-gate.smoke.mjs
//
// 이 파일은 **구현 전에** 쓰였다(ux-dag.yaml P1-B control). 빨간 것을 먼저 보고
// 초록으로 만든다. 판정 대상은 호스트가 실제로 부르는 순수 함수다 —
// `src/learningStateHelpers.ts`. 웹뷰는 게이트를 다시 계산하지 않는다
// (설계 §정보 구조 "호스트·웹뷰·워커의 경계").
//
// 대조군 두 종류를 모두 둔다(verification.md 규칙 2):
//   양성 — 확실히 통과해야 하는 시료가 통과한다  → 너무 엄격한 계측기를 잡는다
//   음성 — 확실히 막혀야 하는 시료가 막힌다      → 너무 관대한 계측기를 잡는다

import assert from "node:assert/strict";
import {
  acceptSubmit,
  gateSentence,
  learningState,
  learningEventRequest,
} from "../src/learningStateHelpers.ts";

const TASK = "task-abc";
const CTX = { week: 3, step_id: "s2", task: TASK, module_version: "m2026.09.20-1" };
let seq = 0;
const ev = (kind, extra = {}) => ({
  id: `e${++seq}`,
  seq,
  task: TASK,
  at: 1_700_000_000_000 + seq,
  kind,
  text: "",
  assistance: "unknown",
  ...extra,
});

const criterion = (extra = {}) =>
  ev("criterion_set", {
    actor: "user",
    student_text: "버튼을 누르면 이름이 화면에 보여야 한다",
    context: CTX,
    evidence_type: "criterion",
    source_state: "self_reported",
    ...extra,
  });
const aiDraft = () => ev("artifact", { actor: "ai", sha256: "a".repeat(64), text: "<html>…</html>" });

const COMPLETION = [
  { id: "c1", event: "criterion_set", label: "기대 조건 적기" },
  { id: "c2", event: "test_observed", label: "직접 시험하기" },
];

// ── 1. DAG P1-B 대조군 그대로 ────────────────────────────────────────────────

{
  // 음성: AI 초안만 있고 기대 조건이 없다 → 완료는 막혀야 한다 (SX-T02)
  seq = 0;
  const state = learningState({ task: TASK, events: [aiDraft()], completion: [COMPLETION[0]] });
  assert.equal(state.complete.ok, false, "초안만 있는데 완료가 열렸다 — 게이트가 너무 관대하다");
  assert.ok(state.complete.reasons.length > 0, "막았으면 이유를 말해야 한다");
  assert.ok(
    state.complete.reasons.every((r) => typeof r === "string" && r.trim().length > 0),
    "이유가 빈 문자열이면 화면에 아무것도 못 보여 준다",
  );
}

{
  // 양성: 기대 조건을 먼저 쓰고 초안을 받았다 → 완료가 열려야 한다
  seq = 0;
  const events = [criterion(), aiDraft()];
  const state = learningState({ task: TASK, events, completion: [COMPLETION[0]] });
  assert.equal(state.complete.ok, true, `기대 조건이 있는데 막혔다 — 너무 엄격하다: ${JSON.stringify(state.complete.reasons)}`);
  assert.deepEqual(state.complete.reasons, []);
}

// ── 2. SX-14 의 나머지 조항 ──────────────────────────────────────────────────

{
  // 코치가 쓴 기대 조건(actor=ai)은 게이트를 통과하지 못한다.
  seq = 0;
  const state = learningState({
    task: TASK,
    events: [ev("criterion_set", { actor: "ai", context: CTX, evidence_type: "criterion", source_state: "self_reported" }), aiDraft()],
    completion: [COMPLETION[0]],
  });
  assert.equal(state.complete.ok, false, "코치가 쓴 기대 조건이 학생 것으로 집계됐다 (SX-45)");
}

{
  // 코치 제안을 학생이 **폼에서 제출**했다면 actor=user + adopted_from 이고 통과한다
  // (설계 §관측 이벤트와 필드 규칙 4). SX-14 본문과 어긋나는 자리이고
  // STATE.md 개정 제안 9번에 올려 뒀다.
  seq = 0;
  const state = learningState({
    task: TASK,
    events: [criterion({ adopted_from: "coach-1" }), aiDraft()],
    completion: [COMPLETION[0]],
  });
  assert.equal(state.complete.ok, true, "학생이 제출한 채택 기대 조건이 막혔다");
  assert.equal(
    state.evidence.find((r) => r.kind === "criterion_set")?.adopted_from,
    "coach-1",
    "채택 표시가 서랍까지 가야 한다",
  );
}

{
  // 완료 조건이 둘인데 하나만 있으면 막히고, **빠진 쪽의 이름**이 이유에 들어간다.
  seq = 0;
  const state = learningState({ task: TASK, events: [criterion()], completion: COMPLETION });
  assert.equal(state.complete.ok, false);
  assert.ok(
    state.complete.reasons.some((r) => r.includes("직접 시험")),
    `빠진 항목의 라벨이 이유에 없다: ${JSON.stringify(state.complete.reasons)}`,
  );
  assert.ok(
    !state.complete.reasons.some((r) => r.includes("기대 조건")),
    "이미 한 것을 아직 안 했다고 말하면 안 된다",
  );
}

{
  // 세션 설계가 완료 조건을 선언하지 않은 단계: 초안도 없으면 열려 있다.
  seq = 0;
  const state = learningState({ task: TASK, events: [], completion: [] });
  assert.equal(state.complete.ok, true, "요구하지 않은 것을 요구하고 있다");
  assert.equal(state.declared, false, "완료 조건 선언이 없다는 사실 자체가 화면에 보여야 한다 (SX-14 예외 조항)");
}

{
  // 다른 Task 의 이벤트는 이 Task 의 게이트를 열지 못한다.
  seq = 0;
  const mine = aiDraft();
  const other = criterion({ task: "task-other" });
  const state = learningState({ task: TASK, events: [mine, other], completion: [COMPLETION[0]] });
  assert.equal(state.complete.ok, false, "옆 과제의 기대 조건으로 완료가 열렸다");
  // 게이트만 보면 코어가 한 번 더 걸러 주기 때문에 이 결함이 드러나지 않는다.
  // (심은 결함 "다른 Task 의 이벤트까지 집계" 가 여기서 통과해 버렸다.)
  // **서랍 목록**까지 봐야 호스트 쪽 필터가 실제로 있는지 판정된다.
  assert.deepEqual(
    state.evidence.map((r) => r.id),
    [mine.id],
    "옆 과제의 근거가 이 과제의 서랍에 섞여 들어왔다",
  );
}

// ── 3. 이유 문장에 숫자·점수가 없다 (SX-14 3항, SX-59) ───────────────────────

{
  seq = 0;
  const state = learningState({ task: TASK, events: [aiDraft()], completion: COMPLETION });
  for (const reason of state.complete.reasons) {
    assert.ok(!/\d/.test(reason), `이유 문장에 숫자가 있다: ${reason}`);
    assert.ok(!/점수|등급|레벨|score|grade|level/i.test(reason), `이유 문장이 점수로 읽힌다: ${reason}`);
  }
}

{
  // gateSentence 는 모르는 code 를 받아도 빈 문장을 돌려주지 않는다.
  const sentence = gateSentence({ code: "이런_코드는_없다" });
  assert.ok(typeof sentence === "string" && sentence.trim().length > 0, "모르는 이유가 빈 줄이 되면 버튼 옆이 비어 보인다");
  assert.ok(!/\d/.test(sentence));
}

// ── 3b. SX-14 부정 조건 — 버튼을 우회해도 호스트가 거절한다 ─────────────────

{
  // 웹뷰가 무엇을 보내든 호스트가 같은 게이트로 다시 판정한다. `disabled` 속성을
  // 지우고 메시지를 직접 던진 상황이 이것이다.
  seq = 0;
  const denied = acceptSubmit({ task: TASK, events: [aiDraft()], completion: [COMPLETION[0]] });
  assert.equal(denied.ok, false, "기대 조건 없이 완료가 받아들여졌다 — disabled 가 유일한 잠금이면 잠금이 아니다");
  assert.ok(denied.reasons.length > 0, "거절 사유를 말하지 않는다");

  seq = 0;
  const allowed = acceptSubmit({ task: TASK, events: [criterion(), aiDraft()], completion: [COMPLETION[0]] });
  assert.equal(allowed.ok, true, "조건을 갖췄는데 제출이 막혔다");
}

{
  // 화면이 보는 판정과 호스트가 보는 판정이 **같은 함수**에서 나온다.
  // 갈라지면 "화면은 열려 있는데 제출은 거절" 이 된다.
  seq = 0;
  const events = [criterion(), aiDraft()];
  const shown = learningState({ task: TASK, events, completion: COMPLETION });
  const server = acceptSubmit({ task: TASK, events, completion: COMPLETION });
  assert.equal(shown.complete.ok, server.ok, "화면 판정과 제출 판정이 갈라졌다");
  assert.deepEqual(shown.complete.reasons, server.ok ? [] : server.reasons);
}

// ── 4. SX-45 규칙 2 — 학습 이벤트는 웹뷰 폼 제출만 만든다 ───────────────────

{
  const ok = learningEventRequest(
    { kind: "criterion_set", student_text: "버튼을 누르면 이름이 보인다" },
    { ...CTX, sender: "webview-form" },
  );
  assert.equal(ok.ok, true, `폼 제출이 막혔다: ${JSON.stringify(ok)}`);
  assert.equal(ok.event.actor, "user", "폼 제출은 학생 것이다");
  assert.equal(ok.event.student_text, "버튼을 누르면 이름이 보인다", "학생 원문은 그대로 저장된다 (SX-44)");
  assert.deepEqual(ok.event.context, CTX, "context 는 호스트가 채운다");
  assert.equal(ok.event.evidence_type, "criterion");
}

{
  // 코치 스트림 콜백은 학습 kind 를 만들 수 없다.
  const denied = learningEventRequest(
    { kind: "criterion_set", student_text: "코치가 대신 적는다" },
    { ...CTX, sender: "coach-stream" },
  );
  assert.equal(denied.ok, false, "코치 스트림이 학습 이벤트를 만들었다 (SX-45 규칙 2)");
  assert.equal(denied.code, "sender_not_form");
}

{
  // 웹뷰가 actor 를 스스로 정하려 해도 무시된다 — 호스트가 정한다.
  const forced = learningEventRequest(
    { kind: "criterion_set", student_text: "직접 적은 기대 조건", actor: "teacher" },
    { ...CTX, sender: "webview-form" },
  );
  assert.equal(forced.ok, true);
  assert.equal(forced.event.actor, "user", "웹뷰가 보낸 actor 가 그대로 저장됐다");
}

{
  // 학습 kind 가 아닌 것은 이 경로로 들어오지 않는다.
  const bad = learningEventRequest({ kind: "tool_result" }, { ...CTX, sender: "webview-form" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "not_learning_kind");
}

{
  // 필수 필드가 비면 거절한다. 채워 주지 않는다.
  const empty = learningEventRequest({ kind: "criterion_set", student_text: "   " }, { ...CTX, sender: "webview-form" });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "missing_student_text");
}

// ── 5. 재확인 게이트가 서랍 줄까지 온다 (SX-15) ──────────────────────────────

{
  seq = 0;
  const c = criterion();
  const before = aiDraft();
  const change = ev("change_requested", {
    actor: "user",
    student_text: "이름이 안 보여요. 고쳐 주세요",
    criterion_ref: c.id,
    artifact_before: before.sha256,
    turn_ref: "t1",
    context: CTX,
    evidence_type: "change",
    source_state: "self_reported",
  });
  const state = learningState({ task: TASK, events: [c, before, change], completion: [] });
  assert.equal(state.verification.state, "unconfirmed");
  assert.ok(
    state.verification.line.includes("다시 확인"),
    `검증 줄이 설계 문구와 다르다: ${state.verification.line}`,
  );
  assert.ok(!/\d/.test(state.verification.line), "검증 줄에 숫자가 있다");
}

// ── 6. 폼이 만든 초안이 정말 `/2` 로 저장되는가 ─────────────────────────────
//
// 여기가 이 파일에서 가장 값이 큰 자리다. 폼 → 호스트 → 검증기 세 계층 중 하나만
// 어긋나도 "설정은 맞는데 동작이 없는" 유형이 된다(.claude/rules/verification.md
// "CI 초록은 아무것도 보장하지 않는다" 의 1번·5번). 실제로 이 단언을 쓰면서 두 개가
// 걸렸다: `evidence_refs: []` 와 빈 `provenance` 는 저장은 되고 **다음 읽기에서**
// 배치 전체가 거절된다.

{
  const { validateObservation } = await import("../src/nativeObservationContract.ts");
  const batchOf = (events) => ({
    format: "hps-observation/2",
    scope: "s",
    session: "sess",
    program: "p",
    events: events.map((e, i) => ({
      id: `f${i + 1}`,
      seq: i + 1,
      task: TASK,
      at: 1_700_000_000_000 + i,
      text: e.student_text ?? "",
      assistance: "unknown",
      ...e,
    })),
  });

  // 서랍의 세 폼이 실제로 만드는 초안. 컴포넌트가 부르는 인자 그대로 적는다.
  const FORM_DRAFTS = [
    { name: "기대 조건 폼", body: { kind: "criterion_set", student_text: "버튼을 누르면 이름이 보인다" } },
    {
      name: "들은 말 폼",
      body: {
        kind: "external_feedback_received",
        student_text: "이름이 더 크면 좋겠어요",
        source_kind: "interview",
        provenance: { who: "옆 반 친구", when: "미기록", where: "미기록" },
        source_state: "unverified",
      },
    },
    {
      name: "이유 폼",
      // `evidence_refs` 는 **같은 배치 안의 이벤트 id** 여야 한다(없으면 orphan_ref).
      // 그래서 앞선 이벤트를 하나 깔고 그것을 가리킨다 — 화면에서도 학생이 고른
      // 대안이 이미 기록돼 있는 상태에서만 이유 폼이 열린다(`pendingDecision`).
      prefix: [
        {
          kind: "criterion_set",
          actor: "user",
          student_text: "이름이 보여야 한다",
          context: CTX,
          evidence_type: "criterion",
          source_state: "self_reported",
        },
      ],
      body: {
        kind: "decision_revised",
        student_text: "더 빨리 만들 수 있어서",
        decision: { from: "직접 짜기", to: "코치 초안 고치기" },
        evidence_refs: ["f1"],
      },
    },
  ];

  for (const { name, body, prefix = [] } of FORM_DRAFTS) {
    // `external_feedback_received` 의 evidence_type 은 kind 표가 정하지 않고
    // **단계 `evidence`** 가 정한다(설계 표). 호스트가 그것을 넘겨준다.
    const made = learningEventRequest(body, { ...CTX, sender: "webview-form", stepEvidenceType: "intent" });
    assert.equal(made.ok, true, `${name} 의 초안이 호스트에서 막혔다: ${JSON.stringify(made)}`);
    // 검증기는 잘못된 이벤트를 `missing` 에 담지 않고 **던진다**. 처음 이 줄을
    // `checked.missing.length === 0` 으로 썼는데 `missing` 은 seq 구멍을 뜻해서
    // 무엇이 통과하든 초록이었다 — 대상을 열어보지 않고 기준을 세운 자리다(규칙 1).
    let checked;
    assert.doesNotThrow(() => {
      checked = validateObservation(batchOf([...prefix, made.event]));
    }, `${name} 이 만든 이벤트를 검증기가 거절했다`);
    assert.equal(
      checked.batch.events.length,
      prefix.length + 1,
      `${name} 이 만든 이벤트가 저장에서 사라졌다`,
    );
  }

  // 음성 대조군 — 빈 evidence_refs 와 빠진 decision 은 **만드는 자리에서** 막힌다.
  const emptyRefs = learningEventRequest(
    { kind: "decision_revised", student_text: "이유", decision: { from: "a", to: "b" }, evidence_refs: [] },
    { ...CTX, sender: "webview-form" },
  );
  assert.equal(emptyRefs.ok, false, "빈 근거 목록이 통과했다 — 저장은 되고 다음 읽기에서 배치가 거절된다");
  assert.equal(emptyRefs.code, "missing_evidence_refs");

  const noDecision = learningEventRequest(
    { kind: "decision_revised", student_text: "이유", evidence_refs: ["e1"] },
    { ...CTX, sender: "webview-form" },
  );
  assert.equal(noDecision.ok, false, "고른 것이 없는 이유가 통과했다");
  assert.equal(noDecision.code, "missing_decision");

  // 단계가 근거 종류를 정해 주지 않으면 여섯 중 하나를 골라 넣지 않고 거절한다.
  const noType = learningEventRequest(
    {
      kind: "external_feedback_received",
      student_text: "들은 말",
      provenance: { who: "친구", when: "미기록", where: "미기록" },
      source_state: "unverified",
    },
    { ...CTX, sender: "webview-form" },
  );
  assert.equal(noType.ok, false, "근거 종류를 추정해서 채웠다 (SX-18 부정 조건)");
  assert.equal(noType.code, "missing_evidence_type");

  // 그리고 그 음성 시료가 **정말** 검증기에서도 거절되는지 확인한다.
  // 이걸 안 보면 "호스트가 막았다" 가 과잉 엄격인지 알 수 없다(규칙 2, 양성/음성 짝).
  assert.throws(
    () =>
      validateObservation(
        batchOf([
          {
            kind: "decision_revised",
            actor: "user",
            student_text: "이유",
            context: CTX,
            evidence_type: "decision",
            source_state: "self_reported",
            decision: { from: "a", to: "b" },
            evidence_refs: [],
          },
        ]),
      ),
    /invalid_learning_event/,
    "검증기는 빈 근거 목록을 받아 준다 — 그렇다면 호스트 쪽 거절이 과잉 엄격이다",
  );
}

console.log("sx-evidence-gate: OK");
