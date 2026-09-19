// Remote classroom operations (#751) — the REAL device client (extension sources)
// against the REAL Service routes + SQLite ledger, in-process. It lives in the
// Service suite because it needs the Service's dependencies; the extension CI job
// installs only the extension's. The device modules under test import nothing but
// node built-ins. Not a real Studio window, a real network or a real D1.
import assert from "node:assert/strict";
import { localOps } from "./harness/classroom-ops.mjs";
import { CommandRunner } from "../../extensions/hypeproof-chat/src/classroomOpsCommands.ts";
import * as ops from "../../extensions/hypeproof-chat/src/classroomOps.ts";
let n = 0; const ok = (name) => { n++; console.log("  ✓ " + name); };
// ── real sync loop ↔ real Service command ledger ──
{
  const f = await localOps();
  try {
    await f.freeze(); const seats = [{ seat_id: "A1", student_id: "student-a" }]; assert.equal((await f.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true } })).status, 201);
    const conn = (await f.pair("A1", 1, 1)).conn.json; let runs = 0, epoch = conn.connection_epoch, drop = 0, id = 0;
    const memory = () => { let s = null; return { async load() { return s && JSON.parse(s); }, async save(v) { s = JSON.stringify(v); } }; };
    const runner = new CommandRunner({ executors: { retry_diagnostics: { mutating: false, run: async () => { runs++; return { ok: true, code: "probe_ok" }; } } }, journal: memory(), monotonic: () => performance.now(), now: () => Date.now(), epoch: () => epoch }); await runner.recover();
    const outbox = await ops.OpsOutbox.open(memory(), conn.grant_id, "stream-e2e-0001", () => Date.now(), () => `event-e2e-${String(++id).padStart(6, "0")}`);
    const loop = ops.startOpsSync({ outbox, appInstanceId: f.instance(1).app_instance_id, capabilities: f.instance(1).capabilities, commands: runner, sample: () => ({ idle_ms: 1 }), now: () => Date.now(), random: () => 0.5, setTimeout: () => 0, clearTimeout() {}, onDisconnected() {}, onEpoch: (e) => { epoch = e; },
      post: async (body) => { const r = await f.request("/v1/classroom/ops/sync", "POST", body, conn.credential); if (drop-- > 0) return { status: 0 }; return { status: r.status, body: r.json }; } });
    const view = async (cid) => (await f.request(f.base + "/commands/" + cid)).json;
    const c1 = (await f.command("retry_diagnostics", ["A1"])).json; assert.equal(c1.targets[0].state, "queued");
    await loop.tick(); assert.equal((await view(c1.command.id)).targets[0].state, "leased"); assert.equal(runs, 0);
    await loop.tick(); assert.equal(runs, 1, "asked, was told to proceed, ran once"); await loop.tick();
    let v = await view(c1.command.id); assert.deepEqual([v.targets[0].state, v.targets[0].result_code, v.summary.all_succeeded], ["succeeded", "probe_ok", true]);
    // The response carrying the command is lost twice: the Service re-delivers, the device runs it once.
    const c2 = (await f.command("retry_diagnostics", ["A1"])).json; drop = 2; for (let i = 0; i < 6; i++) await loop.tick();
    assert.equal(runs, 2); assert.equal((await view(c2.command.id)).targets[0].state, "succeeded");
    // An action this build does not know is answered, not ignored: the instructor sees `unsupported`, not an endless spinner.
    f.db.prepare("UPDATE ops_commands SET action='future_action' WHERE id=?").run((await f.command("restart_preview", ["A1"]).then(async (r) => { if (r.json.targets[0].state === "unsupported") return r; f.db.prepare("UPDATE ops_command_targets SET state='queued' WHERE command_id=?").run(r.json.command.id); return r; })).json.command.id);
    for (let i = 0; i < 4; i++) await loop.tick(); const last = f.db.prepare("SELECT t.state FROM ops_command_targets t JOIN ops_commands c ON c.id=t.command_id WHERE c.action='future_action'").get(); assert.equal(last.state, "unsupported"); assert.equal(runs, 2);
    assert.equal(runner.pendingReceipts().length, 0, "every receipt was acknowledged by the ledger"); loop.stop();
    ok("real ledger: queued→leased→accepted→running→succeeded, lost responses, unknown action → unsupported, no double run");
  } finally { f.close(); }
}
console.log(`classroom-ops-device: ${n} checks passed`);
