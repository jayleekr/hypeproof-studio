// Chalk's own request plumbing: request id + signing-secret guard.
//
// Small, and deliberately NOT imported from worker/src/middleware: those are
// typed on the Service's full Env and its hono instance. Chalk re-uses the
// PURE rule (validateSigningSecret, shared.ts) — the part that could drift —
// and keeps the ~20 lines of framework glue local. The error-body shape
// ({ error: { type, message, request_id } }) matches the Service so the
// console's error mapping sees one format from either origin.

import type { Context, Next } from "hono";
import type { ChalkEnv } from "./env.ts";
import { validateSigningSecret } from "./shared.ts";

export type ChalkCtx = Context<{ Bindings: ChalkEnv; Variables: { requestId: string } }>;

export async function requestId(c: ChalkCtx, next: Next): Promise<void> {
  const cfRay = c.req.header("cf-ray");
  const id = cfRay ? cfRay.slice(0, 8) : crypto.randomUUID().slice(0, 8);
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
}

export function makeErrorBody(
  c: ChalkCtx,
  type: string,
  message: string,
  extra?: Record<string, unknown>,
): { error: { type: string; message: string; request_id: string } & Record<string, unknown> } {
  const request_id = c.get("requestId") ?? "no-request-id";
  return { error: { type, message, request_id, ...(extra ?? {}) } };
}

// #258 — fail closed (503 in production) before any token is verified against
// a missing/weak/placeholder secret. Dev warns and continues, same as the
// Service; verify() itself still refuses a rejected secret per call.
export async function signingSecretGuard(c: ChalkCtx, next: Next): Promise<Response | void> {
  const issue = validateSigningSecret(c.env.HPS_SIGNING_SECRET);
  if (issue) {
    const rid = c.get("requestId") ?? "no-request-id";
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
