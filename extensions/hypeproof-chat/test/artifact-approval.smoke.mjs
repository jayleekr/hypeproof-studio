// #751 U1b — the learner's approval of one exact page version, against a REAL SessionSpool in a temp dir (synthetic learners).
// The question is asked for one record; a change of learner, session or classroom connection while it is open writes nothing,
// and a file edited meanwhile does not change which version was recorded. (Not a real Studio window — see AT-48 mac-collect.)
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SessionSpool, SPOOL_MAX_ARTIFACT_CHARS } from "../src/sessionSpool.ts";
import { approveArtifact, approvalChoices, approvalMessage } from "../src/artifactApproval.ts";

const A = { u: "learner-a", c: "c", p: "p" }, B = { u: "learner-b", c: "c", p: "p" };
const h = (t) => createHash("sha256").update(t, "utf8").digest("hex");
const PAGE = "<html><body>A-PAGE</body></html>";
function fresh() { const root = mkdtempSync(path.join(tmpdir(), "approval-")); return { root, spool: new SessionSpool({ root, appVersion: "t", os: { platform: "darwin", release: "t", arch: "arm64" } }) }; }
function records(root) { const out = {}; for (const day of readdirSync(root)) for (const s of readdirSync(path.join(root, day))) { const d = path.join(root, day, s); try { const u = JSON.parse(readFileSync(path.join(d, "session.meta.json"), "utf8")).user?.u ?? "nobody"; (out[u] ??= []).push(...readFileSync(path.join(d, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))); } catch {} } return out; }
const approvals = (root, u) => (records(root)[u] ?? []).filter((e) => e.type === "artifact_approval");
function deps(spool, { page = PAGE, during = async () => {}, answer = true, classroom = () => "run-1" } = {}) {
  let current = page; return { owner: () => spool.owner(), classroom, readPage: async () => current, ask: async (p) => { await during((next) => { current = next; }); return answer === "close" ? undefined : answer; }, record: (o, e) => spool.recordArtifactApprovalFor(o, e) };
}
let n = 0; const check = async (name, fn) => { await fn(); n++; console.log("PASS " + name); };

await check("another learner signs in while the question is open: nothing is written to either record", async () => {
  const { root, spool } = fresh(); spool.noteIdentity(A); spool.recordPrompt({ turnId: "t", runtime: "proxy", text: "A-WORK" }); await spool.flush();
  const o = await approveArtifact(deps(spool, { during: async () => { spool.noteIdentity(B); await spool.flush(); } }));
  assert.equal(o.status, "owner_changed"); assert.deepEqual([approvals(root, "learner-a"), approvals(root, "learner-b")], [[], []]);
  assert.match(approvalMessage(o), /아무것도 기록하지 않았습니다/);
});
await check("the same learner's session is replaced by a different one meanwhile (A → B → A): refused", async () => {
  const { root, spool } = fresh(); spool.noteIdentity(A); spool.recordPrompt({ turnId: "t", runtime: "proxy", text: "x" }); await spool.flush();
  const o = await approveArtifact(deps(spool, { during: async () => { spool.noteIdentity(B); spool.recordPrompt({ turnId: "b", runtime: "proxy", text: "y" }); spool.noteIdentity(A); spool.recordPrompt({ turnId: "a2", runtime: "proxy", text: "z" }); await spool.flush(); } }));
  assert.equal(o.status, "owner_changed"); assert.deepEqual(approvals(root, "learner-a"), []);
});
await check("the classroom connection changes while the question is open: refused", async () => {
  const { root, spool } = fresh(); spool.noteIdentity(A); let run = "gen1:run-1";
  const o = await approveArtifact(deps(spool, { classroom: () => run, during: async () => { run = "gen2:run-1"; } }));
  assert.equal(o.status, "owner_changed"); assert.deepEqual(approvals(root, "learner-a"), []);
});
await check("normal approve: the page line then the approval, for the version that was shown", async () => {
  const { root, spool } = fresh(); spool.noteIdentity(A);
  const o = await approveArtifact(deps(spool)); assert.deepEqual([o.status, o.approved, o.changed_since], ["recorded", true, false]);
  const ev = records(root)["learner-a"]; assert.deepEqual(ev.map((e) => e.type), ["artifact_snapshot", "artifact_approval"]);
  assert.deepEqual([ev[0].sha256, ev[1].artifact_sha256, ev[1].approved, ev[0].content], [h(PAGE), h(PAGE), true, PAGE]);
});
await check("the file changes while the question is open: the version shown is recorded and the learner is told", async () => {
  const { root, spool } = fresh(); spool.noteIdentity(A);
  const o = await approveArtifact(deps(spool, { during: async (edit) => edit("<html><body>EDITED</body></html>") }));
  assert.deepEqual([o.status, o.changed_since, approvals(root, "learner-a")[0].artifact_sha256], ["recorded", true, h(PAGE)]);
  assert.match(approvalMessage(o), /고르는 사이에 파일이 바뀌었습니다/);
});
await check("withdraw, and closing the question without choosing, behave as asked", async () => {
  const { root, spool } = fresh(); spool.noteIdentity(A);
  assert.equal((await approveArtifact(deps(spool, { answer: "close" }))).status, "cancelled"); assert.deepEqual(records(root), {});
  const o = await approveArtifact(deps(spool, { answer: false })); assert.equal(o.status, "recorded"); assert.equal(approvals(root, "learner-a")[0].approved, false);
  assert.match(approvalMessage(o), /승인을 취소했습니다/);
});
await check("a page over the spool limit: the learner is told before and after; the stored copy says it was cut", async () => {
  const { root, spool } = fresh(); spool.noteIdentity(A); const big = "<html><body>" + "B".repeat(SPOOL_MAX_ARTIFACT_CHARS + 10) + "</body></html>";
  const o = await approveArtifact(deps(spool, { page: big })); assert.equal(o.page.cut, true);
  assert.match(approvalChoices(o.page)[0].detail, /저장 한도보다 커서 앞부분만 보관됩니다/); assert.match(approvalMessage(o), /잘린 결과물/);
  const snap = records(root)["learner-a"].find((e) => e.type === "artifact_snapshot"); assert.deepEqual([snap.content_truncated, snap.sha256], [true, h(big)]);
});
await check("no learner identity, or no page: nothing is asked and nothing written", async () => {
  const { root, spool } = fresh(); let asked = 0;
  assert.equal((await approveArtifact({ ...deps(spool), ask: async () => { asked++; return true; } })).status, "no_learner");
  spool.noteIdentity(A); assert.equal((await approveArtifact({ ...deps(spool, { page: "not a page" }), ask: async () => { asked++; return true; } })).status, "no_page");
  assert.deepEqual([asked, records(root)], [0, {}]);
});
await check("the same learner's session ended normally meanwhile (quit/seal): the approval goes to that learner's next session", async () => {
  const { root, spool } = fresh(); spool.noteIdentity(A); spool.recordPrompt({ turnId: "t", runtime: "proxy", text: "x" }); await spool.flush();
  const o = await approveArtifact(deps(spool, { during: async () => { await spool.close("shutdown"); } }));
  assert.equal(o.status, "recorded"); assert.equal(approvals(root, "learner-a").length, 1);
});
console.log(`artifact-approval: ${n} checks passed`);
