// Instructor (issuer-token) authorization — the ONE implementation.
//
// Shared by two Cloudflare Workers that deploy on different trains:
//   • Service worker (worker/, w*) — every instructor-Bearer WRITE
//     (session start/end/open/close, roster append, student-token mint)
//     goes through authorizeIssuerFor* here before touching the state the
//     participant chat gate reads.
//   • Chalk (chalk/, c*) — the instructor surface re-exports this module
//     (chalk/src/shared.ts) for its READS (GET /admin/cohorts/:id/state, and
//     the board in plan task G).
//
// Why it lives in worker/src/lib and not in chalk/: the Service is the trust
// anchor — it holds the mint side (lib/tokens.ts issue/issueIssuer) and the
// hot-path gate. Chalk only verifies. Two workers, one verifier: a second,
// divergent copy of this logic would be a second trust boundary around
// minors' data (docs/plan/vessel-and-modules.md §4, dag.yaml task F negative
// control). chalk/test/instructor-auth-drift.test.mjs runs the same token
// fixtures through BOTH workers and fails if their verdicts ever differ, and
// asserts Chalk's `verify` IS this module's `verify` (same function object),
// not a copy.
//
// Framework-free on purpose: takes `{ env, req.header }` rather than a Hono
// Context, so it never pins the two workers to one hono package instance.

import type { Env } from "../env";
import { isTokenRevoked } from "./kv";
import { verify, TokenError, type IssuerScope, type TokenPayload } from "./tokens";

/** The two bindings authorization needs — nothing else from the Service Env. */
export type InstructorAuthEnv = Pick<Env, "HPS_SIGNING_SECRET" | "HPS_KV">;

/** Minimal request shape: only the Authorization header is consulted. */
export interface InstructorAuthRequest {
  env: InstructorAuthEnv;
  req: { header: (k: string) => string | undefined };
}

export interface IssuerAuthz {
  scope: IssuerScope;
  payload: TokenPayload;
}

// #257 — verify() failures surface curated TokenError prose only; anything
// else (crypto/config internals) is logged server-side, client gets a
// generic message.
export function publicVerifyError(err: unknown, label: string): string {
  if (err instanceof TokenError) return `invalid ${label} token: ${err.message}`;
  console.error(`${label} token verify failed:`, err);
  return `invalid ${label} token`;
}

// Path-scoped issuer-Bearer exceptions on the Service's /admin/* prefix. Each
// endpoint listed here re-verifies the issuer token + checks scope inside its
// own handler; the admin middleware just lets the request through gating so
// the handler can do the real check. All other admin paths stay admin-only.
//
// Chalk consumes the SAME predicate as its forwarding allowlist: the set of
// Service endpoints an instructor Bearer may reach is defined exactly once.
export function isIssuerAllowedEndpoint(path: string, method: string): boolean {
  if (path === "/admin/tokens/issue" && method === "POST") return true;
  // #167 — issuer-role tokens with can_start_session scope may start/end
  // their scoped cohort's session without admin Basic auth.
  if (method === "POST" && /^\/admin\/cohorts\/[^/]+\/session$/.test(path)) return true;
  if (method === "DELETE" && /^\/admin\/cohorts\/[^/]+\/session$/.test(path)) return true;
  // #290 — scoped issuers may append to their cohort's roster and use the
  // composite session open/close endpoints (self-service workshop ops).
  if (method === "POST" && /^\/admin\/cohorts\/[^/]+\/roster\/append$/.test(path)) return true;
  if (method === "POST" && /^\/admin\/cohorts\/[^/]+\/session\/(open|close)$/.test(path)) return true;
  // #295 — an admin-tier minter (issuer token with can_issue_issuers) may mint
  // instructor issuers via Bearer. The handler re-verifies the token AND the
  // capability; a Bearer minter still cannot create another admin-minter.
  if (path === "/admin/issuers" && method === "POST") return true;
  // GET /admin/cohorts/:id/state (#352) is deliberately ABSENT: it moved to
  // Chalk with plan task F and is answered there, never forwarded.
  return false;
}

// #167 / #290 — when an issuer-role Bearer is presented, re-verify + scope
// check. Returns `null` if no Bearer was present (so the caller knows the
// middleware admitted via Basic/CF Access on the Service — Chalk treats null
// as 401, it has no admin path). Returns a Response on Bearer-but-not-
// authorized cases; the caller returns it as-is.
//
// Cohort-level authority: ANY scope on this cohort is enough (no
// can_start_session needed — minting rights already imply the minted student
// must be able to join the roster / the instructor must be able to see state).
export async function authorizeIssuerForCohort(
  c: InstructorAuthRequest,
  cohortId: string,
): Promise<IssuerAuthz | null | Response> {
  const auth = c.req.header("authorization") ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!bearerMatch || !bearerMatch[1]) return null;

  let payload: TokenPayload;
  try {
    payload = await verify(bearerMatch[1], c.env.HPS_SIGNING_SECRET);
  } catch (err) {
    return Response.json(
      { error: publicVerifyError(err, "issuer") },
      { status: 401 },
    );
  }
  if (payload.role !== "issuer") {
    return Response.json({ error: "token is not an issuer" }, { status: 403 });
  }
  const scope = (payload.scopes ?? []).find((s) => s.cohort === cohortId);
  if (!scope) {
    return Response.json(
      { error: `issuer not scoped to cohort=${cohortId}` },
      { status: 403 },
    );
  }
  if (payload.jti) {
    const rev = await isTokenRevoked(c.env.HPS_KV, payload.jti);
    if (rev) return Response.json({ error: "issuer token revoked" }, { status: 401 });
  }
  return { scope, payload };
}

// Session-control authority: the matched scope must carry can_start_session.
// `requireProfileId`: when set, the matched scope must include this profile
// (start needs it; end does not — end just kills the current session).
export async function authorizeIssuerForSession(
  c: InstructorAuthRequest,
  cohortId: string,
  requireProfileId: string | null,
): Promise<IssuerAuthz | null | Response> {
  const auth = c.req.header("authorization") ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!bearerMatch || !bearerMatch[1]) return null;
  const issuerToken = bearerMatch[1];

  let payload: TokenPayload;
  try {
    payload = await verify(issuerToken, c.env.HPS_SIGNING_SECRET);
  } catch (err) {
    return Response.json(
      { error: publicVerifyError(err, "issuer") },
      { status: 401 },
    );
  }
  if (payload.role !== "issuer") {
    return Response.json({ error: "token is not an issuer" }, { status: 403 });
  }
  const scopes: IssuerScope[] = payload.scopes ?? [];
  const scope = scopes.find(
    (s) =>
      s.cohort === cohortId &&
      s.can_start_session === true &&
      (requireProfileId === null || (s.profiles?.includes(requireProfileId) ?? false)),
  );
  if (!scope) {
    return Response.json(
      {
        error: requireProfileId
          ? `issuer not scoped for session start on (cohort=${cohortId}, profile=${requireProfileId}). scope needs can_start_session=true.`
          : `issuer not scoped for session control on cohort=${cohortId}. scope needs can_start_session=true.`,
      },
      { status: 403 },
    );
  }
  if (payload.jti) {
    const rev = await isTokenRevoked(c.env.HPS_KV, payload.jti);
    if (rev) return Response.json({ error: "issuer token revoked" }, { status: 401 });
  }
  return { scope, payload };
}
