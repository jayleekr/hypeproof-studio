// SX-14 · SX-45 — the verdict for the completion gate and for "learning events are only born in a form".
// Run: node --experimental-strip-types test/sx-evidence-gate.smoke.mjs
//
// This file was written **before the implementation** (ux-dag.yaml P1-B control). See red first,
// then make it green. What gets judged is the pure function the host actually calls —
// `src/learningStateHelpers.ts`. The webview does not recompute the gate
// (design §정보 구조 "호스트·웹뷰·워커의 경계").
//
// Both kinds of control are kept (verification.md rule 2):
//   positive — a sample that must certainly pass, passes  → catches an instrument that is too strict
//   negative — a sample that must certainly be blocked, is blocked → catches one that is too lenient

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

// ── 1. The DAG P1-B controls, verbatim ──────────────────────────────────────

{
  // Negative: only an AI draft, no criterion → completion must be blocked (SX-T02)
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
  // Positive: the criterion was written first, then the draft arrived → completion must open
  seq = 0;
  const events = [criterion(), aiDraft()];
  const state = learningState({ task: TASK, events, completion: [COMPLETION[0]] });
  assert.equal(state.complete.ok, true, `기대 조건이 있는데 막혔다 — 너무 엄격하다: ${JSON.stringify(state.complete.reasons)}`);
  assert.deepEqual(state.complete.reasons, []);
}

// ── 2. The rest of SX-14's clauses ──────────────────────────────────────────

{
  // A criterion written by the coach (actor=ai) does not pass the gate.
  //
  // **This sample must carry a `student_text`.** The first version had none, and because
  // `satisfiesGate()` returns false at the text clause first, **the actor clause never ran once.**
  // The assertion was green while measuring nothing — deleting the whole `isStudentAuthored`
  // clause left the entire suite green (judge F-2). Filling the text in is what leaves only the
  // actor clause. The validator rejects this event as `ai_text_as_student`, but `satisfiesGate`
  // is a pure function we can call directly, and that clause is exactly what is measured here.
  seq = 0;
  const state = learningState({
    task: TASK,
    events: [
      ev("criterion_set", {
        actor: "ai",
        student_text: "코치가 대신 적어 준 기대 조건",
        context: CTX,
        evidence_type: "criterion",
        source_state: "self_reported",
      }),
      aiDraft(),
    ],
    completion: [COMPLETION[0]],
  });
  assert.equal(state.complete.ok, false, "코치가 쓴 기대 조건이 학생 것으로 집계됐다 (SX-45)");
}

{
  // For a kind that has **no `student_text` field at all**, the actor clause is the only defense.
  // The instructor can pick any of the 8 in `learning.completion`, so this path really is used.
  // The sample above does not cover this spot on its own.
  seq = 0;
  const byCoach = ev("test_observed", {
    actor: "ai",
    criterion_ref: "cs1",
    artifact_after: "a".repeat(64),
    outcome: "match",
    context: CTX,
    evidence_type: "action",
    source_state: "self_reported",
  });
  const state = learningState({
    task: TASK,
    events: [criterion(), byCoach],
    completion: [{ id: "c2", event: "test_observed", label: "직접 시험하기" }],
  });
  assert.equal(state.complete.ok, false, "코치가 '확인했다' 고 한 것이 학생의 확인으로 집계됐다");

  // Positive control — the same event submitted by the student passes. Shows that what blocks is
  // **actor**, not kind.
  seq = 0;
  const byStudent = { ...byCoach, actor: "user" };
  const ok = learningState({
    task: TASK,
    events: [criterion(), byStudent],
    completion: [{ id: "c2", event: "test_observed", label: "직접 시험하기" }],
  });
  assert.equal(ok.complete.ok, true, "학생이 직접 확인했는데 막혔다 — 너무 엄격하다");
}

{
  // If the student **submitted it from the form**, a coach suggestion is actor=user + adopted_from
  // and it passes (design §관측 이벤트와 필드 규칙 4). This is a spot that
  // diverges from the body of SX-14, and it is filed as revision proposal 9 in STATE.md.
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
  // With two completion conditions and only one of them present it blocks, and **the name of the
  // missing one** goes into the reason.
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
  // A step where the session design declared no completion condition: with no draft either, it is open.
  seq = 0;
  const state = learningState({ task: TASK, events: [], completion: [] });
  assert.equal(state.complete.ok, true, "요구하지 않은 것을 요구하고 있다");
  assert.equal(state.declared, false, "완료 조건 선언이 없다는 사실 자체가 화면에 보여야 한다 (SX-14 예외 조항)");
}

{
  // Another Task's events cannot open this Task's gate.
  seq = 0;
  const mine = aiDraft();
  const other = criterion({ task: "task-other" });
  const state = learningState({ task: TASK, events: [mine, other], completion: [COMPLETION[0]] });
  assert.equal(state.complete.ok, false, "옆 과제의 기대 조건으로 완료가 열렸다");
  // Looking at the gate alone does not expose this defect, because the core filters it once more.
  // (The planted defect "counts events from another Task too" passed right through here.)
  // Only looking at **the drawer list** judges whether the host-side filter actually exists.
  assert.deepEqual(
    state.evidence.map((r) => r.id),
    [mine.id],
    "옆 과제의 근거가 이 과제의 서랍에 섞여 들어왔다",
  );
}

// ── 3. No numbers or scores in the reason sentences (SX-14 clause 3, SX-59) ─

{
  seq = 0;
  const state = learningState({ task: TASK, events: [aiDraft()], completion: COMPLETION });
  for (const reason of state.complete.reasons) {
    assert.ok(!/\d/.test(reason), `이유 문장에 숫자가 있다: ${reason}`);
    assert.ok(!/점수|등급|레벨|score|grade|level/i.test(reason), `이유 문장이 점수로 읽힌다: ${reason}`);
  }
}

{
  // gateSentence never returns an empty sentence, even for a code it does not know.
  const sentence = gateSentence({ code: "이런_코드는_없다" });
  assert.ok(typeof sentence === "string" && sentence.trim().length > 0, "모르는 이유가 빈 줄이 되면 버튼 옆이 비어 보인다");
  assert.ok(!/\d/.test(sentence));
}

// ── 3b. SX-14 negative condition — bypass the button, the host still rejects ─

{
  // Whatever the webview sends, the host judges it again with the same gate. This is the situation
  // where the `disabled` attribute was deleted and the message thrown directly.
  seq = 0;
  const denied = acceptSubmit({ task: TASK, events: [aiDraft()], completion: [COMPLETION[0]] });
  assert.equal(denied.ok, false, "기대 조건 없이 완료가 받아들여졌다 — disabled 가 유일한 잠금이면 잠금이 아니다");
  assert.ok(denied.reasons.length > 0, "거절 사유를 말하지 않는다");

  seq = 0;
  const allowed = acceptSubmit({ task: TASK, events: [criterion(), aiDraft()], completion: [COMPLETION[0]] });
  assert.equal(allowed.ok, true, "조건을 갖췄는데 제출이 막혔다");
}

{
  // The verdict the screen sees and the verdict the host sees come out of the **same function**.
  // If they split, you get "the screen is open but the submit is rejected".
  seq = 0;
  const events = [criterion(), aiDraft()];
  const shown = learningState({ task: TASK, events, completion: COMPLETION });
  const server = acceptSubmit({ task: TASK, events, completion: COMPLETION });
  assert.equal(shown.complete.ok, server.ok, "화면 판정과 제출 판정이 갈라졌다");
  assert.deepEqual(shown.complete.reasons, server.ok ? [] : server.reasons);
}

// ── 4. SX-45 rule 2 — only a webview form submit makes a learning event ─────

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
  // A coach stream callback cannot make a learning kind.
  const denied = learningEventRequest(
    { kind: "criterion_set", student_text: "코치가 대신 적는다" },
    { ...CTX, sender: "coach-stream" },
  );
  assert.equal(denied.ok, false, "코치 스트림이 학습 이벤트를 만들었다 (SX-45 규칙 2)");
  assert.equal(denied.code, "sender_not_form");
}

{
  // Even if the webview tries to decide actor itself, it is ignored — the host decides.
  const forced = learningEventRequest(
    { kind: "criterion_set", student_text: "직접 적은 기대 조건", actor: "teacher" },
    { ...CTX, sender: "webview-form" },
  );
  assert.equal(forced.ok, true);
  assert.equal(forced.event.actor, "user", "웹뷰가 보낸 actor 가 그대로 저장됐다");
}

{
  // Anything that is not a learning kind does not come in through this path.
  const bad = learningEventRequest({ kind: "tool_result" }, { ...CTX, sender: "webview-form" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "not_learning_kind");
}

{
  // An empty required field is rejected. We do not fill it in.
  const empty = learningEventRequest({ kind: "criterion_set", student_text: "   " }, { ...CTX, sender: "webview-form" });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "missing_student_text");
}

// ── 5. The recheck gate reaches the drawer row (SX-15) ──────────────────────

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

// ── 6. Does a draft made by the form really save as `/2` ────────────────────
//
// This is the highest-value spot in this file. If any one of the three layers — form → host →
// validator — is off, you get the "the setting is right but there is no behavior" type
// (.claude/rules/verification.md, "CI green guarantees nothing", items 1 and 5). Two were actually
// caught while writing these assertions: `evidence_refs: []` and an empty `provenance` do save,
// and then **on the next read** the whole batch is rejected.

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

  // The drafts the drawer's three forms actually make. Written with the exact arguments the
  // components pass.
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
      // `evidence_refs` must be **event ids inside the same batch** (otherwise orphan_ref).
      // So we lay one earlier event down and point at it — on screen too, the reason form only
      // opens once the alternative the student picked is already recorded (`pendingDecision`).
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
    // The evidence_type of `external_feedback_received` is not set by the kind table but by
    // **the step's `evidence`** (design table). The host is what passes it in.
    const made = learningEventRequest(body, { ...CTX, sender: "webview-form", stepEvidenceType: "intent" });
    assert.equal(made.ok, true, `${name} 의 초안이 호스트에서 막혔다: ${JSON.stringify(made)}`);
    // The validator does not put a bad event into `missing` — it **throws**. This line was first
    // written as `checked.missing.length === 0`, but `missing` means a seq hole, so it was green
    // no matter what passed — a spot where the criterion was set without opening the thing it
    // measures (rule 1).
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

  // Negative controls — an empty evidence_refs and a missing decision are blocked **where they are made**.
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

  // When the step does not set the evidence kind, we reject instead of picking one of the six.
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

  // And then check that that negative sample really is rejected by the validator too.
  // Without this you cannot tell whether "the host blocked it" is over-strictness
  // (rule 2, the positive/negative pair).
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

// ── 7. Enforcing SX-45 rule 2 **as a rule** (the record() path) ─────────────
//
// In P1-B, `recordLearningEvent()` was split off from `record()` and the PR body said "only a form
// submit makes a learning event". **Splitting them was not what blocked it** — `record()` takes
// every kind of `/2`, and it spreads `extra` **before** the fixed fields, so when a coach stream
// callback passed `{actor:"user", student_text}`, AI-written text got saved as the student's
// learning event. "Nobody calls it that way today" is a custom, not a rule.

{
  const { NativeObservationRecorder } = await import("../src/nativeObservationRecorder.ts");
  const context = { format: "hps-observation/2", scope: "s", session: "sess", program: "p" };
  const make = () => new NativeObservationRecorder(context);

  // Negative: when the coach stream path tries to make a learning kind, it is rejected by name.
  assert.throws(
    () => make().record(TASK, "criterion_set", "코치가 대신 적는다"),
    /learning_kind_needs_form/,
    "코치 스트림이 학습 이벤트를 만들 수 있다 (SX-45 규칙 2)",
  );

  // Negative: the same when actor and student_text are carried along. This is the actual dangerous path.
  assert.throws(
    () =>
      make().record(TASK, "criterion_set", "코치가 대신 적는다", {
        actor: "user",
        student_text: "코치가 대신 적는다",
        context: CTX,
        evidence_type: "criterion",
        source_state: "self_reported",
      }),
    /learning_kind_needs_form/,
    "AI 가 쓴 글이 actor=user 학습 이벤트로 저장됐다 (루브릭 C5)",
  );

  // Two positive controls — they show that what blocks is the **learning kind**, not `record()` itself.
  const legacy = make();
  legacy.record(TASK, "coach", "코치가 한 말");
  legacy.record(TASK, "artifact", "index.html", { sha256: "a".repeat(64) });
  assert.equal(legacy.batch.events.length, 2, "기존 kind 까지 막혔다 — 너무 엄격하다");

  // Positive: the form path is still open. Evidence that the rule did not kill the feature.
  const form = make();
  const made = learningEventRequest(
    { kind: "criterion_set", student_text: "버튼을 누르면 이름이 보인다" },
    { ...CTX, sender: "webview-form" },
  );
  assert.equal(made.ok, true);
  form.recordLearningEvent(made.event);
  assert.equal(form.batch.events.length, 1, "폼 경로까지 막혔다");
  assert.equal(form.batch.events[0].actor, "user");
}

// ── 8. **Every** place that calls an observation route asks in one voice ────
//
// The server was fixed to negotiate `/v1/profile` and `/observations/context` through the same
// function, and the feature was still dead. **Because the two call sites sent different headers** —
// `fetchProfile` sent `x-hps-observation-format: /2`, `prepareObservation` sent only
// `authorization`. The server honestly handed `/2` to one side and `/1` to the other, the recorder
// got built as `/1`, and the drawer never drew to the end. The 9 worker checks were green that
// whole time — because those checks measured by **sending the same header to both sides**.
//
// So this assertion looks at **the source, statically**. A runtime check cannot catch "a call site
// did not use the helper" (not unless that call site runs). The limitation is written down as is.

{
  const { readFileSync, readdirSync } = await import("node:fs");
  const srcDir = new URL("../src/", import.meta.url);
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

  // The routes the observation contract hangs on. Calling one of these while hand-building the
  // headers is a failure.
  const ROUTES = ["/observations/", "/profile'", '/profile"', "/activity'", '/activity"'];
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, srcDir), "utf8");
    // Sweep from `fetch(` to somewhere near the closing `)` as one chunk. Not an exact parser —
    // the point is **whether there is a header literal inside the call expression**.
    for (const m of text.matchAll(/fetch\(([\s\S]{0,400}?)\}\s*\)/g)) {
      const call = m[1];
      if (!ROUTES.some((r) => call.includes(r))) continue;
      if (call.includes("observationHeaders")) continue;
      // Hand-writing `authorization` marks a spot where the format header can be dropped.
      if (/authorization/i.test(call)) offenders.push(`${file}: ${call.slice(0, 90).replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "관측 라우트를 부르면서 헤더를 직접 만드는 자리가 있다 — observationHeaders() 를 쓰지 않으면 포맷 선언이 조용히 빠진다:\n" +
      offenders.join("\n"),
  );

  // Positive control — does that helper actually carry the format. Obeying a rule that is not there
  // is no use.
  const { observationHeaders } = await import("../src/proxyClientHelpers.ts");
  const h = observationHeaders("t0ken");
  assert.equal(h["x-hps-observation-format"], "hps-observation/2", "헬퍼가 포맷을 싣지 않는다");
  assert.equal(h.authorization, "Bearer t0ken");

  // Negative control — does the check really count. Verified with a planted string of a hand-built call.
  const planted = `fetch(url + '/observations/context', {headers:{authorization:'Bearer '+token}})`;
  const hits = [...planted.matchAll(/fetch\(([\s\S]{0,400}?)\}\s*\)/g)]
    .filter((m) => m[1].includes("/observations/") && !m[1].includes("observationHeaders") && /authorization/i.test(m[1]));
  assert.equal(hits.length, 1, "정적 검사가 손으로 만든 헤더를 못 센다 — 규칙이 공전한다");
}

console.log("sx-evidence-gate: OK");
