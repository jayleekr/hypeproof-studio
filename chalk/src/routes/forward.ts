// Instructor WRITE forwarder — Chalk → Service.
//
// The console and issuer pages call session open/close, roster append and
// student-token mint with relative URLs (/admin/…). Those endpoints did not
// move: they write the KV keys the participant chat gate reads on every
// request, and they sign tokens, so they stay in the Service artifact
// (worker/src/routes/admin.ts). Chalk forwards them server-side, which keeps
// the pages same-origin (no CORS opened on the participant runtime) and keeps
// the Service byte-identical on /admin/*.
//
// Allowlist = the Service's own isIssuerAllowedEndpoint (shared.ts): exactly
// the set an instructor Bearer may reach over there. Not a second list.
//
// Forwarded headers are a whitelist: Authorization (Bearer only — Basic is
// refused here, Chalk is never a path to the admin password) and
// Content-Type. In particular `cf-access-authenticated-user-email`, which
// the Service's admin middleware trusts, is NEVER forwarded.

import type { Context } from "hono";
import { resolveChalkVersion, resolveServiceOrigin, type ChalkEnv } from "../env.ts";
import { isIssuerAllowedEndpoint } from "../shared.ts";

type Ctx = Context<{ Bindings: ChalkEnv; Variables: { requestId: string } }>;

export async function forwardInstructorWrite(c: Ctx): Promise<Response> {
  const rid = c.get("requestId") ?? "no-request-id";
  const url = new URL(c.req.url);
  const method = c.req.method.toUpperCase();

  if (!isIssuerAllowedEndpoint(url.pathname, method)) {
    return c.json(
      { error: { type: "not_found", message: "not an instructor endpoint", request_id: rid, path: url.pathname } },
      404,
    );
  }
  const auth = c.req.header("authorization") ?? "";
  if (!/^Bearer\s+\S/i.test(auth.trim())) {
    return c.json(
      { error: { type: "auth", message: "instructor issuer token required (Authorization: Bearer …)", request_id: rid } },
      401,
    );
  }

  const origin = resolveServiceOrigin(c.env);
  const target = `${origin}${url.pathname}${url.search}`;
  const headers = new Headers({ authorization: auth.trim() });
  const ct = c.req.header("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("x-hps-forwarded-by", `chalk/${resolveChalkVersion(c.env)}`);
  headers.set("x-request-id", rid);

  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const buf = await c.req.arrayBuffer();
    if (buf.byteLength > 0) body = buf;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body });
  } catch (err) {
    console.error(`[${rid}] forward to ${origin} failed:`, err);
    return c.json(
      { error: { type: "upstream", message: "service unreachable — instructor write not applied", request_id: rid } },
      502,
    );
  }

  // Pass the Service's verdict through untouched (status + JSON body): the
  // pages already map its error prose, and a 401/403 from the Service IS the
  // authorization decision — Chalk does not second-guess it.
  const out = new Headers({
    "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
    "x-request-id": rid,
    "x-hps-forwarded-to": new URL(origin).host,
  });
  const upstreamRid = upstream.headers.get("x-request-id");
  if (upstreamRid) out.set("x-hps-service-request-id", upstreamRid);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
