// The curriculum skills panel, App side (cr-skills #1396): the session over a stub Service,
// CR-T40's App half (no workspace file is a skill or widens the coach's tools: the SDK coach
// keeps settingSources [] with the switch on), the answer parser, the request the host sends on
// the coach route, and the panel rendered for real (test/sx-render.mjs). Every check has a
// planted defect that must be caught. The same runs against the real Service router are in
// worker/test/cr-skills.test.mjs.
//
// Run: node --experimental-strip-types test/cr-skills.smoke.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillSession } from "../src/skillSession.ts";
import { extractJsonObject, problemLine, resultSections, skillFormProblems, skillInput } from "../src/skillView.ts";
import { buildSdkQueryOptions, profileToAgentOptions } from "../src/sdkCoachHelpers.ts";
import { lessonBindingHeader } from "../src/proxyClientHelpers.ts";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";

let passed = 0;
const ok = (n) => {
  passed++;
  console.log(`✓ ${n}`);
};

const SKILLS = ["experiment", "evidence", "product-builder", "deck-builder", "interview", "critic", "demo-coach"].map((skill) => ({ skill, version: "1.0.0", tag: `${skill}@1.0.0`, title: skill, intent: "i", preferred_capability: "text.fast", write_back_targets: skill === "evidence" ? ["evidence_draft"] : [] }));
const WEEKS = [{ week: 1, question: "Q1" }, { week: 2, question: "Q2" }];
const MEMORY = {
  experiments: [{ id: "exp-1", week: 2, status: "running", question: "혼자 주문하나?" }],
  decisions: [
    { id: "dec-1", statement: "옵션을 한 단계로", shown_as: "team_decision", affected_deck_slides: [2, 3] },
    { id: "dec-2", statement: "AI 제안", shown_as: "ai_suggestion", affected_deck_slides: [5] },
  ],
  evidence_items: [
    { id: "ev:exp-1/d/o1", statement: "두 명이 멈췄다", confidence: "observed", pending_review: false, sources_real: true },
    { id: "ev:exp-1/d/a1", statement: "가정", confidence: "assumed" },
    { id: "ev:exp-1/d/x1", statement: "AI 해석", confidence: "interpreted", pending_review: true },
  ],
};

/** The run state the Service serves with `GET /skills?project_id=` (its own week rule and team-evidence rule). */
const RUN = { project_id: "prj-1", week: { week: 2, question: "Q2" }, team_evidence: [{ id: "ev:exp-1/d/o1", statement: "두 명이 멈췄다" }] };

/** A stub Service: records every call; answers the registry, memory, prepare and output. */
function stubService({ output = (body) => ({ status: 200, body: { skill: "experiment@1.0.0", output: body.output, written: [] } }), run = RUN } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1\/curriculum/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", path, query: u.search, body });
    const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path === "/skills") return json(200, { curriculum: { weeks: WEEKS }, skills: SKILLS, ...(u.searchParams.get("project_id") === "prj-1" ? { run } : {}) });
    if (path === "/projects/prj-1/memory") return json(200, { memory: MEMORY });
    const m = /^\/projects\/prj-1\/skills\/([a-z-]+)\/(prepare|output)$/.exec(path);
    if (m?.[2] === "prepare") return json(200, { skill: `${m[1]}@1.0.0`, capability: "text.fast", headers: { "x-hps-skill": `${m[1]}@1.0.0`, "x-hps-capability": "text.fast" }, prompt: `PROMPT ${m[1]}` });
    if (m?.[2] === "output") {
      const r = output(body);
      return json(r.status, r.body);
    }
    return json(404, { error: { type: "not_found" } });
  };
  return { calls, fetchImpl };
}
const session = (svc, over = {}) => {
  const sent = [];
  const s = new SkillSession({
    switchOn: () => true,
    token: async () => "tok",
    base: () => "https://svc.test/v1/curriculum",
    fetchImpl: svc.fetchImpl,
    projectId: () => "prj-1",
    complete: async (prompt, headers) => {
      sent.push({ prompt, headers });
      return { ok: true, text: over.answer ?? '{"assumption":"a"}', model: "m" };
    },
    ...over.ports,
  });
  return { s, sent };
};

// ── The session ──
{
  const svc = stubService();
  const { s, sent } = session(svc);
  const view = await s.view();
  assert.equal(view.available, true);
  assert.deepEqual(view.skills.map((x) => x.skill), SKILLS.map((x) => x.skill), "the list is the Service's");
  assert.deepEqual(view.week, { week: 2, question: "Q2" }, "the run's week and question as the Service serves them");
  assert.equal(svc.calls.find((c) => c.path === "/skills").query, "?project_id=prj-1", "the run state is asked for the Project");
  assert.deepEqual(view.pickers.decisions.map((d) => d.id), ["dec-1"], "only the team's decisions that name slides");
  assert.deepEqual(view.pickers.evidence.map((e) => e.id), ["ev:exp-1/d/o1"], "no assumption, no unreviewed AI item");
  assert.deepEqual(await s.run("experiment", { text: "옵션" }), { ok: true });
  assert.deepEqual(sent[0], { prompt: "PROMPT experiment", headers: { "x-hps-skill": "experiment@1.0.0", "x-hps-capability": "text.fast" } });
  const out = svc.calls.find((c) => c.path.endsWith("/output"));
  assert.deepEqual(out.body, { input: { focus: "옵션" }, output: { assumption: "a" }, request: { model: "m" } });
  assert.equal((await s.view()).result.ok, true);
  ok("session: the list and week come from the Service; prepare → complete with the served metadata → output; the result is shown");
}
{
  // Nothing re-derived in the App: a served week and a served team-evidence list the memory would
  // not give (memory has a running week-2 experiment and o1 usable) are shown as served.
  const svc = stubService({ run: { ...RUN, week: { week: 1, question: "Q1" }, team_evidence: [] } });
  const view = await session(svc).s.view();
  assert.deepEqual(view.week, { week: 1, question: "Q1" });
  assert.deepEqual(view.pickers.evidence, []);
  ok("session: the week and the evidence choices are the Service's, not re-derived from memory");
}
{
  // Switch off: nothing is read or sent.
  const svc = stubService();
  const { s, sent } = session(svc, { ports: { switchOn: () => false } });
  assert.equal((await s.view()).available, false);
  assert.equal((await s.run("experiment", {})).ok, false);
  assert.deepEqual([svc.calls.length, sent.length], [0, 0]);
  // An incomplete form is refused before any call.
  const svc2 = stubService();
  const b = session(svc2);
  for (const [skill, msg] of [["evidence", "실험"], ["product-builder", "근거"], ["deck-builder", "결정"], ["interview", "인터뷰"]]) {
    const r = await b.s.run(skill, {});
    assert.ok(!r.ok && r.message.includes(msg), `${skill}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual([svc2.calls.length, b.sent.length], [0, 0]);
  ok("session: with the switch off and with an incomplete form, no Service call and no model call");
}
{
  // A refused answer shows the Service's problems and claims nothing was stored.
  const svc = stubService({ output: () => ({ status: 422, body: { error: { type: "curriculum", code: "invalid_output", problems: ["evidence_draft_valid $.items[0]: observation_without_source_refs"] } } }) });
  const { s } = session(svc);
  const r = await s.run("evidence", { experiment_id: "exp-1" });
  assert.equal(r.ok, false);
  const shown = (await s.view()).result;
  assert.equal(shown.ok, false);
  assert.equal(shown.message, "AI의 답이 규칙을 지키지 않아 아무것도 저장하지 않았어요.");
  assert.deepEqual(shown.problems, ["evidence_draft_valid $.items[0]: observation_without_source_refs"]);
  // An answer that is not JSON never reaches the Service's output gate.
  const svc2 = stubService();
  const { s: s2 } = session(svc2, { answer: "모르겠어요" });
  assert.equal((await s2.run("experiment", {})).ok, false);
  assert.equal(svc2.calls.some((c) => c.path.endsWith("/output")), false);
  ok("session: a refused answer is shown with its problems; a non-JSON answer is not posted");
}

// ── CR-T40, App half: no workspace file is a skill or widens the coach ──
{
  const ws = mkdtempSync(join(tmpdir(), "cr-skills-app-"));
  try {
    mkdirSync(join(ws, ".hypeproof/skills/evil"), { recursive: true });
    mkdirSync(join(ws, ".claude"), { recursive: true });
    writeFileSync(join(ws, ".hypeproof/skills/evil/SKILL.md"), "# evil");
    writeFileSync(join(ws, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(*)", "Write(*)"] } }));
    writeFileSync(join(ws, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["WebFetch"] } }));
    // The skills panel lists only what the Service serves, whatever the workspace holds.
    const { s } = session(stubService());
    assert.equal((await s.view()).skills.some((x) => x.skill === "evil"), false);
    assert.doesNotMatch(readFileSync(new URL("../src/skillSession.ts", import.meta.url), "utf8"), /node:fs|readFile|\.hypeproof\/skills/);

    /** What allow-rules an SDK run would load from `cwd`: the setting sources it names, read as the CLI reads them, plus allowedTools. */
    const effectiveAllowRules = (options) => {
      const files = { project: ".claude/settings.json", local: ".claude/settings.local.json" };
      const rules = [...(options.allowedTools ?? [])];
      for (const src of options.settingSources ?? ["user", "project", "local"]) {
        const f = files[src] && join(options.cwd, files[src]);
        if (f && existsSync(f)) rules.push(...(JSON.parse(readFileSync(f, "utf8")).permissions?.allow ?? []));
      }
      return rules;
    };
    // The cohort the CR switch serves: a workshop tier with tools and the browser.
    const agent = profileToAgentOptions({ game: { template_tier: "website" }, sdk_tools: { read: true, write: true, browser: true }, curriculum_runtime: { enabled: true } }, { model: "hypeproof-default", systemPrompt: "" });
    const options = buildSdkQueryOptions(agent, { proxyUrl: "https://api.hypeproof-ai.xyz/v1", token: "t", cwd: ws, baseEnv: {} });
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(effectiveAllowRules(options), [], "the planted allow-rules have no effect");
    // Instrument control: options that did read project settings pick the planted rules up.
    assert.deepEqual(effectiveAllowRules({ ...options, settingSources: ["project", "local"] }), ["Bash(*)", "Write(*)", "WebFetch"]);
    assert.deepEqual(effectiveAllowRules({ ...options, settingSources: undefined }), ["Bash(*)", "Write(*)", "WebFetch"], "omitting the field loads the defaults");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
  ok("CR-T40 (App): no workspace skill is listed; the SDK coach loads no workspace setting with the CR switch on, and a planted loader that did is caught");
}

// ── The host's coach-route request carries the run's metadata and no model ──
{
  const src = readFileSync(new URL("../src/chatPanelProvider.ts", import.meta.url), "utf8");
  const body = /private async completeSkill\([\s\S]*?\n  \}\n/.exec(src)?.[0] ?? "";
  assert.match(body, /\/chat\/completions/);
  assert.match(body, /JSON\.stringify\(\{ stream: false, messages: \[\{ role: "user", content: prompt \}\] \}\)/, "the body names no model (the lesson policy picks it)");
  assert.match(body, /for \(const k of \["x-hps-skill", "x-hps-capability"\]\)/, "only the two metadata headers are forwarded");
  // Instrument control: a body that names a model is not matched by the same check.
  assert.doesNotMatch('JSON.stringify({ model: "claude-x", stream: false, messages: [{ role: "user", content: prompt }] })', /JSON\.stringify\(\{ stream: false, messages: \[\{ role: "user", content: prompt \}\] \}\)/);
  // On a lesson seat the request names the served lesson binding, like a coach turn (#751 U3).
  assert.match(body, /lessonBindingHeader\(profile\?\.lesson_binding\?\.enforced \? profile\.lesson_binding\.key : undefined\)/);
  assert.match(body, /\.\.\.binding, \.\.\.meta/);
  assert.deepEqual(lessonBindingHeader("0123456789abcdef0123456789abcdef"), { "x-hps-lesson-binding": "0123456789abcdef0123456789abcdef" });
  assert.deepEqual(lessonBindingHeader("token:0123456789abcdef"), { "x-hps-lesson-binding": "token:0123456789abcdef" });
  assert.deepEqual(lessonBindingHeader(undefined), {}, "no binding: no header");
  assert.deepEqual(lessonBindingHeader("not a key\r\nx: y"), {}, "control: a malformed key is never sent");
  ok("host: the skill request goes to the coach route with the skill tag, capability and lesson binding, never a model");
}

// ── Pure helpers ──
{
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('설명입니다\n```json\n{"a":2}\n```\n끝'), { a: 2 });
  assert.deepEqual(extractJsonObject('앞말 {"a":3} 뒷말'), { a: 3 });
  for (const bad of ["", "모르겠어요", "[1,2]", "{a:1}"]) assert.equal(extractJsonObject(bad), null, bad);
  assert.deepEqual(skillInput("critic", { text: "주장 하나\n\n주장 둘" }), { claims: [{ id: "c1", text: "주장 하나" }, { id: "c2", text: "주장 둘" }] });
  assert.deepEqual(skillInput("deck-builder", { decision_id: "dec-1", text: "무시됨" }), { decision_id: "dec-1" });
  assert.deepEqual(skillFormProblems("critic", {}), []);
  // The input schemas' bounds are kept in the form (the Service would refuse them as invalid_input).
  const refs = Array.from({ length: 11 }, (_, i) => `ev:${i}`);
  assert.ok(skillFormProblems("product-builder", { evidence_refs: refs }).some((p) => p.includes("10개까지")));
  assert.deepEqual(skillFormProblems("product-builder", { evidence_refs: refs.slice(0, 10) }), [], "control: ten refs are fine");
  assert.ok(skillFormProblems("interview", { text: "가".repeat(501) }).some((p) => p.includes("500자까지")));
  assert.deepEqual(skillFormProblems("interview", { text: "가".repeat(500) }), [], "control: 500 characters are fine");
  assert.ok(skillFormProblems("interview", { text: "목표", notes: "가".repeat(8001) }).some((p) => p.includes("8000자까지")));
  assert.ok(skillFormProblems("critic", { text: Array.from({ length: 21 }, (_, i) => `주장 ${i}`).join("\n") }).some((p) => p.includes("20줄까지")));
  // Refusal codes read as Korean sentences; an unknown code still reads as one.
  assert.equal(problemLine("experiment_criteria_countable $.success_criteria[0]: not_countable"), "성공 기준을 셀 수 있게 (숫자로) 적지 않았어요.");
  assert.equal(problemLine("$.evidence_refs: too_many_items"), "항목 수가 너무 많아요.");
  assert.equal(problemLine("demo_claims_supported $.qa[0].answer: unsupported_quantity:100"), "근거 없는 숫자나 '모두' 같은 말이 있어요.");
  assert.equal(problemLine("$.x: never_seen_code"), "AI의 답에 규칙에 맞지 않는 곳이 있어요.");
  const critic = resultSections("critic", { weak_claims: [{ claim_id: "slide:3", reason: "가정뿐" }], missing_tests: [], safety: [], ai_failure_review: [{ case: "unavailable", handling: "missing", note: "실패 처리 없음" }] });
  assert.deepEqual(critic.map((x) => x.heading), ["근거가 약한 주장", "AI 실패 대비"]);
  assert.ok(critic[1].lines[0].includes("대비 없음"));
  ok("helpers: the answer parser takes plain, fenced and embedded JSON and refuses the rest; inputs and result sections");
}

// ── The panel, rendered ──
const status = rendererStatus();
if (!status.available) {
  console.log(`ok skills panel render SKIP — ${status.detail}`);
} else {
  const props = (view, extra = {}) => ({ view, error: null, done: null, running: false, onRefresh() {}, onRun() {}, onClose() {}, ...extra });
  const pickers = { experiments: [], decisions: [], evidence: [] };
  const okView = { available: true, notice: null, week: { week: 2, question: "Q2-from-data" }, skills: SKILLS.map((x) => ({ ...x, title: `제목-${x.skill}` })), pickers, result: { skill: "critic", tag: "critic@1.0.0", ok: true, sections: [{ heading: "근거가 약한 주장", lines: ["slide:3: 가정뿐"] }], written: [] } };
  const text = visibleText(await renderComponent("SkillsPanel", props(okView)));
  for (const s of ["커리큘럼 스킬", "2주차 질문: Q2-from-data", "제목-critic", "근거가 약한 주장", "slide:3: 가정뿐", "제안이에요. 저장한 것은 없어요."]) assert.ok(text.includes(s), `${s} in ${text}`);
  const refused = visibleText(await renderComponent("SkillsPanel", props({ ...okView, result: { skill: "evidence", tag: "evidence@1.0.0", ok: false, message: "AI의 답이 규칙을 지키지 않아 아무것도 저장하지 않았어요.", problems: ["evidence_draft_valid $.items[0]: observation_without_source_refs"] } })));
  assert.ok(refused.includes("아무것도 저장하지 않았어요") && refused.includes("본 것(관찰)에 어느 기록에서 봤는지가 빠졌어요."));
  assert.ok(!refused.includes("observation_without_source_refs"), "no raw rule code in the text a student reads");
  assert.ok(!refused.includes("제안이에요."), "a refusal is not drawn as an accepted proposal");
  const off = visibleText(await renderComponent("SkillsPanel", props({ available: false, notice: "이 수업에서는 커리큘럼 스킬을 쓸 수 없어요.", week: null, skills: [], pickers, result: null })));
  assert.ok(off.includes("쓸 수 없어요") && !off.includes("주차 질문"));
  // Instrument control: a week question the view does not carry is never drawn.
  assert.ok(!text.includes("Q1"));
  ok("panel: the week's question is the served data, results and refusals are drawn as such, nothing is shown with the switch off");
}

console.log(`\n${passed} cr-skills checks passed`);
