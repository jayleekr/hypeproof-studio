#!/usr/bin/env bash
# Apply HypeProof Studio product.json overrides AFTER prepare_vscode.sh has run.
# Idempotent — safe to re-run.
#
# Usage (from repo root):
#   source ./hypeproof-studio.env
#   cd vscodium-base
#   bash prepare_vscode.sh
#   bash ../scripts/apply-product-overrides.sh
#   bash build.sh

set -euo pipefail

# Resolve target product.json (created by prepare_vscode.sh inside vscodium-base/vscode/)
PRODUCT_JSON="${PRODUCT_JSON:-vscode/product.json}"

if [[ ! -f "$PRODUCT_JSON" ]]; then
  echo "ERROR: $PRODUCT_JSON not found. Run prepare_vscode.sh first." >&2
  exit 1
fi

# All HPS_* env vars must be set (loaded from hypeproof-studio.env)
: "${HPS_NAME_SHORT:?source hypeproof-studio.env first}"
: "${HPS_NAME_LONG:?}"
: "${HPS_APPLICATION_NAME:?}"
: "${HPS_DATA_FOLDER_NAME:?}"
: "${HPS_DARWIN_BUNDLE_ID:?}"
: "${HPS_URL_PROTOCOL:?}"
: "${HPS_WIN32_DIR_NAME:?}"
: "${HPS_WIN32_NAME_VERSION:?}"
: "${HPS_WIN32_MUTEX_NAME:?}"
: "${HPS_WIN32_APP_USER_MODEL_ID:?}"
: "${HPS_WIN32_REG_VALUE_NAME:?}"

echo "Applying HypeProof Studio overrides to $PRODUCT_JSON"

# Resolve the release version (single source of truth — see resolve-version.sh).
# This must reach product.json (.version) AND the VS Code source package.json
# (drives Info.plist CFBundleShortVersionString + the About screen). Without it
# builds shipped an empty version, which made the in-app updater treat every
# install as out-of-date forever (#206).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HPS_RESOLVED_VERSION="$(bash "$SCRIPT_DIR/resolve-version.sh")"
echo "  version = $HPS_RESOLVED_VERSION"
# NOTE: do NOT stamp .commit/.date here. VSCodium's build sets product.json.commit
# from $BUILD_SOURCEVERSION AFTER this hook runs, clobbering anything we write.
# A real commit is injected by exporting BUILD_SOURCEVERSION before build.sh
# (run-build.sh defaults it to the repo HEAD) — see resolve-version.sh / #206.

tmp=$(mktemp)
jq \
  --arg version             "$HPS_RESOLVED_VERSION" \
  --arg nameShort           "$HPS_NAME_SHORT" \
  --arg nameLong            "$HPS_NAME_LONG" \
  --arg applicationName     "$HPS_APPLICATION_NAME" \
  --arg dataFolderName      "$HPS_DATA_FOLDER_NAME" \
  --arg darwinBundleId      "$HPS_DARWIN_BUNDLE_ID" \
  --arg urlProtocol         "$HPS_URL_PROTOCOL" \
  --arg win32DirName        "$HPS_WIN32_DIR_NAME" \
  --arg win32NameVersion    "$HPS_WIN32_NAME_VERSION" \
  --arg win32MutexName      "$HPS_WIN32_MUTEX_NAME" \
  --arg win32AppUserModelId "$HPS_WIN32_APP_USER_MODEL_ID" \
  --arg win32RegValueName   "$HPS_WIN32_REG_VALUE_NAME" \
  '.version               = $version
   | .nameShort           = $nameShort
   | .nameLong             = $nameLong
   | .applicationName      = $applicationName
   | .dataFolderName       = $dataFolderName
   | .darwinBundleIdentifier = $darwinBundleId
   | .urlProtocol          = $urlProtocol
   | .win32DirName         = $win32DirName
   | .win32NameVersion     = $win32NameVersion
   | .win32MutexName       = $win32MutexName
   | .win32AppUserModelId  = $win32AppUserModelId
   | .win32RegValueName    = $win32RegValueName
   | .tunnelApplicationName = ($applicationName + "-tunnel")
   | .win32ShellNameShort  = $nameShort
   | .win32TunnelServiceMutex = ($applicationName + "-tunnelservice")
   | .win32TunnelMutex     = ($applicationName + "-tunnel")
   | .linuxIconName        = $applicationName
   | .licenseUrl           = "https://github.com/jayleekr/hypeproof-studio/blob/main/LICENSE"
   | .reportIssueUrl       = "https://github.com/jayleekr/hypeproof-studio/issues/new"
   | .serverApplicationName = ($applicationName + "-server")
   | .serverDataFolderName  = ($dataFolderName + "-server")
   | .extensionEnabledApiProposals = ((.extensionEnabledApiProposals // {}) + {"hypeproof.hypeproof-chat": ["browser"]})
  ' "$PRODUCT_JSON" > "$tmp"

mv "$tmp" "$PRODUCT_JSON"

# Also stamp the VS Code source package.json — gulp reads its .version to set
# CFBundleShortVersionString in Info.plist and the version on the About screen.
# product.json.version alone is not enough for those surfaces.
SRC_PKG="$(dirname "$PRODUCT_JSON")/package.json"
if [[ -f "$SRC_PKG" ]]; then
  tmp_pkg=$(mktemp)
  jq --arg version "$HPS_RESOLVED_VERSION" '.version = $version' "$SRC_PKG" > "$tmp_pkg"
  mv "$tmp_pkg" "$SRC_PKG"
  echo "  stamped $SRC_PKG version → $HPS_RESOLVED_VERSION"
else
  echo "  WARN: $SRC_PKG not found — Info.plist version may stay unset" >&2
fi

echo "Done. Verify with:"
echo "  jq '.version, .commit, .nameShort, .applicationName, .darwinBundleIdentifier, .tunnelApplicationName, .linuxIconName' $PRODUCT_JSON"
