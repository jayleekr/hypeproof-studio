# 측정 코어 설계 경계

상태: 설계 제안, 구현 전. Owner: jayleekr. 2026-09-13.
상위: [MC-01–48](../requirements/measurement-core.md). [검증](../testing/measurement-core.md).

## 제품과 코드의 관계

공통 코어는 HypeProof가 소유하는 관찰·근거·해석·재검토 계약과 구현이다. 플러그인은 각 호스트에 이 제품을 전달하는 방법이다. 기존 Studio 측정 경로도 같은 코어를 사용해야 추출 완료다. 별도 로그 수집기만 배포해서 이 설계를 완료 처리하지 않는다.

```text
Studio App ───── 어댑터 ─┐
Claude Code ─── 어댑터 ─┼→ 공통 코어 → 로컬 저장 → 작업 카드 → 검토 → 제출 보관함
Codex ───────── 어댑터 ─┘      │                          │
                             ├ 근거·누락·출처             └ 다음 작업의 확인점
                             └ 모델 정의·버전별 해석          ↓
                                                     모델 연구 검토
Chalk: 선택적 수업·목적 맥락 입력. 코어 실행의 필수 의존성 아님.
```

이 문서의 소프트웨어 코어는 기존 [vessel-and-modules](../plan/vessel-and-modules.md)의 `m*` 커리큘럼 데이터 Module과 다른 개념이다. 실행 코드·어댑터·UI는 해당 App/Service/Surface 경계에 배치하고, 모델 정의·rubric은 버전 데이터로 다룬다.

## 추출 순서와 재사용 대상

확인 기준: Studio `614a4094d570f152f4837d9f459dcb4203f2aeee`. 아래는 코드 존재·의존성에 대한 검토이며 런타임 수용 증거가 아니다.

| 현재 경로 | 공통화할 책임 | 어댑터/기존 경로에 남길 책임 |
|---|---|---|
| `worker/src/lib/native-observation.ts` / `extensions/hypeproof-chat/src/nativeObservationContract.ts` | 사건·근거 검증의 공통 부분, legacy 읽기 계약, 유효·무효 대조 fixture | Worker 인증·scope 검사, App 메시지 전달; 서로 다른 규칙은 감사 후 명시적으로 해소 |
| `extensions/hypeproof-chat/src/nativeObservationRecorder.ts` | 관찰 생성·연결의 호스트 독립 부분 | Studio 실제 host event 수신 |
| `extensions/hypeproof-chat/src/sessionSpool.ts` | task/session 귀속·중복·재시도에서 재사용 가능한 부분 | Studio 로그 경로, cohort token 연계, 업로드 정책; Jay 저장소에 그대로 이식하지 않음 |
| `worker/src/routes/observations.ts` / `worker/src/lib/native-observation-scope.ts` | 공통 검증기 호출 | 기존 서비스 권한·테넌트 경계·API 호환 |
| `skills/hain7-report/scripts/hain7_signal.py`와 references | 기존 근거 추출·rubric의 가정과 반례를 감사하는 참조 | 별도 보고서 도구. 공통화가 필요하면 코어 호출 wrapper로 연결하고 같은 판정기를 두 언어에 복제하지 않음 |
| `worker/src/lib/asset-scorer.ts` | 현행 heuristic의 한계를 migration 감사에 남김 | assistant 키워드·길이 신호를 개인 역량 판정의 기본으로 재사용하지 않음 |

첫 구현에서 dependency graph와 입출력 fixtures를 확인한 뒤 최소 순수 라이브러리를 추출한다. 새 배포 패키지가 필요하면 저장소의 `products.yaml` admission, 실제 실행되는 format drift lock, 이전 코드 제거 계획을 같은 구현 PR에 넣는다. 실행 코드 없는 이 문서 PR은 가상 package나 통과하지 않은 drift lock을 등록하지 않는다.

잠정 구현 선택은 기존 App/Worker와 가까운 TypeScript 공통 라이브러리와 얇은 로컬 명령 인터페이스다. 별도 Python 판정기나 원격 분석 서버를 먼저 만들지 않는다. 최종 위치·패키징은 첫 추출 PR이 의존성과 테스트를 근거로 확정한다.

## 코어와 어댑터의 계약

코어 경계: validate/normalize → append observations → link evidence → validate interpretation → review revision → build/verify submission → accept local receipt. 호스트 UI·인증·파일 접근은 주입된 어댑터가 담당한다. 코어는 기본 네트워크 권한을 요구하지 않는다.

어댑터는 호스트의 실제 event를 정규화한다. host session과 task를 동일시하지 않는다. transcript parser를 안정된 공통 계약으로 삼지 않는다. 원본 포맷에 의존한 fallback parser가 필요하면 지원 버전·누락 범위·실패 상태를 명시한다. 받을 수 없는 사건을 만들어서 공통 schema를 채우지 않는다.

설치 검증은 공식 호스트 문서와 설치된 버전을 함께 기록한다. Codex hook의 `transcript_path`는 없을 수 있고 transcript 구조는 안정 API가 아니다. 비관리 hook 신뢰 절차가 필요하므로 플러그인 파일 생성만으로 연결 성공을 주장하지 않는다. Claude Code도 지원 event와 실제 전달을 검증한다.

참조: [Codex hooks](https://developers.openai.com/codex/hooks/), [Codex plugins](https://developers.openai.com/codex/plugins/), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Claude Code plugins](https://code.claude.com/docs/en/plugins). 문서 확인과 실제 호스트 실행은 별도다.

## 저장 개체와 revision

| 개체 | 최소 정보 / 불변식 |
|---|---|
| Task | 로컬 사용자, 목적의 출처·확인 여부, 프로젝트 scope, 연결된 host sessions, 작업 상태 |
| Observation | 출처 ID, sequence/인과 관계의 가용 범위, actor/assistance, 시각, 관찰 payload, 제외·누락, 원본 참조 |
| Artifact reference | 관찰한 결과물 revision/hash, 실제 읽기 여부, 관련 검증 실행·대상 revision |
| Interpretation | 입력 근거 ID, 주장, 후보 항목, 미관찰 이유, 모델/정의/rubric/evaluator/AI 버전, 검토 상태 |
| Review | 검토 주체, 확인·수정·이견·공유 제외, 이전 revision, 사유; 원본 사건을 변경하지 않음 |
| Submission | 선택된 관찰·해석·검토·제외 목록, task/revision/parent, 정확한 payload digest, destination |
| Receipt | 영속 저장 이후 발급, ID/digest/revision/시각/목적지; local과 remote 구분 |
| Improvement | 이전 근거, 다음 작업에서 확인할 행동, 선택·시도·관찰된 결과·미확인의 별도 상태 |

두 축으로 상태를 관리한다. 작업은 open/paused/completed/abandoned, 수집은 active/paused/degraded다. 제출 묶음은 draft/reviewed/exported/accepted-local이며 원격 도입 시 pending-remote/accepted-remote를 별도 사용한다. export가 acceptance를 함의하지 않는다. 삭제는 모든 참조의 사용 가능성을 갱신하며, 원자료 보존을 삭제 거부의 이유로 쓰지 않는다.

실제 wire schema와 숫자 제한은 추출 PR에서 fixtures·negative controls와 함께 고정한다. 위 표는 새 API가 이미 배포됐다는 뜻이 아니다.

## 기본 모델은 여섯 개

**Jay의 2026-09-13 결정으로 새 제품의 기본은 6개 모델이다.** 정의의 출발점은 Lab [PHILOSOPHY.md §6](https://github.com/jayleekr/hypeprooflab/blob/b081a790cee1a8efa4b6c98dc3cfdf549bd7f3bf/PHILOSOPHY.md) Candidate Capability Model v1이다. 아래 행동·반례는 P0 해석을 위한 초기 운영 정의이며 연구 결과가 아니다. 최초 패키지에 정본 source commit·정의 revision과 함께 고정한다.

| 모델 항목 / 화면 이름 | 초기 관찰 기준 | 긍정 사례 | 이것만으로는 부족한 사례 |
|---|---|---|---|
| Framing / 문제 구성 | 목적·상황·제약·성공 조건을 함께 정하거나 다시 구성함 | “가입 수보다 첫 작업 완료를 보자. 기존 로그인은 유지하고 변경하자”라는 사용자 결정 | AI가 만든 요구사항을 사용자 확인 없이 그대로 저장; 자료 첨부량 |
| Judgment / 판단 | 목적·기준에 따라 대안을 평가하고 선택 이유를 설명함 | 두 안 중 유지보수 비용을 이유로 단순한 안을 선택 | AI가 제시한 안을 자동 채택; 결과물이 예쁨 |
| Orchestrate / 역할·통제 설계 | 사람·AI 역할, 권한, 검토 지점·개입 조건을 정함 | “구현은 맡기되 결제 정책 변경은 내 확인 후 진행” | 도구를 많이 호출하거나 agent 수를 늘림 |
| Verify / 검증 | 근거·반례·한계를 확인하고 확신을 조절함 | 통과 결과의 대상 revision을 확인하고 실패 경계를 추가 검사 | AI가 '테스트 통과'라고 말함; 테스트 요청만 존재 |
| Adapt / 전략 수정 | 피드백으로 문제를 진단하고 접근을 바꾼 뒤 다시 확인함 | 연결 실패 원인을 찾아 인증 흐름을 바꾸고 재검증 | 같은 요청 반복, 결과 변화 없이 재시도 횟수 증가 |
| Ownership / 책임 | 자신의 선택과 도움 범위를 설명하고 결과·오류에 대한 책임을 이어감 | AI가 만든 변경의 영향·한계를 설명하고 오류 수정·후속 확인을 맡음 | 제출 버튼 클릭, 자기 이름 붙이기, AI의 책임 선언 |

같은 사건이 두 항목과 관련될 수 있다. 근거가 같다는 이유로 두 번 점수를 주거나 임의로 한 항목을 강제하지 않는다. Judgment는 적합성·선택 기준, Verify는 믿을 근거·한계로 우선 구분하고 이견을 보존한다. Adapt는 전략 변화, Ownership은 결과 이후 책임으로 구분한다.

기존 7개는 legacy 모델로 읽는다. 새 6개 해석을 원하면 원근거에서 새 interpretation을 생성한다. Intent+Context 합산, Taste의 단순 이름 치환, 과거 점수 비교 그래프 연결을 migration으로 간주하지 않는다. 모든 새 카드에 모델 version을 표시하고 향후 항목 변경은 정의 데이터로 처리한다.

## Jay용 최소 화면과 동작

호스트 안에서는 `연결 상태`, `현재 작업`, `작업 검토`, `제출`, `내 기록`, `기록 일시정지`를 제공한다. 최종 명령명은 호스트 관례를 따른다. 각 호스트에 별도 분석 UI를 만들기보다 동일 카드·검증 결과를 재사용한다.

카드의 첫 화면은 무엇을 하려 했는지, 무엇이 나왔는지, 어떤 판단·확인이 있었는지다. 6개 항목별 보기는 근거를 찾아보는 보조 보기다. 빈 항목을 채우는 숙제가 되지 않게 미관찰을 허용한다. 자동 생성 해석과 Jay의 확인을 시각적으로 구별한다. AI 분석이 없어도 수동 검토·제출 경로가 남는다.

첫 제출 목적지는 Jay 전용 로컬 보관함이다. 서버·다른 사람에게 자동 공유하지 않는다. 원격 팀 수집은 인증·권한·운영 규칙을 갖춘 P1에서 추가한다. 로컬 제출 기록은 자신의 연구 기록을 정리하는 기능이며 팀의 강제 준수를 증명하는 장치가 아니다.

## 변경·복구 경계

측정 장애는 작업 실행을 막지 않는다. 권한 없는 수집은 막고, 누락·열화는 다음 진단에 드러낸다. 제출 성공은 영속 저장 후에만 표시한다. 로컬 전용 데이터 정책은 기존 Studio 학생 정책에 전파하지 않는다. 코드 rollback은 이전 bundle 읽기·삭제를 보존하고 새 수집 지원 범위를 표시한다.
