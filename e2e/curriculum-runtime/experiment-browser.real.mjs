// cr-browser (#1391) — the Experiment Browser core against REAL Chromium CDP.
//
// Evidence class: synthetic. Real Chromium (Playwright's build) and Studio's own serving
// code (`serveStatic`, live-reload injection included), but NOT the Studio app: the
// integrated browser, the tab layout and the compositor questions of recon F7/F8 are the
// Electron layer's, recorded separately. What this run can show is that the CDP logic
// (events, attribution, actions, refs, pick, crop, overlay) behaves on a real engine the
// way the mock-channel smokes assume.
//
// CR-T04 observation · CR-T05 records · CR-T06 actions · CR-T07 five-step flow ·
// CR-T08 step of a failure · CR-T09 element → AI · CR-T11 origin scope ·
// CR-T63 indicator · CR-T56 capture timing (30 samples). Each with its controls.
//
// Run (from e2e/): node --experimental-strip-types curriculum-runtime/experiment-browser.real.mjs [--out result.json]
// Exit: 0 every check and control held · 1 a check or a control failed · 2 could not run.

import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "../../extensions/hypeproof-chat/src");
const { serveStatic, LIVERELOAD_PATH } = await import(join(ext, "liveServerHelpers.ts"));
const eb = await import(join(ext, "experimentBrowser.ts"));
const { buildElementContext, waitForPick, elementContextProblems, cropElement } = await import(join(ext, "elementPick.ts"));
const { artifactVersionFor } = await import(join(ext, "artifactVersion.ts"));
const { CrExecutor, PageEventLog, observationProblems, actionResultProblems, failuresOf } = eb;

const ROOT = join(here, "fixtures/kiosk-practice");
const outArg = process.argv.indexOf("--out");
const outFile = outArg > 0 ? process.argv[outArg + 1] : null;
const results = [];
const record = (id, check, pass, detail = "") => {
  results.push({ id, check, verdict: pass ? "PASS" : "FAIL", detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${check}${detail ? `  — ${detail}` : ""}`);
};

// ── the preview server: Studio's serveStatic + the SSE endpoint, as LiveServer does ──
const sse = new Set();
const server = createServer((req, res) => {
  if ((req.url ?? "/").split("?")[0] === LIVERELOAD_PATH) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    sse.add(res);
    res.on("close", () => sse.delete(res));
    return;
  }
  const r = serveStatic(ROOT, req.url ?? "/");
  res.writeHead(r.status, { "content-type": r.contentType, "cache-control": "no-store" });
  res.end(r.body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const pushReload = () => { for (const res of sse) res.write("data: reload\n\n"); };

let browser;
try {
  // Full Chromium in new-headless mode, not the headless shell: the shell does not paint
  // the inspector overlay into CDP screenshots, so CR-T63 could not see the outline there.
  browser = await chromium.launch({ headless: true, channel: "chromium" });
} catch (err) {
  console.error(`could not launch Chromium: ${err.message}`);
  server.close();
  process.exit(2);
}
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });

/** A fresh tab + CDP session wrapped as the CdpLike the core takes. */
async function openTab(path) {
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const EVENTS = [
    "Page.frameNavigated", "Page.javascriptDialogOpening", "Page.javascriptDialogClosed",
    "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.consoleAPICalled", "Runtime.exceptionThrown",
    "Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFailed", "Log.entryAdded", "Overlay.inspectNodeRequested",
  ];
  const listeners = new Set();
  for (const name of EVENTS) session.on(name, (params) => { for (const fn of [...listeners]) fn({ method: name, params: params ?? {} }); });
  const calls = [];
  const cdp = {
    calls,
    send: (method, params = {}) => { calls.push(method); return session.send(method, params); },
    onEvent: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
  if (path) await page.goto(ORIGIN + path, { waitUntil: "load" });
  const port = {
    session: async () => cdp,
    tabUrl: () => page.url(),
    navigate: async (url) => {
      await cdp.send("Page.navigate", { url });
      await page.waitForLoadState("load");
    },
  };
  return { page, cdp, port };
}

const version = (url) => {
  const u = new URL(url);
  return artifactVersionFor(ROOT, u.pathname);
};
const executor = (port, over = {}) =>
  new CrExecutor(port, { allowedOrigins: () => [ORIGIN], artifactVersion: version, settleMs: 250, ...over });
/** The ref of the element whose snapshot line has this role and name. */
const refOf = (snapshot, role, name) => {
  const m = new RegExp(`\\[ref=(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(snapshot);
  return m ? m[1] : null;
};

// ── CR-T04 ──────────────────────────────────────────────────────────────────
{
  const { port, page } = await openTab("/index.html");
  const r = await executor(port).execute("browser_observe");
  const o = r.observation;
  const probs = observationProblems(o ?? null);
  const refsOk = !!o && ["주문 시작", "큰 글씨로 보기", "도움말 보기"].every((n) => refOf(o.snapshot, "button", n));
  record("CR-T04", "observation: URL, route, snapshot refs, screenshot, viewport, document generation, version", !r.isError && probs.length === 0 && o.route === "/index.html" && o.title === "키오스크 연습" && o.viewport.width === 390 && o.viewport.height === 844 && refsOk && /^[A-F0-9]{32}$/.test(o.documentGeneration),
    o ? `route ${o.route} · viewport ${o.viewport.width}x${o.viewport.height} · generation ${o.documentGeneration} · version ${o.artifact.id.slice(0, 19)}… (${o.artifact.files.length} files)` : JSON.stringify(r.content));
  const { viewport: _v, ...planted } = o ?? {};
  record("CR-T04", "negative control: an observation with the viewport removed is an error", observationProblems(planted).includes("viewport"));
  await page.close();
}

// ── CR-T05 ──────────────────────────────────────────────────────────────────
{
  const { cdp, page } = await openTab();
  const log = new PageEventLog();
  await page.goto(ORIGIN + "/index.html", { waitUntil: "load" });
  await log.attach(cdp);
  await page.goto(ORIGIN + "/index.html?plant=errors", { waitUntil: "load" });
  await page.waitForTimeout(400);
  const planted = log.records();
  const kinds = planted.map((r) => r.kind).sort().join(",");
  record("CR-T05", "one console.error + one throw + one 404 → exactly three records", planted.length === 3 && kinds === "console,exception,network", planted.map((r) => `${r.kind}:${r.message.slice(0, 60)}`).join(" | "));
  const plantedGen = log.documentGeneration;
  await page.goto(ORIGIN + "/index.html", { waitUntil: "load" });
  await page.waitForTimeout(400);
  record("CR-T05", "negative: a clean page yields zero records (live-reload script and favicon included)", log.records().length === 0, JSON.stringify(log.records()));
  record("CR-T05", "negative: the previous document's records stay with it", log.documentGeneration !== plantedGen && log.records(plantedGen).length === 3);
  // The live server's own SSE reload is a new document too (recon F4).
  const before = log.documentGeneration;
  pushReload();
  await page.waitForTimeout(800);
  record("CR-T05", "a live-server SSE reload is seen as a new document", log.documentGeneration !== before, `${before} → ${log.documentGeneration}`);
  await page.close();
}

// ── CR-T06 ──────────────────────────────────────────────────────────────────
{
  const { port, page } = await openTab("/index.html");
  const ex = executor(port);
  let o = (await ex.execute("browser_observe")).observation;
  await ex.execute("browser_click", { ref: refOf(o.snapshot, "button", "주문 시작") });
  o = (await ex.execute("browser_observe")).observation;
  const sel = await ex.execute("browser_select", { ref: refOf(o.snapshot, "combobox", "음료 고르기"), value: "아이스티" });
  record("CR-T06", "select changes what the next observation shows", !sel.isError && /고른 음료: 아이스티/.test(sel.observation?.snapshot ?? ""), sel.isError ? sel.content[0].text : "");
  const scr = await ex.execute("browser_scroll", { ref: refOf(sel.observation.snapshot, "button", "장바구니에 담기") });
  const scrolled = await page.evaluate(() => window.scrollY);
  record("CR-T06", "scroll brings a far element into view", !scr.isError && scrolled > 500, `scrollY ${scrolled}`);
  const hov = await ex.execute("browser_hover", { ref: refOf(scr.observation.snapshot, "button", "주문하기") });
  const hovered = await page.evaluate(() => document.querySelector("#pay").matches(":hover"));
  record("CR-T06", "hover lands on the element", !hov.isError && hovered);
  const gen = hov.observation.documentGeneration;
  const rel = await ex.execute("browser_reload");
  record("CR-T06", "reload yields a new document and its observation", !rel.isError && rel.observation.documentGeneration !== gen && /주문 시작/.test(rel.observation.snapshot));
  record("CR-T06", "every action returned its resulting observation", [sel, scr, hov, rel].every((r) => actionResultProblems("browser_select", r).length === 0));
  // Negative: refs from before a reload are not executed. The reload happens OUTSIDE the
  // agent (the student, or the live server's SSE reload): an agent's own browser_reload
  // returns the new observation and so hands out fresh refs.
  o = rel.observation;
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(200);
  const staleRef = refOf(o.snapshot, "button", "주문 시작");
  const staleResults = [];
  for (const [name, input] of [["browser_select", { ref: staleRef, value: "커피" }], ["browser_scroll", { ref: staleRef }], ["browser_hover", { ref: staleRef }]]) {
    staleResults.push(await ex.execute(name, input));
  }
  const stillStart = await page.evaluate(() => !document.querySelector("#start").hidden && !document.querySelector("#begin").matches(":hover"));
  record("CR-T06", "negative: select/scroll/hover on refs from before a reload are refused", staleResults.every((r) => r.isError && /이전 문서의 ref/.test(r.content[0].text)) && stillStart);
  const unknown = await ex.execute("browser_teleport", {});
  record("CR-T06", "negative: an unknown action is an explicit error", unknown.isError && /알 수 없는 도구/.test(unknown.content[0].text));
  const { observation: _x, ...stripped } = hov;
  record("CR-T06", "negative: a result without its observation fails the contract", actionResultProblems("browser_hover", stripped).includes("missing observation"));
  await page.close();
}

// ── CR-T07 / CR-T08: the five-step flow, driven by a scripted agent ─────────
const FLOW = [
  { name: "browser_click", target: ["button", "주문 시작"], expect: /음료 고르기/ },
  { name: "browser_select", target: ["combobox", "음료 고르기"], value: "아이스티", expect: /고른 음료: 아이스티/ },
  { name: "browser_click", target: ["button", "수량 늘리기"], expect: /수량: 2/ },
  { name: "browser_click", target: ["button", "장바구니에 담기"], expect: /장바구니: 2개/ },
  { name: "browser_click", target: ["button", "주문하기"], expect: /주문이 완료되었어요/ },
];
/** The agent: act on the latest observation's ref, check the step's expected state, stop at the first miss. */
async function runFlow(query) {
  const { port, page } = await openTab(`/index.html${query}`);
  const ex = executor(port);
  let obs = (await ex.execute("browser_observe")).observation;
  const failures = [];
  let failedAt = null;
  for (const [i, step] of FLOW.entries()) {
    const ref = refOf(obs.snapshot, ...step.target);
    const r = ref ? await ex.execute(step.name, { ref, ...(step.value ? { value: step.value } : {}) }) : null;
    if (r?.observation) {
      for (const f of failuresOf(r.observation.records)) if (!failures.some((g) => g.message === f.message)) failures.push(f);
      obs = r.observation;
    }
    if (!r || r.isError || !step.expect.test(obs.snapshot)) {
      failedAt = i + 1;
      break;
    }
  }
  await page.close();
  return { failedAt, failures };
}
{
  const clean = await runFlow("");
  record("CR-T07", "unmodified fixture: five steps succeed, final order screen", clean.failedAt === null, JSON.stringify(clean));
  const disabled = await runFlow("?plant=disabled-step4");
  record("CR-T07", "negative: a disabled button at step 4 is reported as failure at step 4", disabled.failedAt === 4, JSON.stringify(disabled));
  const planted = await runFlow("?plant=console-step3");
  const at3 = planted.failures.filter((f) => /planted-step3-error/.test(f.message));
  record("CR-T08", "a console error raised in step 3 is reported once, at step 3", at3.length === 1 && at3[0].step === 3 && planted.failures.length === 1, JSON.stringify(planted.failures));
  record("CR-T08", "negative: the unmodified flow reports no failure", clean.failures.length === 0, JSON.stringify(clean.failures));
}

// ── CR-T09: element → AI ─────────────────────────────────────────────────────
{
  const { port, cdp, page } = await openTab("/index.html");
  const ex = executor(port);
  const first = (await ex.execute("browser_observe")).observation;
  const log = await ex.logFor(cdp);
  let table = new Map();
  const deps = {
    root: ROOT,
    artifactVersion: version,
    refFor: (id) => ex.refFor(id),
    adopt: (refs, g) => { table = refs; ex.adoptRefs(refs, g); },
  };
  // The student's click in inspect mode: a real mouse click on the element.
  const box = await page.locator("#begin").boundingBox();
  const pickPromise = waitForPick(cdp, 5000);
  await page.waitForTimeout(150);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  let picked = null;
  try { picked = await pickPromise; } catch (e) { record("CR-T09", "the inspect-mode click reaches Overlay.inspectNodeRequested", false, e.message); }
  const stillStart = await page.evaluate(() => !document.querySelector("#start").hidden);
  if (picked !== null) {
    record("CR-T09", "the inspect-mode click is a pick, not a click on the page", stillStart);
    const ctx = await buildElementContext(cdp, log, picked, deps);
    const expectedRef = refOf(first.snapshot, "button", "주문 시작");
    const problems = elementContextProblems(ctx, { refTarget: (r) => table.get(r), viewport: { width: 390, height: 844 }, maxMs: 1000 });
    record("CR-T09", "picking the start button: its ref, snippet, style, element crop, mapping to index.html", problems.length === 0 && ctx.ref === expectedRef && /<button id="begin"/.test(ctx.snippet) && ctx.style["background-color"] === "rgb(10, 20, 30)" && ctx.source !== "unmapped" && ctx.source.file === "index.html" && ctx.crop && ctx.crop.clip.width < 390,
      `ref ${ctx.ref} (snapshot ${expectedRef}) · source ${JSON.stringify(ctx.source)} · crop ${ctx.crop ? `${Math.round(ctx.crop.clip.width)}x${Math.round(ctx.crop.clip.height)}` : "none"} · ${ctx.captureMs} ms · ${problems.join("; ")}`);
    record("CR-T09", "negative: a payload carrying another element's ref fails", elementContextProblems({ ...ctx, ref: refOf(first.snapshot, "button", "주문하기") }, { refTarget: (r) => table.get(r) }).length > 0);
    // The agent can act on the picked ref right away (the table is the executor's).
    const acted = await ex.execute("browser_click", { ref: ctx.ref });
    record("CR-T09", "the picked ref is the agent's ref: clicking it acts on the picked element", !acted.isError && /음료 고르기/.test(acted.observation.snapshot));
  }
  const tipId = (await cdp.send("DOM.describeNode", { objectId: (await cdp.send("Runtime.evaluate", { expression: "document.getElementById('tip')" })).result.objectId })).node.backendNodeId;
  const tip = await buildElementContext(cdp, log, tipId, deps);
  record("CR-T09", "negative: an element the script generates is \"unmapped\", never a guessed file", tip.source === "unmapped", JSON.stringify(tip.source));
  await page.close();
}

// ── CR-T11 ──────────────────────────────────────────────────────────────────
{
  const { port, cdp, page } = await openTab("/index.html");
  const ex = executor(port);
  const ok = await ex.execute("browser_navigate", { url: `${ORIGIN}/index.html?again=1` });
  record("CR-T11", "agent browser actions on the live-server origin run", !ok.isError && ok.observation.route === "/index.html?again=1");
  const before = cdp.calls.length;
  const out = await ex.execute("browser_navigate", { url: "https://example.com/" });
  record("CR-T11", "negative: navigating to an external origin is refused with a reason, before any CDP call", out.isError && /범위 밖이라 거절/.test(out.content[0].text) && cdp.calls.length === before && page.url().startsWith(ORIGIN));
  await page.close();
}

// ── CR-T63: the page outline is on during a step and off for evidence ──────
/** Run one hover step and capture the page mid-step (during the settle wait) and after it. */
async function outlineRun(dropOutline) {
  const { port, cdp, page } = await openTab("/index.html");
  const shot = async () => (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 })).data;
  // The planted variant drops every outline call: an automation step with no indicator.
  const wrapped = dropOutline
    ? { ...port, session: async () => ({ ...cdp, send: (m, p) => (m === "Overlay.highlightRect" ? Promise.resolve({}) : cdp.send(m, p)) }) }
    : port;
  let during = null;
  const ex = executor(wrapped, { settleMs: 1, sleep: async () => { during = await shot(); } });
  const o = (await ex.execute("browser_observe")).observation;
  const r = await ex.execute("browser_hover", { ref: refOf(o.snapshot, "button", "주문 시작") });
  const after = await shot();
  const calls = cdp.calls;
  await page.close();
  return { during, after, evidence: r.observation?.screenshot?.data ?? null, cleared: calls.lastIndexOf("Overlay.hideHighlight") > calls.lastIndexOf("Overlay.highlightRect") };
}
{
  const run = await outlineRun(false);
  record("CR-T63", "the outline is visible on the page during an agent step", !!run.during && run.during !== run.after);
  record("CR-T63", "the evidence screenshot is taken with the outline cleared", run.evidence === run.after);
  record("CR-T63", "the outline is gone after the step", run.cleared);
  const planted = await outlineRun(true);
  record("CR-T63", "negative: a step with no outline drawn is detected (mid-step page equals the page after)", !(!!planted.during && planted.during !== planted.after));
}

// ── CR-T56: element capture to context, 30 samples ──────────────────────────
{
  const { port, cdp, page } = await openTab("/index.html");
  const ex = executor(port);
  await ex.execute("browser_observe");
  const log = await ex.logFor(cdp);
  const id = (await cdp.send("DOM.describeNode", { objectId: (await cdp.send("Runtime.evaluate", { expression: "document.getElementById('begin')" })).result.objectId })).node.backendNodeId;
  const deps = { root: ROOT, artifactVersion: version, refFor: (x) => ex.refFor(x), adopt: (r, g) => ex.adoptRefs(r, g) };
  const samples = [];
  let bad = 0;
  for (let i = 0; i < 30; i++) {
    const ctx = await buildElementContext(cdp, log, id, deps);
    samples.push(ctx.captureMs);
    if (elementContextProblems(ctx, { refTarget: () => id, viewport: { width: 390, height: 844 }, maxMs: 1000 }).length) bad++;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[14] / 2 + sorted[15] / 2;
  record("CR-T56", "element capture to context: p50 under 1 s of local processing (n=30)", p50 < 1000 && bad === 0, `p50 ${p50} ms · min ${sorted[0]} · max ${sorted[29]} · ${os.cpus()[0]?.model ?? "?"} · headless Chromium, not the Studio app`);
  // Negative: a full-page screenshot in place of the element crop is reported as a miss.
  const full = await cdp.send("Page.captureScreenshot", { format: "png" });
  const ctx = await buildElementContext(cdp, log, id, deps);
  const planted = { ...ctx, crop: { mimeType: "image/png", data: full.data, clip: { x: 0, y: 0, width: 390, height: 844 } } };
  record("CR-T56", "negative: a planted full-page screenshot in place of the crop is a miss", elementContextProblems(planted, { refTarget: () => id, viewport: { width: 390, height: 844 } }).some((p) => /whole viewport/.test(p)));
  const crop = await cropElement(cdp, id);
  record("CR-T56", "the crop is the element's box", !!crop && crop.clip.width < 390 && crop.clip.height < 200, crop ? `${Math.round(crop.clip.width)}x${Math.round(crop.clip.height)}` : "none");
  await page.close();
}

await browser.close();
server.close();
for (const res of sse) res.destroy();
const failed = results.filter((r) => r.verdict !== "PASS");
if (outFile) writeFileSync(outFile, JSON.stringify({ origin: ORIGIN, chromium: browser.version?.() ?? null, at: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
