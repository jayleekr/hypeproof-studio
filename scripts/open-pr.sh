#!/usr/bin/env bash
# Deterministic PR open. Pushes the current fix/* or feat/* branch and creates
# a PR against main using .github/pull_request_template.md. Refuses to run on
# main. Safe to let Claude Code run verbatim.
#
# Usage (on your feature branch):  bash scripts/open-pr.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BR="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BR" = "main" ]; then
  echo "✋ You're on main. Branch first:  git switch -c fix/issue-<N>-<slug>" >&2
  exit 1
fi
case "$BR" in
  fix/*|feat/*) : ;;
  *) echo "⚠ Branch '$BR' isn't fix/* or feat/* — rename for the issue→PR convention." >&2 ;;
esac
gh auth status >/dev/null 2>&1 || { echo "✗ gh not authenticated — run: gh auth login" >&2; exit 1; }

# Push the feature branch (pre-push hook allows non-main).
git push -u origin "$BR"

# --fill seeds title/body from commits; the PR template is applied by GitHub.
# Reviews are optional (PR-first policy) — this only opens it.
URL="$(gh pr create --base main --head "$BR" --fill 2>&1)" || {
  echo "$URL" >&2
  echo "If a PR already exists:  gh pr view --web" >&2
  exit 1
}
echo "$URL"
echo "→ Edit the body to fill 'Closes #<N>' and the Essence/Tested sections."
