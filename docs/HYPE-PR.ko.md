# hype-pr

> 작성일 2026-09-08 · 상태: 활성

> 이 문서는 `hypeproof-harness:docs/HYPE-PR.ko.md`가 원천이다.
> 제품 repo에 vendoring된 사본은 직접 고치지 말고 harness에서 PR로 바꾼다.

---

## 목적

`hype-pr`는 PR 생성 시 팀 운영 규칙을 사람 기억에 맡기지 않기 위한 하네스다.

- PR 작성자를 제외한 active 멤버 전원을 reviewer로 요청한다.
- auto-merge는 켜도 되는 PR인지 먼저 판정한다.
- 보안, 배포, 데이터, dependency, governance 변경은 auto-merge 대상에서 제외한다.
- 실제 merge는 여전히 branch protection, CODEOWNERS, required checks가 통과해야 한다.

즉, auto-merge는 "리뷰 없이 merge"가 아니라 "필수 보호 조건이 모두 통과하면 GitHub가
순서대로 merge하게 예약"하는 기능이다.

---

## Agent가 PR을 만드는 흐름

Harness, Lab, Studio의 PR 생성은 `skills/hype-pr/SKILL.md` 정본을 따른다. consumer에서는
`.claude/skills/hype-pr/SKILL.md`로 배포되고 `.agents/skills/hype-pr/`도 같은 내용을 가리킨다.
개발 시작에 기준 연결을 잡고, commit 후 `inspect`로 대상·상위·하위와 미등록 변경을 읽는다.
Agent가 실제 문서를 읽고 assessment를 작성하며, 별도 모델 API key는 필요 없다.
`prepare`는 repo/base/head/다른 정본 repo SHA/정책·도구 version에 묶인 receipt를 git metadata에
저장한다. `create --apply`는 이 receipt를 재검사하고 remote head까지 일치해야 생성한다.
새 owner/상위 단계 누락은 막고 기존 debt는 별도로 표시한다. 미등록 구현은 REQ와 test에 연결하며,
새 기준 문서를 supporting/edit-only로 위장하지 않는다. semantic 판단과 test evidence는 Agent의
attestation이다. 이 과정을 독립 human approval 또는 URL/테스트 결과 자체의 자동 검증이라고 부르지 않는다.

```bash
python3 scripts/hype-pr/pr.py inspect --repo jayleekr/hypeprooflab \
  --output /tmp/impact.json --assessment-template /tmp/assessment.json
# Skill 지침에 따라 assessment를 작성한다. 원문/상세 reasoning은 public PR에 복사하지 않는다.
python3 scripts/hype-pr/pr.py prepare --repo jayleekr/hypeprooflab --assessment /tmp/assessment.json
# 출력된 receipt path를 아래 create --preparation 에 전달한다.
```

### `path_links`는 레지스트리를 닫지 않는다

`inspect`의 `unmapped`에 뜬 파일을 assessment의 `path_links`로 연결하면 그 PR은 통과한다.
그 연결은 **그 PR 한 건의 판단 기록**이고 `config/traceability.json`에는 들어가지 않는다.
그래서 **다음에 같은 파일을 고치는 PR에서 또 `unmapped`로 뜬다** — 더 나쁜 경우, 그 파일만
건드리는 변경은 "영향 노드 없음"으로 조용히 지나간다.

영향 계산에 파일을 **영구히** 넣으려면 `config/traceability.json`에 노드를 추가해 그 파일을
`sources`로 들게 한다(기존 요구·시험 노드에 붙이고, owner나 상위 단계를 발명하지 않는다).
실제로 구별해 보려면 레지스트리에서 그 경로가 몇 번 나오는지 세어 본다 — `path_links`만
썼다면 **0회**다.

발견 경위: 2026-09-11, `worker/src/routes/messages.ts`가 어느 노드의 `sources`도 아니어서
그 라우트의 분기 안에 살던 오디오 거절 구멍(REQ-R3 ⑥)이 영향 계산에 보이지 않았다. 같은 날
레포 전체 사각지대를 쓸어 미매핑 92개 파일이 확인됐고, 그중 34개는 **요구 문서가 본문에서
직접 이름을 부르는** 파일이다(#996). 범위 결정은 그 이슈에 있다. 레지스트리 자신이
`coverage: "Bootstrap scope only…"`라고 적어 두었으므로 숫자 자체는 계약 위반이 아니다 —
문제는 그 사실이 `inspect` 결과에서 보이지 않는다는 것이다.

consumer 명령은 sibling Harness checkout 또는 `HYPEPROOF_HARNESS`로 정본 명령에 위임한다.
Harness가 없으면 명시적으로 실패한다. 정책·엔진 복제나 fallback owner 명단은 없다.
원격 기준 commit이 로컬에 없으면 `git fetch origin main` 후 다시 실행한다. source를 읽을 권한이
없으면 권한을 복구한다. 코드 변경/새 commit/base·다른 repo의 전진은 다시 검토할 이유다.
`create`의 `--path`는 dry-run 참고용이며 실제 생성의 위험 판정은 git diff로 계산한다.

## 기본 사용법

먼저 dry-run으로 reviewer와 auto-merge eligibility를 확인한다.

```bash
python3 scripts/hype-pr/pr.py plan \
  --repo jayleekr/hypeproof-studio \
  --author JinyongShin \
  --path docs/dev/cohort.md \
  --auto-merge
```

기존 PR에 reviewer를 다시 요청한다.

```bash
python3 scripts/hype-pr/pr.py request-reviewers \
  --repo jayleekr/sediment \
  --pr 87

# 실제 GitHub mutation
python3 scripts/hype-pr/pr.py request-reviewers \
  --repo jayleekr/sediment \
  --pr 87 \
  --apply
```

새 PR을 만들 때도 기본은 dry-run이다.

```bash
python3 scripts/hype-pr/pr.py create \
  --repo jayleekr/hypeproof-harness \
  --head feat/hype-pr-workflow-harness \
  --title "Add hype-pr workflow harness" \
  --body-file /tmp/pr-body.md \
  --author jayleekr \
  --path scripts/hype-pr/pr.py \
  --path docs/HYPE-PR.ko.md
```

`--preparation <prepare 출력 경로> --apply`를 붙이면 검토를 재확인한 뒤 `gh pr create`를 실행한다. `--auto-merge`를 같이 붙였고
eligibility가 통과하면 생성 직후 `gh pr merge --auto --squash --delete-branch`도
실행한다.

reviewer 요청은 PR 생성 후 1명씩 시도한다. 특정 repo에서 아직 write 권한이 없거나
초대를 수락하지 않은 멤버가 있으면 PR 생성 자체를 막지 않고, 해당 reviewer 요청
실패를 JSON 결과에 남긴다.

---

## Auto-Merge 판정

auto-merge는 다음 조건을 모두 만족해야 eligible이다.

- CLI에서 `--auto-merge`를 명시했다.
- PR이 draft가 아니다.
- repo profile의 `repository.allow_auto_merge`가 true다.
- repo inventory에 required status checks가 선언돼 있다.
- 변경 파일에서 high-risk category가 감지되지 않았다.
- PR label에 `human-needed`, `security`, `deploy`, `data`, `incident`,
  `breaking-change`, `do-not-merge`가 없다.

현재 active development profile은 auto-merge를 허용한다.

| Profile | GitHub auto-merge setting | 이유 |
|---|---:|---|
| `harness-core` | true | required review/check가 가장 엄격하므로 조건 통과 후 예약 merge 허용 |
| `public-product` | true | public code/private authority 모델에서 보호 조건 통과 후 예약 merge 허용 |
| `private-product` | true | private 예외 repo도 branch protection 통과 후 예약 merge 허용 |
| `content-vault` | false | vault/secret 성격 변경은 수동 merge 유지 |
| `release-artifact` | false | release repo는 source workflow가 artifact를 발행하고 사람 개발 PR은 예외 |

high-risk path는 auto-merge를 막는다.

| Risk | 예시 |
|---|---|
| `security` | `auth`, `admin`, `oauth`, `secret`, `token`, `credential`, `SECURITY.md` |
| `deploy` | `.github/workflows/`, `vercel`, `fly.toml`, `wrangler`, `deploy`, `release` |
| `data` | `migration`, `schema`, `tenant`, `rls`, `database`, `.sql` |
| `dependency` | lockfile, `pyproject.toml`, requirements, `Cargo.lock` |
| `governance` | `policy/`, `CODEOWNERS`, branch protection, repo-governance |

docs/UI 변경은 high-risk가 아니지만, reviewer가 `human-needed`를 붙이면 auto-merge가
막힌다.

---

## 릴리즈 노트 규약

배포 알림은 커밋마다 영어로 흩뿌리지 않고, **매일 06:00(KST) 한글 다이제스트**
하나로 모아 Discord에 올리고 `/members/releases`에 전체 changelog로 쌓는다
(hypeprooflab `web/scripts/gen-releases.mjs` + `releases-refresh.yml`). 그 다이제스트의
품질은 **PR 제목**에서 나온다. 그래서 PR 제목은 규약을 지킨다.

**제목 형식** — `type(scope): 한글 요약`

- `type`은 conventional-commit 타입. 다이제스트가 이걸로 카테고리를 나눈다.
- `scope`는 선택(예: `members`, `auth`, `cron`). 다이제스트에 함께 표시된다.
- 요약은 **한글로, 배포 대상이 읽고 뭐가 바뀌었는지 알 수 있게** 한 줄.
- breaking change는 `type(scope)!:` 처럼 `!`를 붙인다 → 다이제스트에 💥 표시.

| type | 다이제스트 카테고리 |
|---|---|
| `feat` | ✨ 새 기능 |
| `fix` | 🐛 버그 수정 |
| `perf` | ⚡ 성능 개선 |
| `refactor` | ♻️ 구조 개선 |
| `docs` | 📝 문서 |
| `test` | ✅ 테스트 |
| `build`·`ci`·`chore`·`style` | 🔧 빌드/기타 |

**선택 트레일러** — 제목만으로 요약이 부족하거나 영어 병기가 필요하면 PR 본문에 넣는다.

```
릴리즈노트: 회의록 페이지에서 깨진 캘린더 링크 제거
릴리즈노트(en): remove broken calendar links from the meeting-notes page
```

- `릴리즈노트:`가 있으면 다이제스트는 제목 요약 대신 이 한 줄을 쓴다.
- `릴리즈노트(en):`는 `/members/releases`에 영어 보조 줄로 표시된다.

**다이제스트에서 빠지는 것** — dependabot 등 봇 PR, `(auto)`로 끝나는 자동 생성 커밋
(예: `content: daily research 2026-07-21 (auto)`)은 노이즈라 자동 제외된다. 실제로
사람이 배포한 변경만 남는다.

---

## PR 작성자 기준

PR 작성자는 다음을 기억한다.

1. PR 생성 Skill의 inspect/assessment/prepare를 거친다. plan만으로 생성 검토를 대체하지 않는다.
2. high-risk 변경이면 `--auto-merge`를 붙이지 않는다.
3. low-risk 반복 작업이면 `--auto-merge`를 붙일 수 있다.
4. reviewer는 모두 요청하되, 모든 사람의 승인을 기다리는 정책은 아니다.
5. merge는 branch protection quorum과 required checks가 결정한다.
6. 제목은 `type(scope): 한글 요약` 규약을 지킨다(위 "릴리즈 노트 규약"). 이게
   매일 나가는 배포 다이제스트의 한 줄이 된다.

`hype-review`는 리뷰어가 자기 lens로 질문하게 만드는 도구이고, `hype-pr`는 작성자가
PR을 만들 때 팀 운영 정책을 자동으로 적용하게 만드는 도구다.
