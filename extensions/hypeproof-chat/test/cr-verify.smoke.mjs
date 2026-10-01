// AI Verify over the Experiment Browser (cr-verify #1392), App half at the smoke layer.
// The runner and the session drive the real CR executor over a scripted kiosk page (the
// fake CDP page of the cr-browser smokes) and write to a real NativeObservationRecorder
// through the same checked port the App uses.
//
//   CR-T11 (runner)   runner steps on the preview origin run; a step to an external origin
//                     is refused with a reason before any CDP call
//   CR-T63 (runner)   the page outline is drawn for every runner step and gone after; the
//                     run reports running → idle to the panel
//   CR-T12 (session)  three typed criteria are stored as the student's criterion_set; zero
//                     or six are refused; an unconfirmed coach proposal starts nothing
//   CR-T14 (runner)   the same plan on the same version gives the same verdicts; a planted
//                     flaky page is reported non-reproducible
//   CR-T16 (session)  a failed criterion → fix request with report, criterion and version
//                     → the re-test of that criterion on the fixed version is
//                     retest_confirmed; a fix request without its references is refused
//   CR-T76 (session)  the panel says verified only for an all-pass report of the current
//                     version; a coach message changes nothing
//   CR-T03 (verify)   the verify tool answer is the same through both runtimes' adapters
//
// Run: node --experimental-strip-types test/cr-verify.smoke.mjs

import assert from "node:assert/strict";
import { makeFakePage, fakePort } from "./fixtures/fake-cdp-page.mjs";

const { CrExecutor } = await import("../src/experimentBrowser.ts");
const { runCriterionPlan } = await import("../src/verifyRunner.ts");
const { VerifySession, recordChecked, verifyContext, verifyToolResult } = await import("../src/verifySession.ts");
const { NativeObservationRecorder } = await import("../src/nativeObservationRecorder.ts");
const { validateObservation } = await import("../src/nativeObservationContract.ts");
const { toMcpToolResult } = await import("../src/browserMcp.ts");
const { toProxyToolResult } = await import("../src/browserControlHelpers.ts");
const { gates } = await import("../../../worker/src/lib/measurement-core/learning-events.ts");

const ORIGIN = "http://127.0.0.1:5173";
const START = `${ORIGIN}/index.html`;
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const vid = (c) => `sha256:${c.repeat(64)}`;
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

/**
 * A kiosk page: 주문 시작 → menu (음료 고르기, 수량 늘리기, 장바구니에 담기, 주문하기) → 완료.
 * Planted modes: `flaky` (주문하기 does nothing on every other load), `noDone` (the done
 * heading never appears: criterion 2 fails until "fixed").
 */
function kiosk(mode = {}) {
  const START_EL = [
    { key: "begin", role: "button", name: "주문 시작", tag: "button", id: "begin" },
    { key: "title", role: "heading", name: "어르신도 쉬운 키오스크", tag: "h1" },
  ];
  const MENU = [
    { key: "drink", role: "combobox", name: "음료 고르기", tag: "select", options: [{ value: "tea", text: "아이스티" }] },
    { key: "plus", role: "button", name: "수량 늘리기", tag: "button", id: "plus" },
    { key: "add", role: "button", name: "장바구니에 담기", tag: "button", id: "add" },
    { key: "pay", role: "button", name: "주문하기", tag: "button", id: "pay" },
  ];
  let loads = 0;
  const page = makeFakePage({
    elements: [...START_EL],
    onLoad: (p) => {
      loads++;
      p.state.elements = [...START_EL];
    },
    onClick: (p, key) => {
      if (key === "begin") p.state.elements = [...MENU];
      if (key === "pay") {
        if (mode.flaky && loads % 2 === 0) return;
        if (mode.noDone) return;
        p.state.elements = [{ key: "done", role: "heading", name: "주문이 완료되었어요", tag: "h2" }];
      }
    },
  });
  return page;
}

function executorFor(page, version = { current: vid("a") }) {
  const indicator = [];
  const ex = new CrExecutor(fakePort(page), {
    allowedOrigins: () => [ORIGIN],
    artifactVersion: async () => ({ id: version.current, entry: "index.html", files: [{ path: "index.html", sha256: version.current.slice(7), bytes: 10 }] }),
    onIndicator: (visible, tool) => indicator.push({ visible, tool }),
    settleMs: 0,
    sleep: (ms) => tick(Math.min(ms, 5)),
  });
  return { ex, indicator, version };
}

const PLAN_START = { steps: [{ action: "click", target: { role: "button", name: "주문 시작" } }], expect: [{ kind: "element", role: "combobox", name: "음료 고르기" }] };
const PLAN_ORDER = {
  steps: [
    { action: "click", target: { role: "button", name: "주문 시작" } },
    { action: "select", target: { role: "combobox", name: "음료 고르기" }, value: "아이스티" },
    { action: "click", target: { role: "button", name: "장바구니에 담기" } },
    { action: "click", target: { role: "button", name: "주문하기" } },
  ],
  expect: [{ kind: "text", text: "주문이 완료되었어요" }],
};

// ── CR-T11 (runner cases) ───────────────────────────────────────────────────

await test("CR-T11 positive: runner steps on the live-server origin run and are judged", async () => {
  const page = kiosk();
  const { ex } = executorFor(page);
  const out = await runCriterionPlan(ex, PLAN_START, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.equal(out.verdict.status, "pass", JSON.stringify(out.verdict));
  assert.equal(out.artifact.id, vid("a"));
  assert.deepEqual(out.verdict.steps.map((s) => [s.action, s.ok]), [["navigate", true], ["click", true]]);
});

await test("CR-T11 negative: a runner step to an external origin is refused with a reason, before any CDP call to it", async () => {
  const page = kiosk();
  const { ex } = executorFor(page);
  const plan = { steps: [{ action: "navigate", path: "https://example.com/pay" }], expect: [{ kind: "text", text: "x" }] };
  const out = await runCriterionPlan(ex, plan, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.equal(out.verdict.status, "not_verified");
  assert.match(out.verdict.reason, /범위 밖이라 거절/);
  assert.ok(!page.calls.some((c) => c.method === "Page.navigate" && /example\.com/.test(c.params.url)), "nothing was sent toward the external origin");
  // A start page off scope is refused before the executor is touched at all.
  const before = page.calls.length;
  const off = await runCriterionPlan(ex, PLAN_START, { startUrl: "https://example.com/", allowedOrigins: () => [ORIGIN] });
  assert.equal(off.verdict.status, "not_verified");
  assert.equal(page.calls.length, before);
  // Control: a same-origin navigate step runs.
  const same = await runCriterionPlan(ex, { steps: [{ action: "navigate", path: "/index.html?x=1" }], expect: [{ kind: "route", path: "/index.html" }] }, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.notEqual(same.verdict.status, "not_verified", JSON.stringify(same.verdict));
});

// ── CR-T63 (runner case) ────────────────────────────────────────────────────

function indicatorProblems(calls) {
  const ACT = new Set(["Input.dispatchMouseEvent", "Runtime.callFunctionOn", "Page.reload", "Input.insertText", "Page.navigate"]);
  let drawn = false;
  const problems = [];
  for (const c of calls) {
    if (c.method === "Overlay.highlightRect") drawn = true;
    else if (c.method === "Overlay.hideHighlight") drawn = false;
    else if (ACT.has(c.method) && !drawn) problems.push(`${c.method} with no indicator`);
    else if (c.method === "Page.captureScreenshot" && drawn) problems.push("evidence screenshot taken with the outline drawn");
  }
  if (drawn) problems.push("indicator left on after the run");
  return problems;
}

await test("CR-T63 positive: the outline is drawn for every runner step and gone after; the run is reported running then idle", async () => {
  const page = kiosk();
  const { ex, indicator } = executorFor(page);
  const runs = [];
  page.calls.length = 0;
  const out = await runCriterionPlan(ex, PLAN_ORDER, { startUrl: START, allowedOrigins: () => [ORIGIN], onRun: (r) => runs.push(r) });
  assert.equal(out.verdict.status, "pass", JSON.stringify(out.verdict.steps));
  // The navigate creates the tab session first; from its first action on, every action is outlined.
  const firstAct = page.calls.findIndex((c) => c.method === "Overlay.highlightRect");
  assert.deepEqual(indicatorProblems(page.calls.slice(firstAct)), []);
  assert.deepEqual(runs, [true, false]);
  assert.equal(indicator.filter((i) => i.visible).length, 5, "one chat-panel indicator per step (navigate + 4)");
  assert.equal(indicator.at(-1).visible, false);
});

await test("CR-T63 negative: a runner step with no visible indicator is caught", async () => {
  const page = kiosk();
  const { ex } = executorFor(page);
  // Planted: an executor whose outline never reaches the page.
  const send = page.cdp.send.bind(page.cdp);
  page.cdp.send = (m, p) => (m === "Overlay.highlightRect" ? Promise.resolve({}) : send(m, p));
  await runCriterionPlan(ex, PLAN_START, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  const drawnCalls = page.calls.filter((c) => c.method !== "Overlay.highlightRect");
  assert.ok(indicatorProblems(drawnCalls).some((p) => /with no indicator/.test(p)));
});

// ── the session over a real recorder ────────────────────────────────────────

function seat({ page = kiosk(), version = { current: vid("a") }, on = { value: true }, preview = START } = {}) {
  const recorder = new NativeObservationRecorder({ format: "hps-observation/2", scope: "synthetic-cr-verify", session: "s1", program: "p1" });
  const task = "task-1";
  const context = verifyContext({ task });
  let persisted = 0;
  const { ex, indicator } = executorFor(page, version);
  const runs = [];
  const port = {
    events: () => recorder.batch.events,
    record: (kind, text, extra) => recordChecked(recorder.batch, validateObservation, () => recorder.record(task, kind, text, extra)),
    recordLearning: (draft) => recordChecked(recorder.batch, validateObservation, () => recorder.recordLearningEvent({ ...draft, context })),
    persist: () => persisted++,
  };
  let n = 0;
  const session = new VerifySession(
    {
      switchOn: () => on.value,
      recorder: async () => port,
      startUrl: () => preview,
      allowedOrigins: () => [ORIGIN],
      executor: () => ex,
      currentVersion: async () => version.current,
      onRun: (r) => runs.push(r),
      now: () => 1_700_000_000_000 + n,
    },
    () => `id-${++n}`,
  );
  return { session, recorder, page, version, on, indicator, runs, persisted: () => persisted };
}
const valid = (recorder) => validateObservation(structuredClone(recorder.batch)).batch;
const PLAN = (p) => JSON.stringify(p);

await test("CR-T12 positive: three typed criteria start a run and are stored as the student's criterion_set", async () => {
  const s = seat();
  const r = await s.session.start([{ text: "주문 시작을 누르면 음료 고르기가 보인다" }, { text: "주문하면 완료 화면이 보인다" }, { text: "오류가 없다" }]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.sendText, /기대 조건 3개/);
  const crit = valid(s.recorder).events.filter((e) => e.kind === "criterion_set");
  assert.deepEqual(crit.map((e) => [e.actor, e.student_text]), [["user", "주문 시작을 누르면 음료 고르기가 보인다"], ["user", "주문하면 완료 화면이 보인다"], ["user", "오류가 없다"]]);
  const ctx = s.session.takeCoachContext();
  for (const e of crit) assert.ok(ctx.includes(e.id), "the coach is told each criterion id");
  assert.equal(s.session.takeCoachContext(), null, "the coach context goes with one turn only");
});

await test("CR-T12 negative: zero or six criteria are refused; an unconfirmed coach proposal starts nothing and is never the student's", async () => {
  const s = seat();
  assert.deepEqual(await s.session.start([]), { ok: false, code: "criteria_count" });
  assert.deepEqual(await s.session.start(Array.from({ length: 6 }, (_, i) => ({ text: `조건 ${i}` }))), { ok: false, code: "criteria_count" });
  const proposed = await s.session.propose({ criteria: JSON.stringify(["주문 시작이 보인다", "완료 화면이 보인다"]) });
  assert.equal(proposed.isError, false);
  const view = await s.session.view();
  assert.equal(view.proposals.length, 2);
  const pid = view.proposals[0].id;
  assert.deepEqual(await s.session.start([{ text: view.proposals[0].text, proposed_by: "ai", confirmed: false, adopted_from: pid }]), { ok: false, code: "unconfirmed_ai_criterion" });
  // A proposal the session never made cannot be "confirmed" into a run either.
  assert.deepEqual(await s.session.start([{ text: "x", proposed_by: "ai", confirmed: true, adopted_from: "made-up" }]), { ok: false, code: "unconfirmed_ai_criterion" });
  assert.equal(valid(s.recorder).events.filter((e) => e.kind === "criterion_set").length, 0, "nothing stored as the student's");
  assert.equal((await s.session.runTool({ criterion_id: "x", plan: "{}" })).isError, true, "and no run exists for the coach to execute");
  // Control: confirmed, it runs and keeps where it came from (design rule 4).
  const ok = await s.session.start([{ text: view.proposals[0].text, proposed_by: "ai", confirmed: true, adopted_from: pid }]);
  assert.equal(ok.ok, true);
  const c = valid(s.recorder).events.find((e) => e.kind === "criterion_set");
  assert.equal(c.adopted_from, pid);
  assert.equal(c.actor, "user");
});

await test("CR-T14 positive: two runs of the same plans on the same version give identical verdicts (re-test runs with no model)", async () => {
  const s = seat();
  await s.session.start([{ text: "음료 고르기가 보인다" }, { text: "완료 화면이 보인다" }]);
  const [c1, c2] = s.session.activeRun.criteria;
  assert.equal((await s.session.runTool({ criterion_id: c1.id, plan: PLAN(PLAN_START) })).isError, false);
  assert.equal((await s.session.runTool({ criterion_id: c2.id, plan: PLAN(PLAN_ORDER) })).isError, false);
  const first = (await s.session.view()).report;
  const again = await s.session.retest();
  assert.equal(again.ok, true);
  const second = (await s.session.view()).report;
  assert.notEqual(second.run_id, first.run_id);
  assert.deepEqual(second.criteria.map((c) => [c.id, c.status]), first.criteria.map((c) => [c.id, c.status]));
  assert.ok(second.criteria.every((c) => c.status === "pass" && c.reproducible));
});

await test("CR-T14 negative: a planted flaky page makes two runs disagree; the criterion is non-reproducible, not pass", async () => {
  const s = seat({ page: kiosk({ flaky: true }) });
  await s.session.start([{ text: "완료 화면이 보인다" }]);
  const [c] = s.session.activeRun.criteria;
  await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_ORDER) });
  await s.session.retest();
  const report = (await s.session.view()).report;
  assert.equal(report.criteria[0].status, "non_reproducible", JSON.stringify(report.criteria[0]));
  assert.notEqual((await s.session.view()).verification.state, "verified");
});

await test("CR-T16 + CR-T76: fail → fix request (report, criterion 2, v0) → re-test on v1 passes as retest_confirmed → verified", async () => {
  const page = kiosk({ noDone: true });
  const s = seat({ page });
  await s.session.start([{ text: "음료 고르기가 보인다" }, { text: "완료 화면이 보인다" }]);
  const [c1, c2] = s.session.activeRun.criteria;
  await s.session.runTool({ criterion_id: c1.id, plan: PLAN(PLAN_START) });
  const answer = await s.session.runTool({ criterion_id: c2.id, plan: PLAN(PLAN_ORDER) });
  assert.match(answer.text, /^\[실패\] 완료 화면이 보인다/);
  let view = await s.session.view();
  assert.equal(view.verification.state, "failed");
  const runOnV0 = view.report.run_id;
  // A coach message saying it is done changes nothing (CR-81).
  s.recorder.record("task-1", "coach", "완료했어요! 다 잘 동작해요.");
  assert.equal((await s.session.view()).verification.state, "failed");
  // The fix request.
  const fix = await s.session.fix(c2.id, "주문하기를 누르면 완료 화면이 나오게 고쳐 주세요");
  assert.equal(fix.ok, true, JSON.stringify(fix));
  assert.equal(fix.sendText, "주문하기를 누르면 완료 화면이 나오게 고쳐 주세요");
  const ctx = s.session.takeCoachContext();
  const json = JSON.parse(ctx.slice(ctx.indexOf("{")));
  assert.deepEqual([json.report, json.criterion.id, json.artifact_version], [runOnV0, c2.id, vid("a")]);
  const change = valid(s.recorder).events.find((e) => e.kind === "change_requested");
  assert.equal(change.criterion_ref, c2.id);
  assert.equal(change.artifact_before, "a".repeat(64));
  // The coach fixes the product: the page now finishes the order, and the files are v1.
  page.state.onClick = (p, key) => {
    if (key === "begin") p.state.elements = [{ key: "drink", role: "combobox", name: "음료 고르기", tag: "select", options: [{ value: "tea", text: "아이스티" }] }, { key: "add", role: "button", name: "장바구니에 담기", tag: "button" }, { key: "pay", role: "button", name: "주문하기", tag: "button" }];
    if (key === "pay") p.state.elements = [{ key: "done", role: "heading", name: "주문이 완료되었어요", tag: "h2" }];
  };
  s.version.current = vid("b");
  assert.equal((await s.session.view()).verification.state, "needs_recheck", "AE-37: the v0 report does not cover v1");
  const retest = await s.session.retest();
  assert.equal(retest.ok, true);
  const events = valid(s.recorder).events;
  const confirmed = events.filter((e) => e.kind === "retest_confirmed");
  assert.deepEqual(confirmed.map((e) => [e.criterion_ref, e.artifact_after]), [[c2.id, "b".repeat(64)]], "criterion 2 re-tested on v1; criterion 1 had no fix request, so it is test_observed");
  assert.equal(events.filter((e) => e.kind === "test_observed" && e.artifact_after === "b".repeat(64)).map((e) => e.criterion_ref).join(), c1.id);
  assert.equal(gates({ events }).verification.state, "confirmed");
  view = await s.session.view();
  assert.deepEqual(view.report.criteria.map((c) => c.id), [c1.id, c2.id], "the re-test is the whole set");
  assert.equal(view.verification.state, "verified");
});

await test("CR-T16 negative: a fix request without its report or criterion is refused and nothing is sent or recorded", async () => {
  const s = seat({ page: kiosk({ noDone: true }) });
  assert.deepEqual(await s.session.fix("no-such-criterion", "고쳐 주세요"), { ok: false, code: "missing_report_ref" });
  await s.session.start([{ text: "완료 화면이 보인다" }]);
  s.session.takeCoachContext(); // the run's own context went with the start turn
  const [c] = s.session.activeRun.criteria;
  assert.deepEqual(await s.session.fix(c.id, "고쳐 주세요"), { ok: false, code: "missing_report_ref" }, "no report yet for that criterion");
  await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_ORDER) });
  assert.deepEqual(await s.session.fix(null, "고쳐 주세요"), { ok: false, code: "missing_report_ref" });
  assert.deepEqual(await s.session.fix(c.id, ""), { ok: false, code: "missing_student_text" });
  assert.equal(s.session.takeCoachContext(), null, "no free-text request went to the coach");
  assert.equal(valid(s.recorder).events.filter((e) => e.kind === "change_requested").length, 0);
});

await test("CR-T76 negative: a run the coach did not finish is not verified (an untested criterion shows as not verified)", async () => {
  const s = seat();
  await s.session.start([{ text: "음료 고르기가 보인다" }, { text: "완료 화면이 보인다" }]);
  const [c1, c2] = s.session.activeRun.criteria;
  await s.session.runTool({ criterion_id: c1.id, plan: PLAN(PLAN_START) });
  const view = await s.session.view();
  assert.deepEqual(view.report.criteria.map((c) => [c.id, c.status]), [[c1.id, "pass"], [c2.id, "not_verified"]]);
  assert.equal(view.verification.state, "incomplete");
  assert.deepEqual(await s.session.fix(c2.id, "고쳐 주세요"), { ok: false, code: "criterion_not_tested" });
});

await test("CR-T76 negative: no report, or a report of another version, never shows verified", async () => {
  const s = seat();
  assert.equal((await s.session.view()).verification.state, "not_verified");
  await s.session.start([{ text: "음료 고르기가 보인다" }]);
  const [c] = s.session.activeRun.criteria;
  await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_START) });
  assert.equal((await s.session.view()).verification.state, "verified", "control: an all-pass report on this version");
  s.version.current = vid("c");
  assert.equal((await s.session.view()).verification.state, "needs_recheck", "the files changed after the report");
});

await test("the session refuses runs that cannot be bound, and the batch stays readable", async () => {
  const s = seat({ preview: null });
  assert.deepEqual(await s.session.start([{ text: "a" }]), { ok: false, code: "no_preview" });
  const t = seat();
  await t.session.start([{ text: "a" }]);
  const [c] = t.session.activeRun.criteria;
  assert.match((await t.session.runTool({ criterion_id: c.id, plan: "not json" })).text, /plan_not_json/);
  assert.match((await t.session.runTool({ criterion_id: "other", plan: PLAN(PLAN_START) })).text, /이 테스트의 조건이 아니에요/);
  valid(t.recorder);
});

// ── CR-T03 (verify tool): one answer, both runtimes ─────────────────────────

await test("CR-T03: the same verify call gives identical results through the SDK and proxy adapters", async () => {
  const s = seat();
  await s.session.start([{ text: "음료 고르기가 보인다" }]);
  const [c] = s.session.activeRun.criteria;
  const answer = await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_START) });
  const r = verifyToolResult(answer);
  const sdk = toMcpToolResult(r).content.map((b) => b.text).join("\n");
  const proxy = toProxyToolResult("t", r).content.map((b) => b.text).join("\n");
  assert.equal(sdk, proxy);
  assert.equal(toMcpToolResult(r).isError, undefined);
  assert.equal(toProxyToolResult("t", r).is_error, undefined);
  const refused = verifyToolResult(await s.session.runTool({}));
  assert.equal(toMcpToolResult(refused).isError, true);
  assert.equal(toProxyToolResult("t", refused).is_error, true);
});

console.log(`\n${passed} cr-verify checks passed`);
