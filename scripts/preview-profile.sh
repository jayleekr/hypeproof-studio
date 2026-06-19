#!/usr/bin/env bash
# Preview a cohort profile end-to-end against a local wrangler dev:
#   1. ensure wrangler dev is reachable (start it if not — and clean up on exit)
#   2. mint a local workshop token with scripts/issue-token.ts
#   3. GET /v1/profile and assert the panel-facing contract
#      (mirrors e2e/tests/06-dental-profile-api.spec.ts) — greeting, chips, coach
#   4. optionally print the token for a manual round-trip in the app
#
# /v1/profile only needs a valid token + a registered profile id — no roster or
# active class window required, so this is a fast author-time rehearsal.
#
# Usage:
#   bash scripts/preview-profile.sh                                  # default: 초3·4 track
#   bash scripts/preview-profile.sh --profile sk-biopharm-kids-2026-grade-5-6-s1
#   bash scripts/preview-profile.sh --profile <id> --cohort <id> --user <name> --port 8787
#   bash scripts/preview-profile.sh --print-token                    # local manual paste only
#
# Secret: reads HPS_SIGNING_SECRET from worker/.dev.vars (the same secret the
# running wrangler dev verifies with) or the env. Run `bash scripts/dev-secrets.sh`
# first if .dev.vars is empty.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/worker"

# Pin Node 22 (issue-token.ts / dump-profiles.ts use --experimental-strip-types).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh" >/dev/null 2>&1 || true
command -v nvm >/dev/null 2>&1 && nvm use 22.22.1 --silent >/dev/null 2>&1 || true

PROFILE="sk-biopharm-kids-2026-grade-3-4-s1"
COHORT=""
USER_ID="preview-smoke"
PORT="8787"
PRINT_TOKEN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2;;
    --cohort)  COHORT="$2";  shift 2;;
    --user)    USER_ID="$2"; shift 2;;
    --port)    PORT="$2";    shift 2;;
    --print-token|--show-token) PRINT_TOKEN=1; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

BASE="http://localhost:${PORT}"

# --- signing secret --------------------------------------------------------
SIGNING="${HPS_SIGNING_SECRET:-}"
if [[ -z "$SIGNING" && -f .dev.vars ]]; then
  SIGNING="$(grep -E '^HPS_SIGNING_SECRET=' .dev.vars | head -n1 | cut -d= -f2- || true)"
fi
if [[ -z "$SIGNING" ]]; then
  echo "✗ HPS_SIGNING_SECRET not set and not found in worker/.dev.vars" >&2
  echo "  Run: bash scripts/dev-secrets.sh  (and set HPS_SIGNING_SECRET there)" >&2
  exit 1
fi

# --- ensure wrangler dev is up (start + clean up if we own it) -------------
STARTED_BY_US=0
cleanup() { [[ "$STARTED_BY_US" == "1" ]] && pkill -f "wrangler dev.*--port ${PORT}" 2>/dev/null || true; }
trap cleanup EXIT

if curl -fsS "${BASE}/v1/health" >/dev/null 2>&1; then
  echo "✓ wrangler dev already reachable at ${BASE}"
else
  echo "▶ wrangler dev not up — starting (npx wrangler dev --local --port ${PORT})…"
  nohup npx wrangler dev --local --port "${PORT}" > /tmp/hps-preview-wrangler.log 2>&1 &
  STARTED_BY_US=1
  for _ in $(seq 1 30); do
    curl -fsS "${BASE}/v1/health" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -fsS "${BASE}/v1/health" >/dev/null 2>&1; then
    echo "✗ wrangler dev did not become ready. Tail of /tmp/hps-preview-wrangler.log:" >&2
    tail -20 /tmp/hps-preview-wrangler.log >&2
    exit 1
  fi
  echo "✓ wrangler dev ready at ${BASE}"
fi

# --- derive cohort_id from the registry if not provided --------------------
if [[ -z "$COHORT" ]]; then
  COHORT="$(node --experimental-strip-types scripts/dump-profiles.ts 2>/dev/null \
    | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=a.find(x=>x.id===process.argv[1]);if(!p){console.error("profile not in registry: "+process.argv[1]);process.exit(3)}process.stdout.write(p.session.cohort_id)' "$PROFILE")"
  echo "• derived cohort_id: ${COHORT}"
fi

# --- mint a local token ----------------------------------------------------
echo "▶ minting token (user=${USER_ID} cohort=${COHORT} profile=${PROFILE})…"
TOKEN="$(HPS_SIGNING_SECRET="$SIGNING" node --experimental-strip-types scripts/issue-token.ts \
  --user "$USER_ID" --cohort "$COHORT" --profile "$PROFILE" --hours 2 2>/dev/null)"
if [[ -z "$TOKEN" ]]; then echo "✗ token mint failed" >&2; exit 1; fi

# --- GET /v1/profile + assert the panel contract ---------------------------
echo "▶ GET ${BASE}/v1/profile"
BODY="$(curl -fsS "${BASE}/v1/profile" -H "authorization: Bearer ${TOKEN}")" || {
  echo "✗ GET /v1/profile failed" >&2; exit 1; }

echo "$BODY" | node -e '
  const p = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const want = process.argv[1];
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  ok(p.profile_id === want, `profile_id == ${want} (got ${p.profile_id})`);
  ok(typeof p.display_name === "string" && p.display_name.length > 0, "display_name non-empty");
  ok(typeof p.language === "string" && p.language.length > 0, "language present");
  ok(p.welcome && Array.isArray(p.welcome.example_prompts) && p.welcome.example_prompts.length >= 1, "welcome.example_prompts >= 1");
  ok(typeof (p.welcome && p.welcome.greeting_md) === "string" && p.welcome.greeting_md.length > 0, "welcome.greeting_md non-empty");
  const init = p.ux && p.ux.suggestions && p.ux.suggestions.initial;
  ok(Array.isArray(init) && init.length >= 1, "ux.suggestions.initial >= 1");
  if (Array.isArray(init)) {
    ok(init.some(c => c.style === "good"), "at least one good starter chip");
    for (const c of init) if (c.style === "weak") ok(typeof c.caption === "string" && c.caption.length > 0, "weak chip has caption");
  }
  const coach = p.ux && p.ux.coach;
  ok(coach && (coach.naming_mode === "fixed" || (typeof coach.naming_prompt_md === "string" && coach.naming_prompt_md.length > 0)), "naming_mode=fixed OR naming_prompt_md present");
  console.log("\n  display_name : " + p.display_name);
  console.log("  language     : " + p.language);
  console.log("  series       : " + p.series_index + "/" + p.series_total);
  console.log("  assets_focus : " + (p.assets_focus || []).join(", "));
  console.log("  greeting     : " + p.welcome.greeting_md.replace(/\n/g, " ⏎ ").slice(0, 80));
  console.log("  init chips   : " + init.length + " (" + init.map(c=>c.style).join("/") + ")");
  console.log("  publishing   : enabled=" + (p.publishing && p.publishing.enabled) + " strategy=" + (p.publishing && p.publishing.strategy));
  if (fails.length) { console.error("\n✗ FAIL:\n  - " + fails.join("\n  - ")); process.exit(1); }
  console.log("\n✓ /v1/profile contract OK (" + want + ")");
' "$PROFILE"

echo ""
echo "─── round-trip token (paste in HypeProof Studio.app → Set Workshop Token) ───"
echo "  proxy url : ${BASE}/v1"
if [[ "$PRINT_TOKEN" == "1" ]]; then
  echo "  token     : ${TOKEN}"
else
  echo "  token     : <redacted; rerun with --print-token for local manual paste>"
fi
echo "─────────────────────────────────────────────────────────────────────────────"
[[ "$STARTED_BY_US" == "1" ]] && echo "(this script started wrangler dev and will stop it on exit; run scripts/dev-stack.sh for a persistent stack)"
