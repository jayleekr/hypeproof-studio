// Signing-secret runtime guard (#258).
//
// Fail-closed front door for token-authenticated routes. When
// HPS_SIGNING_SECRET is missing/weak/placeholder:
//   - production  → 503 with a sanitized message. Serving would mean either
//     rejecting every token confusingly (401s) or, worse, verifying against a
//     guessable key.
//   - dev         → warn + continue, so `wrangler dev` stays usable while the
//     operator fixes .dev.vars. verify()/issue() still enforce the same gate
//     per-call (shared helper in lib/tokens.ts), so nothing signs or verifies
//     with a rejected secret in ANY environment.
//
// NOT applied to /v1/report (REQ-H6: anonymous bug reporting must survive
// config breakage — its optional token check already try/catches) nor to
// /v1/health (ops probe; no token involved).

import type { Context, Next } from "hono";
import type { Env } from "../env.ts";
import { validateSigningSecret } from "../lib/tokens.ts";
import { makeErrorBody } from "./request-id.ts";

export async function signingSecretGuard(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
  next: Next,
): Promise<Response | void> {
  const issue = validateSigningSecret(c.env.HPS_SIGNING_SECRET);
  if (issue) {
    const rid = c.get("requestId") ?? "no-request-id";
    // Category only — never the secret value.
    console.error(
      `[${rid}] HPS_SIGNING_SECRET rejected (${issue}) — ` +
        (c.env.ENVIRONMENT === "production" ? "failing closed (503)" : "dev mode, continuing"),
    );
    if (c.env.ENVIRONMENT === "production") {
      return c.json(
        makeErrorBody(c, "config", "service unavailable: server signing key misconfigured — contact the operator"),
        503,
      );
    }
  }
  await next();
}
