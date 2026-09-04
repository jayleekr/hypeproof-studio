// #684 — usage_log.status must be an OBSERVED value, and failed turns must
// leave a row.
//
// Production evidence that motivated this file:
//
//   SELECT status, COUNT(*) FROM usage_log GROUP BY status;
//   -- status=200   16,564 rows   2026-07-14 .. 2026-08-23
//
// Seven weeks, every row 200, no other value ever — because both LLM routes
// hardcoded `status: 200` and only called record() on the success path. So a
// student whose every turn errors, a student who never opened Studio, and a
// student quietly doing fine are IDENTICAL in D1. The instructor board (#674)
// stands on this column; built on a constant it renders the student who most
// needs help as "fine".
//
// This file is the planted control for that fix (dag.yaml task B):
//
//   POSITIVE  force an upstream 4xx/5xx => a usage_log row EXISTS carrying the
//             REAL upstream status (not 200) and a populated latency_ms.
//             On pre-fix code no row is created at all, so this MUST fail
//             before the change.
//   NEGATIVE  usage_log is also the billing ledger. Once failures write rows,
//             usage aggregation must count successes only or failures get
//             billed. Asserted by running the PRODUCTION aggregation SQL
//             against a real SQLite database seeded with successes + failures
//             — not by regex over the query text.
//
// Run: node --experimental-strip-types test/usage-log-status.test.mjs

import assert from "node:assert/strict";
import {
  bootApp,
  createMockEnv,
  makeCtx,
  withMockUpstream,
  openAIJsonBody,
  anthropicJsonBody,
  TEST_SECRET,
  COHORT,
  PROFILE,
  USER,
} from "./harness/index.mjs";

const app = await bootApp();
const { issue } = await import("../src/lib/tokens.ts");
const { token: TOKEN } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET);
const AUTH = `Bearer ${TOKEN}`;

// usage_log INSERT binding order (lib/analytics.ts persistUsage):
//   0 session_id · 1 cohort_id · 2 user_id · 3 profile_id · 4 model
//   5 tokens_in · 6 tokens_out · 7 cache_read · 8 cache_write
//   9 latency_ms · 10 status
const B_LATENCY = 9;
const B_STATUS = 10;

function usageInserts(env) {
  return env._dbCalls.filter((c) => /INSERT INTO usage_log/.test(c.sql));
}

function chatRequest(body = {}) {
  return new Request("https://api.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: AUTH },
    body: JSON.stringify({
      model: "hypeproof-default",
      stream: false,
      messages: [{ role: "user", content: "안녕 코치" }],
      ...body,
    }),
  });
}

function messagesRequest(body = {}) {
  return new Request("https://api.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: AUTH },
    body: JSON.stringify({
      model: "claude-mock",
      max_tokens: 1024,
      messages: [{ role: "user", content: "안녕 코치" }],
      ...body,
    }),
  });
}

function anthropicEnv(opts = {}) {
  return createMockEnv({
    ...opts,
    env: { ANTHROPIC_API_KEY: "test-anthropic-key", ...(opts.env ?? {}) },
  });
}

// --- POSITIVE CONTROL 1: /v1/chat upstream 429 → row with status 429 ---------
{
  const env = createMockEnv();
  const ctx = makeCtx();
  const quiet = console.error;
  console.error = () => {};
  try {
    await withMockUpstream(
      () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
      async () => {
        const r = await app.fetch(chatRequest(), env, ctx);
        assert.equal(r.status, 429, "429 passes through to the client (#358)");
        await ctx.settle();
      },
    );
  } finally {
    console.error = quiet;
  }
  const inserts = usageInserts(env);
  assert.equal(inserts.length, 1, "a failed turn STILL writes exactly one usage_log row");
  assert.equal(inserts[0].bindings[B_STATUS], 429, "status is the REAL upstream status, not 200");
  assert.equal(typeof inserts[0].bindings[B_LATENCY], "number", "latency_ms populated");
  assert.ok(inserts[0].bindings[B_LATENCY] >= 0, "latency_ms is a real duration");
  assert.equal(inserts[0].bindings[5], 0, "no tokens billed for a failed turn (tokens_in)");
  assert.equal(inserts[0].bindings[6], 0, "no tokens billed for a failed turn (tokens_out)");
  console.log("✓ #684 chat: upstream 429 → usage_log row, status=429, latency populated");
}

// --- POSITIVE CONTROL 2: /v1/chat upstream 500 → row keeps the UPSTREAM ------
// status even though the client is (correctly) told 502. The column exists to
// answer "what actually happened upstream"; masking it as 502 would repeat the
// original defect one layer down.
{
  const env = createMockEnv();
  const ctx = makeCtx();
  const quiet = console.error;
  console.error = () => {};
  try {
    await withMockUpstream(
      () => new Response("upstream exploded", { status: 500 }),
      async () => {
        const r = await app.fetch(chatRequest(), env, ctx);
        assert.equal(r.status, 502, "5xx is masked as our gateway failure to the client");
        await ctx.settle();
      },
    );
  } finally {
    console.error = quiet;
  }
  const inserts = usageInserts(env);
  assert.equal(inserts.length, 1, "failed turn writes a row");
  assert.equal(inserts[0].bindings[B_STATUS], 500, "row records the observed upstream 500");
  console.log("✓ #684 chat: upstream 500 → usage_log row, status=500 (not the client-facing 502)");
}

// --- POSITIVE CONTROL 3: /v1/messages (Agent SDK path) upstream 400 ----------
{
  const env = anthropicEnv();
  const ctx = makeCtx();
  const quiet = console.error;
  console.error = () => {};
  try {
    await withMockUpstream(
      () => new Response(JSON.stringify({ type: "error" }), { status: 400 }),
      async () => {
        const r = await app.fetch(messagesRequest(), env, ctx);
        assert.equal(r.status, 400, "request-shaped 4xx passes through");
        await ctx.settle();
      },
    );
  } finally {
    console.error = quiet;
  }
  const inserts = usageInserts(env);
  assert.equal(inserts.length, 1, "SDK route also records failed turns");
  assert.equal(inserts[0].bindings[B_STATUS], 400, "status is the real upstream status");
  assert.equal(typeof inserts[0].bindings[B_LATENCY], "number", "latency_ms populated");
  console.log("✓ #684 messages: upstream 400 → usage_log row, status=400");
}

// --- POSITIVE CONTROL 4: upstream unreachable (fetch throws) ----------------
{
  const env = createMockEnv();
  const ctx = makeCtx();
  const quiet = console.error;
  console.error = () => {};
  try {
    await withMockUpstream(
      () => {
        throw new TypeError("network down");
      },
      async () => {
        await app.fetch(chatRequest(), env, ctx);
        await ctx.settle();
      },
    );
  } finally {
    console.error = quiet;
  }
  const inserts = usageInserts(env);
  assert.equal(inserts.length, 1, "an unreachable upstream is still a failed turn, not silence");
  assert.equal(
    inserts[0].bindings[B_STATUS],
    502,
    "no upstream status exists → synthetic 502 (gateway could not reach upstream)",
  );
  console.log("✓ #684 chat: upstream unreachable → usage_log row, status=502");
}

// --- POSITIVE CONTROL 5: stream opened 200 then died ------------------------
// The "중단" case named in #684. The client already has its 200, so the only
// place the gateway can notice is the SSE layer — and before this change the
// row was written with status 200 as if nothing happened.
{
  const env = createMockEnv();
  const ctx = makeCtx();
  const quiet = console.error;
  console.error = () => {};
  try {
    await withMockUpstream(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    id: "chatcmpl-mock",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: { content: "안" }, finish_reason: null }],
                  })}\n\n`,
                ),
              );
              controller.error(new Error("upstream connection reset"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      async () => {
        const r = await app.fetch(chatRequest({ stream: true }), env, ctx);
        assert.equal(r.status, 200, "the stream already answered 200");
        await r.text();          // drain so the transform's finally runs
        await ctx.settle();
      },
    );
  } finally {
    console.error = quiet;
  }
  const inserts = usageInserts(env);
  assert.equal(inserts.length, 1, "an interrupted stream still writes its row");
  assert.equal(inserts[0].bindings[B_STATUS], 502, "interrupted stream is NOT recorded as 200");
  console.log("✓ #684 chat: mid-stream break → usage_log row, status=502");
}

// --- REGRESSION: a 200 turn is unchanged ------------------------------------
{
  const env = createMockEnv();
  const ctx = makeCtx();
  await withMockUpstream(
    () => Response.json(openAIJsonBody({ content: "ok", tokensIn: 3, tokensOut: 2 })),
    async () => {
      const r = await app.fetch(chatRequest(), env, ctx);
      assert.equal(r.status, 200);
      await ctx.settle();
    },
  );
  const inserts = usageInserts(env);
  assert.equal(inserts.length, 1, "exactly one row");
  assert.equal(inserts[0].bindings[B_STATUS], 200, "success still records 200");
  assert.equal(inserts[0].bindings[5], 3, "tokens_in preserved");
  assert.equal(inserts[0].bindings[6], 2, "tokens_out preserved");
  console.log("✓ #684 chat: 200 turn unchanged (status 200, tokens intact)");
}

// --- REGRESSION: a 200 /v1/messages turn is unchanged ------------------------
{
  const env = anthropicEnv();
  const ctx = makeCtx();
  await withMockUpstream(
    () => Response.json(anthropicJsonBody({ text: "ok", tokensIn: 5, tokensOut: 4 })),
    async () => {
      const r = await app.fetch(messagesRequest(), env, ctx);
      assert.equal(r.status, 200);
      await ctx.settle();
    },
  );
  const inserts = usageInserts(env);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].bindings[B_STATUS], 200);
  assert.equal(inserts[0].bindings[6], 4, "tokens_out preserved");
  console.log("✓ #684 messages: 200 turn unchanged");
}

// --- NEGATIVE CONTROL: failures must not be billed ---------------------------
//
// This is the half of #684 that can quietly cost money. It runs the PRODUCTION
// aggregation SQL (imported, not retyped) against a real SQLite database
// holding one success and two failures. Asserting on the query TEXT would only
// prove a string contains "status"; this proves the numbers.
{
  const { DatabaseSync } = await import("node:sqlite");
  const { USAGE_LAST_HOUR_SQL } = await import("../src/lib/analytics.ts");
  const { buildSql } = await import("../scripts/usage-report.mjs");

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT, cohort_id TEXT, user_id TEXT, profile_id TEXT, model TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER, status INTEGER NOT NULL, trial_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const ins = db.prepare(
    `INSERT INTO usage_log
       (cohort_id, user_id, profile_id, model, tokens_in, tokens_out, cache_read, cache_write, latency_ms, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // 1 billable success …
  ins.run(COHORT, USER, PROFILE, "m", 100, 20, 7, 3, 900, 200);
  // … and 2 failures that must NOT be billed. Non-zero token columns on the
  // failure rows are deliberate: a filter that merely relies on failures
  // carrying 0 tokens is not a filter, and would silently start billing the
  // day a partial/streaming failure records real usage.
  ins.run(COHORT, USER, PROFILE, "m", 999, 999, 999, 999, 120, 429);
  ins.run(COHORT, USER, PROFILE, "m", 999, 999, 999, 999, 50, 502);

  // 1. /admin/stats last-hour aggregate
  const stats = db.prepare(USAGE_LAST_HOUR_SQL).get();
  assert.equal(Number(stats.tokens_in), 100, "/admin/stats bills successes only (tokens_in)");
  assert.equal(Number(stats.tokens_out), 20, "/admin/stats bills successes only (tokens_out)");
  assert.equal(Number(stats.errors), 2, "errors is no longer structurally zero");
  assert.equal(Number(stats.messages), 1, "messages counts successful turns only");
  assert.equal(Number(stats.requests), 3, "requests counts every attempt (success + failure)");

  // 2. scripts/usage-report.mjs — the operator-facing billing report
  const rows = db.prepare(buildSql({ days: 30, by: "model", cohort: null })).all();
  assert.equal(rows.length, 1, "one model dimension");
  const r = rows[0];
  assert.equal(Number(r.tokens_in), 100, "usage-report bills successes only (tokens_in)");
  assert.equal(Number(r.tokens_out), 20, "usage-report bills successes only (tokens_out)");
  assert.equal(Number(r.cache_read), 7, "usage-report bills successes only (cache_read)");
  assert.equal(Number(r.cache_write), 3, "usage-report bills successes only (cache_write)");
  assert.equal(Number(r.errors), 2, "failures are counted as errors");
  assert.equal(Number(r.requests), 1, "requests = billable (successful) turns");
  assert.equal(Number(r.avg_latency_ms), 900, "latency averaged over successes only");
  db.close();
  console.log("✓ #684 accounting: failed rows are counted as errors and NEVER billed");
}

console.log("usage-log-status.test.mjs: all tests passed");
