// Remote classroom operations R2 (#751) — device command runner.
// Drives the runner alone (faults, clocks, crash recovery).
// Not a real Studio window, a real SDK stop or a real OS crash.
import assert from "node:assert/strict";
import { CommandRunner } from "../src/classroomOpsCommands.ts";
import * as ops from "../src/classroomOps.ts";
let n = 0; const ok = (name) => { n++; console.log("  ✓ " + name); };
const store = (initial = null) => { let saved = initial ? JSON.stringify(initial) : null; return { async load() { return saved ? JSON.parse(saved) : null; }, async save(s) { saved = JSON.stringify(s); }, peek: () => (saved ? JSON.parse(saved) : null) }; };
const env = (id, action = "retry_diagnostics", extra = {}) => ({ schema_version: 1, command_id: id, action, args: {}, lease_generation: 1, connection_epoch: 3, issued_at: 1, start_within_ms: 120000, run_within_ms: 5000, ...extra });
const proceed = (id) => ({ command_id: id, state: "accepted", proceed: true, reason: "" });
const state = (r, id) => r.pendingReceipts().find((x) => x.command_id === id)?.state;

{
  let mono = 0, runs = 0; const journal = store();
  const executors = { retry_diagnostics: { mutating: false, run: async () => { runs++; assert.equal(journal.peek().entries.find((e) => e.envelope.command_id === "cmd-00000001").state, "running", "journaled before the effect"); return { ok: true, code: "probe_ok" }; } } };
  const r = new CommandRunner({ executors, journal, monotonic: () => mono, now: () => 1000, epoch: () => 3 }); await r.recover();
  await r.onCommands([env("cmd-00000001"), env("cmd-00000002", "shell"), env("cmd-00000003", "retry_diagnostics", { args: { cmd: "id" } }), env("cmd-00000004", "retry_diagnostics", { connection_epoch: 2 })]);
  assert.deepEqual(["cmd-00000001", "cmd-00000002", "cmd-00000003", "cmd-00000004"].map((id) => state(r, id)), ["accepted", "unsupported", "rejected", "rejected"]); assert.equal(runs, 0, "nothing runs before the Service says proceed");
  await r.onCommands([env("cmd-00000001")]); assert.equal(r.pendingReceipts().length, 4, "re-delivery is not a second command");
  await r.onAcks([{ command_id: "cmd-00000001", state: "queued", proceed: false, reason: "schema" }].slice(0, 0)); assert.equal(runs, 0);
  assert.equal(await r.onAcks([proceed("cmd-00000001")]), true); assert.equal(runs, 1); assert.equal(state(r, "cmd-00000001"), "succeeded");
  await r.onAcks([proceed("cmd-00000001")]); assert.equal(runs, 1, "a repeated proceed never re-runs");
  await r.onAcks([{ command_id: "cmd-00000001", state: "succeeded", proceed: false, reason: "" }, { command_id: "cmd-00000002", state: "unsupported", proceed: false, reason: "terminal" }]); assert.ok(!r.pendingReceipts().some((x) => ["cmd-00000001", "cmd-00000002"].includes(x.command_id)), "acknowledged receipts stop being sent");
  // Coaching executors take a closed argument shape; recovery executors take none. Showing is not a state change, so no "instructor acted" banner.
  let shown = [], banners = 0; const c = new CommandRunner({ executors: { send_question: { mutating: false, acceptsArgs: (a) => Object.keys(a).join() === "text", run: async (_s, cmd) => { shown.push(cmd.args.text); return { ok: true, code: "shown" }; } }, retry_diagnostics: executors.retry_diagnostics }, journal: store(), monotonic: () => 0, now: () => 1, epoch: () => 3, notify: () => banners++ }); await c.recover();
  await c.onCommands([env("cmd-00000005", "send_question", { args: { text: "어떤 결과를 기대했나요?" } }), env("cmd-00000006", "send_question", { args: { text: "x", file: "a.html" } }), env("cmd-00000007", "retry_diagnostics", { args: { text: "x" } })]);
  assert.deepEqual(["cmd-00000005", "cmd-00000006", "cmd-00000007"].map((id) => state(c, id)), ["accepted", "rejected", "rejected"]); await c.onAcks([proceed("cmd-00000005")]); assert.deepEqual(shown, ["어떤 결과를 기대했나요?"]); assert.equal(banners, 0);
  ok("allowlist, empty args, epoch, ask-before-run, journal-before-effect, no re-run, receipts until acked, closed coaching args");
}
{
  let mono = 0, wall = 5_000_000, runs = 0; const r = new CommandRunner({ executors: { restart_preview: { mutating: false, run: async () => { runs++; return { ok: true, code: "ok" }; } } }, journal: store(), monotonic: () => mono, now: () => wall, epoch: () => 3 }); await r.recover();
  await r.onCommands([env("cmd-00000010", "restart_preview", { start_within_ms: 1000 })]); mono = 1500; wall = 1; // wall clock jumps backwards; the monotonic window has closed
  await r.onAcks([proceed("cmd-00000010")]); assert.equal(runs, 0); assert.equal(state(r, "cmd-00000010"), "rejected");
  await r.onCommands([env("cmd-00000011", "restart_preview")]); await r.onAcks([{ command_id: "cmd-00000011", state: "expired", proceed: false, reason: "" }]); assert.equal(runs, 0, "Service said expired → not run");
  let epoch = 3; const r2 = new CommandRunner({ executors: { restart_preview: { mutating: false, run: async () => { runs++; return { ok: true, code: "ok" }; } } }, journal: store(), monotonic: () => 0, now: () => 1, epoch: () => epoch }); await r2.recover();
  await r2.onCommands([env("cmd-00000012", "restart_preview")]); epoch = 4; await r2.onAcks([proceed("cmd-00000012")]); assert.equal(runs, 0, "a new login generation between ask and run cancels the run"); assert.equal(state(r2, "cmd-00000012"), "rejected");
  ok("start window is monotonic, Service refusal and epoch change prevent execution");
}
{
  const slow = { mutating: true, run: (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, code: "aborted_late" }))) };
  const r = new CommandRunner({ executors: { mut: slow, probe: { mutating: false, run: async () => { throw new Error("boom with /Users/kid/file.html"); } } }, journal: store(), monotonic: () => 0, now: () => 1, epoch: () => 3 }); await r.recover();
  await r.onCommands([env("cmd-00000020", "mut", { run_within_ms: 1000 })]); await r.onAcks([proceed("cmd-00000020")]); assert.equal(state(r, "cmd-00000020"), "outcome_unknown", "a timed-out state change is unknown, not failed");
  await r.onCommands([env("cmd-00000021", "probe")]); await r.onAcks([proceed("cmd-00000021")]); const rec = r.pendingReceipts().find((x) => x.command_id === "cmd-00000021"); assert.deepEqual([rec.state, rec.result_code], ["failed", "executor_error"]); assert.ok(!JSON.stringify(r.pendingReceipts()).includes("kid"));
  ok("timeout of a mutating action → outcome_unknown; thrown errors never leak text");
}
{
  // Crash between `running` and the final receipt: look at the postcondition, never redo.
  let runs = 0; const crashed = (action) => ({ entries: [{ envelope: env("cmd-00000030", action), state: "running", result_code: "", observed_at: 1, settled: false, proceed: true }, { envelope: env("cmd-00000031", action), state: "accepted", result_code: "", observed_at: 1, settled: false, proceed: false }] });
  for (const [post, mutating, expected] of [["done", true, "succeeded"], ["unknown", true, "outcome_unknown"], ["not_done", true, "outcome_unknown"], ["not_done", false, "failed"], [null, false, "outcome_unknown"]]) {
    const r = new CommandRunner({ executors: { act: { mutating, run: async () => { runs++; return { ok: true, code: "ok" }; }, ...(post ? { postcondition: async () => post } : {}) } }, journal: store(crashed("act")), monotonic: () => 0, now: () => 2, epoch: () => 3 }); await r.recover();
    assert.equal(state(r, "cmd-00000030"), expected, `${post}/${mutating}`); assert.equal(state(r, "cmd-00000031"), "rejected"); await r.onAcks([proceed("cmd-00000030"), proceed("cmd-00000031")]);
  }
  assert.equal(runs, 0, "recovery never executes");
  ok("crash recovery: postcondition decides, destructive actions are never auto-retried");
}
// Part 2 (real sync loop ↔ real Service ledger) lives in worker/test/classroom-ops-device.test.mjs:
// it needs the Service's dependencies, which the extension CI job does not install.
console.log(`classroom-ops-commands.smoke: ${n} checks passed`);
