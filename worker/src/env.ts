// Shared binding shape — keep in sync with wrangler.toml

export type LLMProvider = "gemini" | "anthropic" | "openai" | "glm";

export interface Env {
  // Secrets (wrangler secret put — locally: worker/.dev.vars, gitignored)
  GEMINI_API_KEY?: string;           // default provider key (see resolveProvider)
  ANTHROPIC_API_KEY?: string;        // peer — used when LLM_PROVIDER=anthropic
  OPENAI_API_KEY?: string;           // peer — used when LLM_PROVIDER=openai
  // peer — used when LLM_PROVIDER=glm. Z.ai 의 Anthropic 호환 경로로 나간다
  // (lib/glm.ts). 발급: https://z.ai/manage-apikey/apikey-list
  GLM_API_KEY?: string;
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
/**
 * 지정한 프로바이더의 키를 준다. **UC(프로필)마다 다른 모델을 동시에 쓰기 위한 것.**
 *
 * `resolveProvider` 는 배포 전체의 기본값 하나를 고른다. 그런데 쓰임새는 하나가 아니다 —
 * 아이들 수업은 싸고 빠른 쪽이, 고위험 산출물은 비싸도 정확한 쪽이 맞는다. 프로필이
 * `model.provider` 를 선언하면 그 요청만 그쪽으로 나가고, 선언하지 않은 프로필은
 * 배포 기본값을 그대로 쓴다.
 *
 * 키가 없으면 던진다 — 인증 없는 상류 호출을 조용히 하지 않는다. 프로필이 가리키는
 * 프로바이더의 키를 안 넣어두면 **그 프로필만** 502 가 되고 나머지는 정상이다.
 */
export function providerKey(env: Env, provider: LLMProvider): string {
  const key = {
    gemini: env.GEMINI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    glm: env.GLM_API_KEY,
  }[provider]?.trim();
  if (!key) {
    throw new Error(`profile pins provider=${provider} but its API key is not set`);
  }
  return key;
}

export function resolveProvider(env: Env): ResolvedProvider {
  const gem = env.GEMINI_API_KEY?.trim();
  const ant = env.ANTHROPIC_API_KEY?.trim();
  const oai = env.OPENAI_API_KEY?.trim();
  const glm = env.GLM_API_KEY?.trim();

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
  if (env.LLM_PROVIDER === "glm") {
    if (!glm) throw new Error("LLM_PROVIDER=glm but GLM_API_KEY is not set");
    return { provider: "glm", apiKey: glm };
  }
  // No explicit provider → preserve historical default order.
  // GLM 은 **일부러 이 순서에 없다.** 키를 넣었다는 이유만으로 수업 트래픽의 상류가
  // 바뀌면 안 된다. GLM 을 쓰려면 LLM_PROVIDER=glm 을 명시한다.
  if (gem) return { provider: "gemini", apiKey: gem };
  if (ant) return { provider: "anthropic", apiKey: ant };
  if (oai) return { provider: "openai", apiKey: oai };
  throw new Error(
    "no LLM key configured (set GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / GLM_API_KEY in worker/.dev.vars)",
  );
}
