// Shared binding shape — keep in sync with wrangler.toml

export type LLMProvider = "gemini" | "anthropic" | "openai";

export interface Env {
  // Secrets (wrangler secret put — locally: worker/.dev.vars, gitignored)
  GEMINI_API_KEY?: string;           // default provider key (see resolveProvider)
  ANTHROPIC_API_KEY?: string;        // peer — used when LLM_PROVIDER=anthropic
  OPENAI_API_KEY?: string;           // peer — used when LLM_PROVIDER=openai
  HPS_SIGNING_SECRET: string;
  HPS_ADMIN_PASSWORD?: string;       // used if Cloudflare Access not configured

  // Vars
  ENVIRONMENT: "production" | "dev";
  // Switchable upstream LLM. Defaults to "gemini" when GEMINI_API_KEY is set.
  // Set "anthropic" / "openai" (with their key) to switch — peers, NOT fallback.
  LLM_PROVIDER?: LLMProvider;
  // Override Anthropic endpoint URL — used to route through a region-pinned
  // proxy (e.g. hypeproof-sediment Fly NRT) when CF anycast egress hits an
  // Anthropic-blocked region (HK). Leave unset to call api.anthropic.com.
  ANTHROPIC_PROXY_URL?: string;
  // Shared secret for the hypeproof-sediment proxy (sediment#3eddd06).
  // Sent as `X-Sediment-Proxy-Secret` to /proxy/anthropic/*; without it the
  // proxy returns 403 and the worker bubbles up 502. Local dev unset →
  // worker calls api.anthropic.com directly, no proxy involved.
  ANTHROPIC_PROXY_SECRET?: string;
  // Discord webhook for in-app bug reports (#64). When set, POST /v1/report
  // best-effort fans a formatted embed into the #hypeproof-studio channel.
  // Unset → reports still persist to D1; only the side-effect is skipped.
  DISCORD_REPORT_WEBHOOK_URL?: string;

  // Bindings
  HPS_KV: KVNamespace;
  HPS_DB: D1Database;
  HPS_ANALYTICS: AnalyticsEngineDataset;
  HPS_TRACES: R2Bucket;             // turn-body dumps (#9), gated on log_user_messages
}

export interface ResolvedProvider {
  provider: LLMProvider;
  apiKey: string;
}

/**
 * Decide which upstream LLM to call and which key to use. Gemini, Anthropic
 * and OpenAI are switchable peers (NOT a runtime fallback chain):
 *  - Explicit LLM_PROVIDER wins, but only if its key is present (else throws).
 *  - With no LLM_PROVIDER, prefer keys in order: gemini > anthropic > openai
 *    (preserves the pre-OpenAI default, so existing deployments don't shift).
 *
 * Throws when the chosen provider has no key — surfaced to the client as a
 * 502 config error rather than a silent unauthenticated upstream call.
 */
export function resolveProvider(env: Env): ResolvedProvider {
  const gem = env.GEMINI_API_KEY?.trim();
  const ant = env.ANTHROPIC_API_KEY?.trim();
  const oai = env.OPENAI_API_KEY?.trim();

  if (env.LLM_PROVIDER === "anthropic") {
    if (!ant) throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
    return { provider: "anthropic", apiKey: ant };
  }
  if (env.LLM_PROVIDER === "gemini") {
    if (!gem) throw new Error("LLM_PROVIDER=gemini but GEMINI_API_KEY is not set");
    return { provider: "gemini", apiKey: gem };
  }
  if (env.LLM_PROVIDER === "openai") {
    if (!oai) throw new Error("LLM_PROVIDER=openai but OPENAI_API_KEY is not set");
    return { provider: "openai", apiKey: oai };
  }
  // No explicit provider → preserve historical default order.
  if (gem) return { provider: "gemini", apiKey: gem };
  if (ant) return { provider: "anthropic", apiKey: ant };
  if (oai) return { provider: "openai", apiKey: oai };
  throw new Error(
    "no LLM key configured (set GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY in worker/.dev.vars)",
  );
}
