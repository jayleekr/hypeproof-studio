// #282 — PURE mapping from a resolved cohort profile to Claude Agent SDK
// options, plus the SDK-tool → host-approval mapping. No `vscode`, no SDK
// import: safe to unit-test and typecheck standalone (extension pure/
// orchestration split convention).
//
// This encodes the pedagogy → runtime contract that lets us BUY the engine
// (Agent SDK) while KEEPING the moat: a cohort profile decides which tools the
// coach may touch, how bounded the loop is, and that every tool use passes the
// manual-approve gate. Nothing here calls a model. The gate itself embodies the
// verification_reflex / delegation_judgment assets (docs/seven-assets.md) — the
// student decides whether to delegate each consequential action to the coach.

// Type-only import — erased at build/strip time, so this file stays a leaf
// module that Node can run standalone in the smoke tests.
import type { Options as AgentSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ActionRequest, ResolvedProfile } from "./protocol";

export type AgentPermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

/** Subset of Claude Agent SDK `Options` we drive from a cohort profile. */
export interface AgentCoachOptions {
  /** The cohort system prompt (fetched from the worker /v1/profile prompt). */
  systemPrompt: string;
  /** Resolved model id (same alias the proxy path uses). */
  model: string;
  /**
   * Tools this cohort is permitted to use. Enforced inside `canUseTool` (deny
   * anything not listed) — NOT passed to the SDK `allowedTools`, because an
   * `allowedTools` entry auto-approves and bypasses `canUseTool` entirely. Empty
   * = chat-only.
   */
  permittedTools: string[];
  /**
   * Permission mode. We keep "default" (no auto-approvals) so every tool use
   * falls through to `canUseTool`, where the host modal gates it — that gate is
   * the pedagogy, not overhead. We never auto-approve for a cohort, and never
   * bypass for minors.
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

// Real worker `game.template_tier` values (worker/src/profiles/types.ts).
// Game tiers (kids-basic/kids-rich/teen/pro-3d) are kids/teen cohorts — guided,
// chat-only, minor bounds. The WORKSHOP tiers below are the professional
// adult cohorts whose deliverable IS a webapp the coach edits directly:
// "search-webapp" (보아치과 clinical workshop) and "website" (website-copyclone,
// 보아치과 원장 v2 — added in #273). Anything NOT in this set — including a tier
// we don't recognize or a missing field — is treated as a minor game cohort
// (fail closed). This is the single source of truth for both audience and
// file-tool eligibility; keep it in sync with types.ts (or, ideally, let the
// worker profile own the policy — see ADR 0003 / #283).
const WORKSHOP_TIERS = new Set(["search-webapp", "website"]);

/**
 * Whether this cohort is a minor/guided audience — used to tighten loop bounds.
 * Fails closed: an unknown or missing tier is treated as a minor cohort so the
 * strictest bounds apply.
 */
export function isMinorTier(profile: ResolvedProfile): boolean {
  const tier = profile.game?.template_tier ?? "";
  return !WORKSHOP_TIERS.has(tier);
}

/**
 * Which tools a cohort may use. Conservative and fail-closed by design:
 * - game/kids/teen cohorts get NO autonomous tools — parity with today's
 *   single-turn coach, guided by the panel.
 * - the professional workshop tiers (e.g. "search-webapp", the 보아치과
 *   direction) may read/write/edit the workspace so the coach edits the page
 *   directly instead of the client string-extracting a blob.
 * - WebSearch + WebFetch only where the cohort profile explicitly opted in
 *   (`tools.web_search`, sourced from the worker), matching the trust-tiering
 *   pedagogy. An unknown/missing tier grants nothing.
 */
export function permittedToolsFor(profile: ResolvedProfile): string[] {
  const tier = profile.game?.template_tier ?? "";
  const tools: string[] = [];
  if (WORKSHOP_TIERS.has(tier)) {
    tools.push("Read", "Write", "Edit");
  }
  if (profile.tools?.web_search === true) {
    // Web research = search (find sources) + fetch (open and read them). Granting
    // WebSearch without WebFetch is claude-code half — the coach can find a
    // reference URL but not read it. Both route through canUseTool (SEARCH_TOOLS
    // includes "webfetch") → approval modal, and minors never reach here (they
    // get []), so WebFetch lands only on adult workshop tiers.
    tools.push("WebSearch", "WebFetch");
  }
  return tools;
}

export function maxTurnsFor(profile: ResolvedProfile): number {
  return isMinorTier(profile) ? 6 : 20;
}

// ── Worker gateway env construction (#282 Phase 1, REQ-M6/M13) ──────────────
// The Agent SDK routes model calls to `${ANTHROPIC_BASE_URL}/v1/messages` and
// authenticates with `Authorization: Bearer ${ANTHROPIC_AUTH_TOKEN}`. Our
// worker gateway (worker/src/routes/messages.ts, #316) serves POST /v1/messages
// and verifies the SAME workshop tokens as /v1/chat/completions — the classroom
// Anthropic key never leaves the worker. These helpers are pure so the
// URL-derivation and no-local-API-key invariants are unit-testable.

/**
 * Derive the SDK's ANTHROPIC_BASE_URL from the extension's proxyUrl setting.
 * `hypeproofChat.proxyUrl` is the OpenAI-compat base ENDING IN /v1 (e.g.
 * "https://api.hypeproof-ai.xyz/v1"); the SDK appends "/v1/messages" itself,
 * so the /v1 suffix must be stripped or every call would hit /v1/v1/messages.
 */
export function anthropicBaseUrlFor(proxyUrl: string): string {
  let url = proxyUrl.trim().replace(/\/+$/, "");
  if (/\/v1$/i.test(url)) {
    url = url.slice(0, -"/v1".length).replace(/\/+$/, "");
  }
  return url;
}

/**
 * Build the subprocess env for the SDK. The TS SDK REPLACES the subprocess
 * env with `options.env` (it does not merge), so the caller's base env
 * (process.env) is spread to keep PATH/HOME, then:
 * - ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN route auth'd calls to the worker
 *   gateway (the workshop token IS the credential — REQ-M6);
 * - ambient Anthropic credentials/provider switches are scrubbed so a dev
 *   machine's ANTHROPIC_API_KEY (which outranks AUTH_TOKEN) or a Bedrock/
 *   Vertex switch can never bypass the gateway. No local API key is ever
 *   required or honored on this path (REQ-M13).
 */
export function buildSdkGatewayEnv(
  baseEnv: Record<string, string | undefined>,
  args: { proxyUrl: string; token: string },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv };
  // Scrub anything that could shadow the gateway routing or bearer token.
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  env.ANTHROPIC_BASE_URL = anthropicBaseUrlFor(args.proxyUrl);
  env.ANTHROPIC_AUTH_TOKEN = args.token;
  return env;
}

/**
 * Build the SDK `query()` options for a gateway-routed coach turn — everything
 * EXCEPT the two host-bound fields (canUseTool, abortController), which the
 * orchestration layer (sdkCoach.ts) attaches. Pure and total so the full
 * option/env threading is locked by unit tests (REQ-M5/M6/M13):
 * - allowedTools stays [] (every tool falls through to canUseTool);
 * - settingSources stays [] (workspace settings can't inject allow-rules);
 * - env comes from buildSdkGatewayEnv (base-URL derivation + key scrub).
 */
export function buildSdkQueryOptions(
  agent: AgentCoachOptions,
  args: {
    proxyUrl: string;
    token: string;
    cwd?: string;
    baseEnv: Record<string, string | undefined>;
  },
): Omit<AgentSdkOptions, "canUseTool" | "abortController"> {
  return {
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    allowedTools: [],
    settingSources: [],
    permissionMode: agent.permissionMode,
    maxTurns: agent.maxTurns,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    env: buildSdkGatewayEnv(args.baseEnv, {
      proxyUrl: args.proxyUrl,
      token: args.token,
    }),
  };
}

/**
 * True for an AbortError from EITHER runtime. The proxy path's fetch abort raises
 * a DOMException with name "AbortError"; the SDK path throws an Error with the
 * same name (see sdkCoach `abortError()`). Both runtimes surface a user-initiated
 * stop identically, so the panel can (a) skip committing the truncated turn and
 * (b) suppress the error banner — matching the pre-#282 proxy behavior on stop,
 * minus the stray banner (a bugfix). Pure + exported so this parity is locked by
 * a smoke test rather than resting on manual stop repro.
 */
export function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "AbortError"
  );
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
    permittedTools: permittedToolsFor(profile),
    // Always gate. Minors and adults alike route every tool use through the
    // manual-approve modal — the gate is the lesson.
    permissionMode: "default",
    maxTurns: maxTurnsFor(profile),
  };
}

// ── SDK tool call → host ActionRequest ──────────────────────────────────────
// The Agent SDK sends CamelCase tool names ("Bash"/"Write"/"WebSearch") with a
// structured input object; resolveActionApproval keys its safety tiers on our
// own `kind` vocabulary and a real filesystem path. Getting this mapping right
// is what makes the executeShell hard-deny and the writeFile workspace-scope
// check actually fire — a wrong mapping silently defeats both.

const SHELL_TOOLS = new Set(["bash", "shell", "run"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);
const READ_TOOLS = new Set(["read", "glob", "grep", "ls"]);
const SEARCH_TOOLS = new Set(["websearch", "webfetch"]);

/** A tool action the coach wants to perform, surfaced to the host modal. */
export interface CoachToolAction {
  /** Raw Agent SDK tool name, e.g. "Bash", "Write", "WebSearch". */
  toolName: string;
  /** Raw tool input object as given by the SDK. */
  input: unknown;
}

function firstString(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function safeStringify(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}

/**
 * Map an Agent SDK tool call → the host ActionRequest (minus requestId, which
 * the caller stamps). Unknown tools fail closed: classified as `executeShell`
 * so the Tier-1 hard-deny refuses them rather than letting them slip through as
 * allow-by-default.
 */
export function sdkToolToActionRequest(action: CoachToolAction): Omit<ActionRequest, "requestId"> {
  const name = action.toolName.toLowerCase();

  if (SHELL_TOOLS.has(name)) {
    const command = firstString(action.input, ["command"]) ?? safeStringify(action.input);
    return { kind: "executeShell", description: `${action.toolName}: ${command}`, payload: { command } };
  }
  if (WRITE_TOOLS.has(name)) {
    const path = firstString(action.input, ["file_path", "path", "notebook_path"]);
    return {
      kind: "writeFile",
      description: path ? `${action.toolName} ${path}` : `${action.toolName} ${safeStringify(action.input)}`,
      payload: { path },
    };
  }
  if (READ_TOOLS.has(name)) {
    const path = firstString(action.input, ["file_path", "path", "pattern"]);
    return {
      kind: "readFile",
      description: path ? `${action.toolName} ${path}` : action.toolName,
      payload: { path },
    };
  }
  if (SEARCH_TOOLS.has(name)) {
    const query = firstString(action.input, ["query", "url"]) ?? "";
    return { kind: "webSearch", description: `${action.toolName} ${query}`.trim(), payload: { query } };
  }
  // Unknown tool — fail closed via the shell hard-deny tier.
  return {
    kind: "executeShell",
    description: `${action.toolName} (unrecognized): ${safeStringify(action.input)}`,
    payload: { raw: action.input },
  };
}
