// #1465 E2-5 — chalk-judgements integration tests.
// GET  /admin/chalk/cohorts/:cohort/courses/:course/judge-brief
// POST /admin/chalk/cohorts/:cohort/courses/:course/judgements
// POST /admin/chalk/cohorts/:cohort/courses/:course/check (judgements merged)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, COHORT } from "./harness/index.mjs";

const { issueIssuer, issue } = await import("../src/lib/tokens.ts");
const { listProfiles } = await import("../src/profiles/index.ts");
const { isIssuerAllowedEndpoint } = await import("../src/lib/instructor-auth.ts");

const app = await bootApp();

const KB_SCHEMA = `
CREATE TABLE IF NOT EXISTS chalk_knowledge_versions (
  version INTEGER PRIMARY KEY, parent_version INTEGER,
  origin TEXT NOT NULL, source_repo TEXT, source_commit TEXT,
  note TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  doc_count INTEGER NOT NULL, digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chalk_knowledge_docs (
  version INTEGER NOT NULL REFERENCES chalk_knowledge_versions(version),
  doc_id TEXT NOT NULL, kind TEXT NOT NULL, fields_json TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', source_path TEXT,
  PRIMARY KEY (version, doc_id)
);
`;

const AUTHORING_SCHEMA  = readFileSync(new URL("../migrations/0002-chalk-authoring.sql", import.meta.url), "utf8");
const PLAN_SCHEMA       = readFileSync(new URL("../migrations/0031-chalk-plan-files.sql", import.meta.url), "utf8");
const TIER_SCHEMA       = readFileSync(new URL("../migrations/0035-chalk-course-inputs-tier-duration.sql", import.meta.url), "utf8");
const JUDGEMENTS_SCHEMA = readFileSync(new URL("../migrations/0037-chalk-judgements.sql", import.meta.url), "utf8");

const GOAL_VOCAB = ["inquiry-skills", "observation", "prediction", "cooperative-skills", "communication"];
const COND_VOCAB = ["single-session", "novice-learners"];
const PRIOR_VOCAB = ["novice", "any"];

const BASE_METHODS = [
  { id: "m-guided-discovery", best_for: ["inquiry-skills","observation"], weak_for: [], avoid_when: ["no-prep-time"], prior_knowledge: "any", requires_guidance: false },
  { id: "m-cooperative-learning", best_for: ["cooperative-skills","communication"], weak_for: [], avoid_when: [], prior_knowledge: "any", requires_guidance: false },
];

const profileId = listProfiles().find(p => p.session.cohort_id === COHORT)?.id;
assert.ok(profileId, "profile not found for COHORT");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(KB_SCHEMA);
  db.exec(AUTHORING_SCHEMA);
  db.exec(PLAN_SCHEMA);
  db.exec(TIER_SCHEMA);
  db.exec(JUDGEMENTS_SCHEMA);
  db.prepare(`INSERT INTO chalk_knowledge_versions VALUES(1,NULL,'vault-import',NULL,NULL,'test','tester',0,${BASE_METHODS.length + 3},'digest0')`).run();
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
    1, "vocab:goal", "vocab", JSON.stringify({ keys: GOAL_VOCAB.map(k => ({ key: k, label: k })) }), "", null,
  );
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
    1, "vocab:condition", "vocab", JSON.stringify({ keys: COND_VOCAB.map(k => ({ key: k, label: k })) }), "", null,
  );
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
    1, "vocab:prior", "vocab", JSON.stringify({ keys: PRIOR_VOCAB.map(k => ({ key: k, label: k })) }), "", null,
  );
  for (const m of BASE_METHODS) {
    db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
      1, `method:${m.id}`, "method", JSON.stringify(m), "", null,
    );
  }
  return db;
}

function makeEnv(db) {
  const env = createMockEnv({ withSession: false });
  function makeStmt(sql) {
    let bindings = [];
    const stmt = {
      get _sql() { return sql; },
      get _bindings() { return bindings; },
      bind(...args) { bindings = [...args]; return stmt; },
      async first() { return db.prepare(sql).get(...bindings) ?? null; },
      async run() { const r = db.prepare(sql).run(...bindings); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { success: true, results: db.prepare(sql).all(...bindings) }; },
    };
    return stmt;
  }
  env.HPS_DB = {
    prepare(sql) { return makeStmt(sql); },
    async batch(stmts) {
      const results = [];
      for (const stmt of stmts) {
        try {
          const r = db.prepare(stmt._sql).run(...stmt._bindings);
          results.push({ success: true, results: [], meta: { changes: Number(r.changes) } });
        } catch (e) {
          results.push({ success: false, error: String(e) });
        }
      }
      return results;
    },
  };
  return env;
}

const issuerTok = async (issuer = "tester") =>
  (await issueIssuer({ issuer, scopes: [{ cohort: COHORT, profiles: [profileId] }] }, 4, TEST_SECRET)).token;
const studentTok = async () =>
  (await issue({ u: "kid01", c: COHORT, p: profileId }, 1, TEST_SECRET)).token;

const base = `/admin/chalk/cohorts/${COHORT}/courses/test-course`;

const VALID_INPUTS = {
  audience: "초등학교 3-4학년",
  assets: ["INTENT", "VERIFY"],
  teaching_style: "탐구 기반",
  requirements: "실험 도구 필요",
  format: "workshop",
  family_session: false,
  vocab: { goals: ["inquiry-skills","observation"], conditions: ["single-session","novice-learners"] },
  expected_revision: 1,
  request_id: "req-inputs-seed",
};

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="ko" data-chalk-plan="1" data-chalk-kind="lesson">
<head>
  <meta name="chalk:course" content="test-course">
  <meta name="chalk:knowledge-version" content="1">
  <meta name="chalk:format" content="workshop">
  <meta name="chalk:family-session" content="false">
  <meta name="chalk:duration-min" content="240">
  <meta name="chalk:methods" content="m-guided-discovery m-cooperative-learning">
  <meta name="chalk:audience-tier" content="elementary">
</head>
<body><p>test plan</p></body>
</html>`;

async function req(method, path, body, credential, db) {
  const env = makeEnv(db ?? makeDb());
  const headers = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
  const init = body !== null ? { method, headers, body: JSON.stringify(body) } : { method, headers };
  const res = await app.fetch(
    new Request("https://service.test" + path, init),
    env, makeCtx(),
  );
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

function seedDraft(db, { ownerId = "tester", cohort = COHORT, course = "test-course" } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO authoring_drafts (cohort_id,course_id,owner_id,profile_id,revision,content_json,request_id,request_hash,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    cohort, course, ownerId, "", 1,
    '{"schema":"hps-session-design/1","title":"","audience":"","duration_minutes":120,"objective":"","prerequisites":"","starter":"","steps":[]}',
    "req-seed-initial", "hash-seed-initial", now,
  );
}

async function seedPlan(db) {
  const tok = await issuerTok();
  seedDraft(db);
  const ir = await req("PUT", `${base}/inputs`, VALID_INPUTS, tok, db);
  assert.equal(ir.status, 200, `seedPlan PUT /inputs failed: ${JSON.stringify(ir.json)}`);
  const r = await req("PUT", `${base}/plan`, {
    file: "lesson", html: SAMPLE_HTML, knowledge_version: 1,
    expected_revision: 2, request_id: "req-plan-seed",
  }, tok, db);
  assert.equal(r.status, 200, `seedPlan PUT /plan failed: ${JSON.stringify(r.json)}`);
  return { tok, sha256: r.json.sha256, revision: r.json.revision };
}

// Build a valid POST /judgements body. Uses `check` (the API field name).
function validJudgement(sha256, revision, overrides = {}) {
  return {
    check: "G2-2",
    plan_sha256: sha256,
    revision,
    prompt_id: "G2-2",
    prompt_version: 1,
    model: "claude-sonnet-4-6",
    verdict: "pass",
    rationale: "objectives use observable verbs",
    ...overrides,
  };
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

// ── instructor-auth path_links ────────────────────────────────────────────────

await check("PA-01 isIssuerAllowedEndpoint judge-brief GET allowed", () => {
  assert.ok(isIssuerAllowedEndpoint(`/admin/chalk/cohorts/c1/courses/x/judge-brief`, "GET"));
  assert.ok(!isIssuerAllowedEndpoint(`/admin/chalk/cohorts/c1/courses/x/judge-brief`, "POST"));
});

await check("PA-02 isIssuerAllowedEndpoint judgements POST allowed", () => {
  assert.ok(isIssuerAllowedEndpoint(`/admin/chalk/cohorts/c1/courses/x/judgements`, "POST"));
  assert.ok(!isIssuerAllowedEndpoint(`/admin/chalk/cohorts/c1/courses/x/judgements`, "GET"));
});

await check("PA-03 non-exact paths not matched", () => {
  assert.ok(!isIssuerAllowedEndpoint("/admin/chalk/cohorts/c1/courses/x/judge-briefs", "GET"));
  assert.ok(!isIssuerAllowedEndpoint("/admin/chalk/cohorts/c1/courses/x/judgements/abc", "POST"));
  assert.ok(!isIssuerAllowedEndpoint("/admin/chalk/cohorts/c1/courses/x/judge-brief", "DELETE"));
  assert.ok(!isIssuerAllowedEndpoint("/admin/chalk/cohorts/c1/courses/x/judgements", "PUT"));
});

// ── GET /judge-brief ──────────────────────────────────────────────────────────

await check("JB-01 student token → 403", async () => {
  const tok = await studentTok();
  const r = await req("GET", `${base}/judge-brief`, null, tok);
  assert.equal(r.status, 403);
});

await check("JB-02 no plan → 404", async () => {
  const db = makeDb();
  const tok = await issuerTok();
  seedDraft(db);
  const r = await req("GET", `${base}/judge-brief`, null, tok, db);
  assert.equal(r.status, 404);
});

await check("JB-03 no draft → 404", async () => {
  const db = makeDb();
  const tok = await issuerTok();
  const r = await req("GET", `${base}/judge-brief`, null, tok, db);
  assert.equal(r.status, 404);
});

await check("JB-04 returns 5 items with required fields including revision", async () => {
  const db = makeDb();
  await seedPlan(db);
  const tok = await issuerTok();
  const r = await req("GET", `${base}/judge-brief`, null, tok, db);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(Array.isArray(r.json.items), "items must be array");
  assert.equal(r.json.items.length, 5);
  const checks = r.json.items.map(i => i.check).sort();
  assert.deepEqual(checks, ["G1-3","G2-2","G2-3","G3-2","hint_gives_answer"]);
  for (const item of r.json.items) {
    assert.ok(typeof item.prompt_id === "string" && item.prompt_id.length > 0, "prompt_id required");
    assert.ok(typeof item.prompt_version === "number", "prompt_version required");
    assert.ok(typeof item.prompt_text === "string" && item.prompt_text.length > 0, "prompt_text required");
    assert.ok("excerpt" in item, "excerpt required");
  }
  assert.ok(typeof r.json.plan_sha256 === "string" && r.json.plan_sha256.length === 64, "plan_sha256 required");
  assert.ok(typeof r.json.revision === "number", "revision required in judge-brief response");
});

await check("JB-05 human-only check → 400 human_only", async () => {
  const db = makeDb();
  await seedPlan(db);
  const tok = await issuerTok();
  const r = await req("GET", `${base}/judge-brief?items=G2-12`, null, tok, db);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "human_only");
});

await check("JB-06 other issuer → 404", async () => {
  const db = makeDb();
  await seedPlan(db);
  const other = await issuerTok("other-issuer");
  const r = await req("GET", `${base}/judge-brief`, null, other, db);
  assert.equal(r.status, 404);
});

// ── POST /judgements ──────────────────────────────────────────────────────────

await check("JG-01 student token → 403", async () => {
  const tok = await studentTok();
  const r = await req("POST", `${base}/judgements`, {
    check: "G2-2", plan_sha256: "a".repeat(64), revision: 3,
    prompt_id: "G2-2", prompt_version: 1, model: "m",
    verdict: "pass", rationale: "ok",
  }, tok);
  assert.equal(r.status, 403);
});

await check("JG-02 unknown check → 400 invalid_check", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  const r = await req("POST", `${base}/judgements`, {
    check: "UNKNOWN", plan_sha256: sha256, revision,
    prompt_id: "G2-2", prompt_version: 1, model: "m",
    verdict: "pass", rationale: "ok",
  }, tok, db);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "invalid_check");
});

await check("JG-03 invalid verdict → 400 invalid_verdict", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  for (const badVerdict of ["fail", "warn", "PASS", "maybe"]) {
    const r = await req("POST", `${base}/judgements`, {
      check: "G2-2", plan_sha256: sha256, revision,
      prompt_id: "G2-2", prompt_version: 1, model: "m",
      verdict: badVerdict, rationale: "ok",
    }, tok, db);
    assert.equal(r.status, 400, `verdict="${badVerdict}" should be rejected`);
    assert.equal(r.json.code, "invalid_verdict");
  }
});

await check("JG-04 rationale > 2048 bytes → 400 rationale_too_long", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  const r = await req("POST", `${base}/judgements`, {
    check: "G2-2", plan_sha256: sha256, revision,
    prompt_id: "G2-2", prompt_version: 1, model: "m",
    verdict: "pass", rationale: "x".repeat(2049),
  }, tok, db);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "rationale_too_long");
});

await check("JG-05 unknown plan_sha256 → 400 unknown_plan", async () => {
  const db = makeDb();
  const { tok, revision } = await seedPlan(db);
  const r = await req("POST", `${base}/judgements`, {
    check: "G2-2", plan_sha256: "b".repeat(64), revision,
    prompt_id: "G2-2", prompt_version: 1, model: "m",
    verdict: "pass", rationale: "ok",
  }, tok, db);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "unknown_plan");
});

await check("JG-06 wrong revision → 400 unknown_plan", async () => {
  const db = makeDb();
  const { tok, sha256 } = await seedPlan(db);
  const r = await req("POST", `${base}/judgements`, {
    check: "G2-2", plan_sha256: sha256, revision: 999,
    prompt_id: "G2-2", prompt_version: 1, model: "m",
    verdict: "pass", rationale: "ok",
  }, tok, db);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "unknown_plan");
});

await check("JG-07 other issuer → 404", async () => {
  const db = makeDb();
  const { sha256, revision } = await seedPlan(db);
  const other = await issuerTok("other-issuer");
  const r = await req("POST", `${base}/judgements`, {
    check: "G2-2", plan_sha256: sha256, revision,
    prompt_id: "G2-2", prompt_version: 1, model: "m",
    verdict: "pass", rationale: "ok",
  }, other, db);
  assert.equal(r.status, 404);
});

await check("JG-08 valid POST → 201 with judgement_id", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  const r = await req("POST", `${base}/judgements`, validJudgement(sha256, revision), tok, db);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(typeof r.json.judgement_id === "string" && r.json.judgement_id.startsWith("j_"), "judgement_id must start with j_");
});

await check("JG-09 actor comes from auth payload, not body", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  const r = await req("POST", `${base}/judgements`,
    { ...validJudgement(sha256, revision), actor: "injected-actor" }, tok, db);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const row = db.prepare("SELECT actor FROM chalk_judgements WHERE judgement_id=?").get(r.json.judgement_id);
  assert.equal(row.actor, "tester", "actor must come from auth, not body");
});

await check("JG-10 all 5 valid check names accepted", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  const checks = [
    { check: "G2-2", prompt_id: "G2-2" },
    { check: "G2-3", prompt_id: "G2-3" },
    { check: "G3-2", prompt_id: "G3-2" },
    { check: "G1-3", prompt_id: "G1-3" },
    { check: "hint_gives_answer", prompt_id: "hint_gives_answer" },
  ];
  for (const c of checks) {
    const r = await req("POST", `${base}/judgements`,
      validJudgement(sha256, revision, { check: c.check, prompt_id: c.prompt_id, rationale: `ok for ${c.check}` }), tok, db);
    assert.equal(r.status, 201, `check=${c.check} failed: ${JSON.stringify(r.json)}`);
  }
});

await check("JG-11 rationale exactly 2048 bytes accepted", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  const r = await req("POST", `${base}/judgements`,
    validJudgement(sha256, revision, { verdict: "violation", rationale: "x".repeat(2048) }), tok, db);
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

await check("JG-12 unknown prompt_version → 400 unknown_prompt", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  const r = await req("POST", `${base}/judgements`,
    validJudgement(sha256, revision, { prompt_version: 99 }), tok, db);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "unknown_prompt");
});

await check("JG-13 prompt_id mismatch → 400 prompt_mismatch", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  // check G3-2 but prompt_id belongs to G2-2 — should be rejected
  const r = await req("POST", `${base}/judgements`,
    validJudgement(sha256, revision, { check: "G3-2", prompt_id: "G2-2" }), tok, db);
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json.code, "prompt_mismatch");
});

await check("JG-14 check field accepted (API name), stored as check_name column", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  const r = await req("POST", `${base}/judgements`,
    validJudgement(sha256, revision, { rationale: "check field test" }), tok, db);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const row = db.prepare("SELECT check_name FROM chalk_judgements WHERE judgement_id=?").get(r.json.judgement_id);
  assert.equal(row.check_name, "G2-2");
});

// ── POST /check — judgements merged ──────────────────────────────────────────

await check("CK-01 check without stored judgements returns human-only items", async () => {
  const db = makeDb();
  const { tok } = await seedPlan(db);
  const r = await req("POST", `${base}/check`, {}, tok, db);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(Array.isArray(r.json.results));
  const humanItems = r.json.results.filter(i => i.judge === "human");
  const humanChecks = humanItems.map(i => i.check).sort();
  assert.deepEqual(humanChecks, ["G2-12","G3-6"]);
});

await check("CK-02 stored judgement (unsure) appears as judge=model, severity=info, blocks_confirm=false", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  await req("POST", `${base}/judgements`,
    validJudgement(sha256, revision, { verdict: "unsure", rationale: "needs work" }), tok, db);
  const r = await req("POST", `${base}/check`, {}, tok, db);
  assert.equal(r.status, 200);
  const modelItem = r.json.results.find(i => i.check === "G2-2" && i.judge === "model");
  assert.ok(modelItem, "G2-2 model judgement should appear in check results");
  assert.equal(modelItem.severity, "info");
  assert.equal(modelItem.message, "needs work");
  assert.equal(modelItem.blocks_confirm, false);
});

await check("CK-03 violation verdict → severity=warn, blocks_confirm=false (never blocks)", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  await req("POST", `${base}/judgements`,
    validJudgement(sha256, revision, { check: "G2-3", prompt_id: "G2-3", verdict: "violation", rationale: "wrong" }), tok, db);
  const r = await req("POST", `${base}/check`, {}, tok, db);
  assert.equal(r.status, 200);
  const item = r.json.results.find(i => i.check === "G2-3" && i.judge === "model");
  assert.ok(item, "G2-3 should appear");
  assert.equal(item.severity, "warn");
  assert.equal(item.blocks_confirm, false);
});

await check("CK-04 only latest judgement per (check, location) key", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  // Same check, same location (at_section null) — second replaces first
  await req("POST", `${base}/judgements`,
    validJudgement(sha256, revision, { check: "G3-2", prompt_id: "G3-2", verdict: "violation", rationale: "first" }), tok, db);
  await req("POST", `${base}/judgements`,
    validJudgement(sha256, revision, { check: "G3-2", prompt_id: "G3-2", verdict: "pass", rationale: "second" }), tok, db);
  const r = await req("POST", `${base}/check`, {}, tok, db);
  const items = r.json.results.filter(i => i.check === "G3-2" && i.judge === "model");
  assert.equal(items.length, 1, "only one judgement when check+location same");
  assert.equal(items[0].message, "second");
});

await check("CK-05 different locations produce separate entries in check results", async () => {
  const db = makeDb();
  const { tok, sha256, revision } = await seedPlan(db);
  // Same check_name, different at_section → both should appear
  await req("POST", `${base}/judgements`,
    validJudgement(sha256, revision, { check: "G1-3", prompt_id: "G1-3", rationale: "step1 ok", at_section: "s1" }), tok, db);
  await req("POST", `${base}/judgements`,
    validJudgement(sha256, revision, { check: "G1-3", prompt_id: "G1-3", rationale: "step2 ok", at_section: "s2" }), tok, db);
  const r = await req("POST", `${base}/check`, {}, tok, db);
  assert.equal(r.status, 200);
  const items = r.json.results.filter(i => i.check === "G1-3" && i.judge === "model");
  assert.equal(items.length, 2, "different locations must both appear");
  const rationales = items.map(i => i.message).sort();
  assert.deepEqual(rationales, ["step1 ok", "step2 ok"]);
});

console.log(`\nAll ${passed} tests passed.`);
