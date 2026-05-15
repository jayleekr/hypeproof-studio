#!/usr/bin/env bash
# Copy HypeProof brand SVGs over the VSCodium originals.
# Backs up the originals to icons/stable/*.codium-orig.svg the first time it runs.
#
# Run before `bash icons/build_icons.sh` (which regenerates .icns/.ico/.png from these SVGs).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/assets/brand"
DST="$REPO_ROOT/vscodium-base/icons/stable"

backup_once() {
  local orig="$1"
  local bak="${orig%.svg}.codium-orig.svg"
  if [[ -f "$orig" && ! -f "$bak" ]]; then
    cp "$orig" "$bak"
    echo "  backed up $orig → $(basename "$bak")"
  fi
}

declare -a MAP=(
  "hypeproof_cnl.svg:codium_cnl.svg"
  "hypeproof_cnl_w80_b8.svg:codium_cnl_w80_b8.svg"
  "hypeproof_clt.svg:codium_clt.svg"
)

echo "Installing HypeProof brand assets..."
for pair in "${MAP[@]}"; do
  src="$SRC/${pair%%:*}"
  dst="$DST/${pair##*:}"
  if [[ ! -f "$src" ]]; then
    echo "  ERROR: missing $src" >&2; exit 1
  fi
  backup_once "$dst"
  cp "$src" "$dst"
  echo "  installed $(basename "$dst")"
done

echo
echo "Done. Now regenerate platform icons:"
echo "  cd vscodium-base && bash icons/build_icons.sh"
