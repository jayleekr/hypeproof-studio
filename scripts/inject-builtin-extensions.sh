#!/usr/bin/env bash
# Phase 5 — inject hypeproof-chat as a built-in extension into VS Code source.
# Runs AFTER prepare_vscode.sh (which creates vscodium-base/vscode/).
# Idempotent — safe to re-run.
#
# Usage (from repo root):
#   source ./hypeproof-studio.env
#   cd vscodium-base
#   bash prepare_vscode.sh
#   bash ../scripts/apply-product-overrides.sh
#   bash ../scripts/inject-builtin-extensions.sh
#   bash build.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_SRC="$REPO_ROOT/extensions/hypeproof-chat"
VSCODE_TREE="${VSCODE_TREE:-$REPO_ROOT/vscodium-base/vscode}"

if [[ ! -d "$VSCODE_TREE" ]]; then
  echo "ERROR: $VSCODE_TREE not found. Run prepare_vscode.sh first." >&2
  exit 1
fi

if [[ ! -d "$EXT_SRC" ]]; then
  echo "ERROR: $EXT_SRC not found." >&2
  exit 1
fi

EXT_DST="$VSCODE_TREE/extensions/hypeproof-chat"
PRODUCT_JSON="$VSCODE_TREE/product.json"

# 1. Build the webview + extension bundle
echo "Building hypeproof-chat..."
(
  cd "$EXT_SRC"
  if [[ ! -d node_modules ]]; then npm install --no-audit --no-fund; fi
  npm run build
)

# 2. Copy the built extension into vscode/extensions/
echo "Injecting into $EXT_DST"
rm -rf "$EXT_DST"
mkdir -p "$EXT_DST"
# Files that ship inside the bundled extension:
cp "$EXT_SRC/package.json"  "$EXT_DST/"
cp -r "$EXT_SRC/dist"       "$EXT_DST/"
cp -r "$EXT_SRC/media"      "$EXT_DST/"
mkdir -p "$EXT_DST/webview-ui"
cp -r "$EXT_SRC/webview-ui/dist" "$EXT_DST/webview-ui/dist"

# 3. NOTE: do NOT add to product.json.builtInExtensions. That list triggers
# a marketplace/GH download at build time. Extensions placed in extensions/
# at build time are bundled automatically — same mechanism vscode itself
# uses for git, npm, css-language-features, etc.

echo "Done. hypeproof-chat copied to vscode/extensions/ — will ship pre-installed."
echo "Verify: ls $VSCODE_TREE/extensions/hypeproof-chat/"
