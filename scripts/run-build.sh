#!/usr/bin/env bash
# Wrapper for vscodium-base/build.sh that sources nvm + env first.
# Designed to be run in background via run_in_background or nohup.
#
# Usage:
#   bash scripts/run-build.sh [logfile]
# If no logfile is passed, output streams to stdout/stderr.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGFILE="${1:-}"

# Absolutize LOGFILE — we `cd vscodium-base` below, after which a relative
# log path silently resolves under that subdir and the redirect fails with
# "No such file or directory" → build never starts.
if [[ -n "$LOGFILE" && "$LOGFILE" != /* ]]; then
  LOGFILE="$REPO_ROOT/$LOGFILE"
fi

cd "$REPO_ROOT"

# Source nvm and pin to Node 22
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"
nvm use 22.22.1 --silent

# Source cargo (rust) — needed for native module compilation
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# Source HPS env vars (APP_NAME, BINARY_NAME, etc.)
# shellcheck disable=SC1091
. ./hypeproof-studio.env >/dev/null

# Stamp a real commit into product.json. VSCodium's version.sh derives
# BUILD_SOURCEVERSION = sha1sum(RELEASE_VERSION) when unset — with no
# RELEASE_VERSION that hashes a newline to the adc83b19… placeholder, which the
# build then writes to product.json.commit (clobbering apply-product-overrides).
# Default it to the repo HEAD so the About screen shows a real commit (#206).
# Only export when we actually have a value — never export set-but-empty, so a
# git failure leaves it unset and version.sh derives its own value rather than
# treating "" as an authoritative empty commit.
if [[ -z "${BUILD_SOURCEVERSION:-}" ]]; then
  _hps_commit="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ -n "$_hps_commit" ]] && export BUILD_SOURCEVERSION="$_hps_commit"
  unset _hps_commit
fi
echo "  BUILD_SOURCEVERSION=${BUILD_SOURCEVERSION:-<unset — version.sh will derive>}"

# Verify before kicking off the long build
{
  echo "==================================================="
  echo "HypeProof Studio build starting"
  echo "  date:    $(date '+%Y-%m-%d %H:%M:%S')"
  echo "  node:    $(node --version)"
  echo "  python:  $(python3.11 --version 2>&1)"
  echo "  arch:    $(uname -m)"
  echo "  free:    $(df -g / | awk 'NR==2 {print $4" GB"}')"
  echo "  APP:     $APP_NAME"
  echo "  QUALITY: $VSCODE_QUALITY"
  echo "==================================================="
} | tee /dev/stderr

cd vscodium-base

# --- Pre-build reset ---------------------------------------------------------
# build.sh sources prepare_vscode.sh which re-overlays src/stable/* and applies
# all patches. If vscode/ has already been patched, `git apply` fails. And if
# patches/00-update-disable.patch.yet has been renamed to .patch in a prior run,
# the next mv fails. Reset both before each build.

# 1. Restore patches/00-update-disable.patch.yet from git
if git ls-files --error-unmatch patches/00-update-disable.patch.yet >/dev/null 2>&1; then
  rm -f patches/00-update-disable.patch
  git checkout -- patches/00-update-disable.patch.yet 2>/dev/null || true
fi

# 2. Reset vscode/ tree to pristine fetched state.
# get_repo.sh creates vscode/ as a detached git repo at MS_COMMIT. We reset
# hard + clean -fdx to wipe any prior patches, prior extension injection, etc.
if [[ -d vscode/.git ]]; then
  echo "[run-build] resetting vscode/ tree to pristine state"
  (
    cd vscode
    git reset --hard HEAD --quiet
    git clean -fdx --quiet
  )
else
  echo "[run-build] WARNING: vscode/ is not a git repo. Re-run get_repo.sh + prepare_src.sh." >&2
  exit 1
fi
# -----------------------------------------------------------------------------

if [[ -n "$LOGFILE" ]]; then
  exec bash build.sh > "$LOGFILE" 2>&1
else
  exec bash build.sh
fi
