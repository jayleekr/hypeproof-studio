// #687 — 모델 게이트가 파라미터를 통째로 죽이지 않는지, 그리고 "미확인"이 다시
// "미지원"으로 위장하지 않는지 잠근다.
//
// 원래 모양은 `{ param: "output_config", supportedBy: [] }` 였다. 빈 배열은 두 가지를
// 동시에 뜻했다 — "어떤 모델도 안 받는다" 와 "아무도 확인 안 했다". 그래서 미성년
// effort 가 상류에 한 번도 도달하지 못했고, 2026-08-19 의 `low` 와 2026-08-20 의
// `medium` 두 번의 튜닝이 전부 닫힌 채널을 놓고 이뤄졌다. 아이들은 내내 Sonnet 4.6
// 기본값 "high" 로 돌았다.
//
// 진짜 제약은 파라미터가 아니라 **레벨**이었다: sonnet-4-6 은 low|medium|high|max 를
// 받고 xhigh 에서만 400 인데, 2026-07-24 프로브가 하필 xhigh 를 보냈다.
//
// 실행: node --experimental-strip-types test/model-gated-params.test.mjs

import assert from "node:assert/strict";

const { stripModelGatedParams, MINOR_EFFORT } = await import("../src/lib/model-caps.ts");
const { MODEL_MAP } = await import("../src/profiles/types.ts");

const FAST = MODEL_MAP["hypeproof-fast"];       // claude-haiku-4-5
const DEFAULT = MODEL_MAP["hypeproof-default"]; // claude-sonnet-4-6
const STRONG = MODEL_MAP["hypeproof-strong"];   // claude-opus-4-7

// --- 1. 미성년 effort 가 살아서 나간다 (이 수정의 본체) --------------------------
{
  const r = stripModelGatedParams({ output_config: { effort: MINOR_EFFORT } }, DEFAULT);
  assert.deepEqual(
    r.body.output_config,
    { effort: MINOR_EFFORT },
    `${DEFAULT}: 미성년 effort 가 그대로 상류로 가야 한다`,
  );
  assert.deepEqual(r.dropped, [], "정상 레벨은 아무것도 떨어뜨리지 않는다");
  console.log("✓ 미성년 effort 가 기본 핀에서 살아남는다");
}

// --- 2. Haiku 는 effort 를 아예 안 받는다 (순진한 수정이 만드는 사고) -------------
//
// resolveMessagesModel 이 /claude-.*haiku/ 요청을 fast 핀으로 보낸다 — CLI 의 보조
// 호출이 그리로 간다. 미성년 주입은 **프로필** 기준이라 모델과 무관하게 붙으므로,
// supportedBy 에 sonnet-4-6 만 추가하는 수정은 보조 호출을 전부 400 으로 만든다.
{
  const r = stripModelGatedParams({ output_config: { effort: MINOR_EFFORT } }, FAST);
  assert.equal(r.body.output_config, undefined, `${FAST}: effort 가 제거돼야 한다`);
  assert.equal(r.dropped.length, 1, "제거를 한 건으로 보고한다");
  assert.match(r.dropped[0], /effort/, "무엇을 왜 뺐는지 이름이 남는다");
  console.log("✓ Haiku 보조 호출에서 effort 가 제거된다 (400 방지)");
}

// --- 3. 레벨 단위 강등 — 파라미터를 죽이지 않는다 --------------------------------
{
  const r = stripModelGatedParams({ output_config: { effort: "xhigh" } }, DEFAULT);
  assert.deepEqual(
    r.body.output_config,
    { effort: "high" },
    `${DEFAULT}: xhigh 는 400 이므로 바로 아래 high 로 내린다`,
  );
  assert.match(r.dropped[0], /xhigh→high/, "강등 사실이 로그에 남는다");

  const strong = stripModelGatedParams({ output_config: { effort: "xhigh" } }, STRONG);
  assert.deepEqual(strong.body.output_config, { effort: "xhigh" }, `${STRONG}: xhigh 를 받는다`);
  console.log("✓ xhigh 는 4.6 에서 강등, 4.7 에서는 통과");
}

// --- 4. output_config.format 은 전 모델 공통 — 같이 죽으면 안 된다 ----------------
{
  for (const m of [FAST, DEFAULT, STRONG]) {
    const r = stripModelGatedParams(
      { output_config: { effort: "xhigh", format: { type: "json_schema" } } },
      m,
    );
    assert.deepEqual(
      r.body.output_config.format,
      { type: "json_schema" },
      `${m}: format 은 effort 와 무관하게 살아남는다`,
    );
  }
  console.log("✓ output_config.format 은 세 핀 모두에서 보존된다");
}

// --- 5. 모르는 모델은 fail closed ------------------------------------------------
{
  const r = stripModelGatedParams(
    { output_config: { effort: "high" }, context_management: { edits: [] } },
    "claude-something-unpinned",
  );
  assert.equal(r.body.output_config, undefined, "미확인 모델: effort 제거");
  assert.equal(r.body.context_management, undefined, "미확인 모델: context_management 제거");
  assert.equal(r.dropped.length, 2, "둘 다 보고한다");
  console.log("✓ 미확인 모델은 fail closed");
}

// --- 6. context_management 는 여전히 전부 제거 (의도된 것) ------------------------
//
// 이건 모델 게이트가 아니라 **베타 게이트**다. 2026-07-24 프로브는 베타 헤더 없이
// 보냈으므로 그 400 은 "모델이 거부"와 "베타 미활성"을 가르지 못한다. 확인될 때까지
// 닫아 둔다 — 90분 수업에서 컨텍스트 편집은 프롬프트 캐시만 깨고 이득이 없다.
{
  for (const m of [FAST, DEFAULT, STRONG]) {
    const r = stripModelGatedParams({ context_management: { edits: [] } }, m);
    assert.equal(r.body.context_management, undefined, `${m}: context_management 제거 유지`);
  }
  console.log("✓ context_management 는 미확인이라 계속 닫혀 있다");
}

// --- 7. 드리프트 락 — 핀마다 날짜 있는 근거가 있어야 한다 -------------------------
//
// 빈 근거는 "미확인"의 다른 이름이고, 그게 이 버그를 만들었다. 네 번째 핀을 추가하면
// TypeScript 가 MODEL_CAPS 누락을 잡고(Record<AnthropicModelId>), 이 테스트가 날짜
// 없는 근거를 잡는다.
{
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/lib/model-caps.ts", import.meta.url), "utf8"),
  );
  assert.ok(
    !/supportedBy:\s*\[\s*\]/.test(src),
    "빈 supportedBy 가 돌아왔다 — 그건 '미확인'이지 '미지원'이 아니다",
  );
  for (const id of Object.values(MODEL_MAP)) {
    const block = src.slice(src.indexOf(`"${id}": {`));
    const m = /verifiedBy:\s*([\s\S]{0,400}?),\n\s*\}/.exec(block);
    assert.ok(m, `${id}: MODEL_CAPS 항목에 verifiedBy 가 있어야 한다`);
    assert.match(m[1], /20\d\d-\d\d-\d\d/, `${id}: verifiedBy 에 날짜가 있어야 한다`);
  }
  console.log("✓ 드리프트 락 — 핀 3개 모두 날짜 있는 근거를 갖는다");
}


// --- 8. 샘플링 파라미터 게이트 (4.7 세대부터 non-default 는 400) -------------------
//
// 우리는 이 값을 만들지 않지만 두 경로 모두 클라이언트 것을 그대로 통과시킨다
// (messages.ts 의 `...raw`, translate.ts:572). /v1/chat/completions 는 공개 OpenAI
// 호환 엔드포인트라 아무 클라이언트나 temperature 를 보낼 수 있다.
{
  const body = { temperature: 0.2, top_p: 0.9, top_k: 40 };
  const now = stripModelGatedParams({ ...body }, DEFAULT);
  assert.deepEqual(now.body, body, `${DEFAULT}: 4.6 은 샘플링을 받으므로 무동작이어야 한다`);
  assert.deepEqual(now.dropped, [], "오늘 핀에서는 아무것도 안 바뀐다");

  const strict = stripModelGatedParams({ ...body }, STRONG);
  assert.equal(strict.body.temperature, undefined, `${STRONG}: temperature 제거`);
  assert.equal(strict.body.top_p, undefined, "top_p 제거");
  assert.equal(strict.body.top_k, undefined, "top_k 제거");
  assert.equal(strict.dropped.length, 3, "셋 다 이름과 함께 보고된다");
  console.log("✓ 샘플링 게이트 — 4.6 무동작, 4.7 에서 제거");
}

// --- 9. thinking 모양 정규화 (budget_tokens → adaptive) ---------------------------
//
// 번들 CLI 가 무엇을 보내는지 **관측된 바 없다**. 어느 모양이 와도 안전하도록
// 게이트웨이에서 정규화한다. 실패하면 CLI 재시도 루프가 400 을 삼키고 아이는
// "생각하는 중 ✨" 앞에서 무한정 기다린다 — #384·#403·#406 과 같은 부류다.
{
  const legacy = { thinking: { type: "enabled", budget_tokens: 10000 } };
  const keep = stripModelGatedParams({ ...legacy }, DEFAULT);
  assert.deepEqual(
    keep.body.thinking,
    legacy.thinking,
    `${DEFAULT}: 4.6 은 budget_tokens 를 아직 받으므로 건드리지 않는다`,
  );

  const norm = stripModelGatedParams({ ...legacy }, STRONG);
  assert.deepEqual(norm.body.thinking, { type: "adaptive" }, `${STRONG}: adaptive 로 정규화`);
  assert.match(norm.dropped[0], /adaptive/, "정규화 사실이 로그에 남는다");

  // display 는 보존한다 — 씽킹 표시 UX 를 바꾸지 않는다.
  const withDisplay = stripModelGatedParams(
    { thinking: { type: "enabled", budget_tokens: 1, display: "summarized" } },
    STRONG,
  );
  assert.equal(withDisplay.body.thinking.display, "summarized", "display 는 보존된다");

  // 이미 adaptive 면 무동작.
  const already = stripModelGatedParams({ thinking: { type: "adaptive" } }, STRONG);
  assert.deepEqual(already.dropped, [], "adaptive 는 손대지 않는다");
  console.log("✓ thinking 정규화 — 4.6 무동작, 4.7 에서 adaptive 로");
}

console.log("All model-gated-param checks passed.");
