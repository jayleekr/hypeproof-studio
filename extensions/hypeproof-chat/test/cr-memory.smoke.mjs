// The Venture Memory panel, App side (cr-memory #1395): the session over a stub Service, the
// reconstruction digest (CR-T36's App-unit half), the "belief changed because…" sentence
// (CR-79), the decision form (CR-38) and the panel rendered for real (test/sx-render.mjs).
// Every check has a planted defect that must be caught. The same reads against the real
// Service router run in worker/test/cr-memory.test.mjs; the reopen in the app is
// e2e/curriculum-runtime/memory-app.spec.ts (CR-T36).
//
// Run: node --experimental-strip-types test/cr-memory.smoke.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MemorySession } from "../src/memorySession.ts";
import { beliefSentence, decisionFormProblems, reconstructionDigest, timelineRecord } from "../src/memoryView.ts";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";

let passed = 0;
const ok = (n) => { passed++; console.log(`✓ ${n}`); };

const ITEM = (id, confidence, statement, extra = {}) => ({ id: `ev:exp-1/drf-1/${id}`, statement, confidence, review: "accepted", revision: 2, experiment_id: "exp-1", revisions: [{ revision: 1, confidence, statement }], ...extra });
const MEMORY = {
  format: "hps-venture-memory/1",
  project: { id: "prj-1", title: "키오스크 실험", members: ["cr-a"] },
  problem: "처음 쓰는 사람이 키오스크 주문을 어려워한다",
  stakeholders: [{ id: "stk-1", label: "매점 손님", payer_and_user: true, roles_shown: [{ role: "user", confidence: "observed" }, { role: "payer", confidence: "assumed" }, { role: "beneficiary", confidence: "unsupported" }] }],
  hypotheses: [{ id: "hyp-1", statement: "옵션이 한 단계면 혼자 주문한다", status: "revised", revision: 2, revisions: [{ revision: 1, statement: "혼자 주문한다", status: "open" }, { revision: 2, statement: "옵션이 한 단계면 혼자 주문한다", status: "revised" }] }],
  experiments: [{ id: "exp-1", question: "도움 없이 주문하나?", week: 1, status: "running", hypothesis_id: "hyp-1", product_version_id: "sha256:" + "a".repeat(64), method: "task_test", success_criteria: ["5명 중 3명 완료"] }],
  evidence_items: [ITEM("o1", "observed", "3명 중 2명이 멈췄다")],
  decisions: [
    { id: "dec-1", statement: "옵션 선택을 한 단계로 줄인다", actor: "student", shown_as: "team_decision", no_evidence: false, decided_at: 2, resulting_version_id: "sha256:" + "b".repeat(64), affected_deck_slides: [2, 3], evidence: [{ ref: "ev:exp-1/drf-1/o1", state: "ok", statement: "3명 중 2명이 멈췄다" }], assumptions: [] },
    { id: "dec-2", statement: "버튼을 키운다", actor: "ai", shown_as: "ai_suggestion", no_evidence: true, decided_at: 3, resulting_version_id: null, affected_deck_slides: [], evidence: [], assumptions: [] },
    { id: "dec-3", statement: "색을 바꾼다", actor: "student", shown_as: "team_decision", no_evidence: true, decided_at: 4, resulting_version_id: null, affected_deck_slides: [], evidence: [], assumptions: [] },
  ],
  versions: [{ id: "sha256:" + "a".repeat(64), created_at: 1, entry_html: "index.html", files: [{ path: "index.html", sha256: "c".repeat(64), bytes: 10 }] }, { id: "sha256:" + "b".repeat(64), created_at: 5, entry_html: "index.html", files: [{ path: "help.html", sha256: "d".repeat(64), bytes: 9 }] }],
  metrics: [
    { id: "met-1", name: "혼자 주문 완료", unit: "세션", metric_kind: "impact", value: { status: "result", value: 3, source_refs: ["a", "b", "c"], not_counted: { simulated: 1 } } },
    { id: "met-2", name: "멈춘 사람", unit: "명", metric_kind: "usage", value: { status: "evidence_only", value: null, source_refs: ["ev:exp-1/drf-1/o1", "ev:exp-1/drf-1/i1"], not_counted: {}, evidence: [{ ref: "ev:exp-1/drf-1/o1", confidence: "observed", review: "accepted" }, { ref: "ev:exp-1/drf-1/i1", confidence: "interpreted", review: "accepted" }] } },
  ],
  deck_slides: [{ number: 2, title: "문제", revision: 1 }],
  slide_revisions: [{ number: 2, title: "문제", body: "옵션에서 멈춘다", revision: 1, evidence_refs: ["ev:exp-1/drf-1/o1"] }],
  register: {
    observed: [ITEM("o1", "observed", "3명 중 2명이 멈췄다", { cited_by: [{ decision_id: "dec-1", shown_as: "team_decision" }], slides: [2, 3] }), ITEM("a2", "observed", "어르신도 멈춘다", { assumption_status: "observed_later", revisions: [{ revision: 1, confidence: "assumed", statement: "어르신도 멈춘다" }, { revision: 3, confidence: "observed", statement: "어르신도 멈춘다" }] }), ITEM("o9", "observed", "연습 메모로 본 것", { sources_real: false })],
    interpreted: [ITEM("i1", "interpreted", "옵션이 너무 많다"), ITEM("i9", "interpreted", "AI가 쓴 해석", { review: "draft", created_by: "system", pending_review: true })],
    assumed: [ITEM("a1", "assumed", "한 단계면 혼자 주문한다", { assumption_status: "open" })],
  },
  timeline: [
    { at: 1, entry: "hypothesis", label: "혼자 주문한다", record: { kind: "hypothesis", id: "hyp-1", revision: 1 } },
    { at: 1, entry: "product_version", label: "index.html", record: { kind: "product_version", id: "sha256:" + "a".repeat(64) } },
    { at: 2, entry: "experiment", label: "도움 없이 주문하나?", record: { kind: "experiment", id: "exp-1" } },
    { at: 2, entry: "evidence_item", label: "3명 중 2명이 멈췄다", record: { kind: "evidence_item", id: "ev:exp-1/drf-1/o1" } },
    { at: 2, entry: "decision", label: "옵션 선택을 한 단계로 줄인다", record: { kind: "decision", id: "dec-1" } },
    { at: 3, entry: "ai_suggestion", label: "버튼을 키운다", record: { kind: "decision", id: "dec-2" } },
    { at: 4, entry: "deck_slide", label: "2. 문제", record: { kind: "deck_slide", id: "2", revision: 1 } },
  ],
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
  // The instrument the e2e uses: the reconstruction before and after the chat history is
  // deleted must match. It is run over the real MemorySession and over a planted copy of the
  // same source file that also reads the chat (a defect in the product code, not in the test):
  // the real one passes, the planted one is caught.
  const reconstructionProblems = (before, after) => (before === after ? [] : ["reconstruction changed after chat history was removed"]);
  const reconstructWith = async (Session, chat) => {
    const s = new Session({ switchOn: () => true, token: async () => "tok", base: () => "https://svc.test/v1/curriculum", projectId: () => "prj-1", chatMessages: () => chat, fetchImpl: async () => new Response(JSON.stringify({ memory: structuredClone(MEMORY) }), { status: 200, headers: { "content-type": "application/json" } }) });
    return reconstructionDigest((await s.view()).memory);
  };
  const CHAT = ["안녕", "옵션을 한 단계로 줄이자"];
  assert.deepEqual(reconstructionProblems(await reconstructWith(MemorySession, CHAT), await reconstructWith(MemorySession, [])), [], "the real session: same state with and without the chat");
  const dir = mkdtempSync(join(tmpdir(), "cr-memory-planted-"));
  try {
    const src = new URL("../src/", import.meta.url);
    const original = readFileSync(new URL("memorySession.ts", src), "utf8");
    const anchor = "    if (!r.ok) return none(msg(r));\n";
    assert.ok(original.includes(anchor), "control: the planting anchor is in the real view()");
    const planted = original
      .replace(/from "\.\/(galleryPublish|memoryView)\.ts"/g, (_m, f) => `from ${JSON.stringify(new URL(`${f}.ts`, src).href)}`)
      .replace(anchor, `${anchor}    for (const t of ((this.ports as any).chatMessages?.() ?? []) as string[]) r.body.memory.decisions.push({ id: "chat-" + t, statement: t, actor: "student", shown_as: "team_decision", no_evidence: true, decided_at: 0, resulting_version_id: null, affected_deck_slides: [], evidence: [], assumptions: [] });\n`);
    writeFileSync(join(dir, "memorySession.ts"), planted);
    const { MemorySession: Planted } = await import(pathToFileURL(join(dir, "memorySession.ts")).href);
    assert.equal(reconstructionProblems(await reconstructWith(Planted, CHAT), await reconstructWith(Planted, [])).length, 1, "a session that mixes chat-derived decisions into the reconstruction is caught");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The digest is sensitive to what CR-36 names: a decision lost on reopen is caught.
  assert.notEqual(reconstructionDigest({ ...MEMORY, decisions: MEMORY.decisions.slice(1) }), reconstructionDigest(MEMORY));
  ok("CR-T36 (App unit): the real session reconstructs the same state with and without the chat; a planted chat-reading session and a lost decision are caught");
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

// ── CR-78: every timeline entry opens its stored record (pure, from the same answer) ──
{
  const openProblems = (m) => m.timeline.filter((e) => !timelineRecord(m, e.record)).map((e) => `${e.record.kind}:${e.record.id}`);
  assert.deepEqual(openProblems(MEMORY), [], "every fixture entry opens its record");
  assert.deepEqual(timelineRecord(MEMORY, { kind: "product_version", id: MEMORY.versions[0].id }).lines, ["시작 파일: index.html", "index.html · cccccccc"]);
  assert.match(timelineRecord(MEMORY, { kind: "decision", id: "dec-2" }).title, /AI 제안 \(팀 결정 아님\)/);
  // Planted: one entry per kind naming a record the answer does not hold is caught.
  for (const record of [{ kind: "hypothesis", id: "hyp-1", revision: 9 }, { kind: "experiment", id: "exp-9" }, { kind: "product_version", id: "sha256:" + "9".repeat(64) }, { kind: "evidence_item", id: "ev:exp-1/drf-1/zz" }, { kind: "decision", id: "dec-9" }, { kind: "deck_slide", id: "2", revision: 9 }]) {
    assert.deepEqual(openProblems({ ...MEMORY, timeline: [{ at: 9, entry: "x", label: "x", record }] }), [`${record.kind}:${record.id}`], record.kind);
  }
  ok("CR-78 (App): every timeline entry resolves to its record in the answer; a planted dangling entry of each kind is caught");
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
  assert.match(text, /확인한 것 3개/);
  assert.match(text, /해석 2개/);
  assert.match(text, /가정 1개/);
  assert.match(text, /처음엔 가정이었는데 나중에 확인했어요/);
  assert.match(text, /왜 바뀌었는지는 기록되지 않았어요/);
  assert.match(text, /쓰는 사람이 돈도 내요/);
  assert.match(text, /돈 내는 사람 \(가정\)/);
  assert.match(text, /혼자 주문 완료: 3세션 \(실제 기록 3개\) · 연습·가상 기록은 세지 않았어요/);
  assert.match(text, /AI 제안 \(팀 결정 아님\) · 버튼을 키운다/, "the timeline names an AI suggestion as such");
  const off = await renderComponent("MemoryPanel", props({ available: false, memory: null, diff: null, notice: "이 수업에서는 프로젝트 기억을 쓸 수 없어요." }));
  assert.doesNotMatch(off, /memory-decision/);
  // Negative control through the real panel: an answer that mislabels the AI suggestion as the
  // team's decision is drawn as such, and the check above would catch it.
  const mislabelled = visibleText(await renderComponent("MemoryPanel", props({ available: true, memory: { ...MEMORY, decisions: MEMORY.decisions.map((d) => (d.id === "dec-2" ? { ...d, shown_as: "team_decision" } : d)) }, diff: null, notice: null })));
  assert.match(mislabelled, /팀 결정: 버튼을 키운다/);
  // An unreviewed AI draft item is marked and is not offered as the team's evidence.
  assert.match(text, /AI가 쓴 해석\n· 아직 검토하지 않은 초안/);
  const formHtml = html.slice(html.indexOf('data-testid="memory-decision-form"'));
  assert.ok(!/AI가 쓴 해석/.test(formHtml.slice(0, formHtml.indexOf("이 결정이 기대는 가정"))), "an unreviewed AI item is not a pickable piece of evidence");
  // An item on a record that is not real (SX-46) is marked and is not offered either.
  assert.match(text, /연습 메모로 본 것\n· 실제로 본 기록이 아니에요/);
  assert.ok(!/연습 메모로 본 것/.test(formHtml.slice(0, formHtml.indexOf("이 결정이 기대는 가정"))), "an item on an unreal record is not a pickable piece of evidence");
  assert.match(text, /도움 받는 사람 \(근거를 찾을 수 없어요\)/, "a role whose evidence is gone says so");
  // evidence_only: the cited items, not "no real records".
  assert.match(text, /멈춘 사람: 숫자 없이 근거 2개 \(확인한 것 1, 해석 1\)/);
  assert.doesNotMatch(text, /멈춘 사람: 근거가 되는 실제 기록이 없어요/);
  // CR-78: every timeline entry carries its record (closed <details>, rendered in the DOM).
  const entries = html.match(/data-testid="memory-timeline-entry"[^>]*/g) ?? [];
  assert.equal(entries.length, MEMORY.timeline.length);
  assert.ok(entries.every((e) => e.includes('data-found="yes"')), "every entry opens its record");
  assert.match(text, /성공 기준: 5명 중 3명 완료/);
  assert.match(text, /발표 슬라이드 2 · 1번째 기록/);
  const dangling = await renderComponent("MemoryPanel", props({ available: true, memory: { ...MEMORY, timeline: [...MEMORY.timeline, { at: 9, entry: "decision", label: "없는 결정", record: { kind: "decision", id: "dec-9" } }] }, diff: null, notice: null }));
  assert.equal((dangling.match(/data-found="no"/g) ?? []).length, 1, "a planted entry with no record is drawn as missing, and caught");
  ok("panel render: every decision drawn with its actor and no-evidence mark, the register by confidence, a promotion, an unrecorded reason, roles and metrics, and every timeline entry with its record");
}

console.log(`\n${passed} cr-memory smoke checks passed`);
