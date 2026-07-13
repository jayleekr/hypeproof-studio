// Thin Gemini client via Google's OpenAI-compatible endpoint.
//
// Input is already OpenAI-shaped (see translateOpenAI), and Gemini emits
// OpenAI `chat.completion.chunk` SSE, so we just return the raw fetch Response
// and let the route forward it (passThroughOpenAIStream taps usage only).

import type { OpenAIChatRequest } from "./translate";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

// Pro-class pins are intermittently capacity-limited (503 "high demand")
// and Google retires model ids under our feet (#307: gemini-2.5-pro → 404
// for new keys). gemini-2.5-flash was empirically reliable under the same
// load and produces valid filled skeletons, so it's the resilience fallback.
export const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash";

// Transient upstream statuses worth a retry / fallback. 4xx (400/401/403) are
// our bug or a bad key — surface those immediately, don't mask them.
// 404 is handled separately: it means the model id is retired/unknown, so
// retrying the SAME model is pointless, but the fallback model may still work.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Free a failed response's socket before we retry (don't leak the connection).
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already errored/closed */
  }
}

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

export interface GeminiResult {
  response: Response;
  /** The model that actually answered (may differ from body.model on fallback). */
  model: string;
  fellBack: boolean;
}

/**
 * Resilient Gemini call: retry the requested model once on a transient
 * status, then fall back to gemini-2.5-flash (also with one retry). A 404
 * (retired/unknown model id, #307) skips the same-model retry and advances
 * straight to the fallback model — unless we're already on it, in which case
 * the 404 is genuine and surfaced. Bounds added latency to ~2 extra requests
 * + <1.5s backoff so a waiting child isn't stuck. Works for stream and
 * non-stream alike: Gemini returns 503/404 as an immediate non-200 *before*
 * any stream body, so the status check is safe.
 *
 * The returned Response body is never consumed here — the caller pipes it
 * (stream) or reads it (json / error text).
 */
export async function callGeminiResilient(
  body: OpenAIChatRequest,
  apiKey: string,
  signal?: AbortSignal,
): Promise<GeminiResult> {
  const primary = body.model;
  const chain =
    primary === GEMINI_FALLBACK_MODEL ? [primary] : [primary, GEMINI_FALLBACK_MODEL];

  let res!: Response;
  let model = primary;
  for (let mi = 0; mi < chain.length; mi++) {
    model = chain[mi]!;
    const fellBack = mi > 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await callGemini({ ...body, model }, apiKey, signal);
      // 404 = model id retired/unknown upstream (#307). Same-model retries
      // can't help; jump straight to the fallback model. If there is no
      // different model left in the chain, the 404 is genuine — surface it.
      if (res.status === 404 && mi + 1 < chain.length) {
        await drain(res);
        break;
      }
      if (res.ok || !RETRYABLE.has(res.status)) {
        return { response: res, model, fellBack };
      }
      const moreTries = attempt + 1 < 2 || mi + 1 < chain.length;
      if (!moreTries) return { response: res, model, fellBack };
      await drain(res);
      await sleep(attempt === 0 ? 400 : 900);
    }
  }
  return { response: res, model, fellBack: chain.length > 1 };
}
