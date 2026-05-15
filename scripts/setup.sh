#!/usr/bin/env bash
# One-command contributor setup. Idempotent and safe: does the deterministic
# parts (submodule, secrets, deps) and PRINTS exact commands for anything that
# needs a manual install — it never brew-installs behind your back.
#
# Usage (from repo root):  bash scripts/setup.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
todo(){ printf '  \033[33m→\033[0m %s\n' "$1"; }
hdr(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

[ "$(uname -s)" = "Darwin" ] || { echo "Local dev is macOS-only. On Win/Linux use the web issue forms (see DEV-GUIDE.md)."; exit 1; }

hdr "1. Toolchain"
command -v node >/dev/null && ok "node $(node -v)" || todo "install Node 22.22.1: brew install nvm && nvm install 22.22.1"
command -v gh >/dev/null && ok "gh present" || todo "install gh: brew install gh"
command -v jq >/dev/null && ok "jq present" || todo "brew install jq imagemagick librsvg"
gh auth status >/dev/null 2>&1 && ok "gh authenticated" || todo "gh auth login   (needs 'repo' scope)"

hdr "2. Submodule"
if [ -f vscodium-base/.git ] || [ -d vscodium-base/.git ]; then ok "vscodium-base present"
else todo "git submodule update --init"; git submodule update --init && ok "submodule initialised"; fi

hdr "3. Secrets (worker/.dev.vars — gitignored)"
if [ -f worker/.dev.vars ]; then ok "worker/.dev.vars exists"
else cp worker/.dev.vars.example worker/.dev.vars && ok "created from .example"; fi
if bash scripts/dev-secrets.sh >/dev/null 2>&1; then ok "Gemini key pulled from ~/.env"
else todo "set keys in worker/.dev.vars (see DEV-GUIDE 'Keys & providers')"; fi

hdr "4. Dependencies"
( cd worker && npm install --silent >/dev/null 2>&1 ) && ok "worker deps" || todo "cd worker && npm install"
( cd e2e && npm install --silent >/dev/null 2>&1 ) && ok "e2e deps" || todo "cd e2e && npm install"

hdr "5. PR-safety guard"
git config core.hooksPath .githooks && ok "pre-push guard enabled (blocks accidental main push)"

hdr "Done"
echo "  Next:  bash scripts/dev-stack.sh   then open the app / run tests."
echo "  Build the app once (~1–2 h):  see DEV-GUIDE.md §3"
