# 학습 경험 우선 Studio — Product Intent

상태: 개발 기준 제안, 구현·실사용 검증 전. 2026-09-18.
Owner: jayleekr. 원문: [UI/UX 설계 철학](../design/ui-philosophy-2026-09-18.md) · 분류: [브레이크다운](../design/ux-principles-breakdown-2026-09-18.md).
상위: [Product Intent](../PRODUCT-INTENT.md)의 Useful work first, Human judgment stays visible, Learning is embedded, Minimum necessary intervention, Evidence over claims, Adapt do not script, Capability models are hypotheses. Lab [PHILOSOPHY.md](https://github.com/jayleekr/hypeprooflab/blob/main/PHILOSOPHY.md) §5.3·§7과 [MISSION.md](https://github.com/jayleekr/hypeprooflab/blob/main/MISSION.md) §4가지 학습 경험의 소유권은 옮기지 않는다. 형제 Intent: [공통 측정 코어 INT-MC-01~03](measurement-core.md).

## Product Intent

**학생이 실제 문제를 발견하고 AI와 만들고 실제 사용자에게 검증하면서 스스로 판단하는 경험을 Studio가 설계한다. 학생이 보는 화면의 주인공은 현재 과제·현재 고객·현재 결과물이고, 관찰은 그 흐름 아래에서 조용히 따라가며, 충분한 근거가 쌓였을 때만 변화 기록으로 돌아온다.**

이 Intent는 측정 코어 Intent를 대체하지 않는다. INT-MC가 "무엇을 어떻게 관찰하고 검토하는가"를 소유한다면, 이 문서는 "학생이 무엇을 하는 제품인가"와 "관찰 결과가 언제 어떤 모양으로 돌아오는가"를 소유한다. 여섯 역량(Framing, Judgment, Orchestrate, Verify, Adapt, Ownership)은 내부 관찰 프레임이며 학생 화면의 언어가 아니다.

## 먼저 해결할 문제

현재 앱은 채팅 패널이 중심이다. 학생은 코드 하나로 수업에 들어와 코치와 대화하고 프리뷰를 보지만, "이번 주 무엇을 해야 하는가", "어떤 결과여야 맞다고 볼 것인가", "내가 바꾼 것과 AI가 만든 것이 무엇인가"를 화면이 붙들어 주지 않는다. 한편 상태바에는 구형 7자산 퍼센트가 작업 중에 뜨고, Lab 웹의 측정 페이지는 여섯 점수를 먼저 보여 준다. 학습 흐름은 약하고 측정은 앞에 나와 있다. 이 문서는 그 순서를 뒤집는다.

## Intent

| ID | 의도 | 성공을 관찰하는 방법 | 원칙 |
|---|---|---|---|
| INT-SX-00 | 학습은 전면, 측정은 후면. 학생 화면은 Learning/Venture, AI Coach, Observation/Growth 세 레이어로 나뉘고 세 번째는 기본 숨김이다 | 작업 중 어느 화면에도 역량 점수·등급·평가 라벨이 없다. 관찰 레이어는 회고와 변화 기록에서만 근거와 패턴으로 열린다 | thesis, 설계 전제 |
| INT-SX-01 | 현재 문제가 자기 평가보다 먼저 온다 | 첫 화면 5초 안에 학생이 "지금 해야 할 것"을 말한다. 어떤 화면에서도 현재 과제보다 앞에 능력·점수·평가 라벨이 오지 않는다 | 01 |
| INT-SX-02 | AI는 답을 완성하는 도구가 아니라 학생이 더 좋은 질문·기준·판단을 만들게 돕는 코치다 | 코치 응답이 답 대신 질문·기준·힌트로 끝난 비율을 세션별로 확인한다. 학생이 최종 선택과 이유를 남긴 세션 비율을 본다 | 02 |
| INT-SX-03 | 해석보다 근거가 먼저 보인다 | 모든 해석 문장이 실제 인용·테스트 결과·변경 전후에 연결되어 클릭으로 열린다. 연결 없는 해석은 그리지 않는다 | 03 |
| INT-SX-04 | 최종 선택은 학생이 한다 | 추천 뒤 학생이 선택하고 이유를 한 줄 남긴 결정의 수. AI 추천이 학생 판단으로 기록된 건은 0이다 | 04 |
| INT-SX-05 | 도움은 단계적으로 온다 | 개입이 질문 → 구조화 → 힌트 → 예시 → 강사 → 정답 순서를 지킨 비율. 정답 제공은 예외 사유와 함께만 기록된다 | 05 |
| INT-SX-06 | 회고는 경계에서만 한다 | 실행 중 회고·평가 노출이 0이다. 회고는 제출·세션 종료·주차 종료에서만 열리고, 매 세션 팝업이 없다 | 06 |
| INT-SX-07 | 점수보다 변화 이야기 | 변화 기록 첫 화면에 숫자가 없다. 변화 문장마다 근거 2~3개가 붙고, 근거 없음은 "아직 충분히 보지 못함"이다 | 07 |
| INT-SX-08 | 시뮬레이션과 현실을 분리한다 | real / simulated / self_reported / unverified 라벨이 UI와 데이터 양쪽에 있고, 가상 데이터가 실적으로 표시된 화면이 없다 | 08 |
| INT-SX-09 | 되돌릴 수 있고 들여다볼 수 있다 | AI가 만든 것, 학생이 바꾼 것, 그때의 기준을 언제든 되짚을 수 있다 | 09 |
| INT-SX-10 | 작은 성공은 다음 도전으로 이어진다 | 성공이 배지가 아니라 다음 과제·다음 실험으로 연결된다. 배지·스트릭·랭킹이 없다 | 10 |

## 첫 사용자와 첫 장면

첫 사용자는 Jay(성인, dogfood)이고, 대표 시나리오는 국제고 학생 민서(GlobalBuddy)다. 두 경로가 같은 화면을 쓴다. 학생용 파일럿은 보호자 동의와 강사 매개 경로가 준비된 뒤다(Lab MISSION 아동 안전 결정, 별도).

1. 학생이 수업 코드로 들어오면 첫 화면에 "3주차 · AI가 만든 걸 내가 확인했나?" 한 문장과 지금 할 1~3개 action이 보인다. 점수는 없다.
2. 코치 rail에서 질문과 힌트를 받으며 Work canvas에서 만들고 시험한다. 기대 조건을 적기 전에는 완료를 누를 수 없다.
3. 발견한 차이를 근거로 수정을 요청하고, 같은 조건으로 다시 확인한다. 이 과정이 evidence drawer에 남는다.
4. 과제를 제출하면 그때서야 회고가 열린다. "바뀐 생각 1개 + 다음 실험 1개"만 쓴다.
5. 몇 개 과제가 쌓이면 변화 기록에서 "확인한 뒤 생각을 바꾸는 행동이 늘고 있어요"와 근거 2~3개, 다음 실험 하나를 본다. 숫자는 접힘 안에 있다.
6. 강사는 누가 어디에서 막혔고 어떤 근거가 비어 있는지 보고, 답 대신 질문을 보낸다.

## 첫 버전의 성공과 실패

성공: Jay가 세션 설계 파일 하나로 만든 과제 하나를 1~4번까지 끝까지 돈다. 작업 중 화면에 숫자가 없고, 완료 게이트와 재확인 게이트가 실제로 막고, 회고가 경계에서만 열린다. 5초 회상 테스트에서 과제와 자기 행동을 먼저 말한다.

다시 본다: 학생이 점수를 찾아 헤맨다; 코치가 답을 준다; 완료 게이트가 우회된다; 회고가 귀찮아 비워진다; 가상 데이터와 실제가 섞인다; 관찰이 과제를 바꾼다(관측을 위해 함정을 넣게 된다).

## 범위와 단계

[MVP 순서](../plan/studio-learning-experience.md) P0 Curriculum-first → P1 Evidence capture → P2 Boundary reflection → P3 Growth story → P4 Instructor evidence view → P5 Method layer. P0~P2가 Jay dogfood, P3가 Lab 측정 제안서와의 접점, P4 이후가 학생 파일럿 조건이다.

포함하지 않음: 새 채점기, 제2 저장소, 전 멤버 강제 수집, 점수·순위·배지, 6주 커리큘럼을 코드에 고정하는 것, 학생 파일럿 자체.

## 파생 계약

[요구사항 SX-01~60](../requirements/studio-learning-experience.md) → [설계](../design/studio-learning-experience.md) → [검증 SX-T](../testing/studio-learning-experience.md) → [계획과 DAG](../plan/studio-learning-experience.md).
