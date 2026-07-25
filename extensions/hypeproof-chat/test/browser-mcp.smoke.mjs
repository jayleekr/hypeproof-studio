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

// ─── constants — names the model/canUseTool sees must never drift ────────────
{
  assert.equal(HYPEPROOF_MCP_SERVER_NAME, "hypeproof");
  assert.deepEqual(
    [...MCP_BROWSER_TOOLS],
    ["mcp__hypeproof__browser_open", "mcp__hypeproof__browser_screenshot", "mcp__hypeproof__live_preview_start"],
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
    ["browser_open", "browser_screenshot", "live_preview_start"],
    "short tool names (SDK prefixes mcp__hypeproof__ itself)",
  );
  assert.equal(opts.tools.length, 3, "all three tools attached to the server");
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
