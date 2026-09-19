// Remote classroom operations client (#751): outbox durability, ack-only deletion,
// single-flight/backoff, cause classification, and the drift lock against the
// Service validator. Plain Node — no VS Code, no network.
import assert from "node:assert/strict";
import * as ops from "../src/classroomOps.ts";
const svc = await import("../../../worker/src/lib/classroom-ops.ts");
let n = 0; const ok = (name) => { n++; console.log("  ✓ " + name); };
const memoryStore = () => { let saved = null; return { saves: 0, async load() { return saved ? JSON.parse(saved) : null; }, async save(s) { this.saves++; saved = JSON.stringify(s); } }; };
let id = 0; const uuid = () => `event-${String(++id).padStart(8, "0")}`;

// ── drift lock: every builder output passes the Service validator; its key set is the Service's ──
{
  const samples = { activation: [ops.activationPayload("token_verified", { tokenJti: "11111111-2222-4333-8444-555555555555", tokenExp: 1790000000 }), ops.activationPayload("token_rejected", { reason: "auth_signature", httpStatus: 401 })], step: [ops.stepPayload("m2026.09.18-1", "in_progress", "build"), ops.stepPayload("m2026.09.18-1", "free_activity")], runtime: [ops.runtimePayload("waiting_approval")], error: [ops.errorPayload("network", { blocking: false }), ops.errorPayload("auth_expired", { code: "http_401", requestId: "req-1234-abcd", blocking: true, cleared: true })], upload: [ops.uploadPayload("uploaded", 2)], evidence: [ops.evidencePayload("decision"), ops.evidencePayload("change", { sourceState: "real", stepId: "build", before: "a".repeat(64), after: "b".repeat(64) })] };
  assert.equal(ops.evidencePayload("action").source_state, "unverified", "an unstated source is never reported as real"); assert.deepEqual(Object.keys(ops.evidencePayload("change", { before: "index.html", stepId: "../x" })), ["evidence_type", "source_state"], "names and paths cannot ride in a digest field");
  for (const [kind, list] of Object.entries(samples)) for (const p of list) { const v = svc.validatePayload(kind, p); assert.ok(v.ok, `${kind} ${JSON.stringify(p)} → ${v.error}`); assert.ok(Object.keys(p).every((k) => ops.CLIENT_OPS_PAYLOAD_KEYS[kind].includes(k))); }
  // Negative control: the Service refuses a key the client list does not know, so the lists cannot drift silently.
  for (const kind of Object.keys(ops.CLIENT_OPS_PAYLOAD_KEYS)) assert.equal(svc.validatePayload(kind, { ...samples[kind][0], extra_field: "x" }).ok, false);
  // Unsafe text never reaches a payload: it is dropped, not sent.
  const e = ops.errorPayload("unknown", { code: "/Users/kid/내 파일.html", requestId: "학생이 쓴 글", blocking: true }); assert.deepEqual(Object.keys(e).sort(), ["blocking", "class"]);
  assert.deepEqual([...ops.OPS_CLIENT_CAPABILITIES], ["observe"]); assert.equal(ops.OPS_SCHEMA_VERSION, svc.OPS_SCHEMA_VERSION);
  ok("payload builders match the Service allowlist; unsafe strings are dropped");
}
// ── cause classification: a bare 401 is never "expired" ──
{
  const c = ops.classifyFailure;
  assert.equal(c({ status: 401 }), "auth_rejected"); assert.equal(c({ status: 401, code: "expired" }), "auth_expired"); assert.equal(c({ status: 401, code: "signature" }), "auth_signature"); assert.equal(c({ status: 401, code: "revoked" }), "auth_revoked");
  assert.equal(c({ status: 403, code: "session_inactive" }), "class_not_open"); assert.equal(c({ status: 403, code: "not_in_roster" }), "roster_missing"); assert.equal(c({ status: 403 }), "unknown");
  assert.equal(c({ status: 429 }), "provider_rate_limit"); assert.equal(c({ status: 503 }), "provider_5xx"); assert.equal(c({ networkError: true }), "network"); assert.equal(c({ status: 0 }), "network");
  for (const v of [c({ status: 401 }), c({ status: 418 })]) assert.ok(svc.ERROR_CLASSES.includes(v));
  ok("classification names only what was observed");
}
// ── outbox: persisted before send, deleted only by the contiguous cursor, survives restart, refuses loudly at the cap ──
{
  const store = memoryStore(); let box = await ops.OpsOutbox.open(store, "grant-a", "stream-0001", () => 1000, uuid);
  await box.add("runtime", ops.runtimePayload("running")); await box.add("runtime", ops.runtimePayload("idle")); await box.add("error", ops.errorPayload("network", { blocking: false }));
  assert.deepEqual(box.batch().map((e) => e.seq), [1, 2, 3]); assert.ok(store.saves >= 4);
  assert.equal(await box.acked("another-stream", 3), 0); assert.equal(await box.acked("stream-0001", 2), 2); assert.deepEqual(box.batch().map((e) => e.seq), [3]);
  box = await ops.OpsOutbox.open(store, "grant-a", "stream-0002", () => 2000, uuid); // restart
  assert.equal(box.bootId, "stream-0001"); await box.add("runtime", ops.runtimePayload("running")); assert.deepEqual(box.batch().map((e) => e.seq), [3, 4], "no hole and no reused seq after a restart");
  const other = await ops.OpsOutbox.open(store, "grant-b", "stream-0003", () => 3000, uuid); assert.equal(other.pending, 0, "another seat's grant never inherits these events"); assert.equal(other.bootId, "stream-0003");
  const cap = await ops.OpsOutbox.open(memoryStore(), "grant-c", "stream-0004", () => 1, uuid); for (let i = 0; i < ops.OUTBOX_CAP; i++) await cap.add("runtime", ops.runtimePayload("idle"));
  assert.equal(await cap.add("runtime", ops.runtimePayload("running")), false); assert.equal(cap.refused, 1); assert.equal(cap.batch()[0].seq, 1, "oldest evidence is kept");
  assert.ok(cap.batch().length <= ops.MAX_BATCH_EVENTS && JSON.stringify(cap.batch()).length <= 64 * 1024);
  ok("outbox durability, ack-only deletion, restart continuity, grant isolation, explicit cap");
}
// ── sync loop ──
{
  const timers = []; const deps = (post, box, extra = {}) => ({ post, outbox: box, appInstanceId: "instance-0001", sample: () => ({ idle_ms: 10 }), now: () => 5, random: () => 0.5, setTimeout: (fn, ms) => { timers.push(ms); return fn; }, clearTimeout() {}, onDisconnected() {}, ...extra });
  const box = await ops.OpsOutbox.open(memoryStore(), "grant-a", "stream-0001", () => 1, uuid); await box.add("runtime", ops.runtimePayload("running"));
  // 2xx without an ack deletes nothing (HTTP success is not an ack).
  let loop = ops.startOpsSync(deps(async () => ({ status: 200, body: {} }), box)); await loop.tick(); assert.equal(box.pending, 1); loop.stop();
  // 503/timeout/0: bounded backoff 5→10→20→60→60, evidence kept.
  timers.length = 0; loop = ops.startOpsSync(deps(async () => ({ status: 0 }), box)); timers.length = 0; for (let i = 0; i < 5; i++) await loop.tick(); assert.deepEqual(timers, [5000, 10000, 20000, 60000, 60000]); assert.equal(box.pending, 1); loop.stop();
  // Single-flight: a second tick during a slow request sends nothing.
  let calls = 0, release; loop = ops.startOpsSync(deps(() => { calls++; return new Promise((r) => { release = () => r({ status: 200, body: { ack: { boot_id: "stream-0001", contiguous_seq: 1, missing: [] }, poll_after_ms: 30000 } }); }); }, box));
  const first = loop.tick(); await loop.tick(); assert.equal(calls, 1); timers.length = 0; release(); await first; assert.equal(box.pending, 0); assert.deepEqual(timers, [30000], "Service-set cadence is honoured"); loop.stop();
  // 401 stops for good and tells the host; 429 honours Retry-After; feature-off polls rarely and keeps evidence.
  let gone = ""; loop = ops.startOpsSync(deps(async () => ({ status: 401, body: { reason: "ops_grant_revoked" } }), box, { onDisconnected: (r) => { gone = r; } })); await loop.tick(); assert.equal(gone, "ops_grant_revoked"); assert.equal(loop.state, "stopped");
  timers.length = 0; loop = ops.startOpsSync(deps(async () => ({ status: 429, retryAfterSec: 90 }), box)); timers.length = 0; await loop.tick(); assert.deepEqual(timers, [90000]); loop.stop();
  await box.add("runtime", ops.runtimePayload("idle")); timers.length = 0; loop = ops.startOpsSync(deps(async () => ({ status: 403, body: { reason: "ops_observe_disabled", poll_after_ms: 60000 } }), box)); timers.length = 0; await loop.tick(); assert.deepEqual(timers, [60000]); assert.equal(box.pending, 1); assert.equal(loop.state, "running"); loop.stop();
  // Jitter stays within ±20 %.
  for (const r of [0, 0.999]) { timers.length = 0; const l = ops.startOpsSync(deps(async () => ({ status: 0 }), box, { random: () => r })); assert.ok(timers[0] >= 4000 && timers[0] <= 6000); l.stop(); }
  ok("sync: ack-only deletion, bounded backoff, single-flight, Service cadence, 401 stop, Retry-After, feature-off, jitter");
}
{
  const g = new ops.ChangeGate(); assert.deepEqual(g.next({ status: "idle" }), { status: "idle" }); assert.equal(g.next({ status: "idle" }), null); assert.ok(g.next({ status: "running" }));
  assert.deepEqual(ops.tokenIdentityUnverified("not-a-token"), {}); const t = Buffer.from(JSON.stringify({ jti: "11111111-2222-4333-8444-555555555555", exp: 9 })).toString("base64url") + ".sig"; assert.deepEqual(ops.tokenIdentityUnverified(t), { jti: "11111111-2222-4333-8444-555555555555", exp: 9 });
  ok("change gate and token identity");
}
console.log(`classroom-ops.smoke: ${n} checks passed`);
