// #751 native help — the device store of help drafts and requests (src/classroomHelpStore.ts) against a REAL directory, from one
// process and from several child processes (each child = one window's extension host). Every check is a gate.
//
// What must hold (ADM-05 native help, AT-47 — "기기 저장"):
//   M  windows writing different learners' records at the same instant lose none of them
//   C  a request is marked `sending` by exactly one writer, and only while it still holds the id the learner consented to
//   K  a writer killed at any commit boundary leaves the previous or the new version whole, never a torn or missing record
//   L  a writer that paused and woke up late re-decides against what others wrote meanwhile (no stale overwrite)
//   R  a new store over the same directory (restart) reads what was written
//   P  24-hour retention: untouched records are removed, the learner here now and a record touched meanwhile are kept,
//      a removal is not resurrected by a late import, and old removals are deleted from disk
//   I  the one-time move from globalState is repeatable, never overwrites a newer record, skips expired ones, and a
//      partial failure is reported (and succeeds when run again)
//   F  private files (0700 directories, 0600 files); a corrupt newest version is skipped and never blocks the next write
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HelpRecordStore } from "../src/classroomHelpStore.ts";
import { LOCAL_RETENTION_MS } from "../src/classroomHelp.ts";

const fixture = fileURLToPath(new URL("./fixtures/help-store-writer.mjs", import.meta.url));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "hps-help-store-"));
const results = [];
async function check(id, what, fn) {
  const dir = tmp();
  try { await fn(dir); results.push({ id, status: "PASS" }); console.log("PASS " + id + " " + what); }
  catch (err) { results.push({ id, status: "FAIL" }); console.log("FAIL " + id + " " + what + "\n     " + String(err?.stack ?? err).split("\n").slice(0, 3).join("\n     ")); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
function child(dir, ...args) {
  const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fixture, dir, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; p.stdout.on("data", (b) => { out += b; });
  const until = (word) => new Promise((res, rej) => { const t = setInterval(() => { if (out.includes(word)) { clearInterval(t); res(out); } }, 5); p.on("exit", () => { clearInterval(t); out.includes(word) ? res(out) : rej(new Error("child exited before " + word + ": " + out)); }); });
  const done = new Promise((res) => p.on("exit", (code, sig) => res({ code, sig, result: /DONE (.*)/.exec(out)?.[1] ? JSON.parse(/DONE (.*)/.exec(out)[1]) : null })));
  return { p, until, done, go: () => p.kill("SIGUSR2") };
}
const draft = (q, at = Date.now()) => ({ question: q, turnId: null, duration: 30, updated_at: at });
const env = (id, state = "prepared", at = Date.now()) => ({ request_id: id, draft_key: "k", send_key: "k|g", recipient_id: "t", class_run_id: "run", grant_id: "g", seat_id: "A1", duration_minutes: 30, content: { question: "Q-" + id }, prepared_at: at, class_ends_at: "2099-01-01T00:00:00Z", consent_expires_at: 4_000_000_000, consent_proof: "p".repeat(43), state, truncated: [] });
const files = async (dir) => { const out = []; const walk = async (d) => { for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) { const f = path.join(d, e.name); if (e.isDirectory()) await walk(f); else out.push(f); } }; await walk(dir); return out; };

await check("M1", "six windows (processes) × 25 writes each, all released at once: every learner's own draft survives with its last value", async (dir) => {
  const keys = ["c|p|a|run", "c|p|b|run", "c|p|c|run", "c|p|d|run", "c|p2|a|run", "c|p|a|run2"];
  const kids = keys.map((k) => child(dir, "drafts", k, "25"));
  await Promise.all(kids.map((k) => k.until("READY"))); kids.forEach((k) => k.go());
  const ends = await Promise.all(kids.map((k) => k.done));
  assert.deepEqual(ends.map((e) => e.code), keys.map(() => 0), "every writer finished");
  const s = new HelpRecordStore(dir);
  for (const k of keys) assert.equal((await s.get("draft", k))?.question, `${k}#24`, "draft of " + k);
});

await check("M2", "same instant, one process: two windows' stores write A's draft and B's unknown request — both kept", async (dir) => {
  const w1 = new HelpRecordStore(dir), w2 = new HelpRecordStore(dir);
  await Promise.all([w1.update("draft", "c|p|a|run", () => draft("A")), w2.update("envelope", "c|p|b|run|g", () => env("B", "unknown")), w2.update("draft", "c|p|b|run", () => draft("B"))]);
  assert.equal((await w2.get("draft", "c|p|a|run"))?.question, "A"); assert.equal((await w1.get("draft", "c|p|b|run"))?.question, "B");
  assert.deepEqual([(await w1.get("envelope", "c|p|b|run|g"))?.request_id, (await w1.get("envelope", "c|p|b|run|g"))?.state], ["B", "unknown"]);
});

await check("C1", "five windows race to mark the same consented request sending: exactly one wins", async (dir) => {
  const k = "c|p|a|run|g"; await new HelpRecordStore(dir).update("envelope", k, () => env("E1"));
  const kids = Array.from({ length: 5 }, () => child(dir, "mark", k, "E1"));
  await Promise.all(kids.map((c) => c.until("READY"))); kids.forEach((c) => c.go());
  const ends = await Promise.all(kids.map((c) => c.done)), winners = ends.filter((e) => e.result?.changed);
  assert.equal(winners.length, 1, "winners: " + JSON.stringify(ends.map((e) => e.result)));
  const now = await new HelpRecordStore(dir).get("envelope", k);
  assert.deepEqual([now.request_id, now.state, now.marked_by], ["E1", "sending", winners[0].result.pid]);
});

await check("C2", "a request replaced by a new preview in another window is not marked sending (the consented id is gone)", async (dir) => {
  const k = "c|p|a|run|g", s = new HelpRecordStore(dir); await s.update("envelope", k, () => env("E1")); await s.update("envelope", k, () => env("E2"));
  const c = child(dir, "mark", k, "E1"); await c.until("READY"); c.go(); const end = await c.done;
  assert.equal(end.result.changed, false); assert.deepEqual([(await s.get("envelope", k)).request_id, (await s.get("envelope", k)).state], ["E2", "prepared"]);
});

for (const point of ["tmp_written", "linked"]) {
  await check("K-" + point, `a window killed at ${point}: the record is the previous or the new version, whole; a stray tmp file is swept`, async (dir) => {
    const k = "c|p|a|run|g", s = new HelpRecordStore(dir); await s.update("envelope", k, () => env("E1", "sending"));
    const c = child(dir, "pause", k, point, JSON.stringify({ expect: "E1", value: env("E1", "unknown") })); await c.until("PAUSED"); c.p.kill("SIGKILL"); await c.done;
    const got = await new HelpRecordStore(dir).get("envelope", k);
    assert.equal(got.request_id, "E1"); assert.equal(got.state, point === "linked" ? "unknown" : "sending");
    assert.equal(got.content.question, "Q-E1", "consented content intact");
    const later = new HelpRecordStore(dir, {}, () => Date.now() + 11 * 60_000); await later.update("envelope", k, (e) => ({ ...e, state: "unknown" }));
    const left = (await files(dir)).map((f) => path.basename(f));
    assert.equal(left.filter((f) => f.endsWith(".tmp")).length, 0, "tmp swept: " + left); assert.equal(left.length, 1, "one version left: " + left);
  });
}

await check("L1", "a window that paused before publishing wakes after two newer writes: it re-decides and does not overwrite them", async (dir) => {
  const k = "c|p|a|run|g", s = new HelpRecordStore(dir); await s.update("envelope", k, () => env("E1", "sending"));
  const c = child(dir, "pause", k, "tmp_written", JSON.stringify({ expect: "E1", value: env("E1", "unknown") })); await c.until("PAUSED");
  await s.update("envelope", k, () => null); await s.update("envelope", k, () => env("E2"));
  c.go(); const end = await c.done;
  assert.equal(end.result.changed, false, "the late writer saw E2 and left it");
  assert.deepEqual([(await s.get("envelope", k)).request_id, (await s.get("envelope", k)).state], ["E2", "prepared"]);
});

await check("R1", "restart: a new store over the same directory reads every draft and request", async (dir) => {
  const s = new HelpRecordStore(dir); await s.update("draft", "c|p|a|run", () => draft("A")); await s.update("envelope", "c|p|a|run|g", () => env("E1", "unknown"));
  const again = new HelpRecordStore(dir);
  assert.equal((await again.get("draft", "c|p|a|run")).question, "A"); assert.equal((await again.get("envelope", "c|p|a|run|g")).state, "unknown");
});

await check("P1", "24-hour sweep: untouched records go, the learner here now and fresh records stay; old removals leave the disk", async (dir) => {
  const old = Date.now() - LOCAL_RETENTION_MS - 60_000, s = new HelpRecordStore(dir);
  await s.update("draft", "c|p|old|run", () => draft("OLD", old)); await s.update("envelope", "c|p|old|run|g", () => env("EOLD", "unknown", old));
  await s.update("draft", "c|p|me|run", () => draft("ME", old)); await s.update("envelope", "c|p|me|run|g", () => env("EME", "unknown", old));
  await s.update("draft", "c|p|fresh|run", () => draft("FRESH"));
  assert.equal(await s.sweep("c|p|me|run"), 2);
  assert.equal(await s.get("draft", "c|p|old|run"), null); assert.equal(await s.get("envelope", "c|p|old|run|g"), null);
  assert.equal((await s.get("draft", "c|p|me|run")).question, "ME"); assert.equal((await s.get("envelope", "c|p|me|run|g")).request_id, "EME");
  assert.equal((await s.get("draft", "c|p|fresh|run")).question, "FRESH");
  const nextDay = new HelpRecordStore(dir, {}, () => Date.now() + LOCAL_RETENTION_MS + 60_000); await nextDay.sweep("c|p|me|run");
  const dirs = (await fs.readdir(path.join(dir, "d"))).length + (await fs.readdir(path.join(dir, "e"))).length;
  assert.equal(dirs, 3, "the two removals are gone from disk, me (2) and fresh (1) remain — got " + dirs);
});

await check("P2", "the sweep decides per record against what it holds NOW: a draft another window touched after the sweep read it is kept", async (dir) => {
  const old = Date.now() - LOCAL_RETENTION_MS - 60_000, k = "c|p|b|run";
  let fired = false;
  const s = new HelpRecordStore(dir, { at: async (p) => { if (!fired && p === "tmp_written") { fired = true; await new HelpRecordStore(dir).update("draft", k, () => draft("B typed again")); } } });
  await new HelpRecordStore(dir).update("draft", k, () => draft("B", old));
  await s.sweep(null);
  assert.equal((await s.get("draft", k))?.question, "B typed again");
});

await check("I1", "legacy move: imports fresh records, skips expired, never overwrites a newer or removed record, and is repeatable", async (dir) => {
  const s = new HelpRecordStore(dir), old = Date.now() - LOCAL_RETENTION_MS - 60_000;
  await s.update("draft", "c|p|a|run", () => draft("A newer in a file"));
  await s.update("envelope", "c|p|gone|run|g", () => env("X")); await s.update("envelope", "c|p|gone|run|g", () => null);
  const legacy = { drafts: { "c|p|a|run": draft("A old"), "c|p|b|run": draft("B"), "c|p|x|run": draft("X", old) }, envelopes: { "c|p|b|run|g": env("EB", "unknown"), "c|p|gone|run|g": env("X") } };
  assert.deepEqual(await s.importLegacy(legacy), { imported: 2, present: 2, expired: 1, failed: 0 });
  assert.equal((await s.get("draft", "c|p|a|run")).question, "A newer in a file"); assert.equal((await s.get("draft", "c|p|b|run")).question, "B");
  assert.deepEqual([(await s.get("envelope", "c|p|b|run|g")).request_id, (await s.get("envelope", "c|p|b|run|g")).state], ["EB", "unknown"]);
  assert.equal(await s.get("envelope", "c|p|gone|run|g"), null, "a removed request is not brought back"); assert.equal(await s.get("draft", "c|p|x|run"), null);
  assert.deepEqual(await s.importLegacy(legacy), { imported: 0, present: 4, expired: 1, failed: 0 }, "second run changes nothing");
  const [r1, r2] = await Promise.all([new HelpRecordStore(dir).importLegacy(legacy), new HelpRecordStore(dir).importLegacy(legacy)]);
  assert.equal(r1.imported + r2.imported, 0);
});

await check("I2", "legacy move with a record the disk refuses: reported as failed, the rest imported, and a rerun completes it", async (dir) => {
  const s = new HelpRecordStore(dir), legacy = { drafts: { "c|p|a|run": draft("A"), "c|p|b|run": draft("B") }, envelopes: {} };
  await s.update("draft", "c|p|probe|run", () => draft("x")); const probe = (await fs.readdir(path.join(dir, "d")))[0];
  // Block B's record directory with a file of the same name (mkdir fails), found by writing B elsewhere first.
  const other = tmp(); await new HelpRecordStore(other).update("draft", "c|p|b|run", () => draft("x")); const bName = (await fs.readdir(path.join(other, "d")))[0]; await fs.rm(other, { recursive: true });
  assert.notEqual(bName, probe); await fs.writeFile(path.join(dir, "d", bName), "blocked");
  const first = await s.importLegacy(legacy); assert.deepEqual([first.imported, first.failed], [1, 1]);
  await fs.rm(path.join(dir, "d", bName)); const second = await s.importLegacy(legacy); assert.deepEqual([second.imported, second.present, second.failed], [1, 1, 0]);
  assert.equal((await s.get("draft", "c|p|b|run")).question, "B");
});

await check("F1", "private files, and a corrupt newest version is skipped and written above", async (dir) => {
  const s = new HelpRecordStore(dir), k = "c|p|a|run"; await s.update("draft", k, () => draft("A1"));
  const [f] = await files(dir); assert.equal((await fs.stat(f)).mode & 0o777, 0o600); assert.equal((await fs.stat(path.dirname(f))).mode & 0o777, 0o700);
  await fs.writeFile(path.join(path.dirname(f), "7.json"), "{torn");
  assert.equal((await s.get("draft", k)).question, "A1", "the corrupt 7 is skipped");
  await s.update("draft", k, () => draft("A2")); assert.equal((await s.get("draft", k)).question, "A2");
  assert.ok((await fs.readdir(path.dirname(f))).includes("8.json"), "the next write went above the corrupt version");
});

const failed = results.filter((r) => r.status === "FAIL");
console.log(`${results.length - failed.length}/${results.length} native help store checks passed`);
process.exitCode = failed.length ? 1 : 0;
