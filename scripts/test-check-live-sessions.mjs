#!/usr/bin/env node
// Controls for scripts/check-live-sessions.mjs (docs/plan/dag.yaml task D).
//
// The dag names three controls:
//   positive  live_sessions == 0                       -> exit 0, deploy proceeds
//   negative  live_sessions > 0, no override           -> non-zero, message names the count
//   also      override_live_session == true            -> proceeds, override recorded
//                                                         together with task C's worker version
//
// .claude/rules/verification.md rule 2: a positive control catches a gate that
// is too strict (blocks legitimate deploys forever, so someone disables it); a
// negative control catches a gate that is too permissive (the #668 failure).
// Rule 3: every case here plants a known answer, so a broken checker shows up
// immediately instead of being read off an artifact.
//
// Runs in milliseconds. No live class, no deploy, no network — the CLI cases
// go through HPS_FREEZE_FIXTURE, which reads a JSON file instead of calling
// /admin/cohorts.
//
//   node scripts/test-check-live-sessions.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { classify, isLive } from "./check-live-sessions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "check-live-sessions.mjs");
const TMP = mkdtempSync(join(tmpdir(), "hps-freeze-"));

let failed = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  failed += 1;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

// The planted clock. Every fixture below is written relative to it, so "live"
// and "not live" are facts of the fixture, not of when the test runs.
const NOW = new Date("2026-08-22T10:00:00Z");

const session = (startsAt, endsAt, profile = "sk-biopharm-kids-s1") => ({
  session_id: "sess-planted",
  profile_id: profile,
  starts_at: startsAt,
  ends_at: endsAt,
});

// --------------------------------------------------------------------------
console.log("=== 1. isLive — the same window rule as worker/src/lib/kv.ts ===");
// --------------------------------------------------------------------------

check(isLive(session("2026-08-22T09:00:00Z", "2026-08-22T12:00:00Z"), NOW) === true,
  "inside the window -> live");
check(isLive(session("2026-08-22T12:00:00Z", "2026-08-22T14:00:00Z"), NOW) === false,
  "before it starts -> not live");
check(isLive(session("2026-08-22T06:00:00Z", "2026-08-22T09:00:00Z"), NOW) === false,
  "already ended -> not live (KV keeps the record ~5 min past ends_at)");
// Boundary: the worker's isSessionLive uses >= / <=, so both edges are live.
check(isLive(session("2026-08-22T10:00:00Z", "2026-08-22T12:00:00Z"), NOW) === true,
  "exactly at starts_at -> live (matches the worker's >= boundary)");
check(isLive(session("2026-08-22T08:00:00Z", "2026-08-22T10:00:00Z"), NOW) === true,
  "exactly at ends_at -> live (matches the worker's <= boundary)");
// Non-Z offsets: instructors open sessions from a KST browser.
check(isLive(session("2026-08-22T18:00:00+09:00", "2026-08-22T21:00:00+09:00"), NOW) === true,
  "+09:00 offset parsed as an instant, not as wall-clock text");
check(isLive(session("not-a-date", "2026-08-22T12:00:00Z"), NOW) === null,
  "unparseable timestamp -> null (undecidable), NOT false");

// --------------------------------------------------------------------------
console.log("\n=== 2. classify — planted answers ===");
// --------------------------------------------------------------------------

// POSITIVE CONTROL. Realistic shape: several cohorts, some with a session
// record that has already ended. This is the case that must NOT block, and it
// is the one that catches an over-strict gate.
const quiet = {
  cohorts: [
    { id: "sk-biopharm-kids", session: null },
    { id: "boah-dental", session: session("2026-08-22T06:00:00Z", "2026-08-22T09:00:00Z") },
    { id: "canary", session: null },
  ],
};
let r = classify(quiet, NOW);
check(r.decision === "proceed" && r.liveCount === 0,
  `positive: no live session -> proceed (${r.reason})`);

// NEGATIVE CONTROL. This is #668: a class one hour in.
const inClass = {
  cohorts: [
    { id: "sk-biopharm-kids", session: session("2026-08-22T09:00:00Z", "2026-08-22T12:00:00Z") },
    { id: "boah-dental", session: null },
  ],
};
r = classify(inClass, NOW);
check(r.decision === "blocked" && r.liveCount === 1, `negative: live class -> blocked (${r.reason})`);
check(/\b1 live session/.test(r.message), "negative: message names the count");
check(r.message.includes("sk-biopharm-kids"), "negative: message names the cohort");

r = classify(
  {
    cohorts: [
      { id: "a", session: session("2026-08-22T09:00:00Z", "2026-08-22T12:00:00Z") },
      { id: "b", session: session("2026-08-22T09:30:00Z", "2026-08-22T11:00:00Z") },
    ],
  },
  NOW,
);
check(r.liveCount === 2 && /\b2 live sessions/.test(r.message), "negative: counts every live cohort");

// FAIL-CLOSED CONTROLS. Each of these is a way the check itself can break.
// Every one of them must block, and must say which failure it was.
const failClosed = [
  [new Error("fetch failed"), "query_failed", "network error"],
  [new Error("GET .../admin/cohorts -> HTTP 401"), "query_failed", "rejected credential"],
  [new Error("HPS_ADMIN_PASSWORD is not set"), "query_failed", "unset secret"],
  [null, "bad_payload", "null body"],
  ["<html>502 Bad Gateway</html>", "bad_payload", "HTML error page"],
  [{ error: "admin not configured" }, "bad_payload", "worker error body"],
  [{ cohorts: "nope" }, "bad_payload", "schema drift"],
];
for (const [payload, reason, label] of failClosed) {
  const got = classify(payload, NOW);
  check(got.decision === "blocked" && got.reason === reason,
    `fail-closed: ${label} -> blocked/${got.reason}`);
}

// "Cannot tell" is also a block — the deliberate divergence from the worker,
// which treats an unparseable window as not-live.
r = classify({ cohorts: [{ id: "sk-biopharm-kids", session: session("garbage", "garbage") }] }, NOW);
check(r.decision === "blocked" && r.reason === "undecidable_session",
  "fail-closed: unparseable session window -> blocked");
check(r.message.includes("treated as live"), "fail-closed: message says why it could not tell");

// --------------------------------------------------------------------------
console.log("\n=== 3. CLI — exit codes and the override record ===");
// --------------------------------------------------------------------------

function runCli(payload, env = {}) {
  const fixture = join(TMP, `fixture-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(fixture, typeof payload === "string" ? payload : JSON.stringify(payload));
  const ghOutput = join(TMP, `out-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(ghOutput, "");
  const ghSummary = join(TMP, `sum-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(ghSummary, "");
  let status = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(process.execPath, [CLI], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HPS_FREEZE_FIXTURE: fixture,
        HPS_FREEZE_NOW: NOW.toISOString(),
        HPS_ADMIN_PASSWORD: "",
        GITHUB_OUTPUT: ghOutput,
        GITHUB_STEP_SUMMARY: ghSummary,
        ...env,
      },
    });
  } catch (err) {
    status = err.status ?? 1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }
  return {
    status,
    stdout,
    stderr,
    output: readFileSync(ghOutput, "utf8"),
    summary: readFileSync(ghSummary, "utf8"),
  };
}

// positive
let cli = runCli(quiet);
check(cli.status === 0, "positive: CLI exits 0 when nothing is live");
check(cli.output.includes("decision=proceed") && cli.output.includes("live_sessions=0"),
  "positive: GITHUB_OUTPUT records decision=proceed live_sessions=0");

// negative
cli = runCli(inClass);
check(cli.status === 1, "negative: CLI exits non-zero during a live class");
check(/1 live session/.test(cli.stdout + cli.stderr), "negative: CLI output names the count");
check(cli.output.includes("decision=blocked") && cli.output.includes("live_sessions=1"),
  "negative: GITHUB_OUTPUT records decision=blocked live_sessions=1");
check(/\bwait\b/i.test(cli.stderr) && /-rc/.test(cli.stderr),
  "negative: CLI tells the operator the ways out (wait / -rc dev channel / override)");

// also: override, carrying task C's worker version as the audit context
cli = runCli(inClass, {
  HPS_FREEZE_OVERRIDE: "true",
  HPS_FREEZE_CONTEXT: "worker deploy w2026.09.04-1 (task C version)",
});
check(cli.status === 0, "also: override -> CLI exits 0 during a live class");
check(cli.output.includes("decision=override") && cli.output.includes("override=true"),
  "also: GITHUB_OUTPUT records the override");
check(cli.summary.includes("w2026.09.04-1"),
  "also: the job summary records the override WITH task C's worker version");
check(/::warning::/.test(cli.stdout), "also: override is annotated, never silent");

// The override must never be the default, and must not be satisfied by a
// stray empty/false value.
for (const value of ["", "false", "0", "no"]) {
  cli = runCli(inClass, { HPS_FREEZE_OVERRIDE: value });
  check(cli.status === 1, `also: HPS_FREEZE_OVERRIDE='${value}' does NOT override`);
}

// Override also releases a fail-closed block — that is the escape hatch that
// makes fail-closed affordable when the API itself is down.
cli = runCli("not json at all", { HPS_FREEZE_OVERRIDE: "true", HPS_FREEZE_CONTEXT: "hotfix" });
check(cli.status === 0, "also: override releases a fail-closed block too");
cli = runCli("not json at all");
check(cli.status === 1, "fail-closed: unreadable payload blocks without the override");

// --------------------------------------------------------------------------
console.log("\n=== 4. release-freeze-gate.sh — which refs are exempt ===");
// --------------------------------------------------------------------------
// Acceptance: the freeze applies to STABLE app tag builds and `-rc` tags are
// exempt. Both halves get a control, against the SAME live-class fixture, so
// the exemption cannot be an artifact of the fixture.

const GATE = join(HERE, "release-freeze-gate.sh");

function runGate(ref, payload, env = {}) {
  const fixture = join(TMP, `gate-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(fixture, JSON.stringify(payload));
  try {
    const stdout = execFileSync("bash", [GATE, ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HPS_FREEZE_FIXTURE: fixture,
        HPS_FREEZE_NOW: NOW.toISOString(),
        HPS_ADMIN_PASSWORD: "",
        GITHUB_OUTPUT: "",
        GITHUB_STEP_SUMMARY: "",
        ...env,
      },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

let g = runGate("refs/tags/v9.9.9", inClass);
check(g.status === 1, "stable tag during a live class -> frozen");

g = runGate("refs/tags/v9.9.9-rc.1", inClass);
check(g.status === 0, "dev-channel -rc tag during the SAME live class -> exempt");
check(/prerelease/.test(g.stdout), "exemption says why (prerelease reaches nobody)");

g = runGate("refs/heads/main", inClass);
check(g.status === 0, "branch build (publishes no release) -> exempt");

g = runGate("refs/tags/v9.9.9", quiet);
check(g.status === 0, "positive: stable tag with no class running -> proceeds");

g = runGate("refs/tags/v9.9.9", inClass, {
  HPS_FREEZE_OVERRIDE: "true",
  HPS_FREEZE_CONTEXT: "stable app release v9.9.9",
});
check(g.status === 0, "stable tag + explicit override -> proceeds");

// --------------------------------------------------------------------------
console.log("");
if (failed === 0) {
  console.log("PASS: live-session freeze classifies, fails closed, and records overrides.");
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed.`);
  process.exit(1);
}
