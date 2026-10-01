// Curriculum Runtime switch (CR-02, recon R3). Pure and vscode-free.
//
// One flag, `curriculum_runtime.enabled`, served on the cohort profile by the Service
// (/v1/profile). Absent or anything but `true` is off. The App mirrors it to the context
// key below so `package.json` can hide and disable CR commands, and every CR command
// handler re-checks the served profile, because a command can be executed without its
// menu. No setting, environment variable or build flag turns it on.
//
// `CR_SURFACES` is the CR-T02 switch-off inventory: every CR command, MCP tool, proxy
// tool, webview message and Worker route. Each later `cr-*` item appends its own
// surfaces here, and `test/cr-switch.smoke.mjs` walks the whole list with the switch off
// and on. A surface that is not listed is not checked, so listing is not optional.
//
// One exception is listed too, under `switchOffWhileStored` (CR-02's carve-out, MC-27 and
// Jay's decision 6 "a delete action exists"): the command that deletes the browser-result
// bytes an earlier switch-on stored stays reachable with the switch off while the signed-in
// person has bytes stored, and is hidden when they have none. It shows nothing of the
// results, only a count. `manifestStoredOnlyProblems` checks it is gated on exactly that.

export const CR_CONTEXT_KEY = "hypeproof-chat.curriculumRuntimeEnabled";

/** Context key: the signed-in person has browser-result bytes stored (CR-10). Never the CR switch. */
export const CR_BYTES_CONTEXT_KEY = "hypeproof-chat.crBrowserBytesStored";

/** The five Experiment Browser tool names shared by both coach runtimes (CR-04, CR-06). */
export const CR_BROWSER_TOOL_NAMES = [
  "browser_observe",
  "browser_select",
  "browser_scroll",
  "browser_hover",
  "browser_reload",
] as const;
export type CrBrowserToolName = (typeof CR_BROWSER_TOOL_NAMES)[number];

export const isCrBrowserTool = (name: string): name is CrBrowserToolName =>
  (CR_BROWSER_TOOL_NAMES as readonly string[]).includes(name);

/** The AI Verify tool names shared by both coach runtimes (cr-verify; CR-12–CR-16). */
export const CR_VERIFY_TOOL_NAMES = ["verify_criterion", "verify_propose_criteria"] as const;
export type CrVerifyToolName = (typeof CR_VERIFY_TOOL_NAMES)[number];

export const isCrVerifyTool = (name: string): name is CrVerifyToolName =>
  (CR_VERIFY_TOOL_NAMES as readonly string[]).includes(name);

/** Workshop tiers; mirrors WORKSHOP_TIERS in sdkCoachHelpers.ts and curriculumRuntimeAllowed in the Worker. */
const CR_TIERS = new Set(["search-webapp", "website"]);

/**
 * Is the switch on for this served profile? Anything but an explicit `true` is off.
 *
 * It is also the App's one minor test for every CR surface (the SDK grant, element pick,
 * the CR executor, the context key): off for a served `minor_cohort` (explicit flag or
 * age_range max < 18, computed by the Worker's isMinorCohort) and off unless the tier is
 * a workshop tier, fail-closed on an unknown or missing tier. The Worker serves the switch
 * through curriculumRuntimeAllowed, which also requires the audience's lower age bound to
 * be at least 18 (a mixed-age cohort is served the switch off); the App has no age range
 * on the served profile, so it relies on the served switch for that part.
 */
export function isCurriculumRuntimeEnabled(
  profile: { curriculum_runtime?: { enabled?: unknown } | null; minor_cohort?: unknown; game?: { template_tier?: unknown } | null } | null | undefined,
): boolean {
  if (profile?.curriculum_runtime?.enabled !== true) return false;
  if (profile.minor_cohort === true) return false;
  return CR_TIERS.has(String(profile.game?.template_tier ?? ""));
}

export interface CrSurfaceInventory {
  /** VS Code command ids contributed by package.json. */
  commands: readonly string[];
  /** Full SDK MCP tool names (`mcp__hypeproof__…`). */
  mcpTools: readonly string[];
  /** Proxy tool names the Worker injects (worker/src/lib/browser-tools.ts). */
  proxyTools: readonly string[];
  /** Webview → host message types that only exist for CR. */
  webviewMessages: readonly string[];
  /** Worker routes as `METHOD /path` (`<test-origin>` for the published runtime). `cr-browser` and `cr-verify` add none. */
  workerRoutes: readonly string[];
  /**
   * The allowed exception: commands that delete what an earlier switch-on stored. Shown
   * (switch on or off) only while CR_BYTES_CONTEXT_KEY is true, hidden otherwise.
   */
  switchOffWhileStored: readonly string[];
}

/** The published test runtime's routes, on a test origin (cr-publish; recon §6). */
export const CR_TEST_ORIGIN_ROUTE = "GET <test-origin>/l/:link/*";
/** The participant snippet opens the visit's session here, once (CR-21). */
export const CR_TEST_ORIGIN_SESSION_ROUTE = "POST <test-origin>/l/:link/__hp/session";
/** The participant snippet's events go here (cr-evidence; CR-23). */
export const CR_TEST_ORIGIN_EVENTS_ROUTE = "POST <test-origin>/l/:link/__hp/events";

export const CR_SURFACES: CrSurfaceInventory = {
  // cr-verify adds "Test my product" (CR-12); cr-publish adds "Publish for user test" (CR-17);
  // cr-evidence adds the experiment evidence panel (CR-24–CR-27, CR-69); cr-memory the Venture Memory panel (CR-35–CR-38).
  commands: ["hypeproof-chat.pickElement", "hypeproof-chat.browserResults", "hypeproof-chat.testMyProduct", "hypeproof-chat.publishTestVersion", "hypeproof-chat.experimentEvidence", "hypeproof-chat.ventureMemory"],
  mcpTools: [...CR_BROWSER_TOOL_NAMES, ...CR_VERIFY_TOOL_NAMES].map((n) => `mcp__hypeproof__${n}`),
  proxyTools: [...CR_BROWSER_TOOL_NAMES, ...CR_VERIFY_TOOL_NAMES],
  webviewMessages: ["removeElementContext", "verifyOpen", "verifyStart", "verifyRetest", "verifyFix", "publishOpen", "publishSubmit", "publishLink", "publishRevoke", "evidenceOpen", "evidenceNote", "evidenceDraft", "evidenceReview", "evidenceDelete", "memoryOpen", "memoryDiff", "memoryDecision"],
  // cr-verify adds no Worker route. cr-publish adds the Publish for User Test routes
  // (worker/src/routes/curriculum.ts `CURRICULUM_ROUTES`) and the test origin's.
  workerRoutes: [
    "GET /v1/curriculum/projects",
    "POST /v1/curriculum/projects",
    "GET /v1/curriculum/projects/:id",
    "PUT /v1/curriculum/projects/:id/members",
    "PUT /v1/curriculum/projects/:id/versions/:digest",
    "POST /v1/curriculum/experiments",
    "GET /v1/curriculum/experiments/:id/channels",
    "POST /v1/curriculum/experiments/:id/links",
    "POST /v1/curriculum/links/:id/revoke",
    CR_TEST_ORIGIN_ROUTE,
    CR_TEST_ORIGIN_SESSION_ROUTE,
    // cr-evidence: participant evidence, manual records, drafts, deletion, and the admin's cohort controls.
    "GET /v1/curriculum/experiments/:id/evidence",
    "POST /v1/curriculum/experiments/:id/notes",
    "POST /v1/curriculum/experiments/:id/drafts",
    "POST /v1/curriculum/experiments/:id/drafts/:draft/review",
    "DELETE /v1/curriculum/experiments/:id",
    "DELETE /v1/curriculum/experiments/:id/sessions/:sid",
    CR_TEST_ORIGIN_EVENTS_ROUTE,
    "GET /admin/curriculum/cohorts/:cohort/controls",
    "PUT /admin/curriculum/cohorts/:cohort/controls",
    // cr-memory: Venture Memory reads (member or in-scope director), the director's project list, and the team's writes.
    "GET /v1/curriculum/projects/:id/memory",
    "GET /v1/curriculum/projects/:id/memory/diff",
    "GET /v1/curriculum/director/projects",
    "PUT /v1/curriculum/projects/:id/problem",
    "POST /v1/curriculum/projects/:id/hypotheses",
    "POST /v1/curriculum/projects/:id/hypotheses/:hid/revisions",
    "POST /v1/curriculum/projects/:id/stakeholders",
    "POST /v1/curriculum/experiments/:id/stakeholder",
    "POST /v1/curriculum/projects/:id/metrics",
    "POST /v1/curriculum/projects/:id/decisions",
    "POST /v1/curriculum/decisions/:id/version",
    "PUT /v1/curriculum/projects/:id/slides/:n",
  ],
  switchOffWhileStored: ["hypeproof-chat.clearBrowserResultBytes"],
};

interface ManifestCommand {
  command?: string;
  enablement?: string;
}
interface ManifestMenuItem {
  command?: string;
  when?: string;
}
export interface ExtensionManifestLike {
  contributes?: {
    commands?: ManifestCommand[];
    menus?: Record<string, ManifestMenuItem[] | undefined>;
  };
}

/**
 * Which inventory commands the manifest would show or run with the switch off.
 *
 * A command passes only when its `enablement` requires the context key and every menu
 * entry for it (the command palette included, which needs an explicit entry) has a `when`
 * that requires it too. Returns the problems; empty means the manifest gates every one.
 */
export function manifestSwitchProblems(
  manifest: ExtensionManifestLike,
  commands: readonly string[] = CR_SURFACES.commands,
): string[] {
  const problems: string[] = [];
  const requiresKey = (expr: string | undefined): boolean => {
    if (!expr) return false;
    // The key must be a required conjunct: `a && key`, never `a || key` or `!key`.
    if (/\|\|/.test(expr)) return false;
    return expr
      .split("&&")
      .map((part) => part.trim())
      .some((part) => part === CR_CONTEXT_KEY);
  };
  const declared = manifest.contributes?.commands ?? [];
  const menus = manifest.contributes?.menus ?? {};
  for (const id of commands) {
    const cmd = declared.find((c) => c.command === id);
    if (!cmd) {
      problems.push(`${id}: not declared`);
      continue;
    }
    if (!requiresKey(cmd.enablement)) problems.push(`${id}: enablement does not require ${CR_CONTEXT_KEY}`);
    const palette = (menus.commandPalette ?? []).filter((m) => m.command === id);
    if (palette.length === 0) problems.push(`${id}: no commandPalette entry, so the palette shows it`);
    for (const [menu, items] of Object.entries(menus)) {
      for (const item of items ?? []) {
        if (item.command === id && !requiresKey(item.when)) problems.push(`${id}: ${menu} entry is visible with the switch off`);
      }
    }
  }
  return problems;
}

/**
 * Which `switchOffWhileStored` commands are not gated on exactly "bytes are stored": the
 * enablement and every menu entry (an explicit palette entry included) must be
 * CR_BYTES_CONTEXT_KEY alone, so the command is hidden when nothing is stored and never
 * shown by anything else. Empty means every one is gated.
 */
export function manifestStoredOnlyProblems(
  manifest: ExtensionManifestLike,
  commands: readonly string[] = CR_SURFACES.switchOffWhileStored,
): string[] {
  const problems: string[] = [];
  const exact = (expr: string | undefined) => expr?.trim() === CR_BYTES_CONTEXT_KEY;
  const declared = manifest.contributes?.commands ?? [];
  const menus = manifest.contributes?.menus ?? {};
  for (const id of commands) {
    const cmd = declared.find((c) => c.command === id);
    if (!cmd) {
      problems.push(`${id}: not declared`);
      continue;
    }
    if (!exact(cmd.enablement)) problems.push(`${id}: enablement is not ${CR_BYTES_CONTEXT_KEY}`);
    if (!(menus.commandPalette ?? []).some((m) => m.command === id)) problems.push(`${id}: no commandPalette entry, so the palette shows it`);
    for (const [menu, items] of Object.entries(menus)) {
      for (const item of items ?? []) {
        if (item.command === id && !exact(item.when)) problems.push(`${id}: ${menu} entry is not gated on ${CR_BYTES_CONTEXT_KEY}`);
      }
    }
  }
  return problems;
}
