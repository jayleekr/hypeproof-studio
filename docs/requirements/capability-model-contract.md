# 후보 역량 모델의 Studio 적용 계약

2026-09-08 · 상태: 제안, 측정 구현 전 · Lab #777 D / Studio #746.
정의 정본은 Lab PHILOSOPHY.md이며, [Product Intent](../PRODUCT-INTENT.md)가 제품으로 번역한다.
이 계약은 기존 NAT-08/09, AE-24/34/42~44와 hps-observation/1을 확장할 기준이다.
새 rubric·점수·저장 schema가 이미 적용됐다는 뜻이 아니다.

## 요구사항

| ID | 구현 전에 지킬 계약 | 검증 |
|---|---|---|
| HC-01 | 기존 `T/I/C/V/D/R/O`, 장문 asset key, A1–A5와 과거 evidence를 유지한다. 뜻이 같아 보여도 enum rename이나 점수 산술 변환을 하지 않는다. | CA-T16 |
| HC-02 | 새 해석은 `capability_model_version`(모델 버전), `definition_version`, rubric/evaluator revision과 evidence 참조를 가진다. 생성 AI의 provider/model revision과 구분한다. 버전 미상은 미상으로 보존한다. | CA-T16/17 |
| HC-03 | 원자료를 덮어쓰지 않고 버전별 interpretation을 연결한다. 기존 정정·철회·동의·만료·삭제 정책을 보존하며, 불변성이라는 이유로 삭제 의무를 제거하지 않는다. | CA-T16/17 |
| HC-04 | 사람 발화/선택, AI 제안, 정책 기본값, 강사 개입을 actor provenance로 구분한다. AI가 작성한 목표·검수 문장을 학습자 독립 수행 증거로 저장하지 않는다. | CA-T15/18 |
| HC-05 | `provisional / confirmed / needs_review / null`과 미관찰 이유를 유지한다. evidence별 confirmed와 후보 construct의 타당화 완료는 별개다. 빈 증거를 0점으로 채우지 않는다. | CA-T17/18 |
| HC-06 | 화면은 evidence profile을 먼저 보여 주고 legacy/current candidate·도움 조건·평가 버전을 구분한다. 새 여섯 이름을 메뉴·성취 배지·영구 브랜드로 일괄 고정하지 않는다. | CA-T11/17 |
| HC-07 | 비용·유료 등급·모델 가격·반복 수·토큰량은 역량 등급이 아니다. 도구/모델/Effort/도움·자원 부족을 관측 조건으로 남겨 불가능했던 행동과 수행 실패를 구분한다. | CA-T15/18 |
| HC-08 | 연구의 최소 construct audit를 통과한 정의만 새로운 측정 구현에 사용한다. 제품 동작 테스트와 human pilot/독립 평가·전이·유지 연구를 별도 판정한다. | CA-T18/19 |

## 기능별 Intent로의 번역

| 사용자 경험 | 후보 모델로부터의 연구 질문 | 기존 구현 축 |
|---|---|---|
| 채팅에서 목표·자료·완료 조건을 수정 | Framing이 단순 prompt 작성과 구분되는가? | E1, NAT-03, AE-01/02/36 |
| 대안과 검수 근거를 비교하고 채택 | Judgment와 Verify가 독립적으로 관찰되는가? | E1/E4/E7, AE-18/19/34/35/37 |
| 강사가 도움·도구·모델·Effort를 수업별로 제한하고 학생이 개입 | Orchestrate가 호출 횟수보다 권한·검토 지점 설계로 드러나는가? | E2/E3/E7, AE-09~17/25~33, REQ-M40 |
| 실패 후 원인을 보고 다른 전략으로 재검증 | Adapt가 반복 수와 다르게 나타나는가? | E3/E4/E5, AE-37/40/42 |
| 수업 후 파일·판단 기록을 이어가고 오류를 설명 | Ownership의 agency·authorship·accountability를 분리해야 하는가? | E3/E5, AE-39/43/44 |

이는 **설계 질문의 연결**이다. 기능이 구현됐거나 UI 버튼을 눌렀다는 이유로 후보 역량을
관찰·입증했다고 판정하지 않는다. 기존 자산 매핑은 역사적 설계 참조로 유지한다.


## 확인한 기존 구현과 다음 계약의 차이

기준 `c2d3a055`의 `worker/src/lib/native-observation.ts`와 App 쌍은
`hps-observation/1`, 일곱 대문자 asset 값, `observed/unobserved`,
`unknown/assisted/independent`, event actor `user/policy`를 사용한다.
HC의 모델 버전·다른 검토 상태를 이 API가 이미 저장한다고 가정하지 않는다.
형식 확장·역할 provenance·내보내기 호환은 #852에서 양쪽 validator와 실제 fixture를
감사한 뒤 정의한다. A1–A5라는 문자열의 다른 테스트 case ID를 학습 rubric으로 오인하지 않는다.
