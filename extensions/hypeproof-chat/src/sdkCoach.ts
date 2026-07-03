// Phase-0 spike (#282) — ORCHESTRATION: run the coach on the Claude Agent SDK
// instead of the single-turn proxy. Drop-in with proxyChat's callback contract
// so chatPanelProvider can route to it behind the `hypeproofChat.coachRuntime`
// flag with a one-line branch (Phase 1).
//
// Side effects are injected as callbacks (onDelta / onCitations / onAssetScore /
// requestApproval) — this module stays `vscode`-free and testable, same split
// as proxyClient. The SDK is loaded via a dynamic import so this file compiles
// and ships even before the dependency is installed; flipping the flag without
// the dep throws a clear, single error instead of breaking the live proxy path.

import type { AssetScoreChunk, Citation, ResolvedProfile } from "./protocol";
import { profileToAgentOptions } from "./sdkCoachHelpers";

/** A tool action the coach wants to perform, surfaced to the host modal. */
export interface CoachActionRequest {
  kind: "write_file" | "edit_file" | "run" | "web_search" | string;
  detail: string;
}

export interface SdkCoachArgs {
  /** Worker gateway base (fronts the shared classroom key — no key on device). */
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
  /** Manual-approve gate (essence #16). Resolves true to allow the tool. */
  requestApproval: (action: CoachActionRequest) => Promise<boolean>;
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
      allowedTools: string[];
      permissionMode: string;
      maxTurns: number;
      // Fronts the shared key through our worker instead of a per-device key.
      // (Exact wiring — base URL vs custom fetch/auth — is a Phase-1 detail.)
      env?: Record<string, string>;
      canUseTool?: (name: string, input: unknown) => Promise<{ behavior: "allow" | "deny" }>;
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
  } catch {
    throw new Error(
      `[coach] agent-sdk runtime selected but ${SDK_PACKAGE} is not installed yet. ` +
        `This is the Phase-0 spike (#282); keep hypeproofChat.coachRuntime = "proxy" until Phase 1 wires the SDK.`,
    );
  }
}

/**
 * Run one coach turn on the Agent SDK. Mirrors proxyChat's contract so the
 * caller doesn't care which runtime produced the stream.
 */
export async function runSdkCoach(args: SdkCoachArgs): Promise<void> {
  const sdk = await loadSdk();
  const opts = profileToAgentOptions(args.profile, {
    model: args.model,
    systemPrompt: args.systemPrompt,
  });

  const abortController = new AbortController();
  args.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  // Compose the transcript into a single prompt string for the spike. Phase 1
  // switches to the SDK streaming-input session API to preserve real history.
  const transcript = args.history.map((m) => `${m.role}: ${m.content}`).join("\n");
  const prompt = transcript ? `${transcript}\nuser: ${args.userText}` : args.userText;

  const stream = sdk.query({
    prompt,
    options: {
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      allowedTools: opts.allowedTools,
      permissionMode: opts.permissionMode,
      maxTurns: opts.maxTurns,
      env: { HYPEPROOF_GATEWAY: args.gatewayUrl, HYPEPROOF_TOKEN: args.token },
      // Every tool use is gated through the existing host modal.
      canUseTool: async (name: string, input: unknown) => {
        const ok = await args.requestApproval({
          kind: name.toLowerCase(),
          detail: typeof input === "string" ? input : JSON.stringify(input),
        });
        return { behavior: ok ? "allow" : "deny" };
      },
      abortController,
    },
  });

  // Map SDK messages → the proxyChat callback shape. Field access is defensive
  // (Record<string,unknown>) until the real SDK types land in Phase 1.
  for await (const msg of stream) {
    const type = String((msg as Record<string, unknown>).type ?? "");
    if (type === "assistant" || type === "text" || type === "content_block_delta") {
      const delta = extractText(msg);
      if (delta) args.onDelta(delta);
    } else if (type === "result" || type === "message_stop") {
      // terminal — nothing to emit; caller posts streamEnd
    }
    if (args.signal.aborted) break;
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
