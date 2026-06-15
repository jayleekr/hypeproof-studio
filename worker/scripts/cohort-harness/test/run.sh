#!/usr/bin/env bash
# worker/scripts/cohort-harness/test/run.sh — self-contained checks for the
# studio-local cohort profile validator (../validate.py + ../rules.yaml).
#
# Drives validate.py against the fixtures in ./fixtures/ and asserts exit codes
# + key safety findings. Pure data check — no wrangler/stack needed.
#
# Exit code: 0 ⇔ every assertion holds; 1 otherwise.
# Run directly: bash worker/scripts/cohort-harness/test/run.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VALIDATE="$HERE/../validate.py"
FIX="$HERE/fixtures"
PY="${PYTHON:-python3}"

pass=0 fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }
run_rc() { "$PY" "$VALIDATE" "$1" >/dev/null 2>&1; echo $?; }

echo "## cohort-harness validate — fixtures (studio-local)"

if ! command -v "$PY" >/dev/null 2>&1; then
  bad "python3 not found (set PYTHON=...)"; echo "Totals: PASS=$pass FAIL=$fail"; exit 1
fi
[ -f "$VALIDATE" ] && ok "validate.py present" || bad "validate.py missing at $VALIDATE"
[ -f "$HERE/../rules.yaml" ] && ok "rules.yaml present" || bad "rules.yaml missing"
for f in pass warn fail malformed; do
  [ -f "$FIX/$f.json" ] && ok "fixture $f.json present" || bad "fixture $f.json missing"
done

# T1: clean profiles → exit 0, no findings
rc="$(run_rc "$FIX/pass.json")"
[ "$rc" -eq 0 ] && ok "pass.json → exit 0" || bad "pass.json → exit $rc (want 0)"
if "$PY" "$VALIDATE" --json "$FIX/pass.json" 2>/dev/null \
   | "$PY" -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d["ok"] and d["totals"]["fail"]==0 and d["totals"]["warn"]==0 else 1)'; then
  ok "pass.json → ok=true, 0 FAIL, 0 WARN"
else
  bad "pass.json json gate (ok/0-fail/0-warn) not satisfied"
fi

# T2: WARN-only profile → still exit 0, warn>0
rc="$(run_rc "$FIX/warn.json")"
[ "$rc" -eq 0 ] && ok "warn.json → exit 0 (WARN passes)" || bad "warn.json → exit $rc (want 0)"
if "$PY" "$VALIDATE" --json "$FIX/warn.json" 2>/dev/null \
   | "$PY" -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d["ok"] and d["totals"]["fail"]==0 and d["totals"]["warn"]>0 else 1)'; then
  ok "warn.json → ok=true, 0 FAIL, WARN>0"
else
  bad "warn.json json gate (ok/0-fail/warn>0) not satisfied"
fi

# T3: broken profiles → exit 1
rc="$(run_rc "$FIX/fail.json")"
[ "$rc" -eq 1 ] && ok "fail.json → exit 1" || bad "fail.json → exit $rc (want 1)"

# T4: the safety-critical checks actually fire on fail.json
required_checks="child_log_user_messages publishing_promise_contradiction child_missing_url_ban id_unique asset_enum_unknown series_index_range hours_positive cohort_series_total_consistent child_per_user_pages publishing_strategy_unknown"
got="$("$PY" "$VALIDATE" --json "$FIX/fail.json" 2>/dev/null \
      | "$PY" -c 'import sys,json; d=json.load(sys.stdin); print(" ".join(sorted({f["check"] for f in d["findings"] if f["severity"]=="fail"})))')"
miss=""
for c in $required_checks; do
  case " $got " in *" $c "*) : ;; *) miss="$miss $c" ;; esac
done
[ -z "$miss" ] && ok "fail.json fires all required FAIL checks" || bad "fail.json missing FAIL checks:$miss"

# T5: malformed JSON → exit 2
rc="$(run_rc "$FIX/malformed.json")"
[ "$rc" -eq 2 ] && ok "malformed.json → exit 2" || bad "malformed.json → exit $rc (want 2)"

# T6: stdin path works identically to file path
rc_stdin="$(cat "$FIX/fail.json" | "$PY" "$VALIDATE" >/dev/null 2>&1; echo $?)"
[ "$rc_stdin" -eq 1 ] && ok "stdin pipe → exit 1 (matches file path)" || bad "stdin pipe → exit $rc_stdin (want 1)"

echo
echo "Totals: PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ] && { echo "✓ cohort-harness fixtures pass"; exit 0; } || { echo "✗ cohort-harness fixtures failed"; exit 1; }
