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
import { safeNavigateUrl, isLoopbackUrl } from "./browserControlHelpers.ts";
import {
  MCP_BROWSER_OPEN,
  MCP_BROWSER_SCREENSHOT,
  MCP_BROWSER_TOOLS,
  MCP_BROWSER_READ,
  MCP_BROWSER_CLICK,
  MCP_BROWSER_TYPE,
  MCP_LIVE_PREVIEW_START,
} from "./browserMcp.ts";
import type { ActionRequest, ResolvedProfile } from "./protocol";
import { SDK_BINARY_MIN_BYTES, SDK_BINARY_VERSION } from "./sdkBinaryManifest.ts";
import { isDestructiveCommand } from "./shellPolicy.ts";

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
 * Tell the coach where it actually is (#428).
 *
 * Passing `systemPrompt` as a string REPLACES the SDK's default preamble, and
 * that preamble is what normally carries the working-directory env block — the
 * same block Claude Code itself injects. With `settingSources: []` on top (no
 * CLAUDE.md), the coach was left with zero knowledge of its own cwd while its
 * tools resolved against it correctly. Asked "내 워킹디렉토리 절대경로", it
 * listed the RIGHT files under an invented "/app/workdir".
 *
 * There is no shell to fall back on either — `permittedToolsFor` can never
 * grant Bash, so the coach cannot run `pwd` to recover. The path has to be
 * given, and it has to come from here: `cwd` is per-student (each cohort has
 * its own workspace_root under a different home dir), so it cannot live in the
 * worker's cohort prompt.
 */
export function withWorkspaceContext(
  systemPrompt: string,
  cwd?: string,
  /**
   * 워크스페이스에 지금 있는 파일들 (루트 기준 상대경로). 경로만 알려 주는 것으로는
   * 부족했다 — 2026-07-26 실측에서 코치는 cwd 를 받고도 `Glob` → `ls` → `find ~` 로
   * "여기 뭐가 있지"를 툴로 물었고, 한 턴의 151초 중 120초를 거기 썼다. Claude Code
   * 가 세션 시작에 디렉터리 구조를 미리 넣어 주는 것과 같은 이유다: **물어볼 필요가
   * 없으면 안 묻는다.** 코호트 워크스페이스는 파일이 몇 개 안 되므로 비용이 없다.
   */
  files?: readonly string[],
): string {
  if (!cwd) return systemPrompt;
  const listing =
    files === undefined
      ? ""
      : files.length === 0
        ? "Files: (비어 있음 — 아직 아무것도 만들지 않았다)\n"
        : `Files:\n${files.map((f) => `  ${f}`).join("\n")}\n`;
  return (
    systemPrompt +
    "\n\n<env>\n" +
    `Working directory (absolute): ${cwd}\n` +
    listing +
    "파일이나 폴더의 경로를 말할 때는 반드시 위 절대경로를 기준으로 답한다. 추측하거나 지어내지 않는다.\n" +
    "파일 도구(Read/Write/Edit)에는 **절대경로**를 넘긴다. 위 목록에 있는 파일을 찾으려고 탐색하지 않는다.\n" +
    "</env>"
  );
}

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
  // epic #431 — shell. Profile-gated only, no separate minor strip: a minor
  // cohort grants it by simply not setting the flag. Arbitrary commands are
  // intended; `evaluateSdkToolUse` routes every one of them to the approval
  // modal, and shellPolicy decides which ones additionally refuse to be
  // remembered by "항상 허용".
  if (profile.sdk_tools?.shell === true) {
    tools.push("Bash");
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

/**
 * 한 턴에 허용할 SDK 턴 수.
 *
 * 성인 20 은 **실측으로 부족함이 확인됐다** (2026-07-26): 멀티페이지 사이트를
 * 만드는 한 요청이 툴 54회를 썼고 두 번 연속 예산 소진으로 죽었다. #457 노트에
 * "지금 올리면 낭비를 감춘 채 넘어간다 — 다시 재본 뒤에 판단한다"고 미뤄 뒀던
 * 그 재측정이 그것이다.
 *
 * 낭비 쪽을 먼저 걷어냈다: 상대경로 흡수 + 워크스페이스 목록 주입으로 탐색이
 * 사라지고(한 턴의 80%), 탭 정리로 재확인이 줄었다. 그 위에서 60 으로 올린다.
 *
 * 60 은 **잠정값**이다. 고친 코드로 같은 시나리오를 다시 재기 전까지는 근거가
 * "54 를 봤으니 그보다 넉넉히" 수준이다. 재측정 후 조정한다.
 *
 * 미성년 6 은 건드리지 않는다 — 이건 성능이 아니라 대상 연령 경계다.
 */
export function maxTurnsFor(profile: ResolvedProfile): number {
  return isMinorTier(profile) ? 6 : 60;
}

// ── SDK native binary resolution (#282 W4a, docs/sdk-bundling.md §5) ─────────
// The Agent SDK spawns a vendored native `claude` CLI. Packaged Studio builds
// exclude node_modules, so the binary must be resolvable from OUTSIDE the app:
// the SDK checks `options.pathToClaudeCodeExecutable` FIRST, arbitrary path,
// no node_modules requirement (doc §2.1). Resolution order (REQ-M24):
//   1. explicit setting  — hypeproofChat.sdkBinaryPath (instructor/dev
//      override; used as-is if the file exists);
//   2. env override      — HPS_SDK_BINARY (e2e/CI seam; same contract);
//   3. seeded location   — the per-user dir scripts/seed-sdk-binary.sh
//      installs to, accepted ONLY when the seed-time integrity marker checks
//      out (isSeededBinaryTrusted);
//   4. node_modules      — dev environments: no explicit path is passed and
//      the SDK's own optionalDependency lookup runs;
//   5. none of the above — the orchestration layer throws SdkUnavailableError
//      and the caller falls back to the proxy coach (REQ-M7, unchanged).
// Everything here is pure (fs probes injected) so the order is unit-testable.

/**
 * THE single definition of where a seeded binary lives (the seed script and a
 * future in-app downloader must write to exactly this path):
 *   darwin — ~/Library/Application Support/HypeProof-Studio/sdk/<version>/claude
 *   win32  — %APPDATA%\HypeProof-Studio\sdk\<version>\claude.exe
 *   linux  — ${XDG_CONFIG_HOME:-~/.config}/HypeProof-Studio/sdk/<version>/claude
 * "HypeProof-Studio" matches the app's dataFolderName (branding-swap REQ-J3),
 * but the path is deliberately FIXED rather than derived from globalStorageUri
 * so the shell seeder and the extension agree without a running app, and dev
 * hosts (plain VS Code, data folder "Code") still find a seeded binary.
 * The binary is versioned per SDK release: a dependency bump changes the dir,
 * so a stale binary is simply never resolved (doc §6 "Version skew").
 */
export function seededSdkBinaryPath(args: {
  platform: string;
  homeDir: string;
  env?: Record<string, string | undefined>;
  version?: string;
}): string {
  const version = args.version ?? SDK_BINARY_VERSION;
  const env = args.env ?? {};
  if (args.platform === "win32") {
    const base = env.APPDATA && env.APPDATA.length > 0
      ? env.APPDATA
      : path.win32.join(args.homeDir, "AppData", "Roaming");
    return path.win32.join(base, "HypeProof-Studio", "sdk", version, "claude.exe");
  }
  if (args.platform === "darwin") {
    return path.posix.join(
      args.homeDir,
      "Library",
      "Application Support",
      "HypeProof-Studio",
      "sdk",
      version,
      "claude",
    );
  }
  // linux + anything else POSIX-ish (XDG convention).
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : path.posix.join(args.homeDir, ".config");
  return path.posix.join(base, "HypeProof-Studio", "sdk", version, "claude");
}

/** Seed-time integrity marker written next to the binary (same for .exe). */
export function sdkBinaryMarkerPath(binaryPath: string): string {
  return `${binaryPath}.verified.json`;
}

/** Contents of the `.verified.json` marker the seed script writes. */
export interface SdkBinaryMarker {
  sdkVersion: string;
  /** Byte size of the extracted binary, measured at seed time. */
  size: number;
  /** SRI sha512 of the TARBALL that was verified at seed time. */
  tarballSha512: string;
  verifiedAt?: string;
}

/** Parse + shape-validate a marker file's raw text. null = not trustable. */
export function parseSdkBinaryMarker(raw: string | null | undefined): SdkBinaryMarker | null {
  if (!raw) return null;
  try {
    // Strip a UTF-8 BOM before parsing. `seed-sdk-binary.ps1` runs under
    // Windows PowerShell 5.1 on venue machines, where `Out-File -Encoding utf8`
    // ALWAYS emits EF BB BF — and `JSON.parse` of a BOM-prefixed string throws. The marker
    // then read as "malformed", isSeededBinaryTrusted said no, and the seeded
    // claude.exe was never used: every Windows machine silently fell back to
    // the proxy-only runtime despite a correct, verified seed. The seeder now
    // writes BOM-less UTF-8, but this stays so machines seeded by an older
    // script are repaired by the update rather than needing a re-seed.
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    if (
      typeof parsed.sdkVersion !== "string" ||
      typeof parsed.size !== "number" ||
      !Number.isFinite(parsed.size) ||
      parsed.size <= 0 ||
      typeof parsed.tarballSha512 !== "string" ||
      !parsed.tarballSha512.startsWith("sha512-")
    ) {
      return null;
    }
    return {
      sdkVersion: parsed.sdkVersion,
      size: parsed.size,
      tarballSha512: parsed.tarballSha512,
      ...(typeof parsed.verifiedAt === "string" ? { verifiedAt: parsed.verifiedAt } : {}),
    };
  } catch {
    return null;
  }
}

/** What the fs probe reports about a candidate binary file. */
export interface SdkBinaryStat {
  exists: boolean;
  /** X_OK for the current user (on win32 the probe reports existence). */
  executable: boolean;
  /** Byte size; 0/absent when the file doesn't exist. */
  size: number;
}

/**
 * The W4a integrity gate for a SEEDED binary (never applied to the explicit
 * setting/env overrides — those are operator assertions). Cheap by design:
 * sha512 over ~229 MiB at every coach turn is too slow, so the full hash runs
 * ONCE at seed time (scripts/seed-sdk-binary.sh) and the runtime trusts
 * marker presence + exact size match + a coarse minimum floor. See the trust
 * model note in sdkBinaryManifest.ts.
 */
export function isSeededBinaryTrusted(args: {
  stat: SdkBinaryStat;
  markerRaw: string | null | undefined;
  /** Expected SDK version (defaults to the pinned manifest version). */
  version?: string;
  minBytes?: number;
}): { ok: true } | { ok: false; reason: string } {
  const version = args.version ?? SDK_BINARY_VERSION;
  const minBytes = args.minBytes ?? SDK_BINARY_MIN_BYTES;
  if (!args.stat.exists) return { ok: false, reason: "seeded binary not found" };
  if (!args.stat.executable) return { ok: false, reason: "seeded binary is not executable" };
  const marker = parseSdkBinaryMarker(args.markerRaw);
  if (!marker) return { ok: false, reason: "missing or malformed .verified.json marker" };
  if (marker.sdkVersion !== version) {
    return {
      ok: false,
      reason: `marker sdkVersion "${marker.sdkVersion}" does not match expected "${version}"`,
    };
  }
  if (args.stat.size !== marker.size) {
    return {
      ok: false,
      reason: `binary size ${args.stat.size} does not match seed-time size ${marker.size}`,
    };
  }
  if (args.stat.size < minBytes) {
    return { ok: false, reason: `binary size ${args.stat.size} below sanity floor ${minBytes}` };
  }
  return { ok: true };
}

export type SdkBinarySource = "setting" | "env" | "seeded" | "node-modules";

export type SdkBinaryResolution =
  | {
      available: true;
      source: SdkBinarySource;
      /**
       * Absolute path to pass as `pathToClaudeCodeExecutable`. Undefined for
       * source "node-modules": no override is passed and the SDK's own
       * optionalDependency lookup runs (dev behavior, unchanged).
       */
      path?: string;
    }
  | { available: false; reasons: string[] };

/** Injected candidates — the orchestration layer supplies real fs probes. */
export interface SdkBinaryCandidates {
  /** hypeproofChat.sdkBinaryPath setting (empty/undefined = unset). */
  settingPath?: string;
  /** HPS_SDK_BINARY env var (e2e/CI). */
  envPath?: string;
  /** Probe result for the seededSdkBinaryPath location. */
  seeded?: { path: string; stat: SdkBinaryStat; markerRaw: string | null };
  /** Whether the SDK platform package's binary resolves from node_modules. */
  nodeModulesAvailable: boolean;
  /** fs.existsSync seam for the setting/env candidates. */
  fileExists: (p: string) => boolean;
  version?: string;
}

/**
 * Resolve the claude binary per the REQ-M24 order. Pure: every probe is
 * injected. An unset/invalid higher-priority candidate FALLS THROUGH (with a
 * recorded reason) rather than failing the whole chain — a stale setting on a
 * dev machine must not disable the node_modules path.
 */
export function resolveSdkBinary(c: SdkBinaryCandidates): SdkBinaryResolution {
  const reasons: string[] = [];

  const setting = c.settingPath?.trim();
  if (setting) {
    if (c.fileExists(setting)) return { available: true, source: "setting", path: setting };
    reasons.push(`hypeproofChat.sdkBinaryPath is set but no file exists at ${setting}`);
  }

  const envPath = c.envPath?.trim();
  if (envPath) {
    if (c.fileExists(envPath)) return { available: true, source: "env", path: envPath };
    reasons.push(`HPS_SDK_BINARY is set but no file exists at ${envPath}`);
  }

  if (c.seeded) {
    const verdict = isSeededBinaryTrusted({
      stat: c.seeded.stat,
      markerRaw: c.seeded.markerRaw,
      version: c.version,
    });
    if (verdict.ok) return { available: true, source: "seeded", path: c.seeded.path };
    reasons.push(`seeded binary at ${c.seeded.path} rejected: ${verdict.reason}`);
  }

  if (c.nodeModulesAvailable) return { available: true, source: "node-modules" };
  reasons.push("no SDK platform binary in node_modules (packaged build?)");

  return { available: false, reasons };
}

// ── SDK JS module resolution (#282 W4b, docs/sdk-bundling.md §5 step 1) ──────
// W4a made the native `claude` BINARY resolvable outside node_modules. But the
// SDK JS itself (`sdk.mjs`) is still loaded via a variable-specifier dynamic
// import in sdkCoach.loadSdk — esbuild never bundles it, so a PACKAGED build
// (no node_modules) fails that import and falls back to the proxy coach even
// with a seeded binary (the W4b gap). W4b vendors the SDK JS + its runtime
// closure into the built-in under `dist/vendor/node_modules`, and loadSdk tries
// that copy first.
//
// Why UNDER dist/: scripts/inject-builtin-extensions.sh AND the fork's
// prepare_vscode.sh re-inject BOTH ship the extension by copying `dist/`
// wholesale (`cp -r dist`), so a vendor tree under dist/ rides along on both
// paths with NO vscodium-base change — exactly how the version stamp survives
// the re-inject by writing the SOURCE package.json.
//
// Why a real `node_modules` subtree: `sdk.mjs` is NOT self-contained — it
// `import`s `ajv/dist/runtime/*` and `ajv-formats/dist/formats` at runtime.
// Node resolves those bare specifiers by walking up from sdk.mjs, so the deps
// MUST sit in a sibling `node_modules` (the 229 MB platform binary packages are
// EXCLUDED — those reach students via the W4a seed, not the app bundle).
//
// These resolvers are pure (fileExists injected) so the path logic is unit-
// tested; sdkCoach supplies the real __dirname (the dist/ dir at runtime) + the
// fs probe. Absent vendor + absent node_modules is handled downstream: the
// import throws and loadSdk maps it to SdkUnavailableError → proxy fallback
// (REQ-M7, unchanged).

/** Bare npm specifier for the SDK — used for the dev (node_modules) path. */
export const SDK_JS_SPECIFIER = "@anthropic-ai/claude-agent-sdk";

/**
 * Vendored SDK entry, RELATIVE to the extension's dist/ dir (where the esbuild
 * CJS bundle runs → __dirname). `sdk.mjs` is the package `exports["."]` default;
 * its own `import "ajv/..."` resolves from the sibling vendor/node_modules tree.
 * scripts/inject-builtin-extensions.sh writes exactly this layout.
 */
export const VENDORED_SDK_ENTRY_SUBPATH = path.posix.join(
  "vendor",
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "sdk.mjs",
);

/**
 * Vendored zod ESM entry (zod v4 `exports["."].import` = ./index.js), RELATIVE
 * to dist/. Loaded by loadZod for the browser MCP tool input schemas; absent →
 * loadZod returns null and the coach runs browser-less (graceful).
 */
export const VENDORED_ZOD_ENTRY_SUBPATH = path.posix.join(
  "vendor",
  "node_modules",
  "zod",
  "index.js",
);

export type VendoredModuleResolution =
  | { source: "vendored"; entryPath: string }
  | { source: "node-modules"; specifier: string };

function resolveVendoredModule(
  subpath: string,
  specifier: string,
  distDir: string | undefined,
  fileExists: (p: string) => boolean,
): VendoredModuleResolution {
  if (distDir) {
    const entryPath = path.join(distDir, subpath);
    if (fileExists(entryPath)) return { source: "vendored", entryPath };
  }
  return { source: "node-modules", specifier };
}

/**
 * Resolve where to load the Agent SDK JS from: the vendored copy under
 * `<dist>/vendor` (packaged built-in) when present, else the bare specifier so
 * Node's own node_modules lookup runs (dev/standalone). No distDir (e.g. the
 * ESM smoke context where __dirname is undefined) also falls to the specifier.
 */
export function resolveSdkModule(args: {
  distDir?: string;
  fileExists: (p: string) => boolean;
  specifier?: string;
}): VendoredModuleResolution {
  return resolveVendoredModule(
    VENDORED_SDK_ENTRY_SUBPATH,
    args.specifier ?? SDK_JS_SPECIFIER,
    args.distDir,
    args.fileExists,
  );
}

/**
 * Same resolution for zod (the SDK's peer dep, needed only for the browser MCP
 * tool schemas): vendored copy → bare "zod" (dev) → (downstream) loadZod null.
 */
export function resolveZodModule(args: {
  distDir?: string;
  fileExists: (p: string) => boolean;
}): VendoredModuleResolution {
  return resolveVendoredModule(VENDORED_ZOD_ENTRY_SUBPATH, "zod", args.distDir, args.fileExists);
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
  args: {
    proxyUrl: string;
    token: string;
    /** 작업 폴더 절대경로 — 워커가 `x-hps-workspace` 로 받아 시스템 블록에 넣는다. */
    workspace?: string;
    /** 작업 폴더의 파일 목록 (루트 기준 상대). */
    workspaceFiles?: readonly string[];
    /** 동시 툴 실행 상한. 기본 2 — 병렬 권한 요청이 SDK 제어 채널을 끊는다. */
    maxToolConcurrency?: number;
  },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv };
  // Scrub anything that could shadow the gateway routing or bearer token.
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  env.ANTHROPIC_BASE_URL = anthropicBaseUrlFor(args.proxyUrl);
  env.ANTHROPIC_AUTH_TOKEN = args.token;

  // #431 — 동시 툴 실행을 묶는다.
  //
  // 2026-07-27 실측: 코치가 서브에이전트 4개를 **병렬로** 띄운 직후 모든 툴 호출이
  // `Tool permission request failed: Error: Stream closed` 로 무너졌다 — 한 턴에
  // 28건, 산출물 0. 같은 서브에이전트가 1개일 때는 멀쩡히 돌았다.
  //
  // 방아쇠는 서브에이전트 자체가 아니라 **동시성**으로 보인다. 그 전 빌드에서는
  // 툴마다 승인 모달이 떠서 사람이 하나씩 눌렀고, 그것이 우연히 직렬화 장치였다.
  // 승인을 자동 허용으로 바꾸자 권한 요청이 한꺼번에 쏟아졌다.
  //
  // 그래서 능력을 끄는 대신(subagents: false) 동시성만 제한한다. 병렬 수집의
  // 이점은 2개까지 남기고, 채널을 무너뜨리는 폭주는 막는다.
  env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = String(args.maxToolConcurrency ?? 2);

  // #431 — 작업 폴더를 **헤더로** 보낸다.
  //
  // 시스템 프롬프트에 붙이는 방법은 통하지 않는다: 워커가 클라이언트 `system` 을
  // 통째로 교체한다(주입 방지 설계). 그래서 #428·#457·07-26 세 번의 수정이 전부
  // 무력이었고, 코치는 SDK 경로에서 자기 작업 폴더를 한 번도 받은 적이 없다.
  //
  // 형식은 SDK 가 정한다 (vendor bridge.mjs 확인): `ANTHROPIC_CUSTOM_HEADERS` 를
  // 개행으로 나누고 각 줄을 첫 `:` 에서 이름/값으로 가른다. 따라서 값 안에 개행이
  // 있으면 안 되고 — 파일 목록의 구분자는 퍼센트 인코딩해서 넘긴다. 한글 폴더명도
  // 같은 이유로 인코딩이 필요하다(HTTP 헤더는 바이트 안전해야 한다).
  const custom: string[] = [];
  if (args.workspace?.trim()) {
    custom.push(`x-hps-workspace: ${encodeURIComponent(args.workspace.trim())}`);
  }
  if (args.workspaceFiles?.length) {
    custom.push(
      `x-hps-workspace-files: ${encodeURIComponent(args.workspaceFiles.slice(0, 80).join("\n"))}`,
    );
  }
  if (custom.length) {
    const existing = (env.ANTHROPIC_CUSTOM_HEADERS ?? "").trim();
    env.ANTHROPIC_CUSTOM_HEADERS = existing ? `${existing}\n${custom.join("\n")}` : custom.join("\n");
  }
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
    /**
     * #282 W4a — resolved native `claude` binary path (resolveSdkBinary:
     * setting > HPS_SDK_BINARY > seeded). When absent the option is OMITTED
     * so the SDK's own node_modules optionalDependency lookup runs (dev).
     */
    pathToClaudeCodeExecutable?: string;
    /** 워크스페이스 파일 목록 (루트 기준 상대). withWorkspaceContext 로 전달된다. */
    workspaceFiles?: readonly string[];
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
    systemPrompt: withWorkspaceContext(agent.systemPrompt, args.cwd, args.workspaceFiles),
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
    ...(args.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: args.pathToClaudeCodeExecutable }
      : {}),
    env: buildSdkGatewayEnv(args.baseEnv, {
      proxyUrl: args.proxyUrl,
      token: args.token,
      // 시스템 프롬프트 경로는 워커가 버리므로 헤더로 보낸다 (#431).
      ...(args.cwd ? { workspace: args.cwd } : {}),
      ...(args.workspaceFiles ? { workspaceFiles: args.workspaceFiles } : {}),
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

/** True for the SDK's retry tick (`{type:"system", subtype:"api_retry"}`). */
export function isSdkRetryEvent(msg: Record<string, unknown>): boolean {
  return msg["type"] === "system" && msg["subtype"] === "api_retry";
}

// ── First-token / idle stall watchdog (#403) ────────────────────────────────
// The 400/401 fast-fail above only covers the credential case. Everything else
// the gateway can answer with — 429 / 529 / 5xx / a dropped connection — the
// SDK CLI retries up to 10x with backoff, and a merely SLOW first turn (long
// cohort prompt + a heavy design brief) emits no stream events at all in the
// meantime. Both look identical to a student: "생각하는 중… ✨" forever, no
// error, no way out — observed 4/4 on the heavy-design-prompt runs. The proxy
// path at least terminates with a visible error, so the SDK consumer keeps its
// own deadline for parity.

/**
 * Silence budget (ms) before a turn is declared stalled. Measured from the last
 * PROGRESS event — an `api_retry` tick deliberately does NOT renew it, or a
 * backoff schedule would extend the budget forever, which is the exact hang
 * this catches.
 *
 * Calibrated against a REAL healthy turn, not guessed (2026-07-24, seeded SDK →
 * prod gateway, copyclone prompt, "make the homepage" brief):
 *   result: success · duration 286s · 4 turns · 87 stream events
 *   thinking → Write → thinking → Bash → Write → text
 *   longest silence between events ≈ 86s (long thinking stretches; the periodic
 *   `system/thinking_tokens` events are what break the silence)
 * A healthy turn is MINUTES long here, and 86s of it can be silent. The first
 * cut of this constant was 120s — barely 34s of headroom, i.e. a slightly
 * heavier page would have had the watchdog killing turns that were working.
 * 240s is ~3x the observed worst-case gap and still bounded, which is the whole
 * point: bounded-and-visible beats forever-and-silent.
 */
export const SDK_STREAM_STALL_MS = 240_000;

/**
 * Student-facing stall copy. Same register as the token copy (REQ-B5): says
 * what to do, never shows a technical reason. Retrying is the real recovery —
 * the aborted turn leaves no server-side state behind.
 */
export const SDK_STALL_FRIENDLY =
  "코치 응답이 너무 오래 걸려요. 다시 한 번 보내주세요. 🕐";

/**
 * 턴 예산을 다 썼을 때 학생이 보는 줄.
 *
 * 예전에는 SDK 가 낸 영어 한 줄(`Reached maximum number of turns (20)`)이 그대로
 * 나갔다. 참가자에게는 고장으로 보이고, 실제로 원장은 그 자리에서 두 번 멈췄다.
 * 여기서 중요한 것은 **이게 실패가 아니라 예산 소진**이라는 사실과, 지금까지 한
 * 일이 디스크에 남아 있다는 사실을 알려 주는 것이다.
 */
export const SDK_MAX_TURNS_FRIENDLY =
  "\n\n---\n\n한 번에 할 수 있는 작업량을 다 썼어요. **여기까지 한 것은 파일로 저장돼 있어요.** " +
  "이어서 하려면 무엇을 더 할지 알려주세요 — 예: `이어서 계속해줘` 🔧";

/** Sentinel for the watchdog leg of the stream/timer race. */
const STALLED = Symbol("sdk-stream-stalled");

// ── SDK activity → what the student actually sees the coach doing (#414) ────
// The stream already carries everything: `thinking` blocks, `tool_use` blocks
// with their full input, `tool_result` blocks, and periodic
// `system/thinking_tokens` ticks with a running token estimate. Until now
// consumeSdkStream extracted ONLY `.text`, so a turn that spent 286s writing
// files, hitting a read-only path, recovering via a shell probe, and writing
// again showed the student one static line. Nothing new has to be invented
// here — this stops throwing away what already arrives.
//
// Presentation (icons, truncation, Korean framing) stays OUT of this module:
// it emits raw activity, the host maps it to the toolLog protocol the browser
// loop already renders.

export type SdkActivity = (
  /** Running token estimate while the model thinks (Claude Code's "✻ …" counter). */
  | { kind: "thinking_tokens"; tokens: number }
  /** A completed thinking block. Raw model text — NOT translated (it is usually English). */
  | { kind: "thinking"; text: string }
  /** The coach is about to run a tool. `id` pairs with the matching tool_result. */
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  /** That tool finished. */
  | { kind: "tool_result"; id: string; isError: boolean; reason?: string }
) & {
  /**
   * #503 — SDK 가 이벤트마다 실어 보내는 자기 시각(ms). 단일 타임라인이 영속화될
   * 때 툴 줄의 `createdAt` 으로 쓴다: 호스트 시계로 다시 찍으면 창을 다시 열었을
   * 때의 정렬 근거가 우리 쪽 추정이 되어 버린다. 없으면 호출자가 시계를 준다.
   */
  at?: number;
};

/** SDK 이벤트의 `timestamp`(ISO 문자열 또는 ms)를 ms 로. 없으면 undefined. */
export function sdkEventTime(msg: Record<string, unknown>): number | undefined {
  const raw = msg["timestamp"];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/** `Read` 의 읽은 구간 표기. 범위를 안 줬으면(전체 읽기) 빈 문자열. */
function readRangeSuffix(rec: Record<string, unknown>): string {
  const num = (k: string): number | null => {
    const v = rec[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const offset = num("offset");
  const limit = num("limit");
  if (offset === null && limit === null) return "";
  if (offset !== null && limit !== null) return ` [${offset}~${offset + limit}]`;
  if (offset !== null) return ` [${offset}~]`;
  return ` [~${limit}]`;
}

/**
 * 툴 결과에서 사람이 읽을 첫 텍스트 한 조각. MCP/SDK 모두 content 가 문자열이거나
 * 블록 배열이므로 둘 다 받는다. 없으면 undefined — 빈 문자열로 라벨을 더럽히지 않는다.
 */
export function toolResultText(content: unknown, max = 90): string | undefined {
  const pick = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      for (const b of v) {
        if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
          const t = (b as { text?: unknown }).text;
          if (typeof t === "string" && t.trim()) return t;
        }
      }
    }
    return undefined;
  };
  const raw = pick(content);
  if (!raw) return undefined;
  const one = raw.replace(/\s+/g, " ").trim();
  if (!one) return undefined;
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 활동 로그에 보여 줄 경로 표기.
 *
 * 파일명만 남기던 예전 방식은 **세 가지 서로 다른 상황을 같은 글자로** 만들었다:
 *
 *   Read(/Users/…/HypeProofClinic/agent.md)  →  Read(agent.md)   정상
 *   Read(agent.md)                            →  Read(agent.md)   상대경로, 거부됨
 *   Read(/etc/passwd)                         →  Read(passwd)     워크스페이스 밖!
 *
 * 2026-07-26 실측에서 이것 때문에 같은 결함을 하루에 세 번 만나고 매번 다른
 * 원인으로 추정했다. 세 번째에야 벤더 SDK 타입을 열어 보고 확정했다.
 *
 * 이제 셋이 다르게 보인다:
 *   워크스페이스 안  → `agent.md` · `sub/a.css`   (루트 기준 상대)
 *   워크스페이스 밖  → `/etc/passwd`               (전체 경로 — 눈에 띄어야 한다)
 *   상대경로         → `./agent.md`                (흡수 전이라면 그대로 보인다)
 */
export function displayPath(value: string, workspaceRoot?: string): string {
  if (!path.isAbsolute(value)) return value.startsWith(".") ? value : `./${value}`;
  if (!workspaceRoot) return value;
  const rel = path.relative(workspaceRoot, value);
  // `..` 로 시작하면 루트 밖이다 — 축약하지 않고 전체를 보여 준다.
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return value;
  return rel;
}

/**
 * The one input field worth showing next to a tool name, in Claude Code's
 * `Write(index.html)` spirit. Falls back to a compact JSON clip so an unknown
 * tool still shows something real instead of a bare name.
 */
export function summarizeToolInput(
  name: string,
  input: unknown,
  max = 60,
  workspaceRoot?: string,
): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  const clip = (v: string): string => {
    const one = v.replace(/\s+/g, " ").trim();
    return one.length > max ? `${one.slice(0, max)}…` : one;
  };
  // Ordered by how identifying the field is, not by tool — the same key means
  // the same thing across tools, and unknown tools get the same treatment.
  for (const key of ["file_path", "path", "command", "url", "query", "pattern", "prompt", "description"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) {
      if (key !== "file_path" && key !== "path") return clip(v);
      // 파일 읽기는 **어디를 읽었는지**까지 보여 준다. 큰 파일을 다룰 때 코치는
      // Grep 으로 위치를 찾고 그 구간만 읽는 것이 정상 패턴인데(Claude Code 자신도
      // 그렇게 한다), 라벨이 파일명만 보여 주면 `Read(index.html)` 다섯 번이
      // "다른 구간 다섯 번"인지 "같은 걸 다섯 번"인지 구분되지 않는다. 2026-07-27
      // 실측에서 편집 구간 391초를 낭비로 볼지 정상으로 볼지 판정하지 못했다.
      return clip(displayPath(v, workspaceRoot) + readRangeSuffix(rec));
    }
  }
  try {
    return clip(JSON.stringify(rec));
  } catch {
    return "";
  }
}

/**
 * Pull every displayable activity out of ONE SDK stream event. Pure; returns []
 * for events that carry nothing to show (text deltas, init, result).
 */
export function extractSdkActivity(msg: Record<string, unknown>): SdkActivity[] {
  const type = String(msg["type"] ?? "");
  const at = sdkEventTime(msg);
  const stamp = (a: SdkActivity): SdkActivity => (at === undefined ? a : { ...a, at });

  if (type === "system" && msg["subtype"] === "thinking_tokens") {
    const tokens = msg["estimated_tokens"];
    return typeof tokens === "number" ? [stamp({ kind: "thinking_tokens", tokens })] : [];
  }

  // tool_use rides on assistant messages; tool_result comes back on user ones.
  if (type !== "assistant" && type !== "user") return [];
  const content = (msg["message"] as Record<string, unknown> | undefined)?.["content"];
  if (!Array.isArray(content)) return [];

  const out: SdkActivity[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    switch (b["type"]) {
      case "thinking": {
        const text = typeof b["thinking"] === "string" ? b["thinking"] : "";
        if (text.trim()) out.push(stamp({ kind: "thinking", text }));
        break;
      }
      case "tool_use": {
        const id = typeof b["id"] === "string" ? b["id"] : "";
        const name = typeof b["name"] === "string" ? b["name"] : "";
        if (id && name) out.push(stamp({ kind: "tool_use", id, name, input: b["input"] }));
        break;
      }
      case "tool_result": {
        const id = typeof b["tool_use_id"] === "string" ? b["tool_use_id"] : "";
        if (!id) break;
        const isError = b["is_error"] === true;
        // 실패한 이유는 결과 안에 있는데 그동안 버려졌다. 그래서 화면에는 ⚠️ 하나만
        // 남고 "왜"는 아무 데도 없었다 — 2026-07-27 실측에서 browser_click 이 두 턴
        // 연속 실패했는데 사유를 알 길이 없어 소스를 읽어 추정해야 했다. 짧게 실어
        // 보낸다(성공 결과는 길고 대부분 노이즈이므로 실패일 때만).
        const reason = isError ? toolResultText(b["content"]) : undefined;
        out.push(stamp({ kind: "tool_result", id, isError, ...(reason ? { reason } : {}) }));
        break;
      }
      default:
        break;
    }
  }
  return out;
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
  /**
   * #414 — everything the coach is DOING (thinking, tool calls, their results).
   * Optional so the fast-fail/stall tests can ignore it; when absent the stream
   * behaves exactly as before.
   */
  onActivity?: (activity: SdkActivity) => void;
  /**
   * #403 — silence budget in ms before the turn is declared stalled. Omit for
   * SDK_STREAM_STALL_MS; 0 disables the watchdog (escape hatch / old behavior).
   */
  stallMs?: number;
  /**
   * Build the student-friendly error thrown when the budget elapses. Defaults
   * to a bare Error(SDK_STALL_FRIENDLY) so a caller can't accidentally turn a
   * stall into a silent hang by forgetting to wire it.
   */
  makeStallError?: () => Error;
  /**
   * True while the turn is legitimately blocked OUTSIDE the stream: the
   * approve/deny modal is open (the student is reading it), or a tool the SDK
   * is still executing. Silence there is correct, so the watchdog grants a
   * fresh budget instead of aborting.
   */
  isTurnBlocked?: () => boolean;
}

/**
 * Consume one SDK coach turn's message stream. Pure and injected so both
 * no-silent-hang contracts are locked by unit tests:
 * - on the FIRST api_retry event with error_status 400/401 the query is
 *   aborted and the auth error thrown — within one event, no minutes-long
 *   backoff (#320, REQ-M15);
 * - after `stallMs` of silence with no progress the query is aborted and the
 *   friendly stall error thrown, so a retry storm or a wedged first turn ends
 *   in a visible message instead of an endless "생각하는 중…" (#403, REQ-M26).
 *
 * The manual iterator (instead of `for await`) is what makes the timer race
 * possible; the early-exit paths close the iterator explicitly, which
 * `for await` used to do for us.
 */
export async function consumeSdkStream(
  stream: AsyncIterable<unknown>,
  h: SdkStreamHandlers,
): Promise<void> {
  const budget = h.stallMs ?? SDK_STREAM_STALL_MS;
  const it = stream[Symbol.asyncIterator]();
  /** In-flight it.next(); kept across timer re-arms so it is never called twice. */
  let pending: Promise<IteratorResult<unknown>> | null = null;
  let progressAt = Date.now();
  /**
   * The blocked state is only sampled when the budget expires, so a modal that
   * closes mid-window would otherwise leave the coach ~0ms to answer. One grace
   * window is granted after any observed block: "once the human (or the tool)
   * is done, the coach gets a full budget", regardless of the timing.
   */
  let sawPause = false;

  const nextEvent = async (): Promise<IteratorResult<unknown>> => {
    if (!pending) pending = it.next();
    if (budget <= 0) {
      const settled = await pending;
      pending = null;
      return settled;
    }
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remaining = Math.max(1, budget - (Date.now() - progressAt));
      // NOT unref'd on purpose: this timer is the only thing that ends a wedged
      // turn, so it has to be able to keep the loop alive while one is live.
      // It is always cleared below (both legs of the race).
      const expired = new Promise<typeof STALLED>((resolve) => {
        timer = setTimeout(() => resolve(STALLED), remaining);
      });
      const won = await Promise.race([pending.then((value) => ({ value })), expired]);
      clearTimeout(timer);
      if (won !== STALLED) {
        pending = null;
        return won.value;
      }
      if (h.isTurnBlocked?.()) {
        // An open approval modal / a running tool is not a stall.
        sawPause = true;
        progressAt = Date.now();
        continue;
      }
      if (sawPause) {
        // The block ended somewhere inside the window that just expired; the
        // coach hasn't had a fair budget yet. Spend the grace window.
        sawPause = false;
        progressAt = Date.now();
        continue;
      }
      // Nobody awaits `pending` after this throw and abortQuery() rejects it.
      pending.catch(() => {});
      h.abortQuery();
      throw h.makeStallError?.() ?? new Error(SDK_STALL_FRIENDLY);
    }
  };

  try {
    for (;;) {
      const step = await nextEvent();
      if (step.done) return;
      // Check BEFORE emitting so a chunk isn't flushed to the webview after stop.
      if (h.isAborted()) throw h.makeAbortError();
      const msg = (step.value ?? {}) as Record<string, unknown>;
      const fatal = sdkFatalAuthStatus(msg);
      if (fatal !== null) {
        // Kill the subprocess's retry loop first, then surface the token error.
        h.abortQuery();
        throw h.makeFatalAuthError(fatal);
      }
      // Retry ticks are the pathology, not progress — they must not renew the
      // watchdog budget.
      if (!isSdkRetryEvent(msg)) {
        progressAt = Date.now();
        sawPause = false;
      }
      // #414 — surface the work itself (thinking / tool calls / results) before
      // the text, so the activity line appears when it happens rather than
      // after the prose that describes it.
      //
      // #503 실측(2026-07-28, @anthropic-ai/claude-agent-sdk 0.3.207, 제품과 같은
      // 옵션으로 2회 실행): assistant 메시지 12개 전수에서 `message.content` 길이가
      // 1이었다. SDK 는 API 메시지 하나를 thinking / text / tool_use 세 개의 SDK
      // 메시지로 쪼개 순서대로 보낸다(같은 message.id·request_id·usage 로 묶인다).
      // 그러므로 한 이벤트에서 onActivity 와 onDelta 가 **둘 다** 발화하는 일이
      // 없고, 이 호출 순서는 화면 순서에 영향을 주지 않는다 — 순서를 잃는 곳은
      // 여기가 아니라 웹뷰 리듀서였다(#503 ②③).
      //
      // 같은 실측에서 확인된 것: 최상위 `type === "content_block_delta"` 와
      // `type === "text"` 는 두 런 모두 0건이라 아래 세 갈래 중 실제로 타는 것은
      // "assistant" 뿐이다. 부분 스트리밍(includePartialMessages)을 켜도 이 분기는
      // 안 탄다 — 델타는 최상위 `type: "stream_event"` 로 오고 실제 종류는 한 겹
      // 안쪽 `msg.event.type` 에 있으며, 텍스트 경로도 `msg.delta.text` 가 아니라
      // `msg.event.delta.text` 다(extractSdkText 도 같이 고쳐야 한다). 이 이슈
      // 범위 밖이라 손대지 않는다 — 사실만 남긴다.
      if (h.onActivity) {
        for (const activity of extractSdkActivity(msg)) h.onActivity(activity);
      }
      const type = String(msg["type"] ?? "");
      if (type === "assistant" || type === "text" || type === "content_block_delta") {
        const delta = extractSdkText(msg);
        if (delta) h.onDelta(delta);
      }
      // 턴 예산 소진은 조용히 끝나면 안 된다. SDK 는 `{type:"result",
      // subtype:"error_max_turns"}` 로 알리는데, 예전에는 이 분기가 없어서 영어
      // 원문이 그대로 학생에게 나갔다. 실패가 아니라 예산 소진임을, 그리고 한
      // 일이 디스크에 남아 있음을 우리 말로 알려 준다.
      if (type === "result" && msg["subtype"] === "error_max_turns") {
        console.warn("[coach] maxTurns 소진 — 턴 예산을 다 쓰고 종료했다");
        h.onDelta(SDK_MAX_TURNS_FRIENDLY);
      }
      // Other message types (result / message_stop) are terminal — nothing to
      // emit; the caller posts streamEnd.
    }
  } catch (err) {
    // `for await` closed the iterator on an early exit; the manual loop must.
    void Promise.resolve(it.return?.()).catch(() => {});
    throw err;
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

/**
 * The complete vocabulary of Agent SDK tool names the #282 Phase 2 policy
 * matrix CLASSIFIES — every name any gate in evaluateSdkToolUse recognizes,
 * whether or not a given cohort profile grants it. Read/Write/Search/Shell/
 * Agent (by lowercased name, mirroring the sets above and AGENT_TOOLS) plus
 * the three hypeproof MCP browser tools (by exact name).
 *
 * This is the SDK-tool-drift boundary (#375). A denied tool call whose name is
 * in this set is a ROUTINE policy denial — Bash for a kids cohort, WebFetch
 * with no web_search opt-in — expected and high-volume. A denied name OUTSIDE
 * this set means the installed @anthropic-ai/claude-agent-sdk has grown a tool
 * the matrix has never classified: silent capability drift the coach is
 * dropping, which must surface loudly and distinctly instead of blending into
 * the routine-denial stream. Deny stays deny either way (fail-closed); this
 * only tells the two denials apart.
 */
export function isClassifiedSdkToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  if (
    SHELL_TOOLS.has(name) ||
    WRITE_TOOLS.has(name) ||
    READ_TOOLS.has(name) ||
    SEARCH_TOOLS.has(name) ||
    AGENT_TOOLS.has(name)
  ) {
    return true;
  }
  return (MCP_BROWSER_TOOLS as readonly string[]).includes(toolName);
}

/** A tool action the coach wants to perform, surfaced to the host modal. */
export interface CoachToolAction {
  /** Raw Agent SDK tool name, e.g. "Bash", "Write", "WebSearch". */
  toolName: string;
  /** Raw tool input object as given by the SDK. */
  input: unknown;
  /**
   * epic #431 — carried from the policy verdict so the host can pick the
   * strong confirm. Computed once in evaluateSdkToolUse rather than re-derived
   * at the modal, so policy and UI can never disagree about what is
   * destructive.
   */
  destructive?: boolean;
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
  // #457 배선 누락 수정 (2026-07-27 실측). click/type 은 정책(evaluateSdkToolUse)에는
  // 추가됐는데 여기 매핑이 빠져서 "미지의 툴" 폴백(executeShell)으로 떨어졌다.
  // 그래서 클릭인데 **셸 모달**이 뜨고, 셸 분기는 payload.command 를 읽는데 클릭엔
  // 그게 없어서 문구가 통째로 비었다("코치가 명령을 실행하려고 해요:" 뒤가 공백).
  if (action.toolName === MCP_BROWSER_CLICK) {
    const ref = firstString(action.input, ["ref"]) ?? "";
    return {
      kind: "browserClick",
      description: `페이지 요소 클릭: ${ref || safeStringify(action.input)}`,
      payload: { ref },
    };
  }
  if (action.toolName === MCP_BROWSER_TYPE) {
    const ref = firstString(action.input, ["ref"]) ?? "";
    const text = firstString(action.input, ["text"]) ?? "";
    return {
      kind: "browserType",
      description: `입력창(${ref})에 입력: ${text.slice(0, 60)}`,
      payload: { ref, text },
    };
  }
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
    return {
      kind: "executeShell",
      description: `${action.toolName}: ${command}`,
      payload: { command },
      ...(action.destructive ? { destructive: true } : {}),
    };
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
  // `destructive` (epic #431): shell only. The command is still ask-able —
  // arbitrary commands are the point — but the host must show the stronger
  // confirm and must NOT let "항상 허용" remember it.
  | { decision: "ask"; destructive?: boolean }
  // `drift` (#375): true only when the denied tool NAME is one the matrix has
  // never classified (isClassifiedSdkToolName === false) — i.e. possible Agent
  // SDK tool drift, not a routine profile/policy denial. The caller logs the
  // two at different volume/severity; the deny itself is identical.
  | { decision: "deny"; reason: string; friendly: string; drift?: boolean };

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
 * 상대경로를 워크스페이스 기준 절대경로로 바꿔 준다.
 *
 * 왜 필요한가 (2026-07-26 실측). 벤더 SDK 의 파일 도구는 **절대경로만** 받는다:
 *
 *   sdk-tools.d.ts  "absolute path to the file to read"
 *                   "absolute path to the file to write (must be absolute, not relative)"
 *
 * 코치가 `agent.md` 를 넘기면 파일이 있든 없든 거부된다. 그러면 코치는 "파일이
 * 없나?" 로 해석하고 찾아 나선다 — 실사용에서 `~/Desktop/HypeProof Studio/
 * workspace/` 같은 없는 경로를 지어내고, 이어서 `find ~` 로 홈 전체를 훑었다.
 * 턴 3 의 151초 중 120초가 여기서 증발했고, 같은 행동이 그 전 세션을 maxTurns 로
 * 죽였다(#457 노트).
 *
 * 프롬프트로 "절대경로를 쓰라"고 훈계하는 방법도 있지만 #428 이래 그 방향으로
 * 세 번 시도했고 세 번 다 재발했다. **제품이 흡수하는 쪽이 확실하다.**
 *
 * 규칙:
 *   - `PATH_INPUT_KEYS` 만 건드린다. Glob 의 `pattern` 은 경로가 아니라 패턴이라
 *     손대지 않는다 — `**\/*.html` 을 절대화하면 매칭이 깨진다.
 *   - 이미 절대경로면 그대로 둔다.
 *   - 워크스페이스 밖으로 나가는 상대경로(`../../etc/passwd`)도 **절대화만** 한다.
 *     막는 것은 이 함수가 아니라 뒤이은 containment 검사의 몫이다 — 판정을 한
 *     곳에 모아 둬야 구멍이 안 생긴다.
 */
export function absolutizeToolPaths(args: {
  toolName: string;
  input: unknown;
  workspaceRoot?: string;
}): { input: unknown; rewritten: Array<{ key: string; from: string; to: string }> } {
  const { toolName, input, workspaceRoot } = args;
  const rewritten: Array<{ key: string; from: string; to: string }> = [];
  if (!workspaceRoot || !input || typeof input !== "object" || Array.isArray(input)) {
    return { input, rewritten };
  }
  const name = toolName.toLowerCase();
  if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) return { input, rewritten };

  const rec = input as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const key of PATH_INPUT_KEYS) {
    const value = rec[key];
    if (typeof value !== "string" || value.length === 0) continue;
    if (path.isAbsolute(value)) continue;
    const abs = path.resolve(workspaceRoot, value);
    next ??= { ...rec };
    next[key] = abs;
    rewritten.push({ key, from: value, to: abs });
  }
  return { input: next ?? input, rewritten };
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
  /**
   * #384 — canonicalizer applied to BOTH the workspace root and each candidate
   * path before containment. The host injects an fs.realpath-based resolver so
   * macOS /var → /private/var symlinked workspaces don't auto-deny every
   * write ("path escapes the workspace" on paths that ARE inside it). Pure
   * default: identity (unit tests stay fs-free).
   */
  canonicalize?: (p: string) => string;
}): SdkToolVerdict {
  const { toolName, input, permittedTools, workspaceRoot } = args;
  const canon = args.canonicalize ?? ((p: string) => p);

  // Gate 1 — the profile's permitted set. Bash/WebFetch/anything not granted
  // dies here with a logged reason, even if the upstream model requests it.
  if (!permittedTools.includes(toolName)) {
    // #375 — two denials that mean opposite things share this gate. A name the
    // matrix CLASSIFIES (Bash for kids, WebFetch with no opt-in, …) is a
    // routine policy denial. A name it has never classified is SDK tool drift:
    // the Agent SDK likely grew a tool Studio hasn't wired, and we are silently
    // dropping it. Both fail closed, but they are flagged apart so the caller
    // can surface drift loudly instead of burying it in the routine stream.
    if (!isClassifiedSdkToolName(toolName)) {
      return {
        decision: "deny",
        drift: true,
        reason: `unclassified tool "${toolName}" — the Phase 2 policy matrix has no rule for this name (possible Agent SDK tool drift)`,
        friendly: TOOL_DENIED_FRIENDLY,
      };
    }
    return {
      decision: "deny",
      reason: `tool "${toolName}" is not granted by the cohort profile`,
      friendly: TOOL_DENIED_FRIENDLY,
    };
  }

  const name = toolName.toLowerCase();

  // ── Shell (epic #431) ─────────────────────────────────────────────────────
  // Gate 1 already proved the cohort opted in (`sdk_tools.shell`). From here
  // ANY command may be proposed — there is deliberately no content allowlist,
  // because an allowlist makes the coach invent detours for off-list work,
  // which is the gap-filling that produced #428's fabricated `/app/workdir`.
  //
  // The modal is the gate. What the policy still decides is how LOUD it is:
  // destructive commands (`rm`, `sudo`, `git push --force`, pipe-to-shell)
  // carry a flag so the host shows the stronger confirm and never lets
  // "항상 허용" remember them.
  if (SHELL_TOOLS.has(name)) {
    const command = firstString(input, ["command"]) ?? "";
    if (!command.trim()) {
      return {
        decision: "deny",
        reason: "shell call carried no command string",
        friendly: TOOL_DENIED_FRIENDLY,
      };
    }
    // 되돌리기 어려운 명령만 묻는다 (원장 결정 2026-07-27).
    //
    // 예전에는 모든 셸 호출이 모달이었다 — "모달이 유일한 게이트"라는 전제였다.
    // 실측에서 그 전제가 무너졌다: 코치가 정답지를 읽으려고 `curl … | grep` 을 쓸
    // 때마다 모달이 떴고, 한 턴에 6번까지 갔다. 읽기만 하는 명령에 승인을 물으면
    // 학습되는 것은 판단이 아니라 반사다.
    //
    // 이제 판단은 **되돌릴 수 있느냐**로 가른다. `rm`·`mv`·강제 push·`curl | sh` 처럼
    // 학생 작업을 날릴 수 있는 것은 강한 확인을 유지하고(「항상 허용」도 안 준다),
    // 나머지는 자동 실행한다. 파일 쓰기는 이미 워크스페이스 containment 가 지키고,
    // 셸의 위험은 그 containment 밖으로 나가는 명령이다 — 그게 정확히 이 목록이다.
    if (isDestructiveCommand(command)) {
      return { decision: "ask", destructive: true };
    }
    return { decision: "allow" };
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
    // 자기 워크스페이스를 보는 것은 바깥 행위가 아니다. live_preview_start 는
    // 이미 자동 허용인데(바로 아래), 그렇게 띄운 서버를 **열어서 보는 것**에
    // 모달을 달면 앞뒤가 안 맞는다. 실사용에서 코치는 고칠 때마다 자기 결과를
    // 다시 열어 확인하므로, 이 모달은 "만들고 → 보고 → 고치고 → 다시 보고"
    // 루프마다 반복된다. browser_read 를 자동 허용한 것(#457)과 같은 이유다.
    if (isLoopbackUrl(url)) {
      return { decision: "allow" };
    }
    // 바깥 주소 → 승인 모달 (kind "openBrowser"). 호스트가 오리진 단위로
    // 기억하므로 같은 사이트의 서브페이지는 다시 묻지 않는다.
    return { decision: "ask" };
  }
  // #457 — 검사 3종.
  //   browser_read  : 관측이다. 스크린샷과 같은 등급으로 자동 허용한다. 여기에
  //                   모달을 달면 "검사 → 수정 → 재검사" 루프가 승인 지옥이 된다.
  //   click / type  : 페이지를 **실제로 조작**한다. 학생 화면에서 무언가 일어나는
  //                   행위이므로 모달을 거친다(browser_open 과 같은 등급).
  if (toolName === MCP_BROWSER_READ) {
    return { decision: "allow" };
  }
  if (toolName === MCP_BROWSER_CLICK || toolName === MCP_BROWSER_TYPE) {
    return { decision: "ask" };
  }
  if (toolName === MCP_BROWSER_SCREENSHOT || toolName === MCP_LIVE_PREVIEW_START) {
    // Auto-allow once the browser capability is granted: a screenshot of the
    // student's own tab / serving their own workspace locally is the coach
    // "looking at the page", not an outward delegation.
    return { decision: "allow" };
  }

  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    // Gate 2 — workspace containment for every path the call names. Both
    // sides go through the injected canonicalizer (#384: symlinked roots).
    if (workspaceRoot) {
      const canonRoot = canon(workspaceRoot);
      for (const candidate of pathCandidates(toolName, input)) {
        const canonCandidate = path.isAbsolute(candidate)
          ? canon(candidate)
          : candidate; // relative resolves against the (canonical) root inside isPathContained
        if (!isPathContained(canonRoot, canonCandidate)) {
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

  // Permitted but unclassified — should be unreachable; fail closed. If it ever
  // fires, the permitted set granted a name no gate handles: also drift (#375).
  return {
    decision: "deny",
    drift: true,
    reason: `unrecognized tool "${toolName}"`,
    friendly: TOOL_DENIED_FRIENDLY,
  };
}
