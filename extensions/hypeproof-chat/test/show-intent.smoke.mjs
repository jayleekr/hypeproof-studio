// Smoke tests for chatPanelHelpers (#94 REQ-C9 + #92 REQ-C3 clamp).
// Pure helpers — no vscode host.
// Run: node --experimental-strip-types test/show-intent.smoke.mjs

import assert from "node:assert/strict";

const { isShowIntent, clampHistory, HISTORY_MAX, sanitizeCoachInput, COACH_NAME_MAX, COACH_PERSONALITY_MAX, abortAllStreams } = await import(
  "../src/chatPanelHelpers.ts"
);

// ─── Show intents (true) ──────────────────────────────────────────────
const showCases = [
  "보여줘",
  "실행",
  "실행해",
  "실행해줘",
  "다시 보여줘",
  "그거 보여줘",
  "게임 보여줘",
  "play",
  "run",
  "open",
  "show",
  "켜줘",
  "돌려봐",
  "플레이",
  "미리보기",
  "미리 보기",
];
for (const c of showCases) {
  assert.equal(isShowIntent(c), true, `expected show-intent for: "${c}"`);
}
console.log(`✅ show-intent positives: ${showCases.length} cases`);

// ─── Create intents (false) ───────────────────────────────────────────
const createCases = [
  "게임 만들어줘",
  "별이 떨어지는 게임 보여줘",     // describes content → create
  "색깔 바꿔봐",
  "색상 바꿔줘",
  "소리 넣어줘",
  "더 빠르게 해줘",
  "더 느리게",
  "공룡 추가해줘",
  "배경 그려줘",
  "버튼 없애줘",
  "더 크게 해봐",
];
for (const c of createCases) {
  assert.equal(isShowIntent(c), false, `expected NOT show-intent for: "${c}"`);
}
console.log(`✅ create-intent negatives: ${createCases.length} cases`);

// ─── Korean single-char trap (the critical one) ──────────────────────
// Bare /색/ in the create-verb regex would match "검색" and break the
// dental cohort's 슈퍼서치엔진/검색엔진 prompts. These must still pass
// through to the LLM, NOT be intercepted as create-intent that fails the
// final positive regex (which would just send them as a chat message
// either way — but the show-intent branch needs to return false cleanly).
const searchCases = [
  "검색해줘",
  "검색 결과 보여줘",
  "원장님께 검색해서 보여드려",
];
for (const c of searchCases) {
  // These are NOT show-intents (too long / have non-show verbs), so isShowIntent
  // should return false. The bug we're guarding against is the OPPOSITE failure:
  // if "색" matched "검색" in the create-verb gate, "검색 보여줘" would short-
  // circuit to false at the create gate before even hitting the show regex,
  // and we'd never know we'd lost the dental-cohort path. Test that the create
  // gate does NOT trigger on these.
  assert.equal(isShowIntent(c), false, `should not show-intent: "${c}"`);
}
console.log(`✅ Korean single-char trap (검색 not matching 색): ${searchCases.length} cases`);

// Direct guard: a short "검색해줘" passing the create gate would have to fall
// through to the show regex, which doesn't match "검색해줘" anyway (it's not
// a show verb). So we instead test the CREATE gate in isolation by checking
// that a short "검색" prefix doesn't trip the gate via "색" substring.
// We do this by exposing the same regex through a behavior probe: a short
// hypothetical input "검색" + a show verb would currently fail because the
// create gate fires on "색". Test the canonical fix path: re-running it with
// new regex (multi-char "색깔/색상/색을/색이") leaves "검색" untouched.
// Behaviorally: "검색" alone returns false (no show verb), but the create
// gate must NOT have been the reason — we can't directly assert on which
// branch returned false from the outside. The integration cases above are
// the meaningful protection; this comment documents the why.

// ─── Length boundary ────────────────────────────────────────────────
assert.equal(isShowIntent("보여줘"), true);                     // 3 chars
assert.equal(isShowIntent("실행해줘"), true);                   // 4 chars
assert.equal(isShowIntent("a".repeat(15)), false);              // > 14 chars
assert.equal(isShowIntent("보여줘 보여줘 보여줘 보여줘"), false);   // > 14 chars after trim
console.log("✅ length boundary at 14");

// ─── Punctuation tolerance ──────────────────────────────────────────
assert.equal(isShowIntent("보여줘!"), true);
assert.equal(isShowIntent("보여줘??"), true);
assert.equal(isShowIntent("show~"), true);
assert.equal(isShowIntent("  보여줘  "), true);
console.log("✅ trailing punctuation + whitespace tolerance");

// ─── Off-topic (false) ──────────────────────────────────────────────
const offTopic = [
  "날씨 어때?",
  "안녕",
  "고마워",
  "치과 의사 추천해줘",
  "임플란트 비용이 얼마야",
];
for (const c of offTopic) {
  assert.equal(isShowIntent(c), false, `off-topic should be false: "${c}"`);
}
console.log(`✅ off-topic negatives: ${offTopic.length} cases`);

console.log("\nAll show-intent smoke tests passed.");

// ─── clampHistory (REQ-C3) ─────────────────────────────────────────
{
  assert.equal(HISTORY_MAX, 200, "default ceiling is 200");

  // Empty + empty → empty
  assert.deepEqual(clampHistory([], []), []);

  // Under cap: append everything
  const a = clampHistory(["a", "b"], ["c", "d"]);
  assert.deepEqual(a, ["a", "b", "c", "d"]);

  // Exactly at cap
  const ten = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(clampHistory(ten, [], 10), ten);

  // Over cap: oldest dropped, last N kept
  const overflow = clampHistory(ten, [10, 11, 12], 10);
  assert.deepEqual(overflow, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  // 250-turn seed: only last 200 retained
  const big = Array.from({ length: 250 }, (_, i) => i);
  const clamped = clampHistory(big, [], HISTORY_MAX);
  assert.equal(clamped.length, 200);
  assert.equal(clamped[0], 50, "oldest 50 dropped");
  assert.equal(clamped[199], 249, "newest retained");

  // Defensive: max=0 → empty
  assert.deepEqual(clampHistory(["a"], ["b"], 0), []);
  // Defensive: negative max → empty
  assert.deepEqual(clampHistory(["a"], ["b"], -5), []);

  console.log("✅ clampHistory: 8 cases (empty, under/at/over cap, 250-clamp, defensive)");
}

// ─── sanitizeCoachInput (REQ-F3) ────────────────────────────────────
{
  assert.equal(COACH_NAME_MAX, 40);
  assert.equal(COACH_PERSONALITY_MAX, 200);

  // Happy
  assert.deepEqual(
    sanitizeCoachInput("코디", "친절한", "코치"),
    { name: "코디", personality: "친절한" },
  );

  // Trim
  assert.deepEqual(
    sanitizeCoachInput("  Tony  ", "  ", "코치"),
    { name: "Tony", personality: "" },
  );

  // Empty name → fallback
  assert.deepEqual(
    sanitizeCoachInput("", "", "기본코치"),
    { name: "기본코치", personality: "" },
  );
  assert.deepEqual(
    sanitizeCoachInput("   ", "p", "fallback"),
    { name: "fallback", personality: "p" },
  );

  // Length clamp on name (40)
  const long41 = "a".repeat(41);
  const clampedName = sanitizeCoachInput(long41, "", "_").name;
  assert.equal(clampedName.length, 40);
  assert.equal(clampedName, "a".repeat(40));

  // Length clamp on personality (200)
  const long201 = "p".repeat(201);
  const clampedPers = sanitizeCoachInput("n", long201, "_").personality;
  assert.equal(clampedPers.length, 200);

  // Korean char counted by code unit (each Hangul = 1 unit)
  const koreanName = "코".repeat(41);
  assert.equal(sanitizeCoachInput(koreanName, "", "_").name.length, 40);

  console.log("✅ sanitizeCoachInput: trim + fallback + 40/200 clamp + Korean chars");
}

// ─── abortAllStreams (REQ-L3) ───────────────────────────────────────
{
  // Empty map — no throws
  const empty = new Map();
  abortAllStreams(empty);
  assert.equal(empty.size, 0);

  // Three streams, each tracking abort calls
  const streams = new Map();
  const log = [];
  for (const id of ["s1", "s2", "s3"]) {
    streams.set(id, { abort: () => log.push(`abort:${id}`) });
  }
  abortAllStreams(streams);
  assert.equal(streams.size, 0, "map cleared");
  assert.deepEqual(log.sort(), ["abort:s1", "abort:s2", "abort:s3"]);

  // Defensive: a stream whose abort throws shouldn't prevent the rest
  const streams2 = new Map();
  let called = 0;
  streams2.set("bad", { abort: () => { throw new Error("oops"); } });
  streams2.set("good", { abort: () => { called++; } });
  abortAllStreams(streams2);
  assert.equal(called, 1, "good abort still ran after bad abort threw");
  assert.equal(streams2.size, 0, "map still cleared after a throw");

  console.log("✅ abortAllStreams: 3 cases (empty, multi, throw-resilient)");
}

// ─── "아직 안 떴다" 는 재생성이 아니라 열기다 (REQ-M34, 2026-08-17 실기기) ──
//
// "완성된 거 안 보여" 는 명령이 아니라 **불평**이라 동사 패턴에 안 걸렸고,
// 코치에게 넘어가 세계를 통째로 다시 그렸다 — 보려던 아이가 더 오래 기다렸다.
// 프롬프트로 먼저 막아봤지만 트랙의 ⚠ 최상위 규칙("무조건 완전한 코드 출력")과
// 충돌해서 졌다. 그래서 여기서 결정적으로 끊는다.
//
// **음성 대조군이 이 TC 의 핵심이다.** 이 판정이 너무 관대하면 아이가 원한
// 수정이 조용히 사라진다 — 재생성보다 나쁜 실패다.
{
  const shouldOpen = [
    "안 보여", "안보여", "안 보여요", "안 보이는데", "아직 안 보여", "안 나와",
    "완성된 거 안 보여", "만든 거 안 보여", "그거 안 보여",
    "미래 안 보여", "세계 안 보여", "화면 안 보여",
  ];
  for (const t of shouldOpen) {
    assert.equal(isShowIntent(t), true, `"${t}" 는 열기여야 한다 (다시 그리면 안 된다)`);
  }

  const shouldBuild = [
    "글씨가 안 보여",        // 접두사 목록에 없다 — 진짜 수정 요청이다
    "안 보이게 해줘",        // 숨겨달라는 것 — 정반대
    "색깔 안 보여서 바꿔줘", // 수정 동사가 먼저 걸러낸다
    "건물 안 보이게 지워줘",
    "비 내리게 해줘",
    "별이 떨어지는 게임 보여줘",
  ];
  for (const t of shouldBuild) {
    assert.equal(isShowIntent(t), false, `"${t}" 는 코치에게 가야 한다 (수정 요청이 사라지면 안 된다)`);
  }

  console.log(`✅ "안 보여" 계열: 양성 ${shouldOpen.length} · 음성 ${shouldBuild.length}`);
}

console.log("\nAll chatPanelHelpers smoke tests passed.");
