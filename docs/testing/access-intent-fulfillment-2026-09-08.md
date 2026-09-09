# Intent와 요구사항 충족 현황

2026-09-08 America/Chicago · #800, #746, Lab #777/#780.
판정 대상: Lab #782와 Studio #858/#860/#861/#863/#866/#867의 문서·구현·실행 근거.
**추적 연결은 되어 있다. 요구사항 전체의 실현이나 Intent의 사용자 효과가 모두 검증된 것은 아니다.**

유지보수자가 테스트 통과 후 해당 PR들의 머지를 승인했다. 이는 문서/코드의 병합 승인이다.
후보 역량의 과학적 타당화·사람의 학습 효과·상품 금액·운영 과금 활성화는 이 승인에 포함하지 않는다.
Lab 정본은 [1de0d9b8](https://github.com/jayleekr/hypeprooflab/blob/1de0d9b84ee51880ef9fcc70688b18c1afa4ac4e/PHILOSOPHY.md),
제품 Intent 원본은 같은 커밋의 [INT-ACCESS-01~08](https://github.com/jayleekr/hypeprooflab/blob/1de0d9b84ee51880ef9fcc70688b18c1afa4ac4e/products/studio/access-and-pricing-intent.md)이다.
이 원본이 스스로 표시한 제품 설계 가설/초안 상태와 역사적 기록을 덮어쓰지 않는다.

## 판정 기준

- **범위 내 구현·검증:** 현재 지원하는 계약/모델/런타임에 해당 행동이 있고 실제 테스트했다. 모든 공급자·운영 환경에 대한 보증은 아니다.
- **부분:** 일부 행동과 증거는 있지만 같은 요구사항의 다른 사례 또는 운영/사용자 인수가 남았다.
- **미구현·미검증:** 문서/이슈만 있거나 필요한 실험이 실행되지 않았다.

CI는 관련 회귀 테스트의 통과를 보여준다. 테스트가 없는 요구사항, 사용자의 이해와 판단 개선,
실제 수업의 지원 가능 규모, 현재 청구액을 증명하지 않는다. 단일 완료율을 계산하지 않는다.

## Intent → 실제 행동 → 남은 검증

| Intent | 구현되어 확인한 행동 | 아직 충족을 주장할 수 없는 부분 |
|---|---|---|
| 01 포함 범위·비용 부담 이해 | App 명시적 출처 선택, 포함/잔여/미확인 표시, 자동 개인 비용 전환 차단 | 실제 상품 조건·요율 확정, 학생이 비용 부담을 이해하는지 사용자 인수 |
| 02 강사의 여러 반 운영 | 기존 issuer scope + 대상 반/위임 ceiling, 기관/반/학생 allocation·cap, 동시 수정/권한 취소 차단 | 실제 수업 규모·개입 시간·예상 소진과 마무리 여유 조정의 효과 |
| 03 수업 없는 개인 이용 | 개인 account 계약/기간으로 API 실행, 가짜 cohort/session 생성 없음 | 구매·로그인·결제 공급자 연결과 실제 개인 고객의 전체 진입 인수 |
| 04 겹치는 이용권의 명확한 출처 | 작업당 출처/기간 불변, 중복·이중 차감 방지, 같은 작업에서 출처 변경 거부 | BYO 실행, 모든 복합 상품/공급자 도구 조합 |
| 05 결과 소유·중지·검증 지속 | 실제 Mac에서 소진 후 파일·대화·초안 유지, 종료된 계약의 자기 상태 조회 | Windows, 전체 내보내기/재열기·구독 만료 흐름, 실제 수업 마무리 경험 |
| 06 실제·예약·미확인·포함량 구분 | 원가/예약/청구 조정 분리, SDK 실제 재시도·Read 후속 호출별 귀속, 늦은 정산 | 실제 공급자 invoice/요율·환율 대조, 검증된 실수업 원가와 예측 |
| 07 구매 등급과 역량 구분 | 비용/모델 가격을 역량 점수로 계산하지 않음, 실행 설정·원가 증거 구분 | HC 모델/정의/rubric 버전·도움 출처의 전체 관측/내보내기(#852), 사람 연구 |
| 08 같은 권한 집행 계약 | 개인·수업·기관 모두 Service 집행, Chalk는 기존 forwarder, App은 검증된 DTO 사용 | 유료 Browser/Computer Use·hosted/media/격리 실행·BYO의 같은 집행 경로 확장 |

상위 Product Intent의 **human judgment stays visible**는 이번 명시적 선택·권한·미확인 표시로
지원한다. **useful work first / minimum necessary intervention**는 예산 화면이 실제 과제를
불필요하게 방해하지 않는지 추가 인수가 필요하다. **learning is embedded / evidence over claims**의
학습 효과는 코드 존재만으로 확인되지 않는다. 검증해야 할 사용자 경험 가설로 남는다.

## AB-01~18의 수용 기준별 현황

| 요구사항 | 판정 | 실행 근거와 남은 경계 |
|---|---|---|
| AB-01 상품/원가 revision | 부분 | immutable 계약·exact digest 검증 구현; 승인 운영 상품/원가 artifact 미확정 |
| AB-02 개인/수업/기관/비용 주체 | 부분 | 개인/수업/기관/결합 API 인수; BYO 실행은 미지원 |
| AB-03 정책 교집합 | 범위 내 구현·검증 | Service/profile/lesson/entitlement/runtime deny 우선, 미지원 도구·media 거부 |
| AB-04 위임·역할·동시 수정 | 범위 내 구현·검증 | 실제 issuer/반/학생 격리, ceiling/CAS/취소, 계약 종료 후 강사 수정 거부 |
| AB-05 작업별 출처 불변 | 범위 내 구현·검증 | 같은 job 출처/기간 변경과 자동 대체 거부; 실제 App 직접 선택 |
| AB-06 원자 예약·상한 | 범위 내 구현·검증 | 실제 D1 20명/10개 예약, 슬롯·allocation/cap, 계정/재발급으로 초기화 불가; 운영 규모는 별도 |
| AB-07 실제 시도별 정산 | 부분 | 실제 SDK 채팅·재시도·Read 후속 시도, 중복 evidence 멱등; subagent fan-out·모델 비교 전체 미실행 |
| AB-08 실제 가격 차원 | 부분 | 모델/tier/region/TTL 수집, 정수 원가 계산; 실제 요율/FX/invoice 대조 없음 |
| AB-09 미확인·지연 정산 | 범위 내 구현·검증 | interrupted hold·unknown·미전송 증명·중복/늦은 정산, 취소/갱신 후 과거 기간 유지 |
| AB-10 브라우저/실행/저장 meter | 부분 | typed meter 엔진과 미계측 실행 거부; 실제 유료 executor 연결 미완료 |
| AB-11 학생 안내·요청 | 부분 | 실제 App 선택/잔여/요청 화면; 확정 상품을 사용한 학생 이해도·접근성 전체 미검증 |
| AB-12 강사·운영자 조회 | 부분 | 실제 Chalk/운영자 범위별 조회; 예측은 검증된 분포 부재로 unavailable |
| AB-13 만료/소진 후 결과 보존 | 부분 | 실제 Mac 소진 보존과 종료 후 API 조회; 모든 OS/만료/내보내기 전체 인수 아님 |
| AB-14 구독 이벤트·기간 | 부분 | 검증 참조를 가진 운영자 이벤트·역순/중복/기간 API; 실제 결제 webhook adapter/sandbox 없음 |
| AB-15 잔여·미정산·초과 표시 | 범위 내 구현·검증 | 금액 미상 유지, 예약/소계/기준 시각·음수 노출·새 실행 거부; 질문 수 추정 안 함 |
| AB-16 사용 정산과 청구/입금 구분 | 부분 | 별도 invoice adjustment, 자동 입금/급여 지급 없음; 실제 회계/청구 대조 연결 미완료 |
| AB-17 실행 조건과 역량 | 부분 | 비용 비점수화 경계 유지; 관측 조건 전체 provenance/버전 인수는 HC/#852 |
| AB-18 명시적 활성화·이전 App | 범위 내 구현·검증 | required 대상 서버 집행·옛 App 거부·flag off 우회 방지; 운영 대상 opt-in은 미실행 |

## 이번 예산 구현 바깥의 요구사항

- **HC-01~08 / #852:** 역사적 키와 자료를 자동 개명하지 않았지만, 새 `capability_model_version`·정의/rubric·actor별 interpretation 저장/내보내기는 미구현이다. 최소 construct audit 후 진행한다.
- **Epic #746의 AE-01~44 전체:** 이름/모델/Effort/정책과 예산의 일부가 구현됐다고 E1~E7 전체가 완료된 것은 아니다. 브라우저의 검수 증거·재검증, 전체 SDK 복구/자료 배제, 모델 간 읽기 검토·Auto/인계·비교 학습, 격리 Computer Use는 각 에픽의 완료 조건을 따른다.
- **Lab #778/#779:** 연구 초안이 존재해도 최소 construct audit·독립 평가·전이·유지의 완료와 다르다. 제품 CI와 연구 기록을 혼동하지 않는다.
- **Lab #780:** 이번 변경은 merged source pin과 `LAB-INT-ACCESS` parent 연결만 수행한다. 전체 공개 표현/콘텐츠/측정 UI 이관은 하지 않았다.

## 이번 병합 확인

아래 PR들은 각 단계의 최신 main을 반영한 head에서 보고된 검사를 모두 통과한 뒤 순서대로 병합했다.
Studio의 필수 4개 검사도 각각 성공했다. #860~867의 원래 패치와 rebase 후 패치는 `git range-diff`에서 동일했다.
실제 UI·SDK 인수는 연결된 보고서의 기록된 후보/환경에 대한 증거이며 이번 문서 변경에서 다시 실행한 것으로 표시하지 않는다.

| PR | 검증한 head | 보고된 검사 | 병합 commit |
|---|---|---|---|
| [Lab #782](https://github.com/jayleekr/hypeprooflab/pull/782) | `c683ba47` | 8/8 성공 | [`1de0d9b8`](https://github.com/jayleekr/hypeprooflab/commit/1de0d9b84ee51880ef9fcc70688b18c1afa4ac4e) |
| [Studio #858](https://github.com/jayleekr/hypeproof-studio/pull/858) | `c91db1c9` | 16/16 성공 | [`be59cd42`](https://github.com/jayleekr/hypeproof-studio/commit/be59cd4252148ec29a009b92e236fc20f0527c4b) |
| [Studio #860](https://github.com/jayleekr/hypeproof-studio/pull/860) | `f78e19fa` | 16/16 성공 | [`56261e5d`](https://github.com/jayleekr/hypeproof-studio/commit/56261e5d22b6db0cbfd33f61ba9a8741f280e3d5) |
| [Studio #861](https://github.com/jayleekr/hypeproof-studio/pull/861) | `71dba976` | 16/16 성공 | [`a214791a`](https://github.com/jayleekr/hypeproof-studio/commit/a214791ae928a427254df27bce699cc6e3a32906) |
| [Studio #863](https://github.com/jayleekr/hypeproof-studio/pull/863) | `568dacab` | 16/16 성공 | [`bbe3ccb6`](https://github.com/jayleekr/hypeproof-studio/commit/bbe3ccb6a48150e6352a8a059a4a4b002d3791c4) |
| [Studio #866](https://github.com/jayleekr/hypeproof-studio/pull/866) | `889da244` | 18/18 성공 | [`e7a26b1b`](https://github.com/jayleekr/hypeproof-studio/commit/e7a26b1b489278e8ab11604c9202024d8ecef107) |
| [Studio #867](https://github.com/jayleekr/hypeproof-studio/pull/867) | `a7f654df` | 18/18 성공 | [`a3521a2e`](https://github.com/jayleekr/hypeproof-studio/commit/a3521a2e2b977ad8afa2c92c2f8cd9c695344786) |

이번 작업으로 Service/Chalk/App을 운영에 배포하거나 포함형을 활성화하지 않았다.

## 근거와 다음 순서

[실제 UI 촬영](../research/access-budget-acceptance-2026-09-08/README.md),
[SDK·D1 복구·실제 공급자 단일 관측·운영 집계](../research/budget-readiness-2026-09-08/README.md),
[배포·활성화·rollback](../operations/access-budget-release.md)를 확인한다.

1. 지원 범위의 코드/문서 체인을 병합했다. 기존 테스트를 통과해도 #800/#857/#746 전체를 닫지 않는다.
2. 구매/지원 계약과 공급자 비용 출처를 확정하고 #857의 실제 수업 원가·청구 대조를 채운다. 그 전에는 운영 금액을 임의 설정하지 않는다.
3. Lab의 정의/construct audit 결과에 맞춰 #852의 버전·도움 출처·해석/내보내기 계약을 구현한다.
4. E4/E6/E7의 브라우저 검수·Computer Use·멀티모델 비교와 그 비용 집행을 각각 인수한다. 마지막으로 사람의 판단·전이·유지 효과를 별도 평가한다.
