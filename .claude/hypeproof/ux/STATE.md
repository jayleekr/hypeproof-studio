# STATE: 학습 경험 우선 Studio 야간 개발 원장

> 살아 있는 원장. 단계·게이트가 바뀔 때마다 갱신한다. 재개할 때 이것을 먼저 읽는다.
> 마스터 프롬프트 `MASTER_PROMPT.md` · 루브릭 `../../evals/STUDIO_UX_EVAL.md` · DAG `docs/plan/ux-dag.yaml`

## RESUME HERE

**2026-09-20 실행 세션 진행 중 (Opus 5, worktree `claude-epic`).** 준비 문서 이관·레지스트리·색인 적용 완료, 기존 테스트 세 벌 모두 초록, `ux-dag.yaml` P0 task 실행 중. 아래 "단계별 게이트" 표가 현재 상태다.

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
| PR | `python3 scripts/hype-pr/pr.py inspect` | **FAIL** — 아래 "사람에게 묻는 것" 아님, harness_fixable |

**워커 첫 실패는 제품이 아니라 계측기였다 (harness_fixable).** `test:budget-recovery`가
`SyntaxError: Named export 'convertV4MiniflareOptions' not found`로 죽었다. 원인은 worktree의
`worker/node_modules`가 **메인 체크아웃(`chore/work-ready-20260913`)의 설치본을 가리키는 심볼릭 링크**라서
miniflare `5.20260730.0-alpha`가 깔려 있었던 것이다. 이 브랜치의 `package.json`·lockfile은
`5.20260911.1-alpha`를 요구한다(#1070). 심볼릭 링크를 지우고 worktree 자체에 `npm ci` 하니 전부 초록.
`chalk`도 같은 심볼릭 링크였고 같은 처리를 했다. **메인 체크아웃의 node_modules는 건드리지 않았다**
(링크를 통해 `npm ci`를 돌리면 메인 쪽 설치본을 덮어썼을 것이다). 추적 파일 변경 0, `node_modules`는 gitignore 대상.
규칙 6대로 계측기를 먼저 배제했고, 제품 결함으로 보고하지 않는다.

## 단계별 게이트

| 단계 | task | machine_gate | control | acceptance (루브릭 점수) | 판정 | 시도 |
|---|---|---|---|---|---|---|
| P0 | P0-A 세션 설계 파일 | NOT RUN | | | | 0 |
| P0 | P0-B 토큰·디자인 시스템 | NOT RUN | | | | 0 |
| P0 | P0-C 학생 홈·Mission header | NOT RUN | | | | 0 |
| P0 | P0-D Coach rail·Work canvas 재배치 | NOT RUN | | | | 0 |
| P0 | P0-E assetStatusBar 제거·작업 중 숫자 0 | NOT RUN | | | | 0 |
| P0 | P0-PR | | | | | |
| P1 | P1-A 이벤트·필드 확장 | NOT RUN | | | | 0 |
| P1 | P1-B Evidence drawer·기대 조건·완료 게이트 | NOT RUN | | | | 0 |
| P1 | P1-C 재확인 게이트·변경 전후 | NOT RUN | | | | 0 |
| P1 | P1-D real/simulated 라벨·인터뷰/반응 입력 | NOT RUN | | | | 0 |
| P1 | P1-PR | | | | | |
| P2 | P2-A 경계 회고 | NOT RUN | | | | 0 |
| P2 | P2-B 다음 실험 → 다음 과제, 기존 개선 루프 연결 | NOT RUN | | | | 0 |
| P2 | P2-PR | | | | | |
| P3 | P3-A 변화 기록 화면 (여유 시) | NOT RUN | | | | 0 |

## 열린 PR

(없음)

## 실기 증거

(없음. 규칙: `docs/testing/studio-learning-experience.md` §실기 증거 규칙)

## 사람에게 묻는 것 (harness_undecided / spec / 진짜 blocker)

(없음)

## 요구 개정 제안

(없음)

## Lab에 넘길 것

- Lab `products/lab-web/measurement-profile.md` MP-01 "score-first" 개정: SX-60(6개 점수 카드를 접힌 세부 데이터로)과 충돌. Lab 결정 기록 `docs/decisions/2026-09-18-studio-ux-philosophy-adoption.md`에 등록됨.
- 미성년(고등학생) 파일럿의 보호자 동의·강사 매개 경로: Lab MISSION 아동 안전 결정 대기.

## 기록

- 2026-09-18 준비. 분류표·intent·요구·설계·검증·계획·DAG·정책·루브릭 작성. 코드 변경 없음.
- 2026-09-18 검토. origin/main 대조로 기반 사실 확인, 강사 역할 전제 정정(5개 문서), P0-A를 기존 스키마 확장으로 수정, asset-status 스모크 함정 기록. 코드 변경 없음.
