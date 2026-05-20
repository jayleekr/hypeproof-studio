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

export async function callAnthropic(
  body: AnthropicRequest,
  apiKey: string,
  opts: { url?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(opts.url ?? DEFAULT_URL, {
    method: "POST",
    signal: opts.signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
      // Required to receive cache_read_input_tokens / cache_creation_input_tokens fields.
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify(body),
  });
}
