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
  opts: { url?: string; signal?: AbortSignal; proxySecret?: string } = {},
): Promise<Response> {
  const url = opts.url ?? DEFAULT_URL;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    // Required to receive cache_read_input_tokens / cache_creation_input_tokens fields.
    "anthropic-beta": "prompt-caching-2024-07-31",
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
