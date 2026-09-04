// The ONLY place Chalk reaches into the Service's source tree.
//
// Everything Chalk needs from the Service is re-exported here so the
// dependency is visible in one file and reviewable as a list. Rules:
//
//   • Token verification and instructor authorization are RE-EXPORTED, never
//     copied. chalk/test/instructor-auth-drift.test.mjs asserts `verify` here
//     is the same function object as the Service's and that both workers
//     return identical verdicts for identical tokens. A second implementation
//     would be a second trust boundary around minors' data (spec §4).
//   • Nothing that SIGNS is imported. `issue` / `issueIssuer` stay in the
//     Service; Chalk verifies and forwards, it never mints. (HMAC is
//     symmetric, so the secret could sign — the guarantee is that no code
//     path in this bundle does.)
//   • KV helpers are read-side only (getActiveSession/getRoster/
//     getCohortPause/isTokenRevoked). No startSession/setRoster/revokeToken —
//     the key layout the chat gate reads must be written by one artifact.
//   • The profile registry is imported for display names / cohort membership /
//     dashboard ordering only. Until plan task H moves profiles to KV this
//     means Chalk's bundle carries the (unused) prompt markdown; H replaces
//     this line on both sides with a KV read.
//
// Framework-free: none of these modules import hono, so the two workers can
// pin hono independently without type-identity clashes.

export {
  verify,
  validateSigningSecret,
  TokenError,
  type IssuerScope,
  type TokenPayload,
} from "../../worker/src/lib/tokens.ts";

export {
  authorizeIssuerForCohort,
  isIssuerAllowedEndpoint,
  publicVerifyError,
  type IssuerAuthz,
} from "../../worker/src/lib/instructor-auth.ts";

export {
  getActiveSession,
  getCohortPause,
  getRoster,
  isTokenRevoked,
  type ActiveSession,
  type CohortPause,
} from "../../worker/src/lib/kv.ts";

export { listProfiles } from "../../worker/src/profiles/index.ts";
