// Smoke tests for the Agent SDK coach pure helpers (#282). Pure — no vscode,
// no SDK. Locks the profile → tool-policy contract and the SDK-tool → host
// ActionRequest mapping (the two places a wrong mapping silently defeats the
// executeShell hard-deny / workspace-scope safety tiers).
// Run: node --experimental-strip-types test/sdk-coach-helpers.smoke.mjs

import assert from "node:assert/strict";

const {
  permittedToolsFor,
  isMinorTier,
  maxTurnsFor,
  sdkToolToActionRequest,
} = await import("../src/sdkCoachHelpers.ts");

const profile = (tier, extra = {}) => ({ game: tier ? { template_tier: tier } : undefined, ...extra });

// ─── permittedToolsFor — file tools only for the professional webapp tier ────
{
  // search-webapp (보아치과) → file tools.
  assert.deepEqual(permittedToolsFor(profile("search-webapp")), ["Read", "Write", "Edit"]);

  // Game/kids/teen cohorts → chat-only, NO autonomous tools.
  for (const tier of ["kids-basic", "kids-rich", "teen", "pro-3d"]) {
    assert.deepEqual(permittedToolsFor(profile(tier)), [], `${tier} must be chat-only`);
  }

  // Unknown / missing tier → fail closed (no tools).
  assert.deepEqual(permittedToolsFor(profile("teens-game-NEW")), [], "unknown tier grants nothing");
  assert.deepEqual(permittedToolsFor(profile(null)), [], "missing game field grants nothing");
}

// ─── WebSearch is gated on the profile's explicit tools.web_search opt-in ────
{
  // Dental cohort: search-webapp + web_search opt-in → file tools + WebSearch.
  assert.deepEqual(
    permittedToolsFor(profile("search-webapp", { tools: { web_search: true } })),
    ["Read", "Write", "Edit", "WebSearch"],
  );

  // A minor cohort that did NOT opt in never gets WebSearch, even if its
  // assets_focus mentions verification (the old bug enabled it here).
  assert.deepEqual(
    permittedToolsFor(profile("kids-rich", { assets_focus: ["verification_reflex"] })),
    [],
    "kids cohort without tools.web_search stays chat-only",
  );

  // web_search:false must not add the tool.
  assert.deepEqual(permittedToolsFor(profile("search-webapp", { tools: { web_search: false } })), [
    "Read",
    "Write",
    "Edit",
  ]);
}

// ─── isMinorTier — kids/teen/game/unknown minor; search-webapp adult ─────────
{
  for (const tier of ["kids-basic", "kids-rich", "teen", "pro-3d"]) {
    assert.equal(isMinorTier(profile(tier)), true, `${tier} is a minor cohort`);
  }
  assert.equal(isMinorTier(profile(null)), true, "missing tier fails closed to minor");
  assert.equal(isMinorTier(profile("weird-new-tier")), true, "unknown tier fails closed to minor");
  assert.equal(isMinorTier(profile("search-webapp")), false, "search-webapp is the adult workshop tier");
}

// ─── maxTurnsFor — tight for minors, looser for the workshop ─────────────────
{
  assert.equal(maxTurnsFor(profile("kids-basic")), 6);
  assert.equal(maxTurnsFor(profile("teen")), 6);
  assert.equal(maxTurnsFor(profile(null)), 6, "unknown tier gets the tight minor cap");
  assert.equal(maxTurnsFor(profile("search-webapp")), 20);
}

// ─── sdkToolToActionRequest — SDK tool → accurate host ActionRequest ─────────
{
  // Bash → executeShell (Tier-1 hard-deny), NOT writeFile.
  const bash = sdkToolToActionRequest({ toolName: "Bash", input: { command: "rm -rf /" } });
  assert.equal(bash.kind, "executeShell", "Bash must classify as executeShell");
  assert.equal(bash.payload.command, "rm -rf /");

  // Write → writeFile with the REAL path (Tier-2 workspace-scope sees a path).
  const write = sdkToolToActionRequest({
    toolName: "Write",
    input: { file_path: "/ws/index.html", content: "<html>" },
  });
  assert.equal(write.kind, "writeFile");
  assert.equal(write.payload.path, "/ws/index.html", "path extracted from file_path, not a JSON blob");

  // Edit → writeFile (same disk-write policy) with the real path.
  const edit = sdkToolToActionRequest({
    toolName: "Edit",
    input: { file_path: "/ws/app.js", old_string: "a", new_string: "b" },
  });
  assert.equal(edit.kind, "writeFile");
  assert.equal(edit.payload.path, "/ws/app.js");

  // Read → readFile (also workspace-scoped), WebSearch → webSearch.
  assert.equal(sdkToolToActionRequest({ toolName: "Read", input: { file_path: "/ws/x" } }).kind, "readFile");
  const search = sdkToolToActionRequest({ toolName: "WebSearch", input: { query: "치과" } });
  assert.equal(search.kind, "webSearch");
  assert.equal(search.payload.query, "치과");

  // Unknown tool → fail closed via the shell hard-deny tier.
  assert.equal(
    sdkToolToActionRequest({ toolName: "MysteryTool", input: { x: 1 } }).kind,
    "executeShell",
    "unrecognized tools must fail closed, never allow-by-default",
  );
}

console.log("✓ #282: sdk-coach helpers — tool policy + SDK-tool→ActionRequest mapping");
