// cr-browser (#1391) — the host wiring ChatPanelProvider delegates to (src/crHostWiring.ts)
// and the SDK browser host's scope (src/browserMcp.ts), checked by behaviour:
//   CR-09  a removed element sends nothing; what is sent equals what was previewed; the
//          crop joins a queued page screenshot instead of replacing it.
//   CR-10  one proxy call, one SDK tool_result and one pick each put a
//          `hps-browser-result/1` tool_result on the record, its artifact references as
//          event keys and its screenshot and trace bytes stored on the local record first;
//          the stored results read back labelled by version.
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
const { LocalRecord, validateObservation } = await import("../../../worker/src/lib/measurement-core/index.ts");
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

/** The local record the provider's sink writes to, on an in-memory port. */
function localRecord() {
  const store = new Map();
  const record = new LocalRecord({
    read: async (k) => store.get(k) ?? null,
    write: async (k, v, o) => { if (o?.ifAbsent && store.has(k)) throw new Error("exists"); store.set(k, v); },
    list: async (p) => [...store.keys()].filter((k) => k.startsWith(p)).sort(),
    remove: async (k) => { store.delete(k); },
  });
  return { store, record, sink: (blob) => record.putBlob(blob) };
}

/** Every event must also pass the one validator, on the format the recorder writes. */
function validBatch(events) {
  const evs = events.map((e, i) => ({ id: `x${i + 1}`, seq: i + 1, task: "t", at: i, assistance: "unknown", ...e }));
  return validateObservation({ format: "hps-observation/1", scope: "s", session: "s", program: "p", events: evs }).batch.events;
}

await test("CR-10 positive: a proxy call, an SDK tool_result and a pick each put a browser result on the record, its bytes stored and resolvable", async () => {
  const ex = observationOf(makeFakePage());
  const obs = (await ex.execute("browser_observe")).observation;
  const click = (await ex.execute("browser_click", { ref: "e1" })).observation;
  const local = localRecord();

  const proxy = recorder();
  await w.recordProxyCrResult(proxy.record, "call-1", "browser_click", { ref: "e1" }, click, local.sink);
  assert.deepEqual(proxy.events.map((e) => [e.kind, e.tool_id]), [["tool_request", "proxy-call-1"], ["tool_result", "proxy-call-1"]]);
  const result = proxy.events[1];
  assert.equal(result.artifact_version, FAKE_VERSION.id, "the version rides on the event as a key");
  assert.match(result.screenshot_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.trace_digest, /^sha256:[a-f0-9]{64}$/);
  const shot = await local.record.getBlob(result.screenshot_digest);
  assert.equal(Buffer.from(shot.bytes).toString("base64"), click.screenshot.data, "the screenshot digest resolves to the screenshot");
  const trace = JSON.parse(new TextDecoder().decode((await local.record.getBlob(result.trace_digest)).bytes));
  assert.deepEqual([trace.tool, trace.input, trace.step], ["browser_click", { ref: "e1" }, click.step], "the trace digest resolves to the action trace");
  const pr = browserResults(proxy.events);
  assert.equal(pr.length, 1);
  assert.equal(pr[0].kind, "action");
  assert.equal(pr[0].artifact_version, FAKE_VERSION.id);
  assert.equal(pr[0].screenshot_digest, result.screenshot_digest, "text and keys agree");

  const sdk = new w.SdkCrResults();
  sdk.reset();
  sdk.onToolUse("tu-1", "mcp__hypeproof__browser_observe", true);
  sdk.onInspect("browser_observe", {}, obs, local.sink);
  const sr = await sdk.onToolResult("tu-1", false);
  assert.equal(sr.refs.artifact_version, FAKE_VERSION.id);
  assert.ok(await local.record.getBlob(sr.refs.screenshot_digest));
  const sdkRecord = readBrowserResultEvent({ kind: "tool_result", text: sr.text, ...sr.refs });
  assert.equal(sdkRecord?.kind, "observation");
  assert.equal(sdkRecord?.tool, "browser_observe");

  const pick = recorder();
  await w.recordElementCapture(pick.record, "pick-1", { context: CTX, text: "x", image: null }, local.sink);
  const kr = browserResults(pick.events);
  assert.equal(kr.length, 1);
  assert.equal(kr[0].kind, "capture");
  const crop = await local.record.getBlob(pick.events[1].screenshot_digest);
  assert.equal(crop.media_type, "image/png", "the element crop is stored as the PNG it is");
  assert.equal(Buffer.from(crop.bytes).toString("base64"), CTX.crop.data);

  // The events the recorder writes are valid hps-observation/1 events, references and all.
  const stored = validBatch([...proxy.events, ...pick.events]);
  assert.equal(stored.filter((e) => e.artifact_version === FAKE_VERSION.id).length, 2);
  // The provider calls these for each path, with its sink, and the turn's end waits for them.
  assert.match(providerSrc, /this\.crSdkResults\.onInspect\(name, input, r\.observation, this\.crBlobSink\);/);
  assert.match(providerSrc, /const crResult = this\.crSdkResults\.onToolResult\(a\.id, a\.isError\);/);
  assert.match(providerSrc, /if \(crResult\) observationCaptures\.push\(crResult\.then\(\(r\) => recordObservation\('tool_result', r\.text, \{ \.\.\.r\.refs, tool_id: a\.id/);
  assert.match(providerSrc, /this\.crSdkResults\.onToolUse\(a\.id, a\.name, this\.isCurriculumRuntimeEnabled\(\)\)/);
  assert.match(providerSrc, /const recording = recordProxyCrResult\(p\.recordObservation, call\.id, fixed\.call\.name, fixed\.call\.input \?\? \{\}, tr\.observation, this\.crBlobSink\);\s*if \(p\.trackObservation\) p\.trackObservation\(recording\);/);
  assert.match(providerSrc, /trackObservation: \(q\) => observationCaptures\.push\(q\),/);
  assert.match(providerSrc, /if \(element\) observationCaptures\.push\(recordElementCapture\(recordObservation, `pick-\$\{crypto\.randomUUID\(\)\}`, element, this\.crBlobSink\)\);/);
  assert.match(providerSrc, /return await store\.exclusive\(\(\) => record\.putBlob\(blob\)\);/);
});

await test("CR-10 negative: bytes that were not stored are never named; a sink that answers another digest is not trusted", async () => {
  const ex = observationOf(makeFakePage());
  await ex.execute("browser_observe");
  const click = (await ex.execute("browser_click", { ref: "e1" })).observation;
  for (const [why, sink] of [
    ["no sink", undefined],
    ["sink full", async () => null],
    ["sink throws", async () => { throw new Error("storage_busy"); }],
    ["sink lies", async () => `sha256:${"f".repeat(64)}`],
  ]) {
    const r = recorder();
    await w.recordProxyCrResult(r.record, "c", "browser_click", { ref: "e1" }, click, sink);
    const e = r.events[1];
    assert.equal(e.outcome, "success", `${why}: the result is still recorded`);
    assert.equal(e.artifact_version, FAKE_VERSION.id, `${why}: still bound to its version`);
    assert.equal("screenshot_digest" in e, false, `${why}: no screenshot digest without stored bytes`);
    assert.equal("trace_digest" in e, false, `${why}: no trace digest without stored bytes`);
    const text = browserResults(r.events)[0];
    assert.deepEqual([text.screenshot_digest, text.trace_digest], [null, null], `${why}: the readable copy says the same`);
    validBatch(r.events);
  }
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
  const a = readBrowserResultEvent({ kind: "tool_result", text: (await sdk.onToolResult("tu-a", false)).text });
  const b = readBrowserResultEvent({ kind: "tool_result", text: (await sdk.onToolResult("tu-b", false)).text });
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
  await w.recordProxyCrResult(bad.record, "c", "browser_click", {}, { ...obs, artifact: null }, localRecord().sink);
  assert.deepEqual(bad.events.map((e) => [e.kind, e.outcome ?? null]), [["tool_request", null], ["tool_result", "error"]]);
  assert.equal(browserResults(bad.events).length, 0, "no version: recorded as an error, never as a result");
  assert.equal("artifact_version" in bad.events[1], false, "an error event names no version");
});

await test("CR-10 read-back: stored results come back newest first, labelled current, earlier or unknown by their page's version now", async () => {
  const ex = observationOf(makeFakePage());
  const obs = (await ex.execute("browser_observe")).observation;
  const local = localRecord();
  const V0 = FAKE_VERSION.id;
  const V1 = `sha256:${"c".repeat(64)}`;
  const r = recorder();
  await w.recordProxyCrResult(r.record, "a", "browser_click", { ref: "e1" }, { ...obs, step: 2, records: [{ kind: "console", level: "error", message: "boom", step: 2, time: 1, documentGeneration: "L0" }] }, local.sink);
  await new Promise((res) => setTimeout(res, 5));
  await w.recordProxyCrResult(r.record, "b", "browser_observe", {}, { ...obs, artifact: { ...FAKE_VERSION, id: V1 } }, local.sink);
  await w.recordProxyCrResult(r.record, "c", "browser_observe", {}, { ...obs, artifact: { ...FAKE_VERSION, id: V1, entry: "about.html" }, route: "/about.html" }, local.sink);
  const events = validBatch(r.events);
  assert.deepEqual(w.crResultEntries(events), ["index.html", "about.html"]);
  const items = w.crResultHistory(events, (entry) => (entry === "index.html" ? V1 : null));
  assert.equal(items.length, 3);
  const byState = Object.fromEntries(items.map((i) => [i.version + i.description, i.state]));
  const click = items.find((i) => i.description.startsWith("browser_click"));
  assert.equal(click.state, "earlier", "a result on v0 says it belongs to the earlier version after v1");
  assert.match(click.label, /^이전 버전 · sha256:aaaaaaa/);
  assert.match(click.detail, /오류 1건: boom/, "the earlier result is still readable");
  assert.ok(await local.record.getBlob(click.screenshot_digest), "its screenshot still resolves");
  assert.equal(items.find((i) => i.version === V1 && i.description.includes("/index.html")).state, "current");
  assert.equal(items.find((i) => i.description.includes("/about.html")).state, "unknown", "no current version known: never called earlier");
  assert.ok(items[0].at >= items.at(-1).at, "newest first");
  assert.ok(Object.keys(byState).length === 3);
  // Planted: a reader that ignores the version and calls everything current is caught.
  assert.notDeepEqual(items.map((i) => i.state), ["current", "current", "current"]);
  // The command reads the record, not a copy, and re-checks the switch first.
  assert.match(providerSrc, /async showBrowserResults\(\): Promise<void> \{\s*if \(!this\.isCurriculumRuntimeEnabled\(\)\)/);
  assert.match(providerSrc, /const events = recorder\?\.snapshot\(\)\.events \?\? \[\];/);
  assert.match(providerSrc, /const items = crResultHistory\(events, \(entry\) => current\.get\(entry\) \?\? null\);/);
  assert.match(providerSrc, /blob = await this\.crRecordHandle\(\)\.record\.getBlob\(picked\.item\.screenshot_digest\);/);
});

await test("CR-10: an assessment request leaves the reference keys out; the stored batch keeps them", async () => {
  const ex = observationOf(makeFakePage());
  const obs = (await ex.execute("browser_observe")).observation;
  const r = recorder();
  await w.recordProxyCrResult(r.record, "a", "browser_observe", {}, obs, localRecord().sink);
  const batch = { format: "hps-observation/1", scope: "s", session: "s", program: "p", events: validBatch(r.events) };
  const sent = w.assessmentBatch(batch);
  assert.equal(sent.events.some((e) => "artifact_version" in e || "screenshot_digest" in e || "trace_digest" in e), false);
  assert.equal(batch.events[1].artifact_version, FAKE_VERSION.id, "the record itself is not changed");
  assert.deepEqual(sent.events.map((e) => e.text), batch.events.map((e) => e.text), "every quotable text is sent unchanged");
  assert.match(providerSrc, /body:JSON\.stringify\(assessmentBatch\(snapshot\)\)/);
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
