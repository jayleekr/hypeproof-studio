#!/usr/bin/env python3
"""출하되는 HTML 의 **모든** 인라인 스크립트·스타일이 자기 CSP 해시와 맞는지 검사한다.

## 왜 있나

`pre/index.html` 은 **자기 안의 인라인 스크립트의 SHA-256 을 같은 파일의 CSP meta 에**
들고 있다(`script-src 'sha256-…'`). 그 스크립트를 고치고 해시를 그대로 두면 Chromium 이
실행을 거부하고, webview 셸이 내용 iframe 을 만들지 못해 **채팅·시작 화면이 빈 화면**으로
뜬다. 화면에는 원인이 전혀 드러나지 않는다.

2026-09-11 에 정확히 이 일이 일어났다. 마이크 core 패치 v1 이 그 스크립트 안의 한 줄을
고치고 해시를 뒀고, **빌드는 성공했고 `verify-branding.sh` 도 통과했고 아티팩트도 정상**
이었다. 빈 화면은 실기 인수에서야 드러났다. 세 신호가 전부 초록인 채로 나간 것이다.

## 왜 한 블록이 아니라 전부인가

첫 판은 "그 스크립트 하나" 만 봤다. 동료 세션이 짚었다 — 그러면 **다음에 다른 인라인
블록을 건드릴 때 또 빠져나간다.** 결함은 "그 줄" 이 아니라 "인라인 블록과 그 해시가
어긋날 수 있다" 는 계열이다. 그래서 파일의 인라인 `<script>`·`<style>` **전부**와 CSP 의
`script-src`·`style-src` 해시 목록을 대조한다.

앱을 띄우지 않고 밀리초에 끝나고 결정적이다 — 흔들리는 게이트는 곧 무시되므로, 원인이
결정적인 결함은 결정적 검사로 잡는다.

## 쓰기

    python3 scripts/check-webview-csp-hash.py <file.html> [...]
    python3 scripts/check-webview-csp-hash.py --app "/Applications/HypeProof Studio.app"
    python3 scripts/check-webview-csp-hash.py --selftest

`--app` 은 번들 안에서 **CSP 에 해시를 들고 있는 HTML 전부**를 찾아 검사한다. 검사 대상이
0건이면 통과가 아니라 오류다 — 찾지 못한 것은 합격이 아니다.

종료 코드: 0 전부 일치 · 1 불일치(빌드를 세워야 함) · 2 파일/형식/대상없음
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import pathlib
import re
import sys

# 인라인만: `src=` 가 있으면 외부 파일이므로 해시 대상이 아니다.
SCRIPT_RE = re.compile(r"<script(?![^>]*\ssrc=)([^>]*)>(.*?)</script>", re.S | re.I)
STYLE_RE = re.compile(r"<style(?![^>]*\shref=)([^>]*)>(.*?)</style>", re.S | re.I)
# 속성 인용부호를 역참조로 잡는다. CSP 값에는 `'none'`·`'self'`·`'sha256-…'` 처럼
# **단일 인용부호가 가득**하므로 `[^"']*` 로 쓰면 아무것도 못 찾는다 — 첫 판이 그랬고
# selftest 가 잡았다.
CSP_RE = re.compile(r"""content=(["'])((?:(?!\1).)*?(?:script-src|style-src)(?:(?!\1).)*?)\1""", re.I | re.S)
HASH_RE = re.compile(r"'(sha(?:256|384|512)-[A-Za-z0-9+/=]+)'")
DIRECTIVE_RE = re.compile(r"(script-src|style-src)([^;]*)", re.I)
ALGOS = {"sha256": hashlib.sha256, "sha384": hashlib.sha384, "sha512": hashlib.sha512}


def digest(text: str, algo: str = "sha256") -> str:
    return algo + "-" + base64.b64encode(ALGOS[algo](text.encode("utf-8")).digest()).decode()


def declared(html: str) -> dict[str, set[str]]:
    """CSP meta 에서 지시자별 해시 집합을 뽑는다."""
    out: dict[str, set[str]] = {"script-src": set(), "style-src": set()}
    for _quote, content in CSP_RE.findall(html):
        for name, value in DIRECTIVE_RE.findall(content):
            out[name.lower()].update(HASH_RE.findall(value))
    return out


def inline_blocks(html: str) -> list[tuple[str, str]]:
    """(지시자, 본문) 목록. 본문은 요소의 텍스트 내용이며 태그는 포함하지 않는다."""
    blocks = [("script-src", m.group(2)) for m in SCRIPT_RE.finditer(html)]
    blocks += [("style-src", m.group(2)) for m in STYLE_RE.finditer(html)]
    return blocks


def check_file(path: pathlib.Path) -> int:
    try:
        html = path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"✗ 읽을 수 없다: {path} ({e})", file=sys.stderr)
        return 2

    decl = declared(html)
    blocks = inline_blocks(html)
    if not any(decl.values()):
        # CSP 에 해시가 없으면 이 파일은 해시 방식이 아니다 — 검사 대상이 아니다.
        print(f"· CSP 해시 없음 (검사 대상 아님) — {path.name}")
        return 0
    if not blocks:
        print(f"✗ {path}: CSP 에 해시가 있는데 인라인 블록이 없다 — 구조가 바뀌었다", file=sys.stderr)
        return 2

    bad = 0
    for directive, body in blocks:
        want = decl.get(directive, set())
        if not want:
            print(f"✗ {path.name}: 인라인 {directive} 블록이 있는데 CSP 에 해당 해시가 없다", file=sys.stderr)
            bad += 1
            continue
        # CSP 는 여러 알고리즘을 섞어 쓸 수 있다. 선언된 것 중 하나라도 맞으면 통과.
        algos = {h.split("-")[0] for h in want}
        got = {digest(body, a) for a in algos if a in ALGOS}
        if got & want:
            print(f"✓ {directive} 인라인 블록 일치 ({sorted(got & want)[0][:26]}…) — {path.name}")
            continue
        bad += 1
        print(f"✗ CSP 해시 불일치 — {path}", file=sys.stderr)
        print(f"    지시자           : {directive}", file=sys.stderr)
        print(f"    CSP 에 적힌 해시 : {', '.join(sorted(want))}", file=sys.stderr)
        print(f"    블록 실제 해시   : {', '.join(sorted(got))}", file=sys.stderr)
        print("", file=sys.stderr)
        print("  인라인 블록을 고치고 CSP meta 의 해시를 갱신하지 않았다.", file=sys.stderr)
        print("  이 상태로 배포하면 브라우저가 블록을 거부한다 — 스크립트면 **webview 가 빈 화면**이 되고,", file=sys.stderr)
        print("  증상에 원인이 드러나지 않는다. 그래서 여기서 세운다.", file=sys.stderr)
        print("", file=sys.stderr)
        print(f"  고치는 법: CSP 의 해시를 '{sorted(got)[0]}' 로 바꾼다", file=sys.stderr)
        print("  (블록을 **먼저** 고치고 그 결과로 해시를 계산한다 — 순서를 뒤집으면 또 어긋난다)", file=sys.stderr)

    # 블록과 짝이 없는 선언은 남은 쓰레기일 수 있다. 동적으로 삽입되는 스크립트를 위해
    # 정당하게 남겨둘 수도 있으므로 **경고**로만 둔다 — 세우지는 않는다.
    used = {digest(b, a) for d, b in blocks for a in ALGOS}
    for directive, hashes in decl.items():
        for h in sorted(hashes - used):
            print(f"! {path.name}: {directive} 의 '{h[:26]}…' 에 대응하는 인라인 블록이 없다 (동적 삽입용이면 정상)")
    return 1 if bad else 0


def selftest() -> int:
    fails = []

    def check(c, why):
        if not c:
            fails.append(why)

    body = "\nconsole.log(1);\n"
    good = digest(body)
    html = (f'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
            f"script-src '{good}' 'self';\">\n<script async type=\"module\">{body}</script>\n")

    check(declared(html)["script-src"] == {good}, "CSP 해시 추출 실패")
    check(inline_blocks(html) == [("script-src", body)], f"블록 추출 실패: {inline_blocks(html)}")

    # 음성 대조군 — 틀린 해시를 잡아야 한다.
    wrong = html.replace(good, "sha256-" + "A" * 43 + "=")
    d, b = declared(wrong), inline_blocks(wrong)
    check(not ({digest(b[0][1])} & d["script-src"]), "틀린 해시를 못 잡는다")

    # 한 글자만 바꿔도 해시가 달라진다 — 계산이 내용을 실제로 덮는다는 증거.
    check(digest(body) != digest(body.replace("1", "2")), "내용을 바꿨는데 해시가 같다")

    # **계열 일반화**: 두 번째 인라인 블록과 스타일 블록도 잡아야 한다. 첫 판이
    # 한 블록만 봐서 다음 블록이 빠져나갈 수 있었다.
    body2, css = "\nfoo();\n", "\nbody{color:red}\n"
    multi = (f'<meta http-equiv="Content-Security-Policy" content="script-src '
             f"'{digest(body)}' '{digest(body2)}'; style-src '{digest(css)}';\">\n"
             f"<script>{body}</script>\n<script type=\"module\">{body2}</script>\n<style>{css}</style>\n")
    blocks = inline_blocks(multi)
    check(len(blocks) == 3, f"블록 3개를 못 읽었다: {len(blocks)}")
    check(sum(1 for d_, _ in blocks if d_ == "style-src") == 1, "스타일 블록을 못 읽었다")
    dm = declared(multi)
    check(len(dm["script-src"]) == 2 and len(dm["style-src"]) == 1, f"지시자별 해시 수가 틀렸다: {dm}")

    # `src=` 가 있는 외부 스크립트는 인라인이 아니다 — 잡으면 오탐이 된다.
    ext = '<script src="x.js"></script>\n<script>\nok();\n</script>'
    check(len(inline_blocks(ext)) == 1, f"외부 스크립트를 인라인으로 셌다: {inline_blocks(ext)}")

    # 해시가 없는 CSP 는 검사 대상이 아니다(통과도 실패도 아님).
    nohash = '<meta http-equiv="Content-Security-Policy" content="script-src \'self\';">\n<script>x()</script>'
    check(not any(declared(nohash).values()), "해시 없는 CSP 에서 해시를 읽었다")

    # 알고리즘 셋 다.
    for a in ALGOS:
        check(digest(body, a).startswith(a + "-"), f"{a} 계산 실패")

    for f in fails:
        print("FAIL:", f)
    print(f"selftest: {'OK' if not fails else str(len(fails)) + ' failed'}")
    return 1 if fails else 0


def main() -> int:
    p = argparse.ArgumentParser(description="출하 HTML 의 인라인 블록 CSP 해시 검사")
    p.add_argument("paths", nargs="*", help="HTML 파일들")
    p.add_argument("--app", help=".app 번들 — 안에서 CSP 해시를 가진 HTML 을 모두 찾는다")
    p.add_argument("--selftest", action="store_true")
    a = p.parse_args()

    if a.selftest:
        return selftest()

    targets: list[pathlib.Path] = [pathlib.Path(x) for x in a.paths]
    if a.app:
        root = pathlib.Path(a.app) / "Contents/Resources/app/out"
        if not root.is_dir():
            print(f"✗ 번들 구조가 예상과 다르다: {root}", file=sys.stderr)
            return 2
        found = [f for f in root.rglob("*.html") if any(declared(_read(f)).values())]
        if not found:
            # 찾지 못한 것은 합격이 아니다. 해시 방식이 사라졌다면 이 검사를 먼저 고쳐라.
            print(f"✗ {root} 아래에 CSP 해시를 가진 HTML 이 하나도 없다 — 구조가 바뀌었다", file=sys.stderr)
            return 2
        targets += found
    if not targets:
        p.error("파일 경로 또는 --app 또는 --selftest 가 필요하다")

    worst = 0
    for t in targets:
        worst = max(worst, check_file(t))
    return worst


def _read(f: pathlib.Path) -> str:
    try:
        return f.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


if __name__ == "__main__":
    sys.exit(main())
