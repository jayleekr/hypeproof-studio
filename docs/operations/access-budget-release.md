# 이용권·예산 배포와 포함형 활성화

상태: P1~P5 구현/인수 후보, 운영 미활성. #800 / #857.
[요구사항](../requirements/access-budget-settlement.md), [설계](../design/access-budget-settlement.md),
[실제 인수와 집계](../research/budget-readiness-2026-09-08/README.md)를 따른다.
**코드 배포, 포함형 상품 활성화, 실제 결제 연동은 각각 별도 상태다.**

## 1. 현재 판정

로컬 Service/Chalk/App, D1 경쟁·중복·복구, 실제 pinned SDK 채팅/재시도/Read를 실행했다.
단일 실제 Anthropic 요청에서 model/tier/region/cache TTL 사용량 수집도 확인했다.
운영 usage_log의 집계는 있으나 참석한 실제 수업과 대조된 분포, 실패·보조 호출·도구 비용,
공급자 invoice/승인된 요율 및 판매 계약이 아직 없다. 현재 결론은 **운영 포함형 활성화 불가**다.
제품 테스트 성공으로 Lab #777의 사람 연구 결과나 상업 조건 채택을 대신하지 않는다.

현재 실행 지원은 Anthropic Messages/OpenAI Chat의 확인 가능한 text 및 허용된 로컬 도구다.
BYO, 유료 Computer Use/hosted tools, 이미지·음성, 별도 저장·격리 실행 비용은 아직 연결되지 않았다.
상품 범위로 약속하려면 해당 런타임·meter·실제 공급자·복구 인수를 먼저 추가한다.

## 2. 검토자가 채워야 하는 활성화 자료

| 자료 | 필수 내용 | 현재 |
|---|---|---|
| Lab 가격 정본 | repository/path/commit/content hash/PRICING_VERSION과 채택 기록 | exact-source 검증기는 구현, 운영 artifact 미확정 |
| 판매 계약 revision | SKU, 금액/통화, 포함 meter·양, 모델/Effort/기능/runtime, 기간·timezone·갱신·초과·이월·유예 | 합성 fixture만 있음 |
| 공급자 원가 revision | provider/model/protocol/tier/region/유효기간, 캐시 TTL·meter별 정수 유리수 요율·반올림·FX | 실제 usage 단일 관측, 운영 요율/청구 대조 없음 |
| 실수업 원가 자료 | 실제 수업 일정·참석 범위와 대조한 P50/P95/상위 사용, 초기 prompt/cache, 보조/재시도·도구·실행·저장·미정산 비용 | legacy 집계만 확보, 검증된 비용 분포 아님 |
| 노출/운영 판단 | input/cache/output bound 근거, 전체/개인 동시 슬롯, 강사 위임 ceiling, 마무리 여유, 부족 시 처리 | 기본값 없음, 운영 판단 필요 |
| 복구 및 릴리스 | 정확한 Service/Chalk/App revision, schema, 인수 결과, pause/정산/호환 최소 버전, 운영 담당 | 아래 절차와 합성 인수 있음, 운영 연습 미실행 |
| 실제 결제 연결(사용하는 경우) | 검증된 서버 이벤트·멱등 키·갱신/중지/환불 대조, 공급자 sandbox 결과 | webhook adapter 미구현; redirect를 신뢰하지 않음 |

소규모 로그만으로 포함량을 가격표에 넣지 않는다. 운영자는 자료 링크를 남긴 뒤 계약과
원가표의 **정확한 digest**를 별도로 승인한다. 정산 승인과 매출/입금/강사료 지급은 다르다.
현재 엔진은 초과 deny·이월 none·유예 none·갱신 none/calendar만 지원한다.
다른 조건을 팔려면 요구사항과 엔진을 먼저 확장해야 한다.

기존 read-only source 검증:

```sh
cd worker
node --experimental-strip-types scripts/verify-access-publication.mjs PLAN.json LAB_CHECKOUT
```

출력의 `source_verified=true`는 원문 일치만 뜻한다. 상업 조건 승인이 아니다.
합성 plan/price를 운영에 게시하거나 테스트 금액의 digest를 승인 목록에 넣지 않는다.

## 3. 코드 배포 순서

1. 상위 철학/Intent와 계약 변경을 검토하고 의존 PR을 순서대로 반영한다. 현재 체인은 Lab #782, Studio #858 → #860(P1) → #861(P2) → #863(P3) → #866(P4) → #857의 P5 구현 PR이다. CI와 검토·채택 상태를 각각 확인한다.
2. 관련 Worker/Chalk/App 테스트, D1 계약 시험, 이 보고서의 후보 버전 인수를 확인한다. App은 후보 확장을 기존 셸의 격리 복사본에 넣어 검증했고, Windows 전체 릴리스 인수는 별도다.
3. 기존 `deploy-worker` workflow를 사용한다. 기본 dry_run에서 테스트만 수행한다. 실제 배포는 기존 live-session freeze와 버전/승인 조건을 통과해야 한다. P5는 이 workflow에 additive 0007~0010 순서를 추가했다. 기존 데이터/테이블을 지우거나 schema.sql로 운영을 초기화하지 않는다.
4. Service의 새 API를 먼저 준비하고 Chalk/App 후보를 해당 버전에 연결한다. `HPS_ACCESS_CONTRACTS` 및 승인 digest 미설정 상태에서는 포함형을 활성화하지 않는다. 단지 화면을 확인하려고 실제 수업을 required로 바꾸지 않는다.
5. 승인된 포함형을 켤 때만 동일 릴리스의 API로 account/seat/organization 관계 → 승인 plan/price → 검증된 계약 event → period root → class allocation/cap/강사 delegation 순서로 게시한다. **좌석 계정 연결은 수업 예산 생성 전**이다. 이미 운영 중인 수업의 신원 이관은 별도 작업이다.
6. 허용할 대상의 course policy를 마지막에 required로 바꾸고, 지원 App에서 명시적으로 출처를 선택해 확인한다. 개인 계정은 가짜 수업을 만들지 않는다. 이전 App이 필수 출처 없이 호출하면 거부되어야 한다.
7. 원가 unknown·reservation/slot·overrun, provider 실제 모델/tier/region, 시도와 job, 잔여·강사 역할을 확인한다. 실패하면 다음 절차로 새 호출부터 멈춘다. 모니터 결과를 성공으로 가정하지 않는다.

`HPS_USAGE_REGION`은 확인된 가격 차원과 맞아야 한다. approved plan/price digest를 넣는 방식은
기존 환경 배포에서 값이 보존되는지 확인하고 사용한다. 코드의 임의 기본값이나 일괄 활성화를 추가하지 않는다.
위 순서를 문서화했지만 운영에 실행한 것은 아니다.

## 4. 차단·정산·rollback

1. 운영자가 기존 `/admin/access/budget-roots`와 `/:id` 조회로 대상 기간·root revision을 확인하고 해당 root를 `paused=true`로 CAS 저장한다. 강사는 자신의 위임 범위만 중지한다. 저장 충돌이면 최신값을 다시 검토한다.
2. 새 요청이 공급자에 나가지 않는지 확인한다. 이미 실행된 작업은 자체 중지/완료 정책을 따른다. Stop·타임아웃·HTTP 429·ACK 소실은 무료 증거가 아니다. reserved/sent/unknown 슬롯과 미확인 비용을 시간만으로 반환하지 않는다.
3. 운영자 ledger에서 기존 request_id·job·계약/기간·price revision·누적 evidence version을 대조한다. 실제 공급자 증거로 정산하고, 확인된 미전송만 취소한다. 청구 차이는 invoice adjustment에 별도 기록한다. 재전송은 동일 id/version을 쓰고 원문을 덮어쓰지 않는다.
4. 다음 기간이 시작되어도 옛 예약과 지연 정산은 옛 기간에 남긴다. 새 기간 root 생성은 멱등이며 같은 job을 새 기간으로 옮기지 않는다. 영구 미확인 비용은 별도 노출 검토 대상으로 남긴다.
5. 정산 API가 작동하도록 `HPS_ACCESS_CONTRACTS`는 유지한다. 플래그를 먼저 끄면 게시·조회·정산 도구도 닫힌다. 갑작스러운 off는 이미 required인 수업을 거부하지만 정상 복구 절차가 아니다.
6. 되돌릴 코드도 **P3 이후의 서버 예산 거부/정산 계약을 보존해야 한다.** 최초 활성화 후 P3 이전 서버로의 단순 버전 rollback은 이전 앱에 무제한 경로를 다시 열 수 있다. 호환되는 수정 릴리스를 우선 사용하고, addon 테이블·event·period·receipt는 삭제하지 않는다.
7. 학생 결과 파일·대화·초안 열람과 내보내기는 과금 게이트에서 분리한다. P4 실제 Mac에서 소진 후 보존을 확인했다. 클라이언트 rollback에도 SecretStorage·작업 폴더·기존 history를 초기화하지 않는다.

실제 운영 중 장애 리허설, 공급자 invoice 및 승인 상품으로 수행한 최종 활성화 결과는 아직 없다.
#857은 이 외부 근거가 갖춰질 때까지 완료로 닫지 않는다.
