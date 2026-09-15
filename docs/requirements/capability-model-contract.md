# 후보 역량 모델의 Studio 적용 계약

2026-09-08 · 상태: 제안, 측정 구현 전 · Lab #777 D / Studio #746.
정의 정본은 Lab PHILOSOPHY.md이며, [Product Intent](../PRODUCT-INTENT.md)가 제품으로 번역한다.
이 계약은 기존 NAT-08/09, AE-24/34/42~44와 hps-observation/1을 확장할 기준이다.
새 rubric·점수·저장 schema가 이미 적용됐다는 뜻이 아니다.

2026-09-13 Jay 결정: [공통 측정 코어](../intents/measurement-core.md)의 신규 작업은
6개 모델(Framing, Judgment, Orchestrate, Verify, Adapt, Ownership)을 기본으로 개발한다.
제품 채택과 연구 타당화는 분리한다. 기존 7개 데이터는 보존하고 새 해석을 연결한다.

## 요구사항

| ID | 구현 전에 지킬 계약 | 검증 |
|---|---|---|
| HC-01 | 기존 `T/I/C/V/D/R/O`, 장문 asset key, A1–A5와 과거 evidence를 유지한다. 뜻이 같아 보여도 enum rename이나 점수 산술 변환을 하지 않는다. | CA-T16 |
| HC-02 | 새 해석은 `capability_model_version`(모델 버전), `definition_version`, rubric/evaluator revision과 evidence 참조를 가진다. 생성 AI의 provider/model revision과 구분한다. 버전 미상은 미상으로 보존한다. | CA-T16/17 |
| HC-03 | 원자료를 덮어쓰지 않고 버전별 interpretation을 연결한다. 기존 정정·철회·동의·만료·삭제 정책을 보존하며, 불변성이라는 이유로 삭제 의무를 제거하지 않는다. | CA-T16/17 |
| HC-04 | 사람 발화/선택, AI 제안, 정책 기본값, 강사 개입을 actor provenance로 구분한다. AI가 작성한 목표·검수 문장을 학습자 독립 수행 증거로 저장하지 않는다. | CA-T15/18 |
| HC-05 | `provisional / confirmed / needs_review / null`과 미관찰 이유를 유지한다. evidence별 confirmed와 후보 construct의 타당화 완료는 별개다. 빈 증거를 0점으로 채우지 않는다. | CA-T17/18 |
| HC-06 | 화면은 evidence profile을 먼저 보여 주고 legacy/current candidate·도움 조건·평가 버전을 구분한다. 공통 코어의 새 작업 카드·해석은 여섯 모델을 기본으로 표시한다. 이름·항목은 모델 정의에서 읽어 개정 가능하게 하며, 과거 일곱 기록은 당시 모델로 표시한다. 표시를 검증된 성취 배지로 바꾸지 않는다. | CA-T11/17 |
| HC-07 | 비용·유료 등급·모델 가격·반복 수·토큰량은 역량 등급이 아니다. 도구/모델/Effort/도움·자원 부족을 관측 조건으로 남겨 불가능했던 행동과 수행 실패를 구분한다. | CA-T15/18 |
| HC-08 | Jay dogfood는 정의·행동 예·반례를 버전으로 명시한 여섯 모델로 관찰과 검토를 시작한다. 연구 audit를 제품의 모델 채택·사용 시작을 미루는 조건으로 삼지 않는다. 수치 평가 rubric의 활성화는 별도 audit를 요구하고, 제품 동작·human pilot·독립 평가·전이·유지 연구를 각각 판정한다. | CA-T18/19 |

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

## HAIN7 retirement — 2026-09-15

HC-09: HAIN7 is retired from new measurement and recommended agent workflows. New Codex/Claude measurement uses the member six-capability workbench and its versioned methodology. The old scorer, rubric, examples, and existing results remain available only for explicitly selected historical replay/export; no seven-to-six conversion or source overwrite occurs.

The historical CLI must reject ordinary invocation before reading records or creating output. Archival invocation requires `--legacy-replay` and an exact session path; `--latest` is rejected. This declaration does not authenticate record age. Preserve existing output collision, review, consent, and missing-evidence gates.

Verification: `python3 skills/hain7-report/scripts/test_hain7_signal.py` checks rejection without output, refusal of automatic latest selection, and explicit replay with the original rubric/evidence. The skill catalog and agent default prompt must route current work away from HAIN7. This retirement does not rename historical event enums or rewrite philosophical source definitions.
