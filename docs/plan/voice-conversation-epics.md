# 음성 대화 에픽·인계 순서 (#896)

[요구사항](../requirements/voice-conversation.md) · [인수 계획과 현재 결함](../testing/voice-conversation.md).
계획과 제품 인수는 별도다. #904/#910/#914의 머지는 V0 계측/계약 일부의 제출이며 V1–V6 완료가 아니다.

| 순서 | 이슈 | 요구/시험 범위 | 진입 및 종료 조건 |
|---|---|---|---|
| V0 | [#897](https://github.com/jayleekr/hypeproof-studio/issues/897) | VO-01–05 / VO-T01–05 | 계측기의 수명 결함 수정 검증(#929) → 설치본 관측 → 후보 비교/통합 ADR. 계약과 미지원 조건을 고정한 뒤 인계 |
| V4 선행 | [#901](https://github.com/jayleekr/hypeproof-studio/issues/901) | VO-21–25 / VO-T21–25 | V0 계약에 맞춰 기존 인증·자금원·원장을 확장. 실제 유료 연결 전 지속 예산 집행·철회·보존 경계 확보 |
| V1 | [#898](https://github.com/jayleekr/hypeproof-studio/issues/898) | VO-06–10 / VO-T06–10 | V0 이후 합성 세션 개발 가능. 유료 실행은 V4 필요. 실제 시작/끼어들기/종료/정정 인수 |
| V2 | [#899](https://github.com/jayleekr/hypeproof-studio/issues/899) | VO-11–15 / VO-T11–15 | 기존 대화·결과물 revision 재사용. 음성/텍스트 왕복 후 저장·재개 검증 |
| V3 | [#900](https://github.com/jayleekr/hypeproof-studio/issues/900) | VO-16–20 / VO-T16–20 | V0/V1/V4 계약 위에 기존 승인/operation 경로 연결. 발화와 실행 권한 분리, 재접속 중복 실행 방지 |
| V5 | [#902](https://github.com/jayleekr/hypeproof-studio/issues/902) | VO-26–30 / VO-T26–30 | V1–V4 통합 뒤 실제 OS·접근성·지연·soak·기능 비활성 인수 |
| V6 | [#903](https://github.com/jayleekr/hypeproof-studio/issues/903) | VO-31–35 / VO-T31–35 | 사용 가능한 공통 App과 V5 증거 이후 동의된 사람 파일럿. 효과 기준 사전 고정, 부족한 표본은 INCONCLUSIVE |

## 병렬 작업 경계

Claude: extension/worker 및 필요한 Chalk 제품 경로, 제품 단위·계약 테스트.
Codex: 이 세 문서, e2e 독립 재현·실기 인수, 증거 연결.
설계 문서는 Claude 초안 → Codex 검토 → Claude 반영 순서로 편집한다.
공유 파일은 이슈에 경로·범위·base SHA를 예약하고 제출 시 해제한다.
실제 App과 공유 dev stack은 한 세션만 실행한다.

## 현재 다음 행동

1. #929: 늦은 마이크 권한 해제와 재연결 중 음소거 보존을 수정하고 독립 합성 검증을 통과했다.
2. Codex: 수정 포함 main에서 재현을 확인하고 실제 App 슬롯 인수 후 권한/오디오를 관측한다.
3. V0 후보 비교와 통합 ADR을 고정하고 V4 비용 집행과 V1 합성 세션 작업을 분리해서 착수.

공통 App 배포 정책은 [Product Intent](../PRODUCT-INTENT.md)와 기존 release 규칙을 따른다.
개발용 확장 번들 교체나 한 OS의 실기 검증을 참가자용 공통 App 배포 완료로 기록하지 않는다.
## 팝업 UX 구현 분해 (#939)

[VO-36–47 요구/상태표](../requirements/voice-conversation.md) ·
[VO-T36–47 인수](../testing/voice-conversation.md) ·
[정적 화면 구조](../research/voice-popup-wireframe.svg).
기존 V0–V6를 대체하지 않으며 아래는 구현 순서를 위한 작업 묶음이다.

| 순서 | 연결 에픽 | 구체적인 제출물 | 인수 기준과 선행 조건 |
|---|---|---|---|
| UI-1 | #898, #902 | 입력창 버튼, 큰 패널/작은 컨트롤, 키보드·축소·종료 상태의 합성 UI 시안 | VO-36/40/41/47. 실제 마이크 미연결 시 시안으로 표시; 사용자 작업 영역과 컨트롤 가림 여부를 먼저 검토 |
| UI-2 | #897, #898, #901 | 실제 권한/인증/비용 게이트 → 연결 → 짧은 안내 → 음성 왕복 → 관측 기반 움직임 | VO-37/38/39/42/46. V0 설치본 타당성/전송 ADR과 V4 비용 집행 뒤 실제 연결, 실패·늦은 허용도 검수 |
| UI-3 | #899, #900 | 같은 대화 기록, 선택 결과물/revision, 승인 화면 연결, 수업별 이름과 실제 모델 정보 | VO-43/44/45. 기존 profile/conversation/operation 경로 재사용, 화면 공유는 별도 명시적 권한 |
| UI-4 | #902, #903 | 통합된 테스트앱, 실제 OS·마이크·키보드 인수와 짧은 사용자 체험 절차 | VO-T36–47. 자동/합성 검사 후 실제 대화감 검증. 공통 App release gate를 통과하기 전 배포 완료로 표시하지 않음 |

Claude는 UI-1–3 제품/단위·계약 구현을 맡고 Codex는 요구/시안 검토와 독립 인수를 맡는다.
사용자에게는 실행 가능한 테스트앱과 짧은 과제를 제공한다: 버튼으로 시작 → 하고 싶은 일 말하기 →
AI 말 끊고 정정하기 → 작은 컨트롤로 바꾸고 결과물을 보며 수정 → 종료 후 텍스트로 이어가기.
한국어 인식·말 끊기·지연·화면 가림·종료의 확신을 묻고 합성 CI만으로 사용자 경험을 판정하지 않는다.

첫 범위에 별도 OS 창, 아바타 상점, 화면 전체 자동 캡처, 강제 설문, 세션 중 자동 모델 교체를
추가하지 않는다. 장치·전송 계층 ADR은 기존 Claude 초안→Codex 검토 순서로 유지한다.
