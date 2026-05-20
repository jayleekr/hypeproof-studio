// Thin OpenAI Chat Completions client. Our `/v1/chat/completions` already
// uses the OpenAI schema, so the body is passed straight through — no
// translation beyond model id swap + system-prompt injection (handled in
// translateOpenAI, shared with Gemini). Returns the raw fetch Response so
// the caller can forward the SSE body or read JSON.

import type { OpenAIChatRequest } from "./translate";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export async function callOpenAI(
  body: OpenAIChatRequest,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(OPENAI_URL, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}
