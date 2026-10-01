#!/usr/bin/env bash
# prep-test-app.sh — turn a COPY of HypeProof Studio.app into a background test app.
#
# Quiet mode (e2e/fixtures/app.ts) hides the window once the workbench is ready,
# but macOS still activates a regular app at launch, so the first second of every
# run can take keyboard focus from whoever is working on the Mac. Marking the copy
# as an agent app (LSUIElement=1) removes the Dock icon and stops it from ever
# activating, so e2e runs can happen while someone is using the machine.
#
# Usage:
#   cp -R "/Applications/HypeProof Studio.app" /tmp/hps-test/
#   bash scripts/prep-test-app.sh "/tmp/hps-test/HypeProof Studio.app"
#   HPS_APP_PATH="/tmp/hps-test/HypeProof Studio.app" bash scripts/e2e-quiet.sh
#
# Only ever modifies the bundle it is given, and refuses the installed app and the
# in-tree build artifact. The copy is ad-hoc re-signed because editing Info.plist
# invalidates the original signature.
set -euo pipefail

APP="${1:-}"
if [[ -z "$APP" || ! -f "$APP/Contents/Info.plist" ]]; then
  echo "usage: $0 <path to a copy of HypeProof Studio.app>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REAL="$(cd "$APP" && pwd -P)"
case "$REAL" in
  /Applications/*|"$HOME/Applications/"*|"$ROOT/vscodium-base/"*)
    echo "✗ refusing to modify $REAL — copy the app first" >&2
    exit 2
    ;;
esac

plutil -replace LSUIElement -bool true "$REAL/Contents/Info.plist"
if ! codesign --force --deep --sign - "$REAL" >/dev/null 2>&1; then
  echo "⚠ ad-hoc re-sign failed; the app may refuse to launch" >&2
fi
echo "▶ prepared $REAL (LSUIElement=1: no Dock icon, never takes focus)"
