// Pure allow-list predicate for issuer-Bearer access to /admin/* endpoints.
// Extracted from admin.ts so it can be unit-tested without importing the full
// Hono app (which pulls in directory imports that node's ESM loader can't
// resolve in the smoke harness).
//
// Each endpoint listed here is admitted past the admin Basic/CF-Access gate so
// its handler can do the real issuer re-verify + cohort-scope check. Everything
// not listed stays admin-only.
export function isIssuerAllowedEndpoint(path: string, method: string): boolean {
  if (path === "/admin/tokens/issue" && method === "POST") return true;
  // #167 — issuer-role tokens with can_start_session scope may start/end
  // their scoped cohort's session without admin Basic auth.
  if (method === "POST" && /^\/admin\/cohorts\/[^/]+\/session$/.test(path)) return true;
  if (method === "DELETE" && /^\/admin\/cohorts\/[^/]+\/session$/.test(path)) return true;
  // #191 — instructor self-service: an issuer scoped to a cohort (with
  // can_start_session) may set that cohort's roster without the admin password.
  // The handler re-verifies the token + cohort scope (authorizeIssuerForSession).
  if (method === "POST" && /^\/admin\/cohorts\/[^/]+\/roster$/.test(path)) return true;
  return false;
}
