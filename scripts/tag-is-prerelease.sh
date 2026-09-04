#!/usr/bin/env bash
# Decides whether a release tag is a dev-channel prerelease.
#
# dag.yaml task A / docs/plan/vessel-and-modules.md §6 stage 2: the auto-
# updater (extensions/hypeproof-chat/src/updateCheckerHelpers.ts:169) already
# skips draft/prerelease releases, and GitHub's /releases/latest excludes
# prereleases by definition — the only missing piece is actually marking the
# GitHub Release as a prerelease when the tag says so. This script (and the
# is_prerelease_tag predicate it defines) is that decision, extracted so it
# can be unit-tested without cutting a real tag (scripts/test-tag-is-prerelease.sh).
#
# Convention: a tag carrying a hyphen suffix is a SemVer pre-release
# identifier (v9.9.9-rc.1 -> dev channel). A plain vX.Y.Z tag is a stable
# release.
#
# Usage:
#   # As a CLI (used by build-mac.yml / build-windows.yml):
#   FLAG="$(bash scripts/tag-is-prerelease.sh "$TAG")"   # prints "--prerelease" or ""
#   gh release create "$TAG" $FLAG ...
#
#   # As a library (used by the test harness):
#   . scripts/tag-is-prerelease.sh   # sourcing runs no CLI logic
#   is_prerelease_tag "v9.9.9-rc.1" && echo "prerelease"

is_prerelease_tag() {  # is_prerelease_tag <tag> -> exit 0 if it is a prerelease
  case "${1:-}" in
    *-*) return 0 ;;
    *) return 1 ;;
  esac
}

# Only run the CLI behavior when executed directly. Sourcing (the test
# harness) must be side-effect-free — no `set -e` leaking into the caller's
# shell, no exit.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  tag="${1:-${TAG:-}}"
  if [[ -z "$tag" ]]; then
    echo "usage: $0 <tag>   (or set \$TAG)" >&2
    exit 2
  fi
  if is_prerelease_tag "$tag"; then
    echo "--prerelease"
  else
    echo ""
  fi
fi
