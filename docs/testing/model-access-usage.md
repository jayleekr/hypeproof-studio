# 모델 선택·이용량 실행 결과

2026-09-08, #841. 합성 사용자 실험이며 실제 학습 효과의 증거가 아니다.

- 앱: 공개 v0.1.56 원본, source f5939d9cf6bbf42588eacd370e2faf9cde7c53bc.
- Service: 이 PR 변경 + base 18281a96439e14da3b4c1c1624e8b3f660463e65.
- 실기: Mac Electron, 별도 user-data/workspace, loopback8788, 실제 공급자 API,
  합성 SQLite/KV. 원본 사용자의 앱·수업·파일을 변경하지 않았다.
- 실행: `npm --prefix worker test`, `npm --prefix worker run typecheck`: PASS.
- 계약: `npm --prefix worker run test:model-usage`: PASS. 15개 메뉴 모델 매핑,
  인증/권한/SDK 우회 거부, 캐시·누락·합계 차이, 20개 동시 예약, 중복/늦은 정산,
  코드 재발급 후 한도, 오류 시 한 번 호출, 운영 조회 권한, 스트림 사용량.
- 실기: `HPS_MODEL_REHEARSAL=1 HPS_EXPECT_GPT_CREDIT_BLOCK=1`로
  `scripts/test-native-trial-laptop.sh tests/native-models.spec.ts`: 1 test PASS.
  이는 아래 PASS와 예상 BLOCKED가 정확히 구분됐다는 뜻이다.

| 선택 모델 | 실기 결과 | 응답/사용량 |
|---|---|---|
| GLM 5.2 | PASS | 200, 실제 glm-5.2; 일반 입력4112/출력82 |
| Gemini 3.5 Flash | PASS 응답 / PARTIAL 측정 | 200; 입력3128/출력37, 총3567. 차이402는 미분류이며 0원 또는 출력으로 추정하지 않음 |
| Claude Haiku 4.5 | PASS | 200; 실제 claude-haiku-4-5-20251001; 일반 입력414/캐시쓰기5383/출력24 |
| GPT-5.6 Luna/Terra/Sol | BLOCKED | 실제 API 429 credit_balance_exhausted. UI 오류 표시·429 기록·사용량 null 확인. 성공 응답 검증은 #830에 남음 |
| 나머지 9개 목록 선택 | 계약 PASS / 실 API NOT RUN | 전체 15개 메뉴가 실제 표시됐지만 모든 모델의 실 API 접근을 주장하지 않음 |

첫 실기 시도는 Playwright 설정의 testMatch에 새 파일을 등록하지 않아 `No tests found`.
설정을 고치고 다시 실행한 `20260908T231824Z`가 유효 결과다.

증거는 worktree의 `e2e/test-results/native-trial/20260908T231824Z/`에
manifest, model-results.json(입력/실제 화면), model-usage.json(측정 원장),
api-evidence.json(실제 호출), 모델별 PNG로 남겼다. 토큰은 증거 밖에 저장한 뒤 정리했다.
GLM 실제 응답 PNG를 직접 열어 확인했다.

## 재실행

공개 앱을 별도 `/tmp/hps-828-public-v56/HypeProof Studio.app`에 보존한 환경:

```bash
HPS_MODEL_REHEARSAL=1 HPS_EXPECT_GPT_CREDIT_BLOCK=1 HPS_NATIVE_PORT=8788 HPS_NATIVE_REUSE_DIR=/tmp/hps-828-public-v56 HPS_NATIVE_RELEASE_VERIFY=1 HPS_NATIVE_RELEASE_SHA=f5939d9cf6bbf42588eacd370e2faf9cde7c53bc HPS_NATIVE_RELEASE_VERSION=0.1.56 bash scripts/test-native-trial-laptop.sh tests/native-models.spec.ts
```

크레딧 충전 뒤에는 HPS_EXPECT_GPT_CREDIT_BLOCK을 제거하여 실제 성공을 요구한다.
공개 Worker의 신규 실습 활성화·원격 D1 인수·운영 예산은 이 로컬 실기로 대체하지 않는다.
