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
import type {
  AgentDefinition,
  Options as AgentSdkOptions,
} from "@anthropic-ai/claude-agent-sdk";
import * as path from "node:path";
// Explicit .ts specifiers: the leaf/pure-module graph must load under
// `node --experimental-strip-types` (smoke tests) which resolves specifiers
// literally; esbuild + tsc (allowImportingTsExtensions) accept them.
import { safeNavigateUrl } from "./browserControlHelpers.ts";
import {
  MCP_BROWSER_OPEN,
  MCP_BROWSER_SCREENSHOT,
  MCP_BROWSER_TOOLS,
  MCP_LIVE_PREVIEW_START,
} from "./browserMcp.ts";
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
   * In-process MCP tools this cohort may use (#282 P2 slice 2) — the
   * `mcp__hypeproof__*` browser tools when `sdk_tools.browser` is granted.
   * Kept SEPARATE from `permittedTools` because SDK `Options.tools` is the
   * BUILT-IN base tool set only; MCP tools arrive via `mcpServers`, which the
   * orchestration layer registers exactly when this list is non-empty. Every
   * call still routes through canUseTool. Empty = no browser MCP.
   */
  permittedMcpTools: string[];
  /**
   * SDK subagent-invocation tool names this cohort may use (#282 P2 slice 3)
   * — ["Task", "Agent"] when `sdk_tools.subagents` is granted, [] otherwise.
   * Non-empty ⇒ buildSdkQueryOptions attaches the 코드리뷰어/리서처
   * AgentDefinitions (tools = intersection with `permittedTools`). Every
   * delegation AND every subagent tool call still routes through canUseTool
   * (sdk.d.ts CanUseTool carries `agentID` for sub-agent-context calls).
   */
  permittedAgentTools: string[];
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
// minor bounds. The WORKSHOP tiers below are the professional adult cohorts:
// "search-webapp" (보아치과 clinical workshop) and "website" (website-copyclone,
// 보아치과 원장 v2 — added in #273). Anything NOT in this set — including a tier
// we don't recognize or a missing field — is treated as a minor game cohort
// (fail closed). Since #282 Phase 2 the tier drives AUDIENCE bounds only
// (maxTurns + the minor write-strip); file-tool eligibility is owned by the
// worker profile's `sdk_tools` (ADR 0003). Keep in sync with types.ts.
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

// #282 Phase 2 — exact Agent SDK tool names granted per sdk_tools flag. These
// are the SDK's CamelCase built-in tool names (sdk.d.ts `Options.tools`).
// There is deliberately no shell mapping: no profile flag can grant Bash.
const SDK_READ_TOOL_NAMES = ["Read", "Grep", "Glob"] as const;
const SDK_WRITE_TOOL_NAMES = ["Write", "Edit"] as const;

/**
 * Which tools a cohort may use. Conservative and fail-closed by design:
 * - the WORKER PROFILE owns file-tool policy (`sdk_tools`, ADR 0003 / #282
 *   Phase 2): `read` → Read/Grep/Glob, `write` → Write/Edit. Absent flags
 *   grant nothing — a cohort with no `sdk_tools` is chat-only, and the client
 *   never infers tools from the tier anymore (the pre-Phase-2 tier heuristic
 *   is gone; the tier now only drives audience bounds like maxTurns).
 * - MINOR-SAFETY INVARIANT: write tools are stripped for minor tiers even if
 *   a profile mistakenly carries write:true — defense-in-depth on top of the
 *   worker harness's child_sdk_write FAIL. Minors never gain write capability.
 * - WebSearch + WebFetch only where the cohort profile explicitly opted in
 *   (`tools.web_search`, sourced from the worker), matching the trust-tiering
 *   pedagogy.
 */
export function permittedToolsFor(profile: ResolvedProfile): string[] {
  const tools: string[] = [];
  if (profile.sdk_tools?.read === true) {
    tools.push(...SDK_READ_TOOL_NAMES);
  }
  if (profile.sdk_tools?.write === true && !isMinorTier(profile)) {
    tools.push(...SDK_WRITE_TOOL_NAMES);
  }
  if (profile.tools?.web_search === true) {
    // Web research = search (find sources) + fetch (open and read them). Granting
    // WebSearch without WebFetch is claude-code half — the coach can find a
    // reference URL but not read it. Both route through canUseTool (SEARCH_TOOLS
    // includes "webfetch") → approval path. No minor cohort profile opts into
    // web_search today, so WebFetch lands only on adult workshop tiers — the
    // gate is the worker profile, same owner as sdk_tools.
    tools.push("WebSearch", "WebFetch");
  }
  return tools;
}

/**
 * Which in-process MCP tools a cohort may use (#282 P2 slice 2). Same
 * ownership and fail-closed posture as permittedToolsFor:
 * - the WORKER PROFILE owns the policy: `sdk_tools.browser === true` grants
 *   the three hypeproof browser tools as one unit. Absent/false → none.
 * - MINOR-SAFETY INVARIANT (#306/#318): minors get NO browser MCP tools until
 *   safe-session ships — stripped for minor tiers even if a profile
 *   mistakenly carries browser:true, defense-in-depth on top of the worker
 *   harness's child_sdk_browser FAIL. When in doubt, deny for minors.
 */
export function permittedMcpToolsFor(profile: ResolvedProfile): string[] {
  if (profile.sdk_tools?.browser === true && !isMinorTier(profile)) {
    return [...MCP_BROWSER_TOOLS];
  }
  return [];
}

// ── SDK subagents (#282 P2 slice 3, REQ-M22/M23) ─────────────────────────────
// Two READ-ONLY Korean subagents the coach can delegate to when the worker
// profile grants `sdk_tools.subagents` — the Delegation-judgment asset made
// concrete (docs/seven-assets.md §5): the coach proposes a delegation, the
// student approves it in a modal, a bounded specialist does the read-only work.
//
// canUseTool routing (load-bearing, verified against sdk.d.ts@0.3.207): a
// subagent's tool calls DO route through the PARENT query's canUseTool — the
// CanUseTool options carry `agentID?: string` ("If running within the context
// of a sub-agent, the sub-agent's ID."), so the same evaluateSdkToolUse policy
// matrix gates every subagent call. The definition-level `tools` allowlist is
// therefore defense in depth, not the only gate — but it is kept STRICT
// anyway: read-only wishlist, intersected with the cohort's permitted set.

/** The subagent-invocation tool. sdk.d.ts names it both ways across versions
 *  ("invoked via the Agent tool" / "via the Task tool"), so both names are
 *  granted/gated — the unregistered one is inert in `Options.tools`. */
export const SDK_AGENT_TOOL_NAMES = ["Task", "Agent"] as const;
const AGENT_TOOLS = new Set(["task", "agent"]);

export const SUBAGENT_CODE_REVIEWER = "코드리뷰어";
export const SUBAGENT_RESEARCHER = "리서처";

/** Base (pre-intersection) shape of a HypeProof subagent. */
export interface SubagentBaseDefinition {
  description: string;
  prompt: string;
  /** Read-only tool WISHLIST — intersected with the cohort's permitted set. */
  tools: readonly string[];
  maxTurns: number;
}

// Belt over suspenders: even if a base definition drifts, these can never be
// granted to a subagent. Mirrors the parent invariants (shell never grantable;
// this slice ships NO web tools and NO writes on subagents).
const SUBAGENT_DISALLOWED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebSearch",
  "WebFetch",
] as const;

/**
 * The read-only subagent catalog. Keys are the `subagent_type` values the
 * model uses AND the student-facing names in the delegation modal — Korean by
 * design. Wishlist tools are the read-only built-ins only; a definition that
 * drifts wider is clamped by buildSubagentDefinitions (intersection) and by
 * SUBAGENT_DISALLOWED_TOOLS.
 */
export const SUBAGENT_DEFINITIONS: Readonly<Record<string, SubagentBaseDefinition>> = {
  [SUBAGENT_CODE_REVIEWER]: {
    description:
      "참가자의 워크스페이스 파일(HTML/CSS/JS)을 읽고 코드 리뷰 피드백을 주는 읽기 전용 리뷰어. 코드를 고치지 않고 리뷰만 한다.",
    prompt: [
      "당신은 HypeProof Studio의 코드리뷰어입니다. 참가자(성인 워크숍)의 워크스페이스 파일을 읽고 리뷰합니다.",
      "",
      "규칙:",
      "- 읽기 전용입니다. 파일을 수정하거나 새로 만들지 않고, 리뷰 의견만 돌려줍니다.",
      "- 워크스페이스 안의 파일만 읽습니다.",
      "- 한국어 존댓말로, 친근하지만 전문적으로 씁니다. 참가자를 주눅 들게 하지 않되 실질적인 지적을 아끼지 않습니다.",
      "",
      "리뷰 형식:",
      "1. 잘한 점 — 구체적으로 2~3가지 (파일·부분을 짚어서)",
      "2. 개선점 — 중요한 순서로, 각 항목에 파일 경로와 이유를 함께",
      "3. 다음 한 걸음 — 지금 바로 시도할 수 있는 가장 작은 개선 1가지",
      "",
      "전체 코드를 다시 써 주지 말고, 바꿀 곳과 방향만 짚어 주세요 — 고치는 것은 참가자와 코치의 몫입니다.",
    ].join("\n"),
    tools: SDK_READ_TOOL_NAMES,
    maxTurns: 10,
  },
  [SUBAGENT_RESEARCHER]: {
    description:
      "워크스페이스 안의 문서(md/txt/html 등)를 읽고 정리·요약해 주는 읽기 전용 리서처. 웹에는 접근하지 않는다.",
    prompt: [
      "당신은 HypeProof Studio의 리서처입니다. 참가자의 워크스페이스 안 문서를 읽고 질문에 답합니다.",
      "",
      "규칙:",
      "- 읽기 전용입니다. 파일을 수정하지 않습니다.",
      "- 웹 검색·외부 자료 접근은 하지 않습니다. 근거는 오직 워크스페이스 안의 파일입니다.",
      "- 답할 때 근거가 된 파일 경로를 함께 적습니다.",
      "- 워크스페이스에서 근거를 찾지 못하면 지어내지 말고 '워크스페이스에서 찾을 수 없어요'라고 말합니다.",
      "- 한국어 존댓말로, 간결하고 구조적으로 정리합니다.",
    ].join("\n"),
    tools: SDK_READ_TOOL_NAMES,
    maxTurns: 10,
  },
};

/**
 * Which subagent-invocation tool names a cohort may use. Same ownership and
 * fail-closed posture as permittedToolsFor / permittedMcpToolsFor:
 * - the WORKER PROFILE owns the policy: `sdk_tools.subagents === true` grants
 *   the Agent/Task tool (and with it the read-only subagent catalog). Absent/
 *   false → none.
 * - MINOR-SAFETY INVARIANT: minors get NO subagents until a pedagogy decision
 *   lands — stripped for minor tiers even if a profile mistakenly carries
 *   subagents:true, defense-in-depth on top of the worker harness's
 *   child_sdk_subagents FAIL. When in doubt, deny for minors.
 */
export function permittedAgentToolsFor(profile: ResolvedProfile): string[] {
  if (profile.sdk_tools?.subagents === true && !isMinorTier(profile)) {
    return [...SDK_AGENT_TOOL_NAMES];
  }
  return [];
}

/**
 * Materialize the SDK `agents` option from the base catalog: each subagent's
 * `tools` is the INTERSECTION of its read-only wishlist and the cohort's
 * permitted set — a read-only cohort's 코드리뷰어 can never Write even if a
 * definition drifts, and a chat-only cohort's subagents get `tools: []`.
 * `tools` is ALWAYS set explicitly (possibly empty): omitting it would inherit
 * ALL tools from the parent (sdk.d.ts AgentDefinition.tools — "If omitted,
 * inherits all tools from parent"), which is exactly the widening this
 * function exists to prevent. `disallowedTools` is the second belt.
 */
export function buildSubagentDefinitions(
  permittedTools: readonly string[],
  defs: Readonly<Record<string, SubagentBaseDefinition>> = SUBAGENT_DEFINITIONS,
): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {};
  for (const [name, def] of Object.entries(defs)) {
    out[name] = {
      description: def.description,
      prompt: def.prompt,
      tools: def.tools.filter((t) => permittedTools.includes(t)),
      disallowedTools: [...SUBAGENT_DISALLOWED_TOOLS],
      // model omitted → inherit the main (gateway-clamped) model.
      maxTurns: def.maxTurns,
    };
  }
  return out;
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
 * option/env threading is locked by unit tests (REQ-M5/M6/M13/M16):
 * - `tools` = the cohort's permitted set (profile.sdk_tools → SDK tool names):
 *   tools NOT granted by the profile are removed from the model's context
 *   entirely — a chat-only cohort runs with `tools: []`, so Bash & co never
 *   even exist for the model. Availability only; approval is NOT implied.
 * - allowedTools stays [] — an allowedTools entry AUTO-APPROVES and bypasses
 *   canUseTool (sdk.d.ts: "auto-allowed without prompting"), which would
 *   defeat the manual-approve modal. Every surviving tool call falls through
 *   to canUseTool where evaluateSdkToolUse enforces the policy matrix;
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
  // #282 P2 slice 3 — the read-only subagent catalog rides on the same flag
  // that grants the Agent/Task invoker. Definition tools are the intersection
  // with the cohort's permitted set (buildSubagentDefinitions); no grant → no
  // `agents` key at all, so the model never sees a subagent.
  const agents =
    agent.permittedAgentTools.length > 0
      ? buildSubagentDefinitions(agent.permittedTools)
      : undefined;
  return {
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    // Built-in base tool set ONLY — the mcp__hypeproof__* names never go here
    // (REQ-M19): Options.tools filters BUILT-INS; MCP tools are delivered via
    // mcpServers, which the orchestration layer attaches (host-bound instance)
    // exactly when the profile grants them. The Agent/Task invoker IS a
    // built-in, so it joins the base set only when the profile grants
    // subagents (REQ-M22).
    tools: [...agent.permittedTools, ...agent.permittedAgentTools],
    ...(agents ? { agents } : {}),
    allowedTools: [],
    settingSources: [],
    // #282 P2 slice 2 — only the mcpServers WE pass exist: project .mcp.json,
    // user settings, and plugin MCP configs are ignored, so no ambient config
    // can add tools behind the cohort profile's back.
    strictMcpConfig: true,
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
    permittedMcpTools: permittedMcpToolsFor(profile),
    permittedAgentTools: permittedAgentToolsFor(profile),
    // Always gate. Minors and adults alike route every tool use through the
    // manual-approve modal — the gate is the lesson.
    permissionMode: "default",
    maxTurns: maxTurnsFor(profile),
  };
}

// ── SDK stream consumption + gateway 4xx fast-fail (#320, REQ-M15) ──────────
// e2e finding: the SDK CLI retries 401/400 responses up to 10x with backoff —
// a bad/expired workshop token turned into a multi-minute SILENT hang for a
// kid. The retry attempts surface in the SDK message stream as
// `{type:"system", subtype:"api_retry", error_status, ...}` events (the e2e
// proved error_status:401 rides on them), so the loop can fast-fail on the
// FIRST such event instead of waiting out the backoff schedule.

/**
 * Gateway statuses that can never succeed by retrying on this path: the
 * workshop token is the only credential, so a 401 (rejected/expired token)
 * or 400 (request the gateway refuses outright) will fail all 10 retries
 * identically. 403 is NOT here — the worker uses it for session-window/roster
 * states that the SDK doesn't retry (they surface as a terminal error), and
 * 5xx/429/529 stay retryable (the SDK's backoff is the right behavior there).
 */
export const SDK_FATAL_AUTH_STATUSES: ReadonlySet<number> = new Set([400, 401]);

/**
 * If this SDK stream event is an api_retry carrying a fatal auth-ish status
 * (400/401), return that status; otherwise null (keep consuming the stream).
 * `error_status` is null for connection errors — those stay retryable.
 */
export function sdkFatalAuthStatus(msg: Record<string, unknown>): number | null {
  if (msg["type"] !== "system" || msg["subtype"] !== "api_retry") return null;
  const status = msg["error_status"];
  return typeof status === "number" && SDK_FATAL_AUTH_STATUSES.has(status) ? status : null;
}

/** Best-effort text extraction across candidate SDK message shapes. */
export function extractSdkText(msg: Record<string, unknown>): string {
  const direct = msg["text"];
  if (typeof direct === "string") return direct;
  const delta = msg["delta"] as Record<string, unknown> | undefined;
  if (delta && typeof delta["text"] === "string") return delta["text"] as string;
  const message = msg["message"] as Record<string, unknown> | undefined;
  const content = message?.["content"];
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string" ? (b as Record<string, unknown>).text : ""))
      .join("");
  }
  return "";
}

/**
 * Error/abort construction is injected so this stays a leaf module (no import
 * of proxyClient's error classes → still loadable standalone by smoke tests).
 * sdkCoach.ts wires makeFatalAuthError to ProxyAuthError with the SAME Korean
 * token copy the proxy path uses (TOKEN_EXPIRED_FRIENDLY, REQ-B5).
 */
export interface SdkStreamHandlers {
  /** The caller's (user-stop) abort signal state. */
  isAborted: () => boolean;
  /** Build the AbortError thrown on user stop (proxy-path parity, REQ-M8). */
  makeAbortError: () => Error;
  /** Abort the SDK query (its AbortController) so the CLI stops retrying NOW. */
  abortQuery: () => void;
  /** Build the student-friendly auth error thrown on a fatal 400/401. */
  makeFatalAuthError: (status: number) => Error;
  onDelta: (delta: string) => void;
}

/**
 * Consume one SDK coach turn's message stream. Pure and injected so the
 * fast-fail contract is locked by unit tests: on the FIRST api_retry event
 * with error_status 400/401 the query is aborted and the auth error thrown —
 * within one event, no further stream consumption, no minutes-long backoff.
 */
export async function consumeSdkStream(
  stream: AsyncIterable<unknown>,
  h: SdkStreamHandlers,
): Promise<void> {
  for await (const raw of stream) {
    // Check BEFORE emitting so a chunk isn't flushed to the webview after stop.
    if (h.isAborted()) throw h.makeAbortError();
    const msg = (raw ?? {}) as Record<string, unknown>;
    const fatal = sdkFatalAuthStatus(msg);
    if (fatal !== null) {
      // Kill the subprocess's retry loop first, then surface the token error.
      h.abortQuery();
      throw h.makeFatalAuthError(fatal);
    }
    const type = String(msg["type"] ?? "");
    if (type === "assistant" || type === "text" || type === "content_block_delta") {
      const delta = extractSdkText(msg);
      if (delta) h.onDelta(delta);
    }
    // Other message types (result / message_stop) are terminal — nothing to
    // emit; the caller posts streamEnd.
  }
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

  // #282 P2 slice 2 — browser_open is the only hypeproof MCP tool that reaches
  // the approval path ("ask"); it maps to its own kind so resolveActionApproval
  // modal-gates it by default (requireApprovalFor includes "openBrowser").
  // Screenshot/live-preview auto-allow in evaluateSdkToolUse and never get here.
  if (action.toolName === MCP_BROWSER_OPEN) {
    const url = firstString(action.input, ["url"]) ?? "";
    return {
      kind: "openBrowser",
      description: `브라우저 열기: ${url || safeStringify(action.input)}`,
      payload: { url },
    };
  }

  // #282 P2 slice 3 — the Agent/Task tool: the coach wants to delegate to a
  // subagent (코드리뷰어/리서처). Own kind so resolveActionApproval modal-gates
  // it by default — the student consciously decides the delegation
  // (delegation_judgment, docs/seven-assets.md §5).
  if (AGENT_TOOLS.has(name)) {
    const subagent = firstString(action.input, ["subagent_type"]) ?? "";
    const task =
      firstString(action.input, ["description", "prompt"]) ?? safeStringify(action.input);
    return {
      kind: "delegateAgent",
      description: `${subagent || "서브에이전트"}에게 위임: ${task}`,
      payload: { subagent, task },
    };
  }

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

// ── canUseTool policy matrix (#282 Phase 2, REQ-M16/M17) ─────────────────────
// Pure decision function the orchestration layer (sdkCoach.ts canUseTool) runs
// on EVERY tool call. Three verdicts:
//   allow — read tools whose target stays inside the workspace: auto-run, no
//           modal (a read-only look at the student's own folder is the coach
//           "seeing the page", not a consequential delegation); also the
//           granted browser MCP screenshot/live-preview tools (#282 P2 s2 —
//           the coach looking at the student's own tab/workspace);
//   ask   — write tools (always — the approve/deny modal IS the
//           delegation_judgment / verification_reflex pedagogy), the
//           web-research tools (existing modal tiers decide), and
//           browser_open (outward action → modal, after the URL policy);
//   deny  — anything not granted by the cohort profile (Bash, WebFetch without
//           opt-in, unknown/foreign MCP tools), any path escaping the
//           workspace (`../` traversal, absolute paths outside cwd), and any
//           browser_open URL the safeNavigateUrl policy rejects. Deny reasons
//           are logged host-side; the student sees the Korean `friendly` line.

export type SdkToolVerdict =
  | { decision: "allow" }
  | { decision: "ask" }
  | { decision: "deny"; reason: string; friendly: string };

/** Student-facing copy for a policy deny (tool not granted / never grantable). */
export const TOOL_DENIED_FRIENDLY = "이 도구는 지금 수업에서는 사용할 수 없어요.";
/** Student-facing copy for a workspace path-escape deny. */
export const PATH_ESCAPE_FRIENDLY = "작업 폴더 밖의 파일에는 접근할 수 없어요.";
/** Student-facing copy for a browser_open URL the policy rejects (#282 P2 slice 2). */
export const URL_POLICY_FRIENDLY = "이 주소는 열 수 없어요.";

/**
 * Is `target` inside `workspaceRoot`? Relative targets resolve AGAINST the
 * root (the SDK runs with cwd=workspace), then both sides are normalized so
 * `../` traversal and absolute paths outside the root are caught. Mirrors the
 * host-side isInsideWorkspace (#115) so the two containment checks agree.
 */
export function isPathContained(workspaceRoot: string, target: string): boolean {
  const root = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
  const rel = path.relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const PATH_INPUT_KEYS = ["file_path", "path", "notebook_path"] as const;

/**
 * Path-like strings a tool call wants to touch. Besides the explicit path
 * params, Glob's `pattern` doubles as a path when absolute or `..`-relative
 * ("/etc/**", "../secrets/*") — include it so a glob can't walk out of the
 * workspace. (Grep's `pattern` is a regex, never treated as a path.)
 */
function pathCandidates(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const rec = input as Record<string, unknown>;
  const out: string[] = [];
  for (const key of PATH_INPUT_KEYS) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) out.push(value);
  }
  const pattern = rec["pattern"];
  if (
    toolName.toLowerCase() === "glob" &&
    typeof pattern === "string" &&
    (path.isAbsolute(pattern) || pattern.startsWith(".."))
  ) {
    out.push(pattern);
  }
  return out;
}

/**
 * The #282 Phase 2 tool policy. `permittedTools` comes from the cohort profile
 * (permittedToolsFor — sdk_tools + web_search); the verdict never widens beyond
 * it. `workspaceRoot` is the SDK cwd; when absent (dev/test without a folder,
 * matching isInsideWorkspace's convention) containment is skipped — the
 * production path always has a workspace via ensureWorkspace().
 */
export function evaluateSdkToolUse(args: {
  toolName: string;
  input: unknown;
  permittedTools: readonly string[];
  workspaceRoot?: string;
}): SdkToolVerdict {
  const { toolName, input, permittedTools, workspaceRoot } = args;

  // Gate 1 — the profile's permitted set. Bash/WebFetch/anything not granted
  // dies here with a logged reason, even if the upstream model requests it.
  if (!permittedTools.includes(toolName)) {
    return {
      decision: "deny",
      reason: `tool "${toolName}" is not granted by the cohort profile`,
      friendly: TOOL_DENIED_FRIENDLY,
    };
  }

  const name = toolName.toLowerCase();

  // Gate 1b — belt over suspenders: shell can NEVER be permitted (no profile
  // flag exists for it in Phase 2), so deny even if a future permitted set
  // widens by mistake.
  if (SHELL_TOOLS.has(name)) {
    return {
      decision: "deny",
      reason: "shell execution is never granted (Phase 2 invariant)",
      friendly: TOOL_DENIED_FRIENDLY,
    };
  }

  // ── Agent/Task tool — subagent delegation (#282 P2 slice 3, REQ-M22) ──────
  // Grant already passed Gate 1 (profile opted in via sdk_tools.subagents and
  // the cohort is not a minor — permittedAgentToolsFor stripped it otherwise).
  if (AGENT_TOOLS.has(name)) {
    // Only OUR read-only catalog is delegable: an unknown/absent subagent_type
    // (a general-purpose agent, a hallucinated name) dies here, fail closed.
    const subagentType = firstString(input, ["subagent_type"]) ?? "";
    if (!Object.prototype.hasOwnProperty.call(SUBAGENT_DEFINITIONS, subagentType)) {
      return {
        decision: "deny",
        reason: `subagent_type "${subagentType || "(empty)"}" is not in the HypeProof subagent catalog`,
        friendly: TOOL_DENIED_FRIENDLY,
      };
    }
    // Delegation → ALWAYS the approval modal (kind "delegateAgent") — the
    // student's approve/deny IS the delegation_judgment pedagogy. The
    // subagent's own tool calls come back through this same function
    // (sdk.d.ts: CanUseTool options carry agentID for sub-agent context).
    return { decision: "ask" };
  }

  // ── hypeproof MCP browser tools (#282 P2 slice 2, REQ-M20) ────────────────
  // Grant already passed Gate 1 (profile opted in via sdk_tools.browser and
  // the cohort is not a minor — permittedMcpToolsFor stripped it otherwise).
  if (toolName === MCP_BROWSER_OPEN) {
    // URL policy: the SAME whitelist the #278 browser-control loop uses
    // (safeNavigateUrl) — http(s)/localhost/file only; javascript:, vscode:,
    // data:, bare local paths are rejected before any modal is shown.
    const url = firstString(input, ["url"]) ?? "";
    if (!safeNavigateUrl(url)) {
      return {
        decision: "deny",
        reason: `browser_open URL rejected by policy: ${url || "(empty)"}`,
        friendly: URL_POLICY_FRIENDLY,
      };
    }
    // Outward action → ALWAYS the approval modal (kind "openBrowser").
    return { decision: "ask" };
  }
  if (toolName === MCP_BROWSER_SCREENSHOT || toolName === MCP_LIVE_PREVIEW_START) {
    // Auto-allow once the browser capability is granted: a screenshot of the
    // student's own tab / serving their own workspace locally is the coach
    // "looking at the page", not an outward delegation.
    return { decision: "allow" };
  }

  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    // Gate 2 — workspace containment for every path the call names.
    if (workspaceRoot) {
      for (const candidate of pathCandidates(toolName, input)) {
        if (!isPathContained(workspaceRoot, candidate)) {
          return {
            decision: "deny",
            reason: `path escapes the workspace: ${candidate}`,
            friendly: PATH_ESCAPE_FRIENDLY,
          };
        }
      }
    }
    // Gate 3 — reads auto-allow inside the workspace; writes ALWAYS ask.
    return READ_TOOLS.has(name) ? { decision: "allow" } : { decision: "ask" };
  }

  // Web research (profile-opted): route through the host approval tiers.
  if (SEARCH_TOOLS.has(name)) return { decision: "ask" };

  // Permitted but unclassified — should be unreachable; fail closed.
  return {
    decision: "deny",
    reason: `unrecognized tool "${toolName}"`,
    friendly: TOOL_DENIED_FRIENDLY,
  };
}
