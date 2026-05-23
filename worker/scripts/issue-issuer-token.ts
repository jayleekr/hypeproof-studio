#!/usr/bin/env -S node --experimental-strip-types
// CLI: mint an instructor's "issuer" token — they can then mint student
// tokens themselves via POST /admin/tokens/issue without ever holding the
// admin password.
//
// Usage:
//   HPS_SIGNING_SECRET="..." node --experimental-strip-types worker/scripts/issue-issuer-token.ts \
//     --instructor tj \
//     --cohorts boah-dental-2026-a \
//     --profiles boah-dental-teaser-2026-s1 \
//     --max-hours 12 \
//     --days 60
//
// Multi-cohort/profile (e.g. for a TA covering both teaser + SK kids):
//   --cohorts boah-dental-2026-a,sk-biopharm-2026-a \
//   --profiles boah-dental-teaser-2026-s1,sk-biopharm-kids-2026-grade-3-4-s1
// (Each cohort gets ALL listed profiles as its scope. For fine-grained
//  per-cohort profile lists, edit the JSON output before signing — or run
//  the script multiple times and merge.)
//
// Optional session-control flags (#167) — lets the instructor self-start/end
// the cohort's session without admin Basic:
//   --can-start-session
//   --max-session-hours 4    # default 4

import { issueIssuer } from "../src/lib/tokens.ts";

function arg(flag: string, fallback?: string): string {
  const i = process.argv.indexOf(flag);
  if (i < 0 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    console.error(`missing required flag: ${flag}`);
    process.exit(2);
  }
  return process.argv[i + 1]!;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

const secret = process.env.HPS_SIGNING_SECRET;
if (!secret || secret.length < 16) {
  console.error("HPS_SIGNING_SECRET env var required (>= 16 chars)");
  process.exit(2);
}

const instructor = arg("--instructor");
const cohorts = arg("--cohorts").split(",").map((s) => s.trim()).filter(Boolean);
const profiles = arg("--profiles").split(",").map((s) => s.trim()).filter(Boolean);
const maxHours = parseInt(arg("--max-hours", "168"), 10);
const days = parseInt(arg("--days", "60"), 10);
const canStartSession = flag("--can-start-session");
const maxSessionHours = parseInt(arg("--max-session-hours", "4"), 10);

if (cohorts.length === 0 || profiles.length === 0) {
  console.error("--cohorts and --profiles each need at least one value");
  process.exit(2);
}
if (canStartSession && (!Number.isFinite(maxSessionHours) || maxSessionHours <= 0 || maxSessionHours > 24)) {
  console.error("--max-session-hours must be 1..24");
  process.exit(2);
}

const scopes = cohorts.map((c) => ({
  cohort: c,
  profiles,
  max_hours: maxHours,
  ...(canStartSession ? { can_start_session: true, max_session_hours: maxSessionHours } : {}),
}));
const { token, jti } = await issueIssuer(
  { issuer: instructor, scopes },
  days * 24,
  secret,
);

const out = {
  type: "issuer-token",
  instructor,
  scopes,
  jti,
  exp_days: days,
  token,
  // One-liner the instructor can put in their .env / clipboard.
  mint_curl_example: `curl -fsS -X POST https://api.hypeproof-ai.xyz/admin/tokens/issue \\
  -H "Authorization: Bearer ${token}" \\
  -H 'content-type: application/json' \\
  -d '{"u":"<student-handle>","c":"${cohorts[0]}","p":"${profiles[0]}","hours":6}'`,
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
