#!/usr/bin/env bash
# Single source of truth for the HypeProof Studio release version (#206).
#
# Prints the resolved x.y.z version to stdout. Resolution order:
#   1. $HPS_VERSION env var (CI sets this from the git tag, e.g. v0.1.10)
#   2. the chat extension's package.json version (local/dev fallback)
# A leading "v" is stripped. Exits non-zero if neither yields a sane semver,
# so a build can never silently ship an empty version again.
#
# Usage:
#   VERSION="$(bash scripts/resolve-version.sh)"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_PKG="$REPO_ROOT/extensions/hypeproof-chat/package.json"

ver="${HPS_VERSION:-}"
if [[ -z "$ver" && -f "$EXT_PKG" ]]; then
  ver="$(jq -r '.version // empty' "$EXT_PKG")"
fi
ver="${ver#v}"

if [[ ! "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$ ]]; then
  echo "ERROR: could not resolve a valid version (got '${ver:-<empty>}')." >&2
  echo "       Set HPS_VERSION=x.y.z (CI derives it from the git tag), or" >&2
  echo "       ensure $EXT_PKG has a valid version." >&2
  exit 1
fi

printf '%s\n' "$ver"
