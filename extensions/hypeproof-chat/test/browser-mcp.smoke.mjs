// Smoke tests for the in-process "hypeproof" browser MCP server builder
// (#282 P2 slice 2, REQ-M19/M20). Pure — no vscode, no SDK: the factory
// (createSdkMcpServer/tool), zod, and the host capabilities are all injected
// fakes, so we can lock the tool wiring + handler safety contract offline.
// Run: node --experimental-strip-types test/browser-mcp.smoke.mjs

import assert from "node:assert/strict";

const {
  buildHypeproofMcpServer,
  HYPEPROOF_MCP_SERVER_NAME,
  MCP_BROWSER_OPEN,
  MCP_BROWSER_SCREENSHOT,
  MCP_LIVE_PREVIEW_START,
  MCP_BROWSER_TOOLS,
} = await import("../src/browserMcp.ts");

// ─── constants — names the model/canUseTool sees must never drift ────────────
{
  assert.equal(HYPEPROOF_MCP_SERVER_NAME, "hypeproof");
  assert.deepEqual(
    [...MCP_BROWSER_TOOLS],
    ["mcp__hypeproof__browser_open", "mcp__hypeproof__browser_screenshot", "mcp__hypeproof__live_preview_start"],
    "full MCP tool names = mcp__<server>__<tool> — the canUseTool contract",
  );
  // The full names must be derivable from the server name + short names the
  // factory registers (a rename in one place must break this test).
  assert.equal(MCP_BROWSER_OPEN, `mcp__${HYPEPROOF_MCP_SERVER_NAME}__browser_open`);
  assert.equal(MCP_BROWSER_SCREENSHOT, `mcp__${HYPEPROOF_MCP_SERVER_NAME}__browser_screenshot`);
  assert.equal(MCP_LIVE_PREVIEW_START, `mcp__${HYPEPROOF_MCP_SERVER_NAME}__live_preview_start`);
}

// Fakes: capture what the builder registers; the fake zod marks schemas.
function makeFactory() {
  const registered = [];
  let serverOpts = null;
  return {
    factory: {
      tool: (name, description, inputSchema, handler) => {
        const def = { name, description, inputSchema, handler };
        registered.push(def);
        return def;
      },
      createSdkMcpServer: (opts) => {
        serverOpts = opts;
        return { __server: true, opts };
      },
    },
    registered,
    getServerOpts: () => serverOpts,
  };
}
const fakeZ = { string: () => ({ __zod: "string" }) };

// ─── builder wiring — 3 tools on the "hypeproof" server, exact short names ──
{
  const { factory, registered, getServerOpts } = makeFactory();
  const host = {
    openBrowser: async () => {},
    screenshot: async () => null,
    startLivePreview: async () => null,
  };
  const server = buildHypeproofMcpServer(factory, fakeZ, host);
  assert.ok(server && server.__server, "returns the created server instance");
  const opts = getServerOpts();
  assert.equal(opts.name, HYPEPROOF_MCP_SERVER_NAME, "server registered under 'hypeproof'");
  assert.deepEqual(
    registered.map((t) => t.name),
    ["browser_open", "browser_screenshot", "live_preview_start"],
    "short tool names (SDK prefixes mcp__hypeproof__ itself)",
  );
  assert.equal(opts.tools.length, 3, "all three tools attached to the server");
  // browser_open takes a url string; the parameterless tools take {}.
  const open = registered.find((t) => t.name === "browser_open");
  assert.deepEqual(open.inputSchema, { url: { __zod: "string" } });
  assert.deepEqual(registered.find((t) => t.name === "browser_screenshot").inputSchema, {});
  assert.deepEqual(registered.find((t) => t.name === "live_preview_start").inputSchema, {});
  // Korean descriptions — the model reads these; they must mention the gate.
  assert.ok(open.description.includes("승인"), "browser_open description declares the approval gate");
}

// ─── browser_open handler — URL policy re-validated (belt over suspenders) ──
{
  const { factory, registered } = makeFactory();
  const opened = [];
  buildHypeproofMcpServer(factory, fakeZ, {
    openBrowser: async (url) => { opened.push(url); },
    screenshot: async () => null,
    startLivePreview: async () => null,
  });
  const open = registered.find((t) => t.name === "browser_open");

  // Policy-clean URL → host called with the NORMALIZED URL.
  const ok = await open.handler({ url: "localhost:5173" }, {});
  assert.deepEqual(opened, ["http://localhost:5173"], "bare localhost normalized to http://");
  assert.equal(ok.isError, undefined);
  assert.ok(ok.content[0].text.includes("http://localhost:5173"));

  // Hostile scheme → isError result, host NEVER called — even though
  // canUseTool should have denied it earlier (defense in depth).
  for (const url of ["javascript:alert(1)", "vscode://x", "data:text/html,hi", ""]) {
    const res = await open.handler({ url }, {});
    assert.equal(res.isError, true, `hostile/empty URL ${JSON.stringify(url)} → isError`);
  }
  assert.equal(opened.length, 1, "host.openBrowser never called for rejected URLs");
}

// ─── browser_screenshot handler — image content for vision, isError on none ─
{
  const { factory, registered } = makeFactory();
  let shot = null;
  buildHypeproofMcpServer(factory, fakeZ, {
    openBrowser: async () => {},
    screenshot: async () => shot,
    startLivePreview: async () => null,
  });
  const screenshot = registered.find((t) => t.name === "browser_screenshot");

  // No open tab → isError text the coach can react to (no throw, no toast).
  const none = await screenshot.handler({}, {});
  assert.equal(none.isError, true);
  assert.equal(none.content[0].type, "text");

  // Captured tab → MCP image block (base64 + mimeType) so the model SEES it,
  // plus a title/url label for grounding.
  shot = { imageBase64: "aGVsbG8=", mimeType: "image/jpeg", url: "http://127.0.0.1:7777/", title: "내 게임" };
  const some = await screenshot.handler({}, {});
  assert.equal(some.isError, undefined);
  assert.deepEqual(some.content[0], { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" });
  assert.equal(some.content[1].type, "text");
  assert.ok(some.content[1].text.includes("내 게임") && some.content[1].text.includes("http://127.0.0.1:7777/"));
}

// ─── live_preview_start handler — returns the server URL / isError on fail ──
{
  const { factory, registered } = makeFactory();
  let url = null;
  buildHypeproofMcpServer(factory, fakeZ, {
    openBrowser: async () => {},
    screenshot: async () => null,
    startLivePreview: async () => url,
  });
  const preview = registered.find((t) => t.name === "live_preview_start");

  const fail = await preview.handler({}, {});
  assert.equal(fail.isError, true, "no workspace / server failure → isError");

  url = "http://127.0.0.1:5432/";
  const ok = await preview.handler({}, {});
  assert.equal(ok.isError, undefined);
  assert.ok(ok.content[0].text.includes(url), "tool result carries the live-server URL");
}

console.log("✓ #282 P2 s2: hypeproof browser MCP server — wiring + URL policy + vision screenshot + live preview");
