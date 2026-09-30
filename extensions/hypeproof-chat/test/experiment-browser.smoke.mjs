// cr-browser (#1391) — Experiment Browser core over a scripted CDP page.
// CR-T04 observation · CR-T05 per-document records · CR-T06 actions · CR-T08 step
// attribution (unit half) · CR-T11 origin scope · CR-T63 page indicator (unit half).
//
// Every check has a positive control (a sample that must pass) and a negative control
// (a planted defect that must be caught). The fake page is not a browser; the
// real-Chromium run is e2e/curriculum-runtime/experiment-browser.real.mjs.
//
// Run: node --experimental-strip-types test/experiment-browser.smoke.mjs

import assert from "node:assert/strict";
import { makeFakePage, fakePort, FAKE_VERSION } from "./fixtures/fake-cdp-page.mjs";

const eb = await import("../src/experimentBrowser.ts");
const { PageEventLog, CrExecutor, observationProblems, actionResultProblems, checkAgentOrigin, failuresOf } = eb;

const ORIGIN = "http://127.0.0.1:5173";
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

function executorFor(page, over = {}) {
  const indicator = [];
  const hooks = {
    allowedOrigins: () => [ORIGIN],
    artifactVersion: async () => FAKE_VERSION,
    onIndicator: (visible, tool) => indicator.push({ visible, tool }),
    settleMs: 0,
    sleep: (ms) => tick(Math.min(ms, 10)),
    ...over,
  };
  return { ex: new CrExecutor(fakePort(page), hooks), indicator };
}

// ── CR-T04 observation ──────────────────────────────────────────────────────

await test("CR-T04 positive: known title, route, three buttons and viewport, tagged with the document", async () => {
  const page = makeFakePage({ viewport: { width: 390, height: 844 } });
  const { ex } = executorFor(page);
  const r = await ex.execute("browser_observe");
  assert.equal(r.isError, false, JSON.stringify(r.content));
  const o = r.observation;
  assert.deepEqual(observationProblems(o), []);
  assert.equal(o.url, `${ORIGIN}/index.html`);
  assert.equal(o.route, "/index.html");
  assert.equal(o.title, "키오스크 연습");
  assert.deepEqual(o.refs, ["e1", "e2", "e3"]);
  assert.match(o.snapshot, /\[ref=e1\] button "주문하기"/);
  assert.match(o.snapshot, /\[ref=e3\] button "도움말"/);
  assert.deepEqual(o.viewport, { width: 390, height: 844 });
  assert.equal(o.documentGeneration, "L0");
  assert.equal(o.screenshot.data, page.state.screenshot);
  assert.equal(o.artifact.id, FAKE_VERSION.id);
  assert.equal(r.content[1].type, "image_url", "the screenshot rides as an image block");
});

await test("CR-T04 negative: an observation missing viewport or document generation is an explicit error", async () => {
  const page = makeFakePage();
  const { ex } = executorFor(page);
  const good = (await ex.execute("browser_observe")).observation;
  const { viewport: _v, ...noViewport } = good;
  assert.deepEqual(observationProblems(noViewport), ["viewport"]);
  assert.deepEqual(observationProblems({ ...good, documentGeneration: "" }), ["documentGeneration"]);
  assert.deepEqual(observationProblems({ ...good, viewport: { width: 0, height: 600 } }), ["viewport"]);
  // End to end: a page whose screenshot fails yields an error result, never a partial one.
  const broken = makeFakePage({ screenshotFails: true });
  const r = await executorFor(broken).ex.execute("browser_observe");
  assert.equal(r.isError, true);
  assert.equal(r.observation, undefined, "no partial observation rides on an error");
});

// ── CR-T05 per-document records ─────────────────────────────────────────────

const PLANTED = (p) => {
  p.consoleError("planted-console-error");
  p.throwError("planted-throw");
  p.fetch404("/missing.png");
};

await test("CR-T05 positive: one console.error, one throw and one 404 yield exactly three records", async () => {
  const page = makeFakePage({ onLoad: PLANTED });
  const log = new PageEventLog();
  await log.attach(page.cdp);
  page.newDocument();
  await tick(5);
  const recs = log.records();
  assert.equal(recs.length, 3, JSON.stringify(recs));
  assert.deepEqual(recs.map((r) => r.kind).sort(), ["console", "exception", "network"]);
  const c = recs.find((r) => r.kind === "console");
  assert.equal(c.level, "error");
  assert.equal(c.message, "planted-console-error");
  assert.deepEqual(c.source, { url: `${ORIGIN}/index.html`, line: 12, column: 5 });
  assert.ok(recs.every((r) => Number.isFinite(r.time) && r.documentGeneration === "L1"));
  assert.match(recs.find((r) => r.kind === "network").message, /^404 Not Found .*\/missing\.png$/);
});

await test("CR-T05 negative: a clean page has zero records; the previous document's never move to the new one", async () => {
  const clean = makeFakePage();
  const cleanLog = new PageEventLog();
  await cleanLog.attach(clean.cdp);
  clean.newDocument();
  assert.equal(cleanLog.records().length, 0, "clean page");

  const page = makeFakePage({ onLoad: PLANTED });
  const log = new PageEventLog();
  await log.attach(page.cdp);
  page.newDocument(); // L1 with three planted records
  const oldCtx = page.state.ctx;
  // A request of L1 still in flight when the next document commits.
  page.emit("Network.requestWillBeSent", { requestId: "late", loaderId: "L1", frameId: "F1", request: { url: `${ORIGIN}/late.json` } });
  page.state.onLoad = () => {};
  page.newDocument(); // L2, clean
  // Late events of the OLD document arrive after L2 committed.
  page.emit("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "late-from-L1" }], executionContextId: oldCtx, timestamp: Date.now() });
  page.emit("Network.responseReceived", { requestId: "late", response: { status: 500, statusText: "Server Error" } });
  assert.equal(log.documentGeneration, "L2");
  assert.equal(log.records().length, 0, `L2 must be clean: ${JSON.stringify(log.records())}`);
  assert.equal(log.records("L1").length, 5, "the late ones stay with L1");
  // Instrument check: the attribution really keys on the context (a context-less record is dropped, not guessed).
  page.emit("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "orphan" }], executionContextId: 9999 });
  assert.equal(log.records().length, 0);
});

await test("CR-T05 network rules: a 404 counts once; cancelled and pre-enable requests are dropped", async () => {
  const page = makeFakePage();
  const log = new PageEventLog();
  await log.attach(page.cdp);
  page.fetch404("/a", "r1");
  page.emit("Network.loadingFailed", { requestId: "r1", errorText: "net::ERR_ABORTED", canceled: false });
  page.emit("Network.requestWillBeSent", { requestId: "r2", loaderId: "L0", frameId: "F1", request: { url: `${ORIGIN}/b` } });
  page.emit("Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_ABORTED", canceled: true });
  page.emit("Network.loadingFailed", { requestId: "before-enable", errorText: "net::ERR_FAILED", canceled: false });
  page.emit("Network.requestWillBeSent", { requestId: "r3", loaderId: "L0", frameId: "F1", request: { url: "http://127.0.0.1:9/x" } });
  page.emit("Network.loadingFailed", { requestId: "r3", errorText: "net::ERR_CONNECTION_REFUSED", canceled: false });
  assert.deepEqual(log.records().map((r) => r.message), ["404 Not Found http://127.0.0.1:5173/a", "net::ERR_CONNECTION_REFUSED http://127.0.0.1:9/x"]);
});

await test("CR-T05 bound: records past the per-document cap are counted, not kept", async () => {
  const page = makeFakePage();
  const log = new PageEventLog({ maxPerDocument: 2 });
  await log.attach(page.cdp);
  for (let i = 0; i < 5; i++) page.consoleLog(`line ${i}`);
  assert.equal(log.records().length, 2);
  assert.equal(log.dropped(), 3);
});

// ── CR-T06 actions ──────────────────────────────────────────────────────────

const WITH_SELECT = [
  { key: "order", role: "button", name: "주문하기", tag: "button", id: "order" },
  { key: "size", role: "combobox", name: "크기", tag: "select", id: "size", options: [{ value: "s", text: "작은 컵" }, { value: "l", text: "큰 컵" }] },
  { key: "help", role: "button", name: "도움말", tag: "button", id: "help" },
];

await test("CR-T06 positive: select, scroll, hover and reload each change what the next observation shows", async () => {
  const page = makeFakePage({ elements: WITH_SELECT });
  const { ex } = executorFor(page);
  await ex.execute("browser_observe");
  const sel = await ex.execute("browser_select", { ref: "e2", value: "큰 컵" });
  assert.equal(sel.isError, false, JSON.stringify(sel.content));
  assert.deepEqual(actionResultProblems("browser_select", sel), []);
  assert.match(sel.observation.snapshot, /select=\{"size":"l"\}/);
  const hov = await ex.execute("browser_hover", { ref: "e1" });
  assert.match(hov.observation.snapshot, /hover=order/);
  const scr = await ex.execute("browser_scroll", { ref: "e3" });
  assert.match(scr.observation.snapshot, /scroll=help/);
  const pageScroll = await ex.execute("browser_scroll", { dy: 300 });
  assert.match(pageScroll.observation.snapshot, /y=300/);
  const before = pageScroll.observation.documentGeneration;
  const rel = await ex.execute("browser_reload");
  assert.equal(rel.isError, false, JSON.stringify(rel.content));
  assert.notEqual(rel.observation.documentGeneration, before, "reload yields a new document");
  assert.match(rel.observation.snapshot, /y=0/);
  for (const r of [sel, hov, scr, pageScroll, rel]) assert.deepEqual(actionResultProblems("x", { ...r }).filter((p) => !p.startsWith("unknown")), []);
  // The pre-CR actions return the resulting observation too.
  const click = await ex.execute("browser_click", { ref: "e1" });
  assert.deepEqual(actionResultProblems("browser_click", click), []);
  assert.match(click.observation.snapshot, /clicks=order/);
});

await test("CR-T06 negative: unknown action, stripped observation, and stale refs after reload", async () => {
  const page = makeFakePage({ elements: WITH_SELECT });
  const { ex } = executorFor(page);
  const unknown = await ex.execute("browser_teleport", {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /알 수 없는 도구: browser_teleport/);

  await ex.execute("browser_observe");
  const good = await ex.execute("browser_hover", { ref: "e1" });
  const { observation: _o, ...stripped } = good;
  assert.deepEqual(actionResultProblems("browser_hover", stripped), ["missing observation"]);

  await ex.execute("browser_observe"); // refs of document L0
  page.newDocument(); // e.g. the live server's SSE reload: a new document without our action
  await tick(10);
  const callsBefore = page.calls.length;
  for (const [name, input] of [["browser_select", { ref: "e2", value: "s" }], ["browser_scroll", { ref: "e3" }], ["browser_hover", { ref: "e1" }]]) {
    const r = await ex.execute(name, input);
    assert.equal(r.isError, true, `${name} on a stale ref must not run`);
    assert.match(r.content[0].text, /이전 문서의 ref/);
  }
  const acted = page.calls.slice(callsBefore).filter((c) => ["DOM.resolveNode", "Runtime.callFunctionOn", "Input.dispatchMouseEvent", "DOM.getBoxModel"].includes(c.method));
  assert.deepEqual(acted, [], "no CDP action reached the page for a stale ref");
  assert.equal(page.state.dom.hovered, "order", "state unchanged by the refused hover (still the earlier one)");
});

// ── CR-T08 (unit half) — the step a failure happened in ─────────────────────

await test("CR-T08 unit: a console error raised by step 3 is reported once, at step 3; a clean flow reports none", async () => {
  const flow = [["browser_click", { ref: "e1" }], ["browser_click", { ref: "e2" }], ["browser_click", { ref: "e3" }], ["browser_click", { ref: "e1" }], ["browser_click", { ref: "e2" }]];
  for (const planted of [true, false]) {
    let clicks = 0;
    const page = makeFakePage({ onClick: (p) => { clicks++; if (planted && clicks === 3) p.consoleError("step-3-error"); } });
    const { ex } = executorFor(page);
    await ex.execute("browser_observe");
    const failures = [];
    for (const [name, input] of flow) {
      const r = await ex.execute(name, input);
      assert.equal(r.isError, false);
      for (const f of failuresOf(r.observation.records)) if (!failures.some((g) => g.message === f.message)) failures.push(f);
    }
    if (planted) assert.deepEqual(failures, [{ step: 3, kind: "console", message: "step-3-error" }]);
    else assert.deepEqual(failures, [], "no false positive on the unmodified flow");
  }
});

// ── CR-T11 origin scope ─────────────────────────────────────────────────────

await test("CR-T11 positive: agent browser actions on the live-server origin run", async () => {
  const page = makeFakePage();
  const { ex } = executorFor(page);
  const nav = await ex.execute("browser_navigate", { url: `${ORIGIN}/menu.html` });
  assert.equal(nav.isError, false, JSON.stringify(nav.content));
  assert.equal(nav.observation.route, "/menu.html");
  assert.deepEqual(checkAgentOrigin(`${ORIGIN}/x`, [ORIGIN]), { ok: true });
});

await test("CR-T11 negative: external origins are refused with a reason before any CDP call", async () => {
  const page = makeFakePage();
  const { ex } = executorFor(page);
  for (const url of ["https://example.com/", "http://127.0.0.1:9999/", "file:///etc/passwd", "http://localhost:5173/"]) {
    const before = page.calls.length;
    const r = await ex.execute("browser_navigate", { url });
    assert.equal(r.isError, true, url);
    assert.match(r.content[0].text, /범위 밖이라 거절|미리보기/, url);
    assert.equal(page.calls.length, before, `no CDP call for ${url}`);
  }
  // A tab that is already on an external page: element actions are refused too.
  const external = makeFakePage({ origin: "https://example.com" });
  const r = await executorFor(external).ex.execute("browser_click", { ref: "e1" });
  assert.equal(r.isError, true);
  assert.equal(external.calls.length, 0);
  // Back into an external history entry is refused before navigating.
  const hist = makeFakePage({ backUrl: "https://example.com/" });
  const { ex: hx } = executorFor(hist);
  await hx.execute("browser_observe");
  const back = await hx.execute("browser_back");
  assert.equal(back.isError, true);
  assert.ok(!hist.calls.some((c) => c.method === "Page.navigateToHistoryEntry"));
  // No preview running: refused with the reason, not a silent no-op.
  const none = await executorFor(makeFakePage(), { allowedOrigins: () => [] }).ex.execute("browser_observe");
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /미리보기가 켜져 있지 않아요/);
});

// ── CR-T63 (unit half) — the page-level indicator ───────────────────────────

/** The instrument: every page-changing CDP call must happen while the outline is drawn. */
function indicatorProblems(calls) {
  const ACT = new Set(["Input.dispatchMouseEvent", "Runtime.callFunctionOn", "Page.reload", "Input.insertText"]);
  let drawn = false;
  const problems = [];
  for (const c of calls) {
    if (c.method === "Overlay.highlightRect") drawn = true;
    else if (c.method === "Overlay.hideHighlight") drawn = false;
    else if (ACT.has(c.method) && !drawn) problems.push(`${c.method} with no indicator`);
    else if (c.method === "Page.captureScreenshot" && drawn) problems.push("evidence screenshot taken with the outline drawn");
  }
  if (drawn) problems.push("indicator left on after the step");
  return problems;
}

await test("CR-T63 unit positive: outline drawn during each step, cleared for the screenshot and after the step", async () => {
  const page = makeFakePage({ elements: WITH_SELECT });
  const { ex, indicator } = executorFor(page);
  await ex.execute("browser_observe");
  page.calls.length = 0;
  await ex.execute("browser_hover", { ref: "e1" });
  await ex.execute("browser_select", { ref: "e2", value: "s" });
  await ex.execute("browser_reload");
  assert.deepEqual(indicatorProblems(page.calls), []);
  assert.ok(page.calls.some((c) => c.method === "Overlay.highlightRect"));
  // Chat-panel half: every step is bracketed true → false.
  assert.deepEqual(indicator.slice(-2), [{ visible: true, tool: "browser_reload" }, { visible: false, tool: "browser_reload" }]);
});

await test("CR-T63 unit negative: a step with no visible indicator is caught", async () => {
  const page = makeFakePage();
  const { ex } = executorFor(page);
  await ex.execute("browser_observe");
  page.calls.length = 0;
  await ex.execute("browser_hover", { ref: "e1" });
  const planted = page.calls.filter((c) => c.method !== "Overlay.highlightRect");
  assert.ok(indicatorProblems(planted).some((p) => /with no indicator/.test(p)));
  const leftOn = page.calls.filter((c, i, all) => !(c.method === "Overlay.hideHighlight" && i === all.map((x) => x.method).lastIndexOf("Overlay.hideHighlight")));
  assert.ok(indicatorProblems(leftOn).includes("indicator left on after the step"));
});

await test("dialog: an action that leaves a JS dialog open is an explicit error, not a hang", async () => {
  const page = makeFakePage({ onClick: (p) => { p.state.dialog = "alert"; p.emit("Page.javascriptDialogOpening", { type: "alert", message: "주문 완료" }); } });
  const { ex } = executorFor(page);
  await ex.execute("browser_observe");
  const r = await ex.execute("browser_click", { ref: "e1" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /대화상자가 열려 있어 관찰할 수 없어요 \(alert: 주문 완료\)/);
  const handled = await ex.execute("browser_dialog", { action: "accept" });
  assert.equal(handled.isError, false, JSON.stringify(handled.content));
});

console.log(`\n${passed} experiment-browser checks passed`);
