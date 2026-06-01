#!/usr/bin/env python3
"""histogram.py 회귀 테스트. 실행: python3 test_histogram.py

분모 의미(자산별 non-null 채점 턴)와 None-safe 4종(scores=null, scores 키부재,
자산 키부재, 자산 score=null)을 단언한다. measurement-architecture.md §5 P0.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from histogram import render, asset_score  # noqa: E402

# 4종 모드를 모두 담은 fixture
ROWS = [
    # 1) 첫 턴 — 전부 null (judge-rubric: 첫 턴은 기록만)
    {"scores": {k: {"score": None} for k in
                ["intent_clarity", "taste", "context_design", "verification_reflex",
                 "delegation_judgment", "iteration_reflex", "ownership"]}},
    # 2) 혼합 — 0/1/2 + 일부 null
    {"scores": {"intent_clarity": {"score": 2}, "taste": {"score": 1},
                "context_design": {"score": 1}, "verification_reflex": {"score": 0},
                "delegation_judgment": {"score": 1}, "iteration_reflex": {"score": None},
                "ownership": {"score": None}}},
    # 3) 일부 자산 키 자체가 없음
    {"scores": {"intent_clarity": {"score": 2}, "verification_reflex": {"score": 2}}},
    # 4) scores 키 자체가 없음
    {},
]


def asset_count(key):
    """(발현, 분모) — render와 동일 규칙."""
    scored = [v for r in ROWS if (v := asset_score(r, key)) is not None]
    return sum(1 for v in scored if v >= 1), len(scored)


def check(cond, msg):
    if not cond:
        print(f"  ✗ {msg}")
        return False
    print(f"  ✓ {msg}")
    return True


def main():
    ok = True
    # None-safe: 크래시 없이 렌더된다
    try:
        out = render("desk-kim", ROWS)
        ok &= check(True, "4종 모드 fixture를 크래시 없이 렌더")
    except Exception as e:  # noqa: BLE001
        ok &= check(False, f"렌더 중 예외: {type(e).__name__}: {e}")
        return 1

    # 분모 = 자산별 non-null 채점 턴 (0과 null 구분)
    ok &= check(asset_count("intent_clarity") == (2, 2), "intent_clarity 2/2 (턴2·3)")
    ok &= check(asset_count("verification_reflex") == (1, 2), "verification 1/2 (턴2=0, 턴3=2 → 0과 null 구분)")
    ok &= check(asset_count("taste") == (1, 1), "taste 1/1 (턴2만 채점)")
    ok &= check(asset_count("iteration_reflex") == (0, 0), "iteration 0/0 = 미채점 (항상 null)")
    ok &= check("미채점" in out, "미채점 자산 라벨 노출")
    ok &= check("점수 매겨진" in out, "분모 라벨 노출")

    # 빈 로그 / 전부 미채점도 안전
    ok &= check(render("x", [{}]) is not None, "scores 없는 단일 행도 안전")

    print("\nPASS" if ok else "\nFAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
