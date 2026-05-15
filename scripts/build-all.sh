#!/usr/bin/env bash
# Full build orchestrator for HypeProof Studio.
#
# WARNING: bash build.sh inside this is the long step (1–2 h, 10–20 GB).
# Run only after Phase 0 check-env.sh passes.
#
# Usage:
#   bash scripts/build-all.sh           # full pipeline
#   bash scripts/build-all.sh --rebrand # skip prepare_src, just re-patch + build
#   bash scripts/build-all.sh --inject  # only rebuild + inject extension (no app build)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f hypeproof-studio.env ]]; then
  echo "ERROR: hypeproof-studio.env missing." >&2; exit 1
fi
# shellcheck source=/dev/null
source ./hypeproof-studio.env

MODE="${1:-full}"

run_full() {
  echo "==> Phase 0: env check"
  bash scripts/check-env.sh

  echo "==> Phase 2.1: brand assets"
  bash scripts/install-brand-assets.sh
  (cd vscodium-base && bash icons/build_icons.sh)

  echo "==> Phase 1: fetch + prepare VS Code source"
  (
    cd vscodium-base
    bash get_repo.sh
    bash prepare_src.sh
    bash prepare_vscode.sh
  )

  echo "==> Phase 2.2: product.json overrides"
  (cd vscodium-base && bash ../scripts/apply-product-overrides.sh)

  echo "==> Phase 5: inject hypeproof-chat as built-in"
  bash scripts/inject-builtin-extensions.sh

  echo "==> Phase 3: full build (1–2 h)"
  (cd vscodium-base && bash build.sh)

  echo "==> Verify"
  bash scripts/verify-branding.sh
}

run_rebrand() {
  echo "==> Re-applying brand + product overrides (no source re-fetch)"
  bash scripts/install-brand-assets.sh
  (cd vscodium-base && bash icons/build_icons.sh)
  (cd vscodium-base && bash prepare_vscode.sh)
  (cd vscodium-base && bash ../scripts/apply-product-overrides.sh)
  bash scripts/inject-builtin-extensions.sh
  echo "==> Build"
  (cd vscodium-base && bash build.sh)
  bash scripts/verify-branding.sh
}

run_inject_only() {
  echo "==> Rebuilding hypeproof-chat + re-injecting (no app rebuild)"
  bash scripts/inject-builtin-extensions.sh
  echo "Done. App must be rebuilt for changes to ship (run --rebrand or full)."
}

case "$MODE" in
  --full|full)    run_full ;;
  --rebrand)      run_rebrand ;;
  --inject)       run_inject_only ;;
  *) echo "Usage: $0 [--full|--rebrand|--inject]"; exit 2 ;;
esac
