#!/usr/bin/env python3
"""레지스트리 **사각지대**를 센다 — 어느 노드의 source 도 아닌 소스 파일 (#996).

왜 있나
-------
2026-09-11 `/v1/messages` 의 오디오 거절이 계량 좌석에서만 돌던 구멍(#901 REQ-R3)을
고치다가, 그 라우트 파일이 `config/traceability.json` 의 **어느 노드에도 없다**는 것이
드러났다. 매핑이 없으면 그 파일만 바꾼 PR 은 change-impact 에서 "영향 노드 없음" 으로
지나간다. 구멍이 오래 남은 이유 중 하나다.

이 스크립트는 **판정하지 않고 센다.** 레지스트리가 스스로 bootstrap 범위라고 적어
뒀으므로(`coverage` 필드) 미매핑 자체는 위반이 아니다. 위반이 아니라는 것과 보이지
않는다는 것은 다르고, 여기서 보이게만 만든다. 범위를 어디까지 닫을지는 #996 의 사람
결정이다(인계 큐 H-21).

기본은 **항상 exit 0** 이다. 천장을 정하고 싶으면 `--max-named N` 을 주면 그 수를
넘을 때만 실패한다 — 그 숫자를 고르는 것이 곧 정책이라 기본값을 두지 않는다.

주의
----
`path_links`(hype-pr 평가에 적는 분류)는 이 숫자를 **줄이지 않는다.** 그건 PR 한 건의
판단 기록이고 레지스트리를 바꾸지 않는다. 같은 파일은 다음 PR 에서 또 미매핑이다.

    python3 scripts/check-registry-coverage.py            # 보고
    python3 scripts/check-registry-coverage.py --selftest # 계측기 자체 검증
"""
import argparse
import json
import os
import sys

REGISTRY = "config/traceability.json"
REQUIREMENTS = "docs/studio-requirements.md"
AREAS = [
    ("worker/src/routes", (".ts",)),
    ("worker/src/lib", (".ts",)),
    ("extensions/hypeproof-chat/src", (".ts",)),
    ("extensions/hypeproof-chat/webview-ui/src", (".ts", ".tsx")),
]


def mapped_paths(registry: dict) -> set:
    return {s["path"] for n in registry.get("nodes", []) for s in n.get("sources", [])}


def named_in_requirements(filename: str, text: str) -> bool:
    """요구 문서가 이 파일을 **이름으로 부르나**.

    확장자까지 붙은 언급(`shellPolicy.ts`)과 붙지 않은 언급(`chat-gate`)을 모두 본다.
    짧은 어간(`kv`, `sse`)은 본문의 다른 단어에 우연히 걸리므로 길이로 거른다 — 이
    필터가 없으면 '요구 문서가 부른다' 쪽이 부풀어 결정을 잘못된 크기로 만든다.
    """
    if filename in text:
        return True
    stem = filename.rsplit(".", 1)[0]
    return len(stem) > 6 and stem in text


def sweep(root: str = "."):
    registry = json.load(open(os.path.join(root, REGISTRY), encoding="utf-8"))
    mapped = mapped_paths(registry)
    requirements = open(os.path.join(root, REQUIREMENTS), encoding="utf-8").read()
    areas, named = [], []
    for area, exts in AREAS:
        directory = os.path.join(root, area)
        if not os.path.isdir(directory):
            continue
        files = sorted(f for f in os.listdir(directory) if f.endswith(exts) and not f.endswith(".d.ts"))
        unmapped = [f for f in files if f"{area}/{f}" not in mapped]
        areas.append((area, len(unmapped), len(files)))
        for f in unmapped:
            if named_in_requirements(f, requirements):
                named.append(f"{area}/{f}")
    return areas, sorted(named)


def selftest() -> int:
    """계측기 자체 검증 — 대조군 없는 계측기는 믿지 않는다(.claude/rules/verification.md)."""
    text = "REQ-X 는 `chat-gate` 와 `shellPolicy.ts` 를 계약으로 적는다. kv 저장은 별개다."
    checks = [
        ("확장자까지 적힌 언급을 잡는다", named_in_requirements("shellPolicy.ts", text), True),
        ("확장자 없는 언급을 잡는다", named_in_requirements("chat-gate.ts", text), True),
        ("안 적힌 파일을 잡지 않는다", named_in_requirements("moderation.ts", text), False),
        ("짧은 어간이 우연히 걸리지 않는다", named_in_requirements("kv.ts", text), False),
    ]
    registry = {"nodes": [{"sources": [{"path": "worker/src/routes/chat.ts"}]}]}
    checks.append(("매핑된 경로를 미매핑으로 세지 않는다",
                   "worker/src/routes/chat.ts" in mapped_paths(registry), True))
    checks.append(("매핑되지 않은 경로를 매핑으로 세지 않는다",
                   "worker/src/routes/messages.ts" in mapped_paths(registry), False))
    bad = [name for name, got, want in checks if got is not want]
    for name, got, want in checks:
        print(f"  {'ok  ' if got is want else 'FAIL'}  {name}")
    if bad:
        print("selftest 실패: " + "; ".join(bad))
        return 1
    print("selftest: ok")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="레지스트리 사각지대 보고 (#996)")
    ap.add_argument("--max-named", type=int, default=None,
                    help="요구 문서가 이름을 부르는 미매핑 파일이 이 수를 넘으면 실패한다. "
                         "기본값 없음 — 천장을 고르는 것이 곧 정책이다")
    ap.add_argument("--selftest", action="store_true", help="계측기 자체 검증만 하고 끝낸다")
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    areas, named = sweep()
    print("레지스트리 사각지대 (어느 노드의 source 도 아닌 파일)")
    for area, unmapped, total in areas:
        print(f"  {unmapped:3d} / {total:3d}  {area}")
    print()
    print(f"요구 문서가 이름을 부르는데 매핑되지 않은 파일: {len(named)}개")
    for path in named:
        print(f"  {path}")
    print()
    print("미매핑 자체는 계약 위반이 아니다 — 레지스트리가 bootstrap 범위라고 적어 뒀다.")
    print("다만 매핑되지 않은 파일은 change-impact 에서 '영향 노드 없음' 으로 지나간다 (#996).")
    if args.max_named is not None and len(named) > args.max_named:
        print(f"실패: 천장 {args.max_named} 를 넘었다")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
