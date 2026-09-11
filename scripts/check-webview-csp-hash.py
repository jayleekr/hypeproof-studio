#!/usr/bin/env python3
"""webview 셸의 인라인 스크립트 CSP 해시가 스크립트와 일치하는지 검사한다.

## 왜 있나

`pre/index.html` 은 **자기 안의 인라인 스크립트의 SHA-256 을 같은 파일의 CSP meta 에**
들고 있다(`script-src 'sha256-…'`). 그 스크립트를 고치고 해시를 그대로 두면 Chromium 이
실행을 거부하고, webview 셸이 내용 iframe 을 만들지 못해 **채팅·시작 화면이 빈 화면**으로
뜬다. 콘솔을 열지 않으면 원인을 알 수 없다.

2026-09-11 에 정확히 이 일이 일어났다. 마이크 core 패치(v1)가 그 스크립트 안의 한 줄을
고치고 해시를 두었고, 빌드는 **성공했고** `verify-branding.sh` 도 통과했고 아티팩트도
나왔다. 빈 화면은 실기 인수에서야 드러났다. 빌드 성공이 앱이 켜진다는 뜻이 아니었다.

이 검사는 그걸 **빌드 실패**로 바꾼다. 배포 뒤에 사람이 발견하는 대신.

## 쓰기

    python3 scripts/check-webview-csp-hash.py <path-to-pre/index.html>
    python3 scripts/check-webview-csp-hash.py --app "/Applications/HypeProof Studio.app"
    python3 scripts/check-webview-csp-hash.py --selftest

종료 코드: 0 일치 · 1 불일치(빌드를 세워야 함) · 2 파일/형식 문제
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import pathlib
import re
import sys

SCRIPT_RE = re.compile(r"<script async type=\"module\">(.*?)</script>", re.S)
CSP_HASH_RE = re.compile(r"script-src\s+'(sha256-[A-Za-z0-9+/=]+)'")
BUNDLE_SUBPATH = "Contents/Resources/app/out/vs/workbench/contrib/webview/browser/pre/index.html"


def script_hash(html: str) -> str:
    """script 요소의 **텍스트 내용**을 SHA-256 → base64. 태그는 포함하지 않는다.

    이 계산이 맞는지는 짐작하지 않는다 — 정상 파일에서 **파일에 적힌 해시를 재현**하는 것이
    이 함수의 유일한 검증이고, `--selftest` 와 아래 호출부가 그걸 한다.
    """
    m = SCRIPT_RE.search(html)
    if not m:
        raise ValueError("인라인 스크립트(<script async type=\"module\">)를 못 찾았다")
    return "sha256-" + base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode()


def declared_hash(html: str) -> str:
    m = CSP_HASH_RE.search(html)
    if not m:
        raise ValueError("CSP meta 에서 script-src 해시를 못 찾았다")
    return m.group(1)


def check(path: pathlib.Path) -> int:
    try:
        html = path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"✗ 읽을 수 없다: {path} ({e})", file=sys.stderr)
        return 2
    try:
        want, got = declared_hash(html), script_hash(html)
    except ValueError as e:
        # 구조가 바뀌면 **통과시키지 않는다.** 검사가 대상을 못 찾는 것은 합격이 아니다.
        print(f"✗ {path}: {e}", file=sys.stderr)
        print("  업스트림 구조가 바뀌었다면 이 스크립트를 먼저 고쳐라 — 조용히 통과시키지 않는다.", file=sys.stderr)
        return 2
    if want == got:
        print(f"✓ CSP 해시 일치 ({got[:24]}…) — {path.name}")
        return 0
    print(f"✗ CSP 해시 불일치 — {path}", file=sys.stderr)
    print(f"    CSP 에 적힌 해시 : {want}", file=sys.stderr)
    print(f"    스크립트 실제 해시: {got}", file=sys.stderr)
    print("", file=sys.stderr)
    print("  인라인 스크립트를 고치고 CSP meta 의 해시를 갱신하지 않았다.", file=sys.stderr)
    print("  이 상태로 배포하면 Chromium 이 스크립트를 거부하고 **webview 가 빈 화면**이 된다.", file=sys.stderr)
    print("  증상에 원인이 드러나지 않으므로 여기서 세운다.", file=sys.stderr)
    print("", file=sys.stderr)
    print(f"  고치는 법: CSP meta 의 '{want}' 를 '{got}' 로 바꾼다", file=sys.stderr)
    print("  (스크립트를 **먼저** 고치고 그 결과로 해시를 계산한다 — 순서를 뒤집으면 또 어긋난다)", file=sys.stderr)
    return 1


def selftest() -> int:
    """계산이 맞는지와 **불일치를 실제로 잡는지** 둘 다 본다."""
    fails = []
    base = ('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
            "script-src 'REPLACE' 'self';\">\n<script async type=\"module\">\nconsole.log(1);\n</script>\n")
    body = SCRIPT_RE.search(base).group(1)
    good_hash = "sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()

    # 양성 대조군 — 맞는 해시가 적혀 있으면 통과해야 한다.
    ok_html = base.replace("REPLACE", good_hash)
    if script_hash(ok_html) != declared_hash(ok_html):
        fails.append("맞는 해시를 불일치로 본다")

    # 음성 대조군 — 틀린 해시를 잡아야 한다. 이게 없으면 '항상 통과' 구현도 위를 만족한다.
    bad_html = base.replace("REPLACE", "sha256-" + "A" * 43 + "=")
    if script_hash(bad_html) == declared_hash(bad_html):
        fails.append("틀린 해시를 못 잡는다")

    # 스크립트 한 글자만 바꿔도 해시가 바뀌어야 한다 — 계산이 스크립트를 실제로 덮는다는 증거.
    changed = ok_html.replace("console.log(1);", "console.log(2);")
    if script_hash(changed) == script_hash(ok_html):
        fails.append("스크립트를 바꿨는데 해시가 같다 — 계산이 내용을 덮지 않는다")

    # 구조가 없으면 통과가 아니라 오류여야 한다.
    for broken, why in [("<p>no script</p>", "스크립트 없음"), ("<script async type=\"module\">x</script>", "CSP 없음")]:
        try:
            declared_hash(broken) if why == "CSP 없음" else script_hash(broken)
            fails.append(f"{why} 인데 조용히 통과했다")
        except ValueError:
            pass

    for f in fails:
        print("FAIL:", f)
    print(f"selftest: {'OK' if not fails else str(len(fails)) + ' failed'}")
    return 1 if fails else 0


def main() -> int:
    p = argparse.ArgumentParser(description="webview 인라인 스크립트의 CSP 해시 검사")
    p.add_argument("path", nargs="?", help="pre/index.html 경로")
    p.add_argument("--app", help=".app 번들 경로 (안의 pre/index.html 을 찾는다)")
    p.add_argument("--selftest", action="store_true")
    a = p.parse_args()

    if a.selftest:
        return selftest()
    if a.app:
        target = pathlib.Path(a.app) / BUNDLE_SUBPATH
        if not target.exists():
            print(f"✗ 번들에서 못 찾았다: {target}", file=sys.stderr)
            return 2
        return check(target)
    if not a.path:
        p.error("경로 또는 --app 또는 --selftest 가 필요하다")
    return check(pathlib.Path(a.path))


if __name__ == "__main__":
    sys.exit(main())
