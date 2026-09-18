// #751 R4 — device snapshot uploader against the REAL Service collection routes
// (in-process, SQLite + in-memory R2). Not a real spool directory, a real offline
// laptop or real R2.
import assert from "node:assert/strict";
import { uploadSnapshot } from "../src/evidenceSnapshot.ts";
import { localOps } from "../../../worker/test/harness/classroom-ops.mjs";
let n = 0; const ok = (name) => { n++; console.log("  ✓ " + name); };
const f = await localOps();
try {
  await f.freeze(); assert.equal((await f.configure([{ seat_id: "A1", student_id: "student-a" }], 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true } })).status, 201);
  const a1 = (await f.pair("A1", 1, 1)).conn.json; const enc = (s) => new TextEncoder().encode(s);
  assert.equal((await f.request("/v1/classroom/ops/collect/consent", "POST", { consent: true, purpose: "class_report", notice_version: "notice-v1" }, a1.credential)).status, 201);
  const newBatch = async () => (await f.request(f.base + "/report-batches", "POST", { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: "class_report", notice_version: "notice-v1", dry_run: false })).json.batch.id;
  let spool = { "session.meta.json": '{"session":"s1"}', "events.jsonl": '{"seq":1,"type":"prompt"}\n{"seq":2,"type":"turn_end"}\n', "secret.txt": "must never be sent" };
  let offline = 0, puts = [];
  const deps = (frozen = new Map()) => { let saved = null; return {
    // The copy is taken once per (batch, revision) and then never changes, whatever the live spool does.
    copy: async (b, rev) => { const k = b + ":" + rev; if (!frozen.has(k)) frozen.set(k, Object.entries(spool).map(([name, text]) => ({ name, data: enc(text) }))); return frozen.get(k); },
    loadState: async () => (saved ? JSON.parse(saved) : null), saveState: async (s) => { saved = JSON.stringify(s); }, peek: () => JSON.parse(saved),
    put: async (b, rev, name, data) => { if (offline-- > 0) return { status: 0 }; puts.push(name); const r = await f.app.fetch(new Request(`https://service.test/v1/classroom/ops/collect/snapshots/${b}/${rev}/${name}`, { method: "PUT", headers: { authorization: "Bearer " + a1.credential }, body: data }), f.env, { waitUntil() {} }); const j = await r.json().catch(() => ({})); return { status: r.status, reason: j.reason }; },
    seal: async (b, rev, manifest) => { const r = await f.request(`/v1/classroom/ops/collect/snapshots/${b}/${rev}/seal`, "POST", manifest, a1.credential); return { status: r.status, reason: r.json?.reason, receipt_id: r.json?.receipt_id, coverage: r.json?.coverage }; },
  }; };
  {
    const b = await newBatch(), d = deps(); assert.deepEqual(await uploadSnapshot(b, d), { ok: true, code: "receipt_verified" });
    assert.deepEqual(puts.sort(), ["events.jsonl", "session.meta.json"], "only allowlisted spool files leave the device"); assert.equal(d.peek().coverage, "complete");
    puts = []; assert.deepEqual(await uploadSnapshot(b, d), { ok: true, code: "receipt_verified" }); assert.deepEqual(puts, [], "a proven snapshot is not sent again");
    assert.equal((await f.request(f.base + "/report-batches/" + b)).json.items[0].state, "verified");
    ok("copy → upload → Service-verified receipt; allowlist only; idempotent afterwards");
  }
  {
    // Offline in the middle, the class goes on (the live spool grows), the laptop comes back: the SAME frozen copy is finished.
    const b = await newBatch(), d = deps(); puts = []; offline = 0; const first = d.put; let calls = 0; d.put = async (...a) => (++calls === 2 ? { status: 0 } : first(...a));
    assert.deepEqual(await uploadSnapshot(b, d), { ok: false, code: "offline_pending" }); assert.equal((await f.request(f.base + "/report-batches/" + b)).json.summary.verified, 0, "half an upload is not collected");
    spool = { ...spool, "events.jsonl": spool["events.jsonl"] + '{"seq":3,"type":"prompt"}\n' }; d.put = first;
    assert.deepEqual(await uploadSnapshot(b, d), { ok: true, code: "receipt_verified" }); assert.equal(d.peek().revision, 1); assert.equal(d.peek().files.find((x) => x.name === "events.jsonl").bytes, 54, "resumed the frozen copy, not the grown file");
    ok("offline mid-upload → pending, resumed later from the same immutable copy");
  }
  {
    // A second device state for the same batch (re-install): the Service already holds other bytes for r1 → r2, never an overwrite.
    const b = await newBatch(); assert.deepEqual(await uploadSnapshot(b, deps()), { ok: true, code: "receipt_verified" });
    spool = { ...spool, "events.jsonl": spool["events.jsonl"] + '{"seq":4,"type":"turn_end"}\n' }; const again = deps(); assert.deepEqual(await uploadSnapshot(b, again), { ok: true, code: "receipt_verified" }); assert.equal(again.peek().revision, 2);
    assert.equal((await f.request(f.base + "/report-batches/" + b)).json.items[0].input_revision, 2);
    ok("changed bytes become a new revision and a new input revision");
  }
  {
    const b = await newBatch(); spool = { ...spool, "events.jsonl": '{"seq":1,"user":"student-b"}\n' }; assert.deepEqual(await uploadSnapshot(b, deps()), { ok: false, code: "foreign_events" });
    const none = deps(); none.copy = async () => null; assert.deepEqual(await uploadSnapshot(await newBatch(), none), { ok: false, code: "nothing_recorded" });
    await f.request("/v1/classroom/ops/collect/consent", "POST", { consent: false, purpose: "class_report", notice_version: "notice-v1" }, a1.credential); spool = { ...spool, "events.jsonl": '{"seq":1}\n' };
    const before = f.r2.size; assert.deepEqual(await uploadSnapshot(b, deps()), { ok: false, code: "withdrawn" }); assert.equal(f.r2.size, before);
    ok("verification failure, nothing recorded and withdrawal are reported as such; nothing is stored after withdrawal");
  }
} finally { f.close(); }
console.log(`evidence-snapshot.smoke: ${n} checks passed`);
