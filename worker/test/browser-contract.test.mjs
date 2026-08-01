// 브라우저 도구 계약 ↔ 런타임 정합 테스트 (#520).
//
// 배경: `_browser-control-contract.md` 하나가 두 런타임 모두에 주입되고 있었다.
// 프록시 런타임은 문서대로 8종(navigate/back/forward/dialog 포함)을 갖지만 SDK
// 코치는 6종(open/live_preview_start 포함, navigate 없음)을 갖는다. 그래서 SDK
// 코치는 없는 도구를 배우고, 가진 도구 둘은 배우지 못했다.
//
// 이 테스트가 지키는 것은 "지금 문구가 맞다"가 아니라 **드리프트가 다시 생기면
// 빨갛게 된다**는 것이다. 그래서 문자열을 하드코딩하지 않고, 각 런타임의 실제
// 도구 목록(BROWSER_TOOLS / MCP_BROWSER_TOOLS)을 소스에서 읽어 양방향으로
// 대조한다 — 도구를 추가/삭제하고 문서를 안 고치면 여기서 잡힌다.
//
// 그물의 범위가 두 방향에서 다르다:
//   커버리지(가진 도구를 다 설명하는가) → 계약 문서. 그건 계약의 책임이다.
//   누설(없는 도구를 가르치는가)        → **캐시 프리픽스 전체**. 코호트 프롬프트·
//     스킬·스켈레톤이 전부 한 프롬프트로 합쳐지므로, 계약만 맞고 스킬이 없는
//     도구를 부르면 코치에게는 똑같은 거짓말이다. 실제로 그랬다 —
//     workshop-setup.md 와 publish-homepage.md 가 SDK 전용 도구를 지시했다.
//
// 대조군(.claude/rules/verification.md §2):
//  - 양성 — 브라우저를 켠 코호트는 각 런타임에서 계약을 **받아야** 한다
//  - 음성 — 브라우저를 안 켠 코호트는 어느 런타임에서도 **받지 않아야** 한다
//
// Run: node --experimental-strip-types test/browser-contract.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./harness/loader.mjs";

const { buildAnthropicSystemBlocks } = await import("../src/lib/translate.ts");
const { BROWSER_TOOLS } = await import("../src/lib/browser-tools.ts");
const { MCP_BROWSER_TOOLS } = await import(
  "../../extensions/hypeproof-chat/src/browserMcp.ts"
);
const { getProfile, listProfiles } = await import("../src/profiles/index.ts");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}\n   ${err.message}`);
  }
}

/** The cached prefix (block 0) the worker would send for this runtime. */
const prefixFor = (profile, runtime) =>
  buildAnthropicSystemBlocks(profile, {}, runtime)[0].text;

// **커버리지**(가진 도구를 빠짐없이 설명하는가)는 계약 문서가 소유하므로 문서
// 자체에 대해 잰다. **누설**(없는 도구를 가르치는가)은 캐시 프리픽스 **전체**에
// 대해 잰다 — 코호트 프롬프트·스킬·스켈레톤이 전부 같은 프롬프트로 들어가므로,
// 계약만 맞고 스킬이 다른 런타임의 도구를 부르면 코치에게는 똑같은 거짓말이다.
// (실제로 첫 판에서 스킬 2곳이 그랬다: workshop-setup / publish-homepage.)
const readContract = (name) =>
  readFileSync(new URL(`../src/prompts/_browser-control-contract-${name}.md`, import.meta.url), "utf8");
const PROXY_CONTRACT = readContract("proxy");
const SDK_CONTRACT = readContract("sdk");

// browser_control + sdk_tools.browser 둘 다 켜진 살아있는 코호트 — 드리프트가
// 실제로 발생하던 바로 그 프로필.
const COPYCLONE = getProfile("boah-dental-director-copyclone-2026-s1");
assert.ok(COPYCLONE, "copyclone fixture profile exists in the registry");
assert.equal(COPYCLONE.browser_control?.enabled, true, "fixture opts into browser_control");
assert.equal(COPYCLONE.sdk_tools?.browser, true, "fixture opts into sdk_tools.browser");

// 음성 대조군 — 브라우저를 안 켠 코호트(SK 초3·4 미성년, chat-only).
const KIDS = getProfile("sk-biopharm-kids-2026-grade-3-4-s1");
assert.ok(KIDS, "kids fixture profile exists in the registry");

// MCP 도구는 `mcp__hypeproof__browser_open` 형태로 노출된다. 계약 문서는 학생용
// 산문이라 짧은 이름으로 쓰므로 프리픽스를 벗겨서 대조한다.
const shortMcpName = (n) => n.replace(/^mcp__[^_]+__/, "");
const SDK_TOOL_NAMES = MCP_BROWSER_TOOLS.map(shortMcpName);
const PROXY_TOOL_NAMES = BROWSER_TOOLS.map((t) => t.name);
const TOOLS_OF = { proxy: PROXY_TOOL_NAMES, sdk: SDK_TOOL_NAMES };

/**
 * 이 런타임이 **가지고 있지 않은** 브라우저 도구 이름이 캐시 프리픽스 어디에도
 * 없어야 한다 — 계약이든 코호트 프롬프트든 스킬이든.
 *
 * 도구 이름을 굳이 써야 한다면 런타임 중립 표현("브라우저 도구가 있으면 직접
 * 열어줘라")으로 쓰거나, 그 런타임에도 실재하는 이름을 쓰면 된다. 이 테스트가
 * 빨갛게 되면 스킬 문서를 런타임별로 쪼개기 전에 중립 표현부터 검토해라.
 */
function assertNoForeignTools(profile, runtime) {
  const prefix = prefixFor(profile, runtime);
  const own = TOOLS_OF[runtime];
  const foreign = Object.values(TOOLS_OF)
    .flat()
    .filter((n) => !own.includes(n));
  for (const name of [...new Set(foreign)]) {
    assert.ok(
      !prefix.includes(name),
      `${runtime} 프롬프트가 이 런타임에 없는 ${name} 를 가르친다 — #520 드리프트 재발`,
    );
  }
}

// ── 프록시 런타임 ────────────────────────────────────────────────────────────

test("proxy: browser_control 코호트는 계약을 받는다 (양성 대조군)", () => {
  const prefix = prefixFor(COPYCLONE, "proxy");
  assert.match(prefix, /브라우저 제어 도구 사용 규약/);
});

test("proxy: 계약이 BROWSER_TOOLS 8종을 빠짐없이 설명한다", () => {
  for (const name of PROXY_TOOL_NAMES) {
    assert.ok(PROXY_CONTRACT.includes(name), `프록시 계약에 ${name} 설명이 없다`);
  }
});

test("proxy: 프롬프트 어디에서도 프록시에 없는 도구를 가르치지 않는다", () => {
  assertNoForeignTools(COPYCLONE, "proxy");
});

// ── SDK 런타임 ──────────────────────────────────────────────────────────────

test("sdk: sdk_tools.browser 코호트는 계약을 받는다 (양성 대조군)", () => {
  const prefix = prefixFor(COPYCLONE, "sdk");
  assert.match(prefix, /브라우저 제어 도구 사용 규약/);
});

test("sdk: 계약이 MCP_BROWSER_TOOLS 6종을 빠짐없이 설명한다", () => {
  for (const name of SDK_TOOL_NAMES) {
    assert.ok(SDK_CONTRACT.includes(name), `SDK 계약에 ${name} 설명이 없다`);
  }
});

test("sdk: 프롬프트 어디에서도 SDK 에 없는 도구를 가르치지 않는다 (#520 회귀)", () => {
  assertNoForeignTools(COPYCLONE, "sdk");
});

// ── 게이트 (음성 대조군 + 미성년 안전) ──────────────────────────────────────

test("브라우저를 안 켠 코호트는 어느 런타임에서도 계약을 안 받는다 (음성 대조군)", () => {
  for (const runtime of ["proxy", "sdk"]) {
    const prefix = prefixFor(KIDS, runtime);
    assert.ok(
      !prefix.includes("브라우저 제어 도구 사용 규약"),
      `${runtime}: 브라우저 미사용 코호트에 계약이 샜다`,
    );
  }
});

test("sdk: 미성년 코호트는 sdk_tools.browser 가 켜져 있어도 계약을 안 받는다", () => {
  // 클라이언트(permittedMcpToolsFor)가 미성년에게는 플래그와 무관하게 브라우저
  // MCP 도구를 벗긴다(#306/#318). 계약만 주입되면 바로 이 버그가 재현된다.
  const minorWithBrowser = {
    ...KIDS,
    sdk_tools: { ...(KIDS.sdk_tools ?? {}), browser: true },
  };
  const prefix = prefixFor(minorWithBrowser, "sdk");
  assert.ok(
    !prefix.includes("브라우저 제어 도구 사용 규약"),
    "미성년 코호트에 SDK 브라우저 계약이 주입됐다",
  );
});

// 픽스처 하나만 보면 새로 추가되는 코호트가 그물을 빠져나간다. 레지스트리 전체를
// 훑어 브라우저를 켠 코호트마다 두 런타임을 다 검사한다.
test("레지스트리의 모든 브라우저 코호트가 두 런타임 모두에서 깨끗하다", () => {
  const browserProfiles = listProfiles().filter(
    (p) => p.browser_control?.enabled === true || p.sdk_tools?.browser === true,
  );
  assert.ok(browserProfiles.length > 0, "브라우저를 켠 코호트가 하나도 없다 — 픽스처 가정이 깨졌다");
  for (const p of browserProfiles) {
    for (const runtime of ["proxy", "sdk"]) {
      try {
        assertNoForeignTools(p, runtime);
      } catch (err) {
        throw new Error(`${p.id ?? "(id 없음)"}: ${err.message}`);
      }
    }
  }
});

test("runtime 인자 없이 부르면 프록시 계약 (pre-#520 기본값 유지)", () => {
  const prefix = buildAnthropicSystemBlocks(COPYCLONE, {})[0].text;
  assert.ok(prefix.includes("browser_navigate"), "기본값이 프록시가 아니다");
});

console.log(failed === 0 ? "\nbrowser-contract.test.mjs: all tests passed" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
