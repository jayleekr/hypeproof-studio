// cr-memory (#1395) — Venture Memory on the Service: unit and worker D1 layers (SQLite shim by
// default; `--d1` runs the route checks on local workerd D1 and R2 through Miniflare). Real
// Service router, real token verifier; evidence items are real hps-evidence-draft/1 revisions
// over real participant sessions and manual records in the measurement-core record.
// Synthetic identities; no network.
//
// CR-T02 (Worker half: the memory routes) · CR-T35 · CR-T36 (Service half) · CR-T37 · CR-T38 ·
// CR-T39 · CR-T70 · CR-T71 · CR-T72 · CR-T73 · CR-T74 · CR-T77 · CR-T80 (re-run). Each with a
// positive sample that must pass and a planted defect that must be caught.
//
// Run: node --experimental-strip-types --experimental-sqlite --no-warnings test/cr-memory.test.mjs [--d1]

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { localCurriculum, sqliteBinding } from "./harness/curriculum.mjs";

const venture = await import("../src/lib/curriculum/venture.ts");
const memory = await import("../src/lib/curriculum/memory.ts");
const { reviseEvidenceDraft } = await import("../src/lib/measurement-core/interpretation.ts");
const { participantRecord } = await import("../src/lib/curriculum/participant-record.ts");
const { CURRICULUM_ROUTES } = await import("../src/routes/curriculum.ts");
const { CR_SURFACES } = await import("../../extensions/hypeproof-chat/src/curriculumRuntime.ts");
const { timelineRecord } = await import("../../extensions/hypeproof-chat/src/memoryView.ts");
const store = await import("../src/lib/curriculum/store.ts");
const { revokeToken } = await import("../src/lib/kv.ts");

const D1_MODE = process.argv.includes("--d1");
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}\n   ${err.stack ?? err.message}`);
  }
}

const MEMORY_ROUTES = CURRICULUM_ROUTES.filter((r) => /\/memory|\/director\/|\/problem$|\/hypotheses|\/stakeholder|\/metrics$|\/decisions|\/slides\//.test(r));
const MIGRATIONS = ["0032-curriculum-runtime-publish", "0033-curriculum-runtime-evidence", "0034-curriculum-runtime-memory"];

let mf = null;
async function fixture(opts = {}) {
  if (!D1_MODE) return localCurriculum(opts);
  const { createMiniflare } = await import("./harness/miniflare.mjs");
  const compatibilityDate = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
  mf ??= createMiniflare({ modules: true, script: 'export default {fetch(){return new Response("local test")}}', compatibilityDate, d1Databases: ["HPS_DB"], r2Buckets: ["HPS_TRACES"] });
  const db = await mf.getD1Database("HPS_DB");
  for (const t of ["cr_deck_slides", "cr_metrics", "cr_stakeholders", "cr_decisions", "cr_experiment_records", "cr_link_rates", "cr_cohort_controls", "cr_test_links", "cr_experiments", "cr_product_versions", "cr_hypotheses", "cr_projects"]) await db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  for (const m of MIGRATIONS) {
    const sql = readFileSync(new URL(`../migrations/${m}.sql`, import.meta.url), "utf8");
    // Twice: every migration is re-runnable.
    for (let i = 0; i < 2; i++) for (const s of sql.replace(/^--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  }
  const bucket = await mf.getR2Bucket("HPS_TRACES");
  for (let page = await bucket.list(); page.objects.length; page = await bucket.list()) await bucket.delete(page.objects.map((o) => o.key));
  return localCurriculum({ ...opts, binding: db, r2: bucket });
}

const PAGE = (marker) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>키오스크 연습</title></head><body><h1>${marker}</h1><button id="order">주문하기</button><script src="app.js"></script></body></html>`;
const V0 = { "index.html": PAGE("버전 0"), "app.js": "document.title += ' ok';" };
const V1 = { ...V0, "index.html": PAGE("버전 1 — 옵션 한 단계"), "help.html": PAGE("도움말") };
const OBSERVER = { note_kind: "observer_note", text: "옵션 고르는 화면에서 멈칫함", provenance: { who: "관찰자 A", when: "2주차 수업", where: "교실 키오스크 앞" }, source_state: "real" };

async function started(f, { token } = {}) {
  const t = token ?? (await f.student());
  const p = await f.api("/v1/curriculum/projects", { method: "POST", token: t, body: { title: "키오스크 실험" } });
  assert.equal(p.status, 201, p.text);
  const up = await f.upload(p.json.project.id, V0, t);
  assert.ok(up.status === 201 || up.status === 200, up.text);
  const e = await f.api("/v1/curriculum/experiments", {
    method: "POST",
    token: t,
    body: { project_id: p.json.project.id, product_version_id: up.id, week: 1, question: "도움 없이 주문을 마칠 수 있나?", method: "task_test", success_criteria: ["5명 중 3명 완료"], hypothesis: "처음 쓰는 사람도 혼자 주문할 수 있다" },
  });
  assert.equal(e.status, 201, e.text);
  const l = await f.api(`/v1/curriculum/experiments/${e.json.experiment.id}/links`, { method: "POST", token: t, body: { expires_at: Date.now() + 3600_000 } });
  assert.equal(l.status, 201, l.text);
  return { token: t, project: p.json.project, version: up.id, experiment: e.json.experiment, hypothesis: e.json.hypothesis, link: l.json.link, url: l.json.share_url };
}

/** One participant visit: the entry page, then the snippet's session open. Returns the session id. */
async function visit(f, s) {
  let page = await f.open(s.url);
  if (page.status === 302) page = await f.open(new URL(page.headers.get("location"), s.url).href);
  assert.equal(page.status, 200, page.text);
  const cfg = JSON.parse(/window\.__hpTest=(\{.*?\});<\/script>/.exec(page.text)[1]);
  const opened = await f.raw(new URL(`/l/${s.link.id}/__hp/session`, s.url).href, { method: "POST", body: { token: cfg.session_token } });
  assert.equal(opened.status, 204, opened.text);
  return cfg.session_id;
}

async function note(f, s, text = OBSERVER.text) {
  const r = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/notes`, { method: "POST", token: s.token, body: { ...OBSERVER, text } });
  assert.equal(r.status, 201, r.text);
  return r.json.note.id;
}

async function draft(f, s, items, author = "user") {
  const r = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts`, { method: "POST", token: s.token, body: { author, items: items.map((i) => ({ review: "draft", source_refs: [], ...i })) } });
  assert.equal(r.status, 201, r.text);
  return r.json.draft;
}

async function review(f, s, d, actions) {
  return f.api(`/v1/curriculum/experiments/${s.experiment.id}/drafts/${d.id}/review`, { method: "POST", token: s.token, body: { revision: d.revision, actions, reason: "학생이 읽고 고름" } });
}

const ev = (s, d, item) => venture.evidenceItemRef(s.experiment.id, d.id, item);
const mem = async (f, s, token = s.token) => {
  const r = await f.api(`/v1/curriculum/projects/${s.project.id}/memory`, { token });
  assert.equal(r.status, 200, r.text);
  return r.json.memory;
};

/**
 * The Week 1 → 2 fixture: a hypothesis tested on v0, two participant sessions and two notes,
 * an accepted draft with two observed, one interpreted and two assumed items, a team decision
 * that produced v1 citing two observed items and one assumption and affecting slides 2–3, the
 * hypothesis revised because of it, and slides 2 and 3 revised.
 */
async function week12(f) {
  const s = await started(f);
  const s1 = await visit(f, s);
  const s2 = await visit(f, s);
  const n1 = await note(f, s, "옵션 고르는 화면에서 멈칫함");
  const n2 = await note(f, s, "세 명 중 두 명이 옵션에서 멈춤");
  const d1 = await draft(f, s, [
    { id: "o1", section: "observation", text: "세 명 중 두 명이 옵션 선택에서 멈췄다", source_refs: [`note:${n1}`, `note:${n2}`] },
    { id: "o2", section: "observation", text: "두 세션이 열렸다", source_refs: [`session:${s1}`, `session:${s2}`] },
    { id: "i1", section: "interpretation", text: "옵션 단계가 너무 많다", source_refs: [`note:${n2}`] },
    { id: "a1", section: "assumption", text: "사용자는 한 단계면 혼자 주문한다", source_refs: [] },
    { id: "a2", section: "assumption", text: "어르신도 같은 문제를 겪는다", source_refs: [] },
  ]);
  const accepted = await review(f, s, d1, ["o1", "o2", "i1", "a1", "a2"].map((item) => ({ item, action: "accept" })));
  assert.equal(accepted.status, 201, accepted.text);
  const d = accepted.json.draft;
  const up1 = await f.upload(s.project.id, V1, s.token);
  assert.ok(up1.status === 201 || up1.status === 200, up1.text);
  const dec = await f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, {
    method: "POST",
    token: s.token,
    body: { author: "user", statement: "옵션 선택을 한 단계로 줄인다", evidence_refs: [ev(s, d, "o1"), ev(s, d, "i1")], assumption_refs: [ev(s, d, "a1")], resulting_version_id: up1.id, affected_deck_slides: [2, 3], experiment_id: s.experiment.id },
  });
  assert.equal(dec.status, 201, dec.text);
  const rev = await f.api(`/v1/curriculum/projects/${s.project.id}/hypotheses/${s.hypothesis.id}/revisions`, {
    method: "POST",
    token: s.token,
    body: { revision: 1, statement: "옵션이 한 단계면 처음 쓰는 사람도 혼자 주문할 수 있다", status: "revised", decision_id: dec.json.decision.id },
  });
  assert.equal(rev.status, 201, rev.text);
  for (const n of [2, 3]) {
    const sl = await f.api(`/v1/curriculum/projects/${s.project.id}/slides/${n}`, { method: "PUT", token: s.token, body: { title: n === 2 ? "문제" : "해결", body: "옵션 한 단계", evidence_refs: [ev(s, d, "o1")], decision_id: dec.json.decision.id } });
    assert.equal(sl.status, 201, sl.text);
  }
  return { ...s, sessions: [s1, s2], notes: [n1, n2], draft: d, v1: up1.id, decision: dec.json.decision };
}

// ── CR-T39 (unit): Evidence item, Decision and Artifact contracts ────────────────

const EV_SAMPLE = { id: "ev_018", type: "observation", source_refs: ["session_17", "note_9"], statement: "2 of 3 users paused at option selection", confidence: "observed", created_by: "student", created_at: "2026-10-02T09:00:00Z" };
const DEC_SAMPLE = { id: "dec_007", statement: "Reduce option selection to one step", evidence_refs: ["ev_018", "ev_019"], assumption_refs: ["asm_004"], resulting_version_id: "v8", affected_deck_slides: [2, 3], decided_at: "2026-10-02T09:30:00Z" };
const ART_SAMPLE = { artifact_id: "art_8", type: "product", schema_version: 1, entry_html: "index.html", project_id: "prj_abc", version: 8, source_refs: [], evidence_refs: [] };

await test("CR-T39: the PRD §10.2–10.4 samples validate; each with one required field removed is refused; observed with empty source_refs, slide 9 and an artifact without entry_html are refused", () => {
  const cases = [
    [venture.validateEvidenceItem, EV_SAMPLE, venture.EVIDENCE_ITEM_FIELDS],
    [venture.validateDecisionContract, DEC_SAMPLE, venture.DECISION_FIELDS],
    [venture.validateArtifactContract, ART_SAMPLE, venture.ARTIFACT_FIELDS],
  ];
  for (const [validate, sample, fields] of cases) {
    assert.equal(validate(sample).ok, true, `positive: ${JSON.stringify(validate(sample))}`);
    for (const field of fields) {
      const { [field]: _gone, ...rest } = sample;
      const r = validate(rest);
      assert.equal(r.ok, false, `${field} removed must be refused`);
      assert.ok(r.problems.includes(`missing:${field}`), JSON.stringify(r));
    }
  }
  assert.deepEqual(venture.validateEvidenceItem({ ...EV_SAMPLE, source_refs: [] }).problems, ["observed_without_source_refs"]);
  assert.equal(venture.validateEvidenceItem({ ...EV_SAMPLE, confidence: "assumed", source_refs: [] }).ok, true, "control: an assumption may have no source yet");
  assert.deepEqual(venture.validateDecisionContract({ ...DEC_SAMPLE, affected_deck_slides: [2, 9] }).problems, ["invalid:affected_deck_slides"]);
  assert.equal(venture.validateDecisionContract({ ...DEC_SAMPLE, affected_deck_slides: [1, 8] }).ok, true, "control: 1 and 8 are slides");
  assert.equal(venture.validateDecisionContract({ ...DEC_SAMPLE, resulting_version_id: null }).ok, true, "a decision before its version is built");
  for (const bad of [undefined, "", "index.png", "../index.html"]) {
    const a = bad === undefined ? (({ entry_html: _e, ...r }) => r)(ART_SAMPLE) : { ...ART_SAMPLE, entry_html: bad };
    assert.equal(venture.validateArtifactContract(a).ok, false, `entry_html ${JSON.stringify(bad)} refused`);
  }
  // Every product version's Artifact passes the same validator.
  const art = venture.artifactOfVersion({ id: "sha256:" + "a".repeat(64), project_id: "prj-0000000000000000", entry_html: "index.html" }, 0, []);
  assert.equal(venture.validateArtifactContract(art).ok, true);
});

// ── CR-T02 (Worker half): the memory routes ─────────────────────────────────────

await test("CR-T02 inventory: every memory route is in the App's switch-off inventory and mounted; an unmounted name is not", () => {
  assert.equal(MEMORY_ROUTES.length, 12, JSON.stringify(MEMORY_ROUTES));
  for (const r of MEMORY_ROUTES) assert.ok(CR_SURFACES.workerRoutes.includes(r), `${r} missing from CR_SURFACES.workerRoutes`);
  const src = readFileSync(new URL("../src/routes/curriculum.ts", import.meta.url), "utf8");
  const mounted = new Set([...src.matchAll(/curriculum\.(get|post|put|delete)\("([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} /v1/curriculum${m[2]}`));
  for (const r of MEMORY_ROUTES) assert.ok(mounted.has(r), `${r} is not mounted`);
  assert.ok(!mounted.has("GET /v1/curriculum/projects/:id/memorie"), "control");
});

/** With the switch off a CR route must answer exactly as an unknown route (status, body shape, headers). */
async function switchOffProblems(f, method, path, token) {
  const opts = { method, token, ...(method === "GET" ? {} : { body: {} }) };
  const got = await f.api(path, opts);
  const unknown = await f.api("/v1/cr-never-registered", opts);
  const shape = (r) => JSON.stringify({ s: r.status, t: r.json?.error?.type, m: r.json?.error?.message, keys: Object.keys(r.json?.error ?? {}).sort() });
  const headers = (r) => JSON.stringify([...(r.headers ?? [])].filter(([k]) => k !== "x-request-id").sort());
  const problems = [];
  if (shape(got) !== shape(unknown)) problems.push(`${method} ${path}: ${shape(got)} vs ${shape(unknown)}`);
  if (headers(got) !== headers(unknown)) problems.push(`${method} ${path}: headers differ`);
  if (got.json?.error?.path !== new URL("https://x" + path).pathname) problems.push(`${method} ${path}: path differs`);
  return problems;
}

await test("CR-T02 switch OFF: every memory route, with real ids and a student, a director or no token, answers as an unknown route; ON they answer", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    const director = await f.issuer();
    const real = (p) => p.replace(":hid", s.hypothesis.id).replace("/experiments/:id", `/experiments/${s.experiment.id}`).replace("/decisions/:id", `/decisions/${s.decision.id}`).replace(":id", s.project.id).replace(":n", "2");
    f.setSwitch(false);
    for (const route of MEMORY_ROUTES) {
      const [method, path] = route.split(" ");
      for (const token of [s.token, director, undefined]) assert.deepEqual(await switchOffProblems(f, method, real(path), token), [], `${route} (${token === director ? "director" : token ? "student" : "no token"})`);
    }
    // A director whose one scope mixes this Project's profile (off) with another profile (on)
    // passes the issuer gate, yet this Project stays unknown on every read and is not listed.
    const mixed = await f.issuer(f.cohort, [f.profile.id, f.other.id]);
    const memoryPath = `/v1/curriculum/projects/${s.project.id}/memory`;
    const diffPath = `${memoryPath}/diff?from=${encodeURIComponent(s.version)}&to=${encodeURIComponent(s.v1)}`;
    for (const path of [memoryPath, diffPath]) assert.deepEqual(await switchOffProblems(f, "GET", path, mixed), [], `mixed scope: ${path}`);
    const mixedList = await f.api("/v1/curriculum/director/projects", { token: mixed });
    assert.deepEqual([mixedList.status, mixedList.json.projects], [200, []], "mixed scope: the CR-off Project is not listed");
    f.setSwitch(true);
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/memory`, { token: s.token })).status, 200);
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/memory`, { token: director })).status, 200);
    assert.equal((await f.api(`/v1/curriculum/director/projects`, { token: director })).status, 200);
    assert.equal((await f.api(memoryPath, { token: mixed })).status, 200, "control: the same mixed director reads it once the switch is on");
    assert.deepEqual((await f.api("/v1/curriculum/director/projects", { token: mixed })).json.projects.map((p) => p.id), [s.project.id], "control: and lists it");
    // Instrument negative control: a planted memory route that answers with the switch off is caught.
    f.setSwitch(false);
    const planted = { ...f, api: (path, o) => (path.endsWith("/memory-planted") ? Promise.resolve({ status: 200, json: { memory: {} }, headers: new Headers() }) : f.api(path, o)) };
    assert.ok((await switchOffProblems(planted, "GET", `/v1/curriculum/projects/${s.project.id}/memory-planted`, s.token)).length > 0);
  } finally {
    f.setSwitch(true);
    f.close();
  }
});

// ── CR-T80 re-run: the Experiment and Hypothesis records cr-publish created, extended in place ──

/** Experiment or hypothesis tables outside the Venture Memory storage. */
const strayTables = (sql) => [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/gi)].map((m) => m[1]).filter((n) => /experiment|hypothes/i.test(n) && !["cr_experiments", "cr_hypotheses", "cr_experiment_records"].includes(n));
const allSql = () => [readFileSync(new URL("../schema.sql", import.meta.url), "utf8"), ...readdirSync(new URL("../migrations/", import.meta.url)).map((m) => readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"))].join("\n");

await test("CR-T80 (re-run by cr-memory): the §10.1 sample validates and any one field removed is refused; memory reads the same Hypothesis and Experiment rows, revises them in place, and no table sits beside them", async () => {
  const sample = { id: "exp_001", project_id: "prj_abc", week: 2, hypothesis_id: "hyp_003", question: "Can the user complete the order without help?", method: "task_test", success_criteria: ["3/5 complete", "no critical blocker"], product_version_id: "v7", status: "running" };
  assert.equal(venture.validateExperimentContract(sample).ok, true);
  for (const field of venture.EXPERIMENT_FIELDS) {
    const { [field]: _g, ...rest } = sample;
    assert.ok(venture.validateExperimentContract(rest).problems.includes(`missing:${field}`), field);
  }
  assert.equal(venture.validateExperimentContract({ ...sample, stakeholder_id: "stk_1" }).ok, true, "cr-memory's stakeholder key is additive");
  const f = await fixture();
  try {
    const s = await week12(f);
    const m = await mem(f, s);
    assert.deepEqual(m.experiments.map((e) => e.id), [s.experiment.id], "the experiment cr-publish stored, read, not copied");
    assert.deepEqual(m.hypotheses.map((h) => h.id), [s.hypothesis.id], "the hypothesis cr-publish stored, revised in place");
    assert.equal(m.hypotheses[0].revisions.length, 2);
    assert.equal(m.experiments[0].hypothesis_id, s.hypothesis.id);
    assert.ok(m.versions.some((v) => v.id === m.experiments[0].product_version_id), "product_version_id resolves");
    // An unresolved hypothesis is still refused at the start.
    const bad = await f.api("/v1/curriculum/experiments", { method: "POST", token: s.token, body: { project_id: s.project.id, product_version_id: s.version, week: 2, question: "q", method: "m", success_criteria: ["c"], hypothesis_id: "hyp-0000000000000000" } });
    assert.deepEqual([bad.status, bad.json.error.code], [409, "hypothesis_unresolved"]);
    if (f.db) assert.deepEqual([f.db.prepare("SELECT COUNT(*) n FROM cr_hypotheses").get().n, f.db.prepare("SELECT COUNT(*) n FROM cr_experiments").get().n], [1, 1], "one row each, after a revision");
  } finally {
    f.close();
  }
  assert.deepEqual(strayTables(allSql()), []);
  assert.deepEqual(strayTables(allSql() + "\nCREATE TABLE IF NOT EXISTS cr_hypothesis_revisions (id TEXT);"), ["cr_hypothesis_revisions"], "negative control: a hypothesis table beside the storage is caught");
});

// ── CR-T35 (worker D1): entities and links; evidence by reference only ───────────

/** Tables that would hold evidence or observations outside the measurement-core store (SX-48). */
const evidenceTables = (sql) => [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/gi)].map((m) => m[1]).filter((n) => /^cr_/.test(n) && /evidence|event|observ|note|draft|session|participant|interpret|finding/i.test(n));

await test("CR-T35: hypothesis → experiment → evidence → decision → version → slide round-trips; evidence items are references into the record, not rows; a duplicated evidence table is caught", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    const m = await mem(f, s);
    assert.equal(m.format, "hps-venture-memory/1");
    const chain = m.chains.find((c) => c.hypothesis.id === s.hypothesis.id);
    assert.deepEqual(chain.experiments.map((e) => e.id), [s.experiment.id]);
    assert.ok(chain.evidence.some((e) => e.ref === ev(s, s.draft, "o1")));
    assert.deepEqual(chain.decisions.map((d) => d.id), [s.decision.id]);
    assert.deepEqual(chain.versions, [s.v1]);
    const slides = m.deck_slides.filter((x) => x.decision_id === s.decision.id).map((x) => x.number);
    assert.deepEqual(slides, [2, 3], "the decision's slides");
    assert.equal(m.decisions[0].resulting_version_id, s.v1);
    assert.deepEqual(m.artifacts.map((a) => [a.version, a.type, a.entry_html]), [[0, "product", "index.html"], [1, "product", "index.html"]]);
    for (const a of m.artifacts) assert.equal(venture.validateArtifactContract(a).ok, true);
    assert.deepEqual(m.artifacts[1].evidence_refs.sort(), [ev(s, s.draft, "i1"), ev(s, s.draft, "o1")].sort(), "v1's artifact cites the decision's evidence");
    // Every evidence item maps onto the CR-40 contract.
    for (const it of m.evidence_items) assert.equal(venture.validateEvidenceItem({ ...it }).ok, true, JSON.stringify(it));
    // By reference: the statements live only in the record on R2, never in a D1 row.
    if (f.db) {
      const dump = ["cr_projects", "cr_hypotheses", "cr_experiments", "cr_decisions", "cr_deck_slides", "cr_stakeholders", "cr_metrics"].map((t) => JSON.stringify(f.db.prepare(`SELECT * FROM ${t}`).all())).join("\n");
      assert.ok(dump.includes(ev(s, s.draft, "o1")), "control: the reference is stored");
      assert.ok(!dump.includes("세 명 중 두 명이 옵션 선택에서 멈췄다"), "the evidence statement is not copied into Venture Memory");
    }
  } finally {
    f.close();
  }
  assert.deepEqual(evidenceTables(allSql()), []);
  assert.deepEqual(evidenceTables(allSql() + "\nCREATE TABLE IF NOT EXISTS cr_evidence_items (id TEXT);"), ["cr_evidence_items"], "negative control: a duplicated evidence table is caught");
  assert.deepEqual(evidenceTables(allSql() + "\nCREATE TABLE IF NOT EXISTS cr_observations (id TEXT);"), ["cr_observations"], "negative control: a duplicated observation table is caught");
});

// ── CR-T36 (Service half): reconstruction reads records only ─────────────────────

await test("CR-T36 (Service half): reopening reads the same state from records alone, with no model call; deleting a record changes it (the read is not cached)", async () => {
  const f = await fixture();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...a) => {
    calls++;
    return realFetch(...a);
  };
  try {
    const s = await week12(f);
    calls = 0;
    const a = await mem(f, s);
    const b = await mem(f, s);
    assert.equal(calls, 0, "no outbound call (no model, no chat history service) while reading memory");
    assert.deepEqual(a, b, "the same state on every reopen");
    // Negative control: a source record removed changes the read (it is computed, not a stored snapshot).
    const del = await f.api(`/v1/curriculum/experiments/${s.experiment.id}`, { method: "DELETE", token: s.token });
    assert.equal(del.status, 200, del.text);
    const c = await mem(f, s);
    assert.notDeepEqual(c.evidence_items, a.evidence_items);
    assert.equal(c.decisions[0].evidence.every((e) => e.state === "missing"), true, "a decision whose evidence was deleted shows it as missing, not hidden");
  } finally {
    globalThis.fetch = realFetch;
    f.close();
  }
});

// ── CR-T37 (worker D1): director traversal within scope ──────────────────────────

await test("CR-T37: a director in scope lists the team and walks hypothesis → evidence → decision → version; another cohort's director, another profile's, a student of another team: refused", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    const inScope = await f.issuer();
    const list = await f.api("/v1/curriculum/director/projects", { token: inScope });
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.json.projects.map((p) => p.id), [s.project.id]);
    const m = await mem(f, s, inScope);
    const chain = m.chains[0];
    assert.deepEqual([chain.hypothesis.id, chain.evidence.length > 0, chain.decisions[0].id, chain.versions[0]], [s.hypothesis.id, true, s.decision.id, s.v1]);
    for (const [label, token] of [
      ["another cohort's director", await f.issuer(f.otherCohort, f.other.id)],
      ["the right cohort, another profile", await f.issuer(f.cohort, f.other.id)],
      ["a student of another team", await f.student("cr-b")],
    ]) {
      const r = await f.api(`/v1/curriculum/projects/${s.project.id}/memory`, { token });
      assert.deepEqual([r.status, r.json?.error?.type], [404, "not_found"], label);
      const d = await f.api(`/v1/curriculum/projects/${s.project.id}/memory/diff?from=${encodeURIComponent(s.version)}&to=${encodeURIComponent(s.v1)}`, { token });
      assert.equal(d.status, 404, `${label}: diff`);
    }
    const other = await f.api("/v1/curriculum/director/projects", { token: await f.issuer(f.otherCohort, f.other.id) });
    assert.deepEqual(other.json.projects, [], "another cohort's director lists none of this cohort's teams");
    const sameCohort = await f.api("/v1/curriculum/director/projects", { token: await f.issuer(f.cohort, f.other.id) });
    assert.deepEqual([sameCohort.status, sameCohort.json.projects], [200, []], "the right cohort, another profile: lists none of this profile's teams");
    // A revoked director token reads nothing (it was read before the revocation: control).
    const issued = await f.issuerIssued();
    const memPath = `/v1/curriculum/projects/${s.project.id}/memory`;
    assert.equal((await f.api(memPath, { token: issued.token })).status, 200, "control: the token reads before it is revoked");
    await revokeToken(f.env.HPS_KV, issued.jti, { reason: "test", by: "test" }, 3600);
    const revoked = await f.api(memPath, { token: issued.token });
    assert.deepEqual([revoked.status, revoked.json.error.code], [401, "revoked"], "a revoked director token is refused");
    // A director cannot write the team's memory (reads only; decisions are the team's, SX-45).
    const w = await f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: inScope, body: { author: "user", statement: "x" } });
    assert.equal(w.status, 404);
  } finally {
    f.close();
  }
});

// ── CR-T38: decisions link evidence and slides and record their actor ─────────────

/** The instrument: every stored decision is shown, with its actor and its no-evidence mark. */
function decisionsShownProblems(view, stored) {
  const problems = [];
  for (const d of stored) {
    const v = view.decisions.find((x) => x.id === d.id);
    if (!v) problems.push(`${d.id}: hidden`);
    else {
      if (v.no_evidence !== (d.evidence_refs.length === 0)) problems.push(`${d.id}: no-evidence mark wrong`);
      if (d.actor === "ai" && v.shown_as === "team_decision") problems.push(`${d.id}: AI shown as the team's decision`);
    }
  }
  return problems;
}

await test("CR-T38: a student decision with two evidence refs and slides 2–3 validates; a dangling ref is refused; an AI decision is never the team's; a decision with no evidence is shown and marked", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    assert.deepEqual([s.decision.actor, s.decision.decided_by, s.decision.affected_deck_slides, s.decision.evidence_refs.length, s.decision.shown_as], ["student", "cr-a", [2, 3], 2, "team_decision"]);
    const post = (body) => f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "user", statement: "결정", ...body } });
    for (const [label, ref] of [["missing item", ev(s, s.draft, "zz")], ["missing draft", `ev:${s.experiment.id}/drf-0000000000000000/o1`], ["another project's experiment", "ev:exp-0000000000000000/drf-0000000000000000/o1"], ["not an evidence ref", "note:abc"]]) {
      const r = await post({ evidence_refs: [ref] });
      assert.deepEqual([r.status, r.json.error.code], [409, "unresolved_decision_refs"], label);
    }
    const ai = await f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "ai", statement: "AI 제안: 버튼을 키운다", evidence_refs: [ev(s, s.draft, "o2")] } });
    assert.equal(ai.status, 201, ai.text);
    assert.deepEqual([ai.json.decision.actor, ai.json.decision.shown_as, ai.json.decision.decided_by], ["ai", "ai_suggestion", undefined]);
    const bare = await post({});
    assert.equal(bare.status, 201, bare.text);
    assert.equal((await post({ author: undefined })).json.error.code, "missing_author", "the author is stated, never defaulted");
    const m = await mem(f, s);
    const stored = m.decisions.map(({ shown_as: _a, no_evidence: _b, evidence: _c, assumptions: _d, ...d }) => d);
    assert.deepEqual(decisionsShownProblems(m, stored), [], "positive: every decision shown, marked, actors kept");
    assert.equal(m.decisions.find((d) => d.id === bare.json.decision.id).no_evidence, true);
    // Planted defects the instrument must catch.
    assert.ok(decisionsShownProblems({ decisions: m.decisions.filter((d) => !d.no_evidence) }, stored).some((p) => /hidden/.test(p)), "a hidden no-evidence decision is caught");
    assert.ok(decisionsShownProblems({ decisions: m.decisions.map((d) => ({ ...d, no_evidence: false })) }, stored).some((p) => /no-evidence/.test(p)), "a missing no-evidence mark is caught");
    assert.ok(decisionsShownProblems({ decisions: m.decisions.map((d) => ({ ...d, shown_as: "team_decision" })) }, stored).some((p) => /AI shown/.test(p)), "an AI decision shown as the team's is caught");
    // The AI suggestion is not a chain decision's version and not a belief reason.
    assert.ok(m.timeline.some((e) => e.entry === "ai_suggestion" && e.record.id === ai.json.decision.id));
    // Linking the version once.
    const link = await f.api(`/v1/curriculum/decisions/${bare.json.decision.id}/version`, { method: "POST", token: s.token, body: { version_id: s.v1 } });
    assert.equal(link.status, 200, link.text);
    assert.equal((await f.api(`/v1/curriculum/decisions/${bare.json.decision.id}/version`, { method: "POST", token: s.token, body: { version_id: s.version } })).json.error.code, "version_already_linked");
    assert.equal((await post({ resulting_version_id: "sha256:" + "0".repeat(64) })).status, 409, "a version of no project is refused");
    // An assumption is cited as an assumption: as evidence, or in both lists, it is refused.
    assert.deepEqual((await post({ evidence_refs: [ev(s, s.draft, "a2")] })).json.error.problems, [`evidence_ref_is_assumption:${ev(s, s.draft, "a2")}`]);
    assert.deepEqual((await post({ evidence_refs: [ev(s, s.draft, "a2")], assumption_refs: [ev(s, s.draft, "a2")] })).json.error.problems, [`evidence_ref_is_assumption:${ev(s, s.draft, "a2")}`]);
    // An AI draft item the student never reviewed is listed but is not the team's evidence yet.
    const aiDraft = await draft(f, s, [{ id: "x1", section: "observation", text: "AI 관찰(검토 안 됨)", source_refs: [`session:${s.sessions[0]}`] }], "ai");
    const unreviewed = await post({ evidence_refs: [ev(s, aiDraft, "x1")] });
    assert.deepEqual([unreviewed.status, unreviewed.json.error.problems], [409, [`evidence_ref_not_reviewed:${ev(s, aiDraft, "x1")}`]]);
    const listed = (await mem(f, s)).register.observed.find((x) => x.id === ev(s, aiDraft, "x1"));
    assert.deepEqual([listed.pending_review, listed.created_by], [true, "system"], "listed, marked pending review");
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "ai", statement: "AI 제안", evidence_refs: [ev(s, aiDraft, "x1")] } })).status, 201, "control: an AI suggestion may cite it");
    const reviewed = await review(f, s, aiDraft, [{ item: "x1", action: "accept" }]);
    assert.equal(reviewed.status, 201, reviewed.text);
    assert.equal((await post({ evidence_refs: [ev(s, aiDraft, "x1")] })).status, 201, "control: once the student reviewed it, the team may rest on it");
  } finally {
    f.close();
  }
});

// ── CR-T70: stakeholder roles ─────────────────────────────────────────────────────

await test("CR-T70: a stakeholder holding user and payer with evidence refs validates and shows both roles; no role, an observed role without refs, or with refs that do not resolve, is refused; a role without evidence reads assumed", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    const post = (body) => f.api(`/v1/curriculum/projects/${s.project.id}/stakeholders`, { method: "POST", token: s.token, body });
    const ok = await post({ label: "학교 매점 운영자", roles: [{ role: "user", evidence_refs: [ev(s, s.draft, "o1")], basis: "observed" }, { role: "payer", evidence_refs: [ev(s, s.draft, "o2")], basis: "observed" }, { role: "beneficiary", evidence_refs: [] }] });
    assert.equal(ok.status, 201, ok.text);
    const m = await mem(f, s);
    const st = m.stakeholders[0];
    assert.deepEqual(st.roles_shown.map((r) => [r.role, r.confidence]), [["user", "observed"], ["payer", "observed"], ["beneficiary", "assumed"]]);
    assert.equal(st.payer_and_user, true, "payer and user held by one stakeholder: recorded, both roles kept");
    const single = await post({ label: "이용만 하는 손님", roles: [{ role: "user", evidence_refs: [] }] });
    assert.equal(single.status, 201, single.text);
    assert.equal((await mem(f, s)).stakeholders.find((x) => x.id === single.json.stakeholder.id).payer_and_user, false, "one role only: never read as payer and user");
    assert.deepEqual((await post({ label: "x", roles: [] })).json.error.problems, ["missing:roles"]);
    assert.deepEqual((await post({ label: "x" })).json.error.problems, ["missing:roles"]);
    assert.deepEqual((await post({ label: "x", roles: [{ role: "payer", evidence_refs: [], basis: "observed" }] })).json.error.problems, ["observed_role_without_evidence:payer"]);
    const dangling = await post({ label: "x", roles: [{ role: "payer", evidence_refs: [ev(s, s.draft, "nope")], basis: "observed" }] });
    assert.deepEqual([dangling.status, dangling.json.error.code], [409, "unresolved_evidence_ref"]);
    // Hypotheses and experiments name the stakeholder they concern.
    const h = await f.api(`/v1/curriculum/projects/${s.project.id}/hypotheses`, { method: "POST", token: s.token, body: { statement: "운영자가 비용을 낸다", stakeholder_id: st.id } });
    assert.equal(h.status, 201, h.text);
    assert.equal(h.json.hypothesis.stakeholder_id, st.id);
    const e = await f.api(`/v1/curriculum/experiments/${s.experiment.id}/stakeholder`, { method: "POST", token: s.token, body: { stakeholder_id: st.id } });
    assert.deepEqual([e.status, e.json.experiment.stakeholder_id, e.json.experiment.id], [200, st.id, s.experiment.id]);
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/stakeholder`, { method: "POST", token: s.token, body: { stakeholder_id: "stk-0000000000000000" } })).json.error.code, "stakeholder_unresolved");
    // A role claimed observed resting only on an assumption (or interpretation) is refused.
    for (const item of ["a2", "i1"]) {
      const weak = await post({ label: "x", roles: [{ role: "payer", evidence_refs: [ev(s, s.draft, item)], basis: "observed" }] });
      assert.deepEqual([weak.status, weak.json.error.code], [409, "observed_role_without_observed_evidence"], item);
    }
    assert.equal((await post({ label: "y", roles: [{ role: "payer", evidence_refs: [ev(s, s.draft, "a2"), ev(s, s.draft, "o1")], basis: "observed" }] })).status, 201, "control: one observed item among them is enough");
    // Another Project's stakeholder is never this Project's: refused on every path that names one.
    const other = await started(f, { token: s.token });
    const foreign = await f.api(`/v1/curriculum/projects/${other.project.id}/stakeholders`, { method: "POST", token: s.token, body: { label: "다른 팀 손님", roles: [{ role: "user", evidence_refs: [] }] } });
    assert.equal(foreign.status, 201, foreign.text);
    const fid = foreign.json.stakeholder.id;
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/hypotheses`, { method: "POST", token: s.token, body: { statement: "다른 팀 손님이 산다", stakeholder_id: fid } })).json.error.code, "stakeholder_unresolved", "hypothesis");
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/stakeholder`, { method: "POST", token: s.token, body: { stakeholder_id: fid } })).json.error.code, "stakeholder_unresolved", "experiment link");
    const expBody = (stakeholder_id) => ({ project_id: s.project.id, product_version_id: s.version, week: 2, question: "어르신도 혼자 주문하나?", method: "task_test", success_criteria: ["3명 중 2명 완료"], hypothesis: "어르신도 혼자 주문할 수 있다", stakeholder_id });
    const fe = await f.api("/v1/curriculum/experiments", { method: "POST", token: s.token, body: expBody(fid) });
    assert.deepEqual([fe.status, fe.json.error.code], [409, "stakeholder_unresolved"], "experiment start");
    const okExp = await f.api("/v1/curriculum/experiments", { method: "POST", token: s.token, body: expBody(st.id) });
    assert.equal(okExp.status, 201, okExp.text);
    assert.equal(okExp.json.experiment.stakeholder_id, st.id, "control: this Project's stakeholder is accepted at the start");
    // After the experiment's data is deleted (CR-69), a role resting on it is no longer observed,
    // and the experiment's stakeholder can no longer be changed.
    const del = await f.api(`/v1/curriculum/experiments/${s.experiment.id}`, { method: "DELETE", token: s.token });
    assert.equal(del.status, 200, del.text);
    const after = (await mem(f, s)).stakeholders.find((x) => x.id === st.id);
    assert.deepEqual(after.roles_shown.map((r) => [r.role, r.confidence]), [["user", "unsupported"], ["payer", "unsupported"], ["beneficiary", "assumed"]]);
    assert.equal((await f.api(`/v1/curriculum/experiments/${s.experiment.id}/stakeholder`, { method: "POST", token: s.token, body: { stakeholder_id: st.id } })).json.error.code, "experiment_data_deleted");
  } finally {
    f.close();
  }
});

await test("CR-T70 (unit): a role's confidence is derived on read — observed only over a reviewed observed item, unsupported when nothing resolves", () => {
  const item = (id, confidence, pending_review = false) => [id, { id, confidence, pending_review }];
  const items = new Map([item("o", "observed"), item("a", "assumed"), item("x", "observed", true)]);
  const role = (refs) => ({ role: "payer", basis: "observed", evidence_refs: refs });
  assert.deepEqual([["o"], ["a"], ["x"], ["gone"], ["a", "o"]].map((r) => memory.roleConfidence(role(r), items)), ["observed", "assumed", "assumed", "unsupported", "observed"]);
  assert.equal(memory.roleConfidence({ role: "user", evidence_refs: ["o"] }, items), "assumed", "no observed claim: assumed");
});

await test("CR-75 store race: setting an experiment's stakeholder never overwrites a concurrent close for deletion (CR-69); a planted unguarded write does", async () => {
  const run = async (setStakeholder) => {
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    const base = sqliteBinding(db);
    let gate = null;
    // The first UPDATE of cr_experiments waits for `gate` (the deletion's close) to run first.
    const binding = { prepare(sql) { const st = base.prepare(sql); return { bind(...a) { st.bind(...a); return this; }, first: () => st.first(), all: () => st.all(), async run() { if (gate && /^UPDATE cr_experiments/.test(sql)) { const g = gate; gate = null; await g(); } return st.run(); } }; } };
    const exp = { schema: "hps-venture/1", kind: "experiment", id: "exp-00000000000000aa", project_id: "prj-00000000000000aa", week: 1, hypothesis_id: "hyp-00000000000000aa", question: "q", method: "m", success_criteria: ["c"], product_version_id: "sha256:" + "a".repeat(64), status: "running", created_at: 1 };
    db.prepare("INSERT INTO cr_experiments (id, project_id, hypothesis_id, product_version_id, doc, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, 1)").run(exp.id, exp.project_id, exp.hypothesis_id, exp.product_version_id, JSON.stringify(exp));
    gate = () => store.closeExperimentAfterDeletion(base, exp, 5);
    const r = await setStakeholder(binding, exp);
    const stored = JSON.parse(db.prepare("SELECT doc FROM cr_experiments WHERE id = ?").get(exp.id).doc);
    db.close();
    return { r, stored };
  };
  const real = await run((b, e) => store.setExperimentStakeholder(b, e, "stk-00000000000000aa", 6));
  assert.deepEqual([real.r.ok, real.r.code], [false, "experiment_data_deleted"], "the guarded write sees the close and refuses");
  assert.deepEqual([real.stored.status, real.stored.data_deletion_pending, typeof real.stored.data_deleted_at, real.stored.stakeholder_id], ["closed", true, "number", undefined]);
  // Planted: the unguarded read-modify-write this slice first shipped.
  const unguarded = async (db, e) => {
    const fresh = await store.getExperiment(db, e.id);
    await db.prepare("UPDATE cr_experiments SET doc = ?, revision = revision + 1, updated_at = ? WHERE id = ?").bind(JSON.stringify({ ...fresh, stakeholder_id: "stk-00000000000000aa" }), 6, e.id).run();
  };
  const planted = await run(unguarded);
  assert.equal(planted.stored.status, "running", "instrument: the planted write reopens the deleted experiment, and is caught");
});

// ── CR-T71 (unit): metric values keep sources and source_state ─────────────────────

const pev = (i, state, kind = "task_complete", label = "주문") => ({ id: `e${i}`, kind, label, source_state: state, participant: { session_id: `ps-${String(i).padStart(32, "0")}` } });
const METRIC = { schema: "hps-venture/1", kind: "metric", id: "met-1", project_id: "prj-1", name: "혼자 주문 완료", metric_kind: "impact", definition: "도움 없이 주문을 마친 세션 수", unit: "세션", stakeholder_id: "stk-1", source: { type: "event_count", experiment_id: "exp-1", event_kind: "task_complete", label: "주문" }, created_at: 1 };

/** The instrument: a result counts real inputs only, and every counted input is cited. */
function metricProblems(value, events) {
  const real = new Set(events.filter((e) => e.source_state === "real").map((e) => `event:${e.participant.session_id}/${e.id}`));
  const problems = [];
  if (value.status === "result" && value.source_refs.some((r) => !real.has(r))) problems.push("non-real input counted into a result");
  if (value.status === "result" && value.value !== value.source_refs.length) problems.push("value without a source per unit");
  if (value.status === "result" && value.source_refs.length === 0) problems.push("result with no source");
  return problems;
}

await test("CR-T71: an impact metric from three real events shows 3 with the three refs; a simulated input is labelled and never counted; no source is unsupported; an impact metric with no stakeholder is refused", () => {
  const events = [pev(1, "real"), pev(2, "real"), pev(3, "real"), pev(4, "simulated"), pev(5, "self_reported"), pev(6, "real", "click")];
  const ctx = { experiments: new Set(["exp-1"]), events: new Map([["exp-1", events]]), items: new Map() };
  const v = memory.metricValue(METRIC, ctx);
  assert.deepEqual([v.status, v.value, v.source_refs.length, v.source_state, v.not_counted], ["result", 3, 3, "real", { simulated: 1, self_reported: 1 }]);
  assert.deepEqual(metricProblems(v, events), []);
  // Planted defect: a value that counts the simulated input into the result is caught.
  const planted = { ...v, value: 4, source_refs: [...v.source_refs, `event:${events[3].participant.session_id}/e4`] };
  assert.ok(metricProblems(planted, events).includes("non-real input counted into a result"));
  // No resolvable source: unsupported, no value.
  assert.deepEqual([memory.metricValue(METRIC, { ...ctx, events: new Map([["exp-1", [pev(1, "simulated")]]]) }).status, memory.metricValue(METRIC, { ...ctx, experiments: new Set() }).value], ["unsupported", null]);
  assert.equal(memory.metricValue({ ...METRIC, source: { type: "evidence_items", refs: ["ev:exp-1/d/x"] } }, ctx).status, "unsupported");
  const eo = memory.metricValue({ ...METRIC, source: { type: "evidence_items", refs: ["ev:exp-1/d/x", "ev:exp-1/d/y"] } }, { ...ctx, items: new Map([["ev:exp-1/d/x", { confidence: "observed", review: "accepted" }]]) });
  assert.deepEqual([eo.status, eo.value, eo.evidence], ["evidence_only", null, [{ ref: "ev:exp-1/d/x", confidence: "observed", review: "accepted" }]], "evidence_only carries the cited items' confidence");
  const { stakeholder_id: _s, ...noStakeholder } = METRIC;
  assert.ok(venture.validateMetric(noStakeholder).problems.includes("impact_without_stakeholder"));
  assert.equal(venture.validateMetric({ ...noStakeholder, metric_kind: "usage" }).ok, true, "control: a usage metric may name no stakeholder");
});

await test("CR-T71 (route): a metric is stored as a definition; its value is computed on read; an impact metric without a stakeholder or over another project's experiment is refused", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    const st = await f.api(`/v1/curriculum/projects/${s.project.id}/stakeholders`, { method: "POST", token: s.token, body: { label: "처음 쓰는 손님", roles: [{ role: "user", evidence_refs: [] }] } });
    const post = (body) => f.api(`/v1/curriculum/projects/${s.project.id}/metrics`, { method: "POST", token: s.token, body: { name: "혼자 주문 완료", metric_kind: "impact", definition: "도움 없이 주문을 마친 세션 수", unit: "세션", source: { type: "event_count", experiment_id: s.experiment.id, event_kind: "task_complete" }, ...body } });
    assert.equal((await post({})).json.error.problems.includes("impact_without_stakeholder"), true);
    assert.equal((await post({ stakeholder_id: st.json.stakeholder.id, source: { type: "event_count", experiment_id: "exp-0000000000000000", event_kind: "task_complete" } })).json.error.code, "experiment_unresolved");
    const ok = await post({ stakeholder_id: st.json.stakeholder.id });
    assert.equal(ok.status, 201, ok.text);
    const m = await mem(f, s);
    assert.deepEqual([m.metrics[0].value.status, m.metrics[0].value.value], ["unsupported", null], "no task was completed yet: no value is shown");
  } finally {
    f.close();
  }
});

// ── CR-T72: product version diff ───────────────────────────────────────────────────

await test("CR-T72: the v0 → v1 diff lists the changed files and the decision with its evidence; across two projects it is refused; a version with no recorded decision says so, with no reason", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    const r = await f.api(`/v1/curriculum/projects/${s.project.id}/memory/diff?from=${encodeURIComponent(s.version)}&to=${encodeURIComponent(s.v1)}`, { token: s.token });
    assert.equal(r.status, 200, r.text);
    const d = r.json.diff;
    assert.deepEqual(d.files, [{ path: "help.html", change: "added" }, { path: "index.html", change: "modified" }]);
    assert.deepEqual([d.reason, d.decisions.map((x) => x.id), d.decisions[0].evidence.map((e) => e.state)], ["recorded", [s.decision.id], ["ok", "ok"]]);
    // Reversed order still compares older → newer.
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/memory/diff?from=${encodeURIComponent(s.v1)}&to=${encodeURIComponent(s.version)}`, { token: s.token })).json.diff.to.id, s.v1);
    // Another project of the same student: its version is not this project's.
    const other = await started(f, { token: s.token });
    const v2 = await f.upload(other.project.id, { ...V0, "index.html": PAGE("다른 프로젝트") }, s.token);
    const cross = await f.api(`/v1/curriculum/projects/${s.project.id}/memory/diff?from=${encodeURIComponent(s.version)}&to=${encodeURIComponent(v2.id)}`, { token: s.token });
    assert.deepEqual([cross.status, cross.json.error.code], [409, "cross_project"]);
    // A newer version with no recorded decision: "no recorded decision", nothing inferred.
    const v2own = await f.upload(s.project.id, { ...V1, "index.html": PAGE("버전 2") }, s.token);
    const nd = (await f.api(`/v1/curriculum/projects/${s.project.id}/memory/diff?from=${encodeURIComponent(s.v1)}&to=${encodeURIComponent(v2own.id)}`, { token: s.token })).json.diff;
    assert.deepEqual([nd.reason, nd.decisions], ["no_recorded_decision", []]);
    assert.ok(!("why" in nd) && !("summary" in nd), "no generated reason field");
    // An AI suggestion linked to the newer version is not the decision behind it.
    const ai = await f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "ai", statement: "AI 제안: 도움말 페이지", evidence_refs: [] } });
    assert.equal((await f.api(`/v1/curriculum/decisions/${ai.json.decision.id}/version`, { method: "POST", token: s.token, body: { version_id: v2own.id } })).status, 200);
    const aiDiff = (await f.api(`/v1/curriculum/projects/${s.project.id}/memory/diff?from=${encodeURIComponent(s.v1)}&to=${encodeURIComponent(v2own.id)}`, { token: s.token })).json.diff;
    assert.deepEqual([aiDiff.reason, aiDiff.decisions], ["no_recorded_decision", []], "an AI suggestion is never the recorded reason");
    // Pure: two versions of different projects are refused even when handed in directly.
    const pv = (id, project) => ({ id, project_id: project, files: [{ path: "index.html", sha256: id, bytes: 1 }], entry_html: "index.html", created_at: 1 });
    assert.deepEqual(memory.versionDiff("prj-a", pv("a", "prj-a"), pv("b", "prj-b"), [], new Map()), { ok: false, code: "cross_project" });
  } finally {
    f.close();
  }
});

// ── CR-T73: the timeline ───────────────────────────────────────────────────────────

/** The instrument: every entry opens a stored record; an AI-actor decision is never a "decision" entry. */
function timelineProblems(records, entries) {
  const problems = [];
  for (const e of entries) {
    const rec = memory.openRecord(records, e.record);
    if (!rec) problems.push(`no record: ${JSON.stringify(e.record)}`);
    else if (e.record.kind === "decision" && rec.actor === "ai" && e.entry === "decision") problems.push(`AI suggestion shown as a decision: ${e.record.id}`);
  }
  for (let i = 1; i < entries.length; i++) if (entries[i].at < entries[i - 1].at) problems.push("not in time order");
  return problems;
}

await test("CR-T73: the Week 1 → 2 fixture's timeline is time-ordered and every entry opens its record, with zero model calls; a planted entry with no record and an AI suggestion shown as a decision are caught", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    await f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "ai", statement: "AI 제안", evidence_refs: [] } });
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (...a) => (calls++, realFetch(...a));
    let m;
    try {
      m = await mem(f, s);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls, 0, "the timeline read makes no outbound (model) call");
    const records = { project: m.project, hypotheses: m.hypotheses, experiments: m.experiments, versions: m.versions, decisions: m.decisions, stakeholders: [], metrics: [], slides: m.slide_revisions, items: m.evidence_items };
    assert.deepEqual(timelineProblems(records, m.timeline), []);
    const kinds = new Set(m.timeline.map((e) => e.entry));
    for (const k of ["hypothesis", "hypothesis_revised", "experiment", "product_version", "evidence_item", "decision", "ai_suggestion", "deck_slide"]) assert.ok(kinds.has(k), `timeline has ${k}`);
    // A planted entry with no record, one per kind, is caught.
    for (const record of [{ kind: "decision", id: "dec-0000000000000000" }, { kind: "hypothesis", id: s.hypothesis.id, revision: 99 }, { kind: "experiment", id: "exp-0000000000000000" }, { kind: "evidence_item", id: ev(s, s.draft, "zz") }, { kind: "deck_slide", id: "2", revision: 99 }, { kind: "product_version", id: "sha256:" + "0".repeat(64) }]) {
      assert.ok(timelineProblems(records, [...m.timeline, { at: Date.now() + 1, entry: "decision", label: "만든 기록", record }]).some((p) => p.startsWith("no record")), `a planted ${record.kind} entry with no record is caught`);
    }
    // The App opens every entry of this real read from the same answer (CR-78, the panel's path).
    assert.deepEqual(m.timeline.filter((e) => !timelineRecord(m, e.record)).map((e) => e.record), [], "every entry opens in the App");
    assert.equal(timelineRecord({ ...m, slide_revisions: [] }, m.timeline.find((e) => e.entry === "deck_slide").record), null, "control: without the slide revisions the App could not open a slide entry");
    const aiEntry = m.timeline.find((e) => e.entry === "ai_suggestion");
    assert.ok(timelineProblems(records, m.timeline.map((e) => (e === aiEntry ? { ...e, entry: "decision" } : e))).some((p) => p.startsWith("AI suggestion")), "an AI suggestion shown as a decision is caught");
  } finally {
    f.close();
  }
});

// ── CR-T74: "belief changed because…" ──────────────────────────────────────────────

await test("CR-T74: a hypothesis revised after a decision shows before, after, the decision and its evidence; a revision with no decision reads 'reason not recorded'; an overwrite fails the revision check", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    let m = await mem(f, s);
    const b = m.belief_changes.find((x) => x.hypothesis_id === s.hypothesis.id);
    assert.deepEqual([b.before.statement, b.after.statement, b.after.status, b.decision.id, b.reason], ["처음 쓰는 사람도 혼자 주문할 수 있다", "옵션이 한 단계면 처음 쓰는 사람도 혼자 주문할 수 있다", "revised", s.decision.id, "recorded"]);
    assert.deepEqual(b.evidence.map((e) => e.ref).sort(), [ev(s, s.draft, "i1"), ev(s, s.draft, "o1")].sort());
    // A "because" that is only an assumption, or only an AI item the student never reviewed, is
    // refused even with a team decision linked (CR-79: every reason cites evidence; SX-45, MC-22).
    const bareDec = await f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "user", statement: "근거 없이 정한 것" } });
    assert.equal(bareDec.status, 201, bareDec.text);
    const aiDraft = await draft(f, s, [{ id: "x1", section: "observation", text: "AI: 모두 성공했다", source_refs: [`session:${s.sessions[0]}`] }], "ai");
    const reviseWith = (refs) => f.api(`/v1/curriculum/projects/${s.project.id}/hypotheses/${s.hypothesis.id}/revisions`, { method: "POST", token: s.token, body: { revision: 2, status: "supported", decision_id: bareDec.json.decision.id, evidence_refs: refs } });
    for (const [ref, problem] of [[ev(s, s.draft, "a2"), "evidence_ref_is_assumption"], [ev(s, aiDraft, "x1"), "evidence_ref_not_reviewed"]]) {
      const refused = await reviseWith([ref]);
      assert.deepEqual([refused.status, refused.json.error.code, refused.json.error.problems], [409, "evidence_ref_refused", [`${problem}:${ref}`]], problem);
    }
    const dangling = await reviseWith([ev(s, s.draft, "zz")]);
    assert.deepEqual([dangling.status, dangling.json.error.code], [409, "unresolved_evidence_ref"], "a dangling ev: ref is refused");
    assert.equal((await mem(f, s)).hypotheses[0].revision, 2, "no refused revision was written");
    // A revision with no decision and no evidence.
    const r = await f.api(`/v1/curriculum/projects/${s.project.id}/hypotheses/${s.hypothesis.id}/revisions`, { method: "POST", token: s.token, body: { revision: 2, status: "supported" } });
    assert.equal(r.status, 201, r.text);
    m = await mem(f, s);
    const last = m.belief_changes.filter((x) => x.hypothesis_id === s.hypothesis.id).at(-1);
    assert.deepEqual([last.reason, last.decision, last.evidence], ["reason_not_recorded", null, []]);
    assert.deepEqual(m.hypotheses[0].revisions.map((x) => x.statement), ["처음 쓰는 사람도 혼자 주문할 수 있다", "옵션이 한 단계면 처음 쓰는 사람도 혼자 주문할 수 있다", "옵션이 한 단계면 처음 쓰는 사람도 혼자 주문할 수 있다"], "every earlier statement kept");
    // Stale revision, an AI suggestion as the reason: refused.
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/hypotheses/${s.hypothesis.id}/revisions`, { method: "POST", token: s.token, body: { revision: 1, status: "refuted" } })).json.error.code, "stale_revision");
    const ai = await f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "ai", statement: "AI 제안" } });
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/hypotheses/${s.hypothesis.id}/revisions`, { method: "POST", token: s.token, body: { revision: 3, status: "refuted", decision_id: ai.json.decision.id } })).json.error.code, "decision_is_ai_suggestion");
    // The revision check (pure): rewriting an earlier statement fails it.
    const h = m.hypotheses[0];
    const good = { ...h, statement: "새 믿음", status: "revised", revision: 4, revisions: [...h.revisions, { revision: 4, statement: "새 믿음", status: "revised", at: 9, by: "cr-a" }] };
    assert.deepEqual(venture.hypothesisRevisionProblems(h, good), []);
    const overwritten = { ...good, revisions: good.revisions.map((x, i) => (i === 0 ? { ...x, statement: "처음부터 옵션이 문제였다" } : x)) };
    assert.ok(venture.hypothesisRevisionProblems(h, overwritten).includes("revision_rewritten:1"));
    const replaced = { ...h, statement: "새 믿음", revisions: [{ revision: 1, statement: "새 믿음", status: "open", at: 1, by: "x" }] };
    assert.ok(venture.hypothesisRevisionProblems(h, replaced).length > 0, "a replacement in place is not a revision");
    // Evidence cited but no team decision: what was seen, not what the team changed — reason not recorded.
    const evOnly = await f.api(`/v1/curriculum/projects/${s.project.id}/hypotheses/${s.hypothesis.id}/revisions`, { method: "POST", token: s.token, body: { revision: 3, status: "supported", evidence_refs: [ev(s, s.draft, "o1")] } });
    assert.equal(evOnly.status, 201, evOnly.text);
    const evLast = (await mem(f, s)).belief_changes.filter((x) => x.hypothesis_id === s.hypothesis.id).at(-1);
    assert.deepEqual([evLast.reason, evLast.decision, evLast.evidence.map((e) => e.ref)], ["reason_not_recorded", null, [ev(s, s.draft, "o1")]]);
  } finally {
    f.close();
  }
});

await test("CR-T74 (unit): a belief change reads 'recorded' only on the team's decision and evidence it may rest on; an assumption, an unreviewed AI item, an unreal record or an AI suggestion is never the reason", () => {
  const item = (id, confidence, extra = {}) => [id, { id, statement: id, confidence, pending_review: false, sources_real: true, ...extra }];
  const items = new Map([item("A", "assumed"), item("X", "observed", { pending_review: true }), item("N", "observed", { sources_real: false }), item("O", "observed")]);
  const h = (refs, decision_id) => ({ id: "hyp-x", project_id: "prj-x", statement: "b", status: "revised", revision: 2, created_at: 1, revisions: [{ revision: 1, statement: "a", status: "open", at: 1, by: "u" }, { revision: 2, statement: "b", status: "revised", at: 2, by: "u", evidence_refs: refs, ...(decision_id ? { decision_id } : {}) }] });
  const dec = (id, actor) => ({ id, project_id: "prj-x", statement: id, actor, evidence_refs: [], assumption_refs: [], resulting_version_id: null, affected_deck_slides: [], decided_at: 1 });
  const decisions = [dec("dec-s", "student"), dec("dec-ai", "ai")];
  const one = (refs, d) => memory.beliefChanges([h(refs, d)], decisions, items)[0];
  for (const refs of [["A"], ["X"], ["N"], ["A", "X", "N"]]) assert.deepEqual([one(refs, "dec-s").reason, one(refs, "dec-s").evidence], ["reason_not_recorded", []], refs.join(","));
  assert.deepEqual([one(["O"], "dec-ai").reason, one(["O"], "dec-ai").decision], ["reason_not_recorded", null], "an AI suggestion is never the decision behind a belief change");
  const ok = one(["A", "O"], "dec-s");
  assert.deepEqual([ok.reason, ok.evidence.map((e) => e.ref)], ["recorded", ["O"]], "control: the team's decision and one item it may rest on");
});

// ── CR-T77: the fact/assumption register ────────────────────────────────────────────

await test("CR-T77: two observed, one interpreted and two assumed items are listed by confidence; a student-accepted promotion citing two real sessions moves one assumption to observed and keeps its earlier revision", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    // A slide that cites an item on its own; an AI suggestion with slides and a version (never
    // counted as the team's, SX-45); a draft item the student rejected (not evidence).
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/slides/5`, { method: "PUT", token: s.token, body: { title: "가정", body: "아직 확인 안 됨", evidence_refs: [ev(s, s.draft, "a2")] } })).status, 201);
    const aiSugg = await f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "ai", statement: "AI 제안: 사진을 키운다", evidence_refs: [ev(s, s.draft, "o2")], affected_deck_slides: [6], resulting_version_id: s.version } });
    assert.equal(aiSugg.status, 201, aiSugg.text);
    const rejDraft = await draft(f, s, [{ id: "r1", section: "observation", text: "버린 관찰", source_refs: [`session:${s.sessions[0]}`] }]);
    assert.equal((await review(f, s, rejDraft, [{ item: "r1", action: "reject" }])).status, 201);
    let m = await mem(f, s);
    assert.deepEqual([m.register.observed.length, m.register.interpreted.length, m.register.assumed.length], [2, 1, 2]);
    assert.ok(!m.evidence_items.some((x) => x.id === ev(s, rejDraft, "r1")), "a rejected item is not listed as evidence");
    const a1 = m.register.assumed.find((x) => x.item_id === "a1");
    assert.deepEqual([a1.assumption_status, a1.cited_by.map((c) => c.decision_id), a1.slides], ["open", [s.decision.id], [2, 3]], "an assumption with the decision and slides that cite it");
    assert.deepEqual(m.register.assumed.find((x) => x.item_id === "a2").slides, [5], "a slide that cites the item itself is listed");
    const o1 = m.register.observed.find((x) => x.item_id === "o1");
    assert.deepEqual(o1.slides, [2, 3]);
    const o2 = m.register.observed.find((x) => x.item_id === "o2");
    assert.deepEqual([o2.slides, o2.cited_by.map((c) => c.shown_as)], [[], ["ai_suggestion"]], "an AI suggestion's slides are not the item's");
    assert.deepEqual(m.chains[0].versions, [s.v1], "an AI suggestion's version is not in the chain");
    assert.ok(m.chains[0].decisions.some((d) => d.id === aiSugg.json.decision.id && d.shown_as === "ai_suggestion"), "control: the suggestion is in the chain, as a suggestion");
    const latest = (await f.api(`/v1/curriculum/experiments/${s.experiment.id}/evidence`, { token: s.token })).json.evidence.drafts.filter((x) => x.id === s.draft.id).at(-1);
    const r = await review(f, s, latest, [{ item: "a2", action: "promote", source_refs: s.sessions.map((x) => `session:${x}`) }]);
    assert.equal(r.status, 201, r.text);
    m = await mem(f, s);
    const a2 = m.register.observed.find((x) => x.item_id === "a2");
    assert.deepEqual([a2.confidence, a2.assumption_status, a2.promoted_at_revision, a2.statement], ["observed", "observed_later", r.json.draft.revision, "어르신도 같은 문제를 겪는다"]);
    assert.deepEqual(a2.revisions.map((x) => x.confidence), ["assumed", "assumed", "observed"], "the earlier revisions stay readable");
    assert.equal(a2.revisions[0].statement, a2.statement, "the statement is not overwritten");
    assert.deepEqual([m.register.observed.length, m.register.assumed.length], [3, 1]);
  } finally {
    f.close();
  }
});

await test("CR-T77 negatives: assumption_refs dangling or pointing at an observed item are refused; a promotion with no source, or resting only on an AI or skill statement, is refused; an overwrite of a stored revision fails", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    const post = (body) => f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "user", statement: "결정", ...body } });
    const dangling = await post({ assumption_refs: [ev(s, s.draft, "a9")] });
    assert.deepEqual([dangling.status, dangling.json.error.problems], [409, [`unresolved_assumption_ref:${ev(s, s.draft, "a9")}`]]);
    const observed = await post({ assumption_refs: [ev(s, s.draft, "o1")] });
    assert.deepEqual(observed.json.error.problems, [`assumption_ref_not_assumed:${ev(s, s.draft, "o1")}`]);
    const interpreted = await post({ assumption_refs: [ev(s, s.draft, "i1")] });
    assert.deepEqual([interpreted.status, interpreted.json.error.problems], [409, [`assumption_ref_not_assumed:${ev(s, s.draft, "i1")}`]], "an interpreted item is not an assumption either");
    assert.equal((await post({ assumption_refs: [ev(s, s.draft, "a2")] })).status, 201, "control: an assumed item is accepted");
    const latest = () => f.api(`/v1/curriculum/experiments/${s.experiment.id}/evidence`, { token: s.token }).then((x) => x.json.evidence.drafts.at(-1));
    const noteOf = async (source_state) => (await f.api(`/v1/curriculum/experiments/${s.experiment.id}/notes`, { method: "POST", token: s.token, body: { ...OBSERVER, text: "연습으로 가정해 본 것", source_state } })).json.note.id;
    const simulated = await noteOf("simulated");
    const selfReported = await noteOf("self_reported");
    const d = await latest();
    const tries = [
      [[{ item: "a1", action: "promote" }], 400, "promotion_without_sources"],
      [[{ item: "a1", action: "promote", source_refs: [] }], 400, "promotion_without_sources"],
      [[{ item: "a1", action: "promote", source_refs: [ev(s, s.draft, "o1")] }], 400, "invalid_source_ref"],
      [[{ item: "a1", action: "promote", source_refs: ["ai:coach-said-so"] }], 400, "invalid_source_ref"],
      [[{ item: "a1", action: "promote", source_refs: ["skill:evidence-skill"] }], 400, "invalid_source_ref"],
      [[{ item: "a1", action: "promote", source_refs: ["session:ps-" + "0".repeat(32)] }], 422, "unresolved_source_refs"],
      [[{ item: "a1", action: "promote", source_refs: [`session:${s.sessions[0]}`], text: "다른 문장" }], 400, "promotion_changes_statement"],
      [[{ item: "o1", action: "promote", source_refs: [`session:${s.sessions[0]}`] }], 400, "promotion_not_assumption"],
      // An edit of the same assumption earlier in the batch, then its promotion: refused.
      [[{ item: "a1", action: "edit", text: "완전히 다른 주장으로 바꿈" }, { item: "a1", action: "promote", source_refs: [`session:${s.sessions[0]}`] }], 400, "duplicate_item_action"],
      // A note the student marked simulated (or self-reported) confirms nothing, alone or with a real one.
      [[{ item: "a1", action: "promote", source_refs: [`note:${simulated}`] }], 422, "promotion_source_not_real"],
      [[{ item: "a1", action: "promote", source_refs: [`note:${s.notes[0]}`, `note:${selfReported}`] }], 422, "promotion_source_not_real"],
      // Fail closed: a note whose state is not known (here: no such note) is not known to be real.
      [[{ item: "a1", action: "promote", source_refs: ["note:nte-unknown-0000"] }], 422, "promotion_source_not_real"],
    ];
    for (const [actions, status, code] of tries) {
      const r = await review(f, s, d, actions);
      assert.deepEqual([r.status, r.json.error.code], [status, code], JSON.stringify(actions));
    }
    assert.deepEqual((await latest()).revision, d.revision, "no refused promotion wrote a revision");
    // Control: a promotion on a real note is accepted.
    assert.equal((await review(f, s, d, [{ item: "a1", action: "promote", source_refs: [`note:${s.notes[0]}`] }])).status, 201, "control: a real note confirms");
    // Pure: the statement check holds against the previous revision even without the duplicate rule.
    const prev = { format: "hps-evidence-draft/1", id: "drf-y", experiment: "exp-y", author: "user", created_at: 1, supersedes: null, revision: 1, items: [{ id: "a", section: "assumption", text: "원래 가정", source_refs: [], review: "accepted", reviewed_by: "user" }] };
    assert.throws(() => reviseEvidenceDraft(prev, [{ item: "a", action: "edit", text: "바꾼 주장" }, { item: "a", action: "promote", source_refs: ["session:ps-1"] }], { at: 2, reason: "학생" }), /duplicate_item_action/);
    // A stored revision is never rewritten: the same revision with different content is refused.
    const record = participantRecord(f.r2, s.project.cohort_id, s.project.id);
    const rewritten = { ...d, items: d.items.map(({ sources: _s, comparison: _c, ...i }) => (i.id === "a1" ? { ...i, text: "덮어쓴 가정" } : i)) };
    await assert.rejects(record.saveEvidenceDraft(s.experiment.id, rewritten, { quota: "none" }), /revision_exists/);
    // Pure: a revision the student did not write cannot move a confidence on its own.
    const base = { format: "hps-evidence-draft/1", id: "drf-x", experiment: "exp-x", author: "user", created_at: 1, supersedes: null, revision: 1, items: [{ id: "a", section: "assumption", text: "가정", source_refs: [], review: "accepted", reviewed_by: "user" }] };
    const aiRev = { ...base, revision: 2, author: "ai", created_at: 2, supersedes: { id: "drf-x", revision: 1 }, items: [{ id: "a", section: "observation", text: "가정", source_refs: ["session:ps-1"], review: "draft" }] };
    assert.equal(memory.evidenceItemsOf("exp-x", [base, aiRev])[0].confidence, "assumed", "an AI or skill revision does not promote");
    const studentRev = reviseEvidenceDraft(base, [{ item: "a", action: "promote", source_refs: ["session:ps-1"] }], { at: 3, reason: "학생" });
    assert.deepEqual([memory.evidenceItemsOf("exp-x", [base, studentRev])[0].confidence, memory.evidenceItemsOf("exp-x", [base, studentRev])[0].assumption_status], ["observed", "observed_later"], "control: the student's own promotion does");
  } finally {
    f.close();
  }
});

await test("CR-40 created_by: an AI item stays the system's after the student accepts it (a review, recorded as review state, not authorship); a student's own item is the student's", () => {
  const ai = { format: "hps-evidence-draft/1", id: "drf-z", experiment: "exp-z", author: "ai", created_at: 1, supersedes: null, revision: 1, items: [{ id: "x1", section: "interpretation", text: "AI 해석", source_refs: [], review: "draft" }, { id: "x2", section: "assumption", text: "AI 가정", source_refs: [], review: "draft" }] };
  const before = memory.evidenceItemsOf("exp-z", [ai]).map((i) => [i.item_id, i.created_by, i.review, i.pending_review]);
  assert.deepEqual(before, [["x1", "system", "draft", true], ["x2", "system", "draft", true]]);
  const reviewed = reviseEvidenceDraft(ai, [{ item: "x2", action: "accept" }], { at: 2, reason: "학생" });
  const after = memory.evidenceItemsOf("exp-z", [ai, reviewed]).map((i) => [i.item_id, i.created_by, i.review, i.pending_review]);
  assert.deepEqual(after, [["x1", "system", "draft", true], ["x2", "system", "accepted", false]], "accepted: reviewed, still written by the system; x1 untouched");
  const own = { ...ai, id: "drf-u", author: "user" };
  assert.deepEqual(memory.evidenceItemsOf("exp-z", [own]).map((i) => [i.created_by, i.pending_review]), [["student", false], ["student", false]], "control: the student's own draft is theirs");
});

await test("SX-46 sources_real: an observation resting on a simulated, self-reported or unknown note is listed but supports no observed role and no team decision, on the same rule as promotion", async () => {
  // Pure: the note's state decides; a note the map does not know is not real (fail closed).
  const d = { format: "hps-evidence-draft/1", id: "drf-n", experiment: "exp-n", author: "user", created_at: 1, supersedes: null, revision: 1, items: [{ id: "o", section: "observation", text: "관찰", source_refs: ["note:n1"], review: "draft" }] };
  const real = (states) => memory.evidenceItemsOf("exp-n", [d], states)[0].sources_real;
  assert.deepEqual([real(new Map([["n1", "real"]])), real(new Map([["n1", "simulated"]])), real(new Map()), real(undefined)], [true, false, false, true]);
  const f = await fixture();
  try {
    const s = await week12(f);
    const noteOf = async (source_state) => (await f.api(`/v1/curriculum/experiments/${s.experiment.id}/notes`, { method: "POST", token: s.token, body: { ...OBSERVER, text: "연습으로 적어 본 관찰", source_state } })).json.note.id;
    const sim = await noteOf("simulated");
    const own = await draft(f, s, [{ id: "p1", section: "observation", text: "손님이 혼자 주문했다", source_refs: [`note:${sim}`] }, { id: "p2", section: "observation", text: "실제 관찰", source_refs: [`note:${s.notes[0]}`] }]);
    const listed = (await mem(f, s)).register.observed.find((x) => x.id === ev(s, own, "p1"));
    assert.deepEqual([listed.sources_real, listed.pending_review], [false, false], "listed, marked not real");
    const role = (ref) => f.api(`/v1/curriculum/projects/${s.project.id}/stakeholders`, { method: "POST", token: s.token, body: { label: "손님", roles: [{ role: "user", evidence_refs: [ref], basis: "observed" }] } });
    assert.equal((await role(ev(s, own, "p1"))).json.error.code, "observed_role_without_observed_evidence");
    const dec = (ref) => f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "user", statement: "결정", evidence_refs: [ref] } });
    const refused = await dec(ev(s, own, "p1"));
    assert.deepEqual([refused.status, refused.json.error.problems], [409, [`evidence_ref_not_real:${ev(s, own, "p1")}`]]);
    assert.equal((await role(ev(s, own, "p2"))).status, 201, "control: a real note supports an observed role");
    assert.equal((await dec(ev(s, own, "p2"))).status, 201, "control: and a team decision");
  } finally {
    f.close();
  }
});

await test("CR-35 store race: a director's member change never erases a problem revision written after the route read the Project; a planted whole-doc write does", async () => {
  const run = async (setMembers) => {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    const b = sqliteBinding(db);
    const p = { schema: "hps-venture/1", kind: "project", id: "prj-00000000000000aa", cohort_id: "c", profile_id: "p", title: "t", members: ["cr-a"], created_at: 1 };
    db.prepare("INSERT INTO cr_projects (id, cohort_id, profile_id, creator, doc, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, 1)").run(p.id, p.cohort_id, p.profile_id, "cr-a", JSON.stringify(p));
    const before = await store.getProject(b, p.id);
    assert.ok(await store.reviseProblem(b, before, { statement: "옵션에서 막힌다", by: "cr-a", now: 2 }));
    await setMembers(b, before, ["cr-a", "cr-b"], 3);
    const after = await store.getProject(b, p.id);
    db.close();
    return after;
  };
  const real = await run(store.setMembers);
  assert.deepEqual([real.members, real.problem?.revisions.map((r) => r.statement)], [["cr-a", "cr-b"], ["옵션에서 막힌다"]]);
  const planted = await run(async (db, project, members, now) => {
    await db.prepare("UPDATE cr_projects SET doc = ?, revision = revision + 1, updated_at = ? WHERE id = ?").bind(JSON.stringify({ ...project, members }), now, project.id).run();
  });
  assert.equal(planted.problem ?? null, null, "instrument: the planted whole-doc write erases the problem, and is caught");
});

// ── Ownership and references on the memory write routes (another team's Project) ──

await test("CR memory writes: a non-member cannot link a decision's version or name an experiment's stakeholder; another Project's decision, experiment or stakeholder and a dangling ev: ref are refused on every route that takes one", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    const tB = await f.student("cr-b");
    const b = await started(f, { token: tB });
    const bDec = await f.api(`/v1/curriculum/projects/${b.project.id}/decisions`, { method: "POST", token: tB, body: { author: "user", statement: "B팀 결정" } });
    assert.equal(bDec.status, 201, bDec.text);
    const stakeholderOf = async (project, token) => {
      const r = await f.api(`/v1/curriculum/projects/${project.id}/stakeholders`, { method: "POST", token, body: { label: "손님", roles: [{ role: "user", evidence_refs: [] }] } });
      assert.equal(r.status, 201, r.text);
      return r.json.stakeholder.id;
    };
    const bSt = await stakeholderOf(b.project, tB);
    const aSt = await stakeholderOf(s.project, s.token);
    const aBare = await f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "user", statement: "버전 연결 전" } });
    assert.equal(aBare.status, 201, aBare.text);
    const A = `/v1/curriculum/projects/${s.project.id}`;
    const call = (path, method, body, token = s.token) => f.api(path, { method, token, body });
    // (1) and (2): a student of another team, with this team's own ids.
    const link = (token) => call(`/v1/curriculum/decisions/${aBare.json.decision.id}/version`, "POST", { version_id: s.v1 }, token);
    assert.deepEqual([(await link(tB)).status], [404], "non-member: decision version link");
    const name = (token) => call(`/v1/curriculum/experiments/${s.experiment.id}/stakeholder`, "POST", { stakeholder_id: aSt }, token);
    assert.deepEqual([(await name(tB)).status], [404], "non-member: experiment stakeholder");
    // (3)–(8): another Project's records and dangling refs.
    const code = async (r) => [(await r).status, (await r).json?.error?.code];
    assert.deepEqual(await code(call(`${A}/slides/4`, "PUT", { title: "t", body: "b", evidence_refs: [], decision_id: bDec.json.decision.id })), [409, "decision_unresolved"], "slide: another Project's decision");
    const revise = (body) => call(`${A}/hypotheses/${s.hypothesis.id}/revisions`, "POST", { revision: 2, status: "supported", ...body });
    assert.deepEqual(await code(revise({ decision_id: bDec.json.decision.id })), [409, "decision_unresolved"], "revision: another Project's decision");
    assert.deepEqual(await code(revise({ evidence_refs: [ev(s, s.draft, "zz")] })), [409, "unresolved_evidence_ref"], "revision: dangling ev: ref");
    const metric = (body) => call(`${A}/metrics`, "POST", { name: "확인한 관찰", metric_kind: "usage", definition: "관찰 수", unit: "개", source: { type: "evidence_items", refs: [ev(s, s.draft, "o1")] }, ...body });
    assert.deepEqual(await code(metric({ source: { type: "evidence_items", refs: [ev(s, s.draft, "zz")] } })), [409, "unresolved_evidence_ref"], "metric: dangling ev: ref");
    assert.deepEqual(await code(metric({ stakeholder_id: bSt })), [409, "stakeholder_unresolved"], "metric: another Project's stakeholder");
    const foreignExp = await call(`${A}/decisions`, "POST", { author: "user", statement: "결정", experiment_id: b.experiment.id });
    assert.deepEqual([foreignExp.status, foreignExp.json.error.problems], [409, ["unresolved_experiment"]], "decision: another Project's experiment");
    // Controls: the same calls with this team's own ids, by a member, are accepted.
    assert.equal((await link(s.token)).status, 200, "control: member links the version");
    assert.equal((await name(s.token)).status, 200, "control: member names the stakeholder");
    assert.equal((await call(`${A}/slides/4`, "PUT", { title: "t", body: "b", evidence_refs: [], decision_id: s.decision.id })).status, 201, "control: slide");
    assert.equal((await metric({ stakeholder_id: aSt })).status, 201, "control: metric");
    assert.equal((await call(`${A}/decisions`, "POST", { author: "user", statement: "결정", experiment_id: s.experiment.id })).status, 201, "control: decision");
    assert.equal((await revise({ decision_id: s.decision.id, evidence_refs: [ev(s, s.draft, "o1")] })).status, 201, "control: revision");
  } finally {
    f.close();
  }
});

await test("CR-35 writes: a problem revision keeps the earlier statement; a slide citing a dangling ref or naming an AI suggestion is refused", async () => {
  const f = await fixture();
  try {
    const s = await week12(f);
    const put = (statement) => f.api(`/v1/curriculum/projects/${s.project.id}/problem`, { method: "PUT", token: s.token, body: { statement } });
    assert.equal((await put("처음 쓰는 사람이 키오스크 주문을 어려워한다")).status, 200);
    const second = await put("옵션 고르는 단계에서 막힌다");
    assert.equal(second.status, 200, second.text);
    assert.deepEqual(second.json.project.problem.revisions.map((r) => r.statement), ["처음 쓰는 사람이 키오스크 주문을 어려워한다", "옵션 고르는 단계에서 막힌다"]);
    assert.equal((await mem(f, s)).problem, "옵션 고르는 단계에서 막힌다");
    const slide = (body) => f.api(`/v1/curriculum/projects/${s.project.id}/slides/4`, { method: "PUT", token: s.token, body: { title: "근거", body: "b", evidence_refs: [], ...body } });
    const dangling = await slide({ evidence_refs: [ev(s, s.draft, "zz")] });
    assert.deepEqual([dangling.status, dangling.json.error.code], [409, "unresolved_evidence_ref"]);
    const ai = await f.api(`/v1/curriculum/projects/${s.project.id}/decisions`, { method: "POST", token: s.token, body: { author: "ai", statement: "AI 제안" } });
    const byAi = await slide({ decision_id: ai.json.decision.id });
    assert.deepEqual([byAi.status, byAi.json.error.code], [409, "decision_is_ai_suggestion"]);
    assert.equal((await slide({ decision_id: s.decision.id, evidence_refs: [ev(s, s.draft, "o1")] })).status, 201, "control: the team's decision and a resolving ref are accepted");
    // The deck has eight slides (CR-35 DeckSlides (8)): 0 and 9 are not slides; 8 is (control).
    for (const n of [0, 9]) assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/slides/${n}`, { method: "PUT", token: s.token, body: { title: "t", body: "b", evidence_refs: [] } })).status, 400, `slide ${n}`);
    assert.equal((await f.api(`/v1/curriculum/projects/${s.project.id}/slides/8`, { method: "PUT", token: s.token, body: { title: "t", body: "b", evidence_refs: [] } })).status, 201, "control: slide 8");
  } finally {
    f.close();
  }
});

if (mf) await mf.dispose();
if (failed) {
  console.error(`\n${failed} cr-memory check(s) failed`);
  process.exit(1);
}
console.log(`\ncr-memory (worker ${D1_MODE ? "local workerd D1" : "SQLite"}): OK`);
