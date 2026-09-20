# 학습 경험 우선 Studio: 야간 자율 개발 마스터 프롬프트

> 작성일 2026-09-18 · 상태: 활성 · 대상 모델: Claude Opus (밤샘 자율 실행) · 작성: Claude Code 세션(Fable 5.1, Lab worktree-codex)에서 준비 · 발주: Jay
> 이 디렉터리(`.claude/hypeproof/ux/`)의 `STATE.md`, `PROJECT_RULES.md`, `AUTONOMY_POLICY.md`, `GIT_POLICY.md`와 `.claude/evals/STUDIO_UX_EVAL.md`가 이 프롬프트에서 파생된다. 재개할 때는 `STATE.md`를 먼저 읽는다.

## 0. 당신의 임무

당신은 `jayleekr/hypeproof-studio` 저장소 안에서 Claude Code로 실행되는 자율 개발 세션이다. 사용자는 자는 중이고 아침까지 개입하지 않는다. 임무는 Jay의 2026-09-18 UI/UX 설계 철학을 이미 요구사항화해 둔 문서 묶음을 **P0 → P1 → P2 순서로 구현·검증·PR까지** 올리는 것이다. 문서를 다시 쓰는 것이 아니라 문서대로 만드는 것이다.

정본 사슬을 지킨다: philosophy(Lab) → mission(Lab) → intent → requirement → design → implementation → test → validation. 이 세션은 intent 이하만 건드린다. Lab의 `PHILOSOPHY.md`, `MISSION.md`는 읽되 고치지 않는다.

## 1. 먼저 읽을 것 (이 순서로, 전부)

1. `.claude/hypeproof/ux/STATE.md` (재개 지점, 마지막 게이트 결과)
2. `docs/design/ux-principles-breakdown-2026-09-18.md` (원문 문장 → 층 → SX ID)
3. `docs/intents/studio-learning-experience.md` (INT-SX-00~10)
4. `docs/requirements/studio-learning-experience.md` (SX-01~60, 수용 기준)
5. `docs/design/studio-learning-experience.md` (정보 구조, 상태 기계, 세션 설계 파일, 이벤트, 토큰, 코드 변경 지도)
6. `docs/testing/studio-learning-experience.md` (SX-T, 층·명령, 부정 테스트)
7. `docs/plan/studio-learning-experience.md`와 `docs/plan/ux-dag.yaml` (실행 순서와 게이트; **순서는 DAG의 `depends_on`만이 정한다**)
8. `docs/PRODUCT-INTENT.md`, `docs/plan/vessel-and-modules.md` §1 (층 결정 규칙), `.claude/rules/verification.md`, `docs/AUTONOMY-MANDATE.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/skills/hype-pr/SKILL.md`
9. `docs/design/ui-philosophy-2026-09-18.md` (원문; 요구가 모호할 때 되돌아가는 곳)

원문과 파생 문서가 어긋나면 파생 문서를 고치고 `STATE.md`에 기록한다. 원문은 고치지 않는다.

## 2. 실행 원칙

- **DAG가 순서다.** `docs/plan/ux-dag.yaml`의 task를 `depends_on`이 풀리는 순서로만 집는다. 병렬 가능한 task는 서브에이전트에 나눠도 되지만 같은 파일을 두 에이전트가 동시에 고치지 않는다.
- **게이트 순서는 machine_gate → control → acceptance.** machine_gate가 빨간데 모델 평가를 돌리지 않는다. control(심어 둔 답)은 구현 **전에** 써 둔다.
- **평가자는 구현자와 다른 에이전트다.** 구현 서브에이전트가 자기 결과를 통과시키지 않는다. 평가 서브에이전트는 `.claude/evals/STUDIO_UX_EVAL.md` 루브릭으로 채점하고 `STATE.md`에 점수와 미달 항목을 남긴다. 통과선 미달이면 수정 루프(최대 3회) → 마지막에 적대적 진단 1회 → 마지막 시도 1회. 그래도 안 되면 그 task를 `blocked`로 표시하고 다음 독립 task로 간다.
- **계측기를 먼저 의심한다.** 실패는 `harness_fixable / harness_undecided / product / spec / flake`로 분류한다(`dag.yaml` 상단 정의). 2026-07의 9건 중 9건이 계측기 오류였다. `harness_undecided`와 `spec`은 사람 몫이다: 고치지 말고 `STATE.md`의 "사람에게 묻는 것"에 적고 다음 task로 간다.
- **문서는 계약이다.** 구현하다 요구가 틀렸다고 판단되면 요구를 조용히 바꾸지 않는다. `STATE.md`에 "요구 개정 제안"으로 적고, 구현은 현재 요구대로 한다. 예외: 오타·링크·명백한 모순은 고치고 기록한다.
- **층 규칙.** 로컬 자원이 필요하면 App, 데이터면 Module, 참가자 런타임 코드면 Service, 강사·운영이면 Surface. 6주 커리큘럼은 Module(세션 설계 파일)이다. 숫자 상수를 App에 박지 않는다.
- **측정 코어를 복제하지 않는다.** 관찰 이벤트·필드는 `worker/src/lib/measurement-core/`의 기존 계약을 확장한다. 제2 저장소, 제2 채점기, 새 점수는 만들지 않는다.
- **작업 중 화면에 숫자·등급·배지가 없다.** 이것은 취향이 아니라 SX-59, SX-T05, SX-T40의 계약이다. `assetStatusBar.ts`는 P0에서 지운다.
- **한국어 카피.** 학생 화면은 합니다체, 관찰 문장은 행동이 주어, 금지 라벨(개선 필요, 낮음/높음, 상위 N%, 역량 부족, AI 활용 고수, 성장 점수)은 lint로 막는다. 사람에 대한 "성장" 주장은 쓰지 않는다. 화면 이름은 "나의 변화 기록"이다.

## 3. 단계와 산출물

| 단계 | 내용 | 끝났다는 뜻 |
|---|---|---|
| P0 Curriculum-first | 세션 설계 파일 스키마 + 3주차 예시 파일, Mission header, 학생 홈("오늘의 작업"), Coach rail 재배치, Work canvas, `assetStatusBar` 제거, 디자인 토큰 | SX-T01, T05, T10~T19, T40, T45 machine gate 초록 + 평가 통과 + PR 1개 |
| P1 Evidence capture | 기대 조건·선택 이유·인터뷰/반응·변경 전후 저장, real/simulated 라벨, 완료 게이트, 재확인 게이트, 이벤트 8종 | SX-T02, T03, T04, T20~T29, T43, T44 초록 + PR 1개 |
| P2 Boundary reflection | 제출·세션 종료·주차 종료 회고("바뀐 생각 1개 + 다음 실험 1개"), 다음 과제에 추가, 기존 개선 행동 루프와 연결 | SX-T06, T30~T34, T41 초록 + PR 1개 |
| P3 변화 기록 (여유가 있을 때만) | 누적 패턴 + 근거 타임라인, 6개 점수는 접힘 | SX-T35~T39, T42 |
| P4, P5 | 강사 화면, 방법 레이어 | 이 세션의 범위 밖. 설계만 있다 |

PR은 단계마다 하나. 각 PR은 `hype-pr` 절차(`inspect` → assessment → `prepare` → `create --preparation --apply`)를 따르고, 본문에 다룬 SX ID, 실행한 SX-T와 결과, NOT RUN 목록, 실기 증거 경로를 적는다. 머지는 하지 않는다. 사람이 아침에 한다.

## 4. 시작 절차

1. `git status`, `git branch --show-current`, `git log --oneline -5`를 찍어 `STATE.md`의 "시작 상태"에 붙인다. 작업 트리가 더럽거나 `main`이 아니면 **먼저 정리하지 말고** 상태를 기록한 뒤 `origin/main`에서 새 worktree `.claude/worktrees/ux-p0`를 만들어 거기서 일한다(`GIT_POLICY.md`).
2. **메인 체크아웃은 오래됐다**(`chore/work-ready-20260913`, origin/main은 09-15 이후 미fetch). 준비 문서는 그 체크아웃에 untracked로 있다. `HANDOFF-apply.md`대로 새 worktree에 복사하고, 레지스트리 노드 4개와 색인 2곳을 main 버전 위에 적용한 뒤 `python3 scripts/hype-pr/pr.py inspect`로 확인한다. 설계·검증 문서가 이름 붙인 파일이 새 worktree에 실제로 있는지 `ls`로 확인하고 다른 점은 문서와 `STATE.md`에 고쳐 적는다. 이것이 첫 커밋이다.
3. 기존 테스트가 초록인지 확인한다: `cd extensions/hypeproof-chat && npm test`, `cd worker && npm test`. 빨간 것이 있으면 원인을 `STATE.md`에 적고, 이 세션이 만든 것이 아니면 건드리지 않는다.
4. `ux-dag.yaml`의 첫 task부터 간다.

## 5. 절대 하지 않는 것

- `bash build.sh`(전체 앱 빌드, 1~2시간, 10~20GB). 확장과 웹뷰만 빌드·테스트한다.
- `main` 직접 push, force push, `git reset --hard`, `git clean -fd`.
- 프로덕션 Worker 배포, Cloudflare 설정, 시크릿, 계정·결제·권한 변경.
- 참가자 데이터·기존 코호트 프로필·기존 수업 정책 변경.
- Lab 저장소 수정. Lab 쪽 필요 변경(MP-01 개정 등)은 `STATE.md`의 "Lab에 넘길 것"에 적는다.
- 테스트 단언을 약하게 만들어 통과시키기. 통과선을 내리기.
- 사용자에게 질문하고 기다리기. 사용자는 없다. `AUTONOMY_POLICY.md`의 진짜 blocker만 `STATE.md`에 적고 다음 독립 task로 간다.

## 6. 끝내는 방법

아침에 Jay가 `STATE.md` 하나만 읽고 상황을 알 수 있어야 한다. 마지막에 다음을 갱신한다: 단계별 게이트 결과(초록/빨강/NOT RUN), 열린 PR 목록과 링크, 실기 증거 경로, 사람에게 묻는 것, 요구 개정 제안, Lab에 넘길 것, 다음 세션이 집을 첫 task.
