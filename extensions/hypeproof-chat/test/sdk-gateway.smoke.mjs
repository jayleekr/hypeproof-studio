// Smoke tests for the Agent SDK → worker gateway wiring (#282 Phase 1).
// Pure — no vscode. Locks REQ-M6 (gateway routing + env preservation) and
// REQ-M13 (no-local-API-key invariant), plus the two flag/dependency
// invariants of this slice: coachRuntime still defaults to "proxy" (Phase-3
// flip is Jay-gated) and @anthropic-ai/claude-agent-sdk is genuinely
// installed and loadable.
// Run: node --experimental-strip-types test/sdk-gateway.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const { anthropicBaseUrlFor, buildSdkGatewayEnv, buildSdkQueryOptions, profileToAgentOptions } =
  await import("../src/sdkCoachHelpers.ts");

// ─── anthropicBaseUrlFor — proxyUrl (/v1 base) → SDK base URL ────────────────
// The SDK appends /v1/messages to ANTHROPIC_BASE_URL; passing the proxyUrl
// setting through unmodified would hit /v1/v1/messages (404).
{
  assert.equal(
    anthropicBaseUrlFor("https://api.hypeproof-ai.xyz/v1"),
    "https://api.hypeproof-ai.xyz",
    "prod default: /v1 suffix stripped",
  );
  assert.equal(
    anthropicBaseUrlFor("http://localhost:8787/v1"),
    "http://localhost:8787",
    "wrangler dev base works too",
  );
  assert.equal(
    anthropicBaseUrlFor("https://api.hypeproof-ai.xyz/v1/"),
    "https://api.hypeproof-ai.xyz",
    "trailing slash tolerated",
  );
  assert.equal(
    anthropicBaseUrlFor("https://gateway.example.com"),
    "https://gateway.example.com",
    "a URL without /v1 passes through unchanged",
  );
  assert.equal(
    anthropicBaseUrlFor("  https://api.hypeproof-ai.xyz/V1 "),
    "https://api.hypeproof-ai.xyz",
    "whitespace + case-insensitive /v1",
  );
}

// ─── buildSdkGatewayEnv — REQ-M6 routing + REQ-M13 key scrub ─────────────────
{
  const env = buildSdkGatewayEnv(
    {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/student",
      // A dev machine's ambient credentials/provider switches — all of these
      // could shadow the gateway (API key outranks AUTH_TOKEN; Bedrock/Vertex
      // switches ignore ANTHROPIC_BASE_URL entirely).
      ANTHROPIC_API_KEY: "sk-ant-dev-machine-key",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_AUTH_TOKEN: "stale-token",
    },
    { proxyUrl: "https://api.hypeproof-ai.xyz/v1", token: "hps-workshop-token" },
  );

  // Gateway routing: the SDK-recognized vars point at the worker.
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.hypeproof-ai.xyz");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "hps-workshop-token");

  // No-local-API-key invariant: the workshop token is the ONLY credential.
  assert.equal("ANTHROPIC_API_KEY" in env, false, "ambient ANTHROPIC_API_KEY must be scrubbed");
  assert.equal("CLAUDE_CODE_USE_BEDROCK" in env, false, "Bedrock switch must be scrubbed");
  assert.equal("CLAUDE_CODE_USE_VERTEX" in env, false, "Vertex switch must be scrubbed");

  // The SDK REPLACES the subprocess env with options.env — inherited vars the
  // spawned CLI needs (PATH/HOME) must survive the construction.
  assert.equal(env.PATH, "/usr/bin:/bin", "PATH preserved");
  assert.equal(env.HOME, "/Users/student", "HOME preserved");

  // Works with NO local credentials at all (clean classroom machine).
  const clean = buildSdkGatewayEnv({ PATH: "/bin" }, { proxyUrl: "http://localhost:8787/v1", token: "t" });
  assert.equal(clean.ANTHROPIC_BASE_URL, "http://localhost:8787");
  assert.equal(clean.ANTHROPIC_AUTH_TOKEN, "t");
  assert.equal("ANTHROPIC_API_KEY" in clean, false, "no API key is ever required or invented");
}

// ─── buildSdkQueryOptions — full option threading to query() ─────────────────
{
  const profile = { game: { template_tier: "kids-basic" } };
  const agent = profileToAgentOptions(profile, { model: "hypeproof-default", systemPrompt: "" });
  const options = buildSdkQueryOptions(agent, {
    proxyUrl: "https://api.hypeproof-ai.xyz/v1",
    token: "hps-token",
    baseEnv: { PATH: "/bin", ANTHROPIC_API_KEY: "leak-me-not" },
  });

  assert.equal(options.model, "hypeproof-default", "model threaded to the SDK");
  assert.deepEqual(options.allowedTools, [], "REQ-M5: nothing bypasses canUseTool");
  assert.deepEqual(options.settingSources, [], "REQ-M5: workspace settings cannot inject allow-rules");
  assert.deepEqual(options.tools, [], "REQ-M16: chat-only cohort disables ALL built-in tools (tools: [])");
  assert.equal(options.permissionMode, "default");
  assert.equal(options.maxTurns, 6, "minor cohort keeps the tight loop bound");
  assert.equal(options.env.ANTHROPIC_BASE_URL, "https://api.hypeproof-ai.xyz");
  assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, "hps-token");
  assert.equal("ANTHROPIC_API_KEY" in options.env, false, "REQ-M13 holds through the full option build");
  assert.equal("cwd" in options, false, "cwd omitted when not provided");

  const withCwd = buildSdkQueryOptions(agent, {
    proxyUrl: "https://api.hypeproof-ai.xyz/v1",
    token: "hps-token",
    cwd: "/ws/student",
    baseEnv: {},
  });
  assert.equal(withCwd.cwd, "/ws/student", "workspace root threaded for file tools");

  // #282 Phase 2 (REQ-M16): profile.sdk_tools → Options.tools (base tool set,
  // availability ONLY — approval still runs through canUseTool). allowedTools
  // must stay [] even for the widest cohort: an allowedTools entry would
  // AUTO-APPROVE and bypass canUseTool, defeating the write modal.
  const copyclone = {
    game: { template_tier: "website" },
    sdk_tools: { read: true, write: true },
  };
  const adult = profileToAgentOptions(copyclone, { model: "hypeproof-default", systemPrompt: "" });
  const adultOptions = buildSdkQueryOptions(adult, {
    proxyUrl: "https://api.hypeproof-ai.xyz/v1",
    token: "hps-token",
    cwd: "/ws/clinic",
    baseEnv: {},
  });
  assert.deepEqual(
    adultOptions.tools,
    ["Read", "Grep", "Glob", "Write", "Edit"],
    "adult copyclone cohort: sdk_tools maps to the exact SDK tool names",
  );
  assert.deepEqual(adultOptions.allowedTools, [], "REQ-M5 holds for tooled cohorts too — no auto-approval");
  assert.ok(!adultOptions.tools.includes("Bash"), "no profile flag can put Bash in the tool set");

  // #282 P2 slice 2 (REQ-M19): the browser grant lives in permittedMcpTools,
  // NEVER in Options.tools (that field filters BUILT-INS; MCP tools arrive
  // via mcpServers, attached by the orchestration layer only when granted).
  // strictMcpConfig is pinned true so ambient MCP configs (.mcp.json, user
  // settings, plugins) can never add tools behind the cohort profile's back.
  const browserCohort = {
    game: { template_tier: "website" },
    sdk_tools: { read: true, write: true, browser: true },
  };
  const browserAgent = profileToAgentOptions(browserCohort, { model: "hypeproof-default", systemPrompt: "" });
  assert.deepEqual(
    browserAgent.permittedMcpTools,
    ["mcp__hypeproof__browser_open", "mcp__hypeproof__browser_screenshot", "mcp__hypeproof__live_preview_start"],
    "browser grant → the three hypeproof MCP tool names on the agent options",
  );
  const browserOptions = buildSdkQueryOptions(browserAgent, {
    proxyUrl: "https://api.hypeproof-ai.xyz/v1",
    token: "hps-token",
    cwd: "/ws/clinic",
    baseEnv: {},
  });
  assert.deepEqual(
    browserOptions.tools,
    ["Read", "Grep", "Glob", "Write", "Edit"],
    "REQ-M19: MCP names never leak into Options.tools (built-in base set only)",
  );
  assert.ok(!("mcpServers" in browserOptions), "mcpServers is host-bound — attached by sdkCoach, never by the pure builder");
  assert.equal(options.strictMcpConfig, true, "strictMcpConfig pinned for chat-only cohorts");
  assert.equal(browserOptions.strictMcpConfig, true, "strictMcpConfig pinned for browser cohorts too");
  assert.deepEqual(browserOptions.allowedTools, [], "REQ-M5: browser MCP tools also route through canUseTool");

  // Minor cohort defense-in-depth: even a polluted profile grants nothing.
  const pollutedKids = profileToAgentOptions(
    { game: { template_tier: "kids-rich" }, sdk_tools: { browser: true } },
    { model: "hypeproof-default", systemPrompt: "" },
  );
  assert.deepEqual(pollutedKids.permittedMcpTools, [], "minor tier: browser grant stripped client-side");
}

// ─── coachRuntime flag still defaults to "proxy" (Phase-3 flip is Jay-gated) ─
{
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const flag = pkg.contributes.configuration.properties["hypeproofChat.coachRuntime"];
  assert.equal(flag.default, "proxy", "#282 Phase 1 must NOT flip the default runtime");
  assert.deepEqual(flag.enum, ["proxy", "agent-sdk"]);
  assert.equal(
    "@anthropic-ai/claude-agent-sdk" in (pkg.dependencies ?? {}),
    true,
    "the Agent SDK is a real dependency of the extension host bundle",
  );
}

// ─── the installed SDK is genuinely loadable and exposes query() ─────────────
// Import the real package the way sdkCoach's loadSdk() does (dynamic import).
// This is what separates Phase 1 from the #284 stub: a missing/broken install
// fails HERE, not silently at classroom time via the proxy fallback.
{
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  assert.equal(typeof mod.query, "function", "SDK exports query()");
}

console.log("✓ #282: agent-sdk gateway wiring — base-URL derivation, env/key invariants, flag default, real SDK loadable");
