#!/usr/bin/env bash
# Deterministic worker prod deploy harness.
#
# Wraps `npx wrangler deploy` with:
#   1. Preflight: clean tree, on main, in sync with origin/main.
#   2. Deploy (top-level env — wrangler.toml has multiple env blocks).
#   3. Capture active version ID.
#   4. Post-deploy /v1/health smoke.
#   5. Optional full prod smoke via scripts/verify-prod.sh when TOKEN or
#      HPS_ADMIN_PASSWORD is present.
#   6. Print a one-block summary (timestamp · version · health).
#
# Usage:
#   bash scripts/deploy-worker.sh                  # interactive confirm
#   FORCE=1 bash scripts/deploy-worker.sh          # skip confirmation
#   PROD_URL=https://api.hypeproof-ai.xyz \
#     bash scripts/deploy-worker.sh                # override the verify URL
#
# Exit codes: 0 OK · 1 preflight failure · 2 deploy failure · 3 verify failure.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROD_URL="${PROD_URL:-https://api.hypeproof-ai.xyz}"

note() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit "${2:-1}"; }

# 1. Preflight ----------------------------------------------------------------
note "preflight: branch + sync + tree"

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || die "must be on main (current: $branch). switch to main first."

# Working tree must be clean. Submodule modified content is OK — that's the
# rename residue documented in build-pipeline.md, plus `-dirty` from any
# local vscodium build. Pass --ignore-submodules to both git diff calls so
# those don't wedge the deploy.
if ! git diff --quiet --ignore-submodules || ! git diff --cached --quiet --ignore-submodules; then
  die "working tree dirty. commit or stash first."
fi

# Fetch + ensure we're at origin/main HEAD.
git fetch --quiet origin main
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
[ "$local_sha" = "$remote_sha" ] || \
  die "local main is not at origin/main HEAD. pull --ff-only first."

ok "on main @ $(git log -1 --format='%h %s' HEAD)"

# 2. Confirm (unless FORCE=1) -------------------------------------------------
if [ "${FORCE:-0}" != "1" ]; then
  recent_merges="$(git log --oneline --merges HEAD~5..HEAD 2>/dev/null || true)"
  echo
  echo "About to deploy worker → $PROD_URL"
  echo "Last 5 commits:"
  git log --oneline -5
  echo
  printf "Proceed? [y/N] "
  read -r ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || die "aborted by user."
fi

# 3. Deploy -------------------------------------------------------------------
note "deploy (top-level env)"
cd worker
# --env="" targets the top-level wrangler.toml env (silences the multi-env
# warning that wrangler 4.x prints).
if ! npx wrangler deploy --env="" 2>&1 | tee /tmp/hps-deploy.log; then
  # The Upload step may have succeeded even if a tail step (cron schedules)
  # failed. Check for that pattern before declaring failure.
  if grep -q "Uploaded hypeproof-studio-api" /tmp/hps-deploy.log; then
    warn "deploy exited non-zero, but Upload succeeded — likely a non-blocking"
    warn "side-effect (e.g. cron schedules, workers.dev subdomain)."
  else
    die "wrangler deploy failed before upload. see /tmp/hps-deploy.log" 2
  fi
fi

# 4. Capture active version ---------------------------------------------------
note "capture active version"
version_id="$(npx wrangler deployments status 2>/dev/null \
  | awk '/Version\(s\):/{ print $NF; exit }' || true)"
[ -n "$version_id" ] || warn "could not parse active version id (cosmetic)"

cd "$REPO_ROOT"

# 5. Health smoke -------------------------------------------------------------
note "post-deploy health: $PROD_URL/v1/health"
health="$(curl -fsS --max-time 10 "$PROD_URL/v1/health" || true)"
if echo "$health" | grep -q '"ok":true'; then
  ok "health 200 — $health"
else
  die "health check failed: $health" 3
fi

# 6. Optional full smoke -------------------------------------------------------
if [[ -n "${TOKEN:-}" || -n "${HPS_ADMIN_PASSWORD:-}" ]]; then
  note "post-deploy full smoke: scripts/verify-prod.sh"
  PROD="$PROD_URL" bash scripts/verify-prod.sh
  ok "full smoke passed"
else
  warn "full smoke skipped (set TOKEN for profile+chat, HPS_ADMIN_PASSWORD for deep health)"
fi

# 7. Summary ------------------------------------------------------------------
echo
ok "deploy summary"
printf "  time:    %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf "  commit:  %s\n" "$(git log -1 --format='%h %s' HEAD)"
printf "  version: %s\n" "${version_id:-<unparsed>}"
printf "  url:     %s\n" "$PROD_URL"
printf "  health:  %s\n" "$health"
