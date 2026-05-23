#!/usr/bin/env python3
import json, sys
from pathlib import Path

ASSETS = [
    ("intent_clarity",       "Intent clarity (의도)"),
    ("taste",                "Taste (안목)"),
    ("context_design",       "Context design (컨텍스트)"),
    ("verification_reflex",  "Verification reflex (검증)"),
    ("delegation_judgment",  "Delegation judgment (위임)"),
    ("iteration_reflex",     "Iteration reflex (반복)"),
    ("ownership",            "Ownership (소유감)"),
]

skill = sys.argv[1]
log = Path.home() / ".claude" / "boa-skills" / "logs" / f"{skill}.jsonl"
if not log.exists():
    print(f"기록된 턴이 없어요. ({log})"); sys.exit(0)

rows = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
n = len(rows)
print(f"\n{skill} — 7자산 사용 횟수 (총 {n}턴)\n")
for k, label in ASSETS:
    c = sum(1 for r in rows if r["scores"][k]["score"] >= 1)
    print(f"  {label:<28} {'█'*c}{'·'*(n-c)}  {c}/{n}")
print()
