// #1298 A-01 — decideMode local verification script.
// Runs decideMode with rehearsal-shaped, class-shaped, and expired tokens
// without needing the dev app. Outputs results to stdout.
//
// Usage: node --experimental-strip-types _worklog/verify-decide-mode.mjs

import { decideMode } from "../extensions/hypeproof-chat/src/chalk/modeDecision.ts";

const NOW = Math.floor(Date.now() / 1000);

function makeToken(exp, claims = {}) {
  const payload = JSON.stringify({ sub: "test", exp, ...claims });
  const b64 = Buffer.from(payload).toString("base64url");
  return `${b64}.fakesig`;
}

const cases = [
  {
    label: "rehearsal token (rehearsal claim, exp +1h, status null)",
    token: makeToken(NOW + 3600, { rehearsal: true, cohort: "sk-biopharm-kids-s1" }),
    status: null,
  },
  {
    label: "class token (exp +8h, status ok)",
    token: makeToken(NOW + 8 * 3600, { cohort: "sk-biopharm-kids-s1" }),
    status: "ok",
  },
  {
    label: "expired token (exp -1s, status null)",
    token: makeToken(NOW - 1, { cohort: "sk-biopharm-kids-s1" }),
    status: null,
  },
  {
    label: "hard-rejected (status expired)",
    token: makeToken(NOW + 3600, { cohort: "sk-biopharm-kids-s1" }),
    status: "expired",
  },
  {
    label: "unreachable (status unreachable) — must stay student",
    token: makeToken(NOW + 3600, { cohort: "sk-biopharm-kids-s1" }),
    status: "unreachable",
  },
  {
    label: "no token — instructor opens",
    token: undefined,
    status: null,
  },
];

console.log("decideMode verification — " + new Date().toISOString());
console.log("─".repeat(60));
let pass = 0, fail = 0;
for (const { label, token, status } of cases) {
  const mode = decideMode({ studentToken: token, studentProfileStatus: status, now: NOW });
  const expected = label.includes("instructor opens") || label.includes("expired token") || label.includes("hard-rejected")
    ? "instructor"
    : "student";
  const ok = mode === expected;
  console.log(`${ok ? "✓" : "✗"} [${mode}] ${label}`);
  ok ? pass++ : fail++;
}
console.log("─".repeat(60));
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
