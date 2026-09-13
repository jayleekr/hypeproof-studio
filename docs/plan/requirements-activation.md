# Studio·Chalk 요구사항 실행 원장

상태: 실행 계약 · 2026-09-13 · [#1007](https://github.com/jayleekr/hypeproof-studio/issues/1007).
범위: 멤버 기능 카탈로그가 참조하는 11문서 289개 요구사항과 독립 강의 개설 #1006의 7개 계약.
현재 `docs/requirements/*.md`에서 폐기된 선택형 웹 체험 1문서를 제외한 12문서 296개를 38개 실행 단위에 연결한다.
이 원장은 구현 완료·지원 OS 인수·운영 활성화·사람 학습 효과를 선언하지 않는다. 기존 `docs/studio-requirements.md`의 기초 계약과 제품 밖의 모든 가능성을 전수 완료했다는 뜻도 아니다.

## 왜 작업이 있는데 없다고 읽힐 수 있었나

- `docs/plan/HANDOFF.md`는 옛 vessel/modules 계획의 완료 문서다. 제품 전체 종료 조건이 아니다.
- `config/traceability.json`은 bootstrap scope였고 AE·Chalk의 문서/실행 단위 연결이 일부 빠져 있었다. change-impact는 등록된 기준의 변경 영향을 다루며 제품 backlog 생성기가 아니다.
- 멤버 기능 목록은 검토한 스냅샷이며 GitHub 현재 이슈/claim/PR 가용성을 자동 표현하지 않는다.
- 요구·테스트 계획은 이미 상당 부분 존재한다. NOT RUN, 부분 구현, 환경 대기와 사람 판단을 실행 가능한 첫 PR 단위로 분해하는 연결을 보강했다.
- 실제 미발현도 있었다. 작성·관리·디자인 79개 요구 중 23개는 테스트 시나리오 연결이 없었다. `docs/testing/chalk-authoring.md`의 T-24~46으로 정상·실패 조건을 추가했다. 79/79 연결은 테스트 설계의 범위이며 실행 통과가 아니다.
- 특정 Claude 세션의 종료 판단 원문은 이 조사에 제공되지 않았다. 위 항목은 저장소에서 확인한 구조적 원인이며 그 세션의 내부 판단을 단정한 기록이 아니다.

## 실행 절차

```bash
python3 scripts/next-work.py
python3 scripts/next-work.py --check
```

정본 Harness에 `scripts/work-discovery/discover.py`가 필요하다. 별도 checkout은 `HYPEPROOF_HARNESS`로 지정한다. 첫 명령은 현재 GitHub 전체 이슈·열린 PR을 읽으며 두 번째는 구조 검사만 한다.
ready는 **다음 행동에 착수 가능한 후보**다. 해당 기능 전체가 구현되지 않았다는 판정이나 실제 장치가 준비됐다는 보증이 아니다. 원문/기존 코드/이슈 댓글·PR을 다시 읽고 첫 미충족 조건 하나를 맡는다.
claimed/in_review는 다른 작업과 합류·검토, reconcile은 닫힘/오래된 claim을 먼저 확인, dependency는 선행 증거, blocked는 구체적인 사람/환경 조건을 보고한다. ready 0건으로 할 일 없음을 주장하지 않는다.
이슈별 wip·담당·세션·branch를 기록한다. 기존 상위 Epic의 claim을 가져오지 않는다. App·8787 포트의 실제 실행은 한 세션만 사용하며 로컬 구현/fixture는 독립 작업 가능하다.

## 요구사항·디자인·테스트 전체 연결

문서 ID 목록/hash와 실행 단위의 원본은 [requirement-work.json](../../config/requirement-work.json)이다. 아래는 사람이 읽는 탐색표다. 테스트 문서가 있다는 사실은 개별 요구사항의 충족 증거가 아니다. 미충족 세부 동작은 해당 packet의 디자인 변경·양성/음성 조건을 따른다.

| 요구 문서 | 개수 | 디자인 | 테스트 계획·기록 |
|---|---:|---|---|
| [unified-studio-experience.md](../../docs/requirements/unified-studio-experience.md) | 18 | [unified-studio-experience.md](../../docs/design/unified-studio-experience.md) | [unified-completion-917-919-evidence.md](../../docs/testing/unified-completion-917-919-evidence.md) |
| [studio-native-trial.md](../../docs/requirements/studio-native-trial.md) | 12 | [studio-native-trial.md](../../docs/requirements/studio-native-trial.md) | [studio-native-trial-results-2026-09-08.md](../../docs/testing/studio-native-trial-results-2026-09-08.md) |
| [learning-agent-experience.md](../../docs/requirements/learning-agent-experience.md) | 44 | [learning-agent-experience.md](../../docs/design/learning-agent-experience.md) | [learning-agent-experience.md](../../docs/testing/learning-agent-experience.md) |
| [voice-conversation.md](../../docs/requirements/voice-conversation.md) | 47 | [voice-conversation.md](../../docs/requirements/voice-conversation.md) | [voice-conversation.md](../../docs/testing/voice-conversation.md) |
| [model-access-usage.md](../../docs/requirements/model-access-usage.md) | 8 | [model-effort-and-course-usage.md](../../docs/design/model-effort-and-course-usage.md) | [model-access-usage.md](../../docs/testing/model-access-usage.md) |
| [access-budget-settlement.md](../../docs/requirements/access-budget-settlement.md) | 18 | [access-budget-settlement.md](../../docs/design/access-budget-settlement.md) | [access-intent-fulfillment-2026-09-08.md](../../docs/testing/access-intent-fulfillment-2026-09-08.md) |
| [chalk-authoring.md](../../docs/requirements/chalk-authoring.md) | 53 | [chalk-authoring.md](../../docs/requirements/chalk-authoring.md) | [chalk-authoring.md](../../docs/testing/chalk-authoring.md) |
| [classroom-admin.md](../../docs/requirements/classroom-admin.md) | 14 | [classroom-admin.md](../../docs/requirements/classroom-admin.md) | [classroom-admin.md](../../docs/testing/classroom-admin.md) |
| [studio-native-trial-ux.md](../../docs/requirements/studio-native-trial-ux.md) | 55 | [trial-conversation-experience.md](../../docs/design/trial-conversation-experience.md) | [studio-native-trial-ux.md](../../docs/testing/studio-native-trial-ux.md) |
| [classroom-design.md](../../docs/requirements/classroom-design.md) | 12 | [classroom-design.md](../../docs/requirements/classroom-design.md) | [classroom-admin.md](../../docs/testing/classroom-admin.md) |
| [capability-model-contract.md](../../docs/requirements/capability-model-contract.md) | 8 | [philosophy-alignment-2026-09-08.md](../../docs/design/philosophy-alignment-2026-09-08.md) | [capability-and-access.md](../../docs/testing/capability-and-access.md) |
| [independent-course.md](../../docs/requirements/independent-course.md) | 7 | [independent-course.md](../../docs/requirements/independent-course.md) | [independent-course.md](../../docs/requirements/independent-course.md) |

## 기능별 실행 단위

각 단위는 한 세션의 전체 분량을 보증하지 않는다. 첫 행동에서 필요하면 기존 이슈 아래에 더 작은 PR 범위를 분리하고, 구현된 부분을 재작성하지 않는다.

| 단위 | 종류 | 이슈 |
|---|---|---|
| [학생 목표와 수업 기준 보존](#goal) | implementation | [#554](https://github.com/jayleekr/hypeproof-studio/issues/554) |
| [제외한 자료가 재개 문맥에 남지 않도록 집행](#context) | implementation | [#555](https://github.com/jayleekr/hypeproof-studio/issues/555) |
| [단계별 도움 선택과 실제 모델 행동 연결](#help-modes) | implementation | [#1008](https://github.com/jayleekr/hypeproof-studio/issues/1008) |
| [제한된 승인 묶음의 범위와 만료](#approval-scope) | design | [#563](https://github.com/jayleekr/hypeproof-studio/issues/563) |
| [세션 압축·중복 실행·재개 경계](#session) | validation | [#647](https://github.com/jayleekr/hypeproof-studio/issues/647) |
| [파일 집합 복구와 복구 전 상태 보존](#recovery) | implementation | [#673](https://github.com/jayleekr/hypeproof-studio/issues/673) |
| [현재 산출물 버전에 귀속된 검수](#review-validity) | implementation | [#557](https://github.com/jayleekr/hypeproof-studio/issues/557) |
| [수업·AI 만료 후 선택 내보내기](#export) | implementation | [#553](https://github.com/jayleekr/hypeproof-studio/issues/553) |
| [Auto와 모델 전환의 문맥·실패 계약](#model-routing) | implementation | [#1009](https://github.com/jayleekr/hypeproof-studio/issues/1009) |
| [두 번째 모델의 읽기 전용 검토](#model-review) | implementation | [#1010](https://github.com/jayleekr/hypeproof-studio/issues/1010) |
| [강사 설정·확정 버전·학생 실행 바인딩](#lesson-settings) | implementation | [#1011](https://github.com/jayleekr/hypeproof-studio/issues/1011) |
| [학생 자격 리허설과 버전별 준비 증거](#rehearsal) | implementation | [#1012](https://github.com/jayleekr/hypeproof-studio/issues/1012) |
| [원인별 도움과 학급 일시정지](#operations) | implementation | [#751](https://github.com/jayleekr/hypeproof-studio/issues/751) |
| [사람 피드백과 다음 수업 초안 연결](#feedback-loop) | implementation | [#1013](https://github.com/jayleekr/hypeproof-studio/issues/1013) |
| [판단 변화·전이 연구 인수](#human-learning) | research | [#1014](https://github.com/jayleekr/hypeproof-studio/issues/1014) |
| [격리 Computer Use 타당성 설계](#computer-use) | design | [#752](https://github.com/jayleekr/hypeproof-studio/issues/752) |
| [후보 모델 provenance와 legacy 호환](#candidate-contract) | design | [#852](https://github.com/jayleekr/hypeproof-studio/issues/852) |
| [음성 V0 잔여 계약과 인수](#voice-897) | validation | [#897](https://github.com/jayleekr/hypeproof-studio/issues/897) |
| [음성 V1 잔여 계약과 인수](#voice-898) | implementation | [#898](https://github.com/jayleekr/hypeproof-studio/issues/898) |
| [음성 V2 잔여 계약과 인수](#voice-899) | implementation | [#899](https://github.com/jayleekr/hypeproof-studio/issues/899) |
| [음성 V3 잔여 계약과 인수](#voice-900) | implementation | [#900](https://github.com/jayleekr/hypeproof-studio/issues/900) |
| [음성 V4 잔여 계약과 인수](#voice-901) | implementation | [#901](https://github.com/jayleekr/hypeproof-studio/issues/901) |
| [음성 V5 잔여 계약과 인수](#voice-902) | validation | [#902](https://github.com/jayleekr/hypeproof-studio/issues/902) |
| [음성 V6 잔여 계약과 인수](#voice-903) | research | [#903](https://github.com/jayleekr/hypeproof-studio/issues/903) |
| [기존 고객 프로필 없는 새 강의 개설](#course-create) | implementation | [#1006](https://github.com/jayleekr/hypeproof-studio/issues/1006) |
| [검수 가능한 수업 초안 생성과 재사용](#course-generation) | implementation | [#1015](https://github.com/jayleekr/hypeproof-studio/issues/1015) |
| [강사의 기능 요청과 실제 해결 확인](#support-request) | implementation | [#1016](https://github.com/jayleekr/hypeproof-studio/issues/1016) |
| [미등록 도구의 격리 시험과 수업 편입](#extension-admission) | design | [#1017](https://github.com/jayleekr/hypeproof-studio/issues/1017) |
| [공개 버전 복구와 웹앱 실행 범위](#publish-recovery) | design | [#1018](https://github.com/jayleekr/hypeproof-studio/issues/1018) |
| [unified-studio-experience 기존 구현의 행별 인수 대조](#acceptance-unified-studio-experience) | validation | [#919](https://github.com/jayleekr/hypeproof-studio/issues/919) |
| [studio-native-trial 기존 구현의 행별 인수 대조](#acceptance-studio-native-trial) | validation | [#758](https://github.com/jayleekr/hypeproof-studio/issues/758) |
| [studio-native-trial-ux 기존 구현의 행별 인수 대조](#acceptance-studio-native-trial-ux) | validation | [#848](https://github.com/jayleekr/hypeproof-studio/issues/848) |
| [model-access-usage 기존 구현의 행별 인수 대조](#acceptance-model-access-usage) | validation | [#830](https://github.com/jayleekr/hypeproof-studio/issues/830) |
| [access-budget-settlement 기존 구현의 행별 인수 대조](#acceptance-access-budget-settlement) | validation | [#857](https://github.com/jayleekr/hypeproof-studio/issues/857) |
| [chalk-authoring 기존 구현의 행별 인수 대조](#acceptance-chalk-authoring) | validation | [#732](https://github.com/jayleekr/hypeproof-studio/issues/732) |
| [classroom-admin 기존 구현의 행별 인수 대조](#acceptance-classroom-admin) | validation | [#732](https://github.com/jayleekr/hypeproof-studio/issues/732) |
| [classroom-design 기존 구현의 행별 인수 대조](#acceptance-classroom-design) | validation | [#732](https://github.com/jayleekr/hypeproof-studio/issues/732) |
| [learning-agent-experience 기존 구현의 행별 인수 대조](#acceptance-learning-agent-experience) | validation | [#846](https://github.com/jayleekr/hypeproof-studio/issues/846) |

<a id="goal"></a>

### 학생 목표와 수업 기준 보존

- 이슈: [#554](https://github.com/jayleekr/hypeproof-studio/issues/554) · implementation
- 요구사항: learning-agent-experience: AE-01
- 다음 행동: 기존 목표/대화 저장을 조사하고 학생 목표 수정이 수업 기준을 지우지 않는 첫 PR을 구현한다.
- 디자인 변경: 수업 기준은 불변 revision, 학생 목표는 별도 수정 값. 화면 이동·재접속 시 두 값을 복원한다.
- 양성 대조: 목표 변경 뒤 대화와 결과 화면에서 같은 새 목표와 원 수업 기준을 확인.
- 음성 대조: 학생 수정으로 공통 기준 삭제·다른 수업 목표 복원·열람만으로 완료 기록 거부.
- 확인할 구현 경로: `extensions/hypeproof-chat/src`, `extensions/hypeproof-chat/webview-ui/src`

<a id="context"></a>

### 제외한 자료가 재개 문맥에 남지 않도록 집행

- 이슈: [#555](https://github.com/jayleekr/hypeproof-studio/issues/555) · implementation
- 요구사항: learning-agent-experience: AE-02, AE-41
- 다음 행동: 실제 SDK resume payload에 이전 합성 표식이 남는 경로를 먼저 재현하고 자료 선택/재구성을 연결한다.
- 디자인 변경: 제외 목록을 파일·이전 메시지·요약·도구 결과에 적용한다. 배제를 보장하지 못하는 resume는 허용 자료로 새 세션을 구성한다.
- 양성 대조: 포함 자료 B는 다음 요청에 남고 작업 목표는 유지.
- 음성 대조: 제거 자료 A의 표식이 payload·요약·도구 재탐색에 남으면 실패. 과거 공급자 전송을 삭제했다고 표시하지 않음.
- 확인할 구현 경로: `extensions/hypeproof-chat/src/sdkCoach.ts`, `extensions/hypeproof-chat/src/sdkCoachHelpers.ts`

<a id="help-modes"></a>

### 단계별 도움 선택과 실제 모델 행동 연결

- 이슈: [#1008](https://github.com/jayleekr/hypeproof-studio/issues/1008) · implementation
- 요구사항: learning-agent-experience: AE-10, AE-36; chalk-authoring: EDU-01, EDU-02
- 다음 행동: 기존 lesson binding에 도움 모드와 출처를 추가하는 좁은 schema/요청 PR부터 작성한다.
- 디자인 변경: 시연/힌트/함께 수정/직접 수행은 교수 전략이며 권한과 분리. 실행 중 변경은 다음 실행에 적용하고 입력 보존.
- 양성 대조: 명확한 목표는 바로 수행, 모호한 목표는 다음 결정 하나만 질문.
- 음성 대조: 도움 전환으로 도구 권한 확대·초안 소실·도움받은 수행의 독립 수행 표시 금지.
- 확인할 구현 경로: `worker/src/lib/lesson-feature-policy.ts`, `extensions/hypeproof-chat/src`

<a id="approval-scope"></a>

### 제한된 승인 묶음의 범위와 만료

- 이슈: [#563](https://github.com/jayleekr/hypeproof-studio/issues/563) · design
- 요구사항: learning-agent-experience: AE-13
- 다음 행동: 기존 항상 승인 규칙과 새 묶음 계약의 차이를 명시하고 정책 대조군을 만든다.
- 디자인 변경: 작업·파일 집합·origin·행위·만료·policy revision을 고정. 공개/파괴 작업은 기존 개별 승인 유지.
- 양성 대조: 변경 없는 동일 범위는 승인 재사용.
- 음성 대조: 파일 추가/origin/정책 변경·만료·공개 작업에서 묶음 재사용 거절.
- 확인할 구현 경로: `docs/studio-requirements.md`, `extensions/hypeproof-chat/src`

<a id="session"></a>

### 세션 압축·중복 실행·재개 경계

- 이슈: [#647](https://github.com/jayleekr/hypeproof-studio/issues/647) · validation
- 요구사항: learning-agent-experience: AE-14, AE-16
- 다음 행동: 현재 SDK 세션 구현과 #807의 실기 범위를 읽고 20턴 압축/중단 대조에서 아직 미검증인 분기를 실행한다.
- 디자인 변경: 학생/수업/workspace 식별자와 policy revision을 재개 때 확인. 불명확한 외부 효과는 조회 전 재실행하지 않음.
- 양성 대조: 동일 좌석 재개 시 목표·기준 보존, 새 정상 요청 성공.
- 음성 대조: 타 좌석 문맥·이전 grant 복원·중복 부작용·구 SDK의 새 기능 오인 성공 거부.
- 확인할 구현 경로: `extensions/hypeproof-chat/src/sdkCoach.ts`, `worker/src`

<a id="recovery"></a>

### 파일 집합 복구와 복구 전 상태 보존

- 이슈: [#673](https://github.com/jayleekr/hypeproof-studio/issues/673) · implementation
- 요구사항: learning-agent-experience: AE-15; chalk-authoring: WEB-05
- 다음 행동: 현재 checkpoint/backup을 조사하고 추가·수정·삭제와 수동 편집을 포함하는 로컬 복구부터 구현한다.
- 디자인 변경: 파일 manifest/hash를 복구 단위로 사용하고 복구 전 snapshot을 보존. 외부 DB·공개 배포 복구는 별도.
- 양성 대조: Read/Write/Edit/shell 뒤 지정 snapshot의 전체 파일 집합/해시 복원.
- 음성 대조: 추적 밖 파일·삭제 파일·수동 편집을 누락하거나 외부 배포도 복구됐다고 표시하면 실패.
- 확인할 구현 경로: `extensions/hypeproof-chat/src`

<a id="review-validity"></a>

### 현재 산출물 버전에 귀속된 검수

- 이슈: [#557](https://github.com/jayleekr/hypeproof-studio/issues/557) · implementation
- 요구사항: learning-agent-experience: AE-05, AE-18, AE-19, AE-35, AE-37; chalk-authoring: WEB-06
- 다음 행동: 브라우저 검사 결과에 파일 집합/기준/viewport/검사기 revision을 연결하고 오래된 합격 무효화를 첫 PR로 구현한다.
- 디자인 변경: 도구 성공·검사 통과·학생 채택은 별도 상태. 과거 증거를 보존하되 수정 뒤 재검사 필요 표시.
- 양성 대조: 정상 페이지 통과와 무변경 증거 유지, 두 대안 모두 보류 가능.
- 음성 대조: 깨진 이미지/링크/JS/390px 넘침을 탐지. 파일·기준·viewport 변경 뒤 옛 통과 표시 또는 잘못된 탭 조작은 실패.
- 확인할 구현 경로: `extensions/hypeproof-chat/src/browserMcp.ts`, `extensions/hypeproof-chat/webview-ui/src`

<a id="export"></a>

### 수업·AI 만료 후 선택 내보내기

- 이슈: [#553](https://github.com/jayleekr/hypeproof-studio/issues/553) · implementation
- 요구사항: learning-agent-experience: AE-39; chalk-authoring: BASE-05
- 다음 행동: 기존 export/local history를 재사용해 자격 만료 상태에서도 파일과 선택 기록을 내보내는 첫 PR을 만든다.
- 디자인 변경: 파일·목표·변경 이유·검수 근거를 선택 manifest로 내보내며 실행 자격/타인 자료를 제외.
- 양성 대조: 오프라인·수업 종료 뒤 다른 폴더에 재열기와 수정 가능.
- 음성 대조: SDK 설정/합성 비밀/미선택 대화/다른 학생 파일 포함 금지. 호스팅 만료와 파일 소유 구분.
- 확인할 구현 경로: `extensions/hypeproof-chat/src`

<a id="model-routing"></a>

### Auto와 모델 전환의 문맥·실패 계약

- 이슈: [#1009](https://github.com/jayleekr/hypeproof-studio/issues/1009) · implementation
- 요구사항: learning-agent-experience: AE-25, AE-27, AE-28, AE-29, AE-30, AE-33
- 다음 행동: 현재 picker/alias/substitution 구현을 재사용하고 수업 허용 후보 안의 명시적 Auto 정책과 실패 분기를 먼저 구현한다.
- 디자인 변경: Auto와 장애 대체는 별도 정책. 실제 모델/실행기/능력·문맥 전달·원본 복귀·총비용 귀속을 보존.
- 양성 대조: 허용된 동일 실행기 조합 하나에서 선택/실제 모델과 전달 자료 일치.
- 음성 대조: 미허용 후보·은퇴 모델·예산 부족·스트림 중 실패 뒤 조용한 전환이나 외부 효과 중복 금지.
- 확인할 구현 경로: `worker/src`, `extensions/hypeproof-chat/src`

<a id="model-review"></a>

### 두 번째 모델의 읽기 전용 검토

- 이슈: [#1010](https://github.com/jayleekr/hypeproof-studio/issues/1010) · implementation
- 요구사항: learning-agent-experience: AE-31, AE-32, AE-34
- 다음 행동: 같은 산출물 hash와 기준을 두 읽기 검토에 전달하고 한 분기 실패/취소 처리부터 구현한다.
- 디자인 변경: 편집자는 한 실행기. 분기 provenance·비용 예약·부분 결과·채택/보류 이유를 보존. 모델 합의는 정답이 아님.
- 양성 대조: 정상·결함 예제에서 단일/이중 검토 탐지/오탐과 총비용 비교.
- 음성 대조: 검토 분기 쓰기·타 학생 자격·무제한 재시도·실패 분기를 성공으로 병합 금지.
- 확인할 구현 경로: `worker/src`, `extensions/hypeproof-chat/src`

<a id="lesson-settings"></a>

### 강사 설정·확정 버전·학생 실행 바인딩

- 이슈: [#1011](https://github.com/jayleekr/hypeproof-studio/issues/1011) · implementation
- 요구사항: learning-agent-experience: AE-07, AE-08, AE-09, AE-12, AE-26; chalk-authoring: ENV-01, ENV-02, ENV-03, ENV-04, ENV-07
- 다음 행동: 기존 identity/model/features ADR과 구현을 읽고 교육자 설정부터 학생 profile까지 빠진 전달 한 경로를 구현한다.
- 디자인 변경: 이름·교수법·모델·도구·권한을 별도 값으로 고정. 확정 수업은 snapshot을 참조하며 교집합/deny를 유지.
- 양성 대조: 두 수업의 서로 다른 이름/허용 모델이 각각 정상 적용.
- 음성 대조: 타 수업/위조 단계/학생 API/구버전 새 capability 우회 거절. 이름 변경은 권한 확대 불가.
- 확인할 구현 경로: `chalk/src`, `worker/src/lib/lesson-feature-policy.ts`, `extensions/hypeproof-chat/src`

<a id="rehearsal"></a>

### 학생 자격 리허설과 버전별 준비 증거

- 이슈: [#1012](https://github.com/jayleekr/hypeproof-studio/issues/1012) · implementation
- 요구사항: learning-agent-experience: AE-11; chalk-authoring: RUN-01, RUN-02, VER-02
- 다음 행동: 현재 not_run/activated literal과 기존 authoring 저장을 확인하고 학생 자격 실행/증거 저장 경로를 구현한다.
- 디자인 변경: 강사 자격 없는 실행, 내용·템플릿·정책·도구·App/SDK hash에 증거 귀속. 준비/실행/인증/미지원 상태 분리.
- 양성 대조: 학생 권한으로 정상 예제 실행 후 해당 revision만 준비 완료.
- 음성 대조: 강사 전용 자격으로만 성공하는 예제 거부. 도구/내용 수정 뒤 옛 합격 재사용 금지.
- 확인할 구현 경로: `chalk/src`, `worker/src`

<a id="operations"></a>

### 원인별 도움과 학급 일시정지

- 이슈: [#751](https://github.com/jayleekr/hypeproof-studio/issues/751) · implementation
- 요구사항: learning-agent-experience: AE-20, AE-21, AE-22, AE-40
- 다음 행동: 기존 보드/선택 공유를 재사용해 무신호와 알려진 원인별 다음 행동부터 연결한다.
- 디자인 변경: 전체 명단 유지, 원문 없이 도움 요청. 일시정지는 새 실행 admission에 적용하고 미적용 기기/진행 중 효과 구분.
- 양성 대조: 정상 학생/무신호 학생 모두 보이며 학생이 해결 확인.
- 음성 대조: 401/403/429/5xx를 모두 같은 원인으로 단정·원문 자동 공유·오프라인 기기에도 중지 완료 표시 금지.
- 확인할 구현 경로: `chalk/src`, `worker/src`

<a id="feedback-loop"></a>

### 사람 피드백과 다음 수업 초안 연결

- 이슈: [#1013](https://github.com/jayleekr/hypeproof-studio/issues/1013) · implementation
- 요구사항: learning-agent-experience: AE-42, AE-43; chalk-authoring: CH-05, EDU-03, EDU-04, EDU-05
- 다음 행동: 기존 observation/share/feedback을 참조하는 회고→새 초안 연결을 구현한다.
- 디자인 변경: 가설·도움 조건·출처·사람 반론·채택/보류 이유를 저장하며 기존 확정 수업은 불변.
- 양성 대조: 선택 공유된 피드백에서 새 초안과 다음 리허설 근거를 연결.
- 음성 대조: 공유 철회/만료/타 수업 접근 거부. AI 검토를 사람 피드백으로 표시하거나 누락을 독립 수행으로 채우지 않음.
- 확인할 구현 경로: `worker/src/lib/native-observation.ts`, `chalk/src`

<a id="human-learning"></a>

### 판단 변화·전이 연구 인수

- 이슈: [#1014](https://github.com/jayleekr/hypeproof-studio/issues/1014) · research
- 요구사항: learning-agent-experience: AE-24, AE-44
- 다음 행동: 기술 인수와 구분해 과제/도움/순서/누락 조건을 고정한 뒤 사람 후속 관찰을 수행한다.
- 디자인 변경: AI 대행·도움받은 수행·직접 수행을 비교하고 성장/무변화/약화/미확인을 모두 기록.
- 양성 대조: 동의된 참여자의 새 과제와 후속 관찰에서 출처가 있는 판단 근거.
- 음성 대조: 합성 결과·발화량·제출 완료를 학습 성장 PASS로 바꾸지 않음.
- 확인할 구현 경로: `docs/testing/learning-agent-experience.md`
- 대기: 실제 사람 참여·연구 조건 확정·후속 관측이 필요하다. fixture와 기록 형식은 feedback-loop에서 선행 가능.

<a id="computer-use"></a>

### 격리 Computer Use 타당성 설계

- 이슈: [#752](https://github.com/jayleekr/hypeproof-studio/issues/752) · design
- 요구사항: learning-agent-experience: AE-23
- 다음 행동: 웹/API 대안과 비교할 합성 과제·허용 앱·VM·자격/화면 경계·Stop 시나리오를 먼저 확정 가능한 실험 문서로 만든다.
- 디자인 변경: 개인 바탕화면 대신 격리 환경. 실행 단계는 승인된 과제/환경 확보 후 별도 packet으로 분리.
- 양성 대조: 같은 과제의 웹/API/지정 앱 비교와 no-go도 유효한 결론.
- 음성 대조: 일반 데스크톱 권한 확대·자동 fallback·동의 없는 화면 캡처 금지.
- 확인할 구현 경로: `docs/plan/learning-agent-experience-epics.md`, `docs/testing/learning-agent-experience.md`

<a id="candidate-contract"></a>

### 후보 모델 provenance와 legacy 호환

- 이슈: [#852](https://github.com/jayleekr/hypeproof-studio/issues/852) · design
- 요구사항: capability-model-contract: HC-01, HC-02, HC-03, HC-04, HC-05, HC-06, HC-07, HC-08
- 다음 행동: 양쪽 observation validator와 legacy fixture를 감사하고 모델 revision/provenance 진화 계약을 작성한다.
- 디자인 변경: 정의·관측·해석·채택을 분리. 기존 키는 호환성을 유지하고 미확인은 unknown.
- 양성 대조: 구 기록 왕복과 새 revision/출처 기록을 분리해 읽음.
- 음성 대조: 새 이름/개수 채택만으로 자동 점수·독립 능력 인증·과거 증거 재분류 금지.
- 확인할 구현 경로: `worker/src/lib/native-observation.ts`, `extensions/hypeproof-chat/src`

<a id="voice-897"></a>

### 음성 V0 잔여 계약과 인수

- 이슈: [#897](https://github.com/jayleekr/hypeproof-studio/issues/897) · validation
- 요구사항: voice-conversation: VO-01, VO-02, VO-03, VO-04, VO-05
- 다음 행동: docs/plan/voice-conversation-epics.md와 해당 이슈의 기존 구현/기록을 대조하고 미충족 VO 행 하나를 첫 PR/검증 대상으로 선택한다.
- 디자인 변경: 발화·텍스트·도구 작업·오디오 재생·비용 출처를 같은 activity에 연결하되 각각의 상태와 승인 주체를 구분한다.
- 양성 대조: 해당 VO-T 정상 경로와 기존 텍스트 경로가 같은 작업/결과로 이어짐.
- 음성 대조: 중복/역순/중단/권한 철회/늦은 마이크 grant/한도/타 activity 이벤트에서 누출·중복 효과·허위 성공 0.
- 확인할 구현 경로: `extensions/hypeproof-chat/src`, `extensions/hypeproof-chat/webview-ui/src`, `worker/src`

<a id="voice-898"></a>

### 음성 V1 잔여 계약과 인수

- 이슈: [#898](https://github.com/jayleekr/hypeproof-studio/issues/898) · implementation
- 요구사항: voice-conversation: VO-06, VO-07, VO-08, VO-09, VO-10, VO-36, VO-37, VO-38, VO-39, VO-40, VO-41, VO-42, VO-43
- 다음 행동: docs/plan/voice-conversation-epics.md와 해당 이슈의 기존 구현/기록을 대조하고 미충족 VO 행 하나를 첫 PR/검증 대상으로 선택한다.
- 디자인 변경: 발화·텍스트·도구 작업·오디오 재생·비용 출처를 같은 activity에 연결하되 각각의 상태와 승인 주체를 구분한다.
- 양성 대조: 해당 VO-T 정상 경로와 기존 텍스트 경로가 같은 작업/결과로 이어짐.
- 음성 대조: 중복/역순/중단/권한 철회/늦은 마이크 grant/한도/타 activity 이벤트에서 누출·중복 효과·허위 성공 0.
- 확인할 구현 경로: `extensions/hypeproof-chat/src`, `extensions/hypeproof-chat/webview-ui/src`, `worker/src`

<a id="voice-899"></a>

### 음성 V2 잔여 계약과 인수

- 이슈: [#899](https://github.com/jayleekr/hypeproof-studio/issues/899) · implementation
- 요구사항: voice-conversation: VO-11, VO-12, VO-13, VO-14, VO-15, VO-45
- 다음 행동: docs/plan/voice-conversation-epics.md와 해당 이슈의 기존 구현/기록을 대조하고 미충족 VO 행 하나를 첫 PR/검증 대상으로 선택한다.
- 디자인 변경: 발화·텍스트·도구 작업·오디오 재생·비용 출처를 같은 activity에 연결하되 각각의 상태와 승인 주체를 구분한다.
- 양성 대조: 해당 VO-T 정상 경로와 기존 텍스트 경로가 같은 작업/결과로 이어짐.
- 음성 대조: 중복/역순/중단/권한 철회/늦은 마이크 grant/한도/타 activity 이벤트에서 누출·중복 효과·허위 성공 0.
- 확인할 구현 경로: `extensions/hypeproof-chat/src`, `extensions/hypeproof-chat/webview-ui/src`, `worker/src`

<a id="voice-900"></a>

### 음성 V3 잔여 계약과 인수

- 이슈: [#900](https://github.com/jayleekr/hypeproof-studio/issues/900) · implementation
- 요구사항: voice-conversation: VO-16, VO-17, VO-18, VO-19, VO-20, VO-44
- 다음 행동: docs/plan/voice-conversation-epics.md와 해당 이슈의 기존 구현/기록을 대조하고 미충족 VO 행 하나를 첫 PR/검증 대상으로 선택한다.
- 디자인 변경: 발화·텍스트·도구 작업·오디오 재생·비용 출처를 같은 activity에 연결하되 각각의 상태와 승인 주체를 구분한다.
- 양성 대조: 해당 VO-T 정상 경로와 기존 텍스트 경로가 같은 작업/결과로 이어짐.
- 음성 대조: 중복/역순/중단/권한 철회/늦은 마이크 grant/한도/타 activity 이벤트에서 누출·중복 효과·허위 성공 0.
- 확인할 구현 경로: `extensions/hypeproof-chat/src`, `extensions/hypeproof-chat/webview-ui/src`, `worker/src`

<a id="voice-901"></a>

### 음성 V4 잔여 계약과 인수

- 이슈: [#901](https://github.com/jayleekr/hypeproof-studio/issues/901) · implementation
- 요구사항: voice-conversation: VO-21, VO-22, VO-23, VO-24, VO-25, VO-46
- 다음 행동: docs/plan/voice-conversation-epics.md와 해당 이슈의 기존 구현/기록을 대조하고 미충족 VO 행 하나를 첫 PR/검증 대상으로 선택한다.
- 디자인 변경: 발화·텍스트·도구 작업·오디오 재생·비용 출처를 같은 activity에 연결하되 각각의 상태와 승인 주체를 구분한다.
- 양성 대조: 해당 VO-T 정상 경로와 기존 텍스트 경로가 같은 작업/결과로 이어짐.
- 음성 대조: 중복/역순/중단/권한 철회/늦은 마이크 grant/한도/타 activity 이벤트에서 누출·중복 효과·허위 성공 0.
- 확인할 구현 경로: `extensions/hypeproof-chat/src`, `extensions/hypeproof-chat/webview-ui/src`, `worker/src`

<a id="voice-902"></a>

### 음성 V5 잔여 계약과 인수

- 이슈: [#902](https://github.com/jayleekr/hypeproof-studio/issues/902) · validation
- 요구사항: voice-conversation: VO-26, VO-27, VO-28, VO-29, VO-30, VO-47
- 다음 행동: docs/plan/voice-conversation-epics.md와 해당 이슈의 기존 구현/기록을 대조하고 미충족 VO 행 하나를 첫 PR/검증 대상으로 선택한다.
- 디자인 변경: 발화·텍스트·도구 작업·오디오 재생·비용 출처를 같은 activity에 연결하되 각각의 상태와 승인 주체를 구분한다.
- 양성 대조: 해당 VO-T 정상 경로와 기존 텍스트 경로가 같은 작업/결과로 이어짐.
- 음성 대조: 중복/역순/중단/권한 철회/늦은 마이크 grant/한도/타 activity 이벤트에서 누출·중복 효과·허위 성공 0.
- 확인할 구현 경로: `extensions/hypeproof-chat/src`, `extensions/hypeproof-chat/webview-ui/src`, `worker/src`

<a id="voice-903"></a>

### 음성 V6 잔여 계약과 인수

- 이슈: [#903](https://github.com/jayleekr/hypeproof-studio/issues/903) · research
- 요구사항: voice-conversation: VO-31, VO-32, VO-33, VO-34, VO-35
- 다음 행동: docs/plan/voice-conversation-epics.md와 해당 이슈의 기존 구현/기록을 대조하고 미충족 VO 행 하나를 첫 PR/검증 대상으로 선택한다.
- 디자인 변경: 발화·텍스트·도구 작업·오디오 재생·비용 출처를 같은 activity에 연결하되 각각의 상태와 승인 주체를 구분한다.
- 양성 대조: 해당 VO-T 정상 경로와 기존 텍스트 경로가 같은 작업/결과로 이어짐.
- 음성 대조: 중복/역순/중단/권한 철회/늦은 마이크 grant/한도/타 activity 이벤트에서 누출·중복 효과·허위 성공 0.
- 확인할 구현 경로: `extensions/hypeproof-chat/src`, `extensions/hypeproof-chat/webview-ui/src`, `worker/src`
- 대기: 사람 파일럿과 후속 재사용 관측은 V5 대상 환경 인수·V4 비용 통제·참여 정책 준비 뒤 진행.

<a id="course-create"></a>

### 기존 고객 프로필 없는 새 강의 개설

- 이슈: [#1006](https://github.com/jayleekr/hypeproof-studio/issues/1006) · implementation
- 요구사항: independent-course: IC-01, IC-02, IC-03, IC-04, IC-05, IC-06, IC-07
- 다음 행동: IC-01/02/03의 초안과 명시적 개설 계약부터 구현하고 #1005와 겹치는 변경을 먼저 대조한다.
- 디자인 변경: 불변 강의와 실행 템플릿·기관 범위·개설 operation을 분리. 승인된 기존 인증/명단/서명을 재사용.
- 양성 대조: 합성 새 강의 생성·중복 개설 재시도·학생 코드 진입.
- 음성 대조: 다른 기관 설정 잔존·정책 확대·기존 코드 변경·중복 session 생성 금지.
- 확인할 구현 경로: `chalk/src`, `worker/src`

<a id="course-generation"></a>

### 검수 가능한 수업 초안 생성과 재사용

- 이슈: [#1015](https://github.com/jayleekr/hypeproof-studio/issues/1015) · implementation
- 요구사항: chalk-authoring: CH-02, CH-03, CH-06, CH-07
- 다음 행동: 기존 Module authoring에서 예제/과제/검수 기준을 갖춘 생성 초안 한 종류를 저장·편집·확정하는 범위로 구현한다.
- 디자인 변경: 생성은 초안이며 사람이 확정. 학생별 예제 사본과 다음 기수 복제에서 학생 기록/자격 제외.
- 양성 대조: 두 학생 독립 사본, 기본/확장 과제, 다음 기수 재편집.
- 음성 대조: 생성 직후 자동 개설·원본 변경·다른 학생 자료 복제·필수 기준 없는 확정 금지.
- 확인할 구현 경로: `chalk/src`, `worker/src`

<a id="support-request"></a>

### 강사의 기능 요청과 실제 해결 확인

- 이슈: [#1016](https://github.com/jayleekr/hypeproof-studio/issues/1016) · implementation
- 요구사항: chalk-authoring: REQ-01, REQ-02, REQ-03, REQ-04
- 다음 행동: 기존 지원 요청 저장 경로를 조사하고 수업/목적/참고/필요 날짜/상태/다음 조치를 연결한다.
- 디자인 변경: 기존 안내·선택 확장·기본 개발 분류와 이유를 보존. 처리 완료와 강사의 실제 해결 확인을 구분.
- 양성 대조: 본인 요청 재열기·진행 상태·명시적인 미정 사유 표시.
- 음성 대조: 다른 수업 요청 원문 접근·예상 날짜 추측·PR 병합만으로 해결 확인 금지.
- 확인할 구현 경로: `chalk/src`, `worker/src`

<a id="extension-admission"></a>

### 미등록 도구의 격리 시험과 수업 편입

- 이슈: [#1017](https://github.com/jayleekr/hypeproof-studio/issues/1017) · design
- 요구사항: chalk-authoring: ENV-05, ENV-06
- 다음 행동: 현재 카탈로그 경계를 재사용해 후보 도구의 설치/실행/실패/제거 증거와 편입 판단 계약을 작성한다.
- 디자인 변경: 격리 시험→검토→불변 수업 버전의 명시적 편입. 실패 시 기존 수업 영향 없음.
- 양성 대조: 검증된 후보만 해당 권한 범위에서 연결 시험 성공.
- 음성 대조: 임의 MCP/플러그인 자동 설치·수업 복제 자격 포함·실패 뒤 권한 확대 금지.
- 확인할 구현 경로: `docs/adr/0007-lesson-feature-binding.md`, `worker/src`

<a id="publish-recovery"></a>

### 공개 버전 복구와 웹앱 실행 범위

- 이슈: [#1018](https://github.com/jayleekr/hypeproof-studio/issues/1018) · design
- 요구사항: chalk-authoring: WEB-07, WEB-08, WEB-09
- 다음 행동: 현재 publish 경로와 #718의 환경 대기를 읽고 정적 공개 복구와 의존성 있는 웹앱 지원 범위를 별도 계약으로 분리한다.
- 디자인 변경: 릴리스 artifact/원격 revision·URL 확인을 로컬 파일 복구와 구분. 웹앱은 검증한 템플릿만 admission.
- 양성 대조: 통제된 대상의 공개 버전/자산을 재접속 확인, 설치/빌드 실패는 작업 보존.
- 음성 대조: 미승인 production 배포·URL 존재만으로 현재 버전 성공·외부 DB까지 복구 주장 금지.
- 확인할 구현 경로: `docs/testing/chalk-authoring.md`, `extensions/hypeproof-chat/src`

<a id="acceptance-unified-studio-experience"></a>

### unified-studio-experience 기존 구현의 행별 인수 대조

- 이슈: [#919](https://github.com/jayleekr/hypeproof-studio/issues/919) · validation
- 요구사항: unified-studio-experience: US-01, US-02, US-03, US-04, US-05, US-06, US-07, US-08, US-09, US-10, US-11, US-12, US-13, US-14, US-15, US-16, US-17, US-18
- 다음 행동: 연결된 검증 기록의 SHA/환경/개별 REQ를 현재 구현과 대조한다. 첫 미충족 행 하나를 실행하고 제품 결함과 계측 결함을 구분해 수정한다.
- 디자인 변경: 이미 구현된 저장소·API·UI는 재사용한다. 코드/합성/실기/운영/사람 결과를 별도 열로 기록하고 하위 조건을 포괄 완료 처리하지 않는다.
- 양성 대조: 연결된 테스트 계획의 정상 입력에서 기대 상태/파일/API 결과 일치.
- 음성 대조: 해당 계획의 타 수업/만료/중복/오프라인/긴 내용/누락 증거 대조. 닫힌 PR·테스트 파일만으로 전체 요구사항 PASS 금지.
- 확인할 구현 경로: `docs/testing`, `extensions/hypeproof-chat/src`, `worker/src`, `chalk/src`

<a id="acceptance-studio-native-trial"></a>

### studio-native-trial 기존 구현의 행별 인수 대조

- 이슈: [#758](https://github.com/jayleekr/hypeproof-studio/issues/758) · validation
- 요구사항: studio-native-trial: NAT-01, NAT-02, NAT-03, NAT-04, NAT-05, NAT-06, NAT-07, NAT-08, NAT-09, NAT-10, NAT-11, NAT-12
- 다음 행동: 연결된 검증 기록의 SHA/환경/개별 REQ를 현재 구현과 대조한다. 첫 미충족 행 하나를 실행하고 제품 결함과 계측 결함을 구분해 수정한다.
- 디자인 변경: 이미 구현된 저장소·API·UI는 재사용한다. 코드/합성/실기/운영/사람 결과를 별도 열로 기록하고 하위 조건을 포괄 완료 처리하지 않는다.
- 양성 대조: 연결된 테스트 계획의 정상 입력에서 기대 상태/파일/API 결과 일치.
- 음성 대조: 해당 계획의 타 수업/만료/중복/오프라인/긴 내용/누락 증거 대조. 닫힌 PR·테스트 파일만으로 전체 요구사항 PASS 금지.
- 확인할 구현 경로: `docs/testing`, `extensions/hypeproof-chat/src`, `worker/src`, `chalk/src`

<a id="acceptance-studio-native-trial-ux"></a>

### studio-native-trial-ux 기존 구현의 행별 인수 대조

- 이슈: [#848](https://github.com/jayleekr/hypeproof-studio/issues/848) · validation
- 요구사항: studio-native-trial-ux: TUX-A11Y-01, TUX-A11Y-02, TUX-A11Y-03, TUX-A11Y-04, TUX-CHAT-01, TUX-CHAT-02, TUX-CHAT-03, TUX-CHAT-04, TUX-CHAT-05, TUX-CHAT-06, TUX-CHAT-07, TUX-CHAT-08, TUX-CHAT-09, TUX-CHAT-10, TUX-CHAT-11, TUX-CHAT-12, TUX-CHAT-13, TUX-CHAT-14, TUX-CHAT-15, TUX-CHAT-16, TUX-COND-01, TUX-COND-02, TUX-COND-03, TUX-COND-04, TUX-COND-05, TUX-COND-06, TUX-COPY-01, TUX-HOST-01, TUX-HOST-02, TUX-HOST-03, TUX-HOST-04, TUX-HOST-05, TUX-HOST-06, TUX-HOST-07, TUX-HOST-08, TUX-OBS-01, TUX-OBS-02, TUX-OBS-03, TUX-OBS-04, TUX-OBS-05, TUX-OBS-06, TUX-OBS-07, TUX-OBS-08, TUX-OBS-09, TUX-OBS-10, TUX-SP-01, TUX-SP-02, TUX-SP-03, TUX-SP-04, TUX-SP-05, TUX-SP-06, TUX-SP-07, TUX-SP-08, TUX-SP-09, TUX-SP-10
- 다음 행동: 연결된 검증 기록의 SHA/환경/개별 REQ를 현재 구현과 대조한다. 첫 미충족 행 하나를 실행하고 제품 결함과 계측 결함을 구분해 수정한다.
- 디자인 변경: 이미 구현된 저장소·API·UI는 재사용한다. 코드/합성/실기/운영/사람 결과를 별도 열로 기록하고 하위 조건을 포괄 완료 처리하지 않는다.
- 양성 대조: 연결된 테스트 계획의 정상 입력에서 기대 상태/파일/API 결과 일치.
- 음성 대조: 해당 계획의 타 수업/만료/중복/오프라인/긴 내용/누락 증거 대조. 닫힌 PR·테스트 파일만으로 전체 요구사항 PASS 금지.
- 확인할 구현 경로: `docs/testing`, `extensions/hypeproof-chat/src`, `worker/src`, `chalk/src`

<a id="acceptance-model-access-usage"></a>

### model-access-usage 기존 구현의 행별 인수 대조

- 이슈: [#830](https://github.com/jayleekr/hypeproof-studio/issues/830) · validation
- 요구사항: model-access-usage: MU-01, MU-02, MU-03, MU-04, MU-05, MU-06, MU-07, MU-08
- 다음 행동: 연결된 검증 기록의 SHA/환경/개별 REQ를 현재 구현과 대조한다. 첫 미충족 행 하나를 실행하고 제품 결함과 계측 결함을 구분해 수정한다.
- 디자인 변경: 이미 구현된 저장소·API·UI는 재사용한다. 코드/합성/실기/운영/사람 결과를 별도 열로 기록하고 하위 조건을 포괄 완료 처리하지 않는다.
- 양성 대조: 연결된 테스트 계획의 정상 입력에서 기대 상태/파일/API 결과 일치.
- 음성 대조: 해당 계획의 타 수업/만료/중복/오프라인/긴 내용/누락 증거 대조. 닫힌 PR·테스트 파일만으로 전체 요구사항 PASS 금지.
- 확인할 구현 경로: `docs/testing`, `extensions/hypeproof-chat/src`, `worker/src`, `chalk/src`

<a id="acceptance-access-budget-settlement"></a>

### access-budget-settlement 기존 구현의 행별 인수 대조

- 이슈: [#857](https://github.com/jayleekr/hypeproof-studio/issues/857) · validation
- 요구사항: access-budget-settlement: AB-01, AB-02, AB-03, AB-04, AB-05, AB-06, AB-07, AB-08, AB-09, AB-10, AB-11, AB-12, AB-13, AB-14, AB-15, AB-16, AB-17, AB-18
- 다음 행동: 연결된 검증 기록의 SHA/환경/개별 REQ를 현재 구현과 대조한다. 첫 미충족 행 하나를 실행하고 제품 결함과 계측 결함을 구분해 수정한다.
- 디자인 변경: 이미 구현된 저장소·API·UI는 재사용한다. 코드/합성/실기/운영/사람 결과를 별도 열로 기록하고 하위 조건을 포괄 완료 처리하지 않는다.
- 양성 대조: 연결된 테스트 계획의 정상 입력에서 기대 상태/파일/API 결과 일치.
- 음성 대조: 해당 계획의 타 수업/만료/중복/오프라인/긴 내용/누락 증거 대조. 닫힌 PR·테스트 파일만으로 전체 요구사항 PASS 금지.
- 확인할 구현 경로: `docs/testing`, `extensions/hypeproof-chat/src`, `worker/src`, `chalk/src`

<a id="acceptance-chalk-authoring"></a>

### chalk-authoring 기존 구현의 행별 인수 대조

- 이슈: [#732](https://github.com/jayleekr/hypeproof-studio/issues/732) · validation
- 요구사항: chalk-authoring: ARC-01, ARC-02, AUTH-01, BASE-01, BASE-02, BASE-03, BASE-04, CH-01, CH-04, CLS-01, CLS-02, CLS-03, CLS-04, CLS-05, RUN-03, RUN-04, RUN-05, SAVE-01, VER-01, WEB-01, WEB-02, WEB-03, WEB-04
- 다음 행동: 연결된 검증 기록의 SHA/환경/개별 REQ를 현재 구현과 대조한다. 첫 미충족 행 하나를 실행하고 제품 결함과 계측 결함을 구분해 수정한다.
- 디자인 변경: 이미 구현된 저장소·API·UI는 재사용한다. 코드/합성/실기/운영/사람 결과를 별도 열로 기록하고 하위 조건을 포괄 완료 처리하지 않는다.
- 양성 대조: 연결된 테스트 계획의 정상 입력에서 기대 상태/파일/API 결과 일치.
- 음성 대조: 해당 계획의 타 수업/만료/중복/오프라인/긴 내용/누락 증거 대조. 닫힌 PR·테스트 파일만으로 전체 요구사항 PASS 금지.
- 확인할 구현 경로: `docs/testing`, `extensions/hypeproof-chat/src`, `worker/src`, `chalk/src`

<a id="acceptance-classroom-admin"></a>

### classroom-admin 기존 구현의 행별 인수 대조

- 이슈: [#732](https://github.com/jayleekr/hypeproof-studio/issues/732) · validation
- 요구사항: classroom-admin: ADM-01, ADM-02, ADM-03, ADM-04, ADM-05, ADM-06, ADM-07, ADM-08, ADM-09, ADM-10, ADM-11, ADM-12, ADM-13, ADM-14
- 다음 행동: 연결된 검증 기록의 SHA/환경/개별 REQ를 현재 구현과 대조한다. 첫 미충족 행 하나를 실행하고 제품 결함과 계측 결함을 구분해 수정한다.
- 디자인 변경: 이미 구현된 저장소·API·UI는 재사용한다. 코드/합성/실기/운영/사람 결과를 별도 열로 기록하고 하위 조건을 포괄 완료 처리하지 않는다.
- 양성 대조: 연결된 테스트 계획의 정상 입력에서 기대 상태/파일/API 결과 일치.
- 음성 대조: 해당 계획의 타 수업/만료/중복/오프라인/긴 내용/누락 증거 대조. 닫힌 PR·테스트 파일만으로 전체 요구사항 PASS 금지.
- 확인할 구현 경로: `docs/testing`, `extensions/hypeproof-chat/src`, `worker/src`, `chalk/src`

<a id="acceptance-classroom-design"></a>

### classroom-design 기존 구현의 행별 인수 대조

- 이슈: [#732](https://github.com/jayleekr/hypeproof-studio/issues/732) · validation
- 요구사항: classroom-design: DES-01, DES-02, DES-03, DES-04, DES-05, DES-06, DES-07, DES-08, DES-09, DES-10, DES-11, DES-12
- 다음 행동: 연결된 검증 기록의 SHA/환경/개별 REQ를 현재 구현과 대조한다. 첫 미충족 행 하나를 실행하고 제품 결함과 계측 결함을 구분해 수정한다.
- 디자인 변경: 이미 구현된 저장소·API·UI는 재사용한다. 코드/합성/실기/운영/사람 결과를 별도 열로 기록하고 하위 조건을 포괄 완료 처리하지 않는다.
- 양성 대조: 연결된 테스트 계획의 정상 입력에서 기대 상태/파일/API 결과 일치.
- 음성 대조: 해당 계획의 타 수업/만료/중복/오프라인/긴 내용/누락 증거 대조. 닫힌 PR·테스트 파일만으로 전체 요구사항 PASS 금지.
- 확인할 구현 경로: `docs/testing`, `extensions/hypeproof-chat/src`, `worker/src`, `chalk/src`

<a id="acceptance-learning-agent-experience"></a>

### learning-agent-experience 기존 구현의 행별 인수 대조

- 이슈: [#846](https://github.com/jayleekr/hypeproof-studio/issues/846) · validation
- 요구사항: learning-agent-experience: AE-03, AE-04, AE-06, AE-17, AE-38
- 다음 행동: 연결된 검증 기록의 SHA/환경/개별 REQ를 현재 구현과 대조한다. 첫 미충족 행 하나를 실행하고 제품 결함과 계측 결함을 구분해 수정한다.
- 디자인 변경: 이미 구현된 저장소·API·UI는 재사용한다. 코드/합성/실기/운영/사람 결과를 별도 열로 기록하고 하위 조건을 포괄 완료 처리하지 않는다.
- 양성 대조: 연결된 테스트 계획의 정상 입력에서 기대 상태/파일/API 결과 일치.
- 음성 대조: 해당 계획의 타 수업/만료/중복/오프라인/긴 내용/누락 증거 대조. 닫힌 PR·테스트 파일만으로 전체 요구사항 PASS 금지.
- 확인할 구현 경로: `docs/testing`, `extensions/hypeproof-chat/src`, `worker/src`, `chalk/src`

## 완료와 재개

`completion`은 해당 단위의 모든 조건을 검토했을 때만 추가한다. `reviewed_by`, `report`, `verdict: PASS`, `inputs`를 기록하고 `verification_inputs`에 실제 구현·테스트·fixture 경로를 명시한다. 요구사항/구현/검사 입력 hash가 바뀌면 완료를 재사용하지 않는다. 초기 원장은 모든 완료 attestation을 비워 둔다.
기존 검증을 버리는 것이 아니라 정확한 행과 실행 범위를 대조하는 것이다. 미실행은 NOT RUN, 필요한 환경이 없으면 BLOCKED. 합성 PASS는 실기 또는 인간 인수가 아니다. 구현 PR을 일부 끝냈으면 남은 조건을 같은 이슈나 별도 실행 단위에 남긴다.
