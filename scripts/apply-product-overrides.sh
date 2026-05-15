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

tmp=$(mktemp)
jq \
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
  '.nameShort              = $nameShort
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
   | .licenseUrl           = "https://github.com/jayleekr/hypeproof-studio/blob/main/LICENSE"
   | .reportIssueUrl       = "https://github.com/jayleekr/hypeproof-studio/issues/new"
   | .serverApplicationName = ($applicationName + "-server")
   | .serverDataFolderName  = ($dataFolderName + "-server")
  ' "$PRODUCT_JSON" > "$tmp"

mv "$tmp" "$PRODUCT_JSON"

echo "Done. Verify with:"
echo "  jq '.nameShort, .nameLong, .applicationName, .darwinBundleIdentifier' $PRODUCT_JSON"
