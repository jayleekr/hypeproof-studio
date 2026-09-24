// #1293 — chalk-recommend unit + integration tests.
// Unit: recommendMethods() pure function, no DB.
// Integration: POST /admin/chalk/cohorts/:cohort/courses/:course/recommend
//   — real Service routing, in-memory SQLite, signed issuer tokens.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, COHORT } from "./harness/index.mjs";

const { recommendMethods, VocabError } = await import("../src/lib/chalk-recommend.ts");
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
// Three biopharm-compatible methods and one excluded
const METHODS = [
  {
    id: "m-guided-discovery",
    best_for: ["inquiry-skills", "observation", "critical-thinking"],
    weak_for: [],
    avoid_when: ["no-prep-time"],
  },
  {
    id: "m-predict-observe-explain",
    best_for: ["prediction", "observation", "evidence-based-reasoning"],
    weak_for: [],
    avoid_when: ["high-tech-required"],
  },
  {
    id: "m-cooperative-learning",
    best_for: ["cooperative-skills", "communication", "leadership"],
    weak_for: [],
    avoid_when: ["large-group"],
  },
  {
    id: "m-project-based-learning",
    best_for: ["design-thinking", "autonomy", "problem-solving"],
    weak_for: [],
    avoid_when: ["short-session", "novice-learners"],
  },
];

const VOCAB = { goals: GOAL_VOCAB, conditions: COND_VOCAB };

// ── Unit tests (pure function, no DB) ─────────────────────────────────────────
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

await check("U-01 biopharm conditions: project-based excluded, three candidates", () => {
  const result = recommendMethods(
    { conditions: ["single-session", "short-session", "novice-learners"], goals: [] },
    METHODS, VOCAB, 1,
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
    [METHODS[3]], VOCAB, 1,
  );
  const ex = result.excluded[0];
  assert.equal(ex.id, "m-project-based-learning");
  assert.ok(ex.because.includes("short-session"));
  assert.ok(ex.because.includes("novice-learners"));
});

await check("U-03 unknown condition throws VocabError", () => {
  assert.throws(
    () => recommendMethods({ conditions: ["unknown-condition"], goals: [] }, METHODS, VOCAB, 1),
    (err) => err instanceof VocabError && err.field === "condition",
  );
});

await check("U-04 unknown goal throws VocabError", () => {
  assert.throws(
    () => recommendMethods({ conditions: [], goals: ["nonexistent-goal"] }, METHODS, VOCAB, 1),
    (err) => err instanceof VocabError && err.field === "goal",
  );
});

await check("U-05 determinism: same input + same methods → same output", () => {
  const input = { conditions: ["short-session"], goals: ["cooperative-skills"] };
  const r1 = recommendMethods(input, METHODS, VOCAB, 1);
  const r2 = recommendMethods(input, METHODS, VOCAB, 1);
  assert.deepEqual(r1, r2);
});

await check("U-06 goal rationale: matched goals shown when input goals provided", () => {
  const result = recommendMethods(
    { conditions: [], goals: ["cooperative-skills"] },
    [METHODS[2]], VOCAB, 1,
  );
  assert.deepEqual(result.chosen[0].rationale, ["cooperative-skills"]);
});

await check("U-07 empty conditions → all methods are candidates", () => {
  const result = recommendMethods({ conditions: [], goals: [] }, METHODS, VOCAB, 1);
  assert.equal(result.chosen.length, METHODS.length);
  assert.equal(result.excluded.length, 0);
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

const profileId = listProfiles().find((p) => p.session.cohort_id === COHORT)?.id;
assert.ok(profileId, "profile not found for COHORT");

function makeDb(seed = true) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(KB_SCHEMA);
  if (seed) {
    db.prepare(`INSERT INTO chalk_knowledge_versions VALUES(1,NULL,'vault-import',NULL,NULL,'test','tester',0,${METHODS.length + 2},'digest0')`).run();
    db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
      1, "vocab:goal", "vocab",
      JSON.stringify({ keys: GOAL_VOCAB.map((k) => ({ key: k, label: k })) }), "", null,
    );
    db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
      1, "vocab:condition", "vocab",
      JSON.stringify({ keys: COND_VOCAB.map((k) => ({ key: k, label: k })) }), "", null,
    );
    for (const m of METHODS) {
      db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
        1, `method:${m.id}`, "method",
        JSON.stringify({ id: m.id, best_for: m.best_for, weak_for: m.weak_for, avoid_when: m.avoid_when }),
        "", null,
      );
    }
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

const token = async (scopes = [{ cohort: COHORT, profiles: [profileId] }]) =>
  (await issueIssuer({ issuer: "tester", scopes }, 4, TEST_SECRET)).token;
const studentToken = async () => (await issue({ u: "kid01", c: COHORT, p: profileId }, 1, TEST_SECRET)).token;

const base = `/admin/chalk/cohorts/${COHORT}/courses/test-course/recommend`;

async function req(body, credential, db = makeDb()) {
  const env = makeEnv(db);
  const headers = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
  const res = await app.fetch(
    new Request("https://service.test" + base, { method: "POST", headers, body: JSON.stringify(body) }),
    env, makeCtx(),
  );
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

const issuerTok = await token();
const studentTok = await studentToken();

await check("I-01 student token → 403", async () => {
  const r = await req({ conditions: [], goals: [] }, studentTok);
  assert.equal(r.status, 403);
});

await check("I-02 no knowledge version → 409", async () => {
  const r = await req({ conditions: [], goals: [] }, issuerTok, makeDb(false));
  assert.equal(r.status, 409);
});

await check("I-03 unknown condition → 400 with field", async () => {
  const r = await req({ conditions: ["not-a-real-condition"], goals: [] }, issuerTok);
  assert.equal(r.status, 400);
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

console.log(`\n${passed} tests passed.`);
