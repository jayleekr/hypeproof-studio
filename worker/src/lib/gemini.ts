// Thin Gemini client via Google's OpenAI-compatible endpoint.
//
// Input is already OpenAI-shaped (see translateOpenAI), and Gemini emits
// OpenAI `chat.completion.chunk` SSE, so we just return the raw fetch Response
// and let the route forward it (passThroughOpenAIStream taps usage only).

import type { OpenAIChatRequest } from "./translate";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

export async function callGemini(
  body: OpenAIChatRequest,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(GEMINI_URL, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}
