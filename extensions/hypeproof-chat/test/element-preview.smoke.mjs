// CR-09 / CR-T09 UI half (cr-browser #1391): the student sees what will be sent and can
// remove it. Renders the real ChatPanel (test/sx-render.mjs). Static render cannot click;
// the removal path (webview → `removeElementContext` → host clears the queued element) is
// locked by test/cr-switch.smoke.mjs and exercised in the app run.
//
// Run: node --experimental-strip-types test/element-preview.smoke.mjs

import assert from "node:assert/strict";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";

const status = rendererStatus();
if (!status.available) {
  console.log(`ok element preview SKIP — ${status.detail}`);
  process.exit(0);
}
const { chatPanelProps } = await import("./sx-screen-fixtures.mjs");
const { elementContextText } = await import("../src/elementPick.ts");

const ctx = {
  ref: "e2", backendNodeId: 7, tag: "button", text: "주문 시작", snippet: `<button id="begin" type="button">주문 시작</button>`, snippetTruncated: false,
  style: { "background-color": "rgb(10, 20, 30)" }, crop: { mimeType: "image/png", data: "UE5H", clip: { x: 1, y: 2, width: 100, height: 40 } },
  source: { file: "index.html", line: 21 }, url: "http://127.0.0.1:5173/index.html", route: "/index.html", documentGeneration: "L1",
  artifact: { id: `sha256:${"a".repeat(64)}`, entry: "index.html", files: [] }, captureMs: 20,
};
const sentText = elementContextText(ctx);
const preview = { ref: "e2", tag: "button", text: "주문 시작", source: "index.html:21", sentText, imageDataUrl: "data:image/png;base64,UE5H" };

const html = await renderComponent("ChatPanel", { ...chatPanelProps(), elementPreview: preview, onRemoveElement: () => {} });
const text = visibleText(html);
assert.match(html, /data-testid="element-context"/);
assert.match(text, /함께 보낼 요소/);
assert.match(text, /<button> “주문 시작” · e2/);
assert.match(text, /소스 위치: index.html:21/);
assert.match(html, /<img[^>]*class="hps-element-crop"[^>]*src="data:image\/png;base64,UE5H"/, "the crop that goes is shown");
assert.match(html, /aria-label="이 요소 빼기"/, "a remove control is on the chip");
// What is shown IS what is sent: the exact text block the coach receives.
const shown = /<pre data-testid="element-context-sent">([\s\S]*?)<\/pre>/.exec(html)[1]
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
assert.equal(shown, sentText);
console.log("✓ CR-T09 UI positive: the chip shows the element, its source, the crop and the exact text that will be sent, with a remove control");

const noImage = visibleText(await renderComponent("ChatPanel", { ...chatPanelProps(), elementPreview: { ...preview, imageDataUrl: null, source: "unmapped" } }));
assert.match(noImage, /소스 위치: 찾지 못함 · 이미지는 보내지 않아요/);
console.log("✓ CR-T09 UI: an unmapped element says so, and a cohort without images is told none goes");

const none = await renderComponent("ChatPanel", chatPanelProps());
assert.doesNotMatch(none, /element-context/, "no chip when nothing is queued (and never with the switch off)");
console.log("✓ CR-T09 UI negative: nothing queued, nothing shown");
