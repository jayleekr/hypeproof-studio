# 후보 역량·이용권·예산 인수 계획

2026-09-08 · 상태: 미실행 테스트 계획 · Lab #777 / Studio #800.
대상: [HC 계약](../requirements/capability-model-contract.md),
[AB 계약](../requirements/access-budget-settlement.md).
이 문서와 traceability node의 존재는 실행 결과가 아니다. 기존 #839/#840/#843 근거는 해당
구현 범위에만 유효하며 새 금액 예산·구독 계약을 증명하지 않는다.

## 제품 인수 시나리오

| ID | 양성·음성 대조와 관측 대상 | 요구사항 / 실행 레이어 |
|---|---|---|
| CA-T01 | 수업 이용권·개인 구독·기관 계약 게시; 포함량/revision 누락 거부; 달력 월/30일 구별; 동시 갱신 한 번만 지급 | AB-01/14; Service 실제 DB |
| CA-T02 | 알려진 공급자 2종의 캐시 포함/별도 토큰, TTL·모델·service tier·통화 환산; 가격 미상은 미정산; 현재 가격 변경이 과거 행을 바꾸지 않음 | AB-01/08; 공식 schema 기반 fixture + 실제 응답 대조 |
| CA-T03 | 개인이 코호트 없이 허용된 작업 성공; 위조 contract/다른 사용자/다른 기관/옛 앱 직접 API 거부; 설정된 예산 게이트 우회 불가 | AB-02/03/18; 실제 인증+Service/SDK/proxy |
| CA-T04 | 담당 강사만 자기 배분 조정; 다른 반·기관 총예산·개인 잔액·가격 변경 거부; 이름/프롬프트/BYO로 권한 확대 불가 | AB-03/04/12; API + Chalk |
| CA-T05 | 구독자가 수업 지원분으로 실행 후 개인 출처를 명시 선택; 두 출처 차감 없음; 수업 소진/오류 때 자동 전환 없음 | AB-05; Service + 실제 App |
| CA-T06 | 합성 상한 100단위, 시도 예약 10단위, 서로 다른 20개 동시 요청: 가용 범위만 승인; 공용+학생+슬롯 일부 실패 시 부분 차감 0 | AB-06/10; 독립 연결/실제 D1 직렬화 검증 |
| CA-T07 | 마지막 잔여에 2개 반·학생 경쟁; 강사 동시 증액/축소 revision 충돌; 재로그인/재발급 사용량 보존; 상위 할당/하위 사용 이중 차감 없음 | AB-04/06/15; DB 경쟁·fault injection |
| CA-T08 | 저장 성공 후 ACK 소실, 동일 보고 중복, 늦은 보고, 중지 후 양의 usage, 프로세스 소실을 주입; 실제 시도마다 최대 한 번 정산 | AB-07/09; Service 실제 DB+공급자 stub |
| CA-T09 | SDK 보조·재시도·2모델 비교·검색·sandbox meter별 귀속; 기존 3기록을 함께 조회해도 합산 중복 없음; 공급자 청구 소계 차이를 조정으로 유지 | AB-07/08/10/16; SDK/proxy통합+청구 합성 fixture |
| CA-T10 | 미정산 예약 만료 시 잔액 자동 복구 없음; 종료 증거 없이 슬롯 재사용 없음; 지연 보정 후 부분량 이중 차감 없음; 실제 초과는 초과 노출로 표시 | AB-09/15; 장애/복구 통합 |
| CA-T11 | 학생·구독자·강사·운영자 화면의 출처/범위/as-of/unknown 표시; 타인 원가·원문 비노출; 390px/1280px/200%·키보드/읽기 순서 | AB-11/12, HC-06; 실제 브라우저·Mac 캡처 |
| CA-T12 | 한도 소진·갱신 대기·구독 종료에도 Stop/파일/자기 결과/내보내기 성공; 새 유료 작업은 거부; 서버 장애가 예산 무제한으로 바뀌지 않음 | AB-13/18; 실제 App + 이전 배포 앱 |
| CA-T13 | 서명 위조·중복·역순 결제 이벤트, reconciliation 재수신, 기간 경계의 진행 중 요청; 결제 복귀 URL만으로 권한 지급 불가 | AB-14; 선택된 공급자 sandbox+Service |
| CA-T14 | 미설정 기존 수업 계약 보존; opt-in 대상만 새 게이트; 배포 rollback이 예약/정산을 지우지 않음; 사용량이 실제 결제·입금·급여 지급을 발생시키지 않음 | AB-16/18; migration/이전 클라이언트/모의 배포 |
| CA-T15 | 동일 행동의 유료/무료·높은/낮은 Effort 조건에서 평가가 가격만으로 달라지지 않음; 예산 차단 시 수행 실패 대신 관측 제약 | AB-17, HC-04/07; evaluator 대조, 아래 연구와 구분 |
| CA-T16 | 원본 legacy evidence/키/hash/이전 export 보존; 두 버전 해석 공존; Intent+Context 산술결합 거부; LLM model과 capability version 혼동 거부 | HC-01/02/03; 기존 관측 schema·read/write/export |
| CA-T17 | null·needs_review·provisional/confirmed와 모델 타당화 상태 구분; 철회/삭제·미관찰·새 해석으로 원본 덮어쓰기 거부 | HC-02/03/05/06; API+화면 |
| CA-T18 | AI가 생성한 목표/검수와 사람 채택 구별, 도움 조건 누락 시 독립 수행 확정 거부, 연구 audit 없으면 새 evaluator 활성화 거부 | AB-17, HC-04/05/07/08; provenance/evaluator 계약 |
| CA-T19 | 실제 사람의 pre-task·intervention·다른 post-task, 평가자 2명 원판정/불일치, 다른 도메인·2–4주 후 과제의 실행 여부 보고 | HC-08; human study, 자동 제품 테스트로 대체 불가 |

100/10/20은 합성 경쟁 시나리오의 단위이며 운영 기본 예산이 아니다. SQLite 테스트만으로
D1의 원자성을 확정하지 않는다. DB API의 실제 transaction/실행 의미를 확인하고 같은 불변식을
로컬 workerd/D1 또는 격리된 테스트 환경에서 재현한다. 외부 계정 한도는 통제 가능한 범위만 검증한다.

## 실행 증거 요구

각 실행은 코드/계약/가격 revision, API 경로, principal 범위, DB 환경, 요청·시도 수,
기대/관측, 차감 전후·미정산·오류, 화면 캡처를 남긴다. 비밀/실학생 데이터는 사용하지 않는다.
실제 공급자 호출과 합성 공급자 응답을 분리하고, mock 화면 캡처를 실제 앱 검증으로 보고하지 않는다.
테스트가 실패하면 제품 문제와 계측기 문제를 양성·음성 대조로 구분한다.

## 연구 결과의 별도 판정

CA-T19는 Lab 연구 프로토콜을 따른다. 후보별 구조 타당성, trainability, transfer, retention을
각각 보고한다. 작은 파일럿이나 제품 CI PASS로 여섯 후보의 타당성을 확정하지 않는다.
모델/도구/도움·도메인 경험·예산 부족과 접근성 차이를 교란 요인으로 기록한다.
참여하지 않거나 자원이 부족했던 사람을 낮은 역량으로 분류하지 않는다.

## 출시 조건

코드 단위 완료는 관련 CA-T 제품 시험의 실제 실행 근거와 담당 범위의 문서가 있어야 한다.
포함형 판매 활성화는 별도로 확정된 상품 계약/가격 revision, 원가 계측·동시 예약·복구 근거,
실제 수업의 분포와 운영 판단을 요구한다. 가격을 정하지 않아도 합성 검증은 가능하다.
연구 타당화와 판매·결제 활성화는 서로의 완료 조건을 대신하지 않는다.


## P1 실제 실행 기록 (#853)

2026-09-08, Mac arm64 / Node 24.4.1. 합성 principal·가격 계약을 사용했고 운영 설정/결제는 변경하지 않았다.

- `cd worker && npm run test:access`: 실제 Hono/기존 HMAC·issuer gate/SQLite를 통한 게시 충돌, 불완전 조건, 운영 합성 거부, exact digest 승인, 중복·역순·중지·재개, 기간 변경 rollback, 개인/수업/기관 격리, 자동 출처 선택 없음, 토큰 재발급/기능 미설정 회귀 PASS.
- `cd worker && npm run test:access:d1`: 실제 local workerd/D1에서 12개 동시 동일 이벤트가 기간 1개만 생성, 12개 역순 revision의 최신값 유지, 전체 batch rollback, migration 반복, 끝 시각 배제, 갱신 후 옛 이벤트 재전송 PASS.
- 기존 `npm test`와 `npm run typecheck` PASS. 이 결과는 이용권 저장/조회 부분의 증거다.

CA-T01/03/04/05/13/14의 위 API 부분만 실행했다. 개인 AI 실행·원가 정산·공용 예산·강사 배분 UI·실제 결제 sandbox·Mac 화면·실제 수업 관측과 사람 연구는 아직 이 기록의 PASS 범위가 아니다.


## P2 실제 실행 기록 (#854)

2026-09-08, Mac arm64 / Node 24.4.1, 합성 공급자 응답과 가격/환율. 실제 고객 결제/공급자 invoice 조회/운영 활성화 없음.

- `npm run test:costs`: 실제 Hono/SQLite에서 기존 시도 ID 귀속, 중복/지연/역순 정산, job 비용 출처 불변, Anthropic TTL과 OpenAI inclusive cache/reasoning, 정수 ceil/FX/overflow, 미확인 원가, 도구 seconds meter, 미전송 증명 거부, invoice 조정 및 admin-only 권한 PASS. 실제 `/v1/chat/completions`의 공급자 응답 hook을 합성 upstream으로 실행하여 원가 1행 생성 확인.
- `npm run test:costs:d1`: 실제 local D1에서 12개 중복 등록/보고가 시도·정산을 늘리지 않음, 역순 12개 snapshot 최신값, job 충돌 전체 rollback, 저장 후 ACK 소실 재전송 PASS.
- 원가 snapshot이 부분 보고로 보정되면 예전 확정 금액을 그대로 유지하지 않는다. 금액 예산의 보수적 예약/초과 처리는 #855의 별도 검증이다.

CA-T02/08/09/10의 원가 부분만 실행했다. 실제 SDK CLI fan-out, 전체 pre-dispatch 예산, 외부 공급자 청구 대조, 실제 수업/화면/사람 연구는 이 결과에 포함하지 않는다.


## P3 실제 실행 기록 (#855)

2026-09-08, Mac arm64 / Node 24.4.1. 합성 가격·주체·공급자 응답이며 운영 데이터는 사용하지 않았다.

- `npm run test:budgets`: 실제 Hono/HMAC/SQLite에서 proxy와 SDK의 전송 전 예약, 필수 출처가 없는 옛 클라이언트 거부, 공급자 1회 호출/정산, 개인의 수업 없는 실행, 공용 allocation/cap·token 재발급·job 출처 불변, 미확인/종료/미전송/중복/늦은 비용·음수 노출·credit, 역할/지원하지 않는 도구와 media 거부 PASS.
- `npm run test:budgets:d1`: 실제 local workerd/D1에서 20명 동시 요청 중 10개 예산만 예약, 실패 시 job/시도도 rollback, 12개 동시 동일 원가 및 역순 snapshot, 배정 실패 rollback, pause revision 충돌, migration 반복 PASS.
- 기존 Worker 회귀와 typecheck PASS. 테스트의 91 microUSD 견적·910 총액은 합성 유리수 요율에서 산출한 값이며 판매/공급자 운영 가격이 아니다.

CA-T03/05/06/07/08/10/12/13의 위 Service 부분을 실행했다. SDK CLI 자체 fan-out, 실제 공급자 과금과 청구 대조, 강사/App 화면·실제 수업은 이 기록의 PASS 범위가 아니다. 실제 화면·복구·출시 판정은 P4/P5에서 이어진다.


## P4 실제 실행 기록 (#856 / #847)

2026-09-08, Mac arm64 / Node 24.4.1. [스크린샷과 인수 근거](../research/access-budget-acceptance-2026-09-08/README.md).

- `npm run test:budget-surfaces`: 실제 Hono/HMAC/SQLite에서 issuer 역할만으로 수정 거부, 위임 ceiling/반/학생 격리, CAS, 검토 요청의 예산 부여 없음, 위임 취소 후 mutation rollback, 종료 후 조회, 나중에 만든 cap의 기존 사용량 포함 PASS.
- `npm run test:budget-surfaces:d1`: 실제 local workerd/D1에서 cap 기존 시도 귀속, 8개 동시 위임 갱신 중 1개 성공, grant/revoke 이력 각 1개, 위임 취소 후 예산 저장 rollback PASS.
- Chalk `test:budgets`: 실제 Service 전달에서 위조 CF/funding 헤더 제거, 학생/Basic/운영 API 전달 거부 PASS. App `access-client.smoke`는 DTO 미확인 숫자·기능 교집합·SDK ambient funding 제거/주입 거부 PASS.
- `e2e/access-budgets/browser.mjs`: 실제 Chromium → Chalk → Service/SQLite에서 390/1280·200% CSS page zoom, 키보드 새로고침, 학생 cap/pause 영속화, 다른 반 강사 거부, 운영자 인증 조회 PASS.
- `e2e/access-budgets/mac.mjs`: 실제 Mac 앱 복사본에 후보 확장을 넣고 번들 hash 대조. 직접 출처/모델 선택, 작성 중 초안 보존, 390/1280 CSS px와 실제 앱 200% 확대, 합성 SSE의 예약→1회 전송→정산, 소진 후 호출·대체 출처 없음/기존 파일·작성란 보존 PASS.

실제 공급자에 대한 CLI 보조 호출/청구 검증과 실제 수업 원가 분포는 P5 출시 판정이다. 화면에 보이는 합성 금액을 운영 포함량으로 채택하지 않는다.
