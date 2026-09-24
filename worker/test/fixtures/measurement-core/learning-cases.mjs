// SX-44~48 — `hps-observation/2` fixtures (P1-A).
//
// These are NOT pinned to a golden file and never will be: `legacy-verdicts.json`
// next to this file was captured from the pre-extraction implementation, which
// knows nothing about /2. Nothing here touches that file, and every /1 case still
// lives in `legacy-cases.mjs` and still reproduces byte-for-byte.
//
// Field names, enums and the per-kind required fields come from
// docs/design/studio-learning-experience.md "관측 이벤트와 필드". The four invalid
// cases the design names by hand (AI text as student, orphan ref, stale artifact,
// missing source_state) are exported individually so the control can assert the
// exact refusal code for each.

export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const SHA_C = "c".repeat(64);

export const CONTEXT = { week: 3, step_id: "step-2", task: "task-1", module_version: "2026.09.20-1" };
export const PROVENANCE = { who: "3학년 김OO", when: "2026-09-19", where: "점심시간 교실 인터뷰" };

/** One event. `text` carries what the host would show; `student_text` is the student's own field. */
export const ev = (id, seq, kind, extra = {}) => ({
  id, seq, task: "task-1", at: seq, kind, text: "", assistance: "unknown", ...extra,
});

export const v2 = (events, extra = {}) => ({
  format: "hps-observation/2", scope: "synthetic-seat", session: "s1", program: "m2026.09.08-1", events, ...extra,
});
export const v1 = (events, extra = {}) => ({
  format: "hps-observation/1", scope: "synthetic-seat", session: "s1", program: "m2026.09.08-1", events, ...extra,
});

const learn = (id, seq, kind, evidence_type, extra = {}) =>
  ev(id, seq, kind, { actor: "user", context: CONTEXT, evidence_type, source_state: "self_reported", ...extra });

const said = (text) => ({ text, student_text: text });

/** 1 → 12: every one of the eight learning kinds, in the order the state machine walks them. */
export const learningChain = () => [
  ev("u1", 1, "user", { text: "새 친구가 급식 메뉴를 못 찾는 문제를 풀고 싶어" }),
  ev("c1", 2, "coach", { text: "기대 조건을 '3초 안에 오늘 메뉴가 보인다' 로 잡아 볼까요" }),
  learn("pc1", 3, "problem_committed", "intent", said("전학 온 친구가 오늘 급식을 못 찾는다")),
  learn("cs1", 4, "criterion_set", "criterion", said("첫 화면에서 오늘 메뉴가 3초 안에 보인다")),
  ev("f1", 5, "artifact", { sha256: SHA_A, text: "menu.html" }),
  learn("to1", 6, "test_observed", "action", { criterion_ref: "cs1", artifact_after: SHA_A, outcome: "mismatch" }),
  learn("cr1", 7, "change_requested", "change", {
    ...said("메뉴를 맨 위로 올려 주세요"), criterion_ref: "cs1", artifact_before: SHA_A, turn_ref: "u1",
  }),
  ev("f2", 8, "artifact", { sha256: SHA_B, text: "menu.html" }),
  learn("rc1", 9, "retest_confirmed", "action", { criterion_ref: "cs1", artifact_after: SHA_B, outcome: "match" }),
  ev("ef1", 10, "external_feedback_received", {
    actor: "external_user", context: CONTEXT, evidence_type: "action", source_state: "real",
    provenance: PROVENANCE, text: "메뉴는 보이는데 글씨가 작아요", student_text: "메뉴는 보이는데 글씨가 작아요",
  }),
  learn("dr1", 11, "decision_revised", "decision", {
    ...said("글씨 크기를 먼저 고치기로 바꿨다"), decision: { from: "색을 바꾼다", to: "글씨를 키운다" }, evidence_refs: ["ef1"],
  }),
  learn("rf1", 12, "reflection_submitted", "ownership", {
    ...said("기대 조건을 먼저 적으니 무엇을 고칠지 분명해졌다"), next_experiment: "다음엔 친구 두 명에게 먼저 보여 준다",
  }),
];

/** DAG P1-A positive: a criterion_set by the student with source_state=self_reported. */
export const criterionByStudent = () => v2([
  ev("u1", 1, "user", { text: "급식 메뉴 화면을 만들고 싶어" }),
  learn("cs1", 2, "criterion_set", "criterion", said("첫 화면에서 오늘 메뉴가 3초 안에 보인다")),
]);

export const validCases = {
  /** All eight learning kinds in one batch. */
  all_eight_kinds: () => v2(learningChain()),
  criterion_by_student: criterionByStudent,
  /** /2 is a superset: a batch with only legacy kinds is still valid under it. */
  legacy_events_inside_v2: () => v2([
    ev("u1", 1, "user", { text: "새 직원이 주문을 확인할 문서가 필요해" }),
    ev("t1", 2, "tool_request", { tool_id: "tool-1", text: "Write(order.md)" }),
    ev("a1", 3, "approval", { tool_id: "tool-1", actor: "policy", outcome: "allowed", text: "정책 허용" }),
    ev("r1", 4, "tool_result", { tool_id: "tool-1", outcome: "success", text: "Write(order.md)" }),
    ev("f1", 5, "artifact", { sha256: SHA_A, text: "order.md" }),
  ]),
  /** A coach-proposed criterion the student accepted keeps the student's own submitted string. */
  adopted_criterion: () => v2([
    ev("u1", 1, "user", { text: "기대 조건을 어떻게 적지" }),
    ev("c1", 2, "coach", { text: "'3초 안에 오늘 메뉴가 보인다' 는 어떨까요" }),
    learn("cs1", 3, "criterion_set", "criterion", { ...said("3초 안에 오늘 메뉴가 보인다"), adopted_from: "c1" }),
  ]),
  /** No source_state: the kind default applies, nothing is promoted. */
  criterion_without_source_state: () => v2([
    ev("u1", 1, "user", { text: "메뉴 화면" }),
    ev("cs1", 2, "criterion_set", { actor: "user", context: CONTEXT, evidence_type: "criterion", ...said("3초 안에 보인다") }),
  ]),
  /** A learning event the coach authored: recordable, but it is not the student's. */
  ai_authored_decision: () => v2([
    ev("u1", 1, "user", { text: "둘 중 뭐가 나아?" }),
    ev("dr1", 2, "decision_revised", {
      actor: "ai", context: CONTEXT, evidence_type: "decision", source_state: "self_reported",
      text: "코치가 B 안을 자동으로 골랐다", decision: { from: "A 안", to: "B 안" }, evidence_refs: ["u1"],
    }),
  ]),
};

/** Each case is [batch, expected refusal code]. */
export const invalidCases = {
  // The four the design names.
  ai_text_as_student: [
    () => v2([
      ev("u1", 1, "user", { text: "메뉴 화면" }),
      ev("cs1", 2, "criterion_set", {
        actor: "ai", context: CONTEXT, evidence_type: "criterion", source_state: "self_reported",
        ...said("3초 안에 오늘 메뉴가 보인다"),
      }),
    ]),
    "ai_text_as_student",
  ],
  orphan_ref: [
    () => v2([
      ev("u1", 1, "user", { text: "메뉴 화면" }),
      ev("f1", 2, "artifact", { sha256: SHA_A, text: "menu.html" }),
      learn("to1", 3, "test_observed", "action", { criterion_ref: "cs-missing", artifact_after: SHA_A, outcome: "match" }),
    ]),
    "orphan_ref",
  ],
  missing_source_state: [
    () => v2([
      ev("u1", 1, "user", { text: "친구에게 보여 줬어" }),
      ev("ef1", 2, "external_feedback_received", {
        actor: "external_user", context: CONTEXT, evidence_type: "action", provenance: PROVENANCE,
        ...said("글씨가 작아요"),
      }),
    ]),
    "missing_source_state",
  ],
  // Everything else the control pins.
  unknown_kind: [
    () => v2([ev("m1", 1, "mastery_demonstrated", { actor: "user", context: CONTEXT, evidence_type: "action" })]),
    "invalid_kind",
  ],
  score_key_anywhere: [
    () => v2([
      ev("u1", 1, "user", { text: "메뉴 화면" }),
      ev("cs1", 2, "criterion_set", {
        actor: "user", context: CONTEXT, evidence_type: "criterion", source_state: "self_reported",
        ...said("3초 안에 보인다"), level: 3,
      }),
    ]),
    "unsupported_score",
  ],
  unknown_artifact: [
    () => v2([
      ev("u1", 1, "user", { text: "메뉴 화면" }),
      learn("cs1", 2, "criterion_set", "criterion", said("3초 안에 보인다")),
      learn("to1", 3, "test_observed", "action", { criterion_ref: "cs1", artifact_after: SHA_B, outcome: "match" }),
    ]),
    "unknown_artifact",
  ],
  real_without_provenance: [
    () => v2([
      ev("u1", 1, "user", { text: "친구에게 보여 줬어" }),
      ev("ef1", 2, "external_feedback_received", {
        actor: "external_user", context: CONTEXT, evidence_type: "action", source_state: "real", ...said("글씨가 작아요"),
      }),
    ]),
    "missing_provenance",
  ],
  invalid_actor: [
    () => v2([ev("cs1", 1, "criterion_set", { actor: "robot", context: CONTEXT, evidence_type: "criterion" })]),
    "invalid_actor",
  ],
  missing_required_field: [
    // criterion_set without `context`.
    () => v2([ev("cs1", 1, "criterion_set", { actor: "user", evidence_type: "criterion", ...said("3초 안에 보인다") })]),
    "invalid_learning_event",
  ],
  // A /2 event sent as /1 is refused on the first thing that is wrong with it, and
  // in /1 an unknown key is refused before the kind is even looked at. Measured,
  // not assumed: the first spelling of this case expected `invalid_kind` and the
  // validator was right to say `invalid_event`.
  learning_kind_with_v2_fields_in_v1: [
    () => v1([ev("cs1", 1, "criterion_set", { actor: "user", context: CONTEXT, evidence_type: "criterion" })]),
    "invalid_event",
  ],
  /** …and with /1 keys only, the learning kind itself is what /1 refuses. */
  learning_kind_in_v1: [() => v1([ev("cs1", 1, "criterion_set", { actor: "user" })]), "invalid_kind"],
  v2_field_in_v1: [
    () => v1([ev("u1", 1, "user", { text: "안녕", student_text: "안녕" })]),
    "invalid_event",
  ],
};

// ── Gate fixtures: these batches are VALID; the refusal happens at the gate ───
//
// SX-15 (2) — `retest_confirmed.artifact_after` must equal the latest artifact
// recorded AFTER the change. A retest that names the pre-change revision is a
// well-formed event about a stale artifact, so the validator accepts it and
// `gates()` is what refuses it. Keeping that split is the point: the validator
// judges one batch's shape, the gate judges the task's history.
export const gateCases = {
  /** AI draft, no criterion: the completion gate is closed. */
  draft_without_criterion: () => v2([
    ev("u1", 1, "user", { text: "급식 메뉴 화면 만들어 줘" }),
    ev("f1", 2, "artifact", { sha256: SHA_A, text: "menu.html" }),
  ]),
  /** …and the same history with the student's criterion written after the draft. */
  draft_then_criterion: () => v2([
    ev("u1", 1, "user", { text: "급식 메뉴 화면 만들어 줘" }),
    ev("f1", 2, "artifact", { sha256: SHA_A, text: "menu.html" }),
    learn("cs1", 3, "criterion_set", "criterion", said("첫 화면에서 오늘 메뉴가 3초 안에 보인다")),
  ]),
  /** Tested before any criterion existed: the gate stays closed. */
  test_before_criterion: () => v2([
    ev("u1", 1, "user", { text: "급식 메뉴 화면 만들어 줘" }),
    ev("f1", 2, "artifact", { sha256: SHA_A, text: "menu.html" }),
    ev("to1", 3, "test_observed", { actor: "user", context: CONTEXT, evidence_type: "action", source_state: "self_reported", artifact_after: SHA_A, outcome: "match", criterion_ref: "cs1" }),
    learn("cs1", 4, "criterion_set", "criterion", said("첫 화면에서 오늘 메뉴가 3초 안에 보인다")),
  ]),
  /** change_requested with no retest at all. */
  change_without_retest: () => v2([
    ev("u1", 1, "user", { text: "메뉴 화면" }),
    learn("cs1", 2, "criterion_set", "criterion", said("3초 안에 보인다")),
    ev("f1", 3, "artifact", { sha256: SHA_A, text: "menu.html" }),
    learn("cr1", 4, "change_requested", "change", {
      ...said("메뉴를 맨 위로"), criterion_ref: "cs1", artifact_before: SHA_A, turn_ref: "u1",
    }),
    ev("f2", 5, "artifact", { sha256: SHA_B, text: "menu.html" }),
  ]),
  /** A retest, but against a different criterion. */
  retest_other_criterion: () => v2([
    ...gateCases.change_without_retest().events,
    learn("cs2", 6, "criterion_set", "criterion", said("색이 예쁘다")),
    learn("rc1", 7, "retest_confirmed", "action", { criterion_ref: "cs2", artifact_after: SHA_B, outcome: "match" }),
  ]),
  /** A retest against the same criterion, bound to the artifact after the change. */
  retest_same_criterion: () => v2([
    ...gateCases.change_without_retest().events,
    learn("rc1", 6, "retest_confirmed", "action", { criterion_ref: "cs1", artifact_after: SHA_B, outcome: "match" }),
  ]),
  /** The named "stale artifact" case: the retest names the pre-change revision. */
  stale_artifact: () => v2([
    ...gateCases.change_without_retest().events,
    learn("rc1", 6, "retest_confirmed", "action", { criterion_ref: "cs1", artifact_after: SHA_A, outcome: "match" }),
  ]),
  /** Same criterion, same artifact, plus an executed check bound to that revision. */
  retest_with_executed_result: () => v2([
    ...gateCases.change_without_retest().events,
    ev("t1", 6, "tool_request", { tool_id: "check-1", text: "Bash(npm test)", sha256: SHA_B }),
    ev("r1", 7, "tool_result", { tool_id: "check-1", outcome: "success", text: "all checks passed", sha256: SHA_B }),
    learn("rc1", 8, "retest_confirmed", "action", { criterion_ref: "cs1", artifact_after: SHA_B, outcome: "match", result_ref: "r1" }),
  ]),
  /**
   * P1-C / AE-37 — the criterion changes **after** the confirmation is done.
   * The confirmation really happened, so it is not erased; only the state moves
   * to "재확인 필요".
   */
  criterion_changed_after_confirm: () => v2([
    ...gateCases.retest_same_criterion().events,
    learn("cs2", 7, "criterion_set", "criterion", said("글씨가 작아도 3초 안에 읽힌다")),
  ]),
  /**
   * P1-C / AE-37 — the artifact changes again **after** the confirmation is done.
   * The confirmation was bound to the revision as of that moment, so it cannot
   * cover the current revision.
   */
  artifact_changed_after_confirm: () => v2([
    ...gateCases.retest_same_criterion().events,
    ev("f3", 7, "artifact", { sha256: SHA_C, text: "menu.html" }),
  ]),
  /**
   * P1-C / SX-15 negative — opening the preview and running tools is not a
   * re-confirmation by itself. With no `retest_confirmed`, however many times it
   * is clicked, it is "수정 후 미확인".
   */
  clicks_without_retest: () => v2([
    ...gateCases.change_without_retest().events,
    ev("t1", 6, "tool_request", { tool_id: "check-1", text: "Bash(open preview)", sha256: SHA_B }),
    ev("r1", 7, "tool_result", { tool_id: "check-1", outcome: "success", text: "opened", sha256: SHA_B }),
    ev("t2", 8, "tool_request", { tool_id: "check-2", text: "Bash(open preview)", sha256: SHA_B }),
    ev("r2", 9, "tool_result", { tool_id: "check-2", outcome: "success", text: "opened", sha256: SHA_B }),
  ]),
  /**
   * P1-C / SX-15 negative — **the coach** proposes a criterion after the
   * confirmation. The student did not change their mind, so no re-confirmation is
   * demanded. Without looking at `actor`, every single remark the coach makes
   * invalidates the student's confirmation.
   */
  coach_criterion_after_confirm: () => v2([
    ...gateCases.retest_same_criterion().events,
    ev("cs_ai", 7, "criterion_set", {
      actor: "ai", context: CONTEXT, evidence_type: "criterion", source_state: "self_reported",
      text: "글씨가 작아도 3초 안에 읽히면 어떨까요",
    }),
  ]),
  /**
   * P1-C / SX-16 — **changed twice.** Each change must yield one pair.
   * Lumping them into the last one makes the first judgement something that
   * never happened.
   */
  two_changes: () => v2([
    ev("u1", 1, "user", { text: "급식 메뉴 화면 만들어 줘" }),
    learn("cs1", 2, "criterion_set", "criterion", said("첫 화면에서 오늘 메뉴가 3초 안에 보인다")),
    ev("f1", 3, "artifact", { sha256: SHA_A, text: "menu.html v1" }),
    learn("cr1", 4, "change_requested", "change", {
      ...said("메뉴를 맨 위로 올려 주세요"), criterion_ref: "cs1", artifact_before: SHA_A, turn_ref: "u1",
    }),
    ev("f2", 5, "artifact", { sha256: SHA_B, text: "menu.html v2" }),
    learn("rc1", 6, "retest_confirmed", "action", { criterion_ref: "cs1", artifact_after: SHA_B, outcome: "match" }),
    learn("cr2", 7, "change_requested", "change", {
      ...said("글씨도 키워 주세요"), criterion_ref: "cs1", artifact_before: SHA_B, turn_ref: "u1",
    }),
    ev("f3", 8, "artifact", { sha256: SHA_C, text: "menu.html v3" }),
    learn("rc2", 9, "retest_confirmed", "action", { criterion_ref: "cs1", artifact_after: SHA_C, outcome: "match" }),
  ]),
  /**
   * P1-C / SX-16 — asks for a change and then **asks for another change without
   * confirming.** The first change has no confirmation to pair with. Pulling the
   * second confirmation over onto the first change would paint a revision the
   * student never even looked at as "confirmed".
   */
  change_then_change: () => v2([
    ev("u1", 1, "user", { text: "급식 메뉴 화면 만들어 줘" }),
    learn("cs1", 2, "criterion_set", "criterion", said("첫 화면에서 오늘 메뉴가 3초 안에 보인다")),
    ev("f1", 3, "artifact", { sha256: SHA_A, text: "menu.html v1" }),
    learn("cr1", 4, "change_requested", "change", {
      ...said("메뉴를 맨 위로"), criterion_ref: "cs1", artifact_before: SHA_A, turn_ref: "u1",
    }),
    ev("f2", 5, "artifact", { sha256: SHA_B, text: "menu.html v2" }),
    learn("cr2", 6, "change_requested", "change", {
      ...said("글씨도 키워 주세요"), criterion_ref: "cs1", artifact_before: SHA_B, turn_ref: "u1",
    }),
    ev("f3", 7, "artifact", { sha256: SHA_C, text: "menu.html v3" }),
    learn("rc2", 8, "retest_confirmed", "action", { criterion_ref: "cs1", artifact_after: SHA_C, outcome: "match" }),
  ]),
  /**
   * P1-C / SX-16 negative — there is only the student's revision and **no AI
   * draft.** Do not build an empty comparison; leave it as "AI 초안 없음".
   */
  after_without_before: () => v2([
    ev("u1", 1, "user", { text: "내가 직접 만들어 볼게" }),
    learn("cs1", 2, "criterion_set", "criterion", said("버튼을 누르면 이름이 보인다")),
    ev("f1", 3, "artifact", { sha256: SHA_B, text: "menu.html" }),
    learn("rc1", 4, "retest_confirmed", "action", { criterion_ref: "cs1", artifact_after: SHA_B, outcome: "match" }),
  ]),
};
