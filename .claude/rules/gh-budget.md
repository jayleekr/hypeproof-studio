# GitHub API 예산 — 막히는 건 추론이 아니라 리밋이다

`gh` 를 쓰는 작업, 특히 PR 을 내거나 여러 PR을 훑기 전에 읽는다.
`MASTER_PROMPT.md` §6 이 일화로 적어 둔 것을 규칙으로 옮긴 파일이다.

## 왜 있나

2026-09-21 한 세션에서 **2차 레이트 리밋에 세 번 막혔다.** 잃은 시간은 전부 판단 착오가
아니라 대기였다. 그 앞 세션에서는 적대적 검토 에이전트 **26개**가 시간당 5000 을 태워
PR 생성이 **한 시간** 막혔다.

비용은 사람이 짐작하는 것보다 훨씬 위쪽에 있다. `hype-pr inspect` **한 번**이 Lab
저장소 트리까지 훑는다 — PR 하나를 내는 데 inspect + prepare + create 로 최소 세 번이다.

## 규칙

### 1. `gh` 를 쓰는 에이전트는 한 번에 하나

서브에이전트를 몇 개로 쪼갤지는 `AUTONOMY_POLICY.md` §묻지 않고 정하는 것이 "한도
안에서" 자유라고 적어 둔다. **이 파일이 그 한도다.**

- 병렬 서브에이전트 자체는 제한 없다. 읽기·grep·테스트는 마음껏 쪼갠다
- **`gh` 나 GitHub API 를 부르는 에이전트는 동시에 하나만** 둔다
- 검토·감사 fan-out 을 돌릴 때는 프롬프트에 **`gh` 사용 금지**를 명시한다.
  `git show <tag>:<path>` 는 로컬이라 얼마든지 써도 된다
- `pr.py inspect` / `prepare` 를 두 브랜치에 대해 동시에 돌리지 않는다

### 2. `gh api rate_limit` 은 2차 리밋을 못 본다

이게 이 파일에서 제일 값나가는 한 줄이다.

```
$ gh api rate_limit --jq '.resources.core'
{"limit":5000,"remaining":5000,"used":0}      # ← 막혀 있는 동안에도 이렇게 나온다
```

`rate_limit` 엔드포인트는 2차 리밋에 **면제**라 초록을 그대로 보여 준다. 실제로 뚫리는지
보려면 **진짜 읽기를 찔러 본다**:

```bash
gh api repos/jayleekr/hypeproof-studio/contents --jq 'length'
```

### 3. `HTTP unknown` 을 토큰 문제로 읽지 않는다

`hype-pr` 이 `GET repos/…: HTTP unknown` 으로 죽으면 토큰 만료를 먼저 의심하게 되는데,
2026-09-21 에는 **세 번 다 2차 리밋**이었다. 다음 시도에서 같은 호출이 `HTTP 403` 으로
바뀌어서야 알았다. 순서는 이렇다:

1. §2 의 `contents` 찌르기 — 막혀 있나
2. 막혀 있으면 기다린다 (§4)
3. 뚫리는데도 죽으면 그때 토큰을 본다 (`GH_TOKEN="$(gh auth token)"` 없이는 정말로 죽는다)

### 4. 기다리되, 한 시간을 기다리지 않는다

2차 리밋은 1차 리셋(다음 정시)과 **무관하게 훨씬 빨리 풀린다.** 실측: 07:06 에 막혀
**07:17 에 풀렸다** — 11분. `reset` 타임스탬프를 보고 한 시간을 자면 49분을 버린다.

루프로 재시도하지 말고 **조건을 감시**한다:

```bash
until gh api repos/jayleekr/hypeproof-studio/contents --jq 'length' >/dev/null 2>&1; do
  sleep 120
done
```

### 5. 검토 직후에 PR 을 내지 않는다

적대적 검토는 리밋을 태운다. 검토 → PR 순서로 붙여 놓으면 검토가 성공한 대가로 PR 이
막힌다. 검토 프롬프트에서 `gh` 를 금지하거나, 순서를 바꾸거나, 사이를 띄운다.

## `hype-pr` 함정 — 리밋과 같이 온다

- **`prepare` 의 fingerprint 는 같은 head 에서도 움직인다.** 한 세션에서
  `7b54de1f` → `b25b6892` 로 바뀌어 `assessment is stale` 이 났고 **재실행하니 통과**했다.
  보고서에 GitHub 에서 읽는 값이 들어 있다. inspect·채움·prepare 를 한 프로세스에 붙이는
  것만으로는 부족하고 **재시도를 넣어야 한다**
- **`gh pr edit --body-file` 은 `<!-- hype-pr-prepared:v1 -->` 각주를 조용히 지운다.**
  본문을 고쳤으면 각주를 다시 붙인다. 내용은 receipt 의 `report` 에서 그대로 만들 수 있다
  (`scripts/hype-pr/preparation.py` 의 `summary()` 와 같은 형식)
- **prepare 뒤에 커밋을 push 하면 각주가 낡는다.** attestation 이 가리키는 head 와 실제
  head 가 달라진다. **prepare 를 마지막에 한다**
