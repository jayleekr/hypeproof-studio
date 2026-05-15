#!/usr/bin/env bash
# Generate Linux PNG, Windows .ico, and server favicon/PNGs from the HypeProof
# brand SVG. Replaces the remote-downloaded VSCodium icons that build_icons.sh
# pulls from raw.githubusercontent.com when load_linux_png/load_windows_ico
# fire.
#
# Run AFTER install-brand-assets.sh and BEFORE build_icons.sh (or any time you
# want to refresh platform icons).
#
# Idempotent. Pre-populates the target files so build_icons.sh's existence
# checks skip the remote download path.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$REPO_ROOT/assets/brand/hypeproof_cnl.svg"
RES="$REPO_ROOT/vscodium-base/src/stable/resources"

[[ -f "$SVG" ]] || { echo "ERROR: $SVG missing" >&2; exit 1; }
command -v rsvg-convert >/dev/null || { echo "ERROR: rsvg-convert missing (brew install librsvg)" >&2; exit 1; }
command -v magick       >/dev/null || command -v convert >/dev/null || {
  echo "ERROR: imagemagick missing (brew install imagemagick)" >&2; exit 1; }

# ImageMagick 7 uses 'magick'; 6 uses 'convert'. Wrap both.
im() {
  if command -v magick >/dev/null; then magick "$@"; else convert "$@"; fi
}

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

echo "[icons] rasterizing master 1024x1024 PNG"
rsvg-convert -w 1024 -h 1024 "$SVG" -o "$tmp/master_1024.png"

mkdir -p "$RES/linux" "$RES/linux/rpm" "$RES/win32" "$RES/server"

# Linux — single 1024 PNG (build_linux_main will derive other sizes if needed)
echo "[icons] linux/code.png"
cp "$tmp/master_1024.png" "$RES/linux/code.png"
im "$RES/linux/code.png" "$RES/linux/rpm/code.xpm"

# Server — 192 + 512 PNG + favicon.ico
echo "[icons] server/code-{192,512}.png + favicon.ico"
im "$tmp/master_1024.png" -resize 192x192 "$RES/server/code-192.png"
im "$tmp/master_1024.png" -resize 512x512 "$RES/server/code-512.png"
im "$tmp/master_1024.png" -define icon:auto-resize=64,48,32,16 "$RES/server/favicon.ico"

# Windows — multi-resolution .ico
echo "[icons] win32/code.ico (multi-resolution)"
im "$tmp/master_1024.png" -define icon:auto-resize=256,128,96,64,48,32,24,20,16 "$RES/win32/code.ico"

echo
echo "Generated:"
ls -la "$RES/linux/code.png" "$RES/win32/code.ico" "$RES/server/code-192.png" "$RES/server/code-512.png" "$RES/server/favicon.ico"
echo
echo "Now build_icons.sh will skip the VSCodium-icons.github.com download path."
