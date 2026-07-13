// #306 — pure helpers for the hardened native-browser session.
//
// The worker's /v1/profile response carries a per-cohort `browser_session`
// ({ mode, allowlist }). Minor cohorts send `mode: "safe"`. The host maps that
// to two VS Code settings the fork core patch reads
// (`hypeproof.browser.safeSession` + `hypeproof.browser.safeAllowlist`) so the
// integrated browser uses the locked-down `persist:hp-safe` Electron session.
//
// This module is vscode-free so it is Node-unit-testable (see
// extension-pure-orchestration-split); the actual settings write lives in the
// orchestration layer (chatPanelProvider) which owns the vscode API surface.

/** Minimal shape of the fields we read off a resolved profile. Kept structural
 *  so tests don't need the full ResolvedProfile type. */
export interface BrowserSafetyProfileLike {
  browser_session?: {
    mode?: string;
    allowlist?: unknown;
  } | null;
}

/** The two settings values the host applies for the active cohort. */
export interface BrowserSafetyConfig {
  /** `hypeproof.browser.safeSession` — true only for a `mode: "safe"` cohort. */
  safeSession: boolean;
  /** `hypeproof.browser.safeAllowlist` — the cohort's URL allowlist (safe only). */
  safeAllowlist: string[];
}

/**
 * Resolve the hardened-browser settings for a cohort profile.
 *
 * Fail-safe: anything other than an explicit `mode === "safe"` (including a
 * missing profile, missing field, or an unknown mode) yields `safeSession:false`
 * — i.e. the normal browser, which is the correct default for adult cohorts and
 * for older builds whose worker doesn't send the field yet.
 *
 * The allowlist is only surfaced for safe cohorts; non-string entries are
 * dropped so a malformed profile can never widen access.
 */
export function resolveBrowserSafety(
  profile: BrowserSafetyProfileLike | null | undefined,
): BrowserSafetyConfig {
  const safe = profile?.browser_session?.mode === "safe";
  if (!safe) {
    return { safeSession: false, safeAllowlist: [] };
  }
  const raw = profile?.browser_session?.allowlist;
  const safeAllowlist = Array.isArray(raw)
    ? raw.filter((e): e is string => typeof e === "string" && e.length > 0)
    : [];
  return { safeSession: true, safeAllowlist };
}
