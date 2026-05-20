// Request-ID middleware (S-07 / #49).
//
// Generates an 8-char request_id per request, exposes it via:
//   - response header `x-request-id`
//   - Hono context: c.get("requestId")
//
// 8 chars (32 bits of randomUUID's first segment) is enough to be unique
// across a workshop's worth of requests without being annoying to read
// aloud / paste into a DM. Logs in Workers Logs auto-pick this up because we
// also stamp it into the structured `c.json({ error: { ..., request_id } })`
// payload in onError. Operator workflow:
//
//   강사: "에러 났어요 — 0e1f2a3b"
//   Jay: `wrangler tail | grep 0e1f2a3b`

import type { Context, Next } from "hono";
import type { Env } from "../env.ts";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

export async function requestId(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
  next: Next,
): Promise<void> {
  // Prefer the existing CF Ray for cross-system correlation; fall back to a
  // fresh 8-char UUID slice when not present (local dev, scheduled handlers).
  const cfRay = c.req.header("cf-ray");
  const id = cfRay ? cfRay.slice(0, 8) : crypto.randomUUID().slice(0, 8);
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
}

/**
 * Helper for structured error responses. All 4xx/5xx through Hono onError()
 * use this; individual handlers can also call it directly to skip having to
 * import the request-id type.
 */
export function makeErrorBody(
  c: Context<{ Bindings: Env; Variables: { requestId: string } }>,
  type: string,
  message: string,
  extra?: Record<string, unknown>,
): { error: { type: string; message: string; request_id: string } & Record<string, unknown> } {
  const request_id = c.get("requestId") ?? "no-request-id";
  return {
    error: {
      type,
      message,
      request_id,
      ...(extra ?? {}),
    },
  };
}
