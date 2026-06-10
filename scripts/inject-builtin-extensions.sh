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

# 2b. Stamp the bundled extension's version to the release version. The in-app
# updater's currentBundleVersion() reads this package.json to decide whether an
# update is available; if it stays at the dev version while releases are tagged
# ahead, every install reports out-of-date forever (#206).
#
# CRITICAL: stamp the SOURCE package.json, not just the vscode/ copy. The fork's
# prepare_vscode.sh "HypeProof Studio overrides" hook re-injects from
# $EXT_SRC during build.sh — AFTER run-build.sh's `git clean -fdx` wipes
# vscode/extensions/ — by copying $EXT_SRC/package.json verbatim. So the SOURCE
# version is what actually ships. run-build's reset only touches vscode/, so a
# source stamp set here (an explicit step before run-build) survives to the
# hook. We stamp the copy too for standalone/F5 correctness.
RESOLVED_VERSION="$(bash "$REPO_ROOT/scripts/resolve-version.sh")"
for pkg in "$EXT_SRC/package.json" "$EXT_DST/package.json"; do
  tmp_pkg=$(mktemp)
  jq --arg v "$RESOLVED_VERSION" '.version = $v' "$pkg" > "$tmp_pkg"
  mv "$tmp_pkg" "$pkg"
done
echo "Stamped extension version (source + bundled copy) → $RESOLVED_VERSION"

# 3. NOTE: do NOT add to product.json.builtInExtensions. That list triggers
# a marketplace/GH download at build time. Extensions placed in extensions/
# at build time are bundled automatically — same mechanism vscode itself
# uses for git, npm, css-language-features, etc.

echo "Done. hypeproof-chat copied to vscode/extensions/ — will ship pre-installed."
echo "Verify: ls $VSCODE_TREE/extensions/hypeproof-chat/"
