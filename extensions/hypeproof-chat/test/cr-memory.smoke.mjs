// The Venture Memory panel, App side (cr-memory #1395): the session over a stub Service, the
// reconstruction digest (CR-T36's App-unit half), the "belief changed because…" sentence
// (CR-79), the decision form (CR-38) and the panel rendered for real (test/sx-render.mjs).
// Every check has a planted defect that must be caught. The same reads against the real
// Service router run in worker/test/cr-memory.test.mjs; the reopen in the app is
// e2e/curriculum-runtime/memory-app.spec.ts (CR-T36).
//
// Run: node --experimental-strip-types test/cr-memory.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemorySession } from "../src/memorySession.ts";
import { beliefSentence, decisionFormProblems, reconstructionDigest } from "../src/memoryView.ts";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";

let passed = 0;
const ok = (n) => { passed++; console.log(`✓ ${n}`); };

const ITEM = (id, confidence, statement, extra = {}) => ({ id: `ev:exp-1/drf-1/${id}`, statement, confidence, review: "accepted", revision: 2, experiment_id: "exp-1", revisions: [{ revision: 1, confidence, statement }], ...extra });
const MEMORY = {
  format: "hps-venture-memory/1",
  project: { id: "prj-1", title: "키오스크 실험", members: ["cr-a"] },
  problem: "처음 쓰는 사람이 키오스크 주문을 어려워한다",
  stakeholders: [{ id: "stk-1", label: "매점 손님", payer_and_user: true, roles_shown: [{ role: "user", confidence: "observed" }, { role: "payer", confidence: "assumed" }] }],
  hypotheses: [{ id: "hyp-1", statement: "옵션이 한 단계면 혼자 주문한다", status: "revised", revision: 2, revisions: [{ revision: 1, statement: "혼자 주문한다", status: "open" }, { revision: 2, statement: "옵션이 한 단계면 혼자 주문한다", status: "revised" }] }],
  experiments: [{ id: "exp-1", question: "도움 없이 주문하나?", week: 1, status: "running", hypothesis_id: "hyp-1", product_version_id: "sha256:" + "a".repeat(64) }],
  evidence_items: [],
  decisions: [
    { id: "dec-1", statement: "옵션 선택을 한 단계로 줄인다", actor: "student", shown_as: "team_decision", no_evidence: false, decided_at: 2, resulting_version_id: "sha256:" + "b".repeat(64), affected_deck_slides: [2, 3], evidence: [{ ref: "ev:exp-1/drf-1/o1", state: "ok", statement: "3명 중 2명이 멈췄다" }], assumptions: [] },
    { id: "dec-2", statement: "버튼을 키운다", actor: "ai", shown_as: "ai_suggestion", no_evidence: true, decided_at: 3, resulting_version_id: null, affected_deck_slides: [], evidence: [], assumptions: [] },
    { id: "dec-3", statement: "색을 바꾼다", actor: "student", shown_as: "team_decision", no_evidence: true, decided_at: 4, resulting_version_id: null, affected_deck_slides: [], evidence: [], assumptions: [] },
  ],
  versions: [{ id: "sha256:" + "a".repeat(64), created_at: 1, entry_html: "index.html" }, { id: "sha256:" + "b".repeat(64), created_at: 5, entry_html: "index.html" }],
  metrics: [{ id: "met-1", name: "혼자 주문 완료", unit: "세션", metric_kind: "impact", value: { status: "result", value: 3, source_refs: ["a", "b", "c"], not_counted: { simulated: 1 } } }],
  deck_slides: [{ number: 2, title: "문제", revision: 1 }],
  register: {
    observed: [ITEM("o1", "observed", "3명 중 2명이 멈췄다", { cited_by: [{ decision_id: "dec-1", shown_as: "team_decision" }], slides: [2, 3] }), ITEM("a2", "observed", "어르신도 멈춘다", { assumption_status: "observed_later", revisions: [{ revision: 1, confidence: "assumed", statement: "어르신도 멈춘다" }, { revision: 3, confidence: "observed", statement: "어르신도 멈춘다" }] })],
    interpreted: [ITEM("i1", "interpreted", "옵션이 너무 많다")],
    assumed: [ITEM("a1", "assumed", "한 단계면 혼자 주문한다", { assumption_status: "open" })],
  },
  timeline: [{ at: 1, entry: "hypothesis", label: "혼자 주문한다", record: { kind: "hypothesis", id: "hyp-1", revision: 1 } }, { at: 3, entry: "ai_suggestion", label: "버튼을 키운다", record: { kind: "decision", id: "dec-2" } }],
  belief_changes: [
    { hypothesis_id: "hyp-1", before: { statement: "혼자 주문한다", status: "open" }, after: { statement: "옵션이 한 단계면 혼자 주문한다", status: "revised" }, decision: { id: "dec-1", statement: "옵션 선택을 한 단계로 줄인다" }, evidence: [{ ref: "ev:exp-1/drf-1/o1", statement: "3명 중 2명이 멈췄다" }], reason: "recorded" },
    { hypothesis_id: "hyp-1", before: { statement: "옵션이 한 단계면 혼자 주문한다", status: "revised" }, after: { statement: "옵션이 한 단계면 혼자 주문한다", status: "supported" }, decision: null, evidence: [], reason: "reason_not_recorded" },
  ],
  chains: [],
};

// ── The session over a stub Service: reads, the remembered Project, the fallback, the switch ──
{
  const stub = (answers, calls) => async (url, init) => {
    const u = new URL(url);
    const key = `${init?.method ?? "GET"} ${u.pathname.replace(/^\/v1\/curriculum/, "")}`;
    calls.push({ key, body: init?.body ? JSON.parse(init.body) : undefined, search: u.search });
    const a = answers[key];
    return new Response(JSON.stringify(a ?? { error: { type: "not_found" } }), { status: a ? 200 : 404, headers: { "content-type": "application/json" } });
  };
  const make = (over = {}, answers = {}, calls = []) => new MemorySession({ switchOn: () => true, token: async () => "tok", base: () => "https://svc.test/v1/curriculum", projectId: () => "prj-1", fetchImpl: stub(answers, calls), ...over });

  const calls = [];
  const s = make({}, { "GET /projects/prj-1/memory": { memory: MEMORY } }, calls);
  const v = await s.view();
  assert.deepEqual([v.available, v.memory.project.id, calls.map((c) => c.key)], [true, "prj-1", ["GET /projects/prj-1/memory"]]);

  const offCalls = [];
  const off = await make({ switchOn: () => false }, {}, offCalls).view();
  assert.deepEqual([off.available, offCalls.length], [false, 0], "switch off: nothing is asked of the Service");
  assert.equal((await make({ token: async () => null }).view()).notice, "참여 코드를 먼저 입력해 주세요.");

  // Nothing remembered (cleared local state): the newest member Project is read, never created.
  const fbCalls = [];
  const fb = await make({ projectId: () => undefined }, { "GET /projects": { projects: [{ id: "prj-0", created_at: 1 }, { id: "prj-1", created_at: 9 }] }, "GET /projects/prj-1/memory": { memory: MEMORY } }, fbCalls).view();
  assert.deepEqual([fb.memory.project.id, fbCalls.map((c) => c.key)], ["prj-1", ["GET /projects", "GET /projects/prj-1/memory"]]);
  const noneCalls = [];
  const none = await make({ projectId: () => undefined }, { "GET /projects": { projects: [] } }, noneCalls).view();
  assert.equal(none.available, false);
  assert.ok(noneCalls.every((c) => !c.key.startsWith("POST")), "an empty list never creates a Project");

  // A decision is the student's (author user), checked before the Service is asked.
  const dCalls = [];
  const d = make({}, { "POST /projects/prj-1/decisions": { decision: {} } }, dCalls);
  assert.equal((await d.decide({ statement: " ", evidence_refs: [], assumption_refs: [], affected_deck_slides: [], resulting_version_id: null })).ok, false);
  assert.equal(dCalls.length, 0, "an empty decision is refused before any request");
  assert.equal((await d.decide({ statement: "옵션을 줄인다", evidence_refs: ["ev:exp-1/drf-1/o1"], assumption_refs: [], affected_deck_slides: [2, 3], resulting_version_id: null })).ok, true);
  assert.deepEqual([dCalls[0].body.author, dCalls[0].body.affected_deck_slides], ["user", [2, 3]], "the App never writes an AI suggestion as the team's decision");
  assert.ok(decisionFormProblems({ statement: "x", evidence_refs: [], assumption_refs: [], affected_deck_slides: [9], resulting_version_id: null }).length > 0, "slide 9 is refused in the form too");

  // The diff is the Service's; the session keeps it for the view.
  const cmp = make({}, { "GET /projects/prj-1/memory/diff": { diff: { from: { id: "a" }, to: { id: MEMORY.versions[1].id }, files: [{ path: "index.html", change: "modified" }], decisions: [], reason: "no_recorded_decision" } }, "GET /projects/prj-1/memory": { memory: MEMORY } });
  assert.equal((await cmp.compare("a", "b")).ok, true);
  assert.equal((await cmp.view()).diff.reason, "no_recorded_decision");
  ok("session: reads the Service only, falls back to the newest member Project without creating one, writes the student's decision, keeps the diff; nothing with the switch off");
}

// ── CR-T36 App-unit half: the reconstruction is a function of the Service's answer alone ──
{
  const code = (f) => readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const reads = /history|workspaceState|globalState|getHistory/i;
  assert.doesNotMatch(code("../src/memorySession.ts"), reads, "the memory session has no way to read chat history or local state");
  assert.match("  this.context.workspaceState.get(key)", reads, "control: the source check sees a workspaceState read");
  const reopened = structuredClone(MEMORY);
  assert.equal(reconstructionDigest(reopened), reconstructionDigest(MEMORY), "the same answer reconstructs the same state");
  // The instrument the e2e uses: before and after must match. A planted reconstruction that
  // mixes in the chat (a message count) changes when the chat is deleted, and is caught.
  const reconstructionProblems = (before, after) => (before === after ? [] : ["reconstruction changed after chat history was removed"]);
  const leaky = (m, chat) => reconstructionDigest(m) + `|chat:${chat.length}`;
  assert.deepEqual(reconstructionProblems(reconstructionDigest(MEMORY), reconstructionDigest(reopened)), []);
  assert.equal(reconstructionProblems(leaky(MEMORY, ["안녕", "주문 앱 만들어 줘"]), leaky(reopened, [])).length, 1);
  // The digest is sensitive to what CR-36 names: a decision lost on reopen is caught.
  assert.notEqual(reconstructionDigest({ ...MEMORY, decisions: MEMORY.decisions.slice(1) }), reconstructionDigest(MEMORY));
  ok("CR-T36 (App unit): the reconstruction reads no chat; a planted chat-dependent one and a lost decision are caught");
}

// ── CR-79: the sentence is assembled from links only ──
{
  const [recorded, missing] = MEMORY.belief_changes;
  assert.match(beliefSentence(recorded), /"3명 중 2명이 멈췄다"를 보고 "옵션이 한 단계면 혼자 주문한다"라고 믿게 됐어요\. 그래서 "옵션 선택을 한 단계로 줄인다"로 바꿨어요\./);
  assert.match(beliefSentence(missing), /왜 바뀌었는지는 기록되지 않았어요\.$/);
  // A planted reason (the change has no link, but a "reason" was put in its evidence) is still
  // only ever read from the links: with reason_not_recorded nothing from evidence is said.
  assert.doesNotMatch(beliefSentence({ ...missing, evidence: [{ ref: "x", statement: "AI가 지어낸 이유" }] }), /AI가 지어낸 이유/);
  ok("CR-79 sentence: 'because' cites the linked evidence; no link reads 기록되지 않았어요, never a reason");
}

// ── The panel, rendered ──
const status = rendererStatus();
if (!status.available) {
  console.log(`ok memory panel render SKIP — ${status.detail}`);
} else {
  const props = (view) => ({ view, error: null, done: null, busy: false, onRefresh() {}, onDiff() {}, onDecide() {}, onClose() {} });
  const html = await renderComponent("MemoryPanel", props({ available: true, memory: MEMORY, diff: null, notice: null }));
  const text = visibleText(html);
  assert.equal((html.match(/data-testid="memory-decision"/g) ?? []).length, 3, "every decision is drawn, the AI one and the no-evidence one included");
  assert.match(html, /data-shown-as="ai_suggestion"/);
  assert.match(text, /AI 제안 \(팀 결정 아님\): 버튼을 키운다/);
  assert.doesNotMatch(text, /팀 결정: 버튼을 키운다/, "the AI suggestion is never drawn as the team's decision");
  assert.equal((html.match(/data-testid="memory-no-evidence"/g) ?? []).length, 2, "both decisions with no evidence are marked");
  assert.match(text, /확인한 것 2개/);
  assert.match(text, /해석 1개/);
  assert.match(text, /가정 1개/);
  assert.match(text, /처음엔 가정이었는데 나중에 확인했어요/);
  assert.match(text, /왜 바뀌었는지는 기록되지 않았어요/);
  assert.match(text, /쓰는 사람이 돈도 내요/);
  assert.match(text, /돈 내는 사람 \(가정\)/);
  assert.match(text, /혼자 주문 완료: 3세션 \(실제 기록 3개\) · 연습·가상 기록은 세지 않았어요/);
  assert.match(text, /AI 제안 \(팀 결정 아님\) · 버튼을 키운다/, "the timeline names an AI suggestion as such");
  const off = await renderComponent("MemoryPanel", props({ available: false, memory: null, diff: null, notice: "이 수업에서는 프로젝트 기억을 쓸 수 없어요." }));
  assert.doesNotMatch(off, /memory-decision/);
  // Instrument negative control: a panel that drew the AI suggestion as the team's would fail the check above.
  assert.ok(/팀 결정: 버튼을 키운다/.test(text.replace("AI 제안 (팀 결정 아님): 버튼을 키운다", "팀 결정: 버튼을 키운다")));
  ok("panel render: every decision drawn with its actor and no-evidence mark, the register by confidence, a promotion, an unrecorded reason, roles and metrics");
}

console.log(`\n${passed} cr-memory smoke checks passed`);
