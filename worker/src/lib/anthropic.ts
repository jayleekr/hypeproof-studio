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

// Transient upstream statuses worth a retry. 4xx (400/401/403/413) are our
// bug, a bad key, or an oversize image — surface those immediately, don't mask
// them. Mirrors gemini.ts RETRYABLE.
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

/**
 * Resilient Anthropic call: retry the SAME model on a transient status
 * (429 / 5xx) with bounded backoff. This is the counterpart to
 * callGeminiResilient (gemini.ts), added for #373 — prod runs
 * LLM_PROVIDER=anthropic and the `/v1/chat` proxy path (the ONLY coach route
 * minor cohorts use — worker force-pins minors to "proxy", chat.ts:181) called
 * the bare `callAnthropic` with no retry, while the gemini branch on the same
 * route already had one. So the 23-concurrent SK Biopharm kids class had zero
 * cushioning: a transient 429 from the shared org ITPM/OTPM pool surfaced as a
 * dead turn on a child's screen.
 *
 * DELIBERATELY no model fallback (unlike gemini's → flash). A minor classroom
 * must not silently drop to a weaker model mid-exercise; that quality
 * trade-off is #373 §3's separate go/no-go, not something to smuggle in here.
 *
 * Safe for streaming: Anthropic returns 429/5xx as an immediate non-200
 * *before* any SSE body, so the status check never races a partially-sent
 * stream. Once a 200 is returned the body streams and can't be retried — same
 * limitation as callGeminiResilient. Bounds added latency to ≤2 extra requests
 * + ~1.3s backoff so a waiting child isn't stuck.
 *
 * `/v1/messages` (Agent SDK route) deliberately does NOT use this — its
 * fast-fail passthrough is intentional (messages.ts) and minors never hit it.
 */
export async function callAnthropicResilient(
  body: AnthropicRequest,
  apiKey: string,
  opts: Parameters<typeof callAnthropic>[2] = {},
): Promise<Response> {
  const MAX_ATTEMPTS = 3; // initial + 2 retries
  let res!: Response;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    res = await callAnthropic(body, apiKey, opts);
    if (res.ok || !RETRYABLE.has(res.status)) return res;
    if (attempt + 1 >= MAX_ATTEMPTS) return res; // exhausted → surface last failure
    await drain(res);
    await sleep(attempt === 0 ? 400 : 900);
  }
  return res;
}
