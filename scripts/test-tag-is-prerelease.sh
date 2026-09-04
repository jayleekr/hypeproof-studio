#!/bin/sh
# Regression test for scripts/tag-is-prerelease.sh (dag.yaml task A control).
#
# The prerelease decision has to be testable without cutting a real tag
# (docs/plan/dag.yaml task A "control"), so it lives in tag-is-prerelease.sh
# as both a sourceable predicate (is_prerelease_tag) and a standalone CLI.
# This harness exercises both call shapes against the planted control cases:
#
#   positive  TAG=v9.9.9-rc.1  => --prerelease present
#   negative  TAG=v9.9.9       => --prerelease absent
#
# Runs in milliseconds, no network/app/tag required.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
FAILED=0
ok()  { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; FAILED=$((FAILED + 1)); }

# Load the predicate only — the CLI block in tag-is-prerelease.sh only runs
# when the file is executed directly, so sourcing it here has no side effects.
# shellcheck source=./tag-is-prerelease.sh
. "$HERE/tag-is-prerelease.sh"

echo "=== 1. predicate (is_prerelease_tag) ==="

if is_prerelease_tag "v9.9.9-rc.1"; then
  ok "positive: v9.9.9-rc.1 classified as prerelease"
else
  bad "positive: v9.9.9-rc.1 NOT classified as prerelease"
fi

if is_prerelease_tag "v9.9.9"; then
  bad "negative: v9.9.9 wrongly classified as prerelease"
else
  ok "negative: v9.9.9 classified as a stable release"
fi

# A couple of extra shapes so the classifier isn't accidentally keyed on the
# exact "-rc." substring rather than "any hyphen suffix".
if is_prerelease_tag "v1.2.3-beta.4"; then
  ok "extra: v1.2.3-beta.4 classified as prerelease"
else
  bad "extra: v1.2.3-beta.4 NOT classified as prerelease"
fi

if is_prerelease_tag "v1.2.3"; then
  bad "extra: v1.2.3 wrongly classified as prerelease"
else
  ok "extra: v1.2.3 classified as a stable release"
fi

echo ""
echo "=== 2. CLI (the flag text build-mac.yml / build-windows.yml actually use) ==="

got="$(bash "$HERE/tag-is-prerelease.sh" "v9.9.9-rc.1")"
if [ "$got" = "--prerelease" ]; then
  ok "positive: CLI prints '--prerelease' for v9.9.9-rc.1"
else
  bad "positive: CLI printed '$got' for v9.9.9-rc.1 (expected --prerelease)"
fi

got="$(bash "$HERE/tag-is-prerelease.sh" "v9.9.9")"
if [ -z "$got" ]; then
  ok "negative: CLI prints nothing for v9.9.9"
else
  bad "negative: CLI printed '$got' for v9.9.9 (expected empty)"
fi

# No tag given -> usage error, not a silent empty/false classification.
if bash "$HERE/tag-is-prerelease.sh" >/dev/null 2>&1; then
  bad "missing tag: CLI exited 0 with no tag argument (should error)"
else
  ok "missing tag: CLI exits non-zero with no tag argument"
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "PASS: tag-is-prerelease predicate + CLI both classify correctly."
  exit 0
else
  echo "FAIL: $FAILED check(s) failed."
  exit 1
fi
