#!/usr/bin/env bash
# Tag-aware wrapper around the live-session freeze, for the two app-build
# workflows (docs/plan/dag.yaml task D, issue #676).
#
# It answers one question the worker cannot: does THIS ref actually reach
# participants?
#
#   refs/tags/v0.1.20      stable release -> update banner + mirror -> FREEZE
#   refs/tags/v0.1.20-rc.1 dev channel    -> prerelease, the updater skips it
#                                            and /releases/latest excludes it,
#                                            so it reaches nobody -> EXEMPT
#   anything else          publishes no release at all             -> EXEMPT
#
# The prerelease decision is task A's, reused verbatim from
# scripts/tag-is-prerelease.sh rather than re-derived here — one classifier,
# one place to be wrong.
#
# Usage (build-mac.yml / build-windows.yml):
#   HPS_FREEZE_CONTEXT="stable app release $TAG (pre-build)" \
#   HPS_FREEZE_OVERRIDE="${{ inputs.override_live_session }}" \
#     bash scripts/release-freeze-gate.sh "$GITHUB_REF"
#
# Exit 0 = proceed (exempt, clear, or overridden). Exit 1 = frozen.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REF="${1:-${GITHUB_REF:-}}"

if [[ "$REF" != refs/tags/v* ]]; then
  echo "live-session freeze: ref '$REF' publishes no release — exempt."
  exit 0
fi

TAG="${REF#refs/tags/}"

if [[ -n "$(bash "$HERE/tag-is-prerelease.sh" "$TAG")" ]]; then
  echo "live-session freeze: $TAG is a dev-channel prerelease — exempt."
  echo "  (task A: prereleases are skipped by the in-app updater and excluded"
  echo "   from /releases/latest, so a dev tag reaches nobody. Freezing the dev"
  echo "   channel during class hours would break it when it is most useful.)"
  exit 0
fi

echo "live-session freeze: $TAG is a STABLE release — asking the worker whether a class is live."
exec node "$HERE/check-live-sessions.mjs"
