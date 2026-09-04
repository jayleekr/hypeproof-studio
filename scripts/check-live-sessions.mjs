#!/usr/bin/env node
// Live-class deploy freeze (docs/plan/dag.yaml task D, issue #676;
// docs/plan/vessel-and-modules.md §6 stage 2).
//
// WHY
//   2026-08-22: #668 deployed one hour into a live class. The rule against
//   that existed only in prose. Nothing enforced it.
//
//   The worker already knows whether a class is live — GET /admin/cohorts
//   returns every cohort's ActiveSession (worker/src/lib/kv.ts
//   getActiveSession). So ask it. Do NOT maintain a separate calendar: a
//   second source of truth about "is a class running" is a second thing that
//   can be wrong, and the instructor only ever updates one of them.
//
// WHAT IT GATES
//   - the worker deploy (.github/workflows/deploy-worker.yml)
//   - STABLE app tag builds (build-mac.yml / build-windows.yml). A stable tag
//     publishes a non-prerelease GitHub Release, which the in-app update
//     checker surfaces as a banner and mirror-release.yml propagates.
//     Telling a room of participants to reinstall mid-class is the same
//     failure as a mid-class deploy.
//   - NOT dev-channel `-rc` tags. Task A made those prereleases, which the
//     updater skips and /releases/latest excludes — they reach nobody by
//     design, so freezing them buys nothing and would kill the dev channel
//     during exactly the hours it is most needed. The workflows decide that
//     with scripts/tag-is-prerelease.sh and simply do not call this script.
//
// FAIL CLOSED — deliberate. See the long note above classify() for the
// reasoning and the exact failure taxonomy.
//
// USAGE
//   # CLI (workflows):
//   node scripts/check-live-sessions.mjs
//   #   exit 0 -> proceed        exit 1 -> blocked        exit 2 -> usage error
//   #
//   #   env:
//   #     HPS_ADMIN_PASSWORD  admin Basic credential (required unless fixture)
//   #     HPS_API_BASE        default https://api.hypeproof-ai.xyz
//   #     HPS_FREEZE_OVERRIDE "true" -> proceed anyway, loudly, and record it
//   #     HPS_FREEZE_CONTEXT  free text stamped into the audit line
//   #                         (deploy-worker.yml passes task C's worker
//   #                         version, so the audit trail says WHAT was
//   #                         deployed over a live class)
//   #     HPS_FREEZE_FIXTURE  path to a JSON file to read INSTEAD of calling
//   #                         the API — this is what makes the control cases
//   #                         runnable with no live class and no deploy
//   #     HPS_FREEZE_NOW      ISO8601 "now" override (controls only)
//   #     GITHUB_OUTPUT       when set, decision/live_sessions are written
//   #                         there for the workflow to read
//   #
//   # Library (scripts/test-check-live-sessions.mjs):
//   import { classify, isLive } from "./check-live-sessions.mjs";
//
// The decision is a pure function (classify) over a payload + a clock, so the
// control cases run in milliseconds against fixtures. A control that needs a
// real workshop to run is not a control.

const DEFAULT_API_BASE = "https://api.hypeproof-ai.xyz";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Mirror of worker/src/lib/kv.ts `isSessionLive`, deliberately using the same
 * Date.parse semantics so the freeze cannot disagree with the runtime about
 * what "live" means. Returns null (NOT false) when a timestamp is
 * unparseable — the caller treats "cannot tell" as a block, whereas the
 * worker treats it as not-live. That divergence is intentional: the worker
 * fails open so a malformed record never locks students out of chat; the
 * freeze fails closed so a malformed record never lets a deploy through.
 *
 * @returns {true|false|null} true = live, false = not live, null = undecidable
 */
export function isLive(session, now) {
  if (!session || typeof session !== "object") return false;
  const start = Date.parse(session.starts_at);
  const end = Date.parse(session.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const t = now.getTime();
  return t >= start && t <= end;
}

/**
 * The whole decision, as a pure function.
 *
 * FAIL CLOSED, and here is why.
 *
 * The tempting argument for fail-open is real: if api.hypeproof-ai.xyz is
 * unreachable then chat is down, so either no class is running or the class
 * is already broken and the deploy is the fix. Rejected anyway, for three
 * reasons:
 *
 *   1. A check that fails open is indistinguishable, in the run log, from a
 *      check that passed. It looks like protection while providing none —
 *      strictly worse than no check, because it stops people from thinking.
 *      Every failure mode below prints WHY it blocked.
 *   2. "The API is down" is not the only failure. A missing
 *      HPS_ADMIN_PASSWORD, a rotated credential, a 401, a Cloudflare 5xx in
 *      front of a perfectly healthy worker, a schema drift on
 *      /admin/cohorts — all of those are silent under fail-open, and all of
 *      them are compatible with a class in progress. An unset secret would
 *      disable the control permanently and no one would ever notice.
 *   3. The cost of being wrong is asymmetric. Fail-closed costs one checkbox
 *      (HPS_FREEZE_OVERRIDE / the override_live_session workflow input) on a
 *      deploy that was going to be a judgement call anyway. Fail-open costs
 *      what #668 cost: a live class interrupted, discovered afterwards.
 *
 * The override is the pressure-release valve that makes fail-closed
 * affordable, which is why it exists and why it is recorded.
 *
 * @param {unknown} payload  parsed body of GET /admin/cohorts, or an Error
 * @param {Date} now
 * @returns {{decision: "proceed"|"blocked", reason: string, liveCount: number,
 *            live: Array<{cohort: string, profile_id?: string, ends_at?: string, state: string}>,
 *            message: string}}
 */
export function classify(payload, now) {
  // --- transport / credential failures: block, and say which one ---------
  if (payload instanceof Error) {
    return blocked("query_failed", 0, [], `could not ask the worker whether a class is live: ${payload.message}`);
  }
  if (payload === null || typeof payload !== "object") {
    return blocked("bad_payload", 0, [], `/admin/cohorts returned a non-object payload (${typeof payload})`);
  }
  if (!Array.isArray(payload.cohorts)) {
    // Schema drift, or an error body like {"error":"admin not configured"}.
    const hint = typeof payload.error === "string" ? ` (body said: ${payload.error})` : "";
    return blocked("bad_payload", 0, [], `/admin/cohorts payload has no \`cohorts\` array${hint}`);
  }

  // --- the actual question ----------------------------------------------
  const live = [];
  for (const cohort of payload.cohorts) {
    if (cohort === null || typeof cohort !== "object") {
      live.push({ cohort: "<malformed cohort entry>", state: "undecidable" });
      continue;
    }
    const id = typeof cohort.id === "string" ? cohort.id : "<unnamed cohort>";
    const session = cohort.session;
    if (session === null || session === undefined) continue; // no session: fine
    const verdict = isLive(session, now);
    if (verdict === null) {
      live.push({
        cohort: id,
        profile_id: typeof session.profile_id === "string" ? session.profile_id : undefined,
        state: "undecidable",
      });
    } else if (verdict === true) {
      live.push({
        cohort: id,
        profile_id: typeof session.profile_id === "string" ? session.profile_id : undefined,
        ends_at: typeof session.ends_at === "string" ? session.ends_at : undefined,
        state: "live",
      });
    }
  }

  if (live.length === 0) {
    return {
      decision: "proceed",
      reason: "no_live_sessions",
      liveCount: 0,
      live: [],
      message:
        `no live sessions across ${payload.cohorts.length} ` +
        `${plural(payload.cohorts.length, "cohort")} at ${now.toISOString()}`,
    };
  }

  const undecidable = live.filter((l) => l.state === "undecidable").length;
  const reason = undecidable === live.length ? "undecidable_session" : "live_session";
  return blocked(
    reason,
    live.length,
    live,
    `${live.length} live ${plural(live.length, "session")} at ${now.toISOString()}: ` +
      live
        .map((l) =>
          l.state === "undecidable"
            ? `${l.cohort} (session timestamps unparseable — treated as live)`
            : `${l.cohort}${l.profile_id ? `/${l.profile_id}` : ""} until ${l.ends_at ?? "?"}`,
        )
        .join(", "),
  );
}

function plural(n, word) {
  return n === 1 ? word : `${word}s`;
}

function blocked(reason, liveCount, live, message) {
  return { decision: "blocked", reason, liveCount, live, message };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function fetchCohorts() {
  const fixture = process.env.HPS_FREEZE_FIXTURE;
  if (fixture) {
    // Control path. Never hits the network; a fixture that is not valid JSON
    // exercises the bad-payload branch on purpose.
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(fixture, "utf8");
    try {
      return JSON.parse(raw);
    } catch (err) {
      return new Error(`fixture ${fixture} is not JSON: ${err.message}`);
    }
  }

  const base = (process.env.HPS_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
  const password = process.env.HPS_ADMIN_PASSWORD;
  if (!password) {
    // Fail closed: an unset secret must not silently disable the freeze.
    return new Error(
      "HPS_ADMIN_PASSWORD is not set, so the freeze cannot ask the worker whether a class is live",
    );
  }
  const auth = Buffer.from(`:${password}`).toString("base64");
  try {
    const res = await fetch(`${base}/admin/cohorts`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      return new Error(`GET ${base}/admin/cohorts -> HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    return new Error(`GET ${base}/admin/cohorts failed: ${err.message}`);
  }
}

async function main() {
  const override = /^(1|true|yes)$/i.test(process.env.HPS_FREEZE_OVERRIDE ?? "");
  const context = process.env.HPS_FREEZE_CONTEXT || "(no context supplied)";
  const nowRaw = process.env.HPS_FREEZE_NOW;
  const now = nowRaw ? new Date(nowRaw) : new Date();
  if (!Number.isFinite(now.getTime())) {
    console.error(`HPS_FREEZE_NOW is not a parseable date: ${nowRaw}`);
    return 2;
  }

  const payload = await fetchCohorts();
  const result = classify(payload, now);

  const { appendFileSync } = await import("node:fs");
  const ghOut = process.env.GITHUB_OUTPUT;
  const ghSummary = process.env.GITHUB_STEP_SUMMARY;
  const write = (file, text) => {
    if (file) appendFileSync(file, text);
  };

  if (result.decision === "proceed") {
    console.log(`live-session freeze: PASS — ${result.message}`);
    write(ghOut, `decision=proceed\nreason=${result.reason}\nlive_sessions=0\noverride=false\n`);
    return 0;
  }

  if (override) {
    // Proceed, but never quietly. The audit line carries the context the
    // caller handed us (deploy-worker.yml passes task C's worker version), so
    // afterwards it is answerable WHAT was deployed over a live class.
    const audit =
      `live-session freeze OVERRIDDEN — reason=${result.reason} ` +
      `live_sessions=${result.liveCount} context=${context} at=${now.toISOString()}`;
    console.log(`::warning::${audit}`);
    console.log(`live-session freeze: ${result.message}`);
    console.log(audit);
    write(ghOut, `decision=override\nreason=${result.reason}\nlive_sessions=${result.liveCount}\noverride=true\n`);
    write(
      ghSummary,
      `### ⚠️ Live-session deploy freeze OVERRIDDEN\n\n` +
        `- **what**: \`${context}\`\n` +
        `- **reason**: \`${result.reason}\`\n` +
        `- **live sessions**: ${result.liveCount}\n` +
        `- **when**: ${now.toISOString()}\n` +
        `- **detail**: ${result.message}\n`,
    );
    return 0;
  }

  console.log(`::error::live-session deploy freeze: ${result.message}`);
  console.error(`live-session freeze: BLOCKED (${result.reason})`);
  console.error(result.message);
  console.error("");
  console.error("This gate fails CLOSED: 'cannot tell' blocks too. See the note in");
  console.error("scripts/check-live-sessions.mjs for why.");
  console.error("");
  console.error("Ways out, in order of preference:");
  console.error("  1. Wait for the class to end (or close the session in /console).");
  console.error("  2. App release only: cut a `-rc` tag instead. Dev-channel tags are");
  console.error("     exempt — the updater skips prereleases, so they reach nobody.");
  console.error("  3. Genuinely urgent: re-run with the override input set");
  console.error("     (deploy-worker.yml: override_live_session=true; build-mac.yml /");
  console.error("     build-windows.yml: dispatch against the tag ref with");
  console.error("     override_live_session=true). It is recorded in the job summary.");
  write(ghOut, `decision=blocked\nreason=${result.reason}\nlive_sessions=${result.liveCount}\noverride=false\n`);
  write(
    ghSummary,
    `### ⛔ Blocked by the live-session deploy freeze\n\n` +
      `- **reason**: \`${result.reason}\`\n` +
      `- **live sessions**: ${result.liveCount}\n` +
      `- **detail**: ${result.message}\n`,
  );
  return 1;
}

// Only run the CLI when executed directly; importing must be side-effect-free
// so the control harness can exercise classify() without touching the network.
// pathToFileURL, not a `file://` template — build-windows.yml runs this on
// windows-2022, where a raw path never matches import.meta.url.
const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
