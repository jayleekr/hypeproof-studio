// Thin OpenAI Chat Completions client. Our `/v1/chat/completions` already
// uses the OpenAI schema, so the body is passed straight through — no
// translation beyond model id swap + system-prompt injection (handled in
// translateOpenAI, shared with Gemini). Returns the raw fetch Response so
// the caller can forward the SSE body or read JSON.

import type { OpenAIChatRequest } from "./translate";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Dev-only override: `OPENAI_BASE_URL` (e.g. http://127.0.0.1:8790/v1) routes
 * the OpenAI-shaped call to a local shim. Production never sets it — the
 * default is the real endpoint. Same pattern as anthropic.ts countTokensUrl.
 */
export function openAIChatUrl(baseUrl?: string): string {
  const b = baseUrl?.trim();
  return b ? b.replace(/\/+$/, "") + "/chat/completions" : OPENAI_URL;
}

export async function callOpenAI(
  body: OpenAIChatRequest,
  apiKey: string,
  signal?: AbortSignal,
  baseUrl?: string,
): Promise<Response> {
  return fetch(openAIChatUrl(baseUrl), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}
