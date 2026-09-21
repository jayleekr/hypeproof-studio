# GIT_POLICY: 야간 세션의 브랜치와 PR

> 작성일 2026-09-18 · 상태: 활성 · 저장소 정책(`CLAUDE.md`, `DEV-GUIDE.md`, `.claude/skills/hype-pr/SKILL.md`, `docs/AGENT-GUIDE.ko.md`)이 이긴다

## 어디서 일하는가

- 시작 시 메인 체크아웃이 `main`이 아니거나 더러우면 손대지 않는다. 상태를 `STATE.md`에 적는다.
- `origin/main`에서 worktree를 만든다: `git fetch origin` → `git worktree add .claude/worktrees/ux-p0 -b feat/sx-p0-curriculum-first origin/main`. P1·P2도 같은 방식으로 각각 `feat/sx-p1-evidence-capture`, `feat/sx-p2-boundary-reflection`. P1은 P0 브랜치에서 갈라도 된다(P0 PR이 머지되지 않았으므로). 그 사실을 PR 본문에 적는다.
- 준비 문서(이 디렉터리와 `docs/**` 신규 파일)는 메인 체크아웃에 untracked 상태로 있다. **첫 커밋은 이 문서들을 `feat/sx-p0-curriculum-first`에 그대로 옮겨 커밋하는 것이다.** `git add`로 정확한 경로만 담는다. `git add -A`는 쓰지 않는다.

## 흐름

1. 이슈: 단계마다 GitHub 이슈 1개(`gh issue create --body-file`). 제목 `[SX] P0 Curriculum-first`처럼. 본문에 SX ID 범위와 DAG task.
2. 커밋: task마다 1개 이상. 형식 아래.
3. 게이트가 초록이면 push: `git push -u origin <branch>`.
4. PR: `hype-pr` 절차. `python3 scripts/hype-pr/pr.py inspect` → assessment 작성 → `prepare` → `create --preparation <receipt> --apply`. `gh pr create` 직접 호출로 우회하지 않는다. 본문 파일에 `Closes #<issue>`, 다룬 SX, 실행한 SX-T와 결과, NOT RUN, 실기 증거 경로.
5. **머지하지 않는다.** 리뷰어 요청은 `pr.py request-reviewers`.

## 커밋 형식

```
feat(sx): <무엇을 만들었는가, SX ID>

<왜, 어느 게이트가 뒷받침하는가, NOT RUN>

Co-Authored-By: Claude Opus <noreply@anthropic.com>
```

## 절대 금지

| 하지 않음 | 이유 |
|---|---|
| `main` push, force push, `git reset --hard`, `git clean -fd` | 저장소 정책. 설정으로 막혀 있다 |
| `vscodium-base/vscode/**` 직접 편집 | 업스트림. 패치로만 |
| 시크릿·토큰을 추적 파일에 | `.env`만 |
| `bash build.sh` | 1~2시간, 10~20GB |
| 다른 저장소(Lab, harness) 변경 | 범위 밖 |
