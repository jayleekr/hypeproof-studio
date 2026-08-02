// Smoke tests for the in-process "hypeproof" browser MCP server builder
// (#282 P2 slice 2, REQ-M19/M20). Pure — no vscode, no SDK: the factory
// (createSdkMcpServer/tool), zod, and the host capabilities are all injected
// fakes, so we can lock the tool wiring + handler safety contract offline.
// Run: node --experimental-strip-types test/browser-mcp.smoke.mjs

import assert from "node:assert/strict";

const {
  buildHypeproofMcpServer,
  HYPEPROOF_MCP_SERVER_NAME,
  MCP_BROWSER_OPEN,
  MCP_BROWSER_SCREENSHOT,
  MCP_LIVE_PREVIEW_START,
  MCP_BROWSER_TOOLS,
  resolveAlreadyOpen,
} = await import("../src/browserMcp.ts");
// 판정과 **같은 비교 함수**로 매칭한다 — fake 가 자기 규칙으로 찾으면 계측기가
// 제품보다 관대해지고, 실기기에서만 갈라지는 차이를 못 잡는다.
const { isSameBrowserUrl } = await import("../src/browserControlHelpers.ts");

// ─── constants — names the model/canUseTool sees must never drift ────────────
{
  assert.equal(HYPEPROOF_MCP_SERVER_NAME, "hypeproof");
  assert.deepEqual(
    [...MCP_BROWSER_TOOLS],
    ["mcp__hypeproof__browser_open", "mcp__hypeproof__browser_screenshot", "mcp__hypeproof__live_preview_start",
     "mcp__hypeproof__browser_read", "mcp__hypeproof__browser_click", "mcp__hypeproof__browser_type"],
    "full MCP tool names = mcp__<server>__<tool> — the canUseTool contract",
  );
  // The full names must be derivable from the server name + short names the
  // factory registers (a rename in one place must break this test).
  assert.equal(MCP_BROWSER_OPEN, `mcp__${HYPEPROOF_MCP_SERVER_NAME}__browser_open`);
  assert.equal(MCP_BROWSER_SCREENSHOT, `mcp__${HYPEPROOF_MCP_SERVER_NAME}__browser_screenshot`);
  assert.equal(MCP_LIVE_PREVIEW_START, `mcp__${HYPEPROOF_MCP_SERVER_NAME}__live_preview_start`);
}

// Fakes: capture what the builder registers; the fake zod marks schemas.
function makeFactory() {
  const registered = [];
  let serverOpts = null;
  return {
    factory: {
      tool: (name, description, inputSchema, handler) => {
        const def = { name, description, inputSchema, handler };
        registered.push(def);
        return def;
      },
      createSdkMcpServer: (opts) => {
        serverOpts = opts;
        return { __server: true, opts };
      },
    },
    registered,
    getServerOpts: () => serverOpts,
  };
}
const fakeZ = { string: () => ({ __zod: "string" }) };

// ─── builder wiring — 3 tools on the "hypeproof" server, exact short names ──
{
  const { factory, registered, getServerOpts } = makeFactory();
  const host = {
    openBrowser: async () => {},
    screenshot: async () => null,
    startLivePreview: async () => null,
  };
  const server = buildHypeproofMcpServer(factory, fakeZ, host);
  assert.ok(server && server.__server, "returns the created server instance");
  const opts = getServerOpts();
  assert.equal(opts.name, HYPEPROOF_MCP_SERVER_NAME, "server registered under 'hypeproof'");
  assert.deepEqual(
    registered.map((t) => t.name),
    ["browser_open", "browser_screenshot", "live_preview_start",
     "browser_read", "browser_click", "browser_type"],
    "short tool names (SDK prefixes mcp__hypeproof__ itself)",
  );
  assert.equal(opts.tools.length, 6, "여섯 도구 전부 서버에 붙는다 (#457 검사 3종 포함)");
  // browser_open takes a url string; the parameterless tools take {}.
  const open = registered.find((t) => t.name === "browser_open");
  assert.deepEqual(open.inputSchema, { url: { __zod: "string" } });
  assert.deepEqual(registered.find((t) => t.name === "browser_screenshot").inputSchema, {});
  assert.deepEqual(registered.find((t) => t.name === "live_preview_start").inputSchema, {});
  // Korean descriptions — the model reads these; they must mention the gate.
  assert.ok(open.description.includes("승인"), "browser_open description declares the approval gate");
}

// ─── browser_open handler — URL policy re-validated (belt over suspenders) ──
{
  const { factory, registered } = makeFactory();
  const opened = [];
  buildHypeproofMcpServer(factory, fakeZ, {
    openBrowser: async (url) => { opened.push(url); },
    screenshot: async () => null,
    startLivePreview: async () => null,
  });
  const open = registered.find((t) => t.name === "browser_open");

  // Policy-clean URL → host called with the NORMALIZED URL.
  const ok = await open.handler({ url: "localhost:5173" }, {});
  assert.deepEqual(opened, ["http://localhost:5173"], "bare localhost normalized to http://");
  assert.equal(ok.isError, undefined);
  assert.ok(ok.content[0].text.includes("http://localhost:5173"));

  // Hostile scheme → isError result, host NEVER called — even though
  // canUseTool should have denied it earlier (defense in depth).
  for (const url of ["javascript:alert(1)", "vscode://x", "data:text/html,hi", ""]) {
    const res = await open.handler({ url }, {});
    assert.equal(res.isError, true, `hostile/empty URL ${JSON.stringify(url)} → isError`);
  }
  assert.equal(opened.length, 1, "host.openBrowser never called for rejected URLs");
}

// ─── browser_screenshot handler — image content for vision, isError on none ─
{
  const { factory, registered } = makeFactory();
  let shot = null;
  buildHypeproofMcpServer(factory, fakeZ, {
    openBrowser: async () => {},
    screenshot: async () => shot,
    startLivePreview: async () => null,
  });
  const screenshot = registered.find((t) => t.name === "browser_screenshot");

  // No open tab → isError text the coach can react to (no throw, no toast).
  const none = await screenshot.handler({}, {});
  assert.equal(none.isError, true);
  assert.equal(none.content[0].type, "text");

  // Captured tab → MCP image block (base64 + mimeType) so the model SEES it,
  // plus a title/url label for grounding.
  shot = { imageBase64: "aGVsbG8=", mimeType: "image/jpeg", url: "http://127.0.0.1:7777/", title: "내 게임" };
  const some = await screenshot.handler({}, {});
  assert.equal(some.isError, undefined);
  assert.deepEqual(some.content[0], { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" });
  assert.equal(some.content[1].type, "text");
  assert.ok(some.content[1].text.includes("내 게임") && some.content[1].text.includes("http://127.0.0.1:7777/"));
}

// ─── live_preview_start handler — returns the server URL / isError on fail ──
{
  const { factory, registered } = makeFactory();
  let url = null;
  buildHypeproofMcpServer(factory, fakeZ, {
    openBrowser: async () => {},
    screenshot: async () => null,
    startLivePreview: async () => url,
  });
  const preview = registered.find((t) => t.name === "live_preview_start");

  const fail = await preview.handler({}, {});
  assert.equal(fail.isError, true, "no workspace / server failure → isError");

  url = "http://127.0.0.1:5432/";
  const ok = await preview.handler({}, {});
  assert.equal(ok.isError, undefined);
  assert.ok(ok.content[0].text.includes(url), "tool result carries the live-server URL");
}

// ─── #415 현재 페이지 인지 — 이미 열린 페이지를 또 열지 않는다 ──────────────
//
// WHY: 코치는 브라우저 상태를 읽을 수단이 없어 매번 새로 여는 게 유일한
// 선택지였다. 다시 열 때마다 학생에게 승인 모달이 뜨고(승인 게이트가 교육
// 장치인데 무의미한 반복이 그 의미를 마모시킨다), 보던 페이지가 리로드되고,
// 턴 예산이 깎인다. 실사용 2026-07-24.

// 현재 페이지를 들고 있는 fake 호스트 — 진짜 통합 브라우저 탭의 최소 모델.
function makeHost(initial = null) {
  const state = { page: initial, opens: [], previews: 0 };
  return {
    state,
    host: {
      openBrowser: async (url) => {
        state.opens.push(url);
        state.page = { url, title: "열린 페이지" };
      },
      screenshot: async () =>
        state.page
          ? { imageBase64: "aGk=", mimeType: "image/jpeg", url: state.page.url, title: state.page.title }
          : null,
      startLivePreview: async () => {
        // 실제 호스트(chatPanelProvider.startLivePreview)도 서버를 띄우고
        // **브라우저까지 연다** — 그래서 이후 상태는 프리뷰 URL 이다.
        state.previews += 1;
        const url = "http://127.0.0.1:56767/";
        state.page = { url, title: "내 페이지" };
        return url;
      },
      currentPage: async () => state.page,
    },
  };
}

// 같은 URL → 열지 않는다 + "이미 열려 있어요" 결과 + 상태 줄.
{
  const { factory, registered } = makeFactory();
  const { host, state } = makeHost({ url: "http://127.0.0.1:5432/", title: "내 게임" });
  buildHypeproofMcpServer(factory, fakeZ, host);
  const open = registered.find((t) => t.name === "browser_open");

  const res = await open.handler({ url: "http://127.0.0.1:5432/" }, {});
  assert.equal(res.isError, undefined, "이미 열려 있는 건 에러가 아니다 — 정상 결과");
  assert.equal(state.opens.length, 0, "host.openBrowser 를 부르지 않는다 → 승인 모달·리로드 없음");
  assert.ok(res.content[0].text.includes("이미"), "결과가 '이미 열려 있다'고 말한다");
  assert.ok(
    res.content.at(-1).text.includes("현재 열린 페이지: http://127.0.0.1:5432/"),
    "결과 끝에 브라우저 상태 한 줄 — 모델이 상태를 도구 결과로 계속 학습한다",
  );

  // 끝 슬래시만 다른 표기도 같은 페이지다 (모델이 슬래시를 빼고 부른다).
  const res2 = await open.handler({ url: "http://127.0.0.1:5432" }, {});
  assert.equal(state.opens.length, 0, "끝 슬래시 차이로 중복 오픈이 나면 안 된다");
  assert.ok(res2.content[0].text.includes("이미"));

  // 다른 URL → 실제로 연다 + 상태 줄은 방금 연 주소.
  const res3 = await open.handler({ url: "http://127.0.0.1:5432/about" }, {});
  assert.deepEqual(state.opens, ["http://127.0.0.1:5432/about"], "다른 페이지는 정상적으로 연다");
  assert.ok(res3.content[0].text.includes("열었어요"));
  assert.ok(res3.content.at(-1).text.includes("현재 열린 페이지: http://127.0.0.1:5432/about"));
}

// resolveAlreadyOpen — 승인 모달(canUseTool)과 핸들러가 공유하는 단일 판정.
// WHY 단일 소스: 모달은 핸들러보다 **먼저** 뜬다. 모달을 건너뛰려면 canUseTool
// 도 같은 판정을 해야 하는데, 둘이 갈라지면 "모달 없이 실제로 열리는" 구멍이
// 된다 — 그래서 sdkCoach 의 canUseTool 도 이 함수를 그대로 쓴다.
{
  const { host } = makeHost({ url: "http://127.0.0.1:5432/", title: "내 게임" });
  assert.equal((await resolveAlreadyOpen(host, "http://127.0.0.1:5432")).alreadyOpen, true);
  assert.equal((await resolveAlreadyOpen(host, "127.0.0.1:5432")).alreadyOpen, true, "정책 정규화 후 비교");
  assert.equal((await resolveAlreadyOpen(host, "http://127.0.0.1:5432/x")).alreadyOpen, false);
  // 정책 위반 URL 은 '이미 열림'이 될 수 없다 — deny 경로를 우회하면 안 된다.
  const bad = await resolveAlreadyOpen(host, "javascript:alert(1)");
  assert.equal(bad.alreadyOpen, false);
  assert.equal(bad.url, null);
  // 비문자열 입력도 안전하게 false (모달 우회 방지).
  assert.equal((await resolveAlreadyOpen(host, undefined)).alreadyOpen, false);
  assert.equal((await resolveAlreadyOpen(host, { url: "x" })).alreadyOpen, false);
  // 능력 미지원 호스트 → 모른다 → false (평소대로 모달 + 열기).
  const dumb = { openBrowser: async () => {}, screenshot: async () => null, startLivePreview: async () => null };
  assert.equal((await resolveAlreadyOpen(dumb, "http://127.0.0.1:5432/")).alreadyOpen, false);
}

// #519 — openPages: 슬롯이 둘이므로 "지금 보는 페이지" 하나로는 부족하다.
{
  // 코치는 정답지를 보는 중이고(currentPage), 참가자 결과물은 다른 슬롯에 떠 있다.
  const base = {
    openBrowser: async () => {},
    screenshot: async () => null,
    startLivePreview: async () => null,
    currentPage: async () => ({ url: "https://boaclinic.com/", title: "보아치과" }),
  };
  const twoSlots = {
    ...base,
    openPages: async () => [
      { url: "http://127.0.0.1:5432/", title: "내 홈페이지" },
      { url: "https://boaclinic.com/", title: "보아치과" },
    ],
  };
  // 양성 대조군 — 다른 슬롯에 이미 떠 있으면 모달 없이 통과해야 한다.
  assert.equal((await resolveAlreadyOpen(twoSlots, "http://127.0.0.1:5432")).alreadyOpen, true,
    "다른 슬롯에 이미 떠 있는 페이지에 승인 모달이 또 뜨면 안 된다");
  assert.equal((await resolveAlreadyOpen(twoSlots, "https://boaclinic.com/")).alreadyOpen, true);

  // 음성 대조군 — 안 떠 있는 주소는 여전히 모달을 거친다(게이트 우회 금지).
  assert.equal((await resolveAlreadyOpen(twoSlots, "https://boaclinic.com/vision")).alreadyOpen, false);
  assert.equal((await resolveAlreadyOpen(twoSlots, "http://127.0.0.1:5432/about.html")).alreadyOpen, false);
  // 정책 위반은 openPages 가 있어도 절대 통과 못 한다.
  assert.equal((await resolveAlreadyOpen(twoSlots, "javascript:alert(1)")).alreadyOpen, false);

  // openPages 없는 호스트는 예전 동작(currentPage 비교) 그대로 — 능력은 optional.
  assert.equal((await resolveAlreadyOpen(base, "http://127.0.0.1:5432")).alreadyOpen, false);
  assert.equal((await resolveAlreadyOpen(base, "https://boaclinic.com/")).alreadyOpen, true);

  // 조회가 던지거나 이상한 값을 주면 '모름' → currentPage 폴백 (짐작하지 않는다).
  const broken = { ...base, openPages: async () => { throw new Error("탭 조회 실패"); } };
  assert.equal((await resolveAlreadyOpen(broken, "https://boaclinic.com/")).alreadyOpen, true);
  assert.equal((await resolveAlreadyOpen(broken, "http://127.0.0.1:5432")).alreadyOpen, false);
  const junk = { ...base, openPages: async () => null };
  assert.equal((await resolveAlreadyOpen(junk, "https://boaclinic.com/")).alreadyOpen, true);

  console.log("✓ #519: openPages — 열린 탭 전부와 비교(슬롯 2개), 미지원/실패는 예전 동작으로 폴백");
}

// #523 — "안 여는" 것으로 끝나면 안 된다: 매칭된 탭을 **운전 대상으로 고정**해야
// 한다. 안 그러면 뒤이은 read/click/type 이 직전 타깃(다른 슬롯)에 붙어, 코치가
// A 를 본다고 믿으며 B 를 읽는다. #522 가 판정 범위를 열린 탭 전체로 넓히면서
// 실제로 가능해진 상태다(그 전에는 매칭 = 타깃이라 무해했다).
{
  // 재현 시나리오: 참고 사이트를 보다가 프리뷰로 옮겨간 뒤, 다시 참고 사이트를
  // 열어달라는 요청. 그 탭은 이미 떠 있으므로 열리지 않는다 — 그런데 타깃은?
  const PREVIEW = { url: "http://127.0.0.1:5432/", title: "내 홈페이지" };
  const REFERENCE = { url: "https://boaclinic.com/", title: "보아치과" };
  function makeTwoSlotHost() {
    // targetTab 을 흉내낸다: 지금 운전 중인 페이지(=프리뷰). 실기기에서는
    // live_preview_start 가 setTargetTab 으로 여기까지 옮겨놓은 상태다.
    const state = { target: PREVIEW, opens: [] };
    return {
      state,
      host: {
        openBrowser: async (url) => state.opens.push(url),
        screenshot: async () => null,
        startLivePreview: async () => null,
        currentPage: async () => state.target,
        openPages: async () => [PREVIEW, REFERENCE],
        focusOpenPage: async (url) => {
          const hit = [PREVIEW, REFERENCE].find((p) => isSameBrowserUrl(p.url, url));
          if (!hit) return null;
          state.target = hit;      // ← setTargetTab 에 대응
          return hit;
        },
      },
    };
  }

  // 양성 대조군 — 백그라운드 슬롯의 URL 로 열면, 열지는 않되 **타깃은 그 탭으로**.
  {
    const { factory, registered } = makeFactory();
    const { host, state } = makeTwoSlotHost();
    buildHypeproofMcpServer(factory, fakeZ, host);
    const open = registered.find((t) => t.name === "browser_open");

    const res = await open.handler({ url: "https://boaclinic.com/" }, {});
    assert.equal(state.opens.length, 0, "이미 떠 있으므로 열지 않는다 (#415 유지)");
    assert.equal(
      state.target.url,
      REFERENCE.url,
      "매칭된 탭이 운전 대상이어야 한다 — 안 그러면 다음 browser_read 가 프리뷰를 읽는다",
    );
    const text = res.content.map((c) => c.text).join("\n");
    assert.ok(text.includes("이미"));
    assert.ok(
      text.includes(`현재 열린 페이지: ${REFERENCE.url}`),
      "상태 줄도 매칭된 탭이어야 한다 — 한 결과 안에서 두 줄이 다른 페이지를 말하면 안 된다",
    );
    assert.ok(!text.includes(PREVIEW.url), "직전 타깃(프리뷰)이 상태 줄에 남으면 안 된다");
  }

  // 음성 대조군 ① — 이미 타깃인 페이지를 다시 열어도 타깃은 그대로다(무해한 재지정).
  {
    const { factory, registered } = makeFactory();
    const { host, state } = makeTwoSlotHost();
    buildHypeproofMcpServer(factory, fakeZ, host);
    const open = registered.find((t) => t.name === "browser_open");

    await open.handler({ url: "http://127.0.0.1:5432" }, {});   // 끝 슬래시 없이
    assert.equal(state.opens.length, 0);
    assert.equal(state.target.url, PREVIEW.url, "정규화 차이로 타깃이 튀면 안 된다");
  }

  // 음성 대조군 ② — 안 떠 있는 주소는 평소대로 **열리고**, 고정은 openBrowser 가
  // 한다(이 경로는 예전부터 setTargetTab 을 태운다). focusOpenPage 는 안 불린다.
  {
    const { factory, registered } = makeFactory();
    const { host, state } = makeTwoSlotHost();
    let focusCalls = 0;
    const spied = { ...host, focusOpenPage: async (u) => { focusCalls++; return host.focusOpenPage(u); } };
    buildHypeproofMcpServer(factory, fakeZ, spied);
    const open = registered.find((t) => t.name === "browser_open");

    await open.handler({ url: "https://boaclinic.com/vision" }, {});
    assert.equal(state.opens.length, 1, "안 떠 있는 주소는 열어야 한다");
    assert.equal(focusCalls, 0, "여는 경로에서 focusOpenPage 를 부를 이유가 없다");
  }

  // 음성 대조군 ③ — 능력 없는 호스트(구버전·다른 fake)에서도 죽지 않고 예전 동작.
  {
    const { factory, registered } = makeFactory();
    const { host, state } = makeTwoSlotHost();
    delete host.focusOpenPage;
    buildHypeproofMcpServer(factory, fakeZ, host);
    const open = registered.find((t) => t.name === "browser_open");

    const res = await open.handler({ url: "https://boaclinic.com/" }, {});
    assert.equal(state.opens.length, 0);
    assert.equal(state.target.url, PREVIEW.url, "능력이 없으면 예전 동작 그대로");
    assert.ok(res.content.map((c) => c.text).join("\n").includes("이미"));
  }

  // 음성 대조군 ④ — 고정이 던지거나 null 이어도 결과가 오류로 바뀌면 안 된다.
  // "이미 열려 있다"는 판정 자체는 여전히 유효하다.
  {
    for (const broken of [
      async () => { throw new Error("탭이 방금 닫혔다"); },
      async () => null,
      async () => ({ title: "url 없음" }),
    ]) {
      const { factory, registered } = makeFactory();
      const { host } = makeTwoSlotHost();
      host.focusOpenPage = broken;
      buildHypeproofMcpServer(factory, fakeZ, host);
      const open = registered.find((t) => t.name === "browser_open");

      const res = await open.handler({ url: "https://boaclinic.com/" }, {});
      assert.ok(!res.isError, "고정 실패가 멀쩡한 결과를 오류로 바꾸면 안 된다");
      assert.ok(res.content.map((c) => c.text).join("\n").includes("이미"));
    }
  }

  console.log("✓ #523: alreadyOpen — 열지 않되 매칭된 탭을 운전 대상으로 고정 + 상태 줄도 그 탭");
}

// #526 — "열었어요"가 사실이 아닐 때가 있다. 슬롯당 탭 하나(#519)라 같은 슬롯에
// 탭이 있으면 그 탭이 이 주소로 **이동**하고, 보고 있던 페이지는 화면에서 사라진다.
// 결과가 그걸 말하지 않으면 코치는 참고 사이트 둘이 나란히 떠 있다고 믿고 없는
// 화면을 설명한다(지어낸 성공 — R0 와 같은 실패 계열).
//
// 슬롯 개수는 늘리지 않는다(#519 의 목적이 탭 누적 방지다). 여기서 고치는 것은
// **한계를 숨기지 않는 것**이다.
{
  function makeSlotHost(replaced) {
    const state = { opens: [] };
    return {
      state,
      host: {
        openBrowser: async (url) => {
          state.opens.push(url);
          return replaced ? { replaced } : undefined;
        },
        screenshot: async () => null,
        startLivePreview: async () => null,
        currentPage: async () => null,
        openPages: async () => [],
      },
    };
  }
  const openOf = (host) => {
    const { factory, registered } = makeFactory();
    buildHypeproofMcpServer(factory, fakeZ, host);
    return registered.find((t) => t.name === "browser_open");
  };

  // 양성 대조군 — 참고 슬롯에 있던 다른 사이트가 밀려나면 결과가 그것을 말한다.
  {
    const { host, state } = makeSlotHost({ url: "https://boaclinic.com/", title: "보아치과" });
    const res = await openOf(host).handler({ url: "https://otherclinic.com/" }, {});
    const text = res.content.map((c) => c.text).join("\n");
    assert.equal(state.opens.length, 1);
    assert.ok(text.includes("https://otherclinic.com/"), "요청한 주소는 그대로 보고한다");
    assert.ok(text.includes("보아치과"), "밀려난 페이지를 이름으로 알려준다");
    assert.ok(
      text.includes("이동했어요"),
      "밀려났다는 사실을 말해야 코치가 '나란히 떠 있다'고 착각하지 않는다",
    );
    assert.ok(
      /참고 사이트 1개|번갈아/.test(text),
      "왜 그런지(자리가 하나씩)를 같이 줘야 코치가 참가자에게 설명할 수 있다",
    );
    assert.ok(!res.isError, "정상 동작이다 — 오류가 아니다");
  }

  // 음성 대조군 ① — 밀려난 게 없으면 예전 문장 그대로. 없는 상실을 지어내지 않는다.
  {
    const { host } = makeSlotHost(undefined);
    const res = await openOf(host).handler({ url: "https://boaclinic.com/" }, {});
    const text = res.content.map((c) => c.text).join("\n");
    assert.equal(text.split("\n")[0], "브라우저에서 열었어요: https://boaclinic.com/");
    assert.ok(!text.includes("이동했어요"));
  }

  // 음성 대조군 ② — 같은 주소가 "밀려났다"고 보고돼도 참가자 눈엔 아무것도 안
  // 사라졌다. 그걸 상실로 적으면 코치에게 없는 사실을 가르친다(정규화 차이 포함).
  {
    for (const same of ["https://boaclinic.com/", "https://boaclinic.com"]) {
      const { host } = makeSlotHost({ url: same, title: "보아치과" });
      const res = await openOf(host).handler({ url: "https://boaclinic.com/" }, {});
      assert.ok(
        !res.content.map((c) => c.text).join("\n").includes("이동했어요"),
        `같은 주소(${same})는 상실이 아니다`,
      );
    }
  }

  // 음성 대조군 ③ — 구버전 호스트(void 반환)·기형 값에도 죽지 않는다.
  {
    for (const bad of [undefined, null, {}, { replaced: null }, { replaced: { title: "url 없음" } }]) {
      const opens = [];
      const host = {
        openBrowser: async (url) => { opens.push(url); return bad; },
        screenshot: async () => null,
        startLivePreview: async () => null,
        currentPage: async () => null,
        openPages: async () => [],
      };
      const res = await openOf(host).handler({ url: "https://boaclinic.com/" }, {});
      assert.ok(!res.isError);
      assert.equal(opens.length, 1);
      assert.ok(res.content.map((c) => c.text).join("\n").includes("브라우저에서 열었어요"));
    }
  }

  // 양성 대조군 ② — **교정과 밀려남이 동시에** 일어나는 경우 (#507 + #526 합류).
  //
  // 성립한다: 라이브 서버가 58085 에 떠 있는데 코치가 3000 을 찍으면 주소가
  // 교정되고(#507), 교정된 주소는 여전히 루프백이라 프리뷰 슬롯을 쓰므로 그
  // 슬롯에 떠 있던 다른 페이지가 밀려난다(#526). 두 사실을 다 말해야 한다.
  //
  // **순서가 계약이다**: 교정이 먼저. 교정은 코치가 방금 한 행동의 *대상 자체*를
  // 바꾸는 정보이고 밀려남은 그 부수 효과라, 뒤집으면 코치가 잘못된 대상 위에서
  // 해석을 시작한다.
  {
    const opens = [];
    const host = {
      openBrowser: async (url) => {
        opens.push(url);
        return { replaced: { url: "http://127.0.0.1:58085/", title: "내 홈페이지" } };
      },
      screenshot: async () => null,
      startLivePreview: async () => null,
      currentPage: async () => null,
      openPages: async () => [],
      livePreviewUrl: async () => "http://127.0.0.1:58085/",
    };
    const res = await openOf(host).handler({ url: "http://127.0.0.1:3000/about.html" }, {});
    assert.deepEqual(opens, ["http://127.0.0.1:58085/about.html"], "교정된 주소로 연다");
    const text = res.content.map((c) => c.text).join("\n");

    // #507 쪽이 살아 있는가
    assert.ok(text.includes("3000"), "무엇을 고쳤는지 말한다 (#507)");
    assert.ok(text.includes("58085"), "실제 주소를 말한다 (#507)");
    // #526 쪽이 살아 있는가
    assert.ok(text.includes("내 홈페이지"), "밀려난 페이지를 말한다 (#526)");
    assert.ok(text.includes("이동했어요"), "밀려났다는 사실을 말한다 (#526)");

    // 한쪽 문장만 남고 다른 쪽이 조용히 사라지는 회귀를 잡는다.
    const correction = text.indexOf("이 아니라 실제 라이브 서버 주소로 열었어요");
    const displacement = text.indexOf("같은 자리에 있던");
    assert.ok(correction >= 0, "교정 문장이 통째로 사라지면 안 된다");
    assert.ok(displacement >= 0, "밀려남 문장이 통째로 사라지면 안 된다");
    assert.ok(
      correction < displacement,
      "교정이 먼저 읽혀야 한다 — 순서가 뒤집히면 코치가 잘못된 대상 위에서 해석한다",
    );
  }

  console.log("✓ #526: 슬롯이 하나뿐이라 밀려난 페이지를 결과가 숨기지 않는다 (슬롯 개수는 그대로)");
}

// 탭이 아예 없으면(null) 열어야 한다 + 상태 줄은 "없음".
{
  const { factory, registered } = makeFactory();
  const { host, state } = makeHost(null);
  buildHypeproofMcpServer(factory, fakeZ, host);
  const open = registered.find((t) => t.name === "browser_open");
  await open.handler({ url: "https://example.com" }, {});
  assert.deepEqual(state.opens, ["https://example.com"], "열린 탭이 없으면 당연히 연다");

  const screenshot = registered.find((t) => t.name === "browser_screenshot");
  state.page = null;
  const none = await screenshot.handler({}, {});
  assert.equal(none.isError, true);
  assert.ok(
    none.content.at(-1).text.includes("현재 열린 페이지: 없음"),
    "실패 결과도 상태를 알려줘야 코치가 '먼저 열어야겠다'를 알 수 있다",
  );
}

// currentPage 미지원 호스트 → 예전처럼 무조건 연다 (능력은 optional).
{
  const { factory, registered } = makeFactory();
  const opened = [];
  buildHypeproofMcpServer(factory, fakeZ, {
    openBrowser: async (url) => { opened.push(url); },
    screenshot: async () => null,
    startLivePreview: async () => null,
    // currentPage 없음
  });
  const open = registered.find((t) => t.name === "browser_open");
  const res = await open.handler({ url: "https://example.com" }, {});
  assert.deepEqual(opened, ["https://example.com"], "상태를 모르면 여는 쪽이 안전한 폴백");
  assert.ok(res.content[0].text.includes("열었어요"));
  // 방금 연 주소는 조회 없이도 아는 사실이라 상태 줄은 붙는다.
  assert.ok(res.content.at(-1).text.includes("현재 열린 페이지: https://example.com"));

  // 반면 조회가 필요한 자리(스크린샷 실패)는 모르는 걸 지어내지 않는다.
  const screenshot = registered.find((t) => t.name === "browser_screenshot");
  const none = await screenshot.handler({}, {});
  assert.ok(
    !none.content.some((c) => c.text?.includes("현재 열린 페이지")),
    "currentPage 미지원이면 상태 줄을 지어내지 않는다",
  );
}

// currentPage 가 던져도 도구는 살아 있어야 한다 (조회 실패 = '모름').
{
  const { factory, registered } = makeFactory();
  const opened = [];
  buildHypeproofMcpServer(factory, fakeZ, {
    openBrowser: async (url) => { opened.push(url); },
    screenshot: async () => null,
    startLivePreview: async () => null,
    currentPage: async () => { throw new Error("탭 조회 실패"); },
  });
  const open = registered.find((t) => t.name === "browser_open");
  const res = await open.handler({ url: "https://example.com" }, {});
  assert.equal(res.isError, undefined, "호스트 조회 실패가 학생에게 에러로 보이면 안 된다");
  assert.deepEqual(opened, ["https://example.com"]);
}

// ─── 실사용 시퀀스 회귀: live_preview_start → browser_open(같은 URL) ────────
// 2026-07-24 실제 턴에서 이 순서로 탭이 두 개 열렸다. 원인은 두 가지였다:
// ① live_preview_start 결과가 "라이브 프리뷰 시작: <url>" 이라 모델이 '서버
//    주소만 받았다'고 읽고 browser_open 을 이어 불렀고,
// ② browser_open 에 중복 방지가 없었다.
// 둘 다 잠근다.
{
  const { factory, registered } = makeFactory();
  const { host, state } = makeHost(null);
  buildHypeproofMcpServer(factory, fakeZ, host);
  const preview = registered.find((t) => t.name === "live_preview_start");
  const open = registered.find((t) => t.name === "browser_open");

  const previewRes = await preview.handler({}, {});
  const previewText = previewRes.content.map((c) => c.text).join("\n");
  assert.ok(
    previewText.includes("브라우저에 열었어요") || previewText.includes("브라우저에 열"),
    "결과 문장이 '브라우저까지 열렸다'를 직접 말해야 후속 open 이 안 나온다",
  );
  assert.ok(previewText.includes("현재 열린 페이지: http://127.0.0.1:56767/"));

  // 그래도 모델이 이어서 열려고 하면 — 백스톱이 막는다.
  const openRes = await open.handler({ url: "http://127.0.0.1:56767/" }, {});
  assert.equal(state.opens.length, 0, "라이브 프리뷰가 이미 연 탭을 두 번 열지 않는다 (#415)");
  assert.ok(openRes.content[0].text.includes("이미"));
  assert.equal(state.previews, 1);
}

console.log("✓ #282 P2 s2: hypeproof browser MCP server — wiring + URL policy + vision screenshot + live preview");
console.log("✓ #415: 현재 페이지 인지 — 같은 URL 재오픈 차단 + 모든 결과에 브라우저 상태 한 줄");
