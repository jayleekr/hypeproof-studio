// #1466 (E2-7) — chalk-feedback integration tests.
// POST /admin/chalk/cohorts/:cohort/courses/:course/feedback
// GET  /admin/chalk/cohorts/:cohort/courses/:course/diff
// PUT  /admin/chalk/cohorts/:cohort/courses/:course/plan (feedback_id)
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
const AUTHORING_SCHEMA = readFileSync(new URL("../migrations/0002-chalk-authoring.sql", import.meta.url), "utf8");
const PLAN_SCHEMA = readFileSync(new URL("../migrations/0031-chalk-plan-files.sql", import.meta.url), "utf8");
const TIER_DURATION_SCHEMA = readFileSync(new URL("../migrations/0035-chalk-course-inputs-tier-duration.sql", import.meta.url), "utf8");
const FEEDBACK_SCHEMA = readFileSync(new URL("../migrations/0036-chalk-feedback.sql", import.meta.url), "utf8");
const JUDGEMENTS_SCHEMA = readFileSync(new URL("../migrations/0037-chalk-judgements.sql", import.meta.url), "utf8");

const profileId = listProfiles().find(p => p.session.cohort_id === COHORT)?.id;
assert.ok(profileId, "profile not found for COHORT");

const MINIMAL_LESSON_HTML = `<!DOCTYPE html>
<html lang="ko" data-chalk-plan="1" data-chalk-kind="lesson">
<head>
  <meta charset="utf-8">
  <meta name="chalk:course" content="test-course">
  <meta name="chalk:knowledge-version" content="1">
  <meta name="chalk:format" content="workshop">
  <meta name="chalk:audience-tier" content="">
  <meta name="chalk:family-session" content="false">
  <meta name="chalk:duration-min" content="60">
  <meta name="chalk:prerequisites" content="">
  <meta name="chalk:methods" content="m-coop">
</head>
<body>
  <section data-chalk-section="meta"></section>
  <section data-chalk-section="objectives"><ul>
    <li data-chalk-objective="obj-1">관찰 능력 키우기</li>
  </ul></section>
  <section data-chalk-section="essential-question"></section>
  <section data-chalk-section="flow"><table>
    <tr data-chalk-step="s-1">
      <td data-chalk-field="title">도입</td>
      <td data-chalk-field="teacher">질문하기</td>
      <td data-chalk-field="learner">탐구</td>
      <td data-chalk-field="duration-min">10</td>
    </tr>
  </table></section>
  <section data-chalk-section="key-questions"></section>
  <section data-chalk-section="prohibited-moves"></section>
  <section data-chalk-section="materials"></section>
  <section data-chalk-section="support"></section>
  <section data-chalk-section="evidence"><ul>
    <li>관찰 보고서</li>
  </ul></section>
</body>
</html>`;

const UPDATED_LESSON_HTML = MINIMAL_LESSON_HTML.replace("관찰 능력 키우기", "관찰 및 탐구 능력 키우기");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(KB_SCHEMA);
  db.exec(AUTHORING_SCHEMA);
  db.exec(PLAN_SCHEMA);
  db.exec(TIER_DURATION_SCHEMA);
  db.exec(FEEDBACK_SCHEMA);
  db.exec(JUDGEMENTS_SCHEMA);
  // seed knowledge version 1 + minimal vocab for plan save
  db.prepare(`INSERT INTO chalk_knowledge_versions VALUES(1,NULL,'vault-import',NULL,NULL,'test','tester',0,1,'digest0')`).run();
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
    1, "vocab:goal", "vocab", JSON.stringify({ keys: [{ key: "observation", label: "관찰" }] }), "", null,
  );
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
    1, "vocab:condition", "vocab", JSON.stringify({ keys: [{ key: "single-session", label: "단회" }] }), "", null,
  );
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
    1, "vocab:prior", "vocab", JSON.stringify({ keys: [{ key: "any", label: "any" }] }), "", null,
  );
  db.prepare("INSERT INTO chalk_knowledge_docs VALUES(?,?,?,?,?,?)").run(
    1, "method:m-coop", "method",
    JSON.stringify({ id: "m-coop", best_for: ["observation"], weak_for: [], avoid_when: [], prior_knowledge: "any", requires_guidance: false }),
    "", null,
  );
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

// Seed a draft row at revision 1 directly in db (matching chalk-courses.test.mjs pattern).
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

// Seed a draft + plan file. Returns { itok, planRevision }.
// Draft starts at 1; PUT /inputs bumps to 2; PUT /plan bumps to 3 — but we skip inputs
// here and seed draft then PUT /plan directly from revision 1, landing on revision 2.
async function seedDraftAndPlan(db) {
  const itok = await issuerTok();
  seedDraft(db);
  // save plan (expected_revision=1 → new revision=2)
  const r = await req("PUT", `${base}/plan`, {
    file: "lesson", html: MINIMAL_LESSON_HTML,
    knowledge_version: 1, expected_revision: 1,
    request_id: "plan-save-01",
  }, itok, db);
  if (r.status !== 200) throw new Error(`seedDraftAndPlan PUT /plan failed: ${r.status} ${JSON.stringify(r.json)}`);
  return { itok, planRevision: 2 };
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

// ── isIssuerAllowedEndpoint allowlist ─────────────────────────────────────────
await check("FB-01 POST /feedback in allowlist", async () => {
  assert.ok(isIssuerAllowedEndpoint(`/admin/chalk/cohorts/c1/courses/crs1/feedback`, "POST"));
  assert.ok(!isIssuerAllowedEndpoint(`/admin/chalk/cohorts/c1/courses/crs1/feedback`, "GET"));
});

await check("FB-02 GET /diff in allowlist", async () => {
  assert.ok(isIssuerAllowedEndpoint(`/admin/chalk/cohorts/c1/courses/crs1/diff`, "GET"));
  assert.ok(!isIssuerAllowedEndpoint(`/admin/chalk/cohorts/c1/courses/crs1/diff`, "POST"));
});

// ── POST /feedback ────────────────────────────────────────────────────────────
await check("FB-03 POST /feedback 200 creates record", async () => {
  const db = makeDb();
  const { itok } = await seedDraftAndPlan(db);
  const r = await req("POST", `${base}/feedback`, {
    text: "흐름이 너무 빠릅니다. 도입 단계를 늘려 주세요.",
    model: "claude-sonnet-5",
    base_revision: 2,
    request_id: "fb-req-01",
  }, itok, db);
  assert.equal(r.status, 200);
  assert.ok(typeof r.json.feedback_id === "string", "feedback_id must be string");
  assert.equal(r.json.base_revision, 2);
  assert.ok(typeof r.json.created_at === "number");
});

await check("FB-04a POST /feedback idempotent on same request_id in same course", async () => {
  const db = makeDb();
  const { itok } = await seedDraftAndPlan(db);
  const body = { text: "피드백", model: "claude-sonnet-5", base_revision: 2, request_id: "fb-req-idem" };
  const r1 = await req("POST", `${base}/feedback`, body, itok, db);
  const r2 = await req("POST", `${base}/feedback`, body, itok, db);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r1.json.feedback_id, r2.json.feedback_id, "same course + same request_id must return same feedback_id");
  assert.equal(r1.json.created_at, r2.json.created_at);
});

await check("FB-04b POST /feedback same request_id in different course → two rows, both 200", async () => {
  const db = makeDb();
  const itok = await issuerTok();
  // seed two courses
  const course2 = "test-course-2";
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO authoring_drafts (cohort_id,course_id,owner_id,profile_id,revision,content_json,request_id,request_hash,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(COHORT, "test-course", "tester", "", 1,
    '{"schema":"hps-session-design/1","title":"","audience":"","duration_minutes":120,"objective":"","prerequisites":"","starter":"","steps":[]}',
    "req-seed-c1", "hash-seed-c1", now);
  db.prepare(
    `INSERT INTO authoring_drafts (cohort_id,course_id,owner_id,profile_id,revision,content_json,request_id,request_hash,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(COHORT, course2, "tester", "", 1,
    '{"schema":"hps-session-design/1","title":"","audience":"","duration_minutes":120,"objective":"","prerequisites":"","starter":"","steps":[]}',
    "req-seed-c2", "hash-seed-c2", now);
  const SHARED_REQ_ID = "shared-req-id-01";
  const base2 = `/admin/chalk/cohorts/${COHORT}/courses/${course2}`;
  const r1 = await req("POST", `${base}/feedback`, { text: "fb1", model: "m", base_revision: 1, request_id: SHARED_REQ_ID }, itok, db);
  const r2 = await req("POST", `${base2}/feedback`, { text: "fb2", model: "m", base_revision: 1, request_id: SHARED_REQ_ID }, itok, db);
  assert.equal(r1.status, 200, `course1: ${JSON.stringify(r1.json)}`);
  assert.equal(r2.status, 200, `course2: ${JSON.stringify(r2.json)}`);
  assert.notEqual(r1.json.feedback_id, r2.json.feedback_id, "different courses must produce different feedback_ids");
  const rows = db.prepare("SELECT feedback_id FROM chalk_feedback WHERE request_id=?").all(SHARED_REQ_ID);
  assert.equal(rows.length, 2, "two rows must exist");
});

await check("FB-05 POST /feedback 400 on missing text", async () => {
  const db = makeDb();
  const { itok } = await seedDraftAndPlan(db);
  const r = await req("POST", `${base}/feedback`, {
    model: "claude-sonnet-5", base_revision: 2, request_id: "fb-req-no-text",
  }, itok, db);
  assert.equal(r.status, 400);
});

await check("FB-06 POST /feedback 413 on oversized text", async () => {
  const db = makeDb();
  const { itok } = await seedDraftAndPlan(db);
  const bigText = "x".repeat(17 * 1024);
  const r = await req("POST", `${base}/feedback`, {
    text: bigText, model: "claude-sonnet-5", base_revision: 2, request_id: "fb-req-big",
  }, itok, db);
  assert.equal(r.status, 413);
});

await check("FB-07 POST /feedback 403 on student token", async () => {
  const db = makeDb();
  const stok = await studentTok();
  const r = await req("POST", `${base}/feedback`, {
    text: "학생 피드백", model: "m", base_revision: 1, request_id: "fb-stud-01",
  }, stok, db);
  assert.equal(r.status, 403);
});

// ── GET /diff ─────────────────────────────────────────────────────────────────
await check("FB-08 GET /diff no prior revision returns changes:[] with sha256", async () => {
  const db = makeDb();
  const { itok } = await seedDraftAndPlan(db);
  const r = await req("GET", `${base}/diff?file=lesson`, null, itok, db);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.changes, []);
  assert.equal(r.json.from_revision, null);
  assert.equal(r.json.to_revision, 2);
  assert.equal(r.json.from_sha256, null);
  assert.ok(typeof r.json.to_sha256 === "string" && r.json.to_sha256.length > 0, "to_sha256 must be present");
});

await check("FB-09 GET /diff with two revisions returns changes and sha256", async () => {
  const db = makeDb();
  const { itok } = await seedDraftAndPlan(db);
  // save updated plan at revision 3
  await req("PUT", `${base}/plan`, {
    file: "lesson", html: UPDATED_LESSON_HTML,
    knowledge_version: 1, expected_revision: 2,
    request_id: "plan-save-02",
  }, itok, db);
  const r = await req("GET", `${base}/diff?file=lesson&from=2&to=3`, null, itok, db);
  assert.equal(r.status, 200);
  assert.equal(r.json.from_revision, 2);
  assert.equal(r.json.to_revision, 3);
  assert.ok(r.json.changes.length > 0, "should have at least one change");
  const objChange = r.json.changes.find(c => c.key.startsWith("objectives/"));
  assert.ok(objChange, "objectives change must appear");
  assert.ok(typeof r.json.from_sha256 === "string", "from_sha256 must be present");
  assert.ok(typeof r.json.to_sha256 === "string", "to_sha256 must be present");
  assert.notEqual(r.json.from_sha256, r.json.to_sha256, "shas differ when content differs");
});

await check("FB-09b GET /diff ref≤R: from/to with no direct file save resolves to nearest earlier save", async () => {
  const db = makeDb();
  const { itok } = await seedDraftAndPlan(db);
  // lesson saved at r=2 (MINIMAL). Save lesson again at r=4 (UPDATED) — no lesson at r=3.
  // Step 1: bump draft to r=3 via ops save.
  await req("PUT", `${base}/plan`, {
    file: "ops", html: "<html></html>", knowledge_version: 1, expected_revision: 2,
    request_id: "ops-r3",
  }, itok, db);
  // Step 2: save lesson at r=4.
  await req("PUT", `${base}/plan`, {
    file: "lesson", html: UPDATED_LESSON_HTML, knowledge_version: 1, expected_revision: 3,
    request_id: "lesson-r4",
  }, itok, db);
  // from=3 (no lesson at r=3) → resolves to r=2 content (MINIMAL)
  // to=5   (no lesson at r=5) → resolves to r=4 content (UPDATED)
  // Bump draft to r=5 with another ops save.
  await req("PUT", `${base}/plan`, {
    file: "ops", html: "<html>v2</html>", knowledge_version: 1, expected_revision: 4,
    request_id: "ops-r5",
  }, itok, db);
  const r = await req("GET", `${base}/diff?file=lesson&from=3&to=5`, null, itok, db);
  assert.equal(r.status, 200);
  assert.equal(r.json.from_revision, 3);
  assert.equal(r.json.to_revision, 5);
  assert.ok(r.json.changes.length > 0, "changes must exist (MINIMAL vs UPDATED)");
  assert.notEqual(r.json.from_sha256, r.json.to_sha256, "shas differ");
});

await check("FB-10 GET /diff from >= to → 400", async () => {
  const db = makeDb();
  const { itok } = await seedDraftAndPlan(db);
  const r = await req("GET", `${base}/diff?file=lesson&from=2&to=2`, null, itok, db);
  assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.json)}`);
});

await check("FB-10b GET /diff from before any file save → 404", async () => {
  const db = makeDb();
  const { itok } = await seedDraftAndPlan(db);
  // from=99 → no file at or before r=99 that is earlier than to — but to=100 also has no file at all.
  const r = await req("GET", `${base}/diff?file=lesson&from=1&to=99`, null, itok, db);
  // to=99 resolves to r=2 (ref ≤ 99) — that exists. from=1 resolves to ref ≤ 1 — no file → 404.
  assert.equal(r.status, 404);
});

await check("FB-11 GET /diff 403 on student token", async () => {
  const db = makeDb();
  const stok = await studentTok();
  const r = await req("GET", `${base}/diff?file=lesson`, null, stok, db);
  assert.equal(r.status, 403);
});

// ── PUT /plan with feedback_id ─────────────────────────────────────────────────
await check("FB-12 PUT /plan with valid feedback_id inserts revision link", async () => {
  const db = makeDb();
  const { itok } = await seedDraftAndPlan(db);
  // record feedback first
  const fbR = await req("POST", `${base}/feedback`, {
    text: "수정 요청", model: "claude-sonnet-5", base_revision: 2, request_id: "fb-req-plan",
  }, itok, db);
  assert.equal(fbR.status, 200);
  const feedbackId = fbR.json.feedback_id;
  // save plan referencing that feedback_id
  const planR = await req("PUT", `${base}/plan`, {
    file: "lesson", html: UPDATED_LESSON_HTML,
    knowledge_version: 1, expected_revision: 2,
    request_id: "plan-save-fb",
    feedback_id: feedbackId,
  }, itok, db);
  assert.equal(planR.status, 200);
  // verify revision link exists in DB
  const row = db.prepare("SELECT * FROM chalk_feedback_revisions WHERE feedback_id=?").get(feedbackId);
  assert.ok(row, "chalk_feedback_revisions row must exist");
  assert.equal(row.revision, 3);
  assert.equal(row.file, "lesson");
});

await check("FB-13 PUT /plan with unknown feedback_id returns 400", async () => {
  const db = makeDb();
  const { itok } = await seedDraftAndPlan(db);
  const r = await req("PUT", `${base}/plan`, {
    file: "lesson", html: UPDATED_LESSON_HTML,
    knowledge_version: 1, expected_revision: 2,
    request_id: "plan-save-bad-fb",
    feedback_id: "fb_nonexistent",
  }, itok, db);
  assert.equal(r.status, 400);
});

console.log(`\n${passed} chalk-feedback tests passed`);
