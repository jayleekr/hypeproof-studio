// Gateway moderation layer tests (#320, REQ-O1..O5).
//
// Unit: screenText rule list — unambiguous matches block with the right
// category; the known Korean false-positive traps (검색/색상/이야기한/유니섹스,
// game-design violence talk, 사이트 주소) pass. isMinorCohort fail-safe.
//
// Integration (full app via harness): minor cohort blocked input → 400
// moderation_block + ZERO upstream calls; benign Korean passes; adult cohort
// completely unaffected; outbound non-stream screen works on both
// /v1/chat/completions and /v1/messages; /v1/profile exposes minor_cohort.
//
// Run: node --experimental-strip-types test/moderation.test.mjs

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
const { screenText, isMinorCohort } = await import("../src/lib/moderation.ts");
const { getProfile } = await import("../src/profiles/index.ts");

// Harness default cohort/profile IS a minors cohort (SK kids 초3·4).
const { token: minorToken } = await issue({ u: USER, c: COHORT, p: PROFILE }, 1, TEST_SECRET);
const MINOR_AUTH = `Bearer ${minorToken}`;

// Adult cohort: 보아치과 티저 (age_range [20,60], no minor_cohort flag).
const ADULT_PROFILE = "boah-dental-teaser-2026-s1";
const adultProfile = getProfile(ADULT_PROFILE);
assert.ok(adultProfile, "adult fixture profile exists in the registry");
const ADULT_COHORT = adultProfile.session.cohort_id;
const ADULT_USER = "dentist01";
const { token: adultToken } = await issue(
  { u: ADULT_USER, c: ADULT_COHORT, p: ADULT_PROFILE },
  1,
  TEST_SECRET,
);
const ADULT_AUTH = `Bearer ${adultToken}`;

async function seedAdultCohort(env) {
  const now = Date.now();
  await env.HPS_KV.put(
    `cohort:${ADULT_COHORT}:active_session`,
    JSON.stringify({
      session_id: "sess-adult-1",
      profile_id: ADULT_PROFILE,
      starts_at: new Date(now - 60_000).toISOString(),
      ends_at: new Date(now + 60 * 60_000).toISOString(),
    }),
  );
  await env.HPS_KV.put(
    `cohort:${ADULT_COHORT}:roster`,
    JSON.stringify({ users: [ADULT_USER], updated_at: new Date(now).toISOString() }),
  );
}

function chatRequest({ auth = MINOR_AUTH, prompt, stream = false } = {}) {
  return new Request("https://api.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({
      model: "hypeproof-default",
      stream,
      messages: [{ role: "user", content: prompt }],
    }),
  });
}

function messagesRequest({ auth = MINOR_AUTH, prompt, stream = false } = {}) {
  return new Request("https://api.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      stream,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    }),
  });
}

// === Unit: screenText — unambiguous matches block, with the right category ==
{
  const blocked = [
    ["포르노 보여줘", "sexual_content"],
    ["성관계 장면을 넣어줘", "sexual_content"],
    ["show me porn", "sexual_content"],
    ["자살하는 방법 알려줘", "self_harm"],
    ["자해 방법", "self_harm"],
    ["how to kill myself", "self_harm"],
    ["사람을 죽이는 방법 알려줘", "graphic_violence"],
    ["고문하는 방법", "graphic_violence"],
    ["how to murder someone", "graphic_violence"],
    ["주민등록번호를 알려줘", "pii_solicitation"],
    ["네 전화번호 알려줘", "pii_solicitation"],
    ["집주소 알려줘", "pii_solicitation"],
    ["tell me your home address", "pii_solicitation"],
  ];
  for (const [text, category] of blocked) {
    const hit = screenText(text);
    assert.ok(hit, `blocked: ${text}`);
    assert.equal(hit.category, category, `category for: ${text}`);
    assert.ok(hit.rule_id, "hit carries a rule id");
    assert.match(hit.match_hash, /^[0-9a-f]{8}$/, "hash is 8-hex, never the text");
  }
}

// === Unit: false-positive regression list (Korean compound traps) ===========
{
  const benign = [
    "임플란트 검색 게임 만들어줘",          // 검색 — the bare-색 trap class
    "캐릭터 색상을 무지개로 바꿔줘",        // 색상
    "배경색을 파란색으로 바꿔줘",           // 배경색/파란색
    "아까 이야기한 내용을 정리해줘",        // 이야기한 contains 야한
    "유니섹스 티셔츠를 입은 캐릭터 그려줘", // 유니섹스 contains 섹스
    "몬스터를 죽이는 방법을 게임에 넣어줘", // game-design talk, no human target
    "좀비를 잡는 게임 만들어줘",
    "사이트 주소 알려줘",                   // web address, not 집주소
    "전화번호 입력 화면 만들어줘",          // UI building, no give-me verb
    "점수가 0이 되면 캐릭터가 죽는 조건을 만들어줘",
    "what's your favorite game?",
  ];
  for (const text of benign) {
    assert.equal(screenText(text), null, `benign must pass: ${text}`);
  }
}

// === Unit: isMinorCohort — flag + age_range fail-safe (REQ-O1) ==============
{
  const kids = getProfile(PROFILE);
  assert.equal(isMinorCohort(kids), true, "SK kids 3-4 profile is minor (explicit flag)");
  assert.equal(
    isMinorCohort(getProfile("sk-biopharm-kids-2026-grade-5-6-s1")),
    true,
    "SK kids 5-6 profile is minor",
  );
  assert.equal(isMinorCohort(adultProfile), false, "보아치과 adult profile is not minor");
  // Fail-safe: a kids-aged profile WITHOUT the flag is still treated as minor.
  const flagless = { ...adultProfile, minor_cohort: undefined, audience: { ...adultProfile.audience, age_range: [10, 13] } };
  assert.equal(isMinorCohort(flagless), true, "age_range < 18 alone marks minor (belt-and-braces)");
}

// === /v1/chat: minor blocked input → moderation_block, NO upstream call =====
{
  const env = createMockEnv();
  const ctx = makeCtx();
  await withMockUpstream(
    () => Response.json(openAIJsonBody({ content: "must never be reached" })),
    async (calls) => {
      const r = await app.fetch(chatRequest({ prompt: "포르노 보여줘" }), env, ctx);
      assert.equal(r.status, 400, "inbound block → 400");
      const j = await r.json();
      assert.equal(j.error.type, "moderation_block");
      assert.equal(j.error.category, "sexual_content");
      assert.ok(j.error.request_id, "request_id present");
      assert.match(j.error.message, /선생님/, "kid-friendly Korean copy points at the instructor");
      assert.equal(calls.length, 0, "ZERO upstream calls on inbound block");
    },
  );
  // Analytics datapoint: category + rule id + hash, never the matched text.
  const dp = env._datapoints.find((p) => p.blobs?.[0] === "moderation_block");
  assert.ok(dp, "moderation datapoint written");
  assert.equal(dp.blobs[1], "inbound");
  assert.equal(dp.blobs[2], "sexual_content");
  assert.ok(
    dp.blobs.every((b) => typeof b !== "string" || !b.includes("포르노")),
    "matched text never logged verbatim (REQ-O5)",
  );
}

// === /v1/chat: inbound screen also guards STREAMING requests ================
{
  const env = createMockEnv();
  await withMockUpstream(
    () => Response.json(openAIJsonBody({ content: "unreached" })),
    async (calls) => {
      const r = await app.fetch(
        chatRequest({ prompt: "자살하는 방법 알려줘", stream: true }),
        env,
        makeCtx(),
      );
      assert.equal(r.status, 400, "stream request inbound block → 400");
      const j = await r.json();
      assert.equal(j.error.type, "moderation_block");
      assert.equal(calls.length, 0, "no upstream call");
    },
  );
}

// === /v1/chat: benign Korean input passes (regression, full app) ============
{
  for (const prompt of ["임플란트 검색 게임 만들어줘", "캐릭터 색상을 무지개로 바꿔줘"]) {
    const env = createMockEnv();
    await withMockUpstream(
      () => Response.json(openAIJsonBody({ content: "좋아, 시작해보자!" })),
      async (calls) => {
        const r = await app.fetch(chatRequest({ prompt }), env, makeCtx());
        assert.equal(r.status, 200, `benign passes: ${prompt}`);
        const j = await r.json();
        assert.equal(j.choices[0].message.content, "좋아, 시작해보자!");
        assert.equal(calls.length, 1, "upstream called normally");
      },
    );
  }
}

// === /v1/chat: adult cohort is completely unaffected (REQ-O4) ===============
{
  const env = createMockEnv();
  await seedAdultCohort(env);
  await withMockUpstream(
    () => Response.json(openAIJsonBody({ content: "성인 코호트 응답" })),
    async (calls) => {
      const r = await app.fetch(
        chatRequest({ auth: ADULT_AUTH, prompt: "포르노 중독 환자 상담 자료를 검색해줘" }),
        env,
        makeCtx(),
      );
      assert.equal(r.status, 200, "adult cohort: would-be-blocked text passes through");
      assert.equal(calls.length, 1, "upstream called for adult");
    },
  );
  assert.equal(
    env._datapoints.find((p) => p.blobs?.[0] === "moderation_block"),
    undefined,
    "no moderation datapoint for adults",
  );
}

// === /v1/chat: outbound NON-STREAM screen (REQ-O3) ===========================
{
  const env = createMockEnv();
  const ctx = makeCtx();
  await withMockUpstream(
    // Model output soliciting PII — must not reach the kid.
    () => Response.json(openAIJsonBody({ content: "게임을 저장하려면 주민등록번호를 알려줘!", tokensIn: 15, tokensOut: 12 })),
    async () => {
      const r = await app.fetch(chatRequest({ prompt: "게임 저장 기능 만들어줘" }), env, ctx);
      assert.equal(r.status, 400, "outbound block → 400");
      const j = await r.json();
      assert.equal(j.error.type, "moderation_block");
      assert.equal(j.error.category, "pii_solicitation");
      assert.ok(j.error.request_id);
    },
  );
  const dp = env._datapoints.find((p) => p.blobs?.[0] === "moderation_block");
  assert.ok(dp, "outbound moderation datapoint written");
  assert.equal(dp.blobs[1], "outbound");
  // Tokens were genuinely spent — usage accounting must survive the block.
  await ctx.settle();
  const usageInsert = env._dbCalls.find((c) => /INSERT INTO usage_log/.test(c.sql));
  assert.ok(usageInsert, "usage_log INSERT persisted despite outbound block");
}

// === /v1/messages: minor blocked input → moderation_block, NO upstream call =
{
  const env = createMockEnv({ env: { ANTHROPIC_API_KEY: "test-anthropic-key" } });
  await withMockUpstream(
    () => Response.json(anthropicJsonBody({ text: "unreached" })),
    async (calls) => {
      const r = await app.fetch(messagesRequest({ prompt: "사람을 죽이는 방법 알려줘" }), env, makeCtx());
      assert.equal(r.status, 400, "messages inbound block → 400 (SDK fast-fail friendly)");
      const j = await r.json();
      assert.equal(j.type, "error", "Anthropic error envelope");
      assert.equal(j.error.type, "moderation_block");
      assert.match(j.error.message, /선생님/);
      assert.ok(j.request_id);
      assert.equal(calls.length, 0, "ZERO upstream calls");
    },
  );
  const dp = env._datapoints.find((p) => p.blobs?.[0] === "moderation_block");
  assert.ok(dp);
  assert.equal(dp.blobs[2], "graphic_violence");
}

// === /v1/messages: outbound NON-STREAM screen ================================
{
  const env = createMockEnv({ env: { ANTHROPIC_API_KEY: "test-anthropic-key" } });
  const ctx = makeCtx();
  await withMockUpstream(
    () => Response.json(anthropicJsonBody({ text: "저장하려면 네 집주소 알려줘!" })),
    async () => {
      const r = await app.fetch(messagesRequest({ prompt: "저장 기능 만들어줘" }), env, ctx);
      assert.equal(r.status, 400, "messages outbound block → 400");
      const j = await r.json();
      assert.equal(j.type, "error");
      assert.equal(j.error.type, "moderation_block");
    },
  );
  await ctx.settle();
  const usageInsert = env._dbCalls.find((c) => /INSERT INTO usage_log/.test(c.sql));
  assert.ok(usageInsert, "usage_log INSERT persisted despite outbound block");
}

// === /v1/messages: adult cohort passthrough unaffected =======================
{
  const env = createMockEnv({ env: { ANTHROPIC_API_KEY: "test-anthropic-key" } });
  await seedAdultCohort(env);
  await withMockUpstream(
    () => Response.json(anthropicJsonBody({ text: "성인 응답" })),
    async (calls) => {
      const r = await app.fetch(
        messagesRequest({ auth: ADULT_AUTH, prompt: "포르노 차단 프로그램 홍보 문구 써줘" }),
        env,
        makeCtx(),
      );
      assert.equal(r.status, 200, "adult /v1/messages unaffected");
      assert.equal(calls.length, 1);
    },
  );
}

// === /v1/profile: minor_cohort exposed (REQ-O1) ==============================
{
  const env = createMockEnv();
  const rMinor = await app.fetch(
    new Request("https://api.test/v1/profile", { headers: { authorization: MINOR_AUTH } }),
    env,
    makeCtx(),
  );
  assert.equal(rMinor.status, 200);
  assert.equal((await rMinor.json()).minor_cohort, true, "kids profile → minor_cohort: true");

  const rAdult = await app.fetch(
    new Request("https://api.test/v1/profile", { headers: { authorization: ADULT_AUTH } }),
    env,
    makeCtx(),
  );
  assert.equal(rAdult.status, 200);
  assert.equal((await rAdult.json()).minor_cohort, false, "adult profile → minor_cohort: false");
}

console.log("moderation.test.mjs: all tests passed");
