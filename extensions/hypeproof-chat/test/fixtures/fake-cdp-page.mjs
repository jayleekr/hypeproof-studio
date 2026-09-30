// A scripted CDP page for the cr-browser smokes (CR-T04–T06, T08, T10, T11, T63).
//
// It speaks the subset of CDP the Experiment Browser uses, as a `CdpLike` (send +
// onEvent), and keeps a tiny DOM: a title, a route, and elements with backend node ids
// that change on every new document, the way Chromium's do. Everything a check reads
// comes from here, so each smoke can plant a defect by changing one field.
//
// Not a browser. The real-Chromium run is e2e/curriculum-runtime/experiment-browser.real.mjs.

export function makeFakePage(opts = {}) {
  const calls = [];
  const listeners = new Set();
  const state = {
    origin: opts.origin ?? "http://127.0.0.1:5173",
    route: opts.route ?? "/index.html",
    title: opts.title ?? "키오스크 연습",
    viewport: opts.viewport ?? { width: 800, height: 600 },
    loader: 0,
    ctx: 0,
    nodeBase: 100,
    scrollY: 0,
    dialog: null,
    screenshot: opts.screenshot ?? "SlBFR0RBVEE=", // "JPEGDATA"
    // Elements of the current document. `onClick` may plant console errors etc.
    elements: opts.elements ?? [
      { key: "order", role: "button", name: "주문하기", tag: "button", id: "order" },
      { key: "cancel", role: "button", name: "취소", tag: "button", id: "cancel" },
      { key: "help", role: "button", name: "도움말", tag: "button", id: "help" },
    ],
    dom: { hovered: null, clicked: [], selected: {}, scrolledTo: null },
    // Planted behaviour: what a document does when it loads (console lines, throws, 404s).
    onLoad: opts.onLoad ?? (() => {}),
    onClick: opts.onClick ?? (() => {}),
  };
  const loaderId = () => `L${state.loader}`;
  const nodeId = (key) => state.nodeBase + state.elements.findIndex((e) => e.key === key);
  const elementOf = (backendNodeId) => {
    const i = backendNodeId - state.nodeBase;
    return i >= 0 && i < state.elements.length ? state.elements[i] : null;
  };
  const emit = (method, params) => {
    for (const fn of [...listeners]) fn({ method, params });
  };
  const page = {
    calls,
    state,
    emit,
    nodeId,
    /** Page-side helpers a planted fixture calls. */
    consoleError(message, line = 12) {
      emit("Runtime.consoleAPICalled", {
        type: "error",
        args: [{ type: "string", value: message }],
        executionContextId: state.ctx,
        timestamp: Date.now(),
        stackTrace: { callFrames: [{ url: `${state.origin}${state.route}`, lineNumber: line - 1, columnNumber: 4 }] },
      });
    },
    consoleLog(message) {
      emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: message }], executionContextId: state.ctx, timestamp: Date.now() });
    },
    throwError(message) {
      emit("Runtime.exceptionThrown", {
        timestamp: Date.now(),
        exceptionDetails: { text: "Uncaught", exception: { description: `Error: ${message}\n    at x` }, executionContextId: state.ctx, url: `${state.origin}${state.route}`, lineNumber: 20, columnNumber: 2 },
      });
    },
    fetch404(path, requestId = `R${Math.random().toString(36).slice(2)}`) {
      emit("Network.requestWillBeSent", { requestId, loaderId: loaderId(), frameId: "F1", request: { url: `${state.origin}${path}` } });
      emit("Network.responseReceived", { requestId, response: { status: 404, statusText: "Not Found", url: `${state.origin}${path}` } });
      emit("Network.loadingFinished", { requestId });
    },
    /** A new document: new loader, new context, new node ids (a reload or navigation). */
    newDocument(route = state.route) {
      state.loader++;
      state.ctx++;
      state.nodeBase += 100;
      state.route = route;
      state.scrollY = 0;
      emit("Page.frameNavigated", { frame: { id: "F1", loaderId: loaderId(), url: `${state.origin}${route}` } });
      emit("Runtime.executionContextCreated", { context: { id: state.ctx, auxData: { frameId: "F1", isDefault: true } } });
      state.onLoad(page);
    },
    cdp: {
      onEvent(fn) {
        listeners.add(fn);
        return { dispose: () => listeners.delete(fn) };
      },
      async send(method, params = {}) {
        calls.push({ method, params });
        const fail = (m) => {
          throw new Error(m);
        };
        switch (method) {
          case "Page.enable":
          case "Network.enable":
          case "Log.enable":
          case "DOM.enable":
          case "CSS.enable":
          case "Overlay.enable":
          case "Overlay.highlightRect":
          case "Overlay.hideHighlight":
          case "Overlay.setInspectMode":
          case "Input.insertText":
          case "Input.dispatchKeyEvent":
            return {};
          case "Page.getFrameTree":
            return { frameTree: { frame: { id: "F1", loaderId: loaderId(), url: `${state.origin}${state.route}` } } };
          case "Runtime.enable":
            emit("Runtime.executionContextCreated", { context: { id: state.ctx, auxData: { frameId: "F1", isDefault: true } } });
            return {};
          case "Runtime.evaluate": {
            const e = String(params.expression);
            if (state.dialog && !/readyState/.test(e)) return new Promise(() => {}); // a dialog blocks evaluation
            if (e.includes("location.href") && e.includes("document.title"))
              return { result: { value: JSON.stringify({ h: `${state.origin}${state.route}`, t: state.title }) } };
            if (e === "location.href") return { result: { value: `${state.origin}${state.route}` } };
            if (e.includes("innerWidth")) return { result: { value: JSON.stringify({ w: state.viewport.width, h: state.viewport.height }) } };
            if (e.includes("document.readyState")) return { result: { value: "complete" } };
            if (e.includes("scrollBy")) {
              const dy = Number(/scrollBy\(0, (-?\d+)\)/.exec(e)?.[1] ?? 0);
              state.scrollY += dy;
              return { result: { value: state.scrollY } };
            }
            return { result: { value: null } };
          }
          case "Accessibility.getFullAXTree":
            return {
              nodes: [
                { role: { value: "heading" }, name: { value: state.title } },
                ...state.elements.map((el) => ({ role: { value: el.role }, name: { value: el.name }, backendDOMNodeId: nodeId(el.key) })),
                {
                  role: { value: "StaticText" },
                  name: { value: `상태 hover=${state.dom.hovered ?? "-"} select=${JSON.stringify(state.dom.selected)} scroll=${state.dom.scrolledTo ?? "-"} y=${state.scrollY} clicks=${state.dom.clicked.join(",") || "-"}` },
                },
              ],
            };
          case "Page.captureScreenshot":
            if (opts.screenshotFails) fail("CDP Page.captureScreenshot timed out");
            return { data: params.clip ? "UE5HQ1JPUA==" : state.screenshot };
          case "DOM.resolveNode": {
            const el = elementOf(params.backendNodeId);
            if (!el) fail("No node with given id found");
            return { object: { objectId: `obj-${params.backendNodeId}` } };
          }
          case "DOM.scrollIntoViewIfNeeded":
          case "DOM.getBoxModel": {
            const el = elementOf(params.backendNodeId);
            if (!el) fail("Could not compute box model.");
            if (method === "DOM.scrollIntoViewIfNeeded") return {};
            const i = state.elements.indexOf(el);
            const x = 10, y = 10 + i * 40, w = 100, h = 30;
            const quad = [x, y, x + w, y, x + w, y + h, x, y + h];
            return { model: { content: quad, border: quad } };
          }
          case "Page.getLayoutMetrics":
            return { cssLayoutViewport: { pageX: 0, pageY: state.scrollY, clientWidth: state.viewport.width, clientHeight: state.viewport.height } };
          case "Runtime.callFunctionOn": {
            const el = elementOf(Number(String(params.objectId).replace("obj-", "")));
            if (!el) fail("Cannot find context with specified id");
            const fn = String(params.functionDeclaration);
            if (fn.includes("SELECT")) {
              if (el.tag !== "select") return { result: { value: { ok: false, reason: "not_select" } } };
              const v = params.arguments?.[0]?.value;
              const hit = (el.options ?? []).find((o) => o.value === v || o.text === v);
              if (!hit) return { result: { value: { ok: false, reason: "no_option", options: (el.options ?? []).map((o) => o.value) } } };
              state.dom.selected[el.key] = hit.value;
              return { result: { value: { ok: true, value: hit.value } } };
            }
            if (fn.includes("scrollIntoView")) {
              state.dom.scrolledTo = el.key;
              return { result: { value: true } };
            }
            if (fn.includes("tagName")) return { result: { value: { tag: el.tag, id: el.id ?? "", text: el.name } } };
            return { result: { value: null } };
          }
          case "Input.dispatchMouseEvent": {
            const hit = state.elements.find((el, i) => params.y >= 10 + i * 40 && params.y <= 40 + i * 40 && params.x >= 10 && params.x <= 110);
            if (params.type === "mouseMoved" && hit) state.dom.hovered = hit.key;
            if (params.type === "mouseReleased" && hit && !hit.disabled) {
              state.dom.clicked.push(hit.key);
              state.onClick(page, hit.key);
            }
            return {};
          }
          case "Page.reload":
            setTimeout(() => page.newDocument(), 5);
            return {};
          case "Page.navigate": {
            const u = new URL(params.url);
            setTimeout(() => page.newDocument(u.pathname), 5);
            return { frameId: "F1", loaderId: `L${state.loader + 1}` };
          }
          case "Page.getNavigationHistory":
            return { currentIndex: 1, entries: [{ id: 1, url: opts.backUrl ?? `${state.origin}/prev.html` }, { id: 2, url: `${state.origin}${state.route}` }] };
          case "Page.navigateToHistoryEntry":
            setTimeout(() => page.newDocument("/prev.html"), 5);
            return {};
          case "Page.handleJavaScriptDialog":
            state.dialog = null;
            emit("Page.javascriptDialogClosed", {});
            return {};
          case "DOM.getOuterHTML": {
            const el = elementOf(params.backendNodeId);
            if (!el) fail("No node with given id found");
            return { outerHTML: `<${el.tag} id="${el.id}">${el.name}</${el.tag}>` };
          }
          case "DOM.getDocument":
            return { root: { nodeId: 1 } };
          case "DOM.pushNodesByBackendIdsToFrontend":
            return { nodeIds: [params.backendNodeIds[0] + 5000] };
          case "CSS.getComputedStyleForNode":
            return { computedStyle: [{ name: "display", value: "inline-block" }, { name: "background-color", value: "rgb(10, 20, 30)" }, { name: "font-family", value: "sans-serif" }] };
          default:
            fail(`fake page: unhandled ${method}`);
        }
      },
    },
  };
  return page;
}

/** A tab port over a fake page: the page is the driven tab. */
export function fakePort(page) {
  return {
    session: async () => page.cdp,
    tabUrl: () => `${page.state.origin}${page.state.route}`,
    navigate: async (url) => {
      await page.cdp.send("Page.navigate", { url });
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}

export const FAKE_VERSION = {
  id: `sha256:${"a".repeat(64)}`,
  entry: "index.html",
  files: [{ path: "index.html", sha256: "b".repeat(64), bytes: 10 }],
};
