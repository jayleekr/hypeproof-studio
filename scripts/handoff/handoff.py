#!/usr/bin/env python3
"""인계 큐 — 에이전트 사이에 "너한테 온 일" 을 한 군데 모아 둔다.

## 왜 있나

Claude 세션끼리는 서로 직접 메시지를 보낼 수 있다. Codex 는 별도 도구라 그 경로가
없고, GitHub 에서도 양쪽이 **같은 계정으로** 글을 쓰기 때문에 assign·mention·review
요청으로 한쪽을 지목할 수 없다. 그래서 사람이 "저 댓글 봐" 를 대신 해주는 상태가 됐다.

이 도구는 그 사람 역할을 없애지 **못한다** — 남의 도구를 실행시킬 수는 없다. 대신
**찾는 비용을 0 으로** 만든다. 이슈 일곱 개를 읽는 대신 한 줄을 돌리면 자기 앞으로 온
미완 항목이 나온다. 그러면 각 세션이 턴 시작에 그 한 줄을 습관으로 돌리기만 하면 사람이
빠진다.

## 저장소를 왜 이슈 본문으로 골랐나

- 댓글: 추가만 되고 상태가 없다. "끝났음" 을 표시하려면 전체를 다시 읽어 마지막 상태를
  추론해야 한다 — 파싱이 불안정하다.
- 레포 파일: 갱신마다 커밋 + PR 흐름이 필요하다. 하루에 여러 번 바뀌는 큐에는 과하다.
- **이슈 본문**: 한 군데, 상태가 있고, `gh issue view --json body` 로 기계가 읽고,
  커밋 없이 갱신된다.

본문 중 **구분자 사이만** 건드린다. 밖은 한 바이트도 바꾸지 않는다 — 그 이슈에는 사람이
쓴 Intent 설명이 있고 그걸 날리면 안 된다.

## 동시 쓰기

이 레포에는 세션이 여러 개 동시에 돈다. 그래서 쓰기 전에 본문을 다시 읽고, 내가 읽었던
것과 달라졌으면 **거부한다**(낙관적 동시성). 덮어쓰면 남의 항목이 조용히 사라진다.

Run:
  python3 scripts/handoff/handoff.py list [--owner codex] [--all]
  python3 scripts/handoff/handoff.py add --owner codex --text "…" [--ref "#898"]
  python3 scripts/handoff/handoff.py done H-03 [--by claude]
  python3 scripts/handoff/handoff.py claim H-03 --by codex
  python3 scripts/handoff/handoff.py selftest        # 네트워크 없이 파싱 왕복 검증
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass, replace

BEGIN = "<!-- HANDOFF:BEGIN — scripts/handoff/handoff.py 가 관리한다. 이 줄 위는 건드리지 않는다 -->"
END = "<!-- HANDOFF:END -->"
OWNERS = ("claude", "codex", "human")

# - [ ] `H-01` **codex** 무엇을 — ref
ITEM_RE = re.compile(
    r"^- \[(?P<done>[ xX])\] `(?P<id>H-\d+)` \*\*(?P<owner>\w+)\*\*(?: _\((?P<claim>[^)]*)\)_)? (?P<text>.*?)(?: — (?P<ref>\S.*))?$"
)


@dataclass(frozen=True)
class Item:
    id: str
    owner: str
    text: str
    done: bool = False
    ref: str = ""
    claim: str = ""

    def render(self) -> str:
        box = "x" if self.done else " "
        claim = f" _({self.claim})_" if self.claim else ""
        ref = f" — {self.ref}" if self.ref else ""
        return f"- [{box}] `{self.id}` **{self.owner}**{claim} {self.text}{ref}"


def parse_items(block: str) -> list[Item]:
    items: list[Item] = []
    for line in block.splitlines():
        m = ITEM_RE.match(line.rstrip())
        if not m:
            continue
        items.append(
            Item(
                id=m.group("id"),
                owner=m.group("owner"),
                text=m.group("text").strip(),
                done=m.group("done").lower() == "x",
                ref=(m.group("ref") or "").strip(),
                claim=(m.group("claim") or "").strip(),
            )
        )
    return items


HEADER = """
## 인계 큐 (자동 관리)

에이전트 사이의 "너한테 온 일" 이 여기 모인다. 자기 앞으로 온 것만 보려면:

```
python3 scripts/handoff/handoff.py list --owner codex
```

규칙: 넘기는 쪽이 항목을 만들고, 받는 쪽이 끝내면 체크한다. 상세는 ref 의 이슈에 있고
여기엔 한 줄만 둔다. 이 블록은 도구가 관리하므로 손으로 고치지 않는다.
"""


def render_block(items: list[Item]) -> str:
    lines = [BEGIN, HEADER.rstrip(), ""]
    openi = [i for i in items if not i.done]
    donei = [i for i in items if i.done]
    lines.append(f"**미완 {len(openi)}건**")
    lines.append("")
    lines.extend(i.render() for i in openi) if openi else lines.append("_(없음)_")
    if donei:
        lines += ["", "<details><summary>완료 " + str(len(donei)) + "건</summary>", ""]
        lines.extend(i.render() for i in donei)
        lines += ["", "</details>"]
    lines.append(END)
    return "\n".join(lines)


def splice(body: str, block: str) -> str:
    """구분자 사이만 교체한다. 없으면 **끝에 덧붙인다** — 절대 덮어쓰지 않는다."""
    if BEGIN in body and END in body:
        head = body[: body.index(BEGIN)]
        tail = body[body.index(END) + len(END) :]
        return head + block + tail
    sep = "" if body.endswith("\n\n") else ("\n" if body.endswith("\n") else "\n\n")
    return body + sep + block + "\n"


def extract_block(body: str) -> str:
    if BEGIN in body and END in body:
        return body[body.index(BEGIN) : body.index(END) + len(END)]
    return ""


def next_id(items: list[Item]) -> str:
    n = max((int(i.id.split("-")[1]) for i in items), default=0) + 1
    return f"H-{n:02d}"


# ── GitHub ──────────────────────────────────────────────────────────────────
def gh_body(repo: str, issue: int) -> str:
    out = subprocess.run(
        ["gh", "issue", "view", str(issue), "--repo", repo, "--json", "body", "--jq", ".body"],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"이슈를 읽지 못했다: {out.stderr.strip()[:300]}")
    return out.stdout


def gh_set_body(repo: str, issue: int, body: str, expect_digest: str) -> None:
    """쓰기 직전에 다시 읽어, 내가 읽었던 것과 다르면 거부한다."""
    current = hashlib.sha256(gh_body(repo, issue).encode()).hexdigest()
    if current != expect_digest:
        sys.exit(
            "거부: 내가 읽은 뒤 이슈 본문이 바뀌었다 (다른 세션이 썼다). "
            "다시 실행하면 최신 상태에서 다시 시도한다."
        )
    import tempfile, os
    fd, path = tempfile.mkstemp(suffix=".md")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(body)
    try:
        out = subprocess.run(
            ["gh", "issue", "edit", str(issue), "--repo", repo, "--body-file", path],
            capture_output=True, text=True,
        )
        if out.returncode != 0:
            sys.exit(f"이슈를 쓰지 못했다: {out.stderr.strip()[:300]}")
    finally:
        os.unlink(path)


def load(repo: str, issue: int) -> tuple[str, str, list[Item]]:
    body = gh_body(repo, issue)
    return body, hashlib.sha256(body.encode()).hexdigest(), parse_items(extract_block(body))


def save(repo: str, issue: int, body: str, digest: str, items: list[Item], dry: bool) -> None:
    new = splice(body, render_block(items))
    if dry:
        print(render_block(items))
        print("\n[dry-run] 쓰지 않았다")
        return
    gh_set_body(repo, issue, new, digest)


# ── selftest: 네트워크 없이 파싱·렌더·splice 를 검증한다 ────────────────────
def selftest() -> int:
    fails = []

    def check(cond, why):
        if not cond:
            fails.append(why)

    # 왕복: 렌더한 것을 다시 파싱하면 같아야 한다.
    items = [
        Item("H-01", "codex", "빌드로 네 번째 관문 측정", ref="[#898](x)"),
        Item("H-02", "claude", "원가 문서 반영", done=True, ref="#922"),
        Item("H-03", "codex", "임계값 측정", claim="codex 진행중"),
    ]
    again = parse_items(render_block(items))
    # 렌더는 미완을 먼저, 완료를 뒤로 **재정렬한다**(사람이 읽는 순서). 그래서 왕복을
    # 리스트 동일성으로 재면 안 된다 — 처음 그렇게 썼고 selftest 가 잡았다.
    # 보존되어야 하는 것은 **항목의 집합과 각 필드**이고, 순서는 표현 선택이다.
    check({i.id: i for i in again} == {i.id: i for i in items}, f"왕복에서 항목이 변했다: {again}")
    check(len(again) == len(items), f"왕복에서 항목 수가 변했다: {len(again)} vs {len(items)}")
    # 그리고 의도한 묶음 순서는 지켜져야 한다 — 미완이 완료보다 앞.
    order = [i.done for i in again]
    check(order == sorted(order), f"미완/완료 묶음 순서가 깨졌다: {order}")

    # splice 는 블록 **밖**을 한 바이트도 바꾸지 않는다.
    body = "사람이 쓴 설명\n\n두 번째 문단\n"
    once = splice(body, render_block(items))
    check(once.startswith(body.rstrip("\n")), "splice 가 앞부분을 훼손했다")
    twice = splice(once, render_block(items))
    check(once == twice, "splice 가 멱등이 아니다 — 반복하면 블록이 쌓인다")
    check(once.count(BEGIN) == 1, "BEGIN 이 여러 개 생겼다")

    # 블록만 바꾸고 밖은 보존.
    changed = splice(once, render_block(items[:1]))
    check(body.rstrip("\n") in changed, "블록 교체가 사람 글을 날렸다")
    check(len(parse_items(extract_block(changed))) == 1, "교체된 블록의 항목 수가 틀렸다")

    # 음성 대조군: 체크리스트처럼 보이지만 형식이 아닌 줄은 항목이 아니다.
    noise = f"{BEGIN}\n- [ ] 그냥 할 일\n- [ ] `X-01` **codex** 잘못된 id\n{END}"
    check(parse_items(noise) == [], f"형식 아닌 줄을 항목으로 읽었다: {parse_items(noise)}")

    # 양성 대조군: 파서가 아무것도 못 읽는 고장이 아니다.
    check(len(parse_items(render_block(items))) == 3, "파서가 정상 항목을 못 읽는다")

    # id 증가가 최대값 기준이다(구멍이 있어도 재사용하지 않는다).
    check(next_id([Item("H-01", "codex", "a"), Item("H-07", "codex", "b")]) == "H-08", "id 증가가 틀렸다")
    check(next_id([]) == "H-01", "빈 큐의 첫 id 가 틀렸다")

    for f in fails:
        print("FAIL:", f)
    print(f"selftest: {'OK' if not fails else str(len(fails)) + ' failed'}")
    return 1 if fails else 0


def main() -> int:
    p = argparse.ArgumentParser(description="에이전트 인계 큐")
    p.add_argument("--repo", default="jayleekr/hypeproof-studio")
    p.add_argument("--issue", type=int, default=896)
    p.add_argument("--dry-run", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list", help="미완 항목 (자기 것만 보려면 --owner)")
    pl.add_argument("--owner", choices=OWNERS)
    pl.add_argument("--all", action="store_true", help="완료까지 보기")
    pl.add_argument("--json", action="store_true")

    pa = sub.add_parser("add", help="항목 추가")
    pa.add_argument("--owner", choices=OWNERS, required=True)
    pa.add_argument("--text", required=True)
    pa.add_argument("--ref", default="")

    pd = sub.add_parser("done", help="완료 표시")
    pd.add_argument("id")
    pd.add_argument("--by", choices=OWNERS)

    pc = sub.add_parser("claim", help="진행중 표시")
    pc.add_argument("id")
    pc.add_argument("--by", choices=OWNERS, required=True)

    sub.add_parser("selftest", help="네트워크 없이 파싱 검증")

    a = p.parse_args()
    if a.cmd == "selftest":
        return selftest()

    body, digest, items = load(a.repo, a.issue)

    if a.cmd == "list":
        sel = [i for i in items if a.all or not i.done]
        if a.owner:
            sel = [i for i in sel if i.owner == a.owner]
        if a.json:
            print(json.dumps([i.__dict__ for i in sel], ensure_ascii=False, indent=2))
        elif not sel:
            print("미완 항목 없음" + (f" (owner={a.owner})" if a.owner else ""))
        else:
            for i in sel:
                print(i.render())
        return 0

    by_id = {i.id: i for i in items}

    if a.cmd == "add":
        new = Item(next_id(items), a.owner, a.text, ref=a.ref)
        items = items + [new]
        print("추가:", new.render())
    elif a.cmd in ("done", "claim"):
        if a.id not in by_id:
            sys.exit(f"{a.id} 가 큐에 없다. `list --all` 로 확인하라.")
        cur = by_id[a.id]
        upd = replace(cur, done=True, claim="") if a.cmd == "done" else replace(cur, claim=f"{a.by} 진행중")
        items = [upd if i.id == a.id else i for i in items]
        print(("완료: " if a.cmd == "done" else "진행중: ") + upd.render())

    save(a.repo, a.issue, body, digest, items, a.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
