// #1295 — chalk-courses body-limit gate tests.
// T-C7a: valid issuer token + body > 256KB → PUT /plan returns 413
// T-C7b: no valid token  + body > 256KB → PUT /plan returns 401 (auth before bodyLimit)
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
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

const profileId = listProfiles().find(p => p.session.cohort_id === COHORT)?.id;
assert.ok(profileId, "profile not found for COHORT");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(KB_SCHEMA);
  db.exec(AUTHORING_SCHEMA);
  db.exec(PLAN_SCHEMA);
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

// Body larger than PLAN_MAX_BYTES (256 KB) + 8 KB envelope allowance = 264 KB.
// Send 270 KB to be safely over the limit.
const OVER_LIMIT_HTML = "x".repeat(270 * 1024);
const overBody = JSON.stringify({ file: "lesson", html: OVER_LIMIT_HTML, knowledge_version: 1 });

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

// T-C7a: valid token + body over limit → 413
await check("T-C7a PUT /plan valid-token 270KB body returns 413", async () => {
  const tok = await issuerTok();
  const env = makeEnv(makeDb());
  const res = await app.fetch(
    new Request("https://service.test" + base + "/plan", {
      method: "PUT",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: overBody,
    }),
    env, makeCtx(),
  );
  assert.equal(res.status, 413, `expected 413 got ${res.status}`);
});

// T-C7b: invalid token + body over limit → 401 (auth middleware runs before bodyLimit)
await check("T-C7b PUT /plan invalid-token 270KB body returns 401", async () => {
  const env = makeEnv(makeDb());
  const res = await app.fetch(
    new Request("https://service.test" + base + "/plan", {
      method: "PUT",
      headers: { authorization: "Bearer not-a-valid-token", "content-type": "application/json" },
      body: overBody,
    }),
    env, makeCtx(),
  );
  assert.equal(res.status, 401, `expected 401 got ${res.status}`);
});

console.log(`\nchalk-draft-check: ${passed}/2 passed`);
