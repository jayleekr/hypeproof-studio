// Phase-0 spike (#282) — PURE mapping from a resolved cohort profile to
// Claude Agent SDK options. No `vscode`, no SDK import: safe to unit-test and
// typecheck standalone (extension pure/orchestration split convention).
//
// This encodes the pedagogy → runtime contract that lets us BUY the engine
// (Agent SDK) while KEEPING the moat: a cohort profile decides which tools the
// coach may touch, how bounded the loop is, and that every tool use passes the
// manual-approve gate. Nothing here calls a model.

import type { ResolvedProfile } from "./protocol";

export type AgentPermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

/** Subset of Claude Agent SDK `Options` we drive from a cohort profile. */
export interface AgentCoachOptions {
  /** The cohort system prompt (fetched from the worker /v1/profile prompt). */
  systemPrompt: string;
  /** Resolved model id (same alias the proxy path uses). */
  model: string;
  /** Tools the coach is allowed to invoke this cohort. Empty = chat-only. */
  allowedTools: string[];
  /**
   * Permission mode. We deliberately keep "default" so EVERY tool use is
   * gated — that gate is the pedagogy (essence #16 소격하기), not overhead.
   * We never auto-approve for a cohort, and never bypass for minors.
   */
  permissionMode: AgentPermissionMode;
  /** Hard turn cap so a beginner's loop stays bounded. */
  maxTurns: number;
}

export interface ProfileToAgentCtx {
  model: string;
  /** Cohort system prompt text (the tuned Korean coaching script). */
  systemPrompt: string;
}

/** kids-* game tiers denote a minor audience; used only to tighten bounds. */
export function isMinorTier(profile: ResolvedProfile): boolean {
  const tier = profile.game?.template_tier ?? "";
  return tier.startsWith("kids");
}

/**
 * Which tools a cohort may use. Conservative by design:
 * - chat-only cohorts (kids game tiers) get NO autonomous tools — parity with
 *   today's single-turn coach, guided by the panel.
 * - website/pro cohorts (the dental-homepage direction) may read/write/edit the
 *   workspace file so the coach edits `index.html` directly instead of the
 *   client string-extracting a blob.
 * - WebSearch only where the profile already surfaces citations (assets_focus
 *   includes verification), matching the existing trust-tiering pedagogy.
 */
export function allowedToolsFor(profile: ResolvedProfile): string[] {
  const tools: string[] = [];
  const tier = profile.game?.template_tier ?? "";
  const websiteLike = tier === "" || tier.startsWith("website") || tier.startsWith("pro");
  if (websiteLike && !isMinorTier(profile)) {
    tools.push("Read", "Write", "Edit");
  }
  if ((profile.assets_focus ?? []).includes("verification")) {
    tools.push("WebSearch");
  }
  return tools;
}

export function maxTurnsFor(profile: ResolvedProfile): number {
  return isMinorTier(profile) ? 6 : 20;
}

/**
 * Map a resolved cohort profile → Agent SDK coach options. Pure and total.
 */
export function profileToAgentOptions(
  profile: ResolvedProfile,
  ctx: ProfileToAgentCtx,
): AgentCoachOptions {
  return {
    systemPrompt: ctx.systemPrompt,
    model: ctx.model,
    allowedTools: allowedToolsFor(profile),
    // Always gate. Minors and adults alike route every tool use through the
    // manual-approve modal — the gate is the lesson.
    permissionMode: "default",
    maxTurns: maxTurnsFor(profile),
  };
}
