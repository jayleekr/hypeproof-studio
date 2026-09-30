// CR-T02, App half at the unit layer (cr-browser #1391; recon R3). Walks the switch-off
// inventory `CR_SURFACES` — commands, MCP tools, proxy tools, webview messages — with the
// switch off and on. The Worker half is worker/test/cr-switch.test.mjs; the in-app half
// (09-preview.spec.ts and a CR-enabled app) is a Playwright run recorded in the evidence file.
//
// Run: node --experimental-strip-types test/cr-switch.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const stub = new URL("./fixtures/vscode-stub.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "vscode") return { url: stub, shortCircuit: true };
    if (specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(specifier, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { CR_SURFACES, CR_CONTEXT_KEY, manifestSwitchProblems, isCurriculumRuntimeEnabled } = await import("../src/curriculumRuntime.ts");
const { permittedMcpToolsFor } = await import("../src/sdkCoachHelpers.ts");
const { buildHypeproofMcpServer, MCP_BROWSER_TOOLS } = await import("../src/browserMcp.ts");
const { BrowserControl } = await import("../src/browserControl.ts");
const vscode = await import(stub);

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const protocolSrc = readFileSync(new URL("../src/protocol.ts", import.meta.url), "utf8");
const providerSrc = readFileSync(new URL("../src/chatPanelProvider.ts", import.meta.url), "utf8");
let passed = 0;
const ok = (name) => { passed++; console.log(`✓ ${name}`); };

// ── the flag ────────────────────────────────────────────────────────────────
assert.equal(isCurriculumRuntimeEnabled(undefined), false);
assert.equal(isCurriculumRuntimeEnabled({}), false);
assert.equal(isCurriculumRuntimeEnabled({ curriculum_runtime: { enabled: "true" } }), false, "only an explicit true");
assert.equal(isCurriculumRuntimeEnabled({ curriculum_runtime: { enabled: true } }), true);
ok("flag: absent or anything but true is off");

// ── commands: gated in the manifest ────────────────────────────────────────
assert.deepEqual(manifestSwitchProblems(manifest), [], "every CR command is hidden and disabled with the switch off");
const cmd = (m) => m.contributes.commands.find((c) => c.command === "hypeproof-chat.pickElement");
const plant = (fn) => { const m = structuredClone(manifest); fn(m); return manifestSwitchProblems(m); };
assert.ok(plant((m) => delete cmd(m).enablement).some((p) => /enablement/.test(p)), "a CR command enabled regardless of the switch is caught");
assert.ok(plant((m) => (m.contributes.menus.commandPalette = m.contributes.menus.commandPalette.filter((x) => x.command !== "hypeproof-chat.pickElement"))).some((p) => /palette/.test(p)));
assert.ok(plant((m) => (m.contributes.menus["view/title"].find((x) => x.command === "hypeproof-chat.pickElement").when = "view == hypeproof-chat.panel")).some((p) => /view\/title/.test(p)));
assert.ok(plant((m) => (cmd(m).enablement = `true || ${CR_CONTEXT_KEY}`)).some((p) => /enablement/.test(p)), "an `||` does not require the key");
assert.ok(plant((m) => (cmd(m).command = "hypeproof-chat.renamed")).some((p) => /not declared/.test(p)));
ok("commands: the manifest gates every inventoried CR command; planted ungated variants are caught");
// Every command handler re-checks the served switch (a command runs without its menu).
assert.match(providerSrc, /async pickElement\(\): Promise<void> \{\s*if \(!this\.isCurriculumRuntimeEnabled\(\)\)/);
ok("commands: the pickElement handler re-checks the served switch before anything else");

// ── MCP tools: granted and registered only with the switch on ───────────────
const adult = { game: { template_tier: "website" }, sdk_tools: { browser: true }, minor_cohort: false };
const off = permittedMcpToolsFor(adult);
const on = permittedMcpToolsFor({ ...adult, curriculum_runtime: { enabled: true } });
assert.deepEqual(off, [...MCP_BROWSER_TOOLS], "switch off: the existing grant, unchanged");
assert.deepEqual(off.filter((t) => CR_SURFACES.mcpTools.includes(t)), []);
assert.deepEqual(on.filter((t) => CR_SURFACES.mcpTools.includes(t)).sort(), [...CR_SURFACES.mcpTools].sort());
const minor = permittedMcpToolsFor({ ...adult, game: { template_tier: "kids-quest" }, curriculum_runtime: { enabled: true } });
assert.deepEqual(minor, [], "the switch never grants browser tools the minor rule strips");
function registered(opts) {
  const names = [];
  buildHypeproofMcpServer(
    { tool: (name) => (names.push(name), name), createSdkMcpServer: (o) => o },
    { string: () => "s", boolean: () => "b", number: () => "n" },
    { openBrowser: async () => {}, screenshot: async () => null, startLivePreview: async () => null },
    opts,
  );
  return names;
}
const short = CR_SURFACES.mcpTools.map((t) => t.replace(/^mcp__hypeproof__/, ""));
assert.deepEqual(registered({}).filter((n) => short.includes(n)), []);
assert.deepEqual(registered({ curriculumRuntime: false }).filter((n) => short.includes(n)), []);
assert.deepEqual(registered({ curriculumRuntime: true }).filter((n) => short.includes(n)).sort(), [...short].sort());
ok("MCP tools: absent from the grant and the server with the switch off; all present with it on");

// ── proxy tools: executed only with the switch on ───────────────────────────
{
  vscode.window.browserTabs = [];
  vscode.window.activeBrowserTab = undefined;
  let enabled = false;
  const control = new BrowserControl({
    enabled: () => enabled,
    allowedOrigins: () => ["http://127.0.0.1:5173"],
    artifactVersion: async () => { throw new Error("unused"); },
  });
  for (const name of CR_SURFACES.proxyTools) {
    const r = await control.execute({ id: "t", name, input: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, new RegExp(`알 수 없는 도구: ${name}`), `${name} is unknown with the switch off`);
  }
  await assert.rejects(control.pickElement({ root: null }), /꺼져 있어요/);
  const legacy = await control.execute({ id: "t", name: "browser_navigate", input: { url: "https://example.com/" } });
  assert.doesNotMatch(legacy.content[0].text, /범위 밖/, "switch off: the pre-CR navigate path, no origin scope");
  enabled = true;
  for (const name of CR_SURFACES.proxyTools) {
    const r = await control.execute({ id: "t", name, input: {} });
    assert.doesNotMatch(r.content[0].text, /알 수 없는 도구/, `${name} is routed with the switch on`);
    assert.match(r.content[0].text, /열린 브라우저 탭이 없어요/, "and answered by the CR executor");
  }
  ok("proxy tools: unknown with the switch off, routed to the CR executor with it on (read per call)");
}

// ── webview messages ───────────────────────────────────────────────────────
for (const t of CR_SURFACES.webviewMessages) {
  assert.match(protocolSrc, new RegExp(`\\{ type: "${t}" \\}`), `${t} is a declared webview message`);
  const handler = new RegExp(`case "${t}":[\\s\\S]{0,200}?this\\.clearElementContext\\(\\)`);
  assert.match(providerSrc, handler, `${t} only removes CR state; it has nothing to reach with the switch off`);
}
// The element preview the host posts is built only from pendingElement, which only pickElement sets.
assert.equal((providerSrc.match(/this\.pendingElement = \{/g) ?? []).length, 1, "one writer of pendingElement");
assert.match(providerSrc, /const element = this\.isCurriculumRuntimeEnabled\(\) \? this\.pendingElement : null;/, "a queued element is not sent after the switch turns off");
ok("webview: CR messages are declared, handled, and nothing CR is sent with the switch off");

console.log(`\n${passed} cr-switch checks passed`);
