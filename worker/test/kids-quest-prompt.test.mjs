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
    ["kq-catcher", "kq-collect", "kq-jump", "kq-memory", "kq-run", "kq-runner", "kq-sort", "kq-stack", "kq-whack"],
    "kids-quest tier 에 kq-* 9개",
  );
  for (const s of skels) {
    for (const slot of SLOTS) {
      assert.ok(s.html.includes(`%%${slot}%%`), `${s.id}: %%${slot}%% 자리표시자`);
    }
    const found = new Set([...s.html.matchAll(/%%([A-Z_]+)%%/g)].map((m) => m[1]));
    for (const f of found) assert.ok(SLOTS.includes(f), `${s.id}: 규격 밖 자리표시자 %%${f}%%`);
    assert.ok(s.html.includes('id="guest"'), `${s.id}: 게스트 말풍선`);
    assert.ok(/const WORLD=\{/.test(s.html), `${s.id}: WORLD 블록`);
    assert.ok(s.html.includes('<script src="engine.js"></script>'), `${s.id}: 공용 엔진 참조`);
    assert.ok(!/게임/.test(s.html), `${s.id}: 화면 문구에 "게임" 없음`);
  }
  assert.equal(getSkeletonsForTier("kids-world").length, 0, "kids-world tier 는 사라졌다");
  // #629 — 결과 통로(hp:result/__hpLast)는 공용 엔진에 한 번만 있다.
  const { renderEngine } = await import("../src/skeletons/kids-quest/worlds.ts");
  const eng = renderEngine();
  assert.ok(eng.includes("r.type='hp:result'") && eng.includes("window.__hpLast=r"), "엔진이 결과를 보낸다");
  assert.ok(/const S_CAT=/.test(eng), "엔진에 스프라이트가 있다");
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
      for (const id of ["kq-catcher", "kq-runner", "kq-collect", "kq-stack", "kq-run", "kq-whack", "kq-memory", "kq-jump", "kq-sort"]) {
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

// --- 3. 사전 완성 세상 — 9개 전부 렌더 · 자리표시자 0 · GET /v1/worlds/:id ---------------
{
  const { WORLDS, renderWorld, matchWorld } = await import("../src/skeletons/kids-quest/worlds.ts");
  assert.equal(WORLDS.length, 9, "세상 9개");
  for (const w of WORLDS) {
    const html = renderWorld(w.id);
    assert.ok(html && !/%%[A-Z_]+%%/.test(html), `${w.id}: 자리표시자 없이 렌더`);
    assert.ok(html.includes(`GUEST_NAME='${w.guest}'`), `${w.id}: 게스트 이름 채워짐`);
    assert.equal(matchWorld(w.chip)?.id, w.id, `${w.id}: 칩 문구 매칭`);
    assert.equal(matchWorld(w.chip.replace(/^\S+\s/, ""))?.id, w.id, `${w.id}: 이모지 없는 칩 문구`);
    assert.equal(matchWorld(`${w.guest} 세상 가볼래`), null, `${w.id}: 자유 문장은 전환 안 함(클릭만)`);
  }
  assert.equal(matchWorld("안녕"), null, "무관한 말은 매칭 안 됨");
  assert.equal(matchWorld("초코 색을 갈색으로 바꿔줘"), null, "바꾸기 요청은 전환 아님");
  assert.equal(matchWorld("초코 세상에 다람쥐 데려와줘"), null, "다른 세상 캐릭터 데려오기는 전환 아님 — 아이 작업을 덮어쓰지 않는다");
  assert.equal(matchWorld("다람쥐"), null, "이름만 쳐도 전환 아님(클릭만)");
  const { token } = await issue({ u: USER, c: COHORT, p: PROFILES[0] }, 1, TEST_SECRET);
  const env = createMockEnv();
  const r = await app.fetch(new Request("https://api.test/v1/worlds/kq-runner", { headers: { authorization: `Bearer ${token}` } }), env, makeCtx());
  assert.equal(r.status, 200, "worlds/kq-runner 200");
  const body = await r.text();
  assert.ok(body.includes("GUEST_NAME='나비'") && body.includes("flood:true"), "나비 세상 HTML");
  // #629 — 엔진 분리: 세상 HTML 은 engine.js 를 부르고, 스프라이트는 세상 파일에 없다.
  assert.ok(body.includes('<script src="engine.js"></script>'), "세상 HTML 이 공용 엔진을 부른다");
  assert.ok(!/const S_[A-Z]+=/.test(body), "스프라이트 맵은 세상 파일에 없다");
  assert.ok(body.length < 10_000, `세상 파일이 10KB 미만 (실제 ${body.length})`);
  const re = await app.fetch(new Request("https://api.test/v1/worlds/engine.js", { headers: { authorization: `Bearer ${token}` } }), env, makeCtx());
  assert.equal(re.status, 200, "worlds/engine.js 200");
  const engine = await re.text();
  assert.ok(/const S_CAT=/.test(engine) && /function report\(/.test(engine), "엔진에 스프라이트·report 가 있다");
  const re401 = await app.fetch(new Request("https://api.test/v1/worlds/engine.js"), env, makeCtx());
  assert.equal(re401.status, 401, "engine.js 도 토큰 필요");
  const r404 = await app.fetch(new Request("https://api.test/v1/worlds/nope", { headers: { authorization: `Bearer ${token}` } }), env, makeCtx());
  assert.equal(r404.status, 404, "unknown world 404");
  const r401 = await app.fetch(new Request("https://api.test/v1/worlds/kq-runner"), env, makeCtx());
  assert.equal(r401.status, 401, "no token 401");
  const pr = await app.fetch(new Request("https://api.test/v1/profile", { headers: { authorization: `Bearer ${token}` } }), env, makeCtx());
  const pj = await pr.json();
  assert.equal(pj.worlds?.length, 9, "profile.worlds 9개");
  console.log("✓ 사전 완성 세상 9개 렌더 · 매칭 · /v1/worlds/:id · profile.worlds");
}

// --- 4. 아동 컨텍스트 위생 — 코드 펜스 제거 · 길이 상한(뒤쪽 유지) -----------------
{
  const { trimMinorContext } = await import("../src/routes/messages.ts");
  const long = "```html\n" + "<div>x</div>\n".repeat(200) + "```";
  const t1 = trimMinorContext("앞말\n" + long + "\n뒷말");
  assert.ok(!t1.includes("<div>x</div>"), "코드 본문은 빠진다");
  assert.ok(t1.includes("index.html") && t1.includes("앞말") && t1.includes("뒷말"), "대화는 남는다");
  const t2 = trimMinorContext("A".repeat(9000) + "최근질문", 8000);
  assert.ok(t2.startsWith("[앞부분 생략]") && t2.endsWith("최근질문"), "뒤쪽(최근)을 남긴다");
  assert.ok(t2.length <= 8000 + 20, "상한이 걸린다");
  const short = "초코 세상에 가볼래";
  assert.equal(trimMinorContext(short), short, "짧은 말은 그대로");
  console.log("✓ 아동 컨텍스트 위생 — 펜스 제거·뒤쪽 유지·짧은 말 무변경");
}

// --- 5. 세상별 엔진 — 남의 세상 스프라이트가 파일에 없다 (컨텍스트 오염 차단) --------
{
  const { WORLDS, renderEngineFor } = await import("../src/skeletons/kids-quest/worlds.ts");
  const catcher = renderEngineFor("kq-catcher");
  assert.ok(catcher.includes("S_DOG") && catcher.includes("S_FIRE"), "초코 세상은 자기 그림을 갖는다");
  for (const alien of ["S_PENG", "S_ICE", "S_RAC", "S_PARROT", "S_BEE", "S_MOUSE"]) {
    assert.ok(!catcher.includes(alien), `초코 엔진에 ${alien} 이 없다 (실기기: 초코 세상에서 얼음이 나왔다)`);
  }
  for (const w of WORLDS) {
    const js = renderEngineFor(w.id);
    assert.ok(js && js.includes("function report(") && js.length < 4000, `${w.id}: 엔진 유지 + 4KB 미만`);
  }
  assert.equal(renderEngineFor("nope"), null, "모르는 세상은 null");
  console.log("✓ 세상별 엔진 — 자기 그림만, 남의 세상 없음, report 유지");
}

// --- 6. #682/#675 — 코치가 완료를 단정하지 않는다 -----------------------------------
//
// 2026-08-22 실기기: 코치가 67턴 중 66회 "다 됐어요" 라고 했다(다른 자리 53턴 중 48회).
// 화면을 볼 수 없으면서다. 아이는 같은 요청을 5번 반복했고("아니, 아직도 안 밝아!!!"),
// 다른 아이는 세상이 까맣게 죽은 걸 3번 신고한 끝에 포기했다.
//
// 원인이 중요하다 — **코치는 규칙을 어긴 게 아니라 시킨 대로 했다.** 프롬프트 73행이
// `"다 됐어요"는 코드 뒤에`, 80행 ④가 `끝나면 "다 됐어요!" 한 줄` 이라고 지시하고
// 있었다. 그래서 이 테스트의 핵심은 새 문장이 있는지가 아니라 **지시문이 사라졌는가** 다.
// 경쟁하는 규칙을 얹는 것보다 지시를 지우는 쪽이 훨씬 확실한 지렛대다.
{
  const { readFileSync } = await import("node:fs");
  const files = {
    "3-4": "src/prompts/sk-biopharm-kids-quest-3-4.md",
    "5-6": "src/prompts/sk-biopharm-kids-quest-5-6.md",
  };
  const md = Object.fromEntries(
    Object.entries(files).map(([k, p]) => [k, readFileSync(new URL(`../${p}`, import.meta.url), "utf8")]),
  );

  const HEAD = "## 다 됐다고 말하지 않습니다";
  for (const [track, s] of Object.entries(md)) {
    // (a) 지시문이 없다 — 이게 하중을 받는 단언이다.
    assert.ok(!/④끝나면 "다 됐어요!"/.test(s), `${track}: ④가 완료 문구를 더 이상 지시하지 않는다`);
    assert.ok(
      !/"다 됐어요"는 코드 \*\*뒤\*\*에/.test(s),
      `${track}: 말의 순서가 완료 문구를 더 이상 지시하지 않는다`,
    );

    // (b) 살아남은 "다 됐어요" 는 전부 금지 문맥이어야 한다 — 잔존 지시를 잡는다.
    for (const m of s.matchAll(/다 됐어요/g)) {
      const after = s.slice(m.index, m.index + 60);
      assert.ok(
        /로 끝내지 마세요|라고 단정하지 마세요/.test(after),
        `${track}: "다 됐어요" 가 금지 문맥 밖에 남아 있다 — …${after.slice(0, 40)}…`,
      );
    }

    // (c) 새 절이 정확히 한 번.
    assert.equal(s.split(HEAD).length - 1, 1, `${track}: 새 절이 정확히 한 번`);
    assert.ok(s.includes("지금 화면에"), `${track}: 확인 부탁 문구`);
    assert.ok(s.includes("손 들어서 불러 줄래요"), `${track}: 3회 반복 시 강사 호출`);

    // (d) 양성 대조군 — 너무 많이 지우지 않았다 (verification.md §2: 지배적 실패 방향).
    assert.ok(s.includes("[게스트 결과]"), `${track}: 결과 반응 규칙 유지`);
    assert.ok(s.includes("report()"), `${track}: report() 계약 유지`);
  }

  // (e) 두 트랙이 바이트 동일 — 한쪽만 손보고 갈라지는 것을 막는다.
  const cut = (s) => s.slice(s.indexOf(HEAD), s.indexOf("## 엔진 치트시트"));
  assert.equal(cut(md["3-4"]), cut(md["5-6"]), "새 절이 두 트랙에서 바이트 동일");

  console.log("✓ #682: 완료 단정 지시문 제거 + 확인 요청 규칙 (두 트랙 동일)");
}

// --- 7. #675 — 검색 턴이 화면에 착지해야 하고, 크기 상한이 있다 ---------------------
{
  const { readFileSync } = await import("node:fs");
  const disc = readFileSync(new URL("../src/prompts/_web-search-discipline.md", import.meta.url), "utf8");
  assert.ok(disc.includes("찾은 턴에도 화면은 바뀌어야"), "검색 턴 착지 의무");
  assert.ok(disc.includes("검색 한 번 + 고치기 한두 곳"), "턴 크기 상한");

  // 이 파일의 게이트는 트랙이 아니라 `tools.web_search` 다(translate.ts:486). 보아치과
  // **성인** 코호트 둘도 이 문단을 받는다. 기존 본문은 이미 아동 어휘로 쓰여 있고(그건
  // 별건 — 아래 이슈), 최소한 **새로 넣는 규칙이 그 부채를 키우지는 않게** 못 박는다.
  const added = disc.slice(disc.indexOf("찾은 턴에도 화면은 바뀌어야"));
  for (const kidWord of ["아이", "게스트", "세상"]) {
    assert.ok(
      !added.includes(kidWord),
      `새 규칙에 아동 어휘 '${kidWord}' 가 없다 — 성인 코호트도 이 파일을 받는다`,
    );
  }
  console.log("✓ #675: 검색 턴 착지 의무 + 크기 상한, 어휘 중립 유지");
}
