// Thin Anthropic Messages API client. We call the streaming endpoint and
// return the raw fetch Response so the caller can forward the SSE body.
//
// URL override (#26): the call can be routed through a region-pinned proxy
// (e.g. hypeproof-sediment Fly NRT) when CF Workers' anycast lands fetches
// on a PoP Anthropic's geo policy refuses (HKG). The proxy is a transparent
// passthrough — same headers, same body, same SSE — so callers don't change
// shape based on the override.

import type { AnthropicRequest } from "./translate";

const DEFAULT_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/**
 * Beta flag the worker always needs: without it the upstream response omits
 * cache_read_input_tokens / cache_creation_input_tokens and our usage
 * accounting under-reports cache traffic.
 */
export const PROMPT_CACHING_BETA = "prompt-caching-2024-07-31";

/**
 * Merge the client's `anthropic-beta` header with our own (#282 e2e BLOCKER).
 *
 * The Agent SDK CLI sets its own `anthropic-beta` header (e.g.
 * `context-management-2025-06-27`, required for the `context_management`
 * body field it sends on every turn). Hard-coding only our caching beta
 * DROPPED the client's flags → upstream 400 → gateway 502 → the SDK retried
 * 10x and every turn died. Per Anthropic convention multiple betas are
 * comma-joined in a single header; we keep ours first and append the
 * client's, deduped.
 */
export function mergeAnthropicBeta(clientBeta?: string | null): string {
  const merged = [PROMPT_CACHING_BETA];
  for (const part of (clientBeta ?? "").split(",")) {
    const flag = part.trim();
    if (flag && !merged.includes(flag)) merged.push(flag);
  }
  return merged.join(",");
}

/**
 * Token-counting endpoint URL (#282 follow-up: /v1/messages/count_tokens).
 * Derived from the same base as the Messages call so the ANTHROPIC_PROXY_URL
 * indirection (#26 sediment region pin) keeps working: the proxy is a
 * transparent passthrough under /proxy/anthropic/*, so appending the subpath
 * to the configured messages URL routes count_tokens through it too.
 */
export function countTokensUrl(baseUrl?: string): string {
  return (baseUrl ?? DEFAULT_URL).replace(/\/+$/, "") + "/count_tokens";
}

export async function callAnthropic(
  body: AnthropicRequest,
  apiKey: string,
  opts: {
    url?: string;
    signal?: AbortSignal;
    proxySecret?: string;
    /**
     * Raw inbound `anthropic-beta` header from the client request, merged
     * with our own flags (see mergeAnthropicBeta). Undefined → ours only.
     */
    clientBeta?: string | null;
    /**
     * Preserve the client's `?beta=true` query on the upstream URL. The
     * Agent SDK CLI calls POST /v1/messages?beta=true; dropping the query
     * changes which request shape the upstream accepts, so we forward it.
     */
    beta?: boolean;
  } = {},
): Promise<Response> {
  let url = opts.url ?? DEFAULT_URL;
  if (opts.beta) url += (url.includes("?") ? "&" : "?") + "beta=true";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    // Ours (prompt caching, required for cache usage fields) merged with the
    // client's flags — the Agent SDK needs its own betas honored upstream.
    "anthropic-beta": mergeAnthropicBeta(opts.clientBeta),
  };
  // Sediment proxy (sediment#3eddd06, 2026-05-24) requires a shared secret on
  // /proxy/anthropic/* — without this header the proxy returns 403 and the
  // worker bubbles it up as a 502 to the client. The same fetch goes
  // straight to api.anthropic.com when ANTHROPIC_PROXY_URL is unset (dev),
  // in which case proxySecret is also undefined and we omit the header.
  if (opts.proxySecret) {
    headers["X-Sediment-Proxy-Secret"] = opts.proxySecret;
  }
  return fetch(url, {
    method: "POST",
    signal: opts.signal,
    headers,
    body: JSON.stringify(body),
  });
}
