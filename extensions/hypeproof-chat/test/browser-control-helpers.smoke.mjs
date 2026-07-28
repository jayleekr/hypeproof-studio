// Smoke tests for the browser control pure helpers (#278 Phase 3): URL
// whitelist (security), AX-snapshot ref assignment, click-point math.
// vscode-free. Run:
//   node --experimental-strip-types test/browser-control-helpers.smoke.mjs

import assert from "node:assert/strict";

const { safeNavigateUrl, quadCenter, buildAxSnapshot, normalizeBrowserUrl, isSameBrowserUrl } =
  await import("../src/browserControlHelpers.ts");

// ─── safeNavigateUrl (security boundary) ───
{
  assert.equal(safeNavigateUrl("https://example.com"), "https://example.com");
  assert.equal(safeNavigateUrl("http://a.b/c"), "http://a.b/c");
  assert.equal(safeNavigateUrl("file:///tmp/x.html"), "file:///tmp/x.html");
  assert.equal(safeNavigateUrl("localhost:5173/x"), "http://localhost:5173/x");
  assert.equal(safeNavigateUrl("127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(safeNavigateUrl("example.com/path"), "https://example.com/path"); // bare host → https
  // Disallowed schemes / shapes → null.
  assert.equal(safeNavigateUrl("javascript:alert(1)"), null);
  assert.equal(safeNavigateUrl("data:text/html,<b>x"), null);
  assert.equal(safeNavigateUrl("vscode://foo"), null);
  assert.equal(safeNavigateUrl("/etc/passwd"), null);
  assert.equal(safeNavigateUrl(""), null);
  assert.equal(safeNavigateUrl("   "), null);
  console.log("✓ safeNavigateUrl: http/https/file/localhost/bare-host allowed; js/data/vscode/paths rejected");
}

// ─── quadCenter ───
{
  // Unit square 0..10 → center 5,5.
  assert.deepEqual(quadCenter([0, 0, 10, 0, 10, 10, 0, 10]), { x: 5, y: 5 });
  assert.equal(quadCenter([1, 2, 3]), null, "short quad → null");
  assert.equal(quadCenter("nope"), null, "non-array → null");
  console.log("✓ quadCenter: averages the 4 corners; rejects malformed quads");
}

// ─── buildAxSnapshot ───
{
  const nodes = [
    { role: { value: "heading" }, name: { value: "가격 안내" }, backendDOMNodeId: 1 },
    { role: { value: "button" }, name: { value: "예약하기" }, backendDOMNodeId: 2 },
    { role: { value: "textbox" }, name: { value: "이름" }, backendDOMNodeId: 3 },
    { role: { value: "generic" }, name: { value: "" }, backendDOMNodeId: 4 }, // skipped (not interactive, no name)
    { role: { value: "link" }, name: { value: "오시는 길" }, backendDOMNodeId: 5, ignored: true }, // ignored
  ];
  const { text, refs } = buildAxSnapshot(nodes);
  // Interactive nodes get sequential refs mapped to their backendDOMNodeId.
  assert.equal(refs.get("e1"), 2, "first interactive (button) → e1 → backendId 2");
  assert.equal(refs.get("e2"), 3, "second interactive (textbox) → e2 → backendId 3");
  assert.equal(refs.size, 2, "only interactive, non-ignored nodes get refs");
  assert.ok(text.includes('[ref=e1] button "예약하기"'), "button rendered with ref + name");
  assert.ok(text.includes('[ref=e2] textbox "이름"'), "textbox rendered with ref + name");
  assert.ok(text.includes("heading: 가격 안내"), "heading rendered as text context (no ref)");
  assert.ok(!text.includes("오시는 길"), "ignored node excluded");

  // Empty / no interactive → friendly placeholder.
  const empty = buildAxSnapshot([]);
  assert.equal(empty.refs.size, 0);
  assert.ok(empty.text.includes("찾지 못했"), "empty snapshot has a placeholder");
  console.log("✓ buildAxSnapshot: interactive→[ref=eN]+backendId map, text context, ignored excluded");
}

// ─── normalizeBrowserUrl / isSameBrowserUrl (#415 — 같은 페이지 판정) ───
// WHY: 브라우저가 들고 있는 `tab.url` 과 코치가 요청하는 URL 은 표기가 다르다.
// 그 차이 때문에 "이미 열려 있다"를 놓치면 탭이 중복으로 열리고 학생은 승인
// 모달을 한 번 더 눌러야 한다 (실사용 2026-07-24).
{
  // 끝 슬래시 — live_preview_start 는 ".../" 로, 모델은 슬래시 없이 부르기 쉽다.
  assert.ok(isSameBrowserUrl("http://127.0.0.1:5432/", "http://127.0.0.1:5432"));
  assert.ok(isSameBrowserUrl("https://a.com/x/", "https://a.com/x"));
  // 스킴/호스트 대소문자는 무시 (URL 파서가 정규화).
  assert.ok(isSameBrowserUrl("HTTP://Example.com/A", "http://example.com/A"));
  // 빈 ?/# 은 표기 차이일 뿐이다.
  assert.ok(isSameBrowserUrl("http://a.com/x?", "http://a.com/x"));
  assert.ok(isSameBrowserUrl("http://a.com/x#", "http://a.com/x/"));

  // 반대로: 경로·포트·query·hash 가 다르면 다른 페이지다 (열어야 한다).
  assert.ok(!isSameBrowserUrl("http://a.com/x", "http://a.com/y"));
  assert.ok(!isSameBrowserUrl("http://127.0.0.1:5432/", "http://127.0.0.1:5433/"));
  assert.ok(!isSameBrowserUrl("http://a.com/x?q=1", "http://a.com/x?q=2"));
  assert.ok(!isSameBrowserUrl("http://a.com/x#a", "http://a.com/x#b"));
  // 대문자 경로는 서로 다른 리소스일 수 있으므로 소문자화하지 않는다.
  assert.ok(!isSameBrowserUrl("https://a.com/A", "https://a.com/a"));
  // localhost 와 127.0.0.1 은 일부러 구분한다 — 추측이 늘면 오탐이 생긴다.
  assert.ok(!isSameBrowserUrl("http://localhost:5432/", "http://127.0.0.1:5432/"));
  // 빈 값은 무엇과도 같지 않다 (탭 없음이 "같은 페이지"가 되면 안 된다).
  assert.ok(!isSameBrowserUrl("", ""));
  assert.ok(!isSameBrowserUrl("", "http://a.com"));

  assert.equal(normalizeBrowserUrl("  http://a.com/x/  "), "http://a.com/x");
  assert.equal(normalizeBrowserUrl(""), "");
  console.log("✓ isSameBrowserUrl: 끝 슬래시·대소문자·빈 ?/# 은 같은 페이지, 경로/포트/query/hash 는 다른 페이지");
}

console.log("All browser-control-helpers smoke tests passed.");

// ─── coachTabsToClose — 코치 브라우징 탭을 하나로 유지한다 ───────────────────
{
  const { coachTabsToClose } = await import("../src/browserControlHelpers.ts");

  // 실사용에서 실제로 쌓였던 조합: 프리뷰 + 보아치과 2개 + 404
  const tabs = [
    "http://127.0.0.1:51884/index.html",   // 0 라이브 프리뷰
    "https://boaclinic.com/",              // 1
    "https://boaclinic.com/about",         // 2
    "https://boaclinic.com/about-us",      // 3 (404)
  ];
  // 다음에 /vision 을 연다 → 프리뷰만 남기고 바깥 탭 3개는 정리
  assert.deepEqual(coachTabsToClose(tabs, "https://boaclinic.com/vision"), [1, 2, 3]);

  // 이미 열려 있는 주소로 가면 그 탭은 남긴다 (재사용 대상)
  assert.deepEqual(coachTabsToClose(tabs, "https://boaclinic.com/about"), [1, 3]);

  // 음성 대조군 — 루프백은 어떤 경우에도 닫지 않는다
  for (const preview of [
    "http://127.0.0.1:51884/",
    "http://localhost:3000/index.html",
    "http://127.0.0.1:8080/a/b.html",
  ]) {
    assert.deepEqual(coachTabsToClose([preview], "https://example.com"), [],
      `루프백을 닫으면 안 된다: ${preview}`);
  }

  // 빈 값·빈 목록은 아무것도 닫지 않는다
  assert.deepEqual(coachTabsToClose([], "https://example.com"), []);
  assert.deepEqual(coachTabsToClose([undefined, ""], "https://example.com"), []);

  console.log("✓ coachTabsToClose: 프리뷰는 지키고 · 재사용 대상은 남기고 · 나머지만 정리");
}
