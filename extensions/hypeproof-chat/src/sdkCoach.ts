// #282 — ORCHESTRATION: run the coach on the Claude Agent SDK instead of the
// single-turn proxy. Drop-in with proxyChat's callback contract so
// chatPanelProvider can route to it behind the `hypeproofChat.coachRuntime`
// flag (Phase 1), falling back to the proxy runtime when the SDK isn't present.
//
// Side effects are injected as callbacks (onDelta / onCitations / onAssetScore /
// requestApproval) — this module stays `vscode`-free and testable, same split
// as proxyClient. The SDK is loaded via a dynamic import so this file compiles
// and ships even before the dependency is installed; when it's absent this
// throws SdkUnavailableError so the caller can fall back to the proxy path
// instead of surfacing a raw error to the student.

import type { AssetScoreChunk, Citation, ResolvedProfile } from "./protocol";
import {
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
  /** Worker gateway base, exposed to the SDK as ANTHROPIC_BASE_URL. */
  gatewayUrl: string;
  token: string;
  model: string;
  profile: ResolvedProfile;
  /** Cohort system prompt text (tuned Korean coaching script). */
  systemPrompt: string;
  history: { role: string; content: string }[];
  userText: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onCitations: (citations: Citation[]) => void;
  onAssetScore: (score: AssetScoreChunk) => void;
  /** Manual-approve gate. Resolves true to allow the tool. */
  requestApproval: (action: CoachToolAction) => Promise<boolean>;
}

/** npm package that provides the SDK once wired (Phase 1). */
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * Minimal shape we rely on from the Agent SDK. Documentation-only: the real
 * types come from the package once it is a dependency. Kept here so the mapping
 * is explicit and Phase 1 is a small step.
 */
interface AgentSdkModule {
  query(input: {
    prompt: string | AsyncIterable<unknown>;
    options: {
      systemPrompt: string;
      model: string;
      /**
       * Tools auto-approved WITHOUT hitting canUseTool. We keep this EMPTY on
       * purpose — every tool must fall through to canUseTool so the host modal
       * gates it. (A bare entry like "Read" would silently bypass the gate.)
       */
      allowedTools: string[];
      /**
       * Filesystem setting sources the SDK reads allow/deny rules from. Pinned
       * to [] so a workspace `.claude/settings.json` in a classroom checkout
       * can't inject allow-rules that bypass canUseTool.
       */
      settingSources: string[];
      permissionMode: string;
      maxTurns: number;
      /**
       * Environment for the spawned CLI. The SDK REPLACES the subprocess env
       * with this (it does not merge), so we spread process.env to keep PATH
       * etc., and route model calls through our worker via the SDK-recognized
       * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN (custom names do nothing).
       */
      env?: Record<string, string | undefined>;
      canUseTool?: (
        name: string,
        input: unknown,
      ) => Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown }>;
      abortController?: AbortController;
    };
  }): AsyncIterable<Record<string, unknown>>;
}

async function loadSdk(): Promise<AgentSdkModule> {
  try {
    // Variable specifier → TS treats the import as `any`, so this file
    // typechecks and bundles without the dependency present yet.
    const spec: string = SDK_PACKAGE;
    const mod = (await import(spec)) as unknown as AgentSdkModule;
    return mod;
  } catch (err) {
    // Keep the technical detail for developers (console), NOT for the student.
    console.warn(`[coach] failed to load ${SDK_PACKAGE}:`, err);
    throw new SdkUnavailableError(
      `agent-sdk runtime selected but ${SDK_PACKAGE} is not installed. ` +
        `Falling back to the proxy runtime (Phase-0 spike, #282).`,
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

  const sdk = await loadSdk();
  const opts = profileToAgentOptions(args.profile, {
    model: args.model,
    systemPrompt: args.systemPrompt,
  });

  // Compose the transcript into a single prompt string for the spike. Phase 1
  // switches to the SDK streaming-input session API to preserve real history.
  const transcript = args.history.map((m) => `${m.role}: ${m.content}`).join("\n");
  const prompt = transcript ? `${transcript}\nuser: ${args.userText}` : args.userText;

  const stream = sdk.query({
    prompt,
    options: {
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      allowedTools: [],
      settingSources: [],
      permissionMode: opts.permissionMode,
      maxTurns: opts.maxTurns,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: args.gatewayUrl,
        ANTHROPIC_AUTH_TOKEN: args.token,
      },
      // Every tool call routes here (allowedTools is empty). First enforce the
      // cohort's permitted set, then gate the survivors through the host modal.
      canUseTool: async (name: string, input: unknown) => {
        if (!opts.permittedTools.includes(name)) {
          return { behavior: "deny" as const };
        }
        const ok = await args.requestApproval({ toolName: name, input });
        return ok ? { behavior: "allow" as const, updatedInput: input } : { behavior: "deny" as const };
      },
      abortController,
    },
  });

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
