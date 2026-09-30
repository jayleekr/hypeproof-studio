// CR-T03 (cr-browser #1391): the browser-tool modules import no provider SDK and exchange
// plain data, and the same tool calls give identical results through the SDK coach's
// adapter (`toMcpToolResult`) and the proxy coach's (`toProxyToolResult`).
// cr-verify adds its runner module to BROWSER_TOOL_MODULES and re-runs this.
//
// Run: node --experimental-strip-types test/cr-provider-neutral.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFakePage, fakePort, FAKE_VERSION } from "./fixtures/fake-cdp-page.mjs";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
/** The browser-tool modules (CR-03). The verify runner joins in cr-verify. */
export const BROWSER_TOOL_MODULES = [
  "browserControl.ts",
  "browserControlHelpers.ts",
  "cdpSession.ts",
  "experimentBrowser.ts",
  "elementPick.ts",
  "artifactVersion.ts",
  "browserResult.ts",
  "browserMcp.ts",
  "crHostWiring.ts",
];
const PROVIDER_SDK = /^(?:@anthropic-ai\/|openai(?:\/|$)|@google\/(?:genai|generative-ai)|@ai-sdk\/|ai$|@mistralai\/|cohere-ai|groq-sdk|zhipuai)/;
const IMPORT_RE = /(?:^|[\s;])(?:import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g;

/** Provider SDK specifiers `source` imports, directly. */
export function providerImports(source) {
  const hits = [];
  IMPORT_RE.lastIndex = 0;
  for (let m = IMPORT_RE.exec(source); m; m = IMPORT_RE.exec(source)) if (PROVIDER_SDK.test(m[1])) hits.push(m[1]);
  return hits;
}

/** The modules and every relative module they reach, with their provider imports. */
function scan(entries) {
  const seen = new Map();
  const queue = entries.map((f) => resolve(src, f));
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const text = readFileSync(file, "utf8");
    seen.set(file, providerImports(text));
    IMPORT_RE.lastIndex = 0;
    for (let m = IMPORT_RE.exec(text); m; m = IMPORT_RE.exec(text)) {
      if (!m[1].startsWith(".")) continue;
      const base = resolve(dirname(file), m[1]);
      const next = [base, `${base}.ts`].find((p) => existsSync(p) && /\.ts$/.test(p));
      if (next) queue.push(next);
    }
  }
  return seen;
}

let passed = 0;
const ok = (name) => { passed++; console.log(`✓ ${name}`); };

// ── imports ─────────────────────────────────────────────────────────────────
const graph = scan(BROWSER_TOOL_MODULES);
const offenders = [...graph].filter(([, hits]) => hits.length).map(([f, hits]) => `${f}: ${hits.join(", ")}`);
assert.deepEqual(offenders, [], "no browser-tool module (or anything it reaches) imports a provider SDK");
assert.ok(graph.size >= BROWSER_TOOL_MODULES.length, "the scan walked the modules");
ok(`CR-T03 positive: ${graph.size} modules in the browser-tool graph import no provider SDK`);

// Negative control: a planted SDK import in the runner module is reported (and so is a
// require, a dynamic import and a type-only import — the instrument must see each form).
const runner = readFileSync(resolve(src, "experimentBrowser.ts"), "utf8");
for (const planted of [
  `import Anthropic from "@anthropic-ai/sdk";`,
  `import type { Message } from "@anthropic-ai/sdk/resources";`,
  `const OpenAI = require("openai");`,
  `const g = await import("@google/genai");`,
]) {
  assert.ok(providerImports(`${planted}\n${runner}`).length === 1, `planted: ${planted}`);
}
assert.deepEqual(providerImports(runner), [], "and the unplanted module is clean");
ok("CR-T03 negative: a planted provider import (import / type / require / dynamic) in the runner module is reported");

// ── plain data, both coach adapters ─────────────────────────────────────────
const { CrExecutor } = await import("../src/experimentBrowser.ts");
const { toMcpToolResult } = await import("../src/browserMcp.ts");
const { toProxyToolResult } = await import("../src/browserControlHelpers.ts");

const SCRIPT = [
  ["browser_observe", {}],
  ["browser_click", { ref: "e1" }],
  ["browser_hover", { ref: "e2" }],
  ["browser_scroll", { ref: "e3" }],
  ["browser_reload", {}],
];
async function run(adapter) {
  const page = makeFakePage();
  const ex = new CrExecutor(fakePort(page), {
    allowedOrigins: () => ["http://127.0.0.1:5173"],
    artifactVersion: async () => FAKE_VERSION,
    settleMs: 0,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
  const out = [];
  for (const [i, [name, input]] of SCRIPT.entries()) {
    const r = await ex.execute(name, input);
    // Plain data: survives a JSON round trip unchanged (no classes, functions or SDK objects).
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r, `${name} result is plain data`);
    out.push(adapter(`call-${i}`, r));
  }
  return out;
}
// Normalise each runtime's wire shape to the blocks the model reads.
const fromMcp = (_id, r) => {
  const m = toMcpToolResult(r);
  return { error: m.isError === true, blocks: m.content.map((b) => (b.type === "text" ? ["text", b.text] : ["image", b.mimeType, b.data])) };
};
const fromProxy = (id, r) => {
  const t = toProxyToolResult(id, r);
  assert.equal(t.tool_use_id, id);
  return {
    error: t.is_error === true,
    blocks: t.content.map((b) => (b.type === "text" ? ["text", b.text] : ["image", /^data:([^;,]+)/.exec(b.image_url.url)[1], b.image_url.url.replace(/^data:[^,]*,/, "")])),
  };
};
const viaSdk = await run(fromMcp);
const viaProxy = await run(fromProxy);
assert.deepEqual(viaSdk, viaProxy, "the five calls give identical results through both adapters");
assert.ok(viaSdk.every((r) => !r.error && r.blocks.some((b) => b[0] === "image")), "and each one carries its observation");
ok("CR-T03 positive: the same five-call script gives identical tool results through the SDK and proxy adapters");

// Negative control for the parity instrument: an adapter that drops the image is caught.
const lossy = (id, r) => { const x = fromProxy(id, r); return { ...x, blocks: x.blocks.filter((b) => b[0] !== "image") }; };
assert.notDeepEqual(await run(lossy), viaSdk);
ok("CR-T03 negative: an adapter that changes a result is caught by the parity check");

// ── CR-11 parity: both runtimes refuse an external origin, with the same reason ──
{
  const { checkAgentOrigin } = await import("../src/experimentBrowser.ts");
  const { buildHypeproofMcpServer } = await import("../src/browserMcp.ts");
  const ORIGIN = "http://127.0.0.1:5173";
  const page = makeFakePage();
  const ex = new CrExecutor(fakePort(page), { allowedOrigins: () => [ORIGIN], artifactVersion: async () => FAKE_VERSION, settleMs: 0, sleep: async () => {} });
  const proxy = fromProxy("p", await ex.execute("browser_navigate", { url: "https://example.com/" }));
  const tools = new Map();
  const opened = [];
  buildHypeproofMcpServer(
    { tool: (name, _d, _s, fn) => (tools.set(name, fn), name), createSdkMcpServer: (o) => o },
    { string: () => "s", boolean: () => "b", number: () => "n" },
    {
      openBrowser: async (url) => { opened.push(url); },
      screenshot: async () => null,
      startLivePreview: async () => null,
      livePreviewUrl: async () => `${ORIGIN}/`,
      crEnabled: () => true,
      crScope: (url) => checkAgentOrigin(url, [ORIGIN]),
    },
    { curriculumRuntime: true },
  );
  const sdk = fromMcp("s", await tools.get("browser_open")({ url: "https://example.com/" }));
  assert.equal(proxy.error, true);
  assert.equal(sdk.error, true);
  assert.deepEqual(sdk.blocks, proxy.blocks, "the same refusal text through both runtimes");
  assert.deepEqual(opened, [], "the SDK host opened nothing");
  ok("CR-T03/CR-T11 parity: an external origin is refused by both runtimes with the same reason");
}

console.log(`\n${passed} provider-neutral checks passed`);
