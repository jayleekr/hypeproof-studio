# 수업 effort 검증 (#799)

기준: REQ-M40, AE-27/28 및 AE-T21 중 effort 범위. 전체 Agent Experience,
원가/예산 또는 학습 성과를 이 검증으로 완료 처리하지 않는다.

| ID | 확인하는 계약 | 실행 경로 |
|---|---|---|
| EFF-T01 | 9개 모델 × SDK/proxy × 기본/low/medium 전송값, 상한 우회·메시지 override·미지원 모델·기존 수업 | `worker/test/lesson-effort-policy.test.mjs` |
| EFF-T02 | 불변 버전/기본값/부분집합, 코호트 축소시 거부, 본인만 기록 조회, migration 재실행 | 같은 Service/SQLite 테스트 |
| EFF-T03 | 수업/모델 범위 선택 복원, 잘못된 기록은 미확인, SDK 전용 헤더 환경 격리 | extension `model-selection.smoke`, `live-preview-url.smoke` |
| EFF-T04 | 강사 선택 범위 저장/재열기/동결, 이후 고정 초안과 버전 분리, 390/1280px | `HPS_CHALK_MODEL_SELECTION=1`으로 `e2e/chalk-authoring/run.mjs` |
| EFF-T05 | 실제 App 선택·키보드·초안·실행중 변경·모델 전환·고정 수업·390/1280px/200%, 실제 API와 D1 설정 대조 | `HPS_NATIVE_EFFORT=1`으로 `e2e/native-trial.config.ts`; SDK와 `HPS_EFFORT_RUNTIME=proxy` 분리 |

2026-09-08 실행 상태: Worker/Chalk/extension 전체 테스트와 typecheck, webview/extension
빌드 PASS. EFF-T01–04 PASS (합성 사용자, 실제 Service 라우팅/SQLite, upstream mock 및
Chromium). EFF-T05 PASS: 9개 모델, SDK 22건·proxy 11건과 구형 v0.1.56 2건의 실제 API 요청, 고정 수업과 390/1280px·키보드·200% 입력 접근까지 대조했다. [원본 결과·스크린샷·실패 이력](../research/agent-experience-acceptance-2026-09-08/course-effort/README.md)을 보존한다. Windows 실제 기기,
스크린리더 음성, 실제 강사 수업 파일럿, 배포본 인수는 NOT RUN.

실제 앱은 출시본 v0.1.56의 격리 복사본에 이 브랜치 확장만 주입한다. 개인 앱/설정과
운영 코호트는 수정하지 않는다. primary clone의 e2e 디렉터리에서 실행하며 로그와
스크린샷은 `e2e/test-results/effort-799/`에 보존한다. environment.json에 소스/번들
해시를 기록한다. 스크린샷은 사람이 열어 본 뒤에만 시각 검수로 인정한다.
