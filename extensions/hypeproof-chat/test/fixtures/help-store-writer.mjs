// Child process for classroom-help-store.smoke.mjs — one "window" (its own extension host process) writing help records into a
// shared directory. It prints READY and waits for SIGUSR2 so the parent can release several windows at the same instant.
//   drafts <key> <count>         writes its own draft <count> times (question "<key>#<i>")
//   mark <key> <request_id>      marks the envelope `sending` only if it still holds <request_id> (the send path's CAS)
//   pause <key> <point> <json>   writes <json> as the envelope, stopping at <point> ("tmp_written" | "linked") with PAUSED;
//                                SIGUSR2 continues it, SIGKILL kills it where it stands
// The last line is DONE <json result>.
import { HelpRecordStore } from "../../src/classroomHelpStore.ts";
const [dir, op, key, a, b] = process.argv.slice(2);
let go; const next = () => new Promise((r) => { go = r; }); process.on("SIGUSR2", () => go?.());
const keepAlive = setInterval(() => {}, 1000);
let armed = op === "pause";
const store = new HelpRecordStore(dir, { at: async (p) => { if (armed && p === a) { armed = false; const w = next(); console.log("PAUSED"); await w; } } });
const start = next(); console.log("READY"); if (op !== "pause") await start;
let result;
if (op === "drafts") {
  for (let i = 0; i < Number(a); i++) await store.update("draft", key, () => ({ question: `${key}#${i}`, turnId: null, duration: 30, updated_at: Date.now() }));
  result = { last: `${key}#${Number(a) - 1}` };
} else if (op === "mark") {
  const r = await store.update("envelope", key, (e) => (e && e.request_id === a && e.state === "prepared" ? { ...e, state: "sending", marked_by: process.pid } : undefined));
  result = { changed: r.changed, pid: process.pid };
} else if (op === "pause") {
  const r = await store.update("envelope", key, (e) => (e && e.request_id !== JSON.parse(b).expect ? undefined : JSON.parse(b).value));
  result = { changed: r.changed };
}
clearInterval(keepAlive); console.log("DONE " + JSON.stringify(result));
