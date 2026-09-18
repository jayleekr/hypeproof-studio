// #671 — kids-quest world contract, checked on what the COACH wrote.
//
// worker/test/kids-quest-prompt.test.mjs already asserts the contract over the
// untouched skeletons. That is a build-time check of our own material; it says
// nothing about the document the coach hands back. This file checks the gate
// that runs on that document.
//
// Both controls are here on purpose (.claude/rules/verification.md rule 2):
//   positive — the nine REAL worlds, rendered exactly as production renders
//              them, must PASS. This is the control that catches a checker that
//              is too strict, which is the direction this repo keeps being
//              wrong in.
//   negative — a planted defect of each kind must be caught, with the severity
//              the engine's behaviour justifies.
//
// Run: node --experimental-strip-types test/world-contract.smoke.mjs

import assert from "node:assert/strict";

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { checkWorldContract, externalSubresources, hasElementId, validateAndRepairHtml } =
  await import("../src/htmlStructure.ts");

// The shipped skeleton markup, read from disk. worlds.ts (which fills these in
// production via renderWorld) imports `../index` extensionless, so it is not
// loadable under plain node — and pulling the worker's bundler in here would
// buy nothing: none of the four contract rules reads a placeholder's VALUE,
// only whether one is still unfilled. So the markup is production's and the
// fill values are stand-ins, which is exactly the part that does not matter.
const SKELETON_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../worker/src/skeletons/kids-quest",
);
const FILL = {
  TITLE: "도토의 세상", GUEST_EMOJI: "🐿️", GUEST_NAME: "도토",
  GUEST_LINE: "나뭇가지가 다 부러졌어…", PLAYER_EMOJI: "🐿️",
  ITEM_A: "🌰", ITEM_B: "🍂", SPEED: "6", RATE: "6", GOAL: "30",
  SPECIAL: "7", BG_TOP: "#3a4a5c", BG_BOT: "#8fa3b3",
};
const fill = (html) =>
  Object.entries(FILL).reduce((h, [k, v]) => h.split(`%%${k}%%`).join(v), html);

const skeletons = readdirSync(SKELETON_DIR)
  .filter((f) => f.endsWith(".html"))
  .map((f) => ({ id: f.replace(/\.html$/, ""), raw: readFileSync(path.join(SKELETON_DIR, f), "utf8") }));

// ── positive control — the nine shipped worlds -------------------------------
{
  assert.equal(skeletons.length, 9, "세상 9개");
  for (const s of skeletons) {
    const html = fill(s.raw);
    assert.equal(/%%[A-Z_]+%%/.test(html), false, `${s.id}: 자리표시자를 전부 채웠다`);
    const r = checkWorldContract(html);
    assert.deepEqual(r.issues, [], `${s.id}: 정상 세상에 지적이 붙었다 — 계측기가 너무 엄격하다`);
    assert.equal(r.blocked, false, `${s.id}: 정상 세상이 차단됐다`);
    // The same document through the real chokepoint, contract enabled.
    const gated = validateAndRepairHtml(html, { worldContract: true });
    assert.equal(gated.blocked, false, `${s.id}: 관문이 정상 세상을 막았다`);
    assert.deepEqual(gated.issues, [], `${s.id}: 관문이 정상 세상에 지적을 붙였다`);
  }
  console.log("✓ 양성 대조군 — 실제 세상 9개가 계약을 통과한다");
}

// The UNFILLED skeleton is production material that must NOT pass — the
// placeholder rule has bite without a hand-written fixture.
{
  for (const s of skeletons) {
    assert.equal(checkWorldContract(s.raw).blocked, true, `${s.id}: 안 채운 스켈레톤은 차단`);
  }
  console.log("✓ 안 채운 스켈레톤 9개는 전부 차단된다");
}

const BASE = fill(skeletons.find((s) => s.id === "jump").raw);

// ── negative control — planted defects ---------------------------------------
{
  // 1. guest bubble removed → engine.js dereferences #gface at top level.
  const noGuest = BASE.replace(/<div id="guest">[\s\S]*?<\/div>\s*<\/div>/, "");
  const r1 = checkWorldContract(noGuest);
  assert.equal(r1.blocked, true, "게스트 말풍선이 사라지면 차단");
  assert.match(r1.issues.join(" "), /말풍선/, "이유가 말풍선이라고 적힌다");

  // gsay alone is enough to kill the engine's say().
  const noSay = BASE.replace('id="gsay"', 'id="gbubble"');
  assert.equal(checkWorldContract(noSay).blocked, true, "#gsay 하나만 사라져도 차단");

  // 2. unfilled placeholder → `const SPEED=%%SPEED%%;` is a syntax error.
  const unfilled = BASE.replace(/const SPEED=\d+;/, "const SPEED=%%SPEED%%;");
  assert.notEqual(unfilled, BASE, "SPEED 자리를 실제로 되돌렸다");
  const r2 = checkWorldContract(unfilled);
  assert.equal(r2.blocked, true, "자리표시자가 남으면 차단");
  assert.match(r2.issues.join(" "), /%%SPEED%%/, "어느 자리표시자인지 적힌다");

  // 3. external subresource → live_server serves with no CSP.
  const injected = BASE.replace(
    '<script src="engine.js"></script>',
    '<script src="engine.js"></script>\n<img src="https://evil.example/pixel.png">',
  );
  const r3 = checkWorldContract(injected);
  assert.equal(r3.blocked, true, "바깥 주소를 부르면 차단");
  assert.match(r3.issues.join(" "), /evil\.example/, "어느 주소인지 적힌다");

  // 4. report() gone → world still renders; advisory only.
  const noReport = BASE.replace(/\breport\(/g, "noop_report(");
  const r4 = checkWorldContract(noReport);
  assert.equal(r4.blocked, false, "report 부재는 차단하지 않는다 — 세상은 보인다");
  assert.match(r4.issues.join(" "), /결과 보고/, "그래도 지적은 남는다");
  console.log("✓ 음성 대조군 — 심은 결함 4종이 각각의 무게로 잡힌다");
}

// ── the checker must not fire on things that only look like violations -------
{
  // `<a href="https://…">` is navigation, not a fetch.
  assert.deepEqual(
    externalSubresources('<a href="https://ko.wikipedia.org">위키</a>'),
    [],
    "링크는 서브리소스가 아니다",
  );
  // SVG's xmlns is not a fetched attribute.
  assert.deepEqual(
    externalSubresources('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>'),
    [],
    "xmlns 는 서브리소스가 아니다",
  );
  // Relative and data: sources stay local.
  assert.deepEqual(
    externalSubresources('<script src="engine.js"></script><img src="data:image/gif;base64,AA">'),
    [],
    "상대경로·data: 는 바깥이 아니다",
  );
  assert.deepEqual(
    externalSubresources('<img src="https://a/x.png"><link href=\'https://b/y.css\'>'),
    ["https://a/x.png", "https://b/y.css"],
    "따옴표 두 종류 모두 잡는다",
  );
  // A URL mentioned in a comment or a string is not a tag attribute.
  assert.deepEqual(
    externalSubresources("<!-- 출처: https://example.com --><script>const u='https://x/y';</script>"),
    [],
    "주석·문자열 속 주소는 서브리소스가 아니다",
  );
  // A commented-out report() must not read as a live call.
  assert.match(
    checkWorldContract(BASE.replace(/\breport\(/g, "// report(")).issues.join(" "),
    /결과 보고/,
    "주석 처리된 report 는 호출이 아니다",
  );
  // id matching tolerates quoting styles.
  assert.equal(hasElementId("<div id=gface></div>", "gface"), true, "따옴표 없는 id");
  assert.equal(hasElementId("<div id='gface'></div>", "gface"), true, "홑따옴표 id");
  assert.equal(hasElementId('<div id="gfaces"></div>', "gface"), false, "부분 일치는 아니다");
  console.log("✓ 오탐 방지 — 링크·xmlns·상대경로·주석은 위반이 아니다");
}

// ── the contract is OFF unless the caller asks for it ------------------------
{
  // An adult copyclone page has no report()/#guest by design.
  const adult = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>보아치과</title></head><body><h1>건강한 미소</h1>
<img src="logo.png"></body></html>`;
  const off = validateAndRepairHtml(adult);
  assert.equal(off.blocked, false, "계약을 켜지 않은 코호트는 영향 없음");
  assert.deepEqual(off.issues, [], "계약을 켜지 않으면 지적도 없음");
  const on = validateAndRepairHtml(adult, { worldContract: true });
  assert.equal(on.blocked, true, "켜면 같은 문서가 걸린다 — 게이트가 실제로 갈린다");
  console.log("✓ 코호트 게이트 — 켜지 않으면 기존 동작 그대로");
}

// ── a swallowed <script> must not be reported as a missing element -----------
{
  const broken = BASE.replace("<!doctype html>", "<!doctype html>\n<!-- 안 닫힌 주석");
  const r = validateAndRepairHtml(broken, { worldContract: true });
  assert.equal(r.blocked, true, "구조가 깨지면 차단");
  assert.equal(
    r.issues.some((i) => i.includes("말풍선")),
    false,
    "구조 결함일 때 계약 지적을 겹쳐 내지 않는다",
  );
  console.log("✓ 구조 결함이 먼저 — 계약 지적을 겹쳐 내지 않는다");
}

console.log("world-contract: 전부 통과");
