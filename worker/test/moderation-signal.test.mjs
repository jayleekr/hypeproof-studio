// dag task L — an outbound-blocked turn must not render as a healthy seat,
// and the tokens it really spent must not be written off.
//
// ## The defect
//
// `USAGE_BILLABLE = "status < 400"` made ONE column answer TWO unrelated
// questions: *did we spend money* (billing) and *did this turn help the
// student* (the instructor board, #674). Outbound moderation is where the two
// answers diverge, and there they conflicted:
//
//   chat.ts / messages.ts called `record(mkLog(...))` with the DEFAULT 200
//   before the outbound screen, then returned 400. So a child whose every turn
//   was refused emitted a normal-cadence stream of billable 200s carrying real
//   tokens — rendering as one of the MORE active seats on the board. An
//   instructor scanning for red walks straight past the one lesson that is
//   completely broken. That is exactly the failure #684 exists to eliminate,
//   surviving on one of the two moderation paths (inbound has always written
//   400/MODERATION_BLOCK).
//
// Jay settled the fix 2026-09-04: option (c), decouple the predicates. Bill on
// "were tokens spent"; judge health on status.
//
// ## Planted controls in this file
//
//   POSITIVE  An OUTBOUND-blocked turn is distinguishable from a completed
//             turn in D1 ALONE — status 400 / MODERATION_BLOCK — without
//             consulting Analytics Engine, which is not the per-seat ledger.
//             On pre-L code the row is a status-200 row, so this MUST fail
//             before the change.
//   NEGATIVE  The genuinely-spent tokens are NOT silently zeroed to make the
//             board look right: they stay on the row, and they stay BILLED.
//             Failure rows are seeded with NON-ZERO tokens throughout, so a
//             predicate that only "works" because blocked turns happen to
//             carry 0 tokens cannot pass here.
//   ALSO      Inbound and outbound render as the SAME seat state. The student
//             experience is identical: "I typed something and the coach
//             refused me." Today NEITHER direction is asserted anywhere.
//
// The board/billing halves are proven by executing the PRODUCTION SQL
// (imported, never retyped) against a real SQLite database — asserting on
// query text would only prove a string contains "status".
//
// Run: node --experimental-strip-types test/moderation-signal.test.mjs

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

const { ERROR_KIND, USAGE_BILLABLE, USAGE_LAST_HOUR_SQL } = await import("../src/lib/analytics.ts");

// usage_log INSERT binding order (lib/analytics.ts persistUsage):
//   0 session_id · 1 cohort_id · 2 user_id · 3 profile_id · 4 model
//   5 tokens_in · 6 tokens_out · 7 cache_read · 8 cache_write
//   9 latency_ms · 10 status
const B_TIN = 5;
const B_TOUT = 6;
const B_CREAD = 7;
const B_CWRITE = 8;
const B_STATUS = 10;

// logChat blobs (lib/analytics.ts): [user_id, profile_id, model, status, error_kind]
const D_STATUS = 3;
const D_ERROR_KIND = 4;

// The harness default cohort/profile IS a minors cohort (SK kids 초3·4), so
// both moderation directions are live on it.
const PII_SOLICITATION_OUT = "게임을 저장하려면 주민등록번호를 알려줘!";
const VIOLENT_PROMPT_IN = "사람을 죽이는 방법 알려줘";

function usageInserts(env) {
  return env._dbCalls.filter((c) => /INSERT INTO usage_log/.test(c.sql));
}

function chatDatapoint(env) {
  // The chat datapoint, not the #320 moderation datapoint (blobs[0] discriminator).
  return env._datapoints.find((p) => p.blobs?.[0] !== "moderation_block");
}

function chatRequest(body = {}) {
  return new Request("https://api.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: AUTH },
    body: JSON.stringify({
      model: "hypeproof-default",
      stream: false,
      messages: [{ role: "user", content: "게임 저장 기능 만들어줘" }],
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
      messages: [{ role: "user", content: "저장 기능 만들어줘" }],
      ...body,
    }),
  });
}

function anthropicEnv() {
  return createMockEnv({ env: { ANTHROPIC_API_KEY: "test-anthropic-key" } });
}

/** One outbound-blocked turn on a route; returns the observed row + datapoint. */
async function runOutboundBlock({ env, request, upstream }) {
  const ctx = makeCtx();
  await withMockUpstream(upstream, async () => {
    const r = await app.fetch(request, env, ctx);
    assert.equal(r.status, 400, "outbound block still answers the client 400");
    await ctx.settle();
  });
  const inserts = usageInserts(env);
  assert.equal(inserts.length, 1, "exactly one usage_log row for the blocked turn");
  return { row: inserts[0].bindings, dp: chatDatapoint(env) };
}

/** One inbound-blocked turn; upstream must never be called. */
async function runInboundBlock({ env, request }) {
  const ctx = makeCtx();
  await withMockUpstream(
    () => Response.json(openAIJsonBody({ content: "unreached" })),
    async (calls) => {
      const r = await app.fetch(request, env, ctx);
      assert.equal(r.status, 400, "inbound block answers 400");
      assert.equal(calls.length, 0, "inbound block never reaches upstream");
      await ctx.settle();
    },
  );
  const inserts = usageInserts(env);
  assert.equal(inserts.length, 1, "exactly one usage_log row for the blocked turn");
  return { row: inserts[0].bindings, dp: chatDatapoint(env) };
}

// === POSITIVE CONTROL 1: /v1/chat outbound block is visible in D1 ============
//
// Pre-L this row was status 200 — indistinguishable, in the ledger the board
// reads, from a turn that helped the student.
{
  const { row, dp } = await runOutboundBlock({
    env: createMockEnv(),
    request: chatRequest(),
    upstream: () =>
      Response.json(
        openAIJsonBody({ content: PII_SOLICITATION_OUT, tokensIn: 15, tokensOut: 12 }),
      ),
  });
  assert.equal(row[B_STATUS], 400, "chat outbound block writes status 400, NOT 200");
  assert.equal(dp.blobs[D_STATUS], "400", "analytics datapoint carries the same status");
  assert.equal(
    dp.blobs[D_ERROR_KIND],
    ERROR_KIND.MODERATION_BLOCK,
    "coarse failure class is moderation_block",
  );
  // NEGATIVE CONTROL: the spend is not erased to make the board look right.
  assert.equal(row[B_TIN], 15, "genuinely-spent tokens_in stay on the row");
  assert.equal(row[B_TOUT], 12, "genuinely-spent tokens_out stay on the row");
  console.log("✓ L chat: outbound block → status 400 + moderation_block, tokens intact");
}

// === POSITIVE CONTROL 2: /v1/messages outbound block is visible in D1 ========
{
  const { row, dp } = await runOutboundBlock({
    env: anthropicEnv(),
    request: messagesRequest(),
    upstream: () =>
      Response.json(
        anthropicJsonBody({
          text: "저장하려면 네 집주소 알려줘!",
          tokensIn: 21,
          tokensOut: 9,
          cacheRead: 4,
          cacheCreate: 2,
        }),
      ),
  });
  assert.equal(row[B_STATUS], 400, "messages outbound block writes status 400, NOT 200");
  assert.equal(dp.blobs[D_STATUS], "400");
  assert.equal(dp.blobs[D_ERROR_KIND], ERROR_KIND.MODERATION_BLOCK);
  assert.equal(row[B_TIN], 21, "tokens_in preserved");
  assert.equal(row[B_TOUT], 9, "tokens_out preserved");
  assert.equal(row[B_CREAD], 4, "cache_read preserved");
  assert.equal(row[B_CWRITE], 2, "cache_write preserved");
  console.log("✓ L messages: outbound block → status 400 + moderation_block, tokens intact");
}

// === ALSO: both directions render as the SAME seat state =====================
//
// The student experience is identical — "I typed something and the coach
// refused me" — so the row the board reads must be identical too. Today
// NEITHER direction is asserted anywhere; this is the first pin on both.
{
  const chatIn = await runInboundBlock({
    env: createMockEnv(),
    request: chatRequest({ messages: [{ role: "user", content: VIOLENT_PROMPT_IN }] }),
  });
  const messagesIn = await runInboundBlock({
    env: anthropicEnv(),
    request: messagesRequest({ messages: [{ role: "user", content: VIOLENT_PROMPT_IN }] }),
  });
  const chatOut = await runOutboundBlock({
    env: createMockEnv(),
    request: chatRequest(),
    upstream: () =>
      Response.json(openAIJsonBody({ content: PII_SOLICITATION_OUT, tokensIn: 15, tokensOut: 12 })),
  });
  const messagesOut = await runOutboundBlock({
    env: anthropicEnv(),
    request: messagesRequest(),
    upstream: () =>
      Response.json(anthropicJsonBody({ text: "저장하려면 네 집주소 알려줘!", tokensIn: 21, tokensOut: 9 })),
  });

  for (const [name, r] of [
    ["chat inbound", chatIn],
    ["messages inbound", messagesIn],
    ["chat outbound", chatOut],
    ["messages outbound", messagesOut],
  ]) {
    assert.equal(r.row[B_STATUS], 400, `${name}: same seat state (status 400)`);
    assert.equal(
      r.dp.blobs[D_ERROR_KIND],
      ERROR_KIND.MODERATION_BLOCK,
      `${name}: same seat state (moderation_block)`,
    );
  }
  // The directions differ ONLY in what they cost, which is the honest part.
  assert.equal(chatIn.row[B_TIN] + chatIn.row[B_TOUT], 0, "inbound block spends nothing");
  assert.equal(messagesIn.row[B_TIN] + messagesIn.row[B_TOUT], 0, "inbound block spends nothing");
  assert.ok(chatOut.row[B_TIN] + chatOut.row[B_TOUT] > 0, "outbound block really spent tokens");
  assert.ok(messagesOut.row[B_TIN] + messagesOut.row[B_TOUT] > 0, "outbound block really spent tokens");
  console.log("✓ L: inbound and outbound blocks render as the SAME seat state on both routes");
}

// === REGRESSION: an unblocked turn is untouched ==============================
{
  const env = createMockEnv();
  const ctx = makeCtx();
  await withMockUpstream(
    () => Response.json(openAIJsonBody({ content: "같이 만들어보자!", tokensIn: 3, tokensOut: 2 })),
    async () => {
      const r = await app.fetch(chatRequest(), env, ctx);
      assert.equal(r.status, 200);
      await ctx.settle();
    },
  );
  const inserts = usageInserts(env);
  assert.equal(inserts.length, 1, "exactly one row");
  assert.equal(inserts[0].bindings[B_STATUS], 200, "healthy turn still records 200");
  assert.equal(chatDatapoint(env).blobs[D_ERROR_KIND], "", "no failure class on a healthy turn");
  console.log("✓ L chat: healthy turn unchanged");
}

{
  const env = anthropicEnv();
  const ctx = makeCtx();
  await withMockUpstream(
    () => Response.json(anthropicJsonBody({ text: "좋아, 같이 해보자!", tokensIn: 5, tokensOut: 4 })),
    async () => {
      const r = await app.fetch(messagesRequest(), env, ctx);
      assert.equal(r.status, 200);
      await ctx.settle();
    },
  );
  const inserts = usageInserts(env);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].bindings[B_STATUS], 200, "healthy turn still records 200");
  console.log("✓ L messages: healthy turn unchanged");
}

// === BOARD + BILLING: the two answers, each independently correct ============
//
// Executes the PRODUCTION aggregation SQL against a real SQLite DB. Every
// failure row here carries NON-ZERO tokens on purpose (the technique
// usage-log-status.test.mjs established): a predicate that only works because
// blocked turns happen to have 0 tokens is not a predicate.
{
  const { DatabaseSync } = await import("node:sqlite");

  // One DB per seat, so the PRODUCTION SQL runs VERBATIM — no injected WHERE
  // clause. A rewritten query is a different instrument (rules/verification.md).
  const seatStats = (status) => {
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
    // Same cadence, same token weight on both seats — the ONLY difference is
    // the observed status. That is what makes this a control: if the board
    // still cannot tell them apart, nothing else in the row can save it.
    for (let i = 0; i < 3; i++) ins.run(COHORT, USER, PROFILE, "m", 100, 50, 10, 5, 800, status);
    const out = db.prepare(USAGE_LAST_HOUR_SQL).get();
    db.close();
    return out;
  };

  // --- BOARD: seat A must NOT render as healthy, using D1 alone -------------
  // Seat A: every turn blocked on the OUTBOUND path (real tokens spent,
  // nothing useful delivered). Seat B: a child doing fine.
  const a = seatStats(400);
  const b = seatStats(200);
  assert.equal(Number(a.requests), 3, "seat A: three attempts");
  assert.equal(Number(a.messages), 0, "seat A renders as ZERO healthy turns");
  assert.equal(Number(a.errors), 3, "seat A renders as three errors");
  assert.equal(Number(b.messages), 3, "seat B renders as three healthy turns");
  assert.equal(Number(b.errors), 0, "seat B renders as zero errors");
  assert.notEqual(
    Number(a.messages),
    Number(b.messages),
    "the broken seat and the fine seat are DISTINGUISHABLE in D1 alone",
  );

  // --- BILLING: seat A's spend is still on the books ------------------------
  assert.equal(Number(a.tokens_in), 300, "seat A's genuinely-spent tokens are billed");
  assert.equal(Number(a.tokens_out), 150, "seat A's genuinely-spent tokens are billed");
  assert.equal(
    Number(a.tokens_in),
    Number(b.tokens_in),
    "billing does not care that seat A failed — the money was spent either way",
  );
  console.log("✓ L board: an all-outbound-blocked seat renders broken, and is still billed");
}

// === BILLING PREDICATE: what USAGE_BILLABLE now means ========================
//
// "were tokens spent", NOT "status < 400". Proven both ways: a FAILED turn
// that cost money IS billed; a failed turn that cost nothing is NOT — and the
// latter falls out of arithmetic, not a status filter.
{
  const { DatabaseSync } = await import("node:sqlite");
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
  // 1. healthy turn — billed
  ins.run(COHORT, USER, PROFILE, "m", 100, 20, 7, 3, 900, 200);
  // 2. outbound moderation block — FAILED but upstream charged us → billed
  ins.run(COHORT, USER, PROFILE, "m", 40, 10, 2, 1, 700, 400);
  // 3. mid-stream interruption — FAILED but the partial tokens were spent →
  //    billed. Task B excluded these; task L deliberately puts them back.
  ins.run(COHORT, USER, PROFILE, "m", 60, 30, 1, 1, 300, 502);
  // 4. inbound moderation block — never reached upstream, zero cost
  ins.run(COHORT, USER, PROFILE, "m", 0, 0, 0, 0, 20, 400);
  // 5. upstream 429 — never produced tokens, zero cost
  ins.run(COHORT, USER, PROFILE, "m", 0, 0, 0, 0, 120, 429);

  const billed = db
    .prepare(`SELECT COUNT(*) AS n FROM usage_log WHERE ${USAGE_BILLABLE}`)
    .get();
  assert.equal(Number(billed.n), 3, "exactly the three token-spending rows are billable");

  const stats = db.prepare(USAGE_LAST_HOUR_SQL).get();
  assert.equal(Number(stats.tokens_in), 200, "/admin/stats bills 100+40+60 (spend, not success)");
  assert.equal(Number(stats.tokens_out), 60, "/admin/stats bills 20+10+30");
  assert.equal(Number(stats.requests), 5, "requests = every attempt");
  assert.equal(Number(stats.messages), 1, "messages = HEALTHY turns only (status)");
  assert.equal(Number(stats.errors), 4, "errors = failed turns (status)");
  assert.equal(
    Number(stats.messages) + Number(stats.errors),
    Number(stats.requests),
    "health columns still partition the attempts",
  );

  const rows = db.prepare(buildSql({ days: 30, by: "model", cohort: null })).all();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(Number(r.tokens_in), 200, "usage-report bills spend, not success (tokens_in)");
  assert.equal(Number(r.tokens_out), 60, "usage-report bills spend, not success (tokens_out)");
  assert.equal(Number(r.cache_read), 10, "cache_read: 7+2+1");
  assert.equal(Number(r.cache_write), 5, "cache_write: 3+1+1");
  assert.equal(Number(r.requests), 1, "usage-report requests = healthy turns (status)");
  assert.equal(Number(r.errors), 4, "usage-report errors = failed turns (status)");
  assert.equal(Number(r.avg_latency_ms), 900, "latency still averaged over healthy turns only");

  // The half that can quietly cost money in the OTHER direction: nothing that
  // was never spent may be billed. Rows 4 and 5 carry status 400/429 AND zero
  // tokens, so they contribute nothing — by arithmetic.
  const unspent = db
    .prepare(`SELECT COUNT(*) AS n FROM usage_log WHERE ${USAGE_BILLABLE} AND tokens_in = 0 AND tokens_out = 0`)
    .get();
  assert.equal(Number(unspent.n), 0, "no zero-cost turn is ever billed");
  console.log("✓ L billing: USAGE_BILLABLE = tokens spent — failed-but-charged in, zero-cost out");
  db.close();
}

console.log("moderation-signal.test.mjs: all tests passed");
