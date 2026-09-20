# STATE: 학습 경험 우선 Studio 야간 개발 원장

> 살아 있는 원장. 단계·게이트가 바뀔 때마다 갱신한다. 재개할 때 이것을 먼저 읽는다.
> 마스터 프롬프트 `MASTER_PROMPT.md` · 루브릭 `../../evals/STUDIO_UX_EVAL.md` · DAG `docs/plan/ux-dag.yaml`

## RESUME HERE

**2026-09-20 — P0 완료(평가 1회·수정 1회), P1 은 네 task 중 **하나**만. 둘 다 머지 안 함.**
- `feat/sx-p0-curriculum-first` → **PR #1170**, CI 20개 전부 초록.
- `feat/sx-p1-evidence-capture` (P0 브랜치 위에 쌓임) → **PR #1176, P1-A 하나만.**
- `feat/sx-p1b-evidence-drawer` (#1176 위에 쌓임) → **P1-B.** P1-C·D 미착수.
  머지 순서는 **#1170 → #1176 → P1-B** 다. 각 PR 의 diff 는 바로 아래 브랜치 기준이다.
  #1176 은 #1170 을 머지한 뒤에 본다. 그 전에는 diff 에 P0 커밋이 섞여 보인다.
  **#1172(P1 전체)를 닫지 않는다** — 네 task 중 하나만 담았으므로 `Closes` 줄을 비웠다.
machine_gate 는 전부 초록이고 orchestrator 와 평가자가 **각각 따로** 다시 돌렸다.
다음은 아래 순서로 읽으면 된다: **단계별 게이트** → **평가** → **사람에게 묻는 것** →
**요구 개정 제안** → **다음 세션이 집을 첫 task**.

네 가지를 먼저 알아 두는 편이 좋다.

0. **평가 점수는 FAIL 75/100 이지만 CRITICAL 은 0 이고 거짓 초록은 없다.**
   감점의 큰 덩어리는 루브릭이 P0 에 적용될 수 없는 부분이다(E 는 P1 이 만들 drawer 를
   보고, C 는 만들 수 없는 스크린샷을 본다). 평가자가 그것을 구현자 점수에 조용히
   얹지 않고 `spec` 으로 분리했다. 실제 결함 셋은 고쳤다.

1. **실기 증거는 없다.** 만든 것은 전부 synthetic(단위 테스트·심은 시료·대조군)이다.
   앱을 빌드하지도 띄우지도 않았다. SX-T60(Jay dogfood 인수)과 5초 회상 테스트는
   NOT RUN 이고 이 세션의 어떤 초록도 그것을 대신하지 않는다.
2. **SX-T 행은 하나도 PASS 로 옮기지 않았다.** 대부분이 단위 절반만 덮였고
   Electron e2e·사람 원문 검토 절반이 남았다. 부분 PASS 를 전체 PASS 로 적지 않는다.
3. **요구 개정 제안 1번(`steps[].evidence` 이름 충돌)은 결정이 필요하다.**
   커리큘럼 위키가 상위 정본이고, 지금 이름으로 두면 나중에 진짜 증거물 칸을
   열 자리가 막힌다.

**2026-09-18 준비 완료.** Lab 세션(Fable 5.1, worktree-codex)이 Jay의 UI/UX 설계 철학(docx)을 요구사항화해 두었다. 첫 task는 `ux-dag.yaml`의 `P0-A`(세션 설계 파일 스키마와 3주차 예시).

준비된 문서:

| 층 | 파일 | 상태 |
|---|---|---|
| 원문 | `docs/design/ui-philosophy-2026-09-18.md` (+ `assets/ux-2026-09-18/`) | 보존본, 고치지 않음 |
| 분류 | `docs/design/ux-principles-breakdown-2026-09-18.md` | SX-01~60 제목·층·출처 고정 |
| intent | `docs/intents/studio-learning-experience.md` | INT-SX-00~10 |
| requirement | `docs/requirements/studio-learning-experience.md` | SX-01~60 수용 기준 |
| design | `docs/design/studio-learning-experience.md` | 정보 구조·상태 기계·세션 설계 파일·이벤트·토큰·코드 변경 지도 |
| test | `docs/testing/studio-learning-experience.md` | SX-T01~T60, 전부 NOT RUN |
| plan | `docs/plan/studio-learning-experience.md`, `docs/plan/ux-dag.yaml` | P0~P5, task와 게이트 |
| registry | `config/traceability.json` ST-INT-SX / ST-REQ-SX / ST-DES-SX / ST-TEST-SX | **적용 완료 2026-09-20.** main 기준 126 노드 위에 4개 추가 → 130. 삽입만 있고 기존 노드 diff 0 |
| index | `docs/dev/04-requirements.md`, `docs/studio-requirements.md` | **적용 완료 2026-09-20.** `REQ-STUDIO-LEARNING-EXPERIENCE` 행과 절 추가 |
| handoff | `.claude/hypeproof/ux/HANDOFF-apply.md` | 메인 체크아웃이 오래되어(origin/main 09-15 이후 미fetch) 준비 문서는 untracked 상태. 복사 목록과 적용 절차 |

## 준비 세션이 검증한 것 (2026-09-18)

| 확인 | 결과 |
|---|---|
| 요구 문서 커버리지 | SX-01~60 전부 한 번씩, 중복·누락 0 |
| 검증 문서 커버리지 | SX-T 53행이 SX-01~60 전부를 덮음, 전부 NOT RUN |
| 설계 문서 기반 | worktree `claude-1042`의 아홉 파일이 blob 해시로 `origin/main`과 동일 확인. 메인 체크아웃은 다섯 개가 다름 |
| DAG | 15 task, `depends_on` 전부 해소, YAML 파싱 통과 |
| **정정** | "강사 역할이 없다(admin/creator/spectator)"는 **틀렸다.** Studio에는 `role: "issuer"` + `IssuerScope`(`tokens.ts`, `instructor-auth.ts`)와 Chalk 강사 화면 5종이 이미 있다. admin/creator/spectator는 Lab 멤버 DB의 역할이었다. 요구·설계·검증·계획·분류표 다섯 곳을 고쳤다. P4가 기다리는 것은 역할이 아니라 학습 근거의 issuer 범위 조회 경로와 학생 공유 범위 선택(MC-39)이다 |
| **정정** | P0-A는 새 파일 포맷이 아니라 기존 `hps-session-design/1`(`worker/src/lib/session-design.ts`)의 선택 키 확장이다. 스키마 id를 올리지 않는다 |
| **함정** | `extensions/hypeproof-chat/test/asset-status.smoke.mjs`가 `"7자산 0/7"` 문자열의 존재를 단언한다. P0-E가 소스만 지우면 테스트가 빨개진다. 같은 커밋에서 이 테스트도 제거하거나 뒤집는다 |
| **함정** | 로컬 체크아웃의 `config/traceability.json`은 노드 79개, main은 126개다. SX 노드의 부모 셋(`ST-INT-MEASUREMENT-CORE`, `ST-REQ-MEASUREMENT-CORE`, `ST-REQ-LEARNING-AGENT-EXPERIENCE`)이 로컬에 없다. 반드시 main 기준 파일에 넣는다 |

## 시작 상태 (2026-09-20 실행 세션이 기록)

- worktree: `.claude/worktrees/claude-epic`. 세션이 이 worktree에 격리돼 있어 `ux-p0`를 새로 만들지 않고 여기서 일한다. 시작 시점에 detached HEAD = `ce95747` = `origin/main`이고 작업 트리가 **깨끗했다**. `GIT_POLICY.md`가 요구하는 "origin/main에서 뜬 깨끗한 트리"라는 조건은 충족한다.
- 브랜치: `git switch -c feat/sx-p0-curriculum-first` (from `ce95747`). `git fetch origin` 후에도 `origin/main`은 `ce95747`로 동일.
- 메인 체크아웃(`~/CodeWorkspace/hypeproof-studio`)은 여전히 `chore/work-ready-20260913`(`b70a548`)이며 **건드리지 않았다.** 준비 문서만 읽어서 복사했다.
- `git status` 시작 시점: clean.
- 준비 문서 이관: `HANDOFF-apply.md` §1 목록 그대로 `cp -R` 후 경로별 `git add`. `git add -A` 미사용(#318 symlink 유출 방지).
- `HANDOFF-apply.md` §5 확인: 설계·검증 문서가 이름 붙인 파일 **46개 전부 존재**(missing=0). 문서 정정 불필요.

기존 테스트 (2026-09-20 기준선, 구현 전):

| 대상 | 명령 | 결과 |
|---|---|---|
| 확장 | `cd extensions/hypeproof-chat && npm test` | **PASS** (exit 0) |
| 워커 | `cd worker && npm test` | 1차 **FAIL** → 원인 제거 후 **PASS** (아래) |
| 워커 | `cd worker && npx tsc --noEmit` | **PASS** (exit 0) |
| Chalk | `cd chalk && npm ci && npm test && npm run typecheck` | **PASS** (exit 0, 0, 0) |
| 문서 | `python3 scripts/docs-harness/check.py --min-score 95` | **PASS** 100/100, findings 0 |
| PR | `python3 scripts/hype-pr/pr.py inspect` | 1차 **FAIL** → fresh harness 로 **PASS** (아래) |

**워커 첫 실패는 제품이 아니라 계측기였다 (harness_fixable).** `test:budget-recovery`가
`SyntaxError: Named export 'convertV4MiniflareOptions' not found`로 죽었다. 원인은 worktree의
`worker/node_modules`가 **메인 체크아웃(`chore/work-ready-20260913`)의 설치본을 가리키는 심볼릭 링크**라서
miniflare `5.20260730.0-alpha`가 깔려 있었던 것이다. 이 브랜치의 `package.json`·lockfile은
`5.20260911.1-alpha`를 요구한다(#1070). 심볼릭 링크를 지우고 worktree 자체에 `npm ci` 하니 전부 초록.
`chalk`도 같은 심볼릭 링크였고 같은 처리를 했다. **메인 체크아웃의 node_modules는 건드리지 않았다**
(링크를 통해 `npm ci`를 돌리면 메인 쪽 설치본을 덮어썼을 것이다). 추적 파일 변경 0, `node_modules`는 gitignore 대상.
규칙 6대로 계측기를 먼저 배제했고, 제품 결함으로 보고하지 않는다.

**`pr.py inspect` 도 계측기 문제였다 (harness_fixable).** 형제 체크아웃
`~/CodeWorkspace/hypeproof-harness` 에 `scripts/hype-pr/preparation.py` 가 없어서
"canonical Harness checkout is outdated" 로 죽었다(memory 2026-09-08 과 같은 함정).
scratchpad 에 harness main 을 새로 clone 하고 `HYPEPROOF_HARNESS` 를 그쪽으로 주니
**exit 0, blockers `[]`, existing_debt 0**. 메인 형제 체크아웃은 건드리지 않았다
(GIT_POLICY: 다른 저장소 변경 금지).

> **주의 — 스카우트 보고를 그대로 올리지 않았다.** 조사 서브에이전트 하나가
> "harness 정책 예외 두 건이 2026-09-15 에 만료돼 모든 subcommand 가 exit 4 다,
> 이건 Harness 저장소를 고쳐야 하는 사람 몫 blocker" 라고 보고했다. 직접 돌려 보니
> **재현되지 않았다.** 그 에이전트는 낡은 harness worktree
> (`hypeproof-harness-worktrees/watcher-main`)를 썼고, 현재 harness main 에는 그 만료가
> 없다. verification.md 규칙 5 — 남의 추출을 증거로 올리기 전에 먼저 의심한다.
> 이 한 번의 확인이 없었으면 Jay 앞에 존재하지 않는 blocker 가 놓였을 것이다.

`HYPEPROOF_HARNESS` 경로는 이 세션의 scratchpad 안이라 세션이 끝나면 사라진다.
다음 세션은 harness main 을 다시 clone 하거나 형제 체크아웃을 fast-forward 해야 한다.

## 단계별 게이트

machine_gate 는 **orchestrator 가 구현자와 별도로 다시 돌린 결과**다(루브릭 절차 1).
acceptance 열은 평가 서브에이전트의 판정이 들어온 뒤 채운다.

| 단계 | task | machine_gate | control | acceptance (루브릭 점수) | 판정 | 시도 |
|---|---|---|---|---|---|---|
| P0 | P0-A 세션 설계 파일 | **초록** tsc 0 · worker 0 · chalk 0/0 | **초록** 구현 전 트리에서 빨강, 전부 `invalid session-design fields` | 커밋 `b2517f9` + 수정 `115a746` | 1 |
| P0 | P0-B 토큰·디자인 시스템 | **초록** ext npm test 0 · tsc 0 · webview tsc 0 | **초록** 양성 8 · 음성 18 · 심은 정답 6 · 빈영역 가드 · 실제 화면 3종 | 커밋 `0607777` + 수정 `115a746` | 1 |
| P0 | P0-C 학생 홈·Mission header | **초록** ext npm test 0 · tsc 0 · webview tsc 0 | **초록** 실제 렌더 판정 + 음성 4종 | 커밋 `12c3ece` | 1 |
| P0 | P0-D Coach rail·코치 계약 | **초록** worker tsc 0 · worker npm test 0 · ext npm test 0 | **초록** 구현 전 4 passed / 12 failed(P0-A 적용본 기준), 누출을 실제 조립 프롬프트에서 측정 | 커밋 `a891a01` + `2a841e0` | 1 |
| P0 | P0-E assetStatusBar 제거 | **초록** ext npm test 0 · `! grep -rn '7자산' src webview-ui/src` 0건 | **초록** 부재 증명 + 음성 대조군 3건 | 커밋 `2afca8b` | 1 |
| P0 | **P0 평가** | — | — | **FAIL 75/100, CRITICAL 0.** 판정서 `judge-P0-2026-09-20.md`. 실제 결함 3건(D-1·D-2·D-3)은 `115a746` 에서 고쳤다. 나머지 감점은 대부분 `spec`(아래) | 1 |
| P0 | P0-PR | **초록** inspect exit 0, blockers [] | — | **PR #1170 열림, 머지 안 함** | 1 |
| P1 | P1-A 이벤트·필드 확장 | **초록** worker tsc 0 · worker npm test 0 · ext npm test 0 | **초록** 구현 전 1 passed / 20 failed — 통과한 하나가 `/1` golden 불변이다 | 브랜치 `feat/sx-p1-evidence-capture` 커밋 `7171d56` | 1 |
| P1 | P1-B Evidence drawer·기대 조건·완료 게이트 | **초록** ext tsc 0 · ext npm test 0 · webview vite build 0 | **초록** 심은 결함 18개 중 18개를 잡을 때까지 단언을 고쳤다 | 브랜치 `feat/sx-p1b-evidence-drawer` 커밋 `6d4b8d7` | 0 |
| P1 | P1-C 재확인 게이트·변경 전후 | NOT RUN | | **미착수** | 0 |
| P1 | P1-D real/simulated 라벨·인터뷰/반응 입력 | NOT RUN | | **미착수** | 0 |
| P1 | P1-PR | | | **부분 범위 PR 둘** — #1176 이 P1-A, 그 위가 P1-B. C·D 없음 | 2 |
| P2 | P2-A 경계 회고 | NOT RUN | | | | 0 |
| P2 | P2-B 다음 실험 → 다음 과제, 기존 개선 루프 연결 | NOT RUN | | | | 0 |
| P2 | P2-PR | | | | | |
| P3 | P3-A 변화 기록 화면 (여유 시) | NOT RUN | | | | 0 |

## 열린 PR

**[#1170 feat(sx): 학생 화면의 주인공을 현재 과제로 바꾼다 — 학습 경험 우선 P0](https://github.com/jayleekr/hypeproof-studio/pull/1170)**
브랜치 `feat/sx-p0-curriculum-first` → `main`. 66 파일, +6412 / −269.
**머지하지 않았다.** auto-merge 꺼짐, draft 아님, `mergeable: MERGEABLE`.
리뷰어는 `pr.py` 정책대로 요청됐다(작성자 제외 7명).

`hype-pr` 절차를 그대로 탔다: `inspect` → assessment 직접 작성 → `prepare` → `create --apply`.
`gh pr create` 로 우회하지 않았다. inspect 는 blockers `[]`, existing_debt 0.

assessment 에서 판정한 것(17 노드):
- SX 사슬 5개(`ST-INT-SX`·`ST-REQ-SX`·`ST-DES-SX`·`ST-TEST-SX`·`ST-IMP-SX-P0`) → satisfied
- 공유 파일로 걸린 기존 노드 중 실제 영향이 있는 것(`ST-IMP-START`·`ST-IMP-UNIFIED-ENTRY`·
  `ST-IMP-ACTIVITY-BINDING`·`ST-IMP-LOCAL-REVIEW`·`ST-TEST-LOCAL-REVIEW`) → satisfied,
  각각 무엇을 직접 읽어 확인했는지 적었다
- 음성·실기 검증 노드 7개 → no-impact
- validation 10행: 게이트 9개 pass, Electron e2e·실기·사람 판정은 `not-applicable` 로
  적고 왜 실행할 수 없는지 밝혔다(앱 빌드는 사용자 승인 사항)

**머지 전에 할 일**: 이슈를 붙인다(이 브랜치는 이슈 없이 야간 세션이 열었다).
PR 본문 첫 줄에 그 안내가 주석으로 있다.

### CI 가 잡은 것 — 로컬 게이트가 못 본 세 가지

PR 을 올리고 나서 CI 가 두 번 빨갰다. **둘 다 내 변경 때문이고 둘 다 진짜다.**
"CI 초록은 아무것도 보장하지 않는다" 의 반대쪽 짝이다 — 로컬 초록도 보장하지 않는다.

**1차: `coverage` (harness_fixable → 제품 등록 누락).**
`GAP: unregistered document: docs/requirements/studio-learning-experience.md`.
요구 문서를 `config/requirement-work.json` 에 등록하고, 이어서 뜬 "unassigned
requirement" 60줄을 단계별 실행 단위 5개로 배정했다(이슈 #1171~#1175). exit 0.
문서를 `excluded` 에 넣어 넘어가지 않았다 — 그 자리는 자체 번호가 없는 문서용이고
SX 는 번호가 60개 있다. 세지 않으려고 목록에서 빼는 것은 원장이 하려는 일의 반대다.

**2차: `start-page-browser` → `trial-ux` US-UI-DRAFT (product).**
    await expect(p.getByLabel('현재 활동')).toContainText('합성 활동 B');
예전 `hps-activity-header` 가 갖고 있던 `aria-label="현재 활동"` 을 미션 헤더 안
작은 줄로 옮기면서 **라벨을 빠뜨렸다.** 자리를 옮기는 것과 라벨을 잃는 것은 다르다.
라벨을 되살렸고 로컬 렌더 검사에 그 단언을 더했다 — **없어서 못 잡았다.**

그 김에 바뀐 이름을 저장소 전체에서 세어서 **CI 가 잡아 주지 않았을 것 두 개**를
더 고쳤다. 특히 하나는 초록인데 아무것도 세지 않고 있었다:

| 곳 | 무엇이 | 왜 CI 가 못 잡나 |
|---|---|---|
| `e2e/trial-ux/run.mjs` TUX-COND-05 | `.hps-lesson` 개수 0 단언이 **사라진 클래스**를 세고 있었다 | 초록이다. **빨간 것보다 나쁘다** — 이름을 따라가고 대조군(`.hp-mission` 1개)을 옆에 뒀다 |
| `e2e/lesson-studio/mac.mjs` | `.hps-lesson` 과 그 안의 버튼으로 과제를 채팅에 넣는다 | CI 에서 안 돈다(GUI 로컬 전용). 다음 로컬 실행에서 멎었을 것이다 |

**배운 것을 그대로 적는다.** 내 렌더 스모크는 h1·Primary 개수·금지 수치는 봤지만
**접근 라벨은 보지 않았다.** 렌더 판정은 실제 브라우저 판정을 대신하지 못한다.
로컬에서 실기 절반을 못 돌린다는 사실이 "그 절반이 아마 괜찮다" 는 뜻이 아니다.

### PR 을 쓰다가 잡은 것

`ST-IMP-LOCAL-REVIEW` 의 영향을 판정하려고 바꾼 문자열을 저장소 전체에서 **세어 봤더니**
`e2e/local-review/mac.mjs` 가 `'내 작업 검토'` 버튼과 `h1 === "My task reviews"` 를
가리키고 있었다. P0-C 가 둘 다 "나의 변화 기록" 으로 바꿨으므로 그 하네스는 지금
상태로는 버튼을 못 찾고 멎는다. 세 줄을 따라 고쳤다(`9f227cc`) — 단언을 약하게 한 것이
아니라 같은 세기로 같은 것을 가리키게 했다. 같은 검사에서 `e2e/lesson-studio/*.mjs` 의
`.studio-primary` 도 봤는데 그쪽은 **연결된 수업 화면**의 버튼이라 이번 진입 선택지
변경과 무관했다 — 건드리지 않았다.

assessment 를 쓰지 않았으면 다음에 Jay 가 `e2e/local-review` 를 돌렸을 때 제품 결함처럼
보이는 하네스 고장을 만났을 것이다.

## 평가 (구현자와 다른 세션)

판정서: `.claude/hypeproof/ux/judge-P0-2026-09-20.md`.
**FAIL 75 / 100 (통과선 90). CRITICAL 10개는 전부 통과.**

평가자가 게이트 여덟 개를 **직접 다시 돌렸고**, 구현 전 트리를 `git archive ce95747`
로 scratchpad 에 풀어 대조군을 **재현**했다. 이 체크아웃은 건드리지 않았다.
재현 결과 중 하나는 기록을 고치게 했다: P0-D 의 "4 passed / 12 failed" 는 순수
`origin/main` 이 아니라 **P0-A 를 적용한 트리**에서 나오는 수치다(P0-D 가 데이터상
P0-A 에 의존한다). 평가자가 먼저 계측기를 의심한 뒤 그 사실을 특정했다.

점수 75 의 성격을 분명히 해 둔다. **거짓 초록은 하나도 발견되지 않았고**, 평가자는
"통과라고 적은 것 중 실제로 NOT RUN 인 것을 찾지 못했다 — 오히려 과소 주장 쪽으로
기울어 있다" 고 적었다. 감점의 큰 덩어리는 루브릭이 P0 에 적용될 수 없는 부분이다
(위 "사람에게 묻는 것" 6번).

실제 결함 셋은 `115a746` 에서 고쳤다:

| 지적 | 분류 | 무엇이 틀렸나 | 고친 방법 |
|---|---|---|---|
| D-2 | **product** | 2·5주차 미션·목표가 보존 원문과 달랐다. 5주의 `10명을 만드나 → 열 명을 만나나` 는 **뜻이 움직인다** | 원문 바이트로 되돌리고, 여섯 주차의 미션·목표·금지 문장을 원문 본문과 대조하는 검사 추가(대조군 포함) |
| D-1 | harness_fixable | 감사 계측기가 `ChatPanel`(작업 화면 본체)과 `StartPage` 를 렌더하지 않았다 — C1 의 통과 근거가 렌더가 아니라 소스 grep 이었다 | 두 화면을 등록하고 실제 렌더(530자·353자)를 감사. 미션에 점수를 심는 음성 대조군 추가 |
| D-3 | harness_fixable | 수치 규칙이 단위 붙은 것만 봐서 `레벨 3`·`★★★☆☆`·맨숫자가 통과했다. `region:"metric"` 은 4·6주차 수치 규칙을 통째로 껐다 | 규칙 3개 추가(음성 대조군도 함께, 13→18종), metric 은 끄는 대신 허용 목록을 넓히는 방식으로 변경 |

**그 수정이 곧바로 다시 물었다.** `bare_number` 를 넣자마자 실제 `ChatPanel` 렌더가
두 곳에서 걸렸다 — 목록 번호 `1. 기대 조건` 과 모듈 버전 `m2026.09.20-1` 의 뒷자리.
둘 다 정상 문자열이고 "너무 엄격한 계측기" 쪽 오류다. 허용 목록에 넣고 **양성
대조군으로 고정**했으며, 버전 패턴은 짐작하지 않고 `modules.ts` 의
`MODULE_VERSION_RE` 를 읽어서 맞췄다.

고치지 않고 기록만 한 것(평가자가 `spec` 으로 분류): D-4 · D-5 · D-6 · D-9 · D-10.
전부 아래 두 절에 있다. 요구와 루브릭은 조용히 바꾸지 않는다.

## 실기 증거

**없다. 이 세션은 실기 증거를 만들지 않았다.**
`docs/testing/studio-learning-experience.md` §실기 증거 규칙의 세 라벨 중
이 세션이 만든 것은 전부 **synthetic** 이다 — 단위 테스트, 심은 시료, 대조군.
live-host 도 captured-replay 도 없다. 앱을 빌드하지도 띄우지도 않았다
(`bash build.sh` 는 사용자 승인 없이 금지).

그래서 **SX-T60(Jay dogfood 인수)과 5초 회상 테스트는 NOT RUN 이고, 이 세션의
어떤 결과도 그것을 대신하지 않는다.** 자동 판정이 통과했다는 사실은 학생이
무언가를 배웠다는 증거가 아니고, 게이트가 화면에서 막혔다는 증거조차 아니다 —
아직 화면을 띄워 본 적이 없다.

**대리물은 하나 있다 — 그리고 그것도 증거가 아니다.**
`e2e/test-results/sx-screens/mission-header.html` (gitignore 대상, 테스트가 매번 새로 쓴다).
Mission header 를 실제 렌더해 토큰·스타일과 함께 떨군 HTML 이고, 브라우저로 열면
"첫 화면에서 가장 큰 활자가 미션 문장인가" 를 눈으로 볼 수 있다. 파일 첫 줄에
`synthetic` 라벨과 "실기 증거가 아니다" 가 박혀 있다 — 실제 앱 레이아웃도 폰트도
VS Code 테마도 아니다.

다음 세션이 실기 증거를 만들려면: `extensions/hypeproof-chat && npm run build`
→ `scripts/inject-builtin-extensions.sh` → 앱 실행 → `e2e/` Playwright.
그 전에 Jay 의 빌드 승인이 필요하다.

## 사람에게 묻는 것 (harness_undecided / spec / 진짜 blocker)

**진짜 blocker 는 없다.** P0 는 끝까지 갔다. 아래는 판단이 필요한 것들이다.

1. **SX-T13 "각 화면 정확히 1개" vs SX-04 의 진입 화면 규칙 (spec).**
   SX-04 는 시작 화면의 "AI 체험하기 / 수업에 참여하기" 를 이름으로 지목해
   "동급 선택이므로 선택지 목록으로 그리고 둘 다 Primary 로 그리지 않는다" 고 적었다.
   그대로 구현하면 그 화면의 Primary 개수는 **0** 이 되고, SX-T13 의 "각 화면 정확히
   1개" 와 어긋난다. 구현은 요구대로(선택지 목록) 했다.
   → SX-T13 을 "1개를 넘지 않는다" 로 고칠지, 아니면 선택 뒤 별도 Primary 를 세울지.

2. **SX-02 부정문이 전제하는 action 배열이 스키마에 없다 (spec).**
   "action 이 4개 이상인 설계 파일은 잘라서 보이지 않고 설계 파일 검증에서 거부한다"
   는 설계 파일이 action 을 직접 선언한다고 전제하는데, `hps-session-design/1` 에는
   단계(step)만 있고 최대 30개까지 유효하다. 지금은 현재 단계부터 3개만 보여 주고
   남은 단계 수를 문장으로 같이 말한다(`missionHeaderLogic.ts` 주석에 근거).
   → 설계 파일에 action 칸을 새로 열지, 아니면 SX-02 의 부정문을 고칠지.

3. **카피 lint 의 사각 (harness_undecided).**
   `test/sx-copy-lint.mjs` 는 한국어 **문형 규칙**이지 자연어 이해가 아니다.
   목록 밖의 새로운 평가 문형은 놓친다. 통과는 "나쁜 문형이 없다" 가 아니라
   "알려진 나쁜 문형이 없다" 이고, 판정 결과가 그 사실을 `covers` 로 실어 보낸다.
   SX-T15·T18 의 사람 원문 검토를 대신하지 않는다.

4. **감사 계측기가 일부러 싣지 않은 규칙 두 개 (harness_undecided).**
   - 맨 `상위` — 한국어 부분 문자열로 흔하다(이 저장소에만 "최상위 규칙",
     "상위 provider 필드"). 랭킹 표시(`상위 N%`, `상위 랭킹/순위`)로만 좁혔다.
   - 일반형 `\d+/\d+` 비율 — 날짜(9/20)와 구분되지 않는다. 두 문서가 이름을 댄
     분모(6·7·10·100)로만 좁혔다.
   → 좁힌 범위가 충분한지 사람이 한 번 봐야 한다.

5. **`asset_score` SSE 청크는 워커가 아직 보낸다.**
   App 은 이제 읽고 버린다(SX-59). 청크 발신을 멈추는 것은 별도 Service 변경이고
   이 세션 범위 밖으로 뒀다. 지금 상태가 틀린 것은 아니다 — 죽은 대역폭일 뿐이다.

6. **루브릭이 단계 PR 에 그대로 적용되지 않는다 (spec, 평가자 D-10).**
   E(근거·출처 10점)는 drawer 와 `source_state` 라벨을 보는데 그것은 DAG 상
   P1-B·P1-D 다. C(정보 우선순위 15점)는 스크린샷 기반 5초 회상 판정을 요구하는데
   앱 빌드는 사용자 승인 사항이다. **P0 가 완벽해도 통과선 90 에 구조적으로 닿을 수
   없다.** 평가자가 이것을 구현자 점수에 조용히 얹지 않고 `spec` 으로 분리했다.
   → `.claude/evals/STUDIO_UX_EVAL.md` 에 단계별 적용 열을 넣거나(P0 는 A·B·F·G·H,
     C·D·E 는 "해당 단계에 없으면 만점 제외"), 통과선을 "그 단계가 다루는 영역의
     합계 비율" 로 바꾼다. 루브릭 수정은 `AUTONOMY_POLICY` 가 금지한 항목이라
     이 세션은 손대지 않았다.

7. **SX-55(과제 흐름 상태 기계)가 P0-A 의 `spec_section` 에 있는데 P0 에 없다 (spec, D-4).**
   `learning.completion` 데이터만 있고 `assigned → in_progress → submitted → reflected`
   전이는 없다. 판정 근거가 될 학습 이벤트가 P1-A 에서 생기므로 P1-B 가 맞는 자리다.
   → `ux-dag.yaml` 의 `P0-A.spec_section` 에서 SX-55 를 빼고 P1-B 로 옮길지 결정.

8. **개입 사다리가 데이터가 아니라 워커 코드 상수다 (spec, D-5).**
   `P0-D.acceptance` 는 "encoded as **data** … with the answer step requiring a reason"
   라고 적었다. 실제는 `learning-prompt.ts` 의 문자열 배열이고, 앱은 읽지 않으며
   "이유 필수" 는 프롬프트 지시문이지 집행이 아니다.
   → 사다리를 `learning-design.ts` 에 export 해 앱이 읽게 할지, acceptance 문장을
     "프롬프트 조립기가 소비하는 순서 있는 상수" 로 좁힐지 결정.

## 요구 개정 제안

구현은 **요구대로** 했다. 아래는 제안이고, 어느 것도 조용히 적용하지 않았다.

1. **`steps[].evidence` 이름 충돌 — 가장 중요하다.**
   SX 설계의 `steps[].evidence` 는 SX-18 의 근거 **종류** 6종 enum 이다.
   그런데 `worker/src/lib/lesson-pedagogy.ts` 의 `step_evidence` 검사(관문2-1 /
   curriculum wiki `rules/curriculum-schema.md` Lint 2)가 기다리는 `evidence` 는
   `evidence: ""  # 이 활동이 남기는 증거물 1개` — **제3자가 볼 수 있는 남는 물건의
   이름**(자유 텍스트)이다. 관문2-1 은 "성찰·소감은 증거가 아니다" 라고 못박는다.
   같은 키 이름, 다른 계약. **커리큘럼 위키가 상위 정본이다.**

   구현 중에 한 번 `steps[].evidence` 가 있으면 `step_evidence` 경고를 끄도록
   붙였다가 **되돌렸다.** `evidence: "ownership"` 을 골랐다고 그 단계가 물건을
   남기는 것은 아니고, 그러면 무관한 필드로 살아 있는 검사를 무력화하는 것이 된다.
   `lesson-pedagogy.ts` 는 한 줄도 바뀌지 않았고, 산문 정규식(`제출 증거:`)이
   그대로 유일한 판정이다. 근거는 `worker/src/lib/learning-design.ts` 파일 끝 주석.

   → 제안: SX 쪽 단계 키를 **`evidence_type`** 으로 개칭한다. 그러면 뒤에
     커리큘럼 위키의 `evidence`(남는 물건)를 충돌 없이 열 수 있다.
   → 부작용 하나: 지금 상태로 SX 주차 파일을 확정하면 단계마다
     `step_evidence` **warn** 이 뜬다(차단은 아니다). 시료 단계들이 산문에
     `제출 증거:` 줄을 갖고 있지 않기 때문이고, 그건 사실이다 — 끄지 않았다.

2. **SX-12 의 규칙 문장이 SX-12 의 금지 목록에 걸린다.**
   원문 §10 언어 규칙 (1) 은 "평가형 형용사(우수, 부족, **낮음**)" 라고 예시를 든다.
   그런데 "낮음" 은 §12 가 금지한 라벨 그 자체다. 규칙을 축자로 옮겨 적으면
   그 규칙이 자기 금지 목록에 걸린다. 코치 프롬프트에서는 범주로 바꿔 적었고
   (`learning-prompt.ts`), §10 "나쁜 UX" 다섯 문장도 그대로 싣지 않았다 —
   금지 문형을 프롬프트에 넣는 것은 그 문형을 모델 문맥에 넣어 주는 것이다.
   → §10 이나 §12 중 하나가 이 예외를 명시해야 한다.

3. **§12 "금지 라벨 6개" 는 실제로 7개 토큰이다** ("낮음 / 높음" 이 한 줄).
   계측기는 7개를 전부 센다. 문서의 숫자를 고치거나 목록을 6줄로 나눈다.

4. **SX-56 의 "정책 플래그(SX-41)" 자리가 P0 에 없다.**
   DAG P0-A 의 control 이 고정한 learning 키 집합에 없고 SX-41 자체가 P2 다.
   P2 에서 `learning.policy` 를 열지 결정 필요.

5. **설계 문서의 코치 프롬프트 조립 지점 경로가 틀렸다.**
   §코드 변경 지도는 `worker/src/routes/*` 라고 적었지만 실제 단일 조립 지점은
   `worker/src/lib/chat-gate.ts` 다. 라우트를 고쳤으면 두 런타임이 갈라졌을 것이고,
   `chat-gate.ts` 는 바로 그것을 막으려고 추출된 파일이다.

7. **"나의 변화 기록" 이름이 화면보다 먼저 갔다 (평가자 D-9).**
   `localReview` 의 명령 제목·nav 라벨·패널 제목·h1 을 P0 에서 바꿨는데 화면 **내용**은
   아직 P0 상태다(`LocalReview.tsx` 가 메시지 수·N건 카운트를 그대로 그린다).
   작업 중 화면이 아니라 C1 은 걸리지 않지만, **P3-A 의 "첫 화면에 숫자 없음"
   대조군이 나중에 여기서 빨개진다.** 새 회귀가 아니라 예정된 것이다.

8. **SX-58 의 절반은 아직 없다.**
   "각 항목은 예시 세션 설계 파일의 금지 필드 **와** 코치 프롬프트 부정 fixture 로
   존재한다" 중 앞쪽만 했다. 금지 문장이 프롬프트에 **닿는다**는 것은 실측했지만,
   코치가 그것을 **지킨다**는 부정 fixture 는 여섯 주차 어디에도 없다.
   그건 실제 모델이 필요하다.

9. **P1-A 가 찾은 설계 문서 모순 넷 — 문자 그대로면 쓸 수 없는 것이 나온다.**
   조용히 지나가지 않고 좁은 예외를 만들었다. 어느 쪽이 정본인지는 사람이 정한다.
   - **`external_feedback_received` 가 자기 규칙 1과 충돌한다.** kind 표는 `student_text`(인용)를
     필수로, 기본 actor 를 `external_user` 로 둔다. 규칙 1 은 `student_text` 가
     `actor=user` 에만 있을 수 있다고 한다. 문자 그대로면 **이 kind 는 쓸 수 없다.**
     → 그 한 조합만 예외로 열고 나머지 거절은 유지. SX-44 부정문이 이름을 댄 것은 `actor=AI` 뿐이다.
   - **`criterion_set` 의 `student_text` 필수와 SX-14 가 충돌한다.** SX-14 는 코치가 제안한
     기대 조건이 "actor=AI 로 남아 게이트를 통과하지 못한다" 고 하는데, 그러려면 그
     이벤트가 **저장은 돼야** 한다. → 필수를 `actor=user` 일 때로 좁혔다.
   - **SX-14 규칙 1 이 8종 중 2종에 충족 불가능하다.** `test_observed`·`retest_confirmed` 에는
     `student_text` 칸이 아예 없는데 강사는 8종 중 아무거나 완료 조건으로 고를 수 있다.
     → 텍스트 요구를 그 kind 의 표에 칸이 있을 때만 적용했다.
   - **SX-15 규칙 3 의 `resolveVerification()` 은 그대로 부를 수 없다.** 그 함수는 요청·결과·
     인용된 method 를 받는데 `retest_confirmed` 는 `result_ref` 하나뿐이고, 코어로
     import 하면 순환이 된다. → 같은 규칙을 8줄로 그 자리에 적용하고 주석에 밝혔다.

10. **P1-A 가 남긴 부채 넷 (범위 밖이거나 결정 대기).**
   - `worker/src/routes/observations.ts` 의 `POST /observations/validate` 가 `/2` 배치를 받아
     놓고 응답에 `format: OBSERVATION_FORMAT` 을 **하드코딩**한다 — `/2` 가 `/1` 로 보고된다.
     설계의 "바꾸는 파일" 목록에 이 파일이 없다.
   - `worker/src/lib/learning-design.ts`(P0)가 세 목록을 **자기 사본**으로 들고 있다.
     설계는 코어에 두라고 한다. control 이 deep-equal 을 단언해 드리프트는 스위트가 잡는다.
   - `teacher_review` 의 키가 `reviews/<task>/` 아래라 `exportTask` 가 `Review[]` 로 쓸어
     담는다. P4 가 쓰기 시작하면 한 배열에 두 record 모양이 섞인다. 아직 쓰는 경로가 없다.
   - `SCORE_KEYS` 가 세 군데에 있다. 합치려면 코어에서 export 해야 하는데 `MC-T09` 가
     "코어는 이름이 score·rank·grade 로 읽히는 것을 export 하지 않는다" 를 단언한다.
     **이름을 바꿔 그 단언을 피하는 것은 살아 있는 검사를 속이는 것**이라 합치지 않았다.

11. **P1-B 가 찾은 스키마 ↔ 요구 충돌 둘 — 둘 다 "사람이 정할 것" 이다.**
   - `provenance` 가 SX-20 과 충돌한다. `/2` 검증기는 `{who,when,where}` 세 칸이
     **모두 비어 있지 않을 것**을 요구하는데(`legacy-observation.ts` `shapeOf`),
     SX-20 은 미입력을 "출처 미기록" 으로 남기라고 한다. 빈 문자열을 보내면 배치
     전체가 거절되고, 아무 말이나 넣으면 SX-20 이 금지한 "추정으로 채우기" 가 된다.
     → **기록되지 않았다는 사실 자체를 기록**했다(`UNRECORDED = "미기록"`). 지어낸
     출처가 아니므로 추정이 아니고, 화면에서는 빈 칸과 똑같이 다룬다.
     **정본 선택**: (a) 스키마가 빈 문자열을 허용하도록 넓힌다, (b) 지금처럼 센티널을
     쓴다, (c) `provenance` 를 `external_feedback_received` 의 선택 키로 내린다.
   - SX-22 는 종류에 **설문**을 적고, 설계 표의 `source_kind` 는 `test`(직접 시험)를
     적는다. 둘 다 여섯 개이고 나머지 다섯은 같다. P1-A 가 이미 설계 쪽으로 닫았고
     fixture 와 열린 PR(#1176)이 그 enum 위에 있어서 **바꾸지 않았다**.
     → 설문을 받을 자리가 지금은 없다. 인터뷰로 뭉뚱그리면 SX-22 부정 조건에 걸린다.

12. **P1-B 가 남긴 빚 하나 (범위였는데 못 끝낸 것).**
   `Task.curriculum` 영속화와 phase 전이(`working → submitted`)가 없다. `submitTask` 는
   게이트를 다시 판정하고 거절 사유를 돌려주는 데까지고, 통과해도 상태가 바뀌지 않는다.
   설계 §과제 흐름 상태 기계의 나머지 절반이다. 화면에서는 "완료가 열린다" 까지만
   참이고 **"완료된다" 는 아직 참이 아니다.**

## Lab에 넘길 것

- Lab `products/lab-web/measurement-profile.md` MP-01 "score-first" 개정: SX-60(6개 점수 카드를 접힌 세부 데이터로)과 충돌. Lab 결정 기록 `docs/decisions/2026-09-18-studio-ux-philosophy-adoption.md`에 등록됨.
- 미성년(고등학생) 파일럿의 보호자 동의·강사 매개 경로: Lab MISSION 아동 안전 결정 대기.

## 다음 세션이 집을 첫 task

`docs/plan/ux-dag.yaml` **P1-C — 재확인 게이트와 변경 전후 보기** (`depends_on: [P1-B]`, 끝났다).
P1-D(`real`/`simulated` 라벨·인터뷰 입력)도 `depends_on: [P1-B]` 라 **둘은 서로 독립**이다.
어느 쪽을 먼저 집어도 된다.

P1-C 가 쓸 것은 이미 있다: `gates().verification` 이 `criterion_ref`·`artifact_after`·
`result_ref` 세 조건을 이미 판정하고, 그 문장이 서랍의 검증 줄로 나가고 있다.
남은 것은 **변경 전후 보기**(SX-16) — `artifact` 이벤트 두 개의 sha256 과 본문을
나란히 놓고, 그때 적용된 기대 조건을 함께 보여 주는 화면이다. AE-05 의 기존
전후 증거를 **다시 만들지 말고 재사용**하라고 DAG 수용 기준이 적고 있다 —
`NativeObservationPanel` 의 `hps-observation-compare` 블록이 그것이다.

P1-D 는 `source_state` 가 이미 저장·표시되고 있으므로 Amber 마커와 라벨,
그리고 `external_feedback_received` 의 `source_state` 선택 UI 가 남았다.
지금은 폼이 `unverified` 로 고정해 보낸다(`real` 을 기본으로 채우지 않기 위해).

**P1-B 에서 넘어온 빚 하나**: `Task.curriculum` 영속화와 phase 전이
(`working → submitted`)가 없다. `submitTask` 는 게이트를 다시 판정하고 거절
사유를 돌려주는 데까지다. 설계 §과제 흐름 상태 기계의 나머지 절반이다.

**저장 계층은 이미 있다.** P1-A 가 `hps-observation/2`, 학습 이벤트 8종, 그리고
`gates()`(완료·재확인)를 순수 함수로 만들어 두었다(`measurement-core/learning-events.ts`).
P1-B 가 할 일은 **그것을 부르는 화면**이다 — 지금은 게이트가 정확히 판정하지만
아무도 부르지 않는다.

시작 전에 읽을 것:
- `worker/src/lib/measurement-core/learning-events.ts` — `gates()` 의 입력과
  `GateMiss` 코드. 화면이 "왜 막혔는지" 를 그 코드로 말해야 한다.
- 설계 §정보 구조 영역 D, §과제 흐름 상태 기계.
- `extensions/hypeproof-chat/webview-ui/src/NativeObservationPanel.tsx` — D 가 대체할 것.
- `extensions/hypeproof-chat/test/sx-render.mjs` · `sx-audit.mjs` — 새 화면도 같은
  계측기로 감사한다. `COMPONENTS` 에 등록하면 된다.

**호스트가 게이트를 계산하고 웹뷰는 그린다.** 설계가 못박은 경계다 — 웹뷰에서
게이트를 다시 계산하지 않는다. `MissionHeader` 의 `currentStepId` 가 지금 웹뷰
`useState` 인 것도 P1-B 에서 호스트의 `learningState` 로 옮길 자리다.

**근거 없는 ✓ 를 그리지 않는다.** 지금 완료 조건은 전부 ☐ 이고 화면이 "아직 확인
전" 이라고 말한다. P1-B 가 그 자리를 이벤트로 채운다.

## 기록

- 2026-09-20 P1-B. 브랜치 `feat/sx-p1b-evidence-drawer`(#1176 위), 커밋 `6d4b8d7`.
  영역 D(Evidence drawer)와 완료 게이트를 화면까지 이었다. P1-A 의 순수 함수에
  **부르는 쪽**이 생겼다. 웹뷰는 게이트를 다시 계산하지 않고 호스트가 보낸
  `complete.ok` 를 그린다. `disabled` 는 잠금이 아니므로 `submitTask` 를 받은
  호스트가 **같은 함수**로 다시 판정한다.
  결함 18개를 심어 18개를 잡을 때까지 단언을 고쳤고, 그 과정에서 **내 단언 두 개가
  아무것도 재고 있지 않은 것**을 찾았다: `auditRegionText("EvidenceDrawer", text)` 는
  시그니처가 `(text, opts)` 라서 문자열 "EvidenceDrawer" 를 감사하고 있었고,
  `checked.missing.length === 0` 의 `missing` 은 seq 구멍이라 무엇이 통과하든 초록이었다.
  폼 → 호스트 → 검증기 루프에서 제품 결함 둘도 잡았다(`evidence_refs: []`,
  빈 `provenance`) — 둘 다 저장은 되고 **다음 읽기에서 배치 전체가 거절**되는 유형이다.
  단위 테스트만으로는 끝까지 초록이었을 것이다.
  곁가지로 `prepareObservation` 이 `/1` 만 받던 것을 고쳤다. 안 고쳤으면 `/2` 프로필에서
  관찰이 아예 안 붙어 학습 이벤트가 쌓일 자리가 없었다 — 설정은 맞는데 동작이 없는 유형.
- 2026-09-20 P1-A. 브랜치 `feat/sx-p1-evidence-capture`(P0 브랜치 위), 커밋 `7171d56`.
  `hps-observation/2` 를 같은 파일 안의 상위 집합으로 받고, 학습 이벤트 8종·필드 7개와
  두 게이트를 순수 함수로 만들었다. `/1` golden 은 한 바이트도 안 움직였다.
  **학생 화면은 한 픽셀도 바뀌지 않았다** — 게이트를 부르는 UI 는 P1-B 다.
  설계 문서 모순 4건과 부채 4건을 찾아 위에 올렸다(개정 제안 9·10번).
  구현 중 판단 하나를 되돌렸다: `SCORE_KEYS` 를 코어 export 로 합치려다
  `MC-T09`("코어는 score·rank·grade 로 읽히는 이름을 export 하지 않는다")에 걸렸고,
  이름을 바꿔 피하는 대신 사본을 행동으로 잠갔다.
- 2026-09-18 준비. 분류표·intent·요구·설계·검증·계획·DAG·정책·루브릭 작성. 코드 변경 없음.
- 2026-09-18 검토. origin/main 대조로 기반 사실 확인, 강사 역할 전제 정정(5개 문서), P0-A를 기존 스키마 확장으로 수정, asset-status 스모크 함정 기록. 코드 변경 없음.
- 2026-09-20 P0 실행. 커밋 8개(`c131be3`..`2a841e0`), 브랜치 `feat/sx-p0-curriculum-first`.
  준비 문서 이관 + 레지스트리 4노드 + 색인 2곳 → P0-A → P0-B → P0-E → P0-C → P0-D(Service) → P0-D(카피 lint).
  계측기 오류 **세 건**을 제품 결함으로 올리기 전에 배제했다: worktree 의 낡은
  `node_modules` 심볼릭 링크(miniflare), 낡은 harness 체크아웃, 그리고 스카우트
  에이전트가 낡은 worktree 기준으로 보고한 "harness 정책 만료" 오보.
  구현 중 서브에이전트 판단 **두 건**을 되돌렸다: `steps[].evidence` 로 교육 관문
  경고를 끈 것(요구 개정 제안 1), 감사 스모크가 삭제 예정 모듈을 import 한 것
  (#904→#910 함정). 실기 증거 없음.
