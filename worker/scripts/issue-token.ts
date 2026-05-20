#!/usr/bin/env -S node --experimental-strip-types
// CLI: mint a HypeProof Studio workshop token.
//
// Usage:
//   HPS_SIGNING_SECRET="..." node --experimental-strip-types worker/scripts/issue-token.ts \
//     --user kid01 --cohort sk-biopharm-2026-a --profile sk-biopharm-kids-2026-grade-3-4-s1 --hours 168
//
// Token version is fixed at v2. Pass --hours 168 (7d) for workshop tokens that
// span the full 2-month series — actual access is still gated by the active
// class window (set in admin UI).
//
// Output: by default just the token on stdout (backward compatible with the
// existing dental smoke script). Pass --json to also print the jti, exp, and
// the curl one-liner to revoke this exact token (S-01 / #46).

import { issue } from "../src/lib/tokens.ts";

function arg(flag: string, fallback?: string): string {
  const i = process.argv.indexOf(flag);
  if (i < 0 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    console.error(`missing required flag: ${flag}`);
    process.exit(2);
  }
  return process.argv[i + 1]!;
}

const secret = process.env.HPS_SIGNING_SECRET;
if (!secret || secret.length < 16) {
  console.error("HPS_SIGNING_SECRET env var required (>= 16 chars)");
  process.exit(2);
}

const u = arg("--user");
const c = arg("--cohort");
const p = arg("--profile");
const hours = parseInt(arg("--hours", "168"), 10);
const wantsJson = process.argv.includes("--json");

const { token, jti } = await issue({ u, c, p }, hours, secret);

if (wantsJson) {
  const exp = Math.floor(Date.now() / 1000) + hours * 3600;
  const out = {
    token,
    jti,
    user: u,
    cohort: c,
    profile: p,
    exp,
    revoke_curl: `curl -fsS -X POST https://api.hypeproof-ai.xyz/admin/tokens/revoke \\
  -H "Authorization: Basic $(printf ':%s' "$HPS_ADMIN_PASSWORD" | base64)" \\
  -H 'content-type: application/json' \\
  -d '${JSON.stringify({ jti, cohort: c, user: u, exp, reason: "manual" })}'`,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
} else {
  process.stdout.write(token + "\n");
  // jti to stderr so pipelines that capture stdout still get just the token,
  // but a human running the script sees the audit fields.
  process.stderr.write(`jti: ${jti}\n`);
}
