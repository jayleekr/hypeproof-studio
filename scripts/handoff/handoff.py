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

## owner 와 claim 은 다른 것이다

- `owner` — **어떤 종류의 일인가**(claude / codex / human). 잘 안 바뀐다.
- `claim` — **지금 누가 들고 있나**. 임시다. 세션 이름은 금방 낡으므로 owner 에 쓰지
  않고 claim 에만 쓴다. 날짜를 함께 박아서 **낡은 claim 이 눈에 보이게** 한다.

## 동시 쓰기

이 레포에는 세션이 여러 개 동시에 돈다. 그래서 쓰기 전에 본문을 다시 읽고, 내가 읽었던
것과 달라졌으면 **거부한다**(낙관적 동시성). 덮어쓰면 남의 항목이 조용히 사라진다.

Run:
  python3 scripts/handoff/handoff.py list [--owner codex] [--all] [--json]
  python3 scripts/handoff/handoff.py add --owner codex --text "…" [--ref "#898"]
  python3 scripts/handoff/handoff.py claim H-03 --by "codex (pane 2)"
  python3 scripts/handoff/handoff.py unclaim H-03
  python3 scripts/handoff/handoff.py edit H-03 [--text "…"] [--ref "#899"]
  python3 scripts/handoff/handoff.py done H-03 [--by claude]
  python3 scripts/handoff/handoff.py selftest        # 네트워크 없이 파싱 왕복 검증

`--ref` 는 기본적으로 **실제로 존재하는지 확인한다**(`--no-verify` 로 끈다). 없는 번호를
적어 놓은 적이 있어서 넣었다 — 받는 쪽은 그 번호를 열어 보고서야 알게 된다.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass, replace

BEGIN = "<!-- HANDOFF:BEGIN — scripts/handoff/handoff.py 가 관리한다. 이 줄 위는 건드리지 않는다 -->"
END = "<!-- HANDOFF:END -->"
OWNERS = ("claude", "codex", "human")

# ref 의 모양. **이게 왜 필요한가**: 항목 한 줄은 `text — ref` 로 쓰는데, 이 레포의 산문은
# ` — ` 를 일상적으로 쓴다. 그래서 "첫 번째 ` — ` 에서 자른다" 로 두면 산문 뒷부분이 ref
# 필드로 새어 들어간다. 실제 큐 #896 의 14건 중 **7건이 그렇게 깨져 있었다** — `list` 출력은
# 다시 합쳐서 렌더하므로 멀쩡해 보이고, `--json` 을 봐야 드러난다.
#
# 그래서 ref 는 **ref 처럼 생긴 꼬리**일 때만 ref 다: `#123` · `[…](…)` · `http…` ·
# `owner/repo#123`. 산문은 이 모양이 아니므로 text 에 남는다.
REF_SHAPE = r"(?:\[|#\d|https?://|[\w.-]+/[\w.-]+#)"

# - [ ] `H-01` **codex** _(claim)_ 무엇을 — ref
ITEM_RE = re.compile(
    r"^- \[(?P<done>[ xX])\] `(?P<id>H-\d+)` \*\*(?P<owner>\w+)\*\*"
    r"(?: _\((?P<claim>[^)]*)\)_)? (?P<text>.*?)"
    r"(?: — (?P<ref>" + REF_SHAPE + r".*))?$"
)

# ref 문자열 안의 이슈·PR 지목을 뽑는다. 두 모양을 다룬다:
#   URL      https://github.com/owner/repo/(issues|pull)/123
#   짧은 꼴  #123  ·  owner/repo#123
# `#issuecomment-5636864856` 같은 앵커는 `#` 뒤가 숫자가 아니라 걸리지 않는다.
REF_TOKEN_RE = re.compile(
    r"https?://github\.com/(?P<urepo>[\w.-]+/[\w.-]+)/(?:issues|pull)/(?P<unum>\d+)"
    r"|(?P<srepo>[\w.-]+/[\w.-]+)?#(?P<snum>\d+)"
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
여기엔 한 줄만 둔다. `**owner**` 는 일의 종류고 `_(…)_` 는 지금 누가 들고 있나다 —
들고 있던 걸 놓을 때는 `unclaim`. 이 블록은 도구가 관리하므로 손으로 고치지 않는다.
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


class Rejected(Exception):
    """쓰기 전에 막힌 것. 사용자 입력이 형식을 깨뜨릴 때."""


def assert_roundtrip(items: list[Item]) -> None:
    """렌더한 것을 다시 읽으면 같아야 한다. **쓰기 직전마다** 확인한다.

    정규식을 아무리 다듬어도 `text`/`ref` 경계는 모양 추론이라 새 입력이 들어오면
    또 어긋날 수 있다. 그래서 한 사례를 고치는 대신 **불변식으로 막는다** — 왕복이
    깨지는 블록은 애초에 쓰지 않는다. 깨진 채로 쓰면 `list` 출력은 멀쩡해 보이고
    `--json` 을 보는 쪽만 조용히 틀린다.
    """
    back = {i.id: i for i in parse_items(render_block(items))}
    for want in items:
        got = back.get(want.id)
        if got != want:
            raise Rejected(
                f"거부: {want.id} 가 왕복에서 변한다 — 그대로 쓰면 ref 필드가 틀린다.\n"
                f"  쓰려던 것: text={want.text!r} ref={want.ref!r}\n"
                f"  다시 읽으면: text={(got.text if got else None)!r} ref={(got.ref if got else None)!r}\n"
                f"  text 가 ` — ` 뒤에 ref 처럼 생긴 토막(#123·[…]·http…)을 품으면 이렇게 된다. "
                f"`--ref` 로 분리하거나 text 를 고쳐라."
            )


def clean_oneline(value: str, field: str) -> str:
    """한 줄 필드를 지킨다. 줄바꿈은 항목 하나를 두 줄로 쪼개 큐를 깨뜨린다."""
    if "\n" in value or "\r" in value:
        raise Rejected(f"거부: --{field} 에 줄바꿈이 있다. 항목은 한 줄이다.")
    return value.strip()


def clean_claim(value: str) -> str:
    """claim 은 `_( … )_` 안에 들어가므로 `)` 가 있으면 파싱이 끊긴다."""
    value = clean_oneline(value, "by")
    if ")" in value:
        raise Rejected("거부: --by 에 `)` 가 있다. claim 은 `_( … )_` 안에 들어가서 파싱이 끊긴다.")
    if not value:
        raise Rejected("거부: --by 가 비었다.")
    return value


def today(clock: datetime.datetime | None = None) -> str:
    return (clock or datetime.datetime.now(datetime.timezone.utc)).strftime("%Y-%m-%d")


# ── ref 존재 확인 ────────────────────────────────────────────────────────────
def refs_in(ref: str, default_repo: str) -> list[tuple[str, int]]:
    """ref 문자열에서 (repo, number) 를 중복 없이 뽑는다."""
    out: list[tuple[str, int]] = []
    for m in REF_TOKEN_RE.finditer(ref):
        if m.group("unum"):
            pair = (m.group("urepo"), int(m.group("unum")))
        else:
            pair = (m.group("srepo") or default_repo, int(m.group("snum")))
        if pair not in out:
            out.append(pair)
    return out


STATUS_LINE_RE = re.compile(r"^HTTP/[\d.]+\s+(\d{3})")


def gh_status(repo: str, num: int) -> int | None:
    """HTTP 상태 코드를 돌려준다. 알 수 없으면 None.

    **왜 종료 코드로 안 보나**: 첫 판은 `gh api` 의 비정상 종료를 곧 "없다" 로 읽었다.
    그랬더니 GitHub 이 초당 요청을 많이 받아 **403 으로 막은 순간 실재하는 #898 을
    "존재하지 않는 지목" 으로 거부했다**. 검증기가 자기 고장을 제품 결함으로 보고한 것이다
    (.claude/rules/verification.md 규칙 6, "401 을 만료로 읽지 마라" 와 같은 계열).

    REST `issues/<n>` 는 **PR 도 돌려준다** — 이슈·PR 을 한 경로로 확인한다.
    `gh issue view` 는 GraphQL Issue 조회라 PR 번호에서 실패하므로 쓰지 않는다.
    """
    out = subprocess.run(
        ["gh", "api", f"repos/{repo}/issues/{num}", "-i", "--silent"],
        capture_output=True, text=True,
    )
    first = (out.stdout.strip().splitlines() or [""])[0]
    m = STATUS_LINE_RE.match(first)
    return int(m.group(1)) if m else None


def verify_refs(ref: str, default_repo: str, status=gh_status) -> tuple[list[str], list[str]]:
    """(없는 지목, 판정 불가) 를 돌려준다.

    404 만 "없다" 다. 403·5xx·응답 없음은 **판정 불가**이고 작업을 막지 않는다 —
    막으면 GitHub 이 잠깐 느릴 때마다 멀쩡한 인계가 거부된다.
    """
    missing: list[str] = []
    unknown: list[str] = []
    for repo, num in refs_in(ref, default_repo):
        code = status(repo, num)
        if code == 404:
            missing.append(f"{repo}#{num}")
        elif code is None or code >= 400:
            unknown.append(f"{repo}#{num} (HTTP {code})")
    return missing, unknown


# ── 순수 변환 (네트워크 없이 검증 가능) ──────────────────────────────────────
def apply_add(items: list[Item], owner: str, text: str, ref: str) -> tuple[list[Item], Item]:
    new = Item(next_id(items), owner, clean_oneline(text, "text"), ref=clean_oneline(ref, "ref"))
    return items + [new], new


def apply_update(
    items: list[Item],
    item_id: str,
    cmd: str,
    *,
    by: str = "",
    text: str | None = None,
    ref: str | None = None,
    day: str = "",
) -> tuple[list[Item], Item]:
    by_id = {i.id: i for i in items}
    if item_id not in by_id:
        raise Rejected(f"{item_id} 가 큐에 없다. `list --all` 로 확인하라.")
    cur = by_id[item_id]

    if cmd == "claim":
        upd = replace(cur, claim=f"{clean_claim(by)} 진행중 · {day}")
    elif cmd == "unclaim":
        # 놓는 쪽. 이게 없어서 잘못 찍은 claim 을 되돌릴 길이 없었다.
        upd = replace(cur, claim="")
    elif cmd == "done":
        upd = replace(cur, done=True, claim=f"{clean_claim(by)} 완료 · {day}" if by else "")
    elif cmd == "edit":
        # **내용만** 고친다. done·owner·id 는 건드리지 않는다 — 완료 이력을 글 고치다가
        # 뒤집는 사고를 막는다. 되돌리려면 해당 명령을 쓴다.
        if text is None and ref is None:
            raise Rejected("거부: edit 에 --text 나 --ref 중 하나는 있어야 한다.")
        upd = replace(
            cur,
            text=clean_oneline(text, "text") if text is not None else cur.text,
            ref=clean_oneline(ref, "ref") if ref is not None else cur.ref,
        )
    else:  # pragma: no cover - argparse 가 먼저 막는다
        raise Rejected(f"모르는 명령: {cmd}")

    return [upd if i.id == item_id else i for i in items], upd


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
    assert_roundtrip(items)
    new = splice(body, render_block(items))
    if dry:
        print(render_block(items))
        print("\n[dry-run] 쓰지 않았다")
        return
    gh_set_body(repo, issue, new, digest)


# ── selftest: 네트워크 없이 파싱·렌더·splice·명령을 검증한다 ────────────────
def selftest() -> int:
    fails = []

    def check(cond, why):
        if not cond:
            fails.append(why)

    def raises(fn, why):
        try:
            fn()
        except Rejected:
            return
        fails.append(why)

    # 왕복: 렌더한 것을 다시 파싱하면 같아야 한다.
    items = [
        Item("H-01", "codex", "빌드로 네 번째 관문 측정", ref="[#898](x)"),
        Item("H-02", "claude", "원가 문서 반영", done=True, ref="#922"),
        Item("H-03", "codex", "임계값 측정", claim="codex 진행중 · 2026-09-11"),
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

    # ── text 안의 ` — ` (실제 큐 14건 중 7건을 깨뜨리고 있었다) ──────────────
    dashed = Item("H-04", "codex", "VO-08 임계값 실측 — 한국어 발화의 오탐 비율", ref="[#898](x)")
    rt = parse_items(dashed.render())
    check(rt == [dashed], f"text 의 ` — ` 가 ref 로 새어 들어갔다: {rt}")

    # **음성 대조군**: 고치기 전의 정규식으로는 이 케이스가 **실패해야** 한다. 실패하지
    # 않으면 위 검사는 아무것도 재지 않는다(고장난 계측기는 늘 통과한다).
    old_re = re.compile(
        r"^- \[(?P<done>[ xX])\] `(?P<id>H-\d+)` \*\*(?P<owner>\w+)\*\*"
        r"(?: _\((?P<claim>[^)]*)\)_)? (?P<text>.*?)(?: — (?P<ref>\S.*))?$"
    )
    om = old_re.match(dashed.render())
    check(om is not None and om.group("text") != dashed.text,
          "음성 대조군이 안 터졌다 — 이 검사는 고친 것을 재고 있지 않다")

    # ref 없이 text 가 ` — ` 로 끝나는 산문도 보존된다.
    tail = Item("H-05", "human", "판단 필요 — 범위가 넓다")
    check(parse_items(tail.render()) == [tail], f"ref 없는 산문이 쪼개졌다: {parse_items(tail.render())}")

    # ref 의 여러 모양이 다 붙는다 (양성 대조군).
    for shape in ("#898", "[#898](https://x/y/issues/898)", "https://github.com/a/b/pull/2",
                  "jayleekr/vscodium#2", "[PR](https://github.com/a/b/pull/9)"):
        it = Item("H-06", "codex", "무엇을 한다", ref=shape)
        check(parse_items(it.render()) == [it], f"ref 모양 {shape!r} 가 왕복에서 깨졌다")

    # ── 왕복 불변식이 실제로 막는가 ──────────────────────────────────────────
    # 알려진 한계: text 가 ` — ` 뒤에 ref 모양을 품으면 구분할 수 없다. 그걸 조용히
    # 쓰지 않고 **거부한다**. (막지 못하는 게 아니라, 막는 걸 확인한다.)
    raises(lambda: assert_roundtrip([Item("H-07", "codex", "보고 — #1")]),
           "text 가 ref 모양 토막을 품는데 왕복 불변식이 통과시켰다")
    # 양성 대조군: 정상 항목은 통과한다 (불변식이 전부 거부하는 고장이 아니다).
    assert_roundtrip(items + [dashed, tail])

    # ── 한 줄·claim 위생 ────────────────────────────────────────────────────
    raises(lambda: clean_oneline("두\n줄", "text"), "줄바꿈이 통과했다 — 항목이 두 줄로 쪼개진다")
    raises(lambda: clean_claim("codex (pane 2)"), "`)` 가 있는 claim 이 통과했다 — 파싱이 끊긴다")
    check(clean_claim("  codex pane 2  ") == "codex pane 2", "claim 공백 정리가 틀렸다")

    # ── 명령 변환 ──────────────────────────────────────────────────────────
    # add: 변이 시험(M13)에서 `ref` 를 버리는 고장이 살아남았다 — apply_add 를 아예 한 번도
    # 돌리지 않고 있었다. 명령 하나가 검증 밖에 있으면 그 명령은 없는 것과 같다.
    one, added = apply_add([], "codex", "새 일", "#898")
    check((added.id, added.owner, added.text, added.ref, added.done) == ("H-01", "codex", "새 일", "#898", False),
          f"add 가 필드를 잃었다: {added}")
    two, added2 = apply_add(one, "human", "두 번째", "")
    check([i.id for i in two] == ["H-01", "H-02"], f"add 가 덧붙이지 않았다: {[i.id for i in two]}")
    check(added2.ref == "" and two[0] == added, "add 가 기존 항목을 건드렸다")
    raises(lambda: apply_add([], "codex", "두\n줄", ""), "줄바꿈 있는 add 가 통과했다")

    base = [Item("H-01", "codex", "무엇을", ref="#1"), Item("H-02", "claude", "완료된 것", done=True)]
    _, c = apply_update(base, "H-01", "claim", by="codex cli", day="2026-09-11")
    check(c.claim == "codex cli 진행중 · 2026-09-11", f"claim 렌더가 틀렸다: {c.claim}")
    check(parse_items(c.render())[0].claim == c.claim, "날짜 박힌 claim 이 왕복에서 깨졌다")
    after_claim, _ = apply_update(base, "H-01", "claim", by="codex cli", day="2026-09-11")
    _, u = apply_update(after_claim, "H-01", "unclaim")
    check(u.claim == "" and not u.done, f"unclaim 이 claim 만 비우지 않았다: {u}")
    _, d = apply_update(base, "H-01", "done", by="claude", day="2026-09-11")
    check(d.done and d.claim == "claude 완료 · 2026-09-11", f"done 이 틀렸다: {d}")
    _, d2 = apply_update(base, "H-01", "done")
    check(d2.done and d2.claim == "", f"--by 없는 done 이 claim 을 남겼다: {d2}")

    # edit 은 **내용만** 고친다 — 완료 이력·owner 를 뒤집지 않는다.
    _, e = apply_update(base, "H-02", "edit", text="고친 글")
    check(e.text == "고친 글" and e.done is True and e.owner == "claude",
          f"edit 이 완료 항목의 done/owner 를 건드렸다: {e}")
    # **미완** 항목으로도 확인한다. 완료 항목만 보면 `edit` 이 done 을 True 로 덮는
    # 고장을 잡지 못한다 — 이미 True 라서 값이 맞는 이유가 다르다. 첫 판이 그랬고
    # 변이 시험(M3)이 살아남아서 드러났다.
    _, e0 = apply_update(base, "H-01", "edit", text="고친 글")
    check(e0.done is False, f"edit 이 미완 항목을 완료로 뒤집었다: {e0}")
    _, e2 = apply_update(base, "H-01", "edit", ref="#2")
    check(e2.ref == "#2" and e2.text == "무엇을", f"edit --ref 가 text 를 건드렸다: {e2}")
    raises(lambda: apply_update(base, "H-01", "edit"), "빈 edit 이 통과했다")
    raises(lambda: apply_update(base, "H-99", "unclaim"), "없는 id 가 통과했다")

    # ── ref 추출 ───────────────────────────────────────────────────────────
    R = "jayleekr/hypeproof-studio"
    check(refs_in("[#898](https://github.com/jayleekr/hypeproof-studio/issues/898#issuecomment-563)", R)
          == [(R, 898)], f"앵커가 붙은 링크에서 중복·오탐이 났다: {refs_in('[#898](https://github.com/jayleekr/hypeproof-studio/issues/898#issuecomment-563)', R)}")
    check(refs_in("jayleekr/vscodium#2", R) == [("jayleekr/vscodium", 2)], "크로스 레포 지목을 못 읽었다")
    check(refs_in("https://github.com/a/b/pull/9", R) == [("a/b", 9)], "PR URL 을 못 읽었다")
    check(refs_in("#1 과 #2", R) == [(R, 1), (R, 2)], "여러 지목을 못 읽었다")
    # 음성 대조군: ref 가 아닌 것을 지목으로 읽지 않는다.
    check(refs_in("없음", R) == [], "산문에서 지목을 만들어냈다")
    check(refs_in("#abc", R) == [], "`#abc` 를 번호로 읽었다")

    # ── 존재 확인 (상태 코드를 주입해서) ──────────────────────────────────
    check(verify_refs("#1 과 #2", R, status=lambda r, n: 200 if n == 1 else 404) == ([f"{R}#2"], []),
          "404 를 '없다' 로 잡지 못했다")
    check(verify_refs("#1", R, status=lambda r, n: 200) == ([], []), "200 을 없다고 했다")
    check(verify_refs("산문만", R, status=lambda r, n: 404) == ([], []),
          "지목이 없는 ref 에서 실패를 만들어냈다")
    # **실제로 당한 오판**: 403(요청 제한)을 "없다" 로 읽어 실재하는 #898 을 거부했다.
    # 403·5xx·응답 없음은 판정 불가이고 **작업을 막지 않는다**.
    for code in (403, 500, 502, None):
        miss, unk = verify_refs("#898", R, status=lambda r, n, c=code: c)
        check(miss == [], f"HTTP {code} 를 '없다' 로 읽었다 — 멀쩡한 지목이 거부된다")
        check(len(unk) == 1, f"HTTP {code} 가 판정 불가로 보고되지 않았다")
    # 양성 대조군: 404 는 여전히 막는다(전부 통과시키는 고장이 아니다).
    check(verify_refs("#99999", R, status=lambda r, n: 404)[0] == [f"{R}#99999"],
          "404 를 판정 불가로 흘려보냈다")
    # 상태 줄 파싱 (gh api -i 의 첫 줄)
    check(STATUS_LINE_RE.match("HTTP/2.0 403 Forbidden").group(1) == "403", "상태 줄 파싱이 틀렸다")
    check(STATUS_LINE_RE.match("HTTP/1.1 200 OK").group(1) == "200", "HTTP/1.1 상태 줄을 못 읽었다")
    check(STATUS_LINE_RE.match("gh: something went wrong") is None, "에러 문장을 상태 줄로 읽었다")

    # ── splice 는 블록 **밖**을 한 바이트도 바꾸지 않는다 ────────────────────
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
    p.add_argument("--no-verify", action="store_true",
                   help="--ref 가 실제로 존재하는지 확인하지 않는다 (네트워크 없는 환경용)")
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list", help="미완 항목 (자기 것만 보려면 --owner)")
    pl.add_argument("--owner", choices=OWNERS)
    pl.add_argument("--all", action="store_true", help="완료까지 보기")
    pl.add_argument("--json", action="store_true")

    pa = sub.add_parser("add", help="항목 추가")
    pa.add_argument("--owner", choices=OWNERS, required=True, help="일의 종류 (사람 이름이 아니다)")
    pa.add_argument("--text", required=True)
    pa.add_argument("--ref", default="")

    pd = sub.add_parser("done", help="완료 표시")
    pd.add_argument("id")
    pd.add_argument("--by", default="", help="누가 끝냈나 (자유 문자열)")

    pc = sub.add_parser("claim", help="진행중 표시 — 지금 누가 들고 있나")
    pc.add_argument("id")
    pc.add_argument("--by", required=True, help="자유 문자열. 날짜가 자동으로 붙는다")

    pu = sub.add_parser("unclaim", help="들고 있던 것을 놓는다 (claim 취소)")
    pu.add_argument("id")

    pe = sub.add_parser("edit", help="내용만 고친다 — done·owner 는 건드리지 않는다")
    pe.add_argument("id")
    pe.add_argument("--text")
    pe.add_argument("--ref")

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

    try:
        new_ref = getattr(a, "ref", None)
        if new_ref and not a.no_verify:
            missing, unknown = verify_refs(new_ref, a.repo)
            if missing:
                sys.exit(
                    f"거부: 존재하지 않는 지목 — {', '.join(missing)}\n"
                    "  받는 쪽은 그 번호를 열어 보고서야 알게 된다. 번호를 확인하거나 "
                    "`--no-verify` 로 건너뛴다."
                )
            if unknown:
                # 막지 않는다. 확인에 실패한 것은 ref 의 문제가 아니다.
                print(f"경고: 지목을 확인하지 못했다 — {', '.join(unknown)} (그대로 진행한다)",
                      file=sys.stderr)

        if a.cmd == "add":
            items, touched = apply_add(items, a.owner, a.text, a.ref)
            label = "추가: "
        else:
            items, touched = apply_update(
                items, a.id, a.cmd,
                by=getattr(a, "by", "") or "",
                text=getattr(a, "text", None),
                ref=getattr(a, "ref", None),
                day=today(),
            )
            label = {"done": "완료: ", "claim": "진행중: ", "unclaim": "놓음: ", "edit": "수정: "}[a.cmd]
        print(label + touched.render())
        save(a.repo, a.issue, body, digest, items, a.dry_run)
    except Rejected as exc:
        sys.exit(str(exc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
