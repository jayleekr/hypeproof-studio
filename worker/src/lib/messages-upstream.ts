// #545 — Resolve WHICH Anthropic-native upstream the /v1/messages coach path
// (the Agent SDK gateway, messages.ts) talks to, and with what credentials.
//
// This is the counterpart to env.ts's resolveProvider, but for a DIFFERENT
// axis. resolveProvider picks gemini/anthropic/openai for the /v1/chat path,
// where non-Anthropic vendors need BODY translation (translate.ts). This
// resolver never translates: /v1/messages speaks the Anthropic Messages
// protocol, and every upstream here speaks it verbatim. Only the transport
// envelope changes — base URL, key, auth-header format, model ids, and which
// beta flags are safe to send.
//
// Default is "anthropic" → byte-for-byte identical to the pre-#545 hardcoded
// path (same ANTHROPIC_API_KEY + ANTHROPIC_PROXY_URL + MODEL_MAP + x-api-key +
// full beta set). Prod stays on Anthropic until MESSAGES_UPSTREAM is flipped.
//
// ⚠️ #424 — "Anthropic-compatible" is not one bit; it has ~13 ways to diverge.
// The GLM branch below sets the SAFEST assumptions and flags every unverified
// one as VERIFY-WITH-LIVE-KEY. Do NOT flip prod to "glm" until each is checked
// against the real GLM key issued in #545:
//   [V1] auth header    — GLM wants Authorization: Bearer (assumed). If x-api-key
//                         also works, harmless; if Bearer is rejected, it 401s.
//   [V2] beta flags      — we send NO anthropic-beta to GLM (sendBeta=false),
//                         because unknown flags (prompt-caching-2024-07-31,
//                         context-management-*) may 400. Confirm GLM's own
//                         caching still bills at the $0.26/1M cached rate WITHOUT
//                         our cache_control betas (Z.AI caches automatically).
//   [V3] count_tokens    — GLM may not implement /v1/messages/count_tokens. If it
//                         404s, PASSTHROUGH_4XX surfaces it and the SDK's context
//                         budgeting degrades gracefully (the #316 known gap), not
//                         a hard failure. Confirm it does not 500.
//   [V4] usage cache     — our tap reads usage.cache_read_input_tokens /
//                         cache_creation_input_tokens. If GLM omits/renames them,
//                         cache columns log 0 (correctness-safe, but 김광현's
//                         token tracking under-reports GLM cache — #545). Confirm
//                         field names against a live GLM response.

import type { Env } from "../env";
import { DEFAULT_URL, GLM_DEFAULT_URL } from "./anthropic";
import { MODEL_MAP, GLM_MODEL_MAP, type ModelAlias } from "../profiles/types";

export interface MessagesUpstream {
  kind: "anthropic" | "glm";
  /** Bearer/x-api-key credential for this upstream. */
  apiKey: string;
  /** Auth header format callAnthropic should use. */
  authStyle: "x-api-key" | "bearer";
  /**
   * Full /v1/messages URL for the upstream, or undefined to let callAnthropic
   * fall back to api.anthropic.com (preserves the exact pre-#545 dev behavior
   * where ANTHROPIC_PROXY_URL is unset). count_tokens is derived from this via
   * countTokensUrl(), so a single value drives both endpoints.
   */
  messagesUrl: string | undefined;
  /** Alias → upstream model id (MODEL_MAP for anthropic, GLM_MODEL_MAP for glm). */
  modelMap: Record<ModelAlias, string>;
  /** Send anthropic-beta header + ?beta=true. False for compat upstreams (V2). */
  sendBeta: boolean;
  /** Sediment region-pin proxy secret — anthropic path only. */
  proxySecret?: string;
}

/**
 * Pick the /v1/messages upstream from env. Throws (→ caller returns a 502
 * config error, never a silent unauthenticated call) when the selected
 * upstream has no key — same fail-closed contract as resolveProvider.
 */
export function resolveMessagesUpstream(env: Env): MessagesUpstream {
  if (env.MESSAGES_UPSTREAM === "glm") {
    const key = env.GLM_API_KEY?.trim();
    if (!key) {
      throw new Error("MESSAGES_UPSTREAM=glm but GLM_API_KEY is not set");
    }
    return {
      kind: "glm",
      apiKey: key,
      authStyle: "bearer", // [V1]
      messagesUrl: env.GLM_ANTHROPIC_BASE_URL?.trim() || GLM_DEFAULT_URL,
      modelMap: GLM_MODEL_MAP,
      sendBeta: false, // [V2]
      // No sediment proxy for GLM — Z.AI is reached directly (or via
      // GLM_ANTHROPIC_BASE_URL if a region-pin proxy is ever needed).
      proxySecret: undefined,
    };
  }

  // Default: Anthropic-native — identical to the pre-#545 hardcoded path.
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return {
    kind: "anthropic",
    apiKey: key,
    authStyle: "x-api-key",
    messagesUrl: env.ANTHROPIC_PROXY_URL, // undefined → callAnthropic uses DEFAULT_URL
    modelMap: MODEL_MAP,
    sendBeta: true,
    proxySecret: env.ANTHROPIC_PROXY_SECRET,
  };
}

// Re-export so messages.ts can reference the default without a second import.
export { DEFAULT_URL };
