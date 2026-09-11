# handoff — 에이전트 인계 큐

> "너한테 온 일" 을 한 군데 모아 둔다. 저장소는 [#896](https://github.com/jayleekr/hypeproof-studio/issues/896) 본문의 구분된 블록.

## 왜 있나

Claude 세션끼리는 서로 직접 메시지를 보낼 수 있다. Codex 는 별도 도구라 그 경로가 없고, GitHub 에서도 **양쪽이 같은 계정으로 글을 쓴다** — 그래서 assign·mention·review 요청으로 한쪽을 지목할 수 없다. 결과적으로 사람이 "저 댓글 봐" 를 대신 해주고 있었다.

이 도구는 **그 사람 역할을 없애지 못한다.** 남의 도구를 실행시킬 수는 없다. 없애는 것은 **찾는 비용**이다. 이슈 일곱 개를 읽는 대신:

```bash
python3 scripts/handoff/handoff.py list --owner codex
```

각 세션이 턴 시작에 이 한 줄을 돌리기로 하면 사람이 빠진다. 그 습관은 각 세션이 정할 일이다.

## 쓰기

```bash
# 내 앞으로 온 미완 항목
python3 scripts/handoff/handoff.py list --owner codex
python3 scripts/handoff/handoff.py list --owner codex --json   # 기계가 읽을 때

# 넘기기
python3 scripts/handoff/handoff.py add --owner codex \
  --text "패치된 빌드로 네 번째 관문 측정" --ref "[#898](url)"

# 진행중 / 완료
python3 scripts/handoff/handoff.py claim H-01 --by codex
python3 scripts/handoff/handoff.py done  H-01

# 쓰지 않고 결과만 보기
python3 scripts/handoff/handoff.py --dry-run add --owner claude --text "…"

# 네트워크 없이 파싱·splice 검증
python3 scripts/handoff/handoff.py selftest
```

`--repo` / `--issue` 로 다른 이슈를 쓸 수 있다(기본값 `jayleekr/hypeproof-studio` #896).

## 규칙

- **넘기는 쪽이 항목을 만들고, 받는 쪽이 끝내면 체크한다.**
- 여기엔 **한 줄만** 둔다. 상세는 `--ref` 가 가리키는 이슈 댓글에 있다. 큐가 토론 장소가 되면 다시 일곱 개를 읽는 상태로 돌아간다.
- `human` owner 는 **결정 대기**를 뜻한다 — 에이전트가 스스로 정하면 안 되는 것(공급자 선택, 보안 범위 판단 등).
- 블록은 도구가 관리한다. **손으로 고치지 않는다.**

## 설계에서 조심한 것

**저장소 선택.** 댓글은 추가만 되고 상태가 없어서 "끝났음" 을 마지막 상태 추론으로 읽어야 한다 — 파싱이 불안정하다. 레포 파일은 갱신마다 커밋 + PR 이 필요해 하루에 여러 번 바뀌는 큐에는 과하다. 이슈 본문은 한 군데이고 상태가 있고 `gh issue view --json body` 로 기계가 읽으며 커밋이 필요 없다.

**사람 글을 지키는 것.** #896 에는 사람이 쓴 Intent 설명이 6천 자 있다. `splice()` 는 구분자 **사이만** 교체하고, 구분자가 없으면 **끝에 덧붙인다** — 어떤 경로로도 기존 본문을 덮어쓰지 않는다. `selftest` 가 이걸 단언한다(멱등성 + 블록 밖 보존).

**동시 쓰기.** 이 레포에는 세션이 여러 개 동시에 돈다. 쓰기 직전에 본문을 다시 읽어 내가 읽었던 해시와 다르면 **거부한다.** 덮어쓰면 남의 항목이 조용히 사라진다. 거부되면 그냥 다시 실행하면 된다 — 최신 상태에서 다시 시작한다.

**selftest 가 실제로 버그를 잡았다.** 처음 왕복 단언을 리스트 동일성으로 썼는데 `render_block` 이 미완/완료로 재정렬해서 실패했다. 재정렬은 의도한 동작이므로 단언이 틀린 것이었고, **무엇이 보존되어야 하는지**(항목 집합과 각 필드, 그리고 미완이 완료보다 앞)로 고쳤다. 약하게 바꾸는 대신 정확하게 적었다.

음성 대조군도 있다: 체크리스트처럼 보이지만 형식이 아닌 줄(`- [ ] 그냥 할 일`)은 항목으로 읽지 않는다. 그게 없으면 사람이 본문에 적은 아무 체크박스가 큐 항목이 된다.

## 한계 — 숨기지 않는다

- **Codex 가 이 명령을 돌린다는 보장이 없다.** 그쪽이 습관을 들여야 한다.
- 큐는 **알림을 보내지 않는다.** 보려면 봐야 한다. Claude 쪽은 #896 댓글 모니터가 있어서 상태 변화를 감지하지만, 본문 변경은 댓글이 아니라 감지되지 않는다.
- 감사 기록이 없다. 누가 언제 체크했는지는 이슈의 edit history 에만 남는다.
