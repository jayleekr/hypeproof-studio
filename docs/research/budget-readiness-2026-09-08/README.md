# 예산·정산 구현 인수와 운영 활성화 판단

2026-09-08 America/Chicago (실행 시각은 일부 UTC 2026-09-09). #857 / #800.
**제품의 로컬 인수는 진행했지만 포함형 판매 활성화 근거는 아직 미완료다.**
P1~P4의 코드·인수 위에 P5 복구/SDK 실물 시험과 운영 집계를 추가했다.
[화면 직접 촬영](../access-budget-acceptance-2026-09-08/README.md),
[제품 요구사항](../../requirements/access-budget-settlement.md),
[배포·활성화·복구 절차](../../operations/access-budget-release.md)를 함께 본다.

## 구현에서 보강한 경계

- 계정 연결은 해당 수업의 예산 초기화 전에 끝낸다. 수업 예산/옛 주체의 상한·예약이 생긴 뒤 새 연결은 `seat_link_requires_budget_migration`으로 거부한다. 이미 같은 계정으로 연결된 요청은 멱등이다. 사용 중인 수업의 신원 전환은 별도 이관 계약이 필요하다.
- 연결 계정을 비활성화하면 연결되지 않은 새 좌석으로 돌아가지 않는다. 재활성화 때 동일한 주체가 유지된다. 토큰 재발급으로도 새 한도가 생기지 않는다.
- 강사의 위임 revision뿐 아니라 현재 계약·기간·활성 상태도 mutation transaction 안에서 확인한다. 취소/기간 종료 후 강사 화면은 조회 상태가 되고, 미리 읽은 수정 권한도 새 저장을 허용하지 않는다. 운영자 정산은 별도 권한으로 유지한다.
- 기존 배포 workflow에 additive 0007→0008→0009→0010을 연결했다. 스키마 적용 자체는 상품 게시·금액 승인·수업 opt-in을 하지 않는다. 이 작업에서 실제 배포를 실행하지 않았다.

## 실제 SDK와 공급자 확인

[SDK 결과](sdk-result.json): pinned Agent SDK **0.3.207의 실제 실행 파일** → 로컬 HTTP → 실제 Service/HMAC/SQLite. 공급자 응답만 합성했다.

| 흐름 | 실제 공급자 경로 시도 | 작업 수 | 확인 |
|---|---:|---:|---|
| 일반 채팅 | 1 | 1 | 예약 후 전송, 종료 후 정산 |
| 429 이후 SDK 재시도 | 2 | 1 | 시도별 귀속, 같은 이용권 유지, 429 비용은 미확인 예약 유지 후 별도 확인 증거로 정산 |
| 실제 로컬 파일 Read 후 후속 응답 | 2 | 1 | 실제 파일 내용이 다음 모델 요청에 포함, 파일 유지, 두 호출 모두 정산 |

Read는 SDK의 default 정책에서 자동 허용되어 `canUseTool` callback 횟수가 0이었다.
이 시험을 모든 도구의 승인 UI/권한 검증으로 해석하지 않는다. Subagent fan-out,
Computer Use·이미지·hosted tool의 유료 실행 지원도 이 결과에 포함되지 않는다.

[실제 공급자 결과](live-sdk-result.json): 동일 pinned SDK → 로컬 Service → 기존 Sediment 공급자 프록시 → **실제 Anthropic Sonnet 4.6**의 단일 요청.
실제 `max_tokens=256`, HTTP 200, 입력 3·출력 11·5분 캐시 쓰기 7,217·캐시 읽기 0을 관측했다.
응답의 model/tier/region과 종료·usage가 기존 원가 증거에 들어갔다.
**합성 원가표를 사용하는 격리 시험이므로 `pricing_state=priced`는 실제 청구액을 뜻하지 않는다.**
운영 강의/계약/예산 DB에는 쓰지 않았고, 모델 호출 자체의 공급자 사용량은 발생했다.

캐시 생성이 일반 입력보다 훨씬 컸던 이 요청은 짧은 사용자 질문 길이로 비용 상한을 추정하면
안 된다는 실물 근거다. input/cache bound는 검토된 최대 노출이며 토큰 계측기의 절대 보증이 아니다.
실운영 bounds와 초기 프롬프트·도구 정의·캐시 TTL 분포는 따로 검토해야 한다.

초기 실험의 잘못된 protocol profile, 없는 SQL 열 조회, Read callback 횟수 가정,
시험 코드의 공급자 프록시 헤더 오기는 실패로 분류했다. profile·계측·기존 프록시 헤더를
바로잡아 다시 실행한 결과만 위 결과 파일에 저장했다. 제품의 provider fallback은 추가하지 않았다.

## 실제 운영 기록으로 알 수 있는 것

[집계 결과](production-aggregates.json) · [재현 SQL](usage-distribution.sql).
개인/반 식별자와 대화 본문을 내보내지 않았다. 최종 SELECT 실행은 `rows_written=0`,
`changed_db=false`였다. 최초 `--file` 실행은 SELECT 세 개만 수행했으나 Wrangler가 bulk-import
절차로 처리해 import 메타데이터를 갱신했다. 최종 결과 수집에는 `--command`를 사용했다.

관측 범위 전체에는 2026-07-14~09-09 UTC의 usage_log 16,628건, cohort 식별자 5개가 있었다.
모든 기록의 status가 성공이며 토큰 0 기록이 28개였다. `model_usage_requests`는 0행이었고,
새 usage_attempt_costs/budget 테이블은 운영에 없었다. **오류·보조 호출이 없었다는 뜻이 아니다.**

최근 구간(08-10~09-09 03:25:54 UTC 미만)의 관측:

| 지표 | 기록값 | 해석 제한 |
|---|---:|---|
| 요청 | 9,638 | 모두 Sonnet 4.6으로 기록, 고유 사용자 질문 수 아님 |
| 좌석 식별자 | 85 | 실제 참석자·연구 참여자 수로 확정하지 않음 |
| 입력+출력 토큰 / 요청 P50·P95·최대 | 307 · 10,376 · 28,101 | 캐시 meter를 합산하지 않은 분포 |
| 입력 / 출력 합계 | 9,080,282 / 7,529,574 | 과거 공급자 가격/청구 확정 불가 |
| 캐시 읽기 / 쓰기 합계 | 216,977,647 / 17,011,558 | 과거 TTL별 분해 없음 |
| 상위 약 10% 좌석의 입·출력 비중 | 43.26% | 85개 중 9개, 비용 비중이나 역량 차이가 아님 |
| 평균 기록 지연 | 13,468ms | 응답 품질·학생 체감 지연·성공률 보증 아님 |

**운영 설계에 주는 근거:** 반 공용 pool과 학생별 cap/전용 allocation을 함께 두고,
강사 위임 범위와 수업 마무리 여유를 구분할 필요가 있다. 다만 이 집계는 실제 수업 일정/참석과
대조되지 않았고, 실패·재시도·도구/실행/저장 비용·가격 revision·invoice가 없으므로
상품 포함량이나 소진 예상 시각의 캘리브레이션 완료로 채택할 수 없다.

## 통합 인수 범위

| 요구사항 | 실행한 근거 | 남은 범위 |
|---|---|---|
| AB-01/02/03/05 | P1 계약·개인/수업/기관/결합형, P3 실제 API, P4 출처 선택 | 실제 구매/결제 공급자 adapter·상품 채택 |
| AB-04/06/14 | Hono·D1 위임/CAS/20명 경쟁/10개 예약, P5 계정 lifecycle | 실제 수업 인원 규모/외부 계정 한도 |
| AB-07/08 | 기존 request ID 귀속, 실제 SDK 재시도·Read, 실제 공급자 usage | Subagent fan-out·공급자 invoice 및 실요율 대조 |
| AB-09/15 | 중단된 스트림의 보수적 hold, 취소 후 실행/강사 수정 거부, 8개 동시 갱신·중복 정산, 옛 작업의 새 기간 차감 거부 | 장애 대응의 실제 운영 연습 |
| AB-10 | typed meter 엔진·알 수 없는 hosted/media 실행 거부 | 유료 Browser/Computer Use·격리 실행·저장 meter 연결 |
| AB-11/12/13 | 실제 Mac·Chalk·운영자 화면과 스크린샷, 좁은 폭·확대·소진 보존 | Windows·화면낭독기 음성·실제 사용자 인수 |
| AB-16/17/18 | 보수적 미정산·원가/청구 분리·운영 비활성·학습 연구 분리 | 승인된 상품 조건/원가·사람 연구(Lab #777 E) |

P5 `test:budget-recovery`/`:d1`은 실제 Hono/SQLite와 workerd/D1에서 실행했다.
이전 기간의 미정산 예약을 둔 채 갱신해도 새 포함량은 한 번만 생기며,
늦은 옛 정산은 옛 기간에만 반영된다. 계약 종료·토큰 재발급·계정 중단은 지급 이벤트가 아니다.

## 재현

```sh
cd worker
npm test
npm run typecheck
npm run test:budget-recovery:d1
cd ../e2e
npm run test:budgets:sdk

# 외부 모델 호출 1회를 포함하는 수동 시험. private vars 값은 출력하지 않는다.
HPS_BUDGET_LIVE=1 HPS_BUDGET_DEV_VARS=/absolute/private/.dev.vars \
HPS_BUDGET_EVIDENCE=/tmp/live-sdk-result.json npm run test:budgets:live-sdk
```

운영 집계는 SQL 파일을 `--command` 인자 값으로 전달하는 기존 Wrangler D1 조회로 재현한다.
기간을 변경하면 새로운 관측으로 기록해야 하며, 과거 결과를 덮어써 같은 실험이라고 하지 않는다.
제품 PASS·운영 비용 관측·사람의 학습/전이/유지 결과는 각각 별도로 보고한다.
