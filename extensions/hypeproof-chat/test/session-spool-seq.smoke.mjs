// #751 — the spool's event sequence contract. No app, milliseconds.
//
// Until 2026-09-21 the live spool wrote no `seq`, so every record the Service received — including one from the
// newest build — could only be `sequence_unavailable`. A seq that hides loss would be worse than none, so both
// directions are controlled here:
//   positive — ordinary, concurrent and late (pinned-turn) appends give 1..N in file order, per session
//   negative — a failed append burns its number (gap stays visible), a torn line never swallows the next event,
//              a snapshot read never reports a counter that disagrees with the bytes it returns
// The Service half (what these shapes are judged as) is worker/test/classroom-ops-spool-seq.test.mjs.
//
// Run: node --experimental-strip-types test/session-spool-seq.smoke.mjs

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { SessionSpool } = await import("../src/sessionSpool.ts");
const { freezeSnapshot } = await import("../src/evidenceSnapshot.ts");

const NOW = new Date("2026-09-21T05:00:00.000Z");
function makeSpool(root, ids, clock = { at: NOW.getTime() }) {
  let n = 0;
  return new SessionSpool({ root, appVersion: "0.1.56-test", os: { platform: "darwin", release: "25.5.0", arch: "arm64" }, now: () => new Date(clock.at), newSessionId: () => ids?.[n++] ?? `session-${++n}` });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hps-spool-seq-"));
const lines = (dir) => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim());
const seqs = (dir) => lines(dir).map((l) => { try { return JSON.parse(l).seq; } catch { return "torn"; } });
const ID = { u: "student-a", c: "cohort-x", p: "profile-1" };
let count = 0; const ok = (name) => { count++; console.log("PASS " + name); };

// ── positive: concurrent callers, mixed record kinds → 1..N, file order == seq order ──
{
  const spool = makeSpool(tmp()); spool.noteIdentity(ID);
  for (let i = 0; i < 120; i++) {
    if (i % 3 === 0) spool.recordPrompt({ turnId: `t-${i}`, runtime: "agent-sdk", text: `q${i}` });
    else if (i % 3 === 1) spool.recordWorkflow({ event: "lesson_step", payload: { step_id: "build", status: "in_progress" } });
    else spool.recordWorkflow({ turnId: `t-${i - 2}`, event: "sdk_fallback", payload: { reason: "x" } });
  }
  await Promise.all([spool.flush(), spool.flush()]);
  const got = seqs(spool.currentSessionDir());
  assert.deepEqual(got, Array.from({ length: got.length }, (_, i) => i + 1)); assert.equal(got.length, 120);
  assert.ok(lines(spool.currentSessionDir()).every((l) => JSON.parse(l).schema_version === 1), "readers of schema 1 keep working: seq is an added field");
  ok("concurrent appends are numbered 1..N in file order");
}

// ── a caller field can never replace the seq ──
{
  const spool = makeSpool(tmp()); spool.noteIdentity(ID);
  spool.recordWorkflow({ event: "lesson_step", payload: { seq: 999 }, seq: 999 }); await spool.flush();
  assert.equal(JSON.parse(lines(spool.currentSessionDir())[0]).seq, 1);
  ok("seq is the spool's, not the caller's");
}

// ── per session: identity rotation starts a new stream; a late pinned turn continues the OLD stream ──
{
  const spool = makeSpool(tmp(), ["first", "second"]); spool.noteIdentity(ID);
  spool.recordPrompt({ turnId: "t-1", runtime: "proxy", text: "a" }); await spool.flush(); const firstDir = spool.currentSessionDir();
  spool.noteIdentity({ ...ID, u: "student-b" }); spool.recordPrompt({ turnId: "t-2", runtime: "proxy", text: "b" });
  spool.recordWorkflow({ turnId: "t-1", event: "sdk_fallback", payload: { reason: "late" } }); await spool.flush();
  assert.deepEqual(seqs(firstDir), [1, 2], "the previous learner's late turn event continues their own numbering");
  assert.deepEqual(seqs(spool.currentSessionDir()), [1]);
  ok("each session file has its own contiguous stream");
}

// ── negative: a failed append burns its number; a torn line is isolated, not glued to the next event ──
{
  const spool = makeSpool(tmp()); spool.noteIdentity(ID);
  spool.recordWorkflow({ event: "a", payload: {} }); await spool.flush(); const dir = spool.currentSessionDir();
  const real = fs.promises.appendFile; let mode = "clean";
  fs.promises.appendFile = async (file, data, enc) => {
    if (!String(file).endsWith("events.jsonl") || mode === "off") return real(file, data, enc);
    const m = mode; mode = "off";
    if (m === "torn") await real(file, String(data).slice(0, 25), enc); // half a line reaches the disk, then the write dies
    throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
  };
  try {
    spool.recordWorkflow({ event: "lost", payload: {} }); await spool.flush();              // seq 2: nothing written
    spool.recordWorkflow({ event: "b", payload: {} }); await spool.flush();                  // seq 3
    assert.deepEqual(seqs(dir), [1, 3], "the lost event's number is not reused: the hole is visible");
    mode = "torn"; spool.recordWorkflow({ event: "half", payload: {} }); await spool.flush(); // seq 4: torn
    spool.recordWorkflow({ event: "c", payload: {} }); await spool.flush();                  // seq 5 must survive intact
    assert.deepEqual(seqs(dir), [1, 3, "torn", 5], "the torn fragment stands alone as damage; the next event is whole");
  } finally { fs.promises.appendFile = real; }
  const src = await spool.readForSnapshot(0); assert.equal(src.sequence.last_seq, 5, "the counter counts allocations, not surviving lines");
  ok("failed and torn appends stay visible instead of being renumbered away");
}

// ── snapshot boundary: the counter belongs to the bytes that were read; later events are the next revision's ──
{
  const spool = makeSpool(tmp()); spool.noteIdentity(ID);
  for (let i = 0; i < 5; i++) spool.recordWorkflow({ event: "e" + i, payload: {} });
  const pending = spool.readForSnapshot(0);
  for (let i = 0; i < 5; i++) spool.recordWorkflow({ event: "later" + i, payload: {} }); // queued after the read was requested
  const src = await pending; await spool.flush();
  const copied = new TextDecoder().decode(src.files.find((f) => f.name === "events.jsonl").data).split("\n").filter(Boolean);
  assert.equal(copied.length, 5); assert.equal(src.sequence.last_seq, 5); assert.equal(JSON.parse(copied[4]).seq, 5);
  assert.deepEqual(seqs(spool.currentSessionDir()), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "reading a snapshot never seals, truncates or renumbers the live spool");
  // An append still in flight (bytes without their newline) is not a committed line: the freezer leaves it out.
  const scope = { grant_id: "g", class_run_id: "run", seat_id: "A1", student: ID, activity: null, run: { starts_at: NOW.getTime() - 60_000, ends_at: NOW.getTime() + 3_600_000 } };
  const files = src.files.map((f) => f.name === "events.jsonl" ? { name: f.name, data: new TextEncoder().encode(new TextDecoder().decode(f.data) + '{"schema_version":1,"ts":"2026-09-21T05:00:00.000Z","eve') } : f);
  const frozen = freezeSnapshot(files, scope, "batch-1", { purpose: "class_report", notice_version: "n1" }, NOW.getTime() + 1000, src);
  assert.ok(frozen.ok); assert.deepEqual([frozen.binding.range.lines, frozen.binding.range.first_seq, frozen.binding.range.last_seq, frozen.binding.range.session_last_seq, frozen.binding.range.other_sessions_in_window], [5, 1, 5, 5, 0]);
  ok("a snapshot read is consistent with the write queue, and an in-flight fragment is not copied");
}

// ── restart / second window / sealed session: other sessions of THIS learner in the window are counted, never merged or hidden ──
{
  const root = tmp(), clock = { at: NOW.getTime() };
  const before = makeSpool(root, ["boot-1"], clock); before.noteIdentity(ID); before.recordWorkflow({ event: "before-restart", payload: {} }); await before.flush();
  const other = makeSpool(root, ["someone-else"], clock); other.noteIdentity({ ...ID, u: "student-z" }); other.recordWorkflow({ event: "x", payload: {} }); await other.flush();
  const after = makeSpool(root, ["boot-2"], clock); after.noteIdentity(ID); after.recordWorkflow({ event: "after-restart", payload: {} }); await after.flush();
  assert.deepEqual(seqs(after.currentSessionDir()), [1], "a restarted app starts a new session at 1; it does not pretend to continue the old file");
  assert.equal((await after.readForSnapshot(NOW.getTime() - 60_000)).other_sessions, 1, "the same learner's pre-restart session is declared (another learner's is not)");
  const past = new Date(NOW.getTime() - 86_400_000); fs.utimesSync(path.join(before.currentSessionDir(), "events.jsonl"), past, past);
  assert.equal((await after.readForSnapshot(NOW.getTime() - 60_000)).other_sessions, 0, "a session that ended before the class window is not this class's record");
  fs.writeFileSync(path.join(other.currentSessionDir(), "session.meta.json"), "{not json");
  assert.equal((await after.readForSnapshot(NOW.getTime() - 60_000)).other_sessions, null, "recent events of unknown ownership → the App cannot tell, and says so");
  ok("sessions this copy does not contain are declared, not assumed away");
}

// ── freezer: the declared start must be provable from the live file ──
{
  const scope = { grant_id: "g", class_run_id: "run", seat_id: "A1", student: ID, activity: null, run: { starts_at: NOW.getTime(), ends_at: NOW.getTime() + 3_600_000 } };
  const meta = { name: "session.meta.json", data: new TextEncoder().encode(JSON.stringify({ session_id: "s1", user: ID })) };
  const ev = (seq, minutes) => JSON.stringify({ schema_version: 1, ts: new Date(NOW.getTime() + minutes * 60_000).toISOString(), type: "workflow", ...(seq ? { seq } : {}) });
  const freeze = (rows, last) => freezeSnapshot([meta, { name: "events.jsonl", data: new TextEncoder().encode(rows.join("\n") + "\n") }], scope, "b", { purpose: "class_report", notice_version: "n1" }, NOW.getTime() + 3_000_000, last === undefined ? undefined : { sequence: { session_id: "s1", last_seq: last }, other_sessions: 0 }).binding.range;
  assert.deepEqual([freeze([ev(1, 1), ev(2, 2)], 2).first_seq, freeze([ev(1, 1), ev(2, 2)], 2).last_seq], [1, 2], "positive: starts at the session's first event");
  const windowed = freeze([ev(1, -120), ev(2, -90), ev(3, 1), ev(4, 2)], 4); assert.deepEqual([windowed.lines, windowed.first_seq, windowed.last_seq], [2, 3, 4], "positive: an earlier activity on the same PC is left out by the window, and the line right before proves the start");
  assert.equal(freeze([ev(3, 1), ev(4, 2)], 4).first_seq, undefined, "negative: the file begins at 3 with nothing before it (directory recreated after a sweep) → start not declared");
  assert.equal(freeze([ev(1, -120), ev(3, 1), ev(4, 2)], 4).first_seq, undefined, "negative: the event right before the window is itself missing");
  assert.equal(freeze([ev(0, 1), ev(0, 2)], 2).first_seq, undefined, "records without seq declare no seq range");
  assert.equal(freeze([ev(1, 1), ev(2, 2)]).session_last_seq, undefined, "no live source (a copy made by an earlier build) → the counter is not invented");
  assert.equal(freezeSnapshot([meta, { name: "events.jsonl", data: new TextEncoder().encode(ev(1, 1) + "\n") }], scope, "b", { purpose: "class_report", notice_version: "n1" }, NOW.getTime() + 3_000_000, { sequence: { session_id: "another-session", last_seq: 9 }, other_sessions: 0 }).binding.range.session_last_seq, undefined, "a counter from another session is never attached to this file");
  ok("the freezer declares only what the live file proves");
}

console.log(`${count} spool sequence controls passed`);
