# Studio·Chalk 요구사항 실행 원장

상태: 실행 계약 · 2026-09-13 · [#1007](https://github.com/jayleekr/hypeproof-studio/issues/1007).
범위: 멤버 기능 카탈로그가 참조하는 11문서 289개 요구사항과 독립 강의 개설 #1006의 7개 계약.
현재 `docs/requirements/*.md`에서 폐기된 선택형 웹 체험 1문서를 제외한 12문서 296개를 38개 실행 단위에 연결한다.
Addendum 2026-09-29, outside the #1007 scope above: the [Curriculum Runtime](#curriculum-runtime) section adds 1 document, 84 requirements and 11 work units, so the tables below list 13 documents, 380 requirements and 49 units. Other documents registered in `config/requirement-work.json` since #1007 are not listed here; the ledger is the complete inventory.
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
| [curriculum-runtime.md](../../docs/requirements/curriculum-runtime.md) | 84 | [curriculum-runtime.md](../../docs/plan/curriculum-runtime.md) | [curriculum-runtime.md](../../docs/testing/curriculum-runtime.md) |

## 기능별 실행 단위

각 단위는 한 세션의 전체 분량을 보증하지 않는다. 첫 행동에서 필요하면 기존 이슈 아래에 더 작은 PR 범위를 분리하고, 구현된 부분을 재작성하지 않는다.

| 단위 | 종류 | 이슈 |
|---|---|---|
| [학생 목표와 수업 기준 보존](#goal) | implementation | [#554](https://github.com/jayleekr/hypeproof-studio/issues/554) |
| [제외한 자료가 이후 모델 문맥에 남지 않도록 집행](#context) | implementation | [#555](https://github.com/jayleekr/hypeproof-studio/issues/555) |
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
| [Curriculum Runtime reconnaissance: architecture map and gap matrix](#cr-recon) | design | [#1390](https://github.com/jayleekr/hypeproof-studio/issues/1390) |
| [Experiment Browser: observation, actions and element to AI](#cr-browser) | implementation | [#1391](https://github.com/jayleekr/hypeproof-studio/issues/1391) |
| [AI Verify: test my product against observable criteria](#cr-verify) | implementation | [#1392](https://github.com/jayleekr/hypeproof-studio/issues/1392) |
| [Publish for user test: immutable versions, links and QR](#cr-publish) | implementation | [#1393](https://github.com/jayleekr/hypeproof-studio/issues/1393) |
| [Evidence capture: participant events, notes and sourced drafts](#cr-evidence) | implementation | [#1394](https://github.com/jayleekr/hypeproof-studio/issues/1394) |
| [Venture Memory: structured learning state](#cr-memory) | implementation | [#1395](https://github.com/jayleekr/hypeproof-studio/issues/1395) |
| [Curriculum skills: contract, loader and seven skills](#cr-skills) | implementation | [#1396](https://github.com/jayleekr/hypeproof-studio/issues/1396) |
| [AI Gateway for student apps: capabilities, ceiling and attribution](#cr-gateway) | implementation | [#1397](https://github.com/jayleekr/hypeproof-studio/issues/1397) |
| [Weekly Review Pack and director decisions](#cr-review) | implementation | [#1398](https://github.com/jayleekr/hypeproof-studio/issues/1398) |
| [HTML IR deck: slide state and evidence-aware patches](#cr-deck) | implementation | [#1399](https://github.com/jayleekr/hypeproof-studio/issues/1399) |
| [Curriculum Runtime Week 1 to Week 2 end-to-end loop](#cr-e2e) | validation | [#1400](https://github.com/jayleekr/hypeproof-studio/issues/1400) |

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

### 제외한 자료가 이후 모델 문맥에 남지 않도록 집행

- 이슈: [#555](https://github.com/jayleekr/hypeproof-studio/issues/555) · implementation
- 요구사항: learning-agent-experience: AE-02, AE-41
- 다음 행동: 현재 매 턴 대화를 재전송하는 두 모델 경로에서 메모·텍스트 자료 A를 이후 문맥에서 제외하는 첫 수직 조각을 구현한다. 출처 없는 과거 문맥은 확인된 목표와 유지 자료로 재구성하고 그 경계를 표시한다.
- 디자인 변경: 활동 범위의 호스트 소유 제외 상태를 입력 초안과 분리해 저장하고 SDK·proxy가 공유하는 대화 재생 경로와 UI에 적용한다. 첫 조각은 메모·텍스트만 지원하며 파일·페이지·이미지·자동 도구 읽기는 실제 집행 전까지 제외 가능하다고 표시하지 않는다. SDK resume 도입은 선행 조건이 아니다.
- 양성 대조: 포함 자료 B와 확인된 작업 목표는 다음 요청과 재열기 뒤에도 유지.
- 음성 대조: 제외한 메모·텍스트 자료 A의 표식이 이전 assistant 인용, 입력 초안 저장·전송, 예약 전송, 활동 재열기 뒤 두 모델 요청 경로에 남거나 다른 활동의 제외 상태가 바뀌면 실패. 지원하지 않는 자료 유형을 안전하게 제외됐다고 표시하거나 과거 공급자 전송을 삭제했다고 표시해도 실패.
- 확인할 구현 경로: `extensions/hypeproof-chat/src/protocol.ts`, `extensions/hypeproof-chat/src/contextExclusion.ts`, `extensions/hypeproof-chat/src/chatTimeline.ts`, `extensions/hypeproof-chat/src/chatPanelProvider.ts`, `extensions/hypeproof-chat/src/sdkCoach.ts`, `extensions/hypeproof-chat/src/proxyClient.ts`, `extensions/hypeproof-chat/webview-ui/src/ChatPanel.tsx`

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
- 요구사항: learning-agent-experience: AE-20, AE-21, AE-22, AE-40; classroom-admin: ADM-01~14
- 다음 행동: 2026-09-18 [원격 운영 PRD](../requirements/classroom-admin.md#원격-수업-운영-확장-설계--2026-09-18)와 [R0~R7](learning-agent-experience-epics.md#remote-classroom-delivery)을 따라 현재 회차 명단·pairing·활성화·단계·오류 관측의 첫 수직 경로부터 구현한다.
- 디자인 변경: 전체 명단·activation·단계와 D1 command CAS/lease/epoch/receipt, 보존형 reset, 동의된 immutable 수집, 공통 측정/legacy adapter, 승인된 수신자·delivery outbox를 R0~R7로 분해한다. 일시정지는 새 실행 admission에 적용하고 미적용 기기/진행 중 효과를 구분한다.
- 양성 대조: 정상 학생/무신호 학생 모두 보이며 학생이 해결 확인.
- 음성 대조: 발급을 활성화로 표시·무신호 정상화·401/403/429/5xx를 모두 같은 원인으로 단정·타 학생 제어/원문·중복 reset·미검수 발송·provider 수락을 전달 완료로 표시 금지.
- 확인할 구현 경로: `chalk/src`, `worker/src`, `extensions/hypeproof-chat/src`, `packages/measurement`

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

## Curriculum Runtime

Added 2026-09-29 for epic [#1388](https://github.com/jayleekr/hypeproof-studio/issues/1388): 1 document, 84 requirements, 11 work items. Intent: [INT-CR-00–09](../intents/curriculum-runtime.md). Order, DAG and the provisional gap matrix: [curriculum-runtime plan](curriculum-runtime.md). The entries below are written in English (repository language rule); the ledger is their source.

<a id="cr-recon"></a>

### Curriculum Runtime reconnaissance: architecture map and gap matrix

- Issue: [#1390](https://github.com/jayleekr/hypeproof-studio/issues/1390) · design
- Requirements: curriculum-runtime: CR-01
- Depends on: —
- Next action: Read the ten PRD §13 Phase 0 areas (docs/design/curriculum-runtime-prd-v1.0-2026-09-28.md) on origin/main and write the architecture map (exact paths, symbols, extension points, data flows) and the per-row gap matrix into docs/plan/curriculum-runtime.md, replacing the provisional matrix. Decide whether the upstream browserView tools can be driven from hypeproof-chat through vscodium-base/patches and where the adapter boundary sits, how the CR switch (CR-02) is resolved, and which skill loader CR-43 uses.
- Design change: No production code. Every claim names a path or symbol that exists at the recorded commit; unknowns stay unknown. Before calling a gap new, check the owners of the reused requirements (review-validity #557, publish-recovery #1018, sx-p1-evidence-capture #1172, measurement-core-dogfood #1020, model-routing #1009) and their open PRs.
- Positive control: Every map entry resolves to a path and symbol at the recorded commit; the matrix has one verdict (reuse / extend / new) for each CR row.
- Negative control: A map entry with a non-existent path or symbol, a missing PRD area, or a CR row missing from the matrix fails CR-T01. A gap called new while an open PR already implements it is recorded as a finding.
- Implementation paths to check: `docs/plan/curriculum-runtime-recon.md`, `docs/plan/curriculum-runtime.md`, `docs/testing/curriculum-runtime.md`, `worker/test/cr-recon.test.mjs`, `worker/test/fixtures/cr-recon/frozen-inputs.json`, `worker/package.json`, `e2e/curriculum-runtime`

<a id="cr-browser"></a>

### Experiment Browser: observation, actions and element to AI

- Issue: [#1391](https://github.com/jayleekr/hypeproof-studio/issues/1391) · implementation
- Requirements: curriculum-runtime: CR-02, CR-03, CR-04, CR-05, CR-06, CR-07, CR-08, CR-09, CR-10, CR-11, CR-68
- Depends on: cr-recon
- Next action: Behind the CR switch, extend BrowserControl.execute with select, scroll, hover and reload; buffer CDP console, exception and failed-request events per document generation; return URL, route, viewport and artifact version with every observation and expose them through browserMcp; add element selection that hands ref, DOM snippet, style, crop and source mapping to the coach; show the automation indicator while agent browser tools act; keep agent browser actions on the local preview origin (cr-verify extends CR-11 and CR-68 to the runner, cr-publish extends CR-11 to published test origins). CR-10's artifact references ride on the tool_result event as Jay's decision 8 keys (BROWSER_RESULT_REF_KEYS), the screenshot and trace bytes go to the local record (LocalRecord.putBlob), and the command hypeproof-chat.browserResults reads them back labelled by version. CR-59 and CR-60 moved to cr-e2e (decision 9).
- Design change: Extend the existing CDP stack and MCP tools; no second browser-control framework. The upstream browserView agent tools are not driven and vscodium-base is not patched (docs/plan/curriculum-runtime-recon.md R1). Results bind to the artifact version that recon R4 defines: the digest of the published file set. AE-37 (#557) binds single-file artifact events, and each file keeps the sha256 those events carry.
- Positive control: Existing browser smokes and 09-preview.spec.ts stay green with the switch off; the kiosk fixture five-step flow succeeds; a clean page reports zero console records. Agent browser actions on the live-server origin run, with the automation indicator shown during each browser-tool step and gone after it.
- Negative control: Stale refs after reload or navigation are rejected; a planted console error in flow step 3 is reported once, at the index of the agent action that raised it with the opening navigate counted (action 4 in the App flow), and a later request that does not navigate reads it as an earlier request's record, never at one of its own steps; an agent browser action navigating to an external origin is refused with a reason; an agent browser-tool step with no visible indicator fails; a CR surface visible with the switch off fails.
- Implementation paths to check: `extensions/hypeproof-chat/src/browserControl.ts`, `extensions/hypeproof-chat/src/cdpSession.ts`, `extensions/hypeproof-chat/src/browserControlHelpers.ts`, `extensions/hypeproof-chat/src/browserMcp.ts`, `extensions/hypeproof-chat/src/nativeBrowser.ts`, `extensions/hypeproof-chat/src/liveServer.ts`, `extensions/hypeproof-chat/src/previewProvider.ts`, `extensions/hypeproof-chat/webview-ui/src`

<a id="cr-verify"></a>

### AI Verify: test my product against observable criteria

- Issue: [#1392](https://github.com/jayleekr/hypeproof-studio/issues/1392) · implementation
- Requirements: curriculum-runtime: CR-02, CR-03, CR-11, CR-12, CR-13, CR-14, CR-15, CR-16, CR-61, CR-68, CR-81
- Depends on: cr-browser
- Next action: Add the 'Test my product' action that takes 1–5 criteria, runs them with the CR-06 actions (DOM and accessibility first), and writes an hps-verification/1 report through criterion_set / test_observed bound to the artifact version; hand failed criteria to the coach as a fix request and re-test by criterion ID; show 'verified' only for a version with an all-pass report; keep runner steps on the project's own origins (CR-11) and show the automation indicator during a run (CR-68).
- Design change: The report is a view over existing learning events plus artifact references (SX-48); no new store. AI-proposed criteria stay AI-actor drafts until the student confirms (SX-14, HC-04). Stale-pass handling reuses AE-37 (#557).
- Positive control: Three student criteria on the kiosk fixture give the same verdicts on two runs of the same version; a failed criterion re-tested after a fix yields retest_confirmed. Runner steps on the live-server origin run, and the automation indicator shows during a verify run and is gone after it.
- Negative control: Zero or six criteria are refused; an unconfirmed AI criterion does not run; a verdict without a cited observation is 'not verified'; an earlier pass shown as current after a file change fails. 'Verified' shown for a version without an all-pass report bound to it fails. With the CR switch off, the "Test my product" command and its verification routes are unreachable (a worker route answers as an unknown route does); they are added to the CR-T02 switch-off inventory. A runner step navigating to an external origin is refused with a reason; a runner step with no visible indicator fails.
- Implementation paths to check: `extensions/hypeproof-chat/src/browserControl.ts`, `extensions/hypeproof-chat/src/browserMcp.ts`, `extensions/hypeproof-chat/src/nativeObservationRecorder.ts`, `extensions/hypeproof-chat/webview-ui/src/EvidenceDrawer.tsx`, `worker/src/lib/measurement-core/learning-events.ts`

<a id="cr-publish"></a>

### Publish for user test: immutable versions, links and QR

- Issue: [#1393](https://github.com/jayleekr/hypeproof-studio/issues/1393) · implementation
- Requirements: curriculum-runtime: CR-02, CR-11, CR-17, CR-18, CR-19, CR-20, CR-21, CR-22, CR-39, CR-64, CR-65, CR-66, CR-73
- Depends on: cr-verify
- Next action: Read galleryPublish.ts, the Lab /api/gallery/publish route and publish-recovery #1018, then generalise that path to publish a chosen verified version as a content-addressed test version with share URL, client-side QR, revocation, required expiry, anonymous participant sessions, project / experiment / version attribution and channel-labelled links. Starting a test creates the Experiment record (CR-39, every PRD §10.1 field) and, when the project has none, the Hypothesis it names; agent browser actions and the runner may also reach the project's published test origins, and no other project's (CR-11).
- Design change: One publish path, not a second one beside gallery publish; WEB-07/08 stay with #1018. Test versions are immutable and keyed by digest; experiments pin a version. Until Jay sets a default expiry, publishing requires an explicit one. The published runtime denies microphone and camera unless the experiment declares them. Lab-side changes go in a separate Lab PR linked from #1393. cr-publish creates the participant session record when a link is opened, with project, experiment, version and channel; cr-evidence (CR-23) adds the other event kinds on that path and they inherit the session's attribution. The Experiment record (CR-39) and the Hypothesis it names are created here, in the storage cr-recon chose for Venture Memory (CR-35), because attribution, pinning, channel links and the experiment declarations need them before cr-memory; cr-evidence adds its declarations to that record and cr-memory extends it, and neither creates a second one.
- Positive control: Same bytes publish to the same version ID; a phone (emulated, and one real) opens the link at 390 px without login; publishing v1 leaves the running v0 experiment on v0. Two channel-labelled links of one experiment attribute sessions to their own channel. The publish action shows verified only for a version with an all-pass report bound to it (CR-81). Starting a test on a verified version stores one Experiment record with every CR-39 field whose hypothesis_id resolves (CR-T80); runner steps on the project's published test origin run.
- Negative control: Changing files behind a published version is refused; a revoked or expired link answers 410 with no content; a publish without an explicit expiry is refused while no default is set; a session whose version is not the experiment's is refused; an undeclared page calling getUserMedia is denied. A session claiming an experiment other than its link's is refused. With the CR switch off, the publish action and the public share, QR and session routes are unreachable (a worker route answers as an unknown route does); they are added to the CR-T02 switch-off inventory. An experiment whose hypothesis_id does not resolve is refused; a runner step or agent browser action on another project's published origin is refused.
- Implementation paths to check: `extensions/hypeproof-chat/src/galleryPublish.ts`, `worker/src/routes`, `worker/migrations`, `e2e/tests`

<a id="cr-evidence"></a>

### Evidence capture: participant events, notes and sourced drafts

- Issue: [#1394](https://github.com/jayleekr/hypeproof-studio/issues/1394) · implementation
- Requirements: curriculum-runtime: CR-02, CR-23, CR-24, CR-25, CR-26, CR-27, CR-28, CR-65, CR-67, CR-69, CR-70, CR-72, CR-74
- Depends on: cr-publish
- Next action: Add a lightweight event snippet to published test versions for the six participant event kinds and store them as learning events on the existing measurement-core path with source_state real and the anonymous session ID; add the five manual record kinds with provenance; build Observed / Interpreted / Assumed / Next drafts whose observed statements must resolve their source_refs; derive returning-session evidence for experiments that declare it and per-variant results for comparison experiments.
- Design change: SX-48: extend hps-observation/1 and learning-events; no new table, KV namespace, validator copy or scorer. Raw records are immutable; interpretation edits are revisions (MC-22). Raw participant input is not retained unless the experiment declares it, and its retention default waits for Jay. Deletion propagates to derived drafts following MC-31 and classroom-erasure.ts. Experiment declarations (repeated-use measurement, raw-input retention, comparison variants) are fields of the Experiment record cr-publish created (CR-39), not a record of their own.
- Positive control: One scripted participant session yields the six kinds; three real citations validate; editing an interpretation leaves raw hashes unchanged; clicking a claim opens its sources. A declared repeated-use experiment reports one pseudonym's return count citing its sessions; a two-variant comparison reports per variant.
- Negative control: Three planted fabricated statements are refused; events for a revoked version and events with identity fields are refused; typed text for an undeclared experiment is not stored; a store-inventory check finds no new evidence table. An undeclared experiment shows returns as 'not measured', not 0; an event without a variant in a comparison experiment is refused. With the CR switch off, the participant event ingest route and the manual-record and evidence-draft panels are unreachable (a worker route answers as an unknown route does); they are added to the CR-T02 switch-off inventory.
- Implementation paths to check: `worker/src/lib/measurement-core`, `worker/src/lib/classroom-erasure.ts`, `extensions/hypeproof-chat/src/nativeObservationRecorder.ts`, `extensions/hypeproof-chat/src/sessionSpool.ts`, `extensions/hypeproof-chat/src/evidenceSnapshot.ts`, `extensions/hypeproof-chat/webview-ui/src/EvidenceDrawer.tsx`

<a id="cr-memory"></a>

### Venture Memory: structured learning state

- Issue: [#1395](https://github.com/jayleekr/hypeproof-studio/issues/1395) · implementation
- Requirements: curriculum-runtime: CR-02, CR-35, CR-36, CR-37, CR-38, CR-39, CR-40, CR-41, CR-42, CR-75, CR-76, CR-77, CR-78, CR-79, CR-82
- Depends on: cr-evidence
- Next action: Implement the PRD §10 Experiment, Evidence item, Decision and Artifact contracts and the project entity set as a worker schema extension that links hypotheses, experiments, evidence (by reference), decisions, product versions and deck slides, with stakeholder roles, metric definitions, a product version diff, a project timeline, hypothesis revisions for the "belief changed because…" view, a fact/assumption register, and a director traversal API limited to the director's scope.
- Design change: Observations and evidence items are references into the measurement-core store, never copies (SX-48). Extend hps-session-design/1 conventions without changing its schema ID unless Jay approves a breaking change. Director scope reuses the issuer identity (SX-38); no new role. The Hypothesis and Experiment records cr-publish created (CR-39) are extended in place: cr-memory re-runs CR-T80 and creates no second hypothesis or experiment record.
- Positive control: The four PRD §10 samples validate; a project reopened with chat history deleted shows the same state; a director walks hypothesis → evidence → decision → version. A v0 → v1 diff names the decision and evidence behind v1; every timeline entry opens its record. The register lists every evidence item by confidence, and a student-accepted revision with real sources moves an assumption to observed while keeping the earlier revision.
- Negative control: Each sample missing a required field is refused; an observed evidence item with empty source_refs, slide number 9 and an artifact without entry_html are refused; a director outside scope is refused; a duplicated evidence table fails the store inventory. A stakeholder with no role is refused; a simulated metric input counted as a real result fails; a belief change with no linked decision shows 'reason not recorded'. With the CR switch off, the Venture Memory APIs, the register and timeline views and the director traversal route are unreachable (a worker route answers as an unknown route does); they are added to the CR-T02 switch-off inventory. A dangling assumption_ref is refused; an assumption promoted by an AI or skill statement with no resolvable source_refs is refused.
- Implementation paths to check: `worker/src/lib/session-design.ts`, `worker/src/lib/measurement-core`, `worker/migrations`, `worker/src/routes`, `extensions/hypeproof-chat/src/localReviewService.ts`, `extensions/hypeproof-chat/src/localRecordFile.ts`

<a id="cr-skills"></a>

### Curriculum skills: contract, loader and seven skills

- Issue: [#1396](https://github.com/jayleekr/hypeproof-studio/issues/1396) · implementation
- Requirements: curriculum-runtime: CR-02, CR-43, CR-44, CR-45, CR-46, CR-47
- Depends on: cr-memory
- Next action: With the loader cr-recon chose, read versioned skill contracts and curriculum v5 data, validate outputs before write-back, and ship Experiment, Evidence, Product Builder and Deck Builder first, then Interview, Critic and Demo Coach.
- Design change: No parallel plugin framework. Skill loading must not let workspace settings add tool allow-rules (the SDK coach keeps settingSources: [] or an equivalent restriction). Curriculum content is data, never code (SX-56). Skill outputs and the model requests a skill issues carry skill ID and version and name a capability, not a model ID. Until cr-gateway lands (it depends on this item), skills call models through the existing coach route, where the capability is recorded but resolved by the existing lesson model policy.
- Positive control: A complete skill contract loads; valid Evidence output writes only its declared targets; planted-answer fixtures give the expected outputs. The Critic lists a claim that no verification criterion or experiment checks as a missing test; the Demo Coach returns a demo flow and Q&A.
- Negative control: A skill missing a contract field is not loaded; invalid output writes nothing; a workspace allow-rule has no effect; planted leading questions, weak claims, a product whose AI failure has no handling, out-of-scope file changes and unaffected-slide edits are caught. With the CR switch off, the curriculum skill loader and the skill commands are unreachable (a worker route answers as an unknown route does); they are added to the CR-T02 switch-off inventory. An unsupported claim planted in the Demo Coach Q&A is caught.
- Implementation paths to check: `extensions/hypeproof-chat/src/sdkCoachHelpers.ts`, `worker/src/lib/lesson-help-mode.ts`, `worker/src/prompts`, `worker/src/lib/session-design.ts`

<a id="cr-gateway"></a>

### AI Gateway for student apps: capabilities, ceiling and attribution

- Issue: [#1397](https://github.com/jayleekr/hypeproof-studio/issues/1397) · implementation
- Requirements: curriculum-runtime: CR-02, CR-29, CR-30, CR-31, CR-32, CR-33, CR-34, CR-70, CR-80, CR-83, CR-84
- Depends on: cr-skills
- Next action: Add a student-app endpoint on the worker with app-scoped tokens and origin-bound CORS, a capability → model policy table, a normalised adapter interface with a mock adapter, a hard credit ceiling on the existing budget admission, per-app-token and per-participant-session rate limits, and attribution by organisation, cohort, team, student, project, skill, capability and provider/model. Keep no request, response or R2 turn body for app calls unless the experiment declares raw-input retention, and extend the CR-69 delete path to gateway trace and usage rows. Teach the coach and the Product Builder skill to generate hypeproof.ai.* capability calls through the snippet, with the key scan extended to provider SDK imports, provider endpoints and model IDs.
- Design change: Adapt the existing /v1/chat/completions and /v1/messages stack, budgets and ledgers instead of a new gateway. MU-02 stays: same-provider retry of the mapped model only before output, every attempt metered; no automatic substitution to another provider or an unmapped model; failures are typed errors. The model-practice route keeps MU-02's single upstream call. Admin ceilings reuse AB-04 authorisation. App calls ignore the cohort log_user_messages flag for bodies unless the experiment declares raw-input retention; deleting a participant session drops its trace rows and strips its key from usage rows, which keep cost for settlement (AB-07).
- Positive control: The kiosk app calls text.fast from its published origin without a key; the same request passes through a recorded real adapter and the mock with one shape; requests up to the ceiling succeed with full attribution. Requests under the rate limit from two participant sessions succeed. Asked for an AI feature on the kiosk fixture, the coach generates a hypeproof.ai.* call with a capability that passes the scan and works from the published version.
- Negative control: A planted key pattern in a bundle is found; a token from another origin is refused; a model ID in a request is refused; after a mapped-provider failure a spy sees zero calls to another provider; the request past the ceiling gets 429 with no upstream call; a burst from one participant session gets 429 rate_limited without draining the team ceiling; 20 concurrent requests do not overshoot. With the CR switch off, the `/v1/app/*` routes and the client snippet are unreachable (a worker route answers as an unknown route does); they are added to the CR-T02 switch-off inventory. With log_user_messages on, an undeclared experiment's app call that stores a body fails; a usage or trace row still keyed to a deleted participant session fails; planted generated code with a provider SDK import, a provider URL or a model ID is caught by the scan.
- Implementation paths to check: `worker/src/routes/chat.ts`, `worker/src/routes/messages.ts`, `worker/src/routes/access.ts`, `worker/src/env.ts`, `worker/src/lib/budgets.ts`, `worker/src/lib/budget-admission.ts`, `worker/src/lib/usage-costs.ts`, `worker/src/lib/model-usage.ts`, `worker/src/lib/access-contracts.ts`, `worker/src/lib/lesson-model-policy.ts`, `worker/src/lib/model-caps.ts`, `worker/src/lib/storage.ts`, `worker/src/lib/classroom-erasure.ts`, `worker/schema.sql`, `worker/migrations`, `extensions/hypeproof-chat/src/sdkCoachHelpers.ts`, `worker/src/prompts`

<a id="cr-review"></a>

### Weekly Review Pack and director decisions

- Issue: [#1398](https://github.com/jayleekr/hypeproof-studio/issues/1398) · implementation
- Requirements: curriculum-runtime: CR-02, CR-48, CR-49, CR-50, CR-51, CR-52, CR-53, CR-62
- Depends on: cr-skills
- Next action: Follow the classroom-report pattern to build a per-team pack with the ten PRD sections from structured evidence, cache the latest valid pack keyed by an input digest, add 'Prepare Weekly Review' and section-level regeneration, let the director record a decision and next experiment that write back to Venture Memory, and add the four-team overview.
- Design change: Reuse classroom-report, classroom-evaluator and classroom-report-html rather than a second report engine. Opening a pack never calls a model; stale packs open marked stale. Claims link to sources and interpretation stays apart, reading only the existing store (SX-48).
- Positive control: The Week 2 fixture yields ten sections with linked claims; opening the cached pack makes zero model calls; the director's decision and next experiment appear in memory after reopen. With no slide patch pending, the "deck slides affected" section names the decisions' slides and says "no proposal".
- Negative control: An unlinked factual claim fails; changing one evidence item regenerates only the sections that read it; any model call on open fails; another cohort's team never appears in the overview. With the CR switch off, the review screen, "Prepare Weekly Review" and the director overview routes are unreachable (a worker route answers as an unknown route does); they are added to the CR-T02 switch-off inventory.
- Implementation paths to check: `worker/src/lib/classroom-report.ts`, `worker/src/lib/classroom-evaluator.ts`, `worker/src/lib/classroom-report-html.ts`, `worker/src/routes`, `extensions/hypeproof-chat/webview-ui/src`

<a id="cr-deck"></a>

### HTML IR deck: slide state and evidence-aware patches

- Issue: [#1399](https://github.com/jayleekr/hypeproof-studio/issues/1399) · implementation
- Requirements: curriculum-runtime: CR-02, CR-54, CR-55, CR-56, CR-57, CR-58, CR-63
- Depends on: cr-review
- Next action: Store the eight v5 slides as structured state rendered to HTML in the embedded browser, let the Deck Builder propose per-slide patches with evidence refs, flag unsupported numbers, and add per-slide accept / reject and a change view that shows which claims changed and why.
- Design change: State and render are separate; editing rendered HTML never changes state. Patches touch affected slides only. Numbers without evidence refs are flagged and simulated numbers are labelled (SX-46, SX-58). Export stays out of scope.
- Positive control: The fixture deck renders the eight titles verbatim; the Week 2 fixture yields patches for slides 2–3 only; accepting slide 2 changes only slide 2. Each slide claim shows observed, interpreted or assumed, never stronger than the evidence it cites. A pack prepared while a slide patch is pending lists it under "deck slides affected" with its evidence refs.
- Negative control: Four planted unsupported numbers yield four flags; a rejected patch leaves state byte-identical; any proposal outside slides 2–3 for the Week 2 fixture fails. With the CR switch off, the deck view and the slide patch routes are unreachable (a worker route answers as an unknown route does); they are added to the CR-T02 switch-off inventory. A claim labelled observed without citing an observed evidence item fails. A pack prepared while a patch is pending that leaves it out of "deck slides affected" fails.
- Implementation paths to check: `extensions/hypeproof-chat/src/previewProvider.ts`, `extensions/hypeproof-chat/src/liveServer.ts`, `extensions/hypeproof-chat/webview-ui/src`, `worker/src/lib`

<a id="cr-e2e"></a>

### Curriculum Runtime Week 1 to Week 2 end-to-end loop

- Issue: [#1400](https://github.com/jayleekr/hypeproof-studio/issues/1400) · validation
- Requirements: curriculum-runtime: CR-02, CR-59, CR-60, CR-71
- Depends on: cr-deck, cr-gateway
- Next action: Script the fifteen PRD §14 steps (the §14 procedure in docs/testing/curriculum-runtime.md) on the kiosk-practice app under e2e/classroom, run it on the dev host, then run it once live on a real Mac with a real phone and record the evidence file. Measure CR-59 (preview refresh after save, CR-T55) and CR-60 (element capture to context, CR-T56) in the Studio app on this Mac, 30 samples each, with the screen unlocked (Jay's decision 9, 2026-10-01: moved here from cr-browser).
- Design change: Uses only shipped CR behaviour behind the switch; no test-only shortcuts in product code. Each step reads the previous step's record. The existing preview and HTML regressions are re-run with the switch off, and CR-T02 walks the whole switch-off inventory the earlier items built.
- Positive control: All fifteen steps pass on the dev host; the live run completes with a real phone; the switch-off regressions stay green. With the switch off, CR-T02 walks the full switch-off inventory from every item and finds every entry unreachable. In the Studio app on the reference Mac, preview refresh after save has p50 under 2 s (CR-T55) and element capture to context p50 under 1 s (CR-T56), 30 samples each.
- Negative control: A planted break between steps 8 and 10 stops the loop at step 10; a live-run step satisfied only by synthetic data is NOT RUN, not PASS. Any inventory entry reachable with the switch off fails. A planted 3 s delay in the refresh path, and a full-page screenshot planted in place of the element crop, are each reported as a miss.
- Implementation paths to check: `e2e/classroom`, `e2e/tests`, `docs/testing/curriculum-runtime.md`

## 완료와 재개

`completion`은 해당 단위의 모든 조건을 검토했을 때만 추가한다. `reviewed_by`, `report`, `verdict: PASS`, `inputs`를 기록하고 `verification_inputs`에 실제 구현·테스트·fixture 경로를 명시한다. 요구사항/구현/검사 입력 hash가 바뀌면 완료를 재사용하지 않는다. 초기 원장은 모든 완료 attestation을 비워 둔다.
기존 검증을 버리는 것이 아니라 정확한 행과 실행 범위를 대조하는 것이다. 미실행은 NOT RUN, 필요한 환경이 없으면 BLOCKED. 합성 PASS는 실기 또는 인간 인수가 아니다. 구현 PR을 일부 끝냈으면 남은 조건을 같은 이슈나 별도 실행 단위에 남긴다.
