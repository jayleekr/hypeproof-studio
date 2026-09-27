// #1293 — chalk-recommend unit + integration tests.
// Unit: recommendMethods() pure function, no DB.
// Integration: POST /admin/chalk/cohorts/:cohort/courses/:course/recommend
//   — real Service routing, in-memory SQLite, signed issuer tokens.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, COHORT } from "./harness/index.mjs";

const { recommendMethods, VocabError, KnowledgeIncompatibleError } = await import("../src/lib/chalk-recommend.ts");
const { issueIssuer, issue } = await import("../src/lib/tokens.ts");
const { listProfiles } = await import("../src/profiles/index.ts");

const app = await bootApp();

// ── Shared knowledge fixtures ─────────────────────────────────────────────────
const COND_VOCAB = ["single-session", "short-session", "novice-learners",
  "no-prep-time", "large-group", "requires-materials", "low-autonomy",
  "high-tech-required", "family-mixed-age"];
const GOAL_VOCAB = [
  "creative-thinking", "cooperative-skills", "critical-thinking",
  "problem-solving", "communication", "inquiry-skills", "observation",
  "prediction", "experiment-design", "data-analysis",
  "conceptual-understanding", "metacognition", "self-regulation",
  "motivation", "confidence", "persistence", "autonomy",
  "empathy", "leadership", "presentation-skills",
  "digital-literacy", "hands-on-making", "design-thinking",
  "evidence-based-reasoning", "questioning", "pattern-recognition",
  "systems-thinking", "reflection", "transfer",
];
const PRIOR_VOCAB = ["novice", "intermediate", "any"];
// Four methods: three biopharm-compatible, one excluded by condition
const BASE_METHODS = [
  {
    id: "m-guided-discovery",
    best_for: ["inquiry-skills", "observation", "critical-thinking"],
    weak_for: [],
    avoid_when: ["no-prep-time"],
    prior_knowledge: "any",
    requires_guidance: false,
  },
  {
    id: "m-predict-observe-explain",
    best_for: ["prediction", "observation", "evidence-based-reasoning"],
    weak_for: [],
    avoid_when: ["high-tech-required"],
    prior_knowledge: "any",
    requires_guidance: false,
  },
  {
    id: "m-cooperative-learning",
    best_for: ["cooperative-skills", "communication", "leadership"],
    weak_for: [],
    avoid_when: ["large-group"],
    prior_knowledge: "any",
    requires_guidance: false,
  },
  {
    id: "m-project-based-learning",
    best_for: ["design-thinking", "autonomy", "problem-solving"],
    weak_for: [],
    avoid_when: ["short-session", "novice-learners"],
    prior_knowledge: "any",
    requires_guidance: false,
  },
];

// Additional methods for prior_knowledge and requires_guidance tests
const METHODS_EXTRA = [
  ...BASE_METHODS,
  {
    id: "m-research-project",
    best_for: ["autonomy", "design-thinking", "evidence-based-reasoning"],
    weak_for: [],
    avoid_when: [],
    prior_knowledge: "intermediate",  // needs intermediate+ learner
    requires_guidance: false,
  },
  {
    id: "m-guided-inquiry",
    best_for: ["questioning", "observation", "inquiry-skills"],
    weak_for: [],
    avoid_when: [],
    prior_knowledge: "any",
    requires_guidance: true,  // needs guidance support
  },
  {
    id: "m-weak-overlap",
    best_for: ["design-thinking", "creative-thinking"],
    weak_for: ["cooperative-skills"],  // weak overlap with cooperative goals
    avoid_when: [],
    prior_knowledge: "any",
    requires_guidance: false,
  },
];

const VOCAB = { goals: GOAL_VOCAB, conditions: COND_VOCAB, prior: PRIOR_VOCAB };

// ── Unit tests (pure function, no DB) ─────────────────────────────────────────
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

await check("U-01 biopharm conditions: project-based excluded, three candidates", () => {
  const result = recommendMethods(
    { conditions: ["single-session", "short-session", "novice-learners"], goals: [] },
    BASE_METHODS, VOCAB, 1,
  );
  const chosenIds = result.chosen.map((m) => m.id).sort();
  const excludedIds = result.excluded.map((m) => m.id);
  assert.deepEqual(excludedIds, ["m-project-based-learning"]);
  assert.deepEqual(chosenIds, ["m-cooperative-learning", "m-guided-discovery", "m-predict-observe-explain"].sort());
  assert.equal(result.knowledge_version, 1);
});

await check("U-02 exclusion because lists both avoid_when hits", () => {
  const result = recommendMethods(
    { conditions: ["short-session", "novice-learners"], goals: [] },
    [BASE_METHODS[3]], VOCAB, 1,
  );
  const ex = result.excluded[0];
  assert.equal(ex.id, "m-project-based-learning");
  assert.ok(ex.because.includes("short-session"));
  assert.ok(ex.because.includes("novice-learners"));
});

await check("U-03 unknown condition throws VocabError", () => {
  assert.throws(
    () => recommendMethods({ conditions: ["unknown-condition"], goals: [] }, BASE_METHODS, VOCAB, 1),
    (err) => err instanceof VocabError && err.field === "condition",
  );
});

await check("U-04 unknown goal throws VocabError", () => {
  assert.throws(
    () => recommendMethods({ conditions: [], goals: ["nonexistent-goal"] }, BASE_METHODS, VOCAB, 1),
    (err) => err instanceof VocabError && err.field === "goal",
  );
});

await check("U-05 determinism: same input + same methods → same output", () => {
  const input = { conditions: ["short-session"], goals: ["cooperative-skills"] };
  const r1 = recommendMethods(input, BASE_METHODS, VOCAB, 1);
  const r2 = recommendMethods(input, BASE_METHODS, VOCAB, 1);
  assert.deepEqual(r1, r2);
});

await check("U-06 goal rationale: matched goals shown when input goals provided", () => {
  const result = recommendMethods(
    { conditions: [], goals: ["cooperative-skills"] },
    [BASE_METHODS[2]], VOCAB, 1,
  );
  assert.deepEqual(result.chosen[0].rationale, ["cooperative-skills"]);
  assert.equal(result.chosen[0].no_goal_match, undefined);
});

await check("U-07 empty conditions → all methods are candidates", () => {
  const result = recommendMethods({ conditions: [], goals: [] }, BASE_METHODS, VOCAB, 1);
  assert.equal(result.chosen.length, BASE_METHODS.length);
  assert.equal(result.excluded.length, 0);
});

await check("U-08 prior_knowledge: intermediate method excluded for novice learner", () => {
  const result = recommendMethods(
    { conditions: [], goals: [], learner_level: "novice" },
    [METHODS_EXTRA[4]], // m-research-project: prior_knowledge=intermediate
    VOCAB, 1,
  );
  assert.equal(result.excluded.length, 1);
  assert.ok(result.excluded[0].because.includes("prior_knowledge"));
});

await check("U-09 prior_knowledge: intermediate method OK for intermediate learner", () => {
  const result = recommendMethods(
    { conditions: [], goals: [], learner_level: "intermediate" },
    [METHODS_EXTRA[4]], VOCAB, 1,
  );
  assert.equal(result.chosen.length, 1);
});

await check("U-10 requires_guidance excluded when has_guidance=false", () => {
  const result = recommendMethods(
    { conditions: [], goals: [], has_guidance: false },
    [METHODS_EXTRA[5]], // m-guided-inquiry: requires_guidance=true
    VOCAB, 1,
  );
  assert.equal(result.excluded.length, 1);
  assert.ok(result.excluded[0].because.includes("requires_guidance"));
});

await check("U-11 requires_guidance allowed when has_guidance=true", () => {
  const result = recommendMethods(
    { conditions: [], goals: [], has_guidance: true },
    [METHODS_EXTRA[5]], VOCAB, 1,
  );
  assert.equal(result.chosen.length, 1);
});

await check("U-12 weak_for overlap: penalised methods sorted after clean ones", () => {
  const weakMethod = METHODS_EXTRA[6]; // weak_for: ["cooperative-skills"]
  const cleanMethod = BASE_METHODS[0]; // no weak_for
  const result = recommendMethods(
    { conditions: [], goals: ["cooperative-skills", "inquiry-skills"] },
    [weakMethod, cleanMethod], VOCAB, 1,
  );
  assert.equal(result.chosen.length, 2);
  // clean method (no weak overlap) should come first
  assert.equal(result.chosen[0].id, "m-guided-discovery");
  assert.equal(result.chosen[1].id, "m-weak-overlap");
  assert.deepEqual(result.chosen[1].weak_overlap, ["cooperative-skills"]);
});

await check("U-13 unknown learner_level throws VocabError('learner_level')", () => {
  assert.throws(
    () => recommendMethods({ conditions: [], goals: [], learner_level: "advanced" }, BASE_METHODS, VOCAB, 1),
    (err) => err instanceof VocabError && err.field === "learner_level",
  );
});

await check("U-14 card with invalid prior_knowledge → excluded with 'invalid_card_field'", () => {
  const badCard = {
    id: "m-bad-card",
    best_for: ["inquiry-skills"],
    avoid_when: [],
    prior_knowledge: "advanced",  // not in vocab:prior
    requires_guidance: false,
  };
  const result = recommendMethods({ conditions: [], goals: [] }, [badCard], VOCAB, 1);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].id, "m-bad-card");
  assert.ok(result.excluded[0].because.includes("invalid_card_field"));
});

await check("U-15 no goal match → rationale=[], no_goal_match=true", () => {
  // m-predict-observe-explain: best_for has no overlap with goals
  const result = recommendMethods(
    { conditions: [], goals: ["cooperative-skills"] },
    [BASE_METHODS[1]], VOCAB, 1,
  );
  assert.equal(result.chosen.length, 1);
  assert.deepEqual(result.chosen[0].rationale, []);
  assert.equal(result.chosen[0].no_goal_match, true);
});

await check("U-16 sort by goal match count: more matches rank higher", () => {
  // m-guided-discovery matches 2 goals; m-cooperative-learning matches 1
  const result = recommendMethods(
    { conditions: [], goals: ["inquiry-skills", "observation", "cooperative-skills"] },
    [BASE_METHODS[2], BASE_METHODS[0]], VOCAB, 1,
    // cooperative-learning: best_for=["cooperative-skills","communication","leadership"] → 1 match
    // guided-discovery: best_for=["inquiry-skills","observation","critical-thinking"] → 2 matches
  );
  assert.equal(result.chosen[0].id, "m-guided-discovery");   // 2 matches first
  assert.equal(result.chosen[1].id, "m-cooperative-learning"); // 1 match second
});

await check("U-17 vocab:prior with unranked value throws KnowledgeIncompatibleError", () => {
  const vocabWithUnranked = { ...VOCAB, prior: ["novice", "intermediate", "any", "advanced"] };
  assert.throws(
    () => recommendMethods({ conditions: [], goals: [] }, BASE_METHODS, vocabWithUnranked, 1),
    (err) => err instanceof KnowledgeIncompatibleError && err.field === "vocab:prior" &&
      Array.isArray(err.unranked) && err.unranked.includes("advanced"),
  );
});

await check("U-18 learner_level: 'any' throws VocabError (not a learner input)", () => {
  assert.throws(
    () => recommendMethods({ conditions: [], goals: [], learner_level: "any" }, BASE_METHODS, VOCAB, 1),
    (err) => err instanceof VocabError && err.field === "learner_level",
  );
});

// ── Integration tests (real routing, in-memory D1) ────────────────────────────
// Tables defined inline to avoid depending on #1288 migration file (not in main yet).
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
// authoring_drafts is created by the existing migration (0002-chalk-authoring.sql).
const AUTHORING_SCHEMA_FILE = new URL("../migrations/0002-chalk-authoring.sql", import.meta.url);
import { readFileSync } from "node:fs";
const AUTHORING_SCHEMA = readFileSync(AUTHORING_SCHEMA_FILE, "utf8");

const profileId = listProfiles().find((p) => p.session.cohort_id === COHORT)?.id;
assert.ok(profileId, "profile not found for COHORT");

function makeDb({ seed = true, seedDraft = true, draftOwner = "tester", omitPriorVocab = false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(KB_SCHEMA);
  db.exec(AUTHORING_SCHEMA);
  if (seed) {
    const vocabCount = omitPriorVocab ? 2 : 3;
    db.prepare(`INSERT INTO chalk_knowledge_versions VALUES(1,NULL,'vault-import',NULL,NULL,'test','tester',0,${BASE_METHODS.length + vocabCount},'digest0')`).run();
    db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
      1, "vocab:goal", "vocab",
      JSON.stringify({ keys: GOAL_VOCAB.map((k) => ({ key: k, label: k })) }), "", null,
    );
    db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
      1, "vocab:condition", "vocab",
      JSON.stringify({ keys: COND_VOCAB.map((k) => ({ key: k, label: k })) }), "", null,
    );
    if (!omitPriorVocab) {
      db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
        1, "vocab:prior", "vocab",
        JSON.stringify({ keys: PRIOR_VOCAB.map((k) => ({ key: k, label: k })) }), "", null,
      );
    }
    for (const m of BASE_METHODS) {
      db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
        1, `method:${m.id}`, "method",
        JSON.stringify(m), "", null,
      );
    }
  }
  if (seedDraft) {
    // Insert a draft owned by draftOwner
    db.prepare(
      `INSERT INTO authoring_drafts (cohort_id,course_id,owner_id,profile_id,revision,content_json,request_id,request_hash,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(COHORT, "test-course", draftOwner, profileId, 1, '{"schema":"hps-session-design/1"}', "req-1", "hash-1", new Date().toISOString());
  }
  return db;
}

function makeEnv(db) {
  const env = createMockEnv({ withSession: false });
  env.HPS_DB = {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...args) { bindings = args; return this; },
        async first() { return db.prepare(sql).get(...bindings) ?? null; },
        async run() { const r = db.prepare(sql).run(...bindings); return { success: true, meta: { changes: Number(r.changes) } }; },
        async all() { return { success: true, results: db.prepare(sql).all(...bindings) }; },
      };
    },
  };
  return env;
}

const token = async (issuer, scopes = [{ cohort: COHORT, profiles: [profileId] }]) =>
  (await issueIssuer({ issuer, scopes }, 4, TEST_SECRET)).token;
const studentToken = async () => (await issue({ u: "kid01", c: COHORT, p: profileId }, 1, TEST_SECRET)).token;

const base = `/admin/chalk/cohorts/${COHORT}/courses/test-course/recommend`;

async function req(body, credential, db) {
  const usedDb = db ?? makeDb();
  const env = makeEnv(usedDb);
  const headers = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
  const res = await app.fetch(
    new Request("https://service.test" + base, { method: "POST", headers, body: JSON.stringify(body) }),
    env, makeCtx(),
  );
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

const issuerTok = await token("tester");
const otherIssuerTok = await token("other-instructor");
const studentTok = await studentToken();

await check("I-01 student token → 403", async () => {
  const r = await req({ conditions: [], goals: [] }, studentTok);
  assert.equal(r.status, 403);
});

await check("I-02 no knowledge version → 409", async () => {
  const r = await req({ conditions: [], goals: [] }, issuerTok, makeDb({ seed: false }));
  assert.equal(r.status, 409);
});

await check("I-03 unknown condition → 400 with field", async () => {
  const r = await req({ conditions: ["not-a-real-condition"], goals: [] }, issuerTok);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "vocab_unknown");
  assert.equal(r.json.field, "condition");
});

await check("I-04 biopharm conditions → project-based excluded", async () => {
  const r = await req(
    { conditions: ["single-session", "short-session", "novice-learners"], goals: [] },
    issuerTok,
  );
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.excluded.map((e) => e.id), ["m-project-based-learning"]);
  assert.equal(r.json.chosen.length, 3);
  assert.equal(r.json.knowledge_version, 1);
});

await check("I-05 missing conditions array → 400", async () => {
  const r = await req({ goals: [] }, issuerTok);
  assert.equal(r.status, 400);
});

await check("I-06 invalid Bearer → 401", async () => {
  // admin middleware lets through any Bearer-prefixed header; route handler verifies.
  const r = await req({ conditions: [], goals: [] }, "not-a-valid-token");
  assert.equal(r.status, 401);
});

await check("I-07 draft not found (no draft seeded) → 404", async () => {
  const r = await req({ conditions: [], goals: [] }, issuerTok, makeDb({ seedDraft: false }));
  assert.equal(r.status, 404);
});

await check("I-08 other issuer's course → 404", async () => {
  // Draft is owned by "tester". otherIssuerTok.u = "other-instructor" → 404.
  const r = await req({ conditions: [], goals: [] }, otherIssuerTok);
  assert.equal(r.status, 404);
});

await check("I-09 vocab:prior missing → 409 knowledge incomplete", async () => {
  const r = await req({ conditions: [], goals: [] }, issuerTok, makeDb({ omitPriorVocab: true }));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "knowledge_incomplete");
  assert.ok(r.json.error.includes("incomplete"));
});

await check("I-10 oversized body without valid token → 401 not 413", async () => {
  // Auth middleware runs before bodyLimit; unauthenticated oversized request must get 401.
  const db = makeDb();
  const env = makeEnv(db);
  const bigBody = JSON.stringify({ conditions: [], goals: [], padding: "x".repeat(256 * 1024 + 1) });
  const res = await app.fetch(
    new Request("https://service.test" + base, {
      method: "POST",
      headers: { authorization: "Bearer not-a-valid-token", "content-type": "application/json" },
      body: bigBody,
    }),
    env, makeCtx(),
  );
  assert.equal(res.status, 401);
});

await check("I-11 oversized body with valid token → 413", async () => {
  // bodyLimit runs after auth; authenticated oversized request must get 413.
  const db = makeDb();
  const env = makeEnv(db);
  const bigBody = JSON.stringify({ conditions: [], goals: [], padding: "x".repeat(256 * 1024 + 1) });
  const res = await app.fetch(
    new Request("https://service.test" + base, {
      method: "POST",
      headers: { authorization: `Bearer ${issuerTok}`, "content-type": "application/json" },
      body: bigBody,
    }),
    env, makeCtx(),
  );
  assert.equal(res.status, 413);
});

await check("I-12 vocab:prior has unranked value → 409 knowledge incompatible", async () => {
  // Seed a KB with vocab:prior containing 'advanced' (not in LEVEL_RANK, not 'any')
  const db = makeDb({ seed: false, seedDraft: true });
  db.prepare(`INSERT INTO chalk_knowledge_versions VALUES(1,NULL,'vault-import',NULL,NULL,'test','tester',0,3,'digest0')`).run();
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
    1, "vocab:goal", "vocab", JSON.stringify({ keys: GOAL_VOCAB.map(k => ({ key: k, label: k })) }), "", null,
  );
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
    1, "vocab:condition", "vocab", JSON.stringify({ keys: COND_VOCAB.map(k => ({ key: k, label: k })) }), "", null,
  );
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
    1, "vocab:prior", "vocab",
    JSON.stringify({ keys: ["novice", "intermediate", "any", "advanced"].map(k => ({ key: k, label: k })) }), "", null,
  );
  const r = await req({ conditions: [], goals: [] }, issuerTok, db);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.code, "knowledge_incompatible");
  assert.equal(r.json.error, "knowledge incompatible");
  assert.equal(r.json.field, "vocab:prior");
  assert.ok(Array.isArray(r.json.unranked) && r.json.unranked.includes("advanced"));
});

console.log(`\n${passed} tests passed.`);
