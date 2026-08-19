// kids-quest — 두 SK 아동 프로필(초3·4, 초5·6)이 upstream 으로 보내는 system
// prompt 에 게스트 퀘스트 스켈레톤 5개가 전부 실려 가고, "게임" 낱말이 없고,
// 스켈레톤 자리표시자 규격이 5개 모두 같은지 전체 앱을 띄워 확인한다.
//
// 왜: 2026-08-19 kids-world(미래 그리기) → kids-quest 로 갈아탔다. 프롬프트·
// 프로필·스켈레톤·tier 등록이 4곳에 흩어져 있어 하나라도 빠지면 코치가 옛
// 트랙으로 말하거나 스켈레톤 없이 처음부터 짠다.
//
// Run: node --experimental-strip-types test/kids-quest-prompt.test.mjs

import assert from "node:assert/strict";
import {
  bootApp,
  createMockEnv,
  makeCtx,
  withMockUpstream,
  openAIJsonBody,
  TEST_SECRET,
  COHORT,
  USER,
} from "./harness/index.mjs";

const app = await bootApp();
const { issue } = await import("../src/lib/tokens.ts");
const { getSkeletonsForTier } = await import("../src/skeletons/index.ts");

const PROFILES = ["sk-biopharm-kids-2026-grade-3-4-s1", "sk-biopharm-kids-2026-grade-5-6-s1"];
const SLOTS = [
  "TITLE", "GUEST_EMOJI", "GUEST_NAME", "GUEST_LINE", "PLAYER_EMOJI", "ITEM_A", "ITEM_B",
  "SPEED", "RATE", "GOAL", "SPECIAL", "BG_TOP", "BG_BOT",
];

// --- 1. 스켈레톤 5개 · 규격 동일 · hp:result 통로 --------------------------------
{
  const skels = getSkeletonsForTier("kids-quest");
  assert.deepEqual(
    skels.map((s) => s.id).sort(),
    ["kq-catcher", "kq-collect", "kq-maze", "kq-memory", "kq-runner", "kq-sort", "kq-stack", "kq-water", "kq-whack"],
    "kids-quest tier 에 kq-* 9개",
  );
  for (const s of skels) {
    for (const slot of SLOTS) {
      assert.ok(s.html.includes(`%%${slot}%%`), `${s.id}: %%${slot}%% 자리표시자`);
    }
    const found = new Set([...s.html.matchAll(/%%([A-Z_]+)%%/g)].map((m) => m[1]));
    for (const f of found) assert.ok(SLOTS.includes(f), `${s.id}: 규격 밖 자리표시자 %%${f}%%`);
    assert.ok(s.html.includes("type:'hp:result'") || s.html.includes("r.type='hp:result'"), `${s.id}: hp:result 를 보낸다`);
    assert.ok(s.html.includes("window.__hpLast=r"), `${s.id}: __hpLast 를 남긴다`);
    assert.ok(s.html.includes('id="guest"'), `${s.id}: 게스트 말풍선`);
    assert.ok(/const WORLD=\{/.test(s.html), `${s.id}: WORLD 블록`);
    assert.ok(s.html.includes('r.world=Object.assign({},WORLD)'), `${s.id}: hp:result 에 world 동봉`);
    assert.ok(!/게임/.test(s.html), `${s.id}: 화면 문구에 "게임" 없음`);
  }
  assert.equal(getSkeletonsForTier("kids-world").length, 0, "kids-world tier 는 사라졌다");
  console.log("✓ 스켈레톤 9개 · 규격 동일 · hp:result/__hpLast · 게임 낱말 없음");
}

// --- 2. 두 프로필 모두 upstream system prompt 에 라이브러리가 실린다 --------------
for (const profileId of PROFILES) {
  const { token } = await issue({ u: USER, c: COHORT, p: profileId }, 1, TEST_SECRET);
  const env = createMockEnv();
  // 하네스의 활성 세션은 3·4 프로필로 고정돼 있다 — 세션 프로필을 이 프로필로 맞춘다.
  env._kv.set(
    `cohort:${COHORT}:active_session`,
    JSON.stringify({
      session_id: "sess-kq",
      profile_id: profileId,
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      ends_at: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
  const ctx = makeCtx();
  const req = new Request("https://api.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: "hypeproof-default",
      stream: false,
      messages: [{ role: "user", content: "🐕 초코 얘기 들려줘" }],
    }),
  });
  await withMockUpstream(
    () => new Response(JSON.stringify(openAIJsonBody({ content: "🐕 초코: 헥헥…" })), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    async (calls) => {
      const r = await app.fetch(req, env, ctx);
      assert.equal(r.status, 200, `${profileId}: 200`);
      await ctx.settle();
      const up = calls.find((c) => c.init?.body);
      assert.ok(up, `${profileId}: upstream 호출이 있다`);
      const body = JSON.parse(String(up.init.body));
      const sys = JSON.stringify(body.system ?? body.messages ?? body);
      assert.ok(sys.includes("게스트의 세상 스켈레톤 라이브러리"), `${profileId}: 라이브러리 인트로`);
      for (const id of ["kq-catcher", "kq-runner", "kq-collect", "kq-stack", "kq-maze", "kq-whack", "kq-memory", "kq-water", "kq-sort"]) {
        assert.ok(sys.includes(`스켈레톤: ${id}`), `${profileId}: ${id} 실림`);
      }
      assert.ok(sys.includes("초코") && sys.includes("뽀로") && sys.includes("라쿤"), `${profileId}: 게스트 9명 프롬프트`);
      assert.ok(!sys.includes("내가 만든 미래"), `${profileId}: 옛 트랙 문구 없음`);
      assert.ok(!sys.includes("게임 스켈레톤 라이브러리"), `${profileId}: 게임 인트로 아님`);
      // 프롬프트 본문(코치 규칙)에서 "게임" 은 금지 문구 안에서만 등장한다.
      const promptText = sys;
      const gameHits = [...promptText.matchAll(/게임/g)].length;
      const banHits = [...promptText.matchAll(/(\\?"|`)게임(\\?"|`)|게임\S{0,3}(낱말|이라는 말|프레임|어휘)|게임이 아니라/g)].length;
      assert.ok(gameHits <= banHits + 2, `${profileId}: "게임" 은 금지 문구 밖에서 거의 안 쓰인다 (${gameHits} vs ${banHits})`);
      console.log(`✓ ${profileId}: 라이브러리 9개 + 게스트 프롬프트 upstream 도달`);
    },
  );
}

console.log("kids-quest-prompt.test.mjs: all tests passed");
