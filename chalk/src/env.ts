// Chalk binding shape — keep in sync with chalk/wrangler.toml.
//
// Deliberately NOT the Service's Env (worker/src/env.ts): Chalk holds no LLM
// keys, no admin password, no Analytics Engine, no R2. The two bindings it
// shares with the Service (HPS_KV, HPS_DB) are the same physical namespace
// and database; the one secret it shares (HPS_SIGNING_SECRET) is the same
// HMAC key — that is what lets the shared verifier accept the same tokens.

export interface ChalkEnv {
  // Secret — MUST equal the Service's value (wrangler secret put on both).
  HPS_SIGNING_SECRET: string;

  // Vars
  ENVIRONMENT: "production" | "dev";
  // Surface-layer release identifier, tag prefix c* (e.g. "c0.1.0").
  // Injected per-deploy by .github/workflows/deploy-chalk.yml; unset locally.
  // Read it through resolveChalkVersion() only.
  HPS_CHALK_VERSION?: string;
  // Service origin for forwarded instructor writes. Unset → production.
  HPS_SERVICE_ORIGIN?: string;
  // ISO8601 instant at which task B (#684, observed usage_log.status) reached
  // production. Rows at or after it carry a real status, so the board's failure
  // columns mean something. UNSET => the board reports the failure columns as
  // `unknown`, never as zero — the safe direction if an operator forgets to set
  // it. See board-verdict.ts `resolveErrorSignal`.
  HPS_ERROR_SIGNAL_FROM?: string;
  /**
   * Secret — #680 task I. Break-glass operator credential for session-log
   * RETRIEVAL only (GET /admin/cohorts/:id/logs/:seat/:day/:session/:file),
   * presented in the `x-hps-operator-secret` header. Deliberately NOT the
   * Service's HPS_ADMIN_PASSWORD: that value is broadly held and would make
   * every class-opener a reader of participants' verbatim question text.
   * Unset => retrieval fails closed (503) unless Cloudflare Access fronts the
   * path. Listing endpoints never consult it. See src/routes/logs-admin.ts.
   */
  HPS_LOGS_OPERATOR_SECRET?: string;

  // Bindings (shared with the Service — read-only from Chalk's side)
  HPS_KV: KVNamespace;
  HPS_DB: D1Database;
  // The Service's log/trace bucket. Chalk holds it for the studio-logs READ
  // path (#680) and touches nothing else under it. LIST + GET only — no put,
  // no delete anywhere in this bundle (chalk/test/logs-read-path.test.mjs
  // asserts that on the source). Wrangler has no read-only R2 binding, so the
  // guarantee is code + test, not configuration.
  HPS_TRACES: R2Bucket;
}

export const DEFAULT_SERVICE_ORIGIN = "https://api.hypeproof-ai.xyz";

// Same contract as the Service's resolveWorkerVersion (task C): unset, empty
// or whitespace collapses to "unknown" — never a crash, never "".
export function resolveChalkVersion(env: Pick<ChalkEnv, "HPS_CHALK_VERSION">): string {
  const v = env.HPS_CHALK_VERSION;
  return typeof v === "string" && v.trim().length > 0 ? v : "unknown";
}

export function resolveServiceOrigin(env: Pick<ChalkEnv, "HPS_SERVICE_ORIGIN">): string {
  const v = env.HPS_SERVICE_ORIGIN?.trim();
  return v && v.length > 0 ? v.replace(/\/+$/, "") : DEFAULT_SERVICE_ORIGIN;
}
