# 체험·수업 통합 구현 순서

2026-09-10 · [Intent/Epic #915](https://github.com/jayleekr/hypeproof-studio/issues/915)
제품 책임 Jay (`jayleekr`). 상태: 공통 코드 진입 구현·로컬 검증, 활동 전환 경계 구현 중. 공개 전달은 미완료.
[Intent/설계](../design/unified-studio-experience.md), [US 요구사항](../requirements/unified-studio-experience.md),
[US 테스트](../testing/unified-studio-experience.md)가 원본이다. 이슈/PR은 ID와 실행 근거를 연결한다.

## 단계별 작업

| 단계 / 이슈 | 구현 범위 | 선행 조건 | 완료 증거 |
|---|---|---|---|
| US-1 [#916](https://github.com/jayleekr/hypeproof-studio/issues/916) 공통 진입 | US-01~06/12/17. 같은 App에서 체험·수업·이어가기, 기존 코드 확인. 공개 무코드 발급은 P1로 분리 | 기존 NAT/profile/access, 발급 정책 결정 | US-T01~06/13/15. 실제 자격으로 진입하며 잘못된 코드/발급 실패도 관측 |
| US-2 [#917](https://github.com/jayleekr/hypeproof-studio/issues/917) 활동 전환·보존 | US-05~12/18. 기존 저장소 조사와 귀속 ADR, 준비→확정 전환, 실행·자료·비용 경계 | US-1의 진입 계약, #748/#749와 기존 #800 결과 재사용 | US-T06~14/18. 실패/중지/크래시/늦은 이벤트/폴더 충돌 대조와 실제 복귀 |
| US-3 [#918](https://github.com/jayleekr/hypeproof-studio/issues/918) 기존 환경 이행 | US-01/02/10/12/13/18. 앱 사본/localhost 설정·자격·대화/파일 백업과 공개 연결 | US-1/US-2, #911/#912의 현황 | US-T11/13/16/18. 실제 다음 실행의 버전·자격·원본 보존·복귀 확인 |
| US-4 [#919](https://github.com/jayleekr/hypeproof-studio/issues/919) 릴리스 강제 검사 | US-14~16, 공통 App/Service 경로. 기존 fixture/manifest/workflow 확장 | US-1~3의 계약, 지원 OS와 비운영 자격 | US-T01/02/17/19/20. 실패/누락/stale 대조로 자동 차단 후 최종 산출물 인수 |

US-1과 US-2의 계약 조사가 먼저다. US-4의 gate 설계/대조군은 독립 진행할 수 있으나,
아직 없는 제품 흐름을 mock한 성공으로 최종 배포 gate를 충족시키지 않는다. US-3의 이행은
공개 자격·백업·새 연결을 검증한 다음 수행한다. 코드 없는 공개 체험 정책이 미확정이어도
기존 코드 경로와 합성 발급 검증은 진행할 수 있다.

## 기존 이슈와 범위

- #744: native trial의 권한·기록·관측 기반. 이 Epic은 이를 별도 엔진으로 재구현하지 않는다.
- #746/#748/#749: 수업별 Agent 권한·세션·작업 보존. 실행 코드 변경 전 해당 owner와 파일 범위를 조정한다.
- #800: 이용권·예산·정산의 원본. 새로운 체험 전용 사용량 원장을 만들지 않는다.
- #911/#912: 이 Mac의 앱 사본 문제와 공통 배포 확인 절차. 로컬 적용 대기는 별도 현황이며 자동 게이트 완료 증거가 아니다.
- #896: Voice 작업. 같은 릴리스 전달 기준을 적용하되 음성 UI/capability 구현을 이 문서 PR에 포함하지 않는다.

## 추적과 완료 규칙

```text
Lab 제품 전략 (LAB-PRODUCT-ROLES) + 기존 Studio Product Intent (ST-INT-NATIVE)
  → INT-US-01~04 (ST-INT-UNIFIED)
  → US-01~18 (ST-REQ-UNIFIED, 기존 NAT/AB 연결)
  → UX·배포 설계 (ST-DES-UNIFIED)
  → US-T01~21 (ST-TEST-UNIFIED)
  → #916~919 구현 PR → 런별 증거 → 공개 배포·사용자 적용
```

`config/traceability.json`은 위 가족 단위 노드를 연결한다. 개별 US ID의 Intent·테스트 관계는
요구사항 표, 각 테스트의 US 관계는 테스트 표가 소유한다. 새 runtime 구현/validation 노드는
실제 파일과 증거가 생긴 PR에서 등록한다. 계획을 implementation/validation 노드로 만들지 않는다.

각 구현 PR은 문제·변경 행동·US ID·실제 테스트 명령/환경·증거·남은 미실행을 기록한다.
문서 머지는 문서 발행만 완료한다. 구현 이슈는 해당 US 수용을 관측했을 때 닫고, Epic은
P0 기술 인수와 공개 전달/이행 범위가 확인됐을 때 닫는다. P1 공개 발급이 남으면 별도 상태를
유지하고 ‘코드 없이 누구나 즉시 체험’을 출시한 것처럼 쓰지 않는다.

상태는 계획 / 구현 / 검증 / 공개 전달 / 사용자 적용을 따로 기록한다. 테스트 판정은
PASS / FAIL / BLOCKED / NOT RUN이며 빈칸·skip을 PASS로 취급하지 않는다.
운영 발급 정책이나 다른 팀 소유 계약의 결정이 필요하면 해당 이슈에 책임자·결정할 값·
완료 기준을 남기고 그와 독립적인 구현은 계속한다.


2026-09-10 후속: 창별 자격 바인딩, 활동 초안/첨부, 실제 폴더 전환·재시작,
백업 가능한 실행기 이행과 필수 App/Service 릴리스 검사 코드를 추가했다.
[부분 실행과 남은 인수](../testing/unified-completion-917-919-evidence.md)를 기준으로
판정하며 #916~919의 전체 완료나 공개 배포로 간주하지 않는다.
