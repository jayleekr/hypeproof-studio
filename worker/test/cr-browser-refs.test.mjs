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
  // A blob is not a task, an observation or a receipt: the record's own views do not see it.
  assert.deepEqual((await record.records()).tasks, []);
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
  const full = new LocalRecord(memoryPort(), { maxBytes: 100 });
  await assert.rejects(full.putBlob({ media_type: "image/png", base64: Buffer.alloc(200, 7).toString("base64") }), /capacity_exceeded/);
  // A port that loses the write: no digest is handed out.
  const lossy = memoryPort();
  lossy.write = async () => {};
  await assert.rejects(new LocalRecord(lossy).putBlob({ media_type: "image/png", base64: "UE5H" }), /storage_failure/);
});
