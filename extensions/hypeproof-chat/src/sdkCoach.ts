// #282 — ORCHESTRATION: run the coach on the Claude Agent SDK instead of the
// single-turn proxy. Drop-in with proxyChat's callback contract so
// chatPanelProvider can route to it behind the `hypeproofChat.coachRuntime`
// flag (Phase 1), falling back to the proxy runtime when the SDK isn't present.
//
// Side effects are injected as callbacks (onDelta / onCitations / onAssetScore /
// requestApproval) — this module stays `vscode`-free and testable, same split
// as proxyClient. `@anthropic-ai/claude-agent-sdk` is a real dependency as of
// Phase 1 (#282); it is still loaded via a variable-specifier dynamic import
// (never bundled by esbuild — the SDK spawns a native `claude` binary from its
// platform package, which must resolve from node_modules at runtime). In a
// packaged build without node_modules the import fails and this throws
// SdkUnavailableError so the caller falls back to the proxy path instead of
// surfacing a raw error to the student (REQ-M7).

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildHypeproofMcpServer,
  HYPEPROOF_MCP_SERVER_NAME,
  MCP_BROWSER_OPEN,
  resolveAlreadyOpen,
  type BrowserMcpHost,
  type SdkMcpFactory,
  type ZodLike,
} from "./browserMcp";
import type { AssetScoreChunk, Citation, ResolvedProfile } from "./protocol";
import { ProxyAuthError } from "./proxyClient";
import { TOKEN_EXPIRED_FRIENDLY } from "./proxyClientHelpers";
import {
  buildSdkQueryOptions,
  consumeSdkStream,
  evaluateSdkToolUse,
  SDK_STALL_FRIENDLY,
  SDK_STREAM_STALL_MS,
  profileToAgentOptions,
  resolveSdkBinary,
  resolveSdkModule,
  resolveZodModule,
  sdkBinaryMarkerPath,
  sdkToolToActionRequest,
  seededSdkBinaryPath,
  type SdkActivity,
  type CoachToolAction,
  type SdkBinaryResolution,
  type SdkBinaryStat,
} from "./sdkCoachHelpers";

export type { BrowserMcpHost } from "./browserMcp";

export type { CoachToolAction } from "./sdkCoachHelpers";

/**
 * Thrown when the agent-sdk runtime is selected but the SDK package isn't
 * installed (the pre-Phase-1 state). The caller catches this and falls back to
 * the proxy runtime, so a misconfigured flag never breaks the live coach or
 * shows a technical English error to a child.
 */
export class SdkUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SdkUnavailableError";
  }
}

/**
 * #403 — thrown when the SDK stream produced no progress for the whole stall
 * budget. Carries the student-friendly Korean copy as its message, so
 * chatPanelProvider's generic error path renders it verbatim in the stream
 * error banner (no raw JSON, no English). A distinct class so a caller (or a
 * problem report) can tell "the coach wedged" apart from a real API error.
 */
export class CoachStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoachStallError";
  }
}

export interface SdkCoachArgs {
  /**
   * The extension's proxyUrl setting (OpenAI-compat base ending in /v1).
   * ANTHROPIC_BASE_URL is DERIVED from it (the /v1 suffix stripped — the SDK
   * appends /v1/messages itself); see buildSdkGatewayEnv.
   */
  gatewayUrl: string;
  token: string;
  model: string;
  profile: ResolvedProfile;
  /**
   * Client-side system prompt for the SDK loop. The worker gateway DROPS the
   * client `system` field and injects the cohort profile blocks server-side
   * (REQ-M10, #316), so what the model sees is always the tuned Korean cohort
   * prompt regardless of this value. Kept in the contract for local-dev runs
   * against a non-gateway upstream.
   */
  systemPrompt: string;
  history: { role: string; content: string }[];
  userText: string;
  signal: AbortSignal;
  /** Workspace root for the SDK's file tools (Phase-2 tiers). */
  cwd?: string;
  onDelta: (delta: string) => void;
  /**
   * #414 — what the coach is DOING (thinking / tool calls / results), so the
   * student sees real work instead of a static "만드는 중" line. Optional: the
   * proxy path has no equivalent, and a caller that omits it loses nothing else.
   */
  onActivity?: (activity: SdkActivity) => void;
  onCitations: (citations: Citation[]) => void;
  onAssetScore: (score: AssetScoreChunk) => void;
  /** Manual-approve gate. Resolves true to allow the tool. */
  requestApproval: (action: CoachToolAction) => Promise<boolean>;
  /**
   * #282 P2 slice 2 — host capabilities behind the in-process "hypeproof" MCP
   * browser tools. Optional: when absent (or the profile doesn't grant
   * sdk_tools.browser) no MCP server is registered and the coach stays
   * browser-less. Implemented by chatPanelProvider (it has the vscode API).
   */
  browserHost?: BrowserMcpHost;
  /**
   * #282 W4a — the hypeproofChat.sdkBinaryPath setting (highest-priority
   * binary override). Undefined/empty = unset; resolution then walks
   * HPS_SDK_BINARY → seeded location → node_modules (REQ-M24).
   */
  binaryPathSetting?: string;
  /**
   * #403 — silence budget (ms) before a wedged turn is aborted with a visible
   * message instead of an endless "생각하는 중…". Undefined = the helper default
   * (SDK_STREAM_STALL_MS); 0 disables the watchdog.
   */
  stallTimeoutMs?: number;
  /** Test seam: inject a pre-computed binary resolution (skip fs probes). */
  binaryResolution?: SdkBinaryResolution;
  /** Test seam: inject a fake SDK module instead of importing the real one. */
  sdk?: AgentSdkModule;
  /** Test seam: inject a fake zod instead of importing the real one. */
  zod?: ZodLike;
}

/** npm package that provides the SDK once wired (Phase 1). */
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * The seam this module (and its tests) depend on from the Agent SDK. `Options`
 * is the REAL SDK type (type-only import — erased at build time), so the
 * option mapping below is checked against the actual package contract while
 * tests can still inject a fake module. The real `query()` returns a `Query`
 * (an AsyncGenerator with extra control methods); we only consume it as an
 * AsyncIterable of loosely-typed messages.
 */
export interface AgentSdkModule {
  query(input: {
    prompt: string | AsyncIterable<unknown>;
    options?: Options;
  }): AsyncIterable<Record<string, unknown>>;
  /**
   * In-process MCP server factory functions (#282 P2 slice 2). Optional on
   * the seam: an older/fake module without them simply gets no browser MCP
   * server (graceful degradation — chat still works).
   */
  createSdkMcpServer?: SdkMcpFactory["createSdkMcpServer"];
  tool?: SdkMcpFactory["tool"];
}

/**
 * The extension's dist/ dir at runtime — where the esbuild CJS bundle
 * (dist/extension.js) lives, and the anchor for the vendored SDK JS under
 * dist/vendor (#282 W4b). `__dirname` exists in the CJS bundle (esbuild
 * platform=node, no --format → cjs); under the ESM smoke tests this module
 * isn't loaded, so the guard is only belt. Undefined → resolveSdkModule falls
 * to the bare specifier (dev node_modules lookup).
 */
function extensionDistDir(): string | undefined {
  return typeof __dirname === "string" && __dirname ? __dirname : undefined;
}

/**
 * #384 — canonicalize a path for containment comparison: realpath the nearest
 * EXISTING ancestor (target may not exist yet — new-file writes) and re-append
 * the tail. Twin of chatPanelProvider.canonicalizeForCompare.
 */
function canonicalizeFsPath(p: string): string {
  let base = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0
        ? fs.realpathSync(base)
        : path.join(fs.realpathSync(base), ...tail.reverse());
    } catch {
      const parent = path.dirname(base);
      if (parent === base) return path.resolve(p);
      tail.push(path.basename(base));
      base = parent;
    }
  }
}

async function loadSdk(): Promise<AgentSdkModule> {
  // #282 W4b — prefer the vendored SDK JS under <dist>/vendor (packaged
  // built-in), else the bare specifier so Node's node_modules lookup runs
  // (dev). The vendored sdk.mjs is ESM and its own `import "ajv/..."` resolves
  // from the sibling vendor/node_modules; the native binary is located
  // separately (W4a, pathToClaudeCodeExecutable).
  const resolution = resolveSdkModule({
    distDir: extensionDistDir(),
    fileExists: (p) => fs.existsSync(p),
  });
  try {
    // Variable specifier → esbuild leaves this a true runtime dynamic import()
    // (never inlined into dist/extension.js). Vendored: an absolute file:// URL
    // to sdk.mjs (a raw absolute path is not portably importable on win32).
    // node-modules: the bare specifier.
    const spec: string =
      resolution.source === "vendored"
        ? pathToFileURL(resolution.entryPath).href
        : resolution.specifier;
    const mod = (await import(spec)) as AgentSdkModule;
    if (typeof mod.query !== "function") {
      throw new Error(`${SDK_PACKAGE} loaded but does not export query()`);
    }
    if (resolution.source === "vendored") {
      console.info(`[coach] agent-sdk JS via vendored copy: ${resolution.entryPath}`);
    }
    return mod;
  } catch (err) {
    if (err instanceof SdkUnavailableError) throw err;
    // Keep the technical detail for developers (console), NOT for the student.
    console.warn(`[coach] failed to load ${SDK_PACKAGE} (source=${resolution.source}):`, err);
    throw new SdkUnavailableError(
      `agent-sdk runtime selected but ${SDK_PACKAGE} could not be loaded ` +
        `(source=${resolution.source}; packaged build without the vendored SDK JS or node_modules?). ` +
        `Falling back to the proxy runtime (#282 W4b).`,
    );
  }
}

/**
 * Load zod (the SDK's peer dep — needed for MCP tool input schemas) the same
 * way the SDK itself is loaded: variable-specifier dynamic import, never
 * bundled. Returns null when unavailable (packaged build without
 * node_modules) so the caller degrades to a browser-less coach instead of
 * failing the turn.
 */
async function loadZod(): Promise<ZodLike | null> {
  // #282 W4b — same vendored-first resolution as the SDK: the packaged built-in
  // has no node_modules, so the bare "zod" specifier would fail and the coach
  // would silently lose the browser MCP tools. The vendored copy under
  // <dist>/vendor keeps them working; still null-tolerant (dev without zod).
  const resolution = resolveZodModule({
    distDir: extensionDistDir(),
    fileExists: (p) => fs.existsSync(p),
  });
  try {
    const spec: string =
      resolution.source === "vendored"
        ? pathToFileURL(resolution.entryPath).href
        : resolution.specifier;
    const mod = (await import(spec)) as {
      z?: ZodLike;
      string?: unknown;
      default?: ({ z?: ZodLike } & ZodLike) | undefined;
    };
    const z = (mod.z ?? mod.default?.z ?? mod.default ?? mod) as ZodLike;
    return typeof z.string === "function" ? z : null;
  } catch (err) {
    console.warn("[coach] failed to load zod for the browser MCP tools:", err);
    return null;
  }
}

// ── Native `claude` binary resolution — host side (#282 W4a, REQ-M24) ────────
// The pure order/gate logic lives in sdkCoachHelpers (resolveSdkBinary,
// isSeededBinaryTrusted); this side supplies the real fs/os/require probes.

function statBinary(p: string): SdkBinaryStat {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { exists: false, executable: false, size: 0 };
    let executable = true;
    if (process.platform !== "win32") {
      try {
        fs.accessSync(p, fs.constants.X_OK);
      } catch {
        executable = false;
      }
    }
    return { exists: true, executable, size: st.size };
  } catch {
    return { exists: false, executable: false, size: 0 };
  }
}

function readMarker(binaryPath: string): string | null {
  try {
    return fs.readFileSync(sdkBinaryMarkerPath(binaryPath), "utf8");
  } catch {
    return null;
  }
}

/**
 * Does the SDK's own node_modules optionalDependency lookup stand a chance?
 * Mirrors the SDK's fallback (doc §2.1): createRequire().resolve over the
 * platform package's `claude[.exe]` subpath. `__filename` exists in the
 * esbuild CJS bundle (extension host); under the ESM smoke tests it is
 * undefined and we anchor to cwd — either way this is only a cheap probe.
 */
function nodeModulesBinaryAvailable(): boolean {
  const anchor =
    typeof __filename === "string" && __filename
      ? __filename
      : path.join(process.cwd(), "noop.js");
  let req: NodeJS.Require;
  try {
    req = createRequire(anchor);
  } catch {
    return false;
  }
  const suffixes =
    process.platform === "linux"
      ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
      : [`${process.platform}-${process.arch}`];
  const binName = process.platform === "win32" ? "claude.exe" : "claude";
  for (const suffix of suffixes) {
    try {
      const resolved = req.resolve(`@anthropic-ai/claude-agent-sdk-${suffix}/${binName}`);
      if (fs.existsSync(resolved)) return true;
    } catch {
      // keep probing
    }
  }
  return false;
}

/**
 * Resolve the claude binary with real host probes. Exported for the
 * orchestration path (runSdkCoach calls it when no test seam is injected)
 * and for diagnostics.
 */
export function resolveSdkBinaryForHost(args?: { settingPath?: string }): SdkBinaryResolution {
  const seededPath = seededSdkBinaryPath({
    platform: process.platform,
    homeDir: os.homedir(),
    env: process.env,
  });
  return resolveSdkBinary({
    settingPath: args?.settingPath,
    envPath: process.env.HPS_SDK_BINARY,
    seeded: {
      path: seededPath,
      stat: statBinary(seededPath),
      markerRaw: readMarker(seededPath),
    },
    nodeModulesAvailable: nodeModulesBinaryAvailable(),
    fileExists: (p) => fs.existsSync(p),
  });
}

function abortError(): Error {
  // Mirror the proxy path (fetch throws a DOMException AbortError on abort) so
  // the caller's catch treats an SDK abort identically and skips history commit.
  if (typeof DOMException === "function") return new DOMException("Aborted", "AbortError");
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Run one coach turn on the Agent SDK. Mirrors proxyChat's contract so the
 * caller doesn't care which runtime produced the stream. Throws an AbortError
 * on cancellation (parity with proxyChat) and SdkUnavailableError when the SDK
 * package is absent.
 */
export async function runSdkCoach(args: SdkCoachArgs): Promise<void> {
  // Bridge the caller's signal to an SDK AbortController UP FRONT — before any
  // await — so a stop during loadSdk() still cancels. (addEventListener added
  // after the signal already fired would never run.)
  if (args.signal.aborted) throw abortError();
  const abortController = new AbortController();
  args.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  // #282 W4a — locate the native `claude` binary BEFORE loading the SDK JS:
  // setting > HPS_SDK_BINARY > seeded (integrity-gated) > node_modules. When
  // nothing resolves we throw SdkUnavailableError here — same proxy-fallback
  // contract as a missing SDK package (REQ-M7), but with the reasons logged —
  // instead of letting the SDK crash mid-turn on a missing binary.
  const binary = args.binaryResolution ?? resolveSdkBinaryForHost({
    settingPath: args.binaryPathSetting,
  });
  if (!binary.available) {
    console.warn(`[coach] no claude binary resolvable: ${binary.reasons.join("; ")}`);
    throw new SdkUnavailableError(
      "agent-sdk runtime selected but no claude CLI binary is available " +
        "(set hypeproofChat.sdkBinaryPath or run scripts/seed-sdk-binary.sh). " +
        "Falling back to the proxy runtime (#282 W4a).",
    );
  }
  if (binary.path) {
    console.info(`[coach] claude binary via ${binary.source}: ${binary.path}`);
  }

  const sdk = args.sdk ?? (await loadSdk());
  const opts = profileToAgentOptions(args.profile, {
    model: args.model,
    systemPrompt: args.systemPrompt,
  });

  // Compose the transcript into a single prompt string for now. A follow-up
  // switches to the SDK streaming-input session API to preserve real history.
  const transcript = args.history.map((m) => `${m.role}: ${m.content}`).join("\n");
  const prompt = transcript ? `${transcript}\nuser: ${args.userText}` : args.userText;

  // #282 P2 slice 2 — register the in-process "hypeproof" browser MCP server
  // ONLY when (a) the worker profile grants it (permittedMcpTools non-empty —
  // adults with sdk_tools.browser; minors are always stripped), (b) the host
  // provided the capabilities, and (c) the loaded SDK + zod expose the factory
  // (a fake/old module without them degrades to a browser-less coach).
  // grantedMcpTools mirrors what was ACTUALLY registered so canUseTool never
  // grants a name no server serves — and stays [] when registration didn't
  // happen, keeping the policy fail-closed.
  // #403 — stall-watchdog bookkeeping (see the consumeSdkStream call below).
  // `awaitingUser` is >0 while an approve/deny modal is open; `lastToolCallAt`
  // stamps every canUseTool decision, because the SDK then runs that tool with
  // NO stream events until its result — a subagent (copyclone grants them) can
  // legitimately be silent for a while there.
  let awaitingUser = 0;
  let lastToolCallAt = 0;

  let mcpServers: Options["mcpServers"];
  let grantedMcpTools: readonly string[] = [];
  if (opts.permittedMcpTools.length > 0 && args.browserHost) {
    const hasFactory =
      typeof sdk.createSdkMcpServer === "function" && typeof sdk.tool === "function";
    const z = hasFactory ? args.zod ?? (await loadZod()) : null;
    if (hasFactory && z) {
      const server = buildHypeproofMcpServer(
        { createSdkMcpServer: sdk.createSdkMcpServer!, tool: sdk.tool! },
        z,
        args.browserHost,
      );
      mcpServers = {
        [HYPEPROOF_MCP_SERVER_NAME]: server as NonNullable<Options["mcpServers"]>[string],
      };
      grantedMcpTools = opts.permittedMcpTools;
    } else {
      console.warn(
        "[coach] profile grants browser MCP tools but the SDK/zod factory is unavailable — running browser-less",
      );
    }
  }

  // Pure option/env construction (allowedTools/settingSources pinned to [],
  // ANTHROPIC_BASE_URL derived from proxyUrl, ANTHROPIC_API_KEY scrubbed) is
  // locked by unit tests via buildSdkQueryOptions (REQ-M5/M6/M13); the two
  // host-bound fields are attached here. `Options` is the REAL SDK type.
  const options: Options = {
    ...buildSdkQueryOptions(opts, {
      proxyUrl: args.gatewayUrl,
      token: args.token,
      cwd: args.cwd,
      baseEnv: process.env,
      // W4a — explicit binary path (setting/env/seeded). Undefined for the
      // node-modules source: the option is omitted and the SDK's own
      // optionalDependency lookup runs (dev behavior, unchanged).
      pathToClaudeCodeExecutable: binary.path,
    }),
    // Every tool call routes here (allowedTools is empty — an entry there
    // would auto-approve and bypass this gate). The pure policy matrix
    // (evaluateSdkToolUse, #282 Phase 2) decides:
    //   deny  → not profile-granted (Bash & co) or path escapes the workspace;
    //           reason logged host-side, student sees the Korean line;
    //   allow → read tools contained in the workspace (auto, no modal);
    //   ask   → write tools (ALWAYS the approve/deny modal — the gate is the
    //           pedagogy) + web research (host approval tiers decide).
    // MCP server registration is conditional (see above); mcpServers stays
    // absent for ungranted cohorts, so the model never even sees the tools.
    ...(mcpServers ? { mcpServers } : {}),
    canUseTool: async (name, input) => {
      lastToolCallAt = Date.now();
      const verdict = evaluateSdkToolUse({
        toolName: name,
        input,
        // Union of built-in grants + the Agent/Task invoker (when the profile
        // grants subagents, #282 P2 slice 3) + the MCP tools that actually
        // registered. Subagent-context calls (sdk.d.ts CanUseTool `agentID`)
        // arrive here too and face the same matrix.
        permittedTools: [...opts.permittedTools, ...opts.permittedAgentTools, ...grantedMcpTools],
        workspaceRoot: args.cwd,
        // #384 — realpath-based canonicalizer: without it a symlinked
        // workspace (macOS /var → /private/var, iCloud Desktop, …) fails
        // containment and EVERY coach write auto-denies. Twin of
        // chatPanelProvider.canonicalizeForCompare.
        canonicalize: canonicalizeFsPath,
      });
      if (verdict.decision === "deny") {
        if (verdict.drift) {
          // #375 — the SDK emitted a tool NAME the Phase 2 policy matrix has
          // never classified. The fail-closed deny is correct, but this is
          // capability drift, NOT a routine policy denial: the installed
          // @anthropic-ai/claude-agent-sdk likely grew a tool Studio hasn't
          // wired, and the coach is silently dropping it. Log loudly and
          // distinctly (console.error, not the high-volume warn) so an SDK
          // bump produces a signal instead of silence. The CI drift smoke test
          // (sdk-tool-drift.smoke.mjs) is the PR-time counterpart.
          console.error(
            `[coach] SDK TOOL DRIFT: unclassified tool "${name}" denied (fail-closed) — ${verdict.reason}. ` +
              `Update the classification sets in sdkCoachHelpers.ts (SDK_*_TOOL_NAMES / *_TOOLS) if Studio should ` +
              `handle this tool, or leave it denied deliberately.`,
          );
        } else {
          console.warn(`[coach] tool denied: ${name} — ${verdict.reason}`);
        }
        return { behavior: "deny" as const, message: verdict.friendly };
      }
      if (verdict.decision === "allow") {
        return { behavior: "allow" as const, updatedInput: input };
      }
      // #415 — 이미 열려 있는 페이지를 다시 여는 browser_open 은 모달 없이
      // 통과시킨다. 핸들러가 short-circuit 해서 **실제로 여는 동작이 없기**
      // 때문 — 물을 것이 없는데 뜨는 승인 모달은 학생의 턴을 몇 분씩 막고
      // (2026-07-24 실사용 ~2분), 반복되면 게이트가 교육 장치가 아니라 잡음이
      // 된다(delegation_judgment). 판정은 핸들러와 동일한 resolveAlreadyOpen
      // 단일 소스 — 갈라지면 "모달 없는 실제 오픈" 구멍이 된다.
      if (name === MCP_BROWSER_OPEN && args.browserHost) {
        const { alreadyOpen } = await resolveAlreadyOpen(args.browserHost,
          (input as { url?: unknown } | undefined)?.url);
        if (alreadyOpen) return { behavior: "allow" as const, updatedInput: input };
      }
      // #403 — the modal blocks the SDK stream for as long as the human takes
      // to decide. Mark the turn as human-blocked so the stall watchdog below
      // doesn't read that (correct) silence as a wedged turn.
      awaitingUser += 1;
      let ok: boolean;
      try {
        ok = await args.requestApproval({ toolName: name, input });
      } finally {
        awaitingUser -= 1;
      }
      return ok
        ? { behavior: "allow" as const, updatedInput: input }
        : { behavior: "deny" as const, message: "사용자가 이 작업을 허용하지 않았어요." };
    },
    abortController,
  };

  const stream = sdk.query({ prompt, options });

  // Map SDK messages → the proxyChat callback shape via the pure consumer
  // (sdkCoachHelpers.consumeSdkStream — unit-tested). Three exits besides
  // normal completion:
  // - user stop → AbortError (proxy-path parity, REQ-M8);
  // - gateway 401/400 api_retry → fast-fail (#320, REQ-M15): the SDK CLI would
  //   otherwise retry up to 10x with backoff, i.e. a bad/expired workshop token
  //   became a multi-minute silent hang for a kid. We abort the query on the
  //   FIRST such event and throw the SAME student-friendly token error the
  //   proxy path uses (ProxyAuthError kind "expired" → chatPanelProvider
  //   clears the dead token + reopens the token input box). "expired" fits
  //   both statuses here: the workshop token is the only credential on this
  //   path, so a 400/401 means that token is unusable — replacing it is the
  //   recovery, retrying is not.
  // - stall watchdog → CoachStallError (#403, REQ-M26): everything the 4xx
  //   fast-fail does NOT cover (429/529/5xx/connection retries, or a first turn
  //   that simply never produces a token) left the student on "생각하는 중… ✨"
  //   with no error and no way out. After stallTimeoutMs of no progress we
  //   abort the query and surface a retry-me message.
  // (onCitations / onAssetScore are wired for parity but the SDK stream
  // mapping for those lands in a later phase.)
  const stallMs = args.stallTimeoutMs ?? SDK_STREAM_STALL_MS;
  await consumeSdkStream(stream, {
    isAborted: () => args.signal.aborted,
    makeAbortError: abortError,
    abortQuery: () => abortController.abort(),
    makeFatalAuthError: () => new ProxyAuthError("expired", TOKEN_EXPIRED_FRIENDLY),
    onDelta: args.onDelta,
    ...(args.onActivity ? { onActivity: args.onActivity } : {}),
    stallMs,
    makeStallError: () => {
      // Developer-side signal — the student only ever sees the Korean line.
      console.warn(
        `[coach] SDK stream stalled: no progress for ${stallMs}ms — aborting the turn (#403). ` +
          `Likely a gateway retry storm (429/529/5xx) or a first turn that never produced a token.`,
      );
      return new CoachStallError(SDK_STALL_FRIENDLY);
    },
    // Silence that is NOT a stall: an open modal, or a tool the SDK is still
    // running (one budget of slack after the decision — a long subagent gets
    // ~2 budgets total before the watchdog calls it wedged, a never-returning
    // one still ends in a message rather than a hang).
    isTurnBlocked: () => awaitingUser > 0 || Date.now() - lastToolCallAt < stallMs,
  });
}
