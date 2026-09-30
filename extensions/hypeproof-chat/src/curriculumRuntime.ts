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

export const CR_CONTEXT_KEY = "hypeproof-chat.curriculumRuntimeEnabled";

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
  /** Worker routes as `METHOD /path`. `cr-browser` adds none. */
  workerRoutes: readonly string[];
}

export const CR_SURFACES: CrSurfaceInventory = {
  commands: ["hypeproof-chat.pickElement"],
  mcpTools: CR_BROWSER_TOOL_NAMES.map((n) => `mcp__hypeproof__${n}`),
  proxyTools: [...CR_BROWSER_TOOL_NAMES],
  webviewMessages: ["removeElementContext"],
  workerRoutes: [],
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
