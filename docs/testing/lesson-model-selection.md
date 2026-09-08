# 수업의 모델 선택·전환 인수

#792 / #755 / #746, AE-25/26/27/33 및 AE-T19/20/25의 작은 구현 단위.
사용자는 답변별 모델 배지보다 입력창에서 모델을 선택·전환하는 흐름을 우선했다.
선택값은 요청할 모델이고, 실제 사용 모델은 기존 사용량 기록으로 대조한다.
자동 대체·상세 표시·전체 E7과 학습 효과는 별도다.

## 인수 조건

| 조건 | 검증 경로 |
|---|---|
| 강사만 코호트 허용 부분집합과 기본값을 저장. 임의 모델·학생 편집·다른 프로필 접근 차단 | `worker/test/lesson-model-policy.test.mjs`, 기존 authoring 인증/동시성 검사 |
| Chalk의 고정/학생 선택 저장·재열기·버전 고정, 후속 초안 변경이 이전 버전을 바꾸지 않음 | `HPS_CHALK_MODEL_SELECTION=1`의 기존 `e2e/chalk-authoring/run.mjs` |
| 입력창의 선택과 고정 이유, 다음 요청부터 전환, 미전송 입력·대화 보존 | `HPS_LESSON_MODELS=1`의 기존 `e2e/lesson-studio/mac.mjs` |
| 실제 SDK/proxy 요청과 공급자 호출 모델 일치 | 위 실제 앱 실행의 `gateway-evidence.json`과 `api-evidence.json`; 합성 공급자 응답은 실기 증거가 아님 |
| 고정 수업에서 SDK fast/별칭/직접 ID로 다른 모델 실행 불가. 구형 수업 예외 유지 | Service 두 경로의 고정/선택 대조, 기존 resolver 반례 |
| 모델 ID/공급자/실행기 변경 시 이전 버전 거부, 기존 바이트 보존 | frozen binding 대조·프로필 변경 후 read 거부 |
| 구형 Service/이전 수업 호환, 다른 수업 선택 초기화, 미성년 SDK 확대 금지 | 확장 `model-selection.smoke.mjs` 및 기존 회귀 검사 |
| 실제 390/1280px와 키보드 선택, 확대 | native 화면과 접근성 검수. 실행한 조합만 판정 |

## 실행 경계

실제 앱 검수는 기존 Mac 셸의 격리 사본에 후보 확장/webview를 넣는다. 제출 SHA와 실제
bundle 해시를 먼저 비교하고 기존 primary clone의 e2e 디렉터리에서 실행한다. 모델 경로
fixture는 합성 프로필의 `coach_runtime`을 SDK/proxy로 각각 지정하며 manifest에 기록한다.
운영 프로필을 바꾸거나 두 실행기의 도구 능력이 같다고 주장하지 않는다.

새 확정 정책은 보조 요청을 별도로 신뢰해 분류하지 않고 모든 요청에 같은 허용 집합을
적용한다. 한 모델 고정 시 보조 요청도 그 모델을 사용한다. 정책 없는 구형 수업의 SDK
fast 예외는 유지된다. 이름/교수법 설정이 도구 권한을 부여하지 않는다.

실행 증거는 [연구 기록](../research/agent-experience-acceptance-2026-09-08/model-selection/README.md)에 원본 결과·환경·스크린샷·해시로 보존한다.
Sonnet 4.5/4.6/5, Opus 4.5/4.6/4.7/4.8/5, Haiku 4.5의 텍스트 대화 전환을 두 실행 경로에서 확인했다.
Mac editor 최소 창 폭 때문에 390 CSS px는 실제 Studio 200% 확대, 1280px는 100%에서 측정했다.
키보드와 AX는 SDK/proxy 실행에서, 고정 수업의 화면은 별도 layout-only 실행에서 보완했다.
이 문서 자체는 실행 결과가 아니다. Windows 실기, 모든 모델/도구 조합, provider 간 이관,
자동 대체 상세 UI, 리허설 활성화 게이트와 사람의 학습 효과는 이 단위의 완료 주장이 아니다.
