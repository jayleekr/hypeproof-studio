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
//   CR-T15 (session)  a judgment the coach writes into a plan never decides a verdict
//   CR-T76 (CR-81 lifecycle, session)
//                     a re-test keeps every criterion of the run; a run closes when done,
//                     when its turn ends or when the files change; a verdict is bound to
//                     the entry page's version even when the run ends on another page;
//                     runs on the one tab never interleave; the host closes the run at
//                     turn end and refuses sends and verify actions while the other runs
//
// Run: node --experimental-strip-types test/cr-verify.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function executorFor(page, version = { current: vid("a") }, artifactVersion = null) {
  const indicator = [];
  const ex = new CrExecutor(fakePort(page), {
    allowedOrigins: () => [ORIGIN],
    artifactVersion: artifactVersion ?? (async () => ({ id: version.current, entry: "index.html", files: [{ path: "index.html", sha256: version.current.slice(7), bytes: 10 }] })),
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

function seat({ page = kiosk(), version = { current: vid("a") }, on = { value: true }, preview = START, artifactVersion = null, storeScreenshot = null } = {}) {
  const recorder = new NativeObservationRecorder({ format: "hps-observation/2", scope: "synthetic-cr-verify", session: "s1", program: "p1" });
  const task = "task-1";
  const context = verifyContext({ task });
  let persisted = 0;
  const { ex, indicator } = executorFor(page, version, artifactVersion);
  const runs = [];
  const runningAtRun = [];
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
      onRun: (r) => {
        runs.push(r);
        if (r) runningAtRun.push(session.running);
      },
      ...(storeScreenshot ? { storeScreenshot } : {}),
      now: () => 1_700_000_000_000 + n,
    },
    () => `id-${++n}`,
  );
  return { session, recorder, page, version, on, indicator, runs, runningAtRun, persisted: () => persisted };
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
  // "다시 테스트" keeps the untested criterion in the set: never verified by shrinking it.
  const again = await s.session.retest();
  assert.equal(again.ok, true);
  const after = await s.session.view();
  assert.notEqual(after.report.run_id, view.report.run_id);
  assert.deepEqual(after.report.criteria.map((c) => [c.id, c.status]), [[c1.id, "pass"], [c2.id, "not_verified"]]);
  assert.equal(after.verification.state, "incomplete");
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

// ── CR-T15 / CR-T76 (CR-81 lifecycle): what the coach cannot do ─────────────

const PLAN_VISUAL = (extra) => ({ steps: PLAN_ORDER.steps, expect: [{ kind: "visual", question: "완료 화면이 보이나요?", ...extra }] });

await test("CR-T15 negative: a vision judgment written into the plan is refused and never sets verified", async () => {
  // The order never completes, so a claimed "pass" would be a lie.
  // A seat that stores screenshots, as a signed-in App seat does.
  const shots = [];
  const s = seat({ page: kiosk({ noDone: true }), storeScreenshot: async (b) => (shots.push(b), `sha256:${"d".repeat(64)}`) });
  await s.session.start([{ text: "주문하면 완료 화면이 보인다" }]);
  const [c] = s.session.activeRun.criteria;
  const claimed = await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_VISUAL({ judgment: "pass", method: "vision" })) });
  assert.equal(claimed.isError, true);
  assert.match(claimed.text, /plan_judgment/);
  assert.equal((await s.session.view()).verification.state, "not_verified");
  assert.equal(valid(s.recorder).events.filter((e) => e.kind === "test_observed").length, 0, "nothing recorded from the claim");
  // Control: the question alone runs, and stays "not verified" (no vision step exists).
  const asked = await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_VISUAL({})) });
  assert.match(asked.text, /^\[확인 안 됨\]/);
  const view = await s.session.view();
  assert.deepEqual(view.report.criteria.map((x) => [x.status, x.method]), [["not_verified", "dom"]]);
  assert.equal(shots.length, 1, "the screenshot was stored, and still decided nothing");
  assert.equal(view.verification.state, "incomplete");
});

await test("CR-T76 (CR-81 lifecycle): a run closes when every criterion has a verdict; a second plan for a done criterion is refused", async () => {
  const s = seat({ page: kiosk({ noDone: true }) });
  await s.session.start([{ text: "음료 고르기가 보인다" }, { text: "완료 화면이 보인다" }]);
  const [c1, c2] = s.session.activeRun.criteria;
  assert.match((await s.session.runTool({ criterion_id: c2.id, plan: PLAN(PLAN_ORDER) })).text, /^\[실패\]/);
  // Shopping for a pass with a weaker plan, in the same run.
  const again = await s.session.runTool({ criterion_id: c2.id, plan: PLAN({ steps: [{ action: "reload" }], expect: [{ kind: "no_errors" }] }) });
  assert.equal(again.isError, true);
  assert.match(again.text, /이미 판정했어요/);
  await s.session.runTool({ criterion_id: c1.id, plan: PLAN(PLAN_START) });
  assert.equal(s.session.activeRun, null, "every criterion has a verdict: the run is closed");
  // The coach checks its own fix in a later turn: no run, nothing recorded, state unchanged.
  await s.session.fix(c2.id, "완료 화면이 나오게 고쳐 주세요");
  s.version.current = vid("b");
  const before = s.recorder.batch.events.length;
  const self = await s.session.runTool({ criterion_id: c2.id, plan: PLAN({ steps: [{ action: "reload" }], expect: [{ kind: "no_errors" }] }) });
  assert.equal(self.isError, true);
  assert.equal(s.recorder.batch.events.length, before);
  assert.equal(gates({ events: valid(s.recorder).events }).verification.state === "confirmed", false);
  assert.equal(valid(s.recorder).events.filter((e) => e.kind === "retest_confirmed").length, 0);
});

await test("CR-T76 (CR-81 lifecycle): an open run is closed by its turn's end and by changed files", async () => {
  const s = seat();
  await s.session.start([{ text: "음료 고르기가 보인다" }, { text: "완료 화면이 보인다" }]);
  const [c1] = s.session.activeRun.criteria;
  s.session.endTurn();
  assert.equal(s.session.activeRun, null);
  assert.equal((await s.session.runTool({ criterion_id: c1.id, plan: PLAN(PLAN_START) })).isError, true);
  // A run pinned to v-a, after the files became v-b: refused and closed, nothing recorded.
  await s.session.start([{ text: "음료 고르기가 보인다" }]);
  const [c] = s.session.activeRun.criteria;
  s.version.current = vid("b");
  const before = s.recorder.batch.events.length;
  const r = await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_START) });
  assert.equal(r.isError, true);
  assert.match(r.text, /파일이 바뀌어/);
  assert.equal(s.recorder.batch.events.length, before);
  assert.equal(s.session.activeRun, null);
  // Control: a run on an unchanged version is tested.
  await s.session.start([{ text: "음료 고르기가 보인다" }]);
  const [d] = s.session.activeRun.criteria;
  assert.equal((await s.session.runTool({ criterion_id: d.id, plan: PLAN(PLAN_START) })).isError, false);
});

await test("CR-T76 (CR-81 lifecycle): a criterion that ends on another page is bound to the entry page's version (multi-page)", async () => {
  const page = kiosk();
  const version = { current: vid("a") };
  // Each entry HTML has its own version, as the App computes it (artifactVersionFor(root, path)).
  const artifactVersion = async (url) => {
    const b = new URL(url).pathname === "/b.html";
    const id = b ? vid("b") : version.current;
    return { id, entry: b ? "b.html" : "index.html", files: [{ path: b ? "b.html" : "index.html", sha256: id.slice(7), bytes: 10 }] };
  };
  const s = seat({ page, version, artifactVersion });
  await s.session.start([{ text: "주문 시작 버튼이 있다" }, { text: "안내 페이지로 갈 수 있다" }]);
  const [c1, c2] = s.session.activeRun.criteria;
  await s.session.runTool({ criterion_id: c1.id, plan: PLAN({ steps: [], expect: [{ kind: "element", role: "button", name: "주문 시작" }] }) });
  const a2 = await s.session.runTool({ criterion_id: c2.id, plan: PLAN({ steps: [{ action: "navigate", path: "/b.html" }], expect: [{ kind: "route", path: "/b.html" }] }) });
  assert.match(a2.text, /^\[통과\]/);
  const view = await s.session.view();
  assert.deepEqual(view.report.criteria.map((c) => [c.id, c.status]), [[c1.id, "pass"], [c2.id, "pass"]], JSON.stringify(view.report.criteria));
  assert.equal(view.report.artifact_version_id, vid("a"));
  assert.equal(view.verification.state, "verified");
});

await test("CR-T76 (CR-81 lifecycle) negative: files that change while a run is on the page make the verdict not verified", async () => {
  const version = { current: vid("a") };
  const page = kiosk();
  const click = page.state.onClick;
  page.state.onClick = (p, key) => {
    click(p, key);
    if (key === "begin") version.current = vid("c"); // the coach's file write lands mid-run
  };
  const s = seat({ page, version });
  await s.session.start([{ text: "음료 고르기가 보인다" }]);
  const [c] = s.session.activeRun.criteria;
  const r = await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_START) });
  assert.match(r.text, /^\[확인 안 됨\].*파일이 바뀌어서/);
  const view = await s.session.view();
  assert.notEqual(view.verification.state, "verified");
  // Bound to the version the run started on, not the one it ended on.
  assert.equal(valid(s.recorder).events.find((e) => e.kind === "test_observed").artifact_after, "a".repeat(64));
  // The runner sees it on its own too (same entry page, another version at the end).
  version.current = vid("a");
  const out = await runCriterionPlan(executorFor(page, version).ex, PLAN_START, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.equal(out.verdict.status, "not_verified");
  assert.equal(out.artifact.id, vid("a"));
});

await test("CR-T76 (CR-81 lifecycle): runs never share the tab; a re-test refuses a second re-test and the coach's call", async () => {
  const s = seat();
  await s.session.start([{ text: "완료 화면이 보인다" }]);
  const [c] = s.session.activeRun.criteria;
  await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_ORDER) });
  const [a, b] = await Promise.all([s.session.retest(), s.session.retest()]);
  assert.deepEqual([a.ok, b.ok], [true, false]);
  assert.equal(b.code, "busy");
  await s.session.start([{ text: "음료 고르기가 보인다" }]);
  const [d] = s.session.activeRun.criteria;
  const [rt, tool] = await Promise.all([s.session.retest(), s.session.runTool({ criterion_id: d.id, plan: PLAN(PLAN_START) })]);
  assert.equal(rt.ok, true);
  assert.equal(tool.isError, true);
  assert.match(tool.text, /이미 진행 중/);
  const outcomes = valid(s.recorder).events.filter((e) => e.kind === "test_observed").map((e) => e.outcome);
  assert.ok(outcomes.every((o) => o === "match"), JSON.stringify(outcomes));
  assert.equal((await s.session.view()).verification.state, "verified");
});

await test("CR-T76 (CR-81 lifecycle) negative: the entry page changing while a run ends on another page is not verified (session check)", async () => {
  // The run navigates to /b.html, so the runner's own check (same entry page at the end) never
  // sees the change: only the session's post-run version check does.
  const page = kiosk();
  const version = { current: vid("a") };
  const artifactVersion = async (url) => {
    const b = new URL(url).pathname === "/b.html";
    const id = b ? vid("b") : version.current;
    return { id, entry: b ? "b.html" : "index.html", files: [{ path: b ? "b.html" : "index.html", sha256: id.slice(7), bytes: 10 }] };
  };
  const load = page.state.onLoad;
  let loads = 0;
  const s = seat({ page, version, artifactVersion });
  await s.session.start([{ text: "안내 페이지로 갈 수 있다" }]);
  const [c] = s.session.activeRun.criteria;
  page.state.onLoad = (p) => {
    load(p);
    if (++loads === 2) version.current = vid("c"); // the coach's write to index.html lands during the navigate
  };
  const r = await s.session.runTool({ criterion_id: c.id, plan: PLAN({ steps: [{ action: "navigate", path: "/b.html" }], expect: [{ kind: "route", path: "/b.html" }] }) });
  assert.match(r.text, /^\[확인 안 됨\] 안내 페이지로 갈 수 있다 — 테스트하는 동안 파일이 바뀌어서/, r.text);
  const view = await s.session.view();
  assert.notEqual(view.verification.state, "verified");
  const shown = valid(s.recorder).events.filter((e) => e.kind === "test_observed");
  assert.deepEqual(shown.map((e) => [e.outcome, e.artifact_after]), [["unknown", "a".repeat(64)]], "bound to the start version, never a match");
  // Control: the same run with the entry page unchanged passes.
  page.state.onLoad = load;
  version.current = vid("a");
  await s.session.start([{ text: "안내 페이지로 갈 수 있다" }]);
  const [d] = s.session.activeRun.criteria;
  assert.match((await s.session.runTool({ criterion_id: d.id, plan: PLAN({ steps: [{ action: "navigate", path: "/b.html" }], expect: [{ kind: "route", path: "/b.html" }] }) })).text, /^\[통과\]/);
});

await test("CR-T14 + CR-T76 (CR-81 lifecycle): parallel coach calls never share the tab; the same criterion called twice gets one verdict", async () => {
  // Two criteria called in parallel (the SDK coach can issue parallel tool use).
  const s = seat();
  await s.session.start([{ text: "음료 고르기가 보인다" }, { text: "완료 화면이 보인다" }]);
  const [c1, c2] = s.session.activeRun.criteria;
  const answers = await Promise.all([s.session.runTool({ criterion_id: c1.id, plan: PLAN(PLAN_START) }), s.session.runTool({ criterion_id: c2.id, plan: PLAN(PLAN_ORDER) })]);
  assert.deepEqual(answers.map((a) => a.isError), [false, false]);
  let active = 0;
  let most = 0;
  for (const r of s.runs) {
    active += r ? 1 : -1;
    most = Math.max(most, active);
  }
  assert.equal(most, 1, `runs on the tab overlapped: ${JSON.stringify(s.runs)}`);
  assert.deepEqual(s.runs, [true, false, true, false]);
  assert.deepEqual(s.runningAtRun, [true, true], "the session reports running while a coach call acts on the page (CR-68, chat-panel half)");
  // The same criterion called twice at once: one verdict, the second refused.
  const t = seat();
  await t.session.start([{ text: "완료 화면이 보인다" }]);
  const [c] = t.session.activeRun.criteria;
  const [first, second] = await Promise.all([t.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_ORDER) }), t.session.runTool({ criterion_id: c.id, plan: PLAN({ steps: [{ action: "reload" }], expect: [{ kind: "no_errors" }] }) })]);
  assert.match(first.text, /^\[통과\]/);
  assert.equal(second.isError, true);
  assert.match(second.text, /이미 끝났어요|이미 판정했어요/);
  assert.equal(valid(t.recorder).events.filter((e) => e.kind === "test_observed" || e.kind === "retest_confirmed").length, 1, "exactly one test event for the criterion");
});

await test("CR-T14 negative: pressing 테스트 시작 again with the same words and plan on a flaky page is not verified", async () => {
  const s = seat({ page: kiosk({ flaky: true }) });
  const answers = [];
  for (let i = 0; i < 3; i++) {
    await s.session.start([{ text: "완료 화면이 보인다" }]);
    const [c] = s.session.activeRun.criteria;
    answers.push((await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_ORDER) })).text.split("\n")[0]);
    s.session.endTurn();
  }
  assert.ok(answers.some((a) => a.startsWith("[통과]")) && answers.some((a) => a.startsWith("[실패]")), `the planted page disagrees across runs: ${answers}`);
  const view = await s.session.view();
  assert.equal(view.report.criteria[0].status, "non_reproducible", JSON.stringify(view.report.criteria[0]));
  assert.notEqual(view.verification.state, "verified");
  // Control: the same three starts on a steady page stay pass and verified.
  const t = seat();
  for (let i = 0; i < 3; i++) {
    await t.session.start([{ text: "완료 화면이 보인다" }]);
    const [c] = t.session.activeRun.criteria;
    await t.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_ORDER) });
  }
  assert.equal((await t.session.view()).verification.state, "verified");
});

await test("CR-T76 negative: a later start with fewer criteria never hides an earlier fail on the same files", async () => {
  const s = seat({ page: kiosk({ noDone: true }) });
  await s.session.start([{ text: "음료 고르기가 보인다" }, { text: "완료 화면이 보인다" }]);
  const [c1, c2] = s.session.activeRun.criteria;
  await s.session.runTool({ criterion_id: c1.id, plan: PLAN(PLAN_START) });
  await s.session.runTool({ criterion_id: c2.id, plan: PLAN(PLAN_ORDER) });
  await s.session.start([{ text: "음료 고르기가 보인다" }]);
  const [d] = s.session.activeRun.criteria;
  await s.session.runTool({ criterion_id: d.id, plan: PLAN(PLAN_START) });
  const view = await s.session.view();
  assert.deepEqual(view.report.criteria.map((c) => c.status), ["pass"], "the latest report alone is all-pass");
  assert.equal(view.verification.state, "failed");
  assert.deepEqual(view.verification.open.map((o) => [o.text, o.status]), [["완료 화면이 보인다", "fail"]]);
});

await test("a fix request during a re-test is refused; a criterion stays not done when its result could not be recorded", async () => {
  const mode = { noDone: true };
  const s = seat({ page: kiosk(mode) });
  await s.session.start([{ text: "완료 화면이 보인다" }]);
  const [c] = s.session.activeRun.criteria;
  await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_ORDER) });
  mode.noDone = false;
  s.version.current = vid("b");
  const pending = s.session.retest();
  assert.equal(s.session.running, true);
  assert.deepEqual(await s.session.fix(c.id, "고쳐 주세요"), { ok: false, code: "busy" });
  await pending;
  const kinds = valid(s.recorder).events.filter((e) => e.artifact_after === "b".repeat(64)).map((e) => e.kind);
  assert.deepEqual(kinds, ["test_observed"], "no change_requested slipped in, so the re-test's pass is not retest_confirmed");
  // Control: once the re-test is done a fix request is taken (for a failed criterion).
  const t = seat({ page: kiosk({ noDone: true }) });
  await t.session.start([{ text: "완료 화면이 보인다" }]);
  const [d] = t.session.activeRun.criteria;
  await t.session.runTool({ criterion_id: d.id, plan: PLAN(PLAN_ORDER) });
  assert.equal((await t.session.fix(d.id, "고쳐 주세요")).ok, true);
  // A result the recorder would mangle (its secret scrub eats a JSON escape) is refused by
  // name, nothing binds it, and the criterion can still be tested.
  const page = makeFakePage({ elements: [{ key: "b", role: "button", name: "token:abcdefgh", tag: "button" }] });
  const u = seat({ page });
  await u.session.start([{ text: "버튼이 보인다" }]);
  const [e] = u.session.activeRun.criteria;
  const plan = PLAN({ steps: [], expect: [{ kind: "element", role: "button", name: "token:abcdefgh" }] });
  const before = u.recorder.batch.events.length;
  const bad = await u.session.runTool({ criterion_id: e.id, plan });
  assert.equal(bad.isError, true);
  assert.equal(u.recorder.batch.events.length, before, "refused before anything is written: no unreadable result in the record");
  assert.match(bad.text, /result_unreadable/);
  assert.equal(valid(u.recorder).events.filter((x) => x.kind === "test_observed").length, 0);
  assert.equal(u.recorder.batch.incomplete, undefined);
  assert.ok(u.session.activeRun?.criteria.some((x) => x.id === e.id), "the run is still open for the criterion");
  assert.match((await u.session.runTool({ criterion_id: e.id, plan: PLAN({ steps: [{ action: "reload" }], expect: [{ kind: "no_errors" }] }) })).text, /^\[통과\]/, "control: a plan whose result reads back is recorded");
});

await test("a long result fits under the recorder's text cap and the record stays complete", async () => {
  const long = (ch) => ch.repeat(290);
  const els = Array.from({ length: 6 }, (_, i) => ({ key: `t${i}`, role: "textbox", name: `${long("가")}${i}`, tag: "input" }));
  const page = makeFakePage({ elements: els, onLoad: (p) => { for (let i = 0; i < 30; i++) p.consoleError(`${long("오")} ${i}`); } });
  const s = seat({ page });
  await s.session.start(Array.from({ length: 5 }, (_, i) => ({ text: `${long("조")}${i}` })));
  const [c] = s.session.activeRun.criteria;
  const steps = Array.from({ length: 12 }, (_, i) => ({ action: "type", target: { role: "textbox", name: `${long("가")}${i % 6}` }, text: long("나") }));
  const expect = Array.from({ length: 6 }, (_, i) => ({ kind: "text", text: `${long("다")}${i}`, absent: true }));
  const a = await s.session.runTool({ criterion_id: c.id, plan: PLAN({ steps, expect }) });
  assert.equal(a.isError, false, a.text);
  const res = s.recorder.batch.events.filter((e) => e.kind === "tool_result").at(-1);
  assert.ok(res.text.length < 20_000, `result text ${res.text.length}`);
  assert.equal(s.recorder.batch.incomplete, undefined, "the seat's record is not marked incomplete");
  const view = await s.session.view();
  assert.equal(view.report.criteria.find((x) => x.id === c.id).status, "warning", "the verdict reads back");
});

await test("no_errors fails on an entry page that errors at load, with no steps; error records name the runner step", async () => {
  const errs = () => makeFakePage({ elements: [{ key: "begin", role: "button", name: "주문 시작", tag: "button" }], onLoad: (p) => p.consoleError("로드 중 오류") });
  const page = errs();
  const { ex } = executorFor(page);
  // The executor's step counter runs on across calls: run something first, so its counter is not the runner's.
  await runCriterionPlan(ex, PLAN_START, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  const out = await runCriterionPlan(ex, { steps: [], expect: [{ kind: "no_errors" }] }, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.equal(out.verdict.status, "fail", JSON.stringify(out.verdict));
  assert.ok(out.verdict.cites.some((c) => c.kind === "record" && c.detail === "console 단계 0: 로드 중 오류"), JSON.stringify(out.verdict.cites));
  assert.deepEqual(out.verdict.runtime_errors.map((e) => e.step), [0]);
  // A load error and then a navigate: two records, one per runner step.
  const nav = await runCriterionPlan(executorFor(errs()).ex, { steps: [{ action: "navigate", path: "/index.html?x=1" }], expect: [{ kind: "no_errors" }] }, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.equal(nav.verdict.status, "fail");
  assert.deepEqual(nav.verdict.runtime_errors.map((e) => e.step), [0, 1]);
  // Control: the same zero-step plan on a page with no error passes.
  assert.equal((await runCriterionPlan(executorFor(kiosk()).ex, { steps: [], expect: [{ kind: "no_errors" }] }, { startUrl: START, allowedOrigins: () => [ORIGIN] })).verdict.status, "pass");
});

await test("CR-T15: a snapshot cut at its line cap leaves an absent or missing text undecided, never pass", async () => {
  const many = Array.from({ length: 205 }, (_, i) => ({ key: `p${i}`, role: "heading", name: `항목 ${i}`, tag: "h3" }));
  const page = makeFakePage({ elements: [...many, { key: "err", role: "heading", name: "주문 오류가 발생했어요", tag: "h2" }] });
  const { ex } = executorFor(page);
  const out = await runCriterionPlan(ex, { steps: [], expect: [{ kind: "text", text: "주문 오류", absent: true }] }, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.equal(out.verdict.status, "not_verified", JSON.stringify(out.verdict.expectations));
  // A text that was read is still decided: present at the top of the long page.
  assert.equal((await runCriterionPlan(ex, { steps: [], expect: [{ kind: "text", text: "항목 3" }] }, { startUrl: START, allowedOrigins: () => [ORIGIN] })).verdict.status, "pass");
  // Control: a short page with the error text absent passes.
  assert.equal((await runCriterionPlan(executorFor(kiosk()).ex, { steps: [], expect: [{ kind: "text", text: "주문 오류", absent: true }] }, { startUrl: START, allowedOrigins: () => [ORIGIN] })).verdict.status, "pass");
});

// ── review round 3 (#1392): truncated targets, dropped records, held results, vacuous plans ──

await test("CR-T15: a step target past the snapshot's line cap is not verified, never fail", async () => {
  const many = Array.from({ length: 205 }, (_, i) => ({ key: `h${i}`, role: "heading", name: `메뉴 ${i}`, tag: "h3" }));
  const page = makeFakePage({
    elements: [...many, { key: "pay", role: "button", name: "주문하기", tag: "button", id: "pay" }],
    onClick: (p, key) => {
      if (key === "pay") p.state.elements = [{ key: "done", role: "heading", name: "주문이 완료되었어요", tag: "h2" }];
    },
  });
  const plan = { steps: [{ action: "click", target: { role: "button", name: "주문하기" } }], expect: [{ kind: "text", text: "주문이 완료되었어요" }] };
  const out = await runCriterionPlan(executorFor(page).ex, plan, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.equal(out.verdict.status, "not_verified", JSON.stringify(out.verdict.steps));
  assert.match(out.verdict.reason, /앞부분만 읽었어요/);
  // Control: a short page without the button is an observed failure of the step.
  const short = await runCriterionPlan(executorFor(kiosk()).ex, plan, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.equal(short.verdict.status, "fail", JSON.stringify(short.verdict.steps));
});

await test("CR-T15/CR-81: no_errors on a page whose event log dropped records is not verified, never pass", async () => {
  const noisy = (logs) => makeFakePage({
    elements: [{ key: "pay", role: "button", name: "주문하기", tag: "button", id: "pay" }],
    onLoad: (p) => {
      for (let i = 0; i < logs; i++) p.consoleLog(`log ${i}`);
    },
    onClick: (p, key) => {
      if (key === "pay") {
        p.consoleError("결제 처리 중 오류");
        p.state.elements = [{ key: "done", role: "heading", name: "주문이 완료되었어요", tag: "h2" }];
      }
    },
  });
  const click = [{ action: "click", target: { role: "button", name: "주문하기" } }];
  const opts = { startUrl: START, allowedOrigins: () => [ORIGIN] };
  const dropped = await runCriterionPlan(executorFor(noisy(100)).ex, { steps: click, expect: [{ kind: "no_errors" }] }, opts);
  assert.equal(dropped.verdict.status, "not_verified", JSON.stringify(dropped.verdict.expectations));
  assert.equal(dropped.verdict.expectations[0].ok, null);
  // Without a no_errors expectation, the unread error could have been a warning: not a pass.
  const quiet = await runCriterionPlan(executorFor(noisy(100)).ex, { steps: click, expect: [{ kind: "text", text: "주문이 완료되었어요" }] }, opts);
  assert.equal(quiet.verdict.status, "not_verified", JSON.stringify(quiet.verdict));
  assert.match(quiet.verdict.reason, /일부를 읽지 못했어요/);
  // Controls: with 10 logs the error is read: no_errors fails and the other plan warns.
  assert.equal((await runCriterionPlan(executorFor(noisy(10)).ex, { steps: click, expect: [{ kind: "no_errors" }] }, opts)).verdict.status, "fail");
  assert.equal((await runCriterionPlan(executorFor(noisy(10)).ex, { steps: click, expect: [{ kind: "text", text: "주문이 완료되었어요" }] }, opts)).verdict.status, "warning");
});

await test("CR-81, CR-16: an earlier fail on this version that a later run with the same words passed is shown with its fix action and re-tested", async () => {
  const s = seat({ page: kiosk({ noDone: true }) });
  const X = "주문하면 완료 화면이 보인다";
  await s.session.start([{ text: X }]);
  const [a] = s.session.activeRun.criteria;
  await s.session.runTool({ criterion_id: a.id, plan: PLAN(PLAN_ORDER) });
  s.session.endTurn();
  await s.session.start([{ text: X }]);
  const [b] = s.session.activeRun.criteria;
  await s.session.runTool({ criterion_id: b.id, plan: PLAN(PLAN_START) });
  const view = await s.session.view();
  assert.deepEqual(view.report.criteria.map((c) => [c.id, c.status]), [[b.id, "pass"]], "the latest report alone passes");
  assert.equal(view.verification.state, "failed");
  assert.deepEqual(view.held.map((c) => [c.id, c.status, !!c.test_ref]), [[a.id, "fail", true]], "the failing result is in the view, with its own row");
  // The held row is usable as a fix request.
  const fixed = await s.session.fix(a.id, "완료 화면이 나오게 해 주세요");
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  // A re-test runs the held criterion with its own (failing) plan, not the lenient one.
  const r = await s.session.retest();
  const again = (await s.session.view()).report;
  assert.equal(again.run_id, r.run_id);
  assert.deepEqual(again.criteria.map((c) => [c.id, c.status]), [[a.id, "fail"]]);
  // Control: with no earlier fail nothing is held.
  const t = seat();
  await t.session.start([{ text: X }]);
  await t.session.runTool({ criterion_id: t.session.activeRun.criteria[0].id, plan: PLAN(PLAN_ORDER) });
  const tv = await t.session.view();
  assert.equal(tv.verification.state, "verified");
  assert.deepEqual(tv.held, []);
});

await test("CR-T76 negative: a later start with fewer criteria never hides an earlier warning or not-verified result", async () => {
  const BEGIN = [{ key: "begin", role: "button", name: "주문 시작", tag: "button", id: "begin" }];
  const warnPage = () => makeFakePage({
    elements: [...BEGIN],
    onLoad: (p) => {
      p.state.elements = [...BEGIN];
    },
    onClick: (p, key) => {
      if (key === "begin") {
        p.consoleError("메뉴를 불러오지 못했어요");
        p.state.elements = [{ key: "drink", role: "combobox", name: "음료 고르기", tag: "select", options: [{ value: "tea", text: "아이스티" }] }];
      }
    },
  });
  const A = "제목이 보인다";
  const B = "주문 시작을 누르면 음료 고르기가 보인다";
  const PLAN_A = { steps: [{ action: "reload" }], expect: [{ kind: "element", role: "button", name: "주문 시작" }] };
  for (const [label, planB, expected] of [
    ["warning", PLAN_START, "warning"],
    ["not_verified", { ...PLAN_START, expect: [{ kind: "visual", question: "메뉴가 잘 보이나요?" }] }, "not_verified"],
  ]) {
    const s = seat({ page: warnPage() });
    await s.session.start([{ text: A }, { text: B }]);
    const [a, b] = s.session.activeRun.criteria;
    await s.session.runTool({ criterion_id: a.id, plan: PLAN(PLAN_A) });
    await s.session.runTool({ criterion_id: b.id, plan: PLAN(planB) });
    assert.equal((await s.session.view()).verification.state, "incomplete", label);
    await s.session.start([{ text: A }]);
    await s.session.runTool({ criterion_id: s.session.activeRun.criteria[0].id, plan: PLAN(PLAN_A) });
    const v = await s.session.view();
    assert.equal(v.verification.state, "incomplete", `${label}: the shorter start does not verify the version`);
    assert.deepEqual(v.verification.open.map((o) => [o.text, o.status]), [[B, expected]], label);
    // The re-test keeps the held criterion in the set.
    await s.session.retest();
    const rv = await s.session.view();
    assert.ok(rv.report.criteria.some((c) => c.id === b.id), `${label}: the re-test re-ran the held criterion`);
    assert.notEqual(rv.verification.state, "verified", label);
  }
  // Control: a later report that passes the same words clears an earlier not-verified result.
  const t = seat();
  await t.session.start([{ text: B }]);
  await t.session.runTool({ criterion_id: t.session.activeRun.criteria[0].id, plan: PLAN({ ...PLAN_START, expect: [{ kind: "visual", question: "잘 보이나요?" }] }) });
  await t.session.start([{ text: B }]);
  await t.session.runTool({ criterion_id: t.session.activeRun.criteria[0].id, plan: PLAN(PLAN_START) });
  assert.equal((await t.session.view()).verification.state, "verified", "a later pass of the same words clears a not-verified result");
});

await test("a plan with no steps that only expects an absence is refused (plan_untestable); a step or a positive expectation is accepted", async () => {
  const s = seat({ page: kiosk({ noDone: true }) });
  await s.session.start([{ text: "주문하기를 누르면 주문 완료 화면이 보인다" }]);
  const [c] = s.session.activeRun.criteria;
  const before = s.recorder.batch.events.length;
  for (const expect of [[{ kind: "no_errors" }], [{ kind: "text", text: "오류", absent: true }, { kind: "no_errors" }], [{ kind: "element", role: "button", name: "x", absent: true }]]) {
    const r = await s.session.runTool({ criterion_id: c.id, plan: PLAN({ steps: [], expect }) });
    assert.equal(r.isError, true);
    assert.match(r.text, /plan_untestable/);
  }
  assert.equal(s.recorder.batch.events.length, before, "nothing recorded");
  // Controls: a zero-step plan with a positive expectation, and a plan with a step, are taken.
  const { parsePlan } = await import("../../../worker/src/lib/measurement-core/verification.ts");
  assert.equal(parsePlan({ steps: [], expect: [{ kind: "element", role: "button", name: "주문 시작" }] }).ok, true);
  assert.equal(parsePlan({ steps: [{ action: "reload" }], expect: [{ kind: "no_errors" }] }).ok, true);
});

await test("a text expectation matches from a word start: '완료' does not match '미완료'", async () => {
  const page = (name) => makeFakePage({ elements: [{ key: "h", role: "heading", name, tag: "h2" }] });
  const plan = { steps: [], expect: [{ kind: "text", text: "완료" }] };
  const opts = { startUrl: START, allowedOrigins: () => [ORIGIN] };
  assert.equal((await runCriterionPlan(executorFor(page("주문이 아직 미완료 상태예요")).ex, plan, opts)).verdict.status, "fail");
  assert.equal((await runCriterionPlan(executorFor(page("incomplete")).ex, { steps: [], expect: [{ kind: "text", text: "complete" }] }, opts)).verdict.status, "fail");
  // Controls: a word start, with a Korean ending attached, and after punctuation.
  for (const name of ["주문 완료되었어요", "완료", "(완료)"]) assert.equal((await runCriterionPlan(executorFor(page(name)).ex, plan, opts)).verdict.status, "pass", name);
});

await test("a re-test holds its recorder until it ends and then lets it go (host release)", async () => {
  const mode = { noDone: true };
  const s = seat({ page: kiosk(mode) });
  await s.session.start([{ text: "완료 화면이 보인다" }]);
  await s.session.runTool({ criterion_id: s.session.activeRun.criteria[0].id, plan: PLAN(PLAN_ORDER) });
  let released = 0;
  const ports = Reflect.get(s.session, "ports");
  ports.release = () => released++;
  assert.equal(s.session.retestActive, false);
  const pending = s.session.retest();
  assert.equal(s.session.retestActive, true, "held from the click");
  await pending;
  assert.equal(s.session.retestActive, false);
  assert.equal(released, 1, "released once at the end");
});

// ── the host wiring the session relies on (chatPanelProvider.ts, ChatPanel) ──

const providerSrc = readFileSync(new URL("../src/chatPanelProvider.ts", import.meta.url), "utf8");
const WIRING = {
  // The turn's finally closes the run, so a later turn cannot test on its own.
  endTurn: /this\.activeStreams\.delete\(streamId\);\s*\/\/[^\n]*\n\s*this\.verifySession\?\.endTurn\(\);\s*this\.verifyTurnRecorder = null;/,
  // A send while a re-test drives the tab is refused before the turn starts.
  sendWhileRunning: /private async handleSend\([^)]*?\)[^{]*\{\s*\/\/[^\n]*\n\s*if \(this\.verifySession\?\.running\) \{\s*await this\.post\(\{type:"inputRejected",text,images\}\);[\s\S]{0,200}?return;\s*\}\s*this\.pendingSends\+\+;/,
  // Start, fix and re-test are refused while a turn streams (all three come after this line).
  verifyWhileTurn: /if \(this\.pendingSends > 0 \|\| this\.activeStreams\.size > 0\) return this\.postVerifyState\(\{ error: refusalText\("turn_running"\) \}\);\s*if \(msg\.type === "verifyStart"\)/,
  // The coach's verify calls write to the turn's own recorder.
  turnRecorder: /const observation = await this\.prepareObservation\(proxyUrl, token, profile\);\s*\/\/[^\n]*\n\s*this\.verifyTurnRecorder = observation\?\.batch\.format === 'hps-observation\/2' \? observation : null;/,
  turnRecorderFirst: /const recorder = \(retest \? this\.verifyRunRecorder : null\) \?\? this\.verifyTurnRecorder \?\? /,
  // A re-test holds its recorder; every other writer gets the same one until it ends (no lost writes).
  retestHeld: /await this\.observationWrites;\s*(?:\/\/[^\n]*\n\s*)*if \(this\.verifyRunRecorder && this\.verifySession\.retestActive\) return \(this\.nativeObservation = this\.verifyRunRecorder\);/,
  retestHolds: /if \(retest\) this\.verifyRunRecorder = recorder;/,
  retestRelease: /release: \(\) => \{ this\.verifyRunRecorder = null; \}/,
};
const wiringProblems = (src) => Object.entries(WIRING).filter(([, re]) => !re.test(src)).map(([k]) => k);

await test("host wiring: the turn's end closes the run, sends and verify actions wait for each other, verdicts go to the turn's recorder", async () => {
  assert.deepEqual(wiringProblems(providerSrc), []);
  // Each guard removed is caught.
  const planted = {
    endTurn: providerSrc.replace("this.verifySession?.endTurn();", ""),
    sendWhileRunning: providerSrc.replace("if (this.verifySession?.running) {", "if (false) {"),
    verifyWhileTurn: providerSrc.replace('if (this.pendingSends > 0 || this.activeStreams.size > 0) return this.postVerifyState({ error: refusalText("turn_running") });', ""),
    turnRecorder: providerSrc.replace("this.verifyTurnRecorder = observation?.batch.format", "void observation?.batch.format"),
    turnRecorderFirst: providerSrc.replace("const recorder = (retest ? this.verifyRunRecorder : null) ?? this.verifyTurnRecorder ?? ", "const recorder = "),
    retestHeld: providerSrc.replace("if (this.verifyRunRecorder && this.verifySession.retestActive) return (this.nativeObservation = this.verifyRunRecorder);", ""),
    retestHolds: providerSrc.replace("if (retest) this.verifyRunRecorder = recorder;", ""),
    retestRelease: providerSrc.replace("release: () => { this.verifyRunRecorder = null; },", ""),
  };
  for (const [name, src] of Object.entries(planted)) {
    assert.notEqual(src, providerSrc, `${name}: the plant changed the source`);
    assert.ok(wiringProblems(src).includes(name), `${name}: removing it is caught`);
  }
});

await test("the session's switch check refuses runTool on its own, with nothing recorded", async () => {
  const s = seat();
  await s.session.start([{ text: "음료 고르기가 보인다" }]);
  const [c] = s.session.activeRun.criteria;
  s.on.value = false;
  const before = s.recorder.batch.events.length;
  const calls = s.page.calls.length;
  const r = await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_START) });
  assert.equal(r.isError, true);
  assert.match(r.text, /쓸 수 없어요/);
  assert.equal(s.recorder.batch.events.length, before);
  assert.equal(s.page.calls.length, calls, "the tab was not touched");
  // Control: switched back on, the same open run is tested.
  s.on.value = true;
  assert.equal((await s.session.runTool({ criterion_id: c.id, plan: PLAN(PLAN_START) })).isError, false);
});

await test("the runner refuses an off-origin navigate on its own, with an executor that would allow anything", async () => {
  const seen = [];
  const permissive = {
    async execute(name, input) {
      seen.push([name, input?.url]);
      return { isError: false, content: [{ type: "text", text: "ok" }], observation: { url: START, route: "/index.html", title: "", snapshot: '[ref=e1] button "주문 시작"', refs: ["e1"], screenshot: { mimeType: "image/jpeg", data: "" }, viewport: { width: 800, height: 600 }, documentGeneration: "g1", records: [], droppedRecords: 0, step: 0, artifact: { id: vid("a"), entry: "index.html", files: [] } } };
    },
  };
  const out = await runCriterionPlan(permissive, { steps: [{ action: "navigate", path: "https://example.com/x" }], expect: [{ kind: "no_errors" }] }, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.equal(out.verdict.status, "not_verified");
  assert.deepEqual(seen, [["browser_navigate", START]], "only the entry page was asked for");
  // Control: a same-origin path goes to the executor.
  seen.length = 0;
  await runCriterionPlan(permissive, { steps: [{ action: "navigate", path: "/b.html" }], expect: [{ kind: "no_errors" }] }, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.deepEqual(seen.map((x) => x[1]), [START, `${ORIGIN}/b.html`]);
});

await test("no_errors reads every document the run visited, not only the last", async () => {
  const page = kiosk();
  const click = page.state.onClick;
  page.state.onClick = (p, key) => {
    click(p, key);
    if (key === "begin") p.consoleError("메뉴를 불러오지 못했어요");
  };
  const { ex } = executorFor(page);
  const plan = { steps: [{ action: "click", target: { role: "button", name: "주문 시작" } }, { action: "navigate", path: "/index.html?again=1" }], expect: [{ kind: "no_errors" }] };
  const out = await runCriterionPlan(ex, plan, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.equal(out.verdict.status, "fail", JSON.stringify(out.verdict.cites));
  assert.ok(out.verdict.cites.some((c) => /메뉴를 불러오지 못했어요/.test(c.detail)));
  // Control: the same plan on a page with no error passes.
  const clean = await runCriterionPlan(executorFor(kiosk()).ex, plan, { startUrl: START, allowedOrigins: () => [ORIGIN] });
  assert.equal(clean.verdict.status, "pass", JSON.stringify(clean.verdict.cites));
});

await test("recordChecked takes back a write the validator refuses; the batch stays valid", async () => {
  const recorder = new NativeObservationRecorder({ format: "hps-observation/2", scope: "synthetic-cr-verify", session: "s1", program: "p1" });
  const context = verifyContext({ task: "task-1" });
  recordChecked(recorder.batch, validateObservation, () => recorder.recordLearningEvent({ kind: "criterion_set", actor: "user", evidence_type: "criterion", source_state: "self_reported", student_text: "a", context }));
  const before = recorder.batch.events.length;
  assert.throws(() => recordChecked(recorder.batch, validateObservation, () => recorder.recordLearningEvent({ kind: "criterion_set", actor: "user", evidence_type: "criterion", source_state: "self_reported", student_text: "b", context: { ...context, step_id: "" } })));
  assert.equal(recorder.batch.events.length, before, "the refused event is gone");
  validateObservation(structuredClone(recorder.batch));
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
