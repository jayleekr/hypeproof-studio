// cr-browser (#1391) — element → AI payload (CR-T09 unit half) and the capture checks
// CR-T56 applies (unit half; the 30-sample timing is a real-Mac run).
//
// Run: node --experimental-strip-types test/element-pick.smoke.mjs

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakePage, fakePort, FAKE_VERSION } from "./fixtures/fake-cdp-page.mjs";

const { buildElementContext, waitForPick, mapSource, elementContextProblems, elementContextText, STYLE_KEYS, SNIPPET_MAX } = await import("../src/elementPick.ts");
const { PageEventLog, CrExecutor } = await import("../src/experimentBrowser.ts");
const { browserTabCoverage } = await import("../src/browserControlHelpers.ts");

let passed = 0;
const ok = (name) => { passed++; console.log(`✓ ${name}`); };

const KIOSK = `<!doctype html>
<html><head><title>키오스크 연습</title><style>button { color: red } /* <button>주문하기</button> */</style></head>
<body>
  <h1>메뉴를 고르세요</h1>
  <button id="order">주문하기</button>
  <button>취소</button>
  <button>도움말</button>
  <p>같은 글자</p><p>같은 글자</p>
  <div id="rec"></div>
  <script>
    const b = document.createElement("button");
    b.textContent = "추가 주문";
    document.body.append(b);
    document.getElementById("rec").innerHTML = '<button>추천 메뉴</button>';
  </script>
</body></html>`;

// ── source mapping ──────────────────────────────────────────────────────────
{
  assert.deepEqual(mapSource(KIOSK, "index.html", { tag: "button", id: "order", text: "주문하기" }), { file: "index.html", line: 5 });
  assert.deepEqual(mapSource(KIOSK, "index.html", { tag: "button", text: "취소" }), { file: "index.html", line: 6 });
  ok("CR-T09 positive: an element defined in markup maps to its file and line (by id, else by exact text)");
  assert.equal(mapSource(KIOSK, "index.html", { tag: "button", text: "추가 주문" }), "unmapped", "script-generated: never a guessed line");
  assert.equal(mapSource(KIOSK, "index.html", { tag: "button", text: "추천 메뉴" }), "unmapped", "markup inside a script string is not where the element is defined");
  assert.equal(mapSource(KIOSK, "index.html", { tag: "p", text: "같은 글자" }), "unmapped", "two candidates are a guess");
  assert.equal(mapSource(KIOSK, "index.html", { tag: "div", text: "주문하기" }), "unmapped", "another tag's text is not this element");
  // A script-made clone: an id no markup defines, text equal to a static element's. The id
  // miss is final; it never falls back to the static element's line.
  assert.equal(mapSource(KIOSK, "index.html", { tag: "button", id: "clone", text: "주문하기" }), "unmapped", "an undefined id is never text-matched onto another element");
  // The same text on two live elements (one static, one generated, no ids): a text match cannot tell them apart.
  assert.equal(mapSource(KIOSK, "index.html", { tag: "button", text: "취소", twins: 2 }), "unmapped", "live-DOM twins make a text match a guess");
  assert.deepEqual(mapSource(KIOSK, "index.html", { tag: "button", text: "취소", twins: 1 }), { file: "index.html", line: 6 }, "control: one live element with that text still maps");
  // Two markup elements with the same id: which one was picked cannot be told from the id.
  const DUP = `<body>\n<button id="x">가</button>\n<button id="x">나</button>\n<button id="y">다</button>\n</body>`;
  assert.equal(mapSource(DUP, "index.html", { tag: "button", id: "x", text: "가" }), "unmapped", "a duplicated id is a guess");
  assert.deepEqual(mapSource(DUP, "index.html", { tag: "button", id: "y", text: "다" }), { file: "index.html", line: 4 }, "control: a unique id next to it maps");
  ok("CR-T09 negative: a script-generated or ambiguous element is \"unmapped\", never a guessed file");
}

// ── the payload over a scripted page ───────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "cr-pick-"));
writeFileSync(join(root, "index.html"), KIOSK);
const ELEMENTS = [
  { key: "order", role: "button", name: "주문하기", tag: "button", id: "order" },
  { key: "cancel", role: "button", name: "취소", tag: "button", id: "" },
  { key: "extra", role: "button", name: "추가 주문", tag: "button", id: "" },
];
try {
  const page = makeFakePage({ elements: ELEMENTS });
  const log = new PageEventLog();
  await log.attach(page.cdp);
  let table = new Map();
  const deps = {
    root,
    artifactVersion: async () => FAKE_VERSION,
    refFor: (id) => [...table].find(([, v]) => v === id)?.[0] ?? null,
    adopt: (refs) => { table = refs; },
  };

  // The student's click arrives as Overlay.inspectNodeRequested.
  const orderId = page.nodeId("order");
  setTimeout(() => page.emit("Overlay.inspectNodeRequested", { backendNodeId: orderId }), 10);
  const picked = await waitForPick(page.cdp, 2000);
  assert.equal(picked, orderId);
  const modes = page.calls.filter((c) => c.method === "Overlay.setInspectMode").map((c) => c.params.mode);
  assert.deepEqual(modes, ["searchForNode", "none"], "inspect mode is left after the pick");

  const ctx = await buildElementContext(page.cdp, log, picked, deps);
  const ctxShort = ctx;
  assert.equal(ctx.ref, "e1");
  assert.equal(table.get("e1"), orderId, "the payload's ref is the observation table's ref for that node");
  assert.equal(ctx.snippet, `<button id="order">주문하기</button>`);
  assert.deepEqual(Object.keys(ctx.style).sort(), ["background-color", "display"], "only the computed-style subset");
  assert.ok(Object.keys(ctx.style).every((k) => STYLE_KEYS.includes(k)));
  assert.equal(ctx.crop.mimeType, "image/png");
  assert.deepEqual(ctx.crop.clip, { x: 10, y: 10, width: 100, height: 30 }, "crop = the element's border box");
  const shot = page.calls.find((c) => c.method === "Page.captureScreenshot");
  assert.ok(shot.params.clip, "the capture is clipped, never the full page");
  assert.deepEqual(ctx.source, { file: "index.html", line: 5 });
  assert.equal(ctx.artifact.id, FAKE_VERSION.id, "the capture names its artifact version (CR-10)");
  assert.deepEqual(elementContextProblems(ctx, { refTarget: (r) => table.get(r), viewport: page.state.viewport, maxMs: 1000 }), []);
  assert.match(elementContextText(ctx), /ref: e1[\s\S]*소스 위치: index.html:5[\s\S]*<button id="order">주문하기<\/button>/);
  ok("CR-T09 positive: picking the order button yields its ref, snippet, style subset, element crop and a mapping to index.html");
  ok(`CR-T56 unit positive: element capture processed in ${ctx.captureMs} ms (< 1000) with an element crop`);

  // Negative: a payload carrying another element's ref fails.
  assert.ok(elementContextProblems({ ...ctx, ref: "e2" }, { refTarget: (r) => table.get(r) }).some((p) => /does not name the picked node/.test(p)));
  // Negative: an inline-generated element is "unmapped", end to end.
  const extra = await buildElementContext(page.cdp, log, page.nodeId("extra"), deps);
  assert.equal(extra.source, "unmapped");
  assert.match(elementContextText(extra), /unmapped/);
  ok("CR-T09 negative: a different element's ref fails; an inline-generated element yields \"unmapped\"");

  // CR-T56 negative: a planted full-page screenshot in place of the element crop, and a slow capture.
  const fullPage = { ...ctx, crop: { ...ctx.crop, clip: { x: 0, y: 0, width: 800, height: 600 } } };
  assert.ok(elementContextProblems(fullPage, { refTarget: (r) => table.get(r), viewport: page.state.viewport }).some((p) => /whole viewport/.test(p)));
  assert.ok(elementContextProblems({ ...ctx, crop: null }, { refTarget: (r) => table.get(r) }).includes("no element crop"));
  const slow = await buildElementContext(page.cdp, log, orderId, { ...deps, now: (() => { let t = 0; return () => (t += 3000); })() });
  assert.ok(elementContextProblems(slow, { refTarget: (r) => table.get(r), maxMs: 1000 }).some((p) => /capture took 3000 ms/.test(p)));
  ok("CR-T56 unit negative: a full-page crop and a 3 s capture are reported as misses");

  // A node the snapshot has no ref for gets a new ref in the same table.
  const heading = makeFakePage({ elements: [...ELEMENTS, { key: "h", role: "generic", name: "", tag: "h1", id: "" }] });
  const hlog = new PageEventLog();
  await hlog.attach(heading.cdp);
  let htable = new Map();
  const hctx = await buildElementContext(heading.cdp, hlog, heading.nodeId("h"), { ...deps, adopt: (r) => { htable = r; } });
  assert.equal(hctx.ref, `p${heading.nodeId("h")}`, "a pick-only label, never the next snapshot label");
  assert.equal(htable.get(hctx.ref), heading.nodeId("h"));
  ok("a non-interactive element gets its own ref in the observation's table, so the agent can act on it");

  // After a fresh observation whose tree has one more entry, the pick label is refused, not
  // rebound to whatever node the new snapshot numbers next.
  {
    const pg = makeFakePage({ elements: [...ELEMENTS, { key: "h", role: "generic", name: "", tag: "h1", id: "" }] });
    const ex = new CrExecutor(fakePort(pg), { allowedOrigins: () => ["http://127.0.0.1:5173"], artifactVersion: async () => FAKE_VERSION, settleMs: 0, sleep: async () => {} });
    await ex.execute("browser_observe");
    const pctx = await buildElementContext(pg.cdp, await ex.logFor(pg.cdp), pg.nodeId("h"), { ...deps, refFor: (id) => ex.refFor(id), adopt: (r, g) => ex.adoptRefs(r, g) });
    const hover = await ex.execute("browser_hover", { ref: pctx.ref });
    assert.equal(hover.isError, false, "control: the pick label acts on the picked node until the next observation");
    pg.state.elements.push({ key: "late", role: "button", name: "나중 버튼", tag: "button", id: "late" });
    await ex.execute("browser_observe"); // now four snapshot refs: e4 is the new button
    const stale = await ex.execute("browser_click", { ref: pctx.ref });
    assert.equal(stale.isError, true, "the pick label is refused after a fresh observation");
    assert.ok(!pg.state.dom.clicked.includes("late"), "and never lands on the node the new snapshot numbered next");
    ok("CR-09: a pick-only ref is refused after a fresh observation, never rebound to another node");
  }

  // CR-09 bound: a large element's DOM snippet is cut to SNIPPET_MAX and says so.
  const wall = makeFakePage({ elements: [{ key: "wall", role: "generic", name: "글".repeat(SNIPPET_MAX * 2), tag: "div", id: "wall" }] });
  const wlog = new PageEventLog();
  await wlog.attach(wall.cdp);
  const wctx = await buildElementContext(wall.cdp, wlog, wall.nodeId("wall"), deps);
  assert.equal(wctx.snippet.length, SNIPPET_MAX, "the snippet is bounded");
  assert.equal(wctx.snippetTruncated, true);
  assert.equal(ctxShort.snippetTruncated, false, "control: a short element is not marked truncated");
  ok("CR-09 bound: a large element's snippet is cut to SNIPPET_MAX and marked truncated");

  // The student never picks: the wait ends with a reason, and inspect mode is switched off.
  const idle = makeFakePage();
  await assert.rejects(waitForPick(idle.cdp, 30), /요소를 고르지 않아/);
  assert.equal(idle.calls.at(-1).params.mode, "none");
  ok("a pick nobody makes ends with a reason and leaves inspect mode");
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── coverage of the pinned tab (recon R2) ──────────────────────────────────
{
  const tab = (label, isActive, inputIsUndefined = true, index = 0) => ({ index, label, isActive, inputIsUndefined });
  const title = "키오스크 연습 (http://127.0.0.1:5173/index.html)";
  const beside = [{ tabs: [tab("AI와 작업", true, false)] }, { tabs: [tab("키오스크 연습", true)] }];
  const full = [{ tabs: [tab("index.html", false, false), tab("키오스크 연습", true, true, 1)] }];
  assert.equal(browserTabCoverage(beside, title), "visible");
  assert.equal(browserTabCoverage(full, title), "visible");
  ok("coverage positive: the pinned tab is visible in both the beside and the full-width layout");
  const covered = [{ tabs: [tab("키오스크 연습", false), tab("index.html", true, false, 1)] }];
  assert.equal(browserTabCoverage(covered, title), "covered");
  const tie = [{ tabs: [tab("키오스크 연습", true)] }, { tabs: [tab("키오스크 연습", false)] }];
  assert.equal(browserTabCoverage(tie, title), "unknown");
  assert.equal(browserTabCoverage(beside, undefined), "unknown");
  ok("coverage negative: a covered tab is \"covered\" and a tie is \"unknown\" — the caller refuses both");
}

console.log(`\n${passed} element-pick checks passed`);
