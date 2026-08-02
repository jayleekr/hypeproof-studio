// #507 — 코치는 미리보기 포트를 추측하면 안 된다.
//
// 실측(2026-07-28, v0.1.34): 라이브 서버는 `listen(0)` 으로 **58085** 를 받았고
// 코치는 `127.0.0.1:3000` 으로 이동해 ERR_CONNECTION_REFUSED 로 멈췄다. 3000 은
// 사용 중이라서가 아니라 **비어 있어서** 죽었다 — 어떤 고정 포트도 맞을 수 없다.
// 코드 어디에도 3000 은 없다(모델의 반사적 추측이다). Run 버튼은 확장이 URL 을
// 직접 받으므로 멀쩡했고, 코치만 주소를 알 통로가 없었다.
//
// 여기서 재는 것: ① 순수 교정 함수, ② SDK 경로(browser_open)가 그걸 실제로
// 쓰는지, ③ 주소가 워커까지 나가는 헤더 두 통로. 전부 앱 없이, 밀리초.
// Run: node --experimental-strip-types test/live-preview-url.smoke.mjs

import assert from "node:assert/strict";

const { resolveLivePreviewUrl } = await import("../src/browserControlHelpers.ts");
const { buildHypeproofMcpServer } = await import("../src/browserMcp.ts");
const { buildProxyHeaders } = await import("../src/proxyClientHelpers.ts");
const { buildSdkGatewayEnv } = await import("../src/sdkCoachHelpers.ts");

const LIVE = "http://127.0.0.1:58085/";

// ─── 순수 교정 — 추측한 포트는 실제 서버로, 나머지는 손대지 않는다 ───────────
{
  // 양성 대조군: 실제로 고쳐야 하는 것들
  const guessed = resolveLivePreviewUrl("http://127.0.0.1:3000", LIVE);
  assert.equal(guessed.redirected, true);
  assert.equal(guessed.url, "http://127.0.0.1:58085/");
  assert.equal(guessed.requested, "http://127.0.0.1:3000");

  // 경로·쿼리·해시는 보존한다 — 코치가 하위 페이지를 보려던 의도를 버리면 안 된다.
  const sub = resolveLivePreviewUrl("http://localhost:5500/about.html?x=1#top", LIVE);
  assert.equal(sub.redirected, true);
  assert.equal(sub.url, "http://127.0.0.1:58085/about.html?x=1#top");

  // 스킴 없이 오는 표기(모델이 자주 쓴다)도 같은 판정을 받는다.
  const bare = resolveLivePreviewUrl("127.0.0.1:8080/index.html", LIVE);
  assert.equal(bare.redirected, true);
  assert.equal(bare.url, "http://127.0.0.1:58085/index.html");
}

// ─── 음성 대조군 — 건드리면 안 되는 것들 (계측기가 관대한 쪽으로 틀리지 않게) ─
{
  // 이미 라이브 서버를 가리키면 그대로. 호스트 표기 차이는 같은 서버로 본다.
  assert.equal(resolveLivePreviewUrl(LIVE, LIVE).redirected, false);
  assert.equal(resolveLivePreviewUrl("http://localhost:58085/x.html", LIVE).redirected, false);

  // 외부 주소는 절대 교정하지 않는다 — 참고 사이트를 라이브 서버로 끌고 가면
  // 코치가 보려던 것과 다른 페이지를 읽는다.
  const ext = resolveLivePreviewUrl("https://boaclinic.example/about", LIVE);
  assert.equal(ext.redirected, false);
  assert.equal(ext.url, "https://boaclinic.example/about");

  // 서버 주소를 모르면 아무것도 고치지 않는다 (짐작으로 고치지 않는다).
  for (const unknown of [undefined, null, ""]) {
    const r = resolveLivePreviewUrl("http://127.0.0.1:3000/", unknown);
    assert.equal(r.redirected, false, `모르면 그대로: ${String(unknown)}`);
  }

  // 정책 위반 스킴은 여기서도 통과하지 못한다.
  assert.equal(resolveLivePreviewUrl("javascript:alert(1)", LIVE), null);
  assert.equal(resolveLivePreviewUrl("", LIVE), null);
}

// ─── SDK 경로: browser_open 이 교정을 실제로 쓰는가 ──────────────────────────
function makeFactory() {
  const registered = [];
  return {
    factory: {
      tool: (name, description, inputSchema, handler) => {
        const def = { name, description, inputSchema, handler };
        registered.push(def);
        return def;
      },
      createSdkMcpServer: (opts) => ({ __server: true, opts }),
    },
    registered,
  };
}
const fakeZ = { string: () => ({ __zod: "string" }) };

function makeHost({ live }) {
  const state = { opens: [], previews: 0, page: null, live };
  return {
    state,
    host: {
      openBrowser: async (url) => {
        state.opens.push(url);
        state.page = { url };
      },
      screenshot: async () => null,
      startLivePreview: async () => {
        state.previews += 1;
        state.live = LIVE;
        state.page = { url: LIVE };
        return LIVE;
      },
      livePreviewUrl: async () => state.live,
      currentPage: async () => state.page,
      openPages: async () => (state.page ? [state.page] : []),
    },
  };
}

// 서버가 떠 있는데 코치가 3000 을 찍었다 → 실제 주소로 열고, 그 사실을 말한다.
{
  const { factory, registered } = makeFactory();
  const { host, state } = makeHost({ live: LIVE });
  buildHypeproofMcpServer(factory, fakeZ, host);
  const open = registered.find((t) => t.name === "browser_open");

  const res = await open.handler({ url: "http://127.0.0.1:3000" }, {});
  assert.equal(res.isError, undefined);
  assert.deepEqual(state.opens, ["http://127.0.0.1:58085/"], "죽은 포트가 아니라 진짜 주소로 연다");
  assert.equal(state.previews, 0, "이미 떠 있으므로 다시 시작하지 않는다");
  const said = res.content.map((b) => b.text ?? "").join(" ");
  assert.match(said, /58085/, "실제 주소를 말한다");
  assert.match(said, /3000/, "무엇을 고쳤는지도 말한다 — 조용히 고치면 다음 턴에 또 추측한다");
}

// 서버가 안 떠 있는데 루프백을 찍었다 → 추측을 따라가지 않고 라이브 서버를 띄운다.
{
  const { factory, registered } = makeFactory();
  const { host, state } = makeHost({ live: null });
  buildHypeproofMcpServer(factory, fakeZ, host);
  const open = registered.find((t) => t.name === "browser_open");

  const res = await open.handler({ url: "http://127.0.0.1:3000" }, {});
  assert.equal(res.isError, undefined);
  assert.equal(state.previews, 1, "라이브 서버를 시작한다");
  assert.deepEqual(state.opens, [], "죽은 포트로는 절대 열지 않는다");
  assert.match(res.content.map((b) => b.text ?? "").join(" "), /58085/);
}

// 외부 주소는 서버 상태와 무관하게 그대로 연다 (음성 대조군).
{
  const { factory, registered } = makeFactory();
  const { host, state } = makeHost({ live: null });
  buildHypeproofMcpServer(factory, fakeZ, host);
  const open = registered.find((t) => t.name === "browser_open");

  await open.handler({ url: "https://example.com/ref" }, {});
  assert.deepEqual(state.opens, ["https://example.com/ref"]);
  assert.equal(state.previews, 0, "외부 주소는 라이브 서버를 켜지 않는다");
}

// 이 능력이 없는 구버전 호스트에서는 아무것도 바뀌지 않는다 (무회귀).
{
  const { factory, registered } = makeFactory();
  const { host, state } = makeHost({ live: null });
  delete host.livePreviewUrl;
  buildHypeproofMcpServer(factory, fakeZ, host);
  const open = registered.find((t) => t.name === "browser_open");

  await open.handler({ url: "http://127.0.0.1:3000/" }, {});
  assert.deepEqual(state.opens, ["http://127.0.0.1:3000/"], "모르면 예전 동작 그대로");
  assert.equal(state.previews, 0, "모름을 '없음'으로 읽고 서버를 켜면 안 된다");
}

// ─── 주소가 워커까지 나가는가 — 두 런타임의 통로 ────────────────────────────
{
  // 프록시 경로: 요청 헤더
  const headers = buildProxyHeaders({ token: "t", previewUrl: LIVE });
  assert.equal(decodeURIComponent(headers["x-hps-preview-url"]), LIVE);
  assert.equal(
    buildProxyHeaders({ token: "t" })["x-hps-preview-url"],
    undefined,
    "서버가 없으면 헤더도 없다 — 없는 주소를 지어내지 않는다",
  );

  // SDK 경로: ANTHROPIC_CUSTOM_HEADERS. SDK(bridge.mjs)와 같은 방식으로 되파싱한다.
  const env = buildSdkGatewayEnv(
    { PATH: "/usr/bin" },
    { proxyUrl: "https://api.hypeproof-ai.xyz/v1", token: "t", workspace: "/w", previewUrl: LIVE },
  );
  const parsed = {};
  for (const line of (env.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i >= 0) parsed[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  assert.equal(decodeURIComponent(parsed["x-hps-preview-url"]), LIVE, "SDK 파싱을 통과해 복원된다");
  assert.equal(decodeURIComponent(parsed["x-hps-workspace"]), "/w", "기존 헤더는 그대로");

  const bare = buildSdkGatewayEnv(
    { PATH: "/usr/bin" },
    { proxyUrl: "https://api.hypeproof-ai.xyz/v1", token: "t" },
  );
  assert.equal(bare.ANTHROPIC_CUSTOM_HEADERS, undefined, "보낼 게 없으면 헤더 자체가 없다");
}

console.log("✓ #507: 라이브 서버 주소 — 순수 교정 + browser_open 배선 + 워커 전달 통로");
