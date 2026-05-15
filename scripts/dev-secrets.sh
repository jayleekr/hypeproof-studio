#!/usr/bin/env bash
# Populate worker/.dev.vars (gitignored) for `wrangler dev`.
#
# Pulls the Gemini key from ~/.env and upserts it into worker/.dev.vars as
# GEMINI_API_KEY. Accepts HYPE_GEMINI_KEY / GEMINI_API_KEY / GEMINI_KEY (first
# match wins, optional `export ` prefix). Idempotent; preserves other lines;
# never prints the secret value.
#
# Usage:  bash scripts/dev-secrets.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${HOME}/.env"
DEV_VARS="${ROOT}/worker/.dev.vars"
EXAMPLE="${ROOT}/worker/.dev.vars.example"

[ -f "$ENV_FILE" ] || { echo "✗ ${ENV_FILE} not found"; exit 1; }

# Find the key under any accepted name (first match wins), tolerate `export `.
raw=""
for name in HYPE_GEMINI_KEY GEMINI_API_KEY GEMINI_KEY; do
  raw="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=" "$ENV_FILE" | head -n1 || true)"
  [ -n "$raw" ] && break
done
[ -n "$raw" ] || { echo "✗ no Gemini key (HYPE_GEMINI_KEY/GEMINI_API_KEY/GEMINI_KEY) in ${ENV_FILE}"; exit 1; }
val="${raw#*=}"
val="${val#\"}"; val="${val%\"}"
val="${val#\'}"; val="${val%\'}"
val="$(printf '%s' "$val" | tr -d '[:space:]')"
[ -n "$val" ] || { echo "✗ GEMINI_KEY in ${ENV_FILE} is empty"; exit 1; }

# Seed .dev.vars from the example (empty values) if missing.
if [ ! -f "$DEV_VARS" ]; then
  if [ -f "$EXAMPLE" ]; then cp "$EXAMPLE" "$DEV_VARS"; else : > "$DEV_VARS"; fi
fi

# Upsert GEMINI_API_KEY=<val> without echoing it: filter old line, append new.
tmp="$(mktemp)"
grep -v -E '^[[:space:]]*GEMINI_API_KEY[[:space:]]*=' "$DEV_VARS" > "$tmp" || true
printf 'GEMINI_API_KEY=%s\n' "$val" >> "$tmp"
mv "$tmp" "$DEV_VARS"
chmod 600 "$DEV_VARS"

echo "✓ GEMINI_API_KEY written to worker/.dev.vars (${#val} chars, value not shown)"
echo "  worker/.dev.vars is gitignored — never commit it."
grep -qE '^[[:space:]]*HPS_SIGNING_SECRET[[:space:]]*=[^[:space:]]' "$DEV_VARS" \
  || echo "  ⚠ HPS_SIGNING_SECRET is empty — set it to the secret your test tokens were signed with."
echo "  Next:  cd worker && npm run dev"
