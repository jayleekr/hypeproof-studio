#!/usr/bin/env python3
"""handoff.py 의 selftest 가 **진짜로 잡는지** 변이로 재 본다.

대조군 없는 채점기는 신뢰하지 않는다(.claude/rules/verification.md). selftest 가
초록인 것은 selftest 가 고장났을 때도 똑같이 초록이다. 그래서 제품을 일부러 깨고
**각 변이마다 FAIL 이 떠야 한다**고 요구한다.

    python3 scripts/handoff/mutate_selftest.py      # 20/20 caught 여야 한다

변이 명세를 shell 이 아니라 Python 에 두는 이유: 처음 shell + JSON 으로 넘겼을 때
이중 이스케이프로 **3종이 적용조차 되지 않았다.** 적용되지 않은 변이는 요약만 보면
"잡았다" 와 구별되지 않는다 — 그래서 적용 실패를 별도로 세고 종료 코드에 반영한다.

새 명령이나 새 판정 로직을 handoff.py 에 넣으면 **여기에 변이도 같이 넣는다.**
검증 밖에 있는 명령은 없는 것과 같다(M13 이 그렇게 드러났다).
"""
from __future__ import annotations

import io
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "handoff.py")
TMP = os.path.join(HERE, ".mutant.py")  # 같은 폴더에 둔다 — import 경로가 같아야 한다

# (이름, 원본 조각, 바꿀 것). 한 번에 하나만 적용한다.
MUTATIONS = [
    ("M1  ref shape back to the old \\S",
     r'REF_SHAPE = r"(?:\[|#\d|https?://|[\w.-]+/[\w.-]+#)"',
     r'REF_SHAPE = r"\S"'),
    ("M2  claim allows )",
     'if ")" in value:', 'if False:'),
    ("M3  edit also flips done",
     '            ref=clean_oneline(ref, "ref") if ref is not None else cur.ref,\n        )',
     '            ref=clean_oneline(ref, "ref") if ref is not None else cur.ref,\n            done=True,\n        )'),
    ("M4  unclaim is a no-op",
     '        upd = replace(cur, claim="")', '        upd = replace(cur, claim=cur.claim)'),
    ("M5  roundtrip invariant never raises",
     '            raise Rejected(\n                f"거부: {want.id}',
     '            print(\n                f"거부(무력화): {want.id}'),
    ("M6  refs_in finds nothing",
     '    for m in REF_TOKEN_RE.finditer(ref):', '    for m in []:'),
    ("M7  verify_refs always clean",
     '        if code == 404:', '        if False:'),
    ("M15 rate-limit 403 read as missing",
     '        elif code is None or code >= 400:', '        elif False:'),
    ("M16 any non-200 read as missing",
     '        if code == 404:', '        if code != 200:'),
    ("M17 status line parsed loosely",
     r'STATUS_LINE_RE = re.compile(r"^HTTP/[\d.]+\s+(\d{3})")',
     r'STATUS_LINE_RE = re.compile(r"(\d{3})")'),
    ("M8  newline guard off",
     'if "\\n" in value or "\\r" in value:', 'if False:'),
    ("M9  done no longer records by",
     '        upd = replace(cur, done=True, claim=f"{clean_claim(by)} 완료 · {day}" if by else "")',
     '        upd = replace(cur, done=True, claim="")'),
    ("M10 claim drops the date",
     '        upd = replace(cur, claim=f"{clean_claim(by)} 진행중 · {day}")',
     '        upd = replace(cur, claim=f"{clean_claim(by)} 진행중")'),
    ("M11 bare-number ref matches letters",
     r'|(?P<srepo>[\w.-]+/[\w.-]+)?#(?P<snum>\d+)',
     r'|(?P<srepo>[\w.-]+/[\w.-]+)?#(?P<snum>\w+)'),
    ("M12 empty edit allowed",
     '        if text is None and ref is None:', '        if False:'),
    ("M13 add drops the ref",
     '    new = Item(next_id(items), owner, clean_oneline(text, "text"), ref=clean_oneline(ref, "ref"))',
     '    new = Item(next_id(items), owner, clean_oneline(text, "text"), ref="")'),
    ("M14 splice overwrites the whole body",
     '        return head + block + tail', '        return block'),
    ("M18 an update also clears every other claim",
     '    return [upd if i.id == item_id else i for i in items], upd',
     '    return [upd if i.id == item_id else replace(i, claim="") for i in items], upd'),
    ("M19 an update drops the items after the target",
     '    return [upd if i.id == item_id else i for i in items], upd',
     '    return [upd if i.id == item_id else i for i in items if i.id == item_id], upd'),
    ("M20 an update marks every item done",
     '    return [upd if i.id == item_id else i for i in items], upd',
     '    return [upd if i.id == item_id else replace(i, done=True) for i in items], upd'),
]


def run_selftest(path: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, path, "selftest"], capture_output=True, text=True)


def main() -> int:
    base = io.open(SRC, encoding="utf-8").read()

    # 양성 대조군: 안 건드린 파일은 통과해야 한다. 아니면 아래 "caught" 는 전부 소음이다.
    io.open(TMP, "w", encoding="utf-8").write(base)
    try:
        if run_selftest(TMP).returncode != 0:
            print("ABORT: 변이 없는 selftest 가 이미 실패한다 — 변이 결과를 읽을 수 없다")
            return 2

        survived = notapplied = 0
        for name, old, new in MUTATIONS:
            if old not in base:
                print(f"NOT-APPLIED  {name}   <-- 명세가 원본과 안 맞는다 (리팩터링됐나)")
                notapplied += 1
                continue
            io.open(TMP, "w", encoding="utf-8").write(base.replace(old, new, 1))
            out = run_selftest(TMP)
            if out.returncode == 0:
                print(f"SURVIVED     {name}   <-- selftest 가 못 잡았다")
                survived += 1
            else:
                n = sum(1 for line in out.stdout.splitlines() if line.startswith("FAIL:"))
                # FAIL 단언으로 잡은 것과 예외로 죽은 것을 나눠 찍는다. 둘 다 catch 지만
                # "0 FAIL + 비정상 종료" 는 selftest 가 중간에 멈춘 것이므로 보여야 한다.
                how = f"{n} FAIL" if n else "crash: " + (out.stderr.strip().splitlines() or [""])[-1][:70]
                print(f"caught       {name}   ({how})")
    finally:
        if os.path.exists(TMP):
            os.unlink(TMP)

    caught = len(MUTATIONS) - survived - notapplied
    print(f"\n{caught}/{len(MUTATIONS)} caught, {survived} survived, {notapplied} not applied")
    return 1 if (survived or notapplied) else 0


if __name__ == "__main__":
    sys.exit(main())
