// D1 accounting regression tests — prod outage postmortem.
//
// Background (2026-07 prod incident): the production `cohorts` table was
// never seeded. D1 enforces FOREIGN KEYs unconditionally, so the FK chain
// cohorts → sessions → usage_log/trials meant EVERY accounting INSERT died
// with SQLITE_CONSTRAINT_FOREIGNKEY inside unobserved waitUntil() promises.
// KV kept working; quotas + trace analytics went blind (0 rows everywhere
// except `reports`, the one table without FKs).
//
// These tests pin the three fixes:
//   1. session start writes the cohort parent row in the same D1 batch
//      (self-healing — a fresh database can never FK-kill sessions again)
//   2. persistUsage survives an FK failure: logs + retries with
//      session_id=NULL so usage accounting is never silently lost
//   3. createTrial does the same NULL-session fallback
//
// Run: node --experimental-strip-types test/d1-accounting.test.mjs

import assert from "node:assert/strict";
import {
  bootApp,
  createMockEnv,
  makeCtx,
  withMockUpstream,
  openAIJsonBody,
  TEST_SECRET,
  COHORT,
  PROFILE,
  USER,
} from "./harness/index.mjs";

const app = await bootApp();
const { issue } = await import("../src/lib/tokens.ts");
const { token: TOKEN } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET);
const AUTH = `Bearer ${TOKEN}`;
const ADMIN_PW = "pw-test";
const BASIC = "Basic " + btoa(`admin:${ADMIN_PW}`);

const FK_ERROR = () =>
  new Error("D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_FOREIGNKEY");

function chatRequest() {
  return new Request("https://api.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: AUTH },
    body: JSON.stringify({
      model: "hypeproof-default",
      stream: false,
      messages: [{ role: "user", content: "안녕 코치" }],
    }),
  });
}

function adminRequest(path, body) {
  return new Request(`https://api.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: BASIC },
    body: JSON.stringify(body),
  });
}

// --- 1. baseline: a 200 chat turn persists a usage_log row -------------------
{
  const env = createMockEnv();
  const ctx = makeCtx();
  await withMockUpstream(
    () => Response.json(openAIJsonBody({ content: "ok", tokensIn: 3, tokensOut: 2 })),
    async () => {
      const r = await app.fetch(chatRequest(), env, ctx);
      assert.equal(r.status, 200);
      await ctx.settle();
      const inserts = env._dbCalls.filter((c) => /INSERT INTO usage_log/.test(c.sql));
      assert.equal(inserts.length, 1, "exactly one usage_log INSERT");
      assert.equal(inserts[0].bindings[0], "sess-int-1", "session attributed");
    },
  );
  console.log("✓ d1-accounting: 200 chat → usage_log row (baseline)");
}

// --- 2. FK failure on usage_log → NULL-session retry, chat still 200 ---------
{
  const env = createMockEnv({
    // Simulate prod: any usage_log INSERT that references a session row
    // fails the FK (sessions table empty); NULL session_id passes.
    d1RunError: (sql, bindings) =>
      /INSERT INTO usage_log/.test(sql) && bindings?.[0] != null ? FK_ERROR() : null,
  });
  const ctx = makeCtx();
  const errors = [];
  const realErr = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" "));
  try {
    await withMockUpstream(
      () => Response.json(openAIJsonBody({ content: "ok", tokensIn: 3, tokensOut: 2 })),
      async () => {
        const r = await app.fetch(chatRequest(), env, ctx);
        assert.equal(r.status, 200, "chat unaffected by accounting failure");
        await ctx.settle();
      },
    );
  } finally {
    console.error = realErr;
  }
  const attempts = env._dbCalls.filter((c) => /INSERT INTO usage_log/.test(c.sql));
  assert.equal(attempts.length, 2, "failed INSERT retried once");
  assert.ok(attempts[0].error, "first attempt recorded as failed");
  assert.equal(attempts[1].bindings[0], null, "retry uses session_id=NULL");
  assert.ok(
    errors.some((e) => /persistUsage: usage_log INSERT failed/.test(e)),
    "FK failure logged via console.error (visible in wrangler tail)",
  );
  console.log("✓ d1-accounting: FK-failed usage_log INSERT → logged + NULL-session retry");
}

// --- 3. FK failure on BOTH attempts → logged, never throws -------------------
{
  const env = createMockEnv({
    d1RunError: (sql) => (/INSERT INTO usage_log/.test(sql) ? FK_ERROR() : null),
  });
  const ctx = makeCtx();
  const errors = [];
  const realErr = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" "));
  try {
    await withMockUpstream(
      () => Response.json(openAIJsonBody({ content: "ok", tokensIn: 1, tokensOut: 1 })),
      async () => {
        const r = await app.fetch(chatRequest(), env, ctx);
        assert.equal(r.status, 200);
        await ctx.settle(); // must not reject
      },
    );
  } finally {
    console.error = realErr;
  }
  assert.ok(
    errors.some((e) => /usage row LOST/.test(e)),
    "total loss is loudly logged",
  );
  console.log("✓ d1-accounting: double failure → loud log, no unhandled rejection");
}

// --- 4. session start self-heals the cohorts parent row (batch) --------------
{
  const env = createMockEnv({ adminPassword: ADMIN_PW });
  const ctx = makeCtx();
  const starts = new Date(Date.now() - 60_000).toISOString();
  const ends = new Date(Date.now() + 3_600_000).toISOString();
  const r = await app.fetch(
    adminRequest(`/admin/cohorts/${COHORT}/session`, {
      profile_id: PROFILE,
      starts_at: starts,
      ends_at: ends,
    }),
    env,
    ctx,
  );
  assert.equal(r.status, 200, "session start → 200");
  await ctx.settle();
  const cohortIdx = env._dbCalls.findIndex((c) => /INSERT OR IGNORE INTO cohorts/.test(c.sql));
  const sessionIdx = env._dbCalls.findIndex((c) => /INSERT OR REPLACE INTO sessions/.test(c.sql));
  assert.ok(cohortIdx >= 0, "cohorts parent row ensured");
  assert.ok(sessionIdx >= 0, "sessions row mirrored to D1");
  assert.ok(cohortIdx < sessionIdx, "cohort INSERT precedes sessions INSERT (FK order)");
  assert.equal(env._dbCalls[cohortIdx].bindings[0], COHORT);
  assert.equal(env._dbCalls[sessionIdx].bindings[1], COHORT);
  console.log("✓ d1-accounting: POST /session — cohorts row self-healed in same batch");
}

// --- 5. composite session/open does the same ----------------------------------
{
  const env = createMockEnv({ adminPassword: ADMIN_PW, withSession: false });
  const ctx = makeCtx();
  const r = await app.fetch(
    adminRequest(`/admin/cohorts/${COHORT}/session/open`, {
      profile_id: PROFILE,
      user: "kid77",
    }),
    env,
    ctx,
  );
  assert.equal(r.status, 200, "composite open → 200");
  await ctx.settle();
  const cohortIdx = env._dbCalls.findIndex((c) => /INSERT OR IGNORE INTO cohorts/.test(c.sql));
  const sessionIdx = env._dbCalls.findIndex((c) => /INSERT OR REPLACE INTO sessions/.test(c.sql));
  assert.ok(cohortIdx >= 0 && sessionIdx >= 0 && cohortIdx < sessionIdx,
    "session/open ensures cohort parent before sessions mirror");
  console.log("✓ d1-accounting: POST /session/open — cohorts row self-healed in same batch");
}

// --- 6. session start survives a D1 outage (KV is the gate) -------------------
{
  const env = createMockEnv({
    adminPassword: ADMIN_PW,
    d1RunError: () => new Error("D1_ERROR: database unavailable"),
  });
  const ctx = makeCtx();
  const errors = [];
  const realErr = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" "));
  let r;
  try {
    r = await app.fetch(
      adminRequest(`/admin/cohorts/${COHORT}/session`, {
        profile_id: PROFILE,
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      env,
      ctx,
    );
    await ctx.settle();
  } finally {
    console.error = realErr;
  }
  assert.equal(r.status, 200, "class still starts when D1 mirror fails");
  assert.ok(
    errors.some((e) => /persistSessionStart: D1 sessions mirror failed/.test(e)),
    "mirror failure logged",
  );
  console.log("✓ d1-accounting: D1 outage → session still starts, failure logged");
}

// --- 7. createTrial falls back to NULL session on FK failure ------------------
{
  const { createTrial } = await import("../src/lib/storage.ts");
  const env = createMockEnv({
    d1RunError: (sql, bindings) =>
      /INSERT INTO trials/.test(sql) && bindings?.[1] != null ? FK_ERROR() : null,
  });
  const errors = [];
  const realErr = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" "));
  let id;
  try {
    id = await createTrial(env, {
      session_id: "sess-not-in-d1",
      cohort_id: COHORT,
      user_id: USER,
      profile_id: PROFILE,
    });
  } finally {
    console.error = realErr;
  }
  assert.ok(id, "trial id returned despite FK failure");
  const attempts = env._dbCalls.filter((c) => /INSERT INTO trials/.test(c.sql));
  assert.equal(attempts.length, 2, "trial INSERT retried");
  assert.equal(attempts[1].bindings[1], null, "retry uses session_id=NULL");
  assert.ok(errors.some((e) => /createTrial: INSERT failed/.test(e)), "failure logged");
  console.log("✓ d1-accounting: createTrial FK failure → NULL-session fallback");
}

console.log("d1-accounting.test.mjs: all tests passed");
