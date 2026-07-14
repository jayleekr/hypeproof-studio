// Smoke tests for the Agent SDK subagents (#282 P2 slice 3, REQ-M22/M23).
// Pure — no vscode, no SDK. Locks:
//   1. the profile → subagent grant (sdk_tools.subagents, minor strip);
//   2. the definition-tools INTERSECTION (a drifted definition can never widen
//      a subagent beyond the cohort's permitted set, and `tools` is ALWAYS
//      explicit — omitting it would inherit ALL parent tools per sdk.d.ts);
//   3. flag gating in buildSdkQueryOptions (no grant → no `agents` option);
//   4. the canUseTool policy for the Agent/Task tool (catalog-only, ask) and
//      for subagent-context calls (same matrix as the parent).
// Run: node --experimental-strip-types test/sdk-subagents.smoke.mjs

import assert from "node:assert/strict";

const {
  SDK_AGENT_TOOL_NAMES,
  SUBAGENT_CODE_REVIEWER,
  SUBAGENT_RESEARCHER,
  SUBAGENT_DEFINITIONS,
  permittedAgentToolsFor,
  buildSubagentDefinitions,
  buildSdkQueryOptions,
  profileToAgentOptions,
  evaluateSdkToolUse,
  sdkToolToActionRequest,
} = await import("../src/sdkCoachHelpers.ts");

const profile = (tier, extra = {}) => ({ game: tier ? { template_tier: tier } : undefined, ...extra });

const READ_SET = ["Read", "Grep", "Glob"];

// ─── permittedAgentToolsFor — profile.sdk_tools.subagents owns the grant ─────
{
  assert.deepEqual(
    permittedAgentToolsFor(profile("website", { sdk_tools: { subagents: true } })),
    ["Task", "Agent"],
    "adult cohort with subagents:true gets the Agent/Task invoker (both SDK names)",
  );
  assert.deepEqual([...SDK_AGENT_TOOL_NAMES], ["Task", "Agent"], "invoker name pair is locked");

  // Absent / false / non-boolean truthy → no grant (=== true only).
  assert.deepEqual(permittedAgentToolsFor(profile("website")), [], "absent sdk_tools → none");
  assert.deepEqual(
    permittedAgentToolsFor(profile("website", { sdk_tools: { read: true, write: true } })),
    [],
    "absent subagents flag → none, even for the widest adult cohort",
  );
  assert.deepEqual(
    permittedAgentToolsFor(profile("website", { sdk_tools: { subagents: false } })),
    [],
  );
  assert.deepEqual(
    permittedAgentToolsFor(profile("website", { sdk_tools: { subagents: "yes" } })),
    [],
    "non-boolean truthy grants nothing",
  );

  // MINOR-SAFETY INVARIANT (REQ-M23): a minor/unknown tier with a
  // (misconfigured) subagents:true still gets NO subagents — client strip is
  // defense-in-depth on top of the worker harness's child_sdk_subagents FAIL.
  for (const tier of ["kids-basic", "kids-rich", "teen", "pro-3d"]) {
    assert.deepEqual(
      permittedAgentToolsFor(profile(tier, { sdk_tools: { subagents: true } })),
      [],
      `minor tier ${tier} NEVER gains subagents, even if the profile says subagents:true`,
    );
  }
  assert.deepEqual(
    permittedAgentToolsFor(profile(null, { sdk_tools: { subagents: true } })),
    [],
    "unknown/missing tier fails closed to minor → subagents stripped",
  );
  console.log("✓ permittedAgentToolsFor: profile-owned, === true only, minors always stripped");
}

// ─── subagent catalog invariants — read-only by construction ────────────────
{
  const names = Object.keys(SUBAGENT_DEFINITIONS);
  assert.deepEqual(
    names.sort(),
    [SUBAGENT_CODE_REVIEWER, SUBAGENT_RESEARCHER].sort(),
    "catalog is exactly 코드리뷰어 + 리서처 in this slice",
  );
  for (const [name, def] of Object.entries(SUBAGENT_DEFINITIONS)) {
    assert.ok(def.description.length > 0 && def.prompt.length > 0, `${name}: description + prompt`);
    assert.ok(def.maxTurns > 0 && def.maxTurns <= 20, `${name}: bounded loop`);
    for (const t of def.tools) {
      assert.ok(READ_SET.includes(t), `${name}: wishlist tool ${t} must be read-only built-in`);
      assert.ok(!t.startsWith("mcp__"), `${name}: no MCP names in a definition`);
    }
    assert.ok(!def.tools.includes("WebSearch") && !def.tools.includes("WebFetch"),
      `${name}: NO web tools in this slice (리서처 reads the workspace only)`);
  }
  console.log("✓ catalog: two read-only Korean subagents, no web/MCP/shell/write in any wishlist");
}

// ─── buildSubagentDefinitions — the policy INTERSECTION matrix (REQ-M22) ─────
{
  // Read-granting cohort → definitions carry exactly the read set.
  const defs = buildSubagentDefinitions(READ_SET);
  for (const name of [SUBAGENT_CODE_REVIEWER, SUBAGENT_RESEARCHER]) {
    assert.deepEqual(defs[name].tools, READ_SET, `${name}: wishlist ∩ read cohort = read set`);
    // The omit-inherits-all trap: sdk.d.ts AgentDefinition.tools — "If
    // omitted, inherits all tools from parent". tools must ALWAYS be a
    // concrete array, never undefined.
    assert.ok(Array.isArray(defs[name].tools), `${name}: tools explicitly set (never omitted)`);
    // Belt over suspenders: write/shell/web are hard-disallowed at the
    // definition level too.
    for (const banned of ["Bash", "Write", "Edit", "NotebookEdit", "WebSearch", "WebFetch"]) {
      assert.ok(defs[name].disallowedTools.includes(banned), `${name}: ${banned} hard-disallowed`);
    }
    assert.equal("model" in defs[name] && defs[name].model !== undefined, false,
      `${name}: model omitted → inherits the gateway-clamped main model`);
  }

  // Chat-only cohort → subagents exist but with tools: [] (not undefined!).
  const chatOnly = buildSubagentDefinitions([]);
  for (const name of Object.keys(chatOnly)) {
    assert.deepEqual(chatOnly[name].tools, [], `${name}: chat-only cohort → empty tools, still explicit`);
  }

  // DRIFT MATRIX: a definition that (mistakenly) grants Write × a read-only
  // cohort → Write stripped by the intersection. This is the load-bearing
  // "definition drifts" case from the slice contract.
  const drifted = {
    "드리프트": { description: "d", prompt: "p", tools: ["Read", "Write", "Bash"], maxTurns: 5 },
  };
  const clamped = buildSubagentDefinitions(READ_SET, drifted);
  assert.deepEqual(
    clamped["드리프트"].tools,
    ["Read"],
    "definition-grants-Write × cohort-read-only → no Write (and no Bash) survives the intersection",
  );

  // Even a read+WRITE cohort cannot push Write into the shipped catalog —
  // the wishlists are read-only, so the intersection stays read-only.
  const adultRW = buildSubagentDefinitions(["Read", "Grep", "Glob", "Write", "Edit"]);
  for (const name of Object.keys(adultRW)) {
    assert.deepEqual(adultRW[name].tools, READ_SET,
      `${name}: read+write cohort still yields a READ-ONLY subagent (wishlist caps it)`);
  }
  console.log("✓ buildSubagentDefinitions: intersection clamps drift both ways; tools always explicit");
}

// ─── buildSdkQueryOptions — flag gating of the agents option ─────────────────
{
  const args = { proxyUrl: "https://api.hypeproof-ai.xyz/v1", token: "hps-token", baseEnv: {} };

  // No grant (flag absent) → NO agents key, no Task/Agent in the base tools.
  const noFlag = profileToAgentOptions(
    profile("website", { sdk_tools: { read: true, write: true } }),
    { model: "hypeproof-default", systemPrompt: "" },
  );
  assert.deepEqual(noFlag.permittedAgentTools, [], "no flag → no invoker grant");
  const noFlagOptions = buildSdkQueryOptions(noFlag, args);
  assert.equal("agents" in noFlagOptions, false, "no grant → agents option entirely absent");
  assert.ok(!noFlagOptions.tools.includes("Task") && !noFlagOptions.tools.includes("Agent"),
    "no grant → Agent/Task invoker not in the base tool set");

  // Explicit false → same as absent.
  const flagOff = profileToAgentOptions(
    profile("website", { sdk_tools: { read: true, subagents: false } }),
    { model: "hypeproof-default", systemPrompt: "" },
  );
  assert.equal("agents" in buildSdkQueryOptions(flagOff, args), false, "subagents:false → no agents option");

  // Granted adult cohort → agents present (both subagents), invoker in tools,
  // allowedTools STILL [] (nothing bypasses canUseTool — REQ-M5 holds).
  const granted = profileToAgentOptions(
    profile("website", { sdk_tools: { read: true, write: true, subagents: true } }),
    { model: "hypeproof-default", systemPrompt: "" },
  );
  const grantedOptions = buildSdkQueryOptions(granted, args);
  assert.deepEqual(
    Object.keys(grantedOptions.agents).sort(),
    [SUBAGENT_CODE_REVIEWER, SUBAGENT_RESEARCHER].sort(),
    "granted → both subagents defined",
  );
  assert.deepEqual(
    grantedOptions.agents[SUBAGENT_CODE_REVIEWER].tools,
    READ_SET,
    "definition tools = wishlist ∩ cohort permitted set (read-only despite the write cohort)",
  );
  assert.ok(grantedOptions.tools.includes("Task") && grantedOptions.tools.includes("Agent"),
    "granted → invoker joins the base tool set (availability)");
  assert.deepEqual(grantedOptions.allowedTools, [], "REQ-M5: allowedTools stays [] — every call hits canUseTool");

  // Minor cohort with a polluted profile → stripped end-to-end.
  const pollutedKids = profileToAgentOptions(
    profile("kids-rich", { sdk_tools: { read: true, subagents: true } }),
    { model: "hypeproof-default", systemPrompt: "" },
  );
  const kidsOptions = buildSdkQueryOptions(pollutedKids, args);
  assert.equal("agents" in kidsOptions, false, "minor tier: agents option absent even if profile says true");
  assert.ok(!kidsOptions.tools.includes("Task"), "minor tier: no invoker in the base tool set");
  console.log("✓ buildSdkQueryOptions: agents option rides the flag; minors stripped; allowedTools stays []");
}

// ─── evaluateSdkToolUse — Agent/Task policy + subagent-context calls ─────────
{
  const permitted = [...READ_SET, "Write", "Edit", "Task", "Agent"];

  // Not granted → Gate 1 deny (chat-only / no-subagent cohorts).
  const denied = evaluateSdkToolUse({
    toolName: "Task",
    input: { subagent_type: SUBAGENT_CODE_REVIEWER, prompt: "리뷰해줘" },
    permittedTools: READ_SET,
  });
  assert.equal(denied.decision, "deny", "Task without the profile grant dies at Gate 1");

  // Granted + catalog subagent → ask (the delegation modal IS the pedagogy).
  for (const [tool, sub] of [["Task", SUBAGENT_CODE_REVIEWER], ["Agent", SUBAGENT_RESEARCHER]]) {
    const verdict = evaluateSdkToolUse({
      toolName: tool,
      input: { subagent_type: sub, prompt: "부탁해요" },
      permittedTools: permitted,
    });
    assert.deepEqual(verdict, { decision: "ask" }, `${tool} → ${sub}: delegation always asks`);
  }

  // Granted + UNKNOWN subagent_type → deny (catalog-only, fail closed).
  for (const input of [
    { subagent_type: "general-purpose", prompt: "hack" },
    { subagent_type: "", prompt: "?" },
    { prompt: "no type at all" },
    null,
  ]) {
    const verdict = evaluateSdkToolUse({ toolName: "Task", input, permittedTools: permitted });
    assert.equal(verdict.decision, "deny", `unknown/missing subagent_type → deny (${JSON.stringify(input)})`);
  }

  // Prototype-chain names can't smuggle a "subagent" in.
  assert.equal(
    evaluateSdkToolUse({
      toolName: "Task",
      input: { subagent_type: "toString", prompt: "x" },
      permittedTools: permitted,
    }).decision,
    "deny",
    "Object.prototype members are not catalog entries",
  );

  // Bash stays hard-denied even alongside the agent grant.
  assert.equal(
    evaluateSdkToolUse({ toolName: "Bash", input: { command: "rm -rf /" }, permittedTools: permitted }).decision,
    "deny",
    "shell invariant unaffected by the subagent grant",
  );

  // Subagent-context calls come back through the SAME matrix (sdk.d.ts:
  // CanUseTool options carry agentID) — a contained read auto-allows, a write
  // still asks, an escape still dies. Nothing widens inside a subagent.
  assert.deepEqual(
    evaluateSdkToolUse({
      toolName: "Read",
      input: { file_path: "index.html" },
      permittedTools: permitted,
      workspaceRoot: "/ws/clinic",
    }),
    { decision: "allow" },
    "subagent read inside the workspace auto-allows (same as parent)",
  );
  assert.equal(
    evaluateSdkToolUse({
      toolName: "Read",
      input: { file_path: "../secrets.env" },
      permittedTools: permitted,
      workspaceRoot: "/ws/clinic",
    }).decision,
    "deny",
    "subagent path escape still denied",
  );
  console.log("✓ evaluateSdkToolUse: delegation asks, catalog-only, subagent calls face the same matrix");
}

// ─── sdkToolToActionRequest — delegation surfaces as its own modal kind ──────
{
  const req = sdkToolToActionRequest({
    toolName: "Task",
    input: { subagent_type: SUBAGENT_CODE_REVIEWER, description: "index.html 리뷰", prompt: "리뷰해줘" },
  });
  assert.equal(req.kind, "delegateAgent", "Agent/Task maps to the delegateAgent kind (modal-gated default)");
  assert.ok(req.description.includes(SUBAGENT_CODE_REVIEWER), "modal copy names the subagent");
  assert.ok(req.description.includes("index.html 리뷰"), "modal copy carries the task description");
  assert.deepEqual(req.payload, { subagent: SUBAGENT_CODE_REVIEWER, task: "index.html 리뷰" });

  const viaAgent = sdkToolToActionRequest({
    toolName: "Agent",
    input: { subagent_type: SUBAGENT_RESEARCHER, prompt: "문서 정리해줘" },
  });
  assert.equal(viaAgent.kind, "delegateAgent");
  assert.deepEqual(viaAgent.payload, { subagent: SUBAGENT_RESEARCHER, task: "문서 정리해줘" });
  console.log("✓ sdkToolToActionRequest: Agent/Task → delegateAgent with subagent + task in the modal copy");
}

console.log("sdk-subagents.smoke.mjs: all tests passed");
