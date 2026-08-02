// #476 — 프록시로 떨어진 SDK 코호트에게 "너에겐 파일·셸 도구가 없다" 를 가르치는
// 블록의 게이트 테스트.
//
// 이 블록이 틀리는 두 방향이 정확히 반대의 피해를 낸다:
//   너무 관대 → 정상 SDK 턴에도 "도구가 없다" 고 가르쳐 **멀쩡한 코치를 불구로 만든다**
//   너무 엄격 → 폴백한 코치가 그대로 없는 능력을 자임한다 (원래 결함 유지)
// 그래서 양성·음성 대조군을 둘 다 둔다 (.claude/rules/verification.md 규칙 2).

import assert from "node:assert/strict";
// `.md` string imports only resolve under wrangler's rules; the harness loader
// teaches plain node the same thing (same idiom as browser-contract.test.mjs).
import "./harness/loader.mjs";

const { buildAnthropicSystemBlocks } = await import("../src/lib/translate.ts");
const { getProfile } = await import("../src/profiles/index.ts");

const MARKER = "이번 대화에서 너에게 **파일 도구(Read · Write · Edit)와 셸(Bash)이 없다.**";

/** 정정 블록이 붙었는가 — 캐시 프리픽스(첫 블록)만 본다. */
function hasNotice(profile, runtime) {
  const blocks = buildAnthropicSystemBlocks(profile, {}, runtime);
  return blocks[0].text.includes(MARKER);
}

/** copyclone 형태의 최소 프로필. 각 케이스가 필요한 필드만 덮어쓴다. */
function profile(over = {}) {
  return {
    system_prompt: "코호트 프롬프트. index.html 을 만들어 저장합니다.",
    coach_runtime: "agent-sdk",
    sdk_tools: { read: true, write: true, shell: true, browser: true, subagents: true },
    audience: { age_range: [30, 60] },
    game: { template_tier: "website" },
    preview: { type: "live_server", auto_start: false },
    browser_control: { enabled: true, max_iterations: 8 },
    skills: [],
    ...over,
  };
}

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ── 양성 대조군 — 반드시 붙어야 하는 경우 ─────────────────────────────────

ok("SDK 코호트가 프록시 라우트로 오면 붙는다 (이 이슈의 실제 사고 조건)", () => {
  assert.equal(hasNotice(profile(), "proxy"), true);
});

ok("**실제 프로덕션 프로필**(copyclone)로도 붙는다 — 합성 프로필만 믿지 않는다", () => {
  // 2026-07-27 사고가 난 바로 그 코호트다. 합성 프로필은 내가 게이트에 맞춰
  // 만든 것이라 스스로를 증명하지 못한다 — 실물로 한 번 더 잰다.
  const real = getProfile("boah-dental-director-copyclone-2026-s1");
  assert.ok(real, "프로필이 레지스트리에 있어야 한다 (전제 확인)");
  assert.equal(real.coach_runtime, "agent-sdk", "전제: SDK 를 요청하는 코호트");
  assert.equal(hasNotice(real, "proxy"), true);
  assert.equal(hasNotice(real, "sdk"), false);
});

ok("**실제 kids 프로필**에는 어느 라우트로도 안 붙는다 (8/22 SK 무영향)", () => {
  // id 는 파일명이 아니다 — 레지스트리에서 확인한 실제 값이다
  // (3-4 반은 파일이 `sk-biopharm-kids-s1.ts` 인데 id 는 `…-grade-3-4-s1`).
  for (const id of [
    "sk-biopharm-kids-2026-grade-3-4-s1",
    "sk-biopharm-kids-2026-grade-5-6-s1",
  ]) {
    const p = getProfile(id);
    assert.ok(p, `${id} 가 레지스트리에 있어야 한다`);
    assert.equal(hasNotice(p, "proxy"), false, id);
    assert.equal(hasNotice(p, "sdk"), false, id);
  }
});

ok("read 만 준 코호트도 붙는다", () => {
  assert.equal(
    hasNotice(profile({ sdk_tools: { read: true, browser: true } }), "proxy"),
    true,
  );
});

ok("shell 만 준 코호트도 붙는다", () => {
  assert.equal(hasNotice(profile({ sdk_tools: { shell: true } }), "proxy"), true);
});

// ── 음성 대조군 — 붙으면 안 되는 경우 ────────────────────────────────────
// 여기서 관대해지면 멀쩡히 도구를 가진 코치에게 "도구가 없다" 고 가르친다.

ok("SDK 라우트에는 절대 안 붙는다 (정상 경로를 망가뜨리지 않는다)", () => {
  assert.equal(hasNotice(profile(), "sdk"), false);
});

ok("애초에 프록시로 설계된 코호트에는 안 붙는다", () => {
  // teaser·kids — 프롬프트가 파일·셸을 약속하지 않으므로 정정할 것이 없다.
  assert.equal(hasNotice(profile({ coach_runtime: undefined }), "proxy"), false);
  assert.equal(hasNotice(profile({ coach_runtime: "proxy" }), "proxy"), false);
});

ok("미성년 코호트에는 안 붙는다 (degraded 가 아니라 설계다)", () => {
  // 워커가 chat.ts 에서 미성년을 의도적으로 프록시에 고정한다.
  assert.equal(hasNotice(profile({ minor_cohort: true }), "proxy"), false);
  assert.equal(
    hasNotice(profile({ audience: { age_range: [9, 12] } }), "proxy"),
    false,
  );
});

ok("호스트 도구를 안 준 SDK 코호트에는 안 붙는다", () => {
  // 브라우저만 준 코호트는 프록시에서도 브라우저를 쓴다 — 잃은 게 없다.
  assert.equal(hasNotice(profile({ sdk_tools: { browser: true } }), "proxy"), false);
  assert.equal(hasNotice(profile({ sdk_tools: undefined }), "proxy"), false);
});

// ── 배치 — 스킬 뒤에 와야 한다 ──────────────────────────────────────────

ok("정정은 스킬 **뒤**에 온다 (176줄 셸 절차가 한 문단을 덮지 않게)", () => {
  const p = profile({ skills: ["publish-homepage"] });
  const text = buildAnthropicSystemBlocks(p, {}, "proxy")[0].text;
  // 프로브는 스킬 **본문**에서 골랐다. 처음엔 스킬 *이름*("publish-homepage")으로
  // 찾았는데 그 리터럴은 본문에 0회이고 내 정정 블록에만 있어서, 자기 자신을
  // 가리키며 통과하는 계측기가 됐다(.claude/rules/verification.md 규칙 1 —
  // 판정 기준을 세우기 전에 대상을 열어본다).
  const SKILL_PROBE = "# 스킬: 홈페이지를 인터넷에 올리기";
  const skillAt = text.indexOf(SKILL_PROBE);
  const noticeAt = text.indexOf(MARKER);
  assert.ok(noticeAt > 0, "정정 블록이 있어야 한다");
  assert.ok(skillAt > 0, "스킬이 주입돼야 한다 (전제 확인)");
  assert.ok(noticeAt > skillAt, `정정(${noticeAt})이 스킬(${skillAt}) 뒤여야 한다`);
});

// ── 프롬프트 캐시 — 변형 수가 늘면 교실 전체의 캐시 히트가 깨진다 ──────────

ok("같은 (프로필, 런타임) 은 byte-identical (캐시 공유 유지)", () => {
  const p = profile();
  assert.equal(
    buildAnthropicSystemBlocks(p, {}, "proxy")[0].text,
    buildAnthropicSystemBlocks(p, {}, "proxy")[0].text,
  );
  assert.equal(
    buildAnthropicSystemBlocks(p, {}, "sdk")[0].text,
    buildAnthropicSystemBlocks(p, {}, "sdk")[0].text,
  );
});

ok("캐시 변형은 여전히 런타임당 하나 — 이 블록이 셋째를 만들지 않는다", () => {
  const p = profile();
  const variants = new Set([
    buildAnthropicSystemBlocks(p, {}, "proxy")[0].text,
    buildAnthropicSystemBlocks(p, {}, "proxy")[0].text,
    buildAnthropicSystemBlocks(p, {}, "sdk")[0].text,
    buildAnthropicSystemBlocks(p, {}, "sdk")[0].text,
  ]);
  assert.equal(variants.size, 2);
});

// ── 내용 — 이 문장들이 사라지면 원래 발화가 돌아온다 ───────────────────────

ok("정정이 실측 오발화 3종을 각각 막는다", () => {
  const text = buildAnthropicSystemBlocks(profile(), {}, "proxy")[0].text;
  // "저장했어요" (거짓 성공 보고)
  assert.ok(text.includes('"저장했어요" 라고 말하지 않는다'));
  // "저장해주시겠어요?" (참가자에게 떠넘기기)
  assert.ok(text.includes("떠넘기지 않는다"));
  // "작업 폴더가 비어 있어요" (알 수 없는 것을 단정)
  assert.ok(text.includes("비어 있다고 단정하지도 않는다"));
});

ok("여전히 되는 것도 말한다 (참가자가 수업을 통째로 포기하지 않게)", () => {
  const text = buildAnthropicSystemBlocks(profile(), {}, "proxy")[0].text;
  assert.ok(text.includes("브라우저 도구는 그대로 쓸 수 있다"));
  assert.ok(text.includes("Studio 가 그 블록을 받아"));
});

console.log(`\n#476 runtime-degraded-notice: ${passed} checks passed`);
