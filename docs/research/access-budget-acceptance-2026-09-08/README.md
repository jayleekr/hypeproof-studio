# 이용권·예산 UI 직접 검증

2026-09-08 · #856 / #847 · 실제 Mac 앱 및 Chromium · **합성 수업·가격·공급자 응답**.
운영 판매 조건이나 실제 수업 원가의 증거가 아니다. 구현 계약은
[요구사항](../../requirements/access-budget-settlement.md#p4-구현-범위-856--847)과
[설계](../../design/access-budget-settlement.md#p4-역할별-화면과-위임)를 따른다.

## 직접 촬영한 화면

| 화면 | 촬영 환경 | 확인 내용 |
|---|---|---|
| [학생 채팅 390px](mac-access-390.png) | 실제 Mac, 앱 확대 200%, webview 390 CSS px | 선택 출처·사용 상태, 모델 직접 선택, 작성란 보존 |
| [학생 채팅 1280px](mac-access-1280.png) | 같은 앱, 100%, webview 1280 CSS px | 이용권과 사용량을 기존 모델/Effort 영역에 연결 |
| [예산 소진 후](mac-access-exhausted.png) | 같은 앱 → 로컬 Service → 합성 SSE | 새 공급자 호출 차단, 기존 파일·대화·작성란 유지 |
| [강사 390px](chalk-budget-390.png) | Chromium → Chalk → Service/SQLite | 수업 배정·실제·예약·미확인·배분 진입 |
| [강사 1280px](chalk-budget-1280.png) | 같은 브라우저 | 공유 예산과 전용 배정 구별, 예상 소진 미확인 표시 |
| [강사 200%](chalk-budget-200-percent.png) | 실제 Chromium, CSS page zoom 200% | 학생 상한/pause 저장 후 좁아진 레이아웃, 가로 넘침 없음 |
| [다른 반 강사 거부](chalk-budget-role-denied.png) | 실제 서명된 타반 issuer | 예산 데이터 미노출 |
| [운영자 조회](operator-budget-1280.png) | 기존 admin 인증, 로컬 Service | 원가/예약/청구 조정·변경 이력 분리 |

[Mac 실행 결과](mac-result.json)에는 실측 viewport/zoom과 후보 번들 SHA-256을,
[브라우저 결과](browser-result.json)에는 인증/저장/키보드 검증 범위를 남겼다.
비밀은 테스트 입력창에서 연결 직후 지우고 URL·브라우저 저장소에 넣지 않았다.

## 검증에서 바꾼 점

1. 학생 cap을 나중에 생성해도 그 기간의 이미 실행된 시도와 비용을 포함한다.
   D1 시험에서 이전 사용 32, 새 상한 50이면 잔여 18이며 50으로 초기화되지 않았다.
2. 금액을 현금 잔액·추가 결제액처럼 표현하지 않는다. 정산 기준 단위와 공유 여부,
   본인 사용·예약·미확인·기준 시각을 함께 보여준다. 모델별 질문 수는 추정하지 않는다.
3. 선택 이후 열린 이용권 패널을 유지한다. 좁은 화면에서는 패널 내부를 스크롤하고
   요약에도 잔여 상태를 표시하여 작성란/Send·Stop을 유지한다.
4. 설치된 구버전 확장이 개발 경로보다 먼저 로드된 초기 Mac 실행은 실패로 판정했다.
   설치 앱의 격리 복사본에 후보 확장을 넣고 세 번들의 hash를 대조한 실행만 PASS다.
5. 수업 기본 모델이 합성 이용권 범위 밖이면 모델을 직접 선택한다. 테스트가 편리하도록
   제품 기본값을 바꾸거나 자동으로 저렴한 모델에 보내지 않았다.

## 실제 실행 명령

```sh
cd worker
npm test
npm run test:budget-surfaces:d1
npm run typecheck

cd ../chalk
npm test
npm run typecheck

cd ../extensions/hypeproof-chat
npm test
npm run typecheck
npm run build:extension
cd webview-ui
npm run build

# repo root; dependencies: e2e/package-lock.json
node --experimental-strip-types --experimental-sqlite e2e/access-budgets/browser.mjs
HPS_APP_PATH='/tmp/hps-856-mac-app/HypeProof Studio.app/Contents/MacOS/HypeProof Studio' \
HPS_BUDGET_BUNDLED=1 \
node --experimental-strip-types --experimental-sqlite e2e/access-budgets/mac.mjs
```

Mac 실행은 기존 앱의 **복사본**에 현재 extension.js/webview JS/CSS를 넣는다.
메인 설치 앱과 vscodium-base를 수정하거나 전체 build.sh를 실행하지 않았다.
fixture가 로컬 HTTP 서버와 SQLite를 만들고 실제 Hono·HMAC·Chalk forwarder를 호출한다.
공급자만 합성 응답이며 실제 외부 모델 비용은 발생하지 않는다.

## 아직 이 증거에 포함되지 않는 것

실제 공급자/SDK CLI 보조 호출의 청구 대조, 실제 수업의 사용 분포와 가격별 포함량 결정,
구매/결제 공급자 sandbox, 화면낭독기의 음성, Windows 앱, 사람의 학습/전이/유지 결과는
이 UI 검증의 PASS 범위가 아니다. 운영 포함형 활성화 판단은 #857에서 별도 수행한다.
