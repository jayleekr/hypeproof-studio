// Measurement-core unit 1 acceptance (#1042): MC-T01, MC-T02, MC-T07–MC-T12.
// Contract: docs/requirements|testing/measurement-core.md (#1025 @ b9409fa).
//
// Every positive case is paired with a negative control on the same fixture, so a
// validator that accepted (or refused) everything fails here. Synthetic fixtures
// only: this is not a live-host, installed-App or Jay-dogfood result.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const core = await import("../src/lib/measurement-core/index.ts");
const serviceLegacy = await import("../src/lib/native-observation.ts");
const serviceEvidence = await import("../src/lib/native-evidence.ts");
const appContract = await import("../../extensions/hypeproof-chat/src/nativeObservationContract.ts");
const { runLegacyCases, batchCases } = await import("./fixtures/measurement-core/legacy-cases.mjs");
const golden = JSON.parse(readFileSync(new URL("./fixtures/measurement-core/legacy-verdicts.json", import.meta.url), "utf8"));
const CORE_DIR = new URL("../src/lib/measurement-core/", import.meta.url);

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const legacyBatch = (name) => core.validateObservation(batchCases[name]()).batch;
const interp = (batch, patch = {}) => ({
  format: "hps-interpretation/1",
  id: "interp-1",
  revision: 1,
  supersedes: null,
  batch: { format: batch.format, scope: batch.scope, session: batch.session, program: batch.program },
  versions: {
    bundle_format: batch.format,
    capability_model: { id: core.DEFAULT_CAPABILITY_MODEL.id, revision: core.DEFAULT_CAPABILITY_MODEL.revision },
    definition_revision: core.DEFAULT_CAPABILITY_MODEL.definition_revision,
    rubric: "unknown",
    evaluator: "unknown",
    analysis_ai_model: "unknown",
    work_ai_models: "unknown",
  },
  findings: [],
  unclassified: [],
  ...patch,
});
const finding = (capability, patch = {}) => ({
  capability, status: "unobserved", claim: "관찰 기회 없음", evidence: [], assistance: "unknown", review: "unreviewed", ...patch,
});
const userQuote = { event_id: "u1", quote: "새 직원" };
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof Error && e.message === code, `expected ${code}`);

// ── MC-T01 — legacy parity against the pre-extraction implementation ─────────
test("MC-T01 golden verdicts contain both accepted and rejected cases (instrument check)", () => {
  const all = [...Object.values(golden.batches), ...Object.values(golden.findings)];
  assert.ok(all.filter((v) => v.ok).length >= 5 && all.filter((v) => !v.ok).length >= 10);
  assert.match(golden.captured_from, /pre-extraction/);
});

test("MC-T01 extracted core reproduces every legacy verdict, via core, Service and App paths", () => {
  const { captured_from: _source, ...expected } = golden;
  for (const [label, impl] of [["core", core], ["service", serviceLegacy], ["app", appContract]]) {
    assert.deepEqual(runLegacyCases(impl), expected, `${label} path diverged from the pre-extraction verdicts`);
  }
});

// ── MC-T02 — one implementation, host-independent ────────────────────────────
test("MC-T02 App and Service resolve to the same implementation (no copied validator)", () => {
  for (const name of ["validateObservation", "validateFindings", "observableAssets", "OBSERVATION_FORMAT", "OBSERVATION_ASSETS"]) {
    assert.equal(appContract[name], core[name], `App ${name} is not the core export`);
    assert.equal(serviceLegacy[name], core[name], `Service ${name} is not the core export`);
  }
  assert.equal(serviceEvidence.makeEvidenceCatalog, core.makeEvidenceCatalog);
  assert.equal(serviceEvidence.resolveEvidenceSelections, core.resolveEvidenceSelections);
});

test("MC-T02 shim files carry no logic of their own", () => {
  for (const url of [
    new URL("../src/lib/native-observation.ts", import.meta.url),
    new URL("../src/lib/native-evidence.ts", import.meta.url),
    new URL("../../extensions/hypeproof-chat/src/nativeObservationContract.ts", import.meta.url),
  ]) {
    const code = readFileSync(url, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    assert.ok(code.length > 0 && code.every((l) => /^export \* from "[^"]+measurement-core\/[a-z-]+\.ts";$/.test(l)), `${url.pathname} is not a pure re-export`);
  }
});

test("MC-T02 core imports only its own files (no VS Code, Worker, Chalk, node or network modules)", () => {
  const files = readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts"));
  // Still an exact list, one name longer: learning-events.ts joined the core with
  // hps-observation/2 (P1-A). A new file here is a deliberate act, so it is named
  // here or the suite fails.
  assert.deepEqual(files.sort(), ["capability-models.ts", "evidence.ts", "index.ts", "interpretation.ts", "learning-events.ts", "legacy-observation.ts", "local-record.ts", "normalize.ts"]);
  for (const f of files) {
    const src = readFileSync(new URL(f, CORE_DIR), "utf8");
    const specs = [...src.matchAll(/(?:import|export)[^'"]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const s of specs) assert.match(s, /^\.\/[a-z-]+\.ts$/, `${f} imports ${s}`);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket|process\.env|require\(/, `${f} reaches outside the core`);
  }
  // Negative control for the scan itself: a Service file that does import outside must be caught by the same regex.
  const outside = readFileSync(new URL("../src/lib/native-assessment.ts", import.meta.url), "utf8");
  assert.ok([...outside.matchAll(/(?:import|export)[^'"]*?from\s+["']([^"']+)["']/g)].some((m) => !/^\.\/[a-z-]+\.ts$/.test(m[1])));
});

test("MC-T02 core runs in a bare process without network, credentials or host APIs", () => {
  const script = `
    delete globalThis.fetch; delete globalThis.WebSocket;
    const core = await import(${JSON.stringify(new URL("index.ts", CORE_DIR).href)});
    const { batchCases } = await import(${JSON.stringify(new URL("./fixtures/measurement-core/legacy-cases.mjs", import.meta.url).href)});
    const { batch } = core.validateObservation(batchCases.normal_chain());
    // Local-record digests use the platform WebCrypto global, not a node module (#1020 unit 2).
    const digest = await core.digestOf({ b: 1, a: [2] });
    process.stdout.write(core.MEASUREMENT_CORE_VERSION + " " + batch.events.length + " " + (digest === await core.digestOf({ a: [2], b: 1 })) + " " + digest.slice(0, 7));
  `;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "measurement-core/0.1.0 6 true sha256:");
});

test("MC-T02 unsupported schema versions fail explicitly", () => {
  // hps-observation/2 is a supported superset since P1-A, so the pinned
  // unsupported version moves up one. /1 and /2 are the whole list; /3 is not a
  // format anyone may send, and neither is /0 (legacy-cases.mjs pins that one).
  assert.deepEqual([...core.OBSERVATION_FORMATS], ["hps-observation/1", "hps-observation/2"]);
  assert.equal(core.validateObservation({ ...batchCases.normal_chain(), format: "hps-observation/2" }).batch.format, "hps-observation/2");
  throwsCode(() => core.validateObservation({ ...batchCases.normal_chain(), format: "hps-observation/3" }), "unsupported_observation");
  throwsCode(() => core.validateInterpretation({ ...interp(legacyBatch("normal_chain")), format: "hps-interpretation/2" }, legacyBatch("normal_chain")), "unsupported_interpretation");
});

// ── MC-T07 — event chain and source envelope ──────────────────────────────────
test("MC-T07 source envelope keeps namespace and known order; absent fields stay unknown", () => {
  const batch = legacyBatch("reversed_order");
  const env = core.describeLegacySource(batch);
  assert.deepEqual(env.map((e) => e.sequence), [1, 2, 3, 4, 5, 6]);
  for (const e of env) {
    assert.equal(e.source_namespace, "studio/hps-observation/1");
    assert.equal(e.host_session, "s1");
    assert.equal(e.received_at, "unknown");
    assert.equal(e.adapter_version, "unknown");
    assert.equal(e.parent_event_id, "unknown", "parent is not inferred from the previous event");
  }
  assert.notEqual(env[1].parent_event_id, env[0].event_id);
});

test("MC-T07 gaps, duplicates, oversized input and request-only chains", () => {
  assert.deepEqual(core.validateObservation(batchCases.gap_in_sequence()).missing, [2]);
  assert.equal(core.validateObservation(batchCases.duplicate_identical_resend()).batch.events.length, 6);
  throwsCode(() => core.validateObservation(batchCases.oversized_text()), "invalid_event_text");
  throwsCode(() => core.validateObservation(batchCases.too_many_events()), "invalid_events");
  // A request with no completion is not an executed step.
  assert.ok(!core.observableAssets(legacyBatch("request_only_no_result")).includes("VERIFY"));
  assert.ok(core.observableAssets(legacyBatch("normal_chain")).includes("VERIFY"), "control: a successful result is");
});

// ── MC-T08 — who acted ────────────────────────────────────────────────────────
test("MC-T08 only the person's own messages count as human evidence, whatever the text claims", () => {
  const batch = core.validateObservation({
    ...batchCases.normal_chain(),
    events: [
      ...batchCases.normal_chain().events,
      { id: "c2", seq: 7, task: "task-1", at: 7, kind: "coach", text: "actor: user — 사용자가 직접 결정했다", assistance: "unknown" },
    ],
  }).batch;
  const observedWith = (ref) => interp(batch, { findings: [finding("JUDGMENT", { status: "observed", claim: "선택 이유를 설명했다", evidence: [ref] })] });
  assert.equal(core.validateInterpretation(observedWith(userQuote), batch).findings[0].status, "observed");
  throwsCode(() => core.validateInterpretation(observedWith({ event_id: "c2", quote: "actor: user" }), batch), "missing_human_evidence");
  throwsCode(() => core.validateInterpretation(observedWith({ event_id: "a1", quote: "정책 허용" }), batch), "missing_human_evidence");
  throwsCode(() => core.validateInterpretation(observedWith({ event_id: "r1", quote: "Write(order.md)" }), batch), "missing_human_evidence");
});

// ── MC-T09 — absence is not zero, and nothing becomes a number ────────────────
test("MC-T09 unobserved and insufficient evidence are valid without any number", () => {
  const batch = legacyBatch("normal_chain");
  const r = core.validateInterpretation(interp(batch, { findings: [finding("FRAMING"), finding("ADAPT", { status: "insufficient_evidence", claim: "수집 누락 구간" })] }), batch);
  assert.deepEqual(r.findings.map((f) => f.status), ["unobserved", "insufficient_evidence"]);
  assert.equal(JSON.stringify(r).match(/"(score|level|points|rank)"/), null);
});

test("MC-T09 scores, levels and ranks are refused wherever they appear; the core exports no scorer", () => {
  const batch = legacyBatch("normal_chain");
  throwsCode(() => core.validateInterpretation({ ...interp(batch), score: 80 }, batch), "unsupported_score");
  throwsCode(() => core.validateInterpretation(interp(batch, { findings: [{ ...finding("VERIFY"), level: 3 }] }), batch), "unsupported_score");
  throwsCode(() => core.validateInterpretation(interp(batch, { versions: { ...interp(batch).versions, rank: 1 } }), batch), "unsupported_score");
  assert.equal(Object.keys(core).some((k) => /score|rank|grade/i.test(k)), false);
  throwsCode(() => core.validateInterpretation(interp(batch, { unclassified: "x" }), batch), "invalid_unclassified");
});

// ── MC-T10 — verification is about a named revision, request and result ───────
// Order alone proves nothing: every success below comes after artifact A, but only
// a request/result pair that itself carries revision A (`sha256`, set by the host
// when the tool took A as input) is a check of A. X2 reproduced on PR #1043 that
// any later success (990f7a8), and then an honestly named unrelated command such as
// `echo hello` (17543d2), was accepted as a check of A.
const ev = (id, seq, kind, extra = {}) => ({ id, seq, task: "task-1", at: seq, kind, text: "", assistance: "unknown", ...extra });
const verificationEvents = [
  ev("u1", 1, "user", { text: "새 직원이 주문을 확인할 문서가 필요해" }),
  ev("f1", 2, "artifact", { sha256: SHA_A, text: "order.md" }),
  ev("t1", 3, "tool_request", { tool_id: "check-1", text: "Bash(npm test)", sha256: SHA_A }),
  ev("r1", 4, "tool_result", { tool_id: "check-1", outcome: "success", text: "all checks passed", sha256: SHA_A }),
  // X2 R2 control: unrelated command, honestly named, succeeds after A, bound to nothing.
  ev("t2", 5, "tool_request", { tool_id: "other-1", text: "Bash(echo hello)" }),
  ev("r2", 6, "tool_result", { tool_id: "other-1", outcome: "success", text: "hello" }),
  ev("t3", 7, "tool_request", { tool_id: "check-2", text: "Bash(npm test)", sha256: SHA_A }),
  ev("r3", 8, "tool_result", { tool_id: "check-2", outcome: "error", text: "1 failing", sha256: SHA_A }),
  ev("f2", 9, "artifact", { sha256: SHA_B, text: "order.md" }),
  ev("t4", 10, "tool_request", { task: "task-2", tool_id: "check-3", text: "Bash(npm test)", sha256: SHA_A }),
  ev("r4", 11, "tool_result", { task: "task-2", tool_id: "check-3", outcome: "success", text: "all checks passed", sha256: SHA_A }),
  // Request bound to A, result bound to nothing.
  ev("t6", 12, "tool_request", { tool_id: "check-5", text: "Bash(npm test)", sha256: SHA_A }),
  ev("r6", 13, "tool_result", { tool_id: "check-5", outcome: "success", text: "all checks passed" }),
  // Request bound to A, result reports B.
  ev("t7", 14, "tool_request", { tool_id: "check-6", text: "Bash(npm test)", sha256: SHA_A }),
  ev("r7", 15, "tool_result", { tool_id: "check-6", outcome: "success", text: "all checks passed", sha256: SHA_B }),
];
const verificationBatch = (extra = []) => core.validateObservation({ ...batchCases.normal_chain(), events: [...verificationEvents, ...extra] }).batch;
const link = (request_event_id, result_event_id, method = "npm test") => ({ method, request_event_id, result_event_id });
const verifyClaim = (batch, patch) =>
  interp(batch, { findings: [finding("VERIFY", { status: "observed", claim: "검사 결과를 확인했다", evidence: [userQuote], ...patch })] });

test("MC-T10 observed VERIFY needs the exact revision plus its own linked, executed, successful check", () => {
  const batch = verificationBatch();
  const accepted = core.validateInterpretation(verifyClaim(batch, { target_artifact: SHA_A, verification: link("t1", "r1") }), batch);
  assert.deepEqual(accepted.findings[0].verification, link("t1", "r1"));
  assert.deepEqual(core.resolveVerification(batch, SHA_A, link("t1", "r1")), { checked_revision: SHA_A, current_revision: SHA_B, current: false });
  // A fresh check of the current revision B is accepted and current.
  const rechecked = verificationBatch([ev("t5", 16, "tool_request", { tool_id: "check-4", text: "Bash(npm test)", sha256: SHA_B }), ev("r5", 17, "tool_result", { tool_id: "check-4", outcome: "success", text: "all checks passed", sha256: SHA_B })]);
  assert.deepEqual(core.resolveVerification(rechecked, SHA_B, link("t5", "r5")), { checked_revision: SHA_B, current_revision: SHA_B, current: true });
  assert.equal(core.validateInterpretation(verifyClaim(rechecked, { target_artifact: SHA_B, verification: link("t5", "r5") }), rechecked).findings.length, 1);
});

test("MC-T10 unrelated success, missing target/request/result, mismatched call, failure and stale reuse are refused", () => {
  const batch = verificationBatch();
  const refuse = (patch, code) => throwsCode(() => core.validateInterpretation(verifyClaim(batch, patch), batch), code);
  // X2 repro 1: an unrelated successful result after A, with no link to a check.
  refuse({ target_artifact: SHA_A }, "missing_verification_link");
  // …linked with a method it never ran.
  refuse({ target_artifact: SHA_A, verification: link("t2", "r2") }, "unverified_method");
  // X2 R2 repro: IDs, task, tool call and the real method all match, but the command
  // never took revision A as input.
  refuse({ target_artifact: SHA_A, verification: link("t2", "r2", "echo hello") }, "unbound_verification_request");
  // Only one side bound, or the two sides disagree about the revision.
  refuse({ target_artifact: SHA_A, verification: link("t6", "r6") }, "unbound_verification_result");
  refuse({ target_artifact: SHA_A, verification: link("t7", "r7") }, "unverified_revision");
  // X2 repro 2: observed VERIFY with no target artifact.
  refuse({ verification: link("t1", "r1") }, "missing_target_artifact");
  refuse({}, "missing_target_artifact");
  refuse({ target_artifact: "c".repeat(64), verification: link("t1", "r1") }, "unknown_artifact");
  // Missing or wrong request / result.
  refuse({ target_artifact: SHA_A, verification: { method: "npm test", request_event_id: "t1" } }, "missing_verification_link");
  refuse({ target_artifact: SHA_A, verification: link("missing", "r1") }, "invalid_verification_request");
  refuse({ target_artifact: SHA_A, verification: link("u1", "r1") }, "invalid_verification_request");
  refuse({ target_artifact: SHA_A, verification: link("t1", "missing") }, "missing_execution_evidence");
  refuse({ target_artifact: SHA_A, verification: link("t1", "t3") }, "missing_execution_evidence");
  // Mismatched tool call, and a check from another task.
  refuse({ target_artifact: SHA_A, verification: link("t1", "r2") }, "mismatched_verification_link");
  refuse({ target_artifact: SHA_A, verification: link("t4", "r4") }, "mismatched_verification_link");
  // An executed but failed check.
  refuse({ target_artifact: SHA_A, verification: link("t3", "r3") }, "failed_verification");
  // Stale reuse: the check bound to A claimed for the current revision B.
  refuse({ target_artifact: SHA_B, verification: link("t1", "r1") }, "unverified_revision");
  // A check bound to B that started before B existed.
  const early = core.validateObservation({ ...batchCases.normal_chain(), events: [
    ev("u1", 1, "user", { text: "새 직원" }), ev("f1", 2, "artifact", { sha256: SHA_A, text: "order.md" }),
    ev("t1", 3, "tool_request", { tool_id: "check-1", text: "Bash(npm test)", sha256: SHA_B }),
    ev("r1", 4, "tool_result", { tool_id: "check-1", outcome: "success", text: "ok", sha256: SHA_B }), ev("f2", 5, "artifact", { sha256: SHA_B, text: "order.md" }),
  ] }).batch;
  throwsCode(() => core.validateInterpretation(verifyClaim(early, { target_artifact: SHA_B, verification: link("t1", "r1") }), early), "stale_verification");
  // The file changed to B while the check ran, then back to A: not a check of A.
  const midCheck = core.validateObservation({ ...batchCases.normal_chain(), events: [
    ev("u1", 1, "user", { text: "새 직원" }), ev("f1", 2, "artifact", { sha256: SHA_A, text: "order.md" }),
    ev("t1", 3, "tool_request", { tool_id: "check-1", text: "Bash(npm test)", sha256: SHA_A }), ev("f2", 4, "artifact", { sha256: SHA_B, text: "order.md" }),
    ev("r1", 5, "tool_result", { tool_id: "check-1", outcome: "success", text: "ok", sha256: SHA_A }), ev("f3", 6, "artifact", { sha256: SHA_A, text: "order.md" }),
  ] }).batch;
  throwsCode(() => core.validateInterpretation(verifyClaim(midCheck, { target_artifact: SHA_A, verification: link("t1", "r1") }), midCheck), "stale_verification");
  // A verification link is only meaningful on an observed VERIFY finding.
  throwsCode(() => core.validateInterpretation(interp(batch, { findings: [finding("VERIFY", { verification: link("t1", "r1") })] }), batch), "invalid_finding");
});

test("MC-T10 a hash or a request without an executed result is not verification", () => {
  const hashOnly = core.validateObservation({ ...batchCases.normal_chain(), events: [batchCases.normal_chain().events[0], { id: "f1", seq: 2, task: "task-1", at: 2, kind: "artifact", sha256: SHA_A, text: "order.md", assistance: "unknown" }] }).batch;
  throwsCode(() => core.validateInterpretation(verifyClaim(hashOnly, { target_artifact: SHA_A }), hashOnly), "missing_verification_link");
  const requestOnly = core.validateObservation({ ...batchCases.normal_chain(), events: verificationEvents.slice(0, 3) }).batch;
  throwsCode(() => core.validateInterpretation(verifyClaim(requestOnly, { target_artifact: SHA_A, verification: link("t1", "r1") }), requestOnly), "missing_execution_evidence");
});

// ── MC-T11 — citations and review ─────────────────────────────────────────────
test("MC-T11 real citations pass; missing ids and altered quotes are fabricated", () => {
  const batch = legacyBatch("normal_chain");
  const cite = (ref) => interp(batch, { findings: [finding("FRAMING", { status: "observed", claim: "대상을 정했다", evidence: [ref] })] });
  assert.equal(core.validateInterpretation(cite(userQuote), batch).findings.length, 1);
  throwsCode(() => core.validateInterpretation(cite({ event_id: "missing", quote: "새 직원" }), batch), "fabricated_quote");
  throwsCode(() => core.validateInterpretation(cite({ event_id: "u1", quote: "다른 인용" }), batch), "fabricated_quote");
  throwsCode(() => core.validateInterpretation(cite({ event_id: "u1", quote: "새 직원", invented: true }), batch), "invalid_quote");
});

test("MC-T11 a user correction is human evidence; only the user moves a finding out of unreviewed", () => {
  const batch = core.validateObservation({ ...batchCases.normal_chain(), events: [...batchCases.normal_chain().events, { id: "k1", seq: 7, task: "task-1", at: 7, kind: "correction", text: "아니요, 대상은 신규 매장 직원입니다", assistance: "unknown" }] }).batch;
  const reviewed = (patch) => interp(batch, { findings: [finding("FRAMING", { status: "observed", claim: "대상을 바로잡았다", evidence: [{ event_id: "k1", quote: "신규 매장 직원" }], ...patch })] });
  assert.equal(core.validateInterpretation(reviewed({}), batch).findings[0].review, "unreviewed");
  assert.equal(core.validateInterpretation(reviewed({ review: "confirmed", reviewed_by: "user" }), batch).findings[0].review, "confirmed");
  assert.equal(core.validateInterpretation(reviewed({ review: "retracted", reviewed_by: "user" }), batch).findings[0].review, "retracted");
  throwsCode(() => core.validateInterpretation(reviewed({ review: "confirmed" }), batch), "invalid_review");
  throwsCode(() => core.validateInterpretation(reviewed({ review: "confirmed", reviewed_by: "model" }), batch), "invalid_review");
  throwsCode(() => core.validateInterpretation(reviewed({ reviewed_by: "user" }), batch), "invalid_review");
});

// ── MC-T12 — models, versions and reinterpretation ────────────────────────────
test("MC-T12 new interpretations default to the six-capability model; the seven stay readable separately", () => {
  assert.deepEqual(core.DEFAULT_CAPABILITY_MODEL.capabilities.map((c) => c.key), ["FRAMING", "JUDGMENT", "ORCHESTRATE", "VERIFY", "ADAPT", "OWNERSHIP"]);
  assert.deepEqual(core.LEGACY_SEVEN_ASSETS.capabilities.map((c) => c.key), [...core.OBSERVATION_ASSETS]);
  const batch = legacyBatch("normal_chain");
  const legacyVersions = { ...interp(batch).versions, capability_model: { id: "legacy-seven-assets", revision: 1 }, definition_revision: core.LEGACY_SEVEN_ASSETS.definition_revision };
  assert.equal(core.validateInterpretation(interp(batch, { versions: legacyVersions, findings: [finding("INTENT")] }), batch).findings[0].capability, "INTENT");
  throwsCode(() => core.validateInterpretation(interp(batch, { findings: [finding("INTENT")] }), batch), "unknown_capability");
  throwsCode(() => core.validateInterpretation(interp(batch, { versions: legacyVersions, findings: [finding("FRAMING")] }), batch), "unknown_capability");
});

test("MC-T12 versions are explicit (unknown allowed); AI models and capability models are not confused", () => {
  const batch = legacyBatch("normal_chain");
  const v = interp(batch).versions;
  const known = { ...v, rubric: { id: "native-rubric", version: "2026.09" }, evaluator: { id: "human-review", version: "1" }, analysis_ai_model: "claude-opus-5", work_ai_models: ["claude-sonnet-5"] };
  assert.equal(core.validateInterpretation(interp(batch, { versions: known }), batch).versions.analysis_ai_model, "claude-opus-5");
  const { rubric: _missing, ...noRubric } = v;
  throwsCode(() => core.validateInterpretation(interp(batch, { versions: noRubric }), batch), "invalid_versions");
  throwsCode(() => core.validateInterpretation(interp(batch, { versions: { ...v, capability_model: { id: "claude-opus-5", revision: 1 } } }), batch), "capability_model_confusion");
  throwsCode(() => core.validateInterpretation(interp(batch, { versions: { ...v, analysis_ai_model: "candidate-capability-v1" } }), batch), "capability_model_confusion");
  throwsCode(() => core.validateInterpretation(interp(batch, { versions: { ...v, capability_model: { id: "candidate-capability-v9", revision: 1 } } }), batch), "unknown_capability_model");
  throwsCode(() => core.validateInterpretation(interp(batch, { versions: { ...v, definition_revision: "edited" } }), batch), "definition_revision_mismatch");
});

test("MC-T12 reinterpretation adds a revision and never overwrites the earlier one", () => {
  const batch = legacyBatch("normal_chain");
  const first = interp(batch, { findings: [finding("FRAMING", { status: "observed", claim: "대상을 정했다", evidence: [userQuote] })] });
  const snapshot = structuredClone(first);
  const second = interp(batch, { revision: 2, supersedes: { id: "interp-1", revision: 1 }, reason: "정의 개정 후 원근거에서 재해석", findings: [finding("JUDGMENT", { status: "observed", claim: "기준으로 골랐다", evidence: [userQuote] })] });
  assert.equal(core.validateReinterpretation(first, second, batch).revision, 2);
  assert.deepEqual(first, snapshot, "the earlier revision is not mutated");
  throwsCode(() => core.validateReinterpretation(first, { ...second, reason: undefined }, batch), "invalid_supersedes");
  throwsCode(() => core.validateReinterpretation(first, { ...first, findings: [] }, batch), "invalid_supersedes");
  throwsCode(() => core.validateInterpretation({ ...second, supersedes: { id: "other", revision: 1 } }, batch), "invalid_supersedes");
});

test("MC-T12 no arithmetic legacy conversion; shared evidence, subsets and counter-examples are allowed", () => {
  const batch = legacyBatch("normal_chain");
  throwsCode(() => core.validateInterpretation(interp(batch, { findings: [{ ...finding("FRAMING"), derived_from_legacy: ["INTENT", "CONTEXT"] }] }), batch), "legacy_conversion");
  const shared = interp(batch, {
    findings: [
      finding("FRAMING", { status: "observed", claim: "대상을 정했다", evidence: [userQuote] }),
      finding("JUDGMENT", { status: "observed", claim: "같은 발화에서 기준도 드러났다", evidence: [userQuote] }),
    ],
    unclassified: [{ claim: "어느 항목에도 맞지 않는 반례", evidence: [userQuote] }],
  });
  assert.equal(core.validateInterpretation(shared, batch).findings.length, 2);
  throwsCode(() => core.validateInterpretation(interp(batch, { findings: [finding("FRAMING"), finding("FRAMING")] }), batch), "duplicate_capability");
});

test("legacy heuristic scorer stays on its existing compatibility path only", async () => {
  const scorer = await import("../src/lib/asset-scorer.ts");
  assert.equal(typeof scorer.scoreTurnAssets, "function");
  for (const f of readdirSync(CORE_DIR)) assert.doesNotMatch(readFileSync(new URL(f, CORE_DIR), "utf8"), /asset-scorer|scoreTurnAssets/);
});
