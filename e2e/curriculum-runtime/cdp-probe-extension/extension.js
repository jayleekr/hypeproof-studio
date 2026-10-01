// Test-only development extension driven by ../cdp-probe.mjs (cr-recon, #1390).
//
// It answers one question with evidence instead of source reading: through the
// `browser` proposed API that hypeproof-chat already uses (window.openBrowserTab +
// BrowserTab.startCDPSession), can an extension observe console output, uncaught
// exceptions and failed requests of a page, tell documents apart across a reload,
// perform hover / scroll / select / reload, let a person pick an element, and read
// that element's DOM, computed style and crop? It also lists which upstream
// browserView agent tools the shipped app registers, and records what a pick does
// when another editor covers the browser tab.
//
// It is never bundled into Studio. The runner copies this folder into a temporary
// directory with a probe-config.json next to it and loads it with
// --extensionDevelopmentPath and --enable-proposed-api.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal flat-session CDP client over the proposed API channel that RECORDS events. */
class ProbeCdp {
  constructor(raw) {
    this.raw = raw;
    this.id = 0;
    this.sessionId = undefined;
    this.events = [];
    this.waiters = [];
    this.sub = raw.onDidReceiveMessage((m) => {
      if (!m || typeof m !== "object") return;
      if (typeof m.id === "number") return; // responses are matched in send()
      if (typeof m.method !== "string") return;
      const ev = { method: m.method, params: m.params, sessionId: m.sessionId, at: Date.now() };
      this.events.push(ev);
      this.waiters = this.waiters.filter((w) => {
        if (w.match(ev)) { w.resolve(ev); return false; }
        return true;
      });
    });
  }
  request(method, params = {}, sessionId, timeoutMs = 10000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { sub.dispose(); reject(new Error(`timeout ${method}`)); }, timeoutMs);
      const sub = this.raw.onDidReceiveMessage((m) => {
        if (!m || m.id !== id) return;
        clearTimeout(timer); sub.dispose();
        if (m.error) reject(new Error(m.error.message || `${method} failed`));
        else resolve(m.result);
      });
      void this.raw.sendMessage(sessionId ? { id, method, params, sessionId } : { id, method, params });
    });
  }
  send(method, params = {}, timeoutMs) { return this.request(method, params, this.sessionId, timeoutMs); }
  waitFor(match, timeoutMs = 5000) {
    const hit = this.events.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error("event timeout")); }, timeoutMs);
    });
  }
  async attach() {
    await this.request("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const t = await this.request("Target.getTargets", {});
    const page = (t && t.targetInfos || []).find((x) => x.type === "page");
    if (!page) throw new Error("no page target");
    const a = await this.request("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    this.sessionId = a.sessionId;
  }
}

/**
 * Attribute buffered page events to the document (main-frame loaderId) that produced them.
 * Console and exception events carry an executionContextId; Runtime.executionContextCreated
 * ties that context to a frame, and the loaderId current when the context was created names
 * the document. Network events carry the loaderId of the document that issued them.
 */
function recordsByDocument(events, sessionId) {
  const mine = events.filter((e) => e.sessionId === sessionId);
  let mainFrame;
  let loader;
  const ctxLoader = new Map();
  const reqLoader = new Map();
  const reqUrl = new Map();
  const out = [];
  for (const e of mine) {
    const p = e.params || {};
    // Probe.initialDocument is the frame tree read at attach time: Runtime.enable replays the
    // current document's earlier console messages, which precede any Page.frameNavigated.
    if ((e.method === "Page.frameNavigated" || e.method === "Probe.initialDocument") && !p.frame.parentId) { mainFrame = p.frame.id; loader = p.frame.loaderId; }
    if (e.method === "Runtime.executionContextCreated") {
      const aux = p.context && p.context.auxData || {};
      if (aux.isDefault && (!mainFrame || aux.frameId === mainFrame)) ctxLoader.set(p.context.id, loader);
    }
    if (e.method === "Network.requestWillBeSent") { reqLoader.set(p.requestId, p.loaderId); reqUrl.set(p.requestId, p.request && p.request.url); }
    if (e.method === "Runtime.consoleAPICalled") {
      out.push({ kind: "console", level: p.type, text: (p.args || []).map((a) => a.value ?? a.description ?? "").join(" "),
        url: p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0] ? p.stackTrace.callFrames[0].url : null,
        line: p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0] ? p.stackTrace.callFrames[0].lineNumber : null,
        document: ctxLoader.get(p.executionContextId) ?? null, at: p.timestamp });
    }
    if (e.method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails || {};
      out.push({ kind: "exception", level: "error", text: d.exception && d.exception.description ? String(d.exception.description).split("\n")[0] : d.text,
        url: d.url ?? null, line: d.lineNumber ?? null, document: ctxLoader.get(d.executionContextId) ?? null, at: p.timestamp });
    }
    if (e.method === "Network.responseReceived" && p.response && p.response.status >= 400) {
      out.push({ kind: "http_error", level: "error", text: `${p.response.status} ${p.response.url}`, url: p.response.url, line: null,
        document: p.loaderId ?? reqLoader.get(p.requestId) ?? null, at: p.timestamp });
    }
    // A canceled load (net::ERR_ABORTED when a reload or navigation drops in-flight
    // requests) is the browser's bookkeeping, not a failure of the product.
    if (e.method === "Network.loadingFailed" && !p.canceled) {
      out.push({ kind: "loading_failed", level: "error", text: `${p.errorText} ${reqUrl.get(p.requestId) || ""}`.trim(), url: reqUrl.get(p.requestId) || null,
        line: null, document: reqLoader.get(p.requestId) ?? null, at: p.timestamp, canceled: !!p.canceled });
    }
  }
  return { records: out, currentDocument: loader ?? null };
}

async function evalValue(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  return r && r.result ? r.result.value : undefined;
}

async function waitComplete(cdp, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await evalValue(cdp, "document.readyState").catch(() => null);
    if (s === "complete") return true;
    if (Date.now() > until) return false;
    await sleep(150);
  }
}

async function nodeByAx(cdp, role, name) {
  const ax = await cdp.send("Accessibility.getFullAXTree", {});
  const hit = (ax.nodes || []).find((n) => !n.ignored && n.role && n.role.value === role && (!name || (n.name && n.name.value === name)));
  return hit ? hit.backendDOMNodeId : undefined;
}

function center(quad) {
  return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
}

async function run(cfg) {
  const result = { started_at: new Date().toISOString(), vscode_version: vscode.version, steps: {} };
  const step = async (name, fn) => {
    const t0 = Date.now();
    try { result.steps[name] = { ok: true, ms: 0, ...(await fn()) }; }
    catch (err) { result.steps[name] = { ok: false, error: String(err && err.message || err) }; }
    result.steps[name].ms = Date.now() - t0;
  };

  // A. Which upstream browserView agent tools does the shipped app register?
  await step("upstream_lm_tools", async () => {
    const names = (vscode.lm && vscode.lm.tools || []).map((t) => t.name);
    const browser = names.filter((n) => /browser|Browser|playwright|Playwright/.test(n));
    return { total: names.length, browser_tools: browser };
  });

  // B. Open the planted page through the same API hypeproof-chat uses, attach, enable domains.
  // The layout is controlled, not inherited: whatever editors the installed hypeproof-chat opens
  // at startup (both the stock 0.1.51 and the origin/main build open a "HypeProof Studio" editor)
  // must have opened BEFORE the browser tab, or one of them lands on top of it and the tab is
  // covered. A tab covered right after opening loses the first inspect-mode click (recon R2), so
  // wait until the editor set has been stable for 2 s (at most 15 s) and only then open the tab.
  const groupsNow = () => vscode.window.tabGroups.all.map((g) => ({ col: g.viewColumn, tabs: g.tabs.map((x) => `${x.label}${x.isActive ? "*" : ""}`) }));
  const settleStart = Date.now();
  let seen = JSON.stringify(groupsNow());
  let stableSince = Date.now();
  while (Date.now() - settleStart < 15000 && Date.now() - stableSince < 2000) {
    await sleep(250);
    const now = JSON.stringify(groupsNow());
    if (now !== seen) { seen = now; stableSince = Date.now(); }
  }
  const layout = cfg.layout === "full" ? "full" : "beside";
  const tab = await vscode.window.openBrowserTab(cfg.plantedUrl, {
    // beside: next to the active editor, as hypeproof-chat opens its preview. full: in the active
    // group, so the browser tab is that group's active tab at the window's full editor width.
    viewColumn: layout === "full" ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside,
    preserveFocus: true,
  });
  await sleep(500);
  result.layout = { mode: layout, settled_ms: Date.now() - settleStart, groups_at_open: groupsNow() };
  // The editor tab is found by the planted page's <title>, which the probe controls: the tab label
  // is the page title, while BrowserTab.title reads "<title> (<url>)" (recorded at the pick).
  const isBrowserTab = (x) => x.label === cfg.plantedTitle;
  /** Is the browser tab the active (visible) tab of its editor group? Page visibility cannot tell. */
  const browserTabVisible = () => vscode.window.tabGroups.all.some((g) => g.activeTab && isBrowserTab(g.activeTab));
  /** Opens a workspace text file in the browser tab's group, on top of the browser tab. */
  const coverBrowserTab = async () => {
    const group = vscode.window.tabGroups.all.find((g) => g.tabs.some(isBrowserTab));
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!group || !folder) return false;
    const cover = path.join(folder.uri.fsPath, "cover.txt");
    fs.writeFileSync(cover, "covers the browser tab\n");
    await vscode.window.showTextDocument(vscode.Uri.file(cover), { viewColumn: group.viewColumn, preserveFocus: true, preview: false });
    await sleep(500);
    return true;
  };
  const cdp = new ProbeCdp(await tab.startCDPSession());
  await step("attach", async () => { await cdp.attach(); return { flat_session: !!cdp.sessionId }; });
  await step("enable_domains", async () => {
    await cdp.send("Page.enable", {});
    const tree = await cdp.send("Page.getFrameTree", {});
    cdp.events.unshift({ method: "Probe.initialDocument", params: { frame: tree.frameTree.frame }, sessionId: cdp.sessionId, at: Date.now() });
    for (const d of ["Runtime.enable", "Network.enable", "Log.enable", "DOM.enable", "CSS.enable", "Overlay.enable"]) await cdp.send(d, {});
    return { enabled: 7, initial_document: tree.frameTree.frame.loaderId };
  });

  // C. Console / exception / failed request capture, per document, across a reload.
  await step("capture_planted_reload", async () => {
    await cdp.send("Page.reload", {});
    await waitComplete(cdp);
    await sleep(1500); // setTimeout throw + both fetches settle
    const gen1 = recordsByDocument(cdp.events, cdp.sessionId);
    await cdp.send("Page.reload", {});
    await waitComplete(cdp);
    await sleep(1500);
    const gen2 = recordsByDocument(cdp.events, cdp.sessionId);
    const of = (recs, doc) => recs.filter((r) => r.document === doc);
    const summarise = (recs) => ({
      console_error: recs.filter((r) => r.kind === "console" && r.level === "error").length,
      console_log: recs.filter((r) => r.kind === "console" && r.level === "log").length,
      exception: recs.filter((r) => r.kind === "exception").length,
      http_error: recs.filter((r) => r.kind === "http_error").length,
      loading_failed: recs.filter((r) => r.kind === "loading_failed").length,
    });
    return {
      first_document: gen1.currentDocument,
      second_document: gen2.currentDocument,
      distinct_documents: gen1.currentDocument !== gen2.currentDocument,
      first: summarise(of(gen2.records, gen1.currentDocument)),
      second: summarise(of(gen2.records, gen2.currentDocument)),
      unattributed: gen2.records.filter((r) => !r.document).length,
      unattributed_sample: gen2.records.filter((r) => !r.document).slice(0, 5),
      replayed_from_initial_document: summarise(of(gen2.records, result.steps.enable_domains && result.steps.enable_domains.initial_document)),
      sample: of(gen2.records, gen2.currentDocument).slice(0, 8),
    };
  });

  // D. Clean page: the same instrument must report zero error records for its document.
  await step("capture_clean", async () => {
    await cdp.send("Page.navigate", { url: cfg.cleanUrl });
    await waitComplete(cdp);
    await sleep(1200);
    const g = recordsByDocument(cdp.events, cdp.sessionId);
    const recs = g.records.filter((r) => r.document === g.currentDocument);
    return { document: g.currentDocument, error_records: recs.filter((r) => r.level === "error").length, all_records: recs.length };
  });

  // Back to the planted page for the action probes.
  await cdp.send("Page.navigate", { url: cfg.plantedUrl });
  await waitComplete(cdp);
  await sleep(500);

  await step("viewport", async () => {
    const v = JSON.parse(await evalValue(cdp, "JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})"));
    const lm = await cdp.send("Page.getLayoutMetrics", {});
    let emulation = "not_tried";
    try {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await sleep(300);
      const e = JSON.parse(await evalValue(cdp, "JSON.stringify({w:innerWidth,h:innerHeight})"));
      emulation = e.w === 390 ? "applied" : `ignored (innerWidth ${e.w})`;
      await cdp.send("Emulation.clearDeviceMetricsOverride", {});
    } catch (err) { emulation = `error: ${err.message}`; }
    return { inner: v, css_visual_viewport: lm.cssVisualViewport ? { w: lm.cssVisualViewport.clientWidth, h: lm.cssVisualViewport.clientHeight } : null, emulation_390: emulation };
  });

  await step("hover", async () => {
    const id = await nodeByAx(cdp, "button", "주문하기");
    const box = await cdp.send("DOM.getBoxModel", { backendNodeId: id });
    const c = center(box.model.content);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
    await sleep(150);
    return { hovered: await evalValue(cdp, "document.body.dataset.hovered || null") };
  });

  await step("scroll", async () => {
    const before = await evalValue(cdp, "scrollY");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: 600 });
    await sleep(400);
    const after = await evalValue(cdp, "scrollY");
    // The DOM-level alternative, which needs no composited frame.
    await evalValue(cdp, "scrollTo(0,0)");
    await evalValue(cdp, "document.getElementById('opt').scrollIntoView({block:'start'}), scrollBy(0,300)");
    return { before, after, dom_scroll_after: await evalValue(cdp, "scrollY") };
  });

  await step("select", async () => {
    await evalValue(cdp, "scrollTo(0,0)");
    const id = await nodeByAx(cdp, "combobox", "옵션");
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: id });
    await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function(v){this.value=v;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return this.value;}",
      arguments: [{ value: "b" }], returnByValue: true,
    });
    return { selected: await evalValue(cdp, "document.body.dataset.selected || null") };
  });

  await step("reload_and_stale_ref", async () => {
    const id = await nodeByAx(cdp, "button", "주문하기");
    const before = await evalValue(cdp, "performance.timeOrigin");
    await cdp.send("Page.reload", {});
    await waitComplete(cdp);
    const after = await evalValue(cdp, "performance.timeOrigin");
    let staleBoxModel;
    try { await cdp.send("DOM.getBoxModel", { backendNodeId: id }); staleBoxModel = "resolved"; }
    catch (err) { staleBoxModel = `refused: ${err.message}`; }
    return { new_document: after > before, stale_backend_node: staleBoxModel };
  });

  // E. Element pick: inspect mode + a synthetic click stands in for the student's click. A
  // student can only click a tab they see, so the precondition is recorded with the result.
  await step("element_pick", async () => {
    await sleep(300);
    // Negative control for the precondition check (HPS_CR_PROBE_NEGATIVE=covered).
    if (cfg.coverBeforePick) await coverBrowserTab();
    // Recorded outside the step result so it survives a failed pick.
    result.pick_precondition = { tab_visible: browserTabVisible(), groups: groupsNow(), browser_tab_title_api: tab.title };
    const id = await nodeByAx(cdp, "button", "주문하기");
    const box = await cdp.send("DOM.getBoxModel", { backendNodeId: id });
    const c = center(box.model.content);
    await cdp.send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.66 } } });
    const picked = cdp.waitFor((e) => e.method === "Overlay.inspectNodeRequested" && e.sessionId === cdp.sessionId, 5000);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
    const ev = await picked;
    const t0 = Date.now();
    await cdp.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
    const backendNodeId = ev.params.backendNodeId;
    const { outerHTML } = await cdp.send("DOM.getOuterHTML", { backendNodeId });
    await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeIds } = await cdp.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backendNodeId] });
    const { computedStyle } = await cdp.send("CSS.getComputedStyleForNode", { nodeId: nodeIds[0] });
    const keep = ["color", "background-color", "font-size", "display", "visibility", "opacity", "pointer-events", "cursor"];
    const style = Object.fromEntries((computedStyle || []).filter((p) => keep.includes(p.name)).map((p) => [p.name, p.value]));
    const bm = await cdp.send("DOM.getBoxModel", { backendNodeId });
    const q = bm.model.border;
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    const clip = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), scale: 1 };
    // The crop needs a composited frame; null (not a failure of the pick) when none comes.
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip }, 3000).catch(() => null);
    const localMs = Date.now() - t0;
    const clicked = await evalValue(cdp, "document.body.dataset.clicked || null");
    return {
      same_node_as_ax_ref: backendNodeId === id,
      outer_html: String(outerHTML).slice(0, 200),
      style,
      crop_bytes: shot ? Buffer.from(String(shot.data || ""), "base64").length : null,
      local_processing_ms: localMs,
      page_click_handler_ran: clicked,
    };
  });

  // F. Candidate automation indicator (CR-68): an inspector overlay outline around the
  // viewport. It must not enter the page's DOM / AX tree (the verdicts read those).
  await step("overlay_indicator", async () => {
    // Screenshots need a composited frame (none while the screen is locked), so they are
    // taken with a short timeout and reported as null instead of failing the DOM/AX part.
    const shot = () => cdp.send("Page.captureScreenshot", { format: "png" }, 3000).then((r) => r.data).catch(() => null);
    const axBefore = (await cdp.send("Accessibility.getFullAXTree", {})).nodes.length;
    const domBefore = await evalValue(cdp, "document.querySelectorAll('*').length");
    const shotBefore = await shot();
    const v = JSON.parse(await evalValue(cdp, "JSON.stringify({w:innerWidth,h:innerHeight})"));
    await cdp.send("Overlay.highlightRect", { x: 0, y: 0, width: v.w, height: v.h, color: { r: 0, g: 0, b: 0, a: 0 }, outlineColor: { r: 255, g: 64, b: 0, a: 1 } });
    await sleep(200);
    const shotDuring = await shot();
    const axDuring = (await cdp.send("Accessibility.getFullAXTree", {})).nodes.length;
    const domDuring = await evalValue(cdp, "document.querySelectorAll('*').length");
    await cdp.send("Overlay.hideHighlight", {});
    return { ax_unchanged: axBefore === axDuring, dom_unchanged: domBefore === domDuring,
      screenshot_changed: shotBefore && shotDuring ? shotBefore !== shotDuring : null };
  });

  // G. Characterisation, not an expectation (last, because it covers the tab): the same pick on
  // a tab the student cannot see. Two cases; what they did on 2026-09-29 is in recon R2 and §8:
  //   covered_after_shown  the tab was visible, then another editor covered it;
  //   never_shown          a second tab opened with `background: true` and never shown.
  // document.visibilityState is recorded because it does not tell a covered tab apart.
  const pickTwice = async (c2, box) => {
    const attempt = async () => {
      const t0 = Date.now();
      await c2.send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: { showInfo: true } });
      const picked = c2.waitFor((e) => e.method === "Overlay.inspectNodeRequested" && e.sessionId === c2.sessionId && e.at >= t0, 3000).then(() => true, () => false);
      await c2.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await c2.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await c2.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      const ok = await picked;
      await c2.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
      return ok;
    };
    return { page_visibility: await evalValue(c2, "document.visibilityState"), first_click_picked: await attempt(), second_click_picked: await attempt() };
  };
  await step("pick_on_covered_tab", async () => {
    if (browserTabVisible() && !(await coverBrowserTab())) return { skipped: "no group or workspace folder" };
    const tabVisible = browserTabVisible();
    const id = await nodeByAx(cdp, "button", "주문하기");
    const box = center((await cdp.send("DOM.getBoxModel", { backendNodeId: id })).model.content);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, 3000).then(() => true, () => false);
    const covered = { tab_visible: tabVisible, screenshot: shot, ...(await pickTwice(cdp, box)) };
    let neverShown;
    try {
      const group = vscode.window.tabGroups.all.find((g) => g.tabs.some(isBrowserTab));
      const bg = await vscode.window.openBrowserTab(cfg.plantedUrl, { viewColumn: group ? group.viewColumn : vscode.ViewColumn.Active, background: true, preserveFocus: true });
      const bcdp = new ProbeCdp(await bg.startCDPSession());
      await bcdp.attach();
      for (const d of ["Page.enable", "Runtime.enable", "DOM.enable", "Overlay.enable"]) await bcdp.send(d, {});
      await waitComplete(bcdp);
      await sleep(500);
      const bid = await nodeByAx(bcdp, "button", "주문하기");
      const bbox = center((await bcdp.send("DOM.getBoxModel", { backendNodeId: bid })).model.content);
      neverShown = await pickTwice(bcdp, bbox);
      await bg.close();
    } catch (err) { neverShown = { error: String(err && err.message || err) }; }
    return { covered_after_shown: covered, never_shown: neverShown };
  });

  result.finished_at = new Date().toISOString();
  try { await cdp.request("Target.detachFromTarget", { sessionId: cdp.sessionId }); } catch { /* best effort */ }
  return result;
}

function activate(context) {
  const cfgPath = path.join(context.extensionPath, "probe-config.json");
  if (!fs.existsSync(cfgPath)) return;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  void (async () => {
    let out;
    try { out = await run(cfg); }
    catch (err) { out = { fatal: String(err && err.stack || err) }; }
    fs.writeFileSync(cfg.out + ".tmp", JSON.stringify(out, null, 2));
    fs.renameSync(cfg.out + ".tmp", cfg.out);
  })();
}

module.exports = { activate, deactivate() {} };
