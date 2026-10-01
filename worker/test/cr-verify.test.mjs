// AI Verify, measurement-core half (cr-verify #1392): the `hps-verification/1` report is a
// view over learning events on the one record (SX-48).
//
//   CR-T12 (unit)  1–5 criteria; an unconfirmed AI proposal never starts a run
//   CR-T13         the report validator, and its round trip through criterion_set /
//                  test_observed on a batch the one validator accepts; a store-inventory
//                  check catches a verify module that writes anywhere else
//   CR-T14 (unit)  the same criterion, version and viewport with differing verdicts is
//                  non-reproducible, never the pass of either run
//   CR-T15         every verdict cites an observation; uncited is "not verified"; a
//                  judgment written into the plan is refused (no vision verdict before
//                  anything was observed); element and text expectations read the
//                  snapshot's names and text, never its ref or role tokens
//   CR-T16 (unit)  a fix request carries report, criterion and version, or is refused; a
//                  pass after it is retest_confirmed and SX-15's gate confirms it
//   CR-T76 (unit)  "verified" only for an all-pass report bound to that exact version
//
// Every check has a positive control (must pass) and a planted negative (must be caught).
//
// Run: node --experimental-strip-types --test test/cr-verify.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const core = await import("../src/lib/measurement-core/index.ts");
const {
  validateObservation,
  observableAssets,
  gates,
  checkCriteria,
  parsePlan,
  evaluate,
  finalizeVerdict,
  verdictProblems,
  verifyResultText,
  readVerifyResult,
  verificationReport,
  validateVerificationReport,
  productVerification,
  buildFixRequest,
  testEventKind,
  outcomeOf,
  versionArtifactText,
  isVersionArtifact,
  runIds,
} = core;

const hex = (s) => createHash("sha256").update(s).digest("hex");
const V0 = `sha256:${hex("v0")}`;
const V1 = `sha256:${hex("v1")}`;
const CTX = { week: 2, step_id: "test-my-product", task: "task-1", module_version: "unversioned" };

/** A tiny recorder: assigns ids and seqs the way NativeObservationRecorder does, and validates every write. */
function recorder() {
  const b = { format: "hps-observation/2", scope: "synthetic-cr-verify", session: "s1", program: "p1", events: [] };
  let n = 0;
  const push = (e) => {
    const event = { id: `e${++n}`, seq: n, task: "task-1", at: 1_000 + n, text: "", assistance: "unknown", ...e };
    b.events.push(event);
    validateObservation(b);
    return event;
  };
  return {
    batch: b,
    criterion: (text, extra = {}) => push({ kind: "criterion_set", actor: "user", context: CTX, evidence_type: "criterion", source_state: "self_reported", student_text: text, ...extra }),
    /** One runner verdict, recorded exactly as VerifySession.execute does. */
    verdict({ run, criterion, version, verdict, plan = PLAN, kind, retest = false }) {
      const h = version.slice(7);
      const last = [...b.events].reverse().find((e) => e.kind === "artifact");
      if (last?.sha256 !== h) push({ kind: "artifact", text: versionArtifactText({ id: version, entry: "index.html", files: [] }), sha256: h });
      const tool_id = `verify-${run}-${criterion.id}`;
      push({ kind: "tool_request", text: "verify_criterion", tool_id, sha256: h });
      const result = push({
        kind: "tool_result",
        tool_id,
        outcome: "success",
        sha256: h,
        artifact_version: version,
        text: verifyResultText({ format: "hps-verify-result/1", run_id: run, criterion_id: criterion.id, criterion_text: criterion.student_text, artifact_version: version, tested_at: 5_000 + n, plan, verdict }),
      });
      return push({
        kind: kind ?? testEventKind(b.events, criterion.id, verdict.status, { retest, versionHex: h }),
        actor: "ai",
        context: CTX,
        evidence_type: "action",
        source_state: "real",
        criterion_ref: criterion.id,
        artifact_after: h,
        outcome: outcomeOf(verdict.status),
        result_ref: result.id,
      });
    },
    push,
  };
}

const PLAN = { steps: [{ action: "click", target: { role: "button", name: "주문 시작" } }], expect: [{ kind: "text", text: "음료 고르기" }] };
const SNAP = '[ref=e1] button "주문하기"\nheading: 주문이 완료되었어요\nStaticText: 장바구니: 2개';
const final = (over = {}) => ({ step: 1, snapshot: SNAP, route: "/index.html", errors: [], screenshot: null, viewport: { width: 800, height: 600 }, ...over });
const steps = [{ index: 0, action: "navigate", ok: true, message: "이동 완료" }, { index: 1, action: "click", ok: true, message: "클릭" }];
const pass = () => evaluate(final(), [{ kind: "text", text: "주문이 완료되었어요" }], steps);
const fail = () => evaluate(final(), [{ kind: "text", text: "결제 완료" }], steps);

// ── CR-T12 ───────────────────────────────────────────────────────────────────

test("CR-T12 positive: three student criteria are accepted, text kept verbatim", () => {
  const r = checkCriteria([{ text: "주문 시작을 누르면 음료 고르기가 보인다" }, { text: "수량을 늘리면 2가 된다" }, { text: "주문하기 뒤 완료 화면이 보인다" }]);
  assert.equal(r.ok, true);
  assert.equal(r.criteria.length, 3);
  assert.equal(r.criteria[0].adopted_from, undefined, "a student criterion carries no adopted_from");
});

test("CR-T12 negative: zero and six criteria are refused; an unconfirmed AI proposal never starts a run", () => {
  assert.deepEqual(checkCriteria([]), { ok: false, code: "criteria_count" });
  assert.deepEqual(checkCriteria(Array.from({ length: 6 }, (_, i) => ({ text: `조건 ${i}` }))), { ok: false, code: "criteria_count" });
  assert.deepEqual(checkCriteria([{ text: "a" }, { text: "b", proposed_by: "ai", confirmed: false, adopted_from: "e9" }]), { ok: false, code: "unconfirmed_ai_criterion" });
  assert.deepEqual(checkCriteria([{ text: "b", proposed_by: "ai", adopted_from: "e9" }]), { ok: false, code: "unconfirmed_ai_criterion" }, "confirmed absent = unconfirmed");
  assert.deepEqual(checkCriteria([{ text: "  " }]), { ok: false, code: "empty_criterion" });
  // Control: the same proposal, confirmed, is accepted and keeps where it came from.
  assert.deepEqual(checkCriteria([{ text: "b", proposed_by: "ai", confirmed: true, adopted_from: "e9" }]), { ok: true, criteria: [{ text: "b", adopted_from: "e9" }] });
});

// ── CR-T15 ───────────────────────────────────────────────────────────────────

test("CR-T15 positive: a pass cites a snapshot line, a fail cites the console record that decided it", () => {
  const p = pass();
  assert.equal(p.status, "pass");
  assert.ok(p.cites.some((c) => c.kind === "snapshot" && c.detail === "heading: 주문이 완료되었어요"));
  const errored = evaluate(final({ errors: [{ kind: "console", message: "수량 계산 실패", step: 3 }] }), [{ kind: "no_errors" }], steps);
  assert.equal(errored.status, "fail");
  assert.ok(errored.cites.some((c) => c.kind === "record" && /수량 계산 실패/.test(c.detail)));
  // Errors without a no_errors expectation: the criterion held, with a warning that cites them.
  const warned = evaluate(final({ errors: [{ kind: "exception", message: "boom", step: 2 }] }), [{ kind: "text", text: "장바구니: 2개" }], steps);
  assert.equal(warned.status, "warning");
  assert.ok(warned.cites.some((c) => c.kind === "record" && /boom/.test(c.detail)));
  assert.deepEqual(verdictProblems(p), []);
});

test("CR-T15 negative: an uncited verdict is not verified; a judgment the coach wrote into the plan never decides", () => {
  const stripped = finalizeVerdict({ ...pass(), cites: [] });
  assert.equal(stripped.status, "not_verified", "a pass with its citations removed is not a pass");
  assert.equal(finalizeVerdict({ ...fail(), cites: [] }).status, "not_verified", "nor is an uncited fail");
  // A judgment in the plan is made before the page is observed: refused, labelled or not.
  for (const planted of [{ judgment: "pass", method: "vision" }, { judgment: "pass" }, { judgment: "fail", method: "vision" }, { method: "vision" }]) {
    assert.deepEqual(parsePlan({ steps: [], expect: [{ kind: "visual", question: "완료 화면이 보이나요?", ...planted }] }), { ok: false, code: "plan_judgment" }, JSON.stringify(planted));
  }
  // Even a judgment smuggled past the parser is not read: the runner has no vision step,
  // so a visual expectation stays undecided with a screenshot stored, and the verdict is dom.
  const smuggled = evaluate(final({ screenshot: `sha256:${hex("shot")}` }), [{ kind: "visual", question: "완료 화면이 보이나요?", judgment: "pass", method: "vision" }], steps);
  assert.equal(smuggled.status, "not_verified");
  assert.equal(smuggled.method, "dom");
  // Control: the question alone parses, and stays not verified.
  const asked = parsePlan({ steps: [], expect: [{ kind: "visual", question: "예쁜가" }] });
  assert.equal(asked.ok, true);
  assert.equal(evaluate(final({ screenshot: `sha256:${hex("shot")}` }), asked.plan.expect, steps).status, "not_verified");
  // A stored verdict that decided a visual expectation but says "dom" is refused on read.
  assert.deepEqual(verdictProblems({ ...pass(), expectations: [{ kind: "visual", ok: true, detail: "x" }] }), ["unlabelled_vision"]);
});

test("CR-T15: element expectations match text roles; text expectations never match ref or role tokens", () => {
  // Positive: a heading (a text role, no ref) is found by role and name.
  const heading = evaluate(final(), [{ kind: "element", role: "heading", name: "주문이 완료되었어요" }], steps);
  assert.equal(heading.status, "pass", JSON.stringify(heading.expectations));
  assert.ok(heading.cites.some((c) => c.detail === "heading: 주문이 완료되었어요"));
  assert.equal(evaluate(final(), [{ kind: "element", role: "heading", name: "주문이 완료되었어요", absent: true }], steps).status, "fail", "absent is the opposite");
  assert.equal(evaluate(final(), [{ kind: "element", role: "heading", name: "없는 제목" }], steps).status, "fail");
  // Negative: the snapshot's own tokens ("ref", "button", "heading") are not page text.
  for (const token of ["button", "ref=e1", "heading"]) assert.equal(evaluate(final(), [{ kind: "text", text: token }], steps).status, "fail", token);
  // Control: an accessible name and a text line are page text.
  assert.equal(evaluate(final(), [{ kind: "text", text: "주문하기" }], steps).status, "pass");
  assert.equal(evaluate(final(), [{ kind: "text", text: "장바구니: 2개" }], steps).status, "pass");
});

// ── CR-T13 ───────────────────────────────────────────────────────────────────

test("CR-T13 positive: a report with the PRD §6 fields plus steps round-trips through criterion_set / test_observed", () => {
  const r = recorder();
  const c1 = r.criterion("완료 화면이 보인다");
  const c2 = r.criterion("결제 완료가 보인다");
  r.verdict({ run: "run-1", criterion: c1, version: V0, verdict: pass() });
  r.verdict({ run: "run-1", criterion: c2, version: V0, verdict: fail() });
  // The batch the one validator accepts is the only thing stored.
  const { batch } = validateObservation(structuredClone(r.batch));
  const report = verificationReport(batch.events, "run-1");
  assert.deepEqual(validateVerificationReport(report), []);
  assert.equal(report.artifact_version_id, V0);
  assert.ok(!Number.isNaN(Date.parse(report.tested_at)));
  assert.deepEqual(report.criteria.map((c) => [c.text, c.status]), [["완료 화면이 보인다", "pass"], ["결제 완료가 보인다", "fail"]]);
  for (const k of ["runtime_errors", "network_errors", "screenshots", "steps"]) assert.ok(Array.isArray(report[k]), k);
  assert.ok(report.steps.length >= 4, "the browser steps of both criteria");
  assert.deepEqual(runIds(batch.events), ["run-1"]);
  // A verdict with no test event binding it is not part of any report.
  const orphan = recorder();
  const oc = orphan.criterion("x");
  orphan.push({ kind: "tool_request", text: "verify_criterion", tool_id: "t" });
  orphan.push({ kind: "tool_result", tool_id: "t", outcome: "success", artifact_version: V0, text: verifyResultText({ format: "hps-verify-result/1", run_id: "lone", criterion_id: oc.id, criterion_text: "x", artifact_version: V0, tested_at: 1, plan: PLAN, verdict: pass() }) });
  assert.equal(verificationReport(orphan.batch.events, "lone"), null);
});

test("CR-T13 negative: a report missing artifact_version_id, tested_at or steps is refused", () => {
  const r = recorder();
  const c = r.criterion("완료 화면이 보인다");
  r.verdict({ run: "run-1", criterion: c, version: V0, verdict: pass() });
  const report = verificationReport(r.batch.events, "run-1");
  for (const [field, code] of [["artifact_version_id", "missing_artifact_version_id"], ["tested_at", "missing_tested_at"], ["steps", "missing_steps"]]) {
    const { [field]: _gone, ...rest } = report;
    assert.ok(validateVerificationReport(rest).includes(code), `${field} removed is refused with ${code}`);
  }
  assert.ok(validateVerificationReport({ ...report, criteria: [] }).includes("invalid_criteria"));
  assert.throws(() => verifyResultText({ ...readVerifyResult(r.batch.events.find((e) => e.kind === "tool_result")), artifact_version: "nope" }), /missing_artifact_version/);
});

/** Ways a module could keep a report somewhere other than the record's events. */
const STORE_CALL = /\b(?:CREATE TABLE|\.prepare\(|HPS_(?:KV|DB|TRACES)|workspaceState|globalState|localStorage|writeFile(?:Sync)?\(|appendFile|putBlob\(|\.put\(|indexedDB)/;
const storeHits = (src) => src.split("\n").filter((l) => !/^\s*(?:\/\/|\*)/.test(l) && STORE_CALL.test(l));

test("CR-T13 store inventory: the verify modules write nowhere but the record they are handed (SX-48)", () => {
  const files = [
    new URL("../src/lib/measurement-core/verification.ts", import.meta.url),
    new URL("../../extensions/hypeproof-chat/src/verifyRunner.ts", import.meta.url),
    new URL("../../extensions/hypeproof-chat/src/verifySession.ts", import.meta.url),
    new URL("../../extensions/hypeproof-chat/src/verifyView.ts", import.meta.url),
  ];
  for (const f of files) assert.deepEqual(storeHits(readFileSync(f, "utf8")), [], `${f.pathname} keeps a store of its own`);
  // Negative control: each planted store is caught by the same scan.
  for (const planted of ['await this.context.workspaceState.update("hps.verify.report", report);', 'env.HPS_DB.prepare("INSERT INTO verification_reports VALUES (?)")', "await env.HPS_KV.put(`verify:${id}`, json);", 'fs.writeFileSync("report.json", text);']) {
    assert.equal(storeHits(planted).length, 1, planted);
  }
});

test("version-artifact events are not revisions: observableAssets counts the same as without them", () => {
  const r = recorder();
  r.push({ kind: "artifact", text: "index.html\n<html>", sha256: hex("index") });
  r.push({ kind: "artifact", text: versionArtifactText({ id: V0, entry: "index.html", files: [] }), sha256: V0.slice(7) });
  assert.equal(isVersionArtifact(r.batch.events[1]), true);
  assert.equal(isVersionArtifact(r.batch.events[0]), false);
  const withVersions = observableAssets(r.batch, "candidate-capability-v1");
  assert.ok(!withVersions.includes("ADAPT"), "one file write plus one verified version is not two revisions");
  // Control: a second real file revision does count.
  r.push({ kind: "artifact", text: "index.html\n<html>2", sha256: hex("index2") });
  assert.ok(observableAssets(r.batch, "candidate-capability-v1").includes("ADAPT"));
});

// ── CR-T14 ───────────────────────────────────────────────────────────────────

test("CR-T14 positive: two runs on the same version and viewport with the same verdicts are reproducible", () => {
  const r = recorder();
  const cs = ["a", "b", "c"].map((t) => r.criterion(t));
  for (const run of ["run-1", "run-2"]) for (const c of cs) r.verdict({ run, criterion: c, version: V0, verdict: c.student_text === "c" ? fail() : pass() });
  const a = verificationReport(r.batch.events, "run-1");
  const b = verificationReport(r.batch.events, "run-2");
  assert.deepEqual(a.criteria.map((c) => c.status), ["pass", "pass", "fail"]);
  assert.deepEqual(b.criteria.map((c) => c.status), a.criteria.map((c) => c.status));
  assert.ok(b.criteria.every((c) => c.reproducible));
});

test("CR-T14 negative: a criterion whose verdict differs between runs is non-reproducible, never pass", () => {
  const r = recorder();
  const c = r.criterion("주문하기 뒤 완료 화면이 보인다");
  r.verdict({ run: "run-1", criterion: c, version: V0, verdict: pass() });
  r.verdict({ run: "run-2", criterion: c, version: V0, verdict: fail() });
  for (const run of ["run-1", "run-2"]) {
    const crit = verificationReport(r.batch.events, run).criteria[0];
    assert.equal(crit.status, "non_reproducible", `${run} is not reported as its own verdict`);
    assert.equal(crit.reproducible, false);
  }
  // Control: another viewport is another condition, so it is not compared.
  const r2 = recorder();
  const c2 = r2.criterion("x");
  r2.verdict({ run: "run-1", criterion: c2, version: V0, verdict: pass() });
  r2.verdict({ run: "run-2", criterion: c2, version: V0, verdict: { ...fail(), viewport: { width: 390, height: 844 } } });
  assert.equal(verificationReport(r2.batch.events, "run-1").criteria[0].status, "pass");
  // Control: another plan is another test, so it is not compared either.
  const r3 = recorder();
  const c3 = r3.criterion("x");
  r3.verdict({ run: "run-1", criterion: c3, version: V0, verdict: fail(), plan: { ...PLAN, expect: [{ kind: "text", text: "음료 고르기!" }] } });
  r3.verdict({ run: "run-2", criterion: c3, version: V0, verdict: pass() });
  assert.equal(verificationReport(r3.batch.events, "run-2").criteria[0].status, "pass");
});

test("CR-T14: one row per criterion per run, the last verdict, so repeated calls never overflow the report", () => {
  const r = recorder();
  const cs = ["a", "b", "c", "d", "e"].map((t) => r.criterion(t));
  for (const c of cs) {
    r.verdict({ run: "run-1", criterion: c, version: V0, verdict: fail() });
    r.verdict({ run: "run-1", criterion: c, version: V0, verdict: pass() });
  }
  const report = verificationReport(r.batch.events, "run-1");
  assert.equal(report.criteria.length, 5);
  assert.deepEqual(validateVerificationReport(report), []);
  assert.ok(report.criteria.every((c) => c.status === "pass" && c.reproducible), "rows of one run are not compared with each other");
});

// ── CR-T16 ───────────────────────────────────────────────────────────────────

test("CR-T16 positive: a fix request carries report, criterion and version; a pass after it is retest_confirmed and SX-15 confirms", () => {
  const r = recorder();
  const c1 = r.criterion("완료 화면이 보인다");
  const c2 = r.criterion("결제 완료가 보인다");
  r.verdict({ run: "run-1", criterion: c1, version: V0, verdict: pass() });
  const failed = r.verdict({ run: "run-1", criterion: c2, version: V0, verdict: fail() });
  const report = verificationReport(r.batch.events, "run-1");
  const built = buildFixRequest({ report, criterion_id: c2.id, version: V0, student_text: "결제 완료 문구가 나오게 고쳐 주세요" });
  assert.equal(built.ok, true);
  assert.match(built.request.coach_text, /hps-fix-request\/1/);
  const ctx = JSON.parse(built.request.coach_text.slice(built.request.coach_text.indexOf("{")));
  assert.equal(ctx.report, "run-1");
  assert.equal(ctx.criterion.id, c2.id);
  assert.equal(ctx.artifact_version, V0);
  assert.ok(ctx.steps.length && ctx.observation.length, "steps and the observation that decided it");
  assert.equal(built.request.event.turn_ref, failed.id);
  r.push({ ...built.request.event, actor: "user", context: CTX, evidence_type: "change", source_state: "self_reported" });
  // The coach fixes the file; the re-test runs criterion 2 on v1 and passes.
  r.push({ kind: "artifact", text: "index.html\n<html>fixed", sha256: hex("fixed-file") });
  const retest = r.verdict({ run: "run-2", criterion: c2, version: V1, retest: true, verdict: { ...pass(), cites: [{ step: 1, kind: "snapshot", detail: "heading: 결제 완료" }] } });
  assert.equal(retest.kind, "retest_confirmed");
  assert.equal(gates({ events: r.batch.events }).verification.state, "confirmed");
  assert.equal(gates({ events: r.batch.events }).verification.source_state, "real", "bound to an executed result on that version");
});

test("CR-T16 negative: a fix request without report, criterion or version is refused, never free text", () => {
  const r = recorder();
  const c = r.criterion("결제 완료가 보인다");
  r.verdict({ run: "run-1", criterion: c, version: V0, verdict: fail() });
  const report = verificationReport(r.batch.events, "run-1");
  const base = { report, criterion_id: c.id, version: V0, student_text: "고쳐 주세요" };
  assert.deepEqual(buildFixRequest({ ...base, report: null }), { ok: false, code: "missing_report_ref" });
  assert.deepEqual(buildFixRequest({ ...base, report: { ...report, run_id: "" } }), { ok: false, code: "missing_report_ref" });
  assert.deepEqual(buildFixRequest({ ...base, criterion_id: null }), { ok: false, code: "missing_criterion_ref" });
  assert.deepEqual(buildFixRequest({ ...base, version: null }), { ok: false, code: "missing_version_ref" });
  assert.deepEqual(buildFixRequest({ ...base, version: V1 }), { ok: false, code: "version_mismatch" });
  assert.deepEqual(buildFixRequest({ ...base, student_text: " " }), { ok: false, code: "missing_student_text" });
  // A pass that comes with no fix request in between stays test_observed.
  assert.equal(testEventKind(r.batch.events, c.id, "pass", { retest: true, versionHex: V1.slice(7) }), "test_observed");
  r.push({ kind: "change_requested", actor: "user", context: CTX, evidence_type: "change", source_state: "self_reported", student_text: "고쳐 주세요", criterion_ref: c.id, artifact_before: V0.slice(7), turn_ref: report.criteria[0].test_ref });
  // After the fix request: the coach's own check is never the student's re-test, and a
  // pass on the very version that failed is not a fix.
  assert.equal(testEventKind(r.batch.events, c.id, "pass", { retest: false, versionHex: V1.slice(7) }), "test_observed");
  assert.equal(testEventKind(r.batch.events, c.id, "pass", { retest: true, versionHex: V0.slice(7) }), "test_observed");
  // Control: the student's re-test on another version.
  assert.equal(testEventKind(r.batch.events, c.id, "pass", { retest: true, versionHex: V1.slice(7) }), "retest_confirmed");
});

// ── CR-T76 ───────────────────────────────────────────────────────────────────

test("CR-T76 positive: three passes on a version show verified; a fail shows the fail", () => {
  const r = recorder();
  const cs = ["a", "b", "c"].map((t) => r.criterion(t));
  for (const c of cs) r.verdict({ run: "run-1", criterion: c, version: V0, verdict: pass() });
  assert.equal(productVerification(r.batch.events, V0).state, "verified");
  // A later run on the same version with a failing criterion: the latest report shows the fail.
  // (Re-running criterion b with a different verdict would be CR-14's non-reproducible instead.)
  const d = r.criterion("d");
  r.verdict({ run: "run-2", criterion: d, version: V0, verdict: fail() });
  const now = productVerification(r.batch.events, V0);
  assert.equal(now.state, "failed");
  assert.deepEqual(now.open.map((o) => o.id), [d.id]);
  r.verdict({ run: "run-3", criterion: cs[1], version: V0, verdict: fail() });
  assert.equal(productVerification(r.batch.events, V0).state, "incomplete", "control: a flip on an unchanged criterion is non-reproducible, never verified");
});

test("CR-T76 negative: no report, a report of another version, or a coach saying 완료했어요 all stay not verified", () => {
  const r = recorder();
  assert.equal(productVerification(r.batch.events, V0).state, "not_verified", "no report");
  const c = r.criterion("a");
  r.verdict({ run: "run-1", criterion: c, version: V0, verdict: pass() });
  const other = productVerification(r.batch.events, V1);
  assert.notEqual(other.state, "verified", "a report bound to another version");
  assert.equal(other.state, "needs_recheck");
  assert.deepEqual(other.previous, { run_id: "run-1", artifact_version_id: V0 }, "AE-37: the earlier report is kept");
  r.push({ kind: "coach", text: "완료했어요! 모든 기능이 잘 동작합니다." });
  r.push({ kind: "tool_request", text: "Bash(npm run build)", tool_id: "b1" });
  r.push({ kind: "tool_result", text: "build ok", tool_id: "b1", outcome: "success" });
  assert.notEqual(productVerification(r.batch.events, V1).state, "verified", "a coach message and a green build never set verified");
  assert.equal(productVerification(r.batch.events, null).state, "needs_recheck", "an unknown current version is never verified");
});
