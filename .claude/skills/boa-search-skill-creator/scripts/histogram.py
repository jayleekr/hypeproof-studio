#!/usr/bin/env python3
"""child skill 로그의 7자산 발현 히스토그램.

사용: histogram.py <child-skill-name> [<log-path>]
  - log-path 생략 시 ~/.claude/boa-skills/logs/<name>.jsonl 사용.
  - log-path 인자는 테스트용 (fixture를 home 디렉토리 오염 없이 검증).

분모는 "자산별 점수가 매겨진(non-null) 턴"이다 — 첫 턴(전부 null)·무증거 null과
실제 0점을 구분하기 위해서다. (measurement-architecture.md §5 P0)
"""
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


def asset_score(row, key):
    """채점된 정수 점수만 반환. 첫 턴/무증거(null)·키 부재(scores 없음, 자산 없음)는
    모두 None(=미채점)으로 통일 — None-safe 4종(scores=null, scores 키부재,
    자산 키부재, 자산 score=null)을 한 곳에서 흡수한다."""
    scores = row.get("scores") or {}
    cell = scores.get(key) or {}
    val = cell.get("score")
    return val if isinstance(val, int) else None


def render(skill, rows):
    n = len(rows)
    out = [f"\n{skill} — 7자산 발현 (총 {n}턴 기록)\n"]
    any_scored = False
    for k, label in ASSETS:
        scored = [v for r in rows if (v := asset_score(r, k)) is not None]  # 채점된 턴만 = 분모
        d = len(scored)
        if d == 0:
            out.append(f"  {label:<28} {'·'*max(n, 1)}  미채점")
            continue
        any_scored = True
        shown = sum(1 for v in scored if v >= 1)   # 발현(1점 이상)
        bar = "█" * shown + "·" * (d - shown)
        out.append(f"  {label:<28} {bar}  {shown}/{d}  (점수 매겨진 {d}턴 중)")
    if not any_scored:
        out.append("\n아직 점수가 매겨진 턴이 없어요. (첫 턴은 기록만 하고 채점하지 않아요.)")
    elif n < 3:
        out.append("\n아직 턴이 적어요(3턴 미만). 몇 번 더 써보면 패턴이 보여요.")
    return "\n".join(out) + "\n"


def main(argv):
    if len(argv) < 2:
        print("사용: histogram.py <child-skill-name> [<log-path>]", file=sys.stderr)
        return 2
    skill = argv[1]
    log = Path(argv[2]) if len(argv) > 2 else (
        Path.home() / ".claude" / "boa-skills" / "logs" / f"{skill}.jsonl"
    )
    if not log.exists():
        print(f"기록된 턴이 없어요. ({log})")
        return 0
    rows = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
    print(render(skill, rows))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
