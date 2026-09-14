// Measurement-core unit 2, first increment (#1020): Jay's local work record.
// Contract: docs/requirements|testing/measurement-core.md (#1025 @ b9409fa) —
// MC-T05, MC-T06, MC-T13, MC-T15, MC-T17, MC-T18 at core level.
//
// Synthetic fixtures and an in-memory storage port with injected faults. No host UI,
// no file system port, no live host and no Jay use: those remain NOT RUN.
import assert from "node:assert/strict";
import test from "node:test";

const core = await import("../src/lib/measurement-core/index.ts");

const throwsCode = (fn, code) => assert.rejects(fn, (e) => e instanceof Error && e.message === code, `expected ${code}`);
const throwsSync = (fn, code) => assert.throws(fn, (e) => e instanceof Error && e.message === code, `expected ${code}`);

// Storage port double. `ifAbsent` is atomic; faults simulate disk full, read-only,
// a lost acknowledgement after a durable write, silent truncation and read errors.
function memoryStore() {
  const data = new Map();
  const faults = {};
  return {
    data,
    faults,
    async read(k) {
      if (faults.read?.(k)) throw new Error("EIO");
      return data.has(k) ? data.get(k) : null;
    },
    async write(k, v, o = {}) {
      if (faults.readOnly) throw new Error("EROFS");
      if (faults.diskFull?.(k)) throw new Error("ENOSPC");
      if (o.ifAbsent && data.has(k)) throw new Error("exists");
      // `alter` keeps valid JSON but changes the content, which a parse check alone would miss.
      data.set(k, faults.truncate?.(k) ? v.slice(0, Math.floor(v.length / 2)) : faults.alter?.(k) ? v.replace("중단", "완료") : v);
      if (faults.lostAck?.(k)) {
        faults.lostAck = undefined;
        throw new Error("ECONNRESET");
      }
    },
    async list(p) {
      return [...data.keys()].filter((k) => k.startsWith(p)).sort();
    },
    async remove(k) {
      if (faults.readOnly) throw new Error("EROFS");
      data.delete(k);
    },
  };
}

const SHA_A = "a".repeat(64);
const HOST = "claude-code";
const batch = (session = "s1", extra = []) => ({
  format: "hps-observation/1",
  scope: "jay-local",
  session,
  program: "hypeproof-studio",
  events: [
    { id: "u1", seq: 1, task: "t", at: 1, kind: "user", text: "새 직원이 주문을 확인할 문서가 필요해", assistance: "unknown" },
    { id: "c1", seq: 2, task: "t", at: 2, kind: "coach", text: "초안을 만들게요", assistance: "unknown" },
    { id: "f1", seq: 3, task: "t", at: 3, kind: "artifact", sha256: SHA_A, text: "order.md", assistance: "unknown" },
    ...extra,
  ],
});
const interp = (b, patch = {}) => ({
  format: "hps-interpretation/1",
  id: "interp-1",
  revision: 1,
  supersedes: null,
  batch: { format: b.format, scope: b.scope, session: b.session, program: b.program },
  versions: {
    bundle_format: b.format,
    capability_model: { id: core.DEFAULT_CAPABILITY_MODEL.id, revision: core.DEFAULT_CAPABILITY_MODEL.revision },
    definition_revision: core.DEFAULT_CAPABILITY_MODEL.definition_revision,
    rubric: "unknown",
    evaluator: "unknown",
    analysis_ai_model: "unknown",
    work_ai_models: "unknown",
  },
  findings: [
    { capability: "FRAMING", status: "observed", claim: "대상을 새 직원으로 정했다", evidence: [{ event_id: "u1", quote: "새 직원" }], assistance: "unknown", review: "unreviewed" },
    { capability: "VERIFY", status: "unobserved", claim: "검사 기회 없음", evidence: [], assistance: "unknown", review: "unreviewed" },
  ],
  unclassified: [],
  ...patch,
});
const key = (id, session = "s1") => `observations/jay-local/${session}/${id}`;

// A task with one linked session, observations, an interpretation and a review.
async function seeded(options = {}) {
  const store = memoryStore();
  const record = new core.LocalRecord(store, options);
  await record.createTask({ id: "task-a", project: "hypeproof-studio", at: 1, purpose: { text: "주문 확인 문서", source: "issue", ref: "#1020" } });
  await record.linkSession("task-a", { host: HOST, session_id: "s1", by: "adapter_explicit", at: 1 });
  await record.appendObservations(HOST, batch());
  await record.saveInterpretation("task-a", interp(batch()), batch());
  const review = await record.reviewFinding("task-a", { interpretation: { id: "interp-1", revision: 1 }, capability: "FRAMING", action: "confirm", by: "user", at: 5 });
  const selection = (patch = {}) => ({
    id: "sub-1",
    revision: 1,
    task: "task-a",
    at: 6,
    observations: [key("u1"), key("f1")],
    interpretations: [{ id: "interp-1", revision: 1 }],
    reviews: [review.key],
    excluded: [{ ref: key("c1"), why: "코치 초안 문장은 공유하지 않음" }],
    ...patch,
  });
  return { store, record, review, selection };
}

// ── MC-T05 — purpose provenance ───────────────────────────────────────────────
test("MC-T05 a provided purpose needs no re-entry; undecided purposes still allow work", async () => {
  const store = memoryStore();
  const record = new core.LocalRecord(store);
  const provided = await record.createTask({ id: "from-issue", project: "p", at: 1, purpose: { text: "주문 확인 문서", source: "issue", ref: "#1020" } });
  assert.equal(provided.purpose_state, "provided");
  const undecided = await record.createTask({ id: "undecided", project: "p", at: 1 });
  assert.equal(undecided.purpose, null);
  assert.equal(undecided.purpose_state, "undecided");
  // Work proceeds without a purpose: link, record, interpret.
  await record.linkSession("undecided", { host: HOST, session_id: "s9", by: "user", at: 2 });
  const appended = await record.appendObservations(HOST, batch("s9"));
  assert.equal(appended.task, "undecided");
  assert.equal((await record.saveInterpretation("undecided", interp(batch("s9")), batch("s9"))).id, "interp-1");
});

test("MC-T05 an AI-proposed purpose stays separate from Jay's confirmed or edited purpose", async () => {
  const task = core.createTask({ id: "t", project: "p", at: 1, purpose: { text: "가입 수를 늘린다", source: "ai_proposed" } });
  assert.equal(task.purpose_state, "ai_proposed");
  const edited = core.confirmPurpose(task, { by: "user", at: 2, text: "첫 작업 완료율을 본다" });
  assert.equal(edited.purpose_state, "confirmed");
  assert.deepEqual(edited.purpose_history.map((p) => [p.source, p.text]), [["ai_proposed", "가입 수를 늘린다"], ["user", "첫 작업 완료율을 본다"]]);
  assert.equal(edited.history.at(-1).change, "purpose_edited");
  assert.equal(core.confirmPurpose(task, { by: "user", at: 2 }).history.at(-1).change, "purpose_confirmed");
  // Negative controls: the model cannot confirm, and confirmation is not a purpose source it can claim.
  throwsSync(() => core.confirmPurpose(task, { by: "model", at: 2 }), "purpose_confirmation_requires_user");
  throwsSync(() => core.createTask({ id: "t", project: "p", at: 1, purpose: { text: "x", source: "ai_confirmed" } }), "invalid_purpose");
  throwsSync(() => core.createTask({ id: "../escape", project: "p", at: 1 }), "invalid_task");
});

// ── MC-T06 — session is not task ──────────────────────────────────────────────
test("MC-T06 only explicit links attribute sessions; the same project never merges tasks", async () => {
  const store = memoryStore();
  const record = new core.LocalRecord(store);
  await record.createTask({ id: "task-a", project: "same-folder", at: 1 });
  await record.createTask({ id: "task-b", project: "same-folder", at: 1 });
  await record.linkSession("task-a", { host: HOST, session_id: "s1", by: "adapter_explicit", at: 1 });
  await record.linkSession("task-b", { host: "codex", session_id: "s2", by: "user", at: 1 });
  assert.equal((await record.appendObservations(HOST, batch("s1"))).task, "task-a");
  assert.equal((await record.appendObservations("codex", batch("s2"))).task, "task-b");
  // Same project, unlinked session: stays unassigned instead of joining either task.
  assert.equal((await record.appendObservations(HOST, batch("s3"))).task, null);
  assert.equal((await record.records()).unassigned_observations, 3);
  // The same host session id on a different host is a different session.
  assert.equal(await record.taskForSession("codex", "s1"), null);
  await throwsCode(() => record.linkSession("task-b", { host: HOST, session_id: "s1", by: "user", at: 2 }), "session_linked_to_other_task");
  // Re-linking the same session to the same task is idempotent.
  assert.equal((await record.linkSession("task-a", { host: HOST, session_id: "s1", by: "user", at: 3 })).sessions.length, 1);
});

test("MC-T06 a wrong attribution is reassigned by the person with history; duplicates are not conflicts", async () => {
  const { record, store } = await seeded();
  await record.createTask({ id: "task-b", project: "hypeproof-studio", at: 1 });
  const moved = await record.reassignObservation(key("c1"), "task-b", { by: "user", reason: "다른 작업의 대화였다", at: 7 });
  assert.equal(moved.task, "task-b");
  assert.deepEqual(moved.history.map((h) => [h.from, h.to, h.by]), [[null, "task-a", "adapter_explicit"], ["task-a", "task-b", "user"]]);
  await throwsCode(() => record.reassignObservation(key("c1"), "task-a", { by: "adapter_explicit", reason: "자동", at: 8 }), "invalid_reassignment");
  await throwsCode(() => record.reassignObservation(key("c1"), "task-a", { by: "user", reason: "", at: 8 }), "invalid_reassignment");
  // A retried hook is a duplicate and keeps the user's reassignment.
  const again = await record.appendObservations(HOST, batch());
  assert.deepEqual([again.stored, again.duplicates], [0, 3]);
  assert.equal(JSON.parse(store.data.get(`assignments/jay-local/s1/c1`)).task, "task-b");
  // Same id, different content: refused, original kept.
  const changed = batch();
  changed.events[0] = { ...changed.events[0], text: "다른 내용" };
  await throwsCode(() => record.appendObservations(HOST, changed), "conflicting_event");
  assert.match(JSON.parse(store.data.get(key("u1"))).event.text, /새 직원/);
});

// ── MC-T13 — submission and local receipt ─────────────────────────────────────
test("MC-T13 a reviewed bundle is accepted locally with a receipt the independent verifier confirms", async () => {
  const { record, store, selection } = await seeded();
  const bundle = await record.buildSubmission(selection());
  assert.match(bundle.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(bundle.payload.observations.map((o) => o.event.id), ["u1", "f1"]);
  assert.equal(bundle.payload.excluded[0].ref, key("c1"));
  const receipt = await record.submit(bundle, 10);
  assert.deepEqual(
    { state: receipt.state, id: receipt.id, revision: receipt.revision, digest: receipt.digest, destination: receipt.destination, task: receipt.task },
    { state: "accepted-local", id: "sub-1", revision: 1, digest: bundle.digest, destination: "local-inbox", task: "task-a" },
  );
  assert.deepEqual(await core.verifyReceipt(store, receipt), { ok: true });
  // Same id and digest: the same receipt, one stored copy.
  assert.deepEqual(await record.submit(structuredClone(bundle), 99), receipt);
  assert.equal([...store.data.keys()].filter((k) => k.startsWith("submissions/")).length, 1);
});

test("MC-T13 conflicting, tampered, excluded-but-included and non-local bundles are never accepted", async () => {
  const { record, store, selection } = await seeded();
  const receipt = await record.submit(await record.buildSubmission(selection()), 10);
  // Same id, different content.
  await throwsCode(async () => record.submit(await record.buildSubmission(selection({ reason: "다른 설명" })), 11), "submission_conflict");
  assert.deepEqual(await core.verifyReceipt(store, receipt), { ok: true });
  // Payload changed after the digest was taken.
  const tampered = await record.buildSubmission(selection({ id: "sub-2" }));
  tampered.payload.reason = "몰래 추가";
  await throwsCode(() => record.submit(tampered, 12), "corrupt_bundle");
  assert.equal(store.data.has("submissions/sub-2@1"), false);
  await throwsCode(() => record.submit({ kind: "submission" }, 12), "corrupt_bundle");
  // An item cannot be both included and excluded, and items must belong to the task.
  await throwsCode(() => record.buildSubmission(selection({ id: "sub-3", excluded: [{ ref: key("u1"), why: "제외" }] })), "excluded_item_included");
  await record.createTask({ id: "task-b", project: "hypeproof-studio", at: 1 });
  await throwsCode(() => record.buildSubmission(selection({ id: "sub-4", task: "task-b" })), "foreign_item");
  // Only the local inbox is a P0 destination, even with a recomputed digest.
  const remote = await record.buildSubmission(selection({ id: "sub-5" }));
  remote.payload.destination = "remote-team";
  remote.digest = await core.digestOf(remote.payload);
  await throwsCode(() => record.submit(remote, 13), "unsupported_destination");
});

test("MC-T13 abandoned work is submittable; a resumed revision links to its parent and never rewrites it", async () => {
  const { record, store, selection } = await seeded();
  const task = await record.getTask("task-a");
  await record.saveTask(core.setTaskStatus(task, "abandoned", { by: "user", at: 8, reason: "요구가 바뀌었다" }));
  const first = await record.submit(await record.buildSubmission(selection({ reason: "중단: 요구 변경" })), 10);
  const firstRaw = store.data.get("submissions/sub-1@1");
  assert.equal(JSON.parse(firstRaw).payload.task.status, "abandoned");
  await throwsCode(async () => record.submit(await record.buildSubmission(selection({ revision: 3 })), 11), "missing_parent_receipt");
  const second = await record.submit(await record.buildSubmission(selection({ revision: 2, reason: "재개 후 결과" })), 12);
  assert.deepEqual(JSON.parse(store.data.get("submissions/sub-1@2")).payload.parent, { id: "sub-1", revision: 1 });
  assert.equal(store.data.get("submissions/sub-1@1"), firstRaw);
  assert.deepEqual(await core.verifyReceipt(store, first), { ok: true });
  assert.deepEqual(await core.verifyReceipt(store, second), { ok: true });
  // A plain export is not an acceptance.
  const exported = await record.exportTask("task-a");
  assert.deepEqual([exported.state, exported.receipt], ["exported", null]);
  assert.equal([...store.data.keys()].filter((k) => k.startsWith("receipts/")).length, 2);
});

test("MC-T13 the independent verifier catches changed storage, forged receipts and missing bundles", async () => {
  const { record, store, selection } = await seeded();
  const receipt = await record.submit(await record.buildSubmission(selection()), 10);
  assert.deepEqual(await core.verifyReceipt(store, { ...receipt, id: "never-submitted" }), { ok: false, code: "missing_submission" });
  assert.deepEqual(await core.verifyReceipt(store, { ...receipt, accepted_at: 1 }), { ok: false, code: "receipt_not_issued" });
  const stored = JSON.parse(store.data.get("submissions/sub-1@1"));
  stored.payload.reason = "나중에 바뀜";
  store.data.set("submissions/sub-1@1", JSON.stringify(stored));
  assert.deepEqual(await core.verifyReceipt(store, receipt), { ok: false, code: "digest_mismatch" });
  assert.deepEqual(await core.verifyReceipt(store, { kind: "receipt" }), { ok: false, code: "invalid_receipt" });
});

// ── MC-T15 — improvement follow-up and my records ─────────────────────────────
test("MC-T15 an improvement is chosen, skipped or edited, and the next task records tried / not tried / unconfirmed", async () => {
  const { record } = await seeded();
  await record.createTask({ id: "task-next", project: "hypeproof-studio", at: 20 });
  await throwsCode(() => record.chooseImprovement("task-a", { id: "imp-1", text: "검증 대상 revision 확인", choice: "selected", evidence: [key("missing")], by: "user", at: 9 }), "unknown_evidence");
  await throwsCode(() => record.chooseImprovement("task-a", { id: "imp-1", text: "x", choice: "selected", evidence: [], by: "model", at: 9 }), "improvement_requires_user");
  const chosen = await record.chooseImprovement("task-a", { id: "imp-1", text: "검증 대상 revision 확인", choice: "selected", evidence: [key("f1")], by: "user", at: 9 });
  const edited = await record.chooseImprovement("task-a", { id: "imp-1", text: "검증 전에 대상 파일 revision 기록", choice: "edited", evidence: [key("f1")], by: "user", at: 10 });
  assert.deepEqual(edited.history.map((h) => h.choice), ["selected", "edited"]);
  assert.equal(chosen.follow_ups.length, 0);
  await throwsCode(() => record.recordFollowUp("imp-1", { task: "task-a", attempt: "tried", by: "user", at: 11 }), "same_task_follow_up");
  const tried = await record.recordFollowUp("imp-1", { task: "task-next", attempt: "tried", observed: "revision을 먼저 적었다", by: "user", at: 21 });
  const unclear = await record.recordFollowUp("imp-1", { task: "task-next", attempt: "tried", by: "adapter_explicit", at: 22 });
  const notTried = await record.recordFollowUp("imp-1", { task: "task-next", attempt: "not_tried", by: "user", at: 23 });
  assert.deepEqual(notTried.follow_ups.map((f) => f.result), ["observed", "unconfirmed", "not_tried"]);
  assert.equal(tried.follow_ups[0].observed, "revision을 먼저 적었다");
  assert.equal(unclear.follow_ups[1].observed, undefined);
  await record.chooseImprovement("task-a", { id: "imp-2", text: "건너뜀", choice: "skipped", evidence: [], by: "user", at: 12 });
  await throwsCode(() => record.recordFollowUp("imp-2", { task: "task-next", attempt: "tried", by: "user", at: 24 }), "improvement_skipped");
});

test("MC-T15 my records keep abandoned tasks, unreviewed findings, skipped improvements, unassigned events and gaps", async () => {
  const { record } = await seeded();
  await record.createTask({ id: "task-dropped", project: "hypeproof-studio", at: 2 });
  await record.saveTask(core.setTaskStatus(await record.getTask("task-dropped"), "abandoned", { by: "user", at: 3 }));
  await record.chooseImprovement("task-a", { id: "imp-skip", text: "나중에", choice: "skipped", evidence: [], by: "user", at: 4 });
  // An unlinked session with a sequence gap.
  const gapped = batch("s-gap");
  gapped.events = [gapped.events[0], { ...gapped.events[2], seq: 3 }];
  await record.appendObservations(HOST, gapped);
  const mine = await record.records();
  assert.deepEqual(mine.tasks.map((t) => [t.id, t.status]), [["task-a", "open"], ["task-dropped", "abandoned"]]);
  // FRAMING was confirmed; VERIFY is still unreviewed.
  assert.equal(mine.tasks[0].unreviewed_findings, 1);
  assert.equal(mine.improvements[0].choice, "skipped");
  assert.equal(mine.unassigned_observations, 2);
  assert.deepEqual(mine.gaps, [{ scope: "jay-local", session: "s-gap", missing: [2], incomplete: false }]);
});

// ── MC-T17 — storage faults, retries and concurrency ──────────────────────────
test("MC-T17 disk full, read-only and truncated writes never produce a receipt; a clean retry does", async () => {
  const { record, store, selection } = await seeded();
  const bundle = await record.buildSubmission(selection());
  store.faults.diskFull = (k) => k.startsWith("submissions/");
  await throwsCode(() => record.submit(bundle, 10), "storage_failure");
  assert.equal([...store.data.keys()].some((k) => k.startsWith("receipts/")), false);
  store.faults.diskFull = undefined;
  store.faults.readOnly = true;
  await throwsCode(() => record.submit(bundle, 10), "storage_failure");
  store.faults.readOnly = false;
  store.faults.truncate = (k) => k.startsWith("submissions/");
  await throwsCode(() => record.submit(bundle, 10), "storage_failure");
  assert.equal([...store.data.keys()].some((k) => k.startsWith("receipts/")), false);
  store.faults.truncate = undefined;
  store.data.delete("submissions/sub-1@1");
  const receipt = await record.submit(bundle, 11);
  assert.deepEqual(await core.verifyReceipt(store, receipt), { ok: true });
  // A port that silently stores different but well-formed content gets no receipt either.
  const altered = await record.buildSubmission(selection({ id: "sub-altered", reason: "중단 사유 기록" }));
  store.faults.alter = (k) => k.startsWith("submissions/");
  await throwsCode(() => record.submit(altered, 12), "storage_failure");
  assert.equal(store.data.has("receipts/sub-altered@1"), false);
  assert.match(store.data.get("submissions/sub-altered@1"), /완료 사유 기록/, "control: the fault really altered the stored content");
});

test("MC-T17 a lost acknowledgement after a durable write is recovered by retry without a second copy", async () => {
  const { record, store, selection } = await seeded();
  const bundle = await record.buildSubmission(selection());
  store.faults.lostAck = (k) => k.startsWith("receipts/");
  await throwsCode(() => record.submit(bundle, 10), "storage_failure");
  const retried = await record.submit(bundle, 11);
  assert.equal(retried.accepted_at, 10, "the receipt written before the lost acknowledgement is returned");
  assert.deepEqual(await core.verifyReceipt(store, retried), { ok: true });
});

test("MC-T17 concurrent submissions: same bundle gets one receipt; different content under one id gets one winner", async () => {
  const { record, store, selection } = await seeded();
  const bundle = await record.buildSubmission(selection());
  const [a, b] = await Promise.all([record.submit(bundle, 10), record.submit(structuredClone(bundle), 10)]);
  assert.deepEqual(a, b);
  const other = await record.buildSubmission(selection({ id: "sub-race" }));
  const rival = await record.buildSubmission(selection({ id: "sub-race", reason: "경쟁" }));
  const results = await Promise.allSettled([record.submit(other, 12), record.submit(rival, 12)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((r) => r.status === "rejected").reason.message, "submission_conflict");
  const winner = results.find((r) => r.status === "fulfilled").value;
  assert.deepEqual(await core.verifyReceipt(store, winner), { ok: true });
});

test("MC-T17 capacity is exposed and enforced without deleting reviewed, pending or accepted data", async () => {
  const { record, store, selection } = await seeded();
  await record.submit(await record.buildSubmission(selection()), 10);
  const { bytes } = await record.usage();
  const before = new Map(store.data);
  const tight = new core.LocalRecord(store, { maxBytes: bytes + 10 });
  assert.deepEqual(await tight.usage(), { bytes, max_bytes: bytes + 10 });
  await throwsCode(() => tight.appendObservations(HOST, batch("s-new")), "capacity_exceeded");
  assert.deepEqual(new Map(store.data), before, "nothing evicted to make room");
  assert.equal(core.DEFAULT_LOCAL_MAX_BYTES > 0, true);
  // Read errors and corrupt records surface as failures, not empty lists.
  store.data.set("tasks/broken", "{not json");
  await throwsCode(() => record.records(), "corrupt_record");
  store.data.delete("tasks/broken");
  store.faults.read = (k) => k.startsWith("tasks/");
  await throwsCode(() => record.records(), "storage_failure");
});

// ── MC-T18 — exclusions, review immutability and deletion ─────────────────────
test("MC-T18 known secrets and excluded paths are removed before storage and the exclusion is recorded", async () => {
  const store = memoryStore();
  const record = new core.LocalRecord(store);
  const token = "ghp_" + "Z".repeat(36);
  const secretBatch = batch("s1", [
    { id: "t1", seq: 4, task: "t", at: 4, kind: "tool_request", tool_id: "x", text: "Read(config/.env)", assistance: "unknown" },
    { id: "r1", seq: 5, task: "t", at: 5, kind: "tool_result", tool_id: "x", outcome: "success", text: `token ${token} and sk-ant-${"b".repeat(30)}`, assistance: "unknown" },
  ]);
  const result = await record.appendObservations(HOST, secretBatch, { excludedPaths: ["config/.env"] });
  const raw = [...store.data.values()].join("\n");
  assert.equal(raw.includes(token), false);
  assert.equal(raw.includes("sk-ant-"), false);
  assert.deepEqual(result.exclusions.map((e) => e.kind).sort(), ["anthropic_key", "excluded_path", "github_token"]);
  assert.equal(JSON.parse(store.data.get(key("t1"))).event.text, "[excluded:path]");
  // Control: ordinary text is stored unchanged.
  assert.equal(JSON.parse(store.data.get(key("u1"))).event.text, "새 직원이 주문을 확인할 문서가 필요해");
  // An interpretation must cite what was stored, not the unredacted copy.
  await record.createTask({ id: "task-a", project: "p", at: 1 });
  const cite = interp(secretBatch, { findings: [{ capability: "VERIFY", status: "insufficient_evidence", claim: "결과 확인 불가", evidence: [{ event_id: "r1", quote: "token" }], assistance: "unknown", review: "unreviewed" }] });
  await throwsCode(() => record.saveInterpretation("task-a", cite, secretBatch), "evidence_mismatch");
});

test("MC-T18 a review never edits the interpretation; only the person reviews, and corrections need text", async () => {
  const { record, store } = await seeded();
  const iKey = "interpretations/task-a/interp-1@1";
  const before = store.data.get(iKey);
  const correction = await record.reviewFinding("task-a", { interpretation: { id: "interp-1", revision: 1 }, capability: "FRAMING", action: "correct", corrected_claim: "대상은 신규 매장 직원", by: "user", at: 6 });
  assert.equal(correction.previous, "reviews/task-a/interp-1@1/FRAMING/000001");
  assert.equal(store.data.get(iKey), before);
  await throwsCode(() => record.reviewFinding("task-a", { interpretation: { id: "interp-1", revision: 1 }, capability: "FRAMING", action: "confirm", by: "model", at: 6 }), "review_requires_user");
  await throwsCode(() => record.reviewFinding("task-a", { interpretation: { id: "interp-1", revision: 1 }, capability: "FRAMING", action: "correct", by: "user", at: 6 }), "invalid_review");
  await throwsCode(() => record.reviewFinding("task-a", { interpretation: { id: "interp-1", revision: 1 }, capability: "ADAPT", action: "confirm", by: "user", at: 6 }), "unknown_finding");
  // An interpretation revision is never overwritten.
  await throwsCode(() => record.saveInterpretation("task-a", interp(batch(), { findings: [] }), batch()), "revision_exists");
});

test("MC-T18 deleting a task removes core-managed records only for that task and blocks reuse of its evidence", async () => {
  const { record, store, selection } = await seeded();
  await record.submit(await record.buildSubmission(selection()), 10);
  await record.chooseImprovement("task-a", { id: "imp-1", text: "revision 확인", choice: "selected", evidence: [key("f1")], by: "user", at: 11 });
  // Another task's data must survive.
  await record.createTask({ id: "task-b", project: "hypeproof-studio", at: 1 });
  await record.linkSession("task-b", { host: "codex", session_id: "s2", by: "user", at: 1 });
  await record.appendObservations("codex", batch("s2"));
  await throwsCode(() => record.deleteTask("task-a", { by: "adapter_explicit", at: 12 }), "delete_requires_user");
  const result = await record.deleteTask("task-a", { by: "user", at: 12 });
  assert.deepEqual(result.removed, { observations: 3, interpretations: 1, reviews: 1, submissions: 1, receipts: 1, improvements: 1, sessions: 1 });
  assert.deepEqual([...result.not_covered], ["host_original_records", "copies_exported_by_the_user"]);
  const remaining = [...store.data.keys()];
  assert.equal(remaining.some((k) => k.includes("/s1/") || k.startsWith("interpretations/task-a") || k.startsWith("receipts/") || k === "tasks/task-a"), false);
  assert.equal(remaining.includes(key("u1", "s2")), true);
  assert.equal([...store.data.values()].some((v) => v.includes("새 직원이 주문을") && !v.includes('"session":"s2"')), false);
  // A retried hook cannot bring the deleted evidence back, and reinterpretation cannot cite it.
  const replay = await record.appendObservations(HOST, batch());
  assert.deepEqual([replay.stored, replay.refused_deleted], [0, 3]);
  await record.createTask({ id: "task-c", project: "hypeproof-studio", at: 13 });
  await throwsCode(() => record.saveInterpretation("task-c", interp(batch(), { id: "interp-9" }), batch()), "deleted_evidence");
  assert.deepEqual((await record.records()).deleted_tasks, ["task-a"]);
});
