// Smoke tests for the Agent SDK coach pure helpers (#282). Pure — no vscode,
// no SDK. Locks the profile → tool-policy contract and the SDK-tool → host
// ActionRequest mapping (the two places a wrong mapping silently defeats the
// executeShell hard-deny / workspace-scope safety tiers).
// Run: node --experimental-strip-types test/sdk-coach-helpers.smoke.mjs

import assert from "node:assert/strict";

const {
  permittedToolsFor,
  permittedMcpToolsFor,
  isMinorTier,
  maxTurnsFor,
  sdkToolToActionRequest,
  isAbortError,
  isPathContained,
  evaluateSdkToolUse,
} = await import("../src/sdkCoachHelpers.ts");
const {
  MCP_BROWSER_OPEN,
  MCP_BROWSER_SCREENSHOT,
  MCP_LIVE_PREVIEW_START,
} = await import("../src/browserMcp.ts");

const profile = (tier, extra = {}) => ({ game: tier ? { template_tier: tier } : undefined, ...extra });

// ─── permittedToolsFor — profile.sdk_tools owns file-tool policy (#282 P2) ───
{
  // Adult copyclone cohort (read+write from the worker profile) → full file set.
  assert.deepEqual(
    permittedToolsFor(profile("website", { sdk_tools: { read: true, write: true } })),
    ["Read", "Grep", "Glob", "Write", "Edit"],
    "adult read+write cohort gets the read set + write set (exact SDK tool names)",
  );

  // Read-only grant → read set only, regardless of tier.
  assert.deepEqual(
    permittedToolsFor(profile("website", { sdk_tools: { read: true, write: false } })),
    ["Read", "Grep", "Glob"],
  );

  // No sdk_tools at all → chat-only, EVEN for the adult workshop tiers.
  // Pre-Phase-2 the client inferred Read/Write/Edit from the tier; the worker
  // profile is now the only source (ADR 0003) and absent = all false.
  for (const tier of ["search-webapp", "website", "kids-basic", "kids-rich", "teen", "pro-3d"]) {
    assert.deepEqual(permittedToolsFor(profile(tier)), [], `${tier} without sdk_tools must be chat-only`);
  }
  assert.deepEqual(permittedToolsFor(profile(null)), [], "missing game field + no sdk_tools grants nothing");

  // MINOR-SAFETY INVARIANT: a minor tier with a (misconfigured) write:true
  // still gets NO write tools — the client strips them as defense-in-depth on
  // top of the worker harness's child_sdk_write FAIL.
  assert.deepEqual(
    permittedToolsFor(profile("kids-rich", { sdk_tools: { read: true, write: true } })),
    ["Read", "Grep", "Glob"],
    "minor cohort NEVER gains write tools, even if the profile says write:true",
  );
  assert.deepEqual(
    permittedToolsFor(profile(null, { sdk_tools: { write: true } })),
    [],
    "unknown/missing tier fails closed to minor → write stripped",
  );

  // Explicit false / non-boolean truthy values grant nothing (=== true only).
  assert.deepEqual(permittedToolsFor(profile("website", { sdk_tools: { read: false, write: false } })), []);
  assert.deepEqual(permittedToolsFor(profile("website", { sdk_tools: { read: "yes" } })), []);
}

// ─── WebSearch is gated on the profile's explicit tools.web_search opt-in ────
{
  // Dental cohort: read+write + web_search opt-in → file tools + WebSearch +
  // WebFetch (research = find + read; granting search without fetch is half).
  assert.deepEqual(
    permittedToolsFor(
      profile("search-webapp", { sdk_tools: { read: true, write: true }, tools: { web_search: true } }),
    ),
    ["Read", "Grep", "Glob", "Write", "Edit", "WebSearch", "WebFetch"],
  );

  // A minor cohort that did NOT opt in never gets WebSearch, even if its
  // assets_focus mentions verification (the old bug enabled it here).
  assert.deepEqual(
    permittedToolsFor(profile("kids-rich", { assets_focus: ["verification_reflex"] })),
    [],
    "kids cohort without tools.web_search stays chat-only",
  );

  // web_search:false must not add the tool.
  assert.deepEqual(
    permittedToolsFor(profile("search-webapp", { sdk_tools: { read: true }, tools: { web_search: false } })),
    ["Read", "Grep", "Glob"],
  );
}

// ─── isMinorTier — kids/teen/game/unknown minor; search-webapp adult ─────────
{
  for (const tier of ["kids-basic", "kids-rich", "teen", "pro-3d"]) {
    assert.equal(isMinorTier(profile(tier)), true, `${tier} is a minor cohort`);
  }
  assert.equal(isMinorTier(profile(null)), true, "missing tier fails closed to minor");
  assert.equal(isMinorTier(profile("weird-new-tier")), true, "unknown tier fails closed to minor");
  assert.equal(isMinorTier(profile("search-webapp")), false, "search-webapp is the adult workshop tier");
  assert.equal(isMinorTier(profile("website")), false, "website copyclone is an adult workshop tier");
}

// ─── maxTurnsFor — tight for minors, looser for the workshop ─────────────────
{
  assert.equal(maxTurnsFor(profile("kids-basic")), 6);
  assert.equal(maxTurnsFor(profile("teen")), 6);
  assert.equal(maxTurnsFor(profile(null)), 6, "unknown tier gets the tight minor cap");
  assert.equal(maxTurnsFor(profile("search-webapp")), 20);
  assert.equal(maxTurnsFor(profile("website")), 20, "website copyclone gets the workshop cap");
}

// ─── isAbortError — user-stop parity across BOTH runtimes ─────────────────────
// The default proxy path raises a DOMException("AbortError") on stop; the SDK
// path throws an Error with name "AbortError". Both must be recognized so the
// panel skips committing the truncated turn AND suppresses the error banner —
// the regression basis for "proxy stop behavior preserved" (JinyongShin #284).
{
  // Proxy path: fetch abort surfaces a DOMException named AbortError.
  const domAbort =
    typeof DOMException === "function"
      ? new DOMException("Aborted", "AbortError")
      : Object.assign(new Error("Aborted"), { name: "AbortError" });
  assert.equal(isAbortError(domAbort), true, "fetch/proxy AbortError is recognized");

  // SDK path: plain Error with name AbortError (see sdkCoach abortError()).
  assert.equal(isAbortError(Object.assign(new Error("Aborted"), { name: "AbortError" })), true);

  // Real failures must NOT be swallowed as a stop (they still show a banner).
  assert.equal(isAbortError(new Error("network down")), false, "genuine errors are not aborts");
  assert.equal(isAbortError(new TypeError("boom")), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError("AbortError"), false, "a bare string is not an error object");
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

  // WebFetch routes through the same web-approval tier, surfacing the URL.
  const fetch = sdkToolToActionRequest({ toolName: "WebFetch", input: { url: "https://ref.example/clinic" } });
  assert.equal(fetch.kind, "webSearch", "WebFetch also goes through the web-approval modal");
  assert.equal(fetch.payload.query, "https://ref.example/clinic", "WebFetch url surfaced for the modal");

  // Unknown tool → fail closed via the shell hard-deny tier.
  assert.equal(
    sdkToolToActionRequest({ toolName: "MysteryTool", input: { x: 1 } }).kind,
    "executeShell",
    "unrecognized tools must fail closed, never allow-by-default",
  );
}

// ─── isPathContained — workspace containment primitive (#282 P2) ─────────────
{
  const ws = "/ws/student";
  assert.equal(isPathContained(ws, "/ws/student/index.html"), true, "absolute path inside root");
  assert.equal(isPathContained(ws, "index.html"), true, "relative path resolves against root");
  assert.equal(isPathContained(ws, "sub/dir/app.js"), true);
  assert.equal(isPathContained(ws, "/ws/student"), true, "the root itself is contained");
  assert.equal(isPathContained(ws, "/etc/passwd"), false, "absolute path outside root");
  assert.equal(isPathContained(ws, "../other/secret.txt"), false, "../ traversal escapes");
  assert.equal(isPathContained(ws, "/ws/student/../student2/x"), false, "embedded ../ is normalized before the check");
  assert.equal(isPathContained(ws, "/ws/student2/x"), false, "sibling prefix trick (/ws/student2) is not inside /ws/student");
}

// ─── evaluateSdkToolUse — the #282 Phase 2 policy matrix ─────────────────────
{
  const ws = "/ws/student";
  const adultRW = ["Read", "Grep", "Glob", "Write", "Edit"];       // copyclone (원장, adult)
  const minorRO = ["Read", "Grep", "Glob"];                        // read-only cohort
  const evalTool = (toolName, input, permittedTools, workspaceRoot = ws) =>
    evaluateSdkToolUse({ toolName, input, permittedTools, workspaceRoot });

  // Bash is denied even when the upstream model requests it — for EVERY
  // cohort, including the widest adult set. There is no profile flag that can
  // grant it (Phase 2 invariant).
  for (const permitted of [[], minorRO, adultRW]) {
    const v = evalTool("Bash", { command: "rm -rf /" }, permitted);
    assert.equal(v.decision, "deny", "Bash must be denied regardless of cohort");
    assert.ok(v.friendly.length > 0, "student sees the Korean friendly line");
    assert.ok(v.reason.length > 0, "host gets a loggable reason");
  }
  // Belt over suspenders: even if a permitted set were (wrongly) widened to
  // include a shell tool, Gate 1b still denies it.
  assert.equal(evalTool("Bash", { command: "ls" }, ["Bash"]).decision, "deny",
    "shell denied even if the permitted set is misconfigured to include it");

  // Minor read-only cohort: reads inside the workspace auto-allow (no modal)…
  assert.deepEqual(evalTool("Read", { file_path: "/ws/student/index.html" }, minorRO), { decision: "allow" });
  assert.deepEqual(evalTool("Grep", { pattern: "TODO", path: "src" }, minorRO), { decision: "allow" });
  assert.deepEqual(evalTool("Glob", { pattern: "**/*.html" }, minorRO), { decision: "allow" });
  // …but writes are denied outright (not granted by the profile).
  assert.equal(evalTool("Write", { file_path: "/ws/student/index.html", content: "x" }, minorRO).decision, "deny",
    "read-only cohort: Write denied even inside the workspace");
  assert.equal(evalTool("Edit", { file_path: "index.html" }, minorRO).decision, "deny");

  // Path escapes are rejected for reads AND writes — ../ traversal and
  // absolute paths outside cwd never reach the tool (or the modal).
  assert.equal(evalTool("Read", { file_path: "../teacher/answers.md" }, adultRW).decision, "deny");
  assert.equal(evalTool("Read", { file_path: "/etc/passwd" }, adultRW).decision, "deny");
  assert.equal(evalTool("Write", { file_path: "/ws/student/../../etc/cron.d/x", content: "" }, adultRW).decision, "deny");
  assert.equal(evalTool("Glob", { pattern: "/etc/**" }, adultRW).decision, "deny",
    "absolute Glob pattern outside the workspace is a path escape");
  assert.equal(evalTool("Glob", { pattern: "../**" }, adultRW).decision, "deny");

  // Adult read+write cohort: writes INSIDE the workspace still ask — the
  // approve/deny modal always runs for writes (the gate is the pedagogy).
  assert.deepEqual(evalTool("Write", { file_path: "/ws/student/index.html", content: "x" }, adultRW), { decision: "ask" });
  assert.deepEqual(evalTool("Edit", { file_path: "index.html", old_string: "a", new_string: "b" }, adultRW), { decision: "ask" });
  assert.deepEqual(evalTool("Read", { file_path: "index.html" }, adultRW), { decision: "allow" });

  // Tools outside the profile grant → deny with a logged reason (WebFetch
  // without the web_search opt-in, unknown/future tools, MCP names).
  assert.equal(evalTool("WebFetch", { url: "https://x" }, adultRW).decision, "deny");
  assert.equal(evalTool("MysteryTool", { x: 1 }, adultRW).decision, "deny");
  assert.equal(evalTool("mcp__github__create_pr", {}, adultRW).decision, "deny");

  // Web research, when the profile opted in, routes to the approval path.
  const withWeb = [...adultRW, "WebSearch", "WebFetch"];
  assert.deepEqual(evalTool("WebSearch", { query: "치과" }, withWeb), { decision: "ask" });
  assert.deepEqual(evalTool("WebFetch", { url: "https://ref.example" }, withWeb), { decision: "ask" });

  // No workspaceRoot (dev/test without a folder): containment is skipped,
  // matching the host isInsideWorkspace convention — grants still apply.
  assert.deepEqual(
    evaluateSdkToolUse({ toolName: "Read", input: { file_path: "/anywhere" }, permittedTools: adultRW }),
    { decision: "allow" },
  );
  assert.equal(
    evaluateSdkToolUse({ toolName: "Bash", input: { command: "ls" }, permittedTools: adultRW }).decision,
    "deny",
    "shell stays denied even without a workspace",
  );
}

// ─── permittedMcpToolsFor — profile.sdk_tools.browser owns the grant (#282 P2 s2) ─
{
  const ALL_BROWSER_MCP = [MCP_BROWSER_OPEN, MCP_BROWSER_SCREENSHOT, MCP_LIVE_PREVIEW_START];

  // Adult cohort with the browser grant → all three tools, exact MCP names.
  assert.deepEqual(
    permittedMcpToolsFor(profile("website", { sdk_tools: { browser: true } })),
    ALL_BROWSER_MCP,
    "adult browser cohort gets the three hypeproof MCP tools",
  );

  // Absent / false / non-boolean → nothing (fail closed, === true only).
  assert.deepEqual(permittedMcpToolsFor(profile("website")), [], "no sdk_tools → no browser MCP");
  assert.deepEqual(permittedMcpToolsFor(profile("website", { sdk_tools: { browser: false } })), []);
  assert.deepEqual(permittedMcpToolsFor(profile("website", { sdk_tools: { browser: "yes" } })), []);
  assert.deepEqual(permittedMcpToolsFor(profile("website", { sdk_tools: { read: true, write: true } })), [],
    "read/write grants do NOT imply the browser grant");

  // MINOR-SAFETY INVARIANT (#306/#318): a minor tier with a (misconfigured)
  // browser:true still gets NO browser MCP tools — client strip on top of the
  // worker harness's child_sdk_browser FAIL. When in doubt, deny for minors.
  for (const tier of ["kids-basic", "kids-rich", "teen", "pro-3d", "mystery-NEW", null]) {
    assert.deepEqual(
      permittedMcpToolsFor(profile(tier, { sdk_tools: { browser: true } })),
      [],
      `minor/unknown tier ${tier} NEVER gains browser MCP tools, even with browser:true`,
    );
  }
}

// ─── evaluateSdkToolUse — hypeproof browser MCP policy (#282 P2 s2, REQ-M20) ─
{
  const ws = "/ws/student";
  const adultBrowser = [
    "Read", "Grep", "Glob", "Write", "Edit",
    MCP_BROWSER_OPEN, MCP_BROWSER_SCREENSHOT, MCP_LIVE_PREVIEW_START,
  ];
  const evalTool = (toolName, input, permittedTools) =>
    evaluateSdkToolUse({ toolName, input, permittedTools, workspaceRoot: ws });

  // Not granted (chat-only / no browser opt-in) → deny with a logged reason.
  for (const name of [MCP_BROWSER_OPEN, MCP_BROWSER_SCREENSHOT, MCP_LIVE_PREVIEW_START]) {
    const v = evalTool(name, {}, ["Read", "Grep", "Glob"]);
    assert.equal(v.decision, "deny", `${name} denied when the profile did not grant browser`);
    assert.ok(v.reason.length > 0 && v.friendly.length > 0);
  }

  // browser_open is an OUTWARD action → always "ask" (the approval modal),
  // after the URL policy (the same safeNavigateUrl whitelist as #278).
  assert.deepEqual(
    evalTool(MCP_BROWSER_OPEN, { url: "https://example.com" }, adultBrowser),
    { decision: "ask" },
    "granted browser_open with a policy-clean URL → modal, never auto-run",
  );
  assert.deepEqual(evalTool(MCP_BROWSER_OPEN, { url: "localhost:5173" }, adultBrowser), { decision: "ask" });

  // URL policy rejections — hostile schemes and ambiguous inputs are denied
  // BEFORE any modal (the student never sees an approvable hostile action).
  for (const url of ["javascript:alert(1)", "vscode://settings", "data:text/html,hi", "/etc/passwd", ""]) {
    const v = evalTool(MCP_BROWSER_OPEN, { url }, adultBrowser);
    assert.equal(v.decision, "deny", `browser_open URL ${JSON.stringify(url)} must be denied by policy`);
  }
  assert.equal(evalTool(MCP_BROWSER_OPEN, {}, adultBrowser).decision, "deny", "missing url → deny");

  // Screenshot + live preview auto-allow once the browser capability is
  // granted — reading the student's own tab / serving their own workspace.
  assert.deepEqual(evalTool(MCP_BROWSER_SCREENSHOT, {}, adultBrowser), { decision: "allow" });
  assert.deepEqual(evalTool(MCP_LIVE_PREVIEW_START, {}, adultBrowser), { decision: "allow" });

  // Foreign MCP tools stay denied even for the widest cohort (gate 1), and a
  // permitted-but-unknown MCP name would fail closed (final deny).
  assert.equal(evalTool("mcp__github__create_pr", {}, adultBrowser).decision, "deny");
  assert.equal(
    evalTool("mcp__hypeproof__mystery", {}, [...adultBrowser, "mcp__hypeproof__mystery"]).decision,
    "deny",
    "an unclassified hypeproof MCP name fails closed even if the permitted set is polluted",
  );
}

// ─── sdkToolToActionRequest — browser_open maps to the openBrowser kind ──────
{
  const req = sdkToolToActionRequest({
    toolName: MCP_BROWSER_OPEN,
    input: { url: "https://example.com" },
  });
  assert.equal(req.kind, "openBrowser", "browser_open → openBrowser (modal-gated by default)");
  assert.ok(req.description.includes("https://example.com"), "modal shows the target URL");
  assert.deepEqual(req.payload, { url: "https://example.com" });

  // The other hypeproof MCP tools never reach the approval path (auto-allow),
  // but if one ever did, the unknown-tool fallback must fail closed to the
  // executeShell hard-deny tier.
  assert.equal(
    sdkToolToActionRequest({ toolName: MCP_BROWSER_SCREENSHOT, input: {} }).kind,
    "executeShell",
    "non-open browser MCP tools fail closed in the approval mapping",
  );
}

console.log("✓ #282: sdk-coach helpers — tool policy + SDK-tool→ActionRequest mapping + P2 policy matrix + browser MCP policy");
