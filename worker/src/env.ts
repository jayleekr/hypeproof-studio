// Shared binding shape — keep in sync with wrangler.toml

export interface Env {
  // Secrets (wrangler secret put)
  ANTHROPIC_API_KEY: string;
  HPS_SIGNING_SECRET: string;
  HPS_ADMIN_PASSWORD?: string;       // fallback if Cloudflare Access not used

  // Vars
  ENVIRONMENT: "production" | "dev";

  // Bindings
  HPS_KV: KVNamespace;
  HPS_DB: D1Database;
  HPS_ANALYTICS: AnalyticsEngineDataset;
}
