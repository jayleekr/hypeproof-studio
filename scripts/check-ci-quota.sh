#!/usr/bin/env bash
# Detect GitHub Actions runner allocation failures, which usually mean account
# quota/billing/runner availability rather than a workflow-code failure.
#
# Usage:
#   bash scripts/check-ci-quota.sh
#   REPO=jayleekr/hypeproof-studio LIMIT=30 bash scripts/check-ci-quota.sh
#
# Exit codes:
#   0 no allocation failures found in inspected failed runs
#   1 tool/API error
#   2 allocation failures detected

set -euo pipefail

REPO="${REPO:-jayleekr/hypeproof-studio}"
LIMIT="${LIMIT:-25}"

note() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit "${2:-1}"; }

command -v gh >/dev/null 2>&1 || die "gh CLI is required"

note "inspecting recent workflow runs (repo=$REPO limit=$LIMIT)"

runs="$(gh api "repos/$REPO/actions/runs?per_page=$LIMIT" \
  --jq '.workflow_runs[]
    | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")
    | [.id, .name, .display_title, .conclusion, .html_url]
    | @tsv')" || die "failed to list workflow runs"

if [[ -z "$runs" ]]; then
  ok "no failed/cancelled/timed_out runs in last $LIMIT"
  exit 0
fi

found=0
inspected=0

while IFS=$'\t' read -r run_id workflow title conclusion url; do
  [[ -n "${run_id:-}" ]] || continue
  inspected=$((inspected + 1))

  jobs="$(gh api "repos/$REPO/actions/runs/$run_id/jobs?per_page=100" \
    --jq '.jobs[]
      | select((.runner_id == 0 or .runner_id == null or .runner_name == "" or .runner_name == null)
          and ((.steps | length) == 0)
          and (.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out"))
      | [.id, (.runner_id // "null"), .conclusion]
      | @tsv')" || die "failed to list jobs for run $run_id"

  if [[ -n "$jobs" ]]; then
    found=$((found + 1))
    warn "allocation failure: run=$run_id workflow=$workflow conclusion=$conclusion"
    warn "  title: $title"
    warn "  url:   $url"
    while IFS=$'\t' read -r job_id runner_id job_conclusion; do
      [[ -n "${job_id:-}" ]] || continue
      warn "  job=$job_id runner_id=$runner_id runner_name=<empty> conclusion=$job_conclusion steps=0"
    done <<< "$jobs"
  fi
done <<< "$runs"

if [[ "$found" -gt 0 ]]; then
  cat >&2 <<'HINT'

Likely cause: GitHub Actions could not allocate a runner. For this repo that
usually means private-repo Actions quota/spending limit, billing, or missing
self-hosted runner capacity. This is not evidence that the workflow steps or
code changed incorrectly.

Next actions:
- Check GitHub Billing → Actions minutes / spending limit.
- Register or start the self-hosted runner for expensive Mac/Windows builds.
- Keep release/mirror/deploy paths manual until runner allocation is restored.
HINT
  exit 2
fi

ok "no runner allocation failures found in $inspected failed/cancelled/timed_out runs"
