// #751 R3 — evidence-preserving runtime reset, driven with injected faults.
// This proves the ORDER and the refusal rules. It does not prove that a real SDK
// turn, a real tool process or a real disk behaves this way: AT-22 on a real
// Mac/Windows Studio remains NOT RUN.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runPreservingReset, stopAndConfirm, resetPostcondition } from "../src/runtimeReset.ts";
let n = 0; const ok = (name) => { n++; console.log("  ✓ " + name); };
function world(over = {}) {
  const w = { log: [], frozen: false, running: true, stopsAfterPolls: 2, polls: 0, generation: 4, history: ["q1", "a1", "q2"], draft: "쓰던 글", manifests: [], now: 1000, ...over };
  w.steps = {
    freezeInput: async () => { w.log.push("freeze"); if (w.freezeFails) throw Error("draft"); w.frozen = true; },
    unfreezeInput: async () => { w.log.push("unfreeze"); w.frozen = false; },
    requestStop: () => { w.log.push("stop"); },
    isStopped: () => { if (w.running && w.log.includes("stop") && ++w.polls > w.stopsAfterPolls && !w.neverStops) w.running = false; return !w.running; },
    preserve: async () => { w.log.push("preserve"); if (w.preserveFails) throw Error("io"); return { history_count: w.history.length, history_sha256: "h:" + w.history.join("|"), draft_sha256: "d:" + w.draft, spool_session: "s1", spool_flushed: !w.spoolStuck }; },
    generation: () => w.generation,
    persistManifest: async (m) => { w.log.push("manifest"); if (w.diskFull && !m.generation_after) throw Error("ENOSPC"); w.manifests.push(structuredClone(m)); },
    newGeneration: async () => { w.log.push("generation"); if (w.loses) w.history.pop(); return ++w.generation; },
    probe: async () => { w.log.push("probe"); return !w.probeFails; },
    wait: async () => {}, now: () => w.now++,
  };
  return w;
}
{
  const w = world(); const r = await runPreservingReset("cmd-1", w.steps);
  assert.deepEqual(r, { ok: true, code: "reset_ok" });
  assert.deepEqual(w.log.filter((x, i, a) => a.indexOf(x) === i), ["freeze", "stop", "preserve", "manifest", "generation", "probe", "unfreeze"], "order is the contract");
  assert.ok(w.log.indexOf("manifest") < w.log.indexOf("generation"), "what is kept is on disk before anything changes");
  assert.deepEqual([w.history, w.draft, w.generation, w.frozen], [["q1", "a1", "q2"], "쓰던 글", 5, false]); assert.equal(w.manifests.at(-1).result, "reset_ok"); assert.equal(w.manifests[0].generation_after, undefined);
  ok("happy path: frozen → stopped → preserved durably → new generation → probe → unfrozen; conversation and draft identical");
}
for (const [over, code] of [[{ freezeFails: true }, "draft_not_saved"], [{ neverStops: true }, "stop_unconfirmed"], [{ preserveFails: true }, "preserve_failed"], [{ diskFull: true }, "preserve_failed"], [{ spoolStuck: true }, "evidence_not_flushed"]]) {
  const w = world(over); const r = await runPreservingReset("cmd-2", w.steps, undefined, 1000);
  assert.deepEqual(r, { ok: false, code }); assert.ok(!w.log.includes("generation"), code + ": the runtime generation did not move"); assert.equal(w.generation, 4); assert.equal(w.frozen, false, code + ": input is given back"); assert.deepEqual(w.history, ["q1", "a1", "q2"]);
}
ok("unsaved draft, unconfirmed stop, preservation I/O failure, full disk, unflushed evidence → refused before any change, input unfrozen");
{
  const w = world({ loses: true }); assert.deepEqual(await runPreservingReset("cmd-3", w.steps), { ok: false, code: "preservation_mismatch" }); assert.ok(!w.log.includes("probe")); assert.equal(w.manifests.at(-1).result, "preservation_mismatch");
  const p = world({ probeFails: true }); assert.deepEqual(await runPreservingReset("cmd-4", p.steps), { ok: false, code: "reset_done_probe_failed" }); assert.equal(p.frozen, false);
  const a = new AbortController(); a.abort(); const d = world(); assert.equal((await runPreservingReset("cmd-5", d.steps, a.signal)).code, "deadline_before_change"); assert.ok(!d.log.includes("generation"));
  ok("a preservation difference is reported, never hidden; probe failure is not success; a passed deadline stops before the change");
}
{
  const idle = world({ running: false }); assert.equal(await stopAndConfirm(idle.steps), true); assert.ok(!idle.log.includes("stop"), "nothing to stop → no abort sent");
  const stuck = world({ neverStops: true }); assert.equal(await stopAndConfirm(stuck.steps, 1000), false);
  const m = { schema: "hps-runtime-reset/1", command_id: "c", started_at: 1, before: {}, generation_before: 4 };
  assert.equal(resetPostcondition(null, 4), "not_done"); assert.equal(resetPostcondition(m, 4), "not_done"); assert.equal(resetPostcondition(m, 5), "unknown"); assert.equal(resetPostcondition({ ...m, generation_after: 5 }, 5), "unknown"); assert.equal(resetPostcondition({ ...m, generation_after: 5, result: "reset_ok" }, 5), "done");
  ok("stop is confirmed, not assumed; crash postcondition: done only on a recorded reset_ok");
}
{
  // Structural guard (verification.md 1b: count, do not assume): the reset path names no destructive API.
  for (const file of ["runtimeReset.ts", "classroomOpsCommands.ts", "classroomOps.ts", "classroomOpsHost.ts"]) {
    const src = readFileSync(new URL("../src/" + file, import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const banned of [/clearHistory\s*\(/, /\.rm\s*\(/, /rmSync|unlink|rmdir|truncate/, /workspaceState\.update\([^)]*,\s*(\[\]|undefined)/, /child_process|execSync|spawn\(/, /executeCommand\(\s*[a-zA-Z_]/]) assert.ok(!banned.test(src), `${file} must not contain ${banned}`);
  }
  ok("no clearHistory, file deletion, history truncation, shell or dynamic VS Code command in the remote path");
}
console.log(`runtime-reset.smoke: ${n} checks passed`);
