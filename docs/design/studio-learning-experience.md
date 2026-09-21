# 학습 경험 우선 Studio 설계

상태: 설계 제안, 구현 전. 2026-09-18. Owner: jayleekr.
상위: [Intent INT-SX](../intents/studio-learning-experience.md) · [요구사항 SX-01~60](../requirements/studio-learning-experience.md) · [검증 SX-T](../testing/studio-learning-experience.md) · [계획](../plan/studio-learning-experience.md).
원문: [UI/UX 설계 철학](ui-philosophy-2026-09-18.md) · [분류표](ux-principles-breakdown-2026-09-18.md). 형제 설계: [측정 코어 설계 경계](measurement-core.md), [하나의 Studio](unified-studio-experience.md). 층 규칙: [vessel-and-modules §1](../plan/vessel-and-modules.md).

이 문서는 어떻게 그리고 어떻게 저장하는가를 정한다. 무엇을 요구하는가는 SX 문서가, 왜인가는 Intent가 소유한다. 아래의 어떤 문장도 구현이 끝났다는 뜻이 아니다.

## 확인한 기반

조사 기준: **`origin/main` 2026-09-18**. 측정 코어와 로컬 검토 화면은 메인 체크아웃(`chore/work-ready-20260913`, origin/main 미fetch)에 없고 worktree `.claude/worktrees/claude-1042`에만 있어 그쪽 파일을 읽었다. 그 뒤 GitHub API로 blob 해시를 대조했다: `StartPage.tsx`, `startPage.ts`, `extension.ts`, `chatPanelProvider.ts`, `ChatPanel.tsx`, `LocalReview.tsx`, `assetStatusBar.ts`, `measurement-core/local-record.ts`, `session-design.ts` 아홉 개 모두 **claude-1042 사본이 origin/main과 바이트 단위로 같다**(메인 체크아웃은 다섯 개가 다르다). 따라서 아래 표는 origin/main 기준이다. 구현 세션은 메인 체크아웃이 아니라 `origin/main`에서 뜬 새 worktree에서 다시 연다(verification.md 규칙 1).

| 영역 | 파일 | 확인한 사실 |
|---|---|---|
| 시작 화면 | `extensions/hypeproof-chat/webview-ui/src/StartPage.tsx`, `src/startPage.ts` | 진입은 "AI 체험하기 / 수업에 참여하기 / 이어서 하기". 참여 코드 → 프로필 확인 → candidate → `beginCourse` → 작업 폴더 커밋 → 채팅을 에디터에 연다. 상단 nav에 "내 작업 검토"(`openLocalReview`) 버튼이 있다. 점수·역량 표시는 없다 |
| 채팅 패널 | `webview-ui/src/App.tsx`, `ChatPanel.tsx`(1716줄) | 웹뷰 상태는 `useReducer` 하나. 헤더(코치 이름, 활동 변경, 대화 지우기, 설정) → `hps-activity-header`(활동 종류·이름) → `<details class="hps-lesson">`(수업 제목·목표·단계별 안내·힌트·확인 기준, "채팅에 과제 넣기" 버튼) → `NativeObservationPanel` → 메시지 목록 → 입력 영역(모델·effort 선택, 칩, 첨부). 수업 단계는 읽기 전용이며 진행 상태를 저장하지 않는다 |
| 채팅 호스트 | `src/chatPanelProvider.ts`(3457줄) | 턴마다 `NativeObservationRecorder`에 `user`/`tool_request`/`approval`/`tool_result`/`artifact`/`coach`/`turn_end`를 기록하고 `workspaceState` 키 `hps.observation.1.<scope>.<program>`에 저장한다. `onAssetScore` 콜백이 `AssetScoreSink.recordAssetScore`와 `streamAssetScore` 메시지를 동시에 부른다. `hasActiveStream()`이 활동 전환을 막는다 |
| 관찰 패널 | `webview-ui/src/NativeObservationPanel.tsx` | `<details>` "내 작업 돌아보기". 기록 건수, 산출물 첫/최근 저장본 비교, 동의 체크 뒤 `/observations/assess` 호출, 7자산 finding과 "내가 다르게 보는 점" 정정 입력 |
| 상태바 | `src/assetStatusBar.ts`, `src/assetStatus.ts` | 우측 상태바에 `$(graph) 7자산 N/7  ✓ Taste ◐ Intent …`를 띄우고 클릭하면 QuickPick 히스토그램(퍼센트)을 연다. `extension.ts:71`에서 생성해 `ChatPanelProvider`에 주입한다. 작업 중 항상 보인다 |
| 로컬 검토 | `webview-ui/src/LocalReview.tsx`, `src/localReviewPanel.ts`, `localReviewProtocol.ts`, `localReviewService.ts` | 별도 웹뷰 패널(`data-surface="local-review"`). 트랜스크립트 가져오기 → 목적 확인 → 6역량 finding별 confirm/correct/dispute/exclude/hold 검토 → "다음 작업에서 바꿀 행동 하나"(Improvement) → 이전 행동의 시도 여부·관찰 결과(follow_up) → 미리보기·로컬 제출·영수증. 저장소는 `globalStorage/local-review-v1` |
| 측정 코어 | `worker/src/lib/measurement-core/` 7개 파일 | `hps-observation/1`(`legacy-observation.ts`: 8 kind, 키 allowlist 검증, 7자산 finding 검증), `hps-interpretation/1`(`interpretation.ts`: 점수 키 거부, VERIFY는 요청·결과·sha256 결합 필수), `hps-local-record/1`(`local-record.ts`: Task/Review/Submission/Receipt/Improvement, StoragePort 주입, 삭제 전파), 역량 모델 2개(`capability-models.ts`: candidate-capability-v1, legacy-seven-assets), `evidence.ts`, `normalize.ts`(EventEnvelope) |
| 세션 설계 | `worker/src/lib/session-design.ts`, `chalk/src/ui/authoring.html` | 스키마 `hps-session-design/1`: title, audience, duration_minutes, objective, prerequisites, starter, steps[{id,title,instructions,hint,acceptance,help?}], assistant?, model?, features?. 키 allowlist가 엄격해 모르는 키는 저장 거부. Chalk `/authoring`이 같은 필드를 편집하고 `m2026.09.18-N` 형식으로 동결한다. 도움 방식 `lesson-help-mode.ts`: demonstrate/hint/co_edit/independent |
| 프로필 | `src/protocol.ts` `ResolvedProfile` | `lesson`(동결 수업 사본), `observation{format,scope}`, `assets_focus`, `minor_cohort`, `sdk_tools`, `coach_runtime`이 서비스에서 온다. `AssetScoreChunk`(`heuristic-v1`)는 SSE 청크 타입으로 남아 있다 |
| 스타일 | `webview-ui/src/styles.css`(1277줄), `start.css`(386줄), `localReview.css` | `styles.css`는 `--vscode-*` 변수와 하드코딩 fallback. `start.css`만 `--studio-bg #151D19`, `--studio-panel #202C24`, `--studio-text #F2F4E8`, `--studio-accent #D5F279` 토큰을 가진다. `localReview.css`는 vscode 변수만 쓴다. 공용 토큰 파일은 없다 |
| 프리뷰·캔버스 | `src/previewProvider.ts`, `liveServer.ts` | 존재는 확인했으나 내용은 읽지 않았다(미확인). 이 문서는 캔버스를 VS Code 에디터 그룹 + 기존 프리뷰 웹뷰로 가정한다 |
| 강사 역할 | `worker/src/lib/tokens.ts`, `instructor-auth.ts`, `chalk/src/shared.ts`, `chalk/src/ui/{board,console,manage,sharing,issuer}.html` | **있다.** 토큰 payload에 `role?: "student" \| "issuer"`와 `scopes?: IssuerScope[]`가 있고, `instructor-auth.ts`가 유일한 검증 구현이다(Service는 쓰기, Chalk는 읽기로 같은 함수 객체를 재사용하며 `chalk/test/instructor-auth-drift.test.mjs`가 두 워커의 판정 일치를 검사한다). Chalk에 강사 화면 5종이 이미 있다. 분류표에 적었던 "roles: admin/creator/spectator"는 Lab 멤버 DB의 역할이고 Studio와 무관했다. **P4가 없어서 기다리는 것은 역할이 아니라 (1) 학습 근거를 issuer 범위로 내보내는 조회 경로와 (2) 학생의 공유 범위 선택(MC-39)이다** |

## 정보 구조

여섯 영역이 있다. 학습 정보(A), 작업 공간(C), 근거 기록(D)은 같은 컨테이너에 섞지 않는다(SX-05). 실제 창에서 A·B·D·E는 채팅 웹뷰(`hps-shell`) 안의 구획이고, C는 VS Code 에디터 그룹과 프리뷰다. F는 별도 웹뷰 패널이다.

| 영역 | 보여 주는 것 | 기본 노출 | 자라 나오는 곳 / 대체 | 상태 소유 |
|---|---|---|---|---|
| A Mission header | 주차, 미션 한 문장, 완료 조건 진행(아이콘+문구), 남은 단계, 현재 단계의 다음 행동 1개, "변화 기록" 작은 링크 | 항상. 스크롤에 고정 | `hps-activity-header`와 `<details class="hps-lesson">`를 합쳐 대체한다. 활동 이름은 헤더 안 작은 줄로 내려간다 | 호스트: 세션 설계(프로필 `lesson`) + Task.curriculum. 웹뷰: 렌더만 |
| B Coach rail | 코치 대화, 질문·힌트·체크리스트, 학생 요청, 도움 방식 선택, 강사 메시지(P4) | 작업 중 | `ChatPanel`의 메시지 목록·입력 영역이 그대로 rail이 된다. 칩·세상 스트립·러너 등 코호트별 UI는 유지 | 호스트: 스트림, 관찰 기록. 워커: 프롬프트에 미션·현재 단계·완료 조건·`never` 목록 주입(도움 방식 주입과 같은 자리) |
| C Work canvas | 에디터, 프리뷰, 테스트 실행, 자료·문서 | 작업 중 | 기존 에디터 그룹 + `previewProvider`/`liveServer`. 새 웹뷰를 만들지 않는다 | 호스트 |
| D Evidence drawer | 기대 조건, 발견한 차이, 변경 전후(sha256 두 개와 본문 비교), 출처(provenance, source_state 라벨), 선택 이유 | 필요 시. 접힌 하단 서랍, 단계 `ui`가 요구하면 자동으로 열림 | `NativeObservationPanel`을 대체한다. "평가에 보낼 기록 보기"·"관찰 받기"는 F의 접힌 세부 데이터로 이동 | 호스트: `LocalRecord` 관찰 기록. 웹뷰: 입력 폼과 열림 상태 |
| E Reflection | 바뀐 생각 1개 + 다음 실험 1개 | 제출·세션 종료·주차 종료에서만. 팝업 없음, B 자리에 inline 카드 | `LocalReview`의 `ImprovementReview`(개선 행동 하나, 이전 행동 시도 여부)가 옮겨 온다 | 호스트가 표시 조건 결정(상태 기계). 웹뷰는 조건을 계산하지 않는다 |
| F 변화 기록 | 최근 발견한 변화, 아직 드물게 본 행동, 다음 실험, 근거 타임라인, 방법/세부 데이터(접힘) | 주차·프로그램 단위. A와 시작 화면의 작은 링크로 진입 | `LocalReview.tsx`가 F로 개편된다(`data-surface="growth"`). 6역량 finding 그리드는 접힌 세부 데이터가 된다 | 호스트: `LocalRecord` 전체 읽기. 코어: 순수 함수 `growthStory()` |

내부 개념명은 growth story, UI 이름은 "변화 기록"이다(분류표 §6 결정).

호스트 · 웹뷰 · 워커의 경계:

- 확장 호스트가 진실을 갖는다. Task.curriculum(단계·phase), 관찰 이벤트, 게이트 판정, 회고 표시 조건은 모두 호스트에서 `measurement-core`의 순수 함수로 계산해 `config`/`learningState` 메시지로 내려보낸다.
- 웹뷰는 보기 상태만 가진다. 입력 초안, 서랍 열림, 스크롤. 게이트를 웹뷰에서 다시 계산하지 않는다. CTA 비활성은 호스트가 보낸 `gates.complete.ok`를 그대로 그린다.
- 워커(Service)는 동결 세션 설계를 전달하고 코치 프롬프트를 조립한다. P0~P3에서 학습 이벤트는 워커로 가지 않는다(로컬 기록만, MC-24). 원격 제출은 MC-39 이후다.

데스크톱(1280px 이상, 에디터 그룹 + 웹뷰 두 열):

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ A  3주차 · AI가 만든 걸 내가 확인했나?    ☐ 기대 조건 적기 ☐ 직접 시험 ☐ 재확인 │
│    다음 행동: 기대 조건 적기                    남은 단계 5     변화 기록 › │
├──────────────────────────────────────┬─────────────────────────────────────┤
│ C  Work canvas                       │ B  Coach rail                       │
│    index.html  │  미리보기            │    코치: 직접 써보기 전에, 어떤 결과여야│
│                │                     │    맞다고 볼지 먼저 정해볼까요?        │
│                │                     │    도움 방식 · 힌트 받기 ▾            │
│                │                     │    [ 메시지 입력              ] 보내기 │
│                                      ├─────────────────────────────────────┤
│                                      │ D  근거 ▲  기대 조건 · 차이 · 전후 · 출처│
└──────────────────────────────────────┴─────────────────────────────────────┘
  E 회고: 제출 뒤 B 상단에 inline 카드. F 변화 기록: 별도 탭(Paper).
```

좁은 폭(720px 이하, 웹뷰가 사이드바에 있을 때):

```text
┌──────────────────────────┐
│ A 3주차 · 미션 한 문장      │
│   다음 행동: 기대 조건 적기  │
│   ☐☐☐  남은 단계 5         │
├──────────────────────────┤
│ B 코치 대화                │
│   …                      │
│   [입력]            보내기 │
├──────────────────────────┤
│ D 근거 ▲ (접힘)            │
└──────────────────────────┘
  C는 에디터 영역(웹뷰 밖). A는 sticky, D는 열면 B 위로 시트처럼 올라온다.
```

## 과제 흐름 상태 기계

한 Task는 세션 설계 파일 하나(한 주차)에 대응한다. 단계는 그 안의 `steps`다. Task의 학습 단계는 `Task.curriculum.phase`에, 작업 상태는 기존 `Task.status`(open/paused/completed/abandoned)에 둔다. 두 축을 합치지 않는다(MC-23).

```text
과제(assigned) ──첫 이벤트 또는 첫 턴──▶ 실행(working)
                                        │  "다음으로": current_step 이동
                                        │  단계 gate 미충족이면 제자리
                                        ▼
                         완료 게이트 통과 후 "완료" ──▶ 제출(submitted)
                                        ▼
                    E 카드 작성(바뀐 생각 1 + 다음 실험 1) ──▶ 회고(reflected)
                                        ▼
        Task.status=completed · Improvement 저장 · 다음 주차 Task 생성(carry_in)
```

전이 규칙:

| 전이 | 조건 | 기록 |
|---|---|---|
| assigned → working | 첫 학습 이벤트 또는 첫 코치 턴 | `history: phase:working` |
| working, 단계 이동 | "다음으로". 단계에 `gate`가 있으면 그 이벤트가 actor=user로 존재해야 한다. 이전 단계로 돌아가기는 항상 허용(SX-16) | `history: step:<id>:entered`, `curriculum.current_step` |
| working → submitted | 완료 게이트 통과 + 학생이 "완료" 누름 | `curriculum.submitted_at`, `history: phase:submitted` |
| submitted → reflected | `reflection_submitted` 이벤트 기록 | `history: phase:reflected`, `Task.status=completed`(by user) |
| reflected → 다음 과제 | 다음 주차 세션 설계가 프로필에 있으면 새 Task 생성. 없으면 "다음 주차 준비 중" 상태로 머문다 | 새 Task `curriculum.carry_in = <Improvement id>` |
| 어느 상태 → paused/abandoned | 기존 `setTaskStatus` | 기존 history |

완료 게이트(SX-14). 호스트가 다음을 모두 만족할 때만 `gates.complete.ok=true`를 보낸다.

1. 세션 설계 `learning.completion[]`의 각 항목이 가리키는 이벤트 kind가 이 Task에 actor=user, `student_text` 비어 있지 않은 상태로 1건 이상 있다.
2. 이 Task에 `artifact` 이벤트(AI가 만든 결과물)가 있으면 `criterion_set`이 그 artifact보다 먼저이거나 적어도 `test_observed`보다 먼저다.
3. 미충족이면 CTA는 비활성이고 옆에 "☐ 기대 조건을 먼저 적어요"처럼 부족한 항목을 아이콘+문구로 보여 준다. 우회 버튼은 없다.

재확인 게이트(SX-15). `change_requested` 뒤에 `retest_confirmed`가 와야 검증이 기록된다.

1. `retest_confirmed.criterion_ref`가 같은 Task의 `criterion_set` 이벤트 id와 같다.
2. `retest_confirmed.artifact_after`가 `change_requested` 이후에 기록된 최신 `artifact.sha256`과 같다.
3. `result_ref`가 있으면 `resolveVerification()`(interpretation.ts)의 규칙대로 요청·결과 이벤트가 그 sha256에 결합돼 있어야 `source_state=real`이 된다. 없으면 `self_reported`로 남는다.
4. 조건 하나라도 빠지면 D 서랍의 검증 줄은 "아직 같은 조건으로 다시 확인하지 않음"이고, 해석에서 VERIFY는 observed가 될 수 없다(기존 `missing_execution_evidence`와 같은 경로).

저장. `hps-local-record/1`의 `Task`를 확장한다(`worker/src/lib/measurement-core/local-record.ts`). 새 record kind를 만들지 않는다.

```ts
curriculum?: {
  module: { course_id: string; version: string; sha256: string };  // 프로필 lesson에서 복사
  week: number;
  phase: "assigned" | "working" | "submitted" | "reflected";
  current_step: string;
  steps: Record<string, { entered_at: number; left_at?: number }>;
  submitted_at?: number;
  carry_in?: string;   // 이전 Task의 Improvement id
}
```

`curriculum` 변경은 모두 `saveTask` + `history` 항목으로 남는다. 게이트 결과는 저장하지 않고 매번 관찰 이벤트에서 계산한다. 저장된 값과 계산된 값이 갈라지는 길을 두지 않는다.

Task id는 `task-<module sha256 앞 16자>-<activity id 앞 8자>`로 만들고 `linkSession`으로 호스트 세션을 잇는다. 같은 폴더라는 이유로 합치지 않는다(MC-08).

## 세션 설계 파일 (Module)

6주 커리큘럼은 코드가 아니라 Module 층 데이터다(SX-56, vessel-and-modules §1). Chalk에 이미 `hps-session-design/1`이 있으므로 **그 스키마를 확장한다.** 두 번째 포맷을 만들지 않는다. 확장 방식은 선택 키 추가다. 키가 없으면 오늘의 동작과 같고, 있으면 A·D·E가 그 값을 읽는다. `session-design.ts`의 `OPTIONAL_KEYS`에 `learning`을, 단계 allowlist에 `ui`·`evidence`·`gate`를 더한다. 스키마 id는 올리지 않는다. 필수 키가 바뀌는 날에만 `/2`를 연다.

3주차(Underlying Magic) 예시. 내용은 원문 §6의 GlobalBuddy 행에서 가져왔다.

```json
{
  "schema": "hps-session-design/1",
  "title": "3주차 · Underlying Magic",
  "audience": "국제고 2학년 · GlobalBuddy 팀",
  "duration_minutes": 120,
  "objective": "AI가 만든 결과를 내가 확인했는가?",
  "prerequisites": "2주차 value statement, GlobalBuddy V1 초안 폴더",
  "starter": "globalbuddy-v1/ (2주차 산출물 사본, 원본 보존)",
  "learning": {
    "week": 3,
    "mission": "AI가 만든 걸 내가 확인했나?",
    "completion": [
      { "id": "c1", "text": "기대 조건을 시험 전에 적었다", "event": "criterion_set" },
      { "id": "c2", "text": "발견한 차이를 근거로 수정을 요청했다", "event": "change_requested" },
      { "id": "c3", "text": "같은 조건으로 다시 확인했다", "event": "retest_confirmed" }
    ],
    "observe": [
      "기대 조건을 먼저 정하는가",
      "오류를 근거로 설명하는가",
      "같은 조건으로 다시 확인하는가"
    ],
    "never": [
      "측정을 위해 고의 오류를 추가하지 않는다. 실제 제작 과정에서 생긴 결과를 확인하는 것이 기본이다"
    ],
    "evidence_types": ["criterion", "action", "change", "decision"],
    "source_kinds": ["policy", "test"],
    "reflection": { "changed_mind": true, "next_experiment": true }
  },
  "steps": [
    { "id": "expect", "title": "기대 조건", "instructions": "GlobalBuddy V1의 수업·행정 정보가 어떤 상태여야 맞다고 볼지 적는다.", "hint": "학교 규정 원문 어디와 대조할지 먼저 정하면 쉽다.", "acceptance": "기대 조건이 학생의 말로 1개 이상 적혀 있다.", "ui": "criterion_form", "evidence": "criterion", "gate": "criterion_set", "help": { "default": "hint", "allowed": ["hint", "independent"] } },
    { "id": "build", "title": "Build pane", "instructions": "V1을 코치와 함께 만들거나 이어서 고친다.", "hint": "", "acceptance": "실행 가능한 V1이 작업 폴더에 있다.", "ui": "canvas_editor", "help": { "default": "co_edit", "allowed": ["hint", "co_edit"] } },
    { "id": "test", "title": "Preview / Test", "instructions": "기대 조건대로 직접 써 보고 실제 규정과 대조한다.", "hint": "", "acceptance": "기대 조건마다 맞음/다름을 기록했다.", "ui": "canvas_preview", "evidence": "action", "gate": "test_observed" },
    { "id": "diff", "title": "발견한 차이", "instructions": "기대와 다른 점을 근거와 함께 적는다.", "hint": "규정 몇 조, 화면 어느 줄인지 남긴다.", "acceptance": "차이 1개 이상에 출처가 붙어 있다.", "ui": "evidence_note", "evidence": "action" },
    { "id": "fix", "title": "수정 요청", "instructions": "발견한 차이를 근거로 코치에게 수정을 요청한다.", "hint": "", "acceptance": "요청 문장에 차이와 기대 조건이 들어 있다.", "ui": "coach_request", "evidence": "change", "gate": "change_requested" },
    { "id": "retest", "title": "재검증", "instructions": "같은 기대 조건으로 다시 확인한다.", "hint": "", "acceptance": "재확인 결과가 기대 조건에 연결돼 있다.", "ui": "canvas_preview", "evidence": "action", "gate": "retest_confirmed" }
  ],
  "assistant": { "display_name": "코치" }
}
```

키 의미:

| 키 | 값 | 읽는 곳 |
|---|---|---|
| `learning.week`, `learning.mission` | 정수, 한 문장 | A |
| `learning.completion[].event` | §관측 이벤트의 kind 중 하나 | 완료 게이트, A의 체크 목록 |
| `learning.observe[]` | 관찰 항목 문장 | 학생에게 보이지 않는다. F의 방법/세부 데이터와 해석 프롬프트 |
| `learning.never[]` | 절대 하지 않을 것 | 코치 프롬프트 주입, SX-58 부정 테스트 |
| `learning.evidence_types[]`, `source_kinds[]` | D 폼의 선택지 | D |
| `learning.reflection` | E에 어떤 칸을 보일지 | E |
| `steps[].ui` | `canvas_editor` `canvas_preview` `criterion_form` `evidence_note` `coach_request` `decision_form` `metric_board` | A의 다음 행동 문구, D 자동 열림, B 기본 도움 방식 |
| `steps[].evidence` | SX-18의 6종 중 하나 | D 폼 기본값 |
| `steps[].gate` | 이벤트 kind | "다음으로" 차단 조건 |

Chalk 쪽 변경은 `chalk/src/ui/authoring.html`의 필드 추가(주차·미션·완료 조건·관찰 항목·금지 목록, 단계별 ui/evidence/gate 선택)와 `session-design.ts` 검증뿐이다. 첫 파일 6개는 `worker/test/fixtures/session-design/week-1..6.json`에 예시 데이터로 두고 Chalk로 가져오기(`hps-authoring-batch/1`)한다. 4주차 `metric_board`와 6주차 Metric board만 숫자 카드를 쓴다(SX-51).

## 관측 이벤트와 필드

원문 §15의 필드 7개와 이벤트 8개를 `hps-observation/1` 위에 얹는다(SX-48). 제2 저장소·제2 채점기는 없다. 저장은 기존 `NativeObservationRecorder` → `LocalRecord.appendObservations()` 경로다.

포맷 버전. `hps-observation/1`의 검증기는 kind와 키 allowlist가 닫혀 있고 legacy verdict fixture(MC-T01)에 고정돼 있다. 그래서 `/1`은 손대지 않고 **`hps-observation/2`를 같은 파일에서 상위 집합으로 받는다.** `validateObservation()`은 `format`을 보고 `/1` 규칙 또는 `/1 + 아래 규칙`을 적용한다. `/1` 배치는 그대로 유효하고, `/2` 배치를 `/1`로 강등하지 않는다. 프로필 `observation.format`이 어느 쪽을 쓸지 정한다.

새 이벤트 kind 8개와 필드:

| kind | actor 기본 | 필수 필드 | evidence_type | source_state 기본 | 만드는 곳 |
|---|---|---|---|---|---|
| `problem_committed` | `user` | `student_text`, `context` | intent | `self_reported` | D 폼(1주차 ui `evidence_note`) |
| `criterion_set` | `user` | `student_text`, `context` | criterion | `self_reported` | D `criterion_form` |
| `test_observed` | `user` | `criterion_ref`, `artifact_after`, `outcome`(`match`/`mismatch`/`unknown`) | action | `real`(result_ref 결합 시) / `self_reported` | 프리뷰·도구 결과에서 학생이 "확인함" 누를 때 |
| `change_requested` | `user` | `student_text`, `criterion_ref`, `artifact_before`, `turn_ref` | change | `self_reported` | D `coach_request`. 같은 문장이 `user` 이벤트로도 남고 `turn_ref`로 잇는다 |
| `retest_confirmed` | `user` | `criterion_ref`, `artifact_after`, `outcome` | action | `real`(result_ref 결합 시) / `self_reported` | 재검증 게이트 |
| `external_feedback_received` | `external_user` | `student_text`(인용), `provenance{who,when,where}`, `source_state`(입력 시 선택, 기본값 없음) | 단계 `evidence`에 따름 | 학생이 고른 값 그대로. `real`을 기본으로 채우지 않는다 | D 폼 |
| `decision_revised` | `user` | `student_text`(이유), `decision{from,to}`, `evidence_refs[]` | decision | `self_reported` | D `decision_form` |
| `reflection_submitted` | `user` | `student_text`(바뀐 생각), `next_experiment` | ownership | `self_reported` | E 카드. 같은 턴에 `Improvement`도 저장 |

`/2`에서 이벤트에 허용되는 추가 키와 기본값:

| 필드 | 값 | 기본값 | 비고 |
|---|---|---|---|
| `actor` | `user` \| `ai` \| `teacher` \| `external_user` \| `policy` | 학습 kind는 필수. 기존 kind는 `/1`과 같다 | `user`는 학생 본인이다. `/1`의 값을 유지해 재매핑을 피한다. 화면 라벨은 "학생" |
| `context` | `{ week, step_id, task, module_version }` | 학습 kind는 필수 | Task.curriculum에서 호스트가 채운다 |
| `evidence_type` | `intent` \| `criterion` \| `action` \| `decision` \| `change` \| `ownership` | 학습 kind는 필수 | SX-18 |
| `source_kind` | `link` \| `article` \| `policy` \| `interview` \| `test` \| `none` | `none` | SX-22 |
| `source_state` | `real` \| `simulated` \| `self_reported` \| `unverified` | kind별 표 참조. 저장 후 불변 | SX-46. 정정은 새 `correction` 이벤트로 |
| `student_text` | 문자열 2000자 이하 | 없음 | `actor=user`일 때만 허용. 아래 규칙 |
| `artifact_before`, `artifact_after` | 기존 `artifact` 이벤트의 sha256 | 없음 | 같은 배치에 그 artifact가 있어야 한다(`unknown_artifact`) |
| `criterion_ref`, `turn_ref`, `result_ref`, `evidence_refs[]` | 이벤트 id | 없음 | 존재하지 않는 id는 `orphan_ref` |
| `provenance` | `{ who, when, where }` | 없음 | `external_feedback_received` 필수 |
| `teacher_state` | `unreviewed` \| `confirmed` \| `disputed` | `unreviewed` | 이벤트에 저장하지 않는다. 아래 참조 |

teacher_state는 이벤트를 고쳐서 바꾸지 않는다. 관찰은 append-only다. `hps-local-record/1`에 `Review`와 같은 모양의 `teacher_review` record(`reviews/<task>/teacher/<event id>/<n>`, `by: "teacher"`, `action: confirmed | disputed`)를 두고, 읽을 때 최신 record가 없으면 `unreviewed`로 계산한다. P4 전에는 enum과 기본값만 있고 쓰는 경로가 없다.

AI가 쓴 글은 학생 행동으로 기록되지 않는다(SX-45). 검증기 규칙으로 고정한다.

1. `student_text`는 `actor=user`인 이벤트에만 있을 수 있다. 다른 actor에 있으면 `ai_text_as_student` 거부.
2. 학습 kind 이벤트는 웹뷰 폼 제출을 받은 호스트 핸들러만 만든다. 코치 스트림 콜백(`onAssetScore`, `recordObservation('coach', …)`)은 학습 kind를 만들 수 없다. 호스트에서 `recordLearningEvent()`는 `sender: "webview-form"`일 때만 열린다.
3. `interpretation.ts`의 human 판정을 확장한다. 오늘은 `kind ∈ {user, correction}`이 human이다. `/2`에서는 여기에 `actor=user`인 학습 kind가 더해진다. `actor=ai`는 어떤 kind든 human이 아니다.
4. 코치가 제안한 기대 조건을 학생이 그대로 채택해도, `criterion_set`의 `student_text`는 학생이 폼에서 제출한 문자열이고 `source: "ai_proposed"`가 아니라 `adopted_from: <coach event id>`가 붙는다. 해석은 이 표시를 보고 `insufficient_evidence`로 둘 수 있다.

바꾸는 파일:

- `worker/src/lib/measurement-core/legacy-observation.ts`: `OBSERVATION_FORMATS = ["hps-observation/1","hps-observation/2"]`, `/2` 분기의 kind·키·참조 검증. `/1` 경로와 fixture는 바이트 단위로 유지.
- `worker/src/lib/measurement-core/learning-events.ts`(신규): kind·enum·kind별 필수 필드 표, `gates()`(완료·재확인), `nextStep()`. 순수 함수. `index.ts`에서 export.
- `worker/src/lib/measurement-core/interpretation.ts`: human 판정 확장, `adopted_from` 인지.
- `worker/src/lib/measurement-core/local-record.ts`: `Task.curriculum`, `teacher_review` record.
- `worker/src/lib/measurement-core/normalize.ts`: `/2`의 `source_namespace = "studio/hps-observation/2"`.
- `worker/test/fixtures/measurement-core/`: `/2` 유효·무효 fixture(AI text as student, orphan ref, stale artifact, source_state 누락).
- `extensions/hypeproof-chat/src/nativeObservationRecorder.ts`, `chatPanelProvider.ts`: `recordLearningEvent()`, artifact sha256 결합, 게이트 계산 후 `learningState` 전송.
- `extensions/hypeproof-chat/src/protocol.ts`: 웹뷰→호스트 `learningEvent`, `nextStep`, `submitTask`, `submitReflection`; 호스트→웹뷰 `learningState{ mission, steps, current_step, gates, drawer }`.

## 디자인 시스템

토큰은 새 파일 `extensions/hypeproof-chat/webview-ui/src/tokens.css`에 CSS custom property로 두고 `main.tsx`가 가장 먼저 import한다. 값의 정본은 이 파일이고, 원문 §14는 출처다.

```css
:root {
  --hp-bg: #151D19;       /* Deep forest · 앱 배경, 집중 모드, 코치 rail 외곽 */
  --hp-panel: #202C24;    /* Panel · 미션 카드, 근거 서랍, 보조 패널 */
  --hp-accent: #D5F279;   /* Lime · Primary CTA 1개, 현재 단계 표시 */
  --hp-warn: #E6A373;     /* Amber · 주의, 보류, 확인 필요, 실제/가상 혼동 */
  --hp-ink: #F2F4E8;      /* Ink light · 어두운 면 위 제목·본문 */
  --hp-paper: #F4F6F0;    /* Paper · 회고, 변화 기록, 보고서 */
  --hp-ink-on-paper: #151D19;
  --hp-ink-on-accent: #18231C;   /* start.css .studio-primary가 이미 쓰는 값 */
  --hp-line: #35483A;            /* start.css --studio-line */
  --hp-muted: #ACB9A5;           /* start.css --studio-muted · AI 설명, 보조 문구 */
}
[data-surface="growth"], .hp-reflection {
  --hp-bg: var(--hp-paper);
  --hp-panel: #FFFFFF;
  --hp-ink: var(--hp-ink-on-paper);
  --hp-muted: #4B5A4F;
  --hp-line: #D7DDD2;
}
```

역할 규칙:

| 규칙 | 적용 |
|---|---|
| 한 화면 Primary CTA 1개(SX-04) | `.hp-cta-primary`는 `--hp-accent` 배경 + `--hp-ink-on-accent`. A의 "다음 행동" 버튼 또는 완료 버튼 중 하나만 이 클래스를 가진다. B의 보내기, D의 저장은 `.hp-cta-secondary`(투명 배경, `--hp-line` 테두리) |
| 상태는 아이콘+문구(SX-50) | 완료 조건 `☐/☑ 문구`, 게이트 차단 `⚠ 기대 조건을 먼저 적어요`, source_state `● 실제 / ◌ 가상 / ◐ 자기 보고 / ? 미확인` + 라벨. 색만 바꾸는 상태 표시는 없다 |
| 학습 화면에 숫자 카드 없음(SX-51) | `.hp-stat`는 단계 `ui: metric_board`(4·6주차) 안에서만 렌더한다. A·B·D·E에는 카운트 배지가 없다. "남은 단계 5"는 문장이지 카드가 아니다 |
| 모달보다 inline(SX-52) | E는 카드, D는 서랍, 게이트 안내는 CTA 옆 문구. `showInformationMessage`류 모달은 파괴적 조작(삭제)에만 남긴다 |
| 학생 글이 AI 글보다 위(SX-53) | `.hp-student-text`: `--hp-ink`, 16px, 좌측 3px `--hp-accent` 선, 라벨 "내가 쓴 것". `.hp-ai-text`: `--hp-muted`, 14px, 라벨 "AI가 만든 것". 같은 블록에 둘이 있으면 학생 글이 먼저 온다 |
| 작업 화면은 저대비, 회고는 Paper(SX-54) | 작업 중 표면은 `--hp-bg`/`--hp-panel`에 `--hp-ink` 본문, 강조는 accent 한 곳. E와 F는 `data-surface="growth"` 토큰으로 Paper 전환 |
| 실제/AI 예시 라벨·색 분리(SX-12) | 외부 반응 인용은 `--hp-ink` + "실제 반응", AI 예시는 `--hp-muted` + "AI 예시". 색이 같아도 라벨이 갈린다 |

대비. 상대 휘도로 계산한 근사값이며 구현 시 검사 도구로 다시 확인한다.

| 조합 | 근사 대비 | 판정 |
|---|---|---|
| Ink light on Deep forest | 14:1 | 본문 가능 |
| Ink light on Panel | 12:1 | 본문 가능 |
| Lime on Deep forest | 14:1 | 작은 글자 가능. 그러나 accent는 CTA와 현재 단계에만 쓴다 |
| Ink-on-accent on Lime | 13:1 | CTA 글자 |
| Amber on Deep forest | 7.7:1 | 경고 문구 가능 |
| Amber on Panel | 6.6:1 | 경고 문구 가능 |
| Amber on Paper | 2.0:1 | 글자로 쓰지 않는다. Paper에서는 아이콘·테두리 + `--hp-ink-on-paper` 문구 |
| Ink-on-paper on Paper | 17:1 | 본문 가능 |

기존 스타일 이행:

- `start.css`: `--studio-*` 변수를 `--hp-*`의 별칭으로 바꾼다(`--studio-bg: var(--hp-bg)`). 선택자는 유지. 시작 화면 nav의 "내 작업 검토"는 "변화 기록"으로 이름을 바꾸고 `openGrowth`를 보낸다.
- `styles.css`: 한 번에 갈아엎지 않는다. 각 영역을 다시 만들 때 그 블록만 `--hp-*`로 옮긴다. P0에서 `hps-header`, `hps-activity-header`, `hps-lesson` 블록이 `hp-mission` 블록으로 대체된다. P1에서 `hps-native-observation`, `hps-observation-compare`가 `hp-drawer`로 대체된다. 코호트 전용 블록(`hps-worlds`, `hps-runner`, `hps-naming`)은 손대지 않는다. `--vscode-*` fallback은 학습 화면 밖(설정, 오류 배너)에 남는다.
- `localReview.css`: `growth.css`로 이름을 바꾸고 Paper 토큰을 쓴다. `capability-grid`는 `<details>` 안으로 들어간다.
- `assetStatusBar.ts`와 `assetStatus.ts`는 삭제한다(SX-59). `extension.ts:71`의 생성, `ChatPanelProvider` 생성자의 `assetScores` 인자, `onAssetScore`의 `recordAssetScore` 호출, `streamAssetScore` 호스트 메시지, `App.tsx`의 `assetScore` 상태와 액션, `hypeproof-chat.showAssetHistogram` 명령이 함께 나간다. `AssetScoreChunk` 타입은 프록시 SSE 파서가 `asset_score` 청크를 읽고 버릴 수 있도록 `protocol.ts`에 남긴다. 워커가 청크를 그만 보내는 것은 별도 Service 변경이다.

## 변화 기록 화면

F는 `LocalReview.tsx`를 개편한 별도 웹뷰 패널이다. 표면은 Paper. 첫 화면에 숫자가 없다(SX-30).

```text
┌ 변화 기록 · GlobalBuddy ───────────────────────────────── Paper ┐
│ 1 최근 발견한 변화                                                 │
│   확인한 뒤 생각을 바꾸는 행동이 최근 반복된 패턴으로 관찰됨          │
│   근거 › 3주차 재검증(규정 §4 대조) · 4주차 가격 결정 변경 · 5주차 …  │
│ 2 아직 드물게 본 행동                                              │
│   중요한 결정 전에 대안을 비교한 장면은 최근 과제 중 한 번 관찰됨      │
│ 3 다음 실험                                                       │
│   다음 결정에서 선택지 2개를 먼저 적기      [다음 과제에 추가됨 ☑]     │
│ 4 근거 타임라인                                                    │
│   ● 실제  인터뷰(민서, 9/12) · ◐ 자기 보고  기대 조건 · ● 실제  재확인 │
│ ▸ 5 방법 / 세부 데이터                                             │
│   관찰 기준(candidate-capability-v1 r1) · 데이터 범위 · 역량별 발견   │
└──────────────────────────────────────────────────────────────────┘
```

우선순위 5개(원문 §12)와 데이터 출처:

| 순위 | 내용 | 읽는 데이터 | 규칙 |
|---|---|---|---|
| 1 | 최근 발견한 변화 + 근거 2~3개 | 여러 Task의 학습 이벤트와 해석 finding(`review=confirmed` 우선) | 같은 capability_model id·revision, definition_revision, rubric, evaluator 아래 2개 이상 Task에서 반복될 때만 "최근 반복된 패턴". 아니면 "아직 충분히 보지 못함"(SX-31, 분류표 §6 결정). 문장은 SX-36 라벨만 쓴다 |
| 2 | 아직 드물게 본 행동 | 세션 설계 `learning.observe[]`에 있으나 이벤트가 1건 이하인 항목 | "0"이나 "부족"이라 쓰지 않는다 |
| 3 | 다음 실험 | `Improvement`(choice=selected) 최신 1건 | E에서 저장한 것. 다음 Task의 `carry_in`과 연결돼 있으면 "다음 과제에 추가됨"(SX-28) |
| 4 | 근거 타임라인 | 학습 이벤트 시간순. source_state 아이콘+라벨 | 클릭하면 이벤트 원문(`student_text`, 인용, artifact 전후)이 열린다(SX-32) |
| 5 | 방법/세부 데이터(접힘) | 해석 `versions`, `gaps`, 역량별 finding 카드, 관찰 건수 | 여기만 숫자가 있을 수 있다. 오늘 `LocalReview`의 `capability-grid`와 "관찰 요약"이 이 안으로 들어간다 |

패턴 계산은 `worker/src/lib/measurement-core/growth-story.ts`(신규, 순수 함수)가 한다. 입력은 `LocalRecord.records()`와 Task별 `exportTask()`의 관찰·해석·검토·Improvement. 출력에 숫자 필드는 `method` 안에만 있고, `interpretation.ts`의 `forbidKeys`와 같은 검사를 `growth-story.ts` 출력에도 건다.

6개 점수 카드(SX-60). Studio 안의 해석에는 점수가 없다(`unsupported_score` 거부). 그래서 Studio의 "접힌 세부 데이터"는 역량별 finding 문장과 검토 상태다. Lab 웹 `/measurement`의 hps-six-auto 점수 카드는 별도 읽기 경로이며 보존한다. 그 페이지를 성장 스토리 아래로 내리는 것은 Lab MP-01 개정 작업이고 이 문서 범위 밖이다. Lab 웹 프로필을 F에서 읽는 연결은 P3 이후 별도 설계다.

## 강사 화면 (P4)

원문 §13과 SX-38~42를 만족하려면 아래가 필요하다. 강사 인증과 강사 화면 자체는 이미 있고, 없는 것은 학습 근거를 그 화면까지 보내는 경로와 학생의 공유 결정이다. 설계만 남기고 구현은 P4로 미룬다.

| 필요한 것 | 현재 | 설계 |
|---|---|---|
| 강사 역할 | **있다.** `role: "issuer"` + `IssuerScope[]`(`tokens.ts`), 검증 `instructor-auth.ts`, 화면 `chalk/src/ui/{board,console,manage,sharing}.html` | 새 역할을 만들지 않는다. 기존 issuer 범위를 그대로 쓰고, 학습 근거 조회 라우트를 그 범위 아래 추가한다. 검증은 두 워커가 공유하는 `instructor-auth.ts` 하나만 쓴다(두 번째 신뢰 경계를 만들지 않는다). 화면은 Chalk가 Surface 층이므로 Chalk에 둔다 |
| 학생 데이터 경로 | 학습 이벤트는 로컬에만(MC-24) | MC-39 원격 제출 이후에만 가능. 학생이 공유 범위를 고른 제출 묶음만 강사에게 간다(CLS-02·CLS-05). 자동 공개 없음 |
| 보여 줄 것(SX-38) | 없음 | 주차·단계 진행(`curriculum.phase`, `current_step`), 학생 원문(`student_text`), 막힌 지점(게이트 차단 history, 강사 호출 이벤트), 확인할 증거(`teacher_state=unreviewed`), source_state 라벨 |
| 보여 주지 않을 것(SX-39) | 상태바 퍼센트가 그 반례다 | 순위, 채팅량·토큰량·체류시간, AI 의존도 추정치, 성격·잠재력, 코호트 랭킹. 강사 화면 데이터 모델에 이 필드를 두지 않는다 |
| CTA(SX-40) | 없음 | "질문 보내기" → B에 `actor=teacher` 메시지. "다시 보게 할 지점 표시" → `teacher_review{ pointer: <event id> }`. "근거 확인 / 추가 관찰 필요" → `teacher_state` confirmed/disputed |
| 가드레일(SX-41) | 없음 | 세션 설계 `learning.never[]`와 기관 정책 플래그(인터뷰·결제·외부 링크)를 프로필에 두고, 해당 단계 진입 시 학생과 강사 양쪽에 안내 |
| 강사 호출(SX-09) | 없음 | intervention ladder 5단계. 코치가 판단 대신 막힌 맥락(현재 단계, 기대 조건, 마지막 차이)을 요약해 강사 큐에 넣는다. 학생 원문은 학생이 공유를 승인한 부분만 |

## 코드 변경 지도

| 파일 | 변경 | SX | 단계 |
|---|---|---|---|
| `worker/src/lib/session-design.ts` | `learning` 선택 키, 단계 `ui`·`evidence`·`gate` 허용, 검증 | SX-56, SX-58 | P0 |
| `worker/test/fixtures/session-design/week-1..6.json`(신규) | 6주차 예시 세션 설계 파일 | SX-56, SX-57 | P0 |
| `chalk/src/ui/authoring.html` | 주차·미션·완료 조건·관찰·금지·단계 ui/evidence/gate 편집 | SX-56 | P0 |
| `worker/src/lib/measurement-core/local-record.ts` | `Task.curriculum`, `teacher_review` record | SX-55, SX-42 | P0 |
| `worker/src/lib/measurement-core/learning-events.ts`(신규) | kind·enum·필수 필드, `gates()`, `nextStep()` | SX-14, SX-15, SX-44, SX-47, SX-55 | P0 |
| `extensions/hypeproof-chat/src/protocol.ts` | `learningState`, `learningEvent`, `nextStep`, `submitTask`, `submitReflection`; `streamAssetScore` 제거 | SX-01, SX-14, SX-59 | P0 |
| `extensions/hypeproof-chat/src/chatPanelProvider.ts` | Task 생성·연결, 상태 기계, 게이트 계산, `learningState` 전송, `assetScores` 제거 | SX-55, SX-14, SX-15, SX-59 | P0 |
| `extensions/hypeproof-chat/src/extension.ts` | `AssetStatusBar` 생성·주입 제거, `hypeproof-chat.growth` 명령 | SX-59, SX-03 | P0 |
| `extensions/hypeproof-chat/src/assetStatusBar.ts`, `assetStatus.ts` | 삭제 | SX-59 | P0 |
| `extensions/hypeproof-chat/webview-ui/src/tokens.css`(신규) | 토큰 6개 + 파생, Paper 전환 | SX-49, SX-54 | P0 |
| `extensions/hypeproof-chat/webview-ui/src/MissionHeader.tsx`(신규) | A 영역. `hps-activity-header`·`hps-lesson` 대체 | SX-01, SX-02, SX-04, SX-50, SX-51 | P0 |
| `extensions/hypeproof-chat/webview-ui/src/App.tsx` | `assetScore` 상태 제거, `learningState` 리듀서 | SX-59, SX-01 | P0 |
| `extensions/hypeproof-chat/webview-ui/src/ChatPanel.tsx` | 헤더 축소, A 삽입, 도움 방식 선택을 단계에 연결, D·E 슬롯 | SX-05, SX-06, SX-13, SX-52 | P0 |
| `extensions/hypeproof-chat/webview-ui/src/start.css`, `StartPage.tsx` | `--studio-*` 별칭화, "변화 기록" 링크 | SX-03, SX-49 | P0 |
| `worker/src/routes/*`(코치 프롬프트 조립 지점) | 미션·현재 단계·완료 조건·`never` 주입, ladder 6단계 지침 | SX-06, SX-07, SX-08, SX-10, SX-11, SX-12 | P0 |
| `worker/src/lib/measurement-core/legacy-observation.ts` | `hps-observation/2` 상위 집합 검증 | SX-44~48 | P1 |
| `worker/src/lib/measurement-core/interpretation.ts` | human 판정 확장, `adopted_from` | SX-45 | P1 |
| `worker/src/lib/measurement-core/normalize.ts` | `/2` namespace | SX-48 | P1 |
| `worker/test/fixtures/measurement-core/*`(추가) | `/2` 유효·무효 fixture | SX-45, SX-46 | P1 |
| `extensions/hypeproof-chat/src/nativeObservationRecorder.ts` | `recordLearningEvent()`, artifact sha256 결합, `/2` 배치 | SX-44, SX-46, SX-47 | P1 |
| `extensions/hypeproof-chat/webview-ui/src/EvidenceDrawer.tsx`(신규) | D 영역. `NativeObservationPanel` 대체. criterion/evidence/decision 폼, 전후 비교, provenance | SX-16~24 | P1 |
| `extensions/hypeproof-chat/webview-ui/src/styles.css` | `hps-lesson`·`hps-native-observation` 블록 제거, `hp-*` 블록 추가 | SX-49, SX-53 | P0, P1 |
| `extensions/hypeproof-chat/webview-ui/src/ReflectionCard.tsx`(신규) | E 영역. `ImprovementReview` 이관 | SX-25~29 | P2 |
| `worker/src/lib/measurement-core/growth-story.ts`(신규) | 패턴·드문 행동·타임라인 순수 함수, 숫자 금지 검사 | SX-30~37 | P3 |
| `extensions/hypeproof-chat/webview-ui/src/LocalReview.tsx` → `GrowthStory.tsx`, `localReview.css` → `growth.css` | F 영역. 우선순위 5개, finding 그리드 접힘, Paper | SX-30, SX-35, SX-36, SX-60 | P3 |
| `extensions/hypeproof-chat/src/localReviewPanel.ts` | `data-surface="growth"`, `growthStory()` 호출 | SX-30 | P3 |
| Chalk `board.html` + Service 학습 근거 조회 라우트(신규) | 기존 `role: "issuer"` 범위 아래 조회 라우트, teacher_review 쓰기, CTA 3개, 가드레일. 새 역할은 만들지 않고 `instructor-auth.ts` 하나만 쓴다 | SX-38~42, SX-09 | P4 |
| `worker/src/lib/measurement-core/interpretation.ts` `versions` 표시 | F의 방법/세부 데이터에 관찰 기준·범위·신뢰도 | SX-37 | P5 |

각 단계의 수용은 [검증 문서](../testing/studio-learning-experience.md)의 SX-T가 소유한다. 이 표의 행이 머지돼도 해당 SX가 충족됐다는 뜻은 아니다.
