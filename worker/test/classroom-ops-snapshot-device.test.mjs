// #751 R4 — device snapshot uploader against the REAL Service collection routes
// (in-process, SQLite + in-memory R2). Not a real spool directory, a real offline
// laptop or real R2. Lives in the Service suite because it needs the Service's
// dependencies, which the extension CI job does not install; the device module
// under test imports only node built-ins.
import assert from "node:assert/strict";
import { localOps } from "./harness/classroom-ops.mjs";
import { freezeSnapshot, uploadSnapshot } from "../../extensions/hypeproof-chat/src/evidenceSnapshot.ts";
let n = 0; const ok = (name) => { n++; console.log("  ✓ " + name); };
const f = await localOps();
try {
  await f.freeze(); assert.equal((await f.configure([{ seat_id: "A1", student_id: "student-a" }], 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true } })).status, 201);
  const a1 = (await f.pair("A1", 1, 1)).conn.json; const enc = (s) => new TextEncoder().encode(s);
  assert.equal((await f.request("/v1/classroom/ops/collect/consent", "POST", { consent: true, purpose: "class_report", notice_version: "notice-v1" }, a1.credential)).status, 201);
  const newBatch = async () => (await f.request(f.base + "/report-batches", "POST", { idempotency_key: crypto.randomUUID(), roster_revision: 1, purpose: "class_report", notice_version: "notice-v1", dry_run: false })).json.batch.id;
  // The scope is what the Service returned at pairing; the copy is made by the App's real freezer (review F1).
  const scopeOf = (c) => ({ grant_id: c.grant_id, class_run_id: c.class_run_id, seat_id: c.seat_id, student: c.student, activity: c.lesson ? { course_id: c.lesson.course_id, version: c.lesson.version } : null, run: c.run });
  let scope = scopeOf(a1), spool = { "session.meta.json": f.metaFor(a1), "events.jsonl": '{"seq":1,"type":"prompt"}\n{"seq":2,"type":"turn_end"}\n', "secret.txt": "must never be sent" };
  // What the live SessionSpool reports together with the bytes (2026-09-21 sequence contract): its own counter and the other
  // sessions of this learner in the class window. Here: one healthy session whose counter is the last seq written.
  const liveSource = () => ({ sequence: { session_id: JSON.parse(spool["session.meta.json"]).session_id, last_seq: Math.max(0, ...spool["events.jsonl"].split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).seq ?? 0; } catch { return 0; } })) }, other_sessions: 0 });
  let offline = 0, puts = [];
  const deps = (frozen = new Map()) => { let saved = null; return {
    // The copy is taken once per (batch, revision) and then never changes, whatever the live spool does.
    scope: () => scope,
    copy: async (b, rev) => { const k = b + ":" + rev; if (!frozen.has(k)) { const fr = freezeSnapshot(Object.entries(spool).map(([name, text]) => ({ name, data: enc(text) })), scope, b, { purpose: "class_report", notice_version: "notice-v1" }, Date.now(), liveSource()); if (!fr.ok) return { code: fr.code }; frozen.set(k, { files: fr.files, binding: fr.binding }); } return frozen.get(k); },
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
    // Shared PC / unattributed record: the spool belongs to another learner, or to nobody. Nothing leaves the device.
    const mine = spool; puts = [];
    spool = { ...mine, "session.meta.json": f.metaFor(a1, { user: { u: "student-b", c: a1.student.c, p: a1.student.p } }), "events.jsonl": '{"seq":1,"type":"prompt"}\n' }; assert.deepEqual(await uploadSnapshot(await newBatch(), deps()), { ok: false, code: "identity_mismatch" });
    spool = { ...spool, "session.meta.json": f.metaFor(a1, { user: null }) }; assert.deepEqual(await uploadSnapshot(await newBatch(), deps()), { ok: false, code: "identity_unbound" }); assert.deepEqual(puts, [], "another learner's or an unattributed spool is never sent under this seat");
    // Another activity on the same PC, earlier that day: outside the class window, so it is not part of the copy.
    const early = new Date(a1.run.starts_at - 3 * 3_600_000).toISOString(), inClass = new Date(a1.run.starts_at + 1000).toISOString();
    spool = { ...mine, "events.jsonl": JSON.stringify({ type: "prompt", ts: early, text: "EARLIER PERSONAL WORK" }) + "\n" + JSON.stringify({ type: "prompt", ts: inClass, text: "CLASS WORK" }) + "\n" };
    const windowed = deps(), wb = await newBatch(); assert.deepEqual(await uploadSnapshot(wb, windowed), { ok: true, code: "receipt_verified" }); assert.equal(windowed.peek().binding.range.lines, 1);
    assert.ok(![...f.r2.values()].some((v) => new TextDecoder().decode(v.body ?? v).includes("EARLIER PERSONAL WORK")), "events from before the class never reach the Service");
    // A pending copy frozen under another grant (previous learner, replaced seat) is not this credential's to send.
    const other = deps(); await other.saveState({ batch_id: wb, revision: 1, files: [], scope: { ...windowed.peek().scope, grant_id: "someone-elses-grant" }, binding: windowed.peek().binding }); puts = [];
    assert.deepEqual(await uploadSnapshot(wb, other), { ok: false, code: "foreign_pending_copy" }); assert.deepEqual(puts, []);
    spool = mine;
    const none = deps(); none.copy = async () => null; assert.deepEqual(await uploadSnapshot(await newBatch(), none), { ok: false, code: "nothing_recorded" });
    await f.request("/v1/classroom/ops/collect/consent", "POST", { consent: false, purpose: "class_report", notice_version: "notice-v1" }, a1.credential); spool = { ...spool, "events.jsonl": '{"seq":1}\n' };
    const before = f.r2.size; assert.deepEqual(await uploadSnapshot(b, deps()), { ok: false, code: "withdrawn" }); assert.equal(f.r2.size, before);
    ok("verification failure, nothing recorded and withdrawal are reported as such; nothing is stored after withdrawal");
  }
} finally { f.close(); }
console.log(`classroom-ops-snapshot-device: ${n} checks passed`);
