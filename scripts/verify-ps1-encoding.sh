#!/usr/bin/env bash
# verify-ps1-encoding.sh - fail-closed gate: every tracked .ps1 that contains
# non-ASCII bytes MUST start with a UTF-8 BOM.
#
# Why: Windows PowerShell 5.1 (the shell `irm ... | iex` and
# `powershell -File` land in) reads a BOM-less .ps1 using the ANSI codepage,
# not UTF-8. On a CP1252 machine the UTF-8 bytes of an em-dash (E2 80 94)
# decode to "a", the euro sign, and 0x94 -> U+201D RIGHT DOUBLE QUOTATION MARK.
# PowerShell accepts smart quotes as string delimiters, so an em-dash inside a
# double-quoted string terminates that string early and the file no longer
# parses. Bytes 0x91-0x94 are the dangerous set (curly single/double quotes).
#
# Observed: scripts/seed-sdk-binary.ps1 (441 such bytes) failed with 16 parse
# errors and took install.ps1 step 7 (SDK seeding) down with it;
# scripts/install-win.ps1 (3 bytes) failed with 3. scripts/install.ps1 parsed
# only because its 13 dangerous bytes happened to sit where the damage was
# harmless - i.e. latent, not fixed. A BOM makes 5.1 decode as UTF-8 and all
# three parse cleanly.
#
# Usage: bash scripts/verify-ps1-encoding.sh
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail=0
checked=0

while IFS= read -r f; do
  [ -f "$f" ] || continue
  checked=$((checked + 1))

  # UTF-8 BOM? Then 5.1 decodes as UTF-8 and non-ASCII is safe.
  bom=$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')
  if [ "$bom" = "efbbbf" ]; then
    continue
  fi

  # No BOM: any byte outside 0x00-0x7F is a latent parse failure.
  # `tr -d` of the ASCII range leaves only the offenders (portable: GNU + BSD).
  remaining=$(LC_ALL=C tr -d '\000-\177' < "$f" | wc -c | tr -d ' ')
  if [ "$remaining" != "0" ]; then
    echo "ERROR: $f has $remaining non-ASCII byte(s) and no UTF-8 BOM"
    echo "       Windows PowerShell 5.1 will read it as ANSI and may fail to parse."
    echo "       Fix: save as UTF-8 with BOM, or restrict the file to ASCII."
    fail=1
  fi
done < <(git ls-files '*.ps1')

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "verify-ps1-encoding: FAILED"
  exit 1
fi

echo "verify-ps1-encoding: OK ($checked .ps1 file(s) checked)"
