// CR-T10, measurement-core half (cr-browser #1391). Jay's decision 8 (2026-10-01): a
// browser result's artifact references are ADDITIVE, OPTIONAL keys on hps-observation/1
// and /2 (`BROWSER_RESULT_REF_KEYS`), and the bytes its digests name are stored on the
// same local record (`LocalRecord.putBlob`). Positive controls: valid references pass on
// both formats, an earlier record reads exactly as before, stored bytes resolve to their
// digest. Negative controls: references on the wrong event, malformed, or a byte digest
// without its version are refused; tampered or missing bytes never resolve.
//
// Run: node --experimental-strip-types --test test/cr-browser-refs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const core = await import("../src/lib/measurement-core/index.ts");
const { validateObservation, observableAssets, BROWSER_RESULT_REF_KEYS, LocalRecord, digestOf, redactDeep } = core;

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const VERSION = sha("file-set");
const SHOT = sha("jpeg");
const TRACE = sha("trace");
const ev = (seq, kind, extra = {}) => ({ id: `e${seq}`, seq, task: "t1", at: seq, kind, text: `${kind} ${seq}`, assistance: "unknown", ...extra });
const batch = (format, events) => ({ format, scope: "synthetic-cr", session: "s1", program: "p1", events });
const request = ev(1, "tool_request", { tool_id: "c1" });
const refs = { artifact_version: VERSION, screenshot_digest: SHOT, trace_digest: TRACE };

test("the reference keys are exactly the three decision 8 names", () => {
  assert.deepEqual([...BROWSER_RESULT_REF_KEYS], ["artifact_version", "screenshot_digest", "trace_digest"]);
});

test("positive: a tool_result with its references is valid on /1 and /2 and keeps them", () => {
  for (const format of ["hps-observation/1", "hps-observation/2"]) {
    const { batch: b } = validateObservation(batch(format, [request, ev(2, "tool_result", { tool_id: "c1", outcome: "success", ...refs })]));
    assert.equal(b.format, format, "the format is not moved");
    assert.deepEqual(BROWSER_RESULT_REF_KEYS.map((k) => b.events[1][k]), [VERSION, SHOT, TRACE]);
  }
  // The version alone is enough: bytes that could not be stored are simply not named.
  validateObservation(batch("hps-observation/1", [request, ev(2, "tool_result", { tool_id: "c1", outcome: "success", artifact_version: VERSION })]));
});

test("positive: a record written before the keys reads exactly as before", () => {
  const old = batch("hps-observation/1", [request, ev(2, "tool_result", { tool_id: "c1", outcome: "success" }), ev(3, "artifact", { sha256: "a".repeat(64) })]);
  const { batch: b, missing } = validateObservation(structuredClone(old));
  assert.deepEqual(b.events, old.events);
  assert.deepEqual(missing, []);
});

test("references never count as a revision or as execution on their own", () => {
  const plain = batch("hps-observation/1", [request, ev(2, "tool_result", { tool_id: "c1", outcome: "success" })]);
  const withRefs = batch("hps-observation/1", [request, ev(2, "tool_result", { tool_id: "c1", outcome: "success", ...refs, artifact_version: sha("v2") })]);
  assert.deepEqual(observableAssets(validateObservation(withRefs).batch), observableAssets(validateObservation(plain).batch));
});

test("negative: references on another kind, malformed, or a byte digest without its version are refused", () => {
  const refused = (e, code = /invalid_artifact_reference/) => assert.throws(() => validateObservation(batch("hps-observation/1", [request, e])), code);
  refused(ev(2, "user", { artifact_version: VERSION }));
  refused(ev(2, "tool_request", { tool_id: "c2", artifact_version: VERSION }));
  refused(ev(2, "artifact", { sha256: "a".repeat(64), artifact_version: VERSION }));
  refused(ev(2, "tool_result", { tool_id: "c1", outcome: "success", artifact_version: "v0" }));
  refused(ev(2, "tool_result", { tool_id: "c1", outcome: "success", artifact_version: VERSION.slice(7) }), /invalid_artifact_reference/);
  refused(ev(2, "tool_result", { tool_id: "c1", outcome: "success", artifact_version: VERSION, screenshot_digest: 7 }));
  refused(ev(2, "tool_result", { tool_id: "c1", outcome: "success", screenshot_digest: SHOT }));
  refused(ev(2, "tool_result", { tool_id: "c1", outcome: "success", trace_digest: TRACE }));
  // Control: any other unknown key is still the old refusal.
  refused(ev(2, "tool_result", { tool_id: "c1", outcome: "success", artifact_files: [] }), /invalid_event/);
});

function memoryPort() {
  const store = new Map();
  return {
    store,
    read: async (k) => store.get(k) ?? null,
    write: async (k, v, o) => { if (o?.ifAbsent && store.has(k)) throw new Error("exists"); store.set(k, v); },
    list: async (p) => [...store.keys()].filter((k) => k.startsWith(p)).sort(),
    remove: async (k) => { store.delete(k); },
  };
}

test("positive: stored bytes resolve to exactly their digest; storing again is a no-op", async () => {
  const port = memoryPort();
  const record = new LocalRecord(port);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 250]);
  const d = await record.putBlob({ media_type: "image/jpeg", base64: jpeg.toString("base64") });
  assert.equal(d, sha(jpeg));
  const back = await record.getBlob(d);
  assert.equal(back.media_type, "image/jpeg");
  assert.deepEqual(Buffer.from(back.bytes), jpeg);
  assert.equal(await record.putBlob({ media_type: "image/jpeg", base64: jpeg.toString("base64") }), d);
  assert.equal([...port.store.keys()].filter((k) => k.startsWith("blobs/")).length, 1, "same bytes, one record");
  // JSON: the digest is digestOf of the stored (redacted) value, so it equals what a caller computes.
  const trace = { tool: "browser_type", input: { ref: "e3", text: "hello" }, outcome: "success", step: 3, document_generation: "L0" };
  const t = await record.putBlob({ media_type: "application/json", json: trace });
  assert.equal(t, await digestOf(trace));
  assert.deepEqual(JSON.parse(new TextDecoder().decode((await record.getBlob(t)).bytes)), trace);
  // A blob is not a task, an observation or a receipt, but the record's own view shows it (MC-27).
  const mine = await record.records();
  assert.deepEqual(mine.tasks, []);
  assert.equal(mine.browser_results.stored, 2);
  assert.ok(mine.browser_results.bytes > 0);
});

test("negative: a secret in a trace never reaches storage; tampered, missing or malformed bytes never resolve", async () => {
  const port = memoryPort();
  const record = new LocalRecord(port);
  const secret = { tool: "browser_type", input: { text: "sk-ant-" + "x".repeat(30) } };
  const d = await record.putBlob({ media_type: "application/json", json: secret });
  assert.equal(d, await digestOf(redactDeep(secret)), "the digest names the redacted bytes");
  const stored = [...port.store.values()].join("");
  assert.equal(stored.includes("sk-ant-"), false);
  assert.equal(Buffer.from(JSON.parse(port.store.get(`blobs/${d.slice(7)}`)).data, "base64").toString().includes("sk-ant-"), false);

  const img = await record.putBlob({ media_type: "image/png", base64: Buffer.from("PNGBYTES").toString("base64") });
  const key = `blobs/${img.slice(7)}`;
  const tampered = JSON.parse(port.store.get(key));
  tampered.data = Buffer.from("OTHERBYTES").toString("base64");
  port.store.set(key, JSON.stringify(tampered));
  await assert.rejects(record.getBlob(img), /corrupt_record/, "bytes that do not hash to their key are refused");
  assert.equal(await record.getBlob(sha("never stored")), null);
  await assert.rejects(record.getBlob("sha256:xyz"), /invalid_digest/);
  await assert.rejects(record.putBlob({ media_type: "text/html", base64: "PGI+" }), /invalid_blob/);
  await assert.rejects(record.putBlob({ media_type: "image/png", base64: "not base64!" }), /invalid_blob/);
  await assert.rejects(record.putBlob({ media_type: "image/png", base64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }), /blob_too_large/);
  const full = new LocalRecord(memoryPort(), { maxBlobBytes: 100 });
  await assert.rejects(full.putBlob({ media_type: "image/png", base64: Buffer.alloc(200, 7).toString("base64") }), /capacity_exceeded/);
  // A port that loses the write: no digest is handed out.
  const lossy = memoryPort();
  lossy.write = async () => {};
  await assert.rejects(new LocalRecord(lossy).putBlob({ media_type: "image/png", base64: "UE5H" }), /storage_failure/);
});

// ── Lifecycle of the stored bytes (review r1: owner, delete path, bound, quota) ─────

const png = (n, fill) => Buffer.alloc(n, fill).toString("base64");
const blobKeys = (port) => [...port.store.keys()].filter((k) => k.startsWith("blobs/"));

/** A port that reports exact usage itself (as FileRecordStorage does), not through LocalRecord's fallback. */
function countingPort() {
  const port = memoryPort();
  const sum = (p) => [...port.store].filter(([k]) => k.startsWith(p)).reduce((n, [, v]) => n + v.length, 0);
  return Object.assign(port, { usageBytes: async () => sum(""), usageOf: async (p) => sum(p) });
}

for (const [portName, makePort] of [["fallback count", memoryPort], ["port count", countingPort]])
test(`positive: browser-result bytes never count against the review data's limit (MC-35), ${portName}`, async () => {
  const port = makePort();
  const record = new LocalRecord(port, { maxBytes: 600, maxBlobBytes: 1024 * 1024 });
  for (let i = 0; i < 5; i++) await record.putBlob({ media_type: "image/png", base64: png(20_000, i + 1) }, { at: i });
  assert.equal(blobKeys(port).length, 5);
  assert.ok((await record.records()).browser_results.bytes > 600, "far more bytes than the review limit");
  // The review's own writes still fit: screenshots do not crowd out the local review.
  await record.createTask({ id: "task-a", project: "p", at: 1 });
  await record.createTask({ id: "task-b", project: "p", at: 1 });
  assert.ok((await record.usage()).bytes < 600);
  // Control: review data itself is still bounded (a third task does not fit 600).
  await assert.rejects(record.createTask({ id: "task-c", project: "p", at: 1 }), /capacity_exceeded/);
});

test("positive: the bytes are bounded on their own; the oldest go first and review data is never touched", async () => {
  const port = memoryPort();
  const record = new LocalRecord(port, { maxBlobBytes: 3 * 30_000 });
  await record.createTask({ id: "task-a", project: "p", at: 1 });
  const d = [];
  for (let i = 0; i < 5; i++) d.push(await record.putBlob({ media_type: "image/png", base64: png(20_000, i + 1) }, { at: 100 + i }));
  assert.ok((await record.records()).browser_results.bytes <= 3 * 30_000);
  assert.equal(await record.getBlob(d[0]), null, "the oldest capture was removed");
  assert.ok(await record.getBlob(d[4]), "the newest is kept");
  assert.equal((await record.records()).browser_results.stored, blobKeys(port).length);
  assert.ok(await record.getTask("task-a"), "review data untouched");
  // Negative: one capture larger than the whole bound is refused, nothing is evicted for it.
  const before = blobKeys(port).length;
  await assert.rejects(new LocalRecord(port, { maxBlobBytes: 1000 }).putBlob({ media_type: "image/png", base64: png(5000, 9) }), /capacity_exceeded/);
  assert.equal(blobKeys(port).length, before);
});

test("positive: deleteBlobs removes every stored capture, or just the named ones, and records() says so", async () => {
  const port = memoryPort();
  const record = new LocalRecord(port);
  const a = await record.putBlob({ media_type: "image/png", base64: png(10, 1) });
  const b = await record.putBlob({ media_type: "image/png", base64: png(10, 2) });
  await assert.rejects(record.deleteBlobs({ by: "adapter_explicit", at: 1 }), /delete_requires_user/);
  assert.deepEqual(await record.deleteBlobs({ by: "user", at: 1, digests: [a] }), { removed: 1 });
  assert.equal(await record.getBlob(a), null);
  assert.ok(await record.getBlob(b));
  assert.deepEqual(await record.deleteBlobs({ by: "user", at: 2 }), { removed: 1 });
  assert.deepEqual((await record.records()).browser_results.stored, 0);
  assert.deepEqual([...port.store.keys()].filter((k) => k.startsWith("blob")), [], "no bytes and no age markers left");
});

test("negative: a delete interrupted mid-way never leaves bytes without their age marker", async () => {
  const port = memoryPort();
  const record = new LocalRecord(port);
  await record.putBlob({ media_type: "image/png", base64: png(10, 1) });
  await record.putBlob({ media_type: "image/png", base64: png(10, 2) });
  const remove = port.remove;
  port.remove = async (k) => { if (k.startsWith("blobs/")) throw new Error("disk gone"); return remove(k); };
  await assert.rejects(record.deleteBlobs({ by: "user", at: 1 }));
  const markers = new Set([...port.store.keys()].filter((k) => k.startsWith("blob-order/")).map((k) => k.slice(-64)));
  assert.equal(blobKeys(port).length, 2, "instrument: the bytes are still there");
  for (const k of blobKeys(port)) assert.ok(markers.has(k.slice("blobs/".length)), `${k} is still findable by the bound`);
  // Control: once the port works again the same delete clears everything.
  port.remove = remove;
  assert.deepEqual(await record.deleteBlobs({ by: "user", at: 2 }), { removed: 2 });
  assert.deepEqual([...port.store.keys()].filter((k) => k.startsWith("blob")), []);
});

// Unit level only: in Studio no local-record observation names these digests today (the
// browser-result events live in the workspace's native observation batch), so this path
// covers a future import that carries them, not the student's delete (the results command).
test("positive: deleting a task removes the bytes its observations name; bytes another observation names stay", async () => {
  const port = memoryPort();
  const record = new LocalRecord(port);
  const shotA = await record.putBlob({ media_type: "image/png", base64: png(10, 1) });
  const traceA = await record.putBlob({ media_type: "application/json", json: { tool: "browser_click", step: 1 } });
  const shared = await record.putBlob({ media_type: "image/png", base64: png(10, 3) });
  const loose = await record.putBlob({ media_type: "image/png", base64: png(10, 4) });
  const result = (seq, shot, trace) => ev(seq, "tool_result", { tool_id: `c${seq - 1}`, outcome: "success", artifact_version: VERSION, screenshot_digest: shot, ...(trace ? { trace_digest: trace } : {}) });
  for (const [task, session, events] of [
    ["task-a", "s1", [ev(1, "tool_request", { tool_id: "c1" }), result(2, shotA, traceA), ev(3, "tool_request", { tool_id: "c3" }), result(4, shared)]],
    ["task-b", "s2", [ev(1, "tool_request", { tool_id: "c1" }), result(2, shared)]],
  ]) {
    await record.createTask({ id: task, project: "p", at: 1 });
    await record.linkSession(task, { host: "studio", session_id: session, by: "user", at: 1 });
    await record.appendObservations("studio", { format: "hps-observation/1", scope: "synthetic-cr", session, program: "p1", events });
  }
  const out = await record.deleteTask("task-a", { by: "user", at: 5 });
  assert.equal(out.removed.browser_result_bytes, 2);
  assert.equal(await record.getBlob(shotA), null, "the task's screenshot is gone");
  assert.equal(await record.getBlob(traceA), null, "the task's trace is gone");
  assert.ok(await record.getBlob(shared), "bytes task-b still names stay");
  assert.ok(await record.getBlob(loose), "bytes no task names are not the task's");
  assert.ok(out.not_covered.includes("browser_result_bytes_not_named_by_the_task"), "and the result says so instead of claiming them");
});
