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

// ─── planCoachBrowserTabs — 슬롯당 탭 하나, 슬롯 간 불간섭 (#519) ────────────
{
  const { planCoachBrowserTabs, coachTabSlot } = await import("../src/browserControlHelpers.ts");

  // 슬롯 판정 — 루프백은 결과물, 나머지는 참고.
  assert.equal(coachTabSlot("http://127.0.0.1:51884/about.html"), "preview");
  assert.equal(coachTabSlot("http://localhost:3000/"), "preview");
  assert.equal(coachTabSlot("127.0.0.1:8080"), "preview", "스킴 없이 와도 루프백이다");
  assert.equal(coachTabSlot("https://boaclinic.com/"), "reference");
  assert.equal(coachTabSlot("file:///tmp/x.html"), "reference");

  // 실사용에서 실제로 쌓였던 조합: 프리뷰 + 보아치과 2개 + 404
  const tabs = [
    "http://127.0.0.1:51884/index.html",   // 0 라이브 프리뷰 (preview 슬롯)
    "https://boaclinic.com/",              // 1
    "https://boaclinic.com/about",         // 2
    "https://boaclinic.com/about-us",      // 3 (404)
  ];
  // 바깥 주소로 간다 → 참고 슬롯 첫 탭을 재사용, 나머지 참고 탭만 정리.
  // 프리뷰(0)는 목록에 없다 — 다른 슬롯은 건드리지 않는다.
  assert.deepEqual(planCoachBrowserTabs(tabs, "https://boaclinic.com/vision"),
    { reuse: 1, close: [2, 3] });

  // 이미 열려 있는 주소로 가면 **그 탭**을 고른다 (이동조차 필요 없다)
  assert.deepEqual(planCoachBrowserTabs(tabs, "https://boaclinic.com/about"),
    { reuse: 2, close: [1, 3] });

  // ── 회귀: 루프백 하위 페이지 (#519 주 원인) ──────────────────────────────
  // 전신 coachTabsToClose 는 루프백을 정리 대상에서 통째로 뺐고, 재사용 개념이
  // 없어 4번 탐색에 탭 4개가 쌓였다. 이제 프리뷰 탭 하나를 계속 이동시킨다.
  assert.deepEqual(
    planCoachBrowserTabs(["http://127.0.0.1:51884/"], "http://127.0.0.1:51884/about.html"),
    { reuse: 0, close: [] },
    "결과물 하위 페이지는 프리뷰 탭을 이동시켜 본다 — 새 탭이 아니다",
  );
  // 이미 쌓여 있던 레거시 프리뷰 탭들은 하나만 남기고 정리된다.
  assert.deepEqual(
    planCoachBrowserTabs(
      ["http://127.0.0.1:51884/", "http://127.0.0.1:51884/about.html", "http://127.0.0.1:51884/contact.html"],
      "http://127.0.0.1:51884/about.html",
    ),
    { reuse: 1, close: [0, 2] },
  );

  // ── 양성 대조군: 두 슬롯은 공존해야 한다 ────────────────────────────────
  // 커리큘럼이 "정답지와 내 결과물을 비교"를 요구한다(코호트 프롬프트 :107-109).
  // 전신은 다음 주소가 루프백일 때도 바깥 탭을 전부 닫아서 정답지를 죽였다.
  const both = ["http://127.0.0.1:51884/", "https://boaclinic.com/"];
  assert.deepEqual(planCoachBrowserTabs(both, "http://127.0.0.1:51884/about.html"),
    { reuse: 0, close: [] }, "프리뷰로 이동해도 정답지 탭은 살아 있어야 한다");
  assert.deepEqual(planCoachBrowserTabs(both, "https://boaclinic.com/vision"),
    { reuse: 1, close: [] }, "정답지로 이동해도 결과물 탭은 살아 있어야 한다");

  // ── 음성 대조군: 슬롯이 비어 있으면 새로 연다 ───────────────────────────
  assert.deepEqual(planCoachBrowserTabs([], "https://example.com"), { reuse: null, close: [] });
  assert.deepEqual(planCoachBrowserTabs([undefined, ""], "https://example.com"),
    { reuse: null, close: [] }, "빈 값은 재사용 대상이 아니다");
  assert.deepEqual(planCoachBrowserTabs(["http://127.0.0.1:51884/"], "https://example.com"),
    { reuse: null, close: [] }, "참고 슬롯이 비었으면 프리뷰를 뺏지 않고 새로 연다");

  console.log("✓ planCoachBrowserTabs: 슬롯당 하나 재사용 · 잉여만 정리 · 다른 슬롯 불간섭");
}

// ─── 탭 개수 회귀 그물 — 아무리 탐색해도 슬롯 수(2)를 넘지 않는다 (#519) ─────
// 이 스위트가 e2e 없이 잡을 수 있는 유일한 누적 회귀다. 순수 함수만으로 host의
// openBrowser 상태 전이(닫기 → 재사용 or 새 탭)를 그대로 재현한다.
{
  const { planCoachBrowserTabs } = await import("../src/browserControlHelpers.ts");

  /** host.openBrowser 한 번의 탭 목록 전이. 구현과 같은 순서: 닫고 → 이동 or 열기. */
  function step(tabs, url) {
    const plan = planCoachBrowserTabs(tabs, url);
    const next = tabs.filter((_, i) => !plan.close.includes(i));
    if (plan.reuse === null) return [...next, url];          // 새 탭
    const reuseUrl = tabs[plan.reuse];
    return next.map((u) => (u === reuseUrl ? url : u));      // 기존 탭을 이동
  }

  const base = "http://127.0.0.1:51884";
  const walk = [
    `${base}/`,
    "https://boaclinic.com/",
    `${base}/about.html`,
    "https://boaclinic.com/about",
    `${base}/contact.html`,
    `${base}/about.html`,               // 재방문
    "https://boaclinic.com/vision",
    `${base}/`,
  ];
  let tabs = [];
  for (const url of walk) {
    tabs = step(tabs, url);
    assert.ok(tabs.length <= 2, `탐색 ${url} 뒤 탭이 ${tabs.length}개 — 슬롯 수(2)를 넘었다`);
  }
  // 마지막 상태: 결과물 하나 + 정답지 하나, 각각 마지막으로 간 주소.
  assert.deepEqual(tabs.sort(), ["http://127.0.0.1:51884/", "https://boaclinic.com/vision"]);

  // 프리뷰만 계속 도는 경우 (주 원인 시나리오) — 끝까지 탭 1개.
  let only = [];
  for (const p of ["/", "/about.html", "/contact.html", "/about.html", "/pricing.html"]) {
    only = step(only, `${base}${p}`);
    assert.equal(only.length, 1, `결과물 탐색은 탭 1개여야 한다 (${p} 뒤 ${only.length}개)`);
  }

  console.log("✓ 탭 누적 회귀: 8회 혼합 탐색 후에도 탭 2개 · 결과물 단독 탐색은 1개");
}

// #525 — 앞으로 가져올 탭 고르기. 확장에는 "이 탭이 그 브라우저 탭"이라는 식별자가
// 없다(tabs DTO 에서 BrowserEditorInput 이 UnknownInput 으로 떨어져 input===undefined).
// 그래서 세 조건 교집합으로만 고르고, 애매하면 **아무것도 안 한다.**
//
// 여기 숫자와 문자열은 2026-08-02 실측(설치된 0.1.16, 격리 프로파일)에서 나온 것이다:
//   tab.label            = "Example Domain"
//   BrowserTab.title     = "Example Domain (https://example.com/)"
//   example.com/.org 라벨이 **동일**했다 → 라벨은 동점을 만든다.
{
  const { pickRevealTabIndex } = await import("../src/browserControlHelpers.ts");
  const T = (index, label, inputIsUndefined, isActive = false) =>
    ({ index, label, inputIsUndefined, isActive });
  const TITLE = "Example Domain (https://example.com/)";

  // 양성 — 배경에 있는 그 브라우저 탭 하나를 정확히 고른다.
  assert.equal(
    pickRevealTabIndex(
      [T(0, "index.html", false), T(1, "Example Domain", true), T(2, "notes.md", false)],
      TITLE,
    ),
    1,
  );

  // 양성 — 라벨이 30자에서 잘려 `…` 로 끝나도 접두사로 인정한다(코어 getName 은 truncate).
  assert.equal(
    pickRevealTabIndex([T(0, "보아치과 강남점 임플란트 전문…", true)], "보아치과 강남점 임플란트 전문 클리닉 (https://boaclinic.com/)"),
    0,
  );

  // ── 음성 대조군: 여기가 틀리면 참가자 화면이 엉뚱하게 바뀐다 ──────────────

  // **후보 2개 = 아무것도 안 한다.** 실측에서 example.com 과 example.org 의 라벨이
  // 둘 다 "Example Domain" 이었다. 하나를 찍으면 50% 확률로 남의 화면을 바꾼다.
  assert.equal(
    pickRevealTabIndex([T(0, "Example Domain", true), T(1, "Example Domain", true)], TITLE),
    null,
    "라벨 동점이면 손대지 않는다",
  );

  // input 이 정의된 탭(텍스트 편집기 등)은 후보가 아니다 — 라벨이 우연히 맞아도.
  assert.equal(pickRevealTabIndex([T(0, "Example Domain", false)], TITLE), null);

  // input===undefined 지만 라벨이 안 맞으면 후보 아님. 웰컴/시작하기·설정 편집기도
  // UnknownInput 이라 여기 걸린다 — 그것을 앞세우면 안 된다.
  assert.equal(pickRevealTabIndex([T(0, "시작하기", true), T(1, "설정", true)], TITLE), null);

  // 웰컴 탭이 **같이 있어도** 진짜 후보가 하나면 고른다 (교집합이 일하는 자리).
  assert.equal(
    pickRevealTabIndex([T(0, "시작하기", true), T(1, "Example Domain", true)], TITLE),
    1,
  );

  // 이미 활성이면 할 일이 없다 — 포커스만 흔들 뿐.
  assert.equal(pickRevealTabIndex([T(0, "Example Domain", true, true)], TITLE), null);

  // 후보 없음 / 제목 없음 / 빈 목록 → 전부 null (조용히 아무것도 안 한다).
  assert.equal(pickRevealTabIndex([], TITLE), null);
  assert.equal(pickRevealTabIndex([T(0, "Example Domain", true)], undefined), null);
  assert.equal(pickRevealTabIndex([T(0, "", true)], TITLE), null, "빈 라벨은 모든 제목의 접두사가 되면 안 된다");
  assert.equal(pickRevealTabIndex([T(0, "   ", true)], TITLE), null);

  console.log("✓ #525: 앞세울 탭 고르기 — 세 조건 교집합, 애매하면 손대지 않는다");
}
