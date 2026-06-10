#!/usr/bin/env node
// HypeProof Studio milestone audit/task generator.
//
// This script is intentionally dependency-free so it can run in local shells
// and GitHub Actions without npm install. It audits the current milestone map
// and can create/update GitHub task issues with stable idempotency markers.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd, env, exit } from "node:process";

const REPO = env.REPO || env.GITHUB_REPOSITORY || "jayleekr/hypeproof-studio";
const MARKER_PREFIX = "hps:auto-task:";
const OUT = env.OUT || "milestone-audit.json";

const args = parseArgs(process.argv.slice(2));
const mode = args.mode || "audit";
const dryRun = args["dry-run"] !== false && (args["dry-run"] === true || mode === "audit");
const maxCreate = Number(args["max-create"] || env.MAX_CREATE || 10);
const phaseFilter = String(args.phase || env.PHASE || "all");

const tasks = buildTaskCatalog()
  .filter((task) => phaseFilter === "all" || String(task.phase) === phaseFilter);
const existingIssues = listExistingIssues();
const candidates = tasks.map((task) => resolveTaskState(task, existingIssues));

const summary = {
  repo: REPO,
  mode,
  dry_run: dryRun,
  phase: phaseFilter,
  generated_at: new Date().toISOString(),
  counts: {
    total: candidates.length,
    existing: candidates.filter((t) => t.state === "existing").length,
    create: candidates.filter((t) => t.state === "create").length,
    human_gated: candidates.filter((t) => t.risk === "human").length,
  },
  candidates,
};

if (mode === "issue") {
  createOrUpdateIssues(candidates, { dryRun, maxCreate });
}

writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
printSummary(summary);

function buildTaskCatalog() {
  const metaplan = readIfExists("METAPLAN.md");
  const mandate = readIfExists("docs/AUTONOMY-MANDATE.md");
  if (!metaplan.includes("Phase 7. Release")) {
    fail("METAPLAN.md does not look like the milestone source");
  }
  if (!mandate.includes("Human confirmation required")) {
    fail("docs/AUTONOMY-MANDATE.md does not look like the autonomy source");
  }

  return [
    {
      id: "phase-5-streaming-body-r2-capture",
      phase: 5,
      title: "trace: capture streaming assistant bodies for consented cohorts",
      epic: "#33/#199/#200",
      existingIssue: 33,
      risk: "human",
      labels: ["type:feature", "priority:medium", "autonomy:blocked-human", "milestone:phase-5"],
      body: [
        "Implement streaming response body capture only for cohorts whose profile has `analytics.log_user_messages=true`.",
        "This is human-gated because it changes participant data retention/privacy.",
        "Default action: design and tests only until consent/retention policy is explicitly approved.",
      ],
      acceptance: [
        "Anthropic and OpenAI-compatible streams can be accumulated without changing streamed text behavior.",
        "No body is written when `log_user_messages` is false.",
        "Issue or PR documents the consent/retention gate before any production enablement.",
      ],
    },
    {
      id: "phase-6-notify-release-push-failures",
      phase: 6,
      title: "ci: diagnose notify-release push startup failures",
      epic: "#216/#213",
      existingIssue: 216,
      risk: "low",
      labels: ["type:bug", "priority:medium", "autonomy:ready", "milestone:phase-6"],
      body: [
        "Investigate why `notify-release.yml` has 0s failed push-event runs despite subscribing only to release/workflow_dispatch.",
        "Document whether this is Actions residue/startup failure or workflow registration drift, then patch the workflow/docs if needed.",
      ],
      acceptance: [
        "`gh run list` / workflow metadata evidence is attached in the issue or PR.",
        "If workflow config is wrong, a PR fixes it and includes a dry-run or manual dispatch check.",
        "Release notification expectations mention that CI-created releases with default `GITHUB_TOKEN` do not recurse into `release.published`.",
      ],
    },
    {
      id: "phase-6-mirror-release-workflow",
      phase: 6,
      title: "ci: mirror release assets to hypeproof-studio-releases",
      epic: "#213/#191",
      risk: "medium",
      labels: ["type:feature", "priority:medium", "autonomy:ready", "milestone:phase-6"],
      body: [
        "Add/validate a workflow that mirrors main repo release assets to `jayleekr/hypeproof-studio-releases`.",
        "The workflow must support dry-run and require an explicit PAT secret for cross-repo writes.",
      ],
      acceptance: [
        "Mac and Windows assets are copied by tag when present.",
        "Dry-run lists source assets and target operations without writing.",
        "Missing `MIRROR_RELEASE_PAT` fails with an actionable message, not a partial publish.",
      ],
    },
    {
      id: "phase-6-worker-deploy-workflow",
      phase: 6,
      title: "ci: add manual worker deploy workflow with smoke checks",
      epic: "#191/#200",
      risk: "medium",
      labels: ["type:feature", "priority:medium", "autonomy:ready", "milestone:phase-6"],
      body: [
        "Add/validate a workflow that runs worker tests, deploys with Wrangler on explicit dispatch, and runs prod smoke checks.",
        "The first version should be manual dispatch only; automatic deploy can be a later task after operator confidence.",
      ],
      acceptance: [
        "Dry-run executes tests/typecheck and skips the deploy step.",
        "Real run requires `CLOUDFLARE_API_TOKEN` and reports the deployed Worker version.",
        "`scripts/verify-prod.sh` runs after deploy; L2 uses `HPS_ADMIN_PASSWORD` when configured.",
      ],
    },
    {
      id: "phase-7-release-process-reconcile-version-source",
      phase: 7,
      title: "release: reconcile tag-driven versioning with release docs",
      epic: "#213",
      risk: "low",
      labels: ["type:docs", "priority:medium", "autonomy:ready", "milestone:phase-7"],
      body: [
        "Update release docs/checklists so tag-driven `HPS_VERSION` is declared canonical, or explicitly require bumping source package versions.",
        "Prefer documenting tag-driven versioning because current build scripts already stamp artifacts from the tag.",
      ],
      acceptance: [
        "Release checklist and dev release docs agree on the version source of truth.",
        "Docs mention extension package fallback only for untagged/dev builds.",
        "Docs harness passes if applicable.",
      ],
    },
    {
      id: "phase-7-admin-recovery-path",
      phase: 7,
      title: "ops: add prod admin recovery path",
      epic: "#164/#191",
      existingIssue: 164,
      risk: "human",
      labels: ["type:feature", "priority:high", "autonomy:blocked-human", "milestone:phase-7"],
      body: [
        "Implement or configure a recovery path for lost prod admin password.",
        "This is human-gated because Cloudflare Access policy/admin identity changes require explicit approval.",
      ],
      acceptance: [
        "Chosen recovery path is documented in Worker deploy/runbook docs.",
        "No admin identities or access policies are changed without explicit human confirmation.",
        "A read-only verification command exists for operators.",
      ],
    },
    {
      id: "phase-7-per-cohort-extension-state",
      phase: 7,
      title: "extension: segment history and coach state by cohort",
      epic: "#63",
      existingIssue: 63,
      risk: "low",
      labels: ["type:feature", "priority:medium", "autonomy:ready", "milestone:phase-7"],
      body: [
        "Store chat history and coach state under cohort/profile-aware keys so switching tokens does not leak state across cohorts.",
        "Keep the single active token model; do not add multi-token UI.",
      ],
      acceptance: [
        "Token A history/coach state does not appear after switching to Token B.",
        "Switching back to Token A restores A state.",
        "Existing single-bucket state is migrated once for the active cohort/profile.",
      ],
    },
  ];
}

function listExistingIssues() {
  if (!hasCommand("gh")) return [];
  try {
    const json = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        REPO,
        "--state",
        "all",
        "--limit",
        "1000",
        "--json",
        "number,title,body,state,labels,url",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function resolveTaskState(task, issues) {
  const marker = `${MARKER_PREFIX}${task.id}`;
  const existing = issues.find((issue) => (issue.body || "").includes(marker));
  const existingByNumber = task.existingIssue
    ? issues.find((issue) => Number(issue.number) === Number(task.existingIssue))
    : null;
  const matched = existing || existingByNumber;
  return {
    ...task,
    marker,
    state: matched ? "existing" : "create",
    issue: matched
      ? { number: matched.number, state: matched.state, url: matched.url, title: matched.title }
      : null,
  };
}

function createOrUpdateIssues(items, opts) {
  if (!hasCommand("gh")) fail("gh CLI is required for --mode issue");
  let created = 0;
  for (const item of items) {
    if (item.state !== "create") continue;
    if (created >= opts.maxCreate) break;
    if (opts.dryRun) {
      created += 1;
      continue;
    }
    ensureLabels(item.labels);
    const body = issueBody(item);
    execFileSync(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        REPO,
        "--title",
        item.title,
        "--body",
        body,
        ...item.labels.flatMap((label) => ["--label", label]),
      ],
      { stdio: "inherit" },
    );
    created += 1;
  }
}

function ensureLabels(labels) {
  for (const label of labels) {
    try {
      execFileSync("gh", ["label", "create", label, "--repo", REPO, "--force"], {
        stdio: "ignore",
      });
    } catch {
      // Label creation can fail for permission or existing-label reasons.
      // Issue creation will surface a hard failure if the label is unusable.
    }
  }
}

function issueBody(item) {
  return [
    `<!-- ${item.marker} -->`,
    `Parent/Epic: ${item.epic}`,
    `Milestone phase: ${item.phase}`,
    `Autonomy risk: ${item.risk}`,
    "",
    "## Task",
    ...item.body.map((line) => `- ${line}`),
    "",
    "## Acceptance",
    ...item.acceptance.map((line) => `- [ ] ${line}`),
    "",
    "## Execution",
    item.risk === "human"
      ? "- Human confirmation is required before any prod/account/privacy mutation."
      : "- Eligible for autonomous issue -> branch -> tests -> PR flow.",
  ].join("\n");
}

function printSummary(data) {
  console.log(`milestone audit: ${data.counts.total} candidates`);
  console.log(`  existing:    ${data.counts.existing}`);
  console.log(`  create:      ${data.counts.create}`);
  console.log(`  human-gated: ${data.counts.human_gated}`);
  console.log(`  wrote:       ${OUT}`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function readIfExists(path) {
  const full = join(cwd(), path);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

function hasCommand(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`milestone-audit: ${message}`);
  exit(1);
}
