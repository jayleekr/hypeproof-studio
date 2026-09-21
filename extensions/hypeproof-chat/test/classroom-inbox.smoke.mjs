// Remote classroom operations (#751, U2) — the learner's inbox of instructor notices/materials, on a REAL directory.
// AT-44 D8/D9 device half. What is proven: material already held is never lost to an interrupted update; a late v1 never
// replaces v2; a withdrawal and an offer end the same way whichever arrives first; a writer that was paused (or another
// window) can never overwrite a newer index and never claims "reflected" for what is not shown; an item fetched before a
// restart, a sleep, or a slow answer is not applied after it; an acknowledgement clears only the entry with its own key.
// Every interference is preceded by the undisturbed control. macOS/APFS here — Windows link/rename behaviour is NOT RUN.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as inbox from "../src/classroomInbox.ts";
import { InboxSession, InboxStore, inboxDir, inboxView } from "../src/classroomInboxStore.ts";

let count = 0; async function check(name, fn) { await fn(); count++; console.log("PASS " + name); }
const sha = (s) => createHash("sha256").update(s).digest("hex"), hex32 = (s) => sha(s).slice(0, 32);
const OBJ = "11111111-1111-4111-8111-111111111111", OBJ2 = "22222222-2222-4222-8222-222222222222";
const item = (revision, seq, o = {}) => { const c = { kind: "material", title: "자료 M", body: "v" + revision + " 본문", links: [], ...o.content }; return { offer_key: hex32("offer" + revision + seq + (o.k ?? "")), distribution_id: "dddddddd-dddd-4ddd-8ddd-" + String(seq).padStart(12, "0"), seq, object_id: o.object ?? OBJ, revision, schema: inbox.CONTENT_SCHEMA, ...c, content_hash: o.hash ?? sha(inbox.contentCanonical(c)), issued_at: 1, expires_at: 2, apply_within_ms: 30000, from: "instructor" }; };
const dirs = []; const fresh = () => { const d = mkdtempSync(path.join(tmpdir(), "hps-inbox-")); dirs.push(d); return d; };
const clockAt = (mono = 0, wall = 1_000_000) => ({ t: { mono, wall }, mono() { return this.t.mono; }, wall() { return this.t.wall; } });
const session = (dir, o = {}) => { const clock = o.clock ?? clockAt(), store = new InboxStore(dir, o.hooks ?? {}); let alive = true, changes = 0; const s = new InboxSession({ store, alive: () => alive, clock, changed: () => { changes++; } }); return { s, store, clock, kill: () => { alive = false; }, changes: () => changes, win: () => ({ monoStart: clock.t.mono, wallStart: clock.t.wall }) }; };
const cardsOf = async (dir) => (await new InboxStore(dir).read()).cards.map((c) => [c.object_id === OBJ ? "M" : "other", c.revision, c.withdrawn ? "withdrawn" : c.unreadable ? "unreadable" : c.body]);
const journalOf = async (dir) => (await new InboxStore(dir).current()).index.journal.map((j) => j.type === "offer" ? `${j.stage}:r${j.revision}${j.result_code ? ":" + j.result_code : ""}` : `withdraw:${j.result}`);

try {
  await check("controls: the hash is the Service's hash, the limits are the Service's limits, text is kept as text", async () => {
    const svc = await import("../../../worker/src/lib/classroom-distribution.ts"), c = { kind: "material", title: "제목", body: "<script>alert(1)</script> [x](javascript:alert(1)) rm -rf ~", links: [{ label: "문서", url: "https://docs.example.org/a" }] };
    assert.equal(inbox.contentCanonical(c), svc.contentCanonical(c)); assert.equal(sha(inbox.contentCanonical(c)), await svc.contentHash(c));
    for (const k of ["MAX_TITLE_CHARS", "MAX_BODY_CHARS", "MAX_BODY_BYTES", "MAX_LINKS", "MAX_LINK_LABEL_CHARS", "MAX_LINK_URL_CHARS", "MAX_SYNC_RECEIPTS", "MAX_SYNC_WITHDRAWS", "APPLY_WITHIN_MS", "CONTENT_SCHEMA"]) assert.equal(inbox[k], svc[k], k);
    assert.equal(inbox.INBOX_CAPABILITY, svc.DIST_CLIENT_CAPABILITY);
    const v = inbox.validateItem(item(1, 1, { content: c })); assert.equal(v.ok, true); assert.equal(v.value.body, c.body, "markup is not stripped, escaped or interpreted here — it is data, and it is drawn as text");
    for (const [bad, code] of [[{ kind: "prompt" }, "unsupported_kind"], [{ kind: "setting" }, "unsupported_kind"], [{ schema: "hps-classroom-content/9" }, "unsupported_kind"], [{ title: "" }, "schema"], [{ body: "가".repeat(2001) }, "schema"], [{ links: [{ label: "a", url: "http://docs.example.org/" }] }, "schema"], [{ links: [{ label: "a", url: "javascript:alert(1)" }] }, "schema"], [{ links: [{ label: "a", url: "file:///etc/passwd" }] }, "schema"], [{ links: [{ label: "a", url: "https://u:p@docs.example.org/" }] }, "schema"], [{ apply_within_ms: 0 }, "schema"], [{ apply_within_ms: 30001 }, "schema"], [{ offer_key: "short" }, "schema"]]) assert.equal(inbox.validateItem({ ...item(1, 1), ...bad }).code, code, JSON.stringify(bad));
  });

  await check("controls: one ordering rule — an event of an object applies only with a HIGHER number; an offer never lowers the revision", async () => {
    let ix = inbox.emptyIndex(); const d = (it) => inbox.decideOffer(ix, it, 100).action + (inbox.decideOffer(ix, it, 100).code ? ":" + inbox.decideOffer(ix, it, 100).code : "");
    assert.equal(d(item(1, 1)), "apply"); ix = inbox.applyOffer(ix, item(1, 1), "f1", 100, 5);
    assert.deepEqual([d(item(1, 1)), d(item(1, 3, { k: "again" })), d(item(1, 1, { hash: "f".repeat(64) })), d(item(2, 2))], ["noop", "noop", "failed:hash_conflict", "apply"]);
    ix = inbox.applyOffer(ix, item(2, 2), "f2", 100, 6);
    assert.deepEqual([d(item(1, 1)), d(item(1, 9))], ["superseded:newer_revision", "superseded:newer_revision"], "v1 after v2, however late and whatever its number");
    const w = (seq) => ({ withdraw_key: hex32("w" + seq), object_id: OBJ, seq, revision: 2, reason: "revoked" });
    assert.deepEqual([inbox.decideWithdraw(ix, w(1)), inbox.decideWithdraw(ix, w(3)), inbox.decideWithdraw(ix, { ...w(3), object_id: OBJ2 })], ["stale", "withdraw", "not_held"], "a withdrawal older than what is shown is stale");
    ix = inbox.applyWithdraw(ix, w(3), 7);
    assert.deepEqual([d(item(2, 2)), d(item(2, 3)), d(item(2, 4)), inbox.decideWithdraw(ix, w(3)), inbox.decideWithdraw(ix, w(2))], ["superseded:withdrawn_newer", "superseded:withdrawn_newer", "apply", "already", "already"], "after a withdrawal only a LATER offer brings the card back");
    let full = inbox.emptyIndex(); for (let i = 0; i < inbox.MAX_INBOX_OBJECTS; i++) full = inbox.applyOffer(full, item(1, 1, { object: "33333333-3333-4333-8333-" + String(i).padStart(12, "0") }), "f", 10, 1);
    assert.equal(inbox.decideOffer(full, item(1, 1), 10).code, "inbox_full", "nothing is silently pushed out"); assert.equal(inbox.decideOffer(inbox.applyOffer(inbox.emptyIndex(), item(1, 1, { object: OBJ2 }), "f", inbox.MAX_INBOX_BYTES, 1), item(1, 1), 1).code, "inbox_full");
  });

  await check("controls: an acknowledgement clears only ITS key and stage; a withdrawal's ack cannot clear an offer's entry, nor an old key a new one", async () => {
    const e = (key, stage) => ({ type: "offer", key, stage, distribution_id: "d", object_id: OBJ, revision: 1, content_hash: "h", seq: 1, result_code: "", observed_at: 1 }), wd = (key) => ({ type: "withdraw", key, object_id: OBJ, seq: 2, result: "withdrawn", observed_at: 1 });
    let ix = inbox.emptyIndex(); for (const j of [e("new-key", "received"), e("new-key", "reflected"), wd("same-string"), e("same-string", "reflected")]) ix = inbox.journalAdd(ix, j);
    assert.equal(inbox.journalAdd(ix, e("new-key", "reflected")), ix, "journaling the same receipt twice is one entry");
    const left = (o, w) => inbox.journalAck(ix, o, w).journal.map((j) => j.type + ":" + j.key + ":" + (j.stage ?? ""));
    assert.equal(left([{ offer_key: "old-key", stage: "reflected", recorded: true, reason: "" }], []).length, 4, "an acknowledgement of an OLDER offer key (before a re-login) clears nothing of the new one");
    assert.deepEqual(left([{ offer_key: "new-key", stage: "reflected", recorded: true, reason: "" }], []), ["offer:new-key:received", "withdraw:same-string:", "offer:same-string:reflected"]);
    assert.deepEqual(left([], [{ withdraw_key: "same-string", recorded: true, reason: "" }]), ["offer:new-key:received", "offer:new-key:reflected", "offer:same-string:reflected"], "same characters, other namespace: the offer's entry stays");
    assert.equal(left([{ offer_key: "new-key", stage: "reflected", recorded: false, reason: "storage", final: false }], []).length, 4, "the Service could not store it: keep and resend");
    assert.equal(left([{ offer_key: "new-key", stage: "reflected", recorded: false, reason: "stale_offer", final: true }], []).length, 3, "a final refusal is settled too");
    let many = inbox.emptyIndex(); for (let i = 0; i < inbox.MAX_JOURNAL; i++) many = inbox.journalAdd(many, e("k" + i, "reflected")); assert.equal(inbox.journalAdd(many, e("overflow", "reflected")), null, "a full journal refuses, it does not drop a receipt");
    assert.equal(inbox.pendingReceipts(many).receipts.length, inbox.MAX_SYNC_RECEIPTS);
  });

  await check("control: v1 arrives, then v2 — one card, reported reflected only after it came back through the read path; a restart shows the same card", async () => {
    const dir = fresh(), a = session(dir);
    assert.equal(await a.s.onBlock({ items: [item(1, 1)] }, a.win(), 10), true); assert.deepEqual(await cardsOf(dir), [["M", 1, "v1 본문"]]); assert.deepEqual(await journalOf(dir), ["received:r1", "reflected:r1"]);
    await a.s.onBlock({ receipt_acks: [{ offer_key: item(1, 1).offer_key, stage: "received", recorded: true, reason: "recorded" }, { offer_key: item(1, 1).offer_key, stage: "reflected", recorded: true, reason: "recorded" }], items: [item(2, 2)] }, a.win(), 11);
    assert.deepEqual(await cardsOf(dir), [["M", 2, "v2 본문"]]); assert.deepEqual(await journalOf(dir), ["received:r2", "reflected:r2"]); assert.equal(a.changes(), 2);
    const rebooted = session(dir); await rebooted.store.reconcile(Date.now() + 600_000); assert.deepEqual(await cardsOf(dir), [["M", 2, "v2 본문"]], "after a restart the card is read from disk, unchanged");
    assert.deepEqual((await rebooted.s.pending()).receipts.map((r) => r.stage), ["received", "reflected"], "and the receipts that were never acknowledged are still owed");
    assert.deepEqual(readdirSync(path.join(dir, "rev")).length, 1, "the replaced revision file is cleaned up only AFTER the index stopped pointing at it");
    const view = await inboxView(rebooted.store, { run: "r", student: "s", generation: 3, ended: false }); assert.deepEqual([view.cards.length, view.unread, view.cards[0].is_new], [1, 1, true]); await rebooted.s.markOpened(OBJ); assert.equal((await inboxView(rebooted.store, { run: "r", student: "s", generation: 3, ended: false })).unread, 0);
  });

  await check("D9 every commit boundary, with v1 already held: the process dies while v2 is being applied — v1 stays readable, nothing goes backwards, and \"reflected\" is never claimed for what is not shown", async () => {
    for (const point of ["rev_tmp_written", "rev_linked", "index_tmp_written", "index_linked"]) {
      const dir = fresh(), first = session(dir); await first.s.onBlock({ items: [item(1, 1)] }, first.win(), 10);
      await first.s.onBlock({ receipt_acks: ["received", "reflected"].map((stage) => ({ offer_key: item(1, 1).offer_key, stage, recorded: true, reason: "" })) }, first.win(), 10);
      let armed = true; const dying = session(dir, { hooks: { at: (p, detail) => { if (armed && p === point && (p.startsWith("rev") ? detail.includes(".2.") : true) && (!point.startsWith("index") || dying.calls++ >= 1) /* the first index commit of an offer only journals "received"; the second one moves the pointer */) { armed = false; throw new Error("power cut at " + p); } } } }); dying.calls = 0;
      await dying.s.onBlock({ items: [item(2, 2)] }, dying.win(), 11).catch(() => undefined);
      const after = await cardsOf(dir), journal = await journalOf(dir);
      if (point === "index_linked") { assert.deepEqual(after, [["M", 2, "v2 본문"]], point + ": the index had already moved — v2 is what is shown"); assert.ok(journal.includes("reflected:r2"), "…and it is shown, so reporting it is true"); }
      else { assert.deepEqual(after, [["M", 1, "v1 본문"]], point + ": v1 is still there, whole"); assert.ok(!journal.includes("reflected:r2"), point + ": no claim of v2"); }
      // restart: files the index does not point at are REMOVED, never promoted — the class may have ended meanwhile
      const again = session(dir); const r = await again.store.reconcile(Date.now() + 600_000); assert.deepEqual(await cardsOf(dir), after, point + ": reconcile changes nothing the learner sees");
      if (point === "rev_linked" || point === "index_tmp_written") assert.ok(r.removed.some((f) => f.includes(".2.")), point + ": the orphan v2 file is gone, not shown");
      assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")) && !readdirSync(path.join(dir, "rev")).some((f) => f.endsWith(".tmp")));
      // …and when the Service offers v2 again, it applies
      await again.s.onBlock({ items: [item(2, 2)] }, again.win(), 12); assert.deepEqual(await cardsOf(dir), [["M", 2, "v2 본문"]]);
    }
    // the disk refuses the index (the Windows case: another process holds the file) — v1 stays, the failure is reported
    const dir = fresh(), ok = session(dir); await ok.s.onBlock({ items: [item(1, 1)] }, ok.win(), 10);
    const refused = session(dir, { hooks: { fault: (op, file) => { if (op === "link" && /index\.\d+\.json$/.test(file) && refused.on) throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } } }); refused.on = false;
    refused.on = true; await refused.s.onBlock({ items: [item(2, 2)] }, refused.win(), 11); refused.on = false;
    assert.deepEqual(await cardsOf(dir), [["M", 1, "v1 본문"]]); assert.ok(!(await journalOf(dir)).includes("reflected:r2"));
    const full = session(dir, { hooks: { fault: (op, file) => { if (op === "write" && file.includes(path.sep + "rev" + path.sep)) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); } } });
    await full.s.onBlock({ items: [item(3, 3)] }, full.win(), 12); assert.deepEqual(await cardsOf(dir), [["M", 1, "v1 본문"]]);
  });

  await check("D8 late writers: v1 after v2, an offer after its withdrawal, and offer/withdrawal crossing in both orders end in the same place", async () => {
    const dir = fresh(), a = session(dir); await a.s.onBlock({ items: [item(1, 1)] }, a.win(), 10); await a.s.onBlock({ items: [item(2, 2)] }, a.win(), 11);
    await a.s.onBlock({ items: [item(1, 1, { k: "late" })] }, a.win(), 12); assert.deepEqual(await cardsOf(dir), [["M", 2, "v2 본문"]]); assert.ok((await journalOf(dir)).includes("superseded:r1:newer_revision"), "the late v1 is answered, not applied");
    const w3 = { withdraw_key: hex32("w3"), object_id: OBJ, seq: 3, revision: 2, reason: "revoked" };
    await a.s.onBlock({ withdraw: [w3] }, a.win(), 13); assert.deepEqual(await cardsOf(dir), [["M", 2, "withdrawn"]]); assert.ok(!existsSync(path.join(dir, "rev", a.store.revFile(item(2, 2)))), "the body left the disk with the withdrawal");
    await a.s.onBlock({ items: [item(2, 2, { k: "after-withdraw" })] }, a.win(), 14); assert.deepEqual(await cardsOf(dir), [["M", 2, "withdrawn"]], "a late offer (number ≤ the withdrawal's) does not bring it back"); assert.ok((await journalOf(dir)).includes("superseded:r2:withdrawn_newer"));
    await a.s.onBlock({ withdraw: [w3] }, a.win(), 15); assert.equal((await journalOf(dir)).filter((j) => j === "withdraw:withdrawn").length, 1, "a repeated withdrawal is one entry");
    const ends = []; for (const order of [["w", "o"], ["o", "w"]]) { const d2 = fresh(), s2 = session(d2); await s2.s.onBlock({ items: [item(1, 1)] }, s2.win(), 10); for (const step of order) await s2.s.onBlock(step === "w" ? { withdraw: [{ ...w3, revision: 1 }] } : { items: [item(1, 4, { k: "redistributed" })] }, s2.win(), 11); ends.push(JSON.stringify(await cardsOf(d2))); }
    assert.deepEqual(ends, [JSON.stringify([["M", 1, "v1 본문"]]), JSON.stringify([["M", 1, "v1 본문"]])], "withdrawal #3 and re-distribution #4 of the same revision: whichever arrives first, #4 wins");
    const d3 = fresh(), s3 = session(d3); await s3.s.onBlock({ withdraw: [{ ...w3, object_id: OBJ2 }] }, s3.win(), 10); assert.deepEqual(await journalOf(d3), ["withdraw:not_held"]); assert.equal((await inboxView(s3.store, { run: "r", student: "s", generation: 1, ended: false })).cards.length, 0, "a withdrawal of something never held leaves no card — only the number that keeps a late offer out");
    await s3.s.onBlock({ items: [item(1, 2, { object: OBJ2 })] }, s3.win(), 11); assert.equal((await inboxView(s3.store, { run: "r", student: "s", generation: 1, ended: false })).cards.length, 0);
  });

  await check("D9 two windows and a writer that was PAUSED (long I/O, SIGSTOP): the one that wakes up late cannot overwrite the newer index — there is no lock to steal", async () => {
    const dir = fresh(), seed = session(dir); await seed.s.onBlock({ items: [item(1, 1)] }, seed.win(), 10);
    let release, reached; const paused = new Promise((r) => { release = r; }), atGate = new Promise((r) => { reached = r; }); let gate = true;
    // window A is about to create the next index for v2 … and stops right there, alive, holding nothing
    const A = session(dir, { hooks: { at: async (p) => { if (gate && p === "index_tmp_written") { gate = false; reached(); await paused; } } } });
    const running = A.s.onBlock({ items: [item(2, 2)] }, A.win(), 11); await atGate;
    // window B (another extension host) applies v3 meanwhile — twice the index moves on
    const Bw = session(dir); await Bw.s.onBlock({ items: [item(3, 3)] }, Bw.win(), 12); assert.deepEqual(await cardsOf(dir), [["M", 3, "v3 본문"]]);
    release(); await running;
    assert.deepEqual(await cardsOf(dir), [["M", 3, "v3 본문"]], "the late writer lost the create-if-absent, re-read, and re-decided: v2 is superseded");
    const j = await journalOf(dir); assert.ok(j.includes("superseded:r2:newer_revision") && !j.includes("reflected:r2"), "and it does not claim v2 was reflected: " + j);
    const numbers = readdirSync(dir).filter((f) => /^index\.\d+\.json$/.test(f)).map((f) => Number(f.split(".")[1])).sort((x, y) => x - y); assert.equal(new Set(numbers).size, numbers.length);
    // many concurrent sessions on one directory: every receipt survives, the index numbers never collide
    const d2 = fresh(), all = Array.from({ length: 8 }, () => session(d2)); await Promise.all(all.map((w, i) => w.s.onBlock({ items: [item(1, i + 1, { object: "44444444-4444-4444-8444-" + String(i).padStart(12, "0") })] }, w.win(), 10)));
    assert.equal((await cardsOf(d2)).length, 8); assert.equal((await journalOf(d2)).filter((x) => x.startsWith("reflected")).length, 8, "no lost update across eight writers");
  });

  await check("D9 real processes: a writer killed (SIGKILL) in the middle of a commit leaves the held card whole; SIGSTOP/SIGCONT around a competing commit cannot go backwards", async () => {
    const dir = fresh(), seed = session(dir); await seed.s.onBlock({ items: [item(1, 1)] }, seed.win(), 10);
    const child = (rev, seq, pauseAt) => { const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(new URL("./fixtures/inbox-writer.mjs", import.meta.url)), dir, String(rev), String(seq), pauseAt], { stdio: ["ignore", "pipe", "inherit"] }); let out = ""; p.stdout.on("data", (b) => { out += b; }); return { p, until: (word) => new Promise((res, rej) => { const t = setInterval(() => { if (out.includes(word)) { clearInterval(t); res(out); } }, 10); p.on("exit", () => { clearInterval(t); out.includes(word) ? res(out) : rej(new Error("child exited: " + out)); }); }), done: new Promise((res) => p.on("exit", res)) }; };
    const killed = child(2, 2, "index_tmp_written"); await killed.until("PAUSED"); killed.p.kill("SIGKILL"); await killed.done;
    assert.deepEqual(await cardsOf(dir), [["M", 1, "v1 본문"]], "killed between the temp file and the link: v1 is intact"); await new InboxStore(dir).reconcile(Date.now() + 600_000); assert.deepEqual(await cardsOf(dir), [["M", 1, "v1 본문"]]);
    const stopped = child(2, 2, "index_tmp_written"); await stopped.until("PAUSED"); stopped.p.kill("SIGSTOP");
    const other = session(dir); await other.s.onBlock({ items: [item(3, 3)] }, other.win(), 12);
    stopped.p.kill("SIGCONT"); stopped.p.kill("SIGUSR2"); await stopped.done;
    assert.deepEqual(await cardsOf(dir), [["M", 3, "v3 본문"]], "the process that was stopped and resumed did not put v2 over v3"); assert.ok(!(await journalOf(dir)).includes("reflected:r2"));
  });

  await check("the apply window: a slow answer, a sleep, a moved clock or a restart never gives an item more time — and re-opening what is already held needs none", async () => {
    const dir = fresh(), c = clockAt(), a = session(dir, { clock: c }); const w0 = a.win();
    c.t.mono += 29_000; c.t.wall += 29_000; await a.s.onBlock({ items: [item(1, 1)] }, w0, 10); assert.deepEqual(await cardsOf(dir), [["M", 1, "v1 본문"]], "control: inside the window, counted from when the REQUEST was sent");
    for (const [name, move] of [["the answer arrived 31 s after the request was sent", (t) => { t.mono += 31_000; t.wall += 31_000; }], ["the machine slept: the monotonic clock stood still, the wall clock did not", (t) => { t.mono += 1_000; t.wall += 3_600_000; }], ["the wall clock was set back", (t) => { t.mono += 1_000; t.wall -= 60_000; }], ["the wall clock was set forward", (t) => { t.mono += 1_000; t.wall += 86_400_000; }]]) {
      const w = a.win(); move(c.t); const before = await journalOf(dir); await a.s.onBlock({ items: [item(2, 2)] }, w, 11); assert.deepEqual(await cardsOf(dir), [["M", 1, "v1 본문"]], name); assert.deepEqual(await journalOf(dir), before, name + ": dropped without a word — no receipt is the truthful \"not applied\"");
    }
    const tight = a.win(); await a.s.onBlock({ items: [{ ...item(2, 2), apply_within_ms: 500 }] }, { monoStart: tight.monoStart - 501, wallStart: tight.wallStart - 501 }, 11); assert.deepEqual(await cardsOf(dir), [["M", 1, "v1 본문"]], "the Service gave 500 ms because the class was about to end: 501 ms is too late");
    // a restart: the deadline lived in memory. What was fetched before it is an orphan file at most, and orphans are removed.
    writeFileSync(path.join(dir, "rev", "orphan.2.deadbeefdeadbeef.json"), JSON.stringify({ kind: "material", title: "자료 M", body: "v2 본문", links: [] })); const rebooted = session(dir); await rebooted.store.reconcile(Date.now() + 600_000);
    assert.deepEqual(await cardsOf(dir), [["M", 1, "v1 본문"]], "nothing new appears after a restart without a fresh answer from the Service"); assert.ok(!existsSync(path.join(dir, "rev", "orphan.2.deadbeefdeadbeef.json")));
    assert.equal((await inboxView(rebooted.store, { run: "r", student: "s", generation: 9, ended: true })).cards[0].body, "v1 본문", "what is already held is simply read — no window, no Service");
    // the connection ended while an item was being applied: every await is followed by a check
    const d2 = fresh(); let s2; s2 = session(d2, { hooks: { at: (p) => { if (p === "rev_linked") s2.kill(); } } }); await s2.s.onBlock({ items: [item(1, 1)] }, s2.win(), 10);
    assert.deepEqual(await cardsOf(d2), [], "an answer that belongs to an ended connection applies nothing"); assert.ok(!(await journalOf(d2)).includes("reflected:r1"));
  });

  await check("what is refused is said, what is held stays: wrong hash, unknown kind, a changed revision, a broken file — and none of it touches anything outside the inbox directory", async () => {
    const root = fresh(), dir = inboxDir(root, { cohort: "c/../x", run: "run 1", seat: "A1", student: "student-a" }); assert.ok(dir.startsWith(path.join(root, "classroom-inbox")) && !dir.includes(".."), "identifiers cannot walk out of the inbox root: " + dir);
    writeFileSync(path.join(root, "learner-work.txt"), "mine"); const a = session(dir);
    await a.s.onBlock({ items: [{ ...item(1, 1), body: "tampered on the way" }] }, a.win(), 10); assert.deepEqual(await journalOf(dir), ["failed:r1:hash_mismatch"]); assert.deepEqual(await cardsOf(dir), []);
    await a.s.onBlock({ items: [{ ...item(1, 2, { k: "p" }), kind: "prompt" }] }, a.win(), 10); assert.ok((await journalOf(dir)).includes("failed:r1:unsupported_kind"), "a kind this build does not know (U3) is refused as such, never stored");
    await a.s.onBlock({ items: [item(1, 3, { k: "ok" })] }, a.win(), 10); await a.s.onBlock({ items: [item(1, 4, { k: "conflict", content: { body: "different text, same revision" } })] }, a.win(), 11);
    assert.ok((await journalOf(dir)).includes("failed:r1:hash_conflict")); assert.deepEqual(await cardsOf(dir), [["M", 1, "v1 본문"]], "an immutable revision cannot be replaced by other bytes");
    writeFileSync(path.join(dir, "rev", a.store.revFile(item(1, 3))), "{broken"); assert.deepEqual(await cardsOf(dir), [["M", 1, "unreadable"]], "a damaged file is shown as unreadable — not as empty, not as someone else's text");
    assert.deepEqual([readFileSync(path.join(root, "learner-work.txt"), "utf8"), readdirSync(root).sort()], ["mine", ["classroom-inbox", "learner-work.txt"]], "nothing outside classroom-inbox/ was created or changed");
  });

  console.log(`\n${count} inbox checks passed`);
} finally { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }
