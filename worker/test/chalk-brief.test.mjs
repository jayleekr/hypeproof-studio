// #1306 — GET /brief: audience_tier, duration_min, methods_warning coverage.
// Tests: B-01 audience_tier stored → brief response; B-02 duration_min=90 → time_spec;
//        B-03 no duration_min + format=workshop → default 240.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, COHORT } from "./harness/index.mjs";

const { issueIssuer } = await import("../src/lib/tokens.ts");
const { listProfiles } = await import("../src/profiles/index.ts");

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
const AUTHORING_SCHEMA = readFileSync(new URL("../migrations/0002-chalk-authoring.sql", import.meta.url), "utf8");
const PLAN_SCHEMA = readFileSync(new URL("../migrations/0031-chalk-plan-files.sql", import.meta.url), "utf8");
const TIER_DURATION_SCHEMA = readFileSync(new URL("../migrations/0035-chalk-course-inputs-tier-duration.sql", import.meta.url), "utf8");

const GOAL_VOCAB = ["inquiry-skills", "observation", "creative-thinking"];
const COND_VOCAB = ["single-session", "novice-learners"];
const PRIOR_VOCAB = ["novice", "intermediate", "any"];

// Two methods: m-guided-discovery matches goals above (no_goal_match=false),
// m-no-match is intentionally goal-unmatched to trigger methods_warning tests.
const BASE_METHODS = [
  { id: "m-guided-discovery", best_for: ["inquiry-skills", "observation"], weak_for: [], avoid_when: [], prior_knowledge: "any", requires_guidance: false },
  { id: "m-cooperative-learning", best_for: ["cooperative-skills"], weak_for: [], avoid_when: [], prior_knowledge: "any", requires_guidance: false },
];

const profileId = listProfiles().find(p => p.session.cohort_id === COHORT)?.id;
assert.ok(profileId, "profile not found for COHORT");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(KB_SCHEMA);
  db.exec(AUTHORING_SCHEMA);
  db.exec(PLAN_SCHEMA);
  db.exec(TIER_DURATION_SCHEMA);
  db.prepare(`INSERT INTO chalk_knowledge_versions VALUES(1,NULL,'vault-import',NULL,NULL,'test','tester',0,${BASE_METHODS.length + 3},'digest0')`).run();
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(1, "vocab:goal", "vocab", JSON.stringify({ keys: GOAL_VOCAB.map(k => ({ key: k, label: k })) }), "", null);
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(1, "vocab:condition", "vocab", JSON.stringify({ keys: COND_VOCAB.map(k => ({ key: k, label: k })) }), "", null);
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(1, "vocab:prior", "vocab", JSON.stringify({ keys: PRIOR_VOCAB.map(k => ({ key: k, label: k })) }), "", null);
  for (const m of BASE_METHODS) {
    db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(1, `method:${m.id}`, "method", JSON.stringify(m), "", null);
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

const issuerTok = async () =>
  (await issueIssuer({ issuer: "tester", scopes: [{ cohort: COHORT, profiles: [profileId] }] }, 4, TEST_SECRET)).token;

const base = `/admin/chalk/cohorts/${COHORT}/courses/test-course`;

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

function seedDraft(db) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO authoring_drafts (cohort_id,course_id,owner_id,profile_id,revision,content_json,request_id,request_hash,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    COHORT, "test-course", "tester", "", 1,
    '{"schema":"hps-session-design/1","title":"","audience":"","duration_minutes":120,"objective":"","prerequisites":"","starter":"","steps":[]}',
    "req-seed-initial", "hash-seed-initial", now,
  );
}

const VALID_INPUTS = {
  audience: "초등학교 3-4학년",
  assets: ["INTENT", "VERIFY"],
  teaching_style: "탐구 기반",
  requirements: "",
  format: "workshop",
  family_session: false,
  vocab: {
    goals: ["inquiry-skills", "observation"],
    conditions: ["single-session"],
    learner_level: "novice",
    has_guidance: false,
  },
  expected_revision: 1,
  request_id: "req-inputs-brief",
  profile_id: "",
};

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

// ── B-01: audience_tier stored via PUT /inputs → appears in GET /brief response ──
await check("B-01 audience_tier=lv1 stored → brief inputs.audience_tier=lv1", async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const putR = await req("PUT", `${base}/inputs`, {
    ...VALID_INPUTS,
    audience_tier: "lv1",
    request_id: "req-b01-inputs",
  }, tok, db);
  assert.equal(putR.status, 200, JSON.stringify(putR.json));

  const briefR = await req("GET", `${base}/brief`, null, tok, db);
  assert.equal(briefR.status, 200, JSON.stringify(briefR.json));
  assert.equal(briefR.json.inputs.audience_tier, "lv1");

  // skeleton_html must include the meta tag
  assert.ok(
    briefR.json.skeleton_html.includes('name="chalk:audience-tier"'),
    "skeleton_html should contain chalk:audience-tier meta tag",
  );
});

// ── B-02: duration_min=90 stored → time_spec.total_min=90, inputs.duration_min=90 ──
await check("B-02 duration_min=90 stored → brief time_spec.total_min=90", async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const putR = await req("PUT", `${base}/inputs`, {
    ...VALID_INPUTS,
    duration_min: 90,
    request_id: "req-b02-inputs",
  }, tok, db);
  assert.equal(putR.status, 200, JSON.stringify(putR.json));

  const briefR = await req("GET", `${base}/brief`, null, tok, db);
  assert.equal(briefR.status, 200, JSON.stringify(briefR.json));
  assert.equal(briefR.json.inputs.duration_min, 90);
  assert.equal(briefR.json.time_spec.total_min, 90);
});

// ── B-03: no duration_min + format=workshop → default 240 ──
await check("B-03 no duration_min, format=workshop → default total_min=240", async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const putR = await req("PUT", `${base}/inputs`, {
    ...VALID_INPUTS,
    request_id: "req-b03-inputs",
    // no duration_min
  }, tok, db);
  assert.equal(putR.status, 200, JSON.stringify(putR.json));

  const briefR = await req("GET", `${base}/brief`, null, tok, db);
  assert.equal(briefR.status, 200, JSON.stringify(briefR.json));
  assert.equal(briefR.json.time_spec.total_min, 240);
  assert.equal(briefR.json.inputs.duration_min, 240);
});

console.log(`\n${passed} tests passed`);
