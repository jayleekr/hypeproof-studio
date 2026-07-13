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
import type { AssetScoreChunk, Citation, ResolvedProfile } from "./protocol";
import {
  buildSdkQueryOptions,
  profileToAgentOptions,
  sdkToolToActionRequest,
  type CoachToolAction,
} from "./sdkCoachHelpers";

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
  onCitations: (citations: Citation[]) => void;
  onAssetScore: (score: AssetScoreChunk) => void;
  /** Manual-approve gate. Resolves true to allow the tool. */
  requestApproval: (action: CoachToolAction) => Promise<boolean>;
  /** Test seam: inject a fake SDK module instead of importing the real one. */
  sdk?: AgentSdkModule;
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
}

async function loadSdk(): Promise<AgentSdkModule> {
  try {
    // Variable specifier → esbuild leaves this as a true runtime dynamic
    // import() (never inlined into dist/extension.js). That matters twice:
    // the SDK is ESM-only and spawns a ~240 MB native `claude` binary from
    // its platform package (@anthropic-ai/claude-agent-sdk-<platform>), both
    // of which must resolve from node_modules at runtime, not from a bundle.
    const spec: string = SDK_PACKAGE;
    const mod = (await import(spec)) as AgentSdkModule;
    if (typeof mod.query !== "function") {
      throw new Error(`${SDK_PACKAGE} loaded but does not export query()`);
    }
    return mod;
  } catch (err) {
    if (err instanceof SdkUnavailableError) throw err;
    // Keep the technical detail for developers (console), NOT for the student.
    console.warn(`[coach] failed to load ${SDK_PACKAGE}:`, err);
    throw new SdkUnavailableError(
      `agent-sdk runtime selected but ${SDK_PACKAGE} could not be loaded ` +
        `(packaged build without node_modules?). Falling back to the proxy runtime (#282).`,
    );
  }
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

  const sdk = args.sdk ?? (await loadSdk());
  const opts = profileToAgentOptions(args.profile, {
    model: args.model,
    systemPrompt: args.systemPrompt,
  });

  // Compose the transcript into a single prompt string for now. A follow-up
  // switches to the SDK streaming-input session API to preserve real history.
  const transcript = args.history.map((m) => `${m.role}: ${m.content}`).join("\n");
  const prompt = transcript ? `${transcript}\nuser: ${args.userText}` : args.userText;

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
    }),
    // Every tool call routes here (allowedTools is empty). First enforce the
    // cohort's permitted set, then gate the survivors through the host modal.
    canUseTool: async (name, input) => {
      if (!opts.permittedTools.includes(name)) {
        return {
          behavior: "deny" as const,
          message: "이 도구는 지금 수업에서는 사용할 수 없어요.",
        };
      }
      const ok = await args.requestApproval({ toolName: name, input });
      return ok
        ? { behavior: "allow" as const, updatedInput: input }
        : { behavior: "deny" as const, message: "사용자가 이 작업을 허용하지 않았어요." };
    },
    abortController,
  };

  const stream = sdk.query({ prompt, options });

  // Map SDK messages → the proxyChat callback shape. Field access is defensive
  // (Record<string,unknown>) until the real SDK types land in Phase 1.
  for await (const msg of stream) {
    // Check BEFORE emitting so a chunk isn't flushed to the webview after stop.
    if (args.signal.aborted) throw abortError();
    const type = String((msg as Record<string, unknown>).type ?? "");
    if (type === "assistant" || type === "text" || type === "content_block_delta") {
      const delta = extractText(msg);
      if (delta) args.onDelta(delta);
    }
    // Other message types (result / message_stop) are terminal — nothing to
    // emit; the caller posts streamEnd. (onCitations / onAssetScore are wired
    // for parity but the SDK stream mapping for those lands in Phase 1.)
  }
}

/** Best-effort text extraction across candidate SDK message shapes (spike). */
function extractText(msg: Record<string, unknown>): string {
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
