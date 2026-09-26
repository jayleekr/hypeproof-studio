// #1295 — chalk-courses integration tests.
// PUT /admin/chalk/cohorts/:cohort/courses/:course/inputs
// PUT /admin/chalk/cohorts/:cohort/courses/:course/plan
// GET /admin/chalk/cohorts/:cohort/courses/:course/brief
// GET /admin/chalk/cohorts/:cohort/courses/:course/plan
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { bootApp, createMockEnv, makeCtx, TEST_SECRET, COHORT } from "./harness/index.mjs";

const { issueIssuer, issue } = await import("../src/lib/tokens.ts");
const { listProfiles } = await import("../src/profiles/index.ts");

const app = await bootApp();

// ── Vocab (real keys from bolt spec) ─────────────────────────────────────────
// 9 conditions from the bolt vocab:condition doc
const COND_VOCAB = [
  "single-session", "short-session", "novice-learners",
  "no-prep-time", "large-group", "requires-materials",
  "low-autonomy", "high-tech-required", "family-mixed-age",
];
// vocab:prior (LEVEL_RANK keys + 'any')
const PRIOR_VOCAB = ["novice", "intermediate", "any"];
// 29 goals
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

// ── Knowledge schema (inline; #1288 not in main yet) ─────────────────────────
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

// Sample methods (3 biopharm-compatible + 1 excluded)
const BASE_METHODS = [
  { id: "m-guided-discovery", best_for: ["inquiry-skills", "observation"], weak_for: [], avoid_when: ["no-prep-time"], prior_knowledge: "any", requires_guidance: false },
  { id: "m-predict-observe-explain", best_for: ["prediction", "observation"], weak_for: [], avoid_when: ["high-tech-required"], prior_knowledge: "any", requires_guidance: false },
  { id: "m-cooperative-learning", best_for: ["cooperative-skills", "communication"], weak_for: [], avoid_when: ["large-group"], prior_knowledge: "any", requires_guidance: false },
  { id: "m-project-based-learning", best_for: ["design-thinking", "autonomy"], weak_for: [], avoid_when: ["short-session", "novice-learners"], prior_knowledge: "any", requires_guidance: false },
];

const profileId = listProfiles().find(p => p.session.cohort_id === COHORT)?.id;
assert.ok(profileId, "profile not found for COHORT");

function makeDb({ seedKb = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(KB_SCHEMA);
  db.exec(AUTHORING_SCHEMA);
  db.exec(PLAN_SCHEMA);
  if (seedKb) {
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
const studentTok = async () => (await issue({ u: "kid01", c: COHORT, p: profileId }, 1, TEST_SECRET)).token;

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

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

const VALID_INPUTS = {
  audience: "초등학교 3-4학년",
  assets: ["INTENT", "VERIFY"],
  teaching_style: "탐구 기반",
  requirements: "실험 도구 필요",
  format: "workshop",
  family_session: false,
  vocab: {
    goals: ["inquiry-skills", "observation"],
    conditions: ["single-session", "novice-learners"],
    learner_level: "novice",
    has_guidance: false,
  },
  expected_revision: 1,
  request_id: "req-inputs-01",
  profile_id: "",
};

// ── PUT /inputs tests ─────────────────────────────────────────────────────────

await check("I-01 PUT /inputs saves inputs and bumps draft revision, returns revision 2", async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const r = await req("PUT", `${base}/inputs`, VALID_INPUTS, tok, db);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.revision, 2);
});

await check("I-02 PUT /inputs idempotent: same request_id returns same revision", async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const r1 = await req("PUT", `${base}/inputs`, VALID_INPUTS, tok, db);
  assert.equal(r1.status, 200);
  const r2 = await req("PUT", `${base}/inputs`, VALID_INPUTS, tok, db);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.revision, r1.json.revision);
});

await check("I-03 PUT /inputs student token → 403", async () => {
  const tok = await studentTok();
  const r = await req("PUT", `${base}/inputs`, VALID_INPUTS, tok);
  assert.equal(r.status, 403);
});

await check("I-04 PUT /inputs unknown asset → 400", async () => {
  const tok = await issuerTok();
  const r = await req("PUT", `${base}/inputs`, {
    ...VALID_INPUTS, request_id: "req-bad-asset",
    assets: ["INTENT", "NOT_AN_ASSET"],
  }, tok);
  assert.equal(r.status, 400);
  assert.equal(r.json.field, "assets");
});

await check("I-05 PUT /inputs unknown vocab goal → 400", async () => {
  const tok = await issuerTok();
  const r = await req("PUT", `${base}/inputs`, {
    ...VALID_INPUTS, request_id: "req-bad-goal",
    vocab: { ...VALID_INPUTS.vocab, goals: ["inquiry-skills", "not-a-real-goal"] },
  }, tok);
  assert.equal(r.status, 400);
  assert.equal(r.json.field, "vocab.goals");
});

await check("I-06 PUT /inputs unknown vocab condition → 400", async () => {
  const tok = await issuerTok();
  const r = await req("PUT", `${base}/inputs`, {
    ...VALID_INPUTS, request_id: "req-bad-cond",
    vocab: { ...VALID_INPUTS.vocab, conditions: ["single-session", "bad-condition"] },
  }, tok);
  assert.equal(r.status, 400);
  assert.equal(r.json.field, "vocab.conditions");
});

await check("I-07 PUT /inputs vocab with no KB → 409", async () => {
  const db = makeDb({ seedKb: false });
  const tok = await issuerTok();
  const r = await req("PUT", `${base}/inputs`, VALID_INPUTS, tok, db);
  assert.equal(r.status, 409);
});

await check("I-08 PUT /inputs without vocab saves OK", async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  const { vocab: _, ...noVocab } = VALID_INPUTS;
  const r = await req("PUT", `${base}/inputs`, {
    ...noVocab, request_id: "req-no-vocab",
  }, tok, db);
  assert.equal(r.status, 200);
  assert.equal(r.json.revision, 2);
});

await check("I-09 PUT /inputs no existing draft → 404", async () => {
  const db = makeDb();
  const tok = await issuerTok();
  // No draft seeded — PUT /inputs must reject when no course draft exists.
  const r = await req("PUT", `${base}/inputs`, VALID_INPUTS, tok, db);
  assert.equal(r.status, 404, JSON.stringify(r.json));
});

await check("I-10 PUT /inputs CAS conflict: 409 must NOT mutate chalk_course_inputs", async () => {
  const db = makeDb();
  seedDraft(db);
  const tok = await issuerTok();
  // Request A: succeeds, audience X, revision 1 → 2.
  const audienceX = "초등학교 3-4학년";
  const rA = await req("PUT", `${base}/inputs`, {
    ...VALID_INPUTS, audience: audienceX, request_id: "req-i10-a",
  }, tok, db);
  assert.equal(rA.status, 200, JSON.stringify(rA.json));
  assert.equal(rA.json.revision, 2);

  // Request B: stale expected_revision=1, audience Y → must be 409.
  const audienceY = "중학교 1학년";
  const rB = await req("PUT", `${base}/inputs`, {
    ...VALID_INPUTS, audience: audienceY, expected_revision: 1, request_id: "req-i10-b",
  }, tok, db);
  assert.equal(rB.status, 409, JSON.stringify(rB.json));

  // Side-effect check: inputs row must still hold X, not Y.
  const row = db.prepare(
    "SELECT audience, revision FROM chalk_course_inputs WHERE cohort_id=? AND course_id=?"
  ).get(COHORT, "test-course");
  assert.equal(row.audience, audienceX, `inputs row was mutated by the 409 request: ${row.audience}`);
  assert.equal(row.revision, 2, `inputs revision was mutated: ${row.revision}`);
});

// ── PUT /plan tests ───────────────────────────────────────────────────────────

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="ko" data-chalk-plan="1" data-chalk-kind="lesson">
<head>
  <meta name="chalk:course" content="test-course">
  <meta name="chalk:knowledge-version" content="1">
  <meta name="chalk:format" content="workshop">
  <meta name="chalk:family-session" content="false">
  <meta name="chalk:duration-min" content="240">
  <meta name="chalk:methods" content="m-guided-discovery m-cooperative-learning">
</head>
<body><p>test plan</p></body>
</html>`;

// Insert a minimal draft row directly — PUT /inputs now requires an existing draft.
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

async function seedDraftAndInputs(db) {
  const tok = await issuerTok();
  // Seed draft at revision 1 first; PUT /inputs requires an existing draft.
  seedDraft(db);
  // PUT /inputs bumps draft to revision 2.
  await req("PUT", `${base}/inputs`, VALID_INPUTS, tok, db);
  return tok;
}

await check("P-01 PUT /plan saves file and returns revision + sha256 + findings", async () => {
  const db = makeDb();
  const tok = await seedDraftAndInputs(db);
  // seedDraftAndInputs: seed at revision 1, PUT /inputs bumps to revision 2.
  const r = await req("PUT", `${base}/plan`, {
    file: "lesson", html: SAMPLE_HTML, knowledge_version: 1,
    expected_revision: 2, request_id: "req-plan-01",
  }, tok, db);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.revision, 3);
  assert.ok(typeof r.json.sha256 === "string" && r.json.sha256.length === 64);
  assert.ok(Array.isArray(r.json.findings));
});

await check("P-02 PUT /plan revision conflict → 409", async () => {
  const db = makeDb();
  const tok = await seedDraftAndInputs(db);
  const r = await req("PUT", `${base}/plan`, {
    file: "lesson", html: SAMPLE_HTML, knowledge_version: 1,
    expected_revision: 3, // wrong — draft is at revision 2 after seedDraftAndInputs
    request_id: "req-plan-conflict",
  }, tok, db);
  assert.equal(r.status, 409);
});

await check("P-03 PUT /plan other issuer → 404", async () => {
  const db = makeDb();
  await seedDraftAndInputs(db);
  const otherTok = await issuerTok("other-issuer");
  const r = await req("PUT", `${base}/plan`, {
    file: "lesson", html: SAMPLE_HTML, knowledge_version: 1,
    expected_revision: 2, request_id: "req-plan-other",
  }, otherTok, db);
  assert.equal(r.status, 404);
});

await check("P-04 PUT /plan student token → 403", async () => {
  const tok = await studentTok();
  const r = await req("PUT", `${base}/plan`, {
    file: "lesson", html: SAMPLE_HTML, knowledge_version: 1,
    expected_revision: 1, request_id: "req-plan-student",
  }, tok);
  assert.equal(r.status, 403);
});

await check("P-05 PUT /plan knowledge_version not found → 409", async () => {
  const db = makeDb();
  const tok = await seedDraftAndInputs(db);
  const r = await req("PUT", `${base}/plan`, {
    file: "lesson", html: SAMPLE_HTML, knowledge_version: 99,
    expected_revision: 2, request_id: "req-plan-badkb",
  }, tok, db);
  assert.equal(r.status, 409);
});

await check("P-07 PUT /plan CAS conflict: 409 must NOT insert into chalk_plan_files", async () => {
  const db = makeDb();
  const tok = await seedDraftAndInputs(db);
  // Draft is at revision 2 after seedDraftAndInputs. Bump to 3 directly to simulate a concurrent write.
  db.prepare(
    "UPDATE authoring_drafts SET revision=3, request_id='req-concurrent', request_hash='hash-concurrent' WHERE cohort_id=? AND course_id=?"
  ).run(COHORT, "test-course");

  // PUT /plan with stale expected_revision=2 → must return 409.
  const r = await req("PUT", `${base}/plan`, {
    file: "lesson", html: SAMPLE_HTML, knowledge_version: 1,
    expected_revision: 2, request_id: "req-p07-stale",
  }, tok, db);
  assert.equal(r.status, 409, JSON.stringify(r.json));

  // Side-effect check: no chalk_plan_files row for ref='3' must have been inserted.
  const row = db.prepare(
    "SELECT COUNT(*) as n FROM chalk_plan_files WHERE cohort_id=? AND course_id=? AND ref='3'"
  ).get(COHORT, "test-course");
  assert.equal(row.n, 0, `chalk_plan_files was mutated by the 409 request: ${row.n} row(s) for ref='3'`);
});

await check("P-06 PUT /plan auto-check: plan with violations returns non-empty findings", async () => {
  const db = makeDb();
  const tok = await seedDraftAndInputs(db);
  // Minimal HTML without required chalk:methods meta — parsePlan should emit a violation.
  const badHtml = `<!DOCTYPE html><html lang="ko" data-chalk-plan="1" data-chalk-kind="lesson"><head>
    <meta name="chalk:course" content="test-course">
    <meta name="chalk:knowledge-version" content="1">
  </head><body></body></html>`;
  const r = await req("PUT", `${base}/plan`, {
    file: "lesson", html: badHtml, knowledge_version: 1,
    expected_revision: 2, request_id: "req-plan-violations",
  }, tok, db);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(Array.isArray(r.json.findings));
  assert.ok(r.json.findings.length > 0, "expected violations in findings but got none");
});

// ── GET /brief tests ──────────────────────────────────────────────────────────

await check("B-01 GET /brief returns expected shape after PUT /inputs with vocab", async () => {
  const db = makeDb();
  const tok = await seedDraftAndInputs(db);
  const r = await req("GET", `${base}/brief?file=lesson`, null, tok, db);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(typeof r.json.knowledge_version, "number");
  assert.ok(Array.isArray(r.json.authoring_order));
  assert.ok(Array.isArray(r.json.methods.chosen));
  assert.ok(Array.isArray(r.json.methods.excluded));
  assert.ok(typeof r.json.skeleton_html === "string" && r.json.skeleton_html.includes("data-chalk-plan"));
  assert.deepEqual(r.json.methods.excluded.map(e => e.id), ["m-project-based-learning"]);
  assert.equal(r.json.methods.chosen.length, 3);
});

await check("B-02 GET /brief no inputs → 409", async () => {
  const db = makeDb();
  const tok = await issuerTok();
  // Manually create a draft without inputs
  const authoring = readFileSync(new URL("../migrations/0002-chalk-authoring.sql", import.meta.url), "utf8");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO authoring_drafts (cohort_id,course_id,owner_id,profile_id,revision,content_json,request_id,request_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(COHORT, "test-course", "tester", "", 1, '{"schema":"hps-session-design/1","title":"","audience":"","duration_minutes":120,"objective":"","prerequisites":"","starter":"","steps":[]}', "req-bare", "hash-bare", now);
  const r = await req("GET", `${base}/brief?file=lesson`, null, tok, db);
  assert.equal(r.status, 409);
});

await check("B-03 GET /brief no KB → 409", async () => {
  const db = makeDb({ seedKb: false });
  const tok = await issuerTok();
  seedDraft(db);
  // Seed inputs without vocab (no KB needed for that save path)
  const { vocab: _, ...noVocab } = VALID_INPUTS;
  await req("PUT", `${base}/inputs`, { ...noVocab, request_id: "req-no-kb" }, tok, db);
  // Now try brief (no KB)
  const r = await req("GET", `${base}/brief?file=lesson`, null, tok, db);
  assert.equal(r.status, 409);
});

await check("B-04 GET /brief student token → 403", async () => {
  const tok = await studentTok();
  const r = await req("GET", `${base}/brief?file=lesson`, null, tok);
  assert.equal(r.status, 403);
});

// ── GET /plan tests ───────────────────────────────────────────────────────────

await check("R-01 GET /plan returns saved HTML after PUT /plan", async () => {
  const db = makeDb();
  const tok = await seedDraftAndInputs(db);
  await req("PUT", `${base}/plan`, {
    file: "lesson", html: SAMPLE_HTML, knowledge_version: 1,
    expected_revision: 2, request_id: "req-plan-read",
  }, tok, db);
  const r = await req("GET", `${base}/plan?file=lesson`, null, tok, db);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.html, SAMPLE_HTML);
  assert.ok(typeof r.json.sha256 === "string");
  assert.equal(r.json.ref_kind, "draft");
});

await check("R-02 GET /plan no plan file → 404", async () => {
  const db = makeDb();
  const tok = await seedDraftAndInputs(db);
  const r = await req("GET", `${base}/plan?file=lesson`, null, tok, db);
  assert.equal(r.status, 404);
});

await check("R-03 GET /plan student token → 403", async () => {
  const tok = await studentTok();
  const r = await req("GET", `${base}/plan?file=lesson`, null, tok);
  assert.equal(r.status, 403);
});

// ── PUT /plan body-limit gate ─────────────────────────────────────────────────
// G-01/G-02: auth runs before bodyLimit — oversized body + valid token → 413;
// oversized body + invalid token → 401.

const OVER_LIMIT_PLAN_BODY = JSON.stringify({
  file: "lesson",
  html: "x".repeat(270 * 1024),
  knowledge_version: 1,
  expected_revision: 1,
  request_id: "req-g01",
});

await check("G-01 PUT /plan valid-token 270KB body → 413", async () => {
  const tok = await issuerTok();
  const env = makeEnv(makeDb());
  const res = await app.fetch(
    new Request("https://service.test" + base + "/plan", {
      method: "PUT",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: OVER_LIMIT_PLAN_BODY,
    }),
    env, makeCtx(),
  );
  assert.equal(res.status, 413, `expected 413 got ${res.status}`);
});

await check("G-02 PUT /plan invalid-token 270KB body → 401 (auth before bodyLimit)", async () => {
  const env = makeEnv(makeDb());
  const res = await app.fetch(
    new Request("https://service.test" + base + "/plan", {
      method: "PUT",
      headers: { authorization: "Bearer not-a-valid-token", "content-type": "application/json" },
      body: OVER_LIMIT_PLAN_BODY,
    }),
    env, makeCtx(),
  );
  assert.equal(res.status, 401, `expected 401 got ${res.status}`);
});

// ── Negative: plan text NOT in student profile ────────────────────────────────
// This test verifies E1-1 §3-1 required negative: plan content must never reach
// the student coach prompt or /v1/profile response.
await check("N-01 student token /v1/profile does not contain plan content", async () => {
  const db = makeDb();
  const tok = await issuerTok();
  await seedDraftAndInputs(db);
  // Save plan with a distinctive teacher-side sentence
  const markerSentence = "교사용-비공개-내용-검증-표본";
  const planWithMarker = SAMPLE_HTML.replace("<p>test plan</p>", `<td data-chalk-role="teacher">${markerSentence}</td>`);
  await req("PUT", `${base}/plan`, {
    file: "lesson", html: planWithMarker, knowledge_version: 1,
    expected_revision: 2, request_id: "req-plan-marker",
  }, tok, db);

  // Now fetch /v1/profile as a student — must not contain the marker
  const studentEnv = makeEnv(db);
  const studentToken = await studentTok();
  const profileRes = await app.fetch(
    new Request("https://service.test/v1/profile", {
      headers: { authorization: `Bearer ${studentToken}` },
    }),
    studentEnv, makeCtx(),
  );
  const profileText = await profileRes.text();
  assert.ok(!profileText.includes(markerSentence),
    `plan content leaked into /v1/profile: found "${markerSentence}"`);
});

console.log(`\n${passed} tests passed.`);
