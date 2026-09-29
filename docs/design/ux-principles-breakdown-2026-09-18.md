# UI/UX 설계 철학 브레이크다운: 문장을 사슬의 층에 배치한다

> 작성일 2026-09-18 · 상태: 활성 · 담당자: Jay · 원문: [ui-philosophy-2026-09-18.md](ui-philosophy-2026-09-18.md) · 사슬: philosophy → mission → product-roles → intent → requirement → design → implementation → test → validation
> 이 표가 요구사항화의 출발점이다. 원문의 모든 절을 한 층에 배치하고, 요구가 되는 문장에는 SX ID를 미리 부여한다. 파생 문서: [Intent INT-SX](../intents/studio-learning-experience.md) · [요구 SX-01~60](../requirements/studio-learning-experience.md) · [설계](studio-learning-experience.md) · [검증 SX-T](../testing/studio-learning-experience.md) · [계획](../plan/studio-learning-experience.md) · [DAG](../plan/ux-dag.yaml)

## 1. 층 배치 규칙

| 층 | 여기에 오는 문장 | 원문에서 | 처리 |
|---|---|---|---|
| philosophy (Lab) | 인간·학습에 대한 주장 | "실제로 해보는 경험이 가장 좋은 학습", "좋은 커리큘럼이 좋은 데이터를 만든다" | 새로 선언하지 않는다. Lab `PHILOSOPHY.md` §5.3 Development, §7 Studio·Curriculum에 이미 있다. 링크만 한다 |
| mission / product-roles (Lab) | 무엇을 파는가, 누가 쓰는가 | 국제고 학생, Chalk → Studio → 운영 게시판 구조, 6주 창업 | Lab `MISSION.md` §4가지 학습 경험, `products/PRODUCT-LINEUP.md` "Studio 와 Chalk". 새 주장(국제고 대표 시나리오)은 Lab 결정 기록으로 올린다 |
| intent (Studio) | 제품이 만들 경험과 성공을 관찰하는 방법 | thesis "학습은 전면, 측정은 후면", 10가지 원칙 | `docs/intents/studio-learning-experience.md` INT-SX-00~10. 기존 `docs/PRODUCT-INTENT.md` 7원칙의 하위 구체화이지 대체가 아니다 |
| requirement (Studio) | 화면에서 확인 가능한 행동 계약 | §8 화면 구조, §9 타이밍, §10 대화 설계, §11 관측, §12 성장 화면, §13 강사, §15 데이터 모델, §17 수용 기준, §18 안티패턴 | `docs/requirements/studio-learning-experience.md` SX-01~60 |
| design (Studio) | 어떻게 그리고 어떻게 저장하는가 | §14 디자인 시스템, §15 필드·이벤트, §8 영역 배치, 기존 코드 재배치 | `docs/design/studio-learning-experience.md` |
| module / curriculum (Chalk 접점) | 6주 과제 내용 | §5~§7 주차별 미션·시나리오·UI·관찰·금지 | 코드가 아니라 **세션 설계 파일**(Module 층, `docs/plan/vessel-and-modules.md`). 첫 파일은 `chalk/` 저작 계약(chalk-authoring)에 맞춰 예시 데이터로 만든다 |
| test / validation (Studio) | 실행 가능한 검사와 실기 증거 | §17 Slice 1 acceptance, §16 5초 회상 테스트, §18 안티패턴 | `docs/testing/studio-learning-experience.md` SX-T01~. 안티패턴은 전부 부정 테스트가 된다 |

## 2. 원문 절별 배치

| 원문 절 | 층 | 파생 ID | 비고 |
|---|---|---|---|
| 표지 "한 문장으로", 항목표 | intent | INT-SX-00 | 제품 범위 문장 "강의/과제 → Studio 작업실 → 실제 사용자 검증 → 운영 기록 → 성장 인사이트"는 과제 흐름 상태 기계(SX-55~58)의 출처 |
| §0 비주얼 컨셉 | design(참고) | 없음 | 컨셉 보드. 원문이 "최종 화면 정의가 아니다"라고 명시 |
| §1 설계의 출발점, 설계 전제 5개 | intent | INT-SX-00 | 전제 1 "측정을 위해 커리큘럼을 왜곡하지 않는다"는 SX-57(과제 설계 원칙)로도 내려간다 |
| §2 thesis, 세 레이어 표 | intent + requirement | INT-SX-00, SX-01, SX-30, SX-43 | 표의 "금지" 열은 각각 부정 테스트 |
| §3 대상 사용자, persona, 국제고 UX 요구 5개 | mission(Lab) + requirement | SX-19, SX-20, SX-21, SX-24 | KO/EN 혼용 입력, provenance, 문화 차이 비정오, evidence type 구분, 팀 기여 구분 |
| §4 원칙 01~10 | intent | INT-SX-01~10 | 아래 §3 표 |
| §5 관측 설계 원칙 | requirement | SX-57 | "관측하기 좋은 행동을 만들기 위해 함정을 넣지 않는다" |
| §6~§7 주차별 상세 | module | 세션 설계 파일 6개 | 각 주차의 "절대 하지 않을 것" 6개는 SX-58 부정 테스트 |
| §8 화면 구조 A~F, 학생 홈 | requirement + design | SX-01~05(홈·헤더), SX-06(코치 rail), SX-13(캔버스), SX-17(근거 drawer), SX-25(회고), SX-30(성장) | 영역 배치는 design |
| §9 타이밍, intervention ladder 6단계 | requirement | SX-07~10, SX-26 | 조건 "현재 과제를 더 잘 수행하는 데 필요한가"가 게이트 |
| §10 대화 설계 표, 언어 규칙 5개 | requirement | SX-11, SX-12 | 표의 "좋은 UX" 열은 코치 프롬프트 계약, 언어 규칙은 카피 lint |
| §11 Observation & Growth, evidence type 6개, 인사이트 생성 조건 5개 | requirement | SX-18, SX-22, SX-31~34 | Lab 측정 제안서(products/studio/2026-09-17-measurement-ux-proposal.md)와 같은 결론 |
| §12 성장 화면 우선순위 5개, 금지 라벨 6개, 대체 라벨 5개 | requirement | SX-30, SX-35, SX-36, SX-37 | 금지 라벨은 grep 테스트 |
| §13 강사 UX 표, 개입 CTA 4개, 가드레일 | requirement | SX-38~42 | 강사 정체성은 이미 있다: `worker/src/lib/tokens.ts`의 `role: "issuer"` + `IssuerScope[]`, 검증은 `instructor-auth.ts`, 화면은 Chalk `chalk/src/ui/{board,console,manage,sharing}.html`. P4가 기다리는 것은 역할이 아니라 (1) 학생 학습 근거를 issuer 범위로 내보내는 조회 경로와 (2) 학생이 공유 범위를 고르는 제출 경로(MC-39)다 |
| §14 디자인 시스템 토큰 6개, 컴포넌트 원칙 6개 | design + requirement | SX-49~54 | 토큰 값은 design 문서가 소유. 원칙은 요구 |
| §15 필드 7개, 이벤트 8개 | design + requirement | SX-43~48 | 기존 `hps-observation/1`·measurement-core 계약 위에 확장. 새 저장소를 만들지 않는다 |
| §16 성공 지표 표, 5초 회상 테스트 | validation | SX-T-VAL | 제품 지표. 점수 상승은 지표가 아니다 |
| §17 MVP 순서 Phase 0~5, Slice 1 수용 기준 6개 | plan + test | P0~P5, SX-T01~06 | DAG의 뼈대 |
| §18 안티패턴 6개 | test | SX-T40~45 | 각각 부정 테스트 |
| Appendix 문구 원칙 5쌍 | requirement | SX-12 | 카피 lint의 반례 목록 |

## 3. 원칙 10개 → Intent → 요구

| 원칙 | INT-SX | 성공을 관찰하는 방법 (Intent 열) | 요구 ID |
|---|---|---|---|
| 01 Current problem before self-evaluation | INT-SX-01 | 첫 화면 5초 안에 학생이 "지금 해야 할 것"을 말한다. 어떤 화면에서도 현재 과제보다 앞에 능력·점수·평가 라벨이 오지 않는다 | SX-01, SX-02, SX-03, SX-59 |
| 02 Coach, not answerer | INT-SX-02 | 코치 응답이 답 대신 질문·기준·힌트로 끝난 비율. 학생이 최종 선택과 이유를 남긴 세션 비율 | SX-06, SX-07, SX-11 |
| 03 Evidence before interpretation | INT-SX-03 | 모든 해석 문장이 실제 인용·결과·전후에 연결되어 클릭으로 열린다 | SX-17, SX-18, SX-31, SX-32 |
| 04 Student owns the decision | INT-SX-04 | 추천 뒤 학생이 선택하고 이유를 한 줄 남긴 결정 수. AI 추천이 학생 판단으로 기록된 건 0 | SX-14, SX-23, SX-45 |
| 05 Progressive help | INT-SX-05 | 개입이 질문 → 구조화 → 힌트 → 예시 → 강사 → 정답 순서를 지킨 비율. 정답 제공은 예외 사유와 함께만 | SX-08, SX-09, SX-10 |
| 06 Boundary-based reflection | INT-SX-06 | 작업 중 회고·평가 노출 0. 회고는 제출·세션 종료·주차 종료에서만 | SX-25, SX-26, SX-27 |
| 07 Growth story over score | INT-SX-07 | 성장 화면 첫 화면에 숫자 없음. 변화 문장마다 근거 2~3개 | SX-30, SX-33, SX-35, SX-36 |
| 08 Separate simulation from reality | INT-SX-08 | real / simulated / self_reported / unverified 라벨이 UI와 데이터 양쪽에 있다 | SX-21, SX-46 |
| 09 Reversible and inspectable | INT-SX-09 | AI가 만든 것, 학생이 바꾼 것, 기준을 언제든 되짚을 수 있다 | SX-15, SX-16, SX-47 |
| 10 Small success → next challenge | INT-SX-10 | 성공이 배지가 아니라 다음 과제·다음 실험으로 연결된다 | SX-28, SX-29, SX-34 |

## 4. 요구 ID 할당 (제목만; 본문은 요구사항 문서)

| 묶음 | ID | 제목 | 원문 |
|---|---|---|---|
| HOME | SX-01 | Mission header: 주차 / 미션 한 문장 / 완료 조건 / 남은 단계가 항상 보인다 | §8 A |
| HOME | SX-02 | 학생 홈은 "오늘의 작업": 상단 한 문장, 중앙 1~3개 action, 지난번 이어서 | §8 홈 |
| HOME | SX-03 | 성장 인사이트 진입은 작은 링크, 미션보다 낮은 시각 우선순위 | §8 홈 |
| HOME | SX-04 | 한 화면에 Primary CTA 1개 | §14 |
| HOME | SX-05 | 학습 정보 / 작업 공간 / 근거 기록을 한 화면에 섞지 않는다 | §8 |
| COACH | SX-06 | Coach rail: 질문·힌트·체크리스트·학생 요청·강사 메시지만; 답·대안·최종 선택 대신 하지 않음 | §2, §8 B |
| COACH | SX-07 | 작업 중 피드백 게이트: "현재 과제를 더 잘 수행하는 데 필요한가"를 통과한 것만 | §9 |
| COACH | SX-08 | Intervention ladder 6단계의 순서와 각 단계의 형태 | §9 |
| COACH | SX-09 | 강사 호출은 판단이 아니라 막힌 맥락을 전달한다 | §9 5단계 |
| COACH | SX-10 | 직접 정답 제공은 안전·법적 위험 예외에서만, 사유 기록 | §9 6단계 |
| COACH | SX-11 | 대화 설계 표의 5개 상황별 응답 계약 (모호한 문제, 초안 완성, 가격, 반응 없음, 회고) | §10 |
| COACH | SX-12 | 언어 규칙 5개와 문구 원칙 5쌍: 평가형 형용사 금지, 관찰 문장, 근거 범위 명시, 실제/AI 예시 라벨 분리, 모델/학생 한 문장에 섞지 않음 | §10, Appendix |
| WORK | SX-13 | Work canvas: 에디터·프리뷰·테스트·데이터/문서가 중심, 설명·근거는 rail/drawer | §8 C, §14 |
| WORK | SX-14 | AI 초안 뒤 학생이 기대 조건을 쓰기 전에는 "완료" CTA 비활성 | §17 |
| WORK | SX-15 | 수정 후 같은 조건으로 재확인하지 않으면 검증 완료로 기록되지 않음 | §17, §6 3주 |
| WORK | SX-16 | AI가 만든 것 / 학생이 바꾼 것 / 기준을 되짚을 수 있는 변경 전후 보기 | §4 09 |
| EVID | SX-17 | Evidence drawer: 기대 조건, 근거, 변경 전후, 출처. 필요 시 노출 | §8 D |
| EVID | SX-18 | evidence type 6종(Intent·Criterion·Action·Decision·Change·Ownership)의 저장과 표시 | §11 |
| EVID | SX-19 | KO/EN 혼용 입력 허용, 의미와 근거를 한 화면에서 비교 | §3 |
| EVID | SX-20 | provenance: 누가 언제 어떤 상황에서 말했는지 | §3 |
| EVID | SX-21 | real / simulated / self_reported / unverified 라벨을 UI와 데이터에서 고정 | §3, §4 08, §15 |
| EVID | SX-22 | 외부 링크·기사·규정·인터뷰 등 evidence type 구분 | §3 |
| EVID | SX-23 | 선택 이유 한 줄 남기기 기본 UX | §4 04 |
| EVID | SX-24 | 팀 프로젝트에서 AI 기여와 학생 판단·수정 기여 구분 기록 | §3, §7 6주 |
| REFL | SX-25 | Reflection 영역은 경계(제출·세션 종료·주차 종료)에서만 | §8 E, §4 06 |
| REFL | SX-26 | 회고를 매 세션 팝업으로 띄우지 않는다 | §18 |
| REFL | SX-27 | 주차 종료 회고는 "바뀐 생각 1개 + 다음 실험 1개"만 | §17 |
| REFL | SX-28 | 다음 실험 하나를 다음 과제에 추가한다 | §12 3 |
| REFL | SX-29 | 성공을 배지로 소비하지 않고 다음 도전으로 연결 | §4 10 |
| GROW | SX-30 | 성장 화면 첫 화면: 최근 발견한 변화 + 근거 2~3개; 6개 점수 카드는 접힌 세부 데이터로 | §12 |
| GROW | SX-31 | 한 번의 사건으로 성향을 말하지 않는다; 여러 과제에서 반복될 때만 패턴 | §11 |
| GROW | SX-32 | 근거 세션을 클릭하면 실제 문장·결정·결과가 열린다 | §11 |
| GROW | SX-33 | 근거 없음은 0이 아니라 "아직 충분히 보지 못함" | §11 |
| GROW | SX-34 | 성장 인사이트는 "다음에 실험할 한 가지"로 끝난다 | §11 |
| GROW | SX-35 | 금지 라벨 6개 (개선 필요, 낮음/높음, 상위 N%, 역량 부족, AI 활용 고수, 성장 점수) | §12 |
| GROW | SX-36 | 대체 라벨 5개 (이번 작업에서 관찰됨, 최근 반복된 패턴, 아직 충분히 보지 못함, 근거가 서로 다름, 다음에 실험해볼 것) | §12 |
| GROW | SX-37 | 우선순위 2·4·5: 아직 드물게 본 행동, 근거 타임라인, 방법/세부 데이터 접힘 | §12 |
| INST | SX-38 | 강사 화면: 진행 상태, 학생 원문, 막힌 지점, 확인할 증거, 실제/가상 여부 | §13 |
| INST | SX-39 | 강사 화면 금지: 점수 순위, 채팅량·토큰량·체류시간 대리값, AI 의존도 추정치, 성격/잠재력 평가, 코호트 랭킹 | §13 |
| INST | SX-40 | 강사 CTA: 질문 보내기 / 다시 보게 할 지점 표시 / 근거 확인·추가 관찰 필요 | §13 |
| INST | SX-41 | 학생이 실제 사용자 인터뷰·결제·외부 링크를 다룰 때 기관 정책 가드레일 | §13 |
| INST | SX-42 | teacher_state unreviewed / confirmed / disputed 를 자동 판단과 분리 | §15 |
| DATA | SX-43 | Observation layer는 기본 숨김; 클릭수·토큰수로 능력 추정 금지 | §2 |
| DATA | SX-44 | 필드 7개: actor, context, evidence_type, source_state, student_text, artifact_before/after, teacher_state | §15 |
| DATA | SX-45 | AI 추천은 학생 판단으로 기록되지 않는다 (actor 분리) | §4 04, §15 |
| DATA | SX-46 | source_state를 이벤트 저장 시점에 고정; 가상 데이터를 실적으로 표시하지 않음 | §7 4주, §18 |
| DATA | SX-47 | 이벤트 8종: problem_committed, criterion_set, test_observed, change_requested, retest_confirmed, external_feedback_received, decision_revised, reflection_submitted | §15 |
| DATA | SX-48 | 기존 hps-observation/1 · measurement-core 계약을 확장한다; 제2 저장소·제2 채점기를 만들지 않는다 | Studio MC-02/03, HC-01 |
| DS | SX-49 | 토큰 6개(Deep forest, Panel, Lime, Amber, Ink light, Paper)의 역할 배정; 값은 design 문서 | §14 |
| DS | SX-50 | 상태는 색만으로 표현하지 않음; 아이콘 + 문구 | §14 |
| DS | SX-51 | 숫자 카드는 학습 화면에서 최소화; 가격·GTM·지표 주차에서만 전면 | §14 |
| DS | SX-52 | 모달보다 inline progression | §14 |
| DS | SX-53 | 학생이 직접 쓴 문장·결정은 AI 설명보다 시각적으로 우선 | §14 |
| DS | SX-54 | 학생 작업 화면은 대비를 낮추고 작업물이 주인공; 회고·보고서는 Paper | §14 |
| CURR | SX-55 | 과제 흐름 상태 기계: 과제 → 실행 → 제출 → 회고 → 다음 과제; "다음으로"의 의미 | 표지 제품 범위, §8 |
| CURR | SX-56 | 주차·미션·완료 조건·핵심 UI·관찰 항목은 세션 설계 파일(Module)에서 읽는다; 6주를 코드에 넣지 않는다 | §5~§7, vessel-and-modules |
| CURR | SX-57 | 관측을 위해 과제를 왜곡하거나 함정을 넣지 않는다 | §1, §5 |
| CURR | SX-58 | 주차별 "절대 하지 않을 것" 6개 (AI 인터뷰 대필·문제 자동 선택, 추상 문구 선생성, 고의 오류, 가짜 결제, SNS 노출로 PMF 주장, 예측을 확정처럼) | §6~§7 |
| LEGACY | SX-59 | 작업 중 역량 점수·등급·개선 필요 배지가 보이지 않는다; 기존 `assetStatusBar.ts`(7자산 N/7) 제거 | §17, Lab 측정 제안서 결정 8 |
| LEGACY | SX-60 | /measurement 6개 점수 카드는 성장 스토리의 접힌 세부 데이터로 내려간다; 기존 hps-six-auto 리포트는 보존 | §12, Lab MP-01 개정 필요 |

## 5. 기존 요구와의 관계 (중복 금지)

| 기존 | 관계 |
|---|---|
| NAT-03 (충분하면 실행, 부족할 때 질문 하나, 강제 설문 없음) | SX-07·SX-08의 상위. 새 학습자 상태 시스템을 만들지 않는다 |
| AE-01/02 (목표·완료 기준 확인·수정, 자료 출처) | SX-01·SX-14의 상위 |
| AE-05/37 (변경 전후·검수 근거·재확인) | SX-15·SX-16의 상위 |
| AE-24/34/35 (독립 변경 관측, 비교 채택 이유, 프롬프트 수는 점수 아님) | SX-23·SX-43의 상위 |
| AE-36 (시연/힌트/함께 수정/직접 수행) | SX-08의 도움 모드 |
| AE-42/43/44 (회고, 반론, 도움 조건별 관찰) | SX-25~34의 상위 |
| US-03/05/17 (첫 실행 진입, 활동 이름, 강제 설문 없음) | SX-02의 상위 |
| TUX-SP/CHAT (시작 화면·채팅 조작) | SX-02·SX-06이 이 화면들을 재배치한다. 조작 계약은 유지 |
| MC-18/19/21/22/26/27 (관찰·해석 상태, 근거 중심 카드, 하나의 개선점, 되찾기) | SX-17~34·SX-42~48의 상위. 같은 코어·같은 로컬 레코드 |
| HC-06/07 (evidence profile 먼저, 비용·토큰은 점수 아님) | SX-30·SX-43의 상위 |
| Lab MP-01 (점수 우선 프로필) | SX-60과 충돌. Lab 결정 기록으로 개정 요청 |

## 6. 원문과 기존 정본의 충돌

| 원문 | 정본 | 결정 |
|---|---|---|
| "성장 데이터", "성장 인사이트", "나의 성장 이야기" | PHILOSOPHY §7·MISSION: 성장 주장은 별도 검증; #1049: 성장 라벨 금지 | 화면 이름은 "나의 변화 기록"으로, 내부 개념명은 growth story 유지. 원문 §12의 대체 라벨은 이미 성장 낱말을 쓰지 않는다 |
| "늘고 있어요 / 아직 드물어요" (시간 차이 문장) | Lab 측정 제안서 MC-45/46: 같은 기준·평가기 아래 비교 가능할 때만 | SX-31의 조건(여러 과제 반복)에 "같은 기준·같은 평가기"를 더한다 |
| 국제고 학생이 대표 시나리오 | MISSION Stream B, 아동 안전 아키텍처 미결 | 14세 미만 아님(고등학생)이지만 미성년. 보호자 동의·강사 매개 경로는 Lab 결정 기록으로 |
| /measurement 점수 카드를 세부 데이터로 | Lab MP-01 "score-first" | Lab `measurement-profile.md` MP-01 개정을 Lab 쪽 작업으로 등록 |
