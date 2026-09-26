// Child process for classroom-inbox.smoke.mjs: applies one item to an inbox directory and pauses at a named commit boundary.
// "PAUSED" is printed when it got there. It continues on SIGUSR2 (after a SIGSTOP/SIGCONT), or is killed where it stands.
import { createHash } from "node:crypto";
import * as inbox from "../../src/classroomInbox.ts";
import { InboxSession, InboxStore } from "../../src/classroomInboxStore.ts";
const [dir, revision, seq, pauseAt] = process.argv.slice(2), sha = (s) => createHash("sha256").update(s).digest("hex");
const c = { kind: "material", title: "자료 M", body: "v" + revision + " 본문", links: [] };
const item = { offer_key: sha("child" + revision + seq).slice(0, 32), distribution_id: "dddddddd-dddd-4ddd-8ddd-" + String(seq).padStart(12, "0"), seq: Number(seq), object_id: "11111111-1111-4111-8111-111111111111", revision: Number(revision), schema: inbox.CONTENT_SCHEMA, ...c, content_hash: sha(inbox.contentCanonical(c)), issued_at: 1, expires_at: 2, apply_within_ms: 30000 };
let go; const resumed = new Promise((r) => { go = r; }); process.on("SIGUSR2", () => go());
let armed = true; const keepAlive = setInterval(() => {}, 1000);
const store = new InboxStore(dir, { at: async (p) => { if (armed && p === pauseAt) { armed = false; console.log("PAUSED"); await resumed; } } });
const s = new InboxSession({ store, alive: () => true, clock: { mono: () => 0, wall: () => 0 } });
await s.onBlock({ items: [item] }, { monoStart: 0, wallStart: 0 }, 11); clearInterval(keepAlive); console.log("DONE");
