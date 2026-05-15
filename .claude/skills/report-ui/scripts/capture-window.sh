#!/usr/bin/env bash
# Capture a screenshot of the contributor's *live* HypeProof Studio window.
# Usage: capture-window.sh <out.png>
# macOS only. Uses interactive window-select (screencapture -w): the cursor
# becomes a camera — the contributor clicks the Studio window they want.
set -euo pipefail
OUT="${1:?usage: capture-window.sh <out.png>}"
mkdir -p "$(dirname "$OUT")"

if ! command -v screencapture >/dev/null 2>&1; then
  echo "ERR no screencapture (macOS only)" >&2
  exit 2
fi

echo "→ Click the HypeProof Studio window you want to capture (Esc to cancel)…" >&2
# -w window mode, -o no window shadow, -x silent (no sound)
screencapture -w -o -x "$OUT"

[[ -s "$OUT" ]] || { echo "ERR capture cancelled or empty" >&2; exit 3; }
echo "$OUT"
