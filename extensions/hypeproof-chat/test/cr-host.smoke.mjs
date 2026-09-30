// cr-browser (#1391) — the host wiring ChatPanelProvider delegates to (src/crHostWiring.ts)
// and the SDK browser host's scope (src/browserMcp.ts), checked by behaviour:
//   CR-09  a removed element sends nothing; what is sent equals what was previewed; the
//          crop joins a queued page screenshot instead of replacing it.
//   CR-10  one proxy call, one SDK tool_result and one pick each put a
//          `hps-browser-result/1` tool_result on the record.
//   CR-11  with the switch on the SDK `browser_open` refuses other origins before any tab
//          call, and `browser_screenshot` does not fall back past a CR refusal.
// Each with a control that must pass and a planted defect that must be caught.
//
// Run: node --experimental-strip-types test/cr-host.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeFakePage, fakePort, FAKE_VERSION } from "./fixtures/fake-cdp-page.mjs";

const w = await import("../src/crHostWiring.ts");
const { readBrowserResultEvent } = await import("../src/browserResult.ts");
const { CrExecutor, checkAgentOrigin } = await import("../src/experimentBrowser.ts");
const { buildHypeproofMcpServer, crBrowserOpenRefusal, MCP_CR_BROWSER_TOOLS } = await import("../src/browserMcp.ts");
const providerSrc = readFileSync(new URL("../src/chatPanelProvider.ts", import.meta.url), "utf8");

const ORIGIN = "http://127.0.0.1:5173";
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

const CTX = {
  ref: "e1",
  backendNodeId: 101,
  tag: "button",
  text: "주문 시작",
  snippet: '<button id="begin">주문 시작</button>',
  snippetTruncated: false,
  style: { display: "inline-block" },
  crop: { mimeType: "image/png", data: "Q1JPUA==", clip: { x: 1, y: 2, width: 80, height: 30 } },
  source: { file: "index.html", line: 4 },
  url: `${ORIGIN}/index.html`,
  route: "/index.html",
  documentGeneration: "L0",
  artifact: FAKE_VERSION,
  captureMs: 12,
};

/** A recorder standing in for the turn's `recordObservation`. */
function recorder() {
  const events = [];
  return { events, record: (kind, value, extra = {}) => events.push({ kind, text: value, ...extra }) };
}
const browserResults = (events) => events.map((e) => readBrowserResultEvent(e)).filter(Boolean);

// ── CR-09 ───────────────────────────────────────────────────────────────────

await test("CR-09 positive: the sent text is exactly the previewed text, and the crop rides with the page screenshot", () => {
  const q = new w.ElementQueue();
  const preview = q.attach(CTX, { imagesAllowed: true });
  assert.equal(preview.source, "index.html:4");
  assert.equal(preview.imageDataUrl, "data:image/png;base64,Q1JPUA==");
  const element = q.take(true);
  const sent = w.withElementText("이 버튼 왜 안 눌려요?", element);
  assert.ok(sent.startsWith(`${preview.sentText}\n\n`), "the model text begins with exactly what was previewed");
  assert.ok(sent.endsWith("이 버튼 왜 안 눌려요?"));
  assert.deepEqual(w.turnImages(["data:image/jpeg;base64,U1RVRA=="], "data:image/jpeg;base64,UEFHRQ==", element), [
    "data:image/jpeg;base64,U1RVRA==",
    "data:image/jpeg;base64,UEFHRQ==",
    "data:image/png;base64,Q1JPUA==",
  ], "student image, page screenshot and element crop: none replaces another");
  assert.equal(q.take(true), null, "sent once, then gone");
});

await test("CR-09 negative: after a remove, the next turn carries no element text and no crop", () => {
  const q = new w.ElementQueue();
  q.attach(CTX, { imagesAllowed: true });
  assert.equal(q.clear(), true);
  assert.equal(q.preview(), null, "the preview is gone");
  const element = q.take(true);
  assert.equal(element, null);
  assert.equal(w.withElementText("질문", element), "질문");
  assert.equal(w.turnImages(undefined, null, element), undefined);
  // Switch turned off between pick and send: nothing goes, and the queue is emptied.
  q.attach(CTX, { imagesAllowed: true });
  assert.equal(q.take(false), null);
  assert.equal(q.queued, false);
  // A cohort that takes no images: no crop, and the preview says so.
  assert.equal(new w.ElementQueue().attach(CTX, { imagesAllowed: false }).imageDataUrl, null);
  // The provider's handlers are these calls, not copies of them.
  assert.match(providerSrc, /clearElementContext\(\): void \{\s*if \(this\.elementQueue\.clear\(\)\) this\.postElementPreview\(\);/);
  assert.match(providerSrc, /let userTextForModel = withElementText\(/);
  assert.match(providerSrc, /const effectiveImages = turnImages\(images, pageImage, element\);/);
  assert.match(providerSrc, /element: this\.elementQueue\.preview\(\)/);
});

// ── CR-10 ───────────────────────────────────────────────────────────────────

function observationOf(page) {
  const ex = new CrExecutor(fakePort(page), { allowedOrigins: () => [ORIGIN], artifactVersion: async () => FAKE_VERSION, settleMs: 0, sleep: async () => {} });
  return ex;
}

await test("CR-10 positive: a proxy call, an SDK tool_result and a pick each put a browser result on the record", async () => {
  const ex = observationOf(makeFakePage());
  const obs = (await ex.execute("browser_observe")).observation;
  const click = (await ex.execute("browser_click", { ref: "e1" })).observation;

  const proxy = recorder();
  await w.recordProxyCrResult(proxy.record, "call-1", "browser_click", { ref: "e1" }, click);
  assert.deepEqual(proxy.events.map((e) => [e.kind, e.tool_id]), [["tool_request", "proxy-call-1"], ["tool_result", "proxy-call-1"]]);
  const pr = browserResults(proxy.events);
  assert.equal(pr.length, 1);
  assert.equal(pr[0].kind, "action");
  assert.equal(pr[0].artifact_version, FAKE_VERSION.id);

  const sdk = new w.SdkCrResults();
  sdk.reset();
  sdk.onToolUse("tu-1", "mcp__hypeproof__browser_observe", true);
  sdk.onInspect("browser_observe", {}, obs);
  const text = await sdk.onToolResult("tu-1", false);
  const sr = readBrowserResultEvent({ kind: "tool_result", text });
  assert.equal(sr?.kind, "observation");
  assert.equal(sr?.tool, "browser_observe");

  const pick = recorder();
  await w.recordElementCapture(pick.record, "pick-1", { context: CTX, text: "x", image: null });
  const kr = browserResults(pick.events);
  assert.equal(kr.length, 1);
  assert.equal(kr[0].kind, "capture");
  assert.equal(kr[0].screenshot_digest?.startsWith("sha256:"), true);
  // The provider calls these for each path.
  assert.match(providerSrc, /this\.crSdkResults\.onInspect\(name, input, r\.observation\);/);
  assert.match(providerSrc, /const crResult = this\.crSdkResults\.onToolResult\(a\.id, a\.isError\);/);
  assert.match(providerSrc, /this\.crSdkResults\.onToolUse\(a\.id, a\.name, this\.isCurriculumRuntimeEnabled\(\)\)/);
  assert.match(providerSrc, /void recordProxyCrResult\(p\.recordObservation, call\.id, /);
  assert.match(providerSrc, /if \(element\) void recordElementCapture\(recordObservation, /);
});

await test("CR-10: SDK results pair with their tool_results oldest first; browser_select asks, observe is allowed", async () => {
  const ex = observationOf(makeFakePage());
  const first = (await ex.execute("browser_observe")).observation;
  const second = (await ex.execute("browser_hover", { ref: "e1" })).observation;
  const sdk = new w.SdkCrResults();
  sdk.onToolUse("tu-a", "mcp__hypeproof__browser_observe", true);
  sdk.onToolUse("tu-b", "mcp__hypeproof__browser_hover", true);
  sdk.onInspect("browser_observe", {}, first);
  sdk.onInspect("browser_hover", { ref: "e1" }, second);
  const a = readBrowserResultEvent({ kind: "tool_result", text: await sdk.onToolResult("tu-a", false) });
  const b = readBrowserResultEvent({ kind: "tool_result", text: await sdk.onToolResult("tu-b", false) });
  assert.deepEqual([a?.tool, b?.tool], ["browser_observe", "browser_hover"], "the first tool_result gets the first result");
  const { evaluateSdkToolUse } = await import("../src/sdkCoachHelpers.ts");
  const grant = [...MCP_CR_BROWSER_TOOLS];
  assert.equal(evaluateSdkToolUse({ toolName: "mcp__hypeproof__browser_select", input: { ref: "e1", value: "s" }, permittedTools: grant }).decision, "ask", "select acts on the page: it asks");
  assert.equal(evaluateSdkToolUse({ toolName: "mcp__hypeproof__browser_observe", input: {}, permittedTools: grant }).decision, "allow", "control: observing is allowed");
});

await test("CR-10 negative: switch off, errors and non-browser tools record no browser result; no version is an error event", async () => {
  const ex = observationOf(makeFakePage());
  const obs = (await ex.execute("browser_observe")).observation;
  const sdk = new w.SdkCrResults();
  sdk.onToolUse("tu-off", "mcp__hypeproof__browser_observe", false);
  sdk.onInspect("browser_observe", {}, obs);
  assert.equal(sdk.onToolResult("tu-off", false), undefined, "switch off: the default event, not a browser result");
  sdk.reset();
  sdk.onToolUse("tu-open", "mcp__hypeproof__browser_open", true);
  sdk.onToolUse("tu-read", "Read", true);
  assert.equal(sdk.onToolResult("tu-open", false), undefined);
  assert.equal(sdk.onToolResult("tu-read", false), undefined);
  sdk.onToolUse("tu-err", "mcp__hypeproof__browser_click", true);
  assert.equal(sdk.onToolResult("tu-err", true), undefined, "an error result is not a browser result");

  const bad = recorder();
  await w.recordProxyCrResult(bad.record, "c", "browser_click", {}, { ...obs, artifact: null });
  assert.deepEqual(bad.events.map((e) => [e.kind, e.outcome ?? null]), [["tool_request", null], ["tool_result", "error"]]);
  assert.equal(browserResults(bad.events).length, 0, "no version: recorded as an error, never as a result");
});

// ── CR-11 on the SDK host ───────────────────────────────────────────────────

function sdkServer(host) {
  const tools = new Map();
  buildHypeproofMcpServer(
    { tool: (name, _d, _s, fn) => (tools.set(name, fn), name), createSdkMcpServer: (o) => o },
    { string: () => "s", boolean: () => "b", number: () => "n" },
    host,
    { curriculumRuntime: true },
  );
  return tools;
}
function fakeHost(over = {}) {
  const calls = [];
  const host = {
    calls,
    openBrowser: async (url) => { calls.push(["openBrowser", url]); },
    screenshot: async () => { calls.push(["screenshot"]); return { imageBase64: "RVhURVJOQUw=", mimeType: "image/jpeg", url: "https://example.com/", title: "external" }; },
    startLivePreview: async () => null,
    livePreviewUrl: async () => `${ORIGIN}/`,
    currentPage: async () => ({ url: "https://example.com/", title: "external" }),
    openPages: async () => [],
    inspect: async (name) => { calls.push(["inspect", name]); return { content: [{ type: "text", text: "실험 브라우저는 학생 자신의 미리보기에서만 움직여요. 범위 밖이라 거절했어요." }], isError: true }; },
    crEnabled: () => true,
    crScope: (url) => checkAgentOrigin(url, [ORIGIN]),
    ...over,
  };
  return host;
}

await test("CR-11 SDK negative: with the switch on, browser_open to an external origin is refused before any tab call", async () => {
  const host = fakeHost();
  const tools = sdkServer(host);
  for (const url of ["https://example.com/", "http://192.168.0.7:5173/index.html", "file:///etc/hosts"]) {
    const r = await tools.get("browser_open")({ url });
    assert.equal(r.isError, true, url);
    assert.match(r.content[0].text, /범위 밖이라 거절/);
    assert.equal(await crBrowserOpenRefusal(host, url) !== null, true, "canUseTool denies it too, so no approval modal");
  }
  assert.deepEqual(host.calls.filter((c) => c[0] === "openBrowser"), [], "no tab was opened or navigated");
  // Another loopback port: #507 rewrites it to the live server, so only the preview opens.
  const lb = fakeHost();
  await sdkServer(lb).get("browser_open")({ url: "http://127.0.0.1:60692/index.html" });
  assert.ok(lb.calls.filter((c) => c[0] === "openBrowser").every((c) => new URL(c[1]).origin === ORIGIN), JSON.stringify(lb.calls));
  // A host that refuses late (the reuse path's CR refusal) is not bypassed by a fallback open.
  const late = fakeHost({ crScope: () => ({ ok: true }), openBrowser: async () => { throw new Error("범위 밖이라 거절했어요 (late)"); } });
  const lr = await sdkServer(late).get("browser_open")({ url: `${ORIGIN}/index.html` });
  assert.equal(lr.isError, true);
  assert.match(lr.content[0].text, /late/);
});

await test("CR-11 SDK positive: the student's own preview opens; with the switch off the pre-CR flow is unchanged", async () => {
  const host = fakeHost();
  const r = await sdkServer(host).get("browser_open")({ url: `${ORIGIN}/index.html` });
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  assert.deepEqual(host.calls.filter((c) => c[0] === "openBrowser"), [["openBrowser", `${ORIGIN}/index.html`]]);
  const off = fakeHost({ crEnabled: () => false });
  const o = await sdkServer(off).get("browser_open")({ url: "https://example.com/" });
  assert.notEqual(o.isError, true, "switch off: external open behaves as before (the approval tier decides)");
  assert.deepEqual(off.calls.filter((c) => c[0] === "openBrowser"), [["openBrowser", "https://example.com/"]]);
  assert.equal(await crBrowserOpenRefusal(off, "https://example.com/"), null);
});

await test("CR-11 SDK negative: browser_screenshot returns the CR refusal instead of capturing the tab another way", async () => {
  const host = fakeHost();
  const r = await sdkServer(host).get("browser_screenshot")({});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /범위 밖이라 거절/);
  assert.deepEqual(host.calls.filter((c) => c[0] === "screenshot"), [], "no fallback capture");
  // Control: switch off, the pre-CR fallback still runs.
  const off = fakeHost({ crEnabled: () => false });
  const o = await sdkServer(off).get("browser_screenshot")({});
  assert.notEqual(o.isError, true);
  assert.deepEqual(off.calls.filter((c) => c[0] === "screenshot"), [["screenshot"]]);
});

// ── CR-11 / CR-09 across the proxy turn boundary ────────────────────────────

await test("CR-11 proxy: with the switch on the guard outlives the turn; an escape set off by its last step is taken back and reported next turn", async () => {
  const EXT = "https://example.com/late.html";
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async (crOn) => {
    const page = makeFakePage({ elements: [{ key: "late", role: "button", name: "늦게 이동", tag: "button", id: "late", lateHref: EXT, lateMs: 30, lateCommit: true }] });
    // A control whose dispose closes the session the way CdpSession.close() does.
    const make = () => ({
      ex: new CrExecutor(fakePort(page), { allowedOrigins: () => [ORIGIN], artifactVersion: async () => FAKE_VERSION, settleMs: 0, sleep: (ms) => tick(Math.min(ms, 10)) }),
      dispose: async () => page.closeSession(),
    });
    let shared;
    const turn = () => w.proxyTurnBrowser(crOn, () => (shared ??= make()), make);
    const t1 = turn();
    await t1.browser.ex.execute("browser_observe");
    const click = await t1.browser.ex.execute("browser_click", { ref: "e1" });
    assert.equal(click.isError, false, "the step itself saw nothing yet");
    await t1.release(); // the turn ends right after its last step (final reply, or Stop)
    await tick(100);
    const origin = page.state.origin;
    const t2 = turn();
    const next = await t2.browser.ex.execute("browser_observe");
    await t2.release();
    return { origin, next, sameControl: t1.browser === t2.browser };
  };
  const on = await run(true);
  assert.equal(on.sameControl, true, "switch on: both turns drive one control");
  assert.equal(on.origin, ORIGIN, "switch on: the tab was taken back to the preview after the turn ended");
  assert.equal(on.next.isError, true);
  assert.match(on.next.content[0].text, /지난 단계가 끝난 뒤 .*범위 밖\(https:\/\/example\.com\/late\.html\)/, "the next turn's first call carries the late escape");
  // Control: a control closed at the end of the turn loses its guard, and the escape stands.
  const off = await run(false);
  assert.equal(off.sameControl, false);
  assert.equal(off.origin, "https://example.com", "instrument: without the shared control the late escape really completes");
  // The provider's proxy loop is this call, and does not close the shared control itself.
  assert.match(providerSrc, /proxyTurnBrowser\(\s*this\.isCurriculumRuntimeEnabled\(\),\s*\(\) => \(this\.mcpBrowser \?\?= new BrowserControl\(this\.crBrowserOptions\(\)\)\),/);
  const loop = providerSrc.slice(providerSrc.indexOf("private async runBrowserLoop("), providerSrc.indexOf("private async runBrowserLoop(") + 8000);
  assert.match(loop, /finally \{\s*await turnBrowser\.release\(\);/);
  assert.doesNotMatch(loop, /browser\.dispose\(\)/);
});

await test("CR-09 proxy: a picked element's ref is known to the executor the next proxy turn drives", async () => {
  const page = makeFakePage();
  const make = () => ({ ex: new CrExecutor(fakePort(page), { allowedOrigins: () => [ORIGIN], artifactVersion: async () => FAKE_VERSION, settleMs: 0, sleep: async () => {} }), dispose: async () => {} });
  let shared;
  const pickSide = (shared ??= make()); // pickElement adopts its table into the shared control
  pickSide.ex.adoptRefs(new Map([["p777", page.nodeId("cancel")]]), (await pickSide.ex.logFor(page.cdp)).documentGeneration);
  const t = w.proxyTurnBrowser(true, () => (shared ??= make()), make);
  const r = await t.browser.ex.execute("browser_click", { ref: "p777" });
  assert.equal(r.isError, false, JSON.stringify(r.content));
  assert.deepEqual(page.state.dom.clicked, ["cancel"]);
  // Control: a fresh per-turn control has no such ref.
  const fresh = w.proxyTurnBrowser(false, () => (shared ??= make()), make);
  const miss = await fresh.browser.ex.execute("browser_click", { ref: "p777" });
  assert.equal(miss.isError, true);
});

console.log(`\n${passed} cr-host checks passed`);
