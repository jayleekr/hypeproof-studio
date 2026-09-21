# 학습 경험 우선 Studio: 실행 계획

> 작성일 2026-09-18 · 상태: 활성 · Owner: jayleekr · 실행 그래프: [ux-dag.yaml](ux-dag.yaml) · 요구: [SX-01~60](../requirements/studio-learning-experience.md) · 검증: [SX-T](../testing/studio-learning-experience.md) · 거버넌스: `.claude/hypeproof/ux/`
> 원문 §17 "MVP 구현 순서"를 DAG로 옮긴 것이다. 순서는 `ux-dag.yaml`의 `depends_on`만이 정한다. 이 문서는 왜 그 순서인지와 단계가 끝났다는 뜻을 소유한다.

## 단계

| 단계 | 원문 | 내용 | 끝났다는 뜻 | 세션 |
|---|---|---|---|---|
| P0 Curriculum-first | §17 Phase 0 | 세션 설계 파일(Module) + 3주차 예시, 디자인 토큰, DOM 감사 계측기, 학생 홈·Mission header, Coach rail·Work canvas 재배치, `assetStatusBar` 제거 | SX-T01·T05·T10~T19·T40·T45 초록, 루브릭 90 이상, PR 1개 | 야간 1 |
| P1 Evidence capture | §17 Phase 1 | measurement-core 이벤트·필드 확장, Evidence drawer, 기대 조건·완료 게이트, 재확인 게이트·변경 전후, real/simulated 라벨·인터뷰/반응 입력 | SX-T02~T04·T20~T29·T43·T44 초록, PR 1개 | 야간 1 |
| P2 Boundary reflection | §17 Phase 2 | 제출·세션 종료·주차 종료 회고, 다음 실험 → 다음 과제, 기존 개선 행동 루프 연결 | SX-T06·T30~T34·T41 초록, PR 1개 | 야간 1 (여유 시) |
| P3 변화 기록 | §17 Phase 3 | 누적 패턴 + 근거 타임라인, 6개 점수는 접힘 | SX-T35~T39·T42 | 야간 2 이후. Lab MP-01 개정과 접점 |
| P4 강사 화면 | §17 Phase 4 | 막힘·근거·확인 필요 중심 | 강사 인증(`role: "issuer"` + `IssuerScope`)과 Chalk 화면은 이미 있다. 없는 것은 학습 근거의 issuer 범위 조회 경로와 학생의 공유 범위 선택(MC-39) | 설계만 |
| P5 방법 레이어 | §17 Phase 5 | 관찰 기준·수치·신뢰도·방법론 | Lab 방법론 판과 접점 | 설계만 |

## 왜 이 순서인가

- P0-A(세션 설계 파일)와 P0-B(토큰·계측기)는 서로 독립이고 나머지 전부가 기댄다. 먼저, 병렬로.
- P0-B의 DOM 감사 계측기가 없으면 "작업 중 숫자 0"(SX-T05)을 증명할 수 없다. 계측기가 실물을 재는지 자체 테스트(심어 둔 fixture)가 있어야 한다(`.claude/rules/verification.md`).
- P0-E(`assetStatusBar` 제거)는 작고 독립적이지만 P0-B 뒤에 두어 제거를 감사로 확인한다.
- P1-A(이벤트·필드)는 Service 층(worker)이고 P1-B~D의 저장 형식을 정한다. P1의 첫 task.
- P2는 P1-B(기대 조건·과제 상태 기계)에 기댄다. 회고는 과제 상태 전이의 한 지점이다.
- P3는 Lab의 MP-01(점수 우선)과 충돌하므로 사람 게이트다. 로컬 화면만 만들고 Lab 웹은 건드리지 않는다.

## 층 배치 (vessel-and-modules §1)

| 산출물 | 층 | 이유 |
|---|---|---|
| 세션 설계 파일, 6주 내용 | Module (m) | 데이터. 코호트마다 다르고 배포 없이 교체 |
| 홈·header·rail·canvas·drawer·회고·변화 기록 화면 | App (v) | 로컬 파일·화면이 필요 |
| 이벤트·필드 확장 | Service (w) | measurement-core는 worker의 공통 코어 |
| 강사 화면 | Surface (c) | 강사·운영 |
| 임계값(반복 횟수, 표시 하한) | Service 또는 Module | App에 숫자 상수를 박지 않는다 |

## 게이트

세 게이트를 순서대로: machine_gate(명령이 0으로 끝남) → control(구현 전에 심어 둔 답이 구현 전 코드에서 빨강, 구현 후 초록) → acceptance(구현자와 다른 평가자가 `.claude/evals/STUDIO_UX_EVAL.md`로 채점). task 85, 단계 PR 90. CRITICAL 10개 중 하나라도 걸리면 실패.

실패 분류는 `dag.yaml`의 다섯 가지. `harness_undecided`와 `spec`은 사람 몫이므로 `STATE.md`에 적고 다음 독립 task로 간다.

## Lab 쪽 의존

| 항목 | Lab 문서 | 상태 |
|---|---|---|
| MP-01 "score-first" 개정 (SX-60) | `products/lab-web/measurement-profile.md` | Lab 결정 기록 2026-09-18에 등록, 미결 |
| 미성년 파일럿 동의·강사 매개 | `MISSION.md` 아동 안전 결정 | 미결. P4 이후에만 영향 |
| 측정 UX 제안서(루프 우선) | `products/studio/2026-09-17-measurement-ux-proposal.md` | 같은 결론. P2·P3가 그 Slice 1a에 해당 |

## 실증

자동 재생은 Jay의 실기가 아니다. 단계마다 설치본에서 Jay가 과제 하나를 끝까지 돌린 기록(앱 버전, 날짜, 캡처 명령, 한계)이 `docs/testing/` 아래 증거 파일로 남아야 validation 노드(`ST-VAL-SX`)가 채워진다. 야간 세션은 captured-replay와 synthetic까지만 만들고 live-host는 NOT RUN으로 둔다.
