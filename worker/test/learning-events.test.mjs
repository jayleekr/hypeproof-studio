// P1-A control — `hps-observation/2` and the task-flow gates (SX-14, SX-15, SX-43~48, SX-55).
//
// Contract: docs/requirements/studio-learning-experience.md §H and
// docs/design/studio-learning-experience.md "관측 이벤트와 필드" · "과제 흐름 상태 기계".
//
// Written and run RED before the implementation (verification.md rule 2: the
// control comes first). Every negative names the exact refusal code, so a
// validator that refuses everything fails here just as loudly as one that
// refuses nothing: each negative is paired with the positive it differs from.
//
// Synthetic fixtures only. Nothing here is evidence that a student, a webview or
// an installed App ever produced one of these events — the UI rows (SX-T01..T58)
// are NOT RUN by this file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const core = await import("../src/lib/measurement-core/index.ts");
const learningDesign = await import("../src/lib/learning-design.ts");
const { runLegacyCases, batchCases } = await import("./fixtures/measurement-core/legacy-cases.mjs");
const golden = JSON.parse(readFileSync(new URL("./fixtures/measurement-core/legacy-verdicts.json", import.meta.url), "utf8"));
const F = await import("./fixtures/measurement-core/learning-cases.mjs");

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof Error && e.message === code, `expected ${code}`);
const accept = (make) => core.validateObservation(make()).batch;

// ── /1 stays exactly as it was ────────────────────────────────────────────────
test("P1-A /1 verdicts are unchanged — the golden file is the judge, not this file", () => {
  const { captured_from: _source, ...expected } = golden;
  assert.deepEqual(runLegacyCases(core), expected, "a /1 verdict moved; resolve it, never regenerate the golden");
  // A /1 batch is accepted as /1 and is NOT silently upgraded.
  const one = core.validateObservation(batchCases.normal_chain()).batch;
  assert.equal(one.format, "hps-observation/1");
  assert.equal(core.describeLegacySource(one)[0].source_namespace, "studio/hps-observation/1");
});

test("P1-A a /2 batch is not downgraded, and /2 carries its own source namespace", () => {
  const two = accept(F.validCases.all_eight_kinds);
  assert.equal(two.format, "hps-observation/2");
  assert.equal(core.describeLegacySource(two)[0].source_namespace, "studio/hps-observation/2");
  // Unknown formats stay refused.
  throwsCode(() => core.validateObservation({ ...batchCases.normal_chain(), format: "hps-observation/3" }), "unsupported_observation");
  throwsCode(() => core.validateObservation(batchCases.unsupported_old_format()), "unsupported_observation");
});

// ── POSITIVE ──────────────────────────────────────────────────────────────────
test("P1-A a criterion_set by the student with source_state=self_reported is accepted", () => {
  const batch = accept(F.criterionByStudent);
  const criterion = batch.events.find((e) => e.kind === "criterion_set");
  assert.equal(criterion.actor, "user");
  assert.equal(criterion.source_state, "self_reported");
  assert.equal(criterion.student_text, "첫 화면에서 오늘 메뉴가 3초 안에 보인다");
});

test("P1-A all eight learning kinds validate, and /2 is a superset of /1", () => {
  const batch = accept(F.validCases.all_eight_kinds);
  const kinds = batch.events.map((e) => e.kind);
  for (const kind of core.LEARNING_EVENT_KINDS) assert.ok(kinds.includes(kind), `${kind} missing from the chain`);
  assert.deepEqual([...core.LEARNING_EVENT_KINDS], [
    "problem_committed", "criterion_set", "test_observed", "change_requested",
    "retest_confirmed", "external_feedback_received", "decision_revised", "reflection_submitted",
  ]);
  // The legacy kinds still validate inside a /2 batch, unchanged.
  assert.equal(accept(F.validCases.legacy_events_inside_v2).events.length, 5);
  // Enums are copied from the design table, not invented here.
  assert.deepEqual([...core.EVIDENCE_TYPES], ["intent", "criterion", "action", "decision", "change", "ownership"]);
  assert.deepEqual([...core.SOURCE_KINDS], ["link", "article", "policy", "interview", "test", "none"]);
  assert.deepEqual([...core.SOURCE_STATES], ["real", "simulated", "self_reported", "unverified"]);
  assert.deepEqual([...core.OBSERVATION_ACTORS], ["user", "ai", "teacher", "external_user", "policy"]);
});

test("P1-A the kind list has exactly one home: the session-design schema reads the core's", () => {
  assert.deepEqual([...learningDesign.LEARNING_EVENT_KINDS], [...core.LEARNING_EVENT_KINDS]);
  assert.deepEqual([...learningDesign.EVIDENCE_TYPES], [...core.EVIDENCE_TYPES]);
  assert.deepEqual([...learningDesign.SOURCE_KINDS], [...core.SOURCE_KINDS]);
});

// ── NEGATIVE — each with its named code ───────────────────────────────────────
test("P1-A every named refusal fires on its own case", () => {
  for (const [name, [make, code]] of Object.entries(F.invalidCases)) {
    assert.throws(() => core.validateObservation(make()), (e) => e instanceof Error && e.message === code, `${name}: expected ${code}, got something else`);
  }
});

test("P1-A AI text is never recorded as the student's (SX-45)", () => {
  // Positive control on the same shape: the only difference is who acted.
  assert.equal(accept(F.criterionByStudent).events[1].actor, "user");
  throwsCode(() => core.validateObservation(F.invalidCases.ai_text_as_student[0]()), "ai_text_as_student");
  // A coach-authored learning event is recordable — it just is not the student's text.
  const aiDecision = accept(F.validCases.ai_authored_decision).events[1];
  assert.equal(aiDecision.actor, "ai");
  assert.equal(aiDecision.student_text, undefined);
  assert.equal(core.isStudentAuthored(aiDecision), false);
});

test("P1-A a coach-proposed criterion the student adopted keeps the marker", () => {
  const batch = accept(F.validCases.adopted_criterion);
  const criterion = batch.events.find((e) => e.kind === "criterion_set");
  assert.equal(criterion.adopted_from, "c1");
  assert.equal(criterion.student_text, "3초 안에 오늘 메뉴가 보인다", "the student's submitted string, not the coach's event");
  assert.equal(core.isAdoptedFromCoach(criterion), true);
  assert.equal(core.isStudentAuthored(criterion), true);
  // adopted_from is a ref like any other.
  const events = F.validCases.adopted_criterion().events.map((e) => (e.id === "cs1" ? { ...e, adopted_from: "nope" } : e));
  throwsCode(() => core.validateObservation(F.v2(events)), "orphan_ref");
});

test("P1-A interpretation sees the adopted marker instead of guessing who wrote it", () => {
  const batch = accept(F.validCases.adopted_criterion);
  const doc = (evidence) => ({
    format: "hps-interpretation/1", id: "i1", revision: 1, supersedes: null,
    batch: { format: batch.format, scope: batch.scope, session: batch.session, program: batch.program },
    versions: {
      bundle_format: batch.format,
      capability_model: { id: core.DEFAULT_CAPABILITY_MODEL.id, revision: core.DEFAULT_CAPABILITY_MODEL.revision },
      definition_revision: core.DEFAULT_CAPABILITY_MODEL.definition_revision,
      rubric: "unknown", evaluator: "unknown", analysis_ai_model: "unknown", work_ai_models: "unknown",
    },
    findings: [{ capability: "JUDGMENT", status: "observed", claim: "기대 조건을 정했다", evidence, assistance: "unknown", review: "unreviewed" }],
    unclassified: [],
  });
  const checked = core.validateInterpretation(doc([{ event_id: "cs1", quote: "3초 안에" }]), batch);
  assert.equal(checked.findings[0].status, "observed", "the student did submit the string — this is a judgment, not a refusal");
  assert.deepEqual(core.adoptedEvidence(batch, checked.findings[0]), ["cs1"], "the reviewer is told the criterion came from the coach");
  // Control: a criterion the student wrote unaided is not flagged.
  const own = accept(F.criterionByStudent);
  assert.deepEqual(core.adoptedEvidence(own, { evidence: [{ event_id: "cs1", quote: "3초" }] }), []);
});

// ── DEFAULTS ──────────────────────────────────────────────────────────────────
test("P1-A a missing source_state resolves to its kind default and is never promoted to real", () => {
  const criterion = accept(F.validCases.criterion_without_source_state).events[1];
  assert.equal(criterion.source_state, undefined, "the validator records what was sent; it does not write a value in");
  assert.equal(core.sourceStateOf(criterion), "self_reported", "kind default from the design table");
  // A legacy event carries no source_state at all: unknown source, not a real one.
  assert.equal(core.sourceStateOf(accept(F.validCases.legacy_events_inside_v2).events[0]), "unverified");
  assert.equal(core.defaultSourceState("external_feedback_received"), null, "no default: the student picks it");
  // Nothing is promoted to real without provenance (SX-46).
  throwsCode(() => core.validateObservation(F.invalidCases.real_without_provenance[0]()), "missing_provenance");
  assert.equal(accept(F.validCases.all_eight_kinds).events.find((e) => e.kind === "external_feedback_received").source_state, "real");
});

// ── GATES (SX-14, SX-15) ──────────────────────────────────────────────────────
const gate = (name, completion) => core.gates({ events: accept(F.gateCases[name]).events, task: "task-1", ...(completion ? { completion } : {}) });

test("SX-14 an AI draft without a criterion closes the completion gate; writing one opens it", () => {
  const closed = gate("draft_without_criterion");
  assert.equal(closed.complete.ok, false);
  assert.deepEqual(closed.complete.missing.map((m) => m.code), ["criterion_after_artifact"]);
  const open = gate("draft_then_criterion");
  assert.equal(open.complete.ok, true, "control: the same history plus the student's criterion");
  assert.deepEqual(open.complete.missing, []);
  // Tested before any criterion existed: still closed.
  assert.equal(gate("test_before_criterion").complete.ok, false);
});

test("SX-14 the session design's completion items must each exist as the student's own event", () => {
  const completion = [{ id: "c-criterion", event: "criterion_set" }, { id: "c-reflection", event: "reflection_submitted" }];
  const partial = gate("draft_then_criterion", completion);
  assert.equal(partial.complete.ok, false);
  assert.deepEqual(partial.complete.missing.map((m) => [m.code, m.item]), [["missing_completion_event", "c-reflection"]]);
  const full = core.gates({ events: accept(F.validCases.all_eight_kinds).events, task: "task-1", completion });
  assert.equal(full.complete.ok, true);
});

test("SX-15 a change without a retest is not verified; only the same criterion counts", () => {
  const none = gate("change_without_retest");
  assert.equal(none.verification.state, "unconfirmed");
  assert.deepEqual(none.verification.missing.map((m) => m.code), ["missing_retest"]);
  const other = gate("retest_other_criterion");
  assert.equal(other.verification.state, "unconfirmed", "a retest against a DIFFERENT criterion does not count");
  assert.deepEqual(other.verification.missing.map((m) => m.code), ["criterion_mismatch"]);
  const same = gate("retest_same_criterion");
  assert.equal(same.verification.state, "confirmed");
  assert.deepEqual(same.verification.missing, []);
  assert.equal(same.verification.source_state, "self_reported", "no executed result is bound: the student says so");
});

test("SX-15 a retest bound to the pre-change revision is stale; an executed check makes it real", () => {
  const stale = gate("stale_artifact");
  assert.equal(stale.verification.state, "unconfirmed");
  assert.deepEqual(stale.verification.missing.map((m) => m.code), ["stale_artifact"]);
  const executed = gate("retest_with_executed_result");
  assert.equal(executed.verification.state, "confirmed");
  assert.equal(executed.verification.source_state, "real");
});

test("SX-15 with no change_requested there is nothing to re-verify", () => {
  assert.equal(gate("draft_then_criterion").verification.state, "none");
});

test("SX-45 human evidence reads actor, and the /1 rule it widened is no longer identical", () => {
  // 심은 결함 #15(평가자) — `isHumanEvidence` 의 actor 가드를 지워도 스위트 전체가
  // 초록이었다. 그 가드는 "AI 가 쓴 글은 학생 행동이 아니다" 의 마지막 방어선이고
  // 검사가 없었다. 동시에 이 함수는 `/1` 의 규칙을 **넓힌** 것이라, `/1` 이 허용하던
  // 이벤트가 이제 human 이 아니게 되는 자리가 있다. 그 사실도 여기 못 박는다.
  assert.equal(core.isHumanEvidence({ kind: "user" }), true, "학생 발화가 human 이 아니다");
  assert.equal(core.isHumanEvidence({ kind: "correction" }), true, "정정이 human 이 아니다");
  assert.equal(core.isHumanEvidence({ kind: "coach" }), false, "코치 발화가 human 으로 셌다");

  // actor 가드 — 이 두 줄이 없으면 위 세 줄은 전부 통과하면서 가드는 죽어 있다.
  assert.equal(core.isHumanEvidence({ kind: "user", actor: "ai" }), false, "AI 가 쓴 user 이벤트가 human 으로 셌다");
  assert.equal(core.isHumanEvidence({ kind: "user", actor: "policy" }), false, "정책이 만든 이벤트가 human 으로 셌다");
  assert.equal(core.isHumanEvidence({ kind: "user", actor: "user" }), true, "학생이 낸 것이 막혔다");

  // 학습 kind 는 actor=user 일 때만 human 이다.
  assert.equal(core.isHumanEvidence({ kind: "criterion_set", actor: "user" }), true);
  assert.equal(core.isHumanEvidence({ kind: "criterion_set", actor: "ai" }), false);
});

test("SX-15/AE-37 a confirmation stops covering the work once the criterion or the revision moves", () => {
  // 확인 자체는 진짜로 있었던 일이다. 그래서 **지우지 않고** 보존한 채 상태만 내린다
  // ("이전 증거는 보존한다"). 지우면 학생이 한 확인이 없었던 일이 된다.
  const moved = gate("criterion_changed_after_confirm");
  assert.equal(moved.verification.state, "needs_recheck", "기대 조건이 바뀌었는데 확인이 그대로 유효하다");
  assert.deepEqual(moved.verification.missing.map((m) => m.code), ["criterion_moved"]);
  assert.equal(moved.verification.previous?.event_id, "rc1", "이전 확인이 보존되지 않았다");
  assert.equal(moved.verification.previous?.criterion_ref, "cs1");

  const rebuilt = gate("artifact_changed_after_confirm");
  assert.equal(rebuilt.verification.state, "needs_recheck", "산출물이 또 바뀌었는데 확인이 그대로 유효하다");
  assert.deepEqual(rebuilt.verification.missing.map((m) => m.code), ["artifact_moved"]);
  assert.equal(rebuilt.verification.previous?.event_id, "rc1");

  // 코치가 기대 조건을 **제안**한 것은 학생이 생각을 바꾼 것이 아니다.
  // actor 를 안 보면 코치가 말할 때마다 학생의 확인이 무효가 된다.
  const suggested = gate("coach_criterion_after_confirm");
  assert.equal(suggested.verification.state, "confirmed", "코치의 제안 한 줄이 학생의 확인을 무효로 만들었다");

  // 양성 대조군 — 아무것도 움직이지 않았으면 확인은 확인으로 남는다.
  const still = gate("retest_same_criterion");
  assert.equal(still.verification.state, "confirmed", "움직인 것이 없는데 재확인을 요구한다 — 너무 엄격하다");
  assert.equal(still.verification.previous, undefined, "확인 상태에서는 previous 가 필요 없다");
});

test("SX-15 부정 — 프리뷰 열람과 도구 실행 횟수는 재확인이 아니다", () => {
  const clicks = gate("clicks_without_retest");
  assert.equal(clicks.verification.state, "unconfirmed", "버튼을 누른 것만으로 검증이 기록됐다");
  assert.deepEqual(clicks.verification.missing.map((m) => m.code), ["missing_retest"]);
  // 대조군: 같은 도구 이벤트에 retest_confirmed 하나만 더하면 통과한다 —
  // 막고 있는 것이 "도구 이벤트" 가 아니라 "재확인 선언의 부재" 임을 보인다.
  assert.equal(gate("retest_with_executed_result").verification.state, "confirmed");
});

test("SX-14/15 the gate result is computed every time and never stored", () => {
  const events = accept(F.gateCases.retest_same_criterion).events;
  const snapshot = structuredClone(events);
  const first = core.gates({ events, task: "task-1" });
  assert.deepEqual(core.gates({ events, task: "task-1" }), first, "same events, same verdict");
  assert.deepEqual(events, snapshot, "gates() does not write into the events");
  const task = core.updateCurriculum(core.createTask({ id: "t1", project: "p", at: 1 }), {
    module: { course_id: "globalbuddy", version: "2026.09.20-1", sha256: F.SHA_A }, week: 3, phase: "working", current_step: "s1",
  }, { by: "user", at: 2 });
  assert.equal(JSON.stringify(task).includes("gates"), false, "no gate verdict is stored on the Task");
});

// ── The step move (SX-16, SX-55) ──────────────────────────────────────────────
test("SX-55 nextStep honours a step gate and always allows going back", () => {
  const steps = [{ id: "s1" }, { id: "s2", gate: "criterion_set" }, { id: "s3" }];
  const withoutCriterion = accept(F.gateCases.draft_without_criterion).events;
  const withCriterion = accept(F.gateCases.draft_then_criterion).events;
  assert.deepEqual(core.nextStep({ steps, current: "s1", events: withoutCriterion }), { ok: true, step: "s2" });
  assert.deepEqual(core.nextStep({ steps, current: "s2", events: withoutCriterion }), { ok: false, code: "gate_not_met", gate: "criterion_set" });
  assert.deepEqual(core.nextStep({ steps, current: "s2", events: withCriterion }), { ok: true, step: "s3" });
  assert.deepEqual(core.nextStep({ steps, current: "s2", events: withoutCriterion, direction: "back" }), { ok: true, step: "s1" });
  assert.equal(core.nextStep({ steps, current: "s3", events: withCriterion }).code, "at_last_step");
  assert.equal(core.nextStep({ steps, current: "nope", events: withCriterion }).code, "unknown_step");
});

// ── Task.curriculum and teacher_review (SX-42, SX-55) ─────────────────────────
test("SX-55 curriculum phase moves forward only, and every move is in the task history", () => {
  const task = core.createTask({ id: "t1", project: "p", at: 1 });
  assert.equal(task.curriculum, undefined, "an existing task without curriculum keeps working");
  const assigned = core.updateCurriculum(task, {
    module: { course_id: "globalbuddy", version: "2026.09.20-1", sha256: F.SHA_A }, week: 3, phase: "assigned", current_step: "s1",
  }, { by: "user", at: 2 });
  assert.equal(assigned.curriculum.phase, "assigned");
  const working = core.updateCurriculum(assigned, { phase: "working", current_step: "s2" }, { by: "user", at: 3 });
  assert.deepEqual(working.history.map((h) => h.change).slice(-2), ["curriculum:phase:working", "curriculum:step:s2:entered"]);
  assert.equal(working.curriculum.steps.s2.entered_at, 3);
  assert.equal(working.curriculum.steps.s1.left_at, 3);
  const submitted = core.updateCurriculum(working, { phase: "submitted" }, { by: "user", at: 4 });
  assert.equal(submitted.curriculum.submitted_at, 4);
  assert.equal(core.updateCurriculum(submitted, { phase: "reflected" }, { by: "user", at: 5 }).curriculum.phase, "reflected");
  // SX-55 negative: reflected without submitted, and moving backwards.
  throwsCode(() => core.updateCurriculum(working, { phase: "reflected" }, { by: "user", at: 5 }), "invalid_phase_transition");
  throwsCode(() => core.updateCurriculum(submitted, { phase: "working" }, { by: "user", at: 5 }), "invalid_phase_transition");
  // The two axes stay separate (MC-23): work status is untouched by a phase move.
  assert.equal(submitted.status, "open");
});

test("SX-42 teacher_state defaults to unreviewed while no teacher record exists", async () => {
  const store = new Map();
  const record = new core.LocalRecord({
    async read(k) { return store.has(k) ? store.get(k) : null; },
    async write(k, v, o = {}) { if (o.ifAbsent && store.has(k)) throw new Error("exists"); store.set(k, v); },
    async list(p) { return [...store.keys()].filter((k) => k.startsWith(p)).sort(); },
    async remove(k) { store.delete(k); },
  });
  await record.createTask({ id: "t1", project: "p", at: 1 });
  assert.equal(await record.teacherState("t1", "cs1"), "unreviewed");
  assert.deepEqual([...core.TEACHER_STATES], ["unreviewed", "confirmed", "disputed"]);
});

// ── The refusals the core already had must not have moved ─────────────────────
test("P1-A no score, level or rank survives anywhere — in an event or in an interpretation", () => {
  const batch = core.validateObservation(batchCases.normal_chain()).batch;
  // One key list drives BOTH refusals: interpretation.ts and learning-events.ts
  // keep separate copies (MC-T09 forbids a shared export whose name reads like a
  // score), so a key added to one and not the other fails right here.
  for (const key of ["score", "scores", "level", "points", "rank", "percentile", "grade"]) {
    throwsCode(() => core.validateInterpretation({ format: "hps-interpretation/1", [key]: 1 }, batch), "unsupported_score");
    const flat = F.v2([F.ev("u1", 1, "user", { text: "안녕", [key]: 1 })]);
    throwsCode(() => core.validateObservation(flat), "unsupported_score");
    // …and nested, where an unknown-field check would never look.
    const nested = F.v2([F.ev("u1", 1, "user", { text: "안녕", context: { ...F.CONTEXT, [key]: 1 } })]);
    throwsCode(() => core.validateObservation(nested), "unsupported_score");
  }
  // The new fields themselves do not trip it, and the core still exports no scorer.
  const events = accept(F.validCases.all_eight_kinds).events;
  assert.equal(JSON.stringify(events).match(/"(score|level|points|rank|percentile|grade)"/), null);
  assert.equal(Object.keys(core).some((k) => /score|rank|grade/i.test(k)), false);
});

test("P1-A human evidence covers the student's own learning events and never the coach's", () => {
  const batch = accept(F.validCases.all_eight_kinds);
  assert.equal(core.isHumanEvidence(batch.events.find((e) => e.id === "cs1")), true);
  assert.equal(core.isHumanEvidence(batch.events.find((e) => e.id === "u1")), true);
  assert.equal(core.isHumanEvidence(batch.events.find((e) => e.id === "c1")), false);
  assert.equal(core.isHumanEvidence(batch.events.find((e) => e.id === "ef1")), false, "an external person is not the student");
  assert.equal(core.isHumanEvidence(accept(F.validCases.ai_authored_decision).events[1]), false, "actor=ai is never human");
  // The /1 rule it extends: a policy approval and a tool result are still not human.
  const legacy = core.validateObservation(batchCases.normal_chain()).batch;
  assert.equal(core.isHumanEvidence(legacy.events.find((e) => e.id === "a1")), false);
  assert.equal(core.isHumanEvidence(legacy.events.find((e) => e.id === "r1")), false);
});
