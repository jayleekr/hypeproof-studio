// The experiment evidence panel, App side (cr-evidence #1394): the session over a stub Service,
// the claim-to-source reading (CR-27's view half), the note form (CR-24: nothing filled for
// the student) and the panel rendered for real (test/sx-render.mjs). Every check has a planted
// defect that must be caught. The same session against the real Service router runs in
// worker/test/cr-evidence.test.mjs; the click in the app is e2e/curriculum-runtime/evidence-app.spec.ts.
//
// Run: node --experimental-strip-types test/cr-evidence.smoke.mjs

import assert from "node:assert/strict";
import { EvidenceSession } from "../src/evidenceSession.ts";
import { claimSources, latestDrafts, noteBody, noteFormProblems } from "../src/evidenceView.ts";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";

let passed = 0;
const ok = (n) => { passed++; console.log(`✓ ${n}`); };

const S1 = "ps-" + "1".repeat(32);
const S2 = "ps-" + "2".repeat(32);
const SESSIONS = [
  { session_id: S1, at: Date.UTC(2026, 9, 1, 5), variant: null, channel: null, pages: 2, clicks: 3, inputs: 0, tasks: { 주문하기: { started: true, completed: false } }, milestones: [] },
  { session_id: S2, at: Date.UTC(2026, 9, 1, 6), variant: null, channel: null, pages: 1, clicks: 1, inputs: 0, tasks: { 주문하기: { started: true, completed: true } }, milestones: [] },
];
const NOTES = [{ id: "note-0000000000000001", note_kind: "interview_note", text: "메뉴가 너무 많아요", provenance: { who: "참가자 3", when: "10/1 14:10", where: "카페 앞" }, source_state: "real" }];

// ── CR-27 view half: a claim opens exactly its sources; one that no longer resolves reads 확인 필요 ──
{
  const item = { source_refs: [`session:${S1}`, `note:${NOTES[0].id}`], sources: [{ ref: `session:${S1}`, state: "ok" }, { ref: `note:${NOTES[0].id}`, state: "ok" }] };
  const rows = claimSources({ sessions: SESSIONS, notes: NOTES }, item);
  assert.deepEqual(rows.map((r) => r.state), ["ok", "ok"]);
  assert.match(rows[0].label, /참가 세션 111111/);
  assert.match(rows[0].detail, /주문하기 시작만 함/);
  assert.match(rows[1].detail, /메뉴가 너무 많아요 — 참가자 3/);
  // Unresolvable on the Service, or absent from this experiment's evidence: 확인 필요, nothing opened.
  const gone = claimSources({ sessions: SESSIONS, notes: NOTES }, { source_refs: [`session:${S2}`], sources: [{ ref: `session:${S2}`, state: "deleted" }] });
  assert.deepEqual([gone[0].label, gone[0].state], ["확인 필요", "deleted"]);
  const foreign = claimSources({ sessions: SESSIONS, notes: NOTES }, { source_refs: ["session:ps-" + "9".repeat(32)] });
  assert.deepEqual([foreign[0].label, foreign[0].state], ["확인 필요", "missing"]);
  // Negative control: a reader that opens anything by id regardless of state is told apart.
  const leaky = (view, it) => it.source_refs.map((ref) => ({ ref, state: "ok" }));
  assert.notDeepEqual(leaky(null, { source_refs: [`session:${S2}`] }).map((r) => r.state), gone.map((r) => r.state));
  ok("CR-27 view: a claim opens its sessions and notes; a deleted or foreign reference reads 확인 필요");
}

// ── CR-24: the note form fills nothing in for the student ──
{
  const full = { note_kind: "interview_note", text: "\"메뉴가 많아요\" The button was small.", who: "참가자 3", when: "10/1 14:10", where: "카페 앞", source_state: "real" };
  assert.deepEqual(noteFormProblems(full), []);
  assert.deepEqual(noteBody(full), { note_kind: "interview_note", text: full.text, provenance: { who: "참가자 3", when: "10/1 14:10", where: "카페 앞" }, source_state: "real" }, "verbatim text, no guessed field");
  assert.ok(noteFormProblems({ ...full, source_state: "" }).some((p) => /실제로/.test(p)), "no source state is refused, not defaulted");
  assert.ok(noteFormProblems({ ...full, where: " " }).some((p) => /누가/.test(p)));
  assert.ok(noteFormProblems({ ...full, note_kind: "external_source" }).some((p) => /어느 부분/.test(p)));
  ok("CR-24 form: provenance and source state are the student's; a missing one is named, never filled");
}

// ── The session over a stub Service: reads, actions, switch, sign-in ──
{
  const calls = [];
  const answers = {
    "GET /projects/prj-1": { experiments: [{ id: "exp-1", question: "도움 없이 주문하나?", week: 1, status: "running", declarations: { repeated_use: true } }] },
    "GET /experiments/exp-1/evidence": {
      evidence: {
        sessions: SESSIONS,
        notes: NOTES,
        drafts: [
          { id: "drf-1", revision: 1, author: "runtime", created_at: 1, items: [{ id: "o1", section: "observation", text: "2개 중 1개가 마침", source_refs: [`session:${S1}`], review: "draft" }] },
          { id: "drf-1", revision: 2, author: "user", created_at: 2, items: [{ id: "o1", section: "observation", text: "2개 중 1개가 마침", source_refs: [`session:${S1}`], review: "accepted", reviewed_by: "user" }] },
        ],
        returns: { status: "measured", devices: [] },
        variants: [],
        bursts: [],
      },
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/v1\/curriculum/, "");
    const key = `${init.method ?? "GET"} ${path}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined });
    const body = answers[key] ?? (init.method === "DELETE" ? { receipt: { kind: "participant_session_deleted" } } : { ok: true });
    return new Response(JSON.stringify(body), { status: key.startsWith("POST /experiments/exp-1/notes") && !calls.at(-1).body?.source_state ? 400 : 200 });
  };
  let on = true;
  let token = "tok";
  const session = new EvidenceSession({ switchOn: () => on, token: async () => token, base: () => "https://svc.test/v1/curriculum", fetchImpl, projectId: () => "prj-1" });
  const v = await session.view();
  assert.deepEqual([v.available, v.selected, v.sessions.length, v.notes.length, v.drafts.length, v.drafts[0].revision], [true, "exp-1", 2, 1, 1, 2], "the latest revision of each draft");
  await session.makeDraft("exp-1");
  assert.deepEqual(calls.at(-1), { key: "POST /experiments/exp-1/drafts", body: { from_runtime: true } });
  await session.review("exp-1", "drf-1", 2, [{ item: "o1", action: "reject" }]);
  assert.equal(calls.at(-1).key, "POST /experiments/exp-1/drafts/drf-1/review");
  assert.deepEqual(calls.at(-1).body.revision, 2);
  await session.delete("exp-1", S1);
  assert.equal(calls.at(-1).key, `DELETE /experiments/exp-1/sessions/${S1}`);
  await session.delete("exp-1");
  assert.equal(calls.at(-1).key, "DELETE /experiments/exp-1");
  const n = calls.length;
  const refused = await session.addNote("exp-1", { note_kind: "observer_note", text: "봄", who: "나", when: "오늘", where: "교실", source_state: "" });
  assert.equal(refused.ok, false);
  assert.equal(calls.length, n, "an incomplete note never leaves the App");
  on = false;
  const off = await session.view();
  assert.deepEqual([off.available, off.sessions.length], [false, 0]);
  assert.equal((await session.makeDraft("exp-1")).ok, false);
  assert.equal(calls.length, n, "switch off: nothing reaches the Service");
  on = true;
  token = null;
  assert.match((await session.view()).notice, /참여 코드/);
  assert.deepEqual(latestDrafts([{ id: "a", revision: 1, created_at: 1 }, { id: "a", revision: 3, created_at: 3 }, { id: "a", revision: 2, created_at: 2 }]).map((d) => d.revision), [3]);
  ok("session: reads the Project's experiments and one experiment's evidence; draft, review and delete go to their routes; switch off and no sign-in reach nothing");
}

// ── The panel, rendered ──
const status = rendererStatus();
if (!status.available) {
  console.log(`ok evidence panel render SKIP — ${status.detail}`);
} else {
  const view = (over = {}) => ({
    available: true,
    experiments: [{ id: "exp-1", question: "도움 없이 주문하나?", week: 1, status: "running", data_deleted: false, repeated_use: false, variants: [] }],
    selected: "exp-1",
    sessions: SESSIONS,
    notes: NOTES,
    drafts: [{ id: "drf-1", revision: 1, author: "ai", created_at: 1, items: [
      { id: "o1", section: "observation", text: "2개 중 1개가 멈췄어요", source_refs: [`session:${S1}`], sources: [{ ref: `session:${S1}`, state: "ok" }], review: "draft" },
      { id: "o2", section: "observation", text: "지운 세션에서 본 것", source_refs: [`session:${S2}`], sources: [{ ref: `session:${S2}`, state: "deleted" }], review: "draft" },
      { id: "i1", section: "interpretation", text: "메뉴가 많아서다", source_refs: [], review: "draft" },
    ] }],
    returns: { status: "not_measured" },
    variants: [],
    bursts: [],
    notice: null,
    ...over,
  });
  const props = (v) => ({ view: v, error: null, done: null, busy: false, onSelect() {}, onNote() {}, onDraft() {}, onReview() {}, onDelete() {}, onClose() {} });
  const html = await renderComponent("EvidencePanel", props(view()));
  const text = visibleText(html);
  assert.match(text, /관찰한 것/);
  assert.match(text, /해석/);
  assert.equal((html.match(/data-testid="evidence-claim"/g) ?? []).length, 3);
  assert.equal((html.match(/data-testid="evidence-needs-review"/g) ?? []).length, 1, "only the claim whose source was deleted reads 확인 필요");
  assert.doesNotMatch(html, /data-testid="evidence-sources"/, "sources open on click, not before");
  assert.match(text, /측정하지 않음/, "undeclared returns read 'not measured', never 0");
  assert.doesNotMatch(text, /다시 온 기기/);
  assert.doesNotMatch(html, /type="radio"[^>]*checked/, "no source state is preselected");
  // Observed statements are never offered an edit (they are the records' reading).
  const items = html.split('data-testid="evidence-item"').slice(1);
  assert.ok(!/evidence-edit/.test(items[0]) && /evidence-edit/.test(items[2]));
  const measured = visibleText(await renderComponent("EvidencePanel", props(view({ returns: { status: "measured", devices: [{ pseudonym: "pp-" + "a".repeat(32), return_count: 2, intervals_ms: [86_400_000, 86_400_000], source_refs: [] }] } }))));
  assert.match(measured, /다시 온 기기: aaaaaa 2번 \(간격 1일, 1일\)/);
  assert.match(measured, /사람 수가 아니에요/);
  // Unnamed task events: the line names the publish panel's term and shows only when there are some.
  const withUnnamed = await renderComponent("EvidencePanel", props(view({ sessions: SESSIONS.map((x, i) => ({ ...x, unnamed: i === 0 ? 2 : 0 })) })));
  assert.equal((withUnnamed.match(/data-testid="evidence-session-unnamed"/g) ?? []).length, 1, "one session has unnamed events");
  assert.match(visibleText(withUnnamed), /기록할 과제 이름에 없는 이름 2개는 이름 없이 기록했어요/);
  const noneUnnamed = await renderComponent("EvidencePanel", props(view({ sessions: SESSIONS.map((x) => ({ ...x, unnamed: 0 })) })));
  assert.doesNotMatch(noneUnnamed, /evidence-session-unnamed/, "no line when nothing was unnamed");
  ok("panel: four sections, claims that open on click, 확인 필요 for a dead source, returns labelled per device and 'not measured' when undeclared, the unnamed-events line only when there are some");
}

console.log(`\ncr-evidence smoke: ${passed} passed`);
