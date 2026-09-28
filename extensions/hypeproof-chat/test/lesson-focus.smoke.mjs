// #751 G2 · #1008 — the learner device's pure rules for the current step: which step and help mode a turn carries, what a
// work-surface save may hold, how its text travels, what a rehearsal report says, and that both runtimes send the headers.
// Every rule is checked against a wrong implementation of itself where that is meaningful (negative control).
import assert from "node:assert/strict";
const F = await import("../src/lessonFocus.ts");
const { buildSdkGatewayEnv } = await import("../src/sdkCoachHelpers.ts");
const { proxyChat } = await import("../src/proxyClient.ts");
let n = 0; const ok = (name) => { n++; console.log("PASS " + name); };

const A = { sha256: "a".repeat(64), version: "m2026.09.22-11", content: { steps: [
  { id: "criteria", title: "확인 기준 정하기", help: { default: "hint", allowed: ["hint", "independent"] }, ui: "criterion_form" },
  { id: "look", title: "예제 살펴보기" },
  { id: "board", title: "숫자 보기", ui: "metric_board" },
] } };
const B = { sha256: "b".repeat(64), version: "m2026.09.22-12", content: { steps: [
  { id: "revise", title: "고치고 이유 남기기", help: { default: "co_edit", allowed: ["co_edit", "independent"] }, ui: "decision_form" },
] } };

{
  assert.deepEqual(F.acceptFocus(A, { stepId: "criteria", helpMode: "independent" }), { sha256: A.sha256, stepId: "criteria", helpMode: "independent" });
  assert.deepEqual(F.acceptFocus(A, { stepId: "criteria", helpMode: "co_edit" }), { sha256: A.sha256, stepId: "criteria", helpMode: null }, "a mode the step does not offer is dropped, never kept");
  assert.equal(F.acceptFocus(A, { stepId: "nope", helpMode: "hint" }), null);
  assert.equal(F.acceptFocus(null, { stepId: "criteria" }), null);
  const focus = F.acceptFocus(A, { stepId: "criteria", helpMode: "independent" });
  assert.deepEqual(F.turnLesson(A, focus), { step: "criteria", helpMode: "independent" });
  assert.deepEqual(F.turnLesson(A, F.acceptFocus(A, { stepId: "look", helpMode: "hint" })), { step: "look" }, "a step without help sends no help mode");
  assert.deepEqual(F.turnLesson(B, focus), { step: "revise" }, "after a switch, a focus made under the old lesson is not carried: first step, lesson default");
  assert.deepEqual(F.turnLesson(A, null), { step: "criteria" });
  assert.deepEqual(F.turnLesson({ ...A, content: { steps: [] } }, null), {});
  const wrong = (lesson, f) => ({ step: f?.stepId, helpMode: f?.helpMode ?? undefined });
  assert.notDeepEqual(wrong(B, focus), F.turnLesson(B, focus), "NEGATIVE CONTROL: carrying the old focus into the switched lesson differs");
  ok("focus → turn: only a step of THIS lesson, only an offered help mode, a switched lesson starts from its first step");
}
{
  assert.equal(F.surfaceOf(A.content.steps[0]), "criterion_form"); assert.equal(F.surfaceOf(A.content.steps[1]), "chat"); assert.equal(F.surfaceOf(A.content.steps[2]), "unsupported:metric_board");
  const c = F.acceptWork(A, { stepId: "criteria", kind: "criterion", text: "  예약 버튼이 첫 화면에 보인다  " }, 5);
  assert.deepEqual(c, { stepId: "criteria", work: { kind: "criterion", text: "예약 버튼이 첫 화면에 보인다", savedAt: 5 } });
  assert.equal(F.acceptWork(A, { stepId: "criteria", kind: "decision", text: "x", reason: "y" }, 5), null, "the kind must match the step's surface");
  assert.equal(F.acceptWork(A, { stepId: "look", kind: "criterion", text: "x" }, 5), null, "a chat step has no work surface");
  assert.equal(F.acceptWork(B, { stepId: "revise", kind: "decision", text: "진료시간 수정" }, 5), null, "a decision needs its reason");
  assert.equal(F.acceptWork(A, { stepId: "criteria", kind: "criterion", text: "   " }, 5), null);
  assert.equal(F.acceptWork(A, { stepId: "criteria", kind: "criterion", text: "x".repeat(5000) }, 5).work.text.length, F.WORK_TEXT_MAX);
  const d = F.acceptWork(B, { stepId: "revise", kind: "decision", text: "토요일 진료시간을 오후 2시로", reason: "원장님이 확인한 실제 시간" }, 6);
  assert.match(F.workContext("고치고 이유 남기기", d.work), /결정: 토요일 진료시간을 오후 2시로\n이유: 원장님이 확인한 실제 시간/);
  assert.match(F.workContext("확인 기준 정하기", c.work), /학생이 직접 저장한 확인 기준\]\n예약 버튼이 첫 화면에 보인다/);
  assert.equal(F.workContext("x", undefined), "");
  ok("work surfaces: criterion/decision only where the step asks, bounded, labelled as the learner's own words");
}
{
  const drawn = [{ id: "criteria", visited: true, help_offered: ["hint", "independent", "bogus"], help_default: "hint", surface: "criterion_form" }, { id: "extra", visited: true, help_offered: [], help_default: null, surface: "chat" }];
  const r = F.rehearsalReport(A, drawn, { extension_version: "0.1.x", host: "h", runtime: "agent-sdk", os: "darwin", arch: "arm64" });
  assert.deepEqual(r.steps.map((s) => [s.id, s.visited, s.help_offered, s.surface]), [["criteria", true, ["hint", "independent"], "criterion_form"], ["look", false, [], "not_drawn"], ["board", false, [], "not_drawn"]],
    "steps the panel never drew are reported as not drawn — never filled in from the lesson");
  ok("rehearsal report: only what was drawn, only this lesson's steps");
}
{
  const env = buildSdkGatewayEnv({ ANTHROPIC_CUSTOM_HEADERS: "x-hps-lesson-step: ambient\nx-hps-help-mode: demonstrate\nx-other: keep" }, { proxyUrl: "https://synthetic.invalid/v1", token: "t", lessonStep: "criteria", helpMode: "independent" });
  const lines = env.ANTHROPIC_CUSTOM_HEADERS.split("\n");
  assert.ok(lines.includes("x-hps-lesson-step: criteria") && lines.includes("x-hps-help-mode: independent") && lines.includes("x-other: keep"));
  assert.equal(lines.filter((l) => /x-hps-(lesson-step|help-mode)/.test(l)).length, 2, "an ambient step/help header is never inherited");
  const bad = buildSdkGatewayEnv({}, { proxyUrl: "https://synthetic.invalid/v1", token: "t", lessonStep: "bad step\nx: y", helpMode: "hint" }).ANTHROPIC_CUSTOM_HEADERS ?? "";
  assert.doesNotMatch(bad, /lesson-step|help-mode/, "an invalid step id sends neither header");
  const none = buildSdkGatewayEnv({}, { proxyUrl: "https://synthetic.invalid/v1", token: "t" }).ANTHROPIC_CUSTOM_HEADERS ?? "";
  assert.doesNotMatch(none, /lesson-step|help-mode/, "no lesson → nothing new on the wire");
  const real = globalThis.fetch; let seen;
  globalThis.fetch = async (_u, init) => { seen = init.headers; return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }); };
  try { await proxyChat({ proxyUrl: "https://synthetic.invalid/v1", model: "m", token: "t", history: [], userText: "q", signal: new AbortController().signal, coachName: "c", lessonStep: "revise", helpMode: "co_edit" }).catch(() => {}); } finally { globalThis.fetch = real; }
  assert.equal(seen["x-hps-lesson-step"], "revise"); assert.equal(seen["x-hps-help-mode"], "co_edit");
  ok("both runtimes: the turn's step and help mode go out as x-hps-lesson-step / x-hps-help-mode, validated, never inherited");
}
console.log(`${n} lesson focus checks passed`);
