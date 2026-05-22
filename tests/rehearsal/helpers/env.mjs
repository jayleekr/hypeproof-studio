// Env reading + validation for rehearsal tests (issue #83).
// All tests env-gate; missing optional vars cause individual tests to skip
// with a clear message, NOT a fatal exit.

export const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787/v1";

// Cohort token (Bearer). Used by R1 profile checks + R2 lifecycle + R3 coach +
// R5 rate-limit. Without it most tests skip.
export const TOKEN = process.env.TOKEN ?? "";

// Admin password (basic auth, ":pw"). Used by R1.2 deep-health + R2.4
// cohort-pause + R5.x admin-only checks. Optional.
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";

// Issuer-role token for mint tests (R4). Optional.
export const ISSUER_TOKEN = process.env.ISSUER_TOKEN ?? "";

// Cohort + profile defaults. Override via env to test other cohorts.
export const COHORT = process.env.COHORT ?? "boah-dental-2026-a";
export const PROFILE = process.env.PROFILE ?? "boah-dental-teaser-2026-s1";

export function adminBase() {
  // /v1 in WORKER_URL maps to admin endpoints at the origin.
  return WORKER_URL.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

export function basicAuthHeader(password) {
  // Use Buffer (Node), not btoa, so it works under any runtime.
  const encoded = Buffer.from(`:${password}`).toString("base64");
  return `Basic ${encoded}`;
}

/** Pretty-print which env vars are present for the rehearsal report. */
export function envBanner() {
  return [
    `  WORKER_URL     = ${WORKER_URL}`,
    `  TOKEN          = ${TOKEN ? `set (${TOKEN.slice(0, 12)}…)` : "not set (most tests will skip)"}`,
    `  ADMIN_PASSWORD = ${ADMIN_PASSWORD ? "set" : "not set (admin tests will skip)"}`,
    `  ISSUER_TOKEN   = ${ISSUER_TOKEN ? `set (${ISSUER_TOKEN.slice(0, 12)}…)` : "not set (issuer tests will skip)"}`,
    `  COHORT         = ${COHORT}`,
    `  PROFILE        = ${PROFILE}`,
  ].join("\n");
}

console.log("[rehearsal] env:\n" + envBanner() + "\n");
