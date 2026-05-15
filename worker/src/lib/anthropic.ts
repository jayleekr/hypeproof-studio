// Thin Anthropic Messages API client. We call the streaming endpoint and
// return the raw fetch Response so the caller can forward the SSE body.

import type { AnthropicRequest } from "./translate";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export async function callAnthropic(
  body: AnthropicRequest,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(ANTHROPIC_URL, {
    method: "POST",
    signal,
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
