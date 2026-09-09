# Lab #777에서 Studio 구현으로

2026-09-08 · 상태: 단계별 구현·인수, 운영 활성화 미완료 · Lab #777 / Studio #746 / #800.
철학 개념 채택·제품 설계·코드 구현·운영 활성화·사람 연구의 완료를 구분한다.

## 의존성

```text
Lab #777 A 철학 개정안 → Mission / 제품 역할 / pricing Intent
  ├─ Lab #778 B/C 근거·construct audit → Studio #852 D 측정 계약 구현 → Lab #779 E 사람 검증
  ├─ Studio #800 pricing·예산·정산
  │    #853 계약 → #854 시도·원가 → #855 원자 예산 → #856 역할별 화면 → #857 통합·운영 인수
  └─ Lab #780 F 영향도·명칭 채택 → 기존 change-impact #767/#770 및 최신 wave로 검토
```

가격·권한 엔진은 후보가 여섯 개인지 일곱 개인지에 의존하지 않는다. 측정 구현은 최소
construct audit 후에 한다. 공개 이름은 개념 검토 후 범위별로 채택하며 과거 데이터는 보존한다.
기존 E1~E7의 채팅·SDK·Browser/Computer Use·모델 기능은 해당 실행 경계와 이 자원 계약을 함께 만족한다.

## 추적 가능한 실행 단위

| 추적 | 사용자가 얻는 결과 | 요구·검증 | 완료 경계 |
|---|---|---|---|
| [Lab #777](https://github.com/jayleekr/hypeprooflab/issues/777) | 고정 개수 대신 반증 가능한 Human Capability Research 철학 | normative/empirical 분리, 후보 정의·원자료 보존 | Jay의 개념 채택과 문서 정합성. 사람 연구 완료와 별개 |
| [Lab #778](https://github.com/jayleekr/hypeprooflab/issues/778) | 후보별 근거와 기존 지표 감사 | 13항목 dossier, 5축 상태, keep/merge/split 등 판정 | 실제 문헌·지표 전수 검토. 현재 계획 문서로 완료하지 않음 |
| [#852](https://github.com/jayleekr/hypeproof-studio/issues/852) | 과거 기록을 지키며 새 해석을 구분 | HC-01~08, CA-T15~18 | Service/App/export 호환·actor/버전 실증 |
| [#853](https://github.com/jayleekr/hypeproof-studio/issues/853) | 수업·개인·기관·BYO의 포함 범위와 출처 | AB-01~05/14/18 | 합성 계약 게시·권한·갱신·결합 사례 |
| [#854](https://github.com/jayleekr/hypeproof-studio/issues/854) | 실제 시도별 비용과 미정산 사유 | AB-07~10/15/16 | SDK/proxy/유료 도구/지연 보고·청구 대조 |
| [#855](https://github.com/jayleekr/hypeproof-studio/issues/855) | 공용 예산과 개인 상한의 강제 집행 | AB-04/06/09/10/13/15/18 | 실제 D1 경쟁·장애/복구·이전 앱 우회 검증 |
| [#856](https://github.com/jayleekr/hypeproof-studio/issues/856), 기존 [#847](https://github.com/jayleekr/hypeproof-studio/issues/847) | 강사·운영자 예산과 학생 이용 안내 연결 | AB-11~13/15/17 | 실제 Mac/Chalk 캡처·좁은 화면·권한 음성 대조 |
| [#857](https://github.com/jayleekr/hypeproof-studio/issues/857) | 검증된 운영 범위와 포함량 결정 근거 | CA-T01~15 통합 + 실제 수업 비용 관측 | 가격 정본·배포·운영 인수. 학생 역량 성장을 확정하지 않음 |
| [Lab #779](https://github.com/jayleekr/hypeprooflab/issues/779) | 독립 평가·전이·유지의 실제 연구 근거 | CA-T19, Lab 연구 프로토콜 | 실제 사람·원판정/불일치; 미실행 연구는 미실행 |
| [Lab #780](https://github.com/jayleekr/hypeprooflab/issues/780) | 제품·공개 표현·registry의 일관된 채택 | 참조 인벤토리/분류/최신 impact wave | 승인 범위별 채택·실제 화면 검증. 일괄 rename 금지 |

## 현재 구현과 구분

- #839: 수업별 모델 Effort와 설정 증거가 머지됐다. 구독 권한이나 통화 예산은 아니다.
- #840: 운영자 최근 사용 기록과 unknown cost가 머지됐다. 원가 확정이나 학생 잔액은 아니다.
- #843: 성인 모델 비교의 요청 시도 한도·슬롯·보고 상태가 머지됐다. 기관 공용 금액 예약이나 지연 조정 전체는 아니다.
- P1~P5: #860/#861/#863/#866/#867에서 지원 범위의 이용권·시도 원가·공용 예산·역할별 UI와 SDK/복구 인수를 구현했다. 실제 판매/결제와 연구, HC 새 측정 계약은 미완료다. [충족 현황](../testing/access-intent-fulfillment-2026-09-08.md)을 따른다.

## 변경 채택 순서

Lab #782가 `1de0d9b84ee51880ef9fcc70688b18c1afa4ac4e`로 병합되어 Studio upstream pin과
`ST-INT-CAPABILITY-ACCESS → LAB-INT-ACCESS`를 연결했다. #777/#800은 전체 완료로 닫지 않는다. 기존 미지정 owner 문제 #801과 자동 change-impact wave는 보존한다.
실제 연구와 상업 조건은 코드 PR 승인만으로 확정되지 않는다.
